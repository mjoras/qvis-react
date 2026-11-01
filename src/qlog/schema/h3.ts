/**
 * qlog HTTP/3 and HTTP Capsule event schemas: draft-ietf-quic-qlog-h3-events-13
 * (namespaces `http3`, §3-§4, and `http`, the Capsule Protocol, §5-§7).
 *
 * Source of truth: the CDDL of the PUBLISHED draft (scripts/cddl/h3-events-13.cddl, extracted verbatim),
 * digested in docs/dev/qlog-spec/h3-events.md. Interface and type names are the CDDL rule names.
 * Conventions are the same as in ./quic.ts (Uint64, open enums as `Known | OpenString`, no index signatures for
 * the `* $$...-extension` group sockets: use `Extensible<T>`).
 *
 * Union with the editor's copy (h3 digest §11.1), marked `@editors-copy`: `extended_connect` / `h3_datagram` as
 * uint64, `HTTP3ParametersSet.unknown_settings`, `HTTP3OriginFrame.raw`, and the HTTP3ApplicationError values
 * `http_message_error`, `qpack_*`, `http_datagram_error` (next to -13's `http_early_response`).
 *
 * NOTE: the `http` namespace is the HTTP Capsule Protocol (`http:capsule_created` / `http:capsule_parsed`), NOT the
 * pre-final `http:*` HTTP/3 events of older drafts.
 */
import { toNumber } from "../uint64";
import type { HexString, RawInfo, Uint64 } from "./main";
import type { Initiator, OpenString } from "./quic";

// ================================================================================================
// HTTP/3 data types (§4)
// ================================================================================================

/** §3.3 `$HTTP3StreamType` values. */
export const HTTP3_STREAM_TYPES = [
    "request",
    "control",
    "push",
    "reserved",
    "unknown",
    "qpack_encode",
    "qpack_decode",
] as const;
export type KnownHTTP3StreamType = (typeof HTTP3_STREAM_TYPES)[number];
/** §3.3 `$HTTP3StreamType` (open socket). */
export type HTTP3StreamType = KnownHTTP3StreamType | OpenString;

/** §4.2.10. The priority value in ASCII text, encoded using Structured Fields, e.g. "u=5, i". */
export type HTTP3Priority = string;

/** §3.9 */
export type HTTP3PushDecision = "claimed" | "abandoned";

/** §4.2.2. Fall back to the hex `*_bytes` members when `name` / `value` are absent. */
export interface HTTP3HTTPField {
    name?: string;
    name_bytes?: HexString;
    value?: string;
    value_bytes?: HexString;
}

/** §4.2.4 `$HTTP3SettingsName` values. */
export const HTTP3_SETTINGS_NAMES = [
    "settings_qpack_max_table_capacity",
    "settings_max_field_section_size",
    "settings_qpack_blocked_streams",
    "settings_enable_connect_protocol",
    "settings_h3_datagram",
    "reserved",
    "unknown",
] as const;
export type KnownHTTP3SettingsName = (typeof HTTP3_SETTINGS_NAMES)[number];
/** §4.2.4 `$HTTP3SettingsName` (open socket). */
export type HTTP3SettingsName = KnownHTTP3SettingsName | OpenString;

/** §4.2.4 */
export interface HTTP3Setting {
    name?: HTTP3SettingsName;
    /** uint64; only when name === "unknown" (editor's copy: or "reserved") */
    name_bytes?: Uint64;
    value: Uint64;
}

/** §4.2.11 */
export interface HTTP3OriginEntry {
    /** uint16 */
    origin_len: number;
    ascii_origin?: string;
}

// ================================================================================================
// HTTP/3 frames (§4.2)
// ================================================================================================

/** §4.2.1. The payload length is `raw.payload_length` (the old qvis `byte_length`). */
export interface HTTP3DataFrame {
    frame_type: "data";
    raw?: RawInfo;
}

/** §4.2.2 */
export interface HTTP3HeadersFrame {
    frame_type: "headers";
    headers: HTTP3HTTPField[];
    raw?: RawInfo;
}

