import { kFormat, rttTickFormat, rulerTexts, stepValueAt } from "./format";
import { panClamp, wheelZoom, xDrawScale } from "./viewport";

describe("kFormat (§2.4)", () => {
    it.each([
        [1000, "1000"],
        [2000, "2K"],
        [2500, "2500"],
        [12000, "12K"],
        [12010, "12010"],
        [1000000, "1000K"],
        [-2000, "-2K"],
        [0.4, "0"],
        [0, "0"],
    ])("%s -> %s", (n, s) => {
        expect(kFormat(n)).toBe(s);
    });

    it("RTT ticks: K format for integers, d3 default for fractions (Q5)", () => {
        const f = rttTickFormat((n) => n.toFixed(1).replace("-", "−"));
        expect(f(40)).toBe("40");
        expect(f(2000)).toBe("2K");
        expect(f(0.5)).toBe("0.5");
        expect(f(-0.5)).toBe("-0.5");
    });
});

describe("ruler texts (§3.9)", () => {
    it("times", () => {
        expect(rulerTexts(0, 523, 0, 0).time).toBe("523 ms");
        expect(rulerTexts(0, 10001, 0, 0).time).toBe("10.00s");
        expect(rulerTexts(0, 10000, 0, 0).time).toBe("10000 ms");
        expect(rulerTexts(0, 12345.4, 0, 0).time).toBe("12.35s");
        expect(rulerTexts(500, 0, 0, 0).time).toBe("-500 ms");
    });

    it("bytes", () => {
        expect(rulerTexts(0, 1, 0, 1523).bytes).toBe("1523 bytes");
        expect(rulerTexts(0, 1, 0, 2000001).bytes).toBe("2.00 MB");
        expect(rulerTexts(0, 1, 0, 10001).bytes).toBe("10 KB");
        expect(rulerTexts(0, 1, 0, 10000).bytes).toBe("10000 bytes");
        expect(rulerTexts(0, 1, 50000, 0).bytes).toBe("-50000 bytes");
    });

    it("rates", () => {
        expect(rulerTexts(0, 1000, 0, 125000).rate).toBe("1000 Kbps"); // 1000 Kbit/s
        expect(rulerTexts(0, 1000, 0, 125125).rate).toBe("1.00 Mbps"); // 1001 Kbit/s
        expect(rulerTexts(0, 1000, 0, 65375).rate).toBe("523 Kbps");
        expect(rulerTexts(0, 0, 0, 1000).rate).toBe("Infinity Mbps");
        expect(rulerTexts(0, 0, 0, 0).rate).toBe("NaN Kbps");
    });
});

describe("tooltip step lookup (§3.8)", () => {
    const series: [number, number][] = [
        [5, 0],
        [5, 40960],
        [12, 40960],
        [12, 52000],
        [100, 52000],
    ];
    it("finds the step containing t; an update time shows the new value", () => {
        expect(stepValueAt(series, 4)).toEqual([]);
        expect(stepValueAt(series, 5)).toEqual([40960]);
        expect(stepValueAt(series, 11)).toEqual([40960]);
        expect(stepValueAt(series, 12)).toEqual([52000]);
        // Q11 fix: the last pair counts
        expect(stepValueAt(series, 50)).toEqual([52000]);
        expect(stepValueAt(series, 100)).toEqual([]);
    });
});

describe("viewport (§3.7)", () => {
    it("xDrawScale", () => {
        expect(xDrawScale(1)).toBeCloseTo(1.46894, 5);
        expect(xDrawScale(2)).toBe(1.7);
        expect(xDrawScale(Infinity)).toBe(2.2);
    });

    it("wheel zoom keeps the cursor time fixed and clamps to [0, max]", () => {
        const zin = wheelZoom(-100, 50, [0, 100], 100)!;
        expect(zin[0]).toBeCloseTo(50 - 50 / 1.5);
        expect(zin[1]).toBeCloseTo(50 + 50 / 1.5);
        // the time under the cursor keeps its relative position
        expect((50 - zin[0]) / (zin[1] - zin[0])).toBeCloseTo(0.5);
        expect(wheelZoom(100, 50, [20, 80], 100)).toEqual([5, 95]);
        expect(wheelZoom(100, 10, [0, 100], 100)).toEqual([0, 100]);
        // Q14: horizontal swipes are ignored
        expect(wheelZoom(0, 50, [0, 100], 100)).toBeUndefined();
    });

    it("pan clamps snap the delta to the boundary", () => {
        expect(panClamp(-30, 0, [10, 50], [0, 10], [0, 100], [0, 10])).toEqual({ x: [0, 40], y: [0, 10] });
        expect(panClamp(80, 0, [10, 50], [0, 10], [0, 100], [0, 10])).toEqual({ x: [60, 100], y: [0, 10] });
        expect(panClamp(5, 3, [10, 50], [2, 6], [0, 100], [0, 10])).toEqual({ x: [15, 55], y: [5, 9] });
        expect(panClamp(0, 6, [10, 50], [2, 6], [0, 100], [0, 10])).toEqual({ x: [10, 50], y: [6, 10] });
    });
});
