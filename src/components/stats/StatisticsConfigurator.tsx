// Port of qvis components/stats/StatisticsConfigurator.vue (parity/statistics.md §2.3, §3.2): yellow panel with the
// intro text, the shared file selector in group-only mode (app-shell §2.5.4 mode A) and the no-file alerts.
// Auto-selection: when no file is selected and at least one is loaded, select the oldest one (groups[0]); qvis did
// this in mounted() and updated(), here in an effect on the store's groups.

import { useEffect } from "react";
import ConnectionConfigurator from "@/components/shared/ConnectionConfigurator";
import NoTraceAlerts from "@/components/shared/NoTraceAlerts";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";

export default function StatisticsConfigurator() {
    const groups = useConnectionStore((s) => s.groups);
    const group = useConfigurationStore((s) => s.statisticsConfig.group);
    const update = useConfigurationStore((s) => s.update);

    useEffect(() => {
        if (group === undefined && groups.length > 0) {
            console.debug("selectDefault: adding new default connection configurator", groups);
            update("statisticsConfig", { group: groups[0] });
        }
    }, [group, groups, update]);

    const onGroupSelected = (selected: QlogConnectionGroup): void => {
        console.debug("StatisticsConfigurator:onGroupSelected : ", selected);
        update("statisticsConfig", { group: selected });
    };

    return (
        <div className="stats-configurator">
            <div className="container-fluid">
                <div className="row justify-content-center">
                    <p style={{ marginTop: "10px" }}>Select a file via the dropdown(s) below to view its statistics</p>
                </div>
                <div className="row justify-content-center">
                    {group !== undefined ? (
                        <ConnectionConfigurator
                            allGroups={groups}
                            group={group}
                            canBeRemoved={false}
                            allowGroupSelection={true}
                            allowConnectionSelection={false}
                            onGroupSelected={onGroupSelected}
                        />
                    ) : null}
                </div>

                <NoTraceAlerts />
            </div>
        </div>
    );
}

export { StatisticsConfigurator };
