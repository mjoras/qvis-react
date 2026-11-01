// Thin route wrapper (qvis views/*.vue: `<div><XContainer/></div>`, no logic).

import * as ContainerModule from "@/components/sequencediagram/SequenceDiagramContainer";
import { pickComponent } from "./pickComponent";

const SequenceDiagramContainer = pickComponent(ContainerModule, "SequenceDiagramContainer");

export default function SequenceView() {
    return (
        <div>
            <SequenceDiagramContainer />
        </div>
    );
}
