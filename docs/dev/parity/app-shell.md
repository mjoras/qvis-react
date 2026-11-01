# Parity spec: app-shell (global shell, routing, menu, notifications, shared selector, colors)

Source of truth: qvis `visualizations/` at commit `3db6acf` (quiclog/qvis master, Aug 2026).
All `path:line` citations are relative to
`visualizations/` of [quiclog/qvis](https://github.com/quiclog/qvis)
unless they start with `../` (repo root) or are absolute.

Locked dependency versions of the original (from `package-lock.json`): vue 2.6.10, vue-router 3.1.3, vuex 3.1.1,
vuex-module-decorators 0.9.11, bootstrap 4.3.1 (CSS only), bootstrap-vue 2.0.4, vue-notification 1.3.16,
d3 5.12.0, axios 0.18.1, oboe 2.1.5, typescript 3.6.4, @vue/cli-service 3.12.1.

The target React scaffold already in this repository uses React 19, react-bootstrap 2 + **Bootstrap 5.3**,
react-router 8, zustand 5, d3 7, Vite with `base: "./"`. Section 8 lists what that means for visual parity.

Scope of this document:

- `src/main.ts`, `src/App.vue`, `src/router.ts`, `src/store.ts`, `src/store/ConfigurationStore.ts`
- the store surface the shell touches (`src/store/ConnectionStore.ts`: `loadFilesFromServer` and `outstandingRequestCount`)
- `src/views/*.vue`: `MainMenu`, `VUEDebug`, and the six thin view wrappers
- `src/components/shared/ConnectionConfigurator.vue`, the trace and file picker shared by all visualizations
- `src/components/shared/helpers/ColorHelper.ts`
- `public/index.html`, `package.json`, `vue.config.js`, `../Dockerfile`, `../README.md`, `../.github/ISSUE_TEMPLATE/*`
- every global URL query parameter used anywhere in the codebase
- the notification system, with the verbatim text of every notification in the app
- §9: the mapping of every qlog field the shell consumes to the latest drafts (main-schema-14, quic-events-13,
  h3-events-13)

---

## 1. Overview and user-facing purpose

qvis is a single-page app with hash-based routing (`https://host/#/<route>?<query>`). The shell provides:

1. **A persistent top menu** (`MainMenu`). It is a black bar showing the text "qvis" at the left, six tabs in the
   center (one per tool) and two GitHub buttons at the right. Each active tab takes a pastel color that matches the
   configurator panel of that tool, so the tab visually merges into the panel below it.
2. **Routing** between the tools: file manager, sequence diagram, congestion graph, multiplexing graph, packetization
   diagram, statistics, plus a hidden debug page. **URL query parameters are sticky.** Once the URL has
   `?file=...`, every navigation keeps it. Query parameters placed before the hash (`https://host/?file=x.qlog`) are
   moved into the hash route by a workaround.
3. **Startup file loading from the URL.** If the route has any query parameters when the app mounts, the app calls
   `ConnectionStore.loadFilesFromServer(query)`. That function fetches `file`, `list` or `file1..N` directly or
   through the qvis-server backend.
4. **Toast notifications** (`vue-notification`): one group named `"default"`, anchored at the bottom center, 50% of
   the viewport wide. Store actions, the file manager and renderers all use them.
5. **Global state.** All loaded files ("connection groups") and the per-visualization configuration objects live in
   Vuex. Switching tabs therefore keeps the selected trace and the settings of each tool. Nothing is persisted across
   reloads.
6. **A shared trace selector** (`ConnectionConfigurator`). Every visualization embeds it to pick one connection
   (trace) from all loaded files, or one file in the statistics view. It has two layouts depending on how many
   options exist.
7. **A shared color helper** (`ColorHelper.StreamIDToColor`). It maps HTTP/2 or HTTP/3 stream IDs to a fixed
   palette. The multiplexing and packetization views use it.
8. **A debug page** (`#/debug`, `VUEDebug`). It injects random fake files into the store to test reactivity.

---

## 2. UI inventory

### 2.1 Document shell (`public/index.html`)

| Item | Value (verbatim) |
|---|---|
| `<html lang>` | `en` |
| meta | `charset="utf-8"`, `http-equiv="X-UA-Compatible" content="IE=edge"`, `name="viewport" content="width=device-width,initial-scale=1.0"` |
| favicon | `<link rel="icon" href="<%= BASE_URL %>favicon.ico">`. **No `favicon.ico` exists in `public/`**, so this is a 404 in a plain build. |
| `<title>` | `qvis: tools and visualizations for QUIC and HTTP/3` (static, never changed per route) |
| `<noscript>` | `<strong>We're sorry but qvis doesn't work properly without JavaScript enabled. Please enable it to continue.</strong>` |
| mount point | `<div id="app"></div>`. The Vue root replaces it with App's own root `<div id="app">`. |

`vue.config.js` sets `baseUrl: './'`, so assets use relative URLs and the build can be served from a sub-path. It also
sets `devtool: 'source-map'`, so production source maps are emitted. The React scaffold already matches this
(`base: "./"`, `sourcemap: true`).

### 2.2 App root (`src/App.vue:1-7`)

```html
<div id="app">
    <router-view name="menu"/>     <!-- MainMenu on every defined route -->
    <router-view />                <!-- the tool view -->
    <notifications group="default" position="bottom center" width="50%" />
</div>
```

DOM order: menu, then the view, then the notification container (which is `position: fixed`).

### 2.3 Global CSS

These are imported or declared globally:

1. `bootstrap/dist/css/bootstrap.css` (Bootstrap **4.3.1**), from `src/main.ts:8`.
2. `bootstrap-vue/dist/bootstrap-vue.css` (2.0.4), from `src/main.ts:9`.
3. The unscoped `<style>` in `App.vue:9-33`:

```css
html, body { height: 100%; padding: 0; margin: 0; }
#app {
    font-family: 'Avenir', Helvetica, Arial, sans-serif;   /* no webfont loaded: Avenir only on macOS */
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-align: left;
    color: #2c3e50;
}
.vue-notification.warn, .vue-notification.error { color: black; }   /* overrides lib default white text */
```

4. The default stylesheet of vue-notification 1.3.16, injected by the library. Its rules are reproduced in §3.6.

No other global fonts, icon fonts or logos exist. **There is no logo image anywhere in the shell.** The brand is the
plain text "qvis" in an `<h3>`.

### 2.4 Main menu (`src/views/MainMenu.vue`)

Rendered structure (bootstrap-vue output, using Bootstrap 4 classes):

```
div.container-fluid#MainMenu                         (b-container fluid)
  div.row                                             (b-row)
    div.col-1.col-md-auto.align-middle                (b-col cols="1" md="auto" class="align-middle")
      h3[style="width: 290px;"]  "qvis"
    div.col                                            (b-col)
      ul.nav.nav-tabs.justify-content-center           (b-nav tabs align="center")
        li.nav-item.files-link          > a.nav-link[href="#/files"]          "Manage files"
        li.nav-item.sequence-link       > a.nav-link[href="#/sequence"]       "Sequence"
        li.nav-item.congestion-link     > a.nav-link[href="#/congestion"]     "Congestion"
        li.nav-item.multiplexing-link   > a.nav-link[href="#/multiplexing"]   "Multiplexing"
        li.nav-item.packetization-link  > a.nav-link[href="#/packetization"]  "Packetization"
        li.nav-item.stats-link          > a.nav-link[href="#/stats"]          "qlog stats"
    div.col-1.col-md-auto                              (b-col cols="1" md="auto")
      a.btn.btn-success[href=..., target=_blank, rel=noopener, style="margin-right: 5px;"]  "Request feature"
      a.btn.btn-danger [href=..., target=_blank, rel=noopener]                              "Report issue"
```

Tab labels, in order and verbatim: **Manage files**, **Sequence**, **Congestion**, **Multiplexing**,
**Packetization**, **qlog stats**.

Button targets (the `&amp;` in the template is an HTML entity for `&`):

- "Request feature" (variant `success`): `https://github.com/quiclog/qvis/issues/new?template=feature_request.md&title=Feature+request`
- "Report issue" (variant `danger`): `https://github.com/quiclog/qvis/issues/new?template=bug-report-in-live-version.md&title=Bug+in+live+version`

Both open in a new tab. bootstrap-vue adds `rel="noopener"` automatically for `target="_blank"`. These URLs depend on
the two issue-template filenames in `../.github/ISSUE_TEMPLATE/` (§2.8).

There is no version string, no info text and no logo in the menu. The only version string in the app is in the file
manager heading ("Welcome to qvis v0.1, ..."), which belongs to the file-manager spec.

**Active-state rule** (`MainMenu.vue:26-41`), evaluated against `$route.fullPath`, which **includes the query
string**:

| Tab | active when |
|---|---|
| Manage files | `fullPath.indexOf('/files') >= 0 \|\| fullPath === ''` (the second clause can never be true) |
| Sequence | `fullPath.indexOf('/sequence') >= 0` |
| Congestion | `fullPath.indexOf('/congestion') >= 0` |
| Multiplexing | `fullPath.indexOf('/multiplexing') >= 0` |
| Packetization | `fullPath.indexOf('/packetization') >= 0` |
| qlog stats | `fullPath.indexOf('/stats') >= 0` |

On `#/debug` no tab is active. The check is a case-sensitive substring test, so `#/Sequence` renders the sequence view
(vue-router matches paths case-insensitively) but leaves every tab inactive. See §7 Q1 for the query-substring bug.

**Scoped styles** (`MainMenu.vue:54-130`). Exact values:

```css
#MainMenu { width: 100%; background-color: black; color: white; padding-top: 5px; }
#MainMenu .nav-tabs { border-bottom: none; }
#MainMenu .nav-tabs .nav-item { margin-left: 3px; }
#MainMenu .nav-tabs .nav-link { background-color: lightgrey; color: black; border-bottom: none; }
/* active, one rule per tab: color black; font-weight bold; background-color X; border-bottom-color X */
#MainMenu li.files-link         a.active { background-color: #fff;    border-bottom-color: #fff; }
#MainMenu li.sequence-link      a.active { background-color: #cce5ff; border-bottom-color: #cce5ff; }
#MainMenu li.congestion-link    a.active { background-color: #d4edda; border-bottom-color: #d4edda; }
#MainMenu li.multiplexing-link  a.active { background-color: #d1ecf1; border-bottom-color: #d1ecf1; }
#MainMenu li.packetization-link a.active { background-color: #f8d7da; border-bottom-color: #f8d7da; }
#MainMenu li.stats-link         a.active { background-color: #fff3cd; border-bottom-color: #fff3cd; }
/* every active rule also sets: color: black; font-weight: bold; */
```

The comment in the source says bootstrap-vue's built-in `active-class` did not work because of precedence, which is
why these rules exist.

Bootstrap 4.3.1 values these rules sit on top of (reproduce them for pixel parity):

- `.container-fluid`: `padding: 0 15px`. `.row`: `margin: 0 -15px`. Each column: `padding: 0 15px`.
- `h3`: `font-size: 1.75rem; font-weight: 500; line-height: 1.2; margin: 0 0 .5rem`. The color inherits white from `#MainMenu`.
- `.nav-tabs .nav-link`: `display: block; padding: .5rem 1rem; border: 1px solid transparent; border-top-left-radius: .25rem; border-top-right-radius: .25rem; margin-bottom: -1px`.
- On hover or focus of a non-active link: `border-color: #e9ecef #e9ecef #dee2e6`. Only the top, left and right borders
  are visible because the bottom border is `none`. The text is not underlined.
- `.nav-tabs .nav-link.active`: `border-color: #dee2e6 #dee2e6 #fff`. The scoped rules override the color and
  background. The bottom-border style stays `none`, so no bottom border shows on any tab.
- `.btn`: `padding: .375rem .75rem; font-size: 1rem; line-height: 1.5; border-radius: .25rem; border: 1px solid`.
- `.btn-success`: `#28a745`, hover `#218838` with border `#1e7e34`, white text.
- `.btn-danger`: `#dc3545`, hover `#c82333` with border `#bd2130`, white text.

The tab colors match the background colors of the configurator panels (owned by the tool specs, listed here so they
stay consistent):

| Tool | Configurator panel bg | Intro text in the panel (verbatim) |
|---|---|---|
| Sequence | `#cce5ff` (the diagram also has a `5px solid #cce5ff` border) | "Select one or more traces via the dropdown(s) below to visualize them in the sequence diagram" |
| Congestion | `#d4edda` | "Select a trace via the dropdown(s) below to visualize it in the congestion graph" |
| Multiplexing | `#d1ecf1` | "Select a trace via the dropdown(s) below to visualize it in the stream graph" |
| Packetization | `#f8d7da` | "Select a trace via the dropdown(s) below to visualize it in the packetization diagram" |
| Stats | `#fff3cd` | "Select a file via the dropdown(s) below to view its statistics" |
| Files | white page | (file-manager spec) |

These colors are the Bootstrap 4 `alert-primary`, `alert-success`, `alert-info`, `alert-danger` and `alert-warning`
backgrounds.

Layout notes:

- The 290px fixed width of the "qvis" heading roughly balances the width of the two right-hand buttons, so the
  centered tab strip looks centered on the page.
- Below 768px the side columns become `col-1` (8.33% wide) while the h3 stays 290px, so the menu overlaps. The app is a
  desktop tool; there is no responsive handling.
- The MainMenu instance is reused across route changes (same component in the named `menu` view). It mounts once and
  logs `this.$route` to the console on mount. The class is misnamed `VUEDebug` in the source.

### 2.5 Shared trace selector (`src/components/shared/ConnectionConfigurator.vue`)

#### 2.5.1 Props (verbatim names, defaults and semantics)

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `connection` | `Connection` | none | The currently selected trace, controlled from outside. Required unless `group` is given. |
| `group` | `ConnectionGroup` | none | The currently selected file. Used only for the initial `selectedGroup` (statistics mode). |
| `allGroups` | `ConnectionGroup[]` | none | Every loaded file. All callers pass `store.groups`. |
| `numericalInputValue` | `number?` | none | Initial value of the optional numeric input (latency offset). |
| `numericalInputName` | `string?` | none | If truthy, shows the numeric input column with header label `"<name> : "`. |
| `canBeRemoved` | `boolean` | **`true`** | Shows a remove button `−` (U+2212, written `&minus;`). |
| `allowGroupSelection` | `boolean` | `false` | Makes group header options selectable and calls `onGroupSelected`. |
| `allowConnectionSelection` | `boolean` | `true` | Whether connections can be chosen. |
| `onGroupSelected` | `(group) => void` | none | Callback when a group is chosen. |
| `onConnectionSelected` | `(conn) => void` | none | Callback when a connection is chosen. It is called unconditionally in connection modes. |
| `onNumericalValueChanged` | `(n: number) => void` | none | Called with `parseFloat(value)` on the native `change` event of the number input. |
| `onRemoved` | `() => void` | none | Called by the `−` button. |

Internal state is initialized once at creation (`ConnectionConfigurator.vue:93-96`):

```ts
selectedConnection = this.connection;
selectedGroup      = this.group ? this.group : this.connection.parent;   // throws if both are undefined
numericalValue     = this.numericalInputValue;
```

#### 2.5.2 Callers (all of them)

| Caller | Props passed | Mode in practice |
|---|---|---|
| `SequenceDiagramConfigurator.vue:10-22` | one per `config.connections[i]` (in a `v-for`). `connection=connection.connection`, `key = index + connection.timeOffset` (numeric sum), `numericalInputValue = connection.timeOffset`, `numericalInputName = allowCustomTimeOffset(...) ? 'Latency offset' : undefined`, `canBeRemoved = config.connections.length > 2 && index != 0`, `onConnectionSelected`, `onRemoved` and `onNumericalValueChanged` each bound to `index`. | combined, or separate when there are more than 30 options |
| `CongestionGraphConfigurator.vue:9` | `v-if="config.connection !== undefined"`, `connection=config.connection`, `canBeRemoved=false`, `onConnectionSelected` | combined or separate |
| `MultiplexingGraphConfigurator.vue:9` | `v-if="config.connections.length > 0"`, `connection=config.connections[0]`, `canBeRemoved=false`, `onConnectionSelected` | combined or separate |
| `PacketizationDiagramConfigurator.vue:9` | same as multiplexing | combined or separate |
| `StatisticsConfigurator.vue:9` | `v-if="config.group !== undefined"`, `group=config.group`, `canBeRemoved=false`, `allowGroupSelection=true`, `allowConnectionSelection=false`, `onGroupSelected` | group-only |

`allowCustomTimeOffset(conn, index)` is `index > 0 && config.connections.find(c => c.connection.wasAutoGenerated) === undefined`.
So the "Latency offset" column appears only on the second and later selectors, and only when no auto-generated
trace is part of the selection.

#### 2.5.3 Outer frame

The whole component is a single `b-col`, i.e. `div.col`, with inline style
`background-color: white; color: black; border: black 1px solid; max-width: 50%;`.
It contains a `b-container fluid` (15px horizontal padding).

- Inside a `b-row align-h="center"` (congestion, multiplexing, packetization, stats) it is one centered panel, at most
  50% of the row width.
- In the sequence configurator several of them sit in one plain `b-row`. Each is `flex: 1 0 0%` with a 50% cap, so 2
  selectors take 50% each, 3 take 33% each, and so on, left-aligned.

#### 2.5.4 The three render modes (`ConnectionConfigurator.vue:4-35`)

**Mode A: group-only.** Condition: `allowGroupSelection && !allowConnectionSelection`. Used only by the statistics view.

```
<select class="custom-select mb-3 mt-3"  v-model=selectedGroup  options=groupOptions  @change=onGroupSelectionChanged>
```

**Mode B: separate selects.** Condition: otherwise, and `tooManyOptions` (`combinedOptions.length > 30`).

```
<select class="custom-select mb-3 mt-3"  v-model=selectedGroup       options=groupOptions       @change=onGroupSelectionChanged>
<select class="custom-select mb-3"       v-model=selectedConnection  options=connectionOptions  @change=onConnectionSelectionChanged>
<button class="btn btn-secondary" v-if=canBeRemoved @click=removeMyself>−</button>
```

This mode has **no header label and no numeric input**, even when `numericalInputName` is set (§7 Q9). The `−`
button sits on its own line under the selects with no bottom margin.

**Mode C: combined single select.** Condition: otherwise. This is the common case.

```
div.row.mt-3
  div.col            -> <div>{selectedConnection.parent.filename} ({selectedConnection.parent.description})</div>
  div.col-2  (if numericalInputName)  -> <div v-b-tooltip.hover title="This value is automatically calculated, but can be manually adjusted.">{numericalInputName} : </div>
  div.col[style="max-width: 36px;"]  (if canBeRemoved)  -> empty spacer
div.row.mb-3
  div.col            -> <select class="custom-select" v-model=selectedConnection options=combinedOptions @change=onConnectionSelectionChanged>
  div.col-2  (if numericalInputName)  -> <input type="number" class="form-control" v-model=numericalValue @change=onNumericalValueUpdated>
  div.col-auto.px-0  (if canBeRemoved)  -> <button class="btn btn-secondary">−</button>
```

Verbatim strings:

- The header label is `"<filename> (<description>)"`. With an empty description it renders `"<filename> ()"`.
- The numeric header is `"Latency offset : "` (the only `numericalInputName` in use), with hover-only tooltip
  `This value is automatically calculated, but can be manually adjusted.` in Bootstrap's default top placement.

**The mode is recomputed live.** Loading more files can flip a mounted selector from mode C to mode B once the
combined option count exceeds 30.

#### 2.5.5 Option lists, with verbatim label formats

`groupOptions` is used in modes A and B (`:122-129`). There is one option per group in `allGroups` order (load order):

```
text = group.filename + " (" + (group.title ? group.title + " : " : "") + group.description + ")"
```

Example: `foo.qlog (My title : My description)`. With neither title nor description: `foo.qlog ()`.

`connectionOptions` is used in mode B (`:132-161`). There is one option per `selectedGroup.getConnections()`, with
`text = connectionLabel(conn)`.

`combinedOptions` is used in mode C (`:164-197`). For each group, in order:

1. A header option: `{ value: null, text: group.filename, disabled: !allowGroupSelection }`. It is disabled (greyed)
   for every real caller.
2. For each connection: `{ value: conn, text: "↳ " + connectionLabel(conn) }`. The prefix is U+21B3 followed by one
   space.

`connectionLabel(conn)` is duplicated verbatim three times in qvis: the two above and `Connection.getLongName()`, which
the multiplexing collapsed renderer uses. Implement it once:

```ts
function connectionLabel(c: Connection): string {
    let s = "";
    if (c.vantagePoint) {                                   // always truthy: the loader always sets one
        if (c.vantagePoint.name) { s += c.vantagePoint.name + " : "; }
        s += c.vantagePoint.type ? c.vantagePoint.type : "UNKNOWN";
        s += c.vantagePoint.flow ? " (flow = " + c.vantagePoint.flow + ") : " : " : ";
    }
    if (c.title)       { s += c.title; }
    if (c.description) { s += " : " + c.description; }
    return s;
}
```

Label examples, which can serve as unit-test vectors. They use the loader's defaults (`QlogLoaderV2.ts:49-56,
104-109, 135-144`). A trace without `vantage_point` gets `{type:"unknown", flow:"unknown", name:"No VantagePoint set"}`.

| Trace JSON | Label |
|---|---|
| `vantage_point {name:"aioquic client", type:"client"}`, `title:"Connection 1"` | `aioquic client : client : Connection 1` |
| `vantage_point {type:"server"}`, `title:"t"`, `description:"d"` | `server : t : d` |
| `vantage_point {type:"network", flow:"client"}`, no title | `network (flow = client) : ` (trailing space) |
| no `vantage_point`, `title:"x"` | `No VantagePoint set : unknown (flow = unknown) : x` |
| no `vantage_point`, no title, no description | `No VantagePoint set : unknown (flow = unknown) : ` |
| TraceError `{error_description:"File could not be found", uri:"/srv/a.qlog"}` | `unknown (flow = unknown) : ERROR : /srv/a.qlog : File could not be found` (the connection keeps its constructor-default vantage point, which has no name) |
| events split by `group_id` `"abc"`, trace `title:"T"`, `vantage_point {type:"client"}` | `client : Group abc : T` (the connection title is `"Group " + id + " : " + traceTitle`) |
| sequence-diagram auto-generated sibling of a client trace titled `T` with empty description | `GENERATED : server (flow = unknown) : Simulated, autogenerated trace : T : Simulated, autogenerated trace : ` |

The last row matters for the selector: `Connection.clone()` constructs `new QlogConnection(this.parent)` and the
constructor calls `parent.addConnection(this)` (`Connection.ts:32-49, 53-56`). So once the sequence diagram has
auto-generated a sibling trace (`SequenceDiagramD3Renderer.ts:465-470`), that sibling **appears in every selector of
every tool** and counts towards the 30-option threshold and the file manager's "(N connections)". The
sequence-diagram spec owns this behavior.

Where the group fields come from. This belongs to the file-loading spec; it is listed here because the labels show it.

- `filename` depends on how the file was loaded:
  - upload: the `File.name`
  - URL parameter or "Fetch": `"Loaded via URL (" + urlShort + ")"`, where `urlShort = url.length > 50 ? url.substr(0,25) + "..." + url.substr(url.length-26) : url`
  - demo files: e.g. `"DEMO_new_cid.qlog (<1MB)"`
  - the large demo: `"MASSIVE_DEMO_mvfst_large.qlog (31MB)"`
- `title` and `description` come from the top-level `title` and `description` (`""` if absent).

#### 2.5.6 Interactions

The `@change` handlers fire only on user selection, never on programmatic v-model updates.

- **Group select changed** (modes A and B), `onGroupSelectionChanged(newlySelected)` at `:200-214`:
  1. If `allowGroupSelection && onGroupSelected`, call `onGroupSelected(this.selectedGroup)`. The source comment says
     `selectedGroup` "is the PREVIOUS selection for some reason". With the shipped bootstrap-vue 2.0.4, our analysis
     is that the v-model `input` event is applied before `change`, so this is in practice the newly selected group.
     **The port must pass the newly selected group** (§7 Q8).
  2. If `allowConnectionSelection`, set `selectedConnection = newlySelected.getConnections()[0]` and call
     `onConnectionSelected(thatConnection)`. Changing the file in mode B therefore immediately selects and propagates
     the file's first trace. If the group has no connections this passes `undefined` (§7 Q12).
- **Connection select changed** (modes B and C), `onConnectionSelectionChanged(newlySelected)`: calls
  `this.onConnectionSelected(newlySelected)`. Nothing else happens locally; the parent is expected to update the
  `connection` prop.
- **Remove button:** `onRemoved()`.
- **Number input:**
  - `v-model` keeps `numericalValue` in sync on every keystroke (local only).
  - The native `change` event (on blur or Enter after typing, or on each spinner click) calls
    `onNumericalValueChanged(parseFloat(val))` if the callback exists.
  - An empty input yields `NaN` (§7 Q15).
- **Watcher on the `connection` prop** (`:103-112`, not immediate, not deep). When the parent passes a different
  connection object:
  - `selectedGroup = newConnection.parent`
  - `selectedConnection = newConnection` if it differs
  - `numericalValue = numericalInputValue`, the current prop value

  There is **no** watcher on `group`, `numericalInputValue` or `allGroups`. The option lists are computed, so they do
  react to `allGroups` changes.
- **How the select matches its value.** Vue's `<select v-model>` (used inside bootstrap-vue's `b-form-select`) matches
  option values with `looseEqual`:
  - same object, or recursively structurally equal
  - recursion on cyclic Connection/Group graphs normally terminates at the first differing field; a stack overflow is
    caught and treated as "not equal"
  - if no option matches, the `<select>` shows a blank selection (`selectedIndex = -1`)

  The port should match by identity, for example through index-encoded option values (§8).

#### 2.5.7 Auto-selection rules (in the callers)

Every tool configurator runs the same "select default" check in both `mounted()` and `updated()`. Vue re-renders the
configurator whenever `store.groups.length` changes because the template references it. The effect: whenever files
exist and the tool has no selection, the tool selects the **first trace of the first loaded file** (`groups[0]`, the
oldest). This also happens while the user sits on the tab when the first file finishes loading.

| Tool | Empty condition | Default |
|---|---|---|
| Sequence (`SequenceDiagramConfigurator.vue:241-256`) | `config.connections.length === 0 && groups.length > 0` | `connections.push(createConnectionWithTimeoffset(groups[0].getConnections()[0]))` |
| Congestion (`CongestionGraphConfigurator.vue:116-137`) | `config.connection === undefined && groups.length > 0` | `config.connection = groups[0].getConnections()[0]` |
| Multiplexing (`MultiplexingGraphConfigurator.vue:109-124`) | `config.connections.length === 0 && groups.length > 0` | `config.connections = [groups[0].getConnections()[0]]` |
| Packetization (`PacketizationDiagramConfigurator.vue:160-175`) | same | same |
| Stats (`StatisticsConfigurator.vue:57-72`) | `config.group === undefined && groups.length > 0` | `config.group = groups[0]` |

Loading a second file never changes an existing selection. Removing a file never clears a selection that points into
it (§7 Q11).

When the store has no groups, each of these five configurators shows a shared pair of alerts. Implement this once as a
`<NoTraceAlerts/>` component:

```html
<b-alert v-if="store.outstandingRequestCount === 0 && store.groups.length === 0" show variant="danger">Please load a trace file to visualize it</b-alert>
<b-alert v-else-if="store.groups.length === 0" show variant="warning">Loading files...</b-alert>
```

### 2.6 Notifications container

`<notifications group="default" position="bottom center" width="50%" />` (`App.vue:5`). Rendering, timing and colors
are in §3.6. Every message is listed verbatim in §6.

### 2.7 Debug page (`#/debug`, `src/views/VUEDebug.vue`)

It renders MainMenu (no active tab), then:

```
div.home
  div.hello > h1 "This is the VUE debugger to test reactive data coupling"     (HelloWorld component, msg prop)
  [Add new random ConnectionGroup] | [Delete First] | [Change Connection Name] | [Change Event Name] | [RemoveEvent]
       (b-button, default variant "secondary"; the literal text " | " separates them)
  for each group in store.groups:            div  "{group.description}"          (:key = description; duplicates warn)
  for each connection of the LAST group:     for each event: div  "- Event: ROBIN : {connection.title} : {connection.parseEvent(event).name}"
```

Button labels, verbatim: `Add new random ConnectionGroup`, `Delete First`, `Change Connection Name`,
`Change Event Name`, `RemoveEvent`.

Behavior:

- `created()`: if `store.groups.length <= 1`, call `AddRandomConnection()` 3 times. **This adds 3 fake groups to the
  real global store on every visit while at most one file is loaded.** They then appear in every tool's selector and
  in the file manager.
- `AddRandomConnection()`: calls `store.DEBUG_LoadRandomFile("RandomConnectionGroup " + Math.round(Math.random()*100))`,
  then logs `"ConnectionGroup added. This is called AFTER the mutation has been committed to the store!"` with the
  group.
- `DEBUG_LoadRandomFile(filename)` (`ConnectionStore.ts:92-114`) builds a new group and commits `addGroup`:
  - `description = filename`; `filename` stays `""`, so its header option in the selectors is blank
  - `round(random()*5)+1` connections (1 to 6), each with `title "Connection " + i`
  - each connection has `ceil(random()*3)` events (practically 1 to 3) of pre-spec array shape
    `[j, "testcat", "Connection #i - Event #j", "dummytrigger", {dummy:true}]`, parsed by `PreSpecEventParser`, whose
    `name` is index 2
  - the vantage point stays at the constructor default `{type:"unknown", flow:"unknown"}`
- `DeleteFirstConnection()`: `store.deleteGroup(groups[0])` (commits the mutation directly; a no-op when empty).
- `ChangeConnectionName()`: `connections[0].title = "Connection name was changed"`. This is reactive and the UI
  updates. It logs `"Connection name was changed"`. It throws when there are no groups.
- `ChangeEventName()`: `connections[0].getEvents()[0][2] = "Event was changed"`. This is **not** reactive, so the UI
  does not update until something else re-renders. It logs
  `"Event name was changed, but SHOULD NOT reflect in UI since events are no longer reactive!"`.
- `RemoveEvent()`: splices the last event of `connections[0]`. Also not reactive.

`connections` means `groups[groups.length-1].getConnections()`, or `undefined` when there are no groups.

### 2.8 Repository files that the shell depends on

- `../.github/ISSUE_TEMPLATE/feature_request.md`: name "Feature request", about "Suggest an idea for this project",
  empty title, labels and assignees. Its body sections are "Is your feature request related to a problem? Please
  describe.", "Describe the solution you'd like", "Describe alternatives you've considered" and "Additional context".
- `../.github/ISSUE_TEMPLATE/bug-report-in-live-version.md`: name "Bug report in live version", about "Report a bug in
  the live version of qvis", title "Bug in live version".
  - Body sections: "Describe the bug", "To Reproduce" (bullets "How did you load the file?" and "Which visualization
    had the error?"), "Expected behavior", "Screenshots", "Additional context".
  - The additional-context text tells users to attach the file or email it to robin.marx@uhasselt.be, and says qvis
    is only tested on the latest stable Google Chrome.
- The MainMenu buttons deep-link to these templates **by filename**. The new repository must contain templates with
  the same filenames, or the links must change.
- `../Dockerfile`:
  - stage 1 is `node:16-alpine`; it copies `visualizations/`, then runs `npm ci` and `npm run build`
  - stage 2 is `caddy:alpine`; it copies `/app/dist` to `/srv`, exposes 8080 and runs
    `caddy file-server --listen :8080 --root /srv`
  - it serves only static files, with no `/loadfiles` backend
- `../README.md` covers:
  - qvis input formats: qlog, partial pcap, Chrome netlog
  - the hosted version `https://qvis.quictools.info/`
  - qvis-server, which is needed for pcap and for "loading files via external URL"
  - the Docker run instructions: `docker build -t qvis .`, `docker run -p 8080:8080 qvis`, then open `http://localhost:8080`
  - a section on older versions
- `../LICENSE`: MIT, "Copyright (c) 2019 Hasselt University - EDM". The port is derived from this code and **must keep
  this notice** next to its own (§8.10).

---

## 3. Algorithms and data flow

### 3.1 Bootstrap sequence (`src/main.ts`)

1. Import Vue, BootstrapVue, vue-notification, App, router and store, plus the two Bootstrap CSS files.
2. Large commented-out blocks exist: loading `standalone_data/*.qlog.js` through `<script>` tags, and auto-loading
   demo files on `:8080` unless the URL contains `nodemo`. They are **dead code; do not port**.
3. `Vue.config.productionTip = false; Vue.use(BootstrapVue); Vue.use(Notifications);`
4. `new Vue({ router, store, render: h => h(App) }).$mount("#app")`.
   - Creating the router-bound root runs the initial navigation synchronously, including the `beforeEach` guard and
     any redirect, because there are no async guards or components.
   - So when `App.mounted()` runs, `this.$route` already holds the final route and query.
5. `App.mounted()` (`App.vue:53-57`): `if (Object.keys(this.$route.query).length > 0) store.loadFilesFromServer(this.$route.query)`.
   - This runs once per page load. **Any** query key triggers the call, for example `?focusOnEvent=3` alone. The
     store returns early with only a console log when there is no `file`, `list` or `file1` (§3.5).
   - `created()` holds a commented-out duplicate.
   - Later changes to the query (hash edits, navigation) never trigger loading again (§7 Q6).

### 3.2 Routes (`src/router.ts:14-85`)

vue-router 3 in its default **hash mode**. Paths match case-insensitively and allow an optional trailing slash
(path-to-regexp defaults). No `scrollBehavior`, no `base`, no lazy chunks.

| Hash path | Route name (exact string) | default view → container | named view `menu` |
|---|---|---|---|
| `/` | none | `redirect: "/files"`, which keeps the query and hash | none |
| `/debug` | `VUEDebug` | `VUEDebug` | `MainMenu` |
| `/files` | `FileManager` | `FileManager.vue` → `FileManagerContainer` | `MainMenu` |
| `/sequence` | `sequence` | `SequenceDiagram.vue` → `SequenceDiagramContainer` | `MainMenu` |
| `/congestion` | `congestion` | `CongestionGraph.vue` → `CongestionGraphContainer` | `MainMenu` |
| `/multiplexing` | `multiplexing` | `MultiplexingGraph.vue` → `MultiplexingGraphContainer` | `MainMenu` |
| `/packetization` | `packetization` | `PacketizationDiagram.vue` → `PacketizationDiagramContainer` | `MainMenu` |
| `/stats` | `Statistics` | `Statistics.vue` → `StatisticsContainer` | `MainMenu` |
| anything else | none | **nothing renders, not even the menu** | none |

The six view wrappers (`src/views/{FileManager,SequenceDiagram,CongestionGraph,MultiplexingGraph,PacketizationDiagram,Statistics}.vue`)
are each `<div><XContainer/></div>` with no logic.

**Lifecycle:** there is no `<keep-alive>`. Every route change destroys the previous tool view, including its D3
renderer and DOM, and creates the new one. Tool state survives only because each container reads its config object
from the global `configurations` store (§5.3). The sequence renderer, for example, re-renders from the stored config
on `mounted()`.

Entry-URL normalization done by vue-router's hash history:

- `https://host/` (no hash) becomes `#/`, then the redirect gives `https://host/#/files`.
- `https://host/#?list=x.json` has a hash without a leading slash. vue-router rewrites it to `#/?list=x.json`, and the
  redirect turns that into `#/files?list=x.json`. The file manager's "Option 5" help links use this form.
- `https://host/?file=x.qlog` (query before the hash) becomes `https://host/?file=x.qlog#/files?file=x.qlog` through
  the guard below.
- `https://qvis.quictools.info?#/sequence?file=...&focusOnConnection=..&focusOnEvent=..` is the format of the
  sequence-diagram deep link. A bare `?` gives an empty `location.search`; the hash route and query work as usual.

### 3.3 Global navigation guard (`src/router.ts:87-118`)

```ts
function hasQueryParams(route) { return !!Object.keys(route.query).length; }

router.beforeEach((to, from, next) => {
    if (window.location.search && Object.keys(to.query).length === 0 && from.path === "/") {
        // (1) pre-hash "?a=b" workaround: only on the initial navigation (from = START route "/")
        const params = new URLSearchParams(window.location.search);
        const query = {};
        for (const [k, v] of params.entries()) { query[k] = v; }    // duplicate keys: LAST wins; "?a" gives a = ""
        next({ name: to.name, query });
    }
    else if (!hasQueryParams(to) && hasQueryParams(from)) {
        // (2) sticky query: carry the previous query over to any navigation that has none
        next({ name: to.name, query: from.query });
    }
    else {
        next();
    }
});
```

Exact semantics to reproduce:

1. **Rule 1 (pre-hash migration)** fires only when all of these hold:
   - `location.search` is non-empty (`"?"` alone counts as empty)
   - the target hash route has **zero** query keys; `#/files?` counts as zero, `#/files?x` does not because `x: null`
     is a key
   - the navigation is the initial one (`from` is the START route with path `/`; `/` itself always redirects, so no
     later navigation has `from.path === "/"`)

   It redirects to the same route **name** with the pre-hash parameters as the query. `location.search` is **never
   removed** from the URL. If the hash already has a query, the hash wins and the pre-hash parameters are ignored.
2. **Rule 2 (sticky query)** fires on *every* later navigation, including:
   - menu clicks
   - manual hash edits in the address bar (if the user deletes `?file=...` from the hash, it comes back)
   - browser back and forward to an entry without a query

   It redirects to `{ name: to.name, query: from.query }`. Path params and hash are dropped; neither is used anywhere.
3. When the target route has its own non-empty query, that query **replaces** the old one wholesale. Queries are never
   merged.
4. An unknown route has `to.name === undefined`, so the redirect `{name: undefined, query}` resolves relative to the
   current path:
   - with a sticky query: the user stays on the current page
   - without one: the page is blank
   - on the initial load with pre-hash parameters: it resolves to `/`, which redirects to `/files`
5. A redirect to an identical location aborts as a duplicate navigation, which `router-link` swallows silently.
   Clicking the already-active tab is a no-op.

**Query-string codec** (vue-router 3.1.3, which affects what components receive):

- **Parsing:**
  - strip a leading `?`, `#` or `&`; split on `&`
  - in each part, **replace `+` with a space**, then split on `=`
  - key = `decodeURIComponent(first)`
  - value = `decodeURIComponent(rest.join('='))`, so values may contain `=`; a key with no `=` gets the value `null`
  - repeated keys become an array `[v1, v2, ...]`
  - `decodeURIComponent` is unguarded in 3.1.3, so a malformed `%` escape **throws and the app fails to start**
    (§7 Q25)
- **Stringifying** (used when the router rewrites the URL after rule 1 or 2):
  - `encodeURIComponent`, then additionally escape ``!'()*`` as `%21 %27 %28 %29 %2a` and turn `%2C` back into `,`
  - `null` gives a bare `key`, `undefined` drops the key, an array repeats the key
  - after a menu click, `#/files?file=https://a.org/x.qlog` therefore becomes `#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog`
- `&` inside an unencoded file URL splits it. `?file=https://a.org/get?id=1&fmt=qlog` gives
  `file="https://a.org/get?id=1"` and `fmt="qlog"`. Users must percent-encode such URLs.

**Menu hrefs** are plain `#/files`, `#/sequence` and so on, **without** the query. The query is added only during
in-app navigation, so "open link in new tab" on a menu item loses `?file=...` (§7 Q3).

### 3.4 Store composition (`src/store.ts`, `src/store/ConfigurationStore.ts`)

```ts
new Vuex.Store({ modules: { connections: ConnectionStore, configurations: ConfigurationStore } })   // strict mode off
```

The `connections` module (`ConnectionStore.ts`) has:

- state: `grouplist: ConnectionGroup[]` (load order) and `outstandingRequests: number`
- getters: `groups` and `outstandingRequestCount`
- mutations: `adjustOutstandingRequestCount(amount)`, `addGroup(group)` (push) and `deleteGroup(group)` (splice by
  identity; no-op if missing)
- actions: `removeGroup`, `addGroupFromQlogFile`, `DEBUG_LoadRandomFile`, `loadFilesFromServer`,
  `loadExamplesForDemo` and `loadQlogDirectlyFromURL`

The `configurations` module (`ConfigurationStore.ts:9-16`) holds one long-lived, mutable config object per tool.
Containers read the object once (`this.store.<x>Config`) and mutate it in place:

| Field | Class | Defaults |
|---|---|---|
| `congestionGraphConfig` | `CongestionGraphConfig` | `connection: undefined`. It also holds a `renderer` field that is deliberately not initialized, and the configurator calls `config.renderer.resetZoom()` and similar through it. |
| `sequenceDiagramConfig` | `SequenceDiagramConfig` | `connections: [] as {connection, timeOffset}[]`, `timeResolution: 1` |
| `statisticsConfig` | `StatisticsConfig` | `group: undefined` |
| `multiplexingGraphConfig` | `MultiplexingGraphConfig` | `collapsed: true, showwaterfall: true, showbyteranges: true, connections: []` |
| `packetizationDiagramConfig` | `PacketizationDiagramConfig` | `collapsed: true, connections: []` |

Nothing is persisted: no localStorage and no URL sync of selections. A reload clears everything; the URL query then
re-triggers loading of URL-provided files.

### 3.5 Startup loading from URL (`ConnectionStore.loadFilesFromServer`, `ConnectionStore.ts:116-337`)

The file-loading spec owns the details. The shell-relevant flow:

1. If `query` has no keys, log and return.
2. Choose the URL in this order:
   - `query.file`: `urlToLoad = fullURL = file`
   - else `query.list`: `urlToLoad = list`
   - else `query.file1`: `urlToLoad = file1 + " etc."`. The suffix deliberately breaks the direct download so
     multi-file loading always goes through the backend.
   - otherwise, log and return
3. Show notification N2, "Loading file(s) via URL" (§6), **always**, even when the direct download later succeeds
   without any backend.
4. **Direct download.** Before the extension check it does `outstandingRequests += 1` (§7 Q14).
   - The check: if `urlToLoad` contains (substring, not suffix) `.qlog`, `.sqlog`, `.netlog` or `.json`, it does
     `fetch(urlToLoad)`.
   - On a 2xx response: `FileLoader.Load(text, urlToLoad)`. A loader error is thrown and caught; the request is then
     treated as failed (`count -= 1`) and falls back.
   - On a non-2xx response: `count -= 1`, then fall back.
   - On a thrown error (CORS or network): `count -= 1`, then fall back.
5. **Backend fallback** (only if the direct attempt did not produce a response):
   - The URL is `'/loadfiles'` (origin-relative) by default. If `location.toString()` contains `"localhost:8080"` it
     is `"https://localhost/loadfiles"`. Else if it contains `":8080"` it is `"https://qvis.quictools.info/loadfiles"`.
   - It sends `axios.get(url, {params: <the ENTIRE query object>})`, including `focusOn*`, `forceFull` and the rest,
     and wraps the call in `count += 1` / `count -= 1`.
   - The response is unwrapped as follows:
     - `res.data.qlog` (pcap2qlog output) or `res.data` (proxied file)
     - `.netlog` URLs with `{constants, events}` go to `NetlogToQlog.convert`
     - objects are used as-is
     - strings go through `FileLoader.Load`
   - If `traces[0].error_description` exists, it throws.
6. **Add.** This step requires `fileContents.qlog_version !== undefined`.
   - It builds `filename = "Loaded via URL (" + shortened urlToLoad + ")"`.
   - If `fullURL` is set (only with `?file=`), it also sets `fileInfo.URL = fullURL` and `fileInfo.URLshort`
     (`>50` chars: first 25 + `"..."` + `fullURL.substr(lastIndexOf("/"))`).
   - It dispatches `addGroupFromQlogFile` and shows N3 (success) **unconditionally**, even when parsing failed and N1
     was already shown (§7 Q32).
7. Otherwise it shows N4. Any exception gives `count -= 1` and N5.

**Latest drafts only:** the `qlog_version` gate must become a `file_schema` gate in the React port (§4, §9.1).

### 3.6 Notifications (vue-notification 1.3.16 behavior to reproduce)

API, called from anywhere, including non-component code (store actions):

```ts
Vue.notify({ group: "default", title?: string, text: string, type?: "success" | "warn" | "error", duration?: number })
```

- `group` must equal `"default"`. Any other group is ignored because only one `<notifications>` instance exists.
- `type` absent gives the default ("info") style. Only `success`, `warn` and `error` are used.
- `duration` defaults to **3000 ms**. Only some error notifications set **6000**.

Container configuration: `group="default"`, `position="bottom center"`, `width="50%"`. The library's other defaults:

- `speed = 300`, `duration = 3000`, `max = Infinity`, `reverse = false`, `closeOnClick = true`
- `animation-type = "css"`, `animation-name = "vn-fade"`, `delay = 0`, `cooldown = 0`
- no de-duplication; to our knowledge there is no pause-on-hover in 1.3.16

Behavior:

- **Lifetime:** each item is removed after `duration + 2*speed` ms. That is **3600 ms** for normal items and **6600 ms**
  for `duration: 6000`. A negative duration would be sticky; none is used.
- **Ordering:** with a `bottom` position the list grows **bottom-to-top**. New items are appended at the end, so the
  newest is lowest, closest to the screen edge, and older ones move up.
- **Click** on a notification removes it immediately.
- **Placement:** the container is `position: fixed; z-index: 5000; width: 50%; bottom: 0px; left: calc(50% - 25%)`,
  centered horizontally.
- **Item DOM:**

  ```html
  <div class="vue-notification-wrapper">
    <div class="vue-notification {type}">
      <div class="notification-title" v-html="title"/>    <!-- only if title truthy -->
      <div class="notification-content" v-html="text"/>
    </div>
  </div>
  ```

  Title and text are **HTML** (`v-html`). The app uses `<br/>` for line breaks and also interpolates user-controlled
  URLs and filenames into the HTML (§7 Q7).
- **CSS** (library default, plus the App.vue override):

```css
.vue-notification-group { display: block; position: fixed; z-index: 5000; }
.vue-notification-wrapper { display: block; overflow: hidden; width: 100%; margin: 0; padding: 0; }
.notification-title { font-weight: 600; }
.vue-notification {
  display: block; box-sizing: border-box; text-align: left;
  font-size: 12px; padding: 10px; margin: 0 5px 5px;
  color: white; background: #44A4FC; border-left: 5px solid #187FE7;        /* default/info */
}
.vue-notification.warn    { background: #ffb648; border-left-color: #f48a06; }   /* + App.vue: color black */
.vue-notification.error   { background: #E54D42; border-left-color: #B82E24; }   /* + App.vue: color black */
.vue-notification.success { background: #68CD86; border-left-color: #42A85F; }   /* text stays white */
.vn-fade-enter-active, .vn-fade-leave-active, .vn-fade-move { transition: all .5s; }
.vn-fade-enter, .vn-fade-leave-to { opacity: 0; }
```

Resulting palette:

| type | background | left border (5px) | text |
|---|---|---|---|
| (none) | `#44A4FC` | `#187FE7` | white |
| success | `#68CD86` | `#42A85F` | white |
| warn | `#ffb648` | `#f48a06` | **black** |
| error | `#E54D42` | `#B82E24` | **black** |

### 3.7 ColorHelper (`src/components/shared/helpers/ColorHelper.ts`)

```ts
static StreamIDToColor(streamID: string, protocol: "HTTP2" | "HTTP3"): [fill: string, text: "black"]
```

The function always returns a 2-element array whose second element is the literal `"black"`. Every caller uses only
`[0]`. The lookup tables are lazily-filled static `Map<string,string>`s, one per protocol, and never change after the
first call. Colors are "inspired by Kelly's 22 colour chart".

**HTTP/3 table** (keyed by client-initiated bidirectional stream IDs `0, 4, 8, ...`):

| stream ID | color | source comment |
|---|---|---|
| 0 | `#E1DA4C` | yellow |
| 4 | `#6B067F` | purple |
| 8 | `#E17426` | orange |
| 12 | `#914ca8` | purple |
| 16 | `#99CBDF` | light blue |
| 20 | `#C72737` | red |
| 24 | `#BBC585` | buff |
| 28 | `#7D787A` | grey |
| 32 | `#6CAD58` | green |
| 36 | `#D580AA` | pink |
| 40 | `#4C61B9` | blue |
| 44 | `#D38E75` | yellowish pink |
| 48 | `#46198C` | violet |
| 52 | `#C8A454` | oker |

**HTTP/2 table:**

| stream ID | color | source comment |
|---|---|---|
| 0 | `#FF0000` | bright red |
| 1 | `#E1DA4C` | yellow |
| 3 | `#6B067F` | purple |
| 5 | `#E17426` | orange |
| 7 | `#914ca8` | purple |
| 9 | `#99CBDF` | light blue |
| 11 | `#C72737` | red |
| 13 | `#BBC585` | buff |
| 15 | `#7D787A` | grey |
| 17 | `#6CAD58` | green |
| 19 | `#D580AA` | pink |
| 21 | `#4C61B9` | blue |
| 23 | `#D38E75` | yellowish pink |
| 25 | `#46198C` | violet |
| 27 | `#C8A454` | oker |

The fallback color is the CSS named color **`lavenderblush`** (`#FFF0F5`).

Lookup algorithm. It must be exact, including the "string first" lookup:

```ts
if (lut.has(streamID)) return [lut.get(streamID), "black"];   // exact string match, e.g. "4"
let n = parseInt(streamID, 10);                                // "04" -> 4, " 8" -> 8, "4.7" -> 4, "x" -> NaN
if (protocol === "HTTP2") { if (n > 27) n = n % 28; }
else                      { if (n > 52) n = n % 56; }          // 14 colors * 4 = 56: cycles through client-bidi IDs
return lut.has("" + n) ? [lut.get("" + n), "black"] : ["lavenderblush", "black"];
```

Test vectors:

- HTTP3:
  - `"0"` gives `#E1DA4C`, `"56"` gives `#E1DA4C`, `"60"` gives `#6B067F`, `"100"` (100%56=44) gives `#D38E75`
  - `"2"`, `"3"`, `"53"` and `"57"` (57%56=1) all give `lavenderblush`
  - `"04"` gives `#6B067F`; `"abc"` and `"-4"` give `lavenderblush`
- HTTP2:
  - `"0"` gives `#FF0000`, `"29"` (29%28=1) gives `#E1DA4C`
  - `"28"` (28%28=0) gives `#FF0000`, a quirk: an even server-push stream turns red
  - `"2"` and `"30"` give `lavenderblush`

Callers, which all pass `"" + id` and use `[0]`:

- packetization: `PacketizationQUICPreProcessor.ts:118,171` (HTTP3) and `PacketizationTCPPreProcessor.ts:231,283`
  (HTTP2), through `PacketizationDiagramDataHelper`
- multiplexing: `MultiplexingGraphDataHelper.StreamIDToColor` (always HTTP3), used by the waterfall, byte-range,
  collapsed and simulation D3 renderers and `MultiplexingGraphCollapsedRenderer.vue:147`
- `MultiplexingGraphDataHelper.isDataStream(id) = parseInt(id,10) % 4 === 0` is a sibling helper; keep it next to the
  color helper

---

## 4. Event and field consumption

The shell itself does not interpret protocol events. It consumes **file-level and trace-level metadata** (selector
labels and load gating), event names (debug page only), stream IDs (the color helper, through its callers) and one
packet-number field (the `?focusOnPN=` deep link, through the sequence diagram). The table lists every old-schema
input together with the place qvis reads it. §9 gives the exact latest-draft equivalent of each row (main-schema-14,
quic-events-13, h3-events-13), what to do when a field is absent, and what is new.

| Old qvis input (qlog draft-02 / 0.3, plus legacy) | Read at (qvis) | Used by the shell for | Latest drafts (details in §9) |
|---|---|---|---|
| top-level `qlog_version` (values `draft-00`, `draft-01`, `draft-02-wip`, `draft-02`, `draft-02-RC1`, `qlog-03-WIP`, `0.3`, plus `0.1` pre-spec) | dispatch in `QlogLoader.fromJSON` (`QlogLoader.ts:14-45`) and `QlogLoaderV2.fromJSON` (`QlogLoaderV2.ts:12-31`, aliases from `QlogSchema02.ts:13`); add gate in `loadFilesFromServer` (`ConnectionStore.ts:282`); gate in `loadQlogDirectlyFromURL` (`ConnectionStore.ts:380`, which also requires a falsy root `error` and `error_description`); the dead `apireturns.qlog_version` branch (`:240`, Q33); header checks in `textsequencejsontoqlog.ts:26` and `newlinejsontoqlog.ts:26`; sniffing in `FileLoader.ts:211-246`; copied into `group.version` (`QlogLoaderV2.ts:40`), which only the Stats view displays | deciding whether a loaded document counts as qlog (§3.5 step 6, and the N1 and N9 paths) | **removed.** Gate on `file_schema` (with `serialization_format`) and reject legacy files: latest drafts only (§9.1) |
| top-level `qlog_format` (`JSON`, `NDJSON`, `JSON-SEQ`) | sniffing; `group.format` (`QlogLoaderV2.ts:41`, default `"JSON"`), never displayed by the shell | file-type sniffing (file-loading spec) | `serialization_format`, a case-insensitive media type (§9.1) |
| top-level `title`, `description` | `QlogLoaderV2.ts:42-43` | `group.title` and `group.description`: group option labels, the combined header `filename (description)` and the `#/debug` group list (`VUEDebug.vue:11-13`) | same (§9.1) |
| top-level `summary` | never copied into the group | not used | removed (§9.9) |
| `traces[]` | `QlogLoaderV2.ts:45-56` | one `Connection` per trace (or per `group_id` slice). A trace with `events: []` crashes the non-split path (`:124-125` reads `.length` of `undefined`). | optional `traces` (contained) or one `trace` header plus event records (sequential) (§9.1, §9.2) |
| `traces[i].title`, `.description` | `QlogLoaderV2.ts:135-136` | the `title` and `description` parts of `connectionLabel` | same (§9.2) |
| `traces[i].vantage_point {name?, type, flow?}`, where `type` is `client`, `server`, `network` or `unknown` and `flow` is `client`, `server` or `unknown` | `QlogLoaderV2.ts:138-144`; `getVantagePointPerspective` (`Connection.ts:113-124`) | the leading part of `connectionLabel`. The default when absent is `{name:"No VantagePoint set", type:"unknown", flow:"unknown"}`. If the object exists but `type` is falsy, qvis also **overwrites `name`**. The object is shared by reference with the JSON and with every `group_id` slice, and the sequence diagram later renames it (`SequenceDiagramD3Renderer.ts:469`, `:528`, `:531`), which then shows in every selector. | same, but optional (§9.2) |
| TraceError `{error_description, uri}` | `QlogLoaderV2.ts:49-56`; whole-load abort when `traces[0]` is one (`ConnectionStore.ts:274-276`, backend path only) | a placeholder connection titled `"ERROR"` with description `uri + " : " + error_description` and the constructor-default vantage point (no name). qvis ignores any vantage point on an error entry, and an absent `uri` prints `"undefined"` (§7 Q24). | `uri` optional, `vantage_point` allowed (§9.2) |
| per-event `group_id` (or `"group_id"` inside legacy `event_fields`) | `QlogLoaderV2.ts:68-116` | splits one trace into connections titled `"Group " + id + " : " + traceTitle`. qvis splits only when `events[0].group_id` is defined and never looks at `common_fields.group_id`. Non-string IDs are `JSON.stringify`'d. Events without an ID in a split trace land in `"Group undefined : …"`. `{}` events are skipped. Connection order is first-seen order. | `Event.group_id` or `common_fields.group_id` (text) (§9.3) |
| `event_fields` (CSV-style events, removed in draft-02) | `QlogLoaderV2.ts:60-79`, `:149-152` (`EventFieldsParser`) | not used by the shell | removed: reject or skip (§9.2) |
| `configuration` | `connection.configuration` (`QlogLoaderV2.ts:147`) | not used by the shell | removed in main-schema-06 (§9.9) |
| event name: `parseEvent(evt).name`, which is the part **after** the first `:` (`split(":")[1]`, `QlogLoaderV2.ts:348-363`), or array index 2 for pre-spec events (`QlogLoader.ts:989-991`) | `VUEDebug.vue:16` | the `#/debug` event list, which shows the type only, not the full name | `Event.name` = `namespace:type`; show the type (§9.4) |
| stream IDs: STREAM frames in `transport:packet_sent/received` `data.frames[].stream_id`; `http:frame_created/frame_parsed` `data.stream_id`; `http:data_moved` `data.stream_id` (filter only); HTTP/2 `frame_created/frame_parsed` `data.stream_id` from the TCP converter | the callers listed in §3.7 and §9.5 | the ColorHelper input, always passed as a decimal string. The extraction itself belongs to the multiplexing and packetization specs. | `quic:packet_sent/received` STREAM frames, `http3:frame_created/frame_parsed`, `quic:stream_data_moved`; HTTP/2 has no equivalent (§9.5) |
| `transport:packet_sent` `data.header.packet_number` (sent events only, type-only match, first match, truthy values only) | `SequenceDiagramD3Renderer.ts:1162-1185`; the parameter is parsed at `SequenceDiagramRenderer.vue:63-71` | the `?focusOnPN=` deep link (sequence spec) | `quic:packet_sent` `data.header.packet_number`, now optional (§9.6) |
| pre-spec event arrays `[time, category, name, trigger, data]` | `PreSpecEventParser` (`QlogLoader.ts:970-1010`), built by `DEBUG_LoadRandomFile` (`ConnectionStore.ts:92-114`) | the `#/debug` fake groups | latest-draft event objects (§9.7) |

qvis also attaches implementation-specific runtime fields that are **not** qlog. §9.8 has the complete list with the
port's storage for each:

- `connection.wasAutoGenerated` (boolean)
- `connection.qvis.sequencediagram.generatedSibling` and `connection.qvis.sequencediagram.manualTimeOffset`
- `event.qvis.sequencediagram.focusInfo {connectionIndex, eventIndex}`, used to build the "Direct link to this event"
  URL, and `event.qvis.sequencediagram.y`
- `event.qvis.congestion.{correspondingAck, correspondingLoss, correspondingPackets}`
- one read-only input member: `frame.qvis.sequence.hide` (`SequenceDiagramD3Renderer.ts:1637`)

The port should keep such derived data in side maps (WeakMap) or typed fields, not on raw event objects.

---

## 5. URL query parameters and global state

### 5.1 Every URL query parameter in the codebase

How parameters are read:

- vue-router parses the hash query (`$route.query`). Rule 1 copies a pre-hash `location.search` into it on the first
  navigation.
- Rule 2 keeps the query on every navigation.
- `App.mounted` forwards the whole query object to `loadFilesFromServer`, which forwards **all** of it to the backend
  `/loadfiles` when it falls back.

| Param | Read at | Semantics |
|---|---|---|
| `file` | `ConnectionStore.ts:131-134`; FileManager's "Fetch" also builds `{file}` | A single file URL. qvis first tries a direct `fetch` (when the URL contains `.qlog`, `.sqlog`, `.netlog` or `.json`), then falls back to the backend. It becomes `group.URL` and `URLshort`, which the file manager shows as a link and the sequence diagram uses in "Direct link to this event". |
| `list` | `ConnectionStore.ts:135-137`; Fetch builds `{list}` when the input `endsWith(".json")` | URL of a pcap2qlog list JSON (`{description, paths:[{capture, secrets, description}]}`). Because it contains `.json`, a direct fetch is tried first; the list format is not recognized as qlog, so it throws and falls back to the backend, which runs pcap2qlog. |
| `file1`, `file2`, ... `fileN` | `ConnectionStore.ts:138-144` (only `file1` is checked); qvis-server `FileFetchController.ts:181-211` | Several files. The client always sends them to the backend; `" etc."` is appended to `file1` to break the direct path. The server reads `file1..N` until the first gap and merges them into one qlog through pcap2qlog. |
| `secrets`, `secrets1..N` | backend only (`FileFetchController.ts:154-205`); Fetch adds `secrets` | The TLS key log URL for a `.pcap`. It is required by the server unless the file is `.qlog`, `.pcapng` or `.netlog`. |
| `desc`, `desc1..N` | backend only (`FileFetchController.ts:179,205,250`) | Descriptions written into the generated list. |
| `focusOnConnection` | `SequenceDiagramRenderer.vue:60-71` (in `created()`) | The index into the sequence diagram's trace columns. It is used together with `focusOnEvent`, or optionally with `focusOnPN` (default 0). |
| `focusOnEvent` | same | The event index in that trace to scroll to on first render. Truthiness bug: `0` does not work (§7 Q17). |
| `focusOnPN` | same | Scroll to the first event whose `data.header.packet_number` equals this value (string comparison). `0` does not work. |
| `forceFull` | `SequenceDiagramD3Renderer.ts:1242` (`location.hash.indexOf("forceFull") >= 0`) | A substring flag anywhere in the hash, with any value (`?forceFull`, `&forceFull=1`, or even inside a file URL). It forces a full, non-virtualized sequence render. |
| `multimultiplexing` | `MultiplexingGraphConfigurator.vue:80-85` (`location.toString()` contains `"multimultiplexing"`, `":8080"` or `"localhost"`) | Shows the hidden "Load all connections at once" button. It is a substring test on the whole URL. |
| `nodemo` | `main.ts:65` | Dead (commented out). Do not port. |

Other location-based switches that are not query parameters:

- `":8080"` in the URL turns on `allowSelectAll` in the packetization configurator. The button using it is commented
  out, so this is dead.
- The backend URL selection in §3.5 step 5.

Parameter-producing URLs that the app itself creates:

- The sequence event modal link: `"https://qvis.quictools.info?#/sequence?" + fileLinks + "&focusOnConnection=" + i + "&focusOnEvent=" + j`.
  - `fileLinks` is `file=<URL>` for one distinct `group.URL`, or `file1=..&file2=..` for several.
  - Values are **not** URL-encoded and the host is hard-coded (§7 Q18).
- The file manager "Option 5" help links: `https://qvis.quictools.info/#?list=x.json`, `#?file=x.qlog`,
  `#?file=x.pcap&secrets=x.keys`, `#?file1=x.qlog&file2=y.qlog&file3=z.qlog`,
  `#?file1=x.qlog&secrets1=x.keys&file2=y.qlog&secrets2=y.keys` (file-manager spec).

### 5.2 Global (window, document) state

| What | Where | Notes |
|---|---|---|
| `window.location.search`, `.hash`, `.toString()` | router guard, `forceFull`, the `:8080`/`localhost` checks, `multimultiplexing` | see above |
| `window.holblockinfo = []` | `selectAllConnections()` in the multiplexing and packetization configurators | Global debug sink for paper results ("just for paper results, remove!"). Optional to port. |
| `document` `keyup` listener | `CongestionGraphConfigurator` (the R key toggles the ruler) | Added on mount, removed in `beforeDestroy`. The congestion spec owns it. |
| `window` `scroll` listener | `SequenceDiagramD3Renderer` | sequence spec |
| `alert(...)` | loaders (out-of-order timestamps, non-compliant draft-02), `tcptoqlog`, packetization models | synchronous browser alerts, owned by the respective specs |

No `localStorage`, `sessionStorage`, cookies, `document.title` changes or `process.env` usage exist.

### 5.3 Vuex state (summary)

- `connections.groups`: every loaded file. Groups are mutable class instances.
  - Group fields: `version`, `format`, `filename`, `title`, `description`, `URL`, `URLshort`, `summary`, and
    connections reachable through `getConnections()`.
  - Each connection has `parent`, `title`, `description`, `vantagePoint`, `wasAutoGenerated` and events.
  - Reactivity covers group and connection fields; it does **not** cover events or the event parser
    (`_isVue = true` hack).
- `connections.outstandingRequestCount`: drives the "Loading files..." and "Please load a trace file" alerts.
- `configurations.*`: the five config objects in §3.4.

---

## 6. Edge cases, error handling, notifications

### 6.1 Every notification in qvis (verbatim)

All use `group: "default"`. "Default" duration means 3000 ms. Text marked HTML contains `<br/>`.

| # | Source | type | duration | title | text |
|---|---|---|---|---|---|
| N1 | `ConnectionStore.addGroupFromQlogFile` (`:82-88`): the loader returned `undefined` | error | 6000 | `"ERROR parsing qlog file " + filename` | `File was successfully loaded but could not be parsed.<br/>Make sure you have a well-formed qlog file.<br/>View the devtools JavaScript console for more information.` |
| N2 | `loadFilesFromServer` start (`:152-156`) | (none) | default | `Loading file(s) via URL` | `"Loading files via URL " + urlToLoad + ".<br/>The backend server downloads the files, possibly transforms them into qlog, then sends them back. This can take a while."` |
| N3 | `loadFilesFromServer` success (`:305-310`) | success | default | `Loaded files via URL` | `"The loaded files are now available for visualization " + urlToLoad + ".<br/>Use the menu above to switch views."` |
| N4 | `loadFilesFromServer`: no usable content (`:315-321`) | error | 6000 | `"ERROR loading URL " + urlToLoad` | `"File(s) could not be loaded from " + urlToLoad + ".<br/>View the devtools JavaScript console for more information."` |
| N5 | `loadFilesFromServer`: exception (`:329-335`) | error | 6000 | same as N4 | same as N4 |
| N6 | `loadQlogDirectlyFromURL` start (`:363-367`), used by the demo loaders | (none) | default | `Loading qlog file directly` | `"Loading qlog file \"" + filename + "\" from URL " + url + ". Large files can take a while to load."` |
| N7 | `loadQlogDirectlyFromURL` qlog success (`:383-388`) | success | default | `"Loaded " + filename` | `This file is now available for visualization, use the menu above to switch views.` |
| N8 | `loadQlogDirectlyFromURL` tshark-JSON success (`:401-406`) | success | default | same as N7 | same as N7 |
| N9 | `loadQlogDirectlyFromURL` unrecognized content (`:412-418`) | error | 6000 | `"ERROR loading " + filename` | `"This file could not be loaded from " + url + ".<br/>View the devtools JavaScript console for more information."` |
| N10 | FileManager `loadURL`: `.pcap` without secrets | error | 6000 | `Provide .keys file` | `You're linking to a .pcap without also providing a .keys file. This is currently not supported.` |
| N11 | FileManager `uploadFile`: `.pcap` without secrets | error | 6000 | `Provide .keys file` | `You're uploading a .pcap without also providing a .keys file. This is currently not supported.` |
| N12 | FileManager `uploadFile`: bad extension | error | 6000 | `Provide .qlog/.sqlog file` | `"We currently only support uploading .qlog/.sqlog files. " + file.name` |
| N13 | FileManager `uploadFile`: start, one per file | (none) | default | `Loading uploaded file` | `"Loading uploaded file " + name + ".<br/>The file is not sent to a server."` |
| N14 | FileManager `uploadFile`: success | success | default | `Uploaded file` | `"The uploaded file is now available for visualization " + name + ".<br/>Use the menu above to switch views."` |
| N15 | FileManager `uploadFile`: failure | error | 6000 | `Error uploading file` | `"Something went wrong. " + name + ". For more information, view the devtools console."` |
| N16 | FileManager `loadExamples`: a group whose filename starts with `DEMO` already exists | warn | default | `Example files already loaded` | `Example files were already loaded, check for files with the 'DEMO_' prefix.` |
| N17 | FileManager `loadMassiveExample`: already loaded | warn | default | `Example file already loaded` | `Example file was already loaded, it is called 'MASSIVE_DEMO_mvfst_large'.` |
| N18 | `SequenceDiagramRenderer`: the first selected trace has more than 10000 events (then waits 200 ms) | warn | default | `Trace might take long to render` | `Some large traces can take a long time to render. Please be patient.` |
| N19 | `SequenceDiagramRenderer`: `render()` resolved false | error | default (3000) | `Trace could not be rendered` | `This trace could not be rendered. There could be an error or a previous file was still rendering.<br/>See the JavaScript devtools for more information.` |
| N20 | `PacketizationDiagramRenderer`: more than 10000 events (then waits 200 ms) | warn | default | same as N18 | same as N18 |
| N21, N22 | `PacketizationDiagramRenderer`: the top or bottom renderer resolved false (can fire twice) | error | default | same as N19 | same as N19 |

Commented-out notifications exist in `FileManagerContainer.vue:401-417` and in the `.catch` of
`loadQlogDirectlyFromURL` (`ConnectionStore.ts:421-431`). Do not port them as-is; see Q31.

Known notification orderings:

- **URL load with a parse failure:** N2, then N1 (error), then N3 (success), because the add is dispatched and the
  success is shown unconditionally (§7 Q32).
- **Upload with a parse failure:** N13, then N1, then N14.

### 6.2 Shell edge cases

- **No files loaded:** each tool shows the danger alert "Please load a trace file to visualize it". While a URL load
  is pending (`outstandingRequestCount > 0`) and no group exists yet, it shows the warning "Loading files..." instead.
- **Unknown hash route:** blank page with no menu (rule 4 in §3.3 covers the query-carry-over variant).
- **A query without a file parameter:** `loadFilesFromServer` logs and returns; no notification.
- **A malformed percent-escape in the hash query:** `decodeURIComponent` throws inside vue-router and the app does not
  render.
- **A file that yields zero connections** (`traces: []`):
  - Auto-select sets `connection = undefined` (congestion; harmless) or `[undefined]` (multiplexing, packetization),
    and then ConnectionConfigurator throws on `this.connection.parent`.
  - Sequence `selectDefault` throws in `createConnectionWithTimeoffset(undefined)`.
  - See Q12.
- **A selected group is removed** (file manager "Remove" or debug "Delete First"):
  - configs keep stale references, so the visualization still shows the removed trace
  - the combined header still prints the removed file's name
  - the `<select>` shows a blank selection because no option matches
- **More than 30 combined options** (groups + connections): the selectors switch to two-select mode (§2.5.4).
- **Duplicate query keys:** they become arrays in vue-router (`file: ["a","b"]`). `loadFilesFromServer` then
  misbehaves: `Array.indexOf(".qlog")` is -1, so it skips the direct path, and axios serializes the array as
  `file[]=a&file[]=b`, which the server rejects. Pre-hash duplicates are last-wins instead.
- **`+` in parameter values becomes a space** on both parse paths (vue-router and URLSearchParams). Users must encode
  it as `%2B`.

---

## 7. Known bugs and quirks: PRESERVE or FIX

| ID | Quirk | Decision |
|---|---|---|
| Q1 | The tab active state uses `fullPath.indexOf('/x')`, which includes the query. A file URL containing `/files` or `/stats` lights up extra tabs. | **FIX:** match on the route path only; exact match, case-insensitive. |
| Q2 | `$route.fullPath === ''` is dead. | Drop. |
| Q3 | Menu `href`s omit the query, so "open in new tab" loses `?file=`. | **FIX:** render hrefs with the current query string. In-app behavior is unchanged because rule 2 adds the query anyway. |
| Q4 | An unknown route renders a blank page without the menu. | **FIX:** a catch-all route that redirects to `/files`, keeping the query. |
| Q5 | After rule 1, `location.search` stays in the URL forever (`?file=x#/files?file=x`). | **PRESERVE:** harmless, and stripping it would change shared URLs. |
| Q6 | URL-triggered loading runs only once at startup. Editing the hash to a new `?file=` while the app is open does nothing. | **PRESERVE** for parity. Optional later improvement: load on hashchange when `file`, `list` or `file1` changes. |
| Q7 | Notification title and text are injected as HTML, including user-controlled URLs and filenames (XSS through `?file=<img onerror=...>`). | **FIX (security):** escape everything and turn only the literal `<br/>` (and `<br>`) into line breaks. |
| Q8 | `onGroupSelectionChanged` passes `this.selectedGroup` rather than the argument. | **FIX:** pass the newly selected group. This is behaviorally identical in practice. |
| Q9 | Separate-select mode (>30 options) drops the "Latency offset" input and the header label. | **FIX (functional gap):** render the numeric input (and `−`) in mode B too, laid out like mode C. Keep the header label absent in mode B. |
| Q10 | Only the `connection` prop is watched; `group` prop changes are not reflected. | **FIX naturally:** derive the selection from props in React. Not user-visible in qvis. |
| Q11 | Removing a group leaves stale selections in configs, so tools keep showing removed data and the select shows blank. | **FIX:** on `removeGroup`, clear every config reference into that group. The congestion connection and stats group become `undefined`; the sequence, multiplexing and packetization connection arrays drop the affected entries. The normal auto-select then picks the new `groups[0]` or shows the no-file alert. |
| Q12 | Groups with zero connections crash auto-select and the selector. | **FIX:** auto-select picks the first connection of the first group that **has** one. In mode B, changing to an empty group must not call `onConnectionSelected(undefined)`; keep the previous selection. |
| Q13 | Sequence-generated sibling traces are appended to `group.getConnections()` and leak into every selector and count. | **PRESERVE** (owned by the sequence-diagram spec). The selector must simply list whatever the group contains. |
| Q14 | `outstandingRequestCount` leaks or goes negative: no decrement after a direct-download success, no decrement for non-qlog URLs, and a double decrement on some backend error paths. Visible as "Loading files..." stuck forever after removing all files or after a failed load. | **FIX:** wrap each request in increment / `finally` decrement. |
| Q15 | The number input sends `parseFloat("")`, which is `NaN`. | **FIX:** ignore non-finite values; keep the old value. |
| Q16 | The sequence selector `key = index + timeOffset` (numeric sum) can collide (`0+1 === 1+0`). | **FIX:** use the key `${index}:${timeOffset}`. The sequence spec owns this. |
| Q17 | `focusOnEvent=0` and `focusOnPN=0` are ignored because of truthiness checks. | **FIX:** check `!== undefined`. Sequence spec. |
| Q18 | The event deep link hard-codes `https://qvis.quictools.info` and does not encode values. | **FIX:** `location.origin + location.pathname + "#/sequence?" + encoded params`. |
| Q19 | `focusOn*` parameters are sticky (rule 2), so returning to the Sequence tab re-focuses. | **PRESERVE.** |
| Q20 | The "Load all connections at once" button is gated on a URL substring (`:8080`, `localhost`, `multimultiplexing`). | **PRESERVE** semantics. The Vite dev server on `localhost:5173` matches `localhost`. |
| Q21 | `#/debug` injects random fake groups into the real store. | **PRESERVE** (debug page), but generate latest-draft-shaped events (§8.8). |
| Q22 | `favicon.ico` is referenced but missing. | **FIX:** ship a favicon. |
| Q23 | Backend URL selection by `:8080` substring. | **FIX:** a build/runtime config value (§8.9). |
| Q24 | A TraceError without `uri` gets the description `"undefined : <error>"`. | **FIX:** omit the `uri : ` prefix when `uri` is absent. |
| Q25 | A malformed `%` escape in the hash query crashes app start. | **FIX:** tolerant decoding (on failure, keep the raw string). |
| Q26 | Duplicate query keys produce arrays and break loading. | **FIX:** normalize every query value to a single string, taking the **first** occurrence (`URLSearchParams.get` semantics). |
| Q27 | `+` decodes to a space in query values. | **PRESERVE** (standard form-encoding). |
| Q28 | Fixed 290px brand heading, no responsive menu. | **PRESERVE.** |
| Q29 | MainMenu logs `$route` on mount; misnamed class. | Drop the log. |
| Q30 | No notification cap, so spam can fill the screen bottom-up. | **PRESERVE.** |
| Q31 | `loadQlogDirectlyFromURL` has no `.catch`: a network error leaves N6 shown, no error toast, and the counter stuck. | **FIX:** show N9 on network failure; decrement in `finally`. |
| Q32 | The success toast (N3, N14) is shown even when parsing failed (N1 already shown). | **FIX:** show success only if a group was actually added. |
| Q33 | The `apireturns.qlog_version` branch (`ConnectionStore.ts:240`) is dead because the axios response object never has it. | Drop. |
| Q34 | MainMenu is not remounted across routes; tool views are remounted on every switch (no keep-alive). | **PRESERVE** (renderers rebuild from the stored config on mount). |

---

## 8. Porting notes for React

### 8.1 Suggested module breakdown (fits the existing scaffold)

```
src/main.tsx                       migrate pre-hash query (rule 1), mount <App/>; import global CSS
src/app/App.tsx                    <MainMenu/> + current route view (or nothing) + <Notifications/>; startup URL load effect (once)
src/app/router.ts                  tiny hash router: route table, location store (useSyncExternalStore), navigate(),
                                   rule 2 (sticky query) applied *before* publishing a new location, catch-all → /files
src/app/query.ts                   parseQuery / stringifyQuery (vue-router-compatible encoding, tolerant decode, first-wins)
src/app/routes.ts                  [{path:"/files", name:"FileManager", view: FileManagerView}, ...] (names kept for reference)
src/components/shell/MainMenu.tsx  (+ MainMenu.css with the exact colors of §2.4)
src/components/shell/Notifications.tsx, src/lib/notify.ts, notifications.css
src/components/shared/ConnectionConfigurator.tsx
src/components/shared/NoTraceAlerts.tsx      the shared danger/warning alert pair (§2.5.7)
src/lib/connectionLabels.ts        connectionLabel(), groupOptionLabel(), combinedHeaderLabel()  (pure, unit-tested)
src/lib/colorHelper.ts             streamIdToColor(), isDataStream()                              (pure, unit-tested)
src/store/connectionStore.ts       zustand: groups, outstandingRequestCount, version counter, actions
src/store/configurationStore.ts    zustand: the 5 tool configs with the defaults of §3.4
src/views/*View.tsx                thin wrappers (FileManager, Sequence, Congestion, Multiplexing, Packetization, Statistics, Debug)
src/styles/global.css              App.vue globals + Bootstrap-4 parity overrides (§8.7)
```

### 8.2 Routing: why a small custom hash router is recommended

Exact parity needs four things:

- rule 2 applied synchronously **before** any view renders, because `SequenceDiagramRenderer` reads `focusOn*` once at
  creation
- the same rule applied to manual hash edits and back/forward
- `#?x=1` and `#/` handled as root
- control over query encoding

A ~100-line router built on `hashchange` plus `history.replaceState`, exposed through `useSyncExternalStore`, does all
of this without workarounds. If react-router is used instead (`createHashRouter`):

1. Apply rule 1 in `main.tsx` before the router is created.
2. Implement rule 2 inside the root layout with a ref holding the previous `location.search`. When the new location has
   an empty search and the previous one did not, `navigate({pathname, search: prev}, {replace: true})` and render
   `null` for that frame so the view never mounts without the query.
3. Add an index route `/` that redirects to `/files` **keeping `location.search`**, and a `*` route that does the same
   (Q4).
4. Verify the exact API names against the installed react-router 8.x.

Rule 1 in `main.tsx`, matching §3.3:

```ts
const { search, hash, pathname } = window.location;
if (search && search !== "?") {
  const body = hash.replace(/^#/, "");                      // "", "/seq", "/seq?", "?a=b", "/seq?a=b"
  const qi = body.indexOf("?");
  const hashQuery = qi >= 0 ? body.slice(qi + 1) : "";
  if (Object.keys(parseQuery(hashQuery)).length === 0) {   // "#/x?" counts as empty; "#/x?flag" does not
    let path = qi >= 0 ? body.slice(0, qi) : body;
    if (!path.startsWith("/")) path = "/" + path;           // "" -> "/" (router redirects to /files)
    const q: Record<string,string> = {};
    new URLSearchParams(search).forEach((v, k) => { q[k] = v; });   // qvis is last-wins here; see Q26 for normalization
    history.replaceState(null, "", pathname + search + "#" + path + "?" + stringifyQuery(q));
  }
}
```

Q26 recommends first-wins everywhere. Make one consistent choice and test it.

`stringifyQuery` should reproduce vue-router's encoder: `encodeURIComponent`, then ``[!'()*]`` mapped to `%xx`, then
`%2C` back to `,`. Keys keep insertion order. `parseQuery` must replace `+` with a space before decoding (Q27) and use
a tolerant `decodeURIComponent` (Q25).

The active tab comes from the route path (Q1), not the full path. The `.active` class goes on the `<a class="nav-link">`
and each `<li>` carries `files-link`, `sequence-link`, and so on, so the CSS of §2.4 applies unchanged.

### 8.3 Startup URL load

In `App` (or `main.tsx` after rule 1), run exactly once after the first location is resolved:
`if (Object.keys(query).length > 0) connectionStore.loadFilesFromServer(query)`. Guard against React StrictMode
double effects with a module-level `started` flag. Do not re-run on later location changes (Q6).

### 8.4 Notifications (replace vue-notification; no dependency needed)

- `src/lib/notify.ts` exposes a module-level emitter, `notify({group?, title?, text, type?, duration?})`, callable from
  stores and plain modules.
- `<Notifications group="default" position="bottom center" width="50%"/>` subscribes and ignores other groups.
- Each item gets an `id`. It is removed after `(duration ?? 3000) + 600` ms. Clicking removes it immediately.
- The list renders in insertion order inside a fixed bottom container, so the newest item is at the bottom.
- Enter and leave fade over `opacity .5s`; CSS transitions plus a short "leaving" state are enough.
- Use the CSS of §3.6 verbatim, including the black text for warn and error.
- Render text safely (Q7): split on `/<br\s*\/?>/i` and join the segments with `<br/>` React elements. Never use
  `dangerouslySetInnerHTML`.
- Keep the call sites' strings byte-identical to §6.1, with `<br/>` kept as a line-break marker.
- Add an `ariaLive="polite"` region. This is an accessibility addition; there is no visual change.

### 8.5 ConnectionConfigurator in React

- Make it a fully controlled component. Derive `selectedGroup` from `props.group ?? props.connection?.parent`. No
  internal mirror state except the number input's draft text.
- `<select>` values must be strings, so encode identity by index:
  - group: `"g:<gi>"`
  - connection: `"c:<gi>:<ci>"`
  - header rows: `"h:<gi>"` (disabled unless `allowGroupSelection`)

  Map back by indexing into `allGroups`. Compute the selected value by **identity** (`===`) search. If nothing
  matches, render `value=""` with a hidden empty option so the select shows blank, which is qvis-visible behavior for
  stale selections. With the Q11 fix this should no longer happen.
- `tooManyOptions = Σ(1 + group.getConnections().length) > 30`.
- Mode A is chosen when `allowGroupSelection && !allowConnectionSelection`. Otherwise mode B if `tooManyOptions`,
  otherwise mode C. Markup and classes are as in §2.5.4, using the Bootstrap 5 names:
  - `custom-select` becomes `form-select`
  - `b-col cols=2` becomes `col-2`; `cols="auto"` becomes `col-auto`
  - the spacer is `col` with `style={{maxWidth: 36}}`
- Number input: keep a local draft string. Reset it when `props.connection` identity changes or the component is
  re-keyed. Fire `onNumericalValueChanged(parseFloat(draft))` on the **native** `change` event (attach it through a
  ref, or use `onBlur` + `onKeyDown(Enter)` + spinner handling), not on every keystroke. Skip `NaN` (Q15).
- Tooltip on "Latency offset : ": react-bootstrap `OverlayTrigger` with `trigger="hover"`, `placement="top"`.
- Re-render when groups change or are mutated: subscribe to `groups` and to a `groupsVersion` counter in the
  connection store. Bump the counter whenever loaders or the sequence diagram add connections, such as auto-generated
  siblings.
- Write unit tests for labels (§2.5.5 table), mode switching at 30 and 31 options, group-change auto-selection
  (§2.5.6), and identity matching with two structurally identical groups (load the same file twice).

### 8.6 Stores (zustand)

- Groups and connections are mutable class instances (events can be huge) and must **not** be deep-copied or frozen.
  Keep them in an array in the store. Replace the array reference on add or remove, and bump `groupsVersion` for
  in-place mutations such as the title change in `#/debug` or generated siblings.
- Configs: one zustand store holding the five config objects. Tools may keep mutating the objects through store
  actions that replace the object or slice so React re-renders. Defaults are in §3.4.
- Auto-selection (§2.5.7) becomes a `useEffect` in each tool configurator keyed on
  `[groups, groupsVersion, isEmpty(config)]`. Include the Q12 guard. The congestion renderer handle (`config.renderer`)
  should live in a ref or context, not in the store.
- `removeGroup(group)` also scrubs configs (Q11).

### 8.7 Bootstrap 4 vs 5 parity (the scaffold uses Bootstrap 5.3)

The original renders with Bootstrap 4.3.1. To stay visually 1:1 with Bootstrap 5, add overrides in
`src/styles/global.css`, or switch the dependency to `bootstrap@4.6.x` CSS and drop react-bootstrap for the few
components needed. Either choice is acceptable; overrides are less churn.

- **Links:** Bootstrap 5 underlines links and uses `#0d6efd`. Bootstrap 4: `a { color: #007bff; text-decoration: none }`
  and `a:hover { color: #0056b3; text-decoration: underline }`.
- **Gutters:** Bootstrap 4 uses 15px column padding and `container-fluid` padding. Set
  `.row { --bs-gutter-x: 30px }` and `.container-fluid { padding-left: 15px; padding-right: 15px }`.
- **Headings:** Bootstrap 5 uses responsive font sizes (RFS). Fix them to the Bootstrap 4 sizes: h1 2.5rem, h2 2rem,
  h3 1.75rem, h4 1.5rem, h5 1.25rem, h6 1rem; weight 500, line-height 1.2, margin-bottom .5rem.
- **Button colors** (Bootstrap 4 → Bootstrap 5 defaults differ):

  | Variant | Bootstrap 4 background / hover | Bootstrap 5 default |
  |---|---|---|
  | primary | `#007bff` / `#0069d9` | `#0d6efd` |
  | secondary | `#6c757d` | `#6c757d` (same) |
  | success | `#28a745` / `#218838` | `#198754` |
  | danger | `#dc3545` / `#c82333` | same |
  | info | `#17a2b8` with **white** text | `#0dcaf0` with black text |
  | warning | `#ffc107` | same |

  Override `--bs-btn-*` variables per variant.
- **Alerts:**
  - Bootstrap 4 danger: bg `#f8d7da`, text `#721c24`, border `#f5c6cb`
  - Bootstrap 4 warning: bg `#fff3cd`, text `#856404`, border `#ffeeba`
  - Bootstrap 5 uses darker text; override if exact.
- **Nav tabs:** Bootstrap 5 `.nav-link` defaults to link blue. The MainMenu CSS already forces black and lightgrey.
  Also reproduce the Bootstrap 4 hover border `#e9ecef #e9ecef #dee2e6` and active border `#dee2e6 #dee2e6 #fff`.
- **Class renames:**
  - `custom-select` → `form-select`
  - `ml-*`/`mr-*` → `ms-*`/`me-*`
  - `text-right` → `text-end`
  - `btn-block` → `w-100` (or `d-grid`)
  - `b-row align-h="center"` → `justify-content-center`
  - `b-col cols="1" md="auto"` → `col-1 col-md-auto`
- **Font:** keep `#app { font-family: 'Avenir', Helvetica, Arial, sans-serif; color: #2c3e50 }`. Do not load a
  webfont; Avenir is a macOS system font, as in the original.
- **bootstrap-vue component equivalents** used across the app, as a reference for other specs:

  | bootstrap-vue | React equivalent |
  |---|---|
  | `b-container`, `b-row`, `b-col` | plain `div`s with grid classes |
  | `b-button` | `Button`, or `a.btn` for `href` |
  | `b-alert show` | `Alert` |
  | `b-form-select` | native `select.form-select` |
  | `b-input`, `b-form-input` | `input.form-control` |
  | `b-form-file` | file input or drop zone (file-manager spec) |
  | `b-form-checkbox` | `Form.Check` |
  | `b-modal` + `$bvModal` | react-bootstrap `Modal`, controlled |
  | `v-b-tooltip.hover` | `OverlayTrigger` + `Tooltip` |
  | `b-nav`, `b-nav-item` | `ul.nav.nav-tabs` with links |
  | `b-tabs`, `b-tab` | `Tabs`, `Tab` |
  | `b-table-simple` and its parts | plain `table.table` |
  | `b-progress` | `ProgressBar` |
  | `b-link` | `a` |

### 8.8 Debug page

Port it as `views/DebugView.tsx` at `#/debug` with the same labels (§2.7) and the same "add 3 random groups if 1 or
fewer exist" behavior. Generate latest-draft-shaped events (exact mapping in §9.7):

```ts
{ time: j, name: "testcat:Connection #" + i + " - Event #" + j, data: { dummy: true, trigger: "dummytrigger" } }
```

Show the event's `type` (the canonical name after the first colon) in the list, as for real files (§9.4). For these
events that is `Connection #i - Event #j`, identical to qvis. Change Event Name sets the first event's name to
`"testcat:Event was changed"` without bumping the version, matching the "not reactive" semantics. Change Connection
Name bumps the version. The "- Event: ROBIN : {title} : {name}" rows render
only the **last** group's connections. Consider capping at a few thousand rows to avoid freezing on real traces; this
is a debug-only deviation and must be documented as such.

### 8.9 Hosting on Vercel; backend fallback

- Hash routing needs no rewrites. Serve `dist/` statically. `base: "./"` keeps relative assets working.
- There is **no qvis-server** on Vercel. The original falls back to `'/loadfiles'` (origin-relative). On Vercel that
  path is a 404, or `index.html` if an SPA rewrite exists. Either way the result is the N4/N5 error path, after a
  wasted request.
- **Decision for the file-loading spec owner:**
  - Make the backend base URL configurable. Suggested: `import.meta.env.VITE_QVIS_BACKEND_URL`, unset meaning "no
    backend; skip the fallback and show N4 immediately".
  - Optionally add a Vercel Function `api/loadfiles` that implements only qvis-server's *direct-download proxy* mode:
    a single `file=` ending in `.qlog`/`.sqlog`/`.netlog`/`.json`, optionally `.br`/`.gz`/`.zip`.
  - Such a function needs an http(s)-only allowlist, private-IP and SSRF blocking, and attention to Vercel's function
    response-size limits.
  - pcap, `list` and `file1..N` merging need pcap2qlog plus tshark and cannot run on Vercel. They should fail with N4,
    or point users to qvis-server.
- Replace hard-coded `https://qvis.quictools.info` links (event deep link, file-manager Option 5 examples) with the
  current origin.

### 8.10 Open-source repository chrome

- **Repository:** `github.com/mjoras/<repo>`. Point the two MainMenu buttons at that repository's
  `issues/new?template=feature_request.md&title=Feature+request` and
  `issues/new?template=bug-report-in-live-version.md&title=Bug+in+live+version`. Keep the URL in one constant
  (`src/app/constants.ts`).
- **Issue templates:** copy both templates into `.github/ISSUE_TEMPLATE/` with **identical filenames**. Replace the
  qvis-specific email address and "live version" wording as appropriate.
- **LICENSE:** MIT. Keep "Copyright (c) 2019 Hasselt University - EDM", because the code is derived from qvis, and add
  the new copyright line.
- **README:** what it is (latest qlog drafts only: main-schema-14, quic-events-13, h3-events-13; `.qlog` JSON and
  `.sqlog` JSON-SEQ), the hosted URL, local dev, Docker (optional parity with the original Caddy image on :8080), and
  a note on URL parameters (§5.1).
- **`index.html`:** keep the title and noscript verbatim (the scaffold already does). Add a real `public/favicon.ico`
  (Q22).

### 8.11 D3 and imperative code

The shell has no D3. `colorHelper` must stay a pure function: D3 renderers call it inside `.attr("fill", ...)`
callbacks, so it must stay cheap and synchronous. Keep the lazily-built maps, or two constant `Map`s. The D3 renderers
behind each tool stay imperative, mounted into a ref'd `<svg>`/`<div>` in `useEffect`, rebuilt on mount (no
keep-alive, Q34) and disposed on unmount. That includes removing the `window` scroll listener (sequence) and the
`document` keyup listener (congestion).

