// Data preparation of the congestion graph: port of qvis CongestionGraphD3Renderer.parseQlog (R:1059-1470),
// `_startTimeOffset` (R:523-535), findYExtrema / findMetricUpdateExtrema (R:1788-1873) and fixMetricUpdates
// (R:1887-1908), as a pure builder over one connection (parity/congestion-graph.md §3.3, §8.3, §9).
//
// qvis attached `event.qvis.congestion = {from, to, correspondingAck, correspondingLoss}` to the shared event objects;
// here everything lives in flat side tables that are rebuilt per connection (FIX Q1: the start offset is computed for
// every rendered connection, not only on the first render of a renderer instance).
//
// Latest drafts only (§9.1): `quic:packet_sent` / `quic:packet_received` through `conn.transportNamespace` ("tcp" for
// converter TCP traces), `quic:packet_lost`, `quic:recovery_metrics_updated`, `quic:parameters_set` and (fallback only,
// Q37) `quic:packets_acked`. Event names are used exactly as logged; legacy members (`cwnd`, `owner`,
// `header.packet_size`) are never read.

import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogEvent } from "@/model/QlogEvent";
import { NS, QUIC } from "@/model/names";
import type { RawInfo } from "@/qlog/schema/main";
import { rawByteLength, toNumber } from "@/qlog/uint64";

export type Pt = [number, number];

/** One sized `packet_sent` (unsized ones are not plotted and not matchable, §3.3(b)). */
export interface CgPacket {
    /** graph time (relativeTime + startTimeOffset) */
    t: number;
    /** inclusive, 1-based cumulative byte range */
    from: number;
    to: number;
    /** packet size in bytes (raw.length, or raw.data.length / 2) */
    size: number;
    event: QlogEvent;
    /** first ACK in event order (graph time) and the event that carried it (packet_received, or packets_acked: Q37) */
    ackT?: number;
    ackEvent?: QlogEvent;
    /** last packet_lost in event order */
    lossT?: number;
    lossEvent?: QlogEvent;
}

/** One `recovery_metrics_updated` sample, converted (absent / non-numeric members are undefined). */
export interface MetricSample {
    t: number;
    bytesInFlight?: number;
    congestionWindow?: number;
    minRTT?: number;
    smoothedRTT?: number;
    latestRTT?: number;
}

export interface CongestionModel {
    connection: QlogConnection;
    /** "quic", or "tcp" for converter TCP traces */
    transportNamespace: string;
    /** §3.2: `-(t0 - 200)` when the first event lies beyond 3000 ms, else 0 */
    startTimeOffset: number;
    /** sized packet_sent, in event order; `from` / `to` strictly increasing */
    packets: CgPacket[];
    /** Float64Array views of the packets (hot path: redraw / hover) */
    pT: Float64Array;
    pFrom: Float64Array;
    pTo: Float64Array;
    /** NaN when the packet has no ACK / loss */
    pAckT: Float64Array;
    pLossT: Float64Array;

    /** number of `<ns>:packet_sent` events */
    sentEventCount: number;
    /** packet_sent events without a usable size or header (not plotted) */
    skippedSent: number;
    /** packet_received events without a size or header (no x-extent contribution) */
    skippedReceived: number;
    /** packet_lost events that could not be matched */
    skippedLost: number;
    /** acked packet numbers that matched no sent packet (aggregated, Q30) */
    ackedNotSent: number;
    /** the trace logs the pre-final `transport:packet_sent` name (Q41 rule 1) */
    hasPreFinalPacketSent: boolean;
    /** ACKs were derived from quic:packets_acked (Q37 fallback) */
    usedPacketsAckedFallback: boolean;

    /** step series (fixMetricUpdates) */
    bytes: Pt[];
    cwnd: Pt[];
    minRTT: Pt[];
    smoothedRTT: Pt[];
    latestRTT: Pt[];
    fcApplication: Pt[];
    fcStream: Pt[];
    /** raw metric samples, event order (RTT zoom extrema) */
    metricSamples: MetricSample[];

