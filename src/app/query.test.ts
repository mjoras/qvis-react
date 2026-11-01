import { describe, expect, it } from "vitest";
import { encodeQueryComponent, normalizeQuery, parseQuery, parseQueryRaw, safeDecode, stringifyQuery } from "./query";

describe("parseQueryRaw (vue-router 3.1.3 semantics)", () => {
    it("strips a leading ?, # or &", () => {
        expect(parseQueryRaw("?a=1")).toEqual({ a: "1" });
        expect(parseQueryRaw("#a=1")).toEqual({ a: "1" });
        expect(parseQueryRaw("&a=1")).toEqual({ a: "1" });
        expect(parseQueryRaw("")).toEqual({});
        expect(parseQueryRaw("?")).toEqual({});
    });

    it("replaces + with a space before decoding (Q27)", () => {
        expect(parseQueryRaw("a=b+c%2Bd")).toEqual({ a: "b c+d" });
        expect(parseQueryRaw("a+b=c")).toEqual({ "a b": "c" });
    });

    it("keeps '=' inside values", () => {
        expect(parseQueryRaw("a=b=c")).toEqual({ a: "b=c" });
    });

    it("gives null for a bare key", () => {
        expect(parseQueryRaw("a")).toEqual({ a: null });
        expect(parseQueryRaw("a&b=1")).toEqual({ a: null, b: "1" });
    });

    it("collects repeated keys into arrays", () => {
        expect(parseQueryRaw("file=a&file=b&file")).toEqual({ file: ["a", "b", null] });
    });

    it("tolerates malformed percent escapes (Q25)", () => {
        expect(parseQueryRaw("file=%E0%A4%A&x=%zz")).toEqual({ file: "%E0%A4%A", x: "%zz" });
        expect(safeDecode("%")).toBe("%");
    });

    it("splits unencoded file URLs on &", () => {
        expect(parseQueryRaw("file=https://a.org/get?id=1&fmt=qlog")).toEqual({
            file: "https://a.org/get?id=1",
            fmt: "qlog",
        });
    });

    it("skips empty parameters", () => {
        expect(parseQueryRaw("a=1&&b=2&")).toEqual({ a: "1", b: "2" });
    });
});

describe("parseQuery (normalized)", () => {
    it("normalizes bare keys to the empty string", () => {
        expect(parseQuery("flag")).toEqual({ flag: "" });
        expect(normalizeQuery({ a: null })).toEqual({ a: "" });
    });

    it("keeps the FIRST occurrence of duplicate keys (Q26)", () => {
        expect(parseQuery("file=a&file=b")).toEqual({ file: "a" });
        expect(parseQuery("file&file=b")).toEqual({ file: "" });
    });

    it("decodes percent-encoded URLs", () => {
        expect(parseQuery("?file=https%3A%2F%2Fa.org%2Fx.qlog&focusOnEvent=3")).toEqual({
            file: "https://a.org/x.qlog",
            focusOnEvent: "3",
        });
    });
});

describe("stringifyQuery (vue-router encoder)", () => {
    it("escapes !'()* and keeps commas", () => {
        expect(encodeQueryComponent("!'()*,")).toBe("%21%27%28%29%2a,");
        expect(stringifyQuery({ a: "x(1)!" })).toBe("a=x%281%29%21");
        expect(stringifyQuery({ list: "a,b" })).toBe("list=a,b");
    });

    it("encodes URLs like vue-router after a menu click", () => {
        expect(stringifyQuery({ file: "https://a.org/x.qlog" })).toBe("file=https%3A%2F%2Fa.org%2Fx.qlog");
    });

    it("handles null, undefined, empty strings and arrays", () => {
        expect(stringifyQuery({ a: null })).toBe("a");
        expect(stringifyQuery({ a: undefined, b: "1" })).toBe("b=1");
        expect(stringifyQuery({ a: "" })).toBe("a=");
        expect(stringifyQuery({ f: ["x", null] })).toBe("f=x&f");
        expect(stringifyQuery({})).toBe("");
        expect(stringifyQuery(undefined)).toBe("");
    });

    it("keeps key insertion order", () => {
        expect(stringifyQuery({ z: "1", a: "2", m: "3" })).toBe("z=1&a=2&m=3");
    });

    it("round-trips through parseQuery", () => {
        const q = { file: "https://a.org/x y+z.qlog?x=1&y=2", "weird key": "é,(ok)*" };
        expect(parseQuery(stringifyQuery(q))).toEqual(q);
    });
});

describe("prototype-named keys (robustness)", () => {
    it("inherited Object members are not mistaken for existing keys; __proto__ is an ordinary key", () => {
        expect(parseQuery("constructor=a&toString=b")).toEqual({ constructor: "a", toString: "b" });
        const q = parseQuery("__proto__=x&file=f.qlog");
        expect(Object.keys(q)).toEqual(["__proto__", "file"]);
        expect(q.file).toBe("f.qlog");
        expect(Object.getPrototypeOf(q)).toBe(Object.prototype);
        expect(stringifyQuery(parseQuery("constructor=a"))).toBe("constructor=a");
    });
});
