/**
 * update.mjs — self-update: semver compare, the zip reader against what
 * the packager writes, the release manifest lookup, and applyUpdate's
 * refusals (digest, wrong plugin/version, escaping entry names) and its
 * in-place file replacement.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createZip } from "../../../tools/lib/zip.mjs"
import { applyUpdate, compareSemver, fetchLatestRelease, installedVersion, readZip, unsafeName } from "../scripts/lib/update.mjs"

const sha = (buf) => createHash("sha256").update(buf).digest("hex")
const manifest = (version, name = "ciwg-knowledge") => Buffer.from(JSON.stringify({ name, version }))

const releaseZip = (version, extra = []) =>
    createZip([
        { name: ".claude-plugin/plugin.json", data: manifest(version) },
        { name: "scripts/inject-context.mjs", data: Buffer.from(`// v${version}\n`) },
        { name: "scripts/lib/new-file.mjs", data: Buffer.from("export const fresh = true\n") },
        ...extra,
    ])

/** A fake GitHub: release.json + the zip, by URL suffix. */
const fakeFetch = (version, zip, { manifestOverride } = {}) => async (url) => {
    const body = url.endsWith("/latest/download/release.json")
        ? Buffer.from(
              JSON.stringify(
                  manifestOverride ?? {
                      version,
                      assets: [{ file: `ciwg-knowledge-${version}.zip`, plugin_name: "ciwg-knowledge", sha256: sha(zip) }],
                  }
              )
          )
        : url.endsWith(`/download/ciwg-knowledge-v${version}/ciwg-knowledge-${version}.zip`)
          ? zip
          : null
    return { ok: body !== null, status: body ? 200 : 404, arrayBuffer: async () => body ?? Buffer.alloc(0) }
}

test("compareSemver", () => {
    assert.ok(compareSemver("0.3.5", "0.3.4") > 0)
    assert.ok(compareSemver("0.10.0", "0.9.9") > 0)
    assert.equal(compareSemver("1.2.3", "1.2.3"), 0)
    assert.ok(compareSemver("garbage", "0.0.1") < 0)
})

test("readZip reads what createZip writes (store and deflate, directories skipped)", () => {
    const entries = readZip(createZip([{ name: "a/b.txt", data: Buffer.from("hello") }, { name: "c.bin", data: Buffer.alloc(5000, 7) }]))
    assert.deepEqual(entries.map((e) => e.name), ["a/b.txt", "c.bin"])
    assert.equal(entries[0].data.toString(), "hello")
    assert.equal(entries[1].data.length, 5000)
    assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /not a zip/)
})

test("fetchLatestRelease: the Claude Code asset of the latest manifest, null when unreadable", async () => {
    const zip = releaseZip("0.9.0")
    assert.deepEqual(await fetchLatestRelease({ fetchImpl: fakeFetch("0.9.0", zip) }), {
        version: "0.9.0",
        file: "ciwg-knowledge-0.9.0.zip",
        sha256: sha(zip),
    })
    assert.equal(await fetchLatestRelease({ fetchImpl: fakeFetch("0.9.0", zip, { manifestOverride: { nope: 1 } }) }), null)
    assert.equal(await fetchLatestRelease({ fetchImpl: async () => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.alloc(0) }) }), null)
})

test("applyUpdate replaces the plugin's files in place — manifest last — and refuses a bad digest, the wrong plugin, or an escaping entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ciwg-update-"))
    mkdirSync(join(root, ".claude-plugin"), { recursive: true })
    mkdirSync(join(root, "scripts"), { recursive: true })
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), manifest("0.3.4"))
    writeFileSync(join(root, "scripts", "inject-context.mjs"), "// v0.3.4\n")
    assert.equal(installedVersion(root), "0.3.4")

    const zip = releaseZip("0.3.5")
    const release = { version: "0.3.5", file: "ciwg-knowledge-0.3.5.zip", sha256: sha(zip) }
    const result = await applyUpdate(root, release, { fetchImpl: fakeFetch("0.3.5", zip) })
    assert.deepEqual(result, { version: "0.3.5", files: 3 })
    assert.equal(installedVersion(root), "0.3.5")
    assert.equal(readFileSync(join(root, "scripts", "inject-context.mjs"), "utf8"), "// v0.3.5\n")
    assert.equal(readFileSync(join(root, "scripts", "lib", "new-file.mjs"), "utf8"), "export const fresh = true\n")

    // Digest mismatch: nothing written.
    await assert.rejects(
        applyUpdate(root, { ...release, sha256: "0".repeat(64) }, { fetchImpl: fakeFetch("0.3.5", zip) }),
        /sha256 mismatch/
    )
    // The archive is not this plugin at that version.
    const other = createZip([{ name: ".claude-plugin/plugin.json", data: manifest("0.3.5", "ciwg-knowledge-desktop") }])
    await assert.rejects(
        applyUpdate(root, { ...release, sha256: sha(other) }, { fetchImpl: fakeFetch("0.3.5", other) }),
        /not ciwg-knowledge@0\.3\.5/
    )
    assert.equal(installedVersion(root), "0.3.5")
})

test("unsafeName: entry names that could escape the plugin root are refused (the packager never writes them, a tampered zip might)", () => {
    for (const name of ["../outside.txt", "scripts/../../x", "/etc/passwd", "\\\\server\\share", "C:/Windows/x", ""]) {
        assert.equal(unsafeName(name), true, name)
    }
    for (const name of [".claude-plugin/plugin.json", "scripts/lib/update.mjs", "README.md", "a..b/c.txt"]) {
        assert.equal(unsafeName(name), false, name)
    }
})
