// Error types thrown by the loading pipeline (file-loading spec §3.14, §6.2, §8.1 errors.ts).
//
// The core parser (`@/qlog/parse`) throws its own `LegacyQlogError`; the loader's content sniff throws
// `UnsupportedQlogVersionError` before the whole file is read. Both map to toast X1 (see `legacyVersionOf`).

import { LegacyQlogError } from "@/qlog/parse";

/** A legacy qlog file (`qlog_version` without `file_schema`), detected by the loader's header sniff. */
export class UnsupportedQlogVersionError extends Error {
    readonly qlogVersion: string;
    constructor(qlogVersion: string) {
        super(`Legacy qlog file (qlog_version "${qlogVersion}") is not supported`);
        this.name = "UnsupportedQlogVersionError";
        this.qlogVersion = qlogVersion;
    }
}

/** `file_schema` / `serialization_format` with a value qvis does not support (toast X2). */
export class UnsupportedQlogSchemaError extends Error {
    readonly field: "file_schema" | "serialization_format";
    readonly value: string;
    constructor(field: "file_schema" | "serialization_format", value: string) {
        super(
            field === "file_schema"
                ? `Unsupported qlog file_schema "${value}"`
                : `Unsupported serialization_format "${value}"`,
        );
        this.name = "UnsupportedQlogSchemaError";
        this.field = field;
        this.value = value;
    }
}

/** `.pcap` / `.pcapng` input while no pcap backend is configured (toast X6). */
export class PcapUnsupportedError extends Error {
    constructor(name: string) {
        super("Packet captures (.pcap/.pcapng) cannot be converted in this deployment: " + name);
        this.name = "PcapUnsupportedError";
    }
}

/** A netlog / tshark converter failed (or is not available yet). Final: re-fetching cannot fix it. */
export class ConversionError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ConversionError";
    }
}

/** The qvis CORS proxy (or the optional pcap backend) answered with an error (toast X7). */
export class ProxyError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "ProxyError";
        this.status = status;
    }
}

/** Returns the legacy `qlog_version` if `e` is a legacy-file error from the loader or from the core parser. */
export function legacyVersionOf(e: unknown): string | undefined {
    if (e instanceof UnsupportedQlogVersionError) return e.qlogVersion;
    if (e instanceof LegacyQlogError) return String(e.qlogVersion ?? "");
    return undefined;
}

/**
 * Errors that make a URL load final: re-fetching the same URL through the CORS proxy cannot fix them
 * (file-loading §8.3 loadSingleRemote step 2).
 */
export function isFinalLoadError(e: unknown): boolean {
    return (
        legacyVersionOf(e) !== undefined ||
        e instanceof UnsupportedQlogSchemaError ||
        e instanceof PcapUnsupportedError ||
        e instanceof ConversionError
    );
}

export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}
