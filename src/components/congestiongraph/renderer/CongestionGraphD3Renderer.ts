// Port of qvis congestiongraph/renderer/CongestionGraphD3Renderer.ts (D3 v5 -> v7), parity/congestion-graph.md.
//
// Structure kept from qvis: an axes SVG + a canvas for the main graph, six stacked transparent SVG "mode layers" over
// it (the one with z-index 1 receives the mouse), and an axes SVG + canvas for the RTT graph below. Data preparation
// (qvis parseQlog) lives in congestionModel.ts; the renderer only draws a CongestionModel and handles interaction.
//
// Framework-free (ARCHITECTURE §4): the constructor takes the `#congestion-graph` host element and the `#packetInfo`
// tooltip element; `render(model)` draws (first call creates the DOM), `clear()` returns to the never-rendered state,
// `dispose()` removes everything this class added (DOM, listeners, timers, body cursor).
//
// Deliberate deviations from qvis (spec §7): Q4, Q8, Q9, Q10, Q12, Q14, Q16, Q17, Q18 (HiDPI canvases), Q19 (width
// of the host instead of window.innerWidth, re-layout on resize), Q26 (brushes created once), Q5 (RTT tick labels).
// The dormant received perspective, the picker and the selection brush are not ported (§3.11).

import * as d3 from "d3";
import type { NumberValue, ScaleLinear } from "d3";
import type { CgPacket, CongestionModel, Pt } from "./congestionModel";
import { findYExtrema, rttDomain } from "./congestionModel";
import {
    ackTooltip,
    kFormat,
    lossTooltip,
    rttTickFormat,
    rulerTexts,
    sentTooltip,
    type TooltipContent,
} from "./format";
import { MainGraphState, type AnySelection } from "./MainGraphState";
import { RecoveryGraphState } from "./RecoveryGraphState";
import { panClamp, wheelZoom, xDrawScale } from "./viewport";

type Mode = "panning" | "brushX" | "brush2d" | "selection" | "pick" | "ruler";
/** A line marker (qvis tickDrawFunction), plus a batched form that adds it to one shared path. */
interface Marker {
    draw(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void;
    /** adds the marker to the current path; the caller fills ("fill") or strokes ("stroke") once */
    addToPath(ctx: CanvasRenderingContext2D, x: number, y: number): void;
    paint: "fill" | "stroke";
}

const COLOR_SENT = "#0000FF";
const COLOR_ACK = "#6B8E23";
const COLOR_LOSS = "#FF0000";

/**
 * Spec §8.7: up to this many (sized) sent packets the canvas output is identical to qvis. Above it, rectangles are
 * batched per colour with fillRect and the line markers of each series are drawn as one path, which only changes
 * anti-aliased edges where marks overlap. (The massive demo, 36.8k packets with a 110k-point bytes-in-flight series,
 * stays exact and still redraws faster than qvis: ~140 ms vs ~160 ms at full zoom-out, 29 ms vs 44 ms per pan step.)
 */
const BATCH_THRESHOLD = 50000;
const RESIZE_DEBOUNCE_MS = 150;

interface RulerState {
    /** Removes the ruler's listeners and elements and restores the body cursor from before it was armed. */
    cancel(): void;
}

/** d3's default linear tick format with an ASCII hyphen-minus (d3-format 3 uses U+2212; qvis used d3-format 1). */
function asciiMinusFormat(scale: ScaleLinear<number, number>): (d: NumberValue) => string {
    const f = scale.tickFormat(10);
    return (d) => f(d).replace(/−/g, "-");
}

export default class CongestionGraphD3Renderer {
    private readonly host: HTMLElement;
    private readonly packetInfo: HTMLElement | null;

    private model: CongestionModel | undefined = undefined;
    private mainGraphState!: MainGraphState;
    private recoveryGraphState!: RecoveryGraphState;

    private mainGraphContainer?: AnySelection<HTMLDivElement>;
    private recoveryGraphContainer?: AnySelection<HTMLDivElement>;

    private isInitialised = false;
    private mode: Mode = "panning";
    private ruler: RulerState | undefined = undefined;
    private rttYAxis: d3.Axis<NumberValue> | null = null;

    private resizeObserver: ResizeObserver | undefined = undefined;
    private resizeTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    constructor(host: HTMLElement, packetInfo: HTMLElement | null) {
        this.host = host;
        this.packetInfo = packetInfo;
    }

    // ============================================================================================ public API (buttons)

    public useBrushX(): void {
        if (!this.isReady()) return; // Q10
        this.setMode("brushX");
    }

    public useBrush2d(): void {
        if (!this.isReady()) return;
        this.setMode("brush2d");
    }

    public usePanning(): void {
        if (!this.isInitialised) return;
        this.setMode("panning");
    }

