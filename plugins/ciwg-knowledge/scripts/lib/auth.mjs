/**
 * Sign-in for the ciwg-knowledge hooks — CIWG SSO (Authentik) via OAuth 2.1.
 *
 * Why: the hooks call the knowledge REST API, which accepts an Authentik
 * access token as a Bearer credential. Nobody should have to mint an API
 * token by hand: `/ciwg-login` runs Authorization Code + PKCE against a
 * loopback redirect (opens the browser) or, for headless/SSH sessions, the
 * Device Authorization Grant (RFC 8628), and caches the result in
 * ~/.ciwg/auth.json (0600). Every hook run then uses the cached access
 * token, refreshes it silently when it expires and — when the refresh is
 * REJECTED (user deactivated in Authentik, refresh token revoked or expired)
 * — clears the cache so the hook can hint ONCE and otherwise stay silent.
 *
 * Zero dependencies: node:crypto (PKCE), node:http (loopback listener),
 * global fetch (Node ≥ 18). Every network-touching function takes an
 * injectable `fetchImpl` so the tests never dial out.
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
import {
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { ciwgDir, debug, readJson } from "./paths.mjs"

const normalizeIssuer = (s) => String(s).trim().replace(/\/*$/, "/")

export const OIDC_ISSUER = normalizeIssuer(
    process.env.CIWG_OIDC_ISSUER ||
        "https://auth.ciwebgroup.com/application/o/ciwg-knowledge/"
)
export const OIDC_CLIENT_ID = (
    process.env.CIWG_OIDC_CLIENT_ID || "ciwg-knowledge"
).trim()
export const OIDC_SCOPES = "openid profile email groups offline_access"

const AUTH_VERSION = 1
/** Treat an access token as expired this long before it really is. */
const EXPIRY_SKEW_MS = 30_000
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000
const HTTP_TIMEOUT_MS = 4_000
/** Cross-process refresh lock (Authentik ROTATES refresh tokens: two hooks
 * refreshing the same token concurrently would leave one with a dead token). */
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 3_000
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const FORM_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
}

export const authPath = () => join(ciwgDir(), "auth.json")
const lockPath = () => join(ciwgDir(), "auth.lock")
const pendingPath = () => join(ciwgDir(), "auth-pending.json")
const FIRST_RUN_MARKER = () => join(ciwgDir(), "login-hint")
const RELOGIN_MARKER = () => join(ciwgDir(), "relogin-hint")

/** Injected into context by the hooks — one line each, once. They address
 * Claude (additionalContext is model-facing) and ask it to relay. */
export const LOGIN_HINT_FIRST_RUN =
    "ciwg-knowledge: company knowledge is not connected on this machine. Tell the user once, in one short sentence: run /ciwg-login to connect company knowledge (CIWG SSO sign-in, no token needed)."
export const LOGIN_HINT_RELOGIN =
    "ciwg-knowledge: the company-knowledge sign-in has expired or been revoked. Tell the user once, in one short sentence: run /ciwg-login to sign in again."

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- crypto

const base64url = (buf) =>
    Buffer.from(buf)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")

/** RFC 7636: a 43-char base64url verifier and its S256 challenge. */
export function generatePkce() {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash("sha256").update(verifier).digest())
    return { verifier, challenge, method: "S256" }
}

export const randomToken = (bytes = 16) => base64url(randomBytes(bytes))

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
        const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/")
        const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null
    } catch {
        return null
    }
}

// --------------------------------------------------------------- storage

/** Cached sign-in state, or null when absent/unreadable/other version. */
export function readAuth() {
    const parsed = readJson(authPath())
    if (!parsed || typeof parsed !== "object") return null
    if (parsed.version !== AUTH_VERSION) return null
    return parsed
}

/** Atomic, owner-only write (0600; NTFS ignores the mode but %USERPROFILE%
 * is user-private by default). */
