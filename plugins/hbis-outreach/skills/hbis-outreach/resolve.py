#!/usr/bin/env python3
"""Resolve HBIS outreach rows: slug -> client name, edition, prompt URL, message.

Usage:
  resolve.py plan  --slugs a,b,c [--due "Fri Oct 3"] [--repo PATH]
  resolve.py render --slug a --edition trades --due "Fri Oct 3" \
      --sender "Your Name" --title "Your Title"

`--sender` and `--title` are REQUIRED for any rendering subcommand: they sign
the client-facing message, and there is deliberately no default. Set
HBIS_SENDER / HBIS_TITLE in your shell to avoid retyping them.

`plan` prints one TSV row per slug for review:
  slug  clientName  editionKey  editionLabel  editionURL  confidence  signal
Confidence `low` means the guess needs a human to confirm it.
"""
import argparse, datetime, html, json, os, re, subprocess, sys

EDITIONS_URL = "https://ciwebgroup.com/hbis/editions.json"
# Templates sit next to this script, wherever the plugin is installed.
HERE = os.path.dirname(os.path.abspath(__file__))
# Outside the plugin folder: a plugin update replaces that folder wholesale.
CACHE = os.path.expanduser("~/.claude/hbis-outreach/.editions-cache.json")

# key -> regex of signals that mean "this edition". Order matters: first match wins,
# so the specific ones sit above `trades`, which is the catch-all for home services.
RULES = [
    ("auto-glass",          r"auto ?glass|windshield|adas"),
    ("automotive",          r"\bauto(motive)?\b|collision|tire|muffler|transmission|fleet repair"),
    ("legal",               r"\blaw\b|attorney|legal|counsel|litigat"),
    ("medical",             r"medical|health(care)?|clinic|hospital|home health|hospice"),
    ("clinical-practice",   r"dental|dentist|orthodont|vision|optometr|chiropract|veterinar|\bvet\b"),
    ("real-estate",         r"realty|real estate|brokerage|property manage|\brealtor\b"),
    ("restaurant",          r"restaurant|cafe|catering|brewery|bakery|hospitality|\bmenu\b"),
    ("turf-outdoor-living", r"turf|artificial grass|putting green|hardscape|paver|landscape supply"),
    ("design-build",        r"design.?build|general contractor|remodel|custom home"),
    ("home-accessibility",  r"stair ?lift|walk.?in tub|accessib|aging in place|home elevator|\bramp"),
    ("sports-recreation",   r"fitness|\bgym\b|athletic|\bleague\b|\bcamp\b|recreation|martial arts"),
    ("nonprofit",           r"nonprofit|non-profit|charit|foundation|\bchurch\b|ministr"),
    ("ecommerce",           r"\bshop\b|\bstore\b|ecommerce|e-commerce|online order"),
    ("manufacturer",        r"manufactur|distribut|dealer network|wholesale"),
    ("technology",          r"\bsaas\b|software|\bapi\b|platform|developer tool"),
    ("private-equity",      r"private equity|holdings|portfolio compan|acquisition"),
    ("consulting-marketing",r"marketing agenc|branding|consulting|fractional cmo|\bpr firm\b"),
    ("professional",        r"account(ing|ant)|insurance|financial advis|\bIT\b|\bMSP\b|title compan|lending|mortgage"),
    ("lifestyle-concierge", r"concierge|estate manage|private chef|luxury service"),
    ("personal-brand",      r"speaker|\bauthor\b|\bcoach\b|personal brand"),
    ("trades",              r"hvac|plumb|electric|roof|\bpest\b|clean|air condition|heating|duct|"
                            r"refrigerat|mechanical|drain|sewer|septic|garage door|restoration|"
                            r"insulation|solar|\bmaid|dumpster|paving|pavement|landscap|pool|"
                            r"chimney|gutter|fence|window|siding|handyman|appliance|water heater"),
]


def editions():
    """Fetch the canonical edition list. Uses curl, not urllib: the python.org
    build on this machine ships no CA bundle and fails TLS verification."""
    try:
        out = subprocess.run(["curl", "-sSL", "--fail", "--max-time", "15", EDITIONS_URL],
                             capture_output=True, text=True, check=True).stdout
        data = json.loads(out)
        if not isinstance(data, list) or not data:
            raise ValueError("editions.json was not a non-empty list")
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, "w") as f:
            json.dump(data, f)
        return data
    except Exception as e:
        if os.path.exists(CACHE):
            print(f"warn: live editions.json unavailable ({e}); using cache", file=sys.stderr)
            return json.load(open(CACHE))
        raise


