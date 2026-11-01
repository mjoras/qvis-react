// Reduces and scrubs a Chrome netlog for use as a test fixture (see README.md).
// Usage: node tests/fixtures/netlog/scrub-netlog.mjs <in.netlog> <out.netlog> [other-source events to keep]
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out, keepOtherStr] = process.argv.slice(2);
const keepOther = Number(keepOtherStr ?? 100);
const j = JSON.parse(readFileSync(inp, "utf8"));
const c = j.constants;
const constants = {};
for (const k of [
    "activeFieldTrialGroups",
    "logEventPhase",
    "logEventTypes",
    "logFormatVersion",
    "logSourceType",
    "quicError",
    "quicRstStreamError",
    "timeTickOffset",
]) {
    if (c[k] !== undefined) constants[k] = c[k];
}
constants.activeFieldTrialGroups = [];
const st = Object.fromEntries(Object.entries(c.logSourceType).map(([k, v]) => [v, k]));
const SENSITIVE = /^(cookie|set-cookie|authorization|proxy-authorization|x-client-data|x-goog-[a-z-]+)$/i;
const scrubHeaders = (h) =>
    Array.isArray(h)
        ? h.map((s) => {
              const k = String(s).indexOf(": ", 1);
              if (k < 0) return s;
              const name = s.slice(0, k);
              return SENSITIVE.test(name) ? `${name}: [${s.length - k - 2} bytes were stripped]` : s;
          })
        : h;
let other = 0;
const events = [];
for (const e of j.events) {
    if (st[e.source.type] !== "QUIC_SESSION") {
        if (other++ < keepOther) {
            const { params, ...rest } = e;
            events.push(rest);
        }
        continue;
    }
    const ev = { ...e };
    if (ev.params) {
        const p = { ...ev.params };
        delete p.bytes; // raw crypto/stream bytes (Everything capture mode)
        if (p.headers) p.headers = scrubHeaders(p.headers);
        if (typeof p.self_address === "string") p.self_address = p.self_address.replace(/^[^:]+:/, "192.0.2.10:");
        if (p.source_dependency) delete p.source_dependency;
        ev.params = p;
    }
    events.push(ev);
}
// Chrome writes one event per line
const text =
    '{"constants":' +
    JSON.stringify(constants) +
    ',\n"events": [\n' +
    events.map((e) => JSON.stringify(e)).join(",\n") +
    "\n]}\n";
writeFileSync(out, text);
console.log(out, text.length, events.length);
