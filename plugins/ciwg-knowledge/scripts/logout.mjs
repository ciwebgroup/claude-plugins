#!/usr/bin/env node
/**
 * ciwg-knowledge sign-out — `node scripts/logout.mjs` or `/ciwg-logout`.
 * Revokes the cached refresh token at Authentik (best effort) and deletes
 * ~/.ciwg/auth.json plus the plugin state. Never prints tokens.
 */

import { LEGACY_TOKEN_NOTE, getLegacyToken, logout } from "./lib/auth.mjs"
import { say } from "./lib/paths.mjs"

try {
    const result = await logout()
    if (!result.hadSession) {
        say("No SSO sign-in was cached — nothing to do.")
    } else {
        say(
            `Signed out${result.email ? ` (${result.email})` : ""} — local sign-in removed${result.revoked ? ", refresh token revoked at CIWG SSO" : ""}.`
        )
    }
    if (getLegacyToken()) say(LEGACY_TOKEN_NOTE)
    process.exitCode = 0
} catch (error) {
    say(`Sign-out failed: ${error?.message ?? error}`)
    process.exitCode = 1
}
