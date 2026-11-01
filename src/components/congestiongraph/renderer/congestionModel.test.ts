// Congestion graph model builder: parity/congestion-graph.md §8.8 and the §9.14 test vectors (hand-written
// latest-draft traces), plus the real generated fixtures in tests/fixtures/latest.
/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ev, file, loaded, refTime, trace, type Json } from "@/model/__fixtures__/qlog";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnection } from "@/model/QlogConnection";
import { parseQlogText } from "@/qlog/parse";
import {
    buildCongestionModel,
    congestionNotice,
    findMetricUpdateExtrema,
    findYExtrema,
    packetSize,
    pnSpace,
    rttDomain,
    toStepSeries,
    type CongestionModel,
} from "./congestionModel";
import { ackTooltip, lossTooltip, sentTooltip } from "./format";

const ROOT = join(__dirname, "../../../..");

beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function connOf(events: unknown[], traceExtra: Json = {}): QlogConnection {
    const group = QlogLoader.fromJSON(
        loaded(file([trace(events, { vantage_point: { type: "server" }, ...traceExtra })])),
    );
    if (!group) throw new Error("not loaded");
    return group.getConnections()[0];
}

function modelOf(events: unknown[], traceExtra: Json = {}): CongestionModel {
    return buildCongestionModel(connOf(events, traceExtra));
}

const sent = (time: number, pn: unknown, length: unknown, type = "1RTT", extra: Json = {}): Json =>
    ev(time, "quic:packet_sent", { header: { packet_type: type, packet_number: pn }, raw: { length }, ...extra });

const received = (time: number, type: string, frames: unknown[], pn: unknown = 0, length: unknown = 50): Json =>
    ev(time, "quic:packet_received", { header: { packet_type: type, packet_number: pn }, raw: { length }, frames });

const ack = (...ranges: unknown[]): Json => ({ frame_type: "ack", acked_ranges: ranges });

/** packet numbers that got an ACK */
function ackedPns(model: CongestionModel): unknown[] {
    return model.packets.filter((p) => p.ackEvent !== undefined).map((p) => p.event.data.header.packet_number);
}

describe("byte ranges (§3.3(b))", () => {
    it("are cumulative, 1-based and inclusive", () => {
        const m = modelOf([sent(1, 0, 1280, "initial"), sent(2, 1, 1176, "handshake"), sent(3, 2, 1252)]);
        expect(m.packets.map((p) => [p.from, p.to])).toEqual([
            [1, 1280],
            [1281, 2456],
            [2457, 3708],
        ]);
        expect(m.originalRangeY).toEqual([0, 3718]);
        expect(m.initialRangeY).toEqual([1, 3708]);
        expect(m.originalRangeX).toEqual([0, 12]); // relativeTime starts at 0 (t=1 -> 0), xMax + 10
        expect(m.skippedSent).toBe(0);
        expect(congestionNotice(m)).toBeUndefined();
    });

    it("skips and counts unsized packets (§9.14 #2)", () => {
        const m = modelOf([
            sent(1, 0, 1252),
            sent(2, 1, "1252"),
            sent(3, 2, 0),
            sent(4, 3, "0"),
            ev(5, "quic:packet_sent", { header: { packet_type: "1RTT", packet_number: 4 }, raw: { data: "00ff10" } }),
            ev(6, "quic:packet_sent", { header: { packet_type: "1RTT", packet_number: 5, packet_size: 1252 } }),
            ev(7, "quic:packet_sent", {
                header: { packet_type: "initial", packet_number: 0, length: 1180 },
                raw: { length: 1200, payload_length: 1170 },
            }),
            ev(8, "quic:packet_sent", { raw: { length: 1200 } }), // no header (Q40)
        ]);
        expect(m.packets.map((p) => p.size)).toEqual([1252, 1252, 3, 1200]);
        expect(m.skippedSent).toBe(4);
        expect(congestionNotice(m)).toBe("4 quic:packet_sent events have no raw.length and were not plotted.");
    });

    it("packetSize: raw.length, raw.data fallback, never header.length / payload_length", () => {
        expect(packetSize({ raw: { length: 1252 } })).toBe(1252);
        expect(packetSize({ raw: { length: "1252" } })).toBe(1252);
        expect(packetSize({ raw: { data: "00ff10" } })).toBe(3);
        expect(packetSize({ raw: { payload_length: 1170 } })).toBeUndefined();
        expect(packetSize({ header: { length: 1180 } })).toBeUndefined();
        expect(packetSize({ raw: { length: -5 } })).toBeUndefined();
        expect(packetSize({ raw: { length: "abc" } })).toBeUndefined();
        expect(packetSize(undefined)).toBeUndefined();
    });
});

