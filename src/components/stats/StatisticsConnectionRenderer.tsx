// Port of qvis components/stats/StatisticsConnectionRenderer.vue (parity/statistics.md §2.6, §2.7): the
// "Trace N info" table of one trace. All numbers come from the pure, cached getTraceStats(); labels that can change at
// runtime (title, description, vantage point) are read at render time.
//
// FIXes (spec §7): Title row condition `title.length > 0` (Q1), H3 summary rendered as React elements instead of
// v-html (Q3), connection-level FC guard also passes when FC values exist (Q5), stream-level FC guard also passes for
// local-only limits (Q6), vantage point name line only for a non-empty name (Q8), class instead of the duplicated
// id="toplevel" (Q9). NEW rows: Event schemas, QUIC version, ALPN (S4, S17).

import { Fragment, type ReactNode } from "react";
import type { QlogConnection } from "@/model/QlogConnection";
import { useConnectionStore } from "@/store/connectionStore";
import { displayValue, getTraceStats, type FCSeries } from "./data/computeStatistics";
import StatsProgress from "./StatsProgress";

export interface StatisticsConnectionRendererProps {
    connection: QlogConnection;
    /** 0-based position among the file's real traces (heading shows index + 1) */
    index: number;
}

const NO_PACKET_TYPE = "None of the events in this trace had data.header.packet_type set!";
const NO_STREAM_FC = "No stream level flow control limits set";

