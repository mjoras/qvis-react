// HTTP/2 frame extraction from a tshark `http2` layer (port of qvis tcptoqlog.ts:309-358, converters spec 3.9.4).
//
// The layer can be a dict, an array (often with trailing `{}` elements for frames that complete in a later TCP
// segment), or the string "HyperText Transfer Protocol 2". Frames are `http2.stream` members; the client connection
// preface is a pseudo-frame `{"http2.magic": "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"}`.

import type { DiagnosticCollector } from "../common/diagnostics";
import type { TsharkObject } from "./tls";

function isObject(v: unknown): v is TsharkObject {
    return typeof v === "object" && v !== null;
}

/**
 * The magic is part of the payload, but tshark shows no length or type for it: it is always 24 octets
 * ("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"). qvis patched the input object in place; this returns a patched copy and also
 * patches a lone magic given as a single `http2.stream` object (Q6, T2).
 */
function patchMagic(obj: TsharkObject): TsharkObject {
    return obj["http2.magic"] ? { ...obj, "http2.length": "24", "http2.type": "magic" } : obj;
}

/** Collects the HTTP/2 frames of one packet's `http2` layer (which must not be a string), in order. */
export function collectHttp2Frames(http2: unknown, diag: DiagnosticCollector): TsharkObject[] {
    const frames: TsharkObject[] = [];
    const extract = (input: unknown): void => {
        // strings ("HyperText Transfer Protocol 2") and other primitives: nothing to extract
        if (!isObject(input)) return;
        if (Object.keys(input).length === 0) {
            // expected when a TLS record contains a small piece of the H2 frame (the rest is in a later segment)
            diag.info(
                "tshark.empty-h2-entry",
                "Some tshark HTTP/2 layers contain empty entries (frames completed in a later segment); they were ignored",
            );
            return;
        }
        const obj = patchMagic(input);
        const stream = obj["http2.stream"];
        if (stream) {
            if (Array.isArray(stream)) for (const el of stream) extract(el);
            else if (isObject(stream)) frames.push(patchMagic(stream));
        } else if (obj["http2.length"]) {
            // "0" is a truthy string, so 0-length frames are kept
            frames.push(obj);
        } else if (Array.isArray(obj)) {
            for (const el of obj) extract(el);
        } else {
            diag.info(
                "tshark.h2-not-iterable",
                "Some tshark HTTP/2 entries are neither frames nor lists; they were skipped",
            );
        }
    };
    extract(http2);
    return frames;
}

/** `http2.header` as an array (Q4, T2: missing -> [], a single header object -> [it]). */
export function headerList(frame: TsharkObject): TsharkObject[] | undefined {
    const h = frame["http2.header"];
    if (Array.isArray(h)) return h.filter(isObject);
    if (isObject(h)) return [h];
    return undefined;
}
