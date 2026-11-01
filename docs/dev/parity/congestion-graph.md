# Parity spec: congestion-graph (Congestion Graph view, `#/congestion`)

Source of truth: qvis `visualizations/` at commit `3db6acf` (the same checkout the sibling specs use).
All `path:line` citations are relative to
`visualizations/` of [quiclog/qvis](https://github.com/quiclog/qvis).
`R:NNN` is shorthand for `src/components/congestiongraph/renderer/CongestionGraphD3Renderer.ts:NNN`.

Files read completely for this spec:

| File | Lines | Role |
|---|---|---|
| `src/views/CongestionGraph.vue` | 17 | Route view; renders `<CongestionGraphContainer/>` inside a bare `<div>` |
| `src/components/congestiongraph/CongestionGraphContainer.vue` | 45 | Configurator + hover tooltip div + renderer component |
| `src/components/congestiongraph/CongestionGraphConfigurator.vue` | 140 | Trace selector, 6 buttons, alerts, `R` key listener |
| `src/components/congestiongraph/CongestionGraphRenderer.vue` | 131 | Graph host div, 3 legends, global CSS, creates the D3 renderer |
| `src/components/congestiongraph/data/CongestionGraphConfig.ts` | 11 | `{ connection, renderer }` |
| `src/components/congestiongraph/renderer/CongestionGraphD3Renderer.ts` | 1931 | All parsing, drawing and interaction |
| `src/components/congestiongraph/renderer/MainGraphState.ts` | 140 | Main graph geometry and per-perspective scales and ranges |
| `src/components/congestiongraph/renderer/RecoveryGraphState.ts` | 47 | RTT graph geometry and scale |

Imports read for behaviour: `src/data/Connection.ts` (`lookup`, `setupLookupTable`, `parseEvent`),
`src/data/QlogLoaderV2.ts:267-507` (`DirectEventParser`: `relativeTime`, `timeToMilliseconds`),
`src/data/QlogSchema02.ts` (enum values and the draft-02 shapes), `src/store/ConfigurationStore.ts`, `src/App.vue`
(global font and colour), and `src/data/QlogSchemaConverter.ts` (legacy `header.packet_size` becomes `raw.length`).
Locked libraries that define the reference rendering (from `package-lock.json`): d3 5.12.0, d3-axis 1.0.12,
d3-brush 1.1.3, d3-selection 1.4.0, bootstrap 4.3.1, bootstrap-vue 2.0.4.

Related specs: `app-shell.md` (menu tab, `ConnectionConfigurator`, stores, Bootstrap 4 vs 5 overrides),
`file-loading.md` and `data-model.md` (time model §3.16.3, lookup index §3.16.8, latest-draft mapping §9). The
latest-draft event names and fields this view reads are mapped in **§9** of this document. Event names are used
exactly as logged: `docs/dev/ARCHITECTURE.md` §0 and §3.1 forbid aliasing pre-final names (`transport:packet_sent`,
`recovery:metrics_updated`) and fixing up `data`, so the alias and field-normalization tables in
`docs/dev/qlog-spec/quic-events.md` §15 and `ecosystem.md` §6.4-§6.6 do **not** apply to this view. Background:
`docs/dev/qlog-spec/quic-events.md` (§11 cheat sheet) and `docs/dev/qlog-spec/main-schema.md` (P12 time model).

Labels used throughout (same convention as `file-loading.md`):

- **PARITY**: reproduce exactly (visible text, layout, behaviour).
- **FIX**: qvis bug or hazard; qvis-react deliberately deviates. The qvis behaviour is still described.
- **NEW**: needed because qvis-react only accepts the latest drafts (main-schema-14, quic-events-13, h3-events-13).
- **DECISION**: needs a product call; a recommended default is given.

---

## 1. Overview and user-facing purpose

The Congestion Graph plots **one trace (one "connection") from the logging endpoint's sending perspective**. It
answers three questions: how fast did this endpoint push data, when was each packet acknowledged or declared lost,
and how did the congestion controller and RTT estimates evolve.

The page has two stacked plots that share one time axis:

1. **Main graph** (600 px tall):
   - x is time in ms. Left y is cumulative bytes sent ("Data (bytes)").
   - Every `packet_sent` that has a size becomes a small **blue** rectangle. Its x is the send time. Its vertical
     extent is the packet's byte range in a running sum of all sent packet sizes, so the blue rectangles form a
     rising staircase. The legend calls it "Data sent (includes retransmits)".
   - The **first** ACK that covers the packet is drawn as an **olive-green** rectangle with the same byte range, at
     the time the ACK-carrying packet was received.
   - A `packet_lost` for the packet is drawn as a **red** rectangle with the same byte range, at the loss time.
   - Overlays share the left axis: the connection flow-control limit (`initial_max_data` and received MAX_DATA)
     and the sum of stream flow-control limits (`initial_max_stream_data_bidi_remote` and received MAX_STREAM_DATA).
   - Overlays on a **separate right axis** ("Congestion info (bytes)"), scaled so they use the bottom third of the
     plot: congestion window and bytes in flight, drawn as step lines.
2. **RTT graph** (300 px tall) below it: min RTT, smoothed RTT and latest RTT as step lines, on the same
   (zoomable) x-axis.

Interactions:

- Mouse-wheel zoom on x, with y auto-fit.
- Left-drag pan on x and y.
- A one-shot horizontal brush zoom ("Zoom timerange") and a one-shot rectangular brush zoom ("Zoom area").
- A one-shot measuring ruler ("Ruler (press R)") that shows Δtime, Δbytes and the implied rate.
- "Reset zoom".
- Two toggles: hide or show the congestion and flow-control overlays, and auto-scale the RTT y-axis to the visible
  window.
- Hover tooltips on the blue, green and red rectangles. Hovering an ACK also draws a grey "ack arrow" bar from the
  packet to its ACK.

The view is built for **server-side** (data-sending) traces. For a client trace it still plots the client's own sent
packets, which are mostly small requests and ACK-only packets. A "Toggle perspective" button that would swap the
sent and received sides exists in the code but is commented out (§3.11).

Rendering technology: axes, gridlines and labels are D3 v5 SVG. All data marks (rectangles, lines, markers) are drawn
on two HTML `<canvas>` elements. Input is captured by six stacked transparent SVG "mode layers" over the main
canvas. Whichever layer has `z-index: 1` receives the mouse (§2.7).

Layout sketch (W = `window.innerWidth` when the view first renders; coordinates are relative to the padding box of
`#congestion-graph`):

```
y=0    ┌──────────────────────────── main svg (W × 600) ──────────────────────────────────────┐
       │   ┌─legendPackets (left 80, top 10)─┐                                                │
y=20   │   ┌────────────── plot area: canvas + 6 mode layers, (W-140) × 520 at x=70 ──────┐   │
       │ D │ blue/green/red rects, FC lines (left axis)                                   │ C │
       │ a │                                                                              │ o │
       │ t │                                                  ┌legendMetrics (top 440,    │ n │
       │ a │ cwnd / bytes-in-flight (right axis, bottom 1/3)  │ right 50)┐                │ g.│
y=540  │   └──────────────────────────────────────────────────────────────────────────────┘   │
       │                                  Time (ms)                                           │
y=600  ├──────────────────────────── RTT svg (W × 300) ─────────────────────────────────────────┤
y=620  │ R ┌──────────── RTT canvas (W-140) × 220 at x=70 ────────────────────────────────┐     │
       │ T │ min / smoothed / latest RTT step lines            ┌legendRTT (top 795, right 50)┐ │
y=840  │ T └──────────────────────────────────────────────────────────────────────────────┘     │
       │                                  Time (ms)                                           │
y=900  └──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. UI inventory

### 2.1 View composition and DOM tree

Route `#/congestion` (named `congestion`, menu tab "Congestion", tab colour `#d4edda`; see app-shell §2.4 and §3.2).
`src/views/CongestionGraph.vue` renders `<div><CongestionGraphContainer/></div>`.

Resulting DOM after the first successful render. Attributes and inline styles are verbatim. `W` is
`window.innerWidth`, `IW = W − 140` and `IH = 520`.

```
div                                                      (CongestionGraph.vue)
 └ div.home                                               (CongestionGraphContainer.vue:2)
    ├ div[style="background-color: #d4edda; padding: 0px 10px;"]   (Configurator, §2.2)
    ├ div#packetInfo[style="position: absolute; display: none; z-index: 100; padding: 5px;
    │                       border: 1px solid black; background-color: white;"]       (tooltip, §2.6)
    │    ├ p#timestamp  ├ p#packetNr  ├ p#packetSize  ├ p#ackedFrom  └ p#ackedTo
    └ div                                                 (CongestionGraphRenderer.vue:2)
       └ div#congestion-graph[style="width: 100%; border:5px solid #d4edda; min-height: 200px; position: relative;"]
          ├ div#legendPackets   (§2.3)
          ├ div#legendMetrics   (§2.3)
          ├ div#legendRTT       (§2.3)
          ├ div#mainGraphContainer[style="height: 600px; display: block;"]          (appended by D3, R:366)
          │   ├ svg[width=W height=600 style="position: absolute;"]
          │   │   └ g[transform="translate(70, 20)"]
          │   │       ├ g.grid[transform="translate(0, 520)"]     x axis (axisBottom)
          │   │       ├ g.grid                                    left y axis (axisLeft)
          │   │       ├ g.nogrid[style="display: block;"]         right "congestion" y axis (axisRight)
          │   │       ├ text "Data (bytes)"           x="-260" dy="-3.5em" transform="rotate(-90)"
          │   │       ├ text "Time (ms)"              x="IW/2" y="560"
          │   │       ├ text[style="display: block;"] "Congestion info (bytes)" transform="translate(IW+35, 260), rotate(-90)"
          │   │       └ (rect.ackArrow, transient, while hovering an ACK)
          │   ├ canvas[width=IW height=520 style="margin-left: 70px; margin-top: 20px; position: absolute;"]
          │   ├ svg  panning layer   [width=IW height=520 style="margin-left:70px; margin-top:20px; z-index:1; position:absolute"]
          │   ├ svg  brushX layer    [same, z-index:0]  └ g.brush (d3.brushX)
          │   ├ svg  brush2d layer   [same, z-index:0]  └ g.brush (d3.brush)
          │   ├ svg  selection layer [same, z-index:0]  (empty, unused)
          │   ├ svg  pick layer      [same, z-index:0]  (empty)
          │   └ svg  ruler layer     [same, z-index:0]  (ruler lines and texts while measuring)
          └ div#recoveryGraphContainer[style="height: 300px; display: block;"]      (R:370)
              ├ svg[width=W height=300 style="position: absolute;"]
              │   └ g[transform="translate(70, 20)" style="display: block;"]
              │       ├ g.grid[transform="translate(0, 220)"]     x axis
              │       ├ g.grid                                    y axis
              │       ├ text "Time (ms)"   x="IW/2" y="260"
              │       └ text "RTT (ms)"    x="-110" dy="-3.5em" transform="rotate(-90)"
              └ canvas[width=IW height=220 style="margin-left: 70px; margin-top: 20px; position: absolute; display: block;"]
```

Notes:

- Before any trace is selected, `render()` has never run, so `#mainGraphContainer` and `#recoveryGraphContainer`
  do not exist. `#congestion-graph` is then a 200 px tall empty box with a green border. The three legends are still
  visible. `#legendMetrics` (top 440) and `#legendRTT` (top 795) hang below that box over the empty page (PARITY,
  §6.2).
- The mode layers and canvases are absolutely positioned **without** `top`/`left`. They sit at their static
  position, the top-left of their container, shifted by `margin-left: 70px; margin-top: 20px`.
- The `display: block` on the two containers is set in `setup()` (R:625-626). `setPerspective(true)`
  (R:1043-1046) sets `display: block` on the right-axis `g`, the "Congestion info (bytes)" text, the RTT **`g`**
  (`recoveryGraphState.graphSvg` is the inner `g`, not the `<svg>`) and the RTT canvas. On SVG `g` and `text` this
  has no visual effect. It only matters for the dormant received perspective, where it becomes `display: none`.
- The DOM ids are global and selected with `d3.select("#...")`, so only one instance can exist at a time.

### 2.2 Configurator panel (`CongestionGraphConfigurator.vue:1-27`)

Outer `div` with inline style `background-color: #d4edda; padding: 0px 10px;` containing `b-container fluid`
(`div.container-fluid`). Scoped CSS (`:29-37`): `.row { padding-bottom: 10px; }` and `.btn { margin: 0px 5px; }`.
Text colour is inherited from `#app` (`#2c3e50`). The font is `'Avenir', Helvetica, Arial, sans-serif`, 16 px
(`src/App.vue`).

Rows, top to bottom. All are `b-row align-h="center"`, i.e. `div.row.justify-content-center`.

1. `<p style="margin-top: 10px;">Select a trace via the dropdown(s) below to visualize it in the congestion graph</p>`.
   It keeps the Bootstrap `p` bottom margin of 1 rem.
2. `<ConnectionConfigurator v-if="config.connection !== undefined" :allGroups="store.groups"
   :connection="config.connection" :canBeRemoved="false" :onConnectionSelected="onConnectionSelected"/>`.
   This is the shared trace picker (app-shell §2.5). It is one white panel, at most 50% of the row width,
   centred. The row is empty while no connection is selected.
3. Six `b-button`s (default variant `secondary`, i.e. `button.btn.btn-secondary`, Bootstrap 4 grey `#6c757d`,
   white text), left to right, labels verbatim:

   | # | Label | Tooltip (`v-b-tooltip.hover`, placement top, hover only) | Calls |
   |---|---|---|---|
   | 1 | `Reset zoom` | none | `renderer.resetZoom()` |
   | 2 | `Zoom timerange` | `Click this button, then drag and drop a horizontal time range to zoom in on.` | `renderer.useBrushX()` |
   | 3 | `Zoom area` | `Click this button, then drag and drop a rectangular area to zoom in on.` | `renderer.useBrush2d()` |
   | 4 | `Ruler (press R)` | `Click this button or press R, then drag and drop a line to see the time and byte ranges it spans` | `renderer.useRuler()` |
   | 5 | `Toggle congestion info` | none | `renderer.toggleCongestionGraph()` |
   | 6 | `Toggle RTT zooming` | none | `renderer.toggleZoomingRTTGraph()` |

   The buttons are stateless: neither toggle nor the active mode changes their appearance.
   A seventh button is commented out (`:18`) and must **not** be rendered:
   `Toggle perspective`, `variant="danger"`, `v-if="isClientSideTrace"`, tooltip
   `You have selected a trace from a client-side perspective, while this tool works best for server-side. Press this button to simulate a server-side view (by swapping packet_sent and packet_received)`.
4. Alerts (`:21-22`). They are direct children of the container, not inside a row:
   - `<b-alert show variant="danger">Please load a trace file to visualize it</b-alert>` when
     `store.outstandingRequestCount === 0 && store.groups.length === 0`.
   - otherwise `<b-alert show variant="warning">Loading files...</b-alert>` when `store.groups.length === 0`.

Behaviour (`:61-137`):

- `onConnectionSelected(connection)` sets `config.connection = connection`. The renderer's deep watcher then
  re-renders (§3.1).
- **Default selection**: in `mounted()` and in every `updated()`, if `config.connection === undefined` and
  `groups.length > 0`, then `config.connection = groups[0].getConnections()[0]` (the first trace of the first file).
  The selection persists in the global `ConfigurationStore` across route changes.
- **Keyboard**: `mounted()` adds `document.addEventListener('keyup', this.useRuler)` and `beforeDestroy()` removes
  it. `useRuler(evt)` returns early unless `evt.code === "KeyR"`. This is the physical R key on any layout, with or
  without Shift, regardless of focus. The button calls `useRuler()` with no argument.
- The buttons call the renderer through `config.renderer`, which `CongestionGraphRenderer.created()` puts on the
  config object. If no trace has rendered yet, `renderer.mainGraphState` is undefined and every button and the `R`
  key throw a `TypeError` in the console (§7 Q10).

### 2.3 Graph host and legends (`CongestionGraphRenderer.vue:1-80`)

`div#congestion-graph`: `width: 100%; border:5px solid #d4edda; min-height: 200px; position: relative;`. Bootstrap's
global `box-sizing: border-box` applies. After a render it contains two in-flow blocks (600 px + 300 px), so its
border-box height is 910 px.

Three legend boxes. Each is `div` with inline style
`padding: 5px; border: 1px solid black; background-color: white; position: absolute; z-index: 100;` plus a position:

| id | Position | Items (swatch colour, swatch size, label verbatim) | Item style |
|---|---|---|---|
| `legendPackets` | `top: 10px; left: 80px;` | `blue` 12×8 `: Data sent (includes retransmits)`; `#6B8E23` 12×8 `: Data acknowledged`; `red` 12×8 `: Data lost`; `#a80f3a` 12×8 `: Connection flow control limit`; `#ff69b4` 12×8 `: Sum of stream flow control limits` | `<p style="padding: 0; margin: 10px 0;">`, so one item per line |
| `legendMetrics` | `top: 440px; right: 50px;` | `#8A2BE2` 12×8 `: Congestion window`; `#808000` 12×8 `: Bytes in flight` | same as above |
| `legendRTT` | `top: 795px; right: 50px;` | `#C96480` 32×8 `: Min RTT`; `#ff9900` 32×8 `: Latest RTT`; `#8a554a` 32×8 `: Smoothed RTT` (in this order) | `<p style="padding: 0; margin: 3px 15px; display: inline;">`, so all three sit on one line |

The swatch is `<span style="width: Wpx; height: 8px; background-color: C; display: inline-block; margin-right: 1px; vertical-align: middle;"></span>`.
It is followed by whitespace and then the label text. Rendered, that is a swatch, one space, then `: Label`.
Text inherits `#2c3e50` and the 16 px Avenir/Helvetica/Arial font, with line-height 1.5.

Legend hover: `@mouseenter` adds class `hiddenLegend` (`opacity: 0.3`) to the legend and `@mouseleave` removes it.
The legend stays opaque to the mouse, so the plot under a legend cannot be hovered, panned or brushed (PARITY).

Legends are always visible. They do not react to "Toggle congestion info" or to missing data. They do not move when
the window width changes.

Global (unscoped) CSS in the same file (`:67-80`):

```css
.grid line   { stroke: #ddd; }      /* gridlines of the x and left-y axes */
.nogrid line { stroke: #ffffff; }   /* tick lines of the right "congestion" axis: white */
.hiddenLegend { opacity: 0.3; }
```

### 2.4 Main graph (`MainGraphState.ts:12-19`, `R:356-521`, `R:632-731`)

Geometry (PARITY):

- `outerWidth = window.innerWidth` at the moment of the **first** `render()` of this renderer instance. It is not
  updated on resize (§7 Q19). `outerHeight = 600`.
- `margins = { top: 20, bottom: 60, left: 70, right: 70 }`.
- `innerWidth = outerWidth − 140`, `innerHeight = 600 − 80 = 520`.
- The SVG is `W × 600`. Canvas and mode layers are `IW × 520` at (70, 20) inside the container.
- The SVG is `W` wide, but `#congestion-graph` is `W − 10` (its borders) minus any vertical scrollbar. The SVG
  therefore overflows its container on the right by at least 10 px (§7 Q19).

Axes (all re-rendered through `axis(...)` on the existing `g`):

| Axis | Generator | Ticks | Tick size | Label format | Class / line colour |
|---|---|---|---|---|---|
| x (bottom), `g` at y=520 | `d3.axisBottom(xScale)` | default (10) | `-520` (gridlines span the plot) | d3 default for linear (`",f"` with step precision, e.g. `0`, `200`, `1,200`, `0.5`) | `grid`, `#ddd` |
| left y | `d3.axisLeft(yScale)` | default (10) | `-IW` (gridlines span the plot) | **K-format** (below) | `grid`, `#ddd` |
| right "congestion" y, `g` at x=0 | `d3.axisRight(yCongestionScale)` | default (10) | `+IW`: ticks run from x=0 to x=IW, labels at x = IW + 3 | K-format | `nogrid`, `#ffffff` |

K-format (R:672-687, identical copy at R:692-709):

```ts
(val) => {
  const nr = val.valueOf !== undefined ? val.valueOf() : val;
  if (nr > 1000 || nr < -1000) {
    if (Math.round(nr) % 1000 === 0) return Math.round(nr / 1000) + "K";   // 12000 -> "12K", 1000000 -> "1000K"
    return Math.round(nr).toString();                                     // 12010 -> "12010", 2500 -> "2500"
  }
  return Math.round(nr).toString();                                       // 1000 -> "1000", 0.4 -> "0"
}
```

There is no "M" suffix and no decimals. `1000` prints as `1000`, not `1K`.

d3-axis 1.0.12 details that define the pixels (PARITY; d3 v7 reproduces them with `axis.offset(0.5)`, §8.4):

- Tick positions and the domain path are offset by +0.5 px.
- The `g` gets `fill="none" font-size="10" font-family="sans-serif"` and a `text-anchor` of `end` (left axis),
  `start` (right axis) or `middle` (bottom axis).
- Tick text uses `fill="currentColor"`, and tick lines and the domain path use `stroke="currentColor"`. `color`
  inherits `#2c3e50` from `#app`, so **tick labels and the black-looking plot frame are `#2c3e50`**. The CSS above
  overrides tick lines to `#ddd` and `#fff`.
- `tickSize(n)` sets **both** the inner and the outer tick size. The domain paths therefore draw a frame:
  - x axis: `M0.5,-520V0.5H(IW+0.5)V-520`, i.e. the left, bottom and right edges.
  - left y axis: `M(IW),(520.5)H0.5V0.5H(IW)`, i.e. the bottom, left and top edges.
  - right y axis: the same path again (bottom, left and top).

  Together they draw a closed frame around the plot.
- The text offset is `max(tickSizeInner, 0) + 3`, so the left labels sit at x = −3 and the bottom labels at
  y = 3 with `dy="0.71em"`. Left and right labels get `dy="0.32em"`.
- Axis `g` order is x, left y, right y. The right axis's white tick lines are painted over the grey vertical
  gridlines and over the left frame edge. That leaves 1-px white notches at every right-axis tick (reproduce by
  keeping the order and CSS).

Axis titles. Each is a plain `text` with no font attributes, so it inherits 16 px Avenir/Helvetica/Arial. The fill is
the SVG default **black**, and the anchor is `start`:

| Text | Attributes | Effective placement |
|---|---|---|
| `Data (bytes)` | `x = "-" + 520/2 = "-260"`, `dy = "-3.5em"`, `transform = "rotate(-90)"` | vertical, baseline about 56 px left of the plot edge; the text starts at mid-height and runs **upwards** |
| `Time (ms)` | `x = IW/2`, `y = 520 + 40 = 560` | the text **starts** at the horizontal centre (not centred) |
| `Congestion info (bytes)` | `transform = "translate(IW + 35, 260), rotate(-90)"` | vertical, right of the right-axis labels, starts at mid-height and runs upwards |

Scales after a render (sent perspective; `R:649-664`, `R:808-814`):

- `xScale`: linear, domain `rangeX`, range `[0, IW]`.
- `yScale`: linear, domain `rangeY`, range `[520, 0]` (not `.nice()`d).
- `yCongestionScale`: linear, domain `[0, maxCongestionY × 3]`, `.nice()`, range `[520, 0]`. It is computed once per
  render and **never changes with zoom**. The ×3 confines cwnd and bytes-in-flight to the bottom third.

Initial ranges (§3.4): x = `[0, xMax + 10]`, y = `[firstByte (=1), totalSentBytes]`.

Series drawn on the main canvas, in paint order (`R:871-933`):

| # | Series | Colour (fillStyle/strokeStyle string) | Shape | y scale | Shown when |
|---|---|---|---|---|---|
| 1 | packet sent | `"#0000FF"` | rect, width `3 × drawScaleX`, height = byte range | left | always |
| 2 | first ACK of that packet | `"#6B8E23"` | same rect at the ACK time | left | if ACKed |
| 3 | loss of that packet | `"#FF0000"` | same rect at the loss time | left | if lost |
| 4 | bytes in flight | `"#808000"` | step polyline + filled circles r=2 | right | "congestion info" on |
| 5 | congestion window | `"#8A2BE2"` | step polyline + "×" crosses r=2 | right | "congestion info" on |
| 6 | connection FC limit | `"#a80f3a"` | step polyline + crosses | **left** | "congestion info" on |
| 7 | sum of stream FC limits | `"#ff69b4"` | step polyline + crosses | **left** | "congestion info" on |

Items 1-3 are drawn per packet in packet event order (sent, then its ACK, then its loss), so later packets paint over
earlier ones. Lines are painted over all rectangles.

### 2.5 RTT ("recovery") graph (`RecoveryGraphState.ts:6-13`, `R:452-521`, `R:823-854`, `R:935-946`)

- Outer `W × 300`, the same margins, inner `IW × 220`. The SVG is at y=600 of the host and the canvas at (70, 620).
- **No mouse interaction of its own.** There are no mode layers over it, and the wheel scrolls the page. It follows
  the main graph's x zoom and pan.
- x axis: shares the main `xScale`. It is rendered with the **main graph's** x-axis object, whose tick size is
  `−520`. The gridlines and the left and right frame edges therefore run past the 220-px plot up to the top of the
  RTT svg (20 px above the plot), where the SVG viewport clips them (PARITY quirk, §7 Q6).
- y axis: rendered with the **main graph's left-axis object** (tick size `−IW`, K-format and `Math.round`), applied
  to the RTT scale. Labels are therefore integers: sub-ms ticks show as `0`, `0`, `1`, … (§7 Q5).
- y domain:
  - default `[0, maxRTT]`, where maxRTT is the maximum over **all** `min_rtt`, `smoothed_rtt` and `latest_rtt`
    values. It is not `.nice()`d.
  - with "Toggle RTT zooming" on: `[max(minRTTvis − 10, 0), maxRTTvis + 10]` over metric updates whose time lies in
    the visible x window. If there are none, the fallback is the bytes range (§7 Q4).
- Series, in paint order, all step polylines with small filled dots (`drawSmallTick`: a circle of radius 2 centred
  1 px above the point):

  | Series | Colour | Legend label |
  |---|---|---|
  | min RTT | `"#C96480"` | `Min RTT` |
  | smoothed RTT | `"#8a554a"` | `Smoothed RTT` |
  | latest RTT | `"#ff9900"` | `Latest RTT` |

- Titles: `Time (ms)` at (IW/2, 260) and `RTT (ms)` vertical at `x="-110" dy="-3.5em" rotate(-90)`, with the same
  font rules as the main graph.
- RTT lines are drawn whether or not "congestion info" is enabled.

### 2.6 Hover tooltip (`#packetInfo`, `CongestionGraphContainer.vue:4-10`, `R:1541-1549`, `R:1557-1697`)

Box style: `position: absolute; display: none; z-index: 100; padding: 5px; border: 1px solid black; background-color: white;`.
It contains five `<p>` elements: `#timestamp`, `#packetNr`, `#packetSize`, `#ackedFrom`, `#ackedTo`. Each has the
Bootstrap `p` margins (0 top, 1 rem bottom), text `#2c3e50`, 16 px.

Position: only `margin-left` and `margin-top` are set, relative to the box's static position. The static position is
the top-left border corner of `#congestion-graph`, because the tooltip `div` immediately precedes the renderer root
in `.home`. The values are:

- `margin-left = (mouseX_in_plot + 70 + 10) px`
- `margin-top  = (mouseY_in_plot + 20 + 10) px`

Because the plot origin is 5 px (the border) + 70/20 from that corner, **the box's top-left lands 5 px right of and
5 px below the cursor**. When rendering it inside `#congestion-graph` instead (padding-box origin), use
`left = mouseX + 75`, `top = mouseY + 25`.

Stacking: `#packetInfo` and the legends all have z-index 100. The legends come later in the DOM, so a legend paints
**over** the tooltip where they overlap (PARITY).

Visibility: hidden and emptied (`display: none`, all five `<p>` set to `""`) at the start of every hover event and
every wheel zoom. It is **not** hidden on `mouseleave` or after pan, reset or a toggle. The last tooltip stays until
the next mousemove or wheel on a mode layer (PARITY, §7 Q36).

Content per hovered mark (verbatim; `+` is string concatenation; values are raw JS numbers, not rounded):

| Hovered pixel colour | `#timestamp` | `#packetNr` | `#packetSize` | `#ackedFrom` / `#ackedTo` |
|---|---|---|---|---|
| blue `(0,0,255)` = sent packet | `"Timestamp: " + t_sent` | `"PacketNr: " + header.packet_type + " " + header.packet_number` (the code has a no-header fallback `"PacketNr:  ?"`, which is unreachable because `parseQlog` would already have thrown, §7 Q40) | **HTML**: `"PacketSize: " + raw.length` then, if found, `"<br/>CWND: " + v + " bytes"`, `"<br/>In flight: " + v + " bytes"`, `"<br/>RTT: " + v + " ms"` (latest RTT), `"<br/>sRTT: " + v + " ms"` in this order | empty |
| green `(107,142,35)` = ACK | `"Timestamp: " + t_ack` | `"PacketNr: " + ackPacket.header.packet_type + " " + ackPacket.header.packet_number` (the **received** packet that carried the ACK) | empty | `"Acked from: " + from`, `"Acked to: " + to`, where these are the **byte offsets** of the acked packet, not packet numbers |
| red `(255,0,0)` = loss | `"Timestamp: " + t_loss` | `"PacketNr: " + lost.header.packet_type + " " + (lost.header.packet_number or "unknown")` | text `"PacketSize: " + (loss.data.raw ? loss.data.raw.length : "unknown")`; latest-draft `packet_lost` has no `raw`, so this shows `unknown` (§7 Q25) | empty |

Example (blue): `Timestamp: 85.791083` / `PacketNr: 1RTT 4` / `PacketSize: 1252` + `CWND: 40960 bytes` +
`In flight: 2456 bytes` + `RTT: 40.205667 ms` + `sRTT: 41.1 ms`.

Times are graph times: `relativeTime + startTimeOffset` (§3.2). The CWND, In flight, RTT and sRTT lookup is in §3.8.

ACK "arrow" (`R:1660-1678`): when hovering an ACK, a `rect.ackArrow` is appended to the main **axes** SVG `g`.
It therefore sits **under** the canvas but above gridlines and axes, and it is not clipped to the plot:

```ts
let leftX = xScale(t_sent); leftX = leftX > 0 ? leftX : 0;
const topY = yScale(from), bottomY = yScale(to);
rect.attr("class","ackArrow").attr("x", leftX).attr("width", xScale(t_ack) - xScale(t_sent))   // width NOT reduced when leftX was clamped (§7 Q12)
    .attr("y", bottomY).attr("height", (topY - bottomY) * drawScaleY)
    .attr("fill", "#fff").attr("stroke-width", "2px").attr("stroke", "#686868");
```

It reads as a white bar with a grey outline joining the blue rectangle to the green one. All `.ackArrow` rects are
removed at the start of every hover and wheel event.

### 2.7 Interaction modes (stacked mode layers)

Exactly one mode layer has `z-index: 1`; the other five have `0`. Among equal z-indexes the later DOM sibling is on
top, so the `z-index: 1` layer always receives the mouse. The canvas and axes SVG never receive mouse events
(they are below).

| Mode (method) | Layer on top | Handlers on that layer | Entered by | Left by |
|---|---|---|---|---|
| **panning** (`usePanning`, default) | panning svg | `wheel` → zoom; `click` → picker click (no-op); `mousemove.pan` → pan; `mousemove.hover` → hover | initial state; automatically after a brush or ruler | another mode button or `R` |
| **brushX** (`useBrushX`) | brushX svg | `g.brush`: d3.brushX (`end` → zoom to the brushed time range), `wheel` → zoom, `mousemove` → hover | "Zoom timerange" | brush end (switches to panning) or another mode |
| **brush2d** (`useBrush2d`) | brush2d svg | `g.brush`: d3.brush (`end` → zoom to the rectangle), `wheel`, `mousemove` → hover | "Zoom area" | same |
| **ruler** (`useRuler`) | ruler svg | native `mousedown` (once), `mousemove` (while drawing), `mouseup` (once) | "Ruler (press R)" or the R key | mouseup on the ruler svg (switches to panning) |
| selection, picker | selection or pick svg | (selection: none; pick: wheel, click, hover) | never in the UI | n/a |

The mode is **not** reset when a different trace is rendered: a pending brush mode survives a trace switch (PARITY).
The default d3-brush look and behaviour apply to both brush layers:

- overlay cursor `crosshair`
- selection rect `fill #777`, `fill-opacity 0.3`, `stroke #fff`, `shape-rendering crispEdges`
- 6-px handles
- Space+drag moves the selection, Alt centres it, and Shift locks an axis (2-D brush)
- ctrl-click and non-primary buttons are ignored

### 2.8 Interactions in detail

**Mouse wheel (zoom)** (`R:1481-1511`). Active on the panning, brushX, brush2d and pick layers, not on the ruler
layer and not on the RTT graph.

```ts
d3.event.preventDefault();                          // no page scroll
graphSvg.selectAll(".ackArrow").remove(); clearPacketInfoWidget();
const zoomFactor = d3.event.deltaY > 0 ? 1 / 1.5 : 1.5;   // wheel down = zoom out; deltaY == 0 (horizontal swipe) = zoom IN (§7 Q14)
const mouseX = xScale.invert(d3.mouse(currentTarget)[0]);  // ms under the cursor stays fixed
const [leftX, rightX] = rangeX;
const newLeftX  = mouseX - (mouseX - leftX) / zoomFactor >= 0 ? mouseX - (mouseX - leftX) / zoomFactor : 0;
const newRightX = mouseX + (rightX - mouseX) / zoomFactor <= originalRangeX[1] ? mouseX + (rightX - mouseX) / zoomFactor : originalRangeX[1];
const [newTopY, newBottomY] = findYExtrema(newLeftX, newRightX);   // y AUTO-FITS to the packets sent in the new window
redrawCanvas(newLeftX, newRightX, newTopY, newBottomY);
```

There is no zoom-in limit. Zooming out stops at `[0, originalRangeX[1]]`. Every wheel event is one 1.5× step, so a
trackpad zooms very fast (PARITY).

**Drag to pan** (panning mode only, `R:1513-1539`, `R:1699-1723`). On every `mousemove` with
`d3.event.buttons & 1`:

```ts
const panAmountX = (rangeX[1] - rangeX[0]) / IW;   // ms per px
const panAmountY = (rangeY[1] - rangeY[0]) / 520;  // bytes per px
const deltaX = d3.event.movementX * panAmountX * -1;
const deltaY = d3.event.movementY * panAmountY;
// clamp: if rangeX[0]+dx < 0 → dx = -rangeX[0]; else if rangeX[1]+dx > originalRangeX[1] → dx = originalRangeX[1]-rangeX[1]
//        if rangeY[0]+dy < 0 → dy = -rangeY[0]; else if rangeY[1]+dy > originalRangeY[1] → dy = originalRangeY[1]-rangeY[1]
redrawCanvas(rangeX[0]+dx, rangeX[1]+dx, rangeY[0]+dy, rangeY[1]+dy);
```

The content follows the mouse 1:1 ("grab" behaviour). There is no y auto-fit during a pan. The pan starts with any
mousemove while the primary button is down, even if the press began outside the plot. qvis skips the very first
qualifying mousemove of the renderer's lifetime because `previousMouseX/Y` start as `null` and are never reset
(invisible; do not replicate). Hover is suppressed while a button is down (§3.8).

**Zoom timerange (brushX)** (`R:1725-1740`). After the user drags a horizontal band, on `end`:
`[minX, maxX]` = the sorted inverted selection, `[minY, maxY] = findYExtrema(minX, maxX)` (auto-fit),
`redrawCanvas`, `usePanning()`, then `brushXElement.call(brushX.move, null)` to clear the band. Each use needs a new
button click.

**Zoom area (brush2d)** (`R:1742-1759`). Same, but y comes from the rectangle (`yScale.invert` of both corners,
sorted). There is **no** auto-fit.

**Ruler** (`R:85-279`). See §3.9 for the measurement maths.

1. `useRuler()` puts the ruler layer on top and sets `document.body.style.cursor = "pointer"`.
2. It registers a native `mousedown` listener (`{once: true}`) and a native `mouseup` listener (`{once: true}`) on
   the ruler svg.
3. **mousedown** records `(x1, y1) = (evt.offsetX, evt.offsetY)` and appends:
   - `line.ruler`: stroke `pink`, stroke-width `10`, style opacity `0.7`; from (x1,y1) to the cursor.
   - two `line`s with stroke `black`, width `2`: horizontal (x1,y1)→(x2,y1) and vertical (x2,y1)→(x2,y2).
   - three `text`s with `font-family "Trebuchet MS"`, italic, fill `#000000`, `stroke white`, `stroke-width 5`,
     `paint-order stroke` (a white halo). They also set `style("font-size", "14")`. Hosted qvis (Chrome) accepts the unitless value on SVG text and
     renders **14 px** (`font-size: 14px` in the computed style); measured during the congestion review (§7 Q31).
     - time: `dominant-baseline hanging`, `text-anchor middle`
     - bytes: `dominant-baseline central`, `text-anchor start`
     - rate: `hanging`, `middle`

     Their initial contents are `time`, `bytes` and `rate`, at (0,0) of the layer until the first mousemove (a brief
     flash in the top-left corner, PARITY).

   It then adds a `mousemove` listener.
4. **mousemove** updates the line ends to (x2, y2) = the cursor and the texts:
   - time text at `x = min(x1,x2) + |x1−x2|/2`, `y = y1 + (y1 > y2 ? 12 : −20)`. When dragging upwards it sits under
     the horizontal leg, otherwise above it.
   - bytes text at `x = max(x1,x2) + 12`, `y = min(y1,y2) + |y1−y2|/2`.
   - rate text at the diagonal's midpoint, `y + (y1 > y2 ? −30 : 20)`.
5. **mouseup** on the ruler svg resets the body cursor to `"default"`, removes the mousemove listener, removes all six
   elements and calls `usePanning()`. The ruler is a one-shot.

**Reset zoom** (`R:305-314`): `rangeX = originalRangeX` (`[0, xMax + 10]`), `rangeY = originalRangeY`
(`[0, totalSentBytes + 10]`), then redraw. This y range differs from the initial `[1, total]` (§7 Q7). It does not
change the mode or the toggles.

**Toggle congestion info** (`R:281-289`): flips `congestionGraphEnabled` (initially `true`) and redraws the current
ranges. When off, series 4-7 are not drawn. The right axis, its title and both legends stay visible.

**Toggle RTT zooming** (`R:295-303`): flips `zooming0RTTenabled` (initially `false`) and redraws (§3.5 step 4).

**Click** (panning and pick layers, `R:1761-1775`): dispatches `packetPickEvent {x, y, pixelColor}` on a private
`eventBus` span. Nothing listens, so it has no visible effect. Do not port.

**Double-click:** no handler (no reset on double-click). **Keyboard:** only `R` (keyup). There is no Escape and no
arrow keys.

---

## 3. Algorithms and data flow

### 3.1 Lifecycle (`CongestionGraphRenderer.vue:92-127`, `R:316-352`, `R:539-629`)

1. `CongestionGraphRenderer.created()` creates `new CongestionGraphD3Renderer("congestion-graph")` and stores it in
   `config.renderer`, which is deliberately non-reactive.
2. A Vue watcher `@Watch('config', { immediate: true, deep: true })` calls `renderer.render(config)` whenever
   `config.connection !== undefined`. The immediate call fires before `created()`, while `this.renderer` is still
   undefined, so it does nothing.
3. `mounted()` calls `render(config)` if a connection is already selected (for example when returning to the tab).
4. `render(config)`:
   - Returns immediately if `this.rendering` is true. The flag is cleared in a microtask after drawing.
   - First call on this renderer instance: `new MainGraphState()` (this measures `window.innerWidth`),
     `new RecoveryGraphState()`, then `init()`. `init()` creates all the DOM of §2.1, the axis `g`s and titles, and
     **computes `_startTimeOffset` (§3.2) from the currently selected connection**.
   - Later calls: `mainGraphState.reset()` and `recoveryGraphState.reset()`. These clear scales, ranges, lines and
     FC lines. They keep `congestionGraphEnabled`, `useSentPerspective` and `zooming0RTTenabled`. `_startTimeOffset`
     is **not** recomputed (§7 Q1).
   - `setup()`:
     1. `parseQlog()` (§3.3).
     2. `initSentSide({})` and `initReceivedSide({})` (§3.4).
     3. Call the five axes once.
     4. Bind the handlers of §2.7. A **new** `g.brush` is appended to each brush layer on every render (§7 Q26).
     5. `setPerspective(true, false)`.
     6. Set both containers to `display: block`.
   - `renderParts()`: `redrawCanvas(rangeX[0], rangeX[1], rangeY[0], rangeY[1])`.
5. Navigating away destroys the component; there is no keep-alive. Coming back creates a fresh renderer and DOM, and
   `mounted()` re-renders the stored connection. The **zoom, mode and both toggles reset**. Switching traces in place
   resets the zoom but **keeps** the toggles and the mode.

Re-render triggers are any reactive change inside `config`: selecting another trace, or mutating the selected
connection object (rare). Every render re-parses the whole trace and resets the zoom.

### 3.2 Time base and the start-offset hack (`R:523-535`, `R:1910-1918`)

Every x value is `transformTime(relativeTime) = relativeTime + _startTimeOffset`.

```ts
// computed in init() only (first render of a renderer instance)
const firstEvent = connection.parseEvent(connection.getEvents()[0]);   // first event in array order
if (firstEvent.relativeTime > 3000)  _startTimeOffset = -1 * (firstEvent.relativeTime - 200);  // first event lands at 200 ms
else                                 _startTimeOffset = 0;
```

`relativeTime` comes from the shared event parser (`QlogLoaderV2.ts:289-298`). With old `time_format: "relative"` it
was `time × multiplier + time_offset`, which is often a large server-uptime value. With `absolute` it was
`time − events[0].time`. In qvis-react, `relativeTime` comes from the data model's P12 time model
(`qlog-spec/main-schema.md` P12):

- Case A (Unix epoch) and case U (unknown or monotonic epoch) start at 0, so the hack does not trigger.
- Case R (dated epoch) can start far above 0, so the hack applies. That reproduces qvis.

**PARITY**: keep the rule (threshold `> 3000` ms, lead-in `200` ms, based on the first event of the connection after
the data model's ordering). **FIX**: recompute it for every rendered connection (§7 Q1). The x axis always starts at
**0**, not at the first event, so up to 3 s of empty space can precede the first packet (PARITY).

### 3.3 `parseQlog()`: building the model (`R:1059-1470`)

Inputs come from `connection.setupLookupTable()` and `lookup(category, type)`, in **event (array) order**:

```
packetsSent     = lookup("transport", "packet_sent")
packetsReceived = lookup("transport", "packet_received")
packetsLost     = lookup("recovery",  "packet_lost")
metricUpdates   = lookup("recovery",  "metrics_updated")
transportParams = lookup("transport", "parameters_set")
```

(Latest-draft equivalents: §4 for the inventory, §9.2 for the exact lookups.)

Private per-event state is attached as a non-enumerable `event.qvis.congestion = { from, to, correspondingPackets[],
correspondingAck?, correspondingLoss? }` (`R:1875-1885`). It survives across renders: a re-render recomputes
`from`/`to`, but `correspondingAck` from the earlier render is kept. In React, use side tables instead (§8.3).

Two lookup maps, `packetSentList` and `packetReceivedList`, of type `Map<packet_type, Map<String(packet_number), event>>`.
Packet numbers restart at 0 in each QUIC packet number space. Keying the inner maps by packet type keeps the same
packet number in Initial, Handshake and 1-RTT apart. This is qvis's only "overlapping PN space" support. qvis keys by
**packet_type**, not by PN space, so 0-RTT and 1-RTT, which share the application-data space, are separate maps
(§7 Q3).

**Byte ranges are not per PN space.** There is one cumulative counter across all sent packets of all types in event
order. Initial, Handshake, 0-RTT and 1-RTT packets, including ACK-only and PADDING-only packets, all add to the same
y axis.

Step by step:

**(a) Transport parameters** (`R:1095-1108`). For each `parameters_set`:

```ts
if (data.owner && data.owner === "remote") {
  if (data.initial_max_data)                    flowControlLines.application.push([t, parseFloat(data.initial_max_data)]);
  if (data.initial_max_stream_data_bidi_remote) flowControlLines.stream.push([t, parseFloat(data.initial_max_stream_data_bidi_remote)]);
}
```

`t = transformTime(relativeTime)`. Only the peer's parameters count. The peer's `..._bidi_remote` limit governs
streams this endpoint opens, i.e. our sending. Truthiness checks mean a value of `0` is ignored (§7 Q2).

**(b) Sent packets: byte ranges** (`R:1110-1151`):

```ts
let total = 0;
for (const packet of packetsSent) {
  createPrivateNamespace(packet);
  if (!data.raw || !data.raw.length || data.raw.length === 0) { ++invalidSent; continue; }   // no size → not plotted, not matchable
  const from = total + 1;                          // 1-based, inclusive
  total += parseInt("" + data.raw.length, 10);
  packet.qvis.congestion.from = from;
  packet.qvis.congestion.to   = total;             // inclusive
  packetSentList[data.header.packet_type].set("" + data.header.packet_number, packet);   // a later duplicate PN overwrites
  sent.xMax = max(sent.xMax, t);  sent.yMin = min(sent.yMin, from);  sent.yMax = max(sent.yMax, total);
  received.xMin/xMax also updated with t
}
if (invalidSent > 0) console.error("CongestionGraphD3Renderer:parseQlog : There were " + invalidSent + " sent packets with invalid size! They were not used!");
```

Example: sizes 1280, 1176, 1252 give the ranges [1, 1280], [1281, 2456] and [2457, 3708]. Each range spans
`size − 1` bytes of y, and the next starts 1 byte higher. This leaves a 1-byte gap between packets in continuous
y-space (§3.8). Retransmissions are new packets with new numbers and fresh ranges at the top of the stack.

**(c) Received packets: sizes, flow control, ACK linking** (`R:1153-1296`). For each `packet_received`, in order:

1. If `raw.length` is present and non-zero, the packet gets its own received-side range (used only by the dormant
   received perspective). It is stored in `packetReceivedList[packet_type][pn]` and updates `received.*` extrema and
   **`sent.xMax`**. The x extent therefore covers sent **and** sized received packets. Otherwise
   `++invalidReceived`. The packet is **still** scanned for frames below.
2. `if (!data.frames) continue;`
3. For each frame:
   - `frame_type === "ack"`: collect it.
   - `"max_data"` with `maximum !== undefined`: `flowControlLines.application.push([t, parseFloat(maximum)])`.
   - `"max_stream_data"` with `maximum !== undefined`: `streamFCMap.set(String(stream_id), parseFloat(maximum))`,
     then `flowControlLines.stream.push([t, sum of all values in streamFCMap])`. The map only holds streams that got
     an explicit MAX_STREAM_DATA. The initial parameter value from (a) is **not** part of the sum, so the first
     frame's sum can be lower than the initial point (PARITY).
4. For each collected ACK frame with `acked_ranges`, for each range:
   - `[a, b]`: `from = parseInt(a)`, `to = parseInt(b)` (inclusive). Any other length uses `from = to = parseInt(range[0])`.
     Order is irrelevant.
   - For each `pn` from `from` to `to`:
     - `sentPacket = packetSentList[THIS received packet's header.packet_type]?.get(String(pn))`. The ACK's PN space
       is inferred from the carrying packet's type.
     - Not found: `++notSent` and continue.
     - Found and it has no ACK yet: set `sentPacket.correspondingAck = thisReceivedPacket` and push it to this
       packet's `correspondingPackets`. **The first ACK in event order wins**; duplicate ACKs are ignored.
5. If `notSent > 0` and `commonFields && commonFields.protocol_type !== "TCP"`:
   `console.error("CongestionGraphD3Renderer:parseQlog : There were " + notSent + " packets acked that we didn't send. If this is a TCP trace with SACKs, that is expected for now.")`.
   This happens once per received packet.

After the loop: `if (invalidReceived > 0) console.error("CongestionGraphD3Renderer:parseQlog : There were " + invalidReceived + " received packets with invalid size! They were not used!")`.

**(d) Sent ACK frames (received perspective only)** (`R:1298-1369`). This mirrors (c)4 for ACK frames in *sent*
packets, linking them to `packetReceivedList`. Each unknown PN logs
`console.error("Packet was ACKed that we didn't receive... ignoring", ackedNr, frame, packet)`, once per PN. It is only
needed for the dormant received perspective (§3.11).

**(e) Losses** (`R:1371-1395`). For each `packet_lost`:

- With no `header` or no `header.packet_number`: `console.error("Packet was LOST that didn't contain a packet_number field...", packet)`
  and skip.
- `sentPacket = packetSentList[header.packet_type]?.get(String(header.packet_number))`. Not found:
  `console.error("Packet was LOST that we didn't send... ignoring", pn, packet)` and skip.
- Otherwise `sentPacket.correspondingLoss = lossEvent`. **The last loss event wins** (no first-only check).

**(f) Metrics** (`R:1397-1442`). For each `metrics_updated`, with `t = transformTime(relativeTime)`. Every check is a
**truthiness** check, so 0 values are skipped (§7 Q2):

| Field | Pushed to | Value | Extrema |
|---|---|---|---|
| `bytes_in_flight` | `metricUpdateLines.bytes` | raw value | `sent.min/maxCongestionY` |
| `cwnd`, else `congestion_window` | `metricUpdateLines.cwnd` | raw value | same |
| `min_rtt` | `metricUpdateLines.minRTT` | `timeToMilliseconds(v)` = `parseFloat(v) × (time_units === "us" ? 0.001 : 1)` | `sent.min/maxRTT` |
| `smoothed_rtt` | `.smoothedRTT` | same | same |
| `latest_rtt` | `.lastRTT` | same | same |

Ignored: `rtt_variance`, `pto_count`, `ssthresh`, `packets_in_flight`, `pacing_rate`, `in_recovery`,
`max_ack_delay`, and any extension fields. **ssthresh and pacing rate are not plotted.**

**(g) Extents** (`R:1450-1459`):

```
sent.xMax += 10;  sent.yMax += 10;
sent.originalRangeX          = [0, sent.xMax]            // xMax over sized sent AND sized received packets, +10 ms
sent.originalRangeY          = [0, sent.yMax]            // total sent bytes + 10
sent.originalCongestionRangeY= [0, sent.maxCongestionY]  // unused for drawing
recovery.originalRangeY      = [0, sent.maxRTT]          // max of all RTT values (all three series, whole trace)
received.originalRangeX      = [0, received.xMax]        // no +10
received.originalRangeY      = [0, received.yMax]
```

With no sized packets, `xMax = yMax = 0`, so both ranges become `[0, 10]`.

**(h) Step series** (`fixMetricUpdates`, `R:1887-1908`). This is applied to bytes, cwnd, minRTT, smoothedRTT and
lastRTT, and to both FC lines:

```ts
function fixMetricUpdates(points) {                 // points: [t, v][] in push order (no sorting)
  if (points.length === 0) return [];
  const out = []; let last = 0;
  for (const p of points) { out.push([p[0], last]); out.push(p); last = p[1]; }
  out.push([originalRangeX[1] + 1, out[out.length - 1][1]]);   // extend to just past the right edge (xMax + 11)
  return out;
}
// e.g. [(5,40960),(12,52000)] with xMax+10 = 1287.77 → [[5,0],[5,40960],[12,40960],[12,52000],[1288.77,52000]]
```

Each series is therefore a staircase that starts with a vertical rise from **0** at the first update. Every value is
held horizontally until the next update. The FC lines are pushed in "parameters first, then frames" order. If a
`parameters_set` comes after a frame, the polyline steps backwards in x (PARITY; real traces have the parameters
first).

### 3.4 Initial scales (`initSentSide`, `R:632-731`)

```
[_, maxCongestionY, _, maxRTT] = findMetricUpdateExtrema()   // over updates with 0 <= t <= originalRangeX[1]; parseInt; truthiness
[localMinY, localMaxY]         = findYExtrema(0, originalRangeX[1])   // = [1, totalSentBytes] normally
xScale            domain [0, originalRangeX[1]]
yScale            domain [localMinY, localMaxY]          // NOT [0, total+10] (see Reset, §7 Q7)
yCongestionScale  domain [0, maxCongestionY * 3] .nice()
recovery.yScale   domain [0, maxRTT]                     // immediately replaced in redrawCanvas by [0, recovery.originalRangeY[1]]
rangeX = [0, originalRangeX[1]];  rangeY = [localMinY, localMaxY]
```

Notes:

- `findMetricUpdateExtrema` only counts updates with `t ≤ xMax + 10`. A cwnd peak logged after the last packet does
  not enlarge the right axis (PARITY).
- `findYExtrema(minX, maxX)` (`R:1788-1806`) scans **sent** packets whose `t ∈ [minX, maxX]` (inclusive) and returns
  `[min from, max to]`. It starts from `[Infinity, 0]`, so with no packets in the window it returns
  `[Infinity, 0]`: a broken scale with no ticks and nothing drawn (§7 Q16, Q17).
- `initReceivedSide` (`R:734-786`) builds the equivalent received-side scales; this is dormant.

### 3.5 `redrawCanvas(minX, maxX, minY, maxY)` (`R:799-952`)

Called by every interaction. In order:

1. `xScale = linear([minX, maxX] → [0, IW])` and `yScale = linear([minY, maxY] → [520, 0])` (new objects).
   `gxAxis.call(xAxis.scale(xScale))` and `gyAxis.call(yAxis.scale(yScale))`.
2. Clear the main canvas: `clearRect(0, 0, IW, 520)`.
3. (Sent perspective, always in the UI.) RTT y scale:
   - RTT zooming **on**: `[minRTT, maxRTT] = findMetricUpdateExtrema([minX, maxX])` over updates with t in the window.
     If both are 0 (no RTT samples in the window), use `minRTT = 0` and
     `maxRTT = currentPerspective.originalRangeY[1]`, i.e. the **main bytes axis** maximum (§7 Q4). Domain
     `[max(minRTT − 10, 0), maxRTT + 10]`.
   - RTT zooming **off**: domain `[0, recovery.originalRangeY[1]]`.

   Then `recovery.gyAxis.call(mainYAxis.scale(rttYScale))` (the K-format axis object, §7 Q5),
   `recovery.gxAxis.call(mainXAxis.scale(xScale))` (tick size −520, §7 Q6), and clear the RTT canvas
   (`clearRect(0, 0, IW, 220)`).
4. Draw scales:
   - `drawScaleX = xScalingFunction(originalWidth / (maxX − minX))`, with `xScalingFunction(x) = 1/(1 + e^{−(x−2)}) + 1.2`.
     Values: zoom 1× gives 1.4689 (rect width 4.41 px, line width 1.47 px); 2× gives 1.70 (5.10 px); 3× gives 1.931
     (5.79 px); 5× gives 2.153; the limit is 2.2 (6.6 px).
   - `drawScaleY = 1` (the y scaling function exists but is disabled, `R:860-866`).
5. Packet loop over `packetsSent`. `rectWidth = 3`.

   ```ts
   const height = yScale(to) - yScale(from);            // negative (to > from, y axis inverted)
   const x = xScale(t_sent), yTop = yScale(to), yBottom = yScale(from);
   if (x + 3 >= 0 && x <= IW && yBottom + Math.abs(height) >= 0 && yTop <= 520)            drawRect(x,    yTop, 3, height, "#0000FF");
   if (ack  && ackX  + 3 >= 0 && x <= IW && yBottom + Math.abs(height) >= 0 && yTop <= 520) drawRect(ackX, yTop, 3, height, "#6B8E23");
   if (loss && lossX + 3 >= 0 && x <= IW && yBottom + Math.abs(height) >= 0 && yTop <= 520) drawRect(lossX,yTop, 3, height, "#FF0000");
   ```

   This is culling, an optimization only, since the canvas clips anyway. The tests use the unscaled width (3), and
   the ACK and loss tests check the **sent** x against the right edge (`x <= IW`), not `ackX`/`lossX`. Packets without
   a size have `from`/`to` undefined, which gives NaN and the y test fails, so they are never drawn.
6. If congestion info is enabled, draw these lines in order with `drawLines`:
   - bytes (`#808000`, circles) and cwnd (`#8A2BE2`, crosses), mapped with `(xScale(t), yCongestionScale(v))`.
   - FC application (`#a80f3a`, crosses) and FC stream (`#ff69b4`, crosses), mapped with `(xScale(t), yScale(v))`,
     i.e. the **bytes** axis. They are not filtered: values above the visible y-range are off-canvas and never extend
     the axis.
7. RTT lines on the RTT canvas: minRTT `#C96480`, smoothedRTT `#8a554a`, lastRTT `#ff9900`, all with
   `drawSmallTick`, mapped with `(xScale(t), rttYScale(v))`.
8. `rangeX = [minX, maxX]`, `rangeY = [minY, maxY]`.

### 3.6 Drawing primitives (`R:954-1031`)

```ts
drawRect(ctx, x, y, w, h, color) {
  ctx.beginPath(); ctx.fillStyle = color;
  if (h < 0) ctx.rect(x, y, w * drawScaleX, Math.max(0.05, -h * drawScaleY));   // normal case: downward from yTop, min 0.05 px tall
  else       ctx.rect(x, y, w * drawScaleX, Math.min(-0.05, -h * drawScaleY));  // h >= 0 (1-byte packet): 0.05 px upward
  ctx.fill();
}
drawLines(ctx, pts, color, tick) {
  ctx.lineWidth = 1 * drawScaleX;              // also for the RTT canvas; lines thicken when zoomed in
  if (!pts.length) return;
  ctx.beginPath(); ctx.strokeStyle = color; ctx.moveTo(...pts[0]); for (i = 1..) ctx.lineTo(...pts[i]); ctx.stroke();
  for (i = 1; i < pts.length; ++i) tick(ctx, pts[i][0], pts[i][1], color);   // NO marker on pts[0] (the [t0, 0] point)
}
drawCross(ctx, cx, cy, color)     { r = 2; strokeStyle = color; two separate paths: (cx−2,cy−2)→(cx+2,cy+2) and (cx+2,cy−2)→(cx−2,cy+2); uses current lineWidth }
drawCircle(ctx, cx, cy, color)    { r = 2; fillStyle = color; arc(cx, cy, 2, 0, 360); fill }       // 360 is radians; full circle
drawSmallTick(ctx, cx, cy, color) { r = 2; fillStyle = color; arc(cx, cy − 1, 2, 0, 360); fill }
```

Because the step series duplicates points, markers appear at both corners of every step and at the far-right end
point. The canvas is **not** scaled for `devicePixelRatio`: the bitmap is `IW × 520` CSS px, so it looks blurry on
HiDPI screens (§7 Q18). Rectangles at fractional coordinates are anti-aliased.

### 3.7 Pan, zoom and brush state rules (summary)

| Action | New x range | New y range | Clamp |
|---|---|---|---|
| Initial render | `[0, xMax+10]` | `findYExtrema` over all, i.e. `[1, total]` | n/a |
| Wheel | cursor-anchored ×1.5 or ÷1.5 | `findYExtrema(newX)` (auto-fit) | x to `[0, originalRangeX[1]]`; y none |
| Pan | shift by `−movementX × ms/px` | shift by `movementY × bytes/px` | both to `[0, original*[1]]`, snapping the delta |
| Brush X | the brushed band | `findYExtrema(band)` | none (the brush extent is the plot) |
| Brush 2D | the brushed rectangle x | the brushed rectangle y | none |
| Reset | `[0, xMax+10]` | `[0, total+10]` | n/a |
| Toggles | unchanged | unchanged | n/a |

The RTT graph's x always equals the main x. Its y follows §3.5 step 3.

### 3.8 Hover hit-testing (`R:1557-1697`)

On every `mousemove` on the panning, brushX, brush2d or pick layer:

1. Remove `.ackArrow` and hide and clear the tooltip.
2. `if (d3.event.buttons !== 0) return;` (no hover while dragging).
3. `(sx, sy) = d3.mouse(currentTarget)`, plot-local px. `gy = yScale.invert(sy)`. `gx` is computed but unused.
4. `pixel = mainCanvasCtx.getImageData(sx, sy, 1, 1).data`. If `rgb === (0,0,0)` (a transparent pixel), return.
5. Scan the sent packets in order for the **first** packet with `from <= gy <= to` (the hit is decided by y alone).
   The ranges are disjoint and increase in event order. A `gy` that falls in the 1-byte gap between `to` and the
   next `from` matches nothing.
6. With that packet, compare the **exact** pixel RGB:
   - `(0,0,255)`: sent-packet tooltip.
   - `(107,142,35)`: ACK tooltip and ack arrow.
   - `(255,0,0)`: loss tooltip.
   - Anything else (a line colour, an anti-aliased edge, a blended pixel): nothing.

   Only one packet is examined, so if its colour does not match, the scan returns without a tooltip.
7. Tooltip positioning and content are in §2.6.

Metric lookup for the sent-packet tooltip (`R:1603-1641`), run for each of cwnd, bytes, lastRTT and smoothedRTT, in
that order:

```ts
for (let i = 0; i < series.length - 2; ++i) {          // NOTE: skips the last pair (§7 Q11)
  const a = series[i], b = series[i + 1];               // step series from §3.3(h)
  if (a[0] <= t_sent && b[0] > t_sent) packetText += "<br/>" + LABEL + a[1] + UNIT;
}
```

Labels and units: `CWND: … bytes`, `In flight: … bytes`, `RTT: … ms` (latest), `sRTT: … ms`. With time-ordered
updates, at most one line appears per metric. A packet sent after the **last** update of a metric shows no line for
that metric. A packet sent before the first update also shows none. A packet sent exactly at an update time shows
the new value.

### 3.9 Ruler measurements (`R:205-259`)

The ruler always uses the **sent** perspective's current scales:

```ts
const startTime = Math.round(xScale.invert(x1)), endTime = Math.round(xScale.invert(x2));
const timeDifference = endTime - startTime;                       // signed; negative when dragging left
let timeText = timeDifference + " ms";
if (timeDifference > 10000) timeText = (timeDifference / 1000).toFixed(2) + "s";   // no space before "s"

const startBytes = Math.round(yScale.invert(y1)), endBytes = Math.round(yScale.invert(y2));
const bytesDifference = endBytes - startBytes;                    // positive when dragging upwards
let bytesText = bytesDifference + " bytes";
if (bytesDifference > 2000000)      bytesText = (bytesDifference / 1000000).toFixed(2) + " MB";
else if (bytesDifference > 10000)   bytesText = Math.round(bytesDifference / 1000) + " KB";

const bits = (endBytes - startBytes) * 8;
let rate = (bits / 1000) / ((endTime - startTime) / 1000);        // kbit/s
let rateText = Math.round(rate) + " Kbps";
if (rate > 1000) { rate = (bits / 1000000) / ((endTime - startTime) / 1000); rateText = rate.toFixed(2) + " Mbps"; }
```

Examples: `523 ms`, `12.35s`, `1523 bytes`, `15 KB`, `2.35 MB`, `523 Kbps`, `12.34 Mbps`. Negative values never get
unit scaling. `Δt = 0` gives `Infinity Mbps` (or `NaN Kbps` if Δbytes is also 0). All units are decimal (1000-based).
Times are rounded to whole ms before subtracting, so short spans are coarse (PARITY).

### 3.10 Number and text formats (summary)

| Where | Format |
|---|---|
| x tick labels (both graphs) | d3 linear default (`,` thousands separator, precision from the tick step) |
| left y tick labels (both graphs; RTT through the shared axis object) | K-format (§2.4) |
| right congestion tick labels | K-format |
| tooltip numbers | raw JS `String(number)` (e.g. `85.791083`) |
| ruler | §3.9 |

### 3.11 Dormant code (not reachable from the UI)

- **Received perspective** (`useSentPerspective = false`, `togglePerspective()`, `initReceivedSide`, `R:291-293`,
  `R:734-786`, `R:1034-1056`). It would plot `packet_received` byte ranges, with ACKs taken from the endpoint's own
  sent ACK frames and no losses. It hides the right axis, its title and the whole RTT graph. The only button was
  commented out. **Do not port the UI.** The model builder may skip (d).
- **Picker mode** (`usePicker`), the **selection brush** (`useSelection`, commented out at `R:607-618`),
  `packetPickEvent` and `packetSelectionEvent` (never dispatched), `findYExtremaRecovery` (a stub),
  `yScalingFunction` (unused), and `isClientSideTrace` (unused getter). **Do not port.**

---

## 4. Event and field consumption

qvis looks events up with the draft-02 `category:event` keys (`R:1081-1085`). qvis-react looks them up with the
latest-draft names **exactly as logged** (ARCHITECTURE §0 and §3.1; data-model §9.1 rule 2): there is no alias pass
and `data` is never fixed up. A file that still logs pre-final names (current quic-go: `transport:packet_sent`,
`recovery:metrics_updated`, ...) loads, but this view finds nothing in it (§9.1, Q41). §9 gives the field-by-field
mapping, the absence rules and the new-draft items. The table below is the inventory, verified against `R:1059-1442`
(parsing), `R:871-933` (drawing), `R:1557-1697` (hover), `R:1788-1870` (extrema), `R:523-535` (start offset),
`CongestionGraphConfigurator.vue:109-114` and `QlogLoaderV2.ts:267-384`, `:420-506` (time model).

| qvis lookup or input (old) | Fields read (source) | Used for | qvis-react (latest; details in §9) |
|---|---|---|---|
| `transport:packet_sent` (`R:1081`) | `time` → `relativeTime`. `data.raw.length`: skipped when `!data.raw \|\| !data.raw.length \|\| data.raw.length === 0` (truthiness, `R:1120`), else `parseInt("" + len, 10)` (`R:1126`). `data.header.packet_type` (outer map key, `R:1132`). `data.header.packet_number` (inner key `"" + pn`, `R:1137`). Hover: `header.packet_type`, `header.packet_number`, `raw.length` (`R:1597-1601`). Dormant (d): `data.frames[*].frame_type === "ack"` + `acked_ranges` (`R:1309-1364`). | x position; cumulative byte range (y); PN lookup key for ACK and loss linking; tooltip `PacketNr` / `PacketSize`; x extent (`sent.xMax`, and also `received.xMin/xMax`, `R:1139-1146`) | `quic:packet_sent` through `lookup(conn.transportNamespace, QUIC.packet_sent)` (`tcp:packet_sent` for converter TCP traces, data-model §9.10). Same paths: `data.raw.length` (RawInfo; header + payload + 16-byte AEAD tag), `data.header.packet_type`, `data.header.packet_number`. NEW size fallback `raw.data.length / 2` (Q44). `header.packet_size` and `header.length` are **never** read (§9.3). |
| `transport:packet_received` (`R:1082`) | `time`. `data.raw.length`: strict check `!== undefined && !== 0` (`R:1165`) → dormant received range plus `sent.xMax` / `received.*` extents (`R:1167-1188`). `data.header.packet_type`: PN space of the ACK frames it carries (`R:1262`) and dormant received-map key (`R:1173`). `data.header.packet_number`: dormant received-map key (`R:1178`) and ACK tooltip (`R:1656`). `data.frames` (`if (!data.frames) continue`, `R:1197`). Per frame `frame_type`: `ack` → `acked_ranges` (`range.length === 2` gives `[parseInt(r[0]), parseInt(r[1])]` inclusive, any other length gives `parseInt(r[0])`, `R:1245-1256`); `max_data` → `maximum !== undefined` → `parseFloat` (`R:1206-1211`); `max_stream_data` → key `"" + stream_id`, `maximum !== undefined` → `parseFloat` (`R:1213-1229`). | green ACK rectangles (first ACK in event order wins), ACK tooltip, both flow-control lines, x extent | `quic:packet_received` through `lookup(conn.transportNamespace, QUIC.packet_received)`. Same paths. `acked_ranges` is `[+ AckRange]`, `AckRange = [1*2 uint64]` (numbers or decimal strings, converted by the view, not by the model). `ack_delay`, `ect0`, `ect1`, `ce` are not used. §9.4. |
| `recovery:packet_lost` (`R:1083`) | `time`. `data.header` and `data.header.packet_number`: skipped when either `=== undefined` (so PN 0 is accepted, `R:1376`). `data.header.packet_type` (map key, `R:1383`). Hover: `header.packet_type`, `header.packet_number` (`"unknown"` without header), `raw.length` (`"unknown"` without `raw`, `R:1690-1691`). | red loss rectangles (the last loss event wins), loss tooltip | `quic:packet_lost` through `lookup(NS.quic, QUIC.packet_lost)`: `header.packet_type`, `header.packet_number`. `packet_lost` has **no `raw`** in -13, so the tooltip size comes from the matched sent packet (Q25). `frames`, `is_mtu_probe_packet` and `trigger` are not used. §9.5. |
| `recovery:metrics_updated` (`R:1084`) | `time`. Truthy `bytes_in_flight`, pushed **as logged** (no number conversion, `R:1403-1408`). Truthy `cwnd`, else truthy `congestion_window`, as logged (`R:1409-1420`). Truthy `min_rtt`, `smoothed_rtt`, `latest_rtt` through `timeToMilliseconds(v)` = `parseFloat(v) × timeMultiplier` (`R:1421-1441`, `QlogLoaderV2.ts:383-385`). `findMetricUpdateExtrema` re-reads the same members with `parseInt(v, 10)` for bytes and cwnd (`R:1832-1849`). | right-axis step lines and the right-axis scale; RTT step lines and the RTT scale; tooltip `CWND` / `In flight` / `RTT` / `sRTT` | `quic:recovery_metrics_updated` through `lookup(NS.quic, QUIC.recovery_metrics_updated)`: `bytes_in_flight`, **`congestion_window` only** (`cwnd` is not a -13 member and is not read; Q33), `min_rtt`, `smoothed_rtt`, `latest_rtt` (float ms, never scaled). Not used: `rtt_variance`, `pto_count`, `ssthresh`, `packets_in_flight`, `pacing_rate`. §9.6. |
| `transport:parameters_set` (`R:1085`) | `time`. `owner === "remote"` (`R:1100`). Truthy `initial_max_data` and truthy `initial_max_stream_data_bidi_remote`, each through `parseFloat` (`R:1101-1106`). | the first point of each flow-control line | `quic:parameters_set` through `lookup(NS.quic, QUIC.parameters_set)`: **`initiator`** `=== "remote"` (renamed from `owner` in quic-events-12; `owner` is not read). Same parameter names (uint64). §9.7. |
| connection: first event (`connection.getEvents()[0]`, any event type, `R:527-535`) | `relativeTime` | `_startTimeOffset` (§3.2) | `connection.events[0].relativeTime` after the load-time stable sort (data-model §3.16.3, §3.16.7). Recomputed per rendered connection (Q1). §9.8. |
| time model inputs, through `parseEvent().relativeTime` (`QlogLoaderV2.ts:289-298`, `:402-506`) | `event.time` (`parseFloat`; `relativeTime` is `0` when `time` is absent); trace `common_fields.time_format` (`absolute` / `relative` / `delta`) and `common_fields.reference_time`; `configuration.time_units` (`"us"` gives ×0.001, which also scales RTTs through `timeToMilliseconds`); `configuration.time_offset` (added to every `relativeTime`) | every x value; the RTT unit | data-model §3.16.3 (cases A, R, U; per-event `time_format` and `reference_time` honoured). `time_units` and `time_offset` were removed in main-schema-06: always ms, offset 0. §9.8. |
| `connection.commonFields.protocol_type` (`R:1288`) | `!== "TCP"` | gates one console message | removed in main-schema-11. Drop the gate (§9.8). |
| `connection.vantagePoint.type` / `.flow` (`CongestionGraphConfigurator.vue:109-114`, getter `isClientSideTrace`) | `=== "client"` | only the commented-out "Toggle perspective" button (DEAD) | not ported (§9.8). |

Value types in qvis (relevant because the drafts allow uint64 values as JSON strings, main-14:2419-2423):

- Packet sizes go through `parseInt("" + len, 10)`, ACK range bounds through `parseInt`, flow-control values through
  `parseFloat`, and PN keys through `"" + pn`. These all accept numbers and decimal strings alike.
- `bytes_in_flight` and `cwnd` / `congestion_window` are pushed **unconverted**. String values stay strings in the
  step series and the tooltip, and the `sent.minCongestionY` / `maxCongestionY` comparisons in `parseQlog` then mix
  strings and numbers. Those two values are never used for drawing. The drawn right-axis domain comes from
  `findMetricUpdateExtrema`, which uses `parseInt`, and d3 scales coerce strings with `+`. The visible result is
  therefore the same for numbers and canonical decimal strings.
- qvis-react converts every consumed numeric member **once**, with `toNumber()` from `src/qlog/uint64.ts`, while it
  builds the model (§9.1 rule 4). That changes nothing for numeric input. For non-canonical strings it is a FIX: in
  qvis, a `raw.length` of `"0"` was truthy and produced an inverted byte range.

Implementation-specific or legacy members that qvis tolerated. qvis-react reads none of them (ARCHITECTURE §3.1: no
fix-ups). Of these, data-model §9.6 reports only `header.packet_size`, as `event.legacy-field` (toast DM2); `cwnd` and
`owner` are ignored silently:

- `metrics_updated.cwnd` (mvfst pre-draft-01): not read. Only `congestion_window` feeds the cwnd line (Q33).
- `parameters_set.owner` (draft-02; ngtcp2, kwik and older quiche): not read. Only `initiator` counts.
- `header.packet_size` (draft-01/02; qvis moved it to `raw.length` in `QlogLoaderV2.ts:198-226` and
  `QlogSchemaConverter.ts:142-149`): not read. Such a packet has no size and is counted as an invalid-size packet.
- `commonFields.protocol_type === "TCP"` (TCPToQlog traces with SACK): the gate is dropped. Converter TCP traces
  reach this view through `conn.transportNamespace === "tcp"` (data-model §9.10).

Not consumed (PARITY: do not add without a decision; §9.11 lists what the latest drafts would allow):

- Events:
  - `quic:packets_acked`: used only as the Q37 fallback.
  - `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed` (Q43).
  - `quic:parameters_restored` (Q45).
  - Recovery: `quic:recovery_parameters_set`, `quic:congestion_state_updated`, `quic:timer_updated`,
    `quic:marked_for_retransmit`, `quic:ecn_state_updated`.
  - Blocking: `quic:connection_data_blocked_updated`, `quic:stream_data_blocked_updated`,
    `quic:datagram_data_blocked_updated` (Q46).
  - Datagrams: `quic:udp_datagrams_sent`, `quic:udp_datagrams_received`, `quic:udp_datagram_dropped`.
  - Other packet events: `quic:packet_dropped`, `quic:packet_buffered`.
  - Data movement: `quic:stream_data_moved`, `quic:datagram_data_moved`.
  - Paths: `quic:tuple_assigned`, `quic:migration_state_updated`, `quic:mtu_updated`.
  - All `http3:*`, `http:*`, `loglevel:*` and `simulation:*` events.
  - Non-standard producer events such as quic-go `recovery:spurious_loss` and mvfst `quic:packet_ack`.
- Members:
  - Packet events: `datagram_id` / `datagram_payload_checksum`, `raw.payload_length`, `header.length`,
    `is_mtu_probe_packet`, `trigger`, `supported_versions`, `stateless_reset_token`.
  - The event-level `tuple`, and quic-go's `tuple` inside `data`.
- Frames: everything except `ack`, `max_data` and `max_stream_data`. That includes STREAM, CRYPTO, DATAGRAM,
  RESET_STREAM_AT, DATA_BLOCKED, STREAM_DATA_BLOCKED, MAX_STREAMS and extension frames. They only matter through the
  packet's `raw.length`.

Multipath (per-path PN spaces) is not handled; qvis has no tuple support. §9.9 explains why `tuple` must not become
part of the PN key. The PN-space mapping (Q3) is in §9.9.

---

## 5. URL query parameters and global state

**Query parameters:** none are specific to this view. The global sticky parameters (`file`, `list`, `file1..N`, etc.;
app-shell §5.1 and file-loading) load files at startup. The configurator's default selection then picks
`groups[0].getConnections()[0]`, so `#/congestion?file=<url>` opens straight into a rendered graph:

1. While loading: `Loading files...` (warning alert).
2. When the first group appears: the configurator's `updated()` runs `selectDefault()` and the graph renders.

Zoom, mode and toggles are **not** reflected in the URL.

**Global state used:**

| State | Where | Notes |
|---|---|---|
| `ConfigurationStore.congestionGraphConfig.connection` | `ConfigurationStore.ts:11`, `CongestionGraphConfig.ts:9` | The selected trace. Persists across route changes; initially `undefined`. |
| `ConfigurationStore.congestionGraphConfig.renderer` | `CongestionGraphConfig.ts:10` | The live renderer handle, non-reactive by design. In React keep it in a ref or context, not in the store (app-shell §8.6). |
| `ConnectionStore.groups` | configurator | Options for the picker; default selection. |
| `ConnectionStore.outstandingRequestCount` | configurator `:21` | Chooses the danger or warning alert. |
| `document` `keyup` listener | configurator `:121`, `:125` | `R` key; only while the view is mounted. |
| `document.body.style.cursor` | `R:93`, `R:265` | `"pointer"` while the ruler is armed, `"default"` after mouseup. Not restored if the user leaves ruler mode another way (§7 Q9). |
| `window.innerWidth` | `MainGraphState.ts:12`, `RecoveryGraphState.ts:6` | Read once per renderer instance. |
| DOM ids `#congestion-graph`, `#packetInfo` (+ `#timestamp`, `#packetNr`, `#packetSize`, `#ackedFrom`, `#ackedTo`), `#legendPackets`, `#legendMetrics`, `#legendRTT`, `#mainGraphContainer`, `#recoveryGraphContainer` | global `d3.select` | Single instance only. |
| Non-enumerable `event.qvis.congestion` | `R:1875-1885` | Mutates shared event objects. Excluded from downloads. Do not replicate (§8.3). |
| Renderer-instance state: `congestionGraphEnabled` (true), `zooming0RTTenabled` (false), mode (panning), `_startTimeOffset`, ranges | `MainGraphState`, `RecoveryGraphState` | Reset on remount, kept across trace switches (except ranges). |

---

## 6. Edge cases, error handling, notifications

### 6.1 User-visible messages (verbatim)

The view raises **no toasts**. Its only user-visible messages are the two configurator alerts:

| Condition | Element | Text |
|---|---|---|
| `outstandingRequestCount === 0 && groups.length === 0` | `b-alert variant="danger"` | `Please load a trace file to visualize it` |
| else if `groups.length === 0` | `b-alert variant="warning"` | `Loading files...` |

Console output (developer-facing; not to be shown to users). Verbatim, for reference:

- `CongestionGraphD3Renderer:parseQlog : There were <N> sent packets with invalid size! They were not used!` (error)
- `CongestionGraphD3Renderer:parseQlog : There were <N> received packets with invalid size! They were not used!` (error)
- `CongestionGraphD3Renderer:parseQlog : There were <N> packets acked that we didn't send. If this is a TCP trace with SACKs, that is expected for now.` (error, per received packet)
- `Packet was ACKed that we didn't receive... ignoring` (error, per PN, dormant path)
- `Packet was LOST that didn't contain a packet_number field...` (error)
- `Packet was LOST that we didn't send... ignoring` (error)
- `CongestionGraphD3Renderer:transformTime : _startTimeOffset was not set. We need this here!` (unreachable)
- Logs: `CongestionGraphRenderer:render`, `CongestionGraphRenderer:onConfigChanged : `, `container created`,
  `CongestionGraphConfigurator:onConnectionSelected : `, `CongestionGraphConfigurator: Using ruler`,
  `selectDefault: adding new default connection configurator`.

### 6.2 Edge cases and what qvis does

| Case | qvis behaviour | qvis-react |
|---|---|---|
| No file loaded | Configurator shows the danger alert. `#congestion-graph` is an empty 200-px bordered box. All three legends render; two of them hang below the box. Buttons and `R` throw TypeErrors in the console. | PARITY layout; FIX the TypeErrors by making the buttons no-ops (Q10) |
| Trace with zero events (e.g. a TraceError "ERROR" connection) | `_startTimeOffset` unchanged. Ranges `[0,10]`. Left y domain `[Infinity, 0]`, so no left ticks; the frame is still drawn. The right axis has one `0` tick at mid-height (domain `[0,0]` maps to the range midpoint). The RTT axis has one `0` tick at mid-height. Canvases are blank. No message. | PARITY for the axes, except the left y fallback (Q17). DECISION Q38: add an inline notice. |
| `packet_sent` without `raw.length` (some producers omit `raw`) | Silently not plotted and not matchable by ACK or loss; one console error with the count. If no packet has a size, the main graph is empty. | PARITY plotting. DECISION Q38: show an informational notice with the count. |
| `packet_received` without `raw.length` | Its ACK and FC frames are still processed, but its time does **not** extend the x range, so ACKs can fall past the right edge. | PARITY |
| Sized packet event without `header` (malformed) | TypeError in `parseQlog`; the renderer is stuck until remount. | FIX (Q40) |
| No `recovery_metrics_updated` | No cwnd, bytes-in-flight or RTT lines. Right axis has a single `0` tick (mid-height). RTT axis has a single `0` tick (mid-height). Tooltip shows only `PacketSize`. | PARITY |
| Only some metrics present | Each series is independent; missing ones are not drawn. | PARITY |
| Metric value `0` | Ignored by the truthiness checks: bytes in flight never drops to 0 on the plot. | FIX (Q2) |
| No `parameters_set` from the remote side | FC lines start at the first MAX_DATA / MAX_STREAM_DATA frame (from 0). | PARITY |
| Huge FC limits (e.g. 2^62) | Lines go far off the top of the canvas; the axis is not extended. | PARITY |
| ACK for an unknown PN (not logged, unsized, or another PN space) | Ignored; console error count per received packet. | PARITY (aggregate the logging) |
| ACK range spanning huge numbers (e.g. `[0, 1e9]`) | Iterates every PN, so the browser hangs. | FIX: iterate only over PNs that exist in the sent map for that space, e.g. over sorted keys (Q34) |
| Same PN logged twice in a packet type | The last `packet_sent` wins the map slot; ACK and loss attach to it. The first copy keeps its blue rectangle but never gets an ACK or loss. | PARITY |
| 0-RTT packets | Never get ACK rectangles, because ACKs arrive in 1RTT packets and are looked up in the `1RTT` map. | FIX (Q3) |
| Packet declared lost twice | The last loss event's time is used. | PARITY |
| Packet both ACKed and lost (spurious loss) | Both a green and a red rectangle. | PARITY |
| `packet_lost` without `packet_type` | Not found (the `undefined` key); console error. | PARITY |
| First event at more than 3000 ms | Shifted so the first event is at 200 ms (§3.2). | PARITY (per connection, Q1) |
| Unsorted events | Byte ranges follow event order; step lines are drawn in push order (they can zig-zag); "first ACK" means first in file order. | Inherit the data model's ordering (stable time sort, main-schema P10). Same output for sorted traces. |
| Zoom or brush into a window with no sent packets | y domain `[Infinity, 0]`: no left ticks, no rectangles, no FC lines. Right axis and RTT unaffected. | FIX (Q16) |
| Brush click without drag | `end` with `selection === null`, so a TypeError. The mode stays brushX/brush2d. | FIX: guard, keeping the mode (Q8) |
| Window resized | Nothing adapts; the graph keeps its first-render width. | DECISION (Q19) |
| Very large traces | Every redraw and every hover iterates all sent packets (O(n)), and pan redraws on every mousemove. | Precompute typed arrays (§8.7); same output |
| Client-side trace | Shows the client's sent packets (small). No warning (the perspective toggle is commented out). | PARITY |
| -14 file that logs pre-final names (`transport:packet_sent`, `transport:packet_received`, `recovery:packet_lost`, `recovery:metrics_updated`, `transport:parameters_set`; current quic-go ≤ v0.64.1, e.g. `tests/fixtures/quic-go/*.sqlog`) | n/a: qvis rejected the latest envelope; it plotted these names from `qlog_version` 0.3 files | Not consumed (ARCHITECTURE §3.1). The loader raises DM3 and the view shows its empty state plus the Q41 notice (§9.1, §9.12). |
| Converter TCP trace (`tcp:packet_sent` / `tcp:packet_received`, `protocolHint` `TCP_HTTP2`) | qvis's TCP converter logged TCP packets under `transport`, so they were plotted: byte ranges only, no ACKs (no frames), no losses, no metrics (converters §3.12) | PARITY through `lookup(conn.transportNamespace, …)` for the two packet events (§9.2) |
| Switching to another trace while zoomed | The zoom resets to the new trace's full range; toggles and mode persist; the ack arrow and tooltip may linger until the next hover. | PARITY, except `_startTimeOffset` (Q1) |

---

## 7. Known bugs and quirks: PRESERVE or FIX

| ID | Quirk (qvis) | Where | Decision |
|---|---|---|---|
| Q1 | `_startTimeOffset` is computed only in `init()` (the first render of a renderer instance). Selecting another trace in place reuses the previous trace's offset, which can push the new trace hundreds of seconds off-screen or to negative x. | `R:325-331`, `R:523-535` | **FIX**: recompute for every rendered connection (part of building the model). |
| Q2 | Truthiness checks drop zero values: `bytes_in_flight: 0`, `latest_rtt: 0`, `initial_max_data: 0`, etc. The bytes-in-flight line never shows the pipe draining to 0. | `R:1101-1105`, `R:1403-1441`, `R:1832-1861` | **FIX** (recommended, visible): accept any finite number (`v != null && Number.isFinite(+v)`). The tooltip and extrema follow. |
| Q3 | ACK and loss matching is keyed by `packet_type`, not PN space. 0-RTT packets are acknowledged in 1-RTT packets and never get ACKs drawn. | `R:1132-1137`, `R:1262-1264`, `R:1383-1385` | **FIX**: key by PN space (`initial`, `handshake`, `application_data` for `0RTT`/`1RTT`; other types keep their own key). No change for traces without 0-RTT. |
| Q4 | With RTT zooming on, a window with no RTT samples falls back to the **bytes** axis maximum, so the RTT axis jumps to e.g. 0..1.07M with K labels. This is common when zoomed in between samples. | `R:829-833` | **FIX**, only for a window **without** RTT samples: use the step values carried into the window (each series' last sample before `minX`); if there are none either, fall back to `[0, maxRTT]`. A window that has samples uses only those, exactly like qvis (the same-data check found the first implementation also mixing carried values into such windows, which changed the zoomed RTT axis in the common case; fixed, §10). Keep the ±10 ms fuzz and the `max(…, 0)`. |
| Q5 | The RTT y-axis is rendered with the main y-axis object, so its labels use the K-format with `Math.round`. Sub-ms ticks show duplicate integers (`0 0 0 1 1`). | `R:839`, `R:847` | **FIX (partial)**: K-format for integer tick values (identical to qvis for typical RTT ranges ≥ 10 ms), d3's default format for non-integers. |
| Q6 | The RTT x-axis uses the main x-axis object (tick size −520). Gridlines and the left and right frame edges stick out 20 px above the RTT plot, up to its svg top. | `R:851` | PARITY (cheap: `tickSize(-520)` on the RTT x axis). |
| Q7 | The initial y range is `[1, total]`, but after "Reset zoom" it is `[0, total+10]`. A wheel zoom-out to full width gives `[1, total]` again. | `R:643`, `R:306-307`, `R:1507` | PARITY |
| Q8 | The brush `end` handler dereferences `selection` without a null check. A click without drag throws. Clearing the brush with `brush.move(null)` inside the handler re-enters it with `null` and throws (an uncaught TypeError after the zoom already applied). | `R:1725-1759` | **FIX**: `if (!event.selection) return;` (no visible change). |
| Q9 | Ruler hazards: pressing R twice arms two rulers, which draw simultaneously. Leaving ruler mode through another button leaves `body` cursor `pointer` and leaves the once-listeners armed. A mouseup outside the ruler svg leaves the ruler following the mouse until a later mouseup inside. Coordinates come from `evt.offsetX/Y`, which is target-relative; the cursor is usually over the 10-px pink line. | `R:85-279` | **FIX**: one active ruler (re-arming is a no-op). End on `window` mouseup. Ruler elements get `pointer-events: none`, so the ruler layer is always the event target and qvis's `evt.offsetX/offsetY` are reliable: keep them (Chrome reports whole layer pixels; `d3.pointer` gave fractional coordinates because the plot sits at a fractional page offset, which blurred the 2-px legs and shifted them by up to 1 px, §10). Restore the cursor when switching modes. Visuals and maths stay PARITY. |
| Q10 | Buttons and `R` before any render throw TypeErrors (`mainGraphState` undefined). | configurator `:67-106` | **FIX**: no-ops until a model is rendered. |
| Q11 | The tooltip metric lookup loops to `length − 2`, skipping the last step pair. Packets sent after a metric's last update show no CWND, In flight, RTT or sRTT line. | `R:1603-1641` | **FIX** (recommended; adds missing info): loop to `length − 1`. |
| Q12 | The ack-arrow `x` is clamped to 0, but its width is not reduced, so the bar overshoots past the ACK by the clamped amount. It is also unclipped and can paint into the right margin. | `R:1660-1667` | **FIX** the width (`width = xScale(t_ack) − leftX`). Keep it unclipped and under the canvas (PARITY look). |
| Q13 | Hit-testing by exact pixel colour fails on anti-aliased edges and where a line crosses a rectangle. Only the first y-matching packet is checked. | `R:1569-1694` | PARITY (keep pixel picking; see §8.4 for HiDPI). |
| Q14 | `wheel` with `deltaY === 0` (a horizontal trackpad swipe) zooms **in**. | `R:1492` | **FIX**: ignore events with `deltaY === 0` (still `preventDefault`). |
| Q15 | No minimum zoom width; you can zoom in indefinitely. | `R:1481-1511` | PARITY |
| Q16 | `findYExtrema` returns `[Infinity, 0]` for a window without sent packets, which breaks the left axis and hides ACK and loss rectangles for earlier packets. | `R:1788-1806` | **FIX**: if `min > max`, keep the current y range (wheel or brushX). |
| Q17 | A trace with no sized sent packets gets a left y domain of `[Infinity, 0]`. | `R:643` | **FIX**: fall back to `originalRangeY` (`[0, 10]`). |
| Q18 | The canvas is not scaled for `devicePixelRatio`, so it is blurry on HiDPI. | `R:385-391`, `R:460-466` | **DECISION** (recommended FIX): back the canvases with `IW·dpr × H·dpr`, keep the CSS size `IW × H`, and `ctx.setTransform(dpr,0,0,dpr,0,0)`. Hit-testing must read `getImageData(round(sx·dpr), round(sy·dpr), 1, 1)`. Pixel-identical on 1× displays. |
| Q19 | Width is `window.innerWidth` at the first render, never updated. The SVG is wider than its bordered container, causing a 10 px or more horizontal overflow, and its right part sits under the vertical scrollbar. | `MainGraphState.ts:12`, `RecoveryGraphState.ts:6` | **DECISION** (recommended FIX): use `#congestion-graph.clientWidth` (inside the 5-px border) as `outerWidth`, measured when a model is rendered; re-layout (re-render keeping the current x/y ranges) on a debounced (150 ms) window resize. The re-layout must also re-render the right "congestion" axis, which no zoom redraw touches (the first implementation left its labels at the old width, i.e. outside a narrower svg; fixed, §10). At 1600 px the plot is therefore 10 px narrower than in qvis (1450 vs 1460), and qvis's 5 px horizontal page overflow is gone. |
| Q20 | Pan bookkeeping typo (`previousMouseX = graphY`); the first pan move of the renderer's life is swallowed. | `R:1521-1537` | Do not replicate (invisible). |
| Q21 | "Toggle congestion info" hides the four overlay lines but not the right axis, its title or the legends. The buttons show no on/off state. | `R:281-289`, `R:916` | PARITY |
| Q22 | The right axis maximum only considers metric updates with `t ≤ xMax + 10`. | `R:640`, `R:1821-1822` | PARITY |
| Q23 | The FC lines are not filtered to the plotted range despite the comments. The stream-FC sum ignores initial limits of streams without MAX_STREAM_DATA. MAX_DATA and MAX_STREAM_DATA from **sent** packets are ignored. | `R:1206-1229` | PARITY |
| Q24 | Duplicate PNs: the last sent wins the map slot; the last loss wins; the first ACK wins. | `R:1137`, `R:1278`, `R:1393` | PARITY |
| Q25 | The loss tooltip shows `PacketSize: unknown`, because latest-draft `packet_lost` has no `raw`. | `R:1691` | **FIX** (recommended): when `loss.raw.length` is absent, show the size of the matched sent packet; same text format. |
| Q26 | Every render appends another `g.brush` to each brush layer. Old brushes stay underneath with stale extents. | `R:589-605` | **FIX**: create the brushes once; on re-render only update extents and handlers. |
| Q27 | Tooltip times and values are unrounded floats. | `R:1598`, `R:1609-1639` | PARITY |
| Q28 | The ACK tooltip says `Acked from` / `Acked to`, but shows **byte offsets** of the acked packet, not packet numbers. | `R:1657-1658` | PARITY |
| Q29 | Received perspective, picker, selection brush and `packetPickEvent` are dead code. | §3.11 | Not ported |
| Q30 | Console spam: one error per unknown PN (dormant path) and per received packet. | `R:1287-1291`, `R:1351` | **FIX**: aggregate the counts into one `console.debug` per render (dev builds only). |
| Q31 | The ruler sets `font-size: "14"` (unitless). Chrome applies it to SVG text: hosted qvis renders 14 px (corrected during integration; this row first said 16 px). | `R:147`, `R:161`, `R:175` | PARITY: use **14 px** explicitly. |
| Q32 | The toggles and the mode survive trace switches but reset on remount. | §3.1 | PARITY |
| Q33 | `cwnd` takes precedence over `congestion_window` when both exist. | `R:1409-1420` | **FIX (strict drafts)**: read `congestion_window` only. `cwnd` is not a quic-events-13 member and ARCHITECTURE §3.1 forbids data fix-ups, so a `cwnd`-only update draws no cwnd point. data-model §9.6 reports nothing for it, because `cwnd` is not one of its three legacy patterns. §9.6. |
| Q34 | ACK ranges iterate every PN in `[from, to]`. Bogus huge ranges hang the tab. | `R:1258`, `R:1342` | **FIX**: cap the work, e.g. iterate the map's sorted PNs within `[from, to]` when `to − from` exceeds the map size. Same output. |
| Q35 | x extent from sized packets only: losses or metric updates after the last sized packet lie beyond `xMax + 10` and cannot be panned to. | `R:1451-1453` | PARITY |
| Q36 | The tooltip and ack arrow are not hidden on `mouseleave`. They linger when the cursor leaves the plot, enters the tooltip itself, or after a pan, reset or toggle. | `R:1557-1561` | PARITY |
| Q37 | `quic:packets_acked` (new in the latest drafts) is ignored; ACKs are derived only from ACK frames. Traces that do not log frames show no green rectangles. | n/a | **DECISION** (recommended NEW, fallback only): if a trace has no ACK frames in `packet_received` at all, derive first-ACK times from `quic:packets_acked` (`packet_number_space`, default `application_data`; `packet_numbers`; the event time as the ACK time). There is no carrying packet, so the ACK tooltip's second line uses qvis's no-header form `PacketNr:  ?` (with two spaces). Never mix both sources. Exact algorithm in §9.4.1. |
| Q38 | Empty or unsized traces render silently empty. | §6.2 | **DECISION** (recommended NEW): an inline Bootstrap `alert-info` below the buttons, e.g. `This trace has no packet_sent events with a size (raw.length); there is nothing to plot.` or `N packet_sent events have no raw.length and were not plotted.` The final texts, with the `quic:` / `tcp:` prefix and the non-conforming-name case, are in Q41 (§9.12). |
| Q39 | The `R` key fires even while typing in a form control (e.g. select type-ahead) and with modifiers. | configurator `:82-93` | **DECISION** (recommended FIX): ignore when `event.target` is an `input`, `select`, `textarea` or contentEditable element, or when Ctrl, Meta or Alt is held. |
| Q40 | A sized `packet_sent` or `packet_received` without `header`, or a `packet_received` without `header` that carries ACK frames, throws a TypeError in `parseQlog` (`data.header.packet_type`). `render()` already set `rendering = true` and never resets it, so the renderer ignores every later `render()` until the view is remounted. The graph stays on the previous trace or blank. | `R:1132`, `R:1173`, `R:1262`, `R:338-350` | **FIX**: treat a missing `header` like a missing size (skip and count it). For ACK frames in a header-less received packet, skip the frames. Never leave the renderer stuck: reset state in a `finally`. The -13 schema makes `header` mandatory, so this only affects malformed input. |

Q41 to Q47 come from the latest-draft mapping and are defined in §9.12.

---

## 8. Porting notes for React

### 8.1 Suggested module breakdown

This fits the scaffold and app-shell §8.1:

```
src/views/CongestionView.tsx                      route view → <CongestionGraphContainer/>
src/components/congestion/CongestionGraphContainer.tsx
        owns rendererRef (useRef<CongestionRenderer|null>) and passes the actions to the configurator
src/components/congestion/CongestionGraphConfigurator.tsx
        green panel, intro text, <ConnectionConfigurator/>, 6 buttons (react-bootstrap Button + OverlayTrigger tooltips),
        <NoTraceAlerts/> (shared), document keyup "R" listener (useEffect add/remove)
src/components/congestion/CongestionGraph.tsx
        div#congestion-graph (+ legends + tooltip box); mounts the imperative renderer in useEffect;
        builds the model with useMemo(connection) and calls renderer.setModel()
src/components/congestion/CongestionLegends.tsx   static JSX of the 3 legends (exact inline styles from §2.3)
src/components/congestion/congestion.css           .grid/.nogrid/.hiddenLegend rules, scoped under #congestion-graph
src/lib/congestion/model.ts        buildCongestionModel(connection): CongestionModel   (pure, unit-tested; §8.3)
src/lib/congestion/stepSeries.ts   toStepSeries(points, rightEdge)                     (fixMetricUpdates)
src/lib/congestion/format.ts       kFormat(n), rulerTexts(x1,y1,x2,y2,scales), tooltip text builders
src/lib/congestion/viewport.ts     wheelZoom(), panClamp(), yExtrema(), xDrawScale(), rttDomain()
src/lib/congestion/CongestionRenderer.ts   imperative D3 + canvas class (DOM of §2.1 below the legends)
```

### 8.2 State and lifecycle mapping

| qvis | React |
|---|---|
| `ConfigurationStore.congestionGraphConfig.connection` | zustand `configurationStore.congestion.connection` (app-shell §8.6). Auto-select `groups[0].connections[0]` in a configurator `useEffect` keyed on `[groups, groupsVersion, connection]`. |
| `config.renderer` | `rendererRef` in `CongestionGraphContainer`, exposed to the configurator through props or context. Never in the store. |
| Deep `@Watch('config')` | `useEffect(() => renderer.setModel(model), [model])` with `model = useMemo(() => buildCongestionModel(connection), [connection])`. Re-render on **connection identity** change only (unrelated store mutations should not reset the zoom). |
| `mounted()` render | Covered by the same effect on mount. |
| `rendering` guard | Not needed (synchronous `setModel`). |
| Renderer instance lifetime = component lifetime | `useEffect(() => { const r = new CongestionRenderer(hostEl, tooltipEl); rendererRef.current = r; return () => r.destroy(); }, [])`. `destroy()` removes all appended DOM, d3 listeners, the window resize and mouseup listeners, and restores `body.style.cursor` if the ruler is armed. It must be StrictMode-safe: double mount and unmount must leave exactly one DOM set. |
| `congestionGraphEnabled`, `zooming0RTTenabled`, mode | Fields on the renderer instance (reset on remount, kept across `setModel`). They do not need React state, since the buttons show no state. |
| `#packetInfo` updated with `d3.select(...).text/html` | The tooltip box is rendered by React (static structure) and filled imperatively by the renderer through refs. This is hot-path mousemove, so avoid React state. Place the element **before** the legends in `#congestion-graph` (stacking parity, §2.6). Position it with `left = sx + 75`, `top = sy + 25`, or reproduce the margin trick exactly. |
| `R` key | `document.addEventListener('keyup', h)` in the configurator effect; `h` checks `e.code === "KeyR"` (plus the Q39 guard) and calls `rendererRef.current?.useRuler()`. |

### 8.3 Model builder (pure)

Replace the event mutation (`event.qvis.congestion`) with flat arrays built once per connection. Keep the exact
semantics of §3.3, with FIX Q1, Q2 and Q3 marked:

```ts
type Pt = [number, number];
interface CgPacket {
  t: number; from: number; to: number;            // graph time, inclusive byte range
  type: string; pn: string | undefined; size: number;
  ackT?: number; ackType?: string; ackPn?: string;   // carrying packet_received (first ACK in event order)
  lossT?: number; lossType?: string; lossPn?: string; lossSize?: number;  // last packet_lost
}
interface CongestionModel {
  startTimeOffset: number;                          // §3.2, computed per connection (FIX Q1)
  packets: CgPacket[];                              // sized packet_sent only, event order; from/to strictly increasing
  skippedSent: number; skippedReceived: number;     // for the optional notice (Q38)
  bytes: Pt[]; cwnd: Pt[]; minRTT: Pt[]; smoothedRTT: Pt[]; latestRTT: Pt[];   // step series (§3.3h)
  fcApplication: Pt[]; fcStream: Pt[];              // step series
  metricSamples: { t: number; bif?: number; cwnd?: number; min?: number; srtt?: number; lrtt?: number }[];  // raw samples, for RTT-zoom extrema
  originalRangeX: [0, number];                      // [0, xMax + 10]
  originalRangeY: [0, number];                      // [0, total + 10]
  initialRangeY: [number, number];                  // yExtrema(0, xMax+10) = [1, total]  (Q17 fallback: originalRangeY)
  maxCongestionY: number;                           // over samples with 0 <= t <= xMax+10
  maxRTT: number;                                   // over all RTT samples
}
const pnSpace = (type: string) => type === "0RTT" || type === "1RTT" ? "application_data" : type;  // FIX Q3
```

Event access:

- Use the data model's lookups (namespace + type, main-schema P13) with the exact keys of §9.2. The two packet events
  go through `lookup(conn.transportNamespace, QUIC.packet_sent)` and `lookup(conn.transportNamespace, QUIC.packet_received)`.
  The other events go through `lookup(NS.quic, …)`.
- `relativeTime` comes from the data model (data-model §3.16.3).
- `data` is used **exactly as logged** (ARCHITECTURE §3.1: no alias table, no fix-ups).
- Convert numeric members with `toNumber()` from `src/qlog/uint64.ts` (§9.1 rule 4). `timeToMilliseconds(x)` is
  `toNumber(x)`.
- `pnSpace` above is the Q3 key. §9.9 gives the complete rule, including absent and unknown packet types.

Sorting assumption: `packets` comes out in increasing `from` order by construction, so the hover search (§3.8) can
binary-search on `from`. That gives the same first match as qvis's linear scan, because ranges are disjoint.

### 8.4 Imperative renderer (keep D3 and canvas; port from d3 v5 to v7)

Keep the qvis structure: an axes SVG, a canvas, and the stacked mode layers with z-index switching. That is the
simplest way to stay pixel-identical. Specific v5 to v7 changes:

- `d3.event` and `d3.mouse` are gone. Handlers receive `(event)`; use `d3.pointer(event, event.currentTarget)`.
  `movementX/Y` and `buttons` come from `event`.
- **Wheel:** attach with d3 `.on("wheel", h)` or `addEventListener("wheel", h, { passive: false })` on the layer
  elements. **Do not use React `onWheel`**: React registers wheel listeners as passive, so `preventDefault()` would
  not stop the page from scrolling.
- **Brush:** `d3.brushX()/d3.brush().extent([[0,0],[IW,520]]).on("end", (event) => { if (!event.selection) return; … })`
  (Q8). Clear with `g.call(brush.move, null)` after the zoom. The guard also swallows the programmatic re-entry.
- **Axis pixel offset:** d3-axis 3 uses offset 0 on `devicePixelRatio > 1` and 0.5 otherwise. qvis (d3-axis 1.0.12)
  always used 0.5. Call `.offset(0.5)` on every axis for identical geometry.
- **Minus sign:** d3-format 3 uses U+2212 "−" by default. The x axis uses d3's default format, so negative ticks
  (only possible with a negative `startTimeOffset` edge case) would differ. For exact text, create the x tick format
  with a locale `{ minus: "-" }` (e.g. `d3.formatLocale({decimal: ".", thousands: ",", grouping: [3], currency: ["$",""], minus: "-"})`).
  The K-format uses `String()` and is unaffected.
- Keep `tickSize(-520)` / `tickSize(-IW)` / `tickSize(IW)` exactly. They define both the gridlines and the frame
  (§2.4). Re-render the RTT axes with the main x tick size (Q6), and with the RTT tick format of Q5.
- Axis titles are plain `<text>` with no font attributes, so they inherit the page font (16 px; `#app` family);
  their fill is black. Tick labels inherit `color: #2c3e50` via `currentColor`. Make sure the host inherits the same
  `font-family` and `color` (`#app` rules in global CSS; app-shell §2.3).
- **Hit-testing:** keep `getImageData` pixel picking (Q13). With DPR scaling (Q18 DECISION), multiply the
  coordinates by `dpr` and `Math.floor` them. Create the 2-D contexts with `{ willReadFrequently: true }` so per-move
  reads stay fast. That flag does not change the pixels.
- **Ruler:** a small state machine in the renderer (`idle → armed → drawing → idle`) with the Q9 fixes. Draw into the
  ruler layer SVG with the exact attributes of §2.8.
- **Culling:** optional; the canvas clips. If implemented, use the qvis predicates (§3.5).
- **Mode switching** is a single `setMode(m)` that sets `z-index: 1` on the active layer and `0` on the others,
  keeping the DOM order of §2.1. It also restores `document.body.style.cursor = "default"` when leaving ruler mode
  (Q9).

### 8.5 CSS

- `#congestion-graph .grid line { stroke: #ddd; }`, `#congestion-graph .nogrid line { stroke: #ffffff; }` and
  `#congestion-graph .hiddenLegend { opacity: 0.3; }`. Scoping under the host id avoids leaking the global `.grid`
  rule. Bootstrap 5's optional `.grid` class is off by default, but scope anyway.
- Configurator: `.cg-configurator .row { padding-bottom: 10px; }` and `.cg-configurator .btn { margin: 0 5px; }`.
- Inline styles of the host, legends and tooltip are copied verbatim from §2.1-§2.6. In React these become style
  objects. Mind `border: '5px solid #d4edda'`, `minHeight: 200` and `position: 'relative'`.
- Bootstrap 5 vs 4 (app-shell §8.7): button colours (`btn-secondary` #6c757d in both), the `p` margin-bottom of
  1 rem (both), `.row` gutters (affects the configurator rows), and `alert` padding. The inline SVG/canvas positioning
  is unaffected. Bootstrap 4 reboot set `svg { overflow: hidden }`; the UA default for inline SVG is also
  `overflow: hidden`, so the RTT gridline clipping (Q6) is preserved under Bootstrap 5.

### 8.6 Accessibility (NEW, non-visual)

These are optional and do not change pixels:

- Give the mode buttons `aria-pressed` for the two toggles.
- Give the canvases `role="img"` with an `aria-label` such as "Congestion graph: data sent, acknowledged and lost
  over time".

### 8.7 Performance

- Precompute `Float64Array`s for `t`, `from`, `to`, `ackT` and `lossT` (NaN when absent) and the step series in pixel
  space per redraw.
- Batch canvas fills per colour (one `beginPath` per colour, many `rect`s, one `fill`). Exact-pixel parity requires
  the same paint order where marks overlap: qvis paints per packet (sent, ack, loss) in sequence. Different colours
  overlapping at the same pixel only happen for zero-time ACKs or spurious losses. **Recommendation:** keep
  per-packet order for traces under ~50k packets (identical output) and allow per-colour batching above that.
- Throttle pan redraws to `requestAnimationFrame`, applying the accumulated movement. The output equals qvis's at
  frame boundaries.

### 8.8 Tests (parity harness)

Unit tests (`vitest`):

- `model.test.ts`:
  - byte ranges (1280, 1176, 1252 give [1,1280], [1281,2456], [2457,3708]); unsized packets skipped and counted
  - first ACK wins across duplicate ACKs; last loss wins
  - ACK lookup uses the carrying packet's PN space, and 0-RTT is matched by 1-RTT ACKs (Q3)
  - `[n]` and `[a,b]` ranges, unordered ranges
  - FC: only `initiator === "remote"`; the stream sum over the latest per-stream values
  - zero metric values are kept (Q2)
  - `startTimeOffset`: 3001 ms gives −2801, 3000 gives 0
- `stepSeries.test.ts`: the §3.3(h) example; an empty input gives `[]`.
- `format.test.ts`:
  - K-format: 1000→`1000`, 2000→`2K`, 2500→`2500`, 1000000→`1000K`, −2000→`-2K`, 0.4→`0`
  - ruler: `523 ms`, 10001 ms → `10.00s`, 10000 → `10000 ms`, 2000001 bytes → `2.00 MB`, 10001 → `10 KB`,
    rate 1000 Kbps → `1000 Kbps`, 1001 → `1.00 Mbps`
- `viewport.test.ts`:
  - wheel zoom keeps the cursor time fixed; clamps to `[0, originalRangeX[1]]`; `deltaY === 0` is ignored (Q14)
  - pan clamps snap the delta
  - `xDrawScale(1) ≈ 1.46894`, `xDrawScale(2) = 1.7`
  - RTT domain with and without zooming, including the Q4 fallback

**Fixture caveat (§9.13 F3).** `tests/fixtures/quic-go/*.sqlog` is quic-go v0.64.1 output. It has a -14 envelope
but uses pre-final event names (`transport:packet_sent` 808×, `recovery:metrics_updated` 1001×,
`recovery:packet_lost` 34×, `transport:parameters_set` 2×), which ARCHITECTURE §3.1 does not consume. The positive e2e
below therefore runs on the **conforming** regeneration of the same scenario: `tests/fixtures/latest/`, produced by
`tools/qloggen` (ARCHITECTURE §2), with the `quic:` names of §9.2. Re-derive the numbers below from that file. They
were measured on the quic-go file, and the event data is expected to be identical apart from the names. A negative
e2e loads the quic-go file as is and asserts the DM3 toast, the empty plot and the Q41 notice.

Playwright e2e with the conforming `h3-5x200k-loss2-server` fixture (server; 808 `packet_sent`, all with
`raw.length`, 1,074,802 bytes in total; 34 `packet_lost`; RTT samples 40.2-42.4 ms; remote `initial_max_data`
786432):

- Load the fixture and open `#/congestion`. The first trace is auto-selected.
- The left axis top tick reads `1000K`.
- The main canvas contains blue `(0,0,255)`, green `(107,142,35)` and red `(255,0,0)` pixels.
- Hovering a blue pixel shows `PacketNr: 1RTT <n>` and `PacketSize: <size>`.
- "Toggle congestion info" removes the `#8A2BE2` and `#808000` pixels.
- "Reset zoom" after a wheel zoom restores the x domain `[0, xMax + 10]`.
- Pressing `R`, then dragging, shows ruler texts matching `/ ms$|s$/`, `/ bytes$| KB$| MB$/` and `/ Kbps$| Mbps$/`.

For the client trace `h3-10x50k-loss5-client.sqlog`, the plot shows only 13,868 bytes sent (PARITY:
sending perspective).

---

## 9. Mapping to latest qlog drafts

qvis-react accepts these drafts as input, all published 6 July 2026:

- draft-ietf-quic-qlog-main-schema-14
- draft-ietf-quic-qlog-quic-events-13
- draft-ietf-quic-qlog-h3-events-13

It also accepts the editor's-copy clarifications listed in the digests (ARCHITECTURE §0). This section maps every
old-schema event, member and trace input that the congestion graph consumes (§4) to its exact latest-draft
equivalent. For each one it states the semantic differences and what happens when the input is absent. It also
lists inputs that have no latest equivalent, and evaluates what is new in the drafts. Model-level names and
absence rules belong to data-model §9 (rows L1-L5, hooks N1-N15). This section covers how the congestion graph uses
them. h3-events-13 defines nothing this view reads.

Citation forms:

- `main-14:NNN` and `quic-13:NNN` are `grep -n` line numbers in
  `the published draft texts (ietf.org)draft-ietf-quic-qlog-main-schema-14.txt` and `…/draft-ietf-quic-qlog-quic-events-13.txt`.
- `ed:NNN` is a line in the editor's copy, `scratchpad/ref/qlog-wg/draft-ietf-quic-qlog-quic-events.md`.
- "quic digest", "main digest" and "ecosystem" are `docs/dev/qlog-spec/quic-events.md`, `main-schema.md` and
  `ecosystem.md`.

### 9.1 Ground rules

1. **Exact names, no fix-ups.** This follows ARCHITECTURE §0 and §3.1, and data-model §9.1 rule 2.
   - The view consumes only the event names in §9.2.
   - Pre-final names are not found by the lookups. Examples: `transport:packet_sent`, `recovery:metrics_updated`,
     and the intermediate `quic:metrics_updated`.
   - A file that uses such names still loads. Its events stay in `connection.events`, where they still count for
     the first-event start offset (§9.8), and the loader raises DM3.
   - Members are read only at their -13 paths. The legacy members `cwnd`, `owner` and `header.packet_size` are not
     read.
   - This overrides quic digest §15, ecosystem §6.4-§6.6 and app-shell §9.1 rule 1 (§9.13 F2).

   Consequence: quic-go v0.64.1 (current) writes `transport:packet_sent`, `transport:packet_received`,
   `recovery:packet_lost`, `recovery:metrics_updated` and `transport:parameters_set` (ecosystem §3.1). Its files
   render an empty congestion graph with the Q41 notice. These producers already use the canonical names that this
   view needs:
   - quiche ≥ 0.27, neqo, quinn and tokio-quiche (`quic:packet_sent`, `quic:recovery_metrics_updated`, …);
   - mvfst main, with the caveats in §9.5;
   - qvis-react's own netlog converter;
   - the patched quic-go generator `tools/qloggen`.
2. **Namespaces.**
   - `packet_sent` and `packet_received` are looked up in `conn.transportNamespace`. That is `"quic"`, or `"tcp"` for
     converter TCP traces (data-model §9.10, D9).
   - `packet_lost`, `recovery_metrics_updated`, `parameters_set` and, for Q37, `packets_acked` are looked up in
     `NS.quic` only.
   - Type constants come from `src/model/names.ts` (`QUIC.packet_sent`, …).
3. **Order.**
   - Lookup arrays follow `connection.events` order: file order after the load-time stable sort by resolved time
     (data-model §3.16.7). Main-14 §7.1 lets tools sort, and the editor's copy says tools cannot rely on time order.
   - Every first/last rule of §3.3 is evaluated in that order: cumulative byte ranges, first ACK wins, last loss
     wins, last duplicate PN wins, and step-series push order.
   - For time-ordered files this is qvis's file order.
4. **uint64 values may be JSON numbers or decimal strings** (main-14:2419-2423). This covers `raw.length`,
   `packet_number`, AckRange bounds, `maximum`, `stream_id`, `initial_max_*`, `bytes_in_flight` and
   `congestion_window`.
   - The model builder converts each value once, with `toNumber()` from `src/qlog/uint64.ts`. It returns `NaN` for
     anything that is not a number or a decimal string.
   - Precision loss above 2^53 is acceptable (data-model §9.1 rule 4).
   - Tooltips print the **logged** value (`"" + header.packet_number`), not the converted one (PARITY).

   Helpers used below:

   ```ts
   import { toNumber } from "@/qlog/uint64";
   const has = (v: unknown) => v !== undefined && v !== null && Number.isFinite(toNumber(v));   // presence test (Q2 FIX)
   const pnKey = (v: unknown) => (v === undefined ? "undefined" : String(toNumber(v)));        // PN / stream-ID map key
   ```

   `pnKey` equals qvis's `"" + pn` for numbers and for canonical decimal strings. A string such as `"007"` becomes
   `"7"`, so it matches the `parseInt`-ed ACK bounds as qvis intended (FIX). A missing PN keeps qvis's
   `"undefined"` key: the packet is plotted but can never be matched (PARITY).
5. **Time is float64 ms everywhere.** This covers event `time` and `min_rtt`, `smoothed_rtt` and `latest_rtt`
   (main-14 §1.2). `time_units` was removed (main-14:3297). `timeToMilliseconds(x)` is `toNumber(x)`.
6. **Unknown members, frame types and enum values are ignored** (main-14 §8.4). They never throw and never change
   the plot, except through the packet's `raw.length`.
7. **Status words:**
   - SAME: same path and meaning.
   - RENAMED: same meaning, new name.
   - CHANGED: different optionality, type or meaning.
   - REMOVED: no equivalent.
   - NEW: not in draft-02.

### 9.2 Event lookups

| # | qvis lookup | Latest event (importance; draft) | Status | qvis-react lookup | Names that are **not** consumed (pre-final or non-standard, seen in the wild) |
|---|---|---|---|---|---|
| E1 | `lookup(transport, packet_sent)` (`R:1081`) | `quic:packet_sent` (Core; quic-13 §5.5 :1164, CDDL :1181) | RENAMED (namespace) | `lookup(conn.transportNamespace, QUIC.packet_sent)` | `transport:packet_sent` (quic-go ≤ v0.64.1; also ngtcp2, aioquic, OpenSSL and Go x/net, whose `qlog_version` files are rejected at load anyway) |
| E2 | `lookup(transport, packet_received)` (`R:1082`) | `quic:packet_received` (Core; quic-13 §5.6 :1220, CDDL :1237) | RENAMED | `lookup(conn.transportNamespace, QUIC.packet_received)` | `transport:packet_received` |
| E3 | `lookup(recovery, packet_lost)` (`R:1083`) | `quic:packet_lost` (Core; quic-13 §7.4 :2388, CDDL :2413) | RENAMED | `lookup(NS.quic, QUIC.packet_lost)` | `recovery:packet_lost` (quic-go); `recovery:spurious_loss` (quic-go, non-standard) |
| E4 | `lookup(recovery, metrics_updated)` (`R:1084`) | `quic:recovery_metrics_updated` (Core; quic-13 §7.2 :2283, CDDL :2308) | RENAMED (namespace **and** type) | `lookup(NS.quic, QUIC.recovery_metrics_updated)` | `recovery:metrics_updated` (quic-go), `quic:metrics_updated` (intermediate drafts), mvfst's private `mvfst:pacing_metric_update` / `mvfst:bandwidth_est_update` |
| E5 | `lookup(transport, parameters_set)` (`R:1085`) | `quic:parameters_set` (Core; quic-13 §5.3 :993, CDDL :1043) | RENAMED | `lookup(NS.quic, QUIC.parameters_set)` | `transport:parameters_set` (quic-go). `quic:recovery_parameters_set` and `http3:parameters_set` are different events (qvis separated them by category). |
| E6 | (none) | `quic:packets_acked` (Extra; quic-13 §5.9 :1383, CDDL :1405) | NEW | `lookup(NS.quic, QUIC.packets_acked)`, **only** as the Q37 fallback (§9.4.1) | mvfst `quic:packet_ack` (non-standard data `{packet_num_space, packet_num}`; must not be aliased, ecosystem §6.4) |

Main-14 §8.3 says Core events "SHOULD be present", but tools "SHOULD NOT expect every Core event in every trace". An
absent event type is therefore a normal state, never an error:

| Event absent | Result (PARITY unless noted) |
|---|---|
| E1 | Nothing to plot. The plot area stays empty and the left axis uses the Q17 fallback. The Q41 notice is shown (NEW). |
| E2 | No ACK rectangles (unless Q37 applies) and no flow-control frame points. The x extent comes from sent packets only. |
| E3 | No red rectangles. |
| E4 | No cwnd, bytes-in-flight or RTT lines. The right axis and the RTT axis each show a single `0` tick (§6.2). |
| E5, or no remote E5 | The flow-control lines start at the first MAX_DATA / MAX_STREAM_DATA frame, rising from 0. |
| E6 | Irrelevant unless Q37 applies. |

### 9.3 `quic:packet_sent` (E1)

| Old path (qvis) | Latest path (-13) | Status | Semantic differences | When absent or invalid |
|---|---|---|---|---|
| `time` → `relativeTime` | `time: float64` ms (main-14:874) → data-model `relativeTime` | CHANGED (time model) | §9.8 | Malformed time: the model substitutes the previous event's resolved time (data-model §9.4); qvis used 0. |
| `data.raw.length` | `data.raw.length` (RawInfo `? length: uint64`, main-14:2211, :2215; `? raw`, quic-13:1191) | SAME path; CHANGED type (number or string) | Full packet size: header + payload + a 16-byte AEAD tag counted as a trailer (quic-13:245-252; main digest §16). **Spec ambiguity:** quic-13:2618-2621 (kept in ed:1877-1879) says that for `initial`, `handshake` and `0RTT` "the length field of the packet header is logged in the qlog raw.length field", i.e. packet number + payload. Every known producer logs the full size (quic digest §11, ambiguity 1). Sum `raw.length` as logged; never "correct" it (§9.13 F4). | Size = `packetSize(data)` (below). Undefined: the packet is skipped and counted in `skippedSent` (PARITY with qvis's invalid-size path). It gets no byte range, no ACK or loss match and no x-extent contribution. Q41 notice. |
| (none) | `data.raw.data` (hexstring; main-14:2211) | NEW (Q44) | When `raw.length` is absent and `raw.data` is logged, the data is the full value, so its byte length is `raw.data.length / 2` (main-14:2443-2446, §11.4: "tools SHOULD … derive the length") | qvis skipped such packets. |
| (not read) | `data.raw.payload_length` (main-14:2219) | not consumed | Payload only, without header and AEAD tag. **Never** a size fallback: it would mix two measures on one y axis. | — |
| `data.header.packet_size` (draft-01/02; qvis moved it to `raw.length`, `QlogLoaderV2.ts:198-226`) | none | REMOVED | — | Not read: the packet is unsized. data-model §9.6 reports it once per file as `event.legacy-field` (DM2). |
| (not read) | `data.header.length` (`? length: uint16`, -13 only, quic-13:2666; removed in the editor's copy) | not consumed | Long-header Length field: packet-number length plus payload length. **Not** the packet size. | Never used as a size, which contradicts ecosystem §6.5 and §6.6 `packetLength()` (§9.13 F1). |
| `data.header` | `header: PacketHeader` (**required**, quic-13:1182) | CHANGED (now required) | — | Missing or not an object: skipped and counted like an unsized packet (Q40 FIX). |
| `data.header.packet_type` | `packet_type: $PacketType` (the one required PacketHeader member, quic-13:2637-2638; values at :2581) | SAME | Values and casing are the same as in qvis: `initial`, `handshake`, `0RTT`, `1RTT`, `retry`, `version_negotiation`, `stateless_reset`, `unknown` (with `packet_type_bytes`). The socket is open, so custom strings are allowed. The PN space is not logged; it is derived as in §9.9. | Missing: key `pnSpace(undefined)` = `"undefined"`, so the packet is plotted and never matched. The tooltip prints `PacketNr: undefined <pn>`, the same text as qvis. |
| `data.header.packet_number` | `? packet_number: uint64` (quic-13:2659; only meaningful for `initial`, `handshake`, `0RTT`, `1RTT`) | CHANGED (optional; number or string) | Inner map key `pnKey(pn)` (§9.1). | Absent, which is always the case for `retry`, `version_negotiation` and `stateless_reset`: key `"undefined"`. The packet is plotted if sized and never matched; the tooltip shows `PacketNr: <type> undefined` (PARITY). Duplicate keys: the last sized packet wins the slot (Q24). |
| `data.frames[ack].acked_ranges` (dormant received perspective, §3.3(d)) | same paths | SAME | — | Not ported (§3.11). |
| (none) | `datagram_id` (-13) / `datagram_payload_checksum` (editor's copy), `is_mtu_probe_packet`, `trigger`, `supported_versions`, `stateless_reset_token`, quic-go's `data.tuple` | NEW, not consumed | §9.11 | — |

Size helper, normative for E1 and E2:

```ts
import { rawByteLength } from "@/qlog/uint64";
import type { RawInfo } from "@/qlog/schema/main";
// raw.length (number or decimal string), else raw.data.length / 2 (main-14 §11.4, Q44).
// Undefined unless the result is a positive finite number.
function packetSize(data: Record<string, unknown>): number | undefined {
  const raw = data.raw;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const n = rawByteLength(raw as RawInfo);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);                                  // qvis: parseInt("" + len, 10)
}
```

Differences from qvis are FIX or NEW and invisible for well-formed input:

- The string `"0"` and negative or non-numeric values are skipped. In qvis, `"0"` passed the truthiness test and
  produced an inverted range.
- Packets logged with `raw.data` but no `raw.length` get a size (Q44).

### 9.4 `quic:packet_received` (E2)

| Old path | Latest path (-13) | Status | Semantic differences | When absent or invalid |
|---|---|---|---|---|
| `time` | `time` | CHANGED (time model) | It is the ACK time and the flow-control point time. | As in §9.3. |
| `data.raw.length` | `data.raw.length` (quic-13:1247) | SAME path | Only extends `sent.xMax` (and the dormant received side). Same `packetSize()` as §9.3. | Undefined: no x-extent contribution, but the frames are still processed (PARITY, `R:1165-1197`). |
| `data.header` | `header: PacketHeader` (required, quic-13:1238) | CHANGED | — | Missing: no x-extent contribution and the packet's ACK frames are skipped (Q40 FIX). MAX_DATA and MAX_STREAM_DATA frames are still used because they need no PN space. |
| `data.header.packet_type` | same | SAME | The PN space of **every** ACK frame in this packet. An ACK acknowledges packets of the space it is sent in (RFC 9000 §12.3; quic digest §8.3), so the key is `pnSpace(type)` (Q3, §9.9). | Missing (header present): ACK frames are matched against the key `"undefined"` and find nothing. qvis also found nothing. |
| `data.header.packet_number` | `? packet_number` | CHANGED | Only used for the ACK tooltip `PacketNr: <type> <pn>`. | Absent: the tooltip prints `undefined` (PARITY). |
| `data.frames` | `? frames: [* $QuicFrame]` (quic-13:1239) | SAME (optional) | A producer may log frames in `quic:frames_parsed` / `quic:frames_processed` instead (§9.11, Q43). | Absent or not an array: this packet contributes no ACK or flow-control data (PARITY). |
| frame `frame_type` | `frame_type` (`$QuicFrame` is an open socket, quic digest §8) | SAME | Dispatch on exactly `"ack"`, `"max_data"` and `"max_stream_data"`; ignore every other value. | Non-object frames are ignored. |
| `ack.acked_ranges` | `? acked_ranges: [+ AckRange]`, `AckRange = [1*2 uint64]` (quic-13:2866, :2875) | SAME shape; CHANGED type (numbers or strings) | Each range is `[n]` or `[from, to]`, inclusive, in any order. `[n, n]` is legal and tools MUST accept it (quic digest §8.3). | Absent: the frame is ignored (`R:1241`). Per-range handling: the algorithm below. |
| `ack.ack_delay`, `ect1`, `ect0`, `ce`, `raw` | same (`ack_delay` in float ms, quic-13:2872) | not consumed | — | — |
| `max_data.maximum` | `maximum: uint64` (required, quic-13:3042-3043) | SAME | Converted with `toNumber`; qvis used `parseFloat`. | `undefined`: the frame is ignored (PARITY, `R:1207`). NaN (non-numeric): ignored (FIX; qvis pushed NaN into the polyline). |
| `max_stream_data.stream_id` | `stream_id: uint64` (required, quic-13:3053) | SAME | Map key `pnKey(stream_id)`. qvis used `"" + id`; mvfst logs stream IDs as strings, and `4` and `"4"` give the same key. | Absent: key `"undefined"` (PARITY; qvis keyed `"undefined"` too). |
| `max_stream_data.maximum` | `maximum: uint64` (quic-13:3054) | SAME | As `max_data`; the sum is taken over the latest value per stream key (§3.3(c)). | As `max_data`. |
| (none) | `? trigger: "keys_available"` (quic-13:1250) | NEW, not consumed | The packet was reported earlier by `quic:packet_buffered`. That event is not consumed, so nothing is counted twice. | — |
| (none) | `datagram_id` / checksum, `supported_versions`, `stateless_reset_token`, `tuple` | NEW, not consumed | — | — |

ACK-range handling (normative; replaces `R:1240-1285`):

```ts
const space = pnSpace(data.header.packet_type);                    // §9.9; header checked first (Q40)
for (const f of frames) {
  if (f === null || typeof f !== "object" || f.frame_type !== "ack" || !Array.isArray(f.acked_ranges)) continue;
  for (const r of f.acked_ranges) {
    if (!Array.isArray(r) || r.length === 0) continue;             // malformed; qvis: parseInt(undefined) = NaN, no iteration
    const from = toNumber(r[0]);
    const to = r.length === 2 ? toNumber(r[1]) : from;             // qvis: exactly 2 elements = range, otherwise r[0] only
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;   // qvis: the loop never runs
    markAcked(space, Math.trunc(from), Math.trunc(to), thisEvent); // first ACK wins; bounded iteration (Q34)
  }
}
```

#### 9.4.1 `quic:packets_acked` fallback (E6, Q37)

What the drafts say:

- quic-13:1383-1416: the event is emitted when sent packets are acknowledged **for the first time**.
- `packet_number_space` is optional and defaults to `application_data` (quic-13:1412-1414).
- `packet_numbers: [+ uint64]` is optional.
- main-14:1964-1967: implementations that log no `packet_received` events, and therefore no ACK frames, "SHOULD log
  packets_acked events instead".

neqo emits this event (ecosystem §3.3). When Q37 is adopted:

1. **Activation.** Use E6 only when **no** E2 event contains an `ack` frame with an `acked_ranges` array, and at least
   one E6 event exists. Otherwise ignore E6 completely; the two sources are never mixed.
2. For each E6 event, in order:
   1. `space` is `data.packet_number_space` when it is a string, else `"application_data"`.
   2. If `data.packet_numbers` is not an array, skip the event.
   3. For each `pn` with a finite `toNumber(pn)`, look up `sent = sentByKey.get(space)?.get(pnKey(pn))`.
   4. If `sent` exists and has no ACK yet, set `ackT = transformTime(event.relativeTime)` and `ackHasHeader = false`.
      Because the event fires only on first acknowledgement, "first wins" also covers duplicates across events.
3. **Tooltip.** Such an ACK shows these lines:
   - `Timestamp: <ackT>`
   - `PacketNr:  ?`: two spaces, qvis's no-header form at `R:1656`, because no carrying packet exists.
   - `Acked from: <from>` and `Acked to: <to>`.

   The ACK arrow is drawn as usual.
4. **Requires the Q3 key.** E6 carries a PN space, not a packet type. With qvis's per-type keys, `application_data`
   would have to probe both the `1RTT` and the `0RTT` maps.
5. **No error counting.** PNs that match nothing are not counted as errors; they include packets that the trace never
   logged as sent.

### 9.5 `quic:packet_lost` (E3)

| Old path | Latest path (-13) | Status | Semantic differences | When absent or invalid |
|---|---|---|---|---|
| `time` | `time` | CHANGED (time model) | x position of the loss rectangle | As in §9.3. |
| `data.header` | `? header: PacketHeader` (quic-13:2416; the comment at :2415 says it "should include at least the packet_type and packet_number") | CHANGED (optional) | — | Missing: skipped and counted in `skippedLost` (PARITY with `R:1376-1379`). mvfst's aggregate `quic:packet_lost {largest_lost_packet_num, lost_bytes, lost_packets}` has no header and is always skipped. Do not interpret its members (ecosystem §6.5: not shimmed). |
| `data.header.packet_number` | `? packet_number: uint64` | CHANGED (number or string) | Lookup key `pnKey`. | `=== undefined`: skipped (PARITY; PN 0 is accepted). |
| `data.header.packet_type` | required inside PacketHeader | SAME | Key `pnSpace(type)` (§9.9). | Missing: key `"undefined"`, not found, skipped (PARITY). Never guess `application_data`. The netlog converter's T1 output has `packet_type: "unknown"` and stays unmatched (PARITY, converters §3.12; its T3 option resolves the type). |
| `data.raw.length` (tooltip) | none: `QUICPacketLost` has no `raw` (CDDL quic-13:2413-2425) | REMOVED | — | Q25 FIX: `PacketSize: ` + (`packetSize(loss.data)` if a producer logs `raw` as an extension member, else the matched sent packet's size). Only matched losses are drawn, so the value is always a number. |
| (none) | `? frames`, `? is_mtu_probe_packet` (quic-13:2421), `? trigger` (`reordering_threshold` \| `time_threshold` \| `pto_expired`, :2422) | NEW, not consumed | An MTU-probe loss is not a congestion signal (quic digest §6.4), but it is still drawn red (PARITY; Q46). | — |

Matching is unchanged: the last loss event wins (Q24). -13 has no spurious-loss event, and quic-go's
`recovery:spurious_loss` is non-standard and not consumed. A packet that was declared lost and later acknowledged
still shows both its green and its red rectangle (PARITY).

### 9.6 `quic:recovery_metrics_updated` (E4)

The event is emitted when one or more recovery metrics change (quic-13:2283-2290). Each event carries at least one
metric, and producers SHOULD log only changed values (quic digest §6.2). So the metrics are **sparse deltas**: an
absent member means "unchanged", never 0. qvis's per-member step series already implement exactly that: a series
gets a point only from events that carry its member (PARITY). For example, quic-go's `pto_count`-only updates add no
point to any series.

| Old member (qvis) | Latest member (quic-13) | Status | Conversion and semantics | Series and use | When absent or invalid |
|---|---|---|---|---|---|
| `bytes_in_flight` (truthy, pushed as logged) | `? bytes_in_flight: uint64` (:2321) | SAME | `toNumber`; presence test `has()`, so 0 is a value (Q2) | `bytes` (`#808000`, right axis), tooltip `In flight` | Absent or NaN: no point. |
| `cwnd`, else `congestion_window` | `? congestion_window: uint64` (:2320) **only** | RENAMED (`cwnd` was pre-draft-01) | `toNumber`; `cwnd` is not read (Q33) | `cwnd` (`#8A2BE2`), tooltip `CWND` | Absent: no point, even when `cwnd` is present. |
| `min_rtt` through `timeToMilliseconds` | `? min_rtt: float32` ms (:2312) | SAME; CHANGED unit handling | `toNumber`, never scaled (`time_units` removed, main-14:3297) | `minRTT` (`#C96480`); RTT scale | Absent: no point. |
| `smoothed_rtt` | `? smoothed_rtt: float32` ms (:2313) | SAME | as above | `smoothedRTT` (`#8a554a`), tooltip `sRTT` | as above |
| `latest_rtt` | `? latest_rtt: float32` ms (:2314) | SAME | as above | `lastRTT` (`#ff9900`), tooltip `RTT` | as above |
| (not read) | `rtt_variance` (:2315), `pto_count` (:2316), `ssthresh` (bytes, :2324), `packets_in_flight` (sum over all PN spaces, :2328), `pacing_rate` (bits/s, :2331) | SAME, not consumed | — | none (Q46) | — |
| (not read) `max_ack_delay`, `in_recovery` | none | REMOVED | now `quic:parameters_set.max_ack_delay` and `quic:congestion_state_updated` | — | — |

Notes:

- Extension members (`* $$quic-recoverymetricsupdated-extension`) are ignored.
- The step series and the right-axis domain use the same converted numbers. qvis's series (raw values) and its
  `findMetricUpdateExtrema` (`parseInt`) only agreed for numeric input (§4, value types).
- mvfst logs ms floats. A file with mvfst's pre-draft `cwnd` would need `congestion_window`; current mvfst writes
  `congestion_window`.

### 9.7 `quic:parameters_set` (E5)

| Old member | Latest member (quic-13) | Status | Semantic differences | When absent or invalid |
|---|---|---|---|---|
| `owner === "remote"` | `? initiator: "local" \| "remote"` (:1044) | RENAMED (quic-events-12, #498) | `"remote"` means the values the peer announced, i.e. the peer's limits on our sending. `initiator` "MUST be correct for all settings included in a single event instance"; local and remote settings are separate events (quic-13:1013-1017). | `initiator` absent: treated as not remote and the event is ignored (PARITY with an absent `owner`). `owner` is never read. quiche ≤ 0.26, ngtcp2 and kwik wrote it, and their legacy files are rejected at load. |
| `initial_max_data` (truthy, `parseFloat`) | `? initial_max_data: uint64` (:1074) | SAME | `toNumber`; presence `has()` (Q2) | Absent: no point. The application flow-control line starts at the first MAX_DATA (PARITY). |
| `initial_max_stream_data_bidi_remote` | `? initial_max_stream_data_bidi_remote: uint64` (:1076) | SAME | As above. Q42 covers which parameter this really is. | As above. |

The model is cumulative (quic-13:1020-1025):

- A later `parameters_set` supersedes the earlier value of every setting it includes.
- A setting that an event does not mention is unchanged.
- Producers regularly log several instances (quic-13:1001-1004).

qvis pushes a point only for events that include the parameter, which is already the correct cumulative reading
(PARITY). Repeated remote events with the same value add flat steps (PARITY).

Not consumed:

- `quic:parameters_restored` (quic-13:1125, CDDL :1137): the server parameters a client remembered for 0-RTT. They are
  implicitly remote and the event has no `initiator`. See Q45.
- `initial_max_stream_data_bidi_local`, `initial_max_stream_data_uni`, `initial_max_streams_*` and every other
  parameter.

### 9.8 Trace-level, time and connection inputs

| Old input | Latest | Status | Behaviour in qvis-react |
|---|---|---|---|
| `connection.getEvents()[0].relativeTime` → `_startTimeOffset` (`R:527-535`) | `connection.events[0].relativeTime` (data-model §3.16.3) | CHANGED (time model) | The rule is unchanged: if the first event's time is above 3000 ms, the offset is `−(t − 200)`. It is computed per connection (Q1). Which data-model time case applies decides whether it fires: **case A** (Unix epoch or no `reference_time`, e.g. quinn) and **case U** (`epoch: "unknown"`: the monotonic clocks of quic-go, quiche, neqo and mvfst; mvfst's raw times are about 1e8 ms since boot) both start `relativeTime` at 0, so the offset is 0 and the hack never fires. **Case R** (a dated epoch, where `relativeTime = resolved`) can start above 3000 ms; the hack then fires as in qvis. The first event may be of any namespace, including non-conforming events. |
| `event.time` (`parseFloat`; 0 when absent) | `time: float64` ms (required, main-14:874) | SAME | Resolved per data-model §3.16.3. Per-event `time_format` and `reference_time` are honoured, and `relative_to_previous_event` is decoded at load. |
| `common_fields.time_format` (`absolute` / `relative` / `delta`) and `common_fields.reference_time` (number or string) | `time_format` (`relative_to_epoch` / `relative_to_previous_event`) and a `reference_time` object, in `common_fields` or per event | CHANGED | data-model §9.3. |
| `configuration.time_units` | none (main-14:3297) | REMOVED | Multiplier 1; RTTs are ms. |
| `configuration.time_offset` | none (main-schema-06) | REMOVED | 0. |
| `common_fields.protocol_type !== "TCP"` (console gate, `R:1288`) | none (main-schema-11 removed `protocol_types`) | REMOVED | Drop the gate; the aggregated debug log (Q30) is unconditional. TCP traces carry no ACK frames anyway. |
| `vantage_point.type` / `flow` (`isClientSideTrace`) | `? vantage_point`, same values | SAME | DEAD; not ported. |
| (none) | `group_id` | — | The data model makes one connection per group (data-model §3.16.5). The view plots one connection. |
| (none) | `tuple` (main-14:877, common or per event; quic-go writes it inside `data`) | NEW, not consumed | §9.9 |
| (none) | `event_schemas`, `system_info`, `reference_time.wall_clock_time` | NEW, not consumed | — |

### 9.9 Packet-number spaces and matching keys (Q3 under the latest drafts)

qvis keys sent packets by `header.packet_type` (§3.3). The drafts still do not log the PN space on packet events, but
they define it (quic-13 §8.7, :2594) and use it explicitly on `packets_acked` and `timer_updated`:

```ts
// Q3 FIX: one key per packet number space (quic digest §11).
function pnSpace(packetType: unknown): string {
  switch (packetType) {
    case "initial":   return "initial";
    case "handshake": return "handshake";
    case "0RTT":
    case "1RTT":      return "application_data";
    default:          return String(packetType);   // retry, version_negotiation, stateless_reset, unknown, custom, "undefined"
  }
}
// sentByKey: Map<string /* pnSpace */, Map<string /* pnKey */, CgPacket>>
```

| Source | Key |
|---|---|
| Sent packet (E1) | `pnSpace(header.packet_type)` and `pnKey(header.packet_number)` |
| ACK frame in a received packet (E2) | `pnSpace(` **carrying** packet's `header.packet_type)` and each acked PN |
| Lost packet (E3) | `pnSpace(header.packet_type)` and `pnKey(header.packet_number)` |
| `packets_acked` (E6) | `packet_number_space ?? "application_data"` (the same three strings `pnSpace` produces) and `pnKey(pn)` |

- **The tuple is not part of the key.** RFC 9000 connection migration keeps one PN space per space across paths, so
  an ACK received on a new path acknowledges packets sent on the old one. Keying by `tuple` would lose those
  matches.
- **Multipath is not supported.** Multipath QUIC (separate PN spaces per path) is outside quic-events-13; in such
  traces, ACKs could match the wrong path's packets. Byte ranges stay one cumulative counter across all tuples
  (PARITY).
- `retry`, `version_negotiation` and `stateless_reset` packets never have a PN. They are plotted if sized and never
  matched.

### 9.10 Inputs with no latest-draft equivalent

| Old input | Why it is gone | Proposed behaviour |
|---|---|---|
| `packet_lost.raw.length` (tooltip size) | `QUICPacketLost` has no `raw` | Q25: show the matched sent packet's size. |
| `metrics_updated.cwnd` | pre-draft-01 member; -13 has only `congestion_window` | Not read (Q33). No derivation from other events. |
| `parameters_set.owner` | renamed `initiator` in quic-events-12 | Not read. |
| `header.packet_size` | moved to `raw.length` in draft-02 | Not read. The packet is unsized and DM2 reports it. |
| `configuration.time_units`, `configuration.time_offset` | removed in main-schema-06 | Constant 1 and 0. |
| `common_fields.protocol_type` (`"TCP"` gate) | removed in main-schema-11 (`event_schemas` replaces it) | The gate is dropped. Converter TCP traces work through `transportNamespace` (data-model §9.10). |
| category-based disambiguation of `transport:parameters_set` vs. `recovery:parameters_set` | the drafts use distinct event names | Lookup by full name (E5). |
| `metrics_updated.in_recovery`, `max_ack_delay`; packet `is_coalesced` | removed (never read by this view) | Nothing to do. |
| a dedicated spurious-loss signal (quic-go's non-standard `recovery:spurious_loss`) | not defined by -13 | Not consumed. A spuriously lost packet shows green and red (PARITY). |

### 9.11 New in the latest drafts: what this view could show

| New item (draft reference) | What it could add | Recommendation |
|---|---|---|
| `quic:packets_acked` (quic-13:1383) | ACKs for traces without ACK frames. main-14:1964-1967 tells producers that skip `packet_received` to log it. | **Adopt as a fallback only** (Q37, §9.4.1). |
| `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed` (quic-13:1695-1755; `frames_processed` is removed in the editor's copy) | ACK, MAX_DATA and MAX_STREAM_DATA frames logged outside the packet events, linked by `packet_numbers[i]` | **DECISION Q43, recommended PARITY (ignore).** |
| Sizes derived from `raw.data` (main-14 §11.4) | packets logged with `raw.data` but no `raw.length` | **Adopt** (Q44, NEW). |
| `ssthresh`, `pacing_rate`, `packets_in_flight`, `rtt_variance`, `pto_count` on `quic:recovery_metrics_updated` | an ssthresh step line on the right axis, pacing rate, an RTT-variance band | **DECISION Q46, recommended PARITY (do not plot).** None of them is new; all were in draft-02, and qvis chose not to show them. Extra series would change the legends and the pixels. |
| `quic:congestion_state_updated` (`new`, `trigger`) | slow-start / recovery bands | Q46: not shown. |
| `quic:connection_data_blocked_updated`, `quic:stream_data_blocked_updated`, `quic:datagram_data_blocked_updated` (Extra; reasons include `congestion_control`, `pacing`, `connection_flow_control`, `stream_flow_control`, `amplification_protection`) | markers that explain flat stretches of the sent curve | Q46: not shown. data-model N10 offers a hook. |
| `quic:parameters_restored` (quic-13:1125) | initial flow-control limits for 0-RTT client traces | DECISION Q45, recommended PARITY. |
| `quic:recovery_parameters_set` (`initial_congestion_window`, `minimum_congestion_window`, `max_datagram_size`, `initial_rtt`) | the cwnd starting value, a minimum-cwnd reference line | Q46: not shown. |
| `is_mtu_probe_packet` on `packet_sent` / `packet_lost` | telling probe losses apart from congestion losses | Q46: not shown; probe losses stay red. |
| `packet_sent.trigger` (`retransmit_reordered`, `retransmit_timeout`, `pto_probe`, `retransmit_crypto`, `cc_bandwidth_probe`) and `packet_lost.trigger` | the reason in the tooltip | Not shown: the tooltip text is PARITY. |
| `tuple`, `quic:tuple_assigned` (replaces `path` / `path_assigned`), `quic:migration_state_updated` | per-path colouring | **No** (§9.9). |
| `datagram_id` / `datagram_payload_checksum`, `quic:udp_datagrams_*` | coalescing information | **No.** Each coalesced packet has its own `raw.length`; adding UDP payload sizes would count bytes twice. |
| New frames: `reset_stream_at` (`reliable_size`), `datagram`, `handshake_done`; extension frames `ack_frequency`, `immediate_ack`; ACK `ect0` / `ect1` / `ce` | ECN-CE congestion marks; reliable-reset markers | Not shown. Their bytes already count through the packet's `raw.length`. |
| `http3:*`, `http:*` | — | Not relevant to this view. |

### 9.12 Decisions raised by this mapping

| ID | Topic | Decision |
|---|---|---|
| Q41 | Empty-state notice when names are strict | **DECISION (recommended NEW; extends and supersedes the Q38 texts).** Show an inline Bootstrap `alert-info` below the buttons (the Q38 position). With `ns = conn.transportNamespace`, the first matching rule wins: (1) no `<ns>:packet_sent` events, and the connection's lookup table has `transport:packet_sent`: `This trace has no quic:packet_sent events. It logs packets as transport:packet_sent, a pre-standard event name that qvis does not support, so there is nothing to plot.` (2) no `<ns>:packet_sent` events: `This trace has no <ns>:packet_sent events, so there is nothing to plot.` (3) none of them has a size: `This trace has no <ns>:packet_sent events with a size (raw.length); there is nothing to plot.` (4) some lack a size: `<N> <ns>:packet_sent events have no raw.length and were not plotted.` Rules 1 and 2 also cover a trace whose other events are all non-conforming; DM3 names them at file level. |
| Q42 | Which transport parameter seeds the stream flow-control line | **PARITY (documented quirk).** qvis uses the peer's `initial_max_stream_data_bidi_remote`. Under RFC 9000 §18.2 that is the limit for bidirectional streams opened by the **receiver** of the parameter, i.e. by us. In server traces (the main use case), response data flows on **client**-opened request streams, which the client's `initial_max_stream_data_bidi_local` governs. The first point of the pink line can therefore show the other parameter. It is often numerically equal: quic-go sets both to 524288 in the fixtures. Keep `bidi_remote`. |
| Q43 | `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed` | **DECISION, recommended PARITY (ignore).** qvis ignored `transport:frames_processed`. No surveyed producer logs ACK frames only there. The PN space would have to be guessed: `packet_numbers` carries none, and frame events "omit information that is available in the packet_received or packet_sent event", such as the encryption level (quic-13:1685-1688). If adopted later: use data-model N3 `framesForPacket("received", "application_data", pn)` only for `quic:packet_received` events that have no `frames`, and keep the packet_received time as the ACK and flow-control time. |
| Q44 | Packet size from `raw.data` | **NEW (adopt).** main-14 §11.4 says tools SHOULD derive the length from the value when the length member is absent. `rawByteLength()` already implements this. It does not affect files that log `raw.length`. |
| Q45 | `quic:parameters_restored` as a seed for the flow-control lines | **DECISION, recommended PARITY (ignore).** In 0-RTT client traces, the lines start at the first remote `parameters_set`, as in qvis. |
| Q46 | Further recovery and blocking data (`ssthresh`, `pacing_rate`, `congestion_state_updated`, `*_data_blocked_updated`, `recovery_parameters_set`, `is_mtu_probe_packet`, triggers) | **DECISION, recommended PARITY (not shown).** The legends, colours and tooltip texts stay exactly as in qvis. |
| Q47 | uint64 values as JSON strings | **FIX.** Convert once with `toNumber()`, test presence with `has()`, key maps with `pnKey()` (§9.1). This is invisible for numeric input. It removes qvis's string-comparison and `"0"`-truthiness hazards. |

### 9.13 Cross-spec flags

- **F1: `packetLength()` fallbacks.** ecosystem §6.5 and §6.6 define `packetLength()` with fallbacks to
  `header.packet_size` and `header.length`. That conflicts with ARCHITECTURE §3.1 and with data-model §9.6 and §9.9,
  which say `header.length` is never a size. This view uses `packetSize()` (§9.3). Any shared helper should follow
  §9.3.
- **F2: aliasing.** quic digest §15, ecosystem §6.4-§6.6, app-shell §9.1 rule 1 and app-shell §9.12 F2 assume a
  load-time alias pass. ARCHITECTURE §3.1, which is binding, removed it, and so did data-model §9.1. This spec follows
  ARCHITECTURE. The app-shell owner should revisit app-shell §9.
- **F3: test fixtures.** `tests/fixtures/quic-go/*.sqlog` are non-conforming (pre-final names), so the positive e2e
  of §8.8 needs the conforming `tests/fixtures/latest/` regeneration.
- **F4: `raw.length` for long-header packets.** quic-13:2618-2621 (and ed:1877-1879) say `raw.length` is "the
  length of the packet number plus the payload" for long-header packets. The generic RawInfo definition
  (main-14:2213-2215) says it is the full entity length, including headers and trailers. This view sums `raw.length`
  as logged. Worth raising upstream.
- **F5: data-model hooks.** This view uses data-model N2 (`packets_acked`, Q37) only. N3 (Q43), N5 and N10 (Q46) and
  N8 (Q45) stay unused by default.
- **F6: converters.**
  - The netlog converter's T1 `quic:packet_lost` (`packet_type: "unknown"`) cannot be matched (§9.5); converters T3
    fixes that.
  - The TCP converter must keep `raw.length` (TCP header + payload) and `header.packet_type: "1RTT"` /
    `packet_number` on `tcp:packet_*`, which is what plotting needs.
  - The TCP converter must not emit `ack` frames there (its "1RTT" PNs are capture frame numbers).

### 9.14 Test vectors (add to `model.test.ts`)

All inputs are abridged. They are latest-draft traces with a monotonic clock (case U) unless noted.

1. **Non-conforming names.**
   - Input: `transport:packet_sent {header:{packet_type:"1RTT",packet_number:0}, raw:{length:1200}}` and
     `recovery:metrics_updated {congestion_window:40960}`.
   - Expected: `packets = []`, no cwnd series, Q41 rule 1 text.
2. **Sizes** (E1):
   - `raw.length` of `1252` or `"1252"` gives 1252.
   - `0` and `"0"` are skipped (`skippedSent` +1 each).
   - `{raw:{data:"00ff10"}}` gives 3 (Q44).
   - `header.packet_size: 1252` without `raw` is skipped.
   - `{raw:{length:1200,payload_length:1170}, header:{packet_type:"initial",packet_number:0,length:1180}}` gives 1200.
3. **ACK ranges** in a `1RTT` received packet, against sent 1RTT PNs 1..5:
   - `[[2,3]]` and `[["2","3"]]` ack 2 and 3.
   - `[[3,2]]` acks nothing.
   - `[[5]]` and `[[5,5]]` ack 5.
   - `[[1,2,3]]` acks only 1 (qvis's rule).
   - `[[]]` acks nothing.
4. **PN spaces** (Q3):
   - Sent `0RTT` PNs 0 and 1 plus `1RTT` PN 2; a received `1RTT` packet with ACK `[[0,2]]` acks all three.
   - Sent `initial` PN 0 and `1RTT` PN 0; a received `initial` packet with ACK `[[0]]` acks only the Initial.
5. **`packets_acked` fallback** (Q37):
   - No ACK frame anywhere, plus `quic:packets_acked {packet_numbers:[0,1]}`: PNs 0 and 1 of `application_data` are
     acked at that event's time, and the tooltip's second line is `PacketNr:  ?`.
   - With one ACK frame anywhere in the trace, `packets_acked` is ignored.
6. **Losses:**
   - `{header:{packet_type:"1RTT",packet_number:0}}` matches PN 0.
   - `{header:{packet_type:"1RTT",packet_number:"4"}}` matches PN 4.
   - `{}`, `{header:{packet_number:4}}` and mvfst's `{largest_lost_packet_num:4,lost_bytes:1200,lost_packets:1}` are
     skipped.
   - The loss tooltip size equals the sent packet's size (Q25).
7. **Metrics:**
   - `{congestion_window:"40960"}` gives the cwnd point 40960 (a number).
   - `{cwnd:40960}` gives no point.
   - `{pto_count:1}` gives no point in any series.
   - `{bytes_in_flight:0}` gives a point at 0 (Q2).
   - `{min_rtt:40.2}` gives 40.2 (no scaling).
8. **Parameters:**
   - `{owner:"remote",initial_max_data:100}` gives nothing.
   - `{initiator:"remote",initial_max_data:"786432"}` gives an application flow-control point at 786432.
   - `{initiator:"local",initial_max_data:1}` gives nothing.
   - `{initiator:"remote",initial_max_data:0}` gives a point at 0 (Q2).
9. **Stream IDs:** MAX_STREAM_DATA with `stream_id` `4`, then `"4"`, is one map entry, so the sum counts it once.
10. **Start offset:**
    - Case U (monotonic) with a first raw time of 123456789.1 (mvfst-like): `relativeTime` 0, offset 0.
    - Case R (`epoch: "2026-11-01T00:00:00Z"`, first time 5000): offset −4800.
11. **Converter TCP trace:** three `tcp:packet_sent` events with `raw.length`, and `common_fields.protocol_type:
    "TCP_HTTP2"`. All three are plotted, with no ACKs.

---

## 10. Same-data parity check against hosted qvis (results and decisions)

Method. Hosted qvis (`https://qvis.quictools.info`) loads the draft-02 conversion of each demo
(`tests/fixtures/legacy/<scenario>.draft02.qlog`); qvis-react loads the latest-draft original **through the same
upload control under the same file name**, so the trace picker shows identical labels and wraps identically (loading via
`?file=` labels the file "Loaded via URL (…)", which wraps differently and moved the whole page 24 px down; that is a
test artifact, not a layout difference). Both apps run in Chromium at 1600×1000; for pixel comparisons of the plots
qvis-react runs at 1610 px so that its plot has qvis's width (1460 px, FIX Q19). Scenarios: `new_cid`,
`10_parallel_streams`, `doublevantage_100ms`, `multistream_loss`, `baseline` (client and server) and `massive_server`.
Compared: bounding boxes, texts and computed styles of every element of the view (246 elements), axis ticks (text and
position), both canvases pixel by pixel, the hover tooltip (text, HTML, position, ack arrow) at sent / ACK / loss / line
pixels before and after zooming, wheel zoom at a cursor position, drag pan, Zoom timerange, Zoom area (also a click
without drag), Reset zoom, both toggles, the ruler (button and `R`), legend hover, button tooltips (geometry, flip,
style), button focus states, trace switch with an armed brush and a shown tooltip, remount, wheel over the RTT graph,
window resize and the no-file state, with console errors and page errors collected in both apps.

Result. With the zero-valued metrics removed from the input (qvis ignores them, FIX Q2 draws them), the main and RTT
canvases are pixel-identical in all eleven traces, initially and after every zoom, pan, brush, reset and toggle; all
axis ticks, tooltips, ack arrows, ruler lines and texts, layer z-indexes, legends and the vertical layout (configurator
panel included) are identical. qvis-react logs no console error or warning; qvis throws its known TypeErrors (Q8 on
brush clear and click, Q10 before a render).

Fixed in this check (each with a regression test):

| Area | qvis | qvis-react before | Now |
|---|---|---|---|
| RTT zooming on a zoomed window that contains RTT samples | `[min − 10, max + 10]` of the samples in the window | also mixed in the values carried into the window, so the RTT axis differed (e.g. 42.4–71.9 vs 44.0–71.9 ms) | as qvis; carried values only for an empty window (Q4) |
| Button tooltip near the top of the viewport | flips below the button (Popper 1 `flip`, 5 px padding) | stayed above, partly off-screen | flips like qvis |
| Button tooltip geometry and type | Bootstrap 4: the `.tooltip` box carries 0.4 rem arrow padding, touches the button, top rounded; BS4 font stack; z-index 1070 | 0.6 px lower (Popper 2 offset 6, adaptive bottom anchoring), BS5 font stack, z-index 1080 | identical boxes and styles (`HoverTooltipButton`; now the shared `useHoverTooltip` + `.qvis-tooltip`, app-shell A9) |
| Button tooltip timing | `v-b-tooltip` default `delay: 50` (show and hide), then the Vue transition: the fade-in starts ~90 ms after mouseenter, the fade-out ~90 ms after mouseleave (150 ms linear); a quick sweep over the buttons shows no tooltip | shown and hidden at once, so a sweep flashed tooltips | 50 ms delay plus one frame; fade timings within a frame of qvis |
| Focus ring of a clicked button | BS 4.3.1 draws the grey ring on `:focus`, so it stays around the last clicked button; focus keeps the normal colours | no ring after a mouse click (BS5 `:focus-visible`), hover colours on keyboard focus | as qvis (first scoped to `.cg-configurator`; now the app-wide `.btn:focus` rules in `global.css`, app-shell A7) |
| Ruler coordinates | `evt.offsetX/offsetY`: whole pixels | `d3.pointer`: fractional (the plot sits at page y 381.59), legs blurred and ≤ 1 px off | `offsetX/offsetY` (Q9 row) |
| Right axis after a window resize | (no re-layout) | labels and frame stayed at the old width: invisible after narrowing | re-rendered on re-layout (Q19 row) |

Remaining differences, all intended or caused by the draft-02 conversion:

| Difference | Verdict |
|---|---|
| Plot 10 px narrower at the same window width; no 5 px horizontal page overflow; the graph re-lays out on resize | FIX Q19 |
| Bytes-in-flight line drops to 0 at the bottom of the plot where the trace logs `bytes_in_flight: 0`; the sent tooltip shows `In flight: 0 bytes` | FIX Q2 |
| Sent tooltip shows `CWND: …` (and the other metrics) for packets sent after the last update of that metric, e.g. every client packet when the client logs one cwnd | FIX Q11 |
| Loss tooltip `PacketSize: <size of the sent packet>` instead of `PacketSize: unknown` | FIX Q25 |
| One `g.brush` per brush layer instead of one more per render | FIX Q26 (invisible) |
| The very first pan step of the renderer's life is not swallowed | Q20 (invisible) |
| No TypeErrors on brush clear / click without drag / buttons before a render | FIX Q8, Q10 |
| Ruler elements carry `pointer-events: none`; a mouseup outside the plot ends the ruler | FIX Q9 |
| Trace-picker panel: `position` of the column divs (BS4 `.col` relative vs static) and `display` of the select (inline-block vs block) | shared `ConnectionConfigurator` (app-shell); no visible effect, same boxes |

