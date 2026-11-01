// End-to-end checks for the multiplexing graph (#/multiplexing; docs/dev/parity/multiplexing-graph.md §8.6) on real,
// strictly conforming latest-draft data (tests/fixtures/latest/multiplexing-*), plus the non-conforming quic-go output.
// Every test fails on a console error or an uncaught exception.

import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { muxPanelDump } from "../../src/components/multiplexinggraph/__fixtures__/qvisParityDump";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LATEST = "tests/fixtures/latest";
const AIOQUIC_DEMO = "multiplexing-aioquic-parallel10-client.sqlog";
const QVIS_GOLDEN = "src/components/multiplexinggraph/__fixtures__/qvis-golden-aioquic-parallel10.json";
const PAR10_CLIENT = "multiplexing-par10-client.sqlog";
const PAR10_SERVER = "multiplexing-par10-server.sqlog";
const HANDWRITTEN = "multiplexing-handwritten-client.sqlog";
const NONCONFORMING = ["tests/fixtures/nonconforming", "tests/fixtures/quic-go"]
    .map((d) => path.join(d, "h3-10x50k-loss5-client.sqlog"))
    .find((f) => existsSync(path.join(ROOT, f)));

const INTRO = "Select a trace via the dropdown(s) below to visualize it in the stream graph";
const WATERFALL_EMPTY =
    "This trace doesn't contain multiple independent streams (or has less than 5 STREAM frames), which is needed for the waterfall.";

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

const panels = (page: Page) => page.locator("[id=multiplexingToplevelContainer]");
const waterfall = (scope: Page | Locator) => scope.locator("[id^=multiplexing-waterfall-]");
const strip = (scope: Page | Locator) => scope.locator("[id^=multiplexing-data-]");
const byteranges = (scope: Page | Locator) => scope.locator("[id^=multiplexing-byterange-]");
const tooltip = (page: Page) => page.locator("#multiplexing-packet-tooltip");
/** the tick labels of the first axis group inside a chart */
const ticks = (chart: Locator, axisIndex = 0) => chart.locator("svg > g > g").nth(axisIndex).locator(".tick text");

/**
 * Toasts sit bottom-center over the page and swallow clicks: click them away. Tolerant of toasts that expire on their
 * own meanwhile (the count can drop by more than one per click).
 */
async function dismissToasts(page: Page): Promise<void> {
    const items = page.locator(".vue-notification-group .vue-notification");
    await expect(async () => {
        const n = await items.count();
        if (n > 0) await items.first().click({ force: true, timeout: 1000 });
        expect(await items.count()).toBe(0);
    }).toPass({ timeout: 15_000 });
}

async function openWithFile(page: Page, baseURL: string | undefined, file: string, extraQuery = ""): Promise<void> {
    const url = new URL("/" + file, baseURL).href;
    await page.goto(`/#/multiplexing?file=${encodeURIComponent(url)}${extraQuery}`);
    await expect(strip(page).locator("svg")).toHaveCount(1);
    await dismissToasts(page);
}

async function upload(page: Page, files: string[]): Promise<void> {
    await page.goto("/#/files");
    await page.locator("#fileUpload").setInputFiles(files.map((f) => path.join(ROOT, LATEST, f)));
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.locator("#loadedGroupsContainer > .row")).toHaveCount(files.length);
    await dismissToasts(page);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("without files: intro text, the danger alert and no panel", async ({ page }) => {
    await page.goto("/#/multiplexing");
    await expect(page.getByText(INTRO, { exact: true })).toBeVisible();
    await expect(page.getByText("Please load a trace file to visualize it")).toBeVisible();
    await expect(panels(page)).toHaveCount(0);
    await expect(page.getByLabel("Show waterfall")).toBeChecked();
    await expect(page.getByLabel("Show byte ranges")).toBeChecked();
    await expect(page.locator("#MainMenu .nav-link.active")).toHaveCSS("background-color", "rgb(209, 236, 241)");
    await expectNoHorizontalOverflow(page);
});

