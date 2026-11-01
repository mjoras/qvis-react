// Port of qvis congestiongraph/renderer/RecoveryGraphState.ts: geometry, DOM handles and scale of the RTT graph.
// `outerWidth` is the measured width of `#congestion-graph` (FIX Q19), see MainGraphState.

import type { Axis, NumberValue, ScaleLinear } from "d3";
import type { AnySelection } from "./MainGraphState";

export class RecoveryGraphState {
    public outerWidth: number;
    public outerHeight = 300;
    public margins = {
        top: 20,
        bottom: 60,
        left: 70,
        right: 70,
    };
    public innerWidth: number;
    public innerHeight: number;

    public svg: AnySelection<SVGSVGElement> | null = null;
    public graphSvg: AnySelection<SVGGElement> | null = null;
    public canvas: AnySelection<HTMLCanvasElement> | null = null;
    public canvasContext: CanvasRenderingContext2D | null = null;

    // x scale is shared with the main graph
    public xAxis: Axis<NumberValue> | null = null;
    public gxAxis: AnySelection<SVGGElement> | null = null;
    public xAxisText: AnySelection<SVGTextElement> | null = null;

    public yScale: ScaleLinear<number, number> | null = null;
    public yAxis: Axis<NumberValue> | null = null;
    public gyAxis: AnySelection<SVGGElement> | null = null;
    public originalRangeY: [number, number] = [0, 0];
    public rangeY: [number, number] = [0, 0];

    public zooming0RTTenabled = false;

    public constructor(outerWidth: number) {
        this.outerWidth = outerWidth;
        this.innerWidth = this.outerWidth - this.margins.left - this.margins.right;
        this.innerHeight = this.outerHeight - this.margins.top - this.margins.bottom;
    }

    public setOuterWidth(outerWidth: number): void {
        this.outerWidth = outerWidth;
        this.innerWidth = this.outerWidth - this.margins.left - this.margins.right;
    }

    public reset(): void {
        this.xAxis = null;
        this.yAxis = null;
        this.yScale = null;
        this.originalRangeY = [0, 0];
        this.rangeY = [0, 0];
    }
}
