#!/usr/bin/env node
/**
 * ciwg-knowledge sign-out — `node scripts/logout.mjs` or `/ciwg-logout`.
 * Revokes the cached refresh token at Authentik (best effort) and deletes
 * ~/.ciwg/auth.json plus the hint markers. Never prints tokens.
 */

import { getLegacyToken, logout } from "./lib/auth.mjs"

const say = (line) => process.stdout.write(`${line}\n`)

try {
    const result = await logout()
    if (!result.hadSession) {
        say("No SSO sign-in was cached — nothing to do.")
    } else {
        say(
            `Signed out${result.email ? ` (${result.email})` : ""} — local sign-in removed${result.revoked ? ", refresh token revoked at CIWG SSO" : ""}.`
        )
    }
    if (getLegacyToken()) {
        say(
            "Note: a legacy API token is still configured (CIWG_KNOWLEDGE_TOKEN or ~/.ciwg/knowledge.json) — the hooks will keep using it until you remove it."
        )
    }
    process.exitCode = 0
} catch (error) {
    say(`Sign-out failed: ${error?.message ?? error}`)
    process.exitCode = 1
}
