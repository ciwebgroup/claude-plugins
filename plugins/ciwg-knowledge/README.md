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

> **Server dependency.** SSO sign-in needs the ci-connect change that makes
> the REST API (`/api/v1/knowledge/*`, `/api/v1/engram/*`) accept an
> Authentik access token for the `ciwg-knowledge` app as
> `Authorization: Bearer` (feat/mcp-oauth-connector and its follow-up).
> Until that is **deployed**, an SSO sign-in succeeds but the API answers
> 401: the hooks stay silent apart from one actionable line per session
> ("the knowledge API rejected the sign-in token…"), `login.mjs --status`
> says so, and legacy API tokens keep working unchanged. Do not merge this
> plugin version ahead of that deploy unless that behaviour is acceptable.

## Onboarding — three steps, no tokens

1. Install the plugin:
   ```
   /plugin marketplace add ciwebgroup/claude-plugins
   /plugin install ciwg-knowledge@ciwg
   ```
2. Type `/ciwg-login`. Your browser opens the CIWG SSO sign-in
   (Authentik); log in with your CIWG account. The terminal reports
   `Signed in as you@ciwebgroup.com — company knowledge is connected`.
3. Done. Knowledge starts flowing from your next prompt, and the
   `ciwg-knowledge` MCP tools use the same sign-in. When it ever expires
   or is revoked, a session will tell you once to run `/ciwg-login` again —
   that is the only maintenance there is.

`/ciwg-logout` signs out (revokes the cached refresh token, deletes the
local sign-in). `node scripts/login.mjs --status` shows who is signed in.

**Working over SSH or in a container without a browser?** `/ciwg-login`
detects it and prints a short URL and a code **immediately** — open the
URL on any device (phone included), enter the code, and the sign-in
finishes with `--device-finish` (the slash command does this for you). In
a real terminal, `node scripts/login.mjs --device` does the same in one
go. Requires the admin to have enabled the device-code flow in Authentik
(see "Authentik configuration" below).

## What you get

