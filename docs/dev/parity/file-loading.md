# Parity spec: file loading (File Manager page, loaders, URL parameters, qvis-server)

This document replaces reading the qvis source for this subsystem. Source paths are relative to
`qvis/visualizations/` unless prefixed by `qvis-server/` or `pcap2qlog/`. Line numbers refer to the
reference checkout (qvis `3db6acf`, qvis-server `5165c42`, pcap2qlog `2f19fa6`).

Locked qvis dependency versions (from `package-lock.json`) that define the reference behaviour:
bootstrap 4.3.1, bootstrap-vue 2.0.4, vue-notification 1.3.16, vue-router 3.1.3 (hash mode),
axios 0.18.1, oboe 2.1.5.

Primary sources read in full:

- `src/components/filemanager/FileManagerContainer.vue` (596 lines)
- `src/components/filemanager/data/FileLoader.ts` (313)
- `src/components/filemanager/utils/StreamingJSONParser.ts` (309)
- `src/components/filemanager/newlineconverter/newlinejsontoqlog.ts` (237), `textsequencejsontoqlog.ts` (238)
- `src/store/ConnectionStore.ts` (433)
- `src/App.vue`, `src/router.ts`, `src/main.ts`, `src/views/FileManager.vue`, `src/views/MainMenu.vue`
- `src/data/ConnectionGroup.ts`, `src/data/QlogSchemaConverter.ts`, parts of `src/data/QlogLoader.ts`, `src/data/QlogLoaderV2.ts`, `src/data/Connection.ts`
- `src/components/filemanager/netlogconverter/netlogtoqlog.ts` (894), `netlog.ts` (195); `pcapconverter/tcptoqlog.ts` (envelope and event names), `qlog_tcp_tls_h2.ts`; `src/data/QlogSchemaConverter.ts` (164, full); `src/data/QlogLoader.ts:266-500` (draft-00/01 upgrades)
- the five bundled demo files in `public/standalone_data/draft-00|01/` (envelopes, event names, frame types and counts inventoried for 9.8.4)
- `qvis-server/` (all source + docker/startup scripts)
- `pcap2qlog/src/main.ts`, `flow/*.ts`, `util/*.ts`, head of `parsers/ParserPCAP.ts`
- qlog drafts: main-schema-14 sections 3-5, 7, 11, 13 and changelog; quic-events-13 / h3-events-13 section 2.
- qlog digests in `docs/dev/qlog-spec/` (`main-schema.md` in full, `ecosystem.md` in full, `quic-events.md`
  sections 0-2, 3-8 as needed, 13 and 15, `h3-events.md` sections 2 and 10) for section 9.

Labels used throughout:

- **PARITY**: reproduce exactly (visible text, layout, behaviour).
- **FIX**: qvis bug or hazard; the React version deliberately deviates. The qvis behaviour is still described.
- **NEW**: required because qvis-react only accepts the latest qlog drafts (main-schema-14, quic-events-13, h3-events-13).
- **DECISION**: needs a product decision; a recommended default is given.

---

## 1. Overview and user-facing purpose

The File Manager is the landing page of qvis (`#/` redirects to `#/files`). It is where all trace data
enters the app. Every visualization (sequence, congestion, multiplexing, packetization, stats) only reads
from the global list of loaded "groups" (one group = one loaded file, which may contain several traces
or "connections").

Five ways to get data in, all presented as numbered "Options" on one page, plus a list of loaded files:

1. **Option 1: Load a file by URL.** Type a URL, press Fetch. qvis tries to download it directly from the
   browser (needs CORS on the remote host) and, if that fails, asks the qvis backend (`/loadfiles`) to
   proxy or convert it. `.pcap` needs a second `.keys` URL. A `.json` URL is treated as a "list" file
   (pcap2qlog list format) that bundles several captures.
2. **Option 2: Upload a file.** File picker or drag-and-drop on the picker, multiple files allowed,
   processed fully client-side ("No data is transfered to the server.").
3. **Option 3: Load premade demo files.** Five bundled example qlogs, fetched from the app's own static
   `standalone_data/` folder.
4. **Option 4: Load a massive demo file.** One 31 MB qlog to stress-test performance.
5. **Option 5: URL parameters.** Documentation only (no controls): `?file=`, `?list=`, `?file1=&file2=`,
   `&secrets=`. These are read once when the app starts, on any route.

Below the options, once at least one file is loaded: **List of loaded files**, one row per group with a
name or link, a one-line summary ("title : description (N connections)"), and **Remove** and
**Download** buttons. Download exports qvis's internal representation as a pretty-printed `.qlog` JSON.

All feedback is given through toast notifications ("vue-notification", bottom center, 50% width). There
is no progress bar. A global `outstandingRequestCount` counter is maintained only so that the
visualization pages can suppress their "Please load a trace file to visualize it" alert while a load is
running.

Supported input formats in qvis and the planned qvis-react status:

| Input | qvis handling | qvis-react |
|---|---|---|
| `.qlog` JSON (QlogFile, "contained") | `FileLoader`: sniff header, then `JSON.parse` with oboe fallback | **NEW**: latest draft only (`file_schema: urn:ietf:params:qlog:file:contained`, `serialization_format: application/qlog+json`) |
| `.sqlog` JSON-SEQ (RFC 7464, QlogFileSeq, "sequential") | streaming RS-split parser | **NEW**: latest draft only (`urn:ietf:params:qlog:file:sequential`, `application/qlog+json-seq`) |
| `.qlognd` NDJSON (draft-02/03 era) | streaming newline-split parser | legacy; recommended: give a clear "legacy format" error (section 8.9 D3) |
| `.json` (qlog, Chrome netlog, or tshark JSON) | content sniff | qlog: as `.qlog`. netlog / tshark: DECISION D4/D5 |
| `.netlog` (Chrome net-export) | `NetlogToQlog` converter (emits draft-01) | converter must be ported to emit latest-draft qlog (separate converter spec) |
| `.pcap.json` / tshark JSON (TCP+TLS+HTTP/2) | `TCPToQlog` converter (emits draft-02-wip) | DECISION D5 |
| `.pcap` + `.keys`, `.pcapng` (URL only) | qvis-server, then pcap2qlog, then tshark (emits draft-02-wip) | DECISION D1 (not possible on Vercel as-is) |
| `.qlog.gz/.gzip/.zip/.br/.brotli` (URL only) | backend sets `Content-Encoding` so the browser decompresses | client-side `DecompressionStream` (section 8.6) |

---

## 2. UI inventory

### 2.1 Route and shell

- Route `#/files` (name `FileManager`), rendered below the global `MainMenu` (tabs). The `/` route
  redirects to `/files` (`src/router.ts:16-19`). Hash routing (vue-router default mode), so the
  canonical URL is `https://host/#/files`.
- `MainMenu` tab label for this page: **"Manage files"** (`src/views/MainMenu.vue:26-28`). Active when
  `fullPath` contains `/files` or is `''`. The active tab is styled bold black on `#fff`. Specified fully
  in the app-shell spec; listed here only because "Use the menu above to switch views." in notifications
  refers to it.
- The page component is `views/FileManager.vue`, which only renders `<FileManagerContainer/>`.
- Global notifications container lives in `App.vue:5`:
  `<notifications group="default" position="bottom center" width="50%" />` (section 2.10).

### 2.2 Page header (PARITY, verbatim)

Wrapper `div.home`: `width: 100%; text-align: center; margin-top: 20px;` (`FileManagerContainer.vue:176-180`).

```
<h1>Welcome to qvis v0.1, the QUIC and HTTP/3 visualization toolsuite!</h1>
<p>To be able to visualize something, you need to load some data. We have several options for that:</p>
```

Both are centered (inherit `.home` text-align). Global font: `'Avenir', Helvetica, Arial, sans-serif`,
color `#2c3e50` (`App.vue:16-22`). Bootstrap 4 typography (`h1` 2.5rem, `h3` 1.75rem, weight 500).

### 2.3 Container layout (PARITY)

`<b-container id="FileManagerContainer" class="table-striped" fluid>`, i.e. `div.container-fluid` (the
`table-striped` class has no effect). Scoped CSS (`:182-206`):

```css
#FileManagerContainer { width: 50%; max-width: 1000px; min-width: 500px; }   /* centered via container margin:auto */
.fileOptionContainer { padding: 10px; text-align: left; }
.fileOptionContainer:nth-of-type(odd) { background-color: rgba(0,0,0,.05); }
#loadedGroupsContainer .row:nth-of-type(odd) { background-color: rgba(0,0,0,.05); }
#loadedGroupsContainer .btn { margin-top: 5px; }
```

The container's children are `b-row.fileOptionContainer` divs in this order: Option 1, 2, 3, 4, 5, then
(conditionally) the loaded-files row. Because of `:nth-of-type(odd)`, **Options 1, 3 and 5 are shaded**,
Options 2 and 4 are not, and the loaded-files row (6th) is not shaded.

Every option row has the same two-column shape:

```
<b-row class="fileOptionContainer">
  <b-col cols="1" md="auto"><h3>Option N</h3></b-col>   <!-- col-1 below md, col-md-auto at md and up -->
  <b-col>
    <h3>{title}</h3>
    <div style="margin: 10px 0px;"> ...controls... </div>
    <div><p> ...help text... </p></div>
  </b-col>
</b-row>
```

Below 500px viewport width the page scrolls horizontally (min-width 500px). PARITY.

### 2.4 Option 1: "Load a file by URL" (`:7-35`)

Left column: `<h3>Option 1</h3>`. Right column: `<h3>Load a file by URL</h3>`, then a `<form>` (no
action; see quirk Q1) containing a row with two columns:

- Column 1 (`b-col`):
  - Text input `#urlInput`, `type="text"`, v-model `urlToLoad` (initial `""`), placeholder
    **`https://www.example.com/output.qlog`**. Bootstrap `form-control`.
  - Shown only when `urlIsPcap` (see below):
    - `<p style="margin-top: 10px;">For .pcap files, you also need to specify a .keys file so it can be decrypted.</p>`
    - Text input `#secretsInput`, v-model `secretsToLoad` (initial `""`), placeholder
      **`https://www.example.com/secrets.keys`**.
- Column 2 (`b-col cols="1" md="auto"`): `<b-button variant="primary">Fetch</b-button>` (Bootstrap 4
  primary blue `#007bff`). **Disabled when `urlToLoad === ''`** (exact empty string; whitespace-only
  counts as non-empty). Click: `loadURL()` (section 3.2).

`urlIsPcap` (`:580-582`): `urlToLoad.indexOf(".pcap") >= 0 && urlToLoad.indexOf(".pcapng") < 0`. Updates
live as the user types. Note `x.pcap.json` also counts as pcap.

Help text below (PARITY, verbatim markup; `<a>` without `target` open in the same tab):

```html
<p style="margin-top: 5px;">
    You can load .qlog, .sqlog, .netlog, .pcap (alongside separate .keys) and .pcapng (with embedded keys) files.<br/>
    You can also load a .json file that lists several other files to be fetched (for the format, see <a href="https://github.com/quiclog/pcap2qlog#options">the pcap2qlog documentation</a>. Or try <a href="https://quic-tracker.info.ucl.ac.be/traces/20190820/list/quant.eggert.org:4433?.json">an example</a>).<br/><br/>
    If you're looking for inspiration, <a href="https://quant.eggert.org/" target="_blank">quant</a> has public qlogs, as does <a href="https://quic.aiortc.org/logs" target="_blank">aioquic</a>.<br/>
    <a href="https://quic-tracker.info.ucl.ac.be">QUIC Tracker</a> provides .pcap files for all its tests and has a convenient integration with qvis from its UI. <br/>
    Many of the tests in the <a href="https://interop.seemann.io/">QUIC Interop Runner</a> also include .qlog and .pcap output.
</p>
```

DECISION D1/D6: if the deployment cannot convert pcap, this text over-promises. Recommended minimal
edit only when pcap is unsupported: change sentence 1 to "You can load .qlog and .sqlog files." plus a
sentence noting that pcap conversion is not available in this deployment. Otherwise keep verbatim.

### 2.5 Option 2: "Upload a file" (`:36-84`)

Left: `<h3>Option 2</h3>`. Right: `<h3>Upload a file</h3>`, then a `<form>` with:

- Column 1:
  - `<b-form-file id="fileUpload" multiple v-model="filesToUpload" :state="Boolean(filesToUpload.length > 0)"
    placeholder="Choose files or drop them here..." drop-placeholder="Drop files here..."
    accept=".qlog,.sqlog,.json,.netlog" class="text-nowrap text-truncate">`
    - Renders BootstrapVue 2.0 / Bootstrap 4 "custom-file" markup: `div.custom-file.b-form-file` wrapping a
      hidden `input.custom-file-input[type=file][multiple][accept]` and a `label.custom-file-label` that
      shows the text, with a gray **"Browse"** button drawn on its right edge (CSS `::after` with
      `content: attr(data-browse)`, default text "Browse").
    - Label text: placeholder **"Choose files or drop them here..."** when empty; **"Drop files here..."**
      while a drag is over the control; after selection, the selected file names **joined with ", "**.
      A long list is not ellipsized: it runs on under the "Browse" segment and is clipped (`text-truncate` sits
      on the wrapper; see addendum F7).
    - Validation state (PARITY quirk Q9): `state` is `false` while no files are selected, so the control
      shows the Bootstrap **invalid (red, `#dc3545`) border** on first render. It turns **valid (green,
      `#28a745`)** once one or more files are selected.
    - Drop target is the control itself only. Dropping elsewhere on the page uses browser default
      behaviour (the browser opens the file and navigates away; quirk Q10).
    - A new selection replaces the previous one; it does not append.
  - Dead UI, never rendered because `uploadIsPcap` always returns `false` (`:584-586`):
    - `<p style="margin-top: 10px;">For .pcap files, you also need to upload a .keys file so it can be decrypted. We currently do not yet support decrypted pcaps or pcapng files with embedded keys.</p>`
    - `<b-form-file id="secretsUpload" ... placeholder="Choose a .keys file or drop it here..." drop-placeholder="Drop .keys file here..." accept=".keys">`

    Do not implement these (or keep them behind an always-false flag).
- Column 2: `<b-button variant="primary">Import</b-button>`, **disabled when `filesToUpload.length === 0`**.
  Click: `uploadFile()` (section 3.3).

Help text (PARITY, verbatim, including the "transfered" typo):

```html
<p>
    Upload currently supports .qlog, .sqlog, .json, and <a href="https://www.chromium.org/for-testers/providing-network-details">.netlog</a> files. No data is transfered to the server.<br/>
    Eventually we will also support .pcap, .pcapng and .qtr files.<br/>
    <span style="font-size: 12px;">
        Note: Chrome netlog must be explicitly given the .netlog extension before uploading to qvis.
    </span>
</p>
```

(A commented-out older line, `Upload supports the same formats as Option 1. You can only upload a single
file at a time.`, is not rendered.)

### 2.6 Option 3: "Load some premade demo files" (`:86-101`)

- `<h3>Option 3</h3>` / `<h3>Load some premade demo files</h3>`
- `<b-button variant="primary">Load example .qlog files</b-button>`: `loadExamples()` (section 3.9).
- `<p>This will load a few example files that you can visualize to get an idea of what's possible.<br/></p>`

### 2.7 Option 4: "Load a massive demo file" (`:103-118`)

- `<h3>Option 4</h3>` / `<h3>Load a massive demo file</h3>`
- `<b-button variant="primary">Load 31MB .qlog file</b-button>`: `loadMassiveExample()`.
- `<p>This will load a single qlog file representing a 100MB download. Use this to see how well qvis visualizations perform on larger traces.<br/></p>`

### 2.8 Option 5: "Load a file by URL parameter" (`:120-137`)

No controls; documentation only. Inside `<div style="margin: 10px 0px;"><p>`:

```html
You can pass files you want to load via URL parameters to the qvis page.<br/>
This method supports the same formats as Option 1.<br/><br/>

Format 1: <a href="https://qvis.quictools.info/#?list=x.json">?list=x.json</a><br/>
Format 2: <a href="https://qvis.quictools.info/#?file=x.qlog">?file=x.qlog</a><br/>
Format 3: <a href="https://qvis.quictools.info/#?file=x.pcap&amp;secrets=x.keys">?file=x.pcap&amp;secrets=x.keys</a><br/>
Format 4: <a href="https://qvis.quictools.info/#?file1=x.qlog&amp;file2=y.qlog&amp;file3=z.qlog">?file1=x.qlog&amp;file2=y.qlog&amp;file3=z.qlog</a><br/>
Format 5: <a href="https://qvis.quictools.info/#?file1=x.qlog&amp;secrets1=x.keys&amp;file2=y.qlog&amp;secrets2=y.keys">?file1=x.qlog&amp;secrets1=x.keys&amp;file2=y.qlog&amp;secrets2=y.keys</a><br/>
```

Rendered link texts are `?list=x.json`, `?file=x.qlog`, `?file=x.pcap&secrets=x.keys`,
`?file1=x.qlog&file2=y.qlog&file3=z.qlog`, `?file1=x.qlog&secrets1=x.keys&file2=y.qlog&secrets2=y.keys`.
Links point at the hosted qvis and open in the same tab. DECISION D7: keep the visible text verbatim and
point `href` at the current deployment's own base URL (`${location.origin}${location.pathname}#?…`). The
example files do not exist anyway.

### 2.9 "List of loaded files" (`:139-168`)

Rendered only when `store.groups.length > 0` (`filesLoaded`, `:588-590`).

```
<b-row class="fileOptionContainer" style="padding: 50px 0;">         <!-- inline style overrides padding -->
  <b-col>
    <b-row><b-col cols="1" md="auto"><h3>List of loaded files</h3></b-col></b-row>
    <b-row>
      <b-container id="loadedGroupsContainer">                        <!-- plain .container -->
        <b-row v-for="(group, index) in allGroups" :key="'group_'+index" class="py-1">
          <b-col class="text-left">
            if group.URL !== undefined && group.URL.length > 0:  <a :href="group.URL">{{group.URLshort}}</a>
            else:                                                {{group.filename}}
            <br />
            <span style="font-size: 0.8em">{{group.getShorthand()}}</span>
          </b-col>
          <b-col cols="2" class="text-center"><b-button variant="danger">Remove</b-button></b-col>
          <b-col cols="2" class="text-center"><b-button variant="info">Download</b-button></b-col>
        </b-row>
      </b-container>
    </b-row>
  </b-col>
</b-row>
```

- Order: insertion order of `store.groups`, which is **completion order** of the asynchronous loads (not
  click order). Demo files therefore usually appear smallest first.
- Odd group rows are shaded `rgba(0,0,0,.05)`. Buttons get `margin-top: 5px`. Remove is Bootstrap 4
  danger red `#dc3545`; Download is info teal `#17a2b8`.
- The link (`URLshort` text, `href` = full URL) opens in the same tab and navigates away from qvis,
  losing all loaded state. FIX (recommended): `target="_blank" rel="noopener noreferrer"`, and only render
  `http:`/`https:` hrefs.
- `getShorthand()` (`src/data/ConnectionGroup.ts:37-60`), exact algorithm:

```ts
let output = "";
if (title) output += title;
if (description) output += description.length <= 50 ? " : " + description
                                                     : " : " + description.substr(0, 50) + "...";
output += connections.length !== 1 ? " (" + connections.length + " connections)" : " (1 connection)";
```

  Examples: no title or description gives `" (1 connection)"` (leading space). Description only gives
  `" : desc (2 connections)"`. The quic-trace demo gives
  `Converted from example_github.qtr : Converted from example_github.qtr by the quictrace... (1 connection)`.
  The count is `group.getConnections().length`. That includes group_id-split sub-traces, "ERROR"
  pseudo-connections created for TraceErrors, and the auto-generated mirror trace the sequence diagram
  adds to a single-trace group (quirk Q14). The count can therefore change after visiting the sequence
  diagram.

### 2.10 Notifications (vue-notification 1.3.x), shared app-wide (PARITY)

- One group `"default"`, fixed at **bottom center**, width **50%** (left edge at 25%), `z-index: 5000`.
- New toasts are appended at the bottom of the stack. Default `duration` is **3000 ms**. Calls that pass
  `duration: 6000` stay 6 s. Click to close. Enter/leave is a CSS fade (`.vn-fade`, about 300-500 ms).
- Markup: `div.vue-notification.{type}` > `div.notification-title` (font-weight 600) + `div.notification-content`.
  Both are rendered as raw HTML (`v-html`). Messages use `<br/>` for line breaks. This is an **XSS hole**
  (FIX, section 7 Q2).
- Default CSS (vue-notification) plus the App override (`App.vue:24-26`):

| type | background | border-left (5px solid) | text color |
|---|---|---|---|
| (none) / info | `#44A4FC` | `#187FE7` | white |
| `success` | `#68CD86` | `#42A85F` | white |
| `warn` | `#ffb648` | `#f48a06` | **black** (App override) |
| `error` | `#E54D42` | `#B82E24` | **black** (App override) |

  Common box style: `display:block; box-sizing:border-box; text-align:left; font-size:12px; padding:10px; margin:0 5px 5px;`.

### 2.11 Styling summary (PARITY)

| Element | Style |
|---|---|
| `.home` | width 100%, centered text, margin-top 20px |
| `#FileManagerContainer` | width 50%, max 1000px, min 500px, centered |
| option rows | padding 10px, left-aligned, odd rows `rgba(0,0,0,.05)` |
| controls block | `margin: 10px 0px` |
| Option 1 help `<p>` | `margin-top: 5px` |
| pcap hint `<p>` | `margin-top: 10px` |
| loaded list row | `padding: 50px 0` |
| loaded list sub-rows | `py-1`, odd shaded, buttons `margin-top: 5px` |
| buttons | Bootstrap 4 `btn btn-primary` / `btn-danger` / `btn-info`, default size |

Bootstrap version note: qvis uses Bootstrap 4.x CSS (via bootstrap-vue 2). qvis-react uses Bootstrap 5.3 /
react-bootstrap 2. BS5 dropped `.custom-file`. To match the BS4 look (label + "Browse" button +
placeholder text + red/green state) build a small custom file control (section 8.5) rather than BS5's
native `input.form-control[type=file]`.

---

## 3. Algorithms and data flow

### 3.1 Entry points

```
App start (App.vue mounted) ──► if route.query non-empty ─► store.loadFilesFromServer(route.query)      (3.8)
Option 1 Fetch ──► loadURL() ──► store.loadFilesFromServer({file|list, secrets?})                       (3.2, 3.8)
Option 2 Import ─► uploadFile() ─► per file: FileLoader.Load(File) ─► store.addGroupFromQlogFile        (3.3, 3.4, 3.10)
Option 3 ────────► loadExamples() ─► store.loadExamplesForDemo() ─► 5 × loadQlogDirectlyFromURL         (3.9)
Option 4 ────────► loadMassiveExample() ─► loadQlogDirectlyFromURL(mvfst_large)                          (3.9)
Remove ──────────► store.removeGroup(group)                                                              (3.11)
Download ────────► QlogSchemaConverter.Convert01to02(group) ─► Blob ─► <a download>                      (3.11)

loadFilesFromServer: direct fetch(url) ─► FileLoader.Load(text,url) ┐
                     │ (fails / non-OK / not a qlog-ish URL)        ├─► addGroupFromQlogFile ─► QlogLoader.fromJSON ─► store.addGroup
                     └─► axios GET /loadfiles?{query} (qvis-server) ┘
```

`QlogLoader.fromJSON` (JSON to `QlogConnectionGroup`) belongs to the data-model subsystem. This spec
covers only the contract described in 3.10.

### 3.2 Option 1: `loadURL()` (`FileManagerContainer.vue:235-262`)

