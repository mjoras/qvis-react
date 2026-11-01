// @vitest-environment node
import { connectionFromEvents, ev, filesIn, loadFile, ROOT, type Json } from "../__fixtures__/build";
import { PacketizationDirection, type PacketizationLane, type PacketizationRange } from "./PacketizationDiagramModels";
import PacketizationQUICPreProcessor, { DEFAULT_MAX_PACKET_SIZE } from "./PacketizationQUICPreProcessor";
import { FILLER_FRAME_TYPE } from "./quicFrameSizes";
import { join } from "node:path";
import type { QlogConnection } from "@/model/QlogConnection";

const { sending, receiving } = PacketizationDirection;
const GUESS_MSG =
    "PacketizationQUICPreProcessor: qlog trace does not have frame_size fields set properly. We -guesstimate- them here, so exact frame sizes are expected to be off!";

function run(conn: QlogConnection, dir: PacketizationDirection) {
    return PacketizationQUICPreProcessor.process(conn, dir, { silent: true });
}

const pos = (lane: PacketizationLane) => lane.ranges.map((r) => [r.start, r.size, r.isPayload, r.index, r.color]);
const xMaxOf = (lane: PacketizationLane) =>
    lane.ranges.length === 0 ? 0 : lane.ranges[lane.ranges.length - 1].start + lane.ranges[lane.ranges.length - 1].size;

describe("worked example (§3.6.11)", () => {
    const events: Json[] = [
        ev("quic:packet_received", {
            header: { packet_type: "1RTT", packet_number: 5 },
            raw: { length: 1252, payload_length: 1224 },
            frames: [
                { frame_type: "ack", acked_ranges: [[0, 3]] },
                { frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 1200 } },
            ],
        }),
        ev("http3:frame_parsed", {
            stream_id: 0,
            frame: { frame_type: "headers", raw: { payload_length: 36 }, headers: [{ name: ":status", value: "200" }] },
        }),
        ev("http3:frame_parsed", { stream_id: 0, frame: { frame_type: "data", raw: { payload_length: 2623 } } }),
    ];
    const conn = connectionFromEvents(events);
    const before = JSON.stringify(events);
    const result = run(conn, receiving);
    const [packets, frames, http, streams] = result.lanes;

    it("does not mutate the events (Q-F1, Q-P2)", () => {
        expect(JSON.stringify(events)).toBe(before);
        expect(JSON.stringify(conn.getEvents().map((e) => e.raw))).toBe(before);
    });

    it("lanes, names, classes", () => {
        expect(result.lanes.map((l) => [l.name, l.CSSClassName, l.heightModifier])).toEqual([
            ["QUIC packets", "quicpacket", undefined],
            ["QUIC frames", "quicframe", undefined],
            ["HTTP/3", "httpframe", undefined],
            ["Stream IDs", "streampacket", 0.6],
        ]);
    });

    it("packet: header 12, payload 1224, trailer 16 (Q-P1 fix)", () => {
        expect(pos(packets)).toEqual([
            [0, 12, false, 0, "black"],
            [12, 1224, true, 0, "black"],
            [1236, 16, false, 0, "black"],
        ]);
        expect(packets.ranges.every((r) => r.contentType === "1RTT" && r.lowerLayerIndex === -1)).toBe(true);
        expect(xMaxOf(packets)).toBe(1252);
    });

    it("frames: yellow filler first, then ACK and STREAM", () => {
        expect(pos(frames)).toEqual([
            [12, 12, false, -1, "yellow"],
            [24, 11, false, 0, "red"],
            [35, 1, false, 1, "pink"],
            [36, 1200, true, 1, "pink"],
        ]);
        expect(frames.ranges[0].contentType).toBe(FILLER_FRAME_TYPE);
        expect(frames.ranges[0].rawPacket).toEqual({ frame_type: FILLER_FRAME_TYPE });
        expect(frames.ranges.every((r) => r.lowerLayerIndex === 0)).toBe(true);
    });

    it("HTTP/3: the HEADERS frame is placed, the DATA frame waits for more bytes", () => {
        expect(pos(http)).toEqual([
            [36, 2, false, 0, "blue"],
            [38, 36, true, 0, "blue"],
        ]);
        expect(http.ranges.map((r) => [r.lowerLayerIndex, r.extra.frame_length])).toEqual([
            [1, 38],
            [2, 38],
        ]);
        expect(pos(streams)).toEqual([
            [36, 2, true, 0, "#E1DA4C"],
            [38, 36, true, 0, "#E1DA4C"],
        ]);
        expect(result.diagnostics).toEqual([
            GUESS_MSG,
            "PacketizationQUICPreprocessor: Not all QUIC payload ranges were used up!",
            "PacketizationQUICPreprocessor: Not all HTTP3 frames found a home!",
            "QUIC payload size != HTTP3 payload size",
        ]);
    });

    it("max sizes default, efficiency, no empty note", () => {
        expect(packets.max_size_local).toBe(DEFAULT_MAX_PACKET_SIZE);
        expect(packets.max_size_remote).toBe(65527);
        expect(packets.efficiency).toBeCloseTo(36 / 1252);
        expect(result.emptyNote).toBeUndefined();
        expect(result.insufficientBytes).toBe(false);
    });

    it("tooltips", () => {
        expect(packets.rangeToString(packets.ranges[0])).toBe(
            "QUIC Header #0 : size 12<br/>Packet type : 1RTT, Packet nr : 5<br/>",
        );
        expect(frames.rangeToString(frames.ranges[3])).toBe(
            "QUIC Frame #1 : size 1200<br/>Frame type : stream, stream ID: 0<br/>",
        );
        expect(http.rangeToString(http.ranges[0])).toBe(
            "H3 Header #0 (QUIC frame index: 1) : frame size 38, partial size : 2<br/>frame type: headers, streamID: 0",
        );
    });
});

