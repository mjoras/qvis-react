// Duplicate-key preserving JSON parser (file-loading spec section 3.6).

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseJsonWithDuplicateKeys, TsharkJsonError } from "./parseTsharkJson";

describe("parseJsonWithDuplicateKeys", () => {
    it("turns repeated keys into an ordered array of all values, at the right depth", () => {
        const text = '{"a":1,"b":{"x":1,"x":{"y":2},"x":[3]},"a":2,"c":[{"k":1,"k":2},{"k":3}]}';
        expect(parseJsonWithDuplicateKeys(text)).toEqual({
            a: [1, 2],
            b: { x: [1, { y: 2 }, [3]] },
            c: [{ k: [1, 2] }, { k: 3 }],
        });
    });

    it("parses like JSON.parse otherwise (escapes, numbers, literals, whitespace, BOM)", () => {
        const text =
            '\ufeff [ "a\\"b\\\\", "\\u00e9\\n", -1.5e3, 0, true, false, null, {}, [], {"s":"PRI * HTTP/2.0\\r\\n"} ] ';
        expect(parseJsonWithDuplicateKeys(text)).toEqual(JSON.parse(text.slice(1)));
    });

    it("keeps __proto__ as an own property", () => {
        const v = parseJsonWithDuplicateKeys('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
        expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
        expect(Object.keys(v)).toEqual(["__proto__"]);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it.each(['{"a":', "[1,]", '{"a" 1}', '"open', "[1] x", "nul", "{1:2}"])("rejects %s", (text) => {
        expect(() => parseJsonWithDuplicateKeys(text)).toThrow(TsharkJsonError);
    });

    it("equals JSON.parse on the qvis TCP demo (exported with --no-duplicate-keys)", () => {
        const text = gunzipSync(readFileSync("tests/fixtures/tshark/wikipedia_Playstation.json.gz")).toString("utf8");
        expect(parseJsonWithDuplicateKeys(text)).toEqual(JSON.parse(text));
    });
});