```ts
if (urlIsPcap && secretsToLoad === "") {
  notify({title:"Provide .keys file", type:"error", duration:6000,
          text:"You're linking to a .pcap without also providing a .keys file. This is currently not supported."});
  return;
}
const params: any = {};
if (urlToLoad.endsWith(".json")) params.list = urlToLoad; else params.file = urlToLoad;
if (secretsToLoad !== "") params.secrets = secretsToLoad;   // even if the secrets input is now hidden (Q4)
store.loadFilesFromServer(params);                          // not awaited
```

- The inputs are not cleared after Fetch. There is no trimming.
- A `.json` URL is always sent as `list`. A plain JSON qlog URL ending in `.json` still works, because
  the direct fetch in 3.8 sniffs the content and loads it as qlog.
- `.json` with a query string after it (`x.json?raw=1`) does not end with `.json`, so it becomes
  `file=`. The QUIC Tracker `…?.json` trick does end with `.json`.

### 3.3 Option 2: `uploadFile()` (`:264-457`; lines 302-433 and 460-479 are commented-out dead code)

```ts
if (uploadIsPcap && secretsToUpload === null) { /* dead: uploadIsPcap is always false */ }

// 1. Validate ALL files first; abort everything on the first bad one
for (const file of filesToUpload) {
  if (file === null || (!name.endsWith(".qlog") && !name.endsWith(".sqlog") && !name.endsWith(".json"))
                       && !name.endsWith(".netlog") && !name.endsWith(".qlognd")) {
    notify({title:"Provide .qlog/.sqlog file", type:"error", duration:6000,
            text:"We currently only support uploading .qlog/.sqlog files. " + file.name});
    return;                         // nothing is loaded, even the valid files
  }
}
// (operator precedence makes this equivalent to "none of the 5 suffixes match"; case-sensitive)

// 2. Load all files concurrently (no await in the loop)
for (const file of filesToUpload) {
  notify({title:"Loading uploaded file",
          text:"Loading uploaded file " + file.name + ".<br/>The file is not sent to a server."});
  FileLoader.Load(file, file.name)
    .then(result => {
      store.addGroupFromQlogFile({fileContentsJSON: result.qlogJSON, fileInfo: {filename: file.name}}); // not awaited
      notify({title:"Uploaded file", type:"success",
              text:"The uploaded file is now available for visualization " + file.name + ".<br/>Use the menu above to switch views."});
    })
    .catch(reason => {
      console.error("FileManagerContainer:uploadFile : ", reason);
      notify({title:"Error uploading file", type:"error", duration:6000,
              text:"Something went wrong. " + file.name + ". For more information, view the devtools console."});
    });
}
```

- The allowed suffixes in validation (`.qlog .sqlog .json .netlog .qlognd`) differ from the picker's
  `accept` (`.qlog,.sqlog,.json,.netlog`). `.qlognd` can only arrive via drop or the "All files" picker
  option. Compressed suffixes (`.qlog.gz`) and `.qlogseq` are rejected here, although FileLoader knows them.
- The upload path does **not** touch `outstandingRequestCount`.
- The success toast fires even when `addGroupFromQlogFile` later fails to parse. The user then sees both
  "Uploaded file" (success) and "ERROR parsing qlog file …" (Q6).
- The file input is not reset. Pressing Import again re-imports the same files as duplicate groups. No
  de-duplication by name.
- `group.filename` = exact `File.name`. No `URL`, so the list shows the filename.

### 3.4 `FileLoader.Load(rawContents: File | string, name: string): Promise<FileResult>` (`data/FileLoader.ts:33-159`)

`FileResult = { qlogJSON: any | undefined, error: any | undefined }`. `error` is never set; all failures
are **thrown** (async rejection).

Stage 1: type from extension (`GuesstimateFileTypeFromExtension`, `:161-209`). Ordered allowlist,
first `name.endsWith(ext)` wins (case-sensitive):

| suffix | type |
|---|---|
| `.qlognd` | `qlog_newline` |
| `.qlogseq` | `qlog_textsequence` |
| `.sqlog` | `qlog_textsequence` |
| `.pcap.json` | `pcap_json` (listed before `.json` on purpose) |
| `.netlog`, `.netlog.br`, `.netlog.brotli`, `.netlog.gz`, `.netlog.gzip`, `.netlog.zip` | `netlog` |
| `.qlog`, `.qlog.br`, `.qlog.brotli`, `.qlog.gz`, `.qlog.gzip`, `.qlog.zip` | `unclear` |
| `.json`, `.json.br`, `.json.brotli`, `.json.gz`, `.json.gzip`, `.json.zip` | `unclear` |
| anything else | `unsupported`: `throw Error("File extension unsupported: " + name)` |

Compressed suffixes assume the bytes were already decompressed by the browser (`Content-Encoding`). No
decompression happens in FileLoader.

Stage 2: type from header, only when `unclear` (`GuesstimateFileTypeFromHeader`, `:211-248`). Head =
first 1024 chars (`string.substring(0,1024)`) or the first 1024 **bytes** of a `File` read as text via
`FileReader.readAsText(file.slice(0,1024))`. A UTF-8 character cut at the boundary becomes U+FFFD, which
is harmless. Plain `indexOf` checks, in this order:

```ts
if (head has "qlog_version") {
  if (head has "qlog_format") {
    if (head has "NDJSON")   return qlog_newline;
    else if (head has "JSON-SEQ") return qlog_textsequence;
    else if (head has "JSON")     return qlog_normal;
    // else: fall through to `return unsupported` below (e.g. qlog_format "CBOR")
  } else return qlog_normal;                                   // default qlog_format is JSON
}
else if (head has "activeFieldTrialGroups") return netlog;     // Chrome netlog, even as .json
else if (head has "_source" && head has "layers") return pcap_json;   // tshark -T json
else if (head has "traces" || "event_fields" || "vantage_point" || "common_fields") return qlog_normal; // old qlogs
return unsupported;
```

On `unsupported`: `throw Error("File format unsupported (for qlogs, make sure qlog_version and qlog_format are at the top of the file): " + name + " : " + firstFewCharacters)`.

Then `console.log("FileLoader:Load : we guess filetype for ", name, "is", FileType[type])`.

Stage 3: obtain contents (`:92-114`).

| input | type NDJSON / JSON-SEQ | other types |
|---|---|---|
| `File` | `new Response(file).body` (ReadableStream, true streaming) | `FileReader.readAsText(file)`, full string |
| `string` | `new Response(new Blob([str])).body` | the string itself |

FileReader errors reject with `"File loading aborted: " + file.name + " : " + JSON.stringify(evt)` or
`"File loading error: " + file.name + " : " + JSON.stringify(evt)`.

Stage 4: parse dispatch (`:116-156`).

| type | parser |
|---|---|
| `qlog_normal` | `StreamingJSONParser.parseQlogText(text)` (3.5) |
| `pcap_json` | `StreamingJSONParser.parseJSONWithDeduplication(text)` (3.6), then `TCPToQLOG.convert(json)` |
| `netlog` | `JSON.parse(text)`, then `NetlogToQLOG.convert(json)` |
| `qlog_newline` | `await NewlineJSONToQlog.convert(stream)` (3.7). Non-stream: `throw Error("Could not load NDJSON file from stream : " + name)` |
| `qlog_textsequence` | `await TextSequenceJSONToQlog.convert(stream)` (3.7). `undefined` result: `throw Error("Could not load json-seq file from stream : " + name)` |

Returns `{ qlogJSON: contentsJSON, error: undefined }`. FileLoader does **not** validate that the
result is a usable qlog. That happens in `addGroupFromQlogFile`/`QlogLoader`.

Memory and performance notes: for JSON, the whole file is read into one string and then `JSON.parse`d.
That means two full copies in memory, on the main thread (the UI freezes during parse). Only
NDJSON/JSON-SEQ stream.

### 3.5 `StreamingJSONParser.parseQlogText(text, streamOnlyAsFallback = true)` (`utils/StreamingJSONParser.ts:12-131`)

Purpose: load qlog JSON files that are **not valid JSON**, typically truncated logs whose closing
`]}]}` was never written, or files with garbage after the root.

1. `try { return JSON.parse(text) }`. On error,
   `console.error("StreamingJSONParser:parse : JSON.parse returned an error, trying again with oboe.js fallback parser! Error was: : ", e)`
   and re-enter with `streamOnlyAsFallback=false`.
2. Fallback with oboe.js 2.1.x (incremental SAX-like JSON parser):

```ts
let finalOutput, cleanExit = false, initialRoot;
const s = oboe()
  .on('node:*', (node) => { if (!initialRoot) initialRoot = s.root(); return node; })   // identity
  .done(out => { finalOutput = out; cleanExit = true; })
  .fail(() => {
    console.error("StreamingJSONParser: There were errors in your qlog/JSON file. It was parsed with the fallback parser up until the point of the error.", errorReport, s.root());
    const cur = s.root();
    const len = r => r?.traces?.[0]?.events?.length ?? 0;   // only traces[0] is compared
    finalOutput = len(cur) >= len(initialRoot) ? cur : initialRoot;
  });
s.emit('data', text);            // synchronous
if (cleanExit) return finalOutput;
if (!finalOutput) finalOutput = s.root();     // truncated input: neither done nor fail fires
// event_fields-era repair: drop incomplete trailing array events
for (const trace of finalOutput.traces ?? []) if (trace.event_fields && trace.events)
  for (let i = trace.events.length - 1; i >= 0; --i)
    if (trace.events[i].length !== trace.event_fields.length) {
      const removed = trace.events.pop();          // BUG Q12: pops the LAST, not events[i]
      console.error("StreamingJSONParser: incomplete event found, ignored in output.", removed);
    }
return finalOutput;
```

Behaviour by input:

- Valid JSON: `JSON.parse` result.
- Truncated JSON (unclosed): the partial root, with every complete value so far. The last event object may
  be **partially filled**: oboe adds members as they complete, so `{time, name}` can appear without `data`,
  or `data` can be cut off mid-object. Object-style (draft-02+) events are **not** repaired because the
  repair loop only runs for `event_fields` traces.
- Syntax error mid-file: the root parsed up to the error (the `fail` path).
- Garbage after a complete root: `done` already fired, then `fail` fires and overwrites `finalOutput` with
  whichever of current/initial root has more `traces[0].events`. In practice both are the first root.

**NEW (qvis-react):** keep this two-stage behaviour, but apply the repair to object events. The event
object that the truncation cut is dropped entirely, even if its `time`, `name` and a partial `data` were
already written (log once per trace with the count). Syntactically complete events are never dropped here,
even when they lack `time`, `name` or `data`: the data model keeps and flags them (main-schema digest P8).
The precise cut rule is in section 9.5. Implementation options (section 8.6):
keep `oboe` (npm `oboe@2.1.5`/`2.1.7`, MIT, works in browsers), or a custom "close the open brackets"
repair:
(a) on "unexpected non-whitespace after JSON at position N", parse `text.slice(0,N)`;
(b) on unexpected end, or a syntax error at position N, scan `text.slice(0,N)` with a bracket/string
state machine, cut back to the end of the last complete array element or object member, append the
closing brackets of the open containers in reverse order, then `JSON.parse`.
Both must pass the test vectors in section 8.8.

### 3.6 `parseJSONWithDeduplication(text)` (`:135-308`, tshark JSON only)

tshark `-T json` output contains **duplicate keys** in the same object (e.g. several `"tls.record"` or
`"http2.stream"` keys). `JSON.parse` keeps only the last one, and tshark's `--no-duplicate-keys` is buggy.
This oboe-driven builder rebuilds the document so that a key seen a second time in the same object becomes
an array `[first, second]`, and later repeats are pushed onto that array. Real JSON arrays are preserved.
It returns `context.JSONroot` (root is `[]` if the first path element is index 0, else `{}`). It is only
used for `pcap_json` (TCPToQlog) and in `loadQlogDirectlyFromURL` for tshark JSON demos (all commented
out). Port only if DECISION D5 keeps the TCP converter. Required semantics: duplicate keys turn into an
ordered array of all values, nested at the right depth. A simple custom JSON tokenizer that builds objects
with that rule is preferable to porting the oboe path arithmetic.

### 3.7 Streaming NDJSON and JSON-SEQ converters (`newlineconverter/*.ts`)

Both are copies of `can-ndjson-stream` (MIT; keep the copyright notice if code is ported verbatim). They
are modified to **batch** all records parsed from one chunk into one array per `enqueue` (performance).

Record transformer (`createNewlineTransformer` / `createRecordTransformer`, `:131-236`):

```ts
new ReadableStream({
  start(controller) {
    const reader = input.getReader(); const decoder = new TextDecoder(); let buf = "";
    reader.read().then(function processResult(result) {
      if (result.done) {
        if (cancellationRequest) return;
        buf = buf.trim();
        if (buf.length !== 0) { ++count; try { controller.enqueue([JSON.parse(buf)]); }
                                catch { console.error(<"line #"/"record #"> + count + " was invalid JSON. Skipping and continuing.", buf); } }
        controller.close(); return;
      }
      buf += decoder.decode(result.value, {stream: true});      // UTF-8 safe across chunk boundaries
      const parts = buf.split(SEP);                              // NDJSON: "\n"   JSON-SEQ: "\u001E" (RS)
      const out = [];
      for (let i = 0; i < parts.length - 1; ++i) {
        const p = parts[i].trim();
        if (p.length > 0) { ++count;
          try { out.push(JSON.parse(p)); }
          catch { console.error(...); /* NDJSON: skip and continue */  /* JSON-SEQ: `return;`  <-- BUG Q11 */ }
        }
      }
      buf = parts[parts.length - 1];
      controller.enqueue(out);
      return reader.read().then(processResult);
    });
  },
  cancel(reason) { console.warn(...); cancellationRequest = true; is_reader?.cancel(); },
}, { highWaterMark: 4, size: () => 262144 });   // ineffective; chunks are about 64 KB
```

JSON-SEQ also logs `"TextsequenceJSONToQlog:createRecordTransformer Amount of records", records.length`
once per chunk (noisy; drop).

Collector (`parseNDJSON`/`parseTextSequences`, `:60-98`): reads the stream to the end,
`entries.push(...batch)`, resolves with all entries. There is no reject path: a stalled stream means a
promise that never settles.

Conversion to a "normal" qlog object (`convert`, `:5-58`):

```ts
const qlogFile = { qlog_version: "draft-02", qlog_format: "NDJSON" | "JSON-SEQ", traces: [] };
const entries = await parse(stream);
if (entries.length === 0) { console.error("...no entries found in the loaded file..."); return qlogFile; }  // both: returns empty file
const header = entries.shift();
if (header.qlog_version === undefined || header.qlog_format !== FORMAT || header.trace === undefined) {
  console.error("...File did not start with the proper qlog header...", header);
  return NDJSON ? qlogFile /* empty, traces: [] */ : undefined /* JSON-SEQ: FileLoader throws */;
}
for (const key of Object.keys(header)) if (key !== "trace") qlogFile[key] = header[key];  // copies qlog_version, qlog_format, title, ...
const trace = { vantage_point: { type: "unknown" }, events: [] };
for (const key of Object.keys(header.trace)) trace[key] = header.trace[key];             // header.trace overrides defaults
trace.events = entries;                                                                   // every remaining record is an event
qlogFile.traces = [trace];
return qlogFile;
```

So a sequential file becomes a one-trace contained-style object, and `group.format` later reads
`qlog_format` ("NDJSON"/"JSON-SEQ").

**NEW (qvis-react) JSON-SEQ algorithm** (RFC 7464 and main-schema-14 sections 5 and 11.2):

1. Stream the input (`File.stream()` / `Response.body`) through `TextDecoderStream` (or `TextDecoder` with
   `{stream:true}`), split on `\u001E`, keep the last partial part in the buffer, `trim()` each part, skip
   empty ones. Records may contain newlines internally. RFC 7464 says a record ends with LF, so `trim()`
   is correct.
2. Invalid record: **skip and continue** (FIX for Q11). Count skipped records. A truncated **final**
   record (log cut mid-write) is the expected case and is silently skipped with a console warning.
   Mid-file errors produce one `warn` notification after load (NEW, see section 6).
3. The first record must be the header: `file_schema === "urn:ietf:params:qlog:file:sequential"` and
   `serialization_format` matching `application/qlog+json-seq` (case-insensitive per main-schema section 3),
   plus `trace` (TraceSeq) an object. Lenient mode: accept when only one of the two identifiers is present
   and consistent. Legacy header (`qlog_version` present, no `file_schema`): throw a LegacyQlogError
   (section 6). Header invalid: throw `Error("Could not load json-seq file from stream : " + name)`, which
   keeps the qvis message. Section 9.1 refines this step: `serialization_format` never rejects a file
   (quiche, neqo and quinn write `"JSON-SEQ"`), and a first record that is an event rather than a header
   gets a synthesized header (D17).
4. Output (internal normalized form): `{ file_schema, serialization_format, title?, description?, ...otherHeaderKeys, traces: [ { vantage_point: {type:"unknown"} overridden by header.trace fields (title, description, common_fields, vantage_point, event_schemas, custom), events: records[1..] } ] }`.
   Keep the original `file_schema`/`serialization_format` so `group.format` can show the original format.
5. Zero records: throw "File is empty" (FIX). qvis returned `{qlog_version:"draft-02", traces:[]}`, which
   QlogLoaderV2 accepts, so an empty "(0 connections)" group was added with a success toast.
6. Optional leniency (DECISION D3): if the stream contains no RS at all and the first line parses as a
   valid **latest-draft** sequential header, split on `\n` instead (accepts newline-only writers).

