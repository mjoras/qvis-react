// Component tests for the multiplexing page (docs/dev/parity/multiplexing-graph.md §2, §3.1, §3.8, M17, M19).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { useConfigurationStore } from "@/store/configurationStore";
import { resetConnectionStoreForTests, useConnectionStore } from "@/store/connectionStore";
import MultiplexingGraphContainer from "./MultiplexingGraphContainer";
import { allConnectionsSortedByFilename, allowSelectAllFor } from "./multiplexingSelection";
import { loadFixture } from "./__fixtures__/muxTrace";

const INTRO = "Select a trace via the dropdown(s) below to visualize it in the stream graph";

function setGroups(groups: QlogConnectionGroup[]): void {
    act(() => {
        useConnectionStore.setState({ groups, revision: useConnectionStore.getState().revision + 1 });
    });
}

const panels = (c: HTMLElement) => c.querySelectorAll("[id=multiplexingToplevelContainer]");
const h4s = (c: HTMLElement) => [...c.querySelectorAll("#multiplexingToplevelContainer h4")].map((h) => h.textContent);

beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    resetConnectionStoreForTests();
    useConfigurationStore.getState().reset();
});
afterEach(() => vi.restoreAllMocks());

describe("selection helpers", () => {
    it("allowSelectAll is a URL substring check (M26)", () => {
        expect(allowSelectAllFor("https://qvis.quictools.info/#/multiplexing")).toBe(false);
        expect(allowSelectAllFor("https://qvis.quictools.info/?multimultiplexing=true#/multiplexing")).toBe(true);
        expect(allowSelectAllFor("https://qvis.quictools.info/#/multiplexing?multimultiplexing")).toBe(true);
        expect(allowSelectAllFor("http://localhost:5179/#/multiplexing")).toBe(true);
        expect(allowSelectAllFor("http://example.org:8080/")).toBe(true);
    });

    it("sorts all traces by file name, code-unit order, stable for ties (M25)", () => {
        const b = loadFixture("multiplexing-par10-server.sqlog");
        b.filename = "b";
        const a = loadFixture("multiplexing-handwritten-client.sqlog");
        a.filename = "B"; // "B" < "b" in code-unit order
        const a2 = loadFixture("multiplexing-par10-client.sqlog");
        a2.filename = "b";
        const sorted = allConnectionsSortedByFilename([b, a, a2]);
        expect(sorted.map((c) => c.parent)).toEqual([a, b, a2]);
    });
});

