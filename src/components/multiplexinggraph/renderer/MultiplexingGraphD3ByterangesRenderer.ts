// Port of qvis `components/multiplexinggraph/renderer/MultiplexingGraphD3ByterangesRenderer.ts` (D3 v5 -> v7).
// "Byterange per STREAM frame": for one stream, x = frame index (shared with the data-flow strip), y = byte offset
// (top to bottom). See docs/dev/parity/multiplexing-graph.md §3.7.
//
// Deviations (FIX): synchronous render in try/finally (M20); a unique clip id per instance (M3); zoom() is a no-op
// before the first render and after clear() (M4, M5); the Y auto-fit falls back to [0, maxBytes] instead of a garbage
// domain when no frame of the stream is visible (M8). The M6 axisRight -> axisLeft switch and the M7 index math are
// preserved, and so is the d3 v5 0.5px axis offset at every devicePixelRatio (v5Axis).

import * as d3 from "d3";
import { byteRangeYDomain, type FrameDatum, type MovedDatum } from "./multiplexingData";
import { streamColor, v5Axis } from "./MultiplexingGraphDataHelper";

type GSelection = d3.Selection<SVGGElement, unknown, null, undefined>;
type XScale = d3.ScaleLinear<number, number>;

let instanceCounter = 0;

/**
 * Negative rect sizes (a zero-length FIN-only frame gives `yDomain(-1) < 0`) are not rendered by browsers either, but
 * Chrome logs them as console errors; clamp them to 0 (no visible change).
 */
function nonNegative(v: number): number {
    return v > 0 ? v : 0;
}

export default class MultiplexingGraphD3ByterangesRenderer {
    public readonly container: HTMLElement;
    public rendering: boolean = false;

    protected svg: GSelection | undefined = undefined;
    protected height = 500;

    private readonly clipId: string;
    private dimensions: {
        margin: { top: number; right: number; bottom: number; left: number };
        width: number;
        height: number;
    } = {
        margin: { top: 20, right: 40, bottom: 20, left: 20 },
        width: 0,
        height: 0,
    };

    private updateZoom: ((newX: XScale) => void) | undefined = undefined;

    constructor(container: HTMLElement) {
        this.container = container;
        this.clipId = "mux-byterange-clip-" + ++instanceCounter;
    }

    public render(allFrames: readonly FrameDatum[], allDataMoved: readonly MovedDatum[], streamID: number): boolean {
        if (this.rendering) {
            return false;
        }
        this.rendering = true;
        try {
            if (allFrames.length === 0) {
                // nothing to scale the x axis on (qvis never called render without frames)
                this.clear();
                return false;
            }
            this.setup();
            this.renderLive(allFrames, allDataMoved, streamID);
            return true;
        } finally {
            this.rendering = false;
        }
    }

    public zoom(newXDomain: XScale): void {
        this.updateZoom?.(newXDomain);
    }

    /** M5: remove the drawing (e.g., the new trace has no data frames). */
    public clear(): void {
        d3.select(this.container).selectAll("*").remove();
        this.svg = undefined;
        this.updateZoom = undefined;
    }

    public dispose(): void {
        this.clear();
    }

