// Port of qvis `components/multiplexinggraph/renderer/MultiplexingGraphD3CollapsedRenderer.ts` (D3 v5 -> v7).
// "Multiplexed data flow": one colored rect per data-direction STREAM frame of a request stream, in arrival order,
// with an arrival-type marker below it; zoomable (1-30x) and driving the byte-range chart. The extraction
// (renderLive :148-519 in qvis) lives in multiplexingData.ts. See docs/dev/parity/multiplexing-graph.md §3.3, §3.5,
// §3.6 and §2.6 (tooltip).
//
// Deviations (FIX): synchronous render in try/finally (M20); a unique clip id per instance, so the strip clips to its
// own [0,W] x [0,70] (M3); the byte-range renderer is absent while its container is (M4) and is cleared when the trace
// has no data frames (M5); the tooltip is built from text nodes (M35) with rounded times (M22).
// D3 v7 behaviour that differs from qvis's d3 v5 is restored: the 0.5px axis offset at every devicePixelRatio
// (v5Axis) and the d3-zoom v1 gestures, so a trackpad pinch (ctrl+wheel) does not zoom the strip (withV5ZoomGestures).

import * as d3 from "d3";
import type { QlogConnection } from "@/model/QlogConnection";
import MultiplexingGraphD3ByterangesRenderer from "./MultiplexingGraphD3ByterangesRenderer";
import type MultiplexingGraphD3WaterfallRenderer from "./MultiplexingGraphD3WaterfallRenderer";
import {
    eventNames,
    extractCollapsedData,
    FrameArrivalType,
    frameTooltipLines,
    type FrameDatum,
    type MuxEventNames,
} from "./multiplexingData";
import { streamColor, v5Axis, withV5ZoomGestures } from "./MultiplexingGraphDataHelper";

type GSelection = d3.Selection<SVGGElement, unknown, null, undefined>;
type XScale = d3.ScaleLinear<number, number>;

let instanceCounter = 0;

/** The arrival-type marker groups, in append order (§3.6 step 7). */
const ARRIVAL_MARKERS: ReadonlyArray<{ className: string; type: FrameArrivalType; fill: string }> = [
    { className: "retransmitPacket", type: FrameArrivalType.Retransmit, fill: "black" },
    { className: "reorderPacket", type: FrameArrivalType.Reordered, fill: "blue" },
    { className: "duplicatePacket", type: FrameArrivalType.Duplicate, fill: "red" },
    { className: "futurePacket", type: FrameArrivalType.Future, fill: "purple" },
];

export default class MultiplexingGraphD3CollapsedRenderer {
    public readonly container: HTMLElement;
    public axisLocation: "top" | "bottom" = "bottom";

    public byteRangeRenderer: MultiplexingGraphD3ByterangesRenderer | undefined = undefined;
    /** set from outside (qvis: "FIXME: dirty!"), so waterfall clicks update the byte-range chart */
    public waterfallRenderer: MultiplexingGraphD3WaterfallRenderer | undefined = undefined;

    public rendering: boolean = false;

    protected svg: GSelection | undefined = undefined;
    protected tooltip: d3.Selection<HTMLElement, unknown, null, undefined>;
    protected connection: QlogConnection | undefined = undefined;

    protected barHeight = 70;

    protected currentDomain: XScale | undefined = undefined;

    private readonly clipId: string;
    private dimensions: {
        margin: { top: number; right: number; bottom: number; left: number };
        width: number;
        height: number;
    } = {
        margin: { top: 0, right: 40, bottom: 20, left: 20 },
        width: 0,
        height: 0,
    };

    constructor(container: HTMLElement, tooltip: HTMLElement, byteRangeContainer?: HTMLElement | null) {
        this.container = container;
        this.tooltip = d3.select(tooltip);
        this.clipId = "mux-clip-" + ++instanceCounter;
        this.setByteRangeContainer(byteRangeContainer ?? null);
    }

    /** (Re)creates the byte-range renderer for `el`, or drops it when the byte-range row is hidden (M4 FIX). */
    public setByteRangeContainer(el: HTMLElement | null): void {
        if (el === null) {
            this.byteRangeRenderer = undefined;
            return;
        }
        if (this.byteRangeRenderer === undefined || this.byteRangeRenderer.container !== el) {
            this.byteRangeRenderer = new MultiplexingGraphD3ByterangesRenderer(el);
        }
    }

