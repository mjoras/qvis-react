// Netlog converter end to end (converters spec sections 8.4, 8.9 and 9.9): the spec's synthetic fixture, real Chrome
// netlogs (tests/fixtures/netlog/, captured with Playwright chromium --log-net-log, scrubbed), hand-built 2020-format
// and edge-case netlogs; output through the latest-draft loader and model.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { QlogLoader } from "@/model";
import type { QlogConnection } from "@/model";
import type { Diagnostic } from "@/qlog/parse";
import { convertNetlog, netlogToQlog, repairTruncatedNetlog } from ".";
import type { NetlogConvertOptions } from ".";
import { NO_QUIC_CONNECTIONS_TEXT } from "../common/notifications";

// vitest runs from the repository root
const FIXTURES = "tests/fixtures/netlog/";
const read = (name: string): string => readFileSync(FIXTURES + name, "utf8");
const readGz = (name: string): string => gunzipSync(readFileSync(FIXTURES + name)).toString("utf8");

type Ev = { time: number; name: string; data: Record<string, any> };

// ---- synthetic netlog builder --------------------------------------------------------------------------------

interface NetlogEventSpec {
    type: string;
    params?: Record<string, unknown>;
    phase?: "PHASE_BEGIN" | "PHASE_END" | "PHASE_NONE";
    time?: number;
    source?: number;
    sourceType?: string;
}

function buildNetlog(specs: NetlogEventSpec[], timeTickOffset: string | null = "1600000000000"): object {
    const types = new Map<string, number>();
    const typeOf = (t: string): number => {
        if (!types.has(t)) types.set(t, 100 + types.size);
        return types.get(t)!;
    };
    typeOf("QUIC_SESSION");
    let time = 1000;
    const events = specs.map((s) => {
        if (s.time !== undefined) time = s.time;
        const ev: Record<string, unknown> = {
            phase: { PHASE_NONE: 0, PHASE_BEGIN: 1, PHASE_END: 2 }[s.phase ?? "PHASE_NONE"],
            source: { id: s.source ?? 7, start_time: "1000", type: s.sourceType === "URL_REQUEST" ? 1 : 11 },
            time: String(time),
            type: typeOf(s.type),
        };
        if (s.params) ev.params = s.params;
        return ev;
    });
    const constants: Record<string, unknown> = {
        activeFieldTrialGroups: [],
        logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 },
        logEventTypes: Object.fromEntries(types),
        logSourceType: { NONE: 0, URL_REQUEST: 1, QUIC_SESSION: 11 },
    };
    if (timeTickOffset !== null) constants.timeTickOffset = timeTickOffset;
    return { constants, events };
}

const BEGIN: NetlogEventSpec = {
    type: "QUIC_SESSION",
    phase: "PHASE_BEGIN",
    params: { host: "example.org", connection_id: "0102030405060708", versions: "RFCv1" },
};

function convert(specs: NetlogEventSpec[], opts?: NetlogConvertOptions): { events: Ev[]; diagnostics: Diagnostic[] } {
    const r = convertNetlog(buildNetlog(specs), opts);
    return { events: (r.qlog.traces[0]?.events ?? []) as Ev[], diagnostics: r.diagnostics };
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
    return diagnostics.map((d) => d.code);
}

function load(qlog: unknown, filename = "test.netlog") {
    const group = QlogLoader.fromJSON(
        { root: qlog as Record<string, unknown>, serialization: "json", diagnostics: [] },
        { filename },
    );
    if (!group) throw new Error("not loaded");
    return group;
}

// ---- the spec fixture --------------------------------------------------------------------------------------

