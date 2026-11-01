// A `b-button` with `v-b-tooltip.hover` (BootstrapVue): a grey secondary button whose tooltip (placement top) shows
// while the mouse is over it, and only then. Placement, look and timing parity with BootstrapVue 2.0.4 are in the
// shared hook (src/components/shared/HoverTooltip.tsx), which the sequence and trace configurators use too.

import type { ReactNode } from "react";
import { useHoverTooltip } from "@/components/shared/HoverTooltip";

export interface HoverTooltipButtonProps {
    title?: string;
    onClick: () => void;
    children: ReactNode;
}

export default function HoverTooltipButton({ title, onClick, children }: HoverTooltipButtonProps) {
    const { triggerProps, overlay } = useHoverTooltip<HTMLButtonElement>(title);
    return (
        <>
            <button type="button" className="btn btn-secondary" {...triggerProps} onClick={onClick}>
                {children}
            </button>
            {overlay}
        </>
    );
}

export { HoverTooltipButton };
