// End-to-end checks for the statistics page (`#/stats`, parity/statistics.md §8.5 E2E): empty state, auto-selection,
// File info / Trace N info tables on real generated latest-draft files, switching files, selection persistence across
// tabs, removing the selected file, the non-conforming quic-go output (listed in Events, otherwise not interpreted:
// strict latest drafts), the console step series (§3.10) and every premade demo file (Option 3) against its manifest.
// Every test fails on a console error or uncaught exception (same fixture as smoke.spec.ts).

import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOTH = "tests/fixtures/latest/stats-newcid-both.qlog";
const CLIENT = "tests/fixtures/latest/stats-newcid_client.sqlog";
const H3_CLIENT = "tests/fixtures/latest/stats-h3_client.sqlog";
const QUIC_GO = "tests/fixtures/nonconforming/h3-1x1M-noloss-client.sqlog";
const DEMO_MANIFEST = path.join(ROOT, "public/examples/index.json");

const INTRO = "Select a file via the dropdown(s) below to view its statistics";
const NO_PACKET_TYPE = "None of the events in this trace had data.header.packet_type set!";
const NO_STREAM_FC = "No stream level flow control limits set";

const test = base.extend<{ consoleErrors: string[] }>({
    consoleErrors: [
        async ({ page }, use) => {
            const errors: string[] = [];
            page.on("console", (m) => {
                if (m.type() === "error") errors.push(m.text());
            });
            page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
            await use(errors);
            expect(errors, "console errors / uncaught exceptions").toEqual([]);
        },
        { auto: true },
    ],
});

function statsURL(file: string, baseURL: string | undefined): string {
    return `/#/stats?file=${encodeURIComponent(new URL("/" + file, baseURL).href)}`;
}

async function dismissToasts(page: Page): Promise<void> {
    const items = page.locator(".vue-notification-group .vue-notification");
    for (let n = await items.count(); n > 0; n = await items.count()) {
        // the toast can expire on its own between count() and click(): never wait for one that is gone
        await items
            .first()
            .click({ force: true, timeout: 2000 })
            .catch(() => {});
        // another toast may time out at the same moment: wait for "fewer", not "exactly one fewer"
        await expect.poll(() => items.count()).toBeLessThan(n);
    }
}

async function upload(page: Page, file: string): Promise<void> {
    await page.locator("#fileUpload").setInputFiles(path.join(ROOT, file));
    await page.getByRole("button", { name: "Import" }).click();
    const uploaded = page.locator(".vue-notification", {
        has: page.locator(".notification-title", { hasText: /^Uploaded file/ }),
    });
    await expect(uploaded.filter({ hasText: path.basename(file) })).toBeVisible();
}

const container = (page: Page) => page.locator("#statistics-container");
const fileTable = (page: Page) => container(page).locator("table.stats-file-table");
const traceTable = (page: Page, i: number) => container(page).locator("table.stats-trace-table").nth(i);

/** Value cell (second td) of the direct row of `table` whose first cell starts with `label`. */
function cell(table: Locator, label: string): Locator {
    return table
        .locator(":scope > tbody > tr")
        .filter({ has: table.page().locator(":scope > td:first-child", { hasText: label }) })
        .first()
        .locator(":scope > td")
        .nth(1);
}

async function rowLabels(table: Locator): Promise<string[]> {
    return table.locator(":scope > tbody > tr > td:first-child").allInnerTexts();
}

