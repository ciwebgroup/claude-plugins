/**
 * Engram digest construction — the pure, testable half of the SessionEnd
 * hook (engram-post.mjs is a thin stdin runner around this).
 *
 * PRIVACY HARD RULE: a digest is STRUCTURED FACTS ONLY — repo/branch names,
 * change counts, top paths, client mapping, timing. This module never reads
 * or transmits the session transcript, conversation text, or prompt text.
 * The only touch of the transcript file is fs.stat METADATA (birthtime → a
 * duration estimate); its contents are never opened. The server enforces
 * the same rule with a closed payload whitelist.
 */

import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { basename } from "node:path"
import { debug, getClientMapping } from "./config.mjs"

const GIT_TIMEOUT_MS = 1500
const TOP_PATHS_MAX = 5
const PATH_MAX_CHARS = 200

/** Run one git command; RAW stdout (porcelain status is column-sensitive —
 * a global trim would eat the first line's leading status space), or null
 * on ANY failure (no git, not a repo, timeout). */
function git(cwd, args) {
    try {
        return execFileSync("git", args, {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        })
    } catch (error) {
        debug("git", args[0], "failed:", error.message)
        return null
    }
}

/**
 * Repo identity = basename of the git toplevel, or null outside a git repo.
 * Deliberately NOT a cwd-basename fallback: posts from scratch directories
 * would mint noise "repos", and read-side filters must match what writers
 * posted. Writers and readers both call this.
 */
export function detectRepoName(cwd) {
    if (!cwd) return null
    const toplevel = git(cwd, ["rev-parse", "--show-toplevel"])?.trim()
    return toplevel ? basename(toplevel) : null
}

/** One porcelain status line → the path it names (rename → new path). */
function statusLinePath(line) {
    const path = line.slice(3).trim()
    const arrow = path.indexOf(" -> ")
    const chosen = arrow >= 0 ? path.slice(arrow + 4) : path
    return chosen.replace(/^"|"$/g, "").slice(0, PATH_MAX_CHARS)
}

/** Cheap git facts: current status counts + working-tree shortstat. */
export function collectGitFacts(cwd) {
    const facts = {}
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim()
    // Detached HEAD reports the literal string "HEAD" — not a branch name.
    if (branch && branch !== "HEAD") facts.branch = branch.slice(0, 200)

    const status = git(cwd, ["status", "--porcelain"])
    if (status !== null) {
        const lines = status
            .split("\n")
            .map((line) => line.replace(/\r$/, ""))
            .filter((line) => line.trim())
        facts.filesChanged = lines.length
        const topPaths = lines
            .slice(0, TOP_PATHS_MAX)
            .map(statusLinePath)
            .filter(Boolean)
        if (topPaths.length > 0) facts.topPaths = topPaths
    }

    const shortstat = git(cwd, ["diff", "--shortstat", "HEAD"])
    if (shortstat) {
        const insertions = /(\d+) insertion/.exec(shortstat)
        const deletions = /(\d+) deletion/.exec(shortstat)
        if (insertions) facts.insertions = Number(insertions[1])
        if (deletions) facts.deletions = Number(deletions[1])
    }
    return facts
}

const MAX_SESSION_MINUTES = 24 * 60

/**
 * Session duration from the transcript file's CREATION TIME (metadata-only
 * stat — the file is never opened). Null when underivable or implausible
 * (some filesystems report birthtime 0).
 */
export function deriveDurationMinutes(transcriptPath, nowMs = Date.now()) {
    if (!transcriptPath) return null
    try {
        const birth = statSync(transcriptPath).birthtimeMs
        if (!Number.isFinite(birth) || birth <= 0) return null
        const minutes = Math.round((nowMs - birth) / 60_000)
        if (minutes < 0 || minutes > MAX_SESSION_MINUTES) return null
        return minutes
    } catch (error) {
        debug("transcript stat failed:", error.message)
        return null
    }
}

/**
 * Build the structured activity digest for one ended session, or null when
 * the session has no anchor (no git repo AND no client mapping — the server
 * relevance gate would reject it) or is trivial (no changes and under two
 * minutes — a session that opened and closed is not team signal).
 */
export function buildEngramDigest({ cwd, transcriptPath, now = new Date() }) {
    const repo = detectRepoName(cwd)
    const mapping = getClientMapping(cwd)
    if (!repo && mapping?.organizationId == null) {
        debug("no repo and no client mapping — skipping engram post")
        return null
    }

    const facts = repo ? collectGitFacts(cwd) : {}
    const durationMinutes = deriveDurationMinutes(
        transcriptPath,
        now.getTime()
    )
    if ((facts.filesChanged ?? 0) === 0 && (durationMinutes ?? 0) < 2) {
        debug("trivial session (no changes, <2 min) — skipping engram post")
        return null
    }

    const digest = { source: "claude-code-session-end" }
    if (repo) digest.repo = repo
    if (facts.branch) digest.branch = facts.branch
    if (facts.filesChanged !== undefined) {
        digest.filesChanged = facts.filesChanged
    }
    if (facts.insertions !== undefined) digest.insertions = facts.insertions
    if (facts.deletions !== undefined) digest.deletions = facts.deletions
    if (facts.topPaths) digest.topPaths = facts.topPaths
    if (mapping?.organizationId != null) {
        digest.organizationId = mapping.organizationId
    }
    if (mapping?.clientName) digest.clientName = mapping.clientName
    if (durationMinutes !== null) digest.durationMinutes = durationMinutes
    digest.endedAt = now.toISOString()
    return digest
}
