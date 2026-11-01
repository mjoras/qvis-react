// Notification catalogue of the loading subsystem (file-loading spec §6.1 N1-N15 verbatim, §6.2 X1-X7 NEW).
//
// Texts keep qvis's literal `<br/>` line-break markers; the Notifications host (`src/lib/notify.ts`, shell)
// renders them as line breaks and never as HTML (Q2). Where qvis only says "view the devtools console" we append
// the thrown error's message on a new line (§6.2, last paragraph).

import { errorMessage, legacyVersionOf, PcapUnsupportedError, UnsupportedQlogSchemaError } from "./errors";

export type LoadNotificationType = "success" | "warn" | "error" | "info";

export interface LoadNotification {
    group?: string;
    title: string;
    text: string;
    type?: LoadNotificationType;
    duration?: number;
}

const BR = "<br/>";

function withDetail(text: string, detail?: string): string {
    return detail !== undefined && detail.length > 0 ? text + BR + detail : text;
}

// ---- qvis catalogue (PARITY, §6.1) ----

export const N1_pcapWithoutKeys = (): LoadNotification => ({
    title: "Provide .keys file",
    type: "error",
    duration: 6000,
    text: "You're linking to a .pcap without also providing a .keys file. This is currently not supported.",
});

export const N3_badUploadExtension = (name: string): LoadNotification => ({
    title: "Provide .qlog/.sqlog file",
    type: "error",
    duration: 6000,
    text: "We currently only support uploading .qlog/.sqlog files. " + name,
});

export const N4_uploadStart = (name: string): LoadNotification => ({
    title: "Loading uploaded file",
    text: "Loading uploaded file " + name + ".<br/>The file is not sent to a server.",
});

export const N5_uploadDone = (name: string): LoadNotification => ({
    title: "Uploaded file",
    type: "success",
    text: "The uploaded file is now available for visualization " + name + ".<br/>Use the menu above to switch views.",
});

export const N6_uploadFailed = (name: string, detail?: string): LoadNotification => ({
    title: "Error uploading file",
    type: "error",
    duration: 6000,
    text: withDetail("Something went wrong. " + name + ". For more information, view the devtools console.", detail),
});

export const N7_examplesAlreadyLoaded = (): LoadNotification => ({
    title: "Example files already loaded",
    type: "warn",
    text: "Example files were already loaded, check for files with the 'DEMO_' prefix.",
});

export const N8_massiveAlreadyLoaded = (calledName = "MASSIVE_DEMO_mvfst_large"): LoadNotification => ({
    title: "Example file already loaded",
    type: "warn",
    text: "Example file was already loaded, it is called '" + calledName + "'.",
});

export const N9_parseFailed = (filename: string): LoadNotification => ({
    title: "ERROR parsing qlog file " + filename,
    type: "error",
    duration: 6000,
    text: "File was successfully loaded but could not be parsed.<br/>Make sure you have a well-formed qlog file.<br/>View the devtools JavaScript console for more information.",
});

export const N10_urlLoadStart = (urlToLoad: string): LoadNotification => ({
    title: "Loading file(s) via URL",
    text:
        "Loading files via URL " +
        urlToLoad +
        ".<br/>The backend server downloads the files, possibly transforms them into qlog, then sends them back. This can take a while.",
});

export const N11_urlLoadDone = (urlToLoad: string): LoadNotification => ({
    title: "Loaded files via URL",
    type: "success",
    text:
        "The loaded files are now available for visualization " +
        urlToLoad +
        ".<br/>Use the menu above to switch views.",
});

/** N12, and X7 when `detail` is the proxy's `error` string. */
export const N12_urlLoadFailed = (urlToLoad: string, detail?: string): LoadNotification => ({
    title: "ERROR loading URL " + urlToLoad,
    type: "error",
    duration: 6000,
    text: withDetail(
        "File(s) could not be loaded from " +
            urlToLoad +
            ".<br/>View the devtools JavaScript console for more information.",
        detail,
    ),
});