describe("synthetic fixture (section 8.9.1 -> 8.9.2)", () => {
    const expected = JSON.parse(read("mini.expected.json"));

    it("produces exactly the expected output, from text and from the parsed object", () => {
        const fromText = convertNetlog(read("mini.netlog"));
        expect(fromText.qlog).toEqual(expected);
        expect(convertNetlog(JSON.parse(read("mini.netlog"))).qlog).toEqual(expected);
        // the URL_REQUEST source is skipped silently: no warning-level diagnostics
        expect(fromText.diagnostics.filter((d) => d.level !== "info")).toEqual([]);
        expect(fromText.stats).toMatchObject({ quicSessions: 1, traces: 1, qlogEvents: 12 });
    });

    it("loads without non-conforming names or schema problems, with qvis's relative times (case R)", () => {
        const group = load(convertNetlog(read("mini.netlog")).qlog);
        const bad = group.diagnostics.filter((d) => /^(event\.|schema\.|trace\.)/.test(d.code));
        expect(bad).toEqual([]);
        const conn = group.getConnections()[0];
        expect(conn.title).toBe("example.org-0102030405060708");
        expect(conn.getLongName()).toBe("client : example.org-0102030405060708");
        expect(conn.protocolHint).toBe("QUIC_HTTP3");
        expect(conn.transportNamespace).toBe("quic");
        const events = conn.getEvents();
        expect(events.map((e) => e.relativeTime)).toEqual([1, 1, 2, 3, 4, 4, 4, 30, 45, 46, 46, 100]);
        // absolute time = timeTickOffset + tick: 1600000000000 + 5001
        expect(events[0].absoluteTime).toBe(1600000005001);
        expect(conn.lookup("quic", "packet_received")).toHaveLength(2);
        expect(conn.lookup("loglevel", "info").map((e) => e.data.message)).toEqual([
            "CERT_VERIFIER_REQUEST BEGIN",
            "CERT_VERIFIER_REQUEST END",
        ]);
        // sequence-diagram label inputs (section 9.9.5)
        const tp = conn.lookup("quic", "parameters_set")[0];
        expect(Object.keys(tp.data).length + " transport parameters set").toBe("8 transport parameters set");
        const h3 = conn.lookup("http3", "parameters_set")[0];
        expect(Object.keys(h3.data).length + " HTTP/3 parameters set").toBe("4 HTTP/3 parameters set");
        const lost = conn.lookup("quic", "packet_lost")[0];
        expect(lost.data.header.packet_type + " packet lost #" + lost.data.header.packet_number).toBe(
            "unknown packet lost #1",
        );
    });

    it("attaches the last received packet's frames at the end of input (T2, Q11)", () => {
        const events = convertNetlog(read("mini.netlog")).qlog.traces[0].events as Ev[];
        const lastRx = events.filter((e) => e.name === "quic:packet_received").pop()!;
        expect(lastRx.data.frames).toEqual([
            { frame_type: "stream", stream_id: 0, offset: 0, fin: true, raw: { length: 300 } },
        ]);
    });
});

// ---- real Chrome netlogs -----------------------------------------------------------------------------------

