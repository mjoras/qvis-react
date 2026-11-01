// Port of qvis `components/packetizationdiagram/PacketizationDiagramConfigurator.vue` (parity spec §2.2, §2.3).
//
// Intro row, the shared trace selector (no latency input, no remove button), the "More info on this tool" button, the
// shared no-trace alerts and the info modal. Auto-selection (app-shell §2.5.7, Q12 fix): with no selection and at least
// one loaded file, select the first trace of the first file that has one. The commented-out "Show collapsed" /
// "Load all connections at once" controls of qvis are not ported (dead code, Q-C1).

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import ConnectionConfigurator from "@/components/shared/ConnectionConfigurator";
import NoTraceAlerts from "@/components/shared/NoTraceAlerts";
import { firstAvailableConnection } from "@/lib/selection";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import type PacketizationDiagramConfig from "./data/PacketizationDiagramConfig";
import PacketizationInfoModal from "./PacketizationInfoModal";
import "./PacketizationDiagram.css";

// panel colour and padding on an outer div, so the container-fluid keeps its gutter padding (ARCHITECTURE §4)
const PANEL_STYLE: CSSProperties = { backgroundColor: "#f8d7da", padding: "0px 10px" };
const INTRO_STYLE: CSSProperties = { marginTop: "10px" };
const INFO_BUTTON_STYLE: CSSProperties = { width: "25%" };

export interface PacketizationDiagramConfiguratorProps {
    config: PacketizationDiagramConfig;
}

export default function PacketizationDiagramConfigurator({ config }: PacketizationDiagramConfiguratorProps) {
    const groups = useConnectionStore((s) => s.groups);
    const update = useConfigurationStore((s) => s.update);
    const [infoShown, setInfoShown] = useState(false);

    const hasSelection = config.connections.length > 0;

    // qvis mounted() + updated(): select a default when files exist and nothing is selected
    useEffect(() => {
        if (!hasSelection && groups.length > 0) {
            const first = firstAvailableConnection(groups);
            if (first !== undefined) {
                update("packetizationConfig", { connections: [first] });
            }
        }
    }, [hasSelection, groups, update]);

    const onConnectionSelected = useCallback(
        (connection: QlogConnection) => {
            update("packetizationConfig", { connections: [connection] });
        },
        [update],
    );

    return (
        <div className="packetization-configurator" style={PANEL_STYLE}>
            <div className="container-fluid">
                <div className="row justify-content-center">
                    <p style={INTRO_STYLE}>
                        Select a trace via the dropdown(s) below to visualize it in the packetization diagram
                    </p>
                </div>
                <div className="row justify-content-center">
                    {hasSelection ? (
                        <ConnectionConfigurator
                            allGroups={groups}
                            connection={config.connections[0]}
                            canBeRemoved={false}
                            onConnectionSelected={onConnectionSelected}
                        />
                    ) : null}
                </div>

                <div className="row justify-content-center">
                    <div className="col-8 text-center">
                        <div className="text-center">
                            <button
                                type="button"
                                className="btn btn-secondary btn-block m-auto packetization-info-button"
                                style={INFO_BUTTON_STYLE}
                                onClick={() => setInfoShown(true)}
                            >
                                More info on this tool
                            </button>
                        </div>
                    </div>
                </div>

                <NoTraceAlerts />

                <PacketizationInfoModal show={infoShown} onHide={() => setInfoShown(false)} />
            </div>
        </div>
    );
}

export { PacketizationDiagramConfigurator };
