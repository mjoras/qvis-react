// End-to-end checks for the client-side converters (converters spec sections 2 and 8.8): Chrome netlog and tshark JSON
// uploads through the file manager, ?file= loading of a netlog, the converter toasts, and every tool route showing
// converted traces without console errors.

import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NETLOG = path.join(ROOT, "tests/fixtures/netlog/cloudflare-quic.netlog");
const NETLOG_MULTI = path.join(ROOT, "tests/fixtures/netlog/multi-session.netlog.gz");
const TSHARK = path.join(ROOT, "tests/fixtures/tshark/tls13-h2-duplicate-keys.json");
const TSHARK_DEMO = path.join(ROOT, "tests/fixtures/tshark/wikipedia_Playstation.json.gz");

const NO_FILE_ALERT = "Please load a trace file to visualize it";

const ROUTES = [
    { path: "/sequence", tab: "Sequence" },
    { path: "/congestion", tab: "Congestion" },
    { path: "/multiplexing", tab: "Multiplexing" },
    { path: "/packetization", tab: "Packetization" },
    { path: "/stats", tab: "qlog stats" },
];

// Every test fails on a console error or uncaught exception, except for the ones a test explicitly expects.
const test = base.extend<{ consoleErrors: string[]; allowedErrors: RegExp[] }>({
    allowedErrors: [[], { option: true }],
    consoleErrors: [
        async ({ page, allowedErrors }, use) => {
            const errors: string[] = [];
            page.on("console", (m) => {
                if (m.type() === "error") errors.push(m.text());
            });
            page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
            await use(errors);
            const unexpected = errors.filter((e) => !allowedErrors.some((re) => re.test(e)));
            expect(unexpected, "console errors / uncaught exceptions").toEqual([]);
        },
        { auto: true },
    ],
});

const loadedFiles = (page: Page) => page.locator("#loadedGroupsContainer > .row");
const toast = (page: Page, title: string) =>
    page.locator(".vue-notification", {
        has: page.locator(".notification-title", {
            hasText: new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        }),
    });

async function dismissToasts(page: Page): Promise<void> {
    const items = page.locator(".vue-notification-group .vue-notification");
    for (let n = await items.count(); n > 0; n = await items.count()) {
        // the toast can expire on its own between count() and click(): never wait for one that is gone
        await items
            .first()
            .click({ force: true, timeout: 2000 })
            .catch(() => {});
        await expect.poll(() => items.count()).toBeLessThan(n); // toasts expiring meanwhile can drop the count by >1
    }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, "page must not scroll horizontally").toBeLessThanOrEqual(clientWidth);
}

type UploadFile = string | { name: string; mimeType: string; buffer: Buffer };

async function upload(page: Page, file: UploadFile): Promise<void> {
    await page.locator("#fileUpload").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();
}

async function uploadOk(page: Page, file: UploadFile): Promise<void> {
    await upload(page, file);
    const name = typeof file === "string" ? path.basename(file) : file.name;
    // conversion runs on the main thread; give large inputs time when the shared dev server is busy
    await expect(toast(page, "Uploaded file").filter({ hasText: name })).toBeVisible({ timeout: 20_000 });
}

/** Visits every tool route through the menu; none may show the "no file" alert or log an error. */
async function visitAllRoutes(page: Page, testInfo: { outputPath: (name: string) => string }, prefix: string) {
    for (const route of ROUTES) {
        await dismissToasts(page);
        await page.locator("#MainMenu .nav-link", { hasText: route.tab }).click();
        await expect(page).toHaveURL(new RegExp(`#${route.path}$`));
        await expect(page.locator("#MainMenu .nav-link.active")).toHaveText(route.tab);
        await expect(page.getByText(NO_FILE_ALERT)).toHaveCount(0);
        // give the visualization time to render (and to throw, if it would)
        await page.waitForTimeout(800);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`${prefix}${route.path.slice(1)}.png`), fullPage: true });
    }
}

