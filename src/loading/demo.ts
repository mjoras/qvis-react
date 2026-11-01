// Demo loading (file-loading spec §3.9, §8.7): Option 3 (example files from public/examples/index.json) and
// Option 4 (massive demo from public/examples/massive/index.json), plus qvis `loadQlogDirectlyFromURL`.
//
// Manifest shape (written by the demo-generation workflow): an array of {file, title?, description?, size?}
// (also accepted: {files|examples|demos: [...]}). `file` is relative to the manifest's folder; `size` in bytes
// (or a ready-made label such as "<1MB").

import type { LoadedQlog } from "@/qlog/parse";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { errorMessage } from "./errors";
import { loadQlogFile } from "./fileLoader";
import type { LoadNotification } from "./messages";
import {
    loadErrorNotification,
    N13_directLoadStart,
    N14_directLoadDone,
    N15_directLoadFailed,
    N7_examplesAlreadyLoaded,
    N8_massiveAlreadyLoaded,
} from "./messages";
import type { FetchLike } from "./remote";
import type { FileInfo } from "./shorten";

export interface DemoEntry {
    file: string;
    title?: string;
    description?: string;
    size?: number | string;
}

export interface DemoDeps {
    notify(n: LoadNotification): void;
    addGroupFromQlogFile(
        loaded: LoadedQlog,
        fileInfo: FileInfo,
        success?: LoadNotification,
    ): QlogConnectionGroup | undefined;
    adjustOutstanding(delta: number): void;
    getGroups(): readonly QlogConnectionGroup[];
    fetch?: FetchLike;
}

export const DEMO_PREFIX = "DEMO_";
export const MASSIVE_PREFIX = "MASSIVE_DEMO_";
/** qvis verbatim label, used until the massive manifest says otherwise (D13). */
export const DEFAULT_MASSIVE_BUTTON_LABEL = "Load 31MB .qlog file";

/** URL of a file under public/examples/, relative to the app base (Vite `base: "./"`, like qvis `baseUrl: './'`). */
export function examplesURL(path: string): string {
    const base = import.meta.env.BASE_URL || "./";
    const prefix = base === "./" ? "" : base.endsWith("/") ? base : base + "/";
    return prefix + "examples/" + path.replace(/^\/+/, "");
}

