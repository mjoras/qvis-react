// Port of qvis CongestionGraphContainer.vue (parity/congestion-graph.md §2.1): configurator, the hover tooltip box
// `#packetInfo` and the graph. The DOM order is kept: the tooltip is absolutely positioned at its static position
// (the top-left corner of `#congestion-graph`) and offset with margins by the renderer; the legends come later in the
// DOM and therefore paint over it (PARITY §2.6).
//
// The model is built once per selected connection; the renderer handle lives in a ref (never in the store, §8.2).

import { useMemo, useRef, type CSSProperties } from "react";
import { useConfigurationStore } from "@/store/configurationStore";
import CongestionGraphConfigurator from "./CongestionGraphConfigurator";
import CongestionGraphRenderer from "./CongestionGraphRenderer";
import "./CongestionGraph.css";
import type CongestionGraphD3Renderer from "./renderer/CongestionGraphD3Renderer";
import { buildCongestionModel } from "./renderer/congestionModel";

const PACKET_INFO_STYLE: CSSProperties = {
    position: "absolute",
    display: "none",
    zIndex: 100,
    padding: "5px",
    border: "1px solid black",
    backgroundColor: "white",
};

export default function CongestionGraphContainer() {
    const connection = useConfigurationStore((s) => s.congestionConfig.connection);
    const model = useMemo(
        () => (connection !== undefined ? buildCongestionModel(connection) : undefined),
        [connection],
    );

    const rendererRef = useRef<CongestionGraphD3Renderer | null>(null);
    const packetInfoRef = useRef<HTMLDivElement>(null);

    return (
        <div className="home" id="CongestionGraphContainer">
            <CongestionGraphConfigurator connection={connection} model={model} rendererRef={rendererRef} />
            <div id="packetInfo" ref={packetInfoRef} style={PACKET_INFO_STYLE}>
                <p id="timestamp"></p>
                <p id="packetNr"></p>
                <p id="packetSize"></p>
                <p id="ackedFrom"></p>
                <p id="ackedTo"></p>
            </div>
            <CongestionGraphRenderer model={model} rendererRef={rendererRef} packetInfoRef={packetInfoRef} />
        </div>
    );
}

export { CongestionGraphContainer };
