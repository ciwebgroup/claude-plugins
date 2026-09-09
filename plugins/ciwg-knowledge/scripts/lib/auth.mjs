/**
 * Sign-in for the ciwg-knowledge plugin — CIWG SSO (Authentik) via OAuth 2.1.
 *
 * Why: the hooks and the local MCP server call the knowledge REST API,
 * which accepts an Authentik access token as a Bearer credential. Nobody
 * should have to mint an API token by hand: `/ciwg-login` runs
 * Authorization Code + PKCE against a loopback redirect (opens the browser)
 * or, for headless/SSH sessions, the Device Authorization Grant (RFC 8628),
 * and caches the result in ~/.ciwg/auth.json (0600). Every hook run then
 * uses the cached access token, refreshes it silently when it expires and —
 * when the refresh is REJECTED (user deactivated in Authentik, refresh token
 * revoked or expired) — drops the cache so the hooks can hint ONCE and
 * otherwise stay silent. ONE sign-in covers hooks and MCP tools alike.
 *
 * Zero dependencies: node:crypto (PKCE), node:http (loopback listener),
 * global fetch (Node ≥ 18). Every network-touching function takes an
 * injectable `fetchImpl` so the tests never dial out.
 *
 * Time budget: hooks run under a hard timeout (hooks.json). Callers pass an
 * absolute `deadline`; the lock wait, the refresh round-trip and the API
 * call that follows are each sized from what is LEFT, so their sum can
 * never exceed the hook budget by construction (see lockWaitBudget /
 * httpBudget and config.mjs apiRequest).
 *
 * Precedence: a legacy `route:knowledge` API token (CIWG_KNOWLEDGE_TOKEN or
 * ~/.ciwg/knowledge.json) still works and WINS over SSO when set — CI and
 * service use keep working unchanged; see the README for the deprecation
 * path.
 *
 * Security: the loopback listener binds 127.0.0.1 only, on a random port,
 * accepts a single state-matched callback, and times out. Tokens, the
 * authorization code, the device code and the PKCE verifier are never
 * logged, printed, or put in an error message.
 */

import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import {
    ciwgDir,
    debug,
    escapeXml,
    fetchWithTimeout,
    readJson,
    remainingMs,
    rmQuiet,
    writeJsonAtomic,
} from "./paths.mjs"
import {
    backOff,
    clearState,
    isBackedOff,
    pruneState,
    readState,
    updateState,
} from "./state.mjs"

const normalizeIssuer = (s) => String(s).trim().replace(/\/*$/, "/")

/** One Authentik application on the CIWG SSO instance
 * (https://sso.ciwgserver.com) serves everything (claude.ai connector, the
 * plugin's login, the optional native Claude Code OAuth): its slug is the
 * issuer path and its client id is `ciwg-knowledge`. Env-overridable for
 * staging/local IdPs — and for the day the slug differs from this default
 * (the README says how to read the exact issuer off the provider page). */
const OIDC_ISSUER = normalizeIssuer(
    process.env.CIWG_OIDC_ISSUER ||
        "https://sso.ciwgserver.com/application/o/ciwg-knowledge/"
)
export const OIDC_CLIENT_ID = (
    process.env.CIWG_OIDC_CLIENT_ID || "ciwg-knowledge"
).trim()
export const OIDC_SCOPES = "openid profile email groups offline_access"

const AUTH_VERSION = 1
/** Treat an access token as expired this long before it really is. */
const EXPIRY_SKEW_MS = 30_000
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000
/** One IdP round-trip inside a hook. */
const HTTP_TIMEOUT_MS = 4_000
/** Interactive sign-in calls (a human is waiting, no hook budget). */
const LOGIN_HTTP_TIMEOUT_MS = 10_000
/**
 * Cross-process refresh lock (Authentik ROTATES refresh tokens: two hooks
 * refreshing the same token concurrently would leave one with a dead token,
 * and OAuth 2.1 reuse detection can revoke the whole chain). A waiter is
 * willing to wait at least one holder critical section (refresh + write);
 * a lock whose holder pid is gone is broken immediately, the mtime age is
 * the fallback when the pid is unknowable.
 */
const LOCK_WAIT_MS = HTTP_TIMEOUT_MS + 1_000
const LOCK_STALE_MS = 15_000
const LOCK_POLL_MS = 100
/** Budget kept back for the API call that follows a refresh. */
const API_RESERVE_MS = 1_500
/** Below this, an HTTP call is not worth starting. */
const MIN_HTTP_MS = 750
/** After a network-level refresh failure, skip refreshes for this long. */
const IDP_BACKOFF_MS = 60_000
/** A rotated refresh token is persisted with retries — losing it forces a
 * re-login (the old one is already revoked server-side). */
const WRITE_RETRY_DELAYS_MS = [50, 150, 450]
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
/** Consecutive network failures tolerated while polling a device grant. */
const DEVICE_POLL_MAX_FAILURES = 10
const FORM_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
}

/** Exposed for the budget tests only. */
export const TIMING = Object.freeze({
    HTTP_TIMEOUT_MS,
    LOCK_WAIT_MS,
    API_RESERVE_MS,
    MIN_HTTP_MS,
    EXPIRY_SKEW_MS,
})

export const authPath = () => join(ciwgDir(), "auth.json")
const lockPath = () => join(ciwgDir(), "auth.lock")
const lockPidPath = () => join(lockPath(), "pid")
const pendingPath = () => join(ciwgDir(), "auth-pending.json")

