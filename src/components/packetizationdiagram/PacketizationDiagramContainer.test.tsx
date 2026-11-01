import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { notify } from "@/lib/notify";
import { useConfigurationStore } from "@/store/configurationStore";
import { resetMockConnectionStore, useConnectionStore } from "@/components/shared/__fixtures__/mockConnectionStore";
import { connectionFromEvents, ev } from "./__fixtures__/build";
import PacketizationDiagramContainer from "./PacketizationDiagramContainer";
import { N_PZ1 } from "./notifications";

vi.mock("@/store/connectionStore", () => import("@/components/shared/__fixtures__/mockConnectionStore"));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const packet = (pn: number) =>
    ev("quic:packet_sent", {
        header: { packet_type: "1RTT", packet_number: pn },
        raw: { length: 60, payload_length: 22 },
        frames: [{ frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 20 } }],
    });

describe("PacketizationDiagramContainer", () => {
    beforeEach(() => {
        resetMockConnectionStore();
        useConfigurationStore.getState().reset();
        vi.mocked(notify).mockClear();
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1600);
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it("without files: intro text, danger alert, empty 200px diagram blocks and the tooltip div", () => {
        const { container } = render(<PacketizationDiagramContainer />);
        expect(
            screen.getByText("Select a trace via the dropdown(s) below to visualize it in the packetization diagram"),
        ).toBeInTheDocument();
        expect(screen.getByText("Please load a trace file to visualize it")).toHaveClass("alert", "alert-danger");
        expect(container.querySelector(".home")).not.toBeNull();
        const top = container.querySelector<HTMLElement>("#packetization-diagram-top")!;
        expect(top.style.minHeight).toBe("200px");
        expect(top.style.width).toBe("100%");
        expect(top.children).toHaveLength(0);
        expect(container.querySelector("#packetization-diagram-bottom")).not.toBeNull();
        expect(container.querySelector("#packetization-packet-tooltip")).not.toBeNull();
        expect(container.querySelector("select")).toBeNull();
        expect(screen.getByRole("button", { name: "More info on this tool" })).toHaveStyle({ width: "25%" });
    });

    it("loading state shows the warning alert", () => {
        useConnectionStore.setState({ outstandingRequestCount: 1 });
        render(<PacketizationDiagramContainer />);
        expect(screen.getByText("Loading files...")).toHaveClass("alert-warning");
    });

    it("auto-selects the first trace of the first file and renders both diagrams", async () => {
        const conn = connectionFromEvents([packet(1)]);
        act(() => useConnectionStore.getState().addGroup(conn.parent));
        const { container } = render(<PacketizationDiagramContainer />);
        await waitFor(() => expect(useConfigurationStore.getState().packetizationConfig.connections).toEqual([conn]));
        expect(container.querySelector("select")).not.toBeNull();
        await waitFor(() => expect(container.querySelector("#packetization-diagram-bottom svg")).not.toBeNull());
        expect(container.querySelector("#packetization-diagram-top svg")).not.toBeNull();
        expect(container.querySelectorAll("#packetization-diagram-bottom rect.quicpacket")).toHaveLength(3);
        expect(container.querySelector("#packetization-diagram-top .packetization-empty-note")?.textContent).toBe(
            "No quic:packet_received events found for this direction",
        );
        expect(notify).not.toHaveBeenCalled();

        // loading another file does not change the selection
        const other = connectionFromEvents([packet(2)]);
        act(() => useConnectionStore.getState().addGroup(other.parent));
        expect(useConfigurationStore.getState().packetizationConfig.connections).toEqual([conn]);

        // E23: a scrubbed selection clears the diagrams, then the auto-selection picks the remaining file
        act(() => {
            useConnectionStore.getState().removeGroup(conn.parent);
            useConfigurationStore.getState().scrub(conn.parent);
        });
        await waitFor(() => expect(useConfigurationStore.getState().packetizationConfig.connections).toEqual([other]));
    });

    it("info modal: opens on every click (Q-M1 fix), closes with Close and ×", async () => {
        render(<PacketizationDiagramContainer />);
        const open = screen.getByRole("button", { name: "More info on this tool" });
        fireEvent.click(open);
        expect(await screen.findByText("PacketizationDiagram info")).toBeInTheDocument();
        expect(screen.getByText("How to test?").tagName).toBe("H2");
        expect(screen.getByText("DEMO_10_parallel_streams").tagName).toBe("B");
        expect(
            screen.getByText("quic:packet_sent/quic:packet_received : raw : length (and raw : payload_length)").tagName,
        ).toBe("LI");
        expect(document.querySelector(".modal-dialog")).toHaveClass("modal-xl");

        fireEvent.click(screen.getByText("Close", { selector: "button" }));
        await waitFor(() => expect(screen.queryByText("PacketizationDiagram info")).toBeNull());

        fireEvent.click(open);
        expect(await screen.findByText("PacketizationDiagram info")).toBeInTheDocument();
        fireEvent.click(screen.getByText("×", { selector: "button.close" }));
        await waitFor(() => expect(screen.queryByText("PacketizationDiagram info")).toBeNull());
    });

    it("N-PZ1 for traces with more than 10000 events, then renders after 200ms", async () => {
        vi.useFakeTimers();
        try {
            const events = [packet(0)];
            for (let i = 0; i < 10001; i++) events.push(ev("quic:recovery_metrics_updated", { congestion_window: i }));
            const conn = connectionFromEvents(events);
            useConnectionStore.getState().addGroup(conn.parent);
            useConfigurationStore.getState().update("packetizationConfig", { connections: [conn] });
            const { container } = render(<PacketizationDiagramContainer />);
            expect(notify).toHaveBeenCalledTimes(1);
            expect(notify).toHaveBeenCalledWith({ ...N_PZ1 });
            expect(container.querySelector("#packetization-diagram-bottom svg")).toBeNull();
            act(() => {
                vi.advanceTimersByTime(200);
            });
            expect(container.querySelector("#packetization-diagram-bottom svg")).not.toBeNull();

            // qvis warns on every selection change to a large trace, also when coming back to it
            const small = connectionFromEvents([packet(1)]);
            act(() => useConfigurationStore.getState().update("packetizationConfig", { connections: [small] }));
            expect(notify).toHaveBeenCalledTimes(1);
            act(() => useConfigurationStore.getState().update("packetizationConfig", { connections: [conn] }));
            expect(notify).toHaveBeenCalledTimes(2);
            act(() => {
                vi.advanceTimersByTime(200);
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("info modal root carries qvis' id (b-modal id=info-modal)", async () => {
        render(<PacketizationDiagramContainer />);
        fireEvent.click(screen.getByRole("button", { name: "More info on this tool" }));
        expect(await screen.findByText("PacketizationDiagram info")).toBeInTheDocument();
        const root = document.getElementById("info-modal");
        expect(root).toHaveClass("modal", "packetization-info-modal");
        expect(root?.querySelector(".modal-dialog")).toHaveClass("modal-xl");
    });
});
