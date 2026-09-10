/**
 * Shared config + API access for the ciwg-knowledge plugin.
 *
 * Auth (see lib/auth.mjs): every API call sends the CIWG SSO (Authentik)
 * access token as `Authorization: Bearer` — obtained with /ciwg-login,
 * refreshed silently. A legacy `route:knowledge` API token
 * (CIWG_KNOWLEDGE_TOKEN env, then ~/.ciwg/knowledge.json {"token": "..."})
 * still works as X-API-Token and takes precedence when set. No credential
 * = every entry point no-ops silently — the plugin must never break a
 * session.
 *
 * Time budget: a hook passes `deadline` (hookDeadline()) into every call;
 * credential resolution (lock wait + refresh) and the API call are each
 * sized from what is left, so auth + API ≤ the hooks.json timeout by
 * construction.
 *
 * Client mapping: an optional .ciwg-client.json at the project root
 * ({"organizationId": 7, "clientName": "Acme HVAC"}) scopes retrieval to
 * that client and enables the session brief. Repo-authored = UNTRUSTED:
 * values are validated, capped, and escaped before they touch context.
 *
 * Diagnostics: set CIWG_KNOWLEDGE_DEBUG=1 for stderr traces — the hot
 * paths stay silent by design, which otherwise makes "sign-in expired",
 * "BOM in config", and "nothing relevant" indistinguishable.
 */

import { join } from "node:path"
import { clearApiRejected, markApiRejected, resolveAuth } from "./auth.mjs"
import { ciwgDir, debug, escapeXml, fetchWithTimeout, readJson, remainingMs } from "./paths.mjs"
import { backOff, isBackedOff } from "./state.mjs"

export { debug, escapeXml }

export const API_BASE = (
    process.env.CIWG_KNOWLEDGE_URL || "https://api.ciwebgroup.com"
).replace(/\/$/, "")

/**
 * Wall-clock budget for one hook process. hooks.json gives each hook 6 s;
 * ~1 s is kept back for Node start-up and the stdout flush. Every API call
 * a hook makes is bounded by this deadline (tests assert the relation).
 */
export const HOOK_BUDGET_MS = 5_000
export const hookDeadline = () => Date.now() + HOOK_BUDGET_MS

/** After a network-level API failure, skip lookups for this long. */
const API_BACKOFF_MS = 60_000
/** Below this, an API call is not worth starting. */
const MIN_API_MS = 200
const DEFAULT_API_TIMEOUT_MS = 4_000
/** How long a resolved credential is reused inside one process. Hooks are
 * one-shot (all their calls share it); the long-lived MCP server must see
 * a refreshed token, hence the short life. */
const CREDENTIAL_MEMO_MS = 1_000

const MAX_INT32 = 2147483647

/** {organizationId?, clientName?} from <cwd>/.ciwg-client.json, or null. */
export function getClientMapping(cwd) {
    if (!cwd) return null
    const parsed = readJson(join(cwd, ".ciwg-client.json"))
    if (!parsed || typeof parsed !== "object") return null
    // Accept a quoted number too — a config typo must not silently
    // WIDEN the search to cross-org.
    const orgRaw =
        typeof parsed.organizationId === "string" &&
        /^[1-9]\d{0,9}$/.test(parsed.organizationId)
            ? Number(parsed.organizationId)
            : parsed.organizationId
    const organizationId =
        Number.isInteger(orgRaw) && orgRaw > 0 && orgRaw <= MAX_INT32
            ? orgRaw
            : undefined
    const clientName =
        typeof parsed.clientName === "string" && parsed.clientName.trim()
            ? parsed.clientName.trim().slice(0, 80)
            : undefined
    if (organizationId === undefined && clientName === undefined) return null
    return { organizationId, clientName }
}

let credentialMemo = null

/**
 * The credential for API calls, resolved ONCE per process and shared by
 * the parallel calls a hook makes (one auth.json read, one refresh).
 * Failures are not memoised — they are cheap to re-derive and the IdP
 * backoff lives in auth.mjs. Same result shape as resolveAuth().
 */
