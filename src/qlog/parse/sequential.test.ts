import { DiagnosticCollector } from "./diagnostics";
import { LegacyQlogError, QlogParseError } from "./errors";
import { buildSequentialRoot, parseJsonLinesRecords, parseJsonSeqRecords, SeqRecordParser } from "./sequential";

const RS = "\u001e";
const HEADER = {
    file_schema: "urn:ietf:params:qlog:file:sequential",
    serialization_format: "application/qlog+json-seq",
    title: "seq",
    trace: { vantage_point: { type: "server" }, event_schemas: ["urn:ietf:params:qlog:events:quic-13"] },
};
const E1 = { time: 1, name: "quic:packet_sent", data: { raw: { length: 10 } } };
const E2 = { time: 2, name: "quic:packet_received", data: {} };

function rec(v: unknown, pretty = false): string {
    return RS + JSON.stringify(v, null, pretty ? 2 : undefined) + "\n";
}

describe("JSON-SEQ records (P5, RFC 7464)", () => {
    it("splits on RS; records may contain newlines", () => {
        const diag = new DiagnosticCollector();
        const text = rec(HEADER, true) + rec(E1, true) + rec(E2);
        expect(parseJsonSeqRecords(text, diag)).toEqual([HEADER, E1, E2]);
        expect(diag.size).toBe(0);
    });

    it("ignores consecutive RS and leading whitespace", () => {
        const diag = new DiagnosticCollector();
        const text = "\n" + RS + RS + JSON.stringify(HEADER) + "\n" + RS + RS + RS + JSON.stringify(E1) + "\n";
        expect(parseJsonSeqRecords(text, diag)).toEqual([HEADER, E1]);
        expect(diag.size).toBe(0);
    });

    it("skips an invalid record in the middle and continues (no hang, qvis Q11)", () => {
        const diag = new DiagnosticCollector();
        const text = rec(HEADER) + RS + '{"time": 1, "name": broken}\n' + RS + "also broken\n" + rec(E2);
        expect(parseJsonSeqRecords(text, diag)).toEqual([HEADER, E2]);
        const d = diag.get("seq.invalid-record")!;
        expect(d.level).toBe("warning");
        expect(d.count).toBe(2);
        expect(d.sample).toMatchObject({ record: 2 });
    });

    it("a truncated final record (no LF) is reported separately", () => {
        const diag = new DiagnosticCollector();
        const text = rec(HEADER) + rec(E1) + RS + '{"time": 3, "na';
        expect(parseJsonSeqRecords(text, diag)).toEqual([HEADER, E1]);
        expect(diag.has("seq.truncated-final-record")).toBe(true);
        expect(diag.has("seq.invalid-record")).toBe(false);
    });

    it("first record without a leading RS", () => {
        const diag = new DiagnosticCollector();
        expect(parseJsonSeqRecords(JSON.stringify(HEADER) + "\n" + rec(E1), diag)).toEqual([HEADER, E1]);
    });

    it("incremental parser: RS and records split across chunk boundaries", () => {
        const text = rec(HEADER, true) + rec(E1) + rec(E2, true);
        for (let size = 1; size <= 17; size++) {
            const diag = new DiagnosticCollector();
            const p = new SeqRecordParser(diag);
            for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
            expect(p.end()).toEqual([HEADER, E1, E2]);
            expect(diag.size).toBe(0);
        }
    });

    it("json-lines: one record per line, or pretty-printed records, without RS", () => {
        const diag = new DiagnosticCollector();
        const lines = JSON.stringify(HEADER) + "\n" + JSON.stringify(E1) + "\n\n" + JSON.stringify(E2) + "\n";
        expect(parseJsonLinesRecords(lines, diag)).toEqual([HEADER, E1, E2]);
        const pretty = JSON.stringify(HEADER, null, 2) + "\n" + JSON.stringify(E1, null, 4) + "\n" + JSON.stringify(E2);
        expect(parseJsonLinesRecords(pretty, diag)).toEqual([HEADER, E1, E2]);
        expect(diag.size).toBe(0);
    });

    it("json-lines: garbage lines and a truncated last record are skipped", () => {
        const diag = new DiagnosticCollector();
        const text =
            JSON.stringify(HEADER) +
            "\nnot json\n" +
            JSON.stringify(E1) +
            '\n{"a": nope}\n' +
            '{"time": 3, "name": "x"';
        expect(parseJsonLinesRecords(text, diag)).toEqual([HEADER, E1]);
        expect(diag.get("seq.invalid-record")!.count).toBe(2);
        expect(diag.has("seq.truncated-final-record")).toBe(true);
    });
});

