// Output envelope shared by both converters (converters spec sections 8.3, 9.1 rules 1 and 8, 9.2).
//
// The converters emit a latest-draft contained qlog file (main-schema-14 QlogFile) with object events
// `{time, name, data}`. No file-level title/description (the file list shows the shorthand only, section 2.4).

import { EVENT_SCHEMA_DRAFT, EVENT_SCHEMA_URI } from "@/model/names";

export const FILE_SCHEMA_CONTAINED = "urn:ietf:params:qlog:file:contained";
export const SERIALIZATION_JSON = "application/qlog+json";

/**
 * Private schema base (decision C1): not under urn:ietf:params:qlog:, with an owner-controlled domain and an mmyyyy
 * date (main-schema-14 section 8.1). Change it here only.
 */
export const QVIS_SCHEMA_BASE = "https://github.com/mjoras/qvis-react/112026";

/** Private namespaces of the tshark converter (section 8.6.1). */
export const TCP_SCHEMA_URI = `${QVIS_SCHEMA_BASE}/tcp`;
export const TLS_SCHEMA_URI = `${QVIS_SCHEMA_BASE}/tls`;
export const HTTP2_SCHEMA_URI = `${QVIS_SCHEMA_BASE}/http2`;

/** Private extension schemas declaring the `chromium_*` event-data fields of the netlog converter (C11). */
export const QUIC_CHROMIUM_EXTENSION_URI = `${QVIS_SCHEMA_BASE}/quic#chromium`;
export const HTTP3_CHROMIUM_EXTENSION_URI = `${QVIS_SCHEMA_BASE}/http3#chromium`;

/** Draft-suffixed standard schema URIs (quic-13 section 2.1, h3-13 section 2.1; main-schema has no suffix rule). */
export const QUIC_SCHEMA_URI = `${EVENT_SCHEMA_URI.quic}-${EVENT_SCHEMA_DRAFT.quic}`;
export const HTTP3_SCHEMA_URI = `${EVENT_SCHEMA_URI.http3}-${EVENT_SCHEMA_DRAFT.http3}`;
export const LOGLEVEL_SCHEMA_URI = EVENT_SCHEMA_URI.loglevel;

export type QlogData = Record<string, unknown>;

export interface QlogOutputEvent {
    time: number;
    name: string;
    data: QlogData;
}

export interface QlogOutputTrace {
    title: string;
    vantage_point: { type: "client" };
    common_fields: {
        protocol_type: "QUIC_HTTP3" | "TCP_HTTP2";
        time_format: "relative_to_epoch";
        reference_time: { clock_type: "system" | "monotonic"; epoch: string };
    };
    event_schemas: string[];
    events: QlogOutputEvent[];
}

export interface QlogOutputFile {
    file_schema: typeof FILE_SCHEMA_CONTAINED;
    serialization_format: typeof SERIALIZATION_JSON;
    traces: QlogOutputTrace[];
}

export function makeQlogFile(traces: QlogOutputTrace[]): QlogOutputFile {
    return { file_schema: FILE_SCHEMA_CONTAINED, serialization_format: SERIALIZATION_JSON, traces };
}
