// calculateAckRanges port (qvis netlogtoqlog.ts:93-130) with the T2 guards of converters spec section 8.5.2.
//
// Chrome logs "largest/smallest observed + the missing packet numbers in between"; qlog wants inclusive acked
// ranges. Single-packet ranges are emitted as `[n]` (quic-13 AckFrame: "implementations SHOULD log [120]").

export type AckRangeOut = [number] | [number, number];

export interface AckRangesResult {
    ranges: AckRangeOut[];
    /** `smallest_observed` was absent (old Chrome bug 1112925); qvis threw a TypeError here */
    noSmallest: boolean;
}

export function calculateAckRanges(
    largestObserved: number,
    smallestObserved: number | undefined,
    missingIn: readonly unknown[] | undefined,
): AckRangesResult {
    // Q23: never mutate the input (qvis sorted the event params in place)
    const missing = (missingIn ?? [])
        .map((v) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    const pairs: [number, number][] = [];
    if (missing.length === 0) {
        // no missing packets, everything between smallest and largest is acked
        pairs.push([smallestObserved ?? largestObserved, largestObserved]);
    } else {
        // what if missing_packets' first entry is PN 0? Then smallest is 0 too and the range [0, -1] is dropped below
        if (smallestObserved !== undefined) pairs.push([smallestObserved, missing[0] - 1]);
        // example: largest 20, missing [6,7,8,11], smallest 3 -> [3,5], [9,10], [12,20]
        for (let i = 0; i < missing.length - 1; i++) {
            // consecutive missing packets continue the gap; a jump ends it and the values in between are acked
            if (missing[i + 1] !== missing[i] + 1) pairs.push([missing[i] + 1, missing[i + 1] - 1]);
        }
        pairs.push([missing[missing.length - 1] + 1, largestObserved]);
    }
    // T2: drop inverted ranges (qvis emitted e.g. [3,2] when the first missing number equals smallest_observed)
    const ranges = pairs.filter(([a, b]) => a <= b).map(([a, b]): AckRangeOut => (a === b ? [a] : [a, b]));
    return { ranges, noSmallest: smallestObserved === undefined };
}
