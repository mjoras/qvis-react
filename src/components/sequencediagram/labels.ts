// Text functions of the sequence diagram (qvis SequenceDiagramD3Renderer.ts:1791-2248; parity/sequence-diagram.md
// §3.12, §9.2-§9.4). Strings are verbatim qvis, including odd spacing (SQ23), except for the listed fixes:
// SQ13 (`!== undefined` checks, "stream N blocked at"), SQ18 (congestion_window as cwnd), LD2-LD5, LD7 and the
// extensions X1 (reset_stream_at) / X2 (closing, colors.ts) behind LATEST_EXTENSIONS.
// Strict latest drafts (parity addendum S4): only -13 members are read. qvis's legacy fallbacks (metrics `cwnd`, timer
// `timeout`, packet types `onertt` / `zerortt`, colon-less header names, `raw_error_code`) are not.
//
// Dispatch is on the latest-draft `namespace:type` (QlogEvent.fullName). Converter TCP traces use the private
// `tcp:` / `http2:` namespaces (data-model §9.10), so HTTP/2 frame events get the HTTP/3 frame label.

import type { QlogEvent } from "@/model/QlogEvent";
import { HTTP3_EVENTS, QUIC_EVENTS } from "@/model/names";
import { fieldName, fieldValue } from "@/qlog/schema/h3";

/**
 * Extensions for things that are new in the latest drafts and that qvis had no rendering for (§9.1 tags X1, X2).
 * A strict-parity build can switch them off here.
 */
export const LATEST_EXTENSIONS = true;

/** Types that qvis labelled `<category>: <message>` (type-only match, any namespace). */
export const MESSAGE_TYPES: ReadonlySet<string> = new Set([
    "info",
    "debug",
    "warning",
    "error",
    "verbose",
    "connection_error",
    "internal_error",
    "application_error",
    "internal_warning",
    "marker",
    "message",
]);

/** qvis's category rules: the level for `loglevel:*` (the old category), else the namespace. */
export function levelOf(e: Pick<QlogEvent, "namespace" | "type">): string {
    return e.namespace === "loglevel" ? e.type : e.namespace;
}

