#!/usr/bin/env node
/**
 * Self-update — spawned detached by the SessionStart hook at most once a
 * day (lib/update.mjs does the work). Compares the installed version with
 * the latest public release and replaces this plugin's files in place
 * when a newer one exists; the NEXT session runs it. Off with
 * CIWG_AUTO_UPDATE=off. Silent except with CIWG_KNOWLEDGE_DEBUG.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { debug } from "./lib/paths.mjs"
import { updateState } from "./lib/state.mjs"
import { applyUpdate, compareSemver, fetchLatestRelease, installedVersion } from "./lib/update.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

try {
    if ((process.env.CIWG_AUTO_UPDATE ?? "").toLowerCase() === "off") {
        debug("auto-update: off")
        process.exit(0)
    }
    const current = installedVersion(root)
    const latest = await fetchLatestRelease()
    updateState({ auto_update_checked_at: Date.now() })
    if (!latest || !current) {
        debug("auto-update: no release information")
        process.exit(0)
    }
    if (compareSemver(latest.version, current) <= 0) {
        debug(`auto-update: ${current} is current`)
        process.exit(0)
    }
    const result = await applyUpdate(root, latest)
    updateState({ auto_update_last: result.version, auto_update_at: Date.now() })
    debug(`auto-update: ${current} → ${result.version} (${result.files} files); takes effect next session`)
    process.exit(0)
} catch (error) {
    debug("auto-update failed:", error?.message)
    updateState({ auto_update_error: String(error?.message ?? error).slice(0, 200), auto_update_error_at: Date.now() })
    process.exit(0)
}
