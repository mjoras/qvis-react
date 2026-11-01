// Tooltip texts of every lane (parity/packetization-diagram.md §3.11, verbatim qvis wording incl. its quirks Q-T1/Q-T2).
// Q-X1 FIX: every interpolated value is HTML-escaped; only the literal `<br/>` and `<b>…</b>` markup of the format
// strings stays markup. Values print as JavaScript `String(value)` (an absent value prints "undefined"), as in qvis.

import { fieldName, fieldValue } from "./h3Helpers";
import type { PacketizationRange } from "./PacketizationDiagramModels";

const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** `String(v)` with HTML special characters escaped. */
export function esc(v: unknown): string {
    return String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Request info per stream ID (`parseInt(stream_id, 10)` keys), collected from the request-direction HEADERS frames. */
export interface HTTPStreamInfoEntry {
    headers: unknown[];
    total_size: number;
}
export type HTTPStreamInfoMap = Map<number, HTTPStreamInfoEntry>;

/** STREAMINFO suffix: `<br/>method: path<br/>total resource size: n<br/>` (Q-H8: last :method / :path wins). */
function streamInfoText(streamID: unknown, HTTPStreamInfo: HTTPStreamInfoMap): string {
    const streamInfo = HTTPStreamInfo.get(parseInt(String(streamID), 10));
    if (!streamInfo) {
        return "";
    }
    let text = "<br/>";
    let method: unknown = "";
    let path: unknown = "";
    for (const header of Array.isArray(streamInfo.headers) ? streamInfo.headers : []) {
        const name = fieldName(header as any);
        if (name === ":method") {
            method = fieldValue(header as any);
        } else if (name === ":path") {
            path = fieldValue(header as any);
        }
    }
    text += "" + esc(method) + ": " + esc(path) + "<br/>";
    text += "total resource size: " + esc(streamInfo.total_size) + "<br/>";
    return text;
}

// ---------------------------------------------------------------- QUIC + HTTP/3

export function quicRangeToString(data: PacketizationRange): string {
    let text = "QUIC ";

    text +=
        (data.isPayload ? "Payload #" : data.size === 16 ? "Trailer (authentication tag) #" : "Header #") +
        esc(data.index) +
        " : size " +
        esc(data.size) +
        "<br/>";
    text +=
        "Packet type : " +
        esc(data.contentType) +
        ", Packet nr : " +
        esc(data.rawPacket?.header?.packet_number) +
        "<br/>";

    return text;
}

export function quicFrameRangeToString(data: PacketizationRange): string {
    let text = "QUIC Frame #" + esc(data.index) + " : size " + esc(data.size) + "<br/>";
    text +=
        "Frame type : " +
        esc(data.contentType) +
        ", stream ID: " +
        esc(data.rawPacket && data.rawPacket.stream_id !== undefined ? data.rawPacket.stream_id : "none") +
        "<br/>";
    if (data.rawPacket && data.rawPacket.fin === true) {
        text += "<b>FIN BIT SET</b>";
    }

    return text;
}

export function httpFrameRangeToString(data: PacketizationRange, HTTPStreamInfo: HTTPStreamInfoMap): string {
    let text = "H3 ";
    text +=
        (data.isPayload ? "Payload #" : "Header #") +
        esc(data.index) +
        " (QUIC frame index: " +
        esc(data.lowerLayerIndex) +
        ") : frame size " +
        esc(data.extra?.frame_length) +
        ", partial size : " +
        esc(data.size) +
        "<br/>";
    text += "frame type: " + esc(data.rawPacket?.frame?.frame_type) + ", streamID: " + esc(data.rawPacket?.stream_id);
    text += streamInfoText(data.rawPacket?.stream_id, HTTPStreamInfo);

    return text;
}

export function streamRangeToString(data: PacketizationRange, HTTPStreamInfo: HTTPStreamInfoMap): string {
    let text = "H3 ";
    text += "streamID: " + esc(data.rawPacket?.stream_id);
    text += streamInfoText(data.rawPacket?.stream_id, HTTPStreamInfo);

    return text;
}

// ---------------------------------------------------------------- TCP + TLS + HTTP/2

export function tcpRangeToString(data: PacketizationRange): string {
    let text = "TCP ";
    text +=
        (data.isPayload ? "Payload #" : "Header #") + esc(data.index) + " : packet size " + esc(data.size) + "<br/>";

    return text;
}

export function tlsRangeToString(data: PacketizationRange): string {
    let text = "TLS ";
    text +=
        (data.isPayload ? "Payload #" : data.size > 5 ? "Trailer (MAC/auth tag/padding/content type) " : "Header #") +
        esc(data.index);
    text +=
        " (TCP index: " +
        esc(data.lowerLayerIndex) +
        ") : record size " +
        esc(data.extra?.record_length) +
        ", partial size " +
        esc(data.size) +
        "<br/>";

    if (data.extra?.DEBUG_wiresharkFrameNumber) {
        text += "Wireshark frame number (DEBUG): " + esc(data.extra.DEBUG_wiresharkFrameNumber) + "<br/>";
    }

    text += "content type: " + esc(data.contentType);

    return text;
}

export function http2RangeToString(data: PacketizationRange, HTTPStreamInfo: HTTPStreamInfoMap): string {
    let text = "H2 ";
    // Q-T2 (PRESERVE): no index after "#", and "frame size" is the payload length
    text +=
        (data.isPayload ? "Payload #" : "Header #") +
        " (TLS index: " +
        esc(data.lowerLayerIndex) +
        ") : frame size " +
        esc(data.rawPacket?.frame?.raw?.payload_length) +
        ", partial size : " +
        esc(data.size) +
        "<br/>";
    text += "frame type: " + esc(data.rawPacket?.frame?.frame_type) + ", streamID: " + esc(data.rawPacket?.stream_id);

    if (data.rawPacket?.frame?.stream_end) {
        text += "<br/>";
        text += "<b>STREAM END BIT SET</b>";
    }

    text += streamInfoText(data.rawPacket?.stream_id, HTTPStreamInfo);

    return text;
}

export function http2StreamRangeToString(data: PacketizationRange, HTTPStreamInfo: HTTPStreamInfoMap): string {
    let text = "H2 ";
    text += "streamID: " + esc(data.rawPacket?.stream_id);

    if (data.rawPacket?.frame?.stream_end) {
        text += "<br/>";
        text += "<b>STREAM END BIT SET</b>";
    }

    text += streamInfoText(data.rawPacket?.stream_id, HTTPStreamInfo);

    return text;
}
