/**
 * UserPromptSubmit hook — the zero-model-effort retrieval path.
 *
 * Runs BEFORE Claude sees the prompt: queries the knowledge API with the
 * prompt text and, when something genuinely relevant exists, injects a few
 * compact, source-cited snippets as additional context. In parallel it
 * fetches today's ENGRAM team activity (org- or repo-filtered structured
 * session digests) so the model knows who touched this client/repo today.
 * Engram lines are secondary: a small char budget, appended after
 * knowledge snippets, inside the same untrusted-data framing. The model
 * spends no tokens or reasoning on retrieval — the context is simply
 * present.
 *
 * Sign-in: the API calls use the cached CIWG SSO token (silently refreshed).
 * If the refresh is REJECTED — user deactivated, token revoked — or the
 * API rejects the token (401), the hook injects one short "run /ciwg-login"
 * line once per session and is silent otherwise. Never signed in at all →
 * silent here (SessionStart owns the once-a-day first-run hint).
 *
 * Fail-open discipline: every failure path (no credential, timeout, API
 * down, malformed stdin) exits 0 with no output. Every call is bounded by
 * the hook deadline (hooks.json timeout). Set CIWG_KNOWLEDGE_DEBUG=1 for
 * stderr traces.
 */

import { signInHint } from "./lib/auth.mjs"
import {
    TRUST_PREAMBLE,
    debug,
    emit,
    getClientMapping,
    hookDeadline,
    listEngramActivities,
    readStdin,
    renderEngramLines,
    renderHits,
    searchKnowledge,
} from "./lib/config.mjs"
import { detectRepoName } from "./lib/engram.mjs"

const rawMinScore = Number(process.env.CIWG_KNOWLEDGE_MIN_SCORE)
// A malformed value must not silently disable injection (NaN → API 400 →
// permanent silent no-op).
const MIN_SCORE =
    Number.isFinite(rawMinScore) && rawMinScore >= 0 && rawMinScore <= 1
        ? rawMinScore
        : 0.35
const MIN_PROMPT_CHARS = 15
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
    const [result, engram] = await Promise.all([
        searchKnowledge(
            {
                q: prompt,
                organizationId: mapping?.organizationId,
                limit: 3,
                minScore: MIN_SCORE,
            },
            { deadline }
        ),
        listEngramActivities(
            {
                organizationId: mapping?.organizationId,
                repo:
                    mapping?.organizationId != null
                        ? null
                        : detectRepoName(payload.cwd, { deadline }),
                limit: 5,
            },
            { deadline }
        ),
    ])

    const status = [result.status, engram.status].find((s) => HINTED.has(s))
    if (status) {
        const text = signInHint(status, payload.session_id)
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

    const hits = result.ok
        ? (result.data?.hits?.filter((h) => h.score >= MIN_SCORE) ?? [])
        : []
    const rendered = hits.length > 0 ? renderHits(hits) : ""
    const engramLines = engram.ok
        ? renderEngramLines(engram.data?.activities ?? [])
        : ""

    const sections = []
    if (rendered) sections.push(rendered)
    if (engramLines) {
        sections.push(
            `Team activity today (engram — structured session digests):\n${engramLines}`
        )
    }
    if (sections.length === 0) {
        debug("no hits above threshold and no team activity")
        process.exit(0)
    }

    await emit({
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
                `<company-knowledge auto-retrieved="true">\n` +
                `${TRUST_PREAMBLE}\n${sections.join("\n")}\n` +
                `</company-knowledge>`,
        },
    })
    process.exit(0)
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
