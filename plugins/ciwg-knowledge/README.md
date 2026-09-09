# ciwg-knowledge

Company knowledge, injected — not fetched. This plugin wires CIWG's
knowledge engine into Claude: in **Claude Code**, hooks query the knowledge
API before Claude sees your prompt and inject compact, source-cited
snippets (the model spends zero tokens deciding whether to look something
up); in **Claude Desktop / claude.ai / Cowork**, the bundled connector and
a skill make Claude search company knowledge first and cite its sources.

Ingested sources today: call transcripts, chat logs, Fathom meetings.
Helpdesk tickets, internal team chat and org notes light up automatically
as their ingestion ships — no plugin update needed.

**No tokens, no environment variables.** You sign in with your normal CIWG
SSO login (Authentik, MFA included), once. Access is tied to your staff
membership and ends within minutes of removal from Authentik.

## Install — two paths, three steps each

Get the zip for your Claude from the synapse **AI Tools** page (staff
sign-in) — it always serves the latest release — or from this repo's
[Releases](https://github.com/ciwebgroup/claude-plugins/releases).

### Claude Desktop, claude.ai, Cowork → `ciwg-knowledge-desktop-<version>.zip`

1. Open **Customize → Plugins → Add plugin → Upload plugin** and choose the
   zip (Claude accepts `.zip` only).
2. Open the installed plugin, find the **CIWG Knowledge** connector and
   click **Connect**. Sign in with CIWG SSO and approve access.
3. Done. Ask about a client, a meeting or a decision — Claude searches
   company knowledge first and cites `[source]` pointers.

### Claude Code (terminal, or the desktop app's Code tab) → `ciwg-knowledge-<version>.zip`

Needs Node.js ≥ 18 on your `PATH` (the hooks and the local server run with
`node`; nothing to `npm install`).

1. Unzip into your personal skills folder — it auto-loads, no install step:
   - macOS / Linux: `unzip -o ~/Downloads/ciwg-knowledge-<version>.zip -d ~/.claude/skills/ciwg-knowledge`
   - Windows (PowerShell): `Expand-Archive -Force "$HOME\Downloads\ciwg-knowledge-<version>.zip" "$HOME\.claude\skills\ciwg-knowledge"`
2. Start (or restart) Claude Code. The first session opens the CIWG SSO
   sign-in in your browser by itself — finish it there.
3. Done. Knowledge starts flowing from your next prompt.

Alternatives for Claude Code: `claude --plugin-dir ~/Downloads/ciwg-knowledge-<version>.zip`
loads the zip for one session; developers with GitHub access to this repo
can use the marketplace instead (updates arrive with `/plugin update`):

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install ciwg-knowledge@ciwg
```

Updating a zip install: unzip the new version over the same folder (the
plugin's own `version` in `plugin.json` is what Claude Code reads).

## What you'll see

- **First prompt (Claude Code):** one line — *Opening CIWG sign-in in your
  browser to connect company knowledge…* — and the SSO page opens once. If
  it did not open, the line carries the link. Nothing blocks; sign in and
  carry on. The browser opens at most once a day, never over SSH/CI, and
  not when you have opted out (below). `/ciwg-login` is the manual path.
- **First use (Desktop / claude.ai):** the connector's **Connect** button
  once; the sign-in page opens in the browser.
- **Re-sign-in:** only when Authentik says so — your CIWG session expired
  (refresh token lapsed, default 30 days) or an admin removed your access.
  In Claude Code the next session opens the sign-in again by itself (once
  a day); in Desktop the connector shows **Connect** again.
- **Nothing else.** No tokens to paste, nothing to rotate, nothing to
  clean up when someone leaves.

## What runs where (verified against Anthropic's docs, 2026-09-09)

| Component | Claude Code | Claude Desktop chat / claude.ai | Cowork |
|---|---|---|---|
| Hooks (auto-injection before each prompt, session brief, engram) | yes | **no** — "Hooks and sub-agents run only in Cowork, so they appear grayed out in chat" ([Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)) | yes, inside the Cowork VM |
| Local stdio MCP server (`scripts/knowledge-mcp.mjs`, `node`) | yes | **no** — a plugin's local server never runs in chat; Desktop plugins declare connectors in `.mcp.json` as `http`/`sse` only ([Claude Desktop extensions reference](https://claude.com/docs/third-party/claude-desktop/extensions)) | not relied on |
| Remote SSO connector (`https://api.ciwebgroup.com/mcp`) | optional (`claude mcp add`, needs the `localhost` redirect regex) | **yes** — bundled in the Desktop zip's `.mcp.json` | yes |
| `company-knowledge` skill | yes | yes | yes |
| `/ciwg-login`, `/ciwg-logout` | yes | n/a (Connect / Disconnect on the connector) | n/a |

That is why one source builds two zips (`npm run package`): the Claude
Code zip is the plugin as-is; the Desktop zip carries the remote connector
plus the skill and nothing that cannot run there. Upload accepts `.zip`
only ("choose the plugin's `.zip` file" — [Plugins in Claude Desktop](https://claude.com/docs/government/desktop/plugins);
the plugin must sit at the archive root with `.claude-plugin/plugin.json`,
a single wrapping folder tolerated). Claude Code's `claude plugin install`
takes marketplace names only; a local zip loads via `--plugin-dir` or by
living under `~/.claude/skills/` ([Plugins reference](https://code.claude.com/docs/en/plugins-reference)).

## What you get (Claude Code)

| Surface | When it fires | What it does |
|---|---|---|
| `SessionStart` hook | opening/resuming a session (never after compaction) | Opens the SSO sign-in by itself when there is none (once a day, see above); refreshes a sign-in that is about to expire; injects a short client brief in client-mapped repos — requires BOTH `organizationId` and `clientName` in the mapping — and today's Engram team activity (org-filtered when mapped, else filtered to this git repo's name) |
| `UserPromptSubmit` hook | every substantive prompt | Searches the knowledge API with your prompt; injects up to 3 relevant snippets (score-gated — quiet prompts inject nothing), plus a compact "team activity today" tail (Engram) |
| `SessionEnd` hook | closing a session in a git repo or client-mapped directory | Posts a small STRUCTURED activity digest (Engram) so teammates' sessions know what you worked on — see "Engram" below |
| MCP tools | when you or Claude explicitly ask (the skill says when) | `search_company_knowledge`, `get_source_artifacts` — a local stdio server that uses the same sign-in as the hooks; a tool call without a sign-in opens the browser sign-in itself and answers "finish signing in, then ask again" |
| `company-knowledge` skill | model-invoked | Tells Claude to search company knowledge before answering client/meeting questions and to cite sources |
| `/ciwg-login`, `/ciwg-logout` | when you type them | Manual sign-in / sign-out |

Fail-open by design: not signed in, API down, timeout → the hooks stay
silent and your session is unaffected.

## How sign-in works

**One credential, one sign-in.** Every part of the plugin — the three
hooks and the `ciwg-knowledge` MCP server — sends the Authentik access
token to the REST API (`/api/v1/knowledge/*`, `/api/v1/engram/*`) as
`Authorization: Bearer`. The OAuth 2.1 client is written against
node:crypto + node:http + fetch (no dependencies).

- **Automatic sign-in (new in 0.3).** When a session starts without a
  credential, the `SessionStart` hook spawns a detached
  `login.mjs --auto`, waits up to ~2.5 s for it to publish the authorize
  URL (`~/.ciwg/auto-login.json`, pid-checked so two sessions never open
  two browsers), tells you *Opening CIWG sign-in…* (with the link) and
  returns; the child owns the loopback listener and finishes the flow.
  The MCP server does the same in-process on a tool call. Cadence: once
  a day per machine (`~/.ciwg/state.json` `auto_login_at`); a sign-out
  holds it for a day too. Never on SSH/headless/CI. Opt out with
  `CIWG_AUTO_LOGIN=off` or `"autoLogin": false` in `~/.ciwg/knowledge.json`
  — then the old one-line "run /ciwg-login" nudge is all you see.
  `CIWG_KNOWLEDGE_NO_BROWSER=1` keeps the flow but never launches a
  browser (the link is shown instead).
- **Primary flow — Authorization Code + PKCE with a loopback redirect.**
  A temporary listener is bound to `127.0.0.1` on a random port; the
  browser is opened at Authentik's authorize endpoint with
  `code_challenge` (S256) and a random `state`; the listener accepts one
  state-matched `/callback`, exchanges the code (with the PKCE verifier,
  no client secret — public client) and shuts down. Mismatched state is
  answered `400` and ignored; the whole thing times out after 3 minutes.
  On Windows the browser is launched through `rundll32
  url.dll,FileProtocolHandler <url>` — never `cmd.exe /c start`.
- **Headless/SSH — Device Authorization Grant (RFC 8628).** Auto-detected
  via `SSH_CONNECTION`/`SSH_TTY`, `CI`, or no `DISPLAY` on Linux (or forced
  with `--device`). `/ciwg-login` prints the verification URL and user
  code and **returns at once** (`DEVICE_CODE_PENDING`); `--device-finish`
  then polls the token endpoint and stores the tokens. In a real terminal,
  `node scripts/login.mjs --device` does both in one go. Requires the
  admin to have enabled the device-code flow in Authentik (below).
- **Storage — `~/.ciwg` (directory `0700`).** `auth.json` (`0600`): access
  token + expiry, refresh token, the token/revocation endpoints, your
  email — nothing else, the id_token is not stored. `state.json`:
  non-secret plugin state (hint cadence, auto-login cadence, why a sign-in
  was dropped, backoff timestamps). `auth-pending.json` (`0600`): a device
  code between start and finish. `auto-login.json`: the running automatic
  sign-in (pid + authorize URL). `auth.lock`: the refresh lock.
- **Every hook run:** cached access token if valid (30 s skew), else a
  silent refresh under a cross-process lock (Authentik rotates refresh
  tokens). Only an OAuth `invalid_grant` is terminal: the tokens are
  dropped and the next session opens the sign-in again (once a day).
  Anything else — IdP unreachable, 5xx — keeps the tokens and backs off
  for 60 s.
- **Time budget.** Each hook has 6 s (`hooks.json`); the scripts work to a
  5 s deadline, and the auto-login wait is carved out of what is left.
- **Never printed, never logged:** access/refresh tokens, the
  authorization code, the device code, the PKCE verifier.

**Issuer and client id** default to
`https://sso.ciwgserver.com/application/o/ciwg-knowledge/` and
`lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1` (the Authentik-generated
*Client ID* of that provider — not the slug). `CIWG_OIDC_ISSUER` /
`CIWG_OIDC_CLIENT_ID` override them for a staging IdP. The API base
defaults to `https://api.ciwebgroup.com` (`CIWG_KNOWLEDGE_URL` overrides).
Nothing needs to be set for production.

## Legacy API tokens (CI, service use)

A `route:knowledge` API token still works and **takes precedence** over an
SSO sign-in whenever it is present — `CIWG_KNOWLEDGE_TOKEN` in the
environment, or `~/.ciwg/knowledge.json` `{ "token": "<token>" }` — sent as
`X-API-Token`. Keep it for CI pipelines and unattended machines; humans
should remove it (the automatic sign-in never runs while one is set).

## Other setup (all optional)

- **Client mapping** (per repo) — `.ciwg-client.json` at the project root
  scopes retrieval to that client and enables the session brief:
  `{ "organizationId": 7, "clientName": "Acme HVAC" }`
- **Tuning** — `CIWG_KNOWLEDGE_MIN_SCORE` (default `0.35`).
- **Troubleshooting** — `node scripts/login.mjs --status` says whether you
  are signed in, whether the token is valid, whether a legacy token is
  shadowing SSO, why a sign-in was dropped, whether the API rejected the
  token, and what the automatic sign-in last did. `CIWG_KNOWLEDGE_DEBUG=1`
  adds stderr traces. If the automatic sign-in cannot bind a local port or
  open a browser, `/ciwg-login` prints the link; from a normal terminal,
  `node <plugin-root>/scripts/login.mjs` is the same thing.

## Engram — shared daily working memory

The knowledge engine is the team's long-term memory; **Engram is the
short-term layer**: when your Claude Code session ends, the `SessionEnd`
hook posts a small activity digest, and other staff members' sessions see
today's relevant digests injected. **Structured facts ONLY:** git branch,
repo basename, change counts, up to 5 changed paths, the client mapping,
and a duration estimate. The hook **never reads or transmits the session
transcript, conversation text, or prompt text**. Opt out of publishing
with `CIWG_ENGRAM=off` or `"engram": false` in `~/.ciwg/knowledge.json`.

## Privacy & trust notes

- Everything served is **internal-staff** data; the API enforces the
  staff gate server-side — this plugin adds no access the account doesn't
  already have.
- `~/.ciwg/auth.json` is a credential: treat it like an SSH key.
  `/ciwg-logout` revokes and deletes it; deactivating the account in
  Authentik kills it remotely.
- Injected snippets are labelled `auto-retrieved`, carry source pointers,
  and are framed as untrusted quoted DATA: Claude is told never to follow
  instructions that appear inside retrieved content.
- Prompts are sent to the knowledge API as search queries (internal
  infrastructure). Slash commands, bash-mode (`!`) and very short prompts
  are never sent.

## Authentik configuration (admin, one-time)

**One** OAuth2/OpenID provider + application on `https://sso.ciwgserver.com`,
slug `ciwg-knowledge`, serves everything: the Desktop/claude.ai connector,
this plugin's automatic and manual sign-in, and (optionally) Claude Code's
built-in MCP OAuth.

| Setting | Value | Why |
|---|---|---|
| Client type | **Public** | Laptops and browsers cannot keep a secret; PKCE protects the code |
| Client ID | `lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1` | Auto-generated by Authentik; the plugin default and the API's expected audience |
| Redirect URIs | **strict** `https://claude.ai/api/mcp/auth_callback`, **strict** `https://claude.com/api/mcp/auth_callback`, **regex** `^http://127\.0\.0\.1(:\d+)?/callback$` | The strict entries are the hosted Claude callbacks (Desktop / claude.ai connector); **the regex is the only entry this plugin's sign-in needs** — the loopback listener binds `127.0.0.1` on a random port (RFC 8252). Regex mode, escaped dots, anchored. Add regex `^http://localhost:\d+/callback$` only if someone uses Claude Code's native OAuth for the remote connector |
| Scopes | `openid`, `profile`, `email`, **`offline_access`** | `offline_access` makes Authentik issue a refresh token; `profile` carries `groups` for the staff gate |
| Access token validity | `minutes=10…15` | Bounds how long a deactivated user keeps access |
| Refresh token validity | e.g. `days=30` | The user re-signs in when it lapses; deactivation deletes it immediately |
| Signing key | RS256 certificate | Access tokens must be JWTs the API can verify offline |
| Device code flow (optional, SSH users) | a flow with designation **Stage Configuration** set as the brand's **Default code flow** | Without it `/ciwg-login device` fails with a clear message; the browser flow still works |
| Users | staff group only, via the application's policy bindings | Removal = access ends within one access-token lifetime |

Version note: the per-entry strict/regex selector exists on Authentik
2024.8.5+ / 2024.10.3+ / 2024.12.x (the CIWG instance runs 2024.12.3);
re-check the loopback entry's mode after any upgrade.

Server side (ci-connect): the REST API and `/mcp` accept this
application's tokens (issuer + audience above) — `MCP_OAUTH_ISSUER` /
`MCP_OAUTH_CLIENT_ID` on web-services, `OIDC_VERIFY_SIGNATURE=1`.

## Packaging & releases

`npm run package` (Node only, no dependencies) builds `dist/`:
`ciwg-knowledge-<version>.zip`, `ciwg-knowledge-desktop-<version>.zip`,
`release.json`, `SHA256SUMS` — deterministic (same commit → same bytes).
Pushing to `main` with a new `version` in `.claude-plugin/plugin.json`
creates the GitHub Release `ciwg-knowledge-v<version>` with those assets
(`.github/workflows/release.yml`); the synapse AI Tools page serves them
through web-services (`GET /api/v1/knowledge/plugin-package?target=desktop|code`,
staff-gated, using a read-only GitHub token because this repo is private).

## Tests

`npm test` — or `node --test` with the four files under `tests/`:

- `engram.test.mjs` — digest construction, opt-outs, fail-open, rendering.
- `auth.test.mjs` — PKCE, discovery, the token cache and silent refresh,
  the lock, the hook time budget, legacy-token precedence, the loopback
  and device flows end to end, logout, the hint cadence, the hooks as real
  processes (hint path).
- `autologin.test.mjs` — the automatic sign-in: decision rules (signed in
  / opted out / headless / once a day / already running), the in-process
  background login, the detached child, the SessionStart hook as a real
  process (opens once, tells the user, stays inside its budget even with a
  hung IdP, silent afterwards), the MCP server as a real process (friendly
  message in ~2 s, then works after the sign-in).
- `package.test.mjs` — both zips have the structure each surface expects,
  metadata files agree, rebuilds are byte-identical, the CLI works.

No network is touched — every call goes to a `127.0.0.1` server the test
owns — no real browser is launched, and `~/.ciwg` is redirected to a temp
dir for the run.
