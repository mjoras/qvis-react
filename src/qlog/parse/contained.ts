// P4: parse contained JSON (QlogFile), with recovery of truncated / damaged files (qvis parity: qvis fell back to
// the oboe streaming parser and kept everything parsed up to the error).
//
// Recovery uses a validating JSON scanner instead of a plain bracket counter, so it finds the exact position of
// the first syntax error (truncation, garbage, mid-file damage), cuts back to the last point where a value was
// complete, and appends the closers of the containers that are still open. It also knows the key path of those
// containers, so a partially written event (`traces[i].events[j]` still open at the cut) is dropped instead of
// being kept half-filled.

import { DiagnosticCollector } from "./diagnostics";
import { QlogParseError } from "./errors";

export type RepairReason = "truncated" | "syntax-error" | "trailing-data";

export interface RepairResult {
    /** Repaired JSON text (always parseable by JSON.parse). */
    text: string;
    reason: RepairReason;
    /** Position in the input where scanning stopped (first invalid / missing character). */
    errorPos: number;
    /** True when the cut fell inside an event object (`traces[*].events[*]` or `trace.events[*]`). */
    partialEvent: boolean;
}

// container kinds
const OBJ = 0;
const ARR = 1;
// parser states
const S_VALUE = 0; // expecting a value (top level, after ':' or after ',' in an array)
const S_VALUE_OR_END = 1; // after '[': value or ']'
const S_KEY_OR_END = 2; // after '{': key or '}'
const S_KEY = 3; // after ',' in an object
const S_COLON = 4;
const S_OBJ_NEXT = 5; // after a member value: ',' or '}'
const S_ARR_NEXT = 6; // after an element: ',' or ']'
const S_DONE = 7; // root complete; only whitespace may follow

function isWs(c: number): boolean {
    return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}
function isDigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
}
function isHex(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

/** Returns the index after the closing quote, or -1 (eof) / -2 - pos (invalid at pos). */
function scanString(text: string, start: number): number {
    const n = text.length;
    let i = start + 1;
    while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x22) return i + 1;
        if (c === 0x5c) {
            if (i + 1 >= n) return -1;
            const e = text.charCodeAt(i + 1);
            if (e === 0x75) {
                for (let k = 2; k < 6; k++) {
                    if (i + k >= n) return -1;
                    if (!isHex(text.charCodeAt(i + k))) return -2 - (i + k);
                }
                i += 6;
                continue;
            }
            // " \ / b f n r t
            if (
                e === 0x22 ||
                e === 0x5c ||
                e === 0x2f ||
                e === 0x62 ||
                e === 0x66 ||
                e === 0x6e ||
                e === 0x72 ||
                e === 0x74
            ) {
                i += 2;
                continue;
            }
            return -2 - (i + 1);
        }
        if (c < 0x20) return -2 - i;
        i++;
    }
    return -1;
}

/** Returns the index after the number, or -1 (eof: the number may continue) / -2 - pos (invalid at pos). */
function scanNumber(text: string, start: number): number {
    const n = text.length;
    let i = start;
    if (text.charCodeAt(i) === 0x2d) i++;
    if (i >= n) return -1;
    if (text.charCodeAt(i) === 0x30) i++;
    else if (isDigit(text.charCodeAt(i))) {
        while (i < n && isDigit(text.charCodeAt(i))) i++;
    } else return -2 - i;
    if (i < n && text.charCodeAt(i) === 0x2e) {
        i++;
        if (i >= n) return -1;
        if (!isDigit(text.charCodeAt(i))) return -2 - i;
        while (i < n && isDigit(text.charCodeAt(i))) i++;
    }
    if (i < n && (text.charCodeAt(i) === 0x65 || text.charCodeAt(i) === 0x45)) {
        i++;
        if (i < n && (text.charCodeAt(i) === 0x2b || text.charCodeAt(i) === 0x2d)) i++;
        if (i >= n) return -1;
        if (!isDigit(text.charCodeAt(i))) return -2 - i;
        while (i < n && isDigit(text.charCodeAt(i))) i++;
    }
    if (i >= n) return -1; // a number running into EOF might have been cut short
    return i;
}

function scanLiteral(text: string, start: number, lit: string): number {
    for (let k = 0; k < lit.length; k++) {
        if (start + k >= text.length) return -1;
        if (text.charCodeAt(start + k) !== lit.charCodeAt(k)) return -2 - (start + k);
    }
    return start + lit.length;
}

