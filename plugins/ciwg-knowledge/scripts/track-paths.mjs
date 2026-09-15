#!/usr/bin/env node
/**
 * PostToolUse hook for file edits: remember client-shaped paths (hydra-sites
 * clients/<slug>.json, overrides/<slug>/) for this session, so the prompt
 * hook can tell the server which client the work is for. Local only — no
 * network — and silent.
 */

import { rememberClientPath } from "./lib/clientPaths.mjs"
import { debug } from "./lib/paths.mjs"
import { readStdin } from "./lib/config.mjs"

try {
    const payload = JSON.parse(await readStdin())
    const input = payload.tool_input ?? {}
    const filePath = input.file_path ?? input.notebook_path ?? null
    if (rememberClientPath(payload.session_id, filePath, payload.cwd)) debug("remembered client path for session")
} catch (error) {
    debug("track-paths error:", error?.message)
}
process.exit(0)
