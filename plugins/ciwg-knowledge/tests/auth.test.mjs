/**
 * SSO sign-in tests — PKCE, the token cache + silent refresh (mocked token
 * endpoint), expiry, the hook time budget, legacy-token precedence, the
 * loopback and device flows end to end, logout, the hint cadence, and the
 * hooks' one-line sign-in nudges (real hook processes, no network). Run
 * from the repo root (pass the files — the directory form is not
 * supported by every Node):
 *
 *   node --test plugins/ciwg-knowledge/tests/engram.test.mjs plugins/ciwg-knowledge/tests/auth.test.mjs
 *
 * HOME/USERPROFILE point at a throwaway dir so the user's real ~/.ciwg is
 * never read or written; every network call goes through an injected
 * `fetchImpl` — nothing dials out (the one "IdP" in here is a 127.0.0.1
 * server the SSH test owns).
 */

import assert from "node:assert/strict"
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { createServer, get as httpGet } from "node:http"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { after, beforeEach, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const fakeHome = mkdtempSync(join(tmpdir(), "ciwg-auth-home-"))
const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CIWG_KNOWLEDGE_TOKEN: process.env.CIWG_KNOWLEDGE_TOKEN,
    CIWG_KNOWLEDGE_URL: process.env.CIWG_KNOWLEDGE_URL,
    CIWG_OIDC_CLIENT_ID: process.env.CIWG_OIDC_CLIENT_ID,
    CIWG_AUTO_LOGIN: process.env.CIWG_AUTO_LOGIN,
}
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CIWG_KNOWLEDGE_TOKEN
// The default-client-id assertion below must not see a shell override.
delete process.env.CIWG_OIDC_CLIENT_ID
// A shell that exports CIWG_AUTO_LOGIN=off (automation, a cautious
// developer) must not change what --status and logout report in here: the
// opt-out is exercised per test through explicit env, never inherited.
delete process.env.CIWG_AUTO_LOGIN
// Belt and braces: even a bug that reached the API would hit a dead port.
process.env.CIWG_KNOWLEDGE_URL = "http://127.0.0.1:9"

const auth = await import("../scripts/lib/auth.mjs")
const config = await import("../scripts/lib/config.mjs")
const { readState, updateState } = await import("../scripts/lib/state.mjs")
const {
    LEGACY_TOKEN_NOTE,
    OIDC_CLIENT_ID,
    OIDC_SCOPES,
    TIMING,
    authPath,
    browserLaunchSpec,
    decodeJwtPayload,
    describeAuthStatus,
    discover,
    finishDeviceLogin,
    generatePkce,
    getAccessToken,
    getLegacyToken,
    loginWithBrowser,
    loginWithDeviceCode,
    logout,
    persistAuth,
    readAuth,
    resolveAuth,
    signInHint,
    startLoopbackListener,
    writeAuth,
} = auth
const {
    HOOK_BUDGET_MS,
    describeFailure,
    getSourceArtifacts,
    resetCredentialMemo,
    searchKnowledge,
} = config

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const scriptsDir = join(pluginDir, "scripts")
const ciwgDir = join(fakeHome, ".ciwg")
const statePath = join(ciwgDir, "state.json")
const ISSUER = "https://sso.example.test/application/o/ciwg-knowledge/"
const META = {
    issuer: ISSUER,
    authorization_endpoint: "https://sso.example.test/application/o/authorize/",
    token_endpoint: "https://sso.example.test/application/o/token/",
    device_authorization_endpoint: "https://sso.example.test/application/o/device/",
    revocation_endpoint: "https://sso.example.test/application/o/revoke/",
}
const SEARCH_URL = "http://127.0.0.1:9/api/v1/knowledge/search"
const ARTIFACTS_URL = "http://127.0.0.1:9/api/v1/knowledge/artifacts"

const b64url = (value) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url")
const fakeJwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    })
const sha256url = (s) => createHash("sha256").update(s).digest("base64url")
const noSleep = async () => {}

/** Records every call; routes by URL prefix (query strings ignored).
 * `handlers` maps URL → fn(params, init, callNo). */
function mockFetch(handlers) {
    const calls = []
    const impl = async (url, init = {}) => {
        const key = String(url)
        const params = new URLSearchParams(init.body ?? "")
        calls.push({ url: key, method: init.method ?? "GET", params, headers: init.headers ?? {} })
        const handler = handlers[key] ?? handlers[key.split("?")[0]]
        if (!handler) throw new TypeError(`fetch failed: unexpected ${key}`)
        return handler(params, init, calls.length)
    }
    impl.calls = calls
    return impl
}

/** A handler that never answers — but honours the abort signal, exactly
 * like undici does when fetchWithTimeout gives up. */
const hang = (params, init) =>
    new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })

const discoveryHandlers = () => ({
    [`${ISSUER}.well-known/openid-configuration`]: () => json(META),
})

/** A signed-in cache whose access token expired `expiredForMs` ago. */
const seedAuth = (overrides = {}) =>
    writeAuth({
        client_id: OIDC_CLIENT_ID,
        token_endpoint: META.token_endpoint,
        revocation_endpoint: META.revocation_endpoint,
        access_token: "old-access",
        expires_at: Date.now() - 1000,
        refresh_token: "refresh-1",
        email: "ada@ciwebgroup.com",
        ...overrides,
    })

const seedFresh = (overrides = {}) =>
    seedAuth({ access_token: "fresh", expires_at: Date.now() + 10 * 60_000, ...overrides })

/** A dropped sign-in (what an invalid_grant leaves behind). */
const seedRelogin = (email = "ada@ciwebgroup.com") =>
    updateState({ relogin_at: Date.now(), relogin_email: email, relogin_why: "test" })

after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    rmSync(fakeHome, { recursive: true, force: true })
})

beforeEach(() => {
    delete process.env.CIWG_KNOWLEDGE_TOKEN
    rmSync(ciwgDir, { recursive: true, force: true })
    resetCredentialMemo()
})

// ------------------------------------------------------------------ PKCE

test("generatePkce: 43-char base64url verifier, S256 challenge, unique", () => {
    const a = generatePkce()
    const b = generatePkce()
    assert.equal(a.method, "S256")
    assert.equal(a.verifier.length, 43)
    assert.match(a.verifier, /^[A-Za-z0-9_-]+$/)
    assert.match(a.challenge, /^[A-Za-z0-9_-]+$/)
    assert.equal(a.challenge, sha256url(a.verifier))
    assert.notEqual(a.verifier, b.verifier)
})

test("decodeJwtPayload: tolerant, never throws", () => {
    assert.deepEqual(decodeJwtPayload(fakeJwt({ email: "x@y" })), { email: "x@y" })
    assert.equal(decodeJwtPayload("not-a-jwt"), null)
    assert.equal(decodeJwtPayload(`a.${b64url("[1]")}.c`), null)
    assert.equal(decodeJwtPayload(undefined), null)
})

// ------------------------------------------------------------- client id

test("OIDC_CLIENT_ID: defaults to the Authentik-generated client id (not the slug); CIWG_OIDC_CLIENT_ID overrides", async () => {
    assert.equal(OIDC_CLIENT_ID, "lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1")
    process.env.CIWG_OIDC_CLIENT_ID = "  staging-client-id  "
    try {
        // The query string busts the ESM cache so the constant is re-read.
        const fresh = await import("../scripts/lib/auth.mjs?client-id-override")
        assert.equal(fresh.OIDC_CLIENT_ID, "staging-client-id")
    } finally {
        delete process.env.CIWG_OIDC_CLIENT_ID
    }
})

// ------------------------------------------------------------- discovery

test("discover: reads the issuer's openid-configuration, validates endpoints", async () => {
    const fetchImpl = mockFetch(discoveryHandlers())
    const meta = await discover(ISSUER, { fetchImpl })
    assert.equal(meta.token_endpoint, META.token_endpoint)
    assert.equal(meta.device_authorization_endpoint, META.device_authorization_endpoint)
    // Trailing-slash-less issuer is normalised.
    await discover(ISSUER.replace(/\/$/, ""), { fetchImpl })
    assert.equal(fetchImpl.calls[1].url, `${ISSUER}.well-known/openid-configuration`)

    const broken = mockFetch({
        [`${ISSUER}.well-known/openid-configuration`]: () => json({ issuer: ISSUER }),
    })
    await assert.rejects(discover(ISSUER, { fetchImpl: broken }), /lacks authorization_endpoint/)
})

// --------------------------------------------------------- token cache

