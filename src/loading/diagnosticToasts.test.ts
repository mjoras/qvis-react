import type { Diagnostic } from "@/qlog/parse";
import { diagnosticNotifications, mergeDiagnostics } from "./diagnosticToasts";

const d = (
    code: string,
    count = 1,
    level: Diagnostic["level"] = "warning",
    extra: Partial<Diagnostic> = {},
): Diagnostic => ({
    level,
    code,
    message: "message for " + code,
    count,
    ...extra,
});

describe("diagnosticNotifications", () => {
    it("nothing for a clean file or info-only diagnostics", () => {
        expect(diagnosticNotifications("f.qlog", [])).toEqual([]);
        expect(diagnosticNotifications("f.qlog", [d("trace.no-events", 1, "info")])).toEqual([]);
    });

    it("X4 for a repaired truncated file, X3 with the skipped-record count", () => {
        const out = diagnosticNotifications("f.sqlog", [d("json.truncated-recovered"), d("seq.invalid-record", 3)]);
        expect(out).toEqual([
            {
                title: "Incomplete qlog file f.sqlog",
                type: "warn",
                duration: 6000,
                text: "The file was not properly closed (e.g., the logger was stopped early). It was loaded up to the last complete event.",
            },
            {
                title: "Some records were skipped in f.sqlog",
                type: "warn",
                duration: 6000,
                text: "3 record(s) contained invalid JSON and were ignored. See the devtools console for details.",
            },
        ]);
    });

    it("X4 carries the recovered event count when the repair recorded it (file-loading 9.5 step 5)", () => {
        const out = diagnosticNotifications("f.qlog", [
            d("json.truncated-recovered", 1, "warning", {
                sample: { recoveredEvents: 1234, droppedIncompleteEvents: 1 },
            }),
        ]);
        expect(out[0].text).toBe(
            "The file was not properly closed (e.g., the logger was stopped early). It was loaded up to the last complete event (1234 events).",
        );
    });

    it("a truncated final JSON-SEQ record is silent", () => {
        expect(diagnosticNotifications("f.sqlog", [d("seq.truncated-final-record")])).toEqual([]);
    });

    it("data after a complete root is console-only, no toast (file-loading 9.5)", () => {
        expect(diagnosticNotifications("f.qlog", [d("json.trailing-data")])).toEqual([]);
    });

    it("DM1, DM2 (with <br/> lines) and DM3 from the model builders", () => {
        const out = diagnosticNotifications("f.qlog", [
            d("trace.reordered"),
            d("event.missing-time", 4),
            d("event.nonconforming-name", 12, "warning", {
                samples: ["transport:packet_sent", "recovery:metrics_updated"],
            }),
        ]);
        expect(out.map((n) => n.title)).toEqual([
            "Trace events were not ordered by time",
            "Non-compliant qlog file f.qlog",
            "Unsupported qlog event names in f.qlog",
        ]);
        expect(out.every((n) => n.type === "warn")).toBe(true);
        expect(out.every((n) => n.duration === undefined)).toBe(true); // data-model 6.3: default duration
        expect(out[1].text).toBe(
            "This file does not fully follow the qlog drafts:<br/>message for event.missing-time (4x)<br/>qvis has attempted to auto-fix these things, so things should mostly still work.",
        );
        expect(out[2].text).toBe(
            "This file contains 12 events whose names are not defined by the latest qlog drafts (e.g. transport:packet_sent, recovery:metrics_updated). qvis only supports draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13 event names; the visualizations do not interpret these events.",
        );
    });
});

describe("mergeDiagnostics", () => {
    it("dedupes by code without double counting", () => {
        const merged = mergeDiagnostics([d("a", 2), d("b")], [d("a", 2), d("c")]);
        expect(merged.map((x) => [x.code, x.count])).toEqual([
            ["a", 2],
            ["b", 1],
            ["c", 1],
        ]);
    });
});
