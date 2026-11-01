# Parity spec: sequence-diagram (`#/sequence`)

Source of truth: qvis `visualizations/` (quiclog/qvis master, the same checkout used by `app-shell.md` and
`file-loading.md`). All `path:line` citations are relative to
`visualizations/` of [quiclog/qvis](https://github.com/quiclog/qvis)
unless absolute.

Files covered (all read completely):

| File | Lines | Role |
|---|---|---|
| `src/views/SequenceDiagram.vue` | 17 | Route view. Renders `<div><SequenceDiagramContainer/></div>`. |
| `src/components/sequencediagram/SequenceDiagramContainer.vue` | 46 | `div.home` with the configurator and the renderer. It passes the store's `sequenceDiagramConfig` object to both as the `config` prop. The `SequenceDiagramSimpleRenderer` line is commented out. |
| `src/components/sequencediagram/SequenceDiagramConfigurator.vue` | 267 | Blue panel: trace selectors, "Add trace", "Time multiplier", alerts. Holds the trace-pairing heuristics. |
| `src/components/sequencediagram/SequenceDiagramRenderer.vue` | 195 | Hosts `div#sequence-diagram > svg#sequence-diagram-svg` and the "Event detail" modal. Reads the focus query params, watches the config and triggers renders. |
| `src/components/sequencediagram/renderer/SequenceDiagramD3Renderer.ts` | 2252 | All layout, matching, time alignment, the mirrored-trace generation, virtualized SVG drawing and the label texts and colors. |
| `src/components/sequencediagram/data/SequenceDiagramConfig.ts` | 31 | Config class: `connections: {connection, timeOffset}[]`, `timeResolution = 1`. |
| `src/components/sequencediagram/SequenceDiagramSimpleRenderer.vue` | 39 | Debug text renderer. **Not mounted** (commented out). Do not port. |
| `src/components/sequencediagram/renderer/SequenceDiagramCanvasRenderer.ts` | 242 | Abandoned canvas experiment: green squares at random x and `alert("Clicked on event!"…)`. **Not used** (instantiation commented out at `SequenceDiagramRenderer.vue:56`). Do not port. |

Imports read for behavior: `src/data/Connection.ts` (clone, perspective, lookup table), `src/data/ConnectionGroup.ts`,
`src/data/QlogEventParser.ts`, `src/data/QlogLoaderV2.ts` (`DirectEventParser`: time model, name setter),
`src/data/QlogSchema02.ts` (enum string values), `src/store/ConfigurationStore.ts`,
`src/components/shared/ConnectionConfigurator.vue` (the shared trace picker, fully specified in `app-shell.md` §2.5),
`src/App.vue` (fonts), and `src/components/packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts:310-322`
(injects hidden frames that this view must skip).

Related specs: `app-shell.md` (menu, notifications, the `ConnectionConfigurator`, quirks Q13, Q15-Q19) and
`file-loading.md` (groups, `filename`, `URL`, `URLshort`, sorting, and the latest-draft time model). Where this
document says "data model", it means the shared trace and event model the loader produces. §3.5.1 lists exactly what
this view needs from it.

Quirk IDs in this document are `SQn` (§7). Each one is marked **PRESERVE** or **FIX**. §9 maps every consumed
event and field to the latest drafts; its decisions are `LDn` (latest-draft fixes) and `Xn` (extensions, EXT-ON or
EXT-OFF).

---

## 1. Overview and user-facing purpose

The sequence diagram is the classic "message sequence chart" view of a QUIC/HTTP3 connection:

- Each selected **trace** (one qlog trace, one vantage point) gets a vertical **timeline**. They sit side by side in
  equal-width columns ("bands"), with the client on the left and the server on the right.
- Time flows **downwards**. Every event is a small green square on its trace's timeline, with its timestamp (ms,
  relative to the earliest trace start) printed next to it.
- Each `packet_sent` is connected to the matching `packet_received` on the neighboring timeline by a diagonal
  **arrow**. Blue arrows go left to right; red arrows go right to left. The arrow carries a rotated label that
  summarizes the packet: the packet type and number, plus one colored chip per QUIC frame (e.g. `ack 1-5`,
  `stream 0 FIN`, `connection_close : clean`).
- When no counterpart is found, the packet is assumed **lost**. It gets a half-length arrow ending in a red **X**.
- Every other event (metrics, state changes, HTTP/3 frames, timers, loss, log messages, …) gets a colored text chip
  beside its square. The chip is on the outer side for the leftmost trace and on the right side for the others.
- Clicking any square, packet label, frame chip or event chip opens a modal with the raw event JSON. For
  `recovery_metrics_updated` it also shows the accumulated value of every recovery metric at that moment. When the
  trace was loaded from a URL, the modal also has a shareable deep link to the event.
- **Only one trace?** A sequence diagram needs two sides. qvis then **auto-generates a mirrored trace** for the
  other endpoint: a deep copy in which `packet_sent` and `packet_received` are swapped and all other events are
  hidden. It guesses the vantage point when the trace does not declare one.
- **Two traces (client and server)?** Their clocks are not synchronized. qvis **automatically estimates a time
  offset** for the server trace from the RTT (`recovery_metrics_updated.latest_rtt`/`smoothed_rtt`) and the
  correlation of the first Initial packets. The user can override it in the "Latency offset" field.
- Idle stretches longer than 6 ms are compressed to 120 px and marked "`X.XXms of inactivity`". Events in the same
  millisecond are stacked 20 px apart so they never overlap.
- Large traces stay responsive because only the screen-sized vertical **ranges** around the viewport are drawn, and
  they are redrawn on scroll.

There is no zoom (except the "Time multiplier"), no horizontal scrolling, no legend, no hover tooltips on the diagram
and no filtering.

---

## 2. UI inventory

### 2.1 Page structure (DOM, top to bottom)

```
#app (font-family: 'Avenir', Helvetica, Arial, sans-serif; color #2c3e50)         App.vue:16-22
├─ MainMenu (app-shell.md), "Sequence" tab active (#cce5ff)
└─ div                                                                            views/SequenceDiagram.vue:2
   └─ div.home                                                                    SequenceDiagramContainer.vue:2
      ├─ SequenceDiagramConfigurator   div style="background-color:#cce5ff; padding:0px 10px;"
      │   ├─ p style="padding-top:10px"  "Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram"
      │   ├─ b-container fluid > b-row > ConnectionConfigurator × config.connections.length
      │   ├─ b-container fluid > b-row
      │   │    ├─ b-col                               > b-button "Add trace"
      │   │    ├─ b-col cols=1 align-self=center      > div.text-right (tooltip) "Time multiplier: "
      │   │    └─ b-col cols=1                        > b-input type=number v-model=config.timeResolution
      │   ├─ b-alert danger  (unknown vantage point)        conditional
      │   └─ b-alert danger "Please load…" | warning "Loading files..."   conditional
      └─ SequenceDiagramRenderer   div
          ├─ div#sequence-diagram style="width:100%; border:5px solid #cce5ff; min-height:200px;"
          │    └─ svg#sequence-diagram-svg     (all drawing happens here, imperatively)
          └─ b-modal#event-modal "Event detail" (portalled to <body> by bootstrap-vue)
```

Global CSS added by this view (`SequenceDiagramRenderer.vue:25-29`, unscoped):

```css
#sequence-diagram-svg text.timestamp { font-size: 11px; }
```

Inherited typography that matters for pixel parity:

- `#app` sets `font-family: 'Avenir', Helvetica, Arial, sans-serif`.
- Bootstrap 4 reboot sets `body { font-size: 1rem (16px); line-height: 1.5 }`.
- SVG `<text>` uses `fill` (default black). The `#app` color `#2c3e50` does **not** apply to SVG text, but it does
  apply to HTML inside `<foreignObject>`, where every span sets its own color anyway.

### 2.2 Configurator panel (`SequenceDiagramConfigurator.vue:1-49`)

| # | Element | Verbatim text / attributes | Default / condition | Behavior |
|---|---|---|---|---|
| C1 | Panel `div` | `background-color: #cce5ff; padding: 0px 10px;` | always | The bottom edge sits flush against the 5px `#cce5ff` border of the diagram box, so the two read as one blue frame. |
| C2 | Intro `p` | "Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram" | always; `padding-top:10px` and the default `p` margin-bottom of 1rem | static |
| C3 | Trace selectors | One `ConnectionConfigurator` per `config.connections[i]`, all inside one `b-row`. Props: `allGroups=store.groups`, `connection=config.connections[i].connection`, `key = index + connection.timeOffset` (a numeric sum, see SQ27), `numericalInputValue = config.connections[i].timeOffset`, `numericalInputName = allowCustomTimeOffset(i) ? 'Latency offset' : undefined`, `canBeRemoved = config.connections.length > 2 && index != 0`, `onConnectionSelected = onConnectionSelected(i, conn)`, `onRemoved = onConnectionRemoved(i)`, `onNumericalValueChanged = onTimeOffsetChange(i, offset)` | one per selected trace, including the auto-generated mirror trace (the renderer pushes it into `config.connections`, §3.4) | Layout and modes are in `app-shell.md` §2.5. Each selector is a white column (`border: black 1px solid; max-width: 50%`). With 2 traces the columns sit side by side; with 3+ they wrap. In combined mode (≤ 30 options) the header row shows `filename (description)` and, when enabled, "`Latency offset : `" with the hover tooltip "This value is automatically calculated, but can be manually adjusted.", above a `<select>` and a number input. The `−` button removes a selector; it is shown only for index ≥ 1 when there are more than 2 selectors. |
| C4 | "Latency offset" input | `<input type=number>` showing `timeOffset` **unrounded** (e.g. `21.456000089645386`) | shown only when `index > 0` **and** no selected trace is auto-generated (`allowCustomTimeOffset`, `:89-92`); only in the combined mode (≤ 30 options). Separate-select mode drops it (app-shell Q9: FIX, show it there too). | On `change` (blur or Enter): `parseFloat(value)` goes to `config.connections[i].timeOffset`, which triggers a re-render. Unit: milliseconds, added to every timestamp of that trace (positive = later = lower on screen). |
| C5 | "Add trace" button | `b-button` (bootstrap-vue default variant **secondary**: grey `#6c757d`, white text) with the label "Add trace" | always | `selectDefault()`: **appends** `{connection: store.groups[0].getConnections()[0], timeOffset: parser.timeOffset(=0)}`. It adds the first trace of the first file even when that trace is already shown (SQ6 covers duplicates). |
| C6 | "Time multiplier: " label | `b-col cols="1" align-self="center"` > `div.text-right` with `v-b-tooltip.hover`. Tooltip: "Increase if you have sub-millisecond latencies or want more space between events. 1 = ms level, 1000 = us level. Typically 10 or 100 is enough." | always | Hover shows the tooltip (top placement). The col is 1/12 of the row. |
| C7 | Time multiplier input | `b-input type="number" v-model="config.timeResolution"` (`col-1`, about 8% of the width) | value `1` | v-model writes a **string** on every keystroke (`"10"`), and each change re-renders. JS coerces it in the arithmetic. Empty, 0 or negative values are not validated (SQ25). |
| C8 | Unknown-VP alert | `b-alert show variant="danger"`: "The selected trace has an unknown vantage point. We guessed it based on heuristics, but this could be wrong!" | `connectionIsUnknownPerspective` (`:73-87`): take `config.connections[0].connection`; if it `wasAutoGenerated` and there are more than one, take `[1]` instead. Show the alert iff it has more than 0 events and `vantagePoint.type === "unknown"`. | static |
| C9 | No-file alert | `b-alert show variant="danger"`: "Please load a trace file to visualize it" | `store.outstandingRequestCount === 0 && store.groups.length === 0` | static |
| C10 | Loading alert | `b-alert show variant="warning"`: "Loading files..." | else, if `store.groups.length === 0` | static |

Lifecycle (`:241-256`): in both `mounted()` and `updated()`, if `config.connections.length === 0 && store.groups.length > 0`,
call `selectDefault()`. This is how the first trace gets selected after a file loads, including URL-triggered loads
(see SQ1).

Remove (`:258-260`): `config.connections.splice(i, 1)`. Offset change (`:262-264`):
`config.connections[i].timeOffset = offset`.

### 2.3 Diagram box and SVG

- `div#sequence-diagram`: `width:100%; border:5px solid #cce5ff; min-height:200px`. Before the first render, the empty
  `<svg>` has no width or height attributes, so it is the browser-default 300×150 inside a 200px-tall box.
- After `setup()`:
  - `svg.height = dimensions.height`, which is set **first** so that the page's vertical scrollbar appears before the
    width is measured.
  - Then `svg.width = container.clientWidth` (the inner width, without the 5px borders).
  - qvis also sets `viewbox` (lower-case, so it is ignored by browsers). Effectively there is **no viewBox**: one SVG
    unit is one CSS pixel. Do not add a viewBox.
- The whole page scrolls; the SVG can be tens of thousands of pixels tall. There is no inner scroll container.
- Resizing the window does **not** re-render (SQ21).

SVG child order, which is also the z-order:

1. Created by `setup()` (`D3Renderer.ts:252-346`), never virtualized:
   - per trace, in trace order: timeline rect, header label 1 (file), header label 2 (vantage point)
   - then for every inactivity interval, for every trace: center dashed marker, and between traces the boundary
     dashed marker and the inactivity text
2. Created by `renderPartialExtents()`: one `<g>` per rendered vertical range, appended in render order. Inside a
   range `<g>`, for trace 0 and then trace 1, …, and for each event in that trace's order: event rect, timestamp
   text, then either (arrow line, arrowhead polyline, [lost cross path], label foreignObject) or (side-label
   foreignObject).

### 2.4 Layout constants (all in CSS px unless noted)

| Name | Value | Source |
|---|---|---|
| `margin.top` | 60 | `D3Renderer.ts:221-226` |
| `margin.bottom` | 100 (added after the last event) | same |
| `margin.left/right` | 0 | same |
| `pixelsPerMillisecond` (written `ppm` below) | 20 (the height of one time bucket and the stacking step) | `:230` |
| `shortenIntervalsLongerThan` | 120 (gap cap, in px) | `:231` |
| `bandWidth` | `svgWidth / traces.length` | `:254` |
| band center `cx(i)` | `bandWidth * i + bandWidth * 0.5` | `:256`, `:1348` |
| event rect size | `ppm * 0.6 = 12` (12×12, centered on `(cx, y)`) | `:1377` |
| label text height `textHeight` | `ppm * 0.9 = 18` | `:1521`, `:1706` |
| chip font-size | `floor(textHeight * 0.8) = 14px` | `:1573` etc. |
| direction triangle size | `floor(textHeight * 0.30) = 5` | `:1555`, `:1665` |
| timestamp font-size | 11px (CSS class `timestamp`) | `.vue:26-28` |
| header label font | inherited, 16px | — |
| range height | `screen.height` (the device screen height in CSS px, e.g. 1080) | `:354` |
| arrow color right ("client to server") | `#0468cc` (blue) | `:1415` |
| arrow color left ("server to client") | `#a80f3a` (dark red) | `:1416` |
| event rect fill | `green` (`#008000`) | `:1382` |
| timeline fill | `black` | `:259` |
| lost cross stroke | `red` (`#ff0000`) | `:1513` |

### 2.5 Per-trace header labels (`D3Renderer.ts:255-310`)

For each trace `i` (with `cx = cx(i)`):

1. **Timeline**: `<rect x=cx-1 y=60 width=2 height=svgHeight fill=black>`. It overflows the SVG bottom by 60px and is
   clipped.
2. **Label 1** at `(cx, 20)`, `dominant-baseline=middle`, `text-anchor=middle`, default 16px font:
   - when `!trace.wasAutoGenerated && trace.parent.URL` is truthy: `<a href=URL target=_blank
     style="text-decoration: underline"><text>{parent.URLshort}</text></a>`. The text stays black, because Bootstrap's
     link `color` does not set SVG `fill`.
   - otherwise: `<text>{(wasAutoGenerated ? "GENERATED: " : "") + parent.filename}</text>`. An auto-generated trace
     shares its original's group, so it shows `GENERATED: <same filename>`.
3. **Label 2** at `(cx, 40)`, same attributes: `vantagePoint.type`. For `network` it is
   `"network : from " + vantagePoint.flow + "'s viewpoint"`, for example `network : from client's viewpoint`. A
   generated trace shows `client` or `server`; an original whose type is `unknown` shows `unknown`. The guess only
   appears in the selector name, §3.4.

### 2.6 Inactivity markers (`D3Renderer.ts:312-346`)

For each compressed interval `{yMin, yMax (= yMin+120), timeSkipped}` (§3.6) and for each trace `i`:

- **Center marker** at `x = cx(i)`, from `y1 = yMin + 20` to `y2 = yMax - 20` (80px):
  - line 1: `stroke=white stroke-width=4` (it hides the black timeline)
  - line 2: `stroke=black stroke-width=4 stroke-dasharray=4`

  The result is a dashed, "broken" timeline.
- When `i < n-1`, a **boundary marker** at `x = bandWidth * (i+1)` (the border between two bands) with the same two
  lines, plus a
  `<text class="timestamp" x = bandWidth*(i+1) + 20 y = yMin + 60 dominant-baseline=middle>` (11px, start-anchored)
  showing `` `${(timeSkipped / timeResolution).toFixed(2)}ms of inactivity` ``, for example `12.00ms of inactivity`.

`timeSkipped` is the difference in **bucket indices** (§3.6), so the text is a whole number of buckets divided by the
multiplier, not the exact gap.

### 2.7 Per-event drawing (`D3Renderer.ts:1355-1742`)

For each event (except auto-generated events renamed to `ignoreseq`, which are skipped but still take part in the
layout), with `y` = the event's computed y and `cx = cx(i)`:

**(a) Event square** (`:1376-1384`): `<rect x=cx-6 y=y-6 width=12 height=12 fill=green>`. Click opens the modal.

**(b) Timestamp** (`:1387-1403`): `<text class="timestamp">` (11px):

- `y = y`, `dominant-baseline=middle`
- `x = cx - 10 + (i === 0 ? -40 : +40)`. That is `cx - 50` with `text-anchor=end` for the leftmost trace, and
  `cx + 30` with `text-anchor=start` for every other trace, including middle ones.
- Content is the precomputed `timeText` (§3.6): `time.toFixed(2)`, where `time` is in **ms × timeResolution**,
  relative to the earliest trace start and including the trace's time offset. Examples: `0.00`, `12.53`, `-0.40`. At
  multiplier 1000 a 1.5 ms event shows `1500.00` (SQ15).
- Not clickable.

**(c) Arrow** (only for events with a right target, a left target or a lost marker; §3.7). Order of preference:
right target, then left target, then lost. Variables:

| Case | `m` (offsetMultiplier) | target y `ty` | color | direction |
|---|---|---|---|---|
| right target found | `1` | `target.y` | `#0468cc` | `>` |
| left target found | `-1` | `target.y` | `#a80f3a` | `<` |
| lost, direction right | `0.5` | `y + previousYDiffRight / 2` | `#0468cc` | `>` |
| lost, direction left | `-0.5` | `y + previousYDiffLeft / 2` | `#a80f3a` | `<` |

`previousYDiffRight` / `previousYDiffLeft` hold `target.y - y` of the most recent **found** right / left arrow drawn
earlier **in the same `renderPartialExtents` call**. Both start at 0 on every call (SQ12).

Geometry:

```
tx    = cx + m*bandWidth - m*(ppm/2)            // = cx ± bandWidth ∓ 10 (full), cx ± (bandWidth/2 − 5) (lost)
line  : x1=cx y1=y x2=tx y2=ty  stroke=color stroke-width=2
angle = -atan2(y - ty, tx - cx) * 180/π         // degrees, SVG clockwise positive
head  : <polyline points="tx-10,ty-10 tx,ty tx-10,ty+10" stroke=color stroke-width=4 fill=transparent
                  transform="rotate(angle,tx,ty)">
lost X: crossX = tx + (m*0.02)*bandWidth ; crossY = ty + (ty - y)*0.02
        <path d="M cx-10 cy-10 L cx+10 cy+10 M cx-10 cy+10 L cx+10 cy-10"   (cx/cy = crossX/crossY)
              stroke=red stroke-width=4 fill=transparent transform="rotate(angle,crossX,crossY)">
```

The arrow starts at the center of the source square and its tip stops 10px before the target timeline (the square's
half-size is 6). A lost half-arrow ends halfway across the band, and the X sits just beyond it.

**(d) Arrow label** (`:1519-1677`), a rotated HTML label placed above the line:

```
textWidth  = 0.9 * sqrt((tx-cx)^2 + (ty-y)^2)
textHeight = 18
textAngle  = angle;  if (textAngle >= 90) textAngle -= 180; else if (textAngle <= -90) textAngle += 180;   // never upside down
mx = (cx+tx)/2 ; my = (y+ty)/2
<foreignObject x=mx y=my width=textWidth height=18 style="overflow:visible"
               transform="rotate(textAngle,mx,my) translate(-textWidth/2, -21)">     // -textHeight-3
  <div style="width:{textWidth}px; text-align:center"> …chips… </div>
</foreignObject>
```

Chips are inline `<span>`s that wrap onto more lines when they exceed `textWidth`. Overflow is visible, so extra lines
grow **downwards** over the arrow. The chip order is in §3.11. Common chip style:

```
padding-left:5px; padding-right:5px; border:1px white; border-style:none solid;  (→ 1px white left/right separators only)
font-size:14px; color/background per chip; line-height inherited (1.5 → 21px line box)
```

- **Packet chip**:
  - text `packetTypeToString(header.packet_type) + " : " + header.packet_number` (for example `initial : 0` or
    `1RTT : 15`)
  - color `#383d41` on `#d6d8db`
  - clickable
- **Direction triangle**: an empty `span` with `display:inline-block`, `border-top` and `border-bottom` of
  `5px solid transparent`, and either `border-left: 5px solid <color>` with `margin-left: 1px` (`>`, placed last) or
  `border-right: 5px solid <color>` with `margin-right: 1px` (`<`, placed first). It is a 5×10 colored triangle.
- **Frame chips** and **aggregate chips**: §3.11 and §3.12. All are clickable.

**(e) Side label for non-packet events** (`:1682-1741`), drawn only when the event has no arrow **and**
`type !== packet_sent && type !== packet_received`. Packet events without an arrow get no label at all.

```
sideOffset = timeText.length * 1.3 * 11                 // e.g. "123.45" → 85.8
textHeight = 18
if (i === 0) { align = "right"; width = (bandWidth/2)*0.9 - sideOffset;  x = (bandWidth/2)*0.05; }
else         { align = "left";  width = ((bandWidth/2)*0.9)*0.9;         x = cx + 10 + sideOffset; }
<foreignObject x=x y=(y - 18/1.25) width=width height=18 style="overflow:visible">
  <div style="text-align:{align}">                      // qvis also sets style.width = "" + width (no unit → ignored)
    <span (chip style) color/background = eventTypeToColor(evt)>{eventToShortString(evt)}</span>
  </div>
</foreignObject>
```

- Leftmost trace: the chip is right-aligned and ends at `x + width = cx - 0.025*bandWidth - sideOffset`, about 20px
  left of the timestamp's start.
