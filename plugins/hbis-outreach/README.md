# `hbis-outreach`

Batch HBIS brief requests to Hydra clients in Slack, and run the chase that
follows. It resolves each client's channel, picks their HBIS edition from the
published editions, fills in the copy, and **drafts** every message for the
person running it to read and send. It never sends on its own.

Built by Kimberly Marshall from her own HBIS outreach. This is the shared
copy: no client names, domains, Slack IDs or Asana IDs, so it is safe in this
public repository.

Claude Code only. It needs the **Slack**, **Asana** and **Gmail** connectors.

## Install (once)

In Claude Code:

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install hbis-outreach@ciwg
```

Then turn on updates so you get every improvement without reinstalling:
`/plugin` → **Marketplaces** → `ciwg` → **Enable auto-update**. Claude Code
checks for a new version at the start of each session. Without it, run
`/plugin marketplace update ciwg` to pick up changes by hand.

Start a new session. Ask for it in plain words ("send the HBIS to these
clients") or run `/hbis-outreach:hbis-outreach`.

**Already copied the old version into `~/.claude/skills/hbis-outreach`?**
Delete that folder after installing. Otherwise both copies load, and the
frozen one can be picked instead of this one.

## Set yourself as the operator — before the first run

Every message is signed. `resolve.py` has **no default sender**, by design: a
default once meant one person's name on everyone else's client mail. Add your
own to `~/.zshrc`:

```bash
export HBIS_SENDER="Your Full Name"
export HBIS_TITLE="Your CI Web Group Title"
```

Without these, any `render` or `batch` run stops and says what is missing.
The skill also asks for your **AM name** — how you appear in the Hydra
tracker's `AM` field — which decides whose clients you may contact.

`nudge-templates.md` is used verbatim rather than rendered, so the skill fills
`{{SENDER}}` and `{{TITLE}}` there from the same two values.

## The gate — this skill never sends

**Draft → the operator reads the exact text → the operator says send.**
Invoking the skill is not approval; handing over a client list is not
approval; silence is not approval. The standing instruction (Kimberly,
2026-09-21) covers email as well as Slack, and it exists because a send once
went out carrying a due date nobody had approved. These are client-facing
channels: a bad message is visible to the customer and cannot be recalled.

Due dates are capped at `MAX_DUE_DAYS` (5) unless `--far-due` is passed, so an
invented two-week deadline cannot reach a client by accident.

## Your working files live outside the plugin

Updates replace the plugin folder, so everything personal lives in
`~/.claude/hbis-outreach/` and survives them:

| file                   | what                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `log.md`               | your outreach history. Created on first run. Asana is the shared record.                   |
| `roster.json`          | the batch in flight, with client contact details. Built per batch; SKILL.md has the shape. |
| `asana-ids.json`       | the tracker's project, field and option IDs, looked up by name on first run.               |
| `.editions-cache.json` | fallback copy of `ciwebgroup.com/hbis/editions.json`. Regenerates itself.                  |

The example brief is not shipped either: it is published at
`ciwebgroup.com/hbis/example`, and every template links it.

## This plugin ships a script

`resolve.py` **makes network calls**: it fetches
`ciwebgroup.com/hbis/editions.json` for the edition list, and client homepages
to guess an edition from the business. It reads `clients/<slug>.json` from a
local hydra-sites checkout when one exists (`--repo`, default
`~/Desktop/CIWG Sites/hydra-sites`). It writes only to
`~/.claude/hbis-outreach/` and whatever `--out` path you give it.

## Changing it

Lessons from client replies and new team rules come back here as PRs. Before
opening one:

- **No client data.** Write the lesson as a general rule ("one client's
  in-channel contact…"), never with the name, domain, Slack or Asana ID.
  `npm test` fails on Slack IDs, Asana GIDs, real email addresses, card digits
  and order numbers.
- **Bump `version`** in `.claude-plugin/plugin.json`. Teammates only receive a
  change when the version string changes.
- Run `claude plugin validate plugins/hbis-outreach`.
