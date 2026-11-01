// Hand-written latest-draft qlog builders for the sequence diagram unit tests, plus loaders for the real generated
// fixtures in tests/fixtures/latest (sequence-*.sqlog / .qlog).

import { file, loaded, type Json } from "@/model/__fixtures__/qlog";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";

export type { Json };

export const UNKNOWN_EPOCH = { clock_type: "monotonic", epoch: "unknown" };

export function pkt(
    time: number,
    dir: "sent" | "received",
    packet_type: string,
    packet_number?: number | string,
    frames?: Json[],
    extra: Json = {},
): Json {
    const header: Json = { packet_type };
    if (packet_number !== undefined) header.packet_number = packet_number;
    const data: Json = { header, ...extra };
    if (frames !== undefined) data.frames = frames;
    return { time, name: "quic:packet_" + dir, data };
}

export function evt(time: number, name: string, data: Json = {}): Json {
    return { time, name, data };
}

export function seqTrace(events: Json[], vantage_point: Json | undefined, extra: Json = {}): Json {
    const t: Json = { event_schemas: ["urn:ietf:params:qlog:events:quic-13"], ...extra, events };
    if (vantage_point !== undefined) t.vantage_point = vantage_point;
    return t;
}

/** Loads a contained file with the given traces into a QlogConnectionGroup (not added to any store). */
export function loadGroup(traces: Json[], filename = "test.qlog", URL?: string): QlogConnectionGroup {
    const g = QlogLoader.fromJSON(loaded(file(traces)), { filename, URL });
    if (!g) throw new Error("could not load test group");
    g.filename = filename;
    g.URL = URL ?? "";
    g.URLshort = URL ?? "";
    return g;
}
