/**
 * Engram hook tests — digest construction against a real throwaway git
 * repo, the opt-out switches and the no-token fail-open (rendering and
 * injection policy live server-side — see knowledge/injection.test.ts). Run from the repo root (pass the files — the directory form
 * is not supported by every Node):
 *
 *   node --test plugins/ciwg-knowledge/tests/engram.test.mjs plugins/ciwg-knowledge/tests/auth.test.mjs
 *
 * No network is touched: the only API-path test asserts the no-token
 * short-circuit. HOME/USERPROFILE are pointed at a throwaway dir so the
 * user's real ~/.ciwg is never read or written.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { after, before, beforeEach, test } from "node:test"

// Isolate ~/.ciwg BEFORE importing the modules under test (config.mjs reads
// homedir() lazily at call time, but belt-and-braces).
const fakeHome = mkdtempSync(join(tmpdir(), "engram-home-"))
const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CIWG_ENGRAM: process.env.CIWG_ENGRAM,
    CIWG_KNOWLEDGE_TOKEN: process.env.CIWG_KNOWLEDGE_TOKEN,
}
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CIWG_ENGRAM
delete process.env.CIWG_KNOWLEDGE_TOKEN

const {
    isEngramOptedOut,
    listEngramActivities,
    postEngramActivity,
    postInject,
} = await import("../scripts/lib/config.mjs")
const { buildEngramDigest, collectGitFacts, detectBranch, detectRepoName } = await import(
    "../scripts/lib/engram.mjs"
)

const git = (cwd, args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true })

let repoDir
let plainDir

before(() => {
    // A real git repo named like a client project, with one commit, a work
    // branch, one tracked modification and one untracked file.
    repoDir = join(mkdtempSync(join(tmpdir(), "engram-repo-")), "acme-hvac")
    mkdirSync(repoDir)
    git(repoDir, ["init", "-b", "main"])
    git(repoDir, ["config", "user.email", "test@example.com"])
    git(repoDir, ["config", "user.name", "Engram Test"])
    writeFileSync(join(repoDir, "a.txt"), "one\n")
    git(repoDir, ["add", "."])
    git(repoDir, ["commit", "-m", "init"])
    git(repoDir, ["checkout", "-b", "checkout-fix"])
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n")
    writeFileSync(join(repoDir, "b.txt"), "new\n")

    plainDir = mkdtempSync(join(tmpdir(), "engram-plain-"))
})

after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        rmSync(fakeHome, { recursive: true, force: true })
        rmSync(join(repoDir, ".."), { recursive: true, force: true })
        rmSync(plainDir, { recursive: true, force: true })
    } catch {
        /* best effort */
    }
})

beforeEach(() => {
    delete process.env.CIWG_ENGRAM
    delete process.env.CIWG_KNOWLEDGE_TOKEN
    rmSync(join(fakeHome, ".ciwg"), { recursive: true, force: true })
})

test("detectRepoName: git toplevel basename, null outside a repo", () => {
    assert.equal(detectRepoName(repoDir), "acme-hvac")
    assert.equal(detectRepoName(plainDir), null)
    assert.equal(detectRepoName(undefined), null)
})

test("detectBranch: the branch, null outside a repo or on a spent budget", () => {
    assert.equal(detectBranch(repoDir), "checkout-fix")
    assert.equal(detectBranch(plainDir), null)
    assert.equal(detectBranch(repoDir, { deadline: Date.now() + 1_000 }), null)
})

test("collectGitFacts: branch, status counts, top paths, shortstat", () => {
    const facts = collectGitFacts(repoDir)
    assert.equal(facts.branch, "checkout-fix")
    assert.equal(facts.filesChanged, 2)
    assert.deepEqual([...facts.topPaths].sort(), ["a.txt", "b.txt"])
    assert.ok(facts.insertions >= 2, `insertions: ${facts.insertions}`)
})

test("git facts are bounded by the hook deadline: a spent budget skips the git calls instead of starting them", () => {
    // Plenty of time: the usual facts.
    assert.equal(detectRepoName(repoDir, { deadline: Date.now() + 10_000 }), "acme-hvac")
    assert.equal(collectGitFacts(repoDir, { deadline: Date.now() + 10_000 }).branch, "checkout-fix")
    // Not enough left for a git call AND the POST that follows: nothing is
    // spawned, so the digest has no repo anchor and the hook exits quietly.
    const spent = Date.now() + 1_000
    const t0 = Date.now()
    assert.equal(detectRepoName(repoDir, { deadline: spent }), null)
    assert.deepEqual(collectGitFacts(repoDir, { deadline: spent }), {})
    assert.equal(buildEngramDigest({ cwd: repoDir, deadline: spent }), null)
    assert.ok(Date.now() - t0 < 200, "skipped calls cost nothing")
})

