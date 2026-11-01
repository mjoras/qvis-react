// BootstrapVue 2.0.4 `v-b-tooltip.hover` (qvis: congestion buttons, "Time multiplier:", "Latency offset :"): a tooltip
// (placement top) that shows while the mouse is over its trigger, and only then. react-bootstrap's OverlayTrigger
// logs a console error (development) for a hover-only trigger, so the overlay is controlled with mouseenter /
// mouseleave here.
//
// Placement parity with BootstrapVue 2.0.4 + Popper.js 1 (measured against hosted qvis):
// - the tooltip flips below the trigger when it does not fit above it inside the viewport (Popper 1 `flip`,
//   behaviour "flip", 5px viewport padding); Popper 2 only flips when asked to;
// - Bootstrap 4 geometry: the `.tooltip` box carries the 0.4rem arrow space as padding and touches the trigger
//   (offset 0), so Popper rounds the outer box and the inner box sits at the same sub-pixel position as in qvis;
//   react-bootstrap's default (6px offset, arrow outside the box) put it 0.6px lower. CSS: `.qvis-tooltip` in
//   src/styles/global.css (also Bootstrap 4's font stack and z-index 1070);
// - Popper 1 rounded the top-left corner of the box (Popper 2's adaptive mode anchors top placements at the bottom).
// Timing parity: `v-b-tooltip` waits 50ms (BootstrapVue's default `delay`, show and hide) and its Vue transition
// starts a couple of frames later; a quick sweep over the triggers therefore shows no tooltip. Measured in hosted
// qvis: the fade-in starts ~87ms after mouseenter, the fade-out ~90ms after mouseleave (both 150ms linear, like
// react-bootstrap's Fade).

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Overlay from "react-bootstrap/Overlay";
import Tooltip from "react-bootstrap/Tooltip";

/** BootstrapVue 2.0.4 `BTooltip` config default `delay: 50` (ms, show and hide). */
export const HOVER_DELAY_MS = 50;
/** Class of every hover tooltip (Bootstrap 4.3.1 look, global.css). */
export const QVIS_TOOLTIP_CLASS = "qvis-tooltip";

const NO_OFFSET: [number, number] = [0, 0];
const POPPER_CONFIG = {
    modifiers: [
        { name: "flip", options: { padding: 5 } },
        // Popper 1 rounded the box's top; Popper 2's "adaptive" styles round its distance to the page bottom instead
        { name: "computeStyles", options: { adaptive: false } },
    ],
};

export interface HoverTooltipTriggerProps<T extends HTMLElement> {
    ref: (el: T | null) => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    "aria-describedby"?: string;
}

export interface HoverTooltip<T extends HTMLElement> {
    /** Spread onto the trigger element. */
    triggerProps: HoverTooltipTriggerProps<T>;
    /** Render anywhere next to the trigger (portalled to <body> while shown). */
    overlay: ReactNode;
}

/** `v-b-tooltip.hover title="..."` for one trigger element; no tooltip (and no listeners) when `title` is undefined. */
export function useHoverTooltip<T extends HTMLElement>(title: ReactNode | undefined): HoverTooltip<T> {
    const [target, setTarget] = useState<T | null>(null);
    const [show, setShow] = useState(false);
    const id = useId();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const frame = useRef(0);

    const cancel = (): void => {
        clearTimeout(timer.current);
        cancelAnimationFrame(frame.current);
    };
    // the latest hover state wins after the delay (BootstrapVue's $_hoverState check)
    const schedule = (next: boolean): void => {
        cancel();
        timer.current = setTimeout(() => {
            frame.current = requestAnimationFrame(() => setShow(next));
        }, HOVER_DELAY_MS);
    };
    useEffect(() => cancel, []);

    const enabled = title !== undefined;
    return {
        triggerProps: {
            ref: setTarget,
            onMouseEnter: enabled ? () => schedule(true) : undefined,
            onMouseLeave: enabled ? () => schedule(false) : undefined,
            "aria-describedby": enabled && show ? id : undefined,
        },
        overlay: enabled ? (
            <Overlay
                target={target}
                show={show && target !== null}
                placement="top"
                flip
                offset={NO_OFFSET}
                popperConfig={POPPER_CONFIG}
            >
                <Tooltip id={id} className={QVIS_TOOLTIP_CLASS}>
                    {title}
                </Tooltip>
            </Overlay>
        ) : null,
    };
}
