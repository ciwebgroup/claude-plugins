/**
 * ~/.ciwg/state.json — the plugin's ONE non-secret state file. It replaces
 * the marker-file sprawl (login-hint, relogin-hint, knowledge-down, the
 * needs_login tombstone inside auth.json) with a single small JSON object:
 *
 *   first_run_hint_at        last "run /ciwg-login" nudge to a never-signed-in user
 *   relogin_at/_email/_why   the sign-in was dropped (refresh rejected) — WHO
 *                            and WHY, so the hooks hint once and --status can
 *                            explain; absence = never signed in
 *   relogin_hint_session/_at cadence of that hint (once per Claude session)
 *   api_rejected_at/_token_exp/_hint_session/_at
 *                            the REST API answered 401 to an SSO token —
 *                            surfaced once per session and in --status
 *   api_down_until           REST API unreachable → skip calls until then
 *   idp_down_until           sign-in server unreachable → skip refreshes until
 *                            then (separate from api_down: an IdP outage must
 *                            not silence knowledge lookups that still work)
 *   auto_login_at            last automatic browser sign-in that had a link
 *                            (or a sign-out) — once a day; auto_login_error/
 *                            _error_at say how the last attempt failed and
 *                            auto_login_hold_until holds the next one after
 *                            an attempt that never got a link (IdP unreachable)
 *
 * Secrets never live here: tokens stay in auth.json (0600), a pending device
 * code in auth-pending.json (0600). Every function is fail-open — a missing
 * or corrupt state file reads as {} and the next write heals it.
 */

import { join } from "node:path"
import { ciwgDir, debug, readJson, rmQuiet, writeJsonAtomic } from "./paths.mjs"

export const statePath = () => join(ciwgDir(), "state.json")

/** The current state object — {} when absent or unreadable. */
export function readState() {
    const parsed = readJson(statePath())
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
}

/** Shallow-merge `patch` into the state; a null/undefined value deletes the
 * key. Never throws. */
export function updateState(patch) {
    try {
        const next = { ...readState(), ...patch }
        for (const [key, value] of Object.entries(next)) {
            if (value === null || value === undefined) delete next[key]
        }
        writeJsonAtomic(statePath(), next, { mode: 0o600 })
    } catch (error) {
        debug("state write failed:", error.code || error.message)
    }
}

/** Delete every key whose name starts with one of `prefixes`. */
export function pruneState(prefixes) {
    const state = readState()
    const patch = {}
    for (const key of Object.keys(state)) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) patch[key] = null
    }
    if (Object.keys(patch).length > 0) updateState(patch)
}

export const clearState = () => rmQuiet(statePath())

/** `<key>` holds an absolute ms timestamp until which the thing is down. */
export function isBackedOff(key, now = Date.now()) {
    const until = readState()[key]
    return Number.isFinite(until) && until > now
}

export function backOff(key, forMs, now = Date.now()) {
    updateState({ [key]: now + forMs })
}
