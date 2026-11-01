// The "Selected stream's details" text (qvis MultiplexingGraphCollapsedRenderer.vue:8-21, :140-148;
// parity/multiplexing-graph.md §2.7). Shown after a click on a waterfall bar.

import type { CSSProperties } from "react";
import type { StreamDetail } from "./renderer/MultiplexingGraphD3WaterfallRenderer";
import { streamColor } from "./renderer/MultiplexingGraphDataHelper";
import { streamDuration } from "./renderer/multiplexingData";

export default function StreamDetails({ detail }: { detail: StreamDetail }) {
    const d = detail.data;
    const swatch: CSSProperties = {
        display: "inline-block",
        paddingRight: "10px",
        width: "50px",
        height: "100%",
        backgroundColor: streamColor(detail.stream_id),
    };
    const head =
        " : Requested at " +
        d.requestTime.toFixed(2) +
        "ms. Transmitted from " +
        d.startTime.toFixed(2) +
        "ms to " +
        d.endTime.toFixed(2) +
        "ms (" +
        streamDuration(d.startTime, d.endTime) +
        "ms). " +
        d.totalData +
        " bytes spread over " +
        d.frameCount +
        " frames (including retransmits). ";

    return (
        <div>
            <span style={swatch}>{"\u00a0"}</span>
            {" Stream "}
            <span className="font-weight-bold">{detail.stream_id}</span>
            {head}
            <br />
            {d.h3Info !== null ? (
                <div>
                    {"HTTP/3 HEADERS seen at " +
                        d.h3Info.headersTime.toFixed(2) +
                        "ms. HTTP/3 PRIORITY Update seen at " +
                        d.h3Info.priorityUpdateTime.toFixed(2) +
                        "ms. Priority info (if any): " +
                        d.h3Info.priorityString}
                </div>
            ) : null}
        </div>
    );
}

export { StreamDetails };