    /** `[0, xMax + 10]` */
    originalRangeX: [number, number];
    /** `[0, totalSentBytes + 10]` (Reset zoom) */
    originalRangeY: [number, number];
    /** yExtrema over the whole x range (`[1, total]`), or originalRangeY when there is nothing to plot (Q17) */
    initialRangeY: [number, number];
    /** max of bytes_in_flight / congestion_window over samples with 0 <= t <= xMax + 10 (Q22) */
    maxCongestionY: number;
    /** max over all RTT samples of the whole trace */
    maxRTT: number;
}

// ------------------------------------------------------------------------------------------------ helpers (§9.1)

/** Presence test (FIX Q2: 0 is a value; truthiness checks dropped it in qvis). */
export function has(v: unknown): boolean {
    return v !== undefined && v !== null && Number.isFinite(toNumber(v));
}

/** PN / stream-ID map key: `"" + pn` for numbers and canonical strings; `"undefined"` when absent. */
export function pnKey(v: unknown): string {
    return v === undefined ? "undefined" : String(toNumber(v));
}

/** FIX Q3: one key per packet number space (0-RTT and 1-RTT share application_data). */
export function pnSpace(packetType: unknown): string {
    switch (packetType) {
        case "initial":
            return "initial";
        case "handshake":
            return "handshake";
        case "0RTT":
        case "1RTT":
            return "application_data";
        default:
            return String(packetType);
    }
}

function isObject(v: unknown): v is Record<string, any> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** raw.length (number or decimal string), else raw.data.length / 2 (Q44). Undefined unless positive and finite. */
export function packetSize(data: unknown): number | undefined {
    if (!isObject(data)) return undefined;
    const raw = data.raw;
    if (!isObject(raw)) return undefined;
    const n = rawByteLength(raw as RawInfo);
    if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
    return Math.trunc(n); // qvis: parseInt("" + len, 10)
}

/**
 * qvis fixMetricUpdates (R:1887-1908): a staircase that rises from 0 at the first point, holds every value until the
 * next point and extends to `rightEdge + 1`. Points are kept in push order (no sorting).
 */
export function toStepSeries(points: readonly Pt[], rightEdge: number): Pt[] {
    const out: Pt[] = [];
    if (points.length === 0) return out;
    let last = 0;
    for (const p of points) {
        out.push([p[0], last]);
        out.push(p);
        last = p[1];
    }
    out.push([rightEdge + 1, out[out.length - 1][1]]);
    return out;
}

/** §3.2 start-offset hack (threshold 3000 ms, 200 ms lead-in), computed per connection (FIX Q1). */
export function computeStartTimeOffset(connection: QlogConnection): number {
    const events = connection.getEvents();
    if (events.length === 0) return 0;
    const first = events[0].relativeTime;
    return first > 3000 ? -1 * (first - 200) : 0;
}

// ------------------------------------------------------------------------------------------------ extrema

/** qvis findYExtrema (R:1788-1806): `[min from, max to]` of the sent packets with `minX <= t <= maxX`. */
export function findYExtrema(model: CongestionModel, minX: number, maxX: number): [number, number] {
    let min = Infinity;
    let max = 0;
    const { pT, pFrom, pTo } = model;
    for (let i = 0; i < pT.length; ++i) {
        const t = pT[i];
        if (minX <= t && t <= maxX) {
            if (min > pFrom[i]) min = pFrom[i];
            if (max < pTo[i]) max = pTo[i];
        }
    }
    return [min, max];
}

/**
 * qvis findMetricUpdateExtrema (R:1815-1873): `[minCongestionY, maxCongestionY, minRTT, maxRTT]` over the samples with
 * `minX <= t <= maxX`. minCongestionY starts at 0 (qvis); minRTT / maxRTT are 0 when there is no RTT sample.
 */
