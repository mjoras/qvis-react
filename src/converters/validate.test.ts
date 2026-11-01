// Strict CDDL validation of converter output (converters spec 8.9 test 3, 9.9 test 1). Needs the Rust `cddl` CLI
// (scripts/cddl/README.md): set CDDL_BIN or put `cddl` on PATH; skipped otherwise.
//   - netlog output, after removing the `chromium_*` extension keys from event data (their `$$...-extension`
//     sockets are empty in the drafts), through scripts/validate-qlog.mjs (no --allow-unknown-events)
//   - tshark output (events) against the private TCP/TLS/HTTP2 CDDL in src/converters/tshark/tcp-tls-http2.cddl

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { convertNetlog, convertTshark } from ".";

function findCddl(): string | undefined {
    const candidates = [process.env.CDDL_BIN, "cddl"].filter((c): c is string => !!c);
    for (const bin of candidates) {
        try {
            execFileSync(bin, ["--version"], { stdio: "ignore" });
            return bin;
        } catch {
            // not available
        }
    }
    return undefined;
}

const CDDL = findCddl();
const dir = mkdtempSync(join(tmpdir(), "qvis-converters-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stripChromium(qlog: { traces: { events: { data: Record<string, unknown> }[] }[] }): unknown {
    const copy = JSON.parse(JSON.stringify(qlog)) as typeof qlog;
    for (const t of copy.traces)
        for (const e of t.events) for (const k of Object.keys(e.data)) if (k.startsWith("chromium_")) delete e.data[k];
    return copy;
}

function validateQlog(name: string, qlog: unknown): void {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(qlog));
    // throws (non-zero exit) on any error; the output names the failing events
    execFileSync(process.execPath, ["scripts/validate-qlog.mjs", "--cddl-bin", CDDL!, "-q", path], {
        encoding: "utf8",
    });
}

describe.skipIf(CDDL === undefined)("CDDL validation (needs the cddl CLI)", () => {
    it("netlog output validates against the -14/-13 CDDL", () => {
        for (const [name, text] of [
            ["mini.qlog", readFileSync("tests/fixtures/netlog/mini.netlog", "utf8")],
            ["cloudflare.qlog", readFileSync("tests/fixtures/netlog/cloudflare-quic.netlog", "utf8")],
            ["multi.qlog", gunzipSync(readFileSync("tests/fixtures/netlog/multi-session.netlog.gz")).toString("utf8")],
        ] as const) {
            expect(() => validateQlog(name, stripChromium(convertNetlog(text).qlog))).not.toThrow();
        }
    });

    it("tshark output validates against the private TCP/TLS/HTTP2 CDDL", () => {
        for (const [name, text, extended] of [
            [
                "wiki.json",
                gunzipSync(readFileSync("tests/fixtures/tshark/wikipedia_Playstation.json.gz")).toString("utf8"),
                false,
            ],
            [
                "wiki-ext.json",
                gunzipSync(readFileSync("tests/fixtures/tshark/wikipedia_Playstation.json.gz")).toString("utf8"),
                true,
            ],
            ["tls13.json", readFileSync("tests/fixtures/tshark/tls13-h2-duplicate-keys.json", "utf8"), true],
        ] as const) {
            const qlog = convertTshark(text, { extended }).qlog;
            for (const [i, trace] of qlog.traces.entries()) {
                const path = join(dir, i + "-" + name);
                writeFileSync(path, JSON.stringify(trace.events));
                const out = execFileSync(
                    CDDL!,
                    ["validate", "--cddl", "src/converters/tshark/tcp-tls-http2.cddl", "--json", path],
                    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
                );
                expect(out).not.toMatch(/ERROR|failed/);
            }
        }
    });
});
