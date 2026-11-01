// Y-coordinate layout (qvis `calculateCoordinates`, SequenceDiagramD3Renderer.ts:786-998;
// parity/sequence-diagram.md §3.6). A k-way merge over the traces in timestamp order, without copying events:
// - events in the same time bucket (1 ms at multiplier 1) stack per trace, 20 px apart, all traces starting at the
//   same base y; the next bucket starts below the tallest stack;
// - gaps of up to 6 buckets are drawn to scale (20 px per bucket), longer ones become 120 px plus an inactivity marker.
// The first event is measured from bucket -1 (SQ16 PRESERVE).

export interface LayoutDimensions {
    marginTop: number;
    marginBottom: number;
    /** height of one time bucket and the stacking step */
    pixelsPerMillisecond: number;
    /** gap cap */
    shortenIntervalsLongerThan: number;
}

export const DEFAULT_DIMENSIONS: Readonly<LayoutDimensions> = Object.freeze({
    marginTop: 60,
    marginBottom: 100,
    pixelsPerMillisecond: 20,
    shortenIntervalsLongerThan: 120,
});

export interface Interval {
    yMin: number;
    yMax: number;
    /** difference in bucket indices (not the exact gap) */
    timeSkipped: number;
}

/** One trace as the layout sees it. */
export interface LayoutTrace {
    /** number of events */
    readonly length: number;
    /** absolute time (ms, comparable across traces) of event `i` */
    absoluteTime(i: number): number;
    /** absolute start time of the trace (ms) */
    readonly absoluteStartTime: number;
    /** latency offset (ms) */
    readonly timeOffset: number;
}

export interface CoordinateResult {
    /** per trace, per event index: the y coordinate (SVG px) */
    y: Float64Array[];
    /** per trace, per event index: the displayed time (ms x timeResolution, relative to `startTime`, incl. offset) */
    time: Float64Array[];
    intervals: Interval[];
    /** SVG height (last y + bottom margin) */
    height: number;
    /** "absoluteAggregatedStartTime": the minimum absolute start time over the traces, x timeResolution */
    startTime: number;
}

/** Timestamp text of an event: `time.toFixed(2)` (qvis stored it as `rawEvent.timeText`, SQ14). */
export function formatTime(time: number): string {
    return "" + time.toFixed(2);
}

export function calculateCoordinates(
    traces: readonly LayoutTrace[],
    timeResolution: number,
    dimensions: LayoutDimensions = DEFAULT_DIMENSIONS,
): CoordinateResult {
    const pixelsPerMillisecond = dimensions.pixelsPerMillisecond;
    const n = traces.length;

    const heads = new Array<number>(n).fill(0); // current index per trace, -1 when done
    const trackerY = new Array<number>(n).fill(0);
    const headTime = new Float64Array(n); // cached time of each trace's head event
    const y: Float64Array[] = [];
    const time: Float64Array[] = [];

    let absoluteAggregatedStartTime = Number.MAX_VALUE;
    let doneCount = 0;
    /** moves the head of trace t to event `i`, or marks the trace done (`heads[t] = -1`) */
    const seek = (t: number, i: number): void => {
        if (i >= traces[t].length) {
            heads[t] = -1;
            ++doneCount;
        } else {
            heads[t] = i;
        }
    };

    for (let t = 0; t < n; ++t) {
        y.push(new Float64Array(traces[t].length).fill(NaN));
        time.push(new Float64Array(traces[t].length).fill(NaN));
        absoluteAggregatedStartTime = Math.min(absoluteAggregatedStartTime, traces[t].absoluteStartTime);
        seek(t, 0);
    }
    absoluteAggregatedStartTime *= timeResolution;

    const headTimeOf = (t: number): number => {
        const tr = traces[t];
        return (
            tr.absoluteTime(heads[t]) * timeResolution - absoluteAggregatedStartTime + tr.timeOffset * timeResolution
        );
    };
    for (let t = 0; t < n; ++t) if (heads[t] !== -1) headTime[t] = headTimeOf(t);

    const intervals: Interval[] = [];
    let maxY = 0;
    let currentTimestampUnderConsideration = -1;
    let currentY = dimensions.marginTop;
    let inOverlapPreventionMode = false;
    let previousMinimumTrace = 0; // only needed for overlap prevention

    while (doneCount < n) {
        let currentMinimumTrace = -1;
        let currentMinimumTime = Number.MAX_VALUE;

        for (let t = 0; t < n; ++t) {
            if (heads[t] === -1) continue;
            // < instead of <= so we favor rendering a single trace as long as possible (overlap prevention)
            if (headTime[t] < currentMinimumTime) {
                currentMinimumTrace = t;
                currentMinimumTime = headTime[t];
            }
        }
        if (currentMinimumTrace === -1) {
            // only non-finite times left (qvis crashed here, SQ26): the render wrapper reports it (SN2)
            throw new Error(
                "SequenceDiagram:calculateCoordinates : event times are not finite numbers, cannot lay out",
            );
        }

        // the overlap is on bucket resolution (1 ms at multiplier 1)
        const currentTimeBucket = Math.floor(currentMinimumTime);

        // 2. prevent overlaps
        if (currentTimeBucket === currentTimestampUnderConsideration) {
            if (!inOverlapPreventionMode) {
                inOverlapPreventionMode = true;
                // the 1st event of this bucket was already placed at currentY: the other traces "undo" the increment
                for (let t = 0; t < n; ++t) {
                    trackerY[t] = t !== previousMinimumTrace ? currentY - pixelsPerMillisecond : currentY;
                }
            }
            trackerY[currentMinimumTrace] += pixelsPerMillisecond;
            currentY = trackerY[currentMinimumTrace];
        } else if (inOverlapPreventionMode) {
            // onto the next bucket: continue below the tallest stack
            inOverlapPreventionMode = false;
            let maxTrackerY = 0;
            for (let t = 0; t < n; ++t) if (trackerY[t] > maxTrackerY) maxTrackerY = trackerY[t];
            currentY = maxTrackerY;
        }

        const timeDifference = currentTimeBucket - currentTimestampUnderConsideration;

        // 1. compress longer stretches of inactivity (after 2., which can override currentY)
        if (timeDifference * pixelsPerMillisecond > dimensions.shortenIntervalsLongerThan) {
            intervals.push({
                yMin: currentY,
                yMax: currentY + dimensions.shortenIntervalsLongerThan,
                timeSkipped: currentTimeBucket - currentTimestampUnderConsideration,
            });
            currentY += dimensions.shortenIntervalsLongerThan;
        } else {
            currentY += timeDifference * pixelsPerMillisecond;
        }

        const index = heads[currentMinimumTrace];
        y[currentMinimumTrace][index] = currentY;
        time[currentMinimumTrace][index] = currentMinimumTime;

        currentTimestampUnderConsideration = currentTimeBucket;
        previousMinimumTrace = currentMinimumTrace;

        seek(currentMinimumTrace, index + 1);
        if (heads[currentMinimumTrace] !== -1) headTime[currentMinimumTrace] = headTimeOf(currentMinimumTrace);

        maxY = currentY;
    }

    return {
        y,
        time,
        intervals,
        height: maxY + dimensions.marginBottom, // breathing room at the bottom
        startTime: absoluteAggregatedStartTime,
    };
}
