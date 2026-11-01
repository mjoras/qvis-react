// Port of qvis `components/congestiongraph/data/CongestionGraphConfig.ts` (parity/app-shell.md §3.4,
// parity/congestion-graph.md §5): the selected trace, kept in the configuration store across route changes.
//
// qvis also had an uninitialised `renderer` field used by the configurator (resetZoom etc.). In the React port the
// renderer handle lives in a ref of CongestionGraphContainer (never in the store, congestion-graph.md §8.2). Zoom,
// interaction mode and the two toggles are renderer state: they reset when the view remounts (PARITY §3.1).

import type { QlogConnection } from "@/model/QlogConnection";

export default class CongestionGraphConfig {
    public connection: QlogConnection | undefined = undefined;
}

export { CongestionGraphConfig };
