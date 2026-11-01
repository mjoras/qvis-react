// QUIC frame and packet sizing for the packetization diagram (parity/packetization-diagram.md §3.6.3-§3.6.5, §9.3,
// §9.4). Port of qvis `PacketizationQUICPreProcessor.backfillFrameSizes` WITHOUT mutating the events (Q-F1): every
// computed size goes into a side array of SizedFrame entries.
//
// qvis read draft-02 `frame.frame_size` (total wire size) and `frame.length` (data length of STREAM/CRYPTO, token length
// of NEW_TOKEN, CID length of NEW_CONNECTION_ID). quic-events-13 has neither; frameDataLength / frameWireLength map the
// latest-draft fields onto those two notions.

import { u64 } from "./h3Helpers";
import { VLIELength, type PacketizationDiagnostics } from "./PacketizationDiagramModels";

/** Exact qvis text of the injected filler "frame" (tooltip "Frame type : ..."). */
export const FILLER_FRAME_TYPE = "qvis-injected FILLER (deal with incorrectly guesstimated frame size)";

/** One entry per drawn frame (or the filler) of one packet. */
export interface SizedFrame {
    /** the frame object as logged (never mutated); a synthetic `{frame_type: FILLER_FRAME_TYPE}` for the filler */
    frame: any;
    /** frame_type, `"unknown"` when absent (Q-F5) */
    frameType: string;
    isFiller: boolean;
    /** total wire size (draft-02 `frame_size`); undefined for the filler */
    frame_size: number | undefined;
    header_size: number;
    payload_size: number;
    /** frame_size came from dataFrameHeaderLength (computed STREAM/CRYPTO/DATAGRAM header, §9.4.3) */
    headerComputed: boolean;
}

export interface SizeFramesResult {
    sized: SizedFrame[];
    /** bytes of the packet payload not accounted for (the filler's header_size when !== 0) */
    offset: number;
    mode: "explicit" | "guesstimate";
}

/** Mutable per-process() state (qvis' static `frameSizeErrorShown`). */
export interface FrameSizingState {
    frameSizeErrorShown: boolean;
}

const DATA_FRAMES = new Set(["stream", "crypto", "datagram"]);

/** main-schema-14 §11.4: a hexstring without a companion length is the complete value. */
export function hexByteLength(h: unknown): number | undefined {
    return typeof h === "string" ? Math.floor(h.replace(/^0x/i, "").length / 2) : undefined;
}

function frameTypeOf(f: any): string {
    return f && typeof f.frame_type === "string" ? f.frame_type : "unknown";
}

/** Replaces draft-02 `frame.length`: the bytes drawn as the frame's payload (undefined: header-only frame). */
export function frameDataLength(f: any): number | undefined {
    if (!f || typeof f !== "object") return undefined;
    switch (f.frame_type) {
        case "stream":
        case "crypto":
        case "datagram":
            // quic-events-13: the Length field (data length) in raw.length; quiche: raw.payload_length. The legacy
            // top-level `length` (pre-final quic-go) is NOT read (spec addendum P2 / _gaps.md G11: -13 members only)
            return u64(f.raw?.payload_length) ?? u64(f.raw?.length);
        case "new_token":
            // draft-02 `length` was the token length
            return u64(f.token?.raw?.length) ?? hexByteLength(f.token?.raw?.data);
        case "new_connection_id":
            // draft-02 `length` was the CID length
            return u64(f.connection_id_length) ?? hexByteLength(f.connection_id);
        default:
            return undefined; // header-only (PADDING too, PARITY with draft-02)
    }
}

/** RFC 9000 §19.6/§19.8, RFC 9221 §4, assuming minimal varints and the Length field present (LEN bit set). */
export function dataFrameHeaderLength(f: any, len: number): number {
    switch (f.frame_type) {
        case "stream": {
            const off = u64(f.offset) ?? 0;
            return 1 + VLIELength(u64(f.stream_id) ?? 0) + (off > 0 ? VLIELength(off) : 0) + VLIELength(len);
        }
        case "crypto":
            return 1 + VLIELength(u64(f.offset) ?? 0) + VLIELength(len);
        case "datagram":
            return 1 + VLIELength(len);
    }
    return 1;
}

