// Canvas drawing primitives of the congestion graph renderer (jsdom + a recording 2D context). Pixel-level parity with
// hosted qvis is checked in the browser (tests/e2e/congestion.spec.ts); these tests pin the canvas calls that define
// those pixels: qvis drawRect is `beginPath(); fillStyle = c; rect(...); fill()` per rectangle, in per-packet order
// (sent, its ACK, its loss). fillRect anti-aliases fractional edges differently, so it is only allowed for batched
// drawing above 50k packets (spec §8.7).

import { ev, file, loaded, trace } from "@/model/__fixtures__/qlog";
import { QlogLoader } from "@/model/QlogLoader";
import { buildCongestionModel } from "./congestionModel";
import CongestionGraphD3Renderer from "./CongestionGraphD3Renderer";

interface Recorder {
    ctx: CanvasRenderingContext2D;
    calls: string[];
}

/** A fake 2D context that records every method call and property assignment. */
function recorder(): Recorder {
    const calls: string[] = [];
    const state: Record<string, unknown> = {};
    const ctx = new Proxy(state, {
        get(target, prop) {
            if (typeof prop === "symbol") return undefined;
            if (prop in target) return target[prop];
            return (...args: unknown[]) => {
                calls.push(prop + "(" + args.map((a) => (typeof a === "number" ? +a.toFixed(3) : a)).join(",") + ")");
                return { data: new Uint8ClampedArray(4) };
            };
        },
        set(target, prop, value) {
            target[prop as string] = value;
            calls.push(String(prop) + "=" + value);
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
}

function connectionOf(events: unknown[]) {
    const group = QlogLoader.fromJSON(loaded(file([trace(events, { vantage_point: { type: "server" } })])));
    if (!group) throw new Error("not loaded");
    return group.getConnections()[0];
}

const sent = (t: number, pn: number, length = 1200) =>
    ev(t, "quic:packet_sent", { header: { packet_type: "1RTT", packet_number: pn }, raw: { length } });

let main: Recorder;
let rtt: Recorder;
let host: HTMLDivElement;

beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    main = recorder();
    rtt = recorder();
    const contexts = [main, rtt];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => contexts.shift()!.ctx as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );
    host = document.createElement("div");
    document.body.appendChild(host);
});
afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
});

/** The main-canvas calls of the last redraw that paint rectangles (between clearRect and the first line). */
function rectCalls(calls: string[]): string[] {
    const start = calls.lastIndexOf(calls.filter((c) => c.startsWith("clearRect(")).pop()!);
    const end = calls.findIndex((c, i) => i > start && c.startsWith("lineWidth="));
    return calls.slice(start + 1, end === -1 ? undefined : end);
}

/** The calls that draw the bytes-in-flight series (#808000): its polyline stroke, then its markers. */
function bytesInFlightCalls(calls: string[]): string[] {
    const start = calls.indexOf("strokeStyle=#808000");
    const end = calls.findIndex((c, i) => i > start && c.startsWith("lineWidth="));
    return calls.slice(start, end).map((c) => c.replace(/\(.*\)$/, "()"));
}

/** A recovery_metrics_updated event with bytes in flight: step series [t,0], [t,v], [xMax + 11, v] (3 points). */
const metrics = (t: number) => ev(t, "quic:recovery_metrics_updated", { bytes_in_flight: 2400 });

describe("CongestionGraphD3Renderer drawing", () => {
    it("paints every rectangle with qvis' drawRect primitive, per packet: sent, ACK, loss", () => {
        const conn = connectionOf([
            sent(1, 0),
            sent(2, 1),
            ev(30, "quic:packet_received", {
                header: { packet_type: "1RTT", packet_number: 0 },
                raw: { length: 40 },
                frames: [{ frame_type: "ack", acked_ranges: [[0, 1]] }],
            }),
            ev(40, "quic:packet_lost", { header: { packet_type: "1RTT", packet_number: 1 } }),
            metrics(25),
        ]);
        const renderer = new CongestionGraphD3Renderer(host, null);
        renderer.render(buildCongestionModel(conn));

        const calls = rectCalls(main.calls);
        expect(calls.some((c) => c.startsWith("fillRect("))).toBe(false);
        // five call groups of beginPath / fillStyle / rect / fill
        const groups: string[][] = [];
        for (let i = 0; i < calls.length; i += 4) groups.push(calls.slice(i, i + 4));
        expect(groups.map((g) => g.map((c) => c.replace(/\(.*\)$/, "()")))).toEqual([
            ["beginPath()", "fillStyle=#0000FF", "rect()", "fill()"], // packet 0 sent
            ["beginPath()", "fillStyle=#6B8E23", "rect()", "fill()"], // packet 0 ACK
            ["beginPath()", "fillStyle=#0000FF", "rect()", "fill()"], // packet 1 sent
            ["beginPath()", "fillStyle=#6B8E23", "rect()", "fill()"], // packet 1 ACK
            ["beginPath()", "fillStyle=#FF0000", "rect()", "fill()"], // packet 1 loss
        ]);
        // width 3 * drawScaleX(1x) = 4.407; ACK and loss share the sent packet's y range
        const rects = calls.filter((c) => c.startsWith("rect("));
        for (const r of rects) expect(r.split(",")[2]).toBe("4.407");
        expect(rects[1].split(",").slice(1)).toEqual(rects[0].split(",").slice(1));
        expect(rects[4].split(",").slice(1)).toEqual(rects[2].split(",").slice(1));

        // qvis drawLines + drawCircle: the polyline, then one filled path per marker. No marker on the first point
        // ([25, 0]); the last one ([xMax + 11, 2400] = 41 ms on a [0, 40] ms axis, past the right edge) is
        // invisible and skipped.
        expect(bytesInFlightCalls(main.calls)).toEqual([
            "strokeStyle=#808000",
            "moveTo()",
            "lineTo()",
            "lineTo()",
            "stroke()",
            ...["fillStyle=#808000", "beginPath()", "arc()", "fill()"],
        ]);
        renderer.dispose();
    });

    it("batches rectangles per colour with fillRect above 50k packets (spec §8.7)", () => {
        const events: unknown[] = [];
        for (let pn = 0; pn <= 50000; ++pn) events.push(sent(pn / 10, pn, 1000));
        events.push(metrics(5001));
        const renderer = new CongestionGraphD3Renderer(host, null);
        renderer.render(buildCongestionModel(connectionOf(events)));

        const calls = rectCalls(main.calls);
        expect(calls.some((c) => c.startsWith("rect("))).toBe(false);
        expect(calls.filter((c) => c.startsWith("fillRect(")).length).toBe(50001);
        // one fillStyle per colour pass, sent first
        expect(calls.filter((c) => c.startsWith("fillStyle="))).toEqual([
            "fillStyle=#0000FF",
            "fillStyle=#6B8E23",
            "fillStyle=#FF0000",
        ]);
        // markers of a series in one path, filled once
        expect(bytesInFlightCalls(main.calls)).toEqual([
            "strokeStyle=#808000",
            "moveTo()",
            "lineTo()",
            "lineTo()",
            "stroke()",
            "beginPath()",
            ...["moveTo()", "arc()"],
            ...["moveTo()", "arc()"],
            "fillStyle=#808000",
            "fill()",
        ]);
        renderer.dispose();
    });
});

