/**
 * UserPromptSubmit hook — the zero-model-effort retrieval path.
 *
 * Runs BEFORE Claude sees the prompt: queries the knowledge API with the
 * prompt text and, when something genuinely relevant exists, injects a few
 * compact, source-cited snippets as additional context. The model spends no
 * tokens or reasoning on retrieval — the context is simply present.
 *
 * Fail-open discipline: every failure path (no token, timeout, API down,
 * malformed stdin) exits 0 with no output. This hook must NEVER block or
 * slow a prompt beyond its timeout.
 */

import {
    getClientMapping,
    readStdin,
    renderHits,
    searchKnowledge,
} from "./lib/config.mjs"

const MIN_SCORE = Number(process.env.CIWG_KNOWLEDGE_MIN_SCORE || 0.35)
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
    const hits = result?.hits?.filter((h) => h.score >= MIN_SCORE) ?? []
    if (hits.length === 0) process.exit(0)

    const rendered = renderHits(hits)
    if (!rendered) process.exit(0)

    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext:
                    `<company-knowledge auto-retrieved="true">\n` +
                    `Internal context matching this prompt (cite sources when used; ` +
                    `verify before asserting as current):\n${rendered}\n` +
                    `</company-knowledge>`,
            },
        })
    )
    process.exit(0)
} catch {
    process.exit(0)
}
