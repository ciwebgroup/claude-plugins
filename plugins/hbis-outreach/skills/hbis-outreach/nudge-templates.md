# HBIS nudge templates — APPROVED COPY, USE VERBATIM

Approved by Kimberly 2026-09-16 and kept as CIWG house copy. **Amended
2026-10-01 (Kimberly):** the
example-page block now appears in EVERY chase, not just the in-progress one — it is
part of `chase1-slack`, `chase1-email` and both `-awaiting-approval` variants below.
Two `-awaiting-approval` variants were added the same day for clients whose site is
BUILT and sitting with them for approval.

A scheduled chase MUST use these, filling only
`{link}` (the client's edition prompt URL from roster.json), `{Name}`/`{tag}`, and
`{chase1 weekday}` (the actual weekday chase #1 went out — compute it, never assume).
**Do not rewrite, re-tone, lengthen, or "improve" them.** If a client's
situation doesn't fit any template here, draft nothing and ask the
operator.

**First person PLURAL only — no "I", "me" or "my" anywhere in chase copy.**
Correction from Kimberly, 2026-09-28: "make sure there is no 'me', instead use 'us';
same thing for 'I', it should be 'we'." The team does the work and the team is
asking, so: "we haven't seen it", "tell us what it is", "we'll work with you".
Applies to every template in this file. Do not tighten any of it back to singular.

Two things must survive every edit: **builds enter the production queue in the
order completed briefs arrive**, and **the brief must be fully filled out**.
They are the whole point of the chase.

**The queue claim applies to NOT-STARTED clients only.** Any other client is not in
a queue, and saying so contradicts whatever the initial request told them. Route by
build state:

- **not started** → `chase1-slack` / `chase1-email` (queue lever)
- **build underway** → `chase1-slack-inprogress` (dependency lever)
- **built, sitting with the client for approval** → `chase1-slack-awaiting-approval`
  / `chase1-email-awaiting-approval` (cutover lever)

Read the client's ORIGINAL request to settle which state they were told they were in,
and stay consistent with it. The completeness rule survives in every case, all three.

Slack greeting = the `<@Uxxxx>` tag ALONE, no first name. Email = first name.
Every message signs off with **the operator's own name and title** — fill
these two tokens before the draft goes anywhere near a client:

    {{SENDER}}
    {{TITLE}} | CI Web Group

These templates are used verbatim and are NOT rendered through `resolve.py`,
so nothing substitutes the tokens for you. A sign-off carrying someone else's
name is a misattribution the client acts on.

---

## chase1-slack — silent, is in the channel

Hi {tag} 👋 — checking in on your HBIS brief. We haven't seen it land yet.

Prompt's here: {link}

**If it helps to see a finished one first:** https://ciwebgroup.com/hbis/example — a complete brief for a made-up plumbing company. That's the depth we're after, and it shows how to mark what you don't know instead of guessing at it.

**Worth knowing how this works:** builds enter our production queue in the order completed briefs arrive. Your place is set by when yours comes in — not by when you signed up. Every day it sits is a day further back, behind clients who've already submitted.

It does need to be **fully filled out**. Answer every question the prompt asks. An incomplete brief doesn't enter the queue, because we can't start a build on half a picture — and we'd only be back asking you for the rest.

If anything's unclear or you want a hand with it, say so here and we'll help.

---

## chase1-email — silent, NOT in Slack

Hi {Name},

Checking in on your HBIS brief — we haven't seen it come through yet.

The prompt is here: {link}

**If it helps to see a finished one first:** https://ciwebgroup.com/hbis/example — a complete brief for a made-up plumbing company. That's the depth we're after, and it shows how to mark what you don't know instead of guessing at it.

**Worth knowing how this works:** builds enter our production queue in the order completed briefs arrive. Your place is set by when yours comes in, not when you signed up — so every day it sits is a day further back, behind clients who've already submitted.

It does need to be **fully filled out** — every question the prompt asks. An incomplete brief doesn't enter the queue, because we can't start a build on half a picture.

Two things might be in the way, and we can fix either:

- **Not in Slack yet?** Reply and we'll get a fresh invite out today — that's where the brief needs to land.
- **Started but stuck?** Tell us where and we'll help.

---

## chase1-slack-inprogress — silent, in the channel, BUILD ALREADY UNDERWAY

Approved by Kimberly 2026-09-30. Use this instead of
`chase1-slack` whenever the build is in progress. The lever is the dependency,
not the queue — the build is moving and can only go so far without the brief.

Hi {tag} 👋 — checking in on your HBIS brief. We haven't seen it land yet.

Prompt's here: {link}

**If it helps to see a finished one first:** https://ciwebgroup.com/hbis/example — a complete brief for a made-up plumbing company. That's the depth we're after, and it shows how to mark what you don't know instead of guessing at it.

**Where this sits:** your build is moving, and it can only go so far on what we can see. The pages still ahead — your service areas, which services lead, how you're positioned — need the answers only you have. Every day it's outstanding is a day we're either waiting or guessing.

It does need to be **fully filled out**. Answer every question the prompt asks. Whatever's left blank we end up guessing at, and you'll see those guesses in the result.

If anything's unclear or you want a hand with it, say so here and we'll help.

The example URL is a rendered HTML page, not a raw `.md` file, so it needs no
"wall of text" caveat — that warning belongs only to the prompt link.

---

## chase1-slack-awaiting-approval — silent, in the channel, SITE BUILT AND AWAITING CLIENT APPROVAL

Approved by Kimberly 2026-10-01.
Use this — NOT `chase1-slack-inprogress` — when the client's site is finished and
sitting with them for final review before go-live. `-inprogress` says "your build is
moving" and "the pages still ahead"; both are false for a finished site, and a client
looking at their own staging link will notice. There is no queue here either. The
lever is the cutover: pre-launch the brief is folded into the build, post-launch the
same answers become retrofits. Never state or imply that their go-live is being held
up — it is not, and their original request told them so.

Hi {tag} 👋 — checking in on your HBIS brief. We haven't seen it land yet.

Prompt's here: {link}

**If it helps to see a finished one first:** https://ciwebgroup.com/hbis/example — a complete brief for a made-up plumbing company. That's the depth we're after, and it shows how to mark what you don't know instead of guessing at it.

**Where this sits:** your site is finished and still sitting with you for approval, so nothing here is holding up your go-live — we'll take it live whenever you give us the word. What's still open is how much of *you* is in it when it does. While it's pre-launch we can fold the brief straight into the build; once we've cut over, the same answers become changes to a live site — slower, coarser, and never quite as good as having had them first.

It does need to be **fully filled out**. Answer every question the prompt asks. Whatever's left blank we end up guessing at, and you'll see those guesses in the result.

If anything's unclear or you want a hand with it, say so here and we'll help.

---

## chase1-email-awaiting-approval — same state, NOT in Slack

Approved by Kimberly 2026-10-01. The email twin of
the above, carrying the same two fix-it bullets as `chase1-email`. Before this one
goes to a client, confirm you have the address of the person who actually reviews
the site — on one account the only reviewer to date was a different contact,
by email, while the request kept going to the owner's address.

Hi {Name},

Checking in on your HBIS brief — we haven't seen it come through yet.

The prompt is here: {link}

**If it helps to see a finished one first:** https://ciwebgroup.com/hbis/example — a complete brief for a made-up plumbing company. That's the depth we're after, and it shows how to mark what you don't know instead of guessing at it.

**Where this sits:** your site is finished and still sitting with you for approval, so nothing here is holding up your go-live — we'll take it live whenever you give us the word. What's still open is how much of you is in it when it does. While it's pre-launch we can fold the brief straight into the build; once we've cut over, the same answers become changes to a live site — slower, coarser, and never quite as good as having had them first.

It does need to be **fully filled out** — every question the prompt asks. Whatever's left blank we end up guessing at, and you'll see those guesses in the result.

Two things might be in the way, and we can fix either:

- **Not in Slack yet?** Reply and we'll get a fresh invite out today — that's where the brief needs to land.
- **Started but stuck?** Tell us where and we'll help.

---

## chase2 — second nudge (Slack or email)

Hi {tag or Name} — following up on our note from {chase1 weekday}. We still haven't seen your HBIS brief.

{link}

**If it helps to see a finished one first:** https://ciwebgroup.com/hbis/example — a complete brief for a made-up plumbing company. That's the depth we're after, and it shows how to mark what you don't know instead of guessing at it.

Being straight with you: clients who submitted this week are already in the production queue, and every day yours isn't in, the gap widens. The queue is first-come, first-served on completed briefs — that's the only thing that sets your position.

We know it isn't a small ask. If it's the time, say so and we'll work with you. If something specific is blocking it, tell us what it is. We'd rather solve it with you than keep sending reminders.

---

## chase3 — final nudge

Hi {tag or Name} — third note on this, so we'll be direct.

Your completed HBIS brief is still outstanding, which means you're not in the production queue and your build hasn't started.

{link}

Nothing moves on our side until it arrives, fully filled out. This one is yours to send — the timing is entirely in your hands, and whenever it lands you enter the queue at that point, behind whoever has submitted in the meantime.

This is our last reminder on it. If you've decided to hold off for now, just tell us so we can plan around it.

---

## replied-no-file — engaged but nothing delivered

Hi {tag or Name} — you mentioned you were working on the brief, just checking where it got to. One thing to flag: it needs to be complete to enter the queue, so if you're partway and stuck on a section, tell us which one and we'll help you through it rather than have you send a half-finished one.

**Never** tell a client a partial brief is acceptable. It contradicts the
completeness rule and invites exactly the half-briefs this process exists to
prevent.

**Never offer a phone call, and never propose that the operator chase a
client by phone.** The position (Kimberly, 2026-09-16): completing the HBIS is the
client's responsibility. Three written reminders is the whole ladder. After
chase #3 the ball sits with the client and stays there — report the status,
propose nothing further.
