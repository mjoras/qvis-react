// QlogLoader.fromJSON(loaded, fileInfo) -> QlogConnectionGroup | undefined (data-model spec section 3.16.2).
//
//   A. validate root (P6 was done by the parser; legacy files never get here)
//   B. group: file_schema / serialization_format / title / description
//   C. per traces[i] (file order):
//        TraceError -> placeholder connection
//        Trace      -> normalize trace (P7) -> normalize events (P8) -> resolve times in FILE order (P9, delta
//                      decoding per serialized trace) -> split by group_id (D2 parity rule) -> per slice: stable sort
//                      (P10), timing (P12), lookup index
//   D. diagnostics: deduplicated by code, console once; the store shows the DM1/DM2/DM3 toasts.
//
// Names are used exactly as logged (no aliasing, ARCHITECTURE section 3.1); `data === raw.data`; nothing in the input
// JSON is mutated. One linear pass over the events; sorting only when needed.

import type { LoadedQlog } from "@/qlog/parse";
import { DiagnosticCollector, formatDiagnostic } from "@/qlog/parse/diagnostics";
import {
    fileSchemaFor,
    legacyVersionOfRoot,
    mediaTypeFor,
    normalizeMediaType,
    type Serialization,
} from "@/qlog/parse/normalize";
import { checkEventSchemas, isNonconformingName, parseEventSchemaUri, type EventSchemaInfo } from "./conformance";
import { QlogConnection } from "./QlogConnection";
import { QlogConnectionGroup, withoutChangeEvents } from "./QlogConnectionGroup";
import { QlogEvent } from "./QlogEvent";
import { epochMsOf } from "./time";
import { MISSING_VANTAGE_POINT_NAME, type QlogFileInfo, type TraceErrorInfo, type VantagePoint } from "./types";

/** Slice title / key for events without an effective group_id in a split trace. */
export const NO_GROUP_ID = "(no group_id)";

const KNOWN_VP_TYPES = new Set(["client", "server", "network", "unknown"]);
const KNOWN_VP_FLOWS = new Set(["client", "server", "unknown"]);

type Raw = Record<string, unknown>;

function isPlainObject(v: unknown): v is Raw {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringify(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v);
}

interface NameInfo {
    loggedName: string;
    namespace: string;
    type: string;
    noColon: boolean;
    nonconforming: boolean;
    count: number;
}

interface Slice {
    conn: QlogConnection;
    events: QlogEvent[];
    /** effective epoch of the slice: undefined until its first event */
    epoch: number | null | undefined;
    last: number;
    unordered: boolean;
}

interface LoadContext {
    group: QlogConnectionGroup;
    root: Raw;
    diag: DiagnosticCollector;
}

function normalizeVantagePoint(vp: unknown, diag: DiagnosticCollector, traceIndex: number): VantagePoint {
    if (vp === undefined) {
        diag.info("trace.missing-vantage-point", 'A trace has no vantage_point; it is shown as "No VantagePoint set"', {
            traceIndex,
        });
        return { type: "unknown", flow: "unknown", name: MISSING_VANTAGE_POINT_NAME };
    }
    if (!isPlainObject(vp) || typeof vp.type !== "string" || vp.type === "") {
        diag.warn(
            "trace.invalid-vantage-point",
            'A trace\'s vantage_point is invalid (no type); it is shown as "No VantagePoint set"',
            { traceIndex, sample: vp },
        );
        // qvis overwrote a provided name here; keep it (FIX, minor)
        const name =
            isPlainObject(vp) && typeof vp.name === "string" && vp.name !== "" ? vp.name : MISSING_VANTAGE_POINT_NAME;
        return { type: "unknown", flow: "unknown", name };
    }
    const out: VantagePoint = { type: vp.type };
    if (vp.name !== undefined) out.name = typeof vp.name === "string" ? vp.name : stringify(vp.name);
    if (vp.flow !== undefined) out.flow = typeof vp.flow === "string" ? vp.flow : stringify(vp.flow);
    if (!KNOWN_VP_TYPES.has(vp.type) || (out.flow !== undefined && !KNOWN_VP_FLOWS.has(out.flow))) {
        diag.warn("trace.unknown-vantage-point-type", "A trace's vantage_point has an unknown type or flow", {
            traceIndex,
            sample: vp,
        });
    }
    return out;
}