/** Total wire size with its origin; undefined when unknown. */
function frameWireInfo(f: any): { size: number; computed: boolean } | undefined {
    if (!f || typeof f !== "object") return undefined;
    const rawLen = u64(f.raw?.length);
    const rawPl = u64(f.raw?.payload_length);
    if (f.frame_type === "padding") {
        const v = rawPl ?? rawLen;
        return v === undefined ? undefined : { size: v, computed: false };
    }
    if (DATA_FRAMES.has(f.frame_type)) {
        if (rawLen !== undefined && rawPl !== undefined && rawLen > rawPl) {
            // producer used main-schema "full entity" semantics
            return { size: rawLen, computed: false };
        }
        const len = frameDataLength(f);
        if (len === undefined) return undefined;
        return { size: dataFrameHeaderLength(f, len) + len, computed: true };
    }
    // every other type (incl. new_token, new_connection_id): main-schema "full entity" length
    return rawLen === undefined ? undefined : { size: rawLen, computed: false };
}

/** Replaces draft-02 `frame.frame_size` (total wire size); undefined when unknown. */
export function frameWireLength(f: any): number | undefined {
    return frameWireInfo(f)?.size;
}

/**
 * QUIC packet header / payload / trailer split (§3.6.3 Q-P1, Q-P3, §8.5 splitPacket, §9.3.1).
 * `pl` is `raw.payload_length` (truthy test, as qvis). `trailer` is 0 only for an explicitly sized version_negotiation.
 */
export function splitPacket(
    total: number,
    pl: number | undefined,
    packetType: string | undefined,
    onTagIncluded?: () => void,
): { header: number; payload: number; trailer: number } {
    const TAG = 16; // default authentication tag size is 16 bytes // TODO: support GCM8?
    if (pl) {
        if (packetType === "version_negotiation") {
            // no AEAD tag and no tail on the wire: omit the trailer (§9.3.1)
            return { header: total - pl, payload: pl, trailer: 0 };
        }
        let payload = pl;
        let header = total - pl - TAG;
        if (header < 1) {
            // impossible for a real QUIC packet: the producer logged payload_length including the tag
            payload = pl - TAG;
            header = total - pl;
            onTagIncluded?.();
        }
        return { header, payload, trailer: TAG };
    }
    // not set/known explicitly (PARITY: same for every packet type, "TODO: actually calculate")
    const header = Math.min(4, total);
    return { header, payload: total - header - TAG, trailer: TAG };
}

/**
 * Port of qvis backfillFrameSizes (§3.6.4) into a side array, with the Q-F2..Q-F5 fixes and the §9.4.3 LEN-bit
 * inference. `frames` must be non-empty (Q-F5: the caller skips empty frame lists).
 */
