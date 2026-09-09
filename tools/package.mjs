#!/usr/bin/env node
/**
 * Build the downloadable plugin packages — `npm run package`.
 *
 *   node tools/package.mjs [--out <dir>] [--quiet]
 *
 * ONE source (plugins/ciwg-knowledge) → TWO zips, because the two Claude
 * surfaces run different plugin components (verified against the official
 * docs on 2026-09-09, see the README "What runs where"):
 *
 *   ciwg-knowledge-<version>.zip          Claude Code (terminal, and the
 *                                         desktop app's Code tab): the plugin
 *                                         as-is — hooks, the local stdio MCP
 *                                         server, /ciwg-login, the skill.
 *                                         `claude --plugin-dir` accepts this
 *                                         zip directly; unzipped into
 *                                         ~/.claude/skills/ciwg-knowledge it
 *                                         auto-loads with no install step.
 *   ciwg-knowledge-desktop-<version>.zip  Claude Desktop / claude.ai / Cowork
 *                                         ("Customize → Plugins → Upload
 *                                         plugin", .zip only): those surfaces
 *                                         never run a plugin's hooks or
 *                                         local stdio servers in chat, so
 *                                         this variant bundles the REMOTE
 *                                         SSO connector (.mcp.json, http +
 *                                         oauth) and the skill — sign-in is
 *                                         the connector's own "Connect".
 *
 * Plus release.json (version + sha256 per asset) and SHA256SUMS, so a
 * marketplace `archive` source can pin the digests and the synapse
 * download proxy can show the version.
 *
 * Deterministic: sorted entries, fixed timestamps (tools/lib/zip.mjs) —
 * rebuilding the same commit yields byte-identical archives.
 *
 * Zero dependencies (no `zip` binary, no npm install): Node ≥ 18 only.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, posix, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createZip } from "./lib/zip.mjs"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
export const PLUGIN_DIR = join(repoRoot, "plugins", "ciwg-knowledge")
export const DEFAULT_OUT_DIR = join(repoRoot, "dist")

/** Top-level entries of the plugin directory that ship in the Claude Code
 * zip (everything else — tests, scratch files — stays out). */
const CODE_TOP_LEVEL = [".claude-plugin", "hooks", "commands", "skills", "scripts", "README.md"]
/** Shipped in the Desktop zip from the source tree (the rest is generated). */
const DESKTOP_TOP_LEVEL = ["skills"]

const toPosix = (p) => p.split(sep).join(posix.sep)

/** Code-unit order — NOT localeCompare, which differs between machines and
 * would break byte-identical rebuilds. */
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** [{ name, data }] for every file under `dir`, names relative to `base`,
 * sorted for determinism. Skips *.test.mjs anywhere. */
function collect(dir, base) {
    const out = []
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort(byName)) {
            const full = join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile() && !/\.test\.mjs$/.test(entry.name)) {
                out.push({ name: toPosix(relative(base, full)), data: readFileSync(full) })
            }
        }
    }
    const stat = statSync(dir)
    if (stat.isDirectory()) walk(dir)
    else out.push({ name: toPosix(relative(base, dir)), data: readFileSync(dir) })
    return out
}

const sortEntries = (entries) => [...entries].sort(byName)

export function readPluginManifest(pluginDir = PLUGIN_DIR) {
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"))
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
        throw new Error(`plugin.json version must be semver (x.y.z), got ${JSON.stringify(manifest.version)}`)
    }
    return manifest
}

/** The Claude Code package: the plugin directory, minus tests. */
export function buildCodePackage({ pluginDir = PLUGIN_DIR } = {}) {
    const manifest = readPluginManifest(pluginDir)
    const entries = []
    for (const top of CODE_TOP_LEVEL) {
        entries.push(...collect(join(pluginDir, top), pluginDir))
    }
    const sorted = sortEntries(entries)
    return {
        target: "code",
        file: `ciwg-knowledge-${manifest.version}.zip`,
        version: manifest.version,
        entries: sorted,
        buffer: createZip(sorted),
    }
}

