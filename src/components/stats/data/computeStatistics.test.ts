// @vitest-environment node
/// <reference types="node" />
// parity/statistics.md §8.5 (unit) and §9.15 (latest-draft mapping): golden vector §3.14, progress labels, staggered
// console series, edge cases §6.2, strict names (modes A/B/C), NEW rows, and real generated latest-draft files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnection } from "@/model/QlogConnection";
import { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { parseQlogText } from "@/qlog/parse";
import {
    computeFileStats,
    computeH3Headers,
    computeQuicIdentity,
    computeTraceStats,
    createStaggeredLines,
    displayValue,
    fieldName,
    fieldValue,
    getTraceStats,
    hexToLatin1,
    progressLabel,
    staggeredSeriesMessages,
    type FCSeries,
    type TraceStats,
} from "./computeStatistics";

type Json = Record<string, any>;

const ROOT = join(__dirname, "../../../..");
const FIXTURES = join(__dirname, "../__fixtures__");

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function loadText(text: string, filename = "test.qlog"): QlogConnectionGroup {
    const g = QlogLoader.fromJSON(parseQlogText(text), { filename });
    if (!g) throw new Error("could not load " + filename);
    return g;
}

function loadPath(path: string): QlogConnectionGroup {
    return loadText(readFileSync(path, "utf8"), path.slice(path.lastIndexOf("/") + 1));
}

/** One-trace contained file with the given events (times default to the array index). */
function traceOf(events: Array<[name: string, data: unknown]>, traceExtra: Json = {}): QlogConnection {
    const root = {
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        traces: [
            {
                event_schemas: ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"],
                vantage_point: { type: "client" },
                ...traceExtra,
                events: events.map(([name, data], i) => ({ time: i, name, data })),
            },
        ],
    };
    return loadText(JSON.stringify(root)).getConnections()[0];
}

const series = (s: FCSeries) => s.values;
const mapValues = (m: Map<string, FCSeries>) => [...m].map(([k, s]) => [k, s.values] as const);
const lookupCounts = (c: QlogConnection) =>
    [...c.getLookupTable()].map(([ns, types]) => [ns, [...types].map(([t, evs]) => [t, evs.length])]);

describe("golden vector (spec §3.14)", () => {
    let group: QlogConnectionGroup;
    let conn: QlogConnection;
    let s: TraceStats;

    beforeAll(() => {
        group = loadPath(join(FIXTURES, "stats-basic.qlog"));
        conn = group.getConnections()[0];
        s = computeTraceStats(conn);
    });

    it("file info", () => {
        expect(group.title).toBe("stats fixture");
        expect(group.version).toBe("urn:ietf:params:qlog:file:contained");
        expect(group.serializationFormat).toBe("application/qlog+json");
        const f = computeFileStats(group);
        expect(f.traceCount).toBe(1);
        expect(f.totalEventCount).toBe(10);
    });

    it("trace labels", () => {
        expect(conn.title).toBe("T");
        expect(conn.vantagePoint).toEqual({ type: "client" });
        expect(conn.eventSchemas).toEqual([
            "urn:ietf:params:qlog:events:quic-13",
            "urn:ietf:params:qlog:events:http3-13",
        ]);
    });

    it("events histogram (lookup table, first-seen order)", () => {
        expect(s.eventCount).toBe(10);
        expect(lookupCounts(conn)).toEqual([
            [
                "quic",
                [
                    ["parameters_set", 3],
                    ["packet_sent", 2],
                    ["packet_received", 2],
                ],
            ],
            [
                "http3",
                [
                    ["frame_created", 1],
                    ["frame_parsed", 1],
                ],
            ],
            ["loglevel", [["info", 1]]],
        ]);
        expect(progressLabel(3, 10)).toBe("30.00");
        expect(progressLabel(2, 10)).toBe("20.00");
        expect(progressLabel(1, 10)).toBe("10.00");
    });

    it("frames", () => {
        expect(s.frameCount).toBe(10);
        expect(s.frames).toEqual([
            ["crypto", 2],
            ["padding", 1],
            ["ack", 1],
            ["headers", 2],
            ["stream", 1],
            ["max_data", 1],
            ["max_stream_data", 2],
        ]);
    });

    it("encryption levels", () => {
        expect(s.encryptionLevels).toEqual([
            ["initial", 2],
            ["1RTT", 2],
        ]);
    });

    it("connection-level flow control (FIX Q4: no NaN for the tls_cipher-only parameters_set)", () => {
        expect(series(s.connectionFC.local)).toEqual([1000, 2000]);
        expect(s.connectionFC.local.times).toEqual([0, 9]);
        expect(series(s.connectionFC.remote)).toEqual([5000]);
    });

    it("stream-level flow control", () => {
        expect(mapValues(s.streamFC.local)).toEqual([
            ["bidi_local", [100]],
            ["bidi_remote", [200]],
            ["uni_remote", [300]],
            ["3", [150]],
        ]);
        expect(mapValues(s.streamFC.remote)).toEqual([
            ["bidi_local", [400]],
            ["0", [7000]],
        ]);
    });

    it("H3 connection headers (literal values, last write wins)", () => {
        expect(s.h3).toEqual({ userAgent: "ua/1", server: "<b>srv</b>", authority: "example.org" });
    });

    it("NEW rows hidden without version / ALPN events", () => {
        expect(s.quicVersion).toBeUndefined();
        expect(s.alpn).toBeUndefined();
        expect("quicVersion" in s).toBe(false);
    });

    it("console series", () => {
        const msgs = staggeredSeriesMessages(s, 0);
        expect(msgs).toContainEqual(["Connection-level FC TIMES for local viewpoint of Trace 0: ", "0;9;9;209;"]);
        expect(msgs).toContainEqual(["Connection-level FC for local viewpoint of Trace 0: ", "1000;1000;2000;2000;"]);
        // order verified on hosted qvis: connection-level local, connection-level remote, stream remote, stream local
        expect(msgs.map((m) => m[0])).toEqual([
            "Connection-level FC TIMES for local viewpoint of Trace 0: ",
            "Connection-level FC for local viewpoint of Trace 0: ",
            "Connection-level FC TIMES for remote viewpoint of Trace 0: ",
            "Connection-level FC for remote viewpoint of Trace 0: ",
            "Stream-level FC TIMES for remote viewpoint of Trace 0, stream bidi_local: ",
            "Stream-level FC for remote viewpoint of Trace 0, stream bidi_local: ",
            "Stream-level FC TIMES for remote viewpoint of Trace 0, stream 0: ",
            "Stream-level FC for remote viewpoint of Trace 0, stream 0: ",
            "Stream-level FC TIMES for local viewpoint of Trace 0, stream bidi_local: ",
            "Stream-level FC for local viewpoint of Trace 0, stream bidi_local: ",
            "Stream-level FC TIMES for local viewpoint of Trace 0, stream bidi_remote: ",
            "Stream-level FC for local viewpoint of Trace 0, stream bidi_remote: ",
            "Stream-level FC TIMES for local viewpoint of Trace 0, stream uni_remote: ",
            "Stream-level FC for local viewpoint of Trace 0, stream uni_remote: ",
            "Stream-level FC TIMES for local viewpoint of Trace 0, stream 3: ",
            "Stream-level FC for local viewpoint of Trace 0, stream 3: ",
        ]);
    });
});

describe("progressLabel (bootstrap-vue computedProgress, precision 2)", () => {
    it.each([
        [18, 34, "52.94"],
        [1, 34, "2.94"],
        [3, 10, "30.00"],
        [1, 1549, "0.06"],
        [1, 3, "33.33"],
        [10, 10, "100.00"],
        // bootstrap-vue rounds with Math.round before toFixed: these differ from a plain toFixed(2)
        [3, 4000, "0.08"],
        [101, 4000, "2.53"],
        [201, 20000, "1.01"],
    ])("%i / %i -> %s", (v, m, label) => {
        expect(progressLabel(v, m)).toBe(label);
    });
});

describe("createStaggeredLines", () => {
    it("empty input (qvis quirk: null + 200)", () => {
        expect(createStaggeredLines([], [])).toEqual(["200;", "null;"]);
    });
    it("two points, decimal comma", () => {
        expect(createStaggeredLines([1.5, 3], [100, 200])).toEqual(["1,5;3;3;203;", "100;100;200;200;"]);
    });
    it("single point", () => {
        expect(createStaggeredLines([2], [7])).toEqual(["2;202;", "7;7;"]);
    });
    it("only the first '.' is replaced, NaN kept", () => {
        expect(createStaggeredLines([0.25], [NaN])).toEqual(["0,25;200,25;", "NaN;NaN;"]);
    });
});

describe("getTraceStats cache and console output", () => {
    it("caches per connection and logs the series once", () => {
        const c = traceOf([["quic:parameters_set", { initiator: "local", initial_max_data: 5 }]]);
        const debug = vi.mocked(console.debug);
        debug.mockClear();
        const a = getTraceStats(c, 3);
        const b = getTraceStats(c, 3);
        expect(a).toBe(b);
        expect(debug).toHaveBeenCalledWith("Connection-level FC TIMES for local viewpoint of Trace 3: ", "0;200;");
        expect(debug).toHaveBeenCalledWith("Connection-level FC for local viewpoint of Trace 3: ", "5;5;");
        expect(debug).toHaveBeenCalledTimes(4); // remote + local connection-level, no stream keys
    });

    it("clones (sequence diagram) get their own entry", () => {
        const c = traceOf([
            ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [{ frame_type: "ping" }] }],
        ]);
        const clone = c.clone((ev) => ({
            namespace: ev.namespace,
            type: ev.type === "packet_sent" ? "packet_received" : ev.type,
        }));
        clone.wasAutoGenerated = true;
        expect(getTraceStats(clone)).not.toBe(getTraceStats(c));
        expect(getTraceStats(clone).frames).toEqual([["ping", 1]]);
        // generated traces are excluded from the file stats
        const f = computeFileStats(c.parent);
        expect(f.traceCount).toBe(1);
        expect(f.traces).toEqual([c]);
        expect(f.totalEventCount).toBe(1);
    });
});

