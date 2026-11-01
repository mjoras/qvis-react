// The NetLog event -> latest-draft qlog mapping (converters spec section 8.4; qvis netlogtoqlog.ts:293-867).
//
// T1 = the qvis mapping with the new names/fields, T2 = always-on fixes, T3 = `extended` (default off) and
// `splitCoalescedReceived`. Every input value is read through num()/u64(), because Chrome writes numbers that do not
// fit in int32 as decimal strings.

import type { DiagnosticCollector } from "../common/diagnostics";
import { missingField } from "../common/diagnostics";
import { num, u64 } from "../common/num";
import { ownValue } from "../common/own";
import { calculateAckRanges } from "./ackRanges";
import { cryptoErrorName, h3AppErrorName, transportErrorName } from "./errors";
import { mapSettings, parseHeaders } from "./h3";
import type { Frame, NetlogSession, RxPacket } from "./session";
import { PARAMETERS_RESTORED_KEYS, parseChromiumTransportParameters } from "./transportParams";

export interface NetlogMapContext {
    diag: DiagnosticCollector;
    extended: boolean;
    splitCoalescedReceived: boolean;
    /** netlog event type -> count of events that have no mapping (one aggregated info diagnostic) */
    unsupported: Map<string, number>;
}

type Params = Record<string, unknown>;

/** Table 3.4a: `encryption_level` -> packet_type (QUIC_SESSION_PACKET_SENT and the undecryptable-packet events). */
const ENCRYPTION_LEVEL_TO_TYPE: Readonly<Record<string, string>> = {
    ENCRYPTION_INITIAL: "initial",
    ENCRYPTION_HANDSHAKE: "handshake",
    ENCRYPTION_ZERO_RTT: "0RTT",
    ENCRYPTION_FORWARD_SECURE: "1RTT",
};

/** Table 3.4b: `long_header_type` -> packet_type; absent or anything else (short header, gQUIC) is 1RTT. */
function longHeaderToType(t: unknown): string {
    switch (t) {
        case "INITIAL":
            return "initial";
        case "HANDSHAKE":
            return "handshake";
        case "ZERO_RTT_PROTECTED":
            return "0RTT";
        case "RETRY":
            return "retry";
        case "VERSION_NEGOTIATION":
            return "version_negotiation";
        case "INVALID_PACKET_TYPE":
            return "unknown";
        default:
            return "1RTT";
    }
}

function levelToType(ctx: NetlogMapContext, level: unknown, eventType: string): string {
    const t = typeof level === "string" ? ownValue(ENCRYPTION_LEVEL_TO_TYPE, level) : undefined;
    if (t !== undefined) return t;
    if (level !== undefined) {
        ctx.diag.warn("netlog.unknown-encryption-level", "Some netlog packets have an unknown encryption level", {
            sample: eventType + ": " + String(level),
        });
    }
    return "unknown";
}

/**
 * Chrome version labels (ParsedQuicVersionToString) -> QuicVersion hex (section 9.7). Unknown labels give undefined.
 */
export function versionLabelToHex(label: string): string | undefined {
    const l = label.trim();
    if (l === "RFCv1") return "00000001";
    if (l === "RFCv2") return "6b3343cf";
    if (l === "draft29") return "ff00001d";
    if (/^[0-9a-f]{8}$/i.test(l)) return l.toLowerCase();
    if (/^[A-Z][0-9]{3}$/.test(l)) {
        let hex = "";
        for (let i = 0; i < 4; i++) hex += l.charCodeAt(i).toString(16).padStart(2, "0");
        return hex;
    }
    return undefined;
}

