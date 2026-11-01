// Toast container replacing vue-notification 1.3.16's <notifications group="default" position="bottom center"
// width="50%"/> (parity/app-shell.md §2.6, §3.6, §8.4).
//
// - DOM and classes as rendered by vue-notification (`.notifications > span > .notification-wrapper[data-id] >
//   .vue-notification-template.vue-notification.<type>`), plus our own `vue-notification-group` /
//   `vue-notification-wrapper` class names.
// - lifetime: an item starts leaving after `duration + 2 * speed` ms (3600 ms default, 6600 ms for 6000); negative
//   durations are sticky. Clicking an item dismisses it immediately.
// - transitions (CSS mode of vue-notification, a Vue <transition-group name="vn-fade">): every wrapper carries the
//   inline style `transition: all <speed>ms`, so an item fades in over 300 ms. When a new item is added, the items
//   already shown slide to their new place over 500 ms (FLIP "move", `.vn-fade-move { transition: all .5s }`); Vue
//   clears the inline transition-duration of a moved item, so from then on the class durations apply to it. A leaving
//   item therefore fades out over 300 ms, or over 500 ms once it has moved, and is removed from the DOM afterwards;
//   the remaining items then jump to their new place (no move on removal, as in Vue).
// - bottom positions grow bottom-to-top: new items are appended, so the newest is lowest.
// - title/text are rendered as escaped text; only `<br/>` / `<br>` become line breaks (Q7 fix).

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
    DEFAULT_NOTIFICATION_GROUP,
    splitNotificationLines,
    subscribeNotifications,
    type NotificationItem,
} from "@/lib/notify";
import "./notifications.css";

/** vue-notification `speed` default (ms): inline `transition: all <speed>ms`; lifetime = duration + 2 * speed. */
export const NOTIFICATION_SPEED = 300;
/** `.vn-fade-enter-active, .vn-fade-leave-active, .vn-fade-move { transition: all .5s }` */
export const NOTIFICATION_CLASS_TRANSITION_MS = 500;

export interface NotificationsProps {
    group?: string;
    /** "<top|bottom> <left|center|right>" in either order (vue-notification syntax). */
    position?: string;
    /** CSS width: a number (px) or a "50%" / "300px" string. */
    width?: number | string;
}

interface Entry {
    item: NotificationItem;
    /** epoch ms at which the item starts leaving (Infinity = sticky) */
    leaveAt: number;
    /** epoch ms at which a leaving item is removed (undefined while visible) */
    removeAt?: number;
    /** false for the first frame (class `vn-fade-enter`, opacity 0), then the inline transition fades it in */
    entered: boolean;
}

/** Vue's transition-group clears a moved element's inline transition-duration: the class durations apply from then on. */
function clearTransitionDuration(el: HTMLElement): void {
    el.style.transitionDuration = "";
}

/** vue-notification's inline wrapper style (`notifyWrapperStyle`). Constant, so React never re-applies it. */
const WRAPPER_STYLE: CSSProperties = { transition: `all ${NOTIFICATION_SPEED}ms` };

function parsePosition(position: string): { y: "top" | "bottom"; x: "left" | "center" | "right" } {
    const parts = position.split(/\s+/);
    const y = parts.includes("bottom") ? "bottom" : "top";
    const x = parts.includes("left") ? "left" : parts.includes("right") ? "right" : "center";
    return { y, x };
}

function parseWidth(width: number | string): { value: number; unit: string } {
    if (typeof width === "number") {
        return { value: width, unit: "px" };
    }
    const m = /^\s*(-?[\d.]+)\s*(%|px)?\s*$/.exec(width);
    if (!m) {
        return { value: 300, unit: "px" };
    }
    return { value: parseFloat(m[1]), unit: m[2] ?? "px" };
}

function groupStyle(position: string, width: number | string): CSSProperties {
    const { x, y } = parsePosition(position);
    const w = parseWidth(width);
    const style: CSSProperties = { width: w.value + w.unit, [y]: "0px" };
    if (x === "center") {
        style.left = `calc(50% - ${w.value / 2}${w.unit})`;
    } else {
        style[x] = "0px";
    }
    return style;
}

/** Vue's `nextFrame`: two animation frames, so the start state has been rendered before the change. */
function nextFrame(fn: () => void): () => void {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(fn);
    });
    return () => {
        cancelAnimationFrame(outer);
        if (inner) cancelAnimationFrame(inner);
    };
}

function Lines({ text }: { text: string }) {
    const lines = splitNotificationLines(text);
    return (
        <>
            {lines.map((line, i) => (
                <Fragment key={i}>
                    {i > 0 && <br />}
                    {line}
                </Fragment>
            ))}
        </>
    );
}

