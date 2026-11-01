// qvis-private TCP / TLS / HTTP2 event schemas (converters spec section 8.6.1; port of qvis
// pcapconverter/qlog_tcp_tls_h2.ts). No IETF qlog draft defines TCP, TLS-record or HTTP/2 events, so they live in
// private namespaces with private schema URIs (main-schema-14 section 8.1). The CDDL is documented in
// docs/schemas/tcp-tls-http2.md. Detection of TCP traces never depends on the URI: the model uses
// `common_fields.protocol_type === "TCP_HTTP2"` (protocolHint) or the presence of `tcp:` events.

export { HTTP2_SCHEMA_URI, QVIS_SCHEMA_BASE, TCP_SCHEMA_URI, TLS_SCHEMA_URI } from "../common/envelope";

export const TCP_PACKET_SENT = "tcp:packet_sent";
export const TCP_PACKET_RECEIVED = "tcp:packet_received";
export const TLS_RECORD_CREATED = "tls:record_created";
export const TLS_RECORD_PARSED = "tls:record_parsed";
export const HTTP2_FRAME_CREATED = "http2:frame_created";
export const HTTP2_FRAME_PARSED = "http2:frame_parsed";

export interface RawInfo {
    length?: number;
    payload_length?: number;
}

/** tcp:packet_sent / tcp:packet_received */
export interface TCPPacketEventData {
    header: {
        sequence_number?: number;
        header_length?: number;
        /** qvis compatibility (QUIC-shaped views): always "1RTT" */
        packet_type: "1RTT";
        /** capture frame number (qvis compatibility) */
        packet_number?: number;
        // T3 (extended) only
        acknowledgement_number?: number;
        window_size?: number;
        flags?: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean; psh?: boolean };
    };
    /** length = TCP header + payload; payload_length = TCP payload (tcp.len) */
    raw: RawInfo;
    capture_frame_number?: number;
}

export type TLSContentType = "handshake" | "alert" | "application" | "change-cipherspec" | "unknown";

/** tls:record_created / tls:record_parsed */
export interface TLSRecordEventData {
    header: {
        content_type: TLSContentType;
        /** TLS record header, always 5 */
        header_length: 5;
        /** estimated AEAD tag (+ TLS 1.3 inner content type); 0 if not application or not estimated */
        trailer_length: number;
        /** decision C9: kept so the Stats "Encryption levels" count matches qvis */
        packet_type: "1RTT";
        /** tls.record.version, e.g. "0303" (T2) */
        version?: string;
    };
    /** length = 5 + tls.record.length; payload_length = tls.record.length - trailer_length */
    raw: RawInfo;
    capture_frame_number?: number;
}

export type HTTP2FrameType =
    | "data"
    | "headers"
    | "priority"
    | "reset_stream"
    | "settings"
    | "push_promise"
    | "ping"
    | "go_away"
    | "window_update"
    | "continuation"
    | "magic"
    | "unknown"
    // T3 (extended) only
    | "altsvc"
    | "origin"
    | "priority_update";

/** http2:frame_created / http2:frame_parsed */
export interface HTTP2FrameEventData {
    /** -1 for the connection preface ("magic") */
    stream_id?: number;
    frame: {
        frame_type: HTTP2FrameType;
        frame_type_bytes?: number;
        headers?: { name?: string; value?: string }[];
        stream_end?: boolean;
        /** length = 9 + http2.length (24 for magic); payload_length = http2.length */
        raw: RawInfo;
    };
}

/** `http2.type` -> frame_type (qvis HTTP2FrameTypeName, qlog_tcp_tls_h2.ts:131-144). */
export function http2FrameTypeName(type: unknown, extended: boolean): HTTP2FrameType {
    switch (type) {
        case "0":
            return "data";
        case "1":
            return "headers";
        case "2":
            return "priority";
        case "3":
            return "reset_stream";
        case "4":
            return "settings";
        case "5":
            return "push_promise";
        case "6":
            return "ping";
        case "7":
            return "go_away";
        case "8":
            return "window_update";
        case "9":
            return "continuation";
        case "magic":
            return "magic";
        default:
            break;
    }
    if (extended) {
        if (type === "10") return "altsvc";
        if (type === "12") return "origin";
        if (type === "16") return "priority_update";
    }
    return "unknown";
}

/** `tls.record.content_type` -> content_type ("23" application, "22" handshake, "21" alert, "20" change-cipherspec). */
export function tlsContentType(value: unknown): TLSContentType {
    switch (value) {
        case "23":
            return "application";
        case "22":
            return "handshake";
        case "21":
            return "alert";
        case "20":
            return "change-cipherspec";
        default:
            return "unknown";
    }
}