test("cache: writeAuth is owner-only and readAuth round-trips; the state file shares the 0700 dir", () => {
    seedAuth()
    const stored = readAuth()
    assert.equal(stored.version, 1)
    assert.equal(stored.refresh_token, "refresh-1")
    if (process.platform !== "win32") {
        assert.equal(statSync(authPath()).mode & 0o777, 0o600)
        assert.equal(statSync(ciwgDir).mode & 0o777, 0o700)
    }
    writeFileSync(authPath(), JSON.stringify({ version: 99, access_token: "x" }))
    assert.equal(readAuth(), null, "unknown version is ignored")

    // The state file is created through the same ensureCiwgDir path.
    rmSync(ciwgDir, { recursive: true, force: true })
    updateState({ first_run_hint_at: 1 })
    assert.deepEqual(readState(), { first_run_hint_at: 1 })
    if (process.platform !== "win32") {
        assert.equal(statSync(ciwgDir).mode & 0o777, 0o700)
    }
})

test("getAccessToken: a fresh cached token is used without any network", async () => {
    seedFresh()
    const fetchImpl = mockFetch({})
    const result = await getAccessToken({ fetchImpl })
    assert.equal(result.token, "fresh")
    assert.equal(result.email, "ada@ciwebgroup.com")
    assert.equal(fetchImpl.calls.length, 0)
})

test("getAccessToken: a token inside the 30s skew window counts as expired", async () => {
    seedAuth({ access_token: "almost", expires_at: Date.now() + 10_000 })
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "renewed", expires_in: 600 }),
    })
    const result = await getAccessToken({ fetchImpl })
    assert.equal(result.token, "renewed")
    assert.equal(fetchImpl.calls.length, 1)
})

test("getAccessToken: expired → silent refresh_token grant, rotated token persisted, lean record", async () => {
    seedAuth()
    const fetchImpl = mockFetch({
        [META.token_endpoint]: (params, init) => {
            assert.equal(init.method, "POST")
            assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded")
            assert.equal(init.headers.Authorization, undefined, "public client: no client auth")
            assert.equal(params.get("grant_type"), "refresh_token")
            assert.equal(params.get("refresh_token"), "refresh-1")
            assert.equal(params.get("client_id"), OIDC_CLIENT_ID)
            assert.equal(params.get("client_secret"), null)
            return json({
                access_token: "new-access",
                expires_in: 900,
                refresh_token: "refresh-2",
                id_token: fakeJwt({ email: "ada@ciwebgroup.com" }),
            })
        },
    })
    const before = Date.now()
    const result = await getAccessToken({ fetchImpl })
    assert.equal(result.token, "new-access")
    assert.ok(result.expiresAt >= before + 900_000 - 1000)
    const stored = readAuth()
    assert.equal(stored.access_token, "new-access")
    assert.equal(stored.refresh_token, "refresh-2", "rotated refresh token persisted")
    assert.equal(stored.id_token, undefined, "id_token is never stored")
    assert.equal(stored.token_endpoint, META.token_endpoint)
    assert.deepEqual(
        Object.keys(stored).sort(),
        ["access_token", "client_id", "email", "expires_at", "refresh_token", "revocation_endpoint", "token_endpoint", "version"],
        "no dead fields (issuer, obtained_at, needs_login…)"
    )
    assert.ok(!existsSync(join(ciwgDir, "auth.lock")), "lock released")

    // Second call: cache hit, no network.
    const again = await getAccessToken({ fetchImpl })
    assert.equal(again.token, "new-access")
    assert.equal(fetchImpl.calls.length, 1)
})

test("getAccessToken: a response without refresh_token keeps the previous one", async () => {
    seedAuth()
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "a2", expires_in: 300 }),
    })
    await getAccessToken({ fetchImpl })
    assert.equal(readAuth().refresh_token, "refresh-1")
})

test("getAccessToken: missing expires_in falls back to the JWT exp claim", async () => {
    seedAuth()
    const exp = Math.floor(Date.now() / 1000) + 777
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: fakeJwt({ exp }) }),
    })
    const result = await getAccessToken({ fetchImpl })
    assert.equal(result.expiresAt, exp * 1000)
})

test("getAccessToken: invalid_grant (revoked/deactivated) → relogin, ONE state (auth.json gone, who/why in state.json), no retry storm", async () => {
    seedAuth()
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ error: "invalid_grant" }, 400),
    })
    const first = await getAccessToken({ fetchImpl })
    assert.deepEqual(first, { token: null, reason: "relogin" })
    assert.equal(readAuth(), null, "tokens dropped — no tombstone record")
    const state = readState()
    assert.equal(state.relogin_email, "ada@ciwebgroup.com", "identity kept for --status")
    assert.match(state.relogin_why, /invalid_grant/)
    assert.match(describeAuthStatus(), /sign-in required \(was ada@ciwebgroup\.com\).*\/ciwg-login/)

    const second = await getAccessToken({ fetchImpl })
    assert.deepEqual(second, { token: null, reason: "relogin" })
    assert.equal(fetchImpl.calls.length, 1, "a dead refresh token is not retried")
})

test("getAccessToken: ONLY error=invalid_grant is terminal — other 4xx keep the tokens (invalid_client, proxy HTML 400, 401)", async () => {
    for (const [status, body] of [
        [400, { error: "invalid_client" }],
        [400, "<html>Bad Request</html>"],
        [401, { error: "invalid_request" }],
        [429, { error: "rate_limited" }],
    ]) {
        seedAuth()
        const fetchImpl = mockFetch({
            [META.token_endpoint]: () =>
                new Response(typeof body === "string" ? body : JSON.stringify(body), {
                    status,
                    headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" },
                }),
        })
        assert.deepEqual(
            await getAccessToken({ fetchImpl }),
            { token: null, reason: "http" },
            `HTTP ${status} ${JSON.stringify(body)}`
        )
        assert.equal(readAuth()?.refresh_token, "refresh-1", "tokens kept")
        assert.equal(readState().relogin_at, undefined, "not tombstoned")
        rmSync(statePath, { force: true }) // clear the IdP backoff between cases
    }
})

test("getAccessToken: transient failures keep the tokens and back off the IdP only (not the API)", async () => {
    seedAuth()
    const down = mockFetch({
        [META.token_endpoint]: () => {
            throw new TypeError("fetch failed")
        },
    })
    assert.deepEqual(await getAccessToken({ fetchImpl: down }), { token: null, reason: "network" })
    assert.equal(readAuth().refresh_token, "refresh-1")
    const state = readState()
    assert.ok(state.idp_down_until > Date.now(), "IdP backoff set")
    assert.equal(state.api_down_until, undefined, "an IdP failure must not silence API lookups")
    // Backed off: no second dial, and the reason says so.
    assert.deepEqual(await getAccessToken({ fetchImpl: down }), { token: null, reason: "backoff" })
    assert.equal(down.calls.length, 1)

    rmSync(statePath, { force: true })
    const flaky = mockFetch({
        [META.token_endpoint]: () => json({ error: "server_error" }, 503),
    })
    assert.deepEqual(await getAccessToken({ fetchImpl: flaky }), { token: null, reason: "http" })
    assert.equal(readAuth().refresh_token, "refresh-1")
    assert.equal(readState().relogin_at, undefined)
})

test("getAccessToken: no cached refresh token → relogin without network", async () => {
    seedAuth({ refresh_token: undefined })
    const fetchImpl = mockFetch({})
    assert.deepEqual(await getAccessToken({ fetchImpl }), { token: null, reason: "relogin" })
    assert.equal(readAuth(), null)
    assert.ok(readState().relogin_at)
})

test("getAccessToken: proactive refresh when the token expires soon; a failed one still returns the valid token", async () => {
    seedFresh({ expires_at: Date.now() + 3 * 60_000 })
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "early", expires_in: 900, refresh_token: "refresh-2" }),
    })
    // Not due: 3 min left, no proactive window asked for.
    assert.equal((await getAccessToken({ fetchImpl })).token, "fresh")
    assert.equal(fetchImpl.calls.length, 0)
    // Due within a 5-minute window.
    const early = await getAccessToken({ fetchImpl, refreshWithinMs: 5 * 60_000 })
    assert.equal(early.token, "early")
    assert.equal(readAuth().refresh_token, "refresh-2")

    // IdP down during a proactive refresh: the current token is still good.
    seedFresh({ access_token: "still-good", expires_at: Date.now() + 3 * 60_000 })
    const down = mockFetch({
        [META.token_endpoint]: () => {
            throw new TypeError("fetch failed")
        },
    })
    const kept = await getAccessToken({ fetchImpl: down, refreshWithinMs: 5 * 60_000 })
    assert.equal(kept.token, "still-good")
    assert.ok(readState().idp_down_until > Date.now())
})