MAX_DUE_DAYS = 5


def due_phrase(due, due_date, allow_far=False):
    """Build the deadline phrase, deriving the weekday from a real date.

    Hand-written phrases drift: the 2026-09-15 batch went out saying
    "Wednesday, September 17" when the 17th was a Thursday. Pass --due-date
    YYYY-MM-DD and the weekday is computed, never typed.
    """
    if due_date:
        d = datetime.date.fromisoformat(due_date)
        out = (d - datetime.date.today()).days
        if out > MAX_DUE_DAYS and not allow_far:
            sys.exit(
                f"--due-date {due_date} is {out} days out. HBIS turnaround is a "
                f"day or two (Kimberly, 2026-09-21); every logged batch ran 1-3 "
                f"days. A long deadline is one the client drifts past.\n"
                f"Pass a nearer date, or --far-due if the operator explicitly "
                f"set this one.")
        if out < 0:
            sys.exit(f"--due-date {due_date} is in the past.")
        return f"end of day {d:%A}, {d:%B} {d.day}"
    if due:
        m = re.search(r'(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+'
                      r'(January|February|March|April|May|June|July|August|'
                      r'September|October|November|December)\s+(\d{1,2})', due)
        if m:
            named, month, day = m.group(1) + "day", m.group(2), int(m.group(3))
            year = datetime.date.today().year
            month_n = datetime.datetime.strptime(month, "%B").month
            actual = datetime.date(year, month_n, day).strftime("%A")
            if actual != named:
                sys.exit(f"--due says '{named}' but {month} {day}, {year} is a "
                         f"{actual}. Fix it, or pass --due-date {year}-{month_n:02d}-{day:02d}.")
    return due


def mention_tag(ids):
    """Render one or more Slack user IDs as a leading-space @mention string.

    A plain first name does NOT notify anyone — Slack only pings on a real
    <@Uxxxx> tag. Several clients in the 2026-09-15 batch never saw their
    message partly for this reason. Pass every account the client uses; some
    have two (a personal one and a company one) and only one is watched.

    In the Slack greeting the tag REPLACES the first name (CIWG house style),
    so the line reads `Hi @themF 👋`. The plain name is only the fallback when
    the client has no Slack account to tag; email always uses the name.
    """
    ids = [i.strip() for i in (ids or "").split(",") if i.strip()]
    return "".join(f" <@{i}>" for i in ids)


def describe(repo, slug):
    """Pull ONLY the fields that describe what the business does.

    Deliberately narrow. Dumping the whole config produces false positives:
    `manufacturer` is a Carrier/Trane dealer field and `legalName` is on every
    config, so a full-JSON match called an HVAC shop a manufacturer and a maid
    service a law firm. These four fields are the ones a human would read.
    """
    path = os.path.join(repo, "clients", f"{slug}.json")
    if not os.path.exists(path):
        return None, None, ""
    cfg = json.load(open(path))
    seo = cfg.get("seo", {}) or {}
    extras = cfg.get("siteExtras", {}) or {}
    desc = seo.get("defaultDescription", "") or ""
    services = extras.get("services") or extras.get("serviceList") or []
    if isinstance(services, list):
        services = ", ".join(str(x) for x in services[:12])
    blob = " ".join([cfg.get("clientName", ""), cfg.get("productionDomain", ""),
                     desc, str(services), str(extras.get("tagline", ""))]).lower()
    return cfg, blob, desc


def probe_site(slug, domain=None):
    """No client config yet? Read the live site's meta description instead.

    Most HBIS recipients have a Slack channel but no clients/<slug>.json --
    they have not started a Hydra build, which is the whole point of sending
    them the brief. Their current website is the best available signal.
    """
    host = domain or f"{slug}.com"
    for url in (f"https://{host}", f"https://www.{host}"):
        try:
            page = subprocess.run(
                ["curl", "-sSL", "--fail", "--max-time", "12", "-A", "Mozilla/5.0", url],
                capture_output=True, text=True, check=True).stdout
        except Exception:
            continue
        for pat in (r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']{20,400})',
                    r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']{20,400})',
                    r'<title[^>]*>([^<]{10,200})</title>'):
            m = re.search(pat, page, re.I)
            if m:
                return html.unescape(re.sub(r"\s+", " ", m.group(1)).strip()), host
    return "", host


