// Port of qvis `components/packetizationdiagram/renderer/PacketizationDiagramModels.ts` (parity/packetization-diagram.md
// §3.4, §3.5). Pure, DOM-free.
//
// Deviations (all FIX per the spec):
// - the two blocking `alert()`s in extractRanges are replaced by a diagnostic plus the `insufficientBytes` flag, which the
//   React wrapper turns into at most one N-PZ3 toast per render (Q-L2);
// - extractRanges refuses non-finite / negative sizes instead of looping forever (qvis looped on `NaN`, converters §3.10);
// - qvis' H3FrameTypeToNumber is replaced by h3FrameTypeNumber (h3Helpers.ts, Q-H4).

export enum PacketizationDirection {
    sending,
    receiving,
}

export interface PacketizationRange {
    /** absolute byte offset on this diagram's x axis */
    start: number;
    /** bytes */
    size: number;

    /** true: full lane height; false: 60% height, bottom-aligned (headers and trailers) */
    isPayload: boolean;
    /** packet_type / frame_type / TLS content_type / H2-H3 frame_type */
    contentType?: string;

    /** the unit's ordinal in its lane (packet #, frame #, record #, H3 frame #); -1 for the filler */
    index: number;
    /** "parent" ordinal for tooltips (often approximate, Q-H5) */
    lowerLayerIndex: number;

    color: string;

    /** QUIC lane: packet event data; frame lane: the frame object; H3/stream lanes: the H3 event data */
    rawPacket?: any;
    /** H3/H2: { frame_length }; TLS: { DEBUG_wiresharkFrameNumber, record_length, payload_length } */
    extra?: any;
}

export interface PacketizationLane {
    /** label next to the lane */
    name: string;
    /** CSS class on the lane's rects (re-selected when zooming) */
    CSSClassName: string;
    /** tooltip HTML (every interpolated value is escaped) */
    rangeToString: (r: PacketizationRange) => string;
    /** 1 by default; 0.6 for the "Stream IDs" lane */
    heightModifier?: number;
    ranges: PacketizationRange[];

    /** QUIC lane 0 only */
    max_size_local?: number | string;
    /** QUIC lane 0 only */
    max_size_remote?: number | string;
    /** QUIC lane 0 only */
    efficiency?: number;
}

export interface LightweightRange {
    start: number;
    size: number;
}

/** What a pre-processor returns: the four lanes plus everything it would have logged (unit tests, D-PZ4, N-PZ3). */
export interface PacketizationResult {
    lanes: PacketizationLane[];
    /** every console diagnostic message (first argument only), in order */
    diagnostics: string[];
    /** extractRanges ran out of lower-layer bytes at least once (N-PZ3) */
    insufficientBytes: boolean;
    /** D-PZ4: centered note when lane 0 is empty (undefined when lane 0 has ranges) */
    emptyNote?: string;
}

export interface PacketizationOptions {
    /** do not write the diagnostics to the console (unit tests) */
    silent?: boolean;
}

/**
 * Collects the qvis console diagnostics. They are written with console.warn (qvis used console.error for most of
 * them; trace inconsistencies are expected input, not application errors) and kept in `messages` for tests.
 */
export class PacketizationDiagnostics {
    readonly messages: string[] = [];
    insufficientBytes = false;
    private readonly silent: boolean;

    constructor(silent = false) {
        this.silent = silent;
    }

    warn(message: string, ...details: unknown[]): void {
        this.messages.push(message);
        if (!this.silent) {
            console.warn(message, ...details);
        }
    }
}

/** QUIC variable-length integer encoded size (RFC 9000 §16). NaN gives 8 (all comparisons are false), as in qvis. */
export function VLIELength(input: number): number {
    if (input <= 63) {
        return 1;
    }
    if (input <= 16383) {
        return 2;
    }
    if (input <= 1073741823) {
        return 4;
    }

    return 8;
}

/**
 * Consumes `size` bytes from the FRONT of the FIFO list `ranges`, splitting the last range if needed. MUTATES `ranges`
 * (shift/unshift) and returns the consumed pieces, which are the same objects: a split range object is shortened in
 * place and its remainder is unshifted back as a new object (PARITY).
 */
export function extractRanges(
    ranges: LightweightRange[],
    size: number,
    diagnostics?: PacketizationDiagnostics,
): LightweightRange[] {
    const output: LightweightRange[] = [];

    let remainingLength = size;

    if (size === 0) {
        diagnostics?.warn("Trying to extract ranges for size 0... potential error? Skipping...");

        return output;
    }

    // FIX: qvis looped forever on NaN (every iteration shifts and unshifts one range)
    if (!Number.isFinite(size) || size < 0) {
        diagnostics?.warn("PacketizationDiagram:extractRanges : invalid size, skipping...", size);
        if (diagnostics) diagnostics.insufficientBytes = true;

        return output;
    }

    while (ranges.length > 0) {
        const range = ranges.shift()!;

        // either we consume the range, or we need to split it
        // the last option should only happen once at maximum, at the very end of this run
        if (range.start + range.size <= range.start + remainingLength) {
            // full range is consumed
            output.push(range);
        } else {
            if (size === 5 && remainingLength < 5) {
                // header is being split... bad for performance
                diagnostics?.warn("Splitting a header range... server is being bad/naive?", size);
            }

            // range needs to be split
            ranges.unshift({ start: range.start + remainingLength, size: range.size - remainingLength });
            range.size = remainingLength; // this struct isn't added back to the "ranges" array, so can safely change it

            output.push(range);
        }

        if (range.size < 0) {
            // sanity check
            diagnostics?.warn(
                "PacketizationDiagram:extractRanges : Negative size after extracting ranges! Should not happen!",
                range.size,
                range,
                ranges,
            );
        }

        remainingLength -= range.size;

        if (remainingLength < 0) {
            // sanity check (qvis: alert)
            diagnostics?.warn("Remaining length < 0, CANNOT HAPPEN! " + remainingLength);
            if (diagnostics) diagnostics.insufficientBytes = true;
            break;
        }

        if (remainingLength === 0) {
            break;
        }
    }

    if (remainingLength !== 0) {
        // qvis: alert
        diagnostics?.warn("Trying to fill payloadranges that aren't there! " + remainingLength);
        if (diagnostics) diagnostics.insufficientBytes = true;
    }

    return output;
}
