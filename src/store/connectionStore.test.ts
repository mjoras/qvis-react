import { resetNotificationsForTests, subscribeNotifications, type NotificationItem } from "@/lib/notify";
import { modelEvents } from "@/model/modelEvents";
import { useConfigurationStore } from "@/store/configurationStore";
import { resetDemoState } from "@/loading/demo";
import { resetConnectionStoreForTests, useConnectionStore } from "./connectionStore";

const ROOT = (events: unknown[]) => ({
    file_schema: "urn:ietf:params:qlog:file:contained",
    serialization_format: "application/qlog+json",
    title: "T",
    traces: [{ vantage_point: { type: "client" }, event_schemas: ["urn:ietf:params:qlog:events:quic"], events }],
});

let toasts: NotificationItem[];
let unsubscribe: () => void;

beforeEach(() => {
    resetConnectionStoreForTests();
    resetNotificationsForTests();
    resetDemoState();
    toasts = [];
    unsubscribe = subscribeNotifications((n) => toasts.push(n));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
});

describe("connectionStore", () => {
    it("addGroupFromQlogFile: sets file info, adds, then success and diagnostics toasts", () => {
        const loaded = {
            root: ROOT([
                { time: 5, name: "quic:packet_sent", data: {} },
                { time: 1, name: "quic:packet_received", data: {} },
            ]),
            serialization: "json" as const,
            diagnostics: [],
        };
        const group = useConnectionStore
            .getState()
            .addGroupFromQlogFile(
                loaded,
                { filename: "Loaded via URL (u)", URL: "https://h/u.qlog", URLshort: "https://h/u.qlog" },
                { title: "Loaded files via URL", type: "success", text: "ok" },
            );
        expect(group).toBeDefined();
        const s = useConnectionStore.getState();
        expect(s.groups).toEqual([group]);
        expect(group!.filename).toBe("Loaded via URL (u)");
        expect(group!.URL).toBe("https://h/u.qlog");
        expect(group!.URLshort).toBe("https://h/u.qlog");
        expect(toasts.map((t) => t.title)).toEqual(["Loaded files via URL", "Trace events were not ordered by time"]);
        expect(toasts[1].type).toBe("warn");
    });

    it("addGroupFromQlogFile: N9 when the model rejects the file", () => {
        const group = useConnectionStore
            .getState()
            .addGroupFromQlogFile(
                { root: { nothing: true }, serialization: "json", diagnostics: [] },
                { filename: "bad.qlog" },
            );
        expect(group).toBeUndefined();
        expect(useConnectionStore.getState().groups).toEqual([]);
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toMatchObject({
            title: "ERROR parsing qlog file bad.qlog",
            type: "error",
            duration: 6000,
            text: "File was successfully loaded but could not be parsed.<br/>Make sure you have a well-formed qlog file.<br/>View the devtools JavaScript console for more information.",
        });
    });

    it("removeGroup replaces the array, bumps revision and scrubs view selections", () => {
        const scrub = vi.spyOn(useConfigurationStore.getState(), "scrub");
        const loaded = {
            root: ROOT([{ time: 0, name: "quic:packet_sent", data: {} }]),
            serialization: "json" as const,
            diagnostics: [],
        };
        const g1 = useConnectionStore.getState().addGroupFromQlogFile(loaded, { filename: "a" })!;
        const g2 = useConnectionStore
            .getState()
            .addGroupFromQlogFile(
                { ...loaded, root: ROOT([{ time: 0, name: "quic:packet_sent", data: {} }]) },
                { filename: "b" },
            )!;
        const before = useConnectionStore.getState();
        useConnectionStore.getState().removeGroup(g1);
        const after = useConnectionStore.getState();
        expect(after.groups).toEqual([g2]);
        expect(after.groups).not.toBe(before.groups);
        expect(after.revision).toBeGreaterThan(before.revision);
        expect(scrub).toHaveBeenCalledWith(g1);
        useConnectionStore.getState().removeGroup(g1); // absent: no-op
        expect(useConnectionStore.getState().groups).toEqual([g2]);
    });

    it("model change events bump revision", () => {
        const r0 = useConnectionStore.getState().revision;
        modelEvents.emit({ kind: "timing-changed" });
        expect(useConnectionStore.getState().revision).toBe(r0 + 1);
    });

    it("sequence-diagram clones bump revision without replacing groups", () => {
        const loaded = {
            root: ROOT([{ time: 0, name: "quic:packet_sent", data: {} }]),
            serialization: "json" as const,
            diagnostics: [],
        };
        const g = useConnectionStore.getState().addGroupFromQlogFile(loaded, { filename: "a" })!;
        const { groups, revision } = useConnectionStore.getState();
        g.getConnections()[0].clone();
        expect(useConnectionStore.getState().groups).toBe(groups);
        expect(useConnectionStore.getState().revision).toBeGreaterThan(revision);
    });

    it("outstandingRequestCount never goes negative", () => {
        useConnectionStore.getState().adjustOutstandingRequestCount(-1);
        expect(useConnectionStore.getState().outstandingRequestCount).toBe(0);
        useConnectionStore.getState().adjustOutstandingRequestCount(2);
        useConnectionStore.getState().adjustOutstandingRequestCount(-1);
        expect(useConnectionStore.getState().outstandingRequestCount).toBe(1);
    });

    it("loadFiles (Option 2) end to end", async () => {
        const text = JSON.stringify(ROOT([{ time: 0, name: "quic:packet_sent", data: {} }]));
        await useConnectionStore.getState().loadFiles([new File([text], "up.qlog")]);
        const s = useConnectionStore.getState();
        expect(s.groups.map((g) => g.filename)).toEqual(["up.qlog"]);
        expect(s.outstandingRequestCount).toBe(0);
        expect(toasts.map((t) => t.title)).toEqual(["Loading uploaded file", "Uploaded file"]);
    });

    it("loadFilesFromServer end to end with a mocked global fetch", async () => {
        const text = JSON.stringify(ROOT([{ time: 0, name: "quic:packet_sent", data: {} }]));
        const fetchMock = vi.fn(async () => new Response(text));
        vi.stubGlobal("fetch", fetchMock);
        try {
            await useConnectionStore.getState().loadFilesFromServer({ file: "https://h/x.qlog", focusOnEvent: "1" });
        } finally {
            vi.unstubAllGlobals();
        }
        const s = useConnectionStore.getState();
        expect(s.groups).toHaveLength(1);
        expect(s.groups[0].URL).toBe("https://h/x.qlog");
        expect(s.groups[0].getShorthand()).toBe("T (1 connection)");
        expect(s.outstandingRequestCount).toBe(0);
        expect(toasts.map((t) => t.title)).toEqual(["Loading file(s) via URL", "Loaded files via URL"]);
    });
});
