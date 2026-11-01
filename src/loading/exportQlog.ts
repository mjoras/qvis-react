// Download of a loaded group (file-loading spec §3.11 NEW, §9.6): always a latest-draft contained qlog file built from
// the group's raw objects (QlogConnection.rawTrace / QlogEvent.raw are never mutated by the model), pretty-printed
// with 2 spaces.
//
// Per trace (§9.6): the connection's events in its sorted order (PARITY), each the raw object by reference, except
// - time rule: if the serialized trace uses `relative_to_previous_event` anywhere, splitting / sorting changed the
//   events' predecessors, so every event is exported as a shallow copy with `time: resolvedTime` (no per-event
//   `time_format` / `reference_time`) and `common_fields` says `relative_to_epoch` with the connection's effective
//   `reference_time`; events with a malformed time always get `time: resolvedTime`;
// - D15: a group_id slice whose title is still the loader-generated "Group <id> : <title>" exports the raw title;
// - the loader-injected default vantage point ("No VantagePoint set") is omitted when the raw trace had none;
// - `event_schemas`: the raw value when non-empty, else derived from the namespaces with the draft suffixes.

import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import type { QlogEvent } from "@/model/QlogEvent";
import { MISSING_VANTAGE_POINT_NAME } from "@/model/types";
import { CONTAINED_FORMAT, CONTAINED_SCHEMA } from "./detect";

/** Namespaces with a standard event schema URI, and the suffix the sibling drafts require (§9.6). */
const SCHEMA_FOR_NAMESPACE: ReadonlyArray<readonly [string, string]> = [
    ["quic", "urn:ietf:params:qlog:events:quic-13"],
    ["http3", "urn:ietf:params:qlog:events:http3-13"],
    ["http", "urn:ietf:params:qlog:events:http-13"],
    ["loglevel", "urn:ietf:params:qlog:events:loglevel"],
    ["simulation", "urn:ietf:params:qlog:events:simulation"],
];

const DELTA = "relative_to_previous_event";

/**
 * `out[k] = v`, except that an own `"__proto__"` member (JSON.parse creates one) stays a data member: the plain
 * assignment would replace `out`'s prototype and silently drop the member from the download (security review).
 */
function setMember(out: Record<string, unknown>, k: string, v: unknown): void {
    if (k === "__proto__")
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    else out[k] = v;
}

/** Trace members we set explicitly or drop (`configuration` and `summary` were removed in main-schema-06). */
const HANDLED_TRACE_KEYS = new Set([
    "title",
    "description",
    "common_fields",
    "vantage_point",
    "event_schemas",
    "events",
    "configuration",
    "summary",
]);

type Raw = Record<string, unknown>;

function isPlainObject(v: unknown): v is Raw {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
}

function nameOf(rawEvent: unknown): string | undefined {
    if (rawEvent === null || typeof rawEvent !== "object") return undefined;
    const n = (rawEvent as { name?: unknown }).name;
    return typeof n === "string" ? n : undefined;
}

/**
 * `event_schemas` derived from the namespaces seen: quic -> urn:ietf:params:qlog:events:quic-13, http3 -> ...http3-13,
 * http -> ...http-13, loglevel / simulation unsuffixed; other namespaces add nothing (§9.6).
 */
export function deriveEventSchemas(events: readonly unknown[]): string[] {
    const seen = new Set<string>();
    for (const ev of events) {
        const name = nameOf(ev);
        if (name === undefined) continue;
        const colon = name.indexOf(":");
        if (colon > 0) seen.add(name.slice(0, colon));
    }
    return SCHEMA_FOR_NAMESPACE.filter(([ns]) => seen.has(ns)).map(([, uri]) => uri);
}

function traceErrorToJSON(conn: QlogConnection): Record<string, unknown> {
    const te = conn.traceError;
    const out: Record<string, unknown> = { error_description: te?.error_description ?? conn.description };
    if (te?.uri !== undefined) out.uri = te.uri;
    if (te?.vantage_point !== undefined) out.vantage_point = te.vantage_point;
    return out;
}

/** True if any event of the serialized trace has the effective time_format relative_to_previous_event. */
function usesDeltaTimes(raw: Readonly<Raw>, conn: QlogConnection): boolean {
    const cf = isPlainObject(raw.common_fields) ? raw.common_fields : conn.commonFields;
    if (cf.time_format === DELTA) return true;
    const events: readonly unknown[] = Array.isArray(raw.events) ? raw.events : conn.getEvents().map((e) => e.raw);
    for (const ev of events) if (isPlainObject(ev) && ev.time_format === DELTA) return true;
    return false;
}

/** The connection's effective reference_time: common_fields, else its first event's (file order), as the loader. */
function effectiveReferenceTime(conn: QlogConnection, cf: Readonly<Raw>): unknown {
    if (cf.reference_time !== undefined) return cf.reference_time;
    let first: QlogEvent | undefined;
    for (const ev of conn.getEvents()) if (first === undefined || ev.originalIndex < first.originalIndex) first = ev;
    return first?.raw.reference_time;
}

function exportEvent(ev: QlogEvent, rewriteTimes: boolean): unknown {
    const malformedTime = ev.malformed !== undefined && ev.malformed.includes("time");
    if (!rewriteTimes && !malformedTime) return ev.raw;
    const copy: Raw = { ...ev.raw, time: ev.resolvedTime };
    if (rewriteTimes) {
        delete copy.time_format;
        delete copy.reference_time;
    }
    return copy;
}

