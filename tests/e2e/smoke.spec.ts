// End-to-end smoke checks for the integrated app (ARCHITECTURE §5): file manager layout, upload of conforming and
// non-conforming qlog files, startup loading from ?file=, sticky query parameters, every route (+ #/debug), and no
// console errors anywhere. Assertions use verbatim parity strings (parity/app-shell.md, parity/file-loading.md), so
// they keep holding once the visualization packages replace the placeholder containers.

import { test as base, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAMPLE_VALID = path.join(ROOT, "scripts/cddl/sample-valid.sqlog");
const SAMPLE_VALID_URL_PATH = "/scripts/cddl/sample-valid.sqlog";

const NO_FILE_ALERT = "Please load a trace file to visualize it";
const DM3_TITLE = "Unsupported qlog event names in ";

interface ToolRoute {
    path: string;
    tab: string;
    color: string; // active tab background == configurator panel background (app-shell §2.2)
    intro: string;
}

const TOOL_ROUTES: ToolRoute[] = [
    {
        path: "/sequence",
        tab: "Sequence",
        color: "rgb(204, 229, 255)",
        intro: "Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram",
    },
    {
        path: "/congestion",
        tab: "Congestion",
        color: "rgb(212, 237, 218)",
        intro: "Select a trace via the dropdown(s) below to visualize it in the congestion graph",
    },
    {
        path: "/multiplexing",
        tab: "Multiplexing",
        color: "rgb(209, 236, 241)",
        intro: "Select a trace via the dropdown(s) below to visualize it in the stream graph",
    },
    {
        path: "/packetization",
        tab: "Packetization",
        color: "rgb(248, 215, 218)",
        intro: "Select a trace via the dropdown(s) below to visualize it in the packetization diagram",
    },
    {
        path: "/stats",
        tab: "qlog stats",
        color: "rgb(255, 243, 205)",
        intro: "Select a file via the dropdown(s) below to view its statistics",
    },
];

/** Smallest .qlog/.sqlog file directly inside the first existing directory, or undefined. */
function smallestQlogIn(...dirs: string[]): string | undefined {
    for (const dir of dirs) {
        const abs = path.join(ROOT, dir);
        if (!existsSync(abs)) continue;
        const files = readdirSync(abs)
            .filter((f) => /\.s?qlog$/i.test(f))
            .map((f) => path.join(abs, f))
            .filter((f) => statSync(f).isFile())
            .sort((a, b) => statSync(a).size - statSync(b).size);
        if (files.length > 0) return files[0];
    }
    return undefined;
}

// Strictly conforming generated files (another workflow fills these directories) and the real-but-pre-final quic-go
// output (may move to tests/fixtures/nonconforming/).
const LATEST_FIXTURE = smallestQlogIn("tests/fixtures/latest", "public/examples");
const NONCONFORMING_FIXTURE = smallestQlogIn("tests/fixtures/nonconforming", "tests/fixtures/quic-go");
const HAS_DEMO_MANIFEST = existsSync(path.join(ROOT, "public/examples/index.json"));

// Every test fails if the page logs a console error or throws.
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

const loadedFiles = (page: Page) => page.locator("#loadedGroupsContainer > .row");
/** Toast whose title starts with `title` (case-sensitive; a plain hasText string would be a substring match). */
const toast = (page: Page, title: string) =>
    page.locator(".vue-notification", {
        has: page.locator(".notification-title", {
            hasText: new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        }),
    });

/**
 * Toasts sit bottom-center over the page (position: fixed, 50% wide, like qvis) and swallow clicks on whatever is
 * underneath; click them away (vue-notification closes on click) before clicking page content they may cover.
 */
async function dismissToasts(page: Page): Promise<void> {
    const items = page.locator(".vue-notification-group .vue-notification");
    for (let n = await items.count(); n > 0; n = await items.count()) {
        // the toast can expire on its own between count() and click(): never wait for one that is gone
        await items
            .first()
            .click({ force: true, timeout: 2000 })
            .catch(() => {});
        // toasts that expire on their own meanwhile can make the count drop by more than one
        await expect.poll(() => items.count()).toBeLessThan(n);
    }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, "page must not scroll horizontally").toBeLessThanOrEqual(clientWidth);
}

async function upload(page: Page, file: string): Promise<void> {
    await page.locator("#fileUpload").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();
    await expect(toast(page, "Uploaded file").filter({ hasText: path.basename(file) })).toBeVisible();
}