describe("H3 frames spanning several STREAM frames, request info", () => {
    // payload_length = STREAM frame header (type, id, offset, length varints) + data: explicit sizes everywhere
    const stream = (pn: number, offset: number, len: number, frameHeader: number, extra: Json = {}) =>
        ev("quic:packet_received", {
            header: { packet_type: "1RTT", packet_number: pn },
            raw: { length: 3 + frameHeader + len + 16, payload_length: frameHeader + len },
            frames: [{ frame_type: "stream", stream_id: 0, offset, raw: { length: len }, ...extra }],
        });

    const events: Json[] = [
        ev("http3:frame_created", {
            stream_id: 0,
            frame: {
                frame_type: "headers",
                headers: [
                    { name: ":method", value: "GET" },
                    { name: ":path", value: "/index.html" },
                ],
                raw: { length: 20, payload_length: 18 },
            },
        }),
        // response HEADERS (38 bytes) + DATA header (3 bytes) + first 59 bytes of DATA in the first STREAM frame
        stream(0, 0, 100, 4),
        ev("http3:frame_parsed", {
            stream_id: 0,
            frame: { frame_type: "headers", raw: { length: 38, payload_length: 36 } },
        }),
        ev("http3:frame_parsed", {
            stream_id: 0,
            frame: { frame_type: "data", raw: { length: 203, payload_length: 200 } },
        }),
        stream(1, 100, 100, 6),
        stream(2, 200, 41, 5, { fin: true }),
    ];
    const conn = connectionFromEvents(events);
    const result = run(conn, receiving);
    const [packets, frames, http, streams] = result.lanes;

    it("places every byte; the DATA frame is split in three pieces with the same index", () => {
        expect(packets.ranges).toHaveLength(9);
        expect(frames.ranges.map((r) => [r.size, r.isPayload, r.index])).toEqual([
            [4, false, 0], // 1 + VLIE(0) + VLIE(100)
            [100, true, 0],
            [6, false, 1], // offset 100 adds VLIE(100)
            [100, true, 1],
            [5, false, 2],
            [41, true, 2],
        ]);
        const data = http.ranges.filter((r) => r.contentType === "data");
        expect(data.map((r) => [r.size, r.isPayload, r.index, r.color])).toEqual([
            [3, false, 1, "lightblue"],
            [59, true, 1, "lightblue"],
            [100, true, 1, "lightblue"],
            [41, true, 1, "lightblue"],
        ]);
        expect(streams.ranges).toHaveLength(http.ranges.length);
        expect(result.diagnostics).toEqual([]); // explicit sizes everywhere, everything placed
    });

    it("request info from the client's frame_created HEADERS; Q-H3: stream 0 DATA counts", () => {
        expect(streams.rangeToString(streams.ranges[streams.ranges.length - 1])).toBe(
            "H3 streamID: 0<br/>GET: /index.html<br/>total resource size: 200<br/>",
        );
        const lastFrame = frames.ranges[frames.ranges.length - 1];
        expect(frames.rangeToString(lastFrame)).toBe(
            "QUIC Frame #2 : size 41<br/>Frame type : stream, stream ID: 0<br/><b>FIN BIT SET</b>",
        );
        expect(packets.efficiency).toBeCloseTo((36 + 200) / (3 * 19 + 104 + 106 + 46));
    });
});

