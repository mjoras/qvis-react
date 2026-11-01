// URL loading (file-loading spec §3.8 and the qvis-react algorithm of §8.3): `?file=`, `?list=`, `?file1..N=`
// (startup query and Option 1). list / fileN orchestration happens client-side; every capture is fetched directly
// first and through the CORS proxy on failure. Pure async functions: the store passes its callbacks in (`deps`).

import type { LoadedQlog } from "@/qlog/parse";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { CONTAINED_FORMAT, CONTAINED_SCHEMA, isPcapLikeURL } from "./detect";
import { errorMessage, PcapUnsupportedError } from "./errors";
import { loadQlogFile } from "./fileLoader";
import type { LoadNotification } from "./messages";
import {
    loadErrorNotification,
    N10_urlLoadStart,
    N11_urlLoadDone,
    N12_urlLoadFailed,
    X5_someTracesFailed,
} from "./messages";
import { absoluteURL, fetchFromPcapBackend, fetchRemote, pcapBackendURL } from "./remote";
import type { FetchLike } from "./remote";
import { buildFileInfo } from "./shorten";
import type { FileInfo } from "./shorten";

export type QueryValue = string | null | undefined | ReadonlyArray<string | null>;
export type Query = Readonly<Record<string, QueryValue>>;

export interface LoaderDeps {
    notify(n: LoadNotification): void;
    /**
     * QlogLoader.fromJSON + store add. Shows N9 itself and returns undefined when the model rejects the file;
     * otherwise shows `success` (if given) followed by the post-load diagnostic warnings (X3/X4/DM1-DM3).
     */
    addGroupFromQlogFile(
        loaded: LoadedQlog,
        fileInfo: FileInfo,
        success?: LoadNotification,
    ): QlogConnectionGroup | undefined;
    adjustOutstanding(delta: number): void;
    fetch?: FetchLike;
}

/** First value of a (possibly repeated) query key; `?file` without value (null) counts as absent. */
export function firstValue(v: QueryValue): string | undefined {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "string") return v;
    for (const x of v) if (typeof x === "string") return x;
    return undefined;
}

export interface QuerySelection {
    mode: "file" | "list" | "multi";
    /** display string for N10-N12 and the group filename (`file1 + " etc."` for multi) */
    urlToLoad: string;
    /** only for `file`: becomes group.URL */
    fullURL?: string;
}

/** Precedence `file` > `list` > `file1` (§5.1). Returns undefined when the query has no file parameter. */
export function pickQuery(q: Query): QuerySelection | undefined {
    const file = firstValue(q.file)?.trim();
    if (file) return { mode: "file", urlToLoad: file, fullURL: file };
    const list = firstValue(q.list)?.trim();
    if (list) return { mode: "list", urlToLoad: list };
    const file1 = firstValue(q.file1)?.trim();
    if (file1) return { mode: "multi", urlToLoad: file1 + " etc." };
    return undefined;
}

/** Error toast for a failed URL load (X1 / X2 / X6 for the specific cases, otherwise N12 + message, X7). */
export function urlErrorNotification(e: unknown, urlToLoad: string): LoadNotification {
    return loadErrorNotification(e, urlToLoad, (detail) => N12_urlLoadFailed(urlToLoad, detail));
}

interface TraceErrorLike {
    error_description: string;
    uri?: string;
}

function isTraceError(t: unknown): t is TraceErrorLike {
    return (
        t !== null &&
        typeof t === "object" &&
        typeof (t as { error_description?: unknown }).error_description === "string"
    );
}

function tracesOf(loaded: LoadedQlog): unknown[] {
    const traces = (loaded.root as { traces?: unknown }).traces;
    return Array.isArray(traces) ? traces : [];
}

/** X5 data: how many of the traces are TraceErrors (FIX Q8: good traces are kept). */
export function traceErrorSummary(loaded: LoadedQlog): { failed: number; total: number; first: string } | undefined {
    const traces = tracesOf(loaded);
    const errors = traces.filter(isTraceError);
    if (errors.length === 0) return undefined;
    return { failed: errors.length, total: traces.length, first: errors[0].error_description };
}

/**
 * One remote file. pcap-like URLs go to the optional pcap backend or fail with PcapUnsupportedError (X6).
 * Everything else: direct fetch, proxy fallback on network/CORS/HTTP failure, then the normal file loader.
 */