test("renders waterfall, data flow and byte ranges for a 10-stream client trace", async ({
    page,
    baseURL,
}, testInfo) => {
    await openWithFile(page, baseURL, `${LATEST}/${PAR10_CLIENT}`);
    await expect(panels(page)).toHaveCount(1);
    // URL-loaded files are named "Loaded via URL (<shortened URL>)"
    await expect(panels(page).locator("h4")).toHaveText(
        /^Loaded via URL \(http:.*par10-client\.sqlog\) : quic-go v0\.64\.1\+qlog-latest : client : quic-go client trace/,
    );

    // configurator layout: the checkboxes and the button sit side by side (Bootstrap 5 .row > * reset, §8.5)
    const wfBox = (await page.locator("label[for=waterfall-checkbox]").boundingBox())!;
    const brBox = (await page.locator("label[for=byteranges-checkbox]").boundingBox())!;
    expect(Math.abs(wfBox.y - brBox.y)).toBeLessThan(2);
    expect(brBox.x).toBeGreaterThan(wfBox.x + wfBox.width + 16 + 24 - 2); // me-3 + the next checkbox box
    await expect(page.locator("#byteranges-checkbox")).toBeChecked();

    // all three charts: same width (§2.5), sizes of §2.4 / §3.6 / §3.7 / §3.9
    await expect(waterfall(page).locator("rect.packet")).toHaveCount(10);
    await expect(waterfall(page).locator("svg")).toHaveAttribute("height", "154");
    await expect(waterfall(page).locator("svg text")).toHaveText([
        "Request sent",
        'Colored while stream is "active" (between first and last STREAM frame received)',
    ]);
    expect(await strip(page).locator("rect.packet").count()).toBeGreaterThan(300);
    await expect(strip(page).locator("svg")).toHaveAttribute("height", "110");
    await expect(
        strip(page).getByText("Count of STREAM frames received (regardless of size, includes retransmits)"),
    ).toBeVisible();
    await expect(byteranges(page).locator("svg")).toHaveAttribute("height", "540");
    expect(await byteranges(page).locator("rect.packet").count()).toBeGreaterThan(10);
    await expect(byteranges(page).locator("rect.packet").first()).toHaveAttribute("fill", "#E1DA4C"); // stream 0
    const widths = await Promise.all(
        [waterfall(page), strip(page), byteranges(page)].map((l) => l.evaluate((e) => (e as HTMLElement).style.width)),
    );
    const topWidth = await panels(page).evaluate((e) => e.clientWidth);
    expect(widths).toEqual(Array(3).fill(Math.ceil((topWidth - 90) * 0.9075) + "px"));
    for (const label of ["Waterfall", "Multiplexed data flow", "Byterange per STREAM frame"]) {
        await expect(panels(page).getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Simulated FIFO order")).toBeHidden(); // M1
    await expectNoHorizontalOverflow(page);

    // hover: tooltip format (§2.6)
    await strip(page).locator("rect.packet").nth(60).hover();
    await expect(tooltip(page)).toHaveCSS("opacity", "0.95");
    expect(await tooltip(page).innerHTML()).toMatch(
        /^\d+(\.\d{1,6})?ms : stream \d+ : packet number \d+<br>\[\d+, \d+\] \(size: \d+\)(<br>(Fills gap that was created [\d.]+ms ago|Creates gap from \d+ to \d+ \(size: \d+\)))?$/,
    );
    await expect(tooltip(page)).toHaveCSS("background-color", "rgb(176, 196, 222)");
    await page.screenshot({ path: testInfo.outputPath("multiplexing-par10-client.png"), fullPage: true });
    await page.mouse.move(5, 5);
    await expect(tooltip(page)).toHaveCSS("opacity", "0");
});

test("waterfall click, strip click, wheel zoom and drag", async ({ page, baseURL }, testInfo) => {
    await openWithFile(page, baseURL, `${LATEST}/${PAR10_CLIENT}`);

    // waterfall bar -> details line + byte ranges of that stream; the strip is not re-rendered (M19)
    await strip(page)
        .locator("svg")
        .evaluate((e) => e.setAttribute("data-test-mark", "1"));
    const bar = waterfall(page).locator("rect.packet").nth(3);
    const barColor = await bar.getAttribute("fill");
    await bar.click();
    const details = page.getByText("Selected stream's details").locator("xpath=..");
    await expect(details).toBeVisible();
    await expect(details).toContainText(
        /Stream \d+ : Requested at \d+\.\d\dms\. Transmitted from \d+\.\d\dms to \d+\.\d\dms \(\d+\.\d\dms\)\. \d+ bytes spread over \d+ frames \(including retransmits\)\./,
    );
    await expect(details).toContainText(
        /HTTP\/3 HEADERS seen at \d+\.\d\dms\. HTTP\/3 PRIORITY Update seen at -1\.00ms\. Priority info \(if any\):/,
    );
    await expect(byteranges(page).locator("rect.packet").first()).toHaveAttribute("fill", barColor!);
    await expect(strip(page).locator("svg")).toHaveAttribute("data-test-mark", "1");

    // strip click -> byte ranges of that frame's stream
    const frame = strip(page).locator("rect.packet").nth(111);
    const frameColor = await frame.getAttribute("fill");
    await frame.click();
    await expect(byteranges(page).locator("rect.packet").first()).toHaveAttribute("fill", frameColor!);

    // wheel zoom: the strip axis and the byte-range x axis rescale together; the waterfall does not zoom
    const before = await ticks(strip(page), 1).allTextContents();
    const wfBefore = await waterfall(page).locator("rect.packet").first().getAttribute("width");
    const box = (await strip(page).locator("rect.packet").nth(150).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
    await expect.poll(() => ticks(strip(page), 1).allTextContents()).not.toEqual(before);
    const zoomed = await ticks(strip(page), 1).allTextContents();
    await expect.poll(() => ticks(byteranges(page), 0).allTextContents()).toEqual(zoomed);
    expect(await waterfall(page).locator("rect.packet").first().getAttribute("width")).toBe(wfBefore);
    // after a zoom the byte-range Y axis is an axisLeft (M6) with a sane, auto-fitted domain (M8 FIX)
    const yTicks = (await ticks(byteranges(page), 1).allTextContents()).map((t) => Number(t.replace(/,/g, "")));
    expect(yTicks.length).toBeGreaterThan(1);
    expect(Math.max(...yTicks)).toBeLessThan(1e9);

    // drag pans
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 300, box.y + 10, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => ticks(strip(page), 1).allTextContents()).not.toEqual(zoomed);
    // bars never paint into the left margin (own clip path, M3 FIX)
    const clip = strip(page).locator("clipPath");
    await expect(clip).toHaveCount(1);
    expect(await strip(page).locator("g[clip-path]").getAttribute("clip-path")).toBe(
        `url(#${await clip.getAttribute("id")})`,
    );
    await page.screenshot({ path: testInfo.outputPath("multiplexing-zoomed.png"), fullPage: true });
});

test.describe("retina screen (devicePixelRatio 2), as hosted qvis renders it with d3 v5", () => {
    test.use({ deviceScaleFactor: 2 });

    test("axes keep the 0.5px offset; a trackpad pinch (ctrl+wheel) does not zoom the strip", async ({
        page,
        baseURL,
    }) => {
        await openWithFile(page, baseURL, `${LATEST}/${PAR10_CLIENT}`);
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
        // d3-axis v3 drops the offset when devicePixelRatio > 1 ("M0,6V0H…"); qvis's d3-axis v1 always kept it
        await expect(strip(page).locator(".domain")).toHaveAttribute("d", /^M0\.5,6V0\.5H\d+(\.\d+)?V6$/);
        await expect(byteranges(page).locator(".domain").nth(1)).toHaveAttribute("d", "M6,0.5H0.5V500.5H6");

        const before = await ticks(strip(page), 1).allTextContents();
        const box = (await strip(page).locator("rect.packet").nth(150).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + 10);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -200);
        await page.keyboard.up("Control");
        await page.waitForTimeout(400);
        expect(await ticks(strip(page), 1).allTextContents()).toEqual(before);
        await page.mouse.wheel(0, -200);
        await expect.poll(() => ticks(strip(page), 1).allTextContents()).not.toEqual(before);
    });
});

test("'Load all connections at once' has the Bootstrap 4.3.1 focus look", async ({ page, baseURL }) => {
    await openWithFile(page, baseURL, `${LATEST}/${PAR10_CLIENT}`); // localhost: the button is shown (M26)
    const button = page.getByRole("button", { name: "Load all connections at once" });
    const ring = "rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px";

    // after a mouse click the ring stays while the button has focus (Bootstrap 5: only on :focus-visible)
    await button.click();
    await page.mouse.move(5, 600);
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("box-shadow", ring);
    await expect(button).toHaveCSS("background-color", "rgb(0, 123, 255)");
    await page.mouse.click(5, 600);
    await expect(button).toHaveCSS("box-shadow", "none");

    // keyboard focus: the ring with the normal colours (Bootstrap 5 switches to the hover colours)
    await page.locator("#byteranges-checkbox").focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("box-shadow", ring);
    await expect(button).toHaveCSS("background-color", "rgb(0, 123, 255)");
    await button.hover();
    await expect(button).toHaveCSS("background-color", "rgb(0, 105, 217)");
});

type ChartSections = Record<"waterfall" | "data" | "byterange", string[]>;
interface QvisGolden {
    source: string;
    states: Record<string, Record<keyof ChartSections, string[] | "=initial">>;
    tooltip: { html: string; left: string; topFromStrip: number };
    details: string;
    details0: string;
}

test("1:1 with hosted qvis on its own demo trace: SVG trees, tooltip and details after the same gestures", async ({
    page,
    baseURL,
}) => {
    // Golden recorded from https://qvis.quictools.info on DEMO_10_parallel_streams.qlog at 1600 x 1000 by
    // src/components/multiplexinggraph/__fixtures__/capture-qvis-golden.mjs; the gestures below must stay identical.
    const golden = JSON.parse(readFileSync(path.join(ROOT, QVIS_GOLDEN), "utf8")) as QvisGolden;
    const expected = (state: string): ChartSections => {
        const out = {} as ChartSections;
        for (const kind of ["waterfall", "data", "byterange"] as const) {
            const v = golden.states[state][kind];
            const lines = v === "=initial" ? golden.states.initial[kind] : v;
            // M10 FIX (the only FIX item these gestures exercise): a client trace's request legend says "sent"
            out[kind] = (lines as string[]).map((l) => l.replace('"Request received"', '"Request sent"'));
        }
        return out;
    };
    const actual = async (): Promise<ChartSections> => {
        const out = {} as ChartSections;
        let current: keyof ChartSections = "waterfall";
        for (const line of (await page.evaluate(muxPanelDump)).lines) {
            if (line.startsWith("### ")) out[(current = line.slice(4) as keyof ChartSections)] = [];
            else out[current].push(line);
        }
        return out;
    };

    expect(page.viewportSize()).toEqual({ width: 1600, height: 1000 });
    await openWithFile(page, baseURL, `${LATEST}/${AIOQUIC_DEMO}`);
    const stripSvg = strip(page).locator("svg");

    // 1. initial render
    await expect.poll(actual).toEqual(expected("initial"));

    // 2. hover the 51st frame
    await strip(page).locator("rect.packet").nth(50).hover();
    await expect(tooltip(page)).toHaveCSS("opacity", "0.95");
    expect(await tooltip(page).innerHTML()).toBe(golden.tooltip.html);
    expect(await tooltip(page).evaluate((e) => e.style.left)).toBe(golden.tooltip.left);
    const top = await tooltip(page).evaluate((e) => parseFloat(e.style.top) - window.scrollY);
    expect(top - (await stripSvg.boundingBox())!.y).toBeCloseTo(golden.tooltip.topFromStrip, 1);
    await page.mouse.move(2, 600);

    // 3. click the 4th waterfall bar
    await waterfall(page).locator("rect.packet").nth(3).click();
    const details = page.getByText("Selected stream's details").locator("xpath=..");
    await expect.poll(async () => (await details.innerText()).replace(/\s+/g, " ").trim()).toBe(golden.details);
    await expect.poll(actual).toEqual(expected("wfclick"));

    // 3b. click the stream 0 bar while unzoomed (byte-range Y fit with the M7 off-by-one window)
    await waterfall(page).locator("rect.packet").nth(0).click();
    await expect.poll(async () => (await details.innerText()).replace(/\s+/g, " ").trim()).toBe(golden.details0);
    await expect.poll(actual).toEqual(expected("wfclick0"));

    // 4. click a frame of the strip
    const box = (await stripSvg.boundingBox())!;
    const x = box.x + 20 + 700;
    const y = box.y + 20;
    await page.mouse.click(x, y);
    await expect.poll(actual).toEqual(expected("stripclick"));

    // 5. wheel zoom around that frame
    await page.mouse.move(x, y);
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(100);
    }
    await expect.poll(actual).toEqual(expected("zoom"));

    // 6. drag (pan) 60 px to the right
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(actual).toEqual(expected("pan"));
});

