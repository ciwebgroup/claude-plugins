/**
 * UserPromptSubmit hook — the zero-model-effort retrieval path.
 *
 * Runs BEFORE Claude sees the prompt: hands the prompt and the session's
 * facts (client mapping, repo, branch) to the knowledge API's injection
 * endpoint and emits whatever context comes back, verbatim. The server
 * decides what qualifies (name-matched knowledge, today's team memory
 * ordered by overlap with this session) and how it is rendered — so the
 * policy changes with a deploy, never a plugin release. The model spends no
 * tokens or reasoning on retrieval — the context is simply present.
 *
 * Sign-in: the API call uses the cached CIWG SSO token (silently
 * refreshed). If the refresh is REJECTED — user deactivated, token revoked
 * — or the API rejects the token (401), the hook injects one short "run
 * /ciwg-login" line once per session and is silent otherwise. Never signed
 * in at all → silent here (SessionStart owns the once-a-day first-run hint).
 *
 * Fail-open discipline: every failure path (no credential, timeout, API
 * down, malformed stdin) exits 0 with no output. The call is bounded by the
 * hook deadline (hooks.json timeout). Set CIWG_KNOWLEDGE_DEBUG=1 for stderr
 * traces.
 */

import { signInHint } from "./lib/auth.mjs"
import {
    debug,
    emit,
    getClientMapping,
    hookDeadline,
    postInject,
    readStdin,
} from "./lib/config.mjs"
import { collectGitFacts, detectRepoName } from "./lib/engram.mjs"

/** Below this the server would not look anyway — save the round trip. */
const MIN_PROMPT_CHARS = 15
/** Sent for retrieval only (never stored); the server clips again. */
const PROMPT_CHARS = 8_000
/** Statuses that earn a one-line nudge here (first-run is SessionStart's). */
const HINTED = new Set(["relogin", "api-rejected"])

try {
    const payload = JSON.parse(await readStdin())
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : ""

    // Not worth a lookup: slash commands, tiny prompts, bash-mode.
    if (
        prompt.length < MIN_PROMPT_CHARS ||
        prompt.startsWith("/") ||
        prompt.startsWith("!")
    ) {
        process.exit(0)
    }
    const deadline = hookDeadline()

    const mapping = getClientMapping(payload.cwd)
    const repo = detectRepoName(payload.cwd, { deadline })
    const git = repo ? collectGitFacts(payload.cwd, { deadline }) : {}
    const result = await postInject(
        {
            event: "prompt",
            prompt: prompt.slice(0, PROMPT_CHARS),
            sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
            facts: {
                repo,
                branch: git?.branch ?? null,
                organizationId: mapping?.organizationId ?? null,
                clientName: mapping?.clientName ?? null,
                paths: Array.isArray(git?.topPaths) ? git.topPaths.slice(0, 10) : [],
            },
        },
        { deadline }
    )

    if (HINTED.has(result.status)) {
        const text = signInHint(result.status, payload.session_id)
        if (text) {
            await emit({
                hookSpecificOutput: {
                    hookEventName: "UserPromptSubmit",
                    additionalContext: text,
                },
            })
        } else {
            debug("sign-in required — hint already shown this session")
        }
        process.exit(0)
    }

    const context = result.ok && typeof result.data?.context === "string" ? result.data.context : ""
    if (!context) {
        debug(result.ok ? "server injected nothing" : `inject call failed: ${result.status}`)
        process.exit(0)
    }
    await emit({
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: context,
        },
    })
    process.exit(0)
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
