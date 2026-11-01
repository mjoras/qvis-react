// tshark (TCP/TLS/HTTP2) converter (converters spec sections 3.9, 3.13, 8.6, 8.7, 8.9 tests 5-7, 9.9 tests 2-4):
// the qvis TCP demo (wikipedia_Playstation.json, golden numbers from a faithful port of qvis TCPToQlog), hand-built
// TLS 1.3 fixtures with and without duplicate keys, and robustness cases.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { QlogLoader } from "@/model";
import type { Diagnostic } from "@/qlog/parse";
import { convertTshark, epochSecondsStringToMs, isoTimeToMs, tsharkToQlog } from ".";
import { NO_TCP_CONNECTIONS_TEXT } from "../common/notifications";

const FIXTURES = "tests/fixtures/tshark/"; // vitest runs from the repository root
const read = (name: string): string => readFileSync(FIXTURES + name, "utf8");
const WIKIPEDIA = gunzipSync(readFileSync(FIXTURES + "wikipedia_Playstation.json.gz")).toString("utf8");

type Ev = { time: number; name: string; data: Record<string, any> };

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
    return out;
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
    return diagnostics.map((d) => d.code);
}

// ---- the TCP packetization data contract (section 8.7), as a minimal port of qvis PacketizationTCPPreProcessor ----

interface Range {
    start: number;
    size: number;
}

function extractRanges(ranges: Range[], size: number, alerts: string[]): Range[] {
    const output: Range[] = [];
    let remaining = size;
    if (size === 0) return output;
    while (ranges.length > 0) {
        const range = ranges.shift()!;
        if (range.size > remaining) {
            ranges.unshift({ start: range.start + remaining, size: range.size - remaining });
            range.size = remaining;
        }
        output.push(range);
        remaining -= range.size;
        if (remaining < 0) {
            alerts.push("Remaining length < 0");
            break;
        }
        if (remaining === 0) break;
    }
    if (remaining !== 0) alerts.push("Trying to fill payloadranges that aren't there! " + remaining);
    return output;
}

/** Lane range counts, x-axis maximum and per-stream DATA totals for one direction, reading the 8.7 field map. */
function packetize(events: readonly Ev[], direction: "sending" | "receiving") {
    const tcpName = direction === "sending" ? "tcp:packet_sent" : "tcp:packet_received";
    const tlsName = direction === "sending" ? "tls:record_created" : "tls:record_parsed";
    const httpName = direction === "sending" ? "http2:frame_created" : "http2:frame_parsed";
    const headersSent = "http2:frame_created"; // vantage point client
    const alerts: string[] = [];
    const lanes = { tcp: 0, tls: 0, http: 0, stream: 0 };
    const tcpRanges: Range[] = [];
    const tlsRanges: Range[] = [];
    const streamInfo = new Map<number, { headers: { name?: string; value?: string }[]; total_size: number }>();
    let tcpMax = 0;
    for (const ev of events) {
        const d = ev.data;
        if (ev.name === tcpName) {
            const payload = d.raw.payload_length ?? 0;
            if (payload === 0) continue;
            const header = d.header.header_length ?? d.raw.length - payload;
            lanes.tcp += 2;
            tcpRanges.push({ start: tcpMax + header, size: payload });
            tcpMax += header + payload;
        } else if (ev.name === tlsName) {
            const payload = Math.max(0, d.raw.payload_length ?? 0);
            lanes.tls += extractRanges(tcpRanges, d.header.header_length, alerts).length;
            for (const r of extractRanges(tcpRanges, payload, alerts)) {
                lanes.tls++;
                if (d.header.content_type === "application") tlsRanges.push({ ...r });
            }
            if (d.header.trailer_length !== 0)
                lanes.tls += extractRanges(tcpRanges, d.header.trailer_length, alerts).length;
        } else if (ev.name === httpName) {
            const payload = d.frame.raw.payload_length;
            const header = d.frame.raw.length - payload;
            const hasStream = d.stream_id !== undefined;
            if (header > 0) {
                const n = extractRanges(tlsRanges, header, alerts).length;
                lanes.http += n;
                if (hasStream) lanes.stream += n;
            }
            if (payload > 0) {
                const n = extractRanges(tlsRanges, payload, alerts).length;
                lanes.http += n;
                if (hasStream) lanes.stream += n;
                if (d.frame.frame_type === "data" && d.stream_id !== 0) {
                    const info = streamInfo.get(d.stream_id);
                    if (info) info.total_size += payload;
                    else alerts.push("unknown stream " + d.stream_id);
                }
            }
        }
        if (ev.name === headersSent && d.frame.frame_type === "headers" && !streamInfo.has(d.stream_id)) {
            streamInfo.set(d.stream_id, { headers: d.frame.headers, total_size: 0 });
        }
    }
    const totals = Object.fromEntries(
        [...streamInfo].filter(([, v]) => v.total_size > 0).map(([k, v]) => [k, v.total_size]),
    );
    return { lanes, xMax: tcpMax, alerts, leftover: tcpRanges.length + tlsRanges.length, totals, streamInfo };
}