function loadTraceError(ctx: LoadContext, entry: Raw, traceIndex: number): void {
    const errorDescription = entry.error_description as string;
    const uri = entry.uri === undefined ? undefined : stringify(entry.uri);
    const info: TraceErrorInfo = { error_description: errorDescription };
    if (uri !== undefined) info.uri = uri;
    let vantagePoint: VantagePoint | undefined;
    if (
        isPlainObject(entry.vantage_point) &&
        typeof entry.vantage_point.type === "string" &&
        entry.vantage_point.type !== ""
    ) {
        vantagePoint = normalizeVantagePoint(entry.vantage_point, ctx.diag, traceIndex);
        info.vantage_point = vantagePoint;
    }
    new QlogConnection(ctx.group, {
        title: "ERROR",
        // FIX: no "undefined : " prefix when the (optional) uri is absent
        description: (uri !== undefined ? uri + " : " : "") + errorDescription,
        vantagePoint, // undefined -> constructor default {type: "unknown", flow: "unknown"} without name (PARITY)
        traceIndex,
        rawTrace: entry,
        isError: true,
        traceError: info,
    });
    ctx.diag.info(
        "trace.error",
        "The file contains TraceError entries (traces that could not be loaded by the producer)",
        {
            traceIndex,
            sample: errorDescription,
        },
    );
}

function eventSchemasOf(ctx: LoadContext, entry: Raw, traceIndex: number): string[] {
    const raw = entry.event_schemas;
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === "string")) return raw as string[];
    ctx.diag.warn("trace.missing-event-schemas", "A trace has no valid event_schemas list", {
        traceIndex,
        sample: raw,
    });
    const fallback = Array.isArray(raw) ? raw : ctx.root.event_schemas; // lenient: pre -11 file-level event_schemas
    return Array.isArray(fallback) ? fallback.filter((s): s is string => typeof s === "string") : [];
}

function makeEpochResolver(ctx: LoadContext, traceIndex: number): (ref: unknown) => number | null {
    const report = (code: string, message: string, sample?: unknown): void => {
        ctx.diag.warn(code, message, { traceIndex, sample });
    };
    let lastRef: unknown = undefined;
    let lastEpoch: number | null = 0;
    const byKey = new Map<string, number | null>();
    return (ref: unknown): number | null => {
        if (ref === lastRef) return lastEpoch;
        let epoch: number | null;
        if (isPlainObject(ref) && typeof ref.epoch === "string") {
            const key = String(ref.clock_type) + "\u0000" + ref.epoch;
            const cached = byKey.get(key);
            if (cached !== undefined || byKey.has(key)) epoch = cached as number | null;
            else {
                epoch = epochMsOf(ref, report);
                byKey.set(key, epoch);
            }
        } else {
            epoch = epochMsOf(ref, report);
        }
        lastRef = ref;
        lastEpoch = epoch;
        return epoch;
    };
}

function compareEvents(a: QlogEvent, b: QlogEvent): number {
    return a.resolvedTime - b.resolvedTime || a.originalIndex - b.originalIndex;
}