    /** "Ruler (press R)": one-shot measuring line (R:85-279) with the Q9 fixes. */
    public useRuler(): void {
        if (!this.isReady()) return;
        if (this.ruler !== undefined) return; // Q9: one active ruler at a time
        this.setMode("ruler");

        const previousCursor = document.body.style.cursor;
        document.body.style.cursor = "pointer";

        const layer = this.mainGraphState.mouseHandlerRulerSvg!;
        const node = layer.node()!;
        const linePoints = { x1: 0, y1: 0, x2: 0, y2: 0 };
        let elements: { remove(): unknown }[] = [];
        let line: AnySelection<SVGLineElement> | undefined;
        let lineHorizontal: AnySelection<SVGLineElement> | undefined;
        let lineVertical: AnySelection<SVGLineElement> | undefined;
        let textTime: AnySelection<SVGTextElement> | undefined;
        let textBytes: AnySelection<SVGTextElement> | undefined;
        let textRate: AnySelection<SVGTextElement> | undefined;

        const appendText = (baseline: string, anchor: string, text: string): AnySelection<SVGTextElement> =>
            layer
                .append("text")
                .attr("dominant-baseline", baseline)
                .style("text-anchor", anchor)
                // qvis sets the unitless "14", which Chrome applies as 14px (checked against the hosted qvis)
                .style("font-size", "14px")
                .style("font-family", "Trebuchet MS")
                .style("font-style", "italic")
                .style("stroke", "white")
                .style("stroke-width", 5)
                .style("paint-order", "stroke")
                .style("pointer-events", "none")
                .attr("fill", "#000000")
                .text(text);

        // qvis read evt.offsetX / offsetY (R:106-109, R:189-190): Chrome reports them as whole pixels of the target.
        // The ruler elements ignore the mouse (Q9), so the target is always the ruler layer and offsetX/Y are reliable;
        // d3.pointer would give fractional coordinates (blurry legs, slightly different values) on a page whose
        // layout puts the plot at a fractional offset.
        const layerPoint = (evt: MouseEvent): [number, number] =>
            evt.target === node && Number.isFinite(evt.offsetX) && Number.isFinite(evt.offsetY)
                ? [evt.offsetX, evt.offsetY]
                : d3.pointer(evt, node);

        const handleDrawing = (evt: MouseEvent): void => {
            const [x2, y2] = layerPoint(evt);
            linePoints.x2 = x2;
            linePoints.y2 = y2;

            line!.attr("x2", "" + linePoints.x2).attr("y2", "" + linePoints.y2);
            lineHorizontal!.attr("x2", "" + linePoints.x2).attr("y2", "" + linePoints.y1);
            lineVertical!
                .attr("x1", "" + linePoints.x2)
                .attr("x2", "" + linePoints.x2)
                .attr("y2", "" + linePoints.y2);

            const persp = this.mainGraphState.sent;
            const texts = rulerTexts(
                persp.xScale!.invert(linePoints.x1),
                persp.xScale!.invert(linePoints.x2),
                persp.yScale!.invert(linePoints.y1),
                persp.yScale!.invert(linePoints.y2),
            );

            const timeCenter = Math.min(linePoints.x1, linePoints.x2) + Math.abs(linePoints.x1 - linePoints.x2) / 2;
            const bytesCenter = Math.min(linePoints.y1, linePoints.y2) + Math.abs(linePoints.y1 - linePoints.y2) / 2;
            const rateCenterX = (linePoints.x1 + linePoints.x2) / 2;
            const rateCenterY = (linePoints.y1 + linePoints.y2) / 2;

            textTime!
                .attr("x", timeCenter)
                .attr("y", linePoints.y1 + (linePoints.y1 > linePoints.y2 ? 12 : -20))
                .text(texts.time);
            textBytes!
                .attr("x", Math.max(linePoints.x1, linePoints.x2) + 12)
                .attr("y", bytesCenter)
                .text(texts.bytes);
            textRate!
                .attr("x", rateCenterX)
                .attr("y", rateCenterY + (linePoints.y1 > linePoints.y2 ? -30 : 20))
                .text(texts.rate);
        };

        const removeElements = (): void => {
            for (const el of elements) el.remove();
            elements = [];
        };

        const stopDrawing = (): void => {
            node.removeEventListener("mousemove", handleDrawing);
            removeElements();
            this.ruler = undefined;
            document.body.style.cursor = "default";
            this.usePanning();
        };

        const startDrawing = (evt: MouseEvent): void => {
            const [x1, y1] = layerPoint(evt);
            linePoints.x1 = linePoints.x2 = x1;
            linePoints.y1 = linePoints.y2 = y1;

            const appendLine = (stroke: string, width: number): AnySelection<SVGLineElement> =>
                layer
                    .append("line")
                    .attr("stroke", stroke)
                    .attr("stroke-width", width)
                    .attr("x1", "" + linePoints.x1)
                    .attr("y1", "" + linePoints.y1)
                    .attr("x2", "" + linePoints.x2)
                    .attr("y2", "" + linePoints.y2)
                    .style("pointer-events", "none");

            // the main (typically diagonal) line, then its horizontal and vertical legs
            line = appendLine("pink", 10).style("opacity", "0.7").attr("class", "ruler");
            lineHorizontal = appendLine("black", 2);
            lineVertical = appendLine("black", 2);
            textTime = appendText("hanging", "middle", "time");
            textBytes = appendText("central", "start", "bytes");
            textRate = appendText("hanging", "middle", "rate");
            elements = [line, lineHorizontal, lineVertical, textTime, textBytes, textRate];

            node.addEventListener("mousemove", handleDrawing);
            // Q9: end on any mouseup, also outside the plot
            window.addEventListener("mouseup", stopDrawing, { once: true });
        };

        node.addEventListener("mousedown", startDrawing, { once: true });

        this.ruler = {
            cancel: () => {
                node.removeEventListener("mousedown", startDrawing);
                node.removeEventListener("mousemove", handleDrawing);
                window.removeEventListener("mouseup", stopDrawing);
                removeElements();
                this.ruler = undefined;
                document.body.style.cursor = previousCursor;
            },
        };
    }

    public toggleCongestionGraph(): void {
        if (!this.isReady()) return;
        this.mainGraphState.congestionGraphEnabled = !this.mainGraphState.congestionGraphEnabled;
        this.redrawCurrent();
    }

    public toggleZoomingRTTGraph(): void {
        if (!this.isReady()) return;
        this.recoveryGraphState.zooming0RTTenabled = !this.recoveryGraphState.zooming0RTTenabled;
        this.redrawCurrent();
    }

    public resetZoom(): void {
        if (!this.isReady()) return;
        const persp = this.mainGraphState.currentPerspective();
        persp.rangeX = persp.originalRangeX;
        persp.rangeY = persp.originalRangeY;
        this.redrawCurrent();
    }

