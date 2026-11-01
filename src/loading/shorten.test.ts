import { buildFileInfo, shortenForFilename, shortenURL } from "./shorten";

const EXAMPLE = "https://interop.seemann.io/logs/2023-01-01/quic-go_quiche/handshake/client/qlog/abc.qlog";

describe("shorten (file-loading 3.8)", () => {
    it("reproduces the spec example (88 chars)", () => {
        expect(EXAMPLE.length).toBe(88);
        expect(shortenForFilename(EXAMPLE)).toBe("https://interop.seemann.i...shake/client/qlog/abc.qlog");
        expect(shortenURL(EXAMPLE)).toBe("https://interop.seemann.i.../abc.qlog");
        expect(buildFileInfo(EXAMPLE, EXAMPLE)).toEqual({
            filename: "Loaded via URL (https://interop.seemann.i...shake/client/qlog/abc.qlog)",
            URL: EXAMPLE,
            URLshort: "https://interop.seemann.i.../abc.qlog",
        });
    });

    it("keeps strings of exactly 50 chars and shortens 51", () => {
        const s50 = "https://example.com/" + "a".repeat(30);
        expect(s50.length).toBe(50);
        expect(shortenForFilename(s50)).toBe(s50);
        expect(shortenURL(s50)).toBe(s50);
        const s51 = s50 + "b";
        expect(shortenForFilename(s51)).toBe(s51.slice(0, 25) + "..." + s51.slice(-26));
        expect(shortenForFilename(s51)).toHaveLength(54);
        expect(shortenURL(s51)).toBe("https://example.com/aaaaa.../" + "a".repeat(30) + "b");
    });

    it("URL without a slash after 25 chars repeats from the last slash (qvis formula)", () => {
        const u = "https://h.io/" + "x".repeat(60);
        expect(shortenURL(u)).toBe(u.slice(0, 25) + "..." + u.slice(u.lastIndexOf("/")));
    });

    it("string without any slash keeps only the last char after ... (substr(-1) parity)", () => {
        const u = "y".repeat(60);
        expect(shortenURL(u)).toBe("y".repeat(25) + "..." + "y");
    });

    it("multi-file display name and no URL", () => {
        expect(buildFileInfo("a.qlog etc.")).toEqual({ filename: "Loaded via URL (a.qlog etc.)" });
    });
});
