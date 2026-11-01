// Pure statistics for the "qlog stats" page (parity/statistics.md §3, §9). Port of the computed getters of qvis
// `components/stats/StatisticsConnectionRenderer.vue` (totalFrameCount, frameLUT, encryptionLUT,
// fillConnectionDataFC, fillStreamDataFC, H3headersSummary, createStaggeredLines) and of
// `StatisticsRenderer.vue` (totalEventCount).
//
// qvis rescanned every event ~7 times per render and mutated lookup tables inside computed getters (Q13). Here one
// pass per connection produces an immutable result, cached by connection identity (events never change after load,
// data-model §3.16). Detection modes (§9.1): frames / encryption levels by data SHAPE (mode B) on every event whose
// name conforms to the latest drafts (or is in a private namespace); flow control / H3 headers / QUIC version / ALPN
// by EXACT latest-draft names only (mode C). Events with pre-final names (`transport:*`, `http:frame_*`, ...) are
// listed in the Events histogram but never interpreted (createNameFilter; deviation from spec S16, see there).

import { isNonconformingName, parseEventSchemaUri } from "@/model/conformance";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import type { QlogEvent } from "@/model/QlogEvent";
import { HTTP3, NS, QUIC } from "@/model/names";
import { fieldName, fieldValue, hexToLatin1 as sharedHexToLatin1 } from "@/qlog/schema/h3";

/** One flow-control limit series: values (rendered) and the matching relative times (console output only). */
export interface FCSeries {
    values: number[];
    times: number[];
}

/** HTTP/3 identity headers (row "H3 connection headers"); a member is undefined when never seen (or valueless). */
export interface H3HeadersSummary {
    userAgent?: unknown;
    server?: unknown;
    authority?: unknown;
}

export interface TraceStats {
    eventCount: number;
    frameCount: number;
    /** [frame_type, count], first-seen order; QUIC and HTTP/3 frame types share one map (S19). */
    frames: Array<[frameType: unknown, count: number]>;
    /** [packet_type, count], first-seen order (counts events, not unique packets, Q15). */
    encryptionLevels: Array<[packetType: unknown, count: number]>;
    connectionFC: { local: FCSeries; remote: FCSeries };
    /** key: `bidi_local` / `bidi_remote` / `uni_remote` (initial limits) or a stream id; insertion order. */
    streamFC: { local: Map<string, FCSeries>; remote: Map<string, FCSeries> };
    /** undefined -> row hidden */
    h3?: H3HeadersSummary;
    /** NEW row 3b (§9.12 N7); undefined -> row hidden */
    quicVersion?: string;
    /** NEW row 3c (§9.12 N7); undefined -> row hidden */
    alpn?: string;
}

export interface FileStats {
    traces: readonly QlogConnection[];
    traceCount: number;
    totalEventCount: number;
}

type Side = "local" | "remote";

const STREAM_PARAMS: ReadonlyArray<readonly [key: string, field: string]> = [
    ["bidi_local", "initial_max_stream_data_bidi_local"],
    ["bidi_remote", "initial_max_stream_data_bidi_remote"],
    ["uni_remote", "initial_max_stream_data_uni"],
];

const FRAME_TYPE_MAX_DATA = "max_data";
const FRAME_TYPE_MAX_STREAM_DATA = "max_stream_data";

/** qvis `parseInt(x, 10)`; uint64 may be a JSON number or a decimal string (> 2^53 loses precision, PARITY). */
const int = (x: unknown): number => parseInt(String(x), 10);

const isObject = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null;

/** Hex string to Latin-1 text (h3-events digest §8.1); undefined for anything that is not a string. */
export function hexToLatin1(hex: unknown): string | undefined {
    return typeof hex === "string" ? sharedHexToLatin1(hex) : undefined;
}

/** HTTP3HTTPField name / value (`name ?? name_bytes`, h3 digest §8.1): shared helpers from src/qlog/schema/h3.ts. */
export { fieldName, fieldValue };

