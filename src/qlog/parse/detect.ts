// P3: detect the serialization from the content (main-schema digest section 22). Content wins over the extension.

export type DetectedSerialization = "json" | "json-seq" | "json-lines" | "legacy" | "not-qlog";

/** Number of characters inspected for header members (member order is not significant, so be generous). */
export const DETECT_HEAD_LENGTH = 65536;

const SEQ_SCHEMA_RE = /"file_schema"\s*:\s*"urn:ietf:params:qlog:file:sequential"/;
// also the non-media-type "JSON-SEQ" that quiche, neqo and quinn write (file-loading 9.1 step 5)
const SEQ_FORMAT_RE = /"serialization_format"\s*:\s*"(?:application\/qlog\+)?json-seq/i;

/** Index of the first character that is not a BOM / JSON whitespace. */
export function firstContentIndex(text: string): number {
    let i = 0;
    if (text.charCodeAt(0) === 0xfeff) i = 1; // defensive: stray BOM
    while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
        i++;
    }
    return i;
}

/**
 * - "json-seq": first content char is RS, or an RS occurs in the head (first record lacks its leading RS)
 * - "legacy": head has `"qlog_version"` but no `"file_schema"` (confirmed after parsing)
 * - "json-lines": sequential header without any RS (lenient)
 * - "json": try a contained parse (confirmed after parsing)
 * - "not-qlog": first content char is neither RS nor `{` (e.g. `[` = tshark JSON)
 */
export function detectSerialization(text: string): DetectedSerialization {
    const i = firstContentIndex(text);
    const c = text[i];
    if (c === "\u001e") return "json-seq"; // RFC 7464 record separator
    if (c !== "{") return "not-qlog";
    const head = text.slice(i, i + DETECT_HEAD_LENGTH);
    if (head.includes("\u001e")) return "json-seq"; // first record lacks its leading RS
    if (!head.includes('"file_schema"') && head.includes('"qlog_version"')) return "legacy";
    if (SEQ_SCHEMA_RE.test(head) || SEQ_FORMAT_RE.test(head)) return "json-lines"; // seq header but no RS (lenient)
    return "json";
}

const QLOG_VERSION_RE = /"qlog_version"\s*:\s*"?([^",}\s]*)/;

/** Best-effort extraction of a legacy `qlog_version` value from raw text ("" if not found). */
export function sniffQlogVersion(text: string): string {
    const m = QLOG_VERSION_RE.exec(text.slice(0, DETECT_HEAD_LENGTH));
    return m ? m[1] : "";
}
