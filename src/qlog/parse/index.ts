// Public parser API (ARCHITECTURE section 3.2). Pure functions, no DOM, no store.
//
//   parseQlogText(text)      -> LoadedQlog   (throws LegacyQlogError | QlogParseError)
//   parseQlogStream(stream)  -> Promise<LoadedQlog>   (JSON-SEQ is parsed record by record while streaming)
//
// LoadedQlog.root is normalized to {...header, traces: [...]} for both serializations; LoadedQlog.diagnostics holds
// the parse-level (P3-P6) diagnostics. QlogLoader.fromJSON (src/model) turns it into a QlogConnectionGroup.

import { RECORD_SEPARATOR } from "../schema/main";
import { parseContained } from "./contained";
import { DETECT_HEAD_LENGTH, detectSerialization, firstContentIndex, sniffQlogVersion } from "./detect";
import { type Diagnostic, DiagnosticCollector } from "./diagnostics";
import { LegacyQlogError, QlogParseError } from "./errors";
import { type Serialization, validateAndNormalizeRoot } from "./normalize";
import { SeqRecordParser, buildSequentialRoot, parseJsonLinesRecords, parseJsonSeqRecords } from "./sequential";

export interface LoadedQlog {
    /** normalized: {...header, traces: [...]} for both serializations */
    root: Record<string, unknown>;
    serialization: Serialization;
    /** parse-level (P3-P6) */
    diagnostics: Diagnostic[];
}

export { LegacyQlogError, QlogParseError } from "./errors";
export { detectSerialization, sniffQlogVersion } from "./detect";
export type { DetectedSerialization } from "./detect";
export { DiagnosticCollector, formatDiagnostic, MAX_SAMPLES } from "./diagnostics";
export type { Diagnostic, DiagnosticLevel, DiagnosticOptions } from "./diagnostics";
export type { Serialization } from "./normalize";
export { normalizeMediaType, mediaTypeFor, fileSchemaFor, copyMembers } from "./normalize";
export { repairJson, parseContained } from "./contained";
export type { RepairResult, RepairReason } from "./contained";
export { SeqRecordParser, parseJsonSeqRecords, parseJsonLinesRecords, buildSequentialRoot } from "./sequential";

function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function finish(root: unknown, serialization: Serialization, diag: DiagnosticCollector): LoadedQlog {
    const normalized = validateAndNormalizeRoot(root, serialization, diag);
    return { root: normalized, serialization, diagnostics: diag.toArray() };
}

function finishSequential(records: unknown[], diag: DiagnosticCollector): LoadedQlog {
    return finish(buildSequentialRoot(records, diag), "json-seq", diag);
}

/** Parses a complete qlog text (contained JSON or JSON-SEQ, detected from the content). */
export function parseQlogText(text: string): LoadedQlog {
    const diag = new DiagnosticCollector();
    if (firstContentIndex(text) >= text.length) throw new QlogParseError("File is empty", "file.empty");
    switch (detectSerialization(text)) {
        case "not-qlog":
            throw new QlogParseError(
                "File is not a qlog file: expected a JSON object (.qlog) or a JSON text sequence (.sqlog)",
                "file.not-qlog",
            );
        case "legacy": {
            let root: unknown;
            try {
                root = JSON.parse(stripBom(text));
            } catch {
                // e.g. legacy NDJSON (.qlognd): no point in repairing a file we reject anyway
                throw new LegacyQlogError(sniffQlogVersion(text));
            }
            return finish(root, "json", diag); // P6 confirms (throws LegacyQlogError)
        }
        case "json-seq":
            return finishSequential(parseJsonSeqRecords(text, diag), diag);
        case "json-lines": {
            // a single JSON value with a sequential header is a contained-style file (P6 lenient case)
            let single: unknown;
            try {
                single = JSON.parse(stripBom(text));
            } catch {
                single = undefined;
            }
            if (single !== undefined) return finish(single, "json", diag);
            diag.warn(
                "seq.no-record-separators",
                "The JSON-SEQ file has no record separators (RS); records were split on their JSON structure instead",
            );
            return finishSequential(parseJsonLinesRecords(text, diag), diag);
        }
        default:
            return finish(parseContained(text, diag), "json", diag);
    }
}

/**
 * Parses a byte stream (File.stream(), Response.body). UTF-8 is decoded incrementally (BOM stripped). JSON-SEQ
 * input is split and parsed record by record as the bytes arrive, so the full text is never held in memory;
 * contained JSON is accumulated and handed to {@link parseQlogText}.
 */
export async function parseQlogStream(stream: ReadableStream<Uint8Array>): Promise<LoadedQlog> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    const diag = new DiagnosticCollector();
    let seq: SeqRecordParser | undefined; // set once the input is known to be JSON-SEQ
    let whole: string[] | undefined; // set once the input is known to be something else (parsed at the end)
    let pending = ""; // undecided: not enough content seen yet

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (seq !== undefined) {
                seq.push(text);
                continue;
            }
            if (whole !== undefined) {
                whole.push(text);
                continue;
            }
            pending += text;
            const idx = firstContentIndex(pending);
            if (idx >= pending.length) continue; // only whitespace so far
            if (pending[idx] === RECORD_SEPARATOR) {
                seq = new SeqRecordParser(diag);
                seq.push(pending);
                pending = "";
            } else if (pending.length - idx >= DETECT_HEAD_LENGTH) {
                if (detectSerialization(pending) === "json-seq") {
                    seq = new SeqRecordParser(diag);
                    seq.push(pending);
                } else {
                    whole = [pending];
                }
                pending = "";
            }
        }
    } finally {
        reader.releaseLock();
    }
    const tail = decoder.decode();

    if (seq !== undefined) {
        seq.push(tail);
        return finishSequential(seq.end(), diag);
    }
    return parseQlogText(whole !== undefined ? whole.join("") + tail : pending + tail);
}
