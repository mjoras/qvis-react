// Integration test over every visualization with the premade demo files (ARCHITECTURE §5): load Option 3, open each
// tool route, pick traces through the configurators, check that the visualization really rendered (SVG / canvas
// content, key element counts), that nothing scrolls horizontally and that no console error occurs. One screenshot per
// view goes to $QVIS_SCREENSHOT_DIR (when set) or to the test output folder.

import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(ROOT, "public/examples/index.json");

interface ManifestEntry {
    file: string;
    id: string;
    traces: number;
    events: number;
}

const DEMOS: ManifestEntry[] = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : [];
const MASSIVE_MANIFEST = path.join(ROOT, "public/examples/massive/index.json");
const MASSIVE: ManifestEntry | undefined = existsSync(MASSIVE_MANIFEST)
    ? (JSON.parse(readFileSync(MASSIVE_MANIFEST, "utf8")) as ManifestEntry[])[0]
    : undefined;
const demo = (id: string) => DEMOS.find((d) => d.id === id);

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

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    const dir = process.env.QVIS_SCREENSHOT_DIR;
    if (dir) mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: dir ? path.join(dir, name) : testInfo.outputPath(name) });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, "page must not scroll horizontally").toBeLessThanOrEqual(clientWidth);
}

/** Toasts sit bottom-center over the page and swallow clicks (qvis parity): click them away. */
async function dismissToasts(page: Page): Promise<void> {
    const items = page.locator(".vue-notification-group .vue-notification");
    for (let n = await items.count(); n > 0; n = await items.count()) {
        // the toast can expire on its own between count() and click(): never wait for one that is gone
        await items
            .first()
            .click({ force: true, timeout: 2000 })
            .catch(() => {});
        await expect.poll(() => items.count()).toBeLessThan(n);
    }
}

/** Navigates by clicking the menu tab (a hash change keeps the loaded files). */
async function openTab(page: Page, tab: string, hash: string): Promise<void> {
    await page.locator("#MainMenu .nav-link", { hasText: tab }).click();
    await expect(page).toHaveURL(new RegExp(`#${hash}$`));
}

/**
 * Selects the `vantage` trace of the demo file `id` in a ConnectionConfigurator select (group header option
 * `DEMO_<id>.qlog (...)`, followed by `↳ ... : <vantage> : ...` trace options). Groups arrive in completion order.
 */
async function selectTrace(select: Locator, id: string, vantage: "client" | "server"): Promise<void> {
    const index = await select.evaluate(
        (s, args) => {
            let inFile = false;
            const options = [...(s as HTMLSelectElement).options];
            for (let i = 0; i < options.length; ++i) {
                const text = options[i].text;
                if (!text.startsWith("↳")) inFile = text.startsWith("DEMO_" + args.id + ".");
                else if (inFile && text.includes(" : " + args.vantage + " : ")) return i;
            }
            return -1;
        },
        { id, vantage },
    );
    expect(index, `option for ${id} ${vantage}`).toBeGreaterThan(0);
    await select.selectOption({ index });
}

/** Number of canvas pixels that are not fully transparent and not white. */
async function inkedPixels(page: Page, selector: string): Promise<number> {
    return page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLCanvasElement | null;
        if (!c) return 0;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] !== 0 && !(d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255)) n++;
        }
        return n;
    }, selector);
}

