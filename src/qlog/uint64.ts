// I-JSON helpers (main-schema-14 section 11.3/11.4, digest section 17.3/17.4).
// uint64 members may be logged as JSON numbers or as decimal strings. The model never coerces `data`;
// views that do arithmetic on uint64 members go through these helpers.

import type { HexString, RawInfo, Uint64 } from "./schema/main";

const DECIMAL_RE = /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/;
const UINT_RE = /^\s*\d+\s*$/;

/** True for a JSON number or a decimal string (the two legal uint64 encodings). */
export function isUint64(v: unknown): v is Uint64 {
    if (typeof v === "number") return Number.isInteger(v) && v >= 0;
    return typeof v === "string" && UINT_RE.test(v);
}

/**
 * number -> itself; decimal string -> Number(v); anything else -> NaN.
 * Values above 2^53 lose precision (as with plain JSON.parse of numeric literals; qvis had the same limit).
 */
export function toNumber(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "string" && DECIMAL_RE.test(v)) return Number(v);
    if (typeof v === "bigint") return Number(v);
    return NaN;
}

/** Alias of {@link toNumber} (name used by the main-schema digest). */
export const asNumber = toNumber;

/** Exact form for comparisons; undefined if `v` is not an integer number / decimal integer string / bigint. */
export function toBigInt(v: unknown): bigint | undefined {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : undefined;
    if (typeof v === "string" && /^\s*-?\d+\s*$/.test(v)) return BigInt(v.trim());
    return undefined;
}

/** Alias of {@link toBigInt}. */
export const asBigInt = toBigInt;

/** Decimal string form ("" + v for numbers, trimmed for strings); undefined for other values. */
export function toUint64String(v: unknown): string | undefined {
    if (typeof v === "number") return Number.isFinite(v) ? "" + v : undefined;
    if (typeof v === "string") return v.trim();
    if (typeof v === "bigint") return v.toString();
    return undefined;
}

/** Compares two uint64 values regardless of encoding (number vs string). */
export function uint64Equals(a: unknown, b: unknown): boolean {
    const ba = toBigInt(a);
    const bb = toBigInt(b);
    if (ba !== undefined && bb !== undefined) return ba === bb;
    return a === b;
}

/** Byte length of a hexstring (`hex.length / 2`). */
export function hexByteLength(hex: HexString | undefined): number | undefined {
    return typeof hex === "string" ? hex.length / 2 : undefined;
}

/** Byte length of a RawInfo entity: `length ?? data.length / 2` (main-schema-14 section 11.4). */
export function rawByteLength(raw: RawInfo | undefined | null): number | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    if (raw.length !== undefined) {
        const n = toNumber(raw.length);
        if (!Number.isNaN(n)) return n;
    }
    return hexByteLength(raw.data);
}

/** True when `raw.data` was logged but is shorter than `raw.length` (truncated value, section 11.4). */
export function isRawTruncated(raw: RawInfo | undefined | null): boolean {
    if (!raw || typeof raw !== "object" || raw.length === undefined || typeof raw.data !== "string") return false;
    return raw.data.length / 2 < toNumber(raw.length);
}

/** True when `raw.length` was logged but `raw.data` was omitted. */
export function isRawOmitted(raw: RawInfo | undefined | null): boolean {
    return !!raw && typeof raw === "object" && raw.length !== undefined && raw.data === undefined;
}
