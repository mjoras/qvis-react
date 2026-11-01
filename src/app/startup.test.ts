import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockConnectionStore, useConnectionStore } from "@/components/shared/__fixtures__/mockConnectionStore";
import { resetStartupLoadForTests, runStartupLoadOnce } from "./startup";

vi.mock("@/store/connectionStore", () => import("@/components/shared/__fixtures__/mockConnectionStore"));

const load = () => vi.mocked(useConnectionStore.getState().loadFilesFromServer);

beforeEach(() => {
    resetMockConnectionStore();
    resetStartupLoadForTests();
    load().mockClear();
});

describe("runStartupLoadOnce (parity/app-shell.md §3.1, §8.3)", () => {
    it("forwards ANY non-empty query once", () => {
        runStartupLoadOnce({ focusOnEvent: "3" });
        runStartupLoadOnce({ file: "x.qlog" });
        expect(load()).toHaveBeenCalledTimes(1);
        expect(load()).toHaveBeenCalledWith({ focusOnEvent: "3" });
    });

    it("does nothing for an empty query, and never runs later (Q6)", () => {
        runStartupLoadOnce({});
        runStartupLoadOnce({ file: "x.qlog" });
        expect(load()).not.toHaveBeenCalled();
    });

    it("swallows rejected loads with a console error", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        load().mockRejectedValueOnce(new Error("boom"));
        runStartupLoadOnce({ file: "x.qlog" });
        await new Promise((r) => setTimeout(r, 0));
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });
});
