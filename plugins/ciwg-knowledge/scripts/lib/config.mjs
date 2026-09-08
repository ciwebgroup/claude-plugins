/**
 * Shared config + API access for the ciwg-knowledge plugin.
 *
 * Auth: an API token with the `route:knowledge` scope (minted in synapse
 * admin → API tokens). Sources, in order: CIWG_KNOWLEDGE_TOKEN env, then
 * ~/.ciwg/knowledge.json {"token": "..."}. No token = every entry point
 * no-ops silently — the plugin must never break a session.
 *
 * Client mapping: an optional .ciwg-client.json at the project root
 * ({"organizationId": 7, "clientName": "Acme HVAC"}) scopes retrieval to
 * that client and enables the session brief.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const API_BASE = (
    process.env.CIWG_KNOWLEDGE_URL || "https://api.ciwebgroup.com"
).replace(/\/$/, "")

export function getToken() {
    if (process.env.CIWG_KNOWLEDGE_TOKEN) {
        return process.env.CIWG_KNOWLEDGE_TOKEN.trim()
    }
    try {
        const raw = readFileSync(join(homedir(), ".ciwg", "knowledge.json"), "utf8")
        const parsed = JSON.parse(raw)
        return typeof parsed.token === "string" ? parsed.token.trim() : null
    } catch {
        return null
    }
}

/** {organizationId?, clientName?} from <cwd>/.ciwg-client.json, or null. */
export function getClientMapping(cwd) {
    if (!cwd) return null
    try {
        const raw = readFileSync(join(cwd, ".ciwg-client.json"), "utf8")
        const parsed = JSON.parse(raw)
        const organizationId = Number.isInteger(parsed.organizationId)
            ? parsed.organizationId
            : undefined
        const clientName =
            typeof parsed.clientName === "string" && parsed.clientName.trim()
                ? parsed.clientName.trim()
                : undefined
        if (organizationId === undefined && clientName === undefined) return null
        return { organizationId, clientName }
    } catch {
        return null
    }
}

/**
 * GET /api/v1/knowledge/search. Returns {mode, hits} or null on ANY
 * failure — callers fail open (a knowledge outage must never block work).
 */
export async function searchKnowledge(
    { q, organizationId, sourceTypes, limit, minScore },
    timeoutMs = 4000
) {
    const token = getToken()
    if (!token) return null
    const url = new URL(`${API_BASE}/api/v1/knowledge/search`)
    url.searchParams.set("q", q.slice(0, 500))
    if (organizationId != null) {
        url.searchParams.set("organization_id", String(organizationId))
    }
    if (sourceTypes?.length) {
        url.searchParams.set("source_type", sourceTypes.join(","))
    }
    if (limit != null) url.searchParams.set("limit", String(limit))
    if (minScore != null) url.searchParams.set("min_score", String(minScore))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, {
            headers: { "X-API-Token": token },
            signal: controller.signal,
        })
        if (!res.ok) return null
        return await res.json()
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

/** Read all of stdin (hook payload / not used by the MCP server). */
export async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString("utf8")
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Compact, citation-first rendering of hits for context injection. */
export function renderHits(hits, { maxChars = 1500, maxHits = 3 } = {}) {
    const lines = []
    let used = 0
    for (const hit of hits.slice(0, maxHits)) {
        const source = `${hit.sourceType}:${hit.sourceId}#${hit.chunkIndex}`
        const org = hit.organizationId != null ? ` org:${hit.organizationId}` : ""
        const body = clip(
            (hit.summary ? `${hit.summary} — ` : "") + hit.content.replace(/\s+/g, " "),
            420
        )
        const line = `- [${source}${org} score:${hit.score.toFixed(2)}] ${body}`
        if (used + line.length > maxChars) break
        lines.push(line)
        used += line.length
    }
    return lines.join("\n")
}
