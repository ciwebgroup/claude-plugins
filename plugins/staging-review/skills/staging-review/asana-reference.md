# Asana — Hydra Production Tracker (names, lookups and queries)

Task name = the client's **domain** (e.g. `examplehvac.com`).

## IDs are looked up by NAME at run time — none are stored here

This skill ships in a public repository, so no Asana GID is written into it. Resolve the
GIDs once per machine and cache them:

1. **Project**: `search_objects resource_type=project query="Hydra Production Tracker"`.
   Expect exactly one match. If there's more than one, stop and ask the operator which
   board is live.
2. **Fields and options**: `get_project` on that GID with
   `opt_fields=custom_field_settings.custom_field.name,custom_field_settings.custom_field.gid,custom_field_settings.custom_field.type,custom_field_settings.custom_field.enum_options.name,custom_field_settings.custom_field.enum_options.gid`.
3. **Save** the result to `~/.claude/staging-review/asana-ids.json` and read it on every
   later run:

```json
{
  "resolved": "<YYYY-MM-DD>",
  "project": "<gid>",
  "fields": {
    "Status": { "gid": "<gid>", "options": { "AM: Client Review": "<gid>", "Viber - Changes": "<gid>" } },
    "AM": { "gid": "<gid>", "options": { "<operator's AM label>": "<gid>" } },
    "Viber": { "gid": "<gid>" },
    "Staging Link": { "gid": "<gid>" },
    "Dev Link": { "gid": "<gid>" },
    "Last Client Contact": { "gid": "<gid>" },
    "Next Follow-Up Due": { "gid": "<gid>" }
  }
}
```

Match labels after trimming whitespace. **Two fields are named `Status`**, so pick the one
whose options include `AM: Client Review`. If a write fails with an unknown GID, the cache
is stale: delete it and resolve again. Never guess a GID, and never write an enum by its
display name. The connector needs the option GID (`"enum_value: Not a recognized ID"`
means a display name was sent).

## Fields this skill reads and writes

| field               | type | use                                                         |
| ------------------- | ---- | ----------------------------------------------------------- |
| Status              | enum | find `AM: Client Review`; set `Viber - Changes` on a fail   |
| AM                  | enum | scope: the operator's own projects only                     |
| Viber               | enum | who to @-mention and DM (it's a short label, so match it to the person) |
| Staging Link        | text | the URL to review; fall back to `<slug>-stg`, then Dev Link |
| Dev Link            | text | fallback when staging isn't up                              |
| Last Client Contact | date | set when a client message actually went out                 |
| Next Follow-Up Due  | date | offer a date that matches what the client said             |

Dates are written as `{"date": "YYYY-MM-DD"}`. **Never reassign the Viber field.** "Tag the
Viber" means an @-mention in a comment, not a field write.

## The Client Review query

```
search_tasks
  projects_any  = <project gid>
  custom_fields = {"<Status gid>.value":"<AM: Client Review option gid>"}
  completed     = false
  opt_fields    = name,custom_fields.name,custom_fields.display_value
```

The result is large (every custom field on every task), so it's saved to a file. Use `jq` on
it, then filter to `AM` = the operator. When a task moved to Client Review comes from
`get_task_stories` (`task_ids`, up to 50 per call): look for `changed Status from … to AM:
Client Review`. `modified_at` is useless, because a daily automation bumps every task.

## @-mentions and user GIDs

- Asana: `<a data-asana-gid="USER_GID"/>` inside `html_text`. Get user GIDs from the stories
  feed (`created_by.gid` on that person's own comments). A profile-link GID in comment text
  is a different ID.
- Slack: `slack_search_users` by last name gives `U…`. A DM can be drafted with the user ID
  as the channel; a send needs the DM channel ID (`D…`) from the draft or send result.

## Slack permalink format

Read the channel with `response_format="detailed"` to get `Message TS`, then:
`https://<workspace>.slack.com/archives/<CHANNEL_ID>/p<TS with the dot removed>`.
`C0XXXXXXXXX` + `1700000000.123456` → `…/archives/C0XXXXXXXXX/p1700000000123456`.
