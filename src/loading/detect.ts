// File type detection: extension allowlist + content sniff (file-loading spec §3.4, §3.14 steps 1 and 3).
// Pure functions, no I/O.

import { PcapUnsupportedError, UnsupportedQlogSchemaError, UnsupportedQlogVersionError } from "./errors";

export const CONTAINED_SCHEMA = "urn:ietf:params:qlog:file:contained";
export const SEQUENTIAL_SCHEMA = "urn:ietf:params:qlog:file:sequential";
export const CONTAINED_FORMAT = "application/qlog+json";
export const SEQUENTIAL_FORMAT = "application/qlog+json-seq";

/** What the file extension suggests. `unknown` only for URL loads (D8: allow and sniff). */
export type ExtensionHint = "contained" | "sequential" | "ndjson" | "netlog" | "tshark" | "pcap" | "unknown";
export type CompressionHint = "gzip" | "brotli" | "zip" | undefined;

export interface ExtensionInfo {
    hint: ExtensionHint;
    compression: CompressionHint;
    /** the suffix that matched (lower-case), e.g. ".qlog.gz"; "" when nothing matched */
    suffix: string;
}

const COMPRESSION_SUFFIXES: ReadonlyArray<[string, Exclude<CompressionHint, undefined>]> = [
    [".gzip", "gzip"],
    [".gz", "gzip"],
    [".brotli", "brotli"],
    [".br", "brotli"],
    [".zip", "zip"],
];

// Base suffixes, longest/most specific first (`.pcap.json` before `.json`, as in qvis FileLoader.ts:161-209).
const BASE_SUFFIXES: ReadonlyArray<[string, ExtensionHint, boolean /* compressible */]> = [
    [".qlognd", "ndjson", false],
    [".qlogseq", "sequential", false],
    [".sqlog", "sequential", true],
    [".pcap.json", "tshark", false],
    [".netlog", "netlog", true],
    [".qlog", "contained", true],
    [".json", "contained", true],
    [".pcapng", "pcap", false],
    [".pcap", "pcap", false],
];

function matchSuffix(lowerName: string): ExtensionInfo | undefined {
    for (const [base, hint, compressible] of BASE_SUFFIXES) {
        if (lowerName.endsWith(base)) return { hint, compression: undefined, suffix: base };
        if (!compressible) continue;
        for (const [comp, kind] of COMPRESSION_SUFFIXES) {
            if (lowerName.endsWith(base + comp)) return { hint, compression: kind, suffix: base + comp };
        }
    }
    return undefined;
}

function urlPathname(name: string): string | undefined {
    try {
        const base = typeof document !== "undefined" ? document.baseURI : "http://localhost/";
        return new URL(name, base).pathname;
    } catch {
        return undefined;
    }
}

/**
 * Stage 1: type from extension. Case-insensitive (FIX Q19). The full name is tested first (qvis behaviour,
 * handles QUIC Tracker's `...?.json` trick); for URLs the pathname is tested next (`x.qlog?raw=1`).
 * Unknown extensions throw the PARITY error for files, but are allowed for URL loads (D8).
 */
export function classifyExtension(name: string, isURL = false): ExtensionInfo {
    const direct = matchSuffix(name.toLowerCase());
    if (direct) return direct;
    if (isURL) {
        const path = urlPathname(name);
        const viaPath = path !== undefined ? matchSuffix(path.toLowerCase()) : undefined;
        if (viaPath) return viaPath;
        return { hint: "unknown", compression: undefined, suffix: "" };
    }
    throw new Error("File extension unsupported: " + name);
}

/** Option 1 / list entries: does this URL point at a packet capture? (`.pcap.json` is tshark JSON, not a capture) */
export function isPcapLikeURL(url: string): boolean {
    const lower = url.toLowerCase();
    if (lower.includes(".pcapng")) return true;
    if (lower.includes(".pcap") && !lower.includes(".pcap.json")) return true;
    const path = (urlPathname(url) ?? lower).toLowerCase();
    return path.endsWith("/pcap");
}

/** qvis `urlIsPcap` (FileManagerContainer.vue:580-582), shows the .keys field: note that `x.pcap.json` also counts. */
export function urlIsPcap(url: string): boolean {
    return url.indexOf(".pcap") >= 0 && url.indexOf(".pcapng") < 0;
}

/** The result of the content sniff: which parser / converter handles the file. */
export type ContentKind = "contained" | "sequential" | "netlog" | "tshark";