    protected setup(): void {
        this.dimensions.margin = { top: 20, right: 40, bottom: 20, left: 20 };

        // width and height are the INTERNAL widths (so without the margins)
        // (clamped at 0: a negative clip-path width would be logged as an error for a collapsed container)
        this.dimensions.width = Math.max(
            0,
            this.container.clientWidth - this.dimensions.margin.left - this.dimensions.margin.right,
        );
        this.dimensions.height = this.height;

        // clear old rendering
        d3.select(this.container).selectAll("*").remove();
        this.updateZoom = undefined;

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

    protected renderLive(
        allFrames: readonly FrameDatum[],
        allDataMoved: readonly MovedDatum[],
        streamID: number,
    ): void {
        const svg = this.svg!;

        const streamFrames = allFrames.filter((d) => d.streamID === streamID);
        const dataMoved = allDataMoved.filter((d) => d.streamID === streamID);

        // the final frame isn't necessarily the last one in the file, due to retransmits: search for the largest
        let maxBytes = 0;
        for (const frame of streamFrames) {
            const max = frame.offset + frame.length - 1;
            if (max > maxBytes) {
                maxBytes = max;
            }
        }

        const xDomain = d3
            .scaleLinear()
            .domain([1, allFrames[allFrames.length - 1].countEnd])
            .range([0, this.dimensions.width]);

        const xAxis = svg.append("g");
        xAxis.call(v5Axis(d3.axisTop(xDomain), xDomain));

        const yDomain = d3.scaleLinear().domain([0, maxBytes]).range([0, this.dimensions.height]);

        const yAxis = svg.append("g").attr("transform", "translate(0, 0)");
        yAxis.call(v5Axis(d3.axisRight(yDomain), yDomain));

        svg.append("defs")
            .append("clipPath")
            .attr("id", this.clipId)
            .append("rect")
            .attr("width", this.dimensions.width)
            .attr("height", this.dimensions.height)
            .attr("x", 0)
            .attr("y", 0);

        const rects = svg.append("g").attr("clip-path", "url(#" + this.clipId + ")");

        rects
            .selectAll("rect.packet")
            .data(streamFrames)
            .enter()
            .append("rect")
            .attr("x", (d) => xDomain(d.countStart))
            .attr("y", (d) => yDomain(d.offset))
            .attr("fill", (d) => streamColor(d.streamID))
            .style("opacity", 1)
            .attr("class", "packet")
            .attr("width", (d) => Math.max(1, xDomain(d.countEnd) - xDomain(d.countStart)))
            .attr("height", (d) => Math.max(1, yDomain(d.length - 1)));

        const opacity = 0.2;
        rects
            .selectAll("rect.pingback")
            .data(streamFrames)
            .enter()
            .append("rect")
            .attr("x", () => xDomain(1))
            .attr("y", (d) => yDomain(d.offset))
            .attr("fill", (d) => streamColor(d.streamID))
            .style("opacity", opacity)
            .attr("class", "pingback")
            .attr("width", (d) => Math.max(1, xDomain(d.countEnd) - xDomain(1)))
            .attr("height", (d) => nonNegative(yDomain(d.length - 1)));

        const movedOffset = 1;
        rects
            .selectAll("rect.dataMoved")
            .data(dataMoved)
            .enter()
            .append("rect")
            .attr("x", (d) => xDomain(d.countStart + movedOffset))
            .attr("y", (d) => yDomain(d.offset))
            .attr("fill", "black")
            .style("opacity", 1)
            .attr("class", "dataMoved")
            .attr("width", (d) => Math.max(1, xDomain(d.countEnd) - xDomain(d.countStart)))
            .attr("height", (d) => nonNegative(yDomain(d.offset + d.length - 1) - yDomain(d.offset)));

        this.updateZoom = (newX: XScale) => {
            const [d0, d1] = newX.domain();
            const [startY, endY] = byteRangeYDomain(allFrames, streamID, [d0, d1], maxBytes);
            const newY = yDomain.copy().domain([startY, endY]);

            xAxis.call(v5Axis(d3.axisTop(newX), newX));
            yAxis.call(v5Axis(d3.axisLeft(newY), newY));

            rects
                .selectAll<SVGRectElement, FrameDatum>(".packet")
                .attr("x", (d) => newX(d.countStart))
                .attr("width", (d) => Math.max(1, newX(d.countEnd) - newX(d.countStart)))
                .attr("y", (d) => newY(d.offset))
                .attr("height", (d) => Math.max(1, newY(d.offset + d.length - 1) - newY(d.offset)));

            rects
                .selectAll<SVGRectElement, FrameDatum>(".pingback")
                .attr("x", () => newX(1))
                .attr("width", (d) => nonNegative(newX(d.countEnd) - newX(1)))
                .attr("y", (d) => newY(d.offset))
                .attr("height", (d) => nonNegative(newY(d.offset + d.length - 1) - newY(d.offset)));

            rects
                .selectAll<SVGRectElement, MovedDatum>(".dataMoved")
                .attr("x", (d) => newX(d.countStart + movedOffset))
                .attr("width", (d) => Math.max(1, newX(d.countEnd) - newX(d.countStart)))
                .attr("y", (d) => newY(d.offset))
                .attr("height", (d) => nonNegative(newY(d.offset + d.length - 1) - newY(d.offset)));
        };
    }
}

export { MultiplexingGraphD3ByterangesRenderer };
