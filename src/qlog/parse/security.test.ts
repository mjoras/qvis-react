// Security review: hostile qlog files with "__proto__" members. JSON.parse keeps such a member as an own data
// property; copying it with `out[key] = value` would instead replace the copy's prototype, so the attacker's object
// would supply inherited members (hasOwnProperty, toString, ...) of the normalized root / trace objects.

import { describe, expect, it } from "vitest";
import { parseQlogText } from ".";

const RS = "\u001e";
const HOSTILE = '{"polluted":"yes","hasOwnProperty":1,"toString":"x","events":[1]}';

function seqFile(header: string, events: string[] = ['{"time":1,"name":"quic:packet_sent","data":{}}']): string {
    return [header, ...events].map((r) => RS + r + "\n").join("");
}

describe("normalization keeps __proto__ members as plain data", () => {
    it("JSON-SEQ: __proto__ in the header trace does not become the trace's prototype", () => {
        const loaded = parseQlogText(
            seqFile(
                '{"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"application/qlog+json-seq",' +
                    '"trace":{"__proto__":' +
                    HOSTILE +
                    ',"vantage_point":{"type":"client"},"event_schemas":["urn:ietf:params:qlog:events:quic-13"]}}',
            ),
        );
        const trace = (loaded.root.traces as Record<string, unknown>[])[0];
        expect(Object.getPrototypeOf(trace)).toBe(Object.prototype);
        expect((trace as { polluted?: unknown }).polluted).toBeUndefined();
        expect(typeof trace.hasOwnProperty).toBe("function");
        // the member itself is kept as data (export / debug see it as logged)
        expect(Object.prototype.hasOwnProperty.call(trace, "__proto__")).toBe(true);
        expect(Array.isArray(trace.events) && trace.events.length).toBe(1);
    });

    it("JSON-SEQ: __proto__ in the header does not become the root's prototype", () => {
        const loaded = parseQlogText(
            seqFile(
                '{"__proto__":' +
                    HOSTILE +
                    ',"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"application/qlog+json-seq",' +
                    '"trace":{"vantage_point":{"type":"client"}}}',
            ),
        );
        expect(Object.getPrototypeOf(loaded.root)).toBe(Object.prototype);
        expect((loaded.root as { polluted?: unknown }).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(loaded.root, "__proto__")).toBe(true);
    });

    it("contained file with a single `trace` member: __proto__ is not copied as the prototype", () => {
        const loaded = parseQlogText(
            '{"__proto__":' +
                HOSTILE +
                ',"file_schema":"urn:ietf:params:qlog:file:contained","serialization_format":"application/qlog+json",' +
                '"trace":{"vantage_point":{"type":"client"},"events":[{"time":1,"name":"quic:packet_sent","data":{}}]}}',
        );
        expect(Object.getPrototypeOf(loaded.root)).toBe(Object.prototype);
        expect((loaded.root as { polluted?: unknown }).polluted).toBeUndefined();
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it("never touches Object.prototype", () => {
        parseQlogText(
            seqFile(
                '{"file_schema":"urn:ietf:params:qlog:file:sequential","trace":{"__proto__":{"__proto__":{"polluted":1}}}}',
                ['{"time":1,"name":"quic:packet_sent","data":{"__proto__":{"polluted":1}},"__proto__":{"polluted":1}}'],
            ),
        );
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
        expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("polluted");
    });
});