test.describe("every view with the premade demo files (Option 3)", () => {
    test.skip(DEMOS.length === 0, "public/examples/index.json is not there");

    test("loads the demos and renders sequence, congestion, multiplexing, packetization and stats", async ({
        page,
    }, testInfo) => {
        test.setTimeout(120_000);
        await page.goto("/#/files");
        await page.getByRole("button", { name: "Load example .qlog files" }).click();
        const loaded = page.locator("#loadedGroupsContainer > .row");
        await expect(loaded).toHaveCount(DEMOS.length, { timeout: 30_000 });
        for (const d of DEMOS) await expect(loaded.filter({ hasText: "DEMO_" + d.file })).toHaveCount(1);
        await expect(page.locator(".vue-notification.warn, .vue-notification.error")).toHaveCount(0);
        await dismissToasts(page);
        await screenshot(page, testInfo, "files.png");

        await test.step("sequence diagram: 10_parallel_streams client + server", async () => {
            await openTab(page, "Sequence", "/sequence");
            const selects = page.locator(".sequence-diagram-configurator select");
            const svg = page.locator("#sequence-diagram-svg");
            // auto-selection: the first file's client + server pair
            await expect(selects).toHaveCount(2);
            await expect(svg.locator(":scope > rect")).toHaveCount(2);

            await selectTrace(selects.nth(0), "10_parallel_streams", "client");
            await selectTrace(selects.nth(1), "10_parallel_streams", "server");
            await expect(selects.nth(0).locator("option:checked")).toContainText(": client :");
            await expect(selects.nth(1).locator("option:checked")).toContainText(": server :");
            expect(await svg.locator(":scope > text").allTextContents()).toEqual(
                expect.arrayContaining(["client", "server"]),
            );
            // only the screen-height ranges around the viewport are drawn (virtualized), so these are lower bounds
            await expect.poll(() => svg.locator("rect[data-event]").count()).toBeGreaterThan(50);
            expect(await svg.locator('line[stroke="#0468cc"]').count()).toBeGreaterThan(0); // client -> server arrows
            expect(await svg.locator("g text.timestamp").count()).toBeGreaterThan(25);
            // the automatic latency offset is filled in for the right-hand trace
            const offset = await page.locator(".sequence-diagram-configurator input").first().inputValue();
            expect(Number.isFinite(parseFloat(offset))).toBe(true);
            await expectNoHorizontalOverflow(page);
            await screenshot(page, testInfo, "sequence.png");
        });

        await test.step("congestion graph: multistream_loss server", async () => {
            await openTab(page, "Congestion", "/congestion");
            const select = page.locator("#CongestionGraphContainer select");
            await expect(select).toHaveCount(1);
            await selectTrace(select, "multistream_loss", "server");
            await expect(select.locator("option:checked")).toContainText(": server :");
            await expect(page.locator("#mainGraphContainer canvas")).toBeVisible();
            await expect.poll(() => page.locator("#mainGraphContainer svg g.grid .tick").count()).toBeGreaterThan(5);
            await expect.poll(() => inkedPixels(page, "#mainGraphContainer canvas")).toBeGreaterThan(20_000);
            await expect.poll(() => inkedPixels(page, "#recoveryGraphContainer canvas")).toBeGreaterThan(500);
            for (const name of ["Reset zoom", "Zoom timerange", "Zoom area", "Ruler (press R)"]) {
                await expect(page.getByRole("button", { name })).toBeVisible();
            }
            await expectNoHorizontalOverflow(page);
            await screenshot(page, testInfo, "congestion.png");
        });

        await test.step("multiplexing graph: 10_parallel_streams client", async () => {
            await openTab(page, "Multiplexing", "/multiplexing");
            const select = page.locator("#MultiplexingGraphContainer select");
            await expect(select).toHaveCount(1);
            await selectTrace(select, "10_parallel_streams", "client");
            await expect(select.locator("option:checked")).toContainText(": client :");
            // ten requests: one waterfall bar each; the data-flow strip and the byte ranges have one rect per frame
            await expect.poll(() => page.locator("[id^=multiplexing-waterfall-] svg rect").count()).toBeGreaterThan(9);
            await expect.poll(() => page.locator("[id^=multiplexing-data-] svg rect").count()).toBeGreaterThan(100);
            await expect
                .poll(() => page.locator("[id^=multiplexing-byterange-] svg rect").count())
                .toBeGreaterThan(100);
            await expectNoHorizontalOverflow(page);
            await screenshot(page, testInfo, "multiplexing.png");
        });

        await test.step("packetization diagram: baseline server", async () => {
            await openTab(page, "Packetization", "/packetization");
            const select = page.locator("#PacketizationDiagramContainer select");
            await expect(select).toHaveCount(1);
            await selectTrace(select, "baseline", "server");
            await expect(select.locator("option:checked")).toContainText(": server :");
            // sending direction (top): QUIC packets, frames, HTTP/3 frames, stream lanes for a 1 MB response
            await expect.poll(() => page.locator("#packetization-diagram-top svg rect").count()).toBeGreaterThan(500);
            await expect.poll(() => page.locator("#packetization-diagram-bottom svg rect").count()).toBeGreaterThan(50);
            await expect(
                page.locator("#packetization-diagram-top svg text", { hasText: "QUIC" }).first(),
            ).toBeVisible();
            await expectNoHorizontalOverflow(page);
            await screenshot(page, testInfo, "packetization.png");
        });

        await test.step("statistics: every demo file", async () => {
            await openTab(page, "qlog stats", "/stats");
            const select = page.locator("#StatisticsContainer select");
            await expect(select).toHaveCount(1);
            for (const d of DEMOS) {
                const label = await select.evaluate(
                    (s, name) => [...(s as HTMLSelectElement).options].find((o) => o.text.startsWith(name))?.text,
                    "DEMO_" + d.file + " ",
                );
                expect(label, d.file).toBeTruthy();
                await select.selectOption({ label: label! });
                const fileTable = page.locator("#statistics-container table").first();
                await expect(fileTable.locator("tr", { hasText: "Trace count" })).toContainText(String(d.traces));
                await expect(fileTable.locator("tr", { hasText: "Total event count" })).toContainText(String(d.events));
                await expect(page.locator("#statistics-container h3", { hasText: /^Trace \d+ info$/ })).toHaveCount(
                    d.traces,
                );
            }
            const tenStreams = demo("10_parallel_streams");
            if (tenStreams) {
                const label = await select.evaluate(
                    (s, name) => [...(s as HTMLSelectElement).options].find((o) => o.text.startsWith(name))?.text,
                    "DEMO_" + tenStreams.file + " ",
                );
                await select.selectOption({ label: label! });
            }
            await expectNoHorizontalOverflow(page);
            await screenshot(page, testInfo, "stats.png");
        });

        // back on the file manager, nothing was added or lost on the way
        await openTab(page, "Manage files", "/files");
        await expect(loaded).toHaveCount(DEMOS.length);
    });
});