/** URL of a manifest entry; `file` is relative to the manifest's folder (a redundant folder prefix is tolerated). */
export function entryURL(folder: "" | "massive/", file: string): string {
    let f = file.replace(/^\.?\/+/, "").replace(/^examples\//, "");
    if (folder !== "" && f.startsWith(folder)) f = f.slice(folder.length);
    return examplesURL(folder + f);
}

export const DEMO_INDEX_PATH = "index.json";
export const MASSIVE_INDEX_PATH = "massive/index.json";

function defaultFetch(): FetchLike {
    return (input, init) => fetch(input, init);
}

export function parseManifest(json: unknown): DemoEntry[] {
    let list: unknown = json;
    if (list !== null && typeof list === "object" && !Array.isArray(list)) {
        const o = list as Record<string, unknown>;
        list = o.files ?? o.examples ?? o.demos;
    }
    if (!Array.isArray(list)) throw new Error("Demo index is not a list of files");
    const out: DemoEntry[] = [];
    for (const item of list) {
        if (item === null || typeof item !== "object") continue;
        const e = item as Record<string, unknown>;
        if (typeof e.file !== "string" || e.file.length === 0) continue;
        out.push({
            file: e.file,
            title: typeof e.title === "string" ? e.title : undefined,
            description: typeof e.description === "string" ? e.description : undefined,
            size: typeof e.size === "number" || typeof e.size === "string" ? e.size : undefined,
        });
    }
    return out;
}

export async function fetchManifest(path: string, fetchImpl: FetchLike = defaultFetch()): Promise<DemoEntry[]> {
    const res = await fetchImpl(examplesURL(path), { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return parseManifest(JSON.parse(await res.text()));
}

const MiB = 1024 * 1024;

/** "(<1MB)" / "(3.1MB)" / "(31MB)" style size annotation (qvis demo filenames). */
export function sizeLabel(size: number | string | undefined): string | undefined {
    if (size === undefined) return undefined;
    if (typeof size === "string") {
        const s = size.trim().replace(/^\(|\)$/g, "");
        return s.length > 0 ? s : undefined;
    }
    if (!Number.isFinite(size) || size < 0) return undefined;
    if (size < MiB) return "<1MB";
    const mb = size / MiB;
    return (mb >= 10 ? Math.round(mb).toString() : mb.toFixed(1)) + "MB";
}

function basename(path: string): string {
    const clean = path.split(/[?#]/)[0];
    return clean.slice(clean.lastIndexOf("/") + 1);
}

/** `DEMO_new_cid.qlog (<1MB)` convention (qvis verbatim style). */
export function demoFilename(entry: DemoEntry, prefix = DEMO_PREFIX): string {
    const base = basename(entry.file);
    const name = base.startsWith(prefix) ? base : prefix + base;
    const label = sizeLabel(entry.size);
    return label !== undefined ? name + " (" + label + ")" : name;
}

/** "Load 31MB .qlog file" derived from the massive manifest entry (D13), qvis text as fallback. */
export function massiveButtonLabel(entry: DemoEntry | undefined): string {
    if (entry === undefined) return DEFAULT_MASSIVE_BUTTON_LABEL;
    const label = sizeLabel(entry.size);
    const ext = /\.sqlog(\.|$)/i.test(entry.file) ? ".sqlog" : ".qlog";
    return label !== undefined ? "Load " + label + " " + ext + " file" : "Load massive " + ext + " file";
}

/** qvis's Option 4 help text says "representing a 100MB download" (its mvfst demo). */
export const DEFAULT_MASSIVE_DOWNLOAD_SIZE = "100MB";

/**
 * D13 for the Option 4 help text: the transfer size of the generated massive demo, read from its manifest title or
 * description ("Massive trace: 50 MB download" -> "50MB"); qvis's "100MB" when neither names one.
 */
export function massiveDownloadSize(entry: DemoEntry | undefined): string {
    for (const text of [entry?.title, entry?.description]) {
        const m = typeof text === "string" ? /(\d+(?:\.\d+)?)\s*([KMG]B)\s+(?:HTTP\/3\s+)?download/i.exec(text) : null;
        if (m !== null) return m[1] + m[2].toUpperCase();
    }
    return DEFAULT_MASSIVE_DOWNLOAD_SIZE;
}

/** `MASSIVE_DEMO_mvfst_large.qlog (31MB)` -> `MASSIVE_DEMO_mvfst_large` (the name quoted in N8). */
export function massiveCalledName(filename: string): string {
    const name = filename.split(" (")[0];
    return name.replace(/\.(qlog|sqlog|json)(\.(gz|gzip|br|brotli))?$/i, "");
}

/** qvis `loadExamples()` dedupe: any group whose filename starts with "DEMO" (Q20, PRESERVE). */
export function examplesAlreadyLoaded(groups: readonly QlogConnectionGroup[]): boolean {
    return groups.some((g) => g.filename.indexOf("DEMO") === 0);
}

export function loadedMassiveDemo(groups: readonly QlogConnectionGroup[]): QlogConnectionGroup | undefined {
    return groups.find((g) => g.filename.indexOf(MASSIVE_PREFIX) >= 0);
}

/**
 * qvis `loadQlogDirectlyFromURL({url, filename})` with FIX Q5 (toast N15 on any failure, counter balanced) and
 * `.sqlog` support (uses the regular file loader).
 */
export async function loadQlogDirectlyFromURL(
    { url, filename }: { url: string; filename: string },
    deps: Omit<DemoDeps, "getGroups">,
): Promise<QlogConnectionGroup | undefined> {
    deps.notify(N13_directLoadStart(filename, url));
    deps.adjustOutstanding(+1);
    try {
        const res = await (deps.fetch ?? defaultFetch())(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const loaded = await loadQlogFile(await res.blob(), url, { isURL: true });
        return deps.addGroupFromQlogFile(loaded, { filename }, N14_directLoadDone(filename));
    } catch (e) {
        console.error("FileManagerContainer:loadDirectlyFromURL: error downloading file : ", url, e);
        deps.notify(loadErrorNotification(e, filename, (detail) => N15_directLoadFailed(filename, url, detail)));
        return undefined;
    } finally {
        deps.adjustOutstanding(-1);
    }
}

let examplesInFlight = false;
let massiveInFlight = false;

export function isExamplesLoadInFlight(): boolean {
    return examplesInFlight;
}

export function isMassiveLoadInFlight(): boolean {
    return massiveInFlight;
}

/** test helper */
export function resetDemoState(): void {
    examplesInFlight = false;
    massiveInFlight = false;
    massiveManifestPromise = undefined;
}

async function withManifest(
    path: string,
    deps: DemoDeps,
    start: (entries: DemoEntry[]) => Promise<unknown>[],
): Promise<void> {
    const indexURL = examplesURL(path);
    deps.adjustOutstanding(+1);
    let loads: Promise<unknown>[] = [];
    try {
        const entries = await fetchManifest(path, deps.fetch);
        if (entries.length === 0) throw new Error("Demo index lists no files");
        loads = start(entries); // each load increments the counter synchronously before ours is released
    } catch (e) {
        console.error("FileManagerContainer:loadExamples : could not load the demo index", indexURL, e);
        deps.notify(N15_directLoadFailed(indexURL, indexURL, errorMessage(e)));
    } finally {
        deps.adjustOutstanding(-1);
    }
    await Promise.allSettled(loads);
}

/**
 * Option 3. qvis fired 5 parallel loads; we fire one per manifest entry. Groups appear in completion order (Q21).
 * Guarded against double clicks while in flight (FIX) and against already loaded demos (N7, PARITY).
 */
export async function loadExamplesForDemo(deps: DemoDeps): Promise<void> {
    if (examplesInFlight || examplesAlreadyLoaded(deps.getGroups())) {
        deps.notify(N7_examplesAlreadyLoaded());
        return;
    }
    examplesInFlight = true;
    try {
        await withManifest(DEMO_INDEX_PATH, deps, (entries) =>
            entries.map((entry) =>
                loadQlogDirectlyFromURL({ url: entryURL("", entry.file), filename: demoFilename(entry) }, deps),
            ),
        );
    } finally {
        examplesInFlight = false;
    }
}

let massiveManifestPromise: Promise<DemoEntry | undefined> | undefined;

/** First entry of examples/massive/index.json (cached; undefined if there is none). Used for the button label. */
export function getMassiveDemoEntry(fetchImpl?: FetchLike): Promise<DemoEntry | undefined> {
    if (massiveManifestPromise === undefined) {
        massiveManifestPromise = fetchManifest(MASSIVE_INDEX_PATH, fetchImpl)
            .then((entries) => entries[0])
            .catch(() => {
                massiveManifestPromise = undefined; // retry on the next request
                return undefined;
            });
    }
    return massiveManifestPromise;
}

/** Option 4 (qvis `loadMassiveExample()`): N8 if already loaded (or in flight), else load the single massive file. */
export async function loadMassiveDemo(deps: DemoDeps): Promise<void> {
    const existing = loadedMassiveDemo(deps.getGroups());
    if (existing !== undefined || massiveInFlight) {
        deps.notify(N8_massiveAlreadyLoaded(existing !== undefined ? massiveCalledName(existing.filename) : undefined));
        return;
    }
    massiveInFlight = true;
    try {
        await withManifest(MASSIVE_INDEX_PATH, deps, (entries) => {
            const entry = entries[0];
            return [
                loadQlogDirectlyFromURL(
                    { url: entryURL("massive/", entry.file), filename: demoFilename(entry, MASSIVE_PREFIX) },
                    deps,
                ),
            ];
        });
    } finally {
        massiveInFlight = false;
    }
}
