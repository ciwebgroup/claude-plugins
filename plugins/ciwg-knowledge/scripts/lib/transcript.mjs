/**
 * The last completed turn of a Claude Code session transcript — the
 * user's prompt and Claude's final reply — for the team memory (Stop hook).
 *
 * The transcript is JSONL, one message per line: `type` "user" |
 * "assistant", `message.content` either a string or an array of blocks
 * (`text`, `tool_use`, `tool_result`, …). A user line whose content is
 * only tool results is Claude's own tool round-trip, not a prompt; the
 * reply is every assistant `text` block after the last real prompt, joined.
 * Only the tail of the file is read (a long session's transcript is MBs).
 */
import { openSync, readSync, closeSync, fstatSync } from "node:fs"

/** Bytes read from the end of the transcript — comfortably a long turn. */
const TAIL_BYTES = 512 * 1024

function textOf(content) {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
}

const isToolOnly = (content) =>
    Array.isArray(content) && content.length > 0 && content.every((b) => b && b.type === "tool_result")

export function readTail(path, bytes = TAIL_BYTES) {
    const fd = openSync(path, "r")
    try {
        const size = fstatSync(fd).size
        const length = Math.min(size, bytes)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        let text = buffer.toString("utf8")
        // A partial first line (we started mid-file): drop it.
        if (length < size) text = text.slice(text.indexOf("\n") + 1)
        return text
    } finally {
        closeSync(fd)
    }
}

/** { prompt, reply } of the last completed turn, or null when there is none. */
export function lastTurn(transcriptText) {
    const lines = transcriptText.split("\n").filter((l) => l.trim())
    let promptIndex = -1
    let prompt = ""
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        let entry
        try {
            entry = JSON.parse(lines[i])
        } catch {
            continue
        }
        if (entry?.type !== "user" || entry.isSidechain) continue
        const content = entry.message?.content
        if (isToolOnly(content)) continue
        const text = textOf(content).trim()
        if (!text) continue
        promptIndex = i
        prompt = text
        break
    }
    if (promptIndex < 0) return null
    const parts = []
    for (let i = promptIndex + 1; i < lines.length; i += 1) {
        let entry
        try {
            entry = JSON.parse(lines[i])
        } catch {
            continue
        }
        if (entry?.type !== "assistant" || entry.isSidechain) continue
        const text = textOf(entry.message?.content).trim()
        if (text) parts.push(text)
    }
    const reply = parts.join("\n").trim()
    if (!reply) return null
    return { prompt, reply }
}

export function lastTurnFromFile(path) {
    if (!path) return null
    try {
        return lastTurn(readTail(path))
    } catch {
        return null
    }
}
