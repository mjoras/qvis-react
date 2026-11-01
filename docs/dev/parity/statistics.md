# Parity spec: statistics ("qlog stats", `#/stats`)

Sources (paths relative to `qvis/visualizations/src/` unless stated otherwise), all read completely:

| File | Lines | Role |
|---|---|---|
| `views/Statistics.vue` | 17 | route view, renders `<StatisticsContainer/>` inside a bare `<div>` |
| `components/stats/StatisticsContainer.vue` | 38 | page: configurator + renderer, owns the config reference |
| `components/stats/StatisticsConfigurator.vue` | 76 | yellow panel: intro text, file selector, empty-state alerts, auto-selection |
| `components/stats/StatisticsRenderer.vue` | 103 | "File info" table + one `StatisticsConnectionRenderer` per (real) trace |
| `components/stats/StatisticsConnectionRenderer.vue` | 646 | "Trace N info" table: every per-trace statistic |
| `components/stats/data/StatisticsConfig.ts` | 9 | `{ group: ConnectionGroup \| undefined }` |
| imported: `components/shared/ConnectionConfigurator.vue`, `store/ConnectionStore.ts`, `store/ConfigurationStore.ts`, `data/Connection.ts`, `data/ConnectionGroup.ts`, `data/QlogLoaderV2.ts`, `data/QlogSchema02.ts`, `views/MainMenu.vue`, `router.ts`, `App.vue`, `main.ts` | | behaviour that the stats page depends on |

Related specs (normative for the parts they own, referenced instead of repeated):

- `docs/dev/ARCHITECTURE.md` (stack, stores, strict latest-draft names, **no alias table**, no data fix-ups).
- `docs/dev/parity/app-shell.md` §2.4 (menu tab), §2.5 (shared `ConnectionConfigurator`, mode A "group-only"), §2.5.7 (auto-selection, `<NoTraceAlerts/>`), §8.5-8.7 (React selector, stores, Bootstrap 4 vs 5).
- `docs/dev/parity/data-model.md` §3.16.12 (TypeScript model API: `QlogConnectionGroup`, `QlogConnection`, `QlogEvent`), §7 Q16/Q20, §8.7 D7/D8.
- `docs/dev/qlog-spec/quic-events.md` §4.3 (`quic:parameters_set`), §4.5-4.8, §6.4-6.5, §8.10-8.11 (MAX_DATA / MAX_STREAM_DATA), §13.6.
- `docs/dev/qlog-spec/h3-events.md` §3.5-3.6, §4.2.2 (`HTTP3HTTPField`, `fieldName()`/`fieldValue()`), §10.6.4.
- `docs/dev/qlog-spec/main-schema.md` §4, §6, §12, §27.2.

Verification: on 2026-11-01 the hosted qvis (`https://qvis.quictools.info/#/stats`) was driven with Playwright after
"Load example .qlog files". Rendered DOM and screenshots confirmed every label, the progress-bar label format
(`52.94`, no `%`), the danger cells, and two quirks (§7 Q2, Q12). Observations are quoted as "hosted qvis" below.

Tags used in this document: **PARITY** (reproduce exactly), **FIX** (deliberate, documented deviation), **NEW**
(addition that has no qvis equivalent; optional but recommended), **DROP** (do not port).

---

## 0. Decision summary

| # | Topic | Decision |
|---|---|---|
| S1 | Page structure, every label, row order, nested-table layout, progress-bar format | PARITY (§2) |
| S2 | All counting/collection algorithms (events, frames, encryption levels, flow control, H3 headers) | PARITY on semantics; shape-based detection kept (§3); names translated to latest drafts (§4) |
| S3 | `qlog version` row | label PARITY, value = `group.version` (= `file_schema`, data-model D8) |
| S4 | NEW rows `Serialization format`, per-trace `Event schemas`, file-level `Diagnostics` | NEW, recommended (§2.5, §2.6) |
| S5 | Trace `Title` row never shows (`title > 0` bug) | FIX: `title.length > 0` (§7 Q1) |
| S6 | H3 header summary injected with `v-html` (XSS) | FIX: React elements, same visual markup (§7 Q3) |
| S7 | Absent `initial_max_*` fields produce `NaN` entries | FIX: skip absent fields (§7 Q4) |
| S8 | Connection-level FC cell guarded by the encryption-level map | FIX (minimal superset guard, §7 Q5) |
| S9 | Stream-level FC cell guarded by remote map only | FIX (minimal superset guard, §7 Q6) |
| S10 | Trace sections hidden when the whole file has 0 events | FIX: always render real traces (§7 Q7) |
| S11 | Vantage point with no `name` renders an empty first line | FIX: only render the name line for a non-empty string (§7 Q8) |
| S12 | `Summary` row (file `summary`) | DROP: `summary` no longer exists in -14, row was never shown (§7 Q11) |
| S13 | Duplicate `id="toplevel"` and a dead scoped CSS rule | FIX: class instead of id; do not port the dead rule (visual PARITY) (§7 Q9) |
| S14 | Packetization's `qvis-injected FILLER` frames leaking into the Frames table | FIX by construction (model never mutated; §7 Q12) |
| S15 | Debug console output (staggered FC lines) | PARITY content, emitted with `console.debug` (§3.10) |
| S16 | Detection mode per statistic under strict latest-draft names | **Revised in the stats review:** shape-based counters (frames, encryption levels) skip events with non-conforming (DM3) names; name-based parts (flow control, H3 headers) match exact latest names only (§9.1). The Events histogram lists every event. |
| S17 | NEW rows `QUIC version` and `ALPN` from the Core events `quic:version_information` / `quic:alpn_information` | NEW, recommended; rendered only when the data exists (§9.12) |
| S18 | Flow control from `quic:frames_created` / `quic:frames_parsed` / `quic:frames_processed`, and from `quic:parameters_restored` | not adopted (PARITY); exact optional rules documented (§9.12 N3, N8) |
| S19 | QUIC `unknown` and HTTP/3 `unknown` frame types now share one row (draft-02 QUIC used `unknown_frame_type`) | PARITY of the algorithm (merged row), documented (§9.5) |
| S20 | TLS records of tshark-converted TCP traces and `header.packet_type` | **Superseded by converters decision C9:** the ported converter keeps the compat `header.packet_type: "1RTT"` on `tls:record_*`, so the `1RTT` count is TCP packets + TLS records exactly as in qvis (TCP demo: `283` in both apps, parity check §10). The original text (TCP packets only) is kept below for history |

---

## 1. Overview and user-facing purpose

The statistics page ("qlog stats" tab, route `#/stats`) is a **per-file** summary. The user picks one loaded file
(a `QlogConnectionGroup`, one qlog file) from a dropdown. The page then shows:

1. **File info**: filename, file title and description, qlog version, number of traces, total number of events.
2. For **every trace** in that file (every non-generated `QlogConnection`, i.e. every trace, every `group_id` slice
   and every TraceError placeholder), a **"Trace N info"** table:
   - trace title (see Q1), description, vantage point,
   - a one-line summary of HTTP/3 identity headers ("User Agent X connected to Server Y at Z"),
   - total event count and a **histogram of events by category (namespace) and event type**, with a percentage bar,
   - total frame count and a **histogram of frame types** (QUIC frames from packet events and HTTP/3 frames from
     frame events, in one table), with a percentage bar,
   - number of distinct **packet types** ("encryption levels") and how many events carried each,
   - **connection-level flow-control evolution**: the sequence of `initial_max_data` / `MAX_DATA` limits set by the
     local endpoint and by the remote endpoint,
   - **stream-level flow-control evolution**: initial per-stream limits (`initial_max_stream_data_*`) and every
     `MAX_STREAM_DATA` update, grouped by stream, for local and remote.

There are **no charts** and **no D3** on this page. The only graphical elements are Bootstrap progress bars. The
flow-control "evolution" is a plain list of numbers; for plotting, qvis prints spreadsheet-ready step-function
series to the browser console (§3.10).

The page is read-only. Its only interaction is choosing a file.

---

## 2. UI inventory

### 2.1 Route and menu (owned by app-shell, listed for completeness)

- Route `/stats` (`router.ts:76-83`): `components: { default: Statistics, menu: MainMenu }`. Sticky query parameters
  apply as for every route (app-shell §3.3).
- Menu tab (`MainMenu.vue:41-43`): `li.nav-item.stats-link > a.nav-link[href="#/stats"]`, text **`qlog stats`**.
  Active background `#fff3cd` (`MainMenu.vue:119-123`).

### 2.2 Page DOM tree (qvis, simplified; attributes that matter for layout and tests)

```
div                                                        (views/Statistics.vue:2)
  div.home                                                 (StatisticsContainer.vue:2)
    div[style="background-color:#fff3cd; padding:0px 10px;"]          configurator   (StatisticsConfigurator.vue:2)
      div.container-fluid                                  (b-container fluid)
        div.row.justify-content-center                     (b-row align-h=center; scoped .row {padding-bottom:10px})
          p[style="margin-top:10px;"]  "Select a file via the dropdown(s) below to view its statistics"
        div.row.justify-content-center
          <ConnectionConfigurator/> (only if config.group !== undefined; mode A, group-only)
        div.alert.alert-danger  "Please load a trace file to visualize it"      (if outstandingRequestCount === 0 && groups.length === 0)
        div.alert.alert-warning "Loading files..."                               (else if groups.length === 0)
    div                                                    renderer root (StatisticsRenderer.vue:2)
      div#statistics-container[style="width:100%; border:5px solid #fff3cd; min-height:200px;"]
        div[style="width:50%; min-width:1024px; margin-left:auto; margin-right:auto;"]   (only if group !== undefined)
          h3 "File info"
          div.table-responsive > table.table.b-table.table-bordered.table-sm.b-table-fixed     File info table (2.5)
          (per real trace, index i)
          div
            h3 "Trace {i+1} info"
            div.table-responsive > table#toplevel.table.b-table.table-bordered.table-sm.b-table-fixed   (2.6)
```

### 2.3 Configurator panel (`StatisticsConfigurator.vue`)

| Element | Exact content / behaviour | Source |
|---|---|---|
| Panel | `div`, inline style `background-color: #fff3cd; padding: 0px 10px;` | `:2` |
| Scoped CSS | `.row { padding-bottom: 10px; }`, `.btn { margin: 0px 5px; }` (no buttons exist here; harmless) | `:19-27` |
| Intro | `<p style="margin-top: 10px;">Select a file via the dropdown(s) below to view its statistics</p>`, centered in a `row justify-content-center` | `:5-7` |
| Selector | shared `ConnectionConfigurator` with `allGroups=store.groups`, `group=config.group`, `canBeRemoved=false`, `allowGroupSelection=true`, `allowConnectionSelection=false`, `onGroupSelected`. Rendered only when `config.group !== undefined`. This is **mode A (group-only)** of app-shell §2.5.4: one `select.custom-select.mb-3.mt-3` inside a white panel (`background-color:white; color:black; border:black 1px solid; max-width:50%`) | `:8-10` |
| Option labels | one per loaded group, load order: `group.filename + " (" + (group.title ? group.title + " : " : "") + group.description + ")"`. Example (hosted qvis): `DEMO_new_cid.qlog (<1MB) ()` | `ConnectionConfigurator.vue:122-129` |
| Empty-state alerts | `Please load a trace file to visualize it` (danger) when no request is outstanding and no group is loaded; else `Loading files...` (warning) when no group is loaded. Shared `<NoTraceAlerts/>` (app-shell §2.5.7) | `:12-13` |

Interaction: choosing an option calls `onGroupSelected(group)`, which sets `config.group = group`
(`StatisticsConfigurator.vue:51-55`). The port passes the **newly selected** group (app-shell §2.5.6, Q8). Nothing
else changes (no connection selection in this mode).

### 2.4 Renderer container (`StatisticsRenderer.vue:2-5`)

- `#statistics-container` is always rendered: `width: 100%; border: 5px solid #fff3cd; min-height: 200px;`. With no
  file selected it is an empty 200 px tall white box with a yellow border under the configurator (PARITY).
- Content wrapper (only if a group is selected): `width: 50%; min-width: 1024px; margin-left: auto; margin-right:
  auto;`. On viewports narrower than about 1034 px the page scrolls horizontally (PARITY, desktop tool).

### 2.5 "File info" table (`StatisticsRenderer.vue:6-45`)

Heading `<h3>File info</h3>`. Table: `b-table-simple fixed bordered small responsive` →
`div.table-responsive > table.table.b-table.table-bordered.table-sm.b-table-fixed`, first column 20% wide
(`<colgroup><col width="20%" align="right"></colgroup>`; the obsolete `align` attribute has no effect, cells are
left-aligned, confirmed on hosted qvis). Header row (`thead.thead-dark`, white text on `#343a40`):

| `Aspect` | `Value` |
|---|---|

Body rows, in this exact order (left cell = verbatim label):

| # | Label | Shown when | Value | Source |
|---|---|---|---|---|
| 1 | `Filename` | `group.filename !== ''` | `group.filename` | `:16-19` |
| 2 | `Title` | `group.title !== ''` | `group.title` | `:20-23` |
| 3 | `Description` | `group.description !== ''` | `group.description` | `:24-27` |
| 4 | `qlog version` | always | `group.version`. qvis: `qlog_version` (e.g. `draft-01`). qvis-react: `group.version` = `file_schema` (e.g. `urn:ietf:params:qlog:file:contained`) — data-model D8 | `:28-31` |
| 4a | `Serialization format` | **NEW**; `group.serializationFormat !== ''` | `group.serializationFormat` (e.g. `application/qlog+json`) | — |
| 5 | `Summary` | `Object.keys(group.summary).length > 0` — never true (Q11) | `JSON.stringify(group.summary, null, 4)` (whitespace collapsed by HTML) | `:32-35`; **DROP** |
| 6 | `Trace count` | always | number of connections with `!wasAutoGenerated` (= `group.getRealConnections().length`; includes `group_id` slices and TraceError placeholders) | `:36-39` |
| 7 | `Total event count` | always | Σ `connection.getEvents().length` over the same connections | `:40-43`, `:82-96` |
| 7a | `Diagnostics` | **NEW**; `group.diagnostics.length > 0` | one line per diagnostic (lines separated by `<br/>`): `` `${d.level}: ${d.message}` `` + (`d.count > 1` ? `` ` (${d.count}x)` `` : `""`), in `group.diagnostics` order | data-model D7 |

### 2.6 "Trace N info" table (`StatisticsConnectionRenderer.vue:1-257`)

One block per real trace, in `group.getConnections()` order filtered by `!wasAutoGenerated`. `N = index + 1`, where
`index` is the position **in the filtered list** (`StatisticsRenderer.vue:47`).

Heading `<h3>Trace {N} info</h3>`. Table: `b-table-simple fixed bordered small responsive id="toplevel"` →
`div.table-responsive > table#toplevel.table.b-table.table-bordered.table-sm.b-table-fixed`, first column 20%
(`<colgroup><col width="20%"></colgroup>`). **No header row.** Label cells are plain (left-aligned, normal weight;
see Q9).

Rows in this exact order:

| # | Label (left cell, verbatim) | Shown when | Value cell | Source |
|---|---|---|---|---|
| 1 | `Title` | qvis: `connection.title && connection.title > 0` (effectively never, Q1). **FIX**: `connection.title.length > 0` | `connection.title` | `:7-10` |
| 2 | `Description` | `connection.description && connection.description.length > 0` | `connection.description` | `:11-14` |
| 3 | `Vantage point` | `connection.vantagePoint` (always truthy) | line 1 (if `vantagePoint.name !== ''`, see Q8): `<span>{name}<br/></span>`; line 2: if `type === "network"`: `<span>{type} : with {flow} perspective</span>` else `<span>{type}</span>`. `undefined` renders as empty text | `:15-22` |
| 3a | `Event schemas` | **NEW**; `connection.eventSchemas.length > 0` | each URI on its own line (`<br/>`-separated), verbatim, file order | main-schema §27.2 |
| 3b | `QUIC version` | **NEW** (S17); `stats.quicVersion !== undefined` | the `chosen_version` string verbatim (e.g. `00000001`) | §9.12 N7 |
| 3c | `ALPN` | **NEW** (S17); `stats.alpn !== undefined` | the decoded ALPN text verbatim (e.g. `h3`) | §9.12 N7 |
| 4 | `H3 connection headers` | `H3headersSummary !== undefined` (§3.9) | `<div>` containing: `User Agent ` `<i><u>{ua}</u></i>` ` connected to Server ` `<i><u>{server}</u></i>` ` at ` `<i><u>{authority}</u></i>` | `:23-28` |
| 5 | `Event count` | always | `connection.getEvents().length` | `:29-32` |
| 6 | `Events` | always | nested "Events" table (2.7.1) | `:34-64` |
| 7 | `Frame count` | always | `totalFrameCount` (§3.5) | `:66-69` |
| 8 | `Frames` | always | nested "Frames" table (2.7.2) | `:70-99` |
| 9 | `Encryption level count` | always | number of distinct packet types (§3.6) | `:101-104` |
| 10 | `Encryption levels` | always | if ≥ 1 packet type: nested table (2.7.3); else danger cell **`None of the events in this trace had data.header.packet_type set!`** | `:105-136` |
| 11 | label in §2.7.4 | always | nested table (2.7.4) if guard passes, else the **same** danger text `None of the events in this trace had data.header.packet_type set!` (Q5) | `:137-187` |
| 12 | label in §2.7.5 | always | nested table (2.7.5) if guard passes, else danger cell **`No stream level flow control limits set`** (Q6) | `:191-251` |

