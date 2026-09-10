/**
 * Automatic sign-in tests — the decision rules (skip when signed in /
 * opted out / headless / once a day / already running), the in-process
 * background login the MCP server uses, the detached `login.mjs --auto`
 * child the SessionStart hook spawns, the hook as a real process (returns
 * inside its budget, tells the user, hands Claude one line, then goes
 * silent), and the MCP server as a real process (a tool call without a
 * sign-in answers with the friendly message in ~2 s and never blocks).
 *
 *   node --test plugins/ciwg-knowledge/tests/autologin.test.mjs
 *
 * No real network, no real browser: every process points at a 127.0.0.1
 * IdP this file owns (CIWG_OIDC_ISSUER) and CIWG_KNOWLEDGE_NO_BROWSER=1
 * makes the browser launch a no-op; the "browser" is a plain GET on the
 * loopback redirect. HOME/USERPROFILE point at a throwaway dir.
 */

import assert from "node:assert/strict"
import { execFile, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createServer, get as httpGet } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, beforeEach, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const fakeHome = mkdtempSync(join(tmpdir(), "ciwg-autologin-home-"))
const savedEnv = { ...process.env }
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CIWG_KNOWLEDGE_TOKEN
delete process.env.CIWG_AUTO_LOGIN
delete process.env.SSH_CONNECTION
delete process.env.SSH_TTY
process.env.CI = ""
if (process.platform === "linux" && !process.env.DISPLAY) process.env.DISPLAY = ":0"
process.env.CIWG_KNOWLEDGE_URL = "http://127.0.0.1:9"
process.env.CIWG_KNOWLEDGE_NO_BROWSER = "1"

/** A tiny local IdP: discovery, token (authorization_code → tokens). It is
 * up BEFORE auth.mjs is imported so the module's OIDC_ISSUER constant (read
 * from the env at import time) points here — an in-process login must
 * never reach the real sign-in server. */
let idpHang = false // true → discovery never answers (the hook must still return)
let tokenCalls = 0
let idpOrigin
let issuer
const idp = createServer((req, res) => {
    if (idpHang) return
    const send = (body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
    }
    if (req.url.endsWith("/.well-known/openid-configuration")) {
        send({
            issuer,
            authorization_endpoint: `${idpOrigin}/authorize`,
            token_endpoint: `${idpOrigin}/token`,
            revocation_endpoint: `${idpOrigin}/revoke`,
        })
    } else if (req.url === "/token") {
        let body = ""
        req.on("data", (chunk) => (body += chunk))
        req.on("end", () => {
            tokenCalls += 1
            const params = new URLSearchParams(body)
            if (params.get("grant_type") !== "authorization_code" || !params.get("code_verifier")) {
                send({ error: "invalid_grant" }, 400)
                return
            }
            send({
                access_token: "auto-access",
                expires_in: 600,
                refresh_token: "auto-refresh",
                id_token: fakeJwtEarly({ email: "auto@ciwebgroup.com" }),
            })
        })
    } else {
        send({ error: "not_found" }, 404)
    }
})
await new Promise((r) => idp.listen(0, "127.0.0.1", r))
idpOrigin = `http://127.0.0.1:${idp.address().port}`
issuer = `${idpOrigin}/application/o/ciwg-knowledge/`
process.env.CIWG_OIDC_ISSUER = issuer
function fakeJwtEarly(claims) {
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
    return `${b64({ alg: "none" })}.${b64(claims)}.sig`
}

const auth = await import("../scripts/lib/auth.mjs")
const { readState, updateState } = await import("../scripts/lib/state.mjs")
const {
    AUTO_LOGIN_CONTEXT,
    AUTO_LOGIN_CONTEXT_HELD,
    AUTO_LOGIN_HOLD_MS,
    AUTO_LOGIN_MESSAGE,
    AUTO_LOGIN_MESSAGE_HELD,
    AUTO_LOGIN_MESSAGE_NO_URL,
    OIDC_CLIENT_ID,
    autoLoginDecision,
    beginBackgroundLogin,
    claimAutoLogin,
    describeAuthStatus,
    isAutoLoginOptedOut,
    isEndpointUrl,
    looksHeadless,
    markAutoLoginFailed,
    markAutoLoginStarted,
    publishAutoLoginUrl,
    readAuth,
    readAutoLoginMarker,
    releaseAutoLogin,
    signInCooldownMs,
    spawnAutoLogin,
    tryClaimAutoLogin,
    writeAuth,
} = auth

/** An issuer nobody listens on: discovery fails at once (ECONNREFUSED on
 * the loopback discard port) — the "sign-in server unreachable" case. */
const DEAD_ISSUER = "http://127.0.0.1:9/application/o/ciwg-knowledge/"

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const scriptsDir = join(pluginDir, "scripts")
const ciwgDir = join(fakeHome, ".ciwg")
const markerPath = join(ciwgDir, "auto-login.json")
const authPath = join(ciwgDir, "auth.json")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

after(async () => {
    killStrayChildren()
    idp.closeAllConnections?.()
    await new Promise((r) => idp.close(r))
    for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
    rmSync(fakeHome, { recursive: true, force: true })
})

beforeEach(() => {
    killStrayChildren()
    rmSync(ciwgDir, { recursive: true, force: true })
    idpHang = false
    tokenCalls = 0
})

