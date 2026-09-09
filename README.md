# CIWG Claude Code plugins

Private plugin marketplace for CI Web Group's internal Claude Code tooling.

## Install

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install ciwg-knowledge@ciwg
```

## Plugins

| Plugin | What it does |
|---|---|
| `ciwg-knowledge` | Auto-injects relevant company knowledge (call transcripts, chat logs, Fathom meetings today; helpdesk tickets, team chat and org notes as their ingestion ships) into Claude's context via hooks — the model never spends tokens or reasoning on retrieval. Sign in once with `/ciwg-login` (CIWG SSO). Also ships explicit MCP search tools. |

Each plugin's README covers its own setup (SSO sign-in, environment).