describe("real Chrome netlogs (Chromium 156, capture mode Everything)", () => {
    it("converts a single cloudflare-quic.com session", () => {
        const r = convertNetlog(read("cloudflare-quic.netlog"), { filename: "cloudflare-quic.netlog" });
        expect(r.qlog.traces).toHaveLength(1);
        const trace = r.qlog.traces[0];
        expect(trace.title).toBe("cloudflare-quic.com-bb9e480eb70b79bd");
        expect(trace.common_fields.reference_time).toEqual({ clock_type: "system", epoch: "2026-11-01T20:00:00.962Z" });
        expect(r.diagnostics.filter((d) => d.level !== "info")).toEqual([]);
        // every unknown type is aggregated into one info diagnostic (Q22)
        const unsupported = r.diagnostics.find((d) => d.code === "netlog.unsupported-event")!;
        expect(unsupported.sample).toMatchObject({ QUIC_CONGESTION_CONTROL_CONFIGURED: 2 });

        const events = trace.events as Ev[];
        const count = (name: string) => events.filter((e) => e.name === name).length;
        expect(count("quic:packet_sent")).toBe(18);
        expect(count("quic:packet_received")).toBe(26);
        expect(events.every((e) => e.time >= 0 && Number.isInteger(e.time))).toBe(true);

        // current Chrome's header list format (Q12): the request line is readable again
        const req = events.find((e) => e.name === "http3:frame_created" && e.data.frame.frame_type === "headers")!;
        const field = (n: string) => req.data.frame.headers.find((h: { name: string }) => h.name === n)?.value;
        expect([field(":method"), field(":path"), field(":authority")]).toEqual(["GET", "/", "cloudflare-quic.com"]);
        const resp = events.find((e) => e.name === "http3:frame_parsed" && e.data.frame.frame_type === "headers")!;
        expect(resp.data.frame.headers[0]).toEqual({ name: ":status", value: "200" });
        const data = events.filter((e) => e.name === "http3:frame_parsed" && e.data.frame.frame_type === "data");
        expect(data.map((e) => e.data.frame.raw.payload_length)).toEqual([4096, 3773, 323, 4096, 1102, 0]);

        // transport parameters from the real quiche string
        const tp = events.filter((e) => e.name === "quic:parameters_set");
        expect(tp.map((e) => e.data.initiator)).toEqual(["local", "remote"]);
        expect(tp[0].data).toMatchObject({ max_udp_payload_size: 1472, initial_source_connection_id: "" });
        expect(tp[1].data).toMatchObject({
            max_idle_timeout: 180000,
            disable_active_migration: true,
            original_destination_connection_id: "bb9e480eb70b79bd",
        });

        // wire error names (Q15, Q16): STOP_SENDING / RST_STREAM 0x103, CONNECTION_CLOSE wire code 0
        const frames = events.flatMap((e) => (e.data.frames ?? []) as Record<string, unknown>[]);
        expect(frames.find((f) => f.frame_type === "stop_sending")).toEqual({
            frame_type: "stop_sending",
            stream_id: 15,
            error: "http_stream_creation_error",
        });
        expect(frames.find((f) => f.frame_type === "reset_stream")).toMatchObject({
            stream_id: 15,
            error: "http_stream_creation_error",
            final_size: 26,
        });
        expect(frames.find((f) => f.frame_type === "connection_close")).toEqual({
            frame_type: "connection_close",
            error_space: "transport",
            error: "no_error",
            reason: "net error",
        });
    });

    it("converts a multi-session netlog and loads it through the model", () => {
        const r = convertNetlog(readGz("multi-session.netlog.gz"));
        expect(r.qlog.traces.map((t) => t.title)).toEqual([
            "cloudflare-quic.com-57649290b3a2ed8c",
            "www.google.com-4ad7ad1d81df322f",
            "ogads-pa.clients6.google.com-a8fdb9fa7840bcfa",
        ]);
        const group = load(r.qlog, "multi-session.netlog.gz");
        expect(group.getShorthand()).toBe(" (3 connections)");
        expect(group.diagnostics.filter((d) => /^(event\.|schema\.|trace\.)/.test(d.code))).toEqual([]);
        const google: QlogConnection = group.getConnections()[1];
        expect(google.protocolHint).toBe("QUIC_HTTP3");
        const sent = google.lookup("quic", "packet_sent");
        const received = google.lookup("quic", "packet_received");
        expect(sent.length).toBeGreaterThan(100);
        expect(received.length).toBeGreaterThan(300);
        // every received packet got its frames (T1 on the next packet, T2 flush for the last one)
        expect(received.every((e) => Array.isArray(e.data.frames))).toBe(true);
        expect(sent.every((e) => typeof e.data.header.packet_number === "number")).toBe(true);
        // ACK frames carry numeric ranges ([n] for single packets)
        const acks = received
            .flatMap((e) => e.data.frames)
            .filter((f: { frame_type: string }) => f.frame_type === "ack");
        expect(acks.length).toBeGreaterThan(20);
        for (const a of acks)
            for (const range of a.acked_ranges) expect(range.every((n: unknown) => typeof n === "number")).toBe(true);
        // GET requests on client bidi streams
        const requests = google.lookup("http3", "frame_created").filter((e) => e.data.frame.frame_type === "headers");
        expect(requests.length).toBeGreaterThan(5);
        expect(requests.every((e) => Number(e.data.stream_id) % 4 === 0)).toBe(true);
        // cross-trace alignment: all traces share timeTickOffset (absolute times are Unix ms)
        const starts = group.getConnections().map((c) => c.getEvents()[0].absoluteTime);
        expect(starts[0]).toBeLessThan(starts[1]);
        expect(starts[1] - starts[0]).toBeLessThan(60_000);
    });

    it("repairs a truncated real netlog (section 8.5.6)", () => {
        const text = read("cloudflare-quic.netlog");
        const cut = text.slice(0, Math.floor(text.length * 0.6));
        expect(() => JSON.parse(cut)).toThrow();
        const r = convertNetlog(cut, { filename: "cut.netlog" });
        expect(r.diagnostics.find((d) => d.code === "netlog.repaired-truncated")?.level).toBe("warning");
        expect(r.qlog.traces).toHaveLength(1);
        expect(r.qlog.traces[0].events.length).toBeGreaterThan(5);
        expect(r.qlog.traces[0].events.length).toBeLessThan(64);
    });
});

// ---- repair ------------------------------------------------------------------------------------------------