test("getAccessToken: concurrent callers in one process share a single refresh", async () => {
    seedAuth()
    let hits = 0
    const fetchImpl = mockFetch({
        [META.token_endpoint]: async () => {
            hits += 1
            await new Promise((r) => setTimeout(r, 30))
            return json({ access_token: "shared", expires_in: 300, refresh_token: "refresh-2" })
        },
    })
    const [a, b, c] = await Promise.all([
        getAccessToken({ fetchImpl }),
        getAccessToken({ fetchImpl }),
        getAccessToken({ fetchImpl }),
    ])
    assert.equal(hits, 1)
    assert.equal(a.token, "shared")
    assert.equal(b.token, "shared")
    assert.equal(c.token, "shared")
})

test("getAccessToken: rotation race — invalid_grant on a token a sibling rotated away is NOT a dead sign-in", async () => {
    // Sibling persisted a fresh token under refresh-2 while our refresh-1 was in flight.
    seedAuth()
    const sibling = mockFetch({
        [META.token_endpoint]: (params) => {
            assert.equal(params.get("refresh_token"), "refresh-1")
            seedFresh({ access_token: "from-sibling", refresh_token: "refresh-2" })
            return json({ error: "invalid_grant" }, 400)
        },
    })
    const result = await getAccessToken({ fetchImpl: sibling })
    assert.equal(result.token, "from-sibling", "the sibling's token is used")
    assert.equal(sibling.calls.length, 1, "no second grant with the sibling's token")
    assert.equal(readAuth().refresh_token, "refresh-2", "sibling's rotated token untouched")
    assert.equal(readState().relogin_at, undefined, "never tombstone a token you did not own")

    // Sibling rotated but its access token is not fresh (yet): transient, tokens kept.
    seedAuth()
    const slow = mockFetch({
        [META.token_endpoint]: () => {
            seedAuth({ refresh_token: "refresh-2" })
            return json({ error: "invalid_grant" }, 400)
        },
    })
    assert.deepEqual(await getAccessToken({ fetchImpl: slow }), { token: null, reason: "busy" })
    assert.equal(readAuth().refresh_token, "refresh-2")
    assert.equal(readState().relogin_at, undefined)
})

test("getAccessToken: lock — dead-holder pid is broken at once, a stale mtime is broken, a live one is waited for", async () => {
    const lock = join(ciwgDir, "auth.lock")
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "after-lock", expires_in: 300 }),
    })

    // (1) A lock whose holder pid no longer exists — fresh mtime — is broken immediately.
    seedAuth()
    mkdirSync(lock)
    const dead = spawnSync(process.execPath, ["-e", "0"], { windowsHide: true })
    writeFileSync(join(lock, "pid"), String(dead.pid))
    const sleeps = []
    const t0 = Date.now()
    assert.equal(
        (await getAccessToken({ fetchImpl, sleep: async (ms) => sleeps.push(ms) })).token,
        "after-lock"
    )
    assert.deepEqual(sleeps, [], "no waiting on a dead holder")
    assert.ok(Date.now() - t0 < 1000)
    assert.ok(!existsSync(lock))

    // (2) No pid file, mtime older than the stale threshold → broken.
    seedAuth()
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    assert.equal((await getAccessToken({ fetchImpl })).token, "after-lock")
    assert.ok(!existsSync(lock))

    // (3) Live lock held by "another process" (our own pid is alive) that
    // releases after 250ms and leaves a fresh token behind — use it, never
    // refresh with the same rotating token.
    seedAuth()
    mkdirSync(lock)
    writeFileSync(join(lock, "pid"), String(process.pid))
    setTimeout(() => {
        seedFresh({ access_token: "sibling" })
        rmSync(lock, { recursive: true, force: true })
    }, 250)
    const calls = fetchImpl.calls.length
    const waited = await getAccessToken({ fetchImpl })
    assert.equal(waited.token, "sibling")
    assert.equal(fetchImpl.calls.length, calls, "no refresh after the sibling's")
})

test("getAccessToken: a live lock that is never released → busy (no refresh, tokens kept), bounded by the deadline", async () => {
    seedAuth()
    const lock = join(ciwgDir, "auth.lock")
    mkdirSync(lock)
    writeFileSync(join(lock, "pid"), String(process.pid))
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "must-not-happen", expires_in: 300 }),
    })
    const t0 = Date.now()
    const result = await getAccessToken({ fetchImpl, deadline: Date.now() + 2_800 })
    const elapsed = Date.now() - t0
    assert.deepEqual(result, { token: null, reason: "busy" })
    assert.equal(fetchImpl.calls.length, 0, "never refresh with a token a live sibling may be rotating")
    assert.equal(readAuth().refresh_token, "refresh-1")
    // lockWaitBudget = 2800 - API_RESERVE - MIN_HTTP = 550ms of waiting, not LOCK_WAIT_MS.
    assert.ok(elapsed >= 450 && elapsed < 1500, `waited ${elapsed}ms`)
    rmSync(lock, { recursive: true, force: true })
})

test("getAccessToken: a STALE lock the filesystem refuses to remove is waited out inside the deadline, yielding to the event loop (no synchronous spin)", async (t) => {
    // The regression: stale + undeletable → `continue` past the deadline
    // check and the sleep → an unbounded synchronous spin. Windows: a
    // directory that is some process's cwd cannot be removed (EBUSY) — the
    // same shape as Defender / the indexer holding auth.lock/pid. POSIX: a
    // parent without write permission refuses the rmdir (EACCES).
    seedAuth()
    const lock = join(ciwgDir, "auth.lock")
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old) // no pid file + stale mtime → lockIsStale() stays true
    let holder = null
    if (process.platform === "win32") {
        // The cwd handle is opened by the CHILD as it initialises, not by
        // CreateProcess — wait for its first output, which proves it runs.
        holder = spawn(
            process.execPath,
            ["-e", "process.stdout.write('held'); setTimeout(() => {}, 15000)"],
            { cwd: lock, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
        )
        await new Promise((resolve, reject) => {
            holder.stdout.once("data", resolve)
            holder.once("error", reject)
            holder.once("exit", () => reject(new Error("lock holder exited before it was used")))
        })
    } else {
        chmodSync(ciwgDir, 0o500)
    }
    try {
        // Precondition: the lock really is undeletable here (root, or an
        // exotic filesystem, may still remove it — then this machine has
        // nothing to test).
        let refused = false
        try {
            rmSync(lock, { recursive: true, force: true })
        } catch {
            refused = true
        }
        if (!refused || !existsSync(lock)) {
            t.skip("could not make auth.lock undeletable on this platform")
            return
        }
        assert.ok(Date.now() - statSync(lock).mtimeMs > 30_000, "the refused rm left the mtime alone")

        const fetchImpl = mockFetch({
            [META.token_endpoint]: () => json({ access_token: "must-not-happen", expires_in: 300 }),
        })
        let ticks = 0
        const ticker = setInterval(() => {
            ticks += 1
        }, 10)
        const t0 = Date.now()
        // lockWaitBudget = 3000 - API_RESERVE - MIN_HTTP = 750ms.
        const result = await getAccessToken({ fetchImpl, deadline: Date.now() + 3_000 })
        const elapsed = Date.now() - t0
        clearInterval(ticker)
        assert.deepEqual(result, { token: null, reason: "busy" })
        assert.ok(elapsed >= 600 && elapsed < 2_000, `waited ${elapsed}ms (budget 750ms)`)
        assert.ok(ticks >= 5, `event loop ticked ${ticks} times — the wait must be asynchronous`)
        assert.equal(fetchImpl.calls.length, 0, "never refreshed past a lock it could not take")
        assert.equal(readAuth().refresh_token, "refresh-1", "tokens kept")
    } finally {
        if (holder) {
            holder.kill()
            await new Promise((resolve) => holder.once("exit", resolve))
        } else {
            chmodSync(ciwgDir, 0o700)
        }
        rmSync(lock, { recursive: true, force: true })
    }
})

