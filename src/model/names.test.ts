/**
 * Drift guard for the event name constants: KNOWN_EVENT_NAMES, the per-namespace type lists, importance levels and
 * the EventDataMap must match what the PUBLISHED drafts define (main-schema-14, quic-events-13, h3-events-13),
 * re-extracted here from the draft texts (tests/fixtures/unit/drafts/*.txt).
 */
import { describe, expect, it } from "vitest";
import {
    eventDataTypeName,
    ianaEventTypes,
    proseImportance,
    tableEvents,
    cddlRules,
    cddlAlternatives,
    type DraftId,
} from "@/qlog/schema/__fixtures__/drafts";
import namesSource from "./names.ts?raw";
import {
    classifyEventName,
    EVENT_IMPORTANCE,
    EVENT_SCHEMA_URI,
    EVENT_TYPES_BY_NAMESPACE,
    fullName,
    HTTP,
    HTTP3,
    HTTP3_EVENT_TYPES,
    HTTP3_EVENTS,
    HTTP_EVENT_TYPES,
    HTTP_EVENTS,
    isKnownEventName,
    isKnownNamespace,
    KNOWN_EVENT_NAMES,
    LOGLEVEL,
    LOGLEVEL_EVENT_TYPES,
    LOGLEVEL_EVENTS,
    NS,
    QUIC,
    QUIC_EVENT_TYPES,
    QUIC_EVENTS,
    SIMULATION,
    SIMULATION_EVENT_TYPES,
    SIMULATION_EVENTS,
    splitEventName,
} from "./names";

const DRAFTS: DraftId[] = ["main-schema-14", "quic-events-13", "h3-events-13"];

/** namespace -> draft that registers it (IANA section), and its event types in registration order */
const registered = new Map<string, { draft: DraftId; types: string[] }>();
for (const draft of DRAFTS) {
    for (const [ns, types] of ianaEventTypes(draft)) registered.set(ns, { draft, types });
}
const draftEventNames = [...registered].flatMap(([ns, { types }]) => types.map((t) => `${ns}:${t}`));

describe("KNOWN_EVENT_NAMES", () => {
    it("the drafts register exactly the five expected namespaces", () => {
        expect([...registered.keys()]).toEqual(["loglevel", "simulation", "quic", "http3", "http"]);
    });

    it("equals the event names registered by the three drafts (IANA considerations)", () => {
        expect(draftEventNames.length).toBe(57); // 5 loglevel + 2 simulation + 39 quic + 9 http3 + 2 http
        expect([...KNOWN_EVENT_NAMES].sort()).toEqual([...draftEventNames].sort());
    });

    it("equals the event tables of quic-events-13 (Table 1) and h3-events-13 (Tables 1, 2)", () => {
        const tables = [...tableEvents("quic-events-13"), ...tableEvents("h3-events-13")].map((e) => e.name);
        const fromConstants = [
            ...QUIC_EVENT_TYPES.map((t) => `quic:${t}`),
            ...Object.values(HTTP3_EVENTS),
            ...Object.values(HTTP_EVENTS),
        ];
        // same order as the tables (and as the drafts' EventData unions)
        expect(fromConstants).toEqual(tables);
    });

    it("lists each namespace's types in draft order", () => {
        expect([...LOGLEVEL_EVENT_TYPES]).toEqual(registered.get("loglevel")?.types);
        expect([...SIMULATION_EVENT_TYPES]).toEqual(registered.get("simulation")?.types);
        expect([...HTTP3_EVENT_TYPES]).toEqual(registered.get("http3")?.types);
        expect([...HTTP_EVENT_TYPES]).toEqual(registered.get("http")?.types);
        // the quic IANA list orders timer_updated differently from Table 1; the set is the same
        expect([...QUIC_EVENT_TYPES].sort()).toEqual([...(registered.get("quic")?.types ?? [])].sort());
        for (const ns of Object.values(NS)) {
            expect([...EVENT_TYPES_BY_NAMESPACE[ns]].sort()).toEqual([...(registered.get(ns)?.types ?? [])].sort());
        }
    });
});

describe("EVENT_IMPORTANCE", () => {
    it("matches the importance stated by the drafts", () => {
        const expected: Record<string, string | undefined> = {};
        for (const e of [...tableEvents("quic-events-13"), ...tableEvents("h3-events-13")]) {
            expected[e.name] = e.importance;
        }
        for (const ns of ["loglevel", "simulation"]) {
            for (const t of registered.get(ns)?.types ?? [])
                expected[`${ns}:${t}`] = proseImportance("main-schema-14", t);
        }
        expect(EVENT_IMPORTANCE).toEqual(expected);
    });
});

describe("EventDataMap", () => {
    // EventDataMap is a type, so its source is compared with the drafts: every entry must name the CDDL data type
    // defined in the event's section (interface names in src/qlog/schema/* are the CDDL rule names).
    const body = /export interface EventDataMap \{([\s\S]*?)\n\}/.exec(namesSource)?.[1] ?? "";
    const entries = new Map(
        [...body.matchAll(/^\s+"([a-z0-9]+:[a-z0-9_]+)": (?:[A-Z]\.)?([A-Za-z0-9]+);$/gm)].map((m) => [m[1], m[2]]),
    );

    it("has one entry per known event name", () => {
        expect([...entries.keys()].sort()).toEqual([...KNOWN_EVENT_NAMES].sort());
    });

    it.each(draftEventNames.map((n) => [n] as const))("%s", (name) => {
        const [ns, type] = name.split(":");
        const draft = registered.get(ns)?.draft as DraftId;
        expect(entries.get(name)).toBe(eventDataTypeName(draft, type));
    });

    it("follows each namespace's <X>EventData union in the drafts", () => {
        const unions: Record<string, [DraftId, string]> = {
            loglevel: ["main-schema-14", "LogLevelEventData"],
            simulation: ["main-schema-14", "SimulationEventData"],
            quic: ["quic-events-13", "QuicEventData"],
            http3: ["h3-events-13", "HTTP3EventData"],
            http: ["h3-events-13", "HTTPEventData"],
        };
        for (const [ns, [draft, union]] of Object.entries(unions)) {
            const rule = cddlRules(draft).find((r) => r.name === union);
            const fromMap = [...entries].filter(([n]) => n.startsWith(`${ns}:`)).map(([, t]) => t);
            expect(fromMap, ns).toEqual(cddlAlternatives(rule?.value ?? ""));
        }
    });
});

