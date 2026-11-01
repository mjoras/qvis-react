// Port of qvis `components/packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts`
// (parity/packetization-diagram.md §3.6, consolidated latest-draft pseudo-code §8.5, mapping §9).
//
// One pass over ALL events of the trace in model order. Lane 0: QUIC packets (header, payload, 16-byte AEAD trailer).
// Lane 1: QUIC frames inside the packet payloads. Lane 2: HTTP/3 frames mapped FIFO onto the per-stream STREAM-frame
// payload byte ranges. Lane 3: the same HTTP/3 pieces coloured by stream ID.
//
// Latest drafts only: exact full names (quic:packet_sent/received, http3:frame_created/parsed, quic:parameters_set);
// sizes from raw.length / raw.payload_length (packets), frameWireLength/frameDataLength (frames), frame.raw (H3).
// Fixes vs qvis (see the spec): Q-P1, Q-P2, Q-F1..Q-F5, Q-H1..Q-H4, Q-L2, D-PZ7 (frames from quic:frames_* events),
// D-PZ4 (empty-lane note). Nothing here mutates the events.
//
// Things this pre-processor does NOT do (PARITY, §3.6.10): no UDP datagram lane (coalesced packets are laid out back to
// back), no STREAM offset handling (bytes appended per stream in event order, so retransmissions / reordering shift the
// later H3 frames on that stream), no quic:stream_data_moved, packets without `raw` are invisible, lost packets are not
// marked, the stream-type byte of unidirectional H3 streams is not accounted for (Q-H6).

import { streamIdToColor } from "@/lib/colorHelper";
import { HTTP3_EVENTS, NS, QUIC, QUIC_EVENTS } from "@/model/names";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogEvent } from "@/model/QlogEvent";
import { h3FrameHeaderLength, h3FramePayloadLength, u64 } from "./h3Helpers";
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
import { hexByteLength, makeFiller, sizeFrames, splitPacket, type FrameSizingState } from "./quicFrameSizes";
import {
    httpFrameRangeToString,
    quicFrameRangeToString,
    quicRangeToString,
    streamRangeToString,
    type HTTPStreamInfoMap,
} from "./tooltips";

// exact latest-draft names (names.ts); pre-final transport:* / http:* names are never matched (§9.1)
const PACKET_SENT = QUIC_EVENTS.packet_sent;
const PACKET_RECEIVED = QUIC_EVENTS.packet_received;
const FRAME_CREATED = HTTP3_EVENTS.frame_created;
const FRAME_PARSED = HTTP3_EVENTS.frame_parsed;
const PARAMETERS_SET = QUIC_EVENTS.parameters_set;

/** QUIC default max_udp_payload_size (RFC 9000 §18.2). */
export const DEFAULT_MAX_PACKET_SIZE = 65527;

interface QueuedH3Frame {
    /** the http3:frame_* event data (rawPacket of the H3 / stream ranges) */
    data: any;
    payloadLength: number;
    headerLength: number;
}

/**
 * D-PZ7: frames logged separately in quic:frames_created (sent) / quic:frames_parsed + quic:frames_processed
 * (received), keyed by packet number (`frames[i]` belongs to `packet_numbers[i]`; application_data space only).
 */
function buildSeparateFrameIndex(
    connection: QlogConnection,
    direction: PacketizationDirection,
): Map<string, unknown[]> {
    const index = new Map<string, unknown[]>();
    const types =
        direction === PacketizationDirection.sending
            ? [QUIC.frames_created]
            : [QUIC.frames_parsed, QUIC.frames_processed];
    for (const type of types) {
        for (const ev of connection.lookup(NS.quic, type)) {
            const frames = ev.data?.frames;
            const pns = ev.data?.packet_numbers;
            if (!Array.isArray(frames) || !Array.isArray(pns)) continue;
            for (let i = 0; i < frames.length && i < pns.length; i++) {
                const pn = u64(pns[i]);
                if (pn === undefined) continue;
                const key = "" + pn;
                let list = index.get(key);
                if (!list) {
                    list = [];
                    index.set(key, list);
                }
                list.push(frames[i]);
            }
        }
    }
    return index;
}

