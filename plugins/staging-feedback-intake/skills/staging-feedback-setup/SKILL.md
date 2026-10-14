---
name: staging-feedback-setup
description: One-time setup for staging-feedback-intake. Records who the operator is (their AM name on the Hydra Production Tracker, their Slack and Asana IDs), writes ~/.claude/staging-feedback-intake/config.json, and schedules the twice-daily sweep. Use when the user says "set up staging feedback", "/staging-feedback-setup", "schedule the staging feedback sweep", or when staging-feedback-intake reports that its config is missing.
---

# /staging-feedback-setup

Set up `staging-feedback-intake` for the person running this, the **operator**. Each
Account Manager runs their own copy, scoped to their own projects. Interactive only:
ask, confirm, then write.

## 1. Check the connectors

The sweep needs **Slack**, **Asana** and **Gmail**. Make one cheap read on each: Asana
`get_me`, a Slack user lookup, and Gmail `list_labels`. If one is missing, say which
one and how to connect it, then stop.

## 2. Work out who the operator is

- **Asana gid:** from `get_me`.
- **Slack user ID:** look up the operator's own email with `slack_search_users`.
  Confirm the name it returns with them.
- **Full name:** from either of the above. Confirm it.
- **AM name:** the operator's value in the Hydra Production Tracker's **AM** dropdown.
  Usually it's a first name or nickname, not the full name. Find the tracker project by
  name and read the `AM` field's options (or the distinct values on open tasks). Show
  the list, and ask which one is theirs. **Never guess this value: it decides whose
  clients the sweep touches.** Then count the open tasks with that value and tell them
  ("Found 54 open projects with AM = <value>").

## 3. Optional routing

Ask, accepting "skip" for each. Unset values default to the operator.

- `commercial_owner_name`: who handles pricing, plan and invoice questions.
- `blog_owner_name`: who handles the blogging program.
- `gbp_owner_name`: who handles Google Business Profile changes.
- `internal_contractor_emails`: non-CIWG addresses (for example, contractor Gmail
  accounts) that post on our side and should never count as client feedback.

## 4. Write the config

Write `~/.claude/staging-feedback-intake/config.json` and show the operator the result:

```json
{
  "am_name": "<AM dropdown value>",
  "operator_name": "<Full Name>",
  "operator_slack_id": "<U…>",
  "operator_asana_gid": "<gid>",
  "commercial_owner_name": "<name or omit>",
  "blog_owner_name": "<name or omit>",
  "gbp_owner_name": "<name or omit>",
  "internal_contractor_emails": [],
  "lookback_days": 3
}
```

If a config already exists, show the differences and ask before overwriting. Leave the
state files (`processed.json`, `vibers.json`, `channels.json`, `tracker.json`) alone:
deleting them makes the next sweep re-process old feedback.

## 5. Schedule it

The default is **weekdays at 8:00 AM and 3:00 PM**, in the operator's local time. Ask
whether that works.

- **If `create_scheduled_task` is available** (Claude desktop app), create:
  - `taskId`: `staging-feedback-intake`
  - `cronExpression`: `0 8,15 * * 1-5` (adjust to the operator's answer)
  - `prompt`: "Run the staging-feedback-intake skill in scheduled (unattended) mode.
    Follow its SKILL.md exactly. Read the config from
    ~/.claude/staging-feedback-intake/config.json. Never send anything to a client:
    client replies are drafts only. DM the Viber and the operator as the skill
    describes, and stay silent when there is nothing new."

  If a task with that ID already exists, update it instead of creating a second one.
- **Otherwise**, tell the operator how to schedule the same prompt on their surface
  (`/schedule` in Claude Code), or how to run `/staging-feedback-intake` by hand twice a
  day.

## 6. First supervised run

Tell the operator to click **Run now** on the scheduled task once and stay with it.
The first run asks for Slack, Asana, Gmail and web permissions. Choosing **Always
allow** saves those answers to the task. Otherwise a later unattended run stalls on an
approval card and looks as if it ran.

Two more things to tell them:

- Scheduled runs only happen while the Claude app is open. A missed run fires the next
  time it opens.
- Check what the run produced (the Viber DM, the Asana comment, the draft), not just its
  status. A run can be marked done without doing the work.
