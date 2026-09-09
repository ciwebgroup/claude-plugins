/**
 * Packaging tests — `npm run package` produces the two zips with the
 * structure each Claude surface expects, the metadata files, and does so
 * deterministically. Also covers the zero-dependency zip writer/reader.
 *
 *   node --test plugins/ciwg-knowledge/tests/package.test.mjs
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(pluginDir, "..", "..")
const { createZip, readZip, crc32 } = await import("../../../tools/lib/zip.mjs")
const { buildAll, buildCodePackage, buildDesktopPackage } = await import("../../../tools/package.mjs")
const { OIDC_CLIENT_ID } = await import("../scripts/lib/auth.mjs")
const { API_BASE } = await import("../scripts/lib/config.mjs")

const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"))
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
const names = (pkg) => pkg.entries.map((e) => e.name)
const entry = (pkg, name) => pkg.entries.find((e) => e.name === name)

const outDir = mkdtempSync(join(tmpdir(), "ciwg-package-"))
after(() => rmSync(outDir, { recursive: true, force: true }))

test("zip: round-trips names and bytes (store + deflate), CRCs verified, unsafe names refused", () => {
    const big = Buffer.alloc(50_000, "abc")
    const buf = createZip([
        { name: "a.txt", data: "hello" },
        { name: "dir/b.bin", data: Buffer.from([0, 1, 2, 3]) },
        { name: "./dir/c.json", data: big },
    ])
    const entries = readZip(buf)
    assert.deepEqual(entries.map((e) => e.name), ["a.txt", "dir/b.bin", "dir/c.json"])
    assert.equal(entries[0].data.toString(), "hello")
    assert.deepEqual([...entries[1].data], [0, 1, 2, 3])
    assert.ok(entries[2].data.equals(big))
    assert.ok(buf.length < big.length / 10, "repetitive data was deflated")
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "CRC-32 check value")
    assert.throws(() => createZip([{ name: "../evil", data: "" }]), /invalid zip entry/)
    assert.throws(() => readZip(Buffer.from("not a zip")), /not a zip/)
})

test("plugin.json: version pinned at 0.3.0 (semver) — users only receive updates when it is bumped", () => {
    assert.equal(manifest.name, "ciwg-knowledge")
    assert.equal(manifest.version, "0.3.0")
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
})

test("Claude Code package: manifest + hooks + local MCP server + skill + commands, no tests, version from plugin.json", () => {
    const pkg = buildCodePackage()
    assert.equal(pkg.file, `ciwg-knowledge-${manifest.version}.zip`)
    const list = names(pkg)
    for (const required of [
        ".claude-plugin/plugin.json",
        "hooks/hooks.json",
        "commands/ciwg-login.md",
        "commands/ciwg-logout.md",
        "skills/company-knowledge/SKILL.md",
        "scripts/knowledge-mcp.mjs",
        "scripts/session-brief.mjs",
        "scripts/inject-context.mjs",
        "scripts/engram-post.mjs",
        "scripts/login.mjs",
        "scripts/logout.mjs",
        "scripts/lib/auth.mjs",
        "scripts/lib/config.mjs",
        "scripts/lib/engram.mjs",
        "scripts/lib/paths.mjs",
        "scripts/lib/state.mjs",
        "README.md",
    ]) {
        assert.ok(list.includes(required), `missing ${required}`)
    }
    assert.ok(!list.some((n) => n.startsWith("tests/") || n.endsWith(".test.mjs")), "tests are not shipped")
    assert.deepEqual(list, [...list].sort(), "entries sorted (deterministic)")

    // The zipped manifest IS the source manifest — the plugin at the archive root.
    const zipped = JSON.parse(entry(pkg, ".claude-plugin/plugin.json").data.toString())
    assert.deepEqual(zipped, manifest)
    assert.equal(zipped.mcpServers["ciwg-knowledge"].command, "node")
    assert.deepEqual(zipped.mcpServers["ciwg-knowledge"].args, ["${CLAUDE_PLUGIN_ROOT}/scripts/knowledge-mcp.mjs"])
    assert.equal(zipped.hooks, "./hooks/hooks.json")
    // The archive parses back to the same bytes.
    const back = readZip(pkg.buffer)
    assert.equal(back.length, pkg.entries.length)
    for (const e of back) {
        assert.ok(entry(pkg, e.name).data.equals(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)))
    }
})

test("Claude Desktop package: no hooks, no local server — the remote SSO connector (.mcp.json http + oauth clientId) and the skill", async () => {
    const pkg = await buildDesktopPackage()
    assert.equal(pkg.file, `ciwg-knowledge-desktop-${manifest.version}.zip`)
    assert.deepEqual(names(pkg), [
        ".claude-plugin/plugin.json",
        ".mcp.json",
        "README.md",
        "skills/company-knowledge/SKILL.md",
    ])
    const zipped = JSON.parse(entry(pkg, ".claude-plugin/plugin.json").data.toString())
    assert.equal(zipped.name, "ciwg-knowledge")
    assert.equal(zipped.version, manifest.version)
    assert.equal(zipped.hooks, undefined, "Desktop chat never runs hooks")
    assert.equal(zipped.mcpServers, undefined, "the connector lives in .mcp.json, declared once")
    assert.match(zipped.description, /CIWG SSO/)
    const mcp = JSON.parse(entry(pkg, ".mcp.json").data.toString())
    assert.deepEqual(mcp, {
        mcpServers: {
            "ciwg-knowledge": {
                type: "http",
                url: `${API_BASE}/mcp`,
                oauth: { clientId: OIDC_CLIENT_ID },
            },
        },
    })
    assert.equal(pkg.mcpUrl, "https://api.ciwebgroup.com/mcp", "production connector by default")
    assert.equal(pkg.clientId, "lVCIMgCq4SQiQAdqHUfg7UONaOISMbpHygQXcIe1")
    const readme = entry(pkg, "README.md").data.toString()
    assert.match(readme, /Customize → Plugins → Add plugin → Upload plugin/)
    assert.match(readme, /Connect/)
    assert.match(readme, new RegExp(`v${manifest.version.replace(/\./g, "\\.")}`))
    // The skill is byte-identical to the source.
    assert.ok(
        entry(pkg, "skills/company-knowledge/SKILL.md").data.equals(
            readFileSync(join(pluginDir, "skills", "company-knowledge", "SKILL.md"))
        )
    )
    // Overrides for a staging build.
    const staging = await buildDesktopPackage({ mcpUrl: "https://api.stage.test/mcp", clientId: "stage-client" })
    const stagingMcp = JSON.parse(entry(staging, ".mcp.json").data.toString())
    assert.equal(stagingMcp.mcpServers["ciwg-knowledge"].url, "https://api.stage.test/mcp")
    assert.equal(stagingMcp.mcpServers["ciwg-knowledge"].oauth.clientId, "stage-client")
})

test("buildAll: writes both zips, release.json and SHA256SUMS that agree; rebuilding is byte-identical", async () => {
    const release = await buildAll({ outDir })
    assert.equal(release.version, manifest.version)
    assert.deepEqual(
        release.assets.map((a) => [a.target, a.file]),
        [
            ["code", `ciwg-knowledge-${manifest.version}.zip`],
            ["desktop", `ciwg-knowledge-desktop-${manifest.version}.zip`],
        ]
    )
    const sums = readFileSync(join(outDir, "SHA256SUMS"), "utf8").trim().split("\n")
    assert.equal(sums.length, 2)
    for (const asset of release.assets) {
        const bytes = readFileSync(join(outDir, asset.file))
        assert.equal(bytes.length, asset.bytes)
        assert.equal(sha256(bytes), asset.sha256)
        assert.ok(sums.includes(`${asset.sha256}  ${asset.file}`), `SHA256SUMS lists ${asset.file}`)
        assert.ok(readZip(bytes).length > 0)
    }
    const onDisk = JSON.parse(readFileSync(join(outDir, "release.json"), "utf8"))
    assert.deepEqual(onDisk, release)

    const again = await buildAll({ outDir })
    assert.deepEqual(again, release, "deterministic: same digests on rebuild")
})

test("npm run package (the CLI) builds into --out", () => {
    const cliOut = join(outDir, "cli")
    const stdout = execFileSync(process.execPath, [join(repoRoot, "tools", "package.mjs"), "--out", cliOut], {
        encoding: "utf8",
        windowsHide: true,
    })
    assert.match(stdout, new RegExp(`ciwg-knowledge-${manifest.version.replace(/\./g, "\\.")}\\.zip`))
    assert.match(stdout, /desktop/)
    const release = JSON.parse(readFileSync(join(cliOut, "release.json"), "utf8"))
    assert.equal(release.assets.length, 2)
    const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts
    assert.equal(scripts.package, "node tools/package.mjs")
})
