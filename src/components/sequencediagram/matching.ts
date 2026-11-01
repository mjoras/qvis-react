// Packet matching: arrows and loss (qvis `calculateConnections`, SequenceDiagramD3Renderer.ts:1000-1132;
// parity/sequence-diagram.md §3.7, SQ9, SQ12).
//
// Two passes: "right" (trace t to t+1) and "left" (t to t-1). The SQ9 FIX decides which event type carries the
// packets of each direction from the traces' effective perspectives; it is identical to qvis for every 2-trace pair
// with different perspectives (client|server, the mirror pairs, network flows). Matches use the key
// (header.packet_type, String(header.packet_number)) inside a window of +-10 % (clamped to [200, 1000]) of the end
// events around the last match, first match in index order. A start event without counterpart is presumed lost.

import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogEvent } from "@/model/QlogEvent";

export type Perspective = "client" | "server";

/** Per-trace, per-event (index in `connection.getEvents()`) results. -1 = none. */
export interface MatchResult {
    /** index of the matching event in trace t+1 */
    right: Int32Array[];
    /** index of the matching event in trace t-1 */
    left: Int32Array[];
    /** bit 1: presumed lost to the right; bit 2: presumed lost to the left */
    lost: Uint8Array[];
}

export const LOST_RIGHT = 1;
export const LOST_LEFT = 2;

const opposite = (p: Perspective): Perspective => (p === "client" ? "server" : "client");

/** SQ9 (1): `type` for client and server; `flow` for network when it is client or server; else unknown. */
export function effectivePerspective(conn: QlogConnection): Perspective | undefined {
    const { type, flow } = conn.vantagePoint;
    if (type === "client" || type === "server") return type as Perspective;
    if (type === "network" && (flow === "client" || flow === "server")) return flow as Perspective;
    return undefined;
}

/** SQ9 (2) + (3): the role (who sends the packets logged as packet_sent) of every trace. */
export function traceRoles(conns: readonly QlogConnection[]): { left: Perspective; roles: Perspective[] } {
    const n = conns.length;
    const first = n > 0 ? effectivePerspective(conns[0]) : undefined;
    const last = n > 0 ? effectivePerspective(conns[n - 1]) : undefined;
    const L: Perspective = first ?? (last !== undefined ? opposite(last) : "client");
    const R = opposite(L);
    const roles = conns.map((c, i) => effectivePerspective(c) ?? (i < n - 1 ? L : R));
    return { left: L, roles };
}

/** qvis `connectTraces` perspective: `vantagePoint.type`, or `flow` for network traces (console messages only). */
function loggedPerspective(conn: QlogConnection): string {
    const vp = conn.vantagePoint;
    return "" + (vp.type === "network" ? vp.flow : vp.type);
}

function packetEvents(conn: QlogConnection, type: "packet_sent" | "packet_received"): readonly QlogEvent[] {
    return conn.lookup(conn.transportNamespace, type);
}

function headerOf(ev: QlogEvent): Record<string, any> | undefined {
    const h = ev.data ? ev.data.header : undefined;
    return typeof h === "object" && h !== null ? h : undefined;
}

/**
 * Windowed search (`connectEventLists`). Writes the index of the matching end event into `targets` (indexed by the
 * start event's index) or sets `lostBit` in `lost`.
 */
export function connectEventLists(
    startEvents: readonly QlogEvent[],
    endEvents: readonly QlogEvent[],
    targets: Int32Array,
    lost: Uint8Array,
    lostBit: number,
): void {
    let lastFoundTargetIndex = 0;
    // 10% each way, minimum of 200 events, max of 1000
    const endEventsFraction = Math.min(1000, Math.max(200, Math.round(endEvents.length / 10)));

    for (const ev of startEvents) {
        const header = headerOf(ev);
        if (header === undefined) {
            console.warn(
                "SequenceDiagram:calculateConnections : event data does not have the header field, which is required",
                ev.data,
            );
            continue;
        }
        if (header.packet_number === undefined) {
            if (
                header.packet_type !== "version_negotiation" &&
                header.packet_type !== "retry" &&
                header.packet_type !== "stateless_reset"
            ) {
                console.warn(
                    "SequenceDiagram:calculateConnections : event data does not have the header.packet_number field, which is required",
                    ev.data,
                );
            }
            continue; // no arrow, no side label (SQ31)
        }

        const pt = header.packet_type;
        const pn = "" + header.packet_number;
        const startCandidateIndex = Math.max(0, lastFoundTargetIndex - endEventsFraction);
        const endCandidateIndex = Math.min(endEvents.length - 1, lastFoundTargetIndex + endEventsFraction);

        let counterpartFound = false;
        for (let c = startCandidateIndex; c <= endCandidateIndex; ++c) {
            const candidate = headerOf(endEvents[c]);
            // packet_type separates the packet number spaces
            if (candidate && candidate.packet_type === pt && "" + candidate.packet_number === pn) {
                targets[ev.index] = endEvents[c].index;
                lastFoundTargetIndex = c;
                counterpartFound = true;
                break;
            }
        }
        if (!counterpartFound) lost[ev.index] |= lostBit; // the packet is presumed lost
    }
}

/** `calculateConnections` with the SQ9 rule: per-direction targets, never clearing the other direction. */
export function calculateConnections(conns: readonly QlogConnection[]): MatchResult {
    const n = conns.length;
    const right: Int32Array[] = [];
    const left: Int32Array[] = [];
    const lost: Uint8Array[] = [];
    for (const c of conns) {
        const len = c.getEvents().length;
        right.push(new Int32Array(len).fill(-1));
        left.push(new Int32Array(len).fill(-1));
        lost.push(new Uint8Array(len));
    }

    const { left: L, roles } = traceRoles(conns);
    const R = opposite(L);

    const connectTraces = (dir: "right" | "left", s: number, e: number): void => {
        const sender = dir === "right" ? L : R; // packets flowing in this direction are sent by L (right) or R (left)
        const startType = roles[s] === sender ? "packet_sent" : "packet_received";
        const endType = roles[e] === sender ? "packet_sent" : "packet_received";
        const start = conns[s];
        const end = conns[e];
        const startEvents = packetEvents(start, startType);
        const endEvents = packetEvents(end, endType);

        // the messages name the perspective as qvis did: vantage point type, or the flow for network traces
        if (startEvents.length === 0) {
            console.warn(
                "SequenceDiagram:calculateConnections : trace " +
                    start.parent.filename +
                    ":" +
                    loggedPerspective(start) +
                    " did not have " +
                    startType +
                    " events, which are needed",
            );
        }
        if (endEvents.length === 0) {
            console.warn(
                "SequenceDiagram:calculateConnections : trace " +
                    end.parent.filename +
                    ":" +
                    loggedPerspective(end) +
                    " did not have " +
                    endType +
                    " events, which are needed",
            );
        }

        if (dir === "right") connectEventLists(startEvents, endEvents, right[s], lost[s], LOST_RIGHT);
        else connectEventLists(startEvents, endEvents, left[s], lost[s], LOST_LEFT);
    };

    // packets flowing from client to server (left to right)
    for (let t = 0; t < n - 1; ++t) connectTraces("right", t, t + 1);
    // packets flowing from server to client (right to left)
    for (let t = n - 1; t > 0; --t) connectTraces("left", t, t - 1);

    return { right, left, lost };
}