/** Injected into context by the hooks — one line each, once. They address
 * Claude (additionalContext is model-facing) and ask it to relay. */
export const LOGIN_HINT_FIRST_RUN =
    "ciwg-knowledge: company knowledge is not connected on this machine. Tell the user once, in one short sentence: run /ciwg-login to connect company knowledge (CIWG SSO sign-in, no token needed)."
export const LOGIN_HINT_RELOGIN =
    "ciwg-knowledge: the company-knowledge sign-in has expired or been revoked. Tell the user once, in one short sentence: run /ciwg-login to sign in again."
export const LOGIN_HINT_API_REJECTED =
    "ciwg-knowledge: the knowledge API rejected the sign-in token (HTTP 401). Tell the user once, in one short sentence: re-run /ciwg-login; if it keeps happening, the server may not trust this app yet — ask the CIWG admin."
/** The one sentence about a legacy token shadowing SSO — CLI and --status. */
export const LEGACY_TOKEN_NOTE =
    "Note: a legacy API token is configured (CIWG_KNOWLEDGE_TOKEN or ~/.ciwg/knowledge.json) — the hooks use it instead of SSO until you remove it."

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- crypto

const base64url = (buf) => Buffer.from(buf).toString("base64url")

/** RFC 7636: a 43-char base64url verifier and its S256 challenge. */
export function generatePkce() {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash("sha256").update(verifier).digest())
    return { verifier, challenge, method: "S256" }
}

const randomToken = (bytes = 16) => base64url(randomBytes(bytes))

function safeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    return left.length === right.length && timingSafeEqual(left, right)
}

/** Payload of a JWT WITHOUT verification — display (email) and an `exp`
 * fallback only; the API verifies signatures, this client never relies on
 * these claims for a security decision. */
export function decodeJwtPayload(jwt) {
    if (typeof jwt !== "string") return null
    const parts = jwt.split(".")
    if (parts.length < 2) return null
    try {
        const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null
    } catch {
        return null
    }
}

// --------------------------------------------------------------- storage

/** Optional fields of a valid record — each a string when present. */
const AUTH_STRING_FIELDS = [
    "client_id",
    "token_endpoint",
    "revocation_endpoint",
    "refresh_token",
    "email",
]

/** Cached sign-in, or null when absent/unreadable/other version/malformed.
 * Fields: client_id, token_endpoint, revocation_endpoint, access_token,
 * expires_at, refresh_token, email — nothing else. A file whose fields
 * have the wrong type (hand-edited, a torn write that still parsed) reads
 * as "not signed in" rather than reaching the token endpoint with
 * "[object Object]" as the refresh token. "Not signed in" is the ABSENCE
 * of this file; why it is absent (never / revoked) lives in state.json. */
export function readAuth() {
    const parsed = readJson(authPath())
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (parsed.version !== AUTH_VERSION) return null
    if (typeof parsed.access_token !== "string" || !parsed.access_token) {
        debug("auth.json ignored: access_token is not a string")
        return null
    }
    for (const key of AUTH_STRING_FIELDS) {
        if (parsed[key] != null && typeof parsed[key] !== "string") {
            debug(`auth.json ignored: ${key} is not a string`)
            return null
        }
    }
    return parsed
}

/** Atomic, owner-only write. Throws — see persistAuth for the retrying
 * variant the refresh path uses. */
export function writeAuth(auth) {
    writeJsonAtomic(authPath(), { version: AUTH_VERSION, ...auth }, { mode: 0o600 })
}

/**
 * Persist tokens that MUST not be lost (a rotated refresh token: the old
 * one is already revoked server-side). Retries the atomic write with
 * backoff — NTFS rename can fail transiently under Defender/indexers —
 * then falls back to a plain overwrite. Never throws; false means every
 * attempt failed (the caller still uses the in-memory token for this call).
 */
export async function persistAuth(auth, { sleep = defaultSleep, write = writeAuth } = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            write(auth)
            return true
        } catch (error) {
            debug("persisting tokens failed:", error.code || error.message)
            if (attempt >= WRITE_RETRY_DELAYS_MS.length) break
            await sleep(WRITE_RETRY_DELAYS_MS[attempt])
        }
    }
    try {
        writeFileSync(
            authPath(),
            `${JSON.stringify({ version: AUTH_VERSION, ...auth }, null, 2)}\n`,
            { mode: 0o600 }
        )
        debug("tokens persisted via non-atomic fallback")
        return true
    } catch (error) {
        debug("token persistence exhausted:", error.code || error.message)
        return false
    }
}

/** Marker files the previous plugin version kept beside auth.json;
 * state.json replaced them. Removed on sign-out so an upgrade leaves no
 * stale "knowledge is down" / hint markers behind. */
const LEGACY_MARKER_FILES = ["knowledge-down", "login-hint", "relogin-hint"]

/** Forget the sign-in and every bit of state that describes it. */
function clearAuth() {
    rmQuiet(authPath())
    rmQuiet(pendingPath())
    clearState()
    for (const name of LEGACY_MARKER_FILES) rmQuiet(join(ciwgDir(), name))
}

function isFresh(auth, now = Date.now()) {
    return Boolean(
        auth &&
            typeof auth.access_token === "string" &&
            auth.access_token &&
            Number.isFinite(auth.expires_at) &&
            auth.expires_at - EXPIRY_SKEW_MS > now
    )
}

