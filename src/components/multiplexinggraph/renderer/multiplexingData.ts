// Pure data extraction for the multiplexing graph (no D3, no DOM). Ported from the data halves of qvis
// MultiplexingGraphD3CollapsedRenderer.ts (renderLive, :148-519), MultiplexingGraphD3WaterfallRenderer.ts
// (renderLive, :87-346) and MultiplexingGraphD3ByterangesRenderer.ts (updateZoom, :176-225), mapped to the latest qlog
// drafts as specified in docs/dev/parity/multiplexing-graph.md §9 (§9.8 is the normative reference implementation).
//
// Console policy (M32 FIX): every qvis console.error for a routine condition is emitted at console.debug level, so
// spurious retransmissions etc. never produce console errors. The one qvis console.warn ("stream has holes") is kept.

import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogEvent } from "@/model/QlogEvent";
import { HTTP3_EVENTS, NS, QUIC, QUIC_EVENTS } from "@/model/names";
import { fieldName, fieldValue } from "@/qlog/schema/h3";

// ================================================================================================
// Options (§9.10)
// ================================================================================================

export interface MuxOptions {
    /** D-MX1 (§9.6.1): use quic:frames_* events when the packet events of a direction carry no STREAM frames */
    readonly frameEventFallback: boolean;
    /** D-MX2 (§9.3): infer the perspective from the first packet event when type/flow give none */
    readonly inferUnknownPerspective: boolean;
    /** D-MX3 (§9.4.5): skip quic:stream_data_moved with to: "network" */
    readonly skipMovesToNetwork: boolean;
}

export const MUX_OPTIONS: MuxOptions = {
    frameEventFallback: true,
    inferUnknownPerspective: true,
    skipMovesToNetwork: true,
};

// ================================================================================================
// Field accessors (§4 integer parsing, §9.4, ecosystem.md §6.6, h3-events.md §8.1)
// ================================================================================================

const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** uint64 as a JSON number or a decimal string; anything else is undefined (§4, integer parsing). */
export function u64(v: unknown): number | undefined {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
    return undefined;
}

/** Client-initiated bidirectional stream = HTTP/3 request stream (qvis MultiplexingGraphDataHelper.isDataStream). */
export const isDataStream = (sid: number | undefined): sid is number => sid !== undefined && sid % 4 === 0;

/**
 * STREAM data length (§9.6.5): `raw.payload_length ?? raw.length`. Only reads `raw` when it is an object (a legacy hex
 * string has a `.length` too). Never derived from `raw.data`. The pre-final top-level `length` is NOT accepted (strict
 * latest drafts: quic-events-13 §8.13.9 moved it into `raw.length`).
 */
export function streamFrameDataLength(f: unknown): number | undefined {
    if (!isObject(f) || !isObject(f.raw)) return undefined;
    return u64(f.raw.payload_length) ?? u64(f.raw.length);
}

/** HTTP3HTTPField name / value (h3-events.md §8.1): shared helpers from src/qlog/schema/h3.ts. */
export { fieldName, fieldValue };

// ================================================================================================
// Perspective and event names (§3.2, §9.3, §9.6.1)
// ================================================================================================

export type Perspective = "client" | "server";

/** §9.3: type client/server, else flow (M21 FIX), else D-MX2 heuristic, else client (qvis default). */
export function getPerspective(conn: QlogConnection, opts: MuxOptions = MUX_OPTIONS): Perspective {
    const p = conn.getVantagePointPerspective();
    if (p === "client" || p === "server") return p;
    if (opts.inferUnknownPerspective) {
        // "in QUIC, the client always sends the first packet" (main-schema-14 §6)
        for (const ev of conn.getEvents()) {
            if (ev.fullName === QUIC_EVENTS.packet_sent) return "client";
            if (ev.fullName === QUIC_EVENTS.packet_received) return "server";
        }
    }
    return "client";
}

const hasStreamFrame = (ev: QlogEvent): boolean =>
    Array.isArray(ev.data?.frames) && ev.data.frames.some((f: unknown) => isObject(f) && f.frame_type === "stream");