Examples of row 3 (hosted qvis): `TODO` / `network : with client perspective`; `aioquic` / `client`;
`Probably server, because debugging congestion stuff` / `server`. A trace without `vantage_point` (loader default
`{name:"No VantagePoint set", type:"unknown", flow:"unknown"}`) shows `No VantagePoint set` / `unknown`. A
`network` vantage point without `flow` shows `network : with  perspective` (two spaces in the source text, one
rendered).

Danger cells are `b-td variant="danger"` → `<td class="table-danger">` (Bootstrap 4 background `#f5c6cb`, text
colour unchanged). They span only the value column.

### 2.7 Nested tables (value cells of rows 6, 8, 10, 11, 12)

All nested tables are `b-table-simple fixed small borderless responsive style="border-bottom: 0px;"` →
`div.table-responsive[style="border-bottom: 0px;"] > table.table.b-table.table-borderless.table-sm.b-table-fixed`
with `<colgroup><col width="20%"></colgroup>` (first column 20% of the nested table; the remaining three columns
share the rest equally because of `table-layout: fixed`). They have no `thead`: the first `tbody` row uses `b-th`
cells (`<th role="rowheader" scope="row">`, bold). Each nested table keeps Bootstrap's `margin-bottom: 1rem`, which
produces the blank space under every nested table in the screenshots. Nested tables always have **4 columns**; the
first and/or last column is an intentionally empty spacer so the columns line up with the Events table
("left empty on purpose to get horizontal alignment with the table above", `:77`).

#### 2.7.1 Events (`:37-62`)

Header row: `Category` | `Event type` | `Event count` | `% of total occurence` (typo "occurence" is verbatim,
PARITY).

Body: for each namespace (qvis: category) in `connection.getLookupTable()` iteration order (first-seen order), for
each event type in that namespace's map (first-seen order) one row:

| cell | content |
|---|---|
| 1 | only on the **first** row of the namespace: the namespace string, with `rowspan = number of types in that namespace`; omitted on the following rows |
| 2 | event type string |
| 3 | number of events of that type |
| 4 | progress bar (2.8) with `value = count`, `max = connection.getEvents().length` |

#### 2.7.2 Frames (`:73-97`)

Header row: *(empty)* | `Frame type` | `Frame count` | `% of total occurence`.

Body: one row per frame type in first-seen order (§3.5): *(empty)* | frame type | count | progress bar with
`value = count`, `max = totalFrameCount`.

#### 2.7.3 Encryption levels (`:108-131`)

Header row: *(empty)* | `Encryption level` | `Packet count` | *(empty)*.

Body: one row per packet type in first-seen order (§3.6): *(empty)* | packet type (`initial`, `handshake`, `0RTT`,
`1RTT`, `retry`, `version_negotiation`, `stateless_reset`, `unknown`, or any other string) | count | *(empty)*.

#### 2.7.4 Connection-level flow control (`:137-187`)

Left (label) cell, verbatim, with line breaks:

```
Connection-level Flow Control evolution<br/>(MAX_DATA, initial_max_data)<br/><br/>
Read as: viewpoint allows the other side to send this much data on the entire connection (all streams combined)
```

Value cell (if the guard passes, §7 Q5): nested table.

| Row | Cells |
|---|---|
| header | *(empty)* \| `Viewpoint` \| `Evolution (bytes)` \| *(empty)* |
| local | *(empty)* \| `Local (` + `vantagePoint.type` + `)` \| one `<p>` per value of the local list (§3.7) \| *(empty)* |
| remote | *(empty)* \| `Remote (` + (`vantagePoint.type === "client"` ? `server` : `client`) + `)` \| one `<p>` per value of the remote list \| *(empty)* |

Both rows are always present, even with empty lists (hosted qvis: `Local (network)` with an empty evolution cell).
Each value is a JavaScript number rendered with `String(n)` (`NaN` renders as `NaN`). The `<p>` elements keep
Bootstrap's `margin-bottom: 1rem` (visible vertical gaps between values).

Examples (hosted qvis): `Local (client)` → `1048576`, `1048576`; `Remote (server)` → `131072`.
For `type` = `network` or `unknown` the labels are `Local (network)` / `Remote (client)` and `Local (unknown)` /
`Remote (client)` (PARITY quirk: "remote" is labelled `client` for every non-client type).

#### 2.7.5 Stream-level flow control (`:191-251`)

Left (label) cell, verbatim:

```
Stream-level Flow Control evolution<br/>(MAX_STREAM_DATA, initial_max_stream_data_*)<br/><br/>
Read as: viewpoint allows the other side to send this much data on each individual stream
```

Value cell (if the guard passes, §7 Q6): nested table with two sections in one `tbody`:

| Row | Cells |
|---|---|
| header 1 (`th`) | *(empty)* \| `Local Streams (` + `vantagePoint.type` + `)` \| `Evolution` \| *(empty)* |
| one per local map entry | *(empty)* \| key (`bidi_local`, `bidi_remote`, `uni_remote` or a stream ID such as `0`) \| one `<p>` per value \| *(empty)* |
| header 2 (`th`) | *(empty)* \| `Remote Streams (` + (`type === "client"` ? `server` : `client`) + `)` \| `Evolution` \| *(empty)* |
| one per remote map entry | same shape |

Note the column header is `Evolution` here, not `Evolution (bytes)`.

Example (hosted qvis, `DEMO_10_parallel_streams`): Local Streams (client): `bidi_local` 1048576, `bidi_remote`
1048576, `uni_remote` 1048576; Remote Streams (server): `bidi_local` 65536, `bidi_remote` 65536, `uni_remote` 65536.
Example (`DEMO_new_cid`): Local Streams (network) with no rows, Remote Streams (client): `0` → `80762`.

### 2.8 Progress bar (bootstrap-vue 2.0.4 `b-progress`, `:57`, `:93`)

qvis: `<b-progress :value="v" :max="m" :precision="2" show-progress>`. Exact DOM produced (verified on hosted qvis):

```html
<div class="progress">
  <div role="progressbar" aria-valuemin="0" aria-valuemax="{m}" aria-valuenow="{v.toFixed(2)}"
       class="progress-bar" style="width: {100 * (v / m)}%;">{label}</div>
</div>
```

`label` (bootstrap-vue `computedProgress`): with `p = 10 ** 2`,
`label = (Math.round((100 * p * v) / m) / p).toFixed(2)` (bootstrap-vue 2.0.4 `progress-bar.js`; corrected during
the stats review, the first version of this spec left out `Math.round`). **No `%` sign.** Examples: 18/34 → `52.94`,
1/34 → `2.94`, 3/10 → `30.00`, 1/1549 → `0.06`, 3/4000 → `0.08`, 201/20000 → `1.01`. `aria-valuemax` is `String(m)`, `aria-valuenow` is `v.toFixed(2)` (e.g. `18.00`).
`m` is never 0 when a row exists.

Bootstrap 4 styling: `.progress { display:flex; height:1rem; overflow:hidden; font-size:.75rem;
background-color:#e9ecef; border-radius:.25rem }`, `.progress-bar { display:flex; flex-direction:column;
justify-content:center; color:#fff; text-align:center; white-space:nowrap; background-color:#007bff;
transition:width .6s ease }`. Labels on narrow bars overflow the bar as white text on the light-grey track and are
clipped by `.progress` (barely readable on hosted qvis; PARITY).

### 2.9 Styling reference (Bootstrap 4.3.1 + bootstrap-vue 2.0.4 values in effect)

| Selector (qvis) | Values |
|---|---|
| `h3` | `font-size: 1.75rem; font-weight: 500; line-height: 1.2; margin-top: 0; margin-bottom: .5rem`; colour inherits `#app` `#2c3e50` |
| `.table` | `width: 100%; margin-bottom: 1rem; color: #212529; border-collapse: collapse` |
| `.table th, .table td` | `padding: .75rem; vertical-align: top; border-top: 1px solid #dee2e6` |
| `.table-sm th, .table-sm td` | `padding: .3rem` |
| `.table-bordered`, its `th`/`td` | `border: 1px solid #dee2e6`; `thead th` `border-bottom-width: 2px` |
| `.table thead th` | `vertical-align: bottom; border-bottom: 2px solid #dee2e6` |
| `.table .thead-dark th` | `color: #fff; background-color: #343a40; border-color: #454d55` |
| `.table-borderless th, td, thead th, tbody + tbody` | `border: 0` |
| `.table-danger, > th, > td` | `background-color: #f5c6cb` |
| `.b-table.b-table-fixed` | `table-layout: fixed` (long type names overflow into the next cell, e.g. `custom_cc_application_limited` on hosted qvis; PARITY, no word-break) |
| `.table-responsive` | `display: block; width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch` |
| `th` | `text-align: inherit` (reboot), bold (UA) |
| `p` | `margin-top: 0; margin-bottom: 1rem` |
| body text | `font-size: 1rem; line-height: 1.5`; font `'Avenir', Helvetica, Arial, sans-serif` (app-shell) |

### 2.10 Interactions

| Action | Effect |
|---|---|
| Visit `#/stats` with ≥ 1 file loaded and no file selected | auto-select `groups[0]` (§3.2) |
| Choose a file in the dropdown | `config.group = chosen group`; renderer re-renders all tables for that file |
| Load another file while on the page | dropdown gains an option; current selection unchanged |
| Remove the selected file (file manager) | qvis: stale selection keeps rendering, select shows blank. **FIX** (app-shell Q11): selection cleared → auto-select `groups[0]` or show alerts |
| Switch tabs and come back | selection persists (`ConfigurationStore.statisticsConfig` is global) |
| Sequence diagram adds a generated sibling trace to the file | Stats unchanged (generated traces are filtered out) |

No tooltips, no clickable cells, no sorting, no keyboard handling, no notifications.

---

## 3. Algorithms and data flow

### 3.1 Lifecycle and state

```
ConfigurationStore.statisticsConfig : StatisticsConfig { group: ConnectionGroup | undefined = undefined }   (global, ConfigurationStore.ts:13)
StatisticsContainer.created(): console.log("statistics container created", config)                         (StatisticsContainer.vue:33-35)
  ├─ StatisticsConfigurator(config)  → mounted()/updated(): selectDefault() if needed                       (:57-72)
  └─ StatisticsRenderer(config)      → group = config.group
        ├─ File info (pure reads of group)
        └─ for (connection, index) of group.getConnections().filter(c => !c.wasAutoGenerated):
              StatisticsConnectionRenderer(connection, index)      key = "conn_" + index
```

qvis-react:

```
configurationStore.statisticsConfig : { group?: QlogConnectionGroup }
StatisticsContainer   → <StatisticsConfigurator/> + <StatisticsRenderer/>
StatisticsRenderer    → group.getRealConnections().map((c, i) => <StatisticsConnectionRenderer connection={c} index={i} key={i}/>)
StatisticsConnectionRenderer → stats = getTraceStats(connection)   (pure, cached per connection, §3.13)
```

### 3.2 Auto-selection (`StatisticsConfigurator.vue:57-72`)

```ts
// runs in mounted() and in updated() (every re-render of the configurator, e.g. when store.groups changes)
if (config.group === undefined && store.groups.length > 0) {
    console.log("selectDefault: adding new default connection configurator", store.groups);
    config.group = store.groups[0];          // the oldest loaded file
}
```

- qvis-react: `useEffect(() => { if (config.group === undefined && groups.length > 0) update("statisticsConfig",
  { group: groups[0] }); }, [groups, config.group])`.
- The selector (`ConnectionConfigurator`) is only mounted once `config.group` is set, so in qvis it is created with
  the auto-selected group.
- `groups[0]` can be a file whose traces are all TraceErrors; that is fine for this page.

### 3.3 File-level values (`StatisticsRenderer.vue:78-96`)

```ts
traces          = group.getConnections().filter(c => !c.wasAutoGenerated)     // qvis-react: group.getRealConnections()
traceCount      = traces.length
totalEventCount = traces.reduce((n, t) => n + t.getEvents().length, 0)          // qvis returns -1 when no group (never displayed)
```

qvis renders the trace sections only `v-if="totalEventCount > 0"` (`:47`, the condition is evaluated per item but is
the same for all). FIX (Q7): render them always.

### 3.4 Events histogram (`:47-60`)

