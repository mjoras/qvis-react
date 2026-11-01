// @vitest-environment node
/// <reference types="node" />
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LegacyQlogError, parseQlogStream, parseQlogText, QlogParseError, type LoadedQlog } from "./index";

const RS = "\u001e";
const CONTAINED = "urn:ietf:params:qlog:file:contained";
const SEQUENTIAL = "urn:ietf:params:qlog:file:sequential";
const ROOT_DIR = join(__dirname, "../../..");

const E1 = { time: 1, name: "quic:packet_sent", data: { header: { packet_number: "1" }, raw: { length: "1252" } } };
const E2 = { time: 2, name: "quic:packet_received", data: { note: "héllo \u{1f600} wörld" } };

function containedText(traces: unknown[], extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ file_schema: CONTAINED, serialization_format: "application/qlog+json", ...extra, traces });
}
function trace(events: unknown[], extra: Record<string, unknown> = {}) {
    return {
        event_schemas: ["urn:ietf:params:qlog:events:quic-13"],
        vantage_point: { type: "client" },
        ...extra,
        events,
    };
}
const SEQ_HEADER = {
    file_schema: SEQUENTIAL,
    serialization_format: "application/qlog+json-seq",
    title: "s",
    trace: { vantage_point: { type: "server" }, event_schemas: ["urn:ietf:params:qlog:events:quic-13"] },
};
function seqText(records: unknown[], pretty = false): string {
    return records.map((r) => RS + JSON.stringify(r, null, pretty ? 2 : undefined) + "\n").join("");
}
function codes(l: LoadedQlog): string[] {
    return l.diagnostics.map((d) => d.code);
}

function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
    let pos = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pos >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(pos, pos + chunkSize));
            pos += chunkSize;
        },
    });
}
const enc = new TextEncoder();

describe("parseQlogText: contained (main-schema section 25)", () => {
    it("one trace: root returned as is, no diagnostics", () => {
        const l = parseQlogText(containedText([trace([E1, E2])]));
        expect(l.serialization).toBe("json");
        expect(l.diagnostics).toEqual([]);
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
    });

    it("three traces (client, server, network + flow) and a TraceError", () => {
        const text = containedText([
            trace([E1]),
            trace([E2], { vantage_point: { type: "server" } }),
            trace([], { vantage_point: { type: "network", flow: "client" } }),
            { error_description: "File could not be found", uri: "/srv/a.qlog" },
        ]);
        const l = parseQlogText(text);
        expect(l.root.traces as any[]).toHaveLength(4);
        expect(l.diagnostics).toEqual([]);
    });

    it("traces absent or empty: QlogParseError 'File contains no traces'", () => {
        const noTraces = JSON.stringify({ file_schema: CONTAINED, serialization_format: "application/qlog+json" });
        expect(() => parseQlogText(noTraces)).toThrow(QlogParseError);
        expect(() => parseQlogText(noTraces)).toThrow("File contains no traces");
        expect(() => parseQlogText(containedText([]))).toThrow("File contains no traces");
        try {
            parseQlogText(noTraces);
        } catch (e) {
            expect((e as QlogParseError).code).toBe("file.no-traces");
        }
    });

    it("traces not an array / root not an object", () => {
        expect(() => parseQlogText('{"file_schema":"' + CONTAINED + '","traces":{}}')).toThrow(QlogParseError);
        expect(() => parseQlogText("[1,2]")).toThrow(QlogParseError);
    });

    it("truncated file (missing ]}]}) is recovered with json.truncated-recovered", () => {
        const full = containedText([trace([E1, E2])]);
        const l = parseQlogText(full.slice(0, -4));
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
        expect(codes(l)).toContain("json.truncated-recovered");
        const l2 = parseQlogText(full.slice(0, full.indexOf("héllo")));
        expect((l2.root.traces as any[])[0].events).toEqual([E1]);
    });

    it("trailing garbage after the root", () => {
        const l = parseQlogText(containedText([trace([E1])]) + "\n\n}]garbage");
        expect((l.root.traces as any[])[0].events).toEqual([E1]);
        expect(codes(l)).toEqual(["json.trailing-data"]);
    });

    it("truncated right at the traces array: no traces", () => {
        const full = containedText([trace([E1])]);
        expect(() => parseQlogText(full.slice(0, full.indexOf('"traces":[') + 10))).toThrow("File contains no traces");
    });

    it("BOM and whitespace", () => {
        const l = parseQlogText("﻿\n  " + containedText([trace([E1])]));
        expect((l.root.traces as any[])[0].events).toEqual([E1]);
    });

    it("empty and non-qlog input", () => {
        expect(() => parseQlogText("")).toThrow("File is empty");
        expect(() => parseQlogText(" \n\t ")).toThrow("File is empty");
        expect(() => parseQlogText("﻿")).toThrow("File is empty");
        expect(() => parseQlogText("hello")).toThrow(QlogParseError);
        expect(() => parseQlogText('[{"_source":{"layers":{}}}]')).toThrow(/not a qlog file/);
    });
});