/** §9.6.1: the first candidate quic event type with at least one STREAM frame, else candidates[0]. */
function pickSource(conn: QlogConnection, types: readonly string[], fallback: boolean): string {
    const t = fallback ? (types.find((ty) => conn.lookup(NS.quic, ty).some(hasStreamFrame)) ?? types[0]) : types[0];
    return `${NS.quic}:${t}`;
}

export interface MuxEventNames {
    /** STREAM frames of the response data (data-flow strip, byte ranges, waterfall bars) */
    dataEvent: string;
    /** STREAM frames of the requests (waterfall stream creation) */
    requestEvent: string;
    /** HTTP/3 HEADERS and PRIORITY_UPDATE frames of the requests */
    h3Event: string;
    /** axis label and legend wording: what the trace's data direction is */
    directionText: "received" | "sent";
    perspective: Perspective;
}

const RECEIVE_SIDE = [QUIC.packet_received, QUIC.frames_parsed, QUIC.frames_processed] as const;
const SEND_SIDE = [QUIC.packet_sent, QUIC.frames_created] as const;

/** §9.3 table + §9.6.1 (computed once per render; the strip and the waterfall share it). */
export function eventNames(conn: QlogConnection, opts: MuxOptions = MUX_OPTIONS): MuxEventNames {
    const fb = opts.frameEventFallback;
    return getPerspective(conn, opts) === "server"
        ? {
              dataEvent: pickSource(conn, SEND_SIDE, fb),
              requestEvent: pickSource(conn, RECEIVE_SIDE, fb),
              h3Event: HTTP3_EVENTS.frame_parsed,
              directionText: "sent",
              perspective: "server",
          }
        : {
              dataEvent: pickSource(conn, RECEIVE_SIDE, fb),
              requestEvent: pickSource(conn, SEND_SIDE, fb),
              h3Event: HTTP3_EVENTS.frame_created,
              directionText: "received",
              perspective: "client",
          };
}

/** §9.4.1. undefined = skip this frame (not an object, not STREAM, no stream_id or not a request stream). */
export function readDataStreamFrame(f: unknown): { sid: number; offset: number; length: number } | undefined {
    if (!isObject(f) || f.frame_type !== "stream") return undefined;
    const sid = u64(f.stream_id);
    if (!isDataStream(sid)) return undefined;
    // offset .default 0 (§9.6.4); no length -> 0 (DECISION §6.3)
    return { sid, offset: u64(f.offset) ?? 0, length: streamFrameDataLength(f) ?? 0 };
}

/** §9.4.1 / §9.6.1: header.packet_number for packet events, packet_numbers[i] for frame events. */
export function packetNumberOf(ev: QlogEvent, frameIndex: number): number | undefined {
    if (ev.fullName === QUIC_EVENTS.packet_sent || ev.fullName === QUIC_EVENTS.packet_received) {
        return u64(isObject(ev.data?.header) ? ev.data.header.packet_number : undefined);
    }
    return u64(Array.isArray(ev.data?.packet_numbers) ? ev.data.packet_numbers[frameIndex] : undefined);
}

/** §9.4.5 steps 2, 3, 3b, 5 and 6. The caller does step 4 (dataSent empty), step 7 (link) and step 8 (push). */
export function readStreamDataMoved(
    d: any,
    opts: MuxOptions = MUX_OPTIONS,
): { sid: number; offset: number; length: number } | undefined {
    if (!isObject(d)) return undefined;
    const sid = u64(d.stream_id);
    if (!isDataStream(sid)) return undefined;
    // only dealing with data bubbling up from the transport (M23: AND, verbatim)
    if (d.from !== "transport" && d.to !== "application") return undefined;
    if (opts.skipMovesToNetwork && d.to === "network") return undefined; // D-MX3
    const offset = u64(d.offset);
    const length = isObject(d.raw) ? u64(d.raw.length) : undefined;
    if (offset === undefined || length === undefined || length === 0) {
        if (d.additional_info === undefined) {
            console.debug("data_moved event with length 0, shouldn't happen! ignoring...", d);
        }
        return undefined;
    }
    return { sid, offset, length };
}