describe("latest-draft mapping (§9.13)", () => {
    it("#1 pre-final names: empty lanes, D-PZ4 note (1)", () => {
        const conn = connectionFromEvents([
            ev("transport:packet_sent", { header: { packet_type: "1RTT", packet_number: 1 }, raw: { length: 100 } }),
            ev("http3:frame_created", { stream_id: 0, frame: { frame_type: "headers", raw: { payload_length: 10 } } }),
        ]);
        const sent = run(conn, sending);
        expect(sent.lanes.every((l) => l.ranges.length === 0)).toBe(true);
        expect(sent.emptyNote).toBe(
            "This trace uses pre-standard event names (transport:packet_sent); only quic:packet_sent is supported",
        );
        expect(Number.isNaN(sent.lanes[0].efficiency)).toBe(true);
        expect(run(conn, receiving).emptyNote).toBe("No quic:packet_received events found for this direction");
    });

    it("D-PZ4 note (2): packets exist but none has raw", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", { header: { packet_type: "1RTT", packet_number: 1 } }),
        ]);
        expect(run(conn, sending).emptyNote).toBe(
            "No quic:packet_sent events with raw.length found for this direction",
        );
    });

    it("#2 STREAM data length from every -13 producer shape gives the same layout", () => {
        const shapes = [
            { raw: { length: 50 } },
            { raw: { payload_length: 50 } },
            { raw: { length: 53, payload_length: 50 } },
        ];
        const layouts = shapes.map((shape) => {
            const conn = connectionFromEvents([
                ev("quic:packet_sent", {
                    header: { packet_type: "1RTT", packet_number: 1 },
                    raw: { length: 80, payload_length: 53 },
                    frames: [{ frame_type: "stream", stream_id: 0, offset: 0, ...shape }],
                }),
            ]);
            const r = run(conn, sending);
            expect(r.diagnostics).toEqual([
                "PacketizationQUICPreprocessor: Not all QUIC payload ranges were used up!",
                "QUIC payload size != HTTP3 payload size",
            ]);
            return pos(r.lanes[1]);
        });
        for (const l of layouts) expect(l).toEqual(layouts[0]);
        expect(layouts[0]).toEqual([
            [11, 3, false, 0, "red"],
            [14, 50, true, 0, "red"],
        ]);
    });

    it("#2b the pre-final top-level STREAM `length` is not read (addendum P2): Q-F4 header-only frame", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 80, payload_length: 53 },
                frames: [{ frame_type: "stream", stream_id: 0, offset: 0, length: 50 }],
            }),
        ]);
        const r = run(conn, sending);
        expect(r.diagnostics).toEqual([
            GUESS_MSG,
            "PacketizationQUICPreProcessor: stream frame with no length attribute! skipping...",
        ]);
        expect(pos(r.lanes[1])).toEqual([[11, 53, false, 0, "red"]]);
        expect(r.lanes[2].ranges).toEqual([]);
    });

    it("#3 LEN-bit inference on a full packet", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 70, payload_length: 52 },
                frames: [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 50 } }],
            }),
        ]);
        const frames = run(conn, sending).lanes[1];
        expect(pos(frames)).toEqual([
            [2, 2, false, 0, "red"],
            [4, 50, true, 0, "red"],
        ]);
    });

    it("#4 NEW_CONNECTION_ID / NEW_TOKEN payload rects", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 100, payload_length: 60 },
                frames: [
                    { frame_type: "new_connection_id", sequence_number: 1, connection_id: "0102030405060708" },
                    { frame_type: "new_token", token: { raw: { data: "aabbcc" } } },
                ],
            }),
        ]);
        const frames = run(conn, sending).lanes[1];
        expect(frames.ranges.filter((r) => r.isPayload).map((r) => [r.contentType, r.size])).toEqual([
            ["new_connection_id", 8],
            ["new_token", 3],
        ]);
    });

    it("#5 priority_update with push_id on stream 3 takes a 4-byte type varint", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 100, payload_length: 20 },
                frames: [{ frame_type: "stream", stream_id: 3, offset: 0, raw: { length: 17 } }],
            }),
            ev("http3:frame_created", {
                stream_id: 3,
                frame: {
                    frame_type: "priority_update",
                    push_id: 0,
                    priority_field_value: "u=1",
                    raw: { payload_length: 12 },
                },
            }),
        ]);
        const http = run(conn, sending).lanes[2];
        expect(http.ranges.map((r) => [r.size, r.isPayload])).toEqual([
            [5, false],
            [12, true],
        ]);
    });

    it("#6 H3 event without frame: skipped with the Q-H1 message, nothing throws, other streams unaffected", () => {
        const conn = connectionFromEvents([
            ev("http3:frame_created", { stream_id: 0 }),
            ev("http3:frame_created", { stream_id: 4, frame: { frame_type: "headers", raw: { payload_length: 8 } } }),
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 100, payload_length: 30 },
                frames: [{ frame_type: "stream", stream_id: 4, offset: 0, raw: { length: 10 } }],
            }),
        ]);
        const r = run(conn, sending);
        expect(r.diagnostics[0]).toBe(
            "H3 frame didn't have a payload length (frame.raw.payload_length / frame.raw.length) set! skipping...",
        );
        expect(r.lanes[2].ranges.map((x) => x.size)).toEqual([2, 8]);
    });

    it("Q-H1: an empty SETTINGS frame (payload 0) is still placed", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_received", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 50, payload_length: 6 },
                frames: [{ frame_type: "stream", stream_id: 3, offset: 0, raw: { length: 3 } }],
            }),
            ev("http3:frame_parsed", {
                stream_id: 3,
                frame: { frame_type: "settings", settings: [], raw: { payload_length: 0 } },
            }),
        ]);
        const http = run(conn, receiving).lanes[2];
        expect(http.ranges.map((r) => [r.size, r.isPayload])).toEqual([[2, false]]);
    });

    it("#7 quic:parameters_set initiator + max_udp_payload_size (printed as logged); legacy and other namespaces ignored", () => {
        const conn = connectionFromEvents([
            ev("quic:parameters_set", { initiator: "remote", max_udp_payload_size: "1472" }),
            ev("quic:parameters_set", { owner: "local", max_packet_size: 1200 }),
            ev("quic:recovery_parameters_set", { initiator: "local", max_udp_payload_size: 1000 }),
            ev("http3:parameters_set", { initiator: "local", max_udp_payload_size: 999 }),
        ]);
        const lane0 = run(conn, sending).lanes[0];
        expect(lane0.max_size_remote).toBe("1472");
        expect(lane0.max_size_local).toBe(65527);
    });

    it("#8 D-PZ7: frames from quic:frames_created when the packet has no frames member", () => {
        const packet = (pn: number, packet_type: string, frames?: unknown[]) =>
            ev("quic:packet_sent", {
                header: { packet_type, packet_number: pn },
                raw: { length: 1252, payload_length: 1224 },
                ...(frames ? { frames } : {}),
            });
        const conn = connectionFromEvents([
            ev("quic:frames_created", {
                frames: [
                    { frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 1220 } },
                    { frame_type: "ping", raw: { length: 1 } },
                    { frame_type: "crypto", offset: 0, raw: { length: 1200 } },
                ],
                packet_numbers: [5, 6, 0],
            }),
            packet(5, "1RTT"),
            packet(6, "1RTT", []),
            packet(0, "initial"),
        ]);
        const frames = run(conn, sending).lanes[1];
        expect(frames.ranges.map((r) => [r.contentType, r.lowerLayerIndex])).toEqual([
            ["stream", 0],
            ["stream", 0],
        ]);
    });

    it("D-PZ7: frames_parsed and frames_processed feed the receiving direction", () => {
        const conn = connectionFromEvents([
            ev("quic:frames_processed", {
                frames: [{ frame_type: "ping", raw: { length: 1 } }],
                packet_numbers: ["7"],
            }),
            ev("quic:packet_received", {
                header: { packet_type: "0RTT", packet_number: 7 },
                raw: { length: 30, payload_length: 1 },
            }),
        ]);
        expect(pos(run(conn, receiving).lanes[1])).toEqual([[13, 1, false, 0, "red"]]);
    });

    it("#9 raw.data without length: size = hex chars / 2, event untouched (Q-P2)", () => {
        const events = [
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { data: "ab".repeat(1200) },
            }),
        ];
        const before = JSON.stringify(events);
        const lane0 = run(connectionFromEvents(events), sending).lanes[0];
        expect(xMaxOf(lane0)).toBe(1200);
        expect(JSON.stringify(events)).toBe(before);
    });

    it("#10 a packet with only header.length (no raw) is skipped silently", () => {
        const r = run(
            connectionFromEvents([
                ev("quic:packet_sent", { header: { packet_type: "initial", packet_number: 0, length: 1200 } }),
            ]),
            sending,
        );
        expect(r.lanes[0].ranges).toEqual([]);
        expect(r.diagnostics).toEqual([]);
    });

    it("E4/E6: packets without packet_type or without any size are skipped with a diagnostic", () => {
        const r = run(
            connectionFromEvents([
                ev("quic:packet_sent", { header: { packet_number: 0 }, raw: { length: 100 } }),
                ev("quic:packet_sent", { header: { packet_type: "1RTT" }, raw: { payload_length: 100 } }),
            ]),
            sending,
        );
        expect(r.lanes[0].ranges).toEqual([]);
        expect(r.diagnostics).toEqual([
            "PacketizationQUICPreProcessor: packet without header.packet_type set... ignoring",
            "PacketizationQUICPreProcessor: packet without raw.length set... ignoring",
        ]);
    });

    it("#11 version_negotiation and retry without packet_number", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_received", { header: { packet_type: "version_negotiation" }, raw: { length: 40 } }),
            ev("quic:packet_received", { header: { packet_type: "retry" }, raw: { length: 60 } }),
        ]);
        const lane0 = run(conn, receiving).lanes[0];
        expect(lane0.ranges).toHaveLength(6);
        expect(lane0.rangeToString(lane0.ranges[0])).toBe(
            "QUIC Header #0 : size 4<br/>Packet type : version_negotiation, Packet nr : undefined<br/>",
        );
        expect(lane0.ranges.map((r) => r.color)).toEqual(["black", "black", "black", "grey", "grey", "grey"]);
    });

    it("#12 string STREAM stream_id ('4', mvfst) and numeric http3 stream_id meet in one FIFO", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_received", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 60, payload_length: 13 },
                frames: [{ frame_type: "stream", stream_id: "4", offset: "0", raw: { length: "10" } }],
            }),
            ev("http3:frame_parsed", { stream_id: 4, frame: { frame_type: "data", raw: { payload_length: 8 } } }),
        ]);
        const r = run(conn, receiving);
        expect(r.lanes[2].ranges.map((x) => [x.size, x.isPayload])).toEqual([
            [2, false],
            [8, true],
        ]);
        expect(r.lanes[3].ranges.map((x) => x.color)).toEqual(["#6B067F", "#6B067F"]);
    });

    it("#13 a real frame type containing 'qvis' is a normal frame, not a filler", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 60, payload_length: 10 },
                frames: [{ frame_type: "qvis_ext", raw: { length: 10 } }],
            }),
        ]);
        expect(pos(run(conn, sending).lanes[1])).toEqual([[34, 10, false, 0, "red"]]);
    });

    it("Q-F5: frames: [] and frames without frame_type do not throw", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 60, payload_length: 10 },
                frames: [],
            }),
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 2 },
                raw: { length: 60, payload_length: 10 },
                frames: [{ raw: { length: 10 } }, null],
            }),
        ]);
        const r = run(conn, sending);
        expect(r.lanes[0].ranges).toHaveLength(6);
        expect(r.lanes[1].ranges.map((x) => [x.contentType, x.size])).toEqual([
            ["unknown", 5],
            ["unknown", 5],
        ]);
    });

    it("Q-H2: receiving frame_parsed before the stream's first bytes is queued, not dropped", () => {
        const conn = connectionFromEvents([
            ev("http3:frame_parsed", { stream_id: 0, frame: { frame_type: "headers", raw: { payload_length: 8 } } }),
            ev("quic:packet_received", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 60, payload_length: 13 },
                frames: [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 10 } }],
            }),
        ]);
        const r = run(conn, receiving);
        expect(r.lanes[2].ranges.map((x) => x.size)).toEqual([2, 8]);
        expect(r.diagnostics).toEqual(["No payload ranges known for this stream_id, skipping..."]);
    });

    it("E17: a second request HEADERS on a stream keeps the first one", () => {
        const headers = (path: string) =>
            ev("http3:frame_created", {
                stream_id: 0,
                frame: { frame_type: "headers", headers: [{ name: ":path", value: path }], raw: { payload_length: 4 } },
            });
        const r = run(connectionFromEvents([headers("/a"), headers("/b")]), sending);
        expect(r.diagnostics).toContain(
            "PacketizationQUICPreprocessor: HTTPStreamInfo already had an entry for this stream",
        );
    });

    it("server vantage point: request info from frame_parsed; unknown vantage point: none", () => {
        const events = [
            ev("quic:packet_received", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 60, payload_length: 13 },
                frames: [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 10 } }],
            }),
            ev("http3:frame_parsed", {
                stream_id: 0,
                frame: {
                    frame_type: "headers",
                    headers: [
                        { name: ":method", value: "GET" },
                        { name: ":path", value: "/x" },
                    ],
                    raw: { payload_length: 8 },
                },
            }),
        ];
        const server = run(connectionFromEvents(events, { vantage_point: { type: "server" } }), receiving).lanes[3];
        expect(server.rangeToString(server.ranges[0])).toBe(
            "H3 streamID: 0<br/>GET: /x<br/>total resource size: 0<br/>",
        );
        const unknown = run(connectionFromEvents(events, { vantage_point: { type: "network" } }), receiving).lanes[3];
        expect(unknown.rangeToString(unknown.ranges[0])).toBe("H3 streamID: 0");
    });

    it("payload_length that includes the AEAD tag is detected once", () => {
        const conn = connectionFromEvents([
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 1 },
                raw: { length: 100, payload_length: 90 },
            }),
            ev("quic:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 2 },
                raw: { length: 100, payload_length: 90 },
            }),
        ]);
        const r = run(conn, sending);
        expect(r.diagnostics).toEqual(["raw.payload_length appears to include the AEAD tag"]);
        expect(pos(r.lanes[0]).slice(0, 3)).toEqual([
            [0, 10, false, 0, "black"],
            [10, 74, true, 0, "black"],
            [84, 16, false, 0, "black"],
        ]);
        expect(xMaxOf(r.lanes[0])).toBe(200);
    });
});