test("getAccessToken: a lock that can be neither stat'ed nor removed (deny ACL) is waited out inside the deadline, yielding to the event loop", async (t) => {
    // The second spin shape, distinct from EBUSY above: an explicit deny ACE
    // on auth.lock itself. mkdir → EEXIST, stat → EPERM, rm → EPERM, and
    // existsSync → false — so a loop that trusts existsSync to decide "gone,
    // retry at once" spins synchronously for ever (0 event-loop ticks). Two
    // guards, each sufficient: lockIsStale() treats a non-ENOENT stat error
    // as LIVE, and acquireLock allows one immediate retry per poll cycle.
    // Windows: `icacls <lock> /deny <user>:(F)` in the throwaway HOME.
    // POSIX: chmod 000 on the parent — but there mkdir reports EACCES, not
    // EEXIST (the lock is "unlockable", not "held"), so the probe below
    // skips; the EBUSY variant covers the POSIX refusal.
    seedAuth()
    const lock = join(ciwgDir, "auth.lock")
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old) // stale mtime (no pid file): pre-fix lockIsStale() said "stale"
    const user = userInfo().username
    const icacls = (...args) =>
        execFileSync("icacls", [lock, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let denied = false
    if (process.platform === "win32") {
        try {
            icacls("/deny", `${user}:(F)`)
            denied = true
        } catch (error) {
            t.skip(`icacls could not apply a deny ACE: ${error.message.split("\n")[0]}`)
            return
        }
    } else {
        chmodSync(ciwgDir, 0o000)
    }
    const errorCodeOf = (fn) => {
        try {
            fn()
            return null
        } catch (error) {
            return error.code ?? "unknown"
        }
    }
    try {
        // Precondition: the exact shape — held per mkdir, opaque to stat and
        // rm. Anything else (root, an exotic filesystem, POSIX) has nothing
        // to test here.
        const shape = {
            mkdir: errorCodeOf(() => mkdirSync(lock, { recursive: false })),
            stat: errorCodeOf(() => statSync(lock)),
            rm: errorCodeOf(() => rmSync(lock, { recursive: true, force: true })),
        }
        if (shape.mkdir !== "EEXIST" || shape.stat === null || shape.rm === null) {
            t.skip(`platform cannot reproduce the deny-ACL lock shape: ${JSON.stringify(shape)}`)
            return
        }

        const fetchImpl = mockFetch({
            [META.token_endpoint]: () => json({ access_token: "must-not-happen", expires_in: 300 }),
        })
        let ticks = 0
        const ticker = setInterval(() => {
            ticks += 1
        }, 10)
        const t0 = Date.now()
        // lockWaitBudget = 3000 - API_RESERVE - MIN_HTTP = 750ms; the whole
        // call must come back inside the 3 s deadline (+ slop), not spin.
        const deadline = Date.now() + 3_000
        const result = await getAccessToken({ fetchImpl, deadline })
        const elapsed = Date.now() - t0
        clearInterval(ticker)
        assert.deepEqual(result, { token: null, reason: "busy" })
        assert.ok(Date.now() < deadline + 1_000, `returned ${elapsed}ms after t0 — past the 3 s deadline`)
        assert.ok(elapsed >= 600 && elapsed < 2_000, `waited ${elapsed}ms (budget 750ms)`)
        assert.ok(ticks >= 5, `event loop ticked ${ticks} times — the wait must be asynchronous`)
        assert.equal(fetchImpl.calls.length, 0, "never refreshed past a lock it could not take")
        assert.equal(readAuth().refresh_token, "refresh-1", "tokens kept")
    } finally {
        if (denied) {
            try {
                icacls("/remove:d", user)
            } catch {
                icacls("/reset")
            }
        } else if (process.platform !== "win32") {
            chmodSync(ciwgDir, 0o700)
        }
        rmSync(lock, { recursive: true, force: true })
        assert.ok(!existsSync(lock), "deny ACE restored and lock removed")
    }
})

test("persistAuth: a rotated refresh token is written with retries and never dies with an exception", async () => {
    // Transient write failures: retried with backoff, then succeeds.
    let attempts = 0
    const sleeps = []
    const flaky = () => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error("EPERM: rename"), { code: "EPERM" })
    }
    assert.equal(await persistAuth({ access_token: "x" }, { sleep: async (ms) => sleeps.push(ms), write: flaky }), true)
    assert.equal(attempts, 3)
    assert.deepEqual(sleeps, [50, 150])

    // Persistent failure: exhausts the retries, falls back, reports false — no throw.
    const dead = () => {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    }
    const sleeps2 = []
    mkdirSync(authPath(), { recursive: true }) // auth.json as a DIRECTORY defeats the plain-write fallback too
    assert.equal(await persistAuth({ access_token: "x" }, { sleep: async (ms) => sleeps2.push(ms), write: dead }), false)
    assert.deepEqual(sleeps2, [50, 150, 450])
    rmSync(authPath(), { recursive: true, force: true })

    // End to end: the refresh succeeds, the disk refuses — the hook still
    // gets the new token for THIS call and nothing is thrown.
    seedAuth()
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => {
            rmSync(authPath(), { force: true })
            mkdirSync(authPath())
            return json({ access_token: "in-memory-only", expires_in: 300, refresh_token: "refresh-2" })
        },
    })
    const result = await getAccessToken({ fetchImpl, sleep: noSleep })
    assert.equal(result.token, "in-memory-only")
    rmSync(authPath(), { recursive: true, force: true })
})

// ------------------------------------------------------------ time budget

test("budget: every hooks.json timeout covers HOOK_BUDGET_MS plus start-up/flush margin; lock wait ≥ refresh + 1s", () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")).hooks
    const timeouts = Object.values(hooks).flatMap((groups) =>
        groups.flatMap((group) => group.hooks.map((h) => h.timeout))
    )
    assert.equal(timeouts.length, 3)
    for (const seconds of timeouts) {
        assert.ok(seconds * 1000 >= HOOK_BUDGET_MS + 500, `hook timeout ${seconds}s < budget ${HOOK_BUDGET_MS}ms + margin`)
    }
    assert.ok(TIMING.LOCK_WAIT_MS >= TIMING.HTTP_TIMEOUT_MS + 1000)
    // A hook must have room for at least a minimal refresh AND the API reserve.
    assert.ok(HOOK_BUDGET_MS > TIMING.API_RESERVE_MS + TIMING.MIN_HTTP_MS)
})

test("budget: refresh + API call never exceed the deadline — a hung IdP is cut so the API still had its reserve", async () => {
    seedAuth()
    const fetchImpl = mockFetch({ [META.token_endpoint]: hang, [SEARCH_URL]: hang })
    const deadline = Date.now() + 3_000
    const t0 = Date.now()
    const result = await searchKnowledge({ q: "acme" }, { deadline, fetchImpl })
    const elapsed = Date.now() - t0
    assert.equal(result.status, "network", "the hung refresh is a transient failure")
    assert.ok(elapsed < 3_000, `auth + api took ${elapsed}ms — over the ${3_000}ms deadline`)
    // The refresh was cut at httpBudget = 3000 - API_RESERVE (1500), not HTTP_TIMEOUT (4000).
    assert.ok(elapsed >= 1_200 && elapsed <= 2_400, `refresh cut at ${elapsed}ms`)
    assert.equal(fetchImpl.calls.length, 1, "no API call was attempted once the credential failed")
    assert.equal(readAuth().refresh_token, "refresh-1", "tokens kept")
})

test("budget: a hung API is cut at the remaining deadline; a spent deadline skips the call", async () => {
    seedFresh()
    const fetchImpl = mockFetch({ [SEARCH_URL]: hang })
    const t0 = Date.now()
    const result = await searchKnowledge({ q: "acme" }, { deadline: Date.now() + 1_000, fetchImpl })
    const elapsed = Date.now() - t0
    assert.equal(result.status, "network")
    assert.ok(elapsed >= 800 && elapsed < 1_600, `api cut at ${elapsed}ms`)
    assert.ok(readState().api_down_until > Date.now(), "API backoff set")

    resetCredentialMemo()
    rmSync(statePath, { force: true })
    const spent = await searchKnowledge({ q: "acme" }, { deadline: Date.now() + 50, fetchImpl })
    assert.equal(spent.status, "timeout")
    assert.equal(fetchImpl.calls.length, 1, "no call started with 50ms left")
})

test("budget: a 200 whose BODY stalls is cut by the same timer as the headers — refresh (under the lock) and API alike", async () => {
    // A Response whose body never ends and never looks at the abort signal:
    // the timer must win however the fetch implementation's body behaves.
    const stalledBody = () =>
        new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
        })

    seedAuth()
    const idp = mockFetch({ [META.token_endpoint]: stalledBody })
    const t0 = Date.now()
    // httpBudget = 2500 - API_RESERVE = 1000ms for the whole refresh exchange.
    const refreshed = await getAccessToken({ fetchImpl: idp, deadline: Date.now() + 2_500 })
    const elapsed = Date.now() - t0
    assert.deepEqual(refreshed, { token: null, reason: "network" })
    assert.ok(elapsed >= 800 && elapsed < 1_800, `refresh cut at ${elapsed}ms`)
    assert.ok(!existsSync(join(ciwgDir, "auth.lock")), "lock released after the cut")
    assert.equal(readAuth().refresh_token, "refresh-1", "tokens kept")

    rmSync(statePath, { force: true })
    seedFresh()
    resetCredentialMemo()
    const api = mockFetch({ [SEARCH_URL]: stalledBody })
    const t1 = Date.now()
    const result = await searchKnowledge({ q: "acme" }, { deadline: Date.now() + 1_000, fetchImpl: api })
    const elapsedApi = Date.now() - t1
    assert.equal(result.status, "network")
    assert.ok(elapsedApi >= 800 && elapsedApi < 1_600, `api cut at ${elapsedApi}ms`)
})

