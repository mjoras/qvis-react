// P5: parse JSON Text Sequences (QlogFileSeq, RFC 7464) into records, then normalize the records into the same
// shape as a contained file: {...headerWithoutTrace, traces: [{vantage_point: {type: "unknown"}, ...header.trace,
// events: records[1..]}]} (file-loading spec 3.7 step 4; qvis textsequencejsontoqlog parity).

import { FILE_SCHEMA_SEQUENTIAL, MEDIA_TYPE_JSON_SEQ, RECORD_SEPARATOR } from "../schema/main";
import { DiagnosticCollector } from "./diagnostics";
import { LegacyQlogError, QlogParseError } from "./errors";
import { copyMembers, legacyVersionOfRoot } from "./normalize";

const EXCERPT = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Incremental RS splitter + record parser. Feed decoded text with `push`, then call `end` once.
 * Invalid records are skipped and reported (RFC 7464: SHOULD continue); a broken final record that lacks its LF is
 * reported as truncated (the expected case for a logger that was killed mid-write).
 */
export class SeqRecordParser {
    readonly records: unknown[] = [];
    private buffer = "";
    private recordNo = 0;
    private readonly diag: DiagnosticCollector;

    constructor(diag: DiagnosticCollector) {
        this.diag = diag;
    }

    push(chunk: string): void {
        if (chunk.length === 0) return;
        const buf = this.buffer + chunk;
        let start = 0;
        let rs = buf.indexOf(RECORD_SEPARATOR, start);
        while (rs >= 0) {
            this.handlePart(buf.slice(start, rs), false);
            start = rs + 1;
            rs = buf.indexOf(RECORD_SEPARATOR, start);
        }
        this.buffer = buf.slice(start);
    }

    end(): unknown[] {
        this.handlePart(this.buffer, true);
        this.buffer = "";
        return this.records;
    }

    private handlePart(raw: string, last: boolean): void {
        const rec = raw.trim();
        if (rec.length === 0) return; // leading chunk / consecutive RS: ignore (RFC 7464)
        this.recordNo++;
        try {
            this.records.push(JSON.parse(rec));
        } catch {
            const sample = { record: this.recordNo, text: rec.slice(0, EXCERPT) };
            if (last && !raw.endsWith("\n")) {
                this.diag.warn(
                    "seq.truncated-final-record",
                    "The last JSON-SEQ record was incomplete (truncated file) and was skipped",
                    { sample },
                );
            } else {
                this.diag.warn("seq.invalid-record", "JSON-SEQ records with invalid JSON were skipped", { sample });
            }
        }
    }
}

/** Splits a complete JSON-SEQ text into parsed records (P5). */
export function parseJsonSeqRecords(text: string, diag: DiagnosticCollector): unknown[] {
    const p = new SeqRecordParser(diag);
    p.push(text);
    return p.end();
}

/**
 * Lenient "json-lines" mode: a sequential file without any RS. Splits the text into consecutive top-level JSON
 * values by tracking bracket depth (linear; works for one-record-per-line and for pretty-printed records).
 */
export function parseJsonLinesRecords(text: string, diag: DiagnosticCollector): unknown[] {
    const out: unknown[] = [];
    const n = text.length;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let recordNo = 0;
    while (i < n) {
        let c = text.charCodeAt(i);
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
            i++;
            continue;
        }
        const start = i;
        if (c !== 0x7b && c !== 0x5b) {
            // garbage outside a value: skip to the end of the line
            let nl = text.indexOf("\n", i);
            if (nl < 0) nl = n;
            recordNo++;
            diag.warn("seq.invalid-record", "JSON-SEQ records with invalid JSON were skipped", {
                sample: { record: recordNo, text: text.slice(start, Math.min(nl, start + EXCERPT)) },
            });
            i = nl + 1;
            continue;
        }
        let depth = 0;
        let inStr = false;
        let esc = false;
        let end = -1;
        for (; i < n; i++) {
            c = text.charCodeAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c === 0x5c) esc = true;
                else if (c === 0x22) inStr = false;
                continue;
            }
            if (c === 0x22) inStr = true;
            else if (c === 0x7b || c === 0x5b) depth++;
            else if (c === 0x7d || c === 0x5d) {
                depth--;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        recordNo++;
        if (end < 0) {
            diag.warn(
                "seq.truncated-final-record",
                "The last JSON-SEQ record was incomplete (truncated file) and was skipped",
                { sample: { record: recordNo, text: text.slice(start, start + EXCERPT) } },
            );
            break;
        }
        const rec = text.slice(start, end);
        try {
            out.push(JSON.parse(rec));
        } catch {
            diag.warn("seq.invalid-record", "JSON-SEQ records with invalid JSON were skipped", {
                sample: { record: recordNo, text: rec.slice(0, EXCERPT) },
            });
        }
        i = end;
    }
    return out;
}

