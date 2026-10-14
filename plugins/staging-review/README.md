# `staging-review`

The review gate between "the Viber says it's ready" and "the client gets the link". It reviews
every page of a Hydra staging (or dev) site against the client's HBIS brief and everything the
client has been told since, then either clears the site or hands the Viber a verified fix list.

Built by Kimberly Marshall from her own pre-client reviews. On the first run (2026-10-14),
all six sites marked "ready for client review" failed. The failures included an invented team
on a one-person business, the wrong state's phone number on every out-of-state page, items we
had told the client were fixed and weren't, and two sites whose contact forms couldn't send a
lead. This is the shared copy: no client names, domains, Slack IDs or Asana IDs, so it is safe
in this public repository.

Claude Code only. It needs the **Slack** and **Asana** connectors, a **browser** tool (the
built-in browser pane or Claude in Chrome), and bash with `curl` and `python3`.

## Install (once)

```
/plugin marketplace add ciwebgroup/claude-plugins
/plugin install staging-review@ciwg
```

Turn on updates so you get every improvement: `/plugin` → **Marketplaces** → `ciwg` →
**Enable auto-update**. Start a new session, then ask in plain words ("review my sites that
are ready for client review", "is examplehvac ready for the client?") or run
`/staging-review:staging-review`.

## What it checks, per site

| check | how |
| --- | --- |
| Brief accuracy: services, licences, phones, prices, warranty, staff, claims | background review agent with the brief + every post-brief decision |
| Spelling, grammar, capitalization, template bugs | the same agent, across every page |
| Code defects: broken images and links, old-domain links, canonicals, schema | the same agent, plus `curl` |
| **Lead forms can send** (`window.__PMS_CONFIG__` present) | `scripts/crawl.sh` |
| **375px mobile overflow** on every page | `scripts/mobile-scan.js` in the browser |
| **Sidebar menus**: Service Areas + services in this city | `scripts/sidebar.py` |
| Visual: hero rendering, header controls, clipped badges | screenshots |

Every agent claim is checked against the brief and the live page before it's posted.

## What it does with a fail

1. Posts the full fix list on the tracker task, with the Viber @-mentioned.
2. Moves Status to **Viber - Changes**.
3. Drafts a short Slack DM to the Viber.
4. If the client already has the link: recommends a two-line heads-up to the client, drafted
   top-level in their channel.
5. After you send, logs every message on the task with permalinks, and sets Last Client
   Contact and the next follow-up.

## The gate: it never messages a client

Every client message is a **draft** you read and send. Client replies go **top-level in the
channel, never in a thread**, because clients miss thread replies. Internal DMs to a Viber are
drafted too, unless you tell it to send.

## Your working files live outside the plugin

Updates replace the plugin folder, so personal data lives in `~/.claude/staging-review/`:

| file | what |
| --- | --- |
| `config.json` | you as the operator: name, Slack user ID, Asana user GID. Asked once. |
| `asana-ids.json` | the tracker's project, field and option IDs, looked up by name on first run |

Crawls go in the session scratchpad and are thrown away.

## Scripts

All read-only against the site: plain `curl` GETs, no form submissions.

- `scripts/crawl.sh <work-dir> <url>`: every sitemap page plus the homepage, as HTML and text,
  and lists pages missing `__PMS_CONFIG__`.
- `scripts/sidebar.py <work-dir>`: the two-menu check on every city page.
- `scripts/mobile-scan.js`: pasted into the browser's JavaScript tool; scans every page in a
  375px iframe.
- `scripts/md2asana.py <fixlist.md> <viber-gid> "<opening>"`: fix list → Asana `html_text`
  with the @-mention.

## Contributing a lesson

Every rule came from a real review, so every change risks carrying a client identifier. Write
the lesson as a general rule. `npm test` fails the build on Slack IDs, Asana GIDs, message
timestamps, draft IDs and email addresses. Client names can't be pattern-checked without
publishing the list, so scrub them locally before the PR. Bump `version` in
`.claude-plugin/plugin.json`, or nobody gets the change.
