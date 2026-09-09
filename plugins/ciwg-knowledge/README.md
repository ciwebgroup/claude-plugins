# ciwg-knowledge

Company knowledge, injected — not fetched. This plugin wires CIWG's
knowledge engine into Claude Code so that **retrieval happens outside the
model**: hooks query the knowledge API before Claude sees your prompt and
inject compact, source-cited snippets. The model spends zero tokens and
zero reasoning deciding whether or how to look something up.

Ingested sources today: call transcripts, chat logs, Fathom meetings.
Helpdesk tickets, internal team chat, and org notes light up automatically
as their ingestion ships (ci-connect PR #780) — no plugin update needed.

Requires Node ≥ 18 (global `fetch`). No npm install, no dependencies.

## Onboarding — three steps, no tokens

1. Install the plugin:
   ```
   /plugin marketplace add ciwebgroup/claude-plugins
   /plugin install ciwg-knowledge@ciwg
   ```
2. Type `/ciwg-login`. Your browser opens the CIWG SSO sign-in
   (Authentik); log in with your CIWG account. The terminal reports
   `Signed in as you@ciwebgroup.com — company knowledge is connected`.
3. Done. Knowledge starts flowing from your next prompt. When the
   sign-in ever expires or is revoked, a session will tell you once to run
   `/ciwg-login` again — that is the only maintenance there is.

`/ciwg-logout` signs out (revokes the cached refresh token, deletes the
local sign-in). `node scripts/login.mjs --status` shows who is signed in.

**Working over SSH or in a container without a browser?** Type
`/ciwg-login device` (or run `node scripts/login.mjs --device` in a
terminal): it prints a short URL and a code you open on any device — phone
included — and waits for your approval. Requires the admin to have enabled
the device-code flow in Authentik (see "Authentik configuration" below).

## What you get

| Surface | When it fires | What it does |
|---|---|---|
| `UserPromptSubmit` hook | every substantive prompt | Searches the knowledge API with your prompt; injects up to 3 relevant snippets (score-gated — quiet prompts inject nothing), plus a compact "team activity today" tail (Engram, see below) |
| `SessionStart` hook | opening/resuming a session (never after compaction) | Nudges you once to sign in if you never have (one line, at most once a day); otherwise injects a short client brief in client-mapped repos — requires BOTH `organizationId` and `clientName` in the mapping (the org id server-side-filters the search so a name match can never surface another client's data) — and today's Engram team activity (org-filtered when mapped, else filtered to this git repo's name) |
| `SessionEnd` hook | closing a session in a git repo or client-mapped directory | Posts a small STRUCTURED activity digest (Engram) so teammates' sessions know what you worked on — see "Engram" below |
| MCP tools (remote) | when you or Claude explicitly ask | `search_company_knowledge`, `get_source_artifacts` for deep dives — served by `https://api.ciwebgroup.com/mcp`, which Claude Code signs in to with the same CIWG SSO |
| `/ciwg-login`, `/ciwg-logout` | when you type them | Sign in / out of company knowledge for the hooks |

Fail-open by design: not signed in, API down, timeout → the hooks stay
silent and your session is unaffected. The only thing a hook ever *says*
is a single "run /ciwg-login" line, and it says it once.

## How sign-in works

Two credentials are involved, because two different programs talk to the
knowledge engine:

**The MCP server** (explicit tools) is remote — `plugin.json` declares an
HTTP server with an `oauth` block naming the public client
`ciwg-knowledge`, the scopes, and Authentik's discovery document. Claude
Code performs that OAuth 2.0 sign-in itself: the server answers `401` with
a `WWW-Authenticate … resource_metadata=…` pointer, Claude Code discovers
the authorization server, opens the browser, stores and refreshes the token,
and flags the server in `/mcp` (**Re-authenticate**) when a refresh is
rejected. Nothing in this plugin's scripts touches that flow.

**The hooks** call the REST API (`/api/v1/knowledge/*`,
`/api/v1/engram/*`) from short-lived Node processes, so they need their
own credential. `/ciwg-login` runs `scripts/login.mjs`, an OAuth 2.1
client written against node:crypto + node:http + fetch (no dependencies):

- **Primary flow — Authorization Code + PKCE with a loopback redirect.**
  A temporary listener is bound to `127.0.0.1` on a random port; the
  browser is opened at Authentik's authorize endpoint with
  `code_challenge` (S256) and a random `state`; the listener accepts one
  state-matched `/callback`, exchanges the code (with the PKCE verifier,
  no client secret — public client) and shuts down. Mismatched state is
  answered `400` and ignored; the whole thing times out after 3 minutes.
- **Fallback — Device Authorization Grant (RFC 8628)** for SSH/headless
  sessions (auto-detected via `SSH_CONNECTION`/no `DISPLAY`, or forced with
  `--device`). Polls the token endpoint honouring `interval` and
  `slow_down`. `--device-start` / `--device-finish` split the flow for
  runners that cannot show output while waiting (that is what the slash
  command uses).
- **Storage.** `~/.ciwg/auth.json`, mode `0600` in a `0700` directory
  (NTFS ignores the mode; `%USERPROFILE%` is user-private by default):
  access token + expiry, refresh token, the token/revocation endpoints,
  and your email for `--status`. The id_token is not stored.
- **Every hook run:** use the cached access token if it is still valid
  (30 s skew); otherwise refresh it silently. Authentik *rotates* refresh
  tokens, so concurrent hooks coordinate through a lock directory and
  re-read the cache before declaring a token dead. If the refresh is
  rejected (`invalid_grant`: user deactivated, token revoked or expired)
  the tokens are dropped, the next hook injects the one-line "run
  /ciwg-login" nudge (once per session), and everything else stays silent.
  Transient failures (IdP unreachable, 5xx) keep the tokens and trip the
  same 60 s backoff as an API network failure.
- **Never printed, never logged:** access/refresh tokens, the
  authorization code, the device code, the PKCE verifier. Set
  `CIWG_KNOWLEDGE_DEBUG=1` for stderr traces that name error *codes* only.

**Removing someone from Authentik** deletes their refresh tokens
immediately (Authentik's `user_deactivated` signal); their remaining
access token lives at most its configured validity (10–15 min, see below),
so access is cut within minutes with no plugin involvement.

Overrides for staging/local IdPs: `CIWG_OIDC_ISSUER` (default
`https://auth.ciwebgroup.com/application/o/ciwg-knowledge/`) and
`CIWG_OIDC_CLIENT_ID` (default `ciwg-knowledge`) — hooks and login script
only; the MCP server's issuer is pinned in `plugin.json`.

## Legacy API tokens (CI, service use) — still supported, deprecated for people

A `route:knowledge` API token (synapse admin → API tokens) still works and
**takes precedence** over an SSO sign-in whenever it is present:

- `CIWG_KNOWLEDGE_TOKEN` in the environment, or
- `~/.ciwg/knowledge.json`: `{ "token": "<token>" }`

It is sent as `X-API-Token`, exactly as before. Keep using it for CI
pipelines, service accounts and unattended machines — there is no browser
there. For humans, remove it and use `/ciwg-login` (the login script warns
when a legacy token is shadowing SSO).

Deprecation path: 0.2 — both work, legacy wins (this release). 0.3 — a
one-time notice when a legacy token is used interactively. 1.0 — the
legacy path is removed from the hooks; service use moves to a dedicated
service-account flow on the API side.

## Other setup (all optional)

- **API base** — defaults to `https://api.ciwebgroup.com`; override with
  `CIWG_KNOWLEDGE_URL` (e.g. staging, or a local tunnel). Hooks and local
  fallback server only; the remote MCP URL is pinned in `plugin.json`.
- **Client mapping** (per repo) — drop a `.ciwg-client.json` at the project
  root to scope retrieval to that client and enable the session brief:

  ```json
  { "organizationId": 7, "clientName": "Acme HVAC" }
  ```

- **Tuning** — `CIWG_KNOWLEDGE_MIN_SCORE` (default `0.35`, clamped to 0–1)
  raises/lowers the injection relevance floor.
- **Troubleshooting** — `node scripts/login.mjs --status` first. Then
  `CIWG_KNOWLEDGE_DEBUG=1` for stderr traces from the hooks ("sign-in
  expired" vs. "unreachable API" vs. "genuinely no relevant hits" are
  otherwise indistinguishable by design — the hot path never prints).
  After a network failure the hooks back off for 60 s. If `/ciwg-login`
  cannot bind a local port or open a browser from inside Claude Code
  (sandboxed shells), run `node <plugin-root>/scripts/login.mjs` from a
  normal terminal — the result is the same file.

## Fallback: local stdio MCP server

The remote MCP server is the supported surface. If it is unreachable from
where you work (network policy, an outage), the previous local server is
still shipped and speaks the same REST API with the hooks' credential (SSO
sign-in or legacy token). Register it by hand:

```
claude mcp add ciwg-knowledge-local -- node "<plugin-root>/scripts/knowledge-mcp.mjs"
```

`<plugin-root>` is where Claude Code installed the plugin (shown by
`/plugin`). Remove it again with `claude mcp remove ciwg-knowledge-local`.

## Engram — shared daily working memory

The knowledge engine is the team's long-term memory; **Engram is the
short-term layer**: when your Claude Code session ends, the `SessionEnd`
hook posts a small activity digest to `/api/v1/engram/activities`, and
other staff members' sessions see today's relevant digests injected —
`[engram 16:12 UTC, 4m ago] braedn — acme-hvac repo, branch checkout-fix,
14 files`. At UTC day close the server distills each day's activity into
the knowledge store (source type `engram-day`) and clears raw entries
after a short retention (`ENGRAM_RETENTION_DAYS`, default 3).

**What a digest contains — structured facts ONLY:** git branch, repo
basename (git toplevel — scratch directories post nothing), change counts
from `git status`/`git diff --shortstat`, up to 5 changed paths, the
`.ciwg-client.json` mapping, and a duration estimate taken from the
transcript file's *creation-time metadata*. The hook **never reads or
transmits the session transcript, conversation text, or prompt text**, and
the server enforces the same rule with a closed payload-key whitelist and
hard length clamps. Trivial sessions (no changes, under two minutes) are
not posted.

**Opt out of publishing** your activity with either:

- `CIWG_ENGRAM=off` (also accepts `0` / `false`) in your environment, or
- `"engram": false` in `~/.ciwg/knowledge.json`

The opt-out stops the *write* side; injected team activity from colleagues
still appears (it is ordinary staff-gated knowledge). Engram uses the same
credential and the same fail-open + 60s network-backoff discipline as the
rest of the plugin — not signed in or API down means the hooks stay silent
and your session (and its exit) is unaffected.

## Privacy & trust notes

- Everything served is **internal-staff** data; the API enforces the
  staff gate server-side on the SSO identity (or the legacy token's
  creator) — this plugin adds no access the account doesn't already have.
- `~/.ciwg/auth.json` is a credential: treat it like an SSH key. `/ciwg-logout`
  revokes and deletes it; deactivating the account in Authentik kills it
  remotely.
- Injected snippets are labelled `auto-retrieved` and carry source pointers
  (`helpdesk-ticket:42#3`); Claude is instructed to cite and verify rather
  than assert them as current truth.
- Prompts are sent to the knowledge API as search queries (internal
  infrastructure). Slash commands, bash-mode (`!`), and very short prompts
  are never sent. Query text travels in the URL query string, so a
  server-side error can land prompt text in the API's error logs —
  internal logs, but worth knowing.
- Injected snippets are framed as untrusted quoted DATA: Claude is
  explicitly told never to follow instructions that appear inside
  retrieved content (transcripts and tickets contain text written by
  customers and outsiders). Engram team-activity lines ride inside the
  same framing.
- Engram digests are structured facts, never conversation text — see the
  Engram section above for exactly what leaves your machine.

## Authentik configuration (admin)

**One** OAuth2/OpenID provider + application serves all three clients —
the claude.ai/Desktop connector, Claude Code's built-in MCP OAuth, and the
hooks' `login.mjs`. The API validates the token's `aud` against its own
`MCP_OAUTH_CLIENT_ID`, so the plugin's client id **must be that same
application's client id** and the issuer that application's slug. The
plugin defaults to slug/client id `ciwg-knowledge`; if the application is
named differently, either rename it or set `CIWG_OIDC_ISSUER` /
`CIWG_OIDC_CLIENT_ID` for the hooks and edit the `oauth` block in
`plugin.json` for the MCP server (both are pinned there on purpose).

Settings, assuming slug `ciwg-knowledge`:

| Setting | Value | Why |
|---|---|---|
| Client type | **Public** | Both clients (Claude Code's built-in OAuth and `login.mjs`) run on laptops — no secret can be kept; PKCE protects the code |
| Client ID | `ciwg-knowledge` | Pinned in `plugin.json` and `auth.mjs` (`CIWG_OIDC_CLIENT_ID` overrides for the hooks) |
| Redirect URIs | strict `https://claude.ai/api/mcp/auth_callback` (the web/Desktop connector) **plus** **regex** `http://localhost:\d+/callback` **and** regex `http://127\.0\.0\.1:\d+/callback` | Claude Code's native OAuth redirects to `http://localhost:PORT/callback` on a random port; `login.mjs` binds `127.0.0.1` and redirects there (RFC 8252 loopback). Authentik strict matching cannot express a random port |
| Scopes / property mappings | `openid`, `profile`, `email`, **`offline_access`** (Authentik's default `profile` mapping already emits the `groups` claim; a dedicated `groups` mapping is optional — Authentik ignores a requested scope that has no mapping) | `offline_access` is what makes Authentik issue a refresh token (2024.2+); `groups` lets the API apply the staff gate |
| Access token validity | `minutes=10` … `minutes=15` | This bounds how long a deactivated user keeps access (default is `hours=1` — too long) |
| Refresh token validity | e.g. `days=30` | Long-lived; the user re-logs in when it lapses. Deactivation deletes it immediately |
| Signing key | set (RS256) | Access tokens must be JWTs the API can verify offline (`CIWG_OIDC_ISSUER` on the server) |
| Device code flow (optional, for SSH users) | Create a flow with designation **Stage Configuration** and set it as the brand's **Default code flow** (System → Brands) | Authentik ships no default; without it `/ciwg-login device` fails with a clear message and the browser flow still works |
| Users | staff group only, via the application's policy bindings | Removal from the group / deactivation = access ends within one access-token lifetime |

Claude Code's OAuth needs no dynamic client registration (Authentik's DCR
requires a pre-issued bearer token anyway): the plugin pre-configures the
client id and points `authServerMetadataUrl` straight at
`https://auth.ciwebgroup.com/application/o/ciwg-knowledge/.well-known/openid-configuration`.

## Tests

`node --test plugins/ciwg-knowledge/tests/engram.test.mjs plugins/ciwg-knowledge/tests/auth.test.mjs`

- `engram.test.mjs` — digest construction against a throwaway git repo,
  the opt-out switches, the no-credential fail-open, injection rendering.
- `auth.test.mjs` — PKCE, discovery, the token cache and silent refresh
  against a mocked token endpoint (rotation, expiry skew, `invalid_grant`
  → relogin, transient failures, in-process dedupe, the cross-process
  lock), legacy-token precedence, the loopback flow end to end (a real
  `127.0.0.1` listener with state probing, single-shot, timeout, error
  callback), the device flow (`slow_down`, deferred start/finish, denied /
  expired / not enabled), logout, the hint markers, and the hooks run as
  real processes (nudge once, then silence).

No network is touched — every call goes through an injected `fetchImpl` —
and `~/.ciwg` is redirected to a temp dir for the run.
