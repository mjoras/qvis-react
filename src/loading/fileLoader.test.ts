import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { LegacyQlogError } from "@/qlog/parse";
import { blobToStream, decompressBlob, MAX_DECOMPRESSED_BYTES, maybeDecompress, streamToBlob } from "./decompress";
import { ConversionError, legacyVersionOf, PcapUnsupportedError, UnsupportedQlogSchemaError } from "./errors";
import { loadQlogFile, setExtendedConversion } from "./fileLoader";

const ROOT = process.cwd();
const sampleSqlog = readFileSync(resolve(ROOT, "scripts/cddl/sample-valid.sqlog"));

const contained = (traces: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        title: "t",
        ...extra,
        traces,
    });

const TRACE = {
    vantage_point: { type: "client" },
    event_schemas: ["urn:ietf:params:qlog:events:quic"],
    events: [
        { time: 1, name: "quic:packet_sent", data: { header: { packet_type: "initial", packet_number: 0 } } },
        { time: 2, name: "quic:packet_received", data: { header: { packet_type: "initial", packet_number: 0 } } },
    ],
};

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("decompress helpers", () => {
    it("blobToStream works without Blob.stream (jsdom) and round-trips", async () => {
        const blob = new Blob(["hello ", "world"]);
        const back = await streamToBlob(blobToStream(blob));
        expect(await back.text()).toBe("hello world");
    });

    it("gunzips by magic bytes whatever the name", async () => {
        const gz = new Blob([gzipSync(Buffer.from('{"a":1}'))]);
        const out = await maybeDecompress(gz, "trace.qlog", undefined);
        expect(await out.text()).toBe('{"a":1}');
    });

    it("handles double gzip", async () => {
        const gz2 = new Blob([gzipSync(gzipSync(Buffer.from('{"b":2}')))]);
        expect(await (await maybeDecompress(gz2, "t.qlog.gz", "gzip")).text()).toBe('{"b":2}');
    });

    it("brotli only by name, and skipped when the bytes are already decoded", async () => {
        const br = new Blob([brotliCompressSync(Buffer.from('{"c":3}'))]);
        expect(await (await maybeDecompress(br, "t.qlog.br", "brotli")).text()).toBe('{"c":3}');
        const plain = new Blob(['{"c":3}']);
        expect(await (await maybeDecompress(plain, "t.qlog.br", "brotli")).text()).toBe('{"c":3}');
    });

    it("rejects zip archives and packet captures", async () => {
        await expect(
            maybeDecompress(new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 0])]), "a.qlog.zip", "zip"),
        ).rejects.toThrow("ZIP archives are not supported");
        await expect(
            maybeDecompress(new Blob([new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1])]), "a.qlog", undefined),
        ).rejects.toThrow(PcapUnsupportedError);
    });

    it("stops a decompression bomb at the size cap (security FIX)", async () => {
        // 8 MiB of zeros gzip to about 8 KB; with a 1 MiB cap the inflation is aborted with a clear message
        const bomb = new Blob([gzipSync(Buffer.alloc(8 * 2 ** 20))]);
        expect(bomb.size).toBeLessThan(10_000);
        await expect(decompressBlob(bomb, "gzip", 2 ** 20)).rejects.toThrow(
            "Could not decompress gzip data: The decompressed file is larger than 1 MB",
        );
        // below the cap it still works
        expect((await decompressBlob(bomb, "gzip", 9 * 2 ** 20)).size).toBe(8 * 2 ** 20);
    });

    it("the default cap is 512 MiB and cancels the source stream once it is exceeded", async () => {
        expect(MAX_DECOMPRESSED_BYTES).toBe(2 ** 29);
        // one 64 MiB chunk enqueued over and over (no 512 MiB allocation in the test): 9 chunks exceed the cap
        const chunk = new Uint8Array(64 * 2 ** 20);
        let pulled = 0;
        let cancelled = false;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled++;
                controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        });
        await expect(streamToBlob(endless, "", MAX_DECOMPRESSED_BYTES)).rejects.toThrow(
            "The decompressed file is larger than 512 MB",
        );
        expect(cancelled).toBe(true);
        expect(pulled).toBeLessThanOrEqual(10);
    });

    it("reports corrupt gzip data", async () => {
        await expect(decompressBlob(new Blob([new Uint8Array([0x1f, 0x8b, 1, 2, 3])]), "gzip")).rejects.toThrow(
            /Could not decompress gzip data/,
        );
    });
});

