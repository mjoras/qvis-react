import { PacketizationDiagnostics } from "./PacketizationDiagramModels";
import {
    FILLER_FRAME_TYPE,
    frameDataLength,
    frameWireLength,
    makeFiller,
    sizeFrames,
    splitPacket,
    type FrameSizingState,
} from "./quicFrameSizes";

const GUESS_MSG =
    "PacketizationQUICPreProcessor: qlog trace does not have frame_size fields set properly. We -guesstimate- them here, so exact frame sizes are expected to be off!";

function size(payloadLength: number, frames: unknown[], state: FrameSizingState = { frameSizeErrorShown: false }) {
    const diagnostics = new PacketizationDiagnostics(true);
    const before = JSON.stringify(frames);
    const result = sizeFrames(payloadLength, frames, diagnostics, state);
    expect(JSON.stringify(frames)).toBe(before); // Q-F1: never mutates the frames
    return { ...result, diagnostics: diagnostics.messages };
}

const brief = (r: ReturnType<typeof size>) =>
    r.sized.map((s) => [s.frameType, s.frame_size, s.header_size, s.payload_size] as const);

describe("frameDataLength / frameWireLength (§3.6.5, §9.4)", () => {
    it.each([
        ["-13 / mvfst raw.length", { frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 50 } }],
        ["quiche raw.payload_length", { frame_type: "stream", stream_id: 0, offset: 0, raw: { payload_length: 50 } }],
        [
            "main-schema semantics",
            { frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 53, payload_length: 50 } },
        ],
    ])("STREAM data length from %s", (_label, frame) => {
        expect(frameDataLength(frame)).toBe(50);
        expect(frameWireLength(frame)).toBe(53); // 1 + VLIE(0) + VLIE(50) + 50, or raw.length when > payload_length
    });

    it("the legacy top-level `length` (pre-final quic-go) is not read (addendum P2, _gaps G11)", () => {
        for (const frame_type of ["stream", "crypto", "datagram"]) {
            const frame = { frame_type, stream_id: 0, offset: 0, length: 50 };
            expect(frameDataLength(frame)).toBeUndefined();
            expect(frameWireLength(frame)).toBeUndefined();
        }
    });

    it("computed headers: offset > 0 adds the offset varint; CRYPTO always has its offset; DATAGRAM type + length", () => {
        expect(frameWireLength({ frame_type: "stream", stream_id: 4, offset: 1000, raw: { length: 1200 } })).toBe(
            1 + 1 + 2 + 2 + 1200,
        );
        expect(frameWireLength({ frame_type: "stream", stream_id: "4", offset: "0", raw: { length: "10" } })).toBe(13);
        expect(frameWireLength({ frame_type: "crypto", offset: 0, raw: { length: 64 } })).toBe(1 + 1 + 2 + 64);
        expect(frameWireLength({ frame_type: "datagram", raw: { length: 30 } })).toBe(1 + 1 + 30);
    });

    it("other frames: raw.length is the full size; PADDING: raw.payload_length", () => {
        expect(frameWireLength({ frame_type: "ack", raw: { length: 7 } })).toBe(7);
        expect(frameWireLength({ frame_type: "ack" })).toBeUndefined();
        expect(frameWireLength({ frame_type: "padding", raw: { length: 900, payload_length: 907 } })).toBe(907);
        expect(frameWireLength({ frame_type: "padding", raw: { length: 907 } })).toBe(907);
        expect(frameDataLength({ frame_type: "padding", raw: { payload_length: 907 } })).toBeUndefined();
    });

    it("NEW_CONNECTION_ID / NEW_TOKEN payloads (§9.13 #4)", () => {
        expect(frameDataLength({ frame_type: "new_connection_id", connection_id: "0102030405060708" })).toBe(8);
        expect(frameDataLength({ frame_type: "new_connection_id", connection_id_length: 4, connection_id: "01" })).toBe(
            4,
        );
        expect(frameDataLength({ frame_type: "new_token", token: { raw: { data: "aabbcc" } } })).toBe(3);
        expect(frameDataLength({ frame_type: "new_token", token: { raw: { length: 60, data: "aa" } } })).toBe(60);
        expect(frameDataLength({ frame_type: "ack" })).toBeUndefined();
    });
});