/** What the Desktop variant's README says — the three steps, nothing else. */
function desktopReadme({ version, mcpUrl }) {
    return `# CIWG company knowledge — Claude Desktop / claude.ai plugin (v${version})

Three steps, no tokens:

1. In Claude Desktop (or claude.ai), open **Customize → Plugins → Add plugin → Upload plugin** and choose this zip.
2. Open the installed plugin, find the **CIWG Knowledge** connector and click **Connect**. Sign in with your normal CIWG SSO login (Authentik, MFA included) and approve access.
3. Done. Ask Claude about a client, a meeting or a past decision — the bundled skill makes it search company knowledge first and cite its sources.

What you will see: the sign-in page opens once. Claude only asks you to connect again when your CIWG session expires or an admin removes your access.

Connector URL (for reference): ${mcpUrl}

Claude Desktop's chat runs a plugin's skills and connectors; it does not run local hooks or local servers — that is why this package is different from the Claude Code one. Claude Code users: download the Claude Code package from the synapse AI Tools page instead.
`
}

/**
 * The Claude Desktop / claude.ai / Cowork package: a manifest without
 * hooks or a local server, the remote SSO connector in .mcp.json, and the
 * skill. `mcpUrl` / `clientId` default to the plugin's own defaults
 * (config.mjs API_BASE + /mcp, auth.mjs OIDC_CLIENT_ID) so the three
 * surfaces always point at the same Authentik application.
 */
export async function buildDesktopPackage({ pluginDir = PLUGIN_DIR, mcpUrl, clientId } = {}) {
    const manifest = readPluginManifest(pluginDir)
    if (!mcpUrl || !clientId) {
        const [{ API_BASE }, { OIDC_CLIENT_ID }] = await Promise.all([
            import(toFileUrl(join(pluginDir, "scripts", "lib", "config.mjs"))),
            import(toFileUrl(join(pluginDir, "scripts", "lib", "auth.mjs"))),
        ])
        mcpUrl ??= `${API_BASE}/mcp`
        clientId ??= OIDC_CLIENT_ID
    }
    const desktopManifest = {
        name: manifest.name,
        version: manifest.version,
        description:
            "CIWG company knowledge for Claude Desktop, claude.ai and Cowork: the staff knowledge connector (sign in once with CIWG SSO — no tokens) plus a skill that makes Claude search company knowledge before answering questions about clients, meetings and decisions, and cite its sources.",
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
    }
    const mcp = {
        mcpServers: {
            "ciwg-knowledge": {
                type: "http",
                url: mcpUrl,
                oauth: { clientId },
            },
        },
    }
    const entries = [
        { name: ".claude-plugin/plugin.json", data: `${JSON.stringify(desktopManifest, null, 4)}\n` },
        { name: ".mcp.json", data: `${JSON.stringify(mcp, null, 4)}\n` },
        { name: "README.md", data: desktopReadme({ version: manifest.version, mcpUrl }) },
    ]
    for (const top of DESKTOP_TOP_LEVEL) {
        entries.push(...collect(join(pluginDir, top), pluginDir))
    }
    const sorted = sortEntries(entries)
    return {
        target: "desktop",
        file: `ciwg-knowledge-desktop-${manifest.version}.zip`,
        version: manifest.version,
        entries: sorted,
        buffer: createZip(sorted),
        mcpUrl,
        clientId,
    }
}

const toFileUrl = (p) => new URL(`file:///${toPosix(p).replace(/^\/+/, "")}`).href

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

/** Build both packages and their metadata files into `outDir`. */
export async function buildAll({ outDir = DEFAULT_OUT_DIR, pluginDir = PLUGIN_DIR, log = () => {} } = {}) {
    const packages = [buildCodePackage({ pluginDir }), await buildDesktopPackage({ pluginDir })]
    mkdirSync(outDir, { recursive: true })
    const assets = []
    for (const pkg of packages) {
        writeFileSync(join(outDir, pkg.file), pkg.buffer)
        assets.push({ target: pkg.target, file: pkg.file, sha256: sha256(pkg.buffer), bytes: pkg.buffer.length })
        log(`${pkg.file}  ${pkg.buffer.length} bytes  ${pkg.entries.length} files`)
    }
    const release = { name: "ciwg-knowledge", version: packages[0].version, assets }
    writeFileSync(join(outDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`)
    writeFileSync(join(outDir, "SHA256SUMS"), assets.map((a) => `${a.sha256}  ${a.file}\n`).join(""))
    log(`release.json + SHA256SUMS written to ${outDir}`)
    return release
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
    const args = process.argv.slice(2)
    const outIndex = args.indexOf("--out")
    const outDir = outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT_DIR
    const quiet = args.includes("--quiet")
    try {
        await buildAll({ outDir, log: quiet ? () => {} : (line) => process.stdout.write(`${line}\n`) })
    } catch (error) {
        process.stderr.write(`package failed: ${error?.message ?? error}\n`)
        process.exitCode = 1
    }
}
