// tshark `-T json` (TCP + TLS + HTTP/2) -> qlog with the private tcp:/tls:/http2: namespaces (port of qvis
// TCPToQlog.convert, pcapconverter/tcptoqlog.ts; converters spec sections 3.8-3.9 and 8.6).
//
// One trace per TCP connection, keyed by the endpoint (`ip:port`) that sent the first packet seen ("client"). Per
// packet: one tcp:packet_* event, then its TLS records (tls:record_*), then its HTTP/2 frames (http2:frame_*), all at
// the packet time. The TLS trailer (AEAD tag) size is estimated from records that carry exactly one complete HTTP/2
// frame, and applied retroactively to earlier application records. Finally the events are stable-sorted by time.

import { DiagnosticCollector, missingField } from "../common/diagnostics";
import type { ConverterResult } from "../common/diagnostics";
import { makeQlogFile } from "../common/envelope";
import type { QlogOutputTrace } from "../common/envelope";
import { NO_TCP_CONNECTIONS_TEXT } from "../common/notifications";
import { TcpConnection } from "./connection";
import type { Direction } from "./connection";
import { collectHttp2Frames, headerList } from "./http2";
import { parseJsonWithDuplicateKeys } from "./parseTsharkJson";
import {
    HTTP2_FRAME_CREATED,
    HTTP2_FRAME_PARSED,
    HTTP2_SCHEMA_URI,
    http2FrameTypeName,
    TCP_PACKET_RECEIVED,
    TCP_PACKET_SENT,
    TCP_SCHEMA_URI,
    TLS_RECORD_CREATED,
    TLS_RECORD_PARSED,
    TLS_SCHEMA_URI,
    tlsContentType,
} from "./schema";
import type { HTTP2FrameEventData, TCPPacketEventData, TLSRecordEventData } from "./schema";
import { frameTimeMs } from "./time";
import { collectTlsRecords, EXPECTED_RECORD_FIELDS } from "./tls";
import type { TsharkObject } from "./tls";

export { parseJsonWithDuplicateKeys, TsharkJsonError } from "./parseTsharkJson";
export { epochSecondsStringToMs, isoTimeToMs } from "./time";

export interface TsharkConvertOptions {
    /** T3: tcp flags/ack/window, tls.record.opaque_type fallback, HTTP/2 type names >= 10 (default false) */
    extended?: boolean;
    /** file name, for error messages */
    filename?: string;
}

/** TLS trailer sizes accepted by the estimate: 16 (AEAD tag), 17 (TLS 1.3 tag + inner type), 8 (CCM_8), 24 (GCM nonce + tag). */
const ACCEPTED_TRAILER_SIZES = new Set([16, 17, 8, 24]);

/** One microsecond: the step used to fake an out-of-order timestamp (qvis 0.000001 s). */
const FAKE_TIME_STEP_MS = 0.001;

function isObject(v: unknown): v is TsharkObject {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** qvis `parseInt(x, 10)` (NaN for anything unusable), kept for the arithmetic of the trailer heuristic. */
function pInt(x: unknown): number {
    return typeof x === "string" || typeof x === "number" ? parseInt(String(x), 10) : NaN;
}

function finite(x: number): number | undefined {
    return Number.isFinite(x) ? x : undefined;
}

/** A layer that tshark repeated (e.g. IP-in-IP): use the innermost (last) one. */
function lastLayer(v: unknown): TsharkObject | undefined {
    if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) if (isObject(v[i])) return v[i] as TsharkObject;
        return undefined;
    }
    return isObject(v) ? v : undefined;
}

