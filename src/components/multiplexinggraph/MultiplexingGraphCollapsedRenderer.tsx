// Port of qvis `components/multiplexinggraph/MultiplexingGraphCollapsedRenderer.vue`: despite its name, the per-trace
// panel that hosts the waterfall, the multiplexed data flow strip and the byte-range chart
// (parity/multiplexing-graph.md §2.4, §2.5, §2.7, §2.9, §8.4).
//
// Lifecycle (replaces qvis updateRenderers() + skipRender): a layout effect sets the three chart widths and renders the
// charts synchronously whenever the connection, a checkbox or the h4 label (qvis updated() hook) changes. The stream
// detail state is NOT a dependency (M19), so a waterfall click only re-renders the byte-range chart. The detail is
// cleared when the connection changes (M17 FIX). Each panel measures itself (M27 FIX).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConnectionStore } from "@/store/connectionStore";
import StreamDetails from "./StreamDetails";
import MultiplexingGraphD3CollapsedRenderer from "./renderer/MultiplexingGraphD3CollapsedRenderer";
import MultiplexingGraphD3WaterfallRenderer, {
    type StreamDetail,
} from "./renderer/MultiplexingGraphD3WaterfallRenderer";
import { eventNames } from "./renderer/multiplexingData";

export interface MultiplexingGraphCollapsedRendererProps {
    connection: QlogConnection | undefined;
    showwaterfall: boolean;
    showbyteranges: boolean;
    /** the shared #multiplexing-packet-tooltip element (null until it is mounted) */
    tooltipEl: HTMLElement | null;
}

let panelCounter = 0;

/** qvis: `"multiplexing-fifo-" + Math.round(Math.random() * 100000)`, shared by the panel's four chart divs. */
function newPanelId(): number {
    return ++panelCounter;
}

interface Renderers {
    waterfall?: MultiplexingGraphD3WaterfallRenderer;
    data?: MultiplexingGraphD3CollapsedRenderer;
}

