# ciwg-knowledge

Company knowledge, injected — not fetched. This plugin wires CIWG's
knowledge engine into Claude Code so that **retrieval happens outside the
model**: hooks query the knowledge API before Claude sees your prompt and
inject compact, source-cited snippets. The model spends zero tokens and
zero reasoning deciding whether or how to look something up.

Ingested sources today: call transcripts, chat logs, Fathom meetings.
Helpdesk tickets, internal team chat, and org notes light up automatically
as their ingestion ships (ci-connect PR #780) — no plugin update needed.

Requires Node ≥ 18 (global `fetch`).

## What you get

| Surface | When it fires | What it does |
|---|---|---|
| `UserPromptSubmit` hook | every substantive prompt | Searches the knowledge API with your prompt; injects up to 3 relevant snippets (score-gated — quiet prompts inject nothing) |
| `SessionStart` hook | opening/resuming a session in a client-mapped repo (never after compaction) | Injects a short client brief — requires BOTH `organizationId` and `clientName` in the mapping (the org id server-side-filters the search so a name match can never surface another client's data) |
| MCP tools | when you or Claude explicitly ask | `search_company_knowledge`, `get_source_artifacts` for deep dives |

Fail-open by design: no token, API down, timeout → the hooks stay silent
and your session is unaffected.

## Setup

1. **Token** — mint an API token with the `route:knowledge` scope (synapse
   admin → API tokens; knowledge search is internal-staff-only, so the
   token creator must be staff). Then either:
   - set `CIWG_KNOWLEDGE_TOKEN` in your shell profile (`setx` on Windows
     affects **new** terminals only — open a fresh one before testing), or
   - write `~/.ciwg/knowledge.json`: `{ "token": "<token>" }` (plain
     UTF-8; a BOM is tolerated)
2. **API base** (optional) — defaults to `https://api.ciwebgroup.com`;
   override with `CIWG_KNOWLEDGE_URL` (e.g. staging, or a local tunnel).
3. **Client mapping** (optional, per repo) — drop a `.ciwg-client.json` at
   the project root to scope retrieval to that client and enable the
   session brief:

   ```json
   { "organizationId": 7, "clientName": "Acme HVAC" }
   ```

4. **Tuning** (optional) — `CIWG_KNOWLEDGE_MIN_SCORE` (default `0.35`,
   clamped to 0–1) raises/lowers the injection relevance floor.
5. **Troubleshooting** — set `CIWG_KNOWLEDGE_DEBUG=1` to get stderr traces
   from the hooks (unscoped token vs. unreachable API vs. genuinely no
   relevant hits are otherwise indistinguishable by design — the hot path
   never prints). After a network failure the hooks back off for 60s.

## Privacy & trust notes

- Everything served is **internal-staff** data; the search API enforces the
  staff gate server-side — the token is the credential, this plugin adds no
  access the token doesn't already have.
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
  customers and outsiders).
