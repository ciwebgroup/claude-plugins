/**
 * SSO sign-in tests — PKCE, the token cache + silent refresh (mocked token
 * endpoint), expiry, legacy-token precedence, the loopback and device
 * flows end to end, logout, the hint markers, and the hooks' one-line
 * sign-in nudges (real hook processes, no network). Run:
 *
 *   node --test plugins/ciwg-knowledge/tests/
 *
 * HOME/USERPROFILE point at a throwaway dir so the user's real ~/.ciwg is
 * never read or written; every network call goes through an injected
 * `fetchImpl` — nothing dials out.
 */

import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { get as httpGet } from "node:http"
import { tmpdir } from "node:os"
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
}
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CIWG_KNOWLEDGE_TOKEN
// Belt and braces: even a bug that reached the API would hit a dead port.
process.env.CIWG_KNOWLEDGE_URL = "http://127.0.0.1:9"

const auth = await import("../scripts/lib/auth.mjs")
const { describeFailure } = await import("../scripts/lib/config.mjs")
const {
    OIDC_CLIENT_ID,
    OIDC_SCOPES,
    authPath,
    decodeJwtPayload,
    discover,
    finishDeviceLogin,
    firstRunHintDue,
    generatePkce,
    getAccessToken,
    getLegacyToken,
    loginWithBrowser,
    loginWithDeviceCode,
    logout,
    readAuth,
    reloginHintDue,
    resolveAuth,
    writeAuth,
} = auth

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts")
const ciwgDir = join(fakeHome, ".ciwg")
const ISSUER = "https://sso.example.test/application/o/ciwg-knowledge/"
const META = {
    issuer: ISSUER,
    authorization_endpoint: "https://sso.example.test/application/o/authorize/",
    token_endpoint: "https://sso.example.test/application/o/token/",
    device_authorization_endpoint: "https://sso.example.test/application/o/device/",
    revocation_endpoint: "https://sso.example.test/application/o/revoke/",
}

const b64url = (value) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url")
const fakeJwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    })
const sha256url = (s) => createHash("sha256").update(s).digest("base64url")

/** Records every call; routes by URL. `handlers` maps URL → fn(params, init). */
function mockFetch(handlers) {
    const calls = []
    const impl = async (url, init = {}) => {
        const key = String(url)
        const params = new URLSearchParams(init.body ?? "")
        calls.push({ url: key, method: init.method ?? "GET", params, headers: init.headers ?? {} })
        const handler = handlers[key]
        if (!handler) throw new TypeError(`fetch failed: unexpected ${key}`)
        return handler(params, init, calls.length)
    }
    impl.calls = calls
    return impl
}

const discoveryHandlers = () => ({
    [`${ISSUER}.well-known/openid-configuration`]: () => json(META),
})

/** A signed-in cache whose access token expired `expiredForMs` ago. */
const seedAuth = (overrides = {}) =>
    writeAuth({
        issuer: ISSUER,
        client_id: OIDC_CLIENT_ID,
        token_endpoint: META.token_endpoint,
        revocation_endpoint: META.revocation_endpoint,
        access_token: "old-access",
        expires_at: Date.now() - 1000,
        refresh_token: "refresh-1",
        email: "ada@ciwebgroup.com",
        obtained_at: Date.now() - 3600_000,
        ...overrides,
    })

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

test("cache: writeAuth is owner-only and readAuth round-trips", () => {
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
})

test("getAccessToken: a fresh cached token is used without any network", async () => {
    seedAuth({ access_token: "fresh", expires_at: Date.now() + 10 * 60_000 })
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

test("getAccessToken: expired → silent refresh_token grant, rotated token persisted", async () => {
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

test("getAccessToken: invalid_grant (revoked/deactivated) → relogin, cache cleared, no retry storm", async () => {
    seedAuth()
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ error: "invalid_grant" }, 400),
    })
    const first = await getAccessToken({ fetchImpl })
    assert.deepEqual(first, { token: null, reason: "relogin" })
    const stored = readAuth()
    assert.equal(stored.needs_login, true)
    assert.equal(stored.access_token, undefined)
    assert.equal(stored.refresh_token, undefined)
    assert.equal(stored.email, "ada@ciwebgroup.com", "identity kept for --status")

    const second = await getAccessToken({ fetchImpl })
    assert.deepEqual(second, { token: null, reason: "relogin" })
    assert.equal(fetchImpl.calls.length, 1, "a dead refresh token is not retried")
})

test("getAccessToken: transient failures keep the tokens (network, 5xx)", async () => {
    seedAuth()
    const down = mockFetch({
        [META.token_endpoint]: () => {
            throw new TypeError("fetch failed")
        },
    })
    assert.deepEqual(await getAccessToken({ fetchImpl: down }), { token: null, reason: "network" })
    assert.equal(readAuth().refresh_token, "refresh-1")

    const flaky = mockFetch({
        [META.token_endpoint]: () => json({ error: "server_error" }, 503),
    })
    assert.deepEqual(await getAccessToken({ fetchImpl: flaky }), { token: null, reason: "http" })
    assert.equal(readAuth().refresh_token, "refresh-1")
    assert.equal(readAuth().needs_login, undefined)
})