/** §9.4.3 and §9.4.4. */
export type H3RequestFrame =
    { kind: "headers"; sid: number; priorities: string[] } | { kind: "priority_update"; sid: number; value: string };

export function readH3RequestFrame(d: any): H3RequestFrame | undefined {
    const fr = isObject(d) ? d.frame : undefined;
    if (!isObject(fr)) return undefined;
    if (fr.frame_type === "headers") {
        const sid = u64(d.stream_id);
        if (sid === undefined) return undefined;
        const headers: unknown[] = Array.isArray(fr.headers) ? fr.headers : [];
        const priorities = headers
            .filter((h): h is Record<string, any> => isObject(h) && fieldName(h) === "priority")
            .map((h) => String(fieldValue(h))); // "undefined" when absent (PRESERVE qvis string concatenation)
        return { kind: "headers", sid, priorities };
    }
    if (fr.frame_type === "priority_update") {
        const sid = u64(fr.stream_id);
        if (sid === undefined) return undefined; // push_id only: skip (§9.4.4)
        return { kind: "priority_update", sid, value: String(fr.priority_field_value) };
    }
    return undefined;
}

// ================================================================================================
// Frame arrival classification (§3.5, verbatim port of calculateFrameArrivalType)
// ================================================================================================

export enum FrameArrivalType {
    Normal,
    Future,
    Duplicate,
    Retransmit,
    Reordered,
    UNKNOWN,
}

export interface Range {
    time: number;
    from: number;
    to: number;
}

export interface StreamRange {
    /** up to and including where the stream has been moved to the HTTP layer */
    currentHead: number;
    /** up to where the stream has been received (with holes between currentHead and this if they're not equal) */
    highestReceived: number;
    holes: Range[];
    filled: Range[];
    cumulativeTimeDifference: number;
    timeDifferenceSampleCount: number;
    frameCount: number;
}

export interface ArrivalInfo {
    type: FrameArrivalType;
    timeDifference: number;
    createdHole: [number, number] | undefined;
}

export function newStreamRange(): StreamRange {
    return {
        currentHead: -1,
        highestReceived: -1,
        holes: [],
        filled: [],
        cumulativeTimeDifference: 0,
        timeDifferenceSampleCount: 0,
        frameCount: 0,
    };
}