export function resolveCredential(opts = {}) {
    if (!credentialMemo) {
        const pending = resolveAuth(opts).then(
            (auth) => {
                if (auth.ok) setTimeout(() => (credentialMemo = null), CREDENTIAL_MEMO_MS).unref()
                else credentialMemo = null
                return auth
            },
            (error) => {
                credentialMemo = null
                throw error
            }
        )
        credentialMemo = pending
    }
    return credentialMemo
}

/** Drop the memoised credential (tests; a long-lived caller after logout). */
export function resetCredentialMemo() {
    credentialMemo = null
}

/**
 * Shared request core: credential first (so "not signed in" is never
 * masked as "backoff"), then the API backoff, then one bounded call.
 * Returns {ok:true, data} or {ok:false, status} where status is an HTTP
 * status number, "network", "timeout", "backoff", "no-token" (never
 * signed in, no legacy token), "relogin" (SSO refresh rejected — sign in
 * again), "busy" (a sibling is refreshing), or "api-rejected" (the API
 * answered 401 to an SSO token — actionable, see describeFailure).
 * Callers decide how loud to be (hooks: silent / one hint; MCP tools:
 * actionable message).
 */
async function apiRequest(
    url,
    init,
    { timeoutMs = DEFAULT_API_TIMEOUT_MS, deadline, fetchImpl = globalThis.fetch } = {}
) {
    const auth = await resolveCredential({ deadline, fetchImpl })
    if (!auth.ok) return { ok: false, status: auth.status }
    if (isBackedOff("api_down_until")) {
        debug("skipping API call (recent network failure)")
        return { ok: false, status: "backoff" }
    }
    const budget = Math.min(timeoutMs, remainingMs(deadline))
    if (budget < MIN_API_MS) {
        debug("skipping API call (hook budget exhausted)")
        return { ok: false, status: "timeout" }
    }
    try {
        const res = await fetchWithTimeout(
            fetchImpl,
            url,
            { ...init, headers: { ...auth.headers, ...(init.headers || {}) } },
            budget
        )
        if (res.status === 401 && auth.kind === "oidc") {
            debug("API rejected the SSO token (401)")
            markApiRejected(auth.expiresAt)
            return { ok: false, status: "api-rejected" }
        }
        if (!res.ok) {
            debug(`API HTTP ${res.status}`)
            return { ok: false, status: res.status }
        }
        if (auth.kind === "oidc") clearApiRejected()
        return { ok: true, data: res.json() }
    } catch (error) {
        // Never surface error.message — a header-illegal token value would
        // be echoed back by Node's Headers error.
        debug("API network failure:", error.name)
        backOff("api_down_until", API_BACKOFF_MS)
        return { ok: false, status: "network" }
    }
}

/** GET /api/v1/knowledge/search. See apiRequest for the result shape. */
export async function searchKnowledge(
    { q, organizationId, sourceTypes, limit, minScore },
    opts = {}
) {
    const url = new URL(`${API_BASE}/api/v1/knowledge/search`)
    url.searchParams.set("q", String(q).slice(0, 500))
    if (organizationId != null) {
        url.searchParams.set("organization_id", String(organizationId))
    }
    if (sourceTypes?.length) {
        url.searchParams.set("source_type", sourceTypes.join(","))
    }
    if (limit != null) url.searchParams.set("limit", String(limit))
    if (minScore != null) url.searchParams.set("min_score", String(minScore))
    return apiRequest(url, { method: "GET" }, opts)
}

/** GET /api/v1/knowledge/artifacts — the analysis outputs for one source. */
export async function getSourceArtifacts({ sourceType, sourceId }, opts = {}) {
    const url = new URL(`${API_BASE}/api/v1/knowledge/artifacts`)
    url.searchParams.set("source_type", String(sourceType ?? ""))
    url.searchParams.set("source_id", String(sourceId ?? ""))
    return apiRequest(url, { method: "GET" }, opts)
}

/**
 * Engram opt-out: env CIWG_ENGRAM=off (also 0/false) or `"engram": false`
 * in ~/.ciwg/knowledge.json stops the SessionEnd hook from POSTING activity
 * digests. Read-side injection is unaffected — the opt-out is about not
 * publishing your own activity.
 */
