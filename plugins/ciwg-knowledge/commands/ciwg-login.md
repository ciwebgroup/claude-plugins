---
description: Sign in to CIWG company knowledge with CIWG SSO (Authentik) — the manual fallback; normally the plugin opens the sign-in by itself on first use. Use when the user asks to connect or reconnect company knowledge, or when a ciwg-knowledge hook or tool says to run /ciwg-login.
argument-hint: "[device]"
allowed-tools: Bash(node *)
disable-model-invocation: true
---

Sign the user in to CIWG company knowledge. No token, password or secret is ever typed into Claude Code — the sign-in happens in the browser. One sign-in covers the hooks AND the `ciwg-knowledge` MCP tools. (Normally this is not needed: the plugin opens the same sign-in automatically the first time a session finds none. This command is the manual path — after a sign-out, after opting out of the automatic one, or on a machine where the browser could not open.)

Mode requested: `$ARGUMENTS` (empty = browser sign-in; `device` = code-based sign-in for SSH/headless sessions).

## Browser sign-in (default)

1. Run with the Bash tool, timeout 300000 ms:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs"`
   It opens the CIWG SSO page in the user's default browser and waits (up to 3 minutes) for them to finish. If the browser did not open, the script prints the URL to visit — relay it verbatim.
2. Relay the script's final line. On `Signed in as …`, tell the user company knowledge is connected and applies from their next prompt. If it mentions a legacy API token, mention that too.
3. **If the output contains `DEVICE_CODE_PENDING`** the script detected an SSH/headless session and switched to the device-code flow WITHOUT waiting. Continue with step 2 of "Device sign-in" below.

## Device sign-in (`device`, or when the browser flow cannot work)

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" --device-start` (timeout 60000). It prints a verification URL and a user code and exits immediately.
2. **Show the user the verification URL and the code EXACTLY as printed — verbatim, on their own lines, before doing anything else.** They open the URL on any device (phone included) and enter the code. Ask them to tell you when they have approved it.
3. Once the user says it is approved (or immediately, if they prefer to approve while it waits), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" --device-finish` (timeout 600000). It returns as soon as the approval is seen and reports `Signed in as …`. The code stays valid for several minutes; if it expired, start again from step 1.
4. If it fails with "the Authentik brand needs a device code flow", tell the user to ask the CIWG SSO admin to enable it, or to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs"` in a terminal on a machine with a browser.

## Rules

- Never run a step that would sit blocked while the user cannot see the code: the URL + code must be shown before any waiting call.
- Do not retry more than once. Never ask the user for a password, token or code; never read `~/.ciwg/auth.json`.
- The scripts never print tokens; do not try to extract or display any.
- After a successful sign-in nothing else is needed — the hooks and the MCP tools pick the credential up automatically.
