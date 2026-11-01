/// <reference types="node" />
// Component tests for the statistics page (parity/statistics.md §8.5 "Component", §9.15 #10): empty states,
// auto-selection, File info rows, one section per real trace, verbatim labels, danger cells, progress markup, H3
// header escaping, switching files.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QlogLoader } from "@/model/QlogLoader";
import { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { parseQlogText } from "@/qlog/parse";
import { useConfigurationStore } from "@/store/configurationStore";
import { useConnectionStore } from "@/store/connectionStore";
import StatisticsContainer from "./StatisticsContainer";

type Json = Record<string, any>;

const FIXTURES = join(__dirname, "__fixtures__");
const ROOT = join(__dirname, "../../..");

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    useConfigurationStore.getState().reset();
    useConnectionStore.setState({ groups: [], outstandingRequestCount: 0, revision: 0 });
});
afterEach(() => vi.restoreAllMocks());

function load(text: string, filename: string): QlogConnectionGroup {
    const g = QlogLoader.fromJSON(parseQlogText(text), { filename });
    if (!g) throw new Error("could not load " + filename);
    g.filename = filename;
    return g;
}

function fileOf(traces: Json[], extra: Json = {}): string {
    return JSON.stringify({
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        ...extra,
        traces,
    });
}

function traceOf(events: Array<[name: string, data: unknown]>, extra: Json = {}): Json {
    return {
        event_schemas: ["urn:ietf:params:qlog:events:quic-13"],
        vantage_point: { type: "client" },
        ...extra,
        events: events.map(([name, data], i) => ({ time: i, name, data })),
    };
}

function setGroups(groups: QlogConnectionGroup[]): void {
    act(() => {
        useConnectionStore.setState((s) => ({ groups, revision: s.revision + 1 }));
    });
}

const basic = () => load(readFileSync(join(FIXTURES, "stats-basic.qlog"), "utf8"), "stats-basic.qlog");

/** [label, value] text of the direct rows of a (non-nested) table. */
function rows(table: Element): Array<[string, string]> {
    return Array.from(table.querySelectorAll(":scope > tbody > tr")).map((tr) => {
        const cells = tr.querySelectorAll(":scope > td");
        return [cells[0]?.textContent ?? "", cells[1]?.textContent ?? ""];
    });
}

function rowCell(table: Element, label: string): HTMLTableCellElement {
    const tr = Array.from(table.querySelectorAll(":scope > tbody > tr")).find(
        (r) => r.querySelector(":scope > td")?.textContent === label,
    );
    if (!tr) throw new Error("no row " + label);
    return tr.querySelectorAll(":scope > td")[1] as HTMLTableCellElement;
}

function rowCellStartingWith(table: Element, prefix: string): HTMLTableCellElement {
    const tr = Array.from(table.querySelectorAll(":scope > tbody > tr")).find((r) =>
        (r.querySelector(":scope > td")?.textContent ?? "").startsWith(prefix),
    );
    if (!tr) throw new Error("no row " + prefix);
    return tr.querySelectorAll(":scope > td")[1] as HTMLTableCellElement;
}

/** Text of every cell of every row of a nested table (th and td). */
function nestedRows(cell: Element): string[][] {
    return Array.from(cell.querySelectorAll("table > tbody > tr")).map((tr) =>
        Array.from(tr.children).map((c) => c.textContent ?? ""),
    );
}

const traceTables = (c: HTMLElement) => Array.from(c.querySelectorAll("table.stats-trace-table"));