describe("MultiplexingGraphContainer", () => {
    it("without files: intro text, the danger alert, no panel", () => {
        const { container } = render(<MultiplexingGraphContainer />);
        expect(screen.getByText(INTRO)).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Please load a trace file to visualize it");
        expect(panels(container)).toHaveLength(0);
        expect(screen.getByLabelText("Show waterfall")).toBeChecked();
        expect(screen.getByLabelText("Show byte ranges")).toBeChecked();
        // jsdom runs on localhost: the select-all button is shown, disabled without a selection
        expect(screen.getByRole("button", { name: "Load all connections at once" })).toBeDisabled();
        expect(container.querySelector("#multiplexing-packet-tooltip")).not.toBeNull();
    });

    it("auto-selects the first trace of the first file that has one (Q12) and renders the three charts", () => {
        const empty = new QlogConnectionGroup();
        empty.filename = "empty.sqlog";
        const g = loadFixture("multiplexing-handwritten-client.sqlog");
        const { container } = render(<MultiplexingGraphContainer />);
        setGroups([empty, g]);

        expect(useConfigurationStore.getState().multiplexingConfig.connections).toEqual([g.getConnections()[0]]);
        expect(h4s(container)).toEqual([
            "multiplexing-handwritten-client.sqlog : multiplexing fixture : client : hand-written client",
        ]);
        const panel = panels(container)[0];
        expect(panel.querySelectorAll("[id^=multiplexing-waterfall-] rect.packet")).toHaveLength(3);
        expect(panel.querySelectorAll("[id^=multiplexing-data-] rect.packet")).toHaveLength(15);
        expect(panel.querySelectorAll("[id^=multiplexing-byterange-] rect.packet")).toHaveLength(4);
        // the never-visible "Simulated FIFO order" row (M1)
        const fifoRow = panel.querySelector("[id^=multiplexing-fifo-]")!.closest(".row") as HTMLElement;
        expect(fifoRow.style.display).toBe("none");
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("an in-place trace rename updates the h4 and re-renders the charts (qvis updated() hook)", () => {
        const g = loadFixture("multiplexing-handwritten-client.sqlog");
        setGroups([g]);
        const { container } = render(<MultiplexingGraphContainer />);
        const svg = container.querySelector("[id^=multiplexing-data-] svg");
        act(() => useConnectionStore.setState((st) => ({ revision: st.revision + 1 })));
        expect(container.querySelector("[id^=multiplexing-data-] svg")).toBe(svg); // nothing changed: no re-render
        act(() => g.getConnections()[0].setTitle("renamed"));
        expect(h4s(container)).toEqual([
            "multiplexing-handwritten-client.sqlog : multiplexing fixture : client : renamed",
        ]);
        expect(container.querySelector("[id^=multiplexing-data-] svg")).not.toBe(svg);
    });

    it("checkboxes toggle the rows; byte ranges come back after re-enabling (M4)", () => {
        const g = loadFixture("multiplexing-handwritten-client.sqlog");
        setGroups([g]);
        const { container } = render(<MultiplexingGraphContainer />);

        fireEvent.click(screen.getByLabelText("Show byte ranges"));
        expect(useConfigurationStore.getState().multiplexingConfig.showbyteranges).toBe(false);
        expect(container.querySelector("[id^=multiplexing-byterange-]")).toBeNull();
        expect(screen.queryByText("Byterange per STREAM frame")).toBeNull();

        fireEvent.click(screen.getByLabelText("Show byte ranges"));
        expect(container.querySelectorAll("[id^=multiplexing-byterange-] rect.packet")).toHaveLength(4);

        fireEvent.click(screen.getByLabelText("Show waterfall"));
        expect(container.querySelector("[id^=multiplexing-waterfall-]")).toBeNull();
        expect(screen.queryByText("Waterfall")).toBeNull();
        fireEvent.click(screen.getByLabelText("Show waterfall"));
        expect(container.querySelectorAll("[id^=multiplexing-waterfall-] rect.packet")).toHaveLength(3);
    });

    it("waterfall click: stream details, byte ranges of that stream, no other re-render (M19); cleared on trace change (M17)", () => {
        const g = loadFixture("multiplexing-handwritten-client.sqlog");
        const g2 = loadFixture("multiplexing-par10-client.sqlog");
        setGroups([g, g2]);
        const { container } = render(<MultiplexingGraphContainer />);

        const stripSvg = container.querySelector("[id^=multiplexing-data-] svg");
        act(() => {
            container
                .querySelectorAll("[id^=multiplexing-waterfall-] rect.packet")[2]
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(screen.getByText("Selected stream's details")).toBeInTheDocument();
        const detail = screen.getByText("Selected stream's details").nextElementSibling as HTMLElement;
        expect(detail.textContent!.replace(/\u00a0/g, "_")).toBe(
            "_ Stream 8 : Requested at 12.25ms. Transmitted from 42.00ms to 104.00ms (62.00ms). 6000 bytes spread over 7 frames (including retransmits). " +
                "HTTP/3 HEADERS seen at 12.00ms. HTTP/3 PRIORITY Update seen at 9.75ms. Priority info (if any): FRAME: u=1, i -> HEADER: u=3",
        );
        expect(detail.querySelector(".font-weight-bold")!.textContent).toBe("8");
        expect((detail.querySelector("span") as HTMLElement).style.backgroundColor).toBe("rgb(225, 116, 38)");
        // the byte ranges switched to stream 8; the strip was not re-rendered
        expect(container.querySelectorAll("[id^=multiplexing-byterange-] rect.packet")).toHaveLength(7);
        expect(container.querySelector("[id^=multiplexing-data-] svg")).toBe(stripSvg);

        // a checkbox toggle keeps the detail (qvis), a trace change clears it (M17 FIX)
        fireEvent.click(screen.getByLabelText("Show byte ranges"));
        expect(screen.getByText("Selected stream's details")).toBeInTheDocument();
        act(() =>
            useConfigurationStore.getState().update("multiplexingConfig", { connections: [g2.getConnections()[0]] }),
        );
        expect(screen.queryByText("Selected stream's details")).toBeNull();
    });

    it("Load all connections at once: one panel per trace, sorted by file name, waterfall only; picking a trace returns to single mode", () => {
        const c = loadFixture("multiplexing-par10-client.sqlog");
        const h = loadFixture("multiplexing-handwritten-client.sqlog");
        const s = loadFixture("multiplexing-par10-server.sqlog");
        setGroups([c, h, s]);
        const { container } = render(<MultiplexingGraphContainer />);
        expect(panels(container)).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: "Load all connections at once" }));
        const cfg = useConfigurationStore.getState().multiplexingConfig;
        expect(cfg.showwaterfall).toBe(true);
        expect(cfg.showbyteranges).toBe(false);
        expect(h4s(container).map((t) => t!.split(" : ")[0])).toEqual([
            "multiplexing-handwritten-client.sqlog",
            "multiplexing-par10-client.sqlog",
            "multiplexing-par10-server.sqlog",
        ]);
        expect(container.querySelectorAll("[id^=multiplexing-waterfall-] svg")).toHaveLength(3);
        expect(container.querySelectorAll("[id^=multiplexing-byterange-]")).toHaveLength(0);
        // the shared tooltip stays single
        expect(container.querySelectorAll("#multiplexing-packet-tooltip")).toHaveLength(1);

        // byte ranges back on: every panel draws its chart (M4 FIX)
        fireEvent.click(screen.getByLabelText("Show byte ranges"));
        expect(container.querySelectorAll("[id^=multiplexing-byterange-] svg")).toHaveLength(3);

        const select = container.querySelector("select") as HTMLSelectElement;
        const option = [...select.options].find((o) => o.textContent!.includes("server trace"))!;
        fireEvent.change(select, { target: { value: option.value } });
        expect(panels(container)).toHaveLength(1);
        expect(h4s(container)[0]).toMatch(/^multiplexing-par10-server\.sqlog : /);
    });
});