function writeOwnerOnly(path, value) {
    mkdirSync(ciwgDir(), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.${randomToken(4)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
}

export function writeAuth(auth) {
    writeOwnerOnly(authPath(), { version: AUTH_VERSION, ...auth })
}

/** Forget the sign-in (and every marker that describes it). */
export function clearAuth() {
    for (const path of [
        authPath(),
        pendingPath(),
        FIRST_RUN_MARKER(),
        RELOGIN_MARKER(),
    ]) {
        try {
            rmSync(path, { force: true })
        } catch {
            /* best effort */
        }
    }
}

export function isFresh(auth, now = Date.now()) {
    return Boolean(
        auth &&
            !auth.needs_login &&
            typeof auth.access_token === "string" &&
            auth.access_token &&
            Number.isFinite(auth.expires_at) &&
            auth.expires_at - EXPIRY_SKEW_MS > now
    )
}

/** Keep identity (for /ciwg-login --status) but drop every token: the next
 * hook run hints once and stays silent instead of retrying a dead refresh. */
function markNeedsLogin(auth, why) {
    debug("sign-in required:", why)
    try {
        writeAuth({
            issuer: auth?.issuer ?? OIDC_ISSUER,
            client_id: auth?.client_id ?? OIDC_CLIENT_ID,
            email: auth?.email,
            needs_login: true,
            needs_login_at: Date.now(),
        })
    } catch (error) {
        debug("could not persist needs_login:", error.code || error.message)
    }
}

/** Token-endpoint response → stored record. Keeps the previous refresh
 * token when the server does not rotate it, never stores the id_token. */
function tokenResponseToAuth(tokens, previous, meta, now) {
    const accessToken = tokens?.access_token
    if (typeof accessToken !== "string" || !accessToken) {
        throw new Error("token response lacks access_token")
    }
    const expiresIn = Number(tokens.expires_in)
    const jwtExp = decodeJwtPayload(accessToken)?.exp
    const expiresAt =
        Number.isFinite(expiresIn) && expiresIn > 0
            ? now + expiresIn * 1000
            : Number.isFinite(jwtExp)
              ? jwtExp * 1000
              : now + DEFAULT_TOKEN_TTL_MS
    const refreshToken =
        typeof tokens.refresh_token === "string" && tokens.refresh_token
            ? tokens.refresh_token
            : previous?.refresh_token
    const claims =
        decodeJwtPayload(tokens.id_token) ?? decodeJwtPayload(accessToken) ?? {}
    const email =
        typeof claims.email === "string"
            ? claims.email
            : typeof claims.preferred_username === "string"
              ? claims.preferred_username
              : previous?.email
    return {
        issuer: meta?.issuer ?? previous?.issuer ?? OIDC_ISSUER,
        client_id: previous?.client_id ?? OIDC_CLIENT_ID,
        token_endpoint: meta?.token_endpoint ?? previous?.token_endpoint,
        revocation_endpoint:
            meta?.revocation_endpoint ?? previous?.revocation_endpoint,
        access_token: accessToken,
        expires_at: expiresAt,
        refresh_token: refreshToken,
        email,
        obtained_at: now,
    }
}

// -------------------------------------------------------------- transport

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

const isEndpointUrl = (value) =>
    typeof value === "string" &&
    /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(value)

/** OIDC discovery — Authentik serves it per application at
 * <issuer>/.well-known/openid-configuration. */
export async function discover(
    issuer = OIDC_ISSUER,
    { fetchImpl = globalThis.fetch, timeoutMs = HTTP_TIMEOUT_MS } = {}
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
    const meta = await res.json()
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
        body = await res.json()
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
 * reason is "invalid_grant" (revoked/expired/rotated-away → sign in again),
 * "network", "http" (5xx/429 — transient, keep the tokens) or "malformed".
 */
export async function refreshAccessToken(
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
    if (reply.status === 400 || reply.status === 401) {
        return { ok: false, reason: "invalid_grant", code }
    }
    return { ok: false, reason: "http", code }
}

/** True when the lock was taken; false when it could not be (held past the
 * wait budget, or an unlockable filesystem) — callers proceed regardless,
 * the lock only narrows the rotation race. */
async function acquireLock(sleep) {
    const deadline = Date.now() + LOCK_WAIT_MS
    while (Date.now() <= deadline) {
        try {
            mkdirSync(lockPath(), { recursive: false })
            return true
        } catch (error) {
            if (error.code !== "EEXIST") return false
            let age = 0
            try {
                age = Date.now() - statSync(lockPath()).mtimeMs
            } catch {
                continue // holder released between our mkdir and stat
            }
            if (age > LOCK_STALE_MS) {
                try {
                    rmSync(lockPath(), { recursive: true, force: true })
                } catch {
                    /* retry below */
                }
                continue
            }
            await sleep(100)
        }
    }
    return false
}

function releaseLock() {
    try {
        rmSync(lockPath(), { recursive: true, force: true })
    } catch {
        /* best effort */
    }
}

async function refreshUnderLock(auth, opts) {
    const locked = await acquireLock(opts.sleep)
    try {
        // A sibling hook may have refreshed while we waited for the lock.
        const latest = readAuth()
        if (latest?.needs_login) return { ok: false, reason: "invalid_grant" }
        if (isFresh(latest, opts.now)) return { ok: true, auth: latest }
        const current = latest ?? auth
        const result = await refreshAccessToken(current, opts)
        if (result.ok) {
            writeAuth(result.auth)
            return result
        }
        if (result.reason !== "invalid_grant") return result
        // Rotation race: a sibling already persisted a NEWER refresh token.
        const again = readAuth()
        if (
            again?.refresh_token &&
            again.refresh_token !== current.refresh_token
        ) {
            if (isFresh(again, opts.now)) return { ok: true, auth: again }
            const retry = await refreshAccessToken(again, opts)
            if (retry.ok) {
                writeAuth(retry.auth)
                return retry
            }
            if (retry.reason !== "invalid_grant") return retry
        }
        markNeedsLogin(current, `refresh rejected (${result.code})`)
        return result
    } finally {
        if (locked) releaseLock()
    }
}

/** In-process dedupe: two hooks-in-one-process (search + engram run in
 * parallel) share a single refresh instead of racing each other. */
let inflightRefresh = null

/**
 * Access token for the API, from cache or via a silent refresh.
 * {token, expiresAt, email} or {token:null, reason} with reason "none"
 * (never signed in), "relogin" (refresh rejected — cache cleared),
 * "network" / "http" (transient — tokens kept, try again later).
 */
export async function getAccessToken({
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    timeoutMs = HTTP_TIMEOUT_MS,
    sleep = defaultSleep,
} = {}) {
    const auth = readAuth()
    if (!auth) return { token: null, reason: "none" }
    if (auth.needs_login) return { token: null, reason: "relogin" }
    if (isFresh(auth, now)) {
        return { token: auth.access_token, expiresAt: auth.expires_at, email: auth.email }
    }
    if (!auth.refresh_token || !auth.token_endpoint) {
        markNeedsLogin(auth, "no refresh token cached")
        return { token: null, reason: "relogin" }
    }
    if (!inflightRefresh) {
        inflightRefresh = refreshUnderLock(auth, {
            fetchImpl,
            now,
            timeoutMs,
            sleep,
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
export function getLegacyToken(env = process.env) {
    let raw = env.CIWG_KNOWLEDGE_TOKEN
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
 * {ok:true, kind:"api-token"|"oidc", headers} or
 * {ok:false, status:"no-token"|"relogin"|"network"|"http"}.
 */
export async function resolveAuth({ env = process.env, ...tokenOpts } = {}) {
    const legacy = getLegacyToken(env)
    if (legacy) {
        return { ok: true, kind: "api-token", headers: { "X-API-Token": legacy } }
    }
    const access = await getAccessToken(tokenOpts)
    if (access.token) {
        return {
            ok: true,
            kind: "oidc",
            headers: { Authorization: `Bearer ${access.token}` },
            email: access.email,
        }
    }
    return {
        ok: false,
        status: access.reason === "none" ? "no-token" : access.reason,
    }
}

// ----------------------------------------------------------------- hints

/** First-run nudge: at most once per `everyMs` (default: daily). */
export function firstRunHintDue({ now = Date.now(), everyMs = 24 * 60 * 60_000 } = {}) {
    try {
        if (now - statSync(FIRST_RUN_MARKER()).mtimeMs < everyMs) return false
    } catch {
        /* no marker yet */
    }
    try {
        mkdirSync(ciwgDir(), { recursive: true, mode: 0o700 })
        writeFileSync(FIRST_RUN_MARKER(), String(now))
    } catch {
        /* best effort — worst case the hint repeats */
    }
    return true
}

/** Re-login nudge: once per Claude Code session (the hook payload's
 * session_id), or hourly when no session id is available. */
export function reloginHintDue(sessionId, { now = Date.now() } = {}) {
    const key = sessionId ? String(sessionId).slice(0, 120) : ""
    try {
        const previous = readFileSync(RELOGIN_MARKER(), "utf8").trim()
        if (key && previous === key) return false
        if (!key && now - statSync(RELOGIN_MARKER()).mtimeMs < 60 * 60_000) {
            return false
        }
    } catch {
        /* no marker yet */
    }
    try {
        mkdirSync(ciwgDir(), { recursive: true, mode: 0o700 })
        writeFileSync(RELOGIN_MARKER(), key)
    } catch {
        /* best effort */
    }
    return true
}

// ------------------------------------------------------- loopback login

const escapeHtml = (s) =>
    String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

function htmlPage(res, status, title, body) {
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
    })
    res.end(
        `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
            `<body style="font-family:system-ui;margin:3rem auto;max-width:32rem;text-align:center">` +
            `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`
    )
}

/**
 * Temporary single-shot listener on 127.0.0.1:<random>. Resolves
 * {port, result, close}; `result` settles with {code} on a state-matched
 * /callback, rejects on an `error` callback or after timeoutMs. Mismatched
 * state gets a 400 and is IGNORED (the listener keeps waiting). The auth
 * code is never logged.
 */
export function startLoopbackListener({ state, timeoutMs, host = "127.0.0.1" }) {
    return new Promise((resolveStart, rejectStart) => {
        let settle
        const result = new Promise((resolve, reject) => {
            settle = { resolve, reject }
        })
        // The callback (or the timeout) can land while the caller is still
        // awaiting openBrowser(); without a handler attached that early
        // rejection would be "unhandled" and crash the login process.
        result.catch(() => {})
        const sockets = new Set()
        let done = false
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", `http://${host}`)
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
        server.on("connection", (socket) => {
            sockets.add(socket)
            socket.on("close", () => sockets.delete(socket))
        })
        server.once("error", rejectStart)
        server.listen(0, host, () => {
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
                for (const socket of sockets) socket.destroy()
                server.close()
            }
            resolveStart({ port, result, close })
        })
    })
}

/** Open a URL in the default browser, detached; rejects if no opener. */
export function openInBrowser(url) {
    return new Promise((resolve, reject) => {
        if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) {
            reject(new Error("refusing to open a non-http URL"))
            return
        }
        const options = { detached: true, stdio: "ignore", windowsHide: true }
        let child
        if (process.platform === "win32") {
            // `start "" "<url>"`: the empty title keeps `start` from treating
            // the quoted URL as a window title; verbatim args keep cmd.exe
            // from splitting on `&`.
            child = spawn("cmd.exe", ["/c", "start", '""', `"${url}"`], {
                ...options,
                windowsVerbatimArguments: true,
            })
        } else if (process.platform === "darwin") {
            child = spawn("open", [url], options)
        } else {
            child = spawn("xdg-open", [url], options)
        }
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
        10_000
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
    writeAuth(auth)
    try {
        rmSync(RELOGIN_MARKER(), { force: true })
        rmSync(FIRST_RUN_MARKER(), { force: true })
        rmSync(pendingPath(), { force: true })
    } catch {
        /* best effort */
    }
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
        try {
            await openBrowser(authorizeUrl.toString())
        } catch (error) {
            log(`(could not open a browser automatically: ${error.message})`)
        }
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

async function pollDeviceGrant({
    meta,
    clientId,
    device,
    fetchImpl,
    sleep,
    now,
    timeoutMs,
    log,
}) {
    let interval = Math.max(1, Number(device.interval) || 5) * 1000
    const expiresIn = Math.max(30, Number(device.expires_in) || 600) * 1000
    const deadline = now() + Math.min(expiresIn, timeoutMs)
    for (;;) {
        await sleep(interval)
        if (now() > deadline) {
            throw new Error("the device code expired before the sign-in was approved")
        }
        const reply = await postForm(
            fetchImpl,
            meta.token_endpoint,
            {
                grant_type: DEVICE_GRANT,
                device_code: device.device_code,
                client_id: clientId,
            },
            10_000
        )
        if (reply.ok) return finishLogin(reply.body, meta, clientId, now(), log)
        const code = errorCode(reply)
        if (code === "authorization_pending") continue
        if (code === "slow_down") {
            interval += 5000
            continue
        }
        if (code === "expired_token") {
            throw new Error("the device code expired before the sign-in was approved")
        }
        if (code === "access_denied") throw new Error("the sign-in was denied")
        throw new Error(`device sign-in failed (HTTP ${reply.status}, ${code})`)
    }
}

/**
 * Device Authorization Grant (RFC 8628) — the headless/SSH fallback. Prints
 * the verification URL + user code through `log`, then (unless
 * waitForApproval is false) polls the token endpoint until approved.
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
            10_000
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
    if (!waitForApproval) {
        writeOwnerOnly(pendingPath(), {
            version: AUTH_VERSION,
            created_at: now(),
            client_id: clientId,
            meta,
            device,
        })
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
export async function logout({ fetchImpl = globalThis.fetch, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
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
    return { hadSession: Boolean(auth), revoked, email: auth?.email }
}

// ---------------------------------------------------------------- status

/** Human line(s) for `login.mjs --status`. Never includes token material. */
export function describeAuthStatus({ env = process.env, now = Date.now() } = {}) {
    const lines = []
    if (getLegacyToken(env)) {
        lines.push(
            "Legacy API token configured (CIWG_KNOWLEDGE_TOKEN or ~/.ciwg/knowledge.json) — it takes precedence over SSO until removed."
        )
    }
    const auth = readAuth()
    if (!auth) {
        lines.push("SSO: not signed in — run /ciwg-login.")
    } else if (auth.needs_login) {
        lines.push(
            `SSO: sign-in required${auth.email ? ` (was ${auth.email})` : ""} — the session expired or was revoked; run /ciwg-login.`
        )
    } else {
        const minutes = Math.round(((auth.expires_at ?? 0) - now) / 60_000)
        const validity =
            minutes > 0
                ? `access token valid for ~${minutes} min`
                : "access token expired — refreshes on next use"
        lines.push(
            `SSO: signed in as ${auth.email ?? "(unknown user)"} — ${validity}; refresh token ${auth.refresh_token ? "cached" : "MISSING"}.`
        )
    }
    return lines.join("\n")
}
