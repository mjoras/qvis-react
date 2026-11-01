// End-to-end checks of the packetization diagram (#/packetization; parity/packetization-diagram.md §8.7): real
// latest-draft quic-go traces loaded via ?file=, hover tooltips, wheel zoom + drag pan, trace switching, the info modal,
// TCP + TLS + HTTP/2 mode (hand-written converter-shaped trace) and pre-final names (empty lanes + D-PZ4 note). Every
// test fails on a console error or uncaught exception (the pre-processor diagnostics are console warnings).

import { test as base, expect, type Page } from "@playwright/test";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tcpH2QlogFile } from "../../src/components/packetizationdiagram/__fixtures__/tcpH2Trace";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT = "/tests/fixtures/latest/packetization-par10-client.sqlog";
const SERVER = "/tests/fixtures/latest/packetization-par10-server.sqlog";
const NONCONFORMING_DIR = ["tests/fixtures/nonconforming", "tests/fixtures/quic-go"].find((d) =>
    existsSync(path.join(ROOT, d)),
);
// the smallest pre-final quic-go file (current quic-go output: transport:packet_* names)
const NONCONFORMING = NONCONFORMING_DIR
    ? readdirSync(path.join(ROOT, NONCONFORMING_DIR))
          .filter((f) => /\.sqlog$/.test(f))
          .sort(
              (a, b) =>
                  statSync(path.join(ROOT, NONCONFORMING_DIR, a)).size -
                  statSync(path.join(ROOT, NONCONFORMING_DIR, b)).size,
          )
          .map((f) => "/" + NONCONFORMING_DIR + "/" + f)[0]
    : undefined;

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

const top = (page: Page) => page.locator("#packetization-diagram-top");
const bottom = (page: Page) => page.locator("#packetization-diagram-bottom");
const tooltip = (page: Page) => page.locator("#packetization-packet-tooltip");
const axisTicks = (page: Page, which: "top" | "bottom") =>
    page.locator(`#packetization-diagram-${which} svg g[transform="translate(0,100)"] .tick text`).allTextContents();

/** Opens #/packetization with the given repo files loaded through ?file= (or ?file1=&file2=). */
async function openWithFiles(page: Page, baseURL: string, ...files: string[]): Promise<void> {
    const query = files
        .map(
            (f, i) =>
                (files.length === 1 ? "file" : "file" + (i + 1)) + "=" + encodeURIComponent(new URL(f, baseURL).href),
        )
        .join("&");
    await page.goto("/?" + query + "#/packetization");
}

