// Sequence diagram (#/sequence) end-to-end checks on real generated latest-draft traces (tests/fixtures/latest/
// sequence-*: quic-go with a simulated ~18 ms one-way delay; the "lossy" pair also drops packets).
// parity/sequence-diagram.md §8.6: pair file (SQ1), single trace (mirror), lossy trace, forceFull, focus parameters,
// the event modal and its deep link, virtualization while scrolling, configurator interactions. Every test fails on a
// console error or an uncaught exception.

import { test as base, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = "/tests/fixtures/latest/";
const BOTH = "sequence-newcid-both.qlog";
const SERVER_ONLY = "sequence-newcid-server.sqlog";
const LOSSY_CLIENT = path.join(ROOT, "tests/fixtures/latest/sequence-lossy-client.sqlog");
const LOSSY_SERVER = path.join(ROOT, "tests/fixtures/latest/sequence-lossy-server.sqlog");
// real pre-final quic-go output (transport:* / recovery:* names): parity addendum S2 reference input
const NONCONFORMING = "/tests/fixtures/nonconforming/h3-1x1M-noloss-client.sqlog";

const INTRO = "Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram";

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

const svg = (page: Page) => page.locator("#sequence-diagram-svg");
const selectors = (page: Page) => page.locator(".sequence-diagram-configurator select");
const configInputs = (page: Page) => page.locator(".sequence-diagram-configurator input");
const timelines = (page: Page) => page.locator("#sequence-diagram-svg > rect");
const rangeGroups = (page: Page) => page.locator("#sequence-diagram-svg > g");

function fileUrl(baseURL: string | undefined, name: string): string {
    return new URL(FIXTURES + name, baseURL).href;
}

async function openSequence(page: Page, baseURL: string | undefined, name: string, extra = ""): Promise<void> {
    await page.goto("about:blank"); // a hash-only change would not reload the app
    await page.goto(`/#/sequence?file=${encodeURIComponent(fileUrl(baseURL, name))}${extra}`);
    await expect(page.getByText(INTRO, { exact: true })).toBeVisible();
    await expect(timelines(page)).toHaveCount(2);
}

/** Toasts sit bottom-center over the page and swallow clicks: click them away. */
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
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

/** y (SVG px) of the square of (trace, event), from its rect (12 x 12, centered). */
async function eventY(page: Page, trace: number, event: number): Promise<number> {
    const y = await svg(page).locator(`rect[data-trace="${trace}"][data-event="${event}"]`).getAttribute("y");
    return Number(y) + 6;
}

/**
 * Scroll position a deep link lands on right after a URL load (parity addendum S8): qvis scrolled to y - 50 while
 * its "Loading files..." alert (50 px + 16 px margin) was still shown right above the diagram; when the alert went,
 * Chrome's scroll anchoring moved the view up by 66 px, but only when the viewport top was below the alert.
 */
async function deepLinkScrollY(page: Page, y: number): Promise<number> {
    const boxTop = await page.evaluate(
        () => document.getElementById("sequence-diagram")!.getBoundingClientRect().top + window.scrollY,
    );
    const target = y - 50;
    return target >= boxTop + 50 ? Math.max(0, target - 66) : target;
}

async function selectByLabel(page: Page, index: number, pattern: RegExp): Promise<void> {
    const value = await selectors(page)
        .nth(index)
        .evaluate((s, src) => {
            const re = new RegExp(src);
            return [...(s as HTMLSelectElement).options].find((o) => re.test(o.text))?.value;
        }, pattern.source);
    expect(value, "option matching " + pattern).toBeTruthy();
    await selectors(page).nth(index).selectOption(value!);
}

test.describe("sequence diagram", () => {
    test("opens a client + server file as the pair with an automatic latency offset (SQ1)", async ({
        page,
        baseURL,
    }, testInfo) => {
        await openSequence(page, baseURL, BOTH);
        const url = fileUrl(baseURL, BOTH);

        // configurator: two selectors (client left, server right), latency offset on the right one only
        await expect(selectors(page)).toHaveCount(2);
        await expect(selectors(page).nth(0).locator("option:checked")).toContainText(": client :");
        await expect(selectors(page).nth(1).locator("option:checked")).toContainText(": server :");
        await expect(page.getByText("Latency offset :", { exact: true })).toHaveCount(1);
        await expect(configInputs(page)).toHaveCount(2);
        const offset = parseFloat(await configInputs(page).first().inputValue());
        expect(offset).toBeCloseTo(14.0419, 3);
        await expect(configInputs(page).last()).toHaveValue("1");
        await expect(page.getByRole("button", { name: "Add trace" })).toHaveClass(/btn-secondary/);

        // headers: a link to the file (text URLshort), then the vantage point
        const links = svg(page).locator(":scope > a");
        await expect(links).toHaveCount(2);
        await expect(links.first()).toHaveAttribute("href", url);
        await expect(links.first()).toHaveAttribute("target", "_blank");
        const headerTexts = await svg(page).locator(":scope > text").allTextContents();
        expect(headerTexts.slice(0, 2)).toEqual(["client", "server"]);

        // geometry: 2 bands, timelines at the band centers, squares, timestamps, arrows in both directions
        const width = Number(await svg(page).getAttribute("width"));
        await expect(timelines(page).first()).toHaveAttribute("x", "" + (width / 4 - 1));
        await expect(svg(page).locator("rect[data-event]").first()).toHaveAttribute("fill", "green");
        await expect(svg(page).locator("g text.timestamp").first()).toHaveText("0.00");
        await expect(svg(page).locator("g text.timestamp").first()).toHaveCSS("font-size", "11px");
        expect(await svg(page).locator('line[stroke="#0468cc"]').count()).toBeGreaterThan(0);
        await page.evaluate(() => window.scrollTo(0, 1200));
        await expect.poll(() => svg(page).locator('line[stroke="#a80f3a"]').count()).toBeGreaterThan(0);
        await expect(
            svg(page)
                .locator(".timestamp", { hasText: /ms of inactivity$/ })
                .first(),
        ).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath("pair.png") });
    });

    test("mirrors a single trace (GENERATED client on the left, no latency offset)", async ({ page, baseURL }) => {
        await openSequence(page, baseURL, SERVER_ONLY);
        await expect(selectors(page)).toHaveCount(2);
        await expect(selectors(page).nth(0).locator("option:checked")).toHaveText(
            /^↳ GENERATED : client \(flow = unknown\) : Simulated, autogenerated trace : quic-go server trace/,
        );
        await expect(selectors(page).nth(1).locator("option:checked")).toContainText(": server :");
        await expect(configInputs(page)).toHaveCount(1); // only the time multiplier
        const headerTexts = await svg(page).locator(":scope > text").allTextContents();
        expect(headerTexts[0]).toMatch(/^GENERATED: /);
        expect(headerTexts.slice(1, 3)).toEqual(["client", "server"]);
        // every arrow is horizontal and nothing is lost
        const lines = await svg(page)
            .locator("g line")
            .evaluateAll((ls) => ls.map((l) => [l.getAttribute("y1"), l.getAttribute("y2")]));
        expect(lines.length).toBeGreaterThan(0);
        for (const [y1, y2] of lines) expect(y1).toBe(y2);
        await expect(svg(page).locator('path[stroke="red"]')).toHaveCount(0);
        // the generated trace is now part of the file in every selector
        await expect(selectors(page).nth(1).locator("option")).toHaveCount(3);
        await expect(page.locator(".alert-danger")).toHaveCount(0);
    });

    test("two uploaded files: pick the pair, lost packets get a half arrow and an X, virtualized scrolling", async ({
        page,
    }, testInfo) => {
        await page.goto("/#/files");
        await page.locator("#fileUpload").setInputFiles([LOSSY_CLIENT, LOSSY_SERVER]);
        await page.getByRole("button", { name: "Import" }).click();
        await expect(page.locator("#loadedGroupsContainer > .row")).toHaveCount(2);
        await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
        await expect(timelines(page)).toHaveCount(2);
        await dismissToasts(page);

        await selectByLabel(page, 0, /^↳ quic-go.*: client :/);
        await expect(selectors(page).nth(1).locator("option:checked")).toContainText("GENERATED : server");
        await selectByLabel(page, 1, /^↳ quic-go.*: server :/);
        await expect(selectors(page).nth(1).locator("option:checked")).toContainText("quic-go server trace");
        await expect(page.getByText("Latency offset :", { exact: true })).toHaveCount(1);
        expect(parseFloat(await configInputs(page).first().inputValue())).not.toBe(0);

        const height = Number(await svg(page).getAttribute("height"));
        const screenHeight = await page.evaluate(() => screen.height);
        expect(height / screenHeight).toBeGreaterThan(20);
        let maxGroups = 0;
        let crossY: number | undefined;
        for (let y = 0; y < height && crossY === undefined; y += 700) {
            await page.evaluate((yy) => window.scrollTo(0, yy), y);
            await page.waitForTimeout(300);
            maxGroups = Math.max(maxGroups, await rangeGroups(page).count());
            const crosses = svg(page).locator('path[stroke="red"]');
            if ((await crosses.count()) > 0) {
                crossY = await crosses.first().evaluate((p) => p.getBoundingClientRect().top + window.scrollY);
            }
        }
        expect(crossY, "a lost packet").toBeDefined();
        expect(maxGroups).toBeLessThanOrEqual(5);
        await page.evaluate((yy) => window.scrollTo(0, yy), crossY! - 400);
        await page.waitForTimeout(400);
        await page.screenshot({ path: testInfo.outputPath("lossy.png") });
    });

    test("?forceFull renders every range at once", async ({ page, baseURL }) => {
        await openSequence(page, baseURL, BOTH, "&forceFull");
        const height = Number(await svg(page).getAttribute("height"));
        const screenHeight = await page.evaluate(() => screen.height);
        await expect(rangeGroups(page)).toHaveCount(Math.ceil(height / screenHeight));
        await page.evaluate(() => window.scrollTo(0, 3000));
        await page.waitForTimeout(400);
        await expect(rangeGroups(page)).toHaveCount(Math.ceil(height / screenHeight));
    });

    test("focusOnConnection + focusOnEvent and focusOnPN scroll to the event (SQ10, SQ11)", async ({
        page,
        baseURL,
    }) => {
        await openSequence(page, baseURL, BOTH, "&focusOnConnection=1&focusOnEvent=60");
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        const y = await eventY(page, 1, 60);
        expect(y - 50 - 66).toBeGreaterThan(400); // well below the alert: qvis landed 66 px higher than y - 50
        expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(await deepLinkScrollY(page, y), 0);

        // PN 0 works (qvis ignored it): the server's first sent packet numbered 0
        await openSequence(page, baseURL, BOTH, "&focusOnConnection=1&focusOnPN=0");
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        const sentIndex = await page.evaluate(() => {
            const chips = [...document.querySelectorAll('#sequence-diagram-svg span[data-trace="1"]')];
            const chip = chips.find((c) => c.textContent === "initial : 0"); // the server's first sent packet
            return chip ? Number(chip.getAttribute("data-event")) : -1;
        });
        expect(sentIndex).toBeGreaterThanOrEqual(0);
        expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(
            await deepLinkScrollY(page, await eventY(page, 1, sentIndex)),
            0,
        );
    });

    test("event modal: raw JSON, deep link, recovery metrics fold, close", async ({ page, baseURL }, testInfo) => {
        await openSequence(page, baseURL, BOTH);
        await dismissToasts(page);
        const modal = page.locator("#event-modal");

        const chip = svg(page)
            .locator("foreignObject span", { hasText: /^initial : 0$/ })
            .first();
        const eventIndex = await chip.getAttribute("data-event");
        await chip.click();
        await expect(modal).toBeVisible();
        await expect(modal.locator(".modal-title")).toHaveText("Event detail");
        await expect(modal.locator("pre").first()).toContainText(`Event nr: ${eventIndex}\n{\n  "time": `);
        await expect(modal.locator("pre").first()).toContainText('"name": "quic:packet_sent"');
        await expect(modal.locator("pre").first()).not.toContainText("timeText");
        const link = modal.getByRole("link", { name: "Direct link to this event" });
        const href = await link.getAttribute("href");
        expect(href).toBe(
            `${baseURL}/#/sequence?file=${encodeURIComponent(fileUrl(baseURL, BOTH))}&focusOnConnection=0&focusOnEvent=${eventIndex}`,
        );
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(modal.getByText("Value of all recovery metrics at this point:")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("modal.png") });
        await modal.locator(".btn", { hasText: "Close" }).click();
        await expect(modal).toBeHidden();

        // a recovery metrics side label: the folded values of every metric so far
        await svg(page)
            .locator("foreignObject span", { hasText: /^srtt: / })
            .first()
            .click();
        await expect(modal.getByText("Value of all recovery metrics at this point:", { exact: true })).toBeVisible();
        await expect(modal.locator("pre").nth(1)).toContainText('"congestion_window": ');
        await page.keyboard.press("Escape");
        await expect(modal).toBeHidden();

        // the deep link opens the same file focused on that event (a fresh page load)
        await page.goto("about:blank");
        await page.goto(href!);
        await expect(timelines(page)).toHaveCount(2);
        await expect(svg(page).locator(`rect[data-trace="0"][data-event="${eventIndex}"]`)).toHaveCount(1);
        const y = await eventY(page, 0, Number(eventIndex));
        const landing = await deepLinkScrollY(page, y);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(landing, 0);
    });

    test("configurator: time multiplier, latency offset, add and remove traces, tooltips", async ({
        page,
        baseURL,
    }) => {
        await openSequence(page, baseURL, BOTH);
        await dismissToasts(page);
        const firstServerTime = async () =>
            Number(await svg(page).locator('g text.timestamp[text-anchor="start"]').first().textContent());
        const before = await firstServerTime();

        // time multiplier: x10 multiplies the timestamps; invalid input keeps the last valid value (SQ25)
        const multiplier = configInputs(page).last();
        await multiplier.fill("10");
        await expect.poll(firstServerTime).toBeCloseTo(before * 10, 1);
        await multiplier.fill("");
        await expect(multiplier).toHaveValue("");
        await page.waitForTimeout(300);
        expect(await firstServerTime()).toBeCloseTo(before * 10, 1);
        await multiplier.fill("1");
        await expect.poll(firstServerTime).toBeCloseTo(before, 1);

        // latency offset: a manual 0 sticks (SQ5), also after switching tabs
        const latency = configInputs(page).first();
        const auto = parseFloat(await latency.inputValue());
        await latency.fill("0");
        await latency.press("Enter");
        await expect.poll(firstServerTime).toBeCloseTo(before - auto, 1);
        await page.locator("#MainMenu .nav-link", { hasText: "Congestion" }).click();
        await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
        await expect(configInputs(page).first()).toHaveValue("0");
        await expect.poll(firstServerTime).toBeCloseTo(before - auto, 1);

        // Add trace appends a selector (drawn once while it duplicates a shown trace); "−" removes it
        await page.getByRole("button", { name: "Add trace" }).click();
        await expect(selectors(page)).toHaveCount(3);
        await expect(page.getByRole("button", { name: "−" })).toHaveCount(2);
        await expect(timelines(page)).toHaveCount(2);
        await page.getByRole("button", { name: "−" }).last().click();
        await expect(selectors(page)).toHaveCount(2);
        await expect(page.getByRole("button", { name: "−" })).toHaveCount(0);

        // tooltips
        await page.getByText("Time multiplier:", { exact: true }).hover();
        await expect(
            page.getByRole("tooltip", {
                name: "Increase if you have sub-millisecond latencies or want more space between events. 1 = ms level, 1000 = us level. Typically 10 or 100 is enough.",
                exact: true,
            }),
        ).toBeVisible();
        await page.mouse.move(0, 0);
        await page.getByText("Latency offset :", { exact: true }).hover();
        await expect(
            page.getByRole("tooltip", {
                name: "This value is automatically calculated, but can be manually adjusted.",
                exact: true,
            }),
        ).toBeVisible();
    });

    test("non-conforming (pre-final) events are drawn as generic chips without arrows (addendum S2)", async ({
        page,
        baseURL,
    }) => {
        test.skip(!existsSync(path.join(ROOT, NONCONFORMING)), "non-conforming fixture not available");
        await page.goto("about:blank");
        await page.goto(`/#/sequence?file=${encodeURIComponent(new URL(NONCONFORMING, baseURL).href)}`);
        await expect(timelines(page)).toHaveCount(2);
        await dismissToasts(page);
        const chips = svg(page).locator("foreignObject span");
        await expect(chips.filter({ hasText: /^packet_sent$/ }).first()).toBeVisible();
        await expect(chips.filter({ hasText: /^metrics_updated$/ }).first()).toBeVisible();
        await expect(chips.filter({ hasText: /^packet_sent$/ }).first()).toHaveCSS(
            "background-color",
            "rgb(255, 0, 0)",
        );
        // every event of the original trace has a square; the generated mirror only has ignored events
        expect(await svg(page).locator('rect[data-trace="0"]').count()).toBeGreaterThan(20);
        await expect(svg(page).locator('rect[data-trace="1"]')).toHaveCount(0);
        await expect(svg(page).locator("g line")).toHaveCount(0);
        await expect(svg(page).locator('path[stroke="red"]')).toHaveCount(0);
        await expect(page.locator(".vue-notification-group .vue-notification.error")).toHaveCount(0);

        // the popup shows the raw event as logged
        await chips
            .filter({ hasText: /^packet_sent$/ })
            .first()
            .click();
        await expect(page.locator("#event-modal pre").first()).toContainText('"name": "transport:packet_sent"');
    });

    test("a trace without vantage point: guessed perspective, mirror and the alert", async ({ page }) => {
        // the server trace of new_cid without its vantage_point (the client sends the first Initial, so: server)
        const text = readFileSync(path.join(ROOT, "tests/fixtures/latest/sequence-newcid-server.sqlog"), "utf8");
        const stripped = text.replace(/,"vantage_point":\{[^}]*\}/, "");
        expect(stripped).not.toBe(text);
        await page.goto("/#/files");
        await page
            .locator("#fileUpload")
            .setInputFiles({ name: "novp.sqlog", mimeType: "application/octet-stream", buffer: Buffer.from(stripped) });
        await page.getByRole("button", { name: "Import" }).click();
        await expect(page.locator("#loadedGroupsContainer > .row")).toHaveCount(1);
        await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
        await expect(timelines(page)).toHaveCount(2);
        await expect(
            page.getByText(
                "The selected trace has an unknown vantage point. We guessed it based on heuristics, but this could be wrong!",
                { exact: true },
            ),
        ).toBeVisible();
        await expect(selectors(page).nth(0).locator("option:checked")).toContainText(
            "vantage point type was unknown, pretending it's client : client (flow = unknown) : Simulated, autogenerated trace : ",
        );
        await expect(selectors(page).nth(1).locator("option:checked")).toContainText(
            "vantage point type was unknown, pretending it's server : unknown",
        );
        const headerTexts = await svg(page).locator(":scope > text").allTextContents();
        expect(headerTexts.slice(0, 4)).toEqual(["GENERATED: novp.sqlog", "client", "novp.sqlog", "unknown"]);
    });

    test("without files: the empty bordered box and the alert", async ({ page }) => {
        await page.goto("/#/sequence");
        await expect(page.getByText("Please load a trace file to visualize it")).toBeVisible();
        const box = page.locator("#sequence-diagram");
        await expect(box).toHaveCSS("border-top-width", "5px");
        await expect(box).toHaveCSS("border-top-color", "rgb(204, 229, 255)");
        await expect(box).toHaveCSS("min-height", "200px");
        await expect(svg(page).locator("*")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Add trace" })).toBeVisible();
    });
});