test("budget: a refresh with too little time left is skipped (tokens kept) rather than started", async () => {
    seedAuth()
    const fetchImpl = mockFetch({ [META.token_endpoint]: hang })
    const result = await getAccessToken({ fetchImpl, deadline: Date.now() + 1_000 })
    assert.deepEqual(result, { token: null, reason: "timeout" })
    assert.equal(fetchImpl.calls.length, 0)
    assert.equal(readAuth().refresh_token, "refresh-1")
})

// ------------------------------------------------------------ precedence

test("resolveAuth: legacy CIWG_KNOWLEDGE_TOKEN wins over a valid SSO session", async () => {
    seedFresh()
    process.env.CIWG_KNOWLEDGE_TOKEN = " leg acy\n"
    const fetchImpl = mockFetch({})
    const result = await resolveAuth({ fetchImpl })
    assert.equal(result.kind, "api-token")
    assert.deepEqual(result.headers, { "X-API-Token": "legacy" })
    assert.equal(fetchImpl.calls.length, 0)
})

test("resolveAuth: legacy ~/.ciwg/knowledge.json token wins too (BOM tolerated)", async () => {
    seedFresh()
    mkdirSync(ciwgDir, { recursive: true })
    writeFileSync(join(ciwgDir, "knowledge.json"), "﻿" + JSON.stringify({ token: "file-token" }))
    assert.equal(getLegacyToken(), "file-token")
    const result = await resolveAuth({ fetchImpl: mockFetch({}) })
    assert.deepEqual(result.headers, { "X-API-Token": "file-token" })
})

test("resolveAuth: SSO session → Bearer header; nothing → no-token; dropped → relogin", async () => {
    assert.deepEqual(await resolveAuth({ fetchImpl: mockFetch({}) }), { ok: false, status: "no-token" })

    seedFresh()
    const ok = await resolveAuth({ fetchImpl: mockFetch({}) })
    assert.equal(ok.kind, "oidc")
    assert.deepEqual(ok.headers, { Authorization: "Bearer fresh" })
    assert.equal(ok.email, "ada@ciwebgroup.com")
    assert.ok(ok.expiresAt > Date.now())

    rmSync(authPath(), { force: true })
    seedRelogin()
    assert.deepEqual(await resolveAuth({ fetchImpl: mockFetch({}) }), { ok: false, status: "relogin" })
})

test("API calls: credential is checked BEFORE the backoff — no-token is never masked as backoff", async () => {
    updateState({ api_down_until: Date.now() + 60_000 })
    assert.deepEqual(await searchKnowledge({ q: "x" }, { fetchImpl: mockFetch({}) }), { ok: false, status: "no-token" })
    seedFresh()
    resetCredentialMemo()
    assert.deepEqual(await searchKnowledge({ q: "x" }, { fetchImpl: mockFetch({}) }), { ok: false, status: "backoff" })
})

