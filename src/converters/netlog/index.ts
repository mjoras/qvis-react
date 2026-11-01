// Chrome NetLog -> latest-draft qlog (port of qvis NetlogToQlog.convert, netlogtoqlog.ts:202-893; converters spec
// sections 3.3-3.7 and 8.4-8.5).
//
// One trace per QUIC_SESSION source (in order of first appearance). Events are emitted in netlog order with
// `time` = netlog tick - the session's first tick (integer ms, identical to qvis's relative times). The absolute
// time comes from constants.timeTickOffset (reference_time.epoch), which qvis ignored.

import { DiagnosticCollector } from "../common/diagnostics";
import type { ConverterResult } from "../common/diagnostics";
import {
    HTTP3_CHROMIUM_EXTENSION_URI,
    HTTP3_SCHEMA_URI,
    LOGLEVEL_SCHEMA_URI,
    makeQlogFile,
    QUIC_CHROMIUM_EXTENSION_URI,
    QUIC_SCHEMA_URI,
} from "../common/envelope";
import type { QlogOutputTrace } from "../common/envelope";
import { NO_QUIC_CONNECTIONS_TEXT } from "../common/notifications";
import { num } from "../common/num";
import { mapNetlogEvent } from "./mapEvent";
import type { NetlogMapContext } from "./mapEvent";
import { parseNetlogText } from "./repair";
import { NetlogSession } from "./session";

export { parseNetlogText, repairTruncatedNetlog } from "./repair";
export { calculateAckRanges } from "./ackRanges";
export { parseChromiumTransportParameters } from "./transportParams";
export { parseHeaders, mapSettings } from "./h3";

export interface NetlogConvertOptions {
    /** T3 mappings qvis never produced (default false: 1:1 with qvis plus the T2 fixes) */
    extended?: boolean;
    /** T3: split coalesced received datagrams into one quic:packet_received per QUIC packet (default false) */
    splitCoalescedReceived?: boolean;
    /** file name, for error messages */
    filename?: string;
}

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** constants maps name -> number; events carry the numbers (qvis invertMap, netlogtoqlog.ts:75-84). */
function invertMap(map: unknown, what: string, filename: string): Map<number, string> {
    if (!isObject(map)) throw new Error("Chrome netlog has no constants." + what + ": " + filename);
    const result = new Map<number, string>();
    for (const [name, value] of Object.entries(map)) {
        const n = num(value);
        if (n !== undefined) result.set(n, name);
    }
    return result;
}

function referenceTime(
    timeTickOffset: number | undefined,
    startTick: number,
): QlogOutputTrace["common_fields"]["reference_time"] {
    if (timeTickOffset !== undefined) {
        const ms = timeTickOffset + startTick;
        if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) {
            // both are integer ms, so the ISO string is exact (case R: relativeTime = time, as in qvis)
            return { clock_type: "system", epoch: new Date(ms).toISOString() };
        }
    }
    // case U: monotonic clock, unknown epoch (decision C3)
    return { clock_type: "monotonic", epoch: "unknown" };
}

function eventSchemas(s: NetlogSession): string[] {
    const out: string[] = [];
    if (s.usesQuic) out.push(QUIC_SCHEMA_URI);
    if (s.usesHttp3) out.push(HTTP3_SCHEMA_URI);
    if (s.usesLoglevel) out.push(LOGLEVEL_SCHEMA_URI);
    if (s.usesQuicChromium) out.push(QUIC_CHROMIUM_EXTENSION_URI);
    if (s.usesHttp3Chromium) out.push(HTTP3_CHROMIUM_EXTENSION_URI);
    return out;
}

/**
 * Converts a Chrome net-export log (the parsed JSON object, or its text: the text path repairs truncated files) into
 * a latest-draft QlogFile. Pure and synchronous. Throws only when the input is not a netlog at all.
 */
