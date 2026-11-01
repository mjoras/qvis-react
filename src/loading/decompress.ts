// Byte-level helpers: Blob streaming, magic-byte sniffing and client-side decompression
// (file-loading spec §3.14 step 2, §8.6). Uses the platform DecompressionStream; no dependencies.

import type { CompressionHint } from "./detect";
import { looksLikeText, sniffMagic } from "./detect";
import { PcapUnsupportedError } from "./errors";

const CHUNK = 1 << 20;

/** `blob.stream()` with a slice-based fallback (older browsers, jsdom). */
export function blobToStream(blob: Blob): ReadableStream<Uint8Array> {
    const native = (blob as Blob & { stream?: () => ReadableStream<Uint8Array> }).stream;
    if (typeof native === "function") return native.call(blob) as ReadableStream<Uint8Array>;
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (offset >= blob.size) {
                controller.close();
                return;
            }
            const buf = await blob.slice(offset, offset + CHUNK).arrayBuffer();
            offset += CHUNK;
            controller.enqueue(new Uint8Array(buf));
        },
    });
}

export async function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/**
 * Security FIX (decompression bomb): a 2 KB gzip file can inflate to a GiB in a second (and to many GiB with a few KB
 * more) and take the tab down. Client-side decompression stops at 512 MiB: V8 cannot hold a longer string, so qvis
 * could never parse a larger contained file either, and the largest demo (the massive trace) is about 50 MB.
 */
export const MAX_DECOMPRESSED_BYTES = 2 ** 29;

/**
 * Reads a stream to the end into a Blob (kept out of the JS heap where the browser supports it). Throws (and cancels
 * the stream) once more than `maxBytes` have arrived.
 */
export async function streamToBlob(stream: ReadableStream<Uint8Array>, type = "", maxBytes = Infinity): Promise<Blob> {
    const parts: BlobPart[] = [];
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error("The decompressed file is larger than " + Math.round(maxBytes / 2 ** 20) + " MB");
            }
            parts.push(value as Uint8Array<ArrayBuffer>);
        }
    }
    return new Blob(parts, { type });
}

function makeDecompressionStream(format: "gzip" | "brotli"): DecompressionStream {
    if (typeof DecompressionStream === "undefined") {
        throw new Error(
            format === "gzip"
                ? "Gzip-compressed files are not supported in this browser"
                : "Brotli-compressed files are not supported in this browser",
        );
    }
    try {
        return new DecompressionStream(format as CompressionFormat);
    } catch {
        throw new Error(
            format === "gzip"
                ? "Gzip-compressed files are not supported in this browser"
                : "Brotli-compressed files are not supported in this browser",
        );
    }
}

export async function decompressBlob(
    blob: Blob,
    format: "gzip" | "brotli",
    maxBytes: number = MAX_DECOMPRESSED_BYTES,
): Promise<Blob> {
    const ds = makeDecompressionStream(format);
    try {
        const source = blobToStream(blob) as ReadableStream<Uint8Array<ArrayBuffer>>;
        return await streamToBlob(source.pipeThrough(ds), "", maxBytes);
    } catch (e) {
        throw new Error(
            (format === "gzip" ? "Could not decompress gzip data: " : "Could not decompress brotli data: ") +
                (e instanceof Error ? e.message : String(e)),
            { cause: e },
        );
    }
}

/**
 * §3.14 step 2. gzip is recognised by its magic bytes (whatever the name says); brotli has no magic, so it is only
 * attempted for `.br`/`.brotli` names whose bytes do not already look like JSON (an HTTP `Content-Encoding: br`
 * response arrives decoded). ZIP archives and packet captures are rejected with a clear message.
 */
export async function maybeDecompress(blob: Blob, name: string, compression: CompressionHint): Promise<Blob> {
    const head = await readBytes(blob, 0, 8);
    const magic = sniffMagic(head);
    if (magic === "gzip") {
        const out = await decompressBlob(blob, "gzip");
        // a doubly compressed file (`x.qlog.gz` served with Content-Encoding: gzip by a misconfigured server is
        // decoded once by the browser; handle one more level defensively)
        const inner = sniffMagic(await readBytes(out, 0, 8));
        return inner === "gzip" ? decompressBlob(out, "gzip") : out;
    }
    if (magic === "zip") throw new Error("ZIP archives are not supported");
    if (magic === "pcap") throw new PcapUnsupportedError(name);
    if (compression === "brotli" && !looksLikeText(head)) return decompressBlob(blob, "brotli");
    return blob;
}
