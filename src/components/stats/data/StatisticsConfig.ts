// Port of qvis `components/stats/data/StatisticsConfig.ts` (parity/app-shell.md §3.4).
// Initial version owned by the shell package; the statistics package may extend it.

import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";

export default class StatisticsConfig {
    public group: QlogConnectionGroup | undefined = undefined;
}

export { StatisticsConfig };