/**
 * Repairs JSON text that `JSON.parse` rejected. Returns null when nothing useful can be recovered
 * (no complete value at all), or when the text turns out to be valid JSON.
 */
export function repairJson(text: string): RepairResult | null {
    const n = text.length;
    const kinds: number[] = [];
    const keys: (string | undefined)[] = []; // key under which each container was opened (objects only)
    const curKeys: (string | undefined)[] = []; // current member key of each open object
    let state = S_VALUE; // state of the innermost container (or top level)
    let lastSafePos = -1;
    let lastSafeDepth = 0;
    let rootEnd = -1;
    let i = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let errorPos: number;

    const valueDone = (end: number): void => {
        const depth = kinds.length;
        if (depth === 0) {
            state = S_DONE;
            rootEnd = end;
            return;
        }
        state = kinds[depth - 1] === OBJ ? S_OBJ_NEXT : S_ARR_NEXT;
        lastSafePos = end;
        lastSafeDepth = depth;
    };
    const open = (kind: number): void => {
        const depth = kinds.length;
        const parentKey = depth > 0 && kinds[depth - 1] === OBJ ? curKeys[depth - 1] : undefined;
        kinds.push(kind);
        keys.push(parentKey);
        curKeys.push(undefined);
        state = kind === OBJ ? S_KEY_OR_END : S_VALUE_OR_END;
        // cutting right after a nested opening bracket is safe too ({} / []); the root alone is not worth keeping
        if (depth > 0) {
            lastSafePos = i + 1;
            lastSafeDepth = kinds.length;
        }
    };
    const close = (): void => {
        kinds.pop();
        keys.pop();
        curKeys.pop();
        valueDone(i + 1); // sets the parent's state
    };

    scan: while (true) {
        while (i < n && isWs(text.charCodeAt(i))) i++;
        if (i >= n) {
            errorPos = n;
            break;
        }
        const c = text.charCodeAt(i);
        switch (state) {
            case S_DONE:
                errorPos = i;
                break scan;
            case S_COLON:
                if (c !== 0x3a) {
                    errorPos = i;
                    break scan;
                }
                state = S_VALUE;
                i++;
                continue;
            case S_OBJ_NEXT:
                if (c === 0x2c) {
                    state = S_KEY;
                    i++;
                } else if (c === 0x7d) {
                    close();
                    i++;
                } else {
                    errorPos = i;
                    break scan;
                }
                continue;
            case S_ARR_NEXT:
                if (c === 0x2c) {
                    state = S_VALUE;
                    i++;
                } else if (c === 0x5d) {
                    close();
                    i++;
                } else {
                    errorPos = i;
                    break scan;
                }
                continue;
            case S_KEY_OR_END:
            case S_KEY: {
                if (c === 0x7d && state === S_KEY_OR_END) {
                    close();
                    i++;
                    continue;
                }
                if (c !== 0x22) {
                    errorPos = i;
                    break scan;
                }
                const end = scanString(text, i);
                if (end < 0) {
                    errorPos = end === -1 ? n : -2 - end;
                    break scan;
                }
                curKeys[kinds.length - 1] = text.slice(i + 1, end - 1);
                state = S_COLON;
                i = end;
                continue;
            }
            default: {
                // S_VALUE / S_VALUE_OR_END
                if (c === 0x5d && state === S_VALUE_OR_END) {
                    close();
                    i++;
                    continue;
                }
                if (c === 0x7b) {
                    open(OBJ);
                    i++;
                    continue;
                }
                if (c === 0x5b) {
                    open(ARR);
                    i++;
                    continue;
                }
                let end: number;
                if (c === 0x22) end = scanString(text, i);
                else if (c === 0x2d || isDigit(c)) end = scanNumber(text, i);
                else if (c === 0x74) end = scanLiteral(text, i, "true");
                else if (c === 0x66) end = scanLiteral(text, i, "false");
                else if (c === 0x6e) end = scanLiteral(text, i, "null");
                else {
                    errorPos = i;
                    break scan;
                }
                if (end < 0) {
                    errorPos = end === -1 ? n : -2 - end;
                    break scan;
                }
                i = end;
                valueDone(end);
                continue;
            }
        }
    }

    const start = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (state === S_DONE) {
        if (errorPos >= n) return null; // the whole text is valid JSON
        return { text: text.slice(start, rootEnd), reason: "trailing-data", errorPos, partialEvent: false };
    }
    if (lastSafePos < 0) return null;

    let closers = "";
    for (let d = lastSafeDepth - 1; d >= 0; d--) closers += kinds[d] === OBJ ? "}" : "]";
    // traces[*].events[*] open at the cut, or (lenient) trace.events[*]
    const partialEvent =
        (lastSafeDepth >= 5 &&
            kinds[0] === OBJ &&
            kinds[1] === ARR &&
            keys[1] === "traces" &&
            kinds[2] === OBJ &&
            kinds[3] === ARR &&
            keys[3] === "events" &&
            kinds[4] === OBJ) ||
        (lastSafeDepth >= 4 &&
            kinds[0] === OBJ &&
            kinds[1] === OBJ &&
            keys[1] === "trace" &&
            kinds[2] === ARR &&
            keys[2] === "events" &&
            kinds[3] === OBJ);
    return {
        text: text.slice(start, lastSafePos) + closers,
        reason: errorPos >= n ? "truncated" : "syntax-error",
        errorPos,
        partialEvent,
    };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Events arrays of a (possibly lenient) contained root: `traces[*].events` and `trace.events`. */
function eventArrays(root: Record<string, unknown>): unknown[][] {
    const out: unknown[][] = [];
    if (Array.isArray(root.traces)) {
        for (const t of root.traces) if (isPlainObject(t) && Array.isArray(t.events)) out.push(t.events);
    } else if (isPlainObject(root.trace) && Array.isArray(root.trace.events)) {
        out.push(root.trace.events);
    }
    return out;
}

function lastEventsArray(root: Record<string, unknown>): unknown[] | undefined {
    const arrays = eventArrays(root);
    return arrays.length > 0 ? arrays[arrays.length - 1] : undefined;
}

/**
 * Parses a contained qlog file. Valid JSON goes straight through `JSON.parse`. Otherwise the text is repaired
 * (see {@link repairJson}) and the event object that the cut went through is dropped entirely. Syntactically complete
 * events are never dropped, even when they lack `time`, `name` or `data`: that is not a truncation artefact, the data
 * model keeps and flags them (file-loading 3.5 NEW and 9.5, which refine main-schema digest P4 step 3).
 * Throws QlogParseError when nothing can be recovered.
 */
export function parseContained(text: string, diag: DiagnosticCollector): unknown {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    let firstError: unknown;
    try {
        return JSON.parse(body);
    } catch (e) {
        firstError = e;
    }
    const rep = repairJson(body);
    if (rep === null) {
        throw new QlogParseError(
            "File is not valid JSON and could not be recovered: " + errorMessage(firstError),
            "json.invalid",
        );
    }
    let root: unknown;
    try {
        root = JSON.parse(rep.text);
    } catch (e) {
        throw new QlogParseError(
            "File is not valid JSON and could not be recovered: " + errorMessage(e),
            "json.invalid",
        );
    }
    if (rep.reason === "trailing-data") {
        diag.warn(
            "json.trailing-data",
            "The file has unexpected data after the end of the qlog JSON object; it was ignored",
            {
                sample: body.slice(rep.errorPos, rep.errorPos + 100),
            },
        );
        return root;
    }

    let dropped = 0;
    if (isPlainObject(root)) {
        const events = lastEventsArray(root);
        if (events && events.length > 0 && rep.partialEvent) {
            events.pop();
            dropped++;
        }
    }
    let recovered = 0;
    if (isPlainObject(root)) for (const arr of eventArrays(root)) recovered += arr.length;

    const sample = { recoveredEvents: recovered, droppedIncompleteEvents: dropped, errorPos: rep.errorPos };
    if (rep.reason === "truncated") {
        diag.warn(
            "json.truncated-recovered",
            "The file was not properly closed (truncated); it was loaded up to the last complete event (" +
                recovered +
                " events)",
            { sample },
        );
    } else {
        diag.warn(
            "json.syntax-error-recovered",
            "The file contains invalid JSON at position " +
                rep.errorPos +
                "; it was loaded up to the last complete event before the error (" +
                recovered +
                " events)",
            { sample },
        );
    }
    return root;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
