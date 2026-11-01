// Congestion graph page (jsdom): configurator texts and alerts, default selection, Q41 notice, renderer DOM
// lifecycle (StrictMode-safe mount / unmount), button and R-key guards. Pixels are covered by tests/e2e/congestion.spec.ts.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { ev, file, loaded, trace } from "@/model/__fixtures__/qlog";
import { QlogLoader } from "@/model/QlogLoader";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import CongestionGraphContainer from "./CongestionGraphContainer";

const INTRO = "Select a trace via the dropdown(s) below to visualize it in the congestion graph";

function addFile(name: string, events: unknown[]) {
    const group = QlogLoader.fromJSON(loaded(file([trace(events, { vantage_point: { type: "server" } })])), {
        filename: name,
    });
    if (!group) throw new Error("not loaded");
    act(() => useConnectionStore.getState().addGroup(group));
    return group;
}

const SERVER_EVENTS = [
    ev(0, "quic:parameters_set", { initiator: "remote", initial_max_data: 786432 }),
    ev(1, "quic:packet_sent", { header: { packet_type: "1RTT", packet_number: 0 }, raw: { length: 1252 } }),
    ev(2, "quic:packet_sent", { header: { packet_type: "1RTT", packet_number: 1 }, raw: { length: 1252 } }),
    ev(3, "quic:recovery_metrics_updated", { congestion_window: 40960, bytes_in_flight: 2504, latest_rtt: 30 }),
    ev(30, "quic:packet_received", {
        header: { packet_type: "1RTT", packet_number: 0 },
        raw: { length: 40 },
        frames: [{ frame_type: "ack", acked_ranges: [[0, 1]] }],
    }),
];

beforeEach(() => {
    // jsdom has no canvas: the renderer must cope with a missing 2D context
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    useConnectionStore.setState({ groups: [], revision: 0, outstandingRequestCount: 0 });
    useConfigurationStore.getState().reset();
    document.body.style.cursor = "";
});
afterEach(() => vi.restoreAllMocks());

