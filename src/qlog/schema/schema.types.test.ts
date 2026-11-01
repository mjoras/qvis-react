/**
 * Type-level test: real events of scripts/cddl/sample-valid.sqlog (a strictly conforming, CDDL-validated file)
 * written as literals that must COMPILE against the schema types (`satisfies`), plus negative cases
 * (`@ts-expect-error`) and narrowing checks. The type assertions are enforced by `tsc -b` (npm run typecheck);
 * the runtime part checks that the literals are faithful copies of the file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
    HTTP3_EVENTS,
    isKnownEventName,
    QUIC_EVENTS,
    type EventDataMap,
    type EventDataOf,
    type KnownEventName,
} from "@/model/names";
import sampleValidSqlog from "../../../scripts/cddl/sample-valid.sqlog?raw";
import type { Uint64 } from "./main";
import {
    HTTP3_FRAME_TYPES,
    type HTTP3Frame,
    type HTTP3FrameOf,
    type HTTP3FrameType,
    type HTTP3HeadersFrame,
} from "./h3";
import {
    QUIC_FRAME_TYPES,
    type AckFrame,
    type AckRange,
    type QuicFrame,
    type QuicFrameOf,
    type QuicFrameType,
    type QUICPacketSent,
} from "./quic";

// --- events from scripts/cddl/sample-valid.sqlog (records 1-6, verbatim) -------------------------------------

const connectionStarted = {
    local: { ip_v4: "127.0.0.1", port_v4: 51234, connection_ids: ["c7a2e1f0"] },
    remote: { ip_v4: "127.0.0.1", port_v4: 4433, connection_ids: ["6bf1fc0e7fb5d3f1"] },
} satisfies EventDataMap["quic:connection_started"];

const packetSent = {
    header: {
        packet_type: "initial",
        packet_number: 0,
        packet_number_length: 4,
        version: "00000001",
        scil: 4,
        dcil: 8,
        scid: "c7a2e1f0",
        dcid: "6bf1fc0e7fb5d3f1",
        length: 1182,
    },
    frames: [
        { frame_type: "crypto", offset: 0, raw: { length: 285, payload_length: 281 } },
        { frame_type: "padding", raw: { length: 897, payload_length: 897 } },
    ],
    raw: { length: 1200 },
    datagram_id: 1,
} satisfies EventDataMap["quic:packet_sent"];

const packetReceived = {
    header: { packet_type: "1RTT", packet_number: 3, key_phase_bit: false, spin_bit: false, dcid: "c7a2e1f0" },
    frames: [
        { frame_type: "ack", ack_delay: 0.125, acked_ranges: [[0, 2], [4]] },
        { frame_type: "stream", stream_id: 0, offset: 0, fin: true, raw: { payload_length: 42 } },
        { frame_type: "max_data", maximum: 1048576 },
        {
            frame_type: "new_connection_id",
            sequence_number: 1,
            retire_prior_to: 0,
            connection_id_length: 8,
            connection_id: "0011223344556677",
            stateless_reset_token: "00112233445566778899aabbccddeeff",
        },
    ],
    raw: { length: 120 },
} satisfies EventDataMap["quic:packet_received"];

const recoveryMetricsUpdated = {
    min_rtt: 24.9,
    smoothed_rtt: 25.4,
    latest_rtt: 25,
    rtt_variance: 12.7,
    pto_count: 0,
    congestion_window: 13500,
    bytes_in_flight: 1252,
    packets_in_flight: 1,
    pacing_rate: 4320000,
} satisfies EventDataMap["quic:recovery_metrics_updated"];

const headersCreated = {
    stream_id: 0,
    frame: {
        frame_type: "headers",
        headers: [
            { name: ":method", value: "GET" },
            { name: ":scheme", value: "https" },
            { name: ":authority", value: "localhost:4433" },
            { name: ":path", value: "/" },
        ],
    },
} satisfies EventDataMap["http3:frame_created"];

const settingsCreated = {
    stream_id: 2,
    frame: {
        frame_type: "settings",
        settings: [
            { name: "settings_qpack_max_table_capacity", value: 0 },
            { name: "settings_h3_datagram", value: 1 },
        ],
    },
} satisfies EventDataMap["http3:frame_created"];

const SAMPLE: ReadonlyArray<{ name: KnownEventName; data: object }> = [
    { name: "quic:connection_started", data: connectionStarted },
    { name: "quic:packet_sent", data: packetSent },
    { name: "quic:packet_received", data: packetReceived },
    { name: "quic:recovery_metrics_updated", data: recoveryMetricsUpdated },
    { name: "http3:frame_created", data: headersCreated },
    { name: "http3:frame_created", data: settingsCreated },
];

// --- other shapes the types must accept ----------------------------------------------------------------------

// uint64 as JSON string (main-schema-14 §11.3), editor's-copy members, open enums with unknown values
const _uint64AsString = {
    header: { packet_type: "1RTT", packet_number: "18446744073709551615" },
    frames: [{ frame_type: "ack", acked_ranges: [["9007199254740993", "9007199254740995"]] }],
    datagram_payload_checksum: 12345,
} satisfies QUICPacketSent;
const _openEnum = {
    header: { packet_type: "some_future_packet_type" },
} satisfies EventDataMap["quic:packet_dropped"];
const _editorsCopy = {
    local: { address_v4: { ip: "10.0.0.1", port: 443 }, address_v6: "redacted" },
    remote: { connection_ids: ["ab"] },
} satisfies EventDataMap["quic:connection_started"];
const _reorderingDisabled = {
    timer_granularity: 1,
    reordering_threshold: "disabled",
} satisfies EventDataMap["quic:recovery_parameters_set"];
const _keysUnavailable = { trigger: "keys_unavailable" } satisfies EventDataMap["quic:packet_dropped"];
const _connectionClose = {
    frame_type: "connection_close",
    error_space: "application",
    error: "http_request_cancelled",
    error_code: 268,
    trigger_frame_type: "stream",
} satisfies QuicFrame;
const _cryptoClose = {
    connection_error: "crypto_error_0x128",
    trigger: "error",
} satisfies EventDataMap["quic:connection_closed"];
const _logLevel = { message: "hello" } satisfies EventDataMap["loglevel:info"];
const _capsule = { stream_id: 0, capsule: { capsule_type: "datagram" } } satisfies EventDataMap["http:capsule_parsed"];

// --- negative cases: these must NOT compile ------------------------------------------------------------------

// @ts-expect-error header is required on packet_sent
const _noHeader: EventDataMap["quic:packet_sent"] = { frames: [] };
// @ts-expect-error CRYPTO frames require raw
const _cryptoNoRaw: QuicFrame = { frame_type: "crypto", offset: 0 };
// @ts-expect-error an ACK range has one or two elements
const _badRange: AckRange = [1, 2, 3];
// @ts-expect-error frame_type does not admit unknown strings (extension frames are QuicExtensionFrame)
const _unknownFrame: QuicFrame = { frame_type: "ack_frequency" };
// @ts-expect-error typo in a member name
const _typo: EventDataMap["quic:recovery_metrics_updated"] = { smoothed_rt: 1 };
// @ts-expect-error ECN is a closed choice
const _badEcn: EventDataMap["quic:udp_datagrams_sent"] = { ecn: ["ECT(2)"] };
// @ts-expect-error GOAWAY carries `id`, not `stream_id`
const _goaway: HTTP3Frame = { frame_type: "goaway", stream_id: 4 };

// --- narrowing and type relations -----------------------------------------------------------------------------

function ackedPacketCount(frame: QuicFrame): number {
    switch (frame.frame_type) {
        case "ack":
            expectTypeOf(frame).toEqualTypeOf<AckFrame>();
            return (frame.acked_ranges ?? []).reduce(
                (sum, [from, to]) => sum + (Number(to ?? from) - Number(from) + 1),
                0,
            );
        case "stream":
            expectTypeOf(frame.stream_id).toEqualTypeOf<Uint64>();
            return 0;
        default:
            return 0;
    }
}

function headerNames(frame: HTTP3Frame): string[] {
    if (frame.frame_type !== "headers") return [];
    expectTypeOf(frame).toEqualTypeOf<HTTP3HeadersFrame>();
    return frame.headers.map((h) => h.name ?? "");
}

describe("schema types against scripts/cddl/sample-valid.sqlog", () => {
    const records = sampleValidSqlog
        .split("\u001e")
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
        .map((r) => JSON.parse(r) as Record<string, unknown>);
    // as the model exposes them: `ev.data` is `any`, consumers cast it through EventDataMap
    const events = records.slice(1) as Array<{ name: string; data: any }>;

    it("the typed literals are verbatim copies of the file's events", () => {
        expect(events.map((e) => ({ name: e.name, data: e.data }))).toEqual(SAMPLE);
    });

    it("every event name in the file is a known latest-draft name", () => {
        for (const e of events) expect(isKnownEventName(e.name), e.name).toBe(true);
    });

    it("typed access works on the parsed data", () => {
        const sent = events[1].data as EventDataOf<typeof QUIC_EVENTS.packet_sent>;
        expect(sent.header.packet_type).toBe("initial");
        expect(sent.raw?.length).toBe(1200);
        const received = events[2].data as EventDataMap["quic:packet_received"];
        expect(ackedPacketCount(received.frames?.[0] as QuicFrame)).toBe(4);
        const headers = events[4].data as EventDataOf<typeof HTTP3_EVENTS.frame_created>;
        expect(headerNames(headers.frame)).toEqual([":method", ":scheme", ":authority", ":path"]);
    });
});

describe("type relations (compile-time)", () => {
    it("EventDataMap is keyed by exactly the known event names", () => {
        expectTypeOf<keyof EventDataMap>().toEqualTypeOf<KnownEventName>();
        expectTypeOf<EventDataOf<"quic:packet_sent">>().toEqualTypeOf<QUICPacketSent>();
        expectTypeOf<EventDataOf<"tcp:packet_sent">>().toEqualTypeOf<Record<string, any>>();
    });

    it("frame type arrays cover every frame of the unions", () => {
        expectTypeOf<(typeof QUIC_FRAME_TYPES)[number]>().toEqualTypeOf<QuicFrameType>();
        expectTypeOf<(typeof HTTP3_FRAME_TYPES)[number]>().toEqualTypeOf<HTTP3FrameType>();
        expectTypeOf<QuicFrameOf<"ack">>().toEqualTypeOf<AckFrame>();
        expectTypeOf<HTTP3FrameOf<"headers">>().toEqualTypeOf<HTTP3HeadersFrame>();
        expect(QUIC_FRAME_TYPES.length).toBe(23);
        expect(HTTP3_FRAME_TYPES.length).toBe(11);
    });
});

// keep the compile-only constants referenced (noUnusedLocals)
void [
    _uint64AsString,
    _openEnum,
    _editorsCopy,
    _reorderingDisabled,
    _keysUnavailable,
    _connectionClose,
    _cryptoClose,
    _logLevel,
    _capsule,
    _noHeader,
    _cryptoNoRaw,
    _badRange,
    _unknownFrame,
    _typo,
    _badEcn,
    _goaway,
];