describe("ACK linking (§3.3(c), §9.4)", () => {
    const fiveSent = [1, 2, 3, 4, 5].map((pn) => sent(pn, pn, 1000));

    it.each([
        ["[[2,3]]", [[2, 3]], [2, 3]],
        ['[["2","3"]]', [["2", "3"]], [2, 3]],
        ["[[3,2]]", [[3, 2]], []],
        ["[[5]]", [[5]], [5]],
        ["[[5,5]]", [[5, 5]], [5]],
        ["[[1,2,3]]", [[1, 2, 3]], [1]],
        ["[[]]", [[]], []],
        [
            "unordered [[4,5],[1,1]]",
            [
                [4, 5],
                [1, 1],
            ],
            [1, 4, 5],
        ],
    ])("ranges %s", (_name, ranges, expected) => {
        const m = modelOf([...fiveSent, received(10, "1RTT", [ack(...(ranges as unknown[]))])]);
        expect(ackedPns(m)).toEqual(expected);
    });

    it("the first ACK in event order wins; times are graph times", () => {
        const m = modelOf([
            sent(0, 0, 1000),
            received(10, "1RTT", [ack([0, 0])], 7),
            received(20, "1RTT", [ack([0, 0])], 8),
        ]);
        const p = m.packets[0];
        expect(p.ackT).toBe(10);
        expect(p.ackEvent?.data.header.packet_number).toBe(7);
        expect(ackTooltip(p)).toEqual({
            timestamp: "Timestamp: 10",
            packetNr: "PacketNr: 1RTT 7",
            packetSize: [],
            ackedFrom: "Acked from: 1",
            ackedTo: "Acked to: 1000",
        });
    });

    it("matches by the carrying packet's PN space; 0-RTT is acknowledged in 1-RTT (Q3, §9.14 #4)", () => {
        const a = modelOf([
            sent(0, 0, 100, "0RTT"),
            sent(1, 1, 100, "0RTT"),
            sent(2, 2, 100, "1RTT"),
            received(5, "1RTT", [ack([0, 2])]),
        ]);
        expect(ackedPns(a)).toEqual([0, 1, 2]);

        const b = modelOf([sent(0, 0, 100, "initial"), sent(1, 0, 100, "1RTT"), received(5, "initial", [ack([0])])]);
        expect(b.packets.map((p) => p.ackEvent !== undefined)).toEqual([true, false]);
        expect(pnSpace("0RTT")).toBe("application_data");
        expect(pnSpace(undefined)).toBe("undefined");
    });

    it("bounds the work for huge ranges (Q34) and counts unknown PNs", () => {
        const m = modelOf([...fiveSent, received(10, "1RTT", [ack([0, 1e12])])]);
        expect(ackedPns(m)).toEqual([1, 2, 3, 4, 5]);
        expect(m.ackedNotSent).toBe(1e12 + 1 - 5);
    });

    it("skips ACK frames in header-less packets but keeps their flow-control frames (Q40)", () => {
        const m = modelOf([
            sent(0, 0, 1000),
            ev(5, "quic:packet_received", {
                raw: { length: 50 },
                frames: [ack([0, 0]), { frame_type: "max_data", maximum: 5000 }],
            }),
        ]);
        expect(ackedPns(m)).toEqual([]);
        expect(m.fcApplication.map((p) => p[1])).toContain(5000);
        expect(m.skippedReceived).toBe(1);
    });

    it("sized received packets extend the x range; unsized ones do not", () => {
        const m = modelOf([
            sent(0, 0, 1000),
            received(50, "1RTT", [], 0, 40),
            ev(80, "quic:packet_received", { header: { packet_type: "1RTT", packet_number: 1 }, frames: [] }),
        ]);
        expect(m.originalRangeX).toEqual([0, 60]);
    });
});

