// Test helpers: build small latest-draft JSON-SEQ traces in memory and load them through the real parser and loader,
// or load the real fixtures in tests/fixtures/latest/multiplexing-*.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { parseQlogText } from "@/qlog/parse";

export const ROOT = join(__dirname, "../../../..");
export const FIXTURES = join(ROOT, "tests/fixtures/latest");

export type RawEvent = { time: number; name: string; data: Record<string, unknown> };
/** null = no vantage_point member at all */
export type VP = { type: string; flow?: string; name?: string } | null;

/** JSON-SEQ text of one trace. The first event is always at time 0 (relativeTime = logged time). */
export function traceText(events: RawEvent[], vantagePoint: VP = { type: "client" }, title = "t"): string {
    const trace: Record<string, unknown> = {
        title,
        common_fields: {
            time_format: "relative_to_epoch",
            reference_time: { clock_type: "monotonic", epoch: "unknown" },
        },
        event_schemas: ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"],
    };
    if (vantagePoint !== null) trace.vantage_point = vantagePoint;
    const header = {
        file_schema: "urn:ietf:params:qlog:file:sequential",
        serialization_format: "application/qlog+json-seq",
        trace,
    };
    const all: RawEvent[] = [{ time: 0, name: "quic:connection_started", data: {} }, ...events];
    return [header, ...all].map((o) => "\x1e" + JSON.stringify(o) + "\n").join("");
}

export function loadText(text: string, filename = "test.sqlog"): QlogConnectionGroup {
    const g = QlogLoader.fromJSON(parseQlogText(text), { filename });
    if (!g) throw new Error("could not load " + filename);
    return g;
}

export function trace(
    events: RawEvent[],
    vantagePoint: VP = { type: "client" },
    filename = "test.sqlog",
): QlogConnection {
    return loadText(traceText(events, vantagePoint), filename).getConnections()[0];
}

export function loadFixture(name: string): QlogConnectionGroup {
    return loadText(readFileSync(join(FIXTURES, name), "utf8"), name);
}

// ---- event builders

export function streamFrame(
    stream_id: unknown,
    offset: unknown,
    length: number | undefined,
    extra: Record<string, unknown> = {},
) {
    const f: Record<string, unknown> = { frame_type: "stream", stream_id };
    if (offset !== undefined) f.offset = offset;
    if (length !== undefined) f.raw = { length };
    return { ...f, ...extra };
}

/** packet_number null = not logged */
export function packet(name: string, time: number, frames: unknown[], packet_number: unknown = 1): RawEvent {
    const header: Record<string, unknown> = { packet_type: "1RTT" };
    if (packet_number !== null) header.packet_number = packet_number;
    return { time, name, data: { header, frames } };
}

export const received = (time: number, frames: unknown[], pn?: unknown) =>
    packet("quic:packet_received", time, frames, pn);
export const sent = (time: number, frames: unknown[], pn?: unknown) => packet("quic:packet_sent", time, frames, pn);

export function headers(name: string, time: number, stream_id: unknown, fields: unknown[] = []): RawEvent {
    return { time, name, data: { stream_id, frame: { frame_type: "headers", headers: fields } } };
}

export function priorityUpdate(name: string, time: number, frame: Record<string, unknown>): RawEvent {
    return { time, name, data: { stream_id: 2, frame: { frame_type: "priority_update", ...frame } } };
}

export function moved(time: number, data: Record<string, unknown>): RawEvent {
    return { time, name: "quic:stream_data_moved", data };
}
