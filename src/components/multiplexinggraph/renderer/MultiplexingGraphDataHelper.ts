// Port of qvis `components/multiplexinggraph/renderer/MultiplexingGraphDataHelper.ts`.

import * as d3 from "d3";
import { streamIdToColor } from "@/lib/colorHelper";

export default class MultiplexingGraphDataHelper {
    /** Client-initiated bidirectional stream (HTTP/3 request stream). */
    public static isDataStream(streamID: string): boolean {
        return parseInt(streamID, 10) % 4 === 0;
    }

    /** `[fill, "black"]` from the HTTP/3 stream palette (parity/app-shell.md §3.7). */
    public static StreamIDToColor(streamID: string): [string, "black"] {
        return streamIdToColor(streamID, "HTTP3");
    }
}

/** Stream fill color, `ColorHelper.StreamIDToColor("" + id, "HTTP3")[0]`. */
export function streamColor(streamID: number | string): string {
    return streamIdToColor("" + streamID, "HTTP3")[0];
}

export { MultiplexingGraphDataHelper };

// ---- D3 v5 (qvis) -> v7 differences, restored for pixel and gesture parity (parity/multiplexing-graph.md §3.6, §3.7)

/**
 * D3 v5 -> v7: for a degenerate domain ([1, 1] for a trace without data frames, [0, 0] for a stream without bytes) the
 * v7 linear tick format has no precision and prints "1.000000"; d3 v5 (qvis) printed "1". Restore the v5 output.
 */
export function withV5TickFormat<A extends d3.Axis<d3.NumberValue>>(axis: A, scale: d3.ScaleLinear<number, number>): A {
    const [d0, d1] = scale.domain();
    if (d0 === d1) {
        axis.tickFormat(d3.format(",.0f"));
    }
    return axis;
}

/**
 * Every axis of this view, drawn as d3 v5 (qvis) drew it: d3-axis v1 always shifted the domain path and the ticks by
 * 0.5px (crisp 1px lines), d3-axis v3 drops that offset when `devicePixelRatio > 1`, which moves every axis line and
 * tick half a pixel left/up on retina screens. Also applies the degenerate-domain tick format of withV5TickFormat.
 */
export function v5Axis<A extends d3.Axis<d3.NumberValue>>(axis: A, scale: d3.ScaleLinear<number, number>): A {
    axis.offset(0.5);
    return withV5TickFormat(axis, scale);
}

/** d3-zoom v1 (qvis) `filter`: ignore ctrl-modified events (a trackpad pinch arrives as ctrl+wheel) and non-primary buttons. */
export function v5ZoomFilter(event: { ctrlKey?: boolean; button?: number }): boolean {
    return !event.ctrlKey && !event.button;
}

/** d3-zoom v1 (qvis) `wheelDelta`: d3-zoom v3 multiplies ctrl+wheel by 10 (unreachable with v5ZoomFilter anyway). */
export function v5WheelDelta(event: WheelEvent): number {
    return -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002);
}

/**
 * The d3-zoom v1 (qvis) gesture defaults on a d3 v7 zoom behaviour: d3-zoom v3 also zooms on ctrl+wheel, i.e. on a
 * trackpad pinch, which qvis leaves to the browser (page zoom), and treats any device with `navigator.maxTouchPoints`
 * as touchable.
 */
export function withV5ZoomGestures<E extends Element, D>(zoom: d3.ZoomBehavior<E, D>): d3.ZoomBehavior<E, D> {
    return zoom
        .filter(v5ZoomFilter)
        .wheelDelta(v5WheelDelta)
        .touchable(function (this: E) {
            return "ontouchstart" in this;
        });
}