### 8.12 Suggested tests (parity harness)

- `query.test.ts`: `+` becomes a space; `a=b=c` gives `{a:"b=c"}`; a bare `a` becomes `null`, then normalized; a
  malformed `%` is tolerated; duplicates are first-wins; stringify escapes ``!'()*`` and keeps `,`.
- `router.test.ts`:
  - `#?list=x.json` → `/files?list=x.json`
  - `/?file=x#/sequence` → `/sequence?file=x`, with the search still present
  - a hash query wins over the pre-hash search
  - sticky query on navigation, and on a manual hash edit that removes the query
  - a new non-empty query replaces the old one
  - an unknown route → `/files`, keeping the query
- `MainMenu.test.tsx`: exactly one active tab per route, including when the query contains `/stats`; `#/debug` has
  none; hrefs carry the query.
- `colorHelper.test.ts`: the vectors in §3.7.
- `connectionLabels.test.ts`: the table in §2.5.5.
- `Notifications.test.tsx`: removal at 3600 and 6600 ms with fake timers; click-to-dismiss; newest at the bottom;
  HTML escaped but `<br/>` breaks lines; warn and error text black.
- Playwright e2e: load `#/files?file=<fixture URL>` → N2 then N3 → click "Sequence" → URL keeps `?file=` → the
  selector shows `"Loaded via URL (...)"` and the first trace is selected.
