// Port of qvis `components/packetizationdiagram/PacketizationDiagramContainer.vue` (parity spec §2.1): the configurator
// panel above the two diagrams. The config lives in the configuration store and survives route changes.

import { useConfigurationStore } from "@/store/configurationStore";
import PacketizationDiagramConfigurator from "./PacketizationDiagramConfigurator";
import PacketizationDiagramRenderer from "./PacketizationDiagramRenderer";

export default function PacketizationDiagramContainer() {
    const config = useConfigurationStore((s) => s.packetizationConfig);

    return (
        <div className="home" id="PacketizationDiagramContainer">
            <PacketizationDiagramConfigurator config={config} />
            <PacketizationDiagramRenderer config={config} />
        </div>
    );
}

export { PacketizationDiagramContainer };