/** The detached child of a spawn test that never got completed. */
function killStrayChildren() {
    const marker = readAutoLoginMarker()
    if (marker && marker.pid !== process.pid) {
        try {
            process.kill(marker.pid)
        } catch {
            /* already gone */
        }
    }
}

/** "Click" the authorize URL: land the state-matched callback with a code. */
async function completeSignIn(authorizeUrl, code = "the-code") {
    const u = new URL(authorizeUrl)
    assert.equal(u.origin + u.pathname, `${idpOrigin}/authorize`)
    assert.equal(u.searchParams.get("code_challenge_method"), "S256")
    const redirectUri = u.searchParams.get("redirect_uri")
    assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const state = u.searchParams.get("state")
    return new Promise((resolve, reject) => {
        httpGet(`${redirectUri}?code=${code}&state=${state}`, (res) => {
            res.resume()
            res.on("end", () => resolve(res.statusCode))
        }).on("error", reject)
    })
}

async function waitFor(predicate, { timeoutMs = 8_000, what = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
}

const hookEnv = (extra = {}) => ({
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CIWG_KNOWLEDGE_TOKEN: "",
    CIWG_KNOWLEDGE_URL: "http://127.0.0.1:9",
    CIWG_OIDC_ISSUER: issuer,
    CIWG_KNOWLEDGE_NO_BROWSER: "1",
    CI: "",
    ...extra,
})

/** Run a hook as Claude Code does (payload on stdin, JSON or nothing on
 * stdout) — ASYNCHRONOUSLY, because the hook's detached child needs this
 * process's IdP to answer while the hook is still running. */
async function runHook(script, payload, extraEnv = {}) {
    const t0 = Date.now()
    const child = execFile(process.execPath, [join(scriptsDir, script)], {
        env: hookEnv(extraEnv),
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
    })
    child.stdin.end(JSON.stringify(payload))
    let stdout = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))))
    })
    return { out: stdout.trim() ? JSON.parse(stdout) : null, elapsed: Date.now() - t0 }
}

const startPayload = (id = "s-auto") => ({ session_id: id, cwd: fakeHome, source: "startup" })

// ---------------------------------------------------------------- rules

