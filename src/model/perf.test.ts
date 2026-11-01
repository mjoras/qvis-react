// @vitest-environment node
// Performance sanity (data-model 8.3): fromJSON on a synthetic 200k-event trace should cost about as much as the
// JSON.parse of the same file, and stay well under a few seconds even on slow CI machines.
import { parseQlogText } from "@/qlog/parse";
import { QlogLoader } from "./QlogLoader";

function syntheticTrace(n: number, unordered = false): string {
    const events: unknown[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = unordered && i % 1000 === 999 ? i * 0.25 - 10 : i * 0.25;
        const k = i % 4;
        if (k === 0 || k === 1) {
            events[i] = {
                time: t,
                name: k === 0 ? "quic:packet_sent" : "quic:packet_received",
                data: {
                    header: { packet_type: "1RTT", packet_number: i >> 1 },
                    frames: [{ frame_type: "stream", stream_id: 0, offset: i * 1200, raw: { length: 1200 } }],
                    raw: { length: 1252 },
                },
            };
        } else if (k === 2) {
            events[i] = {
                time: t,
                name: "quic:recovery_metrics_updated",
                data: { congestion_window: 12000 + i, bytes_in_flight: i },
            };
        } else {
            events[i] = { time: t, name: "http3:frame_created", data: { stream_id: 0, frame: { frame_type: "data" } } };
        }
    }
    return JSON.stringify({
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        traces: [
            {
                vantage_point: { type: "client" },
                event_schemas: ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"],
                common_fields: { reference_time: { clock_type: "monotonic", epoch: "unknown" } },
                events,
            },
        ],
    });
}

describe("performance", () => {
    it("fromJSON on 200k events is fast (same order as JSON.parse)", () => {
        const text = syntheticTrace(200_000);
        const t0 = performance.now();
        JSON.parse(text);
        const jsonParseMs = performance.now() - t0;

        const loaded = parseQlogText(text);
        const t1 = performance.now();
        const g = QlogLoader.fromJSON(loaded)!;
        const fromJsonMs = performance.now() - t1;

        const c = g.getConnections()[0];
        expect(c.getEvents()).toHaveLength(200_000);
        expect(c.lookup("quic", "packet_sent")).toHaveLength(50_000);
        expect(c.getEvents()[199_999].relativeTime).toBeCloseTo(199_999 * 0.25);
        expect(g.diagnostics.filter((d) => d.level !== "info")).toEqual([]);
        console.log(
            `perf: JSON.parse ${jsonParseMs.toFixed(0)} ms, fromJSON ${fromJsonMs.toFixed(0)} ms (200k events)`,
        );
        expect(fromJsonMs).toBeLessThan(3000);
        expect(fromJsonMs).toBeLessThan(Math.max(10 * jsonParseMs, 500));
    });

    it("an unordered 200k-event trace (sort path) is still fast", () => {
        const loaded = parseQlogText(syntheticTrace(200_000, true));
        const t0 = performance.now();
        const g = QlogLoader.fromJSON(loaded)!;
        const ms = performance.now() - t0;
        const evs = g.getConnections()[0].getEvents();
        for (let i = 1; i < evs.length; i++)
            if (evs[i].resolvedTime < evs[i - 1].resolvedTime) throw new Error("not sorted at " + i);
        expect(g.diagnostics.map((d) => d.code)).toContain("trace.reordered");
        console.log(`perf: fromJSON with sort ${ms.toFixed(0)} ms (200k events)`);
        expect(ms).toBeLessThan(5000);
    });
});