function bump(map: Map<unknown, number>, key: unknown): void {
    map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Strict latest-draft names (ARCHITECTURE §0 / §3.1, user decision): an event's data is only interpreted when its
 * name is a latest-draft name or uses a private namespace (converter `tcp:` / `tls:` / `http2:`, `mvfst:`, ...).
 * Excluded: exactly the events the loader reports in DM3 (`isNonconformingName`, e.g. quic-go's pre-final
 * `transport:packet_sent`; the toast tells the user "the visualizations do not interpret these events"), names
 * without a namespace and events without a valid name. They are still listed in the Events histogram (mode A, gaps
 * G2 "Stats keeps listing them"), but no longer feed the Frames / Encryption levels counts (DEVIATION from spec S16 /
 * §9.1 mode B, which counted them by data shape).
 */
export function createNameFilter(conn: QlogConnection): (ev: QlogEvent) => boolean {
    const schemas = conn.eventSchemas.map(parseEventSchemaUri);
    const verdicts = new Map<string, boolean>();
    return (ev) => {
        if (ev.malformed !== undefined && ev.malformed.includes("name")) return false;
        let ok = verdicts.get(ev.loggedName);
        if (ok === undefined) {
            ok = ev.loggedName.includes(":") && !isNonconformingName(ev.loggedName, ev.namespace, schemas);
            verdicts.set(ev.loggedName, ok);
        }
        return ok;
    };
}

/** All per-trace statistics in one pass over the events (§3.13). Pure: never mutates the connection or its events. */
export function computeTraceStats(conn: QlogConnection): TraceStats {
    const events = conn.getEvents();
    const interpreted = createNameFilter(conn);
    const frameMap = new Map<unknown, number>();
    const encMap = new Map<unknown, number>();
    let frameCount = 0;
    const fc: Record<Side, { conn: FCSeries; streams: Map<string, FCSeries> }> = {
        local: { conn: { values: [], times: [] }, streams: new Map() },
        remote: { conn: { values: [], times: [] }, streams: new Map() },
    };

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const d: any = ev.data;
        if (!isObject(d)) continue;
        // non-conforming names: listed in the Events histogram only (see createNameFilter)
        if (!interpreted(ev)) continue;

        // ---- frames (§3.5, mode B). FIX Q19: non-array `frames` and null elements are skipped (qvis crashed).
        if (d.frames && Array.isArray(d.frames)) {
            for (const frame of d.frames) {
                if (frame === null || frame === undefined) continue;
                ++frameCount;
                bump(frameMap, frame.frame_type);
            }
        }
        if (d.frame) {
            ++frameCount;
            bump(frameMap, d.frame.frame_type);
        }

        // ---- encryption levels (§3.6, mode B): truthy data.header.packet_type
        if (d.header && d.header.packet_type) {
            bump(encMap, d.header.packet_type);
        }

        // ---- flow control (§3.7, §3.8, mode C): exact quic:* names; `initiator` (not draft-02 `owner`)
        if (ev.namespace !== NS.quic) continue;
        if (ev.type === QUIC.parameters_set) {
            if (d.initiator !== "local" && d.initiator !== "remote") continue;
            const side = fc[d.initiator as Side];
            const t = ev.relativeTime;
            // FIX Q4: -13 parameters_set is cumulative; only present fields contribute (qvis pushed NaN)
            if (d.initial_max_data !== undefined) {
                side.conn.values.push(int(d.initial_max_data));
                side.conn.times.push(t);
            }
            for (const [key, field] of STREAM_PARAMS) {
                // a later event replaces the key's list; Map.set keeps the key's original position (PARITY Q18)
                if (d[field] !== undefined) side.streams.set(key, { values: [int(d[field])], times: [t] });
            }
        } else if ((ev.type === QUIC.packet_sent || ev.type === QUIC.packet_received) && Array.isArray(d.frames)) {
            const side = fc[ev.type === QUIC.packet_sent ? "local" : "remote"];
            const t = ev.relativeTime;
            for (const frame of d.frames) {
                if (!isObject(frame)) continue;
                if (frame.frame_type === FRAME_TYPE_MAX_DATA) {
                    side.conn.values.push(int(frame.maximum));
                    side.conn.times.push(t);
                } else if (frame.frame_type === FRAME_TYPE_MAX_STREAM_DATA) {
                    const streamID = "" + frame.stream_id; // number 0 and string "0" both become "0"
                    let series = side.streams.get(streamID);
                    if (series === undefined) {
                        series = { values: [], times: [] };
                        side.streams.set(streamID, series);
                    }
                    series.values.push(int(frame.maximum));
                    series.times.push(t);
                }
            }
        }
    }

    const identity = computeQuicIdentity(conn);
    const stats: TraceStats = {
        eventCount: events.length,
        frameCount,
        frames: [...frameMap],
        encryptionLevels: [...encMap],
        connectionFC: { local: fc.local.conn, remote: fc.remote.conn },
        streamFC: { local: fc.local.streams, remote: fc.remote.streams },
    };
    const h3 = computeH3Headers(conn);
    if (h3 !== undefined) stats.h3 = h3;
    if (identity.quicVersion !== undefined) stats.quicVersion = identity.quicVersion;
    if (identity.alpn !== undefined) stats.alpn = identity.alpn;
    return stats;
}