describe("<CongestionGraphContainer/>", () => {
    it("shows the intro, the six buttons, the danger alert and the empty graph host without files", () => {
        const { container } = render(<CongestionGraphContainer />);
        expect(screen.getByText(INTRO, { exact: true })).toBeInTheDocument();
        expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
            "Reset zoom",
            "Zoom timerange",
            "Zoom area",
            "Ruler (press R)",
            "Toggle congestion info",
            "Toggle RTT zooming",
        ]);
        expect(container.querySelector(".alert")!.textContent).toBe("Please load a trace file to visualize it");
        const host = container.querySelector("#congestion-graph") as HTMLElement;
        expect(host.style.border).toBe("5px solid rgb(212, 237, 218)");
        expect(host.style.minHeight).toBe("200px");
        expect([...host.children].map((c) => c.id)).toEqual(["legendPackets", "legendMetrics", "legendRTT"]);
        // every item keeps qvis' template whitespace `<p> <span></span> : Label </p>`: in the inline RTT legend the
        // trailing space widens each item (qvis: a 491.2px box at 16px Avenir, not 482.3px)
        const items = (id: string) =>
            [...container.querySelectorAll(`#${id} > p`)].map((p) => p.textContent!.replace(/\s+/g, " "));
        expect(items("legendPackets")).toEqual([
            " : Data sent (includes retransmits) ",
            " : Data acknowledged ",
            " : Data lost ",
            " : Connection flow control limit ",
            " : Sum of stream flow control limits ",
        ]);
        expect(items("legendMetrics")).toEqual([" : Congestion window ", " : Bytes in flight "]);
        expect(items("legendRTT")).toEqual([" : Min RTT ", " : Latest RTT ", " : Smoothed RTT "]);
        for (const p of container.querySelectorAll("#legendRTT > p")) expect(p.textContent!.endsWith(" ")).toBe(true);

        // Q10: buttons and R are no-ops before anything is rendered
        for (const b of screen.getAllByRole("button")) fireEvent.click(b);
        fireEvent.keyUp(document, { code: "KeyR" });
        expect(document.body.style.cursor).toBe("");
        expect(container.querySelector("#mainGraphContainer")).toBeNull();
    });

    it("selects the first trace of the first file and renders both graphs (StrictMode: one DOM set)", () => {
        const { container, unmount } = render(
            <StrictMode>
                <CongestionGraphContainer />
            </StrictMode>,
        );
        const group = addFile("server.sqlog", SERVER_EVENTS);
        expect(useConfigurationStore.getState().congestionConfig.connection).toBe(group.getConnections()[0]);
        expect(container.querySelector(".alert")).toBeNull();
        expect(container.querySelector("select")).not.toBeNull();

        expect(container.querySelectorAll("#mainGraphContainer")).toHaveLength(1);
        expect(container.querySelectorAll("#recoveryGraphContainer")).toHaveLength(1);
        const main = container.querySelector("#mainGraphContainer") as HTMLElement;
        expect(main.style.height).toBe("600px");
        expect(main.style.display).toBe("block");
        // axes svg + canvas + six mode layers, the panning layer on top
        expect([...main.children].map((c) => c.tagName.toLowerCase())).toEqual([
            "svg",
            "canvas",
            "svg",
            "svg",
            "svg",
            "svg",
            "svg",
            "svg",
        ]);
        expect([...main.querySelectorAll(":scope > svg")].slice(1).map((s) => (s as SVGElement).style.zIndex)).toEqual([
            "1",
            "0",
            "0",
            "0",
            "0",
            "0",
        ]);
        const titles = [...main.querySelectorAll("svg > g > text")].map((t) => t.textContent);
        expect(titles).toEqual(["Data (bytes)", "Time (ms)", "Congestion info (bytes)"]);
        const yTicks = [...main.querySelectorAll("svg > g > g.grid")[1].querySelectorAll(".tick text")].map(
            (t) => t.textContent,
        );
        expect(yTicks.length).toBeGreaterThan(0);
        expect(yTicks.every((t) => /^\d+K?$/.test(t!))).toBe(true);

        // buttons work once rendered; the ruler arms with the R key
        fireEvent.click(screen.getByRole("button", { name: "Zoom timerange" }));
        expect([...main.querySelectorAll(":scope > svg")].slice(1).map((s) => (s as SVGElement).style.zIndex)).toEqual([
            "0",
            "1",
            "0",
            "0",
            "0",
            "0",
        ]);
        fireEvent.keyUp(document, { code: "KeyR" });
        expect(document.body.style.cursor).toBe("pointer");

        unmount();
        expect(document.body.style.cursor).toBe(""); // Q9: restored when leaving with an armed ruler
    });

    it("ignores R while typing in a form control or with modifiers (Q39)", () => {
        render(<CongestionGraphContainer />);
        addFile("server.sqlog", SERVER_EVENTS);
        fireEvent.keyUp(document, { code: "KeyR", ctrlKey: true });
        expect(document.body.style.cursor).toBe("");
        fireEvent.keyUp(screen.getByRole("combobox"), { code: "KeyR" });
        expect(document.body.style.cursor).toBe("");
        fireEvent.keyUp(document.body, { code: "KeyR" });
        expect(document.body.style.cursor).toBe("pointer");
    });

    it("shows the Q41 notice for a trace that logs pre-final names", () => {
        const { container } = render(<CongestionGraphContainer />);
        addFile("old.sqlog", [
            ev(0, "transport:packet_sent", {
                header: { packet_type: "1RTT", packet_number: 0 },
                raw: { length: 1200 },
            }),
        ]);
        expect(container.querySelector(".alert.alert-info")!.textContent).toBe(
            "This trace has no quic:packet_sent events. It logs packets as transport:packet_sent, a pre-standard event name that qvis does not support, so there is nothing to plot.",
        );
        // the graph still renders its (empty) axes, like qvis
        expect(container.querySelector("#mainGraphContainer")).not.toBeNull();
    });

    it("returns to the empty state when the selection is cleared", () => {
        const { container } = render(<CongestionGraphContainer />);
        const group = addFile("server.sqlog", SERVER_EVENTS);
        expect(container.querySelector("#mainGraphContainer")).not.toBeNull();
        act(() => useConnectionStore.getState().removeGroup(group));
        expect(useConfigurationStore.getState().congestionConfig.connection).toBeUndefined();
        expect(container.querySelector("#mainGraphContainer")).toBeNull();
        expect(container.querySelector(".alert")!.textContent).toBe("Please load a trace file to visualize it");
    });
});