export async function loadSingleRemote(
    url: string,
    secrets: string | undefined,
    deps: Pick<LoaderDeps, "fetch"> = {},
): Promise<LoadedQlog> {
    if (isPcapLikeURL(url)) {
        const base = pcapBackendURL();
        if (base === undefined) throw new PcapUnsupportedError(url);
        const text = await fetchFromPcapBackend(
            base,
            absoluteURL(url),
            secrets ? absoluteURL(secrets) : undefined,
            deps.fetch,
        );
        return loadQlogFile(text, url, {
            isURL: true,
            extension: { hint: "contained", compression: undefined, suffix: "" },
        });
    }
    const blob = await fetchRemote(url, deps.fetch);
    return loadQlogFile(blob, url, { isURL: true });
}

export interface ListEntry {
    capture: string;
    secrets?: string;
    description?: string;
}

export interface ListFile {
    description?: string;
    paths: ListEntry[];
}

/** pcap2qlog list format `{description?, paths: [{capture, secrets?, description?}]}`; undefined if `text` is not one. */
export function parseListFile(text: string): ListFile | undefined {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
    const obj = json as Record<string, unknown>;
    if (!Array.isArray(obj.paths) || "traces" in obj || "file_schema" in obj || "qlog_version" in obj) return undefined;
    const paths: ListEntry[] = [];
    for (const p of obj.paths) {
        if (p === null || typeof p !== "object") continue;
        const e = p as Record<string, unknown>;
        if (typeof e.capture !== "string" || e.capture.length === 0) continue;
        paths.push({
            capture: e.capture,
            secrets: typeof e.secrets === "string" && e.secrets.length > 0 ? e.secrets : undefined,
            description: typeof e.description === "string" ? e.description : undefined,
        });
    }
    return { description: typeof obj.description === "string" ? obj.description : undefined, paths };
}

function resolveAgainst(url: string, base: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    try {
        return new URL(url, absoluteURL(base)).href;
    } catch {
        return url;
    }
}

/**
 * Security FIX (qvis had no limit): one shared `?list=` / `?file1..N=` link must not make every visitor's browser
 * fetch an unbounded number of captures at once (each failing one also costs a proxy call). Lists longer than
 * MAX_LIST_CAPTURES are rejected; at most LIST_CONCURRENCY captures are fetched at the same time.
 */
export const MAX_LIST_CAPTURES = 100;
export const LIST_CONCURRENCY = 6;

