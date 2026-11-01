// Shared model types (data-model spec section 3.16.9 / 3.16.12).

import type { QlogConnection } from "./QlogConnection";
import type { QlogEvent } from "./QlogEvent";

export type { Diagnostic, DiagnosticLevel } from "@/qlog/parse/diagnostics";
export type {
    CommonFields,
    QlogFile,
    QlogFileSeq,
    RawQlogEvent,
    ReferenceTime,
    Trace,
    TraceError,
    TraceSeq,
    TimeFormat,
    Uint64,
} from "@/qlog/schema/main";

/** A trace's vantage point. Unknown `type` strings are kept for display; perspective logic treats them as unknown. */
export interface VantagePoint {
    name?: string;
    type: "client" | "server" | "network" | "unknown" | (string & {});
    flow?: "client" | "server" | "unknown" | (string & {});
}

/** `{type: "unknown", flow: "unknown"}`: QlogConnection constructor default (qvis parity, no name). */
export const DEFAULT_VANTAGE_POINT: Readonly<VantagePoint> = Object.freeze({ type: "unknown", flow: "unknown" });

/** Loader default for a trace without (valid) vantage_point (qvis parity, QlogLoaderV2.ts:138-144). */
export const MISSING_VANTAGE_POINT_NAME = "No VantagePoint set";

export interface EventPointer {
    connectionIndex: number;
    eventIndex?: number;
    packetNumber?: number;
}

/** Placement of the TraceError a placeholder connection stands for. */
export interface TraceErrorInfo {
    error_description: string;
    uri?: string;
    vantage_point?: VantagePoint;
}

/** `common_fields.protocol_type` (qvis-internal converter values) or derived from namespaces / event_schemas. */
export type ProtocolHint = "QUIC_HTTP3" | "TCP_HTTP2" | "TCP" | "unknown" | (string & {});

export interface FrameSizeInfo {
    frame_size?: number;
    header_size: number;
    payload_size: number;
    [key: string]: unknown;
}

/** Sequence diagram scratch data per event (qvis `evt.qvis.sequencediagram` + `timeText`). */
export interface SequenceEventExt {
    y?: number;
    rightTarget?: QlogEvent;
    leftTarget?: QlogEvent;
    packetLost?: "rightTarget" | "leftTarget";
    focusInfo?: EventPointer;
    timeText?: string;
    [key: string]: unknown;
}

/** Congestion graph scratch data per event (qvis `evt.qvis.congestion`). */
export interface CongestionEventExt {
    from: number;
    to: number;
    correspondingPackets: QlogEvent[];
    correspondingAck?: QlogEvent;
    correspondingLoss?: QlogEvent;
    [key: string]: unknown;
}

/** Packetization scratch data per event (instead of mutating `data.frames`). */
export interface PacketizationEventExt {
    frameSizes?: FrameSizeInfo[];
    fillerHeaderSize?: number;
    [key: string]: unknown;
}

/**
 * Renderer annotations on events (`QlogEvent.ext`). Never serialized. Other packages may add typed slots through
 * declaration merging (`declare module "@/model/types" { interface EventExtensions { mySlot: ... } }`) or use the
 * open index signature.
 */
export interface EventExtensions {
    sequence: SequenceEventExt;
    congestion: CongestionEventExt;
    packetization: PacketizationEventExt;
    [slot: string]: unknown;
}

export interface SequenceConnectionExt {
    generatedSibling?: QlogConnection;
    manualTimeOffset?: number;
    [key: string]: unknown;
}

/** Renderer annotations on connections (`QlogConnection.ext`). */
export interface ConnectionExtensions {
    sequence: SequenceConnectionExt;
    [slot: string]: unknown;
}

/** File info the store passes to QlogLoader.fromJSON (qvis `addGroupFromQlogFile`). */
export interface QlogFileInfo {
    filename?: string;
    URL?: string;
    URLshort?: string;
}

/** Namespace + type pair returned by a clone transform. */
export interface EventNameParts {
    namespace: string;
    type: string;
}
