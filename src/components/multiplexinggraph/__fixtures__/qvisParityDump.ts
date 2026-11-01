// Structural dump of the first multiplexing panel's three charts, used to compare qvis-react 1:1 against the original
// qvis (https://qvis.quictools.info) on the same connection: see capture-qvis-golden.mjs (records the golden from
// hosted qvis) and tests/e2e/multiplexing.spec.ts (replays the same gestures on qvis-react and compares).
//
// One line per SVG element: indentation = depth, tag, attributes sorted by name, text of leaf elements. Numbers are
// rounded to 2 decimals (float noise differs between d3 v5 and v7). Ids and clip-path references are dropped: qvis
// used the shared ids "clip" / "byterange-clip" (M3), qvis-react uses unique ids.
//
// Self-contained on purpose: it is passed to page.evaluate(), so it must not reference anything outside its body.

export interface MuxPanelDump {
    /** one entry per chart: "### waterfall", "### data", "### byterange", then the container style and the SVG tree */
    lines: string[];
}

export function muxPanelDump(): MuxPanelDump {
    const round = (v: string): string =>
        v.replace(/-?\d+\.\d+(e-?\d+)?/g, (m) => String(Math.round(Number(m) * 100) / 100));
    const lines: string[] = [];
    const panel = document.querySelector("[id=multiplexingToplevelContainer]");
    if (panel === null) {
        return { lines: ["NO PANEL"] };
    }
    const walk = (n: Element, indent: string): void => {
        const attrs: string[] = [];
        for (const a of [...n.attributes].sort((x, y) => x.name.localeCompare(y.name))) {
            if (a.name === "id" || a.name === "clip-path" || a.name.startsWith("data-")) continue;
            attrs.push(a.name + "=" + round(a.value));
        }
        const text = n.children.length === 0 && n.textContent ? ' "' + n.textContent + '"' : "";
        lines.push(indent + n.tagName.toLowerCase() + " " + attrs.join(" ") + text);
        for (const c of n.children) walk(c, indent + "  ");
    };
    for (const kind of ["waterfall", "data", "byterange"]) {
        const el = panel.querySelector(`[id^=multiplexing-${kind}-]`);
        lines.push("### " + kind);
        if (el === null) {
            lines.push("(absent)");
            continue;
        }
        lines.push("style=" + el.getAttribute("style"));
        for (const c of el.children) walk(c, "");
    }
    return { lines };
}
