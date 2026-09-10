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
 *   ciwg-knowledge-desktop-<version>.zip  Claude Cowork ("Customize →
 *                                         Plugins → Upload plugin", .zip
 *                                         only): Cowork never runs a
 *                                         plugin's local stdio server, so
 *                                         this variant declares the REMOTE
 *                                         SSO connector (.mcp.json, http +
 *                                         oauth) and ships the skill —
 *                                         sign-in is the connector's own
 *                                         "Connect". Claude Desktop chat /
 *                                         claude.ai chat: UNVERIFIED — the
 *                                         docs disagree on whether an
 *                                         uploaded plugin's connector is
 *                                         added there (release.json and
 *                                         the README carry the note and
 *                                         the custom-connector route).
 *
 * Plus release.json (version + sha256 per asset, the surfaces each asset
 * is documented for, and the "verify on first upload" note) and
 * SHA256SUMS, so a marketplace `archive` source can pin the digests and
 * the synapse AI Tools page can show the version (it reads the GitHub
 * release; the streaming proxy is the private-repo path only).
 *
 * Deterministic: sorted entries, fixed timestamps, directory records
 * (tools/lib/zip.mjs) — rebuilding the same commit ON THE SAME NODE MAJOR
 * yields byte-identical archives. Caveat: the deflate bytes come from the
 * zlib bundled with Node, which changes between Node majors, so a rebuild
 * on another Node line can legitimately produce a different sha256 for
 * the very same files. The published digests are whatever CI produced
 * (Node 22, .github/workflows/release.yml); compare a local build against
 * them on Node 22 only.
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
        surfaces: ["claude-code"],
    }
}

/**
 * The Desktop zip is documented for Cowork only until someone uploads it
 * into a real Claude Desktop / claude.ai chat and sees the connector
 * appear: the support article says a plugin's skills and connectors work
 * in chat, the Desktop plugin docs say "Connectors declared by a plugin
 * you add yourself are not added to Claude Desktop's connectors". Carried
 * in release.json and both READMEs so the claim is never made silently.
 */
export function desktopVerifyNote({ mcpUrl, clientId }) {
    return (
        "VERIFY ON FIRST UPLOAD: documented for Claude Cowork; Claude Desktop chat and claude.ai chat are " +
        "UNVERIFIED — the official docs disagree on whether a user-uploaded plugin's .mcp.json connector is " +
        "added in chat. Until a real upload confirms it, chat users add the connector by hand: Settings → " +
        `Connectors → Add custom connector → ${mcpUrl} with OAuth client id ${clientId} (no secret: public client).`
    )
}

/** What the Desktop variant's README says — the steps, and the honest
 * scope of each surface, nothing else. */
function desktopReadme({ version, mcpUrl, clientId }) {
    return `# CIWG company knowledge — Claude Cowork plugin (v${version})

Three steps in Claude Cowork, no tokens:

1. In Claude Desktop, open **Customize → Plugins → Add plugin → Upload plugin** and choose this zip.
2. Open the installed plugin, find the **CIWG Knowledge** connector and click **Connect**. Sign in with your normal CIWG SSO login (Authentik, MFA included) and approve access.
3. Done. Ask Claude about a client, a meeting or a past decision — the bundled skill makes it search company knowledge first and cite its sources.

What you will see: the sign-in page opens once. Claude only asks you to connect again when your CIWG session expires or an admin removes your access.

## Claude Desktop chat / claude.ai chat — unverified

Whether a chat surface picks up the connector from an uploaded plugin is **unverified**: Anthropic's docs disagree (the support article says plugin connectors work in chat; the Claude Desktop plugin docs say connectors declared by a plugin you add yourself are not added). If you upload this zip in chat and **CIWG Knowledge** does not appear under Connectors, add it by hand — same knowledge, same sign-in:

1. **Settings → Connectors → Add custom connector.**
2. Name \`CIWG Knowledge\`, URL \`${mcpUrl}\`; under **Advanced settings** set **OAuth Client ID** to \`${clientId}\` (public client — leave the secret empty).
3. **Connect**, sign in with CIWG SSO, approve.

If the upload DOES work in chat, tell the plugin maintainers so this note can go.

Connector URL (for reference): ${mcpUrl}

This package has no hooks and no local server — Cowork and chat never run those — which is why it differs from the Claude Code package. Claude Code users: download the Claude Code package from the synapse AI Tools page instead.
`
}

/**
 * The Claude Cowork package (Desktop plugin upload; chat surfaces
 * unverified, see desktopVerifyNote): a manifest without hooks or a local
 * server, the remote SSO connector in .mcp.json, and the skill. `mcpUrl` /
 * `clientId` default to the plugin's own defaults (config.mjs API_BASE +
 * /mcp, auth.mjs OIDC_CLIENT_ID) so every surface points at the same
 * Authentik application.
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
            "CIWG company knowledge for Claude Cowork (Desktop plugin upload): the staff knowledge connector (sign in once with CIWG SSO — no tokens) plus a skill that makes Claude search company knowledge before answering questions about clients, meetings and decisions, and cite its sources. Chat surfaces: see README.md in this package.",
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
        { name: "README.md", data: desktopReadme({ version: manifest.version, mcpUrl, clientId }) },
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
        surfaces: ["cowork"],
        unverified: ["claude-desktop-chat", "claude.ai-chat"],
        note: desktopVerifyNote({ mcpUrl, clientId }),
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
        assets.push({
            target: pkg.target,
            file: pkg.file,
            sha256: sha256(pkg.buffer),
            bytes: pkg.buffer.length,
            surfaces: pkg.surfaces,
            ...(pkg.unverified ? { unverified: pkg.unverified, note: pkg.note } : {}),
        })
        log(`${pkg.file}  ${pkg.buffer.length} bytes  ${pkg.entries.length} files`)
    }
    const release = {
        name: "ciwg-knowledge",
        version: packages[0].version,
        // Digests are reproducible on the same Node major only (see the header).
        built_with: { node: process.versions.node },
        assets,
    }
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