describe("edge cases (spec §6.2, §8.5 #4)", () => {
    it("a group without connections (gaps G10 / addendum T1: hand-built, files without traces are rejected)", () => {
        const f = computeFileStats(new QlogConnectionGroup());
        expect(f.traces).toEqual([]);
        expect(f.traceCount).toBe(0);
        expect(f.totalEventCount).toBe(0);
    });

    it("non-array frames and null frames do not throw and are not counted", () => {
        const c = traceOf([
            ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: {} }],
            ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [null, { frame_type: "ping" }] }],
            ["quic:packet_received", { header: { packet_type: "1RTT" }, frames: "abc" }],
        ]);
        const s = computeTraceStats(c);
        expect(s.frameCount).toBe(1);
        expect(s.frames).toEqual([["ping", 1]]);
        expect(s.encryptionLevels).toEqual([["1RTT", 3]]);
    });

    it("frame without frame_type gives an undefined key (empty cell)", () => {
        const c = traceOf([["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [{ length: 3 }] }]]);
        const s = computeTraceStats(c);
        expect(s.frames).toEqual([[undefined, 1]]);
        expect(displayValue(s.frames[0][0])).toBe("");
    });

    it("QUIC unknown + HTTP/3 unknown share one row (S19); new frame types get their own rows", () => {
        const c = traceOf([
            [
                "quic:packet_received",
                { header: { packet_type: "1RTT" }, frames: [{ frame_type: "unknown", frame_type_bytes: 64 }] },
            ],
            ["http3:frame_parsed", { stream_id: 0, frame: { frame_type: "unknown", frame_type_bytes: 33 } }],
            [
                "quic:packet_sent",
                {
                    header: { packet_type: "1RTT" },
                    frames: [
                        { frame_type: "reset_stream_at" },
                        { frame_type: "handshake_done" },
                        { frame_type: "datagram" },
                    ],
                },
            ],
            ["http3:frame_created", { stream_id: 0, frame: { frame_type: "origin" } }],
        ]);
        const s = computeTraceStats(c);
        expect(s.frames).toEqual([
            ["unknown", 2],
            ["reset_stream_at", 1],
            ["handshake_done", 1],
            ["datagram", 1],
            ["origin", 1],
        ]);
        expect(s.frameCount).toBe(6);
    });

    it("capsules and datagrams are listed as events but not counted as frames (§9.15 #6)", () => {
        const c = traceOf([
            ["http:capsule_parsed", { stream_id: 0, capsule: { capsule_type: "datagram" } }],
            ["http3:datagram_parsed", { quarter_stream_id: 0 }],
        ]);
        const s = computeTraceStats(c);
        expect(s.frameCount).toBe(0);
        expect(s.frames).toEqual([]);
        expect([...c.getLookupTable().keys()]).toEqual(["http", "http3"]);
    });

    it("packet types of all packet events are counted (§9.15 #7)", () => {
        const c = traceOf([
            ["quic:packet_dropped", { header: { packet_type: "handshake" } }],
            ["quic:packet_buffered", {}],
            ["quic:packet_lost", { header: { packet_type: "1RTT", packet_number: 3 } }],
            ["quic:packet_sent", { header: { packet_type: "unknown", packet_type_bytes: 7 } }],
            ["quic:packet_sent", { header: { packet_type: "" } }],
        ]);
        expect(computeTraceStats(c).encryptionLevels).toEqual([
            ["handshake", 1],
            ["1RTT", 1],
            ["unknown", 1],
        ]);
    });

    it("tcp packets count as 1RTT, TLS records without packet_type do not (§9.15 #8, S20)", () => {
        const c = traceOf([
            ["tcp:packet_sent", { header: { packet_type: "1RTT" } }],
            ["tls:record_created", { header: { content_type: "application" } }],
        ]);
        expect(computeTraceStats(c).encryptionLevels).toEqual([["1RTT", 1]]);
    });

    it("parameters_set without initial_max_* adds nothing (FIX Q4)", () => {
        const c = traceOf([["quic:parameters_set", { initiator: "local", tls_cipher: "x" }]]);
        const s = computeTraceStats(c);
        expect(s.connectionFC.local.values).toEqual([]);
        expect(s.streamFC.local.size).toBe(0);
    });

    it("MAX_DATA / MAX_STREAM_DATA without maximum give NaN (PARITY), missing stream_id the key 'undefined'", () => {
        const c = traceOf([
            ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [{ frame_type: "max_data" }] }],
            [
                "quic:packet_sent",
                { header: { packet_type: "1RTT" }, frames: [{ frame_type: "max_stream_data", maximum: 4 }] },
            ],
        ]);
        const s = computeTraceStats(c);
        expect(s.connectionFC.local.values).toEqual([NaN]);
        expect(mapValues(s.streamFC.local)).toEqual([["undefined", [4]]]);
    });

    it("cumulative parameters: a later parameters_set replaces only its keys, positions kept (§9.15 #11)", () => {
        const c = traceOf([
            [
                "quic:parameters_set",
                {
                    initiator: "remote",
                    initial_max_stream_data_bidi_local: 1,
                    initial_max_stream_data_bidi_remote: 2,
                    initial_max_stream_data_uni: 3,
                },
            ],
            ["quic:parameters_set", { initiator: "remote", initial_max_stream_data_uni: 7 }],
        ]);
        expect(mapValues(computeTraceStats(c).streamFC.remote)).toEqual([
            ["bidi_local", [1]],
            ["bidi_remote", [2]],
            ["uni_remote", [7]],
        ]);
    });

    it("string and numeric stream ids merge (§9.15 #12)", () => {
        const c = traceOf([
            [
                "quic:packet_sent",
                {
                    header: { packet_type: "1RTT" },
                    frames: [{ frame_type: "max_stream_data", stream_id: "4", maximum: "100" }],
                },
            ],
            [
                "quic:packet_sent",
                {
                    header: { packet_type: "1RTT" },
                    frames: [{ frame_type: "max_stream_data", stream_id: 4, maximum: 200 }],
                },
            ],
        ]);
        expect(mapValues(computeTraceStats(c).streamFC.local)).toEqual([["4", [100, 200]]]);
    });

    it("parameters_set events and MAX_DATA updates interleave in event order", () => {
        const c = traceOf([
            [
                "quic:packet_received",
                { header: { packet_type: "1RTT" }, frames: [{ frame_type: "max_data", maximum: 9 }] },
            ],
            ["quic:parameters_set", { initiator: "remote", initial_max_data: 3 }],
            [
                "quic:packet_received",
                { header: { packet_type: "1RTT" }, frames: [{ frame_type: "max_data", maximum: 12 }] },
            ],
        ]);
        const s = computeTraceStats(c);
        expect(s.connectionFC.remote.values).toEqual([9, 3, 12]);
        expect(s.connectionFC.remote.times).toEqual([0, 1, 2]);
        expect(s.connectionFC.local.values).toEqual([]);
    });
});