export function sizeFrames(
    payloadLength: number,
    frames: readonly unknown[],
    diagnostics: PacketizationDiagnostics,
    state: FrameSizingState,
): SizeFramesResult {
    const sized: SizedFrame[] = frames.map((raw) => {
        const frame = raw && typeof raw === "object" ? raw : {};
        return {
            frame,
            frameType: frameTypeOf(frame),
            isFiller: false,
            frame_size: undefined,
            header_size: 0,
            payload_size: 0,
            headerComputed: false,
        };
    });

    let offset = 0;
    let mode: "explicit" | "guesstimate";

    // Q-F2 fix: explicit mode only when EVERY frame has a known size (qvis looked at frames[0] only)
    const wire = sized.map((s) => frameWireInfo(s.frame));
    if (sized.length > 0 && wire.every((w) => w !== undefined)) {
        mode = "explicit";
        let totalFrameLength = 0;
        sized.forEach((s, i) => {
            s.frame_size = wire[i]!.size;
            s.headerComputed = wire[i]!.computed;
            totalFrameLength += s.frame_size;
        });

        offset += payloadLength - totalFrameLength;
    } else {
        mode = "guesstimate";
        if (!state.frameSizeErrorShown) {
            diagnostics.warn(
                "PacketizationQUICPreProcessor: qlog trace does not have frame_size fields set properly. We -guesstimate- them here, so exact frame sizes are expected to be off!",
            );
            state.frameSizeErrorShown = true;
        }

        let simulatedPayloadLength = 0;
        const fakeFrameHeaderSize = 1; // pretend all (STREAM) frames have a header of size 1 (totally wrong, but ok for now)

        // we don't know the actual size of the frames, so we start with the ones that we do know (STREAM) and then
        // distribute the leftover size over the rest
        const streamWithLength = new Set<SizedFrame>();
        let otherFrameCount = 0;
        for (const s of sized) {
            if (s.frameType === "stream") {
                const len = frameDataLength(s.frame);
                if (len !== undefined) {
                    s.frame_size = fakeFrameHeaderSize + len; // TODO: consider re-transmissions/overlapping data/etc. with .offset
                    simulatedPayloadLength += s.frame_size;
                    streamWithLength.add(s);
                } else {
                    // Q-F4 fix: treated like a non-STREAM frame below (gets a share, header-only)
                    diagnostics.warn(
                        "PacketizationQUICPreProcessor: stream frame with no length attribute! skipping...",
                        s.frame,
                    );
                }
            }
            if (s.frameType === "max_streams") {
                // did strange things to googlevideo endpoint, so hack something that looks more plausible here
                s.frame_size = fakeFrameHeaderSize + 4;
            } else {
                otherFrameCount++; // QUIRK (Q-F6, PRESERVE): also counts STREAM frames
            }
        }

        const leftoverLength = payloadLength - simulatedPayloadLength;
        let lengthPerOtherFrame: number;
        if (leftoverLength < 0) {
            // Q-F3 fix: qvis returned 0 here before the header/payload split (NaN layout, lost STREAM bytes)
            diagnostics.warn(
                "PacketizationQUICPreProcessor: something went wrong calculating frame sizes!",
                payloadLength,
                simulatedPayloadLength,
                frames,
            );
            lengthPerOtherFrame = 0;
        } else {
            // otherFrameCount 0 (only MAX_STREAMS frames) gave Infinity/NaN in qvis; 0 keeps the layout finite
            lengthPerOtherFrame = otherFrameCount > 0 ? Math.floor(leftoverLength / otherFrameCount) : 0;
        }

        for (const s of sized) {
            if (!streamWithLength.has(s)) {
                // max_streams frames are overwritten here too (Q-F6)
                s.frame_size = lengthPerOtherFrame;
                simulatedPayloadLength += s.frame_size;
            }
        }

        if (leftoverLength >= 0 && payloadLength - simulatedPayloadLength < 0) {
            diagnostics.warn(
                "PacketizationQUICPreProcessor: payload is longer than payload! Shouldn't happen!",
                payloadLength,
                simulatedPayloadLength,
                lengthPerOtherFrame,
                frames,
            );
        }

        offset += payloadLength - simulatedPayloadLength; // rounding errors potentially from the Math.floor
    }

    // header_size and payload_size aren't in qlog, but we calculate them here for ease of use (both modes)
    for (const s of sized) {
        const len = frameDataLength(s.frame);
        if (len) {
            s.header_size = s.frame_size! - len; // can be NEGATIVE in guesstimate mode (e.g. CRYPTO), Q-F8
            s.payload_size = len;
        } else {
            s.header_size = s.frame_size!;
            s.payload_size = 0;
        }
    }

    // §9.4.3: the last STREAM/DATAGRAM frame of a packet may omit its Length field (LEN bit 0)
    if (mode === "explicit" && offset < 0 && sized.length > 0) {
        const last = sized[sized.length - 1];
        if (
            last.headerComputed &&
            (last.frameType === "stream" || last.frameType === "datagram") &&
            -offset === VLIELength(last.payload_size)
        ) {
            last.header_size -= -offset; // the frame had no Length field
            last.frame_size! -= -offset;
            offset = 0;
        }
    }

    if (mode === "explicit" && offset !== 0) {
        diagnostics.warn("PacketizationQUICPreProcessor: frame_sizes don't fill the entire packet payload!", offset);
    }

    return { sized, offset, mode };
}

/** The filler entry injected (first) when `offset !== 0` (§3.6.4; Q-F7 PRESERVE: always at the payload start). */
export function makeFiller(offset: number): SizedFrame {
    return {
        frame: { frame_type: FILLER_FRAME_TYPE },
        frameType: FILLER_FRAME_TYPE,
        isFiller: true,
        frame_size: undefined,
        header_size: offset,
        payload_size: 0,
        headerComputed: false,
    };
}
