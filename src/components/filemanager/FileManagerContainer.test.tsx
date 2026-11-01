import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { resetNotificationsForTests, subscribeNotifications, type NotificationItem } from "@/lib/notify";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { resetDemoState } from "@/loading/demo";
import { resetConnectionStoreForTests, useConnectionStore } from "@/store/connectionStore";
import FileManagerContainer from "./FileManagerContainer";

let toasts: NotificationItem[];
let unsubscribe: () => void;
const actions = {
    loadFilesFromServer: vi.fn(async () => undefined),
    loadFiles: vi.fn(async () => undefined),
    loadExamplesForDemo: vi.fn(async () => undefined),
    loadMassiveDemo: vi.fn(async () => undefined),
};

function makeGroup(filename: string, URL = "", URLshort = ""): QlogConnectionGroup {
    const group = QlogLoader.fromJSON(
        {
            root: {
                file_schema: "urn:ietf:params:qlog:file:contained",
                serialization_format: "application/qlog+json",
                title: "My title",
                traces: [
                    { vantage_point: { type: "client" }, events: [{ time: 0, name: "quic:packet_sent", data: {} }] },
                ],
            },
            serialization: "json",
            diagnostics: [],
        },
        { filename },
    )!;
    group.filename = filename;
    group.URL = URL;
    group.URLshort = URLshort;
    return group;
}