describe("strict latest-draft names (spec §9.1, §9.15)", () => {
    it("#1 quic-go pre-final names: listed, but neither shape-counted nor used for flow control", () => {
        const c = traceOf([
            ["transport:parameters_set", { initiator: "local", initial_max_data: 1000 }],
            [
                "transport:packet_sent",
                { header: { packet_type: "1RTT" }, frames: [{ frame_type: "max_data", maximum: 2000 }] },
            ],
        ]);
        const s = computeTraceStats(c);
        expect(lookupCounts(c)).toEqual([
            [
                "transport",
                [
                    ["parameters_set", 1],
                    ["packet_sent", 1],
                ],
            ],
        ]);
        // strict latest drafts (DM3: "the visualizations do not interpret these events"): deviation from spec S16
        expect(s.frameCount).toBe(0);
        expect(s.frames).toEqual([]);
        expect(s.encryptionLevels).toEqual([]);
        expect(s.connectionFC.local.values).toEqual([]);
        expect(s.connectionFC.remote.values).toEqual([]);
        expect(s.streamFC.local.size).toBe(0);
        expect(s.streamFC.remote.size).toBe(0);
    });

    it("only latest-draft and private-namespace names feed the frame / packet-type counts", () => {
        const frames = { header: { packet_type: "1RTT" }, frames: [{ frame_type: "ping" }] };
        const c = traceOf([
            ["quic:packet_sent", frames], // latest: counted
            ["quic:datagram_dropped", frames], // quic namespace, type not in quic-events-13 (DM3): not counted
            ["recovery:packet_lost", frames], // pre-final category (DM3): not counted
            ["packet_sent", frames], // no namespace: not counted
            ["mvfst:packet_sent", frames], // private namespace (main-schema §8): counted
            ["http:frame_created", { frame: { frame_type: "headers" } }], // pre-final HTTP/3 name (DM3)
            ["http3:frame_created", { frame: { frame_type: "headers" } }], // latest: counted
        ]);
        const s = computeTraceStats(c);
        expect(s.frames).toEqual([
            ["ping", 2],
            ["headers", 1],
        ]);
        expect(s.frameCount).toBe(3);
        expect(s.encryptionLevels).toEqual([["1RTT", 2]]);
        // all of them are still listed in the Events histogram
        expect([...c.getLookupTable().keys()]).toEqual(["quic", "recovery", "unknown", "mvfst", "http", "http3"]);
        // an event without a valid name is not interpreted either
        const root = {
            file_schema: "urn:ietf:params:qlog:file:contained",
            serialization_format: "application/qlog+json",
            traces: [{ vantage_point: { type: "client" }, events: [{ time: 0, data: frames }] }],
        };
        const noName = computeTraceStats(loadText(JSON.stringify(root)).getConnections()[0]);
        expect(noName.frameCount).toBe(0);
        expect(noName.encryptionLevels).toEqual([]);
    });

    it("a pre-final namespace declared by the trace's event_schemas is not DM3 and is counted", () => {
        const c = traceOf(
            [["transport:packet_sent", { header: { packet_type: "initial" }, frames: [{ frame_type: "ack" }] }]],
            {
                event_schemas: ["urn:ietf:params:qlog:events:transport"],
            },
        );
        expect(c.parent.diagnostics.some((d) => d.code === "event.nonconforming-name")).toBe(false);
        const s = computeTraceStats(c);
        expect(s.frames).toEqual([["ack", 1]]);
        expect(s.encryptionLevels).toEqual([["initial", 1]]);
        // still not a latest-draft packet event: no flow control (mode C)
        expect(s.connectionFC.local.values).toEqual([]);
    });

    it("#2 draft-02 `owner` is not read", () => {
        const c = traceOf([["quic:parameters_set", { owner: "local", initial_max_data: 5 }]]);
        const s = computeTraceStats(c);
        expect(s.connectionFC.local.values).toEqual([]);
        expect(s.connectionFC.remote.values).toEqual([]);
    });

    it("#3 frames_parsed frames count as frames but do not feed flow control (N3 not adopted)", () => {
        const c = traceOf([["quic:frames_parsed", { frames: [{ frame_type: "max_data", maximum: 9 }] }]]);
        const s = computeTraceStats(c);
        expect(s.frames).toEqual([["max_data", 1]]);
        expect(s.connectionFC.remote.values).toEqual([]);
    });

    it("#4 parameters_restored does not feed flow control (N8 not adopted)", () => {
        const c = traceOf([["quic:parameters_restored", { initial_max_data: 5 }]]);
        const s = computeTraceStats(c);
        expect(s.connectionFC.local.values).toEqual([]);
        expect(s.connectionFC.remote.values).toEqual([]);
        expect(lookupCounts(c)).toEqual([["quic", [["parameters_restored", 1]]]]);
    });

    it("#9 H3 row only from http3:frame_*; name_bytes / value_bytes decoded", () => {
        const pre = traceOf([
            [
                "http:frame_created",
                { stream_id: 0, frame: { frame_type: "headers", headers: [{ name: "user-agent", value: "x" }] } },
            ],
        ]);
        expect(computeH3Headers(pre)).toBeUndefined();
        expect(computeTraceStats(pre).frames).toEqual([]); // pre-final name: listed only, not interpreted

        const ok = traceOf([
            [
                "http3:frame_created",
                { stream_id: 0, frame: { frame_type: "headers", headers: [{ name: "user-agent", value: "x" }] } },
            ],
        ]);
        expect(computeH3Headers(ok)).toEqual({ userAgent: "x", server: undefined, authority: undefined });

        const bytes = traceOf([
            [
                "http3:frame_created",
                {
                    stream_id: 0,
                    frame: {
                        frame_type: "headers",
                        headers: [{ name_bytes: "3a617574686f72697479", value_bytes: "6578616d706c652e6f7267" }],
                    },
                },
            ],
        ]);
        expect(computeH3Headers(bytes)?.authority).toBe("example.org");
    });

    it("H3: created first, then parsed; valueless header resets; PUSH_PROMISE counts; empty UA kept", () => {
        const c = traceOf([
            [
                "http3:frame_parsed",
                { stream_id: 0, frame: { frame_type: "headers", headers: [{ name: "server", value: "late" }] } },
            ],
            [
                "http3:frame_created",
                {
                    stream_id: 0,
                    frame: {
                        frame_type: "push_promise",
                        push_id: 1,
                        headers: [
                            { name: ":authority", value: "a" },
                            { name: "server", value: "first" },
                        ],
                    },
                },
            ],
            [
                "http3:frame_created",
                { stream_id: 4, frame: { frame_type: "headers", headers: [{ name: "user-agent", value: "" }] } },
            ],
            ["http3:frame_parsed", { stream_id: 4, frame: { frame_type: "headers", headers: [{ name: "server" }] } }],
            ["http3:frame_parsed", { stream_id: 8 }],
            ["http3:frame_parsed", { stream_id: 8, frame: { frame_type: "data" } }],
            ["http3:frame_parsed", { stream_id: 8, frame: { frame_type: "headers", headers: "nope" } }],
            ["http3:frame_parsed", { stream_id: 8, frame: { frame_type: "headers", headers: [null, 3] } }],
        ]);
        // order: created (first, ""), then parsed (late, then valueless -> undefined)
        expect(computeH3Headers(c)).toEqual({ userAgent: "", server: undefined, authority: "a" });
    });

    it("H3: a lone valueless header hides the row", () => {
        const c = traceOf([
            ["http3:frame_parsed", { stream_id: 0, frame: { frame_type: "headers", headers: [{ name: "server" }] } }],
        ]);
        expect(computeH3Headers(c)).toBeUndefined();
    });

    it("#10 NEW rows: QUIC version and ALPN (last chosen wins)", () => {
        const c = traceOf([
            ["quic:version_information", { client_versions: ["00000001"], chosen_version: "00000001" }],
            ["quic:alpn_information", { client_alpns: [{ string_value: "h3" }] }],
            ["quic:version_information", { chosen_version: "6b3343cf" }],
            ["quic:alpn_information", { chosen_alpn: { byte_value: "6833" } }],
        ]);
        expect(computeQuicIdentity(c)).toEqual({ quicVersion: "6b3343cf", alpn: "h3" });
        const s = computeTraceStats(c);
        expect(s.quicVersion).toBe("6b3343cf");
        expect(s.alpn).toBe("h3");

        const pre = traceOf([["transport:alpn_information", { chosen_alpn: { string_value: "h3" } }]]);
        expect(computeQuicIdentity(pre)).toEqual({});
        expect(computeTraceStats(traceOf([])).alpn).toBeUndefined();
    });
});

