// Tiny hand-written latest-draft qlog builders for model unit tests.
import type { LoadedQlog } from "@/qlog/parse";

export const CONTAINED = "urn:ietf:params:qlog:file:contained";
export const SEQUENTIAL = "urn:ietf:params:qlog:file:sequential";
export const QUIC_13 = "urn:ietf:params:qlog:events:quic-13";
export const HTTP3_13 = "urn:ietf:params:qlog:events:http3-13";

export type Json = Record<string, any>;

export function ev(time: unknown, name: unknown, data: unknown = {}, extra: Json = {}): Json {
    const e: Json = {};
    if (time !== undefined) e.time = time;
    if (name !== undefined) e.name = name;
    if (data !== undefined) e.data = data;
    return { ...e, ...extra };
}

export function trace(events: unknown[], extra: Json = {}): Json {
    return { event_schemas: [QUIC_13], vantage_point: { type: "client" }, ...extra, events };
}

export function file(traces: unknown[], extra: Json = {}): Json {
    return { file_schema: CONTAINED, serialization_format: "application/qlog+json", ...extra, traces };
}

export function loaded(root: Json, serialization: "json" | "json-seq" = "json"): LoadedQlog {
    return { root, serialization, diagnostics: [] };
}

export const DATED_EPOCH = "2024-10-10T10:10:10.000Z";
export const DATED_EPOCH_MS = Date.UTC(2024, 9, 10, 10, 10, 10);

export function refTime(epoch: string, clock_type = "system", wall_clock_time?: string): Json {
    const r: Json = { clock_type, epoch };
    if (wall_clock_time !== undefined) r.wall_clock_time = wall_clock_time;
    return r;
}
