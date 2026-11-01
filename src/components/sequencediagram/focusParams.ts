// The sequence diagram's deep-link query parameters (qvis SequenceDiagramRenderer.vue:54-72; parity/sequence-diagram.md
// §5.1, SQ10 FIX; app-shell §9.6): read once when the diagram mounts, applied on its first successful render. Also the
// measurement of the "no file" alert that decides where qvis' deep links landed after a URL load (addendum S8).

import type { FocusPointer, VanishingAlert } from "./renderer/SequenceDiagramD3Renderer";

/** `parseInt(v, 10)`-like decimal digits of a packet number, leading zeros stripped (exact above 2^53), or undefined. */
export function normalizePacketNumberParam(v: string): string | undefined {
    const m = /^\s*\+?(\d+)/.exec(v);
    if (!m) return undefined;
    return m[1].replace(/^0+(?=\d)/, "");
}

/**
 * `focusOnConnection` + `focusOnEvent`, else `focusOnPN` (+ optional `focusOnConnection`, default 0). Values are
 * parsed with parseInt; 0 works (SQ10 FIX: qvis ignored focusOnEvent=0 and focusOnPN=0).
 */
export function readFocusParams(query: Readonly<Record<string, string | undefined>>): FocusPointer | null {
    const focusOnConnection = query.focusOnConnection;
    const focusOnEvent = query.focusOnEvent;
    const focusOnPN = query.focusOnPN;

    if (focusOnConnection && focusOnEvent) {
        return { connectionIndex: parseInt(focusOnConnection, 10), eventIndex: parseInt(focusOnEvent, 10) };
    }
    if (focusOnPN) {
        return {
            connectionIndex: focusOnConnection ? parseInt(focusOnConnection, 10) : 0,
            packetNumber: normalizePacketNumberParam(focusOnPN),
        };
    }
    return null;
}

/**
 * The configurator's "no file" alert ("Loading files..." / "Please load a trace file to visualize it",
 * NoTraceAlerts), or undefined when none is shown. It is the last child of the configurator panel while no file is
 * loaded (the unknown-vantage-point alert needs a selected trace).
 */
export function measureNoTraceAlert(diagramContainer: HTMLElement | null): VanishingAlert | undefined {
    const home = diagramContainer?.closest(".home");
    const panel = home?.querySelector(".sequence-diagram-configurator");
    if (!panel) return undefined;
    let height = 0;
    let extent = 0;
    for (const alert of panel.querySelectorAll(":scope > .alert")) {
        const style = getComputedStyle(alert);
        const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        const h = alert.getBoundingClientRect().height;
        height += h;
        extent += h + margins;
    }
    return extent > 0 ? { height, extent } : undefined;
}