    /** Draws `model` (qvis render(config)). The zoom resets; toggles and the interaction mode are kept. */
    public render(model: CongestionModel): void {
        this.model = model;

        if (!this.isInitialised) {
            this.init();
            this.isInitialised = true;
        } else {
            this.mainGraphState.reset();
            this.recoveryGraphState.reset();
        }

        this.setup();
        this.renderParts();
    }

    /** Back to the never-rendered state (no trace selected): removes the graphs, resets toggles and mode. */
    public clear(): void {
        this.teardown();
        this.model = undefined;
    }

    public dispose(): void {
        this.teardown();
        this.model = undefined;
    }

    /** Current interaction mode (tests, debugging). */
    public getMode(): Mode {
        return this.mode;
    }

    /** Current visible ranges (tests, debugging). */
    public getRanges(): { x: [number, number]; y: [number, number] } | undefined {
        if (!this.isReady()) return undefined;
        const p = this.mainGraphState.sent;
        return { x: [p.rangeX[0], p.rangeX[1]], y: [p.rangeY[0], p.rangeY[1]] };
    }

    // ============================================================================================ lifecycle

    private isReady(): boolean {
        return this.isInitialised && this.model !== undefined;
    }

    private teardown(): void {
        this.ruler?.cancel();
        this.ruler = undefined;
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
        this.resizeTimer = undefined;
        this.mainGraphContainer?.remove();
        this.recoveryGraphContainer?.remove();
        this.mainGraphContainer = undefined;
        this.recoveryGraphContainer = undefined;
        this.clearPacketInfoWidget();
        this.isInitialised = false;
        this.mode = "panning";
        this.rttYAxis = null;
    }

    /** Width of the plot host inside its 5px border (FIX Q19: qvis used window.innerWidth, which overflowed). */
    private measureWidth(): number {
        const w = this.host.clientWidth;
        if (w > 0) return w;
        return typeof window !== "undefined" ? Math.max(0, window.innerWidth - 10) : 0;
    }