NDJSON (`qlog_format: "NDJSON"`) belongs to draft-02/03 (replaced by JSON-SEQ in
main-schema-01: the changelog entry "Since draft-ietf-quic-qlog-main-schema-00" reads "Changed the
streaming serialization format from NDJSON to JSON Text Sequences (#172)"). Do not implement as a format
(D3).

### 3.8 URL loading: `ConnectionStore.loadFilesFromServer(queryParameters)` (`store/ConnectionStore.ts:116-337`)

Called by `App.mounted` with the full route query (all params, including unrelated ones such as
`focusOnEvent`) and by Option 1 with `{file|list, secrets?}`.

```ts
console.log("ConnectionStore:LoadFilesFromServer ", q);
if (Object.keys(q).length === 0) return;                                   // silent
let urlToLoad = "", fullURL = undefined;
if (q.file)       { urlToLoad = q.file; fullURL = q.file; }
else if (q.list)  { urlToLoad = q.list; }
else if (q.file1) { urlToLoad = q.file1 + " etc."; }   // deliberately breaks the direct fetch below
if (urlToLoad === "") return;                                              // silent (e.g. only ?focusOnPN=3)

notify({title:"Loading file(s) via URL",
        text:"Loading files via URL " + urlToLoad + ".<br/>The backend server downloads the files, possibly transforms them into qlog, then sends them back. This can take a while."});

let apireturns = null, fileContents = null;
// STEP 1: direct download
try {
  outstanding += 1;
  if (urlToLoad has ".qlog" || ".sqlog" || ".netlog" || ".json") {       // substring test anywhere in the URL
    apireturns = await fetch(urlToLoad);                                   // default mode 'cors'
    if (apireturns.ok) {                                                   // 2xx
      const txt = await apireturns.text();
      const r = await FileLoader.Load(txt, urlToLoad);                     // name = full URL (extension test uses endsWith)
      fileContents = r.qlogJSON;                                           // NOTE: outstanding is never decremented here (Q7)
    } else {
      outstanding -= 1;
      console.warn("...tried to load qlog from remote server directly but got probable CORS error. Trying again via backend server.", q, apireturns);
      apireturns = null;
    }
  }                                                                        // NOTE: non-matching URL leaves outstanding +1 (Q7)
} catch (e) {                                                              // network/CORS TypeError, or FileLoader throw
  outstanding -= 1; apireturns = null;
  console.warn("...probable CORS error. Trying again via backend server.", q, e);
}

try {
  // STEP 2: backend (qvis-server)
  if (apireturns === null) {
    let url = '/loadfiles';                                                // same origin as the app
    if (location.toString().includes("localhost:8080")) url = "https://localhost/loadfiles";
    else if (location.toString().includes(":8080"))     url = "https://qvis.quictools.info/loadfiles";
    outstanding += 1;
    apireturns = await axios.get(url, { params: q });                      // ALL query params are forwarded; non-2xx throws
    outstanding -= 1;
    if (apireturns.qlog_version) { /* dead: the axios response object never has it */ }
    else if (!apireturns.error && !apireturns.data.error && (apireturns.data.qlog || apireturns.data)) {
      let root = apireturns.data;                     // axios already JSON.parse'd it if it was valid JSON
      if (apireturns.data.qlog) root = apireturns.data.qlog;                // pcap2qlog wrapper {qlog, debug_list}
      if (root.constants && root.events && urlToLoad.includes(".netlog")) {
        console.log("...identified file as .netlog, transforming to .qlog", urlToLoad, root);
        fileContents = NetlogToQlog.convert(root);
      } else if (typeof root === "object") {
        fileContents = root;                          // proxied JSON qlog, used as-is (no FileLoader)
      } else {
        const r = await FileLoader.Load(root, urlToLoad);   // string: invalid JSON (truncated) or .sqlog
        fileContents = r.qlogJSON;
      }
      if (fileContents.traces && fileContents.traces.length > 0 && fileContents.traces[0].error_description)
        throw Error("Trace had an error: " + JSON.stringify(fileContents));   // only traces[0] checked (Q8)
    }
  }
  // STEP 3: add to store
  if (fileContents !== null && fileContents.qlog_version !== undefined) {
    let short = urlToLoad;
    if (short.length > 50) short = short.substr(0, 25) + "..." + short.substr(short.length - 26, short.length);
    const fileInfo: any = { filename: "Loaded via URL (" + short + ")" };
    if (fullURL) {
      fileInfo.URL = fullURL;
      fileInfo.URLshort = fullURL.length > 50
        ? fullURL.substr(0, 25) + "..." + fullURL.substr(fullURL.lastIndexOf("/"), fullURL.length)  // keeps the "/"
        : fullURL;
    }
    dispatch('addGroupFromQlogFile', { fileContentsJSON: fileContents, fileInfo });   // not awaited
    notify({title:"Loaded files via URL", type:"success",
            text:"The loaded files are now available for visualization " + urlToLoad + ".<br/>Use the menu above to switch views."});
  } else {
    console.error("ConnectionStore:LoadFilesFromServer : ERROR : trace not added to qvis! : ", q, apireturns);
    notify({title:"ERROR loading URL " + urlToLoad, type:"error", duration:6000,
            text:"File(s) could not be loaded from " + urlToLoad + ".<br/>View the devtools JavaScript console for more information."});
  }
} catch (e) {
  outstanding -= 1;                                                        // can double-decrement (Q7)
  console.error("ConnectionStore:LoadFilesFromServer : ERROR : trace not added to qvis! : ", e, q);
  notify(/* identical "ERROR loading URL" toast as above */);
}
```

Shortening examples for
`https://interop.seemann.io/logs/2023-01-01/quic-go_quiche/handshake/client/qlog/abc.qlog` (88 chars):

- filename: `Loaded via URL (https://interop.seemann.i...shake/client/qlog/abc.qlog)` (25 + "..." + last 26)
- URLshort: `https://interop.seemann.i.../abc.qlog`

Routing outcomes in qvis, by parameter shape:

| query | direct fetch? | backend call | result |
|---|---|---|---|
| `file=…/x.qlog` | yes | only on failure: proxy (direct mode) | group with URL link |
| `file=…/x.sqlog` | yes | on failure: server **rejects** (500 "Empty URL passed…", see 3.12) | direct only |
| `file=…/x.json` (qlog) | yes | on failure: server rejects (needs secrets) | direct only |
| `file=…/x.netlog` | yes | proxy, then `NetlogToQlog` | |
| `file=…/x.qlog.gz` (no `Content-Encoding` at origin) | yes, binary garbage fails sniff and throws | proxy with `Content-Encoding: gzip` | works |
| `file=…/x.pcap&secrets=…/x.keys` | no (unless the URL contains `.json`) | pcap2qlog | merged qlog in `{qlog}` |
| `file=…/x.pcapng` | no | pcap2qlog (tshark without keylog) | |
| `list=…/l.json` | yes (fails sniff unless it is a qlog), then backend | pcap2qlog `--list` | merged |
| `file1=a.qlog&file2=b.qlog` | yes on `"a.qlog etc."`, intentionally fails (404 or invalid) | pcap2qlog merges all | one group, **no URL** |
| only unrelated keys | nothing | nothing | silent |

Relative URLs (`?file=standalone_data/draft-01/new_cid.qlog`) work through the direct same-origin fetch.
The backend would reject them ("Malformed URL import…").

### 3.9 Demo loading

`loadExamples()` (`FileManagerContainer.vue:483-505`): if any `group.filename.indexOf("DEMO") === 0`,
show warn toast "Example files already loaded" and return. Otherwise
`store.loadExamplesForDemo()`. `MASSIVE_DEMO_…` does not start with "DEMO", so it does not block. A user
file named `DEMO…` does block. Double-clicking before the first file finishes loads everything twice.

`loadExamplesForDemo()` (`ConnectionStore.ts:340-358`) fires 5 parallel `loadQlogDirectlyFromURL` calls,
in this order (URL relative to the app base, `vue.config.js` `baseUrl: './'`):

| # | url | filename (verbatim, shown in list) | source format | traces |
|---|---|---|---|---|
| 1 | `standalone_data/draft-01/new_cid.qlog` | `DEMO_new_cid.qlog (<1MB)` | draft-01, pcap2qlog, 34 KB | 1 ("Connection 1", network/client, 35 events) |
| 2 | `standalone_data/draft-01/spin_bit.qlog` | `DEMO_spin_bit.qlog (<1MB)` | draft-01, 32 KB | 1 (34 events) |
| 3 | `standalone_data/draft-01/parallel_10_50KB_f5.qlog` | `DEMO_10_parallel_streams.qlog (<1MB)` | draft-01, aioquic client, 758 KB | 1 (1549 events) |
| 4 | `standalone_data/draft-01/doublevantage_100ms.qlog` | `DEMO_double_vantagepoint.qlog (3.1MB)` | draft-01, aioquic client + server, 3.0 MB | 2 (2797 + 3940 events) |
| 5 | `standalone_data/draft-00/quictrace_example_github.qlog` | `DEMO_quictrace_example.qlog (3.7MB)` | draft-00 from quic-trace, 3.7 MB | 1 (18557 events) |

Commented-out demos (do not ship): `5stream_from_chrome`, `10paralllel_aioquic`, `10paralllel_litespeed`,
and the TCP tshark JSONs (`standalone_data/tcp/*.json`). `public/standalone_data/**/*.qlog.js` and
`prespec/*` are leftovers from an old `<script>` loader (`main.ts:11-60`, commented out). Do not port.

`loadMassiveExample()` (`:507-529`): if any `group.filename.indexOf("MASSIVE_DEMO_mvfst_large") >= 0`,
warn toast "Example file already loaded" and return. Otherwise
`loadQlogDirectlyFromURL({url:"standalone_data/draft-00/mvfst_large.qlog", filename:"MASSIVE_DEMO_mvfst_large.qlog (31MB)"})`.
That file is **not in the repo**. The server startup script downloads it at deploy time from
`https://quic.edm.uhasselt.be/files/mvfst_large.qlog` (`qvis-server/system/docker_setup/startup/startup.sh:31-33`).

`loadQlogDirectlyFromURL({url, filename})` (`ConnectionStore.ts:360-432`):

```ts
notify({title:"Loading qlog file directly",
        text:"Loading qlog file \"" + filename + "\" from URL " + url + ". Large files can take a while to load."});
outstanding += 1;
axios.get(url, {responseType:"text", transformResponse: undefined})       // raw text, no auto JSON parse
.then(res => {
  outstanding -= 1;
  let c = StreamingJSONParser.parseQlogText(res.data);                    // NOT FileLoader: no .sqlog support
  if (c && !c.error && !c.error_description && c.qlog_version) {
    dispatch('addGroupFromQlogFile', {fileContentsJSON: c, fileInfo: {filename}});
    notify({title:"Loaded " + filename, type:"success",
            text:"This file is now available for visualization, use the menu above to switch views."});
  } else if (c.length > 0 && c[0]._source) {                              // tshark JSON
    c = StreamingJSONParser.parseJSONWithDeduplication(res.data);
    dispatch('addGroupFromQlogFile', {fileContentsJSON: TCPToQlog.convert(c), fileInfo: {filename}});
    notify(/* same success toast */);
  } else {
    console.error("FileManagerContainer:loadDirectlyFromURL: error downloading file : ", url, res);
    notify({title:"ERROR loading " + filename, type:"error", duration:6000,
            text:"This file could not be loaded from " + url + ".<br/>View the devtools JavaScript console for more information."});
  }
});                                                                       // NO .catch (Q5): 404/network leaves outstanding +1, no toast
```

### 3.10 `addGroupFromQlogFile({fileContentsJSON, fileInfo})` (`ConnectionStore.ts:69-90`)

```ts
const group = QlogLoader.fromJSON(fileContentsJSON);       // undefined if version unknown / no qlog_version
if (group !== undefined) {
  group.filename = fileInfo.filename; group.URL = fileInfo.URL; group.URLshort = fileInfo.URLshort;  // URL may become undefined
  commit("addGroup", group);                                // grouplist.push(group)
} else {
  console.error("ConnectionStore:addGroupFromQlogFile : Qlog file could not be parsed!", fileContentsJSON, fileInfo);
  notify({title:"ERROR parsing qlog file " + fileInfo.filename, type:"error", duration:6000,
          text:"File was successfully loaded but could not be parsed.<br/>Make sure you have a well-formed qlog file.<br/>View the devtools JavaScript console for more information."});
}
```

Relevant parts of the `QlogLoader` contract (data-model spec owns the details):

- `qlog_version` dispatch: `"0.1"`, `"draft-00"`, `"draft-01"`, `"draft-02-wip"`, then aliases
  `["draft-02","draft-02-RC1","qlog-03-WIP","0.3"]` (`QlogSchema02.ts:13`). Anything else, or a missing
  field, returns `undefined` and the toast above.
- `group.version`, `group.format = qlog_format ?? "JSON"`, `group.title = title ?? ""`, `group.description = description ?? ""`.
- Each TraceError (`error_description !== undefined`) creates a connection titled `"ERROR"` with
  description `uri + " : " + error_description` and no events.
- `group_id` splitting creates connections titled `"Group " + id + " : " + trace.title`.
- It may call `alert()` (blocking browser dialogs) for unordered timestamps and draft-02 non-compliance.

**NEW contract for qvis-react:** the loader accepts the normalized `LoadedQlog` from section 3.14,
validates `file_schema`, and rejects legacy `qlog_version` files with a specific message (section 6). The
data-model spec should replace the `alert()` calls with `warn` toasts.

### 3.11 Remove and Download

`removeGroup(group)` (`:531-535`): `console.log("FileManagerContainer:removeGroup : removing group ", group)`,
then `store.removeGroup` and `grouplist.splice(indexOf(group), 1)`. No confirmation dialog. Visualization
configs that still reference the group are not cleaned up here (other subsystems' concern; in React,
derive selections from the store so removed groups disappear).

`downloadGroup(group)` (`:537-578`):

```ts
console.log("FileManagerContainer:downloadGroup : downloading internal qlog representation of group ", group);
const internalQlog = QlogSchemaConverter.Convert01to02(group);
// const DEBUGfilter = false; ... (dead debug filter on packet_sent/received/parameters_set/frame_created/…)
let filename = "" + group.filename;
if (group.URL && group.URL.length > 0) filename = group.URL.substr(group.URL.lastIndexOf("/"));   // includes leading "/" (Q13)
if (filename.length === 0) filename = "trace";
if (!filename.endsWith(".qlog")) filename += ".qlog";
const link = document.createElement('a');
link.href = URL.createObjectURL(new Blob([JSON.stringify(internalQlog, null, 2)], {type:'application/json'}));  // never revoked
link.download = filename;
document.body.appendChild(link); link.click(); document.body.removeChild(link);
```

Filename examples: `DEMO_new_cid.qlog (<1MB)` becomes `DEMO_new_cid.qlog (<1MB).qlog`. `client.sqlog`
becomes `client.sqlog.qlog`. URL `…/abc.qlog` becomes `/abc.qlog`, which browsers sanitize (Chrome
gives `_abc.qlog`). URL `…/x?.json` becomes `x?.json.qlog` after sanitizing.

`Convert01to02(group)` (`data/QlogSchemaConverter.ts:7-120`) output:
`{ qlog_version:"draft-02", qlog_format:"JSON", title, description, summary, traces:[…] }`. Per
connection, **skipping `wasAutoGenerated`** (sequence-diagram mirror traces):
`{ vantage_point, title, description, configuration, common_fields (or {}), events }`. Events are copied
as-is for draft-02-family groups, or converted from `event_fields` arrays for draft-00/01. TraceError
"ERROR" connections are dropped (draft-01) or emitted as empty traces (draft-02). group_id sub-traces are
emitted as **separate traces** with their "Group X : " titles. Non-enumerable `qvis` metadata that
renderers attach to events is not serialized.

**NEW download (qvis-react):** always a latest-draft **contained** JSON file, pretty-printed with 2
spaces, `type: application/json`:

```json
{ "file_schema": "urn:ietf:params:qlog:file:contained",
  "serialization_format": "application/qlog+json",
  "title": "<group.title if non-empty>", "description": "<group.description if non-empty>",
  "traces": [ { "title", "description", "common_fields", "vantage_point", "event_schemas", "events", ...other original trace keys }, ... ] }
```

Rules:

- Omit `summary` and `configuration` (removed in main-schema-06).
- Skip auto-generated traces.
- Emit TraceError pseudo-connections back as `{error_description, uri?, vantage_point?}` (FIX).
- group_id-split traces stay split (PARITY), titles as stored internally.
- `event_schemas`: the original trace's value, otherwise derived from the event namespaces seen, with
  the draft suffix the sibling drafts require (`quic` gives `urn:ietf:params:qlog:events:quic-13`,
  `http3` gives `urn:ietf:params:qlog:events:http3-13`; full rule in 9.6).
- Event objects, names and times: section 9.6 (delta-encoded traces are rewritten; D14, D15, D16).
- Filename rule: PARITY, except use `lastIndexOf("/") + 1`, strip `?query`/`#hash`, and fall back to
  `"trace"` (FIX Q13).
- Revoke the object URL after click (FIX).

### 3.12 qvis-server `/loadfiles` (what the hosted backend does)

Stack: Express 4 on Node 10, Docker image based on a custom Wireshark build (commit `e3d4413`, QUIC
draft-29 support), with pcap2qlog checked out at `/srv/pcap2qlog`. qvis's `dist/` is served as static
files from the same server.

- `index.ts`: HTTPS on 443 (certs `/srv/certs/tls_cert.{key,crt}`), HTTP on 80. `app.ts:19-31`: every
  non-HTTPS request is redirected to `https://host + url`. `bodyParser.json/urlencoded`;
  `express.static(out/public)` first, then the router.
- Route: `GET /loadfiles/` (`routes/MainRoutes.ts:13`), handler `FileFetchController.load`.
- Every response: `Access-Control-Allow-Origin: *`, `Content-Type: application/json` (in proxy mode the
  origin's headers override these).

URL validation (`validateURL`, `FileFetchController.ts:28-71`; the same logic is in pcap2qlog's
`Downloader.ValidateRemoteURL`), in order:

1. `undefined` or `""`: 500 `{"error":"Empty URL passed. If you're setting file=*.pcap, make sure to set secret= as well! "}`
2. `new URL(url)` throws: 500 `{"error":"Malformed URL import. URL must include http(s):// : TypeError : <url>"}`
3. Any char outside `[a-z0-9:/?#|\[\]@!$&'()*+,;=.\-_~%]` (case-insensitive): 500 `{"error":"Invalid URL import. : <url>"}`
4. `%` not followed by a hex digit, or `%` + one hex digit + non-hex/end: same 500 "Invalid URL import".
5. Returns a shell-escaped copy (`/(["\s'$`\\])/g` gets a `\` prefix). The **escaped value is
   discarded**: only truthiness is used, and the raw query value is used afterwards.

Parameter modes (`:88-281`):

- **`list`** (checked first): validate, then pcap2qlog `--list <listURL>` (pcap2qlog downloads it).
- **`file`** (with `file`/`desc`/`secrets`): validate `[file]` if no `secrets` **and** file contains
  `.qlog` / `.pcapng` / `.netlog`. Otherwise validate `[file, secrets]`, so `.sqlog`, `.json`, `.pcap`
  and extensionless URLs **require `secrets`** or fail with "Empty URL passed". Then
  `captures = [{capture:file, secrets, description: desc}]`.
- **`file1..N`** (`secretsN`, `descN`): loop `i=1..` while `fileN` exists. Per entry: no secrets +
  `.qlog` validates the capture only. No secrets + `.pcapng` validates `req.query.file`, which is
  **undefined**, so 500 (server bug). Anything else validates `[capture, secrets]`. Push
  `{capture, secrets, description: descN}`.
- None of these: 400 `{"error":"no valid query parameters set. Please use list, file or filex. See github.com/quiclog/qvis-server for more information."}`.

Direct-proxy shortcut (`:214-246`): if exactly one capture **without secrets** and the capture URL
contains (`indexOf`, first match in this order) one of:

| contains | Content-Encoding set |
|---|---|
| `.qlog` | none |
| `.qlog.br`, `.qlog.brotli` | `br` |
| `.qlog.gz`, `.qlog.gzip`, `.qlog.zip` | `gzip` (a real `.zip` archive would be mis-decoded) |
| `.netlog` | none |
| `.netlog.br`/`.brotli` | `br` |
| `.netlog.gz`/`.gzip`/`.zip` | `gzip` |

Because `.qlog` is checked first and matches `x.qlog.gz` by `indexOf`, the **encoding is never set**
for compressed files. Map iteration order is insertion order, so `.qlog` (undefined) wins. qvis's
comment claims otherwise. Compressed URLs only work when the origin sets `Content-Encoding` itself.

Proxy (`:283-378`): copy the incoming request headers (deep copy), delete `host`, `hostname`,
`sec-fetch-site/mode/dest/user` (and `upgrade-insecure-requests` for http). Issue the same method to
`host + pathname + search` of the target with `follow-redirects` (http or https by URL prefix). On
response: `res.writeHead(origin.statusCode, origin.headers)` and pipe the body. Status and body pass
through unchanged (an origin 404 reaches the client as 404). Errors: 500
`{"error":"Something went wrong fetching the files from the origin server through the qvis CORS proxy : <err>","url":…,"options":…}`
(`… (catch) : …` for a synchronous throw). Client cookies and other headers are **forwarded** to the
origin (privacy issue). `port` is not passed explicitly (that line is commented out). `host` is
`URL.host`, which includes `:port` for non-default ports. Whether Node/follow-redirects resolves a
`host` with an embedded port is unverified, so treat non-default ports as unreliable in qvis.

pcap2qlog mode (`:248-276`, `:379-412`):

1. If a list was built from `file`/`fileN`, write
   `{"description": desc || "Generated " + new Date().toLocaleString(), "paths": captures}`
   (`JSON.stringify(_, null, 4)`) to `/srv/qvis-cache/inputs/<random 22 chars>.json`.
   Write error: 500 `{"error":"Something went wrong writing the list.json file : <e>"}`.
2. `spawn('node', ['/srv/pcap2qlog/out/main.js','--list',<path|url>,'--output','/srv/qvis-cache'])`
   (`util/Pcap2Qlog.ts`). 1-minute timeout gives `"Timeout, pcap2qlog didn't complete within 1 minutes"`.
   The last stdout chunk is the output path. Any stderr gives `"Pcap2Qlog : error : <stderr>"`. A non-zero
   exit gives `"Pcap2Qlog : unknown error, but exit code was not 0! : <code> // <path>"`. Empty path gives
   `"Pcap2Qlog : unknown error, but no qlog file written! : <code>"`.
3. Read the output file, delete the temp list (errors ignored), `JSON.parse`, then 200
   `{ "qlog": <combined qlog>, "debug_list": <list JSON string or list URL> }`.
   Failure: 500 `{"error":"Something went wrong converting the files to qlog : <e>"}`.

### 3.13 pcap2qlog pipeline (what "conversion" means)

`pcap2qlog/src/main.ts` (Node CLI, called per request):

1. Input list: download the list if remote (`wget`), parse `{description, paths:[{capture, secrets?, description?}]}`.
   Top description = `list.description`, or (bug) `input_file`, which is undefined in list mode.
2. Download every capture and secrets in parallel, only if the string contains `http`:
   `wget --timeout=1 --tries=2 --retry-connrefused -O <tmp>/<random><ext> <url>` with a 1-minute timeout
   per file. URL re-validation as in 3.12. The extension comes from `path.extname` or heuristics
   (`.json` / `.pcap` or `…/pcap` / `.keys`, `.secrets` or `…/secrets` / `.qlog`). This is why QUIC
   Tracker URLs use the `pcap?.pcap` / `secrets?.keys` trick.
3. For captures that are not JSON or qlog (no `.pcap` check): run tshark
   `/wireshark/run/tshark --no-duplicate-keys -r <pcap> -T json [-o tls.keylog_file:<keys>] > <tmp>.json`
   (1-minute timeout; `.pcapng` with embedded DSB keys needs no keylog).
4. `.qlog` captures: `JSON.parse` as-is. tshark JSON: `ParserPCAP.Parse` emits **`qlog_version: "draft-02-wip"`
   with `event_fields`** (old schema), one trace per QUIC connection (keyed by ODCID), vantage point
   `network`, and requires the first Initial to carry a ClientHello.
5. Combine: `{qlog_version: <last successful capture's version or "draft-01">, description, traces:[...]}`.
   A capture's traces get `trace.description = capture.description` **only if the trace already had a
   description** (may set it to undefined). Failed captures become TraceErrors
   `{error_description: String(error), uri: original capture URL}` in list order.
6. Write `<output>/cache/<sha1(list contents | input+secrets)>.qlog` (pretty, 4 spaces) and print the
   path. There is no cache read (TODO in source).

Conclusion for qvis-react: the backend has two jobs. (a) A **CORS proxy** for remote text files: trivial
in a Vercel Function. (b) **pcap/pcapng+keys decryption and conversion**: needs a tshark binary with
QUIC/TLS dissectors, emits obsolete qlog, and is not feasible in a standard Vercel Function. See D1.

### 3.14 NEW: qvis-react detection and loading algorithm (latest drafts)

Normalized output of all loaders (internal type; the data-model loader consumes it):

```ts
interface LoadedQlog {
  file_schema: string;                 // "urn:ietf:params:qlog:file:contained" | "…:sequential"
  serialization_format: string;        // "application/qlog+json" | "application/qlog+json-seq" (lower-cased)
  title?: string; description?: string;
  traces: Array<Trace | TraceError>;   // sequential files: exactly 1 trace built from header.trace + records
  [k: string]: unknown;                // other top-level keys preserved (spec allows extension)
}
```

`loadQlogFile(input: File | Blob | string | Uint8Array, name: string): Promise<LoadedQlog>`:

1. **Extension** (allowlist, case-insensitive (FIX), longest suffix first). Test the full name string first
   (qvis behaviour, which handles `…?.json`). For URLs, if nothing matches, test the URL pathname. Accept:
   `.qlog`, `.sqlog`, `.json`, compressed `.{qlog,sqlog,json}.{gz,gzip,br,brotli}`, plus D3/D4/D5-dependent
   `.qlognd` (for a clear legacy error), `.netlog*`, `.pcap.json`. Unknown: throw
   `"File extension unsupported: " + name` (PARITY text). For URL loads only, DECISION D8: allow unknown
   extensions and rely on content sniffing (recommended).
2. **Bytes and decompression**: if the first bytes are `1f 8b`, decompress with
   `new DecompressionStream('gzip')`. If the name ends with `.br`/`.brotli`, use
   `DecompressionStream('brotli')` when supported, else throw "Brotli-compressed files are not supported
   in this browser". `PK\x03\x04` (zip): throw "ZIP archives are not supported" (qvis never really
   supported them).
3. **Sniff** the first 65 536 decoded chars (strip a UTF-8 BOM). main-schema section 3 says the
   identifiers SHOULD be in the first 256 bytes, but member order is not significant and mvfst writes
   hash-ordered keys, so `file_schema` can follow `traces`. The sniff is a hint; the binding
   classification runs on the parsed root object or first record (section 9.1).
   - first non-whitespace char is `\u001E` (RS): **sequential**.
   - `/"serialization_format"\s*:\s*"([^"]*)"/i`: `application/qlog+json-seq` (or the non-media-type
     `JSON-SEQ` that quiche, neqo and quinn write) gives sequential, `application/qlog+json` (or `JSON`)
     gives contained; anything else is **not** an error: fall through (9.1).
   - else `/"file_schema"\s*:\s*"([^"]*)"/`: `urn:ietf:params:qlog:file:sequential` or
     `…:contained`. Any other URI throws `Unsupported qlog file_schema "<v>"`.
   - else `/"qlog_version"\s*:\s*"?([^",}\s]*)/`: **LegacyQlogError(version)** (section 6), confirmed on
     the parsed root (`qlog_version` present and `file_schema` absent; 9.1 step 3, fast path 9.1 step 4).
   - else `activeFieldTrialGroups`: netlog (D4). `_source` and `layers`: tshark JSON (D5).
   - else extension `.sqlog`: sequential. `.qlog` / `.json`: contained (lenient; the loader then validates).
   - else throw the PARITY "File format unsupported …" error, with the hint text updated to
     "make sure file_schema and serialization_format are at the top of the file".
4. **Parse**: contained uses `parseQlogText` (3.5, NEW repair); sequential uses the JSON-SEQ stream (3.7 NEW).
5. **Validate** the result: a contained file needs `file_schema === …:contained` (lenient if missing but
   `traces` is an array: accept and warn) and `traces` an array (absent means zero traces: throw "File
   contains no traces"). Each trace: `events` an array (default `[]`). A TraceError is any element with
   `error_description`.

---

## 4. Event and field consumption

This subsystem reads **file-, trace- and envelope-level** fields only. Event payloads are untouched,
except in four places: the truncation repair (event shape), the Download export (which copies event objects
and, in qvis, also carried their in-place mutations), the converters FileLoader dispatches to (NetLog, tshark
JSON, the pcap backend), and the bundled demo files. Section 9 gives the exact latest-draft equivalent,
semantic differences and absent-value behaviour for every row below.

| qvis (old) field | used for (qvis source) | qvis-react (main-schema-14); details in section 9 |
|---|---|---|
| top `qlog_version` | header sniff (`FileLoader.ts:215`), add gate `fileContents.qlog_version !== undefined` (`ConnectionStore.ts:282`), `loadQlogDirectlyFromURL` gate (`:380`), dead check on the axios response object (`:240`), `QlogLoader` dispatch (`QlogLoader.ts:14-45`), NDJSON/JSON-SEQ header check (`textsequencejsontoqlog.ts:26`), download (`QlogSchemaConverter.ts:12`, always `"draft-02"`) | **removed from the spec**. Present without `file_schema`: LegacyQlogError (X1). Present next to `file_schema` (quic-go): ignored. Gate on `file_schema` instead (9.1, 9.2). |
| top `qlog_format` (`JSON` / `NDJSON` / `JSON-SEQ`) | header sniff (`FileLoader.ts:218-227`), sequential header check (exact `=== "JSON-SEQ"` or `"NDJSON"`, `:26`), `group.format` (`QlogLoaderV2.ts:41`), draft-02 compliance message when missing (`QlogLoaderV2.ts:247-249`), download (always `"JSON"`) | `serialization_format` (`application/qlog+json`, `application/qlog+json-seq`, case-insensitive). Informational only: framing is decided by the bytes; quiche/neqo/quinn's `"JSON-SEQ"` is accepted (9.1). |
| (none) | | top `file_schema` (`urn:ietf:params:qlog:file:contained` / `…:sequential`) |
| top `title`, `description` | `group.title/description` (`QlogLoaderV2.ts:42-43`) → `getShorthand()` (desc cut at 50 chars + "..."); download | same |
| top `summary` | **never read from files**: `group.summary` stays `{}` (`ConnectionGroup.ts:31`; no loader assigns it). The download writes that empty object (`QlogSchemaConverter.ts:18`); the Stats "Summary" row is hidden while it is empty (`StatisticsRenderer.vue:32`), so it never renders. | removed in -06. Ignore, do not emit. |
| top `traces[]` | contained traces | same (optional; at least 1 entry when present) |
| root `error`, `error_description` | `loadQlogDirectlyFromURL` gate `c && !c.error && !c.error_description && c.qlog_version` (`ConnectionStore.ts:380`) | no equivalent (a root object is never a TraceError); treated as not-a-qlog (9.2) |
| header `trace` (NDJSON/JSON-SEQ first record) | becomes the single trace (defaults `vantage_point:{type:"unknown"}`, `events:[]`); every other header key is copied onto the file object (`textsequencejsontoqlog.ts:33-55`) | `trace` (TraceSeq: `title`, `description`, `common_fields`, `vantage_point`, `event_schemas`) (9.3) |
| subsequent JSON-SEQ/NDJSON records | `trace.events` | same (each record is an Event `{time, name, data, …}`) |
| `traces[i].error_description`, `uri` (TraceError) | `traces[0]` check throws on URL loads (`ConnectionStore.ts:274`); QlogLoader turns it into an "ERROR" connection | same + optional `vantage_point`; `uri` is optional now; FIX Q8 |
| `traces[i].event_fields` | parseQlogText truncation repair (array events, `StreamingJSONParser.ts:117-122`); legacy sniff key; download's array-to-object conversion (`QlogSchemaConverter.ts:43-115`) | removed. Repair object events (9.5). |
| `traces[i].events[*]` array length vs `event_fields`; `traces[0].events.length` in the oboe fail path | drop incomplete trailing events; choose current vs initial root | object events: drop the one event cut by the truncation (9.5) |
| `traces[i].vantage_point`, `common_fields`, `configuration`, `title`, `description` | copied into downloads **from the connection object**, so the loader-injected default `{type:"unknown", flow:"unknown", name:"No VantagePoint set"}` is exported, `configuration` is exported as `{}` when absent, `common_fields` as `{}` when absent, and slice titles keep their `"Group X : "` prefix (`QlogSchemaConverter.ts:32-41`) | `configuration` removed in -06. Others same; plus `event_schemas`. Export rules in 9.6. |
| (none) | | `traces[i].event_schemas` (required, hint only): export (9.6), Stats |
| `group_id` (event or common field) | QlogLoader splits traces (data-model spec); export keeps split; shorthand count includes the slices | same (9.4, 9.6) |
| download: `group.version` in the draft-02 `versionAliases` | decides "copy events as-is" versus event_fields conversion (`QlogSchemaConverter.ts:45-60`) | no version concept; the export always serializes the model (9.6) |
| download: `eventFieldNames` indices of `relative_time`/`delta_time`/`time`, `category`, `event_type`/`event`, `data`, `trigger` | event_fields → object conversion; writes `common_fields.time_format` `relative`/`delta`/`absolute`; moves `data.packet_type` → `header.packet_type`, `header.packet_size` → `raw.length`, `header.payload_length` → `raw.payload_length`, **deleting the latter two from the loaded event in place** (`QlogSchemaConverter.ts:65-163`) | not needed (no event_fields input) |
| download: event objects as loaded **and as mutated since** | the export carries enumerable renderer state and load-time rewrites: sequence diagram `timeText` (`SequenceDiagramD3Renderer.ts:852`); packetization `frame_size`/`header_size`/`payload_size` written onto frames (`PacketizationQUICPreProcessor.ts:646-693`) and injected filler frames `{frame_type: "qvis-injected FILLER (deal with incorrectly guesstimated frame size)", header_size, payload_size, qvis: {sequence: {hide: true}}}` (here `qvis` **is** enumerable, `:313-323`); draft-02 auto-fixes (`QlogLoaderV2.ts:188-241`); delta times rewritten to absolute values while `common_fields.time_format` stays `"delta"` (`QlogLoaderV2.ts:461-496`); sorted order (`QlogLoaderV2.ts:174`) | export from `QlogEvent.raw` / normalized data only; `ext` is never serialized; delta-encoded traces are rewritten consistently (9.6) |
| non-enumerable `event.qvis.*` (`SequenceDiagramD3Renderer.ts:573`, `SequenceDiagramCanvasRenderer.ts:70`, `CongestionGraphD3Renderer.ts:1877`), `connection.wasAutoGenerated` | excluded from downloads (`QlogSchemaConverter.ts:27`) | same (`ext`, `getRealConnections()`) |
| dead download debug filter: `transport:packet_sent`, `transport:packet_received`, `transport:parameters_set`, `http:frame_created`, `"http" + "frame_parsed"` (no colon, can never match), names containing `session_ticket_used` (`FileManagerContainer.vue:542-555`, `DEBUGfilter = false`) | nothing (dead code) | not ported (9.6) |
| header-sniff legacy keys `traces`, `event_fields`, `vantage_point`, `common_fields` | "old style qlog without qlog_version" means `qlog_normal` (`FileLoader.ts:242-245`) | `traces`/`trace` without `file_schema`: lenient accept with a warning, unless a trace uses `event_fields` (T3) (9.1) |
| `activeFieldTrialGroups` (first 1 KB) | Chrome netlog sniff (`FileLoader.ts:234`) | D4; fast path plus a structural check (9.7) |
| netlog `constants`, `events` | backend-proxied netlog detection (`root.constants && root.events && url has ".netlog"`, `ConnectionStore.ts:251`) | D4; content-based only (9.7) |
| netlog converter input: `constants.logEventTypes`, `logSourceType`, `logEventPhase`, `timeTickOffset` (read but unused), `events[].{source.type, source.id, type, phase, time, params}` | `NetlogToQlog.convert` (`netlogtoqlog.ts:202-893`) emits draft-01 `event_fields` qlog | D4; must emit latest-draft qlog. Full mapping in 9.8.1. |
| `_source` + `layers` (first 1 KB); `[0]._source` | tshark JSON sniff (`FileLoader.ts:238`; demo loader `ConnectionStore.ts:390`); `TCPToQlog` emits `draft-02-wip` with `transport:`/`tls:`/`http2:` events | D5 (9.8.2) |
| server envelope `qlog`, `error`; `debug_list` | unwrap the pcap2qlog result (`ConnectionStore.ts:247-249`); error detection `!apireturns.error && !apireturns.data.error` (`:244`; `apireturns.error` is never set on an axios response). `debug_list` is **never read** by the client. | proxy errors use the same `{"error": string}` shape; a pcap backend's `qlog` must be latest-draft (9.7, 9.8.3) |
| list JSON `description`, `paths[].capture`, `paths[].secrets`, `paths[].description` (pcap2qlog list format; read by qvis-server/pcap2qlog in qvis) | `?list=`, `file1..N` | read client-side (8.3); the merged result is a latest-draft contained file (9.7) |
| demo file contents (draft-00/01 `event_fields` files, 3.9) | Options 3 and 4 | converted offline; event-level mapping in 9.8.4 |

Implementation-specific or legacy behaviour worth knowing:

- pcap2qlog output uses `qlog_version: "draft-02-wip"`, `event_fields`, `configuration.time_units/time_offset/original_uris`
  and vantage point `{name:"pcap", type:"network", flow:"client"}`.
- Netlog output uses `qlog_version: "draft-01"`, `event_fields: ["relative_time","category","event","data"]`,
  `common_fields: {protocol_type:"QUIC_HTTP3", reference_time}` and vantage point `client`.
- TCPToQlog output uses `qlog_version: "draft-02-wip"`.
- qvis accepts version aliases `["draft-02","draft-02-RC1","qlog-03-WIP","0.3"]`. qlog `0.4` files
  (main-schema-06 to -08, `quic:` namespace) are **not** accepted by qvis either.
- Draft event schema URIs: implementations of the drafts MUST identify as `urn:ietf:params:qlog:events:quic-NN`
  / `…:http3-NN` (quic-events-13 section 2.1 / h3-events-13 section 2.1). Treat `event_schemas` only as a
  hint and never reject on it (main-schema section 8: "Tools MUST NOT treat either of these as an error").

---

## 5. URL query parameters and global state

### 5.1 Query parameters

Where read: `App.vue:53-57`, once on mount: `if (Object.keys($route.query).length > 0) loadFilesFromServer($route.query)`.
This happens on **any** route (`#/sequence?file=…` works). Values are vue-router-decoded strings. Repeated
keys arrive as arrays, and `?file` without a value arrives as `null` (falsy, so ignored).

| param | consumer | semantics |
|---|---|---|
| `file` | loadFilesFromServer, server | single URL. Highest precedence. Becomes `group.URL` (list shows a link). |
| `secrets` | server only | `.keys` URL for `file` (pcap). Ignored by the direct fetch. |
| `desc` | server only | description of the single capture and of the generated list (pcap2qlog mode only) |
| `list` | loadFilesFromServer, server | URL of a pcap2qlog list JSON (or of a qlog `.json`; see 3.8). Used if no `file`. |
| `file1`, `file2`, … `fileN` | loadFilesFromServer, server | multiple captures merged into **one** group (server-side). Used if no `file`/`list`. Enumeration stops at the first missing index. Display name uses `file1 + " etc."`. No `group.URL`. |
| `secrets1..N`, `desc1..N` | server only | per-capture keys/description |
| `focusOnConnection`, `focusOnEvent`, `focusOnPN` | sequence diagram (`SequenceDiagramRenderer.vue:58-71`) | not file loading, but forwarded verbatim to `/loadfiles` (harmless) |
| `forceFull` (inside the hash string) | sequence diagram renderer | unrelated |

Precedence: `file` > `list` > `file1`. Only one load happens per app start.

URL shapes that must keep working (drop-in compatibility, PARITY):

- `https://host/#/files?file=URL` and `https://host/#/sequence?file=URL&focusOnConnection=0&focusOnEvent=12`
  (the sequence diagram's own share links: `https://qvis.quictools.info?#/sequence?file=…&focusOnConnection=…&focusOnEvent=…`,
  `SequenceDiagramRenderer.vue:117-131`; with several URL-loaded groups it emits `file1=…&file2=…`).
- `https://host/#?file=URL` (empty hash path normalized to `/`, which redirects to `/files`; vue-router
  keeps the query on string redirects).
- `https://host/?file=URL` and `https://host/?file=URL#/sequence`. `router.ts:100-109`: on the first
  navigation (`from.path === "/"`), if `window.location.search` is set and the hash route has no query,
  the search params are copied into the route query.
- Query persistence across tab navigation (`router.ts:110-114`): navigating to a route without query,
  from one with query, carries the old query over. The address bar keeps showing `?file=…` on every tab.
  This does **not** trigger a reload (loading only happens on mount).
- Values are not re-encoded by qvis. URLs containing `&` must be percent-encoded by the link author.

### 5.2 Global state (`store/ConnectionStore.ts`)

| state | type | writers | readers |
|---|---|---|---|
| `grouplist` (getter `groups`) | `Array<QlogConnectionGroup>` | `addGroup` (push), `deleteGroup` (splice) | File Manager list and demo dedupe; every visualization configurator |
| `outstandingRequests` (getter `outstandingRequestCount`) | number | `adjustOutstandingRequestCount(±1)` in loadFilesFromServer / loadQlogDirectlyFromURL | Sequence/Congestion/Multiplexing/Packetization/Stats configurators: `<b-alert variant="danger">Please load a trace file to visualize it</b-alert>` shown iff `outstandingRequestCount === 0 && groups.length === 0` |

`QlogConnectionGroup` fields used here: `filename`, `URL`, `URLshort`, `title`, `description`, `version`,
`format`, `summary`, `getConnections()`, `getShorthand()`. Defaults: `version ""`, `format "JSON"`, all
strings `""`.

Component-local state (FileManagerContainer): `urlToLoad: ""`, `secretsToLoad: ""`, `filesToUpload: File[] = []`,
`secretsToUpload: File | null = null` (dead). Not persisted. Reset when the route component remounts
(navigating to another tab and back clears the inputs).

Environment-dependent backend URL (`ConnectionStore.ts:218-226`): `/loadfiles` (same origin). Dev:
`localhost:8080` uses `https://localhost/loadfiles`, any other `:8080` uses `https://qvis.quictools.info/loadfiles`.

---

## 6. Edge cases, error handling, notifications

### 6.1 Notification catalogue (qvis, verbatim; `<br/>` = line break; `+ x` = concatenation)

| # | trigger (source) | type | duration | title | text |
|---|---|---|---|---|---|
| N1 | Fetch with pcap URL and empty keys (`FileManagerContainer.vue:237-247`) | error | 6000 | `Provide .keys file` | `You're linking to a .pcap without also providing a .keys file. This is currently not supported.` |
| N2 | (dead) upload pcap without keys (`:266-276`) | error | 6000 | `Provide .keys file` | `You're uploading a .pcap without also providing a .keys file. This is currently not supported.` |
| N3 | upload validation (`:280-290`) | error | 6000 | `Provide .qlog/.sqlog file` | `We currently only support uploading .qlog/.sqlog files. ` + name |
| N4 | per uploaded file start (`:296-300`) | (info) | 3000 | `Loading uploaded file` | `Loading uploaded file ` + name + `.<br/>The file is not sent to a server.` |
| N5 | upload loaded (`:439-444`) | success | 3000 | `Uploaded file` | `The uploaded file is now available for visualization ` + name + `.<br/>Use the menu above to switch views.` |
| N6 | upload failed (`:449-455`) | error | 6000 | `Error uploading file` | `Something went wrong. ` + name + `. For more information, view the devtools console.` |
| N7 | demos already loaded (`:494-499`) | warn | 3000 | `Example files already loaded` | `Example files were already loaded, check for files with the 'DEMO_' prefix.` |
| N8 | massive demo already loaded (`:518-523`) | warn | 3000 | `Example file already loaded` | `Example file was already loaded, it is called 'MASSIVE_DEMO_mvfst_large'.` |
| N9 | QlogLoader rejected the JSON (`ConnectionStore.ts:82-88`) | error | 6000 | `ERROR parsing qlog file ` + filename | `File was successfully loaded but could not be parsed.<br/>Make sure you have a well-formed qlog file.<br/>View the devtools JavaScript console for more information.` |
| N10 | URL load start (`:152-156`) | (info) | 3000 | `Loading file(s) via URL` | `Loading files via URL ` + urlToLoad + `.<br/>The backend server downloads the files, possibly transforms them into qlog, then sends them back. This can take a while.` |
| N11 | URL load success (`:305-310`) | success | 3000 | `Loaded files via URL` | `The loaded files are now available for visualization ` + urlToLoad + `.<br/>Use the menu above to switch views.` |
| N12 | URL load failure (`:315-321`, `:329-335`) | error | 6000 | `ERROR loading URL ` + urlToLoad | `File(s) could not be loaded from ` + urlToLoad + `.<br/>View the devtools JavaScript console for more information.` |
| N13 | demo/massive start (`:363-367`) | (info) | 3000 | `Loading qlog file directly` | `Loading qlog file "` + filename + `" from URL ` + url + `. Large files can take a while to load.` |
| N14 | demo/massive loaded (`:383-388`, `:401-406`) | success | 3000 | `Loaded ` + filename | `This file is now available for visualization, use the menu above to switch views.` |
| N15 | demo/massive not a qlog (`:412-418`) | error | 6000 | `ERROR loading ` + filename | `This file could not be loaded from ` + url + `.<br/>View the devtools JavaScript console for more information.` |

`urlToLoad` in N10-N12 is the raw `file` / `list` value or `file1 + " etc."`. Data-model `alert()`s
(unordered timestamps; draft-02 non-compliance) are specified elsewhere.

### 6.2 NEW messages (qvis-react). Keep the qvis style; plain text, no HTML.

| id | when | type | duration | title | text |
|---|---|---|---|---|---|
| X1 | LegacyQlogError (file has `qlog_version`, no `file_schema`) | error | 10000 | `Unsupported qlog version in ` + filename | `This file uses qlog_version "` + v + `". qvis only supports the latest qlog drafts (file_schema urn:ietf:params:qlog:file:contained or urn:ietf:params:qlog:file:sequential, draft-ietf-quic-qlog-main-schema-14). Please regenerate the file with an up-to-date qlog implementation.` |
| X2 | unsupported `file_schema` (an unknown `serialization_format` never triggers X2, see 9.1) | error | 6000 | `Unsupported qlog file ` + filename | `Unknown file_schema "` + v + `". Supported: urn:ietf:params:qlog:file:contained, urn:ietf:params:qlog:file:sequential.` |
| X3 | JSON-SEQ records skipped (non-final) | warn | 6000 | `Some records were skipped in ` + filename | n + ` record(s) contained invalid JSON and were ignored. See the devtools console for details.` |
| X4 | truncated contained JSON repaired | warn | 6000 | `Incomplete qlog file ` + filename | `The file was not properly closed (e.g., the logger was stopped early). It was loaded up to the last complete event.` |
| X5 | URL load with some TraceErrors (FIX Q8) | warn | 6000 | `Some files could not be loaded` | n + ` of ` + m + ` traces failed: ` + first error_description |
| X6 | pcap/pcapng requested and D1 = unsupported | error | 6000 | `Packet captures not supported` | `This deployment cannot decrypt or convert .pcap/.pcapng files. Convert them to qlog first, or use a qvis instance with a pcap backend.` |
| X7 | proxy returned `{error}` | error | 6000 | N12 title | N12 text + line break + server `error` string |

Where qvis only says "view the devtools console" (N6, N12), append the thrown error's `message` on a new
line (FIX, low risk; keep the qvis sentence first).

### 6.3 Edge cases and expected behaviour

| case | qvis | qvis-react |
|---|---|---|
| Fetch with empty URL | button disabled | same |
| Fetch with whitespace URL | enabled, load fails with N12 | trim before use (FIX) |
| Enter key in URL field | implicit form submit **reloads the page** (Q1) | Enter triggers Fetch; `preventDefault` |
| URL with `.pcap` and empty keys | N1, abort | N1 if D1 has a backend, else X6 |
| Remote host without CORS | direct fails, then proxy | same, with a Vercel proxy |
| Remote 404 | direct non-OK, proxy also 404, N12 | N12 + "HTTP 404" (X7) |
| Remote returns HTML (e.g. a login page) | sniff fails; proxy result is an HTML string, FileLoader throws, N12 | same outcome |
| Truncated `.qlog` | oboe partial root, loads (last array event dropped if `event_fields`) | repair, X4 |
| JSON-SEQ with bad record mid-file | loader **hangs forever** (Q11) | skip, X3 |
| JSON-SEQ with truncated last record | skipped silently | same |
| Empty file | `.qlog`/`.json`: empty head fails the sniff ("File format unsupported…"), N6/N12. `.sqlog`: zero records give `{qlog_version:"draft-02", traces:[]}`, so an **empty group "(0 connections)" is added** with N5. NDJSON with a bad header does the same. | "File is empty" / "File contains no traces" error toast; never add empty groups (FIX) |
| Upload of 5 files, one bad extension | N3 for the first bad one, **none loaded** | PARITY (keep all-or-nothing validation) |
| Same file uploaded twice | two identical groups | PARITY |
| Demo button twice quickly | loads twice | FIX: also block while demo loads are in flight |
| Massive demo while loading | loads twice | same FIX |
| Very large JSON (>~500 MB) | string length limit, FileReader error, N6 | same; recommend `.sqlog` |
| `?file` relative path | direct same-origin fetch | same (Vercel serves `public/`) |
| `?file=x.qlog&secrets=y.keys` | direct `.qlog` fetch, secrets ignored | same |
| `?list=` pointing at a qlog `.json` | loads as qlog via direct fetch | same |
| List with mixed qlog and pcap entries | server merges; failed entries become TraceErrors; if `traces[0]` failed, **whole load fails** | client merges, pcap entries become TraceErrors (D1), X5 |
| Query with only unrelated keys | nothing | same |

---

## 7. Known bugs and quirks

| # | quirk | where | preserve or fix |
|---|---|---|---|
| Q1 | Option 1 `<form>` has one text input, so Enter performs an implicit GET submit and reloads the page, losing all loaded files. With the pcap secrets input visible (two inputs) Enter does nothing. | `FileManagerContainer.vue:12-23` | **FIX**: Enter submits Fetch |
| Q2 | Notification `title`/`text` rendered as HTML with user-controlled strings (`?file=<img onerror=…>`, filenames). **XSS.** | vue-notification `v-html`, all N# | **FIX (must)**: plain text; `<br/>` becomes explicit line breaks |
| Q3 | Group URL rendered as `<a href>` without scheme check; same-tab navigation loses state | `:148-150` | **FIX**: http(s) only, `target=_blank` |
| Q4 | `secrets` sent even when the secrets input is hidden (URL changed from `.pcap` to something else) | `:257-259` | FIX: only send when `urlIsPcap` |
| Q5 | `loadQlogDirectlyFromURL` has no `.catch`: 404/network leaves `outstanding` at +1, unhandled rejection, no toast. `parseQlogText` returning `undefined` gives a TypeError at `fileContents.length`. | `ConnectionStore.ts:371-431` | **FIX**: N15 on any failure; decrement in `finally` |
| Q6 | Upload success toast (N5) fires before or independent of QlogLoader validation, so the user can see N5 and N9 together | `:435-444` | FIX: await add; show N5 only on success |
| Q7 | `outstandingRequestCount` drift: +1 never decremented after a successful direct fetch or when the URL does not match the direct-fetch extensions; −1 twice when post-axios code throws (can go negative). Effect: the "Please load a trace file" alert can be wrongly suppressed. | `ConnectionStore.ts:178-336` | **FIX**: one `try/finally` per request |
| Q8 | URL loads: only `traces[0].error_description` is checked, and it throws the whole result away even when the other traces are fine. Errors at index > 0 become empty "ERROR" connections. | `:274-276` | FIX: X5 and keep good traces (DECISION D9 to keep parity instead) |
| Q9 | Upload control starts in the red "invalid" state because `state=false` when empty | `:48` | **PRESERVE** (visual parity); trivial to drop later |
| Q10 | Dropping a file outside the upload control makes the browser open it (navigates away) | page | FIX (recommended): page-level `dragover`/`drop` `preventDefault`; drop anywhere on the File Manager page goes to the upload selection |
| Q11 | JSON-SEQ invalid record mid-file: `return` inside `processResult` stalls the stream, so `FileLoader.Load` never settles and the UI shows only N4/N10 | `textsequencejsontoqlog.ts:199-201` | **FIX**: skip and continue |
| Q12 | Truncation repair pops the **last** event instead of `events[i]`; it only works for `event_fields` traces | `StreamingJSONParser.ts:117-122` | FIX: object-event repair (3.5) |
| Q13 | Download filename from URL keeps the leading `/` (sanitized to `_`) and any query string; `.sqlog` gets `.qlog` appended; object URL never revoked | `FileManagerContainer.vue:558-572` | FIX (`+1`, strip query, revoke). Keep the "append .qlog" rule (PARITY). |
| Q14 | Shorthand connection count includes sequence-diagram auto-generated traces (clone adds itself to the parent group) | `ConnectionGroup.ts:52-57`, `Connection.ts:56` | FIX: count only non-auto-generated connections |
| Q15 | `loadFilesFromServer` notification always says "The backend server downloads the files…", even for direct loads | N10 | **PRESERVE** text |
| Q16 | Backend direct-proxy never sets `Content-Encoding` for compressed files (`.qlog` matches first via `indexOf`) | `FileFetchController.ts:234-245` | n/a (client decompresses) |
| Q17 | Server rejects `.sqlog`/`.json` single files without secrets ("Empty URL passed…") and `fileN=.pcapng` (validates `req.query.file`) | `:156-203` | n/a (React proxy supports all text formats) |
| Q18 | Server proxy forwards the user's cookies and headers to arbitrary origins; open proxy; no SSRF protection | `:294-323` | **FIX** in the Vercel function (8.6) |
| Q19 | Extension checks are case-sensitive (`X.QLOG` rejected) | FileLoader, uploadFile | FIX: case-insensitive |
| Q20 | Demo dedupe by filename prefix `DEMO`; a user file named `DEMO…` blocks demos | `:483-503` | PRESERVE prefix logic, plus the in-flight guard |
| Q21 | Group order = completion order of parallel loads | store push | PRESERVE (simplest); optional: insert demos in declared order |
| Q22 | `.qlognd` accepted by upload validation but not by `accept`; `.qlogseq`/compressed accepted by FileLoader but rejected by upload validation | `:51`, `:280` | NEW: keep `accept` verbatim. Validation suffixes: `.qlog .sqlog .json .netlog .qlognd` + compressed (D10). |
| Q23 | Header sniff by substring (`"JSON"` anywhere in the first 1 KB means JSON) | `FileLoader.ts:211-248` | replaced by the 3.14 regex sniff (NEW) |
| Q24 | Upload does not touch `outstandingRequestCount` | `uploadFile` | FIX: count uploads too (consistent "loading" state) |
| Q25 | Main-thread parsing freezes the UI for large files | everywhere | optional improvement: Web Worker parse (D11) |

---

## 8. Porting notes for React (Vite + React 19 + react-bootstrap 2 / Bootstrap 5 + react-router 8 + zustand 5)

There is **no D3 in this subsystem**. Everything is declarative React. The only imperative DOM is the
download anchor click.

### 8.1 Module breakdown (suggested)

```
src/
  loading/
    detect.ts            // extension allowlist + header sniff (3.4 / 3.14)   pure, unit-tested
    decompress.ts        // gzip/brotli via DecompressionStream, magic-byte sniff
    parseContained.ts    // parseQlogText: JSON.parse → tolerant fallback + object-event repair (3.5)
    parseSequential.ts   // JSON-SEQ record stream (3.7 NEW)
    fileLoader.ts        // loadQlogFile(input, name): Promise<LoadedQlog>  (3.14)
    urlLoader.ts         // loadFromQueryParameters(q), loadSingleRemote, loadList, loadMulti (8.3)
    proxyClient.ts       // fetchViaProxy(url) → bytes; error JSON → Error(message)
    demo.ts              // DEMO_FILES table, loadExamplesForDemo, loadMassiveExample, loadQlogDirectlyFromURL
    exportQlog.ts        // groupToContainedQlog(group) + downloadGroup(group) (3.11 NEW)
    shorten.ts           // shortenForFilename(urlToLoad), shortenURL(fullURL) (3.8 formulas)
    errors.ts            // LegacyQlogError, UnsupportedFormatError, PcapUnsupportedError
    converters/          // netlogToQlog.ts (D4), tcpToQlog.ts (D5): separate specs
  store/connectionStore.ts   // zustand: groups, outstandingRequests, addGroup, removeGroup, adjustOutstanding
  notifications/             // NotificationsHost + notify() (2.10), plain-text API
  pages/files/
    FileManagerPage.tsx      // header + container + rows
    OptionRow.tsx            // "Option N" | title + children + help
    UrlLoadOption.tsx        // Option 1
    UploadOption.tsx         // Option 2 (uses BsCustomFileInput)
    DemoOption.tsx           // Option 3
    MassiveDemoOption.tsx    // Option 4
    UrlParamsHelpOption.tsx  // Option 5
    LoadedFilesList.tsx      // list + Remove/Download
    BsCustomFileInput.tsx    // BS4-style custom-file look-alike with drag state
    FileManagerPage.css      // 2.3/2.11 styles (scoped via a root class)
api/loadfiles.ts             // Vercel Function: CORS proxy (8.6)
public/standalone_data/...   // converted latest-draft demo files (8.7)
```

Keep loaders **outside** React components and the store (pure async functions that take `store`
callbacks / `notify`), so the same functions serve App start (query) and the page buttons. Mirror qvis's
public names where convenient (`loadFilesFromServer` → `loadFromQueryParameters`,
`loadQlogDirectlyFromURL`, `loadExamplesForDemo`, `addGroupFromQlogFile`).

### 8.2 Store (zustand)

```ts
interface ConnectionStore {
  groups: QlogConnectionGroup[];          // insertion order (Q21)
  outstandingRequests: number;            // never negative; maintained with try/finally
  addGroup(g): void; removeGroup(g): void; adjustOutstanding(delta: number): void;
}
```

Groups are class instances holding large arrays. Store them by reference and never deep-clone or
`structuredClone` them. Components select `groups` (array identity changes on add/remove only). Do not
put event arrays in React state.

`addGroupFromQlogFile({fileContentsJSON, fileInfo})` keeps qvis semantics: call the data-model
`QlogLoader.fromJSON`; on `undefined`, toast N9; otherwise set `filename`/`URL`/`URLshort` and `addGroup`.
Return a boolean so callers can sequence success toasts (FIX Q6).

### 8.3 Routing and query handling (drop-in URL compatibility)

- Use **hash routing** (`createHashRouter`) so `#/files`, `#/sequence?…` links from the wild keep working.
- Boot sequence (in `main.tsx` or `App` `useEffect` with a once-guard, not dependent on route changes):
  1. `hashQuery` = params after the first `?` inside `location.hash`. `searchQuery` = `location.search`.
  2. `q = Object.keys(hashQuery).length ? hashQuery : searchQuery` (router.ts:102 semantics).
  3. If `searchQuery` was used, `history.replaceState` to move it into the hash route (`/#/files?…`), so
     tab navigation keeps it.
  4. Normalize an empty hash path (`#?file=…`) to `#/files?…`.
  5. `loadFromQueryParameters(q)` once. React 19 StrictMode double-invokes effects in dev, so guard with a
     module-level flag.
- Query persistence: the MainMenu tab links must append the current `location.search`-equivalent of the
  hash query, as `router.ts:110-114` does (owned by the app-shell spec; restated here because
  `focusOn*` and share links depend on it).
- Parse repeated keys like vue-router (`getAll`). Treat arrays by taking the first value (qvis would pass
  an array to axios, producing `key[]=` params). DECISION-free: first value.

`loadFromQueryParameters(q)` (qvis-react):

```ts
if (!Object.keys(q).length) return;
const { urlToLoad, fullURL, mode } = pick(q);              // file > list > file1 ; urlToLoad uses " etc." suffix for file1 (display only)
if (!urlToLoad) return;
notify(N10);                                                // PARITY text
adjustOutstanding(+1);
try {
  const qlog = mode === "file" ? await loadSingleRemote(q.file, q.secrets)
             : mode === "list" ? await loadList(q.list)
             :                    await loadMulti(q);       // file1..N/secretsN/descN → same as list
  const ok = await addGroupFromQlogFile({ fileContentsJSON: qlog, fileInfo: buildFileInfo(urlToLoad, fullURL) });
  if (ok) notify(N11);
  maybeNotify(X5 if some TraceErrors);
} catch (e) { notify(N12 /* + e.message */); }
finally { adjustOutstanding(-1); }
```

`loadSingleRemote(url, secrets)`:

1. pcap-like (`url` contains `.pcap` and not `.pcap.json`, or ends with `/pcap`; `.pcapng` too): D1
   (default: throw PcapUnsupportedError, toast X6 instead of N12).
2. If `url` contains `.qlog`/`.sqlog`/`.netlog`/`.json` (PARITY condition; D8 extends this to any URL):
   `fetch(url)` (`mode: 'cors'`, `credentials: 'omit'`). If the response is OK, load its bytes with
   `loadQlogFile(bytes, url)`. Any failure (TypeError, non-OK, detection or parse error) falls through,
   **except LegacyQlogError and unsupported-schema errors, which are final** (re-fetching through the
   proxy cannot fix them).
3. Proxy: `fetch('/api/loadfiles?file=' + encodeURIComponent(url))`. Non-OK: read the `{error}` JSON
   and throw `Error(error)`. Otherwise load the bytes with `loadQlogFile(bytes, url)`.

`loadList(listURL)`: get the bytes as in steps 2-3. If `detect` says qlog, return it (PARITY: `?list=`
pointing at a qlog JSON). Else `JSON.parse`; require `paths: Array<{capture, secrets?, description?}>`.
Load each capture with `Promise.allSettled(paths.map(p => loadSingleRemote(p.capture, p.secrets)))`.
Concatenate the traces in list order; failures become `{error_description: String(err.message), uri: p.capture}`.
Per-capture description rule (pcap2qlog parity): `if (trace.description !== undefined) trace.description = p.description`.
DECISION D12: recommended simplification is "if `p.description` is defined, set it". Result:
`{file_schema: contained, serialization_format: "application/qlog+json", description: list.description, traces}`.

`loadMulti(q)`: build `paths` from `file1..N` / `secrets1..N` / `desc1..N` (stop at the first missing
`fileN`) and `description = q.desc || "Generated " + new Date().toLocaleString()` (server parity), then
continue as in `loadList`.

`buildFileInfo`: `filename = "Loaded via URL (" + shortenForFilename(urlToLoad) + ")"`. If `fullURL`
(single `file` only), also `URL = fullURL` and `URLshort = shortenURL(fullURL)`. Exact formulas in 3.8;
use `String.prototype.slice`/`substring` equivalents of `substr`.

### 8.4 Notifications

Implement a small host component (portal at the end of `App`) replicating section 2.10: fixed bottom
center, width 50%, stack with newest at the bottom, colors table, 12px text, `padding:10px`,
`margin:0 5px 5px`, title bold, click to dismiss, auto-dismiss after `duration` (default 3000), 300 ms
fade. API: `notify({ title: string, text: string | string[], type?: 'info'|'success'|'warn'|'error', duration?: number })`.
Lines are plain text: callers pass the qvis strings split at `<br/>` (or the helper splits on the literal
`<br/>` token and renders `<br/>` elements between React text nodes). **Never** use
`dangerouslySetInnerHTML` (Q2). Do not add a library unless it can be styled to match exactly.

### 8.5 Upload control (`BsCustomFileInput`)

- Hidden `<input type="file" multiple accept=".qlog,.sqlog,.json,.netlog">` under a label styled like BS4
  `.custom-file-label`: height `calc(1.5em + .75rem + 2px)`, padding `.375rem .75rem`, border
  `1px solid #ced4da`, radius `.25rem`, and a right-hand "Browse" segment (background `#e9ecef`, left
  border `inherit`, same height). Text is nowrap and truncated with an ellipsis.
- Label text: placeholder, "Drop files here..." while dragging, or `files.map(f => f.name).join(', ')`.
- State classes: invalid (`border-color:#dc3545` + red focus ring) when 0 files, valid
  (`border-color:#28a745`) when 1 or more (Q9).
- Drag and drop on the control: `dragenter`/`dragover` set dragging and `preventDefault`; `dragleave`
  clears it; `drop` takes `dataTransfer.files` and **replaces** the selection. Do not filter by `accept`
  on drop (BootstrapVue 2.0.4 does not; validation N3 catches bad names). Optional page-level drop guard (Q10).
- Import button `disabled={files.length === 0}`. After Import, keep the selection (PARITY).

### 8.6 Client-side vs server-side (Vercel)

What runs client-side: everything in qvis's `FileLoader` path (upload, sniffing, JSON/JSON-SEQ parsing,
truncation repair, decompression via `DecompressionStream('gzip')` and brotli where the browser supports
it), list orchestration (`list`, `fileN`), merging into one group, and export.

Vercel Function `api/loadfiles.ts` (Node runtime, streaming). It only needs the **CORS-proxy** half of
qvis-server:

- `GET /api/loadfiles?file=<absolute URL>`. Add a `vercel.json` rewrite `/loadfiles` →
  `/api/loadfiles` for API-shape compatibility. `list`/`fileN` are orchestrated client-side. If they reach
  the function, return 400 with the qvis 400 message.
- Validation: `new URL()`; protocol `http:`/`https:` only (otherwise 400 with the qvis "Malformed URL
  import. URL must include http(s):// : …" message). Reuse the qvis character-class checks (3.12 steps
  3-4) with the "Invalid URL import. : <url>" message.
- **SSRF guard (FIX Q18):** resolve the host (`dns.lookup(host, {all:true})`) and reject loopback,
  private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, incl. 169.254.169.254), CGNAT
  (100.64/10), `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0/8` and multicast. Follow redirects **manually**
  (max 5) and re-validate every hop. Only `GET`. **Do not forward client headers or cookies**; send a
  fixed `User-Agent` such as `qvis-react-proxy`.
- Timeout: 60 s total (qvis used 1-minute wget timeouts). Size cap: configurable via env, for example
  `QVIS_PROXY_MAX_BYTES` (default 128 MB). Abort when exceeded and return 413
  `{"error":"File too large for the qvis proxy"}`.
- Response: stream the upstream body **as bytes**. Node `fetch` (undici) transparently decodes transport
  `Content-Encoding`, so do **not** copy upstream `content-encoding`/`content-length`. Set
  `Access-Control-Allow-Origin: *`, `Content-Type: <upstream or application/octet-stream>`,
  `Cache-Control: no-store`, `X-Qvis-Upstream-Status`. A non-2xx upstream gives 502
  `{"error":"Upstream returned HTTP <code>","status":<code>}`. A network error gives 502
  `{"error":"Something went wrong fetching the files from the origin server through the qvis CORS proxy : <err>"}`
  (qvis wording).
- **Verify before relying on it:** current Vercel Function limits (response body size, which is
  documented as 4.5 MB for buffered responses, whether streamed responses are exempt, and max duration
  per plan). If streamed bodies are capped, the 31 MB-class remote files will only load via direct CORS
  fetch. Mitigation options: an Edge runtime function, or a `vercel.json` external rewrite.
- Abuse control: optional allowlist/denylist env vars. Rate limiting via Vercel firewall rules.

**pcap/pcapng + keys (D1).** Not feasible on Vercel as-is. It needs a tshark build with QUIC/TLS
dissection and keylog support (hundreds of MB, native), and pcap2qlog emits obsolete `draft-02-wip`
qlog. Options:

- (a) **Default / recommended for v1:** unsupported. Detect pcap-like URLs and list entries, toast X6
  (single file) or TraceError entries (lists). Adjust help text per D6.
- (b) Optional external backend: env `VITE_PCAP_BACKEND_URL`. If set, pcap requests go to
  `${base}/loadfiles?file=…&secrets=…` (qvis-server API) and the `{qlog}` envelope is unwrapped. Useful
  only if that backend emits latest-draft qlog (an upgraded pcap2qlog). The legacy output would be
  rejected by X1.
- (c) Future: client-side Wireshark-in-WASM (e.g. "wiregasm") plus a port of `ParserPCAP` emitting
  latest-draft events. Large effort.

### 8.7 Demo files

- Must be **latest-draft** files (the old draft-00/01 demos would be rejected). Produce them once with an
  offline script (`scripts/convert-legacy-demos.ts`) that converts each demo to a
  main-schema-14 contained file. Examples: `transport:*` becomes `quic:*`, `recovery:*` becomes `quic:*`
  per quic-events-13, `http:*` becomes `http3:*`. Also add `event_schemas`, `time_format`/`reference_time`.
  The event-level mapping belongs to the data-model/converter spec. Commit the outputs under
  `public/standalone_data/latest/…`. Keep the **filenames shown in the UI verbatim** (`DEMO_new_cid.qlog (<1MB)` …).
  Update a size annotation only if the converted file crosses the stated bound (D13).
- Massive demo: the upstream `mvfst_large.qlog` (draft-00, 31 MB) is downloaded from
  `https://quic.edm.uhasselt.be/files/mvfst_large.qlog`. Convert offline and host it as a static asset.
  Check the per-file deployment size limits (or host on a GitHub release with CORS and keep the URL in
  `demo.ts`). Keep the button label "Load 31MB .qlog file" and filename "MASSIVE_DEMO_mvfst_large.qlog (31MB)".
- `loadQlogDirectlyFromURL` in React should use `loadQlogFile` (so `.sqlog` demos also work), keep the
  N13-N15 texts, and fix Q5. Resolve demo URLs against `import.meta.env.BASE_URL` (Vite `base: './'`
  for subpath hosting, as qvis `baseUrl: './'`).

### 8.8 Tests to write (vitest + Playwright)

Unit (vitest):

- `detect`: every row of the 3.4 extension table and the 3.14 sniff rules. Include RS-first,
  `serialization_format` case-insensitive, legacy `qlog_version: "0.3"` giving LegacyQlogError, a netlog
  head, a tshark head, `…?.json` names, uppercase extensions, and BOM.
- `parseContained`: valid JSON; truncated at each of `"traces": [`, mid-event-object, mid-string,
  after a complete event + comma; garbage after root; syntax error mid-file. Expect the complete events
  only and no partial event objects.
- `parseSequential`: chunk boundary inside a multi-byte UTF-8 char; RS at a chunk boundary; records with
  internal newlines; invalid mid-file record (skipped, count reported, no hang: regression Q11);
  truncated final record; header missing or legacy; zero records.
- `shorten`: the 3.8 example; lengths 50/51 boundary; URL without a slash after 25 chars.
- `exportQlog`: filename rules (Q13 cases), auto-generated traces skipped, TraceError round-trip,
  `summary`/`configuration` omitted.
- `urlLoader` with mocked fetch: direct OK; direct CORS failure then proxy; proxy `{error}` (X7);
  legacy file does not retry via the proxy; list with mixed success (X5); `file1..N` naming
  "Loaded via URL (… etc.)"; outstanding counter returns to 0 in every path (Q7).

E2E (Playwright):

- Upload via the picker and via drag-and-drop onto the control; multi-file; bad extension (N3, nothing
  loaded).
- `#/files?file=<static demo URL>` and `/?file=…` boot loads.
- Demo button twice (N7).
- Remove and Download (check the download filename).
- Enter in the URL field does not reload (Q1).
- XSS probe: `?file=<img src=x onerror=…>.qlog` renders as text.

### 8.9 Open decisions (with recommended defaults)

| id | decision | recommendation |
|---|---|---|
| D1 | pcap/pcapng(+keys) support | v1 unsupported (X6); optional `VITE_PCAP_BACKEND_URL` hook |
| D3 | NDJSON (`.qlognd`) and newline-only JSON-SEQ | NDJSON not supported (clear legacy error through X1 since such files carry `qlog_version`). Optionally accept newline-separated records when there is no RS and the header is latest-draft. |
| D4 | Chrome `.netlog` | keep detection and routing; port `NetlogToQlog` to emit latest-draft qlog (separate converter spec). Until then, toast "Chrome netlog conversion is not supported yet". |
| D5 | tshark JSON (TCP/TLS/HTTP2) converter | defer; detect and toast unsupported. Not part of the qlog QUIC/H3 drafts. |
| D6 | Option 1/2 help text when pcap is unsupported | minimal edits as in 2.4; otherwise verbatim |
| D7 | Option 5 example links | visible text verbatim; href to the current deployment |
| D8 | URL loads with unknown extension | allow and sniff content |
| D9 | `traces[0]` TraceError aborts the load (Q8) | fix (X5) |
| D10 | Accept compressed uploads (`.qlog.gz`, …) | yes (client-side decompression); keep the `accept` attribute verbatim |
| D11 | Worker-based parsing | not in v1; design `loadQlogFile` so it can move into a worker later |
| D12 | pcap2qlog description-override quirk in lists | simplify to "set when defined" |
| D13 | Demo size labels after conversion | keep verbatim unless out of bound |

Real-world compatibility risk to surface to the product owner: many existing qlog producers still emit
`qlog_version: "0.3"`/`"0.4"` (`.sqlog` with `qlog_format: "JSON-SEQ"`). qvis-react will reject those
with X1 by design ("only latest drafts"). This is the single biggest behavioural difference from qvis for
end users.

Decisions D14 to D20 (latest-draft mapping) are listed in 9.12.

---

## 9. Mapping to latest qlog drafts

Sources: draft-ietf-quic-qlog-main-schema-14 (§3 to §5, §7, §8, §11, §13 and the changelog),
quic-events-13, h3-events-13, and the digests in `docs/dev/qlog-spec/` (`main-schema.md` sections 3 to 12,
22 and 27; `quic-events.md` sections 2, 7, 8, 13 and 15; `h3-events.md` sections 2 and 10; `ecosystem.md`
sections 2, 5 and 6). Where this section and sections 3.5, 3.7, 3.11 or 3.14 disagree, this section wins
(those sections point here).

Scope. This subsystem reads the file envelope, the trace envelope and the event **shape**. It never
interprets event `data`, except in three places that are therefore mapped below: the converters FileLoader
dispatches to (9.8.1 to 9.8.3), the offline demo conversion (9.8.4) and the Download export (9.6).
Event-name aliasing (`transport:packet_sent` to `quic:packet_sent`, ...) and data fix-ups (`cwnd` to
`congestion_window`, ...) belong to the data model (data-model 3.16.4; quic-events digest section 15;
ecosystem digest 6.4 and 6.5). The loader's only job there is to **let such files through unmodified**.

### 9.1 Acceptance policy and detection (normative)

Tiers (ecosystem digest 6.1), as applied by this subsystem:

| Tier | Input | Loader action | Feedback |
|---|---|---|---|
| T0 | `file_schema` is one of the two URNs; canonical event names | load | N5 / N11 / N14 |
| T1 | `file_schema` is one of the two URNs, plus legacy companions: `qlog_version`/`qlog_format` next to it (quic-go v0.56 and later), `serialization_format: "JSON-SEQ"` (quiche 0.27 and later, neqo/Firefox, quinn, tokio-quiche), legacy name prefixes (`transport:`, `recovery:`, `security:`), `event_schemas: []` (quinn), `file_schema` far from the start (mvfst) | load unchanged; the data model aliases names and records diagnostics | N5 / N11 / N14, then at most one info toast with the diagnostics (data-model 6.3) |
| T2 | Chrome NetLog; tshark JSON | convert to latest-draft qlog (9.8) | as qvis |
| T3 | `qlog_version` or `qlog_format` without `file_schema`; a trace with `event_fields` and no `file_schema`; NDJSON; unknown `file_schema`; not JSON | reject; nothing is added | X1, X2, or the qvis N6 / N12 / N15 texts |

Detection steps (they supersede 3.14 step 3 where they differ):

1. **Framing comes from the bytes**, never from `serialization_format` or the extension (tquic writes
   JSON-SEQ into `.qlog` files; ecosystem 5.2). After decompression and BOM removal, the first non-whitespace
   character decides: RS (U+001E) means JSON-SEQ; `{` means contained JSON (or a JSON-SEQ file written
   without RS, accepted only under D3 when the first line parses as a latest-draft sequential header); `[`
   means a tshark JSON candidate (D5); anything else is not qlog ("File format unsupported …", PARITY text
   with the 3.14 hint update).
2. **Sniff window: 65 536 chars** (main-schema digest P3). The sniff only selects the parser and the legacy
   fast path (step 4).
3. **The binding classification runs on the parsed root object (contained) or the parsed first record
   (JSON-SEQ)**, in this order:
   1. `typeof root.file_schema === "string"`: compare `trim().toLowerCase()` with
      `urn:ietf:params:qlog:file:contained` and `urn:ietf:params:qlog:file:sequential`. A match means T0/T1,
      and `qlog_version` / `qlog_format` are then ignored. No match means X2. A contained-parsed root that
      declares `sequential` but carries a `trace` object with `events` (or a JSON-SEQ header that declares
      `contained`) is accepted by structure, with a warning.
   2. `root.qlog_version !== undefined || root.qlog_format !== undefined`: X1 (LegacyQlogError; `v` is the
      `qlog_version` value, or the `qlog_format` value when there is no version). Optionally append the
      producer hint of ecosystem 6.7 (", written by ngtcp2", ...) to the X1 text.
   3. `root.constants?.logEventTypes` is an object and `root.events` is an array: NetLog (T2, D4), even when
      the `activeFieldTrialGroups` fast-path sniff missed it.
   4. `root.traces` is an array or `root.trace` is an object, and none of the above applies: accept
      leniently as contained / sequential with the warning diagnostic `file.missing-file-schema`
      (main-schema digest P6), **unless** a trace has a non-empty `event_fields` array: then X1 with the
      `event_fields` wording of ecosystem 6.7 ("This file uses the qlog draft-00/01 event_fields format").
   5. Otherwise: "File format unsupported (for qlogs, make sure file_schema and serialization_format are at
      the top of the file): " + name + " : " + first characters.
