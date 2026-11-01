// vue-router 3.1.3 compatible query-string codec (parity/app-shell.md §3.3 "Query-string codec", §8.2).
//
// Differences from vue-router, all deliberate (parity/app-shell.md §7):
//   - Q25: malformed percent-escapes do not throw; the raw text is kept instead.
//   - Q26: `parseQuery` normalizes every value to ONE string, taking the FIRST occurrence of a repeated key
//          (URLSearchParams.get semantics); a bare key (`?flag`) becomes "". `parseQueryRaw` keeps the
//          vue-router shape (null for bare keys, arrays for repeated keys) for callers that need it.
//   - empty parameters (`a=1&&b=2`, trailing `&`) are skipped instead of producing a "" key.
// Kept (Q27): `+` decodes to a space (standard form encoding).

export type RawQueryValue = string | null | Array<string | null>;
export type RawQuery = Record<string, RawQueryValue>;
export type Query = Record<string, string>;

/** decodeURIComponent that never throws: on a malformed escape the raw input is returned (Q25). */
export function safeDecode(str: string): string {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

/**
 * Own-property write that also works for keys such as `__proto__` (a plain assignment would hit the prototype
 * setter). Reads use {@link getOwn}, so inherited members (`constructor`, `toString`, ...) never look like keys.
 */
function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

function getOwn<T>(obj: Record<string, T>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Parses a query string the way vue-router 3.1.3 does (minus the crash on malformed escapes). */
export function parseQueryRaw(input: string): RawQuery {
    const res: RawQuery = {};
    const query = input.trim().replace(/^(\?|#|&)/, "");
    if (!query) {
        return res;
    }

    for (const param of query.split("&")) {
        if (param === "") {
            continue;
        }
        const parts = param.replace(/\+/g, " ").split("=");
        const key = safeDecode(parts.shift() as string);
        const val = parts.length > 0 ? safeDecode(parts.join("=")) : null;

        const existing = getOwn(res, key);
        if (existing === undefined) {
            setOwn<RawQueryValue>(res, key, val);
        } else if (Array.isArray(existing)) {
            existing.push(val);
        } else {
            setOwn<RawQueryValue>(res, key, [existing, val]);
        }
    }
    return res;
}

/** Collapses a raw (vue-router shaped) query to single strings: first occurrence wins, null becomes "" (Q26). */
export function normalizeQuery(raw: RawQuery): Query {
    const out: Query = {};
    for (const key of Object.keys(raw)) {
        const val = raw[key];
        const first = Array.isArray(val) ? val[0] : val;
        setOwn(out, key, first ?? "");
    }
    return out;
}

/** Parses a query string ("?a=b&c", "a=b", "#a=b" or "") into single-string values. */
export { setOwn as setOwnQueryValue, getOwn as getOwnQueryValue };

export function parseQuery(input: string): Query {
    return normalizeQuery(parseQueryRaw(input));
}

const encodeReserveRE = /[!'()*]/g;
const encodeReserveReplacer = (c: string): string => "%" + c.charCodeAt(0).toString(16);
const commaRE = /%2C/g;

/** vue-router's encoder: encodeURIComponent, then escape !'()* as %21 %27 %28 %29 %2a, and keep commas. */
export function encodeQueryComponent(str: string): string {
    return encodeURIComponent(str).replace(encodeReserveRE, encodeReserveReplacer).replace(commaRE, ",");
}

/**
 * Stringifies a query object like vue-router 3.1.3, WITHOUT the leading "?".
 * `null` gives a bare key, `undefined` drops the key, arrays repeat the key. Keys keep insertion order.
 */
export function stringifyQuery(obj: Record<string, RawQueryValue | undefined> | undefined): string {
    if (!obj) {
        return "";
    }
    const parts: string[] = [];
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val === undefined) {
            continue;
        }
        if (val === null) {
            parts.push(encodeQueryComponent(key));
            continue;
        }
        if (Array.isArray(val)) {
            const sub: string[] = [];
            for (const v of val) {
                if (v === undefined) {
                    continue;
                }
                sub.push(
                    v === null ? encodeQueryComponent(key) : encodeQueryComponent(key) + "=" + encodeQueryComponent(v),
                );
            }
            const joined = sub.join("&");
            if (joined.length > 0) {
                parts.push(joined);
            }
            continue;
        }
        parts.push(encodeQueryComponent(key) + "=" + encodeQueryComponent(val));
    }
    return parts.join("&");
}

/** True when the query object has at least one key (vue-router's `hasQueryParams`). */
export function hasQueryParams(query: Record<string, unknown>): boolean {
    return Object.keys(query).length > 0;
}

/** Shallow equality of two normalized queries, including key order (matches vue-router fullPath comparison). */
export function sameQuery(a: Query, b: Query): boolean {
    return stringifyQuery(a) === stringifyQuery(b);
}