describe("repairTruncatedNetlog", () => {
    const head = '{"constants":{"logEventTypes":{"A":1}},\n"events": [\n';
    it("cuts back to the last complete event and closes the document", () => {
        const t = head + '{"a":1,"s":"x}"},\n{"b":[1,2]},\n{"c":{"d":"\\"}';
        expect(JSON.parse(repairTruncatedNetlog(t)!)).toEqual({
            constants: { logEventTypes: { A: 1 } },
            events: [{ a: 1, s: "x}" }, { b: [1, 2] }],
        });
    });
    it("keeps everything up to the closed events array when truncated in polledData", () => {
        const t = head + '{"a":1}\n],"polledData":{"x":';
        expect(JSON.parse(repairTruncatedNetlog(t)!)).toEqual({
            constants: { logEventTypes: { A: 1 } },
            events: [{ a: 1 }],
        });
    });
    it("accepts a BOM", () => {
        const cut = "\ufeff" + head + '{"a":1},\n{"b"';
        expect(convertNetlog("\ufeff" + read("mini.netlog")).qlog.traces).toHaveLength(1);
        expect(() => convertNetlog(cut)).toThrow(/no constants\.logSourceType/); // repaired, then validated
    });
    it("gives up without a complete event or on non-netlog text", () => {
        expect(repairTruncatedNetlog(head + '{"a":')).toBeUndefined();
        expect(repairTruncatedNetlog('[{"a":1}')).toBeUndefined();
        expect(() => convertNetlog('{"constants":{', { filename: "x.netlog" })).toThrow(
            /^Could not parse netlog file x\.netlog : /,
        );
    });
});

// ---- mapping details ---------------------------------------------------------------------------------------

