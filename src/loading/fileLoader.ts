// FileLoader port (file-loading spec §3.4 and §3.14): sniff + decompress + route to the core parser or a converter.
//
//   loadQlogFile(input, name) -> LoadedQlog
//     1. extension allowlist (case-insensitive; URLs may have unknown extensions, D8)
//     2. bytes: gzip (magic) / brotli (name) decompression, zip/pcap rejection
//     3. sniff the first 65536 decoded characters (detect.ts)
//     4. contained  -> parseQlogText(text)            (core, ARCHITECTURE §3.2)
//        sequential -> parseQlogStream(stream)         (core; newline-only JSON-SEQ goes through parseQlogText)
//        netlog     -> convertForLoading("netlog", text)  (converters package; text, for truncation repair)
//        tshark     -> convertForLoading("tshark", text)  (converters package; raw text for duplicate-key parsing)
//     5. validate: at least one trace ("File contains no traces"; never add empty groups)
//
// Pure async function (no React, no store), so it can move into a worker later (D11).

import { parseQlogStream, parseQlogText } from "@/qlog/parse";
import type { LoadedQlog } from "@/qlog/parse";
import { convertForLoading } from "@/converters";
import type { Diagnostic } from "@/qlog/parse";
import { blobToStream, maybeDecompress, readBytes } from "./decompress";
import { classifyExtension, CONTAINED_SCHEMA, SEQUENTIAL_SCHEMA, SNIFF_LENGTH, sniffContent } from "./detect";
import type { ContentKind, ExtensionInfo } from "./detect";
import { ConversionError, PcapUnsupportedError, UnsupportedQlogSchemaError } from "./errors";

export type LoadInput = Blob | string | Uint8Array | ArrayBuffer;

export interface LoadOptions {
    /** `name` is a URL: unknown extensions are allowed and sniffed (D8), the URL pathname is also tested. */
    isURL?: boolean;
    /** skip the extension stage and use this hint instead (e.g. pcap backend output named after the .pcap URL) */
    extension?: ExtensionInfo;
}

const decoder = () => new TextDecoder("utf-8"); // non-fatal; strips a leading BOM

function isBlobLike(v: unknown): v is Blob {
    // duck-typed: Blobs from another realm (fetch Response.blob() in tests, iframes) are not `instanceof Blob`
    return (
        v instanceof Blob ||
        (typeof v === "object" &&
            v !== null &&
            typeof (v as Blob).arrayBuffer === "function" &&
            typeof (v as Blob).slice === "function" &&
            typeof (v as Blob).size === "number")
    );
}

function toBlob(input: Exclude<LoadInput, string>): Blob {
    if (isBlobLike(input)) return input;
    if (input instanceof ArrayBuffer) return new Blob([input]);
    return new Blob([input as Uint8Array<ArrayBuffer>]);
}

/**
 * §3.14 step 5 / §9.1 step 3 on the parsed root (binding; the sniff only sees the first 64K characters): an unknown
 * `file_schema` is X2, and a file needs at least one trace ("File contains no traces"; never add empty groups).
 */
function ensureTraces(loaded: LoadedQlog): LoadedQlog {
    const fileSchema = (loaded.root as { file_schema?: unknown }).file_schema;
    if (typeof fileSchema === "string") {
        const v = fileSchema.trim().toLowerCase();
        if (v !== CONTAINED_SCHEMA && v !== SEQUENTIAL_SCHEMA)
            throw new UnsupportedQlogSchemaError("file_schema", fileSchema);
    }
    const traces = (loaded.root as { traces?: unknown }).traces;
    if (!Array.isArray(traces) || traces.length === 0) throw new Error("File contains no traces");
    return loaded;
}

function fromConverted(root: Record<string, unknown>, diagnostics: Diagnostic[]): LoadedQlog {
    // the converter diagnostics (netlog.* / tshark.*) end up in group.diagnostics (debug page, converter toasts)
    return { root, serialization: "json", diagnostics };
}

/**
 * Converter tier (converters spec decision C2): T1 + T2 by default; the hidden debug page can switch on the T3
 * "extended mappings" (netlog: `extended` + `splitCoalescedReceived`, tshark: `extended`) for later loads.
 */
let extendedConversion = false;

export function setExtendedConversion(on: boolean): void {
    extendedConversion = on;
}

export function isExtendedConversion(): boolean {
    return extendedConversion;
}

function convert(kind: "netlog" | "tshark", payload: unknown, name: string): LoadedQlog {
    let converted: ReturnType<typeof convertForLoading>;
    try {
        converted = convertForLoading(
            kind,
            payload,
            name,
            extendedConversion ? { extended: true, splitCoalescedReceived: true } : {},
        );
    } catch (e) {
        throw new ConversionError(e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (converted.root === null || typeof converted.root !== "object")
        throw new ConversionError("Converter did not produce a qlog file: " + name);
    return fromConverted(converted.root, converted.diagnostics);
}

function logGuess(name: string, kind: ContentKind): void {
    console.log("FileLoader:Load : we guess filetype for ", name, "is", kind);
}

async function loadFromText(text: string, name: string, ext: ExtensionInfo): Promise<LoadedQlog> {
    const kind = sniffContent(text.slice(0, SNIFF_LENGTH + 1), ext, name);
    logGuess(name, kind);
    switch (kind) {
        case "contained":
        case "sequential":
            return ensureTraces(parseQlogText(text));
        case "netlog":
            return ensureTraces(convert("netlog", text, name));
        case "tshark":
            return ensureTraces(convert("tshark", text, name));
    }
}

async function loadFromBlob(blob: Blob, name: string, ext: ExtensionInfo): Promise<LoadedQlog> {
    const decompressed = await maybeDecompress(blob, name, ext.compression);
    // SNIFF_LENGTH chars need at most 4 bytes each; decoding a prefix is harmless (a cut character becomes U+FFFD)
    const head = decoder()
        .decode(await readBytes(decompressed, 0, SNIFF_LENGTH * 4))
        .slice(0, SNIFF_LENGTH);
    const kind = sniffContent(head, ext, name);
    logGuess(name, kind);
    switch (kind) {
        case "contained":
            return ensureTraces(parseQlogText(await decompressed.text()));
        case "sequential":
            // newline-separated records without RS (D3 leniency) are handled by the text parser's detection
            if (!head.includes("\u001e")) return ensureTraces(parseQlogText(await decompressed.text()));
            return ensureTraces(await parseQlogStream(blobToStream(decompressed)));
        case "netlog":
            return ensureTraces(convert("netlog", await decompressed.text(), name));
        case "tshark":
            return ensureTraces(convert("tshark", await decompressed.text(), name));
    }
}

/**
 * Loads one input (uploaded File, fetched Blob, string, bytes) into the normalized `LoadedQlog` consumed by
 * `QlogLoader.fromJSON`. Throws (async) on every failure: unsupported extension/format, legacy qlog
 * (UnsupportedQlogVersionError / LegacyQlogError), unsupported schema, pcap, parse errors, converter errors.
 */
export async function loadQlogFile(input: LoadInput, name: string, options: LoadOptions = {}): Promise<LoadedQlog> {
    const ext = options.extension ?? classifyExtension(name, options.isURL === true);
    if (ext.hint === "pcap") throw new PcapUnsupportedError(name);
    if (typeof input === "string")
        return loadFromText(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input, name, ext);
    return loadFromBlob(toBlob(input), name, ext);
}
