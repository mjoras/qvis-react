import type { LoadedQlog } from "@/qlog/parse";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import {
    demoFilename,
    entryURL,
    examplesURL,
    loadExamplesForDemo,
    loadMassiveDemo,
    massiveButtonLabel,
    massiveDownloadSize,
    massiveCalledName,
    parseManifest,
    resetDemoState,
    sizeLabel,
    type DemoDeps,
} from "./demo";
import type { LoadNotification } from "./messages";
import type { FetchLike } from "./remote";

const QLOG = (title: string) =>
    JSON.stringify({
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        title,
        traces: [{ vantage_point: { type: "client" }, events: [{ time: 0, name: "quic:packet_sent", data: {} }] }],
    });

function harness(routes: Record<string, () => Response | Promise<Response>>, groups: QlogConnectionGroup[] = []) {
    const toasts: LoadNotification[] = [];
    const added: Array<{ loaded: LoadedQlog; filename: string }> = [];
    let outstanding = 0;
    let max = 0;
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
        calls.push(url);
        const r = routes[url];
        return r ? r() : new Response("missing", { status: 404 });
    };
    const deps: DemoDeps = {
        notify: (n) => toasts.push(n),
        addGroupFromQlogFile: (loaded, fileInfo, success) => {
            added.push({ loaded, filename: fileInfo.filename });
            if (success) toasts.push(success);
            const g = { filename: fileInfo.filename } as unknown as QlogConnectionGroup;
            groups.push(g);
            return g;
        },
        adjustOutstanding: (d) => {
            outstanding += d;
            max = Math.max(max, outstanding);
            expect(outstanding).toBeGreaterThanOrEqual(0);
        },
        getGroups: () => groups,
        fetch: fetchImpl,
    };
    return { deps, toasts, added, calls, outstanding: () => outstanding, max: () => max };
}

