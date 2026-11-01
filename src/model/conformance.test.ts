import { schemasListNamespace, checkEventSchemas, isNonconformingName, parseEventSchemaUri } from "./conformance";

describe("event schema URIs", () => {
    it("parses final, draft, extension and private URIs", () => {
        expect(parseEventSchemaUri("urn:ietf:params:qlog:events:quic-13")).toEqual({
            uri: "urn:ietf:params:qlog:events:quic-13",
            namespace: "quic",
            draft: 13,
        });
        expect(parseEventSchemaUri("urn:ietf:params:qlog:events:http3")).toEqual({
            uri: "urn:ietf:params:qlog:events:http3",
            namespace: "http3",
        });
        expect(parseEventSchemaUri("urn:ietf:params:qlog:events:quic#new-frame-extension")).toMatchObject({
            namespace: "quic",
            extension: "new-frame-extension",
        });
        expect(parseEventSchemaUri("urn:ietf:params:qlog:events:rick#astley")).toMatchObject({
            namespace: "rick",
            extension: "astley",
        });
        expect(parseEventSchemaUri("https://example.com/032024/pickle.html#lilly")).toEqual({
            uri: "https://example.com/032024/pickle.html#lilly",
            extension: "lilly",
        });
        expect(parseEventSchemaUri("https://example.com/032025/cucumber.html")).toEqual({
            uri: "https://example.com/032025/cucumber.html",
        });
    });

    it("P14 checks", () => {
        const schemas = [
            "urn:ietf:params:qlog:events:quic-12",
            "urn:ietf:params:qlog:events:http3-13",
            "urn:ietf:params:qlog:events:loglevel",
        ].map(parseEventSchemaUri);
        expect(checkEventSchemas(schemas, ["quic", "unknown", "simulation"])).toEqual({
            unlistedNamespaces: ["simulation"],
            unusedSchemas: ["urn:ietf:params:qlog:events:http3-13", "urn:ietf:params:qlog:events:loglevel"],
            draftMismatches: ["urn:ietf:params:qlog:events:quic-12"],
        });
    });
});

describe("isNonconformingName", () => {
    const none = [] as ReturnType<typeof parseEventSchemaUri>[];
    it.each([
        ["quic:packet_sent", false],
        ["http3:frame_created", false],
        ["http:capsule_parsed", false],
        ["loglevel:warning", false],
        ["simulation:marker", false],
        ["quic:metrics_updated", true],
        ["quic:loss_timer_updated", true],
        ["http:frame_created", true],
        ["transport:packet_sent", true],
        ["recovery:metrics_updated", true],
        ["security:key_updated", true],
        ["connectivity:connection_started", true],
        ["error:connection_error", true],
        ["tcp:packet_sent", false],
        ["http2:frame_created", false],
        ["nonamespace", false],
    ])("%s -> %s", (name, expected) => {
        const ns = name.includes(":") ? name.slice(0, name.indexOf(":")) : "unknown";
        expect(isNonconformingName(name, ns, none)).toBe(expected);
    });
});

describe("private schema URIs name a namespace by path segment", () => {
    it("matches whole segments only", () => {
        const schemas = [
            parseEventSchemaUri("https://github.com/mjoras/qvis-react/112026/quic#chromium"),
            parseEventSchemaUri("https://example.com/032024/pickle.html#lilly"),
        ];
        expect(schemasListNamespace(schemas, "quic")).toBe(true);
        expect(schemasListNamespace(schemas, "pickle")).toBe(true);
        expect(schemasListNamespace(schemas, "http")).toBe(false);
        expect(schemasListNamespace(schemas, "mjoras")).toBe(true);
        expect(schemasListNamespace(schemas, "qvis")).toBe(false);
    });
});
