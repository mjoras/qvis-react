import { describe, expect, it } from "vitest";
import { ColorHelper, FALLBACK_STREAM_COLOR, isDataStream, streamIdToColor } from "./colorHelper";

const h3 = (id: string) => streamIdToColor(id, "HTTP3")[0];
const h2 = (id: string) => streamIdToColor(id, "HTTP2")[0];

describe("streamIdToColor (parity/app-shell.md §3.7 vectors)", () => {
    it("always returns [fill, 'black']", () => {
        expect(streamIdToColor("0", "HTTP3")).toEqual(["#E1DA4C", "black"]);
        expect(streamIdToColor("x", "HTTP2")).toEqual(["lavenderblush", "black"]);
        expect(FALLBACK_STREAM_COLOR).toBe("lavenderblush");
    });

    it("HTTP3 palette and cycling through client-bidi IDs (mod 56)", () => {
        expect(h3("0")).toBe("#E1DA4C");
        expect(h3("4")).toBe("#6B067F");
        expect(h3("52")).toBe("#C8A454");
        expect(h3("56")).toBe("#E1DA4C");
        expect(h3("60")).toBe("#6B067F");
        expect(h3("100")).toBe("#D38E75");
    });

    it("HTTP3 fallbacks", () => {
        for (const id of ["2", "3", "53", "57", "abc", "-4"]) {
            expect(h3(id)).toBe("lavenderblush");
        }
    });

    it("parses with parseInt after the exact-string lookup", () => {
        expect(h3("04")).toBe("#6B067F");
        expect(h3(" 8")).toBe("#E17426");
        expect(h3("4.7")).toBe("#6B067F");
    });

    it("HTTP2 palette, mod 28 quirk", () => {
        expect(h2("0")).toBe("#FF0000");
        expect(h2("1")).toBe("#E1DA4C");
        expect(h2("27")).toBe("#C8A454");
        expect(h2("29")).toBe("#E1DA4C");
        expect(h2("28")).toBe("#FF0000");
        expect(h2("2")).toBe("lavenderblush");
        expect(h2("30")).toBe("lavenderblush");
    });

    it("exposes the qvis static API shape", () => {
        expect(ColorHelper.StreamIDToColor("8", "HTTP3")[0]).toBe("#E17426");
    });
});

describe("isDataStream", () => {
    it("is true for client-initiated bidirectional stream IDs", () => {
        expect(isDataStream("0")).toBe(true);
        expect(isDataStream("4")).toBe(true);
        expect(isDataStream("2")).toBe(false);
        expect(isDataStream("3")).toBe(false);
    });
});
