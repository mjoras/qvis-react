// Usage: node src/components/multiplexinggraph/__fixtures__/capture-qvis-golden.mjs
//   (Node >= 23.6 for the .ts import; needs network access to https://qvis.quictools.info)
//
// Records how the ORIGINAL qvis renders its own demo "DEMO_10_parallel_streams.qlog" (aioquic client, 10 x 50 KB) on
// #/multiplexing at 1600 x 1000, through a fixed sequence of gestures, and writes
// qvis-golden-aioquic-parallel10.json next to this script. tests/e2e/multiplexing.spec.ts replays the same gestures on
// qvis-react with tests/fixtures/latest/multiplexing-aioquic-parallel10-client.sqlog (the same connection converted to
// the latest drafts by convert-qvis-parallel10-demo.mjs) and compares the SVG trees, the tooltip and the details line.
//
// The gestures are chosen so that no FIX item of docs/dev/parity/multiplexing-graph.md changes the output except M10
// (legend wording), which the test applies to the golden. In particular the zoom and pan windows still contain frames
// of the selected stream, so qvis' M8 ("Something went terribly wrong") does not trigger; the script refuses to write
// a golden if qvis logs it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { muxPanelDump } from "./qvisParityDump.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "qvis-golden-aioquic-parallel10.json");
const QVIS = "https://qvis.quictools.info";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
});

await page.goto(`${QVIS}/#/files`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Load example/ }).click();
await page.waitForTimeout(6000);
await page.goto(`${QVIS}/#/multiplexing`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const select = page.locator("select").first();
const options = await select.locator("option").allTextContents();
await select.selectOption({ index: options.findIndex((o) => o.includes("10 resources")) });
await page.waitForTimeout(1500);

/** the dump split into its three chart sections */
const dump = async () => {
    const sections = {};
    let current;
    for (const line of (await page.evaluate(muxPanelDump)).lines) {
        if (line.startsWith("### ")) sections[(current = line.slice(4))] = [];
        else sections[current].push(line);
    }
    return sections;
};
const strip = page.locator("[id^=multiplexing-data-] svg");
const golden = {
    source: `${QVIS} (qvis 3db6acf), demo DEMO_10_parallel_streams.qlog, trace "aioquic : client", viewport 1600x1000`,
    capturedAt: new Date().toISOString().slice(0, 10),
    states: {},
};

// 1. initial render
golden.states.initial = await dump();

// 2. hover the 51st frame: tooltip text and position (top relative to the strip SVG: the configurator height differs)
await page.locator("[id^=multiplexing-data-] rect.packet").nth(50).hover();
await page.waitForTimeout(400);
const tip = page.locator("#multiplexing-packet-tooltip");
const stripBox0 = await strip.boundingBox();
golden.tooltip = {
    html: await tip.innerHTML(),
    left: await tip.evaluate((e) => e.style.left),
    topFromStrip:
        (await tip.evaluate((e) => parseFloat(e.style.top))) - (stripBox0.y + (await page.evaluate(() => scrollY))),
};
await page.mouse.move(2, 600);
await page.waitForTimeout(400);

// 3. click the 4th waterfall bar: details line + byte ranges of that stream (render + zoom: axisLeft, M6)
await page.locator("[id^=multiplexing-waterfall-] rect.packet").nth(3).click();
await page.waitForTimeout(800);
golden.details = (await page.getByText("Selected stream's details").locator("xpath=..").innerText())
    .replace(/\s+/g, " ")
    .trim();
golden.states.wfclick = await dump();

// 3b. click the first waterfall bar (stream 0) while unzoomed: render + zoom with the M7 off-by-one window (the first two
// frames, stream 0's offset-0 frames, are ignored for the minimum, so the Y axis starts above them)
await page.locator("[id^=multiplexing-waterfall-] rect.packet").nth(0).click();
await page.waitForTimeout(800);
golden.details0 = (await page.getByText("Selected stream's details").locator("xpath=..").innerText())
    .replace(/\s+/g, " ")
    .trim();
golden.states.wfclick0 = await dump();

// 4. click a frame of the strip: byte ranges of that frame's stream
const box = await strip.boundingBox();
const x = box.x + 20 + 700;
const y = box.y + 20;
await page.mouse.click(x, y);
await page.waitForTimeout(500);
golden.states.stripclick = await dump();

// 5. wheel zoom around that frame (5 x -200)
await page.mouse.move(x, y);
for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(100);
}
await page.waitForTimeout(800);
golden.states.zoom = await dump();

// 6. drag (pan) 60 px to the right
await page.mouse.move(x, y);
await page.mouse.down();
await page.mouse.move(x + 60, y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);
golden.states.pan = await dump();

await browser.close();

// a section identical to the initial render is stored as "=initial" (keeps the file small; e.g. a waterfall click must
// not re-render the waterfall or the strip, M19)
for (const [name, state] of Object.entries(golden.states)) {
    if (name === "initial") continue;
    for (const [kind, lines] of Object.entries(state)) {
        if (JSON.stringify(lines) === JSON.stringify(golden.states.initial[kind])) state[kind] = "=initial";
    }
}

const m8 = consoleErrors.filter((e) => e.includes("Something went terribly wrong"));
if (m8.length > 0) {
    console.error("qvis hit M8 (no frame of the selected stream in the window); pick other gestures", m8);
    process.exit(1);
}
fs.writeFileSync(OUT, JSON.stringify(golden, null, 1) + "\n");
console.log(
    "wrote",
    OUT,
    JSON.stringify(golden.states, (k, v) => (Array.isArray(v) ? v.length : v)),
);
