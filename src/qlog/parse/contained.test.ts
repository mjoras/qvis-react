import { parseContained, repairJson } from "./contained";
import { DiagnosticCollector } from "./diagnostics";
import { QlogParseError } from "./errors";

const EVENTS = [
    {
        time: 1,
        name: "quic:packet_sent",
        data: { header: { packet_type: "initial", packet_number: 0 }, raw: { length: 1200 } },
    },
    {
        time: 2,
        name: "quic:packet_received",
        data: {
            header: { packet_type: "initial", packet_number: 0 },
            frames: [{ frame_type: "ack", acked_ranges: [[0, 0]] }],
        },
    },
    {
        time: 3.5,
        name: "quic:packet_sent",
        data: { header: { packet_type: "1RTT", packet_number: "1" }, note: 'a "quoted" string, with ] and } and \\ é' },
        tuple: "",
    },
    { time: 4, name: "loglevel:info", data: { message: "done" }, flag: true, nothing: null },
];
const ROOT = {
    file_schema: "urn:ietf:params:qlog:file:contained",
    serialization_format: "application/qlog+json",
    title: "t",
    traces: [
        { event_schemas: ["urn:ietf:params:qlog:events:quic-13"], vantage_point: { type: "client" }, events: EVENTS },
    ],
};
const PRETTY = JSON.stringify(ROOT, null, 2);
const COMPACT = JSON.stringify(ROOT);

function parse(text: string) {
    const diag = new DiagnosticCollector();
    const root = parseContained(text, diag) as Record<string, any>;
    return { root, diag };
}

function eventsOf(root: Record<string, any>): unknown[] | undefined {
    return root.traces?.[0]?.events;
}

