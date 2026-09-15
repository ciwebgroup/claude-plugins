import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const fakeHome = mkdtempSync(join(tmpdir(), "client-paths-home-"))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const { MAX_PATHS, clientShapedPath, folderName, recentClientPaths, rememberClientPath } = await import("../scripts/lib/clientPaths.mjs")

test("keeps only the client-shaped part of hydra-sites paths", () => {
    assert.equal(clientShapedPath("C:\\work\\hydra-sites\\overrides\\goldstarplumbingaz\\Hero.astro"), "overrides/goldstarplumbingaz/")
    assert.equal(clientShapedPath("/home/x/hydra-sites/clients/surewaycomfort.json"), "clients/surewaycomfort.json")
    assert.equal(clientShapedPath(".memory/long-term/airrightac.md"), ".memory/long-term/airrightac.md")
    assert.equal(clientShapedPath("clients/_schema.json"), null)
    assert.equal(clientShapedPath("apps/site/src/pages/index.astro"), null)
    assert.equal(clientShapedPath(undefined), null)
})

test("remembers client paths per session, newest first, deduplicated and capped", () => {
    assert.equal(rememberClientPath("s-1", "src/unrelated.ts"), false)
    rememberClientPath("s-1", "overrides/goldstarplumbingaz/Hero.astro")
    rememberClientPath("s-1", "clients/goldstarplumbingaz.json")
    rememberClientPath("s-1", "overrides/goldstarplumbingaz/Footer.astro")
    assert.deepEqual(recentClientPaths("s-1"), ["overrides/goldstarplumbingaz/", "clients/goldstarplumbingaz.json"])
    for (let i = 0; i < MAX_PATHS + 5; i++) rememberClientPath("s-2", `overrides/client${i}x/a.astro`)
    assert.equal(recentClientPaths("s-2").length, MAX_PATHS)
    assert.deepEqual(recentClientPaths("never-seen"), [])
})

test("stores nothing but the fragments", () => {
    const dir = join(fakeHome, ".ciwg", "sessions")
    const file = readdirSync(dir).find((n) => n.startsWith("s-1"))
    const saved = readFileSync(join(dir, file), "utf8")
    assert.ok(!saved.includes("Hero.astro"))
})

test("names the working folder", () => {
    assert.equal(folderName(join("worktrees", "feat-design-ryan-lloyd-goldstarplumbingaz")), "feat-design-ryan-lloyd-goldstarplumbingaz")
    assert.equal(folderName(undefined), null)
})
