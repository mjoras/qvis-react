// Port of qvis components/stats/StatisticsContainer.vue (parity/statistics.md §2.2, §3.1): configurator + renderer.
// The selected file lives in configurationStore.statisticsConfig (global, survives route changes); both children
// read it from the store. No D3 on this page: everything is declarative JSX over the cached getTraceStats() result.

import StatisticsConfigurator from "./StatisticsConfigurator";
import StatisticsRenderer from "./StatisticsRenderer";
import "./Statistics.css";

export default function StatisticsContainer() {
    return (
        <div className="home" id="StatisticsContainer">
            <StatisticsConfigurator />
            <StatisticsRenderer />
        </div>
    );
}

export { StatisticsContainer };