export default class PacketizationQUICPreProcessor {
    public static process(
        connection: QlogConnection,
        direction: PacketizationDirection,
        options: PacketizationOptions = {},
    ): PacketizationResult {
        const diagnostics = new PacketizationDiagnostics(options.silent);
        const sizingState: FrameSizingState = { frameSizeErrorShown: false };
        let tagWarningShown = false;

        const sending = direction === PacketizationDirection.sending;
        const QUICEventType = sending ? PACKET_SENT : PACKET_RECEIVED;
        const HTTPEventType = sending ? FRAME_CREATED : FRAME_PARSED;

        let HTTPHeadersSentEventType: string | undefined;
        if (connection.vantagePoint && connection.vantagePoint.type === "server") {
            HTTPHeadersSentEventType = FRAME_PARSED; // server receives request
        } else if (connection.vantagePoint && connection.vantagePoint.type === "client") {
            HTTPHeadersSentEventType = FRAME_CREATED; // client sends request
        }

        let max_packet_size_local: number | string = DEFAULT_MAX_PACKET_SIZE;
        let max_packet_size_remote: number | string = DEFAULT_MAX_PACKET_SIZE;

        const QUICPacketData: PacketizationRange[] = [];
        const QUICFrameData: PacketizationRange[] = [];
        const HTTPData: PacketizationRange[] = [];
        const StreamData: PacketizationRange[] = [];

        let QUICPacketIndex = 0;
        let QUICFrameIndex = 0;
        let HTTPindex = 0;

        let QUICmax = 0;

        // these two need to be the same, or there is a problem with the trace
        let DEBUG_QUICpayloadSize = 0;
        let DEBUG_HTTPtotalSize = 0;

        // "efficiency": how much of the QUIC bytes are actually used to transport application-level data
        let QUICtotalSize = 0;
        let HTTPpayloadSize = 0;

        let packetEventCount = 0;

        const QUICPayloadRangesPerStream = new Map<string, LightweightRange[]>();
        const HTTP3OutstandingFramesPerStream = new Map<string, QueuedH3Frame[]>();

        const HTTPStreamInfo: HTTPStreamInfoMap = new Map();

        let separateFrames: Map<string, unknown[]> | undefined; // D-PZ7, built lazily

        // called not just when an H3 frame event is discovered, but also when we find a QUIC STREAM frame for its stream
        const processHTTP3Frames = (outstandingFrames: QueuedH3Frame[], payloadRangesForStream: LightweightRange[]) => {
            while (outstandingFrames.length > 0) {
                const queued = outstandingFrames.shift()!;
                const frameEvt = queued.data;

                // HTTP3 header is always the VLIE-encoded frame_type, followed by the VLIE-encoded payload length.
                // Everything frame-specific counts as payload (consistent with HTTP2)
                const framePayloadLength = queued.payloadLength;
                const frameHeaderLength = queued.headerLength;

                const totalAvailablePayloadSize = payloadRangesForStream.reduce((prev, cur) => prev + cur.size, 0);
                if (totalAvailablePayloadSize < frameHeaderLength + framePayloadLength) {
                    // HTTP3 frame wasn't fully received yet: wait until the WHOLE frame is available
                    outstandingFrames.unshift(queued);
                    break;
                }

                const frameType = frameEvt.frame?.frame_type;
                const extra = { frame_length: frameHeaderLength + framePayloadLength };
                const streamColor =
                    frameEvt.stream_id !== undefined
                        ? streamIdToColor("" + parseInt(String(frameEvt.stream_id), 10), "HTTP3")[0]
                        : undefined;

                const headerRanges = extractRanges(payloadRangesForStream, frameHeaderLength, diagnostics);
                for (const headerRange of headerRanges) {
                    HTTPData.push({
                        isPayload: false,
                        contentType: frameType,
                        index: HTTPindex,
                        lowerLayerIndex: QUICFrameIndex - 1,
                        start: headerRange.start,
                        size: headerRange.size,
                        color: HTTPindex % 2 === 0 ? "blue" : "lightblue",
                        extra,
                        rawPacket: frameEvt,
                    });

                    if (streamColor !== undefined) {
                        StreamData.push({
                            isPayload: true,
                            contentType: frameType,
                            index: HTTPindex,
                            lowerLayerIndex: QUICFrameIndex - 1,
                            start: headerRange.start,
                            size: headerRange.size,
                            color: streamColor,
                            extra,
                            rawPacket: frameEvt,
                        });
                    }
                }

                DEBUG_HTTPtotalSize += frameHeaderLength;

                if (framePayloadLength > 0) {
                    const payloadRanges = extractRanges(payloadRangesForStream, framePayloadLength, diagnostics);

                    for (const payloadRange of payloadRanges) {
                        HTTPData.push({
                            isPayload: true,
                            contentType: frameType,
                            index: HTTPindex,
                            lowerLayerIndex: QUICFrameIndex, // Q-H5 (PRESERVE): global counter, not the true parent
                            start: payloadRange.start,
                            size: payloadRange.size,
                            color: HTTPindex % 2 === 0 ? "blue" : "lightblue",
                            extra,
                            rawPacket: frameEvt,
                        });

                        if (streamColor !== undefined) {
                            StreamData.push({
                                isPayload: true,
                                contentType: frameType,
                                index: HTTPindex,
                                lowerLayerIndex: QUICFrameIndex,
                                start: payloadRange.start,
                                size: payloadRange.size,
                                color: streamColor,
                                extra,
                                rawPacket: frameEvt,
                            });
                        }
                    }

                    if (frameType === "data") {
                        // Q-H3 fix: in HTTP/3, stream 0 is the first request stream (qvis skipped it, an HTTP/2 leftover)
                        const streamID = parseInt(String(frameEvt.stream_id), 10);
                        const info = HTTPStreamInfo.get(streamID);
                        if (!info) {
                            diagnostics.warn(
                                "PacketizationDiagram: trying to increase payload size sum, but streamID not yet known! Potentially Server Push (which we don't support yet)",
                                streamID,
                                HTTPStreamInfo,
                            );
                        } else {
                            info.total_size += framePayloadLength;
                        }
                    }

                    if (frameType === "data" || frameType === "headers") {
                        HTTPpayloadSize += framePayloadLength;
                    }

                    DEBUG_HTTPtotalSize += framePayloadLength;
                }

                ++HTTPindex;
            }
        };

        const layoutPacketFrames = (frames: readonly unknown[], payloadLength: number, frameStartInit: number) => {
            let frameStart = frameStartInit;

            const { sized, offset } = sizeFrames(payloadLength, frames, diagnostics, sizingState);
            // offset != 0: we've guesstimated wrong (or the logged sizes don't add up): add a filler "frame" (Q-F7)
            const list = offset !== 0 ? [makeFiller(offset), ...sized] : sized;

            for (const entry of list) {
                const frame = entry.frame;
                const isFiller = entry.isFiller;

                if (entry.header_size > 0) {
                    QUICFrameData.push({
                        index: isFiller ? -1 : QUICFrameIndex,
                        isPayload: false,
                        start: frameStart,
                        size: entry.header_size,
                        color: isFiller ? "yellow" : QUICFrameIndex % 2 === 0 ? "red" : "pink",
                        contentType: entry.frameType,
                        lowerLayerIndex: QUICPacketIndex,
                        rawPacket: frame,
                    });
                }

                if (entry.payload_size > 0) {
                    QUICFrameData.push({
                        index: QUICFrameIndex,
                        isPayload: true,
                        start: frameStart + entry.header_size,
                        size: entry.payload_size,
                        color: QUICFrameIndex % 2 === 0 ? "red" : "pink",
                        contentType: entry.frameType,
                        lowerLayerIndex: QUICPacketIndex,
                        rawPacket: frame,
                    });

                    if (!isFiller && entry.frameType === "stream") {
                        DEBUG_QUICpayloadSize += entry.payload_size;

                        const key = "" + frame.stream_id;
                        let ranges = QUICPayloadRangesPerStream.get(key);
                        if (!ranges) {
                            ranges = [];
                            QUICPayloadRangesPerStream.set(key, ranges);
                        }

                        ranges.push({ start: frameStart + entry.header_size, size: entry.payload_size });

                        // if H3 frames are longer than their first QUIC frame, we don't get additional events for them
                        // in many logs (proper form would be to log data_moved for them, but no-one is doing this
                        // correctly yet), so re-check every time we add payload ranges if held-back H3 frames fit now
                        const outstandingFrames = HTTP3OutstandingFramesPerStream.get(key);
                        if (outstandingFrames && outstandingFrames.length > 0) {
                            processHTTP3Frames(outstandingFrames, ranges);
                        }
                    }
                }

                frameStart += entry.header_size + entry.payload_size;

                if (!isFiller) {
                    ++QUICFrameIndex;
                }
            }
        };

        const events: readonly QlogEvent[] = connection.getEvents();
        for (const event of events) {
            const name = event.fullName;
            const rawdata = event.data;

            if (name === QUICEventType) {
                // packet_sent or _received
                ++packetEventCount;
                const data = rawdata;

                if (!data || !data.raw || typeof data.raw !== "object") {
                    continue; // SILENT skip (PARITY)
                }

                if (!data.header || !data.header.packet_type) {
                    diagnostics.warn(
                        "PacketizationQUICPreProcessor: packet without header.packet_type set... ignoring",
                        QUICEventType,
                        event.raw,
                    );
                    continue;
                }

                // Q-P2 fix: raw.data is a hexstring (2 chars per byte); never written back into the event
                const totalPacketLength = u64(data.raw.length) || hexByteLength(data.raw.data);
                if (!totalPacketLength) {
                    diagnostics.warn(
                        "PacketizationQUICPreProcessor: packet without raw.length set... ignoring",
                        QUICEventType,
                        event.raw,
                    );
                    continue;
                }

                const packetType = String(data.header.packet_type);
                const split = splitPacket(totalPacketLength, u64(data.raw.payload_length), packetType, () => {
                    if (!tagWarningShown) {
                        diagnostics.warn("raw.payload_length appears to include the AEAD tag");
                        tagWarningShown = true;
                    }
                });
                const headerLength = split.header;
                const payloadLength = split.payload;
                const trailerLength = split.trailer;
                const color = QUICPacketIndex % 2 === 0 ? "black" : "grey";

                // QUIC packet header
                QUICPacketData.push({
                    index: QUICPacketIndex,
                    isPayload: false,
                    start: QUICmax,
                    size: headerLength,
                    color,
                    contentType: packetType,
                    lowerLayerIndex: -1,
                    rawPacket: data,
                });

                // QUIC packet payload
                QUICPacketData.push({
                    index: QUICPacketIndex,
                    isPayload: true,
                    start: QUICmax + headerLength,
                    size: payloadLength,
                    color,
                    contentType: packetType,
                    lowerLayerIndex: -1,
                    rawPacket: data,
                });

                // QUIC trailer (authentication tag)
                if (trailerLength > 0) {
                    QUICPacketData.push({
                        index: QUICPacketIndex,
                        isPayload: false,
                        start: QUICmax + headerLength + payloadLength,
                        size: trailerLength,
                        color,
                        contentType: packetType,
                        lowerLayerIndex: -1,
                        rawPacket: data,
                    });
                }

                // lane 2 : QUIC frames
                let frames: readonly unknown[] | undefined;
                if (Array.isArray(data.frames)) {
                    frames = data.frames; // inline frames always win (an empty array means "no frames", Q-F5)
                } else if (data.frames === undefined && (packetType === "1RTT" || packetType === "0RTT")) {
                    // D-PZ7: frames logged separately with packet_numbers (application_data space only)
                    const pn = u64(data.header.packet_number);
                    if (pn !== undefined) {
                        separateFrames ??= buildSeparateFrameIndex(connection, direction);
                        frames = separateFrames.get("" + pn);
                    }
                }

                if (frames && frames.length > 0) {
                    layoutPacketFrames(frames, payloadLength, QUICmax + headerLength);
                }

                QUICmax += totalPacketLength;
                ++QUICPacketIndex;

                QUICtotalSize += totalPacketLength;
            } else if (name === HTTPEventType) {
                // frame_created or _parsed
                const data = rawdata;

                // Q-H1 fix: a payload length of 0 is valid (empty SETTINGS)
                const payloadLength = h3FramePayloadLength(data?.frame);
                if (payloadLength === undefined) {
                    diagnostics.warn(
                        "H3 frame didn't have a payload length (frame.raw.payload_length / frame.raw.length) set! skipping...",
                        data,
                    );
                    continue;
                }

                const key = "" + data.stream_id;
                const payloadRangesForStream = QUICPayloadRangesPerStream.get(key);

                if (!payloadRangesForStream && !sending) {
                    // Q-H2 fix: qvis dropped the frame here; it is queued like on the sending side (frame_created
                    // precedes packet_sent) and placed when the stream's STREAM bytes arrive
                    diagnostics.warn(
                        "No payload ranges known for this stream_id, skipping...",
                        payloadRangesForStream,
                        data.stream_id,
                    );
                }

                let outstandingFrames = HTTP3OutstandingFramesPerStream.get(key);
                if (!outstandingFrames) {
                    outstandingFrames = [];
                    HTTP3OutstandingFramesPerStream.set(key, outstandingFrames);
                }

                // H3 frames can be much longer than 1 QUIC packet, but are typically logged after the first QUIC packet
                // they appear in (where the frame header is in), so we hold back frames until they can be fully placed
                outstandingFrames.push({
                    data,
                    payloadLength,
                    headerLength: h3FrameHeaderLength(data.frame, payloadLength),
                });

                if (payloadRangesForStream) {
                    processHTTP3Frames(outstandingFrames, payloadRangesForStream);
                }
            }

            if (
                HTTPHeadersSentEventType !== undefined &&
                name === HTTPHeadersSentEventType &&
                rawdata &&
                rawdata.frame &&
                rawdata.frame.frame_type === "headers"
            ) {
                // link HTTP stream IDs to the resource URLs that are transported over the stream
                const streamID = parseInt(String(rawdata.stream_id), 10);
                if (!HTTPStreamInfo.has(streamID)) {
                    HTTPStreamInfo.set(streamID, {
                        headers: Array.isArray(rawdata.frame.headers) ? rawdata.frame.headers : [],
                        total_size: 0,
                    });
                } else {
                    diagnostics.warn(
                        "PacketizationQUICPreprocessor: HTTPStreamInfo already had an entry for this stream",
                        streamID,
                        HTTPStreamInfo,
                        rawdata,
                    );
                }
            }

            if (name === PARAMETERS_SET && rawdata) {
                // owner -> initiator, max_packet_size -> max_udp_payload_size (last value wins, printed as logged)
                const value = rawdata.max_udp_payload_size;
                if (rawdata.initiator === "local") {
                    if (u64(value)) {
                        max_packet_size_local = value;
                    }
                } else if (rawdata.initiator === "remote") {
                    if (u64(value)) {
                        max_packet_size_remote = value;
                    }
                }
            }
        } // end looping over all events

        let controlStreamData = 0;
        for (const [streamKey, ranges] of QUICPayloadRangesPerStream.entries()) {
            // 0, 4, 8 and 1, 5, 9 etc. are bidirectional data streams; 2, 6, 10 and 3, 7, 11 etc. are unidirectional
            // control streams and implementations don't always log frames for them (e.g., QPACK), so leftover data is
            // "normal" there; checked below with DEBUG_HTTPtotalSize
            const streamID = parseInt(streamKey, 10);
            if ((streamID + 1) % 4 === 0 || (streamID + 2) % 4 === 0) {
                for (const range of ranges) {
                    controlStreamData += range.size;
                }
            } else if (ranges.length !== 0) {
                diagnostics.warn(
                    "PacketizationQUICPreprocessor: Not all QUIC payload ranges were used up!",
                    streamKey,
                    JSON.stringify(ranges),
                    HTTP3OutstandingFramesPerStream.get(streamKey),
                );
            }
        }

        for (const [streamKey, frames] of HTTP3OutstandingFramesPerStream.entries()) {
            if (frames.length !== 0) {
                diagnostics.warn(
                    "PacketizationQUICPreprocessor: Not all HTTP3 frames found a home!",
                    streamKey,
                    frames.map((f) => f.data),
                );
            }
        }

        if (DEBUG_QUICpayloadSize !== DEBUG_HTTPtotalSize) {
            const adjustedHTTPsizeForControlStreams = DEBUG_HTTPtotalSize + controlStreamData;

            if (DEBUG_QUICpayloadSize !== adjustedHTTPsizeForControlStreams) {
                diagnostics.warn(
                    "QUIC payload size != HTTP3 payload size",
                    "QUIC: ",
                    DEBUG_QUICpayloadSize,
                    "HTTP: ",
                    DEBUG_HTTPtotalSize,
                    "HTTP leftover on control streams: ",
                    controlStreamData,
                    "Diff : ",
                    Math.abs(DEBUG_QUICpayloadSize - DEBUG_HTTPtotalSize),
                );
            }
        }

        const efficiency = HTTPpayloadSize / QUICtotalSize; // NaN when there are no packets

        const lanes: PacketizationLane[] = [
            {
                name: "QUIC packets",
                CSSClassName: "quicpacket",
                ranges: QUICPacketData,
                rangeToString: quicRangeToString,
                max_size_local: max_packet_size_local,
                max_size_remote: max_packet_size_remote,
                efficiency,
            },
            {
                name: "QUIC frames",
                CSSClassName: "quicframe",
                ranges: QUICFrameData,
                rangeToString: quicFrameRangeToString,
            },
            {
                name: "HTTP/3",
                CSSClassName: "httpframe",
                ranges: HTTPData,
                rangeToString: (r: PacketizationRange) => httpFrameRangeToString(r, HTTPStreamInfo),
            },
            {
                name: "Stream IDs",
                CSSClassName: "streampacket",
                ranges: StreamData,
                rangeToString: (r: PacketizationRange) => streamRangeToString(r, HTTPStreamInfo),
                heightModifier: 0.6,
            },
        ];

        return {
            lanes,
            diagnostics: diagnostics.messages,
            insufficientBytes: diagnostics.insufficientBytes,
            emptyNote:
                QUICPacketData.length > 0
                    ? undefined
                    : PacketizationQUICPreProcessor.emptyNote(connection, direction, packetEventCount),
        };
    }

    /** D-PZ4 (§9.9): why lane 0 is empty, first matching text wins. */
    public static emptyNote(
        connection: QlogConnection,
        direction: PacketizationDirection,
        packetEventCount: number,
    ): string {
        const dir = direction === PacketizationDirection.sending ? "sent" : "received";
        if (connection.lookup("transport", "packet_" + dir).length > 0) {
            return (
                "This trace uses pre-standard event names (transport:packet_" +
                dir +
                "); only quic:packet_" +
                dir +
                " is supported"
            );
        }
        if (packetEventCount > 0) {
            return "No quic:packet_" + dir + " events with raw.length found for this direction";
        }
        return "No quic:packet_" + dir + " events found for this direction";
    }
}

export { PacketizationQUICPreProcessor };