/** `Promise.allSettled(items.map(fn))` with at most `limit` calls of `fn` running at once; results in input order. */
export async function settleLimited<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const out: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const i = next++;
            try {
                out[i] = { status: "fulfilled", value: await fn(items[i]) };
            } catch (reason) {
                out[i] = { status: "rejected", reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return out;
}

/**
 * Loads every capture (at most LIST_CONCURRENCY in parallel) and merges them into one contained qlog, in list order.
 * Failed captures become TraceErrors `{error_description, uri}`; if every capture failed, the first failure is
 * thrown. Per-capture description (D12): set on each trace when the list entry defines one.
 */
export async function mergeCaptures(
    paths: ListEntry[],
    description: string | undefined,
    deps: Pick<LoaderDeps, "fetch"> = {},
): Promise<LoadedQlog> {
    if (paths.length === 0) throw new Error("The list does not contain any files to load");
    if (paths.length > MAX_LIST_CAPTURES) {
        throw new Error(
            "The list contains " +
                paths.length +
                " files; qvis loads at most " +
                MAX_LIST_CAPTURES +
                " files from one list",
        );
    }
    const results = await settleLimited(paths, LIST_CONCURRENCY, (p) => loadSingleRemote(p.capture, p.secrets, deps));
    const traces: unknown[] = [];
    const diagnostics: LoadedQlog["diagnostics"] = [];
    let firstFailure: unknown;
    let successes = 0;
    results.forEach((r, i) => {
        const p = paths[i];
        if (r.status === "fulfilled") {
            successes++;
            diagnostics.push(...r.value.diagnostics);
            for (const t of tracesOf(r.value)) {
                if (p.description !== undefined && t !== null && typeof t === "object" && !isTraceError(t)) {
                    traces.push({ ...(t as Record<string, unknown>), description: p.description });
                } else {
                    traces.push(t);
                }
            }
        } else {
            console.error("ConnectionStore:LoadFilesFromServer : could not load list entry", p.capture, r.reason);
            if (firstFailure === undefined) firstFailure = r.reason;
            traces.push({ error_description: errorMessage(r.reason), uri: p.capture });
        }
    });
    if (successes === 0) throw firstFailure;
    const root: Record<string, unknown> = { file_schema: CONTAINED_SCHEMA, serialization_format: CONTAINED_FORMAT };
    if (description !== undefined) root.description = description;
    root.traces = traces;
    return { root, serialization: "json", diagnostics };
}

/** `?list=`: a pcap2qlog list file, or (PARITY) a URL that actually points at a qlog / netlog file. */
export async function loadList(listURL: string, deps: Pick<LoaderDeps, "fetch"> = {}): Promise<LoadedQlog> {
    const blob = await fetchRemote(listURL, deps.fetch);
    // only a small JSON object with `paths` can be a list: skip the extra JSON.parse for (possibly huge or compressed)
    // qlog files, which go through the regular loader as bytes (gzip detection, streaming JSON-SEQ)
    const text = await blob.text();
    const list = text.includes('"paths"') ? parseListFile(text) : undefined;
    if (list === undefined) return loadQlogFile(blob, listURL, { isURL: true });
    const paths = list.paths.map((p) => ({
        ...p,
        capture: resolveAgainst(p.capture, listURL),
        secrets: p.secrets !== undefined ? resolveAgainst(p.secrets, listURL) : undefined,
    }));
    return mergeCaptures(paths, list.description, deps);
}

/** `?file1=..&secrets1=..&desc1=..&file2=..`: enumeration stops at the first missing index (server parity). */
export function multiEntries(q: Query): ListEntry[] {
    const out: ListEntry[] = [];
    // one past the cap is enough for mergeCaptures to reject the link
    for (let i = 1; i <= MAX_LIST_CAPTURES + 1; i++) {
        const capture = firstValue(q["file" + i])?.trim();
        if (!capture) break;
        out.push({
            capture,
            secrets: firstValue(q["secrets" + i]) || undefined,
            description: firstValue(q["desc" + i]) ?? undefined,
        });
    }
    return out;
}

export async function loadMulti(q: Query, deps: Pick<LoaderDeps, "fetch"> = {}): Promise<LoadedQlog> {
    const description = firstValue(q.desc) || "Generated " + new Date().toLocaleString();
    return mergeCaptures(multiEntries(q), description, deps);
}

/**
 * qvis `ConnectionStore.loadFilesFromServer(query)` (startup query on any route, and Option 1).
 * Toasts: N10 at start, N11 on success (+ X5 when some traces failed), X1/X2/X6/N12(+X7) on failure.
 * The outstanding request counter is always balanced (FIX Q7).
 */
export async function loadFromQueryParameters(q: Query, deps: LoaderDeps): Promise<void> {
    console.log("ConnectionStore:LoadFilesFromServer ", q);
    if (Object.keys(q).length === 0) return;
    const pick = pickQuery(q);
    if (pick === undefined) return;

    deps.notify(N10_urlLoadStart(pick.urlToLoad));
    deps.adjustOutstanding(+1);
    try {
        let loaded: LoadedQlog;
        if (pick.mode === "file") loaded = await loadSingleRemote(pick.urlToLoad, pickSecrets(q), deps);
        else if (pick.mode === "list") loaded = await loadList(pick.urlToLoad, deps);
        else loaded = await loadMulti(q, deps);

        const fileInfo = buildFileInfo(pick.urlToLoad, pick.fullURL);
        const group = deps.addGroupFromQlogFile(loaded, fileInfo, N11_urlLoadDone(pick.urlToLoad));
        if (group !== undefined) {
            const failed = traceErrorSummary(loaded);
            if (failed !== undefined) deps.notify(X5_someTracesFailed(failed.failed, failed.total, failed.first));
        }
    } catch (e) {
        console.error("ConnectionStore:LoadFilesFromServer : ERROR : trace not added to qvis! : ", e, q);
        deps.notify(urlErrorNotification(e, pick.urlToLoad));
    } finally {
        deps.adjustOutstanding(-1);
    }
}

function pickSecrets(q: Query): string | undefined {
    const s = firstValue(q.secrets)?.trim();
    return s ? s : undefined;
}
