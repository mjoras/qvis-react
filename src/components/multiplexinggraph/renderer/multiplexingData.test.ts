// @vitest-environment node
// Unit tests for the pure multiplexing extraction (docs/dev/parity/multiplexing-graph.md §8.6 and §9.9).

import {
    byteRangeYDomain,
    classifyArrival,
    eventNames,
    extractCollapsedData,
    extractSimulationRequests,
    extractWaterfallData,
    FrameArrivalType,
    frameTooltipLines,
    getPerspective,
    isDataStream,
    MUX_OPTIONS,
    newStreamRange,
    readDataStreamFrame,
    readH3RequestFrame,
    readStreamDataMoved,
    streamDuration,
    streamFrameDataLength,
    u64,
    waterfallLayout,
    type FrameDatum,
} from "./multiplexingData";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    headers,
    loadFixture,
    loadText,
    ROOT,
    moved,
    priorityUpdate,
    received,
    sent,
    streamFrame,
    trace,
    type RawEvent,
} from "../__fixtures__/muxTrace";

const T = FrameArrivalType;

beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------------------------------
describe("classifyArrival (§3.5 vectors)", () => {
    function run(seq: [number, number, number][]) {
        const range = newStreamRange();
        const out = seq.map(([t, from, to]) => classifyArrival(range, t, from, to));
        return { range, out, types: out.map((o) => o.type) };
    }

    it("in order", () => {
        const { types, range } = run([
            [0, 0, 99],
            [1, 100, 199],
            [2, 200, 299],
        ]);
        expect(types).toEqual([T.Normal, T.Normal, T.Normal]);
        expect(range.currentHead).toBe(299);
        expect(range.highestReceived).toBe(299);
        expect(range.holes).toEqual([]);
        expect(range.filled).toEqual([{ from: 0, to: 299, time: 2 }]);
    });

    it("gap, then fill: Future with hole [100,200], then Retransmit (never Reordered for the first fill)", () => {
        const { out, range } = run([
            [0, 0, 99],
            [1, 200, 299],
            [2, 100, 199],
        ]);
        expect(out.map((o) => o.type)).toEqual([T.Normal, T.Future, T.Retransmit]);
        expect(out[1].createdHole).toEqual([100, 200]);
        expect(out[2].timeDifference).toBe(1);
        expect(out[2].createdHole).toBeUndefined();
        expect(range.currentHead).toBe(299);
        expect(range.highestReceived).toBe(299);
        expect(range.timeDifferenceSampleCount).toBe(1);
    });

    it("two fills: the second, fast one is Reordered", () => {
        const { out } = run([
            [0, 0, 99],
            [10, 200, 299],
            [50, 100, 199],
            [60, 400, 499],
            [61, 300, 399],
        ]);
        expect(out.map((o) => o.type)).toEqual([T.Normal, T.Future, T.Retransmit, T.Future, T.Reordered]);
        expect(out[2].timeDifference).toBe(40);
        expect(out[4].timeDifference).toBe(1);
    });

    it("first frame not at offset 0: Future, then Duplicate (no hole before the first filled range)", () => {
        const { out, range } = run([
            [0, 100, 199],
            [5, 0, 99],
        ]);
        expect(out.map((o) => o.type)).toEqual([T.Future, T.Duplicate]);
        expect(out[0].createdHole).toEqual([0, 100]);
        expect(range.currentHead).toBe(199);
        expect(range.highestReceived).toBe(199);
    });

    it("pure duplicate", () => {
        expect(
            run([
                [0, 0, 99],
                [1, 100, 199],
                [2, 0, 99],
            ]).types,
        ).toEqual([T.Normal, T.Normal, T.Duplicate]);
    });

    it("duplicate beyond head (found in filled)", () => {
        const { types, range } = run([
            [0, 0, 99],
            [1, 200, 299],
            [2, 200, 299],
        ]);
        expect(types).toEqual([T.Normal, T.Future, T.Duplicate]);
        expect(range.currentHead).toBe(99);
        expect(range.highestReceived).toBe(299);
    });

    it("partial overlap: Duplicate, no state update", () => {
        const { types, range } = run([
            [0, 0, 99],
            [1, 50, 149],
        ]);
        expect(types).toEqual([T.Normal, T.Duplicate]);
        expect(range.highestReceived).toBe(99);
        expect(range.currentHead).toBe(99);
    });

    it("zero-length FIN: Duplicate", () => {
        expect(
            run([
                [0, 0, 99],
                [1, 100, 99],
            ]).types,
        ).toEqual([T.Normal, T.Duplicate]);
    });

    it("spanning after a new filled range", () => {
        expect(
            run([
                [0, 0, 99],
                [1, 200, 299],
                [2, 300, 399],
                [3, 250, 259],
            ]).types,
        ).toEqual([T.Normal, T.Future, T.Normal, T.Duplicate]);
    });

    it("a new hole inherits the time of the old hole it overlaps", () => {
        const { range } = run([
            [0, 0, 99],
            [10, 300, 399], // hole [100, 299] @10
            [20, 150, 199], // splits it: [100,149] and [200,299], both @10
        ]);
        expect(range.holes).toEqual([
            { from: 100, to: 149, time: 10 },
            { from: 200, to: 299, time: 10 },
        ]);
        expect(range.currentHead).toBe(99);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("accessors", () => {
    it("u64", () => {
        expect(u64(12)).toBe(12);
        expect(u64("12")).toBe(12);
        expect(u64("")).toBeUndefined();
        expect(u64("12abc")).toBeUndefined();
        expect(u64("-1")).toBeUndefined();
        expect(u64(NaN)).toBeUndefined();
        expect(u64(undefined)).toBeUndefined();
        expect(u64(null)).toBeUndefined();
    });

    it("isDataStream", () => {
        expect(isDataStream(0)).toBe(true);
        expect(isDataStream(4)).toBe(true);
        expect(isDataStream(2)).toBe(false);
        expect(isDataStream(3)).toBe(false);
        expect(isDataStream(5)).toBe(false);
        expect(isDataStream(u64("8"))).toBe(true);
        expect(isDataStream(undefined)).toBe(false);
    });

    it("STREAM frames (§9.9)", () => {
        expect(readDataStreamFrame(streamFrame(4, undefined, 10))).toEqual({ sid: 4, offset: 0, length: 10 });
        expect(readDataStreamFrame(streamFrame("8", "100", 10))).toEqual({ sid: 8, offset: 100, length: 10 });
        expect(readDataStreamFrame(streamFrame("", 0, 10))).toBeUndefined();
        expect(readDataStreamFrame(streamFrame(2, 0, 10))).toBeUndefined();
        expect(readDataStreamFrame({ frame_type: "max_stream_data", stream_id: 0, maximum: 1 })).toBeUndefined();
        expect(readDataStreamFrame(null)).toBeUndefined();
        expect(readDataStreamFrame("stream")).toBeUndefined();

        expect(streamFrameDataLength({ raw: { payload_length: 1200 } })).toBe(1200);
        expect(streamFrameDataLength({ raw: { length: 1200 } })).toBe(1200);
        expect(streamFrameDataLength({ raw: { length: 1213, payload_length: 1200 } })).toBe(1200);
        expect(streamFrameDataLength({ raw: { data: "abcd" } })).toBeUndefined();
        expect(streamFrameDataLength({ raw: "abcd" })).toBeUndefined();
        // strict latest drafts: the pre-final top-level length is not read
        expect(streamFrameDataLength({ length: 1200 })).toBeUndefined();

        // no raw -> length 0, range [offset, offset - 1]
        expect(readDataStreamFrame({ frame_type: "stream", stream_id: 0, offset: 50 })).toEqual({
            sid: 0,
            offset: 50,
            length: 0,
        });
        expect(readDataStreamFrame({ frame_type: "stream", stream_id: 0, raw: "abcd" })!.length).toBe(0);
    });

    it("quic:stream_data_moved: every from/to combination (§9.4.5)", () => {
        const values = ["application", "transport", "network", undefined] as const;
        const expected: Record<string, boolean> = {
            "application/application": true,
            "application/transport": false,
            "application/network": false,
            "application/undefined": false,
            "transport/application": true,
            "transport/transport": true,
            "transport/network": false, // D-MX3
            "transport/undefined": true,
            "network/application": true,
            "network/transport": false,
            "network/network": false,
            "network/undefined": false,
            "undefined/application": true,
            "undefined/transport": false,
            "undefined/network": false,
            "undefined/undefined": false,
        };
        for (const from of values) {
            for (const to of values) {
                const d: Record<string, unknown> = { stream_id: 0, offset: 0, raw: { length: 10 } };
                if (from !== undefined) d.from = from;
                if (to !== undefined) d.to = to;
                expect(readStreamDataMoved(d) !== undefined, `${from}/${to}`).toBe(expected[`${from}/${to}`]);
            }
        }
        const net = { stream_id: 0, offset: 0, from: "transport", to: "network", raw: { length: 10 } };
        expect(readStreamDataMoved(net)).toBeUndefined();
        expect(readStreamDataMoved(net, { ...MUX_OPTIONS, skipMovesToNetwork: false })).toEqual({
            sid: 0,
            offset: 0,
            length: 10,
        });
    });

    it("quic:stream_data_moved: lengths, offsets, stream ids", () => {
        const base = { from: "transport", to: "application" };
        const debug = vi.mocked(console.debug);
        debug.mockClear();
        expect(readStreamDataMoved({ ...base, stream_id: 0, offset: 0, additional_info: "fin_set" })).toBeUndefined();
        expect(debug).not.toHaveBeenCalled(); // silent when additional_info is set
        expect(readStreamDataMoved({ ...base, stream_id: 0, offset: 0, raw: "abcd" })).toBeUndefined();
        expect(readStreamDataMoved({ ...base, stream_id: 0, raw: { length: 10 } })).toBeUndefined();
        expect(readStreamDataMoved({ ...base, stream_id: 0, offset: 0, raw: { length: 0 } })).toBeUndefined();
        expect(readStreamDataMoved({ ...base, stream_id: 2, offset: 0, raw: { length: 10 } })).toBeUndefined();
        expect(readStreamDataMoved({ ...base, offset: 0, raw: { length: 10 } })).toBeUndefined();
        expect(readStreamDataMoved({ ...base, stream_id: "8", offset: "5", raw: { length: "10" } })).toEqual({
            sid: 8,
            offset: 5,
            length: 10,
        });
        expect(readStreamDataMoved(undefined)).toBeUndefined();
    });

    it("HTTP/3 request frames (§9.4.3, §9.4.4)", () => {
        const hdr = (h: unknown) => ({ stream_id: 4, frame: { frame_type: "headers", headers: h } });
        expect(readH3RequestFrame(hdr([{ name_bytes: "7072696f72697479", value: "u=1" }]))).toEqual({
            kind: "headers",
            sid: 4,
            priorities: ["u=1"],
        });
        expect(readH3RequestFrame(hdr([{ name: "priority", value_bytes: "753d33" }]))).toEqual({
            kind: "headers",
            sid: 4,
            priorities: ["u=3"],
        });
        expect(readH3RequestFrame(hdr([{ name: "priority" }]))!).toEqual({
            kind: "headers",
            sid: 4,
            priorities: ["undefined"],
        });
        expect(readH3RequestFrame(hdr([{ name: "Priority", value: "u=1" }]))).toEqual({
            kind: "headers",
            sid: 4,
            priorities: [],
        });
        expect(readH3RequestFrame({ stream_id: 4, frame: { frame_type: "headers" } })).toEqual({
            kind: "headers",
            sid: 4,
            priorities: [],
        });
        expect(readH3RequestFrame({ frame: { frame_type: "headers", headers: [] } })).toBeUndefined();
        expect(
            readH3RequestFrame({
                stream_id: 2,
                frame: { frame_type: "priority_update", stream_id: 4, priority_field_value: "u=1, i" },
            }),
        ).toEqual({ kind: "priority_update", sid: 4, value: "u=1, i" });
        expect(
            readH3RequestFrame({
                stream_id: 2,
                frame: { frame_type: "priority_update", push_id: 1, priority_field_value: "u=1" },
            }),
        ).toBeUndefined();
        // legacy aioquic shape: no fallback
        expect(
            readH3RequestFrame({ stream_id: 2, frame: { frame_type: "priority_update", element_id: 8, value: "u=1" } }),
        ).toBeUndefined();
        expect(readH3RequestFrame({ stream_id: 2, frame: { frame_type: "settings", settings: [] } })).toBeUndefined();
        expect(readH3RequestFrame({ stream_id: 2 })).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("perspective (§9.3)", () => {
    const pkts: RawEvent[] = [sent(1, []), received(2, [])];
    const rpkts: RawEvent[] = [received(1, []), sent(2, [])];

    it.each([
        [{ type: "client" }, "client"],
        [{ type: "server" }, "server"],
        [{ type: "network", flow: "client" }, "client"],
        [{ type: "network", flow: "server" }, "server"],
        [{ type: "unknown", flow: "server" }, "server"],
    ])("%o -> %s", (vp, expected) => {
        expect(getPerspective(trace(rpkts, vp))).toBe(expected);
    });

    it("D-MX2: unknown without flow uses the first packet event", () => {
        expect(getPerspective(trace(rpkts, { type: "unknown" }))).toBe("server");
        expect(getPerspective(trace(pkts, { type: "unknown" }))).toBe("client");
        expect(getPerspective(trace([], { type: "unknown" }))).toBe("client");
        expect(getPerspective(trace(rpkts, null))).toBe("server"); // no vantage_point at all
        expect(getPerspective(trace(rpkts, { type: "Server" }))).toBe("server"); // wrong case -> unknown -> heuristic
        expect(getPerspective(trace(pkts, { type: "Server" }))).toBe("client");
        expect(
            getPerspective(trace(rpkts, { type: "unknown" }), { ...MUX_OPTIONS, inferUnknownPerspective: false }),
        ).toBe("client");
    });

    it("event names per perspective", () => {
        expect(eventNames(trace([], { type: "client" }))).toEqual({
            dataEvent: "quic:packet_received",
            requestEvent: "quic:packet_sent",
            h3Event: "http3:frame_created",
            directionText: "received",
            perspective: "client",
        });
        expect(eventNames(trace([], { type: "server" }))).toEqual({
            dataEvent: "quic:packet_sent",
            requestEvent: "quic:packet_received",
            h3Event: "http3:frame_parsed",
            directionText: "sent",
            perspective: "server",
        });
    });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("extractCollapsedData (§3.3)", () => {
    const events: RawEvent[] = [
        sent(1, [streamFrame(0, 0, 30), streamFrame(4, 0, 30), streamFrame(8, 0, 30)]),
        received(
            10,
            [
                streamFrame(0, 0, 100),
                streamFrame(2, 0, 5),
                { frame_type: "max_stream_data", stream_id: 4, maximum: 10 },
            ],
            1,
        ),
        received(11, [streamFrame(4, 0, 100), streamFrame(3, 0, 7), streamFrame(8, 0, 100)], 2),
        moved(11.5, { stream_id: 4, offset: 0, from: "transport", to: "application", raw: { length: 100 } }),
        moved(11.6, { stream_id: 8, offset: 0, from: "application", to: "transport", raw: { length: 100 } }), // AND rule: skip
        received(12, [streamFrame(0, 200, 100)], "3"),
        received(13, [streamFrame(0, 100, 100)], null),
        moved(13.5, { stream_id: "0", offset: 0, to: "application", raw: { length: 300 } }),
        received(14, [streamFrame(8, 0, 100)], 5),
    ];

    it("frames, indices, arrival types and moved linkage", () => {
        const c = extractCollapsedData(trace(events));
        expect(c.directionText).toBe("received");
        expect(c.dataSent.map((d) => d.streamID)).toEqual([0, 4, 8, 0, 0, 8]);
        expect(c.dataSent.map((d) => d.countStart)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(c.dataSent.map((d) => d.countEnd)).toEqual([2, 3, 4, 5, 6, 7]);
        expect(c.dataSent.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(c.frameCount).toBe(7);
        expect(c.dataSent.map((d) => d.arrivalType)).toEqual([
            T.Normal,
            T.Normal,
            T.Normal,
            T.Future,
            T.Retransmit,
            T.Duplicate,
        ]);
        expect(c.dataSent.map((d) => d.packetNumber)).toEqual([1, 2, 2, 3, undefined, 5]);
        expect(c.dataSent[3].arrivalCreatedHole).toEqual([100, 200]);
        expect(c.dataSent[4].arrivalTimeDifference).toBe(1);
        expect(c.dataSent[0]).toMatchObject({ offset: 0, length: 100, size: 100, time: 10 });
        expect(c.dataMoved).toEqual([
            { streamID: 4, countStart: 2, countEnd: 3, offset: 0, length: 100 },
            { streamID: 0, countStart: 5, countEnd: 6, offset: 0, length: 300 },
        ]);
    });

    it("server perspective: data = packet_sent", () => {
        const srv: RawEvent[] = [
            received(1, [streamFrame(0, 0, 30)]),
            sent(2, [streamFrame(0, 0, 500)]),
            sent(3, [streamFrame(0, 500, 500)]),
        ];
        const c = extractCollapsedData(trace(srv, { type: "server" }));
        expect(c.directionText).toBe("sent");
        expect(c.dataSent.map((d) => [d.offset, d.length])).toEqual([
            [0, 500],
            [500, 500],
        ]);
    });

    it("only latest-draft names are matched (§9.9)", () => {
        const legacy: RawEvent[] = [
            { ...received(1, [streamFrame(0, 0, 100)]), name: "transport:packet_received" },
            {
                time: 2,
                name: "quic:packet_lost",
                data: { header: { packet_type: "1RTT", packet_number: 1 }, frames: [streamFrame(0, 0, 100)] },
            },
            { time: 3, name: "quic:marked_for_retransmit", data: { frames: [streamFrame(0, 0, 100)] } },
        ];
        expect(extractCollapsedData(trace(legacy)).dataSent).toEqual([]);
        const renamed = [received(1, [streamFrame(0, 0, 100)])];
        expect(extractCollapsedData(trace(renamed)).dataSent).toHaveLength(1);
    });

    it("trace without events: frameCount 1, nothing else", () => {
        const c = extractCollapsedData(trace([]));
        expect(c).toMatchObject({ dataSent: [], dataMoved: [], frameCount: 1 });
    });

    it("malformed events are skipped, not thrown on (M20)", () => {
        const bad: RawEvent[] = [
            { time: 1, name: "quic:packet_received", data: { frames: [null, 5, "x", { frame_type: "stream" }] } },
            { time: 2, name: "quic:packet_received", data: { header: null, frames: [streamFrame(0, 0, 10)] } },
            { time: 3, name: "quic:packet_received", data: { frames: "nope" } },
            {
                time: 4,
                name: "quic:stream_data_moved",
                data: { stream_id: 0, offset: 0, from: "transport", raw: { length: 10 } },
            },
        ];
        const c = extractCollapsedData(trace(bad));
        expect(c.dataSent).toHaveLength(1);
        expect(c.dataSent[0].packetNumber).toBeUndefined();
        expect(c.dataMoved).toHaveLength(1);
    });

    it("D-MX1: frames_parsed STREAM frames with packet_numbers when packet events carry none", () => {
        const evs: RawEvent[] = [
            received(1, []),
            {
                time: 2,
                name: "quic:frames_parsed",
                data: { frames: [streamFrame(0, 0, 10), streamFrame(4, 0, 10)], packet_numbers: [7, "8"] },
            },
            { time: 3, name: "quic:frames_processed", data: { frames: [streamFrame(0, 0, 10)] } },
        ];
        const conn = trace(evs);
        expect(eventNames(conn).dataEvent).toBe("quic:frames_parsed");
        const c = extractCollapsedData(conn);
        expect(c.dataSent.map((d) => [d.streamID, d.packetNumber])).toEqual([
            [0, 7],
            [4, 8],
        ]);
        expect(eventNames(conn, { ...MUX_OPTIONS, frameEventFallback: false }).dataEvent).toBe("quic:packet_received");
    });

    it("D-MX1: packet events win (no double count); frames_processed only as the last resort", () => {
        const both: RawEvent[] = [
            received(1, [streamFrame(0, 0, 10)]),
            { time: 2, name: "quic:frames_parsed", data: { frames: [streamFrame(0, 0, 10)] } },
        ];
        expect(extractCollapsedData(trace(both)).dataSent).toHaveLength(1);
        const processedOnly: RawEvent[] = [
            { time: 2, name: "quic:frames_parsed", data: { frames: [{ frame_type: "ping" }] } },
            { time: 3, name: "quic:frames_processed", data: { frames: [streamFrame(0, 0, 10)] } },
        ];
        expect(eventNames(trace(processedOnly)).dataEvent).toBe("quic:frames_processed");
    });

    it("D-MX1: the waterfall and the strip report the same N", () => {
        const evs: RawEvent[] = [
            { time: 1, name: "quic:frames_created", data: { frames: [streamFrame(0, 0, 10), streamFrame(4, 0, 10)] } },
            { time: 2, name: "quic:frames_parsed", data: { frames: [streamFrame(0, 0, 10), streamFrame(4, 0, 10)] } },
            { time: 3, name: "quic:frames_parsed", data: { frames: [streamFrame(4, 10, 10), streamFrame(0, 10, 10)] } },
        ];
        const conn = trace(evs);
        const names = eventNames(conn);
        expect(names.requestEvent).toBe("quic:frames_created");
        const c = extractCollapsedData(conn, names);
        const w = extractWaterfallData(conn, names);
        expect(c.dataSent).toHaveLength(4);
        expect(w.dataFrameCount).toBe(4);
        expect(w.streams.size).toBe(2);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("extractWaterfallData (§3.4)", () => {
    const FC = "http3:frame_created";

    it("request order, indices in data-frame space, H3 info and priority strings", () => {
        const evs: RawEvent[] = [
            priorityUpdate(FC, 1, { stream_id: 8, priority_field_value: "u=1" }),
            headers(FC, 2, 0, [{ name: "priority", value: "u=0" }]),
            sent(2, [streamFrame(0, 0, 30)]),
            headers(FC, 3, 4, [{ name: ":path", value: "/b" }]),
            sent(3, [streamFrame(4, 0, 30)]),
            received(10, [streamFrame(0, 0, 100)]),
            headers(FC, 11, 8, [{ name: "priority", value: "u=3" }]),
            sent(11, [streamFrame(8, 0, 30), streamFrame(4, 30, 5)]), // request body on 4: ignored
            received(12, [streamFrame(4, 0, 100), streamFrame(0, 100, 100)]),
            received(13, [streamFrame(8, 0, 100)]),
            received(14, [streamFrame(0, 100, 100)]), // duplicate still counts in totalData
            priorityUpdate(FC, 15, { push_id: 3, priority_field_value: "u=7" }), // push only: skipped
            priorityUpdate(FC, 16, { stream_id: 0, priority_field_value: "u=5" }),
        ];
        const w = extractWaterfallData(trace(evs));
        expect(w.directionText).toBe("received");
        expect(w.dataFrameCount).toBe(5);
        expect([...w.streams.keys()]).toEqual([0, 4, 8]);
        const s0 = w.streams.get(0)!;
        const s4 = w.streams.get(4)!;
        const s8 = w.streams.get(8)!;
        expect(s0).toMatchObject({
            order: 0,
            requestIndex: 0,
            startIndex: 1,
            stopIndex: 5,
            frameCount: 3,
            totalData: 300,
        });
        expect(s0).toMatchObject({ requestTime: 2, startTime: 10, endTime: 14 });
        expect(s4).toMatchObject({
            order: 1,
            requestIndex: 0,
            startIndex: 2,
            stopIndex: 2,
            frameCount: 1,
            totalData: 100,
        });
        expect(s8).toMatchObject({
            order: 2,
            requestIndex: 1,
            startIndex: 4,
            stopIndex: 4,
            frameCount: 1,
            totalData: 100,
        });
        expect(s0.h3Info).toMatchObject({
            headersIndex: 0,
            headersTime: 2,
            priorityUpdateIndex: 5,
            priorityUpdateTime: 16,
        });
        expect(s0.h3Info!.priorityString).toBe("HEADER: u=0 -> FRAME: u=5");
        expect(s4.h3Info).toMatchObject({ headersIndex: 0, priorityUpdateIndex: -1, priorityString: "" });
        expect(s8.h3Info).toMatchObject({
            headersIndex: 1,
            headersTime: 11,
            priorityUpdateIndex: 0,
            priorityUpdateTime: 1,
        });
        expect(s8.h3Info!.priorityString).toBe("FRAME: u=1 -> HEADER: u=3");
    });

    it("M15: a data frame of an unknown stream counts, then breaks out of the packet", () => {
        const evs: RawEvent[] = [
            sent(1, [streamFrame(0, 0, 30), streamFrame(4, 0, 30)]),
            received(2, [streamFrame(12, 0, 100), streamFrame(0, 0, 100)]), // 12 was never requested
            received(3, [streamFrame(4, 0, 100)]),
        ];
        const w = extractWaterfallData(trace(evs));
        expect(w.dataFrameCount).toBe(2);
        expect([...w.streams.keys()]).toEqual([0, 4]);
        expect(w.streams.get(0)!.startIndex).toBe(-1); // its frame was skipped by the break
        expect(w.streams.get(4)!.startIndex).toBe(2);
    });

    it("server perspective: requests = packet_received, H3 = frame_parsed", () => {
        const evs: RawEvent[] = [
            received(1, [streamFrame(0, 0, 30)]),
            headers("http3:frame_parsed", 1.5, 0, [{ name: "priority", value: "u=2" }]),
            headers("http3:frame_created", 1.6, 0, [{ name: "priority", value: "u=6" }]), // response headers: ignored
            sent(2, [streamFrame(0, 0, 1000)]),
        ];
        const w = extractWaterfallData(trace(evs, { type: "server" }));
        expect(w.directionText).toBe("sent");
        expect(w.streams.get(0)).toMatchObject({ requestTime: 1, startTime: 2, totalData: 1000 });
        expect(w.streams.get(0)!.h3Info!.priorityString).toBe("HEADER: u=2");
    });

    it("http:frame_created (Capsule namespace) is never matched", () => {
        const evs: RawEvent[] = [
            headers("http:frame_created", 1, 0, [{ name: "priority", value: "u=2" }]),
            sent(2, [streamFrame(0, 0, 3)]),
        ];
        const w = extractWaterfallData(trace(evs));
        expect(w.streams.get(0)!.h3Info!.headersIndex).toBe(-1);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("layout helpers", () => {
    it("waterfallLayout (§3.9, M36)", () => {
        expect(waterfallLayout(0).svgHeight).toBe(150);
        expect(waterfallLayout(1).svgHeight).toBe(154);
        expect(waterfallLayout(2).svgHeight).toBe(154);
        expect(waterfallLayout(13).svgHeight).toBe(155);
        expect(waterfallLayout(26).svgHeight).toBe(155);
        expect(waterfallLayout(29).svgHeight).toBe(154);
        expect(waterfallLayout(30).svgHeight).toBe(160);
        expect(waterfallLayout(31).svgHeight).toBe(164);
        expect(waterfallLayout(1).circleWidth).toBe(15);
        expect(waterfallLayout(10).minBarHeight).toBeCloseTo(11.4);
        expect(waterfallLayout(10).circleWidth).toBeCloseTo(9.5);
        expect(waterfallLayout(40).minBarHeight).toBe(4);
    });

    const frames = (ids: number[]): FrameDatum[] =>
        ids.map((streamID, i) => ({
            streamID,
            packetNumber: i,
            index: i,
            size: 100,
            countStart: i + 1,
            countEnd: i + 2,
            arrivalType: T.Normal,
            arrivalTimeDifference: 0,
            arrivalCreatedHole: undefined,
            offset: 100 * ids.slice(0, i).filter((x) => x === streamID).length,
            length: 100,
            time: i,
        }));

    it("byteRangeYDomain: M7 index math (first two frames ignored for the minimum when unzoomed)", () => {
        // stream 0 at array indices 0,1,2,3,4 -> offsets 0..400
        const all = frames([0, 0, 0, 0, 0, 0]);
        // unzoomed domain [1, N + 1] = [1, 7]: startIndex 2, endIndex 5
        expect(byteRangeYDomain(all, 0, [1, 7], 599)).toEqual([200, 599]);
        // zoomed into [3.2, 5.9]: startIndex ceil(3.2)+1 = 5, endIndex floor(5.9)-1 = 4 -> nothing -> M8 fallback
        expect(byteRangeYDomain(all, 0, [3.2, 5.9], 599)).toEqual([0, 599]);
    });

    it("byteRangeYDomain: M8 fallback when the stream has no frame in the window", () => {
        const all = frames([0, 4, 4, 4, 4, 4, 4, 0]);
        expect(byteRangeYDomain(all, 0, [3, 7], 199)).toEqual([0, 199]);
        expect(byteRangeYDomain(all, 4, [1, 9], 599)).toEqual([100, 599]);
    });

    it("tooltip lines (§2.6, M22)", () => {
        const [a, b, c, d] = frames([0, 0, 0, 0]);
        expect(frameTooltipLines({ ...a, time: 359.00000000000006, packetNumber: 12 })).toEqual([
            "359ms : stream 0 : packet number 12",
            "[0, 99] (size: 100)",
        ]);
        expect(
            frameTooltipLines({
                ...b,
                packetNumber: undefined,
                arrivalType: T.Retransmit,
                arrivalTimeDifference: 31.0000000004,
            }),
        ).toEqual([
            "1ms : stream 0 : packet number undefined",
            "[100, 199] (size: 100)",
            "Fills gap that was created 31ms ago",
        ]);
        expect(frameTooltipLines({ ...c, arrivalType: T.Reordered, arrivalTimeDifference: 1.25 })[2]).toBe(
            "Fills gap that was created 1.25ms ago",
        );
        // ns precision as logged by quic-go is printed like qvis; float noise below 1 ns is dropped
        expect(frameTooltipLines({ ...c, time: 88.799834, packetNumber: 1 })[0]).toBe(
            "88.799834ms : stream 0 : packet number 1",
        );
        expect(frameTooltipLines({ ...c, time: 44.653917000000035, packetNumber: 1 })[0]).toBe(
            "44.653917ms : stream 0 : packet number 1",
        );
        expect(frameTooltipLines({ ...d, arrivalType: T.Future, arrivalCreatedHole: [100, 200] })[2]).toBe(
            "Creates gap from 100 to 200 (size: 100)",
        );
    });

    it("stream duration from the rounded strings (M38)", () => {
        expect(streamDuration(10, 12.345)).toBe("2.35");
        expect(streamDuration(-1, -1)).toBe("0.00");
        expect(streamDuration(0.005, 0.014)).toBe("0.00");
    });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("real latest-draft fixtures", () => {
    it("qvis demo parallel_10_50KB_f5 converted to the latest drafts: the §3.4 sanity values", () => {
        const conn = loadFixture("multiplexing-aioquic-parallel10-client.sqlog").getConnections()[0];
        const c = extractCollapsedData(conn);
        expect(c.dataSent).toHaveLength(391);
        expect(c.frameCount).toBe(392);
        expect(c.dataSent.every((d) => d.arrivalType === T.Normal)).toBe(true);
        const w = extractWaterfallData(conn);
        expect(w.dataFrameCount).toBe(391);
        expect([...w.streams.keys()]).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
        for (const s of w.streams.values()) {
            expect(s.requestIndex).toBe(0);
            expect(s.h3Info!.headersIndex).toBe(0);
            expect(s.h3Info!.priorityString).toBe("");
        }
        expect(w.streams.get(0)).toMatchObject({
            startIndex: 1,
            stopIndex: 387,
            requestTime: 359,
            startTime: 531,
            endTime: 2083,
            frameCount: 43,
            totalData: 50029,
        });
        expect(w.streams.get(36)).toMatchObject({ startIndex: 255, stopIndex: 291, frameCount: 37, totalData: 50038 });
        // hosted qvis, same connection: stream 12 details and the tooltip of the 51st frame
        expect(w.streams.get(12)).toMatchObject({
            requestTime: 360,
            startTime: 699,
            endTime: 2085,
            totalData: 50026,
            frameCount: 41,
        });
        expect(frameTooltipLines(c.dataSent[50])).toEqual([
            "877ms : stream 20 : packet number 55",
            "[22204, 23643] (size: 1440)",
        ]);
    });

    it("multiplexing-handwritten-client.sqlog: all features", () => {
        const conn = loadFixture("multiplexing-handwritten-client.sqlog").getConnections()[0];
        const c = extractCollapsedData(conn);
        expect(c.dataSent).toHaveLength(15);
        expect(c.frameCount).toBe(16);
        expect([...new Set(c.dataSent.map((d) => d.streamID))]).toEqual([0, 4, 8]);
        const byType = (t: FrameArrivalType) => c.dataSent.filter((d) => d.arrivalType === t).map((d) => d.countStart);
        expect(byType(T.Future)).toEqual([4, 9, 11]);
        expect(byType(T.Retransmit)).toEqual([6, 10]);
        expect(byType(T.Reordered)).toEqual([12]);
        expect(byType(T.Duplicate)).toEqual([8, 15]); // the duplicate and the zero-length FIN
        expect(c.dataSent.filter((d) => d.packetNumber === undefined).map((d) => d.countStart)).toEqual([13, 14]);
        // 8 kept moves: the fin_set move without raw and the transport -> network move are skipped
        expect(c.dataMoved).toHaveLength(8);
        expect(c.dataMoved[0]).toEqual({ streamID: 0, countStart: 1, countEnd: 2, offset: 0, length: 1000 });

        const w = extractWaterfallData(conn);
        expect(w.dataFrameCount).toBe(15);
        expect([...w.streams.keys()]).toEqual([0, 4, 8]);
        expect(w.streams.get(0)!.h3Info!.priorityString).toBe("HEADER: u=0");
        expect(w.streams.get(4)!.h3Info!.priorityString).toBe("HEADER: u=2");
        expect(w.streams.get(8)!.h3Info!.priorityString).toBe("FRAME: u=1, i -> HEADER: u=3");
        expect(w.streams.get(8)!.h3Info).toMatchObject({
            headersIndex: 0,
            priorityUpdateIndex: 0,
            priorityUpdateTime: 9.75,
        });
        expect(w.streams.get(0)).toMatchObject({
            startIndex: 1,
            stopIndex: 13,
            frameCount: 4,
            totalData: 3500,
            requestTime: 10.25,
        });
        expect(w.streams.get(8)).toMatchObject({ frameCount: 7, totalData: 6000, startTime: 42, endTime: 104 });

        expect(extractSimulationRequests(conn).map((r) => r.text)).toEqual([
            "GET /index.html",
            "GET /style.css",
            "GET /app.js",
        ]);
    });

    it("multiplexing-par10-client.sqlog: 10 parallel request streams, client perspective", () => {
        const conn = loadFixture("multiplexing-par10-client.sqlog").getConnections()[0];
        const names = eventNames(conn);
        expect(names.dataEvent).toBe("quic:packet_received");
        const c = extractCollapsedData(conn, names);
        const w = extractWaterfallData(conn, names);
        expect(w.streams.size).toBe(10);
        expect(new Set(c.dataSent.map((d) => d.streamID))).toEqual(new Set([...w.streams.keys()]));
        expect(w.dataFrameCount).toBe(c.dataSent.length);
        expect(c.frameCount).toBe(c.dataSent.length + 1);
        for (const s of w.streams.values()) {
            expect(s.h3Info!.headersIndex).toBe(s.requestIndex);
            expect(s.startIndex).toBeGreaterThan(0);
            expect(s.totalData).toBeGreaterThan(0);
        }
        // every byte of every stream arrived (no holes at the end)
        for (const r of c.streamRanges.values()) expect(r.holes).toEqual([]);
    });

    it("multiplexing-par10-server.sqlog: server perspective (data = packet_sent)", () => {
        const conn = loadFixture("multiplexing-par10-server.sqlog").getConnections()[0];
        const names = eventNames(conn);
        expect(names).toMatchObject({
            dataEvent: "quic:packet_sent",
            requestEvent: "quic:packet_received",
            directionText: "sent",
        });
        const w = extractWaterfallData(conn, names);
        expect(w.streams.size).toBe(10);
        expect(extractCollapsedData(conn, names).dataSent.length).toBe(w.dataFrameCount);
    });

    it("multiplexing-lossy-client.sqlog: retransmissions are detected", () => {
        const conn = loadFixture("multiplexing-lossy-client.sqlog").getConnections()[0];
        const c = extractCollapsedData(conn);
        const types = new Set(c.dataSent.map((d) => d.arrivalType));
        expect(types.has(T.Future)).toBe(true);
        expect(types.has(T.Retransmit) || types.has(T.Reordered)).toBe(true);
        expect(extractWaterfallData(conn).streams.size).toBe(6);
    });
});

describe("non-conforming quic-go output (§9.1, §9.9)", () => {
    const dir = ["tests/fixtures/nonconforming", "tests/fixtures/quic-go"]
        .map((d) => join(ROOT, d))
        .find((d) => existsSync(d));
    const files = dir ? readdirSync(dir).filter((f) => /\.sqlog$/.test(f)) : [];

    it.runIf(files.length > 0).each(files)("%s: transport:* names give an empty view", (f) => {
        const conn = loadText(readFileSync(join(dir!, f), "utf8"), f).getConnections()[0];
        expect(
            conn.lookup("transport", "packet_received").length + conn.lookup("transport", "packet_sent").length,
        ).toBeGreaterThan(0);
        const c = extractCollapsedData(conn);
        expect(c.dataSent).toEqual([]);
        expect(c.frameCount).toBe(1);
        const w = extractWaterfallData(conn);
        expect(w.streams.size).toBe(0);
        expect(w.dataFrameCount).toBe(0);
    });
});
