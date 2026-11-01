import {
    hexByteLength,
    isRawOmitted,
    isRawTruncated,
    isUint64,
    rawByteLength,
    toBigInt,
    toNumber,
    toUint64String,
    uint64Equals,
} from "./uint64";

describe("uint64 helpers (I-JSON: number or decimal string)", () => {
    it("toNumber accepts numbers and decimal strings", () => {
        expect(toNumber(42)).toBe(42);
        expect(toNumber("42")).toBe(42);
        expect(toNumber(" 7 ")).toBe(7);
        expect(toNumber("1.5")).toBe(1.5);
        expect(toNumber("abc")).toBeNaN();
        expect(toNumber(undefined)).toBeNaN();
        expect(toNumber(null)).toBeNaN();
        expect(toNumber({})).toBeNaN();
        expect(toNumber("")).toBeNaN();
    });

    it("toBigInt is exact beyond 2^53", () => {
        expect(toBigInt("18446744073709551615")).toBe(18446744073709551615n);
        expect(toBigInt(5)).toBe(5n);
        expect(toBigInt(1.5)).toBeUndefined();
        expect(toBigInt("x")).toBeUndefined();
    });

    it("isUint64 / toUint64String / uint64Equals", () => {
        expect(isUint64(3)).toBe(true);
        expect(isUint64("3")).toBe(true);
        expect(isUint64(-1)).toBe(false);
        expect(isUint64("1.5")).toBe(false);
        expect(toUint64String(12)).toBe("12");
        expect(toUint64String("12")).toBe("12");
        expect(uint64Equals(12, "12")).toBe(true);
        expect(uint64Equals("9007199254740993", "9007199254740993")).toBe(true);
        expect(uint64Equals("9007199254740993", "9007199254740992")).toBe(false);
    });

    it("RawInfo length rules (main-schema section 11.4)", () => {
        expect(hexByteLength("051428abff")).toBe(5);
        expect(rawByteLength({ length: 5, data: "051428abff" })).toBe(5);
        expect(rawByteLength({ data: "051428abff" })).toBe(5);
        expect(rawByteLength({ length: "1280" })).toBe(1280);
        expect(rawByteLength(undefined)).toBeUndefined();
        expect(isRawTruncated({ length: 5, data: "051428" })).toBe(true);
        expect(isRawTruncated({ length: 5, data: "051428abff" })).toBe(false);
        expect(isRawOmitted({ length: 5 })).toBe(true);
        expect(isRawOmitted({ length: 5, data: "00" })).toBe(false);
    });
});