describe("parseQlogText: legacy and header validation (P6)", () => {
    it("legacy qlog_version '0.3' contained file: LegacyQlogError", () => {
        const text = JSON.stringify({ qlog_version: "0.3", qlog_format: "JSON", traces: [{ events: [] }] });
        expect(() => parseQlogText(text)).toThrow(LegacyQlogError);
        try {
            parseQlogText(text);
        } catch (e) {
            expect(e).toBeInstanceOf(LegacyQlogError);
            expect((e as LegacyQlogError).qlogVersion).toBe("0.3");
        }
    });

    it("legacy draft-02 file whose qlog_version comes late, and legacy NDJSON", () => {
        const late = JSON.stringify({ traces: [{ events: [] }], qlog_version: "draft-02" });
        expect(() => parseQlogText(late)).toThrow(LegacyQlogError);
        const ndjson =
            JSON.stringify({ qlog_version: "0.3", qlog_format: "NDJSON", trace: {} }) + "\n" + JSON.stringify(E1);
        expect(() => parseQlogText(ndjson)).toThrow(LegacyQlogError);
    });

    it("legacy JSON-SEQ header: LegacyQlogError", () => {
        const text = seqText([{ qlog_version: "0.3", qlog_format: "JSON-SEQ", trace: {} }, E1]);
        expect(() => parseQlogText(text)).toThrow(LegacyQlogError);
    });

    it("qlog_format without qlog_version or file_schema is legacy too (file-loading 9.1 step 3.2)", () => {
        const text = JSON.stringify({ qlog_format: "JSON", traces: [{ events: [] }] });
        try {
            parseQlogText(text);
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(LegacyQlogError);
            expect((e as LegacyQlogError).qlogVersion).toBe("JSON");
        }
    });

    it("file_schema is compared trimmed and case-insensitively (no unknown-file-schema warning)", () => {
        const l = parseQlogText(containedText([trace([E1])], { file_schema: " URN:IETF:PARAMS:QLOG:FILE:CONTAINED" }));
        expect(codes(l)).toEqual([]);
    });

    it("file_schema + legacy members (quic-go): parsed normally, info only", () => {
        const text = seqText([{ ...SEQ_HEADER, qlog_version: "0.3", qlog_format: "JSON-SEQ" }, E1]);
        const l = parseQlogText(text);
        expect(l.serialization).toBe("json-seq");
        expect(l.diagnostics.map((d) => [d.code, d.level])).toEqual([["file.legacy-members", "info"]]);
    });

    it("missing / unknown / mismatched file_schema and serialization_format are warnings", () => {
        let l = parseQlogText(JSON.stringify({ traces: [trace([E1])] }));
        expect(codes(l)).toEqual(["file.missing-file-schema", "file.missing-serialization-format"]);
        l = parseQlogText(containedText([trace([E1])], { file_schema: "https://example.org/012026/myschema" }));
        expect(codes(l)).toEqual(["file.unknown-file-schema"]);
        l = parseQlogText(containedText([trace([E1])], { file_schema: SEQUENTIAL }));
        expect(codes(l)).toEqual(["file.schema-mismatch"]);
        l = parseQlogText(
            containedText([trace([E1])], { serialization_format: "APPLICATION/QLOG+JSON; charset=utf-8" }),
        );
        expect(codes(l)).toEqual([]);
        l = parseQlogText(containedText([trace([E1])], { serialization_format: "application/qlog+json-seq" }));
        expect(codes(l)).toEqual(["file.serialization-format-mismatch"]);
        l = parseQlogText(containedText([trace([E1])], { serialization_format: "JSON" }));
        expect(codes(l)).toEqual(["file.nonstandard-serialization-format"]);
        l = parseQlogText(containedText([trace([E1])], { serialization_format: "text/plain" }));
        expect(codes(l)).toEqual(["file.unknown-serialization-format"]);
        expect(l.diagnostics.every((d) => d.level === "warning")).toBe(true);
    });

    it("contained file with a sequential 'trace' member is accepted leniently", () => {
        const text = JSON.stringify({ ...SEQ_HEADER, trace: { ...SEQ_HEADER.trace, events: [E1] } });
        const l = parseQlogText(text);
        expect(l.serialization).toBe("json");
        expect(l.root.trace).toBeUndefined();
        expect((l.root.traces as any[])[0].events).toEqual([E1]);
        expect(codes(l)).toEqual([
            "file.schema-mismatch",
            "file.serialization-format-mismatch",
            "file.trace-in-contained",
        ]);
    });
});

