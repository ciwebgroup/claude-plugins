#!/usr/bin/env node
/**
 * ciwg-knowledge sign-in — `node scripts/login.mjs` or `/ciwg-login`.
 *
 *   (no flag)         browser sign-in (Authorization Code + PKCE, loopback
 *                     redirect); switches to the device flow on SSH/headless
 *   --device          device-code flow: prints a URL + code, waits for approval
 *   --device-start    prints the URL + code and EXITS (for runners that
 *                     cannot show output while waiting) …
 *   --device-finish   … then waits for the approval of that pending sign-in
 *   --status          who is signed in, token validity, legacy-token presence
 *   --help
 *
 * Exit 0 on success, 1 on failure. Prints one result line; never prints
 * tokens, codes, or the PKCE verifier.
 */

import {
    describeAuthStatus,
    finishDeviceLogin,
    getLegacyToken,
    loginWithBrowser,
    loginWithDeviceCode,
} from "./lib/auth.mjs"

const flags = new Set(
    process.argv.slice(2).map((arg) => arg.replace(/^-+/, "").toLowerCase())
)
const has = (name) => flags.has(name)
const say = (line) => process.stdout.write(`${line}\n`)

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

try {
    if (has("help") || has("h")) {
        usage()
    } else if (has("status")) {
        say(describeAuthStatus())
    } else {
        if (getLegacyToken()) {
            say(
                "Note: a legacy API token is configured (CIWG_KNOWLEDGE_TOKEN or ~/.ciwg/knowledge.json); it takes precedence over SSO until you remove it."
            )
        }
        if (has("device-finish")) {
            say("Waiting for you to approve the sign-in…")
            report(await finishDeviceLogin({ log: say }))
        } else if (has("device-start")) {
            const pending = await loginWithDeviceCode({
                log: say,
                waitForApproval: false,
            })
            say(
                `Then run: node scripts/login.mjs --device-finish  (code ${pending.userCode} expires in a few minutes)`
            )
        } else if (has("device") || looksHeadless()) {
            if (!has("device")) {
                say("Headless/SSH session detected — using the device-code flow.")
            }
            report(await loginWithDeviceCode({ log: say }))
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