async function expectToolRoute(page: Page, route: ToolRoute): Promise<void> {
    const active = page.locator("#MainMenu .nav-link.active");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(route.tab);
    await expect(active).toHaveCSS("background-color", route.color);
    await expect(page.getByText(route.intro, { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
}

test.describe("file manager", () => {
    test("renders the qvis landing page", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await expect(page.locator("h1")).toHaveText(
            "Welcome to qvis v0.1, the QUIC and HTTP/3 visualization toolsuite!",
        );
        await expect(page.locator("#MainMenu .nav-link.active")).toHaveText("Manage files");
        await expect(page.locator("#MainMenu .nav-link.active")).toHaveCSS("background-color", "rgb(255, 255, 255)");
        // bootstrap-vue renders <b-button href> as <a role="button" target="_blank">
        await expect(page.getByRole("button", { name: "Request feature" })).toHaveAttribute("href", /\/issues\/new\?/);
        await expect(page.getByRole("button", { name: "Report issue" })).toHaveAttribute("href", /\/issues\/new\?/);

        const options = page.locator("#FileManagerContainer > .fileOptionContainer");
        await expect(options).toHaveCount(5);
        for (let i = 0; i < 5; ++i) {
            await expect(options.nth(i).locator("h3").first()).toHaveText(`Option ${i + 1}`);
        }
        await expect(page.getByRole("button", { name: "Load example .qlog files" })).toBeVisible();
        // Option 4: button label and download size come from public/examples/massive/index.json (D13)
        await expect(page.getByRole("button", { name: /^Load \d+MB \.sqlog file$/ })).toBeVisible();
        await expect(options.nth(3).locator("p")).toHaveText(
            "This will load a single qlog file representing a 50MB download. Use this to see how well qvis visualizations perform on larger traces.",
        );
        // no file chosen yet: BootstrapVue's red "invalid" state (Q9 preserved) and a disabled Import button
        await expect(page.locator("label.custom-file-label")).toHaveText("Choose files or drop them here...");
        await expect(page.getByRole("button", { name: "Import" })).toBeDisabled();
        await expect(page.locator("#loadedGroupsContainer")).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        await page.screenshot({ path: testInfo.outputPath("files.png"), fullPage: true });
    });

    test("uploads a conforming qlog file", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await upload(page, SAMPLE_VALID);
        await expect(loadedFiles(page)).toHaveCount(1);
        await expect(loadedFiles(page).first()).toContainText("sample-valid.sqlog");
        await expect(loadedFiles(page).first()).toContainText("(1 connection)");
        await expect(loadedFiles(page).first().getByRole("button", { name: "Remove" })).toBeVisible();
        await expect(loadedFiles(page).first().getByRole("button", { name: "Download" })).toBeVisible();

        if (LATEST_FIXTURE) {
            await upload(page, LATEST_FIXTURE);
            await expect(loadedFiles(page)).toHaveCount(2);
            await expect(loadedFiles(page).nth(1)).toContainText(path.basename(LATEST_FIXTURE));
        }
        await expect(toast(page, DM3_TITLE)).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("files-loaded.png"), fullPage: true });

        // every tool route must cope with a loaded, strictly conforming file
        for (const route of TOOL_ROUTES) {
            await page.locator("#MainMenu .nav-link", { hasText: route.tab }).click();
            await expect(page).toHaveURL(new RegExp(`#${route.path}$`));
            await expectToolRoute(page, route);
            await expect(page.getByText(NO_FILE_ALERT)).toHaveCount(0);
        }

        await page.locator("#MainMenu .nav-link", { hasText: "Manage files" }).click();
        await dismissToasts(page);
        await loadedFiles(page).first().getByRole("button", { name: "Remove" }).click();
        await expect(loadedFiles(page)).toHaveCount(LATEST_FIXTURE ? 1 : 0);
    });

    test("warns about non-conforming (pre-final) event names with toast DM3", async ({ page }) => {
        test.skip(!NONCONFORMING_FIXTURE, "no non-conforming fixture available");
        const file = NONCONFORMING_FIXTURE!;
        const name = path.basename(file);
        await page.goto("/#/files");
        await upload(page, file);
        await expect(loadedFiles(page)).toHaveCount(1);
        await expect(loadedFiles(page).first()).toContainText(name);

        const dm3 = toast(page, DM3_TITLE + name);
        await expect(dm3).toBeVisible();
        await expect(dm3).toHaveClass(/\bwarn\b/);
        await expect(dm3.locator(".notification-content")).toContainText(
            /^This file contains \d+ events whose names are not defined by the latest qlog drafts \(e\.g\. [^)]+\)\. qvis only supports draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13 event names; the visualizations do not interpret these events\.$/,
        );
    });

    test("loads the premade demo files (Option 3)", async ({ page }) => {
        if (!HAS_DEMO_MANIFEST) {
            // public/examples/ is generated by another workflow; until it exists, serve a one-file stand-in manifest
            const sample = readFileSync(SAMPLE_VALID);
            await page.route("**/examples/index.json", (r) =>
                r.fulfill({ json: [{ file: "sample-valid.sqlog", size: sample.length }] }),
            );
            await page.route("**/examples/sample-valid.sqlog", (r) => r.fulfill({ body: sample }));
        }
        const expected = HAS_DEMO_MANIFEST
            ? (JSON.parse(readFileSync(path.join(ROOT, "public/examples/index.json"), "utf8")) as unknown[]).length
            : 1;
        await page.goto("/#/files");
        const button = page.getByRole("button", { name: "Load example .qlog files" });
        await button.click();
        await expect(loadedFiles(page).first()).toContainText("DEMO_");
        await expect(loadedFiles(page)).toHaveCount(expected, { timeout: 30_000 });
        await expect(toast(page, DM3_TITLE)).toHaveCount(0);

        // N7: a second click does not load the examples twice. The "Loaded ..." toasts stack bottom-center over the
        // Option 3 button and swallow clicks (qvis parity), so click them away first.
        await dismissToasts(page);
        await button.click();
        await expect(toast(page, "Example files already loaded")).toBeVisible();
        await expect(loadedFiles(page)).toHaveCount(expected);
    });
});

