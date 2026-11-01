/**
 * Test helper: the PUBLISHED draft texts (tests/fixtures/unit/drafts/*.txt, copies of
 * https://www.ietf.org/archive/id/<draft>.txt) and extractors for their event names, importance levels and CDDL
 * rules, so the hand-written constants and types can be checked against the drafts (names.test.ts, schema.test.ts).
 *
 * The texts are bundled with Vite `?raw` imports (no node:fs, so the app tsconfig needs no Node types).
 * Test-only: never import this from application code.
 */
import mainSchema14 from "../../../../tests/fixtures/unit/drafts/draft-ietf-quic-qlog-main-schema-14.txt?raw";
import quicEvents13 from "../../../../tests/fixtures/unit/drafts/draft-ietf-quic-qlog-quic-events-13.txt?raw";
import h3Events13 from "../../../../tests/fixtures/unit/drafts/draft-ietf-quic-qlog-h3-events-13.txt?raw";

export type DraftId = "main-schema-14" | "quic-events-13" | "h3-events-13";

const DRAFT_TEXTS: Record<DraftId, string> = {
    "main-schema-14": mainSchema14,
    "quic-events-13": quicEvents13,
    "h3-events-13": h3Events13,
};

const cache = new Map<DraftId, string>();

/** The draft text with page breaks (footer, form feed, running header) removed. */
export function readDraft(id: DraftId): string {
    let text = cache.get(id);
    if (text === undefined) {
        text = stripPageBreaks(DRAFT_TEXTS[id]);
        cache.set(id, text);
    }
    return text;
}

/** Removes the RFC-style page breaks: blank lines, "<authors> Expires ... [Page n]", "\f", "Internet-Draft ...". */
export function stripPageBreaks(raw: string): string {
    return raw.replace(/\r\n/g, "\n").replace(/\n*[^\n]*\[Page \d+\]\n\f\nInternet-Draft[^\n]*\n\n*/g, "\n");
}

// ------------------------------------------------------------------------------------------------
// Event names
// ------------------------------------------------------------------------------------------------

/** IANA registrations: namespace -> event types, from "Namespace  x" / "Event Types  a, b, c". */
export function ianaEventTypes(id: DraftId): Map<string, string[]> {
    const text = readDraft(id);
    const out = new Map<string, string[]>();
    const re = /^ {3}Namespace +([A-Za-z0-9._~-]+)\s*\n\s*\n? {3}Event Types +([\s\S]*?)\n\s*\n/gm;
    for (const m of text.matchAll(re)) {
        const types = m[2]
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        out.set(m[1], types);
    }
    return out;
}

/** Event tables ("Table 1: QUIC Events", ...): full name -> importance, in table order. */
export function tableEvents(id: DraftId): Array<{ name: string; importance: string }> {
    const text = readDraft(id);
    const out: Array<{ name: string; importance: string }> = [];
    for (const m of text.matchAll(/^ *\| ([a-z0-9]+:[a-z0-9_]+) +\| (Core|Base|Extra) +\|/gm)) {
        out.push({ name: m[1], importance: m[2].toLowerCase() });
    }
    return out;
}

/** The body of the section whose heading is exactly `<number>.  <title>` (up to the next heading). */
export function sectionBody(id: DraftId, title: string): string | undefined {
    const text = readDraft(id);
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(
        `^\\d+(?:\\.\\d+)*\\.\\s+${esc}\\n([\\s\\S]*?)(?=^\\d+(?:\\.\\d+)*\\.\\s+\\S|^Change Log|(?![\\s\\S]))`,
        "m",
    ).exec(text);
    return m?.[1];
}

