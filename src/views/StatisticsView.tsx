// Thin route wrapper (qvis views/*.vue: `<div><XContainer/></div>`, no logic).

import * as ContainerModule from "@/components/stats/StatisticsContainer";
import { pickComponent } from "./pickComponent";

const StatisticsContainer = pickComponent(ContainerModule, "StatisticsContainer");

export default function StatisticsView() {
    return (
        <div>
            <StatisticsContainer />
        </div>
    );
}