test("getAccessToken: no cached refresh token → relogin without network", async () => {
    seedAuth({ refresh_token: undefined })
    const fetchImpl = mockFetch({})
    assert.deepEqual(await getAccessToken({ fetchImpl }), { token: null, reason: "relogin" })
    assert.equal(readAuth().needs_login, true)
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

test("getAccessToken: rotation race — a sibling's newer refresh token is picked up", async () => {
    seedAuth()
    const fetchImpl = mockFetch({
        [META.token_endpoint]: (params) => {
            if (params.get("refresh_token") === "refresh-1") {
                // Simulate another process having rotated the token in the
                // meantime: it persisted refresh-2 and our refresh-1 is dead.
                seedAuth({ refresh_token: "refresh-2" })
                return json({ error: "invalid_grant" }, 400)
            }
            assert.equal(params.get("refresh_token"), "refresh-2")
            return json({ access_token: "from-2", expires_in: 300, refresh_token: "refresh-3" })
        },
    })
    const result = await getAccessToken({ fetchImpl })
    assert.equal(result.token, "from-2")
    assert.equal(readAuth().refresh_token, "refresh-3")
    assert.equal(fetchImpl.calls.length, 2)
})

test("getAccessToken: lock — a stale lock is broken, a live one is waited for", async () => {
    seedAuth()
    const lock = join(ciwgDir, "auth.lock")
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const fetchImpl = mockFetch({
        [META.token_endpoint]: () => json({ access_token: "after-stale", expires_in: 300 }),
    })
    assert.equal((await getAccessToken({ fetchImpl })).token, "after-stale")
    assert.ok(!existsSync(lock))

    // Live lock held by "another process" that releases after 250ms and
    // leaves a fresh token behind — we must use it, not refresh again.
    seedAuth()
    mkdirSync(lock)
    setTimeout(() => {
        seedAuth({ access_token: "sibling", expires_at: Date.now() + 600_000 })
        rmSync(lock, { recursive: true, force: true })
    }, 250)
    const calls = fetchImpl.calls.length
    const waited = await getAccessToken({ fetchImpl })
    assert.equal(waited.token, "sibling")
    assert.equal(fetchImpl.calls.length, calls, "no refresh after the sibling's")
})

// ------------------------------------------------------------ precedence

test("resolveAuth: legacy CIWG_KNOWLEDGE_TOKEN wins over a valid SSO session", async () => {
    seedAuth({ access_token: "fresh", expires_at: Date.now() + 600_000 })
    process.env.CIWG_KNOWLEDGE_TOKEN = " leg acy\n"
    const fetchImpl = mockFetch({})
    const result = await resolveAuth({ fetchImpl })
    assert.equal(result.kind, "api-token")
    assert.deepEqual(result.headers, { "X-API-Token": "legacy" })
    assert.equal(fetchImpl.calls.length, 0)
})

test("resolveAuth: legacy ~/.ciwg/knowledge.json token wins too (BOM tolerated)", async () => {
    seedAuth({ access_token: "fresh", expires_at: Date.now() + 600_000 })
    mkdirSync(ciwgDir, { recursive: true })
    writeFileSync(join(ciwgDir, "knowledge.json"), "﻿" + JSON.stringify({ token: "file-token" }))
    assert.equal(getLegacyToken(), "file-token")
    const result = await resolveAuth({ fetchImpl: mockFetch({}) })
    assert.deepEqual(result.headers, { "X-API-Token": "file-token" })
})

test("resolveAuth: SSO session → Bearer header; nothing → no-token; revoked → relogin", async () => {
    assert.deepEqual(await resolveAuth({ fetchImpl: mockFetch({}) }), { ok: false, status: "no-token" })

    seedAuth({ access_token: "fresh", expires_at: Date.now() + 600_000 })
    const ok = await resolveAuth({ fetchImpl: mockFetch({}) })
    assert.equal(ok.kind, "oidc")
    assert.deepEqual(ok.headers, { Authorization: "Bearer fresh" })
    assert.equal(ok.email, "ada@ciwebgroup.com")

    writeAuth({ needs_login: true, email: "ada@ciwebgroup.com" })
    assert.deepEqual(await resolveAuth({ fetchImpl: mockFetch({}) }), { ok: false, status: "relogin" })
})

test("describeFailure: sign-in statuses point at /ciwg-login", () => {
    assert.match(describeFailure("no-token"), /\/ciwg-login/)
    assert.match(describeFailure("relogin"), /\/ciwg-login/)
    assert.doesNotMatch(describeFailure("relogin"), /token/i)
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

test("loginWithBrowser: PKCE + state + loopback end to end, tokens persisted", async () => {
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
        const state = u.searchParams.get("state")
        assert.ok(state.length >= 16)

        // Probing: wrong path, wrong state, missing code — all ignored, the
        // listener keeps waiting for the real callback.
        assert.equal((await browserGet(`${new URL(redirectUri).origin}/`)).status, 404)
        assert.equal((await browserGet(`${redirectUri}?code=evil&state=nope`)).status, 400)
        assert.equal((await browserGet(`${redirectUri}?state=${state}`)).status, 400)

        sentCode = "the-code"
        const done = await browserGet(`${redirectUri}?code=${sentCode}&state=${state}`)
        assert.equal(done.status, 200)
        assert.match(done.body, /close this window/)
        // Single-shot: a replay after completion is refused.
        assert.equal((await browserGet(`${redirectUri}?code=again&state=${state}`)).status, 410)
    }
    const result = await loginWithBrowser({
        issuer: ISSUER,
        fetchImpl,
        openBrowser,
        log: (line) => logs.push(line),
        timeoutMs: 10_000,
    })
    assert.equal(result.email, "grace@ciwebgroup.com")
    assert.equal(result.hasRefreshToken, true)
    const stored = readAuth()
    assert.equal(stored.access_token, "loop-access")
    assert.equal(stored.refresh_token, "loop-refresh")
    assert.equal(stored.revocation_endpoint, META.revocation_endpoint)
    // Nothing secret in the log: no verifier, no code, no tokens.
    const logged = logs.join("\n")
    assert.doesNotMatch(logged, /loop-access|loop-refresh|the-code|code_verifier/)
    // The listener is gone.
    await assert.rejects(browserGet(`${redirectUri}?code=x&state=y`))
})

test("loginWithBrowser: a browser that cannot open is not fatal (URL is logged)", async () => {
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

    const finished = await finishDeviceLogin({ fetchImpl, sleep: async () => {} })
    assert.equal(finished.hasRefreshToken, true)
    assert.ok(!existsSync(pendingPath), "pending device code removed")
    await assert.rejects(finishDeviceLogin({ fetchImpl, sleep: async () => {} }), /no pending/)
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
            loginWithDeviceCode({ issuer: ISSUER, fetchImpl, sleep: async () => {} }),
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

test("logout: revokes the refresh token, wipes the cache and markers", async () => {
    seedAuth()
    reloginHintDue("s1")
    firstRunHintDue()
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
    assert.ok(!existsSync(join(ciwgDir, "relogin-hint")))
    assert.ok(!existsSync(join(ciwgDir, "login-hint")))

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

// ---------------------------------------------------------------- hints

test("firstRunHintDue: once per day", () => {
    const now = Date.parse("2026-09-09T12:00:00Z")
    assert.equal(firstRunHintDue({ now }), true)
    assert.equal(firstRunHintDue({ now: now + 60_000 }), false)
    const marker = join(ciwgDir, "login-hint")
    const yesterday = new Date(Date.now() - 25 * 60 * 60_000)
    utimesSync(marker, yesterday, yesterday)
    assert.equal(firstRunHintDue(), true)
})

test("reloginHintDue: once per session id", () => {
    assert.equal(reloginHintDue("session-a"), true)
    assert.equal(reloginHintDue("session-a"), false)
    assert.equal(reloginHintDue("session-b"), true)
    assert.equal(reloginHintDue("session-a"), true, "a different session re-arms it")
    // No session id: hourly.
    rmSync(join(ciwgDir, "relogin-hint"), { force: true })
    assert.equal(reloginHintDue(undefined), true)
    assert.equal(reloginHintDue(undefined), false)
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
    rmSync(join(ciwgDir, "login-hint"), { force: true })
    assert.equal(runHook("session-brief.mjs", { ...payload, source: "compact" }), null)
})

test("hooks: revoked sign-in → one relogin line per session, then silence", () => {
    writeAuth({ needs_login: true, email: "ada@ciwebgroup.com" })
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
    // and crucially no login-hint marker is ever written.
    const out = runHook(
        "session-brief.mjs",
        { session_id: "s-2", cwd: fakeHome, source: "startup" },
        { CIWG_KNOWLEDGE_TOKEN: "legacy-token" }
    )
    assert.equal(out, null)
    assert.ok(!existsSync(join(ciwgDir, "login-hint")))
})

test("login.mjs --status and logout.mjs never print token material", async () => {
    seedAuth({ access_token: "sekrit-access", expires_at: Date.now() + 600_000, refresh_token: "sekrit-refresh" })
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CIWG_KNOWLEDGE_TOKEN: "" }
    const status = await execFileAsync(process.execPath, [join(scriptsDir, "login.mjs"), "--status"], { env, windowsHide: true })
    assert.match(status.stdout, /signed in as ada@ciwebgroup\.com/)
    assert.doesNotMatch(status.stdout, /sekrit/)
    const out = await execFileAsync(process.execPath, [join(scriptsDir, "logout.mjs")], {
        env: { ...env, CIWG_OIDC_ISSUER: ISSUER },
        windowsHide: true,
    })
    assert.match(out.stdout, /Signed out/)
    assert.doesNotMatch(out.stdout, /sekrit/)
    assert.equal(readAuth(), null)
    assert.equal(readFileSync(join(scriptsDir, "login.mjs"), "utf8").includes("console.log(tokens"), false)
})
