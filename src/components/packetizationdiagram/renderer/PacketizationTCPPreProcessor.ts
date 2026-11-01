// Port of qvis `components/packetizationdiagram/renderer/PacketizationTCPPreProcessor.ts`
// (parity/packetization-diagram.md §3.7, §8.6, §9.7; converter contract parity/converters.md §8.6.1, §8.7, §9.4).
//
// Consumes the private `tcp:` / `tls:` / `http2:` namespaces written by the ported tshark converter. Lane 0: TCP segments
// (header + payload; pure ACKs skipped). Lane 1: TLS records extracted FIFO from the TCP payload byte stream. Lane 2:
// HTTP/2 frames extracted FIFO from the TLS application-data payload bytes. Lane 3: the same H2 pieces coloured by
// stream ID. Field locations (converter contract): sizes in `raw.payload_length` / `frame.raw.*`, the capture frame
// number in `capture_frame_number`. Fixes vs qvis: no alert() (Q-L2), escaped tooltips (Q-X1), no NaN when a size is
// absent (§9.7), diagnostics list.

import { streamIdToColor } from "@/lib/colorHelper";
import type { QlogConnection } from "@/model/QlogConnection";
import { u64 } from "./h3Helpers";
import {
    PacketizationDiagnostics,
    PacketizationDirection,
    extractRanges,
    type LightweightRange,
    type PacketizationLane,
    type PacketizationOptions,
    type PacketizationRange,
    type PacketizationResult,
} from "./PacketizationDiagramModels";
import {
    http2RangeToString,
    http2StreamRangeToString,
    tcpRangeToString,
    tlsRangeToString,
    type HTTPStreamInfoMap,
} from "./tooltips";

export const TCP_PACKET_SENT = "tcp:packet_sent";
export const TCP_PACKET_RECEIVED = "tcp:packet_received";
export const TLS_RECORD_CREATED = "tls:record_created";
export const TLS_RECORD_PARSED = "tls:record_parsed";
export const HTTP2_FRAME_CREATED = "http2:frame_created";
export const HTTP2_FRAME_PARSED = "http2:frame_parsed";

