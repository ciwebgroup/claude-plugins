/**
 * SessionStart hook — automatic sign-in, client brief, today's team activity.
 *
 * Sign-in (first thing, before any API call):
 *   - never signed in / sign-in dropped → the hook OPENS THE BROWSER SIGN-IN
 *     BY ITSELF (a detached `login.mjs --auto`, see lib/auth.mjs "automatic
 *     login"): it tells the user in one line, gives Claude one line of
 *     context, and returns within its budget — the sign-in finishes in the
 *     background and the next prompt's hooks find the credential. At most
 *     once a day, and ONLY on a real session startup (payload source
 *     "startup" — a resume, compact or clear never opens anything); never
 *     on SSH/headless/CI or when opted out — those get the old one-line
 *     "/ciwg-login" nudge (once a day / once per session). When the helper
 *     gives up before it has a link (the sign-in server is unreachable)
 *     the wait ends at once, the user gets ONE soft "run /ciwg-login when
 *     you're online" line, and the automatic sign-in is held for a while
 *     (lib/auth.mjs AUTO_LOGIN_HOLD_MS) — later starts stay silent.
 *     Automation that starts sessions (`claude -p`, cron) also reports
 *     "startup": it must set CIWG_AUTO_LOGIN=off (README) — there is no
 *     payload field that tells an unattended run from a person at a
 *     terminal;
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

import {
    AUTO_LOGIN_CONTEXT,
    AUTO_LOGIN_CONTEXT_HELD,
    AUTO_LOGIN_MESSAGE,
    AUTO_LOGIN_MESSAGE_HELD,
    AUTO_LOGIN_MESSAGE_NO_URL,
    autoLoginDecision,
    signInHint,
    spawnAutoLogin,
} from "./lib/auth.mjs"
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
import { remainingMs } from "./lib/paths.mjs"
import { readState, updateState } from "./lib/state.mjs"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = dirname(fileURLToPath(import.meta.url))

const PROACTIVE_REFRESH_MS = 5 * 60_000
/** Kept back after the auto-login wait for the stdout flush. */
const AUTO_LOGIN_RESERVE_MS = 800

async function hint(additionalContext, systemMessage) {
    await emit({
        ...(systemMessage ? { systemMessage } : {}),
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    })
    process.exit(0)
}

/**
 * No credential: open the browser sign-in ourselves when that is due (and
 * this is a real startup), else fall back to the one-line nudge. Exits the
 * process either way.
 */
async function handleNoCredential(status, sessionId, source, deadline) {
    let decision = autoLoginDecision(status)
    // Only a real session startup opens a browser: a resumed session had
    // its chance when it started, and a compaction/clear is not a start
    // at all. (Unattended runs — `claude -p`, cron — also say "startup";
    // they opt out with CIWG_AUTO_LOGIN=off, see the file header.)
    if (decision === "due" && source !== "startup") decision = "not-startup"
    debug("no usable credential:", status, "— auto-login:", decision)
    if (decision === "due") {
        const waitMs = Math.max(0, Math.min(2_500, remainingMs(deadline) - AUTO_LOGIN_RESERVE_MS))
        const { started, url, ended, failed } = await spawnAutoLogin({ waitMs })
        if (started && url) {
            await hint(AUTO_LOGIN_CONTEXT, `${AUTO_LOGIN_MESSAGE} If it did not open, visit:\n${url}`)
        }
        if (started && !ended) {
            // No link yet = the helper had not reached the sign-in server
            // when we had to answer: promise nothing, name the manual path.
            await hint(AUTO_LOGIN_CONTEXT, AUTO_LOGIN_MESSAGE_NO_URL)
        }
        if (started && failed) {
            // The helper gave up before it had a link (sign-in server
            // unreachable) and has put the automatic sign-in on hold: one
            // soft line now, and today's nudge is spent with it so the next
            // start — still on hold — says nothing at all.
            signInHint(status, sessionId)
            await hint(AUTO_LOGIN_CONTEXT_HELD, AUTO_LOGIN_MESSAGE_HELD)
        }
        if (started) {
            // Gone without a link or a failure: it found nothing to do (a
            // sign-in or a sibling's attempt landed meanwhile) — silence.
            process.exit(0)
        }
    } else if (decision === "in-progress") {
        // The browser is already open from an earlier session — say nothing.
        process.exit(0)
    }
    const text = signInHint(status, sessionId)
    if (text) await hint(text)
    process.exit(0)
}

/**
 * Once a day, check for a newer release in the background (detached, off
 * the hook budget) and install it in place for the NEXT session — so a
 * tester installs once. The stamp is written before the spawn so two
 * sessions starting together do not both check.
 */
function maybeSpawnSelfUpdate() {
    if ((process.env.CIWG_AUTO_UPDATE ?? "").toLowerCase() === "off") return
    const last = readState().auto_update_checked_at
    if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60_000) return
    updateState({ auto_update_checked_at: Date.now() })
    try {
        const child = spawn(process.execPath, [join(scriptsDir, "self-update.mjs")], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: process.env,
        })
        child.unref()
    } catch (error) {
        debug("auto-update spawn failed:", error?.message)
    }
}

try {
    const payload = JSON.parse(await readStdin())
    if (payload.source === "compact" || payload.source === "clear") {
        process.exit(0)
    }
    if (payload.source === "startup") maybeSpawnSelfUpdate()
    const deadline = hookDeadline()

    // Resolves the credential once (a silent — possibly proactive — refresh
    // if needed); the API calls below share the memoised result.
    const auth = await resolveCredential({ deadline, refreshWithinMs: PROACTIVE_REFRESH_MS })
    if (!auth.ok) {
        await handleNoCredential(auth.status, payload.session_id, payload.source, deadline)
    }

    const mapping = getClientMapping(payload.cwd)
    const hasFullMapping = Boolean(
        mapping?.clientName && mapping.organizationId
    )
    const repoName =
        mapping?.organizationId != null ? null : detectRepoName(payload.cwd, { deadline })

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
