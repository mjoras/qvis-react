// One normalized event (data-model spec section 3.16.12). Created once at load; there is no cursor parser.
// The raw JSON object is kept by reference and never mutated (export and raw-JSON views show what was loaded).
//
// Performance: one instance per event (the 31 MB demo has ~10^6). The constructor is monomorphic: every field is
// assigned, always in the same order (`declare` fields avoid a second [[Define]] pass), and the times are
// getters over `resolvedTime`, so ConnectionTiming.setReferenceTime never touches events.

import type { QlogConnection } from "./QlogConnection";
import type { EventExtensions } from "./types";

export class QlogEvent {
    declare readonly conn: QlogConnection;
    /** untouched input object (export, detail modal) */
    declare readonly raw: Readonly<Record<string, unknown>>;
    /** index in trace.events (the serialized trace) */
    declare readonly originalIndex: number;
    /** index in conn.getEvents() (after sorting) — the sequence diagram's `focusOnEvent` refers to it */
    declare index: number;
    /** name as logged (`"unknown:unknown"` when missing) */
    declare readonly loggedName: string;
    /** `namespace:type`; equals loggedName (no aliasing) except for clone transforms */
    declare readonly fullName: string;
    /** "quic" (qvis: category) */
    declare readonly namespace: string;
    /** "packet_sent" (qvis: name) */
    declare readonly type: string;
    /** event data: `=== raw.data` (or common_fields.data); `{}` when missing or not an object */
    declare readonly data: any;
    /** `time` as logged (numeric strings parsed), NaN if malformed */
    declare readonly time: number;
    /** ms since the connection's effective epoch, delta-decoded (malformed: previous event's) */
    declare readonly resolvedTime: number;
    /** effective group_id (event, else common_fields), non-strings through JSON.stringify */
    declare readonly groupId: string | undefined;
    /** effective tuple, "" default */
    declare readonly tuple: string;
    /** names of members that were missing / invalid ("time", "name", "data") */
    declare readonly malformed: readonly string[] | undefined;
    /** renderer annotations (lazily created; never serialized) */
    declare ext: Partial<EventExtensions> | undefined;

    constructor(
        conn: QlogConnection,
        raw: Readonly<Record<string, unknown>>,
        originalIndex: number,
        index: number,
        loggedName: string,
        fullName: string,
        namespace: string,
        type: string,
        data: any,
        time: number,
        resolvedTime: number,
        groupId: string | undefined,
        tuple: string,
        malformed: readonly string[] | undefined,
    ) {
        this.conn = conn;
        this.raw = raw;
        this.originalIndex = originalIndex;
        this.index = index;
        this.loggedName = loggedName;
        this.fullName = fullName;
        this.namespace = namespace;
        this.type = type;
        this.data = data;
        this.time = time;
        this.resolvedTime = resolvedTime;
        this.groupId = groupId;
        this.tuple = tuple;
        this.malformed = malformed;
        this.ext = undefined;
    }

    /** ms, trace-local (x-axes). See ConnectionTiming. */
    get relativeTime(): number {
        return this.resolvedTime - this.conn.timing.relativeZero;
    }

    /** ms, comparable across traces (sequence diagram alignment). See ConnectionTiming. */
    get absoluteTime(): number {
        return this.resolvedTime + this.conn.timing.absoluteShift;
    }

    /** Always 0 (qvis parser.timeOffset; configuration.time_offset no longer exists). */
    get timeOffset(): number {
        return 0;
    }

    /** Units are always ms now: parseFloat (qvis parity for string values). */
    timeToMilliseconds(v: number | string): number {
        return typeof v === "number" ? v : parseFloat(v);
    }

    /** `this.fullName === fullName` */
    is(fullName: string): boolean {
        return this.fullName === fullName;
    }

    /** Effective top-level field: the event's own member, else `common_fields[key]` (main-schema section 7.5). */
    getField(key: string): unknown {
        const v = this.raw[key];
        return v !== undefined ? v : this.conn.commonFields[key];
    }

    /** Returns `ext`, creating it on first use. */
    ensureExt(): Partial<EventExtensions> {
        let ext = this.ext;
        if (ext === undefined) {
            ext = {};
            this.ext = ext;
        }
        return ext;
    }
}