/** Fresh now AND not due for a proactive refresh. */
const isFreshFor = (auth, now, withinMs) =>
    isFresh(auth, now) && auth.expires_at - EXPIRY_SKEW_MS - now >= withinMs

/**
 * Drop the tokens (the refresh was rejected) and remember who/why in
 * state.json so the hooks hint once and --status can explain. Compare-and-
 * swap on the refresh token: only the token WE tried is ever tombstoned —
 * a sibling's freshly rotated token is left alone.
 */
function markNeedsLogin(tried, why) {
    const current = readAuth()
    if (current && tried?.refresh_token && current.refresh_token !== tried.refresh_token) {
        debug("not tombstoning: auth.json was rotated by a sibling")
        return false
    }
    debug("sign-in required:", why)
    rmQuiet(authPath())
    updateState({
        relogin_at: Date.now(),
        relogin_email: tried?.email ?? current?.email ?? null,
        relogin_why: why,
    })
    return true
}

/** Token-endpoint response → stored record. Keeps the previous refresh
 * token when the server does not rotate it, never stores the id_token. */
function tokenResponseToAuth(tokens, previous, meta, now) {
    const accessToken = tokens?.access_token
    if (typeof accessToken !== "string" || !accessToken) {
        throw new Error("token response lacks access_token")
    }
    const accessClaims = decodeJwtPayload(accessToken)
    const expiresIn = Number(tokens.expires_in)
    const expiresAt =
        Number.isFinite(expiresIn) && expiresIn > 0
            ? now + expiresIn * 1000
            : Number.isFinite(accessClaims?.exp)
              ? accessClaims.exp * 1000
              : now + DEFAULT_TOKEN_TTL_MS
    const refreshToken =
        typeof tokens.refresh_token === "string" && tokens.refresh_token
            ? tokens.refresh_token
            : previous?.refresh_token
    const claims = decodeJwtPayload(tokens.id_token) ?? accessClaims ?? {}
    const email =
        typeof claims.email === "string"
            ? claims.email
            : typeof claims.preferred_username === "string"
              ? claims.preferred_username
              : previous?.email
    return {
        client_id: previous?.client_id ?? OIDC_CLIENT_ID,
        token_endpoint: meta?.token_endpoint ?? previous?.token_endpoint,
        revocation_endpoint:
            meta?.revocation_endpoint ?? previous?.revocation_endpoint,
        access_token: accessToken,
        expires_at: expiresAt,
        refresh_token: refreshToken,
        email,
    }
}

// -------------------------------------------------------------- transport

const isEndpointUrl = (value) =>
    typeof value === "string" &&
    /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(value)

/** OIDC discovery — Authentik serves it per application at
 * <issuer>/.well-known/openid-configuration. */
export async function discover(
    issuer = OIDC_ISSUER,
    { fetchImpl = globalThis.fetch, timeoutMs = LOGIN_HTTP_TIMEOUT_MS } = {}
) {
    const url = `${normalizeIssuer(issuer)}.well-known/openid-configuration`
    const res = await fetchWithTimeout(
        fetchImpl,
        url,
        { headers: { Accept: "application/json" } },
        timeoutMs
    )
    if (!res.ok) {
        throw new Error(`OIDC discovery failed (HTTP ${res.status}) at ${url}`)
    }
    let meta
    try {
        meta = res.json()
    } catch {
        throw new Error(`OIDC discovery document at ${url} is not JSON`)
    }
    for (const key of ["authorization_endpoint", "token_endpoint"]) {
        if (!isEndpointUrl(meta?.[key])) {
            throw new Error(`OIDC discovery document lacks ${key}`)
        }
    }
    return {
        issuer: typeof meta.issuer === "string" ? meta.issuer : issuer,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        device_authorization_endpoint: isEndpointUrl(
            meta.device_authorization_endpoint
        )
            ? meta.device_authorization_endpoint
            : undefined,
        revocation_endpoint: isEndpointUrl(meta.revocation_endpoint)
            ? meta.revocation_endpoint
            : undefined,
    }
}

/** POST x-www-form-urlencoded to a token-style endpoint. Returns
 * {ok, status, body} — body is the parsed JSON or {} — or throws on a
 * network-level failure. Never puts request parameters in an error. */
async function postForm(fetchImpl, url, params, timeoutMs) {
    const res = await fetchWithTimeout(
        fetchImpl,
        url,
        {
            method: "POST",
            headers: FORM_HEADERS,
            body: new URLSearchParams(params).toString(),
        },
        timeoutMs
    )
    let body = {}
    try {
        body = res.json()
    } catch {
        /* non-JSON error body */
    }
    return { ok: res.ok, status: res.status, body: body ?? {} }
}

const errorCode = (reply) =>
    typeof reply.body?.error === "string"
        ? reply.body.error
        : `http_${reply.status}`

// ---------------------------------------------------------------- refresh

/**
 * One refresh_token grant. {ok:true, auth} or {ok:false, reason} where
 * reason is "invalid_grant" (the ONLY terminal answer: revoked / expired /
 * rotated-away → sign in again), "network", "http" (anything else the
 * server said — 5xx, 429, a proxy's HTML 400, invalid_client… — transient:
 * keep the tokens, back off) or "malformed".
 */
