// @vitest-environment node
/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { groupFromRoot, ROOT } from "../__fixtures__/build";
import { tcpH2Events, tcpH2QlogFile } from "../__fixtures__/tcpH2Trace";
import { PacketizationDirection, type PacketizationLane } from "./PacketizationDiagramModels";
import { preprocess } from "./PacketizationDiagramD3Renderer";
import PacketizationTCPPreProcessor from "./PacketizationTCPPreProcessor";

const { sending, receiving } = PacketizationDirection;

const conn = () => groupFromRoot(tcpH2QlogFile()).getConnections()[0];
const run = (dir: PacketizationDirection, c = conn()) => PacketizationTCPPreProcessor.process(c, dir, { silent: true });
const pos = (lane: PacketizationLane) => lane.ranges.map((r) => [r.start, r.size, r.isPayload, r.index, r.color]);

describe("TCP + TLS + HTTP/2 (hand-written converter output)", () => {
    it("is detected as TCP_HTTP2 and dispatched to the TCP pre-processor", () => {
        const c = conn();
        expect(c.protocolHint).toBe("TCP_HTTP2");
        const r = preprocess(c, receiving, { silent: true });
        expect(r.lanes.map((l) => [l.name, l.CSSClassName, l.heightModifier])).toEqual([
            ["TCP", "tcppacket", undefined],
            ["TLS", "tlspacket", undefined],
            ["HTTP/2", "httppacket", undefined],
            ["Stream IDs", "streampacket", 0.6],
        ]);
        expect(r.lanes[0].max_size_local).toBeUndefined();
        expect(r.lanes[0].efficiency).toBeUndefined();
    });

    it("does not mutate the events", () => {
        const events = tcpH2Events();
        const before = JSON.stringify(events);
        const c = groupFromRoot(tcpH2QlogFile(events)).getConnections()[0];
        run(sending, c);
        run(receiving, c);
        expect(JSON.stringify(events)).toBe(before);
    });

    describe("receiving (top)", () => {
        const r = run(receiving);
        const [tcp, tls, http, streams] = r.lanes;

        it("TCP: three data segments, pure ACK skipped", () => {
            expect(pos(tcp)).toEqual([
                [0, 32, false, 0, "black"],
                [32, 1400, true, 0, "black"],
                [1432, 32, false, 1, "grey"],
                [1464, 1400, true, 1, "grey"],
                [2864, 32, false, 2, "black"],
                [2896, 331, true, 2, "black"],
            ]);
        });

        it("TLS: records span segments, split into pieces with the same index", () => {
            expect(pos(tls)).toEqual([
                [32, 5, false, 0, "red"],
                [37, 1395, true, 0, "red"],
                [1464, 605, true, 0, "red"],
                [2069, 5, false, 1, "pink"],
                [2074, 790, true, 1, "pink"],
                [2896, 314, true, 1, "pink"],
                [3210, 17, false, 1, "pink"],
            ]);
            expect(tls.ranges.map((x) => x.contentType)).toEqual([
                "handshake",
                "handshake",
                "handshake",
                "application",
                "application",
                "application",
                "application",
            ]);
            expect(tls.ranges[3].lowerLayerIndex).toBe(2);
            expect(tls.ranges[3].extra).toEqual({
                DEBUG_wiresharkFrameNumber: 7,
                record_length: 1126,
                payload_length: 1104,
            });
        });

        it("HTTP/2: frames inside the application payload; DATA split across segments", () => {
            expect(pos(http)).toEqual([
                [2074, 9, false, 0, "blue"],
                [2083, 18, true, 0, "blue"],
                [2101, 9, false, 1, "lightblue"],
                [2110, 9, false, 2, "blue"],
                [2119, 50, true, 2, "blue"],
                [2169, 9, false, 3, "lightblue"],
                [2178, 686, true, 3, "lightblue"],
                [2896, 314, true, 3, "lightblue"],
            ]);
            expect(streams.ranges.map((x) => [x.start, x.size, x.isPayload, x.color])).toEqual([
                [2074, 9, true, "#FF0000"],
                [2083, 18, true, "#FF0000"],
                [2101, 9, true, "#FF0000"],
                [2110, 9, true, "#E1DA4C"],
                [2119, 50, true, "#E1DA4C"],
                [2169, 9, true, "#E1DA4C"],
                [2178, 686, true, "#E1DA4C"],
                [2896, 314, true, "#E1DA4C"],
            ]);
        });

        it("every byte is consumed, no diagnostics", () => {
            expect(r.diagnostics).toEqual([]);
            expect(r.insufficientBytes).toBe(false);
            expect(r.emptyNote).toBeUndefined();
        });

        it("tooltips", () => {
            expect(tcp.rangeToString(tcp.ranges[1])).toBe("TCP Payload #0 : packet size 1400<br/>");
            expect(tls.rangeToString(tls.ranges[6])).toBe(
                "TLS Trailer (MAC/auth tag/padding/content type) 1 (TCP index: 2) : record size 1126, partial size 17<br/>Wireshark frame number (DEBUG): 7<br/>content type: application",
            );
            expect(http.rangeToString(http.ranges[6])).toBe(
                "H2 Payload # (TLS index: 1) : frame size 1000, partial size : 686<br/>frame type: data, streamID: 1<br/><b>STREAM END BIT SET</b><br/>GET: /index.html<br/>total resource size: 1000<br/>",
            );
            expect(streams.rangeToString(streams.ranges[0])).toBe("H2 streamID: 0");
        });
    });

    describe("sending (bottom)", () => {
        const r = run(sending);
        const [tcp, tls, http, streams] = r.lanes;

        it("lane sizes and x extent", () => {
            expect(tcp.ranges).toHaveLength(4);
            expect(tls.ranges).toHaveLength(9);
            expect(http.ranges).toHaveLength(7);
            expect(streams.ranges).toHaveLength(7);
            const last = tcp.ranges[tcp.ranges.length - 1];
            expect(last.start + last.size).toBe(770);
        });

        it("magic has no header, stream -1 is lavenderblush; trailer piece of the application record", () => {
            expect(pos(http)[0]).toEqual([650, 24, true, 0, "blue"]);
            expect(streams.ranges[0].color).toBe("lavenderblush");
            expect(streams.rangeToString(streams.ranges[0])).toBe("H2 streamID: -1");
            expect(pos(tls).slice(-3)).toEqual([
                [645, 5, false, 3, "pink"],
                [650, 103, true, 3, "pink"],
                [753, 17, false, 3, "pink"],
            ]);
        });

        it("tooltips: HEADERS with END_STREAM and request info (total 0 in this direction)", () => {
            const headersHeader = http.ranges.find((x) => !x.isPayload && x.rawPacket.frame.frame_type === "headers")!;
            expect(http.rangeToString(headersHeader)).toBe(
                "H2 Header # (TLS index: 3) : frame size 30, partial size : 9<br/>frame type: headers, streamID: 1<br/><b>STREAM END BIT SET</b><br/>GET: /index.html<br/>total resource size: 0<br/>",
            );
        });

        it("no diagnostics", () => {
            expect(r.diagnostics).toEqual([]);
        });
    });

    it("inconsistent traces: missing TCP bytes are reported once per render through insufficientBytes (N-PZ3)", () => {
        const events = tcpH2Events().filter(
            (e) => !(e.name === "tcp:packet_received" && e.data.capture_frame_number === 7),
        );
        const r = run(receiving, groupFromRoot(tcpH2QlogFile(events)).getConnections()[0]);
        expect(r.insufficientBytes).toBe(true);
        expect(r.diagnostics).toContain("Trying to fill payloadranges that aren't there! 314");
    });

    it("absent sizes never produce NaN (qvis HEAD bug) and settings without payload do not warn", () => {
        const events = [
            { time: 1, name: "tcp:packet_sent", data: { header: { header_length: 20 }, raw: { length: 70 } } },
            {
                time: 2,
                name: "tls:record_created",
                data: { header: { content_type: "application", header_length: 5, trailer_length: 0 } },
            },
            { time: 3, name: "tcp:packet_sent", data: { header: {}, raw: {} } },
            { time: 4, name: "http2:frame_created", data: { stream_id: 0, frame: { frame_type: "settings" } } },
            { time: 5, name: "http2:frame_created", data: { stream_id: 3, frame: { frame_type: "ping" } } },
        ];
        const r = run(sending, groupFromRoot(tcpH2QlogFile(events)).getConnections()[0]);
        expect(pos(r.lanes[0])).toEqual([
            [0, 20, false, 0, "black"],
            [20, 50, true, 0, "black"],
        ]);
        for (const lane of r.lanes) for (const x of lane.ranges) expect(Number.isFinite(x.start + x.size)).toBe(true);
        expect(r.diagnostics).toContain(
            "PacketizationTCPPreprocessor: TCP packet without raw.payload_length... ignoring",
        );
        expect(r.diagnostics).toContain(
            "PacketizationTCPPreprocessor: Found HTTP frame without payload length... potential error?",
        );
        expect(r.diagnostics.filter((d) => d.includes("without payload length"))).toHaveLength(1);
    });

    it("D-PZ4 notes for TCP traces", () => {
        const onlyAcks = [
            {
                time: 1,
                name: "tcp:packet_sent",
                data: { header: { header_length: 20 }, raw: { length: 20, payload_length: 0 } },
            },
        ];
        const c = groupFromRoot(tcpH2QlogFile(onlyAcks)).getConnections()[0];
        expect(run(sending, c).emptyNote).toBe("No tcp:packet_sent events with a payload found for this direction");
        expect(run(receiving, c).emptyNote).toBe("No tcp:packet_received events found for this direction");
    });
});