test.describe("URL loading and routing", () => {
    test("loads ?file= at startup and keeps the query sticky across tabs", async ({ page, baseURL }) => {
        const fileURL = new URL(SAMPLE_VALID_URL_PATH, baseURL).href;
        const encoded = encodeURIComponent(fileURL);
        let fetches = 0;
        page.on("request", (r) => {
            if (r.url() === fileURL) fetches++;
        });

        // query before the hash (rule 1): copied into the hash route, location.search is kept (app-shell §3.1)
        await page.goto(`/?file=${encoded}#/files`);
        await expect(page).toHaveURL(`${baseURL}/?file=${encoded}#/files?file=${encoded}`);
        await expect(toast(page, "Loaded files via URL")).toBeVisible();
        await expect(loadedFiles(page)).toHaveCount(1);
        await expect(loadedFiles(page).first()).toContainText("sample-valid.sqlog");
        await expect(loadedFiles(page).first().locator("a")).toHaveAttribute("href", fileURL);

        for (const route of TOOL_ROUTES) {
            await page.locator("#MainMenu .nav-link", { hasText: route.tab }).click();
            await expect(page).toHaveURL(new RegExp(`#${route.path}\\?file=${encoded.replace(/[.%]/g, "\\$&")}$`));
            await expectToolRoute(page, route);
        }
        await page.locator("#MainMenu .nav-link", { hasText: "Manage files" }).click();
        await expect(page).toHaveURL(new RegExp(`#/files\\?file=`));
        // the startup load runs exactly once (also under React StrictMode), navigation does not re-fetch
        await expect(loadedFiles(page)).toHaveCount(1);
        expect(fetches).toBe(1);
    });

    test("loads ?file= from the hash query on a tool route", async ({ page, baseURL }) => {
        const fileURL = new URL(SAMPLE_VALID_URL_PATH, baseURL).href;
        await page.goto(`/#/congestion?file=${encodeURIComponent(fileURL)}`);
        await expectToolRoute(page, TOOL_ROUTES[1]);
        await expect(toast(page, "Loaded files via URL")).toBeVisible();
        await expect(page.getByText(NO_FILE_ALERT)).toHaveCount(0);
    });

    test("an unencoded ?file= in the hash loads and the address bar shows it encoded (vue-router ensureURL)", async ({
        page,
        baseURL,
    }) => {
        const fileURL = new URL(SAMPLE_VALID_URL_PATH, baseURL).href;
        await page.goto(`/#/stats?file=${fileURL}`);
        await expect(page).toHaveURL(`${baseURL}/#/stats?file=${encodeURIComponent(fileURL)}`);
        await expect(toast(page, "Loaded files via URL")).toBeVisible();
        await expect(page.getByText(NO_FILE_ALERT)).toHaveCount(0);
    });

    test("every route renders without files loaded", async ({ page }) => {
        for (const route of TOOL_ROUTES) {
            await page.goto(`/#${route.path}`);
            await expectToolRoute(page, route);
            await expect(page.getByText(NO_FILE_ALERT)).toBeVisible();
        }

        await page.goto("/#/debug");
        await expect(page.getByText("This is the VUE debugger to test reactive data coupling")).toBeVisible();
        await expect(page.locator("#MainMenu .nav-link.active")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Add new random ConnectionGroup" })).toBeVisible();
        await expect(page.getByText(/^RandomConnectionGroup \d+$/)).toHaveCount(3);

        // "/" and unknown routes resolve to /files
        await page.goto("/#/does-not-exist");
        await expect(page).toHaveURL(/#\/files$/);
        await expect(page.locator("h1")).toContainText("Welcome to qvis");
        await page.goto("/");
        await expect(page).toHaveURL(/#\/files$/);
    });
});
