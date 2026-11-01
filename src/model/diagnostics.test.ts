import type { Diagnostic } from "@/qlog/parse/diagnostics";
import { DiagnosticCollector } from "@/qlog/parse/diagnostics";
import { buildDM1Toast, buildDM2Toast, buildDM3Toast, buildModelToasts, dm2Lines } from "./diagnostics";

function d(code: string, level: Diagnostic["level"], message: string, count = 1, samples?: unknown[]): Diagnostic {
    const out: Diagnostic = { code, level, message, count };
    if (samples) {
        out.samples = samples;
        out.sample = samples[0];
    }
    return out;
}

describe("toast builders (data-model 6.3, ARCHITECTURE 3.1)", () => {
    it("DM1 verbatim", () => {
        expect(buildDM1Toast()).toEqual({
            title: "Trace events were not ordered by time",
            text: "Loaded trace was not ordered on event timestamps. qvis sorted the events by timestamp (stable sort: events with equal timestamps keep their logged order). See the console for more details.",
        });
    });

    it("DM2: up to 5 warning messages with counts, '...and n more.', excluded codes and info ignored", () => {
        const diags = [
            d("trace.reordered", "warning", "reordered"),
            d("event.nonconforming-name", "warning", "nonconforming", 9),
            d("seq.invalid-record", "warning", "x3"),
            d("json.truncated-recovered", "warning", "x4"),
            d("seq.truncated-final-record", "warning", "silent"),
            d("schema.unused", "info", "info only"),
            d("w1", "warning", "first", 3),
            d("w2", "warning", "second"),
            d("w3", "warning", "third", 2),
            d("w4", "warning", "fourth"),
            d("w5", "warning", "fifth"),
            d("w6", "warning", "sixth"),
            d("w7", "warning", "seventh"),
        ];
        expect(dm2Lines(diags)).toEqual({ lines: ["first (3x)", "second", "third (2x)", "fourth", "fifth"], more: 2 });
        expect(buildDM2Toast("a.qlog", diags)).toEqual({
            title: "Non-compliant qlog file a.qlog",
            text: [
                "This file does not fully follow the qlog drafts:",
                "first (3x)",
                "second",
                "third (2x)",
                "fourth",
                "fifth",
                "...and 2 more.",
                "qvis has attempted to auto-fix these things, so things should mostly still work.",
            ].join("\n"),
        });
        expect(buildDM2Toast("b", [d("w", "warning", "only one")])!.text).toBe(
            "This file does not fully follow the qlog drafts:\nonly one\nqvis has attempted to auto-fix these things, so things should mostly still work.",
        );
        expect(buildDM2Toast("a", [d("trace.reordered", "warning", "x"), d("i", "info", "y")])).toBeUndefined();
    });

    it("DM3 verbatim with count and samples", () => {
        const c = new DiagnosticCollector();
        c.warn("event.nonconforming-name", "m", { count: 40, sample: "transport:packet_sent" });
        c.add("warning", "event.nonconforming-name", "", { count: 2, sample: "recovery:metrics_updated" });
        expect(buildDM3Toast("client.sqlog", c.toArray())).toEqual({
            title: "Unsupported qlog event names in client.sqlog",
            text: "This file contains 42 events whose names are not defined by the latest qlog drafts (e.g. transport:packet_sent, recovery:metrics_updated). qvis only supports draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13 event names; the visualizations do not interpret these events.",
        });
        expect(buildDM3Toast("x", [])).toBeUndefined();
    });

    it("buildModelToasts: DM1, DM2, DM3 order, warn type", () => {
        const group = {
            filename: "f.qlog",
            diagnostics: [
                d("event.nonconforming-name", "warning", "n", 1, ["transport:x"]),
                d("trace.reordered", "warning", "r"),
                d("event.missing-data", "warning", "Some events have no data member", 2),
            ],
        };
        const toasts = buildModelToasts(group);
        expect(toasts.map((t) => [t.id, t.type])).toEqual([
            ["DM1", "warn"],
            ["DM2", "warn"],
            ["DM3", "warn"],
        ]);
        expect(toasts[1].text).toContain("Some events have no data member (2x)");
        expect(toasts[2].title).toBe("Unsupported qlog event names in f.qlog");
        expect(buildModelToasts({ filename: "x", diagnostics: [] })).toEqual([]);
    });
});

describe("DiagnosticCollector", () => {
    it("dedupes by code, counts, keeps up to 5 distinct samples, escalates level", () => {
        const c = new DiagnosticCollector();
        c.info("a", "first message", { traceIndex: 2, sample: "s1" });
        for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"]) c.warn("a", "other message", { sample: s });
        const [a] = c.toArray();
        expect(a).toMatchObject({
            code: "a",
            level: "warning",
            message: "first message",
            count: 7,
            traceIndex: 2,
            sample: "s1",
        });
        expect(a.samples).toEqual(["s1", "s2", "s3", "s4", "s5"]);
        const other = new DiagnosticCollector();
        other.error("b", "B");
        other.warn("a", "A", { count: 3, sample: "s9" });
        c.merge(other.toArray());
        expect(c.toArray().map((x) => [x.code, x.count, x.level])).toEqual([
            ["a", 10, "warning"],
            ["b", 1, "error"],
        ]);
    });
});