describe("parseQlogText: JSON-SEQ (main-schema section 25)", () => {
    it("header plus multi-line records", () => {
        const l = parseQlogText(seqText([SEQ_HEADER, E1, E2], true));
        expect(l.serialization).toBe("json-seq");
        expect(l.diagnostics).toEqual([]);
        expect(l.root).toEqual({
            file_schema: SEQUENTIAL,
            serialization_format: "application/qlog+json-seq",
            title: "s",
            traces: [{ ...SEQ_HEADER.trace, events: [E1, E2] }],
        });
    });

    it("double RS, invalid record in the middle, truncated final record", () => {
        const text = RS + seqText([SEQ_HEADER]) + RS + "{bad}\n" + seqText([E1, E2]) + RS + '{"time":3';
        const l = parseQlogText(text);
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
        expect(codes(l)).toEqual(["seq.invalid-record", "seq.truncated-final-record"]);
    });

    it("missing header", () => {
        const l = parseQlogText(seqText([E1, E2]));
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
        expect(codes(l)).toContain("seq.missing-header");
    });

    it("no RS at all (lenient json-lines)", () => {
        const text = [SEQ_HEADER, E1, E2].map((r) => JSON.stringify(r)).join("\n") + "\n";
        const l = parseQlogText(text);
        expect(l.serialization).toBe("json-seq");
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
        expect(codes(l)).toEqual(["seq.no-record-separators"]);
    });

    it("no RS and the non-media-type serialization_format JSON-SEQ (quiche / neqo / quinn)", () => {
        const header = { serialization_format: "JSON-SEQ", trace: SEQ_HEADER.trace };
        const text = [header, E1, E2].map((r) => JSON.stringify(r)).join("\n") + "\n";
        const l = parseQlogText(text);
        expect(l.serialization).toBe("json-seq");
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
    });

    it("zero records", () => {
        expect(() => parseQlogText(RS + RS + "\n")).toThrow("File is empty");
    });
});

