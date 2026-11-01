/**
 * Drift guard: the hand-written types in quic.ts / h3.ts must match the CDDL of the PUBLISHED drafts
 * (draft-ietf-quic-qlog-quic-events-13, draft-ietf-quic-qlog-h3-events-13), re-extracted here from the .txt files.
 *
 * Checked: every CDDL map rule has an interface of the same name with the same members, optionality and member
 * types; every CDDL choice has a TS type with the same values (open sockets stay open, closed choices closed);
 * every union (event data, frames, capsules) has the same members; the exported value arrays match. Extra members
 * and values are only allowed where they come from the editor's copy (ARCHITECTURE §0) and are listed below.
 */
import { describe, expect, it } from "vitest";
import { cddlAlternatives, cddlChoiceValues, cddlLiterals, cddlRules, type CddlRule } from "./__fixtures__/drafts";
import { literalSet, loadTsModel, unionMemberNames } from "./__fixtures__/tsSource";
import quicSource from "./quic.ts?raw";
import h3Source from "./h3.ts?raw";
import {
    isQuicFrame,
    KEY_TYPES,
    PACKET_NUMBER_SPACES,
    PACKET_TYPES,
    QUIC_FRAME_TYPES,
    TRANSPORT_ERRORS,
    type QuicExtensionFrame,
    type QuicFrame,
} from "./quic";
import {
    HTTP3_APPLICATION_ERRORS,
    HTTP3_FRAME_TYPES,
    HTTP3_SETTINGS_NAMES,
    HTTP3_STREAM_TYPES,
    HTTP_CAPSULE_TYPES,
    isHTTP3Frame,
} from "./h3";

/** The one CDDL block in -13 that is an illustration, not a definition ("... extending the socket as such:"). */
const isExample = (r: CddlRule) => r.name === "$ApplicationError" && r.value.includes("new_error_name");

const quicRules = cddlRules("quic-events-13").filter((r) => !isExample(r));
const h3Rules = cddlRules("h3-events-13");
const allRules = [...quicRules, ...h3Rules];
const model = loadTsModel({ "quic.ts": quicSource, "h3.ts": h3Source });

/** Values the editor's copy adds to a CDDL choice (h3 digest §11.1, quic digest §14). */
const EDITORS_COPY_HTTP3_ERRORS = [
    "http_message_error",
    "qpack_decompression_failed",
    "qpack_encoder_stream_error",
    "qpack_decoder_stream_error",
    "http_datagram_error",
];
const EDITORS_COPY_VALUES: Record<string, string[]> = {
    "QUICPacketDropped.trigger": ["keys_unavailable"],
    HTTP3ApplicationError: EDITORS_COPY_HTTP3_ERRORS,
    $ApplicationError: EDITORS_COPY_HTTP3_ERRORS,
};

/** Member types widened by the editor's copy (TS type text expected instead of the -13 mapping). */
const EDITORS_COPY_TYPES: Record<string, string> = {
    "QUICRecoveryParametersSet.reordering_threshold": 'number | "disabled"',
    "HTTP3ParametersSet.extended_connect": "Uint64",
    "HTTP3ParametersSet.h3_datagram": "Uint64",
    "HTTP3ParametersRestored.extended_connect": "Uint64",
    "HTTP3ParametersRestored.h3_datagram": "Uint64",
};

/** CDDL rule -> TS name, where they differ or where the CDDL rule is a socket (`$Name`). */
const TS_NAME: Record<string, string> = {
    BaseConnectionStates: "BaseConnectionState",
    GranularConnectionStates: "GranularConnectionState",
    BaseStreamStates: "BaseStreamState",
    GranularStreamStates: "GranularStreamState",
    QuicBaseFrames: "QuicFrame",
    HTTP3BaseFrames: "HTTP3Frame",
    HTTP3ExtensionFrames: "HTTP3Frame",
    HTTPBaseCapsules: "HTTPCapsule",
};
const tsNameOf = (cddl: string) => TS_NAME[cddl] ?? cddl.replace(/^\$/, "");

const PRIMITIVES: Record<string, string> = {
    uint8: "number",
    uint16: "number",
    uint32: "number",
    uint64: "Uint64",
    float32: "number",
    float64: "number",
    text: "string",
    bool: "boolean",
    hexstring: "HexString",
    any: "any",
};