export function findMetricUpdateExtrema(
    samples: readonly MetricSample[],
    minX: number,
    maxX: number,
): [number, number, number, number] {
    let minCongestionY = 0;
    let maxCongestionY = 0;
    let minRTT = Number.MAX_VALUE;
    let maxRTT = -Infinity;
    for (const s of samples) {
        if (!(minX <= s.t && s.t <= maxX)) continue;
        for (const y of [s.bytesInFlight, s.congestionWindow]) {
            if (y === undefined) continue;
            if (minCongestionY > y) minCongestionY = y;
            if (maxCongestionY < y) maxCongestionY = y;
        }
        for (const y of [s.minRTT, s.smoothedRTT, s.latestRTT]) {
            if (y === undefined) continue;
            if (minRTT > y) minRTT = y;
            if (maxRTT < y) maxRTT = y;
        }
    }
    if (minRTT === Number.MAX_VALUE) minRTT = 0;
    if (maxRTT === -Infinity) maxRTT = 0;
    return [minCongestionY, maxCongestionY, minRTT, maxRTT];
}

/**
 * RTT y domain of the recovery graph (R:823-848). Zooming off: `[0, maxRTT]`. Zooming on: the RTT extrema of the
 * samples inside the visible window, fuzzed by 10 ms (exactly qvis). FIX Q4, only for a window without RTT samples
 * (where qvis fell back to the bytes axis maximum): the step values carried into the window (each series' last sample
 * before `minX`) are used instead, and with none of those either the domain falls back to `[0, maxRTT]`.
 */
export function rttDomain(model: CongestionModel, zooming: boolean, minX: number, maxX: number): [number, number] {
    if (!zooming) return [0, model.maxRTT];

    let minRTT = Infinity;
    let maxRTT = -Infinity;
    const carried: (number | undefined)[] = [undefined, undefined, undefined];
    for (const s of model.metricSamples) {
        const values = [s.minRTT, s.smoothedRTT, s.latestRTT];
        if (s.t < minX) {
            for (let k = 0; k < 3; ++k) if (values[k] !== undefined) carried[k] = values[k];
            continue;
        }
        if (s.t > maxX) continue;
        for (const y of values) {
            if (y === undefined) continue;
            if (minRTT > y) minRTT = y;
            if (maxRTT < y) maxRTT = y;
        }
    }
    if (minRTT === Infinity) {
        // parity: a window that has samples uses only those; the carried values are the Q4 fallback
        for (const y of carried) {
            if (y === undefined) continue;
            if (minRTT > y) minRTT = y;
            if (maxRTT < y) maxRTT = y;
        }
    }
    if (minRTT === Infinity) {
        minRTT = 0;
        maxRTT = model.maxRTT;
    }
    return [Math.max(minRTT - 10, 0), maxRTT + 10];
}

// ------------------------------------------------------------------------------------------------ builder

interface SentSlot {
    packet: CgPacket;
}

