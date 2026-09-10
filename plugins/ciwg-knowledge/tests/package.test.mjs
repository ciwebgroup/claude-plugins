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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(pluginDir, "..", "..")

// The production connector URL / client id are asserted below; a shell
// that points the plugin at a staging API or IdP (CIWG_KNOWLEDGE_URL,
// CIWG_OIDC_CLIENT_ID — the test harness exports a loopback API URL so
// nothing can dial out) must not change what the packages default to.
const savedEnv = {
    CIWG_KNOWLEDGE_URL: process.env.CIWG_KNOWLEDGE_URL,
    CIWG_OIDC_CLIENT_ID: process.env.CIWG_OIDC_CLIENT_ID,
}
delete process.env.CIWG_KNOWLEDGE_URL
delete process.env.CIWG_OIDC_CLIENT_ID
after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
})

const { createZip, readZip, crc32 } = await import("../../../tools/lib/zip.mjs")
const { buildAll, buildCodePackage, buildDesktopPackage, DESKTOP_PLUGIN_NAME } = await import("../../../tools/package.mjs")
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

test("zip: a directory record precedes the first file in each directory (portable extractors); readZip skips them unless asked; still deterministic", () => {
    const files = [
        { name: "a/b/c.txt", data: "x" },
        { name: "a/d.txt", data: "y" },
        { name: "top.txt", data: "z" },
        { name: "a/b/e.txt", data: "w" },
    ]
    const buf = createZip(files)
    assert.deepEqual(
        readZip(buf).map((e) => e.name),
        ["a/b/c.txt", "a/d.txt", "top.txt", "a/b/e.txt"],
        "caller order kept, directories hidden by default"
    )
    const all = readZip(buf, { directories: true })
    assert.deepEqual(
        all.map((e) => e.name),
        ["a/", "a/b/", "a/b/c.txt", "a/d.txt", "top.txt", "a/b/e.txt"],
        "each directory once, before its first file"
    )
    assert.deepEqual(
        all.filter((e) => e.isDirectory).map((e) => [e.name, e.data.length]),
        [["a/", 0], ["a/b/", 0]]
    )
    assert.ok(createZip(files).equals(buf), "byte-identical rebuild")
    assert.ok(!createZip(files, { directories: false }).equals(buf))
    assert.deepEqual(readZip(createZip(files, { directories: false }), { directories: true }).map((e) => e.name), files.map((f) => f.name))
})

