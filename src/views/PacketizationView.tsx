// Thin route wrapper (qvis views/*.vue: `<div><XContainer/></div>`, no logic).

import * as ContainerModule from "@/components/packetizationdiagram/PacketizationDiagramContainer";
import { pickComponent } from "./pickComponent";

const PacketizationDiagramContainer = pickComponent(ContainerModule, "PacketizationDiagramContainer");

export default function PacketizationView() {
    return (
        <div>
            <PacketizationDiagramContainer />
        </div>
    );
}