async function refreshAccessToken(
    auth,
    { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = HTTP_TIMEOUT_MS } = {}
) {
    let reply
    try {
        reply = await postForm(
            fetchImpl,
            auth.token_endpoint,
            {
                grant_type: "refresh_token",
                refresh_token: auth.refresh_token,
                client_id: auth.client_id || OIDC_CLIENT_ID,
            },
            timeoutMs
        )
    } catch (error) {
        debug("token refresh network failure:", error.name)
        return { ok: false, reason: "network" }
    }
    if (reply.ok) {
        try {
            return { ok: true, auth: tokenResponseToAuth(reply.body, auth, null, now) }
        } catch (error) {
            debug("token refresh malformed:", error.message)
            return { ok: false, reason: "malformed" }
        }
    }
    const code = errorCode(reply)
    debug(`token refresh rejected: HTTP ${reply.status} ${code}`)
    if (code === "invalid_grant") return { ok: false, reason: "invalid_grant", code }
    return { ok: false, reason: "http", code }
}

/** The holder recorded its pid; a dead holder (crashed / killed mid-refresh)
 * is detected immediately instead of after the mtime timeout. */
function lockIsStale() {
    let pid = NaN
    try {
        pid = Number(readFileSync(lockPidPath(), "utf8").trim())
    } catch {
        /* holder is between mkdir and its pid write, or pre-pid lock */
    }
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
            process.kill(pid, 0)
        } catch (error) {
            if (error.code === "ESRCH") return true
            /* EPERM: alive, another user's process */
        }
    }
    try {
        return Date.now() - statSync(lockPath()).mtimeMs > LOCK_STALE_MS
    } catch (error) {
        // ENOENT: vanished between our mkdir and the stat → stale, retry.
        // Anything else (EPERM/EACCES — a deny ACL on auth.lock, an
        // unreadable lock) means we cannot judge its age: treat it as LIVE
        // and wait out the deadline. Calling it stale would have us try to
        // remove a directory we cannot even stat, and fail, on every turn.
        return error.code === "ENOENT"
    }
}

/**
 * "acquired" | "busy" (a live holder, waited `waitMs` in vain) |
 * "unlockable" (the filesystem refuses the lock dir — then nothing else in
 * ~/.ciwg works either, so proceed without one).
 */
async function acquireLock(sleep, waitMs) {
    const deadline = Date.now() + waitMs
    let stuckReported = false
    // At most ONE immediate mkdir retry per poll cycle, whatever the
    // filesystem reports: every second pass reaches the deadline check and
    // the await below, so the loop is bounded even where existsSync and
    // mkdir disagree (a deny ACL on auth.lock: mkdir says EEXIST, existsSync
    // says false — trusting existsSync alone spun here forever, synchronously).
    let retriedThisCycle = false
    for (;;) {
        try {
            mkdirSync(lockPath(), { recursive: false })
            try {
                writeFileSync(lockPidPath(), String(process.pid))
            } catch {
                /* pid probe unavailable: waiters fall back to the mtime age */
            }
            return "acquired"
        } catch (error) {
            if (error.code !== "EEXIST") return "unlockable"
        }
        if (lockIsStale()) {
            rmQuiet(lockPath(), { recursive: true })
            // Gone → retry the mkdir at once (once). Still there (Windows
            // EBUSY — Defender or the indexer holding auth.lock/pid — a
            // sibling that re-took it in between) → no free pass: fall
            // through to the deadline check and the poll sleep like any
            // live lock. A bare `continue` here spins SYNCHRONOUSLY for as
            // long as the directory resists, ignoring the budget.
            if (!retriedThisCycle && !existsSync(lockPath())) {
                retriedThisCycle = true
                continue
            }
            if (!stuckReported) {
                stuckReported = true
                debug("stale auth.lock could not be removed — waiting as if live")
            }
        }
        if (Date.now() >= deadline) return "busy"
        await sleep(LOCK_POLL_MS)
        retriedThisCycle = false
    }
}

const releaseLock = () => rmQuiet(lockPath(), { recursive: true })

/** Time we may spend waiting for a sibling's refresh, leaving room for our
 * own (possible) refresh and the API call. */
const lockWaitBudget = (deadline) =>
    Math.max(0, Math.min(LOCK_WAIT_MS, remainingMs(deadline) - API_RESERVE_MS - MIN_HTTP_MS))

/** Time we may spend on the refresh round-trip itself. */
const httpBudget = (deadline) =>
    Math.min(HTTP_TIMEOUT_MS, remainingMs(deadline) - API_RESERVE_MS)

