import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeGroup } from "./__fixtures__/fakeModel";
import { resetMockConnectionStore, useConnectionStore } from "./__fixtures__/mockConnectionStore";
import NoTraceAlerts from "./NoTraceAlerts";

vi.mock("@/store/connectionStore", () => import("./__fixtures__/mockConnectionStore"));

beforeEach(() => resetMockConnectionStore());

describe("<NoTraceAlerts/>", () => {
    it("asks for a file when nothing is loaded or loading", () => {
        const { container } = render(<NoTraceAlerts />);
        const alert = container.querySelector(".alert")!;
        expect(alert.className).toBe("alert alert-danger");
        expect(alert.textContent).toBe("Please load a trace file to visualize it");
    });

    it("shows the loading warning while requests are outstanding", () => {
        useConnectionStore.setState({ outstandingRequestCount: 1 });
        const { container } = render(<NoTraceAlerts />);
        const alert = container.querySelector(".alert")!;
        expect(alert.className).toBe("alert alert-warning");
        expect(alert.textContent).toBe("Loading files...");
    });

    it("renders nothing once a file is loaded", () => {
        const { container } = render(<NoTraceAlerts />);
        act(() => useConnectionStore.getState().addGroup(makeGroup("a.qlog", [{ title: "x" }])));
        expect(container.innerHTML).toBe("");
    });
});
