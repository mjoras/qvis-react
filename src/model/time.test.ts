import { ConnectionTiming, epochMsOf, parseRfc3339Ms, TimeTrackingMethod } from "./time";

describe("parseRfc3339Ms", () => {
    it("parses Z, offsets, fractions beyond ms, lowercase t/z, space separator", () => {
        expect(parseRfc3339Ms("1970-01-01T00:00:00.000Z")).toBe(0);
        expect(parseRfc3339Ms("2024-10-10T10:10:10.000Z")).toBe(Date.UTC(2024, 9, 10, 10, 10, 10));
        expect(parseRfc3339Ms("2024-10-10T10:10:10.5Z")).toBe(Date.UTC(2024, 9, 10, 10, 10, 10, 500));
        expect(
            parseRfc3339Ms("2026-11-01T11:32:13.392432-07:00")! - Date.UTC(2026, 10, 1, 18, 32, 13, 392),
        ).toBeCloseTo(0.432, 3); // float64 ulp at 1.8e12 ms is ~0.24 us
        expect(parseRfc3339Ms("2024-10-10t10:10:10+02:00")).toBe(Date.UTC(2024, 9, 10, 8, 10, 10));
        expect(parseRfc3339Ms("2024-10-10 10:10:10z")).toBe(Date.UTC(2024, 9, 10, 10, 10, 10));
        expect(parseRfc3339Ms("0050-01-01T00:00:00Z")).toBe(new Date("0050-01-01T00:00:00Z").getTime()); // not 1950
        expect(parseRfc3339Ms("2016-12-31T23:59:60Z")).toBe(Date.UTC(2016, 11, 31, 23, 59, 59)); // leap second
        expect(parseRfc3339Ms("garbage")).toBeNull();
    });
});

describe("epochMsOf", () => {
    it("CDDL default, unknown, dated, legacy numeric", () => {
        const problems: string[] = [];
        const report = (code: string) => problems.push(code);
        expect(epochMsOf(undefined, report)).toBe(0);
        expect(epochMsOf({ clock_type: "monotonic", epoch: "unknown" }, report)).toBeNull();
        expect(epochMsOf({ clock_type: "system", epoch: "unknown" }, report)).toBeNull();
        expect(epochMsOf({ clock_type: "system", epoch: "1970-01-01T00:00:00.000Z" }, report)).toBe(0);
        expect(epochMsOf({ clock_type: "custom", epoch: "2024-10-10T10:10:10Z" }, report)).toBe(
            Date.UTC(2024, 9, 10, 10, 10, 10),
        );
        expect(problems).toEqual([]);
        expect(epochMsOf(1564658098991, report)).toBe(1564658098991);
        expect(epochMsOf("1564658098991", report)).toBe(1564658098991);
        expect(epochMsOf("not-a-number", report)).toBeNull();
        expect(epochMsOf({ clock_type: "system" }, report)).toBeNull();
        expect(epochMsOf({ clock_type: "system", epoch: 5 }, report)).toBeNull();
        expect(epochMsOf({ clock_type: "system", epoch: "yesterday" }, report)).toBeNull();
        expect(epochMsOf({ clock_type: "monotonic", epoch: "2024-10-10T10:10:10Z" }, report)).toBe(
            Date.UTC(2024, 9, 10, 10, 10, 10),
        );
        expect(problems).toEqual([
            "time.legacy-reference-time",
            "time.legacy-reference-time",
            "time.legacy-reference-time",
            "time.missing-epoch",
            "time.unparseable-epoch",
            "time.unparseable-epoch",
            "time.monotonic-with-epoch",
        ]);
    });
});

describe("ConnectionTiming", () => {
    it("cases A / R / U", () => {
        const t = new ConnectionTiming();
        t.setCase(0, 1000);
        expect([t.method, t.relativeZero, t.absoluteShift, t.getAbsoluteStartTime()]).toEqual([
            TimeTrackingMethod.ABSOLUTE_TIME,
            1000,
            0,
            1000,
        ]);
        t.setCase(5000, 3);
        expect([t.method, t.relativeZero, t.absoluteShift, t.getAbsoluteStartTime()]).toEqual([
            TimeTrackingMethod.RELATIVE_TIME,
            0,
            5000,
            5000,
        ]);
        t.setCase(null, 7);
        expect([t.method, t.relativeZero, t.absoluteShift, t.getAbsoluteStartTime()]).toEqual([
            TimeTrackingMethod.RELATIVE_TIME,
            7,
            -7,
            0,
        ]);
        t.setReferenceTime(100);
        expect([t.absoluteShift, t.getAbsoluteStartTime()]).toEqual([93, 100]);
        expect(TimeTrackingMethod.DELTA_TIME).toBe(2);
        expect(t.timeToMilliseconds("1.25")).toBe(1.25);
        expect(t.timeOffset).toBe(0);
    });
});
