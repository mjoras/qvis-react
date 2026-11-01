// Shell details that were measured against hosted qvis (https://qvis.quictools.info) on the same data and fixed in
// the parity pass (parity/app-shell.md and parity/file-loading.md, "Same-data parity pass" addenda): Bootstrap 4.3.1
// focus look, the menu tab box model, the upload label overflow, vue-notification's transitions and DOM, and the
// #/debug event list.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLES = path.join(ROOT, "public/examples");
const NEW_CID = path.join(EXAMPLES, "new_cid.qlog");
const PARALLEL = path.join(EXAMPLES, "10_parallel_streams.qlog");

function css(page: Page, selector: string, props: string[], index = 0): Promise<Record<string, string>> {
    return page
        .locator(selector)
        .nth(index)
        .evaluate((el, names) => {
            const cs = getComputedStyle(el);
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n)]));
        }, props);
}

test("a clicked button keeps the Bootstrap 4.3.1 focus ring (qvis: :focus, not only :focus-visible)", async ({
    page,
}) => {
    await page.goto("/#/files");
    await page.fill("#urlInput", "https://example.invalid/x.pcapng"); // X6 toast, no network
    await page.getByRole("button", { name: "Fetch" }).click();
    await page.mouse.move(5, 990);
    const fetch = page.getByRole("button", { name: "Fetch" });
    await expect(fetch).toBeFocused();
    await expect(fetch).toHaveCSS("box-shadow", "rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px");
    // not hovered: the normal colours (Bootstrap 5 :focus-visible would switch to the hover colours)
    await expect(fetch).toHaveCSS("background-color", "rgb(0, 123, 255)");
});

test("menu tabs: Bootstrap 4.3.1 box model, bottom borders and keyboard focus outline", async ({ page }) => {
    await page.goto("/#/sequence");
    // `.nav-tabs .nav-item { margin-bottom: -1px }` (Bootstrap 5 puts it on the link): items are 41 px high
    expect(await css(page, "#MainMenu .nav-item", ["margin-bottom", "height"])).toEqual({
        "margin-bottom": "-1px",
        height: "41px",
    });
    expect(await css(page, "#MainMenu .nav-link", ["margin-bottom"])).toEqual({ "margin-bottom": "0px" });
    // the active tab's (0px wide) bottom border takes the tab colour, as qvis's id rules win over Bootstrap's
    expect(await css(page, "#MainMenu .nav-link.active", ["border-bottom-color", "border-bottom-width"])).toEqual({
        "border-bottom-color": "rgb(204, 229, 255)",
        "border-bottom-width": "0px",
    });
    // keyboard focus: the browser outline (Bootstrap 4 has no nav-link focus ring), no Bootstrap 5 box-shadow
    await page.locator("#MainMenu .nav-link", { hasText: "Congestion" }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement!);
        return {
            text: (document.activeElement as HTMLElement).innerText,
            outline: cs.outlineStyle,
            shadow: cs.boxShadow,
        };
    });
    expect(focused).toEqual({ text: "Congestion", outline: "auto", shadow: "none" });
});

test("upload label: a long selection runs on under 'Browse' (no ellipsis), BootstrapVue DOM", async ({ page }) => {
    await page.goto("/#/files");
    await page.setInputFiles("#fileUpload", [NEW_CID, PARALLEL, path.join(EXAMPLES, "doublevantage_100ms.qlog")]);
    const label = page.locator("label.custom-file-label");
    await expect(label).toHaveText("new_cid.qlog, 10_parallel_streams.qlog, doublevantage_100ms.qlog");
    expect(await css(page, "label.custom-file-label", ["overflow", "text-overflow", "padding-right"])).toEqual({
        overflow: "visible",
        "text-overflow": "clip",
        "padding-right": "12px",
    });
    await expect(page.locator("#fileUpload__BV_file_outer_")).toHaveClass(
        "custom-file b-form-file text-nowrap text-truncate is-valid",
    );
});

test("toasts: vue-notification DOM, 300 ms fade, moved items lose the inline duration", async ({ page }) => {
    await page.goto("/#/files");
    await page.setInputFiles("#fileUpload", [NEW_CID, PARALLEL]);
    await page.getByRole("button", { name: "Import" }).click();
    const wrappers = page.locator(".notifications > span > .notification-wrapper");
    await expect(wrappers).toHaveCount(4);
    await expect(wrappers.first().locator("> .vue-notification-template.vue-notification")).toHaveCount(1);
    await expect(wrappers.last().locator("> .vue-notification-template.vue-notification.success")).toHaveCount(1);
    const durations = await wrappers.evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transitionDuration));
    expect(durations[0]).toBe(""); // slid up when the next toasts arrived: Vue clears the inline duration
    expect(durations[durations.length - 1]).toBe("300ms"); // the newest never moved
    await expect(wrappers.last()).toHaveCSS("opacity", "1");
});

test("#/debug lists the event type, as qvis's parseEvent(event).name", async ({ page }) => {
    await page.goto("/#/files");
    await page.setInputFiles("#fileUpload", [NEW_CID, PARALLEL]);
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.locator("#loadedGroupsContainer > .row")).toHaveCount(2);
    await page.goto("/#/debug");
    const rows = page.getByText(/^- Event: ROBIN : /);
    await expect(rows.first()).toHaveText(/^- Event: ROBIN : quic-go client trace, ODCID [0-9a-f]+ : [a-z_]+$/);
    expect(await page.getByText(/ : quic:/).count()).toBe(0);
});
