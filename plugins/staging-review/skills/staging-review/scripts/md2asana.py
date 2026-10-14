#!/usr/bin/env python3
"""Turn a markdown fix list into Asana comment html_text, with the Viber @-mentioned.

    python3 md2asana.py <fixlist.md> <viber-asana-user-gid> "<opening sentence>"

Supports what fix lists use: #-headings (rendered bold), "1." and "-" lists,
**bold**, `code` and bare URLs. Output is validated as XML, because Asana rejects
html_text that is not well-formed, and printed to stdout for add_comment.
Asana's <ol> has no start attribute, so each section's numbering restarts at 1.
"""
import html
import re
import sys
import xml.dom.minidom

src, gid, opening = sys.argv[1], sys.argv[2], sys.argv[3]


def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    # keep trailing sentence punctuation outside the link
    t = re.sub(r"(https?://[^\s)<]+?)([.,;]?)(?=[\s<]|$)", lambda m: f'<a href="{m.group(1)}">{m.group(1)}</a>{m.group(2)}', t)
    return t


out = [f'<body><a data-asana-gid="{gid}"/> {html.escape(opening, quote=False)}\n\n']
mode = None


def close():
    global mode
    if mode:
        out.append(f"</{mode}>")
        mode = None


for line in open(src, encoding="utf-8").read().splitlines():
    if not line.strip():
        close()
        continue
    m = re.match(r"^#+\s*(.*)", line)
    if m:
        close()
        out.append(f"\n<strong>{inline(m.group(1))}</strong>\n")
        continue
    m = re.match(r"^\d+\.\s+(.*)", line)
    if m:
        if mode != "ol":
            close()
            out.append("<ol>")
            mode = "ol"
        out.append(f"<li>{inline(m.group(1))}</li>")
        continue
    m = re.match(r"^\s*-\s+(.*)", line)
    if m:
        if mode != "ul":
            close()
            out.append("<ul>")
            mode = "ul"
        out.append(f"<li>{inline(m.group(1))}</li>")
        continue
    close()
    out.append(inline(line) + "\n")
close()
out.append("</body>")
doc = "".join(out)
xml.dom.minidom.parseString(doc)
print(doc)
