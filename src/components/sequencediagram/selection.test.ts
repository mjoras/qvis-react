import type { QlogConnection } from "@/model/QlogConnection";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { evt, loadGroup, seqTrace, type Json } from "./__fixtures__/seq";
import { ensureMoreThanOneTrace } from "./mirror";
import {
    addDefaultTrace,
    allowCustomTimeOffset,
    connectionIsUnknownPerspective,
    defaultSelection,
    firstAvailableConnection,
    selectConnection,
} from "./selection";

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const E = [evt(0, "quic:connection_started", {})];
const group = (...vps: (Json | undefined)[]): QlogConnectionGroup =>
    loadGroup(vps.map((vp, i) => seqTrace(E, vp, { title: "t" + i })));
const conns = (sel: { connection: QlogConnection }[]) => sel.map((s) => s.connection);
const wrap = (connection: QlogConnection, timeOffset = 0) => ({ connection, timeOffset });

describe("selectConnection (§3.15)", () => {
    it("single-trace file: A in selector 0, D in selector 1", () => {
        const g = group({ type: "client" });
        const client = g.getConnections()[0];
        expect(conns(selectConnection([], 0, client))).toEqual([client]);
        // the renderer mirrors it: [client, GENERATED server]
        const shown = ensureMoreThanOneTrace([wrap(client)]);
        const generated = shown[1].connection;
        // picking the generated trace in selector 0 still selects the original (case A)
        expect(conns(selectConnection(shown, 0, generated))).toEqual([client]);
        // selector 1: the generated server -> types differ -> set at index 1
        expect(conns(selectConnection(shown, 1, generated))).toEqual([client, generated]);
        // selector 1: the client again -> all the same -> the first non-generated one
        expect(conns(selectConnection(shown, 1, client))).toEqual([client]);
    });

    it("two-trace file: the pair, client first, from any selector (B); SQ1 default", () => {
        const g = group({ type: "server" }, { type: "client" });
        const [server, client] = g.getConnections();
        expect(conns(selectConnection([], 0, server))).toEqual([client, server]);
        expect(conns(selectConnection([wrap(client), wrap(server)], 1, client))).toEqual([client, server]);
        expect(conns(defaultSelection([g])!)).toEqual([client, server]);
        const g2 = group({ type: "client" }, { type: "server" });
        expect(conns(defaultSelection([g2])!)).toEqual(g2.getConnections());
    });

    it("two traces with the same perspective (group_id split): just the selected one", () => {
        const g = group({ type: "client" }, { type: "client" });
        const [, second] = g.getConnections();
        expect(conns(selectConnection([], 0, second))).toEqual([second]);
    });

    it("SQ8 FIX: server + unknown falls back to a plain replacement", () => {
        const g = group({ type: "server" }, undefined);
        const [server, unknown] = g.getConnections();
        const other = group({ type: "client" }).getConnections()[0];
        expect(conns(selectConnection([wrap(other), wrap(other)], 1, unknown))).toEqual([other, unknown]);
        expect(conns(selectConnection([wrap(other)], 0, server))).toEqual([server]);
    });

    it("more traces (C): the selected one and the following ones with another perspective", () => {
        const g = group({ type: "client" }, { type: "network" }, { type: "network" }, { type: "server" });
        const all = g.getConnections();
        expect(conns(selectConnection([], 0, all[0]))).toEqual(all);
        const g2 = group({ type: "client" }, { type: "network", flow: "client" }, { type: "server" });
        expect(conns(selectConnection([], 0, g2.getConnections()[0]))).toEqual([g2.getConnections()[0]]);
        const g3 = group({ type: "client" }, { type: "client" }, { type: "client" });
        expect(conns(selectConnection([], 0, g3.getConnections()[1]))).toEqual([g3.getConnections()[1]]);
    });

    it("two single-trace files: [client, GENERATED server] -> pick the server file in selector 1 (D)", () => {
        const client = group({ type: "client" }).getConnections()[0];
        const server = group({ type: "server" }).getConnections()[0];
        const shown = ensureMoreThanOneTrace([wrap(client)]);
        expect(conns(selectConnection(shown, 1, server))).toEqual([client, server]);
    });

    it("network allowance: all network traces keep the pick", () => {
        const a = group({ type: "network", flow: "client" }).getConnections()[0];
        const b = group({ type: "network", flow: "client" }).getConnections()[0];
        expect(conns(selectConnection([wrap(a), wrap(a)], 1, b))).toEqual([a, b]);
    });
});

describe("defaults, add trace, offsets, alert", () => {
    it("Q12: the first group that has a connection", () => {
        const empty = loadGroup([seqTrace(E, { type: "client" })]);
        // simulate a file without connections
        vi.spyOn(empty, "getConnections").mockReturnValue([]);
        const g = group({ type: "server" });
        expect(firstAvailableConnection([empty, g])).toBe(g.getConnections()[0]);
        expect(defaultSelection([empty])).toBeUndefined();
    });

    it("Add trace appends the first trace of the first file, even when already shown", () => {
        const g = group({ type: "client" });
        const c = g.getConnections()[0];
        const current = [wrap(c), wrap(c)];
        const next = addDefaultTrace(current, [g]);
        expect(conns(next)).toEqual([c, c, c]);
        expect(current).toHaveLength(2);
    });

    it("Latency offset only for index > 0 without generated traces", () => {
        const c = group({ type: "client" }).getConnections()[0];
        const s = group({ type: "server" }).getConnections()[0];
        expect(allowCustomTimeOffset([wrap(c), wrap(s)], 0)).toBe(false);
        expect(allowCustomTimeOffset([wrap(c), wrap(s)], 1)).toBe(true);
        const mirrored = ensureMoreThanOneTrace([wrap(c)]);
        expect(allowCustomTimeOffset(mirrored, 1)).toBe(false);
    });

    it("unknown vantage point alert (LD6: any non-standard type)", () => {
        const u = group(undefined).getConnections()[0];
        expect(connectionIsUnknownPerspective([wrap(u)])).toBe(true);
        const t = group({ type: "transport" }).getConnections()[0];
        const mirrored = ensureMoreThanOneTrace([wrap(t)]);
        expect(mirrored[0].connection.wasAutoGenerated).toBe(true); // guessed server: client mirror on the left
        expect(connectionIsUnknownPerspective(mirrored)).toBe(true);
        expect(connectionIsUnknownPerspective([wrap(group({ type: "network" }).getConnections()[0])])).toBe(false);
        expect(connectionIsUnknownPerspective([])).toBe(false);
    });
});
