// Port of qvis `components/multiplexinggraph/data/MultiplexingGraphConfig.ts` (parity/app-shell.md §3.4).
// Initial version owned by the shell package; the multiplexing-graph package may extend it.

import type { QlogConnection } from "@/model/QlogConnection";

export default class MultiplexingGraphConfig {
    public collapsed: boolean = true;
    public showwaterfall: boolean = true;
    public showbyteranges: boolean = true;
    public connections: QlogConnection[] = [];
}

export { MultiplexingGraphConfig };
