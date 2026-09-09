---
description: Sign out of CIWG company knowledge — revokes the cached SSO refresh token and removes the local sign-in.
allowed-tools: Bash(node *)
disable-model-invocation: true
---

Sign the user out of CIWG company knowledge (hooks and MCP tools alike).

1. Run with the Bash tool: `node "${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs"`
2. Relay its result line. If it notes that a legacy API token is still configured, tell the user the hooks will keep using that token until they remove `CIWG_KNOWLEDGE_TOKEN` / `~/.ciwg/knowledge.json`.
3. Mention that `/ciwg-login` signs back in. Nothing else is needed.
