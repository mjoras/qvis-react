// TLS record extraction from a tshark `tls` layer (port of qvis tcptoqlog.ts:230-307, converters spec 3.9.3).
//
// tshark is very inconsistent in how it groups TLS records: the layer can be a dict, an array (often with an empty
// second element), or just the string "Transport Layer Security" (segments carrying continuation bytes only), and
// `tls.record` can be one record or an array of them.

import type { DiagnosticCollector } from "../common/diagnostics";

export type TsharkObject = Record<string, unknown>;

function isObject(v: unknown): v is TsharkObject {
    return typeof v === "object" && v !== null;
}

/** The record fields qvis expected (tcptoqlog.ts:506); anything else is reported once per field name. */
export const EXPECTED_RECORD_FIELDS: ReadonlySet<string> = new Set([
    "tls.record.content_type",
    "tls.record.opaque_type",
    "tls.record.length",
    "tls.record.version",
    "tls.app_data",
    "tls.handshake",
    "tls.change_cipher_spec",
    "tls.handshake.fragments",
    "tls.alert_message",
    "tls.reassembled_in",
    "tls.handshake.reassembled_in",
]);

/** Collects the TLS records of one packet's `tls` layer (which must not be a string), in order. */
export function collectTlsRecords(tls: unknown, diag: DiagnosticCollector): TsharkObject[] {
    const records: TsharkObject[] = [];
    const extract = (obj: unknown): void => {
        // Q5 (T2): strings inside arrays made qvis recurse forever (for..of over a string yields strings)
        if (!isObject(obj)) return;
        if (Object.keys(obj).length === 0) {
            // typically several TLS record segments in one TCP packet, where the latter cannot be decoded yet
            diag.info("tshark.empty-tls-entry", "Some tshark TLS layers contain empty entries; they were ignored");
            return;
        }
        const record = obj["tls.record"];
        if (record) {
            if (Array.isArray(record)) for (const el of record) extract(el);
            else if (isObject(record)) records.push(record);
        } else if (obj["tls.record.length"]) {
            records.push(obj);
        } else if (Array.isArray(obj)) {
            for (const el of obj) extract(el);
        } else {
            diag.info(
                "tshark.tls-not-iterable",
                "Some tshark TLS entries are neither records nor lists (typically a TLS Unknown Record); they were skipped",
            );
        }
    };

    if (Array.isArray(tls) && tls.length === 2) {
        // sometimes there are two TLS entries but the second one is empty
        const second: unknown = tls[1];
        if (isObject(second) && Object.keys(second).length === 0) extract(tls[0]);
        else extract(tls);
    } else {
        if (Array.isArray(tls) && tls.length > 2) {
            diag.info("tshark.many-tls-entries", "Some tshark packets have more than two TLS layer entries");
        }
        extract(tls);
    }
    return records;
}
