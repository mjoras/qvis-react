// Client-side converters for non-qlog inputs (ARCHITECTURE section 0, converters spec): Chrome netlog -> quic:/http3:
// qlog, tshark JSON (TCP + TLS + HTTP/2) -> private tcp:/tls:/http2: qlog. Pure, synchronous, worker-safe (no DOM,
// no store, no notify): the loading layer passes the result to the normal latest-draft loader and turns the
// diagnostics into toasts (converterNotifications).

import type { Diagnostic } from "./common/diagnostics";
import { NO_QUIC_CONNECTIONS_TEXT, NO_TCP_CONNECTIONS_TEXT } from "./common/notifications";
import { convertNetlog } from "./netlog";
import type { NetlogConvertOptions } from "./netlog";
import { convertTshark } from "./tshark";
import type { TsharkConvertOptions } from "./tshark";

export { convertNetlog, netlogToQlog } from "./netlog";
export type { NetlogConvertOptions } from "./netlog";
export { convertTshark, tsharkToQlog } from "./tshark";
export type { TsharkConvertOptions } from "./tshark";
export type { ConverterResult } from "./common/diagnostics";
export { isConverterDiagnostic } from "./common/diagnostics";
export {
    converterNotifications,
    NETLOG_REPAIRED_CODE,
    NO_QUIC_CONNECTIONS_TEXT,
    NO_TCP_CONNECTIONS_TEXT,
} from "./common/notifications";
export type { ConverterNotification } from "./common/notifications";
export * from "./common/envelope";

export type ConverterKind = "netlog" | "tshark";

export interface ConvertedFile {
    /** latest-draft QlogFile root, ready for QlogLoader.fromJSON */
    root: Record<string, unknown>;
    /** converter diagnostics (codes `netlog.*` / `tshark.*`), to merge into the group's diagnostics */
    diagnostics: Diagnostic[];
}

/**
 * Entry point of the loading layer: `payload` is the file text (netlog: also a parsed object). Throws (the loader
 * wraps it in ConversionError) when the input is not convertible or yields no connection at all, because the loader
 * never adds empty groups; the message then explains why.
 */
export function convertForLoading(
    kind: ConverterKind,
    payload: unknown,
    filename: string,
    options: NetlogConvertOptions & TsharkConvertOptions = {},
): ConvertedFile {
    const opts = { ...options, filename };
    const result = kind === "netlog" ? convertNetlog(payload, opts) : convertTshark(payload, opts);
    if (result.qlog.traces.length === 0) {
        throw new Error(kind === "netlog" ? NO_QUIC_CONNECTIONS_TEXT : NO_TCP_CONNECTIONS_TEXT);
    }
    return { root: result.qlog as unknown as Record<string, unknown>, diagnostics: result.diagnostics };
}