/** The TS type text that the CDDL type expression maps to (see the conventions in quic.ts). */
function expectedTsType(cddlValue: string): string {
    const one = (alt: string): string => {
        const arr = /^\[\s*[*+]\s*(.+?)\s*\]$/.exec(alt);
        if (arr) return `${one(arr[1])}[]`;
        if (alt.startsWith("{")) return "{ [key: string]: any }";
        return PRIMITIVES[alt] ?? tsNameOf(alt);
    };
    return cddlAlternatives(cddlValue).map(one).join(" | ");
}

const isLiteralChoice = (cddlValue: string) => cddlAlternatives(cddlValue).every((a) => /^"[^"]*"$/.test(a));

describe("CDDL map rules <-> TS interfaces", () => {
    const maps = allRules.filter((r) => r.kind === "map" && r.op === "=");

    it("finds the expected number of map rules in the drafts", () => {
        // 39 QUIC events + 23 frames + 6 data types; 9 HTTP/3 events + 11 frames + 3 types; 2 HTTP events + 2 capsules
        expect(maps.length).toBe(39 + 23 + 6 + 9 + 11 + 3 + 2 + 2);
    });

    it.each(maps.map((r) => [r.name, r] as const))("%s", (name, rule) => {
        const iface = model.interfaces.get(name);
        expect(iface, `interface ${name}`).toBeDefined();
        if (!iface) return;
        for (const m of rule.members) {
            const key = `${name}.${m.name}`;
            const tm = iface.get(m.name);
            expect(tm, key).toBeDefined();
            if (!tm) continue;
            expect(tm.optional, `${key} optional`).toBe(m.optional);
            if (isLiteralChoice(m.value)) {
                const ls = literalSet(model, tm.typeNode);
                expect(ls.open, `${key} must be a closed choice`).toBe(false);
                const expected = new Set([...cddlLiterals(m.value), ...(EDITORS_COPY_VALUES[key] ?? [])]);
                expect([...ls.literals].sort(), key).toEqual([...expected].sort());
            } else {
                expect(tm.typeText, key).toBe(EDITORS_COPY_TYPES[key] ?? expectedTsType(m.value));
            }
        }
        for (const [member, tm] of iface) {
            if (rule.members.some((m) => m.name === member)) continue;
            expect(tm.comment, `${name}.${member} is not in -13, so it must be marked @editors-copy`).toContain(
                "@editors-copy",
            );
        }
    });
});

describe("CDDL choices <-> TS literal unions", () => {
    const choiceRules = [
        ...new Set(allRules.filter((r) => r.kind === "other" && cddlLiterals(r.value).length > 0).map((r) => r.name)),
    ];

    it("covers every CDDL choice with literal values", () => {
        expect(choiceRules.sort()).toEqual(
            [
                "$BlockedReason",
                "$BlockedState",
                "$DataLocation",
                "$DataMovedAdditionalInfo",
                "$HTTP3SettingsName",
                "$HTTP3StreamType",
                "$KeyType",
                "$PacketNumberSpace",
                "$PacketType",
                "$TimerType",
                "$TokenType",
                "$TransportError",
                "$ApplicationError",
                "BaseConnectionStates",
                "BaseStreamStates",
                "ECN",
                "ECNState",
                "ErrorSpace",
                "GranularConnectionStates",
                "GranularStreamStates",
                "HTTP3ApplicationError",
                "HTTP3PushDecision",
                "Initiator",
                "MigrationState",
                "StreamType",
            ].sort(),
        );
    });

    // composite sockets whose values come from other rules
    const composite = ["$ConnectionState", "$StreamState"];

    it.each([...choiceRules, ...composite].map((n) => [n] as const))("%s", (cddlName) => {
        const tsName = tsNameOf(cddlName);
        const alias = model.aliases.get(tsName);
        expect(alias, `type ${tsName}`).toBeDefined();
        if (!alias) return;
        const ls = literalSet(model, alias);
        const values = new Set(cddlChoiceValues(allRules, cddlName));
        const expected = new Set([...values, ...(EDITORS_COPY_VALUES[cddlName] ?? [])]);
        expect([...ls.literals].sort(), cddlName).toEqual([...expected].sort());
        expect(ls.open, `${tsName}: open iff the CDDL rule is a $socket`).toBe(cddlName.startsWith("$"));
    });
});

