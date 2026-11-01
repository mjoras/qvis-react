import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { addConnection, conn, makeGroup } from "./__fixtures__/fakeModel";
import { resetMockConnectionStore, useConnectionStore } from "./__fixtures__/mockConnectionStore";
import ConnectionConfigurator, { MAX_COMBINED_OPTIONS } from "./ConnectionConfigurator";

vi.mock("@/store/connectionStore", () => import("./__fixtures__/mockConnectionStore"));

function selects(container: HTMLElement): HTMLSelectElement[] {
    return Array.from(container.querySelectorAll("select"));
}

function optionTexts(select: HTMLSelectElement): string[] {
    return Array.from(select.options)
        .filter((o) => !o.hidden)
        .map((o) => o.textContent ?? "");
}

function selectedText(select: HTMLSelectElement): string {
    const o = select.options[select.selectedIndex];
    return o && !o.hidden ? (o.textContent ?? "") : "";
}

/** `n` files with `perFile` traces each. */
function files(n: number, perFile: number): QlogConnectionGroup[] {
    return Array.from({ length: n }, (_, i) =>
        makeGroup(
            "f" + i + ".qlog",
            Array.from({ length: perFile }, (_, j) => ({ title: "T" + j, vantagePoint: { type: "client" } })),
            { description: "d" + i },
        ),
    );
}

beforeEach(() => resetMockConnectionStore());

