/**
 * ciwg-knowledge MCP server — the EXPLICIT retrieval surface (the hooks are
 * the automatic one). Raw newline-delimited JSON-RPC over stdio; no SDK
 * dependency so the plugin needs no install step.
 *
 * Tools:
 *   search_company_knowledge  — semantic search over ingested company
 *                               knowledge (meetings, tickets, chat, notes)
 *   get_source_artifacts      — the analysis outputs (summary, action
 *                               items, entities, sentiment) for one source
 */

import { createInterface } from "node:readline"
import { API_BASE, getToken, searchKnowledge } from "./lib/config.mjs"

const SOURCE_TYPES = [
    "call-transcript",
    "chat-log",
    "fathom-meeting",
    "helpdesk-ticket",
    "internal-channel-day",
    "organization-note",
]

const TOOLS = [
    {
        name: "search_company_knowledge",
        description:
            "Semantic search over CIWG's ingested company knowledge: Fathom meetings, call transcripts, helpdesk tickets, internal team chat, and org notes. Returns scored chunks with source pointers and per-source AI summaries. Staff-only data — cite sources.",
        inputSchema: {
            type: "object",
            properties: {
                q: { type: "string", description: "What to search for" },
                organization_id: {
                    type: "integer",
                    description: "Restrict to one client organization",
                },
                source_type: {
                    type: "string",
                    enum: SOURCE_TYPES,
                    description: "Restrict to one source type",
                },
                limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: ["q"],
        },
    },
    {
        name: "get_source_artifacts",
        description:
            "The agentic-analysis outputs (summary, action items, entities, sentiment) for one ingested source, addressed by the source pointer a search hit carries.",
        inputSchema: {
            type: "object",
            properties: {
                source_type: { type: "string", enum: SOURCE_TYPES },
                source_id: { type: "string" },
            },
            required: ["source_type", "source_id"],
        },
    },
]

function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function replyError(id, code, message) {
    process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    )
}

const text = (t) => ({ content: [{ type: "text", text: t }], isError: false })
const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true })

async function callTool(name, args) {
    if (!getToken()) {
        return errText(
            "No knowledge API token configured. Set CIWG_KNOWLEDGE_TOKEN or ~/.ciwg/knowledge.json — see the ciwg-knowledge plugin README."
        )
    }
    if (name === "search_company_knowledge") {
        const result = await searchKnowledge(
            {
                q: String(args.q ?? ""),
                organizationId: args.organization_id,
                sourceTypes: args.source_type ? [args.source_type] : undefined,
                limit: args.limit,
            },
            8000
        )
        if (!result) return errText("Knowledge search failed (API unreachable or token rejected).")
        const hits = (result.hits ?? []).map((h) => ({
            source: `${h.sourceType}:${h.sourceId}#${h.chunkIndex}`,
            score: h.score,
            organizationId: h.organizationId,
            summary: h.summary,
            content: h.content.slice(0, 1200),
            createdAt: h.createdAt,
        }))
        return text(JSON.stringify({ mode: result.mode, hits }, null, 2))
    }
    if (name === "get_source_artifacts") {
        const url = new URL(`${API_BASE}/api/v1/knowledge/artifacts`)
        url.searchParams.set("source_type", String(args.source_type ?? ""))
        url.searchParams.set("source_id", String(args.source_id ?? ""))
        try {
            const res = await fetch(url, {
                headers: { "X-API-Token": getToken() },
            })
            if (!res.ok) {
                return errText(`Artifact lookup failed (${res.status}).`)
            }
            return text(JSON.stringify(await res.json(), null, 2))
        } catch (error) {
            return errText(`Artifact lookup failed: ${error.message}`)
        }
    }
    return errText(`Unknown tool "${name}"`)
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on("line", async (line) => {
    let message
    try {
        message = JSON.parse(line)
    } catch {
        return
    }
    const { id, method, params } = message
    try {
        if (method === "initialize") {
            reply(id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "ciwg-knowledge", version: "0.1.0" },
            })
        } else if (method === "notifications/initialized") {
            // notification — no response
        } else if (method === "tools/list") {
            reply(id, { tools: TOOLS })
        } else if (method === "tools/call") {
            reply(id, await callTool(params?.name, params?.arguments ?? {}))
        } else if (id !== undefined) {
            replyError(id, -32601, `Method not found: ${method}`)
        }
    } catch (error) {
        if (id !== undefined) replyError(id, -32603, String(error?.message ?? error))
    }
})