//         filled[0]                holes[0] filled[1] holes[1]   filled[2]
// .../////////////////////////////| _____ |/////////| _______ |/////////////|
//                                 ^                                         ^
//                           currentHead                               highestReceived
//
// We keep track of the filled ranges and generate the holes from them on each step, carrying the timestamps of the
// old holes over. A hole that takes long to fill indicates a retransmit, a short time a re-order.
export function classifyArrival(range: StreamRange, timestamp: number, from: number, to: number): ArrivalInfo {
    let outputType: FrameArrivalType; // qvis initialises it to UNKNOWN; every branch below assigns it
    let outputTimestampDifference = 0;
    let outputHole: Range | undefined = undefined;

    // 1. find the hole this new frame fits in (if none: a new frame, either Normal or Future)
    let foundHole: Range | undefined = undefined;
    for (const hole of range.holes) {
        // ignore if we overlap 2 holes for now
        if ((from >= hole.from && from <= hole.to) || (to >= hole.from && to <= hole.to)) {
            foundHole = hole;
            break;
        }
    }

    if (!foundHole) {
        // just checking to < range.currentHead only finds overlaps in the past; spurious retransmits between
        // currentHead and highestReceived are found by checking overlaps in filled instead
        let foundFilled: Range | undefined = undefined;
        for (const filled of range.filled) {
            if ((from >= filled.from && from <= filled.to) || (to >= filled.from && to <= filled.to)) {
                foundFilled = filled;
                break;
            }
        }

        if (foundFilled) {
            console.debug("DUPLICATE FOUND VIA FILLED!", foundFilled, from, to);
            return { type: FrameArrivalType.Duplicate, timeDifference: 0, createdHole: undefined };
        } else if (to < range.currentHead) {
            // total duplicate, no need to update state
            console.debug(
                "calculateFrameArrivalType : duplicate data found! Not really an error, but means spurious retransmissions.",
                range.currentHead,
                from,
                to,
                timestamp,
            );
            return { type: FrameArrivalType.Duplicate, timeDifference: 0, createdHole: undefined };
        } else if (from > range.highestReceived + 1) {
            // creates a hole
            outputType = FrameArrivalType.Future;
            outputHole = { time: timestamp, from: range.highestReceived + 1, to: from };
        } else if (from === range.highestReceived + 1) {
            // normal, everything arrives in-order without gaps
            outputType = FrameArrivalType.Normal;
        } else if (to > range.highestReceived + 1) {
            // partial overlap at the end: from is < highestReceived, to is > : mark this as "normal" for now
            outputType = FrameArrivalType.Normal;
        } else {
            // a) the range "spans" a hole (starts in one filled range, covers a hole, ends in the next filled range)
            // b) unknown situation we haven't seen before
            let spanning = false;
            for (let i = 0; i < range.filled.length - 1; ++i) {
                const filled1 = range.filled[i];
                const filled2 = range.filled[i + 1];
                if (from >= filled1.from && to > filled1.to && to <= filled2.to) {
                    spanning = true;
                }
            }

            if (spanning) {
                foundHole = undefined;
                for (const hole of range.holes) {
                    // look for the hole we're spanning
                    if (from < hole.from && to > hole.to) {
                        foundHole = hole;
                        break;
                    }
                }

                if (foundHole) {
                    console.debug(
                        "Found spanning frame, shouldn't happen in practice, only when debugging",
                        foundHole,
                        from,
                        to,
                    );
                    outputTimestampDifference = timestamp - foundHole.time;
                    outputType = FrameArrivalType.Retransmit;
                } else {
                    console.debug(
                        "calculateFrameArrivalType: Spanning frame, but not hole found... very weird",
                        from,
                        to,
                    );
                    outputType = FrameArrivalType.UNKNOWN;
                }
            } else {
                console.debug(
                    "calculateFrameArrivalType: no hole found for frame, but also nowhere else we would expect it...",
                    from,
                    to,
                );
                outputType = FrameArrivalType.UNKNOWN;
            }
        }
    } else {
        outputTimestampDifference = timestamp - foundHole.time;
        outputType = FrameArrivalType.Retransmit;
    }

    if (outputType === FrameArrivalType.Retransmit) {
        ++range.timeDifferenceSampleCount;
        range.cumulativeTimeDifference += outputTimestampDifference;

        const avg = range.cumulativeTimeDifference / range.timeDifferenceSampleCount;
        // lower than 20ms and within 30% of the current RTT estimate is -probably- a reorder
        if (outputTimestampDifference < 20 && outputTimestampDifference < avg * 0.3) {
            outputType = FrameArrivalType.Reordered;
        }
    }

    if (to > range.highestReceived) {
        range.highestReceived = to;
    }

    // 2. add to filled, sort ascending by .from and merge touching / overlapping intervals
    range.filled.push({ from, to, time: timestamp });
    range.filled.sort((a, b) => a.from - b.from);

    const stack: Range[] = [];
    stack.push(range.filled[0]);
    for (let i = 1; i < range.filled.length; ++i) {
        const previousInterval = stack.pop()!;
        const currentInterval = range.filled[i];
        if (previousInterval.to + 1 >= currentInterval.from) {
            const endTime = Math.max(previousInterval.to, currentInterval.to);
            stack.push({ from: previousInterval.from, to: endTime, time: timestamp });
        } else {
            stack.push(previousInterval);
            stack.push(currentInterval);
        }
    }
    range.filled = stack; // still sorted

    // 3. regenerate the holes between the filled ranges, backfilling the timestamps from the old holes
    const newHoles: Range[] = [];
    for (let i = 0; i < range.filled.length - 1; ++i) {
        const filled1 = range.filled[i];
        const filled2 = range.filled[i + 1];
        const newHole: Range = { from: filled1.to + 1, to: filled2.from - 1, time: -666 };

        let foundHole2: Range | undefined = undefined;
        for (const hole of range.holes) {
            // ignore if we overlap 2 holes for now
            if (
                (newHole.from >= hole.from && newHole.from <= hole.to) ||
                (newHole.to >= hole.from && newHole.to <= hole.to)
            ) {
                foundHole2 = hole;
                break;
            }
        }
        newHole.time = foundHole2 ? foundHole2.time : timestamp; // else: new hole due to a future frame
        newHoles.push(newHole);
    }
    range.holes = newHoles;

    if (range.holes.length > 0) {
        range.currentHead = range.holes[0].from - 1;
    } else {
        range.currentHead = range.filled[range.filled.length - 1].to;
    }

    return {
        type: outputType,
        timeDifference: outputTimestampDifference,
        createdHole: outputHole !== undefined ? [outputHole.from, outputHole.to] : undefined,
    };
}