describe("packets_acked fallback (Q37, §9.14 #5)", () => {
    it("acks application_data PNs at the event time when no ACK frame exists", () => {
        const m = modelOf([
            sent(0, 0, 100),
            sent(1, 1, 100),
            sent(2, 2, 100),
            ev(9, "quic:packets_acked", { packet_numbers: [0, 1] }),
        ]);
        expect(m.usedPacketsAckedFallback).toBe(true);
        expect(ackedPns(m)).toEqual([0, 1]);
        expect(m.packets[0].ackT).toBe(9);
        expect(ackTooltip(m.packets[0]).packetNr).toBe("PacketNr:  ?");
    });

    it("honours packet_number_space", () => {
        const m = modelOf([
            sent(0, 0, 100, "initial"),
            sent(1, 0, 100, "1RTT"),
            ev(9, "quic:packets_acked", { packet_number_space: "initial", packet_numbers: [0] }),
        ]);
        expect(m.packets.map((p) => p.ackEvent !== undefined)).toEqual([true, false]);
    });

    it("is ignored when any ACK frame exists", () => {
        const m = modelOf([
            sent(0, 0, 100),
            sent(1, 1, 100),
            received(5, "1RTT", [ack([0])]),
            ev(9, "quic:packets_acked", { packet_numbers: [1] }),
        ]);
        expect(m.usedPacketsAckedFallback).toBe(false);
        expect(ackedPns(m)).toEqual([0]);
    });
});

describe("losses (§3.3(e), §9.14 #6)", () => {
    it("matches by PN space and PN (numbers or strings); the last loss wins", () => {
        const m = modelOf([
            sent(0, 0, 1000),
            sent(1, 4, 1200),
            ev(5, "quic:packet_lost", { header: { packet_type: "1RTT", packet_number: 0 } }),
            ev(6, "quic:packet_lost", { header: { packet_type: "1RTT", packet_number: "4" } }),
            ev(7, "quic:packet_lost", { header: { packet_type: "1RTT", packet_number: 0 } }),
            ev(8, "quic:packet_lost", {}),
            ev(8, "quic:packet_lost", { header: { packet_number: 4 } }),
            ev(8, "quic:packet_lost", { largest_lost_packet_num: 4, lost_bytes: 1200, lost_packets: 1 }),
        ]);
        expect(m.packets.map((p) => p.lossT)).toEqual([7, 6]);
        expect(m.skippedLost).toBe(3);
        // Q25: the size comes from the matched sent packet
        expect(lossTooltip(m.packets[1])).toEqual({
            timestamp: "Timestamp: 6",
            packetNr: "PacketNr: 1RTT 4",
            packetSize: ["PacketSize: 1200"],
            ackedFrom: "",
            ackedTo: "",
        });
    });
});

describe("metrics (§3.3(f), §9.14 #7)", () => {
    it("converts values, keeps zeros, ignores legacy cwnd and pto_count-only updates", () => {
        const m = modelOf([
            sent(0, 0, 1000),
            ev(1, "quic:recovery_metrics_updated", { congestion_window: "40960" }),
            ev(2, "quic:recovery_metrics_updated", { cwnd: 50000 }),
            ev(3, "quic:recovery_metrics_updated", { pto_count: 1 }),
            ev(4, "quic:recovery_metrics_updated", { bytes_in_flight: 0 }),
            ev(5, "quic:recovery_metrics_updated", { min_rtt: 40.2, smoothed_rtt: 41.1, latest_rtt: 40.205667 }),
        ]);
        // step series: rise from 0 at the first point, extend to xMax + 11
        expect(m.cwnd).toEqual([
            [1, 0],
            [1, 40960],
            [11, 40960],
        ]);
        expect(m.bytes).toEqual([
            [4, 0],
            [4, 0],
            [11, 0],
        ]);
        expect(m.minRTT[1]).toEqual([5, 40.2]);
        expect(m.maxRTT).toBe(41.1);
        expect(m.maxCongestionY).toBe(40960);
        expect(m.metricSamples.map((s) => s.t)).toEqual([1, 2, 3, 4, 5]);
    });

    it("feeds the sent-packet tooltip (Q11: also after the last update)", () => {
        const m = modelOf([
            ev(0, "quic:recovery_metrics_updated", { congestion_window: 40960, bytes_in_flight: 2456 }),
            ev(0, "quic:recovery_metrics_updated", { latest_rtt: 40.205667, smoothed_rtt: 41.1 }),
            sent(85.791083, 4, 1252),
        ]);
        expect(sentTooltip(m, m.packets[0])).toEqual({
            timestamp: "Timestamp: 85.791083",
            packetNr: "PacketNr: 1RTT 4",
            packetSize: [
                "PacketSize: 1252",
                "CWND: 40960 bytes",
                "In flight: 2456 bytes",
                "RTT: 40.205667 ms",
                "sRTT: 41.1 ms",
            ],
            ackedFrom: "",
            ackedTo: "",
        });
    });

    it("right-axis maximum only counts samples within the plotted x range (Q22)", () => {
        const m = modelOf([
            sent(0, 0, 1000),
            ev(5, "quic:recovery_metrics_updated", { congestion_window: 1000 }),
            ev(50, "quic:recovery_metrics_updated", { congestion_window: 99999 }),
        ]);
        expect(m.originalRangeX).toEqual([0, 10]);
        expect(m.maxCongestionY).toBe(1000);
        expect(findMetricUpdateExtrema(m.metricSamples, 0, 100)).toEqual([0, 99999, 0, 0]);
    });
});

