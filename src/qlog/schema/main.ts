// draft-ietf-quic-qlog-main-schema-14: raw input types (docs/dev/qlog-spec/main-schema.md section 23).
// These describe the JSON as it is logged. The in-memory model (src/model) wraps them; nothing here is mutated.

export const FILE_SCHEMA_CONTAINED = "urn:ietf:params:qlog:file:contained";
export const FILE_SCHEMA_SEQUENTIAL = "urn:ietf:params:qlog:file:sequential";
export const MEDIA_TYPE_JSON = "application/qlog+json";
export const MEDIA_TYPE_JSON_SEQ = "application/qlog+json-seq";
export const RECORD_SEPARATOR = "\u001e";

/** CDDL default epoch of `ReferenceTime` (the Unix epoch). */
export const UNIX_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Event schema URIs defined by main-schema-14 itself (final, no draft suffix). */
export const EVENT_SCHEMA_LOGLEVEL = "urn:ietf:params:qlog:events:loglevel";
export const EVENT_SCHEMA_SIMULATION = "urn:ietf:params:qlog:events:simulation";
/** Prefix of every RFC-defined event schema URI (`urn:ietf:params:qlog:events:<namespace>[-NN][#ext]`). */
export const EVENT_SCHEMA_URN_PREFIX = "urn:ietf:params:qlog:events:";

export type Uint64 = number | string; // I-JSON: MAY be a decimal string
export type HexString = string; // /^([0-9a-f]{2})*$/

export interface LogFile {
    file_schema: string;
    serialization_format: string;
    title?: string;
    description?: string;
}
export interface QlogFile extends LogFile {
    traces?: Array<Trace | TraceError>;
}
export interface QlogFileSeq extends LogFile {
    trace: TraceSeq;
}

export interface TraceSeq {
    title?: string;
    description?: string;
    common_fields?: CommonFields;
    vantage_point?: VantagePoint;
    event_schemas: string[]; // [+text]
}
export interface Trace extends TraceSeq {
    events: QlogEvent[];
}
export interface TraceError {
    error_description: string;
    uri?: string;
    vantage_point?: VantagePoint;
}

export type VantagePointType = "client" | "server" | "network" | "unknown";
export type VantagePointFlow = "client" | "server" | "unknown";
export interface VantagePoint {
    name?: string;
    type: VantagePointType;
    flow?: VantagePointFlow;
}

export type ClockType = "system" | "monotonic" | (string & {});
export interface ReferenceTime {
    clock_type: ClockType; // .default "system"
    epoch: string; // RFC 3339 date-time or "unknown"
    wall_clock_time?: string; // RFC 3339
}
export type TimeFormat = "relative_to_epoch" | "relative_to_previous_event";
export type TupleID = string; // .default ""
export type GroupID = string;
export interface SystemInformation {
    processor_id?: number;
    process_id?: number;
    thread_id?: number;
}

export interface CommonFields {
    tuple?: TupleID;
    time_format?: TimeFormat;
    reference_time?: ReferenceTime;
    group_id?: GroupID;
    [custom: string]: unknown;
}

/** A raw qlog event as logged (main-schema-14 section 7). The model's `QlogEvent` class wraps one of these. */
export interface QlogEvent<D extends object = Record<string, unknown>> {
    time: number; // float64 ms
    name: string; // "namespace:event_type"
    data: D;
    tuple?: TupleID;
    time_format?: TimeFormat;
    group_id?: GroupID;
    system_info?: SystemInformation;
    reference_time?: ReferenceTime; // legal via the CommonFields "on each event" rule (section 7.5)
    [custom: string]: unknown;
}
/** Alias of the raw event shape, to avoid confusion with the model's `QlogEvent` class. */
export type RawQlogEvent<D extends object = Record<string, unknown>> = QlogEvent<D>;

export interface RawInfo {
    length?: Uint64;
    payload_length?: Uint64;
    data?: HexString;
}

// loglevel namespace (main-schema-14 section 9.1)
export interface LogLevelError {
    code?: Uint64;
    message?: string;
    [ext: string]: unknown;
}
export interface LogLevelWarning {
    code?: Uint64;
    message?: string;
    [ext: string]: unknown;
}
export interface LogLevelInfo {
    message: string;
    [ext: string]: unknown;
}
export interface LogLevelDebug {
    message: string;
    [ext: string]: unknown;
}
export interface LogLevelVerbose {
    message: string;
    [ext: string]: unknown;
}
export type LogLevelEventData = LogLevelError | LogLevelWarning | LogLevelInfo | LogLevelDebug | LogLevelVerbose;

// simulation namespace (main-schema-14 section 9.2)
export interface SimulationScenario {
    name?: string;
    details?: Record<string, unknown>;
    [ext: string]: unknown;
}
export interface SimulationMarker {
    type?: string;
    message?: string;
    [ext: string]: unknown;
}
export type SimulationEventData = SimulationScenario | SimulationMarker;