function versionList(v: unknown): string[] {
    const labels = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [];
    const out: string[] = [];
    for (const label of labels) {
        if (label === "") continue;
        const hex = versionLabelToHex(label);
        if (hex !== undefined) out.push(hex);
    }
    return out;
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

/** Lowercase hexstring, quiche's "0" for an empty connection ID -> "", undefined when not hex. */
function hexOf(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    let h = v.toLowerCase().replace(/^0x/, "");
    if (h === "0") h = "";
    return HEX_RE.test(h) ? h : undefined;
}

/** Netlog event types that qvis handled without output (no diagnostic) and that have no T3 mapping. */
const IGNORED = new Set([
    "QUIC_SESSION_CRYPTO_HANDSHAKE_MESSAGE_SENT",
    "QUIC_SESSION_CRYPTO_HANDSHAKE_MESSAGE_RECEIVED",
    "QUIC_SESSION_COALESCED_PACKET_SENT",
    "QUIC_SESSION_CLOSE_ON_ERROR",
    "QUIC_CHROMIUM_CLIENT_STREAM_SEND_REQUEST_HEADERS",
    "QUIC_CHROMIUM_CLIENT_STREAM_READ_RESPONSE_HEADERS",
    "QUIC_SESSION_ATTEMPTING_TO_PROCESS_UNDECRYPTABLE_PACKET",
    "QUIC_SESSION_PACKET_AUTHENTICATED",
    "QUIC_SESSION_STREAM_FRAME_COALESCED",
    "QUIC_SESSION_CERTIFICATE_VERIFIED",
]);

/**
 * Event types with a T3 mapping that are silent (no output, no diagnostic) with `extended: false`: qvis had a case
 * for them (VERSION_NEGOTIATED, HANDSHAKE_DONE, CLOSED, BUFFERED, MAX_PUSH_ID, PRIORITY_UPDATE, DATA_SENT, UNKNOWN_FRAME,
 * HEADERS_RECEIVED), or section 8.4 "Further T3 rows" keeps them silent.
 */
const SILENT_UNLESS_EXTENDED = new Set([
    "QUIC_SESSION_VERSION_NEGOTIATED",
    "QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED",
    "QUIC_SESSION_CLOSED",
    "QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET",
    "HTTP3_MAX_PUSH_ID_SENT",
    "HTTP3_MAX_PUSH_ID_RECEIVED",
    "HTTP3_PRIORITY_UPDATE_SENT",
    "HTTP3_PRIORITY_UPDATE_RECEIVED",
    "HTTP3_DATA_SENT",
    "HTTP3_UNKNOWN_FRAME_RECEIVED",
    "HTTP3_HEADERS_RECEIVED",
    "QUIC_SESSION_VERSION_NEGOTIATION_PACKET_RECEIVED",
    "QUIC_SESSION_CRYPTO_HANDSHAKE_COMPLETE",
    "QUIC_SESSION_DUPLICATE_PACKET_RECEIVED",
    "HTTP3_CANCEL_PUSH_RECEIVED",
    "QUIC_SESSION_ORIGIN_FRAME_RECEIVED",
]);

function unsupported(ctx: NetlogMapContext, eventType: string): void {
    ctx.unsupported.set(eventType, (ctx.unsupported.get(eventType) ?? 0) + 1);
}

function missing(ctx: NetlogMapContext, eventType: string, field: string): void {
    missingField(ctx.diag, "netlog", eventType + "." + field);
}

/**
 * Application error (RST_STREAM / STOP_SENDING, decision C10): `error` name, `error_code` only when unknown. `code` is
 * the raw netlog value, so a uint64 beyond 2^53 keeps its exact decimal string (C12).
 */
function applicationError(frame: Frame, code: unknown, fallbackCode: unknown): void {
    const n = num(code);
    if (n !== undefined) {
        const name = h3AppErrorName(n);
        frame.error = name ?? "unknown";
        if (name === undefined) {
            const raw = u64(code);
            if (raw !== undefined) frame.error_code = raw;
        }
        return;
    }
    frame.error = "unknown";
    const fb = u64(fallbackCode);
    if (fb !== undefined) frame.error_code = fb;
}

function connectionCloseFrame(ctx: NetlogMapContext, p: Params): Frame {
    const isApplication = typeof p.close_type === "string" && /application/i.test(p.close_type);
    const frame: Frame = { frame_type: "connection_close", error_space: isApplication ? "application" : "transport" };
    const wire = num(p.quic_wire_error ?? p.quic_error);
    const name = isApplication
        ? h3AppErrorName(wire)
        : (transportErrorName(wire) ?? cryptoErrorName(wire) ?? undefined);
    frame.error = name ?? "unknown";
    if (name === undefined && wire !== undefined) {
        const code = u64(p.quic_wire_error ?? p.quic_error);
        if (code !== undefined) frame.error_code = code;
    }
    if (typeof p.details === "string") frame.reason = p.details;
    // Chromium's internal QuicErrorCode (spec 8.4: frame extension `chromium_quic_error`) is not emitted: the -13 CDDL
    // frame maps are closed (the validator rejects unknown frame keys); T3 quic:connection_closed carries it instead
    if (ctx.extended && p.transport_close_frame_type !== undefined) {
        const t = u64(p.transport_close_frame_type);
        frame.trigger_frame_type = t !== undefined ? t : String(p.transport_close_frame_type);
    }
    return frame;
}

function packetNumberInto(ctx: NetlogMapContext, header: Record<string, unknown>, v: unknown, where: string): void {
    const pn = u64(v);
    if (pn !== undefined) header.packet_number = pn;
    else missing(ctx, where, "packet_number");
}

/** HTTP/3 frame event on a stream (frame_created when the netlog type contains "SENT", else frame_parsed). */
function pushH3Frame(s: NetlogSession, eventType: string, time: number, streamId: unknown, frame: Frame): void {
    s.push(time, eventType.indexOf("SENT") >= 0 ? "http3:frame_created" : "http3:frame_parsed", {
        stream_id: streamId,
        frame,
    });
}

/** T3 HTTP/3 control-stream frames: the side's control stream id, or undefined (+ diagnostic) when unknown. */
function controlStreamOf(ctx: NetlogMapContext, s: NetlogSession, eventType: string): unknown {
    const id = eventType.indexOf("SENT") >= 0 ? s.controlStream.local : s.controlStream.remote;
    if (id === undefined) missing(ctx, eventType, "control_stream_id");
    return id;
}

function startRxPacket(ctx: NetlogMapContext, s: NetlogSession, time: number, p: Params): void {
    const data: RxPacket["data"] = { header: { packet_type: "unknown" } }; // placeholder, filled in below
    const size = u64(p.size);
    if (size !== undefined) data.raw = { length: size };
    else missing(ctx, "QUIC_SESSION_PACKET_RECEIVED", "size");
    let datagramId: number | undefined;
    if (ctx.splitCoalescedReceived) {
        datagramId = s.datagramCounter++;
        data.datagram_id = datagramId;
        const udp: Record<string, unknown> = { count: 1 };
        if (size !== undefined) udp.raw = [{ length: size }];
        udp.datagram_ids = [datagramId];
        s.push(time, "quic:udp_datagrams_received", udp);
    }
    // push the placeholder right away, so its time and position are those of PACKET_RECEIVED (PARITY)
    s.push(time, "quic:packet_received", data);
    // frames buffered since the previous PACKET_RECEIVED belong to the previous packet
    s.attachRxFrames();
    s.rxPacket = { data, emitted: true, hasHeader: false, datagramId };
}

function onPacketHeader(ctx: NetlogMapContext, s: NetlogSession, eventType: string, time: number, p: Params): void {
    const packetType = longHeaderToType(p.long_header_type);
    if (s.rxPacket === undefined) {
        // header before any PACKET_RECEIVED: no length, never shown (PARITY)
        s.rxPacket = { data: { header: { packet_type: packetType } }, emitted: false, hasHeader: false };
    } else if (ctx.splitCoalescedReceived && s.rxPacket.hasHeader && s.rxPacket.emitted) {
        // T3: a second header after one PACKET_RECEIVED is the next packet coalesced in the same datagram
        s.attachRxFrames();
        const data: RxPacket["data"] = { header: { packet_type: packetType } };
        const datagramId = s.rxPacket.datagramId;
        if (datagramId !== undefined) data.datagram_id = datagramId;
        s.push(time, "quic:packet_received", data);
        s.rxPacket = { data, emitted: true, hasHeader: false, datagramId };
    }
    const header = s.rxPacket.data.header;
    header.packet_type = packetType;
    packetNumberInto(ctx, header, p.packet_number, eventType);
    s.rxPacket.hasHeader = true;
}

/** Maps one netlog event of a QUIC_SESSION source. `time` is relative to the session's first event (ms). */
export function mapNetlogEvent(
    ctx: NetlogMapContext,
    s: NetlogSession,
    eventType: string,
    phase: string,
    time: number,
    params: Params,
): void {
    const p = params;
    const ext = ctx.extended;
    switch (eventType) {
        case "QUIC_SESSION": {
            // creates the trace only (PARITY); T3: the offered versions
            if (ext && phase === "PHASE_BEGIN") {
                const versions = versionList(p.versions);
                if (versions.length > 0) s.push(time, "quic:version_information", { client_versions: versions });
            }
            return;
        }

        case "QUIC_SESSION_TRANSPORT_PARAMETERS_SENT":
        case "QUIC_SESSION_TRANSPORT_PARAMETERS_RECEIVED": {
            if (typeof p.quic_transport_parameters !== "string") {
                missing(ctx, eventType, "quic_transport_parameters");
                return;
            }
            const data: Record<string, unknown> = {
                initiator: eventType.endsWith("_SENT") ? "local" : "remote",
                ...parseChromiumTransportParameters(p.quic_transport_parameters),
            };
            s.usesQuicChromium = true; // chromium_raw (and maybe chromium_extra)
            s.push(time, "quic:parameters_set", data);
            return;
        }

        case "QUIC_SESSION_CRYPTO_FRAME_SENT":
        case "QUIC_SESSION_CRYPTO_FRAME_RECEIVED": {
            const frame: Frame = { frame_type: "crypto" };
            const offset = u64(p.offset);
            if (offset !== undefined) frame.offset = offset;
            else missing(ctx, eventType, "offset");
            // quic-13: "The length field of the Crypto frame MUST be logged in the qlog raw.length field"
            const length = u64(p.data_length);
            frame.raw = length !== undefined ? { length } : {};
            if (length === undefined) missing(ctx, eventType, "data_length");
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_PADDING_FRAME_SENT":
        case "QUIC_SESSION_PADDING_FRAME_RECEIVED": {
            const frame: Frame = { frame_type: "padding" };
            if (ext) {
                const n = u64(p.num_padding_bytes);
                if (n !== undefined) frame.raw = { payload_length: n };
            }
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_PING_FRAME_SENT":
        case "QUIC_SESSION_PING_FRAME_RECEIVED":
            s.pushFrame(eventType, { frame_type: "ping" });
            return;

        case "QUIC_SESSION_STREAM_FRAME_SENT":
        case "QUIC_SESSION_STREAM_FRAME_RECEIVED": {
            const streamId = u64(p.stream_id);
            if (streamId === undefined) {
                missing(ctx, eventType, "stream_id");
                return;
            }
            const frame: Frame = { frame_type: "stream", stream_id: streamId };
            const offset = u64(p.offset);
            if (offset !== undefined) frame.offset = offset;
            if (typeof p.fin === "boolean") frame.fin = p.fin;
            const length = u64(p.length);
            if (length !== undefined) frame.raw = { length };
            else missing(ctx, eventType, "length");
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_ACK_FRAME_SENT":
        case "QUIC_SESSION_ACK_FRAME_RECEIVED": {
            const frame: Frame = { frame_type: "ack" };
            const largest = num(p.largest_observed);
            if (largest === undefined) {
                missing(ctx, eventType, "largest_observed");
            } else {
                const { ranges, noSmallest } = calculateAckRanges(
                    largest,
                    num(p.smallest_observed),
                    Array.isArray(p.missing_packets) ? p.missing_packets : undefined,
                );
                if (noSmallest) {
                    ctx.diag.warn(
                        "netlog.ack.no-smallest-observed",
                        "Some netlog ACK frames have no smallest_observed (old Chrome bug 1112925); their first range was guessed",
                        { sample: eventType },
                    );
                }
                // quic-13 AckFrame: `? acked_ranges: [+ AckRange]`, so never an empty list (e.g. when every range
                // is inverted because the missing packets cover smallest..largest): omit it (section 9.1 rule 6)
                if (ranges.length > 0) frame.acked_ranges = ranges;
                else missing(ctx, eventType, "acked_ranges");
            }
            if (ext) {
                const delay = num(p.delta_time_largest_observed_us);
                if (delay !== undefined) frame.ack_delay = delay / 1000;
                for (const [from, to] of [
                    ["ECT0", "ect0"],
                    ["ECT1", "ect1"],
                    ["CE", "ce"],
                ] as const) {
                    const v = u64(p[from]);
                    if (v !== undefined) frame[to] = v;
                }
            }
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_WINDOW_UPDATE_FRAME_SENT":
        case "QUIC_SESSION_WINDOW_UPDATE_FRAME_RECEIVED": {
            const maximum = u64(p.byte_offset);
            if (maximum === undefined) missing(ctx, eventType, "byte_offset");
            if (num(p.stream_id) === -1 || p.stream_id === "18446744073709551615") {
                const frame: Frame = { frame_type: "max_data" };
                if (maximum !== undefined) frame.maximum = maximum;
                s.pushFrame(eventType, frame);
            } else {
                const streamId = u64(p.stream_id);
                if (streamId === undefined) {
                    missing(ctx, eventType, "stream_id");
                    return;
                }
                // gQUIC uses stream 0 for the connection; PARITY: still treated as stream 0
                const frame: Frame = { frame_type: "max_stream_data", stream_id: streamId };
                if (maximum !== undefined) frame.maximum = maximum;
                s.pushFrame(eventType, frame);
            }
            return;
        }

        case "QUIC_SESSION_RST_STREAM_FRAME_SENT":
        case "QUIC_SESSION_RST_STREAM_FRAME_RECEIVED": {
            const streamId = u64(p.stream_id);
            if (streamId === undefined) {
                missing(ctx, eventType, "stream_id");
                return;
            }
            const frame: Frame = { frame_type: "reset_stream", stream_id: streamId };
            applicationError(frame, p.ietf_error_code, p.quic_rst_stream_error);
            const finalSize = u64(p.offset);
            if (finalSize !== undefined) frame.final_size = finalSize;
            else missing(ctx, eventType, "offset");
            // the internal quic_rst_stream_error (spec 8.4: `chromium_rst_stream_error`) is not emitted: closed frame maps
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_STOP_SENDING_FRAME_SENT":
        case "QUIC_SESSION_STOP_SENDING_FRAME_RECEIVED": {
            const streamId = u64(p.stream_id);
            if (streamId === undefined) {
                missing(ctx, eventType, "stream_id");
                return;
            }
            const frame: Frame = { frame_type: "stop_sending", stream_id: streamId };
            // Q15: current Chrome logs ietf_error_code (+ quic_rst_stream_error), 2020 Chrome application_error_code
            applicationError(frame, p.ietf_error_code ?? p.application_error_code, p.quic_rst_stream_error);
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT":
            s.txFrames.push(connectionCloseFrame(ctx, p));
            return;

        case "QUIC_SESSION_CONNECTION_CLOSE_FRAME_RECEIVED":
            if (!ext) break;
            s.rxFrames.push(connectionCloseFrame(ctx, p));
            return;

        case "QUIC_SESSION_PACKET_SENT": {
            const header: Record<string, unknown> = { packet_type: levelToType(ctx, p.encryption_level, eventType) };
            packetNumberInto(ctx, header, p.packet_number, eventType);
            const data: Record<string, unknown> = { header, frames: s.txFrames };
            s.txFrames = [];
            const size = u64(p.size);
            if (size !== undefined) data.raw = { length: size };
            else missing(ctx, eventType, "size");
            if (ext) {
                if (p.transmission_type === "PTO_RETRANSMISSION") data.trigger = "pto_probe";
                if (s.mtuProbePending) data.is_mtu_probe_packet = true;
                if (header.packet_number !== undefined) {
                    s.sentPacketTypes.set(String(header.packet_number), header.packet_type);
                }
            }
            s.mtuProbePending = false;
            s.push(time, "quic:packet_sent", data);
            return;
        }

        case "QUIC_SESSION_PACKET_RECEIVED":
            startRxPacket(ctx, s, time, p);
            return;

        case "QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED":
            onPacketHeader(ctx, s, eventType, time, p);
            return;

        case "QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED":
        case "QUIC_SESSION_HANDSHAKE_DONE_FRAME_SENT":
            // qvis: no frame (Q18); T3 adds it to the packet
            if (!ext) break;
            s.pushFrame(eventType, { frame_type: "handshake_done" });
            return;

        case "QUIC_SESSION_PACKET_LOST": {
            const header: Record<string, unknown> = { packet_type: "unknown" };
            packetNumberInto(ctx, header, p.packet_number, eventType);
            if (ext && header.packet_number !== undefined) {
                // T3: the type of the latest earlier packet_sent with this number (heuristic: PN spaces overlap)
                const t = s.sentPacketTypes.get(String(header.packet_number));
                if (t !== undefined) header.packet_type = t;
            }
            s.push(time, "quic:packet_lost", { header });
            return;
        }

        case "QUIC_SESSION_CLOSED": {
            if (!ext) break;
            const data: Record<string, unknown> = { initiator: p.from_peer === true ? "remote" : "local" };
            const code = u64(p.quic_error);
            if (code !== undefined) data.internal_code = code;
            if (typeof p.details === "string") data.reason = p.details;
            s.push(time, "quic:connection_closed", data);
            return;
        }

        case "QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET":
            if (!ext) break;
            s.push(time, "quic:packet_buffered", {
                header: { packet_type: levelToType(ctx, p.encryption_level, eventType) },
                trigger: "keys_unavailable",
            });
            return;

        case "QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET":
            // T2: all four encryption levels (qvis only mapped HANDSHAKE); -13 trigger spelling
            s.push(time, "quic:packet_dropped", {
                header: { packet_type: levelToType(ctx, p.encryption_level, eventType) },
                trigger: "key_unavailable",
            });
            return;

        case "HTTP3_PEER_CONTROL_STREAM_CREATED":
        case "HTTP3_LOCAL_CONTROL_STREAM_CREATED":
        case "HTTP3_PEER_QPACK_DECODER_STREAM_CREATED":
        case "HTTP3_LOCAL_QPACK_DECODER_STREAM_CREATED":
        case "HTTP3_PEER_QPACK_ENCODER_STREAM_CREATED":
        case "HTTP3_LOCAL_QPACK_ENCODER_STREAM_CREATED": {
            const streamId = u64(p.stream_id);
            if (streamId === undefined) {
                missing(ctx, eventType, "stream_id");
                return;
            }
            const initiator = eventType.indexOf("PEER") >= 0 ? "remote" : "local";
            const streamType = eventType.endsWith("_CONTROL_STREAM_CREATED")
                ? "control"
                : eventType.endsWith("_QPACK_DECODER_STREAM_CREATED")
                  ? "qpack_decode"
                  : "qpack_encode";
            if (streamType === "control") s.controlStream[initiator] = streamId;
            s.push(time, "http3:stream_type_set", { initiator, stream_id: streamId, stream_type: streamType });
            return;
        }

        case "HTTP3_SETTINGS_SENT":
        case "HTTP3_SETTINGS_RECEIVED": {
            const data: Record<string, unknown> = {
                initiator: eventType.indexOf("SENT") >= 0 ? "local" : "remote",
                ...mapSettings(p, ext),
            };
            if (data.chromium_settings !== undefined || data.unknown_settings !== undefined) {
                s.usesHttp3Chromium = true;
            }
            s.push(time, "http3:parameters_set", data);
            return;
        }

        case "HTTP3_SETTINGS_RESUMED": {
            if (!ext) break;
            const all = mapSettings(p, true);
            const data: Record<string, unknown> = {};
            for (const k of [
                "max_field_section_size",
                "max_table_capacity",
                "blocked_streams_count",
                "extended_connect",
                "h3_datagram",
            ]) {
                if (all[k] !== undefined) data[k] = all[k];
            }
            s.push(time, "http3:parameters_restored", data);
            return;
        }

        case "QUIC_SESSION_TRANSPORT_PARAMETERS_RESUMED": {
            if (!ext) break;
            if (typeof p.quic_transport_parameters !== "string") {
                missing(ctx, eventType, "quic_transport_parameters");
                return;
            }
            const parsed = parseChromiumTransportParameters(p.quic_transport_parameters);
            const data: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(parsed)) if (PARAMETERS_RESTORED_KEYS.has(k)) data[k] = v;
            s.usesQuicChromium = true;
            s.push(time, "quic:parameters_restored", data);
            return;
        }

        case "HTTP3_HEADERS_SENT":
        case "HTTP3_HEADERS_DECODED": {
            const streamId = u64(p.stream_id);
            if (streamId === undefined) {
                missing(ctx, eventType, "stream_id");
                return;
            }
            const frame: Frame = { frame_type: "headers", headers: parseHeaders(p.headers) };
            if (ext && eventType === "HTTP3_HEADERS_DECODED") {
                const key = String(streamId);
                const len = s.pendingHeadersLength.get(key);
                if (len !== undefined) {
                    frame.raw = { payload_length: len };
                    s.pendingHeadersLength.delete(key);
                }
            }
            pushH3Frame(s, eventType, time, streamId, frame);
            return;
        }

        case "HTTP3_HEADERS_RECEIVED": {
            if (!ext) break;
            const streamId = u64(p.stream_id);
            const len = u64(p.payload_length ?? p.compressed_headers_length);
            if (streamId !== undefined && len !== undefined) s.pendingHeadersLength.set(String(streamId), len);
            return;
        }

        case "HTTP3_DATA_FRAME_RECEIVED":
        case "HTTP3_DATA_SENT": {
            if (eventType === "HTTP3_DATA_SENT" && !ext) break;
            const streamId = u64(p.stream_id);
            if (streamId === undefined) {
                missing(ctx, eventType, "stream_id");
                return;
            }
            // qvis: event-level byte_length; -13: the DATA frame's payload length
            const frame: Frame = { frame_type: "data" };
            const len = u64(p.payload_length);
            if (len !== undefined) frame.raw = { payload_length: len };
            else missing(ctx, eventType, "payload_length");
            pushH3Frame(s, eventType, time, streamId, frame);
            return;
        }

        case "HTTP3_UNKNOWN_FRAME_RECEIVED": {
            if (!ext) break;
            const streamId = u64(p.stream_id);
            const typeBytes = u64(p.frame_type);
            if (streamId === undefined || typeBytes === undefined) {
                missing(ctx, eventType, streamId === undefined ? "stream_id" : "frame_type");
                return;
            }
            const frame: Frame = { frame_type: "unknown", frame_type_bytes: typeBytes };
            const len = u64(p.payload_length);
            if (len !== undefined) frame.raw = { payload_length: len };
            pushH3Frame(s, eventType, time, streamId, frame);
            return;
        }

        case "HTTP3_MAX_PUSH_ID_SENT":
        case "HTTP3_MAX_PUSH_ID_RECEIVED": {
            if (!ext) break;
            const pushId = u64(p.push_id);
            const control = controlStreamOf(ctx, s, eventType);
            if (pushId === undefined || control === undefined) return;
            pushH3Frame(s, eventType, time, control, { frame_type: "max_push_id", push_id: pushId });
            return;
        }

        case "HTTP3_PRIORITY_UPDATE_SENT":
        case "HTTP3_PRIORITY_UPDATE_RECEIVED": {
            if (!ext) break;
            const control = controlStreamOf(ctx, s, eventType);
            if (control === undefined || typeof p.priority_field_value !== "string") return;
            const frame: Frame = { frame_type: "priority_update" };
            const element = u64(p.prioritized_element_id);
            if (element !== undefined) {
                if (p.type === "push_stream") frame.push_id = element;
                else frame.stream_id = element;
            }
            frame.priority_field_value = p.priority_field_value;
            pushH3Frame(s, eventType, time, control, frame);
            return;
        }

        case "HTTP3_GOAWAY_SENT":
        case "HTTP3_GOAWAY_RECEIVED": {
            if (!ext) break;
            const control = controlStreamOf(ctx, s, eventType);
            const id = u64(p.stream_id ?? p.id);
            if (control === undefined || id === undefined) return;
            pushH3Frame(s, eventType, time, control, { frame_type: "goaway", id });
            return;
        }

        case "HTTP3_CANCEL_PUSH_RECEIVED": {
            if (!ext) break;
            const control = controlStreamOf(ctx, s, eventType);
            const pushId = u64(p.push_id);
            if (control === undefined || pushId === undefined) return;
            pushH3Frame(s, eventType, time, control, { frame_type: "cancel_push", push_id: pushId });
            return;
        }

        case "QUIC_SESSION_ORIGIN_FRAME_RECEIVED": {
            if (!ext) break;
            const control = controlStreamOf(ctx, s, eventType);
            if (control === undefined || !Array.isArray(p.origins)) return;
            const entries = p.origins.map((o) => {
                const origin = String(o);
                return { origin_len: origin.length, ascii_origin: origin };
            });
            pushH3Frame(s, eventType, time, control, { frame_type: "origin", origin_entries: entries });
            return;
        }

        case "QUIC_SESSION_VERSION_NEGOTIATED": {
            if (!ext) break;
            const v = typeof p.version === "string" ? versionLabelToHex(p.version) : undefined;
            if (v !== undefined) s.push(time, "quic:version_information", { chosen_version: v });
            return;
        }

        case "QUIC_SESSION_VERSION_NEGOTIATION_PACKET_RECEIVED": {
            if (!ext) break;
            const versions = versionList(p.versions);
            if (versions.length === 0) return;
            if (s.rxPacket?.emitted && s.rxPacket.data.header.packet_type === "version_negotiation") {
                s.rxPacket.data.supported_versions = versions;
            }
            s.push(time, "quic:version_information", { server_versions: versions });
            return;
        }

        case "QUIC_SESSION_CRYPTO_HANDSHAKE_COMPLETE":
            if (!ext) break;
            s.push(time, "quic:connection_state_updated", { new: "handshake_complete" });
            return;

        case "QUIC_SESSION_DUPLICATE_PACKET_RECEIVED": {
            if (!ext) break;
            const header: Record<string, unknown> = {
                packet_type: s.rxPacket !== undefined ? s.rxPacket.data.header.packet_type : "unknown",
            };
            packetNumberInto(ctx, header, p.packet_number ?? p.packet_sequence_number, eventType);
            s.push(time, "quic:packet_dropped", { header, trigger: "duplicate" });
            return;
        }

        // current-Chrome frame events (T3 only)
        case "QUIC_SESSION_NEW_CONNECTION_ID_FRAME_SENT":
        case "QUIC_SESSION_NEW_CONNECTION_ID_FRAME_RECEIVED": {
            if (!ext) break;
            const seq = u64(p.sequence_number);
            const retire = u64(p.retire_prior_to);
            const cid = hexOf(p.connection_id);
            if (seq === undefined || retire === undefined || cid === undefined) {
                missing(
                    ctx,
                    eventType,
                    seq === undefined ? "sequence_number" : retire === undefined ? "retire_prior_to" : "connection_id",
                );
                return;
            }
            s.pushFrame(eventType, {
                frame_type: "new_connection_id",
                sequence_number: seq,
                retire_prior_to: retire,
                connection_id: cid,
            });
            return;
        }

        case "QUIC_SESSION_RETIRE_CONNECTION_ID_FRAME_SENT":
        case "QUIC_SESSION_RETIRE_CONNECTION_ID_FRAME_RECEIVED": {
            if (!ext) break;
            const seq = u64(p.sequence_number);
            if (seq === undefined) {
                missing(ctx, eventType, "sequence_number");
                return;
            }
            s.pushFrame(eventType, { frame_type: "retire_connection_id", sequence_number: seq });
            return;
        }

        case "QUIC_SESSION_MAX_STREAMS_FRAME_SENT":
        case "QUIC_SESSION_MAX_STREAMS_FRAME_RECEIVED":
        case "QUIC_SESSION_STREAMS_BLOCKED_FRAME_SENT":
        case "QUIC_SESSION_STREAMS_BLOCKED_FRAME_RECEIVED": {
            if (!ext) break;
            const count = u64(p.stream_count);
            if (count === undefined) {
                missing(ctx, eventType, "stream_count");
                return;
            }
            const streamType = p.is_unidirectional === true ? "unidirectional" : "bidirectional";
            s.pushFrame(
                eventType,
                eventType.indexOf("MAX_STREAMS") >= 0
                    ? { frame_type: "max_streams", stream_type: streamType, maximum: count }
                    : { frame_type: "streams_blocked", stream_type: streamType, limit: count },
            );
            return;
        }

        case "QUIC_SESSION_PATH_CHALLENGE_FRAME_SENT":
        case "QUIC_SESSION_PATH_CHALLENGE_FRAME_RECEIVED":
        case "QUIC_SESSION_PATH_RESPONSE_FRAME_SENT":
        case "QUIC_SESSION_PATH_RESPONSE_FRAME_RECEIVED": {
            if (!ext) break;
            const frame: Frame = {
                frame_type: eventType.indexOf("PATH_CHALLENGE") >= 0 ? "path_challenge" : "path_response",
            };
            const data = hexOf(p.data);
            if (data !== undefined) frame.data = data;
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_NEW_TOKEN_FRAME_SENT":
        case "QUIC_SESSION_NEW_TOKEN_FRAME_RECEIVED": {
            if (!ext) break;
            const data = hexOf(p.token);
            s.pushFrame(eventType, { frame_type: "new_token", token: data !== undefined ? { raw: { data } } : {} });
            return;
        }

        case "QUIC_SESSION_MESSAGE_FRAME_SENT":
        case "QUIC_SESSION_MESSAGE_FRAME_RECEIVED": {
            if (!ext) break;
            const frame: Frame = { frame_type: "datagram" };
            const len = u64(p.message_length);
            if (len !== undefined) frame.raw = { length: len };
            s.pushFrame(eventType, frame);
            return;
        }

        case "QUIC_SESSION_MTU_DISCOVERY_FRAME_SENT":
            if (!ext) break;
            s.pushFrame(eventType, { frame_type: "ping" });
            s.mtuProbePending = true;
            return;

        case "QUIC_SESSION_BLOCKED_FRAME_SENT":
        case "QUIC_SESSION_BLOCKED_FRAME_RECEIVED":
        case "QUIC_SESSION_STOP_WAITING_FRAME_SENT":
        case "QUIC_SESSION_STOP_WAITING_FRAME_RECEIVED":
        case "QUIC_SESSION_GOAWAY_FRAME_SENT":
        case "QUIC_SESSION_GOAWAY_FRAME_RECEIVED":
            // no qlog equivalent with the required fields: nothing, also with T3
            if (!ext) break;
            return;

        case "CERT_VERIFIER_REQUEST":
            // qvis: info:marker with a string; -13 needs an object (decision C8). PHASE_NONE also gives END (PARITY)
            s.push(time, "loglevel:info", {
                message: phase === "PHASE_BEGIN" ? "CERT_VERIFIER_REQUEST BEGIN" : "CERT_VERIFIER_REQUEST END",
            });
            return;

        default:
            break;
    }
    if (IGNORED.has(eventType) || SILENT_UNLESS_EXTENDED.has(eventType)) return;
    // Q22: one aggregated diagnostic per type instead of a console.warn per event
    unsupported(ctx, eventType);
}
