// Netlog text parsing with truncated-file repair (converters spec section 8.5.6, NEW; qvis threw and the upload
// failed). Chrome writes `{"constants":{...},"events":[{...},\n{...},\n ... ]` while capturing and appends
// `],"polledData":{...}}` only when the capture is stopped, so a netlog of a crashed or still-running browser is
// truncated. Like Chrome's own netlog viewer, cut back to the end of the last complete element of the top-level
// "events" array and close the document.

import type { DiagnosticCollector } from "../common/diagnostics";
import { NETLOG_REPAIRED_CODE } from "../common/notifications";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Returns the repaired text, or undefined when the text is not a netlog prefix that can be repaired (no
 * `"events":[` array at the top level of a `{"constants"...` document, or not a single complete event in it).
 */
export function repairTruncatedNetlog(text: string): string | undefined {
    let start = 0;
    if (text.charCodeAt(0) === 0xfeff) start = 1;
    while (start < text.length && /\s/.test(text[start])) start++;
    if (!text.startsWith('{"constants"', start) && !/^\{\s*"constants"/.test(text.slice(start, start + 64))) {
        return undefined;
    }

    const n = text.length;
    let depth = 0;
    let lastKey: string | undefined = undefined; // last string token seen directly in the root object
    let expectKey = false; // inside the root object, the next string is a key
    let eventsDepth = -1; // depth of the open top-level "events" array (2), or -1
    let eventsClosedAt = -1; // index after the "]" that closed the events array
    let lastElementEnd = -1; // index after the "}" / "]" of the last complete events element
    let i = start;
    while (i < n) {
        const c = text.charCodeAt(i);
        if (c === QUOTE) {
            // string: find the closing quote, honouring escapes
            let j = i + 1;
            while (j < n) {
                const d = text.charCodeAt(j);
                if (d === BACKSLASH) j += 2;
                else if (d === QUOTE) break;
                else j++;
            }
            if (j >= n) break; // truncated inside a string
            if (depth === 1 && expectKey) {
                lastKey = text.slice(i + 1, j);
                expectKey = false;
            }
            i = j + 1;
            continue;
        }
        if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
            depth++;
            if (depth === 1) expectKey = true;
            if (depth === 2 && c === 0x5b && lastKey === "events" && eventsClosedAt < 0) eventsDepth = 2;
        } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
            depth--;
            if (eventsDepth > 0 && depth === eventsDepth) lastElementEnd = i + 1;
            if (eventsDepth > 0 && depth === eventsDepth - 1 && c === 0x5d) {
                eventsClosedAt = i + 1;
                eventsDepth = -1;
            }
            if (depth <= 0) break; // complete (JSON.parse failed for another reason) or malformed
        } else if (c === 0x2c /* , */ && depth === 1) {
            expectKey = true;
        }
        i++;
    }
    if (eventsClosedAt > 0) return text.slice(0, eventsClosedAt) + "}";
    if (lastElementEnd > 0) return text.slice(0, lastElementEnd) + "]}";
    return undefined;
}

/** JSON.parse with the truncation repair. Throws (with qvis-like wording) when the text cannot be used. */
export function parseNetlogText(input: string, name: string, diag: DiagnosticCollector): unknown {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    try {
        return JSON.parse(text);
    } catch (e) {
        const repaired = repairTruncatedNetlog(text);
        if (repaired !== undefined) {
            try {
                const root = JSON.parse(repaired);
                diag.warn(
                    NETLOG_REPAIRED_CODE,
                    "The netlog file was not closed properly; it was loaded up to the cut-off",
                    {
                        sample: { originalLength: text.length, usedLength: repaired.length - 2 },
                    },
                );
                return root;
            } catch {
                // fall through to the original error
            }
        }
        throw new Error("Could not parse netlog file " + name + " : " + (e instanceof Error ? e.message : String(e)), {
            cause: e,
        });
    }
}