describe("constants", () => {
    it("type constants map each type to itself", () => {
        expect(QUIC.packet_sent).toBe("packet_sent");
        expect(QUIC.recovery_metrics_updated).toBe("recovery_metrics_updated");
        expect(HTTP3.frame_created).toBe("frame_created");
        expect(HTTP.capsule_parsed).toBe("capsule_parsed");
        expect(LOGLEVEL.error).toBe("error");
        expect(SIMULATION.marker).toBe("marker");
        for (const [k, v] of Object.entries(QUIC)) expect(v).toBe(k);
        expect(Object.keys(QUIC)).toEqual([...QUIC_EVENT_TYPES]);
    });

    it("full-name constants are namespace:type", () => {
        expect(QUIC_EVENTS.packet_sent).toBe("quic:packet_sent");
        expect(HTTP3_EVENTS.frame_parsed).toBe("http3:frame_parsed");
        expect(HTTP_EVENTS.capsule_created).toBe("http:capsule_created");
        expect(LOGLEVEL_EVENTS.warning).toBe("loglevel:warning");
        expect(SIMULATION_EVENTS.scenario).toBe("simulation:scenario");
        for (const [k, v] of Object.entries(HTTP3_EVENTS)) expect(v).toBe(`http3:${k}`);
    });

    it("constants are frozen", () => {
        expect(Object.isFrozen(QUIC)).toBe(true);
        expect(Object.isFrozen(QUIC_EVENTS)).toBe(true);
    });

    it("event schema URIs follow urn:ietf:params:qlog:events:<namespace>", () => {
        for (const ns of Object.values(NS)) expect(EVENT_SCHEMA_URI[ns]).toBe(`urn:ietf:params:qlog:events:${ns}`);
    });
});

describe("helpers", () => {
    it("isKnownEventName", () => {
        expect(isKnownEventName("quic:packet_sent")).toBe(true);
        expect(isKnownEventName("quic:frames_processed")).toBe(true); // in -13, removed in the editor's copy
        expect(isKnownEventName("http:capsule_parsed")).toBe(true);
        expect(isKnownEventName("loglevel:verbose")).toBe(true);
        expect(isKnownEventName("transport:packet_sent")).toBe(false);
        expect(isKnownEventName("quic:metrics_updated")).toBe(false);
        expect(isKnownEventName("http:frame_created")).toBe(false);
        expect(isKnownEventName("QUIC:packet_sent")).toBe(false); // no case folding
        expect(isKnownEventName("packet_sent")).toBe(false);
        expect(isKnownEventName("")).toBe(false);
        expect(isKnownEventName("toString")).toBe(false);
    });

    it("isKnownNamespace", () => {
        for (const ns of ["quic", "http3", "http", "loglevel", "simulation"]) expect(isKnownNamespace(ns)).toBe(true);
        for (const ns of ["transport", "tcp", "", "constructor"]) expect(isKnownNamespace(ns)).toBe(false);
    });

    it("classifyEventName", () => {
        expect(classifyEventName("quic:packet_sent")).toBe("known");
        expect(classifyEventName("http3:frame_created")).toBe("known");
        // pre-final names (quic-go master, quiche, draft-02)
        for (const n of [
            "transport:packet_sent",
            "recovery:metrics_updated",
            "security:key_updated",
            "connectivity:connection_started",
            "http:frame_created",
            "qpack:state_updated",
            "quic:datagrams_sent",
            "quic:key_retired",
            "quic:loss_timer_updated",
            "simulation:foo",
            "packet_sent",
        ]) {
            expect(classifyEventName(n), n).toBe("nonconforming");
        }
        // private namespaces (converters, private schemas)
        for (const n of ["tcp:packet_sent", "tls:record_created", "http2:frame_parsed", "myns:event"]) {
            expect(classifyEventName(n), n).toBe("private");
        }
    });

    it("fullName / splitEventName", () => {
        expect(fullName(NS.quic, QUIC.packet_sent)).toBe(QUIC_EVENTS.packet_sent);
        expect(splitEventName("quic:packet_sent")).toEqual({ namespace: "quic", type: "packet_sent" });
        expect(splitEventName("myns:a:b")).toEqual({ namespace: "myns", type: "a:b" }); // first colon only
        expect(splitEventName("packet_sent")).toEqual({ namespace: "unknown", type: "packet_sent" });
        expect(splitEventName("")).toEqual({ namespace: "unknown", type: "unknown" });
        expect(splitEventName(undefined)).toEqual({ namespace: "unknown", type: "unknown" });
        for (const n of KNOWN_EVENT_NAMES) {
            const { namespace, type } = splitEventName(n);
            expect(fullName(namespace, type)).toBe(n);
        }
    });
});
