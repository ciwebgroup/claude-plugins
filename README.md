# CIWG Claude plugins

Private plugin repository for CI Web Group's internal Claude tooling.
Each release ships downloadable zips (no marketplace, no git access
needed) — staff get them from the synapse **AI Tools** page.

## Plugins

| Plugin | What it does | Get it |
|---|---|---|
| `ciwg-knowledge` | Company knowledge in Claude: auto-injected into Claude Code via hooks (zero retrieval tokens), a connector + skill for Claude Desktop / claude.ai / Cowork. Sign in once with CIWG SSO — no tokens, no env vars. | `ciwg-knowledge-<version>.zip` (Claude Code) / `ciwg-knowledge-desktop-<version>.zip` (Desktop) from [Releases](https://github.com/ciwebgroup/claude-plugins/releases) or the AI Tools page |

Each plugin's README has the three-step install for both surfaces and the
admin notes.

## Developers

```
npm test            # node --test, no dependencies
npm run package     # builds dist/*.zip + release.json + SHA256SUMS
```

Marketplace install (needs GitHub access to this private repo):

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install ciwg-knowledge@ciwg
```

Releases: bump `version` in `plugins/<plugin>/.claude-plugin/plugin.json`,
merge to `main` — `.github/workflows/release.yml` tests, packages and
creates the GitHub Release `ciwg-knowledge-v<version>`.