// ---- golden: the qvis TCP demo (section 3.13) ---------------------------------------------------------------

describe("wikipedia_Playstation.json (qvis TCP demo, section 3.13)", () => {
    const result = convertTshark(WIKIPEDIA, { filename: "wikipedia_Playstation.json" });
    const trace = result.qlog.traces[0];
    const events = trace.events as Ev[];

    it("gives one trace with qvis's title and event counts", () => {
        expect(result.qlog.traces).toHaveLength(1);
        expect(trace.title).toBe(
            "172.18.15.26:38080 -> 91.198.174.208:443 => upload.wikimedia.org @ 16 TLS trailer size",
        );
        expect(trace.vantage_point).toEqual({ type: "client" });
        expect(trace.common_fields).toEqual({
            protocol_type: "TCP_HTTP2",
            time_format: "relative_to_epoch",
            reference_time: { clock_type: "system", epoch: "1970-01-01T00:00:00.000Z" },
        });
        expect(trace.event_schemas).toEqual([
            "https://github.com/mjoras/qvis-react/112026/tcp",
            "https://github.com/mjoras/qvis-react/112026/tls",
            "https://github.com/mjoras/qvis-react/112026/http2",
        ]);
        expect(events).toHaveLength(394);
        expect(countBy(events, (e) => e.name)).toEqual({
            "tcp:packet_sent": 68,
            "tcp:packet_received": 115,
            "tls:record_created": 28,
            "tls:record_parsed": 72,
            "http2:frame_created": 54,
            "http2:frame_parsed": 57,
        });
    });

    it("estimates the TLS trailer (16 from capture frame 29, 21 records adjusted)", () => {
        expect(result.stats).toMatchObject({
            trailerSize: 16,
            trailerEstimatedFromFrame: 29,
            trailerAdjustedRecords: 21,
        });
        const tls = events.filter((e) => e.name.startsWith("tls:"));
        expect(countBy(tls, (e) => e.data.header.content_type)).toEqual({
            application: 89,
            handshake: 9,
            "change-cipherspec": 2,
        });
        for (const e of tls) {
            const app = e.data.header.content_type === "application";
            expect(e.data.header.trailer_length).toBe(app ? 16 : 0);
            expect(e.data.raw.length).toBe(5 + e.data.raw.payload_length + e.data.header.trailer_length);
            expect(e.data.header).toMatchObject({ header_length: 5, packet_type: "1RTT" });
            expect(e.data.header.version).toMatch(/^030[13]$/); // ClientHello records say TLS 1.0 (0x0301)
        }
        const adjusted = tls.filter(
            (e) => e.data.header.content_type === "application" && e.data.capture_frame_number <= 28,
        );
        expect(adjusted.map((e) => e.data.capture_frame_number)).toEqual(
            [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28].flatMap((n) =>
                adjusted.filter((e) => e.data.capture_frame_number === n).map(() => n),
            ),
        );
        expect(adjusted).toHaveLength(21);
    });

    it("maps HTTP/2 frames, stream ids and byte totals", () => {
        const h2 = events.filter((e) => e.name.startsWith("http2:"));
        expect(countBy(h2, (e) => e.data.frame.frame_type)).toEqual({
            headers: 44,
            data: 32,
            window_update: 24,
            priority: 6,
            settings: 4,
            magic: 1,
        });
        const magic = h2.find((e) => e.data.frame.frame_type === "magic")!;
        expect(magic.data).toEqual({
            stream_id: -1,
            frame: { frame_type: "magic", raw: { length: 24, payload_length: 24 } },
        });
        const ids = countBy(h2, (e) => String(e.data.stream_id));
        expect([ids["-1"], ids["0"], ids["3"], ids["13"]]).toEqual([1, 6, 1, 1]);
        const sum = (name: string) =>
            events.filter((e) => e.name === name).reduce((a, e) => a + e.data.raw.payload_length, 0);
        expect([sum("tcp:packet_sent"), sum("tcp:packet_received")]).toEqual([3599, 130494]);
        const tlsApp = events
            .filter((e) => e.name.startsWith("tls:") && e.data.header.content_type === "application")
            .reduce((a, e) => a + e.data.raw.payload_length, 0);
        const http = h2.reduce((a, e) => a + e.data.frame.raw.length, 0);
        expect([tlsApp, http]).toEqual([127506, 127506]);
        expect(codes(result.diagnostics)).not.toContain("tshark.http-tls-size-mismatch");
    });

    it("emits Unix-ms times (FIX of Q1) in stable order", () => {
        expect(events[0].time).toBeCloseTo(1582210168496.779, 3);
        expect(events[events.length - 1].time - events[0].time).toBeCloseTo(472.20125, 3);
        for (let i = 1; i < events.length; i++) expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time);
        expect(result.diagnostics.map((d) => [d.code, d.count])).toEqual([["tshark.empty-h2-entry", 51]]);
    });

    it("satisfies the TCP packetization data contract (section 8.7, golden lanes of 3.13)", () => {
        const rx = packetize(events, "receiving");
        expect(rx.lanes).toEqual({ tcp: 214, tls: 296, http: 196, stream: 196 });
        expect(rx.xMax).toBe(133918);
        expect(rx.alerts).toEqual([]);
        expect(rx.leftover).toBe(0);
        expect(rx.totals).toEqual({
            15: 4333,
            17: 394,
            19: 13370,
            21: 11310,
            23: 7414,
            25: 11716,
            27: 426,
            29: 477,
            31: 532,
            33: 203,
            35: 10007,
            37: 8553,
            39: 11664,
            41: 11031,
            43: 590,
            45: 4001,
            47: 140,
            49: 7854,
            51: 9168,
            53: 4741,
            55: 416,
            57: 1436,
        });
        const tx = packetize(events, "sending");
        expect(tx.lanes).toEqual({ tcp: 38, tls: 80, http: 106, stream: 106 });
        expect(tx.xMax).toBe(4207);
        expect(tx.alerts).toEqual([]);
        expect(tx.leftover).toBe(0);
    });

    it("loads through the model as a TCP trace (protocolHint, transportNamespace, Stats shape counts)", () => {
        const group = QlogLoader.fromJSON(
            {
                root: result.qlog as unknown as Record<string, unknown>,
                serialization: "json",
                diagnostics: result.diagnostics,
            },
            { filename: "wikipedia_Playstation.json" },
        )!;
        expect(group.diagnostics.filter((d) => /^(event\.|schema\.|trace\.)/.test(d.code))).toEqual([]);
        expect(group.diagnostics.map((d) => d.code)).toContain("tshark.empty-h2-entry");
        const conn = group.getConnections()[0];
        expect(conn.protocolHint).toBe("TCP_HTTP2");
        expect(conn.transportNamespace).toBe("tcp");
        expect(conn.getLongName()).toBe("client : " + trace.title);
        expect(conn.lookup(conn.transportNamespace, "packet_sent")).toHaveLength(68);
        const first = conn.getEvents()[0];
        expect(first.relativeTime).toBe(0);
        expect(first.absoluteTime).toBeCloseTo(1582210168496.779, 3);
        const last = conn.getEvents()[conn.getEvents().length - 1];
        expect(last.relativeTime).toBeCloseTo(472.20125, 3);
        // Stats "Encryption levels" shape scan (decision C9): every event with data.header.packet_type
        const oneRtt = conn.getEvents().filter((e) => e.data.header?.packet_type === "1RTT").length;
        expect(oneRtt).toBe(283);
    });
});

