// Port of qvis `components/packetizationdiagram/PacketizationDiagramRenderer.vue` (parity spec §2.4, §3.1, §6.1, §8.3).
//
// Owns the two diagram containers (top = bytes RECEIVED, bottom = bytes SENT) and the shared tooltip div, plus one D3
// renderer instance per container. Renders on mount and whenever the selected trace changes (by identity); nothing is
// cached. Differences from qvis (FIX / DECISION):
// - no `rendering` busy flag: render() is synchronous and superseded runs (the 200ms N-PZ1 wait) are cancelled, so
//   N-PZ2 only reports exceptions (Q-L1);
// - N-PZ1 / N-PZ2 also apply when the tab is re-entered (D-PZ3); N-PZ3 replaces qvis' alert() storms (Q-L2);
// - the diagrams are cleared when the selection is scrubbed (E23);
// - when the containers' width changes (window resize, scrollbar), the diagrams are re-laid out for the new width
//   instead of overflowing (E22/E27, debounced; this resets the zoom, like any re-render).

import { useEffect, useRef, type CSSProperties } from "react";
import { notify } from "@/lib/notify";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConnectionStore } from "@/store/connectionStore";
import type PacketizationDiagramConfig from "./data/PacketizationDiagramConfig";
import { PacketizationDirection } from "./renderer/PacketizationDiagramModels";
import PacketizationDiagramD3Renderer from "./renderer/PacketizationDiagramD3Renderer";
import { LARGE_TRACE_EVENT_COUNT, N_PZ1, N_PZ2, N_PZ3 } from "./notifications";

const CONTAINER_STYLE: CSSProperties = { width: "100%", minHeight: "200px" };

/** Quiet period after the last container width change before the diagrams are re-laid out. */
const RELAYOUT_DEBOUNCE_MS = 150;

interface Renderers {
    top: PacketizationDiagramD3Renderer;
    bottom: PacketizationDiagramD3Renderer;
}

/**
 * Renders both diagrams for `connection`; reports exceptions (N-PZ2) and inconsistent traces (N-PZ3, at most once per
 * render; not again for a re-layout of the same trace).
 */
function renderBoth(renderers: Renderers, connection: QlogConnection, reportInconsistency = true): void {
    let insufficientBytes = false;
    const jobs: [PacketizationDiagramD3Renderer, PacketizationDirection][] = [
        [renderers.top, PacketizationDirection.receiving],
        [renderers.bottom, PacketizationDirection.sending],
    ];
    for (const [renderer, direction] of jobs) {
        try {
            const result = renderer.render(connection, direction);
            insufficientBytes = insufficientBytes || result.insufficientBytes;
        } catch (e) {
            console.error("PacketizationDiagramRenderer: rendering failed", e);
            notify({ ...N_PZ2 });
        }
    }
    if (insufficientBytes && reportInconsistency) {
        notify({ ...N_PZ3 });
    }
}

export interface PacketizationDiagramRendererProps {
    config: PacketizationDiagramConfig;
}

export default function PacketizationDiagramRenderer({ config }: PacketizationDiagramRendererProps) {
    const topRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const renderers = useRef<Renderers | null>(null);
    const connectionRef = useRef<QlogConnection | undefined>(undefined);
    // the connection of the previous render-effect run: N-PZ1 is shown once per selection change (qvis watcher), not
    // again when the effect re-runs for the same trace (React StrictMode, vantage point edits)
    const lastRendered = useRef<QlogConnection | undefined>(undefined);

    const connection: QlogConnection | undefined = config.connections[0];

    // in-place model changes (e.g. a vantage point edited elsewhere) bump the store revision; only the vantage point
    // type influences this view (flow label, local/remote naming, request info)
    useConnectionStore((s) => s.revision);
    const vantagePointType = connection?.vantagePoint?.type;

    // create once (StrictMode: create -> dispose -> create)
    useEffect(() => {
        const created: Renderers = {
            top: new PacketizationDiagramD3Renderer(topRef.current!, tooltipRef.current!, "packetization-clip-top"),
            bottom: new PacketizationDiagramD3Renderer(
                bottomRef.current!,
                tooltipRef.current!,
                "packetization-clip-bottom",
            ),
        };
        renderers.current = created;
        return () => {
            created.top.dispose();
            created.bottom.dispose();
            renderers.current = null;
        };
    }, []);

    // render on mount and on selection change
    useEffect(() => {
        connectionRef.current = connection;
        const current = renderers.current;
        if (!current) {
            return;
        }
        if (!connection) {
            lastRendered.current = undefined;
            current.top.clear();
            current.bottom.clear();
            return;
        }

        let cancelled = false;
        const selectionChanged = lastRendered.current !== connection;
        lastRendered.current = connection;
        if (connection.getEvents().length > LARGE_TRACE_EVENT_COUNT) {
            if (selectionChanged) {
                notify({ ...N_PZ1 });
            }
            // give time to show the warning
            const timer = setTimeout(() => {
                if (!cancelled && renderers.current) {
                    renderBoth(renderers.current, connection);
                }
            }, 200);
            return () => {
                cancelled = true;
                clearTimeout(timer);
            };
        }

        renderBoth(current, connection);
        return () => {
            cancelled = true;
        };
    }, [connection, vantagePointType]);

    // re-layout when the available width changes (the width is otherwise only measured at render time). Debounced: a
    // full render of a large trace takes seconds, so a window drag-resize must not trigger one per frame.
    useEffect(() => {
        const element = topRef.current;
        if (!element || typeof ResizeObserver === "undefined") {
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const current = renderers.current;
                const conn = connectionRef.current;
                const renderedWidth = current?.top.getRenderedWidth();
                if (!current || !conn || renderedWidth === undefined || renderedWidth === element.clientWidth) {
                    return;
                }
                renderBoth(current, conn, false);
            }, RELAYOUT_DEBOUNCE_MS);
        });
        observer.observe(element);
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, []);

    return (
        <div>
            <div id="packetization-diagram-top" ref={topRef} style={CONTAINER_STYLE}></div>

            <div id="packetization-diagram-bottom" ref={bottomRef} style={CONTAINER_STYLE}></div>

            <div id="packetization-packet-tooltip" ref={tooltipRef}></div>
        </div>
    );
}

export { PacketizationDiagramRenderer };
