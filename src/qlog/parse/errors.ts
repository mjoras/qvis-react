// Fatal parse errors (ARCHITECTURE section 3.2). Non-fatal problems are Diagnostics instead.

/** A legacy qlog file (`qlog_version` present, no `file_schema`). The loader shows toast X1. */
export class LegacyQlogError extends Error {
    readonly qlogVersion: string;

    constructor(qlogVersion: string) {
        super(
            'This file uses legacy qlog (qlog_version "' +
                qlogVersion +
                '"). qvis only supports draft-ietf-quic-qlog-main-schema-14 files ' +
                "(file_schema urn:ietf:params:qlog:file:contained / urn:ietf:params:qlog:file:sequential).",
        );
        this.name = "LegacyQlogError";
        this.qlogVersion = qlogVersion;
    }
}

/** Unrecoverable input: empty file, not JSON / JSON-SEQ, not a qlog object, no traces, ... */
export class QlogParseError extends Error {
    /** Stable diagnostic-style code, e.g. "file.empty", "json.invalid", "file.no-traces". */
    readonly code: string;

    constructor(message: string, code = "file.invalid") {
        super(message);
        this.name = "QlogParseError";
        this.code = code;
    }
}