describe("flow control (§3.3(a), (c), §9.14 #8, #9)", () => {
    it("only remote parameters (initiator, not owner) seed the lines; zero is a value", () => {
        const fc = (data: Json) => modelOf([sent(0, 0, 100), ev(1, "quic:parameters_set", data)]).fcApplication;
        expect(fc({ owner: "remote", initial_max_data: 100 })).toEqual([]);
        expect(fc({ initiator: "local", initial_max_data: 1 })).toEqual([]);
        expect(fc({ initiator: "remote", initial_max_data: "786432" })[1]).toEqual([1, 786432]);
        expect(fc({ initiator: "remote", initial_max_data: 0 })[1]).toEqual([1, 0]);
    });

    it('sums the latest MAX_STREAM_DATA per stream (4 and "4" are one stream)', () => {
        const m = modelOf([
            sent(0, 0, 100),
            ev(1, "quic:parameters_set", { initiator: "remote", initial_max_stream_data_bidi_remote: 524288 }),
            received(2, "1RTT", [{ frame_type: "max_stream_data", stream_id: 4, maximum: 1000 }]),
            received(3, "1RTT", [{ frame_type: "max_stream_data", stream_id: 8, maximum: 2000 }]),
            received(4, "1RTT", [{ frame_type: "max_stream_data", stream_id: "4", maximum: 3000 }]),
            received(5, "1RTT", [{ frame_type: "max_data", maximum: "abc" }]),
        ]);
        expect(m.fcStream.filter((_p, i) => i % 2 === 1).map((p) => p[1])).toEqual([524288, 1000, 3000, 5000]);
        expect(m.fcApplication).toEqual([]);
    });
});

describe("start offset (§3.2, Q1, §9.14 #10)", () => {
    it("case R: a first event beyond 3000 ms lands at 200 ms", () => {
        const dated = { common_fields: { reference_time: refTime("2026-11-01T00:00:00Z") } };
        expect(modelOf([sent(5000, 0, 100)], dated).startTimeOffset).toBe(-4800);
        expect(modelOf([sent(3001, 0, 100)], dated).startTimeOffset).toBe(-2801);
        const m = modelOf([sent(3000, 0, 100)], dated);
        expect(m.startTimeOffset).toBe(0);
        expect(m.packets[0].t).toBe(3000);
    });

    it("case U (monotonic clock) starts at 0", () => {
        const m = modelOf([sent(123456789.1, 0, 100)], {
            common_fields: { reference_time: refTime("unknown", "monotonic") },
        });
        expect(m.startTimeOffset).toBe(0);
        expect(m.packets[0].t).toBe(0);
    });
});

describe("names and namespaces (§9.1, §9.14 #1, #11)", () => {
    it("pre-final names are not consumed (Q41 rule 1)", () => {
        const m = modelOf([
            ev(0, "transport:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 0 },
                raw: { length: 1200 },
            }),
            ev(1, "recovery:metrics_updated", { congestion_window: 40960 }),
        ]);
        expect(m.packets).toEqual([]);
        expect(m.cwnd).toEqual([]);
        expect(congestionNotice(m)).toBe(
            "This trace has no quic:packet_sent events. It logs packets as transport:packet_sent, a pre-standard event name that qvis does not support, so there is nothing to plot.",
        );
        expect(m.initialRangeY).toEqual([0, 10]); // Q17
        expect(m.originalRangeX).toEqual([0, 10]);
    });

    it("notice rules 2 and 3", () => {
        expect(congestionNotice(modelOf([ev(0, "quic:connection_started", {})]))).toBe(
            "This trace has no quic:packet_sent events, so there is nothing to plot.",
        );
        expect(congestionNotice(modelOf([sent(0, 0, undefined)]))).toBe(
            "This trace has no quic:packet_sent events with a size (raw.length); there is nothing to plot.",
        );
    });

    it("converter TCP traces use the tcp namespace for packet events", () => {
        const m = modelOf(
            [0, 1, 2].map((i) =>
                ev(i, "tcp:packet_sent", { header: { packet_type: "1RTT", packet_number: i }, raw: { length: 100 } }),
            ),
            { common_fields: { protocol_type: "TCP_HTTP2" } },
        );
        expect(m.transportNamespace).toBe("tcp");
        expect(m.packets).toHaveLength(3);
        expect(ackedPns(m)).toEqual([]);
    });
});