describe("helpers", () => {
    it("hexToLatin1 / fieldName / fieldValue", () => {
        expect(hexToLatin1("6833")).toBe("h3");
        expect(hexToLatin1(undefined)).toBeUndefined();
        expect(fieldName({ name: "a", name_bytes: "62" })).toBe("a");
        expect(fieldName({ name_bytes: "62" })).toBe("b");
        expect(fieldValue({ name: "a" })).toBeUndefined();
        expect(fieldValue({ value_bytes: "6869" })).toBe("hi");
        // h3 digest §8.1 uses `??`: a null text member falls back to the bytes member
        expect(fieldName({ name: null, name_bytes: "62" })).toBe("b");
        expect(fieldValue({ name: "a", value: null, value_bytes: "6869" })).toBe("hi");
        expect(fieldValue({ name: "a", value: null })).toBeUndefined();
    });

    it("displayValue mirrors Vue mustache interpolation", () => {
        expect(displayValue(undefined)).toBe("");
        expect(displayValue(null)).toBe("");
        expect(displayValue(0)).toBe("0");
        expect(displayValue("x")).toBe("x");
        expect(displayValue([1])).toBe("[\n  1\n]");
        expect(displayValue({ a: 1 })).toBe('{\n  "a": 1\n}');
        expect(displayValue(Object.create(null))).toBe("{}");
    });
});

