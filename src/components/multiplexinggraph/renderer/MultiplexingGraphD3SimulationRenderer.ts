// Port of qvis `components/multiplexinggraph/renderer/MultiplexingGraphD3SimulationRenderer.ts` (D3 v5 -> v7).
// "Simulated FIFO order": one box per request (HEADERS frame) in request order. Dead code in qvis: it is never
// constructed and its row is display: none (docs/dev/parity/multiplexing-graph.md §3.10, M1). Ported for completeness
// only; the panel never mounts it (PRESERVE the invisibility).

import * as d3 from "d3";
import type { QlogConnection } from "@/model/QlogConnection";
import { extractSimulationRequests, type SimulatedRequest } from "./multiplexingData";
import { streamColor } from "./MultiplexingGraphDataHelper";

type GSelection = d3.Selection<SVGGElement, unknown, null, undefined>;

let instanceCounter = 0;

export default class MultiplexingGraphD3SimulationRenderer {
    public readonly container: HTMLElement;
    public rendering: boolean = false;

    protected svg: GSelection | undefined = undefined;
    protected connection: QlogConnection | undefined = undefined;

    protected barHeight = 50;

    private readonly clipId: string;
    private dimensions: {
        margin: { top: number; right: number; bottom: number; left: number };
        width: number;
        height: number;
    } = {
        margin: { top: 20, right: 0, bottom: 0, left: 5 },
        width: 0,
        height: 0,
    };

    constructor(container: HTMLElement) {
        this.container = container;
        this.clipId = "mux-fifo-clip-" + ++instanceCounter;
    }

    public render(connection: QlogConnection): boolean {
        if (this.rendering) {
            return false;
        }
        this.rendering = true;
        try {
            this.setup(connection);
            this.renderLive();
            return true;
        } finally {
            this.rendering = false;
        }
    }

    public dispose(): void {
        d3.select(this.container).selectAll("*").remove();
        this.svg = undefined;
    }

    protected setup(connection: QlogConnection): void {
        this.connection = connection;
        const clientWidth = this.container.clientWidth;

        this.dimensions.margin = { top: 20, right: Math.round(clientWidth * 0.05), bottom: 0, left: 5 };

        // width and height are the INTERNAL widths (so without the margins)
        this.dimensions.width = Math.max(0, clientWidth - this.dimensions.margin.left - this.dimensions.margin.right);
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

    protected renderLive(): void {
        const svg = this.svg!;
        const requestsSent = extractSimulationRequests(this.connection!);
        const requestCount = requestsSent.length + 1;

        const xDomain = d3.scaleLinear().domain([1, requestCount]).range([0, this.dimensions.width]);

        svg.append("g"); // the (empty) x axis group

        svg.append("defs")
            .append("clipPath")
            .attr("id", this.clipId)
            .append("rect")
            .attr("width", this.dimensions.width)
            .attr("height", this.dimensions.height)
            .attr("x", 0)
            .attr("y", 0);

        const rects = svg.append("g").attr("clip-path", "url(#" + this.clipId + ")");

        const rects2 = rects.selectAll<SVGGElement, SimulatedRequest>("rect").data(requestsSent).enter().append("g");

        // background
        rects2
            .append("rect")
            .attr("x", (d) => xDomain(d.count) - 0.15)
            .attr("y", 0)
            .attr("fill", (d) => streamColor(d.streamID))
            .style("opacity", 1)
            .attr("class", "packet")
            .attr("width", (d) => xDomain(d.count + 1) - xDomain(d.count) + 0.3)
            .attr("height", this.barHeight);

        // textbox
        rects2
            .append("rect")
            .attr("x", (d) => xDomain(d.count) + 15)
            .attr("y", 15)
            .attr("fill", "#FFFFFF")
            .style("opacity", 0.75)
            .attr("width", (d) => Math.max(0, xDomain(d.count + 1) - xDomain(d.count) - 30))
            .attr("height", this.barHeight * 0.4);

        // text
        rects2
            .append("text")
            .attr("x", (d) => xDomain(d.count) + 15 + 2)
            .attr("y", 15 + (this.barHeight * 0.4) / 2)
            .attr("dominant-baseline", "middle")
            .style("text-anchor", "start")
            .style("font-size", "14px")
            .style("font-family", "Trebuchet MS")
            .style("font-weight", "bold")
            .attr("fill", "#000000")
            .text((d) => d.text);
    }
}

export { MultiplexingGraphD3SimulationRenderer };
