/**
 * Self-update — install once, stay current.
 *
 * The plugin is a plain directory however it was installed (the Code
 * tab's plugin upload, the skills folder, a marketplace), and Claude Code
 * runs its hooks and server as fresh `node` processes, so replacing the
 * files in place is all an update takes: the next session runs the new
 * code. This module fetches the latest public release's manifest
 * (release.json — an asset, no API quota), downloads the Claude Code zip
 * when it is newer than what is installed, verifies its SHA-256 against
 * the manifest, checks the archive really is this plugin at that version,
 * and only then writes the files — each one next to its target and
 * renamed over it, never a half-written script.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, normalize, sep } from "node:path"
import { inflateRawSync } from "node:zlib"

export const RELEASES_BASE = "https://github.com/ciwebgroup/claude-plugins/releases"
export const PLUGIN_NAME = "ciwg-knowledge"
/** A zip bigger than this is not ours. */
const MAX_ZIP_BYTES = 5 * 1024 * 1024

/** semver a vs b: negative, 0, positive. Non-semver → treated as 0.0.0. */
export function compareSemver(a, b) {
    const parse = (v) => {
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""))
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
    }
    const [x, y] = [parse(a), parse(b)]
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
}

/* ── minimal zip reader (store + deflate, what the packager writes) ─── */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const DOS_DIRECTORY = 0x10

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

export function crc32(buf) {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
}

/** [{ name, data }] for every file entry; directories skipped; corrupt → throws. */
export function readZip(buf) {
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
        if (buf.readUInt32LE(i) === SIG_EOCD) {
            eocd = i
            break
        }
    }
    if (eocd < 0) throw new Error("not a zip file")
    const count = buf.readUInt16LE(eocd + 10)
    let pos = buf.readUInt32LE(eocd + 16)
    const entries = []
    for (let n = 0; n < count; n += 1) {
        if (buf.readUInt32LE(pos) !== SIG_CENTRAL) throw new Error("corrupt central directory")
        const method = buf.readUInt16LE(pos + 10)
        const crc = buf.readUInt32LE(pos + 16)
        const compressedSize = buf.readUInt32LE(pos + 20)
        const size = buf.readUInt32LE(pos + 24)
        const nameLen = buf.readUInt16LE(pos + 28)
        const extraLen = buf.readUInt16LE(pos + 30)
        const commentLen = buf.readUInt16LE(pos + 32)
        const externalAttrs = buf.readUInt32LE(pos + 38)
        const localOffset = buf.readUInt32LE(pos + 42)
        const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8")
        pos += 46 + nameLen + extraLen + commentLen
        const isDirectory = name.endsWith("/") || (externalAttrs & DOS_DIRECTORY) !== 0
        if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`corrupt local header for ${name}`)
        const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
        const stored = buf.subarray(dataStart, dataStart + compressedSize)
        let data
        if (method === METHOD_STORE) data = Buffer.from(stored)
        else if (method === METHOD_DEFLATE) data = inflateRawSync(stored)
        else throw new Error(`unsupported compression method ${method} for ${name}`)
        if (data.length !== size || crc32(data) !== crc) throw new Error(`corrupt entry ${name}`)
        if (!isDirectory) entries.push({ name, data })
    }
    return entries
}

/* ── release lookup + apply ────────────────────────────────────────── */

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

async function fetchBytes(url, { timeoutMs = 20_000, maxBytes = MAX_ZIP_BYTES, fetchImpl = globalThis.fetch } = {}) {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error(`download too large (${buf.length} bytes)`)
    return buf
}

/**
 * { version, file, sha256 } of the latest release's Claude Code zip from
 * its release.json, or null when the manifest is unreadable.
 */
export async function fetchLatestRelease({ base = RELEASES_BASE, fetchImpl } = {}) {
    let manifest
    try {
        manifest = JSON.parse((await fetchBytes(`${base}/latest/download/release.json`, { fetchImpl, maxBytes: 64_000 })).toString("utf8"))
    } catch {
        return null
    }
    const version = typeof manifest?.version === "string" ? manifest.version : null
    const asset = Array.isArray(manifest?.assets)
        ? manifest.assets.find((a) => a?.plugin_name === PLUGIN_NAME || a?.file === `${PLUGIN_NAME}-${version}.zip`)
        : null
    if (!version || !asset || typeof asset.file !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) return null
    return { version, file: asset.file, sha256: asset.sha256 }
}

/** A zip entry name that could land outside the plugin root. */
export const unsafeName = (name) =>
    !name || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes("..")

/**
 * Download, verify and install `release` into `root`. Refuses (throws)
 * when the digest mismatches, the archive is not this plugin at that
 * version, or an entry name escapes the root. Files are written next to
 * their target and renamed over it.
 */
export async function applyUpdate(root, release, { base = RELEASES_BASE, fetchImpl } = {}) {
    const zip = await fetchBytes(`${base}/download/${PLUGIN_NAME}-v${release.version}/${release.file}`, { fetchImpl })
    const digest = sha256(zip)
    if (digest !== release.sha256) throw new Error(`sha256 mismatch for ${release.file}`)
    const entries = readZip(zip)
    const manifestEntry = entries.find((e) => e.name === ".claude-plugin/plugin.json")
    if (!manifestEntry) throw new Error("archive carries no plugin manifest")
    const manifest = JSON.parse(manifestEntry.data.toString("utf8"))
    if (manifest.name !== PLUGIN_NAME || manifest.version !== release.version) {
        throw new Error(`archive is ${manifest.name}@${manifest.version}, not ${PLUGIN_NAME}@${release.version}`)
    }
    for (const entry of entries) if (unsafeName(entry.name)) throw new Error(`refusing entry ${entry.name}`)
    // The manifest last: a session that starts mid-update sees the old
    // version until every script is in place.
    const ordered = [...entries.filter((e) => e !== manifestEntry), manifestEntry]
    for (const entry of ordered) {
        const target = normalize(join(root, entry.name))
        if (!target.startsWith(normalize(root) + sep)) throw new Error(`refusing entry ${entry.name}`)
        mkdirSync(dirname(target), { recursive: true })
        const tmp = `${target}.update-tmp`
        writeFileSync(tmp, entry.data)
        try {
            renameSync(tmp, target)
        } catch (error) {
            rmSync(tmp, { force: true })
            throw error
        }
    }
    return { version: release.version, files: entries.length }
}

/** The installed version from the plugin manifest under `root`. */
export function installedVersion(root) {
    try {
        return JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version ?? null
    } catch {
        return null
    }
}
