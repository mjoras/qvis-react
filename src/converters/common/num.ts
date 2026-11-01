// Number helpers shared by the converters (converters spec section 3.2 `num()`, section 9.1 rule 3 / decision C12).
//
// Chrome's NetLogNumberValue writes integers that fit in int32 as JSON numbers and larger ones (offsets,
// `sent_time_us`, ...) as decimal strings; tshark writes every value as a string. These helpers accept both.

const DECIMAL_RE = /^\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/;
const UINT_RE = /^\s*\d+\s*$/;

/** `Number(x)` for a finite number or a numeric string; undefined for anything else (NaN, "", objects, ...). */
export function num(x: unknown): number | undefined {
    if (typeof x === "number") return Number.isFinite(x) ? x : undefined;
    if (typeof x === "string" && DECIMAL_RE.test(x)) {
        const v = Number(x);
        return Number.isFinite(v) ? v : undefined;
    }
    return undefined;
}

/**
 * qlog uint64 (C12): a JSON number when the value is a safe non-negative integer, otherwise the original decimal
 * string (main-schema-14 allows both). Undefined when the input is not a non-negative integer.
 */
export function u64(x: unknown): number | string | undefined {
    if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? x : undefined;
    if (typeof x === "string" && UINT_RE.test(x)) {
        const s = x.trim();
        const v = Number(s);
        if (Number.isSafeInteger(v)) return v;
        return s.replace(/^0+(?=\d)/, "");
    }
    return undefined;
}

/** `parseInt(x, 10)` as qvis did for tshark fields, but undefined instead of NaN. */
export function int(x: unknown): number | undefined {
    if (typeof x === "number") return Number.isFinite(x) ? Math.trunc(x) : undefined;
    if (typeof x !== "string") return undefined;
    const v = parseInt(x, 10);
    return Number.isNaN(v) ? undefined : v;
}
