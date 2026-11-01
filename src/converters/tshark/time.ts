// tshark timestamps -> Unix milliseconds (converters spec section 8.6.3, FIX of Q1: qvis emitted seconds that the
// loader then read as milliseconds, compressing every TCP trace 1000x in time).

/** "1582210168.496779237" -> 1582210168496.779237 (no float rounding of the seconds part). */
export function epochSecondsStringToMs(s: unknown): number {
    const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(String(s));
    if (!m) return NaN;
    const ns = (m[2] ?? "").padEnd(9, "0").slice(0, 9);
    return Number(m[1]) * 1000 + Number(ns) / 1e6;
}

const ISO_RE = /^\s*(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?\s*(Z|UTC|[+-]\d\d:?\d\d)?\s*$/i;

/**
 * Newer Wireshark writes `frame.time_utc` (and `frame.time`) as ISO 8601 strings with up to 9 fractional digits,
 * which Date.parse would round to ms. Older versions write "Feb 20, 2020 14:49:28.496779237 UTC"; Date.parse is the
 * fallback for those. NaN when nothing parses.
 */
export function isoTimeToMs(s: unknown): number {
    if (typeof s !== "string") return NaN;
    const m = ISO_RE.exec(s);
    if (m) {
        let zone = m[4] ?? "Z";
        if (/^utc$/i.test(zone)) zone = "Z";
        else if (zone !== "Z" && !zone.includes(":")) zone = zone.slice(0, 3) + ":" + zone.slice(3);
        const base = Date.parse(m[1] + "T" + m[2] + zone.toUpperCase());
        if (Number.isNaN(base)) return NaN;
        const frac = m[3] ?? "";
        return base + (frac === "" ? 0 : Number("0." + frac) * 1000);
    }
    const v = Date.parse(s);
    return Number.isNaN(v) ? NaN : v;
}

/** The packet time in ms: frame.time_epoch, else frame.time_utc / frame.time. NaN when none parses. */
export function frameTimeMs(frame: Record<string, unknown> | undefined): number {
    if (frame === undefined) return NaN;
    const epoch = epochSecondsStringToMs(frame["frame.time_epoch"]);
    if (!Number.isNaN(epoch)) return epoch;
    // Wireshark >= 4.2 may also print time_epoch as an ISO string
    const isoEpoch = isoTimeToMs(frame["frame.time_epoch"]);
    if (!Number.isNaN(isoEpoch)) return isoEpoch;
    return isoTimeToMs(frame["frame.time_utc"] ?? frame["frame.time"]);
}