describe("CongestionGraphD3Renderer layout and ruler", () => {
    it("re-lays out the right congestion axis on a host resize (FIX Q19)", () => {
        vi.useFakeTimers();
        let onResize: (() => void) | undefined;
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(cb: () => void) {
                    onResize = cb;
                }
                observe() {}
                disconnect() {}
            },
        );
        let width = 1590;
        Object.defineProperty(host, "clientWidth", { configurable: true, get: () => width });
        const conn = connectionOf([sent(1, 0), sent(2, 1), metrics(1.5)]);
        const renderer = new CongestionGraphD3Renderer(host, null);
        renderer.render(buildCongestionModel(conn));
        const rightAxis = () => host.querySelector("#mainGraphContainer g.nogrid") as SVGGElement;
        const tickX2 = () => [...rightAxis().querySelectorAll(".tick line")].map((l) => l.getAttribute("x2"));
        expect(new Set(tickX2())).toEqual(new Set(["1450"]));

        width = 1190;
        onResize!();
        vi.advanceTimersByTime(150);
        // ticks (and their labels at x2 + 3) and the frame follow the new plot width 1190 - 140
        expect(new Set(tickX2())).toEqual(new Set(["1050"]));
        expect(rightAxis().querySelector(".tick text")!.getAttribute("x")).toBe("1053");
        expect(rightAxis().querySelector(".domain")!.getAttribute("d")).toBe("M1050,520.5H0.5V0.5H1050");
        renderer.dispose();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("ruler: takes qvis' offsetX / offsetY of the ruler layer (whole pixels in Chrome)", () => {
        const conn = connectionOf([sent(1, 0), sent(2, 1)]);
        const renderer = new CongestionGraphD3Renderer(host, null);
        renderer.render(buildCongestionModel(conn));
        renderer.useRuler();
        const layer = host.querySelectorAll("#mainGraphContainer > svg")[6] as SVGSVGElement;
        const mouse = (type: string, offsetX: number, offsetY: number) => {
            // d3.pointer would give clientX - left = 12.6 / 17.3 here; Chrome's offsetX / offsetY are integers
            const e = new MouseEvent(type, { bubbles: true, clientX: 12.6, clientY: 17.3, buttons: 1 });
            Object.defineProperty(e, "offsetX", { value: offsetX });
            Object.defineProperty(e, "offsetY", { value: offsetY });
            layer.dispatchEvent(e);
        };
        mouse("mousedown", 300, 400);
        mouse("mousemove", 500, 200);
        const lines = [...layer.querySelectorAll("line")].map((l) =>
            ["x1", "y1", "x2", "y2"].map((a) => l.getAttribute(a)).join(" "),
        );
        expect(lines).toEqual(["300 400 500 200", "300 400 500 400", "500 400 500 200"]);
        const texts = [...layer.querySelectorAll("text")].map((t) => [t.getAttribute("x"), t.getAttribute("y")]);
        expect(texts).toEqual([
            ["400", "412"], // time: under the horizontal leg when dragging upwards
            ["512", "300"], // bytes: right of the vertical leg, at its middle
            ["400", "270"], // rate: the diagonal's midpoint, 30px higher
        ]);
        window.dispatchEvent(new MouseEvent("mouseup"));
        expect(layer.querySelectorAll("line, text")).toHaveLength(0);
        renderer.dispose();
    });
});
