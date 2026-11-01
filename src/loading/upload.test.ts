import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import type { LoadNotification } from "./messages";
import { isUploadAllowed, loadUploadedFiles, type UploadDeps } from "./upload";

const QLOG = JSON.stringify({
    file_schema: "urn:ietf:params:qlog:file:contained",
    serialization_format: "application/qlog+json",
    traces: [{ vantage_point: { type: "client" }, events: [{ time: 0, name: "quic:packet_sent", data: {} }] }],
});

function harness(accept = true) {
    const toasts: LoadNotification[] = [];
    const added: string[] = [];
    let outstanding = 0;
    const deps: UploadDeps = {
        notify: (n) => toasts.push(n),
        addGroupFromQlogFile: (_loaded, fileInfo, success) => {
            added.push(fileInfo.filename);
            if (!accept) return undefined;
            if (success) toasts.push(success);
            return {} as QlogConnectionGroup;
        },
        adjustOutstanding: (d) => (outstanding += d),
    };
    return { deps, toasts, added, outstanding: () => outstanding };
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("isUploadAllowed", () => {
    it("accepts the qvis suffixes (case-insensitive) and compressed variants (D10)", () => {
        for (const n of [
            "a.qlog",
            "a.sqlog",
            "a.json",
            "a.netlog",
            "a.qlognd",
            "A.QLOG",
            "a.qlog.gz",
            "a.sqlog.br",
            "a.json.gzip",
        ]) {
            expect(isUploadAllowed(n)).toBe(true);
        }
        for (const n of ["a.pcap", "a.txt", "a.qlog.zip", "a.keys", "qlog"]) expect(isUploadAllowed(n)).toBe(false);
    });
});

describe("loadUploadedFiles (file-loading 3.3)", () => {
    it("all-or-nothing validation: N3 for the first bad file, nothing loaded", async () => {
        const h = harness();
        await loadUploadedFiles(
            [new File([QLOG], "good.qlog"), new File(["x"], "bad.pcap"), new File(["x"], "bad2.txt")],
            h.deps,
        );
        expect(h.toasts).toEqual([
            {
                title: "Provide .qlog/.sqlog file",
                type: "error",
                duration: 6000,
                text: "We currently only support uploading .qlog/.sqlog files. bad.pcap",
            },
        ]);
        expect(h.added).toEqual([]);
    });

    it("loads every file: N4 each, N5 only after the model accepted it (FIX Q6), counter balanced (Q24)", async () => {
        const h = harness();
        await loadUploadedFiles([new File([QLOG], "a.qlog"), new File([QLOG], "b.qlog")], h.deps);
        expect(h.added.sort()).toEqual(["a.qlog", "b.qlog"]);
        expect(h.toasts.filter((t) => t.title === "Loading uploaded file").map((t) => t.text)).toEqual([
            "Loading uploaded file a.qlog.<br/>The file is not sent to a server.",
            "Loading uploaded file b.qlog.<br/>The file is not sent to a server.",
        ]);
        expect(h.toasts.filter((t) => t.title === "Uploaded file")).toHaveLength(2);
        expect(h.toasts.find((t) => t.title === "Uploaded file")?.text).toBe(
            "The uploaded file is now available for visualization a.qlog.<br/>Use the menu above to switch views.",
        );
        expect(h.outstanding()).toBe(0);
    });

    it("no N5 when the model rejects the file", async () => {
        const h = harness(false);
        await loadUploadedFiles([new File([QLOG], "a.qlog")], h.deps);
        expect(h.toasts.map((t) => t.title)).toEqual(["Loading uploaded file"]);
    });

    it("errors: N6 with the message appended; legacy files get X1", async () => {
        const h = harness();
        await loadUploadedFiles(
            [new File(["{ not json"], "broken.qlog"), new File(['{"qlog_version":"0.3","traces":[]}'], "old.qlog")],
            h.deps,
        );
        const n6 = h.toasts.find((t) => t.title === "Error uploading file");
        expect(
            n6?.text.startsWith(
                "Something went wrong. broken.qlog. For more information, view the devtools console.<br/>",
            ),
        ).toBe(true);
        const x1 = h.toasts.find((t) => t.title === "Unsupported qlog version in old.qlog");
        expect(x1?.type).toBe("error");
        expect(x1?.duration).toBe(10000);
        expect(h.outstanding()).toBe(0);
    });

    it("netlog uploads surface the converter error as a toast", async () => {
        const h = harness();
        await loadUploadedFiles(
            [new File(['{"constants":{"activeFieldTrialGroups":[]},"events":[]}'], "chrome.netlog")],
            h.deps,
        );
        const n6 = h.toasts.find((t) => t.title === "Error uploading file");
        expect(n6?.text).toMatch(/<br\/>Chrome netlog has no constants\.logEventTypes: chrome\.netlog$/);
    });
});
