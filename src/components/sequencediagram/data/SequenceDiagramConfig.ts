// Port of qvis `components/sequencediagram/data/SequenceDiagramConfig.ts` (parity/app-shell.md §3.4,
// parity/sequence-diagram.md §3.1, §8.2).
//
// qvis keeps the timeOffset next to the connection (not in the event parser) so that it is reactive and does not
// change the time base of the other visualizations.
//
// The config lives in the configuration store and is treated as immutable: every change (user action or the
// renderer's write-back of the mirrored trace / automatic latency offset) produces a new `connections` array with new
// wrapper objects. Model objects (connections) are held by reference.

import type { QlogConnection } from "@/model/QlogConnection";

export interface SequenceDiagramConnection {
    connection: QlogConnection;
    /** ms, added to every timestamp of this trace (positive = later = lower on screen) */
    timeOffset: number;
}

export default class SequenceDiagramConfig {
    /** `{connection, timeOffset: connection.timing.timeOffset}` (qvis: `getEventParser().timeOffset`, always 0). */
    public static createConnectionWithTimeoffset(connection: QlogConnection): SequenceDiagramConnection {
        return { connection, timeOffset: connection.timing ? connection.timing.timeOffset : 0 };
    }

    /** The traces shown, index 0 = leftmost column. */
    public connections: SequenceDiagramConnection[] = [];

    /**
     * "Time multiplier": 1 = ms level, 1000 = us level (the sequence diagram groups per millisecond). Always a finite
     * number > 0: the configurator only writes valid values (SQ25 FIX).
     */
    public timeResolution: number = 1;
}

export { SequenceDiagramConfig };
