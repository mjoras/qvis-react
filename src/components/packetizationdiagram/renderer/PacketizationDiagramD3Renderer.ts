// Port of qvis `components/packetizationdiagram/renderer/PacketizationDiagramD3Renderer.ts`
// (parity/packetization-diagram.md §2.4-§2.7, §3.1-§3.3, §3.8-§3.10, §8.2, §8.4). Imperative, framework-free.
//
// D3 v5 -> v7: event argument instead of d3.event, zoom filter/wheelDelta pinned to d3-zoom 1.8 defaults (ctrl+wheel is
// left to the browser), axis offset pinned to 0.5 (d3-axis 1 behaviour on HiDPI screens), "SVG:clipPath" -> clipPath,
// degenerate [0, 0] axis domain formatted as "0" like d3-scale 2 (d3-scale 4 prints "0.000000").
// Fixes: unique clip-path id per instance (Q-R1), render() is synchronous and has no stuck `rendering` flag (Q-L1),
// rect widths are clamped at 0 and non-finite coordinates at 0 (qvis logged "negative value" errors, E7),
// D-PZ4 note when lane 0 is empty. Labels use 14px: hosted qvis renders `.style("font-size", "14")` as 14px.

import * as d3 from "d3";
import type { QlogConnection } from "@/model/QlogConnection";
import {
    PacketizationDirection,
    type PacketizationLane,
    type PacketizationRange,
    type PacketizationResult,
} from "./PacketizationDiagramModels";
import PacketizationQUICPreProcessor from "./PacketizationQUICPreProcessor";
import PacketizationTCPPreProcessor from "./PacketizationTCPPreProcessor";

interface Dimensions {
    margin: { top: number; right: number; bottom: number; left: number };
    width: number;
    height: number;
}

const LABEL_FONT_SIZE = "14px";
const LABEL_FONT_FAMILY = "Trebuchet MS";

/** Runs the pre-processor matching the connection's protocol (§3.3: TCP mode iff protocolHint === "TCP_HTTP2"). */
export function preprocess(
    connection: QlogConnection,
    direction: PacketizationDirection,
    options: { silent?: boolean } = {},
): PacketizationResult {
    if (connection.protocolHint === "TCP_HTTP2") {
        return PacketizationTCPPreProcessor.process(connection, direction, options);
    }
    // assuming QUIC_H3
    return PacketizationQUICPreProcessor.process(connection, direction, options);
}

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

export default class PacketizationDiagramD3Renderer {
    public axisLocation: "top" | "bottom" = "bottom";

    protected readonly container: HTMLElement;
    protected readonly tooltipElement: HTMLElement;
    protected readonly clipId: string;

    protected svg: d3.Selection<SVGGElement, unknown, null, undefined> | undefined;
    protected tooltip: d3.Selection<HTMLElement, unknown, null, undefined>;
    protected connection: QlogConnection | undefined;
    protected direction: PacketizationDirection = PacketizationDirection.sending;

    protected totalHeight = 100;

    private dimensions: Dimensions = { margin: { top: 30, right: 0, bottom: 40, left: 100 }, width: 0, height: 0 };
    private renderedWidth: number | undefined = undefined;

    constructor(container: HTMLElement, tooltip: HTMLElement, clipId: string) {
        this.container = container;
        this.tooltipElement = tooltip;
        this.tooltip = d3.select(tooltip);
        this.clipId = clipId;
    }

    public getDirection(): PacketizationDirection {
        return this.direction;
    }

    /** The container clientWidth the current svg was laid out for (undefined before the first render). */
    public getRenderedWidth(): number | undefined {
        return this.renderedWidth;
    }

    /** Clears and renders one diagram from scratch (zoom resets). Synchronous; throws on bugs (the caller reports N-PZ2). */
    public render(connection: QlogConnection, direction: PacketizationDirection): PacketizationResult {
        this.setup(connection, direction);
        return this.renderLive();
    }

    /** Removes the diagram (e.g. the selected trace was removed). */
    public clear(): void {
        this.svg?.on(".zoom", null);
        d3.select(this.container).selectAll("*").remove();
        this.svg = undefined;
        this.connection = undefined;
        this.renderedWidth = undefined;
    }

    public dispose(): void {
        this.clear();
        this.tooltip.interrupt();
    }

