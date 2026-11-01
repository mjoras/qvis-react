# Parity spec: multiplexing graph (`#/multiplexing`)

Source of truth: qvis `visualizations/` at commit `3db6acf`. All `path:line` citations are relative to
`visualizations/` of [quiclog/qvis](https://github.com/quiclog/qvis)
unless they are absolute. The original runs on d3 5.12.0 (d3-zoom 1.8.3), bootstrap 4.3.1, bootstrap-vue 2.0.4 and vue 2.6.10.

Files read in full:

- `src/views/MultiplexingGraph.vue` (17 lines)
- `src/components/multiplexinggraph/MultiplexingGraphContainer.vue` (32)
- `src/components/multiplexinggraph/MultiplexingGraphConfigurator.vue` (127)
- `src/components/multiplexinggraph/MultiplexingGraphRenderer.vue` (99)
- `src/components/multiplexinggraph/MultiplexingGraphCollapsedRenderer.vue` (195). Despite its name, this is the
  per-trace panel that hosts all three charts.
- `src/components/multiplexinggraph/data/MultiplexingGraphConfig.ts` (9)
- `src/components/multiplexinggraph/renderer/MultiplexingGraphD3CollapsedRenderer.ts` (744)
- `src/components/multiplexinggraph/renderer/MultiplexingGraphD3WaterfallRenderer.ts` (532)
- `src/components/multiplexinggraph/renderer/MultiplexingGraphD3ByterangesRenderer.ts` (256)
- `src/components/multiplexinggraph/renderer/MultiplexingGraphD3SimulationRenderer.ts` (256)
- `src/components/multiplexinggraph/renderer/MultiplexingGraphDataHelper.ts` (13)
- Imported dependencies: `src/components/shared/ConnectionConfigurator.vue`, `src/components/shared/helpers/ColorHelper.ts`,
  `src/data/Connection.ts`, `src/data/ConnectionGroup.ts`, `src/data/QlogEventParser.ts`, `src/data/QlogLoaderV2.ts`
  (`DirectEventParser`), `src/data/QlogSchema02.ts` (enums used), `src/store/ConfigurationStore.ts`, `src/App.vue`,
  `src/router.ts`, `public/index.html`

Cross-references, which this document does not repeat:

- `docs/dev/parity/app-shell.md`: `ConnectionConfigurator` (§2.5), the auto-selection rule and `NoTraceAlerts` (§2.5.7),
  ColorHelper (§3.7), Bootstrap 4 to 5 overrides (§8.7), and the quirk list Q1-Q34 (Q11, Q12 and Q20 apply here).
- `docs/dev/qlog-spec/h3-events.md` §10.6.1-10.6.2 and `quic-events.md` §4.15: field mapping for this view. §9 of
  this document is the complete, normative mapping to the latest drafts.
- `docs/dev/qlog-spec/ecosystem.md` §6.6: accessor helpers (`streamFrameDataLength`, `u64`, `fieldName`, `fieldValue`).
- `docs/dev/ARCHITECTURE.md` §4: React and D3 conventions.

Labels used throughout:

- **PRESERVE**: reproduce exactly, including visible text, layout and behaviour.
- **FIX**: a qvis bug or hazard. The React version deliberately deviates; the qvis behaviour is still described.
- **NEW**: required because qvis-react accepts only the latest qlog drafts (main-schema-14, quic-events-13,
  h3-events-13).
- **DECISION**: needs a product decision. A recommended default is given.

---

## 1. Overview and user-facing purpose

The "Multiplexing" tab (`#/multiplexing`; the active tab color is `#d1ecf1`) shows how a QUIC + HTTP/3 connection
interleaves (multiplexes) the response data of its concurrent request streams. It answers three questions:

- In which order and how interleaved did the data of each request arrive?
- Were there retransmissions, reorderings, duplicates, or gaps (out-of-order "future" data)?
- When was each request sent, and when did its data start and stop flowing?

The page has a configurator (the trace picker plus two checkboxes) and, below it, one panel per selected trace. Each
panel stacks up to three charts that share one horizontal axis: the **count of STREAM frames in the data direction**.
The axis counts frames, not time and not bytes; every STREAM frame gets the same width.

1. **Waterfall** (optional, "Show waterfall"; on by default). One horizontal bar per request stream, in request order
   from top to bottom. A bar spans from the first to the last data frame of its stream. A circle marks when the
   request was sent, a square marks the HTTP/3 HEADERS frame, and a triangle marks a PRIORITY_UPDATE frame. Clicking a
   bar shows a "Selected stream's details" text line above the charts and switches the byte-range chart to that
   stream.
2. **Multiplexed data flow** (always shown; internally the "collapsed" renderer). A single 70 px strip with one colored
   rectangle per STREAM frame, colored by stream ID, in arrival order. Under each frame, a small colored marker
   classifies how the frame arrived:
   - black: retransmission (fills an old gap)
   - blue: reordering (fills a recent gap)
   - red: duplicate
   - purple: "future" (creates a gap)

   Hover shows a tooltip. The mouse wheel and drag zoom and pan horizontally (up to 30x). Clicking a frame switches the
   byte-range chart to that frame's stream.
3. **Byterange per STREAM frame** (optional, "Show byte ranges"; on by default). For one selected stream (initially
   stream 0), it plots each frame's byte range: x is the frame index and y is the byte offset, top to bottom. It also
   draws translucent "pingback" bands and black "data moved to the application" markers. It follows the zoom of the
   data-flow strip and auto-fits its Y axis to the visible window.

A fourth renderer, the **simulation renderer** ("Simulated FIFO order"), exists in the source but is **never shown**:
its row is `display: none` and its renderer is never constructed (§3.9, §7 M1).

Only **request streams** are considered: stream IDs with `id % 4 === 0`, i.e. client-initiated bidirectional streams.
The control stream, the QPACK streams and push streams are ignored.

**Direction.** For a client trace, "data" means STREAM frames in `packet_received` and "requests" means
`packet_sent`. For a server trace this is reversed. qvis treats every non-`server` vantage point (client, network,
unknown) as a client; §7 M21 covers this.

**Multi-trace mode.** With `?multimultiplexing=true` in the URL (or on any `localhost` or `:8080` URL), a button "Load
all connections at once" renders one panel per trace of every loaded file, in series and sorted by file name. This
mode is for comparing many runs (it was used for paper results).

---

## 2. UI inventory and interactions

### 2.1 Page DOM (bootstrap-vue rendered to Bootstrap 4 HTML)

```html
<div>                                                     <!-- views/MultiplexingGraph.vue -->
  <div class="home">                                      <!-- MultiplexingGraphContainer.vue:2 -->
    <!-- Configurator (MultiplexingGraphConfigurator.vue:2-38) -->
    <div style="background-color: #d1ecf1; padding: 0px 10px;">
      <div class="container-fluid">
        <div class="row justify-content-center">
          <p style="margin-top: 10px;">Select a trace via the dropdown(s) below to visualize it in the stream graph</p>
        </div>
        <div class="row justify-content-center">
          <!-- ConnectionConfigurator, only if config.connections.length > 0 -->
        </div>
        <div class="row justify-content-center">
          <div class="custom-control custom-checkbox mr-3">
            <input id="waterfall-checkbox" name="waterfall-checkbox" type="checkbox" class="custom-control-input" value="true">
            <label for="waterfall-checkbox" class="custom-control-label">Show waterfall</label>
          </div>
          <div class="custom-control custom-checkbox">
            <input id="byteranges-checkbox" name="byteranges-checkbox" type="checkbox" class="custom-control-input" value="true">
            <label for="byteranges-checkbox" class="custom-control-label">Show byte ranges</label>
          </div>
          <!-- only if allowSelectAll -->
          <button type="button" class="btn ml-3 btn-primary" [disabled]>Load all connections at once</button>
        </div>
        <!-- one of the two shared alerts, see 2.3 -->
      </div>
    </div>
    <!-- Renderer (MultiplexingGraphRenderer.vue:2-35) -->
    <div>
      <div class="container-fluid">
        <div class="row align-items-center">
          <div class="col-6"><div id="multiplexing-stats" style="width: 100%;"></div></div>
          <div class="col-6"><div id="multiplexing-stats-streams" style="width: 100%;"></div></div>
        </div>
      </div>
      <!-- one per config.connections[i], key = index; see 2.4 -->
      <div id="multiplexingToplevelContainer" class="container-fluid" style="width: 100%; border: 5px solid #d1ecf1;"> ... </div>
      <div id="multiplexing-packet-tooltip"></div>
    </div>
  </div>
</div>
```

Global CSS that applies (`App.vue:16-22`, Bootstrap 4 defaults):

- `#app`: `font-family: 'Avenir', Helvetica, Arial, sans-serif; text-align: left; color: #2c3e50`
- body: 16 px, line-height 1.5

Every text below inherits these unless noted. D3 axes draw with `currentColor`, so axis lines and labels are
**`#2c3e50`**, not black.

### 2.2 Configurator (`MultiplexingGraphConfigurator.vue`)

Container: inline style `background-color: #d1ecf1; padding: 0px 10px;`, holding a `container-fluid` (15 px
horizontal padding). Scoped CSS (`:41-49`):

```css
.row { padding-bottom: 10px; }   /* applies to the three rows in this template */
.btn { margin: 0px 5px; }        /* the select-all button; its ml-3 (margin-left: 1rem !important) wins on the left */
```

Rows, top to bottom; all are `row justify-content-center`, i.e. flex, centered, wrapping:

1. A `<p style="margin-top: 10px;">` with the verbatim text **`Select a trace via the dropdown(s) below to visualize
   it in the stream graph`**. The p's default `margin-bottom: 1rem` applies.
2. `ConnectionConfigurator` (app-shell §2.5), only when `config.connections.length > 0`. Props:
   `allGroups = store.groups`, `connection = config.connections[0]`, `canBeRemoved = false`, and `onConnectionSelected`.
   The callback sets `config.connections = [connection]` (`:74-78`), which also leaves multi-trace mode. It renders as
   one white, bordered column (max 50% wide), centered, in combined-select or separate-select mode.
3. Two bootstrap-vue custom checkboxes and an optional button, in this order:

   | Element | id / name | Label (verbatim) | Bound to | Default | Classes |
   |---|---|---|---|---|---|
   | checkbox | `waterfall-checkbox` | `Show waterfall` | `config.showwaterfall` | `true` | `mr-3` |
   | checkbox | `byteranges-checkbox` | `Show byte ranges` | `config.showbyteranges` | `true` | none |
   | button (`variant="primary"`) | none | `Load all connections at once` | click: `selectAllConnections()` | rendered only if `allowSelectAll`; `disabled` when `config.connections.length === 0` | `ml-3` |

   Flex `align-items: stretch` makes the checkbox blocks as tall as the button (38 px) when the button is present. The
   checkbox labels therefore sit at the top of that 38 px line and are not vertically centered against the button.
   **PRESERVE.**
4. The alerts (2.3), placed directly in the container and not in a row.

`allowSelectAll` (`:80-85`) is true if `window.location.toString()` contains `":8080"`, `"localhost"` or
`"multimultiplexing"`. It is a class getter, so Vue caches it as a computed property for the lifetime of the
configurator instance.

### 2.3 Empty and loading states (shared alerts)

Inside the configurator container (`:33-34`), as in every tool (app-shell §2.5.7, `<NoTraceAlerts/>`):

- `store.outstandingRequestCount === 0 && store.groups.length === 0`:
  `<div role="alert" class="alert alert-danger">Please load a trace file to visualize it</div>`
- otherwise, if `store.groups.length === 0`: `<div class="alert alert-warning">Loading files...</div>`

With no files loaded, `config.connections` is `[]`, so the renderer area holds only the empty stats row and the
tooltip div; no panel is rendered.

### 2.4 Per-trace panel (`MultiplexingGraphCollapsedRenderer.vue`)

Root: `container-fluid`, `id="multiplexingToplevelContainer"` (the same id for every panel; see M27). Its inline style
merges `width: 100%;` from the component with `width: 100%; border:5px solid #d1ecf1;` from the parent. With Bootstrap
`box-sizing: border-box`, `clientWidth = parentWidth − 10`.

Consecutive panels each have their own 5 px border, which forms a 10 px `#d1ecf1` band between panels.

Rows, top to bottom (Bootstrap 4 classes):

| # | Row markup | Shown when | Height | Column 1 (`col-1`) label, verbatim | Column 2 |
|---|---|---|---|---|---|
| a | `row align-items-center`, style `text-align: center;` | always | auto (h4: 1.5 rem, line-height 1.2, `margin-bottom: .5rem`, weight 500, about 36.8 px in total) | none; a single `col-12` | `<h4>`, see below |
| b | `row align-items-center`, style `width: 100%;` | a stream was clicked in the waterfall (`streamDetail !== null`) | auto | `Selected stream's details` | `col-11`: stream detail text (2.7) |
| c | `row align-items-center`, style `height: 165px; width: 100%;` | `showwaterfall` | 165 px | `Waterfall` | `col-11` → `<div style="width: 100%; height: 165px; overflow-y: auto;">` → `<div id="multiplexing-waterfall-NNNNN">` (the waterfall SVG) |
| d | `row`, style `height: 5px;` | always | 5 px | none | none |
| e | `row align-items-center`, style `height: 70px; width: 100%; border: 1px solid red; display: none;` | **never visible** | 0 | `Simulated FIFO order` | `col-11` → `<div id="multiplexing-fifo-NNNNN" style="width: 100%;">`, always empty |
| f | `row`, style `height: 5px;` | always | 5 px | none | none |
| g | `row align-items-center`, style `height: 110px; width: 100%;` | always | 110 px | `Multiplexed data flow` | `col-11` → `<div id="multiplexing-data-NNNNN" style="width: 100%;">` (the data-flow SVG, 110 px tall) |
| h | `row align-items-center`, style `height: 520px; width: 100%; margin-bottom: 10px;` | `showbyteranges` | 520 px, plus a 10 px margin | `Byterange per STREAM frame` | `col-11` → `<div id="multiplexing-byterange-NNNNN" style="width: 100%;">` (the byte-range SVG, **540 px** tall) |

Details:

- The `h4` text (`:5`) is `connection.parent.filename + " : " + connection.getLongName()`, or `""` when `connection` is
  undefined. `getLongName()` is identical to app-shell's `connectionLabel()`. Example:
  `parallel_10_50KB_f5.qlog : aioquic : client : ` (note the trailing `" : "` when the trace has no title).
- The `col-1` labels are plain body text: 16 px, left-aligned, vertically centered, and wrapping because the column is
  narrow.
- Row h: the 540 px SVG in a 520 px `align-items-center` row overflows by 10 px at the top (into row g) and 10 px at the
  bottom (into the 10 px margin). **PRESERVE** by keeping the same sizes.
- Element ids: `NNNNN` = `Math.round(Math.random() * 100000)`, computed once per component instance
  (`:98-115`; class getters are cached computed properties). The id is shared by the fifo, waterfall, data and
  byterange divs of one panel.

Vertical size with everything visible and no detail row: 36.8 + 165 + 5 + 5 + 110 + 520 + 10 ≈ 852 px, plus 10 px of
borders.

### 2.5 Chart widths (`MultiplexingGraphCollapsedRenderer.vue:158-169`)

All three charts must have exactly the same width. Before every render:

```ts
const C = document.getElementById("multiplexingToplevelContainer").clientWidth;   // the first panel's, see M27
const fixedWidth = Math.ceil((C - 90) * 0.9075) + "px";
dataDiv.style.width = fixedWidth;
if (showwaterfall)  waterfallDiv.style.width = fixedWidth;
if (showbyteranges) byterangeDiv.style.width = fixedWidth;
```

The source comment explains the constants: 15 px padding on each side of each column and the container gives 90; the
first column is 1/12; then 99% of the remaining 11/12 gives 0.9075.

Each renderer then computes its inner drawing width from its container:
`W = container.clientWidth − margin.left − margin.right = fixedWidth − 20 − 40 = fixedWidth − 60`.
The left margin is 20 and the right margin 40 for all three charts, so the chart areas line up horizontally.

Worked example: a 1920 px viewport with a vertical page scrollbar (body ≈ 1905 px) gives `C = 1895`,
`fixedWidth = ceil(1805 × 0.9075) = 1639 px` and `W = 1579 px`.

There is **no window-resize handling**. Widths are recomputed only when the panel re-renders (§2.9). **PRESERVE.**

### 2.6 Shared tooltip (`#multiplexing-packet-tooltip`, `MultiplexingGraphRenderer.vue:33`)

A single empty `<div>` placed after all panels and shared by all of them. On every data-flow render, D3 sets
(`MultiplexingGraphD3CollapsedRenderer.ts:127-132`):

```
opacity: 0; position: absolute; padding: 5px; pointer-events: none; background: lightsteelblue;
```

There is no z-index, border, radius or font rule, so the text inherits 16 px Avenir in `#2c3e50`. The containing block
is the initial containing block, so `left` and `top` are page coordinates. Before the first render the div is an
unstyled, zero-height block.

Behaviour (data-flow strip only; the waterfall and byte-range charts have no tooltips):

- **mouseover** on a frame rect: transition opacity to `.95` over 100 ms (d3 default easing, cubic-in-out). Set the
  innerHTML immediately to the text below and set `left = pageX + 15 px`, `top = pageY − 75 px`. There is no
  mousemove handler, so the tooltip stays where the pointer entered the rect.
- **mouseout**: transition opacity to `0` over 200 ms.

Tooltip text, verbatim (`:579-589`), with `<br/>` as a line break:

```
{time}ms : stream {streamID} : packet number {packetNumber}<br/>
[{offset}, {offset + length - 1}] (size: {length})
```

followed by one of:

- if the arrival type is Retransmit or Reordered: `<br/>Fills gap that was created {arrivalTimeDifference}ms ago`
- else, if the frame created a hole: `<br/>Creates gap from {hole[0]} to {hole[1]} (size: {hole[1] - hole[0]})`
- otherwise nothing more

`{time}` and `{arrivalTimeDifference}` are raw JS numbers converted with `String(n)`, not `toFixed`, so float noise
is possible; see M22. `{packetNumber}` is the raw `data.header.packet_number`, printed as `undefined` if missing.

Example: `359ms : stream 4 : packet number 12` / `[1200, 2399] (size: 1200)` / `Fills gap that was created 31ms ago`.

The arrival-type marker rects (black, blue, red, purple) sit below the frame rects (y 49 to 68.25) and have no
handlers, so hovering a marker shows no tooltip. Moving from a frame onto its marker fires the frame's mouseout, which
fades the tooltip.

### 2.7 Stream detail line (`MultiplexingGraphCollapsedRenderer.vue:8-21`, `:140-148`)

Shown after a click on a **waterfall bar** (not on a marker, and not on the data-flow strip). Template, verbatim. Vue
condenses whitespace to single spaces; `{x|2}` means `x.toFixed(2)`:

```html
<div>
  <span style="display:inline-block; padding-right:10px; width:50px; height:100%; background-color:{color}">&nbsp;</span>
  Stream <span class="font-weight-bold">{stream_id}</span> : Requested at {requestTime|2}ms. Transmitted from {startTime|2}ms to {endTime|2}ms ({(Number(endTime|2) − Number(startTime|2))|2}ms). {totalData} bytes spread over {frameCount} frames (including retransmits).
  <br/>
  <div>HTTP/3 HEADERS seen at {h3Info.headersTime|2}ms. HTTP/3 PRIORITY Update seen at {h3Info.priorityUpdateTime|2}ms. Priority info (if any): {h3Info.priorityString}</div>
</div>
```

- `{color}` = `ColorHelper.StreamIDToColor("" + stream_id, "HTTP3")[0]`. With border-box sizing the swatch is 50 px wide
  in total; its height is the line height.
- The inner `<div>` is guarded by `v-if="streamDetail.data.h3Info !== null"`. `h3Info` is never null for a stream
  (§3.4), so this line **always** shows. Values that were never seen print as `-1.00ms`, and `priorityString` is then
  empty. A stream without data prints `Transmitted from -1.00ms to -1.00ms (0.00ms). 0 bytes spread over 0 frames`.
- The duration is computed from the **rounded strings** (`"12.35" - "10.00"`), then `toFixed(2)`. **PRESERVE.**
- Interpolations are HTML-escaped. The trailing `<br/>` before a block `<div>` creates no extra blank line.

Example: `[swatch] Stream **4** : Requested at 360.00ms. Transmitted from 532.00ms to 1388.00ms (856.00ms). 50029 bytes
spread over 39 frames (including retransmits).` / `HTTP/3 HEADERS seen at 359.00ms. HTTP/3 PRIORITY Update seen at
-1.00ms. Priority info (if any): `

Clicking a waterfall bar does three things:

1. It sets this detail state.
2. It re-renders the byte-range chart for that stream and applies the current zoom (2.8).
3. It does **not** re-render the waterfall or the data-flow strip. qvis implements this with a `skipRender` flag
   (`:144`, `:152-156`), which swallows the Vue `updated()` hook that the detail-row change triggers.

The detail state lives in the panel component and is **not** cleared when the trace or the checkboxes change; see M17.

### 2.8 Interactions summary

| Where | Gesture | Effect |
|---|---|---|
| Configurator dropdown | select a trace | `config.connections = [conn]` → panel 0 re-renders (2.9); other panels are destroyed |
| "Show waterfall" | toggle | row c appears or disappears; full re-render of the panel (zoom reset, byte ranges back to stream 0) |
| "Show byte ranges" | toggle | row h appears or disappears; full re-render. In qvis the byte-range chart then stays **blank** after it is switched back on (M4, FIX) |
| "Load all connections at once" | click | multi-trace mode (§3.8) |
| Data-flow strip, frame rect | hover | tooltip (2.6) |
| Data-flow strip, frame rect | click | `byteRange.render(dataSent, dataMoved, d.streamID)`, then `byteRange.zoom(currentDomain)` |
| Data-flow strip, any painted element (frame rects, markers, axis, legend text) | wheel, drag, double-click, touch | d3.zoom on the inner `<g>` (§3.6): horizontal zoom 1-30x and pan clamped to the data. The byte-range chart follows. The **waterfall does not zoom** |
| Waterfall stream bar (`rect.packet`) | click | stream detail (2.7) and byte ranges for that stream |
| Waterfall circle, square or triangle | click | nothing; the marker swallows the click |
| Byte-range chart | any | nothing; no handlers |

The cursor stays the default everywhere. There is no hover highlight anywhere.

### 2.9 When charts (re-)render (`MultiplexingGraphCollapsedRenderer.vue:121-192`)

- `created()` constructs the waterfall renderer (with the detail callback) and the data-flow renderer, which in turn
  constructs the byte-range renderer. The simulation renderer is commented out.
- `mounted()` and `updated()` both call `updateRenderers()`. `updated()` fires whenever a prop used in the template
  changes: the connection (via the h4), `showwaterfall` or `showbyteranges`. It also fires on `streamDetail` changes,
  but `skipRender` swallows those.
- `updateRenderers()` performs these steps:
  1. Set the widths (2.5).
  2. Wait `setTimeout(…, 100)`.
  3. If `connection !== undefined`:
     - if `showwaterfall`, render the waterfall and set `dataRenderer.waterfallRenderer = waterfallRenderer`;
       otherwise set it to `undefined`
     - render the data-flow strip, which at its end renders the byte ranges for stream 0 (if there is at least one
       frame) and re-wires `waterfallRenderer.onStreamClicked` (§3.7)
- Every render clears its container (`selectAll("*").remove()`) and rebuilds the SVG from scratch, which resets the
  zoom.
- Leaving the tab destroys the components (no keep-alive). Returning re-creates them from the persisted config: same
  traces, same checkboxes, no stream detail.

---

## 3. Algorithms and data flow

### 3.1 Config and state (`data/MultiplexingGraphConfig.ts`, `store/ConfigurationStore.ts:14`)

```ts
class MultiplexingGraphConfig {
  collapsed = true;          // UNUSED anywhere
  showwaterfall = true;
  showbyteranges = true;
  connections: Connection[] = [];   // [] = nothing selected; normally 1 entry; N entries in multi-trace mode
}
```

The config is a single long-lived object in the `configurations` store. It survives route changes but not reloads.

Auto-select (`MultiplexingGraphConfigurator.vue:109-124`): in `mounted()` and `updated()`, if
`config.connections.length === 0 && store.groups.length > 0`, then
`config.connections = [store.groups[0].getConnections()[0]]`. The guard for groups without connections is app-shell
Q12 (FIX).

### 3.2 Direction selection (the same in all renderers)

```ts
const isServer = connection.vantagePoint && connection.vantagePoint.type === "server";   // qvis; see M21
// data direction (data-flow strip, byte ranges, waterfall bars):
const dataEvent    = isServer ? "packet_sent"     : "packet_received";
// request direction (waterfall circles):
const requestEvent = isServer ? "packet_received" : "packet_sent";
// HTTP/3 request frames (waterfall square and triangle, simulation):
const h3Event      = isServer ? "frame_parsed"    : "frame_created";
const directionText = isServer ? "sent" : "received";
```

qvis compares only the **type part** of the event name (`DirectEventParser.name` returns the part after `:`), so the
category or namespace is ignored. qvis-react matches full latest-draft names (§4).

`isDataStream(id) = parseInt(id, 10) % 4 === 0` (`MultiplexingGraphDataHelper.ts:5-7`). This keeps client-initiated
bidirectional streams, i.e. HTTP/3 request streams; `undefined` gives NaN and is rejected.

### 3.3 Data-flow ("collapsed") extraction (`MultiplexingGraphD3CollapsedRenderer.ts:148-512`)

The renderer iterates `connection.getEvents()` **once, in stored order**; the loader sorts events by time. There are
two counters, `frameCount = 1` and `packetIndex = 0`, and one map, `streamRanges: Map<number, StreamRange>`.

For each event:

**A. `name === dataEvent`** (`:407-461`): if `data.frames` is non-empty, for each frame in order:

1. Skip the frame if `frame.stream_id === undefined` or `!isDataStream("" + frame.stream_id)`. This drops frames
   without a stream ID (ACK, PADDING, CRYPTO, ...) and frames of non-request streams.
2. Keep only `frame.frame_type === "stream"`. This drops `max_stream_data`, `reset_stream`, `stop_sending` and
   `stream_data_blocked` frames on request streams.
3. `streamID = parseInt(frame.stream_id, 10)`; get or create its `StreamRange`:
   `{currentHead: -1, highestReceived: -1, holes: [], filled: [], cumulativeTimeDifference: 0,
   timeDifferenceSampleCount: 0, frameCount: 0}`.
4. `arrival = calculateFrameArrivalType(range, event.relativeTime, from = parseInt(offset), to = from + parseInt(length) − 1)`
   (3.5).
5. `range.frameCount += 1` (unused afterwards).
6. Push the datum:

   ```ts
   dataSent.push({
     streamID, packetNumber: data.header.packet_number,
     index: packetIndex,                    // global per-FRAME index (despite the name); drives the height alternation
     size: frame.length,                    // raw value, unused
     countStart: frameCount, countEnd: frameCount + 1,
     arrivalType: arrival.type, arrivalTimeDifference: arrival.timeDifference, arrivalCreatedHole: arrival.createdHole,
     offset: parseInt(frame.offset, 10), length: parseInt(frame.length, 10),
     time: event.relativeTime,
   });
   ++frameCount; ++packetIndex;
   ```

After the loop, with N data STREAM frames: `frameCount = N + 1`, `dataSent[i].countStart = i + 1` and
`countEnd = i + 2`.

**B. `name === "data_moved"`** (`:463-511`):

1. Skip if `!isDataStream("" + data.stream_id)`.
2. Skip if `data.from !== "transport" && data.to !== "application"`. This is **AND**: the event is kept when
   `from === "transport"` **or** `to === "application"`. Events without `from` and `to` are skipped. **PRESERVE.**
3. If `dataSent` is empty, `console.error("data moved but no stream frames seen yet... shouldn't happen!", data)` and
   skip.
4. `movedOffset = parseInt(data.offset, 10)`; `movedLength = parseInt(data.length, 10)`. If `movedLength === 0`,
   `console.error("data_moved event with length 0, shouldn't happen! ignoring...", data)` and skip. NaN is **not**
   rejected.
5. Find the **last** `dataSent` entry (searching backwards) with the same stream. If there is none,
   `console.error("Data moved but didn't start at previous stream's offset, impossible!!!", …)` and skip.
6. `dataMoved.push({streamID, countStart: found.countStart, countEnd: found.countEnd, offset: movedOffset, length: movedLength})`.

The link to "the last STREAM frame of the same stream so far" is an approximation; the source comment `:486-490` says
so. It applies regardless of vantage point.

After the loop, for every stream whose `holes` is non-empty:
`console.warn("MultiplexingGraphD3CollapsedRenderer : stream has holes, didn't finish completely! Did this connection end pre-maturely?", stream_id, holes)`.

`xMSRange` (`:154-157`) is computed only for a debug log. Do not port it.

### 3.4 Waterfall extraction (`MultiplexingGraphD3WaterfallRenderer.ts:145-333`)

State: `dataFrameCount = 0`, `streams: Map<number, StreamExtents>` (insertion order = request order), and
`h3Infos: Map<number, H3StreamInfo>`.

```ts
interface StreamExtents { stream_id; order; requestIndex; startIndex; stopIndex;
                          requestTime; startTime; endTime; frameCount; totalData; h3Info: H3StreamInfo | null }
interface H3StreamInfo  { headersIndex; priorityUpdateIndex; headersTime; priorityUpdateTime; priorityString }
const emptyH3 = () => ({ headersIndex: -1, priorityUpdateIndex: -1, headersTime: -1, priorityUpdateTime: -1, priorityString: "" });
```

Single pass over the events in stored order. For each event:

**1. HTTP/3 request frames** (`:162-241`), when `evt.name === h3Event` and `data.frame` exists:

- **`frame_type === "headers"`**:
  - `stream_id = parseInt("" + data.stream_id)`; `info = h3Infos.get(stream_id) ?? emptyH3()`
  - `info.headersIndex = dataFrameCount`; `info.headersTime = evt.relativeTime`
  - for each `header` of `data.frame.headers` with `header.name === "priority"`: append to `priorityString` —
    `"HEADER: " + value` if it is empty, otherwise `" -> HEADER: " + value`
- **`frame_type === "priority_update"`**:
  - qvis: `stream_id = parseInt("" + data.frame.element_id)`. The event-level `data.stream_id` is the control stream
    and is ignored.
  - `info = h3Infos.get(stream_id) ?? emptyH3()`
  - `info.priorityUpdateIndex = dataFrameCount`; `info.priorityUpdateTime = evt.relativeTime`
  - append `"FRAME: " + data.frame.value`, or `" -> FRAME: " + value` if `priorityString` is not empty
- If `stream_id >= 0 && info`: when the stream already exists in `streams`, set `stream.h3Info = info`; always
  `h3Infos.set(stream_id, info)`.

These events fall through to step 2 and are filtered out there, because their name is neither packet event.

**2. Packet events** (`:243-332`): continue only if `evt.name` is `requestEvent` or `dataEvent` and `data.frames`
exists. Collect the STREAM frames (`frame_type === "stream"`); stop if there are none. For each STREAM frame:

```ts
if (!isDataStream("" + f.stream_id)) continue;
const streamID = parseInt(f.stream_id, 10);
if (evt.name === dataEvent) ++dataFrameCount;            // BEFORE the stream lookup
let stream = streams.get(streamID);
if (!stream) {
  if (evt.name !== requestEvent) {
    console.error("MultiplexingGraphD3WaterfallRenderer: first packet for stream was not request! Shouldn't happen!", evt);
    break;                                               // skips the REST of this packet's frames (M15)
  }
  stream = { stream_id: streamID, order: streams.size, requestIndex: dataFrameCount,
             startIndex: -1, stopIndex: -1, requestTime: evt.relativeTime, startTime: -1, endTime: -1,
             frameCount: 0, totalData: 0,
             h3Info: h3Infos.get(streamID) ?? emptyH3() };   // never null
  streams.set(streamID, stream);
} else {
  if (evt.name !== dataEvent) continue;                  // later request-direction frames (request bodies) are ignored
  if (stream.startIndex === -1) { stream.startIndex = dataFrameCount; stream.startTime = evt.relativeTime; }
  if (dataFrameCount > stream.stopIndex) { stream.stopIndex = dataFrameCount; stream.endTime = evt.relativeTime; }
  stream.frameCount++;
  stream.totalData += parseInt(f.length, 0);             // includes retransmits and duplicates
}
```

Notes:

- `requestIndex`, `headersIndex` and `priorityUpdateIndex` are in the **data-frame index space**: they count the data
  frames seen before the event. In a typical client trace all requests go out before any response, so they are all 0.
- `dataFrameCount` ends at N (1-based frame indices 1..N), the same N as the data-flow strip except in the M15 case.
- `order` is the request order; it sets the vertical position.

Expected values for the qvis demo `public/standalone_data/draft-01/parallel_10_50KB_f5.qlog` (aioquic client; computed
with an exact re-implementation). Use them as a sanity fixture after converting the file to the latest draft:

- 391 data STREAM frames, final `frameCount` 392, 10 streams (0-36), all 391 arrivals `Normal`
- waterfall: `dataFrameCount` 391; every `requestIndex` and `headersIndex` is 0; `priorityString` is `""`
- stream 0: start 1, stop 387, requestTime 359, startTime 531, endTime 2083, 43 frames, 50029 bytes
- stream 36: start 255, stop 291, 37 frames, 50038 bytes

### 3.5 Frame arrival classification (`MultiplexingGraphD3CollapsedRenderer.ts:183-398`)

This is the subtlest algorithm. Port it **verbatim**, keeping state per stream and using `event.relativeTime` in ms as
the timestamp. `from`/`to` are inclusive byte offsets.

```ts
enum FrameArrivalType { Normal, Future, Duplicate, Retransmit, Reordered, UNKNOWN }   // numeric 0..5
interface Range { time: number; from: number; to: number }

function calculateFrameArrivalType(range: StreamRange, timestamp: number, from: number, to: number) {
  let outputType = UNKNOWN, outputTimestampDifference = 0, outputHole: Range | undefined;

  // 1. a hole that contains `from` or `to`
  let foundHole = range.holes.find(h => (from >= h.from && from <= h.to) || (to >= h.from && to <= h.to));
  if (!foundHole) {
    const foundFilled = range.filled.find(f => (from >= f.from && from <= f.to) || (to >= f.from && to <= f.to));
    if (foundFilled) return { type: Duplicate, timeDifference: 0, createdHole: undefined };      // NO state update
    else if (to < range.currentHead) return { type: Duplicate, timeDifference: 0, createdHole: undefined };  // NO state update
    else if (from > range.highestReceived + 1) {
      outputType = Future;
      outputHole = { time: timestamp, from: range.highestReceived + 1, to: from };   // note: `to` = from, exclusive end
    }
    else if (from === range.highestReceived + 1) outputType = Normal;
    else if (to > range.highestReceived + 1)    outputType = Normal;  // partial overlap at the end (practically unreachable)
    else {
      // "spanning": starts in filled[i] and ends in filled[i+1], covering a hole
      let spanning = false;
      for (let i = 0; i < range.filled.length - 1; ++i) {
        const f1 = range.filled[i], f2 = range.filled[i + 1];
        if (from >= f1.from && to > f1.to && to <= f2.to) spanning = true;
      }
      if (spanning) {
        foundHole = range.holes.find(h => from < h.from && to > h.to);
        if (foundHole) { outputTimestampDifference = timestamp - foundHole.time; outputType = Retransmit; }
        else outputType = UNKNOWN;
      } else outputType = UNKNOWN;
    }
  } else {
    outputTimestampDifference = timestamp - foundHole.time;
    outputType = Retransmit;
  }

  if (outputType === Retransmit) {
    ++range.timeDifferenceSampleCount;
    range.cumulativeTimeDifference += outputTimestampDifference;
    const avg = range.cumulativeTimeDifference / range.timeDifferenceSampleCount;   // avg INCLUDES this sample
    if (outputTimestampDifference < 20 && outputTimestampDifference < avg * 0.3) outputType = Reordered;
  }
  if (to > range.highestReceived) range.highestReceived = to;

  // 2. insert into `filled`, sort by .from ascending, merge touching/overlapping intervals (stack merge)
  range.filled.push({ from, to, time: timestamp });
  range.filled.sort((a, b) => a.from - b.from);
  const stack = [range.filled[0]];
  for (let i = 1; i < range.filled.length; ++i) {
    const prev = stack.pop()!, cur = range.filled[i];
    if (prev.to + 1 >= cur.from) stack.push({ from: prev.from, to: Math.max(prev.to, cur.to), time: timestamp });
    else { stack.push(prev); stack.push(cur); }
  }
  range.filled = stack;

  // 3. regenerate holes BETWEEN filled ranges; each new hole inherits the time of an old hole it overlaps, else `timestamp`
  const newHoles: Range[] = [];
  for (let i = 0; i < range.filled.length - 1; ++i) {
    const h = { from: range.filled[i].to + 1, to: range.filled[i + 1].from - 1, time: -666 };
    const old = range.holes.find(o => (h.from >= o.from && h.from <= o.to) || (h.to >= o.from && h.to <= o.to));
    h.time = old ? old.time : timestamp;
    newHoles.push(h);
  }
  range.holes = newHoles;
  range.currentHead = range.holes.length > 0 ? range.holes[0].from - 1 : range.filled[range.filled.length - 1].to;

  return { type: outputType, timeDifference: outputTimestampDifference,
           createdHole: outputHole ? [outputHole.from, outputHole.to] : undefined };
}
```

The source's `console.error` calls inside this function are listed in §6.2.

Behavioural consequences to preserve. They are verified by running the exact code; use them as unit-test vectors
(each line is `t [from,to] → type`):

| Scenario | Sequence | Result |
|---|---|---|
| In order | `0 [0,99]`, `1 [100,199]`, `2 [200,299]` | Normal, Normal, Normal |
| Gap, then fill | `0 [0,99]`, `1 [200,299]`, `2 [100,199]` | Normal; **Future** with hole `[100,200]` (tooltip "Creates gap from 100 to 200 (size: 100)"); **Retransmit** with diff 1. The first fill of a stream can never be Reordered, because `diff < avg*0.3` is impossible when `avg === diff`. |
| Two fills | `0 [0,99]`, `10 [200,299]`, `50 [100,199]`, `60 [400,499]`, `61 [300,399]` | Normal, Future, Retransmit (diff 40), Future, **Reordered** (diff 1; avg 20.5; 1 < 20 and 1 < 6.15) |
| First frame not at offset 0 | `0 [100,199]`, `5 [0,99]` | Future (hole `[0,100]`), then **Duplicate**: no hole exists before the first filled range and `to (99) < currentHead (199)` |
| Pure duplicate | `0 [0,99]`, `1 [100,199]`, `2 [0,99]` | Normal, Normal, Duplicate |
| Duplicate beyond head | `0 [0,99]`, `1 [200,299]`, `2 [200,299]` | Normal, Future, Duplicate (found in `filled`) |
| Partial overlap | `0 [0,99]`, `1 [50,149]` | Normal, **Duplicate**. `highestReceived` stays 99 because a Duplicate returns before any state update. |
| Zero-length FIN | `0 [0,99]`, `1 [100,99]` | Normal, **Duplicate**: `to` (99) is inside filled `[0,99]`. A FIN-only STREAM frame always shows a red marker. |
| Spanning (after a new filled range) | `0 [0,99]`, `1 [200,299]`, `2 [300,399]`, `3 [250,259]` | Normal, Future, Normal, Duplicate |

### 3.6 Data-flow strip rendering (`MultiplexingGraphD3CollapsedRenderer.ts:92-146`, `:522-742`)

Geometry:

- `axisLocation = "bottom"`; it is never changed, and the `"top"` branches are dead code.
- `margin = {top: 0, right: 40, bottom: 40, left: 20}`. The code sets bottom to 20, then to 40 because the axis is at
  the bottom.
- `W = container.clientWidth − 60`; `H = barHeight = 70`.
- SVG: `width = W + 60` (the container width), `height = 110`. Attributes: `xmlns="http://www.w3.org/2000/svg"`,
  `xmlns:xlink="http://www.w3.org/1999/xlink"`, `font-family="Trebuchet-ms"` (an invalid font name with no effect,
  because every text sets its own font).
- The inner `<g transform="translate(20,0)">` is called `svg` below. Everything is appended to it, **and the zoom is
  attached to it** (not to the `<svg>`).

Elements, in append order:

1. `<defs><clipPath id="clip"><rect width=W height=70 x=0 y=0>`. Duplicate id: see M3.
2. `rects = svg.append("g").attr("clip-path", "url(#clip)")`.
3. Scale: `xDomain = d3.scaleLinear().domain([1, frameCount]).range([0, W])`, with `currentDomain = xDomain`.
4. Axis: `svg.append("g").attr("transform", "translate(0,70)").call(d3.axisBottom(xDomain))`. These are default d3
   ticks: about 10, `font-size 10`, `font-family sans-serif`, `currentColor` = `#2c3e50`. With 0 frames the domain is
   `[1,1]`, which d3 maps to the range midpoint, so there is a single tick `1` at `W/2`.
5. Constants: `packetSidePadding = 0.3`, `packetHeight = 70*0.65 = 45.5`, `typeGap = 70*0.05 = 3.5`,
   `typeHeight = 70*0.275 = 19.25`.
6. **Frame rects** `rect.packet`, one per `dataSent` entry, in order:

   ```
   x      = xDomain(countStart) − 0.3
   width  = xDomain(countEnd) − xDomain(countStart) + 0.6
   y      = index % 2 === 0 ? 0 : 45.5 * 0.05        (= 2.275)
   height = index % 2 === 0 ? 45.5 : 45.5 * 0.90     (= 40.95)
   fill   = StreamIDToColor("" + streamID, "HTTP3")[0]; style opacity 1; style pointer-events all
   on mouseover / mouseout → tooltip (2.6); on click → byte ranges for d.streamID, then zoom(currentDomain)
   ```

   Odd frames are slightly shorter and shifted down, so neighbouring frames of the same stream remain distinguishable.
7. **Arrival markers**: four groups appended in this order, each filtered from `dataSent`. All use
   `x/width` as above, `y = 45.5 + 3.5 = 49` and `height = 19.25`, opacity 1:

   | class | filter | fill |
   |---|---|---|
   | `retransmitPacket` | `arrivalType === Retransmit` | `black` |
   | `reorderPacket` | `Reordered` | `blue` |
   | `duplicatePacket` | `Duplicate` | `red` |
   | `futurePacket` | `Future` | `purple` |

   Normal and UNKNOWN frames get no marker. There is no legend for these colors.
8. **Axis label** (appended to `svg`, so it is neither clipped nor zoomed): a `text` at `x = xDomain(frameCount / 2)`,
   which is slightly left of center, and `y = 70 + 40 − 10 = 100`. Attributes: `dominant-baseline: baseline`,
   `text-anchor: middle`, style `font-size: 14` (Chrome computes 14 px; use `"14px"`), `font-family: Trebuchet MS`,
   fill `#000000`. Text, verbatim:
   **`"Count of STREAM frames " + directionText + " (regardless of size, includes retransmits)"`**, e.g.
   `Count of STREAM frames received (regardless of size, includes retransmits)`.
9. **Zoom**:

   ```ts
   const zoom = d3.zoom().scaleExtent([1, 30])
       .translateExtent([[0, 0], [W, 70]]).extent([[0, 0], [W, 70]])
       .on("zoom", updateChart);
   svg.call(zoom);          // on the <g>: only painted descendants receive wheel and drag
   function updateChart() {
     const newX = d3.event.transform.rescaleX(xDomain);
     this.currentDomain = newX;
     xAxis.call(d3.axisBottom(newX));
     rects.selectAll(".packet,.retransmitPacket,.reorderPacket,.duplicatePacket,.futurePacket")
          .attr("x", d => newX(d.countStart) − 0.3)
          .attr("width", d => newX(d.countEnd) − newX(d.countStart) + 0.6);   // y and height unchanged
     this.byteRangeRenderer.zoom(newX);
   }
   ```

   d3-zoom defaults apply:
   - wheel zooms around the pointer (at scale 1, zooming out further is ignored and the page scrolls)
   - drag pans (a drag suppresses the following click)
   - double-click zooms in 2x; shift+double-click zooms out
   - touch and pinch work
   - wheel events that change the zoom call `preventDefault`

   D3 v7 differs in ctrl+wheel and pinch handling; qvis-react restores the d3-zoom v1 `filter`, `wheelDelta` and
   `touchable` (PRESERVE; see X4).
10. If `dataSent.length > 0`: `byteRangeRenderer.render(dataSent, dataMoved, 0)`. This always shows **stream 0** and
    applies **no** zoom call, so the Y axis is `axisRight` (§3.7). If there are no frames, the byte-range renderer is
    not called and its previous drawing stays (M5).
11. If a waterfall is linked (`this.waterfallRenderer !== undefined`), set
    `waterfallRenderer.onStreamClicked = (id) => { byteRangeRenderer.render(dataSent, dataMoved, parseInt(id, 0)); byteRangeRenderer.zoom(currentDomain); }`.

### 3.7 Byte-range chart (`MultiplexingGraphD3ByterangesRenderer.ts`)

`render(allFrames = dataSent, allDataMoved = dataMoved, streamID)`:

1. Geometry:
   - `margin = {top 20, right 40, bottom 20, left 20}`; `W = clientWidth − 60`; `H = 500`
   - SVG `width = clientWidth`, `height = 540`, with the same namespace and font attributes as above
   - `<g transform="translate(20,20)">`
2. Filter: `streamFrames = allFrames.filter(d => "" + d.streamID === "" + streamID)` and the same filter for
   `dataMoved`.
3. `maxBytes = max(offset + length − 1)` over `streamFrames`, starting from 0.
4. Scales and axes:
   - `xDomain = scaleLinear([1, allFrames[allFrames.length − 1].countEnd] → [0, W])`. This equals the data-flow domain
     `[1, frameCount]`.
   - `xAxis = g.append("g").call(d3.axisTop(xDomain))`: ticks above y = 0, in the 20 px top margin.
   - `yDomain = scaleLinear([0, maxBytes] → [0, 500])`, so **offset 0 is at the top** and bytes grow downwards.
   - `yAxis = g.append("g").attr("transform", "translate(0, 0)").call(d3.axisRight(yDomain))`: the labels are drawn
     **inside** the plot, to the right of x = 0.
5. `<defs><clipPath id="byterange-clip"><rect width=W height=500 x=0 y=0>` and `rects = g.append("g").attr("clip-path", "url(#byterange-clip)")`.
6. **`rect.packet`** for each stream frame:
   - `x = xDomain(countStart)`; `y = yDomain(offset)`
   - `width = max(1, xDomain(countEnd) − xDomain(countStart))`; `height = max(1, yDomain(length − 1))`
   - fill: the stream color; opacity 1
7. **`rect.pingback`** for each stream frame:
   - `x = xDomain(1)` (= 0); `y = yDomain(offset)`
   - `width = max(1, xDomain(countEnd) − xDomain(1))`; `height = yDomain(length − 1)`, with no minimum
   - fill: the stream color; style opacity **0.2**

   The result is a translucent band from the left edge to the frame. Overlapping bands, such as retransmits, become
   darker.
8. **`rect.dataMoved`** for each data_moved entry:
   - `x = xDomain(countStart + 1)`, i.e. one frame slot to the right of the linked STREAM frame; `y = yDomain(offset)`
   - `width = max(1, xDomain(countEnd) − xDomain(countStart))`; `height = yDomain(offset + length − 1) − yDomain(offset)`
   - fill `black`; opacity 1
9. Stores `this.updateZoom = (newX) => { … }` (below). `zoom(newX)` simply calls `this.updateZoom(newX)`.

`updateZoom(newX)` auto-fits Y to the frames of the selected stream that fall in the visible window. Port this code
verbatim, including its off-by-ones (M7):

```ts
const startIndex = Math.max(0, Math.ceil(newX.domain()[0]) + 1);                       // array index into allFrames
const endIndex   = Math.min(allFrames.length − 1, Math.floor(newX.domain()[1]) − 1);
let startY = Number.MAX_VALUE, endY = 0;
for (let i = startIndex; i < endIndex; ++i)            // min offset; excludes endIndex
  if ("" + allFrames[i].streamID === "" + streamID && allFrames[i].offset < startY) startY = allFrames[i].offset;
for (let i = endIndex; i > startIndex; --i) {          // max end; excludes startIndex
  const f = allFrames[i]; if (!f) continue;
  if ("" + f.streamID === "" + streamID && f.offset + f.length − 1 > endY) endY = f.offset + f.length − 1;
}
if (startY > endY) console.error("Something went terribly wrong", startY, endY);      // see M8
const newY = yDomain.copy().domain([startY, endY]);
xAxis.call(d3.axisTop(newX));
yAxis.call(d3.axisLeft(newY));                        // labels switch to the LEFT, into the 20 px margin (clipped by the svg)
rects.selectAll(".packet")
  .attr("x", d => newX(d.countStart)).attr("width", d => Math.max(1, newX(d.countEnd) − newX(d.countStart)))
  .attr("y", d => newY(d.offset)).attr("height", d => Math.max(1, newY(d.offset + d.length − 1) − newY(d.offset)));
rects.selectAll(".pingback")
  .attr("x", d => newX(1)).attr("width", d => newX(d.countEnd) − newX(1))
  .attr("y", d => newY(d.offset)).attr("height", d => newY(d.offset + d.length − 1) − newY(d.offset));
rects.selectAll(".dataMoved")
  .attr("x", d => newX(d.countStart + 1)).attr("width", d => Math.max(1, newX(d.countEnd) − newX(d.countStart)))
  .attr("y", d => newY(d.offset)).attr("height", d => newY(d.offset + d.length − 1) − newY(d.offset));
```

`allFrames[i]` has `countStart = i + 1`. Unzoomed (domain `[1, N+1]`), `startIndex = 2` and `endIndex = N − 1`, so the
frames at array indices 0 and 1 are excluded from the minimum. Stream 0's first frames (offset 0) therefore land above
the plot and are clipped after the first click. The (dead) check `if (endIndex > allFrames.length) console.error("Something went wrong transforming Y domain byterangeszoom", …)` exists at `:185-187`.

Y-axis style timeline (M6):

- right after a render without a zoom call (the initial stream-0 render): `axisRight` on the original domain
- after any zoom gesture or any stream click (render + zoom): `axisLeft`, with labels in the left margin and clipped
  where they are wider than 20 px

The source has a `TODO` noting that the minimum-offset search does not scan the full range for the lowest offset.

### 3.8 Multi-trace mode (`MultiplexingGraphConfigurator.vue:87-107`, `MultiplexingGraphRenderer.vue:23-31`)

`selectAllConnections()`:

```ts
(window as any).holblockinfo = [];                                   // debug sink for paper results; never read here
let conns = []; for (const g of store.groups) conns.push(...g.getConnections());
conns = conns.sort((c1, c2) => (c1.parent.filename < c2.parent.filename) ? -1 : 1);   // code-unit order; ties: see M25
config.showwaterfall = true;
config.showbyteranges = false;
config.connections = conns;
```

Rendering is `v-for (connection2, index) in config.connections`, with one panel per entry and `:key="index"`, so
panel 0 is reused and the rest are created. Each panel shows its own h4 (`filename : longName`) and renders
independently after its own 100 ms timeout. All panels share the tooltip.

The dropdown shows `connections[0]`. Picking any trace returns to single mode. Loading more files does not extend the
list. Generated sibling traces from the sequence diagram are included if they exist (app-shell Q13).

Because multi mode sets `showbyteranges = false`, the byte-range renderers of the newly created panels hit M4 on their
first render. In qvis, ticking "Show byte ranges" afterwards leaves those charts blank.

### 3.9 Waterfall rendering (`MultiplexingGraphD3WaterfallRenderer.ts:56-85`, `:337-530`)

Geometry:

- `margin = {top: 40, right: 40, bottom: 0, left: 20}`; `W = clientWidth − 60`; `barHeight = 120`
- initial SVG `width = clientWidth`, `height = 160`; `<g transform="translate(20,40)">`

Row height:

```ts
let minBarHeight = 4;
if (4 * streams.size < 120) minBarHeight = (120 * 0.95) / streams.size;   // = 114 / n for n < 30
const height = Math.ceil(minBarHeight * streams.size) + 40;
svgElement.setAttribute("height", height);
```

Resulting SVG heights: 154 px for n = 1-29 (155 for n = 13 and 26 due to float rounding; n = 29 gives
minBarHeight 3.93), and `4n + 40` for n ≥ 30 (160, 164, 168, ...). With n = 0 the height is
`ceil(Infinity × 0) + 40 = NaN`. The attribute is invalid and the browser falls back to **150 px**.

The wrapper is 165 px with `overflow-y: auto`, and an inline SVG adds a few px of baseline gap below itself. A vertical
scrollbar therefore appears from about 31 streams on.

Elements:

1. `xDomain = scaleLinear([1, dataFrameCount] → [0, W])`. **Note `[1, N]`, whereas the data-flow strip uses
   `[1, N+1]` (M9).**
2. An empty `xAxis` group (no axis is drawn).
3. `<defs><clipPath id="clip"><rect width=W+20 height=height x=-20 y=0>`. It is **not applied** to anything in the
   waterfall, but it is the first `#clip` in the document, so the data-flow strip uses it (M3).
4. `rects = g.append("g")`, with no clip.
5. **Empty state**: if `streams.size <= 1 || dataFrameCount < 5`, append one text and return (no legend):
   - position `x = 200`, `y = 100` (SVG coordinates 220, 140)
   - `dominant-baseline: baseline`, `text-anchor: start`, font-size 14, `font-family: Trebuchet MS`, fill `#000000`
   - text, verbatim:
     **`This trace doesn't contain multiple independent streams (or has less than 5 STREAM frames), which is needed for the waterfall.`**
6. Otherwise, one `<g>` per stream in `streams` insertion order (`rects2`), each containing up to four elements in this
   order:
   - **bar** `rect.packet`:
     - `x = xDomain(startIndex) − 0.15`; `y = order × minBarHeight`
     - `width = max(4, xDomain(stopIndex) − xDomain(startIndex) + 0.3)`; `height = max(minBarHeight, 0.01)`
     - fill: the stream color; opacity 1; click → 2.7
     - a stream without data has start = stop = −1, so it becomes a 4 px bar at `xDomain(−1)`, left of the origin
       (M13)
   - `circleWidth = rectWidth = min(15, max(minBarHeight / 1.2, 0.01))`
   - **request circle**:
     - `cx = xDomain(requestIndex) + cw/2`; `cy = order × minBarHeight + cw/1.6` (the source comment says "1.6 should be
       2, but 1.6 somehow looks better")
     - `r = cw/2`; fill: the stream color; stroke `black`; stroke-width `cw/5`
   - **HEADERS square** (only if `h3Info.headersIndex >= 0`):
     - `x = xDomain(headersIndex)`; `y = order × minBarHeight + cw/10`; width = height = `cw`
     - fill: the stream color; stroke black; stroke-width `cw/5`
     - in a client trace it usually coincides with the request circle and covers it (M12)
   - **PRIORITY_UPDATE triangle** (only if `h3Info.priorityUpdateIndex >= 0`):
     - an equilateral-looking triangle pointing up:
       `<path d="m 0,{w} l {w},0 l -{w/2},-{w} z" transform="translate({xDomain(priorityUpdateIndex)},{order × minBarHeight + w/10})">`
     - fill: the stream color; stroke black; stroke-width `w/5`

   Bars touch vertically with no gap. Later streams paint over earlier ones.
7. **Legend** (top left, in the 40 px top margin). `legendY = −20`, `iw = 13`, and `x0 = xDomain(0)`, which is
   **negative**: `−W/(N−1)` (M11).
   - circle: `cx = x0 + 6.5`, `cy = −20`, `r = 6.5`, fill white, stroke black, stroke-width 2.6
   - text: `x = x0 + 26.5`, `y = −19`, `dominant-baseline: middle`, `text-anchor: start`, font-size 14,
     `Trebuchet MS`, fill `#000000`. Content: **`"Request " + directionText`**, i.e. `Request received` for client
     traces and `Request sent` for server traces. This is inverted (M10).
   - rect: `x = x0 + 156.5`, `y = −26.5`, width 20, height 13, fill white, stroke black, stroke-width 2.6
   - text: `x = x0 + 186.5`, `y = −20`, same style. Content:
     **`'Colored while stream is "active" (between first and last STREAM frame ' + directionText + ')'`**

   There are no legend entries for the square or the triangle.

### 3.10 Simulation renderer (dead code: `MultiplexingGraphD3SimulationRenderer.ts`)

This renderer is never constructed (`MultiplexingGraphCollapsedRenderer.vue:91,126,188` are commented out), and its
row is `display: none`. It is documented only for completeness.

What it would do:

- Geometry: `barHeight 50`, `margin {top 20, right round(clientWidth × 0.05), bottom 0, left 5}`.
- Data: `connection.lookup(http, h3Event)`, keeping HEADERS frames on data streams. For each one, push
  `{streamID, count: 1, 2, …, text: method + " " + path}` from the `:method` and `:path` headers; missing values print
  `undefined`.
- `xDomain [1, requestCount]` (count + 1).
- Per request:
  - a bar `x = xDomain(count) − 0.15`, `width = xDomain(count+1) − xDomain(count) + 0.3`, full height 50, fill: the
    stream color
  - a white box at opacity 0.75 at `(xDomain(count) + 15, 15)`, width `bar − 30`, height 20
  - bold 14 text at `(xDomain(count) + 17, 25)`, `dominant-baseline: middle`
- `clip-path url(#clip)`; no zoom.

**Do not render it** (PRESERVE invisibility). Porting the module is optional.

### 3.11 Colors (`ColorHelper.StreamIDToColor(id, "HTTP3")`, also in app-shell §3.7)

| stream | color | stream | color |
|---|---|---|---|
| 0 | `#E1DA4C` | 28 | `#7D787A` |
| 4 | `#6B067F` | 32 | `#6CAD58` |
| 8 | `#E17426` | 36 | `#D580AA` |
| 12 | `#914ca8` | 40 | `#4C61B9` |
| 16 | `#99CBDF` | 44 | `#D38E75` |
| 20 | `#C72737` | 48 | `#46198C` |
| 24 | `#BBC585` | 52 | `#C8A454` |

An exact string match is tried first. Otherwise, IDs `n > 52` use `n % 56`, so 14 colors cycle over request streams
(56 → `#E1DA4C`, 60 → `#6B067F`). Anything else gets `lavenderblush`.

This palette is used by:

- data-flow frame rects
- byte-range packet, pingback and swatch fills
- waterfall bars and markers
- the stream-detail swatch

### 3.12 Data-flow summary

```
connection.getEvents()  ──┬─► Waterfall extraction (3.4) ──► waterfall SVG (3.9) ──click bar──► Vue: streamDetail (2.7)
                          │                                                         └────────────► onStreamClicked ─┐
                          └─► Collapsed extraction (3.3, 3.5) ─► dataSent[], dataMoved[] ─► data-flow SVG (3.6)    │
                                                                       │    hover ─► tooltip (2.6)                 │
                                                                       │    click ─► byteRange.render(stream)+zoom ◄┘
                                                                       │    zoom  ─► byteRange.zoom(newX)
                                                                       └─ initial ─► byteRange.render(stream 0)  (3.7)
```

---

## 4. Event and field consumption

qvis reads the `draft-02` names below and matches the **type part only** (`DirectEventParser.name` returns
`name.split(":")[1]`; `QlogLoaderV2.ts:348-363`), so the category is ignored. The one exception is the dead simulation
renderer, which uses `connection.lookup(http, …)`, keyed by **category** `http`. qvis-react matches the **full
latest-draft names exactly as logged**, uses the shared accessors (ecosystem.md §6.6, h3-events.md §8.1), and does not
alias pre-final names (ARCHITECTURE §0, §3.1). Section 9 is the normative field-by-field mapping; the last column below
is its summary.

| qvis (old) event, by vantage | Fields read (qvis source) | Used for | qvis-react (latest drafts; details in §9) |
|---|---|---|---|
| `transport:packet_received` (client, network, unknown) / `transport:packet_sent` (server): **data direction**, collapsed renderer (`MultiplexingGraphD3CollapsedRenderer.ts:407-461`) | `data.frames` (must be a non-empty array, `:411`). Per frame, in this order: `frame.stream_id === undefined` or `!isDataStream("" + frame.stream_id)` → skip (`:414`); `parseInt(frame.stream_id, 10)` (`:419`); `frame.frame_type === "stream"` (`:421`); `parseInt(frame.offset, 10)` and `parseInt(frame.length, 10)` (`:433`, again at `:450-451`); the raw `frame.length` is also stored as the unused `size` (`:442`). `data.header.packet_number`, raw value (`:440`); a missing `data.header` throws a TypeError, which wedges the renderer (M20). Event time → `relativeTime` (ms). | Data-flow strip frames and arrival types; tooltip; byte ranges | `quic:packet_received` / `quic:packet_sent` (§9.2). StreamFrame `{frame_type:"stream", stream_id: uint64, offset?: uint64 (default 0), fin?, raw?}`. Data length = `streamFrameDataLength(f)` (`raw.payload_length ?? raw.length ?? ...`; quic-events-13 §8.13.9 says the STREAM Length field MUST be logged in `raw.length`). `header.packet_number` is optional (u64). `frames` is optional (§9.6.1). |
| same events and direction, waterfall renderer (`MultiplexingGraphD3WaterfallRenderer.ts:243-332`) | `data.frames` (truthy, `:247`); `frame.frame_type === "stream"` (`:253`); `isDataStream("" + stream_id)` with **no** separate `undefined` check (`"undefined"` parses to NaN and is rejected, `:263`); `parseInt(stream_id, 10)` (`:268`); `parseInt(streamFrame.length, 0)` for `totalData` (radix 0 behaves as 10, `:330`). Event time. | Waterfall `dataFrameCount`, `startIndex`, `stopIndex`, `startTime`, `endTime`, `frameCount`, `totalData` | same as the row above |
| `transport:packet_sent` (client) / `transport:packet_received` (server): **request direction** (waterfall, `:243-301`) | `data.frames[]` STREAM `stream_id` (same checks as the row above); event time. STREAM frames of an already known stream in this direction (request bodies, a late FIN) are ignored (`:315-317`). | Waterfall stream creation: `order`, `requestIndex`, `requestTime` | same latest events as the data rows (the other direction) |
| `http:frame_created` (client) / `http:frame_parsed` (server), `frame_type: "headers"` (`:162-198`) | `evt.name === h3Event`, type only (`:162`); `data.frame` truthy (`:163-164`); `data.frame.frame_type === "headers"` (`:169`); `parseInt("" + data.stream_id)` with no radix (`:173`): NaN fails the later `stream_id >= 0` guard (`:231`), so the info is silently dropped; `data.frame.headers` iterated with **no** guard (`:188`; TypeError if absent); `header.name === "priority"`, exact and case-sensitive (`:189`); `header.value` concatenated raw (prints `undefined` if missing); event time | Waterfall square (`headersIndex`); detail `headersTime`; `priorityString` "HEADER: …" | `http3:frame_created` / `http3:frame_parsed`; `data.stream_id: uint64`; `frame.headers: [* HTTP3HTTPField]`. Use `fieldName(h) === "priority"` and `fieldValue(h)`, which cover `name_bytes` and `value_bytes`. |
| same events, `frame_type: "priority_update"` (`:199-228`) | `parseInt("" + data.frame.element_id)` (`:207`; NaN → dropped as above), `data.frame.value` concatenated raw (`:223`, `:226`). This shape is implementation-specific, from the aioquic era: `{"frame_type":"priority_update","element_id":8,"value":"u=1,i"}`, per the comment at `MultiplexingGraphD3WaterfallRenderer.ts:203`. `data.stream_id` is the control stream and is ignored. | Waterfall triangle (`priorityUpdateIndex`); detail `priorityUpdateTime`; `priorityString` "FRAME: …" | `HTTP3PriorityUpdateFrame {frame_type:"priority_update", stream_id?: uint64 (request), push_id?: uint64 (push), priority_field_value: text, raw?}`. Element = `u64(frame.stream_id)`. **If only `push_id` is present, skip** (qvis wrongly treated a push ID as a stream ID). Value = `frame.priority_field_value`. |
| `http:data_moved`, matched by type `data_moved` in **any** category, so `transport:data_moved` matched too (`MultiplexingGraphD3CollapsedRenderer.ts:463-511`) | `data.stream_id`: `isDataStream("" + id)` (`:465`), linkage by **string** comparison `"" + dataSent[i].streamID === "" + data.stream_id` (`:493`), stored as `parseInt(id, 10)` (`:505`); `data.from`, `data.to` (`:469`); `parseInt(data.offset, 10)` (`:478`); `parseInt(data.length, 10)` (`:479`): only `=== 0` is rejected (`:481`), NaN is kept and yields an invisible NaN-sized rect; `event.relativeTime` only inside a `console.error` | Byte-range black "moved" rects | **`quic:stream_data_moved`** `{stream_id?, offset?, from?, to?: "application"/"transport"/"network", additional_info?: "fin_set"/"stream_reset", raw?}`. Length = `u64(data.raw?.length)`. Skip if `stream_id`, `offset` or the length is missing, or if the length is 0. The from/to AND rule is kept verbatim; `to === "network"` is a DECISION (§9.4.5). |
| (dead simulation) `connection.lookup(http, frame_created \| frame_parsed)`, keyed by category (`MultiplexingGraphD3SimulationRenderer.ts:91-124`) | `data.frame.frame_type === "headers"` (`:103`); `isDataStream("" + data.stream_id)` (`:107`); `data.stream_id` stored **unparsed** as `streamID` (`:123`); `data.frame.headers[]` `.name === ":method"` / `":path"` → `.value` (`:115-120`); `absoluteTime` of the first and last event for a debug log (`:84-85`) | request labels | `conn.lookup(NS.http3, HTTP3.frame_created \| frame_parsed)`; same as the HEADERS row (§9.4.6) |
| Trace metadata | `connection.vantagePoint && connection.vantagePoint.type === "server"` for direction, in every renderer (collapsed `:165-170`, waterfall `:110-115`, simulation `:91-94`); h4 = `connection.parent.filename + " : " + connection.getLongName()` (`MultiplexingGraphCollapsedRenderer.vue:5`), where `getLongName()` reads `vantagePoint.name`, `.type`, `.flow`, `connection.title`, `.description` (`data/Connection.ts:163-186`); configurator: `store.groups`, `group.getConnections()`, `connection.parent.filename` (multi-mode sort, `MultiplexingGraphConfigurator.vue:87-107`) | Direction (3.2); h4 header; trace list | `VantagePoint {name?, type, flow?}` (main-schema-14 §6); same label rules; perspective rules in §9.3 |
| Event time | `parseEvent(e).relativeTime` (ms, relative to the trace start or `reference_time`) for: the tooltip `{time}`; the arrival `timeDifference`, hole `time`, and the Reordered thresholds, which are **absolute ms** (`< 20`, `< avg × 0.3`, §3.5); the waterfall request, start, end, HEADERS and PRIORITY_UPDATE times. `absoluteTime` of the first and last event: debug `xMSRange` log only, in the collapsed (`:154-157`) and dead simulation renderers; the waterfall's copy is commented out (`:90-95`) | All timestamps in the tooltip, arrival diffs and stream details | `ev.relativeTime` in ms (data-model §3.16.3); no unit scaling (§9.4.8) |

Fields and events that are **not** used (relevant when auditing):

- `fin`
- `raw.data`
- `header.packet_type`: there is no packet-type filter, so STREAM frames in 0-RTT and 1-RTT packets both count
- `stream_type_set` (data streams are decided purely by `id % 4`)
- `http3:priority_updated` (latest; optional enhancement, not parity)
- `byte_length`
- `quic:packet_lost` and `recovery:*`: retransmissions are inferred from byte ranges, not from loss events
- ACK frames, CRYPTO frames and every non-STREAM frame on request streams (`max_stream_data`, `reset_stream`,
  `stop_sending`, `stream_data_blocked`)
- DATAGRAM events and frames
- write-only values: the `streamIDs` Set (`MultiplexingGraphD3CollapsedRenderer.ts:161`, `:458`; read only by
  commented-out code at `:533`), `StreamRange.frameCount` (`:435`) and the datum's `size` (`:442`)

Legacy and implementation-specific fields that qvis read and that **no longer exist** in the latest drafts (§9.5):

- STREAM `frame.length`, now `raw.length` / `raw.payload_length`
- `data_moved.length`, now `raw.length`
- `priority_update.element_id` and `.value`, now `stream_id`/`push_id` and `priority_field_value`
- the `http:` category for `data_moved`, now `quic:stream_data_moved` (in the latest drafts `http:` is the Capsule
  Protocol namespace)

Integer parsing: qvis uses `parseInt(x, 10)` on strings. qvis-react uses `u64()`, which accepts JSON numbers and
**decimal** strings (`/^[0-9]+$/`) and returns `undefined` for anything else, including `""` (which `Number("")`
would turn into 0). `undefined` makes the frame or event follow the "absent" rule in §9.4, never NaN arithmetic.
Lenient `parseInt` prefixes such as `"12abc"` → 12 are no longer accepted (FIX; such values are not valid uint64).

---

## 5. URL query parameters and global state

| Item | Where | Semantics |
|---|---|---|
| `multimultiplexing` (any value; **substring of the whole URL**) | `MultiplexingGraphConfigurator.vue:80-85` | Shows "Load all connections at once". The same holds when the URL contains `localhost` or `:8080`. Evaluated once per configurator instance. Sticky across navigation through the router's query rule (app-shell §3.3). **PRESERVE** (app-shell Q20; Vite dev on `localhost` shows it). |
| `window.holblockinfo = []` | `selectAllConnections()` | Debug global ("just for paper results, remove!"); never read here. Optional to port. |
| `configurations.multiplexingGraphConfig` | `ConfigurationStore.ts:14` | `{collapsed: true, showwaterfall: true, showbyteranges: true, connections: []}`. Persists across route changes, not across reloads. |
| `connections.groups`, `connections.outstandingRequestCount` | configurator | Trace list, auto-select and alerts |
| DOM ids | various | `#multiplexingToplevelContainer` (repeated per panel), `#multiplexing-packet-tooltip` (single), `#multiplexing-stats`, `#multiplexing-stats-streams` (empty), `#multiplexing-{fifo,waterfall,data,byterange}-NNNNN`, `#waterfall-checkbox`, `#byteranges-checkbox`, SVG `clipPath` ids `clip` (repeated) and `byterange-clip` (repeated) |
| `ColorHelper.H3streamIDColorLUT` | static | Lazily filled constant map |

No other query parameter is read by this page. There is no localStorage and no URL sync of the selection.

---

## 6. Edge cases, error handling, notifications

### 6.1 User-visible messages (verbatim)

- Alert, danger: `Please load a trace file to visualize it`
- Alert, warning: `Loading files...`
- Waterfall SVG text: `This trace doesn't contain multiple independent streams (or has less than 5 STREAM frames), which is needed for the waterfall.`

This page shows **no toast notifications** and no `alert()`.

### 6.2 Console output in qvis (not user-visible)

`console.error`:

- `DUPLICATE FOUND VIA FILLED!`
- `calculateFrameArrivalType : duplicate data found! Not really an error, but means spurious retransmissions.`
- `Found spanning frame, shouldn't happen in practice, only when debugging`
- `calculateFrameArrivalType: Spanning frame, but not hole found... very weird`
- `calculateFrameArrivalType: no hole found for frame, but also nowhere else we would expect it...`
- `data moved but no stream frames seen yet... shouldn't happen!`
- `data_moved event with length 0, shouldn't happen! ignoring...`
- `Data moved but didn't start at previous stream's offset, impossible!!!`
- `MultiplexingGraphD3WaterfallRenderer: first packet for stream was not request! Shouldn't happen!`
- `Something went terribly wrong`
- `Something went wrong transforming Y domain byterangeszoom` (dead)

`console.warn`: `MultiplexingGraphD3CollapsedRenderer : stream has holes, didn't finish completely! Did this connection end pre-maturely?`

There are also many `console.log` lines.

**FIX (M32):** emit these at `console.debug` level, or collect them into one `console.warn` summary per render. The
e2e gate requires "no console errors", and spurious retransmissions are normal in real traces.

### 6.3 Edge cases and expected behaviour

| Case | qvis behaviour | qvis-react |
|---|---|---|
| No files | danger alert; no panel | same |
| Files still loading | warning alert | same |
| First group has 0 connections | auto-select sets `[undefined]`: the selector crashes, the h4 is empty and nothing renders | FIX (app-shell Q12): select the first group that has a connection |
| Trace without events | strip: axis with a single tick `1` centered, axis label, no bars. Waterfall: SVG height NaN (150 px) with the empty message. Byte range: not re-rendered (stale) | Same strip and waterfall; waterfall height 150 px explicitly; clear the byte range (M5) |
| No request-stream STREAM frames, e.g. a handshake-only trace or a non-H3 app using other stream IDs | Same as above | same |
| Exactly 1 request stream | Waterfall message; the strip renders normally; byte range shows stream 0 if that is the stream | same |
| Stream 0 absent but other streams present | Byte range for stream 0 is empty: no rects, degenerate Y domain `[0,0]`, a single `0` tick at mid-height | PRESERVE |
| ≥ 2 streams but fewer than 5 data frames | Waterfall message | same |
| Data frames whose stream was never seen in the request direction (e.g. only `packet_received` logged, or a server push) | Waterfall: `break` per packet; the stream never appears. If no stream appears at all and the waterfall is shown, the waterfall clip has NaN height and **all data-flow bars disappear** (M3) | Waterfall unchanged (PRESERVE the logic); the data-flow strip must still show its bars (unique clip ids) |
| Many streams (≥ 31) | Waterfall rows are 4 px; the wrapper scrolls vertically | same |
| Stream IDs ≥ 56 | Colors cycle (mod 56) | same |
| `packet_number` missing | Tooltip prints `packet number undefined` | PRESERVE the text (`String(undefined)`) |
| STREAM frame without `offset` | qvis: NaN breaks the classification | `offset = 0` (spec default) |
| STREAM frame without a length | qvis: NaN | DECISION: treat as length 0 (the frame still counts on the frame axis; it classifies as Duplicate when `to = offset − 1` overlaps filled data, otherwise Normal) |
| `quic:stream_data_moved` with `additional_info` and no length | n/a | skip silently |
| Many traces in multi mode | One 100 ms timeout per panel, each iterating all events twice; slow but works | same; optionally render panels sequentially with `requestIdleCallback` (no visible change) |
| Window resize | No re-layout | PRESERVE |
| Switching traces after a waterfall click | Stale "Selected stream's details" from the previous trace stays | FIX (M17): clear it |
| Exception inside a renderer (malformed event) | The renderer's `rendering` flag stays `true` forever and later renders silently return `false` | FIX (M20): `try/finally`; skip malformed events defensively |

---

## 7. Known bugs and quirks

| ID | Quirk | Decision |
|---|---|---|
| M1 | The simulation renderer and its "Simulated FIFO order" row are dead (`display: none`, never constructed). | **PRESERVE** the invisibility; do not render it. Porting the class is optional. |
| M2 | `config.collapsed` is unused. `#multiplexing-stats` and `#multiplexing-stats-streams` are never filled. | Keep the config field for shape parity. The stats placeholder row can be kept as two empty `col-6` divs (zero height) or dropped. |
| M3 | Duplicate SVG id `clip`. `url(#clip)` resolves to the **first** `#clip` in the document. With the waterfall shown, that is the waterfall's clip rect (`x=-20, width W+20, height = waterfall height`), not the strip's own (`x=0, W x 70`). Panned bars may therefore draw into the left 20 px margin. In multi mode all panels use panel 0's waterfall clip. If that waterfall has 0 streams, its clip height is NaN and **every data-flow strip shows no bars**. Verified in headless Chromium. | **FIX:** a unique clip id per renderer instance. The strip clips to its own `[0,W] x [0,70]`. The visible difference is limited to pan states (bars no longer bleed into the left margin) and the NaN case. |
| M4 | With `showbyteranges` false, the strip still calls `byteRange.render()`. Its container is missing, so `setup()` throws a TypeError (an unhandled rejection) and leaves `rendering = true` for good. Re-enabling "Show byte ranges" then shows a **blank** 520 px row until the panel is re-created. Clicks and zooms also call `zoom()` on stale or undefined closures (`this.updateZoom is not a function`). This always happens to new panels in multi mode. | **FIX:** when the byte-range container is absent, the byte-range renderer is absent too, and calls become no-ops. Re-enabling renders stream 0 normally. |
| M5 | When the new trace has 0 data frames, the byte-range chart is not re-rendered and keeps the previous trace's drawing. | **FIX:** clear the byte-range container. |
| M6 | The byte-range Y axis is `axisRight` after a plain render but `axisLeft` (labels in the 20 px margin, clipped) after any zoom or click. | **PRESERVE.** |
| M7 | The byte-range Y auto-fit window is off by about 2 frames at the start (`startIndex = ceil(d0) + 1`, array indices). When unzoomed, the first two frames are ignored, so stream 0's offset-0 frames are clipped above the plot after a click. | **PRESERVE** (exact index math). It is cosmetic and visible in qvis. |
| M8 | If the selected stream has no frames in the visible window, `startY = Number.MAX_VALUE` and `endY = 0`, giving domain `[1.8e308, 0]`, a garbage Y axis, rects collapsed to the bottom, and a `console.error`. Common when zooming with many streams. | **FIX:** fall back to `[0, maxBytes]` (the render-time domain) and skip the error. |
| M9 | The waterfall x domain is `[1, N]` while the strip and byte-range domain is `[1, N+1]`, so the waterfall is stretched by a factor `N/(N−1)`. That is under 1 px drift for typical N, more for small N. | **PRESERVE** for pixel parity. |
| M10 | The waterfall legend says `Request received` for client traces and `Request sent` for server traces. The direction text belongs to the data, so the request wording is inverted. | **FIX:** `Request sent` (client) and `Request received` (server). The second legend text keeps `directionText` unchanged. |
| M11 | The waterfall legend is anchored at `xDomain(0) = −W/(N−1)`. With few frames it is shifted far left and partly cut off (e.g. W = 1500, N = 5 puts it at −375). | **FIX:** `x0 = Math.max(xDomain(0), −margin.left)`. This is identical to qvis for N ≥ W/20 + 1, i.e. typical traces. |
| M12 | The request circle and the HEADERS square usually share the same index and overlap; the square is drawn over the circle. | **PRESERVE.** |
| M13 | A stream without data frames is drawn as a 4 px bar at `xDomain(−1)`, left of the origin, partly in the margin or invisible. | **PRESERVE.** |
| M14 | There are no legend entries for the square, the triangle, or the strip's marker colors. | **PRESERVE.** (A NEW legend is out of scope.) |
| M15 | Waterfall: `++dataFrameCount` happens before the "stream not found" check, and the `break` then skips the packet's remaining frames. The index space can drift from the strip's, and streams first seen in the data direction never appear. | **PRESERVE** the logic, minus the console noise. |
| M16 | `h3Info` is never null, so the H3 detail line always shows, with `-1.00ms` for events that were not seen. | **PRESERVE.** |
| M17 | `streamDetail` is never cleared. It survives trace changes (per panel index) and checkbox toggles, so details from another trace can show. | **FIX:** clear it when the panel's connection changes. Keep it across checkbox toggles, as qvis does. |
| M18 | A click on the strip does not update the stream details; only waterfall clicks do (source TODO). | **PRESERVE.** |
| M19 | `skipRender` hack: the detail-row change must not re-render the charts or reset the zoom. | **PRESERVE** the semantics. In React, detail state is simply not a dependency of the render effect. |
| M20 | `rendering` guards plus async `render()` without `try/finally`: any exception wedges that renderer for the panel's lifetime. | **FIX:** synchronous renders inside `try/finally`; guard every field read. |
| M21 | Only `vantage_point.type === "server"` selects the server perspective. `network` + `flow: "server"` (and `unknown` + `flow: "server"`) are treated as client, which contradicts main-schema-14 §6 ("flow ... server = packet_sent goes towards the client"). | **FIX:** use the connection perspective: `type === "server"`, or (`type` ∈ {network, unknown} and `flow === "server"`). Client and server traces and network+client traces (pcap-style) are unaffected. Perspectives that stay unknown (no usable `type` or `flow`): DECISION D-MX2 in §9.3. |
| M22 | The tooltip prints raw JS numbers (`359.00000000000006ms`) for time and gap age. qvis-era integer-ms traces looked clean. With latest-draft absolute epoch times minus the trace start, float noise is likely. | **DECISION** (recommended): display `String(Math.round(x * 1000) / 1000)`. This is identical for integer or ≤ 3-decimal inputs. **Revised at the final parity check:** round to 1 ns, `String(Math.round(x * 1e6) / 1e6)`: still removes the float noise, and prints quic-go's ns-precision times digit for digit like qvis (`88.799834ms`; 1 µs rounding printed `88.8ms`). |
| M23 | `data_moved` filter: `from !== "transport" && to !== "application"` → skip (AND). | **PRESERVE.** |
| M24 | `data_moved` is linked to the latest data-direction STREAM frame of the stream, even for server traces, where "moved to application" relates to request data. | **PRESERVE.** |
| M25 | The select-all sort uses `(a,b) => a < b ? -1 : 1`, which never returns 0. In V8 the result is stable for ties in practice (binary insertion for small arrays). | **PRESERVE** the order: a stable sort by `parent.filename` with code-unit comparison (`<`, not `localeCompare`); ties keep load order. |
| M26 | `allowSelectAll` is a URL substring check. | **PRESERVE** (app-shell Q20). |
| M27 | `id="multiplexingToplevelContainer"` repeats per panel, and `getElementById` always measures the first. | **FIX:** use refs (each panel measures itself). There is no visible change, because all panels have the same width. |
| M28 | No resize handling. | **PRESERVE.** |
| M29 | Any prop change (checkbox, trace) fully re-renders the panel: zoom resets and byte ranges go back to stream 0. | **PRESERVE.** |
| M30 | The zoom is attached to the inner `<g>`, so wheel and drag work only over painted elements (bars, markers, axis, label). Empty areas do not zoom; the page scrolls instead. | **PRESERVE** (attach to the same `<g>`). |
| M31 | The byte-range SVG (540 px) overflows its 520 px row by 10 px at the top and bottom. | **PRESERVE** the sizes. |
| M32 | `console.error` is used for routine conditions. | **FIX** (§6.2). |
| M33 | The initial byte-range stream is always 0, even if it has no frames. | **PRESERVE.** |
| M34 | The legend and message text style `font-size: "14"` is unitless; Chrome computes 14 px. | Use `"14px"` (same rendering). |
| M35 | The tooltip uses `innerHTML`, and `packet_number` is the raw file value, which could be a string: an injection vector. | **FIX:** build the tooltip with text nodes and `<br>` elements, or HTML-escape. Numbers go through `u64`. |
| M36 | Waterfall SVG height `NaN` for 0 streams. | **FIX** the NaN; set `height = 150` explicitly, which is what browsers rendered. |
| M37 | `priorityString` follows event order. A PRIORITY_UPDATE before HEADERS gives `FRAME: … -> HEADER: …`. A second HEADERS frame (trailers) overwrites `headersIndex` and `headersTime` and appends again. | **PRESERVE.** |
| M38 | The detail duration is computed from the `toFixed(2)` strings. | **PRESERVE.** |

---

## 8. Porting notes for React

### 8.1 Module breakdown (fits ARCHITECTURE §2 and §4)

```
src/components/multiplexinggraph/
  MultiplexingGraphContainer.tsx        <div className="home"> <Configurator/> <Renderer/> </div>; reads config from configurationStore
  MultiplexingGraphConfigurator.tsx     2.2 + <ConnectionConfigurator/> + <NoTraceAlerts/>; auto-select effect (3.1); selectAll (3.8)
  MultiplexingGraphConfigurator.css     scoped: .mux-configurator .row{padding-bottom:10px} .mux-configurator .btn{margin:0 5px}
  MultiplexingGraphRenderer.tsx         empty stats row (optional), panels (key = index), <div id="multiplexing-packet-tooltip" ref>
  MultiplexingGraphCollapsedRenderer.tsx  one panel (2.4): refs, renderer instances, width calc, streamDetail state, effects
  StreamDetails.tsx                     2.7 text (pure, props: {streamId, data: StreamExtents})
  data/MultiplexingGraphConfig.ts       type + defaults {collapsed:true, showwaterfall:true, showbyteranges:true, connections:[]}
  renderer/MultiplexingGraphDataHelper.ts   isDataStream(id), StreamIDToColor(id) → colorHelper.streamIdToColor(id,"HTTP3")[0]
  renderer/multiplexingData.ts          PURE, no D3/DOM (unit-tested):
      getPerspective(conn): "client" | "server"                           (M21)
      eventNames(p) → {dataEvent, requestEvent, h3Event, directionText}
      classifyArrival(range, t, from, to): ArrivalInfo                     (3.5, verbatim)
      extractCollapsedData(conn) → {dataSent, dataMoved, frameCount, directionText}   (3.3)
      extractWaterfallData(conn) → {streams: Map, h3Infos: Map, dataFrameCount, directionText}   (3.4)
      byteRangeYDomain(allFrames, streamID, xDomain:[d0,d1], maxBytes) → [y0,y1]      (3.7 + M8 fallback)
      waterfallLayout(nStreams) → {minBarHeight, svgHeight, circleWidth}            (3.9, M36)
  renderer/MultiplexingGraphD3CollapsedRenderer.ts
  renderer/MultiplexingGraphD3WaterfallRenderer.ts
  renderer/MultiplexingGraphD3ByterangesRenderer.ts
  renderer/MultiplexingGraphD3SimulationRenderer.ts   (optional, never mounted)
src/views/MultiplexingView.tsx          thin wrapper → <MultiplexingGraphContainer/>
```

### 8.2 Latest-draft extraction (reference implementation sketch)

This is the short version. §9.8 is the complete reference and **supersedes this sketch where they differ** (the
unknown-vantage heuristic, the frame-event fallback and the `to: "network"` rule).

```ts
import { QUIC_EVENTS, HTTP3_EVENTS } from "@/model/names";   // "quic:packet_sent", "quic:packet_received", "quic:stream_data_moved", "http3:frame_created", "http3:frame_parsed"
import { u64, fieldName, fieldValue } from "@/qlog/...";
import { streamFrameDataLength } from "@/qlog/...";   // ecosystem.md §6.6

export function getPerspective(c: QlogConnection): "client" | "server" {
  const vp = c.vantagePoint;
  if (vp?.type === "server") return "server";
  if ((vp?.type === "network" || vp?.type === "unknown") && vp.flow === "server") return "server";   // M21 FIX
  return "client";                                    // §9.3 adds the DECISION heuristic for unknown perspectives
}
export function eventNames(p: "client" | "server") {
  return p === "server"
    ? { dataEvent: QUIC_EVENTS.packet_sent, requestEvent: QUIC_EVENTS.packet_received, h3Event: HTTP3_EVENTS.frame_parsed, directionText: "sent" }
    : { dataEvent: QUIC_EVENTS.packet_received, requestEvent: QUIC_EVENTS.packet_sent, h3Event: HTTP3_EVENTS.frame_created, directionText: "received" };
}
export const isDataStream = (id: unknown) => { const n = u64(id as any); return n !== undefined && n % 4 === 0; };

// STREAM frame fields (3.3 / 3.4):
const sid = u64(f.stream_id);                       // skip the frame if undefined or not a data stream
const offset = u64(f.offset) ?? 0;                  // spec default
const length = streamFrameDataLength(f) ?? 0;       // DECISION 6.3
const packetNumber = u64(data.header?.packet_number);   // may be undefined → tooltip prints "undefined"

// quic:stream_data_moved (3.3 B):
if (!isDataStream(data.stream_id)) skip;
if (data.from !== "transport" && data.to !== "application") skip;    // M23, verbatim
const mOff = u64(data.offset), mLen = u64(data.raw?.length);
if (mOff === undefined || mLen === undefined || mLen === 0) skip;    // silent when additional_info is set

// http3 HEADERS / PRIORITY_UPDATE (3.4 step 1):
if (frame.frame_type === "headers") { id = u64(data.stream_id); for (const h of frame.headers ?? []) if (fieldName(h) === "priority") append("HEADER: ", fieldValue(h)); }
if (frame.frame_type === "priority_update") { if (frame.stream_id === undefined) skip /* push_id only */; id = u64(frame.stream_id); append("FRAME: ", frame.priority_field_value); }
```

Iterate the data model's events in stored order, using the EventParser accessors for full `name`, `data` and
`relativeTime`. Do **not** use a category lookup; the strip and the waterfall scan all events, just like qvis.

### 8.3 D3 renderer classes (imperative; ported line by line; D3 v7)

The classes take container elements (ARCHITECTURE §4) and render **synchronously** inside `try/finally` (M20):

```ts
class MultiplexingGraphD3WaterfallRenderer {
  readonly container: HTMLElement;                               // compared by identity in 8.4
  constructor(container: HTMLElement, onStreamClickedUpper: (d: { stream_id: number; data: StreamExtents }) => void);
  onStreamClicked?: (streamID: string) => void;                  // set by the collapsed renderer (3.6 step 11)
  render(connection: QlogConnection): void;
  dispose(): void;                                               // remove listeners and children
}
class MultiplexingGraphD3CollapsedRenderer {
  constructor(container: HTMLElement, tooltip: HTMLElement);
  axisLocation: "top" | "bottom" = "bottom";
  waterfallRenderer?: MultiplexingGraphD3WaterfallRenderer;
  setByteRangeContainer(el: HTMLElement | null): void;           // (re)creates or drops the inner byte-range renderer (M4)
  render(connection: QlogConnection): void;
  dispose(): void;
}
class MultiplexingGraphD3ByterangesRenderer {
  constructor(container: HTMLElement);
  render(allFrames: FrameDatum[], allDataMoved: MovedDatum[], streamID: number): void;
  zoom(newX: d3.ScaleLinear<number, number>): void;              // no-op before the first render
  clear(): void;                                                 // M5
}
```

Keep everything that defines pixels identical to §3: margins, constants, append order, class names, the zoom target
`<g>`, and the transition durations.

D3 v5 → v7 changes:

- `d3.event.transform` becomes the `event.transform` argument
- `.on("mouseover", (d, i) => …)` becomes `(event, d) => …`, with `event.pageX` and `event.pageY`
- `.on("click", d => …)` becomes `(event, d) => …`
- `d3.select("#" + id)` becomes `d3.select(element)`

Clip ids: generate them per instance, e.g. `mux-clip-${seq}` and `mux-byterange-clip-${seq}` from a module counter.
Do not use `useId()`, whose colons need escaping in `url(#…)` (M3).

Tooltip: the collapsed renderer receives the shared tooltip element. On each render it applies the six inline styles
of 2.6. Its content is built with `textContent` and `<br>` nodes (M35), and times are formatted with the M22 helper.

### 8.4 Panel component lifecycle (replaces `updateRenderers` and `skipRender`)

```tsx
function MultiplexingGraphCollapsedRenderer({ connection, showwaterfall, showbyteranges, tooltipEl }) {
  const topRef = useRef<HTMLDivElement>(null), wfRef = useRef<HTMLDivElement>(null),
        dataRef = useRef<HTMLDivElement>(null), brRef = useRef<HTMLDivElement>(null);
  const [streamDetail, setStreamDetail] = useState<StreamDetail | null>(null);
  const renderers = useRef<{ wf?: WaterfallR; data?: CollapsedR }>({});

  useEffect(() => setStreamDetail(null), [connection]);             // M17 FIX

  useLayoutEffect(() => {
    if (!connection || !topRef.current || !dataRef.current) return;
    const fixed = Math.ceil((topRef.current.clientWidth - 90) * 0.9075) + "px";   // 2.5, per-panel (M27)
    dataRef.current.style.width = fixed;
    if (showwaterfall && wfRef.current) wfRef.current.style.width = fixed;
    if (showbyteranges && brRef.current) brRef.current.style.width = fixed;
    // sketch: create the renderers lazily in renderers.current; recreate the waterfall renderer when wfRef.current's
    // identity changed (the element unmounts with the checkbox). Order matters: waterfall first, then link, then data (3.6 step 11)
    const r = renderers.current;
    r.data ??= new MultiplexingGraphD3CollapsedRenderer(dataRef.current, tooltipEl);
    if (showwaterfall && wfRef.current) {
      if (!r.wf || r.wf.container !== wfRef.current) r.wf = new MultiplexingGraphD3WaterfallRenderer(wfRef.current, d => setStreamDetail(d));
    }
    const data = r.data, wf = r.wf;
    if (showwaterfall && wf) { wf.render(connection); data.waterfallRenderer = wf; } else data.waterfallRenderer = undefined;
    data.setByteRangeContainer(showbyteranges ? brRef.current : null);
    data.render(connection);
  }, [connection, showwaterfall, showbyteranges /* NOT streamDetail: M19 */]);

  useEffect(() => () => { renderers.current.wf?.dispose(); renderers.current.data?.dispose(); }, []);
  // JSX: rows a-h of 2.4 with the same classes and inline styles; omit row e (M1) or keep it display:none
}
```

- The qvis 100 ms `setTimeout` exists only because Vue's `v-if` was not settled. React's layout effect runs after the
  DOM commit, so no delay is needed. If one is kept, clear it on cleanup.
- StrictMode double-invokes effects in development. That is harmless, because every render clears its container.
- `onStreamClickedUpper` calls `setStreamDetail({stream_id, data})`. The swatch color comes from
  `StreamIDToColor(String(stream_id))`.
- In multi mode, render the panels with `key={index}` to mirror qvis (panel 0 is reused). Each panel gets the same
  `tooltipEl`.

### 8.5 Bootstrap 5 pitfalls specific to this page (see app-shell §8.7 for the global overrides)

- **`.row > *` in Bootstrap 5** forces `width: 100%`, padding and `flex-shrink: 0` on **every** direct child of a
  row. In Bootstrap 4, non-column children kept their natural size. Without an override:
  - the configurator `<p>` gets 15 px padding and stops being centered
  - the two checkboxes and the button stack vertically

  Fix with a scoped rule, e.g.
  `.mux-configurator .row > :not([class*="col"]) { width: auto; max-width: none; padding-left: 0; padding-right: 0; flex-shrink: 1; margin-top: 0; }`,
  or render those rows as `d-flex flex-wrap justify-content-center` divs with the same `padding-bottom: 10px`.
- Checkboxes: bootstrap-vue's `custom-control custom-checkbox` (1 rem box, `padding-left: 1.5rem`, checked
  `#007bff`) maps to BS5 `form-check` + `form-check-input` + `form-check-label`. Override the checked color to
  `#007bff` for parity.
- Class renames: `mr-3` → `me-3`, `ml-3` → `ms-3`, `font-weight-bold` → `fw-bold`. `align-items-center`,
  `justify-content-center`, `col-1`, `col-6`, `col-11`, `col-12` and `container-fluid` are unchanged, given the
  app-shell 30 px gutter override.
- `h4`: fix it to 1.5 rem (Bootstrap 5 RFS would scale it); see app-shell §8.7.
- The `#2c3e50` inherited color must reach the SVGs, because the axes use `currentColor`.

### 8.6 Tests

- `multiplexingData.test.ts`:
  - `classifyArrival` with every vector in §3.5, including the type, `timeDifference`, `createdHole` and the resulting
    `currentHead` and `highestReceived`
  - `isDataStream` for 0, 4, 2, 3, 5, `"8"`, undefined
  - `getPerspective` for client, server, network+client, network+server and unknown+server
  - `extractCollapsedData` on a hand-written latest-draft trace: `quic:packet_received` with interleaved STREAM frames
    on 0, 4 and 8, plus frames on 2 and 3 that must be ignored, plus a `max_stream_data` frame. Assert `countStart`s,
    the alternating `index`, the arrival types, and the `quic:stream_data_moved` linkage including the AND rule.
  - `extractWaterfallData`: request order, `requestIndex`/`startIndex`/`stopIndex` in data-frame space; HEADERS with a
    `priority` field; PRIORITY_UPDATE before HEADERS (`"FRAME: u=1 -> HEADER: u=3"`); a push-only PRIORITY_UPDATE
    skipped; the M15 `break`.
  - `waterfallLayout(n)` for n = 0, 1, 13, 26, 29, 30, 31 (154/155/160/164; 150 for 0).
  - `byteRangeYDomain` index math (M7) and the M8 fallback.
- The latest-draft mapping tests in §9.9 (name matching, perspective, accessors, frame-event fallback,
  `quic:stream_data_moved` filter, HTTP/3 field decoding) and the fixture requirements listed there.
- Renderer smoke tests (jsdom): render a fixture and assert the counts of `rect.packet`, `rect.retransmitPacket` etc.,
  the waterfall `g` count, the legend text strings (§3.6, §3.9), and the empty-state text.
- Playwright: load a multi-stream demo, open `#/multiplexing`, and check:
  - three charts are visible, with no console errors
  - hovering a frame shows the tooltip text format
  - clicking a waterfall bar shows the detail line and changes the byte-range color
  - wheel zoom rescales the strip axis and the byte-range chart
  - toggling "Show byte ranges" off and on renders the chart again (M4)
  - `#/multiplexing?multimultiplexing=true` shows the button, and clicking it renders one panel per trace in filename
    order with waterfalls and without byte ranges
  - screenshot for the parity harness

---

## 9. Mapping to latest qlog drafts

This section is the normative mapping from every event and field that qvis's multiplexing graph consumes (section 4)
to draft-ietf-quic-qlog-main-schema-14, quic-events-13 and h3-events-13. Where the editor's copies only clarify, their
union with the published drafts applies (ARCHITECTURE §0). Draft line references point into
`the published draft texts (ietf.org)`: `-13:NNNN` is quic-events-13, `h3-13:NNNN` is h3-events-13 and `main:NNNN` is
main-schema-14. The digests `docs/dev/qlog-spec/{main-schema,quic-events,h3-events,ecosystem}.md` give background.

The labels PRESERVE, FIX, NEW and DECISION have the meanings given at the top of this document. The three new
decisions are D-MX1 (§9.6.1), D-MX2 (§9.3) and D-MX3 (§9.4.5); §9.10 summarises them.

### 9.1 Matching policy and what it means for real files

1. Compare `ev.fullName` against `QUIC_EVENTS.*` and `HTTP3_EVENTS.*` from `src/model/names.ts`. `fullName` is the
   name exactly as logged (ARCHITECTURE §3.1: no alias table). Never compare `ev.type` alone. A type-only match, as
   qvis did, would also pick up `transport:packet_received` from non-conforming quic-go files and
   `http2:frame_created` from the TCP converter. Nothing in the latest drafts needs a type-only match.
2. Read `ev.data` as logged (`data === raw.data`). Every uint64 goes through `u64()`, HTTP fields go through
   `fieldName()` and `fieldValue()`, and the STREAM data length goes through `streamFrameDataLength()` (§9.8).
3. Iterate `conn.getEvents()` in stored order. The data model stable-sorts each connection by resolved time, so
   events with equal timestamps keep their logged order (main-schema-14 §7.1; the editor's copy, #622, explicitly
   allows equal times). The indices therefore match qvis, for example for a HEADERS `http3:frame_created` logged at
   the same millisecond as the `quic:packet_sent` that carries it.

Visible result per kind of input:

| Input | What the panel shows | Same as qvis? |
|---|---|---|
| A conforming latest-draft trace (`tools/qloggen` demos, quiche ≥ 0.27, neqo, quinn, mvfst) | The full view | Yes, for the same connection |
| quic-go master as written (`transport:packet_*`, `recovery:*`, `security:*`), for example `tests/fixtures/quic-go/*.sqlog` | The QUIC events are non-conforming, so the loader raises toast DM3 (ARCHITECTURE §3.1). The panel renders like "Trace without events" (§6.3): a single centered `1` tick and the axis label, the waterfall message, and a cleared byte-range chart | No, by product decision (ARCHITECTURE §0). quic-go adds `qlog_version: "0.3"` so that qvis opens the file (ecosystem §0), and qvis then type-matches `transport:packet_*` and reads the top-level STREAM `length` |
| Conforming `http3:*` events but non-conforming QUIC events | h3 info is collected but no stream ever exists, so the panel looks like the row above | — |
| TCP converter output (`tcp:`, `tls:`, `http2:` namespaces) | Empty, as in qvis: qvis matched `transport:packet_*` by type, but TCP packets carry no `frames` | Yes |
| TraceError placeholder (`isError`, zero events, title `ERROR`) | Like "Trace without events" | Yes |
| Sequence-diagram generated sibling (`conn.clone()`: `packet_sent` and `packet_received` swapped, every other type becomes `ignoreseq`) | Matched through its transformed `fullName`, so it renders from the other perspective without H3 markers and without moved rects | Yes |

**PRESERVE:** this page adds no capability message of its own (main-schema digest P15); qvis showed none. Toast DM3
is the only hint that names were non-conforming.

### 9.2 Event names

| qvis (old name, matched by type) | Perspective (§9.3) | Latest full name | Constant (`src/model/names.ts`) | Role |
|---|---|---|---|---|
| `packet_received` (category `transport`) | client | `quic:packet_received` | `QUIC_EVENTS.packet_received` | data direction |
| `packet_sent` | server | `quic:packet_sent` | `QUIC_EVENTS.packet_sent` | data direction |
| `packet_sent` | client | `quic:packet_sent` | `QUIC_EVENTS.packet_sent` | request direction |
| `packet_received` | server | `quic:packet_received` | `QUIC_EVENTS.packet_received` | request direction |
| `frame_created` (category `http`) | client | `http3:frame_created` | `HTTP3_EVENTS.frame_created` | HEADERS and PRIORITY_UPDATE |
| `frame_parsed` (category `http`) | server | `http3:frame_parsed` | `HTTP3_EVENTS.frame_parsed` | HEADERS and PRIORITY_UPDATE |
| `data_moved` in any category (`http:` in draft-02, `transport:` in later pre-final drafts) | both | `quic:stream_data_moved` | `QUIC_EVENTS.stream_data_moved` | byte-range "moved" rects |
| dead simulation: `lookup(http, frame_created \| frame_parsed)` | client / server | `conn.lookup(NS.http3, HTTP3.frame_created)` / `conn.lookup(NS.http3, HTTP3.frame_parsed)` | `NS`, `HTTP3` | not rendered (M1) |
| none | client data, server request | `quic:frames_parsed`, then `quic:frames_processed` | `QUIC_EVENTS.frames_parsed`, `QUIC_EVENTS.frames_processed` | fallback source, DECISION D-MX1 (§9.6.1) |
| none | client request, server data | `quic:frames_created` | `QUIC_EVENTS.frames_created` | fallback source, D-MX1 |

Importance levels (main-schema-14 §8.3; quic-events-13 Table 1; h3-events-13 Table 1):

- `quic:packet_sent`, `quic:packet_received`, `http3:frame_created` and `http3:frame_parsed` are **Core**, so
  conforming producers SHOULD log them, and the strip and the waterfall work for them.
- `quic:stream_data_moved` is only **Base**, and quic-go does not emit it. The black "moved" rects are therefore
  often absent, as they were for most qvis-era traces.
- The `quic:frames_*` events are **Extra**.

Names that this view must **never** match:

- `http:*`: in the latest drafts this namespace is the HTTP Capsule Protocol (h3-events-13 §5), not HTTP/3.
- `http3:priority_updated`: not parity (§9.7).
- `quic:packet_lost` and `quic:marked_for_retransmit`: their `frames` are not received or sent data, and the frames
  of `marked_for_retransmit` "may never appear on the wire".
- `quic:packet_dropped` and `quic:packet_buffered`: a buffered packet is logged again as `quic:packet_received` with
  `trigger: "keys_available"` (-13 §5.6), which carries its frames once.

### 9.3 Perspective (direction) from the latest VantagePoint

main-schema-14 §6 (main:789-866) defines the vantage point:

- `VantagePoint = {? name: text, type: "client" / "server" / "network" / "unknown", ? flow: "client" / "server" /
  "unknown"}`.
- `vantage_point` itself is optional on a trace.
- `flow` "is only required if the type is "network"". It says whose data-flow semantics "packet sent" follows.
- For `"unknown"`, tools "can either try to heuristically infer the semantics from protocol-level domain knowledge
  (e.g., in QUIC, the client always sends the first packet) or give the user the option to switch between client
  and server perspectives manually".

The data model replaces a missing or type-less vantage point with `{type: "unknown", flow: "unknown", name: "No
VantagePoint set"}` and keeps unknown `type` strings verbatim (data-model §3.16.6). `conn.getVantagePointPerspective()`
(data-model §3.3.3) returns `type` when it is `client` or `server`, otherwise `flow` if present, otherwise
`"unknown"`.

| `type` | `flow` | qvis | qvis-react | Label |
|---|---|---|---|---|
| `server` | any | server | server | PRESERVE |
| `client` | any | client | client | PRESERVE |
| `network`, `unknown` or a non-standard string | `server` | client | server | FIX (M21) |
| `network`, `unknown` or a non-standard string | `client` | client | client | PRESERVE |
| `network`, `unknown`, a non-standard string, or the loader default | absent, `unknown` or a non-standard string | client | heuristic, falling back to client | DECISION D-MX2 |

**D-MX2 (recommended: on).** Scan the events in stored order. The first event whose `fullName` is `quic:packet_sent`
means client; the first that is `quic:packet_received` means server. If neither exists, use client.

- Why: quinn always writes `type: "unknown"` (ecosystem §0, §3.4). With the qvis rule, a quinn server trace would
  treat the client's request uploads as "data" and the server's responses as "requests". The waterfall would then hit
  the M15 `break` on almost every packet.
- Every trace that qvis could render correctly (explicit client or server, or network with a flow) is unaffected.
- No UI indicator is added; qvis had none.
- The alternative is strict parity: always client.
- The sequence diagram's unknown-vantage guess only renames `vantagePoint.name` (data-model §2.3). The rename shows in
  this page's h4 (PRESERVE), but `type` does not change, so this page must not rely on it.

Event names derived from the perspective (subject to §9.6.1 for the two packet directions):

| | client | server |
|---|---|---|
| `dataEvent` | `quic:packet_received` | `quic:packet_sent` |
| `requestEvent` | `quic:packet_sent` | `quic:packet_received` |
| `h3Event` | `http3:frame_created` | `http3:frame_parsed` |
| `directionText` (axis label, legend) | `received` | `sent` |

### 9.4 Field mapping per consumer

#### 9.4.1 Data-direction STREAM frames (data-flow strip, byte ranges, waterfall bars)

Event: `dataEvent` (§9.3, §9.6.1). quic-events-13 §5.5-5.6 (-13:1164-1265) defines
`QUICPacketSent/Received = {header: PacketHeader, ? frames: [* $QuicFrame], ? raw, ? datagram_id, ? trigger, ...}`.
`StreamFrame = {frame_type: "stream", stream_id: uint64, ? offset: uint64 .default 0, ? fin: bool .default false,
? raw: RawInfo}` (-13 §8.13.9, -13:3010-3037).

| qvis read | Latest path | Type and default | When absent or invalid | Notes |
|---|---|---|---|---|
| `data.frames` (non-empty array) | `data.frames` | optional `[* $QuicFrame]` | not an array, or empty: the event contributes no frames | Producers may log frames in separate frame events instead (§9.6.1) |
| each frame (no shape check) | `frames[i]` | `$QuicFrame` may be any map (-13 §8.13) | not an object: skip the frame | FIX: qvis threw on `null` |
| `frame.frame_type === "stream"` | `frame.frame_type === "stream"` | literal | any other value, including unknown or extension types: skip | `reset_stream_at`, `datagram` and extension frames such as `ack_frequency` are skipped, just as qvis skipped every non-STREAM frame |
| `frame.stream_id` (`undefined` check, then `parseInt`) | `u64(frame.stream_id)` | uint64, required; a JSON number or a decimal string (main-schema-14 §11.3; mvfst writes strings) | `undefined`: skip the frame | |
| `isDataStream` | `sid % 4 === 0` | | | Client-initiated bidirectional streams (RFC 9000 §2.1) are the HTTP/3 request streams (RFC 9114 §6.1; h3-events-13 §3.3: "Client bidirectional streams always have a stream_type value of "request"") |
| `parseInt(frame.offset, 10)` | `u64(frame.offset) ?? 0` | `.default 0` | absent: 0, the spec default. Present but not a decimal uint64: also 0 | FIX: qvis's NaN broke the classification |
| `parseInt(frame.length, 10)` (collapsed) and `parseInt(length, 0)` (waterfall `totalData`) | `streamFrameDataLength(frame)`, i.e. `u64(raw.payload_length) ?? u64(raw.length) ?? …` (ecosystem §6.6; §9.6.5) | `? raw: RawInfo`. -13: "If the stream frame contains a length field, it MUST be logged in the qlog raw.length field. If it does not, the implementation MAY calculate the actual frame byte length itself and log that in raw.length if necessary." | no length: 0 (DECISION, §6.3). The frame still occupies one slot on the frame axis, with `to = offset − 1` | Never derive the length from `raw.data`: it holds the whole frame including the frame header and may be truncated (main-schema-14 §11.4). Only read `raw` when it is an object (a legacy hex string has a `.length` too). The same value feeds the datum `length`, the byte range and `totalData`, so the detail line never shows `NaN bytes` |
| `data.header.packet_number` | `u64(data.header?.packet_number)` | `PacketHeader.packet_number?: uint64`, optional even for numbered packet types (-13 §8.8, -13:2602-2690) | `undefined`: the tooltip prints `packet number undefined` (PRESERVE) | `header` is required by the CDDL but guard it anyway (M20). The packet number space is not logged and not needed here. For frame-event sources: `u64(data.packet_numbers?.[i])` (§9.6.1) |
| `frame.fin` | not read | `.default false` | | PRESERVE: a FIN-only frame has length 0, so `to = offset − 1` lies inside the filled data and it classifies Duplicate (§3.5) |
| event time | `ev.relativeTime` | ms | | §9.4.8 |

The byte range `[offset, offset + length − 1]` (inclusive) means the same as in draft-02. The frame-event example at
-13:1663-1674 shows offsets advancing by `raw.length`, which confirms that `raw.length` is the STREAM data length.

#### 9.4.2 Request-direction STREAM frames (waterfall stream creation)

Event: `requestEvent`. Same accessors as 9.4.1, but only `frame_type`, `stream_id` and the event time are read. The
first request-direction STREAM frame of a stream sets `order`, `requestIndex = dataFrameCount` and `requestTime`.
Later request-direction STREAM frames of that stream are ignored (PRESERVE). Offset, length and packet number are not
read in this direction.

In a client trace this is the first `quic:packet_sent` that carries a STREAM frame on the request stream, i.e. the
start of its HEADERS frame. It can be a `0RTT` packet; it counts, because there is no packet-type filter. In a server
trace it is the first `quic:packet_received` with that stream.

#### 9.4.3 HTTP/3 HEADERS (waterfall square and detail line)

Event: `h3Event`. h3-events-13 §3.5-3.6 defines `HTTP3FrameCreated/Parsed = {stream_id: uint64, frame: $HTTP3Frame}`.
§4.2.2 defines `HTTP3HeadersFrame = {frame_type: "headers", headers: [* HTTP3HTTPField], ? raw}` and
`HTTP3HTTPField = {? name: text, ? name_bytes: hexstring, ? value: text, ? value_bytes: hexstring}`.

| qvis read | Latest path | Type | When absent or invalid | Notes |
|---|---|---|---|---|
| `data.frame` truthy | `data.frame` is an object | `$HTTP3Frame` may be any map | skip the event | |
| `frame_type === "headers"` | same | literal | | |
| `parseInt("" + data.stream_id)` | `u64(data.stream_id)` | uint64, required | `undefined`: skip the event (qvis: NaN, silently dropped) | For HEADERS, `data.stream_id` is the request stream itself |
| `for (header of data.frame.headers)` | `Array.isArray(frame.headers) ? frame.headers : []` | required array | treated as `[]`: index and time are still set, no priority text is added | FIX: qvis threw a TypeError |
| `header.name === "priority"` | `fieldName(h) === "priority"` | `name` (text) or `name_bytes` (hex) | an entry with neither: no match | Exact and case-sensitive. HTTP/3 field names are lowercase (RFC 9114 §4.2). `name_bytes` is decoded as Latin-1, e.g. `7072696f72697479` |
| `header.value` | `fieldValue(h)` | `value`, `value_bytes`, or neither ("MAY include a value or value_bytes field or neither") | `undefined`: the text becomes `HEADER: undefined` (PRESERVE qvis's string concatenation) | An RFC 9218 Structured Field such as `u=3, i`, shown raw |
| event time | `ev.relativeTime` | | | |

Notes:

- `frame_created` is emitted when the frame is created, not necessarily when it is handed to QUIC (h3-events-13
  §3.5). `frame_parsed` usually follows the `quic:packet_received` that carried the frame header (h3-events digest
  §2.1). The index semantics (`headersIndex = dataFrameCount` at that moment) are unchanged; see M12.
- A second HEADERS frame on the same stream (trailers) overwrites the index and time and appends again (M37,
  PRESERVE).
- Response HEADERS are not read, as in qvis: `frame_parsed` in a client trace, `frame_created` in a server trace.

#### 9.4.4 HTTP/3 PRIORITY_UPDATE (waterfall triangle)

h3-events-13 §4.2.10 (h3-13:957-970) defines `HTTP3PriorityUpdateFrame = {frame_type: "priority_update", ?
stream_id: uint64, ? push_id: uint64, priority_field_value: HTTP3Priority, ? raw}`, with `HTTP3Priority = text`. The
wire types are 0xF0700 for a request stream and 0xF0701 for a push stream (RFC 9218 §7). Only clients send
PRIORITY_UPDATE (RFC 9218 §7), which matches `h3Event`: `frame_created` in client traces and `frame_parsed` in server
traces.

| qvis read | Latest path | When absent or invalid | Notes |
|---|---|---|---|
| `data.frame.element_id` | `u64(data.frame.stream_id)` | absent (push-only frame, or malformed): skip the whole event, with no index and no text | FIX: qvis used a push ID as a stream ID. A push stream is server-initiated and unidirectional (`id % 4 === 3`), so even if the push ID were resolved through `http3:stream_type_set.associated_push_id`, it could never be a waterfall row. Skipping loses nothing visible |
| `data.frame.value` | `data.frame.priority_field_value` | required by the CDDL; if absent, the text becomes `FRAME: undefined` (PRESERVE) | Structured Field text |
| `data.stream_id` (ignored) | `data.stream_id`, the **control** stream (h3-events-13 §3.5-3.6) | ignored | PRESERVE |
| — | no fallback to `element_id` or `value` | | The aioquic-era shape is not a latest-draft shape, and the data is never fixed up (ARCHITECTURE §3.1) |

#### 9.4.5 `data_moved` becomes `quic:stream_data_moved` (byte-range "moved" rects)

quic-events-13 §5.15 (-13:1757-1822):

```cddl
QUICStreamDataMoved = { ? stream_id: uint64, ? offset: uint64, ? from: $DataLocation, ? to: $DataLocation,
                        ? additional_info: $DataMovedAdditionalInfo, ? raw: RawInfo, * $$quic-streamdatamoved-extension }
$DataLocation /= "application" / "transport" / "network"
$DataMovedAdditionalInfo /= "fin_set" / "stream_reset"
```

The draft says: "The raw.length field is used to reflect how many bytes were moved. As this event relates to stream
data only, there are no packet or frame headers and the raw.length field MUST reflect that." With `additional_info`,
"the raw.length field can be omitted or have a zero value". `stream_id` is now optional; draft-02 required it.

The steps keep qvis's order:

| Step | qvis | qvis-react | Label |
|---|---|---|---|
| 1. name | type `data_moved` | `ev.fullName === QUIC_EVENTS.stream_data_moved` | |
| 2. stream | `isDataStream("" + data.stream_id)` | `sid = u64(data.stream_id)`; skip if `undefined` or `sid % 4 !== 0` | PRESERVE |
| 3. direction | skip if `from !== "transport" && to !== "application"` | identical (strict string comparisons; an absent field compares unequal) | PRESERVE (M23) |
| 3b. network | n/a: the value did not exist | also skip if `data.to === "network"`. Given step 3, this changes only `from: "transport", to: "network"` | DECISION D-MX3 (recommended: skip) |
| 4. no frames yet | `console.error`, skip | skip (`console.debug`, M32) | |
| 5. offset | `parseInt(data.offset, 10)`; NaN kept | `u64(data.offset)`; `undefined`: skip | FIX: qvis drew an invisible NaN rect |
| 6. length | `parseInt(data.length, 10)`; only `=== 0` gives `console.error` and a skip | `isObject(data.raw) ? u64(data.raw.length) : undefined`; skip if `undefined` or 0: silently when `additional_info` is set, otherwise with `console.debug` | FIX |
| 7. link | last `dataSent` entry with `"" + streamID === "" + data.stream_id` | last `dataSent` entry with `streamID === sid` (numeric) | FIX: `"08"` would not match 8; otherwise invisible |
| 8. datum | `{streamID, countStart, countEnd, offset, length}` | same | PRESERVE |

Outcome for every `from`/`to` combination (step 3 plus D-MX3):

| `from` \ `to` | `application` | `transport` | `network` | absent |
|---|---|---|---|---|
| `application` | keep | skip | skip | skip |
| `transport` | keep | keep | **skip (D-MX3; the verbatim rule keeps it)** | keep |
| `network` | keep | skip | skip | skip |
| absent | keep | skip | skip | skip |

Why D-MX3: the qvis comment at `MultiplexingGraphD3CollapsedRenderer.ts:469` says "only dealing with data bubbling
up from the transport". `transport → network` is data leaving towards the wire, a send-side event; drawing it as a
"moved" rect misrepresents it. No qvis-era input could contain `network`, so parity is unaffected. The alternative is
the verbatim rule only.

`$DataLocation` is an open socket. Any other string is compared verbatim, so it is neither `transport` nor
`application`.

M24 still applies (PRESERVE): the rect links to the last **data-direction** STREAM frame of the stream, even in server
traces, where `transport → application` moves concern request data. `stream_data_moved` may be logged before the
`frame_parsed` of the same data (h3-events-13 §3); this does not matter, because the link is to STREAM frames.

#### 9.4.6 Dead simulation renderer (optional port)

- Events: `conn.lookup(NS.http3, HTTP3.frame_created)` for a client, `HTTP3.frame_parsed` for a server (§9.3).
- Keep `frame.frame_type === "headers"` and `u64(data.stream_id) % 4 === 0`; `streamID = u64(data.stream_id)`.
- `method` is the **last** `fieldValue(h)` whose `fieldName(h) === ":method"`; `path` likewise with `":path"`.
- Text: `String(method) + " " + String(path)`.
- Still never rendered (M1).

#### 9.4.7 Trace and file metadata

| qvis read | Latest source | Notes |
|---|---|---|
| `connection.vantagePoint.type` | trace `vantage_point` (main-schema-14 §6), with data-model defaults, as `conn.vantagePoint` | §9.3 |
| `getLongName()` inputs: `vantagePoint.name`, `.type`, `.flow`, `title`, `description` | `vantage_point.{name?, type, flow?}`, `Trace.title?`, `Trace.description?` (main-schema-14 §4.2; `TraceSeq` §5 has the same members) | The formula is verbatim (data-model §3.3.4). `group_id` slices are titled `Group <id> : <title>` (data-model §3.16.5). A TraceError placeholder is titled `ERROR` |
| `connection.parent.filename` | `QlogConnectionGroup.filename`, set by the loader | The file name, not the file `title`. A JSON-SEQ file holds exactly one trace (main-schema-14 §5) |
| `store.groups`, `group.getConnections()` | same | Multi-trace mode includes generated siblings (app-shell Q13) |

Not consumed: `event_schemas` (a hint only; main-schema-14 §8, main:1546-1554, says tools MUST NOT treat mismatches as
errors, so never gate this view on it), `common_fields` beyond the time model, `group_id` beyond the split, `tuple`,
`system_info` and `reference_time.wall_clock_time`.

#### 9.4.8 Time

| qvis | Latest | Notes |
|---|---|---|
| `parseEvent(e).relativeTime`, in ms | `ev.relativeTime` (data-model §3.16.3, cases A, R and U). Times are float64 ms (main-schema-14 §1.2: "All timestamps and time-related values (e.g., offsets) in qlog are logged as float64 in the millisecond resolution") | The unit is the same as in qvis, so the Reordered thresholds (`< 20` ms) keep their meaning. Never apply a time-unit multiplier. In case R the values can start far above 0, as in qvis; in case U they start at 0 |
| — | per-event `time_format` (`relative_to_previous_event`) and per-event `reference_time` | Resolved by the data model before this view sees the event; nothing to do here |
| `absoluteTime` of the first and last event (debug `xMSRange`) | — | Not ported |
| integer-ms values (most qvis-era files) | float ms with µs or ns fractions (quiche, quic-go) | Display: M22, `String(Math.round(x * 1e6) / 1e6)` (revised; was 1 µs) in the tooltip; `toFixed(2)` in the detail line, unchanged |

### 9.5 Items with no latest-draft equivalent

| Old item | Status in the latest drafts | Behaviour |
|---|---|---|
| `priority_update.element_id`, `.value` | Replaced by `stream_id` / `push_id` and `priority_field_value` | Read the latest fields only; no fallback (§9.4.4) |
| A push `element_id` treated as a stream ID | A push element is a `push_id`; it has no stream in the waterfall | Skip (§9.4.4) |
| STREAM top-level `length` | `raw.length` (MUST when the frame has a Length field) | `streamFrameDataLength` (§9.6.5) |
| `data_moved.length`, hex `raw` string | `raw.length`; `raw.data` | `raw.length` only (§9.4.5) |
| The `http` category for HTTP/3 frames and `data_moved` | `http` is now the Capsule Protocol; HTTP/3 is `http3`; data movement is a `quic:` event | Never match `http:*` (§9.2) |
| Type-only matching across categories | Categories were removed (main-schema-10, #439); names are `namespace:type` | Full names (§9.1) |
| Two-valued `from`/`to` | Adds `"network"`; open socket | §9.4.5 |
| `absoluteTime` debug range | Still available in the data model | Not ported (debug only) |

Nothing user-visible depends on a field without a latest-draft equivalent.

### 9.6 Latest-draft features that change what this view receives

#### 9.6.1 Frames logged outside packet events (DECISION D-MX1, recommended: on)

quic-events-13 §5.14 (-13:1634-1755) defines `quic:frames_created`, `quic:frames_parsed` and
`quic:frames_processed` (all Extra). Each has `frames: [* $QuicFrame]` and an optional `packet_numbers: [* uint64]`:
"If the packet_numbers field is logged, each and every frame MUST have a corresponding packet number at the same
index." Because `frames` is optional on packet events, a producer that logs STREAM frames only in frame events would
get an empty view under the qvis rules. The editor's copy removes `frames_processed` (quic-events digest §14 E1), but
-13 defines it, so accept it.

```
pickSource(candidates): the first candidate name for which ANY event of the connection with that fullName has a
frames array containing at least one object with frame_type === "stream" (any stream ID); if none: candidates[0].

client: dataEvent    = pickSource([quic:packet_received, quic:frames_parsed, quic:frames_processed])
        requestEvent = pickSource([quic:packet_sent, quic:frames_created])
server: dataEvent    = pickSource([quic:packet_sent, quic:frames_created])
        requestEvent = pickSource([quic:packet_received, quic:frames_parsed, quic:frames_processed])
```

- Compute this once per render. The collapsed and waterfall extractions share it, so `dataFrameCount` stays aligned
  with the strip.
- Use exactly one source name per direction. Never merge packet events and frame events: -13 RECOMMENDS avoiding
  duplicate frame logging but allows it, so merging could double count.
- `frames_parsed` comes before `frames_processed`: a producer that logs both would double count if they were merged,
  and processing "can happen later than parsing", so the parse time is closer to the arrival time.
- The packet number of frame `i` is `u64(data.packet_numbers?.[i])`; `undefined` prints `packet number undefined`.
- Everything else is unchanged: the STREAM accessors, the time (the frame event's `relativeTime`) and
  `directionText`.
- Effect on qvis parity: none for any trace whose packet events carry STREAM frames, which includes every trace qvis
  could display.
- Generated sequence-diagram clones rename frame events to `ignoreseq`, so the clone of a trace that uses a fallback
  source shows nothing. This is acceptable; qvis had no such traces.
- The alternative is strict parity: packet events only.

#### 9.6.2 Optional packet numbers

`header.packet_number` is optional (-13 §8.8). The tooltip prints `packet number undefined` (PRESERVE). Do not derive
packet numbers from other events, except `packet_numbers[i]` when a frame event is the source.

#### 9.6.3 uint64 values as strings

main-schema-14 §11.3 allows uint64 values as JSON strings. Pass every one through `u64()`: `stream_id` (mvfst writes
strings), `offset`, the `raw` lengths, `packet_number` and `packet_numbers[]`. Compare stream IDs numerically.

#### 9.6.4 Optional STREAM offset

`offset` defaults to 0. This mostly affects the first STREAM frame of a stream, which has no Offset field on the wire
(RFC 9000 §19.8, OFF bit unset).

#### 9.6.5 STREAM length precedence

- quic-events-13 §8.13.9: the frame's Length field MUST be logged in `raw.length`. The frame-event example
  (-13:1663-1674) uses `raw.length` as the data length.
- main-schema-14 RawInfo (§10): `length` is the full entity including headers, and `payload_length` is the payload
  without headers. A producer that follows RawInfo literally would put the frame total in `raw.length` and the data
  length in `raw.payload_length`.
- Real producers: quiche writes only `raw.payload_length`; mvfst writes `raw.length`; quic-go writes a top-level
  `length`, which is non-conforming, but its event names are non-conforming as well.
- Hence `raw.payload_length ?? raw.length` (ecosystem §6.6). The shared accessor's further legacy fallback (a
  top-level `length`) only matters for a file with conforming event names and a non-conforming frame field. This
  view uses whatever the shared accessor returns; if the core package drops that fallback under the strict policy,
  nothing here changes.

#### 9.6.6 `$DataLocation` value `"network"`

See D-MX3 in §9.4.5.

#### 9.6.7 `additional_info` on `quic:stream_data_moved`

See §9.4.5, step 6. A `stream_reset` or `fin_set` move with a non-zero length is kept like any other move.

#### 9.6.8 Unknown vantage points

See D-MX2 in §9.3.

#### 9.6.9 Events whose frames must not be counted

The frames in `quic:packet_lost` and `quic:marked_for_retransmit` are not counted, and `quic:packet_dropped` and
`quic:packet_buffered` are not read (§9.2). Full-name matching guarantees this.

#### 9.6.10 Packet types, number spaces and coalescing

There is no packet-type filter (PRESERVE). STREAM frames are only allowed in 0-RTT and 1-RTT packets (RFC 9000 §12.4),
and both count. `datagram_id` and the editor's-copy `datagram_payload_checksum` (coalescing) are not used.

#### 9.6.11 Several connections in one trace

Each `group_id` slice is a separate connection, with its own selector entry and panel. Extraction runs per connection
(data-model §3.16.5). quinn may write several connections into one file.

#### 9.6.12 Tuples and migration

`tuple` (renamed from `path` in main-schema-13) and `quic:tuple_assigned` (renamed from `path_assigned` in
quic-events-12) are ignored. STREAM frames on
every tuple count in arrival order, which suits a multiplexing view; qvis had no path concept.

#### 9.6.13 Ordering of HTTP/3 and QUIC events

`frame_created` HEADERS usually precede the `packet_sent` that carries them, and `frame_parsed` follows the
`packet_received` (h3-events digest §2.1). This is the same as in qvis-era files, so `headersIndex` values match.

### 9.7 New latest-draft information this view could show (not parity; default: not shown)

| Source (latest drafts) | Possible use here | Recommendation |
|---|---|---|
| `reset_stream_at` frame (`stream_id`, `error`, `error_code?`, `final_size`, `reliable_size`; -13 §8.13.5, -13:2932-2956), and `reset_stream` and `stop_sending` on request streams | Mark reset streams in the waterfall; draw `reliable_size` as a line in the byte-range chart | Not in v1 (PRESERVE: qvis drops every non-STREAM frame). If added later, read only the data-direction source |
| `quic:stream_data_moved.additional_info` (`fin_set`, `stream_reset`) | Annotate the last moved rect of the stream | Not in v1 |
| `http3:priority_updated` (Base; `stream_id?`, `push_id?`, `old?`, `new`, `trigger?`, `reason?`; h3-events-13 §3.4) | The effective, merged priority per stream: append `" -> UPDATED: " + new` to `priorityString` | Not in v1. If added: request streams only (`stream_id`), appended in event order as in M37, with no new marker; only the detail text changes |
| `http3:stream_type_set` (`stream_type: "request"`) | Replace the `id % 4 === 0` test | Keep `% 4` (PRESERVE). It is equivalent by RFC 9114 and also works without this Base event |
| `quic:stream_state_updated` (`stream_id`, `new`, `stream_side`; granular states such as `data_read` and `reset_received`) | Mark when the application has consumed the whole stream | Not in v1 |
| `quic:stream_data_blocked_updated` (Extra; `stream_id`, `new: "blocked" / "unblocked"`, `reason`) | Shade flow-control-blocked periods on the waterfall bars | Not in v1. The waterfall x axis is in frame-count space, so a period would have to be mapped to `dataFrameCount` at the event |
| `quic:packet_lost`, `quic:marked_for_retransmit`, `quic:packets_acked`, `quic:packet_sent.trigger` (`retransmit_reordered`, `retransmit_timeout`, `pto_probe`, …) | Server traces only (where data = sent): confirm or label the retransmissions that the byte-range algorithm infers | Not in v1. qvis classifies arrivals purely from byte ranges (§3.5); keep that as the only classifier |
| `quic:recovery_metrics_updated` | Nothing meaningful for this view | Ignore |
| DATAGRAM frames, `quic:datagram_data_moved`, `http3:datagram_created` / `datagram_parsed` (`quarter_stream_id × 4` is the request stream) | HTTP Datagrams belong to a request stream (RFC 9297); they could get a separate lane | Not in v1. They are not stream data and are not on the frame axis |
| `http:capsule_created` / `capsule_parsed` | Capsules inside request-stream DATA | Ignore |
| `quic:tuple_assigned`, event `tuple` | Colour frames by path | Ignore |
| STREAM `fin` | Mark the end of each stream on its bar | Ignore (PRESERVE) |

### 9.8 Reference implementation (normative where §8.2 differs)

```ts
// src/components/multiplexinggraph/renderer/multiplexingData.ts (pure; no D3, no DOM)
import { NS, QUIC, QUIC_EVENTS, HTTP3_EVENTS } from "@/model/names";
import { fieldName, fieldValue, streamFrameDataLength } from "@/qlog/...";   // shared accessors (ecosystem §6.6, h3 §8.1)

export const MUX_OPTIONS = {
  frameEventFallback: true,        // D-MX1 (§9.6.1)
  inferUnknownPerspective: true,   // D-MX2 (§9.3)
  skipMovesToNetwork: true,        // D-MX3 (§9.4.5)
} as const;

const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** uint64 as a JSON number or a decimal string; anything else is undefined (§4, integer parsing). */
export function u64(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
  return undefined;
}
export const isDataStream = (sid: number | undefined): sid is number => sid !== undefined && sid % 4 === 0;

/** §9.3 */
export function getPerspective(conn: QlogConnection, opts = MUX_OPTIONS): "client" | "server" {
  const p = conn.getVantagePointPerspective();          // type client/server, else flow, else "unknown"
  if (p === "client" || p === "server") return p;       // includes the M21 FIX for network/unknown + flow
  if (opts.inferUnknownPerspective) {                   // D-MX2: "the client always sends the first packet"
    for (const ev of conn.getEvents()) {
      if (ev.fullName === QUIC_EVENTS.packet_sent) return "client";
      if (ev.fullName === QUIC_EVENTS.packet_received) return "server";
    }
  }
  return "client";                                      // qvis default
}

const hasStreamFrame = (ev: QlogEvent) =>
  Array.isArray(ev.data?.frames) && ev.data.frames.some((f: unknown) => isObject(f) && f.frame_type === "stream");

/** §9.6.1: candidate event TYPES in the quic namespace, in priority order */
function pickSource(conn: QlogConnection, types: readonly string[], fallback: boolean): string {
  const t = fallback ? (types.find((ty) => conn.lookup(NS.quic, ty).some(hasStreamFrame)) ?? types[0]) : types[0];
  return `${NS.quic}:${t}`;
}

export interface MuxEventNames { dataEvent: string; requestEvent: string; h3Event: string; directionText: "received" | "sent"; }

export function eventNames(conn: QlogConnection, opts = MUX_OPTIONS): MuxEventNames {
  const fb = opts.frameEventFallback;
  const receiveSide = [QUIC.packet_received, QUIC.frames_parsed, QUIC.frames_processed];
  const sendSide = [QUIC.packet_sent, QUIC.frames_created];
  return getPerspective(conn, opts) === "server"
    ? { dataEvent: pickSource(conn, sendSide, fb), requestEvent: pickSource(conn, receiveSide, fb),
        h3Event: HTTP3_EVENTS.frame_parsed, directionText: "sent" }
    : { dataEvent: pickSource(conn, receiveSide, fb), requestEvent: pickSource(conn, sendSide, fb),
        h3Event: HTTP3_EVENTS.frame_created, directionText: "received" };
}

/** §9.4.1. undefined = skip this frame. The caller still uses frames[i]'s index i for packetNumberOf(). */
export function readDataStreamFrame(f: unknown): { sid: number; offset: number; length: number } | undefined {
  if (!isObject(f) || f.frame_type !== "stream") return undefined;
  const sid = u64(f.stream_id);
  if (!isDataStream(sid)) return undefined;
  return { sid, offset: u64(f.offset) ?? 0, length: streamFrameDataLength(f) ?? 0 };   // the accessor must ignore a non-object raw
}

/** §9.4.1 / §9.6.1 */
export function packetNumberOf(ev: QlogEvent, frameIndex: number): number | undefined {
  if (ev.fullName === QUIC_EVENTS.packet_sent || ev.fullName === QUIC_EVENTS.packet_received) {
    return u64(isObject(ev.data?.header) ? ev.data.header.packet_number : undefined);
  }
  return u64(Array.isArray(ev.data?.packet_numbers) ? ev.data.packet_numbers[frameIndex] : undefined);
}

/** §9.4.5 steps 2, 3, 3b, 5 and 6. The caller does step 4 (dataSent empty), step 7 (link) and step 8 (push). */
export function readStreamDataMoved(d: any, opts = MUX_OPTIONS): { sid: number; offset: number; length: number } | undefined {
  const sid = u64(d?.stream_id);
  if (!isDataStream(sid)) return undefined;
  if (d.from !== "transport" && d.to !== "application") return undefined;   // M23, verbatim
  if (opts.skipMovesToNetwork && d.to === "network") return undefined;      // D-MX3
  const offset = u64(d.offset);
  const length = isObject(d.raw) ? u64(d.raw.length) : undefined;
  if (offset === undefined || length === undefined || length === 0) return undefined;   // silent if d.additional_info
  return { sid, offset, length };
}

/** §9.4.3 and §9.4.4. The caller appends "HEADER: " / " -> HEADER: " and "FRAME: " / " -> FRAME: " exactly as in §3.4. */
export type H3RequestFrame =
  | { kind: "headers"; sid: number; priorities: string[] }
  | { kind: "priority_update"; sid: number; value: string };
export function readH3RequestFrame(d: any): H3RequestFrame | undefined {
  const fr = d?.frame;
  if (!isObject(fr)) return undefined;
  if (fr.frame_type === "headers") {
    const sid = u64(d.stream_id);
    if (sid === undefined) return undefined;
    const headers: unknown[] = Array.isArray(fr.headers) ? fr.headers : [];
    const priorities = headers
      .filter((h): h is Record<string, any> => isObject(h) && fieldName(h) === "priority")
      .map((h) => String(fieldValue(h)));                                   // "undefined" when absent (PRESERVE)
    return { kind: "headers", sid, priorities };
  }
  if (fr.frame_type === "priority_update") {
    const sid = u64(fr.stream_id);
    if (sid === undefined) return undefined;                                // push_id only: skip (§9.4.4)
    return { kind: "priority_update", sid, value: String(fr.priority_field_value) };
  }
  return undefined;
}
```

How the extraction loops (§3.3, §3.4) use these, unchanged otherwise:

- Collapsed (§3.3 A): `if (ev.fullName === names.dataEvent)`, then for each `i`, `f` of `ev.data.frames`:
  `const s = readDataStreamFrame(f); if (!s) continue;` then classify with `from = s.offset` and
  `to = s.offset + s.length − 1`, and push the datum with `packetNumber: packetNumberOf(ev, i)`.
- Collapsed (§3.3 B): `else if (ev.fullName === QUIC_EVENTS.stream_data_moved)`, then `readStreamDataMoved` and
  steps 4, 7 and 8.
- Waterfall step 1: `if (ev.fullName === names.h3Event) { const h = readH3RequestFrame(ev.data); … }`. `frame_type`
  values other than `headers` and `priority_update` change nothing, as in qvis.
- Waterfall step 2: `if (ev.fullName !== names.requestEvent && ev.fullName !== names.dataEvent) continue;` then the
  STREAM frames through `readDataStreamFrame`, with `totalData += s.length`. Keep the `++dataFrameCount` and `break`
  semantics of M15 exactly. A frame that `readDataStreamFrame` rejects is a `continue`, as in qvis.

### 9.9 Tests (latest-draft mapping)

- **Name matching:**
  - A trace with `transport:packet_received` STREAM frames yields zero frames. The same trace renamed to `quic:`
    yields the frames.
  - STREAM frames inside `quic:packet_lost` and `quic:marked_for_retransmit` are not counted.
  - `http:frame_created` HEADERS are ignored.
- **Perspective:**
  - client; server; network+client; network+server; unknown+server (M21).
  - unknown without flow, first packet event `quic:packet_received` → server; first `quic:packet_sent` → client;
    no packet events → client.
  - `type: "Server"` (wrong case) → unknown → heuristic.
  - With `inferUnknownPerspective: false` → always client.
- **STREAM accessors:**
  - `offset` absent → 0.
  - `stream_id: "8"` → 8; `stream_id: ""` → skipped; `stream_id: 2` → skipped.
  - `raw: {payload_length: 1200}` → 1200; `raw: {length: 1200}` → 1200; `raw: {length: 1213, payload_length: 1200}`
    → 1200.
  - No `raw` → length 0, giving the range `[offset, offset − 1]`.
  - `raw: {data: "abcd"}` only → 0 (not derived); `raw: "abcd"` (legacy string) → 0, not 4.
- **Packet numbers:** an absent `packet_number` gives a tooltip containing `packet number undefined`;
  `packet_number: "12"` → `12`.
- **D-MX1:**
  - A client trace with frame-less `quic:packet_received` plus `quic:frames_parsed` STREAM frames with
    `packet_numbers` builds `dataSent` from `frames_parsed`, with packet numbers from `packet_numbers`.
  - A trace with STREAM frames in both packet events and `frames_parsed` uses only the packet events (no double
    count).
  - `frames_processed` is used only when `frames_parsed` has no STREAM frames.
  - The waterfall and the strip report the same `N`.
- **`quic:stream_data_moved`:**
  - Every cell of the §9.4.5 combination table.
  - `transport → network` is skipped with D-MX3 and kept with `skipMovesToNetwork: false`.
  - `additional_info: "fin_set"` without `raw` → skipped, with no console output above debug.
  - `raw: "abcd"` → skipped; `offset` absent → skipped.
  - `stream_id: "8"` links to stream 8's frames.
- **HTTP/3:**
  - `{name_bytes: "7072696f72697479", value: "u=1"}` → `HEADER: u=1`.
  - `headers` absent → no throw, `headersIndex` and `headersTime` set.
  - `value` absent → `HEADER: undefined`.
  - `{frame_type: "priority_update", stream_id: 4, priority_field_value: "u=1, i"}` → `FRAME: u=1, i`.
  - `push_id` only → nothing.
  - Legacy `{element_id: 8, value: "u=1"}` → ignored (no fallback).
- **Fixtures:**
  - `tests/fixtures/quic-go/*.sqlog` are non-conforming: `transport:*` names, top-level STREAM `length`, no `http3:*`
    and no `quic:stream_data_moved` events. They must render the empty panel and trigger DM3, with no console errors.
  - The latest-draft fixtures produced by `tools/qloggen` must contain `quic:` names, STREAM `raw.length`, and
    `http3:frame_created` / `frame_parsed` HEADERS frames with a `priority` field. At least one client trace must
    contain a PRIORITY_UPDATE.
  - quic-go does not emit `quic:stream_data_moved`. Add a small hand-written latest-draft fixture for the moved rects
    (`from: "transport", to: "application"`, `raw.length`).
  - Add an offline conversion of `parallel_10_50KB_f5.qlog` to check the §3.4 sanity values.

### 9.10 Decisions introduced by this section

| ID | Decision | Recommended default | Alternative | Visible for qvis-era-equivalent traces? |
|---|---|---|---|---|
| D-MX1 | Use `quic:frames_*` events when the packet events of a direction carry no STREAM frames (§9.6.1) | on | packet events only | no |
| D-MX2 | Infer the perspective from the first packet event when `type`/`flow` give none (§9.3) | on | always client (qvis) | only for unknown-vantage server traces |
| D-MX3 | Skip `quic:stream_data_moved` with `to: "network"` (§9.4.5) | skip | verbatim AND rule only | no (the value did not exist) |

Existing decisions that also concern latest-draft input: §6.3 (STREAM frame without a length counts as length 0) and
M22 (tooltip time rounding). The three options are constants in `MUX_OPTIONS`, not UI.

Events this subsystem consumes, by latest name:

- `quic:packet_received`, `quic:packet_sent`: `data.frames[]` STREAM `stream_id`, `offset`, `raw.payload_length` /
  `raw.length`; `data.header.packet_number`
- `http3:frame_created`, `http3:frame_parsed`: `data.stream_id`; `data.frame.frame_type`; HEADERS
  `frame.headers[]` (`name` / `name_bytes`, `value` / `value_bytes`); PRIORITY_UPDATE `frame.stream_id`,
  `frame.push_id` (skip only), `frame.priority_field_value`
- `quic:stream_data_moved`: `stream_id`, `offset`, `from`, `to`, `additional_info`, `raw.length`
- D-MX1 fallbacks `quic:frames_parsed`, `quic:frames_processed`, `quic:frames_created`: `data.frames[]` STREAM
  fields as above; `data.packet_numbers[]`
- trace metadata: `vantage_point.{name, type, flow}`, `title`, `description`; group `filename`; `ev.relativeTime`

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`). Where this addendum contradicts the body, **this addendum wins**.

### X1. STREAM data length: no top-level fallback (G11): amends §9.4.1 and §9.6.5

`streamFrameDataLength(f) = u64(f.raw?.payload_length) ?? u64(f.raw?.length)`. The "shared accessor's further
legacy fallback (a top-level `length`)" mentioned in §9.6.5 does not exist (data-model addendum M3). A STREAM frame
without `raw` lengths counts as length 0 (§6.3 decision, unchanged).

### X2. Demo content this view needs (G5)

Raw quic-go output has no `http3:*` events and no `quic:stream_data_moved`, and it uses pre-final names. On it this
page shows the empty panel (§9.1, the quic-go row), which is correct. To show what qvis's
`DEMO_10_parallel_streams` showed (waterfall with HEADERS squares, detail line, byte ranges with "moved" rects), the
generated demo set must contain the following (file-loading addendum F2, items 1-4):

- `quic:packet_*` with STREAM frames carrying `raw.length`
- `http3:frame_created`/`frame_parsed` HEADERS (`:method`, `:path`, optionally `priority`)
- `quic:stream_data_moved` (`transport` → `application`)

### X3. Console levels (G13; policy in app-shell addendum A5)

M32 (§6.2) already satisfies the project-wide policy: every qvis `console.error` of this view becomes `console.debug`
(or one `console.warn` summary per render). No further change.

### X4. Same-data parity check against hosted qvis (2026-11-01)

Method: hosted qvis (https://qvis.quictools.info) loaded the draft-02 conversions
(`tests/fixtures/legacy/*.draft02.qlog`, uploaded under the original file names), qvis-react loaded the latest-draft
originals (`public/examples/*`, plus `sqlog-to-qlog` copies of the `tests/fixtures/latest/multiplexing-*`,
`stats-h3_client` and `congestion-small-server` fixtures against `latest-to-legacy` copies). Same viewport (1600 x 1000,
also 800, 1280 and 1920 wide, and devicePixelRatio 2), same trace, same gestures. Compared: every SVG element
(attributes, text, computed font, bounding box), every panel row and configurator element (geometry, text, computed
styles incl. focus/hover/pressed states), the tooltip of **every** frame, the detail line and byte-range chart after a
click on **every** waterfall bar, hover/click/wheel/drag/double-click/shift-double-click/pan-then-click, wheel over
unpainted areas, the axis, the byte-range chart and the waterfall (page scrolls), both checkboxes off/on, trace
switching, tab switching, window resize, multi-trace mode, file removal, and pixel diffs of all screenshots.

Result: identical on all demos (new_cid, 10_parallel_streams, doublevantage_100ms, multistream_loss, baseline,
massive_client, massive_server; client and server), except for the intended FIX items below and three differences
that were fixed:

- **Fixed (PRESERVE d3 v5 rendering):** d3-axis v3 drops the 0.5 px crisp-line offset when `devicePixelRatio > 1`, so
  on retina screens every axis line and tick of the strip and the byte-range chart sat half a CSS pixel left/up of
  qvis's. All axes now use `axis.offset(0.5)` (`v5Axis`), identical to d3-axis v1 at every DPR.
- **Fixed (PRESERVE d3 v5 gestures, replaces the "acceptable" note in §3.6 step 9):** d3-zoom v3 zooms the strip on
  ctrl+wheel, i.e. on a trackpad pinch, ten times faster than a wheel step; d3-zoom v1 (qvis) filters ctrl events out
  and leaves the pinch to the browser. The strip zoom now uses the d3-zoom v1 `filter`, `wheelDelta` and `touchable`
  (`withV5ZoomGestures`).
- **Fixed (PRESERVE Bootstrap 4.3.1):** "Load all connections at once" shows the focus ring
  (`0 0 0 .2rem rgba(38,143,255,.5)`) after a mouse click until it loses focus, and a keyboard-focused button keeps
  its normal colours (Bootstrap 5 shows the ring only on `:focus-visible` and switches to the hover colours). Scoped to
  this configurator in `MultiplexingGraph.css` §4 at first; at integration the rule moved to `src/styles/global.css`
  (app-shell A7) and now covers every button in every view.

Intended differences seen on the same data (no change): M10 legend wording; M11 legend anchoring for small N
(hand-written fixture); M22 tooltip times rounded (now to 1 ns, see the M22 row: `88.799834ms` as in qvis, and `44.653917ms`
where qvis prints the float noise `44.653917000000035ms`); M3 the strip clips to its own
`[0,W]` (qvis, with the waterfall shown, used the waterfall's clip: the first frame's 0.3 px left padding showed as a
faint 1 px column at the strip's left edge, and panned bars bled into the 20 px left margin); M4 byte ranges render
again after "Show byte ranges" is re-ticked (qvis: blank row, and in multi-trace mode for every new panel); M8 sane
Y axis when the selected stream has no frame in the zoom window (qvis: `1.6e+308` ticks, seen on new_cid); M17 the
detail line is cleared on a trace switch; app-shell Q11 removing the selected file re-selects instead of keeping the
removed trace; §9.4.5 a `quic:stream_data_moved` without a length draws nothing (qvis drew an invisible NaN rect);
negative rect sizes are clamped to 0 (invisible either way); M32 no console errors (qvis logs `DUPLICATE FOUND VIA
FILLED!`, `data moved but no stream frames seen yet`, negative-height errors and, with byte ranges off, page errors).