test("autoLoginDecision: only a missing/dropped sign-in is eligible; opt-out, headless, daily cadence and a running attempt all say no", () => {
    for (const status of ["network", "http", "busy", "timeout", "backoff", "api-rejected", 403]) {
        assert.equal(autoLoginDecision(status), "not-applicable", String(status))
    }
    assert.equal(autoLoginDecision("no-token"), "due")
    assert.equal(autoLoginDecision("relogin"), "due")

    // Opt-out: env (off / 0 / false / no) or knowledge.json.
    for (const value of ["off", "0", "false", "no", " OFF "]) {
        assert.equal(autoLoginDecision("no-token", { env: { ...process.env, CIWG_AUTO_LOGIN: value } }), "opted-out", value)
    }
    assert.equal(autoLoginDecision("no-token", { env: { ...process.env, CIWG_AUTO_LOGIN: "on" } }), "due")
    mkdirSync(ciwgDir, { recursive: true })
    writeFileSync(join(ciwgDir, "knowledge.json"), JSON.stringify({ autoLogin: false }))
    assert.equal(isAutoLoginOptedOut(), true)
    assert.equal(autoLoginDecision("no-token"), "opted-out")
    rmSync(join(ciwgDir, "knowledge.json"))

    // Headless: SSH, CI, display-less Linux.
    assert.equal(looksHeadless({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin"), true)
    assert.equal(looksHeadless({ SSH_TTY: "/dev/pts/0" }, "win32"), true)
    assert.equal(looksHeadless({ CI: "true" }, "win32"), true)
    assert.equal(looksHeadless({ CI: "false" }, "win32"), false)
    assert.equal(looksHeadless({}, "linux"), true)
    assert.equal(looksHeadless({ DISPLAY: ":0" }, "linux"), false)
    assert.equal(looksHeadless({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), false)
    assert.equal(looksHeadless({}, "darwin"), false)
    assert.equal(autoLoginDecision("no-token", { env: { ...process.env, SSH_CONNECTION: "x" } }), "headless")
    assert.equal(autoLoginDecision("no-token", { env: { ...process.env, CI: "true" } }), "headless")

    // Once a day.
    const now = Date.now()
    updateState({ auto_login_at: now - 60 * 60_000 })
    assert.equal(autoLoginDecision("no-token", { now }), "recent")
    assert.equal(autoLoginDecision("no-token", { now: now + 24 * 60 * 60_000 }), "due")
    rmSync(join(ciwgDir, "state.json"), { force: true })

    // Held: the last attempt never got a link (markAutoLoginFailed without
    // one holds the next attempt for AUTO_LOGIN_HOLD_MS), or the refresh
    // path found the sign-in server unreachable (idp_down_until). A link
    // that existed leaves the daily cadence in charge; a new link clears
    // the hold.
    markAutoLoginFailed("discovery failed", now)
    assert.equal(readState().auto_login_hold_until, now + AUTO_LOGIN_HOLD_MS)
    assert.equal(autoLoginDecision("no-token", { now }), "held")
    assert.equal(autoLoginDecision("relogin", { now }), "held")
    assert.equal(autoLoginDecision("no-token", { now: now + AUTO_LOGIN_HOLD_MS }), "due", "the hold is over")
    markAutoLoginStarted(now)
    assert.equal(readState().auto_login_hold_until, undefined, "a link clears the hold")
    assert.equal(autoLoginDecision("no-token", { now }), "recent", "…and stamps the day")
    rmSync(join(ciwgDir, "state.json"), { force: true })
    markAutoLoginFailed("timed out waiting for the browser sign-in", now, { hadUrl: true })
    assert.equal(readState().auto_login_hold_until, undefined, "a tab that opened is paced by the daily stamp, not a hold")
    assert.equal(autoLoginDecision("no-token", { now }), "due")
    rmSync(join(ciwgDir, "state.json"), { force: true })
    updateState({ idp_down_until: now + 30_000 })
    assert.equal(autoLoginDecision("no-token", { now }), "held", "IdP backoff honoured")
    assert.equal(autoLoginDecision("no-token", { now: now + 30_000 }), "due")
    rmSync(join(ciwgDir, "state.json"), { force: true })

    // A live attempt (own pid, fresh) → in-progress; stale or dead → due.
    assert.equal(claimAutoLogin({ now }), true)
    assert.equal(autoLoginDecision("no-token", { now }), "in-progress")
    assert.equal(claimAutoLogin({ now }), false, "a live attempt is never duplicated")
    assert.equal(autoLoginDecision("no-token", { now: now + 6 * 60_000 }), "due", "5-minute-old marker is stale")
    releaseAutoLogin()
    assert.ok(!existsSync(markerPath))
    writeFileSync(markerPath, JSON.stringify({ version: 1, pid: 2 ** 22 + 12345, started_at: now }))
    assert.equal(readAutoLoginMarker({ now }), null, "dead holder pid")
    assert.equal(autoLoginDecision("no-token", { now }), "due")
    assert.equal(claimAutoLogin({ now }), true, "a dead holder's marker is replaced")
    releaseAutoLogin()
})

test("publishAutoLoginUrl only touches an attempt this process owns", () => {
    const now = Date.now()
    mkdirSync(ciwgDir, { recursive: true })
    writeFileSync(markerPath, JSON.stringify({ version: 1, pid: process.pid + 1, started_at: now }))
    publishAutoLoginUrl("https://example.test/authorize", { now })
    assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).url, undefined)
    rmSync(markerPath)
    assert.equal(claimAutoLogin({ now }), true)
    publishAutoLoginUrl("https://example.test/authorize", { now })
    assert.equal(readAutoLoginMarker({ now }).url, "https://example.test/authorize")
    releaseAutoLogin()
})

test("claimAutoLogin: an unparsable marker with a fresh mtime is a sibling mid-write (torn read) and is left alone; only an OLD unparsable one is replaced", () => {
    mkdirSync(ciwgDir, { recursive: true })
    const torn = '{"version": 1, "pid": '
    writeFileSync(markerPath, torn)
    const now = Date.now()
    assert.equal(tryClaimAutoLogin({ now }), "sibling")
    assert.equal(claimAutoLogin({ now }), false)
    assert.equal(readFileSync(markerPath, "utf8"), torn, "the sibling's half-written marker survives")
    assert.equal(autoLoginDecision("no-token", { now }), "due", "…even though nobody can read it as live yet")

    const old = new Date(now - 10_000)
    utimesSync(markerPath, old, old)
    assert.equal(tryClaimAutoLogin({ now }), "owned", "old garbage is replaced")
    assert.equal(readAutoLoginMarker({ now }).pid, process.pid)
    releaseAutoLogin()
    assert.ok(!existsSync(markerPath))
})

test("readAutoLoginMarker: a marker url is relayed only when it is an https or loopback-http link (one token, bounded) — the marker itself still counts as live", () => {
    const now = Date.now()
    mkdirSync(ciwgDir, { recursive: true })
    const write = (url) =>
        writeFileSync(markerPath, JSON.stringify({ version: 1, pid: process.pid, started_at: now, url, url_at: now }))
    for (const bad of [
        "javascript:alert(1)",
        "http://evil.example/authorize",
        "file:///etc/passwd",
        "https://sso.example/authorize?x=1 y",
        "https://sso.example/a\nhttp://x",
        'https://sso.example/a"onclick',
        42,
        `https://sso.example/${"a".repeat(5_000)}`,
    ]) {
        write(bad)
        const marker = readAutoLoginMarker({ now })
        assert.ok(marker, `live: ${String(bad).slice(0, 40)}`)
        assert.equal(marker.url, undefined, `dropped: ${String(bad).slice(0, 40)}`)
        assert.equal(autoLoginDecision("no-token", { now }), "in-progress")
    }
    for (const good of [
        "https://sso.ciwgserver.com/application/o/authorize/?client_id=x&state=y&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback",
        "http://127.0.0.1:5555/authorize?state=y",
    ]) {
        write(good)
        assert.equal(readAutoLoginMarker({ now }).url, good)
    }
    assert.equal(isEndpointUrl("http://localhost:1/x"), true)
    assert.equal(isEndpointUrl("http://example.com/x"), false)
    assert.equal(isEndpointUrl(undefined), false)
    rmSync(markerPath)
})

test("signInCooldownMs: a tool-triggered sign-in backs off 5 → 10 → 20 → 40 → 60 min per server process and stays capped at an hour", () => {
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6, 40].map((attempt) => signInCooldownMs(attempt) / 60_000),
        [5, 10, 20, 40, 60, 60, 60]
    )
    assert.equal(signInCooldownMs(0), 5 * 60_000, "a nonsense count never yields a zero cooldown")
})