export default class PacketizationTCPPreProcessor {
    public static process(
        tcpConnection: QlogConnection,
        direction: PacketizationDirection,
        options: PacketizationOptions = {},
    ): PacketizationResult {
        const diagnostics = new PacketizationDiagnostics(options.silent);

        const sending = direction === PacketizationDirection.sending;
        const TCPEventType = sending ? TCP_PACKET_SENT : TCP_PACKET_RECEIVED;
        const TLSEventType = sending ? TLS_RECORD_CREATED : TLS_RECORD_PARSED;
        const HTTPEventType = sending ? HTTP2_FRAME_CREATED : HTTP2_FRAME_PARSED;

        let HTTPHeadersSentEventType: string | undefined;
        if (tcpConnection.vantagePoint && tcpConnection.vantagePoint.type === "server") {
            HTTPHeadersSentEventType = HTTP2_FRAME_PARSED; // server receives request
        } else if (tcpConnection.vantagePoint && tcpConnection.vantagePoint.type === "client") {
            HTTPHeadersSentEventType = HTTP2_FRAME_CREATED; // client sends request
        }

        const TCPData: PacketizationRange[] = [];
        const TLSData: PacketizationRange[] = [];
        const HTTPData: PacketizationRange[] = [];
        const StreamData: PacketizationRange[] = [];

        let TCPindex = 0;
        let TLSindex = 0;
        let HTTPindex = 0;

        let TCPmax = 0;
        let packetEventCount = 0;

        let DEBUG_TLSpayloadSize = 0;
        let DEBUG_HTTPtotalSize = 0;

        const TCPPayloadRanges: LightweightRange[] = [];
        const TLSPayloadRanges: LightweightRange[] = [];

        const HTTPStreamInfo: HTTPStreamInfoMap = new Map();

        for (const event of tcpConnection.getEvents()) {
            const name = event.fullName;
            const data = event.data;

            if (name === TCPEventType) {
                // packet_sent or _received, the ones we want to plot
                ++packetEventCount;
                const rawLength = u64(data?.raw?.length);
                let payloadLength = u64(data?.raw?.payload_length);
                const declaredHeaderLength = u64(data?.header?.header_length);
                if (payloadLength === undefined && rawLength !== undefined && declaredHeaderLength !== undefined) {
                    payloadLength = rawLength - declaredHeaderLength;
                }
                if (payloadLength === undefined) {
                    // qvis rendered NaN here (converters §3.10)
                    diagnostics.warn(
                        "PacketizationTCPPreprocessor: TCP packet without raw.payload_length... ignoring",
                        data,
                    );
                    continue;
                }

                if (payloadLength === 0) {
                    // ack, not showing these for now
                    continue;
                }

                const headerLength =
                    declaredHeaderLength ?? (rawLength !== undefined ? rawLength - payloadLength : undefined) ?? 0;
                const length = headerLength + payloadLength;
                const color = TCPindex % 2 === 0 ? "black" : "grey";

                // TCP packet header
                TCPData.push({
                    index: TCPindex,
                    isPayload: false,
                    start: TCPmax,
                    size: headerLength,
                    color,
                    lowerLayerIndex: -1,
                    rawPacket: data,
                });

                // TCP packet payload
                TCPData.push({
                    index: TCPindex,
                    isPayload: true,
                    start: TCPmax + headerLength,
                    size: payloadLength,
                    color,
                    lowerLayerIndex: -1,
                    rawPacket: data,
                });

                TCPPayloadRanges.push({ start: TCPmax + headerLength, size: payloadLength });

                TCPmax += length;
                ++TCPindex;
            } else if (name === TLSEventType) {
                const header = data?.header ?? {};
                const recordHeaderLength = u64(header.header_length) ?? 0;
                const trailerLength = u64(header.trailer_length) ?? 0;
                const payloadLength = Math.max(0, u64(data?.raw?.payload_length) ?? 0);
                const recordLength = recordHeaderLength + payloadLength + trailerLength;
                const contentType = header.content_type;
                const color = TLSindex % 2 === 0 ? "red" : "pink";
                const extra = {
                    DEBUG_wiresharkFrameNumber: data?.capture_frame_number,
                    record_length: recordLength,
                    payload_length: payloadLength,
                };

                // each TLS record is x bytes header (typically 5 bytes), then payload, then MAC or encryption nonce
                // (typically 16 bytes)
                const headerRanges = extractRanges(TCPPayloadRanges, recordHeaderLength, diagnostics);
                for (const headerRange of headerRanges) {
                    TLSData.push({
                        isPayload: false,
                        contentType,
                        index: TLSindex,
                        lowerLayerIndex: TCPindex - 1, // belongs to the "previous" TCP packet
                        start: headerRange.start,
                        size: headerRange.size,
                        color,
                        extra,
                        rawPacket: data,
                    });
                }

                const payloadRanges = extractRanges(TCPPayloadRanges, payloadLength, diagnostics);
                for (const payloadRange of payloadRanges) {
                    TLSData.push({
                        isPayload: true,
                        contentType,
                        index: TLSindex,
                        lowerLayerIndex: TCPindex - 1, // belongs to the "previous" TCP packet
                        start: payloadRange.start,
                        size: payloadRange.size,
                        color,
                        extra,
                        rawPacket: data,
                    });

                    if (contentType === "application") {
                        TLSPayloadRanges.push({ start: payloadRange.start, size: payloadRange.size });
                        DEBUG_TLSpayloadSize += payloadRange.size;
                    }
                }

                if (trailerLength !== 0) {
                    const trailerRanges = extractRanges(TCPPayloadRanges, trailerLength, diagnostics);

                    for (const trailerRange of trailerRanges) {
                        TLSData.push({
                            isPayload: false,
                            contentType,
                            index: TLSindex,
                            lowerLayerIndex: TCPindex - 1, // belongs to the "previous" TCP packet
                            start: trailerRange.start,
                            size: trailerRange.size,
                            color,
                            extra,
                            rawPacket: data,
                        });
                    }
                }

                ++TLSindex;
            } else if (name === HTTPEventType) {
                const frame = data?.frame;
                const frameRawLength = u64(frame?.raw?.length);
                const framePayloadLength = u64(frame?.raw?.payload_length);
                // 9 for every frame, 0 for the client MAGIC preface (converter: raw.length 24 = raw.payload_length)
                const headerLength =
                    frameRawLength !== undefined && framePayloadLength !== undefined
                        ? frameRawLength - framePayloadLength
                        : 0;
                const payloadLength = framePayloadLength ?? 0;
                const extra = { frame_length: headerLength + payloadLength };
                const contentType = data?.content_type; // never set by the converter (PARITY: always undefined)
                const color = HTTPindex % 2 === 0 ? "blue" : "lightblue";
                const streamColor =
                    data?.stream_id !== undefined
                        ? streamIdToColor("" + parseInt(String(data.stream_id), 10), "HTTP2")[0]
                        : undefined;

                if (headerLength > 0) {
                    // MAGIC from client doesn't have a header
                    const headerRanges = extractRanges(TLSPayloadRanges, headerLength, diagnostics);
                    for (const headerRange of headerRanges) {
                        HTTPData.push({
                            isPayload: false,
                            contentType,
                            index: HTTPindex,
                            lowerLayerIndex: TLSindex - 1, // belongs to the "previous" TLS record // TODO: probably wrong
                            start: headerRange.start,
                            size: headerRange.size,
                            color,
                            extra,
                            rawPacket: data,
                        });

                        if (streamColor !== undefined) {
                            StreamData.push({
                                isPayload: true,
                                contentType,
                                index: HTTPindex,
                                lowerLayerIndex: TLSindex - 1,
                                start: headerRange.start,
                                size: headerRange.size,
                                color: streamColor,
                                extra,
                                rawPacket: data,
                            });
                        }
                    }

                    DEBUG_HTTPtotalSize += headerLength;
                }

                // some frames, like SETTINGS, don't necessarily have a payload
                if (payloadLength > 0) {
                    const payloadRanges = extractRanges(TLSPayloadRanges, payloadLength, diagnostics);

                    for (const payloadRange of payloadRanges) {
                        HTTPData.push({
                            isPayload: true,
                            contentType,
                            index: HTTPindex,
                            lowerLayerIndex: TLSindex - 1,
                            start: payloadRange.start,
                            size: payloadRange.size,
                            color,
                            extra,
                            rawPacket: data,
                        });

                        if (streamColor !== undefined) {
                            StreamData.push({
                                isPayload: true,
                                contentType,
                                index: HTTPindex,
                                lowerLayerIndex: TLSindex - 1,
                                start: payloadRange.start,
                                size: payloadRange.size,
                                color: streamColor,
                                extra,
                                rawPacket: data,
                            });
                        }
                    }

                    if (frame && frame.frame_type === "data") {
                        const streamID = parseInt(String(data.stream_id), 10);
                        if (streamID !== 0) {
                            // stream 0 is the HTTP/2 connection stream
                            const info = HTTPStreamInfo.get(streamID);
                            if (!info) {
                                diagnostics.warn(
                                    "PacketizationTCPPreprocessor: trying to increase payload size sum, but streamID not yet known! Potentially Server Push (which we don't support yet)",
                                    streamID,
                                    HTTPStreamInfo,
                                );
                            } else {
                                info.total_size += payloadLength;
                            }
                        }
                    }

                    DEBUG_HTTPtotalSize += payloadLength;
                } else if (frame?.frame_type !== "settings") {
                    // for settings, we know the server sometimes doesn't send anything
                    diagnostics.warn(
                        "PacketizationTCPPreprocessor: Found HTTP frame without payload length... potential error?",
                        data,
                    );
                }

                ++HTTPindex;
            }

            if (
                HTTPHeadersSentEventType !== undefined &&
                name === HTTPHeadersSentEventType &&
                data?.frame?.frame_type === "headers"
            ) {
                // link HTTP stream IDs to the resource URLs that are transported over the stream
                const streamID = parseInt(String(data.stream_id), 10);
                if (!HTTPStreamInfo.has(streamID)) {
                    HTTPStreamInfo.set(streamID, {
                        headers: Array.isArray(data.frame.headers) ? data.frame.headers : [],
                        total_size: 0,
                    });
                } else {
                    diagnostics.warn(
                        "PacketizationTCPPreprocessor: HTTPStreamInfo already had an entry for this stream",
                        streamID,
                        HTTPStreamInfo,
                        data,
                    );
                }
            }
        }

        if (TCPPayloadRanges.length !== 0 || TLSPayloadRanges.length !== 0) {
            diagnostics.warn(
                "PacketizationTCPPreprocessor: Not all payload ranges were used up!",
                TCPPayloadRanges,
                TLSPayloadRanges,
            );
        }

        if (DEBUG_TLSpayloadSize !== DEBUG_HTTPtotalSize) {
            diagnostics.warn(
                "TLS payload size != HTTP payload size",
                "TLS: ",
                DEBUG_TLSpayloadSize,
                "HTTP: ",
                DEBUG_HTTPtotalSize,
                "Diff : ",
                Math.abs(DEBUG_TLSpayloadSize - DEBUG_HTTPtotalSize),
            );
        }

        const lanes: PacketizationLane[] = [
            { name: "TCP", CSSClassName: "tcppacket", ranges: TCPData, rangeToString: tcpRangeToString },
            { name: "TLS", CSSClassName: "tlspacket", ranges: TLSData, rangeToString: tlsRangeToString },
            {
                name: "HTTP/2",
                CSSClassName: "httppacket",
                ranges: HTTPData,
                rangeToString: (r: PacketizationRange) => http2RangeToString(r, HTTPStreamInfo),
            },
            {
                name: "Stream IDs",
                CSSClassName: "streampacket",
                ranges: StreamData,
                rangeToString: (r: PacketizationRange) => http2StreamRangeToString(r, HTTPStreamInfo),
                heightModifier: 0.6,
            },
        ];

        const dir = sending ? "sent" : "received";
        return {
            lanes,
            diagnostics: diagnostics.messages,
            insufficientBytes: diagnostics.insufficientBytes,
            emptyNote:
                TCPData.length > 0
                    ? undefined
                    : packetEventCount > 0
                      ? "No tcp:packet_" + dir + " events with a payload found for this direction"
                      : "No tcp:packet_" + dir + " events found for this direction",
        };
    }
}

export { PacketizationTCPPreProcessor };