/** Toasts sit over the page and swallow hovers/clicks; click them away (they may also expire meanwhile). */
async function dismissToasts(page: Page): Promise<void> {
    const items = page.locator(".vue-notification-group .vue-notification");
    for (let n = await items.count(); n > 0; n = await items.count()) {
        await items
            .first()
            .click({ force: true, timeout: 1000 })
            .catch(() => {});
        await expect.poll(() => items.count()).toBeLessThan(n);
    }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

async function labels(page: Page, which: "top" | "bottom"): Promise<string[]> {
    const texts = await page.locator(`#packetization-diagram-${which} svg > g > g > text`).allTextContents();
    return texts;
}

test.describe("packetization diagram", () => {
    test("renders a real quic-go client trace (both directions)", async ({ page, baseURL }, testInfo) => {
        await openWithFiles(page, baseURL!, CLIENT);
        await expect(page.locator("#MainMenu .nav-link.active")).toHaveText("Packetization");
        await expect(top(page).locator("svg")).toHaveCount(1);
        await expect(bottom(page).locator("svg")).toHaveCount(1);

        // auto-selected first trace in the shared selector
        await expect(page.locator(".packetization-configurator select")).toHaveCount(1);

        await expect(top(page).locator("svg")).toHaveAttribute("height", "170");
        expect(await labels(page, "top")).toEqual([
            "QUIC packets",
            "QUIC frames",
            "HTTP/3",
            "Stream IDs",
            "Bytes received",
            "max receiving size client: 1452",
            "max receiving size server: 1452",
            expect.stringMatching(/^efficiency \d+\.\d\d%$/),
            "Data received by client from server (trace vantagepoint = client)",
        ]);
        expect(await labels(page, "bottom")).toContain("Bytes sent");
        expect(await labels(page, "bottom")).toContain("Data sent from client to server (trace vantagepoint = client)");

        for (const cls of ["quicpacket", "quicframe", "httpframe", "streampacket"]) {
            expect(
                await top(page)
                    .locator("rect." + cls)
                    .count(),
            ).toBeGreaterThan(100);
        }
        expect((await top(page).locator("rect.quicpacket").count()) % 3).toBe(0);
        await expect(top(page).locator("clipPath")).toHaveAttribute("id", "packetization-clip-top");
        await expect(bottom(page).locator("clipPath")).toHaveAttribute("id", "packetization-clip-bottom");
        // 14px Trebuchet MS labels, as hosted qvis renders them
        await expect(top(page).locator("text", { hasText: "QUIC packets" })).toHaveCSS("font-size", "14px");
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("packetization-client.png") });
    });

    test("hover tooltips, wheel zoom and drag pan", async ({ page, baseURL }, testInfo) => {
        await openWithFiles(page, baseURL!, CLIENT);
        await expect(top(page).locator("rect.quicpacket").first()).toBeAttached();
        await dismissToasts(page);

        // hover: tooltip fades in next to the pointer with the lane's text
        const packetRect = bottom(page).locator("rect.quicpacket").nth(1);
        await packetRect.hover({ force: true });
        await expect(tooltip(page)).toHaveCSS("opacity", "0.95");
        await expect(tooltip(page)).toContainText(/^QUIC Payload #0 : size \d+Packet type : initial, Packet nr : 0$/);
        const box = (await packetRect.boundingBox())!;
        const tipBox = (await tooltip(page).boundingBox())!;
        expect(tipBox.x).toBeGreaterThan(box.x);

        const httpRect = top(page).locator("rect.httpframe").nth(1);
        await httpRect.hover({ force: true });
        await expect(tooltip(page)).toContainText(
            /^H3 (Header|Payload) #\d+ \(QUIC frame index: \d+\) : frame size \d+/,
        );

        const streamRect = top(page).locator("rect.streampacket").nth(20);
        await streamRect.hover({ force: true });
        await expect(tooltip(page)).toContainText(/H3 streamID: \d+GET: \/file-\d\.bin\s*total resource size: 50000/);

        // leaving a rect fades the tooltip out
        await page.mouse.move(5, 990);
        await expect(tooltip(page)).toHaveCSS("opacity", "0");

        // wheel over a painted element zooms the x axis (only the hovered diagram)
        const before = await axisTicks(page, "top");
        const bottomBefore = await axisTicks(page, "bottom");
        const target = (await top(page).locator("rect.quicpacket").nth(30).boundingBox())!;
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
        for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -400);
        await expect.poll(() => axisTicks(page, "top")).not.toEqual(before);
        expect(await axisTicks(page, "bottom")).toEqual(bottomBefore);
        await page.screenshot({ path: testInfo.outputPath("packetization-zoomed.png") });

        // drag on a painted element pans (zooming kept the hovered rect under the pointer)
        const zoomed = await axisTicks(page, "top");
        const x = target.x + target.width / 2;
        const y = target.y + target.height / 2;
        expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName, [x, y])).toBe("rect");
        await page.mouse.down();
        await page.mouse.move(x - 300, y, { steps: 5 });
        await page.mouse.up();
        await expect.poll(() => axisTicks(page, "top")).not.toEqual(zoomed);
    });

    test("switching traces re-renders both diagrams", async ({ page, baseURL }) => {
        await openWithFiles(page, baseURL!, CLIENT, SERVER);
        await expect(top(page).locator("text", { hasText: "trace vantagepoint = client" })).toHaveCount(1);
        const select = page.locator(".packetization-configurator select");
        await expect(select.locator("option")).toHaveCount(3); // ?file1=&file2= merge into one file: header + two traces
        const serverOption = await select.locator("option", { hasText: "server trace" }).getAttribute("value");
        await select.selectOption(serverOption!);
        await expect(
            top(page).locator("text", { hasText: "Data received by server from client (trace vantagepoint = server)" }),
        ).toHaveCount(1);
        await expect(
            bottom(page).locator("text", { hasText: "Data sent from server to client (trace vantagepoint = server)" }),
        ).toHaveCount(1);
        await expect(top(page).locator("svg")).toHaveCount(1);
        expect(await labels(page, "top")).toContain("max receiving size server: 1452");

        // the selection survives a route change
        await page.locator("#MainMenu .nav-link", { hasText: "Sequence" }).click();
        await page.locator("#MainMenu .nav-link", { hasText: "Packetization" }).click();
        await expect(top(page).locator("text", { hasText: "trace vantagepoint = server" })).toHaveCount(1);
    });

    test("info modal opens every time and closes with Close, × and ESC", async ({ page }, testInfo) => {
        await page.goto("/#/packetization");
        await expect(page.getByText("Please load a trace file to visualize it")).toBeVisible();
        const open = page.getByRole("button", { name: "More info on this tool" });
        const title = page.locator(".modal-title", { hasText: "PacketizationDiagram info" });

        await open.click();
        await expect(title).toBeVisible();
        await expect(page.locator(".modal-dialog")).toHaveClass(/modal-xl/);
        await expect(page.locator("#info-modal.modal")).toBeVisible(); // qvis b-modal id
        // Bootstrap 4 / browser-default list indent (Bootstrap 5 would give 2rem)
        await expect(page.locator(".modal-body ul").first()).toHaveCSS("padding-left", "40px");
        await expect(page.locator(".modal-body h2")).toHaveText([
            "How to test?",
            "What does it do?",
            "How does it work?",
            "Also usable for TCP + TLS + HTTP/2",
        ]);
        await page.screenshot({ path: testInfo.outputPath("packetization-modal.png") });
        await page.locator(".modal-body").getByRole("button", { name: "Close" }).click();
        await expect(title).toHaveCount(0);

        await open.click();
        await expect(title).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(title).toHaveCount(0);

        await open.click(); // qvis needed two clicks here (Q-M1)
        await expect(title).toBeVisible();
        await page.locator(".modal-header button.close").click();
        await expect(title).toHaveCount(0);
    });

    test("buttons show the Bootstrap 4 focus ring (mouse and keyboard focus)", async ({ page }) => {
        await page.goto("/#/packetization");
        const open = page.getByRole("button", { name: "More info on this tool" });
        const ring = "rgba(130, 138, 145, 0.5) 0px 0px 0px 3.2px";
        const secondary = "rgb(108, 117, 125)";

        // closing the modal hands focus back to the button: hosted qvis (Bootstrap 4 `:focus`) rings it
        await open.click();
        await expect(page.locator(".modal-title")).toBeVisible();
        const close = page.locator(".modal-body").getByRole("button", { name: "Close" });
        await close.focus();
        await expect(close).toHaveCSS("box-shadow", ring);
        await page.locator(".modal-header button.close").click();
        await expect(page.locator(".modal-title")).toHaveCount(0);
        await page.mouse.move(5, 990);
        await expect(open).toBeFocused();
        await expect(open).toHaveCSS("box-shadow", ring);
        await expect(open).toHaveCSS("background-color", secondary);

        // keyboard focus: ring only; Bootstrap 5's :focus-visible would also switch to the hover background
        await page.locator("p", { hasText: "Select a trace via the dropdown" }).click();
        await expect(open).not.toBeFocused();
        await expect(open).toHaveCSS("box-shadow", "none");
        await open.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(open).toBeFocused();
        expect(await open.evaluate((b) => b.matches(":focus-visible"))).toBe(true);
        await expect(open).toHaveCSS("box-shadow", ring);
        await expect(open).toHaveCSS("background-color", secondary);
    });

    test("TCP + TLS + HTTP/2 mode (converter-shaped trace)", async ({ page }, testInfo) => {
        await page.goto("/#/files");
        await page.locator("#fileUpload").setInputFiles({
            name: "packetization-tcp-h2.qlog",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify(tcpH2QlogFile())),
        });
        await page.getByRole("button", { name: "Import" }).click();
        await expect(page.locator("#loadedGroupsContainer > .row")).toHaveCount(1);
        await page.locator("#MainMenu .nav-link", { hasText: "Packetization" }).click();

        expect(await labels(page, "top")).toEqual([
            "TCP",
            "TLS",
            "HTTP/2",
            "Stream IDs",
            "Bytes received",
            "Data received by client from server (trace vantagepoint = client)",
        ]);
        await expect(top(page).locator("rect.tcppacket")).toHaveCount(6);
        await expect(top(page).locator("rect.tlspacket")).toHaveCount(7);
        await expect(top(page).locator("rect.httppacket")).toHaveCount(8);
        await expect(bottom(page).locator("rect.tcppacket")).toHaveCount(4);
        await dismissToasts(page);

        await top(page).locator("rect.httppacket").nth(6).hover({ force: true });
        await expect(tooltip(page)).toHaveText(
            "H2 Payload # (TLS index: 1) : frame size 1000, partial size : 686frame type: data, streamID: 1STREAM END BIT SETGET: /index.htmltotal resource size: 1000",
        );
        await page.screenshot({ path: testInfo.outputPath("packetization-tcp.png") });
    });

    test("pre-final quic-go names: empty diagrams with an explanation", async ({ page, baseURL }) => {
        test.skip(!NONCONFORMING, "no non-conforming fixture");
        await openWithFiles(page, baseURL!, NONCONFORMING!);
        await expect(top(page).locator(".packetization-empty-note text")).toHaveText(
            "This trace uses pre-standard event names (transport:packet_received); only quic:packet_received is supported",
        );
        await expect(bottom(page).locator(".packetization-empty-note text")).toHaveText(
            "This trace uses pre-standard event names (transport:packet_sent); only quic:packet_sent is supported",
        );
        await expect(top(page).locator("rect")).toHaveCount(1); // only the clip-path rect
        await expectNoHorizontalOverflow(page);
    });
});