// -------------------------------------------------- in-process (MCP path)

test("beginBackgroundLogin: returns the authorize URL at once, finishes the loopback flow in the background, cleans up", async () => {
    const t0 = Date.now()
    const attempt = beginBackgroundLogin({ urlTimeoutMs: 2_000, timeoutMs: 10_000 })
    const url = await attempt.url
    assert.ok(Date.now() - t0 < 2_000, "the URL is known well inside the tool-call budget")
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/)
    assert.ok(readState().auto_login_at, "cadence stamped before the flow starts")
    assert.equal(readAutoLoginMarker().url, url, "the attempt is published for sibling processes")
    assert.equal(readAuth(), null, "not signed in yet")

    assert.equal(await completeSignIn(url), 200)
    const result = await attempt.done
    assert.equal(result.ok, true)
    assert.equal(result.email, "auto@ciwebgroup.com")
    assert.equal(readAuth().refresh_token, "auto-refresh")
    assert.ok(!existsSync(markerPath), "marker released")
    assert.equal(readState().auto_login_at, undefined, "a successful sign-in clears the auto-login state")
    assert.equal(tokenCalls, 1)
})

test("beginBackgroundLogin: a flow that times out reports a failure without throwing, records it for --status", async () => {
    const attempt = beginBackgroundLogin({ urlTimeoutMs: 2_000, timeoutMs: 200 })
    assert.match(await attempt.url, /authorize/)
    const result = await attempt.done
    assert.equal(result.ok, false)
    assert.match(result.error, /timed out/)
    assert.ok(!existsSync(markerPath))
    assert.match(readState().auto_login_error, /timed out/)
    assert.match(describeAuthStatus(), /Automatic sign-in: the last attempt failed \(timed out/)
    assert.equal(readAuth(), null)

    // A hung IdP: the URL promise still settles (null) inside urlTimeoutMs.
    // (Fresh state: the timed-out attempt above DID have a link and stamped
    // the cadence — that is the contrast this leg asserts.)
    rmSync(join(ciwgDir, "state.json"), { force: true })
    idpHang = true
    const t0 = Date.now()
    const stuck = beginBackgroundLogin({ urlTimeoutMs: 300, timeoutMs: 1_000 })
    assert.equal(await stuck.url, null)
    assert.ok(Date.now() - t0 < 1_000)
    idpHang = false
    idp.closeAllConnections?.()
    const failed = await stuck.done
    assert.equal(failed.ok, false)
    // No link ever existed, so no tab: the daily cadence is NOT stamped —
    // instead the automatic sign-in is HELD for a while (the error is on
    // record), so an unreachable sign-in server does not cost every
    // session start a doomed attempt.
    const state = readState()
    assert.equal(state.auto_login_at, undefined)
    assert.match(state.auto_login_error, /./)
    assert.ok(state.auto_login_hold_until > Date.now(), "held")
    assert.ok(state.auto_login_hold_until <= Date.now() + AUTO_LOGIN_HOLD_MS)
    assert.equal(autoLoginDecision("no-token"), "held")
    assert.match(describeAuthStatus(), /Automatic sign-in: the last attempt failed \(.+\); it retries after \d{4}-\d{2}-\d{2}T/)
})

test("beginBackgroundLogin: a claim lost to a HALF-WRITTEN marker keeps following through the torn-read grace — the winner's link is relayed once it lands, and only a torn marker that outlives the grace ends the follow", async () => {
    mkdirSync(ciwgDir, { recursive: true })
    const torn = '{"version": 1, "pid": '
    writeFileSync(markerPath, torn)
    const now = Date.now()
    assert.equal(tryClaimAutoLogin({ now }), "sibling")
    const opened = []
    const openBrowser = async (u) => opened.push(u)
    const follower = beginBackgroundLogin({ urlTimeoutMs: 3_000, timeoutMs: 10_000, openBrowser })
    // The old follower gave up on its first poll here (url null, done
    // {ok:false, sibling:true} within a millisecond): a fresh unparsable
    // marker is a sibling mid-write, so both promises must still be open.
    const pending = () => sleep(400).then(() => "pending")
    assert.equal(await Promise.race([follower.url, pending()]), "pending")
    assert.equal(await Promise.race([follower.done, pending()]), "pending")
    // The winner finishes its write and publishes the link…
    const link = "https://sso.ciwgserver.com/application/o/authorize/?state=torn"
    writeFileSync(markerPath, JSON.stringify({ version: 1, pid: process.pid, started_at: now, url: link, url_at: now }))
    assert.equal(await follower.url, link, "relayed, not a link of its own")
    // …and its sign-in lands.
    writeAuth({ access_token: "a", expires_at: Date.now() + 60_000, refresh_token: "r", email: "torn@ciwebgroup.com" })
    const result = await follower.done
    assert.deepEqual(
        { ok: result.ok, sibling: result.sibling, email: result.email },
        { ok: true, sibling: true, email: "torn@ciwebgroup.com" }
    )
    assert.equal(opened.length, 0, "a follower opens nothing")
    assert.equal(readState().auto_login_at, undefined, "…and stamps nothing")
    rmSync(markerPath)
    rmSync(authPath)

    // A torn marker nobody ever completes: the follow ends once the file
    // outlives the grace (a crashed writer), not before.
    writeFileSync(markerPath, torn)
    const orphan = beginBackgroundLogin({ urlTimeoutMs: 3_000, timeoutMs: 10_000, openBrowser })
    assert.equal(await Promise.race([orphan.done, sleep(300).then(() => "pending")]), "pending")
    const old = new Date(Date.now() - 10_000)
    utimesSync(markerPath, old, old)
    const t0 = Date.now()
    assert.equal(await orphan.url, null)
    const gaveUp = await orphan.done
    assert.equal(gaveUp.ok, false)
    assert.equal(gaveUp.sibling, true)
    assert.match(gaveUp.error, /another session/)
    assert.ok(Date.now() - t0 < 1_000, "gives up promptly once the marker is judged dead")
    assert.equal(opened.length, 0)
    assert.equal(readFileSync(markerPath, "utf8"), torn, "a follower never removes a marker")
    rmSync(markerPath)
})

test("tryClaimAutoLogin: a regular FILE at ~/.ciwg (or a directory at the marker path) is \"unwritable\" — not a sibling that a follower would wait on and give up", async () => {
    writeFileSync(ciwgDir, "not a directory")
    const now = Date.now()
    assert.equal(tryClaimAutoLogin({ now }), "unwritable")
    assert.equal(claimAutoLogin({ now }), false)
    assert.equal(readFileSync(ciwgDir, "utf8"), "not a directory", "left alone")
    // Unclaimed, the flow still runs in THIS process — a link of its own
    // inside the budget and an outcome of its own (no sibling flag) —
    // instead of "following" a sibling that does not exist and reporting
    // {ok:false, sibling:true} with no link at all.
    const attempt = beginBackgroundLogin({ urlTimeoutMs: 2_000, timeoutMs: 300 })
    assert.match(await attempt.url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/)
    const result = await attempt.done
    assert.equal(result.ok, false)
    assert.equal(result.sibling, undefined)
    assert.match(result.error, /timed out/)
    rmSync(ciwgDir, { force: true })

    mkdirSync(markerPath, { recursive: true })
    assert.equal(tryClaimAutoLogin({ now }), "unwritable")
    assert.ok(existsSync(markerPath), "not removed")
    rmSync(markerPath, { recursive: true, force: true })
})

test("beginBackgroundLogin: two attempts racing on one machine open ONE browser — the loser follows the winner's marker, relays its link and settles when its sign-in lands", async () => {
    const opened = []
    const openBrowser = async (u) => {
        opened.push(u)
    }
    const winner = beginBackgroundLogin({ urlTimeoutMs: 3_000, timeoutMs: 10_000, openBrowser })
    const loser = beginBackgroundLogin({ urlTimeoutMs: 3_000, timeoutMs: 10_000, openBrowser })
    const [url, relayed] = await Promise.all([winner.url, loser.url])
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/)
    assert.equal(relayed, url, "the loser relays the winner's link — it never made one of its own")
    await sleep(50) // the winner's browser launch is a microtask behind onAuthorizeUrl
    assert.equal(opened.length, 1, "exactly one browser launch")
    assert.equal(readAutoLoginMarker().pid, process.pid)

    assert.equal(await completeSignIn(url), 200)
    const [w, l] = await Promise.all([winner.done, loser.done])
    assert.equal(w.ok, true)
    assert.equal(w.sibling, undefined)
    assert.deepEqual(
        { ok: l.ok, sibling: l.sibling, email: l.email, hasRefreshToken: l.hasRefreshToken },
        { ok: true, sibling: true, email: "auto@ciwebgroup.com", hasRefreshToken: true }
    )
    assert.equal(opened.length, 1, "still one")
    assert.equal(tokenCalls, 1, "one code exchange")
    assert.ok(!existsSync(markerPath))
})