function isHeaderLike(r: Record<string, unknown>): boolean {
    return (
        isPlainObject(r.trace) ||
        r.file_schema !== undefined ||
        r.serialization_format !== undefined ||
        r.qlog_version !== undefined
    );
}

function isEventLike(r: Record<string, unknown>): boolean {
    return r.name !== undefined && r.time !== undefined && r.trace === undefined;
}

function headerWithoutTrace(header: Record<string, unknown>): Record<string, unknown> {
    return copyMembers(header, {}, "trace");
}

function buildTrace(header: Record<string, unknown>, events: unknown[]): Record<string, unknown> {
    // qvis parity (textsequencejsontoqlog.ts:33-55): defaults overridden by header.trace, events = records
    const trace: Record<string, unknown> = { vantage_point: { type: "unknown" } };
    const src = header.trace;
    if (isPlainObject(src)) copyMembers(src, trace);
    // a producer that nevertheless puts an `events` array into the header's trace: those events come first
    // (file-loading 9.3, ecosystem digest 6.2)
    trace.events =
        isPlainObject(src) && Array.isArray(src.events) && src.events.length > 0 ? src.events.concat(events) : events;
    return trace;
}

/**
 * Normalizes parsed JSON-SEQ records into `{...header, traces: [...]}`.
 * - records[0] is the QlogFileSeq header. A legacy header (`qlog_version`, no `file_schema`) throws
 *   LegacyQlogError. An event-like first record gets a synthesized header (warning `seq.missing-header`).
 * - A later record with both `file_schema` and `trace` (e.g. `cat a.sqlog b.sqlog`) starts a new trace.
 * Throws QlogParseError for zero records or an unrecognizable first record.
 */
export function buildSequentialRoot(records: unknown[], diag: DiagnosticCollector): Record<string, unknown> {
    if (records.length === 0) throw new QlogParseError("File is empty", "file.empty");
    const first = records[0];
    let header: Record<string, unknown>;
    let firstEvent = 1;
    const legacy = isPlainObject(first) ? legacyVersionOfRoot(first) : undefined;
    if (legacy !== undefined) throw new LegacyQlogError(legacy);
    if (isPlainObject(first) && isHeaderLike(first)) {
        header = first;
        if (!isPlainObject(first.trace)) {
            diag.warn("seq.header-without-trace", "The JSON-SEQ header record has no trace object; defaults were used");
        }
    } else if (isPlainObject(first) && isEventLike(first)) {
        diag.warn(
            "seq.missing-header",
            "The JSON-SEQ file does not start with a qlog header record; a default header was assumed",
        );
        header = {
            file_schema: FILE_SCHEMA_SEQUENTIAL,
            serialization_format: MEDIA_TYPE_JSON_SEQ,
            trace: { event_schemas: [], vantage_point: { type: "unknown" } },
        };
        firstEvent = 0;
    } else {
        throw new QlogParseError("JSON-SEQ file does not start with a qlog header record", "seq.invalid-header");
    }

    const traces: Record<string, unknown>[] = [];
    let currentHeader = header;
    let events: unknown[] = [];
    for (let r = firstEvent; r < records.length; r++) {
        const rec = records[r];
        if (isPlainObject(rec) && typeof rec.file_schema === "string" && isPlainObject(rec.trace)) {
            diag.warn(
                "seq.multiple-headers",
                "The JSON-SEQ file contains more than one header record (concatenated files); each starts a new trace",
            );
            traces.push(buildTrace(currentHeader, events));
            currentHeader = rec;
            events = [];
            continue;
        }
        events.push(rec);
    }
    traces.push(buildTrace(currentHeader, events));
    if (traces.every((t) => (t.events as unknown[]).length === 0)) {
        // header record(s) only: one connection with zero events, not an empty group (file-loading 9.3)
        diag.warn("seq.no-events", "No events could be parsed (file truncated?)");
    }

    const root = headerWithoutTrace(header);
    root.traces = traces;
    return root;
}