test.describe("Chrome netlog", () => {
    test("uploads a netlog via #/files and shows it in #/sequence", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await uploadOk(page, NETLOG);
        await expect(loadedFiles(page)).toHaveCount(1);
        await expect(loadedFiles(page).first()).toContainText("cloudflare-quic.netlog");
        await expect(loadedFiles(page).first()).toContainText("(1 connection)");
        // converted output is strictly latest-draft: no DM3 / DM2, and info-level converter notes give no toast
        await expect(toast(page, "Unsupported qlog event names in ")).toHaveCount(0);
        await expect(toast(page, "Non-compliant qlog file ")).toHaveCount(0);
        await expect(toast(page, "Converted with warnings")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("netlog-files.png"), fullPage: true });

        await dismissToasts(page);
        await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
        await expect(page).toHaveURL(/#\/sequence$/);
        await expect(page.getByText(NO_FILE_ALERT)).toHaveCount(0);
        await expect(
            page.getByText(
                "Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram",
                { exact: true },
            ),
        ).toBeVisible();
        // the converted trace is selectable as "client : <host>-<connection id>"
        await expect(
            page.locator("select option", { hasText: "client : cloudflare-quic.com-bb9e480eb70b79bd" }).first(),
        ).toBeAttached({ timeout: 15_000 });
        await page.waitForTimeout(1000);
        // the converter output reaches the view: C8 marker label, T2 header parsing (Q12), wire error names (Q15/Q16)
        for (const label of [
            "info: CERT_VERIFIER_REQUEST BEGIN",
            "info: CERT_VERIFIER_REQUEST END",
            "GET / (stream 0) cloudflare-quic.com",
            "200 (stream 0)",
            "stop sending 15 (http_stream_creation_error)",
            "connection_close : clean",
        ]) {
            await expect(page.getByText(label, { exact: true })).toHaveCount(1);
        }
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("netlog-sequence.png"), fullPage: true });
    });

    test("loads a gzipped multi-session netlog and every tool route renders it", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await uploadOk(page, NETLOG_MULTI);
        await expect(loadedFiles(page).first()).toContainText("(3 connections)");
        await visitAllRoutes(page, testInfo, "netlog-multi-");
    });

    test("loads a netlog from ?file= at startup", async ({ page }) => {
        await page.goto(
            "/?file=" +
                encodeURIComponent("http://localhost:5179/tests/fixtures/netlog/cloudflare-quic.netlog") +
                "#/sequence",
        );
        await expect(page).toHaveURL(/#\/sequence/);
        await page.locator("#MainMenu .nav-link", { hasText: "Manage files" }).click();
        await expect(loadedFiles(page)).toHaveCount(1);
        await expect(loadedFiles(page).first()).toContainText("(1 connection)");
    });

    test("repairs a truncated netlog and says so", async ({ page }) => {
        const text = readFileSync(NETLOG, "utf8");
        await page.goto("/#/files");
        await uploadOk(page, {
            name: "truncated.netlog",
            mimeType: "application/json",
            buffer: Buffer.from(text.slice(0, Math.floor(text.length * 0.7))),
        });
        await expect(toast(page, "Netlog was truncated")).toBeVisible();
        await expect(toast(page, "Netlog was truncated")).toContainText(
            "The netlog file was not closed properly; events up to the cut-off were loaded.",
        );
        await expect(loadedFiles(page)).toHaveCount(1);
    });

    test.describe(() => {
        // the qvis upload path logs the failure to the console ("For more information, view the devtools console")
        test.use({ allowedErrors: [/^FileManagerContainer:uploadFile/] });
        test("explains a netlog without QUIC connections", async ({ page }) => {
            await page.goto("/#/files");
            const netlog = {
                constants: {
                    activeFieldTrialGroups: [],
                    logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 },
                    logEventTypes: { URL_REQUEST_START_JOB: 2 },
                    logSourceType: { URL_REQUEST: 1 },
                    timeTickOffset: "1600000000000",
                },
                events: [{ phase: 0, source: { id: 1, start_time: "1", type: 1 }, time: "1", type: 2 }],
            };
            await upload(page, {
                name: "tcp-only.netlog",
                mimeType: "application/json",
                buffer: Buffer.from(JSON.stringify(netlog)),
            });
            await expect(toast(page, "Error uploading file")).toContainText(
                "No QUIC connections found in this Chrome netlog.",
            );
            await expect(page.locator("#loadedGroupsContainer")).toHaveCount(0);
        });
    });
});

test.describe("tshark JSON (TCP + TLS + HTTP/2)", () => {
    test("uploads tshark JSON with duplicate keys and every tool route renders it", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await uploadOk(page, TSHARK);
        await expect(loadedFiles(page).first()).toContainText("(2 connections)");
        await expect(toast(page, "Converted with warnings")).toHaveCount(0);
        await visitAllRoutes(page, testInfo, "tshark-");
    });

    test("uploads the qvis TCP demo and shows it in #/packetization", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await uploadOk(page, TSHARK_DEMO);
        await expect(loadedFiles(page).first()).toContainText("(1 connection)");
        await dismissToasts(page);
        await page.locator("#MainMenu .nav-link", { hasText: "Packetization" }).click();
        await expect(page).toHaveURL(/#\/packetization$/);
        await expect(
            page
                .locator("select option", {
                    hasText:
                        "client : 172.18.15.26:38080 -> 91.198.174.208:443 => upload.wikimedia.org @ 16 TLS trailer size",
                })
                .first(),
        ).toBeAttached({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        // TCP mode (protocol_type TCP_HTTP2): qvis's four lanes per direction and flow labels, no QUIC-only labels
        await expect
            .poll(() =>
                page.evaluate(() =>
                    [...document.querySelectorAll("svg text")]
                        .map((t) => t.textContent ?? "")
                        .filter((s) => /^(TCP|TLS|HTTP\/[23]|Stream IDs|Bytes |Data |max receiving size)/.test(s)),
                ),
            )
            .toEqual([
                "TCP",
                "TLS",
                "HTTP/2",
                "Stream IDs",
                "Bytes received",
                "Data received by client from server (trace vantagepoint = client)",
                "TCP",
                "TLS",
                "HTTP/2",
                "Stream IDs",
                "Bytes sent",
                "Data sent from client to server (trace vantagepoint = client)",
            ]);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("tshark-demo-packetization.png"), fullPage: true });

        // TCP segments are drawn as arrows ("1RTT : <capture frame number>") and HTTP/2 frames get qvis's labels
        await dismissToasts(page);
        await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
        await expect(page).toHaveURL(/#\/sequence$/);
        for (const label of ["1RTT : 1", "magic created (stream -1)", "settings parsed (stream 0)"]) {
            await expect(page.getByText(label, { exact: true })).toHaveCount(1, { timeout: 15_000 });
        }
    });
});