export function convertNetlog(input: unknown, options: NetlogConvertOptions = {}): ConverterResult {
    const filename = options.filename ?? "netlog";
    const diag = new DiagnosticCollector();
    const root = typeof input === "string" ? parseNetlogText(input, filename, diag) : input;
    if (!isObject(root) || !isObject(root.constants) || !Array.isArray(root.events)) {
        throw new Error('Not a Chrome netlog (expected an object with "constants" and "events"): ' + filename);
    }
    const constants = root.constants;
    const events: unknown[] = root.events;

    const eventTypes = invertMap(constants.logEventTypes, "logEventTypes", filename);
    const sourceTypes = invertMap(constants.logSourceType, "logSourceType", filename);
    const phases = invertMap(constants.logEventPhase, "logEventPhase", filename);
    const timeTickOffset = num(constants.timeTickOffset);

    const ctx: NetlogMapContext = {
        diag,
        extended: options.extended === true,
        splitCoalescedReceived: options.splitCoalescedReceived === true,
        unsupported: new Map(),
    };
    const sessions = new Map<unknown, NetlogSession>(); // insertion order = trace order

    for (const event of events) {
        if (!isObject(event)) continue;
        const source = isObject(event.source) ? event.source : undefined;
        const sourceType = source !== undefined ? sourceTypes.get(num(source.type) ?? NaN) : undefined;
        if (sourceType === undefined) {
            diag.warn(
                "netlog.unknown-source-type",
                "Some netlog events have an unknown source type; they were skipped",
                {
                    sample: source?.type,
                },
            );
            continue;
        }
        // only events of a QUIC session are converted
        if (sourceType !== "QUIC_SESSION") continue;

        const eventType = eventTypes.get(num(event.type) ?? NaN);
        if (eventType === undefined) {
            diag.warn("netlog.unknown-event-type", "Some netlog events have an unknown event type; they were skipped", {
                sample: event.type,
            });
            continue;
        }
        const phase = phases.get(num(event.phase) ?? NaN);
        if (phase === undefined) {
            diag.warn("netlog.unknown-phase", "Some netlog events have an unknown event phase; they were skipped", {
                sample: event.phase,
            });
            continue;
        }
        const tick = num(event.time);
        if (tick === undefined) {
            diag.info(
                "netlog.missing-field",
                "Some netlog events lack a field the qlog event needs; the field was omitted",
                {
                    sample: eventType + ".time",
                },
            );
            continue;
        }
        const params: Raw = isObject(event.params) ? event.params : {};

        const sourceId = source!.id;
        let session = sessions.get(sourceId);
        if (session === undefined) {
            if (eventType !== "QUIC_SESSION" || phase !== "PHASE_BEGIN") {
                diag.warn(
                    "netlog.session-without-begin",
                    "Some QUIC sessions in the netlog do not start with a QUIC_SESSION BEGIN event (capture started late?)",
                    { sample: eventType + " " + phase },
                );
            }
            session = new NetlogSession(sourceId, tick);
            sessions.set(sourceId, session);
        }
        if (session.sessionParams === undefined && params.host !== undefined) session.sessionParams = params;

        mapNetlogEvent(ctx, session, eventType, phase, tick - session.startTick, params);
    }

    const traces: QlogOutputTrace[] = [];
    let unsentFrames = 0;
    for (const s of sessions.values()) {
        // T2 (Q11): the last received packet gets its frames too (qvis only attached them on the next packet)
        if (s.rxPacket !== undefined && s.rxPacket.emitted) {
            if (s.rxPacket.data.frames === undefined) s.attachRxFrames();
        } else {
            // no received packet yet, or only a header-only packet that is never shown (PARITY): nothing to attach to
            unsentFrames += s.rxFrames.length;
        }
        unsentFrames += s.txFrames.length;

        if (s.events.length === 0) {
            diag.info(
                "netlog.empty-session-dropped",
                "Some QUIC sessions in the netlog have no convertible events (e.g. timeout-only sessions); they were not loaded",
                { sample: s.title },
            );
            continue;
        }
        traces.push({
            title: s.title,
            vantage_point: { type: "client" },
            common_fields: {
                protocol_type: "QUIC_HTTP3",
                time_format: "relative_to_epoch",
                reference_time: referenceTime(timeTickOffset, s.startTick),
            },
            event_schemas: eventSchemas(s),
            events: s.events,
        });
    }
    if (unsentFrames > 0) {
        diag.info(
            "netlog.unsent-frames",
            "Some netlog frames were logged without a packet (after the last sent packet or before the first received one); they were dropped",
            { count: unsentFrames },
        );
    }
    if (timeTickOffset === undefined && traces.length > 0) {
        diag.info(
            "netlog.no-time-tick-offset",
            "The netlog has no constants.timeTickOffset; absolute times are unknown and each trace starts at 0",
        );
    }
    if (ctx.unsupported.size > 0) {
        let total = 0;
        for (const c of ctx.unsupported.values()) total += c;
        diag.add(
            "info",
            "netlog.unsupported-event",
            "Some netlog event types have no qlog mapping; they were skipped",
            {
                count: total,
                sample: Object.fromEntries(ctx.unsupported),
            },
        );
    }
    if (traces.length === 0) {
        diag.warn("netlog.no-quic-sessions", NO_QUIC_CONNECTIONS_TEXT);
    }

    let qlogEvents = 0;
    for (const t of traces) qlogEvents += t.events.length;
    return {
        qlog: makeQlogFile(traces),
        diagnostics: diag.toArray(),
        stats: { netlogEvents: events.length, quicSessions: sessions.size, traces: traces.length, qlogEvents },
    };
}

/**
 * Contract used by the loading layer (src/loading/fileLoader.ts): the netlog object or text -> latest-draft qlog
 * root. Throws when the input is not a netlog or contains no QUIC connection (the loader never adds empty groups).
 */
export function netlogToQlog(netlog: unknown, filename: string): Record<string, unknown> {
    const { qlog } = convertNetlog(netlog, { filename });
    if (qlog.traces.length === 0) throw new Error(NO_QUIC_CONNECTIONS_TEXT);
    return qlog as unknown as Record<string, unknown>;
}