// ---- hand-built TLS 1.3 fixtures --------------------------------------------------------------------------

describe("hand-built TLS 1.3 + HTTP/2 capture", () => {
    const dup = convertTshark(read("tls13-h2-duplicate-keys.json"));
    const merged = convertTshark(read("tls13-h2-no-duplicate-keys.json"));

    it("gives the same output with and without duplicate keys (dedup parser)", () => {
        expect(dup.qlog).toEqual(merged.qlog);
        expect(dup.diagnostics).toEqual(merged.diagnostics);
    });

    it("converts both TCP connections (IPv4 + IPv6) and skips the DNS packet", () => {
        expect(dup.qlog.traces.map((t) => t.title)).toEqual([
            "10.0.0.1:50000 -> 93.184.216.34:443 => example.com @ 17 TLS trailer size",
            "2001:db8::1:50001 -> 2001:db8::2:443 => Unknown URL",
        ]);
        expect(dup.qlog.traces[1].event_schemas).toEqual(["https://github.com/mjoras/qvis-react/112026/tcp"]);
        expect(dup.stats).toMatchObject({ packets: 12, tcpPackets: 11, connections: 2, trailerSize: 17 });
        // the TLS-only connection has no warning: no application records, so no trailer to estimate
        expect(dup.diagnostics.filter((d) => d.level === "warning")).toEqual([]);
    });

    it("maps every layer", () => {
        const events = dup.qlog.traces[0].events as Ev[];
        expect(events.map((e) => e.name.split(":")[1] + "#" + (e.data.capture_frame_number ?? ""))).toEqual([
            "packet_sent#1",
            "packet_received#2",
            "packet_sent#3",
            "packet_sent#4",
            "record_created#4",
            "packet_received#5",
            "record_parsed#5",
            "record_parsed#5",
            "record_parsed#5",
            "packet_sent#6",
            "record_created#6",
            "record_created#6",
            "record_created#6",
            "frame_created#",
            "frame_created#",
            "frame_created#",
            "frame_created#",
            "packet_received#7",
            "record_parsed#7",
            "frame_parsed#",
            "packet_received#8",
            "record_parsed#8",
            "frame_parsed#",
            "frame_parsed#",
            "packet_sent#9",
            "packet_sent#10",
            "record_created#10",
            "frame_created#",
        ]);
        expect(events[0].data).toEqual({
            header: { packet_type: "1RTT", sequence_number: 0, header_length: 40, packet_number: 1 },
            raw: { length: 40, payload_length: 0 },
            capture_frame_number: 1,
        });
        expect(events[0].time).toBeCloseTo(1700000000000.1, 6);
        // the application record of frame 6 was created before the estimate (frame 7) and adjusted retroactively
        expect(events[12].data).toEqual({
            header: {
                content_type: "application",
                header_length: 5,
                trailer_length: 17,
                packet_type: "1RTT",
                version: "0303",
            },
            raw: { length: 125, payload_length: 103 },
            capture_frame_number: 6,
        });
        expect(events[10].data.header.content_type).toBe("change-cipherspec");
        expect(events[13].data).toEqual({
            stream_id: -1,
            frame: { frame_type: "magic", raw: { length: 24, payload_length: 24 } },
        });
        expect(events[16].data).toEqual({
            stream_id: 1,
            frame: {
                frame_type: "headers",
                headers: [
                    { name: ":method", value: "GET" },
                    { name: ":authority", value: "example.com" },
                    { name: ":scheme", value: "https" },
                    { name: ":path", value: "/" },
                ],
                stream_end: true,
                raw: { length: 39, payload_length: 30 },
            },
        });
        expect(events[23].data).toEqual({
            stream_id: 1,
            frame: { frame_type: "data", stream_end: true, raw: { length: 109, payload_length: 100 } },
        });
    });

    it("satisfies the packetization contract in both directions", () => {
        const events = dup.qlog.traces[0].events as Ev[];
        const rx = packetize(events, "receiving");
        const tx = packetize(events, "sending");
        expect([rx.alerts, rx.leftover, tx.alerts, tx.leftover]).toEqual([[], 0, [], 0]);
        expect(rx.totals).toEqual({ 1: 100 });
        expect(rx.streamInfo.get(1)?.headers[0]).toEqual({ name: ":method", value: "GET" });
    });

    it("adds TCP flags, ack and window with extended mappings (T3)", () => {
        const ext = convertTshark(read("tls13-h2-no-duplicate-keys.json"), { extended: true });
        const first = ext.qlog.traces[0].events[0] as Ev;
        expect(first.data.header).toEqual({
            packet_type: "1RTT",
            sequence_number: 0,
            header_length: 40,
            packet_number: 1,
            acknowledgement_number: 0,
            window_size: 64256,
            flags: { syn: true, ack: false, fin: false, rst: false, psh: false },
        });
    });

    it("throws for QUIC-only captures (loading contract) and non-tshark input", () => {
        const quic = convertTshark(read("udp-quic-only.json"));
        expect(quic.qlog.traces).toEqual([]);
        expect(codes(quic.diagnostics)).toEqual(["tshark.no-tcp-connections"]);
        expect(() => tsharkToQlog(read("udp-quic-only.json"), "q.json")).toThrow(NO_TCP_CONNECTIONS_TEXT);
        expect(() => convertTshark('{"a":1}')).toThrow(/Not a tshark JSON export/);
        expect(() => convertTshark("[{", { filename: "bad.json" })).toThrow(
            /^Could not parse tshark JSON file bad\.json : /,
        );
    });
});