describe("mapping details", () => {
    it("handles a 2020-format netlog (object headers, pre-RFC names, application_error_code)", () => {
        const { events, diagnostics } = convert([
            BEGIN,
            {
                type: "QUIC_SESSION_TRANSPORT_PARAMETERS_RECEIVED",
                params: { quic_transport_parameters: "[Server idle_timeout 30000 max_packet_size 1350]" },
            },
            {
                type: "HTTP3_SETTINGS_RECEIVED",
                params: {
                    SETTINGS_MAX_HEADER_LIST_SIZE: 16384,
                    SETTINGS_QPACK_BLOCKED_STREAMS: 0,
                    SETTINGS_QPACK_MAX_TABLE_CAPACITY: 0,
                },
            },
            { type: "HTTP3_HEADERS_SENT", params: { stream_id: 0, headers: { ":method": "GET", ":path": "/x" } } },
            { type: "QUIC_SESSION_STOP_SENDING_FRAME_SENT", params: { stream_id: 4, application_error_code: 0x10c } },
            {
                type: "QUIC_SESSION_RST_STREAM_FRAME_SENT",
                params: { stream_id: 4, quic_rst_stream_error: 6, offset: 10 },
            },
            { type: "QUIC_SESSION_WINDOW_UPDATE_FRAME_SENT", params: { stream_id: -1, byte_offset: 100 } },
            { type: "QUIC_SESSION_WINDOW_UPDATE_FRAME_SENT", params: { stream_id: 0, byte_offset: "5000000000" } },
            { type: "QUIC_SESSION_PING_FRAME_SENT" },
            {
                type: "QUIC_SESSION_PACKET_SENT",
                params: { encryption_level: "ENCRYPTION_FORWARD_SECURE", packet_number: 9, size: 60 },
            },
        ]);
        expect(diagnostics.filter((d) => d.level !== "info")).toEqual([]);
        expect(events.map((e) => e.name)).toEqual([
            "quic:parameters_set",
            "http3:parameters_set",
            "http3:frame_created",
            "quic:packet_sent",
        ]);
        expect(events[0].data).toMatchObject({
            initiator: "remote",
            max_idle_timeout: 30000,
            max_udp_payload_size: 1350,
        });
        expect(events[1].data).toEqual({
            initiator: "remote",
            max_field_section_size: 16384,
            max_table_capacity: 0,
            blocked_streams_count: 0,
        });
        expect(events[2].data.frame.headers).toEqual([
            { name: ":method", value: "GET" },
            { name: ":path", value: "/x" },
        ]);
        expect(events[3].data).toEqual({
            header: { packet_type: "1RTT", packet_number: 9 },
            frames: [
                { frame_type: "stop_sending", stream_id: 4, error: "http_request_cancelled" },
                { frame_type: "reset_stream", stream_id: 4, error: "unknown", error_code: 6, final_size: 10 },
                { frame_type: "max_data", maximum: 100 },
                { frame_type: "max_stream_data", stream_id: 0, maximum: 5000000000 },
                { frame_type: "ping" },
            ],
            raw: { length: 60 },
        });
    });

    it("maps wire error names (section 9.9.6)", () => {
        const { events } = convert([
            BEGIN,
            {
                type: "QUIC_SESSION_RST_STREAM_FRAME_RECEIVED",
                params: { stream_id: 0, ietf_error_code: 0x10c, quic_rst_stream_error: 6, offset: 0 },
            },
            {
                type: "QUIC_SESSION_RST_STREAM_FRAME_RECEIVED",
                params: { stream_id: 4, ietf_error_code: 0x10e, quic_rst_stream_error: 6, offset: 0 },
            },
            { type: "QUIC_SESSION_PACKET_RECEIVED", params: { size: 100 } },
            {
                type: "QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT",
                params: { quic_wire_error: 0x128, quic_error: 3, close_type: "Transport", details: "tls" },
            },
            {
                type: "QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT",
                params: { quic_wire_error: 0x101, quic_error: 3, close_type: "Application" },
            },
            {
                type: "QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT",
                params: { quic_wire_error: 0x99, close_type: "Transport" },
            },
            {
                type: "QUIC_SESSION_PACKET_SENT",
                params: { encryption_level: "ENCRYPTION_HANDSHAKE", packet_number: 1, size: 50 },
            },
        ]);
        const rx = events.find((e) => e.name === "quic:packet_received")!;
        expect(rx.data.frames).toEqual([]); // the frames came before the packet: dropped
        const tx = events.find((e) => e.name === "quic:packet_sent")!;
        expect(tx.data.frames).toEqual([
            { frame_type: "connection_close", error_space: "transport", error: "crypto_error_0x128", reason: "tls" },
            { frame_type: "connection_close", error_space: "application", error: "http_general_protocol_error" },
            { frame_type: "connection_close", error_space: "transport", error: "unknown", error_code: 0x99 },
        ]);
        const r2 = convert([
            BEGIN,
            { type: "QUIC_SESSION_PACKET_RECEIVED", params: { size: 100 } },
            {
                type: "QUIC_SESSION_RST_STREAM_FRAME_RECEIVED",
                params: { stream_id: 0, ietf_error_code: 0x10c, quic_rst_stream_error: 6, offset: 0 },
            },
            {
                type: "QUIC_SESSION_RST_STREAM_FRAME_RECEIVED",
                params: { stream_id: 4, ietf_error_code: 0x10e, quic_rst_stream_error: 6, offset: 0 },
            },
        ]);
        expect(r2.events[0].data.frames).toEqual([
            { frame_type: "reset_stream", stream_id: 0, error: "http_request_cancelled", final_size: 0 },
            { frame_type: "reset_stream", stream_id: 4, error: "unknown", error_code: 270, final_size: 0 },
        ]);
    });

    it("keeps uint64 values beyond 2^53 as decimal strings (C12, section 9.9.7)", () => {
        const { events } = convert([
            BEGIN,
            {
                type: "QUIC_SESSION_STREAM_FRAME_SENT",
                params: { stream_id: 0, offset: "9007199254740993", length: 3, fin: false },
            },
            { type: "QUIC_SESSION_STREAM_FRAME_SENT", params: { stream_id: 0, offset: "42", length: "3", fin: true } },
            {
                type: "QUIC_SESSION_PACKET_SENT",
                params: { encryption_level: "ENCRYPTION_FORWARD_SECURE", packet_number: 2, size: 80 },
            },
        ]);
        expect(events[0].data.frames.map((f: { offset: unknown }) => f.offset)).toEqual(["9007199254740993", 42]);
    });

    it("maps undecryptable packets, unknown levels, missing fields and the session title fallbacks", () => {
        const { events, diagnostics } = convert([
            { type: "QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET", params: { encryption_level: "ENCRYPTION_ZERO_RTT" } },
            {
                type: "QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET",
                params: { encryption_level: "ENCRYPTION_FORWARD_SECURE" },
            },
            { type: "QUIC_SESSION_PACKET_SENT", params: { encryption_level: "ENCRYPTION_WEIRD", size: 10 } },
            { type: "QUIC_SESSION_ACK_FRAME_RECEIVED", params: { largest_observed: 5, missing_packets: [] } },
            { type: "QUIC_SESSION_STREAM_FRAME_SENT", params: { offset: 0, length: 1 } },
            { type: "CERT_VERIFIER_REQUEST", phase: "PHASE_NONE" },
        ]);
        expect(events.map((e) => [e.name, e.data])).toEqual([
            ["quic:packet_dropped", { header: { packet_type: "0RTT" }, trigger: "key_unavailable" }],
            ["quic:packet_dropped", { header: { packet_type: "1RTT" }, trigger: "key_unavailable" }],
            ["quic:packet_sent", { header: { packet_type: "unknown" }, frames: [], raw: { length: 10 } }],
            ["loglevel:info", { message: "CERT_VERIFIER_REQUEST END" }],
        ]);
        expect(codes(diagnostics)).toEqual(
            expect.arrayContaining([
                "netlog.session-without-begin",
                "netlog.unknown-encryption-level",
                "netlog.missing-field",
                "netlog.unsent-frames",
            ]),
        );
        const r = convertNetlog(
            buildNetlog([
                { type: "QUIC_SESSION_PING_FRAME_SENT" },
                { type: "CERT_VERIFIER_REQUEST", phase: "PHASE_BEGIN" },
            ]),
        );
        expect(r.qlog.traces[0].title).toBe("QUIC session 7");
        const r2 = convertNetlog(
            buildNetlog([{ ...BEGIN, params: { host: "h.example" } }, { type: "CERT_VERIFIER_REQUEST" }]),
        );
        expect(r2.qlog.traces[0].title).toBe("h.example");
    });

    it("warns about ACKs without smallest_observed instead of failing (Q17)", () => {
        const { events, diagnostics } = convert([
            BEGIN,
            { type: "QUIC_SESSION_ACK_FRAME_SENT", params: { largest_observed: 10, missing_packets: [] } },
            {
                type: "QUIC_SESSION_PACKET_SENT",
                params: { encryption_level: "ENCRYPTION_INITIAL", packet_number: 0, size: 1200 },
            },
        ]);
        expect(events[0].data.frames).toEqual([{ frame_type: "ack", acked_ranges: [[10]] }]);
        expect(diagnostics.find((d) => d.code === "netlog.ack.no-smallest-observed")?.level).toBe("warning");
    });

    it("never emits an empty acked_ranges (quic-13 AckFrame: [+ AckRange])", () => {
        // every range is inverted: the missing packets cover smallest..largest
        const { events, diagnostics } = convert([
            BEGIN,
            {
                type: "QUIC_SESSION_ACK_FRAME_SENT",
                params: { largest_observed: 4, smallest_observed: 3, missing_packets: [3, 4] },
            },
            {
                type: "QUIC_SESSION_PACKET_SENT",
                params: { encryption_level: "ENCRYPTION_FORWARD_SECURE", packet_number: 1, size: 50 },
            },
        ]);
        expect(events[0].data.frames).toEqual([{ frame_type: "ack" }]);
        expect(diagnostics.find((d) => d.code === "netlog.missing-field")?.samples).toContain(
            "QUIC_SESSION_ACK_FRAME_SENT.acked_ranges",
        );
    });

    it("keeps application error codes beyond 2^53 as exact decimal strings (C12)", () => {
        const { events } = convert([
            BEGIN,
            { type: "QUIC_SESSION_PACKET_RECEIVED", params: { size: 100 } },
            {
                type: "QUIC_SESSION_RST_STREAM_FRAME_RECEIVED",
                params: { stream_id: 0, ietf_error_code: "18446744073709551615", quic_rst_stream_error: 6, offset: 0 },
            },
            {
                type: "QUIC_SESSION_STOP_SENDING_FRAME_RECEIVED",
                params: { stream_id: 4, ietf_error_code: "9007199254740993", quic_rst_stream_error: 6 },
            },
            { type: "QUIC_SESSION_STOP_SENDING_FRAME_RECEIVED", params: { stream_id: 8, ietf_error_code: -1 } },
        ]);
        expect(events[0].data.frames).toEqual([
            {
                frame_type: "reset_stream",
                stream_id: 0,
                error: "unknown",
                error_code: "18446744073709551615",
                final_size: 0,
            },
            { frame_type: "stop_sending", stream_id: 4, error: "unknown", error_code: "9007199254740993" },
            // not a uint64: no error_code is invented
            { frame_type: "stop_sending", stream_id: 8, error: "unknown" },
        ]);
    });

    it("reports frames buffered for a header-only received packet (never shown, PARITY) as dropped", () => {
        const r = convertNetlog(
            buildNetlog([
                BEGIN,
                // a header without a preceding PACKET_RECEIVED: qvis created a packet that never appears
                {
                    type: "QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED",
                    params: { long_header_type: "INITIAL", packet_number: 0 },
                },
                { type: "QUIC_SESSION_PING_FRAME_RECEIVED" },
                { type: "CERT_VERIFIER_REQUEST", phase: "PHASE_BEGIN" },
            ]),
        );
        expect((r.qlog.traces[0].events as Ev[]).map((e) => e.name)).toEqual(["loglevel:info"]);
        expect(r.diagnostics.find((d) => d.code === "netlog.unsent-frames")?.count).toBe(1);
    });

    it("drops sessions without convertible events and separates sessions by source id", () => {
        const r = convertNetlog(
            buildNetlog([
                { ...BEGIN, source: 1 },
                { ...BEGIN, source: 2, params: { host: "b.example", connection_id: "bb" } },
                { type: "QUIC_SESSION_CLOSED", source: 1, params: { quic_error: 25 } },
                { type: "CERT_VERIFIER_REQUEST", source: 2, phase: "PHASE_BEGIN" },
                { type: "URL_REQUEST_START_JOB", sourceType: "URL_REQUEST" },
            ]),
        );
        expect(r.qlog.traces.map((t) => t.title)).toEqual(["b.example-bb"]);
        expect(codes(r.diagnostics)).toContain("netlog.empty-session-dropped");
    });

    it("uses a monotonic clock with an unknown epoch without timeTickOffset (C3)", () => {
        const r = convertNetlog(buildNetlog([BEGIN, { type: "CERT_VERIFIER_REQUEST", time: 1005 }], null));
        expect(r.qlog.traces[0].common_fields.reference_time).toEqual({ clock_type: "monotonic", epoch: "unknown" });
        expect(r.qlog.traces[0].event_schemas).toEqual(["urn:ietf:params:qlog:events:loglevel"]);
        expect(codes(r.diagnostics)).toContain("netlog.no-time-tick-offset");
        const conn = load(r.qlog).getConnections()[0];
        expect(conn.getEvents()[0].relativeTime).toBe(0);
    });

    it("throws for non-netlogs and (loading contract) for netlogs without QUIC sessions", () => {
        expect(() => convertNetlog({ events: [] })).toThrow(/Not a Chrome netlog/);
        expect(() => convertNetlog({ constants: {}, events: [] })).toThrow(/no constants\.logEventTypes/);
        const empty = buildNetlog([{ type: "URL_REQUEST_START_JOB", sourceType: "URL_REQUEST" }]);
        const r = convertNetlog(empty);
        expect(r.qlog.traces).toEqual([]);
        expect(codes(r.diagnostics)).toContain("netlog.no-quic-sessions");
        expect(() => netlogToQlog(empty, "x.netlog")).toThrow(NO_QUIC_CONNECTIONS_TEXT);
    });
});

