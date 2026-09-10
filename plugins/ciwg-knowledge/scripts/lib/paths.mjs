/**
 * Tiny shared leaf module — the bits config.mjs, auth.mjs and state.mjs
 * need without importing each other (a circular import between them would
 * work under ESM but is fragile; keeping the leaf separate is simpler).
 *
 * Everything here is dependency-free and side-effect-free at import time.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export function debug(...args) {
    if (process.env.CIWG_KNOWLEDGE_DEBUG) {
        console.error("[ciwg-knowledge]", ...args)
    }
}

/** One line to stdout — the CLI scripts' only output channel. */
export const say = (line) => process.stdout.write(`${line}\n`)

/** ~/.ciwg — resolved at call time so tests can redirect HOME/USERPROFILE. */
export const ciwgDir = () => join(homedir(), ".ciwg")

/**
 * ~/.ciwg exists and is owner-only (0700). The ONE place the directory is
 * created: every writer (tokens, state, legacy config) goes through here so
 * its permissions never depend on which hook happened to run first. NTFS
 * ignores the mode; %USERPROFILE% is user-private by default.
 */
export function ensureCiwgDir() {
    const dir = ciwgDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") {
        try {
            chmodSync(dir, 0o700) // tighten a directory an older version left at 0755
        } catch {
            /* not ours to chmod (symlink, other owner) — the mkdir mode stands */
        }
    }
}

export const stripBom = (s) => s.replace(/^﻿/, "")

/** Parsed JSON file, or null on ANY failure (missing, unreadable, invalid).
 * Never throws: every caller is on a fail-open path. */
export function readJson(path) {
    try {
        return JSON.parse(stripBom(readFileSync(path, "utf8")))
    } catch (error) {
        // ENOENT is the normal "not configured" case — keep the trace terse.
        debug(`${basename(path)} unreadable:`, error.code || error.message)
        return null
    }
}

/**
 * Atomic JSON write (temp file + rename, so a reader never sees a torn
 * file) with an explicit mode. Throws on failure — callers decide whether
 * that is fatal (a login) or must be retried/absorbed (a token rotation).
 */
export function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
    ensureCiwgDir()
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
        renameSync(tmp, path)
    } catch (error) {
        rmQuiet(tmp)
        throw error
    }
}

/** rm -f that never throws (best-effort cleanup on fail-open paths). */
export function rmQuiet(path, options = {}) {
    try {
        rmSync(path, { force: true, ...options })
    } catch {
        /* best effort */
    }
}

/** Escape for XML/HTML attribute or body context — untrusted values only
 * ever reach the model or a browser through this. */
export function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

const abortError = (signal) =>
    signal.reason ?? new DOMException("This operation was aborted", "AbortError")

/** The whole body, or the abort error the moment the signal fires — even
 * when the fetch implementation's body stream ignores the signal. */
function readBody(res, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError(signal))
            return
        }
        signal.addEventListener("abort", () => reject(abortError(signal)), { once: true })
        res.text().then(resolve, reject)
    })
}

/**
 * fetch with a hard timeout (AbortController) that spans the WHOLE
 * exchange — headers AND body. A server that answers 200 and then stalls
 * the body must not hang a hook (or a refresh that is holding auth.lock),
 * so the body is read here, under the same timer. Resolves {ok, status,
 * text, json()} — json() parses on demand and throws on a non-JSON body.
 * Rejects with the abort error when the budget runs out; the caller maps
 * that to a transient failure. Every network call in the plugin goes
 * through here.
 */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs))
    try {
        const res = await fetchImpl(url, { ...init, signal: controller.signal })
        const text = await readBody(res, controller.signal)
        return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text) }
    } finally {
        clearTimeout(timer)
    }
}

/** Milliseconds left before an absolute `deadline` (ms epoch), or Infinity
 * when no deadline was given. Negative once it has passed. */
export const remainingMs = (deadline, now = Date.now()) =>
    Number.isFinite(deadline) ? deadline - now : Infinity

/**
 * This plugin's own version, from the manifest — the single source, so a
 * hook, the MCP server and the API client can never disagree. Sent with
 * every server call: without it, "injection is not working for me" cannot
 * be answered from the server side (see the 2026-09-10 tester report).
 * Memoised; "0.0.0" if the manifest is unreadable.
 */
let cachedVersion
export function pluginVersion() {
    if (cachedVersion === undefined) {
        try {
            const manifest = JSON.parse(
                stripBom(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"))
            )
            cachedVersion = typeof manifest.version === "string" ? manifest.version : "0.0.0"
        } catch {
            cachedVersion = "0.0.0"
        }
    }
    return cachedVersion
}