/** §4.2.3 */
export interface HTTP3CancelPushFrame {
    frame_type: "cancel_push";
    push_id: Uint64;
    raw?: RawInfo;
}

/** §4.2.4 */
export interface HTTP3SettingsFrame {
    frame_type: "settings";
    settings: HTTP3Setting[];
    raw?: RawInfo;
}

/** §4.2.5 */
export interface HTTP3PushPromiseFrame {
    frame_type: "push_promise";
    push_id: Uint64;
    headers: HTTP3HTTPField[];
    raw?: RawInfo;
}

/** §4.2.6 */
export interface HTTP3GoawayFrame {
    frame_type: "goaway";
    /** either a stream_id or a push_id, implicit from the sender of the frame */
    id: Uint64;
    raw?: RawInfo;
}

/** §4.2.7 */
export interface HTTP3MaxPushIDFrame {
    frame_type: "max_push_id";
    push_id: Uint64;
    raw?: RawInfo;
}

/** §4.2.8 */
export interface HTTP3ReservedFrame {
    frame_type: "reserved";
    /** uint64, without variable-length integer encoding */
    frame_type_bytes: Uint64;
    raw?: RawInfo;
}

/** §4.2.9 */
export interface HTTP3UnknownFrame {
    frame_type: "unknown";
    /** uint64, without variable-length integer encoding */
    frame_type_bytes: Uint64;
    raw?: RawInfo;
}

/**
 * §4.2.10 (RFC 9218 extension frame). `stream_id` / `push_id` identify the PRIORITIZED element; the event's own
 * `data.stream_id` is the control stream.
 */
export interface HTTP3PriorityUpdateFrame {
    frame_type: "priority_update";
    /** if the prioritized element is a request stream */
    stream_id?: Uint64;
    /** if the prioritized element is a push stream */
    push_id?: Uint64;
    priority_field_value: HTTP3Priority;
    raw?: RawInfo;
}

/** §4.2.11 (RFC 9412 extension frame) */
export interface HTTP3OriginFrame {
    frame_type: "origin";
    origin_entries: HTTP3OriginEntry[];
    /** @editors-copy */
    raw?: RawInfo;
}

/** §4.2 `HTTP3BaseFrames / HTTP3ExtensionFrames`, discriminated on `frame_type`. */
export type HTTP3Frame =
    | HTTP3DataFrame
    | HTTP3HeadersFrame
    | HTTP3CancelPushFrame
    | HTTP3SettingsFrame
    | HTTP3PushPromiseFrame
    | HTTP3GoawayFrame
    | HTTP3MaxPushIDFrame
    | HTTP3ReservedFrame
    | HTTP3UnknownFrame
    | HTTP3PriorityUpdateFrame
    | HTTP3OriginFrame;

/** Every `frame_type` value of {@link HTTP3Frame}, in -13 order. */
export const HTTP3_FRAME_TYPES = [
    "data",
    "headers",
    "cancel_push",
    "settings",
    "push_promise",
    "goaway",
    "max_push_id",
    "reserved",
    "unknown",
    "priority_update",
    "origin",
] as const satisfies readonly HTTP3Frame["frame_type"][];
export type HTTP3FrameType = HTTP3Frame["frame_type"];

/** The frame with the given `frame_type`, e.g. `HTTP3FrameOf<"headers">` is {@link HTTP3HeadersFrame}. */
export type HTTP3FrameOf<T extends HTTP3FrameType> = Extract<HTTP3Frame, { frame_type: T }>;

/**
 * `$HTTP3Frame /= { * text => any }`: the socket admits any map (frames defined by extensions). Kept out of
 * {@link HTTP3Frame} so that switching on `frame_type` narrows; consumers still need a default branch at runtime.
 */
export interface HTTP3ExtensionFrame {
    frame_type?: string;
    raw?: RawInfo;
    [field: string]: any;
}

const HTTP3_FRAME_TYPE_SET: ReadonlySet<string> = new Set(HTTP3_FRAME_TYPES);