export const N13_directLoadStart = (filename: string, url: string): LoadNotification => ({
    title: "Loading qlog file directly",
    text: 'Loading qlog file "' + filename + '" from URL ' + url + ". Large files can take a while to load.",
});

export const N14_directLoadDone = (filename: string): LoadNotification => ({
    title: "Loaded " + filename,
    type: "success",
    text: "This file is now available for visualization, use the menu above to switch views.",
});

export const N15_directLoadFailed = (filename: string, url: string, detail?: string): LoadNotification => ({
    title: "ERROR loading " + filename,
    type: "error",
    duration: 6000,
    text: withDetail(
        "This file could not be loaded from " +
            url +
            ".<br/>View the devtools JavaScript console for more information.",
        detail,
    ),
});

// ---- qvis-react additions (NEW, §6.2) ----

export const X1_legacyQlog = (filename: string, version: string): LoadNotification => ({
    title: "Unsupported qlog version in " + filename,
    type: "error",
    duration: 10000,
    text:
        'This file uses qlog_version "' +
        version +
        '". qvis only supports the latest qlog drafts (file_schema urn:ietf:params:qlog:file:contained or urn:ietf:params:qlog:file:sequential, draft-ietf-quic-qlog-main-schema-14). Please regenerate the file with an up-to-date qlog implementation.',
});

export const X2_unsupportedSchema = (
    filename: string,
    field: "file_schema" | "serialization_format",
    value: string,
): LoadNotification => ({
    title: "Unsupported qlog file " + filename,
    type: "error",
    duration: 6000,
    text:
        field === "file_schema"
            ? 'Unknown file_schema "' +
              value +
              '". Supported: urn:ietf:params:qlog:file:contained, urn:ietf:params:qlog:file:sequential.'
            : 'Unknown serialization_format "' +
              value +
              '". Supported: application/qlog+json, application/qlog+json-seq.',
});

export const X3_recordsSkipped = (filename: string, n: number): LoadNotification => ({
    title: "Some records were skipped in " + filename,
    type: "warn",
    duration: 6000,
    text: n + " record(s) contained invalid JSON and were ignored. See the devtools console for details.",
});

/** X4; with the recovered event count when known ("... last complete event (N events).", file-loading 9.5 step 5). */
export const X4_truncatedRepaired = (filename: string, events?: number): LoadNotification => ({
    title: "Incomplete qlog file " + filename,
    type: "warn",
    duration: 6000,
    text:
        "The file was not properly closed (e.g., the logger was stopped early). It was loaded up to the last complete event" +
        (events !== undefined ? " (" + events + " events)" : "") +
        ".",
});

export const X5_someTracesFailed = (n: number, m: number, firstError: string): LoadNotification => ({
    title: "Some files could not be loaded",
    type: "warn",
    duration: 6000,
    text: n + " of " + m + " traces failed: " + firstError,
});

export const X6_pcapUnsupported = (): LoadNotification => ({
    title: "Packet captures not supported",
    type: "error",
    duration: 6000,
    text: "This deployment cannot decrypt or convert .pcap/.pcapng files. Convert them to qlog first, or use a qvis instance with a pcap backend.",
});

/**
 * Error toast for a failed load: X1 (legacy qlog), X2 (unsupported file_schema / serialization_format),
 * X6 (pcap), otherwise the caller's qvis toast with the error message appended (N6 / N12 / N15, X7).
 */
export function loadErrorNotification(
    e: unknown,
    filename: string,
    fallback: (detail: string) => LoadNotification,
): LoadNotification {
    const legacy = legacyVersionOf(e);
    if (legacy !== undefined) return X1_legacyQlog(filename, legacy);
    if (e instanceof UnsupportedQlogSchemaError) return X2_unsupportedSchema(filename, e.field, e.value);
    if (e instanceof PcapUnsupportedError) return X6_pcapUnsupported();
    return fallback(errorMessage(e));
}
