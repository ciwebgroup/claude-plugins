#!/usr/bin/env node
/**
 * ciwg-knowledge sign-in — `node scripts/login.mjs` or `/ciwg-login`.
 *
 *   (no flag)         browser sign-in (Authorization Code + PKCE, loopback
 *                     redirect). On SSH/headless it prints a device-code
 *                     URL + code and RETURNS AT ONCE (never blocks) — finish
 *                     with --device-finish once approved
 *   --device          device-code flow in a real terminal: prints the URL +
 *                     code, then waits for the approval
 *   --device-start    prints the URL + code and EXITS (for runners that
 *                     cannot show output while waiting) …
 *   --device-finish   … then waits for the approval of that pending sign-in
 *   --status          who is signed in, token validity, legacy-token presence
 *   --help
 *
 * Exit 0 on success, 1 on failure. Prints one result line; never prints
 * tokens, codes (other than the user code), or the PKCE verifier.
 */

import {
    LEGACY_TOKEN_NOTE,
    describeAuthStatus,
    finishDeviceLogin,
    getLegacyToken,
    loginWithBrowser,
    loginWithDeviceCode,
} from "./lib/auth.mjs"
import { say } from "./lib/paths.mjs"

const flags = new Set(
    process.argv.slice(2).map((arg) => arg.replace(/^-+/, "").toLowerCase())
)
const has = (name) => flags.has(name)

/** SSH sessions and display-less Linux cannot receive a loopback redirect
 * in a local browser — use the device flow there. */
function looksHeadless() {
    if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true
    return (
        process.platform === "linux" &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY
    )
}

function usage() {
    say("Usage: node scripts/login.mjs [--device | --device-start | --device-finish | --status]")
    say("  Signs you in to CIWG company knowledge with CIWG SSO (no token needed).")
}

function report(result) {
    say(
        `Signed in as ${result.email ?? "(unknown user)"} — company knowledge is connected from your next prompt.`
    )
    if (!result.hasRefreshToken) {
        say("Note: no refresh token was issued, so you will be asked to sign in again when the access token expires.")
    }
}

/** Print the URL + code and return immediately; the approval is collected
 * by a later --device-finish. Used by --device-start and by the default
 * mode over SSH, so a Bash-tool run never sits blocked with the code
 * invisible. */
async function deferredDeviceStart() {
    const pending = await loginWithDeviceCode({ log: say, waitForApproval: false })
    say(
        `DEVICE_CODE_PENDING: approve the sign-in on any device, then run: node scripts/login.mjs --device-finish  (code ${pending.userCode} expires in a few minutes)`
    )
}

try {
    if (has("help") || has("h")) {
        usage()
    } else if (has("status")) {
        say(describeAuthStatus())
    } else {
        if (getLegacyToken()) say(LEGACY_TOKEN_NOTE)
        if (has("device-finish")) {
            say("Waiting for you to approve the sign-in…")
            report(await finishDeviceLogin({ log: say }))
        } else if (has("device-start")) {
            await deferredDeviceStart()
        } else if (has("device")) {
            report(await loginWithDeviceCode({ log: say }))
        } else if (looksHeadless()) {
            say("Headless/SSH session detected — using the device-code flow.")
            await deferredDeviceStart()
        } else {
            report(await loginWithBrowser({ log: say }))
        }
    }
    process.exitCode = 0
} catch (error) {
    say(`Sign-in failed: ${error?.message ?? error}`)
    if (!has("device") && !has("device-start") && !has("device-finish")) {
        say("If a browser cannot reach this machine, try: node scripts/login.mjs --device")
    }
    process.exitCode = 1
}
