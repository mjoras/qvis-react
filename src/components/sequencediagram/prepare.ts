// Everything the sequence diagram computes before drawing (qvis `setup()` steps 1-2, SequenceDiagramD3Renderer.ts:
// 174-236; parity/sequence-diagram.md §3.3, §8.2): drop traces without events, dedupe + mirror, automatic latency
// offset, y layout, packet matching and the lost-arrow slant. Nothing is written onto the raw events (SQ14): the
// results live in the returned SeqLayout (side tables indexed by trace and event index).

import type { QlogConnection } from "@/model/QlogConnection";
import type { SequenceDiagramConnection } from "./data/SequenceDiagramConfig";
import { calculateCoordinates, type CoordinateResult, type LayoutTrace } from "./layout";
import { calculateConnections, LOST_LEFT, LOST_RIGHT, type MatchResult } from "./matching";
import { dedupeTraces, ensureMoreThanOneTrace } from "./mirror";
import { calculateTimeOffsets } from "./timeAlignment";
import { absoluteStartTime, absoluteTimeShift } from "./timeModel";

export interface SeqLayout extends CoordinateResult, MatchResult {
    /** the rendered traces: after dropping empty ones, dedupe, mirror and the automatic offset ("getTraces()") */
    traces: SequenceDiagramConnection[];
    timeResolution: number;
    /**
     * Per trace, per event: target y of the half arrow of a presumed-lost packet (SQ12 FIX: y + half of the y
     * difference of the most recent earlier arrow of the same trace in that direction; NaN when not lost).
     */
    lostTargetY: Float64Array[];
}

export interface PrepareResult {
    layout: SeqLayout;
    /**
     * true when `layout.traces` differs from the input for another reason than removed duplicates (mirror added,
     * automatic offset, traces without events dropped): the caller writes it back to the configuration. A duplicate
     * alone (e.g. right after "Add trace") stays in the configuration, so the user can pick another trace in that
     * selector; it is just not drawn twice (SQ6).
     */
    tracesChanged: boolean;
}

function layoutTrace(t: SequenceDiagramConnection): LayoutTrace {
    const c = t.connection;
    const events = c.getEvents();
    const shift = absoluteTimeShift(c);
    return {
        length: events.length,
        absoluteTime: (i: number) => events[i].absoluteTime + shift,
        absoluteStartTime: absoluteStartTime(c),
        timeOffset: t.timeOffset,
    };
}

function computeLostTargets(conns: readonly QlogConnection[], y: Float64Array[], match: MatchResult): Float64Array[] {
    const out: Float64Array[] = [];
    for (let t = 0; t < conns.length; ++t) {
        const len = y[t].length;
        const targets = new Float64Array(len).fill(NaN);
        const right = match.right[t];
        const left = match.left[t];
        const lost = match.lost[t];
        let previousYDiffRight = 0;
        let previousYDiffLeft = 0;
        for (let e = 0; e < len; ++e) {
            const r = right[e];
            const l = left[e];
            if (r >= 0) previousYDiffRight = y[t + 1][r] - y[t][e];
            if (l >= 0) previousYDiffLeft = y[t - 1][l] - y[t][e];
            if (r >= 0 || l >= 0) continue;
            if (lost[e] & LOST_RIGHT) targets[e] = y[t][e] + previousYDiffRight / 2;
            else if (lost[e] & LOST_LEFT) targets[e] = y[t][e] + previousYDiffLeft / 2;
        }
        out.push(targets);
    }
    return out;
}

function sameTraces(a: readonly SequenceDiagramConnection[], b: readonly SequenceDiagramConnection[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Returns undefined (after the qvis console diagnostic, as console.warn: parity addendum S6) when none of the selected
 * traces has events.
 */
export function prepareDiagram(
    input: readonly SequenceDiagramConnection[],
    timeResolution: number,
): PrepareResult | undefined {
    // 1. new array: we might add a trace if there's only 1, and drop invalid ones (no events). Events with
    // non-conforming (pre-final) names are drawn like any unknown event (parity addendum S2): generic chips, no arrows.
    const withEvents = input.filter((t) => t.connection.getEvents().length > 0);
    if (withEvents.length === 0) {
        console.warn(
            "SequenceDiagramD3Renderer:setup : None of the selected traces have events in them, cannot render",
        );
        return undefined;
    }

    let traces = ensureMoreThanOneTrace(withEvents);

    // 2. time offsets, coordinates, connections
    const offset = calculateTimeOffsets(traces);
    if (offset !== undefined) {
        traces = traces.map((t, i) => (i === 1 ? { connection: t.connection, timeOffset: offset } : t));
    }

    const coords = calculateCoordinates(traces.map(layoutTrace), timeResolution);
    const conns = traces.map((t) => t.connection);
    const match = calculateConnections(conns);
    const lostTargetY = computeLostTargets(conns, coords.y, match);

    return {
        layout: { ...coords, ...match, traces, timeResolution, lostTargetY },
        tracesChanged: !sameTraces(traces, input) && !sameTraces(traces, dedupeTraces(input)),
    };
}