export default function Notifications({
    group = DEFAULT_NOTIFICATION_GROUP,
    position = "bottom center",
    width = "50%",
}: NotificationsProps) {
    const [entries, setEntries] = useState<Entry[]>([]);
    const bottomToTop = parsePosition(position).y === "bottom";

    /** rendered wrapper elements by item id */
    const elements = useRef(new Map<number, HTMLDivElement>());
    /** running slide animations by item id */
    const slides = useRef(new Map<number, Animation>());
    /** visual positions of the shown items just before an item was added (FLIP "first") */
    const before = useRef<Map<number, DOMRect> | null>(null);
    /** items that slid at least once: Vue cleared their inline transition-duration, the class durations (.5s) apply */
    const moved = useRef(new Set<number>());
    /** moved before their enter fade started: the duration is cleared once the fade runs (it keeps its 300 ms) */
    const clearAfterEnter = useRef(new Set<number>());

    const startLeaving = useCallback((id: number): void => {
        setEntries((prev) =>
            prev.map((p) =>
                p.item.id === id && p.removeAt === undefined
                    ? {
                          ...p,
                          removeAt:
                              Date.now() +
                              (moved.current.has(id) ? NOTIFICATION_CLASS_TRANSITION_MS : NOTIFICATION_SPEED),
                      }
                    : p,
            ),
        );
    }, []);

    // receive notifications for our group
    useEffect(() => {
        return subscribeNotifications((item) => {
            if (item.group !== group) {
                return;
            }
            const rects = new Map<number, DOMRect>();
            for (const [id, el] of elements.current) {
                rects.set(id, el.getBoundingClientRect());
            }
            before.current = rects;
            const entry: Entry = {
                item,
                leaveAt: item.duration >= 0 ? Date.now() + item.duration + 2 * NOTIFICATION_SPEED : Infinity,
                entered: false,
            };
            setEntries((prev) => (bottomToTop ? [...prev, entry] : [entry, ...prev]));
        });
    }, [group, bottomToTop]);

    // <transition-group> move (FLIP): the items that changed place slide from where they were to where they are now,
    // over .5s (`.vn-fade-move`), with the Web Animations API; their inline transition-duration is cleared as in Vue.
    useLayoutEffect(() => {
        // compute the enter start state (opacity 0) of new items now, so dropping `vn-fade-enter` always transitions
        for (const e of entries) {
            const el = elements.current.get(e.item.id);
            if (el === undefined) continue;
            if (!e.entered) {
                void getComputedStyle(el).opacity;
            } else if (clearAfterEnter.current.delete(e.item.id)) {
                void getComputedStyle(el).opacity; // start the 300 ms fade first
                clearTransitionDuration(el);
            }
        }
        const first = before.current;
        if (first === null) {
            return;
        }
        before.current = null;
        const entered = new Set(entries.filter((e) => e.entered).map((e) => e.item.id));
        for (const [id, el] of elements.current) {
            const old = first.get(id);
            if (old === undefined || typeof el.animate !== "function") {
                continue;
            }
            slides.current.get(id)?.cancel(); // a slide still running: restart it from the current visual position
            slides.current.delete(id);
            const now = el.getBoundingClientRect();
            const dx = old.left - now.left;
            const dy = old.top - now.top;
            if (dx === 0 && dy === 0) {
                continue;
            }
            const anim = el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], {
                duration: NOTIFICATION_CLASS_TRANSITION_MS,
                easing: "ease",
            });
            slides.current.set(id, anim);
            anim.onfinish = () => {
                if (slides.current.get(id) === anim) slides.current.delete(id);
            };
            moved.current.add(id);
            if (entered.has(id)) {
                clearTransitionDuration(el);
            } else {
                clearAfterEnter.current.add(id);
            }
        }
    }, [entries]);

    // enter: drop `vn-fade-enter` (opacity 0) on the next frame so the inline transition fades the item in
    const hasEntering = entries.some((e) => !e.entered);
    useEffect(() => {
        if (!hasEntering) {
            return;
        }
        return nextFrame(() => setEntries((prev) => prev.map((p) => (p.entered ? p : { ...p, entered: true }))));
    }, [hasEntering]);

    // (re)arm the lifetime timers from absolute deadlines; StrictMode-safe and cheap for the few items on screen
    useEffect(() => {
        const handles: ReturnType<typeof setTimeout>[] = [];
        const now = Date.now();
        for (const e of entries) {
            const id = e.item.id;
            if (e.removeAt !== undefined) {
                handles.push(
                    setTimeout(
                        () => {
                            moved.current.delete(id);
                            clearAfterEnter.current.delete(id);
                            setEntries((prev) => prev.filter((p) => p.item.id !== id));
                        },
                        Math.max(0, e.removeAt - now),
                    ),
                );
            } else if (Number.isFinite(e.leaveAt)) {
                handles.push(setTimeout(() => startLeaving(id), Math.max(0, e.leaveAt - now)));
            }
        }
        return () => handles.forEach(clearTimeout);
    }, [entries, startLeaving]);

    return (
        <div className="vue-notification-group notifications" style={groupStyle(position, width)} aria-live="polite">
            <span>
                {entries.map((e) => {
                    const leaving = e.removeAt !== undefined;
                    const { item } = e;
                    const phase = leaving
                        ? " vn-fade-leave-active vn-fade-leave-to"
                        : e.entered
                          ? ""
                          : " vn-fade-enter vn-fade-enter-active";
                    return (
                        <div
                            key={item.id}
                            ref={(el) => {
                                if (el) {
                                    elements.current.set(item.id, el);
                                } else {
                                    elements.current.delete(item.id);
                                }
                            }}
                            className={"vue-notification-wrapper notification-wrapper" + phase}
                            style={WRAPPER_STYLE}
                            data-id={item.id}
                        >
                            <div
                                className={
                                    "vue-notification-template vue-notification" + (item.type ? " " + item.type : "")
                                }
                                onClick={() => startLeaving(item.id)}
                            >
                                {item.title ? (
                                    <div className="notification-title">
                                        <Lines text={item.title} />
                                    </div>
                                ) : null}
                                <div className="notification-content">
                                    <Lines text={item.text} />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </span>
        </div>
    );
}

export { Notifications };
