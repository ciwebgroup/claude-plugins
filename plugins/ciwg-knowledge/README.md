# ciwg-knowledge

Company knowledge, injected — not fetched. This plugin wires CIWG's
knowledge engine (Fathom meetings, call transcripts, helpdesk tickets,
internal team chat, org notes) into Claude Code so that **retrieval happens
outside the model**: hooks query the knowledge API before Claude sees your
prompt and inject compact, source-cited snippets. The model spends zero
tokens and zero reasoning deciding whether or how to look something up.

## What you get

| Surface | When it fires | What it does |
|---|---|---|
| `UserPromptSubmit` hook | every substantive prompt | Searches the knowledge API with your prompt; injects up to 3 relevant snippets (score-gated — quiet prompts inject nothing) |
| `SessionStart` hook | opening a session in a client-mapped repo | Injects a short client brief (recent meetings/tickets/notes) |
| MCP tools | when you or Claude explicitly ask | `search_company_knowledge`, `get_source_artifacts` for deep dives |

Fail-open by design: no token, API down, timeout → the hooks stay silent
and your session is unaffected.

## Setup

1. **Token** — mint an API token with the `route:knowledge` scope (synapse
   admin → API tokens; knowledge search is internal-staff-only, so the
   token creator must be staff). Then either:
   - `setx CIWG_KNOWLEDGE_TOKEN <token>` (Windows) / export it in your
     shell profile, or
   - write `~/.ciwg/knowledge.json`: `{ "token": "<token>" }`
2. **API base** (optional) — defaults to `https://api.ciwebgroup.com`;
   override with `CIWG_KNOWLEDGE_URL` (e.g. staging, or a local tunnel).
3. **Client mapping** (optional, per repo) — drop a `.ciwg-client.json` at
   the project root to scope retrieval to that client and enable the
   session brief:

   ```json
   { "organizationId": 7, "clientName": "Acme HVAC" }
   ```

4. **Tuning** (optional) — `CIWG_KNOWLEDGE_MIN_SCORE` (default `0.35`)
   raises/lowers the injection relevance floor.

## Privacy & trust notes

- Everything served is **internal-staff** data; the search API enforces the
  staff gate server-side — the token is the credential, this plugin adds no
  access the token doesn't already have.
- Injected snippets are labelled `auto-retrieved` and carry source pointers
  (`helpdesk-ticket:42#3`); Claude is instructed to cite and verify rather
  than assert them as current truth.
- Prompts are sent to the knowledge API as search queries (internal
  infrastructure). Slash commands, bash-mode (`!`), and very short prompts
  are never sent.