describe("mode C: combined select", () => {
    it("renders the header label, disabled file headers and ↳ connection rows", () => {
        const a = makeGroup(
            "a.qlog",
            [{ title: "Connection 1", vantagePoint: { name: "TODO", type: "network", flow: "client" } }],
            {
                description: "",
            },
        );
        const b = makeGroup("b.qlog", [
            { title: "x", vantagePoint: { type: "server" } },
            { title: "y", description: "d", vantagePoint: { type: "client" } },
        ]);
        const { container } = render(
            <ConnectionConfigurator connection={conn(a, 0)} allGroups={[a, b]} canBeRemoved={false} />,
        );

        const frame = container.firstElementChild as HTMLElement;
        expect(frame.className).toBe("col");
        expect(frame.getAttribute("style")).toBe(
            "background-color: white; color: black; border: 1px solid black; max-width: 50%;",
        );
        expect(
            container.querySelector(".col > .container-fluid > div > div > .row.mt-3 > .col > div")!.textContent,
        ).toBe("a.qlog ()");

        const [select] = selects(container);
        expect(select.className).toBe("form-select");
        expect(optionTexts(select)).toEqual([
            "a.qlog",
            "↳ TODO : network (flow = client) : Connection 1",
            "b.qlog",
            "↳ server : x",
            "↳ client : y : d",
        ]);
        expect(Array.from(select.options).map((o) => o.disabled)).toEqual([true, false, true, false, false]);
        expect(selectedText(select)).toBe("↳ TODO : network (flow = client) : Connection 1");
        expect(screen.queryByText("−")).toBeNull();
    });

    it("calls onConnectionSelected with the picked connection and stays controlled", () => {
        const g = makeGroup("a.qlog", [{ title: "one" }, { title: "two" }]);
        const onConnectionSelected = vi.fn();
        const { container } = render(
            <ConnectionConfigurator
                connection={conn(g, 0)}
                allGroups={[g]}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        const [select] = selects(container);
        fireEvent.change(select, { target: { value: "c:0:1" } });
        expect(onConnectionSelected).toHaveBeenCalledTimes(1);
        expect(onConnectionSelected.mock.calls[0][0]).toBe(conn(g, 1));
        // the parent did not update the prop, so the select snaps back
        expect(selectedText(select)).toContain("one");
    });

    it("matches the selection by identity when the same file is loaded twice", () => {
        const traces = [{ title: "same", vantagePoint: { type: "client" } }];
        const first = makeGroup("same.qlog", traces);
        const second = makeGroup("same.qlog", traces);
        const onConnectionSelected = vi.fn();
        const { container, rerender } = render(
            <ConnectionConfigurator
                connection={conn(second, 0)}
                allGroups={[first, second]}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        const [select] = selects(container);
        expect(select.value).toBe("c:1:0");
        fireEvent.change(select, { target: { value: "c:0:0" } });
        expect(onConnectionSelected.mock.calls[0][0]).toBe(conn(first, 0));
        expect(onConnectionSelected.mock.calls[0][0]).not.toBe(conn(second, 0));
        rerender(
            <ConnectionConfigurator
                connection={conn(first, 0)}
                allGroups={[first, second]}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        expect(select.value).toBe("c:0:0");
    });

    it("shows a blank selection for a connection that is no longer loaded", () => {
        const removed = makeGroup("gone.qlog", [{ title: "old" }]);
        const kept = makeGroup("kept.qlog", [{ title: "new" }]);
        const { container } = render(<ConnectionConfigurator connection={conn(removed, 0)} allGroups={[kept]} />);
        const [select] = selects(container);
        expect(select.value).toBe("");
        expect(selectedText(select)).toBe("");
        expect(container.querySelector(".row.mt-3 .col > div")!.textContent).toBe("gone.qlog ()");
    });

    it("shows the remove button by default and calls onRemoved", () => {
        const g = makeGroup("a.qlog", [{ title: "one" }]);
        const onRemoved = vi.fn();
        const { container } = render(
            <ConnectionConfigurator connection={conn(g, 0)} allGroups={[g]} onRemoved={onRemoved} />,
        );
        const button = screen.getByText("−");
        expect(button.className).toBe("btn btn-secondary");
        expect(button.parentElement!.className).toBe("col-auto px-0");
        expect(container.querySelector(".row.mt-3 > .col[style]")!.getAttribute("style")).toBe("max-width: 36px;");
        fireEvent.click(button);
        expect(onRemoved).toHaveBeenCalledTimes(1);
    });

    it("re-renders when the model changes in place (connection store revision)", () => {
        const g = makeGroup("a.qlog", [{ title: "T", vantagePoint: { type: "client" } }]);
        const { container } = render(<ConnectionConfigurator connection={conn(g, 0)} allGroups={[g]} />);
        expect(optionTexts(selects(container)[0])).toHaveLength(2);
        addConnection(g, {
            title: "Simulated, autogenerated trace : T",
            description: "Simulated, autogenerated trace : ",
            vantagePoint: { name: "GENERATED", type: "server", flow: "unknown" },
        });
        act(() => useConnectionStore.setState({ revision: useConnectionStore.getState().revision + 1 }));
        expect(optionTexts(selects(container)[0])[2]).toBe(
            "↳ GENERATED : server (flow = unknown) : Simulated, autogenerated trace : T : Simulated, autogenerated trace : ",
        );
    });
});

describe("numeric input (latency offset)", () => {
    function setup(value = 0) {
        const g = makeGroup("a.qlog", [{ title: "one" }, { title: "two" }]);
        const onNumericalValueChanged = vi.fn();
        const utils = render(
            <ConnectionConfigurator
                connection={conn(g, 0)}
                allGroups={[g]}
                numericalInputName="Latency offset"
                numericalInputValue={value}
                onNumericalValueChanged={onNumericalValueChanged}
            />,
        );
        const input = utils.container.querySelector<HTMLInputElement>("input[type=number]")!;
        return { ...utils, g, input, onNumericalValueChanged };
    }

    it("renders the header and the initial value", () => {
        const { input } = setup(12.5);
        expect(screen.getByText("Latency offset :")).toBeInTheDocument();
        expect(screen.getByText("Latency offset :").parentElement!.className).toBe("col-2");
        expect(input.className).toBe("form-control");
        expect(input.value).toBe("12.5");
    });

    it("fires on the native change event only, with parseFloat", () => {
        const { input, onNumericalValueChanged } = setup();
        fireEvent.input(input, { target: { value: "7" } });
        expect(input.value).toBe("7");
        expect(onNumericalValueChanged).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { value: "42.25" } });
        expect(onNumericalValueChanged).toHaveBeenCalledWith(42.25);
    });

    it("ignores non-numeric values (Q15)", () => {
        const { input, onNumericalValueChanged } = setup();
        fireEvent.change(input, { target: { value: "" } });
        expect(onNumericalValueChanged).not.toHaveBeenCalled();
    });

    it("resets the draft when the selected connection changes", () => {
        const { input, g, rerender, onNumericalValueChanged } = setup(3);
        fireEvent.input(input, { target: { value: "99" } });
        rerender(
            <ConnectionConfigurator
                connection={conn(g, 1)}
                allGroups={[g]}
                numericalInputName="Latency offset"
                numericalInputValue={5}
                onNumericalValueChanged={onNumericalValueChanged}
            />,
        );
        expect(input.value).toBe("5");
    });

    it("shows the hover tooltip text (BootstrapVue v-b-tooltip.hover look: shared .qvis-tooltip)", async () => {
        setup();
        const label = screen.getByText("Latency offset :");
        fireEvent.mouseOver(label);
        // BootstrapVue's 50ms show delay: nothing yet
        expect(screen.queryByRole("tooltip")).toBeNull();
        expect(
            await screen.findByText("This value is automatically calculated, but can be manually adjusted."),
        ).toBeInTheDocument();
        const tip = screen.getByRole("tooltip");
        expect(tip).toHaveClass("tooltip", "qvis-tooltip");
        expect(label).toHaveAttribute("aria-describedby", tip.id);
        // the label is one text node, like Vue's `{{numericalInputName}} : `
        expect(label.childNodes).toHaveLength(1);
    });
});

describe("mode switching at 30 options", () => {
    it(`stays combined at exactly ${MAX_COMBINED_OPTIONS} options`, () => {
        const groups = files(5, 5); // 5 * (1 + 5) = 30
        const { container } = render(<ConnectionConfigurator connection={conn(groups[0], 0)} allGroups={groups} />);
        expect(selects(container)).toHaveLength(1);
        expect(optionTexts(selects(container)[0])).toHaveLength(30);
    });

    it("switches to separate selects at 31 options, without the header label", () => {
        const groups = [...files(5, 5), makeGroup("extra.qlog", [])]; // 31
        const { container } = render(
            <ConnectionConfigurator connection={conn(groups[1], 2)} allGroups={groups} canBeRemoved={false} />,
        );
        const [groupSelect, connSelect] = selects(container);
        expect(selects(container)).toHaveLength(2);
        expect(groupSelect.className).toBe("form-select mb-3 mt-3");
        expect(optionTexts(groupSelect)).toEqual([
            "f0.qlog (d0)",
            "f1.qlog (d1)",
            "f2.qlog (d2)",
            "f3.qlog (d3)",
            "f4.qlog (d4)",
            "extra.qlog ()",
        ]);
        expect(selectedText(groupSelect)).toBe("f1.qlog (d1)");
        expect(optionTexts(connSelect)).toEqual([
            "client : T0",
            "client : T1",
            "client : T2",
            "client : T3",
            "client : T4",
        ]);
        expect(selectedText(connSelect)).toBe("client : T2");
        expect(container.querySelector(".row.mt-3")).toBeNull();
    });

    it("flips a mounted selector from combined to separate when more files are loaded", () => {
        const groups = files(5, 5);
        const { container, rerender } = render(
            <ConnectionConfigurator connection={conn(groups[0], 0)} allGroups={groups} />,
        );
        expect(selects(container)).toHaveLength(1);
        rerender(
            <ConnectionConfigurator connection={conn(groups[0], 0)} allGroups={[...groups, makeGroup("x.qlog", [])]} />,
        );
        expect(selects(container)).toHaveLength(2);
    });

    it("selects and propagates the first trace of a newly chosen file", () => {
        const groups = [...files(5, 5), makeGroup("extra.qlog", [])];
        const onConnectionSelected = vi.fn();
        const { container } = render(
            <ConnectionConfigurator
                connection={conn(groups[0], 0)}
                allGroups={groups}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        fireEvent.change(selects(container)[0], { target: { value: "g:3" } });
        expect(onConnectionSelected).toHaveBeenCalledTimes(1);
        expect(onConnectionSelected.mock.calls[0][0]).toBe(conn(groups[3], 0));
    });

    it("keeps the previous selection when the chosen file has no traces (Q12)", () => {
        const groups = [...files(5, 5), makeGroup("extra.qlog", [])];
        const onConnectionSelected = vi.fn();
        const { container } = render(
            <ConnectionConfigurator
                connection={conn(groups[0], 0)}
                allGroups={groups}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        fireEvent.change(selects(container)[0], { target: { value: "g:5" } });
        expect(onConnectionSelected).not.toHaveBeenCalled();
        expect(selectedText(selects(container)[0])).toBe("f0.qlog (d0)");
    });

    it("renders the latency input and remove button in separate mode too (Q9)", () => {
        const groups = [...files(5, 5), makeGroup("extra.qlog", [])];
        const onNumericalValueChanged = vi.fn();
        const onRemoved = vi.fn();
        const { container } = render(
            <ConnectionConfigurator
                connection={conn(groups[0], 0)}
                allGroups={groups}
                numericalInputName="Latency offset"
                numericalInputValue={1}
                onNumericalValueChanged={onNumericalValueChanged}
                onRemoved={onRemoved}
            />,
        );
        const input = container.querySelector<HTMLInputElement>("input[type=number]")!;
        fireEvent.change(input, { target: { value: "2" } });
        expect(onNumericalValueChanged).toHaveBeenCalledWith(2);
        fireEvent.click(screen.getByText("−"));
        expect(onRemoved).toHaveBeenCalled();
        expect(screen.getByText("Latency offset :")).toBeInTheDocument();
    });

    it("propagates a connection picked in the second select", () => {
        const groups = [...files(5, 5), makeGroup("extra.qlog", [])];
        const onConnectionSelected = vi.fn();
        const { container } = render(
            <ConnectionConfigurator
                connection={conn(groups[2], 0)}
                allGroups={groups}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        fireEvent.change(selects(container)[1], { target: { value: "bc:4" } });
        expect(onConnectionSelected.mock.calls[0][0]).toBe(conn(groups[2], 4));
    });
});

describe("mode A: group-only (statistics)", () => {
    it("renders one group select and calls onGroupSelected with the NEW group (Q8)", () => {
        const a = makeGroup("a.qlog", [{ title: "x" }], { title: "My title", description: "My description" });
        const b = makeGroup("b.qlog", [{ title: "y" }]);
        const onGroupSelected = vi.fn();
        const onConnectionSelected = vi.fn();
        const { container } = render(
            <ConnectionConfigurator
                group={a}
                allGroups={[a, b]}
                canBeRemoved={false}
                allowGroupSelection={true}
                allowConnectionSelection={false}
                onGroupSelected={onGroupSelected}
                onConnectionSelected={onConnectionSelected}
            />,
        );
        const [select] = selects(container);
        expect(selects(container)).toHaveLength(1);
        expect(select.className).toBe("form-select mb-3 mt-3");
        expect(optionTexts(select)).toEqual(["a.qlog (My title : My description)", "b.qlog ()"]);
        expect(selectedText(select)).toBe("a.qlog (My title : My description)");
        fireEvent.change(select, { target: { value: "g:1" } });
        expect(onGroupSelected).toHaveBeenCalledWith(b);
        expect(onConnectionSelected).not.toHaveBeenCalled();
        expect(screen.queryByText("−")).toBeNull();
    });

    it("stays in group-only mode with many options", () => {
        const groups = files(10, 5);
        const { container } = render(
            <ConnectionConfigurator
                group={groups[9]}
                allGroups={groups}
                allowGroupSelection={true}
                allowConnectionSelection={false}
            />,
        );
        expect(selects(container)).toHaveLength(1);
        expect(selectedText(selects(container)[0])).toBe("f9.qlog (d9)");
    });
});

describe("typing", () => {
    it("accepts the real model types", () => {
        // compile-time check: the callbacks receive model instances
        const handler = (c: QlogConnection) => c.parent;
        const g = makeGroup("a.qlog", [{ title: "one" }]);
        render(<ConnectionConfigurator connection={conn(g, 0)} allGroups={[g]} onConnectionSelected={handler} />);
        expect(true).toBe(true);
    });
});