/**
 * qvis `H3headersSummary` (§3.9, Q14): ALL http3:frame_created first, then ALL http3:frame_parsed (not
 * chronological); the last assignment wins; a header with the right name but no value overwrites with undefined.
 * Any frame with `headers` counts (HEADERS and PUSH_PROMISE). Pre-final `http:frame_*` events are ignored.
 */
export function computeH3Headers(conn: QlogConnection): H3HeadersSummary | undefined {
    let userAgent: unknown = undefined;
    let server: unknown = undefined;
    let authority: unknown = undefined;

    const frameEvents = [...conn.lookup(NS.http3, HTTP3.frame_created), ...conn.lookup(NS.http3, HTTP3.frame_parsed)];
    for (const ev of frameEvents) {
        const d: any = ev.data;
        if (!isObject(d) || !d.frame) continue;
        const headers = d.frame.headers;
        if (headers === undefined || !Array.isArray(headers)) continue; // FIX Q19: non-array headers
        for (const header of headers) {
            if (!isObject(header)) continue;
            const name = fieldName(header);
            if (name === "server") {
                server = fieldValue(header);
            } else if (name === "user-agent") {
                userAgent = fieldValue(header);
            } else if (name === ":authority") {
                authority = fieldValue(header);
            }
        }
    }
    // qvis: shown when any of the three is !== undefined (a valueless header resets to undefined)
    if (userAgent === undefined && server === undefined && authority === undefined) return undefined;
    return { userAgent, server, authority };
}

/** NEW rows 3b / 3c (§9.12 N7): last chosen_version / chosen_alpn of quic:version_information / alpn_information. */
export function computeQuicIdentity(conn: QlogConnection): { quicVersion?: string; alpn?: string } {
    let quicVersion: string | undefined;
    let alpn: string | undefined;
    for (const ev of conn.lookup(NS.quic, QUIC.version_information)) {
        const d: any = ev.data;
        const v = isObject(d) ? d.chosen_version : undefined;
        if (typeof v === "string" && v !== "") quicVersion = v;
    }
    for (const ev of conn.lookup(NS.quic, QUIC.alpn_information)) {
        const d: any = ev.data;
        const a = isObject(d) ? d.chosen_alpn : undefined;
        if (!isObject(a)) continue;
        const text =
            typeof a.string_value === "string"
                ? a.string_value
                : typeof a.byte_value === "string"
                  ? hexToLatin1(a.byte_value)
                  : undefined;
        if (text !== undefined && text !== "") alpn = text;
    }
    const out: { quicVersion?: string; alpn?: string } = {};
    if (quicVersion !== undefined) out.quicVersion = quicVersion;
    if (alpn !== undefined) out.alpn = alpn;
    return out;
}

const cache = new WeakMap<QlogConnection, TraceStats>();

/**
 * Cached `computeTraceStats` (one entry per connection; sequence-diagram clones are separate connections). On the
 * first computation the spreadsheet-ready flow-control step series are written to the console (§3.10, S15) with the
 * 0-based trace index `index`.
 */
export function getTraceStats(conn: QlogConnection, index?: number): TraceStats {
    let stats = cache.get(conn);
    if (stats === undefined) {
        stats = computeTraceStats(conn);
        cache.set(conn, stats);
        if (index !== undefined) logStaggeredSeries(stats, index);
    }
    return stats;
}

