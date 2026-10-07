// hbis-outreach ships in a PUBLIC repo. Its lessons come from real client
// outreach, so every change risks carrying a client identifier along with
// the rule. This fails the build on the identifiers a pattern can catch.
// Client NAMES cannot be caught here without publishing the very list we are
// protecting — that check runs on the author's machine before the PR.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

const PATTERNS = {
    "Slack ID": /\b[UCDGW]0[0-9A-Z]{8,10}\b/g,
    "Asana GID": /\b1[0-9]{15}\b/g,
    "Slack message ts": /\b1[0-9]{9}\.[0-9]{6}\b/g,
    "Slack draft id": /\bDr0[0-9A-Z]{9}\b/g,
    "email address": /\b[\w.+-]+@(?!example\.com\b)[\w-]+\.[\w.]+\b/g,
    "card digits": /\b(visa|mastercard|amex|card)\s*[•*x]+\s*\d{4}/gi,
    "order number": /\bWEB-\d{6}-[A-Z0-9]{4}\b/g,
}
// Obvious placeholders used in examples: U0AAAAAAAAA, C0XXXXXXXXX, 1700000000.123456
const PLACEHOLDER = /^([UCDGW]0([A-Z])\2+|1700000000\.123456)$/

function* files(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (name === "tests") continue
        if (statSync(p).isDirectory()) yield* files(p)
        else yield p
    }
}

test("hbis-outreach carries no client identifiers", () => {
    const found = []
    for (const p of files(root)) {
        readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
                for (const [kind, rx] of Object.entries(PATTERNS)) {
                    for (const m of line.matchAll(rx)) {
                        if (!PLACEHOLDER.test(m[0])) found.push(`${relative(root, p)}:${i + 1} ${kind}: ${m[0]}`)
                    }
                }
            })
    }
    assert.deepEqual(found, [], `client identifiers found:\n${found.join("\n")}`)
})
