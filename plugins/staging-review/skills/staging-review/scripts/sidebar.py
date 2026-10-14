#!/usr/bin/env python3
"""Sidebar-menu check for every city page of a crawled Hydra site (SKILL.md, check 6).

    python3 sidebar.py <work-dir> [extra-city-slug ...]

<work-dir> is the folder crawl.sh wrote (sm.txt + pages/). City slugs come from the
site's own /service-areas/<slug> pages; pass extra slugs (e.g. "lodi-ca") if a site
has city-service pages without a matching service-area page.

Every city page needs two sidebar menus:
  1. Service Areas       -> links to /service-areas/<city> pages
  2. Services in <city>  -> links to the OTHER service pages for the SAME city

The first <aside> is often the request form, so links are collected from every
sidebar-like block (<aside>, class "sidebar", or a sticky column) on the page.
Prints a summary and writes <work-dir>/sidebar.json with per-page detail.
"""
import glob
import json
import os
import re
import sys
from html.parser import HTMLParser

wd = sys.argv[1]
sm = {l.strip().rstrip("/") or "/" for l in open(os.path.join(wd, "sm.txt")) if l.strip()}
cities = sorted(
    {p.split("/")[-1] for p in sm if p.startswith("/service-areas/") and p.count("/") == 2} | set(sys.argv[2:]),
    key=len,
    reverse=True,
)


def city_of(path):
    for c in cities:
        if path.endswith("-" + c) or path.endswith("/" + c):
            return c
    return None


class Sidebars(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.blocks, self.cur = [], [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        side = tag == "aside" or re.search(r"\bsidebar\b", cls, re.I) or "lg:sticky" in cls
        self.stack.append(side)
        if side and self.cur is None:
            self.cur = {"links": [], "depth": len(self.stack)}
        href = a.get("href") or ""
        if tag == "a" and self.cur is not None and href.startswith("/"):
            self.cur["links"].append(href.split("#")[0].rstrip("/") or "/")

    def handle_endtag(self, tag):
        if self.stack:
            self.stack.pop()
            if self.cur is not None and len(self.stack) < self.cur["depth"]:
                self.blocks.append(self.cur)
                self.cur = None


rows = []
for f in sorted(glob.glob(os.path.join(wd, "pages", "*.html"))):
    name = os.path.basename(f)[:-5]
    path = "/" if name == "_home" else "/" + name[1:].replace("_", "/")
    if path.startswith("/blog") or path in ("/service-areas", "/"):
        continue
    city = city_of(path)
    if not city:
        continue
    p = Sidebars()
    p.feed(open(f, encoding="utf-8", errors="ignore").read())
    links = {l for b in p.blocks for l in b["links"]}
    areas = {l for l in links if l.startswith("/service-areas/")}
    same = {l for l in links if city_of(l) == city and not l.startswith("/service-areas/") and l != path}
    other = {l for l in links if city_of(l) not in (None, city) and not l.startswith("/service-areas/")}
    broken = {l for l in links if l not in sm and l != "/" and not l.startswith(("/blog", "/contact"))}
    rows.append({
        "path": path, "city": city, "sidebars": len(p.blocks),
        "area_links": len(areas), "same_city_links": len(same),
        "other_city_links": sorted(other)[:5], "broken_links": sorted(broken)[:5],
    })

json.dump(rows, open(os.path.join(wd, "sidebar.json"), "w"), indent=1)
n_area_pages = sum(1 for p in sm if p.startswith("/service-areas/") and p.count("/") == 2)


def count(pred):
    return sum(1 for r in rows if pred(r))


print(f"{os.path.basename(wd.rstrip('/'))}: {len(rows)} city pages, {n_area_pages} service-area pages")
print(f"  no sidebar at all:              {count(lambda r: r['sidebars'] == 0)}")
print(f"  missing Service Areas menu:     {count(lambda r: r['area_links'] == 0)}")
if rows:
    al = [r["area_links"] for r in rows if r["area_links"]]
    print(f"  Service Areas links per page:   min {min(al) if al else 0} / max {max(al) if al else 0}"
          f" (all other areas = {max(n_area_pages - 1, 0)})")
print(f"  missing services-in-city menu:  {count(lambda r: r['same_city_links'] == 0)}")
print(f"  with other-city service links:  {count(lambda r: r['other_city_links'])}"
      "  (a 'same service in nearby towns' block is fine ONLY alongside both required menus)")
print(f"  with broken sidebar links:      {count(lambda r: r['broken_links'])}")
for label, pred in (("missing services-in-city", lambda r: r["same_city_links"] == 0),
                    ("missing Service Areas", lambda r: r["area_links"] == 0)):
    sample = [r["path"] for r in rows if pred(r)][:5]
    if sample:
        print(f"  e.g. {label}: {', '.join(sample)}")