test("API 401 with an SSO token → actionable api-rejected status, visible in --status, cleared by the next 2xx", async () => {
    seedFresh()
    let status = 401
    const fetchImpl = mockFetch({
        [SEARCH_URL]: (params, init) => {
            if (process.env.CIWG_KNOWLEDGE_TOKEN) {
                assert.equal(init.headers["X-API-Token"], "legacy")
            } else {
                assert.equal(init.headers.Authorization, "Bearer fresh")
            }
            return status === 401 ? new Response("", { status: 401 }) : json({ hits: [] })
        },
        [ARTIFACTS_URL]: () => new Response("", { status: 401 }),
    })
    assert.deepEqual(await searchKnowledge({ q: "x" }, { fetchImpl }), { ok: false, status: "api-rejected" })
    assert.ok(readState().api_rejected_at)
    assert.match(describeFailure("api-rejected"), /\/ciwg-login.*may not trust this app/)
    const shown = describeAuthStatus()
    assert.match(shown, /REJECTED this token \(HTTP 401/)
    assert.doesNotMatch(shown, /access token valid/)
    // Both MCP tools go through the same helper.
    assert.deepEqual(await getSourceArtifacts({ sourceType: "a", sourceId: "b" }, { fetchImpl }), { ok: false, status: "api-rejected" })

    // A refreshed token is not "accepted" just because it is new: --status
    // keeps the earlier rejection on record until the API answers 2xx.
    seedFresh({ expires_at: Date.now() + 20 * 60_000 })
    const afterRefresh = describeAuthStatus()
    assert.match(afterRefresh, /access token valid/)
    assert.match(afterRefresh, /rejected an earlier sign-in token \(HTTP 401 at /)
    resetCredentialMemo()

    status = 200
    assert.equal((await searchKnowledge({ q: "x" }, { fetchImpl })).ok, true)
    assert.equal(readState().api_rejected_at, undefined, "cleared once the API accepts the token")
    assert.match(describeAuthStatus(), /access token valid/)
    assert.doesNotMatch(describeAuthStatus(), /earlier sign-in token/)

    // A legacy token's 401 is the plain numeric status.
    process.env.CIWG_KNOWLEDGE_TOKEN = "legacy"
    resetCredentialMemo()
    status = 401
    assert.deepEqual(await searchKnowledge({ q: "x" }, { fetchImpl }), { ok: false, status: 401 })
})

test("describeFailure: sign-in statuses point at /ciwg-login; transient ones do not", () => {
    assert.match(describeFailure("no-token"), /\/ciwg-login/)
    assert.match(describeFailure("relogin"), /\/ciwg-login/)
    assert.doesNotMatch(describeFailure("relogin"), /token/i)
    assert.match(describeFailure("busy"), /refreshing/)
    assert.match(describeFailure("timeout"), /time/)
    assert.doesNotMatch(describeFailure("busy"), /\/ciwg-login/)
})

// -------------------------------------------------------- loopback flow

/** Simulate the browser hitting the loopback redirect. */
function browserGet(url) {
    return new Promise((resolve, reject) => {
        httpGet(url, (res) => {
            let body = ""
            res.on("data", (chunk) => (body += chunk))
            res.on("end", () => resolve({ status: res.statusCode, body }))
        }).on("error", reject)
    })
}

test("startLoopbackListener: 127.0.0.1 only, state-matched single shot (404 / 400 / 200 / 410), closed after", async () => {
    const listener = await startLoopbackListener({ state: "s3cret", timeoutMs: 5_000 })
    const base = `http://127.0.0.1:${listener.port}`
    assert.equal((await browserGet(`${base}/`)).status, 404)
    assert.equal((await browserGet(`${base}/callback?code=evil&state=nope`)).status, 400)
    assert.equal((await browserGet(`${base}/callback?state=s3cret`)).status, 400, "missing code")
    const done = await browserGet(`${base}/callback?code=the-code&state=s3cret`)
    assert.equal(done.status, 200)
    assert.match(done.body, /close this window/)
    assert.deepEqual(await listener.result, { code: "the-code" })
    assert.equal((await browserGet(`${base}/callback?code=again&state=s3cret`)).status, 410, "single shot")
    listener.close()
    await assert.rejects(browserGet(`${base}/callback?code=x&state=y`), "listener closed")
})

test("loginWithBrowser: PKCE + state + loopback end to end, tokens persisted, state cleared", async () => {
    seedRelogin("old@ciwebgroup.com")
    updateState({ api_rejected_at: 1, idp_down_until: Date.now() + 60_000, first_run_hint_at: 5 })
    let challenge
    let redirectUri
    let sentCode
    const fetchImpl = mockFetch({
        ...discoveryHandlers(),
        [META.token_endpoint]: (params) => {
            assert.equal(params.get("grant_type"), "authorization_code")
            assert.equal(params.get("client_id"), OIDC_CLIENT_ID)
            assert.equal(params.get("redirect_uri"), redirectUri)
            assert.equal(params.get("code"), sentCode)
            assert.equal(sha256url(params.get("code_verifier")), challenge, "verifier matches challenge")
            return json({
                access_token: "loop-access",
                expires_in: 600,
                refresh_token: "loop-refresh",
                id_token: fakeJwt({ email: "grace@ciwebgroup.com" }),
            })
        },
    })
    const logs = []
    let state
    let signalOpened
    const opened = new Promise((resolve) => {
        signalOpened = resolve
    })
    // The opener resolves at once — the flow must NOT wait on it.
    const openBrowser = async (url) => {
        const u = new URL(url)
        assert.equal(u.origin + u.pathname, META.authorization_endpoint)
        assert.equal(u.searchParams.get("response_type"), "code")
        assert.equal(u.searchParams.get("client_id"), OIDC_CLIENT_ID)
        assert.equal(u.searchParams.get("scope"), OIDC_SCOPES)
        assert.equal(u.searchParams.get("code_challenge_method"), "S256")
        challenge = u.searchParams.get("code_challenge")
        redirectUri = u.searchParams.get("redirect_uri")
        assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
        state = u.searchParams.get("state")
        assert.ok(state.length >= 16)
        signalOpened()
    }
    const pendingLogin = loginWithBrowser({
        issuer: ISSUER,
        fetchImpl,
        openBrowser,
        log: (line) => logs.push(line),
        timeoutMs: 10_000,
    })
    await opened
    // Probing while the flow waits: wrong state and a missing code are ignored.
    assert.equal((await browserGet(`${redirectUri}?code=evil&state=nope`)).status, 400)
    assert.equal((await browserGet(`${redirectUri}?state=${state}`)).status, 400)
    sentCode = "the-code"
    assert.equal((await browserGet(`${redirectUri}?code=${sentCode}&state=${state}`)).status, 200)

    const result = await pendingLogin
    assert.equal(result.email, "grace@ciwebgroup.com")
    assert.equal(result.hasRefreshToken, true)
    const stored = readAuth()
    assert.equal(stored.access_token, "loop-access")
    assert.equal(stored.refresh_token, "loop-refresh")
    assert.equal(stored.revocation_endpoint, META.revocation_endpoint)
    const after = readState()
    assert.equal(after.relogin_at, undefined, "dropped-sign-in state cleared by a login")
    assert.equal(after.api_rejected_at, undefined)
    assert.equal(after.idp_down_until, undefined)
    assert.equal(after.first_run_hint_at, 5, "unrelated state untouched")
    // Nothing secret in the log: no verifier, no code, no tokens.
    const logged = logs.join("\n")
    assert.doesNotMatch(logged, /loop-access|loop-refresh|the-code|code_verifier/)
    // The listener is gone.
    await assert.rejects(browserGet(`${redirectUri}?code=x&state=y`))
})

test("loginWithBrowser: a browser that cannot open is not fatal (URL is logged); a BLOCKING opener does not stall the flow", async () => {
    let redirectUri
    let state
    const fetchImpl = mockFetch({
        ...discoveryHandlers(),
        [META.token_endpoint]: () => json({ access_token: "a", expires_in: 60, refresh_token: "r" }),
    })
    const logs = []
    const pending = loginWithBrowser({
        issuer: ISSUER,
        fetchImpl,
        openBrowser: async (url) => {
            const u = new URL(url)
            redirectUri = u.searchParams.get("redirect_uri")
            state = u.searchParams.get("state")
            throw new Error("no xdg-open")
        },
        log: (line) => logs.push(line),
        timeoutMs: 10_000,
    })
    // Give the flow a tick to reach the wait, then "click" the printed URL.
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(logs.some((l) => l.includes("could not open a browser")))
    assert.ok(logs.some((l) => l.includes(META.authorization_endpoint)))
    await browserGet(`${redirectUri}?code=c&state=${state}`)
    assert.equal((await pending).hasRefreshToken, true)

    // An opener that never returns (some xdg-open wrappers block until the
    // window closes) must not keep the flow from finishing.
    let uri2
    let state2
    const stuck = loginWithBrowser({
        issuer: ISSUER,
        fetchImpl,
        openBrowser: (url) =>
            new Promise(() => {
                const u = new URL(url)
                uri2 = u.searchParams.get("redirect_uri")
                state2 = u.searchParams.get("state")
            }),
        timeoutMs: 10_000,
    })
    await new Promise((r) => setTimeout(r, 50))
    await browserGet(`${uri2}?code=c&state=${state2}`)
    assert.equal((await stuck).hasRefreshToken, true)
})

test("loginWithBrowser: times out and closes the listener; error callback rejects", async () => {
    const fetchImpl = mockFetch(discoveryHandlers())
    let redirectUri
    await assert.rejects(
        loginWithBrowser({
            issuer: ISSUER,
            fetchImpl,
            openBrowser: async (url) => {
                redirectUri = new URL(url).searchParams.get("redirect_uri")
            },
            timeoutMs: 150,
        }),
        /timed out/
    )
    await assert.rejects(browserGet(`${redirectUri}?code=x&state=y`), "listener closed after timeout")
    assert.equal(readAuth(), null)

    await assert.rejects(
        loginWithBrowser({
            issuer: ISSUER,
            fetchImpl,
            openBrowser: async (url) => {
                const u = new URL(url)
                await browserGet(
                    `${u.searchParams.get("redirect_uri")}?error=access_denied&error_description=nope&state=${u.searchParams.get("state")}`
                )
            },
            timeoutMs: 5000,
        }),
        /access_denied/
    )
})

test("browserLaunchSpec: Windows never goes through cmd.exe; the URL is one argv element, byte for byte", () => {
    const url =
        "https://sso.ciwgserver.com/application/o/authorize/?redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&scope=openid%20profile&state=a%26b%3Dc"
    const win = browserLaunchSpec(url, "win32")
    assert.notEqual(win.command.toLowerCase(), "cmd.exe")
    assert.notEqual(win.command.toLowerCase(), "cmd")
    assert.equal(win.command, "rundll32")
    assert.deepEqual(win.args, ["url.dll,FileProtocolHandler", url], "raw URL, no quoting, no %XX% exposure")
    assert.ok(win.args.includes(url))
    assert.deepEqual(browserLaunchSpec(url, "darwin"), { command: "open", args: [url] })
    assert.deepEqual(browserLaunchSpec(url, "linux"), { command: "xdg-open", args: [url] })
})

// ---------------------------------------------------------- device flow

test("loginWithDeviceCode: prints URL + code, polls with slow_down, persists", async () => {
    let polls = 0
    const fetchImpl = mockFetch({
        ...discoveryHandlers(),
        [META.device_authorization_endpoint]: (params) => {
            assert.equal(params.get("client_id"), OIDC_CLIENT_ID)
            assert.equal(params.get("scope"), OIDC_SCOPES)
            return json({
                device_code: "dev-secret",
                user_code: "ABCD-EFGH",
                verification_uri: "https://sso.example.test/device",
                verification_uri_complete: "https://sso.example.test/device?code=ABCD-EFGH",
                expires_in: 600,
                interval: 5,
            })
        },
        [META.token_endpoint]: (params) => {
            assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code")
            assert.equal(params.get("device_code"), "dev-secret")
            assert.equal(params.get("client_id"), OIDC_CLIENT_ID)
            polls += 1
            if (polls === 1) return json({ error: "authorization_pending" }, 400)
            if (polls === 2) return json({ error: "slow_down" }, 400)
            return json({
                access_token: "dev-access",
                expires_in: 600,
                refresh_token: "dev-refresh",
                id_token: fakeJwt({ email: "linus@ciwebgroup.com" }),
            })
        },
    })
    const sleeps = []
    const logs = []
    const result = await loginWithDeviceCode({
        issuer: ISSUER,
        fetchImpl,
        sleep: async (ms) => sleeps.push(ms),
        log: (line) => logs.push(line),
    })
    assert.equal(result.email, "linus@ciwebgroup.com")
    assert.deepEqual(sleeps, [5000, 5000, 10000], "slow_down adds 5s")
    assert.equal(readAuth().refresh_token, "dev-refresh")
    const logged = logs.join("\n")
    assert.match(logged, /ABCD-EFGH/)
    assert.match(logged, /sso\.example\.test\/device\?code=ABCD-EFGH/)
    assert.doesNotMatch(logged, /dev-secret|dev-access|dev-refresh/)
})

test("loginWithDeviceCode: polling survives network blips (RFC 8628) and stops at the code's own expiry", async () => {
    let polls = 0
    const device = () =>
        json({ device_code: "d", user_code: "U", verification_uri: "https://sso.example.test/device", expires_in: 600, interval: 1 })
    const blippy = mockFetch({
        ...discoveryHandlers(),
        [META.device_authorization_endpoint]: device,
        [META.token_endpoint]: () => {
            polls += 1
            if (polls === 1) throw new TypeError("fetch failed")
            if (polls === 2) return json({ error: "authorization_pending" }, 400)
            if (polls === 3) throw new TypeError("fetch failed")
            return json({ access_token: "a", expires_in: 60, refresh_token: "r" })
        },
    })
    const result = await loginWithDeviceCode({ issuer: ISSUER, fetchImpl: blippy, sleep: noSleep })
    assert.equal(result.hasRefreshToken, true)
    assert.equal(polls, 4)

    // Deferred finish long after the device code expired: no endless polling.
    const stale = mockFetch({
        ...discoveryHandlers(),
        [META.device_authorization_endpoint]: device,
        [META.token_endpoint]: () => json({ error: "authorization_pending" }, 400),
    })
    const started = await loginWithDeviceCode({
        issuer: ISSUER,
        fetchImpl: stale,
        waitForApproval: false,
        now: () => Date.now() - 20 * 60_000,
    })
    assert.equal(started.pending, true)
    await assert.rejects(finishDeviceLogin({ fetchImpl: stale, sleep: noSleep }), /expired/)

    // An IdP that stays down is reported, not polled forever.
    const down = mockFetch({
        ...discoveryHandlers(),
        [META.device_authorization_endpoint]: device,
        [META.token_endpoint]: () => {
            throw new TypeError("fetch failed")
        },
    })
    await assert.rejects(loginWithDeviceCode({ issuer: ISSUER, fetchImpl: down, sleep: noSleep }), /stayed unreachable/)
})

test("loginWithDeviceCode: deferred start/finish via the pending file", async () => {
    let polls = 0
    const fetchImpl = mockFetch({
        ...discoveryHandlers(),
        [META.device_authorization_endpoint]: () =>
            json({
                device_code: "dev-2",
                user_code: "WXYZ-1234",
                verification_uri: "https://sso.example.test/device",
                expires_in: 600,
                interval: 1,
            }),
        [META.token_endpoint]: () => {
            polls += 1
            return polls < 2
                ? json({ error: "authorization_pending" }, 400)
                : json({ access_token: "a", expires_in: 60, refresh_token: "r" })
        },
    })
    const started = await loginWithDeviceCode({
        issuer: ISSUER,
        fetchImpl,
        waitForApproval: false,
    })
    assert.equal(started.pending, true)
    assert.equal(started.userCode, "WXYZ-1234")
    const pendingPath = join(ciwgDir, "auth-pending.json")
    assert.ok(existsSync(pendingPath))
    if (process.platform !== "win32") {
        assert.equal(statSync(pendingPath).mode & 0o777, 0o600)
    }
    assert.equal(readAuth(), null)

    const finished = await finishDeviceLogin({ fetchImpl, sleep: noSleep })
    assert.equal(finished.hasRefreshToken, true)
    assert.ok(!existsSync(pendingPath), "pending device code removed")
    await assert.rejects(finishDeviceLogin({ fetchImpl, sleep: noSleep }), /no pending/)
})

test("loginWithDeviceCode: denied / expired / not enabled surface as errors", async () => {
    const device = () =>
        json({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://sso.example.test/device",
            expires_in: 600,
            interval: 1,
        })
    for (const [error, pattern] of [
        ["access_denied", /denied/],
        ["expired_token", /expired/],
    ]) {
        const fetchImpl = mockFetch({
            ...discoveryHandlers(),
            [META.device_authorization_endpoint]: device,
            [META.token_endpoint]: () => json({ error }, 400),
        })
        await assert.rejects(
            loginWithDeviceCode({ issuer: ISSUER, fetchImpl, sleep: noSleep }),
            pattern
        )
    }
    const notEnabled = mockFetch({
        ...discoveryHandlers(),
        [META.device_authorization_endpoint]: () => json({ error: "invalid_request" }, 400),
    })
    await assert.rejects(
        loginWithDeviceCode({ issuer: ISSUER, fetchImpl: notEnabled }),
        /device code flow/
    )
    assert.equal(readAuth(), null)
})

// ----------------------------------------------------------------- logout

test("logout: revokes the refresh token, wipes the cache and state, holds the first-run nudge for a day", async () => {
    seedAuth()
    seedRelogin()
    signInHint("relogin", "s1")
    const fetchImpl = mockFetch({
        [META.revocation_endpoint]: (params) => {
            assert.equal(params.get("token"), "refresh-1")
            assert.equal(params.get("token_type_hint"), "refresh_token")
            assert.equal(params.get("client_id"), OIDC_CLIENT_ID)
            return new Response("", { status: 200 })
        },
    })
    const result = await logout({ fetchImpl })
    assert.deepEqual(result, { hadSession: true, revoked: true, email: "ada@ciwebgroup.com" })
    assert.equal(readAuth(), null)
    const state = readState()
    assert.equal(state.relogin_at, undefined)
    assert.equal(state.relogin_hint_session, undefined)
    assert.ok(state.first_run_hint_at, "a deliberate sign-out is not a first run")
    assert.equal(signInHint("no-token", "s2"), null, "no nag right after signing out")
    const status = describeAuthStatus().split("\n")
    assert.equal(status[0], "SSO: not signed in — run /ciwg-login.")
    // Signing out also holds the automatic browser sign-in for a day.
    assert.ok(state.auto_login_at, "auto-login held after a deliberate sign-out")
    assert.match(status[1], /Automatic sign-in: held until/)

    // Nothing cached: a no-op, no network.
    const idle = mockFetch({})
    assert.equal((await logout({ fetchImpl: idle })).hadSession, false)
    assert.equal(idle.calls.length, 0)

    // Revocation endpoint down: the local wipe still happens.
    seedAuth()
    const down = mockFetch({
        [META.revocation_endpoint]: () => {
            throw new TypeError("fetch failed")
        },
    })
    const wiped = await logout({ fetchImpl: down })
    assert.equal(wiped.revoked, false)
    assert.equal(readAuth(), null)
})

test("logout: also removes the previous plugin version's marker files (knowledge-down, login-hint, relogin-hint)", async () => {
    const markers = ["knowledge-down", "login-hint", "relogin-hint"]
    seedFresh()
    for (const name of markers) writeFileSync(join(ciwgDir, name), String(Date.now()))
    await logout({
        fetchImpl: mockFetch({ [META.revocation_endpoint]: () => new Response("", { status: 200 }) }),
    })
    for (const name of markers) assert.ok(!existsSync(join(ciwgDir, name)), `${name} removed`)
    assert.equal(readAuth(), null)
})

test('readAuth: a malformed auth.json (refresh_token not a string) reads as not signed in — no refresh is dialled with "[object Object]"', async () => {
    seedAuth()
    const raw = JSON.parse(readFileSync(authPath(), "utf8"))
    writeFileSync(authPath(), JSON.stringify({ ...raw, refresh_token: { token: "refresh-1" } }))
    assert.equal(readAuth(), null)
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "must-not-happen", expires_in: 300 }),
    })
    assert.deepEqual(await getAccessToken({ fetchImpl }), { token: null, reason: "none" })
    assert.equal(fetchImpl.calls.length, 0, "nothing dialled")
    assert.deepEqual(await resolveAuth({ fetchImpl }), { ok: false, status: "no-token" })

    // Any wrong-typed field is malformed; an ABSENT optional field is fine.
    for (const patch of [{ token_endpoint: 42 }, { access_token: null }, { email: ["x"] }]) {
        writeFileSync(authPath(), JSON.stringify({ ...raw, ...patch }))
        assert.equal(readAuth(), null, JSON.stringify(patch))
    }
    const { email, ...withoutEmail } = raw
    writeFileSync(authPath(), JSON.stringify(withoutEmail))
    assert.equal(readAuth()?.refresh_token, "refresh-1")
    void email
})

