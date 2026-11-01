// Port of qvis views/VUEDebug.vue, the hidden #/debug page (parity/app-shell.md §2.7, §8.8, Q21).
//
// PRESERVED: on mount, if at most one file is loaded, three random fake files are added to the REAL store; they then
// show up in every tool's selector and in the file manager.
// Fake files are latest-draft shaped (contained qlog, `{time, name, data}` events) and go through QlogLoader.
// "Change Event Name" / "RemoveEvent" mutate the model without a change notification, so (as in qvis) the UI only
// reflects them on the next unrelated re-render. "Change Connection Name" notifies (re-renders).
// DEVIATION (debug only): the event list is capped at DEBUG_EVENT_ROW_CAP rows so real traces do not freeze the page.
// NEW (converters spec decision C2): a "Convert with extended mappings" checkbox switches the netlog / tshark
// converters to their T3 tier for files loaded afterwards. Only here, so the file manager stays verbatim.

import { useEffect, useRef, useState } from "react";
import { isExtendedConversion, setExtendedConversion } from "@/loading/fileLoader";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import type { QlogEvent } from "@/model/QlogEvent";
import { useConnectionStore } from "@/store/connectionStore";
import "./DebugPage.css";

/** Maximum number of "- Event: ROBIN : ..." rows rendered. */
export const DEBUG_EVENT_ROW_CAP = 2000;

/** qvis ConnectionStore.DEBUG_LoadRandomFile: 1..6 traces titled "Connection i", each with 1..3 dummy events. */
function createRandomGroup(filename: string): QlogConnectionGroup | undefined {
    const traces: Record<string, unknown>[] = [];
    const connectionCount = Math.round(Math.random() * 5) + 1;
    for (let i = 0; i < connectionCount; ++i) {
        const events: Record<string, unknown>[] = [];
        const eventCount = Math.ceil(Math.random() * 3);
        for (let j = 0; j < eventCount; ++j) {
            // qvis' pre-spec array [j, "testcat", "Connection #i - Event #j", "dummytrigger", {dummy: true}] in
            // latest-draft shape (§9.7): the category becomes the namespace, the trigger moves into data
            events.push({
                time: j,
                name: "testcat:Connection #" + i + " - Event #" + j,
                data: { dummy: true, trigger: "dummytrigger" },
            });
        }
        // qvis leaves the constructor-default vantage point {type: "unknown", flow: "unknown"}; the event_schemas
        // entry declares the private namespace, so the loader reports no diagnostics for these fake files
        traces.push({
            title: "Connection " + i,
            vantage_point: { type: "unknown", flow: "unknown" },
            event_schemas: ["urn:ietf:params:qlog:events:testcat"],
            events,
        });
    }
    const root: Record<string, unknown> = {
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        traces,
    };
    const group = QlogLoader.fromJSON({ root, serialization: "json", diagnostics: [] });
    if (group) {
        group.filename = "";
        group.description = filename;
    }
    return group;
}

function addRandomConnectionGroup(): void {
    const filename = "RandomConnectionGroup " + Math.round(Math.random() * 100);
    const group = createRandomGroup(filename);
    if (!group) {
        console.error("DebugPage: QlogLoader could not build a random ConnectionGroup", filename);
        return;
    }
    useConnectionStore.getState().addGroup(group);
    console.log("ConnectionGroup added. This is called AFTER the mutation has been committed to the store!", group);
}

function lastGroupConnections(groups: readonly QlogConnectionGroup[]): readonly QlogConnection[] | undefined {
    return groups.length > 0 ? groups[groups.length - 1].getConnections() : undefined;
}

