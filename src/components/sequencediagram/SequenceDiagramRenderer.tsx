// React host of the sequence diagram (qvis SequenceDiagramRenderer.vue; parity/sequence-diagram.md §3.2, §8.4):
// `div#sequence-diagram > svg#sequence-diagram-svg` drawn by the imperative SequenceDiagramD3Renderer, plus the
// "Event detail" modal.
//
// Render triggering: one layout per user action (SQ2). The effect renders when the configuration's `connections`
// array or `timeResolution` changes. The derived values a render produces (the mirrored trace, the automatic latency
// offset, the deduped list) are written back to the store as a new `connections` array that is remembered as already
// rendered, so the write-back updates the selectors without a second layout pass.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getRoute } from "@/app/router";
import { notify } from "@/lib/notify";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import type { SequenceDiagramConnection } from "./data/SequenceDiagramConfig";
import EventDetailModal from "./EventDetailModal";
import { buildEventDetail, type EventDetail } from "./eventDetail";
import { measureNoTraceAlert, readFocusParams } from "./focusParams";
import { LARGE_TRACE_EVENT_COUNT, SN1_LARGE_TRACE, SN2_NOT_RENDERED } from "./notifications";
import { prepareDiagram } from "./prepare";
import {
    SequenceDiagramD3Renderer,
    type FocusPointer,
    type VanishingAlert,
} from "./renderer/SequenceDiagramD3Renderer";

interface RenderState {
    /** the connections array the current drawing was made from (or written back by it) */
    connections: readonly SequenceDiagramConnection[] | null;
    timeResolution: number;
    /** bumped by every render request and on unmount: a newer request cancels an older pending one */
    token: number;
    /** the first render after mount with an already configured diagram does not show SN1 (qvis `mounted()`) */
    skipLargeTraceWarning: boolean;
}

const DIAGRAM_STYLE = { width: "100%", border: "5px solid #cce5ff", minHeight: "200px" } as const;

export default function SequenceDiagramRenderer() {
    const config = useConfigurationStore((s) => s.sequenceConfig);
    // while no file is loaded, the configurator shows a "no file" alert (re-measured when it changes)
    const noFiles = useConnectionStore((s) => s.groups.length === 0);
    const loading = useConnectionStore((s) => s.outstandingRequestCount > 0);

    const containerRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const rendererRef = useRef<SequenceDiagramD3Renderer | null>(null);
    const focusRef = useRef<FocusPointer | null>(null);
    /**
     * Deep-link landing parity (parity/sequence-diagram.md addendum S8): when files arrive while this view is shown,
     * qvis renders and scrolls to the focused event while its "Loading files..." alert is still in the DOM (the
     * b-alert leave transition removes it one frame later); Chrome's scroll anchoring then keeps the content where it
     * was, so the event lands lower by the alert's height. Measured while the alert is shown, used by the next render.
     */
    const noFileAlertRef = useRef<VanishingAlert | undefined>(undefined);
    const stateRef = useRef<RenderState>({
        connections: null,
        timeResolution: NaN,
        token: 0,
        skipLargeTraceWarning: false,
    });

    const [modalShown, setModalShown] = useState(false);
    const [detail, setDetail] = useState<EventDetail | null>(null);

    const onEventClicked = useCallback((traceIndex: number, eventIndex: number) => {
        const layout = rendererRef.current?.getLayout();
        if (!layout) return;
        const d = buildEventDetail(layout, traceIndex, eventIndex);
        if (d === undefined) return;
        setDetail(d);
        setModalShown(true);
    }, []);

    // the imperative renderer lives as long as the component (StrictMode: disposed and recreated)
    useEffect(() => {
        const renderer = new SequenceDiagramD3Renderer(containerRef.current!, svgRef.current!, onEventClicked);
        rendererRef.current = renderer;
        const st = stateRef.current;
        st.connections = null;
        st.timeResolution = NaN;
        st.skipLargeTraceWarning = useConfigurationStore.getState().sequenceConfig.connections.length > 0;
        // focus parameters are read once per mount and applied on the first successful render (SQ11 FIX)
        focusRef.current = readFocusParams(getRoute().query);
        return () => {
            st.token++;
            renderer.dispose();
            if (rendererRef.current === renderer) rendererRef.current = null;
        };
    }, [onEventClicked]);

    // the configurator (rendered before this component) has committed its alert when this runs
    useLayoutEffect(() => {
        if (noFiles) noFileAlertRef.current = measureNoTraceAlert(containerRef.current);
    }, [noFiles, loading]);

    useEffect(() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const st = stateRef.current;
        // always the latest store value (after a StrictMode remount the closure can be one write-back behind)
        const current = useConfigurationStore.getState().sequenceConfig;
        const connections = current.connections;
        const timeResolution = current.timeResolution;
        if (st.connections === connections && st.timeResolution === timeResolution) return;

        const token = ++st.token;
        st.connections = connections;
        st.timeResolution = timeResolution;

        if (connections.length === 0) {
            // SQ35: nothing selected (e.g. every selected file was removed): no render, no stale drawing
            renderer.clear();
            return;
        }

        const showWarning = !st.skipLargeTraceWarning;
        st.skipLargeTraceWarning = false;
        // only the first render after the alert was shown; after qvis' 200 ms SN1 wait the alert was already gone
        let vanishedAlert = noFileAlertRef.current;
        noFileAlertRef.current = undefined;

        const run = (): void => {
            if (token !== st.token || rendererRef.current !== renderer) return;
            let rendered = false;
            try {
                const prepared = prepareDiagram(connections, timeResolution);
                if (prepared !== undefined) {
                    if (prepared.tracesChanged) {
                        // write back the mirror / offset / dedupe result without triggering another layout (SQ2)
                        st.connections = prepared.layout.traces;
                        useConfigurationStore.getState().update("sequenceConfig", {
                            connections: prepared.layout.traces,
                        });
                    }
                    renderer.setup(prepared.layout);
                    renderer.renderPartialExtents(focusRef.current, vanishedAlert);
                    focusRef.current = null; // focus only once (SQ11)
                    rendered = true;
                }
            } catch (e) {
                // SQ26 FIX: never leave the diagram frozen
                console.error("SequenceDiagramRenderer: rendering failed", e);
            }
            if (!rendered) notify(SN2_NOT_RENDERED);
        };

        if (showWarning && connections[0].connection.getEvents().length > LARGE_TRACE_EVENT_COUNT) {
            notify(SN1_LARGE_TRACE);
            // give time to show the warning
            vanishedAlert = undefined;
            setTimeout(run, 200);
        } else {
            run();
        }
    }, [config]);

    const hideModal = useCallback(() => setModalShown(false), []);

    return (
        <div>
            <div id="sequence-diagram" ref={containerRef} style={DIAGRAM_STYLE}>
                <svg id="sequence-diagram-svg" ref={svgRef}></svg>
            </div>
            <EventDetailModal show={modalShown} detail={detail} onHide={hideModal} />
        </div>
    );
}

export { SequenceDiagramRenderer };