// ---------------------------------------------------------------- hints

test("signInHint: one cadence rule — first run once a day, relogin / api-rejected once per session, hourly without a session id", () => {
    const now = Date.parse("2026-09-09T12:00:00Z")
    assert.equal(signInHint("no-token", "s1", { now }), auth.LOGIN_HINT_FIRST_RUN)
    assert.equal(signInHint("no-token", "s2", { now: now + 60_000 }), null, "daily, regardless of session")
    assert.equal(signInHint("no-token", "s2", { now: now + 25 * 60 * 60_000 }), auth.LOGIN_HINT_FIRST_RUN)

    assert.equal(signInHint("relogin", "session-a"), auth.LOGIN_HINT_RELOGIN)
    assert.equal(signInHint("relogin", "session-a"), null)
    assert.equal(signInHint("relogin", "session-b"), auth.LOGIN_HINT_RELOGIN)
    assert.equal(signInHint("relogin", "session-a"), auth.LOGIN_HINT_RELOGIN, "a different session re-arms it")
    // No session id: hourly. (The per-session calls above stamped the real
    // clock, so this leg runs on a clock 10 h ahead of it.)
    const later = Date.now() + 10 * 60 * 60_000
    assert.equal(signInHint("relogin", undefined, { now: later }), auth.LOGIN_HINT_RELOGIN)
    assert.equal(signInHint("relogin", undefined, { now: later + 60_000 }), null)
    assert.equal(signInHint("relogin", undefined, { now: later + 61 * 60_000 }), auth.LOGIN_HINT_RELOGIN)

    assert.equal(signInHint("api-rejected", "s1"), auth.LOGIN_HINT_API_REJECTED)
    assert.equal(signInHint("api-rejected", "s1"), null)
    // Transient statuses never nudge.
    for (const status of ["network", "http", "busy", "timeout", "backoff", 403]) {
        assert.equal(signInHint(status, "s1"), null)
    }
})