describe("viewport helpers", () => {
    it("toStepSeries (§3.3(h))", () => {
        expect(toStepSeries([], 100)).toEqual([]);
        expect(
            toStepSeries(
                [
                    [5, 40960],
                    [12, 52000],
                ],
                1287.77,
            ),
        ).toEqual([
            [5, 0],
            [5, 40960],
            [12, 40960],
            [12, 52000],
            [1288.77, 52000],
        ]);
    });

    it("findYExtrema returns [Infinity, 0] for an empty window", () => {
        const m = modelOf([sent(0, 0, 100), sent(100, 1, 100)]);
        expect(findYExtrema(m, 0, 50)).toEqual([1, 100]);
        expect(findYExtrema(m, 40, 50)).toEqual([Infinity, 0]);
    });

    it("rttDomain: zooming off, on, carried step value and empty fallback (Q4)", () => {
        const m = modelOf([
            sent(0, 0, 100),
            ev(10, "quic:recovery_metrics_updated", { min_rtt: 40, smoothed_rtt: 50, latest_rtt: 60 }),
            ev(100, "quic:recovery_metrics_updated", { latest_rtt: 80 }),
        ]);
        expect(rttDomain(m, false, 0, 1)).toEqual([0, 80]);
        expect(rttDomain(m, true, 0, 200)).toEqual([30, 90]);
        // window without samples: the values carried into it count
        expect(rttDomain(m, true, 20, 30)).toEqual([30, 70]);
        // window with samples: only those count, exactly like qvis (the carried 40 / 50 / 60 are ignored)
        expect(rttDomain(m, true, 50, 200)).toEqual([70, 90]);
        // nothing before or inside the window: [0, maxRTT] fuzzed
        expect(rttDomain(m, true, 0, 5)).toEqual([0, 90]);
    });
});

// ------------------------------------------------------------------------------------------------ real fixtures

const LATEST = join(ROOT, "tests/fixtures/latest");
const latestFiles = existsSync(LATEST) ? readdirSync(LATEST).filter((f) => /\.s?qlog$/.test(f)) : [];

function loadFixture(name: string) {
    const group = QlogLoader.fromJSON(parseQlogText(readFileSync(join(LATEST, name), "utf8")), { filename: name });
    if (!group) throw new Error("could not load " + name);
    return group;
}

describe("real latest-draft fixtures", () => {
    it.each(latestFiles)("%s: builds a model for every trace without throwing", (name) => {
        for (const conn of loadFixture(name).getConnections()) {
            const m = buildCongestionModel(conn);
            for (let i = 1; i < m.packets.length; ++i) {
                expect(m.packets[i].from).toBe(m.packets[i - 1].to + 1);
            }
        }
    });

    const lossyServer = "congestion-lossy-server.sqlog";
    it.runIf(latestFiles.includes(lossyServer))("lossy server trace: key values", () => {
        const conn = loadFixture(lossyServer).getConnections()[0];
        const m = buildCongestionModel(conn);
        const sentEvents = conn.lookup("quic", "packet_sent");
        expect(m.sentEventCount).toBe(sentEvents.length);
        expect(m.skippedSent).toBe(0);
        expect(m.packets).toHaveLength(1924);
        const total = sentEvents.reduce((s, e) => s + Number(e.data.raw.length), 0);
        expect(m.packets[m.packets.length - 1].to).toBe(total);
        expect(m.originalRangeY).toEqual([0, total + 10]);
        expect(m.initialRangeY).toEqual([1, total]);
        expect(m.startTimeOffset).toBe(0);
        // every packet_lost names a sent packet
        expect(m.packets.filter((p) => p.lossT !== undefined)).toHaveLength(178);
        expect(m.skippedLost).toBe(0);
        expect(m.packets.filter((p) => p.ackT !== undefined).length).toBeGreaterThan(1500);
        expect(m.cwnd.length).toBeGreaterThan(0);
        expect(m.maxRTT).toBeGreaterThan(60);
        // peer's initial_max_data seeds the connection flow-control line
        expect(m.fcApplication[1][1]).toBe(786432);
        expect(congestionNotice(m)).toBeUndefined();
    });
});
