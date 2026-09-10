#!/usr/bin/env node
/**
 * Stop hook — the team memory's write path. After every reply, hands the
 * turn (the prompt, Claude's reply, and the session's facts: repo, branch,
 * client, paths touched) to the knowledge API, where it is summarized in
 * the context of the author's day and stored as one activity line; the
 * raw text is never persisted server-side. Nothing here is on the
 * critical path: fire-and-forget inside the hook budget, silent on every
 * failure, off entirely with the engram opt-out.
 *
 * Skipped: a Stop fired by another Stop hook (stop_hook_active), sessions
 * with no readable transcript, turns too small to say anything, and
 * sessions with no anchor at all (no git repo and no client mapping).
 */
import {
    debug,
    getClientMapping,
    hookDeadline,
    isEngramOptedOut,
    postEngramTurn,
    readStdin,
} from "./lib/config.mjs"
import { collectGitFacts, detectRepoName } from "./lib/engram.mjs"
import { lastTurnFromFile } from "./lib/transcript.mjs"

/** Per-field cap sent for summarization (the server clips again). */
const TEXT_CHARS = 6_000
/** A reply shorter than this said nothing worth remembering. */
const MIN_REPLY_CHARS = 120

try {
    if (isEngramOptedOut()) {
        debug("engram opt-out active — not posting the turn")
        process.exit(0)
    }
    const deadline = hookDeadline()
    const payload = JSON.parse(await readStdin())
    if (payload.stop_hook_active) process.exit(0)
    const turn = lastTurnFromFile(payload.transcript_path)
    if (!turn || turn.reply.length < MIN_REPLY_CHARS) {
        debug("no turn worth posting")
        process.exit(0)
    }
    const mapping = getClientMapping(payload.cwd)
    const repo = detectRepoName(payload.cwd, { deadline })
    if (!repo && mapping?.organizationId == null) {
        debug("no repo and no client mapping — nothing to anchor the turn to")
        process.exit(0)
    }
    const facts = repo ? collectGitFacts(payload.cwd, { deadline }) : {}
    const result = await postEngramTurn(
        {
            sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
            repo,
            branch: facts?.branch ?? null,
            organizationId: mapping?.organizationId ?? null,
            clientName: mapping?.clientName ?? null,
            paths: Array.isArray(facts?.topPaths) ? facts.topPaths.slice(0, 10) : [],
            prompt: turn.prompt.slice(0, TEXT_CHARS),
            reply: turn.reply.slice(0, TEXT_CHARS),
        },
        { deadline }
    )
    if (!result.ok) debug("engram turn post failed:", result.status)
    process.exit(0)
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