describe("splitPacket (§3.6.3 Q-P1, Q-P3, §9.3.1)", () => {
    it("latest semantics: payload_length excludes header and tag", () => {
        expect(splitPacket(1252, 1224, "1RTT")).toEqual({ header: 12, payload: 1224, trailer: 16 });
        expect(splitPacket(1280, 1229, "initial")).toEqual({ header: 35, payload: 1229, trailer: 16 });
    });

    it("payload_length that includes the tag (header < 1): qvis' interpretation, reported once by the caller", () => {
        const onTag = vi.fn();
        expect(splitPacket(1252, 1240, "1RTT", onTag)).toEqual({ header: 12, payload: 1224, trailer: 16 });
        expect(onTag).toHaveBeenCalledTimes(1);
    });

    it("fallback without payload_length: header min(4, total), for every packet type (PARITY)", () => {
        expect(splitPacket(1252, undefined, "1RTT")).toEqual({ header: 4, payload: 1232, trailer: 16 });
        expect(splitPacket(1252, 0, "initial")).toEqual({ header: 4, payload: 1232, trailer: 16 });
        expect(splitPacket(10, undefined, "1RTT")).toEqual({ header: 4, payload: -10, trailer: 16 }); // tiny packet (E7)
        expect(splitPacket(3, undefined, "1RTT")).toEqual({ header: 3, payload: -16, trailer: 16 });
    });

    it("explicit version_negotiation has no trailer", () => {
        expect(splitPacket(60, 40, "version_negotiation")).toEqual({ header: 20, payload: 40, trailer: 0 });
        expect(splitPacket(60, undefined, "version_negotiation")).toEqual({ header: 4, payload: 40, trailer: 16 });
    });
});