test.describe("statistics page", () => {
    test("without files: intro, danger alert, empty bordered box", async ({ page }, testInfo) => {
        await page.goto("/#/stats");
        await expect(page.locator("#MainMenu .nav-link.active")).toHaveText("qlog stats");
        await expect(page.getByText(INTRO, { exact: true })).toBeVisible();
        await expect(page.locator(".stats-configurator .alert-danger")).toHaveText(
            "Please load a trace file to visualize it",
        );
        await expect(page.locator(".stats-configurator select")).toHaveCount(0);
        await expect(container(page)).toBeVisible();
        await expect(container(page)).toBeEmpty();
        await expect(container(page)).toHaveCSS("border-top", "5px solid rgb(255, 243, 205)");
        await expect(container(page)).toHaveCSS("min-height", "200px");
        await expect(page.locator(".stats-configurator")).toHaveCSS("background-color", "rgb(255, 243, 205)");
        // the intro keeps its natural width and is centered (Bootstrap 5 .row > * neutralized)
        const intro = await page.getByText(INTRO, { exact: true }).boundingBox();
        expect(intro!.width).toBeLessThan(600);
        expect(Math.abs(intro!.x + intro!.width / 2 - 800)).toBeLessThan(10);
        await page.screenshot({ path: testInfo.outputPath("stats-empty.png"), fullPage: true });
    });

    test("two-trace latest-draft file: File info and Trace N info", async ({ page, baseURL }, testInfo) => {
        const debug: string[] = [];
        page.on("console", (m) => {
            if (m.type() === "debug") debug.push(m.text());
        });
        await page.goto(statsURL(BOTH, baseURL));
        await expect(container(page).locator("h3")).toHaveText(["File info", "Trace 1 info", "Trace 2 info"]);
        await dismissToasts(page);

        // file selector: group-only mode, auto-selected
        const select = page.locator(".stats-configurator select");
        await expect(select).toHaveCount(1);
        await expect(select).toHaveClass("form-select mb-3 mt-3");
        await expect(select.locator("option:checked")).toContainText("stats-newcid-both.qlog");
        await expect(page.locator(".stats-configurator .alert")).toHaveCount(0);

        // File info
        await expect(fileTable(page).locator("thead th")).toHaveText(["Aspect", "Value"]);
        await expect(fileTable(page).locator("thead th").first()).toHaveCSS("background-color", "rgb(52, 58, 64)");
        expect(await rowLabels(fileTable(page))).toEqual([
            "Filename",
            "Title",
            "Description",
            "qlog version",
            "Serialization format",
            "Trace count",
            "Total event count",
            "Diagnostics",
        ]);
        await expect(cell(fileTable(page), "qlog version")).toHaveText("urn:ietf:params:qlog:file:contained");
        await expect(cell(fileTable(page), "Serialization format")).toHaveText("application/qlog+json");
        await expect(cell(fileTable(page), "Trace count")).toHaveText("2");
        await expect(cell(fileTable(page), "Total event count")).toHaveText("200");

        // Trace 1: the client
        const t1 = traceTable(page, 0);
        expect((await rowLabels(t1)).slice(0, 9)).toEqual([
            "Title",
            "Description",
            "Vantage point",
            "Event schemas",
            "QUIC version",
            "ALPN",
            "H3 connection headers",
            "Event count",
            "Events",
        ]);
        await expect(cell(t1, "Vantage point")).toHaveText("quic-go v0.64.1+qlog-latestclient");
        await expect(cell(t1, "QUIC version")).toHaveText("00000001");
        await expect(cell(t1, "ALPN")).toHaveText("h3");
        await expect(cell(t1, "H3 connection headers")).toHaveText(
            /^User Agent .+ connected to Server .+ at localhost:\d+$/,
        );
        await expect(cell(t1, "H3 connection headers").locator("i > u")).toHaveCount(3);
        await expect(cell(t1, "Event count")).toHaveText("84");
        const events = cell(t1, "Events");
        await expect(events.locator("tr").first().locator("th")).toHaveText([
            "Category",
            "Event type",
            "Event count",
            "% of total occurence",
        ]);
        await expect(events.locator("td[rowspan]")).toHaveText(["quic", "http3"]);
        const bar = events.locator("[role=progressbar]").first();
        await expect(bar).toHaveAttribute("aria-valuemax", "84");
        await expect(bar).toHaveAttribute("aria-valuenow", "1.00");
        await expect(bar).toHaveText("1.19");
        await expect(bar).toHaveCSS("background-color", "rgb(0, 123, 255)");

        await expect(cell(t1, "Encryption level count")).toHaveText("3");
        await expect(cell(t1, "Encryption levels").locator("tr td:nth-child(2)")).toHaveText([
            "initial",
            "handshake",
            "1RTT",
        ]);
        const connFC = cell(t1, "Connection-level Flow Control evolution");
        await expect(connFC.locator("tr th")).toHaveText(["", "Viewpoint", "Evolution (bytes)", ""]);
        await expect(connFC.locator("tr td:nth-child(2)")).toHaveText(["Local (client)", "Remote (server)"]);
        const streamFC = cell(t1, "Stream-level Flow Control evolution");
        await expect(streamFC.locator("th:nth-child(2)")).toHaveText([
            "Local Streams (client)",
            "Remote Streams (server)",
        ]);
        await expect(t1.locator("td.stats-danger")).toHaveCount(0);

        // Trace 2: the server (labels swap)
        const t2 = traceTable(page, 1);
        await expect(cell(t2, "Vantage point")).toHaveText("quic-go v0.64.1+qlog-latestserver");
        await expect(cell(t2, "Event count")).toHaveText("116");
        await expect(cell(t2, "Connection-level Flow Control evolution").locator("tr td:nth-child(2)")).toHaveText([
            "Local (server)",
            "Remote (client)",
        ]);

        // spreadsheet-ready flow-control series on the console (console.debug, once per trace)
        await expect
            .poll(() => debug.filter((d) => d.startsWith("Connection-level FC TIMES for local viewpoint of Trace ")))
            .toHaveLength(2);
        expect(
            debug.some((d) => d.startsWith("Stream-level FC for remote viewpoint of Trace 1, stream bidi_local: ")),
        ).toBe(true);

        // desktop layout: 1024 px wide content, centered, no horizontal page scroll at 1600 px
        const inner = await container(page).locator(".stats-inner").boundingBox();
        expect(Math.round(inner!.width)).toBe(1024);
        const { sw, cw } = await page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
        }));
        expect(sw).toBeLessThanOrEqual(cw);
        await page.screenshot({ path: testInfo.outputPath("stats-both.png"), fullPage: true });
    });

    test("switching files, persistence across tabs, removing the selected file", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await upload(page, CLIENT);
        await upload(page, H3_CLIENT);
        await dismissToasts(page);

        await page.locator("#MainMenu .nav-link", { hasText: "qlog stats" }).click();
        await expect(page).toHaveURL(/#\/stats$/);
        const select = page.locator(".stats-configurator select");
        await expect(select.locator("option:not([hidden])")).toHaveText([
            /^stats-newcid_client\.sqlog \(quic-go qlog : /,
            /^stats-h3_client\.sqlog \(quic-go qlog : /,
        ]);
        // auto-selection: the oldest file
        await expect(select.locator("option:checked")).toContainText("stats-newcid_client.sqlog");
        await expect(cell(fileTable(page), "Filename")).toHaveText("stats-newcid_client.sqlog");
        await expect(cell(traceTable(page, 0), "Event count")).toHaveText("84");
        // qvis keys the histogram rows by position ('evt_' + index1 + '_' + index2): on a file switch every row is
        // patched in place and its bar animates (transition: width .6s) instead of being moved or recreated
        const eventBars = cell(traceTable(page, 0), "Events").locator('[role="progressbar"]');
        await expect(eventBars.first()).toHaveCSS("transition-property", "width");
        await expect(eventBars.first()).toHaveCSS("transition-duration", "0.6s");
        await eventBars.evaluateAll((bars) => bars.forEach((b, i) => b.setAttribute("data-pos", String(i))));
        const barsBefore = await eventBars.count();

        // choose the other file: everything re-renders for it (no accumulation)
        await select.selectOption({ label: (await select.locator("option").nth(1).textContent())! });
        await expect(cell(fileTable(page), "Filename")).toHaveText("stats-h3_client.sqlog");
        const kept = Math.min(barsBefore, await eventBars.count());
        expect(
            (await eventBars.evaluateAll((bars) => bars.map((b) => b.getAttribute("data-pos")))).slice(0, kept),
        ).toEqual(Array.from({ length: kept }, (_, i) => String(i)));
        await expect(cell(fileTable(page), "Serialization format")).toHaveText("application/qlog+json-seq");
        const t = traceTable(page, 0);
        await expect(cell(t, "Event count")).toHaveText("458");
        await expect(cell(t, "Frames").locator("tr td:nth-child(2)", { hasText: /^max_data$/ })).toHaveCount(1);
        await expect(cell(t, "Connection-level Flow Control evolution").locator("p")).not.toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("stats-h3.png"), fullPage: true });

        // the selection is global: survives a tab switch
        // (via the file manager: other tools are not this package's concern)
        await page.locator("#MainMenu .nav-link", { hasText: "Manage files" }).click();
        await page.locator("#MainMenu .nav-link", { hasText: "qlog stats" }).click();
        await expect(cell(fileTable(page), "Filename")).toHaveText("stats-h3_client.sqlog");

        // removing the selected file clears the selection and auto-selects groups[0] (FIX app-shell Q11)
        await page.locator("#MainMenu .nav-link", { hasText: "Manage files" }).click();
        await dismissToasts(page);
        await page
            .locator("#loadedGroupsContainer > .row", { hasText: "stats-h3_client.sqlog" })
            .getByRole("button", { name: "Remove" })
            .click();
        await page.locator("#MainMenu .nav-link", { hasText: "qlog stats" }).click();
        await expect(cell(fileTable(page), "Filename")).toHaveText("stats-newcid_client.sqlog");
        await expect(page.locator(".stats-configurator select option:not([hidden])")).toHaveCount(1);
    });

    test("non-conforming quic-go output: listed in Events, nothing interpreted (strict latest drafts)", async ({
        page,
        baseURL,
    }, testInfo) => {
        await page.goto(statsURL(QUIC_GO, baseURL));
        await expect(container(page).locator("h3")).toHaveText(["File info", "Trace 1 info"]);
        await expect(page.locator(".vue-notification", { hasText: "Unsupported qlog event names in " })).toBeVisible();
        await dismissToasts(page);

        await expect(cell(fileTable(page), "Diagnostics")).toContainText(
            "warning: Some events use names that are not defined by the latest qlog drafts",
        );
        const t = traceTable(page, 0);
        // the Events histogram lists what is in the file, under the logged (pre-final) namespaces
        await expect(cell(t, "Events").locator("td[rowspan]")).toHaveText([
            "transport",
            "recovery",
            "quic",
            "security",
        ]);
        // ... but the data of transport:* / recovery:* events is not interpreted (DM3: "the visualizations do not
        // interpret these events"): no frames, no packet types, no flow control, no QUIC version / ALPN
        await expect(cell(t, "Frame count")).toHaveText("0");
        await expect(cell(t, "Frames").locator("tr")).toHaveCount(1);
        await expect(cell(t, "Encryption level count")).toHaveText("0");
        await expect(cell(t, "Encryption levels")).toHaveText(NO_PACKET_TYPE);
        await expect(cell(t, "Connection-level Flow Control evolution")).toHaveText(NO_PACKET_TYPE);
        await expect(cell(t, "Stream-level Flow Control evolution")).toHaveText(NO_STREAM_FC);
        await expect(cell(t, "Stream-level Flow Control evolution")).toHaveCSS(
            "background-color",
            "rgb(245, 198, 203)",
        );
        expect(await rowLabels(t)).not.toContain("QUIC version");
        expect(await rowLabels(t)).not.toContain("ALPN");
        await page.screenshot({ path: testInfo.outputPath("stats-quicgo.png"), fullPage: true });
    });

    test("premade demo files (Option 3): every file renders, counts match the manifest (spec §8.5 E2E)", async ({
        page,
    }) => {
        test.skip(!existsSync(DEMO_MANIFEST), "public/examples/ not generated yet");
        const manifest = JSON.parse(readFileSync(DEMO_MANIFEST, "utf8")) as Array<{
            file: string;
            traces?: number;
            events?: number;
        }>;
        await page.goto("/#/files");
        await page.getByRole("button", { name: "Load example .qlog files" }).click();
        await expect(page.locator("#loadedGroupsContainer > .row")).toHaveCount(manifest.length, { timeout: 20000 });
        await dismissToasts(page);
        await page.locator("#MainMenu .nav-link", { hasText: "qlog stats" }).click();

        const select = page.locator(".stats-configurator select");
        const options = select.locator("option:not([hidden])");
        await expect(options).toHaveCount(manifest.length);
        // demo files are added in completion order, not manifest order: pick each option by its file name
        const labels = await options.allTextContents();
        for (const entry of manifest) {
            const label = labels.find((l) => l.includes(entry.file));
            expect(label, entry.file).toBeDefined();
            await select.selectOption({ label: label! });
            await expect(cell(fileTable(page), "Filename")).toContainText(entry.file);
            const headings = container(page).locator("h3");
            await expect(headings.first()).toHaveText("File info");
            if (entry.traces !== undefined) {
                await expect(cell(fileTable(page), "Trace count")).toHaveText(String(entry.traces));
                await expect(headings).toHaveCount(entry.traces + 1);
            }
            if (entry.events !== undefined) {
                await expect(cell(fileTable(page), "Total event count")).toHaveText(String(entry.events));
            }
            // conforming demo data: every trace has packet types and transport parameters
            await expect(container(page).locator("td.stats-danger")).toHaveCount(0);
            const { sw, cw } = await page.evaluate(() => ({
                sw: document.documentElement.scrollWidth,
                cw: document.documentElement.clientWidth,
            }));
            expect(sw).toBeLessThanOrEqual(cw);
        }
    });
});