// ---- robustness (section 8.9 test 7) ----------------------------------------------------------------------

function pkt(
    n: number,
    t: string,
    src: [string, number],
    dst: [string, number],
    tcpLen: number,
    extra: Record<string, unknown> = {},
) {
    return {
        _index: "packets",
        _source: {
            layers: {
                frame: { "frame.time_epoch": t, "frame.number": String(n) },
                ip: { "ip.src": src[0], "ip.dst": dst[0] },
                tcp: {
                    "tcp.srcport": String(src[1]),
                    "tcp.dstport": String(dst[1]),
                    "tcp.seq": String(n * 100),
                    "tcp.len": String(tcpLen),
                    "tcp.hdr_len": "20",
                },
                ...extra,
            },
        },
    };
}
const A: [string, number] = ["10.0.0.1", 40000];
const B: [string, number] = ["10.0.0.2", 443];
const appRecord = (len: number) => ({
    "tls.record": { "tls.record.content_type": "23", "tls.record.length": String(len) },
});

describe("robustness", () => {
    it("does not crash on HEADERS without (or with a single) http2.header (Q4)", () => {
        const r = convertTshark([
            pkt(1, "1.0", A, B, 50, {
                tls: appRecord(45),
                http2: { "http2.stream": { "http2.length": "19", "http2.type": "1", "http2.streamid": "1" } },
            }),
            pkt(2, "1.1", A, B, 50, {
                tls: appRecord(45),
                http2: {
                    "http2.stream": {
                        "http2.length": "19",
                        "http2.type": "1",
                        "http2.streamid": "3",
                        "http2.header": { "http2.header.name": ":authority", "http2.header.value": "a.example" },
                    },
                },
            }),
        ]);
        const frames = r.qlog.traces[0].events.filter((e) => e.name === "http2:frame_created") as Ev[];
        expect(frames.map((e) => e.data.frame.headers)).toEqual([[], [{ name: ":authority", value: "a.example" }]]);
        expect(r.qlog.traces[0].title).toBe("10.0.0.1:40000 -> 10.0.0.2:443 => a.example @ 17 TLS trailer size");
        expect(codes(r.diagnostics)).toContain("tshark.headers-missing");
    });

    it("skips strings inside TLS arrays (Q5) and patches a lone magic object (Q6)", () => {
        const r = convertTshark([
            pkt(1, "1.0", A, B, 62, {
                tls: ["Transport Layer Security", appRecord(57)],
                http2: { "http2.stream": { "http2.magic": "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" } },
            }),
        ]);
        const events = r.qlog.traces[0].events as Ev[];
        expect(events.map((e) => e.name)).toEqual(["tcp:packet_sent", "tls:record_created", "http2:frame_created"]);
        expect(events[2].data).toEqual({
            stream_id: -1,
            frame: { frame_type: "magic", raw: { length: 24, payload_length: 24 } },
        });
    });

    it("drops the HTTP/2 frames of a packet whose TLS layer has no records (Q7 PARITY)", () => {
        const r = convertTshark([
            pkt(1, "1.0", A, B, 10, {
                tls: [{}, { foo: "1" }],
                http2: { "http2.stream": { "http2.length": "1", "http2.type": "0", "http2.streamid": "1" } },
            }),
        ]);
        expect(r.qlog.traces[0].events.map((e) => e.name)).toEqual(["tcp:packet_sent"]);
        expect(codes(r.diagnostics)).toEqual(
            expect.arrayContaining(["tshark.no-tls-record", "tshark.tls-not-iterable"]),
        );
    });

    it("reports h2c, unknown TLS record fields, unexpected trailer sizes and swapped roles", () => {
        const r = convertTshark([
            pkt(1, "1.0", B, A, 20, {
                http2: { "http2.stream": { "http2.length": "11", "http2.type": "42", "http2.streamid": "0" } },
            }),
            pkt(2, "1.1", A, B, 40, {
                tls: {
                    "tls.record": {
                        "tls.record.content_type": "23",
                        "tls.record.length": "35",
                        "tls.app_data_proto": "HTTP2",
                    },
                },
                http2: { "http2.stream": { "http2.length": "6", "http2.type": "6", "http2.streamid": "0" } },
            }),
        ]);
        expect(r.qlog.traces[0].title).toBe("10.0.0.2:443 -> 10.0.0.1:40000 => Unknown URL");
        const h2 = r.qlog.traces[0].events.filter((e) => e.name.startsWith("http2:")) as Ev[];
        expect(h2[0].data.frame).toEqual({
            frame_type: "unknown",
            frame_type_bytes: 42,
            raw: { length: 20, payload_length: 11 },
        });
        expect(codes(r.diagnostics)).toEqual(
            expect.arrayContaining([
                "tshark.first-packet-from-server-port",
                "tshark.trailer-unexpected-size",
                "tshark.tls-unknown-record-field",
                "tshark.trailer-not-estimated",
            ]),
        );
        expect(r.diagnostics.find((d) => d.code === "tshark.tls-unknown-record-field")?.sample).toBe(
            "tls.app_data_proto",
        );
        const h2c = convertTshark([
            pkt(1, "1.0", A, ["10.0.0.2", 80], 20, {
                http2: { "http2.stream": { "http2.length": "11", "http2.type": "4", "http2.streamid": "0" } },
            }),
        ]);
        expect(codes(h2c.diagnostics)).toEqual(
            expect.arrayContaining(["tshark.h2-without-tls", "tshark.http-tls-size-mismatch"]),
        );
    });

    it("fakes out-of-order timestamps when sequence numbers are in order (3.9.1)", () => {
        const r = convertTshark([pkt(1, "2.000", A, B, 0), pkt(2, "1.500", A, B, 0), pkt(3, "1.000", A, B, 0)]);
        const times = r.qlog.traces[0].events.map((e) => e.time);
        expect(times[0]).toBe(2000);
        expect(times[1]).toBeCloseTo(2000.001, 6);
        expect(times[2]).toBeCloseTo(2000.002, 6);
        expect(codes(r.diagnostics)).toEqual(["tshark.timestamp-faked", "tshark.trailer-not-estimated"]);
    });

    it("uses frame.time_utc / frame.time when time_epoch is missing", () => {
        const p = pkt(1, "x", A, B, 0);
        (p._source.layers.frame as Record<string, string>)["frame.time_utc"] = "2023-11-14T22:13:20.000100000Z";
        const r = convertTshark([p]);
        expect(r.qlog.traces[0].events[0].time).toBeCloseTo(1700000000000.1, 6);
    });

    it("converts epoch and ISO strings without losing sub-ms precision", () => {
        expect(epochSecondsStringToMs("1582210168.496779237")).toBeCloseTo(1582210168496.7793, 3);
        expect(epochSecondsStringToMs("12")).toBe(12000);
        expect(Number.isNaN(epochSecondsStringToMs("abc"))).toBe(true);
        expect(isoTimeToMs("2020-02-20T14:49:28.496779237Z")).toBeCloseTo(1582210168496.779, 3);
        expect(isoTimeToMs("2020-02-20 15:49:28.5 +0100")).toBe(1582210168500);
        expect(isoTimeToMs("Feb 20, 2020 14:49:28 UTC")).toBe(1582210168000);
    });
});
