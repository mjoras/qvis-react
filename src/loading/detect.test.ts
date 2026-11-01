import {
    classifyExtension,
    isPcapLikeURL,
    looksLikeText,
    sniffContent,
    sniffMagic,
    urlIsPcap,
    type ExtensionInfo,
} from "./detect";
import { PcapUnsupportedError, UnsupportedQlogSchemaError, UnsupportedQlogVersionError } from "./errors";

const ext = (hint: ExtensionInfo["hint"]): ExtensionInfo => ({ hint, compression: undefined, suffix: "" });

describe("classifyExtension (file-loading 3.4 table, case-insensitive)", () => {
    it.each([
        ["trace.qlognd", "ndjson", undefined],
        ["trace.qlogseq", "sequential", undefined],
        ["trace.sqlog", "sequential", undefined],
        ["trace.sqlog.gz", "sequential", "gzip"],
        ["capture.pcap.json", "tshark", undefined],
        ["chrome.netlog", "netlog", undefined],
        ["chrome.netlog.br", "netlog", "brotli"],
        ["chrome.netlog.brotli", "netlog", "brotli"],
        ["chrome.netlog.gz", "netlog", "gzip"],
        ["chrome.netlog.gzip", "netlog", "gzip"],
        ["chrome.netlog.zip", "netlog", "zip"],
        ["a.qlog", "contained", undefined],
        ["a.qlog.br", "contained", "brotli"],
        ["a.qlog.brotli", "contained", "brotli"],
        ["a.qlog.gz", "contained", "gzip"],
        ["a.qlog.gzip", "contained", "gzip"],
        ["a.qlog.zip", "contained", "zip"],
        ["a.json", "contained", undefined],
        ["a.json.gz", "contained", "gzip"],
        ["A.QLOG", "contained", undefined],
        ["A.SQLOG", "sequential", undefined],
        ["x.pcap", "pcap", undefined],
        ["x.pcapng", "pcap", undefined],
    ])("%s -> %s", (name, hint, compression) => {
        const r = classifyExtension(name);
        expect(r.hint).toBe(hint);
        expect(r.compression).toBe(compression);
    });

    it("throws the PARITY error for unknown extensions of local files", () => {
        expect(() => classifyExtension("notes.txt")).toThrow("File extension unsupported: notes.txt");
    });

    it("tests the full name first (QUIC Tracker ?.json trick)", () => {
        expect(
            classifyExtension("https://quic-tracker.info.ucl.ac.be/traces/x/list/quant.eggert.org:4433?.json", true)
                .hint,
        ).toBe("contained");
    });

    it("falls back to the URL pathname for URLs", () => {
        expect(classifyExtension("https://example.com/a/b.sqlog?raw=1", true).hint).toBe("sequential");
        expect(classifyExtension("https://example.com/a/b.qlog#frag", true).hint).toBe("contained");
    });

    it("allows unknown extensions for URLs (D8)", () => {
        expect(classifyExtension("https://example.com/download?id=3", true).hint).toBe("unknown");
    });
});

describe("pcap URL helpers", () => {
    it("isPcapLikeURL excludes tshark JSON", () => {
        expect(isPcapLikeURL("https://x/y.pcap")).toBe(true);
        expect(isPcapLikeURL("https://x/y.pcapng")).toBe(true);
        expect(isPcapLikeURL("https://x/y.PCAP")).toBe(true);
        expect(isPcapLikeURL("https://quic-tracker/traces/1/pcap")).toBe(true);
        expect(isPcapLikeURL("https://x/y.pcap.json")).toBe(false);
        expect(isPcapLikeURL("https://x/y.qlog")).toBe(false);
    });

    it("urlIsPcap keeps the qvis quirks", () => {
        expect(urlIsPcap("x.pcap")).toBe(true);
        expect(urlIsPcap("x.pcap.json")).toBe(true);
        expect(urlIsPcap("x.pcapng")).toBe(false);
    });
});

