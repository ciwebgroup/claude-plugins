#!/usr/bin/env bash
# Crawl every URL in a Hydra site's sitemap.xml (plus the homepage) into a work dir.
#
#   crawl.sh <work-dir> <base-url>
#   crawl.sh /tmp/review/examplehvac https://examplehvac-stg.ciwebgroup.com
#
# Writes into <work-dir>:
#   sm.txt          one path per line, from sitemap.xml ("/" always included)
#   codes.txt       "<http-status> <path>" per page
#   pages/*.html    raw HTML   (path with "/" -> "_", homepage = _home.html)
#   pages/*.txt     tag-stripped text, for grepping copy
#   pms-config.txt  pages missing window.__PMS_CONFIG__ (see SKILL.md, check 4)
# and prints a one-line summary.
set -euo pipefail
WD="$1"; BASE="${2%/}"
mkdir -p "$WD/pages"
cd "$WD/pages"

{ echo "/"; curl -fsS "$BASE/sitemap.xml" | grep -oE '<loc>[^<]*' | sed -E 's#<loc>https?://[^/]+##; s#<loc>##'; } \
  | sed -E 's#/+$##; s#^$#/#' | sort -u > ../sm.txt

fetch() {
  local p="$1" f
  f=$(printf '%s' "$p" | tr / _); [ "$f" = "_" ] && f=_home
  printf '%s %s\n' "$(curl -s -o "$f.html" -w '%{http_code}' "$BASE$p")" "$p"
}
export -f fetch; export BASE
xargs -P 12 -I{} bash -c 'fetch "{}"' < ../sm.txt > ../codes.txt

python3 - <<'PY'
import glob, html, re
for f in glob.glob("*.html"):
    t = open(f, encoding="utf-8", errors="ignore").read()
    t = re.sub(r"(?s)<(script|style)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"<[^>]+>", " ", t)
    open(f[:-5] + ".txt", "w").write(html.unescape(re.sub(r"\s+", " ", t)))
missing = [f for f in sorted(glob.glob("*.html"))
           if "__PMS_CONFIG__" not in open(f, encoding="utf-8", errors="ignore").read()]
open("../pms-config.txt", "w").write("\n".join(missing) + ("\n" if missing else ""))
PY

total=$(wc -l < ../sm.txt | tr -d ' ')
bad=$(grep -vc '^200' ../codes.txt || true)
nopms=$(grep -c . ../pms-config.txt || true)
echo "$(basename "$WD"): $total pages, non-200: $bad, missing __PMS_CONFIG__: $nopms"