/** The CDDL data type of an event: the first `Name = {` rule in the event's section (heading = event type). */
export function eventDataTypeName(id: DraftId, eventType: string): string | undefined {
    const body = sectionBody(id, eventType);
    if (body === undefined) return undefined;
    return /^ {3}([A-Za-z][A-Za-z0-9]*) = \{/m.exec(body)?.[1];
}

/** "It has Core importance level" style statements in an event's section (used for loglevel / simulation). */
export function proseImportance(id: DraftId, eventType: string): string | undefined {
    const body = sectionBody(id, eventType);
    return body ? /\b(Core|Base|Extra) importance level/.exec(body)?.[1].toLowerCase() : undefined;
}

// ------------------------------------------------------------------------------------------------
// CDDL
// ------------------------------------------------------------------------------------------------

export interface CddlMember {
    name: string;
    optional: boolean;
    /** the value expression, comments removed, continuation lines joined with " " */
    value: string;
}

export interface CddlRule {
    name: string;
    /** "=" or "/=" (socket extension) */
    op: "=" | "/=";
    kind: "map" | "other";
    /** for maps: the members in order */
    members: CddlMember[];
    /** the right-hand side, comments removed, lines joined with " " (for maps: the raw body) */
    value: string;
}

const RULE_START = /^ {3}(\$?[A-Za-z][A-Za-z0-9_-]*) *(\/=|=) *(.*)$/;
const MEMBER_START = /^(\?\s*)?([a-z_][a-z0-9_]*)\s*:\s*(.*)$/;

function stripComment(line: string): string {
    // CDDL comments start with ";" (never inside the quoted strings used by these drafts)
    const i = line.indexOf(";");
    return (i >= 0 ? line.slice(0, i) : line).trim();
}

/** Every CDDL rule of a draft (both `Name = ...` and `$Name /= ...`), in document order. */
export function cddlRules(id: DraftId): CddlRule[] {
    const lines = readDraft(id).split("\n");
    const rules: CddlRule[] = [];
    for (let i = 0; i < lines.length; i++) {
        const start = RULE_START.exec(lines[i]);
        if (!start) continue;
        const [, name, op, rest0] = start;
        const rest = stripComment(rest0);
        if (rest.startsWith("{") && !rest.endsWith("}")) {
            // multi-line map: until a line that is exactly "   }" (or "   } / text" style alternations)
            const body: string[] = [];
            let j = i + 1;
            for (; j < lines.length && !/^ {3}\}/.test(lines[j]); j++) body.push(lines[j]);
            rules.push({
                name,
                op: op as "=" | "/=",
                kind: "map",
                members: parseMembers(body),
                value: body.join("\n"),
            });
            i = j;
            continue;
        }
        // choice / simple rule: continue while the expression is incomplete (ends with "/" or "=" or is empty)
        const parts: string[] = rest.length ? [rest] : [];
        let expectMore = rest.length === 0 || rest.endsWith("/");
        let j = i + 1;
        while (expectMore && j < lines.length) {
            const content = stripComment(lines[j]);
            j++;
            if (content.length === 0) continue;
            parts.push(content);
            expectMore = content.endsWith("/");
        }
        rules.push({ name, op: op as "=" | "/=", kind: "other", members: [], value: parts.join(" ") });
        i = j - 1;
    }
    return rules;
}

function parseMembers(body: string[]): CddlMember[] {
    const members: CddlMember[] = [];
    let depth = 0; // nesting of inline maps such as `details: { * text => any }`
    for (const line of body) {
        const content = stripComment(line);
        if (content.length === 0) continue;
        const m = depth === 0 ? MEMBER_START.exec(content) : null;
        if (m) {
            members.push({ name: m[2], optional: m[1] !== undefined, value: m[3].trim() });
        } else if (depth === 0 && content.startsWith("*")) {
            // group socket (`* $$quic-...-extension`): not a member
        } else if (members.length > 0) {
            // continuation of the previous member's value (multi-line choices, inline maps)
            const last = members[members.length - 1];
            last.value = `${last.value} ${content}`.trim();
        }
        depth += (content.match(/\{/g) ?? []).length - (content.match(/\}/g) ?? []).length;
    }
    return members;
}

/** The quoted string literals of a CDDL expression, ignoring `.default "x"` / `.regexp "x"` operands. */
export function cddlLiterals(value: string): string[] {
    const cleaned = value.replace(/\.(default|regexp)\s+"[^"]*"/g, "");
    return [...cleaned.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Top-level alternatives of a CDDL type expression (`a / b / [* c]`), operators like `.default x` removed. */
export function cddlAlternatives(value: string): string[] {
    const cleaned = value
        .replace(/\.(default|regexp)\s+("[^"]*"|\S+)/g, "")
        .replace(/\.size\s+\S+/g, "")
        .trim();
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of cleaned) {
        if (ch === "[" || ch === "{") depth++;
        if (ch === "]" || ch === "}") depth--;
        if (ch === "/" && depth === 0) {
            out.push(cur.trim());
            cur = "";
        } else {
            cur += ch;
        }
    }
    if (cur.trim().length) out.push(cur.trim());
    return out;
}

/**
 * All values of a (possibly socket-extended) CDDL choice: quoted literals plus, recursively, the literals of the
 * referenced choice rules. `rules` may span several drafts (`$ApplicationError /= HTTP3ApplicationError` lives in h3).
 */
export function cddlChoiceValues(rules: readonly CddlRule[], name: string, seen = new Set<string>()): string[] {
    if (seen.has(name)) return [];
    seen.add(name);
    const out: string[] = [];
    for (const rule of rules.filter((r) => r.name === name && r.kind === "other")) {
        for (const alt of cddlAlternatives(rule.value)) {
            const lit = /^"([^"]*)"$/.exec(alt);
            if (lit) out.push(lit[1]);
            else if (
                /^\$?[A-Za-z][A-Za-z0-9_-]*$/.test(alt) &&
                rules.some((r) => r.name === alt && r.kind === "other")
            ) {
                out.push(...cddlChoiceValues(rules, alt, seen));
            }
        }
    }
    return out;
}