// ---- T3 (extended) -----------------------------------------------------------------------------------------

describe("extended mappings (T3)", () => {
    it("adds the T3 events and fields on the spec fixture", () => {
        const r = convertNetlog(read("mini.netlog"), { extended: true });
        const events = r.qlog.traces[0].events as Ev[];
        expect(events[0]).toEqual({
            time: 0,
            name: "quic:version_information",
            data: { client_versions: ["00000001"] },
        });
        const sent = events.find((e) => e.name === "quic:packet_sent")!;
        expect(sent.data.frames[1]).toEqual({ frame_type: "padding", raw: { payload_length: 905 } });
        const firstRx = events.find((e) => e.name === "quic:packet_received")!;
        expect(firstRx.data.frames[0]).toEqual({ frame_type: "ack", acked_ranges: [[1]], ack_delay: 0.25 });
        // packet_lost gets the type of the sent packet with that number
        expect(events.find((e) => e.name === "quic:packet_lost")!.data.header).toEqual({
            packet_type: "initial",
            packet_number: 1,
        });
    });

    it("maps the current-Chrome frame and HTTP/3 events", () => {
        const { events } = convert(
            [
                BEGIN,
                { type: "HTTP3_LOCAL_CONTROL_STREAM_CREATED", params: { stream_id: 2 } },
                { type: "HTTP3_PEER_CONTROL_STREAM_CREATED", params: { stream_id: 3 } },
                {
                    type: "HTTP3_PRIORITY_UPDATE_SENT",
                    params: { prioritized_element_id: 0, priority_field_value: "u=0, i" },
                },
                { type: "HTTP3_HEADERS_RECEIVED", params: { stream_id: 0, compressed_headers_length: 121 } },
                { type: "HTTP3_HEADERS_DECODED", params: { stream_id: 0, headers: [":status: 200"] } },
                {
                    type: "HTTP3_UNKNOWN_FRAME_RECEIVED",
                    params: { stream_id: 0, frame_type: "2851641266922629474", payload_length: 0 },
                },
                { type: "HTTP3_GOAWAY_RECEIVED", params: { stream_id: 8 } },
                { type: "QUIC_SESSION_PACKET_RECEIVED", params: { size: 1200 } },
                { type: "QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED", params: { packet_number: 4 } },
                {
                    type: "QUIC_SESSION_NEW_CONNECTION_ID_FRAME_RECEIVED",
                    params: { connection_id: "01a0", retire_prior_to: 0, sequence_number: 1 },
                },
                { type: "QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED" },
                {
                    type: "QUIC_SESSION_MAX_STREAMS_FRAME_RECEIVED",
                    params: { stream_count: 100, is_unidirectional: true },
                },
                { type: "QUIC_SESSION_CRYPTO_HANDSHAKE_COMPLETE" },
                { type: "QUIC_SESSION_CLOSED", params: { quic_error: 70, details: "net error", from_peer: false } },
            ],
            { extended: true },
        );
        const byName = (n: string) => events.filter((e) => e.name === n).map((e) => e.data);
        expect(byName("http3:frame_created")).toEqual([
            { stream_id: 2, frame: { frame_type: "priority_update", stream_id: 0, priority_field_value: "u=0, i" } },
        ]);
        expect(byName("http3:frame_parsed")).toEqual([
            {
                stream_id: 0,
                frame: {
                    frame_type: "headers",
                    headers: [{ name: ":status", value: "200" }],
                    raw: { payload_length: 121 },
                },
            },
            {
                stream_id: 0,
                frame: { frame_type: "unknown", frame_type_bytes: "2851641266922629474", raw: { payload_length: 0 } },
            },
            { stream_id: 3, frame: { frame_type: "goaway", id: 8 } },
        ]);
        expect(byName("quic:packet_received")[0].frames).toEqual([
            { frame_type: "new_connection_id", sequence_number: 1, retire_prior_to: 0, connection_id: "01a0" },
            { frame_type: "handshake_done" },
            { frame_type: "max_streams", stream_type: "unidirectional", maximum: 100 },
        ]);
        expect(byName("quic:connection_state_updated")).toEqual([{ new: "handshake_complete" }]);
        expect(byName("quic:connection_closed")).toEqual([
            { initiator: "local", internal_code: 70, reason: "net error" },
        ]);
    });

    it("splits coalesced received datagrams (splitCoalescedReceived)", () => {
        const { events } = convert(
            [
                BEGIN,
                { type: "QUIC_SESSION_PACKET_RECEIVED", params: { size: 1200 } },
                {
                    type: "QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED",
                    params: { long_header_type: "INITIAL", packet_number: 0 },
                },
                {
                    type: "QUIC_SESSION_ACK_FRAME_RECEIVED",
                    params: { largest_observed: 1, smallest_observed: 1, missing_packets: [] },
                },
                {
                    type: "QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED",
                    params: { long_header_type: "HANDSHAKE", packet_number: 0 },
                },
                { type: "QUIC_SESSION_CRYPTO_FRAME_RECEIVED", params: { offset: 0, data_length: 900 } },
            ],
            { splitCoalescedReceived: true },
        );
        expect(events.map((e) => [e.name, e.data])).toEqual([
            ["quic:udp_datagrams_received", { count: 1, raw: [{ length: 1200 }], datagram_ids: [0] }],
            [
                "quic:packet_received",
                {
                    header: { packet_type: "initial", packet_number: 0 },
                    raw: { length: 1200 },
                    datagram_id: 0,
                    frames: [{ frame_type: "ack", acked_ranges: [[1]] }],
                },
            ],
            [
                "quic:packet_received",
                {
                    header: { packet_type: "handshake", packet_number: 0 },
                    datagram_id: 0,
                    frames: [{ frame_type: "crypto", offset: 0, raw: { length: 900 } }],
                },
            ],
        ]);
    });

    it("default output is unchanged by the T3 code paths (qvis-silent events stay silent)", () => {
        const { events, diagnostics } = convert([
            BEGIN,
            { type: "QUIC_SESSION_VERSION_NEGOTIATED", params: { version: "RFCv1" } },
            { type: "HTTP3_PRIORITY_UPDATE_SENT", params: { prioritized_element_id: 0, priority_field_value: "u=0" } },
            { type: "QUIC_SESSION_CRYPTO_HANDSHAKE_COMPLETE" },
            { type: "QUIC_SESSION_CLOSED", params: { quic_error: 70 } },
            { type: "CERT_VERIFIER_REQUEST", phase: "PHASE_BEGIN" },
        ]);
        expect(events.map((e) => e.name)).toEqual(["loglevel:info"]);
        expect(codes(diagnostics)).not.toContain("netlog.unsupported-event");
    });
});
