/**
 * Which client a session is working on, from the files it touches.
 *
 * hydra-sites keeps every client in `clients/<slug>.json`, `overrides/<slug>/`
 * and `.memory/long-term/<slug>.md`. A PostToolUse hook records those
 * client-shaped paths per session; the prompt hook sends them so the server
 * can inject the right client's profile without anyone naming the client.
 *
 * Only the client-shaped PART of a path is kept and sent (e.g.
 * "overrides/goldstarplumbingaz/"), never the full path or any other file.
 */

import { mkdirSync, readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { ciwgDir, ensureCiwgDir, readJson, rmQuiet, writeJsonAtomic } from "./paths.mjs"

export const MAX_PATHS = 10
const SESSION_FILE_TTL_MS = 2 * 24 * 60 * 60 * 1000

const SLUG = String.raw`[a-z0-9][a-z0-9-]*[a-z0-9]`
const SEP = String.raw`[\\/]`
const CLIENT_PATH = new RegExp(
    String.raw`(?:^|${SEP})(clients${SEP}${SLUG}\.json|overrides${SEP}${SLUG}(?=${SEP}|$)|\.memory${SEP}long-term${SEP}${SLUG}\.md)`,
    "i"
)

/** The client-shaped fragment of a path, forward-slashed, or null. */
export function clientShapedPath(filePath) {
    if (typeof filePath !== "string") return null
    const match = CLIENT_PATH.exec(filePath)
    if (!match) return null
    const fragment = match[1].split("\\").join("/")
    if (fragment.toLowerCase().startsWith("clients/_")) return null
    return fragment.toLowerCase().startsWith("overrides/") ? `${fragment}/` : fragment
}

const sessionsDir = () => join(ciwgDir(), "sessions")
const safeId = (sessionId) => String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)
const pathsFile = (sessionId) => join(sessionsDir(), `${safeId(sessionId)}.paths.json`)

/** Client-shaped paths this session touched, newest first. */
export function recentClientPaths(sessionId) {
    if (!sessionId) return []
    const saved = readJson(pathsFile(sessionId))
    return Array.isArray(saved?.paths) ? saved.paths.filter((p) => typeof p === "string").slice(0, MAX_PATHS) : []
}

/** Remember a touched file when it belongs to a client. Never throws. */
export function rememberClientPath(sessionId, filePath, now = Date.now()) {
    const fragment = clientShapedPath(filePath)
    if (!sessionId || !fragment) return false
    try {
        ensureCiwgDir()
        mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 })
        const paths = [fragment, ...recentClientPaths(sessionId).filter((p) => p !== fragment)].slice(0, MAX_PATHS)
        writeJsonAtomic(pathsFile(sessionId), { paths, updatedAt: now })
        pruneOldSessions(now)
        return true
    } catch {
        return false
    }
}

function pruneOldSessions(now) {
    try {
        for (const name of readdirSync(sessionsDir())) {
            const full = join(sessionsDir(), name)
            if (now - statSync(full).mtimeMs > SESSION_FILE_TTL_MS) rmQuiet(full)
        }
    } catch {
        /* pruning is best-effort */
    }
}

/** The working folder's name: hydra-sites worktrees are named for the client. */
export const folderName = (cwd) => (typeof cwd === "string" && cwd ? basename(cwd) : null)
