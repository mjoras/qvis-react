// HTTP/3 helpers of the netlog converter: header lists (converters spec section 8.5.3) and SETTINGS mapping
// (section 8.5.4).

import { u64 } from "../common/num";
import { setOwn } from "../common/own";

export interface HTTPField {
    name: string;
    value?: string;
}

/**
 * Current Chrome logs headers as a list of `"name: value"` strings (ElideQuicHeaderListForNetLog); 2020 Chrome logged
 * an object `{":method": "GET", ...}`. qvis used Object.entries() on both, which turned the list form into
 * `{name: "0", value: ":method: GET"}` (Q12, FIX T2). Elided values ("[N bytes were stripped]") are kept as values.
 */
export function parseHeaders(h: unknown): HTTPField[] {
    if (Array.isArray(h)) {
        return h.map((s) => {
            const str = typeof s === "string" ? s : String(s);
            const k = str.indexOf(": ", 1); // from 1: pseudo-headers start with ':'
            return k < 0 ? { name: str } : { name: str.slice(0, k), value: str.slice(k + 2) };
        });
    }
    if (h !== null && typeof h === "object") {
        // 2020 format (PARITY)
        return Object.entries(h as Record<string, unknown>).map(([name, value]) => ({
            name,
            value: typeof value === "string" ? value : String(value),
        }));
    }
    return [];
}

/** quiche H3SettingsToString names of unknown settings: `UNSUPPORTED_SETTINGS_TYPE(<n>)`. */
const UNSUPPORTED_RE = /^UNSUPPORTED_SETTINGS_TYPE\((\d+)\)$/;
const NUMERIC_ID_RE = /^(?:0x[0-9a-f]+|\d+)$/i;

/** RFC 9114 section 7.2.4.1 reserved setting identifiers (0x1f * N + 0x21). */
function isReserved(n: bigint): boolean {
    return n >= 0x21n && (n - 0x21n) % 0x1fn === 0n;
}

/** Keys that are known and handled (T1/T2 or T3); everything else is a T3 extra. */
const KNOWN_SETTINGS = new Set([
    "SETTINGS_MAX_HEADER_LIST_SIZE",
    "SETTINGS_MAX_FIELD_SECTION_SIZE",
    "SETTINGS_QPACK_MAX_TABLE_CAPACITY",
    "SETTINGS_QPACK_BLOCKED_STREAMS",
    "SETTINGS_ENABLE_CONNECT_PROTOCOL",
    "SETTINGS_H3_DATAGRAM",
]);

/**
 * HTTP3_SETTINGS_SENT / _RECEIVED params -> http3:parameters_set / parameters_restored fields (without initiator).
 * Missing keys stay absent (in qvis they were `undefined` and dropped by JSON). `extended` adds the T3 fields.
 */
export function mapSettings(params: Record<string, unknown>, extended: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // Q14: current Chrome uses the RFC 9114 name; 2020 Chrome the HTTP/2 one
    const fieldSection = u64(params.SETTINGS_MAX_FIELD_SECTION_SIZE ?? params.SETTINGS_MAX_HEADER_LIST_SIZE);
    if (fieldSection !== undefined) out.max_field_section_size = fieldSection;
    const tableCapacity = u64(params.SETTINGS_QPACK_MAX_TABLE_CAPACITY);
    if (tableCapacity !== undefined) out.max_table_capacity = tableCapacity;
    const blocked = u64(params.SETTINGS_QPACK_BLOCKED_STREAMS);
    if (blocked !== undefined) out.blocked_streams_count = blocked;
    if (!extended) return out;

    const connect = u64(params.SETTINGS_ENABLE_CONNECT_PROTOCOL);
    if (typeof connect === "number" && connect <= 0xffff) out.extended_connect = connect;
    const datagram = u64(params.SETTINGS_H3_DATAGRAM);
    if (typeof datagram === "number" && datagram <= 0xffff) out.h3_datagram = datagram;

    const unknown: Record<string, unknown>[] = [];
    const chromium: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (KNOWN_SETTINGS.has(key)) continue;
        const m = UNSUPPORTED_RE.exec(key);
        const idText = m !== null ? m[1] : NUMERIC_ID_RE.test(key) ? key : undefined;
        if (idText !== undefined) {
            const id = BigInt(idText);
            const idOut = id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString();
            const entry: Record<string, unknown> = { name: isReserved(id) ? "reserved" : "unknown", name_bytes: idOut };
            const v = u64(value);
            entry.value = v !== undefined ? v : value;
            unknown.push(entry);
        } else {
            setOwn(chromium, key, value);
        }
    }
    if (unknown.length > 0) out.unknown_settings = unknown;
    if (Object.keys(chromium).length > 0) out.chromium_settings = chromium;
    return out;
}
