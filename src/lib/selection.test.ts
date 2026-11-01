import { describe, expect, it } from "vitest";
import { firstAvailableConnection } from "./selection";

const g = (conns: string[]) => ({ getConnections: () => conns });

describe("firstAvailableConnection (Q12)", () => {
    it("returns the first trace of the first file", () => {
        expect(firstAvailableConnection([g(["a", "b"]), g(["c"])])).toBe("a");
    });

    it("skips files without traces", () => {
        expect(firstAvailableConnection([g([]), g(["c"])])).toBe("c");
    });

    it("returns undefined when nothing is selectable", () => {
        expect(firstAvailableConnection([])).toBeUndefined();
        expect(firstAvailableConnection([g([])])).toBeUndefined();
    });
});