/**
 * Sniff window in decoded characters (file-loading §9.1 step 2, main-schema digest P3): member order is not
 * significant and mvfst writes hash-ordered keys, so `file_schema` can come late in the header.
 */
export const SNIFF_LENGTH = 65536;

function stripBOM(s: string): string {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normalizeMediaType(v: string): string {
    return v.split(";")[0].trim().toLowerCase();
}

/**
 * Stage 3 (§3.14 step 3, refined by §9.1): sniff the first decoded characters. Content wins over the extension; the
 * extension is only a fallback when no qlog/netlog/tshark marker is present.
 * - `serialization_format` only selects the parser; an unknown value is never an error (§9.1 step 5: quiche, neqo
 *   and quinn write non-media-type values), the sniff falls through to `file_schema`.
 * - `file_schema` is compared trimmed and case-insensitively (§9.1 step 3.1); any other URI is X2.
 * Throws UnsupportedQlogVersionError (legacy, X1), UnsupportedQlogSchemaError (X2) or the PARITY
 * "File format unsupported" error.
 */
export function sniffContent(rawHead: string, ext: ExtensionInfo, name: string): ContentKind {
    const head = stripBOM(rawHead).slice(0, SNIFF_LENGTH);
    const trimmed = head.trimStart();
    if (trimmed.length === 0) throw new Error("File is empty");

    if (trimmed.charCodeAt(0) === 0x1e) return "sequential";

    const sf = /"serialization_format"\s*:\s*"([^"]*)"/i.exec(head);
    if (sf) {
        const v = normalizeMediaType(sf[1]);
        if (v === SEQUENTIAL_FORMAT || v === "json-seq") return "sequential";
        if (v === CONTAINED_FORMAT || v === "json") return "contained";
        // anything else: informational only, fall through (§9.1 step 5)
    }

    const fs = /"file_schema"\s*:\s*"([^"]*)"/.exec(head);
    if (fs) {
        const v = fs[1].trim().toLowerCase();
        if (v === SEQUENTIAL_SCHEMA) return "sequential";
        if (v === CONTAINED_SCHEMA) return "contained";
        throw new UnsupportedQlogSchemaError("file_schema", fs[1]);
    }

    // legacy fast path (§9.1 step 4): qlog_version, or qlog_format without a version, and no file_schema
    const legacy = /"qlog_version"\s*:\s*"?([^",}\s]*)/.exec(head) ?? /"qlog_format"\s*:\s*"?([^",}\s]*)/.exec(head);
    if (legacy) throw new UnsupportedQlogVersionError(legacy[1]);

    if (head.includes("activeFieldTrialGroups")) return "netlog";
    if (head.includes("_source") && head.includes("layers")) return "tshark";

    // JSON-SEQ whose first record lacks its leading RS
    if (head.includes("\u001e")) return "sequential";

    switch (ext.hint) {
        case "sequential":
            return "sequential";
        case "contained":
            return "contained";
        case "netlog":
            return "netlog";
        case "tshark":
            return "tshark";
        case "pcap":
            throw new PcapUnsupportedError(name);
        default:
            break;
    }

    const firstFewCharacters = trimmed.slice(0, 100);
    throw new Error(
        "File format unsupported (for qlogs, make sure file_schema and serialization_format are at the top of the file): " +
            name +
            " : " +
            firstFewCharacters,
    );
}

/** Magic bytes of the binary formats we recognise (to give a clear error instead of a JSON parse failure). */
export type MagicKind = "gzip" | "zip" | "pcap" | undefined;

export function sniffMagic(bytes: Uint8Array): MagicKind {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
        return "zip";
    if (bytes.length >= 4) {
        const m = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        // pcap (both byte orders, micro- and nanosecond variants) and pcapng section header block
        if (m === 0xa1b2c3d4 || m === 0xd4c3b2a1 || m === 0xa1b23c4d || m === 0x4d3cb2a1 || m === 0x0a0d0d0a)
            return "pcap";
    }
    return undefined;
}

/** True if the bytes already look like (decoded) text JSON / JSON-SEQ, i.e. no decompression is needed. */
export function looksLikeText(bytes: Uint8Array): boolean {
    let i = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
    if (i >= bytes.length) return true; // empty / whitespace only: let the sniff report "File is empty"
    const c = bytes[i];
    return c === 0x7b /* { */ || c === 0x5b /* [ */ || c === 0x1e; /* RS */
}