    // Called on first render only: creates the elements that are reused over renders (R:356-536).
    private init(): void {
        const host = d3.select(this.host);

        // Containers first: their height can add a vertical scrollbar, which must be accounted for in the width.
        this.mainGraphContainer = host
            .append<HTMLDivElement>("div")
            .attr("id", "mainGraphContainer")
            .style("height", "600px");
        this.recoveryGraphContainer = host
            .append<HTMLDivElement>("div")
            .attr("id", "recoveryGraphContainer")
            .style("height", "300px");

        const width = this.measureWidth();
        const ms = (this.mainGraphState = new MainGraphState(width));
        const rs = (this.recoveryGraphState = new RecoveryGraphState(width));

        // Contains the chart axes, grid, labels
        ms.svg = this.mainGraphContainer.append<SVGSVGElement>("svg").style("position", "absolute");
        ms.graphSvg = ms.svg
            .append<SVGGElement>("g")
            .attr("transform", "translate(" + ms.margins.left + ", " + ms.margins.top + ")");

        // Canvas on which the plots are drawn
        ms.canvas = this.mainGraphContainer
            .append<HTMLCanvasElement>("canvas")
            .attr("role", "img")
            .attr("aria-label", "Congestion graph: data sent, acknowledged and lost over time")
            .style("margin-left", ms.margins.left + "px")
            .style("margin-top", ms.margins.top + "px")
            .style("position", "absolute");

        // Mode layers: whichever has z-index 1 receives the mouse (later siblings win among equal z-indexes)
        const layer = (zIndex: number): AnySelection<SVGSVGElement> =>
            this.mainGraphContainer!.append<SVGSVGElement>("svg")
                .style("margin-left", ms.margins.left + "px")
                .style("margin-top", ms.margins.top + "px")
                .style("z-index", zIndex)
                .style("position", "absolute");
        ms.mouseHandlerPanningSvg = layer(1); // enabled by default
        ms.mouseHandlerBrushXSvg = layer(0);
        ms.mouseHandlerBrush2dSvg = layer(0);
        ms.mouseHandlerSelectionSvg = layer(0);
        ms.mouseHandlerPickSvg = layer(0);
        ms.mouseHandlerRulerSvg = layer(0);

        rs.svg = this.recoveryGraphContainer.append<SVGSVGElement>("svg").style("position", "absolute");
        rs.graphSvg = rs.svg
            .append<SVGGElement>("g")
            .attr("transform", "translate(" + rs.margins.left + ", " + rs.margins.top + ")");

        rs.canvas = this.recoveryGraphContainer
            .append<HTMLCanvasElement>("canvas")
            .attr("role", "img")
            .attr("aria-label", "RTT graph: min, smoothed and latest RTT over time")
            .style("margin-left", rs.margins.left + "px")
            .style("margin-top", rs.margins.top + "px")
            .style("position", "absolute");

        ms.canvasContext = ms.canvas.node()!.getContext("2d", { willReadFrequently: true });
        rs.canvasContext = rs.canvas.node()!.getContext("2d");

        // Graphical axes, reused for all renders
        ms.gxAxis = ms.graphSvg.append<SVGGElement>("g").attr("class", "grid");
        ms.gyAxis = ms.graphSvg.append<SVGGElement>("g").attr("class", "grid");
        ms.gyCongestionAxis = ms.graphSvg.append<SVGGElement>("g").attr("class", "nogrid");
        rs.gxAxis = rs.graphSvg.append<SVGGElement>("g").attr("class", "grid");
        rs.gyAxis = rs.graphSvg.append<SVGGElement>("g").attr("class", "grid");

        /* Axis labels */
        ms.graphSvg
            .append("text")
            .attr("x", "-" + ms.innerHeight / 2)
            .attr("dy", "-3.5em")
            .attr("transform", "rotate(-90)")
            .text("Data (bytes)");
        ms.xAxisText = ms.graphSvg.append<SVGTextElement>("text").text("Time (ms)");
        ms.congestionAxisText = ms.graphSvg.append<SVGTextElement>("text").text("Congestion info (bytes)");
        rs.xAxisText = rs.graphSvg.append<SVGTextElement>("text").text("Time (ms)");
        rs.graphSvg
            .append("text")
            .attr("x", "-" + rs.innerHeight / 2)
            .attr("dy", "-3.5em")
            .attr("transform", "rotate(-90)")
            .text("RTT (ms)");

        // Brushes and handlers are created once (FIX Q26); they read the current model at event time.
        ms.brushX = d3.brushX().on("end", (event: d3.D3BrushEvent<unknown>) => this.onBrushXEnd(event));
        ms.brushXElement = ms.mouseHandlerBrushXSvg.append<SVGGElement>("g").attr("class", "brush");
        ms.brush2d = d3.brush().on("end", (event: d3.D3BrushEvent<unknown>) => this.onBrush2dEnd(event));
        ms.brush2dElement = ms.mouseHandlerBrush2dSvg.append<SVGGElement>("g").attr("class", "brush");

        const onZoom = (event: WheelEvent): void => this.onZoom(event);
        const onHover = (event: MouseEvent): void => this.onHover(event);
        ms.mouseHandlerPanningSvg
            .on("wheel", onZoom, { passive: false })
            .on("mousemove.pan", (event: MouseEvent) => this.onPan(event))
            .on("mousemove.hover", onHover);
        ms.brushXElement.on("wheel", onZoom, { passive: false }).on("mousemove", onHover);
        ms.brush2dElement.on("wheel", onZoom, { passive: false }).on("mousemove", onHover);

        this.applyGeometry();

        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => this.onHostResize());
            this.resizeObserver.observe(this.host);
        }
    }

    /** Sets every width-dependent attribute (initially and on re-layout, FIX Q19) and the canvas backing stores. */
    private applyGeometry(): void {
        const ms = this.mainGraphState;
        const rs = this.recoveryGraphState;
        const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
        ms.dpr = dpr;
        const iw = Math.max(0, ms.innerWidth);
        const riw = Math.max(0, rs.innerWidth);

        ms.svg!.attr("width", ms.outerWidth).attr("height", ms.outerHeight);
        for (const l of this.layers()) l.attr("width", iw).attr("height", ms.innerHeight);
        this.sizeCanvas(ms.canvas!, ms.canvasContext, iw, ms.innerHeight, dpr);
        rs.svg!.attr("width", rs.outerWidth).attr("height", rs.outerHeight);
        this.sizeCanvas(rs.canvas!, rs.canvasContext, riw, rs.innerHeight, dpr);

        ms.gxAxis!.attr("transform", "translate(0, " + ms.innerHeight + ")");
        rs.gxAxis!.attr("transform", "translate(0, " + rs.innerHeight + ")");
        ms.xAxisText!.attr("x", "" + ms.innerWidth / 2).attr("y", "" + (ms.innerHeight + 40));
        ms.congestionAxisText!.attr(
            "transform",
            "translate(" + (ms.innerWidth + ms.margins.right / 2) + ", " + ms.innerHeight / 2 + "), rotate(-90)",
        );
        rs.xAxisText!.attr("x", "" + rs.innerWidth / 2).attr("y", "" + (rs.innerHeight + 40));

        const extent: [[number, number], [number, number]] = [
            [0, 0],
            [iw, ms.innerHeight],
        ];
        ms.brushX!.extent(extent);
        ms.brush2d!.extent(extent);
        ms.brushXElement!.call(ms.brushX!);
        ms.brush2dElement!.call(ms.brush2d!);
    }

    private sizeCanvas(
        canvas: AnySelection<HTMLCanvasElement>,
        ctx: CanvasRenderingContext2D | null,
        width: number,
        height: number,
        dpr: number,
    ): void {
        canvas
            .attr("width", Math.round(width * dpr))
            .attr("height", Math.round(height * dpr))
            .style("width", width + "px")
            .style("height", height + "px");
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    private layers(): AnySelection<SVGSVGElement>[] {
        const ms = this.mainGraphState;
        return [
            ms.mouseHandlerPanningSvg!,
            ms.mouseHandlerBrushXSvg!,
            ms.mouseHandlerBrush2dSvg!,
            ms.mouseHandlerSelectionSvg!,
            ms.mouseHandlerPickSvg!,
            ms.mouseHandlerRulerSvg!,
        ];
    }

    private onHostResize(): void {
        if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = undefined;
            if (!this.isReady()) return;
            const width = this.measureWidth();
            if (Math.abs(width - this.mainGraphState.outerWidth) < 1) return;
            this.mainGraphState.setOuterWidth(width);
            this.recoveryGraphState.setOuterWidth(width);
            this.applyGeometry();
            const persp = this.mainGraphState.sent;
            persp.yAxis!.tickSize(-this.mainGraphState.innerWidth);
            persp.yCongestionAxis!.tickSize(this.mainGraphState.innerWidth);
            this.rttYAxis!.tickSize(-this.mainGraphState.innerWidth);
            // the right axis is not redrawn by redrawCanvas (its scale never changes with zoom): its labels sit at
            // x = innerWidth + 3 and must follow the new width
            this.mainGraphState.gyCongestionAxis!.call(persp.yCongestionAxis!);
            this.redrawCurrent(); // keeps the current x / y ranges
        }, RESIZE_DEBOUNCE_MS);
    }

    // Runs before each render (R:539-629).
    private setup(): void {
        this.initSentSide();

        const ms = this.mainGraphState;
        const rs = this.recoveryGraphState;
        ms.gxAxis!.call(ms.sent.xAxis!);
        ms.gyAxis!.call(ms.sent.yAxis!);
        ms.gyCongestionAxis!.call(ms.sent.yCongestionAxis!);
        rs.gxAxis!.call(rs.xAxis!);
        rs.gyAxis!.call(rs.yAxis!);

        this.setPerspective();

        // Make the graphs visible
        this.mainGraphContainer!.style("display", "block");
        this.recoveryGraphContainer!.style("display", "block");
    }

    // Scales, axes and ranges of the "packet_sent" perspective (initSentSide, R:632-731).
    private initSentSide(): void {
        const model = this.model!;
        const ms = this.mainGraphState;
        const rs = this.recoveryGraphState;
        const persp = ms.sent;

        persp.originalRangeX = model.originalRangeX;
        persp.originalRangeY = model.originalRangeY;
        rs.originalRangeY = [0, model.maxRTT];

        const [localXMin, localXMax] = [0, model.originalRangeX[1]];
        const [localMinY, localMaxY] = model.initialRangeY; // Q17: originalRangeY when nothing is plotted

        // Make the congestion graph take up only 1/3 of the vertical screen space
        const scaledMaxCongestionY = model.maxCongestionY * 3;

        persp.xScale = d3.scaleLinear().domain([localXMin, localXMax]).range([0, ms.innerWidth]);
        persp.yScale = d3.scaleLinear().domain([localMinY, localMaxY]).range([ms.innerHeight, 0]);
        persp.yCongestionScale = d3.scaleLinear().domain([0, scaledMaxCongestionY]).range([ms.innerHeight, 0]).nice();
        rs.yScale = d3.scaleLinear().domain([0, model.maxRTT]).range([rs.innerHeight, 0]);

        // d3-axis 1 always offset by 0.5px; d3-axis 3 uses 0 on HiDPI screens
        persp.xAxis = d3
            .axisBottom<NumberValue>(persp.xScale)
            .tickSize(-ms.innerHeight)
            .offset(0.5)
            .tickFormat(asciiMinusFormat(persp.xScale));

        // Custom labeling so that big numbers are nicely rounded using a 'K' postfix
        persp.yAxis = d3.axisLeft<NumberValue>(persp.yScale).tickFormat(kFormat).tickSize(-ms.innerWidth).offset(0.5);

        persp.yCongestionAxis = d3
            .axisRight<NumberValue>(persp.yCongestionScale)
            .tickFormat(kFormat)
            .tickSize(ms.innerWidth)
            .offset(0.5);

        // The recovery x axis uses the main graph's x scale, so panning / zooming also applies to the RTT graph
        rs.xAxis = d3
            .axisBottom<NumberValue>(persp.xScale)
            .tickSize(-rs.innerHeight)
            .offset(0.5)
            .tickFormat(asciiMinusFormat(persp.xScale));
        rs.yAxis = d3.axisLeft<NumberValue>(rs.yScale).tickSize(-rs.innerWidth).offset(0.5);
        // qvis re-renders the RTT y axis with the main y-axis object (K format, tick size -IW); see redrawCanvas
        this.rttYAxis = d3.axisLeft<NumberValue>(rs.yScale).tickSize(-ms.innerWidth).offset(0.5);

        persp.rangeX = [localXMin, localXMax];
        persp.rangeY = [localMinY, localMaxY];
        rs.rangeY = rs.originalRangeY;
    }

    // Only the sent perspective is reachable (qvis setPerspective(true, false), R:1034-1056).
    private setPerspective(): void {
        const ms = this.mainGraphState;
        const rs = this.recoveryGraphState;
        ms.congestionAxisText!.style("display", "block");
        ms.gyCongestionAxis!.style("display", "block");
        rs.graphSvg!.style("display", "block");
        rs.canvas!.style("display", "block");
    }

    private renderParts(): void {
        this.redrawCurrent();
    }

    private redrawCurrent(): void {
        const persp = this.mainGraphState.currentPerspective();
        this.redrawCanvas(persp.rangeX[0], persp.rangeX[1], persp.rangeY[0], persp.rangeY[1]);
    }

    private setMode(mode: Mode): void {
        if (mode !== "ruler" && this.ruler !== undefined) {
            this.ruler.cancel(); // Q9: leaving ruler mode another way restores the cursor
        }
        this.mode = mode;
        const ms = this.mainGraphState;
        ms.mouseHandlerBrush2dSvg!.style("z-index", mode === "brush2d" ? 1 : 0);
        ms.mouseHandlerBrushXSvg!.style("z-index", mode === "brushX" ? 1 : 0);
        ms.mouseHandlerPanningSvg!.style("z-index", mode === "panning" ? 1 : 0);
        ms.mouseHandlerSelectionSvg!.style("z-index", mode === "selection" ? 1 : 0);
        ms.mouseHandlerPickSvg!.style("z-index", mode === "pick" ? 1 : 0);
        ms.mouseHandlerRulerSvg!.style("z-index", mode === "ruler" ? 1 : 0);
    }

    // ============================================================================================ drawing

    // Y is bytes sent; the congestion y scale is fixed per render; the RTT y scale follows the x window when RTT
    // zooming is on (R:799-952).
    private redrawCanvas(minX: number, maxX: number, minY: number, maxY: number): void {
        const model = this.model;
        if (model === undefined) return;
        const ms = this.mainGraphState;
        const rs = this.recoveryGraphState;
        const persp = ms.currentPerspective();
        const iw = Math.max(0, ms.innerWidth);
        const ih = ms.innerHeight;

        // The width of a single event, before scaling
        const rectWidth = 3;

        persp.xScale = d3.scaleLinear().domain([minX, maxX]).range([0, ms.innerWidth]);
        persp.yScale = d3.scaleLinear().domain([minY, maxY]).range([ms.innerHeight, 0]);
        const xScale = persp.xScale;
        const yScale = persp.yScale;

        ms.gxAxis!.call(persp.xAxis!.scale(xScale).tickFormat(asciiMinusFormat(xScale)));
        ms.gyAxis!.call(persp.yAxis!.scale(yScale));

        const ctx = ms.canvasContext;
        ctx?.clearRect(0, 0, iw, ih);

        // RTT graph: y domain (Q4), axes (Q5: tick format; Q6: the main x axis with its -520 tick size), clear
        const [rttMin, rttMax] = rttDomain(model, rs.zooming0RTTenabled, minX, maxX);
        rs.yScale = d3.scaleLinear().domain([rttMin, rttMax]).range([rs.innerHeight, 0]);
        rs.gyAxis!.call(this.rttYAxis!.scale(rs.yScale).tickFormat(rttTickFormat(rs.yScale.tickFormat(10))));
        rs.gxAxis!.call(persp.xAxis!.scale(xScale));
        const rctx = rs.canvasContext;
        rctx?.clearRect(0, 0, Math.max(0, rs.innerWidth), rs.innerHeight);

        // X draw scale grows asymptotically when zooming in; Y draw scale is fixed at 1 (qvis R:856-866)
        persp.drawScaleX = xDrawScale((persp.originalRangeX[1] - persp.originalRangeX[0]) / (maxX - minX));
        persp.drawScaleY = 1;

        if (ctx) {
            this.drawPackets(ctx, model, xScale, yScale, rectWidth, iw, ih);

            if (ms.congestionGraphEnabled) {
                const congestionScale = persp.yCongestionScale!;
                const bounds = { width: iw, height: ih, batched: model.pT.length > BATCH_THRESHOLD };
                this.drawLines(ctx, model.bytes, xScale, congestionScale, "#808000", drawCircle, bounds);
                this.drawLines(ctx, model.cwnd, xScale, congestionScale, "#8A2BE2", drawCross, bounds);
                this.drawLines(ctx, model.fcApplication, xScale, yScale, "#a80f3a", drawCross, bounds);
                this.drawLines(ctx, model.fcStream, xScale, yScale, "#ff69b4", drawCross, bounds);
            }
        }

        if (rctx) {
            const bounds = {
                width: Math.max(0, rs.innerWidth),
                height: rs.innerHeight,
                batched: model.pT.length > BATCH_THRESHOLD,
            };
            this.drawLines(rctx, model.minRTT, xScale, rs.yScale, "#C96480", drawSmallTick, bounds);
            this.drawLines(rctx, model.smoothedRTT, xScale, rs.yScale, "#8a554a", drawSmallTick, bounds);
            this.drawLines(rctx, model.latestRTT, xScale, rs.yScale, "#ff9900", drawSmallTick, bounds);
        }

        persp.rangeX = [minX, maxX];
        persp.rangeY = [minY, maxY];
        rs.rangeY = [rttMin, rttMax];
    }

    // Sent packets and their first ACK / last loss, in packet order (later packets paint over earlier ones).
    private drawPackets(
        ctx: CanvasRenderingContext2D,
        model: CongestionModel,
        xScale: ScaleLinear<number, number>,
        yScale: ScaleLinear<number, number>,
        rectWidth: number,
        iw: number,
        ih: number,
    ): void {
        const { pT, pFrom, pTo, pAckT, pLossT } = model;
        const n = pT.length;
        const persp = this.mainGraphState.sent;
        const w = rectWidth * persp.drawScaleX;
        const dsy = persp.drawScaleY;
        const batched = n > BATCH_THRESHOLD;
        const passes = batched ? [0, 1, 2] : [-1];
        // Up to BATCH_THRESHOLD packets: qvis's drawRect primitive (beginPath + rect + fill), which anti-aliases
        // fractional edges differently from fillRect, so the pixels (and thus exact-colour hover picking) are
        // identical to qvis. Above it (spec §8.7 allowance): fillRect, batched per colour.
        const drawRect: (x: number, y: number, h: number, color: string) => void = batched
            ? (x, y, h) => ctx.fillRect(x, y, w, h) // fillStyle is set per pass
            : (x, y, h, color) => {
                  ctx.beginPath();
                  ctx.fillStyle = color;
                  ctx.rect(x, y, w, h);
                  ctx.fill();
              };

        for (const pass of passes) {
            if (pass >= 0) ctx.fillStyle = [COLOR_SENT, COLOR_ACK, COLOR_LOSS][pass];
            for (let i = 0; i < n; ++i) {
                const yTop = yScale(pTo[i]);
                const yBottom = yScale(pFrom[i]);
                // drawing happens top down: height is negative (inverted y axis)
                const height = yTop - yBottom;
                if (!(yBottom + Math.abs(height) >= 0 && yTop <= ih)) continue;
                const x = xScale(pT[i]);
                if (x > iw) continue; // the ACK / loss tests also check the SENT x (qvis culling predicates)

                // qvis drawRect: at least 0.05px tall
                const h = height < 0 ? Math.max(0.05, -height * dsy) : Math.min(-0.05, -height * dsy);

                if ((pass === -1 || pass === 0) && x + rectWidth >= 0) {
                    drawRect(x, yTop, h, COLOR_SENT);
                }
                if (pass === -1 || pass === 1) {
                    const ackT = pAckT[i];
                    if (ackT === ackT) {
                        const ackX = xScale(ackT);
                        if (ackX + rectWidth >= 0) drawRect(ackX, yTop, h, COLOR_ACK);
                    }
                }
                if (pass === -1 || pass === 2) {
                    const lossT = pLossT[i];
                    if (lossT === lossT) {
                        const lossX = xScale(lossT);
                        if (lossX + rectWidth >= 0) drawRect(lossX, yTop, h, COLOR_LOSS);
                    }
                }
            }
        }
    }

    // qvis drawLines (R:970-997): one polyline, then a marker on every point except the first.
    private drawLines(
        ctx: CanvasRenderingContext2D,
        points: readonly Pt[],
        xScale: ScaleLinear<number, number>,
        yScale: ScaleLinear<number, number>,
        color: string,
        marker: Marker,
        /** canvas size (CSS px), and whether the trace is above BATCH_THRESHOLD (markers in one path, §8.7) */
        bounds: { width: number; height: number; batched: boolean },
    ): void {
        ctx.lineWidth = 1 * this.mainGraphState.currentPerspective().drawScaleX;
        if (points.length === 0) return;
        const n = points.length;
        const xs = new Float64Array(n);
        const ys = new Float64Array(n);
        for (let i = 0; i < n; ++i) {
            xs[i] = xScale(points[i][0]);
            ys[i] = yScale(points[i][1]);
        }
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.moveTo(xs[0], ys[0]);
        for (let i = 1; i < n; ++i) ctx.lineTo(xs[i], ys[i]);
        ctx.stroke();
        // markers outside the canvas are invisible: skip them (same pixels, much faster for long series)
        const margin = 4;
        const visible = (x: number, y: number): boolean =>
            !(x < -margin || x > bounds.width + margin || y < -margin || y > bounds.height + margin);
        if (!bounds.batched) {
            for (let i = 1; i < n; ++i) {
                if (visible(xs[i], ys[i])) marker.draw(ctx, xs[i], ys[i], color);
            }
            return;
        }
        ctx.beginPath();
        for (let i = 1; i < n; ++i) {
            if (visible(xs[i], ys[i])) marker.addToPath(ctx, xs[i], ys[i]);
        }
        if (marker.paint === "fill") {
            ctx.fillStyle = color;
            ctx.fill();
        } else {
            ctx.strokeStyle = color;
            ctx.stroke();
        }
    }

    // ============================================================================================ interaction

    /*
     * Zooming is anchored at the cursor's x: the time under the cursor stays put, y auto-fits to the packets sent in
     * the new window (R:1481-1511).
     */
    private onZoom(event: WheelEvent): void {
        event.preventDefault(); // no page scroll
        if (!this.isReady() || event.deltaY === 0) return; // Q14: horizontal swipes are ignored

        const ms = this.mainGraphState;
        ms.graphSvg!.selectAll(".ackArrow").remove();
        this.clearPacketInfoWidget();

        const persp = ms.currentPerspective();
        const mouseX = persp.xScale!.invert(d3.pointer(event, event.currentTarget as Element)[0]);
        const zoomed = wheelZoom(event.deltaY, mouseX, persp.rangeX, persp.originalRangeX[1]);
        if (zoomed === undefined) return;
        const [newLeftX, newRightX] = zoomed;
        const [newTopY, newBottomY] = this.yExtremaOrCurrent(newLeftX, newRightX);
        this.redrawCanvas(newLeftX, newRightX, newTopY, newBottomY);
    }

    /** findYExtrema with FIX Q16: a window without sent packets keeps the current y range. */
    private yExtremaOrCurrent(minX: number, maxX: number): [number, number] {
        const [min, max] = findYExtrema(this.model!, minX, maxX);
        if (min > max) {
            const r = this.mainGraphState.currentPerspective().rangeY;
            return [r[0], r[1]];
        }
        return [min, max];
    }

    // Grab-style pan while the primary button is down (R:1513-1539). Chrome already delivers mousemove per frame.
    private onPan(event: MouseEvent): void {
        if (!this.isReady() || !(event.buttons & 1)) return;
        const ms = this.mainGraphState;
        const persp = ms.currentPerspective();
        const panAmountX = (persp.rangeX[1] - persp.rangeX[0]) / ms.innerWidth;
        const panAmountY = (persp.rangeY[1] - persp.rangeY[0]) / ms.innerHeight;
        const deltaX = event.movementX * panAmountX * -1;
        const deltaY = event.movementY * panAmountY;
        if (deltaX === 0 && deltaY === 0) return;
        const r = panClamp(deltaX, deltaY, persp.rangeX, persp.rangeY, persp.originalRangeX, persp.originalRangeY);
        this.redrawCanvas(r.x[0], r.x[1], r.y[0], r.y[1]);
    }

    private onBrushXEnd(event: d3.D3BrushEvent<unknown>): void {
        const selection = event.selection as [number, number] | null;
        if (!selection || !this.isReady()) return; // Q8: click without drag, and the programmatic clear below
        const persp = this.mainGraphState.currentPerspective();
        const dragStartX = persp.xScale!.invert(selection[0]);
        const dragStopX = persp.xScale!.invert(selection[1]);
        const [minX, maxX] = dragStartX < dragStopX ? [dragStartX, dragStopX] : [dragStopX, dragStartX];
        const [minY, maxY] = this.yExtremaOrCurrent(minX, maxX);

        this.redrawCanvas(minX, maxX, minY, maxY);

        this.usePanning(); // one-shot: back to panning
        this.mainGraphState.brushXElement!.call(this.mainGraphState.brushX!.move, null); // clear the brush band
    }

    private onBrush2dEnd(event: d3.D3BrushEvent<unknown>): void {
        const selection = event.selection as [[number, number], [number, number]] | null;
        if (!selection || !this.isReady()) return; // Q8
        const persp = this.mainGraphState.currentPerspective();
        const dragStartX = persp.xScale!.invert(selection[0][0]);
        const dragStopX = persp.xScale!.invert(selection[1][0]);
        const dragStartY = persp.yScale!.invert(selection[0][1]);
        const dragStopY = persp.yScale!.invert(selection[1][1]);
        const [minX, maxX] = dragStartX < dragStopX ? [dragStartX, dragStopX] : [dragStopX, dragStartX];
        const [minY, maxY] = dragStartY < dragStopY ? [dragStartY, dragStopY] : [dragStopY, dragStartY];

        this.redrawCanvas(minX, maxX, minY, maxY);

        this.usePanning();
        this.mainGraphState.brush2dElement!.call(this.mainGraphState.brush2d!.move, null);
    }

    private clearPacketInfoWidget(): void {
        const info = this.packetInfo;
        if (!info) return;
        info.style.display = "none";
        for (const id of ["timestamp", "packetNr", "packetSize", "ackedFrom", "ackedTo"]) {
            const p = info.querySelector("#" + id);
            if (p) p.textContent = "";
        }
    }

    private showPacketInfoWidget(sx: number, sy: number, content: TooltipContent): void {
        const info = this.packetInfo;
        if (!info) return;
        const ms = this.mainGraphState;
        info.style.display = "block";
        info.style.marginLeft = sx + ms.margins.left + 10 + "px";
        info.style.marginTop = sy + ms.margins.top + 10 + "px";
        const set = (id: string, text: string): void => {
            const p = info.querySelector("#" + id);
            if (p) p.textContent = text;
        };
        set("timestamp", content.timestamp);
        set("packetNr", content.packetNr);
        set("ackedFrom", content.ackedFrom);
        set("ackedTo", content.ackedTo);
        // qvis set "<br/>"-joined HTML here; build the same structure without parsing file data as HTML
        const size = info.querySelector("#packetSize");
        if (size) {
            size.textContent = "";
            content.packetSize.forEach((line, i) => {
                if (i > 0) size.appendChild(document.createElement("br"));
                size.appendChild(document.createTextNode(line));
            });
        }
    }

    /** The sized sent packet whose byte range contains `bytes` (binary search; ranges are disjoint and increasing). */
    private packetAtBytes(bytes: number): CgPacket | undefined {
        const { pFrom, pTo, packets } = this.model!;
        let lo = 0;
        let hi = pFrom.length - 1;
        let idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (pFrom[mid] <= bytes) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (idx < 0 || !(pTo[idx] >= bytes)) return undefined;
        return packets[idx];
    }

    // Hover picking: the packet is found by its byte range (y), the mark by the exact pixel colour (R:1557-1697).
    private onHover(event: MouseEvent): void {
        if (!this.isReady()) return;
        const ms = this.mainGraphState;
        ms.graphSvg!.selectAll(".ackArrow").remove();
        this.clearPacketInfoWidget();

        if (event.buttons !== 0) return;

        const persp = ms.currentPerspective();
        const [sx, sy] = d3.pointer(event, event.currentTarget as Element);
        const graphY = persp.yScale!.invert(sy);

        const ctx = ms.canvasContext;
        if (!ctx) return;
        const dpr = ms.dpr;
        const pixel = ctx.getImageData(Math.floor(sx * dpr), Math.floor(sy * dpr), 1, 1).data;
        const [r, g, b] = [pixel[0], pixel[1], pixel[2]];
        if (r === 0 && g === 0 && b === 0) return; // no event

        const packet = this.packetAtBytes(graphY);
        if (packet === undefined) return;

        if (r === 0 && g === 0 && b === 255) {
            this.showPacketInfoWidget(sx, sy, sentTooltip(this.model!, packet));
        } else if (r === 107 && g === 142 && b === 35 && packet.ackT !== undefined) {
            this.showPacketInfoWidget(sx, sy, ackTooltip(packet));

            // "ack arrow": a white bar with a grey outline from the packet to its ACK, under the canvas
            let leftX = persp.xScale!(packet.t);
            leftX = leftX > 0 ? leftX : 0;
            const topY = persp.yScale!(packet.from);
            const bottomY = persp.yScale!(packet.to);
            const height = (topY - bottomY) * persp.drawScaleY;
            const width = persp.xScale!(packet.ackT) - leftX; // FIX Q12: shortened by the clamped amount

            ms.graphSvg!.append("rect")
                .attr("class", "ackArrow")
                .attr("x", leftX)
                .attr("width", Math.max(0, width))
                .attr("y", bottomY)
                .attr("height", Math.max(0, height))
                .attr("fill", "#fff")
                .attr("stroke-width", "2px")
                .attr("stroke", "#686868");
        } else if (r === 255 && g === 0 && b === 0 && packet.lossT !== undefined) {
            this.showPacketInfoWidget(sx, sy, lossTooltip(packet));
        }
    }
}

