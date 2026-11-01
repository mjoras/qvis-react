// User-facing messages of the converters (converters spec sections 6.3 and 8.8). The converters never call
// notify() themselves (they are pure and worker-safe); the loading layer turns these into toasts.

import type { Diagnostic } from "./diagnostics";
import { isConverterDiagnostic } from "./diagnostics";

export interface ConverterNotification {
    title: string;
    text: string;
    type: "warn";
    duration: number;
}

/** Thrown (wrapped in the loader's ConversionError) when a netlog has no QUIC session with events. */
export const NO_QUIC_CONNECTIONS_TEXT = "No QUIC connections found in this Chrome netlog.";
/** Thrown when a tshark JSON has no TCP connection. */
export const NO_TCP_CONNECTIONS_TEXT =
    "No TCP connections found in this tshark JSON. QUIC captures need pcap2qlog (not available in this deployment).";

export const NETLOG_REPAIRED_CODE = "netlog.repaired-truncated";

/**
 * Toasts after a successful conversion: "Netlog was truncated" for a repaired netlog, and one "Converted with
 * warnings" for any other warning-level converter diagnostic. Info-level diagnostics are only on the debug page.
 */
export function converterNotifications(filename: string, diagnostics: readonly Diagnostic[]): ConverterNotification[] {
    const out: ConverterNotification[] = [];
    const converter = diagnostics.filter(isConverterDiagnostic);
    if (converter.some((d) => d.code === NETLOG_REPAIRED_CODE)) {
        out.push({
            title: "Netlog was truncated",
            text: "The netlog file was not closed properly; events up to the cut-off were loaded.",
            type: "warn",
            duration: 6000,
        });
    }
    if (converter.some((d) => d.level !== "info" && d.code !== NETLOG_REPAIRED_CODE)) {
        out.push({
            title: "Converted with warnings",
            text: filename + " was converted, but some input could not be interpreted. See the debug page for details.",
            type: "warn",
            duration: 6000,
        });
    }
    return out;
}
