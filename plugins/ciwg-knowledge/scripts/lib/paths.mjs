/**
 * Tiny shared leaf module — the bits both config.mjs and auth.mjs need
 * without importing each other (a circular import between the two would
 * work under ESM but is fragile; keeping the leaf separate is simpler).
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export function debug(...args) {
    if (process.env.CIWG_KNOWLEDGE_DEBUG) {
        console.error("[ciwg-knowledge]", ...args)
    }
}

/** ~/.ciwg — resolved at call time so tests can redirect HOME/USERPROFILE. */
export const ciwgDir = () => join(homedir(), ".ciwg")

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
