import { calculateCoordinates, formatTime, type LayoutTrace } from "./layout";

function tr(times: number[], timeOffset = 0, absoluteStartTime = 0): LayoutTrace {
    return { length: times.length, absoluteTime: (i) => times[i], absoluteStartTime, timeOffset };
}

describe("calculateCoordinates (§3.6)", () => {
    it("worked example: exact y values, intervals and height", () => {
        const client = tr([0.0, 0.3, 25.0, 25.2]);
        const server = tr([12.5, 12.6, 12.9, 13.0, 37.7]);
        const r = calculateCoordinates([client, server], 1);
        expect(Array.from(r.y[0])).toEqual([80, 100, 400, 420]);
        expect(Array.from(r.y[1])).toEqual([220, 240, 260, 280, 540]);
        expect(r.intervals).toEqual([
            { yMin: 100, yMax: 220, timeSkipped: 12 },
            { yMin: 280, yMax: 400, timeSkipped: 12 },
            { yMin: 420, yMax: 540, timeSkipped: 12 },
        ]);
        expect(r.height).toBe(640);
        expect(Array.from(r.time[0]).map(formatTime)).toEqual(["0.00", "0.30", "25.00", "25.20"]);
        expect(Array.from(r.time[1]).map(formatTime)).toEqual(["12.50", "12.60", "12.90", "13.00", "37.70"]);
    });

    it("applies the latency offset and the earliest start time", () => {
        const client = tr([100, 100.3], 0, 100);
        const server = tr([5, 6], 100, 5); // server clock 95 ms behind, offset 100 ms
        const r = calculateCoordinates([client, server], 1);
        expect(r.startTime).toBe(5);
        expect(Array.from(r.time[0]).map(formatTime)).toEqual(["95.00", "95.30"]);
        expect(Array.from(r.time[1]).map(formatTime)).toEqual(["100.00", "101.00"]);
    });

    it("time multiplier x10 and x1000 (SQ15: timestamps in ms x multiplier)", () => {
        const r10 = calculateCoordinates([tr([0, 0.3, 1.5]), tr([0.05])], 10);
        expect(Array.from(r10.time[0]).map(formatTime)).toEqual(["0.00", "3.00", "15.00"]);
        const r1000 = calculateCoordinates([tr([0, 1.5]), tr([0.0005])], 1000);
        expect(Array.from(r1000.time[0]).map(formatTime)).toEqual(["0.00", "1500.00"]);
        expect(formatTime(r1000.time[1][0])).toBe("0.50");
        // 1.5 ms at x1000 = 1500 buckets: a compressed interval of 1499.5 -> 1500 - 0 = 1500 buckets skipped
        expect(r1000.intervals[0].timeSkipped).toBe(1500);
    });

    it("first event at bucket >= 6 starts with an inactivity interval one bucket too long (SQ16)", () => {
        const r = calculateCoordinates([tr([6.2, 6.4]), tr([30])], 1);
        expect(r.intervals[0]).toEqual({ yMin: 60, yMax: 180, timeSkipped: 7 });
        expect(r.y[0][0]).toBe(180);
        // first event at relative time 0 lands at 60 + 20
        expect(calculateCoordinates([tr([0]), tr([0.5])], 1).y[0][0]).toBe(80);
    });

    it("stacks three traces in one bucket and continues below the tallest stack", () => {
        const a = tr([1.0, 1.1, 2.0]);
        const b = tr([1.2, 1.3, 1.4]);
        const c = tr([1.5]);
        const r = calculateCoordinates([a, b, c], 1);
        expect(Array.from(r.y[0])).toEqual([100, 120, 160]);
        expect(Array.from(r.y[1])).toEqual([100, 120, 140]);
        expect(Array.from(r.y[2])).toEqual([100]);
    });

    it("gaps up to 6 buckets are drawn to scale, 7+ are compressed to 120 px", () => {
        const r = calculateCoordinates([tr([0, 6]), tr([13])], 1);
        expect(Array.from(r.y[0])).toEqual([80, 200]);
        expect(r.y[1][0]).toBe(320);
        expect(r.intervals).toEqual([{ yMin: 200, yMax: 320, timeSkipped: 7 }]);
    });

    it("ties go to the lowest trace index", () => {
        const r = calculateCoordinates([tr([1]), tr([1])], 1);
        expect(r.y[0][0]).toBe(100);
        expect(r.y[1][0]).toBe(100); // stacked from the same base: 80 + 20
    });

    it("throws (instead of looping) when only non-finite times are left (SQ26)", () => {
        expect(() => calculateCoordinates([tr([NaN]), tr([NaN])], 1)).toThrow(/not finite/);
    });
});