function loadTrace(ctx: LoadContext, entry: Raw, traceIndex: number): QlogConnection[] {
    const { group, diag } = ctx;
    const title = typeof entry.title === "string" ? entry.title : "";
    const description = typeof entry.description === "string" ? entry.description : "";

    let cf: Raw;
    if (entry.common_fields === undefined) cf = {};
    else if (isPlainObject(entry.common_fields)) cf = entry.common_fields;
    else {
        diag.warn("trace.invalid-common-fields", "A trace's common_fields is not an object; it was ignored", {
            traceIndex,
            sample: entry.common_fields,
        });
        cf = {};
    }
    const eventSchemas = eventSchemasOf(ctx, entry, traceIndex);
    const schemaInfos: EventSchemaInfo[] = eventSchemas.map(parseEventSchemaUri);
    const vantagePoint = normalizeVantagePoint(entry.vantage_point, diag, traceIndex);
    if (entry.event_fields !== undefined) {
        diag.warn(
            "trace.event-fields-unsupported",
            "A trace uses event_fields (removed in qlog draft-02); array events were skipped",
            { traceIndex },
        );
    }

    let rawEvents: unknown[];
    if (Array.isArray(entry.events)) rawEvents = entry.events;
    else {
        if (entry.events === undefined) {
            diag.warn("trace.missing-events", "A trace has no events array", { traceIndex });
        } else {
            diag.warn("trace.invalid-events", "A trace's events member is not an array; it was ignored", {
                traceIndex,
            });
        }
        rawEvents = [];
    }
    const n = rawEvents.length;

    // D2 parity rule: split when at least one event carries its own group_id member
    let split = false;
    for (let i = 0; i < n; i++) {
        const ev = rawEvents[i];
        if (typeof ev === "object" && ev !== null && (ev as Raw).group_id !== undefined) {
            split = true;
            break;
        }
    }

    const makeConnection = (groupId: string | undefined): QlogConnection =>
        new QlogConnection(group, {
            title: groupId !== undefined ? "Group " + groupId + " : " + title : title,
            description,
            vantagePoint: { ...vantagePoint }, // own copy per slice (FIX Q8)
            commonFields: cf,
            eventSchemas,
            groupId,
            traceIndex,
            rawTrace: entry,
        });
    const newSlice = (groupId: string | undefined): Slice => ({
        conn: makeConnection(groupId),
        events: [],
        epoch: undefined,
        last: -Infinity,
        unordered: false,
    });

    const slices: Slice[] = [];
    const sliceById = new Map<string, Slice>();
    const single = split ? undefined : newSlice(undefined);
    if (single) slices.push(single);

    // effective common values
    const cfName = cf.name;
    const cfData = cf.data;
    const cfTimeFormat = cf.time_format;
    const cfTuple = typeof cf.tuple === "string" ? cf.tuple : "";
    const cfGroupId = cf.group_id === undefined ? undefined : stringify(cf.group_id);
    const cfRef = cf.reference_time;
    const epochOf = makeEpochResolver(ctx, traceIndex);
    const cfEpoch = cfRef === undefined ? 0 : epochOf(cfRef);

    const names = new Map<string, NameInfo>();
    const missingName: NameInfo = {
        loggedName: "unknown:unknown",
        namespace: "unknown",
        type: "unknown",
        noColon: false,
        nonconforming: false,
        count: 0,
    };
    let notObject = 0;
    let notObjectSample: unknown = undefined;
    let timeStrings = 0;
    let missingTime = 0;
    let invalidName = 0;
    let missingData = 0;
    let invalidData = 0;
    let unknownFormat = 0;
    let unknownFormatSample: unknown = undefined;
    let mixedEpochs = 0;
    let firstMalformedIndex = -1;

    let prev: number | undefined = undefined;
    for (let i = 0; i < n; i++) {
        const ev = rawEvents[i] as Raw;
        if (typeof ev !== "object" || ev === null || Array.isArray(ev)) {
            notObject++;
            if (notObjectSample === undefined) notObjectSample = ev;
            continue;
        }
        const rawTime = ev.time;
        const rawName = ev.name;
        let rawData = ev.data;
        if (rawTime === undefined && rawName === undefined && rawData === undefined) {
            let empty = true;
            for (const _k in ev) {
                empty = false;
                break;
            }
            if (empty) continue; // `{}`: skipped silently (qvis trailing-comma accommodation, now everywhere)
        }
        let malformed: string[] | undefined = undefined;

        // time (P8)
        let time: number;
        if (typeof rawTime === "number" && rawTime - rawTime === 0) time = rawTime;
        else if (typeof rawTime === "string" && (time = parseFloat(rawTime)) - time === 0) timeStrings++;
        else {
            time = NaN;
            missingTime++;
            malformed = ["time"];
        }

        // name (P8; no aliasing: fullName === loggedName)
        const nm = rawName !== undefined ? rawName : cfName;
        let info: NameInfo;
        if (typeof nm === "string") {
            let cached = names.get(nm);
            if (cached === undefined) {
                const colon = nm.indexOf(":");
                const namespace = colon < 0 ? "unknown" : nm.slice(0, colon);
                cached = {
                    loggedName: nm,
                    namespace,
                    type: colon < 0 ? nm : nm.slice(colon + 1),
                    noColon: colon < 0,
                    nonconforming: colon >= 0 && isNonconformingName(nm, namespace, schemaInfos),
                    count: 0,
                };
                names.set(nm, cached);
            }
            info = cached;
        } else {
            info = missingName;
            if (nm !== undefined) invalidName++;
            if (malformed === undefined) malformed = ["name"];
            else malformed.push("name");
        }
        info.count++;

        // data (P8): plain object, else {} (raw value stays in raw)
        if (rawData === undefined) rawData = cfData;
        let data: any;
        if (typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)) data = rawData;
        else {
            data = {};
            if (rawData === undefined) missingData++;
            else invalidData++;
            if (malformed === undefined) malformed = ["data"];
            else malformed.push("data");
        }
        if (malformed !== undefined && firstMalformedIndex < 0) firstMalformedIndex = i;

        // effective shared fields
        const gidRaw = ev.group_id;
        const groupId = gidRaw === undefined ? cfGroupId : stringify(gidRaw);
        const tupleRaw = ev.tuple;
        const tuple = tupleRaw === undefined ? cfTuple : typeof tupleRaw === "string" ? tupleRaw : stringify(tupleRaw);
        const fmt = ev.time_format !== undefined ? ev.time_format : cfTimeFormat;

        // P9 step A: delta decoding in FILE order of the serialized trace (before splitting and sorting)
        let resolved: number;
        if (time !== time)
            resolved = prev === undefined ? 0 : prev; // malformed: keep the logged position
        else if (fmt === "relative_to_previous_event") resolved = prev === undefined ? time : prev + time;
        else {
            if (fmt !== undefined && fmt !== "relative_to_epoch") {
                unknownFormat++;
                if (unknownFormatSample === undefined) unknownFormatSample = fmt;
            }
            resolved = time;
        }
        prev = resolved;

        // P9 step B: epoch
        const ref = ev.reference_time;
        const evEpoch = ref === undefined ? cfEpoch : epochOf(ref);

        // split (P11)
        let slice: Slice;
        if (single !== undefined) slice = single;
        else {
            const key = groupId === undefined ? NO_GROUP_ID : groupId;
            let s = sliceById.get(key);
            if (s === undefined) {
                s = newSlice(key);
                sliceById.set(key, s);
                slices.push(s);
            }
            slice = s;
        }
        if (slice.epoch === undefined) slice.epoch = cfRef !== undefined ? cfEpoch : evEpoch;
        let shifted = resolved;
        if (evEpoch !== slice.epoch) {
            // mixed per-event reference_time: pre-shift onto the slice epoch so the getters stay uniform
            mixedEpochs++;
            if (evEpoch !== null && slice.epoch !== null) shifted = resolved + (evEpoch - slice.epoch);
        }

        const qe = new QlogEvent(
            slice.conn,
            ev,
            i,
            slice.events.length,
            info.loggedName,
            info.loggedName,
            info.namespace,
            info.type,
            data,
            time,
            shifted,
            groupId,
            tuple,
            malformed,
        );
        if (shifted < slice.last) slice.unordered = true;
        slice.last = shifted;
        slice.events.push(qe);
    }

    // per slice: order (P10), timing (P12), index
    for (const slice of slices) {
        const events = slice.events;
        if (slice.unordered) {
            let at = 1;
            while (at < events.length && events[at].resolvedTime >= events[at - 1].resolvedTime) at++;
            const before = events[at - 1];
            const after = events[at];
            events.sort(compareEvents);
            for (let k = 0; k < events.length; k++) events[k].index = k;
            diag.warn("trace.reordered", "Trace events were not ordered by timestamp; they were sorted (stable sort)", {
                traceIndex,
                sample: { connection: slice.conn.title, originalIndex: after.originalIndex },
            });
            console.warn(
                "QlogLoader: trace " +
                    traceIndex +
                    (slice.conn.groupId !== undefined ? " (group " + slice.conn.groupId + ")" : "") +
                    " was not ordered on event timestamps: event #" +
                    after.originalIndex +
                    " (" +
                    after.loggedName +
                    ", time " +
                    after.resolvedTime +
                    ") < event #" +
                    before.originalIndex +
                    " (" +
                    before.loggedName +
                    ", time " +
                    before.resolvedTime +
                    "). Sorted the events by timestamp (stable sort).",
            );
        }
        const epoch = slice.epoch === undefined ? cfEpoch : slice.epoch;
        slice.conn.timing.setCase(epoch, events.length > 0 ? events[0].resolvedTime : 0);
        if (epoch === null) {
            diag.info(
                "time.unknown-epoch",
                "A trace has an unknown reference time epoch (e.g. a monotonic clock); its times start at 0",
                { traceIndex },
            );
        }
        slice.conn.initEvents(events);
    }

    // diagnostics (P8)
    if (n === 0) diag.info("trace.no-events", "A trace has no events", { traceIndex });
    if (notObject > 0) {
        diag.warn("event.not-object", "Some events are not JSON objects; they were skipped", {
            traceIndex,
            count: notObject,
            sample: Array.isArray(notObjectSample)
                ? "array"
                : notObjectSample === null
                  ? "null"
                  : typeof notObjectSample,
        });
    }
    if (timeStrings > 0) {
        diag.warn("event.time-string", "Some events have their time as a string instead of a number", {
            traceIndex,
            count: timeStrings,
        });
    }
    if (missingTime > 0) {
        diag.warn(
            "event.missing-time",
            "Some events have no valid time; they were placed at the previous event's time",
            { traceIndex, count: missingTime, sample: firstMalformedIndex },
        );
    }
    if (missingName.count - invalidName > 0) {
        diag.warn("event.missing-name", "Some events have no name; they are shown as unknown:unknown", {
            traceIndex,
            count: missingName.count - invalidName,
        });
    }
    if (invalidName > 0) {
        diag.warn(
            "event.invalid-name",
            "Some events have a name that is not a string; they are shown as unknown:unknown",
            {
                traceIndex,
                count: invalidName,
            },
        );
    }
    if (missingData > 0) {
        diag.warn("event.missing-data", "Some events have no data member", { traceIndex, count: missingData });
    }
    if (invalidData > 0) {
        diag.warn("event.invalid-data", "Some events have a data member that is not an object", {
            traceIndex,
            count: invalidData,
        });
    }
    if (unknownFormat > 0) {
        diag.warn(
            "event.unknown-time-format",
            "Some events use an unknown time_format; it was treated as relative_to_epoch",
            { traceIndex, count: unknownFormat, sample: unknownFormatSample },
        );
    }
    if (mixedEpochs > 0) {
        diag.warn(
            "time.mixed-reference-times",
            "Events of one trace use different reference_time epochs; their times were aligned to the trace's epoch",
            { traceIndex, count: mixedEpochs },
        );
    }

    // names: no namespace / non-conforming (DM3)
    let noColonCount = 0;
    const noColonSamples: string[] = [];
    let nonconformingCount = 0;
    const nonconformingSamples: string[] = [];
    for (const info of names.values()) {
        if (info.noColon) {
            noColonCount += info.count;
            noColonSamples.push(info.loggedName);
        } else if (info.nonconforming) {
            nonconformingCount += info.count;
            nonconformingSamples.push(info.loggedName);
        }
    }
    if (noColonCount > 0) {
        diag.warn("event.name-without-namespace", 'Some event names have no namespace (no "namespace:" prefix)', {
            traceIndex,
            count: noColonCount,
            sample: noColonSamples[0],
        });
        for (let k = 1; k < noColonSamples.length; k++)
            diag.add("warning", "event.name-without-namespace", "", { count: 0, sample: noColonSamples[k] });
    }
    if (nonconformingCount > 0) {
        diag.warn(
            "event.nonconforming-name",
            "Some events use names that are not defined by the latest qlog drafts (quic-events-13, h3-events-13)",
            { traceIndex, count: nonconformingCount, sample: nonconformingSamples[0] },
        );
        for (let k = 1; k < nonconformingSamples.length; k++) {
            diag.add("warning", "event.nonconforming-name", "", { count: 0, sample: nonconformingSamples[k] });
        }
    }

    // P14: event schema sanity (info only)
    const observed = new Set<string>();
    for (const info of names.values()) observed.add(info.namespace);
    const schemaCheck = checkEventSchemas(schemaInfos, observed);
    for (const ns of schemaCheck.unlistedNamespaces) {
        diag.info("schema.unlisted-namespace", "Some event namespaces are not listed in the trace's event_schemas", {
            traceIndex,
            sample: ns,
        });
    }
    // listed schemas without events are not reported: main-schema-14 says listed schemas need not have their events
    // present, and quic-go lists `loglevel` in every trace (the Stats Diagnostics row showed it for every demo file)
    for (const uri of schemaCheck.draftMismatches) {
        diag.info(
            "schema.draft-mismatch",
            "Some event_schemas entries reference a different draft than the supported ones (quic-13, http3-13)",
            { traceIndex, sample: uri },
        );
    }

    return slices.map((s) => s.conn);
}

