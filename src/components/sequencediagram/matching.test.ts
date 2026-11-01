import type { QlogConnection } from "@/model/QlogConnection";
import { loadGroup, pkt, seqTrace, type Json } from "./__fixtures__/seq";
import { calculateConnections, effectivePerspective, LOST_LEFT, LOST_RIGHT, traceRoles } from "./matching";
import { ensureMoreThanOneTrace } from "./mirror";

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function conn(events: Json[], vp: Json | undefined): QlogConnection {
    return loadGroup([seqTrace(events, vp)]).getConnections()[0];
}

const CLIENT_EVENTS = [
    pkt(0, "sent", "initial", 0),
    pkt(1, "sent", "initial", 1), // lost
    pkt(30, "received", "initial", 0),
    pkt(31, "sent", "handshake", 0),
    pkt(32, "sent", "1RTT", 0),
];
const SERVER_EVENTS = [
    pkt(10, "received", "initial", 0),
    pkt(11, "sent", "initial", 0),
    pkt(12, "sent", "handshake", 0), // lost
    pkt(40, "received", "handshake", "0"), // string PN matches number PN
    pkt(41, "received", "1RTT", 0),
];

/** [start index, end index] pairs of a target table */
function pairs(targets: Int32Array): number[][] {
    const out: number[][] = [];
    targets.forEach((t, i) => {
        if (t >= 0) out.push([i, t]);
    });
    return out;
}

describe("calculateConnections (§3.7)", () => {
    it("client/server baseline equals qvis: right = client.sent -> server.received, left = server.sent -> client.received", () => {
        const c = conn(CLIENT_EVENTS, { type: "client" });
        const s = conn(SERVER_EVENTS, { type: "server" });
        const m = calculateConnections([c, s]);
        expect(pairs(m.right[0])).toEqual([
            [0, 0],
            [3, 3],
            [4, 4],
        ]);
        expect(pairs(m.left[1])).toEqual([[1, 2]]);
        expect(Array.from(m.lost[0])).toEqual([0, LOST_RIGHT, 0, 0, 0]);
        expect(Array.from(m.lost[1])).toEqual([0, 0, LOST_LEFT, 0, 0]);
        expect(pairs(m.right[1])).toEqual([]);
        expect(pairs(m.left[0])).toEqual([]);
    });

    it("packet numbers are matched per packet type (number space)", () => {
        const c = conn([pkt(0, "sent", "initial", 0), pkt(1, "sent", "1RTT", 0)], { type: "client" });
        const s = conn([pkt(5, "received", "1RTT", 0), pkt(6, "received", "initial", 0)], { type: "server" });
        const m = calculateConnections([c, s]);
        expect(pairs(m.right[0])).toEqual([
            [0, 1],
            [1, 0],
        ]);
    });

    it("PN-less retry / version negotiation / stateless reset get no arrow and no loss (SQ31)", () => {
        const c = conn(
            [pkt(0, "sent", "retry"), pkt(1, "sent", "version_negotiation"), pkt(2, "sent", "stateless_reset")],
            { type: "client" },
        );
        const s = conn([pkt(5, "received", "initial", 0)], { type: "server" });
        const m = calculateConnections([c, s]);
        expect(pairs(m.right[0])).toEqual([]);
        expect(Array.from(m.lost[0])).toEqual([0, 0, 0]);
        expect(console.warn).not.toHaveBeenCalledWith(
            "SequenceDiagram:calculateConnections : event data does not have the header.packet_number field, which is required",
            expect.anything(),
        );
    });

    it("packet_received with trigger keys_available ends the arrow", () => {
        const c = conn([pkt(0, "sent", "handshake", 0)], { type: "client" });
        const s = conn(
            [
                { time: 4, name: "quic:packet_buffered", data: { header: { packet_type: "handshake" } } },
                pkt(9, "received", "handshake", 0, undefined, { trigger: "keys_available" }),
            ],
            { type: "server" },
        );
        expect(pairs(calculateConnections([c, s]).right[0])).toEqual([[0, 1]]);
    });

    it("every sent packet is lost when the peer has no end events", () => {
        const c = conn([pkt(0, "sent", "initial", 0), pkt(1, "sent", "initial", 1)], { type: "client" });
        const s = conn(
            [{ time: 3, name: "http3:frame_created", data: { stream_id: 0, frame: { frame_type: "data" } } }],
            {
                type: "server",
            },
        );
        const m = calculateConnections([c, s]);
        expect(Array.from(m.lost[0])).toEqual([LOST_RIGHT, LOST_RIGHT]);
    });

    it("windowed search: +-10 % of the end events, clamped to [200, 1000], around the last match", () => {
        // 3000 end events (window 300): a match 400 positions after the last one is not found
        const end: Json[] = [];
        for (let i = 0; i < 3000; ++i) end.push(pkt(10 + i, "received", "1RTT", i));
        const c = conn([pkt(0, "sent", "1RTT", 0), pkt(1, "sent", "1RTT", 400), pkt(2, "sent", "1RTT", 250)], {
            type: "client",
        });
        const s = conn(end, { type: "server" });
        const m = calculateConnections([c, s]);
        expect(pairs(m.right[0])).toEqual([
            [0, 0],
            [2, 250],
        ]);
        expect(m.lost[0][1]).toBe(LOST_RIGHT);
        // small traces: a window of at least 200 (500 end events: 10 % would be 50)
        const small: Json[] = [];
        for (let i = 0; i < 500; ++i) small.push(pkt(10 + i, "received", "1RTT", i));
        const m2 = calculateConnections([
            conn([pkt(0, "sent", "1RTT", 0), pkt(1, "sent", "1RTT", 199), pkt(2, "sent", "1RTT", 400)], {
                type: "client",
            }),
            conn(small, { type: "server" }),
        ]);
        expect(pairs(m2.right[0])).toEqual([
            [0, 0],
            [1, 199],
        ]);
        expect(m2.lost[0][2]).toBe(LOST_RIGHT); // 400 is 201 positions after the last match
    });

    it("duplicate packet numbers match the first candidate in the window", () => {
        const c = conn([pkt(0, "sent", "1RTT", 5)], { type: "client" });
        const s = conn([pkt(1, "received", "1RTT", 5), pkt(2, "received", "1RTT", 5)], { type: "server" });
        expect(pairs(calculateConnections([c, s]).right[0])).toEqual([[0, 0]]);
    });
});