- `latestDraftLabels.test.ts`: the vectors in §9.11, fed through the real loader.

---

## 9. Mapping to latest qlog drafts

The input contract is draft-ietf-quic-qlog-main-schema-14, draft-ietf-quic-qlog-quic-events-13 and
draft-ietf-quic-qlog-h3-events-13 (all published 6 July 2026), plus the editor's-copy clarifications that the digests
list. Sources and citation forms used in this section:

- Digests in `docs/dev/qlog-spec/`: `main-schema.md` ("main digest"), `quic-events.md` ("quic digest"),
  `h3-events.md` ("h3 digest") and `ecosystem.md` ("ecosystem").
- Raw draft line numbers are written `main-14:NNN`, `quic-13:NNN` and `h3-13:NNN`. They use `grep -n` numbering of
  the `.txt` drafts in `the published draft texts (ietf.org)`.
- The loader belongs to `docs/dev/parity/data-model.md` and `docs/dev/parity/file-loading.md`. This section states
  what the shell needs from them and follows their decisions; any conflict is listed in §9.12.

Ground rules that apply to every row below:

1. **Canonical names only.** The shell, and every caller of `colorHelper`, sees event names after the load-time alias
   pass (ecosystem §6.4; data-model §3.16.4 step 3). `transport:packet_sent` (quic-go today), `http:frame_created`
   (the old HTTP/3 category) and `quic:datagrams_sent` (quiche) reach the shell as `quic:packet_sent`,
   `http3:frame_created` and `quic:udp_datagrams_sent`. Shell code never compares against a legacy name.