beforeEach(() => {
    resetDemoState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("manifest helpers", () => {
    it("parses arrays and {files: [...]}", () => {
        expect(parseManifest([{ file: "a.qlog", size: 10 }, { nope: 1 }, { file: "b.sqlog", title: "B" }])).toEqual([
            { file: "a.qlog", title: undefined, description: undefined, size: 10 },
            { file: "b.sqlog", title: "B", description: undefined, size: undefined },
        ]);
        expect(parseManifest({ files: [{ file: "x.qlog" }] })).toHaveLength(1);
        expect(() => parseManifest({ nope: true })).toThrow();
    });

    it("size labels follow the qvis demo convention", () => {
        expect(sizeLabel(34_000)).toBe("<1MB");
        expect(sizeLabel(3.1 * 1024 * 1024)).toBe("3.1MB");
        expect(sizeLabel(31 * 1024 * 1024 + 5)).toBe("31MB");
        expect(sizeLabel("(3.7MB)")).toBe("3.7MB");
        expect(sizeLabel(undefined)).toBeUndefined();
    });

    it("demo filenames keep the DEMO_ prefix convention", () => {
        expect(demoFilename({ file: "new_cid.qlog", size: 34_000 })).toBe("DEMO_new_cid.qlog (<1MB)");
        expect(demoFilename({ file: "sub/DEMO_x.sqlog" })).toBe("DEMO_x.sqlog");
        expect(demoFilename({ file: "mvfst_large.qlog", size: 31 * 1024 * 1024 }, "MASSIVE_DEMO_")).toBe(
            "MASSIVE_DEMO_mvfst_large.qlog (31MB)",
        );
    });

    it("massive helpers", () => {
        expect(massiveCalledName("MASSIVE_DEMO_mvfst_large.qlog (31MB)")).toBe("MASSIVE_DEMO_mvfst_large");
        expect(massiveButtonLabel(undefined)).toBe("Load 31MB .qlog file");
        expect(massiveButtonLabel({ file: "big.sqlog", size: 45 * 1024 * 1024 })).toBe("Load 45MB .sqlog file");
        expect(massiveDownloadSize(undefined)).toBe("100MB");
        expect(massiveDownloadSize({ file: "m.sqlog", title: "Massive trace: 50 MB download" })).toBe("50MB");
        expect(massiveDownloadSize({ file: "m.sqlog", description: "A 1.5 GB HTTP/3 download over ..." })).toBe(
            "1.5GB",
        );
        expect(massiveDownloadSize({ file: "m.sqlog", title: "big" })).toBe("100MB");
    });

    it("example URLs are relative to the app base", () => {
        const base = import.meta.env.BASE_URL;
        const prefix = base === "./" ? "" : base.endsWith("/") ? base : base + "/";
        expect(examplesURL("index.json")).toBe(prefix + "examples/index.json");
        expect(entryURL("massive/", "massive/big.qlog")).toBe(prefix + "examples/massive/big.qlog");
        expect(entryURL("", "./a.qlog")).toBe(prefix + "examples/a.qlog");
    });
});

describe("loadExamplesForDemo", () => {
    const index = () =>
        new Response(
            JSON.stringify([
                { file: "a.qlog", size: 1000 },
                { file: "b.qlog", size: 2 * 1024 * 1024 },
                { file: "broken.qlog", size: 10 },
            ]),
        );

    it("loads every manifest entry with N13/N14 and DEMO_ names; failures give N15 (FIX Q5)", async () => {
        const h = harness({
            [examplesURL("index.json")]: index,
            [examplesURL("a.qlog")]: () => new Response(QLOG("a")),
            [examplesURL("b.qlog")]: () => new Response(QLOG("b")),
        });
        await loadExamplesForDemo(h.deps);
        expect(h.outstanding()).toBe(0);
        expect(h.added.map((a) => a.filename).sort()).toEqual(["DEMO_a.qlog (<1MB)", "DEMO_b.qlog (2.0MB)"]);
        const titles = h.toasts.map((t) => t.title);
        expect(titles.filter((t) => t === "Loading qlog file directly")).toHaveLength(3);
        expect(titles).toContain("Loaded DEMO_a.qlog (<1MB)");
        expect(titles).toContain("ERROR loading DEMO_broken.qlog (<1MB)");
        const n13 = h.toasts.find((t) => t.title === "Loading qlog file directly")!;
        expect(n13.text).toBe(
            'Loading qlog file "DEMO_a.qlog (<1MB)" from URL ' +
                examplesURL("a.qlog") +
                ". Large files can take a while to load.",
        );
        const n15 = h.toasts.find((t) => t.title.startsWith("ERROR loading"))!;
        expect(n15.text).toBe(
            "This file could not be loaded from " +
                examplesURL("broken.qlog") +
                ".<br/>View the devtools JavaScript console for more information.<br/>HTTP 404",
        );
    });

    it("N7 when demo files are already loaded (filename starts with DEMO) or still loading", async () => {
        const h = harness({}, [{ filename: "DEMO_x.qlog" } as unknown as QlogConnectionGroup]);
        await loadExamplesForDemo(h.deps);
        expect(h.toasts).toEqual([
            {
                title: "Example files already loaded",
                type: "warn",
                text: "Example files were already loaded, check for files with the 'DEMO_' prefix.",
            },
        ]);
        expect(h.calls).toEqual([]);

        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const h2 = harness({
            [examplesURL("index.json")]: async () => {
                await gate;
                return new Response(JSON.stringify([{ file: "a.qlog" }]));
            },
            [examplesURL("a.qlog")]: () => new Response(QLOG("a")),
        });
        const first = loadExamplesForDemo(h2.deps);
        await loadExamplesForDemo(h2.deps); // double click while in flight
        expect(h2.toasts.map((t) => t.title)).toEqual(["Example files already loaded"]);
        release();
        await first;
        expect(h2.added).toHaveLength(1);
    });

    it("missing index gives an error toast and balances the counter", async () => {
        const h = harness({});
        await loadExamplesForDemo(h.deps);
        expect(h.outstanding()).toBe(0);
        expect(h.toasts[0].title).toBe("ERROR loading " + examplesURL("index.json"));
    });
});

describe("loadMassiveDemo", () => {
    it("loads the first entry of examples/massive/index.json as MASSIVE_DEMO_*", async () => {
        const h = harness({
            [examplesURL("massive/index.json")]: () =>
                new Response(JSON.stringify([{ file: "big.qlog", size: 31 * 1024 * 1024 }])),
            [examplesURL("massive/big.qlog")]: () => new Response(QLOG("big")),
        });
        await loadMassiveDemo(h.deps);
        expect(h.added.map((a) => a.filename)).toEqual(["MASSIVE_DEMO_big.qlog (31MB)"]);
        expect(h.outstanding()).toBe(0);
    });

    it("N8 names the loaded massive file", async () => {
        const h = harness({}, [{ filename: "MASSIVE_DEMO_mvfst_large.qlog (31MB)" } as unknown as QlogConnectionGroup]);
        await loadMassiveDemo(h.deps);
        expect(h.toasts).toEqual([
            {
                title: "Example file already loaded",
                type: "warn",
                text: "Example file was already loaded, it is called 'MASSIVE_DEMO_mvfst_large'.",
            },
        ]);
    });
});