// Golden numbers of parity/converters.md §3.13 on the real tshark capture, converted by the ported converter.
const PLAYSTATION = [
    "tests/fixtures/tshark/wikipedia_Playstation.json.gz",
    "tests/fixtures/tshark/wikipedia_Playstation.json",
]
    .map((p) => join(ROOT, p))
    .find((p) => existsSync(p));

describe.runIf(PLAYSTATION !== undefined)("converted wikipedia_Playstation.json (converters §3.13)", () => {
    it("lane range counts, x extents and stream totals", async () => {
        const { tsharkToQlog } = await import("@/converters/tshark");
        const bytes = readFileSync(PLAYSTATION!);
        const text = PLAYSTATION!.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
        const root = tsharkToQlog(text, "wikipedia_Playstation.json");
        const c = groupFromRoot(root).getConnections()[0];
        const top = PacketizationTCPPreProcessor.process(c, receiving, { silent: true });
        const bottom = PacketizationTCPPreProcessor.process(c, sending, { silent: true });
        const counts = (r: typeof top) => r.lanes.map((l) => l.ranges.length);
        const xMax = (r: typeof top) => {
            const last = r.lanes[0].ranges[r.lanes[0].ranges.length - 1];
            return last.start + last.size;
        };
        expect(counts(top)).toEqual([214, 296, 196, 196]);
        expect(xMax(top)).toBe(133918);
        expect(counts(bottom)).toEqual([38, 80, 106, 106]);
        expect(xMax(bottom)).toBe(4207);
        expect(top.insufficientBytes).toBe(false);
        const totals: Record<string, number> = {
            15: 4333,
            17: 394,
            19: 13370,
            21: 11310,
            23: 7414,
            25: 11716,
            27: 426,
            29: 477,
            31: 532,
            33: 203,
            35: 10007,
            37: 8553,
            39: 11664,
            41: 11031,
            43: 590,
            45: 4001,
            47: 140,
            49: 7854,
            51: 9168,
            53: 4741,
            55: 416,
            57: 1436,
        };
        const streams = top.lanes[3];
        for (const [id, total] of Object.entries(totals)) {
            const range = streams.ranges.find((x) => String(x.rawPacket.stream_id) === id)!;
            expect(streams.rangeToString(range)).toContain("total resource size: " + total + "<br/>");
        }
    });
});
