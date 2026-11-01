// Post-load warning toasts for a successfully loaded file: X4 / X3 (file-loading §6.2, from the parse-level
// diagnostics) and DM1 / DM2 / DM3 (built by the core model, src/model/diagnostics.ts). At most one toast per kind
// per file; type "warn".

import type { Diagnostic } from "@/qlog/parse";
import { converterNotifications, isConverterDiagnostic } from "@/converters";
import { buildModelToasts, X3_CODE, X4_CODES } from "@/model/diagnostics";
import type { LoadNotification } from "./messages";
import { X3_recordsSkipped, X4_truncatedRepaired } from "./messages";

/**
 * Union of both lists, deduplicated by code. QlogLoader.fromJSON already merges the parse-level diagnostics into
 * group.diagnostics; this keeps working (without double counting) if it ever stops doing so.
 */
export function mergeDiagnostics(...lists: ReadonlyArray<readonly Diagnostic[] | undefined>): Diagnostic[] {
    const byCode = new Map<string, Diagnostic>();
    const out: Diagnostic[] = [];
    for (const list of lists) {
        for (const d of list ?? []) {
            const existing = byCode.get(d.code);
            if (existing === undefined) {
                const copy = { ...d };
                byCode.set(d.code, copy);
                out.push(copy);
            } else if (d.count > existing.count) {
                existing.count = d.count;
            }
        }
    }
    return out;
}

/** The model builders separate lines with "\n"; the Notifications host splits on the qvis `<br/>` marker. */
function toLines(text: string): string {
    return text.split("\n").join("<br/>");
}

/** Event count recorded by the contained-JSON repair (`sample.recoveredEvents`), if any. */
function recoveredEvents(d: Diagnostic): number | undefined {
    const sample = d.sample as { recoveredEvents?: unknown } | undefined;
    return sample !== null && typeof sample === "object" && typeof sample.recoveredEvents === "number"
        ? sample.recoveredEvents
        : undefined;
}

export function diagnosticNotifications(filename: string, diagnostics: readonly Diagnostic[]): LoadNotification[] {
    const out: LoadNotification[] = [];
    const repaired = diagnostics.find((d) => X4_CODES.includes(d.code));
    if (repaired !== undefined) out.push(X4_truncatedRepaired(filename, recoveredEvents(repaired)));
    const skipped = diagnostics.find((d) => d.code === X3_CODE);
    if (skipped !== undefined) out.push(X3_recordsSkipped(filename, skipped.count));
    // converters spec 8.8: netlog.* / tshark.* diagnostics get the converter toasts, not DM2
    out.push(...converterNotifications(filename, diagnostics));
    const modelDiagnostics = diagnostics.filter((d) => !isConverterDiagnostic(d));
    // data-model 6.3: DM1-DM3 are `warn` toasts with the default duration
    for (const t of buildModelToasts({ filename, diagnostics: modelDiagnostics }, filename)) {
        out.push({ title: t.title, text: toLines(t.text), type: t.type });
    }
    return out;
}
