import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify, resetNotificationsForTests } from "@/lib/notify";
import Notifications from "./Notifications";

// vitest blanks CSS imports (even ?raw), so the stylesheet is read from disk; the module name is a variable so the
// app's TypeScript config does not need Node typings.
async function readStylesheet(relative: string): Promise<string> {
    const fsModule = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
    return fs.readFileSync(new URL(relative, import.meta.url), "utf8");
}

function wrappers(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(".vue-notification-wrapper"));
}

function isLeaving(el: HTMLElement): boolean {
    return el.classList.contains("vn-fade-leave-to");
}

beforeEach(() => {
    vi.useFakeTimers();
    resetNotificationsForTests();
});

afterEach(() => {
    vi.useRealTimers();
    resetNotificationsForTests();
});

describe("<Notifications/>", () => {
    it("renders the vue-notification DOM and container placement", () => {
        const { container } = render(<Notifications group="default" position="bottom center" width="50%" />);
        act(() => notify({ group: "default", title: "Loaded files via URL", text: "a", type: "success" }));
        const group = container.querySelector<HTMLElement>(".vue-notification-group")!;
        expect(group.style.width).toBe("50%");
        expect(group.style.bottom).toBe("0px");
        expect(group.style.left).toBe("calc(25%)"); // jsdom simplifies calc(50% - 25%)
        expect(group.getAttribute("aria-live")).toBe("polite");
        const item = container.querySelector(".vue-notification-wrapper > .vue-notification.success")!;
        expect(item.querySelector(".notification-title")!.textContent).toBe("Loaded files via URL");
        expect(item.querySelector(".notification-content")!.textContent).toBe("a");
    });

    it("uses vue-notification's own class names, data-id and inline transition", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ title: "t", text: "a", type: "warn" }));
        const group = container.querySelector<HTMLElement>(".notifications")!;
        expect(group.className).toBe("vue-notification-group notifications");
        const wrapper = group.querySelector<HTMLElement>(":scope > span > .notification-wrapper")!;
        expect(wrapper.getAttribute("data-id")).toMatch(/^\d+$/);
        expect(wrapper.style.transition).toBe("all 300ms");
        expect(wrapper.firstElementChild!.className).toBe("vue-notification-template vue-notification warn");
    });

    it("fades in: `vn-fade-enter` (opacity 0) for the first frames only", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ text: "x" }));
        expect(wrappers(container)[0].classList.contains("vn-fade-enter")).toBe(true);
        act(() => vi.advanceTimersByTime(40)); // two animation frames
        expect(wrappers(container)[0].classList.contains("vn-fade-enter")).toBe(false);
        expect(wrappers(container)[0].style.transition).toBe("all 300ms");
    });

    it("omits the title element when there is no title, and has no type class by default", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ text: "plain" }));
        const item = container.querySelector(".vue-notification")!;
        expect(item.className).toBe("vue-notification-template vue-notification");
        expect(item.querySelector(".notification-title")).toBeNull();
    });

    it("starts leaving at 3600 ms (default) and is removed 300 ms later (inline `transition: all 300ms`)", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ text: "x" }));
        act(() => vi.advanceTimersByTime(3599));
        expect(wrappers(container)).toHaveLength(1);
        expect(isLeaving(wrappers(container)[0])).toBe(false);
        act(() => vi.advanceTimersByTime(1));
        expect(isLeaving(wrappers(container)[0])).toBe(true);
        act(() => vi.advanceTimersByTime(299));
        expect(wrappers(container)).toHaveLength(1);
        act(() => vi.advanceTimersByTime(1));
        expect(wrappers(container)).toHaveLength(0);
    });

    it("slides the shown items up when a new one arrives; a moved item then leaves over .5s", () => {
        // bottom-anchored stack: every item is 80 px high, the newest one is at the bottom
        const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
            this: HTMLElement,
        ) {
            const after = this.classList.contains("notification-wrapper")
                ? Array.from(this.parentElement!.children).length -
                  1 -
                  Array.from(this.parentElement!.children).indexOf(this)
                : 0;
            return new DOMRect(400, 920 - 80 * after, 790, 80);
        });
        const animations: Array<{ el: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions }> = [];
        const proto = HTMLElement.prototype as unknown as { animate?: unknown };
        const originalAnimate = proto.animate;
        proto.animate = function (this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
            animations.push({ el: this, frames, opts });
            return { cancel() {}, onfinish: null } as unknown as Animation;
        };
        try {
            const { container } = render(<Notifications />);
            act(() => notify({ text: "first" }));
            act(() => vi.advanceTimersByTime(100));
            act(() => notify({ text: "second" }));
            expect(animations).toHaveLength(1);
            expect(animations[0].el.textContent).toBe("first");
            expect(animations[0].frames).toEqual([{ transform: "translate(0px,80px)" }, { transform: "none" }]);
            expect(animations[0].opts).toEqual({ duration: 500, easing: "ease" });
            const [first, second] = wrappers(container);
            expect(first.style.transitionDuration).toBe(""); // cleared as by Vue's transition-group
            expect(second.style.transition).toBe("all 300ms");

            act(() => vi.advanceTimersByTime(3500)); // first: 3600 ms after it was added
            expect(isLeaving(first)).toBe(true);
            act(() => vi.advanceTimersByTime(100)); // second starts leaving too
            expect(isLeaving(second)).toBe(true);
            act(() => vi.advanceTimersByTime(300)); // second never moved: 300 ms
            expect(wrappers(container).map((w) => w.textContent)).toEqual(["first"]);
            act(() => vi.advanceTimersByTime(100)); // first moved: 500 ms
            expect(wrappers(container)).toHaveLength(0);
        } finally {
            rect.mockRestore();
            if (originalAnimate === undefined) delete proto.animate;
            else proto.animate = originalAnimate;
        }
    });

    it("uses duration + 600 ms for custom durations (6600 ms for 6000)", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ text: "err", type: "error", duration: 6000 }));
        act(() => vi.advanceTimersByTime(6599));
        expect(isLeaving(wrappers(container)[0])).toBe(false);
        act(() => vi.advanceTimersByTime(1));
        expect(isLeaving(wrappers(container)[0])).toBe(true);
        act(() => vi.advanceTimersByTime(300));
        expect(wrappers(container)).toHaveLength(0);
    });

    it("keeps negative durations (sticky)", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ text: "sticky", duration: -1 }));
        act(() => vi.advanceTimersByTime(60_000));
        expect(wrappers(container)).toHaveLength(1);
    });

    it("dismisses on click", () => {
        const { container } = render(<Notifications />);
        act(() => notify({ text: "click me" }));
        fireEvent.click(screen.getByText("click me"));
        expect(isLeaving(wrappers(container)[0])).toBe(true);
        act(() => vi.advanceTimersByTime(300));
        expect(wrappers(container)).toHaveLength(0);
    });

    it("appends the newest item at the bottom for bottom positions, at the top for top positions", () => {
        const bottom = render(<Notifications />);
        act(() => {
            notify({ text: "first" });
            notify({ text: "second" });
        });
        expect(wrappers(bottom.container).map((w) => w.textContent)).toEqual(["first", "second"]);
        bottom.unmount();

        const top = render(<Notifications position="top right" width={300} />);
        act(() => {
            notify({ text: "first" });
            notify({ text: "second" });
        });
        expect(wrappers(top.container).map((w) => w.textContent)).toEqual(["second", "first"]);
        const group = top.container.querySelector<HTMLElement>(".vue-notification-group")!;
        expect(group.style.top).toBe("0px");
        expect(group.style.right).toBe("0px");
        expect(group.style.width).toBe("300px");
    });

    it("ignores other groups", () => {
        const { container } = render(<Notifications group="default" />);
        act(() => notify({ group: "elsewhere", text: "nope" }));
        expect(wrappers(container)).toHaveLength(0);
    });

    it("shows notifications emitted before it mounted", () => {
        notify({ text: "early bird" });
        render(<Notifications />);
        expect(screen.getByText("early bird")).toBeInTheDocument();
    });

    it("escapes HTML but turns <br/> into line breaks (Q7)", () => {
        const { container } = render(<Notifications />);
        act(() =>
            notify({
                title: "ERROR loading URL <img src=x onerror=alert(1)>",
                text: "File(s) could not be loaded from <b>x</b>.<br/>View the devtools JavaScript console for more information.",
                type: "error",
            }),
        );
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("b")).toBeNull();
        const content = container.querySelector(".notification-content")!;
        expect(content.querySelectorAll("br")).toHaveLength(1);
        expect(content.textContent).toBe(
            "File(s) could not be loaded from <b>x</b>.View the devtools JavaScript console for more information.",
        );
        expect(container.querySelector(".notification-title")!.textContent).toBe(
            "ERROR loading URL <img src=x onerror=alert(1)>",
        );
    });

    it("styles warn and error with black text and the vue-notification palette", async () => {
        const css = (await readStylesheet("./notifications.css")).replace(/\s+/g, " ");
        expect(css).toContain(".vue-notification.warn, .vue-notification.error { color: black; }");
        expect(css).toContain("background: #44a4fc; border-left: 5px solid #187fe7;");
        expect(css).toContain(".vue-notification.warn { background: #ffb648; border-left-color: #f48a06; }");
        expect(css).toContain(".vue-notification.error { background: #e54d42; border-left-color: #b82e24; }");
        expect(css).toContain(".vue-notification.success { background: #68cd86; border-left-color: #42a85f; }");
        expect(css).toContain(".vue-notification-group { display: block; position: fixed; z-index: 5000; }");
        expect(css).toContain(".vn-fade-enter-active, .vn-fade-leave-active, .vn-fade-move { transition: all 0.5s; }");
        expect(css).toContain(".vn-fade-enter, .vn-fade-leave-to { opacity: 0; }");
    });
});
