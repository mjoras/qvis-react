// Per-TCP-connection state of the tshark converter (port of qvis `TCPConnection`, tcptoqlog.ts:6-18).

import type { QlogOutputEvent } from "../common/envelope";
import type { TLSRecordEventData } from "./schema";

export type Direction = "sending" | "receiving";

export class TcpConnection {
    /** `<client ip>:<port> -> <server ip>:<port>`; finalized with the URL and trailer size */
    title: string;
    readonly events: QlogOutputEvent[] = [];
    /** guessed from the first HTTP/2 :authority header */
    probableUrl: string | undefined;
    /** estimated TLS application-data trailer (AEAD tag, ...) size */
    trailerSize: number | undefined;
    /** application records emitted before the trailer size was known (adjusted retroactively) */
    recordsToAdjust: TLSRecordEventData[] = [];
    /** capture frame number of the packet the trailer size was estimated from */
    trailerEstimatedFromFrame: number | undefined;
    /** number of records adjusted retroactively when the trailer size was estimated */
    trailerAdjustedRecords = 0;

    // sanity totals (qvis DEBUG_HTTPtotalSize / DEBUG_TLSpayloadSize)
    httpTotalSize = 0;
    tlsPayloadSize = 0;
    applicationRecords = 0;
    tlsRecords = 0;
    h2Frames = 0;

    // namespaces used, for event_schemas
    usesTls = false;
    usesHttp2 = false;

    /** per direction: time (ms) and TCP sequence number of the last in-order packet */
    readonly timestampTracker: Record<Direction, { time: number; seq: number }> = {
        sending: { time: -1, seq: -1 },
        receiving: { time: -1, seq: -1 },
    };

    constructor(title: string) {
        this.title = title;
    }
}
