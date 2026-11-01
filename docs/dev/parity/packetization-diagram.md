# Parity spec: Packetization Diagram (`#/packetization`)

This document replaces reading the qvis source for the packetization diagram. Source paths are relative to
`qvis/visualizations/` (reference checkout: quiclog/qvis `3db6acf`). Abbreviations used for citations:

| Abbrev. | File |
|---|---|
| `VIEW` | `src/views/PacketizationDiagram.vue` (17 lines) |
| `CONT` | `src/components/packetizationdiagram/PacketizationDiagramContainer.vue` (32) |
| `CFG` | `src/components/packetizationdiagram/PacketizationDiagramConfigurator.vue` (189) |
| `RND` | `src/components/packetizationdiagram/PacketizationDiagramRenderer.vue` (108) |
| `CONF` | `src/components/packetizationdiagram/data/PacketizationDiagramConfig.ts` (7) |
| `D3R` | `src/components/packetizationdiagram/renderer/PacketizationDiagramD3Renderer.ts` (360) |
| `MOD` | `src/components/packetizationdiagram/renderer/PacketizationDiagramModels.ts` (202) |
| `QPP` | `src/components/packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts` (699) |
| `TPP` | `src/components/packetizationdiagram/renderer/PacketizationTCPPreProcessor.ts` (430) |
| `DH` | `src/components/packetizationdiagram/renderer/PacketizationDiagramDataHelper.ts` (9) |
| `COLOR` | `src/components/shared/helpers/ColorHelper.ts` (92) |
| `CC` | `src/components/shared/ConnectionConfigurator.vue` (233) |
| `TCPQ` | `src/components/filemanager/pcapconverter/qlog_tcp_tls_h2.ts` (193), the qvis-custom TCP/TLS/H2 schema |
| `T2Q` | `src/components/filemanager/pcapconverter/tcptoqlog.ts` (699), the tshark-JSON converter that feeds TCP mode |

All of these were read in full, plus the relevant parts of `src/data/Connection.ts`, `src/data/QlogLoader.ts`
(event parsers), `src/data/QlogLoaderV2.ts`, `src/data/QlogSchema02.ts`, `src/router.ts`, `src/App.vue`,
`src/views/MainMenu.vue`, `src/store/ConfigurationStore.ts`, `src/store/ConnectionStore.ts`.

Locked qvis dependency versions relevant here (`package-lock.json`): d3 5.12.0 (d3-selection 1.4.0, d3-zoom 1.8.3,
d3-axis 1.0.12, d3-scale 2.2.2, d3-transition 1.2.0), bootstrap 4.3.1, bootstrap-vue 2.0.4, vue 2.6.10.

Companion documents this spec relies on (do not duplicate their content, follow them):

- `docs/dev/ARCHITECTURE.md`: binding module layout, D3 v5 to v7 rules, store conventions.
- `docs/dev/parity/app-shell.md`: `ConnectionConfigurator` (§2.5), `NoTraceAlerts` (§2.5.7), notifications (§3.6,
  §8.4), `ColorHelper` (§3.7), quirks Q11/Q12 (stale or empty selections).
- `docs/dev/qlog-spec/quic-events.md` §11 and `docs/dev/qlog-spec/h3-events.md` §8.1 and §10.6.5: latest-draft size
  fields and accessor helpers (`streamFrameDataLength`, `h3FramePayloadLength`, `h3FrameTypeNumber`, `vlieLength`).
- `docs/dev/qlog-spec/ecosystem.md` §6.5 and §6.6: which fields real producers actually emit.

Labels used throughout (same as the other parity specs):

- **PARITY**: reproduce exactly (visible text, geometry, behaviour).
- **FIX**: a qvis bug or hazard; the React version deliberately deviates. The qvis behaviour is still described.
- **NEW**: required because qvis-react only accepts the latest qlog drafts (main-schema-14, quic-events-13,
  h3-events-13).
- **DECISION**: needs a product decision; a recommended default is given.

---

## 1. Overview and user-facing purpose

The packetization diagram shows, for **one** selected trace (connection), how bytes are packed into the protocol
layers on the wire. The x-axis is **cumulative bytes** (not time). The bytes of every packet in one direction are laid
end to end, and each protocol layer is drawn as a horizontal lane of rectangles over the same byte axis, so you can see
which upper-layer unit sits inside which lower-layer unit.

Two diagrams are always rendered, one above the other, for the same trace:

- **Top:** the bytes the trace's endpoint **received** (`packet_received` + `frame_parsed`).
- **Bottom:** the bytes the trace's endpoint **sent** (`packet_sent` + `frame_created`).

The two x-axes are independent (each starts at 0 and covers its own direction's bytes). There is no direction toggle.

Each diagram has four lanes (bottom to top):

| Lane (bottom to top) | QUIC + HTTP/3 mode | TCP + TLS + HTTP/2 mode |
|---|---|---|
| 0 | **QUIC packets**: per packet a header, payload and 16-byte AEAD trailer | **TCP**: per segment a header and payload |
| 1 | **QUIC frames**: frames inside each packet payload (header + payload per frame) | **TLS**: records (header, payload, trailer) inside the TCP payload byte stream |
| 2 | **HTTP/3**: H3 frames (header + payload) inside the STREAM-frame payload bytes of their stream | **HTTP/2**: H2 frames (header + payload) inside TLS application-data payload bytes |
| 3 | **Stream IDs** (60% height): the byte ranges of lane 2, colored by stream ID | **Stream IDs** (60% height), same for H2 |

Layer boundaries are shown by alternating two colors per lane (black/grey, red/pink, blue/lightblue), headers and
trailers are drawn shorter than payloads, and a bright yellow "filler" rectangle marks bytes the tool could not
attribute to a frame (wrongly guessed frame sizes). There is **no UDP datagram lane**: coalesced QUIC packets are drawn
as consecutive, independent packets (see §3.6.10).

What the user can do:

- pick the trace via the shared trace selector;
- hover any rectangle for a tooltip with in-context details (indices, sizes, packet number, frame type, stream ID,
  FIN bit, request method and path, total resource size);
- zoom with the mouse wheel and drag to pan, each diagram independently, horizontally only;
- read summary labels: direction ("Bytes sent"/"Bytes received"), who sent what (flow label), "efficiency" and the
  local/remote max packet sizes (QUIC mode only);
- open a "More info on this tool" modal with usage notes.

The original was built for TCP+TLS+HTTP/2 traces converted from tshark JSON and later extended to QUIC+HTTP/3. In
qvis-react, QUIC mode consumes **latest-draft** `quic:*`/`http3:*` events. TCP mode consumes the private
`tcp:`/`tls:`/`http2:` namespaces emitted by the ported tshark converter (ARCHITECTURE §0).

---

## 2. UI inventory

### 2.1 Route and page composition

- Route: `#/packetization`, route name `packetization` (`src/router.ts:68-75`), default view `VIEW`, menu `MainMenu`.
  The menu tab label is **"Packetization"**. Its active color `#f8d7da` is owned by app-shell §2.4.
- There are no route-specific query parameters (§5).
- DOM tree (ids and classes **PARITY**, e2e tests use them):

```
<div>                                                    VIEW:2  (route wrapper, no class)
  <div class="home">                                     CONT:2
    <div style="background-color:#f8d7da; padding:0px 10px;">          CFG:2   configurator panel
      <div class="container-fluid"> ... </div>                          CFG:4   (b-container fluid)
    </div>
    <div>                                                RND:2
      <div id="packetization-diagram-top"    style="width:100%; min-height:200px;"> <svg/> </div>   RND:6
      <div id="packetization-diagram-bottom" style="width:100%; min-height:200px;"> <svg/> </div>   RND:12
      <div id="packetization-packet-tooltip"></div>                                                RND:18
    </div>
  </div>
</div>
```

The tool's config lives in the global configuration store (`ConfigurationStore.packetizationDiagramConfig`,
`src/store/ConfigurationStore.ts:15`) and survives route changes. `CONT:29-30` simply passes it down.

```ts
// CONF:3-7
class PacketizationDiagramConfig {
    collapsed: boolean = true;                 // UNUSED (its checkbox is commented out, CFG:12-23)
    connections: Array<Connection> = [];       // only connections[0] is ever used
}
```

### 2.2 Configurator panel (`CFG:1-98`)

Outer `div` with inline style `background-color: #f8d7da; padding: 0px 10px;`, containing a
`b-container fluid` (`.container-fluid`, 15px horizontal padding in Bootstrap 4). Scoped CSS (`CFG:100-108`):

```css
.row { padding-bottom: 10px; }   /* applies to the three b-rows of this component only */
.btn { margin: 0px 5px; }        /* applies to this component's buttons ("More info..." and the modal "Close") */
```

Children, top to bottom:

1. **Intro row** (`CFG:5-7`): `b-row align-h="center"` (`.row.justify-content-center`) containing
   `<p style="margin-top: 10px;">` with the verbatim text
   **"Select a trace via the dropdown(s) below to visualize it in the packetization diagram"**.
   The paragraph keeps Bootstrap's default `margin-bottom: 1rem`.
2. **Selector row** (`CFG:8-10`): `b-row align-h="center"` containing
   `<ConnectionConfigurator v-if="config.connections.length > 0" :allGroups="store.groups"
   :connection="config.connections[0]" :canBeRemoved="false" :onConnectionSelected="onConnectionSelected" />`.
   The component is the shared selector (app-shell §2.5): a white panel with a 1px black border, at most 50% wide,
   centered. With 30 or fewer options it shows the combined single `<select>` with a
   `"{filename} ({description})"` header line. With more than 30 options it shows two selects (file, then trace). No
   "Latency offset" input, no remove button. When `connections` is empty the row is empty, but still has 10px
   bottom padding.
3. **Commented-out row** (`CFG:12-23`): a "Show collapsed" checkbox bound to `config.collapsed` and a
   "Load all connections at once" button (gated on `allowSelectAll`, `":8080"` in the URL). Both are inside an HTML
   comment and are **not rendered**. Do not port them, nor `allowSelectAll` / `selectAllConnections` /
   `window.holblockinfo` (`CFG:141-158`), which are dead code here.
4. **Info button row** (`CFG:25-31`): `b-row align-h="center"` > `b-col cols="8" class="text-center"` >
   `div.text-center` > `b-button class="m-auto" style="width: 25%;" block` with the text **"More info on this tool"**.
   - Default variant `secondary` (Bootstrap 4: `#6c757d` background, white text).
   - `block` gives `display:block`. The inline `width:25%` overrides `.btn-block`'s 100%, so the button is 25% of the
     `col-8` and centered by `m-auto` (`margin:auto !important` beats the scoped `.btn` margin).
   - Click calls `toggleInfo()` (§2.3).
5. **No-trace alerts** (`CFG:33-34`), inside the container, not in a row. These are the shared `NoTraceAlerts`
   (app-shell §2.5.7):
   - `outstandingRequestCount === 0 && groups.length === 0`: `b-alert variant="danger"` with
     **"Please load a trace file to visualize it"**
   - else, if `groups.length === 0`: `b-alert variant="warning"` with **"Loading files..."**
6. **Info modal** (`CFG:36-93`), see §2.3.

**Auto-selection** (`CFG:160-175`), **PARITY** with the shared rule (app-shell §2.5.7): in `mounted()` **and**
`updated()`, if `config.connections.length === 0 && store.groups.length > 0`, then
`config.connections = [ store.groups[0].getConnections()[0] ]` (logs
`"PacketizationDiagramConfigurator:selectDefault: adding new default connection configurator"`). Loading more files
never changes an existing selection. App-shell Q11/Q12 fixes apply: scrub on group removal, skip empty groups.

**Selection change** (`CFG:135-139`): `onConnectionSelected(connection)` sets `config.connections = [ connection ]`
(new array, which triggers the renderer, §3.1).

### 2.3 Info modal (`CFG:36-93`)

`b-modal id="info-modal" size="xl" hide-footer title="PacketizationDiagram info"`:

- Bootstrap 4 `.modal-xl` is max-width 1140px at ≥1200px viewport width.
- Header shows the title **"PacketizationDiagram info"** and the default × close button. There is no footer.
- Closes with ×, ESC, a backdrop click, or the "Close" button.

`toggleInfo()` (`CFG:177-186`) keeps a private `infoShown` flag: if false it calls `$bvModal.show("info-modal")`,
otherwise `$bvModal.hide(...)`, then flips the flag. **Quirk Q-M1:** closing the modal through ×, ESC or the backdrop
does not reset the flag, so the next "More info on this tool" click only flips it back and the modal does not open;
a second click opens it. **FIX:** the button always opens and "Close" always closes (controlled `show` state).

Verbatim body markup (`CFG:37-92`, **PARITY**, including the original wording, typos and grammar):

```html
<h2>How to test?</h2>
    Load the predefined DEMO files (using the "manage files" tab above) and then select the "<b>DEMO_10_parallel_streams</b>" file here (the other demo files are a bit flaky on this visualization because they're older and don't always contain all the necessary fields)<br />

    You can also upload your own qlog files, but note that this has been tested mainly on client-side traces. Server-side logs should work, but there might be dragons. Let us know if you find any bugs.

<h2>What does it do?</h2>
<p>
    The packetization diagram shows how QUIC and HTTP/3 frames are packed inside each other and inside QUIC packets. 
    This helps to see how (especially STREAM and DATA) frames are sized, how packet sizes are modulated, if HTTP/3 frame boundaries don't directly correspond to QUIC boundaries, etc.
    <ul>
        <li>
            The bottom row (black and grey) shows the QUIC packets. Each packet has a header (the lower area) and a payload (the higher area). <br />
            The first packet is black, the second grey, etc. to clearly show when a new packet starts. This use of alternating colors to show clear delineations is consistent for the rest of the diagram as well.
        </li>
        
        <li>The second row (red and pink) shows the QUIC frames inside the packet payloads. Each frame has a frame header and a payload.</li>

        <li>The third row (blue and light blue) show the HTTP/3 frames inside QUIC STREAM frame's payloads. Each HTTP/3 frame has a frame header and a payload.</li>

        <li>The fourth row (several colors) show to which stream each HTTP/3 frame belongs (if any). This to make it easier to track how streams are multiplexed on the wire.</li>
    </ul>

    <b>IMPORTANT: the x-axis does NOT show time but bytes sent/received</b>. 
    This also means that the two individual x-axis (for the top and bottom diagrams) do not (directly) overlap in time, even though it might appear like that at first glance!
    To get a better idea of timing, use the sequence diagram<br /><br />

    You can hover over each element and get a popup with more in-context information on what's present at that location. <br />
    You can also zoom with the scrollwheel and drag to pan the diagram.<br /><br />

    Keep an eye on the browser devtools' JavaScript console: if you see weird behaviour, you'll probably see an error message explaining things there as well.
</p>
<h2>How does it work?</h2>
<p>
    The visualization currently looks mainly at the following qlog events and attributes to figure out packet and frame sizes:
    <ul>
        <li>packet_sent/packet_received : raw : length</li>
        <li>packet_sent/packet_received : frames[ StreamFrame ] : length</li>
        <li>frame_parsed/frame_created : byte_length</li>
    </ul>

    However, these events are not enough to fully know the sizes of all QUIC frames: we only have explicit (payload) lengths for the stream frames. 
    Because of QUIC's use of variable-length integer encoding for frame headers, it's difficult to know the frame's header and payload sizes (especially for things like ACK frames).<br/>
    qlog draft-02 should include fields to allow explicit logging of these lengths. For pre-02, this tool tries to <b>guesstimate</b> the sizes (and probably gets it wrong).
    If we fail to correctly guess, we backfill with bright yellow rendered "filler" frames. <br/><br/>

    Note that this means that while the sizes of most QUIC frames (except STREAM frames) are off, the visualization is still accurate in showing which frames were in which packet.
</p>
<h2>Also usable for TCP + TLS + HTTP/2</h2>
<p>
    This visualization was first created for use with TCP + TLS + HTTP/2, as there the implementations are typically less well aggregated. This often leads to inefficiencies in how data is packed inside the different layers.
    If you want to use this tool with those protocols as well, create a decrypted trace (so HTTP/2 is decoded) using wireshark (or equivalent) and then output it as JSON (either from wireshark directly or using tshark).
    You can then upload that as a .json file using the qvis file manager. It has a built-in pcap-to-qlog convertor (or at least the basic of one for this purpose).
    See the qvis repository for a demo TCP file. 
</p>

<b-button class="mt-3 d-block" @click="toggleInfo">Close</b-button>
```

**Effective DOM (pixel-close detail).** Vue 2's template parser mimics the browser: a `<ul>` start tag closes an open
`<p>`, and the later stray `</p>` creates an **empty `<p></p>`**. The real DOM is therefore:
`<h2>`, text, `<h2>`, `<p>`(intro text)`</p>`, `<ul>…</ul>`, bare text + `<b>` + `<br>`s, `<p></p>`, `<h2>`,
`<p>`(intro)`</p>`, `<ul>…</ul>`, bare text…, `<p></p>`, `<h2>`, `<p>…</p>`, button. In JSX write exactly that
structure (JSX would otherwise nest `<ul>` in `<p>` and change the margins). Whitespace is collapsed as in normal HTML.

The "Close" button: `class="mt-3 d-block"`, variant secondary, plus the scoped `.btn { margin: 0 5px }`, so the
left/right margin is 5px and the top margin is 1rem (`mt-3` is `!important`).

**DECISION D-PZ1 (help text field names).** The "How does it work?" bullets name draft-02 fields that no longer exist
in the latest drafts. Recommended: keep everything else verbatim and update only these lines (h3 digest §10.6.5 makes
the same recommendation):

```html
<li>quic:packet_sent/quic:packet_received : raw : length (and raw : payload_length)</li>
<li>quic:packet_sent/quic:packet_received : frames[ StreamFrame ] : raw : length (or raw : payload_length)</li>
<li>http3:frame_parsed/http3:frame_created : frame : raw : payload_length (or frame : raw : length)</li>
```

Optionally replace the sentence "qlog draft-02 should include fields … (and probably gets it wrong)." with "The
latest qlog drafts allow logging every frame's length in raw.length, but most implementations don't. When these
lengths are missing, this tool tries to <b>guesstimate</b> the sizes (and probably gets it wrong)."
The demo name "DEMO_10_parallel_streams" stays valid because the demo file names are kept verbatim (file-loading
§8.7).

### 2.4 Renderer area (`RND:1-20`)

- `#packetization-diagram-top`: `width:100%; min-height:200px`. Holds the **receiving** diagram.
- `#packetization-diagram-bottom`: same styles. Holds the **sending** diagram.
- `#packetization-packet-tooltip`: an initially empty div shared by both diagrams. Each renderer's `setup()` sets these
  inline styles on it (`D3R:94-99`): `opacity:0; position:absolute; padding:5px; pointer-events:none;
  background:lightsteelblue`. It has no z-index, border, border-radius, width or font settings, so it inherits
  `#app`'s `'Avenir', Helvetica, Arial, sans-serif`, `color:#2c3e50`, 16px, line-height 1.5. It is absolutely
  positioned against the initial containing block (no positioned ancestor) and shrink-to-fit wide, so it wraps when
  close to the right edge.
- Commented-out debug markup (`RND:3-4`, `7-9`, `13-15`) is not rendered.

### 2.5 SVG anatomy (one diagram), exact geometry

All numbers come from `D3R:58-102` and `D3R:106-359`. Let `cw` be the container's `clientWidth`, read **once** at
render time.

| Quantity | Value |
|---|---|
| `margin.top` | 30 |
| `margin.right` | `Math.round(cw * 0.05)` |
| `margin.bottom` | 40 (`axisLocation` is always `"bottom"`, so the `else` branch at `D3R:70-72` sets 40) |
| `margin.left` | 100 |
| inner `width` | `cw - 100 - Math.round(cw*0.05)` |
| inner `height` | `totalHeight` = **100** |
| `<svg>` | `width = cw`, `height = 170`, attributes `xmlns="http://www.w3.org/2000/svg"`, `xmlns:xlink="http://www.w3.org/1999/xlink"`, `font-family="Trebuchet-ms"` (sic; has no visible effect because every text overrides it) |
| main `<g>` | `transform="translate(100,30)"`. Everything below is in this g's coordinates. |
| lanes | 4, so `packetHeight = 100 / 4 = 25` |
| `packetSidePadding` | 0.3 (every rect is widened by 0.3px on each side to avoid hairline gaps) |

The container has `min-height: 200px`, so each diagram block is 200px tall (svg 170px plus 30px empty space below).

**Lane vertical layout** (lanes array index 0 = bottom, `yOffsetMultiplier = lanes.length - index - 1`,
`laneTop = 25 * yOffsetMultiplier`; `D3R:191-228`):

| Lane | laneTop | payload rect (`isPayload: true`) y / height | header/trailer rect (`isPayload: false`) y / height | label y |
|---|---|---|---|---|
| 3 "Stream IDs" (heightModifier 0.6) | 0 | 0 / **15** | (never used: all ranges are payload) 10 / 9 | 14.2857 |
| 2 "HTTP/3" / "HTTP/2" | 25 | 25 / 25 | 35 / 15 | 39.2857 |
| 1 "QUIC frames" / "TLS" | 50 | 50 / 25 | 60 / 15 | 64.2857 |
| 0 "QUIC packets" / "TCP" | 75 | 75 / 25 | 85 / 15 | 89.2857 |

Formulas (`D3R:205-211`):

```ts
y      = packetHeight * yOffsetMultiplier + packetHeight * (d.isPayload ? 0 : 0.40)
height = heightModifier * (packetHeight * (d.isPayload ? 1 : 0.60))
x      = xDomain(d.start) - 0.3
width  = xDomain(d.start + d.size) - xDomain(d.start) + 0.6
```

Headers and trailers are 60% of the lane height and **bottom-aligned**. Payloads fill the lane. The Stream IDs lane
bars are 15px tall and **top-aligned** (y 0..15), which leaves a 10px gap above the HTTP lane.

Every rect: `fill = d.color`, `style opacity: 1`, `class = lane.CSSClassName`, `style pointer-events: all`,
listeners `mouseover` and `mouseout` (§3.12). There is no stroke.

**Element order inside the main g** (z-order; `D3R:135-321`):

1. `<defs><clipPath id="clip"><rect width={width} height={100} x=0 y=0/></clipPath></defs>`. The code writes
   `append("SVG:clipPath")`. d3 drops the unknown `SVG:` prefix and inherits the SVG namespace, so the result is a
   normal `clipPath`.
2. `<g clip-path="url(#clip)">`: all lane rects, lane 0 first, then 1, 2, 3, each in range-array order. Later rects
   paint over earlier ones.