test("buildEngramDigest: structured facts only, from git + mapping", () => {
    writeFileSync(
        join(repoDir, ".ciwg-client.json"),
        JSON.stringify({ organizationId: 7, clientName: "Acme HVAC" })
    )
    try {
        const digest = buildEngramDigest({ cwd: repoDir })
        assert.equal(digest.repo, "acme-hvac")
        assert.equal(digest.branch, "checkout-fix")
        assert.equal(digest.filesChanged, 3) // a.txt, b.txt, .ciwg-client.json
        assert.equal(digest.organizationId, 7)
        assert.equal(digest.clientName, "Acme HVAC")
        assert.equal(digest.source, "claude-code-session-end")
        assert.ok(!Number.isNaN(Date.parse(digest.endedAt)))
        // The privacy hard rule, mechanically: no free-text fields beyond
        // the whitelisted structured facts.
        const allowed = new Set([
            "repo",
            "branch",
            "organizationId",
            "clientName",
            "filesChanged",
            "insertions",
            "deletions",
            "topPaths",
            "durationMinutes",
            "startedAt",
            "endedAt",
            "source",
        ])
        for (const key of Object.keys(digest)) {
            assert.ok(allowed.has(key), `unexpected digest key: ${key}`)
        }
    } finally {
        rmSync(join(repoDir, ".ciwg-client.json"), { force: true })
    }
})

test("buildEngramDigest: null with no repo and no mapping (relevance gate)", () => {
    assert.equal(buildEngramDigest({ cwd: plainDir }), null)
})

test("buildEngramDigest: mapping alone anchors a repo-less digest", () => {
    writeFileSync(
        join(plainDir, ".ciwg-client.json"),
        JSON.stringify({ organizationId: 9 })
    )
    // Trivial guard would skip a 0-change/0-minute session; a transcript
    // "created" 10 minutes ago (now shifted forward) derives a duration.
    const transcript = join(plainDir, "transcript.jsonl")
    writeFileSync(transcript, "{}\n")
    const digest = buildEngramDigest({
        cwd: plainDir,
        transcriptPath: transcript,
        now: new Date(Date.now() + 10 * 60_000),
    })
    assert.equal(digest.organizationId, 9)
    assert.equal(digest.repo, undefined)
    assert.ok(digest.durationMinutes >= 9, `duration: ${digest.durationMinutes}`)
    rmSync(join(plainDir, ".ciwg-client.json"), { force: true })
})

test("buildEngramDigest: trivial sessions (no changes, <2 min) are skipped", () => {
    const cleanDir = join(mkdtempSync(join(tmpdir(), "engram-clean-")), "tidy")
    mkdirSync(cleanDir)
    git(cleanDir, ["init", "-b", "main"])
    assert.equal(buildEngramDigest({ cwd: cleanDir }), null)
    rmSync(join(cleanDir, ".."), { recursive: true, force: true })
})

test("opt-out: CIWG_ENGRAM env forms", () => {
    assert.equal(isEngramOptedOut(), false)
    for (const value of ["off", "OFF", "0", "false"]) {
        process.env.CIWG_ENGRAM = value
        assert.equal(isEngramOptedOut(), true, `CIWG_ENGRAM=${value}`)
    }
    process.env.CIWG_ENGRAM = "on"
    assert.equal(isEngramOptedOut(), false)
})

test('opt-out: "engram": false in ~/.ciwg/knowledge.json', () => {
    mkdirSync(join(fakeHome, ".ciwg"), { recursive: true })
    const configPath = join(fakeHome, ".ciwg", "knowledge.json")
    writeFileSync(configPath, JSON.stringify({ engram: false }))
    assert.equal(isEngramOptedOut(), true)
    writeFileSync(configPath, JSON.stringify({ engram: true }))
    assert.equal(isEngramOptedOut(), false)
    writeFileSync(configPath, JSON.stringify({}))
    assert.equal(isEngramOptedOut(), false)
})

test("API calls fail open with no token — no network attempted", async () => {
    const post = await postEngramActivity({ repo: "acme-hvac" })
    assert.deepEqual(post, { ok: false, status: "no-token" })
    const list = await listEngramActivities({ repo: "acme-hvac" })
    assert.deepEqual(list, { ok: false, status: "no-token" })
    const inject = await postInject({ event: "prompt", prompt: "what did Acme decide?", facts: { repo: "acme-hvac" } })
    assert.deepEqual(inject, { ok: false, status: "no-token" })
})

test("pluginVersion: the manifest's version, matching what the MCP server reports", async () => {
    const { pluginVersion } = await import("../scripts/lib/paths.mjs")
    const manifest = JSON.parse(
        readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")
    )
    assert.equal(pluginVersion(), manifest.version)
    assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/)
})

test("listEngramActivities refuses an unscoped read", async () => {
    const result = await listEngramActivities({})
    assert.deepEqual(result, { ok: false, status: "no-scope" })
})
