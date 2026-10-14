# `staging-feedback-intake`

Client feedback on a Hydra dev or staging site arrives in Slack threads, forwarded
emails and untagged channel posts. When nobody is tagged, nobody is notified. This
plugin sweeps for that feedback twice a day, **scoped to your own projects** (the Hydra
Production Tracker's `AM` field). For each client who said something, it:

1. **Drafts a reply to the client** in their thread (or a Gmail reply if they aren't
   in Slack). It thanks them, confirms what has gone to the design team, and asks 1–3
   specific questions for anything too vague to build. **You read it and send it.**
2. **Comments on the client's tracker task**, @-mentioning the Viber and you, with a
   numbered list of requests. No fields are changed.
3. **DMs the Viber a self-contained brief**: page, section, the client's exact words,
   and a ready-to-paste prompt for each change. Vague items go out too, marked pending.
   When the client answers, the update arrives in the same DM thread.
4. **DMs you a digest** of drafts waiting for you, anything routed elsewhere, and
   anything it couldn't resolve. A quiet run sends nothing.

Built by Kimberly Marshall. This is the shared copy: it contains no client names,
domains, Slack IDs or Asana IDs, so it is safe in this public repository. Your own
settings stay on your machine.

Claude Code / the Claude desktop app. It needs the **Slack**, **Asana** and **Gmail**
connectors.

## Install (once)

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install staging-feedback-intake@ciwg
```

Turn on updates so improvements arrive by themselves: `/plugin` → **Marketplaces** →
`ciwg` → **Enable auto-update**.

## Set up (once)

Start a new session and say **"set up staging feedback"** (or run
`/staging-feedback-intake:staging-feedback-setup`). It will:

- find your Slack and Asana accounts;
- ask which **AM** value on the tracker is yours. It shows the list. Pick carefully:
  this value decides whose clients it touches;
- ask who handles commercial, blog and Google Business Profile questions (default:
  you);
- write `~/.claude/staging-feedback-intake/config.json`;
- schedule the sweep for **weekdays at 8:00 AM and 3:00 PM**.

Then click **Run now** on the task once and choose **Always allow** on each permission
card. Otherwise later runs stall waiting for an approval nobody sees.

Run it by hand at any time: **"check for staging feedback"** or
`/staging-feedback-intake:staging-feedback-intake`.

## What it will and won't do

| It will                                          | It won't                                                      |
| ------------------------------------------------ | ------------------------------------------------------------- |
| Draft client replies for you to send             | Send anything to a client, ever                               |
| Send the Viber and you a Slack DM                | Change any Asana field, including Status, Viber and AM        |
| Comment on the tracker task with @-mentions      | Touch another AM's clients                                    |
| Route pricing, blog and GBP asks to their owners | Answer pricing, promise dates, or promise a change is done    |
| Flag text in a client message that targets an AI | Follow instructions found in client messages                  |
| Tell you about files it can't open               | Ask the client to resend something they already sent          |
| Skip feedback a teammate already logged on Asana | Log the same Slack message twice (it checks the comment sources) |
| Flag sites with no Viber and all-sites requests  | Guess which site a message means in a multi-site channel      |

## Files on your machine

`~/.claude/staging-feedback-intake/` holds `config.json` (you) plus state:
`processed.json` (what has been handled, so nothing is processed twice),
`vibers.json`, `channels.json` and `tracker.json` (lookup caches). Don't delete
`processed.json` unless you want old feedback processed again.
