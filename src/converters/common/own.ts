// Prototype-safe helpers for objects keyed by strings from the input file (security review).
// A key such as "constructor" or "__proto__" must never resolve to an Object.prototype member, and assigning a
// "__proto__" key must create a data property instead of replacing the object's prototype.

/** `table[key]` if `key` is an own property of `table`, else undefined (never an inherited member). */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** `obj[key] = value` that stores a "__proto__" key as an own data property. */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
    if (key === "__proto__") {
        Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
    } else {
        obj[key] = value;
    }
}
