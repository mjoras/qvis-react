// @vitest-environment node
/// <reference types="node" />
// Real files: the non-conforming quic-go output (DM3 test, replaces data-model 8.6 #10), the hand-written valid sample,
// and every strictly conforming generated file (tests/fixtures/latest, public/examples) when present.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQlogText } from "@/qlog/parse";
import { buildDM3Toast, buildModelToasts } from "./diagnostics";
import { QlogLoader } from "./QlogLoader";
import { TimeTrackingMethod } from "./time";

const ROOT = join(__dirname, "../..");

function filesIn(...dirs: string[]): string[] {
    return dirs
        .map((d) => join(ROOT, d))
        .filter((d) => existsSync(d))
        .flatMap((d) =>
            readdirSync(d)
                .filter((f) => /\.s?qlog$/.test(f))
                .map((f) => join(d, f)),
        );
}

function loadFile(path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const group = QlogLoader.fromJSON(parseQlogText(readFileSync(path, "utf8")), { filename: name });
    if (!group) throw new Error("could not load " + path);
    return group;
}

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const nonconforming = filesIn("tests/fixtures/quic-go", "tests/fixtures/nonconforming");

describe("non-conforming quic-go output (DM3)", () => {
    it("fixtures are present", () => {
        expect(nonconforming.length).toBeGreaterThan(0);
    });

    it.each(nonconforming)("%s: loads, names kept as logged, event.nonconforming-name -> DM3", (path) => {
        const g = loadFile(path);
        expect(g.serialization).toBe("json-seq");
        expect(g.fileSchema).toBe("urn:ietf:params:qlog:file:sequential");
        const conns = g.getConnections();
        expect(conns).toHaveLength(1); // group_id only in common_fields: no split
        const c = conns[0];
        expect(c.groupId).toBeUndefined();
        expect(c.getEvents().length).toBeGreaterThan(100);
        // monotonic clock, epoch "unknown": case U
        expect(c.timing.getTimeTrackingMethod()).toBe(TimeTrackingMethod.RELATIVE_TIME);
        expect(c.timing.getAbsoluteStartTime()).toBe(0);
        expect(c.getEvents()[0].relativeTime).toBe(0);
        // no aliasing: pre-final names stay under their own namespace
        expect(c.lookup("transport", "packet_sent").length).toBeGreaterThan(0);
        expect(c.lookup("quic", "packet_sent")).toHaveLength(0);
        for (const ev of c.getEvents()) {
            expect(ev.fullName).toBe(ev.loggedName);
            expect(ev.data).toBe(ev.raw.data);
        }

        const d = g.diagnostics.find((x) => x.code === "event.nonconforming-name")!;
        expect(d.level).toBe("warning");
        const expectedCount = c
            .getEvents()
            .filter(
                (e) =>
                    ["transport", "recovery", "security", "connectivity"].includes(e.namespace) ||
                    e.fullName === "http:frame_created",
            ).length;
        expect(d.count).toBeGreaterThanOrEqual(expectedCount);
        expect(d.samples!.length).toBeGreaterThan(0);
        expect(d.samples!.length).toBeLessThanOrEqual(5);
        expect(d.samples!.some((x) => String(x).startsWith("transport:") || String(x).startsWith("recovery:"))).toBe(
            true,
        );

        const dm3 = buildDM3Toast(g.filename, g.diagnostics)!;
        expect(dm3.title).toBe("Unsupported qlog event names in " + g.filename);
        expect(dm3.text).toBe(
            "This file contains " +
                d.count +
                " events whose names are not defined by the latest qlog drafts (e.g. " +
                d.samples!.join(", ") +
                "). qvis only supports draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13 event names; the visualizations do not interpret these events.",
        );
        expect(buildModelToasts(g).map((t) => t.id)).toContain("DM3");
        // file_schema + legacy qlog_version members: info only; quic-12 schema: draft mismatch info
        expect(g.diagnostics.find((x) => x.code === "file.legacy-members")?.level).toBe("info");
        expect(g.diagnostics.find((x) => x.code === "schema.draft-mismatch")?.level).toBe("info");
    });
});

describe("strictly conforming files", () => {
    it("scripts/cddl/sample-valid.sqlog: no warnings, no DM toasts", () => {
        const g = loadFile(join(ROOT, "scripts/cddl/sample-valid.sqlog"));
        expect(g.diagnostics.filter((d) => d.level !== "info")).toEqual([]);
        expect(buildModelToasts(g)).toEqual([]);
        const c = g.getConnections()[0];
        expect(c.getLongName()).toBe("sample client : client : client connection");
        expect(c.protocolHint).toBe("QUIC_HTTP3");
        expect(c.lookup("quic", "packet_sent").length).toBeGreaterThan(0);
    });

    const latest = filesIn("tests/fixtures/latest", "public/examples");
    it.runIf(latest.length > 0).each(latest)("%s: loads without non-conforming names or reordering", (path) => {
        const g = loadFile(path);
        expect(g.getConnections().length).toBeGreaterThan(0);
        const codes = g.diagnostics.filter((d) => d.level !== "info").map((d) => d.code);
        expect(codes).not.toContain("event.nonconforming-name");
        expect(g.diagnostics.filter((d) => d.level === "error")).toEqual([]);
        for (const c of g.getConnections()) {
            const evs = c.getEvents();
            for (let i = 1; i < evs.length; i++)
                expect(evs[i].relativeTime).toBeGreaterThanOrEqual(evs[i - 1].relativeTime);
        }
    });
});
