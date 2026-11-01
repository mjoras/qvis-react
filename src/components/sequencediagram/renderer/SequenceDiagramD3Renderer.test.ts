import { evt, loadGroup, pkt, seqTrace } from "../__fixtures__/seq";
import { prepareDiagram, type SeqLayout } from "../prepare";
import { SequenceDiagramD3Renderer } from "./SequenceDiagramD3Renderer";

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.location.hash = "";
});

const f = (frame_type: string, extra: Record<string, unknown> = {}) => ({ frame_type, ...extra });

function setupDom(): { container: HTMLDivElement; svg: SVGSVGElement } {
    const container = document.createElement("div");
    container.id = "sequence-diagram";
    Object.defineProperty(container, "clientWidth", { value: 1000 });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "sequence-diagram-svg";
    container.appendChild(svg);
    document.body.appendChild(container);
    return { container, svg };
}

function pairLayout(url?: string): SeqLayout {
    const client = loadGroup(
        [
            seqTrace(
                [
                    pkt(0, "sent", "initial", 0, [f("crypto"), f("padding")]),
                    evt(0.5, "quic:recovery_metrics_updated", {
                        congestion_window: 1000,
                        bytes_in_flight: 10,
                        min_rtt: 1,
                    }),
                    pkt(1, "sent", "1RTT", 1, [
                        ...Array.from({ length: 6 }, (_, i) => f("stream", { stream_id: i * 4 })),
                        f("ack", { acked_ranges: [[0, 0]] }),
                        f("ack", { acked_ranges: [[2, 3]] }),
                        f("padding"),
                    ]),
                    pkt(2, "sent", "1RTT", 2), // lost
                    pkt(3, "received", "initial", 0, [f("ack", { acked_ranges: [[0, 0]] })]),
                ],
                { type: "client" },
            ),
        ],
        "client.qlog",
        url,
    ).getConnections()[0];
    const server = loadGroup(
        [
            seqTrace(
                [
                    pkt(0.2, "received", "initial", 0),
                    pkt(0.3, "sent", "initial", 0, [f("ack", { acked_ranges: [[0, 0]] })]),
                    pkt(1.2, "received", "1RTT", 1),
                ],
                { type: "server" },
            ),
        ],
        "server.qlog",
    ).getConnections()[0];
    return prepareDiagram(
        [
            { connection: client, timeOffset: 0 },
            { connection: server, timeOffset: 0 },
        ],
        1,
    )!.layout;
}

/** text of the spans of the arrow label of (trace, event) */
function labelOf(svg: SVGSVGElement, t: number, e: number): string[] {
    const span = svg.querySelector(`foreignObject span[data-trace="${t}"][data-event="${e}"]`)!;
    return Array.from(span.parentElement!.children).map((c) => c.textContent ?? "");
}

