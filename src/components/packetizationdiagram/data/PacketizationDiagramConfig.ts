// Port of qvis `components/packetizationdiagram/data/PacketizationDiagramConfig.ts` (parity/packetization-diagram.md
// §2.1). Lives in the configuration store (`packetizationConfig`) and survives route changes.

import type { QlogConnection } from "@/model/QlogConnection";

export default class PacketizationDiagramConfig {
    /** UNUSED (its "Show collapsed" checkbox is commented out in qvis); kept for config-shape parity (Q-C1) */
    public collapsed: boolean = true;
    /** only connections[0] is rendered */
    public connections: QlogConnection[] = [];
}

export { PacketizationDiagramConfig };
