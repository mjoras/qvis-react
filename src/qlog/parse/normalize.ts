// P6: validate the file header and normalize the root to {...header, traces: [...]} for both serializations.
// Trace and event normalization (P7-P14) is done by the model loader (src/model/QlogLoader.ts).

import { FILE_SCHEMA_CONTAINED, FILE_SCHEMA_SEQUENTIAL, MEDIA_TYPE_JSON, MEDIA_TYPE_JSON_SEQ } from "../schema/main";
import { DiagnosticCollector } from "./diagnostics";
import { LegacyQlogError, QlogParseError } from "./errors";

export type Serialization = "json" | "json-seq";

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Copies the own enumerable members of `src` (except `skip`) onto `out` as data properties. A JSON `"__proto__"`
 * member is an own data property after JSON.parse; a plain `out[key] = value` would set the copy's prototype to the
 * file's value instead (hostile files could then supply inherited members such as `hasOwnProperty`).
 */
export function copyMembers(
    src: Record<string, unknown>,
    out: Record<string, unknown>,
    skip?: string,
): Record<string, unknown> {
    for (const key of Object.keys(src)) {
        if (key === skip) continue;
        if (key === "__proto__") {
            Object.defineProperty(out, key, { value: src[key], enumerable: true, writable: true, configurable: true });
        } else {
            out[key] = src[key];
        }
    }
    return out;
}

/** `serialization_format` compared case-insensitively, without media type parameters. */
export function normalizeMediaType(value: string): string {
    return value.split(";")[0].trim().toLowerCase();
}

/** Media type for a serialization. */
export function mediaTypeFor(serialization: Serialization): string {
    return serialization === "json-seq" ? MEDIA_TYPE_JSON_SEQ : MEDIA_TYPE_JSON;
}

/** File schema URI for a serialization. */
export function fileSchemaFor(serialization: Serialization): string {
    return serialization === "json-seq" ? FILE_SCHEMA_SEQUENTIAL : FILE_SCHEMA_CONTAINED;
}

function checkFileSchema(root: Record<string, unknown>, serialization: Serialization, diag: DiagnosticCollector): void {
    const fs = root.file_schema;
    if (fs === undefined) {
        diag.warn("file.missing-file-schema", "The file has no file_schema; it was inferred from the file structure");
        return;
    }
    if (typeof fs !== "string") {
        diag.warn(
            "file.invalid-file-schema",
            "The file_schema is not a string; it was inferred from the file structure",
            {
                sample: fs,
            },
        );
        return;
    }
    const normalized = fs.trim().toLowerCase(); // file-loading 9.1 step 3.1
    if (normalized === FILE_SCHEMA_CONTAINED || normalized === FILE_SCHEMA_SEQUENTIAL) {
        if (normalized !== fileSchemaFor(serialization)) {
            diag.warn(
                "file.schema-mismatch",
                "The file_schema does not match the file's serialization (" +
                    (serialization === "json-seq" ? "JSON text sequence" : "JSON") +
                    "); the file contents were used",
                { sample: fs },
            );
        }
        return;
    }
    diag.warn(
        "file.unknown-file-schema",
        "The file_schema is not a known qlog file schema; it was loaded as qlog anyway",
        {
            sample: fs,
        },
    );
}

function checkSerializationFormat(
    root: Record<string, unknown>,
    serialization: Serialization,
    diag: DiagnosticCollector,
): void {
    const sf = root.serialization_format;
    if (sf === undefined) {
        diag.warn("file.missing-serialization-format", "The file has no serialization_format");
        return;
    }
    if (typeof sf !== "string") {
        diag.warn("file.invalid-serialization-format", "The serialization_format is not a string", { sample: sf });
        return;
    }
    const mt = normalizeMediaType(sf);
    const expected = mediaTypeFor(serialization);
    if (mt === expected) return;
    if (mt === MEDIA_TYPE_JSON || mt === MEDIA_TYPE_JSON_SEQ) {
        diag.warn(
            "file.serialization-format-mismatch",
            "The serialization_format does not match the file contents; the file contents were used",
            { sample: sf },
        );
        return;
    }
    if (mt === "json" || mt === "json-seq") {
        diag.warn(
            "file.nonstandard-serialization-format",
            "The serialization_format is not a media type (expected " + expected + ")",
            { sample: sf },
        );
        return;
    }
    diag.warn("file.unknown-serialization-format", "The serialization_format is not a known qlog media type", {
        sample: sf,
    });
}

/**
 * Legacy root (file-loading 9.1 step 3.2): `qlog_version` or `qlog_format` without `file_schema`. Returns the
 * version to report (the `qlog_version` value, else the `qlog_format` value), or undefined for a non-legacy root.
 */
export function legacyVersionOfRoot(root: Record<string, unknown>): string | undefined {
    if (root.file_schema !== undefined) return undefined;
    if (root.qlog_version !== undefined) return String(root.qlog_version);
    if (root.qlog_format !== undefined) return String(root.qlog_format);
    return undefined;
}

/**
 * P6. Throws QlogParseError (`file.not-object`, `file.no-traces`, `file.invalid-traces`) or LegacyQlogError.
 * Returns the root itself when it already has a `traces` array (no copy), or a shallow normalized copy for the
 * lenient "contained file with a sequential `trace`" case.
 */
export function validateAndNormalizeRoot(
    root: unknown,
    serialization: Serialization,
    diag: DiagnosticCollector,
): Record<string, unknown> {
    if (!isPlainObject(root)) {
        throw new QlogParseError(
            "File is not a qlog file: the top-level JSON value is not an object",
            "file.not-object",
        );
    }
    const legacy = legacyVersionOfRoot(root);
    if (legacy !== undefined) throw new LegacyQlogError(legacy);
    checkFileSchema(root, serialization, diag);
    checkSerializationFormat(root, serialization, diag);
    if (root.qlog_version !== undefined || root.qlog_format !== undefined) {
        diag.info(
            "file.legacy-members",
            "The file also has legacy qlog_version / qlog_format members; they were ignored (file_schema wins)",
            { sample: root.qlog_version ?? root.qlog_format },
        );
    }

    if (Array.isArray(root.traces)) {
        if (root.traces.length === 0) throw new QlogParseError("File contains no traces", "file.no-traces");
        return root;
    }
    if (root.traces === undefined && isPlainObject(root.trace)) {
        // a contained-parsed file carrying a sequential header and a single trace (lenient)
        diag.warn(
            "file.trace-in-contained",
            "The file uses a single 'trace' member instead of a 'traces' array; it was loaded as one trace",
        );
        const out = copyMembers(root, {}, "trace");
        const trace = root.trace;
        out.traces = [Array.isArray(trace.events) ? trace : { ...trace, events: [] }];
        return out;
    }
    if (root.traces !== undefined) {
        throw new QlogParseError("File is not a valid qlog file: 'traces' is not an array", "file.invalid-traces");
    }
    throw new QlogParseError("File contains no traces", "file.no-traces");
}