/** The loader's default for a trace without a (valid) vantage point, unchanged since loading. */
function isInjectedDefaultVantagePoint(conn: QlogConnection, raw: Readonly<Raw>): boolean {
    const rawVp = raw.vantage_point;
    if (isPlainObject(rawVp) && typeof rawVp.type === "string" && rawVp.type !== "") return false;
    const vp = conn.vantagePoint;
    return vp.type === "unknown" && vp.flow === "unknown" && vp.name === MISSING_VANTAGE_POINT_NAME;
}

/** D15: the raw title for a slice whose title is still the loader-generated "Group <id> : <title>". */
function exportTitle(conn: QlogConnection, raw: Readonly<Raw>): string | undefined {
    const rawTitle = typeof raw.title === "string" ? raw.title : undefined;
    if (conn.groupId !== undefined && conn.title === "Group " + conn.groupId + " : " + (rawTitle ?? "")) {
        return rawTitle !== undefined && rawTitle !== "" ? rawTitle : undefined;
    }
    return conn.title ? conn.title : undefined;
}

function traceToJSON(conn: QlogConnection): Record<string, unknown> {
    const raw: Readonly<Raw> = conn.rawTrace ?? {};
    const rewriteTimes = usesDeltaTimes(raw, conn);
    const events = conn.getEvents().map((ev) => exportEvent(ev, rewriteTimes));

    const out: Record<string, unknown> = {};
    const title = exportTitle(conn, raw);
    if (title !== undefined) out.title = title;
    if (conn.description) out.description = conn.description;

    const rawCf = isPlainObject(raw.common_fields) ? raw.common_fields : undefined;
    if (rewriteTimes) {
        const cf: Raw = { ...(rawCf ?? conn.commonFields), time_format: "relative_to_epoch" };
        const ref = effectiveReferenceTime(conn, rawCf ?? conn.commonFields);
        if (ref !== undefined) cf.reference_time = ref;
        else delete cf.reference_time;
        out.common_fields = cf;
    } else if (raw.common_fields !== undefined) out.common_fields = raw.common_fields;
    else if (Object.keys(conn.commonFields).length > 0) out.common_fields = conn.commonFields;

    if (!isInjectedDefaultVantagePoint(conn, raw)) out.vantage_point = conn.vantagePoint;

    if (isNonEmptyStringArray(raw.event_schemas)) out.event_schemas = raw.event_schemas;
    else if (conn.eventSchemas.length > 0) out.event_schemas = [...conn.eventSchemas];
    else {
        const derived = deriveEventSchemas(events);
        out.event_schemas = derived.length > 0 ? derived : Array.isArray(raw.event_schemas) ? raw.event_schemas : [];
    }
    for (const [k, v] of Object.entries(raw)) {
        if (!HANDLED_TRACE_KEYS.has(k)) setMember(out, k, v);
    }
    out.events = events;
    return out;
}

/** Root members we set explicitly or drop (pre-final `qlog_version`/`qlog_format`, removed `summary`). */
const HANDLED_ROOT_KEYS = new Set([
    "file_schema",
    "serialization_format",
    "title",
    "description",
    "traces",
    "trace",
    "summary",
    "qlog_version",
    "qlog_format",
]);

/** The group as a main-schema-14 contained QlogFile object. */
export function groupToContainedQlog(group: QlogConnectionGroup): Record<string, unknown> {
    const out: Record<string, unknown> = {
        file_schema: CONTAINED_SCHEMA,
        serialization_format: CONTAINED_FORMAT,
    };
    if (group.title) out.title = group.title;
    if (group.description) out.description = group.description;
    // other top-level members of the loaded file (e.g. quic-go's code_version) are kept
    for (const [k, v] of Object.entries(group.rawRoot ?? {})) {
        if (!HANDLED_ROOT_KEYS.has(k)) setMember(out, k, v);
    }

    // skip sequence-diagram generated mirror traces
    const connections = group.getConnections().filter((c) => !c.wasAutoGenerated);

    // group_id slices stay separate traces (PARITY)
    out.traces = connections.map((c) => (c.isError ? traceErrorToJSON(c) : traceToJSON(c)));
    return out;
}

/**
 * Download filename (PARITY with FIX Q13): the group filename, or for URL loads the last path segment of the URL
 * without query/hash; "trace" if empty; ".qlog" appended unless already there.
 */
export function downloadFilename(group: Pick<QlogConnectionGroup, "filename" | "URL">): string {
    let filename = "" + (group.filename ?? "");
    const url = group.URL;
    if (url && url.length > 0) {
        const clean = url.split("#")[0].split("?")[0];
        filename = clean.slice(clean.lastIndexOf("/") + 1);
    }
    if (filename.length === 0) filename = "trace";
    if (!filename.endsWith(".qlog")) filename += ".qlog";
    return filename;
}

export function serializeGroup(group: QlogConnectionGroup): string {
    return JSON.stringify(groupToContainedQlog(group), null, 2);
}

/** Revoke delay: long enough for every browser to start the download (FileSaver.js uses 40 s). */
const REVOKE_DELAY_MS = 40_000;

export function downloadGroup(group: QlogConnectionGroup): void {
    console.log("FileManagerContainer:downloadGroup : downloading latest-draft qlog representation of group ", group);
    const blob = new Blob([serializeGroup(group)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = downloadFilename(group);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(href), REVOKE_DELAY_MS);
}