export function isEngramOptedOut() {
    const env = (process.env.CIWG_ENGRAM || "").trim().toLowerCase()
    if (env === "off" || env === "0" || env === "false") return true
    const parsed = readJson(join(ciwgDir(), "knowledge.json"))
    return parsed?.engram === false
}

/**
 * POST /api/v1/engram/activities — publish one STRUCTURED activity digest
 * (structured facts only; the server whitelists keys and clamps lengths).
 */
/**
 * The team memory's write path (Stop hook): one turn — prompt, reply and
 * the session's facts — for the server to summarize in the context of the
 * author's day and keep as one activity line. The raw text is not stored.
 */
export async function postEngramTurn(turn, opts = {}) {
    return apiRequest(
        `${API_BASE}/api/v1/engram/turns`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(turn),
        },
        opts
    )
}

export async function postEngramActivity(digest, opts = {}) {
    return apiRequest(
        `${API_BASE}/api/v1/engram/activities`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(digest),
        },
        opts
    )
}

/**
 * GET /api/v1/engram/activities — today's team activity, org- or
 * repo-filtered. Callers must pass at least one filter; an unfiltered read
 * would inject unrelated team activity into every session.
 */
export async function listEngramActivities(
    { organizationId, repo, limit } = {},
    opts = {}
) {
    if (organizationId == null && !repo) {
        return { ok: false, status: "no-scope" }
    }
    const url = new URL(`${API_BASE}/api/v1/engram/activities`)
    if (organizationId != null) {
        url.searchParams.set("organization_id", String(organizationId))
    } else {
        url.searchParams.set("repo", String(repo).slice(0, 200))
    }
    if (limit != null) url.searchParams.set("limit", String(limit))
    return apiRequest(url, { method: "GET" }, { timeoutMs: 3_000, ...opts })
}

/**
 * POST /api/v1/knowledge/inject — the server-side brain behind the prompt
 * and session-start hooks. The hook sends what it knows (the event, the
 * prompt, the session's facts) and injects `data.context` VERBATIM (null =
 * nothing qualifies). Every retrieval and rendering policy — what earns a
 * place in the context window, how it is cited, how team memory is
 * ordered — lives on the server, so it changes with a deploy and never
 * needs a plugin release. See apiRequest for the result shape.
 */
export async function postInject(request, opts = {}) {
    return apiRequest(
        `${API_BASE}/api/v1/knowledge/inject`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        },
        opts
    )
}

/** Human-actionable line for an API failure status. */
export function describeFailure(status) {
    if (status === "no-token") {
        return "Not signed in to company knowledge. Run /ciwg-login (or `node scripts/login.mjs`) to sign in with CIWG SSO — see the ciwg-knowledge plugin README."
    }
    if (status === "relogin") {
        return "The company-knowledge sign-in expired or was revoked. Run /ciwg-login to sign in again."
    }
    if (status === "api-rejected") {
        return "The knowledge API rejected the sign-in token (401) — re-run /ciwg-login; if it persists, the server may not trust this app yet (ask the CIWG admin)."
    }
    if (status === 401) return "Knowledge API rejected the credential (401)."
    if (status === 403) {
        return "Credential lacks access: the account is not internal staff, or a legacy token lacks the route:knowledge scope (403)."
    }
    if (status === 400) return "Knowledge API rejected the parameters (400)."
    if (status === "backoff") {
        return "Knowledge API (or the sign-in server) recently unreachable — backing off briefly."
    }
    if (status === "busy") {
        return "Another process is refreshing the sign-in right now — try again in a moment."
    }
    if (status === "timeout") return "Ran out of time before the knowledge API could be called."
    if (status === "network") return "Knowledge API unreachable (network)."
    if (status === "http") return "Sign-in server returned a transient error — try again shortly."
    return `Knowledge API error (${status}).`
}

/** Read all of stdin (hook payload). */
export async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString("utf8")
}

/** Emit hook JSON; resolves once stdout has DRAINED (Windows pipes are
 * async — a bare process.exit right after write truncates the payload
 * intermittently). Callers: `await emit(payload); process.exit(0)`. */
export function emit(payload) {
    return new Promise((resolve) => {
        process.stdout.write(JSON.stringify(payload), () => resolve())
    })
}