describe("SQ9: roles of 3+ traces and same-perspective pairs", () => {
    it("effective perspectives and roles", () => {
        const net = conn([], { type: "network", flow: "client" });
        expect(effectivePerspective(net)).toBe("client");
        expect(effectivePerspective(conn([], { type: "network" }))).toBeUndefined();
        expect(effectivePerspective(conn([], { type: "transport" }))).toBeUndefined();
        const unknown = conn([], undefined);
        const server = conn([], { type: "server" });
        expect(traceRoles([unknown, server]).roles).toEqual(["client", "server"]);
        expect(traceRoles([server, unknown]).roles).toEqual(["server", "client"]);
        expect(traceRoles([unknown, unknown]).roles).toEqual(["client", "server"]);
    });

    it("[client, network(client), server]: client -> network -> server and back, no reversed arrows", () => {
        const c = conn([pkt(0, "sent", "1RTT", 1), pkt(30, "received", "1RTT", 9)], { type: "client" });
        const n = conn([pkt(5, "sent", "1RTT", 1), pkt(25, "received", "1RTT", 9)], {
            type: "network",
            flow: "client",
        });
        const s = conn([pkt(10, "received", "1RTT", 1), pkt(20, "sent", "1RTT", 9)], { type: "server" });
        const m = calculateConnections([c, n, s]);
        expect(pairs(m.right[0])).toEqual([[0, 0]]); // client sent -> network "sent" (client's flow)
        expect(pairs(m.right[1])).toEqual([[0, 0]]); // network -> server received
        expect(pairs(m.left[2])).toEqual([[1, 1]]); // server sent -> network received
        expect(pairs(m.left[1])).toEqual([[1, 1]]); // network received -> client received
        expect(Array.from(m.lost[1])).toEqual([0, 0]);
    });

    it("[network(client), network(client)]: matches sent -> sent once, no upward duplicates", () => {
        const a = conn([pkt(0, "sent", "1RTT", 1), pkt(9, "received", "1RTT", 2)], { type: "network", flow: "client" });
        const b = conn([pkt(1, "sent", "1RTT", 1), pkt(8, "received", "1RTT", 2)], { type: "network", flow: "client" });
        const m = calculateConnections([a, b]);
        expect(pairs(m.right[0])).toEqual([[0, 0]]);
        // R = server: its packets are the "received" ones in both traces
        expect(pairs(m.left[1])).toEqual([[1, 1]]);
        expect(pairs(m.left[1]).some(([i]) => i === 0)).toBe(false);
    });

    it("[server, client] is identical to qvis (server.sent -> client.received to the right)", () => {
        const s = conn([pkt(0, "sent", "initial", 0), pkt(9, "received", "initial", 0)], { type: "server" });
        const c = conn([pkt(5, "received", "initial", 0), pkt(6, "sent", "initial", 0)], { type: "client" });
        const m = calculateConnections([s, c]);
        expect(pairs(m.right[0])).toEqual([[0, 0]]);
        expect(pairs(m.left[1])).toEqual([[1, 1]]);
    });

    it("[unknown, GENERATED server] and [GENERATED client, unknown] mirrors never lose packets", () => {
        const events = [pkt(0, "sent", "initial", 0), pkt(5, "received", "initial", 0), pkt(6, "sent", "1RTT", 0)];
        // the guess says client (Initial 0 sent before one was received): mirror is a server, on the right
        const u = conn(events, undefined);
        const traces = ensureMoreThanOneTrace([{ connection: u, timeOffset: 0 }]);
        expect(traces.map((t) => t.connection.vantagePoint.type)).toEqual(["unknown", "server"]);
        let m = calculateConnections(traces.map((t) => t.connection));
        expect(m.lost.every((l) => l.every((x) => x === 0))).toBe(true);
        expect(pairs(m.right[0])).toEqual([
            [0, 0],
            [2, 2],
        ]);
        expect(pairs(m.left[1])).toEqual([[1, 1]]);

        // the guess says server: mirror is a client, on the left
        const u2 = conn([pkt(0, "received", "initial", 0), pkt(1, "sent", "initial", 0)], undefined);
        const traces2 = ensureMoreThanOneTrace([{ connection: u2, timeOffset: 0 }]);
        expect(traces2.map((t) => t.connection.vantagePoint.type)).toEqual(["client", "unknown"]);
        m = calculateConnections(traces2.map((t) => t.connection));
        expect(m.lost.every((l) => l.every((x) => x === 0))).toBe(true);
        expect(pairs(m.right[0])).toEqual([[0, 0]]); // generated "sent" = the original's received Initial
        expect(pairs(m.left[1])).toEqual([[1, 1]]);
    });
});
