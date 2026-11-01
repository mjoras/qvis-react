import type { LoadedQlog } from "@/qlog/parse";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import type { LoadNotification } from "./messages";
import { PROXY_ENDPOINT, type FetchLike } from "./remote";
import {
    LIST_CONCURRENCY,
    loadFromQueryParameters,
    MAX_LIST_CAPTURES,
    multiEntries,
    parseListFile,
    pickQuery,
    settleLimited,
    type LoaderDeps,
    type Query,
} from "./urlLoader";

const CONTAINED = (title: string, traces: unknown[] = [TRACE]) =>
    JSON.stringify({
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        title,
        traces,
    });
const TRACE = {
    title: "conn",
    vantage_point: { type: "client" },
    events: [{ time: 0, name: "quic:packet_sent", data: {} }],
};
const LEGACY = JSON.stringify({ qlog_version: "draft-02", traces: [{ events: [] }] });

type Handler = Response | "network-error" | ((init?: RequestInit) => Response);

function proxyKey(url: string): string {
    return PROXY_ENDPOINT + "?file=" + encodeURIComponent(new URL(url, document.baseURI).href);
}

function proxied(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "X-Qvis-Upstream-Status": String(status) } });
}

function proxyError(error: string, status = 502): Response {
    return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(routes: Record<string, Handler>): FetchLike & { calls: string[] } {
    const calls: string[] = [];
    const f = (async (input: string, init?: RequestInit) => {
        calls.push(input);
        const h = routes[input];
        if (h === undefined) return new Response("not found", { status: 404 });
        if (h === "network-error") throw new TypeError("Failed to fetch");
        return typeof h === "function" ? h(init) : h.clone();
    }) as FetchLike & { calls: string[] };
    f.calls = calls;
    return f;
}

interface Harness {
    deps: LoaderDeps;
    toasts: LoadNotification[];
    added: Array<{
        loaded: LoadedQlog;
        fileInfo: { filename: string; URL?: string; URLshort?: string };
        success?: LoadNotification;
    }>;
    outstanding(): number;
    minOutstanding(): number;
}

function harness(fetchImpl: FetchLike, accept = true): Harness {
    const toasts: LoadNotification[] = [];
    const added: Harness["added"] = [];
    let outstanding = 0;
    let min = 0;
    const deps: LoaderDeps = {
        notify: (n) => toasts.push(n),
        addGroupFromQlogFile: (loaded, fileInfo, success) => {
            added.push({ loaded, fileInfo, success });
            if (!accept) return undefined;
            if (success) toasts.push(success);
            return { filename: fileInfo.filename } as unknown as QlogConnectionGroup;
        },
        adjustOutstanding: (d) => {
            outstanding += d;
            min = Math.min(min, outstanding);
        },
        fetch: fetchImpl,
    };
    return { deps, toasts, added, outstanding: () => outstanding, minOutstanding: () => min };
}

const titles = (h: Harness) => h.toasts.map((t) => t.title);

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function run(q: Query, h: Harness) {
    await loadFromQueryParameters(q, h.deps);
    expect(h.outstanding()).toBe(0); // FIX Q7: balanced in every path
    expect(h.minOutstanding()).toBeGreaterThanOrEqual(0);
}

describe("pickQuery", () => {
    it("file > list > file1; arrays take the first value; null counts as absent", () => {
        expect(pickQuery({ file: "a.qlog", list: "l.json", file1: "x" })).toEqual({
            mode: "file",
            urlToLoad: "a.qlog",
            fullURL: "a.qlog",
        });
        expect(pickQuery({ list: "l.json", file1: "x" })).toEqual({ mode: "list", urlToLoad: "l.json" });
        expect(pickQuery({ file1: "x.qlog", file2: "y.qlog" })).toEqual({ mode: "multi", urlToLoad: "x.qlog etc." });
        expect(pickQuery({ file: ["a.qlog", "b.qlog"] })?.urlToLoad).toBe("a.qlog");
        expect(pickQuery({ file: null, focusOnEvent: "3" })).toBeUndefined();
    });
});

describe("parseListFile", () => {
    it("accepts the pcap2qlog list format and rejects qlog files", () => {
        expect(
            parseListFile('{"description":"d","paths":[{"capture":"a.qlog","description":"x"},{"nope":1}]}'),
        ).toEqual({
            description: "d",
            paths: [{ capture: "a.qlog", secrets: undefined, description: "x" }],
        });
        expect(parseListFile(CONTAINED("t"))).toBeUndefined();
        expect(parseListFile("[1,2]")).toBeUndefined();
        expect(parseListFile("{ broken")).toBeUndefined();
    });
});

describe("loadFromQueryParameters", () => {
    const URL1 = "https://remote.example/logs/trace.qlog";

    it("does nothing for an empty query or only unrelated keys", async () => {
        const f = mockFetch({});
        const h = harness(f);
        await run({}, h);
        await run({ focusOnConnection: "0", focusOnEvent: "12" }, h);
        expect(h.toasts).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    it("direct download OK: N10, group with URL link, N11", async () => {
        const f = mockFetch({ [URL1]: new Response(CONTAINED("direct")) });
        const h = harness(f);
        await run({ file: URL1, focusOnEvent: "3" }, h);
        expect(f.calls).toEqual([URL1]);
        expect(titles(h)).toEqual(["Loading file(s) via URL", "Loaded files via URL"]);
        expect(h.toasts[0].text).toBe(
            "Loading files via URL " +
                URL1 +
                ".<br/>The backend server downloads the files, possibly transforms them into qlog, then sends them back. This can take a while.",
        );
        expect(h.added).toHaveLength(1);
        expect(h.added[0].fileInfo).toEqual({ filename: "Loaded via URL (" + URL1 + ")", URL: URL1, URLshort: URL1 });
        expect(h.added[0].loaded.root.title).toBe("direct");
    });

    it("direct CORS failure, then the proxy", async () => {
        const f = mockFetch({ [URL1]: "network-error", [proxyKey(URL1)]: proxied(CONTAINED("via proxy")) });
        const h = harness(f);
        await run({ file: URL1 }, h);
        expect(f.calls).toEqual([URL1, proxyKey(URL1)]);
        expect(h.added[0].loaded.root.title).toBe("via proxy");
        expect(titles(h)).toContain("Loaded files via URL");
    });

    it("proxy {error} gives N12 plus the server error (X7)", async () => {
        const f = mockFetch({
            [URL1]: "network-error",
            [proxyKey(URL1)]: proxyError("Upstream returned HTTP 404"),
        });
        const h = harness(f);
        await run({ file: URL1 }, h);
        const err = h.toasts[h.toasts.length - 1];
        expect(err.title).toBe("ERROR loading URL " + URL1);
        expect(err.type).toBe("error");
        expect(err.duration).toBe(6000);
        expect(err.text).toBe(
            "File(s) could not be loaded from " +
                URL1 +
                ".<br/>View the devtools JavaScript console for more information.<br/>Upstream returned HTTP 404",
        );
        expect(h.added).toHaveLength(0);
    });

    it("remote 404: direct non-OK falls through to the proxy (qvis parity)", async () => {
        const f = mockFetch({
            [URL1]: new Response("nope", { status: 404 }),
            [proxyKey(URL1)]: proxyError("Upstream returned HTTP 404"),
        });
        const h = harness(f);
        await run({ file: URL1 }, h);
        expect(f.calls).toEqual([URL1, proxyKey(URL1)]);
        expect(h.toasts[h.toasts.length - 1].text).toMatch(/Upstream returned HTTP 404$/);
    });

    it("proxy not deployed (index.html fallback) gives a clear message", async () => {
        const f = mockFetch({
            [URL1]: "network-error",
            [proxyKey(URL1)]: new Response("<!doctype html><html></html>", {
                headers: { "Content-Type": "text/html" },
            }),
        });
        const h = harness(f);
        await run({ file: URL1 }, h);
        expect(h.toasts[h.toasts.length - 1].text).toMatch(
            /could not be downloaded directly \(Failed to fetch\) and the qvis CORS proxy is not available\.$/,
        );
    });

    it("dev server without the proxy (Vite answers /api/loadfiles with a 500 page): N12 names both failures", async () => {
        // what `npx vite` does: api/loadfiles.ts is not a Vercel Function there, the request fails with an HTML error
        const vite500 = () =>
            new Response("<!DOCTYPE html><title>Error</title>", {
                status: 500,
                headers: { "Content-Type": "text/html" },
            });
        for (const [direct, reason] of [
            ["network-error", "Failed to fetch"],
            [new Response("nope", { status: 404 }), "HTTP 404"],
        ] as const) {
            const f = mockFetch({ [URL1]: direct, [proxyKey(URL1)]: vite500 });
            const h = harness(f);
            await run({ file: URL1 }, h);
            expect(f.calls).toEqual([URL1, proxyKey(URL1)]);
            expect(titles(h)).toEqual(["Loading file(s) via URL", "ERROR loading URL " + URL1]);
            const err = h.toasts[1];
            expect(err.type).toBe("error");
            expect(err.duration).toBe(6000);
            expect(err.text).toBe(
                "File(s) could not be loaded from " +
                    URL1 +
                    ".<br/>View the devtools JavaScript console for more information.<br/>" +
                    "The file could not be downloaded directly (" +
                    reason +
                    ") and the qvis CORS proxy is not available (HTTP 500).",
            );
            expect(h.added).toHaveLength(0);
        }
    });

    it("a legacy file is final: no proxy retry, toast X1", async () => {
        const f = mockFetch({ [URL1]: new Response(LEGACY) });
        const h = harness(f);
        await run({ file: URL1 }, h);
        expect(f.calls).toEqual([URL1]);
        const last = h.toasts[h.toasts.length - 1];
        expect(last.title).toBe("Unsupported qlog version in " + URL1);
        expect(last.duration).toBe(10000);
        expect(last.text).toMatch(
            /^This file uses qlog_version "draft-02"\. qvis only supports the latest qlog drafts/,
        );
    });

    it("pcap without a backend: X6, nothing fetched", async () => {
        const f = mockFetch({});
        const h = harness(f);
        await run({ file: "https://remote.example/x.pcap", secrets: "https://remote.example/x.keys" }, h);
        expect(f.calls).toEqual([]);
        expect(h.toasts.map((t) => t.title)).toEqual(["Loading file(s) via URL", "Packet captures not supported"]);
    });

    it("list with mixed success keeps the good traces and warns (X5)", async () => {
        const LIST = "https://remote.example/list.json";
        const list = {
            description: "my list",
            paths: [
                { capture: "https://remote.example/a.qlog", description: "first capture" },
                { capture: "https://remote.example/missing.qlog" },
                { capture: "https://remote.example/c.pcap", secrets: "https://remote.example/c.keys" },
            ],
        };
        const f = mockFetch({
            [LIST]: new Response(JSON.stringify(list)),
            "https://remote.example/a.qlog": new Response(CONTAINED("a")),
            "https://remote.example/missing.qlog": new Response("", { status: 404 }),
            [proxyKey("https://remote.example/missing.qlog")]: proxyError("Upstream returned HTTP 404"),
        });
        const h = harness(f);
        await run({ list: LIST }, h);
        expect(h.added).toHaveLength(1);
        const root = h.added[0].loaded.root;
        expect(root.file_schema).toBe("urn:ietf:params:qlog:file:contained");
        expect(root.description).toBe("my list");
        const traces = root.traces as Array<Record<string, unknown>>;
        expect(traces).toHaveLength(3);
        expect(traces[0].description).toBe("first capture");
        expect(traces[0].title).toBe("conn");
        expect(traces[1]).toEqual({
            error_description: "Upstream returned HTTP 404",
            uri: "https://remote.example/missing.qlog",
        });
        expect(traces[2].uri).toBe("https://remote.example/c.pcap");
        expect(h.added[0].fileInfo).toEqual({ filename: "Loaded via URL (" + LIST + ")" });
        expect(titles(h)).toEqual([
            "Loading file(s) via URL",
            "Loaded files via URL",
            "Some files could not be loaded",
        ]);
        expect(h.toasts[2].text).toBe("2 of 3 traces failed: Upstream returned HTTP 404");
    });

    it("list where every capture fails gives N12 with the first error", async () => {
        const LIST = "https://remote.example/list.json";
        const f = mockFetch({
            [LIST]: new Response(JSON.stringify({ paths: [{ capture: "https://remote.example/x.pcapng" }] })),
        });
        const h = harness(f);
        await run({ list: LIST }, h);
        expect(h.added).toHaveLength(0);
        expect(titles(h)).toEqual(["Loading file(s) via URL", "Packet captures not supported"]);
    });

    it("?list= pointing at a qlog file loads it as qlog (PARITY)", async () => {
        const LIST = "https://remote.example/qlog.json";
        const f = mockFetch({ [LIST]: new Response(CONTAINED("json qlog")) });
        const h = harness(f);
        await run({ list: LIST }, h);
        expect(h.added[0].loaded.root.title).toBe("json qlog");
    });

    it("?list= pointing at a gzip-compressed qlog (no Content-Encoding) is decompressed like ?file=", async () => {
        const { gzipSync } = await import("node:zlib");
        const LIST = "https://remote.example/qlog.json";
        const gz = new Uint8Array(gzipSync(Buffer.from(CONTAINED("gz qlog"))));
        const f = mockFetch({ [LIST]: new Response(gz) });
        const h = harness(f);
        await run({ list: LIST }, h);
        expect(h.added[0].loaded.root.title).toBe("gz qlog");
    });

    it("file1..N: one merged group named 'Loaded via URL (file1 etc.)' without URL", async () => {
        const f = mockFetch({
            "https://remote.example/a.qlog": new Response(CONTAINED("a")),
            "https://remote.example/b.qlog": new Response(CONTAINED("b")),
            "https://remote.example/c.qlog": new Response(CONTAINED("c")),
        });
        const h = harness(f);
        await run(
            {
                file1: "https://remote.example/a.qlog",
                desc1: "A",
                file2: "https://remote.example/b.qlog",
                file4: "https://remote.example/c.qlog", // enumeration stops at the missing file3
            },
            h,
        );
        expect(h.added).toHaveLength(1);
        expect(h.added[0].fileInfo).toEqual({ filename: "Loaded via URL (https://remote.example/a.qlog etc.)" });
        const root = h.added[0].loaded.root;
        expect((root.traces as unknown[]).length).toBe(2);
        expect(String(root.description)).toMatch(/^Generated /);
        expect((root.traces as Array<Record<string, unknown>>)[0].description).toBe("A");
        expect(h.toasts[0].text).toMatch(/^Loading files via URL https:\/\/remote\.example\/a\.qlog etc\./);
    });

    it("relative ?file= paths use the direct same-origin fetch", async () => {
        const f = mockFetch({ "examples/x.qlog": new Response(CONTAINED("rel")) });
        const h = harness(f);
        await run({ file: "examples/x.qlog" }, h);
        expect(h.added[0].fileInfo.URL).toBe("examples/x.qlog");
    });

    it("model rejection (N9 shown by the store): no X5, counter balanced", async () => {
        const f = mockFetch({ [URL1]: new Response(CONTAINED("x")) });
        const h = harness(f, false);
        await run({ file: URL1 }, h);
        expect(titles(h)).toEqual(["Loading file(s) via URL"]);
    });

    it("a thrown fetch implementation still balances the counter", async () => {
        const h = harness((() => {
            throw new Error("boom");
        }) as unknown as FetchLike);
        await run({ file: URL1 }, h);
        expect(h.toasts[h.toasts.length - 1].title).toBe("ERROR loading URL " + URL1);
    });
});

describe("?list= / ?fileN= amplification limits (security FIX)", () => {
    const LIST = "https://remote.example/list.json";
    const capture = (i: number) => "https://remote.example/c" + i + ".qlog";
    const listOf = (n: number) =>
        JSON.stringify({ paths: Array.from({ length: n }, (_, i) => ({ capture: capture(i) })) });

    /** fetch that resolves each capture only after a tick and records the peak number of captures in flight */
    function countingFetch(): FetchLike & { peak(): number; captures(): number } {
        let inFlight = 0;
        let peak = 0;
        let captures = 0;
        const f = (async (input: string) => {
            if (input === LIST) return new Response(listOf(currentListSize));
            captures++;
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight--;
            return new Response(CONTAINED("t" + input));
        }) as FetchLike & { peak(): number; captures(): number };
        f.peak = () => peak;
        f.captures = () => captures;
        return f;
    }
    let currentListSize = 0;

    it("a list with more than MAX_LIST_CAPTURES entries is rejected before any capture is fetched", async () => {
        currentListSize = MAX_LIST_CAPTURES + 1;
        const f = countingFetch();
        const h = harness(f);
        await run({ list: LIST }, h);
        expect(f.captures()).toBe(0);
        expect(h.added).toHaveLength(0);
        const last = h.toasts[h.toasts.length - 1];
        expect(last.type).toBe("error");
        expect(last.text).toContain("The list contains 101 files; qvis loads at most 100 files from one list");
    });

    it("at most LIST_CONCURRENCY captures are fetched at once, and the traces stay in list order", async () => {
        currentListSize = MAX_LIST_CAPTURES;
        const f = countingFetch();
        const h = harness(f);
        await run({ list: LIST }, h);
        expect(f.captures()).toBe(MAX_LIST_CAPTURES);
        expect(f.peak()).toBe(LIST_CONCURRENCY);
        const traces = h.added[0].loaded.root.traces as Array<Record<string, unknown>>;
        expect(traces).toHaveLength(MAX_LIST_CAPTURES);
    });

    it("?file1..N= links are capped the same way", async () => {
        const q: Record<string, string> = {};
        for (let i = 1; i <= 500; i++) q["file" + i] = capture(i);
        expect(multiEntries(q)).toHaveLength(MAX_LIST_CAPTURES + 1);
        const f = countingFetch();
        const h = harness(f);
        await run(q, h);
        expect(f.captures()).toBe(0);
        expect(h.toasts[h.toasts.length - 1].text).toContain("qvis loads at most 100 files from one list");
    });

    it("settleLimited keeps input order, reports rejections and respects the limit", async () => {
        let running = 0;
        let peak = 0;
        const out = await settleLimited([5, 1, 4, 2, 3], 2, async (n) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, n));
            running--;
            if (n === 4) throw new Error("four");
            return n * 10;
        });
        expect(peak).toBe(2);
        expect(out.map((r) => (r.status === "fulfilled" ? r.value : (r.reason as Error).message))).toEqual([
            50,
            10,
            "four",
            20,
            30,
        ]);
        expect(await settleLimited([], 6, async () => 1)).toEqual([]);
    });
});