describe("parseQlogStream", () => {
    const seq = seqText([SEQ_HEADER, E1, E2], true);
    const contained = containedText([trace([E1, E2])], { title: "ééé \u{1f600}" });

    it.each([1, 2, 3, 5, 7, 64, 4096])(
        "JSON-SEQ in %i-byte chunks (multi-byte UTF-8 and RS across boundaries)",
        async (size) => {
            const l = await parseQlogStream(streamOf(enc.encode(seq), size));
            expect(l).toEqual(parseQlogText(seq));
        },
    );

    it.each([1, 3, 1000])("contained JSON in %i-byte chunks", async (size) => {
        const l = await parseQlogStream(streamOf(enc.encode(contained), size));
        expect(l).toEqual(parseQlogText(contained));
        expect(l.root.title).toBe("ééé \u{1f600}");
    });

    it("strips a UTF-8 BOM", async () => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(seq)]);
        expect(await parseQlogStream(streamOf(bytes, 2))).toEqual(parseQlogText(seq));
    });

    it("invalid mid-file record does not stall the stream", async () => {
        const text = seqText([SEQ_HEADER]) + RS + "{nope\n" + seqText([E1, E2]);
        const l = await parseQlogStream(streamOf(enc.encode(text), 4));
        expect((l.root.traces as any[])[0].events).toEqual([E1, E2]);
        expect(codes(l)).toEqual(["seq.invalid-record"]);
    });

    it("truncated final record, legacy header, zero records", async () => {
        const truncated = seqText([SEQ_HEADER, E1]) + RS + '{"time":';
        const l = await parseQlogStream(streamOf(enc.encode(truncated), 3));
        expect((l.root.traces as any[])[0].events).toEqual([E1]);
        expect(codes(l)).toEqual(["seq.truncated-final-record"]);
        const legacy = seqText([{ qlog_version: "0.3", trace: {} }, E1]);
        await expect(parseQlogStream(streamOf(enc.encode(legacy), 8))).rejects.toBeInstanceOf(LegacyQlogError);
        await expect(parseQlogStream(streamOf(enc.encode(RS + "\n"), 8))).rejects.toBeInstanceOf(QlogParseError);
        await expect(parseQlogStream(streamOf(new Uint8Array(0), 8))).rejects.toThrow("File is empty");
    });

    it("large contained file (> detection head) and a sequential file whose first record lacks RS", async () => {
        const many = Array.from({ length: 3000 }, (_, i) => ({ time: i, name: "quic:packet_sent", data: { i } }));
        const big = containedText([trace(many)]);
        expect(big.length).toBeGreaterThan(65536);
        const l = await parseQlogStream(streamOf(enc.encode(big), 8192));
        expect((l.root.traces as any[])[0].events).toHaveLength(3000);
        const seqNoLeadingRS =
            JSON.stringify(SEQ_HEADER) + "\n" + many.map((e) => RS + JSON.stringify(e) + "\n").join("");
        const l2 = await parseQlogStream(streamOf(enc.encode(seqNoLeadingRS), 8192));
        expect(l2.serialization).toBe("json-seq");
        expect((l2.root.traces as any[])[0].events).toHaveLength(3000);
    });
});

describe("real files", () => {
    it("scripts/cddl/sample-valid.sqlog parses without diagnostics", async () => {
        const text = readFileSync(join(ROOT_DIR, "scripts/cddl/sample-valid.sqlog"), "utf8");
        const l = parseQlogText(text);
        expect(l.serialization).toBe("json-seq");
        expect(l.diagnostics).toEqual([]);
        const events = (l.root.traces as any[])[0].events as any[];
        expect(events.length).toBeGreaterThan(3);
        expect(
            await parseQlogStream(streamOf(readFileSync(join(ROOT_DIR, "scripts/cddl/sample-valid.sqlog")), 1000)),
        ).toEqual(l);
    });

    const dirs = ["tests/fixtures/quic-go", "tests/fixtures/nonconforming", "tests/fixtures/latest", "public/examples"];
    const files = dirs
        .map((d) => join(ROOT_DIR, d))
        .filter((d) => existsSync(d))
        .flatMap((d) =>
            readdirSync(d)
                .filter((f) => /\.s?qlog$/.test(f))
                .map((f) => join(d, f)),
        );

    it.each(files)("%s parses (string and stream agree)", async (file) => {
        const bytes = readFileSync(file);
        const l = parseQlogText(bytes.toString("utf8"));
        expect(Array.isArray(l.root.traces)).toBe(true);
        expect(l.diagnostics.filter((d) => d.level === "error")).toEqual([]);
        expect(await parseQlogStream(streamOf(new Uint8Array(bytes), 65536))).toEqual(l);
    });
});