describe("empty states", () => {
    it("no files and nothing loading: danger alert, empty container", () => {
        const { container } = render(<StatisticsContainer />);
        expect(screen.getByText("Select a file via the dropdown(s) below to view its statistics")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Please load a trace file to visualize it");
        expect(screen.getByRole("alert")).toHaveClass("alert-danger");
        const box = container.querySelector("#statistics-container")!;
        expect(box).toBeInTheDocument();
        expect(box.childElementCount).toBe(0);
        expect(container.querySelector("select")).toBeNull();
    });

    it("files loading: warning alert", () => {
        useConnectionStore.setState({ outstandingRequestCount: 1 });
        render(<StatisticsContainer />);
        expect(screen.getByRole("alert")).toHaveTextContent("Loading files...");
        expect(screen.getByRole("alert")).toHaveClass("alert-warning");
    });
});

describe("auto-selection and file selector", () => {
    it("selects groups[0] and shows its option label", () => {
        const a = basic();
        const b = load(fileOf([traceOf([])], { title: "B title", description: "B desc" }), "b.qlog");
        setGroups([a, b]);
        const { container } = render(<StatisticsContainer />);
        expect(useConfigurationStore.getState().statisticsConfig.group).toBe(a);
        const select = container.querySelector("select")!;
        expect(select.className).toBe("form-select mb-3 mt-3");
        const options = Array.from(select.options).filter((o) => !o.hidden);
        expect(options.map((o) => o.textContent)).toEqual([
            "stats-basic.qlog (stats fixture : )",
            "b.qlog (B title : B desc)",
        ]);
        expect(select.options[select.selectedIndex].textContent).toBe("stats-basic.qlog (stats fixture : )");
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("auto-selects the first file once it finishes loading", () => {
        const { container } = render(<StatisticsContainer />);
        expect(container.querySelector("h3")).toBeNull();
        const a = basic();
        setGroups([a]);
        expect(useConfigurationStore.getState().statisticsConfig.group).toBe(a);
        expect(container.querySelector("h3")).toHaveTextContent("File info");
    });

    it("switching the file re-renders with the new numbers (no accumulation)", () => {
        const a = basic();
        const b = load(
            fileOf([
                traceOf([["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [{ frame_type: "ping" }] }]]),
            ]),
            "b.qlog",
        );
        setGroups([a, b]);
        const { container } = render(<StatisticsContainer />);
        expect(rowCell(traceTables(container)[0], "Frame count").textContent).toBe("10");

        const select = container.querySelector("select")!;
        const bValue = Array.from(select.options).find((o) => o.textContent?.startsWith("b.qlog"))!.value;
        fireEvent.change(select, { target: { value: bValue } });
        expect(useConfigurationStore.getState().statisticsConfig.group).toBe(b);
        expect(rowCell(traceTables(container)[0], "Frame count").textContent).toBe("1");
        expect(rowCell(traceTables(container)[0], "Event count").textContent).toBe("1");

        fireEvent.change(select, {
            target: { value: Array.from(select.options).find((o) => o.textContent?.startsWith("stats-basic"))!.value },
        });
        expect(rowCell(traceTables(container)[0], "Frame count").textContent).toBe("10");
    });

    it("removing the selected file re-selects groups[0] (FIX app-shell Q11)", () => {
        const a = basic();
        const b = load(fileOf([traceOf([])]), "b.qlog");
        setGroups([a, b]);
        render(<StatisticsContainer />);
        act(() => useConnectionStore.getState().removeGroup(a));
        expect(useConfigurationStore.getState().statisticsConfig.group).toBe(b);
    });
});

describe("File info table", () => {
    it("rows in qvis order; Title / Description hidden when empty; no Summary; NEW rows", () => {
        const a = basic();
        setGroups([a]);
        const { container } = render(<StatisticsContainer />);
        const headings = Array.from(container.querySelectorAll("#statistics-container h3")).map((h) => h.textContent);
        expect(headings).toEqual(["File info", "Trace 1 info"]);

        const table = container.querySelector("table.stats-file-table")!;
        expect(Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["Aspect", "Value"]);
        expect(table.querySelector("thead")).toHaveClass("stats-thead-dark");
        expect(table.querySelector("col")!.getAttribute("width")).toBe("20%");
        expect(rows(table)).toEqual([
            ["Filename", "stats-basic.qlog"],
            ["Title", "stats fixture"],
            ["qlog version", "urn:ietf:params:qlog:file:contained"],
            ["Serialization format", "application/qlog+json"],
            ["Trace count", "1"],
            ["Total event count", "10"],
            // NEW (S4): the golden vector logs loglevel:info without listing its schema
            ["Diagnostics", "info: Some event namespaces are not listed in the trace's event_schemas"],
        ]);
    });

    it("a group without connections: Trace count 0, Total event count 0, no trace sections (gaps G10)", () => {
        const g = new QlogConnectionGroup();
        g.filename = "empty.qlog";
        g.version = "urn:ietf:params:qlog:file:contained";
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        expect(Array.from(container.querySelectorAll("#statistics-container h3")).map((h) => h.textContent)).toEqual([
            "File info",
        ]);
        const fileTable = container.querySelector("table.stats-file-table")!;
        expect(rows(fileTable)).toEqual([
            ["Filename", "empty.qlog"],
            ["qlog version", "urn:ietf:params:qlog:file:contained"],
            ["Trace count", "0"],
            ["Total event count", "0"],
        ]);
    });

    it("Description and Diagnostics rows", () => {
        const g = load(
            fileOf([traceOf([["quic:packet_sent", {}]], { vantage_point: undefined, event_schemas: [] })], {
                description: "d",
            }),
            "d.qlog",
        );
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        const table = container.querySelector("table.stats-file-table")!;
        const labels = rows(table).map((r) => r[0]);
        expect(labels).toEqual([
            "Filename",
            "Description",
            "qlog version",
            "Serialization format",
            "Trace count",
            "Total event count",
            "Diagnostics",
        ]);
        const diag = rowCell(table, "Diagnostics");
        expect(diag.innerHTML).toContain("<br>");
        for (const d of g.diagnostics) {
            expect(diag.textContent).toContain(d.level + ": " + d.message);
        }
    });
});

describe("Trace N info", () => {
    it("golden vector rows, labels and values", () => {
        setGroups([basic()]);
        const { container } = render(<StatisticsContainer />);
        const [table] = traceTables(container);
        expect(table.querySelector("thead")).toBeNull();
        expect(rows(table).map((r) => r[0])).toEqual([
            "Title",
            "Vantage point",
            "Event schemas",
            "H3 connection headers",
            "Event count",
            "Events",
            "Frame count",
            "Frames",
            "Encryption level count",
            "Encryption levels",
            "Connection-level Flow Control evolution(MAX_DATA, initial_max_data)Read as: viewpoint allows the other side to send this much data on the entire connection (all streams combined)",
            "Stream-level Flow Control evolution(MAX_STREAM_DATA, initial_max_stream_data_*)Read as: viewpoint allows the other side to send this much data on each individual stream",
        ]);
        expect(rowCell(table, "Title").textContent).toBe("T");
        expect(rowCell(table, "Vantage point").innerHTML).toBe("<span>client</span>");
        expect(rowCell(table, "Event schemas").innerHTML).toBe(
            "urn:ietf:params:qlog:events:quic-13<br>urn:ietf:params:qlog:events:http3-13",
        );

        // H3 header value with markup is text (FIX Q3)
        const h3 = rowCell(table, "H3 connection headers");
        expect(h3.textContent).toBe("User Agent ua/1 connected to Server <b>srv</b> at example.org");
        expect(h3.querySelector("b")).toBeNull();
        expect(Array.from(h3.querySelectorAll("i > u")).map((u) => u.textContent)).toEqual([
            "ua/1",
            "<b>srv</b>",
            "example.org",
        ]);

        expect(rowCell(table, "Event count").textContent).toBe("10");
        const events = nestedRows(rowCell(table, "Events"));
        expect(events[0]).toEqual(["Category", "Event type", "Event count", "% of total occurence"]);
        expect(events.slice(1)).toEqual([
            ["quic", "parameters_set", "3", "30.00"],
            ["packet_sent", "2", "20.00"],
            ["packet_received", "2", "20.00"],
            ["http3", "frame_created", "1", "10.00"],
            ["frame_parsed", "1", "10.00"],
            ["loglevel", "info", "1", "10.00"],
        ]);
        const quicCell = rowCell(table, "Events").querySelector("tbody > tr:nth-child(2) > td")!;
        expect(quicCell.getAttribute("rowspan")).toBe("3");

        expect(rowCell(table, "Frame count").textContent).toBe("10");
        expect(nestedRows(rowCell(table, "Frames"))).toEqual([
            ["", "Frame type", "Frame count", "% of total occurence"],
            ["", "crypto", "2", "20.00"],
            ["", "padding", "1", "10.00"],
            ["", "ack", "1", "10.00"],
            ["", "headers", "2", "20.00"],
            ["", "stream", "1", "10.00"],
            ["", "max_data", "1", "10.00"],
            ["", "max_stream_data", "2", "20.00"],
        ]);

        expect(rowCell(table, "Encryption level count").textContent).toBe("2");
        expect(nestedRows(rowCell(table, "Encryption levels"))).toEqual([
            ["", "Encryption level", "Packet count", ""],
            ["", "initial", "2", ""],
            ["", "1RTT", "2", ""],
        ]);

        const connFC = rowCellStartingWith(table, "Connection-level Flow Control evolution");
        expect(nestedRows(connFC)).toEqual([
            ["", "Viewpoint", "Evolution (bytes)", ""],
            ["", "Local (client)", "10002000", ""],
            ["", "Remote (server)", "5000", ""],
        ]);
        expect(Array.from(connFC.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["1000", "2000", "5000"]);

        const streamFC = rowCellStartingWith(table, "Stream-level Flow Control evolution");
        expect(nestedRows(streamFC)).toEqual([
            ["", "Local Streams (client)", "Evolution", ""],
            ["", "bidi_local", "100", ""],
            ["", "bidi_remote", "200", ""],
            ["", "uni_remote", "300", ""],
            ["", "3", "150", ""],
            ["", "Remote Streams (server)", "Evolution", ""],
            ["", "bidi_local", "400", ""],
            ["", "0", "7000", ""],
        ]);
        expect(streamFC.querySelectorAll("th")).toHaveLength(8);

        const label = rows(table).find((r) => r[0].startsWith("Connection-level"))!;
        const labelCell = Array.from(table.querySelectorAll(":scope > tbody > tr > td")).find(
            (td) => td.textContent === label[0],
        )!;
        expect(labelCell.innerHTML).toBe(
            "Connection-level Flow Control evolution<br>(MAX_DATA, initial_max_data)<br><br>Read as: viewpoint allows the other side to send this much data on the entire connection (all streams combined)",
        );
    });

    it("progress bar markup (bootstrap-vue b-progress)", () => {
        setGroups([basic()]);
        const { container } = render(<StatisticsContainer />);
        const bar = container.querySelector(".stats-progress > .stats-progress-bar")!;
        expect(bar.getAttribute("role")).toBe("progressbar");
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("10");
        expect(bar.getAttribute("aria-valuenow")).toBe("3.00");
        expect((bar as HTMLElement).style.width).toBe("30%");
        expect(bar.textContent).toBe("30.00");
    });

    it("one section per real trace; generated sibling excluded; TraceError placeholder", () => {
        const g = load(
            fileOf([
                traceOf([["quic:packet_sent", { header: { packet_type: "1RTT" } }]], {
                    title: "first",
                    vantage_point: { name: "probe", type: "network", flow: "client" },
                }),
                { error_description: "boom", uri: "x.qlog" },
                traceOf([], { vantage_point: { type: "network" } }),
            ]),
            "multi.qlog",
        );
        const clone = g.getConnections()[0].clone();
        clone.wasAutoGenerated = true;
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        const headings = Array.from(container.querySelectorAll("#statistics-container h3")).map((h) => h.textContent);
        expect(headings).toEqual(["File info", "Trace 1 info", "Trace 2 info", "Trace 3 info"]);
        expect(rowCell(container.querySelector("table.stats-file-table")!, "Trace count").textContent).toBe("3");
        expect(rowCell(container.querySelector("table.stats-file-table")!, "Total event count").textContent).toBe("1");

        const [t1, t2, t3] = traceTables(container);
        expect(rowCell(t1, "Title").textContent).toBe("first");
        expect(rowCell(t1, "Vantage point").innerHTML).toBe(
            "<span>probe<br></span><span>network : with client perspective</span>",
        );
        expect(nestedRows(rowCellStartingWith(t1, "Connection-level"))[1]).toEqual(["", "Local (network)", "", ""]);
        expect(nestedRows(rowCellStartingWith(t1, "Connection-level"))[2]).toEqual(["", "Remote (client)", "", ""]);

        // TraceError placeholder: Title ERROR (FIX Q1), Description uri : error_description, no events (FIX Q7)
        expect(rowCell(t2, "Title").textContent).toBe("ERROR");
        expect(rowCell(t2, "Description").textContent).toBe("x.qlog : boom");
        expect(rowCell(t2, "Vantage point").textContent).toBe("unknown");
        expect(rowCell(t2, "Event count").textContent).toBe("0");
        expect(nestedRows(rowCell(t2, "Events"))).toEqual([
            ["Category", "Event type", "Event count", "% of total occurence"],
        ]);
        expect(rowCell(t2, "Frame count").textContent).toBe("0");
        expect(rowCell(t2, "Encryption level count").textContent).toBe("0");
        const danger = Array.from(t2.querySelectorAll("td.stats-danger")).map((td) => td.textContent);
        expect(danger).toEqual([
            "None of the events in this trace had data.header.packet_type set!",
            "None of the events in this trace had data.header.packet_type set!",
            "No stream level flow control limits set",
        ]);
        expect(t2.querySelector("td.stats-danger")).not.toHaveClass("table-danger");

        // network without flow: "network : with  perspective"
        expect(rowCell(t3, "Vantage point").textContent).toBe("network : with  perspective");
    });

    it("no vantage_point: loader default name and unknown type", () => {
        setGroups([load(fileOf([traceOf([], { vantage_point: undefined, event_schemas: [] })]), "novp.qlog")]);
        const { container } = render(<StatisticsContainer />);
        const [t] = traceTables(container);
        expect(rowCell(t, "Vantage point").innerHTML).toBe("<span>No VantagePoint set<br></span><span>unknown</span>");
        expect(rows(t).map((r) => r[0])).not.toContain("Event schemas");
    });

    it("FC tables shown without packet events (FIX Q5) and for local-only stream limits (FIX Q6)", () => {
        const g = load(
            fileOf([
                traceOf([
                    [
                        "quic:parameters_set",
                        { initiator: "local", initial_max_data: 11, initial_max_stream_data_bidi_local: 12 },
                    ],
                ]),
            ]),
            "fc.qlog",
        );
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        const [t] = traceTables(container);
        expect(nestedRows(rowCellStartingWith(t, "Connection-level"))).toEqual([
            ["", "Viewpoint", "Evolution (bytes)", ""],
            ["", "Local (client)", "11", ""],
            ["", "Remote (server)", "", ""],
        ]);
        expect(nestedRows(rowCellStartingWith(t, "Stream-level"))).toEqual([
            ["", "Local Streams (client)", "Evolution", ""],
            ["", "bidi_local", "12", ""],
            ["", "Remote Streams (server)", "Evolution", ""],
        ]);
        expect(rowCell(t, "Encryption levels")).toHaveClass("stats-danger");
    });

    it("NEW rows QUIC version / ALPN only when present (§9.15 #10)", () => {
        const g = load(
            fileOf([
                traceOf([
                    ["quic:version_information", { client_versions: ["00000001"], chosen_version: "00000001" }],
                    ["quic:alpn_information", { chosen_alpn: { byte_value: "6833" } }],
                ]),
                traceOf([]),
            ]),
            "id.qlog",
        );
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        const [t1, t2] = traceTables(container);
        const labels = rows(t1).map((r) => r[0]);
        expect(labels.slice(0, 4)).toEqual(["Vantage point", "Event schemas", "QUIC version", "ALPN"]);
        expect(rowCell(t1, "QUIC version").textContent).toBe("00000001");
        expect(rowCell(t1, "ALPN").textContent).toBe("h3");
        expect(rows(t2).map((r) => r[0])).not.toContain("QUIC version");
        expect(rows(t2).map((r) => r[0])).not.toContain("ALPN");
    });

    it("H3 row fallbacks: unknown / unknown authority", () => {
        const g = load(
            fileOf([
                traceOf([
                    [
                        "http3:frame_created",
                        {
                            stream_id: 0,
                            frame: { frame_type: "headers", headers: [{ name: "user-agent", value: "" }] },
                        },
                    ],
                ]),
            ]),
            "h3.qlog",
        );
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        expect(rowCell(traceTables(container)[0], "H3 connection headers").textContent).toBe(
            "User Agent unknown connected to Server unknown at unknown authority",
        );
    });

    it("H3 row values are concatenated like qvis (String(v)), not JSON like mustache interpolation", () => {
        const headers = [
            { name: "user-agent", value: { a: 1 } },
            { name: "server", value: ["x", "y"] },
            { name: ":authority", value: 443 },
        ];
        const g = load(
            fileOf([traceOf([["http3:frame_created", { stream_id: 0, frame: { frame_type: "headers", headers } }]])]),
            "h3.qlog",
        );
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        expect(rowCell(traceTables(container)[0], "H3 connection headers").textContent).toBe(
            "User Agent [object Object] connected to Server x,y at 443",
        );
    });

    it("pre-final event names are listed in Events but not interpreted (strict latest drafts)", () => {
        const pkt = { header: { packet_type: "1RTT" }, frames: [{ frame_type: "max_data", maximum: 5 }] };
        const g = load(
            fileOf([
                traceOf([
                    ["transport:parameters_set", { initiator: "local", initial_max_data: 9 }],
                    ["transport:packet_sent", pkt],
                ]),
            ]),
            "quicgo.qlog",
        );
        setGroups([g]);
        const { container } = render(<StatisticsContainer />);
        const t = traceTables(container)[0];
        expect(nestedRows(rowCell(t, "Events"))).toEqual([
            ["Category", "Event type", "Event count", "% of total occurence"],
            ["transport", "parameters_set", "1", "50.00"],
            ["packet_sent", "1", "50.00"],
        ]);
        expect(rowCell(t, "Frame count").textContent).toBe("0");
        expect(rowCell(t, "Encryption level count").textContent).toBe("0");
        expect(Array.from(t.querySelectorAll("td.stats-danger")).map((td) => td.textContent)).toEqual([
            "None of the events in this trace had data.header.packet_type set!",
            "None of the events in this trace had data.header.packet_type set!",
            "No stream level flow control limits set",
        ]);
    });

    it("renders a real generated two-trace file", () => {
        const text = readFileSync(join(ROOT, "tests/fixtures/latest/stats-newcid-both.qlog"), "utf8");
        setGroups([load(text, "stats-newcid-both.qlog")]);
        const { container } = render(<StatisticsContainer />);
        const [t1, t2] = traceTables(container);
        expect(rowCell(t1, "Vantage point").textContent).toBe("quic-go v0.64.1+qlog-latestclient");
        expect(rowCell(t2, "Vantage point").textContent).toBe("quic-go v0.64.1+qlog-latestserver");
        expect(rowCell(t1, "ALPN").textContent).toBe("h3");
        expect(rowCell(t1, "H3 connection headers").textContent).toMatch(
            /^User Agent .+ connected to Server .+ at .+$/,
        );
        expect(nestedRows(rowCellStartingWith(t1, "Connection-level"))[1][1]).toBe("Local (client)");
        expect(nestedRows(rowCellStartingWith(t2, "Connection-level"))[1][1]).toBe("Local (server)");
        expect(nestedRows(rowCellStartingWith(t2, "Connection-level"))[2][1]).toBe("Remote (client)");
        expect(container.querySelectorAll("td.stats-danger")).toHaveLength(0);
    });
});

describe("DOM parity with qvis's compiled Vue templates (parity check on identical data)", () => {
    /** The td / th of `root` whose whole text is `text`. */
    function cellWithText(root: Element, text: string): Element {
        const found = Array.from(root.querySelectorAll("td, th")).find((c) => c.textContent === text);
        if (!found) throw new Error("no cell " + text);
        return found;
    }
    const nodes = (el: Element) =>
        Array.from(el.childNodes).map((n) => (n.nodeType === 3 ? "#" + n.textContent : (n as Element).tagName));

    it("interpolated labels are single text nodes, like `Local ({{type}})` (split nodes shift glyphs)", () => {
        const network = load(
            fileOf([traceOf([], { vantage_point: { name: "tap", type: "network", flow: "client" } })]),
            "net.qlog",
        );
        setGroups([basic(), network]);
        const { container } = render(<StatisticsContainer />);
        const heading = container.querySelectorAll("#statistics-container h3")[1];
        expect(nodes(heading)).toEqual(["#Trace 1 info"]);
        const [t] = traceTables(container);
        for (const label of [
            "Local (client)",
            "Remote (server)",
            "Local Streams (client)",
            "Remote Streams (server)",
        ]) {
            expect(nodes(cellWithText(t, label))).toEqual(["#" + label]);
        }
        // v-html "User Agent <i><u>ua</u></i> connected to Server <i>...</i> at <i>...</i>"
        expect(nodes(rowCell(t, "H3 connection headers").firstElementChild!)).toEqual([
            "#User Agent ",
            "I",
            "# connected to Server ",
            "I",
            "# at ",
            "I",
        ]);

        const select = container.querySelector("select")!;
        const netValue = Array.from(select.options).find((o) => o.textContent?.startsWith("net.qlog"))!.value;
        fireEvent.change(select, { target: { value: netValue } });
        const vp = rowCell(traceTables(container)[0], "Vantage point");
        expect(nodes(vp.lastElementChild!)).toEqual(["#network : with client perspective"]);
    });

    it("rows are keyed by position like qvis's v-for keys: a file switch patches them in place (bars animate)", () => {
        const msd = (id: number) => ({ frame_type: "max_stream_data", stream_id: id, maximum: 100 + id });
        const a = load(
            fileOf([
                traceOf([
                    ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [msd(4), msd(8)] }],
                    ["quic:packet_received", { header: { packet_type: "1RTT" }, frames: [] }],
                ]),
            ]),
            "a.qlog",
        );
        const b = load(
            fileOf([
                traceOf([
                    ["quic:packet_received", { header: { packet_type: "1RTT" }, frames: [] }],
                    ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [msd(8), msd(4)] }],
                    ["quic:packet_sent", { header: { packet_type: "1RTT" }, frames: [] }],
                ]),
            ]),
            "b.qlog",
        );
        setGroups([a, b]);
        const { container } = render(<StatisticsContainer />);
        const eventBars = () =>
            Array.from(rowCell(traceTables(container)[0], "Events").querySelectorAll('[role="progressbar"]'));
        const streamRows = () =>
            Array.from(rowCellStartingWith(traceTables(container)[0], "Stream-level").querySelectorAll("tbody > tr"));
        const barsA = eventBars();
        const rowsA = streamRows();
        expect(barsA.map((p) => p.parentElement!.parentElement!.parentElement!.textContent)).toEqual([
            "quicpacket_sent150.00",
            "packet_received150.00",
        ]);

        const select = container.querySelector("select")!;
        fireEvent.change(select, {
            target: { value: Array.from(select.options).find((o) => o.textContent?.startsWith("b.qlog"))!.value },
        });
        const barsB = eventBars();
        // same DOM element per position (Vue: 'evt_' + index1 + '_' + index2), only its width / label change
        expect(barsB[0]).toBe(barsA[0]);
        expect(barsB[1]).toBe(barsA[1]);
        expect(barsB.map((p) => p.textContent)).toEqual(["33.33", "66.67"]);
        expect(nestedRows(rowCell(traceTables(container)[0], "Events"))[1].slice(0, 3)).toEqual([
            "quic",
            "packet_received",
            "1",
        ]);
        // stream rows likewise ('fcsl_' + index6): stream 8 now first, in the row element stream 4 used
        const rowsB = streamRows();
        expect(rowsB[1]).toBe(rowsA[1]);
        expect(rowsB[1].textContent).toBe("8108");
        expect(rowsB[2]).toBe(rowsA[2]);
        expect(rowsB[2].textContent).toBe("4104");
    });
});
