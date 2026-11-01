import { detectSerialization, sniffQlogVersion } from "./detect";

describe("detectSerialization (P3)", () => {
    it("RS first means json-seq", () => {
        expect(detectSerialization('\u001e{"file_schema":"x"}\n')).toBe("json-seq");
        expect(detectSerialization('  \n\u001e{"a":1}')).toBe("json-seq");
    });

    it("BOM and leading whitespace are skipped", () => {
        expect(detectSerialization('﻿\u001e{"a":1}')).toBe("json-seq");
        expect(detectSerialization('﻿  {"file_schema":"urn:ietf:params:qlog:file:contained"}')).toBe("json");
    });

    it("first record without leading RS is still json-seq", () => {
        expect(detectSerialization('{"file_schema":"urn:ietf:params:qlog:file:sequential"}\n\u001e{"time":1}')).toBe(
            "json-seq",
        );
    });

    it("legacy qlog_version without file_schema", () => {
        expect(detectSerialization('{"qlog_version":"0.3","traces":[]}')).toBe("legacy");
        // quic-go: both members -> not legacy (file_schema wins)
        expect(
            detectSerialization(
                '{"file_schema":"urn:ietf:params:qlog:file:contained","qlog_version":"0.3","traces":[]}',
            ),
        ).toBe("json");
    });

    it("sequential header without RS is json-lines (lenient)", () => {
        expect(
            detectSerialization(
                '{"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"application/qlog+json-seq","trace":{}}\n{"time":1}',
            ),
        ).toBe("json-lines");
        expect(detectSerialization('{"serialization_format":"APPLICATION/QLOG+JSON-SEQ"}\n')).toBe("json-lines");
        // the non-media-type value written by quiche / neqo / quinn (file-loading 9.1 step 5)
        expect(detectSerialization('{"serialization_format":"JSON-SEQ","trace":{}}\n{"time":1}')).toBe("json-lines");
    });

    it("contained and non-qlog", () => {
        expect(detectSerialization('{"file_schema":"urn:ietf:params:qlog:file:contained","traces":[]}')).toBe("json");
        expect(detectSerialization('[{"_source":{}}]')).toBe("not-qlog");
        expect(detectSerialization("hello")).toBe("not-qlog");
        expect(detectSerialization("")).toBe("not-qlog");
    });

    it("sniffQlogVersion", () => {
        expect(sniffQlogVersion('{"qlog_version":"draft-02","x":1}')).toBe("draft-02");
        expect(sniffQlogVersion('{"qlog_version": 0.3}')).toBe("0.3");
        expect(sniffQlogVersion("{}")).toBe("");
    });
});