// ================================================================================================
// Data-flow ("collapsed") extraction (§3.3)
// ================================================================================================

/** One data-direction STREAM frame on a request stream (qvis `dataSent` entry). */
export interface FrameDatum {
    streamID: number;
    /** raw packet number (undefined when not logged: the tooltip prints "undefined") */
    packetNumber: number | undefined;
    /** global per-FRAME index (despite the name); drives the height alternation */
    index: number;
    /** unused (qvis: raw frame.length) */
    size: number;
    countStart: number;
    countEnd: number;
    arrivalType: FrameArrivalType;
    arrivalTimeDifference: number;
    arrivalCreatedHole: [number, number] | undefined;
    offset: number;
    length: number;
    /** event relativeTime in ms */
    time: number;
}

/** One quic:stream_data_moved, linked to the last data-direction STREAM frame of its stream (qvis `dataMoved`). */
export interface MovedDatum {
    streamID: number;
    countStart: number;
    countEnd: number;
    offset: number;
    length: number;
}

export interface CollapsedData {
    dataSent: FrameDatum[];
    dataMoved: MovedDatum[];
    /** N + 1 for N data frames (the x domain is [1, frameCount]) */
    frameCount: number;
    directionText: "received" | "sent";
    streamRanges: Map<number, StreamRange>;
}

export function extractCollapsedData(
    conn: QlogConnection,
    names: MuxEventNames = eventNames(conn),
    opts: MuxOptions = MUX_OPTIONS,
): CollapsedData {
    let frameCount = 1;
    let packetIndex = 0;
    const streamRanges = new Map<number, StreamRange>();
    const dataSent: FrameDatum[] = [];
    const dataMoved: MovedDatum[] = [];

    for (const event of conn.getEvents()) {
        const data = event.data;

        if (event.fullName === names.dataEvent) {
            // packet_sent or _received (or the D-MX1 frame event), the ones we want to plot
            const frames: unknown[] = Array.isArray(data?.frames) ? data.frames : [];
            for (let i = 0; i < frames.length; ++i) {
                const s = readDataStreamFrame(frames[i]);
                if (!s) continue; // skip control streams like QPACK, and non-STREAM frames

                let ranges = streamRanges.get(s.sid);
                if (!ranges) {
                    ranges = newStreamRange();
                    streamRanges.set(s.sid, ranges);
                }

                const arrivalInfo = classifyArrival(ranges, event.relativeTime, s.offset, s.offset + s.length - 1);
                ranges.frameCount += 1;

                dataSent.push({
                    streamID: s.sid,
                    packetNumber: packetNumberOf(event, i),
                    index: packetIndex,
                    size: s.length,
                    countStart: frameCount,
                    countEnd: frameCount + 1,
                    arrivalType: arrivalInfo.type,
                    arrivalTimeDifference: arrivalInfo.timeDifference,
                    arrivalCreatedHole: arrivalInfo.createdHole,
                    offset: s.offset,
                    length: s.length,
                    time: event.relativeTime,
                });

                ++frameCount;
                ++packetIndex;
            }
        } else if (event.fullName === QUIC_EVENTS.stream_data_moved) {
            const m = readStreamDataMoved(data, opts);
            if (!m) continue;

            if (dataSent.length === 0) {
                console.debug("data moved but no stream frames seen yet... shouldn't happen!", data);
                continue;
            }

            // can't simply take dataSent[dataSent.length - 1]: one packet can carry STREAM frames of several streams,
            // so find the last STREAM frame of the stream the move belongs to (an approximation, see qvis :486-490)
            let foundFrame: FrameDatum | undefined = undefined;
            for (let i = dataSent.length - 1; i >= 0; --i) {
                if (dataSent[i].streamID === m.sid) {
                    foundFrame = dataSent[i];
                    break;
                }
            }

            if (!foundFrame) {
                console.debug(
                    "Data moved but didn't start at previous stream's offset, impossible!!!",
                    event.relativeTime,
                    data,
                );
                continue;
            }

            dataMoved.push({
                streamID: m.sid,
                countStart: foundFrame.countStart,
                countEnd: foundFrame.countEnd,
                offset: m.offset,
                length: m.length,
            });
        }
    }

    for (const [streamID, range] of streamRanges) {
        if (range.holes.length !== 0) {
            console.warn(
                "MultiplexingGraphD3CollapsedRenderer : stream has holes, didn't finish completely! Did this connection end pre-maturely?",
                streamID,
                range.holes,
            );
        }
    }

    return { dataSent, dataMoved, frameCount, directionText: names.directionText, streamRanges };
}