describe("CDDL unions <-> TS unions", () => {
    const unionOf = (name: string) =>
        allRules.filter((r) => r.name === name && r.kind === "other").flatMap((r) => cddlAlternatives(r.value));

    it.each([
        ["QuicEventData", ["QuicEventData"]],
        ["HTTP3EventData", ["HTTP3EventData"]],
        ["HTTPEventData", ["HTTPEventData"]],
        ["QuicFrame", ["QuicBaseFrames"]],
        ["HTTP3Frame", ["HTTP3BaseFrames", "HTTP3ExtensionFrames"]],
        ["HTTPCapsule", ["HTTPBaseCapsules"]],
    ] as const)("%s", (tsName, cddlNames) => {
        expect(unionMemberNames(model, tsName)).toEqual(cddlNames.flatMap(unionOf));
    });

    it("has a TS counterpart for every named CDDL rule", () => {
        const skip = new Set(["$ProtocolEventData", "$QuicFrame", "$HTTP3Frame", "$HTTPCapsule"]);
        const missing = [...new Set(allRules.map((r) => r.name))]
            .filter((n) => !skip.has(n))
            .map(tsNameOf)
            .filter((n) => !model.aliases.has(n) && !model.interfaces.has(n));
        expect(missing).toEqual([]);
    });
});

describe("exported value arrays", () => {
    const frameTypes = (unionRule: string) =>
        allRules
            .filter((r) => r.name === unionRule)
            .flatMap((r) => cddlAlternatives(r.value))
            .map((frame) => {
                const rule = allRules.find((r) => r.name === frame && r.kind === "map");
                const discriminant = rule?.members.find((m) => m.name === "frame_type" || m.name === "capsule_type");
                return discriminant ? cddlLiterals(discriminant.value)[0] : `<${frame}?>`;
            });

    it("QUIC_FRAME_TYPES lists every frame_type of QuicBaseFrames, in order", () => {
        expect([...QUIC_FRAME_TYPES]).toEqual(frameTypes("QuicBaseFrames"));
    });
    it("HTTP3_FRAME_TYPES lists every frame_type of HTTP3BaseFrames / HTTP3ExtensionFrames, in order", () => {
        expect([...HTTP3_FRAME_TYPES]).toEqual([
            ...frameTypes("HTTP3BaseFrames"),
            ...frameTypes("HTTP3ExtensionFrames"),
        ]);
    });
    it("HTTP_CAPSULE_TYPES lists every capsule_type of HTTPBaseCapsules", () => {
        expect([...HTTP_CAPSULE_TYPES]).toEqual(frameTypes("HTTPBaseCapsules"));
    });
    it.each([
        ["PACKET_TYPES", "$PacketType", PACKET_TYPES],
        ["PACKET_NUMBER_SPACES", "$PacketNumberSpace", PACKET_NUMBER_SPACES],
        ["KEY_TYPES", "$KeyType", KEY_TYPES],
        ["TRANSPORT_ERRORS", "$TransportError", TRANSPORT_ERRORS],
        ["HTTP3_STREAM_TYPES", "$HTTP3StreamType", HTTP3_STREAM_TYPES],
        ["HTTP3_SETTINGS_NAMES", "$HTTP3SettingsName", HTTP3_SETTINGS_NAMES],
    ] as const)("%s matches %s", (_name, rule, values) => {
        expect([...values]).toEqual(cddlChoiceValues(allRules, rule));
    });
    it("HTTP3_APPLICATION_ERRORS = the -13 values followed by the editor's-copy additions", () => {
        expect([...HTTP3_APPLICATION_ERRORS]).toEqual([
            ...cddlChoiceValues(allRules, "HTTP3ApplicationError"),
            ...EDITORS_COPY_HTTP3_ERRORS,
        ]);
    });
});

describe("frame guards", () => {
    it("isQuicFrame accepts the -13 frame types only", () => {
        expect(isQuicFrame({ frame_type: "ack", acked_ranges: [[0, 2], [4]] })).toBe(true);
        expect(
            isQuicFrame({
                frame_type: "reset_stream_at",
                stream_id: 0,
                error: "unknown",
                final_size: 1,
                reliable_size: 0,
            }),
        ).toBe(true);
        const ext: QuicExtensionFrame = { frame_type: "ack_frequency", sequence_number: 0 };
        expect(isQuicFrame(ext)).toBe(false);
        expect(isQuicFrame({} as QuicExtensionFrame)).toBe(false);
        expect(isQuicFrame({ frame_type: 42 } as unknown as QuicFrame)).toBe(false);
    });
    it("isHTTP3Frame accepts the h3-events-13 frame types only", () => {
        expect(isHTTP3Frame({ frame_type: "headers", headers: [] })).toBe(true);
        expect(isHTTP3Frame({ frame_type: "origin", origin_entries: [] })).toBe(true);
        expect(isHTTP3Frame({ frame_type: "webtransport_stream" })).toBe(false);
    });
});
