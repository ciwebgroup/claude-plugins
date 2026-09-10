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
 *   ciwg-knowledge-<version>.zip          plugin `ciwg-knowledge` — Claude
 *                                         Code (terminal, and the desktop
 *                                         app's Code tab): the plugin as-is
 *                                         — hooks, the local stdio MCP
 *                                         server, /ciwg-login, the skill.
 *                                         `claude --plugin-dir` accepts this
 *                                         zip directly; unzipped into
 *                                         ~/.claude/skills/ciwg-knowledge it
 *                                         auto-loads with no install step.
 *   ciwg-knowledge-desktop-<version>.zip  plugin `ciwg-knowledge-desktop` —
 *                                         Claude Cowork ("Customize →
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
 * The two zips are two DISTINCT plugins on purpose (since 0.3.2). Claude
 * Desktop stores an uploaded plugin under
 * ~/.claude/plugins/marketplaces/local-desktop-app-uploads/<name> and
 * registers it in the same installed-plugins registry Claude Code reads,
 * and an installed plugin takes precedence over a same-named one under
 * ~/.claude/skills. While both zips said `ciwg-knowledge`, a machine with
 * the Code zip unzipped AND the Desktop zip uploaded got, in Claude Code:
 *   ciwg-knowledge@skills-dir: Not loaded — the name "ciwg-knowledge" is
 *   already taken by an installed plugin
 *   (ciwg-knowledge@local-desktop-app-uploads), which takes precedence.
 * — i.e. the hook-less Desktop variant silently replaced the Code plugin:
 * no auto-injection, no automatic sign-in. Under different names both load
 * side by side (the Desktop plugin's connector just shows "requires
 * authentication" in Claude Code until authenticated with /mcp, which is
 * optional there). The MCP server key inside .mcp.json stays
 * `ciwg-knowledge` — that is the connector's name, "CIWG Knowledge" in the
 * READMEs — and it cannot collide: Claude Code namespaces it per plugin
 * (plugin:ciwg-knowledge-desktop:ciwg-knowledge).
 *
 * Plus release.json (version + sha256 per asset, each asset's plugin name,
 * the surfaces each asset is documented for, and the "verify on first
 * upload" note) and SHA256SUMS, so a marketplace `archive` source can pin
 * the digests. (The
 * synapse AI Tools page takes the version from the GitHub release itself;
 * its streaming proxy is the private-repo path only.)
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
/** The Desktop zip's plugin name — deliberately NOT the source plugin's
 * (`ciwg-knowledge`, the Code zip), see the header: a same-named Desktop
 * upload shadows the Code plugin in Claude Code on the same machine. */
export const DESKTOP_PLUGIN_NAME = "ciwg-knowledge-desktop"

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
        // The two zip FILE names (`ciwg-knowledge-<v>.zip`,
        // `ciwg-knowledge-desktop-<v>.zip`) are a contract with ci-connect's
        // plugin-package route (ASSET_PATTERNS) and the release notes — the
        // source manifest's name is pinned by plugins/ciwg-knowledge/tests/package.test.mjs.
        file: `${manifest.name}-${manifest.version}.zip`,
        pluginName: manifest.name,
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
function desktopReadme({ version, mcpUrl, clientId, pluginName, codePluginName }) {
    return `# CIWG company knowledge — Claude Cowork plugin \`${pluginName}\` (v${version})

Three steps in Claude Cowork, no tokens:

1. In Claude Desktop, open **Customize → Plugins → Add plugin → Upload plugin** and choose this zip. It installs as the plugin **${pluginName}**. Upgrading from 0.3.1 or earlier? Remove the old \`${codePluginName}\` upload first (Customize → Plugins, or \`claude plugin uninstall ${codePluginName}@local-desktop-app-uploads\`) — the name changed, so this upload adds a plugin rather than replacing it.
2. Open the installed plugin, find the **CIWG Knowledge** connector and click **Connect**. Sign in with your normal CIWG SSO login (Authentik, MFA included) and approve access.
3. Done. Ask Claude about a client, a meeting or a past decision — the bundled skill makes it search company knowledge first and cite its sources.

What you will see: the sign-in page opens once. Claude only asks you to connect again when your CIWG session expires or an admin removes your access.

## Also running Claude Code on this machine?

This is the plugin **${pluginName}**; the Claude Code package (\`${codePluginName}-<version>.zip\`, unzipped into \`~/.claude/skills/${codePluginName}\`) is a different plugin, **${codePluginName}**. Claude Desktop registers an uploaded plugin in the same plugin registry Claude Code reads, so both appear in Claude Code — side by side, each under its own name, so the company-knowledge skill and the CIWG Knowledge connector each show up twice there, once per plugin. (Before 0.3.2 the two shared a name and this upload silently replaced the Code plugin there: no hooks, no automatic sign-in.) In Claude Code, \`/mcp\` lists this plugin's **CIWG Knowledge** connector as *requires authentication* until you authenticate it there — optional, because the Code plugin already injects the same knowledge; authenticate it only if you also want the remote connector's tools in Claude Code. If you would rather not have the duplicate, skip this upload on that machine and add the custom connector in Claude Desktop instead (next section).

## Claude Desktop chat / claude.ai chat — unverified

Whether a chat surface picks up the connector from an uploaded plugin is **unverified**: Anthropic's docs disagree (the support article says plugin connectors work in chat; the Claude Desktop plugin docs say connectors declared by a plugin you add yourself are not added). If you upload this zip in chat and **CIWG Knowledge** does not appear under Connectors, add it by hand — same knowledge, same sign-in:

1. **Settings → Connectors → Add custom connector.**
2. Name \`CIWG Knowledge\`, URL \`${mcpUrl}\`; under **Advanced settings** set **OAuth Client ID** to \`${clientId}\` (public client — leave the secret empty).
3. **Connect**, sign in with CIWG SSO, approve.

If the upload DOES work in chat, tell the plugin maintainers so this note can go.

Connector URL (for reference): ${mcpUrl}

This package has no hooks and no local server — Cowork and chat never run those — which is why it is a separate plugin from the Claude Code package. Claude Code users: download the Claude Code package from the synapse AI Tools page instead.
`
}

/**
 * The Claude Cowork package (Desktop plugin upload; chat surfaces
 * unverified, see desktopVerifyNote): its own plugin, DESKTOP_PLUGIN_NAME
 * — a manifest without hooks or a local server, the remote SSO connector
 * in .mcp.json, and the skill. `mcpUrl` / `clientId` default to the
 * plugin's own defaults (config.mjs API_BASE + /mcp, auth.mjs
 * OIDC_CLIENT_ID) so every surface points at the same Authentik
 * application.
 */
export async function buildDesktopPackage({ pluginDir = PLUGIN_DIR, mcpUrl, clientId } = {}) {
    const manifest = readPluginManifest(pluginDir)
    if (manifest.name === DESKTOP_PLUGIN_NAME) {
        throw new Error(`the Desktop zip must not share the Code plugin's name (${JSON.stringify(manifest.name)}) — it would shadow it in Claude Code`)
    }
    if (!mcpUrl || !clientId) {
        const [{ API_BASE }, { OIDC_CLIENT_ID }] = await Promise.all([
            import(toFileUrl(join(pluginDir, "scripts", "lib", "config.mjs"))),
            import(toFileUrl(join(pluginDir, "scripts", "lib", "auth.mjs"))),
        ])
        mcpUrl ??= `${API_BASE}/mcp`
        clientId ??= OIDC_CLIENT_ID
    }
    const desktopManifest = {
        name: DESKTOP_PLUGIN_NAME,
        version: manifest.version,
        description:
            `CIWG company knowledge — the Claude Desktop / Cowork variant of ${manifest.name} (plugin upload): the remote CIWG Knowledge SSO connector (sign in once with CIWG SSO — no tokens) plus the company-knowledge skill, which makes Claude search company knowledge before answering questions about clients, meetings and decisions, and cite its sources. No hooks, no local server; a separate plugin from ${manifest.name} (Claude Code), so both can be installed on one machine. Chat surfaces: see README.md in this package.`,
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
        {
            name: "README.md",
            data: desktopReadme({
                version: manifest.version,
                mcpUrl,
                clientId,
                pluginName: DESKTOP_PLUGIN_NAME,
                codePluginName: manifest.name,
            }),
        },
    ]
    for (const top of DESKTOP_TOP_LEVEL) {
        entries.push(...collect(join(pluginDir, top), pluginDir))
    }
    const sorted = sortEntries(entries)
    return {
        target: "desktop",
        file: `${DESKTOP_PLUGIN_NAME}-${manifest.version}.zip`,
        pluginName: DESKTOP_PLUGIN_NAME,
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
            // The plugin `name` inside the zip's .claude-plugin/plugin.json —
            // distinct per asset (see the header), and what Claude Code /
            // Claude Desktop register the install under.
            plugin_name: pkg.pluginName,
            sha256: sha256(pkg.buffer),
            bytes: pkg.buffer.length,
            surfaces: pkg.surfaces,
            ...(pkg.unverified ? { unverified: pkg.unverified, note: pkg.note } : {}),
        })
        log(`${pkg.file}  ${pkg.buffer.length} bytes  ${pkg.entries.length} files`)
    }
    const release = {
        // The source plugin / release name; each asset carries its own plugin_name.
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
