# CIWG Claude plugins

Private plugin repository for CI Web Group's internal Claude tooling.
Each release ships downloadable zips (no marketplace, no git access
needed) — staff get them from the synapse **AI Tools** page.

## Plugins

| Plugin | What it does | Get it |
|---|---|---|
| `ciwg-knowledge` | Company knowledge in Claude: auto-injected into Claude Code via hooks (zero retrieval tokens); a remote connector + skill for Claude Cowork (plugin upload) and for claude.ai / Claude Desktop chat (as a custom connector — whether the plugin upload itself works in chat is unverified, see the plugin README). Sign in once with CIWG SSO — no tokens, no env vars. | `ciwg-knowledge-<version>.zip` (Claude Code) / `ciwg-knowledge-desktop-<version>.zip` (Cowork) from [Releases](https://github.com/ciwebgroup/claude-plugins/releases) or the AI Tools page |

Each plugin's README has the three-step install for each surface and the
admin notes.

## Developers

```
npm test            # node --test, no dependencies (hermetic: passes with CIWG_AUTO_LOGIN=off exported)
npm run package     # builds dist/*.zip + release.json + SHA256SUMS
```

Digests are reproducible on the same Node major only (zlib differs between
Node lines); CI builds on Node 22. A local zip loads for one session with
`claude --plugin-dir <zip>` or `claude --plugin-url <zip url>`.

Marketplace install (needs GitHub access to this private repo):

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install ciwg-knowledge@ciwg
```

Releases: bump `version` in `plugins/<plugin>/.claude-plugin/plugin.json`,
merge to `main` — `.github/workflows/release.yml` tests, packages and
creates the GitHub Release `ciwg-knowledge-v<version>` (the test job runs
PR code with a read-only token; only the release job can write).
