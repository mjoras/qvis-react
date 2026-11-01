// Security review: hostile netlog / tshark JSON inputs (prototype-named keys and values). A string from the file must
// never resolve to an inherited Object.prototype member, and a "__proto__" key must stay plain data.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ownValue, setOwn } from "./common/own";
import { convertNetlog } from "./netlog";
import { mapSettings } from "./netlog/h3";
import { parseChromiumTransportParameters } from "./netlog/transportParams";
import { parseJsonWithDuplicateKeys } from "./tshark/parseTsharkJson";

const mini = (): string => readFileSync("tests/fixtures/netlog/mini.netlog", "utf8");

describe("netlog converter with prototype-named keys", () => {
    it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
        "encryption_level %s is an unknown level, not an inherited Object.prototype member",
        (level) => {
            const text = mini().replaceAll('"encryption_level":"ENCRYPTION_INITIAL"', `"encryption_level":"${level}"`);
            const result = convertNetlog(text, { filename: "x.netlog" });
            const events = (result.qlog as any).traces[0].events as any[];
            const sent = events.filter((e) => e.name === "quic:packet_sent");
            expect(sent.length).toBeGreaterThan(0);
            for (const e of sent) expect(e.data.header.packet_type).toBe("unknown");
            expect(result.diagnostics.map((d) => d.code)).toContain("netlog.unknown-encryption-level");
        },
    );

    it("transport parameters named after Object.prototype members stay data", () => {
        const out = parseChromiumTransportParameters(
            "[Client constructor 5 __proto__ 7 toString x initial_max_data 10 hasOwnProperty]",
        );
        expect(out.initial_max_data).toBe(10);
        const extra = out.chromium_extra as Record<string, unknown>;
        expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(extra, "__proto__")).toBe(true);
        expect(extra.constructor).toBe("5");
        expect(Object.getOwnPropertyDescriptor(extra, "__proto__")?.value).toBe("7");
        expect(extra.toString).toBe("x");
        expect(extra.hasOwnProperty).toBe(true);
        expect(JSON.parse(JSON.stringify(extra))).toEqual({
            constructor: "5",
            ["__proto__"]: "7",
            toString: "x",
            hasOwnProperty: true,
        });
    });

    it("an HTTP/3 setting named __proto__ is kept as data, not as the prototype of chromium_settings", () => {
        const params = JSON.parse('{"__proto__":{"polluted":1},"SETTINGS_FOO":3}') as Record<string, unknown>;
        const out = mapSettings(params, true);
        const chromium = out.chromium_settings as Record<string, unknown>;
        expect(Object.getPrototypeOf(chromium)).toBe(Object.prototype);
        expect((chromium as { polluted?: unknown }).polluted).toBeUndefined();
        expect(Object.keys(chromium)).toEqual(["__proto__", "SETTINGS_FOO"]);
    });

    it("tshark JSON: __proto__ keys (also duplicated) stay own data members", () => {
        const v = parseJsonWithDuplicateKeys('{"__proto__":{"polluted":1},"__proto__":2,"a":{"__proto__":[]}}') as any;
        expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(v, "__proto__")?.value).toEqual([{ polluted: 1 }, 2]);
        expect(Object.getPrototypeOf(v.a)).toBe(Object.prototype);
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it("helpers", () => {
        const table: Record<string, number> = { a: 1 };
        expect(ownValue(table, "a")).toBe(1);
        expect(ownValue(table, "constructor")).toBeUndefined();
        expect(ownValue(table, "__proto__")).toBeUndefined();
        const o: Record<string, unknown> = {};
        setOwn(o, "__proto__", { polluted: 1 });
        expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
        expect(JSON.stringify(o)).toBe('{"__proto__":{"polluted":1}}');
    });
});
