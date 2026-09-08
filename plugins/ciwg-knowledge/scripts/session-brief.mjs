/**
 * SessionStart hook — client brief on session open.
 *
 * Only fires in repos that carry a .ciwg-client.json mapping with a
 * clientName: injects a handful of the most relevant recent knowledge hits
 * for that client (meetings, tickets, notes) so the session starts already
 * oriented. Unmapped repos get nothing — no org-wide noise.
 *
 * Same fail-open discipline as inject-context: any failure exits 0 silent.
 */

import {
    getClientMapping,
    readStdin,
    renderHits,
    searchKnowledge,
} from "./lib/config.mjs"

try {
    const payload = JSON.parse(await readStdin())
    const mapping = getClientMapping(payload.cwd)
    if (!mapping?.clientName) process.exit(0)

    const result = await searchKnowledge({
        q: mapping.clientName,
        organizationId: mapping.organizationId,
        limit: 5,
        minScore: 0.2,
    })
    const hits = result?.hits ?? []
    if (hits.length === 0) process.exit(0)

    const rendered = renderHits(hits, { maxChars: 1800, maxHits: 5 })
    if (!rendered) process.exit(0)

    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext:
                    `<company-knowledge client="${mapping.clientName}" auto-retrieved="true">\n` +
                    `Recent internal context for this client (cite sources when ` +
                    `used; verify before asserting as current):\n${rendered}\n` +
                    `</company-knowledge>`,
            },
        })
    )
    process.exit(0)
} catch {
    process.exit(0)
}