/** b-table-simple fixed small borderless responsive style="border-bottom: 0px;" */
function NestedTable({ children }: { children: ReactNode }) {
    return (
        <div className="table-responsive" style={{ borderBottom: "0px" }}>
            <table className="stats-table stats-table-sm stats-table-borderless">
                <colgroup>
                    <col width="20%" />
                </colgroup>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

function ValueList({ values }: { values: readonly number[] }) {
    return (
        <>
            {values.map((v, i) => (
                <p key={i}>{String(v)}</p>
            ))}
        </>
    );
}

// qvis keys every v-for row by its POSITION (`'fcsl_' + index6`, `'evt_' + index1 + '_' + index2`, ...), so on a file
// switch Vue patches the row at the same position in place and the progress bars animate (`transition: width .6s`)
// from the previous file's value at that position. Keys by content would make React move rows, and moved bars jump.
function StreamRows({ streams, prefix }: { streams: Map<string, FCSeries>; prefix: string }) {
    return (
        <>
            {[...streams].map(([key, series], i) => (
                <tr key={prefix + i}>
                    <td></td>
                    <td>{key}</td>
                    <td>
                        <ValueList values={series.values} />
                    </td>
                    <td></td>
                </tr>
            ))}
        </>
    );
}

export default function StatisticsConnectionRenderer({ connection, index }: StatisticsConnectionRendererProps) {
    // title / description / vantage point may be changed in place (sequence diagram setters)
    useConnectionStore((s) => s.revision);

    const stats = getTraceStats(connection, index);
    const vp = connection.vantagePoint;
    const remoteType = vp.type === "client" ? "server" : "client"; // PARITY Q10: "client" for every non-client type
    const eventCount = stats.eventCount;

    const showConnectionFC =
        stats.encryptionLevels.length > 0 ||
        stats.connectionFC.local.values.length > 0 ||
        stats.connectionFC.remote.values.length > 0;
    const showStreamFC = stats.streamFC.remote.size > 0 || stats.streamFC.local.size > 0;

    const title = displayValue(connection.title);
    const description = displayValue(connection.description);
    const h3 = stats.h3;

    return (
        <div>
            {/* one text node per label, like Vue's compiled `Trace {{index + 1}} info` (split text nodes shift glyphs) */}
            <h3>{"Trace " + (index + 1) + " info"}</h3>
            <div className="table-responsive">
                <table className="stats-table stats-table-bordered stats-table-sm stats-trace-table">
                    <colgroup>
                        <col width="20%" />
                    </colgroup>
                    <tbody>
                        {title.length > 0 ? (
                            <tr>
                                <td>Title</td>
                                <td>{title}</td>
                            </tr>
                        ) : null}
                        {description.length > 0 ? (
                            <tr>
                                <td>Description</td>
                                <td>{description}</td>
                            </tr>
                        ) : null}
                        {vp ? (
                            <tr>
                                <td>Vantage point</td>
                                <td>
                                    {typeof vp.name === "string" && vp.name !== "" ? (
                                        <span>
                                            {vp.name}
                                            <br />
                                        </span>
                                    ) : null}
                                    {vp.type === "network" ? (
                                        <span>
                                            {displayValue(vp.type) +
                                                " : with " +
                                                displayValue(vp.flow) +
                                                " perspective"}
                                        </span>
                                    ) : (
                                        <span>{displayValue(vp.type)}</span>
                                    )}
                                </td>
                            </tr>
                        ) : null}
                        {connection.eventSchemas.length > 0 ? (
                            <tr>
                                <td>Event schemas</td>
                                <td>
                                    {connection.eventSchemas.map((uri, i) => (
                                        <Fragment key={i}>
                                            {i > 0 ? <br /> : null}
                                            {displayValue(uri)}
                                        </Fragment>
                                    ))}
                                </td>
                            </tr>
                        ) : null}
                        {stats.quicVersion !== undefined ? (
                            <tr>
                                <td>QUIC version</td>
                                <td>{stats.quicVersion}</td>
                            </tr>
                        ) : null}
                        {stats.alpn !== undefined ? (
                            <tr>
                                <td>ALPN</td>
                                <td>{stats.alpn}</td>
                            </tr>
                        ) : null}
                        {h3 !== undefined ? (
                            // qvis concatenated the values into an HTML string (v-html): String(v), never JSON
                            <tr>
                                <td>H3 connection headers</td>
                                <td>
                                    <div>
                                        {"User Agent "}
                                        <i>
                                            <u>{h3.userAgent ? String(h3.userAgent) : "unknown"}</u>
                                        </i>
                                        {" connected to Server "}
                                        <i>
                                            <u>{h3.server ? String(h3.server) : "unknown"}</u>
                                        </i>
                                        {" at "}
                                        <i>
                                            <u>{h3.authority ? String(h3.authority) : "unknown authority"}</u>
                                        </i>
                                    </div>
                                </td>
                            </tr>
                        ) : null}
                        <tr>
                            <td>Event count</td>
                            <td>{eventCount}</td>
                        </tr>

                        <tr>
                            <td>Events</td>
                            <td>
                                <NestedTable>
                                    <tr>
                                        <th>Category</th>
                                        <th>Event type</th>
                                        <th>Event count</th>
                                        <th>% of total occurence</th>
                                    </tr>
                                    {[...connection.getLookupTable()].map(([namespace, types], index1) =>
                                        [...types].map(([type, events], index2) => (
                                            <tr key={"evt_" + index1 + "_" + index2}>
                                                {index2 === 0 ? <td rowSpan={types.size}>{namespace}</td> : null}
                                                <td>{type}</td>
                                                <td>{events.length}</td>
                                                <td>
                                                    <StatsProgress value={events.length} max={eventCount} />
                                                </td>
                                            </tr>
                                        )),
                                    )}
                                </NestedTable>
                            </td>
                        </tr>

                        <tr>
                            <td>Frame count</td>
                            <td>{stats.frameCount}</td>
                        </tr>
                        <tr>
                            <td>Frames</td>
                            <td>
                                <NestedTable>
                                    <tr>
                                        {/* left empty on purpose to get horizontal alignment with the table above */}
                                        <th></th>
                                        <th>Frame type</th>
                                        <th>Frame count</th>
                                        <th>% of total occurence</th>
                                    </tr>
                                    {stats.frames.map(([frameType, count], i) => (
                                        <tr key={"frame_" + i}>
                                            <td></td>
                                            <td>{displayValue(frameType)}</td>
                                            <td>{count}</td>
                                            <td>
                                                <StatsProgress value={count} max={stats.frameCount} />
                                            </td>
                                        </tr>
                                    ))}
                                </NestedTable>
                            </td>
                        </tr>

                        <tr>
                            <td>Encryption level count</td>
                            <td>{stats.encryptionLevels.length}</td>
                        </tr>
                        <tr>
                            <td>Encryption levels</td>
                            {stats.encryptionLevels.length > 0 ? (
                                <td>
                                    <NestedTable>
                                        <tr>
                                            <th></th>
                                            <th>Encryption level</th>
                                            <th>Packet count</th>
                                            <th></th>
                                        </tr>
                                        {stats.encryptionLevels.map(([packetType, count], i) => (
                                            <tr key={"enc_" + i}>
                                                <td></td>
                                                <td>{displayValue(packetType)}</td>
                                                <td>{count}</td>
                                                <td></td>
                                            </tr>
                                        ))}
                                    </NestedTable>
                                </td>
                            ) : (
                                <td className="stats-danger">{NO_PACKET_TYPE}</td>
                            )}
                        </tr>

                        <tr>
                            <td>
                                Connection-level Flow Control evolution
                                <br />
                                (MAX_DATA, initial_max_data)
                                <br />
                                <br />
                                Read as: viewpoint allows the other side to send this much data on the entire connection
                                (all streams combined)
                            </td>
                            {showConnectionFC ? (
                                <td>
                                    <NestedTable>
                                        <tr>
                                            <th></th>
                                            <th>Viewpoint</th>
                                            <th>Evolution (bytes)</th>
                                            <th></th>
                                        </tr>
                                        <tr>
                                            <td></td>
                                            <td>{"Local (" + displayValue(vp.type) + ")"}</td>
                                            <td>
                                                <ValueList values={stats.connectionFC.local.values} />
                                            </td>
                                            <td></td>
                                        </tr>
                                        <tr>
                                            <td></td>
                                            <td>{"Remote (" + remoteType + ")"}</td>
                                            <td>
                                                <ValueList values={stats.connectionFC.remote.values} />
                                            </td>
                                            <td></td>
                                        </tr>
                                    </NestedTable>
                                </td>
                            ) : (
                                <td className="stats-danger">{NO_PACKET_TYPE}</td>
                            )}
                        </tr>

                        <tr>
                            <td>
                                Stream-level Flow Control evolution
                                <br />
                                (MAX_STREAM_DATA, initial_max_stream_data_*)
                                <br />
                                <br />
                                Read as: viewpoint allows the other side to send this much data on each individual
                                stream
                            </td>
                            {showStreamFC ? (
                                <td>
                                    <NestedTable>
                                        <tr>
                                            <th></th>
                                            <th>{"Local Streams (" + displayValue(vp.type) + ")"}</th>
                                            <th>Evolution</th>
                                            <th></th>
                                        </tr>
                                        <StreamRows streams={stats.streamFC.local} prefix="fcsl_" />
                                        <tr>
                                            <th></th>
                                            <th>{"Remote Streams (" + remoteType + ")"}</th>
                                            <th>Evolution</th>
                                            <th></th>
                                        </tr>
                                        <StreamRows streams={stats.streamFC.remote} prefix="fcsr_" />
                                    </NestedTable>
                                </td>
                            ) : (
                                <td className="stats-danger">{NO_STREAM_FC}</td>
                            )}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export { StatisticsConnectionRenderer };
