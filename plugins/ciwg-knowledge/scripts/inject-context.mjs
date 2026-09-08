/**
 * UserPromptSubmit hook — the zero-model-effort retrieval path.
 *
 * Runs BEFORE Claude sees the prompt: queries the knowledge API with the
 * prompt text and, when something genuinely relevant exists, injects a few
 * compact, source-cited snippets as additional context. The model spends no
 * tokens or reasoning on retrieval — the context is simply present.
 *
 * Fail-open discipline: every failure path (no token, timeout, API down,
 * malformed stdin) exits 0 with no output. Set CIWG_KNOWLEDGE_DEBUG=1 for
 * stderr traces.
 */

import {
    TRUST_PREAMBLE,
    debug,
    emitAndExit,
    getClientMapping,
    readStdin,
    renderHits,
    searchKnowledge,
} from "./lib/config.mjs"

const rawMinScore = Number(process.env.CIWG_KNOWLEDGE_MIN_SCORE)
// A malformed value must not silently disable injection (NaN → API 400 →
// permanent silent no-op).
const MIN_SCORE =
    Number.isFinite(rawMinScore) && rawMinScore >= 0 && rawMinScore <= 1
        ? rawMinScore
        : 0.35
const MIN_PROMPT_CHARS = 15

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

    const mapping = getClientMapping(payload.cwd)
    const result = await searchKnowledge({
        q: prompt,
        organizationId: mapping?.organizationId,
        limit: 3,
        minScore: MIN_SCORE,
    })
    if (!result.ok) process.exit(0)
    const hits = result.data?.hits?.filter((h) => h.score >= MIN_SCORE) ?? []
    if (hits.length === 0) {
        debug("no hits above threshold")
        process.exit(0)
    }

    const rendered = renderHits(hits)
    if (!rendered) process.exit(0)

    emitAndExit({
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
                `<company-knowledge auto-retrieved="true">\n` +
                `${TRUST_PREAMBLE}\n${rendered}\n` +
                `</company-knowledge>`,
        },
    })
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
