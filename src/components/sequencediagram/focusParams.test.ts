import { normalizePacketNumberParam, readFocusParams } from "./focusParams";

describe("readFocusParams (§5.1, SQ10)", () => {
    it("focusOnConnection + focusOnEvent", () => {
        expect(readFocusParams({ focusOnConnection: "1", focusOnEvent: "25" })).toEqual({
            connectionIndex: 1,
            eventIndex: 25,
        });
        expect(readFocusParams({ focusOnConnection: "0", focusOnEvent: "0" })).toEqual({
            connectionIndex: 0,
            eventIndex: 0,
        });
    });

    it("focusOnPN, with an optional connection (default 0)", () => {
        expect(readFocusParams({ focusOnPN: "12" })).toEqual({ connectionIndex: 0, packetNumber: "12" });
        expect(readFocusParams({ focusOnPN: "0", focusOnConnection: "1" })).toEqual({
            connectionIndex: 1,
            packetNumber: "0",
        });
        // focusOnEvent without focusOnConnection falls through to focusOnPN
        expect(readFocusParams({ focusOnEvent: "3", focusOnPN: "7" })).toEqual({
            connectionIndex: 0,
            packetNumber: "7",
        });
    });

    it("nothing to focus", () => {
        expect(readFocusParams({})).toBeNull();
        expect(readFocusParams({ focusOnEvent: "3" })).toBeNull();
        expect(readFocusParams({ file: "x" })).toBeNull();
    });

    it("packet numbers stay exact above 2^53 and leading zeros are stripped", () => {
        expect(normalizePacketNumberParam("18446744073709551615")).toBe("18446744073709551615");
        expect(normalizePacketNumberParam("007")).toBe("7");
        expect(normalizePacketNumberParam("0")).toBe("0");
        expect(normalizePacketNumberParam("12abc")).toBe("12");
        expect(normalizePacketNumberParam("abc")).toBeUndefined();
    });
});
