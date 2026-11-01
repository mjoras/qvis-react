// Port of qvis CongestionGraphRenderer.vue: the bordered graph host `#congestion-graph` with the three legends, into
// which the imperative CongestionGraphD3Renderer appends the main and RTT graphs (ARCHITECTURE §4).
//
// The renderer instance lives for the component's lifetime (zoom, mode and toggles reset on remount, PARITY §3.1) and
// is exposed through `rendererRef` for the configurator's buttons. It re-renders when the model changes, i.e. when a
// different connection is selected (not on unrelated store changes, spec §8.2).

import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import CongestionGraphLegends from "./CongestionGraphLegends";
import CongestionGraphD3Renderer from "./renderer/CongestionGraphD3Renderer";
import type { CongestionModel } from "./renderer/congestionModel";

const HOST_STYLE: CSSProperties = {
    width: "100%",
    border: "5px solid #d4edda",
    minHeight: "200px",
    position: "relative",
};

export interface CongestionGraphRendererProps {
    model: CongestionModel | undefined;
    rendererRef: RefObject<CongestionGraphD3Renderer | null>;
    packetInfoRef: RefObject<HTMLDivElement | null>;
}

export default function CongestionGraphRenderer({ model, rendererRef, packetInfoRef }: CongestionGraphRendererProps) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const renderer = new CongestionGraphD3Renderer(hostRef.current!, packetInfoRef.current);
        rendererRef.current = renderer;
        return () => {
            renderer.dispose();
            if (rendererRef.current === renderer) rendererRef.current = null;
        };
    }, [rendererRef, packetInfoRef]);

    useEffect(() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        if (model) renderer.render(model);
        else renderer.clear();
    }, [model, rendererRef]);

    return (
        <div>
            <div id="congestion-graph" ref={hostRef} style={HOST_STYLE}>
                <CongestionGraphLegends />
            </div>
        </div>
    );
}

export { CongestionGraphRenderer };
