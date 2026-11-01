import { parseQlogText } from "@/qlog/parse";
import {
    DATED_EPOCH,
    DATED_EPOCH_MS,
    ev,
    file,
    HTTP3_13,
    loaded,
    QUIC_13,
    refTime,
    trace,
    type Json,
} from "./__fixtures__/qlog";
import { modelEvents } from "./modelEvents";
import type { QlogConnectionGroup } from "./QlogConnectionGroup";
import { QlogLoader } from "./QlogLoader";
import { TimeTrackingMethod } from "./time";

function load(root: Json, fileInfo?: { filename?: string; URL?: string }): QlogConnectionGroup {
    const g = QlogLoader.fromJSON(loaded(root), fileInfo);
    if (!g) throw new Error("fromJSON returned undefined");
    return g;
}
function codes(g: QlogConnectionGroup): string[] {
    return g.diagnostics.map((d) => d.code);
}
/** non-info diagnostic codes (info = P14 schema hints etc.) */
function warnings(g: QlogConnectionGroup): string[] {
    return g.diagnostics.filter((d) => d.level !== "info").map((d) => d.code);
}
function diag(g: QlogConnectionGroup, code: string) {
    return g.diagnostics.find((d) => d.code === code);
}

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("QlogLoader.fromJSON: group", () => {
    it("copies header fields; version/format are the file schema / media type; summary stays empty", () => {
        const g = load(
            file([trace([ev(1, "quic:packet_sent")])], {
                title: "My title",
                description: "some description",
                serialization_format: "Application/QLOG+json",
            }),
            { filename: "a.qlog", URL: "https://x/a.qlog" },
        );
        expect(g.fileSchema).toBe("urn:ietf:params:qlog:file:contained");
        expect(g.version).toBe("urn:ietf:params:qlog:file:contained");
        expect(g.serializationFormat).toBe("application/qlog+json");
        expect(g.format).toBe("application/qlog+json");
        expect(g.serialization).toBe("json");
        expect(g.title).toBe("My title");
        expect(g.description).toBe("some description");
        expect(g.summary).toEqual({});
        expect(g.filename).toBe("a.qlog");
        expect(g.URL).toBe("https://x/a.qlog");
        expect(g.URLshort).toBe("");
        expect(g.eventSchemas).toEqual([QUIC_13]);
        expect(g.diagnostics).toEqual([]);
    });

    it("sequential files end to end (parseQlogText -> fromJSON)", () => {
        const RS = "\u001e";
        const header = {
            file_schema: "urn:ietf:params:qlog:file:sequential",
            serialization_format: "application/qlog+json-seq",
            trace: { vantage_point: { type: "server" }, event_schemas: [QUIC_13, HTTP3_13] },
        };
        const text = [header, ev(1, "quic:packet_sent"), ev(2, "http3:frame_created")]
            .map((r) => RS + JSON.stringify(r) + "\n")
            .join("");
        const g = QlogLoader.fromJSON(parseQlogText(text))!;
        expect(g.serialization).toBe("json-seq");
        expect(g.fileSchema).toBe("urn:ietf:params:qlog:file:sequential");
        expect(g.format).toBe("application/qlog+json-seq");
        const [c] = g.getConnections();
        expect(c.vantagePoint).toEqual({ type: "server" });
        expect(c.getEvents().map((e) => e.fullName)).toEqual(["quic:packet_sent", "http3:frame_created"]);
        expect(g.diagnostics).toEqual([]);
    });

    it("merges parse diagnostics", () => {
        const l = loaded(file([trace([ev(1, "quic:packet_sent")])]));
        l.diagnostics = [{ level: "warning", code: "json.truncated-recovered", message: "m", count: 1 }];
        expect(codes(QlogLoader.fromJSON(l)!)).toEqual(["json.truncated-recovered"]);
    });

    it("returns undefined (never throws) for unusable roots", () => {
        expect(QlogLoader.fromJSON(loaded([] as unknown as Json))).toBeUndefined();
        expect(QlogLoader.fromJSON({ root: null, serialization: "json", diagnostics: [] } as any)).toBeUndefined();
        expect(QlogLoader.fromJSON(loaded({ file_schema: "x" }))).toBeUndefined();
        expect(QlogLoader.fromJSON(loaded({ qlog_version: "0.3", traces: [] }))).toBeUndefined();
        expect(QlogLoader.fromJSON(undefined as any)).toBeUndefined();
    });

    it("accepts a non-normalized sequential root (trace object) and empty traces", () => {
        const g = load({
            file_schema: "urn:ietf:params:qlog:file:sequential",
            trace: { events: [ev(1, "quic:packet_sent")] },
        });
        expect(g.getConnections()).toHaveLength(1);
        expect(g.fileSchema).toBe("urn:ietf:params:qlog:file:sequential");
        const empty = load(file([]));
        expect(empty.getConnections()).toHaveLength(0);
        expect(codes(empty)).toEqual(["file.no-traces"]);
    });

    it("QlogLoader.fromRoot convenience", () => {
        const g = QlogLoader.fromRoot(file([trace([ev(1, "a:b")])], { description: "d" }), { filename: "f" })!;
        expect(g.filename).toBe("f");
        expect(g.description).toBe("d");
    });

    it("does not emit model change events while loading", () => {
        const listener = vi.fn();
        const off = modelEvents.on(listener);
        load(file([trace([ev(1, "quic:packet_sent", {}, { group_id: "a" }), ev(2, "x:y", {}, { group_id: "b" })])]));
        off();
        expect(listener).not.toHaveBeenCalled();
    });
});

