---
description: Sign in to CIWG company knowledge with CIWG SSO (Authentik). Use when the user wants to connect or reconnect company knowledge, or when a ciwg-knowledge hook says to run /ciwg-login.
argument-hint: "[device]"
allowed-tools: Bash(node *)
disable-model-invocation: true
---

Sign the user in to CIWG company knowledge. No token, password or secret is ever typed into Claude Code — the sign-in happens in the browser.

Mode requested: `$ARGUMENTS` (empty = browser sign-in; `device` = code-based sign-in for SSH/headless sessions).

## Browser sign-in (default)

1. Run with the Bash tool, timeout 300000 ms:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs"`
   It opens the CIWG SSO page in the user's default browser and waits (up to 3 minutes) for them to finish. If the browser did not open, the script prints the URL to visit — relay it verbatim.
2. Relay the script's final line. On `Signed in as …`, tell the user company knowledge is connected and applies from their next prompt. If it mentions a legacy API token taking precedence, mention that too.
3. If the script reports it detected a headless/SSH session, it already switched to the device flow: show the user the URL and code it printed, verbatim.

## Device sign-in (`device`, or when the browser flow cannot work)

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" --device-start` (timeout 60000). Show the user the verification URL and the code exactly as printed.
2. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" --device-finish` (timeout 600000) — it waits for the user to approve the sign-in on any device, then reports `Signed in as …`.
3. If it fails with "the Authentik brand needs a device code flow", tell the user to ask the CIWG SSO admin to enable it, or to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs"` in a terminal on a machine with a browser.

## Rules

- Do not retry more than once. Never ask the user for a password, token or code; never read `~/.ciwg/auth.json`.
- The scripts never print tokens; do not try to extract or display any.
- After a successful sign-in nothing else is needed — the hooks pick the credential up automatically.