/** True if `frame.frame_type` is one of the HTTP/3 frame types defined by h3-events-13. */
export function isHTTP3Frame(frame: HTTP3Frame | HTTP3ExtensionFrame): frame is HTTP3Frame {
    return typeof frame.frame_type === "string" && HTTP3_FRAME_TYPE_SET.has(frame.frame_type);
}

// ================================================================================================
// HTTP/3 application errors (§4.3); they extend QUIC's `$ApplicationError`
// ================================================================================================

/**
 * §4.3 HTTP3ApplicationError values: the 17 of -13 followed by the 5 the editor's copy adds
 * (`http_message_error` is the editor's name for -13's `http_early_response`, code 0x010e).
 */
export const HTTP3_APPLICATION_ERRORS = [
    "http_no_error",
    "http_general_protocol_error",
    "http_internal_error",
    "http_stream_creation_error",
    "http_closed_critical_stream",
    "http_frame_unexpected",
    "http_frame_error",
    "http_excessive_load",
    "http_id_error",
    "http_settings_error",
    "http_missing_settings",
    "http_request_rejected",
    "http_request_cancelled",
    "http_request_incomplete",
    "http_early_response",
    "http_connect_error",
    "http_version_fallback",
    // @editors-copy
    "http_message_error",
    "qpack_decompression_failed",
    "qpack_encoder_stream_error",
    "qpack_decoder_stream_error",
    "http_datagram_error",
] as const;
/** §4.3 HTTP3ApplicationError (closed in the CDDL; consumers still display unknown strings as-is). */
export type HTTP3ApplicationError = (typeof HTTP3_APPLICATION_ERRORS)[number];

// ================================================================================================
// HTTP/3 events (§3)
// ================================================================================================

/** http3:parameters_set (Base, §3.1). May appear several times (local and remote). */
export interface HTTP3ParametersSet {
    /** "local" for own settings, "remote" for received ones (-13 prose typo says "received") */
    initiator?: Initiator;
    /** RFC 9114 */
    max_field_section_size?: Uint64;
    /** RFC 9204 */
    max_table_capacity?: Uint64;
    /** RFC 9204 */
    blocked_streams_count?: Uint64;
    /** RFC 9220 SETTINGS_ENABLE_CONNECT_PROTOCOL; -13: uint16, editor's copy: uint64 */
    extended_connect?: Uint64;
    /** RFC 9297 SETTINGS_H3_DATAGRAM; -13: uint16, editor's copy: uint64 */
    h3_datagram?: Uint64;
    /** qlog-specific: whether this implementation waits for a SETTINGS frame before processing requests */
    waits_for_settings?: boolean;
    /** @editors-copy settings this implementation does not recognize, including reserved (GREASE) settings */
    unknown_settings?: HTTP3Setting[];
}

/** http3:parameters_restored (Base, §3.2) */
export interface HTTP3ParametersRestored {
    /** RFC 9114 */
    max_field_section_size?: Uint64;
    /** RFC 9204 */
    max_table_capacity?: Uint64;
    /** RFC 9204 */
    blocked_streams_count?: Uint64;
    /** RFC 9220; -13: uint16, editor's copy: uint64 */
    extended_connect?: Uint64;
    /** RFC 9297; -13: uint16, editor's copy: uint64 */
    h3_datagram?: Uint64;
}

/** http3:stream_type_set (Base, §3.3) */
export interface HTTP3StreamTypeSet {
    initiator?: Initiator;
    stream_id: Uint64;
    stream_type: HTTP3StreamType;
    /** uint64; only when stream_type === "unknown" (editor's copy: or "reserved") */
    stream_type_bytes?: Uint64;
    /** uint64; only when stream_type === "push" */
    associated_push_id?: Uint64;
}

/** http3:priority_updated (Base, §3.4) */
export interface HTTP3PriorityUpdated {
    /** if the prioritized element is a request stream */
    stream_id?: Uint64;
    /** if the prioritized element is a push stream */
    push_id?: Uint64;
    old?: HTTP3Priority;
    new: HTTP3Priority;
    trigger?: "client_signal_received" | "local" | "other";
    reason?: "client_signal_only" | "client_server_merged" | "local_policy" | "other";
}