// ------------------------------------------------------------------ real generated latest-draft fixtures

const realFiles = filesIn("tests/fixtures/latest", "public/examples");

describe.runIf(realFiles.length > 0)("real latest-draft fixtures", () => {
    it.each(realFiles)("%s: invariants in both directions", (path) => {
        const group = loadFile(path);
        for (const conn of group.getConnections()) {
            const rawBefore = JSON.stringify(conn.getEvents().map((e) => e.raw));
            for (const dir of [sending, receiving]) {
                const r = run(conn, dir);
                const [packets, frames, http, streams] = r.lanes;
                const name = dir === sending ? "quic:packet_sent" : "quic:packet_received";
                const pkts = conn
                    .getEvents()
                    .filter((e) => e.fullName === name && e.data.raw && e.data.header?.packet_type);
                const expectedXMax = pkts.reduce(
                    (sum, e) => sum + (Number(e.data.raw.length) || e.data.raw.data.length / 2),
                    0,
                );

                expect(xMaxOf(packets)).toBe(expectedXMax);
                expect(packets.ranges).toHaveLength(3 * pkts.length);
                packets.ranges.forEach((range: PacketizationRange, i) => {
                    const k = Math.floor(i / 3);
                    expect(range.index).toBe(k);
                    expect(range.color).toBe(k % 2 === 0 ? "black" : "grey");
                });
                // header + payload + trailer tile every packet without gaps or overlaps
                for (let i = 1; i < packets.ranges.length; i++) {
                    expect(packets.ranges[i].start).toBe(packets.ranges[i - 1].start + packets.ranges[i - 1].size);
                }
                for (const range of [...frames.ranges, ...http.ranges, ...streams.ranges]) {
                    expect(Number.isFinite(range.start) && Number.isFinite(range.size)).toBe(true);
                    expect(range.start).toBeGreaterThanOrEqual(0);
                    expect(range.start + range.size).toBeLessThanOrEqual(expectedXMax);
                }
                expect(streams.ranges).toHaveLength(http.ranges.length);
                if (pkts.length > 0) {
                    expect(packets.efficiency).toBeGreaterThanOrEqual(0); // 0 for traces without HTTP/3
                    expect(packets.efficiency).toBeLessThanOrEqual(1);
                    expect(r.emptyNote).toBeUndefined();
                }
                expect(r.diagnostics).not.toContain(
                    "PacketizationQUICPreprocessor: Not all HTTP3 frames found a home!",
                );
                expect(r.insufficientBytes).toBe(false);
            }
            expect(JSON.stringify(conn.getEvents().map((e) => e.raw))).toBe(rawBefore); // Q-F1
        }
    });
});

