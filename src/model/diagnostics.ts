// Data-model notifications (data-model spec section 6.3, ARCHITECTURE section 3.1): pure builders returning the
// verbatim {title, text} of toasts DM1, DM2 and DM3. The store decides when to show them (type "warn", at most one
// per kind per file, after a successful QlogLoader.fromJSON).

import type { Diagnostic } from "@/qlog/parse/diagnostics";

export { DiagnosticCollector, formatDiagnostic, MAX_SAMPLES } from "@/qlog/parse/diagnostics";
export type { Diagnostic, DiagnosticLevel, DiagnosticOptions } from "@/qlog/parse/diagnostics";

/** DM1 condition: some slice was re-sorted. */
export const DM1_CODE = "trace.reordered";
/** DM3 condition: events with names not defined by the latest drafts. */
export const DM3_CODE = "event.nonconforming-name";
/** Parse diagnostics behind the loading package's toasts X3 (records skipped) and X4 (truncation repaired). */
export const X3_CODE = "seq.invalid-record";
export const X4_CODES: readonly string[] = ["json.truncated-recovered", "json.syntax-error-recovered"];

/**
 * Warning codes that DM2 does not list because another toast covers them (DM1, DM3, X3, X4), or because the spec
 * wants them silent (console only): a truncated final JSON-SEQ record is the expected case (file-loading 9.3), and
 * data after a complete root object was loaded by qvis too, "so log a console warning and show no toast" (9.5).
 */
export const DM2_EXCLUDED_CODES: ReadonlySet<string> = new Set([
    DM1_CODE,
    DM3_CODE,
    X3_CODE,
    ...X4_CODES,
    "seq.truncated-final-record",
    "json.trailing-data",
]);

export const DM2_MAX_LINES = 5;

export interface ToastText {
    title: string;
    text: string;
}

export type ModelToastId = "DM1" | "DM2" | "DM3";

export interface ModelToast extends ToastText {
    id: ModelToastId;
    type: "warn";
}

/** DM1: `Trace events were not ordered by time`. */
export function buildDM1Toast(): ToastText {
    return {
        title: "Trace events were not ordered by time",
        text: "Loaded trace was not ordered on event timestamps. qvis sorted the events by timestamp (stable sort: events with equal timestamps keep their logged order). See the console for more details.",
    };
}

/** Warning-level diagnostics that DM2 lists (first-occurrence order). */
export function dm2Diagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    return diagnostics.filter((d) => d.level === "warning" && !DM2_EXCLUDED_CODES.has(d.code));
}

/** DM2 message lines: up to 5 messages, ` (<count>x)` appended when count > 1, plus how many were left out. */
export function dm2Lines(diagnostics: readonly Diagnostic[]): { lines: string[]; more: number } {
    const listed = dm2Diagnostics(diagnostics);
    const lines = listed.slice(0, DM2_MAX_LINES).map((d) => d.message + (d.count > 1 ? " (" + d.count + "x)" : ""));
    return { lines, more: Math.max(0, listed.length - DM2_MAX_LINES) };
}

/** DM2: `Non-compliant qlog file <filename>`; undefined when there is nothing to report. Lines joined with "\n". */
export function buildDM2Toast(filename: string, diagnostics: readonly Diagnostic[]): ToastText | undefined {
    const { lines, more } = dm2Lines(diagnostics);
    if (lines.length === 0) return undefined;
    const parts = ["This file does not fully follow the qlog drafts:", ...lines];
    if (more > 0) parts.push("...and " + more + " more.");
    parts.push("qvis has attempted to auto-fix these things, so things should mostly still work.");
    return { title: "Non-compliant qlog file " + filename, text: parts.join("\n") };
}

/** The `event.nonconforming-name` diagnostic: count and up to 5 sample names. */
export function nonconformingNames(
    diagnostics: readonly Diagnostic[],
): { count: number; samples: string[] } | undefined {
    const d = diagnostics.find((x) => x.code === DM3_CODE);
    if (d === undefined || d.count === 0) return undefined;
    const samples = (d.samples ?? (d.sample !== undefined ? [d.sample] : [])).map((s) => String(s));
    return { count: d.count, samples };
}

/** DM3: `Unsupported qlog event names in <filename>`; undefined when all names conform. */
export function buildDM3Toast(filename: string, diagnostics: readonly Diagnostic[]): ToastText | undefined {
    const info = nonconformingNames(diagnostics);
    if (info === undefined) return undefined;
    return {
        title: "Unsupported qlog event names in " + filename,
        text:
            "This file contains " +
            info.count +
            " events whose names are not defined by the latest qlog drafts (e.g. " +
            info.samples.join(", ") +
            "). qvis only supports draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13 event names; the visualizations do not interpret these events.",
    };
}

/** All data-model toasts for a loaded file, in DM1, DM2, DM3 order. */
export function buildModelToasts(
    group: { filename: string; diagnostics: readonly Diagnostic[] },
    filename: string = group.filename,
): ModelToast[] {
    const out: ModelToast[] = [];
    const d = group.diagnostics;
    if (d.some((x) => x.code === DM1_CODE)) out.push({ id: "DM1", type: "warn", ...buildDM1Toast() });
    const dm2 = buildDM2Toast(filename, d);
    if (dm2) out.push({ id: "DM2", type: "warn", ...dm2 });
    const dm3 = buildDM3Toast(filename, d);
    if (dm3) out.push({ id: "DM3", type: "warn", ...dm3 });
    return out;
}
