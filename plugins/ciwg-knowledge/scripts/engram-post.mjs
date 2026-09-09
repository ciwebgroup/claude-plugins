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
    const payload = JSON.parse(await readStdin())
    const digest = buildEngramDigest({
        cwd: payload.cwd,
        transcriptPath: payload.transcript_path,
    })
    if (!digest) process.exit(0)

    const result = await postEngramActivity(digest, { deadline: hookDeadline() })
    if (!result.ok) debug("engram post failed:", result.status)
    process.exit(0)
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