// ================================================================================================
// Waterfall extraction (§3.4)
// ================================================================================================

export interface H3StreamInfo {
    headersIndex: number;
    priorityUpdateIndex: number;
    headersTime: number;
    priorityUpdateTime: number;
    priorityString: string;
}

export interface StreamExtents {
    stream_id: number;
    /** request order: vertical position */
    order: number;
    requestIndex: number;
    startIndex: number;
    stopIndex: number;
    requestTime: number;
    startTime: number;
    endTime: number;
    frameCount: number;
    totalData: number;
    /** never null in practice (M16) */
    h3Info: H3StreamInfo | null;
}

export interface WaterfallData {
    /** insertion order = request order */
    streams: Map<number, StreamExtents>;
    h3Infos: Map<number, H3StreamInfo>;
    dataFrameCount: number;
    directionText: "received" | "sent";
}

const emptyH3 = (): H3StreamInfo => ({
    headersIndex: -1,
    priorityUpdateIndex: -1,
    headersTime: -1,
    priorityUpdateTime: -1,
    priorityString: "",
});

export function extractWaterfallData(conn: QlogConnection, names: MuxEventNames = eventNames(conn)): WaterfallData {
    // We plot in "frame count space" instead of "time space": loop over all the events and keep track of the data
    // frame indices, to keep the x-axis in sync with the data-flow strip. HTTP/3 info is tracked separately and linked
    // by stream ID, because HEADERS can be logged before or after the packet that carries it.
    let dataFrameCount = 0;
    const streams = new Map<number, StreamExtents>();
    const h3Infos = new Map<number, H3StreamInfo>();

    for (const evt of conn.getEvents()) {
        const data = evt.data;

        // 1. the HTTP/3 events: HEADERS or PRIORITY_UPDATE
        if (evt.fullName === names.h3Event) {
            const h = readH3RequestFrame(data);
            if (h) {
                // we might have gotten h3Info from a PRIORITY_UPDATE frame before HEADERS
                const h3Info = h3Infos.get(h.sid) ?? emptyH3();
                if (h.kind === "headers") {
                    h3Info.headersIndex = dataFrameCount;
                    h3Info.headersTime = evt.relativeTime;
                    for (const value of h.priorities) {
                        if (h3Info.priorityString.length === 0) {
                            h3Info.priorityString = "HEADER: " + value;
                        } else {
                            h3Info.priorityString += " -> HEADER: " + value; // HEADERS updates the value from PRIORITY_UPDATE
                        }
                    }
                } else {
                    // data.stream_id is the control stream; the prioritized request stream is frame.stream_id
                    h3Info.priorityUpdateIndex = dataFrameCount;
                    h3Info.priorityUpdateTime = evt.relativeTime;
                    if (h3Info.priorityString.length === 0) {
                        h3Info.priorityString = "FRAME: " + h.value;
                    } else {
                        h3Info.priorityString += " -> FRAME: " + h.value; // frame updates the value from HEADERS
                    }
                }

                // hook up the h3Info to an existing stream (e.g., packet_received logged before frame_parsed)
                if (h.sid >= 0) {
                    const stream = streams.get(h.sid);
                    if (stream) {
                        stream.h3Info = h3Info;
                    }
                    h3Infos.set(h.sid, h3Info);
                }
            }
        }

        // 2. the packet (or frame) events
        if (evt.fullName !== names.requestEvent && evt.fullName !== names.dataEvent) {
            continue;
        }
        if (!Array.isArray(data?.frames)) {
            continue;
        }

        for (const frame of data.frames as unknown[]) {
            if (!isObject(frame) || frame.frame_type !== "stream") continue;
            const s = readDataStreamFrame(frame);
            if (!s) {
                // skip control streams like QPACK
                continue;
            }

            if (evt.fullName === names.dataEvent) {
                ++dataFrameCount; // BEFORE the stream lookup (M15, PRESERVE)
            }

            let stream = streams.get(s.sid);
            if (!stream) {
                if (evt.fullName !== names.requestEvent) {
                    console.debug(
                        "MultiplexingGraphD3WaterfallRenderer: first packet for stream was not request! Shouldn't happen!",
                        evt.raw,
                    );
                    break; // skips the REST of this packet's frames (M15, PRESERVE)
                }

                stream = {
                    stream_id: s.sid,
                    order: streams.size,
                    requestIndex: dataFrameCount,
                    startIndex: -1,
                    stopIndex: -1,
                    requestTime: evt.relativeTime,
                    startTime: -1,
                    endTime: -1,
                    frameCount: 0,
                    totalData: 0,
                    // parsed before this: just link; otherwise prepare in case it's discovered later
                    h3Info: h3Infos.get(s.sid) ?? emptyH3(),
                };
                streams.set(s.sid, stream);
            } else {
                if (evt.fullName !== names.dataEvent) {
                    continue; // later request-direction frames (request bodies, a late FIN) are ignored
                }
                if (stream.startIndex === -1) {
                    stream.startIndex = dataFrameCount;
                    stream.startTime = evt.relativeTime;
                }
                if (dataFrameCount > stream.stopIndex) {
                    stream.stopIndex = dataFrameCount;
                    stream.endTime = evt.relativeTime;
                }
                stream.frameCount++;
                stream.totalData += s.length; // includes retransmits and duplicates
            }
        }
    }

    return { streams, h3Infos, dataFrameCount, directionText: names.directionText };
}

