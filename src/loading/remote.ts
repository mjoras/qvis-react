// Network access for URL loads: direct CORS fetch first, then our Vercel CORS proxy (`/api/loadfiles?file=`),
// plus the optional qvis-server compatible pcap backend (file-loading spec §3.8, §8.3, §8.6, ARCHITECTURE §0).

import { ProxyError } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const env = import.meta.env as Record<string, string | undefined>;

/** Same-origin Vercel Function (api/loadfiles.ts). Overridable for other hosting setups. */
export const PROXY_ENDPOINT: string = env.VITE_QVIS_PROXY_URL || "/api/loadfiles";

/** Optional qvis-server compatible backend for .pcap/.pcapng (+ .keys); unset means "pcap unsupported" (D1). */
export function pcapBackendURL(): string | undefined {
    const v = env.VITE_PCAP_BACKEND_URL;
    return v && v.trim().length > 0 ? v.trim().replace(/\/+$/, "") : undefined;
}

/** Header set by api/loadfiles.ts on every proxied response; its absence means the proxy is not deployed. */
export const UPSTREAM_STATUS_HEADER = "X-Qvis-Upstream-Status";

export function absoluteURL(url: string): string {
    try {
        const base = typeof document !== "undefined" ? document.baseURI : undefined;
        return new URL(url, base).href;
    } catch {
        return url;
    }
}

function defaultFetch(): FetchLike {
    return (input, init) => fetch(input, init);
}

/** Direct browser download. Throws a TypeError (network / CORS) or an Error("HTTP <status>"). */
export async function fetchDirect(url: string, fetchImpl: FetchLike = defaultFetch()): Promise<Blob> {
    const res = await fetchImpl(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.blob();
}

async function readProxyError(res: Response): Promise<string | undefined> {
    try {
        const text = await res.text();
        const json = JSON.parse(text) as { error?: unknown };
        return typeof json.error === "string" ? json.error : undefined;
    } catch {
        return undefined;
    }
}

/** Download through the qvis CORS proxy. Non-OK responses carry `{"error": string}` (ProxyError, toast X7). */
export async function fetchViaProxy(
    url: string,
    fetchImpl: FetchLike = defaultFetch(),
    directReason?: string,
): Promise<Blob> {
    const proxyURL = PROXY_ENDPOINT + "?file=" + encodeURIComponent(absoluteURL(url));
    const res = await fetchImpl(proxyURL, { credentials: "omit" });
    const fromProxy = res.headers.has(UPSTREAM_STATUS_HEADER);
    if (!res.ok) {
        const error = await readProxyError(res);
        if (error !== undefined) throw new ProxyError(error, res.status);
        throw new ProxyError(proxyUnavailableMessage(directReason, "HTTP " + res.status), res.status);
    }
    if (!fromProxy) {
        // e.g. the Vite dev server or a static host answering /api/loadfiles with index.html
        throw new ProxyError(proxyUnavailableMessage(directReason), res.status);
    }
    return res.blob();
}

function proxyUnavailableMessage(directReason?: string, proxyStatus?: string): string {
    return (
        "The file could not be downloaded directly" +
        (directReason ? " (" + directReason + ")" : "") +
        " and the qvis CORS proxy is not available" +
        (proxyStatus ? " (" + proxyStatus + ")" : "") +
        "."
    );
}

/**
 * Direct fetch first; on any network/CORS failure or non-OK status retry through the proxy (qvis
 * loadFilesFromServer STEP 1/2). Content errors are not handled here: once bytes arrived, the proxy would return
 * the same bytes, so callers treat loader errors on these bytes as final.
 */
export async function fetchRemote(url: string, fetchImpl: FetchLike = defaultFetch()): Promise<Blob> {
    let directReason: string;
    try {
        return await fetchDirect(url, fetchImpl);
    } catch (e) {
        directReason = e instanceof Error ? e.message : String(e);
        console.warn(
            "ConnectionStore:LoadFilesFromServer : tried to load qlog from remote server directly but got probable CORS error. Trying again via backend server.",
            url,
            e,
        );
    }
    return fetchViaProxy(url, fetchImpl, directReason);
}

/**
 * Optional pcap backend (D1 option b): GET `${base}/loadfiles?file=...&secrets=...`, unwrap the pcap2qlog
 * `{qlog, debug_list}` envelope and return the qlog as JSON text (it then goes through the normal loader, so a
 * legacy `qlog_version` result is rejected with X1).
 */
export async function fetchFromPcapBackend(
    base: string,
    url: string,
    secrets: string | undefined,
    fetchImpl: FetchLike = defaultFetch(),
): Promise<string> {
    let endpoint = base + "/loadfiles?file=" + encodeURIComponent(url);
    if (secrets) endpoint += "&secrets=" + encodeURIComponent(secrets);
    const res = await fetchImpl(endpoint, { credentials: "omit" });
    if (!res.ok) {
        const error = await readProxyError(res);
        throw new ProxyError(error ?? "pcap backend returned HTTP " + res.status, res.status);
    }
    const body = (await res.json()) as unknown;
    if (body !== null && typeof body === "object") {
        const env = body as { error?: unknown; qlog?: unknown };
        if (typeof env.error === "string") throw new ProxyError(env.error, res.status);
        const root = env.qlog !== undefined ? env.qlog : body;
        return typeof root === "string" ? root : JSON.stringify(root);
    }
    throw new ProxyError("pcap backend returned an unexpected response", res.status);
}