async function refreshUnderLock(auth, opts) {
    const { now, sleep, deadline, refreshWithinMs } = opts
    const lock = await acquireLock(sleep, lockWaitBudget(deadline))
    if (lock === "busy") {
        // A live sibling holds the lock and will persist a fresh token. NEVER
        // refresh with the same rotating token in parallel — use its result
        // if it already landed, otherwise report transient.
        const latest = readAuth()
        return isFresh(latest, now) ? { ok: true, auth: latest } : { ok: false, reason: "busy" }
    }
    try {
        // A sibling may have refreshed while we waited for the lock.
        const latest = readAuth()
        if (!latest) {
            return { ok: false, reason: readState().relogin_at ? "invalid_grant" : "none" }
        }
        if (isFreshFor(latest, now, refreshWithinMs)) return { ok: true, auth: latest }
        const timeoutMs = httpBudget(deadline)
        if (timeoutMs < MIN_HTTP_MS) return { ok: false, reason: "timeout" }
        const result = await refreshAccessToken(latest, { ...opts, timeoutMs })
        if (result.ok) {
            await persistAuth(result.auth, { sleep })
            return result
        }
        if (result.reason !== "invalid_grant") return result
        // invalid_grant on a token that a sibling rotated away from under us
        // is not a dead sign-in — the sibling's newer token is the live one.
        const again = readAuth()
        if (again && again.refresh_token !== latest.refresh_token) {
            return isFresh(again, now) ? { ok: true, auth: again } : { ok: false, reason: "busy" }
        }
        markNeedsLogin(latest, `refresh rejected (${result.code})`)
        return result
    } finally {
        if (lock === "acquired") releaseLock()
    }
}

/** In-process dedupe: two hooks-in-one-process (search + engram run in
 * parallel) share a single refresh instead of racing each other. */
let inflightRefresh = null

/**
 * Access token for the API, from cache or via a silent refresh.
 * {token, expiresAt, email} or {token:null, reason} with reason "none"
 * (never signed in), "relogin" (refresh rejected — cache dropped),
 * "network" / "http" / "busy" / "timeout" / "backoff" (transient — tokens
 * kept, try again later).
 *
 * `deadline` (absolute ms) bounds lock wait + refresh so an API call still
 * fits after them; `refreshWithinMs` asks for a PROACTIVE refresh when the
 * token expires that soon — if it fails transiently, the still-valid token
 * is returned anyway.
 */
export async function getAccessToken({
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    sleep = defaultSleep,
    deadline,
    refreshWithinMs = 0,
} = {}) {
    const auth = readAuth()
    if (!auth) return { token: null, reason: readState().relogin_at ? "relogin" : "none" }
    const current = { token: auth.access_token, expiresAt: auth.expires_at, email: auth.email }
    const fresh = isFresh(auth, now)
    if (isFreshFor(auth, now, refreshWithinMs)) return current
    if (!auth.refresh_token || !auth.token_endpoint) {
        if (fresh) return current
        markNeedsLogin(auth, "no refresh token cached")
        return { token: null, reason: "relogin" }
    }
    if (isBackedOff("idp_down_until", now)) {
        debug("skipping refresh (sign-in server recently unreachable)")
        return fresh ? current : { token: null, reason: "backoff" }
    }
    if (!inflightRefresh) {
        inflightRefresh = refreshUnderLock(auth, {
            fetchImpl,
            now,
            sleep,
            deadline,
            refreshWithinMs,
        }).finally(() => {
            inflightRefresh = null
        })
    }
    const result = await inflightRefresh
    if (result.ok) {
        return {
            token: result.auth.access_token,
            expiresAt: result.auth.expires_at,
            email: result.auth.email,
        }
    }
    if (result.reason === "network" || result.reason === "http") {
        backOff("idp_down_until", IDP_BACKOFF_MS, now)
    }
    if (fresh) return current // proactive refresh failed: the token is still good
    return {
        token: null,
        reason: result.reason === "invalid_grant" ? "relogin" : result.reason,
    }
}

// ----------------------------------------------------------- precedence

/**
 * Legacy `route:knowledge` API token: CIWG_KNOWLEDGE_TOKEN env, then
 * ~/.ciwg/knowledge.json {"token": "..."}. Interior whitespace (a token
 * pasted from a wrapped email) is stripped so a header-illegal character
 * can never surface the token inside a Headers error message.
 */
export function getLegacyToken() {
    let raw = process.env.CIWG_KNOWLEDGE_TOKEN
    if (!raw) {
        const parsed = readJson(join(ciwgDir(), "knowledge.json"))
        raw = typeof parsed?.token === "string" ? parsed.token : null
    }
    if (!raw) return null
    return raw.replace(/\s+/g, "") || null
}

/**
 * The credential the REST calls should send. Legacy token first (CI /
 * service use, explicit opt-in), else the SSO access token.
 * {ok:true, kind:"api-token"|"oidc", headers, expiresAt?, email?} or
 * {ok:false, status:"no-token"|"relogin"|"network"|"http"|"busy"|"timeout"|"backoff"}.
 */
export async function resolveAuth(tokenOpts = {}) {
    const legacy = getLegacyToken()
    if (legacy) {
        return { ok: true, kind: "api-token", headers: { "X-API-Token": legacy } }
    }
    const access = await getAccessToken(tokenOpts)
    if (access.token) {
        return {
            ok: true,
            kind: "oidc",
            headers: { Authorization: `Bearer ${access.token}` },
            expiresAt: access.expiresAt,
            email: access.email,
        }
    }
    return {
        ok: false,
        status: access.reason === "none" ? "no-token" : access.reason,
    }
}

// ----------------------------------------------------------------- hints

const HINTS = {
    "no-token": { text: LOGIN_HINT_FIRST_RUN, key: "first_run_hint", everyMs: 24 * 60 * 60_000 },
    relogin: { text: LOGIN_HINT_RELOGIN, key: "relogin_hint", perSession: true },
    "api-rejected": { text: LOGIN_HINT_API_REJECTED, key: "api_rejected_hint", perSession: true },
}

