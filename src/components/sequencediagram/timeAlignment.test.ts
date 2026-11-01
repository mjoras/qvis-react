import type { QlogConnection } from "@/model/QlogConnection";
import { evt, loadGroup, pkt, seqTrace, UNKNOWN_EPOCH, type Json } from "./__fixtures__/seq";
import { calculateTimeOffsets } from "./timeAlignment";
import { absoluteStartTime, absoluteTime, getRememberedOffset, rememberOffset } from "./timeModel";

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function conn(events: Json[], type: string, unknownEpoch = false): QlogConnection {
    const extra = unknownEpoch ? { common_fields: { reference_time: UNKNOWN_EPOCH } } : {};
    return loadGroup([seqTrace(events, { type }, extra)]).getConnections()[0];
}

const offsetOf = (client: QlogConnection, server: QlogConnection, serverOffset = 0) =>
    calculateTimeOffsets([
        { connection: client, timeOffset: 0 },
        { connection: server, timeOffset: serverOffset },
    ]);

describe("calculateTimeOffsets (§3.5.2)", () => {
    // case A traces (no reference_time): absoluteTime = logged time
    const client = () =>
        conn(
            [
                pkt(0, "sent", "initial", 0),
                pkt(40, "received", "initial", 0),
                evt(40.1, "quic:recovery_metrics_updated", { smoothed_rtt: 40, latest_rtt: 40 }),
            ],
            "client",
        );

    it("latest_rtt path, server clock ahead: negative offset (SQ4 FIX)", () => {
        const server = conn([pkt(120, "received", "initial", 0), pkt(121, "sent", "initial", 0)], "server");
        // expected server receive = 0 + 40 / 2 = 20; server logged 120 -> offset -100
        expect(offsetOf(client(), server)).toBe(-100);
        expect(getRememberedOffset(server)).toEqual({ value: -100, userSet: false });
    });

    it("server clock behind: positive offset", () => {
        const server = conn([pkt(5, "received", "initial", 0)], "server");
        expect(offsetOf(client(), server)).toBe(15);
    });

    it("smoothed_rtt fallback keeps the LAST value; then the server's metrics", () => {
        const c = conn(
            [
                pkt(0, "sent", "initial", 0),
                evt(1, "quic:recovery_metrics_updated", { smoothed_rtt: 10 }),
                evt(2, "quic:recovery_metrics_updated", { smoothed_rtt: 30 }),
                pkt(40, "received", "initial", 0),
            ],
            "client",
        );
        const server = conn([pkt(100, "received", "initial", 0)], "server");
        expect(offsetOf(c, server)).toBe(15 - 100);

        const c2 = conn([pkt(0, "sent", "initial", 0), pkt(40, "received", "initial", 0)], "client");
        const s2 = conn(
            [pkt(100, "received", "initial", 0), evt(101, "quic:recovery_metrics_updated", { latest_rtt: "8" })],
            "server",
        );
        expect(offsetOf(c2, s2)).toBe(4 - 100); // uint64/float as string through toNum
    });

    it("no metrics: one-way latency from the client's Initial RTT", () => {
        const c = conn([pkt(0, "sent", "initial", 0), pkt(40, "received", "initial", 0)], "client");
        const server = conn([pkt(100, "received", "initial", 0)], "server");
        expect(offsetOf(c, server)).toBe(20 - 100);
    });

    it("lost client Initial: correlates the PN the server received first", () => {
        const c = conn(
            [
                pkt(0, "sent", "initial", 0), // lost
                pkt(10, "sent", "initial", 1),
                pkt(60, "received", "initial", 0),
                evt(60.1, "quic:recovery_metrics_updated", { latest_rtt: 40 }),
            ],
            "client",
        );
        const server = conn([pkt(50, "received", "initial", 1)], "server");
        expect(offsetOf(c, server)).toBe(10 + 20 - 50);
    });

    it("metrics only (Initials not correlated): the offset is RTT / 2", () => {
        const c = conn([evt(1, "quic:recovery_metrics_updated", { latest_rtt: 40 })], "client");
        const server = conn([evt(2, "quic:connection_started", {})], "server");
        expect(offsetOf(c, server)).toBe(20);
    });

    it("no information: no offset", () => {
        const c = conn([evt(1, "quic:connection_started", {})], "client");
        const server = conn([evt(2, "quic:connection_started", {})], "server");
        expect(offsetOf(c, server)).toBeUndefined();
    });

    it("initial received before sent: no offset", () => {
        const c = conn([pkt(10, "received", "initial", 0), pkt(20, "sent", "initial", 0)], "client");
        const server = conn([pkt(15, "received", "initial", 0)], "server");
        expect(offsetOf(c, server)).toBeUndefined();
    });

    it("remembered per server connection; a user-entered 0 is kept (SQ5 FIX)", () => {
        const c = client();
        const server = conn([pkt(120, "received", "initial", 0)], "server");
        expect(offsetOf(c, server)).toBe(-100);
        // a new wrapper (re-selection) gets the remembered value back
        expect(offsetOf(c, server, 0)).toBe(-100);
        // a non-zero value in the wrapper is kept and remembered
        expect(offsetOf(c, server, 7)).toBeUndefined();
        expect(getRememberedOffset(server)!.value).toBe(7);
        // the user types 0
        rememberOffset(server, 0, true);
        expect(offsetOf(c, server, 0)).toBeUndefined();
        expect(getRememberedOffset(server)).toEqual({ value: 0, userSet: true });
    });

    it("more than 2 traces or a generated trace: no automatic offset", () => {
        const c = client();
        const s = conn([pkt(120, "received", "initial", 0)], "server");
        expect(
            calculateTimeOffsets([
                { connection: c, timeOffset: 0 },
                { connection: s, timeOffset: 0 },
                { connection: s, timeOffset: 0 },
            ]),
        ).toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
            "SequenceDiagramD3Renderer:calculateTimeOffsets : no time offsets auto-calculated for more than 2 traces. Use the UI to assign them manually if needed.",
        );
        s.wasAutoGenerated = true;
        expect(offsetOf(c, s)).toBeUndefined();
    });
});