describe("loadQlogFile", () => {
    it("loads the valid JSON-SEQ sample from a Blob (streaming) and from a string", async () => {
        for (const input of [new Blob([sampleSqlog]), sampleSqlog.toString("utf-8")]) {
            const loaded = await loadQlogFile(input, "sample-valid.sqlog");
            expect(loaded.serialization).toBe("json-seq");
            const traces = loaded.root.traces as Array<{ events: unknown[] }>;
            expect(traces).toHaveLength(1);
            expect(traces[0].events.length).toBeGreaterThan(3);
        }
    });

    it("loads a contained file (File input, uppercase extension, BOM)", async () => {
        const file = new File(["﻿" + contained([TRACE])], "TRACE.QLOG");
        const loaded = await loadQlogFile(file, file.name);
        expect(loaded.serialization).toBe("json");
        expect((loaded.root.traces as unknown[]).length).toBe(1);
    });

    it("loads gzip-compressed input (.qlog.gz and .sqlog.gz)", async () => {
        const a = await loadQlogFile(new Blob([gzipSync(Buffer.from(contained([TRACE])))]), "x.qlog.gz");
        expect((a.root.traces as unknown[]).length).toBe(1);
        const b = await loadQlogFile(new Uint8Array(gzipSync(sampleSqlog)), "x.sqlog.gz");
        expect(b.serialization).toBe("json-seq");
    });

    it("loads brotli-compressed input by name", async () => {
        const loaded = await loadQlogFile(new Blob([brotliCompressSync(Buffer.from(contained([TRACE])))]), "x.qlog.br");
        expect((loaded.root.traces as unknown[]).length).toBe(1);
    });

    it("repairs a truncated contained file and reports json.truncated-recovered (X4)", async () => {
        const full = contained([TRACE]);
        const cut = full.slice(0, full.indexOf('{"time":2'));
        const loaded = await loadQlogFile(cut, "cut.qlog");
        const events = (loaded.root.traces as Array<{ events: unknown[] }>)[0].events;
        expect(events).toHaveLength(1);
        expect(loaded.diagnostics.map((d) => d.code)).toContain("json.truncated-recovered");
    });

    it("skips an invalid mid-file JSON-SEQ record (X3) instead of hanging (Q11)", async () => {
        const text = sampleSqlog.toString("utf-8");
        const records = text.split("\u001e");
        records.splice(3, 0, '{"time": 5, "name": broken}\n');
        const loaded = await loadQlogFile(new Blob([records.join("\u001e")]), "bad.sqlog");
        expect(loaded.diagnostics.find((d) => d.code === "seq.invalid-record")?.count).toBe(1);
    });

    it("rejects legacy files with a legacy error (X1), from the head sniff", async () => {
        const legacy = JSON.stringify({ qlog_version: "draft-02", qlog_format: "JSON", traces: [] });
        const err = await loadQlogFile(legacy, "old.qlog").catch((e: unknown) => e);
        expect(legacyVersionOf(err)).toBe("draft-02");
        const seq = '{"qlog_version":"0.3","qlog_format":"JSON-SEQ","trace":{}}\n\u001e{"time":1,"name":"transport:x"}';
        const err2 = await loadQlogFile(new Blob([seq]), "old.sqlog").catch((e: unknown) => e);
        expect(legacyVersionOf(err2)).toBe("0.3");
    });

    it("maps the core parser's LegacyQlogError too", () => {
        expect(legacyVersionOf(new LegacyQlogError("0.4"))).toBe("0.4");
    });

    it("rejects unknown file_schema (X2)", async () => {
        const text = JSON.stringify({ file_schema: "urn:ietf:params:qlog:file:other", traces: [] });
        await expect(loadQlogFile(text, "a.qlog")).rejects.toBeInstanceOf(UnsupportedQlogSchemaError);
    });

    it("rejects an unknown file_schema found only after the sniff window (binding check on the parsed root)", async () => {
        const text = JSON.stringify({
            traces: [{ vantage_point: { type: "client" }, padding: "x".repeat(70000), events: [] }],
            file_schema: "urn:example:other",
        });
        const err = await loadQlogFile(new Blob([text]), "late.qlog").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnsupportedQlogSchemaError);
        expect((err as UnsupportedQlogSchemaError).value).toBe("urn:example:other");
    });

    it("throws for empty files and files without traces (never adds empty groups)", async () => {
        await expect(loadQlogFile("", "a.qlog")).rejects.toThrow("File is empty");
        await expect(loadQlogFile(new Blob([]), "a.sqlog")).rejects.toThrow("File is empty");
        await expect(loadQlogFile(contained([]), "a.qlog")).rejects.toThrow(/no traces/i);
    });

    it("rejects unsupported extensions (PARITY text) and pcap files", async () => {
        await expect(loadQlogFile("{}", "a.txt")).rejects.toThrow("File extension unsupported: a.txt");
        await expect(loadQlogFile("{}", "a.pcap")).rejects.toBeInstanceOf(PcapUnsupportedError);
    });

    it("routes netlog and tshark JSON to the converters and wraps their errors", async () => {
        const netlog = JSON.stringify({ constants: { activeFieldTrialGroups: [] }, events: [] });
        const e1 = await loadQlogFile(netlog, "chrome.netlog").catch((e: unknown) => e);
        expect(e1).toBeInstanceOf(ConversionError);
        expect((e1 as Error).message).toMatch(/Chrome netlog has no constants\.logEventTypes/);
        const e2 = await loadQlogFile(new Blob([netlog]), "chrome.json").catch((e: unknown) => e);
        expect(e2).toBeInstanceOf(ConversionError);
        const tshark = '[{"_index":"packets","_source":{"layers":{"frame":{}}}}]';
        const e3 = await loadQlogFile(tshark, "cap.pcap.json").catch((e: unknown) => e);
        expect(e3).toBeInstanceOf(ConversionError);
        expect((e3 as Error).message).toMatch(/No TCP connections found in this tshark JSON/);
    });

    it("passes the debug page's extended-mappings switch to the converters (converters C2)", async () => {
        const text = readFileSync(resolve(ROOT, "tests/fixtures/tshark/tls13-h2-duplicate-keys.json"), "utf8");
        const firstHeader = (l: Awaited<ReturnType<typeof loadQlogFile>>) => {
            const traces = l.root.traces as { events: { name: string; data: { header: Record<string, unknown> } }[] }[];
            return traces[0].events.find((e) => e.name.startsWith("tcp:packet_"))!.data.header;
        };
        try {
            expect(firstHeader(await loadQlogFile(text, "cap.json")).flags).toBeUndefined();
            setExtendedConversion(true);
            expect(firstHeader(await loadQlogFile(text, "cap.json")).flags).toBeDefined();
        } finally {
            setExtendedConversion(false);
        }
    });

    it("loads URLs with unknown extensions by sniffing (D8)", async () => {
        const loaded = await loadQlogFile(new Blob([contained([TRACE])]), "https://example.com/download?id=1", {
            isURL: true,
        });
        expect((loaded.root.traces as unknown[]).length).toBe(1);
    });

    it("loads every generated latest-draft fixture (tests/fixtures/latest, public/examples)", async () => {
        const dirs = [resolve(ROOT, "tests/fixtures/latest"), resolve(ROOT, "public/examples")];
        for (const dir of dirs) {
            if (!existsSync(dir)) continue;
            for (const name of readdirSync(dir)) {
                if (!/\.(s?qlog)(\.gz)?$/i.test(name)) continue;
                const bytes = readFileSync(resolve(dir, name));
                if (bytes.length > 40 * 1024 * 1024) continue;
                const loaded = await loadQlogFile(new Blob([bytes]), name);
                expect((loaded.root.traces as unknown[]).length, name).toBeGreaterThan(0);
            }
        }
    });

    it("parses the real (non-conforming) quic-go output: file_schema wins over qlog_version", async () => {
        const dirs = [resolve(ROOT, "tests/fixtures/nonconforming"), resolve(ROOT, "tests/fixtures/quic-go")];
        const dir = dirs.find((d) => existsSync(d));
        if (dir === undefined) return;
        const name = readdirSync(dir).find((n) => n.endsWith(".sqlog"));
        if (name === undefined) return;
        const loaded = await loadQlogFile(new Blob([readFileSync(resolve(dir, name))]), name);
        expect(loaded.serialization).toBe("json-seq");
    });
});
