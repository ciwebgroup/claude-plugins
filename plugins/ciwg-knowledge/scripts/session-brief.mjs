/**
 * SessionStart hook — sign-in nudge, client brief, today's team activity.
 *
 * Sign-in nudge (first thing, before any API call):
 *   - never signed in (no SSO cache, no legacy token) → ONE line asking
 *     the user to run /ciwg-login, at most once a day, then nothing else;
 *   - SSO refresh rejected (revoked / expired) → the same kind of line,
 *     once per session;
 *   - the API rejected the SSO token (401) → an actionable line, once per
 *     session (the server may not trust this app yet).
 *
 * Proactive refresh: a token that expires within 5 minutes is refreshed
 * here, at session start, so the per-prompt hooks never pay for it.
 *
 * Knowledge brief: fires only in repos whose .ciwg-client.json carries BOTH
 * an organizationId and a clientName: the org id server-side-filters the
 * search (a name-only lexical match can surface OTHER clients' data), and
 * the name is the query seed. Unmapped repos get no knowledge brief.
 *
 * Engram (team activity): today's activity digests, org-filtered when the
 * repo is client-mapped, else filtered to this git repo's name — so an
 * unmapped internal repo still shows who else touched it today. Secondary
 * by design: small line budget, never crowds out knowledge snippets.
 * Fires on real startup/resume only, never after compaction.
 *
 * Same fail-open discipline as inject-context: any failure exits 0 silent.
 * Every call is bounded by the hook deadline (hooks.json timeout).
 */

import { signInHint } from "./lib/auth.mjs"
import {
    TRUST_PREAMBLE,
    debug,
    emit,
    escapeXml,
    getClientMapping,
    hookDeadline,
    listEngramActivities,
    readStdin,
    renderEngramLines,
    renderHits,
    resolveCredential,
    searchKnowledge,
} from "./lib/config.mjs"
import { detectRepoName } from "./lib/engram.mjs"

const PROACTIVE_REFRESH_MS = 5 * 60_000

async function hint(additionalContext) {
    await emit({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    })
    process.exit(0)
}

try {
    const payload = JSON.parse(await readStdin())
    if (payload.source === "compact" || payload.source === "clear") {
        process.exit(0)
    }
    const deadline = hookDeadline()

    // Resolves the credential once (a silent — possibly proactive — refresh
    // if needed); the API calls below share the memoised result.
    const auth = await resolveCredential({ deadline, refreshWithinMs: PROACTIVE_REFRESH_MS })
    if (!auth.ok) {
        const text = signInHint(auth.status, payload.session_id)
        if (text) await hint(text)
        debug("no usable credential:", auth.status)
        process.exit(0)
    }

    const mapping = getClientMapping(payload.cwd)
    const hasFullMapping = Boolean(
        mapping?.clientName && mapping.organizationId
    )
    const repoName =
        mapping?.organizationId != null ? null : detectRepoName(payload.cwd)

    const [knowledge, engram] = await Promise.all([
        hasFullMapping
            ? searchKnowledge(
                  {
                      q: mapping.clientName,
                      organizationId: mapping.organizationId,
                      limit: 5,
                      minScore: 0.2,
                  },
                  { deadline }
              )
            : Promise.resolve(null),
        listEngramActivities(
            {
                organizationId: mapping?.organizationId,
                repo: repoName,
                limit: 5,
            },
            { deadline }
        ),
    ])

    if (knowledge?.status === "api-rejected" || engram.status === "api-rejected") {
        const text = signInHint("api-rejected", payload.session_id)
        if (text) await hint(text)
    }

    const renderedHits =
        knowledge?.ok && knowledge.data?.hits?.length
            ? renderHits(knowledge.data.hits, { maxChars: 1800, maxHits: 5 })
            : ""
    const engramLines = engram.ok
        ? renderEngramLines(engram.data?.activities ?? [])
        : ""

    const sections = []
    if (renderedHits) sections.push(renderedHits)
    if (engramLines) {
        sections.push(
            `Team activity today (engram — structured session digests):\n${engramLines}`
        )
    }
    if (sections.length === 0) {
        debug("nothing to inject (no hits, no team activity)")
        process.exit(0)
    }

    const clientAttr = hasFullMapping
        ? ` client="${escapeXml(mapping.clientName)}"`
        : ""
    await emit({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext:
                `<company-knowledge${clientAttr} auto-retrieved="true">\n` +
                `${TRUST_PREAMBLE}\n${sections.join("\n")}\n` +
                `</company-knowledge>`,
        },
    })
    process.exit(0)
} catch (error) {
    debug("hook error:", error?.message)
    process.exit(0)
}
