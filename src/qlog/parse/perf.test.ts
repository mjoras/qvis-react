// @vitest-environment node
// Parser performance at the size of the 31 MB "massive" demo (file-loading 2.7): the truncation repair (a full
// validating scan) and the streaming JSON-SEQ parser must stay linear, so a truncated or sequential 30 MB file loads
// in about the time of a JSON.parse of the same size.
import { parseQlogStream, parseQlogText } from "./index";

const RS = "\u001e";

function event(i: number): Record<string, unknown> {
    return {
        time: i * 0.25,
        name: i % 2 === 0 ? "quic:packet_sent" : "quic:packet_received",
        data: {
            header: { packet_type: "1RTT", packet_number: i },
            frames: [{ frame_type: "stream", stream_id: 0, offset: i * 1200, length: 1200 }],
            raw: { length: 1252 },
        },
    };
}

const N = 150_000; // ~30 MB of JSON

function chunkedStream(text: string, chunkSize: number): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.subarray(offset, offset + chunkSize));
            offset += chunkSize;
        },
    });
}

describe("parser performance (~30 MB)", () => {
    it("repairs a truncated 30 MB contained file in linear time", () => {
        const events: unknown[] = new Array(N);
        for (let i = 0; i < N; i++) events[i] = event(i);
        const full = JSON.stringify({
            file_schema: "urn:ietf:params:qlog:file:contained",
            serialization_format: "application/qlog+json",
            traces: [{ vantage_point: { type: "client" }, event_schemas: [], events }],
        });
        expect(full.length).toBeGreaterThan(25_000_000);
        const truncated = full.slice(0, full.length - 40); // cut inside the last event

        const t0 = performance.now();
        JSON.parse(full);
        const jsonParseMs = performance.now() - t0;
        const t1 = performance.now();
        const loaded = parseQlogText(truncated);
        const repairMs = performance.now() - t1;

        const traces = loaded.root.traces as Array<{ events: unknown[] }>;
        expect(traces[0].events).toHaveLength(N - 1);
        expect(loaded.diagnostics.map((d) => d.code)).toContain("json.truncated-recovered");
        console.log(`perf: JSON.parse ${jsonParseMs.toFixed(0)} ms, truncated parse+repair ${repairMs.toFixed(0)} ms`);
        expect(repairMs).toBeLessThan(Math.max(15 * jsonParseMs, 8000));
    });

    it("streams a 30 MB JSON-SEQ file in 64 KB chunks", async () => {
        const header = {
            file_schema: "urn:ietf:params:qlog:file:sequential",
            serialization_format: "application/qlog+json-seq",
            trace: { vantage_point: { type: "server" }, event_schemas: [] },
        };
        const parts: string[] = [RS + JSON.stringify(header) + "\n"];
        for (let i = 0; i < N; i++) parts.push(RS + JSON.stringify(event(i)) + "\n");
        const text = parts.join("");
        expect(text.length).toBeGreaterThan(25_000_000);

        const t0 = performance.now();
        const loaded = await parseQlogStream(chunkedStream(text, 65536));
        const ms = performance.now() - t0;
        const traces = loaded.root.traces as Array<{ events: unknown[] }>;
        expect(traces[0].events).toHaveLength(N);
        expect(loaded.diagnostics).toEqual([]);
        console.log(`perf: streaming JSON-SEQ ${ms.toFixed(0)} ms (${N} records)`);
        expect(ms).toBeLessThan(10000);
    });
});
