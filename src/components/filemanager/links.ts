// Link helpers for the File Manager (FIX Q3: only http(s) group URLs become links).

/** Absolute http(s) href for a group URL, or undefined (javascript:, data:, unparsable, ...). */
export function safeHref(url: string): string | undefined {
    try {
        const base = typeof document !== "undefined" ? document.baseURI : undefined;
        const u = new URL(url, base);
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
    } catch {
        return undefined;
    }
}