/**
 * The one-line sign-in nudge for a failed credential status, or null when
 * it is not due. ONE cadence rule: a never-signed-in machine is nudged at
 * most once a day; a dropped sign-in (relogin) or an API that rejects the
 * token is nudged once per Claude Code session (the hook payload's
 * session_id — hourly when no session id is available). Other statuses
 * (transient failures) never nudge.
 */
export function signInHint(status, sessionId, { now = Date.now() } = {}) {
    const hint = HINTS[status]
    if (!hint) return null
    const state = readState()
    const key = sessionId ? String(sessionId).slice(0, 120) : ""
    const at = state[`${hint.key}_at`]
    if (hint.perSession && key) {
        if (state[`${hint.key}_session`] === key) return null
    } else if (Number.isFinite(at) && now - at < (hint.everyMs ?? 60 * 60_000)) {
        return null
    }
    updateState({ [`${hint.key}_at`]: now, [`${hint.key}_session`]: key || null })
    return hint.text
}

/** The REST API answered 401 to an SSO token that looked valid — remember
 * which token (by its expiry) so --status can say so instead of "valid". */
export function markApiRejected(expiresAt) {
    updateState({ api_rejected_at: Date.now(), api_rejected_token_exp: expiresAt ?? null })
}

export function clearApiRejected() {
    if (readState().api_rejected_at) pruneState(["api_rejected"])
}

// ------------------------------------------------------- loopback login

function htmlPage(res, status, title, body) {
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
    })
    res.end(
        `<!doctype html><meta charset="utf-8"><title>${escapeXml(title)}</title>` +
            `<body style="font-family:system-ui;margin:3rem auto;max-width:32rem;text-align:center">` +
            `<h1>${escapeXml(title)}</h1><p>${escapeXml(body)}</p></body>`
    )
}

/**
 * Temporary single-shot listener on 127.0.0.1:<random>. Resolves
 * {port, result, close}; `result` settles with {code} on a state-matched
 * /callback, rejects on an `error` callback or after timeoutMs. Mismatched
 * state gets a 400 and is IGNORED (the listener keeps waiting). The auth
 * code is never logged. Callers must attach to `result` before yielding.
 */