test("checkboxes: byte ranges and waterfall come back after toggling (M4)", async ({ page, baseURL }) => {
    await openWithFile(page, baseURL, `${LATEST}/${PAR10_CLIENT}`);
    await page.locator("label[for=byteranges-checkbox]").click();
    await expect(page.locator("#byteranges-checkbox")).not.toBeChecked();
    await expect(byteranges(page)).toHaveCount(0);
    await page.locator("label[for=byteranges-checkbox]").click();
    await expect(byteranges(page).locator("rect.packet").first()).toHaveAttribute("fill", "#E1DA4C");

    await page.locator("label[for=waterfall-checkbox]").click();
    await expect(waterfall(page)).toHaveCount(0);
    await expect(panels(page).getByText("Waterfall", { exact: true })).toHaveCount(0);
    await page.locator("label[for=waterfall-checkbox]").click();
    await expect(waterfall(page).locator("rect.packet")).toHaveCount(10);

    // the config survives a tab switch (not a reload)
    await page.locator("label[for=byteranges-checkbox]").click();
    await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
    await page.locator("#MainMenu .nav-link", { hasText: "Multiplexing" }).click();
    await expect(page.locator("#byteranges-checkbox")).not.toBeChecked();
    await expect(waterfall(page).locator("rect.packet")).toHaveCount(10);
    await expect(byteranges(page)).toHaveCount(0);
});