beforeEach(() => {
    resetConnectionStoreForTests();
    resetDemoState();
    resetNotificationsForTests();
    toasts = [];
    unsubscribe = subscribeNotifications((n) => toasts.push(n));
    for (const fn of Object.values(actions)) fn.mockClear();
    useConnectionStore.setState(actions);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("missing", { status: 404 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
    unsubscribe();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function renderPage() {
    const r = render(<FileManagerContainer />);
    await act(async () => undefined); // settle the massive-manifest effect
    return r;
}

describe("FileManagerContainer", () => {
    it("renders the verbatim page structure", async () => {
        const { container } = await renderPage();
        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
            "Welcome to qvis v0.1, the QUIC and HTTP/3 visualization toolsuite!",
        );
        expect(
            screen.getByText(
                "To be able to visualize something, you need to load some data. We have several options for that:",
            ),
        ).toBeInTheDocument();
        const root = container.querySelector("#FileManagerContainer.container-fluid.table-striped")!;
        const rows = Array.from(root.children);
        expect(rows).toHaveLength(5);
        expect(rows.map((r) => r.className)).toEqual(Array(5).fill("row fileOptionContainer"));
        expect(rows.map((r) => r.querySelector(".col-1.col-md-auto h3")?.textContent)).toEqual([
            "Option 1",
            "Option 2",
            "Option 3",
            "Option 4",
            "Option 5",
        ]);
        expect(rows.map((r) => r.querySelector(".col > h3")?.textContent)).toEqual([
            "Load a file by URL",
            "Upload a file",
            "Load some premade demo files",
            "Load a massive demo file",
            "Load a file by URL parameter",
        ]);
        expect(screen.getByText("Load example .qlog files").tagName).toBe("BUTTON");
        expect(screen.getByText("Load 31MB .qlog file").tagName).toBe("BUTTON");
        expect(rows[1].querySelector("p")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
            "Upload currently supports .qlog, .sqlog, .json, and .netlog files. No data is transfered to the server.Eventually we will also support .pcap, .pcapng and .qtr files.Note: Chrome netlog must be explicitly given the .netlog extension before uploading to qvis.",
        );
        expect(rows[2].querySelector("p")?.textContent).toBe(
            "This will load a few example files that you can visualize to get an idea of what's possible.",
        );
        expect(rows[3].querySelector("p")?.textContent?.replace(/\s+/g, " ")).toBe(
            "This will load a single qlog file representing a 100MB download. Use this to see how well qvis visualizations perform on larger traces.",
        );
    });

    it("Option 5 links keep the visible text and point at this deployment (D7)", async () => {
        await renderPage();
        const base = window.location.origin + window.location.pathname;
        const expected: Array<[string, string]> = [
            ["?list=x.json", "list=x.json"],
            ["?file=x.qlog", "file=x.qlog"],
            ["?file=x.pcap&secrets=x.keys", "file=x.pcap&secrets=x.keys"],
            ["?file1=x.qlog&file2=y.qlog&file3=z.qlog", "file1=x.qlog&file2=y.qlog&file3=z.qlog"],
            [
                "?file1=x.qlog&secrets1=x.keys&file2=y.qlog&secrets2=y.keys",
                "file1=x.qlog&secrets1=x.keys&file2=y.qlog&secrets2=y.keys",
            ],
        ];
        for (const [text, query] of expected) {
            expect(screen.getByText(text).getAttribute("href")).toBe(base + "#?" + query);
        }
    });

    it("Option 1: Fetch disabled until typed; Enter submits (Q1); .json goes to list; URL trimmed", async () => {
        await renderPage();
        const input = screen.getByPlaceholderText("https://www.example.com/output.qlog") as HTMLInputElement;
        expect(input.id).toBe("urlInput");
        const fetchButton = screen.getByText("Fetch") as HTMLButtonElement;
        expect(fetchButton.disabled).toBe(true);

        fireEvent.change(input, { target: { value: "  https://h/a.qlog " } });
        expect(fetchButton.disabled).toBe(false);
        fireEvent.submit(input.closest("form")!);
        expect(actions.loadFilesFromServer).toHaveBeenCalledWith({ file: "https://h/a.qlog" });

        fireEvent.change(input, { target: { value: "https://h/list.json" } });
        fireEvent.click(fetchButton);
        expect(actions.loadFilesFromServer).toHaveBeenLastCalledWith({ list: "https://h/list.json" });

        fireEvent.change(input, { target: { value: "   " } });
        fireEvent.click(fetchButton);
        expect(actions.loadFilesFromServer).toHaveBeenCalledTimes(2);
    });

    it("Option 1: pcap without a backend shows X6 and loads nothing; no secrets field", async () => {
        await renderPage();
        const input = screen.getByPlaceholderText("https://www.example.com/output.qlog");
        fireEvent.change(input, { target: { value: "https://h/x.pcap" } });
        expect(screen.queryByPlaceholderText("https://www.example.com/secrets.keys")).toBeNull();
        fireEvent.click(screen.getByText("Fetch"));
        expect(actions.loadFilesFromServer).not.toHaveBeenCalled();
        expect(toasts.map((t) => t.title)).toEqual(["Packet captures not supported"]);
    });

    it("Option 2: BS4 custom-file control states, selection by picker and by drop, Import", async () => {
        const { container } = await renderPage();
        const input = container.querySelector("#fileUpload") as HTMLInputElement;
        expect(input.getAttribute("accept")).toBe(".qlog,.sqlog,.json,.netlog");
        expect(input.multiple).toBe(true);
        expect(input.className).toContain("is-invalid"); // Q9 preserved
        const label = container.querySelector("label.custom-file-label")!;
        expect(label.textContent).toBe("Choose files or drop them here...");
        expect(label.getAttribute("data-browse")).toBe("Browse");
        const importButton = screen.getByText("Import") as HTMLButtonElement;
        expect(importButton.disabled).toBe(true);

        const a = new File(["{}"], "a.qlog");
        const b = new File(["{}"], "b.sqlog");
        fireEvent.change(input, { target: { files: [a, b] } });
        expect(label.textContent).toBe("a.qlog, b.sqlog");
        expect(input.className).toContain("is-valid");
        expect(importButton.disabled).toBe(false);

        const control = container.querySelector(".custom-file")!;
        expect(control.id).toBe("fileUpload__BV_file_outer_"); // BootstrapVue DOM: state class on the wrapper too
        expect(control.className).toBe("custom-file b-form-file text-nowrap text-truncate is-valid");
        fireEvent.dragOver(control, { dataTransfer: { types: ["Files"], files: [] } });
        expect(label.textContent).toBe("Drop files here...");
        expect(label.className).toBe("custom-file-label dragging");
        const c = new File(["{}"], "c.qlog");
        fireEvent.drop(control, { dataTransfer: { types: ["Files"], files: [c] } });
        expect(label.textContent).toBe("c.qlog"); // replaces, does not append

        fireEvent.click(importButton);
        expect(actions.loadFiles).toHaveBeenCalledWith([c]);
    });

    it("Option 2: dropping anywhere on the page selects the files (Q10)", async () => {
        const { container } = await renderPage();
        const d = new File(["{}"], "d.qlog");
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [d] } });
        act(() => {
            window.dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(true);
        expect(container.querySelector("label.custom-file-label")!.textContent).toBe("d.qlog");
    });

    it("Options 3 and 4 call the demo loaders", async () => {
        await renderPage();
        fireEvent.click(screen.getByText("Load example .qlog files"));
        fireEvent.click(screen.getByText("Load 31MB .qlog file"));
        expect(actions.loadExamplesForDemo).toHaveBeenCalledTimes(1);
        expect(actions.loadMassiveDemo).toHaveBeenCalledTimes(1);
    });

    it("Option 4 label follows the massive manifest (D13)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify([{ file: "big.sqlog", size: 45 * 1024 * 1024 }]))),
        );
        await renderPage();
        expect(await screen.findByText("Load 45MB .sqlog file")).toBeInTheDocument();
    });

    it("list of loaded files: link or filename, shorthand, Remove", async () => {
        const g1 = makeGroup("Loaded via URL (x)", "https://h/logs/x.qlog", "https://h/logs/x.qlog");
        const g2 = makeGroup("DEMO_new_cid.qlog (<1MB)");
        const g3 = makeGroup("evil", "javascript:alert(1)", "javascript:alert(1)");
        const removeGroup = vi.fn();
        useConnectionStore.setState({ groups: [g1, g2, g3], removeGroup });
        const { container } = await renderPage();

        const list = container.querySelector("#loadedGroupsContainer")!;
        expect(screen.getByText("List of loaded files")).toBeInTheDocument();
        const rows = list.querySelectorAll(":scope > .row.py-1");
        expect(rows).toHaveLength(3);

        const link = within(rows[0] as HTMLElement).getByText("https://h/logs/x.qlog") as HTMLAnchorElement;
        expect(link.tagName).toBe("A");
        expect(link.getAttribute("href")).toBe("https://h/logs/x.qlog");
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
        expect(within(rows[1] as HTMLElement).getByText("DEMO_new_cid.qlog (<1MB)")).toBeInTheDocument();
        expect(within(rows[1] as HTMLElement).getByText("My title (1 connection)")).toBeInTheDocument();
        expect(rows[2].querySelector("a")).toBeNull(); // FIX Q3

        fireEvent.click(within(rows[1] as HTMLElement).getByText("Remove"));
        expect(removeGroup).toHaveBeenCalledWith(g2);
        expect(within(rows[0] as HTMLElement).getByText("Download").className).toBe("btn btn-info");
    });

    it("no list without loaded files", async () => {
        await renderPage();
        expect(screen.queryByText("List of loaded files")).toBeNull();
    });
});