test("beginBackgroundLogin: a follower whose sibling ends without a sign-in reports that, opens nothing and stamps nothing", async () => {
    // The "sibling" is this very process holding the marker (no url yet).
    assert.equal(claimAutoLogin(), true)
    const opened = []
    const t0 = Date.now()
    const follower = beginBackgroundLogin({
        urlTimeoutMs: 300,
        timeoutMs: 10_000,
        openBrowser: async (u) => opened.push(u),
    })
    assert.equal(await follower.url, null, "the sibling never published a link")
    assert.ok(Date.now() - t0 < 2_000)
    releaseAutoLogin() // the sibling gives up
    const result = await follower.done
    assert.equal(result.ok, false)
    assert.equal(result.sibling, true)
    assert.match(result.error, /another session/)
    assert.equal(opened.length, 0)
    assert.equal(readState().auto_login_at, undefined, "a follower never stamps the cadence")
    assert.equal(readState().auto_login_error, undefined, "…nor records an error that is not its own")
    assert.ok(!existsSync(markerPath))
})

// --------------------------------------------------- detached (hook path)

test("spawnAutoLogin: starts a detached login.mjs --auto, relays its authorize URL, the child completes the sign-in on its own", async () => {
    const t0 = Date.now()
    const { started, url } = await spawnAutoLogin({ waitMs: 6_000 })
    const elapsed = Date.now() - t0
    assert.equal(started, true)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/, "URL published by the child")
    assert.ok(elapsed < 6_000, `waited ${elapsed}ms`)
    const marker = readAutoLoginMarker()
    assert.notEqual(marker.pid, process.pid, "the attempt belongs to the child")
    assert.ok(readState().auto_login_at)

    assert.equal(await completeSignIn(url), 200)
    await waitFor(() => readAuth()?.refresh_token === "auto-refresh", { what: "the child to persist the tokens" })
    await waitFor(() => !existsSync(markerPath), { what: "the child to release the marker" })
})

