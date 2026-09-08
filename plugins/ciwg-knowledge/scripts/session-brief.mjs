/**
 * SessionStart hook — client brief on session open.
 *
 * Fires only in repos whose .ciwg-client.json carries BOTH an
 * organizationId and a clientName: the org id server-side-filters the
 * search (a name-only lexical match can surface OTHER clients' data), and
 * the name is the query seed. Unmapped repos get nothing — no org-wide
 * noise. Fires on real startup/resume only, never after compaction.
 *
 * Same fail-open discipline as inject-context: any failure exits 0 silent.
 */

import {
    TRUST_PREAMBLE,
    debug,
    emitAndExit,
    escapeXml,
    getClientMapping,
    readStdin,
    renderHits,
    searchKnowledge,
} from "./lib/config.mjs"

try {
    const payload = JSON.parse(await readStdin())
    if (payload.source === "compact" || payload.source === "clear") {
        process.exit(0)
    }
    const mapping = getClientMapping(payload.cwd)
    if (!mapping?.clientName || !mapping.organizationId) {
        debug("no complete client mapping (need organizationId + clientName)")
        process.exit(0)
    }

    const result = await searchKnowledge({
        q: mapping.clientName,
        organizationId: mapping.organizationId,
        limit: 5,
        minScore: 0.2,
    })
    if (!result.ok) process.exit(0)
    const hits = result.data?.hits ?? []
    if (hits.length === 0) process.exit(0)

    const rendered = renderHits(hits, { maxChars: 1800, maxHits: 5 })
    if (!rendered) process.exit(0)

    emitAndExit({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext:
                `<company-knowledge client="${escapeXml(mapping.clientName)}" auto-retrieved="true">\n` +
                `${TRUST_PREAMBLE}\n${rendered}\n` +
                `</company-knowledge>`,
        },
    })
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
