import {
    PacketizationDiagnostics,
    VLIELength,
    extractRanges,
    type LightweightRange,
} from "./PacketizationDiagramModels";
import {
    fieldName,
    fieldValue,
    h3FrameHeaderLength,
    h3FramePayloadLength,
    h3FrameTypeNumber,
    u64,
    vlieLength,
} from "./h3Helpers";

describe("VLIELength", () => {
    it.each([
        [0, 1],
        [63, 1],
        [64, 2],
        [16383, 2],
        [16384, 4],
        [1073741823, 4],
        [1073741824, 8],
        [NaN, 8],
    ])("%d -> %d", (n, len) => {
        expect(VLIELength(n)).toBe(len);
        expect(vlieLength(n)).toBe(len);
    });
});

describe("extractRanges", () => {
    it("consumes whole ranges from the front", () => {
        const a = { start: 0, size: 10 };
        const b = { start: 20, size: 5 };
        const c = { start: 30, size: 7 };
        const ranges: LightweightRange[] = [a, b, c];
        const out = extractRanges(ranges, 15, new PacketizationDiagnostics(true));
        expect(out).toEqual([a, b]);
        expect(out[0]).toBe(a); // same objects (PARITY)
        expect(out[1]).toBe(b);
        expect(ranges).toEqual([c]);
    });

    it("splits the last range: the consumed piece is the original object, shortened; the remainder goes back in front", () => {
        const a = { start: 0, size: 10 };
        const b = { start: 20, size: 5 };
        const ranges: LightweightRange[] = [a, b];
        const out = extractRanges(ranges, 13, new PacketizationDiagnostics(true));
        expect(out).toHaveLength(2);
        expect(out[0]).toBe(a);
        expect(out[1]).toBe(b);
        expect(b).toEqual({ start: 20, size: 3 }); // mutated in place
        expect(ranges).toEqual([{ start: 23, size: 2 }]);
        expect(ranges[0]).not.toBe(b);
    });

    it("size 0: warns and returns nothing", () => {
        const d = new PacketizationDiagnostics(true);
        const ranges = [{ start: 0, size: 10 }];
        expect(extractRanges(ranges, 0, d)).toEqual([]);
        expect(ranges).toHaveLength(1);
        expect(d.messages).toEqual(["Trying to extract ranges for size 0... potential error? Skipping..."]);
        expect(d.insufficientBytes).toBe(false);
    });

    it("insufficient bytes: reported (no alert) and flagged for N-PZ3", () => {
        const alert = vi.fn();
        vi.stubGlobal("alert", alert);
        const d = new PacketizationDiagnostics(true);
        const ranges = [{ start: 0, size: 4 }];
        const out = extractRanges(ranges, 10, d);
        expect(out).toEqual([{ start: 0, size: 4 }]);
        expect(ranges).toEqual([]);
        expect(d.messages).toEqual(["Trying to fill payloadranges that aren't there! 6"]);
        expect(d.insufficientBytes).toBe(true);
        expect(alert).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("warns when a 5-byte (TLS) header is split", () => {
        const d = new PacketizationDiagnostics(true);
        const ranges = [
            { start: 0, size: 3 },
            { start: 10, size: 10 },
        ];
        const out = extractRanges(ranges, 5, d);
        expect(out).toEqual([
            { start: 0, size: 3 },
            { start: 10, size: 2 },
        ]);
        expect(d.messages).toEqual(["Splitting a header range... server is being bad/naive?"]);
    });

    it("never loops on NaN / negative sizes (qvis looped forever)", () => {
        const d = new PacketizationDiagnostics(true);
        const ranges = [{ start: 0, size: 10 }];
        expect(extractRanges(ranges, NaN, d)).toEqual([]);
        expect(extractRanges(ranges, -3, d)).toEqual([]);
        expect(ranges).toEqual([{ start: 0, size: 10 }]);
        expect(d.insufficientBytes).toBe(true);
    });

    it("logs with console.warn unless silent", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        extractRanges([], 0, new PacketizationDiagnostics());
        expect(warn).toHaveBeenCalledWith("Trying to extract ranges for size 0... potential error? Skipping...");
        warn.mockClear();
        extractRanges([], 0, new PacketizationDiagnostics(true));
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("HTTP/3 helpers", () => {
    it("u64 accepts numbers and decimal strings", () => {
        expect(u64(5)).toBe(5);
        expect(u64("1472")).toBe(1472);
        expect(u64(undefined)).toBeUndefined();
        expect(u64("abc")).toBeUndefined();
        expect(u64(null)).toBeUndefined();
    });

    it("h3FrameTypeNumber (Q-H4 fix)", () => {
        expect(h3FrameTypeNumber({ frame_type: "data" })).toBe(0);
        expect(h3FrameTypeNumber({ frame_type: "headers" })).toBe(1);
        expect(h3FrameTypeNumber({ frame_type: "cancel_push" })).toBe(3);
        expect(h3FrameTypeNumber({ frame_type: "settings" })).toBe(4);
        expect(h3FrameTypeNumber({ frame_type: "push_promise" })).toBe(5);
        expect(h3FrameTypeNumber({ frame_type: "goaway" })).toBe(7);
        expect(h3FrameTypeNumber({ frame_type: "origin" })).toBe(0x0c);
        expect(h3FrameTypeNumber({ frame_type: "max_push_id" })).toBe(0x0d);
        expect(h3FrameTypeNumber({ frame_type: "priority_update" })).toBe(0xf0700);
        expect(h3FrameTypeNumber({ frame_type: "priority_update", push_id: 3 })).toBe(0xf0701);
        expect(h3FrameTypeNumber({ frame_type: "unknown", frame_type_bytes: 64 })).toBe(64);
        expect(h3FrameTypeNumber({ frame_type: "unknown" })).toBe(0);
        expect(h3FrameTypeNumber({ frame_type: "webtransport_stream" })).toBe(0);
        expect(h3FrameTypeNumber(undefined)).toBe(0);
    });

    it("h3FrameHeaderLength: priority_update needs a 4-byte type varint; reserved uses frame_type_bytes", () => {
        expect(h3FrameHeaderLength({ frame_type: "priority_update", push_id: 0 }, 10)).toBe(4 + 1);
        expect(h3FrameHeaderLength({ frame_type: "priority_update" }, 100)).toBe(4 + 2);
        expect(h3FrameHeaderLength({ frame_type: "reserved", frame_type_bytes: 0x21 + 0x1f * 1000 }, 0)).toBe(4 + 1);
        expect(h3FrameHeaderLength({ frame_type: "data" }, 2623)).toBe(1 + 2);
    });

    it("h3FrameHeaderLength: raw.length - raw.payload_length shortcut (non-minimal varints)", () => {
        expect(h3FrameHeaderLength({ frame_type: "data", raw: { length: 20005, payload_length: 20000 } }, 20000)).toBe(
            5,
        );
        expect(h3FrameHeaderLength({ frame_type: "data", raw: { length: "38", payload_length: "36" } }, 36)).toBe(2);
        // inconsistent values fall back to the computed length
        expect(h3FrameHeaderLength({ frame_type: "data", raw: { length: 10, payload_length: 10 } }, 10)).toBe(2);
    });

    it("h3FramePayloadLength: payload_length, else derived from raw.length / raw.data", () => {
        expect(h3FramePayloadLength({ frame_type: "data", raw: { payload_length: 0 } })).toBe(0);
        expect(h3FramePayloadLength({ frame_type: "data", raw: { payload_length: "36" } })).toBe(36);
        expect(h3FramePayloadLength({ frame_type: "headers", raw: { length: 38 } })).toBe(36);
        expect(h3FramePayloadLength({ frame_type: "data", raw: { length: 2626 } })).toBe(2623);
        expect(h3FramePayloadLength({ frame_type: "settings", raw: { data: "0400" } })).toBe(0);
        expect(h3FramePayloadLength({ frame_type: "data" })).toBeUndefined();
        expect(h3FramePayloadLength(undefined)).toBeUndefined();
    });

    it("fieldName / fieldValue decode *_bytes as Latin-1", () => {
        expect(fieldName({ name: ":path" })).toBe(":path");
        expect(fieldName({ name_bytes: "3a70617468" })).toBe(":path");
        expect(fieldValue({ name: "x", value_bytes: "2f61" })).toBe("/a");
        expect(fieldValue({ name: "x" })).toBeUndefined();
        expect(fieldName(undefined)).toBeUndefined();
    });
});