/** uint64 as number (JSON number or decimal string), else undefined. Only for arithmetic and numeric equality (LD2). */
export function toNum(v: unknown): number | undefined {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `packetTypeToString` (`:2226-2248`). */
export function packetTypeToString(packetType: unknown): string {
    switch (packetType) {
        case "1RTT":
            return "1RTT";
        case "0RTT":
            return "0RTT";
        case "version_negotiation":
            return "VNEG";
        default:
            return "" + packetType;
    }
}

/** The packet chip on an arrow: `packetTypeToString(packet_type) + " : " + packet_number`. */
export function packetHeaderText(data: any): string {
    const header = isPlainObject(data) ? data.header : undefined;
    return (
        "" +
        (isPlainObject(header) ? packetTypeToString(header.packet_type) : "") +
        " : " +
        (isPlainObject(header) ? header.packet_number : "")
    );
}

/** LD3 error text of reset_stream / stop_sending / reset_stream_at: `error`, or `error_code` when error is "unknown". */
function errText(f: Record<string, any>): unknown {
    if (f.error !== undefined && !(f.error === "unknown" && f.error_code !== undefined)) return f.error;
    return f.error_code !== undefined ? f.error_code : undefined;
}

/** `frameToShortString` (`:1791-1939`) with the quic-events-13 field mapping (§3.12.2, §9.4). */
export function frameToShortString(frame: any, extensions: boolean = LATEST_EXTENSIONS): string {
    if (!isPlainObject(frame)) return "" + frame;
    const f = frame as Record<string, any>;
    switch (f.frame_type) {
        case "ack": {
            let output = f.frame_type + " ";
            const ranges = f.acked_ranges;
            if (ranges) {
                if (Array.isArray(ranges)) {
                    for (let r = 0; r < ranges.length; ++r) {
                        const range = ranges[r];
                        if (!Array.isArray(range)) {
                            output += range;
                        } else if (range.length === 1) {
                            output += range[0];
                        } else {
                            const a = toNum(range[0]);
                            const b = toNum(range[1]);
                            const same = a !== undefined && b !== undefined ? a === b : range[0] === range[1]; // LD2
                            output += same ? range[0] : range[0] + "-" + range[1];
                        }
                        if (r < ranges.length - 1) output += ",";
                    }
                }
            }
            return "" + output;
        }

        case "stream":
            return f.frame_type + " " + f.stream_id + (f.fin ? " FIN" : "");

        case "connection_close": {
            // LD3: old error_code (enum string) is now `error`; old raw_error_code is now `error_code` (uint64)
            let output = f.frame_type + " ";
            if (f.error === "no_error" || f.error === "http_no_error" || toNum(f.error_code) === 0) {
                output += ": clean";
            } else {
                if (f.error !== undefined && f.error !== "unknown") output += f.error;
                else if (f.error_code !== undefined) output += f.error_code;
                else output += f.error ?? "";

                if (f.reason) output += " : " + f.reason;
            }
            return output;
        }

        // SQ13 FIX: `!== undefined` instead of truthiness (stream 0, maximum 0, limit 0)
        case "max_stream_data":
            if (f.maximum !== undefined && f.stream_id !== undefined) {
                return "max data " + f.maximum + " (stream " + f.stream_id + ")";
            }
            return "max_stream_data";

        case "max_data":
            if (f.maximum !== undefined) return "max data " + f.maximum;
            return "max_data";

        case "max_streams":
            if (f.maximum !== undefined && f.stream_type !== undefined) {
                return "max " + f.maximum + " " + f.stream_type + " streams";
            }
            return "max_streams";

        case "streams_blocked":
            if (f.limit !== undefined && f.stream_type !== undefined) {
                return "blocked at " + f.limit + " " + f.stream_type + " streams";
            }
            return "streams_blocked";

        case "stream_data_blocked":
            if (f.limit !== undefined && f.stream_id !== undefined) {
                return "stream " + f.stream_id + " blocked at " + f.limit; // SQ13 FIX: missing space
            }
            return "stream_data_blocked";

        case "data_blocked":
            if (f.limit !== undefined) return "connection blocked at " + f.limit;
            return "data_blocked";

        case "reset_stream":
        case "stop_sending": {
            const prefix = f.frame_type === "reset_stream" ? "reset stream " : "stop sending ";
            if (f.stream_id !== undefined) {
                const err = errText(f);
                return err !== undefined ? prefix + f.stream_id + " (" + err + ")" : prefix + f.stream_id;
            }
            return "" + f.frame_type;
        }

        case "reset_stream_at":
            if (extensions) {
                // X1 (EXT-ON)
                if (f.stream_id === undefined) return "reset_stream_at";
                const err = errText(f);
                return (
                    "reset stream " +
                    f.stream_id +
                    (err !== undefined ? " (" + err + ")" : "") +
                    (f.reliable_size !== undefined ? " at " + f.reliable_size : "")
                );
            }
            return "" + f.frame_type;

        default:
            return f.frame_type === undefined ? "" : "" + f.frame_type;
    }
}

/** `recovery_metrics_updated` label (`:1994-2048`) with SQ18 (`congestion_window`, labelled `cwnd: `). */
export function metricsLabel(data: any): string {
    const d: Record<string, any> = isPlainObject(data) ? data : {};
    const metricNames = Object.keys(d);
    const parts: string[] = [];
    let count = 0;

    if (metricNames.indexOf("congestion_window") >= 0) {
        parts.push("cwnd: " + d.congestion_window);
        count += 1;
    }
    if (metricNames.indexOf("smoothed_rtt") >= 0) {
        parts.push("srtt: " + d.smoothed_rtt);
        count += 1;
    }
    if (metricNames.indexOf("bytes_in_flight") >= 0) {
        parts.push("in flight: " + d.bytes_in_flight);
        count += 1;
    }
    if (metricNames.indexOf("ssthresh") >= 0) {
        parts.push("ssthresh: " + d.ssthresh);
        count += 1;
    }

    let output = parts.join(", ");
    const amountLeftOver = metricNames.length - count;
    if (count > 0 && amountLeftOver > 0) {
        output += ", ...";
    } else if (count === 0) {
        output = metricNames.map((name) => "" + name + ": " + d[name]).join(", ");
    }
    return "" + output;
}

/** `quic:timer_updated` label (§9.3.5, LD4). */
export function timerLabel(e: Pick<QlogEvent, "data" | "type" | "relativeTime">): string {
    const d: Record<string, any> = isPlainObject(e.data) ? e.data : {};
    if (d.event_type === undefined) return e.type; // LD4

    let pnSpaceString = "";
    if (d.packet_number_space !== undefined) {
        pnSpaceString = d.packet_number_space === "application_data" ? "appdata " : d.packet_number_space + " ";
    }
    const timerType = d.timer_type !== undefined ? ("" + d.timer_type).toUpperCase() + " " : " ";

    let timeString = "";
    if (d.event_type === "set") {
        const delta = parseFloat(d.delta);
        if (Number.isFinite(delta)) timeString = " @ " + (e.relativeTime + delta).toFixed(4); // LD4: no " @ NaN"
    }
    return pnSpaceString + " " + timerType + "timer " + d.event_type + timeString;
}

/** `quic:packet_lost` label (§9.3.3). */
export function packetLostLabel(e: Pick<QlogEvent, "data" | "type">): string {
    const d = e.data;
    if (isPlainObject(d) && isPlainObject(d.header) && d.header.packet_number !== undefined) {
        const packetType = d.header.packet_type !== undefined ? packetTypeToString(d.header.packet_type) + " " : "";
        return packetType + "packet lost #" + d.header.packet_number;
    }
    return e.type;
}

/** h3-events digest §8.1: `name ?? name_bytes`, `value ?? value_bytes` (LD5); shared in src/qlog/schema/h3.ts. */
export { fieldName, fieldValue };

/** `http3:frame_created` / `http3:frame_parsed` label (`:2122-2198`, §9.3.10). */
export function h3FrameLabel(e: Pick<QlogEvent, "data" | "type">): string {
    const d: Record<string, any> = isPlainObject(e.data) ? e.data : {};
    const streamID = d.stream_id !== undefined ? " (stream " + d.stream_id + ")" : "";

    // TRY to return something like   GET /index.html if possible
    if (d.frame && d.frame.headers) {
        let method: string | undefined;
        let path: string | undefined;
        let authority: string | undefined;
        let status: string | undefined;
        if (Array.isArray(d.frame.headers)) {
            for (const header of d.frame.headers) {
                const name = fieldName(header);
                if (name === ":method") method = fieldValue(header);
                else if (name === ":path") path = fieldValue(header);
                else if (name === ":authority") authority = fieldValue(header);
                else if (name === ":status") status = fieldValue(header);
            }
        }

        let shorthand = "";
        if (status) shorthand += status + " ";
        if (method) shorthand += method + " ";
        if (path) shorthand += path + " ";
        if (shorthand !== "") shorthand += streamID + " ";
        if (authority) {
            if (shorthand === "") shorthand += streamID + " ";
            shorthand += authority;
        }
        if (shorthand !== "") return shorthand;
    }

    let frameType = "";
    if (d.frame && d.frame.frame_type) frameType = d.frame.frame_type + " ";
    const verb = e.type === "frame_created" ? "created" : "parsed";
    return frameType + " " + verb + streamID;
}

/** LD7: count the producer's keys (`raw.data`), never a normalized copy. */
function keyCount(e: Pick<QlogEvent, "data" | "raw">): number {
    const rawData = e.raw ? (e.raw as Record<string, unknown>).data : undefined;
    return Object.keys(isPlainObject(rawData) ? rawData : isPlainObject(e.data) ? e.data : {}).length;
}

/** `eventToShortString` (`:1984-2224`, §9.2 reference implementation). */
export function eventToShortString(e: QlogEvent): string {
    const d: Record<string, any> = isPlainObject(e.data) ? e.data : {};
    switch (e.fullName) {
        case QUIC_EVENTS.spin_bit_updated:
            return "Spin " + (d.state ? "ON" : "OFF");
        case QUIC_EVENTS.recovery_metrics_updated:
            return metricsLabel(d);
        case QUIC_EVENTS.parameters_set:
            return "" + keyCount(e) + " transport parameters set";
        case QUIC_EVENTS.recovery_parameters_set:
            return "" + keyCount(e) + " recovery parameters set";
        case HTTP3_EVENTS.parameters_set:
            return "" + keyCount(e) + " HTTP/3 parameters set";
        case QUIC_EVENTS.connection_state_updated:
            return "Connection state: " + d.new;
        case QUIC_EVENTS.timer_updated:
            return timerLabel(e);
        case QUIC_EVENTS.packet_lost:
            return packetLostLabel(e);
        case QUIC_EVENTS.congestion_state_updated:
            return d.new !== undefined ? "Congestion state: " + ("" + d.new).replace("_", " ") : e.type;
        case HTTP3_EVENTS.frame_created:
        case HTTP3_EVENTS.frame_parsed:
        case "http2:frame_created": // converter TCP traces (data-model §9.10)
        case "http2:frame_parsed":
            return h3FrameLabel(e);
    }

    if (e.type === "parameters_set") {
        // any other namespace (qvis: unknown category)
        console.warn(
            "SequenceDiagramD3Renderer:eventToShortString : unknown category for 'parameters_set' event...",
            e.namespace,
        );
        return "" + keyCount(e) + " UNKNOWN parameters set";
    }

    if (MESSAGE_TYPES.has(e.type)) {
        if (d.message === undefined) return e.type;
        return levelOf(e) + ": " + d.message;
    }

    return e.type;
}