test("spawnAutoLogin: an unreachable sign-in server — the wait ends the moment the helper gives up (not after the full budget), the automatic sign-in is HELD, --status says until when", async () => {
    process.env.CIWG_OIDC_ISSUER = DEAD_ISSUER
    try {
        const t0 = Date.now()
        const result = await spawnAutoLogin({ waitMs: 6_000 })
        const elapsed = Date.now() - t0
        assert.deepEqual(result, { started: true, url: null, ended: true, failed: true })
        assert.ok(elapsed < 1_500, `returned after ${elapsed}ms — the child's exit cuts the wait short`)
        assert.ok(!existsSync(markerPath))
        const state = readState()
        assert.equal(state.auto_login_at, undefined, "no link, no tab: the daily cadence is untouched")
        assert.match(state.auto_login_error, /./)
        assert.ok(state.auto_login_hold_until > Date.now() + AUTO_LOGIN_HOLD_MS - elapsed - 1_000)
        assert.ok(state.auto_login_hold_until <= Date.now() + AUTO_LOGIN_HOLD_MS)
        assert.equal(autoLoginDecision("no-token"), "held")
        assert.equal(autoLoginDecision("no-token", { now: Date.now() + AUTO_LOGIN_HOLD_MS }), "due", "…until the hold is over")
        assert.match(describeAuthStatus(), /Automatic sign-in: the last attempt failed \(.+\); it retries after \d{4}-\d{2}-\d{2}T/)
        assert.doesNotMatch(describeAuthStatus(), /next session start/)
    } finally {
        process.env.CIWG_OIDC_ISSUER = issuer
    }
})

test("login.mjs --auto: exits without opening anything when signed in, opted out, headless, or when a sibling attempt is live", async () => {
    const run = (extra = {}) =>
        execFileSync(process.execPath, [join(scriptsDir, "login.mjs"), "--auto"], {
            env: hookEnv(extra),
            encoding: "utf8",
            timeout: 15_000,
            windowsHide: true,
        })
    // Signed in already.
    writeAuth({ access_token: "a", expires_at: Date.now() + 60_000, refresh_token: "r" })
    assert.equal(run(), "")
    assert.ok(!existsSync(markerPath))
    rmSync(authPath)
    // Opted out / headless.
    assert.equal(run({ CIWG_AUTO_LOGIN: "off" }), "")
    assert.equal(run({ SSH_CONNECTION: "1 2 3 4" }), "")
    assert.ok(!existsSync(markerPath))
    assert.equal(tokenCalls, 0)
    // A live sibling: the marker names THIS (alive) process.
    assert.equal(claimAutoLogin(), true)
    assert.equal(run(), "")
    assert.equal(readAutoLoginMarker().pid, process.pid, "sibling's marker untouched")
    releaseAutoLogin()
})

test("SessionStart hook: no sign-in → opens the browser sign-in itself, tells the user (with the link), hands Claude one line, returns inside its budget; later sessions stay silent while it runs and after it lands", async () => {
    const { out, elapsed } = await runHook("session-brief.mjs", startPayload("s-1"))
    assert.ok(out, "the hook said something")
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart")
    assert.equal(out.hookSpecificOutput.additionalContext, AUTO_LOGIN_CONTEXT)
    assert.ok(out.systemMessage.startsWith(AUTO_LOGIN_MESSAGE), out.systemMessage)
    const url = out.systemMessage.split("\n").pop()
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/, "the link is in the user-facing line")
    assert.ok(elapsed < 6_000, `hook took ${elapsed}ms`)
    assert.doesNotMatch(JSON.stringify(out), /code_verifier|auto-access|auto-refresh/)
    const marker = readAutoLoginMarker()
    assert.ok(marker?.url, "the child is running and published its URL")
    assert.ok(readState().auto_login_at)

    // Another session while the browser is still open: silent, no second child.
    const second = await runHook("session-brief.mjs", startPayload("s-2"))
    assert.equal(second.out, null)
    assert.equal(readAutoLoginMarker().pid, marker.pid)

    // The user finishes in the browser; the child persists the tokens.
    assert.equal(await completeSignIn(url), 200)
    await waitFor(() => readAuth()?.refresh_token === "auto-refresh", { what: "the child to persist the tokens" })
    await waitFor(() => !existsSync(markerPath), { what: "the child to exit" })

    // Signed in now: the hook goes on to its normal work (the API port is
    // dead → fail-open, silent) and never nudges.
    const third = await runHook("session-brief.mjs", startPayload("s-3"))
    assert.equal(third.out, null)
    assert.equal(readState().first_run_hint_at, undefined)
})

test("SessionStart hook: once a day — a second machine-day is not re-opened; the old one-line hint takes over", async () => {
    updateState({ auto_login_at: Date.now() - 60 * 60_000 })
    const { out } = await runHook("session-brief.mjs", startPayload("s-4"))
    assert.ok(out)
    assert.equal(out.systemMessage, undefined, "no browser this time")
    assert.match(out.hookSpecificOutput.additionalContext, /run \/ciwg-login/)
    assert.ok(!existsSync(markerPath), "no child spawned")
    assert.equal((await runHook("session-brief.mjs", startPayload("s-5"))).out, null, "and the hint itself is daily")
})