test.describe("every view with the massive demo file (Option 4)", () => {
    test.skip(MASSIVE === undefined, "public/examples/massive/index.json is not there");

    test("loads the massive trace and every view renders it without console errors", async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        await page.goto("/#/files");
        await page.getByRole("button", { name: /^Load .* file$/ }).click();
        const loaded = page.locator("#loadedGroupsContainer > .row");
        await expect(loaded).toHaveCount(1, { timeout: 60_000 });
        await expect(loaded.first()).toContainText("MASSIVE_DEMO_" + MASSIVE!.file);
        await dismissToasts(page);

        // time from the tab click (the views render synchronously on mount) until the content is there
        const timings: Record<string, number> = {};
        const view = async (tab: string, hash: string, name: string, rendered: () => Promise<void>) => {
            const t0 = Date.now();
            await openTab(page, tab, hash);
            await rendered();
            timings[name] = Date.now() - t0;
            await expectNoHorizontalOverflow(page);
            await screenshot(page, testInfo, "massive-" + name + ".png");
        };

        await view("Sequence", "/sequence", "sequence", async () => {
            await expect(page.locator("#sequence-diagram-svg > rect")).toHaveCount(2, { timeout: 30_000 });
            await expect.poll(() => page.locator("#sequence-diagram-svg rect[data-event]").count()).toBeGreaterThan(20);
            // virtualized rendering: never more than three screen-height range groups in the DOM
            expect(await page.locator("#sequence-diagram-svg > g").count()).toBeLessThanOrEqual(3);
        });

        await view("Congestion", "/congestion", "congestion", async () => {
            await expect
                .poll(() => inkedPixels(page, "#mainGraphContainer canvas"), { timeout: 30_000 })
                .toBeGreaterThan(20_000);
        });

        await view("Multiplexing", "/multiplexing", "multiplexing", async () => {
            await expect
                .poll(() => page.locator("[id^=multiplexing-data-] svg rect").count(), { timeout: 30_000 })
                .toBeGreaterThan(1000);
        });

        await view("Packetization", "/packetization", "packetization", async () => {
            await expect
                .poll(() => page.locator("#packetization-diagram-top svg rect").count(), { timeout: 30_000 })
                .toBeGreaterThan(1000);
        });

        await view("qlog stats", "/stats", "stats", async () => {
            const fileTable = page.locator("#statistics-container table").first();
            await expect(fileTable.locator("tr", { hasText: "Total event count" })).toContainText(
                String(MASSIVE!.events),
                { timeout: 30_000 },
            );
        });
        testInfo.annotations.push({ type: "render times (ms)", description: JSON.stringify(timings) });
        console.log("massive demo render times (ms):", JSON.stringify(timings));
    });
});