describe("SequenceDiagramD3Renderer", () => {
    it("setup: SVG size, timelines and header labels", () => {
        const { container, svg } = setupDom();
        const r = new SequenceDiagramD3Renderer(container, svg, () => {});
        const layout = pairLayout();
        r.setup(layout);
        expect(svg.getAttribute("width")).toBe("1000");
        expect(svg.getAttribute("height")).toBe("" + layout.height);
        expect(svg.hasAttribute("viewBox")).toBe(false);
        const timelines = Array.from(svg.querySelectorAll(":scope > rect"));
        expect(timelines.map((x) => [x.getAttribute("x"), x.getAttribute("y"), x.getAttribute("width")])).toEqual([
            ["249", "60", "2"],
            ["749", "60", "2"],
        ]);
        const texts = Array.from(svg.querySelectorAll(":scope > text")).map((t) => t.textContent);
        expect(texts).toEqual(["client.qlog", "client", "server.qlog", "server"]);
        r.dispose();
    });

    it("header link only for safe URLs (sequenceHeaderTitle / isSafeLinkURL)", () => {
        const { container, svg } = setupDom();
        const r = new SequenceDiagramD3Renderer(container, svg, () => {});
        r.setup(pairLayout("https://example.org/client.qlog"));
        const a = svg.querySelector(":scope > a")!;
        expect(a.getAttribute("href")).toBe("https://example.org/client.qlog");
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.textContent).toBe("https://example.org/client.qlog");
        r.setup(pairLayout("javascript:alert(1)"));
        expect(svg.querySelector("a")).toBeNull();
        r.dispose();
    });

    it("draws events, timestamps, arrows, chip order, frame aggregation, side labels and lost packets", () => {
        const { container, svg } = setupDom();
        const r = new SequenceDiagramD3Renderer(container, svg, () => {});
        const layout = pairLayout();
        r.setup(layout);
        r.renderPartialExtents();
        expect(svg.querySelectorAll(":scope > g").length).toBeGreaterThan(0);
        expect(svg.querySelectorAll("rect[data-event]")).toHaveLength(8);
        const timestamps = Array.from(svg.querySelectorAll("g text.timestamp")).map((t) => t.textContent);
        expect(timestamps).toContain("0.00");
        // the server got an automatic offset of 1.3 ms (Initial RTT 3 ms / 2 - 0.2): its Initial arrives at 1.50
        expect(layout.traces[1].timeOffset).toBeCloseTo(1.3, 10);
        expect(timestamps).toContain("1.50");

        // ">" : frames (last first), packet chip, triangle
        expect(labelOf(svg, 0, 0)).toEqual(["padding", "crypto", "initial : 0", ""]);
        // ">" with >= 8 frames: individual frames of small groups, then the aggregate, then the packet chip
        expect(labelOf(svg, 0, 2)).toEqual([
            "padding",
            "ack 2-3",
            "ack 0",
            "6 stream frames (click for details)",
            "1RTT : 1",
            "",
        ]);
        // "<" : triangle, packet chip, frames in order
        expect(labelOf(svg, 1, 1)).toEqual(["", "initial : 0", "ack 0"]);
        const chip = svg.querySelector('span[data-trace="0"][data-event="0"]') as HTMLSpanElement;
        expect(chip.textContent).toBe("padding");
        expect(chip.style.backgroundColor).toBe("rgb(255, 105, 180)");
        expect(chip.style.fontSize).toBe("14px");
        expect(chip.style.paddingLeft).toBe("5px");

        // side label for the metrics event (purple), none for packet events without arrows
        const side = svg.querySelector('foreignObject span[data-trace="0"][data-event="1"]') as HTMLSpanElement;
        expect(side.textContent).toBe("cwnd: 1000, in flight: 10, ...");
        expect(side.style.backgroundColor).toBe("rgb(95, 9, 132)");
        expect(side.parentElement!.style.textAlign).toBe("right"); // leftmost trace

        // lost: half arrow + red X; arrow colours
        expect(svg.querySelectorAll('path[stroke="red"]')).toHaveLength(1);
        expect(svg.querySelectorAll('line[stroke="#0468cc"]')).toHaveLength(3);
        expect(svg.querySelectorAll('line[stroke="#a80f3a"]')).toHaveLength(1);
        r.dispose();
    });

    it("delegates clicks on squares and chips to the handler; dispose removes the listeners", () => {
        const { container, svg } = setupDom();
        const onClick = vi.fn();
        const r = new SequenceDiagramD3Renderer(container, svg, onClick);
        r.setup(pairLayout());
        r.renderPartialExtents();
        (svg.querySelector('rect[data-trace="1"][data-event="2"]') as SVGRectElement).dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
        (svg.querySelector('span[data-trace="0"][data-event="2"]') as HTMLSpanElement).click();
        expect(onClick.mock.calls).toEqual([
            [1, 2],
            [0, 2],
        ]);
        const remove = vi.spyOn(window, "removeEventListener");
        r.dispose();
        expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
        (svg.querySelector('rect[data-trace="1"][data-event="2"]') as SVGRectElement).dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
        expect(onClick).toHaveBeenCalledTimes(2);
    });

    it("virtualizes by screen-height ranges; forceFull renders all of them", () => {
        const { container, svg } = setupDom();
        const r = new SequenceDiagramD3Renderer(container, svg, () => {});
        // a tall diagram: events every 10 ms (compressed gaps of 120 px)
        const events = Array.from({ length: 200 }, (_, i) => pkt(i * 10, "sent", "1RTT", i));
        const c = loadGroup([seqTrace(events, { type: "client" })]).getConnections()[0];
        const layout = prepareDiagram([{ connection: c, timeOffset: 0 }], 1)!.layout;
        r.setup(layout);
        const rangeCount = Math.ceil(layout.height / (screen.height > 0 ? screen.height : window.innerHeight));
        expect(rangeCount).toBeGreaterThan(5);
        r.renderPartialExtents();
        expect(svg.querySelectorAll(":scope > g")).toHaveLength(2); // ranges 0 and 1 at the top of the page
        window.location.hash = "#/sequence?forceFull";
        r.renderPartialExtents();
        expect(svg.querySelectorAll(":scope > g")).toHaveLength(rangeCount);
        r.clear();
        expect(svg.childNodes).toHaveLength(0);
        expect(svg.hasAttribute("width")).toBe(false);
        r.dispose();
    });

    it("focus scrolls to y - 50 and then draws (SQ11)", () => {
        const { container, svg } = setupDom();
        const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        const r = new SequenceDiagramD3Renderer(container, svg, () => {});
        const layout = pairLayout();
        r.setup(layout);
        r.renderPartialExtents({ connectionIndex: 1, eventIndex: 0 });
        expect(scrollTo).toHaveBeenCalledWith(0, layout.y[1][0] - 50);
        expect(svg.querySelectorAll(":scope > g").length).toBeGreaterThan(0);
        scrollTo.mockClear();
        // focusOnPN: the first packet_sent with that number (PN 0 works, SQ10)
        r.renderPartialExtents({ connectionIndex: 0, packetNumber: "0" });
        expect(scrollTo).toHaveBeenCalledWith(0, layout.y[0][0] - 50);
        scrollTo.mockClear();
        r.renderPartialExtents({ connectionIndex: 5, eventIndex: 0 });
        expect(scrollTo).not.toHaveBeenCalled();
        // addendum S8: the "Loading files..." alert qvis still showed above the diagram (here: diagram top at 0, so
        // the alert spanned 0..50): scroll anchoring moved qvis up by its extent when the viewport top was below it
        const alert = { height: 50, extent: 66 };
        const y0 = layout.y[1][0];
        r.renderPartialExtents({ connectionIndex: 1, eventIndex: 0 }, alert);
        expect(y0 - 50).toBeGreaterThanOrEqual(50);
        expect(scrollTo).toHaveBeenCalledWith(0, Math.max(0, y0 - 50 - 66));
        scrollTo.mockClear();
        // viewport top inside or above the alert: the anchor was the alert or above it, no adjustment
        r.renderPartialExtents({ connectionIndex: 1, eventIndex: 0 }, { height: y0, extent: y0 + 16 });
        expect(scrollTo).toHaveBeenCalledWith(0, y0 - 50);
        scrollTo.mockClear();
        r.renderPartialExtents({ connectionIndex: 1, eventIndex: 0 }, { height: y0 - 50, extent: y0 - 34 });
        expect(scrollTo).toHaveBeenCalledWith(0, 0);
        r.dispose();
    });
});
