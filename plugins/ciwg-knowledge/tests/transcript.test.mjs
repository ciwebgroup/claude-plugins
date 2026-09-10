/**
 * transcript.mjs — the last completed turn of a Claude Code transcript:
 * the real prompt (not a tool round-trip), the reply's text blocks joined,
 * sidechains ignored, a partial first line of a tail read dropped.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lastTurn, lastTurnFromFile, readTail } from "../scripts/lib/transcript.mjs"

const line = (obj) => JSON.stringify(obj)
const user = (content, extra = {}) => line({ type: "user", message: { role: "user", content }, ...extra })
const assistant = (content, extra = {}) => line({ type: "assistant", message: { role: "assistant", content }, ...extra })

test("lastTurn: the last real prompt and every assistant text block after it; tool round-trips are not prompts", () => {
    const transcript = [
        user("earlier question"),
        assistant([{ type: "text", text: "earlier answer" }]),
        user("What did we agree with Star Heating?"),
        assistant([{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "search", input: {} }]),
        user([{ type: "tool_result", tool_use_id: "t1", content: "…" }]),
        assistant([{ type: "text", text: "They want a Webflow rebuild." }]),
        // A sidechain (subagent) after the turn does not belong to it.
        assistant([{ type: "text", text: "subagent noise" }], { isSidechain: true }),
    ].join("\n")
    assert.deepEqual(lastTurn(transcript), {
        prompt: "What did we agree with Star Heating?",
        reply: "Let me check.\nThey want a Webflow rebuild.",
    })
})

test("lastTurn: string content, no reply yet, garbage lines", () => {
    assert.deepEqual(lastTurn([user("hi there"), assistant("hello!")].join("\n")), { prompt: "hi there", reply: "hello!" })
    assert.equal(lastTurn([user("hi"), assistant([{ type: "tool_use", id: "x", name: "y", input: {} }])].join("\n")), null)
    assert.equal(lastTurn(["not json", user(""), ""].join("\n")), null)
    assert.equal(lastTurn(""), null)
})

test("readTail drops the partial first line and lastTurnFromFile is null for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ciwg-transcript-"))
    const path = join(dir, "t.jsonl")
    const body = [user("x".repeat(3000)), user("the prompt"), assistant("the reply")].join("\n") + "\n"
    writeFileSync(path, body)
    const tail = readTail(path, 200)
    // The cut fell inside the first (3000-char) line: that fragment is dropped, the rest are whole lines.
    assert.ok(!tail.includes("xxxx"), "a mid-line start is dropped")
    assert.ok(tail.startsWith("{"))
    assert.deepEqual(lastTurn(tail), { prompt: "the prompt", reply: "the reply" })
    assert.deepEqual(lastTurnFromFile(path), { prompt: "the prompt", reply: "the reply" })
    assert.equal(lastTurnFromFile(join(dir, "missing.jsonl")), null)
    assert.equal(lastTurnFromFile(""), null)
})
