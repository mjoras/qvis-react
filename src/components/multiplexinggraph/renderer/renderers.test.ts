// Renderer smoke tests (jsdom): render real latest-draft fixtures with the D3 classes and check the drawn elements
// (docs/dev/parity/multiplexing-graph.md §8.6).

import { loadFixture, received, sent, streamFrame, trace } from "../__fixtures__/muxTrace";
import MultiplexingGraphD3ByterangesRenderer from "./MultiplexingGraphD3ByterangesRenderer";
import MultiplexingGraphD3CollapsedRenderer from "./MultiplexingGraphD3CollapsedRenderer";
import MultiplexingGraphD3SimulationRenderer from "./MultiplexingGraphD3SimulationRenderer";
import MultiplexingGraphD3WaterfallRenderer, {
    WATERFALL_EMPTY_MESSAGE,
    type StreamDetail,
} from "./MultiplexingGraphD3WaterfallRenderer";
import { extractCollapsedData } from "./multiplexingData";
import { v5WheelDelta, v5ZoomFilter } from "./MultiplexingGraphDataHelper";

function div(width = 1639): HTMLDivElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
    document.body.appendChild(el);
    return el;
}

const hand = () => loadFixture("multiplexing-handwritten-client.sqlog").getConnections()[0];

beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe("MultiplexingGraphD3CollapsedRenderer", () => {
    it("draws one rect per frame, the arrival markers, the axis label and the byte ranges of stream 0", () => {
        const data = div();
        const tooltip = div();
        const br = div();
        const r = new MultiplexingGraphD3CollapsedRenderer(data, tooltip, br);
        expect(r.render(hand())).toBe(true);

        const svg = data.querySelector("svg")!;
        expect(svg.getAttribute("width")).toBe("1639");
        expect(svg.getAttribute("height")).toBe("110");
        expect(data.querySelectorAll("rect.packet")).toHaveLength(15);
        expect(data.querySelectorAll("rect.retransmitPacket")).toHaveLength(2);
        expect(data.querySelectorAll("rect.reorderPacket")).toHaveLength(1);
        expect(data.querySelectorAll("rect.duplicatePacket")).toHaveLength(2);
        expect(data.querySelectorAll("rect.futurePacket")).toHaveLength(3);
        expect(data.querySelector("text:not(.tick text)")?.textContent).toBe(
            "Count of STREAM frames received (regardless of size, includes retransmits)",
        );
        // alternating heights: 45.5 and 40.95
        const packets = [...data.querySelectorAll("rect.packet")];
        expect(packets.slice(0, 2).map((p) => [p.getAttribute("y"), p.getAttribute("height")])).toEqual([
            ["0", "45.5"],
            ["2.275", "40.95"],
        ]);
        // M3 FIX: the strip clips to its own, uniquely named clip path
        const clipId = data.querySelector("clipPath")!.id;
        expect(clipId).toMatch(/^mux-clip-\d+$/);
        expect(data.querySelector("g[clip-path]")!.getAttribute("clip-path")).toBe("url(#" + clipId + ")");

        // tooltip styles
        expect(tooltip.style.position).toBe("absolute");
        expect(tooltip.style.background).toBe("lightsteelblue");
        expect(tooltip.style.pointerEvents).toBe("none");

        // byte ranges for stream 0: 4 frames, 4 pingbacks, 3 moves
        expect(br.querySelectorAll("rect.packet")).toHaveLength(4);
        expect(br.querySelectorAll("rect.pingback")).toHaveLength(4);
        expect(br.querySelectorAll("rect.dataMoved")).toHaveLength(3);
        expect([...br.querySelectorAll("rect.packet")].every((p) => p.getAttribute("fill") === "#E1DA4C")).toBe(true);
        expect(br.querySelector("svg")!.getAttribute("height")).toBe("540");
    });

    it("tooltip on hover (text nodes, M35) and byte ranges on click", () => {
        const data = div();
        const tooltip = div();
        const br = div();
        const r = new MultiplexingGraphD3CollapsedRenderer(data, tooltip, br);
        r.render(hand());

        const packets = data.querySelectorAll("rect.packet");
        packets[3].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        expect(tooltip.innerHTML).toBe(
            "43ms : stream 0 : packet number 3<br>[2000, 2999] (size: 1000)<br>Creates gap from 1000 to 2000 (size: 1000)",
        );
        packets[12].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        expect(tooltip.innerHTML).toBe("103ms : stream 0 : packet number undefined<br>[3000, 3499] (size: 500)");

        // click a stream-8 frame: the byte-range chart switches to stream 8 (7 frames, 3 moves) and zooms (axisLeft)
        packets[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(br.querySelectorAll("rect.packet")).toHaveLength(7);
        expect(br.querySelectorAll("rect.dataMoved")).toHaveLength(3);
        expect(br.querySelector("rect.packet")!.getAttribute("fill")).toBe("#E17426");
        // the zero-length FIN frame's pingback is clamped to 0 instead of a negative height
        expect([...br.querySelectorAll("rect.pingback")].every((p) => Number(p.getAttribute("height")) >= 0)).toBe(
            true,
        );
    });

    it("works without a byte-range container (M4) and clears the byte ranges for a trace without frames (M5)", () => {
        const data = div();
        const br = div();
        const r = new MultiplexingGraphD3CollapsedRenderer(data, div(), null);
        r.render(hand());
        expect(() =>
            data.querySelector("rect.packet")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        ).not.toThrow();

        r.setByteRangeContainer(br);
        r.render(hand());
        expect(br.querySelectorAll("rect.packet")).toHaveLength(4);

        r.render(trace([]));
        expect(br.childElementCount).toBe(0);
        expect(data.querySelectorAll("rect.packet")).toHaveLength(0);
        expect([...data.querySelectorAll(".tick text")].map((t) => t.textContent)).toEqual(["1"]);
    });

    it("server traces say 'sent'", () => {
        const data = div();
        const r = new MultiplexingGraphD3CollapsedRenderer(data, div(), null);
        r.render(loadFixture("multiplexing-par10-server.sqlog").getConnections()[0]);
        expect(
            [...data.querySelectorAll("text")].some(
                (t) => t.textContent === "Count of STREAM frames sent (regardless of size, includes retransmits)",
            ),
        ).toBe(true);
        expect(data.querySelectorAll("rect.packet").length).toBeGreaterThan(100);
    });

    it("dispose removes the drawing", () => {
        const data = div();
        const r = new MultiplexingGraphD3CollapsedRenderer(data, div(), div());
        r.render(hand());
        r.dispose();
        expect(data.childElementCount).toBe(0);
        expect(r.byteRangeRenderer).toBeUndefined();
    });
});

describe("MultiplexingGraphD3WaterfallRenderer", () => {
    it("one group per stream with bar, circle, square and triangle; legend; click handlers", () => {
        const el = div();
        const upper = vi.fn<(d: StreamDetail) => void>();
        const w = new MultiplexingGraphD3WaterfallRenderer(el, upper);
        const lower = vi.fn<(id: string) => void>();
        w.onStreamClicked = lower;
        expect(w.render(hand())).toBe(true);

        expect(el.querySelector("svg")!.getAttribute("height")).toBe("154");
        expect(el.querySelectorAll("rect.packet")).toHaveLength(3);
        expect(el.querySelectorAll("g > g > g > circle")).toHaveLength(3);
        expect(el.querySelectorAll("g > g > g > rect:not(.packet)")).toHaveLength(3); // HEADERS squares
        expect(el.querySelectorAll("path")).toHaveLength(1); // the PRIORITY_UPDATE of stream 8
        const texts = [...el.querySelectorAll("text")].map((t) => t.textContent);
        expect(texts).toEqual([
            "Request sent",
            'Colored while stream is "active" (between first and last STREAM frame received)',
        ]);
        expect(el.querySelector("clipPath")!.id).toMatch(/^mux-waterfall-clip-\d+$/);

        el.querySelectorAll("rect.packet")[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(upper).toHaveBeenCalledTimes(1);
        expect(upper.mock.calls[0][0].stream_id).toBe(8);
        expect(upper.mock.calls[0][0].data.h3Info!.priorityString).toBe("FRAME: u=1, i -> HEADER: u=3");
        expect(lower).toHaveBeenCalledWith("8");
    });

    it("empty state: message and a 150 px SVG (M36)", () => {
        const el = div();
        const w = new MultiplexingGraphD3WaterfallRenderer(el, () => {});
        w.render(trace([]));
        expect(el.querySelector("svg")!.getAttribute("height")).toBe("150");
        expect(el.querySelector("text")!.textContent).toBe(WATERFALL_EMPTY_MESSAGE);
        expect(el.querySelectorAll("rect.packet")).toHaveLength(0);

        // one stream only: still the message (154 px)
        w.render(
            trace([
                sent(1, [streamFrame(0, 0, 10)]),
                ...[2, 3, 4, 5, 6].map((t) => received(t, [streamFrame(0, (t - 2) * 10, 10)])),
            ]),
        );
        expect(el.querySelector("svg")!.getAttribute("height")).toBe("154");
        expect(el.querySelector("text")!.textContent).toBe(WATERFALL_EMPTY_MESSAGE);
    });

    it("server legend (M10 FIX) and anchoring (M11 FIX)", () => {
        const el = div();
        new MultiplexingGraphD3WaterfallRenderer(el, () => {}).render(
            loadFixture("multiplexing-par10-server.sqlog").getConnections()[0],
        );
        const texts = [...el.querySelectorAll("text")].map((t) => t.textContent);
        expect(texts).toEqual([
            "Request received",
            'Colored while stream is "active" (between first and last STREAM frame sent)',
        ]);
        expect(el.querySelectorAll("rect.packet")).toHaveLength(10);

        const small = div();
        new MultiplexingGraphD3WaterfallRenderer(small, () => {}).render(hand());
        // xDomain(0) = -1579 / 14 < -20: clamped to the left margin
        expect(small.querySelector("svg > g > g > circle")!.getAttribute("cx")).toBe(String(-20 + 6.5));
    });
});

describe("MultiplexingGraphD3ByterangesRenderer", () => {
    it("zoom is a no-op before the first render; empty input clears", () => {
        const el = div();
        const b = new MultiplexingGraphD3ByterangesRenderer(el);
        expect(() => b.zoom({ domain: () => [1, 2] } as never)).not.toThrow();
        expect(b.render([], [], 0)).toBe(false);
        expect(el.childElementCount).toBe(0);
    });

    it("stream 0 absent: no rects and a single 0 tick (v5 tick format)", () => {
        const conn = trace([sent(1, [streamFrame(4, 0, 10)]), received(2, [streamFrame(4, 0, 100)])]);
        const { dataSent, dataMoved } = extractCollapsedData(conn);
        const el = div();
        new MultiplexingGraphD3ByterangesRenderer(el).render(dataSent, dataMoved, 0);
        expect(el.querySelectorAll("rect.packet")).toHaveLength(0);
        const yTicks = [...el.querySelectorAll("svg > g > g:nth-of-type(2) .tick text")].map((t) => t.textContent);
        expect(yTicks).toEqual(["0"]);
    });
});

describe("d3 v5 (qvis) behaviour on d3 v7", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("axes keep d3 v5's 0.5px offset on high-DPI screens (d3-axis v3 drops it when devicePixelRatio > 1)", () => {
        vi.stubGlobal("devicePixelRatio", 2);
        const data = div();
        const br = div();
        new MultiplexingGraphD3CollapsedRenderer(data, div(), br).render(hand());
        const W = 1639 - 60;
        expect(data.querySelector(".domain")!.getAttribute("d")).toBe(`M0.5,6V0.5H${W + 0.5}V6`);
        const tick = data.querySelector(".tick")!;
        expect(tick.getAttribute("transform")).toMatch(/^translate\(\d+(\.\d+)?,0\)$/);
        const [x, y] = br.querySelectorAll(".domain");
        expect(x.getAttribute("d")).toBe(`M0.5,-6V0.5H${W + 0.5}V-6`);
        expect(y.getAttribute("d")).toBe("M6,0.5H0.5V500.5H6"); // axisRight
        // x tick "2" at xDomain(2) + 0.5, y tick "0" at yDomain(0) + 0.5
        const tickAt = (text: string) =>
            [...br.querySelectorAll(".tick")].find((t) => t.textContent === text)!.getAttribute("transform");
        expect(tickAt("2")).toBe(`translate(${W / 15 + 0.5},0)`);
        expect(tickAt("0")).toBe("translate(0,0.5)");
        // after a strip click: zoom() redraws both byte-range axes (axisLeft, M6), still with the offset
        data.querySelectorAll("rect.packet")[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(br.querySelectorAll(".domain")[0].getAttribute("d")).toBe(`M0.5,-6V0.5H${W + 0.5}V-6`);
        expect(br.querySelectorAll(".domain")[1].getAttribute("d")).toBe("M-6,0.5H0.5V500.5H-6");
    });

    it("a trackpad pinch (ctrl+wheel) does not zoom the strip, a plain wheel does (d3-zoom v1 gestures)", () => {
        const data = div();
        new MultiplexingGraphD3CollapsedRenderer(data, div(), null).render(hand());
        const tickTexts = () => [...data.querySelectorAll(".tick text")].map((t) => t.textContent).join(",");
        const before = tickTexts();
        const frame = data.querySelectorAll("rect.packet")[7];
        const wheel = (ctrlKey: boolean) =>
            new WheelEvent("wheel", { deltaY: -500, ctrlKey, bubbles: true, cancelable: true, clientX: 700 });

        const pinch = wheel(true);
        frame.dispatchEvent(pinch);
        expect(tickTexts()).toBe(before);
        expect(pinch.defaultPrevented).toBe(false); // left to the browser (page zoom), as in qvis

        const plain = wheel(false);
        frame.dispatchEvent(plain);
        expect(tickTexts()).not.toBe(before);
        expect(plain.defaultPrevented).toBe(true);
    });

    it("v5 zoom filter and wheel delta", () => {
        expect(v5ZoomFilter({ ctrlKey: true, button: 0 })).toBe(false);
        expect(v5ZoomFilter({ ctrlKey: false, button: 1 })).toBe(false);
        expect(v5ZoomFilter({ ctrlKey: false, button: 0 })).toBe(true);
        expect(v5ZoomFilter({})).toBe(true); // touch events have neither
        expect(v5WheelDelta(new WheelEvent("wheel", { deltaY: -500 }))).toBe(1);
        expect(v5WheelDelta(new WheelEvent("wheel", { deltaY: -500, ctrlKey: true }))).toBe(1); // v3: 10
        expect(v5WheelDelta(new WheelEvent("wheel", { deltaY: -20, deltaMode: 1 }))).toBe(1);
    });
});

describe("MultiplexingGraphD3SimulationRenderer (dead in qvis, never mounted)", () => {
    it("renders one box per request", () => {
        const el = div();
        new MultiplexingGraphD3SimulationRenderer(el).render(hand());
        expect([...el.querySelectorAll("text")].map((t) => t.textContent)).toEqual([
            "GET /index.html",
            "GET /style.css",
            "GET /app.js",
        ]);
        expect(el.querySelectorAll("rect.packet")).toHaveLength(3);
    });
});