describe("reference-time repair (HERE BE DRAGONS, SQ19)", () => {
    it("two epoch-unknown traces: the client is seeded at -5 ms, then the offset is computed", () => {
        const c = conn(
            [
                evt(100, "quic:connection_started", {}),
                pkt(101, "sent", "initial", 0),
                pkt(141, "received", "initial", 0),
                evt(141.1, "quic:recovery_metrics_updated", { latest_rtt: 40 }),
            ],
            "client",
            true,
        );
        const s = conn([pkt(500, "received", "initial", 0)], "server", true);
        expect(absoluteStartTime(c)).toBe(0);
        const offset = offsetOf(c, s);
        expect(absoluteStartTime(c)).toBe(-5);
        // the model's own timing is untouched (view-local override)
        expect(c.timing.getAbsoluteStartTime()).toBe(0);
        expect(c.getEvents()[1].absoluteTime).toBe(1);
        expect(absoluteTime(c.getEvents()[1])).toBe(-4);
        // client Initial at 1 - 5 = -4, + 20 = 16; the server received it at its relative 0
        expect(offset).toBe(16);
        expect(console.warn).toHaveBeenCalledWith(
            "SequenceDiagramD3Renderer:calculateTimeOffsets : Client had no reference_time set, trying to fix by using the server-side reftime. HERE BE DRAGONS!",
        );
    });

    it("epoch-unknown server with an absolute client: the server is seeded at clientStart + 5", () => {
        const c = conn([pkt(1000, "sent", "initial", 0), pkt(1040, "received", "initial", 0)], "client");
        const s = conn([pkt(3, "received", "initial", 0)], "server", true);
        const offset = offsetOf(c, s);
        expect(absoluteStartTime(s)).toBe(1005);
        // client sent 1000 + 20 = 1020 expected; server received at 1005 + 0
        expect(offset).toBe(15);
    });
});
