// Port of qvis congestiongraph/renderer/MainGraphState.ts: geometry, DOM handles, scales and ranges of the main graph
// (data sent / acked / lost, congestion info, flow control).
//
// Differences (parity/congestion-graph.md): the received perspective is dormant in qvis and not ported (§3.11), so only
// the sent perspective exists; the step series live in the CongestionModel; `outerWidth` is the measured width of
// `#congestion-graph` instead of `window.innerWidth` (FIX Q19) and can change on re-layout.

import type { Axis, BrushBehavior, NumberValue, ScaleLinear, Selection } from "d3";

export type AnySelection<E extends Element = Element> = Selection<E, unknown, null, undefined>;

export interface PerspectiveInfo {
    xScale: ScaleLinear<number, number> | null;
    /** packet_sent, ACK and loss rectangles, flow-control lines */
    yScale: ScaleLinear<number, number> | null;
    /** congestion window and bytes in flight (right axis; fixed per render) */
    yCongestionScale: ScaleLinear<number, number> | null;
    xAxis: Axis<NumberValue> | null;
    yAxis: Axis<NumberValue> | null;
    yCongestionAxis: Axis<NumberValue> | null;
    rangeX: [number, number];
    rangeY: [number, number];
    originalRangeX: [number, number];
    originalRangeY: [number, number];
    drawScaleX: number;
    drawScaleY: number;
}

export class MainGraphState {
    public outerWidth: number;
    public outerHeight = 600;
    public margins = {
        top: 20,
        bottom: 60,
        left: 70,
        right: 70,
    };
    public innerWidth: number;
    public innerHeight: number;
    /** canvas backing-store scale (FIX Q18) */
    public dpr = 1;

    public svg: AnySelection<SVGSVGElement> | null = null;
    public graphSvg: AnySelection<SVGGElement> | null = null;
    public canvas: AnySelection<HTMLCanvasElement> | null = null;
    public canvasContext: CanvasRenderingContext2D | null = null;
    public mouseHandlerPanningSvg: AnySelection<SVGSVGElement> | null = null;
    public mouseHandlerBrushXSvg: AnySelection<SVGSVGElement> | null = null;
    public mouseHandlerBrush2dSvg: AnySelection<SVGSVGElement> | null = null;
    public mouseHandlerSelectionSvg: AnySelection<SVGSVGElement> | null = null;
    public mouseHandlerPickSvg: AnySelection<SVGSVGElement> | null = null;
    public mouseHandlerRulerSvg: AnySelection<SVGSVGElement> | null = null;
    public brushX: BrushBehavior<unknown> | null = null;
    public brushXElement: AnySelection<SVGGElement> | null = null;
    public brush2d: BrushBehavior<unknown> | null = null;
    public brush2dElement: AnySelection<SVGGElement> | null = null;
    public congestionGraphEnabled = true;

    public gxAxis: AnySelection<SVGGElement> | null = null;
    public gyAxis: AnySelection<SVGGElement> | null = null;
    public gyCongestionAxis: AnySelection<SVGGElement> | null = null;

    public xAxisText: AnySelection<SVGTextElement> | null = null;
    public congestionAxisText: AnySelection<SVGTextElement> | null = null;

    /** Perspective in which packet_sent events play the main role (the only one reachable from the UI). */
    public sent!: PerspectiveInfo;

    public constructor(outerWidth: number) {
        this.outerWidth = outerWidth;
        this.innerWidth = this.outerWidth - this.margins.left - this.margins.right;
        this.innerHeight = this.outerHeight - this.margins.top - this.margins.bottom;
        this.reset();
    }

    public setOuterWidth(outerWidth: number): void {
        this.outerWidth = outerWidth;
        this.innerWidth = this.outerWidth - this.margins.left - this.margins.right;
    }

    public currentPerspective(): PerspectiveInfo {
        return this.sent;
    }

    public reset(): void {
        this.sent = {
            xScale: null,
            yScale: null,
            yCongestionScale: null,
            xAxis: null,
            yAxis: null,
            yCongestionAxis: null,
            rangeX: [0, 0],
            rangeY: [0, 0],
            originalRangeX: [0, 0],
            originalRangeY: [0, 0],
            drawScaleX: 1,
            drawScaleY: 1,
        };
    }
}