3. Axis `<g transform="translate(0,100)">` with `d3.axisBottom(xDomain)`. It is appended after the rect g, so the
   axis domain line (y=100.5) paints over the bottom edge of the packet lane.
4. One `<g><text/></g>` per lane label, lane 0 first: `x=-5`,
   `y = laneTop + packetHeight/1.75` (a code comment says "1.75 should be 2, but eyeballing says 1.75 is better"),
   `dominant-baseline="middle"`, `text-anchor: end`, `font-family: "Trebuchet MS"`, `fill="#000000"`, `font-size`
   (see font note). Texts: QUIC mode **"QUIC packets"**, **"QUIC frames"**, **"HTTP/3"**, **"Stream IDs"**. TCP mode
   **"TCP"**, **"TLS"**, **"HTTP/2"**, **"Stream IDs"**.
5. Direction legend `<g><text/></g>`: `x = xDomain(xMax/2)`, `y = 100 + 40 - 10 = 130`,
   `dominant-baseline="baseline"`, `text-anchor: middle`, text **"Bytes sent"** (sending diagram) or
   **"Bytes received"** (receiving diagram).
6. QUIC mode only (`if (lanes[0].max_size_local)`, which is always truthy in QUIC mode because the default is 65527):
   - `<text x = xDomain(xMax) - 450, y=130, text-anchor:start>`
     **`"max receiving size " + localname + ": " + max_size_local`**
   - `<text x = xDomain(xMax), y=130, text-anchor:end>` **`"max receiving size " + remotename + ": " + max_size_remote`**
   - `localname = vantagePoint.type === "server" ? "server" : "client"` (network or unknown also gives "client");
     `remotename` is the other one.
7. QUIC mode only, if `lanes[0].efficiency` is truthy (not 0 and not NaN): `<text x = xDomain(0) = 0, y=130,
   text-anchor:start>` **`"efficiency " + (efficiency * 100).toFixed(2) + "%"`**.
8. Flow label `<g><text/></g>`: `x = xDomain(xMax/2)`, `y = -10`, `dominant-baseline="baseline"`, `text-anchor: middle`
   (`D3R:292-321`). Text by vantage point type and direction (verbatim):

   | vantage_point.type | sending (bottom) | receiving (top) |
   |---|---|---|
   | `server` | "Data sent from server to client (trace vantagepoint = server)" | "Data received by server from client (trace vantagepoint = server)" |
   | `client` | "Data sent from client to server (trace vantagepoint = client)" | "Data received by client from server (trace vantagepoint = client)" |
   | anything else | `""` (an empty text element is still appended) | `""` |

   In TCP mode the same label logic runs; the tshark converter sets `vantage_point.type = "client"`.

All texts in 5-8 use `font-family: "Trebuchet MS"`, `fill="#000000"`, and the same font-size note.

