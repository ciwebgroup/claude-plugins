#!/usr/bin/env bash
# Mobile PageSpeed (Lighthouse lab) on a few pages of a Hydra site, 3 runs each, median kept.
#
#   pagespeed.sh <work-dir> <base-url> <path> [<path> ...]
#   pagespeed.sh /tmp/review/examplehvac https://examplehvac-stg.ciwebgroup.com / /air-conditioning/ac-repair
#
# Tries the public PageSpeed Insights API first: the same numbers leadership re-checks after
# go-live. Set PAGESPEED_API_KEY for a real quota; without one Google often answers 429. Any run
# PSI refuses is re-run locally with Lighthouse 12 (`npx -y lighthouse@12`, the engine behind
# `hydra performance` and PSI, same mobile lab profile), and the row says which source it used.
# RUNS overrides the run count (default 3). Each run takes 20-60s, so run this in the background.
#
# Writes into <work-dir>/psi/:
#   <page>-<n>.json   raw PSI response (or wrapped local Lighthouse report) per run (path with "/" -> "_", homepage = _home)
#   summary.tsv       one row per page: median score, LCP, TBT, CLS, FCP, runs, source, PASS/FAIL, notes
# and prints summary.tsv. Field (real-user) data is ignored on purpose: on a staging host it
# is empty, and on a domain that just migrated it still describes the old site.
set -euo pipefail
WD="$1"; BASE="${2%/}"; shift 2
RUNS="${RUNS:-3}"
mkdir -p "$WD/psi"
cd "$WD/psi"

for p in "$@"; do
  f=$(printf '%s' "$p" | tr / _); [ "$f" = "_" ] && f=_home
  for n in $(seq 1 "$RUNS"); do
    curl -sS -G --max-time 120 "https://www.googleapis.com/pagespeedonline/v5/runPagespeed" \
      --data-urlencode "url=$BASE$p" -d strategy=mobile -d category=performance \
      ${PAGESPEED_API_KEY:+-d key="$PAGESPEED_API_KEY"} -o "$f-$n.json" || true
    if ! grep -q '"lighthouseResult"' "$f-$n.json" 2>/dev/null; then
      npx -y lighthouse@12 "$BASE$p" --only-categories=performance --output=json \
        --output-path="$f-$n.lh.json" --quiet --chrome-flags="--headless=new" >/dev/null 2>&1 || true
      [ -s "$f-$n.lh.json" ] && python3 -c 'import json,sys; json.dump({"lighthouseResult": json.load(open(sys.argv[1])), "source": "local"}, open(sys.argv[2], "w"))' "$f-$n.lh.json" "$f-$n.json"
    fi
  done
done

python3 - "$RUNS" "$@" <<'PY'
import json, statistics, sys
runs, paths = int(sys.argv[1]), sys.argv[2:]
# The go-live standard: 90+ mobile, and every Core Web Vital in Google's "good" band.
BAR = {"score": 90, "lcp": 2.5, "tbt": 200, "cls": 0.1}
rows = ["page\tscore\tlcp_s\ttbt_ms\tcls\tfcp_s\truns\tsource\tresult\tnotes"]
for p in paths:
    f = p.replace("/", "_") if p != "/" else "_home"
    got, errs, src, lcp_el = [], [], set(), ""
    for n in range(1, runs + 1):
        try:
            d = json.load(open(f"{f}-{n}.json"))
        except Exception as e:
            errs.append(f"run {n}: unreadable"); continue
        if "error" in d:
            errs.append(f"run {n}: {d['error'].get('code')} {d['error'].get('message', '')[:60]}"); continue
        lh = d["lighthouseResult"]; a = lh["audits"]
        if lh.get("runtimeError"):
            errs.append(f"run {n}: {lh['runtimeError'].get('code')}"); continue
        src.add(d.get("source", "psi"))
        got.append({
            "score": round(lh["categories"]["performance"]["score"] * 100),
            "lcp": a["largest-contentful-paint"]["numericValue"] / 1000,
            "tbt": a["total-blocking-time"]["numericValue"],
            "cls": a["cumulative-layout-shift"]["numericValue"],
            "fcp": a["first-contentful-paint"]["numericValue"] / 1000,
        })
        try:  # what the LCP is, so the fix item can name it (an <h1> inside an astro-island = client-rendered hero)
            node = a["largest-contentful-paint-element"]["details"]["items"][0]["items"][0]["node"]
            lcp_el = node.get("selector", "") + (" [in astro-island]" if "ASTRO-ISLAND" in node.get("path", "") else "")
        except (KeyError, IndexError, TypeError):
            pass
    if not got:
        rows.append(f"{p}\t-\t-\t-\t-\t-\t0/{runs}\t-\tNO DATA\t{'; '.join(errs)}"); continue
    m = {k: statistics.median(r[k] for r in got) for k in got[0]}
    fails = [k for k in BAR if (m[k] < BAR[k] if k == "score" else m[k] > BAR[k])]
    spread = max(r["score"] for r in got) - min(r["score"] for r in got)
    notes = [f"misses {', '.join(fails)}"] if fails else []
    if spread >= 15: notes.append(f"runs vary by {spread} pts")
    if "lcp" in fails and lcp_el: notes.append(f"LCP element: {lcp_el}")
    notes += errs
    rows.append(f"{p}\t{m['score']:.0f}\t{m['lcp']:.1f}\t{m['tbt']:.0f}\t{m['cls']:.2f}\t{m['fcp']:.1f}"
                f"\t{len(got)}/{runs}\t{'+'.join(sorted(src))}\t{'FAIL' if fails else 'PASS'}\t{'; '.join(notes)}")
open("summary.tsv", "w").write("\n".join(rows) + "\n")
print("\n".join(rows))
PY