2. **A uint64 may be a JSON string** (main-14 §11.3; main digest §17.3). Every numeric identifier the shell touches
   (`stream_id`, `packet_number`, `quarter_stream_id`) may arrive as `4` or as `"4"`. The shell only converts them
   with `"" + x` or `parseInt(x, 10)`, as qvis did, so parity holds. Exceptions are noted where they apply.
3. **Unknown members are ignored, never fatal** (main-14 §8.4, §13). Extra keys on the file, trace, event, `data` or
   frame objects must not change anything the shell renders.
4. **Status words:**
   - SAME: same name and meaning.
   - RENAMED: same meaning, new name.
   - CHANGED: different optionality, value space or meaning.
   - REMOVED: no equivalent.
   - NEW: did not exist in draft-02.

### 9.1 File level (`LogFile` main-14:397, `QlogFile` :484, `QlogFileSeq` :689)

| Old (qvis) | Latest | Status | Semantic differences | When absent or invalid (qvis-react) |
|---|---|---|---|---|
| `qlog_version`: the load gate at the sites listed in §4 row 1, and `group.version` | `file_schema` (required, absolute URI): `urn:ietf:params:qlog:file:contained` (`QlogFile`, JSON) or `urn:ietf:params:qlog:file:sequential` (`QlogFileSeq`, JSON-SEQ) | REMOVED, replaced by `file_schema` | There is no version number at all. A file's identity is its file schema URI plus each trace's `event_schemas`, whose URIs carry a draft suffix such as `urn:ietf:params:qlog:events:quic-13`. File schema URIs carry **no** `-NN` suffix (main digest §3). `qlog_version` `"0.4"` (main-schema-06 to -09) is legacy as well. | **Gate:** `typeof root.file_schema === "string"` and its trimmed, lower-cased value is one of the two URNs. **Both present** (quic-go ≥ v0.56 writes `qlog_version:"0.3"` next to `file_schema`, ecosystem §3.1): `file_schema` wins and `qlog_version` / `qlog_format` are ignored. **`file_schema` absent, `qlog_version` or `qlog_format` present:** LegacyQlogError, file-loading notification X1, no group added. **Both absent but `traces` is an array:** accept as contained with a warning (file-loading §3.14 step 5). **Any other URI:** X2. `group.version`, which only Stats shows, becomes `fileSchema` (data-model D8). |
| `qlog_format` (`JSON`, `NDJSON`, `JSON-SEQ`), copied into `group.format` | `serialization_format` (required media type, **case-insensitive**): `application/qlog+json` or `application/qlog+json-seq` | RENAMED and CHANGED | The value changed from a keyword to a media type, and NDJSON no longer exists (JSON-SEQ replaced it). The bytes decide the framing: a leading RS (0x1E) means JSON-SEQ. The field itself is informational (main digest P6). | Missing or contradicting the bytes: a warning, not a rejection. quiche ≥ 0.27, neqo and quinn write the non-media-type values `"JSON-SEQ"` and `"JSON"` (ecosystem §5.2); these must load (§9.12 F1). `group.format` = the lower-cased value, or `""`. The shell never displays it. |
| `title`, `description`, copied into `group.title` and `group.description` | `LogFile.title?`, `LogFile.description?` (text) | SAME | none | `""`, also for non-string values. Labels then render `filename ()` or `filename (title : )`, exactly as in §2.5.5. |
| `summary` | none | REMOVED (main-schema-06) | none | `group.summary` stays `{}`. The shell never read it. |
| `traces` (required) | `QlogFile.traces?: [+ Trace / TraceError]` (optional; at least one entry when present). `QlogFileSeq.trace: TraceSeq` (exactly one trace: the header is the first JSON-SEQ record and every later record is one `Event`) | CHANGED | A sequential file always yields one trace before `group_id` splitting. | `traces` absent or `[]`: file-loading rejects the file ("File contains no traces", file-loading §3.14 step 5 and §6.3) and never adds an empty group. Keep the selector's zero-connection guard (Q12) anyway. |
| other top-level keys, for example quic-go's `code_version` | allowed | not applicable | none | Ignored by the shell; kept for the raw view. |