describe("sniffContent (file-loading 3.14 step 3)", () => {
    it("RS first means sequential", () => {
        expect(sniffContent('\u001e{"file_schema":"x"}', ext("contained"), "a.qlog")).toBe("sequential");
        expect(sniffContent('  \n\u001e{"a":1}', ext("unknown"), "u")).toBe("sequential");
    });

    it("serialization_format wins and is case-insensitive", () => {
        expect(sniffContent('{"serialization_format":"Application/QLOG+JSON-SEQ"}', ext("contained"), "a")).toBe(
            "sequential",
        );
        expect(
            sniffContent('{"serialization_format":"application/qlog+json; charset=utf-8"}', ext("sequential"), "a"),
        ).toBe("contained");
    });

    it("an unknown serialization_format never rejects a file (9.1 step 5): the sniff falls through", () => {
        expect(sniffContent('{"serialization_format":"application/cbor"}', ext("contained"), "a")).toBe("contained");
        expect(
            sniffContent(
                '{"serialization_format":"text/x-qlog","file_schema":"urn:ietf:params:qlog:file:sequential"}',
                ext("contained"),
                "a",
            ),
        ).toBe("sequential");
    });

    it("file_schema is compared trimmed and case-insensitively (9.1 step 3.1)", () => {
        expect(sniffContent('{"file_schema":" URN:IETF:params:qlog:file:Sequential "}', ext("contained"), "a")).toBe(
            "sequential",
        );
    });

    it("uses a 64K sniff window: a late file_schema (hash-ordered mvfst headers) is still found", () => {
        const head =
            '{"traces_placeholder":"' + "x".repeat(10000) + '","file_schema":"urn:ietf:params:qlog:file:sequential"}';
        expect(sniffContent(head, ext("unknown"), "https://h/no-extension")).toBe("sequential");
    });

    it("file_schema decides when serialization_format is absent", () => {
        expect(sniffContent('{"file_schema":"urn:ietf:params:qlog:file:sequential"}', ext("contained"), "a")).toBe(
            "sequential",
        );
        expect(sniffContent('{"file_schema":"urn:ietf:params:qlog:file:contained"}', ext("sequential"), "a")).toBe(
            "contained",
        );
        try {
            sniffContent('{"file_schema":"urn:example:other"}', ext("contained"), "a");
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(UnsupportedQlogSchemaError);
            expect((e as UnsupportedQlogSchemaError).field).toBe("file_schema");
            expect((e as UnsupportedQlogSchemaError).value).toBe("urn:example:other");
            expect((e as Error).message).toBe('Unsupported qlog file_schema "urn:example:other"');
        }
    });

    it("legacy qlog_version 0.3 throws UnsupportedQlogVersionError (X1)", () => {
        try {
            sniffContent('{"qlog_version":"0.3","qlog_format":"JSON-SEQ","trace":{}}', ext("sequential"), "a.sqlog");
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(UnsupportedQlogVersionError);
            expect((e as UnsupportedQlogVersionError).qlogVersion).toBe("0.3");
        }
        expect(() => sniffContent('{"qlog_version":"draft-02","traces":[]}', ext("contained"), "a")).toThrow(
            UnsupportedQlogVersionError,
        );
        // qlog_format without qlog_version is legacy too (9.1 step 3.2)
        try {
            sniffContent('{"qlog_format":"NDJSON","trace":{}}', ext("unknown"), "u");
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(UnsupportedQlogVersionError);
            expect((e as UnsupportedQlogVersionError).qlogVersion).toBe("NDJSON");
        }
    });

    it("file_schema next to a legacy qlog_version (current quic-go output) is not legacy", () => {
        const head =
            '{"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"application/qlog+json-seq","qlog_format":"JSON-SEQ","qlog_version":"0.3"}';
        expect(sniffContent(head, ext("sequential"), "a.sqlog")).toBe("sequential");
    });

    it("recognises a Chrome netlog head and a tshark head", () => {
        expect(sniffContent('{"constants":{"activeFieldTrialGroups":[]}}', ext("contained"), "x.json")).toBe("netlog");
        expect(sniffContent('[{"_index":"packets","_source":{"layers":{}}}]', ext("contained"), "x.json")).toBe(
            "tshark",
        );
    });

    it("strips a UTF-8 BOM", () => {
        expect(sniffContent('﻿{"file_schema":"urn:ietf:params:qlog:file:contained"}', ext("unknown"), "u")).toBe(
            "contained",
        );
        expect(sniffContent("﻿\u001e{}", ext("unknown"), "u")).toBe("sequential");
    });

    it("falls back to the extension (lenient), else throws the PARITY error", () => {
        expect(sniffContent('{"traces":[]}', ext("contained"), "a.qlog")).toBe("contained");
        expect(sniffContent('{"trace":{}}', ext("sequential"), "a.sqlog")).toBe("sequential");
        expect(sniffContent('{"x":1}', ext("netlog"), "a.netlog")).toBe("netlog");
        expect(() => sniffContent('{"x":1}', ext("pcap"), "a.pcap")).toThrow(PcapUnsupportedError);
        expect(() => sniffContent("<html><body>login</body></html>", ext("unknown"), "https://x/y")).toThrow(
            "File format unsupported (for qlogs, make sure file_schema and serialization_format are at the top of the file): https://x/y : <html><body>login</body></html>",
        );
    });

    it("empty input throws File is empty", () => {
        expect(() => sniffContent("", ext("contained"), "a.qlog")).toThrow("File is empty");
        expect(() => sniffContent("  \n ", ext("contained"), "a.qlog")).toThrow("File is empty");
    });
});

describe("magic bytes", () => {
    it("recognises gzip, zip and pcap/pcapng", () => {
        expect(sniffMagic(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe("gzip");
        expect(sniffMagic(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe("zip");
        expect(sniffMagic(new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1]))).toBe("pcap");
        expect(sniffMagic(new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a]))).toBe("pcap");
        expect(sniffMagic(new TextEncoder().encode("{}"))).toBeUndefined();
    });

    it("looksLikeText", () => {
        expect(looksLikeText(new TextEncoder().encode('  {"a":1}'))).toBe(true);
        expect(looksLikeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x1e]))).toBe(true);
        expect(looksLikeText(new Uint8Array([0x0b, 0x80, 0x00]))).toBe(false);
    });
});
