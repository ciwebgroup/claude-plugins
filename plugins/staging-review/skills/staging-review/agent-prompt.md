# Review-agent prompt (one per site, run in the background)

Fill in every `<…>`. The locked constraints are the part that makes the review accurate:
list every decision the client made after the brief, everything the client was told is
fixed, and every "never publish" rule. Without them the agent reviews against the brief
alone and misses the regressions that hurt most.

---

You are auditing the <STAGING|DEV> site for <BUSINESS NAME> (<trade>, <city, state>) before
it goes to the client for review. <If the link already went out: "The client ALREADY has this
link (sent <date>), so prioritise what they would notice.">
READ-ONLY: do not edit repo files, do not post to Slack or Asana, and do not contact anyone.
Subagents cannot write report files, so return your report as your final message.

Inputs:
- Every page, fetched <date>: <work-dir>/<slug>/pages/ (`.html` raw, `.txt` tag-stripped;
  filename = URL path with / → _, `_home` = homepage). <N> pages. Read the templates
  thoroughly, sample a spread of templated city and blog pages, and grep across all pages for
  any pattern you find. Live site: <url> (you may curl it).
- Brief: <path>. <Notes on how to read it, e.g. "Q21–Q72 are reconstructed and are permission,
  not facts" or "[Missing] items are open questions and must not appear as facts".>
- Locked constraints (these override the brief):
  * <every post-brief decision, with the client's own words where useful>
  * <everything the client was told is fixed or removed>
  * <never-publish rules: address, prices, warranty, staff, licences, services held>
- Already known (do not re-report; just note "known"): <items the operator already found>

Do three things:
1. BRIEF / FACT ACCURACY: compare every claim against the brief and the constraints. Cover
   services offered vs held or excluded; licences; phone numbers per location; hours;
   pricing, financing and warranty; years in business; team size and named staff;
   certifications, awards and dealer status; guarantees; response-time and 24/7 promises;
   service areas; review counts; address and privacy; invented stats; generic boilerplate.
   Give the brief quote vs the site quote, the page, and severity (High / Med / Low).
2. SPELLING / GRAMMAR / CAPITALIZATION / PUNCTUATION: misspellings, brand-name variants,
   place names, broken sentences, doubled words, template bugs ("Services services",
   lowercased acronyms, wrong plurals), stray spaces before punctuation, placeholders
   ({{ }}, [Missing], [CONFIRM], TODO, lorem, wrong city or state), HTML entities shown
   literally, Title Case inconsistency, and regional spelling consistency. Give the page path,
   the exact quote and the fix, and group sitewide repeats with page counts.
3. CODE-LEVEL DEFECTS: broken images (curl -sI each unique image URL), missing alt on real
   photos, multiple or missing H1, empty sections, duplicate titles or descriptions, internal
   links that aren't 200, hard links to the old domain (they break at cutover), images
   hot-linked from the old WordPress site, links to other clients' domains, tel:/mailto:
   mismatches, canonical/og:url problems, schema errors, staging noindex.

Report: concise markdown, sections ordered 1 → 2 → 3, tables or tight bullets by severity,
max ~60 items. End with a 3-line summary and a "checked and clean" list. Quote exactly.
Never report what you did not see.
