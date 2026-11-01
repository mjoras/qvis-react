// Thin route wrapper (qvis views/*.vue: `<div><XContainer/></div>`, no logic).

import * as ContainerModule from "@/components/congestiongraph/CongestionGraphContainer";
import { pickComponent } from "./pickComponent";

const CongestionGraphContainer = pickComponent(ContainerModule, "CongestionGraphContainer");

export default function CongestionView() {
    return (
        <div>
            <CongestionGraphContainer />
        </div>
    );
}