**Font-size note (PARITY of the rendered result).** All qvis texts call `.style("font-size", "14")`, a unitless CSS
length. That is invalid in standards mode (qvis' `index.html` has `<!DOCTYPE html>`), so the declaration is dropped
and the texts inherit **16px** from Bootstrap's `body { font-size: 1rem }`. The React port should set
`font-size: 16px` explicitly so the visual result is identical and deterministic. Confirm in the parity harness
(screenshot vs hosted qvis). If hosted qvis turns out to render 14px, use 14px. "Trebuchet MS" has no fallback family,
so on systems without it the browser default font is used (PARITY).

**Axis** (`D3R:153-163`): `d3.axisBottom(xDomain)` with default ticks (about 10) and the default linear tick format
(thousands separators, e.g. `"200,000"`). d3-axis sets `fill="none" font-size="10" font-family="sans-serif"
text-anchor="middle"` on the axis g. Tick lines and labels use `currentColor`, which inherits `#app`'s `color:#2c3e50`.
The axis is not labelled except through the "Bytes …" legend below it. The `axisTop` branch (`D3R:155-158`,
`330-332`) is unreachable (`axisLocation` is never `"top"`). Keep it as an option or drop it.

**x scale** (`D3R:127-131`, `149-151`): `xDomain = d3.scaleLinear().domain([0, xMax]).range([0, width])`, where
`xMax = last(lanes[0].ranges).start + last(lanes[0].ranges).size`, or 0 if lane 0 is empty. QUIC lane 0's last range
is the trailer of the last packet. TCP lane 0's last range is the payload of the last segment. With
`domain [0,0]`, d3-scale returns the range midpoint for every input, so every x-positioned label collapses to
`width/2` (§6.3).

**Rough absolute layout** for a 1920px-wide window (`cw` ≈ 1920 minus any scrollbar): `margin.right` = 96,
`width` = 1724. Lanes span absolute y 30..130. The axis sits at absolute y 130 with tick labels around y 139-148. The
legend baseline is at absolute y 160 and the flow label baseline at absolute y 20. Lane labels end at absolute x 95.

### 2.6 Colors (all CSS named colors except stream colors)

| Element | Even index | Odd index | Index used |
|---|---|---|---|
| QUIC packet header/payload/trailer | `black` | `grey` (#808080) | `QUICPacketIndex` (global packet counter for the direction) |
| QUIC frame header/payload | `red` | `pink` (#FFC0CB) | `QUICFrameIndex` (global frame counter, not reset per packet) |
| qvis filler "frame" | `yellow` (#FFFF00) | | always yellow |
| HTTP/3 or HTTP/2 frame header/payload | `blue` | `lightblue` (#ADD8E6) | `HTTPindex` (global, in **processing** order, §3.6.7) |
| TCP segment | `black` | `grey` | `TCPindex` |
| TLS record header/payload/trailer | `red` | `pink` | `TLSindex` |
| Stream IDs lane | `ColorHelper.StreamIDToColor("" + parseInt(stream_id,10), "HTTP3" \| "HTTP2")[0]` | | app-shell §3.7: H3 table keyed 0,4,…,52 (cycle 56), H2 table keyed 0,1,3,…,27 (cycle 28), fallback `lavenderblush` |

Consequences: in HTTP/3 mode only client-initiated bidirectional streams (id % 4 == 0) get a real color.
Server-initiated and all unidirectional streams (control, QPACK encoder/decoder, push) are `lavenderblush`
(#FFF0F5, near white).

### 2.7 Interactions

| Interaction | Behaviour |
|---|---|
| Select a trace | Both diagrams re-render from scratch (§3.1). Zoom resets. |
| Hover a rect (`mouseover`) | The tooltip fades to opacity .95 over 100ms. Its HTML is set to `lane.rangeToString(d)` and it is positioned at `left = pageX + 15`, `top = pageY - 75` (px). It does **not** follow the mouse inside a rect (no mousemove handler). |
| Leave a rect (`mouseout`) | The tooltip fades to opacity 0 over 200ms. Both diagrams share the one tooltip element, so transitions interrupt each other. |
| Mouse wheel over a **painted** element of the diagram (rect, lane label, legend text, axis) | Zoom around the pointer, `scaleExtent [1, 2000]`. Only x is rescaled (axis + rect x/width). Labels do not move. The page does not scroll, except when the wheel would go past a scale limit: d3-zoom 1.8 returns early without `preventDefault`, so the page scrolls. |
| Wheel over empty areas inside the plot (gaps between bars, the 10px header gaps, blank margins) | Nothing (the page scrolls). Zoom is attached to the main `<g>`, which has no background rect, so only painted children receive events. |
| Drag (mouse down on a painted element and move) | Pan, constrained by `translateExtent [[0,0],[width,100]]`. At scale 1 nothing moves. Vertical panning changes nothing visible (y is not rescaled). |
| Double-click a painted element | d3-zoom default: zoom in ×2 around the pointer, animated (250ms). Shift+double-click zooms out. |
| Touch | d3-zoom defaults (pinch, drag). |
| Ctrl + wheel | Ignored by the d3-zoom 1.8 default filter (`!event.ctrlKey && !event.button`), so the browser page-zooms. See §8.4 for keeping this in d3 v7. |
| Window resize | Nothing. The width is measured only at render time. It is re-measured when the trace changes or the route is re-entered. |
| Brush | None. |
| Click a rect | Nothing. |

Top and bottom diagrams zoom **independently** (separate zoom behaviours, no synchronisation).

---

## 3. Algorithms and data flow

### 3.1 Lifecycle and render triggering (`RND:28-107`, `D3R:35-56`)

```text
RND.created():  rendererTop = new D3Renderer("packetization-diagram-top")
                rendererBottom = new D3Renderer("packetization-diagram-bottom")       // only store the id
RND.mounted():  if config.connections.length > 0:
                    rendererTop.render(connections[0], receiving)                    // no notifications on this path
                    rendererBottom.render(connections[0], sending)
@Watch('config', {immediate: true, deep: true}) onConfigChanged(newConfig):
    (the immediate call happens before created(), the renderers are undefined, so it is a no-op)
    if (!rendererTop.rendering):
        if newConfig.connections[0].getEvents().length > 10000:
            notify(warn N-PZ1) ; await sleep(200)                                    // "give time to show the warning"
        rendererTop.render(connections[0], receiving).then(ok => if !ok notify(error N-PZ2))
        rendererBottom.render(connections[0], sending).then(ok => if !ok notify(error N-PZ2))
```

`D3Renderer.render(connection, direction)`:

```ts
if (this.rendering) return false;          // busy, so N-PZ2 "could not be rendered"
this.rendering = true;
const ok = this.setup(connection, direction);   // always true
if (!ok) { this.rendering = false; return false; }
await this.renderLive();                   // synchronous body; the await only yields one microtask
this.rendering = false;
return true;
```

Notes:

- The `rendering` flag deduplicates Vue's multiple watcher invocations. Example: on first mount, the configurator's
  auto-select changes `connections`, the renderer's `mounted()` renders, and the queued watcher flush then sees
  `rendering === true` (the render's continuation microtask has not run yet) and skips. React needs no such hack: render
  on mount and whenever `config.connections[0]` (by identity) changes. Guard against concurrent async runs with a
  token (§8.3).
- **Quirk Q-L1 (FIX):** if `renderLive()` throws (for example a frame without `frame_type`, or an empty `frames`
  array, §6.3), the promise rejects, `rendering` stays `true` forever, nothing tells the user, and every later render
  of that renderer returns `false` (N-PZ2) until a page reload. If the top renderer is the stuck one, the watcher's
  `!rendererTop.rendering` check silently skips **both** renderers. **FIX:** wrap in `try/finally`, and on an
  exception `console.error` it and show N-PZ2.
- `setup()` calls `connection.setupLookupTable()` (`D3R:60`), an index-building side effect that this view never
  reads. Not needed in the port.
- Rendering is fully synchronous and recomputes the lanes on every render (no caching). Navigating away and back
  re-renders from the stored config (route views are re-mounted, app-shell Q34).

### 3.2 `setup()` (`D3R:58-102`)

1. Store the connection and direction.
2. Read the container `clientWidth` and compute the margins and dimensions (§2.5).
3. Clear the container: `d3.select("#"+id).selectAll("*").remove()`.
4. Append the svg and main g (§2.5).
5. Re-style the shared tooltip div (§2.4).

### 3.3 Protocol dispatch (`D3R:117-124`)

```ts
if (connection.commonFields && connection.commonFields.protocol_type === "TCP_HTTP2")
    lanes = PacketizationTCPPreProcessor.process(connection, direction);
else // "assuming QUIC_H3"
    lanes = PacketizationQUICPreProcessor.process(connection, direction);
```

**NEW:** `protocol_type` no longer exists in main-schema-14 (qlog-spec/main-schema.md: "derive the protocol from
namespaces instead"). Use TCP mode iff `connection.protocolHint === "TCP_HTTP2"` (data-model §3.16.6 and §9.10:
the converter's custom `common_fields.protocol_type`, else derived from the observed `tcp` + `http2` namespaces;
converters §8.6.1). Never test the private schema URI. Otherwise use QUIC mode. A trace with neither QUIC nor TCP
packets gives empty lanes (§6.3). Full mapping in §9.6.

### 3.4 Data model (`MOD:3-43`), PARITY

```ts
enum PacketizationDirection { sending, receiving }        // numeric enum: sending = 0, receiving = 1

interface PacketizationRange {
    start: number;            // absolute byte offset on this diagram's x axis
    size: number;             // bytes
    isPayload: boolean;       // true: full lane height; false: 60% height, bottom-aligned
    contentType?: string;     // packet_type / frame_type / TLS content_type / H2-H3 frame_type
    index: number;            // the unit's ordinal in its lane (packet #, frame #, record #, H3 frame #); -1 for filler
    lowerLayerIndex: number;  // "parent" ordinal for tooltips (often approximate, see §3.6.7)
    color: string;
    rawPacket?: any;          // QUIC lane: packet event data; frame lane: the frame object; H3/stream lanes: the H3 event data
    extra?: any;              // H3/H2: { frame_length }; TLS: { DEBUG_wiresharkFrameNumber, record_length, payload_length }
}

interface PacketizationLane {
    name: string;                         // lane label
    CSSClassName: string;                 // class on rects; used to re-select them when zooming
    rangeToString: (r: PacketizationRange) => string;   // tooltip HTML
    heightModifier?: number;              // default 1; 0.6 for the "Stream IDs" lane
    ranges: PacketizationRange[];
    max_size_local?: number;              // QUIC lane 0 only
    max_size_remote?: number;             // QUIC lane 0 only
    efficiency?: number;                  // QUIC lane 0 only
}

interface LightweightRange { start: number; size: number; }
```

A unit that crosses lower-layer boundaries (for example an H3 frame spanning two STREAM frames) is emitted as
**several ranges with the same `index`**, one per contiguous piece. All pieces share the same color.

Lane CSS class names (PARITY, used in the DOM): QUIC `quicpacket`, `quicframe`, `httpframe`, `streampacket`; TCP
`tcppacket`, `tlspacket`, `httppacket`, `streampacket`.

### 3.5 Shared helpers (`MOD:45-201`)

**`VLIELength(n)`** (QUIC varint encoded size; `MOD:111-137`): `n <= 63 → 1`, `n <= 16383 → 2`,
`n <= 1073741823 → 4`, else `8`. NaN gives 8 (all comparisons are false).

**`H3FrameTypeToNumber(frame)`** (`MOD:48-108`), switch on `frame.frame_type`:
`data 0x00, headers 0x01, reserved 0x02, cancel_push 0x03, settings 0x04, push_promise 0x05, goaway 0x07,
max_push_id 0x0D, unknown → frame.raw_frame_type, default → 0x00`.
**FIX + NEW:** use `h3FrameTypeNumber` from qlog-spec/h3-events.md §8.1:

- `origin` is 0x0c;
- `priority_update` is 0xF0700, or 0xF0701 when `push_id` is set. These need a 4-byte varint, and qvis' default 0
  under-counts by 3 bytes, which misaligns all later frames on the stream;
- `reserved` and `unknown` use `frame_type_bytes`, default 0.

The result is used only through `VLIELength`.

**`extractRanges(ranges, size)`** (`MOD:139-201`). It consumes `size` bytes from the **front** of a FIFO list of
available byte ranges, splitting the last range if needed. It **mutates** `ranges` (shift/unshift) and returns the
consumed pieces, which are the same objects: a split range object is shortened in place and its remainder is
unshifted back as a new object.

```ts
static extractRanges(ranges: LightweightRange[], size: number): LightweightRange[] {
    const output = [];
    let remainingLength = size;
    if (size === 0) { console.warn("Trying to extract ranges for size 0... potential error? Skipping..."); return output; }
    while (ranges.length > 0) {
        const range = ranges.shift()!;
        if (range.start + range.size <= range.start + remainingLength) {      // i.e. range.size <= remaining: consume whole
            output.push(range);
        } else {                                                             // split: only on the last iteration
            if (size === 5 && remainingLength < 5) console.warn("Splitting a header range... server is being bad/naive?", size);
            ranges.unshift({ start: range.start + remainingLength, size: range.size - remainingLength });
            range.size = remainingLength;
            output.push(range);
        }
        if (range.size < 0) console.error("PacketizationDiagram:extractRanges : Negative size after extracting ranges! Should not happen!", ...);
        remainingLength -= range.size;
        if (remainingLength < 0) { alert("Remaining length < 0, CANNOT HAPPEN! " + remainingLength); break; }
        if (remainingLength === 0) break;
    }
    if (remainingLength !== 0) alert("Trying to fill payloadranges that aren't there! " + remainingLength);
    return output;
}
```

The `alert()` calls are blocking browser dialogs and can fire once per frame (an "alert storm") on inconsistent TCP
traces. **FIX:** replace them with `console.error` plus at most **one** warn notification per render (§6.1, N-PZ3).
The return value and the mutation semantics stay **PARITY**.

### 3.6 QUIC + HTTP/3 preprocessor (`QPP:9-533`)

`process(connection, direction) → PacketizationLane[4]`. It is a single pass over **all** events of the trace in file
order. The HTTP/3 layer is derived by mapping H3 frame sizes onto the per-stream STREAM-frame payload byte ranges,
first in, first out.

#### 3.6.1 Direction and event-type selection (`QPP:13-29`)

| | receiving (top) | sending (bottom) |
|---|---|---|
| `QUICEventType` | `packet_received` | `packet_sent` |
| `HTTPEventType` | `frame_parsed` | `frame_created` |

`HTTPHeadersSentEventType`, the event type that carries the **requests** whose `:method`/`:path` are shown in
tooltips, depends only on the vantage point, not on the direction:

- `vantage_point.type === "server"` → `frame_parsed` (the server receives requests);
- `"client"` → `frame_created` (the client sends requests);
- otherwise `undefined` (no request info at all).

qvis matched events on the **type part only** (`event.name` from the event parsers is the type without the category,
`QlogLoaderV2.ts:348-363`). **NEW:** match exact full names: `quic:packet_received`, `quic:packet_sent`,
`http3:frame_parsed`, `http3:frame_created`, `quic:parameters_set`.

#### 3.6.2 State (`QPP:31-56`)

```text
max_packet_size_local = 65527, max_packet_size_remote = 65527      // QUIC default max_udp_payload_size
QUICPacketData[], QUICFrameData[], HTTPData[], StreamData[]         // the four lanes' ranges
QUICPacketIndex = 0, QUICFrameIndex = 0, HTTPindex = 0              // global counters (colors + tooltips)
QUICmax = 0                                                         // running byte offset (x position)
DEBUG_QUICpayloadSize = 0, DEBUG_HTTPtotalSize = 0                  // consistency check only
QUICtotalSize = 0, HTTPpayloadSize = 0                              // efficiency
QUICPayloadRangesPerStream: Map<string streamId, LightweightRange[]>   // available STREAM payload bytes, FIFO
HTTP3OutstandingFramesPerStream: Map<string streamId, H3FrameEventData[]> // H3 frames waiting for bytes, FIFO
HTTPStreamInfo: Map<number streamId, { headers, total_size }>       // request info for tooltips
frameSizeErrorShown = false                                         // static, reset per process() call
```

Stream map keys are `"" + stream_id`, so numeric `4` and string `"4"` meet. `HTTPStreamInfo` keys are
`parseInt(stream_id, 10)`.

#### 3.6.3 Per packet event (`event.name === QUICEventType`, `QPP:213-406`)

```text
data = event.data
1. if (!data.raw) continue                                   // SILENT skip: no lane entries, no frames, no bytes
2. if (!data.header || !data.header.packet_type) { console.error("PacketizationQUICPreProcessor: packet without header.packet_type set... ignoring", ...); continue }
3. if (!data.raw.length):
       if (data.raw.data !== undefined) data.raw.length = data.raw.data.length    // MUTATES the event; counts HEX CHARS (2x bytes) -- bug
       else { console.error("PacketizationQUICPreProcessor: packet without raw.length set... ignoring", ...); continue }
4. totalPacketLength = parseInt("" + data.raw.length, 10)
   trailerLength     = 16                                    // "default authentication tag size is 16 bytes // TODO: support GCM8?"
   payloadLength     = (data.raw.payload_length ? data.raw.payload_length : 0) - 16
   headerLength      = totalPacketLength - payloadLength
   if (!data.raw.payload_length):                            // 0 or absent
       headerLength  = Math.min(4, totalPacketLength)        // same for every packet type ("TODO: actually calculate")
       payloadLength = totalPacketLength - headerLength - 16
5. push 3 ranges into QUICPacketData, all with index=QUICPacketIndex, color = (QUICPacketIndex % 2 === 0 ? "black" : "grey"),
   contentType = data.header.packet_type, lowerLayerIndex = -1, rawPacket = data:
       header : { start: QUICmax,                              size: headerLength,  isPayload: false }
       payload: { start: QUICmax + headerLength,               size: payloadLength, isPayload: true  }
       trailer: { start: QUICmax + headerLength + payloadLength, size: 16,          isPayload: false }
6. if (data.frames) → frame lane, §3.6.4 (frameStart = QUICmax + headerLength)
7. QUICmax += totalPacketLength ; ++QUICPacketIndex ; QUICtotalSize += totalPacketLength
```

**Quirk Q-P1 (FIX, NEW).** With an explicit `raw.payload_length`, qvis treats it as **including** the 16-byte tag. So
header + payload + trailer = `total + 16`: the trailer overlaps the next packet's first 16 bytes, and `xMax` is 16
bytes past the real total. Under the latest drafts, `raw.payload_length` **excludes** headers and trailers, and the
AEAD tag is a 16-byte trailer (quic-events-13 §1.x "Raw Packet and Frame Information"; quic-go writes exactly this).
The port must use:

```ts
payload = pl;  header = total - pl - 16;          // pl = toNum(raw.payload_length), truthy
if (header < 1) {                                  // impossible for a real QUIC packet: the producer logged pl including the tag
    payload = pl - 16; header = total - pl;        // the self-consistent version of qvis' interpretation
    warnOnce("raw.payload_length appears to include the AEAD tag");   // console only
}
```

The fallback for absent or zero `payload_length` (`header = min(4,total)`, `payload = total - header - 16`) stays
**PARITY**. Packets shorter than 20 bytes get a negative payload size and an invalid negative-width rect; see §6.3.
The 16-byte trailer is added for every packet type, including `version_negotiation`, `retry` and `stateless_reset`
(PARITY).

**Quirk Q-P2 (FIX).** The `raw.data` fallback writes the **hex string length** into `raw.length` (twice the byte
count) and mutates the event. Use `raw.data.length / 2` (main-schema-14: `data` is a hexstring and, when `length` is
absent, the data is complete) and **do not mutate**.

#### 3.6.4 Frame lane: sizing frames and laying them out (`QPP:305-400`, `QPP:611-698`)

qvis computes three numbers per frame and **writes them onto the frame objects** (`frame_size`, `header_size`,
`payload_size`) via `backfillFrameSizes(payloadLength, data.frames)`. That function returns an `offset`, the bytes
left unaccounted for.

**Mode selection** (`QPP:617`): `if (frames[0].frame_size)`, i.e. only the **first** frame is checked ("we assume that
if one frame has frame_size set, they all have"). `frame_size` is the frame's total wire size (header + payload).

**Explicit mode** (`QPP:617-629`):

```ts
totalFrameLength = Σ frame.frame_size
offset = payloadLength - totalFrameLength
if (offset !== 0) console.error("PacketizationQUICPreProcessor: frame_sizes don't fill the entire packet payload!", offset)
```

**Guesstimate mode** (`QPP:630-682`), reproduced exactly with its quirks:

```ts
if (!frameSizeErrorShown) { console.error("PacketizationQUICPreProcessor: qlog trace does not have frame_size fields set properly. We -guesstimate- them here, so exact frame sizes are expected to be off!"); frameSizeErrorShown = true; }
let simulatedPayloadLength = 0;
const fakeFrameHeaderSize = 1;          // "pretend all (STREAM) frames have a header of size 1"
let otherFrameCount = 0;
for (const frame of frames) {
    if (frame.frame_type === "stream") {
        if (frame.length !== undefined) {
            frame.frame_size = fakeFrameHeaderSize + parseInt(frame.length, 10);
            simulatedPayloadLength += frame.frame_size;
        } else console.error("PacketizationQUICPreProcessor: stream frame with no length attribute! skipping...", frame);
    }
    if (frame.frame_type === "max_streams") {       // NOTE: separate `if`, so the `else` below also counts STREAM frames
        frame.frame_size = fakeFrameHeaderSize + 4; // "did strange things to googlevideo endpoint" hack; overwritten below
    } else {
        otherFrameCount++;                          // QUIRK: counts every non-max_streams frame INCLUDING stream frames
    }
}
const leftoverLength = payloadLength - simulatedPayloadLength;
if (leftoverLength < 0) {
    console.error("PacketizationQUICPreProcessor: something went wrong calculating frame sizes!", payloadLength, simulatedPayloadLength, frames);
    return 0;                                       // QUIRK: returns BEFORE header_size/payload_size are computed (see below)
}
const lengthPerOtherFrame = Math.floor(leftoverLength / otherFrameCount);
for (const frame of frames) {
    if (frame.frame_type !== "stream") {            // max_streams frames are overwritten here too
        frame.frame_size = lengthPerOtherFrame;
        simulatedPayloadLength += frame.frame_size;
    }
}
if (payloadLength - simulatedPayloadLength < 0)
    console.error("PacketizationQUICPreProcessor: payload is longer than payload! Shouldn't happen!", ...);
offset = payloadLength - simulatedPayloadLength;    // "rounding errors potentially from the Math.floor"
```

Net effect of the quirks (**PARITY**, they shape the familiar qvis picture):

- Leftover bytes are divided by the number of **all** non-MAX_STREAMS frames, STREAM frames included, but only
  non-STREAM frames receive a share. The STREAM frames' shares become the yellow **filler**.
- MAX_STREAMS frames are excluded from the divisor but still get a share. With MAX_STREAMS present, the total can
  exceed the payload, giving a negative offset.
- `otherFrameCount === 0` (only possible when every frame is MAX_STREAMS) gives `Infinity` or `NaN` sizes (§6.3).

**Header/payload split** (`QPP:686-695`, both modes):

```ts
for (const frame of frames) {
    if (frame.length) {                         // truthy: STREAM, CRYPTO, NEW_TOKEN, NEW_CONNECTION_ID in draft-02 (all had `length`)
        frame.header_size  = frame.frame_size - frame.length;   // can be NEGATIVE in guesstimate mode (e.g. CRYPTO)
        frame.payload_size = parseInt(frame.length, 10);
    } else {                                    // every other frame, and zero-length STREAM frames
        frame.header_size  = frame.frame_size;
        frame.payload_size = 0;
    }
}
return offset;
```

**Filler injection** (`QPP:309-326`): if `offset !== 0`, then

```ts
data.frames.unshift({                                   // MUTATES the event's frames array (FIX, see Q-F1)
    header_size: offset, payload_size: 0,
    frame_type: "qvis-injected FILLER (deal with incorrectly guesstimated frame size)",
    qvis: { sequence: { hide: true } },                 // intended to hide it from the sequence diagram (nothing reads this key)
});
```

The filler always goes **first**, so the yellow block appears at the **start** of the packet payload, even if the
missing bytes belong elsewhere (for example trailing padding).

**Layout loop** (`QPP:307`, `328-399`): `frameStart = QUICmax + headerLength`; for each frame (filler included):

```text
isFiller = frame.frame_type.indexOf("qvis") >= 0
if (frame.header_size > 0)  push QUICFrameData {
        index: isFiller ? -1 : QUICFrameIndex, isPayload: false, start: frameStart, size: frame.header_size,
        color: isFiller ? "yellow" : (QUICFrameIndex % 2 === 0 ? "red" : "pink"),
        contentType: frame.frame_type, lowerLayerIndex: QUICPacketIndex, rawPacket: frame }
if (frame.payload_size > 0) {
    push QUICFrameData { index: QUICFrameIndex, isPayload: true, start: frameStart + frame.header_size, size: frame.payload_size,
        color: QUICFrameIndex % 2 === 0 ? "red" : "pink", contentType, lowerLayerIndex: QUICPacketIndex, rawPacket: frame }
    if (frame.frame_type === "stream") {
        DEBUG_QUICpayloadSize += frame.payload_size
        ranges = QUICPayloadRangesPerStream.getOrCreate("" + frame.stream_id)
        ranges.push({ start: frameStart + frame.header_size, size: frame.payload_size })
        outstanding = HTTP3OutstandingFramesPerStream.get("" + frame.stream_id)
        if (outstanding && outstanding.length > 0) processHTTP3Frames(outstanding, ranges)       // §3.6.7, immediately
        if (frame.stream_id !== undefined && frame.stream_id % 2 !== 0)
            console.log("PacketizationPreProcessor: data seen on unidirectional stream: ", ...)  // wrong: odd = server-initiated; drop
    }
}
frameStart += frame.header_size + frame.payload_size
if (!isFiller) ++QUICFrameIndex
```

Consequences to preserve:

- A **negative** offset gives a filler with `header_size < 0`, which is not drawn, but `frameStart` moves back by
  `|offset|`. All real frames are then shifted left so the last one ends exactly at the payload end. The first frames
  overlap the packet header region of the frame lane.
- A negative `header_size` (guesstimate mode CRYPTO frames, see the worked example) is not drawn. Its payload rect
  starts at `frameStart + header_size`, left of `frameStart`, overlapping the previous frame.
- CRYPTO, DATAGRAM and other payloads are drawn but never feed the HTTP/3 layer. Only `frame_type === "stream"` does.
- Zero-length STREAM frames (e.g. FIN-only) produce a header-only rect and no stream range.
- The H3 matching is **offset-agnostic**: STREAM `offset` is never read. Bytes are appended in event order
  (§3.6.10).

**Quirk Q-F1 (FIX).** All of the above **mutates the trace's events**: `frame_size`, `header_size` and
`payload_size` on every frame, plus the filler frame in `data.frames`. Effects in qvis:

- (a) After visiting this tab, the sequence diagram and stats page see the injected filler as a real frame. The
  sequence diagram's frame lists and the stats frame-type counts include
  `"qvis-injected FILLER (deal with incorrectly guesstimated frame size)"`. No code reads `qvis.sequence.hide`; the
  sequence diagram uses `qvis.sequencediagram`.
- (b) Re-rendering the same trace (choosing it again, or leaving and re-entering the tab) gives a **different**
  picture. `frames[0]` is now the filler, which has no `frame_size`, so the packet switches to guesstimate mode, and the
  filler takes part in the guess.
- (c) Exported files contain these fields.

**FIX:** compute sizes into a side array, e.g.
`sized: Array<{frame: QuicFrame | null, isFiller: boolean, header_size: number, payload_size: number}>`, and never
touch the event. The first render's picture is the PARITY reference.

**Quirk Q-F2 (FIX).** Explicit mode is chosen by `frames[0]` alone. If a later frame has no size, the sum is NaN,
`offset` is NaN, and the filler has `header_size = NaN`. Every `frameStart` becomes NaN and none of the packet's frames
are drawn or registered. **FIX:** use explicit mode only if **every** frame has a known size; otherwise use
guesstimate mode.

**Quirk Q-F3 (FIX).** Guesstimate mode with `leftoverLength < 0` returns 0 **before** the header/payload split.
`header_size` and `payload_size` stay undefined, `frameStart` becomes NaN, no frame of that packet is drawn, and its
STREAM bytes never reach the H3 layer, which cascades into misaligned H3 frames on those streams. **FIX:** keep the
`console.error`, set `lengthPerOtherFrame = 0` for the other frames, still run the header/payload split, and return
`offset = payloadLength - simulatedPayloadLength`, which is negative. That gives a negative-offset filler, the same
path as an explicit-mode overshoot.

**Quirk Q-F4 (FIX).** A STREAM frame with no data length keeps `frame_size === undefined` in guesstimate mode (the
second loop skips STREAM frames). That gives NaN layout for the rest of the packet. **FIX:** treat it like a non-STREAM
frame (it gets `lengthPerOtherFrame`, header-only, no stream range), keeping the `console.error`.

**Quirk Q-F5 (FIX).** `data.frames = []` (an empty array is legal in quic-events-13: `? frames: [* $QuicFrame]`)
crashes `backfillFrameSizes` on `frames[0].frame_size`. That triggers Q-L1, a stuck renderer. **FIX:** skip the frame
lane for packets with zero frames (packet ranges are still drawn). A frame without `frame_type` crashes on
`.indexOf` (also Q-L1). **FIX:** treat it as `frame_type "unknown"`.

#### 3.6.5 Latest-draft size accessors for frames (NEW)

qvis read `frame.frame_size` (total wire size, never actually standardised) and `frame.length` (data length of
STREAM/CRYPTO, token length of NEW_TOKEN, CID length of NEW_CONNECTION_ID; draft-02). quic-events-13 has neither:

- every frame has an optional `raw: RawInfo` (CRYPTO: required);
- STREAM, CRYPTO and DATAGRAM put their **Length field (the data length)** in `raw.length`. quic-events-13 says so, and
  its own example advances offsets by `raw.length`. That conflicts with main-schema's generic meaning of `raw.length`
  (full entity). quiche writes `raw.payload_length` instead, quic-go a top-level `length`;
- every other frame type uses main-schema semantics: `raw.length` is the full frame size;
- PADDING: one frame per packet, `raw.payload_length` is the number of padding bytes, which is also its wire size.

Implement these two pure helpers (in `renderer/quicFrameSizes.ts`) and use them in place of the legacy fields. Use the
data-model's `toNum` (uint64 can be a JSON string) and, if the data-model contract provides it, `streamFrameDataLength`
(qlog-spec/ecosystem.md §6.6).

```ts
const DATA_FRAMES = new Set(["stream", "crypto", "datagram"]);

/** replaces draft-02 `frame.length` (bytes drawn as the frame's payload) */
export function frameDataLength(f: any): number | undefined {
    switch (f.frame_type) {
        case "stream": case "crypto": case "datagram":
            return toNum(f.raw?.payload_length) ?? toNum(f.raw?.length) ?? toNum(f.length);   // = streamFrameDataLength
        case "new_token":         // draft-02 `length` was the token length (always present, so always a payload rect)
            return toNum(f.token?.raw?.length) ?? hexByteLength(f.token?.raw?.data);
        case "new_connection_id": // draft-02 `length` was the CID length (always present)
            return toNum(f.connection_id_length) ?? hexByteLength(f.connection_id);
        default:                  return undefined;                      // header-only (PADDING too, PARITY with draft-02)
    }
}

/** main-schema-14 §11.4: a hexstring without a companion length is the complete value */
const hexByteLength = (h: unknown) => (typeof h === "string" ? Math.floor(h.replace(/^0x/i, "").length / 2) : undefined);

/** replaces draft-02 `frame.frame_size` (total wire size), undefined when unknown */
export function frameWireLength(f: any): number | undefined {
    const rawLen = toNum(f.raw?.length), rawPl = toNum(f.raw?.payload_length);
    if (f.frame_type === "padding") return rawPl ?? rawLen;
    if (DATA_FRAMES.has(f.frame_type)) {
        if (rawLen !== undefined && rawPl !== undefined && rawLen > rawPl) return rawLen;   // producer used main-schema semantics
        const len = frameDataLength(f);
        if (len === undefined) return undefined;
        return dataFrameHeaderLength(f, len) + len;                                         // NEW, see below
    }
    return rawLen;                    // every other type (incl. new_token, new_connection_id): main-schema "full entity" length
}

/** RFC 9000 §19.6/§19.8, RFC 9221 §4, assuming minimal varints and the Length field present (LEN bit set) */
function dataFrameHeaderLength(f: any, len: number): number {
    switch (f.frame_type) {
        case "stream": {
            const off = toNum(f.offset) ?? 0;
            return 1 + VLIELength(toNum(f.stream_id) ?? 0) + (off > 0 ? VLIELength(off) : 0) + VLIELength(len);
        }
        case "crypto":   return 1 + VLIELength(toNum(f.offset) ?? 0) + VLIELength(len);
        case "datagram": return 1 + VLIELength(len);
    }
    return 1;
}
```

Mode selection in the port: **explicit** iff `frames.length > 0 && frames.every(f => frameWireLength(f) !== undefined)`
(Q-F2 fix). Then `frame_size := frameWireLength(f)`. Otherwise **guesstimate** (port of §3.6.4), with
`frame.length := frameDataLength(f)` for the STREAM rule. The header/payload split uses `frameDataLength(f)` in
place of `frame.length`, with the same truthiness test (0 means header-only).

**DECISION D-PZ2 (recommended: as above).** The computed STREAM/CRYPTO/DATAGRAM header length in `frameWireLength` is
new. Without it, *every* packet carrying a STREAM frame falls into guesstimate mode, even when a producer logs
`raw.length` on all other frames, because quic-events-13 gives the STREAM `raw.length` its data-length meaning. With
it, explicit mode is reachable for such producers. Packets whose frames all have computable sizes (typically a single
STREAM frame) render exactly. Where an implementation used non-minimal varints, the computed sizes are too small and a
small yellow filler appears. Where the last STREAM or DATAGRAM frame of a packet omitted its Length field (RFC 9000
§19.8 LEN bit 0, RFC 9221 type 0x30), the computed size is 1-8 bytes too large, which gives a negative offset; the
LEN-bit inference rule in §9.4.3 removes exactly that case. In guesstimate mode the qvis rule (STREAM size = 1 + data
length) is kept unchanged (PARITY).

What real producers give (ecosystem.md): quic-go logs no `raw` on frames and a top-level STREAM `length`. Packets with
ACK frames therefore use guesstimate mode, and pure STREAM packets use explicit mode with computed headers. quiche logs
`raw.payload_length` on STREAM, CRYPTO and PADDING, and nothing on ACK.

**ENH-1 (optional, default OFF, not parity).** Compute exact wire sizes for every QUIC v1 frame type whose encoding is
fully determined by its qlog fields (PING, HANDSHAKE_DONE, MAX_DATA, MAX_STREAM_DATA, MAX_STREAMS, *_BLOCKED,
RETIRE_CONNECTION_ID, PATH_CHALLENGE/RESPONSE, RESET_STREAM, STOP_SENDING, NEW_CONNECTION_ID, CONNECTION_CLOSE).
Then give the leftover to the remaining unknown frames (usually the ACK), which removes most yellow fillers. This
changes the picture versus qvis, so it should sit behind a code-level flag.

#### 3.6.6 HTTP/3 frame events (`event.name === HTTPEventType`, `QPP:408-449`)

```text
data = event.data
if (!data.byte_length) { console.error("H3 frame didn't have byte_length set! skipping...", data); continue }
payloadRangesForStream = QUICPayloadRangesPerStream.get("" + data.stream_id)
skipProcessing = false
if (!payloadRangesForStream):
    if (direction === sending) skipProcessing = true        // frame_created precedes packet_sent: queue it, processed when STREAM bytes arrive
    else { console.error("No payload ranges known for this stream_id, skipping...", ...); continue }   // receiving: DROPPED
outstanding = HTTP3OutstandingFramesPerStream.getOrCreate("" + data.stream_id)
outstanding.push(data)                                      // H3 frames are held back until all their bytes are present
if (!skipProcessing) processHTTP3Frames(outstanding, payloadRangesForStream)
```

**NEW:** `byte_length` is replaced by `h3FramePayloadLength(data.frame)` (h3-events.md §8.1:
`frame.raw.payload_length`, else derived from `frame.raw.length` or `frame.raw.data` with minimal-varint inversion).
The event-level `byte_length`, `length` and `raw` no longer exist; sizes live in `data.frame.raw`.

**Quirk Q-H1 (FIX).** `!data.byte_length` also rejects a numeric `0`. A SETTINGS frame with no settings has payload 0,
and dropping it shifts every later frame on the control stream. **FIX:** skip only when the payload length is
`undefined`. Message: `"H3 frame didn't have a payload length (frame.raw.payload_length / frame.raw.length) set! skipping..."`
(console only).

**Quirk Q-H2 (FIX).** In the receiving direction, an H3 frame whose stream has not yet carried any STREAM bytes is
**dropped**. That happens when an implementation logs `frame_parsed` before the corresponding `packet_received`. The
next frames on that stream then eat its bytes, and the whole stream is misaligned. **FIX:** queue it in both
directions, like the sending path. If the bytes never arrive, it is reported by the "Not all HTTP3 frames found a
home!" check. Keep the `console.error` text, as a warning.

#### 3.6.7 `processHTTP3Frames(outstandingFrames, payloadRangesForStream)` (`QPP:60-205`)

It runs from two places: right after an H3 event is queued (§3.6.6), and right after a STREAM frame adds bytes to a
stream that has queued frames (§3.6.4). That second call happens **inside** the packet's frame loop, before
`QUICFrameIndex` is incremented for the current frame.

```text
while (outstandingFrames.length > 0):
    frameEvt = outstandingFrames.shift()
    framePayloadLength = parseInt(frameEvt.byte_length, 10)                          // NEW: h3FramePayloadLength(frameEvt.frame)
    frameHeaderLength  = VLIELength(H3FrameTypeToNumber(frameEvt.frame)) + VLIELength(framePayloadLength)
    totalAvailablePayloadSize = Σ payloadRangesForStream[i].size
    if (totalAvailablePayloadSize < frameHeaderLength + framePayloadLength):
        outstandingFrames.unshift(frameEvt); break                                    // wait until the WHOLE frame is available
    headerRanges = extractRanges(payloadRangesForStream, frameHeaderLength)
    for r of headerRanges:
        HTTPData.push { isPayload:false, contentType: frameEvt.frame.frame_type, index: HTTPindex,
                        lowerLayerIndex: QUICFrameIndex - 1, start: r.start, size: r.size,
                        color: HTTPindex % 2 === 0 ? "blue" : "lightblue",
                        extra: { frame_length: frameHeaderLength + framePayloadLength }, rawPacket: frameEvt }
        if (frameEvt.stream_id !== undefined)
            StreamData.push { isPayload: TRUE, same contentType/index/lowerLayerIndex/start/size/extra/rawPacket,
                              color: StreamIDToColor("" + parseInt(frameEvt.stream_id, 10), "HTTP3")[0] }
    DEBUG_HTTPtotalSize += frameHeaderLength
    if (framePayloadLength > 0):
        payloadRanges = extractRanges(payloadRangesForStream, framePayloadLength)
        for r of payloadRanges:
            HTTPData.push { isPayload:true, ..., lowerLayerIndex: QUICFrameIndex, ... same color rule ... }
            if (stream_id !== undefined) StreamData.push { isPayload:true, ..., lowerLayerIndex: QUICFrameIndex, stream color }
        if (frame_type === "data"):
            streamID = parseInt(frameEvt.stream_id, 10)
            if (streamID !== 0):                                                      // QUIRK Q-H3: inherited from HTTP/2
                if (!HTTPStreamInfo.has(streamID)) console.error("PacketizationDiagram: trying to increase payload size sum, but streamID not yet known! Potentially Server Push (which we don't support yet)", ...)
                else HTTPStreamInfo.get(streamID).total_size += framePayloadLength
        if (frame_type === "data" || frame_type === "headers") HTTPpayloadSize += framePayloadLength
        DEBUG_HTTPtotalSize += framePayloadLength
    ++HTTPindex
```

Notes:

- **Optional header length shortcut (NEW, recommended).** If `frame.raw.length` and `frame.raw.payload_length` are
  both present, use `frameHeaderLength = raw.length - raw.payload_length`. It equals the computed value for minimal
  varints and stays aligned when a producer uses non-minimal encodings.
- The header rect gets `lowerLayerIndex = QUICFrameIndex - 1`, the payload rect `QUICFrameIndex`. Both are the
  **global** counter at processing time, not the frame that contains the bytes. They only appear in the tooltip text
  "(QUIC frame index: N)" (PARITY: keep the same values, which costs nothing; optional: compute the true containing
  frame).
- `HTTPindex` increases in **processing order**. Frames waiting on one stream can be overtaken by frames on other
  streams, so the blue/lightblue alternation follows completion order, not event order.
- **Quirk Q-H3 (FIX).** `streamID !== 0` excludes stream 0, but in HTTP/3, stream 0 is the **first request stream**.
  Its "total resource size" stays 0 in tooltips. **FIX:** for HTTP/3, drop the `!== 0` test. (The TCP preprocessor
  keeps it: H2 stream 0 is the connection stream.)
- The stream lane copies every H3 piece (header **and** payload) with `isPayload: true`, so its bars are always 15px
  tall and top-aligned.
- Unidirectional H3 streams (control, QPACK, push) start with a stream-type varint that is not an H3 frame. qvis does
  not account for it, so the first frame on such a stream starts **one byte early** and one byte is left over at the
  end. This is PARITY (tolerated by the leftover check, §3.6.9). Optional fix (ENH-2): when an
  `http3:stream_type_set` event is seen for a unidirectional stream, consume `VLIELength(type code)` bytes from that
  stream's ranges before the first frame.

#### 3.6.8 Request info and transport parameters (`QPP:452-478`)

Every event, independently of the branches above:

```text
if (event.name === HTTPHeadersSentEventType && event.data && event.data.frame && event.data.frame.frame_type === "headers"):
    streamID = parseInt(event.data.stream_id, 10)
    if (!HTTPStreamInfo.has(streamID)) HTTPStreamInfo.set(streamID, { headers: event.data.frame.headers, total_size: 0 })
    else console.error("PacketizationQUICPreprocessor: HTTPStreamInfo already had an entry for this stream", ...)   // e.g. trailers: first one wins

if (event.name === "parameters_set"):                                     // NEW: exactly "quic:parameters_set"
    if (data.owner === "local"  && data.max_packet_size) max_packet_size_local  = data.max_packet_size
    else if (data.owner === "remote" && data.max_packet_size) max_packet_size_remote = data.max_packet_size
```

- **NEW:** `owner` becomes `initiator`, and `max_packet_size` becomes `max_udp_payload_size` (uint64, use `toNum`). The
  last value wins. qvis also matched `recovery:parameters_set` and `http:parameters_set` through the type-only match;
  that was harmless and is gone.
- Request headers are collected in **both** diagrams from the same requests (vantage-point based), so the receiving
  diagram's tooltips show the request that a response belongs to.
- **NEW:** headers are `HTTP3HTTPField { name?, name_bytes?, value?, value_bytes? }`. Read them with
  `fieldName`/`fieldValue` (h3-events.md §8.1), so `name_bytes`/`value_bytes` work too.

#### 3.6.9 End-of-trace checks and lane assembly (`QPP:481-530`)

```text
controlStreamData = Σ sizes of leftover ranges on streams with (id+1)%4===0 (3,7,11,…) or (id+2)%4===0 (2,6,10,…)
for every other stream with leftover ranges: console.error("PacketizationQUICPreprocessor: Not all QUIC payload ranges were used up!", id, ranges, outstanding)
for every stream with queued H3 frames:     console.error("PacketizationQUICPreprocessor: Not all HTTP3 frames found a home!", id, frames)
if (DEBUG_QUICpayloadSize !== DEBUG_HTTPtotalSize && DEBUG_QUICpayloadSize !== DEBUG_HTTPtotalSize + controlStreamData)
    console.error("QUIC payload size != HTTP3 payload size", "QUIC: ", ..., "HTTP: ", ..., "HTTP leftover on control streams: ", ..., "Diff : ", ...)
efficiency = HTTPpayloadSize / QUICtotalSize          // NaN when no packets
return [
  { name: "QUIC packets", CSSClassName: "quicpacket",   ranges: QUICPacketData, rangeToString: quicRangeToString,
    max_size_local: max_packet_size_local, max_size_remote: max_packet_size_remote, efficiency },
  { name: "QUIC frames",  CSSClassName: "quicframe",    ranges: QUICFrameData,  rangeToString: quicFrameRangeToString },
  { name: "HTTP/3",       CSSClassName: "httpframe",    ranges: HTTPData,       rangeToString: r => httpFrameRangeToString(r, HTTPStreamInfo) },
  { name: "Stream IDs",   CSSClassName: "streampacket", ranges: StreamData,     rangeToString: r => streamRangeToString(r, HTTPStreamInfo), heightModifier: 0.6 },
]
```

"Efficiency" is the fraction of this direction's on-wire QUIC bytes that are HTTP/3 **DATA and HEADERS payload**,
counting only frames that were actually placed. Everything else (packet headers, AEAD tags, QUIC frame headers, H3
frame headers, control/SETTINGS/QPACK traffic, ACKs, padding, CRYPTO) counts as overhead. The checks are console-only
diagnostics. The port should collect them into a returned `diagnostics: string[]` (for tests) **and** log them.

#### 3.6.10 Things the QUIC preprocessor does NOT do (PARITY, document in code)

- **No UDP datagram layer.** `is_coalesced` (draft-02), `datagram_payload_checksum` (quic-events-13) and
  `quic:udp_datagrams_*` events are ignored. Coalesced packets are laid out back to back like any other packets, with
  no visual grouping. A datagram lane would be a new feature, not parity.
- **No STREAM offset handling.** Bytes are appended per stream in **event order**. Retransmitted STREAM data adds
  duplicate bytes, and out-of-order reception puts bytes in arrival order. Both shift all later H3 frames on that
  stream and leave leftover bytes (only reported in the console).
- **No `quic:stream_data_moved` use** (qvis comment `QPP:379-380`: "proper form would be to log data_moved for them,
  but no-one is doing this correctly yet").
- **Packets without `raw` are invisible.** Many producers do not log `raw`, and then the whole diagram is empty
  without explanation (§6.3, DECISION D-PZ4).
- **Lost or dropped packets** are not marked; a sent packet appears once per `packet_sent`.
- **Only `connections[0]`** of the config is rendered.

#### 3.6.11 Worked example (fixed semantics Q-P1, guesstimate frames)

Client trace, receiving direction, first packet:

```json
{"name":"quic:packet_received","data":{"header":{"packet_type":"1RTT","packet_number":5},
  "raw":{"length":1252,"payload_length":1224},
  "frames":[{"frame_type":"ack","acked_ranges":[[0,3]]},
            {"frame_type":"stream","stream_id":0,"offset":0,"raw":{"length":1200}}]}}
```

- Packet: total 1252, payload 1224, header 1252 - 1224 - 16 = 12. Ranges: header `[0,12)`, payload `[12,1236)`,
  trailer `[1236,1252)`, all black (packet #0). QUICmax becomes 1252.
- Frames: the ACK has no size, so guesstimate mode.
  - STREAM: `frame_size = 1 + 1200 = 1201`, so `simulated = 1201`.
  - `otherFrameCount` = 2 (ACK + STREAM, the quirk). `leftover = 1224 - 1201 = 23`, `per = floor(23/2) = 11`, so the
    ACK's `frame_size` is 11 and `simulated = 1212`. `offset = 12`.
  - Split: STREAM header `1201 - 1200 = 1`, payload 1200. ACK header 11, payload 0.
  - Filler `header_size 12` goes first.
  - Frame lane from `frameStart = 12`: filler `[12,24)` yellow (index -1); ACK header `[24,35)` red (frame #0); STREAM
    header `[35,36)` pink (frame #1); STREAM payload `[36,1236)` pink. Stream "0" gets the available range `{36,1200}`.
- Then `http3:frame_parsed {stream_id:0, frame:{frame_type:"headers", raw:{payload_length:36}, headers:[…]}}`:
  header `VLIE(1)+VLIE(36) = 2`; 38 ≤ 1200, so the H3 header is `[36,38)` and the payload `[38,74)`, blue (H3 frame #0).
  The stream lane gets the same two pieces in `#E1DA4C` (stream 0). Stream "0" has `{74,1162}` left.
- Then `frame_parsed {stream_id:0, frame:{frame_type:"data", raw:{payload_length:2623}}}`: header `1+2 = 3`,
  3 + 2623 > 1162, so it waits. It is processed as soon as later STREAM frames on stream 0 bring the available total to
  ≥ 2626. It is then drawn as several `[start,size)` pieces in lightblue (H3 frame #1), one per STREAM-frame payload
  piece.

Under qvis' original formula the packet would be header 44 (`1252 - (1224-16)`), payload 1208, trailer `[1252,1268)`,
overlapping the next packet by 16 bytes.

### 3.7 TCP + TLS + HTTP/2 preprocessor (`TPP:10-343`)

Inputs come from the qvis-custom schema (`TCPQ`) written by `T2Q`. **NEW:** in qvis-react the ported tshark converter
emits them under `tcp:`, `tls:` and `http2:` (ARCHITECTURE §0), and several size fields moved into `raw` (converters
§8.6.1 and §8.7). The pseudo-code below keeps the qvis field names; translate every field access with §9.7. qvis used
category `"transport"` for TCP and matched on the type part only.

| | receiving | sending |
|---|---|---|
| TCP event | `tcp:packet_received` | `tcp:packet_sent` |
| TLS event | `tls:record_parsed` | `tls:record_created` |
| H2 event | `http2:frame_parsed` | `http2:frame_created` |
| request-headers event (by vantage point) | server: `http2:frame_parsed`, client: `http2:frame_created`, else none | same |

`directionText` (`TPP:18,25`) is computed but unused.

Per event (`TPP:57-327`), in order:

1. **TCP segment** (`TPP:62-103`): `if (data.header.payload_length === 0) continue` (pure ACKs are not shown).
   `length = header.header_length + header.payload_length`.
   - Push header `{start: TCPmax, size: header_length, isPayload:false}` and payload
     `{start: TCPmax+header_length, size: payload_length, isPayload:true}`, color black/grey by `TCPindex`,
     `lowerLayerIndex -1`, `rawPacket = data`.
   - `TCPPayloadRanges.push({start: TCPmax+header_length, size: payload_length})`.
   - `TCPmax += length; ++TCPindex`.
2. **TLS record** (`TPP:104-193`): `payloadLength = max(0, header.payload_length)`,
   `recordLength = header_length + payloadLength + trailer_length`.
   - `extractRanges(TCPPayloadRanges, header_length)` gives header pieces (isPayload false).
   - `extractRanges(…, payloadLength)` gives payload pieces (isPayload true). Size 0 gives the console.warn and no
     pieces. If `content_type === "application"`, each payload piece is also pushed to `TLSPayloadRanges`, and
     `DEBUG_TLSpayloadSize` grows.
   - If `trailer_length !== 0`: `extractRanges(…, trailer_length)` gives trailer pieces (isPayload false).
   - All pieces: color red/pink by `TLSindex`, `contentType = header.content_type`,
     `lowerLayerIndex = TCPindex - 1` (the last segment seen), `extra = {DEBUG_wiresharkFrameNumber, record_length,
     payload_length}`, `rawPacket = data`. Then `++TLSindex`.
3. **H2 frame** (`TPP:194-315`):
   - If `header_length > 0` (the client MAGIC preface has none): header pieces from `TLSPayloadRanges`, blue/lightblue
     by `HTTPindex`, `lowerLayerIndex = TLSindex - 1`, `extra.frame_length = header_length + payload_length`.
     If `stream_id !== undefined`, also stream-lane pieces (`isPayload: true`, color
     `StreamIDToColor("" + parseInt(stream_id), "HTTP2")[0]`). `DEBUG_HTTPtotalSize += header_length`.
   - If `payload_length > 0`: payload pieces plus stream pieces the same way. DATA frames with `streamID !== 0` add
     `payload_length` to `HTTPStreamInfo[streamID].total_size`, or log `console.error("PacketizationTCPPreprocessor:
     trying to increase payload size sum, but streamID not yet known! Potentially Server Push (which we don't support
     yet)", …)`. `DEBUG_HTTPtotalSize += payload_length`.
   - Else, if `frame.frame_type !== "settings"`: `console.warn("PacketizationTCPPreprocessor: Found HTTP frame without
     payload length... potential error?", data)`.
   - `++HTTPindex`.
   - MAGIC has `stream_id = -1`, so its stream color is `lavenderblush`.
4. **Request headers** (`TPP:317-326`): same rule as QUIC, on the H2 HEADERS frames of the request-headers event type.
   The duplicate message is `"PacketizationTCPPreprocessor: HTTPStreamInfo already had an entry for this stream"`.

End checks (`TPP:329-335`): leftover `TCPPayloadRanges` or `TLSPayloadRanges` give
`"PacketizationTCPPreprocessor: Not all payload ranges were used up!"`. A size mismatch gives
`"TLS payload size != HTTP payload size"`.

Lanes (`TPP:337-340`): `"TCP"/tcppacket/tcpRangeToString`, `"TLS"/tlspacket/tlsRangeToString`,
`"HTTP/2"/httppacket/httpRangeToString`, `"Stream IDs"/streampacket/streamRangeToString` with `heightModifier 0.6`.
No `max_size_*` and no `efficiency`, so those labels are absent.

`extractRanges` can run out of bytes on inconsistent traces (e.g. missing segments), which triggers the "Trying to
fill payloadranges that aren't there!" alert (FIX N-PZ3).

### 3.8 `renderLive()` step by step (`D3R:106-359`)

1. `lanes = TCP or QUIC preprocessor` (§3.3).
2. `xMax` from lane 0 (§2.5).
3. Append `defs/clipPath#clip` and the clipped rect group (§2.5).
4. `xDomain`, then the axis.
5. Define the `mouseOver`/`mouseOut` handlers (§3.10).
6. `packetHeight = totalHeight * (1 / lanes.length)` = 25.
7. `allClassNames = lanes.map(l => "." + l.CSSClassName).join(",")`, e.g.
   `".quicpacket,.quicframe,.httpframe,.streampacket"`.
8. For each lane: data-join its ranges as rects into the clipped group (§2.5 formulas), then append its label.
9. Append the direction legend, max-size labels, efficiency label and flow label (§2.5).
10. Install zoom (§3.9).

There is no transition on initial render and no "no data" message.

### 3.9 Zoom (`D3R:323-354`)

```ts
const updateChart = () => {
    const newX = d3.event.transform.rescaleX(xDomain);
    xAxis.call(d3.axisBottom(newX));                       // (axisTop if axisLocation === "top")
    rects.selectAll(allClassNames)
        .attr("x",     (d) => newX(d.start) - packetSidePadding)
        .attr("width", (d) => newX(d.start + d.size) - newX(d.start) + packetSidePadding * 2);
};
const zoom = d3.zoom()
    .scaleExtent([1, 2000])                                 // comment in code ("x0.5 … x50") is stale
    .translateExtent([[0, 0], [width, height]])             // height = 100
    .extent([[0, 0], [width, height]])
    .on("zoom", updateChart);
this.svg.call(zoom);                                        // this.svg is the translated main <g>, NOT the <svg>
```

The zoom state lives on the main g and is discarded with it on the next render.

### 3.10 Tooltip handlers (`D3R:166-184`)

```ts
mouseOver(toString, d) {
    tooltip.transition().duration(100).style("opacity", .95);
    tooltip.html(toString(d)).style("left", (pageX + 15) + "px").style("top", (pageY - 75) + "px");
}
mouseOut() { tooltip.transition().duration(200).style("opacity", 0); }
```

### 3.11 Tooltip texts (verbatim, PARITY; values interpolated **raw** in qvis, FIX: escape, §7 Q-X1)

`+` is string concatenation. Values print as JavaScript `String(value)`, so an absent value prints `"undefined"`.
`<br/>` and `<b>` are real markup.

**QUIC packets lane** (`QPP:536-544`):

```text
"QUIC " + (isPayload ? "Payload #" : (size === 16 ? "Trailer (authentication tag) #" : "Header #")) + index + " : size " + size + "<br/>"
+ "Packet type : " + contentType + ", Packet nr : " + rawPacket.header.packet_number + "<br/>"
```

Example: `QUIC Header #0 : size 12<br/>Packet type : 1RTT, Packet nr : 5<br/>`. Quirk (PARITY): a **header** of
exactly 16 bytes is labelled "Trailer (authentication tag)". Packets without a packet number print
`Packet nr : undefined`.

**QUIC frames lane** (`QPP:546-555`), the same text for the header and payload pieces:

```text
"QUIC Frame #" + index + " : size " + size + "<br/>"
+ "Frame type : " + contentType + ", stream ID: " + (rawPacket && rawPacket.stream_id !== undefined ? rawPacket.stream_id : "none") + "<br/>"
+ (rawPacket && rawPacket.fin === true ? "<b>FIN BIT SET</b>" : "")
```

Filler: `QUIC Frame #-1 : size 12<br/>Frame type : qvis-injected FILLER (deal with incorrectly guesstimated frame size), stream ID: none<br/>`.
In the port, `rawPacket` for the filler is a synthetic object `{frame_type: <filler text>}`.

**HTTP/3 lane** (`QPP:557-581`):

```text
"H3 " + (isPayload ? "Payload #" : "Header #") + index + " (QUIC frame index: " + lowerLayerIndex + ") : frame size " + extra.frame_length + ", partial size : " + size + "<br/>"
+ "frame type: " + rawPacket.frame.frame_type + ", streamID: " + rawPacket.stream_id
+ STREAMINFO
```

**Stream IDs lane, QUIC** (`QPP:583-606`): `"H3 " + "streamID: " + rawPacket.stream_id + STREAMINFO`.

`STREAMINFO`, present if `HTTPStreamInfo.get(parseInt(rawPacket.stream_id, 10))` exists:

```text
"<br/>" + method + ": " + path + "<br/>" + "total resource size: " + total_size + "<br/>"
```

`method` and `path` are the **last** `:method` and `:path` entries found in `streamInfo.headers`, or `""` when missing
(so `": /index.html"` is possible).

**TCP lane** (`TPP:345-352`): `"TCP " + (isPayload ? "Payload #" : "Header #") + index + " : packet size " + size + "<br/>"`
(the "packet size" is the piece size).

**TLS lane** (`TPP:354-368`):

```text
"TLS " + (isPayload ? "Payload #" : (size > 5 ? "Trailer (MAC/auth tag/padding/content type) " : "Header #")) + index
+ " (TCP index: " + lowerLayerIndex + ") : record size " + extra.record_length + ", partial size " + size + "<br/>"
+ (extra.DEBUG_wiresharkFrameNumber ? "Wireshark frame number (DEBUG): " + extra.DEBUG_wiresharkFrameNumber + "<br/>" : "")
+ "content type: " + contentType
```

Quirks (PARITY): a trailer piece of 5 bytes or less, and any split header piece, is labelled "Header #". "Trailer"
has no `#` before the index.

**HTTP/2 lane** (`TPP:370-399`):

```text
"H2 " + (isPayload ? "Payload #" : "Header #") + " (TLS index: " + lowerLayerIndex + ") : frame size " + rawPacket.payload_length + ", partial size : " + size + "<br/>"
+ "frame type: " + rawPacket.frame.frame_type + ", streamID: " + rawPacket.stream_id
+ (rawPacket.frame.stream_end ? "<br/><b>STREAM END BIT SET</b>" : "")
+ STREAMINFO
```

Quirks (PARITY): no `index` is printed (`"H2 Header # (TLS index: 3) …"`), and "frame size" is the **payload**
length.

**Stream IDs lane, TCP** (`TPP:401-429`): `"H2 " + "streamID: " + rawPacket.stream_id + (stream_end ? "<br/><b>STREAM END BIT SET</b>" : "") + STREAMINFO`.

---

## 4. Event and field consumption

Old names are what qvis matched (type part only; categories in parentheses are what the producers used). Latest names
are what qvis-react must match exactly (full name, data-model §9.1). Source lines were re-verified against
`QPP`, `TPP`, `MOD`, `D3R`, `RND` and `CFG`. Section 9 gives, for every row, the semantic differences, the behaviour
when the member is absent, and the PARITY/FIX/NEW tag; this table is the inventory.

**QUIC + HTTP/3 mode**

| qvis (old) event / field | Read at | Latest-draft equivalent | Used for |
|---|---|---|---|
| `packet_received` / `packet_sent` (`transport:`), type-only match | `QPP:13-21`, `:213` | `quic:packet_received` / `quic:packet_sent` (exact; `transport:packet_*` from current quic-go is **not** matched, §9.1) | QUIC packets and frames lanes (direction by event type) |
| `data.raw` (presence) | `QPP:217` | `data.raw` (RawInfo, optional) | packets without it are skipped silently |
| `data.header` (presence) and `data.header.packet_type` | `QPP:221`, `:266`, `:282`, `:298` | `data.header` (required) `.packet_type` (`initial`, `handshake`, `0RTT`, `1RTT`, `retry`, `version_negotiation`, `stateless_reset`, `unknown`) | required (else skipped + console.error); `contentType`; tooltip "Packet type" |
| `data.raw.length` (number or string; truthiness test) | `QPP:226`, `:236` | `data.raw.length` (uint64) | total packet size, x advance, efficiency denominator |
| `data.raw.data` (hex) | `QPP:227-228` | `data.raw.data` (hexstring) | fallback size when `raw.length` is absent or 0 (qvis: hex-char count and event mutation, FIX: `/2`, no write) |
| `data.raw.payload_length` (truthiness; assumed to **include** the AEAD tag) | `QPP:238`, `:244` | `data.raw.payload_length` (**excludes** header and tag) | header/payload split (Q-P1) |
| `data.header.packet_number` | `QPP:541` | `data.header.packet_number` (optional uint64) | tooltip "Packet nr" |
| `data.frames` (presence) and `data.frames[]` | `QPP:305`, `:309`, `:323`, `:328` | `data.frames` (optional `[* $QuicFrame]`, may be empty or absent) | frames lane; absent frames: D-PZ7 (§9.9) |
| `frame.frame_type` | `QPP:335-343`, `:361`, `:367`, `:396`, `:644-671`, `:687`; tooltip `:549` | `frame.frame_type` (open socket; new types in §9.4) | tooltip; STREAM detection; guesstimate rules (`stream`, `max_streams`); filler detection (`"qvis"` substring, FIX: explicit `isFiller` flag) |
| `frame.frame_size` (never standardised) | `QPP:617-621` | `frameWireLength(frame)` (§3.6.5): `raw.length`, PADDING `raw.payload_length`, STREAM/CRYPTO/DATAGRAM computed | explicit sizing mode |
| `frame.length` (STREAM, CRYPTO, NEW_TOKEN, NEW_CONNECTION_ID) | `QPP:645-646`, `:687-689` | `frameDataLength(frame)`: STREAM/CRYPTO/DATAGRAM `raw.payload_length ?? raw.length` (?? `length`); NEW_TOKEN `token.raw.length ?? token.raw.data/2`; NEW_CONNECTION_ID `connection_id_length ?? connection_id/2` | header/payload split; STREAM bytes for H3 |
| `frame.stream_id` | `QPP:371-374`, `:382`, `:387`; tooltip `:549` | `frame.stream_id` (uint64; JSON string from mvfst) | per-stream byte ranges (`"" + id` key); tooltip "stream ID" for **any** frame type that has the key |
| `frame.fin` | tooltip `QPP:550` | `frame.fin` (default false; quiche writes it only when true) | tooltip "FIN BIT SET" |
| `frame.offset` | (not read) | `frame.offset` (default 0) | qvis: unused. Port: STREAM/CRYPTO header length computation (D-PZ2) |
| `frame_parsed` / `frame_created` (`http:`), type-only match | `QPP:14-21`, `:408` | `http3:frame_parsed` / `http3:frame_created` (exact; `http:frame_*` is not matched and `http:` is now the Capsule namespace) | HTTP/3 and Stream IDs lanes |
| `data.byte_length` (string, H3 frame **payload** length; truthiness) | `QPP:67`, `:412` | `h3FramePayloadLength(data.frame)`: `frame.raw.payload_length`, else derived from `frame.raw.length` / `frame.raw.data` | H3 frame payload size and header varint |
| `data.frame` (presence) | guarded at `QPP:182`, `:194`, `:452`; **unguarded** at `QPP:68` (via `MOD:76`), `:89`, `:111` (crash) | `data.frame` (required `$HTTP3Frame`) | everything H3; absent: skipped with the Q-H1 diagnostic (FIX of the crash) |
| `data.frame.frame_type` | `QPP:89`, `:111`, `:141`, `:164`, `:182-196`, `:452`; `MOD:76-106`; tooltip `:561` | `data.frame.frame_type` | header varint size; tooltip; DATA/HEADERS accounting; request info |
| `data.frame.raw_frame_type` (`unknown`); `reserved` mapped to fixed `0x02` | `MOD:101-102`; `MOD:83-84` | `data.frame.frame_type_bytes` (required on `reserved` and `unknown`) | header varint size |
| (none) | — | `data.frame.push_id` on `priority_update` | 0xF0700 vs 0xF0701 type code (FIX) |
| (none) | — | `data.frame.raw.length` with `raw.payload_length` | optional exact H3 header length (§3.6.7 note) |
| `data.stream_id` | `QPP:105-106`, `:158-159`, `:183`, `:417`, `:435`, `:455`; tooltips `:561-563`, `:586-588` | `data.stream_id` (uint64, required; the **carrying** stream, e.g. the control stream for SETTINGS/PRIORITY_UPDATE) | match to STREAM bytes; stream color; tooltip; request-info key |
| `data.frame.headers[] {name, value}` on HEADERS | `QPP:457`, `:568-575`, `:593-600` | `data.frame.headers[]` `HTTP3HTTPField {name?, name_bytes?, value?, value_bytes?}` | `:method`, `:path` in tooltips (only on the request-direction event type) |
| `parameters_set` (`transport:`, also matched `recovery:`/`http:`) `owner`, `max_packet_size` | `QPP:464-476` | `quic:parameters_set` `initiator`, `max_udp_payload_size` | "max receiving size client/server" labels (default 65527) |
| trace `vantage_point.type` | `QPP:24-29`, `D3R:246`, `:293-305` | trace `vantage_point.type` (vantage_point now optional) | flow label; local/remote naming; request-headers event type |
| `common_fields.protocol_type === "TCP_HTTP2"` | `D3R:119` | `connection.protocolHint === "TCP_HTTP2"` (custom common field written by our converter, else derived from `tcp`+`http2` namespaces) | TCP vs QUIC mode |
| all events (count) | `RND:68` | all events of the connection (any namespace, conforming or not) | > 10000 gives the N-PZ1 warning |
| event **order** (`getEvents()` array order); `time` is never read | `QPP:208`, `TPP:57` | `connection.events` order (stable sort by resolved time, data-model §3.16.7) | FIFO matching of H3 frames to STREAM bytes, TLS to TCP bytes, H2 to TLS bytes; colour alternation; `lowerLayerIndex` |

**TCP + TLS + HTTP/2 mode** (converter-defined private namespaces; field locations per converters §8.6.1 and §8.7)

| qvis (old) event / field | Read at | qvis-react (converter output) | Used for |
|---|---|---|---|
| TCP `transport:packet_sent/received` (type-only) | `TPP:15`, `:22`, `:62` | `tcp:packet_sent` / `tcp:packet_received` | TCP lane |
| TCP `data.header.payload_length` (`=== 0` skips the segment) | `TPP:64`, `:69`, `:91`, `:99` | `data.raw.payload_length` | TCP payload rect and the TCP payload FIFO; pure ACKs skipped |
| TCP `data.header.header_length` | `TPP:69`, `:77`, `:90`, `:99` | `data.header.header_length` (fallback `raw.length - raw.payload_length`) | TCP header rect |
| TLS `tls:record_created/parsed` (type-only) | `TPP:16`, `:23`, `:104` | `tls:record_created` / `tls:record_parsed` | TLS lane |
| TLS `data.header.header_length`, `trailer_length` | `TPP:107`, `:112`, `:165-166` | unchanged (`data.header.*`) | header and trailer pieces |
| TLS `data.header.payload_length` (`Math.max(0, …)`) | `TPP:106` | `data.raw.payload_length` | payload pieces |
| TLS `data.header.content_type` (`=== "application"` feeds the H2 FIFO) | `TPP:117`, `:141`, `:159`, `:172` | unchanged (`"handshake"`, `"alert"`, `"application"`, `"change-cipherspec"`, `"unknown"`) | `contentType`, tooltip, FIFO gating |
| TLS `data.header.DEBUG_wiresharkFrameNumber` | `TPP:127`, `:151`, `:182` | `data.capture_frame_number` | tooltip "Wireshark frame number (DEBUG)" |
| H2 `http2:frame_created/parsed` (type-only) | `TPP:17`, `:24`, `:194` | `http2:frame_created` / `http2:frame_parsed` | HTTP/2 and Stream IDs lanes |
| H2 `data.header_length` (`> 0`; 0 for magic) | `TPP:196-197`, `:212`, `:242` | `data.frame.raw.length - data.frame.raw.payload_length` | header pieces |
| H2 `data.payload_length` | `TPP:212`, `:246-247`, `:301`, `:306`; tooltip `:373` | `data.frame.raw.payload_length` | payload pieces, total size, tooltip "frame size" |
| H2 `data.content_type` (never set by the converter: always `undefined`) | `TPP:202`, `:224`, `:253`, `:276` | (none) | `contentType` of H2 and stream ranges (not displayed) |
| H2 `data.stream_id` (`-1` for magic) | `TPP:218-219`, `:270-271`, `:295`, `:319`; tooltips `:374`, `:381`, `:404`, `:411` | unchanged | stream lane, colour, request info, tooltip |
| H2 `data.frame.frame_type` (`data`, `headers`, `settings` special) | `TPP:294`, `:309`, `:317`; tooltip `:374` | unchanged | total size, warning exemption, request info, tooltip |
| H2 `data.frame.headers[] {name, value}` | `TPP:321`, `:386-391`, `:416-421` | unchanged (`{name?, value?}`) | `:method`, `:path` |
| H2 `data.frame.stream_end` | tooltips `TPP:376`, `:406` | unchanged | "STREAM END BIT SET" |
| trace `vantage_point.type` | `TPP:28-33` | unchanged (converter writes `"client"`) | request-headers event type, flow label |

Implementation-specific or legacy fields qvis wrote or read:

- written: `frame.frame_size`, `frame.header_size`, `frame.payload_size`, the injected filler with
  `qvis.sequence.hide`, `raw.length` (from `raw.data`). All FIX: never write.
- read: TLS `DEBUG_wiresharkFrameNumber` (converter-only; now `capture_frame_number`).
- not read although present in the source: `group.filename` (`CFG:152`, dead `selectAllConnections`),
  `connection.setupLookupTable()` (`D3R:60`, side effect only), the commented-out time-range code (`D3R:109-113`).

Events **not** consumed by the parity port (section 9.9 says which ones the port may optionally use):
`quic:udp_datagrams_sent/received`, `quic:udp_datagram_dropped`, `quic:stream_data_moved`, `quic:packet_lost`,
`quic:packet_dropped`, `quic:packet_buffered`, `quic:frames_created/parsed/processed` (D-PZ7), `quic:tuple_assigned`,
`quic:parameters_restored`, `http3:stream_type_set` (ENH-2), `http3:datagram_*`, `http3:priority_updated`,
`http:capsule_*`.

---

## 5. URL query parameters and global state

- **Query parameters:** none are read by this tool. Global parameters (`file`, `list`, `file1..N`, …) load files at
  startup and are sticky across navigation (app-shell §3.3, §3.5). They only matter here through the auto-selection of
  `groups[0]`'s first trace. There is no deep link to a specific trace or zoom state (PARITY).
- **Global state read:**
  - `ConnectionStore.groups` (selector options, auto-selection, alerts) and `outstandingRequestCount` (alerts).
  - `ConfigurationStore.packetizationDiagramConfig.connections` (selected trace, persisted across routes for the
    session; not persisted across reloads).
  - From the connection: events, `vantagePoint.type`, and (qvis) `commonFields.protocol_type`.
- **Global state written:** `packetizationDiagramConfig.connections` (selection), and, in qvis, the event objects
  themselves (Q-F1, Q-P2; FIX).
- **Window/document:** `pageX`/`pageY` for the tooltip, the shared `#packetization-packet-tooltip` element, the
  document-wide id `clip` (Q-R1), and `alert()` (FIX). No global listeners (no resize, no keyboard), nothing in
  `localStorage`.

---

## 6. Edge cases, error handling, notifications

### 6.1 Notifications (verbatim; group `"default"`, default 3000ms duration; rendering per app-shell §3.6/§8.4)

| ID (app-shell ID) | When | type | title | text |
|---|---|---|---|---|
| N-PZ1 (N20) | the selected trace has more than 10000 events (any type), on a selection change; then the render is delayed by 200ms | `warn` | `Trace might take long to render` | `Some large traces can take a long time to render. Please be patient.` |
| N-PZ2 (N21, N22) | a renderer's `render()` resolved `false` (busy). Shown once per failing renderer, so up to twice. **FIX:** also on an exception during render (Q-L1). | `error` | `Trace could not be rendered` | `This trace could not be rendered. There could be an error or a previous file was still rendering.<br/>See the JavaScript devtools for more information.` |
| N-PZ3 (**FIX**, new) | replaces the `extractRanges` `alert()`s, at most once per render. Suggested text, not in qvis. | `warn` | `Trace data inconsistent` | `Some frames could not be placed in the packetization diagram (not enough lower-layer bytes). See the JavaScript devtools for more information.` |

Note the `<br/>` in N-PZ2: it is a line break (app-shell §8.4 split rule).

**DECISION D-PZ3 (recommended: unify).** In qvis, N-PZ1 and N-PZ2 come only from the watcher path. The `mounted()`
re-render (returning to the tab) neither warns nor reports failure. Recommended: use the same path for both.

### 6.2 Blocking alerts in qvis (both FIX → console.error + N-PZ3)

- `"Remaining length < 0, CANNOT HAPPEN! " + remainingLength` (`MOD:187`)
- `"Trying to fill payloadranges that aren't there! " + remainingLength` (`MOD:197`)

### 6.3 Edge cases

| # | Situation | qvis behaviour | Port |
|---|---|---|---|
| E1 | No files loaded | Danger alert; no selector; two empty 200px blocks | PARITY |
| E2 | Files loading, none finished | Warning alert "Loading files..." | PARITY |
| E3 | Trace has no packets in a direction, or no packet has `raw` | Empty lanes, `xMax = 0`, a single axis tick "0" at `width/2`. "Bytes …", both "max receiving size" labels (default 65527) and the flow label all collapse to the center, overlapping (`xDomain` of `[0,0]` returns the midpoint). Efficiency is NaN and not shown. No message. | PARITY for geometry. **DECISION D-PZ4** (recommended, NEW): if lane 0 is empty, show a small centered note in the plot area: `No packets with raw.length found for this direction` (console + visual). Off by default to keep parity screenshots; §9.9 revisits this for latest-only input (recommended ON, three texts). |
| E4 | Packet without `header.packet_type` | Skipped with console.error | PARITY |
| E5 | `raw` without `length` but with `data` | Size = hex-char count (2x), event mutated | FIX (Q-P2) |
| E6 | `raw` without `length` and `data` | Skipped with console.error | PARITY |
| E7 | Packet shorter than 20 bytes and no `payload_length` | Negative payload size, so a negative-width rect (browser console error "A negative value is not valid"; nothing drawn). Header and trailer still drawn. | PARITY (optionally clamp the width at 0 to silence the console) |
| E8 | `frames: []` | Crash, then a stuck renderer (Q-L1) | FIX (Q-F5) |
| E9 | Frame without `frame_type` | Crash (Q-L1) | FIX (Q-F5) |
| E10 | Guessed frame sizes do not match | Yellow filler at payload start, or frames shifted left (negative offset) | PARITY |
| E11 | Guesstimate overshoot (`leftover < 0`) | Frames of that packet vanish (NaN); stream bytes lost | FIX (Q-F3) |
| E12 | H3 frame without a size | console.error, frame dropped, later frames on that stream misaligned | PARITY except numeric 0 (Q-H1) |
| E13 | Receiving: `frame_parsed` logged before the first STREAM bytes of its stream | Frame dropped | FIX (Q-H2) |
| E14 | Retransmissions / out-of-order data | Misaligned H3 frames, leftover bytes, console errors | PARITY (documented) |
| E15 | Unidirectional H3 streams | 1-byte shift from the stream-type byte; leftover tolerated for ids ≡ 2,3 (mod 4) | PARITY (ENH-2 optional) |
| E16 | Server push (H3 frames on server uni streams), or DATA on a stream without request info | console.error "…Potentially Server Push…"; tooltip without method/path | PARITY |
| E17 | Two HEADERS in the request direction on one stream (trailers) | First kept, console.error | PARITY |
| E18 | Vantage point `network` / `unknown` / absent | Empty flow label; `localname = "client"`; no request info (no `HTTPHeadersSentEventType`) | PARITY |
| E19 | More than 10000 events | N-PZ1 + 200ms delay, then a slow synchronous render | PARITY (§8.3 for the async variant) |
| E20 | A new selection while rendering / during the 200ms wait | Busy gives N-PZ2. During the 200ms window the flag is not set yet, so two renders can run back to back (both render the latest selection, because the config object is shared). | Latest-wins token, no N-PZ2 for superseded renders (§8.3) |
| E21 | Exception inside a render | Stuck `rendering` flag, no message | FIX (Q-L1) |
| E22 | Window resized | No relayout | PARITY. Optional: debounce-rerender on resize (zoom is lost anyway on any re-render) |
| E23 | Selected file removed in the File Manager | Diagram keeps showing the removed trace; the selector shows blank | FIX (app-shell Q11) |
| E24 | First group has zero connections | Auto-select sets `[undefined]`, then the renderer crashes on `connections[0].getEvents()` | FIX (app-shell Q12) |
| E25 | Very wide traces | Thin rects (< 1px) still drawn with ±0.3px padding, so long runs look solid. Zoom up to 2000x. | PARITY |
| E26 | Header/payload/stream values containing HTML (e.g. `:path`) | Injected unescaped into the tooltip (XSS) | FIX (Q-X1) |
| E27 | Vertical scrollbar appears or disappears after rendering | Width was measured before, so the svg may be wider than the container by the scrollbar width (horizontal page scroll) | PARITY. Optional: measure after layout (`requestAnimationFrame`) |
| E28 | `http3:frame_*` event without `data.frame` (draft-02: H3 event with `byte_length` but no `frame`) | Crash in `H3FrameTypeToNumber` (`QPP:68`), stuck renderer (Q-L1) | FIX: skipped with the Q-H1 message (§9.5.1) |
| E29 | Trace uses pre-final names (`transport:packet_sent`, `http:frame_created`; current quic-go) | Rendered normally (type-only matching) | No packet or H3 event matches: E3 geometry, DM3 toast from the loader, D-PZ4 text (1) when enabled (§9.1, §9.9) |
| E30 | `quic:packet_*` without `frames`, frames logged in `quic:frames_created` / `frames_parsed` with `packet_numbers` | n/a (draft-02 `frames_processed` was never read) | D-PZ7 (§9.9): frames taken from the frame events for 0RTT/1RTT packets |

### 6.4 Console diagnostics (verbatim message prefixes; keep them for debugging parity, collect them in `diagnostics`)

QUIC: `"PacketizationQUICPreProcessor: packet without header.packet_type set... ignoring"`,
`"PacketizationQUICPreProcessor: packet without raw.length set... ignoring"`,
`"PacketizationQUICPreProcessor: frame_sizes don't fill the entire packet payload!"`,
`"PacketizationQUICPreProcessor: qlog trace does not have frame_size fields set properly. We -guesstimate- them here, so exact frame sizes are expected to be off!"`
(once per process call),
`"PacketizationQUICPreProcessor: stream frame with no length attribute! skipping..."`,
`"PacketizationQUICPreProcessor: something went wrong calculating frame sizes!"`,
`"PacketizationQUICPreProcessor: payload is longer than payload! Shouldn't happen!"`,
`"H3 frame didn't have byte_length set! skipping..."` (qvis wording; the port prints the Q-H1 text
`"H3 frame didn't have a payload length (frame.raw.payload_length / frame.raw.length) set! skipping..."`),
`"No payload ranges known for this stream_id, skipping..."`,
`"PacketizationDiagram: trying to increase payload size sum, but streamID not yet known! Potentially Server Push (which we don't support yet)"`,
`"PacketizationQUICPreprocessor: HTTPStreamInfo already had an entry for this stream"`,
`"PacketizationQUICPreprocessor: Not all QUIC payload ranges were used up!"`,
`"PacketizationQUICPreprocessor: Not all HTTP3 frames found a home!"`,
`"QUIC payload size != HTTP3 payload size"`.
Models: `"Trying to extract ranges for size 0... potential error? Skipping..."` (warn),
`"Splitting a header range... server is being bad/naive?"` (warn),
`"PacketizationDiagram:extractRanges : Negative size after extracting ranges! Should not happen!"`.
TCP: the four `PacketizationTCPPreprocessor: …` messages in §3.7 and `"TLS payload size != HTTP payload size"`.
Drop: `"PacketizationPreProcessor: data seen on unidirectional stream: "` (wrong and noisy), and the plain `console.log`
traces (`"PacketizationDiagramD3Renderer:render"`, `"Rendering packetization diagram"`,
`"PacketizationDiagram: rendering data"`, configurator/renderer change logs).

---

## 7. Known bugs and quirks: PRESERVE or FIX

| ID | Quirk | Decision |
|---|---|---|
| Q-P1 | Explicit `raw.payload_length` treated as including the AEAD tag, so the trailer overlaps the next packet by 16 bytes and `xMax` is 16 too large | **FIX** (latest semantics, with the self-consistent fallback heuristic, §3.6.3) |
| Q-P2 | `raw.data` fallback uses the hex-char count and mutates the event | **FIX** (`/2`, no mutation) |
| Q-P3 | Fallback header length is always `min(4, total)`, for every packet type | **PRESERVE** |
| Q-P4 | 16-byte trailer added even for packet types without an AEAD tag (VN, stateless reset) | **PRESERVE** |
| Q-F1 | Mutates frames (`frame_size`/`header_size`/`payload_size`) and injects the filler into `data.frames`: leaks into the sequence diagram, stats and export; re-render differs | **FIX** (side arrays; the first-render picture is the reference) |
| Q-F2 | Explicit mode decided by `frames[0]` only, which can give a NaN layout | **FIX** (all frames) |
| Q-F3 | Guesstimate `leftover < 0` returns before the split, so the packet's frames vanish | **FIX** (§3.6.4) |
| Q-F4 | STREAM frame without length gives a NaN layout | **FIX** (treat as a non-STREAM frame) |
| Q-F5 | Empty `frames` / missing `frame_type` crash | **FIX** |
| Q-F6 | `otherFrameCount` counts STREAM frames; the MAX_STREAMS hack is overwritten; floor rounding. The result is the yellow filler. | **PRESERVE** (this is the visual qvis users know; the help text explains the yellow filler) |
| Q-F7 | Filler always at the start of the payload | **PRESERVE** |
| Q-F8 | Negative frame header sizes / negative offsets shift rects left, overlapping | **PRESERVE** |
| Q-H1 | H3 frame with payload length 0 (numeric) rejected | **FIX** |
| Q-H2 | Receiving direction drops H3 frames seen before their stream's first bytes | **FIX** (queue) |
| Q-H3 | DATA bytes on H3 stream 0 never counted in "total resource size" | **FIX** (H3 only) |
| Q-H4 | H3 frame type codes: `priority_update`/`origin` mapped to 0 | **FIX** (`h3FrameTypeNumber`) |
| Q-H5 | `lowerLayerIndex` in H3/H2/TLS tooltips is the global counter at processing time, not the true parent | **PRESERVE** (text parity) |
| Q-H6 | Stream-type varint on unidirectional streams ignored | **PRESERVE** (ENH-2 optional) |
| Q-H7 | STREAM offsets ignored (retransmissions, reordering) | **PRESERVE** |
| Q-H8 | `":method"`/`":path"` lookup keeps the last occurrence; missing gives `""` | **PRESERVE** |
| Q-T1 | Tooltip "Trailer (authentication tag)" for any 16-byte header | **PRESERVE** |
| Q-T2 | H2 tooltip omits the index; "frame size" is the payload length; TLS small-trailer labelled "Header" | **PRESERVE** |
| Q-X1 | Tooltip HTML built from trace values without escaping (XSS via `:path`, frame types, etc.) | **FIX (security):** HTML-escape every interpolated value; keep the literal `<br/>` and `<b>…</b>` markup produced by the format strings |
| Q-R1 | Both diagrams create `<clipPath id="clip">` (duplicate document ids; other views use `#clip` too). Works only because both clip rects are identical. | **FIX:** unique id per renderer instance (e.g. `packetization-clip-top`) |
| Q-R2 | Text `font-size: "14"` is invalid CSS and ignored, so 16px is inherited | **PRESERVE visual** (set 16px explicitly, verify in the harness) |
| Q-R3 | svg `font-family="Trebuchet-ms"` typo | **PRESERVE** (harmless) or drop |
| Q-R4 | Zoom attached to the main g, so wheel/drag only work over painted elements | **PRESERVE** |
| Q-R5 | No resize handling; width measured once | **PRESERVE** (optional rerender on resize) |
| Q-R6 | Labels overlap on narrow screens (the local "max receiving size" text starts at `width - 450`) or with empty data (E3) | **PRESERVE** |
| Q-R7 | Stale scale-extent comment "x0.5 … x50" | n/a |
| Q-L1 | Exception leaves `rendering = true` forever | **FIX** (`try/finally` + N-PZ2) |
| Q-L2 | `extractRanges` uses blocking `alert()` (possible alert storm) | **FIX** (console + N-PZ3 once) |
| Q-L3 | N-PZ1/N-PZ2 not emitted on the mount path | **DECISION D-PZ3:** unify |
| Q-M1 | Info modal toggle flag desynchronises when closed via × / ESC / backdrop | **FIX** |
| Q-M2 | Help text names draft-02 fields | **DECISION D-PZ1:** update the three bullets |
| Q-C1 | Dead code: `collapsed` config, "Load all connections" button, `allowSelectAll`, `selectAllConnections`, `holblockinfo` | Do not port (keep `collapsed: true` in the config type only if the config store schema wants parity) |
| Q-C2 | Odd stream IDs logged as "unidirectional" | Drop the log |

---

## 8. Porting notes for React

### 8.1 Module breakdown (fits ARCHITECTURE §2)

```
src/components/packetizationdiagram/
  PacketizationDiagramContainer.tsx      <div className="home"> <Configurator/> <Renderer/> ; reads config from configurationStore
  PacketizationDiagramConfigurator.tsx   intro row, <ConnectionConfigurator/>, info button, <NoTraceAlerts/>, <PacketizationInfoModal/>; auto-select effect
  PacketizationInfoModal.tsx             react-bootstrap <Modal size="xl" show onHide> with the §2.3 body (effective DOM) + "Close"
  PacketizationDiagramRenderer.tsx       the two container divs + tooltip div (ids kept); owns 2 D3 renderer instances via refs
  PacketizationDiagram.css               scoped CSS ported: .row padding, .btn margin (scope under a wrapper class)
  data/PacketizationDiagramConfig.ts     { collapsed: true, connections: QlogConnection[] }
  renderer/PacketizationDiagramModels.ts PacketizationDirection, PacketizationRange, PacketizationLane, LightweightRange,
                                         VLIELength, extractRanges (pure; reports instead of alert)
  renderer/quicFrameSizes.ts             frameDataLength, frameWireLength, dataFrameHeaderLength, sizeFrames() (port of
                                         backfillFrameSizes without mutation, returns {sized[], offset})
  renderer/PacketizationQUICPreProcessor.ts  process(connection, direction) -> { lanes, diagnostics }
  renderer/PacketizationTCPPreProcessor.ts   process(connection, direction) -> { lanes, diagnostics }
  renderer/tooltips.ts                   all rangeToString functions (escape helper inside)
  renderer/PacketizationDiagramD3Renderer.ts imperative class (D3 v7), see 8.2
  renderer/*.test.ts
src/views/PacketizationView.tsx          thin wrapper (<div><PacketizationDiagramContainer/></div>)
```

`PacketizationDiagramDataHelper` becomes a direct import of `lib/colorHelper.ts` (`StreamIDToColor`).
`h3FrameTypeNumber`, `h3FramePayloadLength`, `fieldName`/`fieldValue` and `toNum` come from the shared qlog helpers
(`src/qlog/schema/h3.ts` / `src/qlog/uint64.ts`), not re-implemented here.

### 8.2 D3 renderer class (keep imperative; port line by line)

```ts
export class PacketizationDiagramD3Renderer {
    constructor(container: HTMLElement, tooltip: HTMLElement, clipId: string) {}
    render(connection: QlogConnection, direction: PacketizationDirection): boolean   // synchronous; throws on bug (caller catches)
    dispose(): void                       // remove the svg, interrupt tooltip transitions, `.on(".zoom", null)`
}
```

- Keep every constant and formula in §2.5/§3.8-3.10 verbatim: margins, 100px plot height, 25px lanes, 0.40/0.60
  header geometry, 0.6 stream lane, 0.3px side padding, label offsets (-5, `/1.75`, -10, `height + margin.bottom - 10`,
  `-450`), and the tooltip offsets (+15, -75).
- Use `selection.html()` for the tooltip (the content is already escaped).
- The preprocessors must be pure and DOM-free, so they can be unit-tested and later moved into a worker.

### 8.3 React wrapper behaviour

```tsx
// PacketizationDiagramRenderer.tsx (sketch)
const topRef = useRef<HTMLDivElement>(null), bottomRef = useRef<HTMLDivElement>(null), tipRef = useRef<HTMLDivElement>(null);
const renderers = useRef<{top?: R; bottom?: R}>({});
const connection = config.connections[0];
useEffect(() => {                       // create once
  renderers.current = { top: new R(topRef.current!, tipRef.current!, "packetization-clip-top"),
                        bottom: new R(bottomRef.current!, tipRef.current!, "packetization-clip-bottom") };
  return () => { renderers.current.top?.dispose(); renderers.current.bottom?.dispose(); };
}, []);
useEffect(() => {                       // render on mount and on connection identity change
  if (!connection) return;
  let cancelled = false;
  (async () => {
    if (connection.getEvents().length > 10000) { notify(N_PZ1); await sleep(200); if (cancelled) return; }
    for (const [r, dir] of [[renderers.current.top, receiving], [renderers.current.bottom, sending]] as const) {
      try { r!.render(connection, dir); }
      catch (e) { console.error(e); notify(N_PZ2); }
    }
  })();
  return () => { cancelled = true; };
}, [connection /* identity */, groupsVersion /* only if connection objects can be mutated in place */]);
```

- No `rendering` flag is needed: `render` is synchronous and superseded async runs are cancelled. N-PZ2 is therefore
  only shown for exceptions (Q-L1). The "busy" case cannot happen.
- React 19 StrictMode double-invokes effects in development. The create/dispose pair above handles it.
- The tooltip div stays a sibling below both diagrams (DOM parity). Its inline styles are set by the renderer
  (`opacity 0`, absolute, `padding 5px`, `pointer-events none`, `lightsteelblue`).
- Optional (not parity): cache `{lanes}` per `(connection, direction)` in a `WeakMap`. This is safe now that events
  are not mutated, and it makes tab switching instant for large traces.

### 8.4 D3 v5 → v7 specifics for this view

- Event handlers: `.on("mouseover", (event, d) => mouseOver(lane.rangeToString, d, event))`, using `event.pageX`/`pageY`.
  `.on("mouseout", () => mouseOut())`.
- Zoom: `.on("zoom", (event) => { const newX = event.transform.rescaleX(xDomain); … })`.
- d3-zoom v3 changed the defaults: it now **accepts ctrl+wheel** and multiplies the wheel delta by 10 when ctrl is
  held. For parity set:
  ```ts
  zoom.filter((event) => !event.ctrlKey && !event.button)
      .wheelDelta((event) => -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002));
  ```
- d3-axis v3 uses `offset = devicePixelRatio > 1 ? 0 : 0.5`; v1 always used 0.5. For pixel parity on HiDPI screens call
  `.offset(0.5)` on both axis constructions, or accept the sharper lines.
- `append("SVG:clipPath")` → `append("clipPath")` (same result).
- `d3.scaleLinear().domain([0,0])` still maps to the range midpoint in v7 (E3 geometry unchanged).

### 8.5 Latest-draft QUIC preprocessor: consolidated pseudo-code (normative for the port)

```ts
function processQUIC(conn, direction): { lanes: PacketizationLane[]; diagnostics: string[] } {
  const PKT = direction === sending ? "quic:packet_sent" : "quic:packet_received";
  const H3  = direction === sending ? "http3:frame_created" : "http3:frame_parsed";
  const vp = conn.vantagePoint?.type;
  const REQ = vp === "server" ? "http3:frame_parsed" : vp === "client" ? "http3:frame_created" : undefined;
  // state exactly as §3.6.2
  for (const ev of conn.getEvents()) {               // name = full "ns:type", data = ev.data
    if (ev.name === PKT) {
      const d = ev.data; if (!d.raw) continue;
      if (!d.header?.packet_type) { diag(...); continue; }
      const total = toNum(d.raw.length) || (typeof d.raw.data === "string" ? d.raw.data.length / 2 : undefined); // Q-P2; `||` mirrors qvis' truthiness test
      if (!total) { diag("PacketizationQUICPreProcessor: packet without raw.length set... ignoring"); continue; }
      let { header, payload } = splitPacket(total, toNum(d.raw.payload_length));                               // Q-P1 / Q-P3
      push3PacketRanges(...);                                                                                   // §3.6.3 step 5
      // D-PZ7 (§9.9): when d.frames is ABSENT (not empty), use conn.framesForPacket(dir, pnSpace, pn) instead
      if (Array.isArray(d.frames) && d.frames.length > 0) {                                                     // Q-F5
        const { sized, offset } = sizeFrames(payload, d.frames);                                                // §3.6.4/§3.6.5, no mutation
        const list = offset !== 0 ? [filler(offset), ...sized] : sized;
        layoutFrames(list, QUICmax + header);       // §3.6.4 layout loop; STREAM bytes -> per-stream ranges -> processHTTP3Frames
      }
      QUICmax += total; ++QUICPacketIndex; QUICtotalSize += total;
    } else if (ev.name === H3) {
      const pl = h3FramePayloadLength(ev.data.frame);
      if (pl === undefined) { diag(...); continue; }                                                            // Q-H1
      queue(ev.data, pl); if (rangesExist(ev.data.stream_id)) processHTTP3Frames(...);                         // Q-H2: always queue
    }
    if (REQ && ev.name === REQ && ev.data?.frame?.frame_type === "headers") recordRequest(ev.data);            // §3.6.8
    if (ev.name === "quic:parameters_set") recordMaxSize(ev.data.initiator, toNum(ev.data.max_udp_payload_size));
  }
  endChecks(); return { lanes: assembleLanes(), diagnostics };
}
```

`splitPacket(total, pl)`: if `pl` is truthy, then `payload = pl; header = total - pl - 16`; if `header < 1`, then
`payload = pl - 16; header = total - pl` (warn once). Otherwise `header = Math.min(4,total);
payload = total - header - 16`. The trailer is always `{start: QUICmax + header + payload, size: 16}`.

### 8.6 TCP preprocessor port

A near line-by-line port of §3.7, with the namespace-qualified names and the field locations of §9.7 (converters
§8.7: sizes come from `raw.payload_length` / `frame.raw.*`, the frame number from `capture_frame_number`). The TCP-mode
inputs are produced by our own converter, so they never need the QUIC/HTTP/3 accessors. Apply only the shared fixes: no
`alert`, escaping, no event mutation (TPP mutates nothing), diagnostics list.

### 8.7 Tests (Vitest, `renderer/*.test.ts`)

- `VLIELength` boundaries: 0, 63, 64, 16383, 16384, 1073741823, 1073741824 → 1,1,2,2,4,4,8.
- `extractRanges`: whole consumption; split with the remainder put back at the front (assert the identity/mutation
  semantics); size 0 (warn, `[]`); insufficient bytes (reported, not alert).
- `sizeFrames` guesstimate vector from §3.6.11 (filler 12, ACK 11, STREAM 1/1200); explicit vector (all `raw.length`
  present, offset 0); negative-offset vector; MAX_STREAMS vector (offset < 0); Q-F3/Q-F4/Q-F5 cases. **Assert that
  the input events are deep-equal before and after** (Q-F1).
- `splitPacket`: latest semantics, legacy-including-tag heuristic, fallback, tiny packet.
- `h3FrameTypeNumber` / header length incl. `priority_update` (4-byte varint) and `raw.length - raw.payload_length`
  shortcut.
- QUIC preprocessor on `tests/fixtures/latest/*` (client and server): `xMax === Σ raw.length` of the direction's
  packets with `raw`; lane 0 has `3 × packets` ranges; colors alternate; every H3 frame is placed (no "found a home"
  diagnostics) on a clean fixture; `efficiency` within (0,1]; stream 0 `total_size` > 0 (Q-H3).
- Tooltip strings byte-exact for each lane, including the filler, `FIN BIT SET`, STREAMINFO, and escaping
  (`:path = "<img src=x>"` renders as text).
- TCP preprocessor on a converted tshark fixture, if the converter is available.
- Renderer (jsdom) smoke test: four label texts; `.quicpacket` rect count; the "Bytes received"/"Bytes sent" texts; the
  flow label for a client trace; unique clip ids; the max-size label texts with the 65527 default.
- Playwright: load a demo, go to `#/packetization`, check that both svgs exist, hover a rect and see the tooltip
  become visible with the expected first line, wheel-zoom changes the axis tick labels, and there are no console errors
  other than the known diagnostic prefixes in §6.4.

### 8.8 Parity harness notes

Compare against hosted qvis with the legacy fixture (`tests/fixtures/legacy/*.draft02.qlog`) that corresponds to a
`public/examples/*` latest file:

- Q-P1, Q-H3, Q-H4 and D-PZ2 change geometry slightly versus qvis. Expected differences: no 16-byte packet overlap,
  exact STREAM headers in all-sized packets, stream 0 totals. Record them as known deltas.
- Fonts: confirm the 16px label size (Q-R2) and Trebuchet MS availability on the CI machine; otherwise compare on
  macOS.
- The first-render picture of qvis is the reference (qvis re-renders differ, Q-F1).

---

## 9. Mapping to latest qlog drafts

This section maps every old-schema (qlog draft-02 / `qlog_version` "0.3") event, field and name check that this view
consumes (section 4) to the latest drafts, and lists what the latest drafts add that this view could show:

- draft-ietf-quic-qlog-main-schema-14 (digest `qlog-spec/main-schema.md`; RawInfo §16, truncation §17.4, uint64 §17.3),
- draft-ietf-quic-qlog-quic-events-13 (digest `qlog-spec/quic-events.md`; packets §4.5-4.6, frames §8, sizes §11,
  draft-02 diff §13),
- draft-ietf-quic-qlog-h3-events-13 (digest `qlog-spec/h3-events.md`; frames §4.2, helpers §8.1, draft-02 diff §10,
  this view §10.6.5),
- the editor's copies where they do not conflict (ARCHITECTURE §0),
- the converter contract for TCP mode (`parity/converters.md` §8.6-8.7).

Tags as in the legend, plus **NONE** (no equivalent in the latest drafts; the row gives the behaviour) and **ENH**
(optional enhancement, default OFF, not parity).

### 9.1 Ground rules for this view (normative)

1. **Exact names, no aliasing** (ARCHITECTURE §0 and §3.1, data-model §9.1). Matching is on the full logged name
   against `src/model/names.ts` constants. qvis matched the type part only (`QPP:13-29`, `:213`, `:408`, `:464`). A
   file that still uses pre-final names, for example current quic-go output (`file_schema` plus
   `transport:packet_sent`, `transport:parameters_set`; its `http3:frame_*` names are already final), loads, but this
   view finds **no packets**: both diagrams show the empty-lane geometry of E3, and the loader's DM3 toast explains why
   (E29, D-PZ4 revisited in §9.9). This is deliberate (user direction: latest drafts only), not a bug.
2. **No data fix-ups.** The model never rewrites `data` (`data === raw.data`), and neither does this view (Q-F1, Q-P2).
   Legacy members such as `header.packet_size`, `header.payload_length`, `frame_size`, H3 `byte_length` are **not**
   read (the model raises `event.legacy-field` for some of them, data-model §9.6). The only legacy read kept is the
   top-level STREAM/CRYPTO/DATAGRAM `length` at the end of the `frameDataLength` chain (§3.6.5): it is a read-side
   tolerance that costs nothing and changes nothing for conforming input.
3. **uint64.** `toNum` in this spec is `toNumber()` from `src/qlog/uint64.ts` (number passthrough, decimal string to
   number, anything else `undefined`; the h3 digest calls it `u64()`). Map keys keep qvis's `"" + id` form, which
   already unifies `4` and `"4"` (mvfst writes STREAM `stream_id` as a JSON string). `HTTPStreamInfo` keeps
   `parseInt(id, 10)`. Tooltips print the value as logged (`String(v)`).
4. **Accessor ownership and three traps in the ecosystem digest.**
   - Shared, from `src/qlog/schema/h3.ts`: `h3FramePayloadLength`, `h3FrameTypeNumber`, `vlieLength`,
     `fieldName`, `fieldValue` (h3 digest §8.1). Use them unchanged.
   - Local to this view, in `renderer/quicFrameSizes.ts`: `frameDataLength`, `frameWireLength`,
     `dataFrameHeaderLength`, `hexByteLength`, `sizeFrames` (§3.6.5). **Do not** substitute the ecosystem digest's
     shared `frameWireLength(f) = f.raw?.length ?? f.frame_size` (ecosystem §6.6): for STREAM, CRYPTO and DATAGRAM
     frames quic-events-13 puts the **data** length in `raw.length` (§8.7, §8.9, §8.23 of the digest, and the
     `frames_*` example at -13:1663-1674), so that helper would size every STREAM frame without its header.
     Name the local helper `pzFrameWireLength` if a shared helper with the same name exists.
   - **Do not** use the ecosystem digest's `packetLength(evData)` (`raw?.length ?? header?.packet_size ?? packet_size
     ?? header?.length`). `header.length` is the long-header Length field (packet number + payload), not the packet
     size (quic digest §11; removed in the editor's copy), and the other two are legacy. This view reads
     `raw.length`, then `raw.data`, nothing else.
   - The ecosystem digest's shim "`http3:frame_*` `data.byte_length` → `data.frame.raw.length`" (ecosystem §6.5) is
     wrong: `byte_length` was the H3 frame **payload** length (h3 digest §10.3.3), so it would map to
     `raw.payload_length`. It is moot because no shims are applied (rule 2); do not implement it.
5. **Absence is normal.** Every row below says what happens when the member is absent. Nothing in this view may
   throw on a missing member; the exceptions qvis had (Q-F5, E28) are FIX.
6. **Editor's-copy points that touch this view:** the AEAD trailer applies only to protected packet types (§9.3.1);
   `PacketHeader.length` is removed (never used here anyway); `datagram_id` becomes `datagram_payload_checksum`
   (ENH-3 only); `quic:frames_processed` is removed (D-PZ7 accepts it); `HTTP3OriginFrame` gains `raw` (accept it).

### 9.2 Event names

| # | qvis match (sites) | Latest full name | Role in this view | Notes | Tag |
|---|---|---|---|---|---|
| EV1 | type `packet_received`, any category (`QPP:13`, `:213`) | `quic:packet_received` | top diagram, lanes 0-1, STREAM bytes for lane 2 | `trigger: "keys_available"` marks a packet already reported by `quic:packet_buffered`; only `packet_received` is read, so it is counted once | PARITY |
| EV2 | type `packet_sent` (`QPP:18-19`, `:213`) | `quic:packet_sent` | bottom diagram, lanes 0-1 | | PARITY |
| EV3 | type `frame_parsed`, any category (`QPP:14`, `:408`; request info for server traces `QPP:24-25`, `:452`) | `http3:frame_parsed` | top H3/stream lanes; request info when `vantage_point.type === "server"` | `http:frame_parsed` (pre-final HTTP/3 category) is not matched: in the latest drafts `http` is the Capsule namespace | PARITY |
| EV4 | type `frame_created` (`QPP:19-20`, `:408`; request info for client traces `QPP:27-28`, `:452`) | `http3:frame_created` | bottom H3/stream lanes; request info when `vantage_point.type === "client"` | | PARITY |
| EV5 | type `parameters_set`, any category: `transport:`, `recovery:`, `http:` (`QPP:464`) | `quic:parameters_set` only | "max receiving size" labels | `quic:recovery_parameters_set` and `http3:parameters_set` are separate names now and are not matched (FIX, data-model §9.8; harmless in qvis because they never had `max_packet_size`) | FIX |
| EV6 | TCP types `packet_*`, `record_*`, `frame_*` (`TPP:15-33`) | `tcp:packet_*`, `tls:record_*`, `http2:frame_*` | TCP mode lanes | private converter namespaces (converters §8.6.1); never flagged by DM3 | PARITY |
| EV7 | (none) | `quic:frames_created` (sent), `quic:frames_parsed` and `quic:frames_processed` (received) | frame lane for packets logged without `frames` | D-PZ7, §9.9 | NEW |
| EV8 | (all events) `getEvents().length` (`RND:68`) | all events of the connection | N-PZ1 threshold | counts every namespace, including non-conforming and custom events (same as qvis) | PARITY |

Names that are **not** matched and what that means here: `transport:packet_*` (quic-go today, ngtcp2-era files are
rejected earlier), `http:frame_*` and `h3:frame_*` (pre-final HTTP/3), `quic:datagrams_*` (quiche; irrelevant here),
`transport:parameters_set` (quic-go: the max-size labels keep 65527). None of them has a fallback.

### 9.3 QUIC packet events (`quic:packet_sent`, `quic:packet_received`)

| Old path (qvis) | Latest path | Semantic differences | When absent or invalid | Tag |
|---|---|---|---|---|
| `data.raw` (presence, `QPP:217`) | `data.raw` (`? raw: RawInfo`) | same object; all members optional | absent: packet skipped silently, no lane entries, no frames, no STREAM bytes (PARITY; D-PZ4 explains an all-empty direction) | PARITY |
| `data.header`, `data.header.packet_type` (`QPP:221`) | `data.header` (required) `.packet_type` (`$PacketType`) | same values and casing (`0RTT`, `1RTT`); new: `packet_type_bytes` with `unknown` (not shown) | missing: `console.error("PacketizationQUICPreProcessor: packet without header.packet_type set... ignoring")`, skipped | PARITY |
| `data.raw.length` (`QPP:226`, `:236`; `parseInt("" + x)`) | `data.raw.length` (uint64, number or string) | **full packet size: header + payload + 16-byte AEAD tag** (quic-13 §1.2; main-14 RawInfo). Ambiguity for long-header packets in §9.3.2 | absent or 0: use `hexByteLength(raw.data)`; still nothing: `console.error("… packet without raw.length set... ignoring")`, skipped | PARITY |
| `data.raw.data` (`QPP:227-228`) | `data.raw.data` (hexstring, possibly truncated) | main-14 §11.4: without `length` the data is the complete entity, so length = hex chars / 2. With `length` present, `data` may be truncated and is ignored | no data: see the previous row | FIX (Q-P2) |
| `data.raw.payload_length` (`QPP:238`, `:244`; treated as **including** the tag) | `data.raw.payload_length` (uint64) | **excludes header and trailer**. `header = raw.length - raw.payload_length - 16`, `payload = raw.payload_length` (Q-P1, `splitPacket` §8.5). quic-go writes exactly this (ecosystem §3.1) | absent or 0: fallback `header = min(4, total)`, `payload = total - header - 16` (PARITY, Q-P3) | FIX (Q-P1) |
| `data.header.packet_number` (tooltip `QPP:541`) | `data.header.packet_number` (uint64, **optional**) | never present on `retry`, `version_negotiation`, `stateless_reset`; optional even where it exists | tooltip prints `Packet nr : undefined` (PARITY) | PARITY |
| `data.frames` (`QPP:305`) | `data.frames` (`? frames: [* $QuicFrame]`) | may be absent because the producer logs frames separately (`quic:frames_created`/`frames_parsed` with `packet_numbers`, quic-13 §5.14) | absent: D-PZ7 lookup (§9.9), else no frame lane for the packet. `[]`: no frame lane (Q-F5) | PARITY + NEW |
| `is_coalesced` (draft-02; never read by qvis) | (none) | coalescing is now `datagram_id` (-13) / `datagram_payload_checksum` (editor's copy) | not read; ENH-3 | NONE |
| `header.packet_size`, `header.payload_length`, top-level `data.packet_type` (draft-01, moved by qvis' loader `QlogLoaderV2.ts:198-240`) | (none) | not part of -13 | not read: a packet that only has `header.packet_size` has no `raw` and is skipped (the model reports `event.legacy-field`) | NONE |
| (none) | `data.header.length` (-13 only: long-header Length field) | packet number + payload, **not** the packet size; removed in the editor's copy | never read | n/a |
| (none) | `datagram_id` / `datagram_payload_checksum`, `trigger`, `is_mtu_probe_packet`, `supported_versions`, `stateless_reset_token`, top-level event `tuple` | new members | not read by the parity port (ENH-3, ENH-5, ENH-9) | NEW |

#### 9.3.1 The 16-byte trailer per packet type

quic-events-13 §1.2 makes the AEAD tag a 16-byte trailer "for the purposes of calculating the lengths in fields of
type RawInfo related to QUIC packets". The editor's copy narrows it to protected packets (Initial, 0-RTT, Handshake,
1-RTT). qvis always draws a 16-byte trailer (Q-P4, PRESERVE). On the wire that is harmless for two of the three
unprotected types: a Retry ends with a 16-byte Retry Integrity Tag and a Stateless Reset ends with a 16-byte token,
so a 16-byte tail rect is visually right. Only Version Negotiation has no tail. Rule for the port: keep Q-P4 on the
fallback path (no `payload_length`). With an explicit `payload_length` on a `version_negotiation` packet (not seen in
the wild), use `header = total - pl` and omit the trailer range (two lane-0 ranges for that packet; a size-0 range
would still paint a 0.6px sliver because of the side padding). Known delta, no visual change for real traces.

#### 9.3.2 `raw.length` on long-header packets (spec ambiguity)

-13 §8.8 and the editor's copy both say that for `initial`, `handshake` and `0RTT` packets "the length field of the
packet header is logged in the qlog raw.length field, and the value signifies the length of the packet number plus
the payload". That contradicts main-14 RawInfo (`length` = full entity) and every producer surveyed (quic-go,
quiche, mvfst, the netlog converter log the full packet size). Rule: **treat `raw.length` as the full packet size
for every packet type** (quic digest §11, ambiguity 1). If a producer followed the literal sentence, its long-header
packets would be drawn without the long-header bytes before the packet number (with an explicit `payload_length` the
header rect shrinks to the packet-number length, 1-4 bytes). The layout stays self-consistent and no warning fires;
no further handling.

### 9.4 QUIC frames (inside `data.frames`)

#### 9.4.1 Members read on every frame

| Old path (qvis) | Latest path | Semantic differences | When absent or invalid | Tag |
|---|---|---|---|---|
| `frame.frame_type` | `frame.frame_type` (`$QuicFrame` is an open map: any string is legal) | renamed types: `unknown_frame_type` → `unknown`, `application_close` → `connection_close` (`error_space: "application"`); new: `reset_stream_at`, `handshake_done`, `datagram`, extension types (`ack_frequency`, `immediate_ack`, …) | missing: treat as `"unknown"` (Q-F5); the tooltip prints `unknown` | PARITY + FIX |
| filler detection `frame_type.indexOf("qvis") >= 0` (`QPP:335`, `:341`, `:396`) | (none) | a real latest-draft frame type may contain `qvis`; the filler is a qvis artefact | use the explicit `isFiller` flag of the side array (§3.6.4 Q-F1 fix); never test the string | FIX |
| `frame.frame_size` (`QPP:617-621`) | `frameWireLength(frame)` (§3.6.5) | never standardised. Latest: `raw.length` = full frame size for every type except STREAM/CRYPTO/DATAGRAM (data length) and PADDING (`raw.payload_length` = byte count = wire size) | `undefined` for any frame: guesstimate mode for the whole packet (Q-F2 fix) | NEW |
| `frame.length` (`QPP:645-646`, `:687-689`) | `frameDataLength(frame)` (§3.6.5, per-type table below) | draft-02 `length` was the data length of STREAM/CRYPTO, the token length of NEW_TOKEN, the CID length of NEW_CONNECTION_ID; the latest drafts spread these over `raw.*`, `token.raw.*`, `connection_id_length` | `undefined` or 0: header-only frame, no payload rect, no STREAM bytes; a STREAM frame without it is Q-F4 | PARITY |
| `frame.stream_id` (`QPP:371-387`, tooltip `:549`) | `frame.stream_id` (uint64, required on stream-related types) | may be a JSON string (mvfst) | STREAM without it: bytes go to key `"undefined"` and never match an H3 frame (PARITY); tooltip prints `none` | PARITY |
| `frame.fin` (tooltip `QPP:550`) | `frame.fin` (`bool .default false`) | quiche writes it only when true | absent = false, no "FIN BIT SET" | PARITY |
| `frame.offset` (not read by qvis) | `frame.offset` (`uint64 .default 0`; required on CRYPTO) | used only by `dataFrameHeaderLength` (OFF bit present iff offset > 0) | absent = 0 | NEW |
| (none) | `frame.raw.data` | possibly truncated frame bytes | not read (the frame size never comes from `raw.data`: for STREAM it would mix the data-length and full-entity meanings) | n/a |

#### 9.4.2 Per frame type

`dataLen` = `frameDataLength`, `wire` = `frameWireLength`, "other" = the guesstimate-mode "non-STREAM frame" rule
(§3.6.4: shares the leftover bytes, header-only unless `dataLen` is truthy). Every type in the "tooltip stream ID"
column prints `stream ID: <id>` because it has a `stream_id` key (qvis printed it for any frame with the key).

| Latest `frame_type` | qvis / draft-02 name | `dataLen` | `wire` | Guesstimate role | Feeds H3 lane | Tooltip stream ID | Notes | Tag |
|---|---|---|---|---|---|---|---|---|
| `padding` | `padding` | `undefined` (header-only) | `raw.payload_length ?? raw.length` | other | no | no | one frame per packet (-13 §8.13.1); quic-go logs none, so its padding bytes become filler | PARITY |
| `ping` | `ping` | — | `raw.length` | other | no | no | 1 byte on the wire (ENH-1) | PARITY |
| `ack` | `ack` | — | `raw.length` | other | no | no | `ack_delay` (ms), `acked_ranges`, `ect0/ect1/ce` not read; quic-go and quiche log no `raw` on ACK (ecosystem §3.1-3.2), so their packets with an ACK use guesstimate mode | PARITY |
| `reset_stream` | `reset_stream` | — | `raw.length` | other | no | yes | `error`/`error_code` renamed (not read) | PARITY |
| `reset_stream_at` | (none) | — | `raw.length` | other | no | yes | new (draft-ietf-quic-reliable-stream-reset); `reliable_size`, `final_size` not read | NEW |
| `stop_sending` | `stop_sending` | — | `raw.length` | other | no | yes | | PARITY |
| `crypto` | `crypto` | `raw.payload_length ?? raw.length ?? length` | `raw.length` if `> raw.payload_length`, else `1 + VLIE(offset) + VLIE(dataLen) + dataLen` | other (QUIRK: negative header, §3.6.4) | no | no | `raw` is REQUIRED and `raw.length` MUST be the Length field (-13 §8.13.7) | PARITY + NEW |
| `new_token` | `new_token` (`length`, hex `token`) | `token.raw.length ?? hexByteLength(token.raw.data)` | `raw.length` | other | no | no | token is now a `Token` object `{type?, details?, raw?}`; quic-go writes `{raw:{data}}` | PARITY |
| `stream` | `stream` | `raw.payload_length ?? raw.length ?? length` | `raw.length` if `> raw.payload_length`, else `1 + VLIE(stream_id) + (offset > 0 ? VLIE(offset) : 0) + VLIE(dataLen) + dataLen` (§9.4.3 for a missing Length field) | STREAM rule: `1 + dataLen` (PARITY) | **yes** (payload bytes, FIFO per `"" + stream_id`) | yes | `raw.length` MUST be the Length field when present (-13 §8.13.9); quiche: `raw.payload_length`; mvfst: `raw.length`; quic-go: top-level `length` | PARITY + NEW |
| `max_data` | `max_data` | — | `raw.length` | other | no | no | | PARITY |
| `max_stream_data` | `max_stream_data` | — | `raw.length` | other | no | yes | | PARITY |
| `max_streams` | `max_streams` | — | `raw.length` | MAX_STREAMS hack (`1 + 4`, then overwritten, Q-F6) | no | no | `stream_type` not read | PARITY |
| `data_blocked` | `data_blocked` | — | `raw.length` | other | no | no | | PARITY |
| `stream_data_blocked` | `stream_data_blocked` | — | `raw.length` | other | no | yes | | PARITY |
| `streams_blocked` | `streams_blocked` | — | `raw.length` | other | no | no | | PARITY |
| `new_connection_id` | `new_connection_id` (`length`, `reset_token`) | `connection_id_length ?? hexByteLength(connection_id)` | `raw.length` | other | no | no | `length` → `connection_id_length` (optional, "mainly used … for privacy"), `reset_token` → `stateless_reset_token`. Without the hex fallback every NCID would lose the payload rect qvis drew from the required draft-02 `length` | PARITY |
| `retire_connection_id` | `retire_connection_id` | — | `raw.length` | other | no | no | | PARITY |
| `path_challenge`, `path_response` | same | — | `raw.length` | other | no | no | 8-byte `data` (not read) | PARITY |
| `connection_close` | `connection_close`, `application_close` | — | `raw.length` | other | no | no | `application_close` merged (`error_space: "application"`); tooltip shows `connection_close` | PARITY |
| `handshake_done` | (none in qvis' schema) | — | `raw.length` | other | no | no | 1 byte on the wire | NEW |
| `unknown` | `unknown_frame_type` (`raw_frame_type`) | — | `raw.length` | other | no | no | `frame_type_bytes` (not read) | PARITY |
| `datagram` | (none) | `raw.payload_length ?? raw.length ?? length` | `raw.length` if `> raw.payload_length`, else `1 + VLIE(dataLen) + dataLen` (§9.4.3) | other, like CRYPTO (D-PZ8) | no (ENH-6) | no | RFC 9221; Length field in `raw.length` when present (-13 §8.13.23) | NEW |
| any other string (`ack_frequency`, `immediate_ack`, WebTransport, …) | (none) | — | `raw.length` | other | no | if it has `stream_id` | rendered like any frame, tooltip shows the string | NEW |

#### 9.4.3 LEN-bit inference for the last data frame (refines D-PZ2, NEW, recommended ON)

`dataFrameHeaderLength` assumes the Length field is present. RFC 9000 §19.8 lets the last STREAM frame of a packet
omit it (LEN bit 0, the data runs to the end of the packet), and RFC 9221 §4 does the same for DATAGRAM (type 0x30).
Implementations do this routinely for full packets. The computed wire size is then too large by exactly
`VLIE(dataLen)` bytes, the explicit-mode offset is negative, and every frame of the packet shifts left (Q-F8). Rule,
applied in `sizeFrames` after the explicit-mode sum:

```ts
if (mode === "explicit" && offset < 0) {
    const last = sized[sized.length - 1];                       // last real frame of the packet
    if (last.headerComputed                                     // size came from dataFrameHeaderLength, not raw.length
        && (last.frame.frame_type === "stream" || last.frame.frame_type === "datagram")
        && -offset === VLIELength(last.payload_size)) {
        last.header_size -= -offset;                            // the frame had no Length field
        offset = 0;
    }
}
```

`sizeFrames` therefore records `headerComputed: true` on every side-array entry whose size came from
`dataFrameHeaderLength` (i.e. `frameWireLength` did not return `raw.length`). Only explicit mode with computed headers
is affected, which is itself new (D-PZ2), so qvis parity is untouched. CRYPTO always carries its Length field and is
excluded.

#### 9.4.4 DECISION D-PZ8: DATAGRAM frames in guesstimate mode

qvis had no DATAGRAM frames. In guesstimate mode the port treats `datagram` exactly like `crypto` (an "other" frame
that also has a data length, so its header can come out negative and its payload rect overlaps the previous frame).
Recommended: keep it that way (one rule for both data-bearing non-STREAM frames, no new special case). Alternative:
give DATAGRAM the STREAM rule (`1 + dataLen`), which looks better but is a second deviation from the qvis algorithm.

### 9.5 HTTP/3 frame events (`http3:frame_created`, `http3:frame_parsed`)

#### 9.5.1 Event members

| Old path (qvis) | Latest path | Semantic differences | When absent or invalid | Tag |
|---|---|---|---|---|
| `data.stream_id` (`QPP:417`, `:435`, `:105-106`, `:455`; tooltips) | `data.stream_id` (uint64, required) | the stream that **carries** the frame. For SETTINGS, GOAWAY, MAX_PUSH_ID, CANCEL_PUSH, PRIORITY_UPDATE, ORIGIN that is the control stream (2 or 3). Never use `data.frame.stream_id` (PRIORITY_UPDATE's prioritized stream) or `data.frame.id` (GOAWAY) for byte placement or colour | absent: queued under key `"undefined"`, never placed, reported by "Not all HTTP3 frames found a home!"; no stream-lane rects (PARITY) | PARITY |
| `data.byte_length` (`QPP:67`, `:412`; string; payload length) | `h3FramePayloadLength(data.frame)` = `frame.raw.payload_length`, else derived from `frame.raw.length` or `frame.raw.data` (minimal-varint inversion, h3 digest §8.1) | moved **into the frame** (#495); event-level `byte_length`, `length` and hex `raw` no longer exist | `undefined`: skipped with `"H3 frame didn't have a payload length (frame.raw.payload_length / frame.raw.length) set! skipping..."`. A numeric 0 is valid (Q-H1) | PARITY + FIX |
| `data.frame` (unguarded at `QPP:68`, `:89`) | `data.frame` (required `$HTTP3Frame`) | open map | absent: `h3FramePayloadLength(undefined)` returns `undefined`, so the Q-H1 skip applies; qvis crashed here when `byte_length` was set (E28) | FIX |
| `data.frame.frame_type` | `data.frame.frame_type` | new types `priority_update`, `origin`; `duplicate_push` removed (would be `unknown`) | missing: type number 0 (1-byte varint), tooltip `frame type: undefined` (PARITY) | PARITY |
| `data.frame.raw_frame_type` (`unknown` only); `reserved` fixed to `0x02` (`MOD:83-84`, `:101-102`) | `data.frame.frame_type_bytes` (required on `reserved` and `unknown`) | GREASE reserved types `0x1f·N+0x21` need 1-8 varint bytes, so qvis' fixed `0x02` under-counted them | missing: 0 (1 byte). qvis: an `unknown` frame without `raw_frame_type` gave `VLIELength(undefined)` = 8 | FIX (Q-H4) |
| (none) | `data.frame.push_id` on `priority_update` | selects 0xF0701 (push) instead of 0xF0700 (request) | absent: 0xF0700 | FIX (Q-H4) |
| (none) | `data.frame.raw.length` together with `raw.payload_length` | exact header length `raw.length - raw.payload_length` (§3.6.7 note), correct even with non-minimal varints | either absent: computed `VLIE(type) + VLIE(payload)` | NEW |
| `data.frame.headers[] {name, value}` (`QPP:457`, `:568-575`) | `data.frame.headers[]`: `HTTP3HTTPField {name?, name_bytes?, value?, value_bytes?}` | read through `fieldName` / `fieldValue` (hex `*_bytes` decoded as Latin-1); names are lowercase | no `headers` on a request HEADERS frame: qvis stores `headers: undefined` and its tooltip loop (`for…of`, `QPP:568`, `:593`) throws inside the hover handler; port: treat as `[]`, so the tooltip prints `: ` with empty method and path | PARITY + FIX (guard) |
| event-level hex `raw` (draft-02) | `data.frame.raw.data` | | only used by `h3FramePayloadLength` when no length is logged | PARITY |

#### 9.5.2 Per HTTP/3 frame type (header size = `VLIE(type) + VLIE(payload)`)

| `frame_type` | Wire type used for the varint | Special handling in this view | Tag |
|---|---|---|---|
| `data` | 0x00 | adds to `HTTPStreamInfo.total_size` (stream 0 included, Q-H3) and to `HTTPpayloadSize` (efficiency) | PARITY + FIX |
| `headers` | 0x01 | adds to `HTTPpayloadSize`; on the request-direction event, creates `HTTPStreamInfo[stream]` (first wins) | PARITY |
| `cancel_push` | 0x03 | | PARITY |
| `settings` | 0x04 | an empty SETTINGS has payload 0 and is still placed (Q-H1) | FIX |
| `push_promise` | 0x05 | its `headers` are not recorded (only `headers` frames are) | PARITY |
| `goaway` | 0x07 | `id` (was `stream_id`) not read | PARITY |
| `origin` | 0x0c | new (RFC 9412); `raw` only in the editor's copy, so usually skipped for lack of a size | NEW |
| `max_push_id` | 0x0d | | PARITY |
| `priority_update` | 0xF0700, or 0xF0701 with `push_id` (4-byte varint) | qvis used 0 (1 byte), misaligning every later frame on the control stream by 3 bytes | FIX (Q-H4) |
| `reserved` | `frame_type_bytes` | | FIX |
| `unknown` | `frame_type_bytes` | | FIX |
| other strings (WebTransport, extensions) | 0 | header may be under-counted if the real type is > 63; prefer `raw.length - raw.payload_length` when both are logged | NEW |

### 9.6 Connection-level inputs

| Old (qvis) | Latest | Semantic differences | When absent | Tag |
|---|---|---|---|---|
| `parameters_set.owner` (`QPP:468`, `:473`) | `quic:parameters_set.initiator` (`"local"` \| `"remote"`) | renamed (#498). Local and remote settings MUST be separate events; the model is cumulative (an unmentioned setting is unchanged) | no `initiator`: event ignored (qvis ignored events without `owner`) | PARITY |
| `parameters_set.max_packet_size` (`QPP:469-475`) | `quic:parameters_set.max_udp_payload_size` (uint64) | same meaning: the largest UDP payload the endpoint is willing to receive (RFC 9000 §18.2), so "max receiving size" stays correct. Last event per initiator wins (as qvis). Value printed as logged | absent or 0 (truthiness, as qvis): keep the previous value, default 65527 (the RFC 9000 default) | PARITY |
| `vantage_point.type` (`QPP:24-29`, `D3R:246`, `:293-305`) | trace `vantage_point.type` (`client`, `server`, `network`, `unknown`); `vantage_point` itself is optional | unchanged values; the model substitutes `{type: "unknown"}` when absent. Non-standard strings (quic-go endpoint traces: `"transport"`) are kept and match neither branch | not client/server: empty flow label, `localname = "client"`, no request info (E18, PARITY). `network` + `flow` is not used (D-PZ9) | PARITY |
| `common_fields.protocol_type === "TCP_HTTP2"` (`D3R:119`) | `connection.protocolHint === "TCP_HTTP2"` | `protocol_type`/`protocol_types` were removed (main-schema-11). Our tshark converter keeps writing `common_fields.protocol_type: "TCP_HTTP2"` as a custom common field; otherwise the model derives the hint from the `tcp` + `http2` namespaces (data-model §9.10). quiche/neqo `protocol_types: ["QUIC"]` is ignored | no hint: QUIC mode | PARITY |
| all events count (`RND:68`) | `connection.getEvents().length` | per connection after the `group_id` split | n/a | PARITY |
| event order (`getEvents()`) | `connection.events` (stable sort by resolved time, data-model §3.16.7) | all FIFO matching depends on order **within** a stream (H3) or within the direction's byte stream (TCP mode). With the Q-H2 fix the relative order of H3 events and packet events no longer changes the placement (it still changes the blue/lightblue alternation and `lowerLayerIndex`, as in qvis) | n/a | PARITY |

**DECISION D-PZ9 (`network` vantage points).** For `type: "network"` traces, main-14 §6 says `flow` decides what
"sent" means. qvis ignores it (empty flow label, client naming, no request info). Recommended: PARITY. Optional: use
`connection.getVantagePointPerspective()` (data-model §3.3.3) in place of `vantage_point.type` for the three uses.

### 9.7 TCP mode (converter contract, converters §8.6.1 and §8.7)

The TCP/TLS/HTTP2 inputs are not qlog-draft events; they are private namespaces produced by our own tshark converter.
Their field **locations** changed with the port (sizes moved into `raw`), so the TCP preprocessor port reads:

| qvis (`TPP`) | qvis-react | When absent | Tag |
|---|---|---|---|
| `event.name === "packet_received"` / `"packet_sent"` | `ev.name === "tcp:packet_received"` / `"tcp:packet_sent"` | n/a | PARITY |
| TCP `data.header.payload_length` (`=== 0` → skip) | `toNum(data.raw.payload_length)`; skip when `=== 0` | the converter always writes it; if absent use `raw.length - header.header_length`, else skip with a diagnostic (qvis on HEAD rendered NaN, converters §3.10) | PARITY (FIX of the qvis HEAD bug) |
| TCP `data.header.header_length` | `data.header.header_length` (fallback `raw.length - raw.payload_length`) | | PARITY |
| `"record_parsed"` / `"record_created"` | `"tls:record_parsed"` / `"tls:record_created"` | | PARITY |
| TLS `data.header.payload_length` | `data.raw.payload_length` (already net of the estimated trailer) | the converter always writes it; absent: treat as 0 (qvis: `Math.max(0, undefined)` = NaN and an endless `extractRanges` loop, converters §3.10) | PARITY (FIX when absent) |
| TLS `data.header.header_length`, `trailer_length`, `content_type` | unchanged (`data.header.*`) | | PARITY |
| TLS `data.header.DEBUG_wiresharkFrameNumber` | `data.capture_frame_number` | absent: tooltip line omitted (truthiness, as qvis) | PARITY |
| TLS `record_length` (`extra`) = `header_length + payload + trailer_length` | same formula (equals `raw.length`) | | PARITY |
| `"frame_parsed"` / `"frame_created"` (and the request-headers event) | `"http2:frame_parsed"` / `"http2:frame_created"` | | PARITY |
| H2 `data.header_length` | `toNum(frame.raw.length) - toNum(frame.raw.payload_length)` (9, or 0 for `magic`) | | PARITY |
| H2 `data.payload_length` | `toNum(frame.raw.payload_length)` | | PARITY |
| H2 tooltip `rawPacket.payload_length` ("frame size ") | `rawPacket.frame.raw.payload_length` | | PARITY |
| H2 `data.content_type` (always `undefined`) | (none); keep `contentType: undefined` | not displayed | PARITY |
| H2 `data.stream_id`, `frame.frame_type`, `frame.headers`, `frame.stream_end` | unchanged; `stream_id: -1` for `magic`, `frame_type` values `go_away`, `reset_stream`, `magic` verbatim | | PARITY |
| `commonFields.protocol_type === "TCP_HTTP2"` | `connection.protocolHint === "TCP_HTTP2"` | | PARITY |

Golden numbers: converters §3.13 (`wikipedia_Playstation.json`), unchanged by the field moves.

### 9.8 Old members with no latest equivalent (consolidated)

| Old member | Read or written by qvis | Behaviour in qvis-react | Tag |
|---|---|---|---|
| `frame.frame_size` | read (explicit mode), written (guesstimate) | computed by `frameWireLength` into a side array; never written | NONE → NEW |
| `frame.header_size`, `frame.payload_size`, injected filler frame, `qvis.sequence.hide` | written | side array only (`ext.packetization`, data-model §3.16.9) | NONE (FIX Q-F1) |
| H3 event-level `byte_length`, hex `raw` | read | `frame.raw.payload_length` / `frame.raw.length` / `frame.raw.data` | NONE → moved |
| H3 `raw_frame_type` | read | `frame_type_bytes` | renamed |
| `parameters_set.owner`, `max_packet_size` | read | `initiator`, `max_udp_payload_size` | renamed |
| `common_fields.protocol_type` | read | `connection.protocolHint` (custom common field kept by our converter) | NONE → derived |
| `is_coalesced` | not read | `datagram_id` / `datagram_payload_checksum` (ENH-3) | NONE |
| category-based (type-only) matching | all lookups | exact full names | NONE |
| TCP `header.payload_length`, TLS `header.payload_length`, `DEBUG_wiresharkFrameNumber`, H2 `header_length` / `payload_length` | read (TCP mode) | converter fields of §9.7 | moved (converter) |
| draft-02 `frame.length` on NEW_TOKEN / NEW_CONNECTION_ID | read (header/payload split) | `token.raw.length` / `token.raw.data`, `connection_id_length` / `connection_id` | moved |
| `raw.length` written from `raw.data` | written | computed locally (`hexByteLength`) | FIX Q-P2 |

### 9.9 New in the latest drafts that this view could show

| Id | Latest item | What this view can do with it | Default | Tag |
|---|---|---|---|---|
| D-PZ7 | `quic:frames_created` (sending), `quic:frames_parsed` and `quic:frames_processed` (receiving), `{frames, packet_numbers?}` (quic-13 §5.14; the editor's copy drops `frames_processed`) | When a `quic:packet_*` event has **no** `frames` member (absent, not `[]`) and its `packet_type` is `0RTT` or `1RTT`, take its frames from `conn.framesForPacket(direction === sending ? "sent" : "received", "application_data", toNum(header.packet_number))` (data-model §9.12 N3; frame events carry no PN space, -13 says "normally application_data", so Initial/Handshake packets are not matched). Then size and lay them out exactly like inline frames; STREAM bytes enter the H3 FIFO at the **packet** event's position. Inline frames always win (no merging, so no double counting) | **ON** (recommended): spec-compliant producers that log frames separately would otherwise get an empty frame lane and an empty H3 lane | NEW |
| D-PZ4 (revisited) | empty lane 0 under latest-only input | The empty diagram is now common (current quic-go names, producers without packet `raw`). Recommended now: **ON**, centered in the plot area (`x = width/2`, `y = 50`, `text-anchor: middle`, `dominant-baseline: middle`, `font-family: "Trebuchet MS"`, 16px, fill `#6c757d`), first matching text wins: (1) the connection has `transport:packet_<dir>` events: `This trace uses pre-standard event names (transport:packet_<dir>); only quic:packet_<dir> is supported`; (2) `quic:packet_<dir>` events exist but none has `raw.length` or `raw.data`: `No quic:packet_<dir> events with raw.length found for this direction`; (3) otherwise `No quic:packet_<dir> events found for this direction`. TCP mode uses only (2) `No tcp:packet_<dir> events with a payload found for this direction` and (3) `No tcp:packet_<dir> events found for this direction`. `<dir>` is `sent` or `received` | ON unless the parity harness screenshots an empty state | DECISION |
| ENH-1 (extended) | exact sizes for fully determined frames | add `handshake_done` (1), `ping` (1), `reset_stream_at` (`1 + VLIE(stream_id) + VLIE(code) + VLIE(final_size) + VLIE(reliable_size)`, code from `error_code` or the h3 digest §4.3 table) to the §3.6.5 ENH-1 list | OFF | ENH |
| ENH-2 | `http3:stream_type_set {stream_id, stream_type, stream_type_bytes?, associated_push_id?}` | consume the stream-type varint before the first frame of a unidirectional stream: `VLIE(code)` with control 0x00, push 0x01, qpack_encode 0x02, qpack_decode 0x03, reserved/unknown `stream_type_bytes`; for `push` also `VLIE(associated_push_id)` (the Push ID follows the type, RFC 9114 §4.6). Removes the 1-byte shift of E15 | OFF | ENH |
| ENH-3 | `datagram_id` (-13) / `datagram_payload_checksum` (editor's copy) on packet events; `quic:udp_datagrams_sent/received {raw: [+RawInfo], datagram_ids}` | mark coalesced packets: consecutive packet events with the same `coalescingKey()` (data-model §9.12 N4) get a 2px black bracket under lane 0 and a tooltip line `UDP datagram: <key> (<n> coalesced packets)` | OFF | ENH |
| ENH-4 | `quic:packet_lost {header}` | sending diagram only: packets matched by (PN space of `packet_type`, `packet_number`) get a tooltip line `<b>LOST</b>` (+ `trigger`) and a hatched overlay | OFF | ENH |
| ENH-5 | event-level `tuple` + `quic:tuple_assigned` (replaces `path`) | tooltip line `tuple: <id>` on packets whose effective tuple is not `""` (data-model §9.12 N1); multipath traces keep one byte axis per direction | OFF | ENH |
| ENH-6 | `http3:datagram_created` / `http3:datagram_parsed {quarter_stream_id, raw?}` | FIFO-match them (same direction) to DATAGRAM frame payloads; H3 lane piece `VLIE(quarter_stream_id)` header + rest payload, stream lane colour of stream `quarter_stream_id * 4`, tooltip `H3 Datagram, streamID: <id>` | OFF | ENH |
| ENH-7 | `quic:parameters_restored.max_udp_payload_size` (0-RTT, implicitly remote) | seed `max_size_remote` until a remote `quic:parameters_set` arrives | OFF | ENH |
| ENH-8 | `quic:udp_datagrams_*.raw[i].length` | size a packet that has no `raw` from its datagram when exactly one packet event shares that datagram's id | OFF | ENH |
| ENH-9 | `is_mtu_probe_packet`, `trigger` on `quic:packet_sent` | tooltip line `MTU probe` / `trigger: <t>` | OFF | ENH |
| (automatic) | new QUIC frame types (`reset_stream_at`, `handshake_done`, `datagram`, extension frames), new H3 frame types (`priority_update`, `origin`), `HTTP3HTTPField` `*_bytes`, string-encoded uint64 | handled by §9.4 / §9.5 with no option | always | NEW / FIX |
| n/a | `quic:packets_acked`, `quic:recovery_metrics_updated` (`rtt_variance`, `pto_count`, `packets_in_flight`, `pacing_rate`), `quic:congestion_state_updated`, `quic:timer_updated`, `quic:ecn_state_updated` | time-based or state signals with no meaning on a byte axis; the congestion graph and sequence diagram own them | — | n/a |
| n/a | `quic:mtu_updated` | PMTU estimate, a sender-side value; not the same as the `max_udp_payload_size` transport parameter shown in the "max receiving size" labels; do not substitute | — | n/a |
| n/a | `quic:stream_data_moved`, `quic:datagram_data_moved` | the H3/QUIC boundary is inferred from frame sizes (qvis comment `QPP:379-380`); could validate H3 placement but adds no picture | — | n/a |
| n/a | `quic:packet_dropped`, `quic:packet_buffered` | not drawn (PARITY: qvis ignored `transport:packet_dropped`); a buffered packet appears once, at its `packet_received` (`trigger: "keys_available"`) | — | n/a |
| n/a | `http3:priority_updated`, `http3:push_resolved`, `http:capsule_*`, `loglevel:*`, `simulation:*` | not relevant to byte layout | — | n/a |

### 9.10 What real producers give (expected picture)

| Producer (ecosystem digest §3) | Packet sizes | Frame sizes | H3 sizes | Expected picture |
|---|---|---|---|---|
| quic-go ≥ v0.56 | `raw.length` + `raw.payload_length` | STREAM/CRYPTO/DATAGRAM top-level `length` (read via the legacy tail of `frameDataLength`); no `raw` on ACK; no PADDING frames | `frame.raw` | **nothing**: events are `transport:packet_*` (rule 1, E29). If quic-go switches to `quic:` names unchanged: pure-STREAM packets exact (computed headers, §9.4.3), packets with ACK guesstimated, padded Initials get a leading filler |
| quiche ≥ 0.27, neqo, quinn (qlog crate) | packet `raw` is not documented in the ecosystem digest; packets without it are invisible (D-PZ4 text 2) | STREAM/CRYPTO/PADDING `raw.payload_length`; nothing on ACK | handled by `h3FramePayloadLength` whatever `raw` member is logged | as above with `quic:` names; quinn has `vantage_point.type: "unknown"`, so no flow label and no request info (E18) |
| mvfst | `raw.length` | STREAM `raw.length` (data length), `stream_id` as JSON string | per its H3 logging | computed STREAM headers; string stream IDs work through `"" + id` |
| netlog converter (converters §8.4) | `raw.length` from `size`; no `payload_length` (fallback header 4, as in qvis) | STREAM/CRYPTO `raw.length` (T1); DATAGRAM `raw.length` and PADDING `raw.payload_length` only at T3 | received DATA `raw.payload_length` (T1); sent DATA and received HEADERS sized only at T3 | same as qvis' netlog picture: HEADERS frames skipped with the Q-H1 message at T1 (qvis skipped them for lack of `byte_length`) |
| tshark converter | TCP mode, §9.7 | | | converters §3.13 golden numbers |
| `tools/qloggen` demo data (ARCHITECTURE §0) | SHOULD log `raw.length` + `raw.payload_length` | SHOULD log `raw.length` on every non-data frame, the Length field in STREAM/CRYPTO/DATAGRAM `raw.length`, one PADDING frame with `raw.payload_length` | SHOULD log `frame.raw.length` + `raw.payload_length`; SHOULD emit `http3:stream_type_set` (ENH-2) | explicit mode everywhere, no fillers. For the parity harness also generate a variant without frame `raw` (except STREAM/CRYPTO data lengths), which reproduces qvis' guesstimate picture with the yellow fillers the help text describes |

### 9.11 Diagnostics and texts affected by the mapping

- H3 skip (Q-H1, console only): `"H3 frame didn't have a payload length (frame.raw.payload_length / frame.raw.length) set! skipping..."`.
- Q-P1 heuristic (console only, once per render): `"raw.payload_length appears to include the AEAD tag"`.
- §9.4.3 adds no message. D-PZ7 adds no message.
- D-PZ4 texts as in §9.9.
- Help text: D-PZ1 (§2.3) already names `quic:`/`http3:` and `raw` fields.
- All other §6.4 messages keep their qvis wording, including the misleading `"… packet without raw.length set... ignoring"`
  (it also covers a missing `raw.data`).

### 9.12 Latest names referenced by this view (checklist for `names.ts`)

- Required: `quic:packet_sent`, `quic:packet_received`, `quic:parameters_set`, `http3:frame_created`,
  `http3:frame_parsed`.
- D-PZ7 (recommended ON): `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed`.
- D-PZ4 text (1) only: the pre-final names `transport:packet_sent`, `transport:packet_received` (lookup by logged
  namespace, never matched as packets).
- Optional ENH: `http3:stream_type_set`, `quic:udp_datagrams_sent`, `quic:udp_datagrams_received`,
  `quic:packet_lost`, `quic:tuple_assigned`, `http3:datagram_created`, `http3:datagram_parsed`,
  `quic:parameters_restored`.
- TCP mode (converter): `tcp:packet_sent`, `tcp:packet_received`, `tls:record_created`, `tls:record_parsed`,
  `http2:frame_created`, `http2:frame_parsed`.

### 9.13 Tests for the mapping (vitest, in addition to §8.7)

1. Pre-final names: a trace with `transport:packet_sent` + `http3:frame_created` gives empty lanes, no exception, and
   D-PZ4 text (1) when the note is enabled.
2. STREAM data length from each producer shape gives the same layout: `{raw:{length:50}}` (-13, mvfst),
   `{raw:{payload_length:50}}` (quiche), `{length:50}` (quic-go, tolerated), `{raw:{length:53, payload_length:50}}`
   (main-schema semantics: wire 53).
3. LEN-bit inference: 1RTT packet with `raw:{length:70, payload_length:52}` and one frame `{frame_type:"stream", stream_id:0,
   offset:0, raw:{length:50}}`: computed 53, offset -1 = -VLIE(50), inferred header 2, payload 50, no filler, no left
   shift. The same packet with `payload_length` 53 stays header 3. CRYPTO is never adjusted.
4. `new_connection_id` with `connection_id: "0102030405060708"` and no `connection_id_length`: payload rect 8.
   `new_token` with `token:{raw:{data:"aabbcc"}}`: payload rect 3.
5. `priority_update` with `push_id` on stream 3: header `4 + VLIE(len)`; a `reserved` frame with
   `frame_type_bytes: 0x21 + 0x1f*1000` gets a 4-byte type varint.
6. H3 event without `frame`: skipped with the Q-H1 message, no throw, later frames on other streams unaffected.
7. `quic:parameters_set {initiator:"remote", max_udp_payload_size:"1472"}` on a client trace gives
   `max receiving size server: 1472`; `{owner:"remote", max_packet_size:1472}` is ignored (65527 stays);
   `quic:recovery_parameters_set` and `http3:parameters_set` are ignored.
8. D-PZ7: `quic:packet_sent {header:{packet_type:"1RTT", packet_number:5}, raw:{length:1252, payload_length:1224}}`
   without `frames` plus `quic:frames_created {frames:[stream…], packet_numbers:[5]}` fills the frame lane; the same
   packet with `frames: []` does not; an `initial` packet is never matched.
9. `raw:{data:"<2400 hex chars>"}` without `length`: total 1200; the event object is deep-equal before and after.
10. A packet with only `header.length` (no `raw`) is skipped silently.
11. `version_negotiation` and `retry` without `packet_number`: tooltip `Packet nr : undefined`; three lane-0 ranges.
12. mvfst-style `stream_id: "4"` on STREAM frames and `stream_id: 4` on `http3:frame_parsed` meet in one FIFO.
13. A real frame with `frame_type: "qvis_ext"` is drawn red/pink with a normal index (not a filler).
14. TCP mode on the converted `wikipedia_Playstation.json`: converters §3.13 golden numbers with the §9.7 field
    locations (`raw.payload_length`, `capture_frame_number`, `frame.raw.*`).

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`). Where this addendum contradicts the body, **this addendum wins**.

### P1. The info modal names a demo file (G4): amends §2.3 and the note at :274

The modal body (verbatim, PARITY) tells users to select "**DEMO_10_parallel_streams**". The note "stays valid
because the demo file names are kept verbatim (file-loading 8.7)" is void: ARCHITECTURE §0 replaces the converted
qvis demos with generated ones from a manifest (file-loading addendum F2). Requirement on the demo set: Option 3
MUST include a multi-stream HTTP/3 demo whose basename starts with `DEMO_10_parallel_streams` (file-loading F2 item
6), so the verbatim text stays true. If the demo set cannot provide it, change only the quoted file name in the
modal to the actual demo name and record it as a PARITY deviation in §7.

That demo must contain `http3:frame_created`/`frame_parsed` (HEADERS and DATA with `frame.raw.payload_length`) and
STREAM frames with `raw.length` (file-loading F2 items 2-3). Otherwise the HTTP/3 lane stays empty, which is the
current behaviour on raw quic-go output.

### P2. No legacy `length` fallback (G11): amends §3.6.5

`frameDataLength()` for `stream`/`crypto`/`datagram` becomes
`toNum(f.raw?.payload_length) ?? toNum(f.raw?.length)`. The trailing `?? toNum(f.length)` is removed (data-model
addendum M3, the single strict rule for legacy members). Consequence: a frame that logs only a top-level `length`
(pre-final quic-go) has no data length, so its packet uses guesstimate mode. Such files are non-conforming by name
anyway, so this view finds no packets in them (§9.1, E29). The "What real producers give" paragraph ("quic-go logs
... a top-level STREAM `length`") is informational only. Test 13 and the other §9.13 tests are unchanged.

### P3. Console levels (G13; policy in app-shell addendum A5)

The §6.4 diagnostics that fire on valid or partial latest-draft input use `console.warn` with unchanged text. Every
-13 size member is optional, and producers log frames and HTTP/3 events partially. The affected messages:

- `packet without header.packet_type set`, `packet without raw.length set`
- `frame_sizes don't fill the entire packet payload!`, the `-guesstimate-` notice, `stream frame with no length
  attribute!`, `something went wrong calculating frame sizes!`
- `H3 frame didn't have a payload length ...`, `No payload ranges known for this stream_id`
- `Not all QUIC payload ranges were used up!`, `Not all HTTP3 frames found a home!`, `QUIC payload size != HTTP3
  payload size`
- `Negative size after extracting ranges!`
- the TCP-preprocessor size mismatches

`console.error` stays only for caught exceptions and for the case where `render()` resolves `false` (which also shows
N-PZ2). The two former `alert()`s of §6.2 (`MOD:187`, `MOD:197`) can fire on inconsistent but loadable size data, so
they become `console.warn` plus N-PZ3, not `console.error` plus N-PZ3 as the §6.2 heading says.

## 10. Integration addendum (as built)

- §2.3: hosted qvis nests the `<ul>` and the following text INSIDE the first two `<p>`s (Vue `createElement`, no
  browser p-closing). The port renders those two paragraphs as `div.packetization-info-paragraph` with `<p>` margins
  (React rejects `<ul>` in `<p>`); the pixels are identical. `id="info-modal"` is set on the `.modal` root.
- Lane labels and the D-PZ4 empty note are **14 px** (hosted qvis renders the unitless `"14"` as 14 px); §9.9's
  16 px assumed 16 px labels.
- Bootstrap 4 modal frame (border `rgba(0,0,0,.2)`, `.3rem` header corners), the 40 px list indent and the Bootstrap 4
  body font stack are now global (`src/styles/global.css`); the scoped copies in `PacketizationDiagram.css` are
  redundant but harmless.

## 11. Same-data parity audit (hosted qvis vs qvis-react)

Method: hosted qvis (`qvis.quictools.info`) loaded `tests/fixtures/legacy/<scenario>.draft02.qlog`; qvis-react loaded
the latest-draft original under the same file name, so the selector header is identical. Compared at 1600x1000 and
900x1000, first renders only (Q-F1), for new_cid, 10_parallel_streams, baseline, doublevantage_100ms,
multistream_loss and massive_client, client and server traces: every rect's bound data (`start`, `size`,
`isPayload`, `contentType`, `index`, `lowerLayerIndex`, `color`), all texts and their boxes, axis ticks, tooltips
(text, box, position, fade), zoom transforms after wheel, drag, double-click and ctrl+wheel, trace switching, tab
re-entry, the info modal, the empty state, an empty receive direction (E3) and the N-PZ1 toast.

**Identical:** page and panel geometry, the selector, the "More info on this tool" button, both svgs, lane labels,
legend, flow and efficiency labels (14 px Trebuchet MS), axis ticks and fonts, rect y/height/fill/style, the HTTP/3 and
Stream IDs lanes rect for rect (except where Q-F3 changes qvis, below), tooltip texts and boxes, zoom transforms
(`k`, `x`, `y`) and tick labels after the same input, page scrolling at the scale limits, independent top/bottom zoom,
zoom reset on trace switch, the selection surviving a route change, the modal geometry, fonts and text (except
D-PZ1), N-PZ1 text, colours and position, and E3 geometry.

**Fixed in this audit:** Bootstrap 4.3 rings `.btn-secondary` on any `:focus`. Hosted qvis therefore shows the ring on
"More info on this tool" after a mouse click and whenever the modal hands focus back on close (×, ESC, backdrop or
"Close"). Bootstrap 5 rings only `:focus-visible` and also switches keyboard focus to the hover colours.
`PacketizationDiagram.css` restored the Bootstrap 4 behaviour for this view's two buttons (e2e: "buttons show the
Bootstrap 4 focus ring"); at integration the same rules moved to `src/styles/global.css` for every button (app-shell
A7) and the local copy was removed.

**Known deltas on the same data** (none is a qvis-react bug):

| Delta | Cause |
|---|---|
| Packet headers 32 bytes smaller, payloads 16 bytes larger, no 16-byte trailer overlap, `xMax` 16 bytes smaller (tick positions shift by < 1 px); ACK-only packets get a full-height payload instead of a negative-width rect | Q-P1 (FIX) |
| Packets whose guessed frame sizes overshoot the payload: qvis draws no frames and loses their STREAM bytes, so later HTTP/3 frames on that stream are split differently, may never be placed ("Not all HTTP3 frames found a home"), and efficiency drops (10_parallel_streams client receive: 86.61% vs 96.22%) | Q-F3 (FIX), triggered by Q-P1 |
| "total resource size: 0" on stream 0 | Q-H3 (FIX) |
| Packets with exactly one unsized frame (ACK+PADDING, ACK+CRYPTO, ACK+STREAM, a lone MAX_STREAMS): qvis shows exact frame edges, qvis-react the qvis guesstimate (shared leftover, small yellow filler, negative CRYPTO headers) | converter hint: the legacy converter derives `frame_size` for that frame, information the latest-draft file only has implicitly; on un-hinted data qvis guesstimates exactly like qvis-react (Q-F6 PRESERVE) |
| A packet whose only frames are MAX_STREAMS: qvis-react draws a 0-byte frame plus a full-payload filler | qvis divides by zero there (Infinity/NaN layout); qvis-react uses 0 per frame (FIX, `quicFrameSizes.ts`) |
| "max receiving size …: 65527" in qvis | qvis reads the pre-draft-02 `max_packet_size`, never draft-02 `max_udp_payload_size` (qvis quirk) |
| D-PZ4 note in an empty direction | D-PZ4 (NEW) |
| The three "How does it work?" bullets | D-PZ1 |
| The info button opens on every click | Q-M1 (FIX) |
| Clip-path ids, no console errors (diagnostics are `console.warn`), no "negative value" errors | Q-R1, P3, E7 |
| N-PZ1 also on the mount path; the diagrams re-lay out when the container width changes | D-PZ3; Q-R5/E22 option |
| Re-entering the tab or re-selecting a trace gives the same picture | Q-F1 (FIX; qvis adds more fillers) |

**TCP mode cannot be compared:** hosted qvis cannot render its own TCP demo (`wikipedia_Playstation.json`). Its TCP
payload sizes come out `undefined`, and `extractRanges` loops forever on the resulting NaN until the tab crashes.
With a NaN guard injected into the hosted bundle it renders only NaN rects. qvis-react renders the demo (the NaN guard
in `extractRanges` is a FIX).