/** http3:frame_created (Core, §3.5). Logged once per frame (for its header), usually BEFORE its packet_sent. */
export interface HTTP3FrameCreated {
    stream_id: Uint64;
    frame: HTTP3Frame;
}

/** http3:frame_parsed (Core, §3.6). Logged once per frame, usually AFTER the packet_received carrying its header. */
export interface HTTP3FrameParsed {
    stream_id: Uint64;
    frame: HTTP3Frame;
}

/** http3:datagram_created (Base, §3.7) */
export interface HTTP3DatagramCreated {
    /** the request stream ID divided by 4 */
    quarter_stream_id: Uint64;
    raw?: RawInfo;
}

/** http3:datagram_parsed (Base, §3.8) */
export interface HTTP3DatagramParsed {
    /** the request stream ID divided by 4 */
    quarter_stream_id: Uint64;
    raw?: RawInfo;
}

/** http3:push_resolved (Extra, §3.9) */
export interface HTTP3PushResolved {
    push_id?: Uint64;
    /** in case this is logged from a place that does not have access to the push_id */
    stream_id?: Uint64;
    decision: HTTP3PushDecision;
}

/** §2 `HTTP3EventData`: every `http3:*` event data type. */
export type HTTP3EventData =
    | HTTP3ParametersSet
    | HTTP3ParametersRestored
    | HTTP3StreamTypeSet
    | HTTP3PriorityUpdated
    | HTTP3FrameCreated
    | HTTP3FrameParsed
    | HTTP3DatagramCreated
    | HTTP3DatagramParsed
    | HTTP3PushResolved;

// ================================================================================================
// HTTP Capsule Protocol (namespace `http`, §5-§7)
// ================================================================================================

/** §7.1.1 */
export interface HTTPCapsuleDatagram {
    capsule_type: "datagram";
    raw?: RawInfo;
}

/** §7.1.2 */
export interface HTTPCapsuleUnknown {
    capsule_type: "unknown";
    /** uint64 */
    capsule_type_value?: Uint64;
    raw?: RawInfo;
}

/** §7.1 `HTTPBaseCapsules`, discriminated on `capsule_type`. */
export type HTTPCapsule = HTTPCapsuleDatagram | HTTPCapsuleUnknown;

/** Every `capsule_type` value of {@link HTTPCapsule}. */
export const HTTP_CAPSULE_TYPES = ["datagram", "unknown"] as const satisfies readonly HTTPCapsule["capsule_type"][];
export type HTTPCapsuleType = HTTPCapsule["capsule_type"];

/** `$HTTPCapsule /= { * text => any }`: capsules defined by extensions. */
export interface HTTPExtensionCapsule {
    capsule_type?: string;
    raw?: RawInfo;
    [field: string]: any;
}

/** http:capsule_created (Core, §6.1) */
export interface HTTPCapsuleCreated {
    stream_id: Uint64;
    capsule: HTTPCapsule;
}

/** http:capsule_parsed (Core, §6.2) */
export interface HTTPCapsuleParsed {
    stream_id: Uint64;
    capsule: HTTPCapsule;
}

/** §5 `HTTPEventData`: every `http:*` event data type. */
export type HTTPEventData = HTTPCapsuleCreated | HTTPCapsuleParsed;

// ================================================================================================
// Reader helpers (h3 digest §8.1), shared by the views (sequence, multiplexing, packetization, stats)
// ================================================================================================

/** uint64 (JSON number or decimal string) -> number for display/arithmetic; anything else -> undefined. */
function u64(v: unknown): number | undefined {
    if (v === undefined || v === null) return undefined;
    const n = toNumber(v);
    return Number.isFinite(n) ? n : undefined;
}

/** Hex string -> Latin-1 text, one character per byte (`*_bytes` members of HTTP3HTTPField). */
export function hexToLatin1(hex: string): string {
    return hex.replace(/../g, (b) => String.fromCharCode(parseInt(b, 16)));
}

