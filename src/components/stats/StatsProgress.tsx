// bootstrap-vue 2.0.4 `<b-progress :value :max :precision="2" show-progress>` (parity/statistics.md §2.8): exactly
// the markup qvis produced, styled with the Bootstrap 4.3.1 values (Statistics.css). Own class names instead of
// `.progress` / `.progress-bar`: Bootstrap 5's `.progress-bar { overflow: hidden }` would clip the labels of narrow
// bars, which overflow as white text onto the grey track in qvis.

import { progressLabel } from "./data/computeStatistics";

export interface StatsProgressProps {
    value: number;
    max: number;
}

export default function StatsProgress({ value, max }: StatsProgressProps) {
    // bootstrap-vue writes aria-valuenow with the precision ("18.00"); React types these attributes as numbers
    const aria = { "aria-valuemax": String(max), "aria-valuenow": value.toFixed(2) } as unknown as {
        "aria-valuemax": number;
        "aria-valuenow": number;
    };
    return (
        <div className="stats-progress">
            <div
                role="progressbar"
                aria-valuemin={0}
                {...aria}
                className="stats-progress-bar"
                style={{ width: 100 * (value / max) + "%" }}
            >
                {progressLabel(value, max)}
            </div>
        </div>
    );
}

export { StatsProgress };