    public render(connection: QlogConnection, names?: MuxEventNames): boolean {
        if (this.rendering) {
            return false;
        }
        this.rendering = true;
        try {
            this.setup(connection);
            this.renderLive(names ?? eventNames(connection));
            return true;
        } finally {
            this.rendering = false;
        }
    }

    public dispose(): void {
        if (this.svg) {
            this.svg.on(".zoom", null);
        }
        this.tooltip.interrupt();
        d3.select(this.container).selectAll("*").remove();
        this.svg = undefined;
        this.byteRangeRenderer?.dispose();
        this.byteRangeRenderer = undefined;
        this.waterfallRenderer = undefined;
    }

    protected setup(connection: QlogConnection): void {
        this.connection = connection;

        this.dimensions.margin = { top: 0, right: 40, bottom: 20, left: 20 };
        if (this.axisLocation === "top") {
            this.dimensions.margin.top = 20;
        } else {
            this.dimensions.margin.bottom = 40;
        }

        // width and height are the INTERNAL widths (so without the margins)
        this.dimensions.width = Math.max(
            0,
            this.container.clientWidth - this.dimensions.margin.left - this.dimensions.margin.right,
        );
        this.dimensions.height = this.barHeight;

        // clear old rendering
        if (this.svg) {
            this.svg.on(".zoom", null);
        }
        d3.select(this.container).selectAll("*").remove();

        this.svg = d3
            .select(this.container)
            .append("svg")
            .attr("width", this.dimensions.width + this.dimensions.margin.left + this.dimensions.margin.right)
            .attr("height", this.dimensions.height + this.dimensions.margin.top + this.dimensions.margin.bottom)
            .attr("xmlns", "http://www.w3.org/2000/svg")
            .attr("xmlns:xlink", "http://www.w3.org/1999/xlink")
            .attr("font-family", "Trebuchet-ms")
            .append("g")
            .attr("transform", "translate(" + this.dimensions.margin.left + "," + this.dimensions.margin.top + ")");

        this.tooltip
            .style("opacity", 0)
            .style("position", "absolute")
            .style("padding", "5px")
            .style("pointer-events", "none") // crucial!
            .style("background", "lightsteelblue");
    }