    protected setup(connection: QlogConnection, direction: PacketizationDirection): void {
        this.connection = connection;
        this.direction = direction;

        const container = this.container;
        const clientWidth = container.clientWidth;
        this.renderedWidth = clientWidth;

        this.dimensions.margin = { top: 30, right: Math.round(clientWidth * 0.05), bottom: 20, left: 100 };
        if (this.axisLocation === "top") {
            this.dimensions.margin.top = 30;
        } else {
            this.dimensions.margin.bottom = 40;
        }

        // width and height are the INTERNAL widths (so without the margins)
        this.dimensions.width = clientWidth - this.dimensions.margin.left - this.dimensions.margin.right;
        this.dimensions.height = this.totalHeight;

        // clear old rendering
        this.svg?.on(".zoom", null);
        d3.select(container).selectAll("*").remove();

        this.svg = d3
            .select(container)
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

    protected renderLive(): PacketizationResult {
        const svg = this.svg!;
        const connection = this.connection!;
        const dims = this.dimensions;

        const result = preprocess(connection, this.direction);
        const lanes: PacketizationLane[] = result.lanes;

        let xMax = 0;
        if (lanes.length > 0 && lanes[0].ranges && lanes[0].ranges.length > 0) {
            const bottomRanges = lanes[0].ranges;
            xMax = bottomRanges[bottomRanges.length - 1].start + bottomRanges[bottomRanges.length - 1].size;
        }
        xMax = finite(xMax);

        svg.append("defs")
            .append("clipPath")
            .attr("id", this.clipId)
            .append("rect")
            .attr("width", Math.max(0, dims.width))
            .attr("height", dims.height)
            .attr("x", 0)
            .attr("y", 0);

        const rects = svg.append("g").attr("clip-path", "url(#" + this.clipId + ")");

        const packetSidePadding = 0.3;

        const xDomain = d3.scaleLinear().domain([0, xMax]).range([0, dims.width]);

        const axisFor = (scale: d3.ScaleLinear<number, number>) => {
            const axis = (this.axisLocation === "top" ? d3.axisTop(scale) : d3.axisBottom(scale)).offset(0.5);
            // E3 (empty lane 0, domain [0, 0]): d3-scale 2 formatted the single tick as "0"; d3-scale 4 derives an
            // infinite tick step and prints "0.000000". Every other domain formats identically in both versions.
            const [d0, d1] = scale.domain();
            return d0 === d1 ? axis.tickFormat(d3.format(",.0f")) : axis;
        };

        const xAxis = svg.append("g");
        if (this.axisLocation === "top") {
            xAxis.call(axisFor(xDomain));
        } else {
            xAxis.attr("transform", "translate(0," + dims.height + ")").call(axisFor(xDomain));
        }

        // https://bl.ocks.org/d3noob/a22c42db65eb00d4e369
        const mouseOver = (
            toString: (r: PacketizationRange) => string,
            data: PacketizationRange,
            event: MouseEvent,
        ) => {
            this.tooltip.transition().duration(100).style("opacity", 0.95);

            const text = toString(data);

            this.tooltip
                .html(text)
                .style("left", event.pageX + 15 + "px")
                .style("top", event.pageY - 75 + "px");
        };

        const mouseOut = () => {
            this.tooltip.transition().duration(200).style("opacity", 0);
        };

        const packetHeight = this.totalHeight * (1 / lanes.length);

        // e.g. ".quicpacket,.quicframe,.httpframe,.streampacket", to select all elements at once when zooming
        const allClassNames = lanes.map((lane) => "." + lane.CSSClassName).join(",");

        const rectX = (scale: d3.ScaleLinear<number, number>, d: PacketizationRange) =>
            finite(scale(d.start) - packetSidePadding);
        const rectWidth = (scale: d3.ScaleLinear<number, number>, d: PacketizationRange) =>
            Math.max(0, finite(scale(d.start + d.size) - scale(d.start) + packetSidePadding * 2));

        for (const [index, lane] of lanes.entries()) {
            // lanes[0] (e.g. QUIC packets) is drawn at the bottom; y=0 is the top, so invert the index
            const yOffsetMultiplier = lanes.length - index - 1;

            const heightModifier = lane.heightModifier !== undefined ? lane.heightModifier : 1;

            rects
                .selectAll<SVGRectElement, PacketizationRange>("rect." + lane.CSSClassName)
                .data(lane.ranges)
                .enter()
                .append("rect")
                .attr("x", (d) => rectX(xDomain, d))
                .attr("y", (d) => packetHeight * yOffsetMultiplier + packetHeight * (d.isPayload ? 0 : 0.4))
                .attr("fill", (d) => d.color)
                .style("opacity", 1)
                .attr("class", lane.CSSClassName)
                .attr("width", (d) => rectWidth(xDomain, d))
                .attr("height", (d) => heightModifier * (packetHeight * (d.isPayload ? 1 : 0.6)))
                .style("pointer-events", "all")
                .on("mouseover", (event: MouseEvent, d) => mouseOver(lane.rangeToString, d, event))
                .on("mouseout", mouseOut);

            this.appendLabel(
                svg,
                -5,
                packetHeight * yOffsetMultiplier + packetHeight / 1.75,
                "middle",
                "end",
                lane.name,
            ); // 1.75 should be 2, but eyeballing says 1.75 is better
        }

        const legendY = dims.height + dims.margin.bottom - 10;

        // legend
        this.appendLabel(
            svg,
            xDomain(xMax / 2),
            legendY,
            "baseline",
            "middle",
            "Bytes " + (this.direction === PacketizationDirection.sending ? "sent" : "received"),
        );

        if (lanes[0]?.max_size_local) {
            const localname =
                connection.vantagePoint && connection.vantagePoint.type === "server" ? "server" : "client";
            const remotename = localname === "client" ? "server" : "client";

            this.appendLabel(
                svg,
                xDomain(xMax) - 450,
                legendY,
                "baseline",
                "start",
                "max receiving size " + localname + ": " + lanes[0].max_size_local,
            );
            this.appendLabel(
                svg,
                xDomain(xMax),
                legendY,
                "baseline",
                "end",
                "max receiving size " + remotename + ": " + lanes[0].max_size_remote,
            );
        }

        if (lanes[0]?.efficiency) {
            this.appendLabel(
                svg,
                xDomain(0),
                legendY,
                "baseline",
                "start",
                "efficiency " + (lanes[0].efficiency * 100).toFixed(2) + "%",
            );
        }

        let flowLabel = "";
        if (connection.vantagePoint && connection.vantagePoint.type === "server") {
            flowLabel =
                this.direction === PacketizationDirection.sending
                    ? "Data sent from server to client (trace vantagepoint = server)"
                    : "Data received by server from client (trace vantagepoint = server)";
        } else if (connection.vantagePoint && connection.vantagePoint.type === "client") {
            flowLabel =
                this.direction === PacketizationDirection.sending
                    ? "Data sent from client to server (trace vantagepoint = client)"
                    : "Data received by client from server (trace vantagepoint = client)";
        }

        this.appendLabel(svg, xDomain(xMax / 2), -10, "baseline", "middle", flowLabel); // y eyeballed

        // D-PZ4: say why the diagram is empty
        if (result.emptyNote !== undefined) {
            svg.append("g")
                .attr("class", "packetization-empty-note")
                .append("text")
                .attr("x", dims.width / 2)
                .attr("y", dims.height / 2)
                .attr("dominant-baseline", "middle")
                .style("text-anchor", "middle")
                .style("font-size", LABEL_FONT_SIZE)
                .style("font-family", LABEL_FONT_FAMILY)
                .attr("fill", "#6c757d")
                .text(result.emptyNote);
        }

        const updateChart = (event: d3.D3ZoomEvent<SVGGElement, unknown>) => {
            // recover the new scale
            const newX = event.transform.rescaleX(xDomain);

            // update axes with these new boundaries
            xAxis.call(axisFor(newX));

            // update position
            rects
                .selectAll<SVGRectElement, PacketizationRange>(allClassNames)
                .attr("x", (d) => rectX(newX, d))
                .attr("width", (d) => rectWidth(newX, d));
        };

        const extent: [[number, number], [number, number]] = [
            [0, 0],
            [Math.max(0, dims.width), dims.height],
        ];
        const zoom = d3
            .zoom<SVGGElement, unknown>()
            .scaleExtent([1, 2000])
            .translateExtent(extent)
            .extent(extent)
            // d3-zoom 1.8 defaults (v3 accepts ctrl+wheel and multiplies the delta by 10 with ctrl)
            .filter((event: any) => !event.ctrlKey && !event.button)
            .wheelDelta(
                (event: WheelEvent) => -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002),
            )
            .on("zoom", updateChart);

        svg.call(zoom); // on the translated main <g> (Q-R4: only painted elements receive wheel/drag)

        return result;
    }

    private appendLabel(
        svg: d3.Selection<SVGGElement, unknown, null, undefined>,
        x: number,
        y: number,
        baseline: string,
        anchor: string,
        text: string,
    ): void {
        svg.append("g")
            .append("text")
            .attr("x", finite(x))
            .attr("y", finite(y))
            .attr("dominant-baseline", baseline)
            .style("text-anchor", anchor)
            .style("font-size", LABEL_FONT_SIZE)
            .style("font-family", LABEL_FONT_FAMILY)
            .attr("fill", "#000000")
            .text(text);
    }
}

export { PacketizationDiagramD3Renderer };
