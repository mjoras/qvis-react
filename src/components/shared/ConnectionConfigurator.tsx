// Port of qvis components/shared/ConnectionConfigurator.vue: the trace / file picker embedded by every tool
// (parity/app-shell.md §2.5, §8.5).
//
// Fully controlled: the selected file is derived from `group ?? connection.parent` (Q10). Option values encode
// identity by index ("g:<gi>", "c:<gi>:<ci>", "h:<gi>", "bc:<ci>"), and the selected value is found by identity
// (===), so two structurally identical files (the same file loaded twice) stay distinct. A selection that matches no
// option renders blank (qvis behaviour for stale selections).
//
// Render modes (§2.5.4):
//   A  group-only        allowGroupSelection && !allowConnectionSelection           (statistics)
//   B  separate selects  otherwise, when the combined option count is > 30
//   C  combined select   otherwise (the common case)
// Fixes: Q8 (onGroupSelected gets the newly selected group), Q9 (mode B also shows the numeric input and the remove
// button, laid out like mode C, without the file header label), Q12 (switching to a file without traces keeps the
// previous selection), Q15 (non-numeric input is ignored).

import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { useConnectionStore } from "@/store/connectionStore";
import {
    combinedConnectionLabel,
    combinedHeaderLabel,
    connectionLabel,
    groupOptionLabel,
} from "@/lib/connectionLabels";
import { useHoverTooltip } from "./HoverTooltip";

export interface ConnectionConfiguratorProps {
    /** The currently selected trace (controlled). Required unless `group` is given. */
    connection?: QlogConnection;
    /** The currently selected file (statistics / group-only mode). */
    group?: QlogConnectionGroup;
    /** Every loaded file (callers pass the connection store's `groups`). */
    allGroups: readonly QlogConnectionGroup[];
    /** Initial value of the optional numeric input (latency offset). */
    numericalInputValue?: number;
    /** If truthy, shows the numeric input with header label `"<name> : "`. */
    numericalInputName?: string;
    /** Shows the remove button "−" (default true, as in qvis). */
    canBeRemoved?: boolean;
    /** Makes file entries selectable and calls onGroupSelected (default false). */
    allowGroupSelection?: boolean;
    /** Whether traces can be chosen (default true). */
    allowConnectionSelection?: boolean;
    onGroupSelected?: (group: QlogConnectionGroup) => void;
    onConnectionSelected?: (connection: QlogConnection) => void;
    /** Called with parseFloat(value) on the native `change` event of the number input (finite values only). */
    onNumericalValueChanged?: (value: number) => void;
    onRemoved?: () => void;
}

/** More combined options than this switches to two selects (qvis `tooManyOptions`). */
export const MAX_COMBINED_OPTIONS = 30;

const LATENCY_TOOLTIP = "This value is automatically calculated, but can be manually adjusted.";
const FRAME_STYLE: CSSProperties = {
    backgroundColor: "white",
    color: "black",
    border: "black 1px solid",
    maxWidth: "50%",
};
const SPACER_STYLE: CSSProperties = { maxWidth: "36px" };
const MINUS = "−";

function formatNumber(v: number | undefined): string {
    return v === undefined || v === null ? "" : String(v);
}

