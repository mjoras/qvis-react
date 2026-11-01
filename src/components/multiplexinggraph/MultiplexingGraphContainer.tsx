// Port of qvis `components/multiplexinggraph/MultiplexingGraphContainer.vue`: the "Multiplexing" tab
// (`#/multiplexing`; parity/multiplexing-graph.md). Configurator + one panel per selected trace; the config lives in
// the configuration store and survives route changes (not reloads).

import { useConfigurationStore } from "@/store/configurationStore";
import MultiplexingGraphConfigurator from "./MultiplexingGraphConfigurator";
import MultiplexingGraphRenderer from "./MultiplexingGraphRenderer";

export default function MultiplexingGraphContainer() {
    const config = useConfigurationStore((s) => s.multiplexingConfig);

    return (
        // id: app-level tests address every tool page by `#<Tool>Container` (qvis's root only had class "home")
        <div id="MultiplexingGraphContainer" className="home">
            <MultiplexingGraphConfigurator config={config} />
            <MultiplexingGraphRenderer config={config} />
        </div>
    );
}

export { MultiplexingGraphContainer };