export default function MultiplexingGraphCollapsedRenderer({
    connection,
    showwaterfall,
    showbyteranges,
    tooltipEl,
}: MultiplexingGraphCollapsedRendererProps) {
    const [panelId] = useState(newPanelId);

    const topRef = useRef<HTMLDivElement>(null);
    const waterfallRef = useRef<HTMLDivElement>(null);
    const dataRef = useRef<HTMLDivElement>(null);
    const byterangeRef = useRef<HTMLDivElement>(null);
    const renderers = useRef<Renderers>({});

    // M17 FIX: a detail belongs to the connection it was clicked in
    const [streamDetail, setStreamDetail] = useState<StreamDetail | null>(null);
    const [detailConnection, setDetailConnection] = useState(connection);
    if (detailConnection !== connection) {
        setDetailConnection(connection);
        setStreamDetail(null);
    }

    // in-place model changes (e.g. a renamed trace) bump the store revision: recompute the h4. As with qvis's updated()
    // hook, the charts re-render only when the h4 text actually changed (it is an effect dependency below).
    useConnectionStore((s) => s.revision);
    const title = connection !== undefined ? connection.parent.filename + " : " + connection.getLongName() : "";

    useLayoutEffect(() => {
        const top = topRef.current;
        const dataDiv = dataRef.current;
        if (!top || !dataDiv) {
            return;
        }

        // All three charts need the exact same width. 15px padding on each side of each column and the container
        // gives 90px; the first column is 1/12th; then 99% of the remaining 11/12th (no horizontal scrollbar) = 0.9075
        const fixedWidth = Math.ceil((top.clientWidth - 90) * 0.9075) + "px";
        dataDiv.style.width = fixedWidth;
        if (showwaterfall && waterfallRef.current) {
            waterfallRef.current.style.width = fixedWidth;
        }
        if (showbyteranges && byterangeRef.current) {
            byterangeRef.current.style.width = fixedWidth;
        }

        if (connection === undefined || tooltipEl === null) {
            return;
        }

        const r = renderers.current;
        if (!r.data || r.data.container !== dataDiv) {
            r.data?.dispose();
            r.data = new MultiplexingGraphD3CollapsedRenderer(dataDiv, tooltipEl);
        }

        const waterfallDiv = showwaterfall ? waterfallRef.current : null;
        if (waterfallDiv === null) {
            r.waterfall?.dispose();
            r.waterfall = undefined;
        } else if (!r.waterfall || r.waterfall.container !== waterfallDiv) {
            r.waterfall?.dispose();
            r.waterfall = new MultiplexingGraphD3WaterfallRenderer(waterfallDiv, setStreamDetail);
        }

        // the strip and the waterfall must agree on the event sources (§9.6.1)
        const names = eventNames(connection);
        if (r.waterfall) {
            r.waterfall.render(connection, names);
            // needed to hook up the click handlers (qvis: "quite dirty")
            r.data.waterfallRenderer = r.waterfall;
        } else {
            r.data.waterfallRenderer = undefined;
        }
        r.data.setByteRangeContainer(showbyteranges ? byterangeRef.current : null);
        r.data.render(connection, names);
    }, [connection, showwaterfall, showbyteranges, tooltipEl, title]);

    useEffect(() => {
        const r = renderers.current;
        return () => {
            r.waterfall?.dispose();
            r.data?.dispose();
            r.waterfall = undefined;
            r.data = undefined;
        };
    }, []);

    return (
        <div ref={topRef} id="multiplexingToplevelContainer" className="container-fluid" style={PANEL_STYLE}>
            <div className="row align-items-center" style={{ textAlign: "center" }}>
                <div className="col-12">
                    <h4>{title}</h4>
                </div>
            </div>
            {streamDetail !== null ? (
                <div className="row align-items-center" style={{ width: "100%" }}>
                    <div className="col-1">Selected stream&apos;s details</div>
                    <div className="col-11">
                        <StreamDetails detail={streamDetail} />
                    </div>
                </div>
            ) : null}
            {showwaterfall ? (
                <div className="row align-items-center" style={{ height: "165px", width: "100%" }}>
                    <div className="col-1">Waterfall</div>
                    <div className="col-11">
                        {/* wrapper to prevent issues with width calculations due to the potential vertical scrollbar */}
                        <div style={{ width: "100%", height: "165px", overflowY: "auto" }}>
                            <div ref={waterfallRef} id={"multiplexing-waterfall-" + panelId}></div>
                        </div>
                    </div>
                </div>
            ) : null}
            <div className="row" style={{ height: "5px" }}></div>
            {/* M1 PRESERVE: the simulation renderer is dead code in qvis; its row is never visible */}
            <div className="row align-items-center" style={FIFO_ROW_STYLE}>
                <div className="col-1">Simulated FIFO order</div>
                <div className="col-11">
                    <div id={"multiplexing-fifo-" + panelId} style={{ width: "100%" }}></div>
                </div>
            </div>
            <div className="row" style={{ height: "5px" }}></div>
            <div className="row align-items-center" style={{ height: "110px", width: "100%" }}>
                <div className="col-1">Multiplexed data flow</div>
                <div className="col-11">
                    <div ref={dataRef} id={"multiplexing-data-" + panelId} style={{ width: "100%" }}></div>
                </div>
            </div>
            {showbyteranges ? (
                <div
                    className="row align-items-center"
                    style={{ height: "520px", width: "100%", marginBottom: "10px" }}
                >
                    <div className="col-1">Byterange per STREAM frame</div>
                    <div className="col-11">
                        <div
                            ref={byterangeRef}
                            id={"multiplexing-byterange-" + panelId}
                            style={{ width: "100%" }}
                        ></div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// the component's own `width: 100%` merged with the parent's `width: 100%; border: 5px solid #d1ecf1`
const PANEL_STYLE = { width: "100%", border: "5px solid #d1ecf1" } as const;
const FIFO_ROW_STYLE = { height: "70px", width: "100%", border: "1px solid red", display: "none" } as const;

export { MultiplexingGraphCollapsedRenderer };
