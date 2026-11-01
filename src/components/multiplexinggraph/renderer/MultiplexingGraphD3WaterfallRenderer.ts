// Port of qvis `components/multiplexinggraph/renderer/MultiplexingGraphD3WaterfallRenderer.ts` (D3 v5 -> v7).
// One bar per request stream, from its first to its last data-direction STREAM frame, in frame-count space shared with
// the data-flow strip. See docs/dev/parity/multiplexing-graph.md §3.4 (extraction, in multiplexingData.ts) and §3.9.
//
// Deviations (FIX): synchronous render in try/finally (M20); a unique clip id (M3; the waterfall's clip is still not
// applied to anything, as in qvis); SVG height 150 instead of NaN for 0 streams (M36); legend wording "Request sent"
// for client traces / "Request received" for server traces (M10); the legend is anchored at
// max(xDomain(0), -margin.left) (M11).

import * as d3 from "d3";
import type { QlogConnection } from "@/model/QlogConnection";
import {
    eventNames,
    extractWaterfallData,
    waterfallLayout,
    type MuxEventNames,
    type StreamExtents,
} from "./multiplexingData";
import { streamColor } from "./MultiplexingGraphDataHelper";

type GSelection = d3.Selection<SVGGElement, unknown, null, undefined>;

export interface StreamDetail {
    stream_id: number;
    data: StreamExtents;
}

export const WATERFALL_EMPTY_MESSAGE =
    "This trace doesn't contain multiple independent streams (or has less than 5 STREAM frames), which is needed for the waterfall.";

let instanceCounter = 0;

export default class MultiplexingGraphD3WaterfallRenderer {
    public readonly container: HTMLElement;
    public rendering: boolean = false;

    /** Set by the collapsed renderer (qvis: "dirty"): a bar click updates the byte-range chart. */
    public onStreamClicked: ((streamID: string) => void) | undefined = undefined;

    /** Clicks for the React layer: shows the stream details line. */
    protected onStreamClickedUpper: (streamDetails: StreamDetail) => void;

    protected svg: GSelection | undefined = undefined;
    protected connection: QlogConnection | undefined = undefined;

    protected barHeight = 120;

    private readonly clipId: string;
    private dimensions: {
        margin: { top: number; right: number; bottom: number; left: number };
        width: number;
        height: number;
    } = {
        margin: { top: 40, right: 40, bottom: 0, left: 20 },
        width: 0,
        height: 0,
    };

    constructor(container: HTMLElement, onStreamClickedUpper: (streamDetails: StreamDetail) => void) {
        this.container = container;
        this.onStreamClickedUpper = onStreamClickedUpper;
        this.clipId = "mux-waterfall-clip-" + ++instanceCounter;
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
        d3.select(this.container).selectAll("*").remove();
        this.svg = undefined;
        this.onStreamClicked = undefined;
    }

    protected setup(connection: QlogConnection): void {
        this.connection = connection;

        this.dimensions.margin = { top: 40, right: 40, bottom: 0, left: 20 };

        // width and height are the INTERNAL widths (so without the margins)
        this.dimensions.width = Math.max(
            0,
            this.container.clientWidth - this.dimensions.margin.left - this.dimensions.margin.right,
        );
        this.dimensions.height = this.barHeight;

        // clear old rendering
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
    }

