// Thin route wrapper (qvis views/*.vue: `<div><XContainer/></div>`, no logic).

import * as ContainerModule from "@/components/multiplexinggraph/MultiplexingGraphContainer";
import { pickComponent } from "./pickComponent";

const MultiplexingGraphContainer = pickComponent(ContainerModule, "MultiplexingGraphContainer");

export default function MultiplexingView() {
    return (
        <div>
            <MultiplexingGraphContainer />
        </div>
    );
}
