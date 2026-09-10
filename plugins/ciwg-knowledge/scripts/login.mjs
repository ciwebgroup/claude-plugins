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
 *   --auto            the AUTOMATIC sign-in helper the SessionStart hook
 *                     spawns detached (see lib/auth.mjs "automatic login"):
 *                     silent, claims ~/.ciwg/auto-login.json, publishes the
 *                     authorize URL there (stamping the daily cadence at
 *                     that moment), runs the browser flow, exits.
 *                     Never prints; never runs when opted out or headless
 *   --status          who is signed in, token validity, legacy-token presence
 *   --help
 *
 * Exit 0 on success, 1 on failure. Prints one result line; never prints
 * tokens, codes (other than the user code), or the PKCE verifier.
 */

import {
    AUTO_LOGIN_TIMEOUT_MS,
    LEGACY_TOKEN_NOTE,
    claimAutoLogin,
    describeAuthStatus,
    finishDeviceLogin,
    getLegacyToken,
    isAutoLoginOptedOut,
    loginWithBrowser,
    loginWithDeviceCode,
    looksHeadless,
    markAutoLoginFailed,
    markAutoLoginStarted,
    publishAutoLoginUrl,
    readAuth,
    releaseAutoLogin,
} from "./lib/auth.mjs"
import { debug, say } from "./lib/paths.mjs"

const flags = new Set(
    process.argv.slice(2).map((arg) => arg.replace(/^-+/, "").toLowerCase())
)
const has = (name) => flags.has(name)

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

/**
 * The detached automatic sign-in. Guards are re-checked here (the spawning
 * hook checked them too, but the child may start seconds later): a legacy
 * token or an existing sign-in means nothing to do; opt-out and headless
 * never open a browser; a live sibling attempt (marker) is not duplicated.
 * The daily cadence is stamped HERE, the moment the authorize URL exists
 * and just before the browser opens — not by the spawner: a child that
 * never reaches the sign-in server leaves the cadence alone and instead
 * puts the automatic sign-in on a shorter hold (markAutoLoginFailed
 * without a link), so an unreachable IdP does not cost every session
 * start a doomed attempt (the spawner's own "in-progress" check on the
 * marker is what stops a second tab).
 */
async function autoLogin() {
    if (getLegacyToken() || readAuth()) return
    if (isAutoLoginOptedOut() || looksHeadless()) return
    if (!claimAutoLogin()) return
    let hadUrl = false
    try {
        await loginWithBrowser({
            timeoutMs: AUTO_LOGIN_TIMEOUT_MS,
            log: debug,
            onAuthorizeUrl: (url) => {
                hadUrl = true
                markAutoLoginStarted()
                publishAutoLoginUrl(url)
            },
        })
    } catch (error) {
        markAutoLoginFailed(error?.message ?? error, Date.now(), { hadUrl })
    } finally {
        releaseAutoLogin()
    }
}

try {
    if (has("help") || has("h")) {
        usage()
    } else if (has("status")) {
        say(describeAuthStatus())
    } else if (has("auto")) {
        await autoLogin()
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
