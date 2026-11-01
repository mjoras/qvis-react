// Port of qvis `components/multiplexinggraph/MultiplexingGraphRenderer.vue` (parity/multiplexing-graph.md §2.1, §3.8):
// the (never filled) stats row, one panel per selected trace (key = index, so panel 0 is reused, as in qvis) and the
// single tooltip shared by all panels.

import { useState } from "react";
import type MultiplexingGraphConfig from "./data/MultiplexingGraphConfig";
import MultiplexingGraphCollapsedRenderer from "./MultiplexingGraphCollapsedRenderer";

export interface MultiplexingGraphRendererProps {
    config: MultiplexingGraphConfig;
}

export default function MultiplexingGraphRenderer({ config }: MultiplexingGraphRendererProps) {
    const [tooltipEl, setTooltipEl] = useState<HTMLDivElement | null>(null);

    return (
        <div>
            {/* M2: #multiplexing-stats and #multiplexing-stats-streams are never filled */}
            <div className="container-fluid">
                <div className="row align-items-center">
                    <div className="col-6">
                        <div id="multiplexing-stats" style={{ width: "100%" }}></div>
                    </div>
                    <div className="col-6">
                        <div id="multiplexing-stats-streams" style={{ width: "100%" }}></div>
                    </div>
                </div>
            </div>

            {config.connections.map((connection, index) => (
                <MultiplexingGraphCollapsedRenderer
                    key={index}
                    connection={connection}
                    showwaterfall={config.showwaterfall}
                    showbyteranges={config.showbyteranges}
                    tooltipEl={tooltipEl}
                />
            ))}

            <div id="multiplexing-packet-tooltip" ref={setTooltipEl}></div>
        </div>
    );
}

export { MultiplexingGraphRenderer };