/** Builds the congestion model of one connection (qvis parseQlog with the FIXes of spec §7 / §9). */
export function buildCongestionModel(connection: QlogConnection): CongestionModel {
    const ns = connection.transportNamespace;
    const startTimeOffset = computeStartTimeOffset(connection);
    const transformTime = (ev: QlogEvent): number => ev.relativeTime + startTimeOffset;

    const packetsSent = connection.lookup(ns, QUIC.packet_sent);
    const packetsReceived = connection.lookup(ns, QUIC.packet_received);
    const packetsLost = connection.lookup(NS.quic, QUIC.packet_lost);
    const metricUpdates = connection.lookup(NS.quic, QUIC.recovery_metrics_updated);
    const transportParams = connection.lookup(NS.quic, QUIC.parameters_set);

    let xMax = 0;
    let yMax = 0;

    const fcApplication: Pt[] = [];
    const fcStream: Pt[] = [];

    // (a) transport parameters: only the peer's (initiator "remote"; draft-02 `owner` is not read)
    for (const ev of transportParams) {
        const data = ev.data;
        if (!isObject(data) || data.initiator !== "remote") continue;
        const t = transformTime(ev);
        if (has(data.initial_max_data)) fcApplication.push([t, toNumber(data.initial_max_data)]);
        if (has(data.initial_max_stream_data_bidi_remote)) {
            fcStream.push([t, toNumber(data.initial_max_stream_data_bidi_remote)]);
        }
    }

    // (b) sent packets: cumulative byte ranges across all packet types, in event order
    const packets: CgPacket[] = [];
    const sentByKey = new Map<string, Map<string, SentSlot>>();
    let total = 0;
    let skippedSent = 0;
    for (const ev of packetsSent) {
        const data = ev.data;
        const size = packetSize(data);
        const header = isObject(data) ? data.header : undefined;
        if (size === undefined || !isObject(header)) {
            // no size (or malformed: no header, Q40) -> not plotted, not matchable
            ++skippedSent;
            continue;
        }
        const t = transformTime(ev);
        const from = total + 1;
        total += size;
        const packet: CgPacket = { t, from, to: total, size, event: ev };
        packets.push(packet);

        const space = pnSpace(header.packet_type);
        let byPn = sentByKey.get(space);
        if (byPn === undefined) {
            byPn = new Map();
            sentByKey.set(space, byPn);
        }
        byPn.set(pnKey(header.packet_number), { packet }); // a later duplicate PN overwrites (Q24)

        if (xMax < t) xMax = t;
        if (yMax < total) yMax = total;
    }

    // (c) received packets: x extent, flow control frames, ACK linking (first ACK in event order wins)
    let ackedNotSent = 0;
    let skippedReceived = 0;
    let sawAckFrames = false;
    const streamFC = new Map<string, number>();

    const markAcked = (space: string, from: number, to: number, ackEvent: QlogEvent, ackT: number): void => {
        const byPn = sentByKey.get(space);
        const count = to - from + 1;
        if (byPn === undefined) {
            ackedNotSent += count;
            return;
        }
        let matched = 0;
        const ack = (slot: SentSlot): void => {
            ++matched;
            if (slot.packet.ackEvent === undefined) {
                slot.packet.ackEvent = ackEvent;
                slot.packet.ackT = ackT;
            }
        };
        if (count > byPn.size) {
            // FIX Q34: bounded work for huge (bogus) ranges; same result as iterating every PN
            for (const [key, slot] of byPn) {
                const pn = Number(key);
                if (pn >= from && pn <= to) ack(slot);
            }
        } else {
            for (let pn = from; pn <= to; ++pn) {
                const slot = byPn.get(String(pn));
                if (slot !== undefined) ack(slot);
            }
        }
        ackedNotSent += count - matched;
    };

    for (const ev of packetsReceived) {
        const data = ev.data;
        if (!isObject(data)) {
            ++skippedReceived;
            continue;
        }
        const t = transformTime(ev);
        const header = isObject(data.header) ? data.header : undefined;
        if (packetSize(data) !== undefined && header !== undefined) {
            if (xMax < t) xMax = t;
        } else {
            ++skippedReceived;
        }

        const frames = data.frames;
        if (!Array.isArray(frames)) continue;

        const ackFrames: Record<string, any>[] = [];
        for (const frame of frames) {
            if (!isObject(frame)) continue;
            if (frame.frame_type === "ack") {
                ackFrames.push(frame);
            } else if (frame.frame_type === "max_data") {
                if (frame.maximum !== undefined && has(frame.maximum)) {
                    fcApplication.push([t, toNumber(frame.maximum)]);
                }
            } else if (frame.frame_type === "max_stream_data") {
                if (frame.maximum !== undefined && has(frame.maximum)) {
                    // absolute per-stream values: keep the latest per stream and sum them
                    streamFC.set(pnKey(frame.stream_id), toNumber(frame.maximum));
                    let sum = 0;
                    for (const v of streamFC.values()) sum += v;
                    fcStream.push([t, sum]);
                }
            }
        }

        if (ackFrames.length === 0) continue;
        for (const f of ackFrames) if (Array.isArray(f.acked_ranges)) sawAckFrames = true;
        if (header === undefined) continue; // Q40: no PN space for these ACK frames

        // an ACK acknowledges packets of the space it is sent in (RFC 9000 §12.3)
        const space = pnSpace(header.packet_type);
        for (const f of ackFrames) {
            if (!Array.isArray(f.acked_ranges)) continue;
            for (const r of f.acked_ranges) {
                if (!Array.isArray(r) || r.length === 0) continue;
                const from = toNumber(r[0]);
                const to = r.length === 2 ? toNumber(r[1]) : from;
                if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
                markAcked(space, Math.trunc(from), Math.trunc(to), ev, t);
            }
        }
    }

    // Q37: quic:packets_acked, only when the trace has no ACK frames at all (never mixed)
    let usedPacketsAckedFallback = false;
    if (!sawAckFrames) {
        const packetsAcked = connection.lookup(NS.quic, QUIC.packets_acked);
        if (packetsAcked.length > 0) {
            usedPacketsAckedFallback = true;
            for (const ev of packetsAcked) {
                const data = ev.data;
                if (!isObject(data) || !Array.isArray(data.packet_numbers)) continue;
                const space =
                    typeof data.packet_number_space === "string" ? data.packet_number_space : "application_data";
                const byPn = sentByKey.get(space);
                if (byPn === undefined) continue;
                const t = transformTime(ev);
                for (const pn of data.packet_numbers) {
                    if (!Number.isFinite(toNumber(pn))) continue;
                    const slot = byPn.get(pnKey(pn));
                    if (slot !== undefined && slot.packet.ackEvent === undefined) {
                        slot.packet.ackEvent = ev;
                        slot.packet.ackT = t;
                    }
                }
            }
        }
    }

    // (e) losses: the last loss event wins
    let skippedLost = 0;
    for (const ev of packetsLost) {
        const data = ev.data;
        const header = isObject(data) ? data.header : undefined;
        if (!isObject(header) || header.packet_number === undefined) {
            ++skippedLost;
            continue;
        }
        const slot = sentByKey.get(pnSpace(header.packet_type))?.get(pnKey(header.packet_number));
        if (slot === undefined) {
            ++skippedLost;
            continue;
        }
        slot.packet.lossEvent = ev;
        slot.packet.lossT = transformTime(ev);
    }

    // (f) metrics (sparse deltas: a series only gets a point from events that carry its member)
    const bytes: Pt[] = [];
    const cwnd: Pt[] = [];
    const minRTT: Pt[] = [];
    const smoothedRTT: Pt[] = [];
    const latestRTT: Pt[] = [];
    const metricSamples: MetricSample[] = [];
    let maxRTT = 0;
    for (const ev of metricUpdates) {
        const data = ev.data;
        if (!isObject(data)) continue;
        const t = transformTime(ev);
        const sample: MetricSample = { t };
        if (has(data.bytes_in_flight)) {
            sample.bytesInFlight = toNumber(data.bytes_in_flight);
            bytes.push([t, sample.bytesInFlight]);
        }
        if (has(data.congestion_window)) {
            sample.congestionWindow = toNumber(data.congestion_window);
            cwnd.push([t, sample.congestionWindow]);
        }
        if (has(data.min_rtt)) {
            sample.minRTT = toNumber(data.min_rtt);
            minRTT.push([t, sample.minRTT]);
            if (maxRTT < sample.minRTT) maxRTT = sample.minRTT;
        }
        if (has(data.smoothed_rtt)) {
            sample.smoothedRTT = toNumber(data.smoothed_rtt);
            smoothedRTT.push([t, sample.smoothedRTT]);
            if (maxRTT < sample.smoothedRTT) maxRTT = sample.smoothedRTT;
        }
        if (has(data.latest_rtt)) {
            sample.latestRTT = toNumber(data.latest_rtt);
            latestRTT.push([t, sample.latestRTT]);
            if (maxRTT < sample.latestRTT) maxRTT = sample.latestRTT;
        }
        metricSamples.push(sample);
    }

    // (g) extents
    xMax += 10; // make sure the final packets get drawn
    yMax += 10; // some headroom
    const originalRangeX: [number, number] = [0, xMax];
    const originalRangeY: [number, number] = [0, yMax];

    const n = packets.length;
    const pT = new Float64Array(n);
    const pFrom = new Float64Array(n);
    const pTo = new Float64Array(n);
    const pAckT = new Float64Array(n);
    const pLossT = new Float64Array(n);
    for (let i = 0; i < n; ++i) {
        const p = packets[i];
        pT[i] = p.t;
        pFrom[i] = p.from;
        pTo[i] = p.to;
        pAckT[i] = p.ackT === undefined ? NaN : p.ackT;
        pLossT[i] = p.lossT === undefined ? NaN : p.lossT;
    }

    const model: CongestionModel = {
        connection,
        transportNamespace: ns,
        startTimeOffset,
        packets,
        pT,
        pFrom,
        pTo,
        pAckT,
        pLossT,
        sentEventCount: packetsSent.length,
        skippedSent,
        skippedReceived,
        skippedLost,
        ackedNotSent,
        hasPreFinalPacketSent: connection.lookup("transport", "packet_sent").length > 0,
        usedPacketsAckedFallback,
        // (h) step series
        bytes: toStepSeries(bytes, xMax),
        cwnd: toStepSeries(cwnd, xMax),
        minRTT: toStepSeries(minRTT, xMax),
        smoothedRTT: toStepSeries(smoothedRTT, xMax),
        latestRTT: toStepSeries(latestRTT, xMax),
        fcApplication: toStepSeries(fcApplication, xMax),
        fcStream: toStepSeries(fcStream, xMax),
        metricSamples,
        originalRangeX,
        originalRangeY,
        initialRangeY: originalRangeY,
        maxCongestionY: 0,
        maxRTT,
    };

    // §3.4 initial scales: right axis over samples within the plotted x range (Q22), y = yExtrema over all (Q17)
    model.maxCongestionY = findMetricUpdateExtrema(metricSamples, originalRangeX[0], originalRangeX[1])[1];
    const [minY, maxY] = findYExtrema(model, originalRangeX[0], originalRangeX[1]);
    model.initialRangeY = minY > maxY ? originalRangeY : [minY, maxY];

    if (import.meta.env?.DEV && typeof console !== "undefined") {
        // Q30: one aggregated developer message per model instead of qvis's console.error spam
        const parts: string[] = [];
        if (skippedSent > 0) parts.push(skippedSent + " sent packets with invalid size");
        if (skippedReceived > 0) parts.push(skippedReceived + " received packets with invalid size");
        if (ackedNotSent > 0) parts.push(ackedNotSent + " packets acked that we didn't send");
        if (skippedLost > 0) parts.push(skippedLost + " lost packets that could not be matched");
        if (parts.length > 0) console.debug("CongestionGraph:buildCongestionModel : " + parts.join(", "));
    }

    return model;
}

/** Q41 empty-state notice (first matching rule wins), or undefined when everything was plotted. */
export function congestionNotice(model: CongestionModel): string | undefined {
    const ns = model.transportNamespace;
    if (model.sentEventCount === 0) {
        if (model.hasPreFinalPacketSent) {
            return (
                "This trace has no " +
                ns +
                ":packet_sent events. It logs packets as transport:packet_sent, a pre-standard event name that qvis does not support, so there is nothing to plot."
            );
        }
        return "This trace has no " + ns + ":packet_sent events, so there is nothing to plot.";
    }
    if (model.packets.length === 0) {
        return "This trace has no " + ns + ":packet_sent events with a size (raw.length); there is nothing to plot.";
    }
    if (model.skippedSent > 0) {
        return model.skippedSent + " " + ns + ":packet_sent events have no raw.length and were not plotted.";
    }
    return undefined;
}