describe("buildSequentialRoot", () => {
    it("normalizes to {...header, traces: [{vantage_point default, ...header.trace, events}]}", () => {
        const diag = new DiagnosticCollector();
        const root = buildSequentialRoot([HEADER, E1, E2], diag);
        expect(root).toEqual({
            file_schema: HEADER.file_schema,
            serialization_format: HEADER.serialization_format,
            title: "seq",
            traces: [
                { vantage_point: { type: "server" }, event_schemas: HEADER.trace.event_schemas, events: [E1, E2] },
            ],
        });
        expect(root.trace).toBeUndefined();
        // events are the parsed records themselves (no copies)
        expect((root.traces as any)[0].events[0]).toBe(E1);
    });

    it("defaults vantage_point to {type: unknown} like qvis (header.trace overrides)", () => {
        const diag = new DiagnosticCollector();
        const header = { ...HEADER, trace: { event_schemas: [] } };
        expect((buildSequentialRoot([header], diag).traces as any)[0]).toEqual({
            vantage_point: { type: "unknown" },
            event_schemas: [],
            events: [],
        });
    });

    it("header-only file: one trace with zero events and a 'file truncated?' warning (file-loading 9.3)", () => {
        const diag = new DiagnosticCollector();
        const root = buildSequentialRoot([HEADER], diag);
        expect((root.traces as any)[0].events).toEqual([]);
        expect(diag.get("seq.no-events")?.level).toBe("warning");
        expect(diag.get("seq.no-events")?.message).toBe("No events could be parsed (file truncated?)");
        const ok = new DiagnosticCollector();
        buildSequentialRoot([HEADER, E1], ok);
        expect(ok.has("seq.no-events")).toBe(false);
    });

    it("events inside the header's trace are prepended to the records (file-loading 9.3)", () => {
        const diag = new DiagnosticCollector();
        const header = { ...HEADER, trace: { ...HEADER.trace, events: [E1] } };
        const root = buildSequentialRoot([header, E2], diag);
        expect((root.traces as any)[0].events).toEqual([E1, E2]);
        expect(diag.has("seq.no-events")).toBe(false);
    });

    it("qlog_format without qlog_version or file_schema is legacy too (9.1 step 3.2)", () => {
        const diag = new DiagnosticCollector();
        try {
            buildSequentialRoot([{ qlog_format: "JSON-SEQ", trace: {} }, E1], diag);
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(LegacyQlogError);
            expect((e as LegacyQlogError).qlogVersion).toBe("JSON-SEQ");
        }
    });

    it("synthesizes a header when the first record is an event", () => {
        const diag = new DiagnosticCollector();
        const root = buildSequentialRoot([E1, E2], diag);
        expect(root.file_schema).toBe("urn:ietf:params:qlog:file:sequential");
        expect((root.traces as any)[0].events).toEqual([E1, E2]);
        expect(diag.get("seq.missing-header")?.level).toBe("warning");
    });

    it("legacy header throws LegacyQlogError", () => {
        const diag = new DiagnosticCollector();
        const legacy = { qlog_version: "0.3", qlog_format: "JSON-SEQ", trace: {} };
        expect(() => buildSequentialRoot([legacy, E1], diag)).toThrow(LegacyQlogError);
        try {
            buildSequentialRoot([legacy], diag);
        } catch (e) {
            expect((e as LegacyQlogError).qlogVersion).toBe("0.3");
        }
    });

    it("zero records and an unrecognizable first record throw QlogParseError", () => {
        const diag = new DiagnosticCollector();
        expect(() => buildSequentialRoot([], diag)).toThrow(QlogParseError);
        expect(() => buildSequentialRoot([[1, 2]], diag)).toThrow(QlogParseError);
        expect(() => buildSequentialRoot([{ foo: 1 }], diag)).toThrow(/header/);
    });

    it("concatenated files: a later header starts a new trace", () => {
        const diag = new DiagnosticCollector();
        const h2 = { ...HEADER, title: "second", trace: { vantage_point: { type: "client" }, event_schemas: [] } };
        const root = buildSequentialRoot([HEADER, E1, h2, E2], diag);
        expect(root.title).toBe("seq");
        const traces = root.traces as any[];
        expect(traces).toHaveLength(2);
        expect(traces[0].events).toEqual([E1]);
        expect(traces[1].vantage_point).toEqual({ type: "client" });
        expect(traces[1].events).toEqual([E2]);
        expect(diag.has("seq.multiple-headers")).toBe(true);
    });
});
