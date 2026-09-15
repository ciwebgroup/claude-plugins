import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const fakeHome = mkdtempSync(join(tmpdir(), "client-paths-home-"))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const { MAX_PATHS, SITE_REPO, clientFacts, clientShapedPath, folderName, hydraSitesRoot, recentClientPaths, rememberClientPath } =
    await import("../scripts/lib/clientPaths.mjs")

/** A minimal hydra-sites checkout: identified by its own marker files. */
function fakeHydra(name) {
    const root = join(mkdtempSync(join(tmpdir(), "hydra-")), name)
    mkdirSync(join(root, "clients"), { recursive: true })
    mkdirSync(join(root, "overrides", "goldstarplumbingaz", "components"), { recursive: true })
    writeFileSync(join(root, "core-policy.json"), "{}")
    writeFileSync(join(root, "clients", "_schema.json"), "{}")
    return root
}
const hydra = fakeHydra("feat-design-ryan-lloyd-goldstarplumbingaz")
const elsewhere = mkdtempSync(join(tmpdir(), "docs-site-"))
mkdirSync(join(elsewhere, "overrides", "partials"), { recursive: true })

test("keeps only the client-shaped part of hydra-sites paths", () => {
    assert.equal(clientShapedPath("C:\\work\\hydra-sites\\overrides\\goldstarplumbingaz\\Hero.astro"), "overrides/goldstarplumbingaz/")
    assert.equal(clientShapedPath("/home/x/hydra-sites/clients/surewaycomfort.json"), "clients/surewaycomfort.json")
    assert.equal(clientShapedPath(".memory/long-term/airrightac.md"), ".memory/long-term/airrightac.md")
    assert.equal(clientShapedPath("clients/_schema.json"), null)
    assert.equal(clientShapedPath("apps/site/src/pages/index.astro"), null)
    assert.equal(clientShapedPath(undefined), null)
})

test("recognises a hydra-sites checkout by its files, from any depth", () => {
    assert.equal(hydraSitesRoot(join(hydra, "overrides", "goldstarplumbingaz", "components")), hydra)
    assert.equal(hydraSitesRoot(join(elsewhere, "overrides", "partials")), null)
})

test("remembers client files only inside hydra-sites, newest first, deduplicated and capped", () => {
    assert.equal(rememberClientPath("s-1", "src/unrelated.ts", hydra), false)
    // An MkDocs-style overrides/ folder in another repo is not a client.
    assert.equal(rememberClientPath("s-1", join(elsewhere, "overrides", "partials", "main.html"), elsewhere), false)
    rememberClientPath("s-1", join(hydra, "overrides", "goldstarplumbingaz", "components", "Hero.astro"), hydra)
    rememberClientPath("s-1", "clients/goldstarplumbingaz.json", hydra)
    rememberClientPath("s-1", "overrides/goldstarplumbingaz/Footer.astro", hydra)
    assert.deepEqual(recentClientPaths("s-1"), ["overrides/goldstarplumbingaz/", "clients/goldstarplumbingaz.json"])
    for (let i = 0; i < MAX_PATHS + 5; i++) rememberClientPath("s-2", `overrides/client${i}x/a.astro`, hydra)
    assert.equal(recentClientPaths("s-2").length, MAX_PATHS)
    assert.deepEqual(recentClientPaths("never-seen"), [])
})

test("stores nothing but the fragments", () => {
    const dir = join(fakeHome, ".ciwg", "sessions")
    const file = readdirSync(dir).find((n) => n.startsWith("s-1"))
    const saved = readFileSync(join(dir, file), "utf8")
    assert.ok(!saved.includes("Hero.astro"))
})

test("sends client facts from a hydra-sites checkout and nothing from anywhere else", () => {
    const inside = clientFacts("s-1", hydra)
    assert.equal(inside.siteRepo, SITE_REPO)
    assert.equal(inside.folder, "feat-design-ryan-lloyd-goldstarplumbingaz")
    assert.equal(inside.paths[0], "overrides/goldstarplumbingaz/")
    assert.deepEqual(clientFacts("s-1", elsewhere), { siteRepo: null, paths: [], folder: null })
})

test("names the working folder", () => {
    assert.equal(folderName(join("worktrees", "feat-design-ryan-lloyd-goldstarplumbingaz")), "feat-design-ryan-lloyd-goldstarplumbingaz")
    assert.equal(folderName(undefined), null)
})
