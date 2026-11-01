// Port of qvis CongestionGraphConfigurator.vue (parity/congestion-graph.md §2.2): intro text, trace picker, the six
// buttons, the no-file alerts, the `R` key, and the default selection of the first trace of the first file.
//
// Additions: the Q41 notice for traces with nothing to plot, Q39 (the `R` key is ignored while typing in a form
// control or with Ctrl / Meta / Alt), Q10 (buttons are no-ops until a trace is rendered, handled by the renderer).

import { useEffect, type CSSProperties, type RefObject } from "react";
import ConnectionConfigurator from "@/components/shared/ConnectionConfigurator";
import NoTraceAlerts from "@/components/shared/NoTraceAlerts";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import HoverTooltipButton from "./HoverTooltipButton";
import type CongestionGraphD3Renderer from "./renderer/CongestionGraphD3Renderer";
import { congestionNotice, type CongestionModel } from "./renderer/congestionModel";

const PANEL_STYLE: CSSProperties = { backgroundColor: "#d4edda", padding: "0px 10px" };

export interface CongestionGraphConfiguratorProps {
    connection: QlogConnection | undefined;
    model: CongestionModel | undefined;
    rendererRef: RefObject<CongestionGraphD3Renderer | null>;
}

/** Q39: typing in a form control (e.g. select type-ahead) or a shortcut with modifiers must not arm the ruler. */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

export default function CongestionGraphConfigurator({
    connection,
    model,
    rendererRef,
}: CongestionGraphConfiguratorProps) {
    const groups = useConnectionStore((s) => s.groups);
    const revision = useConnectionStore((s) => s.revision);
    const update = useConfigurationStore((s) => s.update);

    // default selection: the first trace of the first file (qvis mounted() / updated() -> selectDefault())
    useEffect(() => {
        if (connection === undefined && groups.length > 0) {
            const first = groups[0].getConnections()[0];
            if (first !== undefined) {
                update("congestionConfig", { connection: first });
            }
        }
    }, [connection, groups, revision, update]);

    // "Ruler (press R)"
    useEffect(() => {
        const onKeyUp = (evt: KeyboardEvent): void => {
            if (evt.code !== "KeyR") return;
            if (evt.ctrlKey || evt.metaKey || evt.altKey || isTypingTarget(evt.target)) return;
            rendererRef.current?.useRuler();
        };
        document.addEventListener("keyup", onKeyUp);
        return () => document.removeEventListener("keyup", onKeyUp);
    }, [rendererRef]);

    const onConnectionSelected = (c: QlogConnection): void => {
        update("congestionConfig", { connection: c });
    };

    const notice = model !== undefined ? congestionNotice(model) : undefined;

    return (
        <div className="cg-configurator" style={PANEL_STYLE}>
            <div className="container-fluid">
                <div className="row justify-content-center">
                    <p style={{ marginTop: "10px" }}>
                        Select a trace via the dropdown(s) below to visualize it in the congestion graph
                    </p>
                </div>
                <div className="row justify-content-center">
                    {connection !== undefined ? (
                        <ConnectionConfigurator
                            allGroups={groups}
                            connection={connection}
                            canBeRemoved={false}
                            onConnectionSelected={onConnectionSelected}
                        />
                    ) : null}
                </div>
                <div className="row justify-content-center">
                    <HoverTooltipButton onClick={() => rendererRef.current?.resetZoom()}>Reset zoom</HoverTooltipButton>
                    <HoverTooltipButton
                        title="Click this button, then drag and drop a horizontal time range to zoom in on."
                        onClick={() => rendererRef.current?.useBrushX()}
                    >
                        Zoom timerange
                    </HoverTooltipButton>
                    <HoverTooltipButton
                        title="Click this button, then drag and drop a rectangular area to zoom in on."
                        onClick={() => rendererRef.current?.useBrush2d()}
                    >
                        Zoom area
                    </HoverTooltipButton>
                    <HoverTooltipButton
                        title="Click this button or press R, then drag and drop a line to see the time and byte ranges it spans"
                        onClick={() => rendererRef.current?.useRuler()}
                    >
                        Ruler (press R)
                    </HoverTooltipButton>
                    <HoverTooltipButton onClick={() => rendererRef.current?.toggleCongestionGraph()}>
                        Toggle congestion info
                    </HoverTooltipButton>
                    <HoverTooltipButton onClick={() => rendererRef.current?.toggleZoomingRTTGraph()}>
                        Toggle RTT zooming
                    </HoverTooltipButton>
                </div>

                <NoTraceAlerts />
                {notice !== undefined ? (
                    <div role="alert" className="alert alert-info">
                        {notice}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export { CongestionGraphConfigurator };