def guess(blob):
    if not blob:
        return None, "none", "no config"
    for key, pat in RULES:
        m = re.search(pat, blob, re.I)
        if m:
            conf = "low" if key == "trades" and not re.search(
                r"hvac|plumb|electric|roof|air condition|heating", blob, re.I) else "high"
            return key, conf, m.group(0)
    return None, "low", "no signal matched"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["plan", "render", "batch"])
    ap.add_argument("--slugs"); ap.add_argument("--slug")
    ap.add_argument("--csv", help="batch mode: the filled-in address CSV")
    ap.add_argument("--out", help="batch mode: directory to write emails into")
    ap.add_argument("--edition"); ap.add_argument("--due", default="{{DUE}}")
    ap.add_argument("--far-due", action="store_true",
                    help="allow a due date more than %d days out; only when "
                         "the operator explicitly set it" % MAX_DUE_DAYS)
    ap.add_argument("--due-date", dest="due_date",
                    help="YYYY-MM-DD; the weekday is derived, never typed")
    # No defaults: these sign a client-facing message, so the operator's own
    # name and title must be supplied every run. A default here once meant one
    # person's name on everyone else's outreach.
    ap.add_argument("--sender", default=os.environ.get("HBIS_SENDER"),
                    help="operator's full name (or $HBIS_SENDER). REQUIRED.")
    ap.add_argument("--title", default=os.environ.get("HBIS_TITLE"),
                    help="operator's CI Web Group title (or $HBIS_TITLE). "
                         "REQUIRED.")
    ap.add_argument("--name")
    ap.add_argument("--mention", default="",
                    help="Slack user ID(s) of the client, comma-separated "
                         "(e.g. U0AAAAAAAAA,U0BBBBBBBBB). Renders as a real "
                         "@mention so the client actually gets notified.")
    ap.add_argument("--in-progress", dest="in_progress", action="store_true",
                    help="the build is ALREADY underway: no queue language, no "
                         "'build doesn't start' - frames the brief as shaping "
                         "the build vs correcting it afterwards")
    ap.add_argument("--in-slack", dest="in_slack", action="store_true",
                    help="email variant for a contact already in the channel: "
                         "points back to Slack instead of walking them into it")
    ap.add_argument("--email", action="store_true",
                    help="render the email variant (adds the Slack-setup prompt)")
    ap.add_argument("--channel", default="your project channel",
                    help="Slack channel name, for the email variant's setup prompt")
    ap.add_argument("--probe", action="store_true",
                    help="for slugs with no config, read the live site for a description")
    ap.add_argument("--repo", default=os.path.expanduser(
        "~/Desktop/CIWG Sites/hydra-sites"))
    a = ap.parse_args()

    # Any mode that renders client-facing copy must be signed by the operator
    # running it. Fail here, loudly, rather than letting a None reach
    # a.sender.split() as an AttributeError three frames down.
    if a.mode in ("render", "batch"):
        for flag, val in (("--sender", a.sender), ("--title", a.title)):
            if not (val or "").strip():
                sys.exit(
                    f"{flag} is required for `{a.mode}` and has no default.\n"
                    f"This signs a message that reaches a client, so it must "
                    f"be the name and title of whoever is running this.\n"
                    f"Pass {flag}, or export "
                    f"{'HBIS_SENDER' if flag == '--sender' else 'HBIS_TITLE'}.")

    eds = {e["key"]: e for e in editions()}


    if a.mode == "batch":
        import csv as _csv
        out = os.path.expanduser(a.out or ".")
        os.makedirs(out, exist_ok=True)
        tpl = open(os.path.join(HERE, "email-template.md")).read()
        missing = []
        for row in _csv.DictReader(open(os.path.expanduser(a.csv))):
            slug = (row.get("slug") or "").strip()
            if not slug:
                continue
            addr = (row.get("email") or "").strip()
            if not addr:
                missing.append(slug)
            key = (row.get("edition") or "").strip() or "trades"
            e = eds.get(key)
            if not e:
                sys.exit(f"{slug}: unknown edition '{key}'")
            body = tpl
            for token, val in [
                ("CLIENT_NAME", (row.get("contact_first_name") or "there").strip()),
                ("EDITION_LABEL", e["label"]), ("EDITION_URL", e["href"]),
                ("DUE", due_phrase(a.due, a.due_date, a.far_due)), ("SENDER", a.sender),
                ("SENDER_FIRST", a.sender.split()[0]), ("TITLE", a.title),
                ("CHANNEL", (row.get("slack_channel") or "your project channel").strip()),
                ("MENTION", ""),
            ]:
                body = body.replace("{{" + token + "}}", val)
            left = re.findall(r"\{\{(\w+)\}\}", body)
            if left:
                sys.exit(f"{slug}: unfilled placeholders {left}")
            with open(os.path.join(out, f"{slug}.md"), "w") as f:
                f.write(f"To: {addr or '?? NEED ADDRESS ??'}\n" + body)
            print(f"wrote {slug}.md -> {addr or 'NEED ADDRESS'}")
        if missing:
            print(f"\nstill missing an address: {', '.join(missing)}", file=sys.stderr)
        return

    if a.mode == "plan":
        print("slug\tclientName\teditionKey\teditionLabel\teditionURL\tconfidence\tsignal\tdescription")
        for entry in [s.strip() for s in a.slugs.split(",") if s.strip()]:
            slug, _, dom = entry.partition("=")
            dom = dom or None
            cfg, blob, desc = describe(a.repo, slug)
            name = (cfg or {}).get("clientName", "") or "?? NO CONFIG ??"
            if cfg is None and a.probe:
                desc, host = probe_site(slug, dom)
                blob = f"{slug} {host} {desc}".lower()
                if desc:
                    name = f"?? CONFIRM ?? (from {host})"
            key, conf, sig = guess(blob)
            e = eds.get(key, {})
            print("\t".join([slug, name, key or "?", e.get("label", "?? PICK ONE ??"),
                             e.get("href", ""), conf, sig, desc[:180] or "(no description)"]))
        return

    e = eds.get(a.edition)
    if not e:
        sys.exit(f"unknown edition '{a.edition}'. valid: {', '.join(eds)}")
    cfg, _, _ = describe(a.repo, a.slug)
    name = a.name or (cfg or {}).get("clientName") or a.slug
    if a.email:
        if a.in_slack:
            which = "email-template-inslack.md"
        elif a.in_progress:
            which = "email-template-inprogress.md"
        else:
            which = "email-template.md"
    elif a.in_progress:
        which = "message-template-inprogress.md"
    else:
        which = "message-template.md"
    tpl = open(os.path.join(HERE, which)).read()
    for token, val in [("CLIENT_NAME", name), ("EDITION_LABEL", e["label"]),
                       ("EDITION_URL", e["href"]), ("DUE", due_phrase(a.due, a.due_date, a.far_due)), ("SENDER", a.sender),
                       ("SENDER_FIRST", a.sender.split()[0]), ("TITLE", a.title),
                       ("CHANNEL", a.channel), ("MENTION", mention_tag(a.mention)),
                       ("GREETING", mention_tag(a.mention).strip() or name)]:
        tpl = tpl.replace("{{" + token + "}}", val)
    # The Gmail connector silently replaces `www.`-prefixed URLs with the
    # literal text "[link removed]" (observed 2026-09-29 on a client batch: the
    # prompt-trades and /hbis/example links both died, the bare-domain /hbis
    # link survived). Both forms serve 200, and the bare form was chosen
    # form, so normalise every ciwebgroup URL here -- this also catches the
    # EDITION_URL that arrives www-prefixed from the live editions feed.
    tpl = tpl.replace("https://www.ciwebgroup.com/", "https://ciwebgroup.com/")
    left = re.findall(r"\{\{(\w+)\}\}", tpl)
    if left:
        sys.exit(f"unfilled placeholders: {left}")
    print(tpl, end="")


if __name__ == "__main__":
    main()