test("plugin.json: version pinned at 0.3.3 (semver) — users only receive updates when it is bumped", () => {
    assert.equal(manifest.name, "ciwg-knowledge")
    assert.equal(manifest.version, "0.3.3")
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
    assert.equal(zipped.name, "ciwg-knowledge", "the Claude Code plugin keeps the source name")
    assert.equal(pkg.pluginName, "ciwg-knowledge")
    assert.equal(zipped.mcpServers["ciwg-knowledge"].command, "node")
    assert.deepEqual(zipped.mcpServers["ciwg-knowledge"].args, ["${CLAUDE_PLUGIN_ROOT}/scripts/knowledge-mcp.mjs"])
    assert.equal(zipped.hooks, "./hooks/hooks.json")
    // The archive parses back to the same bytes.
    const back = readZip(pkg.buffer)
    assert.equal(back.length, pkg.entries.length)
    for (const e of back) {
        assert.ok(entry(pkg, e.name).data.equals(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)))
    }
    // …and carries the folder records extractors that need them expect.
    const dirs = readZip(pkg.buffer, { directories: true }).filter((e) => e.isDirectory).map((e) => e.name)
    for (const dir of [".claude-plugin/", "hooks/", "scripts/", "scripts/lib/", "skills/company-knowledge/"]) {
        assert.ok(dirs.includes(dir), `directory record ${dir}`)
    }
    assert.deepEqual(pkg.surfaces, ["claude-code"])
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
    // Its own plugin. Up to 0.3.1 it was also named "ciwg-knowledge", and
    // Claude Desktop registers an upload in the registry Claude Code reads —
    // so on a machine with both, Claude Code reported `ciwg-knowledge@skills-dir:
    // Not loaded — the name "ciwg-knowledge" is already taken by an installed
    // plugin (ciwg-knowledge@local-desktop-app-uploads)` and silently lost the
    // hooks and the automatic sign-in.
    assert.equal(zipped.name, "ciwg-knowledge-desktop")
    assert.equal(DESKTOP_PLUGIN_NAME, "ciwg-knowledge-desktop")
    assert.equal(pkg.pluginName, "ciwg-knowledge-desktop")
    assert.notEqual(zipped.name, manifest.name, "never the Code plugin's name")
    assert.equal(zipped.version, manifest.version)
    assert.deepEqual(zipped.author, manifest.author)
    assert.equal(zipped.homepage, manifest.homepage)
    assert.equal(zipped.repository, manifest.repository)
    assert.equal(zipped.hooks, undefined, "Desktop chat never runs hooks")
    assert.equal(zipped.mcpServers, undefined, "the connector lives in .mcp.json, declared once")
    assert.match(zipped.description, /CIWG SSO/)
    assert.match(zipped.description, /Claude Desktop \/ Cowork variant of ciwg-knowledge/)
    assert.match(zipped.description, /separate plugin from ciwg-knowledge \(Claude Code\)/)
    // The MCP server key is the connector's name ("CIWG Knowledge"), not the
    // plugin's — Claude Code namespaces it per plugin, so it cannot collide.
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
    // Honest scope: Cowork is documented; chat is unverified and gets the
    // custom-connector route (URL + client id) instead of a promise.
    assert.match(readme, /Claude Cowork plugin `ciwg-knowledge-desktop`/)
    assert.match(readme, /installs as the plugin \*\*ciwg-knowledge-desktop\*\*/)
    // Coexistence with the Code plugin on one machine, spelled out.
    assert.match(readme, /Also running Claude Code on this machine\?/)
    assert.match(readme, /a different plugin, \*\*ciwg-knowledge\*\*/)
    assert.match(readme, /`~\/\.claude\/skills\/ciwg-knowledge`/)
    assert.match(readme, /side by side, each under its own name/)
    assert.match(readme, /\*requires authentication\* until you authenticate it there — optional/)
    assert.match(readme, /skip this upload on that machine and add the custom connector/)
    assert.match(readme, /chat — unverified/)
    assert.match(readme, /Settings → Connectors → Add custom connector/)
    assert.ok(readme.includes(`URL \`${API_BASE}/mcp\``))
    assert.ok(readme.includes(OIDC_CLIENT_ID))
    assert.doesNotMatch(readme, /Claude Desktop \/ claude\.ai plugin/)
    assert.deepEqual(pkg.surfaces, ["cowork"])
    assert.deepEqual(pkg.unverified, ["claude-desktop-chat", "claude.ai-chat"])
    assert.match(pkg.note, /^VERIFY ON FIRST UPLOAD/)
    assert.ok(pkg.note.includes(`${API_BASE}/mcp`) && pkg.note.includes(OIDC_CLIENT_ID))
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

test("Desktop package: refuses a source manifest that already carries the Desktop name — the two zips must stay distinct plugins", async () => {
    const clash = join(outDir, "clash")
    mkdirSync(join(clash, ".claude-plugin"), { recursive: true })
    writeFileSync(join(clash, ".claude-plugin", "plugin.json"), JSON.stringify({ name: DESKTOP_PLUGIN_NAME, version: "9.9.9" }))
    await assert.rejects(
        buildDesktopPackage({ pluginDir: clash, mcpUrl: "https://api.stage.test/mcp", clientId: "stage-client" }),
        /must not share the Code plugin's name/
    )
})

test("buildAll: writes both zips, release.json and SHA256SUMS that agree; rebuilding is byte-identical", async () => {
    const release = await buildAll({ outDir })
    assert.equal(release.version, manifest.version)
    assert.deepEqual(
        release.assets.map((a) => [a.target, a.file, a.plugin_name]),
        [
            ["code", `ciwg-knowledge-${manifest.version}.zip`, "ciwg-knowledge"],
            ["desktop", `ciwg-knowledge-desktop-${manifest.version}.zip`, "ciwg-knowledge-desktop"],
        ],
        "each asset names the plugin it installs as — two distinct plugins"
    )
    assert.equal(release.name, "ciwg-knowledge", "the release / source plugin name")
    const sums = readFileSync(join(outDir, "SHA256SUMS"), "utf8").trim().split("\n")
    assert.equal(sums.length, 2)
    for (const asset of release.assets) {
        const bytes = readFileSync(join(outDir, asset.file))
        assert.equal(bytes.length, asset.bytes)
        assert.equal(sha256(bytes), asset.sha256)
        assert.ok(sums.includes(`${asset.sha256}  ${asset.file}`), `SHA256SUMS lists ${asset.file}`)
        const zipped = readZip(bytes)
        assert.ok(zipped.length > 0)
        // release.json's plugin_name IS the name inside the zip's manifest.
        const zippedManifest = JSON.parse(zipped.find((e) => e.name === ".claude-plugin/plugin.json").data.toString())
        assert.equal(zippedManifest.name, asset.plugin_name, `${asset.file}: plugin_name matches the zipped manifest`)
    }
    const onDisk = JSON.parse(readFileSync(join(outDir, "release.json"), "utf8"))
    assert.deepEqual(onDisk, release)
    // The "verify on first upload" note travels with the Desktop asset; the
    // Node line the digests were produced on is recorded.
    const desktop = release.assets.find((a) => a.target === "desktop")
    assert.deepEqual(desktop.surfaces, ["cowork"])
    assert.deepEqual(desktop.unverified, ["claude-desktop-chat", "claude.ai-chat"])
    assert.match(desktop.note, /VERIFY ON FIRST UPLOAD/)
    assert.match(desktop.note, /Add custom connector/)
    assert.ok(desktop.note.includes(OIDC_CLIENT_ID))
    const code = release.assets.find((a) => a.target === "code")
    assert.deepEqual(code.surfaces, ["claude-code"])
    assert.equal(code.note, undefined)
    assert.equal(release.built_with.node, process.versions.node)

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