describe("parseContained / repairJson (P4)", () => {
    it("valid JSON goes straight through JSON.parse without diagnostics", () => {
        const { root, diag } = parse(PRETTY);
        expect(root).toEqual(ROOT);
        expect(diag.size).toBe(0);
    });

    it("strips a BOM", () => {
        expect(parse("﻿" + COMPACT).root).toEqual(ROOT);
    });

    it.each([
        ["pretty", PRETTY],
        ["compact", COMPACT],
    ])("every truncation point of a %s file yields only complete events (prefix property)", (_label, text) => {
        const eventsStart = text.indexOf('"events"');
        for (let cut = eventsStart; cut < text.length - 1; cut++) {
            const { root, diag } = parse(text.slice(0, cut));
            const events = eventsOf(root);
            if (events === undefined) continue; // cut before the events array opened
            expect(events, "cut at " + cut).toEqual(EVENTS.slice(0, events.length));
            expect(diag.has("json.truncated-recovered"), "cut at " + cut).toBe(true);
        }
    });

    it("truncated right after the opening of traces", () => {
        const text = COMPACT.slice(0, COMPACT.indexOf('"traces":[') + '"traces":['.length);
        const { root } = parse(text);
        expect(root.traces).toEqual([]);
        expect(root.title).toBe("t");
    });

    it("truncated mid-event drops the partial event", () => {
        const at = COMPACT.indexOf('"packet_number":"1"');
        const { root, diag } = parse(COMPACT.slice(0, at + 5));
        expect(eventsOf(root)).toEqual(EVENTS.slice(0, 2));
        const d = diag.get("json.truncated-recovered")!;
        expect(d.level).toBe("warning");
        expect(d.sample).toMatchObject({ recoveredEvents: 2, droppedIncompleteEvents: 1 });
    });

    it("truncated after the data object closed but before the event closed: partial event dropped", () => {
        const at = COMPACT.indexOf('"tuple":""');
        const { root } = parse(COMPACT.slice(0, at - 1)); // ...}} of data, then ","
        expect(eventsOf(root)).toEqual(EVENTS.slice(0, 2));
    });

    it("truncated mid-string keeps the complete events", () => {
        const at = COMPACT.indexOf("quoted");
        expect(eventsOf(parse(COMPACT.slice(0, at)).root)).toEqual(EVENTS.slice(0, 2));
    });

    it("truncated after a complete event and a comma", () => {
        const end = COMPACT.indexOf('{"time":3.5');
        expect(COMPACT[end - 1]).toBe(",");
        expect(eventsOf(parse(COMPACT.slice(0, end)).root)).toEqual(EVENTS.slice(0, 2));
    });

    it("a syntactically complete last event is kept even without time / name (file-loading 9.5)", () => {
        const text =
            '{"traces":[{"events":[{"time":1,"name":"quic:packet_sent","data":{}},{"name":"quic:packet_sent","data":{}},{"ti';
        const { root, diag } = parse(text);
        expect(eventsOf(root)).toEqual([
            { time: 1, name: "quic:packet_sent", data: {} },
            { name: "quic:packet_sent", data: {} },
        ]);
        expect(diag.get("json.truncated-recovered")?.sample).toMatchObject({
            recoveredEvents: 2,
            droppedIncompleteEvents: 1,
        });
    });

    it("trailing garbage after the root is ignored with a warning", () => {
        const { root, diag } = parse(PRETTY + "\n}garbage]]");
        expect(root).toEqual(ROOT);
        expect(diag.get("json.trailing-data")?.level).toBe("warning");
        expect(diag.has("json.truncated-recovered")).toBe(false);
    });

    it("syntax error mid-file: loaded up to the last complete event before the error", () => {
        const at = COMPACT.indexOf('{"time":3.5');
        const broken = COMPACT.slice(0, at) + '{"time": NaN, "name":"x"}' + COMPACT.slice(at);
        const { root, diag } = parse(broken);
        expect(eventsOf(root)).toEqual(EVENTS.slice(0, 2));
        expect(diag.get("json.syntax-error-recovered")?.level).toBe("warning");
    });

    it("keeps a closed last event that lacks time or name (9.5: only the cut event is dropped; P8 flags it)", () => {
        const text = COMPACT.slice(0, COMPACT.indexOf('{"time":4')) + '{"data":{}} ';
        const { root } = parse(text);
        expect(eventsOf(root)).toEqual([...EVENTS.slice(0, 3), { data: {} }]);
    });

    it("lenient sequential-shaped contained file (trace.events) is repaired too", () => {
        const text = JSON.stringify({ file_schema: "x", trace: { events: EVENTS } });
        const cut = text.indexOf("quoted");
        const root = parse(text.slice(0, cut)).root;
        expect(root.trace.events).toEqual(EVENTS.slice(0, 2));
    });

    it("unrecoverable input throws QlogParseError", () => {
        expect(() => parse('{"file_sch')).toThrow(QlogParseError);
        expect(() => parse("{oops")).toThrow(QlogParseError);
    });

    it("repairJson returns null for valid JSON and reports the reason", () => {
        expect(repairJson(COMPACT)).toBeNull();
        expect(repairJson('{"a":[1,2')!.reason).toBe("truncated");
        expect(repairJson('{"a":[1,2')!.text).toBe('{"a":[1]}'); // "2" may continue: not safe
        expect(repairJson('{"a":[1,2]')!.text).toBe('{"a":[1,2]}');
        expect(repairJson('{"a":tru')).toBeNull(); // nothing complete below the root
        expect(repairJson('{"a":1,"b":tru')!.text).toBe('{"a":1}');
        expect(repairJson('{"a":1} x')!.reason).toBe("trailing-data");
        expect(repairJson('{"a":1,,"b":2}')).toMatchObject({ reason: "syntax-error", text: '{"a":1}', errorPos: 7 });
        expect(repairJson('{"z":0,"a":"\u0001"}')!.reason).toBe("syntax-error"); // unescaped control char
        expect(repairJson('{"z":0,"a":"\\x"}')!.reason).toBe("syntax-error");
        expect(repairJson('{"z":0,"a":"\\u12G4"}')!.reason).toBe("syntax-error");
        expect(repairJson('{"z":0,"a":-}')!.reason).toBe("syntax-error");
        expect(repairJson('{"z":0,"a":1.}')!.reason).toBe("syntax-error");
        expect(JSON.parse(repairJson('{"a":{"b":[{"c":1e5},{"d":-0.5E-2}],"e":"\\u00e9\\n"},"f":')!.text)).toEqual({
            a: { b: [{ c: 1e5 }, { d: -0.005 }], e: "é\n" },
        });
    });
});
