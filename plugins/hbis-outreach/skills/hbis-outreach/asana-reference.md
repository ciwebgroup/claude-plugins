# Asana — Hydra Production Tracker (names, lookups and queries)

Workspace project: **Hydra Production Tracker**

Task name = the client's **domain** (e.g. `examplehvac.com`).

## IDs are looked up by NAME at run time — none are stored here

This skill ships in a public repository, so no Asana GID is written into it.
Every field, option and project below is named exactly as it appears in Asana.
Resolve the GIDs once per machine and keep them locally:

1. **Project** — `search_objects resource_type=project query="Hydra Production Tracker"`.
   Exactly one match is expected; more than one = stop and ask the operator
   which board is live.
2. **Fields and options** — `get_project` on that GID with
   `opt_fields=custom_field_settings.custom_field.name,custom_field_settings.custom_field.gid,custom_field_settings.custom_field.type,custom_field_settings.custom_field.enum_options.name,custom_field_settings.custom_field.enum_options.gid`.
3. **Save** the result to `~/.claude/hbis-outreach/asana-ids.json` in this
   shape, and read it on every later run:

```json
{
  "resolved": "2026-10-07",
  "project": "<gid>",
  "fields": {
    "Status": { "gid": "<gid>", "options": { "Pending HBIS": "<gid>" } },
    "HBIS": { "gid": "<gid>", "options": { "Requested": "<gid>" } },
    "Slack": {
      "gid": "<gid>",
      "options": {
        "Customer in Slack": "<gid>",
        "Customer not in Slack": "<gid>"
      }
    },
    "Last Client Contact": { "gid": "<gid>" },
    "HBIS Received": { "gid": "<gid>" }
  }
}
```

**Match labels after trimming whitespace** — the HBIS field's `Received`
option carries a leading space in its label. If a write fails with an unknown
GID, or a name below is missing from the project, the cache is stale: delete
the file and resolve again. Never guess a GID, and never write an enum by its
display name — the connector needs the option GID.

## The fields this flow reads and writes

| field               | type | use                                                |
| ------------------- | ---- | -------------------------------------------------- |
| Status              | enum | find Pending HBIS; set it on every send            |
| HBIS                | enum | gate 2; set to `Requested` on every send           |
| Slack               | enum | record channel membership on every send            |
| Reach Out Status    | enum | read only — never derive Pending HBIS from it      |
| Last Client Contact | date | set to today on every send                         |
| HBIS Received       | date | gate 3 — a date here means the brief is already in |
| AM                  | —    | gate 1 — the operator's own accounts               |

### Status options (the ones this flow touches)

`Pending HBIS` (written on every send), `Viber`, `Needs Buildout/Content`,
`AM: Client Review`.

**`Status` → Pending HBIS is written on every send** (Kimberly, 2026-10-01),
whatever the field currently reads — a task sitting on `Viber` or `Needs
Buildout/Content` with no brief on file is a field that has run ahead of the
work, and gets corrected. Only a human moves a client OFF Pending HBIS, when
the brief lands.

### HBIS options

`Requested` · `Received` (leading space in the label) · `Uploaded to Hydra`.

There is **no "Sent" option** — the field has exactly these three. An earlier
version of this file called it "Sent"; setting it once came back reading
**Requested**. Report the result as "HBIS → Requested".

### Slack options (membership, written by Step 5b)

`Customer in Slack` · `Customer not in Slack` · `Check Slack` ·
`Account Set Up`.

Step 5b writes one of the first two from what `slack_list_channel_members`
returned. **Blank on most tasks**, so it never replaces paging the member list —
read members, then record what you read. A field that contradicts a fresh member
list loses to the member list.

## THE Pending HBIS query — use this, never a CSV export

```
search_tasks
  projects_any  = <project gid>
  custom_fields = {"<Status gid>.value":"<Pending HBIS option gid>"}
  completed     = false
  opt_fields    = name,gid
```

**`Status` does NOT survive the CSV export** — every row comes back blank, which
is why an attempt to derive "Pending HBIS" from `Reach Out Status` + blank
`HBIS` was wrong in both directions. Ask Asana, not the spreadsheet.

## Find one client's task

```
search_tasks projects_any=<project gid> text="<domain>" completed=false opt_fields=name,gid
```

Match on the FULL domain — one client group can own several brands, each its
own task under its own domain.

## Slack permalink format

Read the channel with `response_format="detailed"` to get `Message TS`, then:

```
https://ci-web-group.slack.com/archives/<CHANNEL_ID>/p<TS with the dot removed>
```

`C0XXXXXXXXX` + `1700000000.123456` → `…/archives/C0XXXXXXXXX/p1700000000123456`

## What the connector CANNOT do

**There is no attachment-upload tool.** `get_attachments` reads; nothing writes.
PDFs of client emails cannot be attached to a task by this flow.

**Post the email body as an Asana comment instead.** Searchable, no PDF to
make, no upload step. Decision from Kimberly, 2026-09-18: do NOT route these
through Google Drive — a Drive link is another place to look, which is the
problem rather than the fix.