    protected renderLive(names: MuxEventNames): void {
        const svg = this.svg!;
        const { streams, dataFrameCount, directionText } = extractWaterfallData(this.connection!, names);

        const { minBarHeight, svgHeight, circleWidth } = waterfallLayout(streams.size);
        this.dimensions.height = svgHeight;

        // update the height of the surrounding svg
        d3.select(this.container).select("svg").attr("height", this.dimensions.height);

        const xDomain = d3.scaleLinear().domain([1, dataFrameCount]).range([0, this.dimensions.width]);

        svg.append("g"); // the (empty) x axis group

        // need a bit more space for the circles at the beginning if they're at dataFrameCount 0 (not applied, as in qvis)
        svg.append("defs")
            .append("clipPath")
            .attr("id", this.clipId)
            .append("rect")
            .attr("width", this.dimensions.width + this.dimensions.margin.left)
            .attr("height", this.dimensions.height)
            .attr("x", -this.dimensions.margin.left)
            .attr("y", 0);

        const rects = svg.append("g");

        if (streams.size <= 1 || dataFrameCount < 5) {
            rects
                .append("text")
                .attr("x", 200)
                .attr("y", 100)
                .attr("dominant-baseline", "baseline")
                .style("text-anchor", "start")
                .style("font-size", "14px")
                .style("font-family", "Trebuchet MS")
                .attr("fill", "#000000")
                .text(WATERFALL_EMPTY_MESSAGE);
            return;
        }

        const rects2 = rects
            .selectAll<SVGGElement, StreamExtents>("rect")
            .data([...streams.values()])
            .enter()
            .append("g");

        const minWidth = 4; // 4px minimum width

        rects2
            .append("rect")
            .attr("x", (d) => xDomain(d.startIndex) - 0.15)
            .attr("y", (d) => d.order * minBarHeight)
            .attr("fill", (d) => streamColor(d.stream_id))
            .style("opacity", 1)
            .attr("class", "packet")
            .attr("width", (d) => Math.max(minWidth, xDomain(d.stopIndex) - xDomain(d.startIndex) + 0.3))
            .attr("height", Math.max(minBarHeight, 0.01))
            .on("click", (_event: MouseEvent, d) => {
                if (this.onStreamClickedUpper) {
                    // updates the stream detail in the React layer
                    this.onStreamClickedUpper({ stream_id: d.stream_id, data: streams.get(d.stream_id)! });
                }
                if (this.onStreamClicked) {
                    this.onStreamClicked("" + d.stream_id); // updates the byte-range chart
                }
            });

        const rectWidth = circleWidth;

        // request indicator: circle
        rects2
            .append("circle")
            .attr("cx", (d) => xDomain(d.requestIndex) + circleWidth / 2)
            .attr("cy", (d) => d.order * minBarHeight + circleWidth / 1.6) // 1.6 should be 2, but 1.6 somehow looks better...
            .attr("fill", (d) => streamColor(d.stream_id))
            .attr("stroke", "black")
            .attr("stroke-width", () => circleWidth / 5)
            .attr("r", circleWidth / 2);

        // HEADERS indicator: square
        rects2
            .filter((d) => !!d && !!d.h3Info && d.h3Info.headersIndex >= 0)
            .append("rect")
            .attr("x", (d) => xDomain(d.h3Info!.headersIndex))
            .attr("y", (d) => d.order * minBarHeight + rectWidth / 10)
            .attr("fill", (d) => streamColor(d.stream_id))
            .attr("stroke", "black")
            .attr("stroke-width", () => rectWidth / 5)
            .attr("width", rectWidth)
            .attr("height", rectWidth);

        // PRIORITY_UPDATE indicator: an equilateral triangle with the base at the bottom, drawn with relative
        // path commands (each coordinate is relative to the previous one)
        let trianglePath = "m 0," + rectWidth; // bottom left
        trianglePath += " l " + rectWidth + ",0"; // bottom right
        trianglePath += " l -" + rectWidth / 2 + ",-" + rectWidth; // the middle on top
        trianglePath += " z";

        rects2
            .filter((d) => !!d && !!d.h3Info && d.h3Info.priorityUpdateIndex >= 0)
            .append("path")
            .attr("d", trianglePath)
            // normal x and y don't work on a path
            .attr(
                "transform",
                (d) =>
                    "translate(" +
                    xDomain(d.h3Info!.priorityUpdateIndex) +
                    "," +
                    (d.order * minBarHeight + rectWidth / 10) +
                    ")",
            )
            .attr("fill", (d) => streamColor(d.stream_id))
            .attr("stroke", "black")
            .attr("stroke-width", () => rectWidth / 5);

        // legend top left
        const legendY = -this.dimensions.margin.top / 2;
        const legendIconWidth = 13;
        // M11 FIX: qvis anchored at xDomain(0) = -W/(N-1), which is far left (cut off) for small N
        const x0 = Math.max(xDomain(0), -this.dimensions.margin.left);
        // M10 FIX: the request goes the other way than the data
        const requestText = directionText === "received" ? "sent" : "received";

        rects
            .append("circle")
            .attr("cx", x0 + legendIconWidth / 2)
            .attr("cy", legendY)
            .attr("fill", "white")
            .attr("stroke", "black")
            .attr("stroke-width", legendIconWidth / 5)
            .attr("r", legendIconWidth / 2);

        rects
            .append("text")
            .attr("x", x0 + legendIconWidth / 2 + 20)
            .attr("y", legendY + 1) // + 1 is eyeballed magic number
            .attr("dominant-baseline", "middle")
            .style("text-anchor", "start")
            .style("font-size", "14px")
            .style("font-family", "Trebuchet MS")
            .attr("fill", "#000000")
            .text("Request " + requestText);

        rects
            .append("rect")
            .attr("x", x0 + legendIconWidth / 2 + 150)
            .attr("y", legendY - legendIconWidth / 2)
            .attr("fill", "white")
            .attr("stroke", "black")
            .attr("stroke-width", legendIconWidth / 5)
            .attr("width", 20)
            .attr("height", legendIconWidth);

        rects
            .append("text")
            .attr("x", x0 + legendIconWidth / 2 + 180)
            .attr("y", legendY)
            .attr("dominant-baseline", "middle")
            .style("text-anchor", "start")
            .style("font-size", "14px")
            .style("font-family", "Trebuchet MS")
            .attr("fill", "#000000")
            .text('Colored while stream is "active" (between first and last STREAM frame ' + directionText + ")");
    }
}

export { MultiplexingGraphD3WaterfallRenderer };
