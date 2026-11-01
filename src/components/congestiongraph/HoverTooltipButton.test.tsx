// HoverTooltipButton / useHoverTooltip (jsdom): BootstrapVue `v-b-tooltip.hover` timing (50ms show / hide delay, then a frame), so a
// quick sweep over the buttons shows no tooltip. Placement and look are checked in the browser (congestion.spec.ts).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { HOVER_DELAY_MS } from "@/components/shared/HoverTooltip";
import HoverTooltipButton from "./HoverTooltipButton";

const TITLE = "Click this button, then drag and drop a rectangular area to zoom in on.";

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    });
});
afterEach(() => vi.useRealTimers());

function advance(ms: number): void {
    act(() => {
        vi.advanceTimersByTime(ms);
    });
}

describe("<HoverTooltipButton/>", () => {
    it("shows the tooltip 50ms (+ a frame) after mouseenter and hides it 50ms (+ a frame) after mouseleave", () => {
        const onClick = vi.fn();
        render(
            <HoverTooltipButton title={TITLE} onClick={onClick}>
                Zoom area
            </HoverTooltipButton>,
        );
        const button = screen.getByRole("button", { name: "Zoom area" });
        expect(HOVER_DELAY_MS).toBe(50);

        fireEvent.mouseEnter(button);
        advance(HOVER_DELAY_MS - 1);
        expect(screen.queryByRole("tooltip")).toBeNull();
        advance(1 + 20);
        expect(screen.getByRole("tooltip")).toHaveTextContent(TITLE);
        expect(button).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);

        // re-entering while the hide delay runs keeps it open
        fireEvent.mouseLeave(button);
        advance(20);
        fireEvent.mouseEnter(button);
        advance(200);
        expect(screen.getByRole("tooltip")).toBeInTheDocument();

        fireEvent.mouseLeave(button);
        advance(HOVER_DELAY_MS - 1);
        expect(button).toHaveAttribute("aria-describedby");
        advance(1 + 20); // then the 150ms fade-out runs (transition events, browser only)
        expect(button.getAttribute("aria-describedby") ?? "").toBe(""); // the popper may leave an empty attribute

        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("a sweep shorter than the delay shows nothing; buttons without a title never show one", () => {
        render(
            <>
                <HoverTooltipButton title={TITLE} onClick={() => {}}>
                    Zoom area
                </HoverTooltipButton>
                <HoverTooltipButton onClick={() => {}}>Reset zoom</HoverTooltipButton>
            </>,
        );
        const zoom = screen.getByRole("button", { name: "Zoom area" });
        fireEvent.mouseEnter(zoom);
        advance(30);
        fireEvent.mouseLeave(zoom);
        advance(500);
        expect(screen.queryByRole("tooltip")).toBeNull();

        const reset = screen.getByRole("button", { name: "Reset zoom" });
        fireEvent.mouseEnter(reset);
        advance(500);
        expect(screen.queryByRole("tooltip")).toBeNull();
        expect(reset).not.toHaveAttribute("aria-describedby");
    });
});