test("SessionStart hook: opted out / headless / CI / legacy token → never opens a browser", async () => {
    for (const extra of [
        { CIWG_AUTO_LOGIN: "off" },
        { SSH_CONNECTION: "10.0.0.2 1 10.0.0.1 22" },
        { CI: "true" },
    ]) {
        rmSync(ciwgDir, { recursive: true, force: true })
        const { out } = await runHook("session-brief.mjs", startPayload("s-6"), extra)
        assert.ok(out, JSON.stringify(extra))
        assert.equal(out.systemMessage, undefined)
        assert.match(out.hookSpecificOutput.additionalContext, /\/ciwg-login/)
        assert.ok(!existsSync(markerPath))
        assert.equal(readState().auto_login_at, undefined)
    }
    rmSync(ciwgDir, { recursive: true, force: true })
    mkdirSync(ciwgDir, { recursive: true })
    writeFileSync(join(ciwgDir, "knowledge.json"), JSON.stringify({ autoLogin: false }))
    const { out } = await runHook("session-brief.mjs", startPayload("s-7"))
    assert.match(out.hookSpecificOutput.additionalContext, /\/ciwg-login/)
    assert.ok(!existsSync(markerPath))
    rmSync(ciwgDir, { recursive: true, force: true })
    assert.equal((await runHook("session-brief.mjs", startPayload("s-8"), { CIWG_KNOWLEDGE_TOKEN: "legacy" })).out, null)
    assert.ok(!existsSync(markerPath))
})

test("SessionStart hook: a hung sign-in server never holds the hook — it returns inside its budget, names the manual path instead of promising a tab, and does not spend the day's attempt", async () => {
    idpHang = true
    try {
        const { out, elapsed } = await runHook("session-brief.mjs", startPayload("s-9"))
        assert.ok(out)
        assert.equal(out.systemMessage, AUTO_LOGIN_MESSAGE_NO_URL, "no URL to show yet → '— or run /ciwg-login'")
        assert.ok(out.systemMessage.startsWith(AUTO_LOGIN_MESSAGE))
        assert.match(out.systemMessage, /\/ciwg-login/)
        assert.equal(out.hookSpecificOutput.additionalContext, AUTO_LOGIN_CONTEXT)
        assert.ok(elapsed < 6_000, `hook took ${elapsed}ms`)
        assert.ok(readAutoLoginMarker(), "the child is still trying")
        assert.equal(readState().auto_login_at, undefined, "no link, no tab: the daily cadence is NOT stamped")
        assert.equal(readState().auto_login_hold_until, undefined, "…and nothing is held while it is still trying")
    } finally {
        idpHang = false
        idp.closeAllConnections?.()
        // The child fails now (its discovery socket was just cut) and writes
        // its hold — let that land before the next test wipes the state.
        await waitFor(() => !existsSync(markerPath), { what: "the child to give up" })
    }
})

test("SessionStart hook: an unreachable sign-in server costs ONE soft \"run /ciwg-login when you're online\" line and returns fast; the automatic sign-in is held and the next starts say nothing at all", async () => {
    const dead = { CIWG_OIDC_ISSUER: DEAD_ISSUER }
    const { out, elapsed } = await runHook("session-brief.mjs", startPayload("s-held-1"), dead)
    assert.ok(out)
    assert.equal(out.systemMessage, AUTO_LOGIN_MESSAGE_HELD)
    assert.doesNotMatch(out.systemMessage, /Opening/, "no promise of a browser that is not going to open")
    assert.equal(out.hookSpecificOutput.additionalContext, AUTO_LOGIN_CONTEXT_HELD)
    assert.ok(elapsed < 2_500, `hook took ${elapsed}ms — it did not sit out the 2.5 s link wait`)
    assert.ok(!existsSync(markerPath))
    const state = readState()
    assert.equal(state.auto_login_at, undefined)
    assert.ok(state.auto_login_hold_until > Date.now(), "held")
    assert.ok(state.first_run_hint_at, "today's nudge is spent with the soft line")

    // On hold: no wait, no line, no child.
    const second = await runHook("session-brief.mjs", startPayload("s-held-2"), dead)
    assert.equal(second.out, null)
    assert.ok(!existsSync(markerPath))
    assert.equal(readState().auto_login_hold_until, state.auto_login_hold_until, "the hold is not extended by a silent start")

    // The hold over, still unreachable: one soft line again, a new hold —
    // independent of the daily nudge, which was already spent today.
    updateState({ auto_login_hold_until: Date.now() - 1 })
    const third = await runHook("session-brief.mjs", startPayload("s-held-3"), dead)
    assert.equal(third.out?.systemMessage, AUTO_LOGIN_MESSAGE_HELD)
    assert.ok(readState().auto_login_hold_until > Date.now())
    assert.equal(readState().auto_login_at, undefined)
})

test("SessionStart hook: only a real startup opens a browser — a resumed session gets the one-line hint at most, and stays silent while a sibling's browser is open", async () => {
    const { out } = await runHook("session-brief.mjs", { session_id: "s-resume", cwd: fakeHome, source: "resume" })
    assert.ok(out, "the hint still fires")
    assert.equal(out.systemMessage, undefined, "no browser")
    assert.match(out.hookSpecificOutput.additionalContext, /\/ciwg-login/)
    assert.ok(!existsSync(markerPath), "no child spawned")
    assert.equal(readState().auto_login_at, undefined)

    rmSync(join(ciwgDir, "state.json"), { force: true })
    assert.equal(claimAutoLogin(), true)
    assert.equal(
        (await runHook("session-brief.mjs", { session_id: "s-resume-2", cwd: fakeHome, source: "resume" })).out,
        null,
        "a sibling's sign-in is open: a resume neither nags nor opens another"
    )
    releaseAutoLogin()
})

