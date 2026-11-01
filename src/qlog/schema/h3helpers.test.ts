// Shared HTTP/3 reader helpers (h3 digest §8.1), used by sequence, multiplexing, packetization and stats.
import { describe, expect, it } from "vitest";
import {
    fieldName,
    fieldValue,
    h3FrameHeaderLength,
    h3FramePayloadLength,
    h3FrameTypeNumber,
    hexToLatin1,
    vlieLength,
} from "./h3";

describe("h3 reader helpers (digest §8.1)", () => {
    it("fieldName / fieldValue use `??` with the hex *_bytes fallback", () => {
        expect(hexToLatin1("3a70617468")).toBe(":path");
        expect(fieldName({ name: ":path" })).toBe(":path");
        expect(fieldName({ name_bytes: "3a70617468" })).toBe(":path");
        expect(fieldName({ name: "a", name_bytes: "62" })).toBe("a");
        expect(fieldName({ name: null, name_bytes: "62" } as never)).toBe("b");
        expect(fieldValue({ name: "x", value_bytes: "2f61" })).toBe("/a");
        expect(fieldValue({ name: "x" })).toBeUndefined();
        expect(fieldName(undefined)).toBeUndefined();
        expect(fieldName(null)).toBeUndefined();
    });

    it("vlieLength and h3FrameTypeNumber", () => {
        expect([0, 63, 64, 16383, 16384, 1073741823, 1073741824].map(vlieLength)).toEqual([1, 1, 2, 2, 4, 4, 8]);
        expect(h3FrameTypeNumber({ frame_type: "headers" })).toBe(1);
        expect(h3FrameTypeNumber({ frame_type: "origin" })).toBe(0x0c);
        const requestUpdate = { frame_type: "priority_update", stream_id: 0 };
        expect(h3FrameTypeNumber(requestUpdate)).toBe(0xf0700);
        expect(h3FrameTypeNumber({ frame_type: "priority_update", push_id: 1 })).toBe(0xf0701);
        expect(h3FrameTypeNumber({ frame_type: "unknown", frame_type_bytes: "33" })).toBe(33);
        expect(h3FrameTypeNumber(undefined)).toBe(0);
    });

    it("h3FramePayloadLength prefers raw.payload_length, else derives it from raw.length / raw.data", () => {
        expect(h3FramePayloadLength({ frame_type: "data", raw: { length: 100, payload_length: "98" } })).toBe(98);
        // DATA: 1 byte type + 1 byte length + 60 payload
        expect(h3FramePayloadLength({ frame_type: "data", raw: { length: 62 } })).toBe(60);
        // DATA: 1 byte type + 2 bytes length + 100 payload
        expect(h3FramePayloadLength({ frame_type: "data", raw: { length: 103 } })).toBe(100);
        expect(h3FramePayloadLength({ frame_type: "headers", raw: { data: "0102030405" } })).toBe(3);
        expect(h3FramePayloadLength({ frame_type: "data" })).toBeUndefined();
    });

    it("h3FrameHeaderLength uses raw.length - raw.payload_length when both are logged", () => {
        expect(h3FrameHeaderLength({ frame_type: "data", raw: { length: 105, payload_length: 100 } }, 100)).toBe(5);
        expect(h3FrameHeaderLength({ frame_type: "data" }, 100)).toBe(3);
        const requestUpdate = { frame_type: "priority_update", stream_id: 0 };
        expect(h3FrameHeaderLength(requestUpdate, 10)).toBe(5);
    });
});