    protected renderLive(names: MuxEventNames): void {
        const svg = this.svg!;
        const { dataSent, dataMoved, frameCount, directionText } = extractCollapsedData(this.connection!, names);

        svg.append("defs")
            .append("clipPath")
            .attr("id", this.clipId)
            .append("rect")
            .attr("width", this.dimensions.width)
            .attr("height", this.dimensions.height)
            .attr("x", 0)
            .attr("y", 0);

        const rects = svg.append("g").attr("clip-path", "url(#" + this.clipId + ")");

        const packetSidePadding = 0.3;

        const xDomain = d3.scaleLinear().domain([1, frameCount]).range([0, this.dimensions.width]);

        this.currentDomain = xDomain;

        const xAxis = svg.append("g");
        if (this.axisLocation === "top") {
            xAxis.call(v5Axis(d3.axisTop(xDomain), xDomain));
        } else {
            xAxis
                .attr("transform", "translate(0," + this.dimensions.height + ")")
                .call(v5Axis(d3.axisBottom(xDomain), xDomain));
        }

        const packetMouseOver = (event: MouseEvent, data: FrameDatum) => {
            this.tooltip.transition().duration(100).style("opacity", 0.95);

            // M35 FIX: text nodes and <br> elements instead of innerHTML
            const node = this.tooltip.node()!;
            node.replaceChildren();
            frameTooltipLines(data).forEach((line, i) => {
                if (i > 0) {
                    node.appendChild(document.createElement("br"));
                }
                node.appendChild(document.createTextNode(line));
            });

            this.tooltip.style("left", event.pageX + 15 + "px").style("top", event.pageY - 75 + "px");
        };

        const packetMouseOut = () => {
            this.tooltip.transition().duration(200).style("opacity", 0);
        };

        const packetHeight = this.barHeight * 0.65;
        const typeGap = this.barHeight * 0.05;
        const typeHeight = this.barHeight * 0.275;

        rects
            .selectAll("rect.packet")
            .data(dataSent)
            .enter()
            .append("rect")
            .attr("x", (d) => xDomain(d.countStart) - packetSidePadding)
            .attr("y", (d) => (d.index % 2 === 0 ? 0 : packetHeight * 0.05))
            .attr("fill", (d) => streamColor(d.streamID))
            .style("opacity", 1)
            .attr("class", "packet")
            .attr("width", (d) => xDomain(d.countEnd) - xDomain(d.countStart) + packetSidePadding * 2)
            .attr("height", (d) => packetHeight * (d.index % 2 === 0 ? 1 : 0.9))
            .style("pointer-events", "all")
            .on("mouseover", packetMouseOver)
            .on("mouseout", packetMouseOut)
            .on("click", (_event: MouseEvent, d) => {
                if (this.byteRangeRenderer !== undefined) {
                    this.byteRangeRenderer.render(dataSent, dataMoved, d.streamID);
                    this.byteRangeRenderer.zoom(this.currentDomain!);
                }
            });

        for (const marker of ARRIVAL_MARKERS) {
            rects
                .selectAll("rect." + marker.className)
                .data(dataSent.filter((d) => d.arrivalType === marker.type))
                .enter()
                .append("rect")
                .attr("x", (d) => xDomain(d.countStart) - packetSidePadding)
                .attr("y", () => packetHeight + typeGap)
                .attr("fill", () => marker.fill)
                .style("opacity", 1)
                .attr("class", marker.className)
                .attr("width", (d) => xDomain(d.countEnd) - xDomain(d.countStart) + packetSidePadding * 2)
                .attr("height", () => typeHeight);
        }

        // legend
        svg.append("g")
            .append("text")
            .attr("x", xDomain(frameCount / 2))
            .attr("y", this.dimensions.height + this.dimensions.margin.bottom - 10)
            .attr("dominant-baseline", "baseline")
            .style("text-anchor", "middle")
            .style("font-size", "14px")
            .style("font-family", "Trebuchet MS")
            .attr("fill", "#000000")
            .text("Count of STREAM frames " + directionText + " (regardless of size, includes retransmits)");

        const updateChart = (event: d3.D3ZoomEvent<SVGGElement, unknown>) => {
            // recover the new scale
            const newX = event.transform.rescaleX(xDomain);

            this.currentDomain = newX;

            // update the axis with these new boundaries
            if (this.axisLocation === "top") {
                xAxis.call(v5Axis(d3.axisTop(newX), newX));
            } else {
                xAxis.call(v5Axis(d3.axisBottom(newX), newX));
            }

            // update positions (y and height unchanged)
            rects
                .selectAll<SVGRectElement, FrameDatum>(
                    ".packet,.retransmitPacket,.reorderPacket,.duplicatePacket,.futurePacket",
                )
                .attr("x", (d) => newX(d.countStart) - packetSidePadding)
                .attr("width", (d) => newX(d.countEnd) - newX(d.countStart) + packetSidePadding * 2);

            this.byteRangeRenderer?.zoom(newX);
        };

        // d3-zoom v1 gestures (qvis): a trackpad pinch (ctrl+wheel) zooms the page, not the chart
        const zoom = withV5ZoomGestures(d3.zoom<SVGGElement, unknown>())
            .scaleExtent([1, 30]) // how much you can unzoom (x1) and zoom (x30)
            .translateExtent([
                [0, 0],
                [this.dimensions.width, this.dimensions.height],
            ])
            .extent([
                [0, 0],
                [this.dimensions.width, this.dimensions.height],
            ])
            .on("zoom", updateChart);

        // M30 PRESERVE: attached to the inner <g>, so only painted elements receive wheel and drag
        svg.call(zoom);

        if (dataSent.length > 0) {
            // always stream 0, without a zoom call (M33, M6)
            this.byteRangeRenderer?.render(dataSent, dataMoved, 0);
        } else {
            this.byteRangeRenderer?.clear(); // M5 FIX
        }

        // make sure that if someone clicks on the waterfall, it also updates the byte-range chart
        if (this.waterfallRenderer !== undefined) {
            this.waterfallRenderer.onStreamClicked = (streamID: string) => {
                if (this.byteRangeRenderer !== undefined) {
                    this.byteRangeRenderer.render(dataSent, dataMoved, parseInt(streamID, 10));
                    this.byteRangeRenderer.zoom(this.currentDomain!);
                }
            };
        }
    }
}

export { MultiplexingGraphD3CollapsedRenderer };
