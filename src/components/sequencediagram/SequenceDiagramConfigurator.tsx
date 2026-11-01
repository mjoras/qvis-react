// Port of qvis SequenceDiagramConfigurator.vue (parity/sequence-diagram.md §2.2, §3.15): the blue panel with one trace
// selector per column, "Add trace", the "Time multiplier" input and the alerts. Selection heuristics live in
// selection.ts; this component only wires them to the configuration store.

import { useEffect, useState, type ChangeEvent } from "react";
import ConnectionConfigurator from "@/components/shared/ConnectionConfigurator";
import { useHoverTooltip } from "@/components/shared/HoverTooltip";
import NoTraceAlerts from "@/components/shared/NoTraceAlerts";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import type { SequenceDiagramConnection } from "./data/SequenceDiagramConfig";
import {
    addDefaultTrace,
    allowCustomTimeOffset,
    connectionIsUnknownPerspective,
    defaultSelection,
    selectConnection,
} from "./selection";
import { rememberOffset } from "./timeModel";

const PANEL_STYLE = { backgroundColor: "#cce5ff", padding: "0px 10px" } as const;

export const TIME_MULTIPLIER_TOOLTIP =
    "Increase if you have sub-millisecond latencies or want more space between events. 1 = ms level, 1000 = us level. Typically 10 or 100 is enough.";

function setConnections(connections: SequenceDiagramConnection[]): void {
    useConfigurationStore.getState().update("sequenceConfig", { connections });
}

function currentConnections(): SequenceDiagramConnection[] {
    return useConfigurationStore.getState().sequenceConfig.connections;
}

export default function SequenceDiagramConfigurator() {
    const config = useConfigurationStore((s) => s.sequenceConfig);
    const groups = useConnectionStore((s) => s.groups);
    // re-render when the model changes in place (generated traces, renamed vantage points)
    useConnectionStore((s) => s.revision);
    const multiplierTooltip = useHoverTooltip<HTMLDivElement>(TIME_MULTIPLIER_TOOLTIP);

    const connections = config.connections;

    // mounted() / updated(): select a default trace as soon as a file is available (SQ1 FIX: with the same heuristic
    // as a pick in the leftmost selector, so a client + server file opens as the pair)
    useEffect(() => {
        if (currentConnections().length === 0 && groups.length > 0) {
            const selection = defaultSelection(groups);
            if (selection !== undefined) setConnections(selection);
        }
    }, [groups, connections.length]);

    // "Time multiplier": the text as typed; only finite values > 0 are applied (SQ25 FIX)
    const [multiplier, setMultiplier] = useState(() => ({
        applied: config.timeResolution,
        text: "" + config.timeResolution,
    }));
    let multiplierText = multiplier.text;
    if (multiplier.applied !== config.timeResolution) {
        // changed elsewhere (e.g. a store reset)
        multiplierText = "" + config.timeResolution;
        setMultiplier({ applied: config.timeResolution, text: multiplierText });
    }

    const onMultiplierChange = (e: ChangeEvent<HTMLInputElement>): void => {
        const text = e.target.value;
        const value = Number(text);
        const valid = text.trim() !== "" && Number.isFinite(value) && value > 0;
        setMultiplier({ applied: valid ? value : multiplier.applied, text });
        if (valid && value !== useConfigurationStore.getState().sequenceConfig.timeResolution) {
            useConfigurationStore.getState().update("sequenceConfig", { timeResolution: value });
        }
    };

    const onConnectionSelected = (index: number, connection: QlogConnection): void => {
        setConnections(selectConnection(currentConnections(), index, connection));
    };

    const onConnectionRemoved = (index: number): void => {
        const next = currentConnections().slice();
        next.splice(index, 1);
        setConnections(next);
    };

    const onTimeOffsetChange = (index: number, offset: number): void => {
        const current = currentConnections();
        const target = current[index];
        if (target === undefined) return;
        // SQ5 FIX: a user-entered offset (including 0) is remembered for this trace and wins over auto-calculation
        rememberOffset(target.connection, offset, true);
        const next = current.slice();
        next[index] = { connection: target.connection, timeOffset: offset };
        setConnections(next);
    };

    const onAddTrace = (): void => {
        setConnections(addDefaultTrace(currentConnections(), groups));
    };

    return (
        <div style={PANEL_STYLE} className="sequence-diagram-configurator">
            <p style={{ paddingTop: "10px" }}>
                Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram
            </p>
            <div className="container-fluid">
                <div className="row">
                    {connections.map((c, index) => (
                        <ConnectionConfigurator
                            // a new offset (computed or typed) re-initializes the latency input (SQ27 / app-shell Q16)
                            key={index + ":" + c.timeOffset}
                            allGroups={groups}
                            connection={c.connection}
                            numericalInputValue={c.timeOffset}
                            numericalInputName={
                                allowCustomTimeOffset(connections, index) ? "Latency offset" : undefined
                            }
                            canBeRemoved={connections.length > 2 && index !== 0}
                            onConnectionSelected={(conn) => onConnectionSelected(index, conn)}
                            onRemoved={() => onConnectionRemoved(index)}
                            onNumericalValueChanged={(offset) => onTimeOffsetChange(index, offset)}
                        />
                    ))}
                </div>
            </div>

            <div className="container-fluid">
                <div className="row">
                    <div className="col">
                        <button type="button" className="btn btn-secondary" onClick={onAddTrace}>
                            Add trace
                        </button>
                    </div>
                    <div className="col-1 align-self-center">
                        <div className="text-right" {...multiplierTooltip.triggerProps}>
                            {"Time multiplier: "}
                        </div>
                        {multiplierTooltip.overlay}
                    </div>
                    <div className="col-1">
                        <input
                            type="number"
                            className="form-control"
                            value={multiplierText}
                            onChange={onMultiplierChange}
                        />
                    </div>
                </div>
            </div>

            {connectionIsUnknownPerspective(connections) ? (
                <div role="alert" aria-live="polite" aria-atomic="true" className="alert alert-danger">
                    The selected trace has an unknown vantage point. We guessed it based on heuristics, but this could
                    be wrong!
                </div>
            ) : null}

            <NoTraceAlerts />
        </div>
    );
}

export { SequenceDiagramConfigurator };