export default function DebugPage() {
    const groups = useConnectionStore((s) => s.groups);
    useConnectionStore((s) => s.revision);
    const initialized = useRef(false);
    const [extended, setExtended] = useState(isExtendedConversion);

    // qvis created(): only for debugging, obviously
    useEffect(() => {
        if (initialized.current) {
            return;
        }
        initialized.current = true;
        if (useConnectionStore.getState().groups.length <= 1) {
            addRandomConnectionGroup();
            addRandomConnectionGroup();
            addRandomConnectionGroup();
        }
    }, []);

    const connections = lastGroupConnections(groups);

    function deleteFirst(): void {
        const first = useConnectionStore.getState().groups[0];
        if (first) {
            useConnectionStore.getState().removeGroup(first);
        }
    }

    function changeConnectionName(): void {
        const conn = connections?.[0];
        if (!conn) {
            console.error("DebugPage: no connection to rename");
            return;
        }
        conn.setTitle("Connection name was changed"); // emits a model change -> store revision -> re-render
        console.log("Connection name was changed", conn);
    }

    function changeEventName(): void {
        const conn = connections?.[0];
        const ev = conn?.getEvents()[0];
        if (!conn || !ev) {
            console.error("DebugPage: no event to rename");
            return;
        }
        try {
            const renamed = ev as { loggedName: string; fullName: string; type: string };
            renamed.loggedName = ev.namespace + ":Event was changed"; // §9.7: "testcat:Event was changed"
            renamed.fullName = renamed.loggedName;
            renamed.type = "Event was changed";
        } catch (e) {
            console.error("DebugPage: could not rename event", e);
        }
        console.log("Event name was changed, but SHOULD NOT reflect in UI since events are no longer reactive!", conn);
    }

    function removeEvent(): void {
        const conn = connections?.[0];
        if (!conn) {
            console.error("DebugPage: no event to remove");
            return;
        }
        try {
            const events = conn.getEvents() as QlogEvent[];
            events.splice(events.length - 1, 1);
        } catch (e) {
            console.error("DebugPage: could not remove event", e);
        }
    }

    const eventRows: { key: string; text: string }[] = [];
    let hiddenEvents = 0;
    if (connections) {
        connections.forEach((conn, ci) => {
            conn.getEvents().forEach((ev, ei) => {
                if (eventRows.length >= DEBUG_EVENT_ROW_CAP) {
                    hiddenEvents++;
                    return;
                }
                // qvis `connection.parseEvent(event).name`: the event type, i.e. the name after the first colon (§9.4)
                eventRows.push({ key: ci + ":" + ei, text: "- Event: ROBIN : " + conn.title + " : " + ev.type });
            });
        });
    }

    return (
        <div id="VUEDebug" className="home">
            <div className="hello">
                <h1>This is the VUE debugger to test reactive data coupling</h1>
            </div>
            <button type="button" className="btn btn-secondary" onClick={addRandomConnectionGroup}>
                Add new random ConnectionGroup
            </button>
            {" | "}
            <button type="button" className="btn btn-secondary" onClick={deleteFirst}>
                Delete First
            </button>
            {" | "}
            <button type="button" className="btn btn-secondary" onClick={changeConnectionName}>
                Change Connection Name
            </button>
            {" | "}
            <button type="button" className="btn btn-secondary" onClick={changeEventName}>
                Change Event Name
            </button>
            {" | "}
            <button type="button" className="btn btn-secondary" onClick={removeEvent}>
                RemoveEvent
            </button>
            <div className="form-check debug-extended-conversion">
                <input
                    id="debug-extended-conversion"
                    className="form-check-input"
                    type="checkbox"
                    checked={extended}
                    onChange={(e) => {
                        setExtendedConversion(e.target.checked);
                        setExtended(e.target.checked);
                    }}
                />
                <label className="form-check-label" htmlFor="debug-extended-conversion">
                    Convert with extended mappings
                </label>
            </div>

            {groups.map((g, gi) => (
                <div key={gi}>{g.description}</div>
            ))}
            {eventRows.map((row) => (
                <div key={row.key}>{row.text}</div>
            ))}
            {hiddenEvents > 0 ? (
                <div>{"... " + hiddenEvents + " more events not shown (debug page row cap)"}</div>
            ) : null}
        </div>
    );
}

export { DebugPage };