describe("real generated latest-draft files", () => {
    const dirs = [join(ROOT, "tests/fixtures/latest"), join(ROOT, "public/examples"), FIXTURES];
    const files = dirs
        .filter((d) => existsSync(d))
        .flatMap((d) =>
            readdirSync(d)
                .filter((f) => /\.s?qlog$/.test(f))
                .map((f) => join(d, f)),
        );

    it.each(files)("%s: computes without throwing", (path) => {
        const g = loadPath(path);
        const f = computeFileStats(g);
        expect(f.traceCount).toBe(g.getRealConnections().length);
        for (const c of f.traces) {
            const s = computeTraceStats(c);
            expect(s.eventCount).toBe(c.getEvents().length);
            expect(s.frames.reduce((n, [, k]) => n + k, 0)).toBe(s.frameCount);
            for (const fcs of [
                s.connectionFC.local,
                s.connectionFC.remote,
                ...s.streamFC.local.values(),
                ...s.streamFC.remote.values(),
            ]) {
                expect(fcs.values.length).toBe(fcs.times.length);
                for (const v of fcs.values) expect(Number.isNaN(v)).toBe(false);
            }
            staggeredSeriesMessages(s, 0);
        }
    });

    it("stats-newcid_client.sqlog: key values", () => {
        const g = loadPath(join(ROOT, "tests/fixtures/latest/stats-newcid_client.sqlog"));
        expect(g.version).toBe("urn:ietf:params:qlog:file:sequential");
        expect(g.serializationFormat).toBe("application/qlog+json-seq");
        const [c] = g.getRealConnections();
        const s = computeTraceStats(c);
        expect(s.eventCount).toBe(84);
        expect(s.encryptionLevels.map(([t]) => t)).toEqual(["initial", "handshake", "1RTT"]);
        expect(s.encryptionLevels.reduce((n, [, k]) => n + k, 0)).toBe(
            c.lookup("quic", "packet_sent").length + c.lookup("quic", "packet_received").length,
        );
        expect(s.frames.map(([t]) => t)).toContain("headers");
        expect(s.quicVersion).toBe("00000001");
        expect(s.alpn).toBe("h3");
        expect(s.h3).toBeDefined();
        expect(s.h3!.authority).toEqual(expect.any(String));
        expect(s.h3!.userAgent).toEqual(expect.any(String));
        // quic-go logs its own transport parameters (initiator local) and the peer's (remote)
        expect(s.connectionFC.local.values.length).toBeGreaterThan(0);
        expect(s.connectionFC.remote.values.length).toBeGreaterThan(0);
        expect([...s.streamFC.local.keys()].slice(0, 3)).toEqual(["bidi_local", "bidi_remote", "uni_remote"]);
        expect([...s.streamFC.remote.keys()].slice(0, 3)).toEqual(["bidi_local", "bidi_remote", "uni_remote"]);
    });

    it("stats-allevents_client.sqlog: MAX_DATA / MAX_STREAM_DATA frames feed flow control", () => {
        const g = loadPath(join(FIXTURES, "stats-allevents_client.sqlog"));
        const s = computeTraceStats(g.getRealConnections()[0]);
        const maxData = s.frames.find(([t]) => t === "max_data")![1];
        const sentOrReceivedMaxData = g
            .getRealConnections()[0]
            .getEvents()
            .filter((e) => e.namespace === "quic" && (e.type === "packet_sent" || e.type === "packet_received"))
            .flatMap((e) => (Array.isArray(e.data.frames) ? e.data.frames : []))
            .filter((fr: Json) => fr.frame_type === "max_data").length;
        expect(maxData).toBeGreaterThanOrEqual(sentOrReceivedMaxData);
        const params = g
            .getRealConnections()[0]
            .lookup("quic", "parameters_set")
            .filter((e) => e.data.initial_max_data !== undefined).length;
        expect(s.connectionFC.local.values.length + s.connectionFC.remote.values.length).toBe(
            sentOrReceivedMaxData + params,
        );
    });

    it.each(
        existsSync(join(ROOT, "tests/fixtures/nonconforming"))
            ? readdirSync(join(ROOT, "tests/fixtures/nonconforming")).filter((f) => f.endsWith(".sqlog"))
            : [],
    )("non-conforming quic-go output %s: listed under transport, nothing interpreted (§9.13)", (file) => {
        const g = loadPath(join(ROOT, "tests/fixtures/nonconforming", file));
        expect(g.diagnostics.some((d) => d.code === "event.nonconforming-name")).toBe(true);
        const c = g.getRealConnections()[0];
        const s = computeTraceStats(c);
        expect([...c.getLookupTable().keys()]).toContain("transport");
        // every frame / packet type of these files sits in transport:* / recovery:* events
        expect(s.frameCount).toBe(0);
        expect(s.encryptionLevels).toEqual([]);
        expect(s.connectionFC.local.values).toEqual([]);
        expect(s.connectionFC.remote.values).toEqual([]);
        expect(s.streamFC.local.size + s.streamFC.remote.size).toBe(0);
        expect(s.quicVersion).toBeUndefined();
        expect(s.alpn).toBeUndefined();
    });
});