### 9.2 Trace level (`Trace` main-14:568, `TraceSeq` :772, `TraceError` :650, `VantagePoint` :794)

| Old | Latest | Status | Semantic differences | When absent or invalid |
|---|---|---|---|---|
| `traces[i]`, giving one `Connection` | `Trace` (contained), or the `TraceSeq` header plus the following records (sequential). file-loading §3.14 normalizes both to one `traces[]` entry. | SAME | `Trace` now **requires** `event_schemas` (at least one) and `events` (may be empty). A trace "typically" holds one connection; several are separated by `group_id` (editor's copy). | `events` missing: `[]` with a warning. `events: []` is legal: produce a connection with zero events. It appears in every selector with its normal label. qvis crashed here (`QlogLoaderV2.ts:124-125`). |
| `trace.title`, `trace.description` | same, on `Trace` and `TraceSeq` | SAME | none | `""`. The label then omits the title part and the `" : " + description` part. |
| `trace.vantage_point {name?, type, flow?}` (required in old qlog) | `VantagePoint {name?, type, flow?}` with `type` one of `client`, `server`, `network`, `unknown` and `flow` one of `client`, `server`, `unknown`. It is **optional** on `Trace` and `TraceSeq`. | CHANGED (now optional) | `flow` is required only for `type: "network"`. | **Missing, not an object, or without a truthy `type`:** `{name: "No VantagePoint set", type: "unknown", flow: "unknown"}` (PARITY), but keep a provided `name` (data-model §3.16.6 FIX; qvis overwrote it). **Non-standard values are displayed raw:** quic-go endpoint traces use `type: "transport"`, giving `transport : …`. The quiche crate's type also admits `flow: "network"`, which would give `… (flow = network) : …`. Perspective logic maps such values to `unknown`. **Copies:** each connection, and each `group_id` slice, gets its own copy of the object (data-model Q8 FIX), so the sequence diagram's renames stay local to that connection. |
| TraceError `{error_description, uri}` (`uri` required) | `TraceError {error_description, uri?, vantage_point?}` | CHANGED | `uri` is optional, and a `vantage_point` may be attached. | A placeholder connection: title `"ERROR"`; description `(uri !== undefined ? uri + " : " : "") + error_description` (Q24); zero events. Its vantage point is the TraceError's own `vantage_point` when that is an object with a `type`, otherwise the constructor default `{type: "unknown", flow: "unknown"}` **without** a name (data-model §3.16.6). qvis aborted a whole URL load when `traces[0]` was a TraceError (`ConnectionStore.ts:274-276`). The drafts define TraceError as the way to report one failed component of an otherwise good aggregate, so that abort has no basis: keep the other traces and show file-loading X5. |
| none | `event_schemas: [+text]` (required) | NEW | Only a hint; it is never an error (main-14 §8). | Not read by the shell. When missing: `[]` plus a diagnostic (data-model). |
| `common_fields` (`group_id`, `protocol_type`, `reference_time`, `time_format`, …) | `CommonFields {tuple?, time_format?, reference_time?, group_id?, * any}` (main-14:1465) | CHANGED | The shell reads only `group_id`, through the effective-value rule in §9.3. `protocol_type` and `protocol_types` were removed (main-schema-11). | `{}` |
| `configuration {time_offset, time_units, original_uris}` | none | REMOVED (main-schema-06) | none | Not read by the shell. `timeOffset` starts at 0 (data-model). |
| `event_fields` (CSV-style events; removed in draft-02, still accepted by qvis through `EventFieldsParser`) | none | REMOVED | Events are always JSON objects. | Without `file_schema`: rejected (ecosystem §6.7 message, file-loading X1). With `file_schema`: array-shaped events are skipped with the diagnostic `trace.event-fields-unsupported` (data-model §3.16.4). |

### 9.3 `group_id` splitting (the connection list and its titles)

Latest drafts: `Event.group_id?: GroupID` with `GroupID = text` (main-14:873, :1300). A producer may instead hoist it
once into `common_fields.group_id` (main-14:1465), which then applies to every event. quic-events-13 §1.4 recommends
the ODCID as the value. Implement data-model §3.16.5 (decision D2), which keeps qvis's titles:

- **Effective value per event:** `ev.group_id !== undefined ? ev.group_id : common_fields.group_id`. Non-string values
  go through `JSON.stringify` (PARITY).
- **When to split:** when **at least one event carries its own `group_id` member**. qvis looked only at `events[0]`
  (`QlogLoaderV2.ts:80-85`). `common_fields.group_id` alone never splits and never adds a prefix (PARITY). For
  example, quic-go writes the ODCID there, and its label stays `client : …`.
- **One connection per distinct effective value,** in first-appearance order, titled
  `"Group " + id + " : " + (trace.title ?? "")`, with the trace's description. A trace whose events all carry the same
  per-event value still becomes one connection with the `Group` prefix (PARITY).
- **Events with no effective value** form the slice `"(no group_id)"`, titled `"Group (no group_id) : " + title`
  (FIX: qvis produced `"Group undefined : "`).
- **`{}` events** are skipped (qvis skipped them in split mode, `:93-96`).
- **quinn** writes a per-event `group_id` and may interleave several connections in one stream (ecosystem §3.4). This
  rule gives one selector entry per connection, labelled `unknown : Group <id> : ` (vantage point `unknown`, no title).

### 9.4 Event names (`#/debug` list)

| Old | Latest | Shell rule |
|---|---|---|
| `parseEvent(evt).name`: the part of `name` after the first `:` (qvis takes `split(":")[1]`, `QlogLoaderV2.ts:348-363`), or the whole string when there is no colon. Pre-spec arrays use index 2 (`PreSpecEventParser`, `QlogLoader.ts:989-991`). | `Event.name` = `namespace + ":" + event_type` (required; main-14 §8). Namespaces: `quic`, `http3`, `http` (capsules only), `loglevel`, `simulation`, plus private ones. | Each debug row is `"- Event: ROBIN : " + connection.title + " : " + event.type`. `type` is the canonical name after the **first** colon (data-model `QlogEvent.type`). |

Examples of `type` for the debug list:

- `quic:packet_sent` → `packet_sent`
- `http3:frame_created` → `frame_created`
- `loglevel:error` → `error`
- `http:capsule_parsed` → `capsule_parsed`
- `mvfst:foo` → `foo`
- a name without a colon → the whole name (data-model: namespace `unknown`)
- a missing name → `unknown`

Differences from qvis:

- An event type that itself contains `:` keeps its tail. qvis dropped it. This is a FIX.
- Legacy prefixes show the canonical type: `recovery:metrics_updated` shows `recovery_metrics_updated`.

The events of a sequence-diagram generated sibling (§2.5.5, Q13) show up in the list as `packet_sent`,
`packet_received` or `ignoreseq`, because the sibling renames them (`SequenceDiagramD3Renderer.ts:543-554`). The name
setter replaces the type inside the full name, so `quic:packet_sent` becomes `quic:packet_received`. This is PARITY
and belongs to the sequence spec.

The shell does not read `time`, `data`, `tuple`, `time_format`, `system_info` or a per-event `reference_time`.

### 9.5 Stream IDs feeding `colorHelper` (§3.7)

`streamIdToColor(id: string, protocol)` does not change: same tables, same lookup, same test vectors. Only its inputs
move. Every caller still passes a decimal **string**. The exact latest sources:

| qvis caller | Old source | Latest source | Notes |
|---|---|---|---|
| `PacketizationQUICPreProcessor.ts:118`, `:171` (HTTP3 palette) | `http:frame_created` (sending direction) or `frame_parsed` (receiving direction), `data.stream_id`, passed as `"" + parseInt(stream_id, 10)` | `http3:frame_created` or `http3:frame_parsed` `data.stream_id` (uint64, **required**; h3-13:542, :569) | The event-level `stream_id` is the QUIC stream the frame travels on. For SETTINGS, GOAWAY, MAX_PUSH_ID, CANCEL_PUSH, PRIORITY_UPDATE and ORIGIN that is the **control stream** (2, 3, …), which maps to `lavenderblush`, exactly as in qvis. When it is absent (malformed input), qvis skipped the stream-lane entry (`frameEvt.stream_id !== undefined`); keep that. |
| `MultiplexingGraphD3WaterfallRenderer.ts:263`, `:417-475`; `MultiplexingGraphD3CollapsedRenderer.ts:414`, `:615`; `MultiplexingGraphD3ByterangesRenderer.ts:141`, `:155`; `MultiplexingGraphCollapsedRenderer.vue:147` (HTTP3 palette, filtered by `isDataStream`, which is `parseInt(id, 10) % 4 === 0`) | STREAM frames in `transport:packet_sent` or `packet_received` `data.frames[]` (`frame_type: "stream"`, `stream_id`) | `quic:packet_sent` or `quic:packet_received` (quic-13:1181, :1237) `data.frames[]` entries with `frame_type: "stream"` and `stream_id` (uint64, **required** in `StreamFrame`, quic-13:3029). `data.frames` itself is optional. | The direction per vantage point is unchanged (multiplexing spec §3.2). Frames without `stream_id` are skipped: in qvis `"" + undefined` gives `NaN % 4`, which is not a data stream. Byte lengths come from `streamFrameDataLength(f)` (multiplexing spec; ecosystem §6.6), not from the shell. |
| `MultiplexingGraphD3CollapsedRenderer.ts:465` (filter only) | `http:data_moved` (`HTTP3EventType.data_moved`) `data.stream_id` | `quic:stream_data_moved` `data.stream_id` (quic-13:1801), now **optional**. `http:data_moved` is aliased to it at load (ecosystem §6.4). | When absent, `isDataStream("undefined")` is false and the event is skipped (PARITY, no special code). |
| `MultiplexingGraphD3WaterfallRenderer.ts` (request info from HEADERS and PRIORITY_UPDATE) and `MultiplexingGraphD3SimulationRenderer.ts:107`, `:177` (dead code) | `http:frame_created` or `frame_parsed` `data.stream_id`; the PRIORITY_UPDATE target was `frame.element_id` | `http3:frame_created` or `http3:frame_parsed` `data.stream_id`. The PRIORITY_UPDATE target is now **`data.frame.stream_id`** (request stream) or `data.frame.push_id` (push stream) (h3 digest §10.4). | Never color a PRIORITY_UPDATE by its event-level `data.stream_id`, which is the control stream. The waterfall keys its streams by the STREAM-frame IDs anyway. |
| `PacketizationTCPPreProcessor.ts:231`, `:283` (**HTTP2** palette) | HTTP/2 `frame_created` or `frame_parsed` `data.stream_id`, produced by qvis's TCP converter (`tcptoqlog.ts`, `qlog_tcp_tls_h2.ts`) | **none**: no IETF qlog draft defines TCP, TLS-record or HTTP/2 events | See §9.9. Keep the HTTP2 table in `colorHelper` (it is pure and unit-tested) so a TCP path can come back with a private event schema. |

Value notes:

- `"" + 4` and `"" + "4"` both give `"4"`, so uint64 values sent as JSON strings hit the exact-string lookup. mvfst
  writes `stream_id` as strings (ecosystem §0). Packetization normalizes through `parseInt`, so `"04"` also works
  there, while multiplexing passes the raw value through `"" + id`. Keep both behaviours (PARITY).
- Values above 2^53 lose precision in `parseInt`, and the modulo cycling may then pick a different color. That is
  acceptable; qvis had the same limitation (main digest §17.3).
- A producer may log STREAM frames only in the frame events (`quic:frames_created`, `quic:frames_parsed`,
  `quic:frames_processed`; quic-13:1700, :1714, :1748), where `packet_numbers[i]` links `frames[i]` to its packet,
  and not inside `packet_sent` / `packet_received`. qvis's views then see no stream frames, so no stream colors are
  drawn. For parity, read packet events only and let the view show its "no data" state. Whether to also read frame
  events is a multiplexing and packetization decision, not a shell one.

### 9.6 Packet numbers (`?focusOnPN=`)

| Old | Latest | Rule |
|---|---|---|
| `transport:packet_sent` `data.header.packet_number`, matched type-only (`evt.name === "packet_sent"`, `SequenceDiagramD3Renderer.ts:1170-1172`) | `quic:packet_sent` `data.header.packet_number` (`PacketHeader`, quic-13:2637, field at :2659): uint64, **optional**, defined only for `initial`, `handshake`, `0RTT` and `1RTT` packets | Search only `packet_sent` events (never `packet_received`), in `connection.events` order (after load sorting and `group_id` splitting), within trace column `focusOnConnection` (default 0). The first event with `String(packet_number) === String(parseInt(focusOnPN, 10))` wins. Matching stays type-only (`type === "packet_sent"`), as data-model §4.2 specifies. |

Differences and absent cases:

- **`packet_number` absent** (retry, version_negotiation, stateless_reset, or a producer that omits it): the event is
  skipped. If nothing matches, qvis only logs `"packet number couldn't be found in the trace..."` to the console.
  PARITY: no toast.
- **PN 0** is unreachable in qvis because of truthiness checks (`:1162`, `:1171`). Q17 FIX: test `!== undefined` on
  both sides.
- **Packet number spaces.** QUIC numbers the `initial`, `handshake` and `application_data` (0-RTT and 1-RTT) spaces
  independently, each from 0 (quic digest §11). The drafts do not log the space; it is inferred from
  `header.packet_type`. `focusOnPN=3` therefore jumps to the first sent packet numbered 3 in **any** space, usually an
  Initial or Handshake packet. This is PARITY.
  - Optional additive extension, not in qvis, for the sequence spec to decide: `focusOnPNType=initial|handshake|0RTT|1RTT`
    restricts the match to `header.packet_type`. It changes nothing when absent.
- **JSON-string values** (`"12"`) compare equal through `String(...)`. For values above 2^53, compare decimal strings
  without `parseInt` (strip leading zeros from the query value) so exact matches still work. This FIX cannot change
  any result below 2^53.

### 9.7 `#/debug` random groups in latest-draft shape (replaces the pre-spec arrays)

qvis builds `[j, "testcat", "Connection #i - Event #j", "dummytrigger", {dummy: true}]` (`ConnectionStore.ts:92-114`)
and reads it through `PreSpecEventParser`: index 0 is the time, 1 the category, 2 the name, 3 the trigger and 4 the
data. The latest-draft equivalent of each array:

```ts
{ time: j, name: "testcat:Connection #" + i + " - Event #" + j, data: { dummy: true, trigger: "dummytrigger" } }
```

- The category becomes the namespace (main-14 §8; categories were removed in main-schema-10).
- The top-level trigger moves into `data.trigger` (main-14 §8.2.1).
- The displayed type (§9.4) is `Connection #i - Event #j`, byte-identical to qvis.
- Build the group directly, as qvis did, not through the file loader:
  - `filename: ""`, `title: ""`, `description: <random name>`, no `file_schema`
  - each connection with `vantage_point {type: "unknown", flow: "unknown"}` and no name

  Labels therefore stay `unknown (flow = unknown) : Connection <i>`, and the group header option stays blank, as in
  qvis. If the implementation routes the group through the normalizer anyway, pass that explicit vantage point and
  suppress diagnostics.
- "Change Event Name" sets the first event's name to `"testcat:Event was changed"` (displayed as
  `Event was changed`) without bumping `groupsVersion`, matching qvis's "not reactive" behaviour.