/** qvis StatisticsRenderer: real (non-generated) traces, their count and the sum of their event counts (§3.3). */
export function computeFileStats(group: QlogConnectionGroup): FileStats {
    const traces = group.getRealConnections();
    let totalEventCount = 0;
    for (const trace of traces) totalEventCount += trace.getEvents().length;
    return { traces, traceCount: traces.length, totalEventCount };
}

/**
 * bootstrap-vue 2.0.4 `computedProgress` with precision 2, then `toFixed(2)`: `52.94` for 18 / 34 (no `%` sign,
 * §2.8). Note the `Math.round` (bootstrap-vue `progress-bar.js`; the spec's formula omits it): 3 / 4000 -> `0.08`,
 * not `0.07`.
 */
export function progressLabel(value: number, max: number): string {
    const p = Math.pow(10, 2);
    return (Math.round((100 * p * value) / max) / p).toFixed(2);
}

/**
 * qvis `createStaggeredLines` (§3.10): step-function series for spreadsheets, `;` separated, `,` as decimal mark
 * (first `.` only), the last value extended by 200 ms. Empty input gives `["200;", "null;"]`.
 */
export function createStaggeredLines(timesInput: readonly number[], valsInput: readonly number[]): [string, string] {
    let times = "";
    let vals = "";
    let prevVal: number | null = null;
    let prevTime: number | null = null;
    const f = (x: unknown): string => ("" + x).replace(".", ",");

    for (let i = 0; i < timesInput.length; ++i) {
        const time = timesInput[i];
        const val = valsInput[i];

        if (prevVal !== null) {
            times += f(time) + ";";
            vals += f(prevVal) + ";";
        }

        times += f(time) + ";";
        vals += f(val) + ";";

        prevTime = time;
        prevVal = val;
    }

    times += f((prevTime as number) + 200) + ";"; // null + 200 === 200 (qvis quirk for empty input)
    vals += f(prevVal) + ";";

    return [times, vals];
}

/**
 * The eight console message kinds of §3.10, in the order qvis's template evaluated its getters (verified on hosted
 * qvis): connection-level local, connection-level remote, then every remote stream key, then every local stream key.
 */
export function staggeredSeriesMessages(stats: TraceStats, index: number): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const conn = (side: Side, series: FCSeries): void => {
        const [times, vals] = createStaggeredLines(series.times, series.values);
        out.push(["Connection-level FC TIMES for " + side + " viewpoint of Trace " + index + ": ", times]);
        out.push(["Connection-level FC for " + side + " viewpoint of Trace " + index + ": ", vals]);
    };
    const streams = (side: Side, map: Map<string, FCSeries>): void => {
        for (const [key, series] of map) {
            const [times, vals] = createStaggeredLines(series.times, series.values);
            out.push([
                "Stream-level FC TIMES for " + side + " viewpoint of Trace " + index + ", stream " + key + ": ",
                times,
            ]);
            out.push(["Stream-level FC for " + side + " viewpoint of Trace " + index + ", stream " + key + ": ", vals]);
        }
    };
    conn("local", stats.connectionFC.local);
    conn("remote", stats.connectionFC.remote);
    streams("remote", stats.streamFC.remote);
    streams("local", stats.streamFC.local);
    return out;
}

/** Writes the staggered flow-control series with console.debug (qvis used console.log on every render, Q20). */
export function logStaggeredSeries(stats: TraceStats, index: number): void {
    for (const [prefix, value] of staggeredSeriesMessages(stats, index)) console.debug(prefix, value);
}

/**
 * Vue 2 mustache interpolation (`{{ x }}`): null / undefined -> "", arrays and plain objects -> JSON with 2-space
 * indentation, anything else String(x). React would throw on objects, so every file-derived value goes through this.
 */
export function displayValue(x: unknown): string {
    if (x === null || x === undefined) return "";
    if (Array.isArray(x)) return JSON.stringify(x, null, 2);
    if (typeof x === "object") {
        // Vue: isPlainObject(x) && x.toString === Object.prototype.toString; prototype-less objects too (no throw)
        const own = (x as { toString?: unknown }).toString;
        if (
            Object.prototype.toString.call(x) === "[object Object]" &&
            (own === Object.prototype.toString || own === undefined)
        ) {
            return JSON.stringify(x, null, 2);
        }
    }
    return String(x);
}
