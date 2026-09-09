/**
 * SessionEnd hook — publish this session's ENGRAM ACTIVITY DIGEST so
 * teammates' sessions know "braedn worked on acme-hvac, branch
 * checkout-fix, 14 files — 4 minutes ago".
 *
 * The digest is structured facts computed here (lib/engram.mjs): git
 * branch/status counts, repo basename, .ciwg-client.json mapping, duration
 * from transcript-file METADATA. NEVER conversation text — this hook does
 * not read the transcript, and the server whitelists payload keys anyway.
 *
 * Fail-open and fast: opt-out (CIWG_ENGRAM=off, or "engram": false in
 * ~/.ciwg/knowledge.json), not signed in / sign-in revoked, unmapped
 * scratch dir, network down, or the 60s backoff → exit 0 silently,
 * session exit unaffected. Bounded by the hook deadline. (No login hint
 * here — a session that is ending has no one left to read it.)
 */

import {
    debug,
    hookDeadline,
    isEngramOptedOut,
    postEngramActivity,
    readStdin,
} from "./lib/config.mjs"
import { buildEngramDigest } from "./lib/engram.mjs"

try {
    if (isEngramOptedOut()) {
        debug("engram opt-out active — not posting")
        process.exit(0)
    }
    // Captured BEFORE any work: the hook timer started when this process was
    // spawned, and the git calls below draw on the same budget as the POST
    // that follows (up to four of them at 1.5 s each would otherwise run
    // before the deadline was even set).
    const deadline = hookDeadline()
    const payload = JSON.parse(await readStdin())
    const digest = buildEngramDigest({
        cwd: payload.cwd,
        transcriptPath: payload.transcript_path,
        deadline,
    })
    if (!digest) process.exit(0)

    const result = await postEngramActivity(digest, { deadline })
    if (!result.ok) debug("engram post failed:", result.status)
    process.exit(0)
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