### 9.8 Runtime-only fields (never qlog)

qvis writes the fields below onto the parsed objects. None of them exists in any draft. The port keeps them in typed
fields or in `WeakMap`s keyed by the connection or event object, never on the raw event or frame. Raw objects must stay
byte-identical for the raw-JSON views and for downloads (file-loading §4, last row).

| qvis field | Set and read at | Port |
|---|---|---|
| `connection.wasAutoGenerated` | set at `SequenceDiagramD3Renderer.ts:470`; read by the sequence configurator (`allowCustomTimeOffset`, §2.5.2) and the renderer | a typed boolean on the connection model |
| `connection.qvis.sequencediagram.generatedSibling` | `SequenceDiagramD3Renderer.ts:454-458`, `:558-560` | `WeakMap<Connection, Connection>` (sequence spec) |
| `connection.qvis.sequencediagram.manualTimeOffset` | `:608`, `:614-618`, `:783` | sequence-spec state |
| `event.qvis.sequencediagram.focusInfo {connectionIndex, eventIndex}` | set at `:107-109`; read at `SequenceDiagramRenderer.vue:97-130` ("Direct link to this event") | `WeakMap<event, EventPointer>` |
| `event.qvis.sequencediagram.y` | `:968` and later | a renderer-local map |
| `event.qvis.congestion.{correspondingAck, correspondingLoss, correspondingPackets}` | `CongestionGraphD3Renderer.ts:874-1584` | congestion spec |
| vantage-point renames: the sibling gets `name = "GENERATED"` (`:469`); the unknown-perspective guess renames **both** traces to `"vantage point type was unknown, pretending it's " + side` (`:528`, `:531`) | visible in every selector label (§9.11 row 11) | PRESERVE, on the per-connection copy (§9.2) |

