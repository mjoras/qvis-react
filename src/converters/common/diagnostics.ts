// Converter diagnostics (converters spec section 8.8): qvis's console messages and alert()s become aggregated,
// non-modal diagnostics. They use the parser's Diagnostic type, so the loading layer can merge them into the
// group's diagnostics (debug page) and show the converter toasts.

import { DiagnosticCollector } from "@/qlog/parse/diagnostics";
import type { Diagnostic } from "@/qlog/parse/diagnostics";
import type { QlogOutputFile } from "./envelope";

export { DiagnosticCollector };
export type { Diagnostic };

/** What both converters return (section 8.1). */
export interface ConverterResult {
    qlog: QlogOutputFile;
    diagnostics: Diagnostic[];
    /** counters for tests and the debug page (e.g. sessions, events per name) */
    stats: Record<string, number>;
}

export const NETLOG_DIAGNOSTIC_PREFIX = "netlog.";
export const TSHARK_DIAGNOSTIC_PREFIX = "tshark.";

/** True for diagnostics produced by one of the converters (they get their own toasts, not DM2). */
export function isConverterDiagnostic(d: Pick<Diagnostic, "code">): boolean {
    return d.code.startsWith(NETLOG_DIAGNOSTIC_PREFIX) || d.code.startsWith(TSHARK_DIAGNOSTIC_PREFIX);
}

/**
 * Counts `"<scope>.<field>"` occurrences of input values the CDDL requires but the input lacks (section 9.1 rule 6):
 * the member is omitted, never invented.
 */
export function missingField(diag: DiagnosticCollector, converter: "netlog" | "tshark", where: string): void {
    diag.info(
        converter + ".missing-field",
        converter === "netlog"
            ? "Some netlog events lack a field the qlog event needs; the field was omitted"
            : "Some tshark packets lack a field the qlog event needs; the field was omitted",
        { sample: where },
    );
}