// ================================================================================================
// Layout helpers
// ================================================================================================

/** Waterfall row and SVG height (§3.9; M36 FIX: 150 px instead of NaN for 0 streams). */
export function waterfallLayout(nStreams: number): { minBarHeight: number; svgHeight: number; circleWidth: number } {
    const barHeight = 120;
    const marginTop = 40;
    // 4px is the minimum height. Above that, we start scrolling (at 120 normal height, 4px gives us 30 streams)
    let minBarHeight = 4;
    if (minBarHeight * nStreams < barHeight) {
        minBarHeight = (barHeight * 0.95) / nStreams;
    }
    const svgHeight = nStreams === 0 ? 150 : Math.ceil(minBarHeight * nStreams) + marginTop;
    const circleWidth = Math.min(15, Math.max(minBarHeight / 1.2, 0.01));
    return { minBarHeight, svgHeight, circleWidth };
}

/**
 * Byte-range Y auto-fit for the visible x window (§3.7 updateZoom, M7 off-by-ones PRESERVED). `domain` is the visible
 * x domain [d0, d1] in frame-count space. M8 FIX: when no frame of the stream is found (startY > endY), fall back to
 * the render-time domain [0, maxBytes] instead of a garbage axis.
 */
export function byteRangeYDomain(
    allFrames: readonly FrameDatum[],
    streamID: number,
    domain: readonly [number, number],
    maxBytes: number,
): [number, number] {
    // nicely stays within indexes!
    const startIndex = Math.max(0, Math.ceil(domain[0]) + 1);
    const endIndex = Math.min(allFrames.length - 1, Math.floor(domain[1]) - 1);

    let startY = Number.MAX_VALUE;
    let endY = 0;

    // TODO (qvis): the first frame we find doesn't necessarily have the lowest offset
    for (let i = startIndex; i < endIndex; ++i) {
        const frame = allFrames[i];
        if (frame.streamID === streamID && frame.offset < startY) {
            startY = frame.offset;
        }
    }
    for (let i = endIndex; i > startIndex; --i) {
        const frame = allFrames[i];
        if (!frame) continue;
        if (frame.streamID === streamID && frame.offset + frame.length - 1 > endY) {
            endY = frame.offset + frame.length - 1;
        }
    }

    if (startY > endY) {
        return [0, maxBytes];
    }
    return [startY, endY];
}

