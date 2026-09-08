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
| `ciwg-knowledge` | Auto-injects relevant company knowledge (Fathom meetings, helpdesk tickets, team chat, org notes) into Claude's context via hooks — the model never spends tokens or reasoning on retrieval. Also ships explicit MCP search tools. |

Each plugin's README covers its own setup (auth token, environment).