4. **Legacy fast path (performance only).** A contained file MAY be rejected with X1 before the full parse
   when the sniff window matches `/"qlog_version"\s*:/` and `/"traces"\s*:/` but not `/"file_schema"\s*:/`.
   This is safe for every producer surveyed: the only hash-ordered writer (mvfst) stopped writing
   `qlog_version` when it adopted `file_schema` (ecosystem 3.5), and quic-go writes `file_schema` before its
   `qlog_version` (ecosystem 3.1). JSON-SEQ needs no fast path, because its header is one small record.
5. **`serialization_format` is informational.** Normalize `value.split(";")[0].trim().toLowerCase()`.
   `application/qlog+json` and `application/qlog+json-seq` are canonical. `json` and `json-seq` (quiche,
   neqo, quinn) map to them with an info diagnostic. Any other value, a missing value, or a value that
   contradicts the framing gives a warning, and the bytes win. It **never** rejects a file. This replaces
   the former 3.14 rule that threw `Unsupported serialization_format`, which would have rejected every
   quiche, neqo and quinn file, including Firefox's (ecosystem 3.3).
6. **JSON-SEQ first record** (refines 3.7 NEW step 3):
   - it is classified with step 3;
   - exception to step 3.5: a first record with `time` and `name` but none of `trace`, `file_schema`,
     `qlog_version`, `qlog_format` is not rejected. Synthesize `{file_schema: "urn:ietf:params:qlog:file:sequential", serialization_format:
     "application/qlog+json-seq", trace: {event_schemas: [], vantage_point: {type: "unknown"}}}`, keep that
     record as the first event, warning `seq.missing-header` (main-schema digest P5; D17). qvis aborted
     (`textsequencejsontoqlog.ts:26-30`);
   - a first record that does not parse: `"Could not load json-seq file from stream : " + name` (PARITY);
   - a later record with both `file_schema` and `trace` (two `.sqlog` files concatenated) starts a new trace
     (D17).