/**
 * M22 (revised at the final parity check): tooltip number formatting rounded to 1 ns,
 * `String(Math.round(x * 1e6) / 1e6)`. It removes float noise (`44.653917000000035` -> `44.653917`) and prints
 * ns-precision times exactly as qvis does (`88.799834`), where the first 1 µs rounding printed `88.8`.
 */
export function formatTooltipMs(x: number): string {
    return String(Math.round(x * 1e6) / 1e6);
}

/** Tooltip lines for one data-flow frame (§2.6, verbatim; joined with <br/> by the renderer). */
export function frameTooltipLines(d: FrameDatum): string[] {
    const lines: string[] = [];
    lines.push(formatTooltipMs(d.time) + "ms : stream " + d.streamID + " : packet number " + d.packetNumber);
    lines.push("[" + d.offset + ", " + (d.offset + d.length - 1) + "] (size: " + d.length + ")");
    if (d.arrivalType === FrameArrivalType.Retransmit || d.arrivalType === FrameArrivalType.Reordered) {
        lines.push("Fills gap that was created " + formatTooltipMs(d.arrivalTimeDifference) + "ms ago");
    } else if (d.arrivalCreatedHole !== undefined) {
        const [a, b] = d.arrivalCreatedHole;
        lines.push("Creates gap from " + a + " to " + b + " (size: " + (b - a) + ")");
    }
    return lines;
}

/** Stream details line (§2.7, M38 PRESERVE): the duration is computed from the toFixed(2) strings, then toFixed(2). */
export function streamDuration(startTime: number, endTime: number): string {
    return (Number(endTime.toFixed(2)) - Number(startTime.toFixed(2))).toFixed(2);
}

// ================================================================================================
// Dead simulation renderer data (§3.10, §9.4.6; never rendered, M1)
// ================================================================================================

export interface SimulatedRequest {
    streamID: number;
    count: number;
    text: string;
}

export function extractSimulationRequests(conn: QlogConnection, opts: MuxOptions = MUX_OPTIONS): SimulatedRequest[] {
    const type = getPerspective(conn, opts) === "server" ? "frame_parsed" : "frame_created";
    const out: SimulatedRequest[] = [];
    let requestCount = 1;
    for (const evt of conn.lookup(NS.http3, type)) {
        const data = evt.data;
        const fr = isObject(data) ? data.frame : undefined;
        if (!isObject(fr) || fr.frame_type !== "headers") continue;
        const sid = u64(data.stream_id);
        if (!isDataStream(sid)) continue; // skip control streams like QPACK

        let method: string | undefined = undefined;
        let path: string | undefined = undefined;
        for (const h of Array.isArray(fr.headers) ? (fr.headers as unknown[]) : []) {
            if (!isObject(h)) continue;
            const name = fieldName(h);
            if (name === ":method") method = fieldValue(h);
            if (name === ":path") path = fieldValue(h);
        }
        out.push({ streamID: sid, count: requestCount, text: String(method) + " " + String(path) });
        ++requestCount;
    }
    return out;
}
