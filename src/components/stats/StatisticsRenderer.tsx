// Port of qvis components/stats/StatisticsRenderer.vue (parity/statistics.md §2.4, §2.5, §3.3): the always-present
// #statistics-container box, the "File info" table and one "Trace N info" section per real (non-generated) trace.
//
// Deviations (documented in the spec): no `Summary` row (S12, `summary` no longer exists), NEW `Serialization format`
// and `Diagnostics` rows (S4), trace sections rendered even when the file has no events (FIX Q7).

import { Fragment } from "react";
import type { Diagnostic } from "@/model/types";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import { computeFileStats, displayValue } from "./data/computeStatistics";
import StatisticsConnectionRenderer from "./StatisticsConnectionRenderer";

function diagnosticLine(d: Diagnostic): string {
    return d.level + ": " + d.message + (d.count > 1 ? " (" + d.count + "x)" : "");
}

export default function StatisticsRenderer() {
    const group = useConfigurationStore((s) => s.statisticsConfig.group);
    // in-place model changes (generated sibling traces, renamed traces) bump the revision
    useConnectionStore((s) => s.revision);

    let content = null;
    if (group !== undefined) {
        const { traces, traceCount, totalEventCount } = computeFileStats(group);
        content = (
            <div className="stats-inner">
                <h3>File info</h3>
                <div className="table-responsive">
                    <table className="stats-table stats-table-bordered stats-table-sm stats-file-table">
                        <colgroup>
                            <col width="20%" />
                        </colgroup>
                        <thead className="stats-thead-dark">
                            <tr>
                                <th>Aspect</th>
                                <th>Value</th>
                            </tr>
                        </thead>
                        <tbody>
                            {group.filename !== "" ? (
                                <tr>
                                    <td>Filename</td>
                                    <td>{displayValue(group.filename)}</td>
                                </tr>
                            ) : null}
                            {group.title !== "" ? (
                                <tr>
                                    <td>Title</td>
                                    <td>{displayValue(group.title)}</td>
                                </tr>
                            ) : null}
                            {group.description !== "" ? (
                                <tr>
                                    <td>Description</td>
                                    <td>{displayValue(group.description)}</td>
                                </tr>
                            ) : null}
                            <tr>
                                <td>qlog version</td>
                                <td>{displayValue(group.version)}</td>
                            </tr>
                            {group.serializationFormat !== "" ? (
                                <tr>
                                    <td>Serialization format</td>
                                    <td>{displayValue(group.serializationFormat)}</td>
                                </tr>
                            ) : null}
                            <tr>
                                <td>Trace count</td>
                                <td>{traceCount}</td>
                            </tr>
                            <tr>
                                <td>Total event count</td>
                                <td>{totalEventCount}</td>
                            </tr>
                            {group.diagnostics.length > 0 ? (
                                <tr>
                                    <td>Diagnostics</td>
                                    <td>
                                        {group.diagnostics.map((d, i) => (
                                            <Fragment key={i}>
                                                {i > 0 ? <br /> : null}
                                                {diagnosticLine(d)}
                                            </Fragment>
                                        ))}
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </div>

                {traces.map((connection, index) => (
                    <StatisticsConnectionRenderer key={"conn_" + index} connection={connection} index={index} />
                ))}
            </div>
        );
    }

    return (
        <div>
            <div id="statistics-container">{content}</div>
        </div>
    );
}

export { StatisticsRenderer };