qvis also reads, but never writes, one **input** member: `frame.qvis.sequence.hide` on a QUIC frame
(`SequenceDiagramD3Renderer.ts:1637`). Frames are open maps in the drafts (`$QuicFrame /= { * text => any }`, quic
digest §8), so this remains a legal private member. Keep reading it (sequence spec). Nothing in the shell depends on
it.

A trap for the port: events and `common_fields` are open maps too, so a producer may legally log a top-level member
named `qvis`. qvis's `createPrivateNamespace` (`SequenceDiagramD3Renderer.ts:571-579`) reuses an existing `qvis` object
and writes its runtime state into it. Side maps avoid that clash.

### 9.9 Old inputs with no latest-draft equivalent

| Old input | Why it is gone | Proposed behaviour |
|---|---|---|
| `qlog_version` and every version-based branch | main-schema-10 replaced it with `file_schema` + `serialization_format` | Gate on `file_schema` (§9.1). Show `fileSchema` where qvis showed the version (Stats). Draft identity per namespace comes from the `event_schemas` suffixes (Stats and diagnostics only). |
| `qlog_format: "NDJSON"` (`.qlognd`) | replaced by JSON-SEQ in main-schema-01 | Reject with the ecosystem §6.7 NDJSON message. |
| `summary` | removed in main-schema-06 | Nothing to show; the shell never used it. |
| `configuration.time_offset`, `time_units`, `original_uris` | removed in main-schema-06; all times are in ms | `timeOffset` is 0 at load; no unit scaling. |
| `event_fields` and array events (draft-00/01) | removed in draft-02 | Reject or skip (§9.2). |
| the event `category`, and the `common_fields.category` / `common_fields.name` fallbacks (`QlogLoaderV2.ts:331-346`, `:400-405`) | categories were removed in main-schema-10 | The namespace comes from the name prefix. The debug list shows `type` and is unaffected. |
| a top-level event `trigger` (pre-spec array index 3) | moved into `data.trigger` | Only the debug generator used it (§9.7). |
| HTTP/2, TLS-record and TCP events (the HTTP2 palette input) | no IETF qlog draft covers them | Keep the palette code. If a TCP converter is kept, it must emit a private event schema (for example `https://<domain>/112026/tcp`, following the main-14 §3.1 private-URI rule; ecosystem Q3) and keep `common_fields.protocol_type: "TCP_HTTP2"` so that data-model `protocolHint` routes it. Otherwise only tests reach the HTTP2 table. |
| `http:data_moved` as an HTTP/3 event | moved to `quic:stream_data_moved`; the `http` namespace now means the Capsule Protocol | Alias it at load (ecosystem §6.4 exact table). Never treat `http:capsule_*` as HTTP/3. |
| a TraceError in `traces[0]` aborting a URL load | the drafts define TraceError as a per-component placeholder | Keep the other traces and warn with file-loading X5 (§9.2). |
| qvis-server/pcap2qlog output (`qlog_version: "draft-02-wip"`, `event_fields`, vantage point `{name:"pcap", type:"network", flow:"client"}`) and qvis's netlog converter output (`draft-01`) | legacy formats | Through the backend, the startup URL load (§3.5) can only succeed for proxied latest-draft files. Converted output is rejected with X1 unless the converters are updated (file-loading D1, D4). The shell's N2/N4/N5 flow is unchanged. |

### 9.10 New in the latest drafts: what the shell could show