export default function ConnectionConfigurator(props: ConnectionConfiguratorProps) {
    const {
        connection,
        group,
        allGroups,
        numericalInputValue,
        numericalInputName,
        canBeRemoved = true,
        allowGroupSelection = false,
        allowConnectionSelection = true,
        onGroupSelected,
        onConnectionSelected,
        onNumericalValueChanged,
        onRemoved,
    } = props;

    // re-render when the model changes in place (e.g. the sequence diagram adds a generated sibling trace)
    useConnectionStore((s) => s.revision);

    const latencyTooltip = useHoverTooltip<HTMLDivElement>(LATENCY_TOOLTIP);
    const selectedGroup: QlogConnectionGroup | undefined = group ?? connection?.parent;

    // ---- numeric input: local draft text, reset when the selected connection changes (qvis connection watcher)
    const [draft, setDraft] = useState(() => ({ conn: connection, text: formatNumber(numericalInputValue) }));
    let draftText = draft.text;
    if (draft.conn !== connection) {
        draftText = formatNumber(numericalInputValue);
        setDraft({ conn: connection, text: draftText });
    }

    const numericCallback = useRef(onNumericalValueChanged);
    useLayoutEffect(() => {
        numericCallback.current = onNumericalValueChanged;
    });
    // native "change" (blur / Enter / spinner click), not React's per-keystroke onChange
    const numericInputRef = useCallback((el: HTMLInputElement | null) => {
        if (!el) {
            return;
        }
        const handler = (): void => {
            const value = parseFloat(el.value);
            if (Number.isFinite(value)) {
                numericCallback.current?.(value);
            }
        };
        el.addEventListener("change", handler);
        return () => el.removeEventListener("change", handler);
    }, []);

    // ---- option model
    const groupOnly = allowGroupSelection && !allowConnectionSelection;
    let combinedCount = 0;
    for (const g of allGroups) {
        combinedCount += 1 + g.getConnections().length;
    }
    const tooManyOptions = combinedCount > MAX_COMBINED_OPTIONS;

    const selectedGroupIndex = selectedGroup ? allGroups.indexOf(selectedGroup) : -1;
    const groupValue = selectedGroupIndex >= 0 ? "g:" + selectedGroupIndex : "";

    function handleGroupChange(e: ChangeEvent<HTMLSelectElement>): void {
        const m = /^g:(\d+)$/.exec(e.target.value);
        const newGroup = m ? allGroups[Number(m[1])] : undefined;
        if (!newGroup) {
            return;
        }
        if (allowGroupSelection && onGroupSelected) {
            onGroupSelected(newGroup);
        }
        if (allowConnectionSelection) {
            const first = newGroup.getConnections()[0];
            if (first !== undefined) {
                onConnectionSelected?.(first);
            }
        }
    }

    const groupSelect = (className: string) => (
        <select className={className} value={groupValue} onChange={handleGroupChange}>
            {groupValue === "" ? <option value="" hidden /> : null}
            {allGroups.map((g, gi) => (
                <option key={gi} value={"g:" + gi}>
                    {groupOptionLabel(g)}
                </option>
            ))}
        </select>
    );

    const numericHeader = numericalInputName ? (
        <div className="col-2">
            <div {...latencyTooltip.triggerProps}>{numericalInputName + " : "}</div>
            {latencyTooltip.overlay}
        </div>
    ) : null;

    const numericInput = numericalInputName ? (
        <div className="col-2">
            <input
                ref={numericInputRef}
                type="number"
                className="form-control"
                value={draftText}
                onChange={(e) => setDraft({ conn: connection, text: e.target.value })}
            />
        </div>
    ) : null;

    const removeButton = canBeRemoved ? (
        <div className="col-auto px-0">
            <button type="button" className="btn btn-secondary" onClick={() => onRemoved?.()}>
                {MINUS}
            </button>
        </div>
    ) : null;

    let body;
    if (groupOnly) {
        // ---- mode A
        body = <div>{groupSelect("form-select mb-3 mt-3")}</div>;
    } else if (tooManyOptions) {
        // ---- mode B
        const conns = selectedGroup ? selectedGroup.getConnections() : [];
        const ci = connection ? conns.indexOf(connection) : -1;
        const connValue = ci >= 0 ? "bc:" + ci : "";
        const handleConnChange = (e: ChangeEvent<HTMLSelectElement>): void => {
            const m = /^bc:(\d+)$/.exec(e.target.value);
            const picked = m ? conns[Number(m[1])] : undefined;
            if (picked !== undefined) {
                onConnectionSelected?.(picked);
            }
        };
        body = (
            <div>
                <div>
                    {groupSelect("form-select mb-3 mt-3")}
                    {numericalInputName ? (
                        <div className="row">
                            <div className="col"></div>
                            {numericHeader}
                            {canBeRemoved ? <div className="col" style={SPACER_STYLE}></div> : null}
                        </div>
                    ) : null}
                    <div className="row mb-3">
                        <div className="col">
                            <select className="form-select" value={connValue} onChange={handleConnChange}>
                                {connValue === "" ? <option value="" hidden /> : null}
                                {conns.map((c, i) => (
                                    <option key={i} value={"bc:" + i}>
                                        {connectionLabel(c)}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {numericInput}
                        {removeButton}
                    </div>
                </div>
            </div>
        );
    } else {
        // ---- mode C
        let combinedValue = "";
        if (connection) {
            for (let gi = 0; gi < allGroups.length && combinedValue === ""; ++gi) {
                const ci = allGroups[gi].getConnections().indexOf(connection);
                if (ci >= 0) {
                    combinedValue = "c:" + gi + ":" + ci;
                }
            }
        }
        const handleCombinedChange = (e: ChangeEvent<HTMLSelectElement>): void => {
            const value = e.target.value;
            const c = /^c:(\d+):(\d+)$/.exec(value);
            if (c) {
                const picked = allGroups[Number(c[1])]?.getConnections()[Number(c[2])];
                if (picked !== undefined) {
                    onConnectionSelected?.(picked);
                }
                return;
            }
            const h = /^h:(\d+)$/.exec(value);
            if (h && allowGroupSelection) {
                const g = allGroups[Number(h[1])];
                if (g) {
                    onGroupSelected?.(g);
                }
            }
        };
        body = (
            <div>
                <div>
                    <div className="row mt-3">
                        <div className="col">
                            <div>{connection ? combinedHeaderLabel(connection) : ""}</div>
                        </div>
                        {numericHeader}
                        {canBeRemoved ? <div className="col" style={SPACER_STYLE}></div> : null}
                    </div>
                    <div className="row mb-3">
                        <div className="col">
                            <select className="form-select" value={combinedValue} onChange={handleCombinedChange}>
                                {combinedValue === "" ? <option value="" hidden /> : null}
                                {allGroups.map((g, gi) => [
                                    <option key={"h:" + gi} value={"h:" + gi} disabled={!allowGroupSelection}>
                                        {g.filename}
                                    </option>,
                                    ...g.getConnections().map((c, ci) => (
                                        <option key={"c:" + gi + ":" + ci} value={"c:" + gi + ":" + ci}>
                                            {combinedConnectionLabel(c)}
                                        </option>
                                    )),
                                ])}
                            </select>
                        </div>
                        {numericInput}
                        {removeButton}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="col" style={FRAME_STYLE}>
            <div className="container-fluid">{body}</div>
        </div>
    );
}

export { ConnectionConfigurator };