// ================================================================================================ primitives (R:999-1031)

const MARKER_RADIUS = 2;

/** "x" cross with the current line width (two separate paths, like qvis). */
const drawCross: Marker = {
    paint: "stroke",
    draw(ctx, centerX, centerY, color) {
        const radius = MARKER_RADIUS;
        ctx.strokeStyle = color;
        // top left to bottom right
        ctx.beginPath();
        ctx.moveTo(centerX - radius, centerY - radius);
        ctx.lineTo(centerX + radius, centerY + radius);
        ctx.stroke();
        // top right to bottom left
        ctx.beginPath();
        ctx.moveTo(centerX + radius, centerY - radius);
        ctx.lineTo(centerX - radius, centerY + radius);
        ctx.stroke();
    },
    addToPath(ctx, centerX, centerY) {
        const radius = MARKER_RADIUS;
        ctx.moveTo(centerX - radius, centerY - radius);
        ctx.lineTo(centerX + radius, centerY + radius);
        ctx.moveTo(centerX + radius, centerY - radius);
        ctx.lineTo(centerX - radius, centerY + radius);
    },
};

/** Filled dot (arc end angle 360 radians: a full circle, as in qvis). */
const drawCircle: Marker = {
    paint: "fill",
    draw(ctx, centerX, centerY, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(centerX, centerY, MARKER_RADIUS, 0, 360);
        ctx.fill();
    },
    addToPath(ctx, centerX, centerY) {
        ctx.moveTo(centerX + MARKER_RADIUS, centerY);
        ctx.arc(centerX, centerY, MARKER_RADIUS, 0, 360);
    },
};

/** Filled dot centred 1px above the point (RTT lines). */
const drawSmallTick: Marker = {
    paint: "fill",
    draw(ctx, centerX, centerY, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(centerX, centerY - 1, MARKER_RADIUS, 0, 360);
        ctx.fill();
    },
    addToPath(ctx, centerX, centerY) {
        ctx.moveTo(centerX + MARKER_RADIUS, centerY - 1);
        ctx.arc(centerX, centerY - 1, MARKER_RADIUS, 0, 360);
    },
};

export { CongestionGraphD3Renderer };
