// Port of qvis `components/multiplexinggraph/MultiplexingGraphConfigurator.vue` (parity/multiplexing-graph.md §2.2,
// §2.3, §3.1, §3.8): trace picker, the two checkboxes, the optional "Load all connections at once" button and the
// shared no-file alerts. Auto-selects the first available trace (Q12 FIX: skips files without traces).

import { useEffect, useState } from "react";
import ConnectionConfigurator from "@/components/shared/ConnectionConfigurator";
import NoTraceAlerts from "@/components/shared/NoTraceAlerts";
import { firstAvailableConnection } from "@/lib/selection";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import type MultiplexingGraphConfig from "./data/MultiplexingGraphConfig";
import { allConnectionsSortedByFilename, allowSelectAllFor } from "./multiplexingSelection";
import "./MultiplexingGraph.css";

export interface MultiplexingGraphConfiguratorProps {
    config: MultiplexingGraphConfig;
}

export default function MultiplexingGraphConfigurator({ config }: MultiplexingGraphConfiguratorProps) {
    const groups = useConnectionStore((s) => s.groups);
    const update = useConfigurationStore((s) => s.update);

    // a class getter in qvis: cached for the lifetime of the configurator instance
    const [allowSelectAll] = useState(() => allowSelectAllFor(window.location.toString()));

    // qvis mounted() + updated(): select a default trace when there is none
    const noSelection = config.connections.length === 0;
    useEffect(() => {
        if (noSelection && groups.length > 0) {
            const first = firstAvailableConnection(groups);
            if (first !== undefined) {
                update("multiplexingConfig", { connections: [first] });
            }
        }
    }, [noSelection, groups, update]);

    const onConnectionSelected = (connection: QlogConnection): void => {
        update("multiplexingConfig", { connections: [connection] });
    };

    const selectAllConnections = (): void => {
        update("multiplexingConfig", {
            showwaterfall: true,
            showbyteranges: false,
            connections: allConnectionsSortedByFilename(useConnectionStore.getState().groups),
        });
    };

    return (
        <div className="mux-configurator" style={{ backgroundColor: "#d1ecf1", padding: "0px 10px" }}>
            <div className="container-fluid">
                <div className="row justify-content-center">
                    <p style={{ marginTop: "10px" }}>
                        Select a trace via the dropdown(s) below to visualize it in the stream graph
                    </p>
                </div>
                <div className="row justify-content-center">
                    {config.connections.length > 0 ? (
                        <ConnectionConfigurator
                            allGroups={groups}
                            connection={config.connections[0]}
                            canBeRemoved={false}
                            onConnectionSelected={onConnectionSelected}
                        />
                    ) : null}
                </div>

                <div className="row justify-content-center">
                    <div className="custom-control custom-checkbox me-3">
                        <input
                            id="waterfall-checkbox"
                            name="waterfall-checkbox"
                            type="checkbox"
                            autoComplete="off"
                            className="custom-control-input"
                            value="true"
                            checked={config.showwaterfall}
                            onChange={(e) => update("multiplexingConfig", { showwaterfall: e.target.checked })}
                        />
                        <label htmlFor="waterfall-checkbox" className="custom-control-label">
                            Show waterfall
                        </label>
                    </div>

                    <div className="custom-control custom-checkbox">
                        <input
                            id="byteranges-checkbox"
                            name="byteranges-checkbox"
                            type="checkbox"
                            autoComplete="off"
                            className="custom-control-input"
                            value="true"
                            checked={config.showbyteranges}
                            onChange={(e) => update("multiplexingConfig", { showbyteranges: e.target.checked })}
                        />
                        <label htmlFor="byteranges-checkbox" className="custom-control-label">
                            Show byte ranges
                        </label>
                    </div>

                    {allowSelectAll ? (
                        <button
                            type="button"
                            className="btn ms-3 btn-primary"
                            onClick={selectAllConnections}
                            disabled={config.connections.length === 0}
                        >
                            Load all connections at once
                        </button>
                    ) : null}
                </div>

                <NoTraceAlerts />
            </div>
        </div>
    );
}

export { MultiplexingGraphConfigurator };