test("hand-written latest-draft trace: moved data, priorities, arrival markers", async ({
    page,
    baseURL,
}, testInfo) => {
    await openWithFile(page, baseURL, `${LATEST}/${HANDWRITTEN}`);
    await expect(strip(page).locator("rect.packet")).toHaveCount(15);
    await expect(strip(page).locator("rect.retransmitPacket")).toHaveCount(2);
    await expect(strip(page).locator("rect.reorderPacket")).toHaveCount(1);
    await expect(strip(page).locator("rect.duplicatePacket")).toHaveCount(2);
    await expect(strip(page).locator("rect.futurePacket")).toHaveCount(3);
    await expect(byteranges(page).locator("rect.dataMoved")).toHaveCount(3);
    await expect(waterfall(page).locator("path")).toHaveCount(1); // PRIORITY_UPDATE triangle

    await strip(page).locator("rect.packet").nth(12).hover();
    await expect(tooltip(page)).toHaveText("103ms : stream 0 : packet number undefined[3000, 3499] (size: 500)");
    await strip(page).locator("rect.packet").nth(11).hover();
    await expect(tooltip(page)).toHaveText(
        "102ms : stream 8 : packet number 11[4000, 4999] (size: 1000)Fills gap that was created 1ms ago",
    );

    await waterfall(page).locator("rect.packet").nth(2).click();
    const details = page.getByText("Selected stream's details").locator("xpath=..");
    await expect(details).toContainText(
        "Stream 8 : Requested at 12.25ms. Transmitted from 42.00ms to 104.00ms (62.00ms). 6000 bytes spread over 7 frames (including retransmits).",
    );
    await expect(details).toContainText(
        "HTTP/3 HEADERS seen at 12.00ms. HTTP/3 PRIORITY Update seen at 9.75ms. Priority info (if any): FRAME: u=1, i -> HEADER: u=3",
    );
    await expect(details.locator("span").first()).toHaveCSS("background-color", "rgb(225, 116, 38)");
    await expect(byteranges(page).locator("rect.dataMoved")).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath("multiplexing-handwritten.png"), fullPage: true });
});