- Other traces: the chip is left-aligned and starts right after the timestamp.
- The `y - 14.4` top, with the 21px line box, puts the text center about 4px above the event's y.
- If `width ≤ 0` (very narrow bands), the leftmost trace's chips are not rendered at all (SQ24).

### 2.8 Event detail modal (`SequenceDiagramRenderer.vue:11-21`, `:85-150`)

`b-modal#event-modal`: title "Event detail", `hide-footer`, default size (BS4 max-width 500px). It has the standard
header close "×", and Esc or a backdrop click closes it. Body:

1. If `eventLink !== null`: `<a href={eventLink} target="_blank">Direct link to this event</a><br/>`, then `<hr>`.
2. `<pre class="d-block">{eventDetail}</pre>`, where
   `eventDetail = "Event nr: " + focusInfo.eventIndex + "\n" + JSON.stringify(rawEvent, null, 2)`. Every click path
   supplies focusInfo, so the prefix is always present.
3. If `eventDetailExtra !== null` (only for `metrics_updated`):
   - `<p style="font-weight: bold;">Value of all recovery metrics at this point:</p>`
   - `<pre class="d-block">{JSON.stringify(aggregatedMetrics, null, 2)}</pre>`
4. `b-button class="mt-3" block` with the label "Close" (secondary grey, full width).

The JSON is the **raw event object as stored**:

- It includes any enumerable junk qvis attached, notably `"timeText": "12.34"` (SQ14).
- It excludes the non-enumerable `qvis` namespace.
- For auto-generated events it is the cloned event with its swapped `name`.

### 2.9 Interaction summary

| Target | Gesture | Result |
|---|---|---|
| event square (any trace, any event type except `ignoreseq`) | click | modal for that event (§3.14) |
| packet chip, frame chip or aggregate chip on an arrow label | click | modal for the arrow's **source** event (the `packet_sent`) |
| side-label chip | click | modal for that event |
| arrow line, arrowhead, X, timestamp, inactivity text | none | not interactive |
| URL header label | click | opens `parent.URL` in a new tab |
| page scroll | scroll | virtualized range (re)rendering (§3.8) |
| selectors, `−`, Add trace, Time multiplier, Latency offset | change | config mutation, then a full re-render (§3.2) |

There are no hover effects and no cursor changes (the default cursor is shown over clickable SVG and spans).
Optional improvement: `cursor:pointer` on clickable items (does not affect layout).

---

## 3. Algorithms and data flow

### 3.1 Data flow

```
ConfigurationStore.sequenceDiagramConfig  (persists across tab switches; never across reloads)
   │  { connections: [{connection, timeOffset}], timeResolution }
   ├──► SequenceDiagramConfigurator  (mutates config: select / add / remove / offset / multiplier)
   └──► SequenceDiagramRenderer.vue  (@Watch('config', deep, immediate))
          └─ SequenceDiagramD3Renderer.render(connections, timeResolution, focusOnNext)
               setup():
                 0 container checks
                 1 drop traces with 0 events; dedupe; ensureMoreThanOneTrace (mirror) → may push into config.connections
                   setupLookupTable() on every trace
                 2 dimensions; calculateTimeOffsets (may write config.connections[1].timeOffset)
                   calculateCoordinates (y per event, intervals, timeText, svg height)
                   calculateConnections (arrow targets, lost markers)
                 3 clear SVG, size it, draw timelines/headers/inactivity
                 4 prepare ranges (screen.height each)
                 5 (re)install window scroll handler
               renderPartialExtents(focusOn)   → draws ranges near the viewport (or scrolls to focus and returns)
          window scroll ──(throttled)──► renderPartialExtents()
          click ──► onEventClicked ──► showEventModal (Vue) ──► b-modal
```

All per-event layout data is stored **on the raw event objects** in a non-enumerable `qvis.sequencediagram`
namespace (`createPrivateNamespace`, `:571-579`): `y`, `rightTarget`, `leftTarget`, `packetLost`, `focusInfo`. Per
connection it stores `generatedSibling` and `manualTimeOffset`. One field, `timeText`, is stored as an **enumerable**
property directly on the raw event (SQ14). The port should use side tables instead (§8).

### 3.2 Render triggering and lifecycle (`SequenceDiagramRenderer.vue:54-192`)

1. `created()` (`:54-72`):
   - constructs `new SequenceDiagramD3Renderer("sequence-diagram", "sequence-diagram-svg", this.showEventModal)`
   - reads the focus params **once** from `$route.query` (§5.1) into `focusOnNext`:
     - if both `focusOnConnection` and `focusOnEvent` are present:
       `{connectionIndex: parseInt(focusOnConnection,10), eventIndex: parseInt(focusOnEvent,10)}`
     - else if `focusOnPN` is present:
       `{connectionIndex: focusOnConnection ? parseInt(…) : 0, packetNumber: parseInt(focusOnPN,10)}`
2. The `@Watch('config', {immediate:true, deep:true})` handler runs once **before** `created` (Vue 2 initState). At
   that point `this.renderer` is undefined, so nothing happens.
3. `mounted()` (`:74-79`): if `config.connections.length > 0`, calls `renderer.render(connections, timeResolution)`.
   This is **without focus**. It is the "come back to the tab" path (SQ11).
4. Any later deep change to `config` (selection, offset, multiplier, the renderer's own writes) calls
   `onConfigChanged`. If `!renderer.rendering`:
   1. If `newConfig.connections[0].connection.getEvents().length > 10000`, show the warning toast "Trace might take
      long to render" (§6.1), then `await` 200 ms "to show the warning". This runs on **every** config change for such
      traces.
   2. Call `renderer.render(newConfig.connections, newConfig.timeResolution, this.focusOnNext)`.
   3. `.then(rendered => { focusOnNext = null; if (!rendered) error toast "Trace could not be rendered" })`.
5. `render()` (`D3Renderer.ts:144-171`):
   - returns `false` immediately if `this.rendering`
   - otherwise sets `rendering = true` and runs `setup()`; if `setup()` returns false, it resets the flag and returns
     `false`
   - otherwise `await renderPartialExtents(focusOn)` (synchronous in practice), resets the flag and returns `true`
   - an exception leaves `rendering = true` forever (SQ26)

**Self-triggered changes.** `setup()` writes to the reactive config in two places:

- the mirror generation (and dedupe) rewrites `config.connections`
- `calculateTimeOffsets` sets `config.connections[1].timeOffset`

Vue flushes these watchers in a microtask that runs while `rendering === true`, so they are ignored. No second render
happens, but the UI (selectors, latency field) updates. The port must reproduce this: **one render per user action**,
and the auto-written values must not cause a second layout pass (§8.4).

### 3.3 `setup(tracesInput)` (`D3Renderer.ts:174-403`)

0. Container checks. They compare `getElementById(...) === undefined`, which is never true (`null` is returned), so
   they are dead code. The port should check for `null`.
1. `this.traces = tracesInput.filter(t => t.connection.getEvents().length > 0)`. The wrapper objects are the same
   ones as in `config.connections`. If none remain: `console.error("SequenceDiagramD3Renderer:setup : None of the
   selected traces have events in them, cannot render")` and return false.
2. `ensureMoreThanOneTrace()` (§3.4), then `trace.connection.setupLookupTable()` for each trace. This builds
   `category → type → events[]` once per connection; a no-op when it already exists.
3. `dimensions = {margin:{top:60,bottom:100,left:0,right:0}, width:0, height:0, pixelsPerMillisecond:20,
   shortenIntervalsLongerThan:120}`.
4. `calculateTimeOffsets(traces)` (§3.5), then `dimensions.height = calculateCoordinates(traces)` (§3.6), then
   `calculateConnections()` (§3.7).
5. `svg.selectAll("*").remove()`. Then set `height` first, then `width = container.clientWidth`, then the dead
   `viewbox`. `bandWidth = width / n`. Draw the timelines, labels and inactivity markers (§2.5, §2.6).
6. Ranges:
   - `rangeHeight = screen.height`
   - `renderedRanges = []`; for `y = 0; y < height; y += rangeHeight`, push `{rendered:false, svgGroup:undefined,
     yMin:y}`
7. Scroll handler (`:370-398`):
   - remove the previously installed handler of **this renderer instance**, if any
   - install a new one on `window` that does:

```js
clearTimeout(timer); timer = setTimeout(execute, 250);
if (++count % 5 === 0) { count = 0; clearTimeout(timer); execute(); }   // execute = renderPartialExtents()
```

   That is, it renders on every 5th scroll event plus once 250 ms after the last one. The handler is never removed
   on component destroy (SQ20).

### 3.4 Dedupe and the auto-generated mirror trace (`ensureMoreThanOneTrace`, `:405-569`)

**Step 1: dedupe**, if there is more than one trace.

- `this.traces = this.traces.filter((v,i) => this.traces.indexOf(v) === i)`. This dedupes **wrapper objects**, which
  are always distinct, so the same connection selected twice is **not** removed (SQ6).
- If the count changed (never in practice), `config.connections` (`selectedTraces`) is emptied and refilled with
  `this.traces`.
- If more than one trace remains, return.

**Step 2: reuse.** If `original.qvis.sequencediagram.generatedSibling` exists:

- `this.traces.push(wrap(sibling))` and `config.connections.push(wrap(sibling))` (a **different** wrapper object;
  `wrap` = `createConnectionWithTimeoffset`, timeOffset 0)
- return

The sibling is always appended on the **right**, even when it is a client (SQ7).

**Step 3: generate.** `newTrace = original.clone()` (`Connection.ts:53-71`):

- **The `Connection` constructor appends the clone to `original.parent`**, so the generated trace becomes a
  permanent member of the file's group. It shows up in every selector of every view, and in counts (app-shell Q13
  PRESERVE; file-loading Q14 fixes only the counts).
- It deep-copies, via JSON, `title`, `description`, `eventFieldNames`, `commonFields`, `configuration`,
  `vantagePoint` and `events` (any enumerable `timeText` from earlier renders is copied too).
- It **shares** the original's event parser object (same time base).

Then:

```
newTrace.title        = "Simulated, autogenerated trace : " + original.title
newTrace.description  = "Simulated, autogenerated trace : " + original.description
newTrace.vantagePoint.name = "GENERATED"
newTrace.wasAutoGenerated  = true
```

Perspective decision:

| original | new trace | placement |
|---|---|---|
| `type === "server"` **or** `flow === "server"` | `type = "client"`, `flow = "unknown"` | **unshift** (new trace on the left) |
| else `type === "client"` **or** `flow === "client"` | `type = "server"`, `flow = "unknown"` | **push** (new trace on the right) |
| else (unknown, or network with unknown/absent flow): guess | see below | |

Guess heuristic (`:485-540`):

```
sent = original.lookup("transport","packet_sent"); recv = original.lookup("transport","packet_received")
firstInitialSent     = first sent event with header.packet_type === "initial" && ""+header.packet_number === "0"
firstInitialReceived = first recv event with the same condition
guessed = "server"                                          // default
if (firstInitialSent && firstInitialReceived && firstInitialSent.absoluteTime < firstInitialReceived.absoluteTime)
    guessed = "client"
original.vantagePoint.name = "vantage point type was unknown, pretending it's " + guessed     // mutates the ORIGINAL
newTrace.vantagePoint.type = (guessed === "client") ? "server" : "client"
newTrace.vantagePoint.name = "vantage point type was unknown, pretending it's " + newTrace.vantagePoint.type
newTrace.vantagePoint.flow = "unknown"
newTrace is pushed (right) when it is a server, unshifted (left) when it is a client
```

The original keeps `type: "unknown"`, which triggers configurator alert C8.

Event rewriting of the clone (`:542-555`), through the parser's `name` setter (`QlogLoaderV2.ts:363-371`):

- `packet_sent` becomes `packet_received`, and `packet_received` becomes `packet_sent`
- **every other event** is renamed to `"ignoreseq"`

The setter does `raw.name = raw.name.replace(currentType, newType)`, so `"transport:packet_sent"` becomes
`"transport:packet_received"` and `"recovery:metrics_updated"` becomes `"recovery:ignoreseq"`. Ignored events are
never drawn or clickable, but they still take part in the y layout (§3.6). This changes nothing visible, because they
mirror the original's events one-to-one and get the same y as their counterparts.

Cross-links:

- `original.qvis.sequencediagram.generatedSibling = newTrace`
- `newTrace.qvis.sequencediagram.generatedSibling = original`

Finally `config.connections` is emptied and refilled with `this.traces` (wrappers shared with the renderer).

Consequences:

- All mirrored arrows are **horizontal**: a mirror event has exactly the same time as its original, so it gets the
  same y.
- No packet is ever "lost".
- `calculateTimeOffsets` is skipped.
- The "Latency offset" inputs disappear (`allowCustomTimeOffset`).

### 3.5 Time model and automatic time alignment

#### 3.5.1 What this view needs from the data model

qvis uses `DirectEventParser` (`QlogLoaderV2.ts:267-532`). The port needs these per-trace, per-event accessors. The
old meaning is given first, then the latest-draft mapping (main-schema-14 §"Timestamps"):

The latest-draft column follows `data-model.md` §3.16.3, which owns the final word. `resolved` is the event `time`
(float64 ms) after `relative_to_previous_event` decoding; `start` is the smallest `resolved` of the connection;
`epochMs` comes from the effective `reference_time.epoch`. Case **A**: `epochMs === 0` (epoch 1970-01-01, or no
`reference_time` at all). Case **R**: a dated epoch. Case **U**: `epoch: "unknown"` (monotonic clocks; this is what
quic-go, quiche, neqo and mvfst write). §9.5 has the full mapping.

| Accessor | qvis meaning | Latest-draft mapping |
|---|---|---|
| `absoluteTime(e)` (ms) | `time * mult + addTime + time_offset`. `addTime` = reference_time (RELATIVE) or 0 (ABSOLUTE). | A: `resolved`. R: `epochMs + resolved`. U: `resolved − start + refOverride`, where `refOverride` is 0 unless the "dragons" repair (§3.5.2) set it. |
| `absoluteStartTime(trace)` (ms) | RELATIVE: `reference_time`. ABSOLUTE: `events[0].time`. | A: `start`. R: `epochMs`. U: `refOverride` (initially `0`). |
| `relativeTime(e)` (ms) | `time*mult - subtractTime + offset` | A: `resolved − start`. R: `resolved`. U: `resolved − start`. In every case this equals `absoluteTime(e) − absoluteStartTime(trace)`. |
| `timeToMilliseconds(x)` | `x * mult` (µs → ms when `time_units: "us"`) | `parseFloat(x)`: all qlog times and RTT fields are ms in the latest drafts |
| `parser.timeOffset` | `configuration.time_offset` (ms) | **removed** from the drafts; always 0 |
| `setReferenceTime(ms)` | sets `addTime` (mutates the shared parser, which affects every view) | a **sequence-diagram-local** `refOverride` for that connection (SQ19). Only meaningful for case U, the only case that satisfies the next row. |
| `isRelativeWithoutReference(trace)` | `getAbsoluteStartTime() === 0 && method === RELATIVE_TIME` | `timing.method === RELATIVE_TIME && absoluteStartTime(trace) === 0`, which is true exactly for case U before any override |

Events must be in time order. The loader sorts them, stably (`file-loading.md`; qvis sorts and `alert()`s). The merge
in §3.6 assumes sorted traces.

#### 3.5.2 `calculateTimeOffsets(traces)` (`D3Renderer.ts:581-784`)

This computes the time offset of **`traces[1]`** (called "server") relative to **`traces[0]`** ("client"). It only
ever writes `traces[1].timeOffset`; index 0 is always 0 unless the user edits it, which the UI does not allow.

Early outs, in order:

1. `traces.length > 2`: `console.warn("SequenceDiagramD3Renderer:calculateTimeOffsets : no time offsets
   auto-calculated for more than 2 traces. Use the UI to assign them manually if needed.")` and return.
2. Either trace `wasAutoGenerated`: return.
3. `server.parser.timeOffset !== 0` (file-provided `configuration.time_offset`): return. This never happens with the
   latest drafts.
4. `server.timeOffset` is **truthy** (set manually in the UI, or by an earlier run for this wrapper): store
   `server.connection.qvis.sequencediagram.manualTimeOffset = server.timeOffset` and return. Because the check is
   for truthiness, a manual value of 0 is impossible (SQ5).
5. `server.connection.qvis.sequencediagram.manualTimeOffset !== undefined` (remembered from an earlier visit, keyed
   by the **server connection**): set `server.timeOffset = that` and return.

Reference-time repair ("HERE BE DRAGONS", `:628-639`):