// ------------------------------------------------- MCP server (real process)

/** Drive the stdio MCP server: newline-delimited JSON-RPC. */
function startServer(extraEnv = {}) {
    const child = spawn(process.execPath, [join(scriptsDir, "knowledge-mcp.mjs")], {
        env: hookEnv(extraEnv),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
    })
    let buffer = ""
    const waiters = new Map()
    child.stdout.on("data", (chunk) => {
        buffer += chunk
        let nl
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            try {
                const msg = JSON.parse(line)
                waiters.get(msg.id)?.(msg)
                waiters.delete(msg.id)
            } catch {
                /* ignore */
            }
        }
    })
    let nextId = 1
    const call = (method, params, timeoutMs = 10_000) =>
        new Promise((resolve, reject) => {
            const id = nextId++
            const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
            waiters.set(id, (msg) => {
                clearTimeout(timer)
                resolve(msg)
            })
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
        })
    const stop = () =>
        new Promise((resolve) => {
            child.once("exit", resolve)
            child.kill()
        })
    return { call, stop }
}

const toolText = (msg) => msg.result.content[0].text

test("MCP server: a tool call without a sign-in opens the browser sign-in and answers in ~2 s with the friendly message; the next call after the user signs in works", async () => {
    const server = startServer()
    try {
        const init = await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } })
        assert.equal(init.result.serverInfo.version, "0.3.3", "version comes from plugin.json")
        assert.match(init.result.instructions, /search_company_knowledge/)
        const list = await server.call("tools/list", {})
        assert.deepEqual(list.result.tools.map((t) => t.name), ["search_company_knowledge", "get_source_artifacts"])
        assert.match(list.result.tools[0].description, /USE THIS FIRST/)

        const t0 = Date.now()
        const first = await server.call("tools/call", { name: "search_company_knowledge", arguments: { q: "acme" } })
        const elapsed = Date.now() - t0
        assert.ok(elapsed < 3_000, `tool call answered in ${elapsed}ms`)
        assert.equal(first.result.isError, false, "not an error — Claude relays it, no retry storm")
        const message = toolText(first)
        assert.match(message, /opened in your browser/)
        const url = message.split("\n").pop()
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/)
        assert.doesNotMatch(message, /code_verifier/)
        assert.ok(readAutoLoginMarker()?.url, "attempt published for sibling processes")

        // Asking again while the browser is open: same link, no second flow.
        const again = await server.call("tools/call", { name: "get_source_artifacts", arguments: { source_type: "a", source_id: "b" } })
        assert.match(toolText(again), /still open in your browser/)
        assert.ok(toolText(again).includes(url))

        assert.equal(await completeSignIn(url), 200)
        await waitFor(() => readAuth()?.refresh_token === "auto-refresh", { what: "the server to persist the tokens" })
        await waitFor(() => !existsSync(markerPath), { what: "marker release" })

        // Signed in: the credential is picked up; the dead API port is a
        // plain transient failure now, not a sign-in prompt.
        const after = await server.call("tools/call", { name: "search_company_knowledge", arguments: { q: "acme" } })
        assert.equal(after.result.isError, true)
        assert.match(toolText(after), /unreachable|backing off/)
        assert.doesNotMatch(toolText(after), /browser/)
    } finally {
        await server.stop()
    }
})

test("MCP server: while the automatic sign-in is held (the sign-in server was unreachable), a tool call gets the manual /ciwg-login line — not \"opened in your browser\" about a tab that never opens", async () => {
    markAutoLoginFailed("OIDC discovery failed", Date.now())
    const server = startServer()
    try {
        await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } })
        const res = await server.call("tools/call", { name: "search_company_knowledge", arguments: { q: "acme" } })
        assert.equal(res.result.isError, true)
        assert.match(toolText(res), /\/ciwg-login/)
        assert.doesNotMatch(toolText(res), /browser/)
        assert.ok(!existsSync(markerPath))
        assert.equal(readState().auto_login_at, undefined)
    } finally {
        await server.stop()
    }
})

test("MCP server: opted out (or headless) → the manual /ciwg-login message, no browser", async () => {
    const server = startServer({ CIWG_AUTO_LOGIN: "off" })
    try {
        await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } })
        const res = await server.call("tools/call", { name: "search_company_knowledge", arguments: { q: "acme" } })
        assert.equal(res.result.isError, true)
        assert.match(toolText(res), /\/ciwg-login/)
        assert.ok(!existsSync(markerPath))
        assert.equal(readState().auto_login_at, undefined)
    } finally {
        await server.stop()
    }
})

test("MCP server: a sign-in started elsewhere (hook child) is respected — the tool relays its link instead of opening another", async () => {
    const { url } = await spawnAutoLogin({ waitMs: 6_000 })
    assert.match(url, /authorize/)
    const server = startServer()
    try {
        await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } })
        const res = await server.call("tools/call", { name: "search_company_knowledge", arguments: { q: "acme" } })
        assert.equal(res.result.isError, false)
        assert.match(toolText(res), /still open in your browser/)
        assert.ok(toolText(res).includes(url), "the hook child's link, not a new one")
    } finally {
        await server.stop()
        killStrayChildren()
    }
})