The table **is** the connection's lookup index: `Map<category, Map<eventType, rawEvent[]>>`, built in event order
(after the loader's time sort), insertion order = first occurrence (`Connection.ts:126-152`). Count = array length,
percentage = count / total events. Nothing is sorted.

qvis-react: `connection.getLookupTable()` (`Map<namespace, Map<type, QlogEvent[]>>`, data-model §3.16.8). Namespaces
are now `quic`, `http3`, `http`, `loglevel`, `simulation`, private namespaces from converters (`tcp`, `tls`, `http2`),
`unknown` (names without a colon) and any non-conforming namespace (e.g. `transport` from pre-final producers; those
events are listed here like any other — this page is the one view that shows them).

### 3.5 Frames (`totalFrameCount` `:389-408`, `frameLUT` `:410-430`)

Shape-based, over **every** event of the trace, in event order:

```ts
for (const ev of trace.getEvents()) {
    const data = ev.data;
    if (data && data.frames) {                     // QUIC: packet_sent/received, packet_lost, frames_*, marked_for_retransmit
        for (const frame of data.frames) { total++; lut.set(frame.frame_type, (lut.get(frame.frame_type) || 0) + 1); }
    }
    if (data && data.frame) {                      // HTTP/3 (and http2 from converters): frame_created / frame_parsed
        total++; lut.set(data.frame.frame_type, (lut.get(data.frame.frame_type) || 0) + 1);
    }
}
```

- QUIC and HTTP/3 frame types share **one** map keyed by the `frame_type` string. Collisions are merged. In the
  latest drafts the only collision is `unknown` (QUIC `UnknownFrame` and `HTTP3UnknownFrame`; draft-02 QUIC used
  `unknown_frame_type`, so qvis never merged them). PARITY of the algorithm (S19, §9.5).
- `frame_type` missing → key `undefined` → a row with an empty "Frame type" cell. PARITY.
- Frames are counted wherever they appear, so the same frame can be counted more than once when a producer logs it
  in several events (e.g. in `quic:packet_sent` and `quic:packet_lost`, or `quic:frames_created` plus
  `quic:packet_sent`). PARITY.
- HTTP Capsule events (`http:capsule_*`, `data.capsule`) are not counted. PARITY.
- Robustness FIX (no visible change for valid files): only iterate `data.frames` when `Array.isArray`, and skip
  `null`/`undefined` elements, in **both** the total and the map (qvis crashes the whole component on a non-iterable
  `frames` or a `null` frame, and iterates the characters of a string).

### 3.6 Encryption levels (`encryptionLUT` `:432-445`)

```ts
for (const ev of trace.getEvents())
    if (ev.data && ev.data.header && ev.data.header.packet_type)
        lut.set(ev.data.header.packet_type, (lut.get(ev.data.header.packet_type) || 0) + 1);
encryptionLevelCount = lut.size;
```

- Counts **events**, not unique packets: in -13 `quic:packet_sent`, `quic:packet_received`, `quic:packet_dropped`,
  `quic:packet_buffered` and `quic:packet_lost` all carry `header.packet_type`, so a lost packet is counted twice
  (sent + lost), a buffered-then-received packet twice, and so on. PARITY.
- Converter traces: `tcp:packet_sent` / `tcp:packet_received` carry `header.packet_type: "1RTT"` and count. qvis
  also counted every TLS record, because its tshark converter gave `tls:record_*` a compat
  `header.packet_type: "1RTT"` (`filemanager/pcapconverter/tcptoqlog.ts:515-518`). The ported converter drops that
  member (converters spec §8.6.4), so on TCP traces the `1RTT` count is the number of TCP packets only (S20, §9.6).
  **Superseded (S20, converters C9):** the member is kept, the count includes the TLS records as in qvis.
- Empty-string `packet_type` is skipped (truthiness). PARITY.
- The label says "Encryption level" although values include `retry`, `version_negotiation`, `stateless_reset`,
  `unknown`. PARITY.

### 3.7 Connection-level flow control (`fillConnectionDataFC` `:447-484`)

For `owner ∈ {"local", "remote"}`, separately, one pass over all events in event order:

```ts
const packetType = owner === "remote" ? "packet_received" : "packet_sent";
for (const ev of trace.getEvents()) {
    // 1. initial limit from the transport parameters
    if (ev.category === "transport" && ev.name === "parameters_set" && ev.data && ev.data.owner === owner) {
        times.push(ev.relativeTime);  values.push(parseInt(ev.data.initial_max_data, 10));
    }
    // 2. updates from MAX_DATA frames in packets the owner sent
    if (ev.category === "transport" && ev.name === packetType && ev.data && ev.data.frames) {
        for (const frame of ev.data.frames)
            if (frame.frame_type === "max_data") { times.push(ev.relativeTime); values.push(parseInt(frame.maximum, 10)); }
    }
}
```

Meaning: "local" = limits the logging endpoint granted its peer (its own `initial_max_data`, `MAX_DATA` frames it
sent); "remote" = limits the peer granted (the peer's transport parameters, `MAX_DATA` frames received). The two
sources interleave in event order. Values are rendered as the list in §2.7.4. `times` are only used for console
output (§3.10).

Latest-draft translation (strict names, no aliasing — ARCHITECTURE §3.1):

| qvis | qvis-react |
|---|---|
| `ev.category === "transport"` | `ev.namespace === "quic"` |
| `ev.name === "parameters_set"` / `"packet_sent"` / `"packet_received"` | `ev.type === ...` (same strings) |
| `ev.data.owner === owner` | `ev.data.initiator === owner` (`Initiator = "local" / "remote"`, quic-events §4.3). `owner` is **not** read |
| `initial_max_data`, `frame.frame_type === "max_data"`, `frame.maximum` | same names (uint64: number or decimal string) |
| `parseInt(x, 10)` | `parseInt(String(x), 10)` (same results for numbers and decimal strings; > 2^53 loses precision as in qvis) |

FIX (Q4): push the parameters_set entry only when `ev.data.initial_max_data !== undefined`. -13 parameters_set is
cumulative (a later event may carry only `tls_cipher` etc.); qvis pushed `NaN` for those. `MAX_DATA.maximum` is
required, so a missing one still yields `NaN` (PARITY).

Not used: `quic:parameters_restored` (0-RTT remembered parameters; no initiator) — PARITY (qvis had no such event).

### 3.8 Stream-level flow control (`fillStreamDataFC` `:486-547`)

Same two passes (`local` with `packet_sent`, `remote` with `packet_received`), building
`Map<string, number[]>` (insertion order = display order) plus a parallel times map:

```ts
// 1. parameters_set of this owner: (RE)SET three pseudo-streams, replacing any previous value list
if (isParamsSet && data.owner === owner) {
    map.set("bidi_local",  [parseInt(data.initial_max_stream_data_bidi_local, 10)]);
    map.set("bidi_remote", [parseInt(data.initial_max_stream_data_bidi_remote, 10)]);
    map.set("uni_remote",  [parseInt(data.initial_max_stream_data_uni, 10)]);
    times.set("bidi_local", [t]); times.set("bidi_remote", [t]); times.set("uni_remote", [t]);
}
// 2. MAX_STREAM_DATA frames in packets of this owner: append to the stream's list
if (isPacketOfOwner && data.frames)
    for (const frame of data.frames)
        if (frame.frame_type === "max_stream_data") {
            const id = "" + frame.stream_id;                 // number 0 and string "0" both become "0"
            (map.get(id) ?? map.set(id, []).get(id)).push(parseInt(frame.maximum, 10));
            (times.get(id) ?? times.set(id, []).get(id)).push(t);
        }
```

- The three keys are labels for the *initial* limits of a category of streams; `initial_max_stream_data_uni` is shown
  as `uni_remote`. The source comment admits the initial values are not merged into the per-stream lists ("TODO: add
  these as initial values to the individual streams as well", `:508-509`). PARITY.
- A later parameters_set of the same owner **replaces** the three lists (it does not append); `Map.set` on an
  existing key keeps its original position. PARITY.
- FIX (Q4): set each of the three keys only when its field is present (`!== undefined`); otherwise leave the key
  untouched (and do not create it). qvis replaced all three with `[NaN]` whenever the event lacked them.
- Translation as in §3.7 (`initiator`, namespace `quic`; field names unchanged).
- MAX_STREAMS / `initial_max_streams_*` are not shown ("TODO: FIXME: not doing the MAX_STREAMS stuff yet",
  `:639-640`). PARITY.

### 3.9 H3 connection headers (`H3headersSummary` `:317-358`)

```ts
const created = lookup("http", "frame_created");     // qvis-react: lookup("http3", "frame_created")
const parsed  = lookup("http", "frame_parsed");      // qvis-react: lookup("http3", "frame_parsed")
let userAgent, server, authority;                    // all undefined
for (const ev of [...created, ...parsed]) {          // ALL created first, then ALL parsed (not chronological)
    const d = ev.data;
    if (!d.frame) continue;
    if (d.frame.headers !== undefined)               // any frame with headers: HEADERS and PUSH_PROMISE alike
        for (const h of d.frame.headers) {
            if      (h.name === "server")     server    = h.value;
            else if (h.name === "user-agent") userAgent = h.value;
            else if (h.name === ":authority") authority = h.value;
        }
}
if (userAgent !== undefined || server !== undefined || authority !== undefined)
    summary = "User Agent <i><u>" + (userAgent ? userAgent : "unknown") + "</u></i>" +
              " connected to Server <i><u>" + (server ? server : "unknown") + "</u></i>" +
              " at <i><u>" + (authority ? authority : "unknown authority") + "</u></i>";
// else summary stays undefined → row hidden
```

- **Last assignment wins** in the created-then-parsed order. For a client trace the request headers
  (`:authority`, `user-agent`) come from `frame_created` and `server` from `frame_parsed`; for a server trace the
  other way round. With many requests, the last request/response in that order wins.
- Comparisons are exact and case-sensitive (HTTP/3 field names are lowercase anyway).
- A header with the right name but no value **overwrites** an earlier value with `undefined` (PARITY).
- Presence test uses `!== undefined`, display uses truthiness: an empty-string value shows the row with `unknown`.
- Latest drafts (h3-events §4.2.2): `HTTP3HTTPField` has optional `name` / `name_bytes` / `value` / `value_bytes`.
  Use `fieldName(h)` and `fieldValue(h)` (h3-events §8.1: `name ?? hexToLatin1(name_bytes)`, `value ??
  hexToLatin1(value_bytes)`).
- Robustness FIX: only iterate `frame.headers` when `Array.isArray`, skip non-object entries (qvis crashes the
  component otherwise).
- Security FIX (Q3): qvis inserts the string with `v-html`, so header values from the file are rendered as HTML
  (script/markup injection). Render React elements with the same structure:

```tsx
<div>User Agent <i><u>{ua || "unknown"}</u></i> connected to Server <i><u>{server || "unknown"}</u></i> at <i><u>{authority || "unknown authority"}</u></i></div>
```

  Hosted qvis example: `User Agent aioquic/0.8.4 connected to Server Apache/2.2.15 (CentOS) at f5quic.com:4433`
  (values italic + underlined).

The row only considers the `http3` namespace (PARITY with qvis's `http` category). HTTP/2 frames from the tshark
converter (`http2:` namespace) do not produce this row (in qvis the TCP converter used category `http2` as well).

### 3.10 Console output: `createStaggeredLines` (`:549-637`)

Every evaluation of the four flow-control getters logs spreadsheet-ready step-function series (the research use
case). The values use `;` as separator and `,` as decimal mark (first `.` only):

```ts
function createStaggeredLines(timesInput: number[], valsInput: number[]): [string, string] {
    let times = "", vals = "", prevVal: number | null = null, prevTime: number | null = null;
    const f = (x: unknown) => ("" + x).replace(".", ",");
    for (let i = 0; i < timesInput.length; ++i) {
        const time = timesInput[i], val = valsInput[i];
        if (prevVal !== null) { times += f(time) + ";"; vals += f(prevVal) + ";"; }   // horizontal step
        times += f(time) + ";"; vals += f(val) + ";";
        prevTime = time; prevVal = val;
    }
    times += f((prevTime as number) + 200) + ";";   // extend the last value by 200 ms
    vals  += f(prevVal) + ";";
    return [times, vals];
}
// empty input → ["200;", "null;"]   (null + 200 === 200)
// times [1.5, 3], vals [100, 200] → ["1,5;3;3;203;", "100;100;200;200;"]
```

Messages (verbatim prefixes; `index` is the **0-based** trace index, unlike the 1-based heading):

```
"Connection-level FC TIMES for remote viewpoint of Trace " + index + ": ", times
"Connection-level FC for remote viewpoint of Trace " + index + ": ", vals
"Connection-level FC TIMES for local viewpoint of Trace " + index + ": ", times
"Connection-level FC for local viewpoint of Trace " + index + ": ", vals
"Stream-level FC TIMES for remote viewpoint of Trace " + index + ", stream " + key + ": ", times
"Stream-level FC for remote viewpoint of Trace " + index + ", stream " + key + ": ", vals
"Stream-level FC TIMES for local viewpoint of Trace " + index + ", stream " + key + ": ", times
"Stream-level FC for local viewpoint of Trace " + index + ", stream " + key + ": ", vals
```

Emission order (measured on hosted qvis during the stats review; the list above is the message catalogue, not the
order): connection-level local, connection-level remote, stream-level remote, stream-level local (the order in which
qvis's template evaluates its getters).

In qvis the local stream-level messages are only logged when the stream-level table is rendered (remote map
non-empty), because that getter is evaluated lazily inside the `v-if`. qvis-react: compute the series once per
connection (in the cached stats, §3.13) and emit the same messages with **`console.debug`** once per computation
(S15). Port `createStaggeredLines` as an exported pure function with unit tests.

Other console output: `statistics container created` (+config), `StatisticsConfigurator:onGroupSelected : `
(+config, group), `selectDefault: adding new default connection configurator` (+groups),
`Selected a new group` (shared selector). Optional in the port (`console.debug`).

### 3.11 Vue reactivity behaviour that explains qvis's numbers (and what React must do instead)

The component keeps its lookup tables in instance fields and *mutates them inside computed getters*:

- `frameLookupTable`, `encryptionLookupTable` (`Map`s) and `flowControlRemote`/`flowControlLocal` (objects of
  arrays and `Map`s) are reactive **properties**; the getters `frameLUT`, `encryptionLUT`, `connectionDataFC*`,
  `streamDataFC*` add to them without clearing.
- `beforeUpdate()` (`:364-387`) replaces all of them with fresh, empty instances. Replacing the property invalidates
  the computed caches, so the next render recomputes from empty structures. Result: the displayed numbers are
  always correct, but **every** component update re-scans all events about seven times.
- `h3Headers` is initialised to `undefined`, which vue-class-component does **not** make reactive. Its reset in
  `beforeUpdate` therefore does not invalidate `H3headersSummary`; the getter is recomputed only when `connection`
  changes, and always re-derives the value from scratch, so it is correct. (Had `h3Headers` been reactive, setting
  it inside the getter would have caused an update loop.)
- `totalFrameCount` deliberately does not share state with `frameLUT` ("Reactivity strikes again! ... infinite update
  loops", `:392`).

React rule: compute all statistics with a **pure function from a connection to an immutable result object**, never
accumulate into component state or long-lived maps. Cache by connection identity (events never change after load;
data-model §3.16). Labels that can change at runtime (`title`, `description`, `vantagePoint`, via the sequence
diagram's setters) are read at render time, keyed on the store `revision`.

### 3.12 Performance

- qvis scans every event ~7 times per trace render (plus the lookup table). For the 31 MB "massive" demo this is
  noticeable but acceptable. qvis-react: **one** pass per connection for frames, encryption levels and flow control,
  plus two `lookup()` arrays for the H3 headers; result cached in a `WeakMap<QlogConnection, TraceStats>`.
- Files with many traces / `group_id` slices render one large table each (PARITY; no virtualisation). Stream maps
  with thousands of `MAX_STREAM_DATA` values produce thousands of `<p>` elements (PARITY).
- Never put `QlogEvent` arrays into React state.

### 3.13 Reference implementation (qvis-react, normative behaviour)

```ts
// src/components/stats/data/computeStatistics.ts   (pure; no React, no DOM)
import type { QlogConnection, QlogConnectionGroup } from "@/model";
import { fieldName, fieldValue } from "@/qlog/schema/h3";        // h3-events digest §8.1

export interface FCSeries { values: number[]; times: number[] }
export interface TraceStats {
  eventCount: number;
  frameCount: number;
  frames: Array<[frameType: unknown, count: number]>;             // first-seen order
  encryptionLevels: Array<[packetType: string, count: number]>;   // first-seen order
  connectionFC: { local: FCSeries; remote: FCSeries };
  streamFC: { local: Map<string, FCSeries>; remote: Map<string, FCSeries> };
  h3?: { userAgent?: string; server?: string; authority?: string };   // undefined → row hidden
  quicVersion?: string;                                           // NEW row 3b (§9.12 N7); undefined → row hidden
  alpn?: string;                                                  // NEW row 3c (§9.12 N7); undefined → row hidden
}

const STREAM_PARAMS: Array<[key: string, field: string]> = [
  ["bidi_local",  "initial_max_stream_data_bidi_local"],
  ["bidi_remote", "initial_max_stream_data_bidi_remote"],
  ["uni_remote",  "initial_max_stream_data_uni"],
];
const int = (x: unknown) => parseInt(String(x), 10);

export function computeTraceStats(conn: QlogConnection): TraceStats {
  const frameMap = new Map<unknown, number>();
  const encMap = new Map<string, number>();
  let frameCount = 0;
  const fc = {
    local:  { conn: { values: [], times: [] } as FCSeries, streams: new Map<string, FCSeries>() },
    remote: { conn: { values: [], times: [] } as FCSeries, streams: new Map<string, FCSeries>() },
  };
  for (const ev of conn.getEvents()) {
    const d: any = ev.data;                                   // always an object in the model
    // frames (3.5)
    if (d.frames) {
      if (Array.isArray(d.frames)) for (const f of d.frames) {
        if (f == null) continue;
        frameCount++; frameMap.set(f.frame_type, (frameMap.get(f.frame_type) || 0) + 1);
      }
    }
    if (d.frame) { frameCount++; frameMap.set(d.frame.frame_type, (frameMap.get(d.frame.frame_type) || 0) + 1); }
    // encryption levels (3.6)
    if (d.header && d.header.packet_type) encMap.set(d.header.packet_type, (encMap.get(d.header.packet_type) || 0) + 1);
    // flow control (3.7, 3.8)
    if (ev.namespace !== "quic") continue;
    const t = ev.relativeTime;
    if (ev.type === "parameters_set" && (d.initiator === "local" || d.initiator === "remote")) {
      const o = fc[d.initiator as "local" | "remote"];
      if (d.initial_max_data !== undefined) { o.conn.values.push(int(d.initial_max_data)); o.conn.times.push(t); }   // FIX Q4
      for (const [key, field] of STREAM_PARAMS)
        if (d[field] !== undefined) o.streams.set(key, { values: [int(d[field])], times: [t] });                     // FIX Q4
    } else if ((ev.type === "packet_sent" || ev.type === "packet_received") && Array.isArray(d.frames)) {
      const o = ev.type === "packet_sent" ? fc.local : fc.remote;
      for (const f of d.frames) {
        if (f == null) continue;
        if (f.frame_type === "max_data") { o.conn.values.push(int(f.maximum)); o.conn.times.push(t); }
        else if (f.frame_type === "max_stream_data") {
          const id = "" + f.stream_id;
          let s = o.streams.get(id); if (!s) { s = { values: [], times: [] }; o.streams.set(id, s); }
          s.values.push(int(f.maximum)); s.times.push(t);
        }
      }
    }
  }
  return {
    eventCount: conn.getEvents().length, frameCount,
    frames: [...frameMap], encryptionLevels: [...encMap],
    connectionFC: { local: fc.local.conn, remote: fc.remote.conn },
    streamFC: { local: fc.local.streams, remote: fc.remote.streams },
    h3: computeH3Headers(conn),
    ...computeQuicIdentity(conn),                                 // NEW rows 3b/3c, §9.12 N7
  };
}

export function computeH3Headers(conn: QlogConnection): TraceStats["h3"] {
  let userAgent: string | undefined, server: string | undefined, authority: string | undefined;
  for (const ev of [...conn.lookup("http3", "frame_created"), ...conn.lookup("http3", "frame_parsed")]) {
    const frame: any = (ev.data as any).frame;
    if (!frame || frame.headers === undefined || !Array.isArray(frame.headers)) continue;
    for (const h of frame.headers) {
      if (h == null || typeof h !== "object") continue;
      const name = fieldName(h);
      if (name === "server") server = fieldValue(h);
      else if (name === "user-agent") userAgent = fieldValue(h);
      else if (name === ":authority") authority = fieldValue(h);
    }
  }
  return userAgent !== undefined || server !== undefined || authority !== undefined ? { userAgent, server, authority } : undefined;
}

const cache = new WeakMap<QlogConnection, TraceStats>();
export function getTraceStats(conn: QlogConnection): TraceStats {
  let s = cache.get(conn);
  if (!s) { s = computeTraceStats(conn); cache.set(conn, s); logStaggeredSeries(conn, s); }
  return s;
}

export function computeFileStats(group: QlogConnectionGroup) {
  const traces = group.getRealConnections();
  return { traces, traceCount: traces.length, totalEventCount: traces.reduce((n, c) => n + c.getEvents().length, 0) };
}

export function progressLabel(value: number, max: number): string {     // bootstrap-vue computedProgress, precision 2
  const p = 10 ** 2;
  return (Math.round((100 * p * value) / max) / p).toFixed(2);
}
```

Notes on the sketch:

- The frame/encryption checks reproduce qvis's truthiness exactly except for the `Array.isArray` / null guards.
- The FC branch uses `else if` because one event cannot be both `parameters_set` and a packet event (same results
  as qvis's two independent `if`s).
- `logStaggeredSeries` emits the eight message kinds of §3.10 (remote then local, connection-level then each stream
  key in map order) with `console.debug`, passing the `index` of the trace in `getRealConnections()`; since the cache
  is per connection, pass the index from the component or log from the component's effect instead. Either is fine;
  logging is not part of the visual contract.

### 3.14 Worked example (golden test vector, latest drafts)

Fixture `tests/fixtures/latest/stats-basic.qlog` (suggested; a hand-written -14 contained file):

```json
{ "file_schema": "urn:ietf:params:qlog:file:contained", "serialization_format": "application/qlog+json",
  "title": "stats fixture",
  "traces": [ { "title": "T", "vantage_point": { "type": "client" },
    "event_schemas": ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"],
    "events": [
      { "time": 0,  "name": "quic:parameters_set", "data": { "initiator": "local", "initial_max_data": 1000,
          "initial_max_stream_data_bidi_local": 100, "initial_max_stream_data_bidi_remote": 200, "initial_max_stream_data_uni": 300 } },
      { "time": 1,  "name": "quic:packet_sent", "data": { "header": { "packet_type": "initial", "packet_number": 0 },
          "frames": [ { "frame_type": "crypto", "offset": 0, "raw": { "length": 10 } }, { "frame_type": "padding" } ] } },
      { "time": 5,  "name": "quic:packet_received", "data": { "header": { "packet_type": "initial", "packet_number": 0 },
          "frames": [ { "frame_type": "ack", "acked_ranges": [[0]] }, { "frame_type": "crypto", "offset": 0, "raw": { "length": 90 } } ] } },
      { "time": 6,  "name": "quic:parameters_set", "data": { "initiator": "remote", "initial_max_data": "5000",
          "initial_max_stream_data_bidi_local": 400 } },
      { "time": 7,  "name": "quic:parameters_set", "data": { "initiator": "local", "tls_cipher": "AES_128_GCM_SHA256" } },
      { "time": 8,  "name": "http3:frame_created", "data": { "stream_id": 0, "frame": { "frame_type": "headers",
          "headers": [ { "name": ":authority", "value": "example.org" }, { "name": "user-agent", "value": "ua/1" } ] } } },
      { "time": 9,  "name": "quic:packet_sent", "data": { "header": { "packet_type": "1RTT", "packet_number": 1 },
          "frames": [ { "frame_type": "stream", "stream_id": 0, "raw": { "length": 20 } }, { "frame_type": "max_data", "maximum": 2000 },
                      { "frame_type": "max_stream_data", "stream_id": 3, "maximum": 150 } ] } },
      { "time": 12, "name": "http3:frame_parsed", "data": { "stream_id": 0, "frame": { "frame_type": "headers",
          "headers": [ { "name": ":status", "value": "200" }, { "name": "server", "value": "<b>srv</b>" } ] } } },
      { "time": 13, "name": "quic:packet_received", "data": { "header": { "packet_type": "1RTT", "packet_number": 1 },
          "frames": [ { "frame_type": "max_stream_data", "stream_id": "0", "maximum": "7000" } ] } },
      { "time": 14, "name": "loglevel:info", "data": { "message": "hi" } } ] } ] }
```

Expected (qvis-react, with the FIXes):

| Item | Value |
|---|---|
| File info | `Filename` = load name, `Title` = `stats fixture`, `qlog version` = `urn:ietf:params:qlog:file:contained`, NEW `Serialization format` = `application/qlog+json`, `Trace count` = `1`, `Total event count` = `10` |
| Trace 1 | `Title` = `T` (FIX Q1); `Vantage point` = `client` (single line, FIX Q8); NEW `Event schemas` = the two URIs |
| H3 connection headers | `User Agent ` *ua/1* ` connected to Server ` *&lt;b&gt;srv&lt;/b&gt;* (literal text, FIX Q3) ` at ` *example.org* |
| Event count | `10` |
| Events | `quic`: `parameters_set` 3 `30.00`, `packet_sent` 2 `20.00`, `packet_received` 2 `20.00`; `http3`: `frame_created` 1 `10.00`, `frame_parsed` 1 `10.00`; `loglevel`: `info` 1 `10.00` |
| Frame count | `10` |
| Frames | `crypto` 2 `20.00`, `padding` 1 `10.00`, `ack` 1 `10.00`, `headers` 2 `20.00`, `stream` 1 `10.00`, `max_data` 1 `10.00`, `max_stream_data` 2 `20.00` |
| Encryption level count / levels | `2`; `initial` 2, `1RTT` 2 |
| Connection-level FC | `Local (client)`: `1000`, `2000` (qvis: `1000`, `NaN`, `2000`); `Remote (server)`: `5000` |
| Stream-level FC | `Local Streams (client)`: `bidi_local` 100, `bidi_remote` 200, `uni_remote` 300, `3` 150 (qvis: the three keys show `NaN` because the t=7 event replaced them); `Remote Streams (server)`: `bidi_local` 400, `0` 7000 (qvis additionally `bidi_remote` `NaN`, `uni_remote` `NaN`) |
| console.debug | `Connection-level FC TIMES for local viewpoint of Trace 0: ` `0;9;9;209;` and `Connection-level FC for local viewpoint of Trace 0: ` `1000;1000;2000;2000;` (relative times; no `reference_time` → relative to the first event) |

Hosted qvis reference values (draft-01 demos, for the legacy parity harness): `DEMO_new_cid`: 34 events,
Frame count 54 (71 after visiting Packetization first, Q12), encryption levels `initial` 3 / `handshake` 5 / `1RTT`
19, `Remote (client)` 97146, remote stream `0` → 80762. `DEMO_spin_bit`: local 32975, 33389; remote 10000017,
10000051; stream-level "No stream level flow control limits set". `DEMO_10_parallel_streams`: 1549 events, 636
frames, encryption levels `initial` 5, `retry` 1, `handshake` 7, `1RTT` 500.

---

## 4. Event and field consumption

Old = qvis draft-02 internal names (category:event), with the qvis read site. New = latest drafts
(namespace:type), read **strictly** (no aliasing of pre-final names or fields; ARCHITECTURE §3.1). §9 gives, for
every row, the exact latest path, the semantic differences and the behaviour when the member is absent.

| Old category/event + fields (qvis site) | New event + fields | Used for | Detection |
|---|---|---|---|
| every event: `category` + type (`DirectEventParser.category` / `.name`, `QlogLoaderV2.ts:331-363`; index `Connection.ts:126-152`; table `StatisticsConnectionRenderer.vue:47-60`) | every `QlogEvent`: `namespace`, `type` (logged `name` split at the first `:`) | Events histogram (via the lookup index) | all events |
| `connection.getEvents().length` (`:31`, `:57`; `StatisticsRenderer.vue:82-96`) | number of `QlogEvent`s of the connection | Event count, histogram percentages, Total event count | all events |
| every event: `data.frames[].frame_type` (`:389-430`; in practice `transport:packet_sent`, `packet_received`, `frames_processed`, `recovery:packet_lost`, `marked_for_retransmit`) | every event with `data.frames`: `quic:packet_sent`, `quic:packet_received`, `quic:packet_lost`, `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed`, `quic:marked_for_retransmit` (also non-conforming names that carry `frames`, §9.1) | Frame count, Frames histogram | shape (`data.frames` truthy) |
| every event: `data.frame.frame_type` (`:402-404`, `:423-426`; `http:frame_created`, `http:frame_parsed`; qvis TCP converter `http2:frame_*`, `tcptoqlog.ts:577`, `:684`) | every event with `data.frame`: `http3:frame_created`, `http3:frame_parsed` (+ `http2:frame_*` from the tshark converter) | Frame count, Frames histogram | shape (`data.frame` truthy) |
| every event: `data.header.packet_type` (`:432-445`; `transport:packet_sent`, `packet_received`, `packet_dropped`, `packet_buffered`, `recovery:packet_lost`; qvis TCP converter: TCP packets as `transport:packet_*` and `tls:record_*`, both `"1RTT"`, `tcptoqlog.ts:212-213`, `:515-518`) | every event with `data.header.packet_type`: `quic:packet_sent`, `quic:packet_received`, `quic:packet_dropped`, `quic:packet_buffered`, `quic:packet_lost` (+ `tcp:packet_sent` / `tcp:packet_received` from the tshark converter; `tls:record_*` keep the compat `"1RTT"`, converters C9, S20 superseded) | Encryption level count / table; connection-level FC guard (Q5) | shape |
| `transport:parameters_set` `.owner`, `.initial_max_data` (`:466-471`) | `quic:parameters_set` **`.initiator`**, `.initial_max_data` | connection-level FC initial values | namespace + type |
| `transport:parameters_set` `.initial_max_stream_data_bidi_local`, `_bidi_remote`, `_uni` (`:505-518`) | `quic:parameters_set` same three fields | stream-level FC rows `bidi_local`, `bidi_remote`, `uni_remote` | namespace + type |
| `transport:packet_sent` / `packet_received` `.frames[]` with `frame_type: "max_data"`, `.maximum` (`:474-482`) | `quic:packet_sent` / `quic:packet_received`, MaxDataFrame `.maximum` | connection-level FC updates (sent = local, received = remote) | namespace + type + frame_type |
| same, `frame_type: "max_stream_data"`, `.stream_id`, `.maximum` (`:521-544`) | MaxStreamDataFrame `.stream_id`, `.maximum` | stream-level FC per-stream rows | namespace + type + frame_type |
| `http:frame_created` / `frame_parsed` (`lookup(http, …)`, `:321-322`), guard `!data.frame` → skip (`:332-334`), any frame with `headers !== undefined` (HEADERS and PUSH_PROMISE, `:336`), `headers[].{name,value}` for `server`, `user-agent`, `:authority` (`:337-347`). The qvis netlog converter produced these from `HTTP3_HEADERS_SENT` / `HTTP3_HEADERS_DECODED` | `http3:frame_created` / `frame_parsed` `.frame.headers[]` `HTTP3HTTPField` `{name?, name_bytes?, value?, value_bytes?}` (the ported netlog converter emits `http3:*`) | H3 connection headers row | `lookup("http3", ...)` |
| event `relativeTime` (`DirectEventParser.relativeTime`, `QlogLoaderV2.ts:289-299`; read at `:469`, `:478`, `:515-517`, `:542`) | `QlogEvent.relativeTime` | console step series only | |
| trace `vantage_point.{name,type,flow}` (`:15-20`, `:156`, `:170`, `:202`, `:225`; loader default `QlogLoaderV2.ts:138-144`) | same | Vantage point row; Local/Remote labels | |
| trace `title`, `description` (`:7-14`); TraceError `uri`, `error_description` (placeholder `QlogLoaderV2.ts:49-56`); `group_id` slices (`"Group <id> : "` prefix) | same (`""` default; `"Group <id> : "` prefix for slices; `ERROR` + `uri : error_description` for TraceErrors, `uri` now optional) | Title / Description rows | |
| file `traces[]` (traces and TraceErrors, split by `group_id`) minus generated clones (`StatisticsRenderer.vue:36-39`, `:47`, `:82-96`) | `traces[]` (`Trace` / `TraceError`; JSON-SEQ: the single `trace`), split by `group_id`; `group.getRealConnections()` | Trace count, Total event count, one "Trace N info" section per entry | |
| (none) | trace `event_schemas` | NEW Event schemas row | |
| (none) | `quic:version_information` `.chosen_version`; `quic:alpn_information` `.chosen_alpn.{string_value,byte_value}` | NEW `QUIC version` / `ALPN` rows (S17) | namespace + type |
| file name (not a qlog member: `group.filename`, set by the file loader, `StatisticsRenderer.vue:16-19`) | same | `Filename` row | |
| file `title`, `description` (`:20-27`) | same | File info rows | |
| file `qlog_version` (`group.version`, `:28-31`) | `file_schema` (via `group.version`) | `qlog version` row | |
| (none; qvis stored `qlog_format` in `group.format` but never displayed it) | file `serialization_format` | NEW Serialization format row | |
| file `summary` (`:32-35`) | removed in -14 | (Summary row dropped) | |
| (none) | `group.diagnostics` | NEW Diagnostics row | |

Implementation-specific and legacy fields:

| Field | Status |
|---|---|
| `owner` on `parameters_set` (draft-02, still emitted by some pre-final producers) | not read. Such events are usually also non-conforming by name (`transport:parameters_set`) and then appear only in the Events histogram under their logged namespace; DM3 toast (ARCHITECTURE §3.1) explains it. quic-go master emits `initiator` (on `transport:parameters_set`, which is still ignored by FC, §9.1) |
| `qvis-injected FILLER (deal with incorrectly guesstimated frame size)` frame type | qvis-only artefact of the packetization pre-processor mutating raw frames; cannot occur in qvis-react (Q12) |
| frame-level `length` (draft-02) vs `raw.length` (-13) | not used by Stats |
| `max_streams` frames, `initial_max_streams_*` | counted in Frames only; no FC table (PARITY with qvis TODO, `:639-640`) |
| `FCData.streamsUniFCList` / `streamsBidiFCList` (`:278-279`, reset at `:301-302`, `:310-311`, `:376-377`, `:384-385`) | declared and reset but never filled (the MAX_STREAMS TODO); DROP |
| qvis TCP converter category `transport` for TCP packets (`pcapconverter/qlog_tcp_tls_h2.ts:3-7`: `EventCategory.tcp = "transport"`) | qvis's FC passes therefore also iterated TCP packets, which never carry `frames`, so they never contributed. qvis-react: `tcp:` namespace, ignored by FC; same (empty) result. The Events histogram groups them under `tcp` instead of `transport` (§9.4) |
| `http:capsule_*` (`data.capsule`) | listed in Events only, not counted as frames |
| `http3:datagram_created` / `datagram_parsed` (`quarter_stream_id`, `raw`), `quic:udp_datagrams_*` (`raw[]`) | no `frame`, `frames` or `header`: listed in Events only |
| `index` prop (0-based trace index) | not a qlog member; used only in console messages (§3.10) |

Source check (2026-11-01): `StatisticsRenderer.vue`, `StatisticsConnectionRenderer.vue` (all 646 lines), `Connection.ts`
(lookup index, `parseEvent`), `QlogLoaderV2.ts` (`DirectEventParser`, TraceError, vantage default) and the qvis
converters were re-read against this table. Rows added in this pass: event count, file name, trace list, TraceError
members, the `!data.frame` guard and PUSH_PROMISE headers, the qvis TCP converter's `transport` category and TLS
`packet_type`, the dead `streamsUniFCList` / `streamsBidiFCList`, and the H3 datagram / UDP events that are not counted.

---

## 5. URL query parameters and global state

Query parameters: the stats page reads **none**. Sticky parameters (`file`, `list`, `file1..N`, …) load files at
startup through the shell (app-shell §3.3, §3.5); afterwards the auto-selection picks `groups[0]`. There is no
parameter to pre-select a file on this page (PARITY; do not add one).

Global state:

| State | qvis | qvis-react |
|---|---|---|
| Selected file | `ConfigurationStore.statisticsConfig.group` (Vuex, survives route changes) | `configurationStore.statisticsConfig.group` (zustand), updated with `update("statisticsConfig", { group })`; cleared by `removeGroup` scrub (app-shell Q11) |
| Loaded files | `ConnectionStore.groups` | `connectionStore.groups` (+ `revision` for in-place model changes) |
| Loading indicator | `ConnectionStore.outstandingRequestCount` | `connectionStore.outstandingRequestCount` (drives `<NoTraceAlerts/>`) |
| Per-trace scratch (`frameLookupTable` etc.) | component instance fields | none (pure function + `WeakMap` cache) |

The page writes nothing into the model.

---

## 6. Edge cases, error handling, notifications

### 6.1 Messages (verbatim)

| Where | Text | Kind |
|---|---|---|
| configurator | `Select a file via the dropdown(s) below to view its statistics` | intro paragraph |
| configurator | `Please load a trace file to visualize it` | danger alert |
| configurator | `Loading files...` | warning alert |
| Encryption levels cell; Connection-level FC cell (guard fails) | `None of the events in this trace had data.header.packet_type set!` | `td.table-danger` |
| Stream-level FC cell (guard fails) | `No stream level flow control limits set` | `td.table-danger` |
| H3 row fallbacks | `unknown`, `unknown`, `unknown authority` | inline text |

No toasts. No modal dialogs. Console messages in §3.10.

### 6.2 Edge cases

| Case | qvis | qvis-react |
|---|---|---|
| No files loaded, nothing loading | danger alert; empty bordered box | same |
| Files loading, none finished | warning alert; empty box | same |
| First file finishes while on the page | auto-selects it (configurator `updated()`) | same (effect) |
| Selected file removed | stale tables keep showing; select blank | selection cleared, re-auto-select (FIX, app-shell Q11) |
| File whose traces all have 0 events (incl. only TraceErrors) | File info only (`totalEventCount > 0` guard) | trace sections rendered (FIX Q7): Event count 0, empty nested tables (header row only), Encryption-level and Connection-level danger cells, Stream-level danger cell |
| TraceError placeholder | counted in Trace count; section shows Description `uri : error_description`, Vantage point (empty line +) `unknown`, Event count 0 | Title `ERROR` (FIX Q1), Description (`uri` optional: just `error_description` when absent, data-model §3.16.6), Vantage point `unknown`, zero-event tables |
| `group_id` slices | one "Trace N info" per slice; Title row hidden (Q1) | one per slice, Title `Group <id> : <title>` visible |
| Generated sibling traces (sequence diagram) | excluded from Trace count, Total event count and sections | same (`getRealConnections()`) |
| No `vantage_point` | `No VantagePoint set` / `unknown`; FC labels `Local (unknown)` / `Remote (client)` | same |
| `vantage_point` without `name` | empty first line, then type (Q8) | type only (FIX) |
| `type: "network"` without `flow` | `network : with  perspective` | same (render `flow ?? ""`) |
| Trace without packet events but with `quic:parameters_set` | Connection FC shows the packet_type danger message even though values exist (Q5) | table shown (FIX) |
| Only local stream limits | "No stream level flow control limits set" (Q6; hosted qvis `DEMO_double_vantagepoint` trace 1) | table shown with an empty Remote section (FIX) |
| `parameters_set` without `initial_max_*` (cumulative updates, TLS-only events) | `NaN` entries / `NaN` rows (Q4) | skipped (FIX) |
| `MAX_DATA` / `MAX_STREAM_DATA` without `maximum` | `NaN` | `NaN` (PARITY) |
| uint64 as decimal string | `parseInt` | same |
| uint64 > 2^53 | precision loss | same (PARITY) |
| `frames` not an array / `null` frames / `headers` not an array | TypeError, whole trace section fails to render | guarded (FIX, no visible change for valid input) |
| Frame without `frame_type` | row with empty Frame type | same |
| QUIC and HTTP/3 frame type with the same string (`unknown`) | draft-02 data never collided (QUIC used `unknown_frame_type`); the map would merge any equal string | merged `unknown` row (S19, §9.5) |
| Draft-02 `application_close` frames | own `application_close` row | n/a: -13 logs them as `connection_close` (`error_space: "application"`), counted in the `connection_close` row (§9.5) |
| Header value containing HTML | interpreted as HTML (Q3) | shown as text (FIX) |
| Header field with only `name_bytes`/`value_bytes` | n/a (draft-02 had none) | decoded via `fieldName`/`fieldValue` |
| Event name without colon | category = whole name | namespace `unknown`, type = whole name (data-model §3.16.4) |
| Event name with two or more colons (`ns:a:b`) | type = `a` (`split(":")[1]`) | type = `a:b` (split at the first colon, main-schema digest §12) |
| Non-standard vantage `type` (quic-go endpoint-level traces write `"transport"`) | n/a | shown verbatim: `transport`; FC labels `Local (transport)` / `Remote (client)` (Q10) |
| `event_schemas: []` (quinn) or missing | n/a | `Event schemas` row hidden; the parser's `trace.missing-event-schemas` warning appears in the file-level `Diagnostics` row |
| `http3:frame_*` events without `data.frame` | skipped by the H3 row (`!evt.frame`), not counted as frames | same |
| Pre-final names (`transport:packet_sent`, current quic-go output) | n/a | listed in Events under `transport`; their frames and packet headers still counted by shape; FC tables and the H3 row ignore them (exact `quic:` / `http3:` names only). Full per-producer matrix in §9.13 |
| Very long type names | overflow into the next cell (fixed layout) | same |
| Narrow viewport | horizontal scroll (min-width 1024 px) | same |

---

## 7. Known bugs and quirks

| # | Quirk | qvis location | Decision |
|---|---|---|---|
| Q1 | Trace `Title` row condition `connection.title && connection.title > 0` compares a string with a number: true only for numeric titles > 0, so normal titles ("Connection 1", "Group x : ...", "ERROR") are never shown (confirmed: hosted qvis hides `Connection 1` of `DEMO_new_cid`) | `StatisticsConnectionRenderer.vue:7` | **FIX**: `connection.title.length > 0` (data-model Q20 recommendation) |
| Q2 | Progress labels have no `%` sign and use bootstrap-vue's `computedProgress` rounding | `:57`, `:93` | **PARITY** (§2.8) |
| Q3 | H3 header summary built as an HTML string and inserted with `v-html` (markup/script injection from file contents) | `:26`, `:351-355` | **FIX** (security): React elements, identical visual structure |
| Q4 | `parseInt(undefined)` = `NaN` pushed for `parameters_set` events lacking `initial_max_data`; stream keys replaced with `[NaN]` when the event lacks the stream fields | `:470`, `:510-512` | **FIX**: skip absent fields. Parity alternative (if a strict pixel harness requires it): push unconditionally |
| Q5 | Connection-level FC cell guarded by `encryptionLUT.size > 0` (copy-paste) and shows the packet_type message | `:141`, `:184-186` | **FIX** (minimal superset): show the table when `encryptionLevels.length > 0 \|\| local.values.length > 0 \|\| remote.values.length > 0`, otherwise the original message. Identical to qvis for every trace that has packet events |
| Q6 | Stream-level FC cell guarded by the remote map only; local-only limits are hidden | `:195` | **FIX** (minimal superset): `remote.size > 0 \|\| local.size > 0` |
| Q7 | Trace sections only rendered if the whole file has > 0 events | `StatisticsRenderer.vue:47` | **FIX**: always render (shows TraceError placeholders and empty traces) |
| Q8 | `vantagePoint.name !== ''` is true for `undefined`, rendering an empty first line | `:18` | **FIX**: render the name line only when `typeof name === "string" && name !== ""` |
| Q9 | `id="toplevel"` repeated for every trace (duplicate ids); the scoped rule `#toplevel > tr[role="row"] td:first-of-type {text-align:right; font-weight:bold; padding-right:10px}` never matches (there is a `tbody` in between), and the same dead rule is copied into `StatisticsRenderer.vue` | `:4`, `:259-265`; `StatisticsRenderer.vue:54-60` | **FIX** ids (use class `stats-trace-table`); **PARITY** visuals: do **not** port the rule (labels stay left-aligned, normal weight, as on hosted qvis) |
| Q10 | "Remote" label is `client` for every non-client vantage type (`network`, `unknown`, `server`→`client` is correct) | `:170`, `:225` | **PARITY** |
| Q11 | `Summary` row never shown (`group.summary` never populated by any loader) | `StatisticsRenderer.vue:32-35`; `QlogLoaderV2.ts:39-43` | **DROP** (`summary` removed in main-schema; data-model Q16) |
| Q12 | Visiting Packetization first mutates raw events (filler frames), so Stats then counts a `qvis-injected FILLER (deal with incorrectly guesstimated frame size)` frame type (hosted qvis: `DEMO_new_cid` 54 → 71 frames) | `PacketizationQUICPreProcessor.ts` (data-model Q15) | **FIX** by construction (model is never mutated) |
| Q13 | Every component update re-scans all events ~7 times; lookup tables mutated inside computed getters and reset in `beforeUpdate` | `:364-445` | **FIX** (internal): pure single pass + cache; same numbers |
| Q14 | H3 headers: created events first, then parsed; last write wins; a valueless header overwrites with `undefined`; PUSH_PROMISE headers count too | `:328-349` | **PARITY** |
| Q15 | Frames/encryption counted by data shape across all events, so duplicates across event types (lost, buffered, frames_created) are counted again | `:389-445` | **PARITY** |
| Q16 | "Encryption level" label for packet types that are not encryption levels | `:113` | **PARITY** |
| Q17 | Typo `% of total occurence` | `:44`, `:80` | **PARITY** |
| Q18 | Stream initial limits shown as pseudo-streams `bidi_local` / `bidi_remote` / `uni_remote` and not merged into real stream rows; later `parameters_set` replaces them | `:508-517` | **PARITY** |
| Q19 | Non-iterable `frames`/`headers` or `null` frames crash the component | `:397`, `:417`, `:337`, `:476-477`, `:523-524` | **FIX** (guards) |
| Q20 | Console spam on every render (staggered series) | `:585-633` | **PARITY** content via `console.debug`, once per connection |
| Q21 | Event/frame histograms unsorted (first-seen order) | `:47`, `:83` | **PARITY** |

---

## 8. Porting notes for React

### 8.1 Module breakdown

```
src/views/StatisticsView.tsx                       thin wrapper: <div><StatisticsContainer/></div>   (shell package)
src/components/stats/
  data/StatisticsConfig.ts                         export interface StatisticsConfig { group: QlogConnectionGroup | undefined }  (default { group: undefined })
  data/computeStatistics.ts                        computeTraceStats, computeH3Headers, computeQuicIdentity, getTraceStats (WeakMap cache),
                                                   computeFileStats, progressLabel, createStaggeredLines, logStaggeredSeries
  data/computeStatistics.test.ts                   golden vector §3.14, createStaggeredLines vectors, progressLabel vectors, edge cases §6.2
  StatisticsContainer.tsx                          <div className="home"><StatisticsConfigurator/><StatisticsRenderer/></div>
  StatisticsConfigurator.tsx                       yellow panel, intro, ConnectionConfigurator (mode A), NoTraceAlerts, auto-select effect
  StatisticsRenderer.tsx                           #statistics-container, File info table, maps real traces to StatisticsConnectionRenderer
  StatisticsConnectionRenderer.tsx                 Trace N info table (rows 1-12 + NEW 3a, 3b, 3c)
  StatsProgress.tsx                                exact b-progress markup (§2.8)
  Statistics.css                                   §8.3
  Statistics.test.tsx                              component tests (§8.5)
```

No D3, no imperative renderer, no refs: everything is declarative JSX over a precomputed result.

### 8.2 Component sketches

```tsx
// StatisticsConfigurator.tsx
export function StatisticsConfigurator() {
  const groups = useConnectionStore((s) => s.groups);
  useConnectionStore((s) => s.revision);                      // re-render on in-place model changes (labels)
  const config = useConfigurationStore((s) => s.statisticsConfig);
  const update = useConfigurationStore((s) => s.update);
  useEffect(() => {
    if (config.group === undefined && groups.length > 0) update("statisticsConfig", { group: groups[0] });
  }, [groups, config.group, update]);
  return (
    <div className="stats-configurator">
      <div className="container-fluid">
        <div className="row justify-content-center"><p style={{ marginTop: 10 }}>Select a file via the dropdown(s) below to view its statistics</p></div>
        <div className="row justify-content-center">
          {config.group !== undefined && (
            <ConnectionConfigurator allGroups={groups} group={config.group} canBeRemoved={false}
              allowGroupSelection allowConnectionSelection={false}
              onGroupSelected={(g) => update("statisticsConfig", { group: g })} />
          )}
        </div>
        <NoTraceAlerts />
      </div>
    </div>
  );
}
```

```tsx
// StatisticsConnectionRenderer.tsx (excerpt)
const remoteLabel = (vp: VantagePoint) => (vp.type === "client" ? "server" : "client");
export function StatisticsConnectionRenderer({ connection: c, index }: { connection: QlogConnection; index: number }) {
  useConnectionStore((s) => s.revision);                       // title / vantage point may be renamed
  const s = getTraceStats(c);
  const vp = c.vantagePoint;
  const total = s.eventCount;
  const showConnFC = s.encryptionLevels.length > 0 || s.connectionFC.local.values.length > 0 || s.connectionFC.remote.values.length > 0;
  const showStreamFC = s.streamFC.remote.size > 0 || s.streamFC.local.size > 0;
  return (
    <div>
      <h3>Trace {index + 1} info</h3>
      <div className="table-responsive">
        <table className="stats-table stats-table-bordered stats-table-sm stats-trace-table">
          <colgroup><col width="20%" /></colgroup>
          <tbody>
            {c.title.length > 0 && <tr><td>Title</td><td>{c.title}</td></tr>}
            {c.description.length > 0 && <tr><td>Description</td><td>{c.description}</td></tr>}
            <tr><td>Vantage point</td><td>
              {typeof vp.name === "string" && vp.name !== "" && <span>{vp.name}<br /></span>}
              {vp.type === "network" ? <span>{vp.type} : with {vp.flow ?? ""} perspective</span> : <span>{vp.type}</span>}
            </td></tr>
            {/* NEW 3a Event schemas, NEW 3b QUIC version, NEW 3c ALPN, 4 H3 headers, 5 Event count, 6 Events, ... exactly as §2.6 / §2.7 */}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

Events table rows: iterate `[...c.getLookupTable()]`, and for each namespace `[...typeMap]` with `i === 0` deciding
whether to emit the `rowSpan={typeMap.size}` category cell. Keys: **by position**, exactly qvis's v-for keys
(`"evt_" + index1 + "_" + index2`, `"frame_" + i`, `"enc_" + i`, `"fcsl_" + i` / `"fcsr_" + i`). Content keys (for
example `ns + "\u0000" + type`, the first version of this sketch) make React *move* rows on a file switch, and a moved
progress bar jumps to its new width instead of animating (`transition: width .6s`) from the previous file's value at that
position as in qvis (parity check §10, D2).

Text: every label that interpolates a value is rendered as **one** text node, as Vue's compiled template produces it
(`{"Local (" + type + ")"}`, `{"Trace " + (index + 1) + " info"}`, the H3 row's `{"User Agent "}` / `{" connected to
Server "}` / `{" at "}` around the `<i><u>` elements). JSX like `Local ({type})` creates three text nodes, and Chrome
positions the glyphs after a text-node boundary at slightly different sub-pixel offsets (visible in pixel diffs against
qvis, parity check §10, D1).

Lists of values: `values.map((v, i) => <p key={i}>{String(v)}</p>)` (`String(NaN)` → `NaN`).

### 8.3 CSS (`Statistics.css`) — Bootstrap 4 parity without fighting Bootstrap 5

Bootstrap 5's `.table` styles every cell through `.table > :not(caption) > * > *` (CSS variables, inset box-shadow
for variants, `.5rem`/`.25rem` padding, `#0d6efd` progress), which is hard to neutralise. Use **own class names**
with the Bootstrap 4.3.1 values from §2.9 instead of `.table`/`.progress`:

```css
.stats-configurator { background-color: #fff3cd; padding: 0 10px; }
.stats-configurator .row { padding-bottom: 10px; }
#statistics-container { width: 100%; border: 5px solid #fff3cd; min-height: 200px; }
#statistics-container .stats-inner { width: 50%; min-width: 1024px; margin-left: auto; margin-right: auto; }
#statistics-container h3 { font-size: 1.75rem; font-weight: 500; line-height: 1.2; margin: 0 0 .5rem; }
#statistics-container p { margin-top: 0; margin-bottom: 1rem; }
.stats-table { width: 100%; margin-bottom: 1rem; color: #212529; border-collapse: collapse; table-layout: fixed; background: transparent; }
.stats-table th, .stats-table td { padding: .75rem; vertical-align: top; border-top: 1px solid #dee2e6; }
.stats-table th { text-align: inherit; font-weight: bold; }
.stats-table thead th { vertical-align: bottom; border-bottom: 2px solid #dee2e6; }
.stats-table-sm th, .stats-table-sm td { padding: .3rem; }
.stats-table-bordered, .stats-table-bordered th, .stats-table-bordered td { border: 1px solid #dee2e6; }
.stats-table-bordered thead th { border-bottom-width: 2px; }
.stats-table .stats-thead-dark th { color: #fff; background-color: #343a40; border-color: #454d55; }
.stats-table-borderless, .stats-table-borderless th, .stats-table-borderless td { border: 0; }
.stats-table td.stats-danger { background-color: #f5c6cb; }
.stats-progress { display: flex; height: 1rem; overflow: hidden; font-size: .75rem; background-color: #e9ecef; border-radius: .25rem; }
.stats-progress-bar { display: flex; flex-direction: column; justify-content: center; color: #fff; text-align: center;
                      white-space: nowrap; background-color: #007bff; transition: width .6s ease; }
@media (prefers-reduced-motion: reduce) { .stats-progress-bar { transition: none; } }
```

Wrap every table in `div.table-responsive` (Bootstrap 5's version is equivalent). Nested tables:
`stats-table stats-table-sm stats-table-borderless`; File info table: `stats-table stats-table-bordered
stats-table-sm` with `thead.stats-thead-dark`. Keep `#statistics-container` (id parity, used by tests).

### 8.4 Mapping table (Vue → React)

| qvis | qvis-react |
|---|---|
| `views/Statistics.vue` | `views/StatisticsView.tsx` |
| `StatisticsContainer` (`config` from `ConfigurationStore`) | `StatisticsContainer` (reads `configurationStore` in children) |
| `StatisticsConfigurator.mounted/updated → selectDefault` | `useEffect` auto-select |
| `b-alert` pair | `<NoTraceAlerts/>` (shared) |
| `ConnectionConfigurator` mode A | shared React `ConnectionConfigurator` (app-shell §8.5), `allowGroupSelection`, `allowConnectionSelection={false}` |
| `StatisticsRenderer.totalEventCount` | `computeFileStats(group).totalEventCount` |
| `group.getConnections().filter(!wasAutoGenerated)` | `group.getRealConnections()` |
| `connection.getLookupTable().entries()` | `connection.getLookupTable()` (namespaces) |
| `frameLUT` / `totalFrameCount` / `encryptionLUT` / `connectionDataFC*` / `streamDataFC*` / `H3headersSummary` | fields of `getTraceStats(connection)` |
| `beforeUpdate` resets | not needed (pure function) |
| `b-progress ... show-progress :precision="2"` | `<StatsProgress value max/>` (§2.8) |
| `b-td variant="danger"` | `<td className="stats-danger">` |
| `b-table-simple fixed bordered small responsive` | `div.table-responsive > table.stats-table.stats-table-bordered.stats-table-sm` |
| `v-html` | JSX (`<i><u>…</u></i>`) |
| `qlog.EventCategory.transport` / `http` | `"quic"` / `"http3"` (constants from `src/model/names.ts`) |
| `data.owner` | `data.initiator` |

### 8.5 Tests

Unit (`computeStatistics.test.ts`):

1. Golden vector §3.14: every number, order of namespaces/types/frames/packet types, map key order, FC lists, H3
   summary fields.
2. `progressLabel`: (18, 34) → `52.94`; (1, 34) → `2.94`; (3, 10) → `30.00`; (1, 1549) → `0.06`; (1, 3) → `33.33`;
   (3, 4000) → `0.08`; (201, 20000) → `1.01`.
3. `createStaggeredLines`: `[]` → `["200;", "null;"]`; `[1.5, 3]`/`[100, 200]` → `["1,5;3;3;203;",
   "100;100;200;200;"]`; single point `[2]`/`[7]` → `["2;202;", "7;7;"]`.
4. Edge cases of §6.2: `frames: {}` and `frames: [null]` do not throw; frame without `frame_type`; QUIC `unknown` +
   HTTP/3 `unknown` merged; header via `name_bytes`/`value_bytes`; valueless `server` header after a valued one
   resets to `undefined` (row still shown if another header exists); empty-string user agent shows `unknown`;
   pre-final `transport:parameters_set` with `owner` ignored by FC; `parameters_set` without fields adds nothing;
   second `parameters_set` replaces stream keys in place (position kept); stream id `0` and `"0"` merge.
5. Cache: `getTraceStats(c) === getTraceStats(c)`; clones (sequence diagram) get their own entry.

Component (`Statistics.test.tsx`, Testing Library):

1. No groups, `outstandingRequestCount = 0` → danger alert text; `> 0` → warning text; `#statistics-container`
   present and empty.
2. With groups and empty config → effect selects `groups[0]`; select shows its label
   (`<filename> (<title> : <description>)` format).
3. File info row order and conditional rows (`Title`/`Description` hidden for empty strings; no `Summary` row;
   NEW rows only when data present).
4. Trace sections: one per real connection, headings `Trace 1 info`, `Trace 2 info`; generated sibling excluded;
   TraceError placeholder shows `Title` `ERROR`.
5. Every verbatim label of §2.6/§2.7 (including the two multi-line FC labels and `% of total occurence`).
6. Danger cells: zero packet types → both packet_type messages; FC values without packets → table (Q5 FIX);
   local-only stream limits → table (Q6 FIX); no stream limits → `No stream level flow control limits set`.
7. Progress DOM: `aria-valuemax`, `aria-valuenow` (`18.00`), `style.width`, label text.
8. H3 header value `<b>srv</b>` renders as text (no `<b>` element in the DOM).
9. Switching the selected group re-renders with the new file's numbers (no accumulation across switches).

Latest-draft mapping tests (strict names, mode A/B/C behaviour, NEW rows 3b/3c): §9.15.

E2E (Playwright): load the demo files, open `#/stats`, select each file, assert no console errors and that
`#statistics-container h3` texts start with `File info`; screenshot for the parity harness (legacy draft-02 fixture
on hosted qvis vs the latest-draft equivalent; expect the documented FIX differences: Title row, no NaN, no blank
vantage-point line, NEW rows).

---

## 9. Mapping to latest qlog drafts

This section maps **every** old-schema (qlog draft-02, as read by qvis) member that the stats page consumes (§4) to
the latest drafts, and lists what is new in those drafts and whether this page shows it:

- draft-ietf-quic-qlog-main-schema-14 (digest `qlog-spec/main-schema.md`, §27 is the old-vs-new diff),
- draft-ietf-quic-qlog-quic-events-13 (digest `qlog-spec/quic-events.md`, §13),
- draft-ietf-quic-qlog-h3-events-13 (digest `qlog-spec/h3-events.md`, §10),
- the editor's copies where they do not conflict (ARCHITECTURE §0).

`data-model.md` §9 owns model-level names, paths and absence semantics; this section owns how Stats reads and renders
them. Draft line references: `q13:NNNN` = `ref/drafts/draft-ietf-quic-qlog-quic-events-13.txt`, `h13:NNNN` =
`…-h3-events-13.txt`, `m14:NNNN` = `…-main-schema-14.txt`. qvis references are relative to
`qvis/visualizations/src/`; a bare `:NNN` means `components/stats/StatisticsConnectionRenderer.vue`.

Tags as in the legend, plus **NONE** (no equivalent in the latest drafts; the row gives the behaviour) and **AUTO**
(new latest-draft content that the existing algorithm shows without extra code).

### 9.1 Ground rules for this page (normative)

1. **Strict names** (ARCHITECTURE §0, §3.1; data-model §9.1 rule 2). `ev.namespace` / `ev.type` are the logged
   `name` split at the first colon, `ev.data === raw.data`. No aliasing, no data fix-ups. Pre-final names
   (`transport:*`, `recovery:*`, `security:*`, `connectivity:*`, `http:frame_*`, `qpack:*`) keep their logged
   namespace; the file-level DM3 toast reports them (not this page's concern).
2. **Three detection modes**, chosen so that the qvis algorithm is kept unchanged:

   | Mode | Statistics | Rule | Events with non-conforming names |
   |---|---|---|---|
   | A. all events | Event count, Events histogram, Total event count | every `QlogEvent` | listed under their logged namespace (this page is where users see them) |
   | B. shape | Frame count, Frames histogram, Encryption level count / table (and the Q5 guard that uses it) | `data.frames` / `data.frame` / `data.header.packet_type` on **any** event (qvis was name-agnostic here, `:389-445`) | counted (PARITY of the algorithm) |
   | C. exact name | Connection-level and stream-level FC, H3 connection headers, NEW `QUIC version` / `ALPN` rows | `ev.namespace === "quic"` / `conn.lookup("http3", …)` / `conn.lookup("quic", …)` plus the exact type | ignored |

   **Superseded (stats review, strict latest-drafts rule):** mode B now skips exactly the events the loader reports in
   DM3 (`isNonconformingName` with the trace's `event_schemas`), plus names without a namespace and events without a
   valid name; latest-draft names and private namespaces (`tcp:`, `tls:`, `http2:`, `mvfst:` …) are still counted.
   The Events histogram (mode A) still lists every event (gaps G2). For current quic-go output this gives Frame count
   0, Encryption level count 0 and the standard danger cells. The rest of this item describes the original decision.

   Original consequence (S16): for a file whose packet events use pre-final names (current quic-go output), the mode
   B tables are populated while the mode C flow-control tables stay empty (§9.13). Mode B is **not** filtered to
   conforming names: qvis's counters never looked at names, and the open `$ProtocolEventData` / `$QuicFrame` sockets
   let converter and extension namespaces (`tcp:`, `http2:`, …) legitimately carry `frames`, `frame` and `header`.
   The DM3 text ("these events are ignored by the visualizations") stays as is: it is accurate for the graph views,
   and Stats lists these events by design.
3. **uint64** members may be JSON numbers or decimal strings (m14 §11.3). FC values keep `parseInt(String(x), 10)`,
   stream-ID keys keep `"" + x` (data-model §9.1 rule 4). Never coerce `data`.
4. **Absence is normal.** Producers omit even REQUIRED members (quic digest §2). Nothing on this page throws on a
   missing member; each row below says what is shown.
5. **Editor's copy.** No member read by this page differs between -13 and the editor's copy. The only relevant
   union point: `quic:frames_processed` (removed in the editor's copy) is still accepted and its frames are counted
   (mode B).

### 9.2 File level ("File info" table)

| # | Old (qvis) | Latest (main-schema-14) | Model | Semantic differences | When absent / invalid | Tag |
|---|---|---|---|---|---|---|
| F1 | file name / URL (set by the loader; not a qlog member) | same | `group.filename` | none | `""` → `Filename` row hidden | PARITY |
| F2 | file `title` | `LogFile.title?: text` (m14 §3) | `group.title` | none (quic-go writes `"quic-go qlog"`, mvfst `"mvfst qlog"`) | `""` → row hidden | PARITY |
| F3 | file `description` | `LogFile.description?: text` | `group.description` | none | `""` → row hidden | PARITY |
| F4 | `qlog_version` (`draft-02`, `0.3`, …) → `qlog version` row | `file_schema` (required absolute URI, m14:398): `urn:ietf:params:qlog:file:contained` or `urn:ietf:params:qlog:file:sequential` | `group.version` (= `group.fileSchema`, data-model D8) | No version number exists any more. The file schema names the container; the event-vocabulary version is the `-NN` suffix of each `event_schemas` URI, shown by the NEW `Event schemas` row. quic-go also writes a legacy `qlog_version: "0.3"` next to `file_schema`: ignored, `file_schema` wins | missing: the parser infers the URI from `traces` / `trace` and adds warning `file.missing-file-schema` (visible in `Diagnostics`); the row is always shown. A legacy file (`qlog_version`, no `file_schema`) never reaches this page (`LegacyQlogError`, toast X1) | PARITY (label); value changes |
| F5 | `qlog_format` (stored in `group.format`, never displayed) | `serialization_format` (required media type, case-insensitive, m14:399) | `group.serializationFormat` | quiche / neqo / quinn write the literal `JSON-SEQ`; the model presents it as `application/qlog+json-seq` (data-model §9.2, §9.14 test 7) | missing: the model uses the media type of the detected framing + warning; the row still shows a value | NEW row 4a |
| F6 | `summary` → `Summary` row | **NONE** (removed in main-schema-06) | `group.summary` is always `{}` | — | row never rendered (S12) | NONE / DROP |
| F7 | `traces[]` (traces and TraceErrors, split by `group_id`) minus generated clones | contained: `traces?: [+ Trace / TraceError]`; sequential: exactly one `trace` (`TraceSeq`) followed by one record per event | `group.getRealConnections()` | `traces` is optional; a JSON-SEQ file has exactly one trace, so several "Trace N info" sections only appear through `group_id` splitting (for example quinn's per-event `group_id`) | no `traces`: zero connections → `Trace count` `0`, `Total event count` `0`, no trace sections; info `file.no-traces` in `Diagnostics` | PARITY |
| F8 | Σ `getEvents().length` | number of events | `computeFileStats()` | events are objects `{time, name, data, …}`; non-object entries and `{}` are skipped by the parser (data-model §3.16.4 step 1), so a malformed file can count fewer than its raw array length | `0` | PARITY |
| F9 | (none) | parser and model diagnostics | `group.diagnostics` | — | row hidden when empty | NEW row 7a |

Not shown: custom top-level members (quic-go `code_version`), JSON-SEQ framing details.

### 9.3 Trace level ("Trace N info" rows 1 to 3a)

| # | Old | Latest | Model | Semantic differences | When absent | Tag |
|---|---|---|---|---|---|---|
| T1 | trace `title` | `Trace.title?` / `TraceSeq.title?` (m14 §4.2, §5.1) | `connection.title` (`"Group <id> : " + title` for `group_id` slices; `ERROR` for TraceErrors) | none | `""` → row hidden (FIX Q1 condition `title.length > 0`) | PARITY + FIX Q1 |
| T2 | trace `description`; TraceError `uri`, `error_description` | same; `TraceError {error_description, uri?, vantage_point?}` (m14:650) | `connection.description` (TraceError: `uri + " : " + error_description`, or only `error_description` when `uri` is absent) | `TraceError.uri` became optional | `""` → row hidden | PARITY |
| T3 | `vantage_point.{name, type, flow}` (required in draft-02) | `VantagePoint {name?, type, flow?}` (m14:794), optional on `Trace`, `TraceSeq`, `TraceError`. `type`: `client` / `server` / `network` / `unknown`; `flow`: `client` / `server` / `unknown`, meaningful for `network` | `connection.vantagePoint` | values unchanged; the member is now optional. Non-standard strings are shown verbatim (quic-go endpoint-level traces write `type: "transport"`; the quiche crate allows `flow: "network"`) | loader default `{type: "unknown", flow: "unknown", name: "No VantagePoint set"}` (PARITY) → `No VantagePoint set` / `unknown`; FC labels `Local (unknown)` / `Remote (client)` | PARITY |
| T4 | (none) | `event_schemas: [+text]` (required, a hint only, m14:573) | `connection.eventSchemas` | shown verbatim: draft URIs carry `-NN` (`…:quic-13`; quic-go / quiche write `…:quic-12`, `…:http3-12`), mvfst writes unversioned `…:quic` and private `…:mvfst`. Never compared with the events (m14 §8.1: mismatches MUST NOT be treated as errors) | `[]` (quinn) or missing → row hidden (the parser's warning appears in `Diagnostics`) | NEW row 3a |
| T5 | `group_id` slices | `Event.group_id?` / `common_fields.group_id` (m14 §7.3); quic-13 §1.4 recommends the ODCID | slices per data-model §3.16.5 | each slice is one "Trace N info" section | not split → one section | PARITY |

Not shown: `common_fields` (`reference_time`, `time_format`, `tuple`, custom keys such as mvfst's `odcid`),
`system_info` (§9.12 N14).

### 9.4 Events histogram and event count (mode A)

The key changes from `(category, eventType)` to `(namespace, type)`. Algorithm unchanged (first-seen order, count,
percentage of the trace's event count).

#### 9.4.1 Category column: old categories to namespaces

| qvis category (draft-02) | Latest namespace | Effect on the table |
|---|---|---|
| `connectivity`, `transport`, `security`, `recovery` | `quic` | four groups collapse into one; the `quic` cell usually spans most rows (`rowSpan` = number of distinct `quic` types) |
| `http` (meant HTTP/3) | `http3` | `http` now means the Capsule Protocol (`http:capsule_created`, `http:capsule_parsed`); a pre-final `http:frame_*` event is listed under `http` |
| `qpack` | none (all QPACK events removed, h3 change log -05) | never appears for conforming files |
| `error`, `warning`, `info`, `debug`, `verbose` | `loglevel` with types `error`, `warning`, `info`, `debug`, `verbose` | the old category became the type: `error:connection_error` → `loglevel:error` |
| `simulation` | `simulation` (`scenario`, `marker`) | same |
| qvis TCP converter: `transport` (TCP packets), `tls`, `http2` | `tcp`, `tls`, `http2` (converter private namespaces) | TCP packets move from `transport` to `tcp` |
| (none) | `http` (capsules), custom namespaces (`mvfst`, …), `unknown` (names without a colon) | listed verbatim |

#### 9.4.2 Event type column: renames beyond the prefix

Full tables: quic digest §13.2, h3 digest §10.2.

| draft-02 | -13 |
|---|---|
| `recovery:metrics_updated` | `quic:recovery_metrics_updated` |
| `recovery:parameters_set` | `quic:recovery_parameters_set` (distinct from `quic:parameters_set`) |
| `recovery:loss_timer_updated` (draft-01 `loss_timer_set`, `loss_timer_triggered`) | `quic:timer_updated` |
| `transport:datagrams_sent` / `datagrams_received` / `datagram_dropped` | `quic:udp_datagrams_sent` / `quic:udp_datagrams_received` / `quic:udp_datagram_dropped` |
| `security:key_retired` | `quic:key_discarded` |
| `transport:data_moved`, `http:data_moved` | `quic:stream_data_moved` |
| `connectivity:path_assigned` (draft-02 spec) | `quic:tuple_assigned` |
| `http:dependency_update`, `http:data_received`, `qpack:*` | none |

Real producers still log some pre-final names; they are listed verbatim (quic-go: `transport`, `recovery`,
`security`; quiche: `quic:datagrams_sent`, `quic:key_retired`; mvfst: `quic:packet_ack`, `quic:loss_timer_updated`,
`mvfst:*`). PARITY with "show what is in the file".

When absent: an event without `name` is indexed as `unknown:unknown`; a name without a colon gives namespace
`unknown` and type = the whole name (data-model §3.16.4 step 4). A name with several colons keeps everything after
the first colon as the type (§6.2).

### 9.5 Frames (mode B)

| # | Old | Latest events carrying it | Latest path | Semantic differences | When absent | Tag |
|---|---|---|---|---|---|---|
| R1 | `data.frames[].frame_type` (draft-02 `transport:packet_sent`, `transport:packet_received`, `transport:frames_processed`, `recovery:packet_lost`, `recovery:marked_for_retransmit`) | `quic:packet_sent` (`? frames`, q13:1183), `quic:packet_received` (`? frames`, q13:1239), `quic:packet_lost` (`? frames`, q13:2420), `quic:frames_created` (`frames` required, q13:1701), `quic:frames_parsed` (q13:1715), `quic:frames_processed` (q13:1749; editor's copy removed it, still accepted), `quic:marked_for_retransmit` (`[+ $QuicFrame]`, q13:2470) | `data.frames[i].frame_type` (`$QuicFrame` is an open map; every defined frame has a required `frame_type` text) | (1) -13 allows logging frames separately from packets (`frames_created` / `frames_parsed` with `packet_numbers[i]`) and only RECOMMENDS avoiding duplicates: a producer that logs both gets every frame counted twice (PARITY Q15). (2) `packet_lost` / `marked_for_retransmit` repeat frames already counted in `packet_sent` (PARITY). (3) Some frame-type strings changed (table below) | no `frames` → no contribution; non-array `frames` or `null` elements → guarded (FIX Q19); frame without `frame_type` → row with an empty cell (PARITY) | PARITY |
| R2 | `data.frame.frame_type` (`http:frame_created`, `http:frame_parsed`; qvis TCP converter `http2:frame_*`) | `http3:frame_created` (`frame` required, h13:544), `http3:frame_parsed` (h13:571); tshark converter `http2:frame_created` / `http2:frame_parsed` | `data.frame.frame_type` (`$HTTP3Frame` open map) | one event per HTTP/3 frame, logged for its header, even if the payload spans many QUIC packets (unchanged). `http:capsule_*` carry `data.capsule` and `http3:datagram_*` carry no frame: neither is counted (qvis's shape rule) | no `frame` → no contribution | PARITY |

Frame type values (Frame type column):

| draft-02 (qvis enums, `QlogSchema02.ts:745-767`, `:980-992`) | -13 | Effect on the table |
|---|---|---|
| QUIC `padding`, `ping`, `ack`, `reset_stream`, `stop_sending`, `crypto`, `new_token`, `stream`, `max_data`, `max_stream_data`, `max_streams`, `data_blocked`, `stream_data_blocked`, `streams_blocked`, `new_connection_id`, `retire_connection_id`, `path_challenge`, `path_response`, `connection_close` | same strings | none |
| QUIC `application_close` | `connection_close` with `error_space: "application"` | no `application_close` row any more; counted under `connection_close` (NONE as a separate type) |
| QUIC `unknown_frame_type` | `unknown` (+ `frame_type_bytes`, q13:3253) | merges with HTTP/3 `unknown` (S19) |
| (none) | QUIC `reset_stream_at` (q13:2939), `handshake_done` (q13:3229), `datagram` (q13:3270) | AUTO: new rows when present |
| HTTP/3 `data`, `headers`, `cancel_push`, `settings`, `push_promise`, `goaway`, `max_push_id`, `priority_update`, `reserved`, `unknown` | same strings | none |
| HTTP/3 `duplicate_push` | none (not in RFC 9114; would be logged as `unknown`) | merges into `unknown` |
| (none) | HTTP/3 `origin` | AUTO |
| (none) | extension frames in the wild: quic-go `ack_frequency`, `immediate_ack`; tshark-converter HTTP/2 types | AUTO (verbatim string) |

S19: keep one map keyed by the string (PARITY of the algorithm). Disambiguating (for example `unknown (QUIC)` /
`unknown (HTTP/3)`) would change labels for a rare case and is not adopted.

### 9.6 Encryption levels (mode B)

| # | Old | Latest events carrying it | Latest path | Semantic differences | When absent | Tag |
|---|---|---|---|---|---|---|
| E1 | `data.header.packet_type` (draft-02 `transport:packet_sent`, `packet_received`, `packet_dropped`, `packet_buffered`, `recovery:packet_lost`; qvis TCP converter TCP packets and TLS records, both `"1RTT"`) | `quic:packet_sent` (`header` required, q13:1182), `quic:packet_received` (required, q13:1238), `quic:packet_dropped` (`? header`, "Primarily packet_type should be filled here", q13:1295), `quic:packet_buffered` (`? header`, q13:1364), `quic:packet_lost` (`? header`, "should include at least the packet_type and packet_number", q13:2415); tshark converter `tcp:packet_sent` / `tcp:packet_received` (`"1RTT"`) | `data.header.packet_type` (`$PacketType`, q13:2583: `initial`, `handshake`, `0RTT`, `1RTT`, `retry`, `version_negotiation`, `stateless_reset`, `unknown`) | Values and casing unchanged. -13 logs neither the encryption level nor the PN space, so the packet type stays the only source (label quirk Q16 kept). Unknown numeric types are `unknown` with `packet_type_bytes` (not shown). Version Negotiation and Stateless Reset packets are packet events of that type (counted). A buffered packet logged again as `packet_received` with `trigger: "keys_available"` counts twice (PARITY). Converted TLS records keep the compat member (converters C9; S20 superseded) | header or `packet_type` absent or empty → not counted (mvfst's aggregate `quic:packet_lost` has no header); no types at all → danger text `None of the events in this trace had data.header.packet_type set!`. The path in that text is still the latest-draft path: keep it verbatim | PARITY |

Not used: `header.packet_number`, `raw.length`, `datagram_id` / `datagram_payload_checksum`, `is_mtu_probe_packet`,
`trigger`.

### 9.7 Connection-level flow control (mode C)

| # | Old | Latest event | Latest path | Semantic differences | When absent | Tag |
|---|---|---|---|---|---|---|
| C1 | `transport:parameters_set` with `data.owner === side`, `data.initial_max_data` (`:466-471`) | `quic:parameters_set` (Core, q13 §5.3) | `data.initiator` (`Initiator = "local" / "remote"`, q13:2527) and `data.initial_max_data` (uint64) | `owner` → `initiator`, same values and meaning (`remote` = values the peer told us). -13 is **cumulative**: an event carries only the settings it sets, a setting not mentioned is unchanged, and local and remote settings MUST be separate events (q13:1012-1028). FIX Q4 (push only when `initial_max_data !== undefined`) is exactly this semantics; a repeated value is listed again (the list is an evolution, PARITY) | `initiator` missing or any other value → the event matches neither side (as qvis without `owner`); `owner` is never read. `initial_max_data` missing → nothing pushed (FIX Q4). Non-numeric value → `NaN` (PARITY) | PARITY + FIX Q4 |
| C2 | `transport:packet_sent` `data.frames[]` `{frame_type: "max_data", maximum}` (`:474-482`) | `quic:packet_sent` | `data.frames[]` MaxDataFrame `{frame_type: "max_data", maximum: uint64, raw?}` (q13:3041) | none | no `frames` → no updates (frames logged only in `quic:frames_created` are not read, N3); `maximum` missing → `NaN` (PARITY) | PARITY |
| C3 | `transport:packet_received`, same frames | `quic:packet_received` | same | none (`quic:frames_parsed` / `frames_processed` are not read, N3) | as C2 | PARITY |

Labels unchanged: `Local (<type>)`, `Remote (<server|client>)`. For a `network` vantage point qvis ignores `flow`
(local = `packet_sent` as logged): PARITY.

Not read (PARITY): `quic:parameters_restored` (N8), DATA_BLOCKED frames and `quic:connection_data_blocked_updated`
(N10). Converter traces: `tcp:` events never match; qvis's TCP packets were `transport:packet_*` without `frames`, so
the result is the same (empty). Using `conn.transportNamespace` instead of `"quic"` for the packet types gives the
same output; the reference code (§3.13) uses `"quic"`.

### 9.8 Stream-level flow control (mode C)

| # | Old | Latest event | Latest path | Semantic differences | When absent | Tag |
|---|---|---|---|---|---|---|
| S1 | `transport:parameters_set` `owner` + `initial_max_stream_data_bidi_local`, `_bidi_remote`, `_uni` (`:505-518`) → keys `bidi_local`, `bidi_remote`, `uni_remote` | `quic:parameters_set` | `data.initiator` + `data.initial_max_stream_data_bidi_local`, `data.initial_max_stream_data_bidi_remote`, `data.initial_max_stream_data_uni` (uint64) | Transport-parameter meaning unchanged (RFC 9000 §18.2: limits the sender of the parameter applies to bidi streams it opened, bidi streams the peer opened, and uni streams the peer opened; hence qvis's label `uni_remote`). Cumulative: FIX Q4 sets only present keys and keeps each key's position, which is exactly the -13 "unchanged if absent" rule (qvis replaced all three with `[NaN]`). A later event that carries a key replaces that key's list (PARITY Q18) | key absent → untouched, not created | PARITY + FIX Q4 |
| S2 | `transport:packet_sent` frames `{frame_type: "max_stream_data", stream_id, maximum}` (`:521-544`) | `quic:packet_sent` | `data.frames[]` MaxStreamDataFrame `{frame_type: "max_stream_data", stream_id: uint64, maximum: uint64, raw?}` (q13:3051) → key `"" + stream_id` | `stream_id` may be a number or a decimal string (mvfst logs stream IDs as strings); `"" + x` merges `0` and `"0"` (PARITY) | `stream_id` missing → key `"undefined"` (PARITY); `maximum` missing → `NaN` (PARITY) | PARITY |
| S3 | `transport:packet_received`, same frames | `quic:packet_received` | same | same | same | PARITY |

Not shown (PARITY): `initial_max_streams_bidi` / `_uni` and MAX_STREAMS frames (qvis TODO, `:639-640`),
STREAM_DATA_BLOCKED frames and `quic:stream_data_blocked_updated`, `quic:stream_state_updated`.

### 9.9 H3 connection headers (mode C)

| # | Old | Latest | Semantic differences | When absent | Tag |
|---|---|---|---|---|---|
| H1 | `lookup(http, frame_created)` then `lookup(http, frame_parsed)` (`:321-322`); `data.frame.headers[].{name, value}` for `server`, `user-agent`, `:authority` (`:336-347`) | `conn.lookup("http3", "frame_created")` then `conn.lookup("http3", "frame_parsed")` (Core, h13 §3.5-3.6); `data.frame.headers[]` of HTTP3HeadersFrame (h13:742) and HTTP3PushPromiseFrame (h13:871); each entry an `HTTP3HTTPField {name?: text, name_bytes?: hexstring, value?: text, value_bytes?: hexstring}` (h13:733). Header names unchanged (HTTP/3 field names are lowercase) | (a) A field MUST carry `name` or `name_bytes` and MAY carry `value`, `value_bytes` or neither (h13:797): read through `fieldName()` / `fieldValue()` (h3 digest §8.1: text first, else hex decoded as Latin-1); a field without any value yields `undefined` and overwrites an earlier value (PARITY Q14). (b) `http:` is now the Capsule namespace: pre-final `http:frame_*` events are ignored here. (c) QPACK events no longer exist; decoded headers live only in HEADERS / PUSH_PROMISE frames, which is what qvis read. (d) Event `stream_id` (control vs request stream) is not used | no `http3:frame_*` events (neqo, quinn, HTTP/3 not logged) → row hidden; frames without `headers` (DATA, SETTINGS, …) skipped; `headers: []` → nothing found. The netlog converter emits `http3:*` (row works, PARITY); tshark `http2:` frames are not read (PARITY) | PARITY + FIX Q3 |

### 9.10 Times (console output only)

| Old | Latest | Semantic differences | When absent | Tag |
|---|---|---|---|---|
| `relativeTime` = `parseFloat(time) * timeMultiplier - subtractTime + timeOffset` (`QlogLoaderV2.ts:289-299`), driven by `configuration.time_units` (`us` → ×0.001), `configuration.time_offset`, `common_fields.time_format` (`absolute` / `relative` / `delta`) and a numeric `reference_time` | `QlogEvent.relativeTime` (data-model §3.16.3): event `time` (float64 ms, m14 §1.2), per-event or common `time_format` (`relative_to_epoch` default, `relative_to_previous_event`), `reference_time` object `{clock_type, epoch, wall_clock_time?}` | always milliseconds (no `time_units`, no `time_offset`); delta-encoded traces are decoded by the model before Stats reads them | malformed `time` → the model uses the previous event's time (data-model §3.16.4 step 6) | PARITY |

Only the `console.debug` step series (§3.10) uses times; the rendered tables do not.

### 9.11 Old members with no latest equivalent (consolidated)

| Old member | Read for | Latest | Behaviour |
|---|---|---|---|
| `qlog_version` | `qlog version` row | none: `file_schema` names the container, `-NN` suffixes in `event_schemas` name the vocabulary | show `file_schema` under the old label; versions visible in the NEW `Event schemas` row (F4, T4) |
| `summary` | `Summary` row | none | row dropped (S12) |
| `owner` | FC side | `initiator` (equivalent) | read `initiator` only |
| categories `connectivity`, `transport`, `security`, `recovery` | histogram grouping | one `quic` namespace | grouped under `quic`; the old sub-grouping is not reconstructed (the -13 subdivisions exist "purely for readability", q13:510-513) |
| `qpack:*`, `http:dependency_update`, `http:data_received` | histogram | none | never appear in conforming files |
| frame types `application_close`, `unknown_frame_type`, HTTP/3 `duplicate_push` | Frames | `connection_close`, `unknown`, `unknown` | merged rows (§9.5) |
| qvis TCP converter `transport` category; TLS-record `header.packet_type` | histogram; encryption levels | `tcp` namespace; TLS `packet_type` kept (converters C9) | §9.4.1; S20 (superseded) |
| `configuration.time_units`, `time_offset` | console times | none (always ms) | — |
| `FCData.streamsUniFCList` / `streamsBidiFCList` | nothing (never filled) | — | DROP |

### 9.12 New in the latest drafts: what this page shows

| Id | Item | Decision | Details |
|---|---|---|---|
| N1 | event `tuple` + `quic:tuple_assigned` (replace `path` / `path_assigned`) | AUTO (histogram) | qvis had no path view. A `Tuples` row (= `connection.getTuples().size`, data-model N1, shown when > 1) is a possible later addition, not adopted |
| N2 | `quic:packets_acked` (Extra) | AUTO (histogram) | no `frames` / `header`, so not counted elsewhere |
| N3 | `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed` | AUTO in Frames (mode B) and histogram. Flow control: **not adopted** (S18) | Optional rule, if a producer ever logs frames only in frame events: per direction, when the trace has no `quic:packet_sent` (resp. `quic:packet_received`) with a non-empty `frames` array, read MAX_DATA / MAX_STREAM_DATA from `quic:frames_created` (local) (resp. `quic:frames_parsed` and `quic:frames_processed`, remote) with the C2/C3 and S2/S3 rules. It never triggers where qvis produced values (strict superset). No surveyed producer needs it (quic-go, quiche, neqo, quinn, mvfst log frames inside packet events) |
| N4 | QUIC frames `reset_stream_at`, `handshake_done`, `datagram`, `unknown` (+ extension frames) | AUTO (Frames) | §9.5 |
| N5 | HTTP/3 frame `origin`; `reserved` / `unknown` with `frame_type_bytes` | AUTO (Frames) | `frame_type_bytes` not shown |
| N6 | datagram events: `quic:udp_datagrams_sent` / `_received` / `udp_datagram_dropped`, `quic:datagram_data_moved`, `http3:datagram_created` / `_parsed`, `http:capsule_created` / `_parsed` | AUTO (histogram only) | not frames (no `frames` / `frame`); DATAGRAM frames inside packets are counted as `datagram` |
| N7 | `quic:version_information` (Core, q13:905) and `quic:alpn_information` (Core, q13:961) | **NEW rows 3b `QUIC version` and 3c `ALPN`** (S17, recommended) | Core events that tools SHOULD support (m14 §8.3, main digest §14); they identify the connection like the H3 row does. Rows are hidden when nothing is found, so draft-02-equivalent traces render exactly as qvis. Rules below |
| N8 | `quic:parameters_restored` (Base, q13:1137) | **not adopted** (S18; qvis ignored `transport:parameters_restored`) | Optional rule: treat it as `initiator: "remote"` for C1 / S1 at its event position (its values are the server parameters remembered for 0-RTT, q13 §5.4) |
| N9 | new `quic:parameters_set` members (`tls_cipher`, `initial_source_connection_id`, `retry_source_connection_id`, `max_datagram_frame_size`, `grease_quic_bit`, `reset_stream_at`, `unknown_parameters`, `initial_max_streams_*`) | not shown (PARITY) | `reset_stream_at: true` explains `reset_stream_at` rows in Frames; no extra row |
| N10 | `quic:connection_data_blocked_updated`, `stream_data_blocked_updated`, `datagram_data_blocked_updated`; DATA_BLOCKED / STREAM_DATA_BLOCKED frames | AUTO (histogram, Frames) | not merged into the FC tables: they record blocking, not limits |
| N11 | `quic:recovery_metrics_updated` (`rtt_variance`, `pto_count`, `packets_in_flight`, `pacing_rate`, …), `quic:recovery_parameters_set`, `quic:congestion_state_updated`, `quic:timer_updated` | AUTO (histogram) | owned by the congestion graph and the sequence diagram |
| N12 | `quic:key_updated` / `key_discarded` (`key_type`, `key_phase`) | AUTO (histogram) | not used as an "encryption level" source (would change the table's meaning) |
| N13 | `quic:connection_closed`, `connection_started`, `connection_state_updated`, `mtu_updated`, `ecn_state_updated`, `migration_state_updated`, `stream_state_updated`, `stream_data_moved`; `http3:parameters_set`, `stream_type_set`, `priority_updated`, `push_resolved`; `loglevel:*`, `simulation:*` | AUTO (histogram) | a `Connection closed` row (initiator, error, reason) is a possible later addition, not adopted |
| N14 | `reference_time.wall_clock_time`, `system_info`, `tuple`, `time_format` | not shown | a "Start (approx.)" row from `connection.calendarStart` (data-model N14) is a possible later addition, not adopted |
| N15 | `group_id` = ODCID (q13 §1.4) | already visible | slice titles `Group <id> : …` |

N7 rules (normative for rows 3b / 3c):

```ts
// src/components/stats/data/computeStatistics.ts
// hexToLatin1: the helper behind fieldName()/fieldValue() (h3 digest §8.1); export it from src/qlog/schema/h3.ts
// (or a shared src/qlog/hex.ts) instead of duplicating it.
export function computeQuicIdentity(conn: QlogConnection): { quicVersion?: string; alpn?: string } {
  let quicVersion: string | undefined;
  let alpn: string | undefined;
  for (const ev of conn.lookup("quic", "version_information")) {      // event order, last wins (like the H3 row)
    const v = (ev.data as any).chosen_version;                          // QuicVersion = hexstring (q13 §8.1)
    if (typeof v === "string" && v !== "") quicVersion = v;            // verbatim, e.g. "00000001" (also "0x…" if logged so)
  }
  for (const ev of conn.lookup("quic", "alpn_information")) {
    const a = (ev.data as any).chosen_alpn;                             // ALPNIdentifier {byte_value?, string_value?} (q13:969)
    if (a == null || typeof a !== "object") continue;
    const text = typeof a.string_value === "string" ? a.string_value
               : typeof a.byte_value === "string" ? hexToLatin1(a.byte_value) : undefined;
    if (text !== undefined && text !== "") alpn = text;
  }
  return { quicVersion, alpn };
}
```

- Last wins: a client logs `client_versions` + `chosen_version` when sending its Initial and logs again after Version
  Negotiation; it logs `client_alpns` first and `chosen_alpn` on the server's Initial. Events without the chosen
  member are skipped.
- Rendering: `<tr><td>QUIC version</td><td>{s.quicVersion}</td></tr>`, `<tr><td>ALPN</td><td>{s.alpn}</td></tr>`,
  React text (no HTML), placed after row 3a and before row 4 (§2.6). No friendly names (`QUIC v1`) are added.
- Mode C: pre-final `transport:version_information` / `transport:alpn_information` (quic-go) do not feed the rows.

### 9.13 What Stats shows per producer

Latest-envelope producers surveyed in the ecosystem digest §3 (2026-11-01), plus the ported converters. Use these
as expectations for fixtures and the e2e smoke test.

| Producer | Events table namespaces | Frames / Encryption levels | Connection- / stream-level FC | H3 row | NEW rows |
|---|---|---|---|---|---|
| quic-go ≥ v0.56 | `transport`, `recovery`, `security` (pre-final), `quic` (`recovery_parameters_set`, non-conforming `datagram_dropped`), `http3` | populated (mode B) | **empty**: `transport:parameters_set` / `transport:packet_*` are non-conforming. Connection-level: table with empty `Local` / `Remote` cells (the Q5 guard passes through the encryption levels); stream-level: danger `No stream level flow control limits set` | shown when `http3:frame_*` with headers exist | `Event schemas` `…:quic-12` / `…:http3-12` when registered; `QUIC version` / `ALPN` hidden (`transport:` names); endpoint-level traces show vantage `transport` |
| quiche ≥ 0.27 / tokio-quiche | `quic` (incl. non-conforming `datagrams_sent`, `key_retired`), `http3`, `loglevel` | populated | from `quic:parameters_set` + packet frames | shown when HTTP/3 is logged | `Event schemas` `…-12`; version / ALPN when logged; `Serialization format` `application/qlog+json-seq` (literal `JSON-SEQ` normalized) |
| neqo / Firefox | `quic` | populated | from `quic:parameters_set` + packet frames | hidden (no HTTP/3 events) | `Event schemas` `…:quic-12`; version when logged |
| quinn | `quic` (`packet_sent`, `packet_received`, `packet_lost`, `recovery_metrics_updated`) | populated | no `quic:parameters_set` in the surveyed event list: only MAX_DATA / MAX_STREAM_DATA updates from packet frames | hidden | `Event schemas` hidden (`[]`); vantage `unknown`; one section per `group_id` |
| mvfst | `quic` (incl. non-standard `packet_ack`, `loss_timer_updated`, `datagram_received`), `mvfst` | populated; aggregate `quic:packet_lost` has no header (not counted) | `quic:parameters_set` is not in the surveyed event list: packet-frame updates only | shown when HTTP/3 is logged | `Event schemas` unversioned `…:quic`, `…:http3`, private `…:mvfst` |
| qvis-react netlog converter | `quic`, `http3` | populated | `quic:parameters_set` (`initiator`) + WINDOW_UPDATE → `max_data` / `max_stream_data` | shown (`HTTP3_HEADERS_SENT` / `_DECODED`) | per converters spec |
| qvis-react tshark converter | `tcp`, `tls`, `http2` | Frames: HTTP/2 frames; Encryption levels: `1RTT` = TCP packets + TLS records, as in qvis (converters C9; S20 superseded) | empty: connection-level table with empty cells (guard passes through `1RTT`), stream-level danger cell | hidden (`http2` is not read) | per converters spec |

### 9.14 Latest names this page references (checklist for `names.ts`)

- Mode C lookups: `quic:parameters_set`, `quic:packet_sent`, `quic:packet_received`, `http3:frame_created`,
  `http3:frame_parsed`, NEW `quic:version_information`, `quic:alpn_information`.
- Frame types compared: `max_data`, `max_stream_data`.
- Members: `initiator`, `initial_max_data`, `initial_max_stream_data_bidi_local`,
  `initial_max_stream_data_bidi_remote`, `initial_max_stream_data_uni`, `frames`, `frame`, `frame_type`, `maximum`,
  `stream_id`, `header`, `packet_type`, `headers`, `name`, `name_bytes`, `value`, `value_bytes`, `chosen_version`,
  `chosen_alpn`, `string_value`, `byte_value`.
- Values: header names `server`, `user-agent`, `:authority`; `Initiator` `local`, `remote`; `VantagePointType`
  `client`, `network`.
- Optional, not adopted (N3, N8): `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed`,
  `quic:parameters_restored`.

### 9.15 Tests to add (`computeStatistics.test.ts`, in addition to §8.5)

1. quic-go-style trace: `transport:parameters_set {initiator: "local", initial_max_data: 1000}` and
   `transport:packet_sent {header: {packet_type: "1RTT"}, frames: [{frame_type: "max_data", maximum: 2000}]}` →
   Events namespace `transport` (2 types); Frame count 1 (`max_data`); Encryption levels `1RTT` 1;
   `connectionFC.local.values` `[]`; both stream maps empty.
2. `quic:parameters_set {owner: "local", initial_max_data: 5}` (no `initiator`) → no FC entries.
3. Only `quic:frames_parsed {frames: [{frame_type: "max_data", maximum: 9}]}` → Frames `max_data` 1; remote FC empty
   (N3 not adopted).
4. `quic:parameters_restored {initial_max_data: 5}` → FC empty (N8 not adopted); listed in Events under `quic`.
5. `quic:packet_received` with `{frame_type: "unknown", frame_type_bytes: 64}` and `http3:frame_parsed {stream_id: 0,
   frame: {frame_type: "unknown", frame_type_bytes: 33}}` → one `unknown` row with count 2 (S19);
   `reset_stream_at`, `handshake_done`, `datagram` and `origin` frames each get their own row.
6. `http:capsule_parsed {stream_id: 0, capsule: {capsule_type: "datagram"}}` and `http3:datagram_parsed
   {quarter_stream_id: 0}` → listed in Events (`http`, `http3`); Frame count unchanged.
7. `quic:packet_dropped {header: {packet_type: "handshake"}}`, `quic:packet_buffered {}`, `quic:packet_lost {header:
   {packet_type: "1RTT", packet_number: 3}}`, `quic:packet_sent {header: {packet_type: "unknown",
   packet_type_bytes: 7}}` → Encryption levels `handshake` 1, `1RTT` 1, `unknown` 1 (count 3).
8. `tcp:packet_sent {header: {packet_type: "1RTT"}}` + `tls:record_created {header: {content_type: "application"}}`
   → `1RTT` 1 (S20).
9. `http:frame_created {stream_id: 0, frame: {frame_type: "headers", headers: [{name: "user-agent", value: "x"}]}}`
   → H3 row hidden (Frames still counts `headers` 1, mode B); the same event as `http3:frame_created` → row shown.
   A field `{name_bytes: "3a617574686f72697479", value_bytes: "6578616d706c652e6f7267"}` gives authority
   `example.org`.
10. NEW rows: `quic:version_information {client_versions: ["00000001"], chosen_version: "00000001"}` then
    `{chosen_version: "6b3343cf"}` → `quicVersion === "6b3343cf"`; `quic:alpn_information {client_alpns:
    [{string_value: "h3"}]}` then `{chosen_alpn: {byte_value: "6833"}}` → `alpn === "h3"`;
    `transport:alpn_information {chosen_alpn: {string_value: "h3"}}` alone → `alpn === undefined`; no such events →
    both `undefined`, rows 3b / 3c absent from the DOM.
11. Cumulative parameters: `quic:parameters_set {initiator: "remote", initial_max_stream_data_bidi_local: 1,
    initial_max_stream_data_bidi_remote: 2, initial_max_stream_data_uni: 3}` then `{initiator: "remote",
    initial_max_stream_data_uni: 7}` → remote map keys in order `bidi_local` [1], `bidi_remote` [2], `uni_remote` [7].
12. String stream IDs: `max_stream_data {stream_id: "4", maximum: "100"}` then `{stream_id: 4, maximum: 200}` in
    `quic:packet_sent` → local key `4` with `[100, 200]`.

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`).

### T1. Files without traces (G10): amends §9.2 row F7

A file whose `traces` is absent or `[]` never reaches this page. The parser rejects it with "File contains no
traces" (file-loading §3.14 step 5, code `file.no-traces`; data-model addendum M2). Row F7's "When absent" cell
becomes: "unreachable for loaded files (rejected at load). A group can still end up with zero connections only
through future programmatic construction. Then `Trace count` shows `0`, `Total event count` `0`, and there are no
trace sections." Keep a unit test for that case on a hand-built group, not on a file.

### T2. Non-conforming names (G2, cross-reference)

§9.1 already notes that DM3's "ignored by the visualizations" is accurate for the graph views and that this page
lists such events in the Events histogram. The sequence diagram also draws them, as generic chips
(sequence-diagram addendum S2). The DM3 text stays verbatim (ARCHITECTURE §3.1).

---

## 10. Parity check on identical data (2026-11-01)

Method: the same connection loaded into hosted qvis (`https://qvis.quictools.info`, draft-02 conversion
`tests/fixtures/legacy/<scenario>.draft02.qlog`, uploaded via `#fileUpload` + Import) and into qvis-react (the latest-draft
original from `public/examples/`, uploaded the same way), viewport 1600x1000, `#/stats`. Scenarios: `new_cid`,
`10_parallel_streams`, `doublevantage_100ms`, `multistream_loss`, `baseline`, `massive_client`, `massive_server`, and the
qvis TCP demo `wikipedia_Playstation.json` (same tshark input in both apps). Compared: a structured DOM dump of every
table, row and cell (text, rowspan, danger class, progress-bar `aria-*` / width / label, `<p>` lists, bounding boxes,
computed styles), the console flow-control series, full-page screenshots pixel by pixel (NEW rows hidden, filename /
version text neutralised, Events histograms masked), and the interactions of §2.10.

Results:

- Every number is equal in every scenario: event counts per type (after the name mapping of §9.4), progress labels,
  `aria-valuenow`, `aria-valuemax` and bar widths, Frame count and every frame row in the same order, encryption levels,
  connection- and stream-level flow-control lists, H3 headers, Trace count, Total event count.
- Geometry and styles: every matched row, cell, nested table, `<p>` and progress bar has the same position and size
  (tolerance 1.5 px; measured differences 0), and all sampled computed styles are equal. With the NEW rows hidden and the
  Events histograms masked, the full-page screenshots of all seven QUIC scenarios are **pixel-identical** (0 differing
  pixels).
- Console: the 32 `Connection-level FC ...` / `Stream-level FC ...` messages of `10_parallel_streams` are identical in
  content and order (qvis `console.log`, qvis-react `console.debug`, S15). No console errors, warnings or page errors in
  qvis-react; qvis only logs its own tshark-converter warnings on the TCP demo.
- Interactions: empty state, `Loading files...`, auto-selection of `groups[0]`, option labels, switching files and back,
  persistence across a tab switch, a single-trace file after the sequence diagram added its generated sibling (excluded),
  and the 900 px viewport (page scroll width 1029 in both) all behave identically. Removing the selected file differs
  as intended (app-shell Q11).

Fixed in this pass (regression tests in `Statistics.test.tsx` "DOM parity with qvis's compiled Vue templates" and the
e2e "switching files" test):

| # | Difference | Fix |
|---|---|---|
| D1 | Labels with an interpolated value (`Local (client)`, `Remote (server)`, `Local Streams (…)`, `Remote Streams (…)`, `Trace N info`, `network : with … perspective`) and the H3 row text were split into several text nodes; Chrome placed some glyphs a sub-pixel off (pixel diffs on `client)`, `server)`, the H3 authority) | one text node per label, as Vue renders it (§8.2) |
| D2 | Events and stream-level rows were keyed by content; on a file switch React moved reordered rows and their bars jumped to the new width (e.g. 34 px → 2 px within 150 ms), while qvis patches rows by position and every bar animates | positional keys exactly as qvis's v-for keys (§8.2) |

Intended differences seen (not changed): `qlog version` value (`file_schema`, S3); NEW rows `Serialization format`,
`Diagnostics`, `Event schemas`, `QUIC version`, `ALPN` (S4, S17); trace `Title` row shown (Q1); Events histogram grouped by
latest namespaces (`quic`, `http3`, `tcp`) with latest type names, so its row order and category cells differ (§9.4);
no empty first vantage-point line when the name is absent (Q8, TCP demo: 24 px shorter); removing the selected file
re-selects `groups[0]` (app-shell Q11); FC series via `console.debug` (S15). Filename differences (`.draft02.qlog`)
come from the conversion. S20 is superseded (see §0).

