import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockConnectionStore, useConnectionStore } from "@/components/shared/__fixtures__/mockConnectionStore";
import { notify, resetNotificationsForTests } from "@/lib/notify";
import App from "./App";
import { initRouter, migratePreHashQuery, navigate, resetRouterForTests } from "./router";
import { resetStartupLoadForTests } from "./startup";

vi.mock("@/store/connectionStore", () => import("@/components/shared/__fixtures__/mockConnectionStore"));

function boot(url: string) {
    resetRouterForTests();
    window.history.replaceState(null, "", url);
    migratePreHashQuery();
    initRouter();
    return render(
        <StrictMode>
            <App />
        </StrictMode>,
    );
}

const load = () => vi.mocked(useConnectionStore.getState().loadFilesFromServer);

beforeEach(() => {
    resetMockConnectionStore();
    resetStartupLoadForTests();
    resetNotificationsForTests();
    load().mockClear();
});

afterEach(() => {
    resetRouterForTests();
});

describe("<App/>", () => {
    it("renders menu, routed view and the notification container in that order", () => {
        const { container } = boot("/#/congestion");
        const children = Array.from(container.children);
        expect(children[0].id).toBe("MainMenu");
        expect(container.querySelector("#CongestionGraphContainer")).not.toBeNull();
        expect(children[children.length - 1].className).toBe("vue-notification-group notifications");
        expect(screen.getByText("Please load a trace file to visualize it")).toBeInTheDocument();
    });

    it("loads files from the startup query exactly once (StrictMode-safe)", () => {
        boot("/?file=https://a.org/x.qlog#/sequence");
        expect(load()).toHaveBeenCalledTimes(1);
        expect(load()).toHaveBeenCalledWith({ file: "https://a.org/x.qlog" });
        act(() => navigate("/stats", { file: "other.qlog" }));
        expect(load()).toHaveBeenCalledTimes(1);
    });

    it("does not load without a query", () => {
        boot("/#/files");
        expect(load()).not.toHaveBeenCalled();
    });

    it("switches views on navigation and keeps the menu mounted", () => {
        const { container } = boot("/#/sequence");
        const menu = container.querySelector("#MainMenu");
        expect(container.querySelector("#SequenceDiagramContainer")).not.toBeNull();
        act(() => navigate("/multiplexing"));
        expect(container.querySelector("#SequenceDiagramContainer")).toBeNull();
        expect(container.querySelector("#MultiplexingGraphContainer")).not.toBeNull();
        expect(container.querySelector("#MainMenu")).toBe(menu);
        act(() => navigate("/packetization"));
        expect(container.querySelector("#PacketizationDiagramContainer")).not.toBeNull();
        act(() => navigate("/stats"));
        expect(container.querySelector("#StatisticsContainer")).not.toBeNull();
    });

    it("renders the file manager for unknown routes (Q4)", () => {
        const { container } = boot("/#/does-not-exist");
        expect(container.querySelector("#MainMenu")).not.toBeNull();
        expect(container.querySelector("li.files-link a.active")).not.toBeNull();
    });

    it("shows toasts emitted by store actions", () => {
        boot("/#/files");
        act(() => notify({ group: "default", title: "Loading file(s) via URL", text: "x" }));
        expect(screen.getByText("Loading file(s) via URL")).toBeInTheDocument();
    });

    it("renders the debug page on #/debug with no active tab", () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const { container } = boot("/#/debug");
        expect(screen.getByText("This is the VUE debugger to test reactive data coupling")).toBeInTheDocument();
        expect(container.querySelector("#MainMenu a.active")).toBeNull();
        expect(useConnectionStore.getState().groups).toHaveLength(3);
        vi.restoreAllMocks();
    });
});