/** `tls.record.version` "0x00000303" -> "0303" (T2). */
function tlsVersion(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const n = parseInt(v.replace(/^0x/i, ""), 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return undefined;
    return n.toString(16).padStart(4, "0");
}

interface ConvertContext {
    diag: DiagnosticCollector;
    extended: boolean;
    unknownRecordFields: Set<string>;
}

function missing(ctx: ConvertContext, where: string): void {
    missingField(ctx.diag, "tshark", where);
}

/** qvis addEntry (tcptoqlog.ts:160-698): the events of one captured packet. */
function addEntry(ctx: ConvertContext, conn: TcpConnection, direction: Direction, L: TsharkObject): void {
    const { diag } = ctx;
    const frame = isObject(L.frame) ? L.frame : undefined;
    const tcp = lastLayer(L.tcp) as TsharkObject;
    const frameNumber = finite(pInt(frame?.["frame.number"]));
    const sending = direction === "sending";

    // timestamps are often badly ordered (a SYN/ACK supposedly arriving long after the ACK reply...)
    const tracker = conn.timestampTracker[direction];
    let timestamp = frameTimeMs(frame);
    if (Number.isNaN(timestamp)) {
        diag.warn("tshark.bad-timestamp", "Some tshark packets have no usable timestamp; the previous one was used", {
            sample: frameNumber,
        });
        timestamp = tracker.time >= 0 ? tracker.time : 0;
    }
    const seqNr = pInt(tcp["tcp.seq"]);
    if (seqNr < tracker.seq) {
        // this should NEVER happen (retransmission / reordering in the capture)
        diag.info("tshark.seq-unordered", "Some TCP sequence numbers in the capture are not increasing", {
            sample: frameNumber,
        });
    }
    if (timestamp < tracker.time) {
        if (seqNr > tracker.seq) {
            // the order in the JSON is fine, only the timestamps are borked: pretend it arrived at the same time
            timestamp = tracker.time + FAKE_TIME_STEP_MS;
            diag.info(
                "tshark.timestamp-faked",
                "Some packet timestamps were out of order while their sequence numbers were not; their time was moved forward by 1 µs",
                { sample: frameNumber },
            );
            conn.timestampTracker[direction] = { time: timestamp, seq: seqNr };
        } else {
            diag.warn(
                "tshark.timestamp-unordered",
                "Some packets have both timestamps and sequence numbers out of order",
                {
                    sample: frameNumber,
                },
            );
        }
    } else {
        conn.timestampTracker[direction] = { time: timestamp, seq: seqNr };
    }

    // TCP packet
    {
        const hdrLen = finite(pInt(tcp["tcp.hdr_len"]));
        const len = finite(pInt(tcp["tcp.len"]));
        const header: TCPPacketEventData["header"] = { packet_type: "1RTT" };
        const seq = finite(seqNr);
        if (seq !== undefined) header.sequence_number = seq;
        else missing(ctx, "tcp.seq");
        if (hdrLen !== undefined) header.header_length = hdrLen;
        else missing(ctx, "tcp.hdr_len");
        // "QUIC qlog compat mode": the capture frame number acts as packet number
        if (frameNumber !== undefined) header.packet_number = frameNumber;
        if (ctx.extended) {
            const ack = finite(pInt(tcp["tcp.ack"]));
            if (ack !== undefined) header.acknowledgement_number = ack;
            const win = finite(pInt(tcp["tcp.window_size"] ?? tcp["tcp.window_size_value"]));
            if (win !== undefined) header.window_size = win;
            const ft = tcp["tcp.flags_tree"];
            if (isObject(ft)) {
                const flags: NonNullable<TCPPacketEventData["header"]["flags"]> = {};
                for (const [key, name] of [
                    ["tcp.flags.syn", "syn"],
                    ["tcp.flags.ack", "ack"],
                    ["tcp.flags.fin", "fin"],
                    ["tcp.flags.reset", "rst"],
                    ["tcp.flags.push", "psh"],
                ] as const) {
                    if (ft[key] !== undefined) flags[name] = ft[key] === "1" || ft[key] === "True";
                }
                header.flags = flags;
            }
        }
        const raw: TCPPacketEventData["raw"] = {};
        if (hdrLen !== undefined || len !== undefined) raw.length = (hdrLen ?? 0) + (len ?? 0);
        if (len !== undefined) raw.payload_length = len;
        else missing(ctx, "tcp.len");
        const data: TCPPacketEventData = { header, raw };
        if (frameNumber !== undefined) data.capture_frame_number = frameNumber;
        conn.events.push({
            time: timestamp,
            name: sending ? TCP_PACKET_SENT : TCP_PACKET_RECEIVED,
            data: data as unknown as Record<string, unknown>,
        });
    }

    // extract the TLS records and HTTP/2 frames first: the H2 frames are needed to estimate the TLS trailer size
    let TLS: unknown = undefined;
    let records: TsharkObject[] = [];
    // sometimes `tls` is just the string "Transport Layer Security"
    if (L.tls && typeof L.tls !== "string") {
        TLS = L.tls;
        records = collectTlsRecords(TLS, diag);
        if (records.length === 0) {
            // Q7 PARITY: this packet's HTTP/2 frames are dropped too
            diag.warn(
                "tshark.no-tls-record",
                "Some packets have a TLS layer without records; their HTTP/2 frames were skipped",
                { sample: frameNumber },
            );
            return;
        }
    }
    let frames: TsharkObject[] = [];
    let hasHttp = false;
    // sometimes `http2` is just the string "HyperText Transfer Protocol 2"
    if (L.http2 && typeof L.http2 !== "string") {
        hasHttp = true;
        frames = collectHttp2Frames(L.http2, diag);
    }

    if (TLS) {
        {
            // sanity check (qvis "DEBUG: REMOVE")
            let recordLength = 0;
            for (const record of records) {
                if (record["tls.record.content_type"] === "23") recordLength += pInt(record["tls.record.length"]);
            }
            let httpLength = 0;
            for (const f of frames) httpLength += pInt(f["http2.length"]);
            if (Math.abs(recordLength - httpLength) > 500) {
                diag.info(
                    "tshark.frame-size-inconsistency",
                    "Some packets have very different TLS application record and HTTP/2 frame sizes",
                    { sample: frameNumber },
                );
            }
        }

        // all frames of this packet, with their 9-byte headers (the magic counts as 24 + 9 too: Q8 PARITY)
        let totalH2payloadLength = 0;
        for (const f of frames) totalH2payloadLength += pInt(f["http2.length"]) + 9;

        for (const record of records) {
            let contentTypeValue: unknown = record["tls.record.content_type"];
            // T3: with re-ordered packets content_type can be absent while opaque_type (TLS 1.3) is present
            if (!contentTypeValue && ctx.extended) contentTypeValue = record["tls.record.opaque_type"];
            const contentType = tlsContentType(contentTypeValue);

            if (!record["tls.record.length"]) missing(ctx, "tls.record.length");
            const recordLength = pInt(record["tls.record.length"]);
            const appData = record["tls.app_data"];
            if (typeof appData === "string" && appData !== "") {
                const appDataLength = (appData.length + 1) / 3; // "aa:bb:..." -> bytes
                if (appDataLength !== recordLength) {
                    diag.info(
                        "tshark.app-data-length-mismatch",
                        "Some TLS records' length differs from their app_data",
                        {
                            sample: frameNumber,
                        },
                    );
                }
            } else if (contentType === "application") {
                diag.info("tshark.application-without-app-data", "Some TLS application records have no app_data", {
                    sample: frameNumber,
                });
            }

            // Try to find records that contain one complete H2 frame (most connections have some): the difference
            // is the trailer. Dirty, but it works well enough without tracking reassembly across TCP packets.
            const fullPayloadLength = recordLength; // includes all trailers, but not the 5-byte header
            if (
                contentType === "application" &&
                records.length === frames.length &&
                fullPayloadLength - totalH2payloadLength > 0 &&
                !L["tls.segments"] &&
                !(isObject(TLS) && TLS["tls.segment.data"])
            ) {
                const suggested = fullPayloadLength - totalH2payloadLength;
                if (!ACCEPTED_TRAILER_SIZES.has(suggested)) {
                    diag.warn(
                        "tshark.trailer-unexpected-size",
                        "A TLS trailer size estimate was not 16, 17, 8 or 24 bytes and was ignored",
                        { sample: suggested },
                    );
                } else if (!conn.trailerSize) {
                    conn.trailerSize = suggested;
                    conn.trailerEstimatedFromFrame = frameNumber;
                    conn.trailerAdjustedRecords = conn.recordsToAdjust.length;
                    for (const r of conn.recordsToAdjust) {
                        r.header.trailer_length = suggested;
                        if (r.raw.payload_length !== undefined) {
                            r.raw.payload_length -= suggested;
                            if (r.raw.payload_length < 0) {
                                diag.warn(
                                    "tshark.trailer-negative-payload",
                                    "Adjusting TLS records for the estimated trailer size gave a negative payload size",
                                );
                            }
                        }
                        conn.tlsPayloadSize -= suggested;
                    }
                    conn.recordsToAdjust = [];
                } else if (conn.trailerSize !== suggested) {
                    diag.warn(
                        "tshark.trailer-inconsistent",
                        "The estimated TLS trailer size was inconsistent between records; the first estimate was kept",
                        { sample: { estimate: conn.trailerSize, other: suggested, frame: frameNumber } },
                    );
                }
            }

            const trailerSize = conn.trailerSize && contentType === "application" ? conn.trailerSize : 0;

            // defensive: report record fields qvis did not know (qvis showed one alert() per field per record, Q3)
            for (const field of Object.keys(record)) {
                if (!EXPECTED_RECORD_FIELDS.has(field)) ctx.unknownRecordFields.add(field);
            }

            const header: TLSRecordEventData["header"] = {
                content_type: contentType,
                header_length: 5, // TLS record header length is always 5
                trailer_length: trailerSize,
                packet_type: "1RTT", // C9: QUIC qlog compat mode (Stats encryption levels)
            };
            const version = tlsVersion(record["tls.record.version"]);
            if (version !== undefined) header.version = version;
            const raw: TLSRecordEventData["raw"] = {};
            if (Number.isFinite(recordLength)) {
                raw.length = 5 + recordLength;
                raw.payload_length = recordLength - trailerSize;
            }
            const data: TLSRecordEventData = { header, raw };
            if (frameNumber !== undefined) data.capture_frame_number = frameNumber;

            // re-adjusted later when the actual trailer size is known
            if (contentType === "application" && !conn.trailerSize) conn.recordsToAdjust.push(data);
            if (contentType === "application") {
                conn.applicationRecords++;
                if (Number.isFinite(recordLength)) conn.tlsPayloadSize += recordLength - trailerSize;
            }
            if (raw.payload_length === 0) {
                diag.info("tshark.tls-record-without-payload", "Some TLS records have no payload", {
                    sample: frameNumber,
                });
            }
            conn.tlsRecords++;
            conn.usesTls = true;
            conn.events.push({
                time: timestamp,
                name: sending ? TLS_RECORD_CREATED : TLS_RECORD_PARSED,
                data: data as unknown as Record<string, unknown>,
            });
        }
    }

    if (hasHttp) {
        for (const f of frames) {
            // NOTE: an implementation would log frame_created BEFORE packet_sent; from a capture it comes after,
            // which the TCP packetization logic relies on
            const frameType = http2FrameTypeName(f["http2.type"], ctx.extended);
            const frameLength = pInt(f["http2.length"]);
            const headerLength = f["http2.type"] !== "magic" ? 9 : 0;

            const frameData: HTTP2FrameEventData["frame"] = { frame_type: frameType, raw: {} };
            if (frameType === "unknown") {
                const t = pInt(f["http2.type"]);
                if (Number.isFinite(t) && t >= 0 && t <= 255) frameData.frame_type_bytes = t;
            }
            if (frameType === "headers") {
                const list = headerList(f);
                if (list === undefined) {
                    // Q4 (T2): HPACK not decodable (capture started mid-connection): qvis crashed here
                    diag.warn(
                        "tshark.headers-missing",
                        "Some HTTP/2 HEADERS frames have no decoded header list (capture started mid-connection?)",
                        { sample: frameNumber },
                    );
                }
                frameData.headers = [];
                for (const header of list ?? []) {
                    const name = header["http2.header.name"];
                    const value = header["http2.header.value"];
                    const h: { name?: string; value?: string } = {};
                    if (typeof name === "string") h.name = name;
                    if (typeof value === "string") h.value = value;
                    frameData.headers.push(h);
                    if (name === ":authority" && typeof value === "string") {
                        if (!conn.probableUrl) conn.probableUrl = value;
                        else if (conn.probableUrl !== value) {
                            diag.warn(
                                "tshark.conflicting-authority",
                                "A TCP connection carries requests for several :authority values; the first one names the trace",
                                { sample: value },
                            );
                        }
                    }
                }
            }
            if (frameType === "headers" || frameType === "data") {
                const flags = f["http2.flags_tree"];
                if (isObject(flags) && flags["http2.flags.end_stream"]) {
                    frameData.stream_end = flags["http2.flags.end_stream"] === "1";
                }
            }
            if (Number.isFinite(frameLength)) {
                frameData.raw = { length: headerLength + frameLength, payload_length: frameLength };
            } else {
                missing(ctx, "http2.length");
            }
            // key order as in qvis: stream_id, frame
            const streamId = f["http2.type"] !== "magic" ? pInt(f["http2.streamid"]) : -1;
            const data: HTTP2FrameEventData = Number.isFinite(streamId)
                ? { stream_id: streamId, frame: frameData }
                : { frame: frameData };
            if (!Number.isFinite(streamId)) missing(ctx, "http2.streamid");

            if (Number.isFinite(frameLength)) conn.httpTotalSize += headerLength + frameLength;
            conn.h2Frames++;
            conn.usesHttp2 = true;
            conn.events.push({
                time: timestamp,
                name: sending ? HTTP2_FRAME_CREATED : HTTP2_FRAME_PARSED,
                data: data as unknown as Record<string, unknown>,
            });
        }
    }
}

/**
 * Converts tshark `-T json` output (the raw text, parsed with duplicate-key preservation, or an already parsed array)
 * into a QlogFile with one trace per TCP connection. Pure and synchronous. Throws only when the input is not a
 * tshark packet array at all.
 */
export function convertTshark(input: unknown, options: TsharkConvertOptions = {}): ConverterResult {
    const filename = options.filename ?? "tshark JSON";
    const diag = new DiagnosticCollector();
    let packets: unknown = input;
    if (typeof input === "string") {
        try {
            packets = parseJsonWithDuplicateKeys(input);
        } catch (e) {
            throw new Error(
                "Could not parse tshark JSON file " + filename + " : " + (e instanceof Error ? e.message : String(e)),
                { cause: e },
            );
        }
    }
    if (!Array.isArray(packets)) {
        throw new Error("Not a tshark JSON export (expected an array of packets): " + filename);
    }

    const ctx: ConvertContext = { diag, extended: options.extended === true, unknownRecordFields: new Set() };
    // key: "ip:port" of the CLIENT side only (the endpoint that sent the first packet seen)
    const connections = new Map<string, TcpConnection>();
    let tcpPackets = 0;

    for (const entry of packets) {
        const source = isObject(entry) ? entry._source : undefined;
        const L = isObject(source) && isObject(source.layers) ? source.layers : undefined;
        // non-TCP packets (DNS, QUIC/UDP, ARP, ...) are expected in a whole-capture dump: skipped silently
        if (L === undefined || (!L.ip && !L.ipv6) || !L.tcp || lastLayer(L.tcp) === undefined) continue;

        let IP = lastLayer(L.ip);
        let srcField = "ip.src";
        let dstField = "ip.dst";
        if (IP === undefined) {
            IP = lastLayer(L.ipv6);
            srcField = "ipv6.src";
            dstField = "ipv6.dst";
        }
        if (IP === undefined) continue;
        const TCP = lastLayer(L.tcp) as TsharkObject;
        const src = String(IP[srcField]) + ":" + String(TCP["tcp.srcport"]);
        const dst = String(IP[dstField]) + ":" + String(TCP["tcp.dstport"]);

        let direction: Direction = "sending";
        let conn = connections.get(src);
        if (conn === undefined) {
            conn = connections.get(dst);
            direction = "receiving";
        }
        if (conn === undefined) {
            // new connection, always initiated from the client (the first packet seen decides who that is)
            direction = "sending";
            conn = new TcpConnection(src + " -> " + dst);
            connections.set(src, conn);
            const wellKnown = (p: unknown): boolean => p === "443" || p === "80" || p === 443 || p === 80;
            if (wellKnown(TCP["tcp.srcport"]) && !wellKnown(TCP["tcp.dstport"])) {
                diag.warn(
                    "tshark.first-packet-from-server-port",
                    "A TCP connection's first captured packet comes from port 443/80, so client and server may be swapped",
                    { sample: conn.title },
                );
            }
        }
        tcpPackets++;
        addEntry(ctx, conn, direction, L);
    }

    const traces: QlogOutputTrace[] = [];
    for (const conn of connections.values()) {
        conn.title += " => " + (conn.probableUrl ? conn.probableUrl : "Unknown URL");
        if (!conn.trailerSize) {
            const msg =
                "The TLS trailer size could not be estimated for some connections (not decrypted, or no suitable record)";
            if (conn.applicationRecords > 0) diag.warn("tshark.trailer-not-estimated", msg, { sample: conn.title });
            else diag.info("tshark.trailer-not-estimated", msg, { sample: conn.title });
        } else {
            conn.title += " @ " + conn.trailerSize + " TLS trailer size";
        }
        // the order is fixed per direction in addEntry; between directions it is not: stable sort by time
        conn.events.sort((a, b) => a.time - b.time);
        if (conn.h2Frames > 0 && conn.tlsRecords === 0) {
            diag.warn(
                "tshark.h2-without-tls",
                "Some connections carry HTTP/2 without TLS (h2c); the packetization diagram cannot place their frames",
                { sample: conn.title },
            );
        }
        if (conn.httpTotalSize !== conn.tlsPayloadSize) {
            diag.warn(
                "tshark.http-tls-size-mismatch",
                "HTTP/2 does not fully fill the TLS application records of some connections",
                { sample: { connection: conn.title, tls: conn.tlsPayloadSize, http: conn.httpTotalSize } },
            );
        }
        const schemas = [TCP_SCHEMA_URI];
        if (conn.usesTls) schemas.push(TLS_SCHEMA_URI);
        if (conn.usesHttp2) schemas.push(HTTP2_SCHEMA_URI);
        traces.push({
            title: conn.title,
            vantage_point: { type: "client" },
            common_fields: {
                protocol_type: "TCP_HTTP2",
                time_format: "relative_to_epoch",
                reference_time: { clock_type: "system", epoch: "1970-01-01T00:00:00.000Z" },
            },
            event_schemas: schemas,
            events: conn.events,
        });
    }
    if (ctx.unknownRecordFields.size > 0) {
        diag.add("info", "tshark.tls-unknown-record-field", "Some TLS records have fields qvis does not know", {
            count: ctx.unknownRecordFields.size,
            sample: [...ctx.unknownRecordFields].join(", "),
        });
    }
    if (traces.length === 0) diag.warn("tshark.no-tcp-connections", NO_TCP_CONNECTIONS_TEXT);

    let qlogEvents = 0;
    for (const t of traces) qlogEvents += t.events.length;
    const first = [...connections.values()][0];
    return {
        qlog: makeQlogFile(traces),
        diagnostics: diag.toArray(),
        stats: {
            packets: packets.length,
            tcpPackets,
            connections: connections.size,
            qlogEvents,
            trailerSize: first?.trailerSize ?? 0,
            trailerEstimatedFromFrame: first?.trailerEstimatedFromFrame ?? 0,
            trailerAdjustedRecords: first?.trailerAdjustedRecords ?? 0,
        },
    };
}

/**
 * Contract used by the loading layer (src/loading/fileLoader.ts): the raw tshark JSON text (or parsed array) ->
 * latest-draft qlog root. Throws when the input is not tshark JSON or contains no TCP connection.
 */
export function tsharkToQlog(tshark: unknown, filename: string): Record<string, unknown> {
    const { qlog } = convertTshark(tshark, { filename });
    if (qlog.traces.length === 0) throw new Error(NO_TCP_CONNECTIONS_TEXT);
    return qlog as unknown as Record<string, unknown>;
}