test("multi-trace mode (?multimultiplexing=true): one panel per trace, sorted by file name", async ({
    page,
}, testInfo) => {
    await upload(page, [PAR10_SERVER, PAR10_CLIENT, HANDWRITTEN]);
    await page.evaluate(() => history.replaceState(null, "", "/?multimultiplexing=true" + location.hash));
    await page.locator("#MainMenu .nav-link", { hasText: "Multiplexing" }).click();
    await expect(panels(page)).toHaveCount(1);

    const button = page.getByRole("button", { name: "Load all connections at once" });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(panels(page)).toHaveCount(3);
    const titles = await panels(page).locator("h4").allTextContents();
    expect(titles.map((t) => t.split(" : ")[0])).toEqual([HANDWRITTEN, PAR10_CLIENT, PAR10_SERVER]);
    await expect(page.locator("#waterfall-checkbox")).toBeChecked();
    await expect(page.locator("#byteranges-checkbox")).not.toBeChecked();
    await expect(waterfall(page).locator("svg")).toHaveCount(3);
    await expect(byteranges(page)).toHaveCount(0);
    await expect(panels(page).nth(2).locator("[id^=multiplexing-waterfall-] text").first()).toHaveText(
        "Request received",
    );
    await expect(tooltip(page)).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("multiplexing-multi.png"), fullPage: true });

    // byte ranges on: every panel draws them (M4 FIX)
    await page.locator("label[for=byteranges-checkbox]").click();
    await expect(byteranges(page).locator("svg")).toHaveCount(3);

    // picking a trace returns to single mode
    const select = page.locator(".mux-configurator select");
    const options = await select.locator("option").allTextContents();
    await select.selectOption({ index: options.findIndex((o) => o.includes("server trace")) });
    await expect(panels(page)).toHaveCount(1);
    await expect(panels(page).locator("h4")).toContainText(PAR10_SERVER);
});

test("non-conforming quic-go output: DM3 and an empty panel", async ({ page, baseURL }) => {
    test.skip(!NONCONFORMING, "no non-conforming fixture available");
    const url = new URL("/" + NONCONFORMING!, baseURL).href;
    await page.goto(`/#/multiplexing?file=${encodeURIComponent(url)}`);
    await expect(page.locator(".vue-notification", { hasText: "Unsupported qlog event names in" })).toBeVisible();
    await expect(strip(page).locator("svg")).toHaveCount(1);
    await expect(strip(page).locator("rect.packet")).toHaveCount(0);
    await expect(ticks(strip(page), 1)).toHaveText(["1"]);
    await expect(waterfall(page).locator("svg")).toHaveAttribute("height", "150");
    await expect(waterfall(page).locator("text")).toHaveText(WATERFALL_EMPTY);
    await expect(byteranges(page).locator("*")).toHaveCount(0);
});