| Surface | When it fires | What it does |
|---|---|---|
| `UserPromptSubmit` hook | every substantive prompt | Searches the knowledge API with your prompt; injects up to 3 relevant snippets (score-gated — quiet prompts inject nothing), plus a compact "team activity today" tail (Engram, see below) |
| `SessionStart` hook | opening/resuming a session (never after compaction) | Nudges you once to sign in if you never have (one line, at most once a day); refreshes a sign-in that is about to expire; otherwise injects a short client brief in client-mapped repos — requires BOTH `organizationId` and `clientName` in the mapping (the org id server-side-filters the search so a name match can never surface another client's data) — and today's Engram team activity (org-filtered when mapped, else filtered to this git repo's name) |
| `SessionEnd` hook | closing a session in a git repo or client-mapped directory | Posts a small STRUCTURED activity digest (Engram) so teammates' sessions know what you worked on — see "Engram" below |
| MCP tools | when you or Claude explicitly ask | `search_company_knowledge`, `get_source_artifacts` for deep dives — a local stdio server (`scripts/knowledge-mcp.mjs`) that uses the same sign-in as the hooks |
| `/ciwg-login`, `/ciwg-logout` | when you type them | Sign in / out of company knowledge — one sign-in for hooks and tools |

Fail-open by design: not signed in, API down, timeout → the hooks stay
silent and your session is unaffected. The only thing a hook ever *says*
is a single "run /ciwg-login" line, and it says it once.

## How sign-in works

**One credential, one sign-in.** `/ciwg-login` runs `scripts/login.mjs`,
an OAuth 2.1 client written against node:crypto + node:http + fetch (no
dependencies), and everything in the plugin — the three hooks and the
`ciwg-knowledge` MCP server — sends the resulting Authentik access token
to the REST API (`/api/v1/knowledge/*`, `/api/v1/engram/*`) as
`Authorization: Bearer`.

- **Primary flow — Authorization Code + PKCE with a loopback redirect.**
  A temporary listener is bound to `127.0.0.1` on a random port; the
  browser is opened at Authentik's authorize endpoint with
  `code_challenge` (S256) and a random `state`; the listener accepts one
  state-matched `/callback`, exchanges the code (with the PKCE verifier,
  no client secret — public client) and shuts down. Mismatched state is
  answered `400` and ignored; the whole thing times out after 3 minutes.
  On Windows the browser is launched through `rundll32
  url.dll,FileProtocolHandler <url>` — never `cmd.exe /c start`, which
  expands `%XX%` sequences inside the percent-encoded redirect URI.
- **Headless/SSH — Device Authorization Grant (RFC 8628).** Auto-detected
  via `SSH_CONNECTION`/`SSH_TTY` or no `DISPLAY` on Linux (or forced with
  `--device`). Inside Claude Code the script prints the verification URL
  and user code and **returns at once** (`DEVICE_CODE_PENDING`), because a
  command running under the Bash tool cannot show you the code while it
  waits; `--device-finish` then polls the token endpoint (honouring
  `interval` and `slow_down`, riding through network blips, bounded by the
  code's own expiry) and stores the tokens. `--device-start` /
  `--device-finish` are the same two halves, explicitly.
- **Storage — four files in `~/.ciwg` (directory `0700`).**
  `auth.json` (`0600`): access token + expiry, refresh token, the
  token/revocation endpoints, and your email for `--status` — nothing
  else, the id_token is not stored. `state.json`: non-secret plugin state
  (hint cadence, why a sign-in was dropped, the 60 s backoff timestamps,
  an API-rejected marker). `auth-pending.json` (`0600`): a device code
  between `--device-start` and `--device-finish`. `auth.lock`: the refresh
  lock directory (holder pid inside). NTFS ignores the modes;
  `%USERPROFILE%` is user-private by default. "Not signed in" is simply the
  absence of `auth.json`; `state.json` remembers whether that is because
  you never signed in or because the sign-in was dropped.
- **Every hook run:** use the cached access token if it is still valid
  (30 s skew); otherwise refresh it silently. Authentik *rotates* refresh
  tokens, so concurrent hooks coordinate through the lock: a waiter never
  refreshes with a token a live sibling may be rotating (it uses the
  sibling's result or reports a transient failure), a lock whose holder
  process is gone is broken at once, and only the token a hook actually
  tried is ever tombstoned. Only an OAuth `invalid_grant` answer (user
  deactivated, token revoked or expired) is terminal: the tokens are
  dropped, the next hook injects the one-line "run /ciwg-login" nudge
  (once per session), and everything else stays silent. Anything else —
  IdP unreachable, 5xx, a proxy's HTML 400, `invalid_client` — keeps the
  tokens and backs the *sign-in server* off for 60 s (separate from the
  API's own 60 s backoff, so an IdP hiccup never silences lookups that
  still work). A rotated refresh token is persisted with retries and a
  plain-write fallback; it never dies with an exception.
- **Time budget.** Each hook has 6 s (`hooks.json`); the scripts work to a
  5 s deadline and size the lock wait, the refresh round-trip and the API
  call from what is left, so their sum can never exceed the hook timeout.
  `SessionStart` refreshes proactively when the token expires within
  5 minutes, so per-prompt hooks rarely pay for a refresh at all.
- **Never printed, never logged:** access/refresh tokens, the
  authorization code, the device code, the PKCE verifier. Set
  `CIWG_KNOWLEDGE_DEBUG=1` for stderr traces that name error *codes* only.

**Removing someone from Authentik** deletes their refresh tokens
immediately (Authentik's `user_deactivated` signal); their remaining
access token lives at most its configured validity (10–15 min, see below),
so access is cut within minutes with no plugin involvement.

**Issuer and client id.** The default issuer is
`https://sso.ciwgserver.com/application/o/ciwg-knowledge/` — the CIWG
Authentik instance, application slug `ciwg-knowledge`. The exact string is
whatever the provider's page in Authentik shows as *OpenID Configuration
Issuer*; `/ciwg-login` fetches
`<issuer>.well-known/openid-configuration` anonymously, so that URL must
answer 200 (it does for the default). The default client id is
`lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1` — the opaque *Client ID*
Authentik generated for that provider (it is **not** the slug; read it
off the provider page). If either differs from the default — a renamed
application, a re-created provider (Authentik mints a new client id), a
staging/local IdP — set `CIWG_OIDC_ISSUER` and/or `CIWG_OIDC_CLIENT_ID`.

## Remote connector (claude.ai, Claude Desktop — optional in Claude Code)

The knowledge engine also exposes a remote MCP server at
`https://api.ciwebgroup.com/mcp` with native OAuth (RFC 9728 resource
metadata → the same Authentik application). That is the path for
**claude.ai and Claude Desktop** connectors, where there are no hooks and
no plugin. Claude Code users get the same tools from this plugin's local
server on the `/ciwg-login` sign-in; those who prefer Claude Code's
built-in OAuth can add the remote server by hand instead:

```
claude mcp add --transport http ciwg-knowledge-remote https://api.ciwebgroup.com/mcp
```

That is a second, independent sign-in (Claude Code stores and refreshes
its own token, and flags the server in `/mcp` → **Re-authenticate** when
a refresh is rejected). Claude Code's native flow redirects to
`http://localhost:PORT/callback`, which is *not* in the baseline Authentik
redirect list below — an admin must add the regex
`^http://localhost:\d+/callback$` to the same application before this
optional path works.

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
  `CIWG_KNOWLEDGE_URL` (e.g. staging, or a local tunnel). Hooks and the
  local MCP server alike.
- **Client mapping** (per repo) — drop a `.ciwg-client.json` at the project
  root to scope retrieval to that client and enable the session brief:

  ```json
  { "organizationId": 7, "clientName": "Acme HVAC" }
  ```

- **Tuning** — `CIWG_KNOWLEDGE_MIN_SCORE` (default `0.35`, clamped to 0–1)
  raises/lowers the injection relevance floor.
- **Troubleshooting** — `node scripts/login.mjs --status` first: it says
  whether you are signed in, whether the token is valid, whether a legacy
  token is shadowing SSO, why a sign-in was dropped, and whether the API
  rejected the token (401 — the server may not trust this app yet). Then
  `CIWG_KNOWLEDGE_DEBUG=1` for stderr traces from the hooks ("sign-in
  expired" vs. "unreachable API" vs. "genuinely no relevant hits" are
  otherwise indistinguishable by design — the hot path never prints).
  After a network failure the hooks back off for 60 s (`~/.ciwg/state.json`
  holds the timestamps; deleting the file resets everything but the
  sign-in). If `/ciwg-login` cannot bind a local port or open a browser
  from inside Claude Code (sandboxed shells), run
  `node <plugin-root>/scripts/login.mjs` from a normal terminal — the
  result is the same file.

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

**One** OAuth2/OpenID provider + application on the CIWG Authentik
instance (`https://sso.ciwgserver.com`), slug `ciwg-knowledge`, serves
everything: the claude.ai / Claude Desktop connector, this plugin's
`login.mjs`, and (optionally) Claude Code's built-in MCP OAuth. The API
validates the token's issuer and audience against that application, so
the plugin's defaults **must** match it; if the application is named
differently or the provider is re-created (which mints a new client id),
set `CIWG_OIDC_ISSUER` / `CIWG_OIDC_CLIENT_ID` for the plugin (see
"Issuer and client id" above — confirm both strings on the provider page).

Settings, as created (slug `ciwg-knowledge`):

| Setting | Value | Why |
|---|---|---|
| Client type | **Public** | Every client runs on a laptop or in a browser — no secret can be kept; PKCE protects the code |
| Client ID | `lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1` | Auto-generated by Authentik for this provider (not the slug); the plugin default (`CIWG_OIDC_CLIENT_ID` overrides) and the API's expected audience |
| Redirect URIs — all in this one app | **strict** `https://claude.ai/api/mcp/auth_callback`, **strict** `https://claude.com/api/mcp/auth_callback`, **regex** `^http://127\.0\.0\.1(:\d+)?/callback$` | The two strict entries are the claude.ai / Claude Desktop connector callbacks; the regex is `login.mjs`, which binds `127.0.0.1` on a random port (RFC 8252 loopback — a strict entry cannot express a random port). Regex entries are matched against the whole redirect URI, so escape the dots and anchor with `^…$`. Add regex `^http://localhost:\d+/callback$` only if someone uses the optional Claude Code native-OAuth path |
| Scopes / property mappings | `openid`, `profile`, `email`, **`offline_access`** (Authentik's default `profile` mapping already emits the `groups` claim; a dedicated `groups` mapping is optional — Authentik ignores a requested scope that has no mapping) | `offline_access` is what makes Authentik issue a refresh token (2024.2+); `groups` lets the API apply the staff gate |
| Access token validity | `minutes=10` … `minutes=15` | This bounds how long a deactivated user keeps access (default is `hours=1` — too long) |
| Refresh token validity | e.g. `days=30` | Long-lived; the user re-logs in when it lapses. Deactivation deletes it immediately |
| Signing key | set (RS256) | Access tokens must be JWTs the API can verify offline |
| Device code flow (optional, for SSH users) | Create a flow with designation **Stage Configuration** and set it as the brand's **Default code flow** (System → Brands) | Authentik ships no default; without it `/ciwg-login` over SSH fails with a clear message and the browser flow still works |
| Users | staff group only, via the application's policy bindings | Removal from the group / deactivation = access ends within one access-token lifetime |

Version note: the per-entry **strict / regex** selector is the CVE-2024-52289 fix (2024.8.5, 2024.10.3 and every 2024.12.x — the CIWG instance runs 2024.12.3), and the upgrade migration marks every pre-existing entry *strict*, so re-check the mode of the loopback regex after any upgrade; on an older instance there is no selector — every line is a regex matched in full — so enter the two connector callbacks as `^https://claude\.ai/api/mcp/auth_callback$` and `^https://claude\.com/api/mcp/auth_callback$` there.

Server side (ci-connect): the API must accept this application's tokens
(issuer `https://sso.ciwgserver.com/application/o/ciwg-knowledge/`,
audience `lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1`) on
`/api/v1/knowledge/*`, `/api/v1/engram/*`
**and** `/mcp` — see the dependency note at the top.

## Tests

`node --test plugins/ciwg-knowledge/tests/engram.test.mjs plugins/ciwg-knowledge/tests/auth.test.mjs`
(pass the files — the directory form is not supported by every Node).

- `engram.test.mjs` — digest construction against a throwaway git repo,
  the git calls bounded by the hook deadline, the opt-out switches, the
  no-credential fail-open, injection rendering.
- `auth.test.mjs` — PKCE, discovery, the token cache and silent refresh
  against a mocked token endpoint (rotation, expiry skew, `invalid_grant`
  → relogin as the ONE dropped state, every other 4xx transient, in-process
  dedupe, the pid-aware cross-process lock, busy siblings, a stale lock
  the filesystem refuses to remove waited out inside the deadline without
  a synchronous spin, retried persistence of a rotated token, proactive
  refresh, a malformed `auth.json` read as not-signed-in), the hook time
  budget (hung IdP / hung API / a 200 whose body stalls, all cut inside the
  deadline, `hooks.json` timeouts vs. the budget, a real hook process
  against a hanging API), legacy-token
  precedence, credential-before-backoff ordering, API 401 → actionable
  status, the loopback flow end to end (a real `127.0.0.1` listener with
  state probing, single-shot, timeout, error callback, blocking opener),
  the Windows browser launch spec, the device flow (`slow_down`, network
  blips, expiry, deferred start/finish, denied / not enabled), `login.mjs`
  over SSH as a real process against a local IdP (prints the code and
  returns at once, `--device-finish` completes), logout, the hint cadence,
  and the hooks run as real processes (nudge once, then silence).

No network is touched — every call goes through an injected `fetchImpl`
or a `127.0.0.1` server the test owns — and `~/.ciwg` is redirected to a
temp dir for the run.
