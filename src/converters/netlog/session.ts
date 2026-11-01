// Per-QUIC_SESSION state of the netlog converter (port of qvis `QUICConnection`, netlogtoqlog.ts:132-197).

import type { QlogData, QlogOutputEvent } from "../common/envelope";

export type Frame = Record<string, unknown>;

export interface RxPacket {
    /** the `quic:packet_received` data object (already in `events` when `emitted`) */
    data: { header: Record<string, unknown>; raw?: { length: unknown }; frames?: Frame[]; [k: string]: unknown };
    /** false for a packet created by UNAUTHENTICATED_PACKET_HEADER_RECEIVED without PACKET_RECEIVED (PARITY: never shown) */
    emitted: boolean;
    /** an UNAUTHENTICATED_PACKET_HEADER_RECEIVED already filled the header (T3 splitCoalescedReceived) */
    hasHeader: boolean;
    /** T3 splitCoalescedReceived: datagram id of the PACKET_RECEIVED this packet came from */
    datagramId?: number;
}

export class NetlogSession {
    readonly sourceId: unknown;
    /** `params` of the first event that names the host (normally QUIC_SESSION BEGIN) */
    sessionParams: Record<string, unknown> | undefined;
    /** netlog tick (ms) of the session's first event; event times are relative to it (PARITY) */
    readonly startTick: number;
    readonly events: QlogOutputEvent[] = [];

    /**
     * Frames logged by *_FRAME_SENT before their QUIC_SESSION_PACKET_SENT (Chrome logs frames as they are added to the
     * packet being built, then the packet).
     */
    txFrames: Frame[] = [];
    /**
     * Frames logged after QUIC_SESSION_PACKET_RECEIVED / UNAUTHENTICATED_PACKET_HEADER_RECEIVED; they belong to the
     * current `rxPacket` and are attached when the next packet arrives (or at the end of input, T2).
     */
    rxFrames: Frame[] = [];
    rxPacket: RxPacket | undefined;

    // namespaces and extension fields used, for event_schemas (C13)
    usesQuic = false;
    usesHttp3 = false;
    usesLoglevel = false;
    usesQuicChromium = false;
    usesHttp3Chromium = false;

    // T3 state
    readonly controlStream: { local?: unknown; remote?: unknown } = {};
    /** packet_number (as string) -> packet_type of the latest quic:packet_sent */
    readonly sentPacketTypes = new Map<string, unknown>();
    /** stream id (as string) -> payload_length of the last HTTP3_HEADERS_RECEIVED */
    readonly pendingHeadersLength = new Map<string, unknown>();
    datagramCounter = 0;
    mtuProbePending = false;

    constructor(sourceId: unknown, startTick: number) {
        this.sourceId = sourceId;
        this.startTick = startTick;
    }

    push(time: number, name: string, data: QlogData): void {
        if (name.startsWith("quic:")) this.usesQuic = true;
        else if (name.startsWith("http3:")) this.usesHttp3 = true;
        else if (name.startsWith("loglevel:")) this.usesLoglevel = true;
        this.events.push({ time, name, data });
    }

    pushFrame(eventType: string, frame: Frame): void {
        if (eventType.indexOf("SENT") >= 0) this.txFrames.push(frame);
        else this.rxFrames.push(frame);
    }

    /** Gives the current rx packet its buffered frames (shallow copies, as qvis) and clears the buffer. */
    attachRxFrames(): void {
        if (this.rxPacket !== undefined) this.rxPacket.data.frames = this.rxFrames.map((f) => ({ ...f }));
        this.rxFrames = [];
    }

    /** C7 / T2 title: `<host>-<connection_id>`, `<host>`, or `QUIC session <source id>`. */
    get title(): string {
        const host = this.sessionParams?.host;
        const cid = this.sessionParams?.connection_id;
        if (host === undefined || host === null || host === "") return "QUIC session " + String(this.sourceId);
        if (cid === undefined || cid === null || cid === "") return String(host);
        return `${String(host)}-${String(cid)}`;
    }
}