export function startLoopbackListener({ state, timeoutMs }) {
    return new Promise((resolveStart, rejectStart) => {
        let settle
        const result = new Promise((resolve, reject) => {
            settle = { resolve, reject }
        })
        let done = false
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1")
            if (url.pathname !== "/callback") {
                res.writeHead(404, { Connection: "close" })
                res.end("Not found")
                return
            }
            if (done) {
                htmlPage(res, 410, "Already done", "This sign-in has already completed.")
                return
            }
            if (!safeEqual(url.searchParams.get("state") ?? "", state)) {
                htmlPage(res, 400, "Ignored", "State mismatch — this callback was ignored.")
                return
            }
            const error = url.searchParams.get("error")
            if (error) {
                done = true
                const description = url.searchParams.get("error_description") ?? ""
                htmlPage(res, 400, "Sign-in failed", `${error} ${description}`.trim())
                settle.reject(new Error(`authorization server returned "${error}"`))
                return
            }
            const code = url.searchParams.get("code")
            if (!code) {
                htmlPage(res, 400, "Ignored", "Missing authorization code.")
                return
            }
            done = true
            htmlPage(res, 200, "Signed in", "You can close this window and return to Claude Code.")
            settle.resolve({ code })
        })
        server.once("error", rejectStart)
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address()
            const timer = setTimeout(() => {
                settle.reject(
                    new Error(
                        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser sign-in`
                    )
                )
            }, timeoutMs)
            const close = () => {
                clearTimeout(timer)
                server.closeAllConnections?.()
                server.close()
            }
            resolveStart({ port, result, close })
        })
    })
}

/**
 * How to hand a URL to the default browser, per platform. Windows goes
 * through rundll32's FileProtocolHandler — NEVER `cmd.exe /c start`, which
 * expands %XX% sequences inside quotes and mangles the percent-encoded
 * redirect_uri when an environment variable happens to match. The URL is
 * passed as ONE argv element, byte for byte.
 */
export function browserLaunchSpec(url, platform = process.platform) {
    if (platform === "win32") {
        return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
    }
    if (platform === "darwin") return { command: "open", args: [url] }
    return { command: "xdg-open", args: [url] }
}

/** Open a URL in the default browser, detached; rejects if no opener. */
function openInBrowser(url) {
    return new Promise((resolve, reject) => {
        if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) {
            reject(new Error("refusing to open a non-http URL"))
            return
        }
        const { command, args } = browserLaunchSpec(url)
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
        child.once("error", reject)
        child.once("spawn", () => {
            child.unref()
            resolve()
        })
    })
}

async function exchangeCode({ meta, clientId, code, redirectUri, verifier, fetchImpl }) {
    const reply = await postForm(
        fetchImpl,
        meta.token_endpoint,
        {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
        },
        LOGIN_HTTP_TIMEOUT_MS
    )
    if (!reply.ok) {
        throw new Error(`token exchange failed (HTTP ${reply.status}, ${errorCode(reply)})`)
    }
    return reply.body
}

function finishLogin(tokens, meta, clientId, now, log) {
    const auth = tokenResponseToAuth(tokens, { client_id: clientId }, meta, now)
    if (!auth.refresh_token) {
        log(
            "Warning: no refresh token was issued — you will be asked to sign in again when the access token expires. Ask the admin to add the offline_access scope mapping to the ciwg-knowledge provider."
        )
    }
    writeAuth(auth) // a login that cannot persist IS a failure — let it throw
    rmQuiet(pendingPath())
    pruneState(["relogin", "api_rejected", "idp_down"])
    return {
        email: auth.email,
        expiresAt: auth.expires_at,
        hasRefreshToken: Boolean(auth.refresh_token),
    }
}

/**
 * Authorization Code + PKCE with a loopback redirect — the primary flow.
 * Opens the browser (or prints the URL), waits for the single callback,
 * exchanges the code, persists the tokens. Resolves {email, expiresAt,
 * hasRefreshToken}.
 */
export async function loginWithBrowser({
    issuer = OIDC_ISSUER,
    clientId = OIDC_CLIENT_ID,
    scopes = OIDC_SCOPES,
    fetchImpl = globalThis.fetch,
    openBrowser = openInBrowser,
    timeoutMs = 180_000,
    log = () => {},
    now = Date.now,
} = {}) {
    const meta = await discover(issuer, { fetchImpl })
    const pkce = generatePkce()
    const state = randomToken(16)
    const listener = await startLoopbackListener({ state, timeoutMs })
    try {
        const redirectUri = `http://127.0.0.1:${listener.port}/callback`
        const authorizeUrl = new URL(meta.authorization_endpoint)
        authorizeUrl.searchParams.set("response_type", "code")
        authorizeUrl.searchParams.set("client_id", clientId)
        authorizeUrl.searchParams.set("redirect_uri", redirectUri)
        authorizeUrl.searchParams.set("scope", scopes)
        authorizeUrl.searchParams.set("state", state)
        authorizeUrl.searchParams.set("code_challenge", pkce.challenge)
        authorizeUrl.searchParams.set("code_challenge_method", pkce.method)
        log("Opening your browser to sign in with CIWG SSO…")
        log(`If it does not open, visit:\n  ${authorizeUrl}`)
        // Not awaited: some openers block until the browser window closes,
        // and the callback can land before they return.
        Promise.resolve()
            .then(() => openBrowser(authorizeUrl.toString()))
            .catch((error) => log(`(could not open a browser automatically: ${error.message})`))
        const { code } = await listener.result
        const tokens = await exchangeCode({
            meta,
            clientId,
            code,
            redirectUri,
            verifier: pkce.verifier,
            fetchImpl,
        })
        return finishLogin(tokens, meta, clientId, now(), log)
    } finally {
        listener.close()
    }
}

// --------------------------------------------------------- device login

/**
 * Poll the token endpoint per RFC 8628 until approved: honours `interval`
 * and `slow_down`, keeps polling through network blips (a bounded run of
 * consecutive failures), and stops at the device code's own expiry.
 */
async function pollDeviceGrant({
    meta,
    clientId,
    device,
    startedAt,
    fetchImpl,
    sleep,
    now,
    timeoutMs,
    log,
}) {
    let interval = Math.max(1, Number(device.interval) || 5) * 1000
    const expiresIn = Math.max(30, Number(device.expires_in) || 600) * 1000
    const deadline = Math.min(startedAt + expiresIn, now() + timeoutMs)
    const expired = () => new Error("the device code expired before the sign-in was approved")
    let failures = 0
    for (;;) {
        await sleep(interval)
        if (now() > deadline) throw expired()
        let reply
        try {
            reply = await postForm(
                fetchImpl,
                meta.token_endpoint,
                {
                    grant_type: DEVICE_GRANT,
                    device_code: device.device_code,
                    client_id: clientId,
                },
                LOGIN_HTTP_TIMEOUT_MS
            )
        } catch (error) {
            failures += 1
            debug("device poll network failure:", error.name)
            if (failures > DEVICE_POLL_MAX_FAILURES) {
                throw new Error("the sign-in server stayed unreachable while waiting for approval")
            }
            continue
        }
        failures = 0
        if (reply.ok) return finishLogin(reply.body, meta, clientId, now(), log)
        const code = errorCode(reply)
        if (code === "authorization_pending") continue
        if (code === "slow_down") {
            interval += 5000
            continue
        }
        if (code === "expired_token") throw expired()
        if (code === "access_denied") throw new Error("the sign-in was denied")
        throw new Error(`device sign-in failed (HTTP ${reply.status}, ${code})`)
    }
}

/**
 * Device Authorization Grant (RFC 8628) — the headless/SSH path. Prints
 * the verification URL + user code through `log` FIRST, then either polls
 * until approved (waitForApproval, for a real terminal) or records the
 * pending grant in auth-pending.json and returns at once (the slash
 * command: a Bash-tool run cannot show the code while it waits — the
 * approval is collected by finishDeviceLogin).
 * Authentik requires a brand-level "device code flow" to be configured or
 * the device endpoint answers 4xx — the error says so.
 */
export async function loginWithDeviceCode({
    issuer = OIDC_ISSUER,
    clientId = OIDC_CLIENT_ID,
    scopes = OIDC_SCOPES,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    timeoutMs = 15 * 60_000,
    waitForApproval = true,
    log = () => {},
} = {}) {
    const meta = await discover(issuer, { fetchImpl })
    const endpoint =
        meta.device_authorization_endpoint ??
        `${new URL(issuer).origin}/application/o/device/`
    let reply
    try {
        reply = await postForm(
            fetchImpl,
            endpoint,
            { client_id: clientId, scope: scopes },
            LOGIN_HTTP_TIMEOUT_MS
        )
    } catch (error) {
        throw new Error(`device authorization request failed (${error.name})`)
    }
    if (!reply.ok) {
        throw new Error(
            `device authorization failed (HTTP ${reply.status}, ${errorCode(reply)}) — the Authentik brand needs a device code flow configured for /ciwg-login device to work`
        )
    }
    const device = reply.body
    if (
        typeof device.device_code !== "string" ||
        typeof device.user_code !== "string" ||
        typeof device.verification_uri !== "string"
    ) {
        throw new Error("device authorization response is malformed")
    }
    const where =
        typeof device.verification_uri_complete === "string"
            ? device.verification_uri_complete
            : device.verification_uri
    log(`On any device, open:\n  ${where}\nand enter the code:  ${device.user_code}`)
    const startedAt = now()
    if (!waitForApproval) {
        writeJsonAtomic(
            pendingPath(),
            { version: AUTH_VERSION, created_at: startedAt, client_id: clientId, meta, device },
            { mode: 0o600 }
        )
        return {
            pending: true,
            userCode: device.user_code,
            verificationUri: where,
        }
    }
    return pollDeviceGrant({
        meta,
        clientId,
        device,
        startedAt,
        fetchImpl,
        sleep,
        now,
        timeoutMs,
        log,
    })
}

/** Second half of a deferred device sign-in (`--device-start` then
 * `--device-finish`, for runners that cannot show output while waiting). */
export async function finishDeviceLogin({
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    timeoutMs = 15 * 60_000,
    log = () => {},
} = {}) {
    const pending = readJson(pendingPath())
    if (!pending || pending.version !== AUTH_VERSION || !pending.device) {
        throw new Error("no pending device sign-in — run `--device-start` first")
    }
    return pollDeviceGrant({
        meta: pending.meta,
        clientId: pending.client_id || OIDC_CLIENT_ID,
        device: pending.device,
        startedAt: Number.isFinite(pending.created_at) ? pending.created_at : now(),
        fetchImpl,
        sleep,
        now,
        timeoutMs,
        log,
    })
}

// ---------------------------------------------------------------- logout

/** Best-effort revocation of the refresh token, then forget everything.
 * Never throws — the local wipe is what matters. */
export async function logout({ fetchImpl = globalThis.fetch, timeoutMs = LOGIN_HTTP_TIMEOUT_MS } = {}) {
    const auth = readAuth()
    let revoked = false
    if (auth?.refresh_token && auth.revocation_endpoint) {
        try {
            const reply = await postForm(
                fetchImpl,
                auth.revocation_endpoint,
                {
                    token: auth.refresh_token,
                    token_type_hint: "refresh_token",
                    client_id: auth.client_id || OIDC_CLIENT_ID,
                },
                timeoutMs
            )
            revoked = reply.ok
            if (!reply.ok) debug(`revocation HTTP ${reply.status}`)
        } catch (error) {
            debug("revocation network failure:", error.name)
        }
    }
    clearAuth()
    // A deliberate sign-out is not a first run: the user knows /ciwg-login.
    // Hold the daily "connect company knowledge" nudge for a day.
    updateState({ first_run_hint_at: Date.now() })
    return { hadSession: Boolean(auth), revoked, email: auth?.email }
}

// ---------------------------------------------------------------- status

/** Human line(s) for `login.mjs --status`. Never includes token material. */
export function describeAuthStatus({ now = Date.now() } = {}) {
    const lines = []
    if (getLegacyToken()) lines.push(LEGACY_TOKEN_NOTE)
    const auth = readAuth()
    const state = readState()
    if (!auth) {
        if (state.relogin_at) {
            const who = state.relogin_email ? ` (was ${state.relogin_email})` : ""
            const why = state.relogin_why ? `: ${state.relogin_why}` : ""
            lines.push(`SSO: sign-in required${who} — the session expired or was revoked${why}; run /ciwg-login.`)
        } else {
            lines.push("SSO: not signed in — run /ciwg-login.")
        }
        return lines.join("\n")
    }
    const minutes = Math.round(((auth.expires_at ?? 0) - now) / 60_000)
    const rejectedAt = state.api_rejected_at
        ? new Date(state.api_rejected_at).toISOString()
        : null
    const rejectedThisToken =
        rejectedAt !== null && state.api_rejected_token_exp === auth.expires_at
    const validity = rejectedThisToken
        ? `but the knowledge API REJECTED this token (HTTP 401 at ${rejectedAt}) — re-run /ciwg-login; if it persists the server may not trust this app yet`
        : minutes > 0
          ? `access token valid for ~${minutes} min`
          : "access token expired — refreshes on next use"
    lines.push(
        `SSO: signed in as ${auth.email ?? "(unknown user)"} — ${validity}; refresh token ${auth.refresh_token ? "cached" : "MISSING"}.`
    )
    // A refreshed token is not "accepted" just because it is new: the
    // rejection stays on record until the API answers 2xx to some token.
    if (rejectedAt !== null && !rejectedThisToken) {
        lines.push(
            `Note: the knowledge API rejected an earlier sign-in token (HTTP 401 at ${rejectedAt}); the current one has not been accepted yet — if the hooks stay silent, re-run /ciwg-login or ask the CIWG admin.`
        )
    }
    return lines.join("\n")
}