describe("sizeFrames (§3.6.4)", () => {
    it("guesstimate vector of §3.6.11: filler 12, ACK 11, STREAM 1/1200", () => {
        const r = size(1224, [
            { frame_type: "ack", acked_ranges: [[0, 3]] },
            { frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 1200 } },
        ]);
        expect(r.mode).toBe("guesstimate");
        expect(r.offset).toBe(12);
        expect(brief(r)).toEqual([
            ["ack", 11, 11, 0],
            ["stream", 1201, 1, 1200],
        ]);
        expect(r.diagnostics).toEqual([GUESS_MSG]);
    });

    it("the guesstimate warning is shown once per process() call", () => {
        const state = { frameSizeErrorShown: false };
        expect(size(10, [{ frame_type: "ping" }], state).diagnostics).toEqual([GUESS_MSG]);
        expect(size(10, [{ frame_type: "ping" }], state).diagnostics).toEqual([]);
    });

    it("explicit vector: every frame sized, offset 0, no message", () => {
        const r = size(1229, [
            { frame_type: "crypto", offset: 0, raw: { length: 64 } },
            { frame_type: "crypto", offset: 69, raw: { length: 1156 } },
        ]);
        expect(r.mode).toBe("explicit");
        expect(r.offset).toBe(0);
        expect(brief(r)).toEqual([
            ["crypto", 68, 4, 64],
            ["crypto", 1161, 5, 1156],
        ]);
        expect(r.diagnostics).toEqual([]);
    });

    it("explicit negative offset: reported, filler header negative (not drawn)", () => {
        const r = size(20, [
            { frame_type: "ping", raw: { length: 1 } },
            { frame_type: "ack", raw: { length: 25 } },
        ]);
        expect(r.mode).toBe("explicit");
        expect(r.offset).toBe(-6);
        expect(r.diagnostics).toEqual([
            "PacketizationQUICPreProcessor: frame_sizes don't fill the entire packet payload!",
        ]);
    });

    it("Q-F2: explicit only when EVERY frame has a size (qvis looked at frames[0] only)", () => {
        const r = size(100, [{ frame_type: "ack", raw: { length: 10 } }, { frame_type: "ping" }]);
        expect(r.mode).toBe("guesstimate");
        expect(brief(r)).toEqual([
            ["ack", 50, 50, 0],
            ["ping", 50, 50, 0],
        ]);
        expect(r.offset).toBe(0);
    });

    it("MAX_STREAMS hack: excluded from the divisor, still gets a share, total overshoots (Q-F6 PRESERVE)", () => {
        const r = size(20, [{ frame_type: "max_streams", maximum: 100 }, { frame_type: "ack" }]);
        expect(brief(r)).toEqual([
            ["max_streams", 20, 20, 0],
            ["ack", 20, 20, 0],
        ]);
        expect(r.offset).toBe(-20);
        expect(r.diagnostics).toContain(
            "PacketizationQUICPreProcessor: payload is longer than payload! Shouldn't happen!",
        );
    });

    it("only MAX_STREAMS frames: no Infinity/NaN sizes", () => {
        const r = size(20, [{ frame_type: "max_streams" }]);
        expect(brief(r)).toEqual([["max_streams", 0, 0, 0]]);
        expect(r.offset).toBe(20);
    });

    it("Q-F3: guesstimate overshoot keeps the split and returns a negative offset", () => {
        const r = size(100, [{ frame_type: "ack" }, { frame_type: "stream", stream_id: 0, raw: { length: 200 } }]);
        expect(r.diagnostics).toContain("PacketizationQUICPreProcessor: something went wrong calculating frame sizes!");
        expect(brief(r)).toEqual([
            ["ack", 0, 0, 0],
            ["stream", 201, 1, 200],
        ]);
        expect(r.offset).toBe(-101);
    });

    it("Q-F4: STREAM frame without a data length is treated like a non-STREAM frame (header-only)", () => {
        const r = size(30, [{ frame_type: "stream", stream_id: 0 }, { frame_type: "ping" }]);
        expect(r.diagnostics).toContain(
            "PacketizationQUICPreProcessor: stream frame with no length attribute! skipping...",
        );
        expect(brief(r)).toEqual([
            ["stream", 15, 15, 0],
            ["ping", 15, 15, 0],
        ]);
        expect(r.offset).toBe(0);
    });

    it("Q-F5: frame without frame_type is 'unknown'", () => {
        const r = size(10, [{ raw: { length: 10 } }]);
        expect(brief(r)).toEqual([["unknown", 10, 10, 0]]);
    });

    it("STREAM with a zero data length is header-only", () => {
        const r = size(10, [
            { frame_type: "stream", stream_id: 0, fin: true, raw: { length: 0 } },
            { frame_type: "ack" },
        ]);
        expect(brief(r)).toEqual([
            ["stream", 1, 1, 0],
            ["ack", 4, 4, 0],
        ]);
        expect(r.offset).toBe(5);
    });

    it("CRYPTO in guesstimate mode can get a negative header (Q-F8 PRESERVE)", () => {
        const r = size(100, [{ frame_type: "crypto", offset: 0, raw: { length: 90 } }, { frame_type: "ack" }]);
        expect(brief(r)).toEqual([
            ["crypto", 50, -40, 90],
            ["ack", 50, 50, 0],
        ]);
    });

    it("NEW_CONNECTION_ID without raw in guesstimate mode keeps an 8-byte payload rect (§9.13 #4)", () => {
        const r = size(30, [{ frame_type: "new_connection_id", connection_id: "0102030405060708" }]);
        expect(brief(r)).toEqual([["new_connection_id", 30, 22, 8]]);
    });

    describe("LEN-bit inference (§9.4.3, §9.13 #3)", () => {
        it("last STREAM frame without Length field: header shrinks by VLIE(len), no filler", () => {
            const r = size(52, [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 50 } }]);
            expect(r.offset).toBe(0);
            expect(brief(r)).toEqual([["stream", 52, 2, 50]]);
            expect(r.diagnostics).toEqual([]);
        });

        it("with the Length field present the header stays 3", () => {
            const r = size(53, [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 50 } }]);
            expect(brief(r)).toEqual([["stream", 53, 3, 50]]);
        });

        it("only when the difference is exactly VLIE(len) of the last frame", () => {
            const r = size(51, [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 50 } }]);
            expect(r.offset).toBe(-2);
        });

        it("CRYPTO is never adjusted", () => {
            const r = size(52, [{ frame_type: "crypto", offset: 0, raw: { length: 50 } }]);
            expect(r.offset).toBe(-1);
            expect(brief(r)).toEqual([["crypto", 53, 3, 50]]);
        });

        it("a STREAM frame sized by raw.length (main-schema semantics) is never adjusted", () => {
            const r = size(52, [{ frame_type: "stream", stream_id: 0, raw: { length: 53, payload_length: 50 } }]);
            expect(r.offset).toBe(-1);
        });
    });

    it("makeFiller: the qvis-injected filler", () => {
        expect(makeFiller(12)).toMatchObject({
            frame: { frame_type: FILLER_FRAME_TYPE },
            isFiller: true,
            header_size: 12,
            payload_size: 0,
        });
        expect(FILLER_FRAME_TYPE).toBe("qvis-injected FILLER (deal with incorrectly guesstimated frame size)");
    });
});
