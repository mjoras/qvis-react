/// <reference types="node" />
// Test helpers: build model connections from hand-written latest-draft events or from real fixture files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { parseQlogText } from "@/qlog/parse";

export type Json = Record<string, any>;

export const QUIC_13 = "urn:ietf:params:qlog:events:quic-13";
export const HTTP3_13 = "urn:ietf:params:qlog:events:http3-13";

export const ROOT = join(__dirname, "../../../..");

/** A group from a complete qlog root object (contained serialization). */
export function groupFromRoot(root: Json, filename = "test.qlog"): QlogConnectionGroup {
    const group = QlogLoader.fromJSON({ root, serialization: "json", diagnostics: [] }, { filename });
    if (!group) throw new Error("could not load " + filename);
    return group;
}

/** One connection holding `events` (client vantage point unless overridden). */
export function connectionFromEvents(events: Json[], traceExtra: Json = {}): QlogConnection {
    const root = {
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        traces: [{ event_schemas: [QUIC_13, HTTP3_13], vantage_point: { type: "client" }, ...traceExtra, events }],
    };
    return groupFromRoot(root).getConnections()[0];
}

let t = 0;
/** Event with a monotonically increasing time. */
export function ev(name: string, data: Json): Json {
    t += 1;
    return { time: t, name, data };
}

export function loadFile(path: string): QlogConnectionGroup {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const group = QlogLoader.fromJSON(parseQlogText(readFileSync(path, "utf8")), { filename: name });
    if (!group) throw new Error("could not load " + path);
    return group;
}

/** Every .qlog / .sqlog directly inside the given repo-relative directories that exist. */
export function filesIn(...dirs: string[]): string[] {
    return dirs
        .map((d) => join(ROOT, d))
        .filter((d) => existsSync(d))
        .flatMap((d) =>
            readdirSync(d)
                .filter((f) => /\.s?qlog$/.test(f))
                .map((f) => join(d, f)),
        );
}