describe("time model (data-model 3.16.3, fixtures 1-5)", () => {
    it("1. case R: dated epoch", () => {
        const g = load(
            file([
                trace([ev(10, "quic:packet_sent"), ev(25.5, "quic:packet_received")], {
                    common_fields: { time_format: "relative_to_epoch", reference_time: refTime(DATED_EPOCH) },
                }),
            ]),
        );
        const c = g.getConnections()[0];
        expect(c.timing.getTimeTrackingMethod()).toBe(TimeTrackingMethod.RELATIVE_TIME);
        expect(c.timing.getAbsoluteStartTime()).toBe(DATED_EPOCH_MS);
        expect(c.startTime).toBe(DATED_EPOCH_MS);
        const [a, b] = c.getEvents();
        expect(a.relativeTime).toBe(10);
        expect(b.relativeTime).toBe(25.5);
        expect(a.absoluteTime).toBe(DATED_EPOCH_MS + 10);
        expect(b.absoluteTime).toBe(DATED_EPOCH_MS + 25.5);
        expect(a.timeOffset).toBe(0);
        expect(c.timing.timeOffset).toBe(0);
        expect(c.timeRange()).toEqual({ minRelative: 10, maxRelative: 25.5 });
        expect(g.diagnostics).toEqual([]);
    });

    it("2. case A: no reference_time, Unix ms", () => {
        const t0 = 1553986553572;
        const g = load(
            file([
                trace([ev(t0, "quic:packet_sent"), ev(t0 + 5, "quic:packet_sent"), ev(t0 + 15.25, "quic:packet_sent")]),
            ]),
        );
        const c = g.getConnections()[0];
        expect(c.timing.getTimeTrackingMethod()).toBe(TimeTrackingMethod.ABSOLUTE_TIME);
        expect(c.timing.getAbsoluteStartTime()).toBe(t0);
        expect(c.getEvents().map((e) => e.relativeTime)).toEqual([0, 5, 15.25]);
        expect(c.getEvents().map((e) => e.absoluteTime)).toEqual([t0, t0 + 5, t0 + 15.25]);
        // explicit Unix epoch is the same case
        const g2 = load(
            file([
                trace([ev(t0, "quic:packet_sent")], {
                    common_fields: { reference_time: refTime("1970-01-01T00:00:00.000Z") },
                }),
            ]),
        );
        expect(g2.getConnections()[0].timing.getTimeTrackingMethod()).toBe(TimeTrackingMethod.ABSOLUTE_TIME);
        // setReferenceTime is ignored for ABSOLUTE_TIME (FIX Q22)
        c.timing.setReferenceTime(42);
        expect(c.getEvents()[0].absoluteTime).toBe(t0);
        expect(c.timing.getAbsoluteStartTime()).toBe(t0);
    });

    it("3. case U: unknown epoch (monotonic); setReferenceTime(1000) shifts absoluteTime", () => {
        const g = load(
            file([
                trace([ev(5000, "quic:packet_sent"), ev(5005, "quic:packet_sent"), ev(5015, "quic:packet_sent")], {
                    common_fields: { reference_time: refTime("unknown", "monotonic", DATED_EPOCH) },
                }),
            ]),
        );
        const c = g.getConnections()[0];
        expect(c.timing.getTimeTrackingMethod()).toBe(TimeTrackingMethod.RELATIVE_TIME);
        expect(c.timing.getAbsoluteStartTime()).toBe(0);
        expect(c.timing.epochMs).toBeNull();
        expect(c.getEvents().map((e) => e.relativeTime)).toEqual([0, 5, 15]);
        expect(c.getEvents().map((e) => e.absoluteTime)).toEqual([0, 5, 15]);
        expect(diag(g, "time.unknown-epoch")?.level).toBe("info");

        const listener = vi.fn();
        const off = modelEvents.on(listener);
        c.timing.setReferenceTime(1000);
        off();
        expect(listener).toHaveBeenCalledWith({ kind: "timing-changed", connection: c });
        expect(c.timing.getAbsoluteStartTime()).toBe(1000);
        expect(c.getEvents().map((e) => e.absoluteTime)).toEqual([1000, 1005, 1015]);
        expect(c.getEvents().map((e) => e.relativeTime)).toEqual([0, 5, 15]);
        c.timing.setReferenceTime(500);
        expect(c.getEvents()[0].absoluteTime).toBe(500);
    });

    it("4. relative_to_previous_event with a negative delta: decoded once, stable sort, DM1 diagnostic", () => {
        const events = [
            ev(1000, "quic:packet_sent", { n: 0 }),
            ev(5, "quic:packet_sent", { n: 1 }),
            ev(-3, "quic:packet_received", { n: 2 }),
            ev(0, "quic:packet_sent", { n: 3 }),
            ev(10, "quic:packet_sent", { n: 4 }),
        ];
        const g = load(file([trace(events, { common_fields: { time_format: "relative_to_previous_event" } })]));
        const c = g.getConnections()[0];
        const evs = c.getEvents();
        expect(evs.map((e) => e.data.n)).toEqual([0, 2, 3, 1, 4]); // 1002 (n2) and 1002 (n3) keep logged order
        expect(evs.map((e) => e.resolvedTime)).toEqual([1000, 1002, 1002, 1005, 1012]);
        expect(evs.map((e) => e.relativeTime)).toEqual([0, 2, 2, 5, 12]);
        expect(evs.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
        expect(evs.map((e) => e.originalIndex)).toEqual([0, 2, 3, 1, 4]);
        expect(evs.map((e) => e.time)).toEqual([1000, -3, 0, 5, 10]);
        expect(diag(g, "trace.reordered")).toMatchObject({ level: "warning", count: 1, traceIndex: 0 });
        // lookup arrays follow the sorted order
        expect(c.lookup("quic", "packet_sent").map((e) => e.data.n)).toEqual([0, 3, 1, 4]);
        // raw untouched
        expect(events[2].time).toBe(-3);
    });

    it("equal timestamps out of order elsewhere keep their logged order (stable)", () => {
        const g = load(
            file([
                trace([ev(5, "a:x", { n: 0 }), ev(5, "a:x", { n: 1 }), ev(1, "a:x", { n: 2 }), ev(5, "a:x", { n: 3 })]),
            ]),
        );
        expect(
            g
                .getConnections()[0]
                .getEvents()
                .map((e) => e.data.n),
        ).toEqual([2, 0, 1, 3]);
    });

    it("ordered traces with equal timestamps are not reported", () => {
        const g = load(file([trace([ev(1, "a:x"), ev(1, "a:x"), ev(2, "a:x")])]));
        expect(codes(g)).not.toContain("trace.reordered");
    });

    it("5. per-event time_format mix (delta base is the previous event's resolved time)", () => {
        const g = load(
            file([
                trace(
                    [
                        ev(100, "a:x"),
                        ev(5, "a:x", {}, { time_format: "relative_to_previous_event" }),
                        ev(200, "a:x"),
                        ev(1, "a:x", {}, { time_format: "relative_to_previous_event" }),
                        ev(2, "a:x", {}, { time_format: "relative_to_previous_event" }),
                    ],
                    { common_fields: { time_format: "relative_to_epoch", reference_time: refTime(DATED_EPOCH) } },
                ),
            ]),
        );
        expect(
            g
                .getConnections()[0]
                .getEvents()
                .map((e) => e.resolvedTime),
        ).toEqual([100, 105, 200, 201, 203]);
        expect(warnings(g)).toEqual([]);
    });

    it("first delta event is relative to the reference time", () => {
        const g = load(
            file([
                trace([ev(10, "a:x"), ev(5, "a:x")], {
                    common_fields: { time_format: "relative_to_previous_event", reference_time: refTime(DATED_EPOCH) },
                }),
            ]),
        );
        expect(
            g
                .getConnections()[0]
                .getEvents()
                .map((e) => e.absoluteTime),
        ).toEqual([DATED_EPOCH_MS + 10, DATED_EPOCH_MS + 15]);
    });

    it("per-event reference_time: same epoch is fine, a different one is aligned with a warning", () => {
        const sameRef = refTime(DATED_EPOCH);
        const g = load(
            file([
                trace([
                    ev(1, "a:x", {}, { reference_time: sameRef }),
                    ev(2, "a:x", {}, { reference_time: { ...sameRef } }),
                ]),
            ]),
        );
        const c = g.getConnections()[0];
        expect(c.timing.getAbsoluteStartTime()).toBe(DATED_EPOCH_MS);
        expect(c.getEvents().map((e) => e.absoluteTime)).toEqual([DATED_EPOCH_MS + 1, DATED_EPOCH_MS + 2]);
        expect(warnings(g)).toEqual([]);

        const later = new Date(DATED_EPOCH_MS + 1000).toISOString();
        const g2 = load(
            file([
                trace([
                    ev(1, "a:x", {}, { reference_time: sameRef }),
                    ev(2, "a:x", {}, { reference_time: refTime(later) }),
                ]),
            ]),
        );
        const c2 = g2.getConnections()[0];
        expect(c2.getEvents().map((e) => e.resolvedTime)).toEqual([1, 1002]);
        expect(c2.getEvents().map((e) => e.absoluteTime)).toEqual([DATED_EPOCH_MS + 1, DATED_EPOCH_MS + 1002]);
        expect(diag(g2, "time.mixed-reference-times")?.level).toBe("warning");
    });

    it("lenient legacy numeric reference_time and a monotonic clock with a dated epoch", () => {
        const g = load(file([trace([ev(1, "a:x")], { common_fields: { reference_time: "1564658098991" } })]));
        expect(g.getConnections()[0].timing.getAbsoluteStartTime()).toBe(1564658098991);
        expect(diag(g, "time.legacy-reference-time")?.level).toBe("warning");
        const g2 = load(
            file([trace([ev(1, "a:x")], { common_fields: { reference_time: refTime(DATED_EPOCH, "monotonic") } })]),
        );
        expect(g2.getConnections()[0].timing.getAbsoluteStartTime()).toBe(DATED_EPOCH_MS);
        expect(warnings(g2)).toEqual(["time.monotonic-with-epoch"]);
        const g3 = load(file([trace([ev(1, "a:x")], { common_fields: { reference_time: refTime("not a date") } })]));
        expect(g3.getConnections()[0].timing.epochMs).toBeNull();
        expect(codes(g3)).toContain("time.unparseable-epoch");
    });

    it("event without valid time takes the previous event's time and keeps its position; string times are parsed", () => {
        const g = load(
            file([trace([ev(1, "a:x"), ev(undefined, "a:y"), ev("3.5", "a:z"), ev("abc", "a:w"), ev(4, "a:v")])]),
        );
        const evs = g.getConnections()[0].getEvents();
        expect(evs.map((e) => e.type)).toEqual(["x", "y", "z", "w", "v"]);
        expect(evs.map((e) => e.resolvedTime)).toEqual([1, 1, 3.5, 3.5, 4]);
        expect(evs[1].time).toBeNaN();
        expect(evs[1].malformed).toEqual(["time"]);
        expect(evs[2].time).toBe(3.5);
        expect(evs[2].malformed).toBeUndefined();
        expect(diag(g, "event.missing-time")).toMatchObject({ level: "warning", count: 2 });
        expect(diag(g, "event.time-string")).toMatchObject({ level: "warning", count: 1 });
        expect(codes(g)).not.toContain("trace.reordered");
    });

    it("first event without time resolves to 0", () => {
        const g = load(file([trace([ev(undefined, "a:x"), ev(5, "a:y")])]));
        expect(
            g
                .getConnections()[0]
                .getEvents()
                .map((e) => e.resolvedTime),
        ).toEqual([0, 5]);
    });

    it("unknown time_format is treated as relative_to_epoch", () => {
        const g = load(file([trace([ev(1, "a:x"), ev(2, "a:x", {}, { time_format: "delta" })])]));
        expect(
            g
                .getConnections()[0]
                .getEvents()
                .map((e) => e.resolvedTime),
        ).toEqual([1, 2]);
        expect(diag(g, "event.unknown-time-format")).toMatchObject({ count: 1, sample: "delta" });
    });
});

describe("group_id splitting (fixtures 6-7)", () => {
    it("6. per-event group_id: slices in first-seen order, titles, delta decoding in file order", () => {
        const g = load(
            file([
                trace(
                    [
                        ev(10, "quic:packet_sent", { n: 0 }, { group_id: "a" }),
                        ev(5, "quic:packet_sent", { n: 1 }, { group_id: "b" }),
                        ev(5, "quic:packet_sent", { n: 2 }),
                        ev(5, "quic:packet_received", { n: 3 }, { group_id: "a" }),
                        ev(5, "quic:packet_sent", { n: 4 }, { group_id: 7 }),
                    ],
                    { title: "T", description: "D", common_fields: { time_format: "relative_to_previous_event" } },
                ),
            ]),
        );
        const conns = g.getConnections();
        expect(conns.map((c) => c.title)).toEqual([
            "Group a : T",
            "Group b : T",
            "Group (no group_id) : T",
            "Group 7 : T",
        ]);
        expect(conns.map((c) => c.groupId)).toEqual(["a", "b", "(no group_id)", "7"]);
        expect(conns.map((c) => c.description)).toEqual(["D", "D", "D", "D"]);
        expect(conns[0].getEvents().map((e) => e.resolvedTime)).toEqual([10, 25]);
        expect(conns[1].getEvents().map((e) => e.resolvedTime)).toEqual([15]);
        expect(conns[2].getEvents().map((e) => e.resolvedTime)).toEqual([20]);
        expect(conns[3].getEvents().map((e) => e.resolvedTime)).toEqual([30]);
        expect(conns[0].getEvents().map((e) => [e.index, e.originalIndex])).toEqual([
            [0, 0],
            [1, 3],
        ]);
        expect(conns[2].getEvents()[0].groupId).toBeUndefined();
        expect(conns[3].getEvents()[0].groupId).toBe("7");
        // own vantage point copy per slice (FIX Q8)
        conns[0].vantagePoint.name = "renamed";
        expect(conns[1].vantagePoint.name).toBeUndefined();
        expect(conns.every((c) => c.traceIndex === 0)).toBe(true);
        expect(conns[0].commonFields).toBe(conns[1].commonFields);
    });

    it("single group_id value still splits with a prefix (parity rule D2)", () => {
        const g = load(
            file([trace([ev(1, "a:x", {}, { group_id: "abc" })], { title: "T", vantage_point: { type: "client" } })]),
        );
        expect(g.getConnections().map((c) => c.getLongName())).toEqual(["client : Group abc : T"]);
    });

    it("group_id on later events only still splits (FIX Q9)", () => {
        const g = load(file([trace([ev(1, "a:x"), ev(2, "a:x", {}, { group_id: "z" })], { title: "T" })]));
        expect(g.getConnections().map((c) => c.title)).toEqual(["Group (no group_id) : T", "Group z : T"]);
    });

    it("common group_id is the fallback in a split trace", () => {
        const g = load(
            file([trace([ev(1, "a:x"), ev(2, "a:x", {}, { group_id: "z" })], { common_fields: { group_id: "c" } })]),
        );
        expect(g.getConnections().map((c) => c.title)).toEqual(["Group c : ", "Group z : "]);
    });

    it("7. group_id only in common_fields: no split, no prefix", () => {
        const g = load(file([trace([ev(1, "a:x"), ev(2, "a:y")], { title: "T", common_fields: { group_id: "abc" } })]));
        const conns = g.getConnections();
        expect(conns).toHaveLength(1);
        expect(conns[0].title).toBe("T");
        expect(conns[0].groupId).toBeUndefined();
        expect(conns[0].getEvents().map((e) => e.groupId)).toEqual(["abc", "abc"]);
    });

    it("each slice is ordered and timed independently", () => {
        const g = load(
            file([
                trace([
                    ev(100, "a:x", {}, { group_id: "a" }),
                    ev(50, "a:x", {}, { group_id: "b" }),
                    ev(60, "a:x", {}, { group_id: "b" }),
                ]),
            ]),
        );
        const [a, b] = g.getConnections();
        expect(codes(g)).not.toContain("trace.reordered");
        expect(a.timing.getAbsoluteStartTime()).toBe(100);
        expect(b.timing.getAbsoluteStartTime()).toBe(50);
        expect(b.getEvents().map((e) => e.relativeTime)).toEqual([0, 10]);
    });
});

describe("trace normalization (fixture 8)", () => {
    it("TraceError with and without uri; vantage point defaults; zero-event trace", () => {
        const g = load(
            file([
                { error_description: "File could not be found", uri: "/srv/a.qlog" },
                { error_description: "conversion failed" },
                { error_description: "x", vantage_point: { type: "server" } },
                trace([], { vantage_point: undefined, title: "empty" }),
                trace([ev(1, "a:x")], { vantage_point: { name: "aioquic client", type: "client" }, description: "d" }),
            ]),
        );
        const [e1, e2, e3, empty, named] = g.getConnections();
        expect(e1.isError).toBe(true);
        expect(e1.title).toBe("ERROR");
        expect(e1.description).toBe("/srv/a.qlog : File could not be found");
        expect(e1.vantagePoint).toEqual({ type: "unknown", flow: "unknown" });
        expect(e1.getLongName()).toBe("unknown (flow = unknown) : ERROR : /srv/a.qlog : File could not be found");
        expect(e1.getEvents()).toEqual([]);
        expect(e1.timing.getAbsoluteStartTime()).toBe(0);
        expect(e1.traceError).toEqual({ error_description: "File could not be found", uri: "/srv/a.qlog" });
        expect(e2.description).toBe("conversion failed"); // FIX: no "undefined : "
        expect(e3.vantagePoint).toEqual({ type: "server" });
        expect(empty.isError).toBe(false);
        expect(empty.getEvents()).toEqual([]);
        expect(empty.timeRange()).toBeUndefined();
        expect(empty.vantagePoint).toEqual({ type: "unknown", flow: "unknown", name: "No VantagePoint set" });
        expect(empty.getLongName()).toBe("No VantagePoint set : unknown (flow = unknown) : empty");
        expect(named.getLongName()).toBe("aioquic client : client :  : d");
        expect(diag(g, "trace.no-events")?.level).toBe("info");
        expect(diag(g, "trace.missing-vantage-point")?.level).toBe("info");
        expect(g.getShorthand()).toBe(" (5 connections)");
    });

    it("vantage point without type keeps a provided name; unknown types are kept and warned", () => {
        const g = load(
            file([
                trace([ev(1, "a:x")], { vantage_point: { name: "probe" } }),
                trace([ev(1, "a:x")], { vantage_point: { type: "middlebox" } }),
                trace([ev(1, "a:x")], { vantage_point: { type: "network", flow: "client" } }),
                trace([ev(1, "a:x")], { vantage_point: { type: "network" } }),
                trace([ev(1, "a:x")], { vantage_point: "client" }),
            ]),
        );
        const c = g.getConnections();
        expect(c[0].vantagePoint).toEqual({ type: "unknown", flow: "unknown", name: "probe" });
        expect(c[1].vantagePoint).toEqual({ type: "middlebox" });
        expect(c[1].perspective).toBe("unknown");
        expect(c[2].getVantagePointPerspective()).toBe("client");
        expect(c[2].getLongName()).toBe("network (flow = client) : ");
        expect(c[3].getVantagePointPerspective()).toBe("unknown");
        expect(c[4].vantagePoint.name).toBe("No VantagePoint set");
        expect(codes(g)).toEqual(
            expect.arrayContaining(["trace.invalid-vantage-point", "trace.unknown-vantage-point-type"]),
        );
    });

    it("missing events / event_schemas / invalid common_fields / event_fields", () => {
        const g = load(
            file(
                [
                    { vantage_point: { type: "client" }, common_fields: "nope", event_fields: ["time", "name"] },
                    trace([[1, "a:x", {}], ev(2, "a:y")], { event_schemas: [] }),
                ],
                { event_schemas: ["urn:ietf:params:qlog:events:quic"] },
            ),
        );
        const [a, b] = g.getConnections();
        expect(a.getEvents()).toEqual([]);
        expect(a.commonFields).toEqual({});
        expect(a.eventSchemas).toEqual(["urn:ietf:params:qlog:events:quic"]); // lenient file-level fallback
        expect(b.getEvents().map((e) => e.type)).toEqual(["y"]);
        expect(codes(g)).toEqual(
            expect.arrayContaining([
                "trace.invalid-common-fields",
                "trace.missing-event-schemas",
                "trace.event-fields-unsupported",
                "trace.missing-events",
                "event.not-object",
            ]),
        );
        expect(diag(g, "trace.missing-event-schemas")!.count).toBe(2);
    });

    it("non-object trace entries are skipped", () => {
        const g = load(file([42, trace([ev(1, "a:x")])]));
        expect(g.getConnections()).toHaveLength(1);
        expect(g.getConnections()[0].traceIndex).toBe(1);
        expect(codes(g)).toContain("trace.not-object");
    });

    it("protocolHint", () => {
        const g = load(
            file([
                trace([ev(1, "tcp:packet_sent")], {
                    event_schemas: ["https://x/012026/tcp"],
                    common_fields: { protocol_type: "TCP_HTTP2" },
                }),
                trace([ev(1, "tcp:packet_sent")], { event_schemas: ["https://x/012026/tcp"] }),
                trace([ev(1, "quic:packet_sent")], { event_schemas: ["https://x/012026/other"] }),
                trace([], { event_schemas: [HTTP3_13] }),
                trace([ev(1, "tcp:packet_sent"), ev(2, "http2:frame_created")]),
                trace([ev(1, "a:x")], { event_schemas: [] }),
                trace([ev(1, "quic:packet_sent"), ev(2, "tcp:packet_sent")], { event_schemas: [] }),
            ]),
        );
        // data-model 3.16.6: protocol_type, else tcp(+http2) namespaces, else quic/http3, else unknown
        expect(g.getConnections().map((c) => c.protocolHint)).toEqual([
            "TCP_HTTP2",
            "TCP",
            "QUIC_HTTP3",
            "QUIC_HTTP3",
            "TCP_HTTP2",
            "unknown",
            "QUIC_HTTP3",
        ]);
        expect(g.getConnections().map((c) => c.transportNamespace)).toEqual([
            "tcp",
            "tcp",
            "quic",
            "quic",
            "tcp",
            "quic",
            "quic",
        ]);
    });
});

describe("event normalization (fixture 9) and raw data", () => {
    it("name without colon, two colons, missing name, missing / invalid data, {} in the middle", () => {
        const events = [
            ev(1, "packet_sent", { a: 1 }),
            {},
            ev(2, "quic:a:b"),
            ev(3, undefined, { b: 2 }),
            { time: 4, name: "quic:packet_sent" },
            {},
            ev(5, "quic:packet_sent", [1, 2]),
            ev(6, 42),
        ];
        const g = load(file([trace(events)]));
        const evs = g.getConnections()[0].getEvents();
        expect(evs).toHaveLength(6);
        expect(evs.map((e) => [e.namespace, e.type, e.fullName])).toEqual([
            ["unknown", "packet_sent", "packet_sent"],
            ["quic", "a:b", "quic:a:b"],
            ["unknown", "unknown", "unknown:unknown"],
            ["quic", "packet_sent", "quic:packet_sent"],
            ["quic", "packet_sent", "quic:packet_sent"],
            ["unknown", "unknown", "unknown:unknown"],
        ]);
        expect(evs.map((e) => e.originalIndex)).toEqual([0, 2, 3, 4, 6, 7]);
        expect(evs.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(evs[0].data).toBe(events[0].data);
        expect(evs[3].data).toEqual({});
        expect(evs[3].malformed).toEqual(["data"]);
        expect(evs[4].data).toEqual({});
        expect(evs[4].raw.data).toEqual([1, 2]);
        expect(evs[2].malformed).toEqual(["name"]);
        expect(evs[5].malformed).toEqual(["name"]);
        expect(evs[0].loggedName).toBe("packet_sent");
        expect(evs[2].loggedName).toBe("unknown:unknown");
        expect(diag(g, "event.name-without-namespace")).toMatchObject({ count: 1, sample: "packet_sent" });
        expect(diag(g, "event.missing-name")?.count).toBe(1);
        expect(diag(g, "event.invalid-name")?.count).toBe(1);
        expect(diag(g, "event.missing-data")?.count).toBe(1);
        expect(diag(g, "event.invalid-data")?.count).toBe(1);
        expect(codes(g)).not.toContain("event.not-object"); // {} is skipped silently
    });

    it("common_fields name / data / tuple act as defaults (effective fields)", () => {
        const g = load(
            file([
                trace([{ time: 1 }, ev(2, "a:y", { z: 1 }, { tuple: "p1", odcid: "e" })], {
                    common_fields: { name: "a:x", data: { d: 1 }, tuple: "p0", odcid: "c" },
                }),
            ]),
        );
        const [x, y] = g.getConnections()[0].getEvents();
        expect(x.fullName).toBe("a:x");
        expect(x.data).toEqual({ d: 1 });
        expect(x.tuple).toBe("p0");
        expect(y.tuple).toBe("p1");
        expect(x.getField("odcid")).toBe("c");
        expect(y.getField("odcid")).toBe("e");
        expect(y.getField("missing")).toBeUndefined();
    });

    it("tuple defaults to empty string", () => {
        const g = load(file([trace([ev(1, "a:x")])]));
        expect(g.getConnections()[0].getEvents()[0].tuple).toBe("");
    });

    it("14. raw JSON is never mutated and data is shared, uint64 strings untouched", () => {
        const root = file([
            trace(
                [
                    ev(3, "quic:packet_sent", {
                        header: { packet_number: "18446744073709551615" },
                        raw: { length: "1252" },
                    }),
                    ev(1, "quic:stream_data_moved", { stream_id: "4", offset: 0, raw: { length: 10 } }),
                    {},
                    ev(2, "transport:packet_sent", { custom: { nested: true } }, { group_id: 5 }),
                ],
                { common_fields: { time_format: "relative_to_previous_event" } },
            ),
        ]);
        const before = JSON.stringify(root);
        const g = load(root);
        expect(JSON.stringify(root)).toBe(before);
        for (const c of g.getConnections()) {
            for (const e of c.getEvents()) {
                expect(e.data).toBe(e.raw.data);
                expect(root.traces[0].events[e.originalIndex]).toBe(e.raw);
            }
        }
        expect(g.getConnections().map((c) => c.title)).toEqual(["Group (no group_id) : ", "Group 5 : "]);
        const pn = g.getConnections()[0].getEvents()[0].data.header.packet_number;
        expect(pn).toBe("18446744073709551615");
    });
});

describe("lookup index (fixture 11)", () => {
    it("first-seen order, namespaces as keys, eager and always valid", () => {
        const g = load(
            file([
                trace([
                    ev(1, "quic:parameters_set"),
                    ev(2, "http3:frame_created"),
                    ev(3, "quic:packet_sent", { n: 1 }),
                    ev(4, "loglevel:info", { message: "m" }),
                    ev(5, "quic:packet_sent", { n: 2 }),
                    ev(6, "myns:custom_event", { unknown_member: 1 }),
                    ev(7, "quic:parameters_set"),
                ]),
            ]),
        );
        const c = g.getConnections()[0];
        const table = c.getLookupTable();
        expect([...table.keys()]).toEqual(["quic", "http3", "loglevel", "myns"]);
        expect([...table.get("quic")!.keys()]).toEqual(["parameters_set", "packet_sent"]);
        expect(c.lookup("quic", "packet_sent").map((e) => e.data.n)).toEqual([1, 2]);
        expect(c.lookup("myns", "custom_event")).toHaveLength(1);
        expect(c.lookup("quic", "nope")).toEqual([]);
        expect(c.lookup("nope", "nope")).toEqual([]);
        expect(c.lookup("nope", "nope")).toBe(c.lookup("x", "y")); // shared empty array
        expect(Object.isFrozen(c.lookup("x", "y"))).toBe(true);
        c.setupLookupTable(); // no-op porting aid
        expect(c.getLookupTable()).toBe(table);
        const sent = c.lookup("quic", "packet_sent")[0];
        expect(c.getEvents()[sent.index]).toBe(sent);
        expect(c.parseEvent(sent)).toBe(sent);
        expect(c.getEventParser().load(sent)).toBe(sent);
        expect(sent.is("quic:packet_sent")).toBe(true);
        expect(sent.timeToMilliseconds("2.5")).toBe(2.5);
        expect(c.getEventParser().timeToMilliseconds(3)).toBe(3);
    });
});

describe("event schemas (P14) and name conformance", () => {
    it("draft-suffixed, extension, private and final URIs", () => {
        const g = load(
            file([
                trace([ev(1, "quic:packet_sent"), ev(2, "http3:frame_created"), ev(3, "myns:thing")], {
                    event_schemas: [
                        "urn:ietf:params:qlog:events:quic-12",
                        "urn:ietf:params:qlog:events:quic#my-extension",
                        "https://example.org/012026/myns",
                        "urn:ietf:params:qlog:events:loglevel",
                    ],
                }),
            ]),
        );
        const unlisted = diag(g, "schema.unlisted-namespace")!;
        expect(unlisted.level).toBe("info");
        expect(unlisted.samples).toEqual(["http3"]);
        // a listed schema without events is normal (m14: "listed schemas need not have all their events present")
        expect(diag(g, "schema.unused")).toBeUndefined();
        expect(diag(g, "schema.draft-mismatch")?.samples).toEqual(["urn:ietf:params:qlog:events:quic-12"]);
        expect(g.diagnostics.every((d) => d.level === "info")).toBe(true);
    });

    it("non-conforming names are kept as logged and counted (DM3 data)", () => {
        const g = load(
            file([
                trace([
                    ev(1, "transport:packet_sent"),
                    ev(2, "transport:packet_sent"),
                    ev(3, "recovery:metrics_updated"),
                    ev(4, "quic:metrics_updated"),
                    ev(5, "http:frame_created"),
                    ev(6, "http:capsule_parsed"),
                    ev(7, "quic:packet_sent"),
                    ev(8, "tcp:packet_sent"),
                    ev(9, "nonamespace"),
                    ev(10, "security:key_updated"),
                    ev(11, "connectivity:connection_started"),
                ]),
            ]),
        );
        const d = diag(g, "event.nonconforming-name")!;
        expect(d.level).toBe("warning");
        expect(d.count).toBe(7);
        expect(d.samples).toEqual([
            "transport:packet_sent",
            "recovery:metrics_updated",
            "quic:metrics_updated",
            "http:frame_created",
            "security:key_updated",
        ]);
        const c = g.getConnections()[0];
        expect(c.lookup("transport", "packet_sent")).toHaveLength(2);
        expect(c.lookup("quic", "packet_sent")).toHaveLength(1);
    });

    it("extension schemas and declared namespaces are respected", () => {
        const g = load(
            file([
                trace([ev(1, "quic:my_new_event"), ev(2, "qpack:state_updated")], {
                    event_schemas: ["urn:ietf:params:qlog:events:quic-13#my-ext", "urn:ietf:params:qlog:events:qpack"],
                }),
            ]),
        );
        expect(codes(g)).not.toContain("event.nonconforming-name");
    });
});
