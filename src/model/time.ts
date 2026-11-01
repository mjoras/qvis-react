// Time model (data-model spec section 3.16.3, main-schema digest P9/P12).
//
// Per event: resolvedTime = ms relative to the effective reference_time epoch, after delta decoding.
// Per connection (ConnectionTiming), with start = first resolvedTime after sorting:
//   A  epochMs === 0 (Unix epoch or no reference_time)   relative = resolved - start   absolute = resolved
//   R  epochMs finite, non-zero                           relative = resolved           absolute = epochMs + resolved
//   U  epochMs === null (unknown / monotonic)              relative = resolved - start   absolute = resolved - start + ref

import type { QlogConnection } from "./QlogConnection";
import { modelEvents } from "./modelEvents";

export enum TimeTrackingMethod {
    ABSOLUTE_TIME,
    RELATIVE_TIME,
    DELTA_TIME,
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

/** RFC 3339 -> ms since the Unix epoch, keeping sub-ms precision. null if unparseable. */
export function parseRfc3339Ms(s: string): number | null {
    const m = RFC3339.exec(s.trim());
    if (!m) {
        const t = Date.parse(s);
        return Number.isNaN(t) ? null : t;
    }
    const [, Y, Mo, D, h, mi, sec, frac, z, sign, oh, om] = m;
    const d = new Date(0);
    d.setUTCFullYear(+Y, +Mo - 1, +D); // avoids Date.UTC's 0..99 => 19xx quirk
    d.setUTCHours(+h, +mi, Math.min(+sec, 59), 0); // leap second 60 -> 59
    let ms = d.getTime() + (frac ? parseFloat(frac) * 1000 : 0);
    if (z !== "Z" && z !== "z") ms -= (sign === "+" ? 1 : -1) * (+oh * 60 + +om) * 60000;
    return ms;
}

/** Reports a time-related problem (diagnostic code, message, sample). */
export type TimeProblemReporter = (code: string, message: string, sample?: unknown) => void;

/**
 * Epoch of a reference_time in ms since the Unix epoch:
 * - undefined (no reference_time anywhere): 0, the CDDL default (system clock, Unix epoch);
 * - `epoch: "unknown"` (or missing / unparseable): null;
 * - legacy numeric reference_time (number or numeric string, non-compliant): that number, with a warning.
 */
export function epochMsOf(ref: unknown, report?: TimeProblemReporter): number | null {
    if (ref === undefined) return 0;
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        const n = typeof ref === "number" ? ref : typeof ref === "string" && ref.trim() !== "" ? Number(ref) : NaN;
        report?.(
            "time.legacy-reference-time",
            "reference_time is not an object (legacy numeric value); it was interpreted as milliseconds since the Unix epoch",
            ref,
        );
        return Number.isFinite(n) ? n : null;
    }
    const r = ref as { clock_type?: unknown; epoch?: unknown };
    if (r.epoch === "unknown") return null;
    if (r.epoch === undefined) {
        report?.("time.missing-epoch", "reference_time has no epoch; it was treated as unknown", ref);
        return null;
    }
    if (typeof r.epoch !== "string") {
        report?.(
            "time.unparseable-epoch",
            "reference_time.epoch is not an RFC 3339 date-time; it was treated as unknown",
            r.epoch,
        );
        return null;
    }
    if (r.clock_type === "monotonic") {
        report?.(
            "time.monotonic-with-epoch",
            'reference_time uses a monotonic clock with a dated epoch (the epoch MUST be "unknown"); the epoch was used anyway',
            r.epoch,
        );
    }
    const ms = parseRfc3339Ms(r.epoch);
    if (ms === null) {
        report?.(
            "time.unparseable-epoch",
            "reference_time.epoch is not an RFC 3339 date-time; it was treated as unknown",
            r.epoch,
        );
    }
    return ms;
}

/**
 * Per-connection time base. Replaces qvis's IQlogEventParser time contract (getAbsoluteStartTime,
 * getTimeTrackingMethod, setReferenceTime, timeOffset, timeToMilliseconds). O(1) per event access.
 */
export class ConnectionTiming {
    /** ABSOLUTE_TIME (case A) or RELATIVE_TIME (cases R and U); DELTA_TIME is never produced. */
    method: TimeTrackingMethod = TimeTrackingMethod.ABSOLUTE_TIME;
    /** Subtracted from resolvedTime for relativeTime. A: start, R: 0, U: start. */
    relativeZero = 0;
    /** Added to resolvedTime for absoluteTime. A: 0, R: epochMs, U: -start (+ setReferenceTime offset). */
    absoluteShift = 0;
    /** getAbsoluteStartTime(). A: start, R: epochMs, U: 0 (or the value given to setReferenceTime). */
    absoluteStart = 0;
    /** Epoch of the connection's effective reference_time: 0 (Unix / default), ms, or null (unknown). */
    epochMs: number | null = 0;
    /** configuration.time_offset no longer exists: always 0 (qvis `parser.timeOffset`). */
    readonly timeOffset = 0;
    /** Connection notified on setReferenceTime (change notification). */
    owner: QlogConnection | undefined;

    constructor(owner?: QlogConnection) {
        this.owner = owner;
    }

    /** Sets the time case from the connection's epoch and its first (minimum) resolved time. */
    setCase(epochMs: number | null, start: number): void {
        this.epochMs = epochMs;
        if (epochMs === 0) {
            this.method = TimeTrackingMethod.ABSOLUTE_TIME;
            this.relativeZero = start;
            this.absoluteShift = 0;
            this.absoluteStart = start;
        } else if (epochMs !== null && Number.isFinite(epochMs)) {
            this.method = TimeTrackingMethod.RELATIVE_TIME;
            this.relativeZero = 0;
            this.absoluteShift = epochMs;
            this.absoluteStart = epochMs;
        } else {
            this.epochMs = null;
            this.method = TimeTrackingMethod.RELATIVE_TIME;
            this.relativeZero = start;
            this.absoluteShift = -start;
            this.absoluteStart = 0;
        }
    }

    copyFrom(other: ConnectionTiming): void {
        this.method = other.method;
        this.relativeZero = other.relativeZero;
        this.absoluteShift = other.absoluteShift;
        this.absoluteStart = other.absoluteStart;
        this.epochMs = other.epochMs;
    }

    getAbsoluteStartTime(): number {
        return this.absoluteStart;
    }

    getTimeTrackingMethod(): TimeTrackingMethod {
        return this.method;
    }

    /**
     * qvis `setReferenceTime(ms)` (sequence diagram: align a trace without reference time to its peer).
     * Only meaningful for RELATIVE_TIME connections (cases R and U); ignored for ABSOLUTE_TIME (FIX Q22).
     */
    setReferenceTime(ms: number): void {
        if (this.method !== TimeTrackingMethod.RELATIVE_TIME) return;
        this.absoluteShift += ms - this.absoluteStart;
        this.absoluteStart = ms;
        modelEvents.emit({ kind: "timing-changed", connection: this.owner });
    }

    /** Units are always ms now: parseFloat. */
    timeToMilliseconds(v: number | string): number {
        return typeof v === "number" ? v : parseFloat(v);
    }

    /** Porting shim for `getEventParser().load(evt)`: there is no cursor, the event is returned as is. */
    load<T>(ev: T): T {
        return ev;
    }
}