function logDiagnostics(group: QlogConnectionGroup): void {
    const prefix = "QlogLoader: " + (group.filename ? group.filename + ": " : "");
    for (const d of group.diagnostics) {
        const line = prefix + formatDiagnostic(d);
        if (d.level === "info") console.info(line, d.samples ?? "");
        else console.warn(line, d.samples ?? "");
    }
}

function loadGroup(loaded: LoadedQlog, fileInfo: QlogFileInfo | undefined): QlogConnectionGroup | undefined {
    const root = loaded?.root as unknown;
    if (!isPlainObject(root)) {
        console.error("QlogLoader: the qlog file is not a JSON object", root);
        return undefined;
    }
    const legacy = legacyVersionOfRoot(root);
    if (legacy !== undefined) {
        console.error("QlogLoader: legacy qlog files (qlog_version " + legacy + ") are not supported", root);
        return undefined;
    }
    let traces: unknown[];
    if (Array.isArray(root.traces)) traces = root.traces;
    else if (isPlainObject(root.trace))
        traces = [root.trace]; // non-normalized sequential root
    else {
        console.error("QlogLoader: qlog files MUST have a traces array (or a sequential trace object)", root);
        return undefined;
    }

    const serialization: Serialization = loaded.serialization === "json-seq" ? "json-seq" : "json";
    const diag = new DiagnosticCollector();
    diag.merge(loaded.diagnostics);

    const group = new QlogConnectionGroup();
    group.fileSchema = typeof root.file_schema === "string" ? root.file_schema : fileSchemaFor(serialization);
    group.serializationFormat =
        typeof root.serialization_format === "string"
            ? normalizeMediaType(root.serialization_format)
            : mediaTypeFor(serialization);
    group.version = group.fileSchema;
    group.format = group.serializationFormat;
    group.serialization = serialization;
    group.title = typeof root.title === "string" ? root.title : "";
    group.description = typeof root.description === "string" ? root.description : "";
    group.rawRoot = root;
    if (fileInfo) {
        if (fileInfo.filename !== undefined) group.filename = fileInfo.filename;
        if (fileInfo.URL !== undefined) group.URL = fileInfo.URL;
        if (fileInfo.URLshort !== undefined) group.URLshort = fileInfo.URLshort;
    }

    const ctx: LoadContext = { group, root, diag };
    const schemas = new Set<string>();
    if (traces.length === 0) diag.info("file.no-traces", "The file contains no traces");
    withoutChangeEvents(group, () => {
        for (let i = 0; i < traces.length; i++) {
            const entry = traces[i];
            if (!isPlainObject(entry)) {
                diag.warn("trace.not-object", "Some traces are not JSON objects; they were skipped", { traceIndex: i });
                continue;
            }
            if (typeof entry.error_description === "string") {
                loadTraceError(ctx, entry, i);
                continue;
            }
            for (const conn of loadTrace(ctx, entry, i)) for (const s of conn.eventSchemas) schemas.add(s);
        }
    });
    group.eventSchemas = Array.from(schemas);
    group.diagnostics.push(...diag.toArray());
    logDiagnostics(group);
    return group;
}

export const QlogLoader = {
    /**
     * Builds the model for one loaded file. Returns undefined (with a console.error) when the root is not a qlog
     * object, is a legacy file, or has neither a `traces` array nor a sequential `trace` object; the store then shows
     * the "ERROR parsing qlog file" toast. Never throws.
     */
    fromJSON(loaded: LoadedQlog, fileInfo?: QlogFileInfo): QlogConnectionGroup | undefined {
        try {
            return loadGroup(loaded, fileInfo);
        } catch (e) {
            console.error("QlogLoader: could not load qlog file", fileInfo?.filename ?? "", e);
            return undefined;
        }
    },

    /** Convenience for already-normalized roots (converters, debug page): `fromJSON({root, serialization, diagnostics: []})`. */
    fromRoot(
        root: Record<string, unknown>,
        fileInfo?: QlogFileInfo,
        serialization: Serialization = "json",
    ): QlogConnectionGroup | undefined {
        return QlogLoader.fromJSON({ root, serialization, diagnostics: [] }, fileInfo);
    },
};