| New item | Where it would surface in the shell | Recommendation |
|---|---|---|
| `TraceError.vantage_point` (main-14:650) | the prefix of the ERROR placeholder's label | **Adopt** (§9.2): `server : ERROR : …` instead of `unknown (flow = unknown) : ERROR : …` when a vantage point is given. |
| `common_fields.group_id` / ODCID (quic-13 §1.4), and the custom `common_fields.odcid` (mvfst) | could tell apart the many untitled traces (`client : `) | **Do not** change `connectionLabel`: labels are parity test vectors. Optional: put the `group_id` into the `<option title="…">` tooltip, which is invisible unless hovered. |
| `file_schema`, `serialization_format`, `event_schemas` | none in the shell | Stats and file manager only. |
| `tuple` and `quic:tuple_assigned` (main-14 §7.2, quic-13:816) | could create one selector entry per path | **No.** A tuple is a network path inside one connection (migration, multipath). Splitting by tuple would break packet-number and stream continuity in every tool. Split connections by `group_id` only. |
| `http3:datagram_created` / `http3:datagram_parsed` `quarter_stream_id` (h3-13:593, :625) | the color of HTTP/3 datagrams, if a view ever draws them | Optional helper next to `colorHelper`: `streamIdFromQuarterStreamId(q) = q * 4` (RFC 9297 §2.1), then `streamIdToColor("" + id, "HTTP3")`, so a request's datagrams share its stream color. No qvis view draws datagrams today. |
| `http3:stream_type_set` `stream_type` (h3-13:463) | could replace the `id % 4 === 0` heuristic of `isDataStream` | **Keep** the heuristic (PARITY). For RFC 9114 traffic the client-initiated bidirectional streams are exactly the `request` streams, so both agree. They differ only for extensions such as WebTransport. |
| `http:capsule_created` / `http:capsule_parsed` `stream_id` (h3-13:1098) | none | No shell change. Any view that draws capsules colors them by `stream_id` with the HTTP3 palette. |
| the `reset_stream_at` frame (`stream_id`, `reliable_size`; quic-13:2939) and the `datagram` frame (no stream ID; quic-13:3270) | none in the shell | Views that draw them (for example the sequence diagram's frame labels) color RESET_STREAM_AT by `stream_id`, like STREAM frames. DATAGRAM frames get no stream color. The collapsed multiplexing renderer already ignores non-`stream` frames that carry a `stream_id`. |
| `quic:frames_created`, `frames_parsed`, `frames_processed` with `packet_numbers[]`; `quic:packets_acked` | possible extra sources of stream IDs (§9.5) and packet numbers (§9.6) | Not read by the shell. Recorded as a decision for the multiplexing, packetization and sequence specs. |
| `loglevel:*` and `simulation:*` events | `#/debug` rows | Shown automatically as `error`, `warning`, `info`, `debug`, `verbose`, `scenario` and `marker`. |
| `system_info`, `reference_time.wall_clock_time`, per-event `time_format` | none | Not shown by the shell. |

### 9.11 Label test vectors for latest-draft input

These extend the §2.5.5 table, whose rows remain valid; its TraceError row describes a TraceError without a
`vantage_point`. `fn` is the filename. File-level fields affect only the group option labels, and trace fields only
the connection labels. Every input also carries the required `file_schema`, `serialization_format` and
`event_schemas` members unless shown otherwise.

| # | Input (abridged JSON) | Group option (`groupOptions`) | Connection label (`connectionLabel`) |
|---|---|---|---|
| 1 | contained: `{"file_schema":"urn:ietf:params:qlog:file:contained","serialization_format":"application/qlog+json","title":"T","description":"D","traces":[{"vantage_point":{"name":"aioquic client","type":"client"},"title":"Connection 1","event_schemas":["urn:ietf:params:qlog:events:quic-13"],"events":[]}]}` | `fn (T : D)` | `aioquic client : client : Connection 1` (zero events is fine) |
| 2 | sequential header with no top-level title or description (shaped like neqo's, ecosystem §3.3): `{"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"JSON-SEQ","trace":{"title":"neqo-Client trace","description":"neqo-Client trace","vantage_point":{"name":"neqo-Client","type":"client"},"event_schemas":["urn:ietf:params:qlog:events:quic-12"]}}` | `fn ()` | `neqo-Client : client : neqo-Client trace : neqo-Client trace` |
| 3 | top-level `"title":"quic-go qlog"`; trace `{"vantage_point":{"type":"client"},"common_fields":{"group_id":"<odcid>"}}`; no event has its own `group_id` | `fn (quic-go qlog : )` | `client : ` (no split, no Group prefix) |
| 4 | as 3, but the trace has `{"vantage_point":{"type":"transport"}}` (quic-go endpoint trace) | `fn (quic-go qlog : )` | `transport : ` |
| 5 | trace `{"vantage_point":{"type":"unknown"},"event_schemas":[]}`; events with `group_id` `"a1"` and `"b2"`, interleaved (quinn) | `fn ()` | `unknown : Group a1 : ` and `unknown : Group b2 : `, in first-seen order |
| 6 | trace `title:"T"`, `vantage_point {type:"client"}`; events with `group_id` `"a"`, `"b"` and one without | (any) | `client : Group a : T`, `client : Group b : T`, `client : Group (no group_id) : T` |
| 7 | every event has `group_id:"x"` (a single value); trace `title:"T"`, `vantage_point {type:"server"}` | (any) | `server : Group x : T` (PARITY: still prefixed) |
| 8 | TraceError `{"error_description":"File could not be found","uri":"/srv/a.qlog","vantage_point":{"type":"server"}}` | (any) | `server : ERROR : /srv/a.qlog : File could not be found` |
| 9 | TraceError `{"error_description":"File could not be found"}` | (any) | `unknown (flow = unknown) : ERROR : File could not be found` |
| 10 | `vantage_point {name:"edge-1"}` (no type), `title:"x"` | (any) | `edge-1 : unknown (flow = unknown) : x` (qvis: `No VantagePoint set : unknown (flow = unknown) : x`) |
| 11 | no `vantage_point`, `title:"x"`, empty description, after the sequence diagram auto-generated a sibling and guessed "server" (its default guess when no Initial with packet number 0 is found) | (any) | original: `vantage point type was unknown, pretending it's server : unknown (flow = unknown) : x`; sibling: `vantage point type was unknown, pretending it's client : client (flow = unknown) : Simulated, autogenerated trace : x : Simulated, autogenerated trace : ` |

Row 2 depends on §9.12 F1: the file must load despite `"serialization_format":"JSON-SEQ"`.

### 9.12 Cross-spec flags raised by this mapping

- **F1: `serialization_format` values that are not media types.** For a file without a leading RS, file-loading
  §3.14 step 3 throws `Unsupported serialization_format` for anything other than the two media types. quiche's
  contained writer and every quiche-based producer write `"JSON-SEQ"` or `"JSON"` (ecosystem §5.2), and the main
  digest (P6) treats a mismatch as a warning only. Recommendation to the file-loading owner: map `json` and
  `json-seq` (any case) to the media types with a compatibility note, and never reject on this field. RS-prefixed
  files already pass the sniff before the field is checked.
- **F2: alias-pass ordering.** The event-name alias pass (ecosystem §6.4) must run before every shell consumer: the
  debug list types, the `colorHelper` callers and `focusOnPN`. Otherwise quic-go traces (`transport:packet_sent`)
  silently lose deep-link focus and stream colors.
- **F3: split rule.** The data-model split rule (D2) and the main digest §10 recommendation differ for single-group
  traces. The shell follows D2 (§9.11 row 7).
- **F4: empty groups and empty connections.** file-loading never adds a group without traces, and data-model turns
  `events: []` into a zero-event connection. Together this means a group always has at least one connection, but a
  connection may have zero events. The selector only reads labels, so it handles zero-event connections as is; keep
  the Q12 guard anyway.
- **F5: vantage-point display.** Ecosystem §6.3 suggests lower-casing `vantage_point.type` and mapping unknown values
  to `unknown`. Data-model §3.16.6 keeps the raw value for display and maps it only for perspective logic. The shell
  shows what the data model stores (§9.11 row 4 expects `transport : `). Whoever changes this must update the
  vectors.

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`). Where this addendum contradicts the body, **this addendum wins**
(it aligns the body with `docs/dev/ARCHITECTURE.md`, which is binding).

### A1. No alias pass (G1): supersedes §9.1 rule 1, §9.9 row `http:data_moved`, §9.12 F2

ARCHITECTURE §0 and §3.1 forbid aliasing pre-final names and fixing up `data` (data-model §9.1 rule 2). Event names
reach the shell **exactly as logged** (`fullName === loggedName`, `data === raw.data`).

- §9.1 rule 1 now reads: "Latest names only. The shell, and every caller of `colorHelper`, matches -13 names exactly.
  A pre-final name (`transport:packet_sent`, `http:frame_created`, `quic:datagrams_sent`) is **not** rewritten: it is
  a non-conforming event (toast DM3, data-model §6.3) and no shell feature uses it."
- §9.9 row `http:data_moved`: replace "Alias it at load" with "Not recognized; a non-`capsule_*` `http:` name raises
  DM3. Never treat `http:*` as HTTP/3."
- §9.12 F2 is withdrawn. Consequences, all intended: on current quic-go output (`transport:*` names) `?focusOnPN=`
  finds no `quic:packet_sent` and logs the sequence diagram's "packet number couldn't be found in the trace..."
  diagnostic; the multiplexing and packetization views get no stream IDs, so `colorHelper` is never called; the
  `#/debug` list shows the logged type (`packet_sent`). The DM3 toast is the user-visible explanation.

### A2. Notification ID crosswalk (G6)

This spec's §6.1 numbering differs from `file-loading.md` §6.1, which is **canonical for every loading toast** (the
code names its message builders after the file-loading IDs, e.g. `N13_directLoadStart`). Read every "Nx" in this spec
(§3.5, §6.1, §7 Q31, Q32, §8.9) through this table:

| app-shell | file-loading | Title |
|---|---|---|
| N1 | N9 | `ERROR parsing qlog file <filename>` |
| N2 | N10 | `Loading file(s) via URL` |
| N3 | N11 | `Loaded files via URL` |
| N4, N5 | N12 | `ERROR loading URL <url>` |
| N6 | N13 | `Loading qlog file directly` |
| N7, N8 | N14 | `Loaded <filename>` |
| N9 | N15 | `ERROR loading <filename>` |
| N10 | N1 | `Provide .keys file` (linking) |
| N11 | N2 | `Provide .keys file` (uploading; dead) |
| N12 | N3 | `Provide .qlog/.sqlog file` |
| N13 | N4 | `Loading uploaded file` |
| N14 | N5 | `Uploaded file` |
| N15 | N6 | `Error uploading file` |
| N16 | N7 | `Example files already loaded` |
| N17 | N8 | `Example file already loaded` |
| N18, N19 | sequence-diagram §6.1 | `Trace might take long to render`, `Trace could not be rendered` |
| N20, N21, N22 | packetization-diagram §6.1 (N-PZ*) | same two titles |

So Q31 ("show N9 on network failure") means file-loading **N15** (`ERROR loading <filename>`), and Q32 ("N3, N14")
means file-loading **N11 and N5**. New toasts: X1-X7 (file-loading §6.2) and DM1-DM3 (data-model §6.3).

### A3. Backend (G7): supersedes §8.9

ARCHITECTURE §0 and file-loading §8.6 are authoritative:

- The CORS proxy `api/loadfiles.ts` (Vercel Function: SSRF guard, size cap) is always deployed.
- `vercel.json` rewrites `/loadfiles` and `/loadfiles/` to `/api/loadfiles`.
- The client tries a direct `fetch` first, then falls back to `/api/loadfiles?file=<url>`.
- There is **no** `VITE_QVIS_BACKEND_URL`. The only backend env hook is `VITE_PCAP_BACKEND_URL` (pcap/pcapng only;
  useful only if that backend emits latest-draft qlog).

`list` and `file1..N` are orchestrated client-side (file-loading §8.3, `loadList`/`loadMulti`), so they no longer
fail just because qvis-server is absent.

### A4. Routing stack (G8)

ARCHITECTURE §0 removes react-router. The stack line at the top of this spec ("react-router 8") is obsolete. In §8.2
only the custom-router branch applies; the "If react-router is used instead (`createHashRouter`)" branch is moot.
Q5 stays PRESERVE: rule 1 **copies** the pre-hash query into the hash and never strips `location.search`. Q26 is
decided as **first occurrence wins** on both paths, the startup load and the router (as implemented in
`src/app/query.ts` and `src/app/router.ts`). The "qvis is last-wins here" comment in the §8.2 snippet describes qvis,
not the port.

### A5. Console policy, cross-cutting (G13)

ARCHITECTURE §5 and `tests/e2e/smoke.spec.ts` fail on any `console.error` or uncaught exception. The view specs keep
qvis's diagnostics for debugging parity, and some of them fire on valid latest-draft input (HTTP/3-only traces,
missing `reference_time`, guesstimated frame sizes, ...). Project-wide rule:

1. Keep every qvis diagnostic **text** verbatim (prefix `ComponentName:function :`).
2. A diagnostic that can fire on valid -13 input, or on input the drafts allow to be partial, uses `console.warn`
   (or `console.debug` when it would fire per event).
3. `console.error` is only for internal faults: caught exceptions, impossible states, renderer failures that also
   show a toast (N19/N21/N22).
4. The e2e smoke suite must load the Option 3 demos and visit every route without any `console.error`.

### A6. Repository README (G15): extends §8.10

The README must also state the following, which change meaning compared with qvis's README:

- **Inputs:** `.qlog` (contained JSON) and `.sqlog` (JSON-SEQ) of the latest drafts only: main-schema-14,
  quic-events-13, h3-events-13. Legacy `qlog_version` files are rejected with a message. Chrome `.netlog` and tshark
  JSON (TCP/TLS/HTTP2) are converted client-side. `.pcap`/`.pcapng` are not supported, unless the deployment sets
  `VITE_PCAP_BACKEND_URL`.
- **Remote files:** the built-in `/loadfiles` CORS proxy replaces qvis-server for remote URLs.
- **Self-hosting:** Vercel (static `dist/` plus `api/`), or any static host, where remote URLs then need CORS on the
  origin.
- **Browsers:** current Chrome, Edge, Firefox and Safari. `DecompressionStream` is required for `.gz` inputs. qvis
  itself was "only tested and maintained for the latest stable versions of Google Chrome".
- **License:** MIT, keeping "Copyright (c) 2019 Hasselt University - EDM" plus the new copyright line (§8.10).

The bug-report template's last paragraph (the email address and "only tested ... Google Chrome") must be updated
accordingly. The filename stays `bug-report-in-live-version.md`, because the MainMenu deep link uses it.

## Addendum: same-data parity pass (2026-11-01)

Hosted qvis (draft-02 conversions from `tests/fixtures/legacy/`) and qvis-react (latest-draft originals) were compared
at 1600 x 1000 with the same selections: computed styles, element boxes, pixel diffs, DOM, toast timelines (sampled
every animation frame) and the response to every shell interaction. Scripts and screenshots are in the session
scratchpad (`work/parity/shell/`). Where this addendum contradicts the body, it wins.

### A7. Fixed (now identical to hosted qvis)

| Area | qvis (Bootstrap 4.3.1, vue-notification 1.3.16) | Was | Now |
|---|---|---|---|
| Button focus | `.btn:focus` box-shadow `0 0 0 .2rem rgba(<variant>, .5)`: the ring stays around a button after a mouse click and while pressed; focus keeps the normal colours | Bootstrap 5: ring only on `:focus-visible`, with the hover colours | `global.css` `.btn:focus` ring + `:focus-visible:not(:hover):not(:active)` normal colours (all views; the local copies in the congestion, multiplexing and packetization CSS were removed at integration) |
| Menu tab keyboard focus | browser outline (`auto 1px`), no box-shadow | Bootstrap 5 `.nav-link:focus-visible` box-shadow ring | `global.css` `.nav-link:focus-visible { outline: revert; box-shadow: none }` |
| Menu tab box model | `.nav-tabs .nav-item { margin-bottom: -1px }` (items 41 px), active tab's 0-px bottom border in the tab colour, hovered tab's in currentColor | margin on the link (items 40 px); pinned hover/active rules out-ranked qvis's id rules (bottom colour `#fff` / `#dee2e6`) | `MainMenu.css`: item margin, link margin 0, pinned rules removed (Bootstrap 5 defaults equal 4.3.1) |
| Toast fade-in | inline `transition: all 300ms` (vue-notification `speed`) | 0.5 s keyframes | 300 ms (inline style, `vn-fade-enter` class for the first frames) |
| Toast stacking | shown items slide up over 0.5 s when a new one arrives (`<transition-group>` FLIP move, `.vn-fade-move`) | jump | FLIP slide with the Web Animations API, 0.5 s ease |
| Toast fade-out | 300 ms; 500 ms for an item that moved (Vue clears the moved item's inline `transition-duration`, so `.vn-fade-leave-active { transition: all .5s }` applies); removed after the fade, the rest then jumps | always 500 ms | same rule; measured removal within ~10 ms of qvis |
| Toast DOM | `div.notifications > span > div.notification-wrapper[data-id] > div.vue-notification-template.vue-notification.<type>`; click handler on the inner div | own class names only; click on the wrapper (also on its 5 px margin) | qvis class names added (`vue-notification-group`, `vue-notification-wrapper` kept for tests), `data-id`, click on the inner div |
| `#/debug` rows | `connection.parseEvent(event).name` = the type after the first colon (`packet_sent`) | full name (`quic:packet_sent`), against §9.4 | `ev.type`; random files built as §9.7 (`testcat:` names, `data.trigger`, `event_schemas` so the loader logs no diagnostics); "Change Event Name" sets `testcat:Event was changed` |

The reduced-motion override of the toast animations was dropped with the keyframes: vue-notification has none.

### A8. Differences that remain (decided)

| Difference | Verdict |
|---|---|
| "Request feature" / "Report issue" link to `mjoras/qvis-react` | intended (§2.4 button targets, repository chrome) |
| Menu hrefs carry the query (`#/sequence?file=...`) | intended, Q3 |
| `#/Files` lights "Manage files" (qvis: no active tab) | intended, Q1 |
| Unknown route redirects to `#/files` (qvis: blank page without menu, the file still loads) | intended, Q4 |
| Malformed `%` escape in the hash query: hosted qvis does **not** crash, it drops the whole query (no load, no toast); qvis-react keeps the raw value, tries to load it and shows N10 + N12 | intended, Q25 (the body's "crashes app start" describes the source, not the hosted build) |
| `favicon.ico` served (qvis: 404) | intended, Q22 |
| After removing a file the selectors auto-select the next file (qvis: blank selection); after removing all, "Please load a trace file to visualize it" (qvis: empty selects and "Loading files..." forever) | intended, Q11 / Q14 |
| A client+server file never gets the sequence diagram's GENERATED mirror, so selectors and the "(N connections)" count do not grow after a sequence visit | intended, sequence SQ1 and file-loading Q14 |
| Mode B (more than 30 options): numeric input and "−" laid out like mode C | intended, Q9 |
| Multiplexing shows "Load all connections at once" on `localhost` (hosted qvis is not localhost) | intended, Q20 (same rule) |
| `#/debug` has the "Convert with extended mappings" checkbox, which moves the list 26 px down | intended, converters C2 |
| `quant` / `aioquic` help links carry `rel="noreferrer"` (qvis: none) | intended (security hygiene for `target="_blank"`, not visible) |
| A disabled button's computed cursor is `pointer` (qvis: `default`) | not visible: Bootstrap 5 disables pointer events on it, so the cursor of the element below (the arrow) shows, as in qvis |
| Pixel diff of the empty `#/files` page | only the intended Option 1 sentence (D1/D6) and Option 4 label (D13), plus sub-pixel anti-aliasing of a few glyphs |
| Configurator (congestion, multiplexing, packetization, stats; modes A, B, C) | pixel-identical with the same data and selection |
| Every view with nothing loaded, and while a `?file=` load is outstanding ("Loading files...") | pixel-identical (multiplexing: Q20 button only) |

### A9. Final integration (2026-11-01)

| Area | qvis | Was | Now |
|---|---|---|---|
| Address bar after a `?file=` load or a hash edit | vue-router's `ensureURL` rewrites the hash to the route's `fullPath`, i.e. the query re-encoded (`#/sequence?file=https%3A%2F%2F...`) | the raw query stayed in the address bar | `syncFromLocation` rewrites the hash with `replaceState` to the typed path plus the re-encoded raw query (repeated and bare keys kept). Only the address bar changes. A malformed escape (Q25) is written back encoded (`%25`), so a reload still loads the same raw value |
| Hover tooltips "Time multiplier:" and "Latency offset :" | BootstrapVue `v-b-tooltip.hover`: 50 ms show/hide delay, Bootstrap 4 geometry, font stack and z-index 1070, Popper 1 flip | react-bootstrap `OverlayTrigger` (hover+focus): 0.6 px lower, Bootstrap 5 font stack, z-index 1080, no delay | shared `useHoverTooltip` (`components/shared/HoverTooltip.tsx`, CSS `.qvis-tooltip`), also used by the congestion buttons. Box, inner box, arrow, computed style and show delay measured identical to hosted qvis for all three kinds |
| "Latency offset :" label | one text node (`{{numericalInputName}} : `) | two text nodes | one text node (glyph positions as in Vue) |
| Option 4 help text | "representing a 100MB download" (its mvfst demo) | verbatim, while the generated massive demo is a 50 MB download | the size comes from the massive manifest's title or description like the button label (D13); "100MB" when neither names one |