- If the client is relative without a reference time:
  `console.error("SequenceDiagramD3Renderer:calculateTimeOffsets : Client had no reference_time set, trying to fix by using the server-side reftime. HERE BE DRAGONS!")`
  and `client.setReferenceTime(serverStart - 5)` ("-5 because the client should start earlier because it sends the
  initial").
- Else, if the server is relative without a reference time:
  `console.error("… : Server had no reference_time set, trying to fix by using the client-side reftime. HERE BE DRAGONS!")`
  (same prefix as the client message) and `server.setReferenceTime(clientStart + 5)`.

RTT and one-way latency estimate:

```js
let oneWay = MIN_SAFE_INTEGER; let smoothedBackup = 0;
for (e of client.lookup("recovery","metrics_updated")) {         // latest: quic:recovery_metrics_updated
    if (e.data.latest_rtt)        oneWay = e.data.latest_rtt / 2;
    else if (e.data.smoothed_rtt) smoothedBackup = e.data.smoothed_rtt / 2;   // keeps the LAST such value
    if (oneWay !== MIN) { oneWay = timeToMilliseconds(oneWay); break; }       // first truthy latest_rtt wins
}
if (oneWay === MIN && smoothedBackup !== 0) oneWay = smoothedBackup;
if (oneWay === MIN) { /* same loop over the SERVER's metrics_updated events */ }
```

Initial correlation:

```js
// server: first packet_received with header.packet_type === "initial" && packet_number !== undefined
serverInitialReceived = that event; firstPN = "" + its packet_number;          // e.g. "2" if client Initials 0,1 were lost
// client: walk events in order until both are found
//   initialSent     = packet_sent  initial with ""+packet_number === firstPN   (overwritten each time one matches)
//   initialReceived = packet_received initial (any PN)                          (overwritten until both found)
if (initialSent && initialReceived && serverInitialReceived) {
    if (oneWay === MIN) {
        oneWay = (abs(initialReceived) - abs(initialSent)) / 2;
        if (oneWay <= 0) { console.error("SequenceDiagramD3Renderer:calculateTimeOffset : initial received is earlier than sent! ", oneWay); return; }
    }
    const serverReceiveTime = abs(serverInitialReceived);
    const expected          = abs(initialSent) + oneWay;
    oneWay = serverReceiveTime > expected ? serverReceiveTime - expected      // SQ4: wrong sign
                                          : expected - serverReceiveTime;
} else if (oneWay !== MIN) {
    console.log("…calculating probable RTT from metrics_updated events because initials couldn't be properly correlated (was there loss?)", …);
    // oneWay (RTT/2) itself is used as the offset
}
if (oneWay === MIN) return;
server.timeOffset = oneWay;                                         // reactive → selector shows it
server.connection.qvis.sequencediagram.manualTimeOffset = oneWay;   // remembered for this server connection
```

`abs()` is `absoluteTime`. The offset is in ms and is **added** to all of the server's times in §3.6.

### 3.6 Y-coordinate layout (`calculateCoordinates`, `:786-998`)

This is a k-way merge over the traces in timestamp order. It does not copy the events. Per trace `t` there is a head
index and a tracker `{timestamp:0, y:0}`.

```js
const ppm = 20, res = timeResolution;
start = min over traces of absoluteStartTime(trace);  start *= res;     // "absoluteAggregatedStartTime"
let bucketPrev = -1, currentY = 60 /*margin.top*/, overlap = false, prevTrace = 0;
shortenedIntervals = [];
while (!done) {
  // 1. choose the head event with the smallest time (STRICT <, so ties go to the lowest trace index)
  for each unfinished trace t:
      time_t = absoluteTime(head_t) * res - start + timeOffset_t * res;
      head_t.timeText = "" + time_t.toFixed(2);           // stored on the raw event (enumerable!)
      track minimum → (minTrace, minTime, minEvent)
  const bucket = Math.floor(minTime);                      // 1 bucket = 1 ms at res=1, 1 µs at res=1000

  // 2. overlap prevention: events in the same bucket stack per-trace, all traces starting at the same base y
  if (bucket === bucketPrev) {
      if (!overlap) {
          overlap = true;
          for (t of traces) trackers[t].y = (t === prevTrace) ? currentY : currentY - ppm;   // "undo" for the others
      }
      trackers[minTrace].y += ppm;
      currentY = trackers[minTrace].y;
  } else if (overlap) {
      overlap = false;
      currentY = max over trackers of y;                   // continue below the tallest stack
  }

  // 3. gap compression (after 2.)
  const diff = bucket - bucketPrev;                         // integer
  if (diff * ppm > 120) {                                   // diff ≥ 7 buckets
      shortenedIntervals.push({ yMin: currentY, yMax: currentY + 120, timeSkipped: diff });
      currentY += 120;
  } else {
      currentY += diff * ppm;                               // 20 px per bucket (0 inside a stack)
  }

  minEvent.y = currentY;
  bucketPrev = bucket; prevTrace = minTrace; advance head(minTrace); maxY = currentY;
}
return maxY + 100;                                          // svg height
```

Properties to keep:

- The first event's `diff` is `bucket + 1` (it is measured from `-1`). An event at relative time 0 gets
  `y = 60 + 20 = 80`. When the earliest event is at bucket ≥ 6, the diagram starts with an inactivity marker whose
  text reads one more than the bucket (SQ16).
- Gaps of up to 6 buckets are drawn to scale (20 px/bucket). Gaps of 7 or more become exactly 120 px plus a marker.
- Within one bucket, each trace's events are spaced 20 px apart starting at the same base. The next bucket starts
  below the tallest stack.
- `y` values are always integers (60 + multiples of 20 or 120). Range boundaries rely on this (§3.8).
- Negative relative times, negative offsets and out-of-order events can make `y` decrease, even above 60 (SQ17).
- A `NaN` time (for example a `NaN` offset) is never the minimum. When only `NaN` traces remain, `minTrace = -1` and
  the loop crashes (SQ26).

Worked example (2 traces, multiplier 1). Client C (index 0): events at 0.0, 0.3, 25.0, 25.2 ms. Server S (index 1,
after its offset): 12.5, 12.6, 12.9, 13.0, 37.7 ms.

| step | event | bucket | action | y |
|---|---|---|---|---|
| 1 | C 0.0 | 0 | diff 1 → +20 | 80 |
| 2 | C 0.3 | 0 | overlap starts: tr[C]=80, tr[S]=60; tr[C]+=20 | 100 |
| 3 | S 12.5 | 12 | overlap ends: y=max(100,60)=100; diff 12 → interval {100,220,12}; +120 | 220 |
| 4 | S 12.6 | 12 | overlap starts: tr[S]=220, tr[C]=200; tr[S]+=20 | 240 |
| 5 | S 12.9 | 12 | tr[S]+=20 | 260 |
| 6 | S 13.0 | 13 | overlap ends: y=max(200,260)=260; diff 1 → +20 | 280 |
| 7 | C 25.0 | 25 | diff 12 → interval {280,400,12} | 400 |
| 8 | C 25.2 | 25 | overlap: tr[C]=400, tr[S]=380; tr[C]+=20 | 420 |
| 9 | S 37.7 | 37 | ends: y=420; diff 12 → interval {420,540,12} | 540 |

SVG height = 640. The three intervals each show "`12.00ms of inactivity`". The timestamps read `0.00`, `0.30`,
`12.50`, …

### 3.7 Packet matching: arrows and loss (`calculateConnections`, `:1000-1132`)

Passes:

- **Right**: for `t = 0 … n-2`, `connectTraces("rightTarget", traces[t], traces[t+1])`
- **Left**: for `t = n-1 … 1`, `connectTraces("leftTarget", traces[t], traces[t-1])`

`connectTraces(prop, start, end)`:

```js
startP = start.vp.type === "network" ? start.vp.flow : start.vp.type;   // same for endP ("unknown" stays "unknown")
startEvents = start.lookup("transport", "packet_sent");                 // ALWAYS packet_sent
endEvents   = end.lookup("transport", startP === endP ? "packet_sent" : "packet_received");
if (startEvents.length === 0) console.error("SequenceDiagram:calculateConnections : trace " + start.parent.filename + ":" + startP + " did not have packet_sent events, which are needed");
if (endEvents.length === 0)   console.error("SequenceDiagram:calculateConnections : trace " + end.parent.filename + ":" + endP + " did not have " + endType + " events, which are needed");
connectEventLists(prop, startEvents, endEvents);
```

`connectEventLists` uses a windowed search, which brought a 3.5 MB trace from 7 s to under 600 ms:

```js
let last = 0;
const frac = Math.min(1000, Math.max(200, Math.round(endEvents.length / 10)));   // ±10 %, clamped to [200, 1000]
for (raw of startEvents) {
    const d = raw.data, md = raw.qvis.sequencediagram;
    if (d.header === undefined) { console.error("SequenceDiagram:calculateConnections : event data does not have the header field, which is required", d); continue; }
    if (d.header.packet_number === undefined) {
        if (!["version_negotiation","retry","stateless_reset"].includes(d.header.packet_type))
            console.error("SequenceDiagram:calculateConnections : event data does not have the header.packet_number field, which is required", d);
        continue;                                   // → no arrow, no side label, only square + timestamp (SQ31)
    }
    md.rightTarget = undefined; md.leftTarget = undefined;     // NOTE: also wipes the other pass's result (SQ9)
    for (c = max(0, last - frac); c <= min(endEvents.length - 1, last + frac); ++c) {
        const cand = endEvents[c].data;
        if (cand.header && cand.header.packet_type === d.header.packet_type
            && ("" + cand.header.packet_number) === ("" + d.header.packet_number)) {
            md[prop] = endEvents[c]; last = c; found = true; break;      // first match in index order
        }
    }
    if (!found) md.packetLost = prop;               // "rightTarget" | "leftTarget"; never cleared (harmless, see §8)
}
```

Notes:

- The match key is `(packet_type, String(packet_number))`. Different packet number spaces are kept apart by
  `packet_type` (`initial`/`handshake`/`0RTT`/`1RTT`).
- Duplicate packet numbers (for example in a retransmission trace) match the first candidate in the window.
- Any `packet_sent` without a counterpart within the window is "lost". That includes packets the peer never logged,
  and every sent packet when the peer trace has none of the end type.
- Explicit `packet_lost` events are **not** used for this.
- The mirror trace (§3.4) always matches perfectly.
- Rendering priority (§2.7c): `rightTarget`, then `leftTarget`, then `packetLost`.
- 2 traces (the normal case): right pass is `client.sent → server.received`; left pass is
  `server.sent → client.received`. Every `packet_sent` gets at most one arrow.
- 3+ traces: middle traces' `packet_sent` events are start events in **both** passes. The left pass wipes the right
  target, and for a `network` trace with flow `client`, it matches the network's `packet_sent` events against the
  client's `packet_sent` events. Arrows then go the wrong way (SQ9).
- Two traces with the **same** effective perspective (for example two pcap2qlog network traces, both with flow
  client): the right pass matches `A.sent → B.sent` (correct). The left pass matches `B.sent → A.sent`, which draws a
  red arrow going **up** for every client packet. Server-to-client packets get no arrows (SQ9).

### 3.8 Virtualized rendering (`renderPartialExtents`, `:1134-1750`)

1. Focus handling first (§3.9). It may scroll and **return without drawing**.
2. Visible window of the SVG:

```js
const r = svg.getBoundingClientRect();
const offsetFromDocTop = r.top - document.body.getBoundingClientRect().top;
const yMin = Math.max(0, window.pageYOffset - offsetFromDocTop);
const yMax = yMin + (window.innerHeight - Math.max(0, r.top));         // computed but unused
```

3. `forceFull` is true when `window.location.hash.indexOf("forceFull") >= 0`.
4. Ranges to render:
   - `cur = floor(yMin / rangeHeight)`, `from = max(0, cur-1)`, `to = min(last, cur+1)`
   - with `forceFull`: `from = 0`, `to = last`, plus
     `console.warn("SequenceDiagramD3Renderer:renderPartialExtents: forcing a full render of the entire diagram, this can cause slowdowns!", ranges)`
   - for each `r` in `[from, to]` not yet rendered, the extent is `{start: r*H, stop: r*H + H - 1}`
5. Ranges to remove (skipped with `forceFull`):
   - rendered ranges in `[max(0, from-500), max(0, from-2)]`, **unless** both bounds are 0
   - rendered ranges in `[min(last, to+2), min(last, to+500)]`, **unless** both bounds equal `last`
   - The effect is that rendered ranges `from-1` and `to+1` are kept as a buffer. Removal means detaching the range's
     `<g>` and marking it not rendered.
6. If there are no new extents, return.
7. Set `previousYDiffLeft = previousYDiffRight = 0`. These are shared by all extents and traces in this call (SQ12).
8. For each new extent:
   - create a `<g>` and mark the range rendered
   - for each trace `i`, iterate **all** events from index 0 (`currentEventId` counts every event, including ignored
     ones):
     - skip while `y < start`; `break` once `y > stop`
     - skip events named `ignoreseq`
     - draw §2.7 (a), (b), then (c)/(d) or (e)
     - `focusInfo = {connectionIndex: i, eventIndex: index}` is bound into each element's click closure
   - append the `<g>` to the SVG

An element whose start event lies in a range that is not drawn is missing, even when part of it (for example a long
arrow) would reach into the viewport. The ±1 render window and the ±2 keep-window hide this in practice.

### 3.9 Focus / deep-link scrolling (`:1156-1214`)

`focusOn` comes only from the `render()` call of the watcher path (§3.2).

```js
if (traces.length > focusOn.connectionIndex) {                 // index into the RENDERED traces (incl. the mirror)
  events = traces[ci].connection.getEvents();
  if (focusOn.packetNumber) {                                  // truthy: PN 0 is ignored (SQ10)
     idx = first index of an event with type === "packet_sent" && data.header.packet_number truthy
           && "" + packet_number === "" + focusOn.packetNumber          // any packet type / PN space
     focusOn.eventIndex = idx (if found; else console.error("…packet number couldn't be found in the trace...", …))
  }
  if (focusOn.eventIndex) {                                    // truthy: event 0 is ignored (SQ10)
     if (events.length > eventIndex && events[eventIndex].qvis.sequencediagram.y) {
         window.scrollTo(0, y - 50);                           // y is SVG-relative but used as a DOCUMENT offset
         return;                                               // nothing drawn now; the scroll handler draws later
     } else console.error(…"couldn't focus on event, y unknown" | "couldn't focus on event, eventIndex unknown")
  } else console.error("…neither eventIndex nor pnIndex was set, one is required to focus!")
} else console.error("…couldn't focus on event, traceIndex unknown")
```

Effects:

- The focused event lands `svgDocumentTop + 50` px below the top of the viewport, because the SVG's document offset
  (menu plus configurator) is not added. The port keeps this exact formula. **Amended by addendum S8:** after a URL
  load (the normal deep-link case) qvis scrolls while its "Loading files..." alert is still in the DOM, and the event
  lands 66 px lower.
- If `scrollTo` does not change the scroll position (a page that is too short, or already there), no scroll event
  fires and **the diagram stays empty** apart from timelines, headers and inactivity markers (SQ11).

### 3.10 Drawing details

All geometry is in §2.5-2.7. Implementation notes:

- Every element is created with raw `document.createElementNS` and `appendChild`, not through d3 data joins.
  `foreignObject` content uses `createElementNS(XHTML,"div")` plus `document.createElement("span")`. The code
  comments (`:1136-1151`) say this was faster than d3 and created less garbage.
- `d3` is used only to `select` the SVG, `selectAll("*").remove()`, and to `append` the timeline rect and the
  inactivity lines.

### 3.11 Arrow label composition and frame aggregation (`:1550-1677`)

Let `dir` be `">"` (right or lost-right) or `"<"` (left or lost-left).

1. If `dir === "<"`: append the left-pointing triangle.
2. Append the **packet chip** (header text).
3. If `data.frames` exists:
   - **`frames.length >= 8`**:
     - group frames by `frame_type`, in order of first appearance
     - each group with **> 5** frames becomes one **aggregate chip**: `` `${count} ${frame_type} frames (click for details)` ``,
       colored by type, clickable. `">"` **prepends** it; `"<"` appends it.
     - frames of groups with ≤ 5 entries are collected (in group order, not original order) as individual frames
   - **otherwise**: all frames are individual frames, in original order
   - for each individual frame, skip it if `frame.qvis?.sequence?.hide` (set by the packetization view on its
     injected "FILLER" frames, SQ30). Otherwise create a chip with the text `frameToShortString(frame)` and colors
     `frameTypeToColor(frame.frame_type)`, then `">"` **prepends** it and `"<"` appends it.
4. If `dir === ">"`: append the right-pointing triangle.

Final visual order, left to right:

```
">" :  [f_N … f_2 f_1] [agg_K … agg_1] [PT : PN] ▶
"<" :  ◀ [PT : PN] [agg_1 … agg_K] [f_1 f_2 … f_N]
```

The packet chip always sits next to the direction triangle, at the arrow's "front", and the frames trail behind it
in packet order. Hidden frames still count toward the `>= 8` threshold.

### 3.12 Text functions

#### 3.12.1 `packetTypeToString` (`:2226-2248`)

| `header.packet_type` | displayed |
|---|---|
| `"1RTT"` or legacy `"onertt"` | `1RTT` |
| `"0RTT"` or legacy `"zerortt"` | `0RTT` |
| `"version_negotiation"` | `VNEG` |
| anything else | verbatim (`initial`, `handshake`, `retry`, `stateless_reset`, `unknown`, …) |

#### 3.12.2 `frameToShortString(frame)` (`:1791-1939`), with the latest-draft (quic-events-13) field mapping

The qvis checks are **truthiness** checks, so `0` counts as absent. See SQ13 for which ones to fix.

| `frame_type` | qvis output (verbatim) | qvis condition | Latest-draft fields |
|---|---|---|---|
| `ack` | `"ack " + ranges.join(",")`. Each range: `[a]` gives `a`; `[a,b]` with `a !== b` gives `a-b`; `[a,a]` gives `a`. No `acked_ranges` gives `"ack "`. | — | `acked_ranges: [[from,to] or [n]]` (unordered allowed; keep the given order) |
| `stream` | `"stream " + stream_id + (fin ? " FIN" : "")` | — | `stream_id`, `fin` (default false) |
| `connection_close` | **clean**: `"connection_close : clean"`. Else: `"connection_close " + code + (reason ? " : " + reason : "")`. | clean when `error_code === "no_error"`, or `"http_no_error"`, or `"" + error_code === "0"`, or (`raw_error_code` truthy and `"" + raw_error_code === "0"`). `code` = `error_code` if truthy, else `raw_error_code` if truthy, else `""`. | Old `error_code` is new **`error`** (a string: `$TransportError`, `crypto_error_0x1NN`, an HTTP/3 error, or `"unknown"`). Old `raw_error_code` is new **`error_code`** (uint64, present when `error === "unknown"`). Port rule: clean iff `error ∈ {"no_error","http_no_error"}` or `error_code === 0`. `code` = `error` when `error` is present and not `"unknown"`; else `error_code` when defined; else `error ?? ""`. `reason` is unchanged (ignore `reason_bytes`). |
| `max_stream_data` | `"max data " + maximum + " (stream " + stream_id + ")"`, else `"max_stream_data"` | `maximum && stream_id` | `stream_id`, `maximum` |
| `max_data` | `"max data " + maximum`, else `"max_data"` | `maximum` | `maximum` |
| `max_streams` | `"max " + maximum + " " + stream_type + " streams"` (e.g. `max 100 bidirectional streams`), else `"max_streams"` | `maximum && stream_type` | `stream_type`, `maximum` |
| `streams_blocked` | `"blocked at " + limit + " " + stream_type + " streams"`, else `"streams_blocked"` | `limit && stream_type` | `stream_type`, `limit` |
| `stream_data_blocked` | `"stream " + stream_id + "blocked at " + limit` (**no space** before "blocked", SQ13), else `"stream_data_blocked"` | `limit && stream_id` | `stream_id`, `limit` |
| `data_blocked` | `"connection blocked at " + limit`, else `"data_blocked"` | `limit` | `limit` |
| `reset_stream` | `"reset stream " + stream_id + " (" + error_code + ")"`, or `"reset stream " + stream_id` when `error_code === undefined`; else `"reset_stream"` | `stream_id` | Old `error_code` is new `error` (string, required), with `error_code` (uint64) when `error === "unknown"`. Port: show `error` unless it is `"unknown"` and `error_code` is defined, in which case show `error_code`. |
| `stop_sending` | `"stop sending " + stream_id + " (" + code + ")"` / `"stop sending " + stream_id` / `"stop_sending"` | same | same as `reset_stream` |
| `reset_stream_at` (new in quic-events-13) | qvis: `frame_type` verbatim (default case) | — | Port: X1 (EXT-ON), `"reset stream " + stream_id + " (" + error + ") at " + reliable_size`; see §9.4 |
| anything else | `frame_type` verbatim | — | `padding`, `ping`, `crypto`, `new_token`, `new_connection_id`, `retire_connection_id`, `path_challenge`, `path_response`, `handshake_done`, `datagram`, `unknown` |

#### 3.12.3 `eventToShortString(evt)` (`:1984-2224`)

The switch is on the **type** part of the name only (qvis `evt.name`). The port must switch on the latest
`namespace:type`.

| qvis case (old) | Latest event | Output (verbatim construction) |
|---|---|---|
| `spin_bit_updated` | `quic:spin_bit_updated` | `"Spin " + (data.state ? "ON" : "OFF")` |
| `metrics_updated` | `quic:recovery_metrics_updated` | See below. |
| `parameters_set` + category `recovery` | `quic:recovery_parameters_set` | `Object.keys(data).length + " recovery parameters set"` (port: `N` counts the keys of `raw.data`, LD7, §9.3.6) |
| `parameters_set` + category `transport` | `quic:parameters_set` | `N + " transport parameters set"` |
| `parameters_set` + category `http` | `http3:parameters_set` | `N + " HTTP/3 parameters set"` |
| `parameters_set` + another category | — | `N + " UNKNOWN parameters set"` and `console.error("SequenceDiagramD3Renderer:eventToShortString : unknown category for 'parameters_set' event...", category)` |
| `connection_state_updated` | `quic:connection_state_updated` | `"Connection state: " + data.new` |
| `loss_timer_updated` (draft-02 string) | `quic:timer_updated` | `pn + " " + (timer_type !== undefined ? String(timer_type).toUpperCase() + " " : " ") + "timer " + event_type + at`. `pn` = `""`, or `packet_number_space + " "` with `application_data` shortened to `"appdata "`. `at` = `" @ " + (relativeTime(evt) + delta).toFixed(4)` only when `event_type === "set"`. Old `timeout` was a fallback for `delta`. Example: `"appdata  PTO timer set @ 123.4560"` (HTML collapses the double space). Port: LD4 for a missing `event_type` or `delta` (§9.3.5). |
| `packet_lost` | `quic:packet_lost` | when `data.header.packet_number !== undefined`: `(packet_type !== undefined ? packetTypeToString(pt) + " " : "") + "packet lost #" + packet_number` (e.g. `1RTT packet lost #42`); else `"packet_lost"` |
| `congestion_state_updated` | `quic:congestion_state_updated` | when `data.new !== undefined`: `"Congestion state: " + String(data.new).replace("_", " ")` (**first** underscore only); else the type name |
| `frame_parsed`, `frame_created` | `http3:frame_parsed`, `http3:frame_created` | See below. |
| `info`, `debug`, `warning`, `error`, `verbose`, `connection_error`, `internal_error`, `application_error`, `internal_warning`, `marker`, `message` | `loglevel:error|warning|info|debug|verbose`, `simulation:marker` | qvis: `data?.message === undefined` gives the type name; else `category + ": " + data.message`. Port: the prefix is the **level** for `loglevel:*` (`"error: …"`, `"warning: …"`, `"info: …"`, `"debug: …"`, `"verbose: …"`, matching the old category prefix) and `"simulation"` for `simulation:marker`. |
| default | everything else | the type name, e.g. `packet_dropped`, `packet_buffered`, `connection_started`, `connection_closed`, `connection_id_updated`, `udp_datagrams_sent`, `key_updated`, `stream_state_updated`, `version_information`, `alpn_information`, `scenario` |

`recovery_metrics_updated` label (`:1994-2048`). `keys = Object.keys(data)`; `count = 0`; parts are joined with
`", "`:

1. if `"cwnd"` is in keys: `"cwnd: " + data.cwnd`. Legacy draft-00/01 key. Port: also accept `congestion_window`,
   labelled `cwnd: ` (SQ18).
2. if `"smoothed_rtt"` is in keys: `"srtt: " + value`
3. if `"bytes_in_flight"` is in keys: `"in flight: " + value`
4. if `"ssthresh"` is in keys: `"ssthresh: " + value`
5. if `count > 0` and `keys.length - count > 0`: append `", ..."`
6. if `count === 0`: list **all** keys as `"key: value"` joined by `", "`

Examples: `cwnd: 14720, srtt: 25.3, in flight: 1252, ...` and `min_rtt: 10, latest_rtt: 12`.

HTTP/3 `frame_created` / `frame_parsed` label (`:2122-2198`):

```js
streamID = data.stream_id !== undefined ? " (stream " + data.stream_id + ")" : "";
if (data.frame && data.frame.headers) {                       // HEADERS frame
   for (h of headers)    // last occurrence wins; both ":x" and legacy "x" names accepted
      ":method"|"method" → method; ":path"|"path" → path; ":authority"|"authority" → authority; ":status"|"status" → status
   s = (status ? status + " " : "") + (method ? method + " " : "") + (path ? path + " " : "");
   if (s !== "") s += streamID + " ";
   if (authority) { if (s === "") s += streamID + " "; s += authority; }
   if (s !== "") return s;      // e.g. "GET /index.html  (stream 0) example.org"   "200  (stream 0) "
}
return (data.frame?.frame_type ? frame_type + " " : "") + " " + (type === "frame_created" ? "created" : "parsed") + streamID;
                                 // e.g. "data  created (stream 0)", "settings  parsed (stream 3)"
```

Latest drafts: `HTTP3HTTPField = {name?, name_bytes?, value?, value_bytes?}`. Read names and values through the
shared h3 helpers `fieldName()` / `fieldValue()`, which fall back to the hex `*_bytes` members (LD5, §9.3.10). Keep the
exact spacing; the browser collapses repeated and leading whitespace.

### 3.13 Colors

#### 3.13.1 `frameTypeToColor(frame_type) → [background, text]` (`:1752-1789`)

| frame types | background | text |
|---|---|---|
| `ack` | `#03ad25` (green) | `#FFFFFF` |
| `stream`, `crypto` | `#0468cc` (blue) | `#FFFFFF` |
| `padding` | `#ff69b4` (pink) | `#FFFFFF` |
| `connection_close`, `reset_stream`, `application_close` (legacy), `stop_sending`; port also `reset_stream_at` (X1, §9.4) | `#a80f3a` (dark red) | `#FFFFFF` |
| `new_connection_id`, `retire_connection_id` | `#068484` (teal) | `#FFFFFF` |
| `ping`, `path_challenge`, `path_response` | `#d6dd02` (yellow) | `#000000` |
| `max_data`, `max_stream_data`, `max_streams`, `data_blocked`, `streams_blocked`, `stream_data_blocked` | `#5f0984` (purple) | `#FFFFFF` |
| anything else (`new_token`, `handshake_done`, `datagram`, `unknown`, `unknown_frame_type`, extension frames, …) | `#FF0000` | `#FFFFFF` |

#### 3.13.2 `eventTypeToColor(evt)` (`:1941-1982`): an if/else-if chain, evaluated in this order

| Condition (qvis, old) | Latest | Colors |
|---|---|---|
| type `connection_id_updated` | `quic:connection_id_updated` | as `new_connection_id`: `#068484`/white |
| type `spin_bit_updated` | `quic:spin_bit_updated` | as `ping`: `#d6dd02`/black |
| type `connection_state_updated` | `quic:connection_state_updated` | `data.new` is `closed` or `draining` (port: also the new `closing`, X2, §9.3.7): as `connection_close`, `#a80f3a`/white. **Any other state falls out of the chain to the default `#FF0000`/white** (SQ22). |
| type `metrics_updated`, or `parameters_set` (any category), or `loss_timer_updated` | `quic:recovery_metrics_updated`, `quic:parameters_set`, `quic:recovery_parameters_set`, `http3:parameters_set`, `quic:timer_updated` | as `max_data`: `#5f0984`/white |
| type `frame_created`, `frame_parsed` | `http3:frame_created`, `http3:frame_parsed` | as `stream`: `#0468cc`/white |
| type `datagrams_sent`, `datagrams_received` | `quic:udp_datagrams_sent`, `quic:udp_datagrams_received` | `#FFFFFF`/`#000000` |
| category `error` | `loglevel:error` | `#FF0000`/`#000000` |
| category `warning` or `simulation` | `loglevel:warning`, `simulation:*` | `#FFA500` (orange)/`#000000` |
| category `debug`, `info`, `verbose` | `loglevel:debug`, `loglevel:info`, `loglevel:verbose` | `#D3D3D3` (lightgrey)/`#000000` |
| otherwise | e.g. `packet_lost`, `packet_dropped`, `packet_buffered`, `congestion_state_updated`, `key_updated`, `connection_started`, … | `#FF0000`/`#FFFFFF` |

The packet chip on arrows is always `#383d41` on `#d6d8db`.

### 3.14 Click handling and popup (`D3Renderer.ts:79-138`, `SequenceDiagramRenderer.vue:85-150`)

`onEventClicked(rawEvt, connection, focusInfo)`:

1. `evt = connection.parseEvent(rawEvt)`.
2. **Prefer the original over a generated event.** The condition as written is
   `connection.wasAutoGenerated && type === packet_sent || type === packet_received`, which JS evaluates as
   `(gen && sent) || received`. When it holds and `rawEvt.qvis.sequencediagram.rightTarget` exists, replace `rawEvt`
   with that target and log `"SequenceDiagramD3Renderer:onEventClicked : switched event from auto-generated to original"`.
   The comment assumes the client is always on the left. In practice:
   - clicking a **left-side generated client**'s arrow (its `packet_sent`) shows the server's original
     `packet_received`
   - clicking a **right-side generated server**'s arrows or squares shows the generated clone, with the swapped name
     (SQ3)
3. `rawEvt.qvis.sequencediagram.focusInfo = focusInfo`. It is attached to the event that is **shown**, while
   `focusInfo` still names the clicked trace and index. Because the mirror is index-aligned, the "Event nr" is still
   correct.
4. If `evt.type === metrics_updated`: walk `connection.getEvents()` from the start up to **and including** `rawEvt`.
   For each `metrics_updated`, copy every key of its `data` into a `Map` (later values overwrite earlier ones; key
   order is first appearance). Then call `onEventClicked(rawEvt, Object.fromEntries(map))`. Otherwise call
   `onEventClicked(rawEvt, undefined)`.

`showEventModal(event, extra)`:

- `eventDetail = JSON.stringify(event, null, 2)`
- `eventDetailExtra = extra !== undefined ? JSON.stringify(extra, null, 2) : null`
- if `event.qvis.sequencediagram.focusInfo` exists:
  - `traces = renderer.getTraces()`
  - `URLs` = the distinct `trace.connection.parent.URL` values, truthy only, in trace order
  - `trace = traces[focusInfo.connectionIndex]`
  - if `trace && URLs.length > 0`:
    - `fileLinks` = `"file=" + URLs[0]` when there is one URL, else `"file1=" + URLs[0] + "&file2=" + …`
    - if `trace.connection.parent.URL` is set, `eventLink` is
      `"https://qvis.quictools.info?#/sequence?" + fileLinks + "&focusOnConnection=" + focusInfo.connectionIndex + "&focusOnEvent=" + focusInfo.eventIndex`
      (no encoding, hard-coded host; app-shell Q18 FIX); otherwise `null`
  - else `eventLink = null` and
    `console.error("SequenceDiagramRenderer:showEventModal : trying to focus on trace, but doesn't exist: ", …)`
  - `eventDetail = "Event nr: " + focusInfo.eventIndex + "\n" + eventDetail`
- `$bvModal.show("event-modal")`. "Close" calls `$bvModal.hide`.

### 3.15 Trace selection heuristics (`SequenceDiagramConfigurator.vue:94-239`)

`onConnectionSelected(index, conn)` runs when the user picks a trace in selector `index`. Definitions:

- `P = conn.parent`
- `all = P.getConnections()`, which includes previously generated traces at the end
- `nonGen = all.filter(c => !c.wasAutoGenerated)`
- `persp(c) = c.getVantagePointPerspective()`: `type` when it is client or server; otherwise
  `flow || "unknown"` (`Connection.ts:113-124`)
- `wrap(c) = {connection: c, timeOffset: c.parser ? c.parser.timeOffset : 0}`, a new wrapper every time, with
  `timeOffset` always 0 for the latest drafts

The first matching case wins:

| Case | Condition | New `config.connections` |
|---|---|---|
| A | `index === 0 && nonGen.length === 1` | `[wrap(all[0])]`. That is the file's first trace (the original), even when the user picked its generated sibling. The renderer then reuses or creates the mirror. |
| B | `nonGen.length === 2` (any index) | `f = all[0]`, `s = all[1]`. If `persp(f) === persp(s)` (typical for `group_id` splits): `[wrap(conn)]`. Else if `persp(f) === "client"`: `[wrap(f), wrap(s)]`. Else if `persp(s) === "client"`: `[wrap(s), wrap(f)]`. **Else (e.g. server + unknown): no change at all** (SQ8). |
| C | `all.length > 2` | `r = [wrap(conn)]`; `fp = persp(conn)`. For `j` from `all.indexOf(conn)+1` to the end: if `persp(all[j]) !== fp && !all[j].wasAutoGenerated`, push `wrap(all[j])`; else break. The result is `r`. Each trace is compared with the **selected** trace's perspective, not the previous one's. |
| D | `index > 0` | "All the same vantage point" logic, below. |
| E | otherwise (effectively unreachable) | `config.connections[index] = wrap(conn)` (Vue.set) |

Case D:

```js
let allSame = true, prev = "unknown", firstNonGen = undefined;      // NB: ends up holding the LAST non-generated one
for (i = 0; i < L; ++i) {
   const c  = (i === index) ? conn : config.connections[i].connection;
   const vp = c.vantagePoint.type;                                   // type, NOT perspective
   if (!c.wasAutoGenerated) firstNonGen = c;
   if (i !== 0 && vp !== prev) { config.connections[index] = wrap(conn); allSame = false; break; }
   prev = vp;
}
if (allSame && prev === "network") { allSame = false; config.connections[index] = wrap(conn); }   // pcap2qlog allowance
if (allSame) {
   if (firstNonGen) { console.warn("SequenceDiagramConfigurator: all selected traces had the same vantagePoint, auto-selecting the first non-autogenerated trace"); config.connections = [wrap(firstNonGen)]; }
   else { console.error("SequenceDiagramConfigurator: all selected traces had the same vantagePoint and were also auto-generated. Trying to find a proper trace.");
          first non-generated c in P → [wrap(c)], else console.error("SequenceDiagramConfigurator: Proper trace not found, keeping last selected connection. THIS SHOULD NOT HAPPEN!") and [wrap(conn)] }
}
```

Examples:

- **Single-trace file** (client), default view `[client, GENERATED server]`. Picking anything in selector 0 gives
  case A, the same result. In selector 1, picking the GENERATED trace gives case D: types differ, so it is set at
  index 1. Picking the client again in selector 1 gives types `client, client`: all the same, so the result is
  `[wrap(client)]`, then mirrored again.
- **Two-trace file** (client + server): `selectDefault` shows `[client, GENERATED server]` (SQ1). Picking the server
  or client in any selector gives case B, `[client, server]`, with the latency offset computed automatically.
- **Two single-trace files** (client.qlog, server.qlog):
  1. The default is `[client, GENERATED server]`.
  2. Picking `server.qlog`'s trace in selector 1 gives case D: types `client` and `server` differ, so the result is
     `[client, server]`.
  3. The offset is auto-calculated, but only once the generated trace is no longer selected, which is true now.

### 3.16 Performance strategies (all must be kept in spirit)

1. **Vertical virtualization** by screen-height ranges: at most about 5 range groups exist in the DOM. Unseen
   ranges are removed, because style recalculation and layout grow super-linearly with the DOM size.
2. **Raw DOM creation** instead of d3 data joins.
3. **k-way merge** for the layout instead of concatenating and sorting the events.
4. **Windowed packet matching** (±10%, clamped to 200-1000 candidates around the last match) instead of
   O(n·m).
5. **A per-connection lookup table** (`category → type → events`) built once.
6. The UI **warns** when the first trace has more than 10000 events.
7. `forceFull` (debug and "save SVG" use) disables virtualization.
8. Bypassing Vue reactivity for events and parsers (the `_isVue` hack). The port keeps events out of React state
   and out of zustand-proxied objects.

Known costs:

- Each range render iterates every trace from event 0 (O(N) per range).
- Inactivity markers are drawn eagerly.
- The canvas approach was abandoned.

---

## 4. Event and field consumption

Old names are the qvis checks (qlog draft-02-era `category`/type, plus legacy). New names are the latest drafts:
main-schema-14, quic-events-13, h3-events-13. qvis matches on the type part **only**, except where a category is
listed.

| Old (qvis) | Fields used | Latest draft (namespace:type, fields) | Used for |
|---|---|---|---|
| **every event** (any name, including unknown events and the mirror's `ignoreseq` events) | `time` through `absoluteTime` (`:850`); the event's index in `connection.getEvents()` (`focusInfo.eventIndex`, "Event nr", `focusOnEvent`); `name` (type part) and `category` for dispatch; the raw object (popup JSON) | `Event.time`, resolved with the effective `time_format` / `reference_time` (per event or `common_fields`); canonical `name` | y layout (§3.6), timestamp text, the square, click target and popup. `connection.getEvents().length` also drives SN1 (> 10000), the empty-trace drop (§3.3 step 1) and alert C8 (> 0). |
| `transport:packet_sent` | `data.header` (presence check), `data.header.packet_type`, `data.header.packet_number` (compared as strings), `data.frames[]` (all frame fields in §3.12.2; `frame.qvis.sequence.hide`), the raw event for the popup | `quic:packet_sent`: `header: PacketHeader {packet_type, packet_number?}`, `frames?: [$QuicFrame]` | arrow start events (§3.7); arrow label (§3.11: packet chip = `packetTypeToString(packet_type) + " : " + packet_number`); mirroring (it becomes `packet_received`); vantage guess (Initial with PN 0, compared by `absoluteTime`); RTT correlation (client Initial with PN equal to the server's first received Initial PN); `focusOnPN` lookup (truthy PN); the "no side label" rule; click "prefer original" swap (`:84-100`) |
| `transport:packet_received` | same | `quic:packet_received`: same fields | arrow end events; mirroring; vantage guess; RTT correlation (server's first Initial received, client's first Initial received); the "no side label" rule |
| `recovery:metrics_updated` | `latest_rtt`, `smoothed_rtt` (RTT, truthiness checks, then `timeToMilliseconds()` at `:662`/`:685`); `cwnd` (legacy), `smoothed_rtt`, `bytes_in_flight`, `ssthresh` (label); every key (fallback label, popup aggregation from the first event up to and including the clicked one) | `quic:recovery_metrics_updated`: `min_rtt, smoothed_rtt, latest_rtt, rtt_variance, pto_count, congestion_window, bytes_in_flight, ssthresh, packets_in_flight, pacing_rate, *ext` (all ms or bytes) | time alignment (§3.5.2), side label, purple color, popup "Value of all recovery metrics at this point:" |
| `recovery:packet_lost` | `header.packet_type`, `header.packet_number` | `quic:packet_lost`: `header?: PacketHeader`, `frames?`, `trigger?` | side label "`<PT> packet lost #N`" (red). **Not** used for the arrow loss markers. |
| `recovery:congestion_state_updated` | `new` | `quic:congestion_state_updated`: `old?, new, trigger?` (free text) | side label (red) |
| `recovery:loss_timer_updated` (draft-02, string literal) | `event_type`, `delta` (or legacy `timeout`, both through `timeToMilliseconds()`), `packet_number_space`, `timer_type`, plus the event's `relativeTime` | `quic:timer_updated`: `timer_type?, timer_id?, packet_number_space?, event_type: set/expired/cancelled, delta?` (ms) | side label (purple). The draft-01 names `loss_timer_set` / `loss_timer_triggered` were **not** recognized by qvis (default red chip); the latest loader aliases them to `quic:timer_updated` (§9.3.5). |
| `transport:parameters_set` | key count | `quic:parameters_set` | "`N transport parameters set`" (purple) |
| `recovery:parameters_set` | key count | `quic:recovery_parameters_set` | "`N recovery parameters set`" (purple) |
| `http:parameters_set` | key count | `http3:parameters_set` | "`N HTTP/3 parameters set`" (purple) |
| `connectivity:connection_state_updated` | `new` | `quic:connection_state_updated`: `old?, new` (`attempted`, `handshake_started`, `handshake_complete`, `closed`, `peer_validated`, `early_write`, `handshake_confirmed`, `closing`, `draining`, or custom) | label "`Connection state: X`"; dark red for `closed`/`draining`, bright red otherwise |
| `connectivity:spin_bit_updated` | `state` | `quic:spin_bit_updated`: `state: bool` | "`Spin ON/OFF`" (yellow) |
| `connectivity:connection_id_updated` | (none; name only) | `quic:connection_id_updated` | label = type name, teal |
| `transport:datagrams_sent` / `datagrams_received` | (none) | `quic:udp_datagrams_sent` / `quic:udp_datagrams_received` | label = type name, white chip |
| `http:frame_created` / `frame_parsed` | `stream_id`, `frame.frame_type`, `frame.headers[].name/value` (`:method`, `:path`, `:authority`, `:status`, plus colon-less legacy names) | `http3:frame_created` / `http3:frame_parsed`: `stream_id`, `frame: $HTTP3Frame`; HEADERS `headers: [HTTP3HTTPField {name?, name_bytes?, value?, value_bytes?}]` | label (blue) |
| categories `error`/`warning`/`info`/`debug`/`verbose`/`simulation` with types `connection_error`, `application_error`, `internal_error`, `internal_warning`, `message`, `marker`, … | `message` | `loglevel:error|warning` (`code?, message?`), `loglevel:info|debug|verbose` (`message`), `simulation:marker` (`type?, message?`), `simulation:scenario` (`name?, details?`) | label `"<level>: <message>"`; color by level (§3.13.2) |
| **every other event** | name only | e.g. `quic:packet_dropped` (`header?, trigger?`), `quic:packet_buffered`, `quic:connection_started/closed`, `quic:key_updated`, `quic:stream_state_updated`, `quic:version_information`, `quic:alpn_information`, `quic:frames_processed`, `quic:stream_data_moved`, `quic:mtu_updated`, `quic:tuple_assigned`, `quic:migration_state_updated`, `quic:ecn_state_updated`, `http3:stream_type_set`, `http3:priority_updated`, … | square, timestamp, red side label with the type name; click shows the JSON |

Frames inside `packet_sent` (and so on), for the arrow labels: `frame_type` plus the per-type fields in §3.12.2, from
quic-events-13 §8.13. Legacy frame types still recognized: `application_close` (color), `unknown_frame_type`
(default). The latest drafts do not need them.

Trace- and file-level fields:

| Field | Latest draft | Use |
|---|---|---|
| `vantage_point.type` | `Trace.vantage_point` / `TraceSeq.vantage_point`: `"client"|"server"|"network"|"unknown"` (optional; the loader defaults to `{type:"unknown", flow:"unknown", name:"No VantagePoint set"}`) | perspective, header label 2, mirroring, matching, configurator heuristics, alert C8 |
| `vantage_point.flow` | `"client"|"server"|"unknown"` (for network) | perspective for `network`; header label "`network : from <flow>'s viewpoint`" |
| `vantage_point.name` | text | overwritten on mirrored or guessed traces (shown in the selectors) |
| `title`, `description` | `Trace.title/description` (optional; the loader defaults them to `""`) | prefixed on generated traces (selector text) |
| `common_fields.reference_time`, `time_format`, `Event.time` | main-schema-14 Timestamps | time model (§3.5.1) |
| `common_fields`, `configuration`, `event_fields` (as `eventFieldNames`) | `common_fields` only; `configuration` and `event_fields` no longer exist | deep-copied into the mirror by `Connection.clone()` (`Connection.ts:53-71`); not otherwise read by this view |
| parser `timeOffset`, `getAbsoluteStartTime()`, `getTimeTrackingMethod()`, `setReferenceTime()`, `timeToMilliseconds()` | data-model `ConnectionTiming` | time alignment and the "dragons" repair (§3.5) |
| group `filename`, `URL`, `URLshort` | file-loading spec | header label 1; deep link; `calculateConnections` console messages |
| `parent.getConnections()` | data-model group | configurator heuristics (§3.15); the mirror is appended to it |

Implementation-specific and legacy fields (not qlog):

| Field | Where | Port treatment |
|---|---|---|
| `frame.qvis.sequence.hide` | written by `PacketizationQUICPreProcessor.ts:320` onto injected filler frames (`frame_type: "qvis-injected FILLER (deal with incorrectly guesstimated frame size)"`), which it **unshifts into the shared raw `data.frames`** | Honor `qvis?.sequence?.hide` in the sequence diagram. Better: the packetization port must not mutate shared events (SQ30). |
| `rawEvent.timeText` | written by `calculateCoordinates`; **enumerable**, so it leaks into the popup JSON and qlog downloads | Do not write it; keep it in a side table (SQ14). |
| `rawEvent.qvis.sequencediagram.{y, rightTarget, leftTarget, packetLost, focusInfo}` | non-enumerable | side tables |
| `connection.qvis.sequencediagram.{generatedSibling, manualTimeOffset}` | non-enumerable | `WeakMap`s keyed by connection |
| `connection.wasAutoGenerated` | boolean, written only by this view | keep the field (the selectors, stats, the export and the file manager count read it) |
| legacy aliases: `packet_type` `"onertt"` / `"zerortt"`; metrics `cwnd`; timer `timeout`; header names without a colon; `raw_error_code`; string `packet_number`s | old drafts | Keep the cheap aliases (they are harmless); they never occur in latest-draft files. |
| `configuration.time_offset`, `time_units` | removed after main-schema-05 | not supported (the offset is always 0, times are always ms) |

---

## 5. URL query parameters and global state

### 5.1 Query parameters

All are read from the **hash** query, which persists across tab switches (app-shell rule 2).

| Param | Read at | Semantics |
|---|---|---|
| `focusOnConnection` | `SequenceDiagramRenderer.vue:60-68` (`created`) | `parseInt(…,10)`: index into the **rendered** trace list, including the mirror. Used with `focusOnEvent`, or with `focusOnPN` (default 0). |
| `focusOnEvent` | same | `parseInt`: index into that trace's event array. It needs `focusOnConnection` too. |
| `focusOnPN` | same | `parseInt`: the first `packet_sent` in that trace whose `header.packet_number` equals it (string compare, any packet type) becomes the focus event. Used when `focusOnEvent` is absent. |
| `forceFull` | `D3Renderer.ts:1242` | Substring test on `window.location.hash`, so any occurrence works (`?forceFull`, `&forceFull=1`, even inside a file URL). It renders every range and never removes any. |
| `file`, `file1..N` | produced by the modal deep link (§3.14) | loading is in `file-loading.md` |

Truthiness bugs: `focusOnEvent=0`, `focusOnPN=0`, and packet number 0 inside the PN search all do nothing (SQ10;
app-shell Q17). When focus is applied, see §3.2 and SQ11.

### 5.2 Global state

| State | Owner | Notes |
|---|---|---|
| `configurations.sequenceDiagramConfig` (`ConfigurationStore.ts:12`) | Vuex | `{connections: SequenceDiagramConnection[], timeResolution: number|string}`. A singleton for the app's lifetime; it survives route changes and is lost on reload. Both the configurator and the renderer **mutate it in place**. |
| `connections.groups`, `outstandingRequestCount` | ConnectionStore | groups for the selectors and `selectDefault`; alerts C9/C10 |
| group connection lists | mutated | The mirror trace is appended to `parent.getConnections()` permanently (until the file is removed). |
| the event parser of a trace | mutated | `setReferenceTime` in the "dragons" repair changes `absoluteTime` for **every** view (SQ19). Mirror event names are rewritten in the clone only. |
| raw event objects | mutated | `timeText` (enumerable), `qvis.sequencediagram.*` |
| `window` scroll listener | renderer instance | never removed (SQ20) |
| `screen.height`, `window.pageYOffset`, `window.innerHeight`, `document.body` rect | read | range size and visibility |
| `window.location.hash` | read | `forceFull` |
| `$route.query` | read once in `created()` | focus params |
| `#event-modal` | bootstrap-vue | single modal instance |

---

## 6. Edge cases, error handling, notifications

### 6.1 Notifications (vue-notification, group `"default"`; rendering rules in `app-shell.md`)

| # | Type | Title (verbatim) | Text (verbatim; `<br/>` = line break) | When |
|---|---|---|---|---|
| SN1 | `warn` | Trace might take long to render | Some large traces can take a long time to render. Please be patient. | Before each render triggered by a config change when `config.connections[0]` has more than 10000 events. A 200 ms delay follows. |
| SN2 | `error` | Trace could not be rendered | This trace could not be rendered. There could be an error or a previous file was still rendering.<br/>See the JavaScript devtools for more information. | `render()` resolved `false`: no selected trace has events, or a render was already running after the SN1 wait. |

### 6.2 In-page alerts (configurator)

| # | Variant | Text (verbatim) | Condition |
|---|---|---|---|
| SA1 | danger | The selected trace has an unknown vantage point. We guessed it based on heuristics, but this could be wrong! | §2.2 C8 |
| SA2 | danger | Please load a trace file to visualize it | no groups and no outstanding requests |
| SA3 | warning | Loading files... | no groups, requests outstanding |

### 6.3 Strings produced on traces (visible in selectors)

- `"Simulated, autogenerated trace : " + title` and the same prefix on `description`
- `vantagePoint.name = "GENERATED"`
- `"vantage point type was unknown, pretending it's server"` / `"…client"`, on both the original and the mirror
- The full selector label of a mirror, built by ConnectionConfigurator, e.g.
  `GENERATED : server (flow = unknown) : Simulated, autogenerated trace : T : Simulated, autogenerated trace : D`

### 6.4 Console diagnostics (keep them as `console.*`; not user-visible)

`setup`: "None of the selected traces have events in them, cannot render".

`calculateTimeOffsets`:

- the more-than-2 warning
- the two "HERE BE DRAGONS" errors
- "initial received is earlier than sent!"
- the "calculating probable RTT from metrics_updated events…" log
- "offset determined at "

`calculateConnections`:

- missing `header`
- missing `packet_number` (except VN, retry and stateless_reset)
- "did not have packet_sent/packet_received events, which are needed"

`renderPartialExtents` focus errors:

- "packet number couldn't be found in the trace..."
- "couldn't focus on event, y unknown"
- "couldn't focus on event, eventIndex unknown"
- "neither eventIndex nor pnIndex was set, one is required to focus!"
- "couldn't focus on event, traceIndex unknown"
- the `forceFull` warning

Configurator: the three case-D messages (§3.15). `eventToShortString`: the unknown `parameters_set` category.

### 6.5 Edge cases

| Situation | qvis behavior |
|---|---|
| No file loaded | SA2. The SVG is an empty 300×150 inside the 200px bordered box. |
| File with zero traces or connections | `selectDefault` throws in `createConnectionWithTimeoffset(undefined)` (app-shell Q12: FIX by picking the first group that has a connection). |
| All selected traces have 0 events (e.g. TraceError placeholders) | SN2. The previous drawing is **not** cleared, because `setup` returns before `selectAll().remove()`. |
| One selected trace has 0 events | It is dropped silently. The remaining trace is mirrored if it is alone; `config.connections` is overwritten without the empty one. |
| Single trace, any vantage point | mirrored (§3.4); all arrows horizontal; no loss; no latency input |
| Same connection selected twice | not deduped (SQ6); the y values of the shared raw events are overwritten by the second column, giving a broken layout |
| 3+ traces | no auto offsets (warn); manual "Latency offset" on every index ≥ 1; network-trace arrows wrong (SQ9) |
| `packet_sent` without `header` / `packet_number` (retry, VN, stateless reset) | square and timestamp only, no label (SQ31) |
| Peer trace has no `packet_received` | every sent packet drawn as lost (half arrow + X) |
| Packets matched across a big clock skew | Arrows may point **up** (no check exists; there is a TODO). |
| More than 30 combined selector options | separate-select mode, without the latency input (app-shell Q9) |
| Empty "Latency offset" input | `NaN` offset, the merge crashes, `rendering` stays true, and the diagram never updates again until reload (SQ26) |
| Empty, 0 or negative "Time multiplier" | `""` coerces to 0: all events collapse into bucket 0 (stacked); negative values break the merge order (SQ25) |
| Very narrow window | negative side-label width for trace 0, so those labels vanish (SQ24) |
| Window resized | the SVG keeps its old width until the next config change (SQ21) |
| Navigating away and back | Re-rendered from the stored config on mount, without focus. The scroll position is wherever the browser left it; ranges are drawn for that position. |
| Focus target already in view, or page not scrollable | nothing drawn until the user scrolls (SQ11) |

---

## 7. Known bugs and quirks: PRESERVE or FIX

| ID | Quirk (qvis) | Decision |
|---|---|---|
| SQ1 | `selectDefault` adds only `groups[0].connections[0]`. A file with a client **and** a server trace (e.g. demo `doublevantage_100ms.qlog`) therefore opens as `[client, GENERATED server]`, and appends a mirror to the group. The real pair appears only after the user re-selects a trace (case B). | **FIX:** the default selection (mount, updated, URL load) calls the same heuristic as a user pick in selector 0: `onConnectionSelected(0, groups[0].connections[0])`, so client+server files open as the pair with an automatic offset. Single-trace files behave exactly as in qvis. "Add trace" keeps the qvis behavior (it appends). Deep-link impact: a qvis link with `focusOnConnection=1` for such a file pointed at the mirror; in the port it points at the real server. This is accepted, since qvis's own links for such files were inconsistent too. |
| SQ2 | `ensureMoreThanOneTrace` and the configurator both rewrite `config.connections` while a render is in progress, and the rendering flag swallows the re-entrant watcher. | **PRESERVE** the semantics (exactly one layout per user action; the UI shows the written values). Implement it explicitly (§8.4), not through a re-entrancy flag. |
| SQ3 | The click "prefer original" check has wrong precedence and only follows `rightTarget`. A right-side generated server shows the cloned (name-swapped) JSON; generated `packet_received` squares never switch. | **FIX:** if the clicked event belongs to an auto-generated trace, show its original counterpart. Use the forward target (`rightTarget` or `leftTarget`) when present; else use a reverse map (the original event whose target is this one); else fall back to the clicked event. Keep `focusInfo` (and so "Event nr" and the link) pointing at the **clicked** trace and index, as qvis does. |
| SQ4 | Auto time offset sign: when the server's Initial is received **later** than expected (server clock ahead), qvis adds `+(serverReceive − expected)`, which doubles the skew. | **FIX:** `offset = expected − serverReceiveTime` (signed, possibly negative). The metrics-only fallback (`offset = RTT/2`) is kept as is. Add a unit test with a server clock both ahead and behind. |
| SQ5 | A manual offset of `0` cannot be set: the truthiness check reverts to the remembered or auto value. | **FIX:** track "user-set" explicitly. A user edit, including 0, is stored as the connection's remembered offset and wins over auto-calculation. Non-finite input is ignored (app-shell Q15). |
| SQ6 | Dedupe compares wrapper objects, so a connection selected twice is kept twice and the layout breaks. | **FIX:** dedupe by `connection` identity (keep the first). Write the deduped list back to the config. If one trace remains, mirror it. |
| SQ7 | A reused `generatedSibling` is always **appended** (right), so re-selecting a server trace in selector 0 puts the server left and the generated client right. | **FIX:** place the sibling by perspective (client left via unshift, server right via push), exactly like first-time generation. |
| SQ8 | Case B with two non-generated traces where neither is a client (e.g. server + unknown) changes nothing: the selector shows the pick but the diagram does not change. | **FIX:** fall back to case E (`config.connections[index] = wrap(conn)`). |
| SQ9 | Matching for 3+ traces and same-perspective pairs. The start type is always `packet_sent`, and the left pass wipes middle traces' `rightTarget`. Network traces (flow client) between client and server get reversed arrows; two same-perspective traces get duplicate upward arrows and no server-to-client arrows. | **FIX** with this rule, which is **identical to qvis for every 2-trace pair with different perspectives** (verify with tests). (1) `eff(X)` = `type` for client and server; `flow` for network when it is client or server; else unknown. (2) `L = eff(traces[0])` when known, else the opposite of `eff(traces[n-1])` when known, else `"client"`; `R = opposite(L)`. (3) A trace with unknown `eff` is treated as `L` when it is first or in the middle, and as `R` when it is last. (4) Pass right (t to t+1) matches "packets sent by L": in any trace X, those are `packet_sent` if `eff(X) === L`, else `packet_received`. Pass left (t to t-1) matches "packets sent by R" the same way. (5) Store right and left targets and the lost direction **per direction**; never clear the other direction. (6) Drawing priority is unchanged: right, left, lost-right, lost-left. |
| SQ10 | `focusOnEvent=0`, `focusOnPN=0` and PN 0 inside the search are ignored (truthiness). | **FIX:** `!== undefined` / `Number.isFinite`. The search also accepts PN 0. |
| SQ11 | Focus is applied only on renders triggered by a config change. A mount with an existing config (e.g. returning to the tab, or loading the files before visiting the tab) ignores it, and the pending focus then fires on the **next unrelated** config change. After `scrollTo`, the function returns without drawing, so if no scroll event fires the diagram stays empty. | **FIX:** apply the URL focus once, on the first successful render after mount (whichever path triggered it), then clear it. After `scrollTo`, always run the range render. Keep the target formula `window.scrollTo(0, y − 50)` with the SVG-relative `y` (this is the visual parity). |
| SQ12 | The lost-arrow slant uses `previousYDiffRight/Left`, which reset on every partial render call, so the same lost packet can look different depending on scroll history. | **FIX** (deterministic): precompute it in the layout phase. For a lost event in direction d on trace i, use `target.y − y` of the most recent **earlier event of the same trace** with a found arrow in direction d (0 if none). This equals qvis's `forceFull` result for 2-trace diagrams. |
| SQ13 | Frame labels use truthiness (`stream_id` 0, `maximum` 0 and `limit` 0 fall back to the bare type; e.g. MAX_STREAM_DATA on stream 0 shows `max_stream_data`), and `stream_data_blocked` lacks a space (`stream 4blocked at 1000`). | **FIX:** use `!== undefined` checks and print `"stream " + id + " blocked at " + limit`. All other strings stay verbatim. |
| SQ14 | `timeText` is stored as an enumerable property on raw events, so it appears in the popup JSON and in downloaded qlog files. | **FIX:** a side table. The popup shows only the original event's own fields. |
| SQ15 | The timestamp column is in ms × multiplier (`1500.00` at multiplier 1000 for 1.5 ms), while the inactivity text divides by the multiplier (ms). | **PRESERVE** (matches the tooltip: "1000 = us level"). |
| SQ16 | The first event is measured from bucket −1: it gets an extra 20 px, and a leading inactivity text reads one more than the real gap. Inactivity shows the bucket difference, not the real time difference. | **PRESERVE.** |
| SQ17 | Negative, NaN or out-of-order times are not guarded (y can decrease). | **PRESERVE** for negative values (the loader sorts). NaN is handled by SQ26. |
| SQ18 | The metrics label looks for the legacy key `cwnd` only. The draft-02+ `congestion_window` is never summarized as cwnd. | **FIX:** treat `congestion_window` (and legacy `cwnd`) as the `cwnd: ` part, counted once. This keeps the converted demo files looking like qvis did with the originals. |
| SQ19 | The "dragons" reference-time repair mutates the shared parser, which shifts `absoluteTime` in other views. | **FIX:** apply the override only inside the sequence diagram's time accessor (a per-connection override map). It is recomputed on every render, with the same result. |
| SQ20 | The window scroll listener is never removed on unmount (leak). Every revisit adds another renderer and listener. | **FIX:** remove it on unmount or re-setup. |
| SQ21 | No re-layout on window resize. | **PRESERVE** by default. Optional improvement: re-render (debounced 250 ms) when `container.clientWidth` changes; this cannot change any other behavior. |
| SQ22 | `connection_state_updated` with any state other than `closed`/`draining` falls out of the color chain and is bright red `#FF0000`/white. | **PRESERVE** (established look). |
| SQ23 | Assorted string oddities: `replace("_"," ")` on the first underscore only; double, leading and trailing spaces in the HTTP/3 and timer labels; `"connection_close : clean"` spacing. | **PRESERVE** the strings verbatim. |
| SQ24 | Side-label `div.style.width` has no unit (ignored); trace 0's label width can go negative on narrow screens. | **PRESERVE** the effective layout (do not set the width; it fills the foreignObject). Clamping to `max(0, …)` is the same visual. |
| SQ25 | "Time multiplier" accepts `""`, `0` and negative values (no validation). | **FIX:** render with the last valid value > 0 and leave the input showing what was typed. Re-render on each valid change (qvis re-renders on every keystroke). |
| SQ26 | Any exception inside a render (e.g. a NaN offset) leaves `rendering = true` forever, and the view freezes. | **FIX:** `try/finally`; on an exception, show SN2 and log it. |
| SQ27 | The selector `key = index + timeOffset` (numeric) can collide (app-shell Q16). | **FIX:** use controlled inputs; no remount trick needed. |
| SQ28 | The SN1 warning repeats on every config change for big traces. | **PRESERVE.** |
| SQ29 | Range removal special cases (`from ≤ 2`, the 500-range window). | Not visible. The port may use the simpler "remove every rendered range outside `[cur−2, cur+2]`"; it must keep rendering `[cur−1, cur+1]`. |
| SQ30 | The packetization view injects hidden filler frames into the shared raw `data.frames` (marked `qvis.sequence.hide`). They count toward the ≥8 aggregation threshold, and their mutations show in the popup JSON. | **FIX upstream:** the packetization port must not mutate shared events. Keep the `hide` check here for safety. |
| SQ31 | Sent retry, version-negotiation and stateless-reset packets (no `packet_number`) get no arrow and no label. | **PRESERVE** (optional later: a side chip with the packet type). |
| SQ32 | The mirror trace is appended to its group (it shows in every selector and other views). | **PRESERVE** (app-shell Q13); counts are fixed elsewhere (file-loading Q14). |
| SQ33 | Mirror events other than packets are renamed `<ns>:ignoreseq` (other views that select the mirror see them that way). | **PRESERVE** the rename on the clone's events (other views and stats rely on it). In the port it is a model-level rename (`QlogEvent.type` / `fullName`, `data-model.md` §3.16.10); raw objects stay untouched (§9.6). |
| SQ34 | `setup()` failure does not clear the old drawing. | **PRESERVE.** |
| SQ35 | `onConfigChanged` reads `connections[0]` without checking for emptiness. | **FIX:** guard against an empty list (no render). |

---

## 8. Porting notes for React

Target stack (see `app-shell.md` §8): React 19, Vite, react-bootstrap 2 with Bootstrap 5.3, zustand 5, react-router 8
(hash), d3 7 (optional here).

### 8.1 Suggested module breakdown

```
src/views/SequenceDiagramView.tsx                 route "/sequence" → <SequenceDiagramContainer/>
src/features/sequence/
  SequenceDiagramContainer.tsx                    <div className="home"> configurator + renderer
  SequenceDiagramConfigurator.tsx                 §2.2 (uses shared ConnectionConfigurator)
  SequenceDiagramRenderer.tsx                     div#sequence-diagram + svg ref + EventDetailModal; owns the imperative renderer
  EventDetailModal.tsx                            §2.8
  config.ts                                       zustand slice: { connections: {connection, timeOffset}[], timeResolution }
  selection.ts        pure: onConnectionSelected(state, index, conn) → new connections   (§3.15 + SQ1, SQ8)
  mirror.ts           ensureMoreThanOneTrace / guessPerspective / createMirror            (§3.4 + SQ6, SQ7)
  timeModel.ts        absoluteTime / startTime / relativeTime with local ref-time overrides (§3.5.1, SQ19)
  timeAlignment.ts    calculateTimeOffsets                                                (§3.5.2 + SQ4, SQ5)
  layout.ts           calculateCoordinates → {y[][], timeText[][], intervals, height}     (§3.6)
  matching.ts         calculateConnections → {right[][], left[][], lostDir[][], lostSlant[][]} (§3.7 + SQ9, SQ12)
  labels.ts           packetTypeToString, frameToShortString, eventToShortString           (§3.12)
  colors.ts           frameTypeToColor, eventTypeToColor                                    (§3.13)
  arrowLabel.ts       chip ordering/aggregation (§3.11) → DOM builder
  SequenceDiagramSvgRenderer.ts   imperative class: setup(svg, layout), renderRanges(), focus(), dispose()
  __tests__/…
```

`selection.ts`, `mirror.ts`, `timeAlignment.ts`, `layout.ts`, `matching.ts`, `labels.ts` and `colors.ts` must be pure
and unit-tested. Feed them latest-draft fixtures plus the converted demo files.

### 8.2 Data structures (replace the mutations on raw events)

```ts
type TraceRef = { connection: Connection; timeOffset: number };   // config entry (store)
interface SeqLayout {
  traces: TraceRef[];                         // after dedupe + mirror (what "getTraces()" returned)
  y: Float64Array[];                          // per trace, per event index
  timeText: string[][];
  intervals: { yMin: number; yMax: number; timeSkipped: number }[];
  height: number; startTime: number;
  right: (EventRef | undefined)[][];  left: (EventRef | undefined)[][];
  lost: ("right" | "left" | undefined)[][];   lostSlant: number[][];
  ignored: boolean[][];                       // mirror non-packet events
}
type EventRef = { trace: number; index: number };
const generatedSibling = new WeakMap<Connection, Connection>();   // both directions
const rememberedOffset = new WeakMap<Connection, { value: number; userSet: boolean }>();
const refTimeOverride  = new WeakMap<Connection, number>();       // the "dragons" repair, local (SQ19)
```

The `connection.wasAutoGenerated` field stays on the connection object (other modules read it). The mirror is still
appended to `parent` connections, and the connection store must notify subscribers (app-shell §8.5's change
counter).

Mirror creation: use the data model's `connection.clone(transform)` (`data-model.md` §3.16.10). The transform maps
`quic:packet_sent` to `quic:packet_received` and back, and every other event to `<namespace>:ignoreseq`. The clone
shares the untouched raw event objects (no deep copy), gets its own `QlogEvent` wrappers, lookup index and copied
timing, and is registered in the parent group, so other views can select it. The renames therefore live on
`QlogEvent.type` / `fullName`, not on `raw.name` (§9.6).

### 8.3 Imperative renderer (keep it imperative)

React must **not** render the per-event SVG. Keep a class that:

- **`setup(svgEl, containerEl, layout)`**:
  - clears the SVG
  - sets height, then width = `container.clientWidth`
  - draws timelines, headers and inactivity markers with `createElementNS`
  - builds the range table with `rangeHeight = screen.height`
- **`renderRanges()`**: §3.8, with the exact visibility math (`window.scrollY`, `getBoundingClientRect`), the
  `[cur−1, cur+1]` render window and the `forceFull` hash check.
- **`focus(pointer)`**: §3.9 with the SQ10/SQ11 fixes.
- **Scroll throttling**: every 5th `scroll` event plus a 250 ms trailing timer, on `window`, passive.
- **`dispose()`**: removes the listener and timer.
- **Click delegation**: attach a click handler to each clickable node (as qvis does), or use one delegated listener
  on the SVG with `data-trace` / `data-event` attributes. The delegated listener is equivalent and cheaper. Clicks
  call a callback prop that opens the React modal.

Build the label HTML inside `foreignObject` with `createElementNS(XHTML,"div")` and `document.createElement("span")`.
Use the inline styles from §2.7 exactly (`border:1px white; border-style:none solid` → in JS:
`style.border = "1px white"; style.borderStyle = "none solid"`).

### 8.4 React lifecycle and state

- **Store**: zustand slice `sequenceDiagramConfig`, a singleton kept across routes (no persistence). Actions:
  `setConnections`, `setConnectionAt`, `removeConnectionAt`, `appendDefault`, `setTimeOffset(i, v, {user:true})`,
  `setTimeResolution`.
- **Render effect** in `SequenceDiagramRenderer`, keyed by a "user revision": a counter bumped by user actions
  (selection, add, remove, offset edit, multiplier) and by `groups` changes that trigger the default selection.
  - The effect computes `prepare(config)` (dedupe, mirror, offsets, layout, matching), then `renderer.setup` and
    `renderRanges` or `focus`.
  - It then writes the **derived** values back to the store without bumping the revision (the mirror inserted into
    `connections`, the auto offset into `connections[1].timeOffset`). This reproduces qvis's "one render, UI shows
    the derived values" (SQ2).
  - Do **not** depend on the whole config object deep-equal, or the write-back will re-render.
- **SN1**: before computing, if `connections[0]` has more than 10000 events, call `notify(SN1)` and
  `await new Promise(r => setTimeout(r, 200))`. Use an abort guard for overlapping renders: a newer revision cancels
  an older pending one. The old SN2 "previous file was still rendering" case therefore disappears; SN2 is still shown
  when `prepare` finds no events, or on an exception (SQ26).
- **Focus params**: read once on mount from the router's search params into a ref. Apply on the first successful
  render, then clear (SQ11).
- **Default selection**: in the configurator, a `useEffect` on `[groups.length, connections.length]`. When
  `connections.length === 0 && groups.length > 0`, run the selection heuristic for selector 0 (SQ1).
- **Unmount**: `renderer.dispose()`.
- **Window width**: optional resize re-render (SQ21).

### 8.5 Bootstrap 5 differences to neutralize (pixel parity)

- react-bootstrap `Button` defaults to `variant="primary"`. Set `variant="secondary"` for "Add trace" and "Close".
- BS5 has no `btn-block`. Use `className="mt-3 w-100"` for "Close".
- `Col xs={1}` gives `col-1`, and `className="align-self-center"`. The label `div` uses `text-end` (BS5) in place of
  `text-right`.
- BS4 gutters were 15px (row −15px margins, col 15px padding); BS5 uses 12px (`--bs-gutter-x: 1.5rem`). If pixel
  parity is required, apply the global gutter override chosen in `app-shell.md` §8.
- `Modal`: `show`/`onHide` state, `<Modal.Header closeButton><Modal.Title>Event detail</Modal.Title>`, no footer,
  default size (500px).
- `<pre className="d-block">`. Bootstrap 5's `pre` has the same monospace stack, 0.875em and `overflow:auto`.
- Alerts: `<Alert variant="danger|warning">`. BS5.3's subtle colors differ slightly from BS4; follow the app-shell
  palette decision.
- Tooltip on "Time multiplier: " and "Latency offset : ": ~~`OverlayTrigger trigger={["hover","focus"]} placement="top"`~~
  the shared `useHoverTooltip` (app-shell A9): `v-b-tooltip.hover` delay, geometry and look, measured identical to
  hosted qvis.
- Keep `#app { font-family: 'Avenir', Helvetica, Arial, sans-serif }` and the body `line-height: 1.5`; the
  foreignObject chips depend on them.
- Keep the unscoped CSS `#sequence-diagram-svg text.timestamp { font-size: 11px; }` (global stylesheet).

### 8.6 Tests

Unit tests (vitest):

- `layout`: the worked example in §3.6, exact y values and intervals; the multiplier ×10 and ×1000 `timeText`; the
  first event at bucket ≥ 6 (leading interval, SQ16); stacking with 3 traces in one bucket.
- `matching`:
  - the 2-trace client/server baseline **equals qvis**, including the window clamp (200/1000) and PN-type matching
  - mirrors never lost
  - SQ9 cases: `[client, net(client), server]`, `[net(client), net(client)]`, `[unknown, GENERATED server]`,
    `[GENERATED client, unknown]`, `[server, client]`
- `timeAlignment`: metrics `latest_rtt` path; smoothed fallback (last value); initial-loss PN correlation; server
  clock ahead and behind (SQ4); manual 0 kept (SQ5); `epoch: "unknown"` repair (±5 ms).
- `labels` and `colors`: every row of §3.12 and §3.13, including the exact spaces.
- `selection`: every case A-E with the examples in §3.15, plus SQ1, SQ7 and SQ8.
- `mirror`: perspective table and guess heuristic; names swapped and `ignoreseq`; sibling reuse placement.

E2E (Playwright, visual snapshots against reference screenshots taken from qvis with converted demo files):

- the single-trace client file
- the two-trace file (opened through the SQ1 fix vs qvis after re-selection)
- a lossy trace
- `?forceFull`
- `?focusOnConnection=0&focusOnEvent=N` and `?focusOnPN=N`
- clicking an arrow label opens the modal with "Event nr: N", the JSON and the link; clicking a metrics event shows
  "Value of all recovery metrics at this point:"
- scrolling a 10k+-event trace keeps at most about 5 range `<g>`s in the DOM

### 8.7 Acceptance checklist (quick)

- [ ] Configurator texts, tooltips, alerts and defaults exactly as in §2.2. "Latency offset" appears only for index
      ≥ 1 with no generated trace selected.
- [ ] SVG geometry constants exactly as in §2.4-§2.7 (60/100 margins, 20 px/ms, 120 px cap, 12 px squares, 11 px
      timestamps, 14 px chips, colors).
- [ ] Mirror generation, placement, names and group append as in §3.4 (plus SQ6/SQ7).
- [ ] Auto offset and its write-back to the latency field (plus SQ4/SQ5).
- [ ] Layout identical to §3.6. Matching identical for 2 traces (§3.7).
- [ ] Chip order (§3.11), all label strings (§3.12) and colors (§3.13) verbatim, except the listed FIXes.
- [ ] Virtualized rendering, scroll throttle, `forceFull`, focus params (§3.8, §3.9).
- [ ] Modal content and deep link (§2.8, §3.14), with the app-shell Q18 link fix.
- [ ] Notifications SN1/SN2 verbatim.
- [ ] No mutation of raw events (the mirror's renames live on the clone's model events, §9.6). The listener is cleaned
      up on unmount.
- [ ] Every name and field test uses the canonical latest-draft names and paths of §9 (no `transport:`, `recovery:`,
      `connectivity:` or `http:` tests anywhere in the view), with the LD fixes and the X1/X2 extensions of §9.

---

## 9. Mapping to latest qlog drafts

This section maps every old-schema event and field the sequence diagram consumes (§4) to
draft-ietf-quic-qlog-main-schema-14, draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13. It
also covers what has no equivalent and what is new. Sources: the digests `../qlog-spec/main-schema.md`,
`../qlog-spec/quic-events.md`, `../qlog-spec/h3-events.md` and `../qlog-spec/ecosystem.md`, the drafts themselves
(`the published draft texts (ietf.org)`), and `data-model.md` (§3.16), which defines the event model this view reads.

Summary: **every input this view needs has a latest-draft equivalent.** No feature is lost. The differences are
renamed events and fields, fields that became optional, the time model, and a handful of label texts.

### 9.1 Ground rules

1. **Canonical names only.** The loader (`data-model.md` §3.16.4, `ecosystem.md` §6.4-6.5, `quic-events.md` §15)
   rewrites legacy and intermediate names before any view runs. Examples: quic-go's `transport:packet_sent`,
   `recovery:metrics_updated` and `recovery:loss_timer_updated`; quiche's `quic:datagrams_sent` and
   `quic:key_retired`; mvfst's `quic:loss_timer_updated`; old `http:frame_created`; `generic:*`. The view never
   tests `transport:`, `recovery:`, `connectivity:`, `security:`, `generic:` or `http:` (meaning HTTP/3). In the
   latest drafts, `http` is the Capsule Protocol namespace (h3-events-13 §5).
2. **Dispatch on `QlogEvent.fullName`** (`namespace:type`, split at the **first** colon). qvis switched on the type
   part and used the category in three places. Two helpers reproduce those category rules exactly:
   - `levelOf(e) = e.namespace === "loglevel" ? e.type : e.namespace`. For `loglevel:*` the type is the old
     category (`error`, `warning`, `info`, `debug`, `verbose`); for `simulation:*` it is `"simulation"`, as before.
   - `parameters_set` stays a **type-only** match, so the namespace decides the label: `quic` → transport, `http3`
     → HTTP/3, any other namespace → UNKNOWN. `quic:recovery_parameters_set` is now a distinct type.
3. **Read `e.data`, show `e.raw`.** `e.data` is the normalized data (a shallow copy only when the loader applied a
   fix-up, `data-model.md` §3.16.4 step 5). The popup shows `e.raw`, untouched (no `timeText`, SQ14). Exception:
   key counts use `e.raw.data` (LD7).
4. **uint64 may be a JSON number or a decimal string** (main-schema-14 §11.3). Display values verbatim with
   `"" + v` (qvis did the same). Compare packet numbers with `String(a) === String(b)` (unchanged). Use
   `toNum(v)` (number passthrough, numeric string to `Number`, else `undefined`) only for arithmetic and numeric
   equality (LD2).
5. **Optional means optional.** Most fields this view reads are optional in the latest drafts. Every row below says
   what happens when the field is absent. Required-but-missing fields from sloppy producers are handled the same way
   as absent ones; nothing may throw.

Tags used in this section:

| Tag | Meaning |
|---|---|
| PARITY | Same output as qvis for the equivalent latest-draft input. |
| LDn | Latest-draft fix. qvis would misread a latest-draft field or print garbage (`undefined`, `NaN`); the port renders it as the draft defines. Not optional. |
| Xn EXT-ON | Something new in the latest drafts that qvis never had a rendering for, rendered by direct analogy with an existing qvis rule. On by default. Implement it behind one `LATEST_EXTENSIONS` constant in `labels.ts` / `colors.ts`, so a strict-parity build can switch it off. |
| Xn EXT-OFF | A documented proposal. Not part of v1. |

Decision principle for new items: an item becomes EXT-ON only when the concept did not exist in draft-02 (so qvis
has no established look for it) **and** an existing qvis rule obviously applies. Everything that qvis already
rendered generically (for example a `handshake_done` or `datagram` frame, or a `transport:parameters_restored`
event) keeps the generic look (PARITY).

### 9.2 Name dispatch (every name or category the view tests)

| qvis test (old) | Port predicate (latest) | Used in |
|---|---|---|
| `lookup(transport, packet_sent)`; type `packet_sent` | `conn.lookup("quic", "packet_sent")`; `e.fullName === "quic:packet_sent"` | matching, mirror, guess, RTT correlation, `focusOnPN`, click swap, "no side label" |
| `lookup(transport, packet_received)`; type `packet_received` | `"quic:packet_received"` | same |
| `lookup(recovery, metrics_updated)`; type `metrics_updated` | `"quic:recovery_metrics_updated"` | RTT estimate, label, color, popup fold |
| type `packet_lost` | `"quic:packet_lost"` | label |
| type `congestion_state_updated` | `"quic:congestion_state_updated"` | label |
| string `"loss_timer_updated"` | `"quic:timer_updated"` | label, color |
| type `parameters_set` + category `transport` | `"quic:parameters_set"` | label, color |
| type `parameters_set` + category `recovery` | `"quic:recovery_parameters_set"` | label, color |
| type `parameters_set` + category `http` | `"http3:parameters_set"` | label, color |
| type `parameters_set` + any other category | `e.type === "parameters_set"` with another namespace | "UNKNOWN" label + `console.error`, purple |
| type `connection_state_updated` | `"quic:connection_state_updated"` | label, color |
| type `spin_bit_updated` | `"quic:spin_bit_updated"` | label, color |
| type `connection_id_updated` | `"quic:connection_id_updated"` | color |
| types `datagrams_sent` / `datagrams_received` | `"quic:udp_datagrams_sent"` / `"quic:udp_datagrams_received"` | color |
| types `frame_created` / `frame_parsed` | `"http3:frame_created"` / `"http3:frame_parsed"` | label, color |
| types `info`, `debug`, `warning`, `error`, `verbose`, `connection_error`, `internal_error`, `application_error`, `internal_warning`, `marker`, `message` (any category) | the same **type-only** set (`MESSAGE_TYPES`) with prefix `levelOf(e)` | label |
| category `error` / `warning` / `simulation` / `debug` / `info` / `verbose` | `levelOf(e)` with the same values | color |
| the `ignoreseq` rename (qvis wrote `"transport:ignoreseq"` into `raw.name`) | the clone's events get `type = "ignoreseq"` (`fullName = ns + ":ignoreseq"`) | layout-only events |

Reference implementation of the two dispatchers (the label builders they call are in §3.12 and §9.3):

```ts
const MESSAGE_TYPES = new Set(["info", "debug", "warning", "error", "verbose", "connection_error",
  "internal_error", "application_error", "internal_warning", "marker", "message"]);
const levelOf  = (e: QlogEvent) => (e.namespace === "loglevel" ? e.type : e.namespace);
const keyCount = (e: QlogEvent) => Object.keys(isPlainObject(e.raw.data) ? e.raw.data : e.data).length;   // LD7
const RED_WHITE: [string, string] = ["#FF0000", "#FFFFFF"];

function eventTypeToColor(e: QlogEvent): [string, string] {
  switch (e.fullName) {
    case "quic:connection_id_updated":   return frameTypeToColor("new_connection_id");   // teal
    case "quic:spin_bit_updated":        return frameTypeToColor("ping");                // yellow
    case "quic:connection_state_updated": {
      const s = e.data.new;
      if (s === "closed" || s === "draining" || (LATEST_EXTENSIONS && s === "closing"))   // X2
        return frameTypeToColor("connection_close");                                   // dark red
      return RED_WHITE;                                                                // SQ22: leaves the chain
    }
    case "quic:recovery_metrics_updated":
    case "quic:recovery_parameters_set":
    case "quic:timer_updated":           return frameTypeToColor("max_data");            // purple
    case "http3:frame_created":
    case "http3:frame_parsed":           return frameTypeToColor("stream");              // blue
    case "quic:udp_datagrams_sent":
    case "quic:udp_datagrams_received":  return ["#FFFFFF", "#000000"];
  }
  if (e.type === "parameters_set") return frameTypeToColor("max_data");                // any namespace (qvis: type-only)
  const lvl = levelOf(e);
  if (lvl === "error") return ["#FF0000", "#000000"];
  if (lvl === "warning" || lvl === "simulation") return ["#FFA500", "#000000"];
  if (lvl === "debug" || lvl === "info" || lvl === "verbose") return ["#D3D3D3", "#000000"];
  return RED_WHITE;
}

function eventToShortString(e: QlogEvent): string {
  const d = e.data;
  switch (e.fullName) {
    case "quic:spin_bit_updated":         return "Spin " + (d.state ? "ON" : "OFF");
    case "quic:recovery_metrics_updated": return metricsLabel(d);                  // §9.3.2
    case "quic:parameters_set":           return keyCount(e) + " transport parameters set";
    case "quic:recovery_parameters_set":  return keyCount(e) + " recovery parameters set";
    case "http3:parameters_set":          return keyCount(e) + " HTTP/3 parameters set";
    case "quic:connection_state_updated": return "Connection state: " + d.new;
    case "quic:timer_updated":            return timerLabel(e);                    // §9.3.5
    case "quic:packet_lost":              return packetLostLabel(e);               // §9.3.3
    case "quic:congestion_state_updated":
      return d.new !== undefined ? "Congestion state: " + String(d.new).replace("_", " ") : e.type;
    case "http3:frame_created":
    case "http3:frame_parsed":            return h3FrameLabel(e);                  // §9.3.10
  }
  if (e.type === "parameters_set") {                                               // any other namespace
    console.error("SequenceDiagramD3Renderer:eventToShortString : unknown category for 'parameters_set' event...", e.namespace);
    return keyCount(e) + " UNKNOWN parameters set";
  }
  if (MESSAGE_TYPES.has(e.type)) return d.message === undefined ? e.type : levelOf(e) + ": " + d.message;
  return e.type;                                                                   // default: type name only
}
```

Matching on `fullName` instead of the type differs from qvis only for a custom namespace that reuses a standard type
name (for example a hypothetical `mvfst:spin_bit_updated`). Such an event gets the default chip. This is
intentional: the latest drafts make names unique per namespace.

### 9.3 Per-event field mapping

#### 9.3.1 `quic:packet_sent` and `quic:packet_received` (Core; quic-events-13 §5.5-5.6)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `transport:packet_sent` / `transport:packet_received` | `quic:packet_sent` / `quic:packet_received` | Category `transport` became namespace `quic` (quic-events-05, -09). The mirror swaps them: `quic:packet_sent` ↔ `quic:packet_received` (model-level rename, §9.6). | The `calculateConnections` `console.error`s fire. When the peer has none of the end type, every `quic:packet_sent` of the start trace is drawn as lost; a trace without `quic:packet_sent` starts no arrows (PARITY). |
| `data.header` | `data.header: PacketHeader` (REQUIRED) | Unchanged. | `console.error("…event data does not have the header field, which is required", d)`; square and timestamp only (PARITY). |
| `data.header.packet_type` | same; `$PacketType` = `initial`, `handshake`, `0RTT`, `1RTT`, `retry`, `version_negotiation`, `stateless_reset`, `unknown` | Values identical to draft-02. The packet number space is **not** logged in -13; `packet_type` keeps separating the spaces in the match key exactly as before (0RTT and 1RTT share the application_data space, but each side logs the same type for the same packet). `unknown` comes with `packet_type_bytes`, which this view ignores. | Required. If missing anyway: PARITY (`undefined` is compared like a value; the chip shows `undefined : N`). |
| `data.header.packet_number` (compared as strings) | same; uint64, **optional for every type** | Absent by definition for `retry`, `version_negotiation` and `stateless_reset` (no PN on the wire). May be a decimal string. | §3.7: skipped, no arrow and no label; `console.error` unless VN, retry or stateless reset (SQ31, PARITY). |
| `data.frames[]` | same; `? frames: [* $QuicFrame]` | `$QuicFrame` is an open socket: any object is a frame. Dispatch on `frame_type` (§9.4). | No frame chips: the label is the packet chip plus the direction triangle. Producers that log frames separately (`quic:frames_created` / `frames_parsed`) lose the chips: see X4. |
| (none) | `data.raw`, `data.datagram_id` (-13) / `data.datagram_payload_checksum` (editor's copy), `data.trigger`, `data.is_mtu_probe_packet`, `data.stateless_reset_token`, `data.supported_versions`, event-level `tuple` | New or not consumed. | Ignored (visible in the popup only). |

Uses, with the latest paths:

- **Arrow matching** (§3.7, SQ9): key `(header.packet_type, String(header.packet_number))`.
- **Vantage guess** (§3.4): first `quic:packet_sent` and first `quic:packet_received` with
  `header.packet_type === "initial" && "" + header.packet_number === "0"`, compared by `absoluteTime`. Main-schema-14
  §6 explicitly allows this kind of heuristic ("in QUIC, the client always sends the first packet").
- **RTT correlation** (§3.5.2): server = first `quic:packet_received` with `packet_type === "initial"` and
  `packet_number !== undefined`; client = `quic:packet_sent` initial whose PN string equals it, and the last
  `quic:packet_received` initial before both are found (§3.5.2).
- **`focusOnPN`** (§3.9, SQ10): first `quic:packet_sent` with a defined `header.packet_number` whose string equals the
  parameter, any packet type.
- **`packet_received` with `trigger: "keys_available"`**: logged when a buffered packet (an earlier
  `quic:packet_buffered`) could finally be decrypted. The arrow ends at this event, as in qvis for the same draft-02
  pattern (PARITY). The `packet_buffered` event itself is a default chip.
- Coalesced packets are separate events with separate arrows, as before. `datagram_id` is not used (see X8 for the
  editor's-copy checksum).

#### 9.3.2 `quic:recovery_metrics_updated` (Core; quic-events-13 §7.2)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `recovery:metrics_updated` | `quic:recovery_metrics_updated` | Renamed in quic-events-09. quic-go still writes `recovery:metrics_updated`, and older files use `recovery:metric_update`; the loader aliases both. | — |
| `latest_rtt` (offset estimate) | `data.latest_rtt` (float32, ms) | Always ms. `timeToMilliseconds()` is `parseFloat` (identity); never scale by a time unit. | Not present (or 0, a falsy value) in any client event: fall back to `smoothed_rtt`, then to the server's events, then to the Initial correlation alone (§3.5.2, PARITY). |
| `smoothed_rtt` (offset fallback, label `srtt: `) | `data.smoothed_rtt` (float32, ms) | Same. | Same chain; label part omitted. |
| `cwnd` (label) | `data.congestion_window` (uint64 bytes) | qvis read only the pre-draft-01 `cwnd` (SQ18 FIX). The loader shim renames a legacy `cwnd` to `congestion_window` in `e.data`; the label also accepts `cwnd` directly (cheap). If both keys exist, the label uses `congestion_window` and the other one counts as a leftover key. | Label part omitted. |
| `bytes_in_flight`, `ssthresh` (label) | same (uint64 bytes) | Same. | Label part omitted. |
| every key (fallback label; popup fold) | every present key: `min_rtt`, `smoothed_rtt`, `latest_rtt`, `rtt_variance`, `pto_count`, `congestion_window`, `bytes_in_flight`, `ssthresh`, `packets_in_flight`, `pacing_rate`, plus extension keys | Events are **sparse**: at least one metric per event, unchanged values SHOULD be omitted. qvis's popup fold (carry forward, last value wins, first-appearance key order) is exactly the reading the draft intends. Fold over `e.data` of every `quic:recovery_metrics_updated` from the first event up to and including the clicked one. | A metric that never appeared is not in the popup (PARITY). |
| (removed) `max_ack_delay`, `in_recovery` | gone (now `quic:parameters_set.max_ack_delay` and `quic:congestion_state_updated`) | This view never read them by name. | — |

`metricsLabel(d)`: §3.12.3 with SQ18. Examples under latest producers:

- quic-go `{min_rtt, smoothed_rtt, latest_rtt, rtt_variance, congestion_window, bytes_in_flight, packets_in_flight}`
  → `cwnd: 13500, srtt: 25.1, in flight: 1252, ...`
- quic-go `{pto_count: 1}` (an update with only the PTO count) → `pto_count: 1`

uint64 values may be strings and are printed verbatim. The RTT halving uses `toNum()`.

#### 9.3.3 `quic:packet_lost` (Core; quic-events-13 §7.4)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `recovery:packet_lost` | `quic:packet_lost` | Renamed. | — |
| `data.header.packet_type` | same; `header` is now **optional** ("should include at least the packet_type and packet_number") | Same values. | Label without the type prefix: `packet lost #N` (PARITY). |
| `data.header.packet_number` | same | May be a string; printed verbatim. | `header` or PN absent: label `packet_lost` (PARITY). This includes mvfst's aggregate shape `{largest_lost_packet_num, lost_bytes, lost_packets}`. |
| (none) | `data.frames`, `data.trigger` (`reordering_threshold`, `time_threshold`, `pto_expired`), `data.is_mtu_probe_packet` | New. | Not shown (X7). |

`packetLostLabel(e)` is the §3.12.3 row: `(packet_type !== undefined ? packetTypeToString(packet_type) + " " : "")
+ "packet lost #" + packet_number`, for example `1RTT packet lost #42`. `quic:packet_lost` is still **not** used for
the arrow loss markers (PARITY; see X7 for why).

#### 9.3.4 `quic:congestion_state_updated` (Base; quic-events-13 §7.3)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `recovery:congestion_state_updated` | `quic:congestion_state_updated` | Renamed. | — |
| `data.new` | `data.new: text` (REQUIRED, free text) | The values are deliberately producer-defined. quic-go: `slow_start`, `congestion_avoidance`, `recovery`, `application_limited` → `Congestion state: slow start`, `Congestion state: congestion avoidance`, … (`replace("_", " ")` touches the **first** underscore only, SQ23). | Label = type name `congestion_state_updated` (PARITY). mvfst reuses this name for several data shapes; those without `new` fall into this case. |
| (none) | `data.old`, `data.trigger` | New. | Ignored. |

Color: default `#FF0000`/`#FFFFFF` (not in the chain, PARITY).

#### 9.3.5 `quic:timer_updated` (Extra; quic-events-13 §5.21)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `recovery:loss_timer_updated` (draft-02, string literal in qvis) | `quic:timer_updated` | Renamed in quic-events-12 (#496). The loader also maps draft-01 `loss_timer_set` (`event_type = "set"`) and `loss_timer_triggered` / `loss_timer_expired` (`event_type = "expired"`), quic-go's `recovery:loss_timer_updated` and mvfst's `quic:loss_timer_updated`. | — |
| `data.event_type` | same: `"set"`, `"expired"`, `"cancelled"` (REQUIRED) | Same values. | **LD4:** label = `timer_updated` (the type name). qvis printed `timer undefined`. This happens with mvfst's non-standard data `{largest_sent, alarm_count, outstanding_packets, type}`. |
| `data.delta` (fallback `data.timeout`) | `data.delta` (float32 ms from this event's time; meaningful for `set`) | The loader shim maps a legacy `timeout` to `delta`; the view reads `delta` (and may keep the `timeout` fallback, it is cheap). | `set` without a finite `parseFloat(delta)`: **LD4:** omit the ` @ …` part. qvis printed ` @ NaN`. |
| `data.packet_number_space` | same: `initial`, `handshake`, `application_data` | Now also appears on non-recovery timers. `application_data` still prints `appdata `. | `pn` = `""` (PARITY). |
| `data.timer_type` | `$TimerType`: `ack`, `pto`, `loss_timeout`, `path_validation`, `handshake_timeout`, `idle_timeout`, or custom (quic-go `path_probe`) | Upper-cased verbatim: `ACK`, `PTO`, `LOSS_TIMEOUT`, `IDLE_TIMEOUT`, `PATH_PROBE`, … | The `" "` placeholder (PARITY spacing). |
| (none) | `data.timer_id` | New: disambiguates several timers of one type. | Ignored (PARITY). |
| the event's `relativeTime` | `QlogEvent.relativeTime` (`data-model.md` §3.16.3) | The `@` value stays in **trace-relative ms**: no time multiplier, no latency offset, and for case R it counts from the epoch, not from the first event. So it is not in the same time base as the timestamp column. PARITY. | — |

```ts
function timerLabel(e: QlogEvent): string {
  const d = e.data;
  if (d.event_type === undefined) return e.type;                                   // LD4
  const pns = d.packet_number_space;
  const pn  = pns === undefined ? "" : (pns === "application_data" ? "appdata " : pns + " ");
  const tt  = d.timer_type !== undefined ? String(d.timer_type).toUpperCase() + " " : " ";
  const delta = parseFloat(d.delta !== undefined ? d.delta : d.timeout);
  const at  = d.event_type === "set" && Number.isFinite(delta)                      // LD4
            ? " @ " + (e.relativeTime + delta).toFixed(4) : "";
  return pn + " " + tt + "timer " + d.event_type + at;
}
// {packet_number_space:"application_data", timer_type:"pto", event_type:"set", delta:31.5} at relativeTime 92.0291
//   -> "appdata  PTO timer set @ 123.5291"     (HTML collapses the double space)
// {timer_type:"idle_timeout", event_type:"cancelled"} -> "  IDLE_TIMEOUT timer cancelled"
```

Color: purple `#5f0984`/white for every timer type (PARITY: qvis colored every `loss_timer_updated` purple).

#### 9.3.6 The parameter events

| Old (qvis) | Latest name | Label | When absent / notes |
|---|---|---|---|
| `transport:parameters_set` | `quic:parameters_set` (Core) | `N + " transport parameters set"` | `N` counts **every** key of `raw.data` (LD7): `initiator` (was `owner`), each parameter, `preferred_address` and `unknown_parameters` once each, extension keys. A producer may log several events per initiator (the draft's model is cumulative); each gets its own chip. |
| `recovery:parameters_set` | `quic:recovery_parameters_set` (Base) | `N + " recovery parameters set"` | `timer_granularity` is REQUIRED now; `reordering_threshold` may be `"disabled"` (editor's copy, quic-go). Both just count as keys. |
| `http:parameters_set` | `http3:parameters_set` (Base) | `N + " HTTP/3 parameters set"` | `initiator` counts. -13's prose erratum (`"received"`) does not matter here. The editor's-copy `unknown_settings` array counts once. |
| `parameters_set` in any other category | `<other ns>:parameters_set` | `N + " UNKNOWN parameters set"` and the `console.error` | Only custom namespaces can reach this now. |
| `transport:parameters_restored` (draft-02 spec; default chip in qvis) | `quic:parameters_restored` (Base) | default: `parameters_restored`, red | PARITY (qvis already rendered it generically). X3 (EXT-OFF) proposes a purple `N transport parameters restored`. |
| (none) | `http3:parameters_restored` (Base) | default: `parameters_restored`, red | PARITY. Same X3 proposal (`N HTTP/3 parameters restored`). |

All `parameters_set` events are purple. **LD7:** count `Object.keys(e.raw.data)` (or `e.data` when `raw.data` is not
a plain object), never the normalized copy. A loader fix-up that adds `initiator` next to a legacy `owner` would
otherwise change the number. qvis counted the producer's keys.

#### 9.3.7 `quic:connection_state_updated` (Base; quic-events-13 §4.6)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `connectivity:connection_state_updated` | `quic:connection_state_updated` | Renamed. | — |
| `data.new` | `data.new: $ConnectionState` (REQUIRED) | New value set. Base: `attempted`, `handshake_started`, `handshake_complete`, `closed`. Granular: `peer_validated`, `early_write`, `handshake_confirmed`, `closing`, `draining`. Custom strings are allowed and shown verbatim (the draft asks tools to). The draft-01 values `handshake`, `active`, `reset`, `keepalive` no longer occur. | Label `Connection state: undefined` (PARITY; the field is required). |
| (none) | `data.old` | — | Ignored. |

Label: `"Connection state: " + new`. Color: `closed` and `draining` dark red `#a80f3a`; **X2 (EXT-ON): `closing`
dark red too** (the new "CONNECTION_CLOSE sent" state belongs to the same close family; draft-02 had no such state);
every other state bright red `#FF0000`/white (SQ22, PARITY).

#### 9.3.8 `quic:spin_bit_updated` (Base; quic-events-13 §4.5)

`connectivity:spin_bit_updated` → `quic:spin_bit_updated`; `data.state: bool` (REQUIRED). Label `"Spin " + (state ?
"ON" : "OFF")`, yellow. Missing `state` prints `Spin OFF` (PARITY). The draft says the event is emitted only when the
bit **changes**; this does not affect the view.

#### 9.3.9 Name-only events with their own color

| Old (qvis) | Latest | Label | Color | Notes |
|---|---|---|---|---|
| `connectivity:connection_id_updated` | `quic:connection_id_updated` (Base) | `connection_id_updated` | teal `#068484`/white | Fields (`initiator`, `old`, `new`; quiche still writes `owner`) are not read. |
| `transport:datagrams_sent` | `quic:udp_datagrams_sent` (Extra) | **`udp_datagrams_sent`** | white/black | Renamed. The chip text is the latest type name, so it differs from qvis's `datagrams_sent` (§9.10). `count`, `raw[]`, `ecn[]`, `datagram_ids[]` are not read. Aliased from quiche's `quic:datagrams_sent`. |
| `transport:datagrams_received` | `quic:udp_datagrams_received` (Extra) | **`udp_datagrams_received`** | white/black | Same; also aliased from mvfst's singular `quic:datagram_received`. |

#### 9.3.10 `http3:frame_created` / `http3:frame_parsed` (Core; h3-events-13 §3.5-3.6)

| Old (qvis) | Latest path | Semantic difference | When absent |
|---|---|---|---|
| name `http:frame_created` / `http:frame_parsed` | `http3:frame_created` / `http3:frame_parsed` | Category `http` became namespace `http3` (h3-events-08/09). The loader maps legacy `http:frame_*` to `http3:`; real `http:` events are now Capsule Protocol events (§9.8). | — |
| `data.stream_id` | same; uint64 (REQUIRED) | May be a string; printed verbatim. For control-stream frames (SETTINGS, GOAWAY, MAX_PUSH_ID, CANCEL_PUSH, PRIORITY_UPDATE, ORIGIN) it is the control stream's ID, as before. | No ` (stream N)` part (PARITY). |
| `data.frame.frame_type` | same; `$HTTP3Frame` is an open socket | New types `priority_update`, `origin`, `reserved`, `unknown`; `duplicate_push` is gone. All of them get the generic `"<type>  created (stream N)"` form. | `""` → label `" created (stream N)"` (PARITY). |
| `data.frame.headers[].name` / `.value` (`:method`, `:path`, `:authority`, `:status`, plus colon-less legacy names) | `data.frame.headers: [* HTTP3HTTPField]` on `headers` and `push_promise` frames; `HTTP3HTTPField = {name?, name_bytes?, value?, value_bytes?}` | All four members are optional; a field MUST have `name` or `name_bytes`. Characters that are unsafe as text are logged hex-encoded in `*_bytes`. **LD5:** read through the shared h3 helpers `fieldName(h) = h.name ?? hexToLatin1(h.name_bytes)` and `fieldValue(h) = h.value ?? hexToLatin1(h.value_bytes)` (`h3-events.md` §8.1). For plain-text headers the result is identical to qvis. Keep the colon-less aliases (cheap). | A missing value leaves that part out (falsy check, PARITY). |
| event-level `byte_length`, `raw` (hex) | `data.frame.raw` (RawInfo) | Moved into the frame. | Not read by this view. |

`h3FrameLabel(e)` is §3.12.3, verbatim, with `fieldName` / `fieldValue`. Examples:

- HEADERS `[:method GET, :path /index.html, :authority example.org]` on stream 0, created →
  `GET /index.html  (stream 0) example.org`
- HEADERS response `[:status 200]` → `200  (stream 0) `
- SETTINGS on stream 3, parsed → `settings  parsed (stream 3)`
- PRIORITY_UPDATE on control stream 2, created → `priority_update  created (stream 2)`

The browser collapses the repeated spaces; keep the strings verbatim (SQ23).

#### 9.3.11 `loglevel:*` and `simulation:*` (main-schema-14 §9)

| Old (qvis) | Latest | Fields | Label | Color |
|---|---|---|---|---|
| `error:connection_error`, `error:application_error`, `error:internal_error` (`{code?, description?}`) | `loglevel:error` (Core) | `code?` (uint64), `message?` | `message` set: `"error: " + message`; else `error` | `#FF0000`/black |
| `warning:internal_warning` (`{code?, description?}`) | `loglevel:warning` (Base) | `code?`, `message?` | `"warning: " + message` / `warning` | orange `#FFA500`/black |
| `info:message`, `debug:message`, `verbose:message` (`{message}`) | `loglevel:info`, `loglevel:debug`, `loglevel:verbose` (Extra) | `message` (REQUIRED) | `"info: " + message`, `"debug: …"`, `"verbose: …"` | lightgrey `#D3D3D3`/black |
| `simulation:marker` (`{marker_type, message?}`) | `simulation:marker` (Extra) | `type?` (was `marker_type`), `message?` | `"simulation: " + message` / `marker` | orange |
| `simulation:scenario` | `simulation:scenario` (Extra) | `name?`, `details?` | `scenario` (no `message` field; PARITY default) | orange |

Semantic notes:

- The prefix is `levelOf(e)`: the level for `loglevel:*` (the same text as the old category prefix) and `simulation`
  for `simulation:*`.
- Old error and warning events carried `description`, which qvis ignored (it showed the type name, for example
  `internal_error`). The latest `message` is shown. `code` and the marker `type` are not shown (PARITY: qvis did not
  show `code` or `marker_type` either).
- Loader aliases that land here: `generic:*` (quiche ≤ 0.26, tquic), quic-go's `transport:debug`, a bare `debug`.
- A custom namespace with a message-like type and a `message` (for example `mvfst:message`) prints
  `"mvfst: " + message` with the default color, exactly what qvis did with its category.

#### 9.3.12 Every other event

Label = `e.type` (the text after the first colon), colors `#FF0000`/`#FFFFFF`, square, timestamp and popup (PARITY).
This covers, in the latest drafts:

- QUIC: `server_listening`, `connection_started`, `connection_closed`, `tuple_assigned`, `mtu_updated`,
  `version_information`, `alpn_information`, `parameters_restored`, `packet_dropped`, `packet_buffered`,
  `packets_acked`, `udp_datagram_dropped`, `stream_state_updated`, `frames_created`, `frames_parsed`,
  `frames_processed`, `stream_data_moved`, `datagram_data_moved`, `connection_data_blocked_updated`,
  `stream_data_blocked_updated`, `datagram_data_blocked_updated`, `migration_state_updated`, `key_updated`,
  `key_discarded`, `marked_for_retransmit`, `ecn_state_updated`.
- HTTP/3 and HTTP: `http3:parameters_restored`, `http3:stream_type_set`, `http3:priority_updated`,
  `http3:datagram_created`, `http3:datagram_parsed`, `http3:push_resolved`, `http:capsule_created`,
  `http:capsule_parsed`.
- Custom names kept by the loader: mvfst `quic:packet_ack`, `quic:connection_migrated`, `quic:path_validated`,
  `quic:stream_priority_updated`, `mvfst:*`; quic-go `quic:spurious_loss`, `quic:priority_updated`; legacy `qpack:*`.

Several of these were renamed since draft-02, so their chip text changes (§9.10).

### 9.4 QUIC frames inside packet events (quic-events-13 §8.13)

Exact output strings are in §3.12.2 (with SQ13). This table adds the latest field paths, what happens when a field is
absent, and the new frame types. `frameTypeToColor` keeps the qvis table of §3.13.1, plus X1.

| `frame_type` | Fields read (latest) | Change vs draft-02 | When absent | Color |
|---|---|---|---|---|
| `ack` | `acked_ranges: [+ ([from, to] / [n])]` | Ranges may be unordered (keep the given order) and `[n]` or `[n, n]`; tools MUST accept both. **LD2:** collapse a two-element range when `toNum(from) === toNum(to)` (qvis compared with `!==`, so `[5, "5"]` printed `5-5`). `ack_delay` (now decoded ms), `ect0`, `ect1`, `ce`, `raw` are not read. | No `acked_ranges`: `ack ` (PARITY). | green |
| `stream` | `stream_id` (REQUIRED), `fin` (`.default false`) | Length moved to `raw.length` (quic-go still writes top-level `length`); `offset` defaults to 0. Neither is read. | No `fin`: no ` FIN`. Missing `stream_id`: `stream undefined` (PARITY; required field). | blue |
| `crypto` | — | `offset` + `raw.length` (raw is REQUIRED); not read. | — | blue |
| `connection_close` | `error`, `error_code`, `reason` | **LD3** (the §3.12.2 port rule). Old `error_code` (enum string) is now `error`; old `raw_error_code` is now `error_code` (uint64, present when `error === "unknown"`). `error` may be a `$TransportError`, a `crypto_error_0x1NN` string, an `$ApplicationError` (HTTP/3: `http_*`, `qpack_*`), or `"unknown"`. `error_space` (`transport` / `application`; was `transport_error` / `application_error`), `trigger_frame_type` and `reason_bytes` are not read (see X13). Old `application_close` frames become `connection_close` with `error_space: "application"` (loader shim). | `connection_close ` + `""` when neither `error` nor `error_code` exists; no ` : reason` without `reason`. | dark red |
| `reset_stream`, `stop_sending` | `stream_id`, `error`, `error_code` | **LD3:** show `error` unless it is `"unknown"` and `error_code` is defined, then show `error_code`. quic-go writes only a numeric `error_code`; the loader adds `error: "unknown"`, so the label reads `reset stream 4 (268)`, the same as qvis showed for quic-go's draft-02 files. `final_size` is not read. | §3.12.2 (with SQ13's `!== undefined` checks). | dark red |
| `reset_stream_at` (**new**, RFC reliable stream reset) | `stream_id`, `error`, `error_code`, `reliable_size` | **X1 (EXT-ON).** qvis showed the bare type name in red. | See below. | **dark red `#a80f3a`** (X1) |
| `max_data`, `max_stream_data`, `max_streams`, `data_blocked`, `stream_data_blocked`, `streams_blocked` | `maximum` / `limit`, `stream_id`, `stream_type` (`bidirectional` / `unidirectional`) | Unchanged names and values. | §3.12.2 fallbacks to the bare type (SQ13 `!== undefined` checks). | purple |
| `new_connection_id`, `retire_connection_id` | — | `length` → `connection_id_length`, `reset_token` → `stateless_reset_token`; not read. | — | teal |
| `ping`, `path_challenge`, `path_response` | — | — | — | yellow |
| `padding` | — | One frame per packet; byte count in `raw.payload_length`. Not read. | — | pink |
| `new_token`, `handshake_done`, `datagram`, `unknown` (was `unknown_frame_type`, renamed by the loader), extension frames (quic-go `ack_frequency`, `immediate_ack`) | — | Label = `frame_type`. | — | red `#FF0000` (PARITY: qvis rendered these, or their draft-02 spellings, with the default color) |
| any frame | `frame.qvis.sequence.hide` | Not qlog (§9.6). | — | — |

X1 label:

```ts
case "reset_stream_at":                       // only with LATEST_EXTENSIONS; otherwise the default case
  if (f.stream_id === undefined) return "reset_stream_at";
  {
    const err = errText(f);                   // the reset_stream / stop_sending rule (LD3)
    return "reset stream " + f.stream_id
         + (err !== undefined ? " (" + err + ")" : "")
         + (f.reliable_size !== undefined ? " at " + f.reliable_size : "");
  }
// {stream_id: 4, error: "http_request_cancelled", final_size: 5000, reliable_size: 1000}
//   -> "reset stream 4 (http_request_cancelled) at 1000"
// errText(f) = (f.error !== undefined && !(f.error === "unknown" && f.error_code !== undefined)) ? f.error
//            : (f.error_code !== undefined ? f.error_code : undefined)
```

LD3 examples for `connection_close`:

| Frame (latest) | Label |
|---|---|
| `{error_space: "transport", error: "no_error"}` | `connection_close : clean` |
| `{error_space: "application", error: "http_no_error"}` | `connection_close : clean` |
| `{error_space: "application", error: "unknown", error_code: 0}` | `connection_close : clean` |
| `{error_space: "transport", error: "crypto_error_0x128", reason: "handshake failure"}` | `connection_close crypto_error_0x128 : handshake failure` |
| `{error_space: "application", error: "unknown", error_code: 268}` | `connection_close 268` |
| `{error_space: "transport", error: "protocol_violation"}` | `connection_close protocol_violation` |

The frame aggregation of §3.11 (groups by `frame_type`, `>= 8` frames, groups `> 5`) is unchanged.

### 9.5 Trace-level fields and the time model

| Old (qvis) | Latest (main-schema-14) | Semantic difference | When absent |
|---|---|---|---|
| `vantage_point` (required in draft-02) | `Trace.vantage_point` / `TraceSeq.vantage_point` (**optional**; `type` required inside) | — | Data-model default `{type: "unknown", flow: "unknown", name: "No VantagePoint set"}` → mirror guess and alert C8 (PARITY). |
| `vantage_point.type` | `"client"`, `"server"`, `"network"`, `"unknown"` | Values unchanged. Non-standard strings occur in the wild (quic-go endpoint traces write `"transport"`); the data model keeps them for display and treats them as unknown for perspective. | **LD6:** alert C8 fires when `type` is not one of `client`, `server`, `network` (qvis: `=== "unknown"`), so a raw `"transport"` trace that gets guessed also gets the warning. Header label 2 shows the raw string. |
| `vantage_point.flow` | `"client"`, `"server"`, `"unknown"`; meaningful for `network` only | Unchanged. | Network trace without `flow`: perspective unknown (guess). **LD6:** header label 2 prints `network : from unknown's viewpoint` (qvis printed `undefined`). |
| `vantage_point.name` | optional text | Overwritten on mirrored or guessed traces (§6.3 strings). | Stays absent until the guess writes it. |
| `title`, `description` | optional on `Trace` / `TraceSeq` | The data model defaults them to `""`. | `"Simulated, autogenerated trace : "` + `""`. |
| `common_fields.reference_time` (number or string), `common_fields.time_format` (`absolute` / `relative` / `delta`), `configuration.time_units`, `configuration.time_offset` | `reference_time: {clock_type, epoch, wall_clock_time?}` and `time_format: relative_to_epoch / relative_to_previous_event`, per event or in `common_fields`; no units (always ms); no offset | Resolved by the loader into cases A / R / U (§3.5.1, `data-model.md` §3.16.3). | Absent `reference_time`: CDDL defaults (system clock, Unix epoch) = case A. |
| group `filename`, `URL`, `URLshort` | not qlog (file-loading) | — | — |

Which case real producers hit (`ecosystem.md` §2):

| Producer | `reference_time` | Case |
|---|---|---|
| quic-go ≥ 0.56, quiche ≥ 0.27, neqo/Firefox | `{clock_type: "monotonic", epoch: "unknown", wall_clock_time}`; times from the trace start | U |
| mvfst | monotonic, `epoch: "unknown"`; times since boot (about 1e8 ms) | U (normalized to the first event) |
| quinn | none at all; times from the stream start | A (small values) |
| a file with a dated `epoch` | RFC 3339 date | R |

Time alignment under the latest drafts (§3.5.2, unchanged algorithm, latest names):

1. `parser.timeOffset` is always 0, so early-out 3 never fires.
2. The "dragons" repair fires for case U (`method === RELATIVE_TIME && absoluteStartTime === 0`). Two U traces: the
   client gets `refOverride = serverStart − 5 = −5`, so client timestamps start at `0.00` and the server's at `5.00`
   before the computed offset. U + A (for example a quinn client and a quiche server): the client is not RELATIVE,
   so the server gets `refOverride = clientStart + 5`. The override is local to this view (SQ19).
3. The RTT estimate reads `quic:recovery_metrics_updated.latest_rtt` / `smoothed_rtt` in ms (§9.3.2); the Initial
   correlation reads `quic:packet_sent` / `quic:packet_received` (§9.3.1); the result is written to the "Latency
   offset" as before (SQ4, SQ5).
4. `wall_clock_time` is **not** used for alignment: main-schema-14 §7.1 says conversions based on it "cannot be
   safely relied on", and qvis had no equivalent. `group_id` is not used either.
5. Keep qvis's expression `absoluteTime * res − start * res + offset * res` (§3.6). For case A with Unix-ms times and
   a multiplier of 1000 the products are about 1.7e15 (an ulp of 0.25). Do not "improve" it: `Math.floor` bucket
   boundaries could move in rare cases.

### 9.6 Implementation-specific and legacy fields

| Field (qvis) | Latest / port | Treatment |
|---|---|---|
| `frame.qvis.sequence.hide` (packetization filler frames) | Not qlog. The packetization port no longer injects frames (`data-model.md` §3.16.9), and a latest-draft file cannot contain qvis's injected frames (qvis exported only legacy files). | Keep the check (a no-op in practice). |
| `rawEvent.timeText` | `QlogEvent.ext.sequence.timeText` (`data-model.md` §3.16.9) or the layout's `timeText[][]` (§8.2) | Never written to `raw` (SQ14). |
| `rawEvent.qvis.sequencediagram.{y, rightTarget, leftTarget, packetLost, focusInfo}` | `QlogEvent.ext.sequence.*` or the §8.2 side tables | Reset at the start of each render (`data-model.md` §3.16.9, last bullet). |
| `connection.qvis.sequencediagram.{generatedSibling, manualTimeOffset}` | `QlogConnection.ext.sequence.*` or the §8.2 `WeakMap`s | Add the `userSet` flag (SQ5). |
| `connection.wasAutoGenerated` | `QlogConnection.wasAutoGenerated` | Unchanged. |
| mirror renames through the parser's `name` setter (`raw.name.replace(type, newType)`) | `connection.clone(transform)` (`data-model.md` §3.16.10): raw objects are **shared and untouched**; the clone's `QlogEvent.type` / `fullName` carry `packet_received` / `packet_sent` / `ignoreseq` | Supersedes the deep copy. Consequence: the popup for a mirror event shows the raw event with its **original** name, where qvis showed the swapped name (§2.8). With SQ3, a click on a mirror event shows its original counterpart anyway, so this is only visible when no counterpart exists. |
| `packet_type` `"onertt"` / `"zerortt"` | never in latest files (`1RTT` / `0RTT`) | Keep the two aliases in `packetTypeToString` (harmless). |
| metrics `cwnd`, timer `timeout`, frame `raw_error_code`, `application_close`, `unknown_frame_type`, `error_code` as a string | loader shims (`ecosystem.md` §6.5, `quic-events.md` §15.3) produce `congestion_window`, `delta`, `error` / `error_code`, `connection_close`, `unknown` | The view reads only the latest fields, plus the cheap `cwnd` and `timeout` fallbacks. |
| colon-less header names (`method`, `path`, `authority`, `status`) | never in latest files (HTTP/3 pseudo-headers start with `:`) | Keep the aliases (harmless). |
| `configuration.time_offset`, `time_units`; `event_fields` | removed (main-schema-06; draft-02) | Not supported: the offset is always 0, times are always ms, events are always objects. `clone()` does not copy them. |

### 9.7 Inputs with no latest-draft equivalent

| qvis input | Status in the latest drafts | Port behavior |
|---|---|---|
| `configuration.time_offset` (file-provided offset) | removed | Always 0. The "Latency offset" is UI state only; early-out 3 of §3.5.2 is dead. |
| `configuration.time_units: "us"` | removed: all times and durations are ms | `timeToMilliseconds = parseFloat`. The "Time multiplier" (a UI zoom) is unaffected. |
| category-based disambiguation (`transport` / `recovery` / `http` `parameters_set`; `error` / `warning` / … categories) | categories removed (main-schema-10, #439) | Distinct type names, `levelOf()`, and the type-only `parameters_set` rule (§9.1-9.2). Nothing is lost. |
| generic types `connection_error`, `application_error`, `internal_error`, `internal_warning`, `message` | replaced by the five `loglevel` types; connection-level errors are also `quic:connection_closed` | `loglevel:*` mapping (§9.3.11). The old type names stay in `MESSAGE_TYPES` for custom namespaces. |
| `metrics_updated.cwnd` | `congestion_window` | SQ18. |
| `metrics_updated.max_ack_delay`, `in_recovery` | removed (`quic:parameters_set.max_ack_delay`, `quic:congestion_state_updated`) | Not read by this view; nothing to replace. |
| `loss_timer_updated.timeout` | `timer_updated.delta` | §9.3.5. |
| frames `application_close`, `unknown_frame_type` | `connection_close` + `error_space: "application"`; `unknown` | Chip text changes (§9.10); colors unchanged. |
| connection states `handshake`, `active`, `reset`, `keepalive` (draft-01) | renamed (`handshake_started`, `handshake_complete`) or removed | Never mapped; any string is shown verbatim. |
| `qpack:*` events | removed in h3-events-06 (#335) | If present (legacy producers), default chips (custom namespace). |
| `http:dependency_update`, `http:data_received` | removed (nearest: `http3:priority_updated`, `quic:stream_data_moved`) | Not read by this view. |
| `http:data_moved` / `transport:data_moved` | `quic:stream_data_moved` | Default chip, text `stream_data_moved`. |
| `header.packet_size`, `is_coalesced` | `raw.length`; `datagram_id` / checksum | Not read by this view. |
| `IHTTPHeader {name, value}` (both required) | `HTTP3HTTPField` (all optional, `*_bytes`) | LD5. |

### 9.8 New in the latest drafts

| New item | Default | Rationale and exact behavior |
|---|---|---|
| `reset_stream_at` frame | **X1 EXT-ON** | Dark red, label `reset stream <id> (<error>) at <reliable_size>` (§9.4). It is a RESET_STREAM variant, and qvis groups stream and connection aborts in dark red. |
| connection state `closing` | **X2 EXT-ON** | Dark red with `closed` / `draining` (§9.3.7). The other new states (`handshake_started`, `handshake_complete`, `peer_validated`, `early_write`, `handshake_confirmed`) stay bright red (SQ22). |
| `quic:parameters_restored`, `http3:parameters_restored` | PARITY (default chip); X3 EXT-OFF | Draft-02 already had `transport:parameters_restored` and qvis rendered it generically. X3 would print `N transport parameters restored` / `N HTTP/3 parameters restored` in purple. |
| `quic:recovery_metrics_updated` fields (`pto_count`, `packets_in_flight`, `pacing_rate`, `rtt_variance`, `min_rtt`, extensions) | PARITY | Shown through the `, ...` suffix or the all-keys fallback, and in the popup fold (§9.3.2). |
| `quic:timer_updated` timer types and `timer_id` | PARITY | Types upper-cased verbatim; `timer_id` ignored (§9.3.5). |
| DATAGRAM: the `datagram` frame, `quic:udp_datagram_dropped`, `quic:datagram_data_moved`, `http3:datagram_created` / `datagram_parsed`, the `datagram_data_blocked_updated` event | PARITY | Frame chip `datagram` in red; events are default chips. qvis already showed DATAGRAM frames from draft-02-era producers this way. |
| `handshake_done`, `new_token` frames; `unknown` frame with `frame_type_bytes` | PARITY | Red chips with the type name. |
| `quic:frames_created` / `frames_parsed` / `frames_processed` (`frames[]` + `packet_numbers[]`) | PARITY (default chips); X4 EXT-OFF | X4: when a packet event has no `frames`, attach the frames of the same trace's `frames_created` (sender) or `frames_parsed` / `frames_processed` (receiver) whose `packet_numbers[i]` equals the packet's PN. Not in v1: the draft logs no PN space for these events ("infer it from context, normally application_data"), so Initial and Handshake packets can be mis-attached, and `frames_processed` was removed in the editor's copy. |
| `quic:packets_acked` (`packet_number_space?` default `application_data`, `packet_numbers[]`) | PARITY (default chip); X5 EXT-OFF | X5: green chip `packets acked 1-5,7` (ranges collapsed like the ACK label, prefixed by the space when it is not `application_data`). Not in v1: qvis had no such event, and the ACK frames on the arrows already show the same information when packets are logged with frames. |
| `tuple` (event field), `quic:tuple_assigned` (was `path` / `path_assigned`), `quic:migration_state_updated` | PARITY (ignored / default chips); X6 EXT-OFF | Matching ignores tuples. That stays correct across migration, because packet numbers belong to the connection's PN spaces, not to a path. X6: show the tuple ID on arrow labels when more than one tuple occurs in a trace. |
| `packet_lost.trigger`, `packet_lost.is_mtu_probe_packet`, `packet_sent.trigger`, `packet_sent.is_mtu_probe_packet` | PARITY (not shown); X7 EXT-OFF | X7: append ` (time_threshold)` etc. to the loss chip, and mark MTU probes. Not in v1: it changes label strings. Using `packet_lost` to draw loss on arrows is also out: it is the **sender's** loss declaration, which can be spurious (quic-go logs `recovery:spurious_loss`), while the arrow X means "the peer never logged it". |
| `datagram_payload_checksum` / `datagram_payload_checksums` (editor's copy; quic-go writes it) | PARITY (ignored); X8 EXT-OFF | X8: the checksum is the same in both traces, so Retry, Version Negotiation and Stateless Reset packets (no PN) could be matched by `(packet_type, checksum)` and get arrows instead of SQ31's square-only rendering. Collisions are possible but rare. |
| `quic:packet_dropped` on the peer | PARITY (default chip); X9 EXT-OFF | X9: end the arrow of a sent packet at the peer's matching `packet_dropped` (when its `header` has type and PN) instead of drawing it as lost. |
| `quic:connection_closed` (`initiator`, `connection_error` / `application_error`, `error_code`, `internal_code`, `reason`, `trigger`) | PARITY (default chip); X10 EXT-OFF | Draft-02 had `connection_closed` and qvis rendered it generically. X10: `connection_closed <error> : <reason>` in dark red, with the LD3 clean rule. |
| `group_id` = ODCID (quic-events-13 §1.1, RECOMMENDED) | PARITY; X11 EXT-OFF | X11 implements qvis's own TODO (`SequenceDiagramConfigurator.vue:216-217`): on the default selection, pair a single-trace file with a trace of the opposite perspective in another loaded file that has the same effective `group_id` (or `common_fields.odcid`). quic-go writes the ODCID as `group_id` in every per-perspective file. |
| per-view capability check (main-schema digest P15) | PARITY (console errors only); X12 EXT-OFF | X12: a non-blocking info alert in the configurator when the selected traces have no `quic:packet_sent` / `quic:packet_received`. |
| `reason_bytes` on CONNECTION_CLOSE | PARITY (ignored); X13 EXT-OFF | X13: when `reason` is absent, decode `reason_bytes` as UTF-8 for the ` : reason` part. |
| `quic:version_information`, `quic:alpn_information` (Core) | PARITY (default chips); X14 EXT-OFF | X14: `version <chosen_version>` / `ALPN <chosen_alpn.string_value>` labels. |
| `http:capsule_created` / `capsule_parsed` (new `http` namespace) | PARITY (default chips) | Do not confuse this namespace with old qvis's `http` (HTTP/3) category. |
| HTTP/3 frame types `priority_update`, `origin` | PARITY | Generic HTTP/3 label (§9.3.10). |
| `http3:priority_updated`, `http3:stream_type_set`, `http3:push_resolved` | PARITY (default chips) | — |
| `system_info`, `event_schemas`, `wall_clock_time` | not used | Not part of this view (§9.5 for `wall_clock_time`). |

### 9.9 What real producers send to this view (`ecosystem.md` §3, §5)

- **quinn:** vantage point `unknown` on every trace, so the mirror guess and alert C8 are the normal path; several
  connections in one file through per-event `group_id` (the selection heuristics see several `unknown` traces in one
  group: case B or C of §3.15 keeps just the picked one, and it gets mirrored); no `reference_time` (case A).
- **quic-go:** `transport:` / `recovery:` / `security:` names (aliased); `transport:debug` becomes `loglevel:debug`
  (grey `debug: <message>`); `quic:datagram_dropped` becomes `quic:udp_datagram_dropped`; reset frames with a numeric
  `error_code` only (LD3); `recovery:metrics_updated` with only `pto_count`; `tuple` inside `data` (ignored);
  endpoint traces with `vantage_point.type: "transport"` (LD6); one file per perspective, each with
  `common_fields.group_id` = ODCID (X11); `datagram_payload_checksum` (X8).
- **quiche / neqo:** `quic:datagrams_sent` / `quic:datagrams_received` (aliased; white chips `udp_datagrams_*`);
  `quic:key_retired` (aliased; chip `key_discarded`); `connection_id_updated` with `owner` (teal chip, unaffected);
  `quic:frames_processed` and, for neqo, `quic:packets_acked` (default chips); neqo logs no HTTP/3 events.
- **mvfst:** aggregate `quic:packet_lost` without `header` (chip `packet_lost`); `quic:loss_timer_updated` with
  non-standard data (chip `timer_updated`, LD4); `quic:packet_ack` and `mvfst:*` (default chips); `stream_id` as JSON
  strings (printed verbatim, matched by string); times since boot (case U normalizes them).
- **A trace with only HTTP/3 events, or with no packet events at all** (h3-events-13 §1.1 allows HTTP/3 events
  without QUIC events): no arrows, the mirror column is all `ignoreseq`, the guess falls back to `server`, and the
  `calculateConnections` console errors fire (PARITY).

quic-go ≥ 0.56 files are the only latest-envelope files that original qvis can also open (they still carry
`qlog_version: "0.3"`). They are a usable baseline for side-by-side checks, with the differences of §9.10 (notably
`transport:debug`, `datagram_dropped` and the CONNECTION_CLOSE labels, which qvis misreads under -13 field names).

### 9.10 Expected visible differences from qvis

Use this list when comparing against qvis screenshots taken with the demo files converted to the latest drafts:

1. Default chips show the **latest type name**: `udp_datagrams_sent` / `udp_datagrams_received` (qvis:
   `datagrams_sent` / `datagrams_received`), `udp_datagram_dropped` (`datagram_dropped`), `key_discarded`
   (`key_retired`), `stream_data_moved` (`data_moved`), `tuple_assigned` (`path_assigned`).
2. Converted `application_close` frames read `connection_close …` (still dark red); `unknown_frame_type` reads
   `unknown`.
3. Draft-01 `loss_timer_set` / `loss_timer_triggered` render as purple timer labels (qvis: red type-name chips).
4. Generic events: `loglevel:error` with a `message` reads `error: <message>`. The old `error:internal_error` with a
   `description` read `internal_error`.
5. LD3: CONNECTION_CLOSE, RESET_STREAM and STOP_SENDING labels for latest-draft field names (qvis misreads them).
6. LD4, LD6, X1 and X2 as described above; SQ13, SQ18 and the other §7 FIXes.
7. The popup JSON is the raw event as logged: no `timeText` (SQ14), and mirror events keep their original `name`
   (§9.6).

### 9.11 Tests for the mapping (add to §8.6)

Fixtures are synthetic latest-draft files (`ecosystem.md` §7 has producer-shaped ones). Assert:

- `labels` / `colors`, one case per row of §9.3 and §9.4, including:
  - every LD4 timer case (`event_type` missing; `set` without `delta`; custom `timer_type: "path_probe"`);
  - every LD3 CONNECTION_CLOSE example of §9.4; quic-go's numeric-only `reset_stream`;
  - X1 (`reset_stream_at` with and without `error` / `reliable_size`) and X2 (`closing`), with
    `LATEST_EXTENSIONS` on and off;
  - LD2 (`acked_ranges: [[5, "5"], ["7"]]` → `ack 5,7`);
  - LD5 (`{name_bytes: "3a6d6574686f64", value: "GET"}` acts as `:method`);
  - LD7 (`parameters_set` key count equals the logged key count after the loader's `owner` shim);
  - `levelOf` for every `loglevel` type, `simulation:marker` with and without `message`, and `mvfst:message`;
  - an `X:parameters_set` with a custom namespace (UNKNOWN label plus `console.error`).
- `matching`: string versus number packet numbers match; PN-less Retry / VN / SR stay square-only; a quinn-style
  `unknown` single trace gets mirrored with the guess; `packet_received` with `trigger: "keys_available"` ends the
  arrow.
- `timeAlignment`: two case-U traces (−5 ms seed, then the offset); a U server with an A client (`+5` on the server);
  RTT taken from `quic:recovery_metrics_updated.latest_rtt` without unit scaling.
- `mirror`: the clone's events have `fullName` `quic:packet_received` / `quic:packet_sent` / `quic:ignoreseq` while
  `raw.name` is unchanged.

### 9.12 Summary: canonical events and fields consumed

| Canonical name | Fields read |
|---|---|
| every event | `time` (via `absoluteTime` / `relativeTime`), `fullName`, `namespace`, `type`, index, `raw` (popup) |
| `quic:packet_sent`, `quic:packet_received` | `header.packet_type`, `header.packet_number`, `frames[]` (`frame_type`; `acked_ranges`; `stream_id`, `fin`; `error`, `error_code`, `reason`; `maximum`, `limit`, `stream_type`; `reliable_size`) |
| `quic:recovery_metrics_updated` | `latest_rtt`, `smoothed_rtt`, `congestion_window` (or `cwnd`), `bytes_in_flight`, `ssthresh`, every key |
| `quic:packet_lost` | `header.packet_type`, `header.packet_number` |
| `quic:congestion_state_updated` | `new` |
| `quic:timer_updated` | `event_type`, `delta` (or `timeout`), `packet_number_space`, `timer_type` |
| `quic:parameters_set`, `quic:recovery_parameters_set`, `http3:parameters_set` (and any `*:parameters_set`) | key count of `raw.data` |
| `quic:connection_state_updated` | `new` |
| `quic:spin_bit_updated` | `state` |
| `quic:connection_id_updated`, `quic:udp_datagrams_sent`, `quic:udp_datagrams_received` | name only |
| `http3:frame_created`, `http3:frame_parsed` | `stream_id`, `frame.frame_type`, `frame.headers[]` (`name` / `name_bytes`, `value` / `value_bytes`) |
| `loglevel:error`, `loglevel:warning`, `loglevel:info`, `loglevel:debug`, `loglevel:verbose`, `simulation:marker`, `simulation:scenario` | `message` |
| trace | `vantage_point.{type, flow, name}`, `title`, `description`, effective `reference_time` / `time_format` (through the data model's timing) |

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`). Where this addendum contradicts the body, **this addendum wins**.
It aligns §9 with `docs/dev/ARCHITECTURE.md` §0/§3.1 (binding) and `data-model.md` §9.1 rule 2 and §9.10.

### S1. No alias pass, no data fix-ups (G1)

- §9.1 rule 1 is replaced by: "**Latest names, exactly as logged.** The view matches -13 names. Nothing rewrites
  pre-final names (`transport:*`, `recovery:*`, `security:*`, `http:*` other than `capsule_*`, quiche
  `quic:datagrams_*`, `quic:key_retired`, mvfst `quic:loss_timer_updated`, `generic:*`). Such events are
  non-conforming (toast DM3) and are rendered by the generic rules (S2)."
- §9.1 rule 3: `e.data === e.raw.data` always. Read `e.data`; the popup shows `e.raw`. "A shallow copy only when the
  loader applied a fix-up" is void.
- §9.3.10 row 1: "The loader maps legacy `http:frame_*` to `http3:`" is void. `http:frame_created` is a non-conforming
  default chip (`frame_created`, red/white).
- §9.3.11 "Loader aliases that land here: `generic:*` …, quic-go's `transport:debug`, a bare `debug`" is void. They
  are not aliased:
  - `transport:debug {message}` and `generic:debug {message}` match MESSAGE_TYPES by type, so the label is
    `levelOf(e) + ": " + message` = `"transport: <message>"` / `"generic: <message>"`, with colours `#FF0000`/`#FFFFFF`
    (levelOf is the namespace, which matches no colour rule).
  - A bare `debug` (no colon) is namespace `unknown`, type `debug`: `"unknown: <message>"`, red/white.
- §9.3.12 "Custom names kept by the loader" means "names as logged".
- §9.4:
  - `reset_stream`/`stop_sending`: the loader does **not** add `error: "unknown"`. A frame with only a numeric
    `error_code` (quic-go style) and no `error` still prints `reset stream 4 (268)` through `errText()`'s
    `error_code` branch, so the output is the same.
  - `unknown_frame_type` is **not** renamed: label `unknown_frame_type`, default red.
  - Draft-02 `application_close` is **not** converted: label `application_close`, still dark red, because the
    legacy entry stays in the `frameTypeToColor` table (§3.13.1).
- §9.9: replace "(aliased)" in the quic-go and quiche bullets with "non-conforming: default chips, no arrows, DM3"
  (S2). §9.10 items 1-3 apply to conforming files only.

### S2. Rendering of non-conforming traces (G2), normative

Reference input: current quic-go output (`tests/fixtures/quic-go/*.sqlog`: `file_schema` header, `transport:*`,
`recovery:*`, `security:*` names). Expected behaviour, which follows from the generic rules and is PARITY with how
qvis rendered unknown events:

1. Every event gets a square and a timestamp, and a chip with label = the type after the first colon
   (`packet_sent`, `packet_received`, `metrics_updated`, `loss_timer_updated`, `key_updated`, ...), colours
   `#FF0000`/`#FFFFFF`. Popups work as usual (raw event).
2. No arrows. `conn.lookup(conn.transportNamespace, "packet_sent")` is empty. The auto-generated mirror trace
   consists only of `ignoreseq` events. The vantage-point guess falls back as in §9.9 ("no packet events at all").
   `calculateConnections` logs its "did not have packet_sent/packet_received events" diagnostic (as `console.warn`,
   S6).
3. RTT-based time alignment finds no `quic:packet_*` or `quic:recovery_metrics_updated`, so offsets fall back as for
   traces without packets (§3.5).
4. `?focusOnPN=` finds nothing and logs "packet number couldn't be found in the trace..."; `focusOnEvent` works.
5. The N18 large-trace warning counts all events, including non-conforming ones.
6. The DM3 toast text stays verbatim (ARCHITECTURE §3.1). "Ignored by the visualizations" means "not interpreted":
   the events are still drawn as generic chips here and listed by Stats. Changing the wording is an ARCHITECTURE
   decision.

Test: load `tests/fixtures/quic-go/h3-1x1M-noloss-client.sqlog`. Expect no arrows, chips labelled `packet_sent`,
no exception, and no `console.error`.

### S3. Converter TCP traces and HTTP/2 frames (G3): amends §9.2 and its reference code

data-model §9.10 (D9) and converters C4 are normative. In qvis the tshark converter wrote TCP packets under category
`transport` (`pcapconverter/qlog_tcp_tls_h2.ts:3-7`), so the sequence diagram drew arrows for TCP traces. The ported
converter writes `tcp:packet_sent` / `tcp:packet_received`. To keep parity:

- Every `"quic:packet_sent"` / `"quic:packet_received"` in §9.2 (matching, mirror, guess, RTT correlation,
  `focusOnPN`, click swap, "no side label") becomes `conn.transportNamespace + ":packet_sent"` /
  `":packet_received"`, and `conn.lookup("quic", …)` becomes `conn.lookup(conn.transportNamespace, …)`.
  `transportNamespace` is `"tcp"` for converter TCP traces and `"quic"` otherwise (data-model §9.10).
- In `eventTypeToColor` and `eventToShortString`, add `case "http2:frame_created": case "http2:frame_parsed":` next to
  the `http3:` cases: blue `#0468cc`/white, label `h3FrameLabel(e)`. qvis matched `frame_created`/`frame_parsed` by
  type only. `h3FrameLabel` reads only `data.stream_id`, `data.frame.frame_type` and `frame.headers`, which the
  converter writes for HTTP/2 too.
- `tls:record_created` / `tls:record_parsed` stay default chips (`record_created`), as in qvis.
- The packet chip on TCP arrows shows `packetTypeToString("1RTT")` and the converter's `packet_number` (the capture
  frame number), as in qvis.
- Test: convert `public/standalone_data/tcp/wikipedia_Playstation.json` (converters §3.13). The sequence diagram must
  show arrows between the trace and its generated mirror, and blue HTTP/2 frame chips.

### S4. Legacy member aliases (G11): amends §3.12.3 (SQ18), §9.3.10, §9.6 "legacy aliases" row

Under the strict policy (ARCHITECTURE §0 "never on schema names"; data-model §9.6, where legacy members are "not
read"), drop the "cheap aliases":

- `cwnd`: read only `congestion_window`, still labelled `cwnd: `
- `timeout`: read only `delta`
- `packet_type` `"onertt"` / `"zerortt"`
- colon-less header names (`method`, `path`, `authority`, `status`)
- `raw_error_code`

Files that use these members already raise `event.legacy-field` (DM2) or DM3. Rationale: one rule for all views
(congestion F1, packetization and multiplexing addenda). Keep the label texts themselves (`cwnd: `, `srtt: `, ...)
verbatim.

### S5. Dead renderers (G12)

Do not port `SequenceDiagramSimpleRenderer.vue` or `SequenceDiagramCanvasRenderer.ts` (dead in qvis:
`SequenceDiagramContainer.vue:5` and `SequenceDiagramRenderer.vue:56` comment them out). The
"`(+ Canvas/Simple)`" note in ARCHITECTURE §2 is informational only.

### S6. Console levels (G13, policy in app-shell addendum A5)

In §6.4, the following can fire on valid latest-draft input and use `console.warn` with the same text:

- `setup` "None of the selected traces have events in them"
- every `calculateTimeOffsets` message, including both "HERE BE DRAGONS"
- every `calculateConnections` message: a missing `header` or `packet_number` is legal for some packet types, and
  HTTP/3-only traces are legal (h3-events-13 §1.1)
- every `renderPartialExtents` focus message
- the configurator case-D messages

`console.error` remains only for caught exceptions (`render()` resolving `false`, which also shows N19).

### S7. Stack line (G8)

The §8 intro's "react-router 8" is obsolete. Routing uses the custom hash router (ARCHITECTURE §0,
`src/app/router.ts`). `useRoute().query` provides `focusOnConnection`, `focusOnEvent` and `focusOnPN`, read once
when the renderer is created (§3.9). `forceFull` stays a substring test on `location.hash`.

### S8. Deep-link landing after a URL load (same-data check against hosted qvis, 2026-11-01)

Measured in Chrome with the same file in hosted qvis (draft-02 conversion) and the port, both loaded through
`#/sequence?file=…&focusOnConnection=…&focusOnEvent=…` (or `focusOnPN`):

- qvis's first render happens synchronously inside the watcher flush that follows the file's arrival
  (configurator `updated()` → `selectDefault()` → renderer watcher → `render()` → `window.scrollTo(0, y − 50)`). At that
  moment the configurator's "Loading files..." `b-alert` is still in the DOM: bootstrap-vue removes it after its leave
  transition, one frame later. qvis therefore scrolls in a document that is 66 px taller above the diagram (alert 50 px
  + 16 px margin).
- When the alert goes, Chrome's scroll anchoring keeps the visible content in place: if the viewport top was below the
  alert (`y − 50 ≥` the alert's top + its height; the alert's top is where the diagram box starts once it is gone),
  the scroll position moves up by 66 px, so the event appears 66 px lower than `svgDocumentTop + 50`. If the viewport
  top was inside or above the alert, the anchor is the alert or something above it and nothing moves.
- With SN1 (first trace > 10000 events), qvis awaits 200 ms before rendering; the alert is gone by then and the landing
  is plain `y − 50`.

Examples (new_cid client file, 1600 × 1000): event 40 at y 914 → qvis scrollY 864 (not 864 + 66); event 12 (y 420) →
304; event 11 (y 300) → 250; massive_client event 2000 (SN1) → y − 50.

**Decision (PRESERVE the visual result):** the port measures the "no file" alert (NoTraceAlerts) while it is shown and
passes it to the first render after the files arrived; `focus()` applies the anchoring rule above
(`SequenceDiagramRenderer.tsx`, `SequenceDiagramD3Renderer.focus`). The mount path (files already loaded, SQ11 FIX)
has no alert and keeps `y − 50`. Tests: `SequenceDiagramContainer.test.tsx` "deep link landing (addendum S8)",
`SequenceDiagramD3Renderer.test.ts` "focus …", e2e `sequence.spec.ts` focus and modal tests (`deepLinkScrollY`).

### S9. Same-data parity check results (2026-11-01)

All five demo connections were compared element by element (every drawn SVG element's geometry, text, colours and
chip styles, with `forceFull` and at six scroll positions without it), plus the configurator boxes, the modal, the
tooltips, tab switching, window resize, narrow windows, a GENERATED mirror on either side, unknown / network / missing
vantage points and two uploaded single-trace files. Apart from S8 (fixed) the only differences are intended:

| Difference | Reason |
|---|---|
| Metric chips show `cwnd: …` (qvis: `in flight: …` or `congestion_window: …`) | SQ18 |
| `max data N (stream 0)`, `stream 0 blocked at N` (qvis: `max_stream_data`, `stream_data_blocked`) | SQ13 |
| Chips `key_discarded`, `stream_data_moved`; popup `"name"` values are the latest names | latest drafts (§9.10) |
| Automatic latency offset has the opposite sign (`-0.0639…` vs `0.0639…`), so server timestamps differ by ~0.1 ms | SQ4 |
| A client + server file opens as the pair (qvis: client + GENERATED server); deep links with `focusOnConnection=1`, or to an event whose y differs between the two layouts, land elsewhere | SQ1 |
| After a pick in the left selector, the left selector shows the trace actually drawn there (qvis keeps showing the picked option, e.g. "server" above the client column) | app-shell §8.5 (controlled selectors) |
| Lost-packet half arrows at the start of a range rendered while scrolling are slanted like the previous arrow (qvis: horizontal) | SQ12 |
| "Add trace" on a two-column diagram adds a selector but no duplicate column | SQ6 |
| A click on the GENERATED trace shows the original event (qvis: the renamed clone) | SQ3 |
| Popup JSON without `timeText` | SQ14 |
| Deep link points at this app (encoded parameters) | app-shell Q18 |
| Diagnostics are `console.warn` (qvis `console.error`); the forceFull warning logs the range count, not the array | S6 |

The two differences this check left to the shell were fixed at the final integration: the Bootstrap 4.3.1 focus ring
after a click on "Add trace" (global `.btn:focus`, app-shell A7) and the "Time multiplier:" / "Latency offset :"
tooltips (0.6 px lower, Bootstrap 5 font stack, no 50 ms delay; now the shared `useHoverTooltip`, app-shell A9).