type HTTPFieldLike = { name?: unknown; name_bytes?: unknown; value?: unknown; value_bytes?: unknown };

/**
 * HTTP3HTTPField name: `name ?? hexToLatin1(name_bytes)` (§4.2.2, digest §8.1). The text member is returned as
 * logged; undefined when the argument is not an object or neither member is present.
 */
export function fieldName(f: HTTP3HTTPField | HTTPFieldLike | null | undefined): string | undefined {
    if (f === null || typeof f !== "object") return undefined;
    return (f.name ?? (typeof f.name_bytes === "string" ? hexToLatin1(f.name_bytes) : undefined)) as string | undefined;
}

/** HTTP3HTTPField value: `value ?? hexToLatin1(value_bytes)` (§4.2.2, digest §8.1). */
export function fieldValue(f: HTTP3HTTPField | HTTPFieldLike | null | undefined): string | undefined {
    if (f === null || typeof f !== "object") return undefined;
    return (f.value ?? (typeof f.value_bytes === "string" ? hexToLatin1(f.value_bytes) : undefined)) as
        string | undefined;
}

/** QUIC variable-length integer encoded size (RFC 9000 §16). */
export const vlieLength = (v: number): number => (v <= 63 ? 1 : v <= 16383 ? 2 : v <= 1073741823 ? 4 : 8);

/**
 * Wire frame type, only used for its varint size (§4.2; digest §8.1): origin 0x0c, priority_update 0xF0700 /
 * 0xF0701 (push), reserved/unknown from `frame_type_bytes`, anything else 0 (as qvis).
 */
export function h3FrameTypeNumber(
    f: { frame_type?: unknown; push_id?: unknown; frame_type_bytes?: unknown } | null | undefined,
): number {
    switch (f?.frame_type) {
        case "data":
            return 0x00;
        case "headers":
            return 0x01;
        case "cancel_push":
            return 0x03;
        case "settings":
            return 0x04;
        case "push_promise":
            return 0x05;
        case "goaway":
            return 0x07;
        case "origin":
            return 0x0c;
        case "max_push_id":
            return 0x0d;
        case "priority_update":
            return f.push_id !== undefined ? 0xf0701 : 0xf0700;
        case "reserved":
        case "unknown":
            return u64(f.frame_type_bytes) ?? 0;
        default:
            return 0x00;
    }
}

/**
 * HTTP/3 frame PAYLOAD length (replaces draft-02 `byte_length`): `frame.raw.payload_length`, else derived from
 * `frame.raw.length` / `frame.raw.data` assuming minimal varints (digest §8.1). undefined when nothing is logged.
 */
export function h3FramePayloadLength(
    f: { frame_type?: unknown; raw?: unknown } | null | undefined,
): number | undefined {
    const raw = f?.raw as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    const pl = u64(raw.payload_length);
    if (pl !== undefined) return pl;
    const total = u64(raw.length) ?? (typeof raw.data === "string" ? raw.data.length / 2 : undefined);
    if (total === undefined) return undefined;
    const t = vlieLength(h3FrameTypeNumber(f));
    for (const l of [1, 2, 4, 8]) {
        // unique solution assuming minimal varint encoding
        const p = total - t - l;
        if (p >= 0 && vlieLength(p) === l) return p;
    }
    return undefined;
}

/**
 * HTTP/3 frame header length (type varint + length varint). When both `raw.length` and `raw.payload_length` were
 * logged, their difference is used (exact even with non-minimal varints).
 */
export function h3FrameHeaderLength(
    f: { frame_type?: unknown; push_id?: unknown; frame_type_bytes?: unknown; raw?: unknown } | null | undefined,
    payloadLength: number,
): number {
    const raw = f?.raw as Record<string, unknown> | undefined;
    if (raw && typeof raw === "object") {
        const len = u64(raw.length);
        const pl = u64(raw.payload_length);
        if (len !== undefined && pl !== undefined && len - pl > 0) return len - pl;
    }
    return vlieLength(h3FrameTypeNumber(f)) + vlieLength(payloadLength);
}
