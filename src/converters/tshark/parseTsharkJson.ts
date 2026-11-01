// JSON parser that keeps duplicate keys (file-loading spec section 3.6; qvis StreamingJSONParser
// .parseJSONWithDeduplication, which drove oboe.js).
//
// tshark `-T json` writes duplicate keys in one object (several "tls.record" or "http2.stream" members), and
// JSON.parse keeps only the last one; tshark's --no-duplicate-keys has been buggy. Here a key seen a second time in the
// same object becomes an array `[first, second]`, and later repeats are appended. Real JSON arrays are preserved.
// A small recursive-descent parser over char codes: single pass, no intermediate tokens.

export class TsharkJsonError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TsharkJsonError";
    }
}

const WS_SPACE = 0x20;
const WS_TAB = 0x09;
const WS_LF = 0x0a;
const WS_CR = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Plain assignment, except for "__proto__", which must become an own data property, not the prototype. */
function setOwn(obj: Record<string, unknown>, key: string, v: unknown): void {
    if (key === "__proto__")
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
    else obj[key] = v;
}

class Parser {
    private pos = 0;
    constructor(private readonly text: string) {}

    parse(): unknown {
        if (this.text.charCodeAt(0) === 0xfeff) this.pos = 1;
        this.ws();
        const v = this.value();
        this.ws();
        if (this.pos < this.text.length) this.fail("Unexpected data after the JSON value");
        return v;
    }

    private fail(msg: string): never {
        throw new TsharkJsonError(msg + " at position " + this.pos);
    }

    private ws(): void {
        const t = this.text;
        let c = t.charCodeAt(this.pos);
        while (c === WS_SPACE || c === WS_LF || c === WS_CR || c === WS_TAB) c = t.charCodeAt(++this.pos);
    }

    private value(): unknown {
        const c = this.text.charCodeAt(this.pos);
        if (c === QUOTE) return this.string();
        if (c === 0x7b) return this.object();
        if (c === 0x5b) return this.array();
        if (c === 0x74) return this.literal("true", true);
        if (c === 0x66) return this.literal("false", false);
        if (c === 0x6e) return this.literal("null", null);
        if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
        if (Number.isNaN(c)) this.fail("Unexpected end of JSON input");
        return this.fail("Unexpected character " + JSON.stringify(this.text[this.pos]));
    }

    private literal(word: string, v: unknown): unknown {
        if (!this.text.startsWith(word, this.pos)) this.fail("Invalid literal");
        this.pos += word.length;
        return v;
    }

    private number(): number {
        const t = this.text;
        const start = this.pos;
        let c = t.charCodeAt(this.pos);
        while (c === 0x2d || c === 0x2b || c === 0x2e || c === 0x65 || c === 0x45 || (c >= 0x30 && c <= 0x39)) {
            c = t.charCodeAt(++this.pos);
        }
        const s = t.slice(start, this.pos);
        const v = Number(s);
        if (s === "" || Number.isNaN(v)) this.fail("Invalid number " + JSON.stringify(s));
        return v;
    }

    private string(): string {
        const t = this.text;
        const start = this.pos + 1;
        let i = start;
        let escaped = false;
        for (;;) {
            const c = t.charCodeAt(i);
            if (c === QUOTE) break;
            if (c === BACKSLASH) {
                escaped = true;
                i += 2;
            } else if (Number.isNaN(c)) {
                this.pos = t.length;
                this.fail("Unterminated string");
            } else i++;
        }
        this.pos = i + 1;
        return escaped ? (JSON.parse(t.slice(start - 1, i + 1)) as string) : t.slice(start, i);
    }

    private object(): Record<string, unknown> {
        this.pos++; // {
        const obj: Record<string, unknown> = {};
        let duplicated: Set<string> | undefined = undefined;
        this.ws();
        if (this.text.charCodeAt(this.pos) === 0x7d) {
            this.pos++;
            return obj;
        }
        for (;;) {
            this.ws();
            if (this.text.charCodeAt(this.pos) !== QUOTE) this.fail("Expected a property name");
            const key = this.string();
            this.ws();
            if (this.text.charCodeAt(this.pos) !== 0x3a) this.fail("Expected ':'");
            this.pos++;
            this.ws();
            const v = this.value();
            if (!Object.prototype.hasOwnProperty.call(obj, key)) {
                setOwn(obj, key, v);
            } else if (duplicated?.has(key)) {
                (obj[key] as unknown[]).push(v);
            } else {
                // second time we see this key: turn it into an array of all its values, in order
                const arr = [obj[key], v];
                setOwn(obj, key, arr);
                (duplicated ??= new Set()).add(key);
            }
            this.ws();
            const c = this.text.charCodeAt(this.pos);
            if (c === 0x2c) {
                this.pos++;
                continue;
            }
            if (c === 0x7d) {
                this.pos++;
                return obj;
            }
            this.fail("Expected ',' or '}'");
        }
    }

    private array(): unknown[] {
        this.pos++; // [
        const arr: unknown[] = [];
        this.ws();
        if (this.text.charCodeAt(this.pos) === 0x5d) {
            this.pos++;
            return arr;
        }
        for (;;) {
            this.ws();
            arr.push(this.value());
            this.ws();
            const c = this.text.charCodeAt(this.pos);
            if (c === 0x2c) {
                this.pos++;
                continue;
            }
            if (c === 0x5d) {
                this.pos++;
                return arr;
            }
            this.fail("Expected ',' or ']'");
        }
    }
}

/** Parses JSON text; a key repeated in one object becomes an array of all its values (in order). */
export function parseJsonWithDuplicateKeys(text: string): unknown {
    return new Parser(text).parse();
}