### 9.2 File-level fields

| qvis field (consumers: section 4) | Latest-draft field (main-14) | Semantic differences | Absent / invalid: qvis-react |
|---|---|---|---|
| `qlog_version` | **none**. Identity is `file_schema` (file level) plus each trace's `event_schemas`, whose URIs carry the draft number (`urn:ietf:params:qlog:events:quic-13`). | No version string exists any more; every `qlog_version` value (`"draft-00"` to `"0.3"`, `"0.4"`) is legacy. | Alone: X1. Next to `file_schema`: ignored, kept in `LoadedQlog` for a raw-header view, never exported. `group.version` := `file_schema` (data-model 3.16.12; Stats "qlog version" row). |
| `qlog_format` | `serialization_format` (required; a media type; case-insensitive) | `"JSON"` → `application/qlog+json`; `"JSON-SEQ"` → `application/qlog+json-seq`; `"NDJSON"` → **none** (replaced by JSON-SEQ in main-schema-01). | Alone: X1. `group.format` := the normalized `serialization_format`, else derived from the framing. The File Manager page never shows it. |
| (none) | `file_schema` (required; absolute URI) | Only the two URNs are standardized. File schema URIs have no `-NN` draft suffix rule (main-schema digest 3). | 9.1 step 3. |
| `title` | `title` (`LogFile`, optional text) | same | `""`; `getShorthand()` unchanged (PARITY) |
| `description` | `description` (`LogFile`, optional text) | same | `""`; shorthand truncation at 50 chars unchanged (PARITY) |
| `summary` | **none** (removed in main-schema-06, #308) | qvis never read it (section 4) | Ignored, never exported. Nothing visible changes: the Stats row never rendered in qvis either. |
| `traces` (required) | `traces?: [+ Trace / TraceError]` | Optional now; at least one entry when present. | Absent or `[]`: "File contains no traces" (3.14 step 5; FIX, qvis could add an empty group). Not an array: the same error. |
| custom top-level keys (quic-go `code_version`, ...) | not in the `LogFile` CDDL, but tools MUST NOT error on unknown fields (main-14 §13) | — | Kept in `LoadedQlog` (`[k: string]: unknown`); export per D16. |
| root `error` / `error_description` (`ConnectionStore.ts:380`) | **none** | A root object is never a TraceError. The proxy's `{error}` envelope is handled before parsing (9.7). | 9.1 step 3.5 (not a qlog). |
| root array | **none** | tshark JSON | D5 |

### 9.3 Sequential header and records

| qvis (old header or record) | Latest draft (`QlogFileSeq`, main-14 §5) | qvis-react |
|---|---|---|
| header `qlog_version` (required by `textsequencejsontoqlog.ts:26`) | `file_schema: "urn:ietf:params:qlog:file:sequential"` | 9.1 step 3 |
| header `qlog_format === "JSON-SEQ"` (exact) | `serialization_format: "application/qlog+json-seq"` | 9.1 step 5 (lenient) |
| header `qlog_format: "NDJSON"` (`.qlognd`) | none | X1 (D3) |
| header `title`, `description`, other keys (copied onto the file object, `:33-37`) | `title`, `description` (`LogFile`); custom keys tolerated | same; custom keys kept |
| header `trace` (required) | `trace: TraceSeq {title?, description?, common_fields?, vantage_point?, event_schemas: [+text]}`, with **no `events`** member | Copy every key of `header.trace` onto the single trace. If a producer nevertheless puts an `events` array inside the header's `trace`, prepend those events to the records (ecosystem 6.2). |
| default `vantage_point: {type: "unknown"}` (`:40-45`) | `vantage_point` is optional | **PARITY: keep this default for sequential files.** It yields the label `"unknown : " + title` (`Connection.ts:163-186`). A contained trace without `vantage_point` instead gets the data-model default and the label `"No VantagePoint set : unknown (flow = unknown) : " + title`. quinn writes `{type: "unknown"}` explicitly, so most real files look the same either way. |
| default `events: []`; records 1..n | each record is one `Event {time, name, data, tuple?, time_format?, group_id?, system_info?, *}` | RFC 7464: consecutive RS are ignored; an invalid record is skipped and counted, X3 (FIX Q11); a truncated final record is dropped with a console warning only |
| zero records | — | "File is empty" (FIX; qvis added an empty group) |
| header record only | — | Load one trace with zero events and warn "No events could be parsed (file truncated?)" (ecosystem 6.7, last row). This is one connection, so it is not an empty group. |

### 9.4 Trace-level fields

| qvis field (old) | Latest-draft field | Semantic differences | Absent / invalid: qvis-react |
|---|---|---|---|
| `vantage_point` (required) `{name?, type, flow?}` | `vantage_point?: VantagePoint {name?, type: "client"/"server"/"network"/"unknown", flow?: "client"/"server"/"unknown"}` | Optional now; same values; `flow` is only required for `network`. Producers also write non-standard `type` values (`"transport"` for quic-go endpoint traces, uppercase in msquic's tool). | Contained: data-model default `{type: "unknown", flow: "unknown", name: "No VantagePoint set"}` (PARITY). Sequential: 9.3. Non-standard `type` strings are kept for display, and perspective logic treats them as `unknown` (data-model 3.16.6). Export: 9.6. |
| `title`, `description` | same (optional text) | same | `""` |
| `common_fields` `{group_id?, protocol_type?, reference_time?: string or number, time_format?: "absolute"/"relative"/"delta", ODCID?, ...}` | `common_fields?: CommonFields {tuple?, time_format?: "relative_to_epoch"/"relative_to_previous_event", reference_time?: {clock_type, epoch, wall_clock_time?}, group_id?: text, * any}` | `reference_time` is an object whose `epoch` is an RFC 3339 string or `"unknown"`; new `time_format` values; per-event overrides are legal (main-14 §7.5). | Passed through untouched; interpretation is data-model P9 / P12. The loader reads it only for the export time rewrite (9.6). |
| `common_fields.protocol_type` | **none** (renamed `protocol_types` in main-10, removed in main-11 in favour of `event_schemas`, #449) | — | Ignored. A converter that needs a TCP marker keeps it as a custom key (9.8.2); data-model `protocolHint` reads it. |
| `configuration` `{time_offset?, time_units?, original_uris?}` | **none** (removed in main-06, #308) | Units are always ms; `time_offset` is always 0 (data-model 3.16.3); `original_uris` has no replacement (`TraceError.uri` is the nearest). | Ignored if present; never exported. Converters scale µs inputs themselves (9.8.4). |
| `event_fields` and array events | **none** | Events are always JSON objects. | Without `file_schema`: X1 (9.1 step 3.4). With `file_schema`: the data model skips array events (`event.not-object`, `trace.event-fields-unsupported`). The truncation repair never looks at it, so Q12 becomes moot. |
| `events` (required) | `events: [* Event]` (required in `Trace`) | may be empty | Missing: `[]` plus a warning. |
| (none) | `event_schemas: [+ text]` (required in `Trace` and `TraceSeq`; **a hint only**: main-14 §8.1, "Tools MUST NOT treat either of these as an error") | Draft implementations append `-NN` (`...:quic-13`, `...:http3-13`, `...:http-13`); mvfst writes unversioned and private (`...:mvfst`) URIs; quinn writes `[]`. | Missing or `[]`: treated as `[]` plus a diagnostic; never rejects. This subsystem reads it only for the export (9.6); Stats shows it. A root-level `event_schemas` (pre-main-11 placement) is copied into traces lacking one by the data model (main-schema digest P7). |
| TraceError `{error_description, uri}` (both required) | `TraceError {error_description: text, uri?: text, vantage_point?: VantagePoint}` | `uri` is optional; new optional `vantage_point`. Discriminate on `typeof error_description === "string"`. | URL loads no longer abort on `traces[0]` (FIX Q8, X5 quotes the first `error_description`). Placeholder connection: data-model 3.16.6 (no `"undefined : "` prefix; vantage point taken from the TraceError). |
| `group_id` (event level, or `common_fields.group_id`) | `Event.group_id?: GroupID` (text) and `CommonFields.group_id` | Per-event values are legal on any event (qvis only checked the first event); the value is text (non-strings are stringified, PARITY). quinn writes it per event; mvfst writes none (only a custom `odcid`). | Splitting is data-model 3.16.5. File loading sees it only through the shorthand count (2.9) and the export (9.6). |

### 9.5 Event shape: truncation repair (contained JSON)

Old: draft-01 array events were compared with `event_fields.length` and the last array was popped
(`StreamingJSONParser.ts:117-122`, Q12). draft-02 object events were never checked, so a partially written
last event survived (oboe adds members as they complete). New: `Event = {time: float64, name: text, data:
$ProtocolEventData, ...}`, all three required (main-14 §7).

Precise rule (it replaces the "drop events lacking time/name" wording that 3.5 NEW used to have, and refines
main-schema digest P4, whose cut point can leave a partially filled event):

1. `JSON.parse(text)`. On success no event is dropped here. Malformed but complete events are the data
   model's concern (P8: kept and flagged).
2. On failure, scan `text` with a string- and escape-aware bracket stack. For each open container also
   record (a) the member name it was opened under (`"traces"`, `"trace"`, `"events"`, ...; array elements
   inherit the array's name), and (b) for each object that is a direct element of an `events` array at
   `$.traces[i].events` or `$.trace.events`, the offset of its opening `{` and of the `,` before it, if any.
3. Choose the cut:
   - **Complete root followed by non-whitespace** ("Unexpected non-whitespace character after JSON at
     position N"): parse `text.slice(0, N)`. qvis loaded these too (3.5), so log a console warning and show no
     toast.
   - **Truncation, or a syntax error at position N**: inspect the stack at N. If it contains an open event
     object (step 2b), cut at that event's opening `{` and also remove the preceding `,` and whitespace, so
     the partial event disappears entirely. Otherwise cut at the last position where a value or member was
     completed (main-schema digest P4 `lastSafe`), removing a dangling `"key":` or trailing `,`.
   - Append the closing brackets of every container still open at the cut, innermost first, and
     `JSON.parse` the result.
4. If the repaired parse fails, or there is no cut point (truncated before the root's first member), throw
   `Error("File is not valid JSON and could not be repaired: " + name)`, shown through N6 / N12 / N15 with
   the message appended.
5. After a successful repair, toast X4 once per file, with the count added: "... It was loaded up to the
   last complete event (N events)."

Rationale: a complete event without `time` is not a truncation artefact (the data model keeps it, P8). A
partial event is dropped even when `time`, `name` and a truncated `data` exist, so no view ever sees, for
example, a `quic:packet_sent` whose `frames` array was cut short (8.8: "no partial event objects"). The rule
looks only at structure, never at event names, so events of every namespace, including new ones such as
`quic:tuple_assigned` or `http:capsule_parsed`, are treated alike.

JSON-SEQ records are independent; 9.3 applies.

### 9.6 Download export mapped to the latest drafts

Old output (`QlogSchemaConverter.Convert01to02`, `QlogSchemaConverter.ts:7-120`) to new output, member by
member:

| Old member | New member | Rule |
|---|---|---|
| `qlog_version: "draft-02"` (`:12`) | `file_schema: "urn:ietf:params:qlog:file:contained"` | always contained JSON, whatever the input framing (a `.sqlog` input becomes one contained trace) |
| `qlog_format: "JSON"` (`:13`) | `serialization_format: "application/qlog+json"` | |
| `title`, `description` (`:15-16`) | same | only when non-empty (3.11) |
| `summary` (`:18`, always `{}`) | — | omitted |
| input companions `qlog_version` / `qlog_format` (quic-go) | — | omitted (D16) |
| other custom top-level keys | same | kept (D16) |
| per trace `vantage_point: connection.vantagePoint` (`:33`) | `vantage_point` | the connection's current vantage point (sequence-diagram renames are kept, PARITY), **except** when it is the loader-injected default and the raw trace had no `vantage_point`: then it is omitted (FIX: qvis wrote `name: "No VantagePoint set"` into files) |
| `title`, `description` (`:34-35`) | same | `group_id` slices: D15 |
| `configuration` (`:37`; `{}` when absent) | — | omitted (removed in main-06) |
| `common_fields ?? {}` (`:38`) | `common_fields` | the raw object; omitted when the raw trace had none and no time rewrite applies; time rewrite below |
| (none) | `event_schemas` | The raw trace's value when it is a non-empty string array (verbatim, including other draft numbers, unversioned or private URIs). Otherwise derived from the namespaces of the exported event names: `quic` → `urn:ietf:params:qlog:events:quic-13`, `http3` → `urn:ietf:params:qlog:events:http3-13`, `http` → `urn:ietf:params:qlog:events:http-13` (quic-13 §2.1, h3-13 §2.1 and §5.1 require the draft suffix), `loglevel` → `urn:ietf:params:qlog:events:loglevel`, `simulation` → `urn:ietf:params:qlog:events:simulation` (main-14 defines these two without a suffix rule); other namespaces add nothing. If nothing is derived, emit the raw value (possibly `[]`). |
| `events = connection.getEvents()` (`:52`; sorted; mutated in place by the loader and the renderers) | `events` | The connection's sorted order (PARITY). One object per event per D14 and the time rule below. Never `ext`, `qvis`, `timeText`, filler frames or packetization sizes. |
| event_fields → object conversion (`:63-115`) | — | gone |
| TraceError placeholders (dropped for draft-01, empty trace for draft-02) | `{error_description, uri?, vantage_point?}` from the original TraceError | FIX (3.11) |
| `wasAutoGenerated` connections skipped (`:27`) | same | `getRealConnections()` |

**Time rule (NEW; required for a correct file).** Under the latest drafts a `relative_to_previous_event`
value is a delta to the previously **logged** event of the serialized trace (main-14 §7.1; editor's copy
#622). Splitting by `group_id` and stable sorting both change an event's predecessor, so raw delta values
cannot be exported as they are. Rule per exported trace:

- If any event of the serialized trace that the connection came from has the effective `time_format`
  (`event.time_format ?? common_fields.time_format`) `"relative_to_previous_event"`: export every event as a
  shallow copy with `time: ev.resolvedTime`, without per-event `time_format` and `reference_time`, and export
  `common_fields` as `{...raw.common_fields, time_format: "relative_to_epoch", reference_time: <the
  connection's effective reference_time>}` (omit `reference_time` when there is none). `resolvedTime` is
  expressed against the connection-level epoch (data-model 3.16.3 pre-shifts events with a different
  epoch), which is why the per-event `reference_time` must go.
- Events the data model flagged `malformed: ["time"]` are always exported with `time: ev.resolvedTime`, so
  the output never lacks a required member.
- Otherwise raw `time` values are exported unchanged: they are relative to an epoch, so order and
  membership do not matter.
- qvis comparison: qvis rewrote delta times into absolute values inside the loaded objects but left
  `common_fields.time_format: "delta"` (`QlogLoaderV2.ts:461-496`), so re-loading its export of a delta
  trace applied the deltas twice (FIX).

**D14 (names and data).** Recommended: export the data model's normalized view. When `ev.fullName !==
ev.loggedName` or `ev.data !== ev.raw.data` (an alias or a fix-up was applied), emit `{...ev.raw, name:
ev.fullName, data: ev.data}`; otherwise emit `ev.raw` by reference. This mirrors qvis, whose Download also
carried its internal upgrades (draft-02 auto-fixes, `QlogLoaderV2.ts:188-241`), and it turns an
intermediate producer's file (quic-go `transport:*`, quiche `quic:datagrams_sent`) into a clean latest-draft
file. Alternative: always `ev.raw`, exactly "as logged".

**D15 (titles of `group_id` slices).** qvis exported slices with their `"Group X : "` titles, so re-loading
the export produced `"Group X : Group X : title"`. Recommended (FIX): when a slice's title still equals the
loader-generated `"Group " + id + " : " + (rawTrace.title ?? "")`, export `rawTrace.title` (omitted when
undefined); a renamed title is exported as is. Slices stay separate traces (PARITY), and each still carries
its events' `group_id`, so a reload rebuilds the same labels.

**D16 (top-level keys).** Recommended: copy every top-level key of the loaded file except `file_schema`,
`serialization_format`, `title`, `description`, `traces`, `trace`, `qlog_version`, `qlog_format` and
`summary`.

List and `fileN` groups (9.7) export like any other group: `description` is the list description, and
there is no title. The filename rules are unchanged (3.11).

Dead debug filter (`FileManagerContainer.vue:542-555`): its terms would be `quic:packet_sent`,
`quic:packet_received`, `quic:parameters_set`, `http3:frame_created` and `http3:frame_parsed` today (the
`"http" + "frame_parsed"` term lacks the colon and never matched); `session_ticket_used` has no latest
equivalent. Not ported.

### 9.7 Non-qlog inputs and transport envelopes

| qvis input or field | Used for | Latest-draft equivalent | qvis-react |
|---|---|---|---|
| `activeFieldTrialGroups` in the first 1 KB (`FileLoader.ts:234`) | NetLog sniff | none (NetLog is not qlog) | Keep as the fast path (qvis relied on it appearing near the start of `constants`); confirm after `JSON.parse` with `constants.logEventTypes` plus an `events` array (9.1 step 3.3; ecosystem 6.2). |
| `root.constants && root.events && urlToLoad` contains `".netlog"` (`ConnectionStore.ts:251`) | NetLog returned by the proxy | none | Content-based detection only (FIX: no URL condition; same path as uploads). |
| `_source` and `layers` in the first 1 KB (`FileLoader.ts:238`); `c[0]._source` (`ConnectionStore.ts:390`) | tshark JSON | none | D5 (9.8.2) |
| qvis-server envelope `{qlog, debug_list}` or `{error}`; `apireturns.qlog_version` (dead); `apireturns.error` (never set) | unwrap the pcap2qlog output; error detection | none | The Vercel proxy returns the upstream bytes, or `{"error": string}` with a non-2xx status (8.6), so there is nothing to unwrap. The optional pcap backend (D1 b) keeps the qvis envelope: unwrap `qlog`, ignore `debug_list`, and run the unwrapped object through 9.1 (pcap2qlog's current `draft-02-wip` output fails with X1; 9.8.3). |
| list JSON `{description, paths: [{capture, secrets?, description?}]}` | `?list=`, `file1..N` | none (qvis-specific) | Orchestration unchanged (8.3). The merged result is `{file_schema: contained, serialization_format: "application/qlog+json", description, traces}`. Each capture's traces are copied in list order (main-14 §4.1: aggregate by copying traces); a sequential capture contributes its single trace; a failed capture becomes `{error_description, uri: capture}`; each capture's own top-level `title` / `description` are dropped (pcap2qlog parity). |
| `.pcap` / `.pcapng` plus `.keys` | pcap2qlog | none | D1 |

### 9.8 Converters and demo files: required latest-draft output

#### 9.8.1 NetlogToQlog (D4; `netlogconverter/netlogtoqlog.ts`)

The h3 digest (section 10.7) already maps the HTTP/3 part; this table repeats it so the converter can be
ported from one place.

Input handling stays as in qvis: inverted `constants.logEventTypes` / `logSourceType` / `logEventPhase`
maps (`invertMap`, `:75-84`, used at `:218-220`); only `QUIC_SESSION` sources (`:234`); the first event of a
source creates the connection with `startTime = +event.time` (`:262-279`, with a warning when that first
event is not `QUIC_SESSION` in `PHASE_BEGIN`); event time = `+event.time - startTime`, in ms (`:287`).

Envelope:

| qvis output | Latest output |
|---|---|
| `{qlog_version: "draft-01", traces}` (`:886-889`) | `{file_schema: "urn:ietf:params:qlog:file:contained", serialization_format: "application/qlog+json", traces}`. No `title` / `description` (PARITY: the shorthand reads `" (N connections)"`). |
| trace `title: host + "-" + connection_id` (`:875`) | same |
| `vantage_point: {type: "client"}` (`:876`) | same |
| `event_fields: ["relative_time", "category", "event", "data"]` with array events (`:877`) | object events `{time, name, data}` |
| `common_fields: {protocol_type: "QUIC_HTTP3", reference_time: "<startTime>"}` (`:878`) | `common_fields: {time_format: "relative_to_epoch", reference_time: {clock_type: "system", epoch: new Date(Number(constants.timeTickOffset) + startTime).toISOString()}}` when `timeTickOffset` is finite (qvis reads it but never uses it, `:216`); otherwise `reference_time: {clock_type: "monotonic", epoch: "unknown"}`. `protocol_type` is dropped (data-model `protocolHint` derives `QUIC_HTTP3` from the namespaces). Effect: qvis's "relative + reference_time" becomes data-model case R; relative times are identical (PARITY); absolute times become Unix ms instead of tick values, and cross-connection alignment is unchanged because all connections share the one offset. |
| (none) | `event_schemas: ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"]`, plus `"urn:ietf:params:qlog:events:loglevel"` when a `CERT_VERIFIER_REQUEST` event was emitted |
| connections without events are skipped with a warning (`:873-884`) | same |

Every value the old converter stringified (`stream_id`, `offset`, `length`, `packet_number`, `maximum`,
`push_id`, ACK range bounds) becomes a JSON number: these are uint64 fields whose values are far below 2^53.

Per NetLog event type:

| NetLog event (qvis line) | qvis output (draft-01) | Latest output | Notes |
|---|---|---|---|
| `QUIC_SESSION` (`:294`) | none (creates the connection) | none | PARITY |
| `QUIC_SESSION_TRANSPORT_PARAMETERS_SENT` (`:310`) / `_RECEIVED` (`:585`) | `transport:parameters_set {owner: "local"/"remote", <key>: "<value>", ...}`, from `quic_transport_parameters.split(" ").slice(1)` taken pairwise | `quic:parameters_set {initiator: "local"/"remote", ...pairs}` | Keep the qvis tokenization (PARITY). Rename pre-RFC keys: `max_packet_size` → `max_udp_payload_size`, `idle_timeout` → `max_idle_timeout`, `original_connection_id` → `original_destination_connection_id` (quic digest 15.2). Decimal-string values become numbers; everything else stays a string; unrecognized keys stay as extension members. |
| `QUIC_SESSION_CRYPTO_FRAME_SENT` / `_RECEIVED` (`:329`) | frame `{frame_type: "crypto", offset: "n", length: "n"}` | `{frame_type: "crypto", offset: n, raw: {length: data_length}}` | `raw` is **required** on CryptoFrame (quic-13) |
| `QUIC_SESSION_PADDING_FRAME_*` (`:341`) | `{frame_type: "padding"}` | `{frame_type: "padding", raw: {payload_length: num_padding_bytes}}`; omit `raw` when the param is missing | NEW (recommended): -13 says a single PaddingFrame SHOULD carry the padding byte count in `raw.payload_length`; qvis discarded `num_padding_bytes` |
| `QUIC_SESSION_PING_FRAME_*` (`:351`) | `{frame_type: "ping"}` | same | |
| `QUIC_SESSION_STREAM_FRAME_*` (`:360`) | `{frame_type: "stream", stream_id, offset, length, fin}` | `{frame_type: "stream", stream_id: n, offset: n, fin, raw: {length: length}}` | the data length moves to `raw.length` (quic-13 StreamFrame) |
| `QUIC_SESSION_ACK_FRAME_*` (`:374`) | `{frame_type: "ack", acked_ranges: [["a", "b"], ...]}` from `calculateAckRanges(largest_observed, smallest_observed, missing_packets)` (`:93-130`) | `{frame_type: "ack", acked_ranges: [[a, b], ...]}` with numbers; emit `[a]` when `a === b` (producers SHOULD; tools MUST accept both) | Same range algorithm, including the test vectors in the comments at `:206-210`. Optional (D18): `ack_delay: delta_time_largest_observed_us / 1000` (qvis TODO at `:382`). |
| `QUIC_SESSION_WINDOW_UPDATE_FRAME_*` (`:393`) | `max_data {maximum}` when `stream_id === -1`, else `max_stream_data {stream_id, maximum}` | `{frame_type: "max_data", maximum: n}` / `{frame_type: "max_stream_data", stream_id: n, maximum: n}` | |
| `QUIC_SESSION_RST_STREAM_FRAME_*` (`:413`) | `{frame_type: "reset_stream", stream_id, error_code: quic_rst_stream_error, final_size: offset}` | `{frame_type: "reset_stream", stream_id: n, error: "unknown", error_code: quic_rst_stream_error, final_size: offset}` | `error` is required in -13. Semantic difference: `quic_rst_stream_error` is Chromium's internal `QuicRstStreamErrorCode`, not the wire code -13 expects in `error_code`; it stays there so the displayed number matches qvis. |
| `QUIC_SESSION_STOP_SENDING_FRAME_*` (`:426`) | `{frame_type: "stop_sending", stream_id, error_code: application_error_code}` | `{frame_type: "stop_sending", stream_id: n, error: "unknown", error_code: application_error_code}` | Optional: name known HTTP/3 codes with the h3 digest's numeric table (section 7). |
| `QUIC_SESSION_CRYPTO_HANDSHAKE_MESSAGE_*` (`:438`) | none | none | |
| `QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT` (`:445`) | tx frame `{frame_type: "connection_close", error_space: "transport_error", error_code: quic_error, raw_error_code: quic_error, reason: details}` | `{frame_type: "connection_close", error_space: "transport", error: quic_error === 0 ? "no_error" : "unknown", error_code: quic_error (omitted when 0), reason: details}` | `quic_error` is Chromium's internal `QuicErrorCode`; 0 is `QUIC_NO_ERROR`, so the sequence diagram's ": clean" label survives (sequence-diagram spec port rule: clean when `error` is `no_error` or `http_no_error`, or `error_code === 0`). Other values are internal codes shown as numbers, as in qvis. `_RECEIVED` is not handled by qvis (it falls to the default branch): PARITY. |
| `QUIC_SESSION_PACKET_SENT` (`:458`) | `transport:packet_sent {header: {packet_type, packet_number: "n"}, frames: <buffered tx frames>, raw: {length: size}}` | `quic:packet_sent {header: {packet_type, packet_number: n}, frames, raw: {length: size}}` | `encryption_level` → `packet_type`: `ENCRYPTION_INITIAL` → `initial`, `ENCRYPTION_HANDSHAKE` → `handshake`, `ENCRYPTION_ZERO_RTT` → `0RTT`, `ENCRYPTION_FORWARD_SECURE` → `1RTT`, other → `unknown`. qvis wrote the draft-01 values `zerortt` / `onertt`, which its draft-01 loader turned into `0RTT` / `1RTT` (`QlogLoader.ts:266-275`, `:494-500`). `transmission_type` and `sent_time_us` are ignored (PARITY). |
| `QUIC_SESSION_COALESCED_PACKET_SENT` (`:500`) | none | none | |
| `QUIC_SESSION_PACKET_RECEIVED` (`:505`) | `transport:packet_received {header: {packet_type: "unknown", packet_number: ""}, is_coalesced: false, raw: {length: size}}`; the following `UNAUTHENTICATED_PACKET_HEADER_RECEIVED` fills the header; frames are attached when the **next** `PACKET_RECEIVED` arrives | `quic:packet_received {header: {packet_type, packet_number?}, frames, raw: {length: size}}` | `is_coalesced` is not in -13: drop it. Omit `packet_number` while it is unknown (never `""`). FIX: after the last NetLog event, attach the still-buffered rx frames to the last received packet (qvis lost them). `peer_address` / `self_address` are ignored (PARITY). |
| `QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED` (`:546`) | sets `rxPacket.header.packet_type` and `packet_number` | same, on the `quic:packet_received` data | `long_header_type`: `INITIAL` → `initial`, `HANDSHAKE` → `handshake`, `ZERO_RTT_PROTECTED` → `0RTT`, `RETRY` → `retry`, `VERSION_NEGOTIATION` → `version_negotiation`, `INVALID_PACKET_TYPE` → `unknown`, absent (short header) → `1RTT`. qvis quirk kept: with no `rxPacket` yet, a header-only packet object is built and never emitted. |
| `QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED` (`:601`) | none | none | Optional (D18): push `{frame_type: "handshake_done"}` to the rx frames. |
| `QUIC_SESSION_PACKET_LOST` (`:606`) | `recovery:packet_lost {header: {packet_type: "unknown", packet_number: "n"}}` | `quic:packet_lost {header: {packet_type, packet_number: n}}` | FIX (recommended): `packet_type` = the type of the most recent converted `quic:packet_sent` with this `packet_number` in the connection, else `"unknown"`. -13 says the header "should include at least the packet_type and packet_number", and with `unknown` the views cannot place the loss in a packet number space. |
| `QUIC_SESSION_CLOSED` (`:627`), `QUIC_SESSION_CLOSE_ON_ERROR` (`:632`) | none | none | Optional (D18): `quic:connection_closed`, see 9.10 item 8. |
| `QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET` (`:636`) | none (commented out) | none | Optional (D18): `quic:packet_buffered {trigger: "keys_unavailable"}`. |
| `QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET` (`:647`) | `transport:packet_dropped {header: {packet_type: "handshake" or "unknown", packet_number: ""}}` | `quic:packet_dropped {header: {packet_type}}` | Map `encryption_level` with the full `PACKET_SENT` table (FIX: qvis only knew `ENCRYPTION_HANDSHAKE`); omit `packet_number`. Optional (D18): `trigger: "key_unavailable"` (the -13 spelling; the editor's copy says `keys_unavailable`). |
| `QUIC_CHROMIUM_CLIENT_STREAM_SEND_REQUEST_HEADERS`, `..._READ_RESPONSE_HEADERS`, `QUIC_SESSION_ATTEMPTING_TO_PROCESS_UNDECRYPTABLE_PACKET`, `..._PACKET_AUTHENTICATED`, `..._VERSION_NEGOTIATED`, `..._STREAM_FRAME_COALESCED`, `..._CERTIFICATE_VERIFIED` (`:670-697`) | none | none | |
| `HTTP3_PEER_CONTROL_STREAM_CREATED` / `HTTP3_LOCAL_...` (`:699`) | `http:stream_type_set {stream_id: "n", owner, new: "control"}` | `http3:stream_type_set {initiator: PEER → "remote", LOCAL → "local", stream_id: n, stream_type: "control"}` | h3 digest 10.7 |
| `HTTP3_*_QPACK_DECODER_STREAM_CREATED` (`:721`) / `..._ENCODER_...` (`:743`) | same with `new: "qpack_decode"` / `"qpack_encode"` | `stream_type: "qpack_decode"` / `"qpack_encode"` | |
| `HTTP3_SETTINGS_RECEIVED` / `_SENT` (`:766`) | `http:parameters_set {owner, max_header_list_size, max_table_capacity, blocked_streams_count}` | `http3:parameters_set {initiator: SENT → "local", else "remote", max_field_section_size: SETTINGS_MAX_HEADER_LIST_SIZE, max_table_capacity: SETTINGS_QPACK_MAX_TABLE_CAPACITY, blocked_streams_count: SETTINGS_QPACK_BLOCKED_STREAMS}` | |
| `HTTP3_MAX_PUSH_ID_*` (`:789`) | builds a frame, never emits it | none | PARITY |
| `HTTP3_HEADERS_DECODED` / `HTTP3_HEADERS_SENT` (`:799`) | `http:frame_parsed` / `http:frame_created {stream_id: "n", frame: {frame_type: "headers", headers: [{name, value}]}}` (`pushH3Frame` picks "created" when the type contains `SENT`, `:181-196`) | `http3:frame_parsed` / `http3:frame_created {stream_id: n, frame: {frame_type: "headers", headers: [{name, value}]}}` | |
| `HTTP3_PRIORITY_UPDATE_*` (`:816`), `HTTP3_DATA_SENT` (`:823`), `HTTP3_UNKNOWN_FRAME_RECEIVED` (`:840`), `HTTP3_HEADERS_RECEIVED` (`:844`) | none | none | PARITY; optional ideas in h3 digest 10.7 |
| `HTTP3_DATA_FRAME_RECEIVED` (`:827`) | `http:frame_parsed {stream_id: "n", frame: {frame_type: "data"}, byte_length: "<payload_length>"}` | `http3:frame_parsed {stream_id: n, frame: {frame_type: "data", raw: {payload_length: payload_length}}}` | `byte_length` (the frame payload length) moved into `frame.raw.payload_length` (h3 digest 10.3.3) |
| `CERT_VERIFIER_REQUEST` (`:849`) | `["info", "marker", "CERT_VERIFIER_REQUEST BEGIN" or "... END"]`; the data is a bare string | `loglevel:info {message: "CERT_VERIFIER_REQUEST BEGIN"}` / `{message: "CERT_VERIFIER_REQUEST END"}` | `data` must be an object in -14. `simulation:marker` is meant for changes of emulated test conditions, so `loglevel:info` fits better. |
| any other type | `console.warn("netlog2qlog:convert : unknown QUIC event, not supported yet!", ...)`; dropped | same | |

#### 9.8.2 TCPToQlog (D5; `pcapconverter/tcptoqlog.ts`, `pcapconverter/qlog_tcp_tls_h2.ts`)

Today's output: `{qlog_version: "draft-02-wip", traces}` (`tcptoqlog.ts:31`); traces with `vantage_point:
{type: "client"}`, `event_fields: ["time", "category", "event", "data"]`, `common_fields: {protocol_type:
"TCP_HTTP2"}` (`:67-69`); events `transport:packet_sent` / `transport:packet_received` for **TCP** segments
(the enum is `tcp = "transport"`, `qlog_tcp_tls_h2.ts:3-7`), `tls:record_created` / `tls:record_parsed`,
`http2:frame_created` / `http2:frame_parsed`; the TCP header carries `packet_type: "1RTT"` and
`packet_number` so the QUIC views accept it (`qlog_tcp_tls_h2.ts:52-60`).

The latest drafts define nothing for TCP, TLS records or HTTP/2. If D5 ever ports the converter:

- envelope: contained `file_schema` / `serialization_format`, object events;
- the namespace MUST NOT be `transport:`: the data model's alias rule rewrites `transport:*` to `quic:*`,
  and the QUIC views would then treat TCP segments as QUIC packets. Use private namespaces: `tcp:packet_sent`,
  `tcp:packet_received`, `tls:record_created`, `tls:record_parsed`, `http2:frame_created`,
  `http2:frame_parsed`;
- `event_schemas`: private URIs per main-14 §3.1 and §8 (a domain the project controls plus `mmyyyy`; never
  `urn:ietf:params:qlog:`), for example `https://<project domain>/112026/qvis-tcp`;
- keep `common_fields.protocol_type: "TCP_HTTP2"` as a custom key (data-model `protocolHint` reads it) and
  move `header.packet_size` to `raw.length`;
- the packetization and congestion views then look up `tcp:*` (their specs own that).

#### 9.8.3 pcap2qlog / qvis-server (D1)

pcap2qlog writes `qlog_version: "draft-02-wip"` traces with `event_fields`
(`pcap2qlog/src/parsers/ParserPCAP.ts:236-243`), and the combined file takes the last capture's version or
`"draft-01"` (`pcap2qlog/src/main.ts:246-255`). Under D1 (a) nothing changes. Under D1 (b) that output fails
with X1 unless the backend is upgraded to emit contained latest-draft files: `connectivity:` and
`transport:` names become `quic:*` (quic digest 13.2), and its existing CONNECTION_CLOSE handling
(`connection_state_updated {new: "closed"}`, `ParserPCAP.ts:797-806`) maps to
`quic:connection_state_updated`. Caveat: ACK `ack_delay` is copied from tshark's `quic.ack.ack_delay`
(`ParserPCAP.ts:865`), which is the undecoded wire value (verify against the Wireshark build used), while the
-13 `ack_delay` is decoded milliseconds.

#### 9.8.4 Demo files (8.7): offline conversion

Envelope per demo (inventory taken from the files in `public/standalone_data/`):

| Demo | Old envelope | Latest envelope |
|---|---|---|
| `draft-01/new_cid.qlog`, `draft-01/spin_bit.qlog` (pcap2qlog) | `qlog_version: "draft-01"`, `description: ""`; trace `title`, `vantage_point {name: "TODO", type: "network", flow: "client"}`, `configuration {time_offset: "0", time_units: "ms", original_uris: [...]}`, `common_fields {group_id, protocol_type: "QUIC", reference_time: "1564658098.991056"}`, `event_fields [relative_time, category, event, trigger, data]` | Contained envelope; the empty `description` is dropped (it is invisible in the shorthand); trace `title` and `vantage_point` verbatim (including `name: "TODO"`); no `configuration`; `common_fields {group_id, time_format: "relative_to_epoch", reference_time: {clock_type: "system", epoch: "2019-08-01T11:14:58.991Z"}}` (the value is in **seconds**: multiply by 1000, then format as ISO; the lost sub-ms digits do not matter); `event_schemas: ["urn:ietf:params:qlog:events:quic-13"]`. qvis read that reference time as milliseconds (main-schema digest 27.5), so absolute times differ, but each file has a single trace, so nothing visible changes. |
| `draft-01/parallel_10_50KB_f5.qlog` (aioquic) | trace `description`, `vantage_point {name: "aioquic", type: "client"}`, `common_fields {ODCID, reference_time: "1575028855415"}` (ms) | `common_fields {odcid (lower-cased: main-14 §11.1 requires lowercase field names), time_format: "relative_to_epoch", reference_time: {clock_type: "system", epoch: <ISO of 1575028855415>}}`; `event_schemas: [quic-13, http3-13]` |
| `draft-01/doublevantage_100ms.qlog` (aioquic; client and server traces) | as above; `reference_time` 1566844755588 (client) and 1566844755688 (server) | As above, per trace. Both epochs must stay exact (100 ms apart), because the sequence diagram aligns the two traces on absolute time. |
| `draft-00/quictrace_example_github.qlog` | `title`, `description`, `summary {...}`; trace `vantage_point {type: "SERVER", name: "Probably server, because debugging congestion stuff"}`, `configuration {time_offset: 0, time_units: "us"}`, `common_fields {reference_time: 0, group_id: "AAAAAAAAACo=", dcid, scid, protocol_type: "QUIC_HTTP3"}`, `event_fields [relative_time, CATEGORY, EVENT_TYPE, TRIGGER, DATA]` | `title` and `description` verbatim (the shorthand shows them, 2.9); no `summary`; `vantage_point.type: "server"` (qvis's draft-00 loader lower-cased it, data-model 3.10); `time = relative_time / 1000` (µs to ms), and the RTT metrics likewise; `common_fields {group_id, dcid, scid, time_format: "relative_to_epoch", reference_time: {clock_type: "monotonic", epoch: "unknown"}}` (0 is not a real epoch; case U gives the same relative times because the first event is at 0) |
| `MASSIVE_DEMO` `mvfst_large.qlog` (draft-00, 31 MB, not in the repo) | downloaded at deploy time (3.9) | Convert with the same script and tables. The script MUST fail on any event name or frame type that the tables below do not cover, so that new rows are added deliberately instead of events being dropped silently. |

The old `trigger` column only holds `"line"` (pcap2qlog demos), `"DEFAULT"` and `"UNKNOWN"` (quic-trace
demo). None of them is a -13 trigger value and qvis never displayed them, so they are dropped.

Events (counts per file; qvis's load-time renames are in `QlogLoader.ts:397-500`):

| Old name as logged (demo: count) | qvis internal name after load | Latest event | Field mapping |
|---|---|---|---|
| `connectivity:connection_new` (new_cid: 1, spin_bit: 1) | `connection_started` | `quic:connection_started`, plus `quic:version_information` at the same time | `local: {ip_v4 or ip_v6 (per ip_version "4"/"6"): src_ip, port_v4 or port_v6: Number(src_port), connection_ids: [src_cid]}`, `remote` likewise from `dst_*`; `quic_version: "0xff000016"` → `version_information.chosen_version: "ff000016"` (a hexstring, without `0x`); `transport_protocol` dropped. With `vantage_point {type: "network", flow: "client"}`, "local" is the client side, i.e. `src_*`. |
| `connectivity:connection_id_update` (new_cid: 3, spin_bit: 1) | `connection_id_updated` | `quic:connection_id_updated` | `src_old` / `src_new` → `{initiator: "local", old, new}`; `dst_old` / `dst_new` → `{initiator: "remote", old, new}` (quic digest 13.3) |
| `connectivity:connection_close` (new_cid: 2, spin_bit: 2) | `connection_state_updated {new: "closed", src_id: "removed when converting to draft-01"}` | `quic:connection_state_updated {new: "closed"}` | `src_id` dropped (qvis blanked it too) |
| `connectivity:spin_bit_update` (spin_bit: 8, doublevantage: 978), `connectivity:spin_bit_updated` (parallel: 395) | `spin_bit_updated` | `quic:spin_bit_updated {state}` | `state` is already a boolean |
| `transport:ALPN_update` (new_cid: 1, spin_bit: 1) | `transport:parameters_set {alpn: new}` | `quic:alpn_information {chosen_alpn: {string_value: new}}` | D20. Visible change: the sequence diagram labels it `alpn_information` instead of `parameters_set`. `old` (always `""`) dropped. |
| `transport:packet_sent` / `transport:packet_received` (all files) | `packet_type` moved into the header; `packet_size` / `payload_length` moved into `raw` | `quic:packet_sent` / `quic:packet_received` | `header: {packet_type (lower-cased: "UNKNOWN" → "unknown"; draft-01 "zerortt" / "onertt" → "0RTT" / "1RTT"), packet_number: Number, version: without "0x", scid, dcid, scil: Number, dcil: Number}`; `raw: {length: packet_size, payload_length: payload_length}`; frames per the next table |
| `transport:datagrams_sent` / `_received` (parallel: 109 / 401), `transport:datagram_sent` / `_received` (doublevantage: 986 / 981) | `datagrams_sent` / `datagrams_received` | `quic:udp_datagrams_sent` / `quic:udp_datagrams_received` | `{count, raw: [{length: byte_length}]}`. Every demo event has `count: 1`, so the per-datagram `raw` array is exact. |
| `transport:parameters_set` (parallel: 3) | same | `quic:parameters_set` | `owner` → `initiator`, `idle_timeout` → `max_idle_timeout`, `max_packet_size` → `max_udp_payload_size`, `original_connection_id` → `original_destination_connection_id`; other keys unchanged |
| `recovery:metrics_updated` (parallel: 45), `recovery:metric_update` (doublevantage: 1817, quic-trace: 3679) | `metrics_updated` | `quic:recovery_metrics_updated` | `cwnd` → `congestion_window`; `bytes_in_flight`, `min_rtt`, `smoothed_rtt`, `latest_rtt`, `rtt_variance` and `pacing_rate` keep their names; quic-trace RTTs × 0.001 (µs to ms) |
| `recovery:packet_lost` (quic-trace: 238) | same | `quic:packet_lost` | `{header: {packet_type: "1RTT", packet_number: Number(packet_number)}}` (every quic-trace packet is 1RTT) |
| `recovery:custom_cc_application_limited` (quic-trace: 1) | unchanged (an unknown event) | `quic:congestion_state_updated {new: "application_limited", trigger: "custom_cc_application_limited"}` | D20. -13 lists "Application Limited" among the free-text congestion states. Keeping the old name would put an unregistered type into the `quic` namespace, which main-14 §8 does not allow. Visible change: the sequence diagram shows "Congestion state: application limited" instead of a generic label. |
| `http:frame_created` (parallel: 20) / `http:frame_parsed` (parallel: 63) | same | `http3:frame_created` / `http3:frame_parsed` | `stream_id: Number`; `frame` unchanged (`headers: [{name, value}]` is the -13 shape); `byte_length` → `frame.raw.payload_length: Number` (h3 digest 10.3.3) |

Frames:

| Old frame (demos) | Latest frame |
|---|---|
| `crypto {offset, length}` | `{frame_type: "crypto", offset: n, raw: {length: n}}` |
| `padding {}`, `ping {}` | unchanged |
| `ack {ack_delay, acked_ranges: [["a", "b"], ...]}` (draft-00 `ACK`) | lower-case `frame_type`; range bounds as numbers (keep `[a, b]`; consumers accept both shapes); `ack_delay` as a number with its value unchanged. qvis displayed these values as logged; the pcap2qlog ones are tshark's raw field (9.8.3), so their unit is not guaranteed to be ms. |
| `stream {id, offset, length, fin}` (draft-00 `STREAM`) | `{frame_type: "stream", stream_id: n (from id, as qvis did: QlogLoader.ts:468-477), offset: n, fin, raw: {length: n}}`; omit `raw` for the 9 new_cid frames without `length` (-13: the length MAY then be computed, it is not required) |
| `new_token {length, token}` | `{frame_type: "new_token", token: {raw: {data: token, length: n}}}` |
| `new_connection_id {sequence_number, retire_prior_to, connection_id, length, reset_token}` | `{frame_type: "new_connection_id", sequence_number: n, retire_prior_to: n, connection_id, connection_id_length: n, stateless_reset_token: reset_token}` |
| `retire_connection_id {sequence_number}` | numbers |
| `max_data {maximum}`, `max_stream_data {id, maximum}` | `{maximum: n}`, `{stream_id: n, maximum: n}` |
| `max_streams {stream_type, maximum}` | unchanged (`bidirectional` / `unidirectional` are -13 values); `maximum: n` |
| `connection_close {error_space: "transport_error", error_code: "http_no_error", raw_error_code: "0", reason: ""}` | `{frame_type: "connection_close", error_space: "application", error: "http_no_error", reason: ""}`. `http_no_error` is an HTTP/3 application error (h3 digest 4.3), so the space is corrected; the sequence diagram still labels it ": clean". |

### 9.9 Items with no latest-draft equivalent

| Old item | Status | Behaviour in qvis-react |
|---|---|---|
| `qlog_version` | gone (main-14 has no version field) | X1 when alone; ignored next to `file_schema` |
| `qlog_format: "NDJSON"`, `.qlognd` | removed (main-01) | X1 (D3) |
| `summary` | removed (main-06) | ignored, never exported |
| `configuration.time_units` / `time_offset` / `original_uris` | removed (main-06) | always ms / always 0 / dropped (`TraceError.uri` is the nearest) |
| `event_fields` and array events | removed (draft-02) | X1 without `file_schema`; array events skipped with it |
| `common_fields.protocol_type` | removed (main-11) | ignored; converters may keep it as a custom key (9.8.2) |
| root `error` / `error_description` | never qlog | not a qlog file |
| qvis-server envelope `{qlog, debug_list}` | never qlog | 9.7 |
| TraceError `uri` required | now optional | placeholder without `"undefined : "` |
| loader-injected vantage default, `configuration: {}`, `summary: {}` in exports | — | not exported (9.6) |
| Chromium internal error codes (`quic_error`, `quic_rst_stream_error`) | no wire code available | `error: "unknown"` plus `error_code` (display parity); `quic_error` 0 → `"no_error"` |
| demo-only fields: `connection_close.src_id`, `ALPN_update.old`, `connection_new.transport_protocol`, `trigger` values `line` / `DEFAULT` / `UNKNOWN` | none | dropped (9.8.4) |
| dead debug filter term `session_ticket_used` | none | not ported |

### 9.10 New in the latest drafts that this subsystem should surface

1. **Supported-format statement.** main-14 §13 says tools "MUST indicate" which schemas, serialization
   formats and compression methods they support. D19: append one sentence to the Option 2 help paragraph,
   after "No data is transfered to the server.": "Supported: qlog files following
   draft-ietf-quic-qlog-main-schema-14 (.qlog, file_schema urn:ietf:params:qlog:file:contained; .sqlog,
   urn:ietf:params:qlog:file:sequential; optionally gzip-compressed) with QUIC (quic-events-13) and HTTP/3
   (h3-events-13) events." The rest of the help text stays verbatim (2.5).
2. **`file_schema` and `serialization_format`** become the values of `group.version` / `group.format`
   (Stats rows; data-model 3.16.12). Nothing new appears on the File Manager page itself (PARITY).
3. **`event_schemas`** (with their draft numbers) feed the export (9.6) and the Stats view; mismatches are
   info diagnostics only (main-schema digest P14).
4. **`TraceError.vantage_point`** becomes the vantage point of the "ERROR" placeholder connection.
5. **Sequential files are first-class** (streamed `.sqlog` is the main format of quic-go, quiche,
   neqo/Firefox and quinn), and compressed `.sqlog.gz` (quiche) / `.qlog.gz` (mvfst) are decompressed
   client-side (D10). `.sqlog.zst` (quiche) needs a small JavaScript zstd decoder (ecosystem open question 4;
   extend D10 if accepted).
6. **Compatibility notes** (T1 aliasing, for example "N events used the legacy prefix `transport:`") are
   data-model diagnostics, shown as at most one info toast after the load. The loaded-files list stays
   PARITY (no badge).
7. **Pass-through guarantee.** The loader, the truncation repair and the export must carry the following
   unchanged, without dropping or rewriting them: events of every namespace and type (new ones include
   `quic:tuple_assigned`, `quic:mtu_updated`, `quic:frames_created`, `quic:frames_parsed`,
   `quic:frames_processed`, `quic:packets_acked`, `quic:udp_datagrams_sent`, `quic:udp_datagrams_received`,
   `quic:udp_datagram_dropped`, `quic:stream_data_moved`, `quic:datagram_data_moved`,
   `quic:connection_data_blocked_updated`, `quic:stream_data_blocked_updated`,
   `quic:datagram_data_blocked_updated`, `quic:migration_state_updated`, `quic:ecn_state_updated`,
   `quic:connection_closed`, `http3:priority_updated`, `http3:datagram_created`, `http3:datagram_parsed`,
   `http:capsule_created`, `http:capsule_parsed`, `loglevel:*`, `simulation:*`); new frame types
   (`reset_stream_at`, `datagram`, `handshake_done`, extension frames such as `ack_frequency`); new
   top-level event members (`tuple`, `time_format`, `group_id`, `system_info`, per-event `reference_time`);
   and new `quic:recovery_metrics_updated` fields (`ssthresh`, `packets_in_flight`, `pacing_rate`,
   `pto_count`). main-14 §8.4 and §13: tools MUST NOT break on unknown fields. Visualizing them is the
   views' business, not this subsystem's.
8. **Optional NetLog enrichments (D18; off for v1, because qvis did not show them).** Each maps a NetLog
   event that qvis ignored onto an existing -13 event:
   - `QUIC_SESSION_CLOSED {details, from_peer, quic_error}` → `quic:connection_closed {initiator: from_peer
     ? "remote" : "local", internal_code: quic_error, reason: details}`, plus `connection_error: "no_error"`
     when `quic_error === 0`. -13's `internal_code` is the slot for implementation-internal codes such as
     Chromium's.
   - `QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET` → `quic:packet_buffered {trigger: "keys_unavailable"}`.
   - `QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED` → `{frame_type: "handshake_done"}` in the received
     packet's frames.
   - `QUIC_SESSION_CONNECTION_CLOSE_FRAME_RECEIVED` → the `_SENT` frame mapping, into the rx frames.
   - ACK `delta_time_largest_observed_us` → `ack_delay` in ms.
   - `QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET` → `trigger: "key_unavailable"`.

   Not proposed, because they would require guessing Chromium semantics: `transmission_type` →
   `quic:packet_sent.trigger`, and `QUIC_SESSION` → `quic:connection_started` (NetLog has a host name, not
   addresses).

### 9.11 Latest-draft names this subsystem reads or writes

- **Reads (envelope):** `file_schema`, `serialization_format`, `title`, `description`, `traces[]`, `trace`
  (TraceSeq), `traces[i].error_description` / `uri` / `vantage_point` (TraceError),
  `traces[i].event_schemas`, `traces[i].common_fields` (`time_format` and `reference_time` for the export
  rewrite; `group_id`), `traces[i].vantage_point`, event object boundaries (repair), `group_id`; the legacy
  markers `qlog_version`, `qlog_format` and `event_fields` only in order to reject; NetLog
  `constants.logEventTypes` and `events`; tshark `[0]._source.layers`.
- **Writes (converters, demos, export):** `quic:parameters_set`, `quic:packet_sent`, `quic:packet_received`,
  `quic:packet_lost`, `quic:packet_dropped`, `http3:stream_type_set`, `http3:parameters_set`,
  `http3:frame_created`, `http3:frame_parsed`, `loglevel:info` (NetLog); additionally
  `quic:connection_started`, `quic:version_information`, `quic:connection_id_updated`,
  `quic:connection_state_updated`, `quic:spin_bit_updated`, `quic:alpn_information`,
  `quic:udp_datagrams_sent`, `quic:udp_datagrams_received`, `quic:recovery_metrics_updated`,
  `quic:congestion_state_updated` (demos); optionally (D18) `quic:connection_closed` and
  `quic:packet_buffered`. The export writes whatever was loaded (D14).

### 9.12 Decisions added by this section

| id | decision | recommendation |
|---|---|---|
| D14 | Export event names and data | the normalized view (canonical name, fixed-up data) where an alias or fix-up applied; the raw object otherwise |
| D15 | Export title of `group_id` slices | the raw trace title while the label is loader-generated (round-trip stable); renamed titles as is |
| D16 | Export top-level custom keys | keep, except `qlog_version`, `qlog_format`, `summary` and the keys the export sets itself |
| D17 | JSON-SEQ without a header record; concatenated `.sqlog` files | synthesize the header with a warning; a later header record starts a new trace |
| D18 | NetLog converter enrichments beyond qvis | off for v1 (parity); list in 9.10 item 8. The padding byte count (9.8.1) is recommended regardless. |
| D19 | Supported-format statement (main-14 §13 MUST) | add one sentence to the Option 2 help text |
| D20 | Demo events `ALPN_update` and `custom_cc_application_limited` | `quic:alpn_information` and `quic:congestion_state_updated {new: "application_limited"}` |

### 9.13 Tests to add (extends 8.8)

- Detection: a quic-go header (`file_schema` plus a trailing `qlog_version: "0.3"`) loads; a quiche/neqo
  header with `serialization_format: "JSON-SEQ"` loads; an mvfst file with `file_schema` after `traces`
  loads; a 0.3 contained file is rejected by the fast path without a full parse; `qlog_format` without
  `qlog_version` gives X1; `traces` plus `event_fields` without `file_schema` gives X1; `traces` without
  `file_schema` loads with a warning; an unknown `file_schema` gives X2; a JSON-SEQ file whose first record
  is an event loads with `seq.missing-header`.
- Repair: a cut inside `data.frames` of the last event drops that event although `time`, `name` and `data`
  exist; a syntax error inside an event in the middle of the file keeps the events before it and nothing
  after it; a cut inside `common_fields.reference_time` before `events` gives one trace with zero events and
  a warning; a complete root followed by garbage loads without X4.
- Export: a `relative_to_previous_event` trace split into two `group_id` slices round-trips to the same
  resolved times; rewritten traces carry no per-event `time_format` / `reference_time`; `event_schemas`
  derivation gives `quic-13` / `http3-13` / `loglevel`; slice titles round-trip without a double prefix
  (D15); the "No VantagePoint set" default is not written; `qlog_version`, `qlog_format`, `summary` and
  `configuration` never appear; the loaded raw objects are unchanged after an export.
- NetLog converter: a golden file per row of 9.8.1, including the `calculateAckRanges` vectors, `quic_error`
  0 → `no_error`, the `PACKET_LOST` type lookup and the final rx-frame flush.
- Demo conversion: every converted demo passes the strict T0 checks (no alias needed, no diagnostic above
  info), and the two doublevantage traces keep their 100 ms epoch offset.

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`). Where this addendum contradicts the body, **this addendum wins**.
It aligns the body with `docs/dev/ARCHITECTURE.md` (binding) and with the owners of the topics involved.

### F1. No aliasing (G1)

- §9 intro: "Event-name aliasing ... belong to the data model" is void. Nothing aliases names or fixes up data
  (ARCHITECTURE §3.1; data-model §9.1 rule 2). The loader's job, letting such files through unmodified, is
  unchanged.
- §9.1 tier T1, "Loader action": "load unchanged; the data model flags non-conforming names (DM3) and legacy members
  (DM2)". The views do not interpret pre-final names (`transport:`, `recovery:`, `security:`).
- §9.8.2 rationale for private TCP namespaces: `transport:*` would not be rewritten. It would be flagged as
  non-conforming (DM3), and the QUIC views would ignore it. The rule itself (use `tcp:`, `tls:`, `http2:`) stands.
- §9.10 item 6: "Compatibility notes (T1 aliasing ...)" becomes "DM2/DM3 toasts (data-model §6.3)".
- **D14 resolved:** the export always emits `ev.raw` (the event "as logged"). The "normalized view" branch is never
  taken, because `fullName === loggedName` and `data === raw.data` always hold.
- §9.13 last bullet: "every converted demo passes the strict T0 checks (no alias needed ...)" now applies to the
  generated demos (F2).

### F2. Demo data (G4, G5): supersedes §8.7 and §9.8.4

ARCHITECTURE §0/§2 is binding and is implemented in `src/loading/demo.ts`:

- Option 3 loads every entry of `public/examples/index.json`. Option 4 loads `public/examples/massive/index.json`.
- Manifest: an array of `{file, title?, description?, size? (bytes, or a ready label such as "<1MB")}`, with `file`
  relative to the manifest's folder.
- Display filename: `demoFilename()` = `DEMO_` + basename (unless it already starts with `DEMO_`), plus
  `" (" + sizeLabel + ")"`. The massive one uses the `MASSIVE_DEMO_` prefix. The button label comes from the massive
  entry's size (D13, fallback "Load 31MB .qlog file").
- The demos are generated by the patched quic-go harness (`tools/qloggen`), not converted from qvis's
  draft-00/01 files.

§8.7's offline conversion and §9.8.4's event and frame tables remain only as a mapping reference, for example for a
`scripts/latest-to-legacy.mjs` parity harness.

Content requirements for the generated demo set. These are normative for the generator: without them the views
show less than qvis did with its demos.

1. Only -13 names (`quic:`, `http3:`); `event_schemas` `["urn:ietf:params:qlog:events:quic-13",
   "urn:ietf:params:qlog:events:http3-13"]`; passes `scripts/validate-qlog.mjs` (CDDL); no DM2 or DM3 diagnostics.
   Raw quic-go output fails this: it uses `transport:*`/`recovery:*`/`security:*` and `…:quic-12`, and puts a
   non-conforming top-level `length` on STREAM/CRYPTO frames.
2. STREAM, CRYPTO and DATAGRAM data lengths in `raw.length` (quic-events-13 §8.13.7/§8.13.9), optionally also
   `raw.payload_length`. Packet events with `raw.length` and `raw.payload_length`.
3. HTTP/3 events, which raw quic-go output lacks entirely (0 `http3:*` events in `tests/fixtures/quic-go/*`):
   - `http3:frame_created` / `http3:frame_parsed` for HEADERS (`:method`, `:path`, `:authority`, `:status`, and a
     `priority` field on some requests), DATA (`frame.raw.payload_length`) and SETTINGS
   - `http3:stream_type_set` for the control and QPACK streams
   - `http3:parameters_set`

   These feed the multiplexing waterfall and detail line, the packetization HTTP/3 lane, the sequence diagram's
   HEADERS labels and the Stats "H3 connection headers" row.
4. `quic:stream_data_moved` (`from: "transport"`, `to: "application"`, `raw.length`) on the receiving side, for the
   byte-range "moved" rects.
5. `quic:recovery_metrics_updated` (`congestion_window`, `bytes_in_flight`, `smoothed_rtt`, `min_rtt`, `latest_rtt`),
   `quic:packet_lost`, `quic:parameters_set` with `initiator: "local"` and `"remote"` (`initial_max_data`,
   `initial_max_stream_data_*`), and ACK frames with `acked_ranges`. These feed the congestion graph and the Stats
   flow-control tables.
6. A multi-stream HTTP/3 demo whose basename starts with `DEMO_10_parallel_streams`, because the packetization info
   modal (packetization §2.3, verbatim) tells users to select that file. The modal text stays PARITY only if this
   holds.
7. One demo file with **both** the client and the server trace of the same connection (qvis
   `DEMO_double_vantagepoint`: a `traces` array of two). Prefer `reference_time {clock_type: "system", epoch: <real
   RFC 3339>}` on both, so the sequence diagram can align on absolute time (qvis relied on this; quic-go writes
   `monotonic`/`unknown`).
8. At least one demo with losses (for example a `loss2`/`loss5` scenario).
9. Optional, for parity with `DEMO_new_cid` / `DEMO_spin_bit`: `quic:connection_id_updated` and
   `quic:spin_bit_updated` events.
10. The massive demo: one large file, about 100 MB transferred (qvis: "a 100MB download", 31 MB qlog). Check the
    Vercel per-file static asset limits (§8.7).

### F3. Notification IDs (G6)

This spec's §6.1 IDs (N1-N15) are **canonical** for all loading toasts, and the implementation names its message
builders after them. `app-shell.md` §6.1 numbers the same toasts differently; its addendum A2 has the crosswalk.

### F4. Routing (G8): supersedes the routing bullets of §8.3

- No `createHashRouter`: ARCHITECTURE §0 removes react-router. The custom hash router is `src/app/router.ts`
  (app-shell §8.2).
- Pre-hash query: the router **copies** `location.search` into the hash route and **never strips** it (app-shell
  §3.3 rule 1, Q5 PRESERVE). Step 3's "move it into the hash route" therefore means copy.
- Duplicate keys: the first occurrence wins, both for the startup load and in the router (app-shell Q26, as
  implemented).

The `loadFromQueryParameters` / `loadSingleRemote` / `loadList` / `loadMulti` algorithms below the bullets are
unchanged.

### F5. Diagnostic toasts after a load (G9): amends §9.1 T1 and §9.10 item 6

data-model §6.3 is canonical. After the success toast (N5 / N11 / N14), show DM1, DM2 and DM3 as applicable:
`type: "warn"`, default duration, **at most one per kind per file** (so up to three), plain text. `info`-level
diagnostics only go to the console and to the Stats `Diagnostics` row.

### F6. Files without traces (G10)

§3.14 step 5 (reject `traces` absent or `[]` with "File contains no traces", code `file.no-traces`) is canonical and
implemented. data-model §9.2 and statistics §9.2 F7, which describe a zero-connection group, are amended to match.

## Addendum: same-data parity pass (2026-11-01)

Hosted qvis with the draft-02 conversions (`tests/fixtures/legacy/*.draft02.qlog`, copied to the same file names)
against qvis-react with the latest-draft originals, 1600 x 1000. Remote URLs were served through Playwright request
interception (CORS, no CORS, 404, network failure; qvis's `/loadfiles` and our `/api/loadfiles` either real or
intercepted). See also app-shell "Addendum: same-data parity pass" (A7/A8) for the toasts and the menu.

### F7. Fixed

- **Upload label overflow** (§2.5 corrected): Bootstrap 4.3.1's `.custom-file-label` has no overflow handling, and
  `.text-truncate` sits on the wrapper, whose only inline content is the hidden input. A long selection therefore runs
  on under the "Browse" segment and is clipped at the wrapper's edge; there is **no ellipsis**. The port padded the
  label to 5.5rem on the right and showed an ellipsis before "Browse"; it now renders like qvis.
- **BootstrapVue DOM of the control:** wrapper `div#fileUpload__BV_file_outer_.custom-file.b-form-file.<state>` (the
  state class on the wrapper too), `dragging` class on the label (was on the wrapper).

### F8. Same-data results (no change needed)

Identical text, colour, position (bottom centre, 790 px wide at 1600 px) and order of every toast, and identical
loaded-files rows (name, shorthand, link text and href, row geometry), for: upload of each demo, of two files at once,
of a `.txt` file alone or with a `.qlog` (N3, nothing loaded), of invalid JSON / HTML / an empty file (N4 then N6);
Option 1 with a CORS-enabled URL, without CORS (direct fetch fails, proxy fallback) and with a 404; `?file=` on the
hash, before the hash (`?file=x#/files?file=x`, the pre-hash query is kept), with a URL longer than 50 characters
(`https://qlogs.example.tes.../new_cid.qlog`), and `?file1=&file2=` (`Loaded via URL (<file1> etc.)`); Option 3 twice
(N7). The sticky query survives every tab switch in both apps.

Intended differences seen on the same data:

| Difference | Reason |
|---|---|
| N6 / N12 / N15 carry one more line with the error message (e.g. `File is empty`, `The file could not be downloaded directly (HTTP 404) and the qvis CORS proxy is not available (HTTP 500).`) | §6.2 last paragraph |
| A partial JSON object without traces (`{"qlog_version": "draft-02", <garbage>`): qvis shows N4 + **N5 "Uploaded file"**, adds nothing and throws a Vuex page error; qvis-react shows N6 + `File contains no traces` | §6.3 empty file row, F6 |
| A truncated file loads in both (same group, "(2 connections)"); qvis-react also shows X4 with the recovered event count | X4, §9.5 step 5 |
| Option 1 pcap URL: X6 instead of N1 / a backend error | D1 |
| The dev server has no `/api/loadfiles` (Vite answers 500): the fallback ends in N12 + "... proxy is not available (HTTP 500)." (unit-tested in `urlLoader.test.ts`); with the proxy answering, the file loads exactly as qvis's `/loadfiles` fallback | ARCHITECTURE §0, A3 |
| Group links open in a new tab (`target="_blank" rel="noopener noreferrer"`) | Q3 |
| Download: `new_cid.qlog` (qvis `_new_cid.qlog` for URL loads), latest-draft content | Q13, D14 |
| Demo toasts and rows name the generated demos (`DEMO_new_cid.qlog (<1MB)` from `/examples/new_cid.qlog`; qvis `standalone_data/draft-01/...`); Option 4 reads "Load 28MB .sqlog file" | G4, F2, D13 |

Resolved at the final integration (app-shell A9): Option 4's help text said "a single qlog file representing a 100MB
download", while the generated massive demo is a 50 MB download (manifest `massive/index.json`); the size now comes
from the manifest (D13), as the button label does.

## Addendum: security review (2026-11-01)

Security FIXes (qvis had none of these limits). The XSS and prototype-pollution review found no injection; the
details are in `docs/dev/STATUS.md` ("Security review").

### F9. Proxy abuse controls (amends §8.6)

`/api/loadfiles` still answers with `Access-Control-Allow-Origin: *` (§8.6), but browsers may use it only from the
app's own origin: `Sec-Fetch-Site` `same-site`/`cross-site`, or (without fetch metadata) an `Origin` other than the
deployment's, gets 403 unless `QVIS_PROXY_ALLOW_ORIGINS` lists the origin (`*` = any). `Sec-Fetch-Dest` other than
`empty` (navigations, image/script/frame loads) gets 403, and every response carries
`Cross-Origin-Resource-Policy: same-origin`. Requests carrying the proxy's own User-Agent get 508 (no nested proxy
chains). Target ports on the Fetch standard's bad-port list get 400 (first URL and every redirect hop). IPv4-translated
IPv6 addresses (`::ffff:0:0/96`) are blocked like their IPv4 address. Unit tests:
`src/lib/loadfilesProxy.security.test.ts`. Rate limiting is deployment configuration (Vercel Firewall rule), not code.

### F10. Client-side limits (amends §3.8, §3.14 step 2)

- `?list=` and `?file1..N=` load at most `MAX_LIST_CAPTURES` = 100 files; a longer list fails with N12 + "The list
  contains <n> files; qvis loads at most 100 files from one list" before anything is fetched. At most
  `LIST_CONCURRENCY` = 6 captures are fetched at once (`settleLimited`); traces stay in list order. Before, one shared
  link with 500 entries made every visitor's browser start 500 fetches plus 500 proxy calls at once.
- gzip/brotli decompression stops at `MAX_DECOMPRESSED_BYTES` = 512 MiB ("Could not decompress gzip data: The
  decompressed file is larger than 512 MB"), checked per level of a double-gzip file. A 1.8 KB double-gzip bomb
  inflated to 1 GiB in about a second (a few KB more would mean many GiB). V8 cannot hold a longer string, so qvis
  could not parse a larger contained file either; the largest demo is about 50 MB.
- Download keeps own `"__proto__"` members of the root and the traces as data (they were silently dropped).
