import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelEvents } from "@/model/modelEvents";
import { makeGroup } from "@/components/shared/__fixtures__/fakeModel";
import { resetMockConnectionStore, useConnectionStore } from "@/components/shared/__fixtures__/mockConnectionStore";
import { isExtendedConversion, setExtendedConversion } from "@/loading/fileLoader";
import { QlogLoader } from "@/model/QlogLoader";
import DebugPage from "./DebugPage";

vi.mock("@/store/connectionStore", () => import("@/components/shared/__fixtures__/mockConnectionStore"));

let unsubscribe: () => void = () => {};

beforeEach(() => {
    resetMockConnectionStore();
    // mirror the real store: in-place model changes bump the revision
    unsubscribe = modelEvents.on(() => useConnectionStore.setState((s) => ({ revision: s.revision + 1 })));
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
});

function eventRows(): string[] {
    return screen.queryAllByText(/^- Event: ROBIN : /).map((el) => el.textContent ?? "");
}

describe("DebugPage (#/debug)", () => {
    it("renders the heading and the five buttons separated by ' | '", () => {
        const { container } = render(<DebugPage />);
        expect(container.querySelector("#VUEDebug.home > .hello > h1")!.textContent).toBe(
            "This is the VUE debugger to test reactive data coupling",
        );
        const buttons = Array.from(container.querySelectorAll(".home > button")).map((b) => b.textContent);
        expect(buttons).toEqual([
            "Add new random ConnectionGroup",
            "Delete First",
            "Change Connection Name",
            "Change Event Name",
            "RemoveEvent",
        ]);
        expect(container.querySelector(".home > button")!.className).toBe("btn btn-secondary");
        expect(container.querySelector(".home")!.textContent).toContain(
            "Add new random ConnectionGroup | Delete First | ",
        );
    });

    it("adds three random files to the store when at most one is loaded (Q21, preserved)", () => {
        render(<DebugPage />);
        const groups = useConnectionStore.getState().groups;
        expect(groups).toHaveLength(3);
        for (const g of groups) {
            expect(g.filename).toBe("");
            expect(g.description).toMatch(/^RandomConnectionGroup \d+$/);
            const conns = g.getConnections();
            expect(conns.length).toBeGreaterThanOrEqual(1);
            expect(conns.length).toBeLessThanOrEqual(6);
            conns.forEach((c, i) => {
                expect(c.title).toBe("Connection " + i);
                expect(c.getLongName()).toBe("unknown (flow = unknown) : Connection " + i);
                expect(c.getEvents().length).toBeLessThanOrEqual(3);
            });
        }
        for (const g of groups) {
            expect(screen.getAllByText(g.description).length).toBeGreaterThanOrEqual(1);
        }
        // event rows of the LAST group only
        const last = groups[groups.length - 1];
        const expected = last
            .getConnections()
            .flatMap((c, i) =>
                c
                    .getEvents()
                    .map((_, j) => "- Event: ROBIN : Connection " + i + " : Connection #" + i + " - Event #" + j),
            );
        expect(eventRows()).toEqual(expected);
    });

    it("lists the event type (the name after the first colon), as qvis's parseEvent(event).name (§9.4)", () => {
        const real = QlogLoader.fromJSON({
            root: {
                file_schema: "urn:ietf:params:qlog:file:contained",
                serialization_format: "application/qlog+json",
                traces: [
                    {
                        title: "client trace",
                        vantage_point: { type: "client" },
                        events: [
                            { time: 0, name: "quic:packet_sent", data: {} },
                            { time: 1, name: "http3:frame_created", data: {} },
                            { time: 2, name: "mvfst:a:b", data: {} },
                        ],
                    },
                ],
            },
            serialization: "json",
            diagnostics: [],
        })!;
        useConnectionStore.setState({ groups: [makeGroup("a.qlog", []), real] });
        render(<DebugPage />);
        expect(eventRows()).toEqual([
            "- Event: ROBIN : client trace : packet_sent",
            "- Event: ROBIN : client trace : frame_created",
            "- Event: ROBIN : client trace : a:b",
        ]);
        act(() => {
            fireEvent.click(screen.getByText("Change Event Name"));
        });
        fireEvent.click(screen.getByText("Change Connection Name")); // an unrelated re-render shows the new name
        expect(eventRows()[0]).toBe("- Event: ROBIN : Connection name was changed : Event was changed");
        expect(real.getConnections()[0].getEvents()[0].loggedName).toBe("quic:Event was changed");
    });

    it("builds the random files in latest-draft shape without loader diagnostics (§9.7)", () => {
        const warn = vi.spyOn(console, "warn");
        const info = vi.spyOn(console, "info");
        render(<DebugPage />);
        expect(warn).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        const ev = useConnectionStore.getState().groups.at(-1)!.getConnections()[0].getEvents()[0];
        expect(ev.loggedName).toBe("testcat:Connection #0 - Event #0");
        expect(ev.type).toBe("Connection #0 - Event #0");
        expect(ev.data).toEqual({ dummy: true, trigger: "dummytrigger" });
    });

    it("does not add random files when two or more are already loaded", () => {
        useConnectionStore.setState({ groups: [makeGroup("a.qlog", []), makeGroup("b.qlog", [])] });
        render(<DebugPage />);
        expect(useConnectionStore.getState().groups).toHaveLength(2);
    });

    it("adds and deletes files with the buttons", () => {
        render(<DebugPage />);
        fireEvent.click(screen.getByText("Add new random ConnectionGroup"));
        expect(useConnectionStore.getState().groups).toHaveLength(4);
        const second = useConnectionStore.getState().groups[1];
        fireEvent.click(screen.getByText("Delete First"));
        expect(useConnectionStore.getState().groups).toHaveLength(3);
        expect(useConnectionStore.getState().groups[0]).toBe(second);
    });

    it("renames the first connection of the last file reactively", () => {
        render(<DebugPage />);
        fireEvent.click(screen.getByText("Change Connection Name"));
        const last = useConnectionStore.getState().groups.at(-1)!;
        expect(last.getConnections()[0].title).toBe("Connection name was changed");
        expect(eventRows()[0]).toMatch(/^- Event: ROBIN : Connection name was changed : /);
    });

    it("changes the first event name without re-rendering (not reactive, as in qvis)", () => {
        render(<DebugPage />);
        const before = eventRows();
        act(() => {
            fireEvent.click(screen.getByText("Change Event Name"));
        });
        const last = useConnectionStore.getState().groups.at(-1)!;
        expect(last.getConnections()[0].getEvents()[0].loggedName).toBe("testcat:Event was changed");
        expect(eventRows()).toEqual(before);
    });

    it("removes the last event of the first connection", () => {
        render(<DebugPage />);
        const first = useConnectionStore.getState().groups.at(-1)!.getConnections()[0];
        const count = first.getEvents().length;
        fireEvent.click(screen.getByText("RemoveEvent"));
        expect(first.getEvents().length).toBe(count - 1);
    });

    it("'Convert with extended mappings' switches the converters' T3 tier (converters C2)", () => {
        setExtendedConversion(false);
        render(<DebugPage />);
        const box = screen.getByLabelText("Convert with extended mappings") as HTMLInputElement;
        expect(box.checked).toBe(false);
        fireEvent.click(box);
        expect(box.checked).toBe(true);
        expect(isExtendedConversion()).toBe(true);
        fireEvent.click(box);
        expect(isExtendedConversion()).toBe(false);
    });
});