const PAR10_CLIENT = join(ROOT, "tests/fixtures/latest/packetization-par10-client.sqlog");

describe.runIf(realFiles.includes(PAR10_CLIENT))("quic-go client, 10 parallel 50000-byte requests", () => {
    const conn = loadFile(PAR10_CLIENT).getConnections()[0];

    it("receiving: every byte placed, every response's total resource size is 50000 (incl. stream 0, Q-H3)", () => {
        const r = run(conn, receiving);
        expect(r.diagnostics).toEqual([GUESS_MSG]);
        const [packets, , http, streams] = r.lanes;
        expect(packets.max_size_local).toBe(1452);
        expect(packets.max_size_remote).toBe(1452);
        const totals = new Map<number, string>();
        for (const range of streams.ranges) {
            const id = Number(range.rawPacket.stream_id);
            if (id % 4 === 0) totals.set(id, streams.rangeToString(range));
        }
        expect([...totals.keys()].sort((a, b) => a - b)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
        for (const [id, text] of totals) {
            expect(text).toMatch(
                new RegExp("^H3 streamID: " + id + "<br/>GET: /file-\\d\\.bin<br/>total resource size: 50000<br/>$"),
            );
        }
        const dataPayload = http.ranges
            .filter((x) => x.contentType === "data" && x.isPayload)
            .reduce((s, x) => s + x.size, 0);
        expect(dataPayload).toBe(10 * 50000);
    });

    it("sending: the 10 request HEADERS frames and the control/QPACK streams are placed", () => {
        const r = run(conn, sending);
        expect(r.diagnostics).toEqual([GUESS_MSG]);
        const headers = r.lanes[2].ranges.filter((x) => x.contentType === "headers" && x.isPayload);
        expect(headers).toHaveLength(10);
        expect(r.lanes[1].ranges.some((x) => x.color === "yellow")).toBe(true); // ACK-only packets are guesstimated
    });
});