// ------------------------------------------------- hooks (real processes)

const execFileAsync = promisify(execFile)

/** Run a hook script exactly as Claude Code does: payload on stdin, JSON
 * (or nothing) on stdout. Sync so stdin is written and CLOSED — a hook
 * blocks on readStdin() until EOF. */
function runHook(script, payload, extraEnv = {}) {
    const stdout = execFileSync(process.execPath, [join(scriptsDir, script)], {
        env: {
            ...process.env,
            HOME: fakeHome,
            USERPROFILE: fakeHome,
            CIWG_KNOWLEDGE_TOKEN: "",
            CIWG_KNOWLEDGE_URL: "http://127.0.0.1:9",
            // These tests cover the HINT path; the automatic browser sign-in
            // (autologin.test.mjs) must never spawn a child from here — it
            // would dial the real issuer and open a real browser.
            CIWG_AUTO_LOGIN: "off",
            CIWG_KNOWLEDGE_NO_BROWSER: "1",
            ...extraEnv,
        },
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
    })
    return stdout.trim() ? JSON.parse(stdout) : null
}

test("SessionStart hook: never signed in → one-line /ciwg-login hint, once a day", () => {
    const payload = { session_id: "s-1", cwd: fakeHome, source: "startup" }
    const first = runHook("session-brief.mjs", payload)
    assert.equal(first.hookSpecificOutput.hookEventName, "SessionStart")
    assert.match(first.hookSpecificOutput.additionalContext, /\/ciwg-login/)
    assert.equal(first.hookSpecificOutput.additionalContext.split("\n").length, 1)
    assert.equal(runHook("session-brief.mjs", payload), null, "silent until tomorrow")
    // Compaction never nudges.
    rmSync(statePath, { force: true })
    assert.equal(runHook("session-brief.mjs", { ...payload, source: "compact" }), null)
})

test("hooks: dropped sign-in → one relogin line per session, then silence", () => {
    seedRelogin()
    const start = runHook("session-brief.mjs", { session_id: "s-9", cwd: fakeHome, source: "startup" })
    assert.match(start.hookSpecificOutput.additionalContext, /expired or been revoked.*\/ciwg-login/)
    const prompt = { session_id: "s-9", cwd: fakeHome, prompt: "what did we agree with Acme HVAC last week?" }
    assert.equal(runHook("inject-context.mjs", prompt), null, "same session: silent")
    const other = runHook("inject-context.mjs", { ...prompt, session_id: "s-10" })
    assert.equal(other.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.match(other.hookSpecificOutput.additionalContext, /\/ciwg-login/)
    assert.equal(runHook("inject-context.mjs", { ...prompt, session_id: "s-10" }), null)
})

test("hooks: with a legacy token the sign-in nudges never fire", () => {
    // The dead API port makes the legacy call fail fast → silent (fail-open),
    // and crucially no first-run hint is ever recorded.
    const out = runHook(
        "session-brief.mjs",
        { session_id: "s-2", cwd: fakeHome, source: "startup" },
        { CIWG_KNOWLEDGE_TOKEN: "legacy-token" }
    )
    assert.equal(out, null)
    assert.equal(readState().first_run_hint_at, undefined)
})

test("hooks: a hook process finishes inside the hooks.json timeout even when the API hangs", async () => {
    // A 127.0.0.1 API that accepts the connection and never answers.
    const server = createServer(() => {})
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const { port } = server.address()
    try {
        seedFresh()
        const t0 = Date.now()
        const out = runHook(
            "inject-context.mjs",
            { session_id: "s-3", cwd: fakeHome, prompt: "what did we agree with Acme HVAC last week?" },
            { CIWG_KNOWLEDGE_URL: `http://127.0.0.1:${port}` }
        )
        const elapsed = Date.now() - t0
        assert.equal(out, null, "fail-open, silent")
        const hooks = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")).hooks
        const timeoutMs = hooks.UserPromptSubmit[0].hooks[0].timeout * 1000
        assert.ok(elapsed < timeoutMs, `hook took ${elapsed}ms ≥ ${timeoutMs}ms timeout`)
    } finally {
        server.closeAllConnections?.()
        server.close()
    }
})

test("login.mjs --status and logout.mjs never print token material; the legacy note is one shared sentence", async () => {
    seedFresh({ access_token: "sekrit-access", refresh_token: "sekrit-refresh" })
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CIWG_KNOWLEDGE_TOKEN: "" }
    const status = await execFileAsync(process.execPath, [join(scriptsDir, "login.mjs"), "--status"], { env, windowsHide: true })
    assert.match(status.stdout, /signed in as ada@ciwebgroup\.com/)
    assert.doesNotMatch(status.stdout, /sekrit/)
    const out = await execFileAsync(process.execPath, [join(scriptsDir, "logout.mjs")], {
        env: { ...env, CIWG_OIDC_ISSUER: ISSUER, CIWG_KNOWLEDGE_TOKEN: "legacy" },
        windowsHide: true,
    })
    assert.match(out.stdout, /Signed out/)
    assert.ok(out.stdout.includes(LEGACY_TOKEN_NOTE))
    assert.doesNotMatch(out.stdout, /sekrit/)
    assert.equal(readAuth(), null)
    assert.equal(readFileSync(join(scriptsDir, "login.mjs"), "utf8").includes("console.log(tokens"), false)
})

test("login.mjs over SSH: prints the verification URL + code and RETURNS AT ONCE; --device-finish completes it", async () => {
    // A tiny local IdP: discovery, device authorization, token (approved).
    const server = createServer((req, res) => {
        const send = (body, status = 200) => {
            res.writeHead(status, { "content-type": "application/json" })
            res.end(JSON.stringify(body))
        }
        const origin = `http://127.0.0.1:${server.address().port}`
        if (req.url.endsWith("/.well-known/openid-configuration")) {
            send({
                issuer: `${origin}/application/o/ciwg-knowledge/`,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                device_authorization_endpoint: `${origin}/device`,
            })
        } else if (req.url === "/device") {
            send({ device_code: "ssh-dev", user_code: "SSHC-0DE1", verification_uri: `${origin}/activate`, expires_in: 600, interval: 1 })
        } else if (req.url === "/token") {
            send({ access_token: "ssh-access", expires_in: 600, refresh_token: "ssh-refresh", id_token: fakeJwt({ email: "ssh@ciwebgroup.com" }) })
        } else {
            send({ error: "not_found" }, 404)
        }
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const env = {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CIWG_KNOWLEDGE_TOKEN: "",
        CIWG_OIDC_ISSUER: `http://127.0.0.1:${server.address().port}/application/o/ciwg-knowledge/`,
        SSH_CONNECTION: "10.0.0.2 51234 10.0.0.1 22",
    }
    try {
        const t0 = Date.now()
        const start = await execFileAsync(process.execPath, [join(scriptsDir, "login.mjs")], { env, windowsHide: true, timeout: 15_000 })
        const elapsed = Date.now() - t0
        assert.ok(elapsed < 5_000, `default mode over SSH blocked for ${elapsed}ms`)
        assert.match(start.stdout, /Headless\/SSH session detected/)
        assert.match(start.stdout, /SSHC-0DE1/)
        assert.match(start.stdout, /\/activate/)
        assert.match(start.stdout, /DEVICE_CODE_PENDING/)
        assert.doesNotMatch(start.stdout, /ssh-dev|ssh-access|ssh-refresh/)
        assert.ok(existsSync(join(ciwgDir, "auth-pending.json")))
        assert.equal(readAuth(), null, "nothing signed in yet")

        const finish = await execFileAsync(process.execPath, [join(scriptsDir, "login.mjs"), "--device-finish"], { env, windowsHide: true, timeout: 15_000 })
        assert.match(finish.stdout, /Signed in as ssh@ciwebgroup\.com/)
        assert.doesNotMatch(finish.stdout, /ssh-dev|ssh-access|ssh-refresh/)
        assert.equal(readAuth().refresh_token, "ssh-refresh")
        assert.ok(!existsSync(join(ciwgDir, "auth-pending.json")))
    } finally {
        server.closeAllConnections?.()
        server.close()
    }
})
