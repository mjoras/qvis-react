// Converters through the loading pipeline (converters spec sections 2.2, 3.1, 8.8, 8.9 test 8): detection, the
// loader call site (src/loading/fileLoader.ts -> convertForLoading), diagnostics in the group, converter toasts.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadQlogFile } from "@/loading/fileLoader";
import { ConversionError } from "@/loading/errors";
import { diagnosticNotifications, mergeDiagnostics } from "@/loading/diagnosticToasts";
import { QlogLoader } from "@/model";
import { converterNotifications, convertForLoading, NO_QUIC_CONNECTIONS_TEXT } from ".";

const netlogText = readFileSync("tests/fixtures/netlog/cloudflare-quic.netlog", "utf8");
const netlogGz = readFileSync("tests/fixtures/netlog/multi-session.netlog.gz");
const tsharkText = readFileSync("tests/fixtures/tshark/tls13-h2-duplicate-keys.json", "utf8");
const wikipediaGz = readFileSync("tests/fixtures/tshark/wikipedia_Playstation.json.gz");

async function loadGroup(input: string | Uint8Array | Blob, name: string) {
    const loaded = await loadQlogFile(input, name);
    const group = QlogLoader.fromJSON(loaded, { filename: name })!;
    return {
        loaded,
        group,
        toasts: diagnosticNotifications(name, mergeDiagnostics(loaded.diagnostics, group.diagnostics)),
    };
}

describe("detection and routing", () => {
    it.each([
        ["x.netlog", netlogText],
        ["chrome-net-export-log.json", netlogText], // Chrome's default export name: content sniff
        ["x.netlog", new Blob([netlogText])],
    ])("loads %s as a Chrome netlog", async (name, input) => {
        const { group, toasts } = await loadGroup(input, name);
        expect(group.getConnections().map((c) => c.title)).toEqual(["cloudflare-quic.com-bb9e480eb70b79bd"]);
        expect(group.getShorthand()).toBe(" (1 connection)");
        expect(toasts).toEqual([]); // info-level converter diagnostics only
        expect(group.diagnostics.map((d) => d.code)).toContain("netlog.unsupported-event");
    });

    it("loads a gzipped netlog (.netlog.gz)", async () => {
        const { group } = await loadGroup(new Blob([new Uint8Array(netlogGz)]), "multi-session.netlog.gz");
        expect(group.getConnections()).toHaveLength(3);
    });

    it.each([
        ["capture.json", tsharkText],
        ["capture.pcap.json", tsharkText],
        ["wikipedia_Playstation.json.gz", new Blob([new Uint8Array(wikipediaGz)])],
    ])("loads %s as tshark JSON", async (name, input) => {
        const { group } = await loadGroup(input, name);
        const conn = group.getConnections()[0];
        expect(conn.protocolHint).toBe("TCP_HTTP2");
        expect(conn.title).toMatch(/ TLS trailer size$/);
    });

    it("repairs a truncated netlog and shows the 'Netlog was truncated' toast", async () => {
        const cut = netlogText.slice(0, Math.floor(netlogText.length * 0.7));
        const { group, toasts } = await loadGroup(cut, "cut.netlog");
        expect(group.getConnections()).toHaveLength(1);
        expect(toasts).toEqual([
            {
                title: "Netlog was truncated",
                text: "The netlog file was not closed properly; events up to the cut-off were loaded.",
                type: "warn",
                duration: 6000,
            },
        ]);
    });

    it("fails with an explanation when there is nothing to show", async () => {
        const noQuic = gzipSync(
            JSON.stringify({
                constants: {
                    activeFieldTrialGroups: [],
                    logEventTypes: { A: 1 },
                    logSourceType: { URL_REQUEST: 1 },
                    logEventPhase: { PHASE_NONE: 0 },
                },
                events: [{ phase: 0, source: { id: 1, type: 1 }, time: "1", type: 1 }],
            }),
        );
        const e = await loadQlogFile(new Blob([new Uint8Array(noQuic)]), "tcp-only.netlog.gz").catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ConversionError);
        expect((e as Error).message).toBe(NO_QUIC_CONNECTIONS_TEXT);
        const quic = readFileSync("tests/fixtures/tshark/udp-quic-only.json", "utf8");
        const e2 = await loadQlogFile(quic, "quic.json").catch((x: unknown) => x);
        expect((e2 as Error).message).toBe(
            "No TCP connections found in this tshark JSON. QUIC captures need pcap2qlog (not available in this deployment).",
        );
    });
});

describe("converter toasts (section 8.8)", () => {
    it("shows one 'Converted with warnings' toast instead of DM2 for warning-level converter diagnostics", async () => {
        const capture = JSON.stringify([
            {
                _source: {
                    layers: {
                        frame: { "frame.time_epoch": "1.0", "frame.number": "1" },
                        ip: { "ip.src": "10.0.0.2", "ip.dst": "10.0.0.1" },
                        tcp: {
                            "tcp.srcport": "443",
                            "tcp.dstport": "40000",
                            "tcp.seq": "1",
                            "tcp.len": "0",
                            "tcp.hdr_len": "20",
                        },
                    },
                },
            },
        ]);
        const { toasts } = await loadGroup(capture, "swapped.json");
        expect(toasts).toEqual([
            {
                title: "Converted with warnings",
                text: "swapped.json was converted, but some input could not be interpreted. See the debug page for details.",
                type: "warn",
                duration: 6000,
            },
        ]);
    });

    it("builds no toast for info-level diagnostics", () => {
        expect(
            converterNotifications("x", [{ level: "info", code: "netlog.unsupported-event", message: "m", count: 3 }]),
        ).toEqual([]);
        expect(
            converterNotifications("x", [{ level: "warning", code: "trace.reordered", message: "m", count: 1 }]),
        ).toEqual([]);
    });

    it("convertForLoading returns the root and the diagnostics", () => {
        const r = convertForLoading("tshark", tsharkText, "c.json");
        expect((r.root as { traces: unknown[] }).traces).toHaveLength(2);
        expect(r.diagnostics.every((d) => d.code.startsWith("tshark."))).toBe(true);
    });
});
