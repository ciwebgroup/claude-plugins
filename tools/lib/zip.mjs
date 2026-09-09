/**
 * Minimal, dependency-free ZIP writer + reader (PKZIP 2.0, deflate).
 *
 * Why hand-rolled: the packaging step must run on any staff/CI machine with
 * nothing but Node — no `zip` binary (absent on Windows), no npm install
 * (the repo has no node_modules by design). Node ships zlib, which is the
 * only hard part; the container format is ~100 lines.
 *
 * Deterministic output: entries are written in the order given, every
 * entry carries the same fixed timestamp, and file modes are fixed (0644
 * files, 0755 directories) — so the same inputs always produce
 * byte-identical archives and a stable sha256 (the marketplace `archive`
 * source pins archives by digest). One caveat: the deflate bytes are
 * whatever the zlib bundled with the running Node produces, and that
 * changes between Node MAJORS — "same inputs" includes the Node line
 * (tools/package.mjs).
 *
 * Portability: a directory record ("dir/", zero bytes, the MS-DOS
 * directory attribute) precedes the first file inside each directory.
 * Info-ZIP and macOS do without them, but several extractors (Windows'
 * built-in one on some paths, Java ZipInputStream-based tools, older
 * 7-Zip builds) create the folder tree from those records and mis-handle
 * an archive that has none.
 *
 * Reader: enough to verify what the writer produced (central directory →
 * entries → inflated bytes) — used by the tests and by `package.mjs
 * --verify`.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib"

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** "made by" version: 3 = UNIX (so the external attrs carry a mode), spec 2.0. */
const VERSION_MADE_BY = (3 << 8) | 20
const VERSION_NEEDED = 20
/** Bit 11: the file name is UTF-8. */
const FLAG_UTF8 = 0x0800
/** MS-DOS directory attribute (low byte of the external attributes). */
const DOS_DIRECTORY = 0x10
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

/** 2024-01-01 00:00:00 in MS-DOS date/time (local-time-agnostic constant). */
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1
const DOS_TIME = 0

const EMPTY = Buffer.alloc(0)

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
    for (let i = 0; i < buf.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}

/**
 * The records to write: the caller's entries in the order given, each
 * preceded by a record for every not-yet-seen parent directory. Order is
 * preserved (never re-sorted) so the caller's determinism contract holds.
 */
function withDirectoryRecords(entries) {
    const out = []
    const seen = new Set()
    for (const entry of entries) {
        const name = normalizeName(entry.name)
        const parts = name.split("/")
        let prefix = ""
        for (let i = 0; i < parts.length - 1; i += 1) {
            prefix += `${parts[i]}/`
            if (!seen.has(prefix)) {
                seen.add(prefix)
                out.push({ name: prefix, data: EMPTY, isDirectory: true })
            }
        }
        out.push({ ...entry, name, isDirectory: false })
    }
    return out
}

/**
 * Build a zip from `entries`: [{ name, data, mode? }] where `name` is a
 * forward-slash path relative to the archive root (no leading "./" or "/")
 * and `data` is a Buffer or string. Directory records are added for every
 * parent directory (see the header); `{ directories: false }` omits them.
 * Returns the archive as a Buffer.
 */
export function createZip(entries, { directories = true } = {}) {
    const records = directories
        ? withDirectoryRecords(entries)
        : entries.map((entry) => ({ ...entry, name: normalizeName(entry.name), isDirectory: false }))
    const locals = []
    const centrals = []
    let offset = 0
    for (const record of records) {
        const nameBuf = Buffer.from(record.name, "utf8")
        const raw = record.isDirectory
            ? EMPTY
            : Buffer.isBuffer(record.data)
              ? record.data
              : Buffer.from(String(record.data), "utf8")
        const crc = crc32(raw)
        let method = METHOD_STORE
        let stored = raw
        if (!record.isDirectory) {
            const deflated = deflateRawSync(raw, { level: 9 })
            if (deflated.length < raw.length) {
                method = METHOD_DEFLATE
                stored = deflated
            }
        }
        const externalAttrs = record.isDirectory
            ? (((S_IFDIR | 0o755) << 16) | DOS_DIRECTORY) >>> 0
            : ((S_IFREG | (record.mode ?? 0o644)) << 16) >>> 0

        const local = Buffer.alloc(30)
        local.writeUInt32LE(SIG_LOCAL, 0)
        local.writeUInt16LE(VERSION_NEEDED, 4)
        local.writeUInt16LE(FLAG_UTF8, 6)
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(DOS_TIME, 10)
        local.writeUInt16LE(DOS_DATE, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(stored.length, 18)
        local.writeUInt32LE(raw.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        local.writeUInt16LE(0, 28)
        locals.push(local, nameBuf, stored)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(SIG_CENTRAL, 0)
        central.writeUInt16LE(VERSION_MADE_BY, 4)
        central.writeUInt16LE(VERSION_NEEDED, 6)
        central.writeUInt16LE(FLAG_UTF8, 8)
        central.writeUInt16LE(method, 10)
        central.writeUInt16LE(DOS_TIME, 12)
        central.writeUInt16LE(DOS_DATE, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(stored.length, 20)
        central.writeUInt32LE(raw.length, 24)
        central.writeUInt16LE(nameBuf.length, 28)
        central.writeUInt16LE(0, 30) // extra
        central.writeUInt16LE(0, 32) // comment
        central.writeUInt16LE(0, 34) // disk
        central.writeUInt16LE(0, 36) // internal attrs
        central.writeUInt32LE(externalAttrs, 38)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, nameBuf)

        offset += local.length + nameBuf.length + stored.length
    }
    const centralStart = offset
    const centralBuf = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(records.length, 8)
    eocd.writeUInt16LE(records.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(centralStart, 16)
    eocd.writeUInt16LE(0, 20)
    return Buffer.concat([...locals, centralBuf, eocd])
}

function normalizeName(name) {
    const clean = String(name).replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "")
    if (!clean || clean.split("/").includes("..")) {
        throw new Error(`invalid zip entry name: ${name}`)
    }
    return clean
}

/**
 * Parse a zip Buffer into [{ name, data, isDirectory }] (data inflated).
 * Directory records are skipped unless `{ directories: true }`. Supports
 * what createZip writes (store/deflate, no zip64, no encryption) — enough
 * to verify our own archives and any plain zip a CI step might hand back.
 */
export function readZip(buf, { directories = false } = {}) {
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
        if (buf.readUInt32LE(i) === SIG_EOCD) {
            eocd = i
            break
        }
    }
    if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)")
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
        const localNameLen = buf.readUInt16LE(localOffset + 26)
        const localExtraLen = buf.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLen + localExtraLen
        const stored = buf.subarray(dataStart, dataStart + compressedSize)
        let data
        if (method === METHOD_STORE) data = Buffer.from(stored)
        else if (method === METHOD_DEFLATE) data = inflateRawSync(stored)
        else throw new Error(`unsupported compression method ${method} for ${name}`)
        if (data.length !== size || crc32(data) !== crc) {
            throw new Error(`corrupt entry ${name} (size/crc mismatch)`)
        }
        if (isDirectory && !directories) continue
        entries.push({ name, data, isDirectory })
    }
    return entries
}
