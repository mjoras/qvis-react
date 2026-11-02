# qvis-react status

State at release (2026-11-01). qvis-react is a 1:1 port of qvis that reads only the latest qlog drafts
(main-schema-14, quic-events-13, h3-events-13). This page lists, per view, what works, where it deliberately differs
from qvis, and what is still open. The parity specs (`docs/dev/parity/*.md`) give the full reasoning for each FIX;
`ARCHITECTURE.md` is the implementation contract.

## Quality gates

All green: `npm run typecheck`, `npm run lint`, `npm test` (1560 unit tests, 2 skipped without `CDDL_BIN`),
`npm run build`, `npm run e2e` (64 Playwright tests, also stable with `--repeat-each 2`: 128 of 128).

The e2e suite needs no network: Chromium runs with a host-resolver rule that fails every host except localhost, fake
remote URLs go through `page.route()`, and the hosted-qvis comparison in the suite (multiplexing golden test) replays
committed golden data.

## How parity was checked

Each view was ported line by line from the qvis source, then reviewed by a second agent against the source, the parity
spec and hosted qvis (https://qvis.quictools.info). The decisive check uses the same data in both apps: the demo
connections converted to draft-02 (`tests/fixtures/legacy/*.draft02.qlog`) in hosted qvis, the latest-draft originals
(`public/examples/*`) in qvis-react, same viewport (1600 x 1000), same selections, usually uploaded under the same file
name so selector texts match. Before release one agent per view repeated that comparison in depth (DOM and computed
style dumps, element boxes, pixel diffs, tooltips, every gesture, console output in both apps), fixed every real
difference with a regression test, and recorded the result in its spec. Differences caused by the draft-02 conversion
or by hosted qvis's own bugs are not counted.

| View | Same-data result (final pass) | Fixed in the final pass | Intended differences (FIX ids) |
|---|---|---|---|
| File manager / shell | Identical text, layout and pixels for all five Options; toast text, colour, position, order, timing; URL loading (CORS, no CORS, 404, pre-hash `?file=`, `?list=`, `?file1=&file2=`); menu states | Bootstrap 4.3.1 button focus look app-wide, menu tab box model and keyboard focus, toast fade/slide timings and DOM, upload label overflow, `#/debug` event types, address bar re-encoded like vue-router, Option 4 help text names the real demo size (app-shell A7, A9; file-loading F7) | D1/D6 Option 1 sentence, D13 Option 4 label/size, Q1, Q3, Q4, Q11, Q14, Q18, Q20, Q22, Q25 (app-shell A8) |
| Sequence | `forceFull` SVG dumps identical for all 5 demos; virtualized range counts identical at every scroll position (also the 145k-event massive trace); modal, configurator, alerts, narrow windows identical; deep links land on the same scrollY as qvis in all 13 tested cases | Deep-link landing after a URL load (qvis's "Loading files..." alert and Chrome scroll anchoring, S8); "Add trace" focus ring and the two configurator tooltips (shell) | SQ1 pair instead of GENERATED mirror, SQ3, SQ4 offset sign, SQ6, SQ12, SQ13, SQ14, SQ18 `cwnd:` chips, latest names (`key_discarded`), Q18 deep link (sequence S9) |
| Congestion | Main and RTT canvases pixel-identical in all 12 demo traces, initially and after every zoom, pan, brush, reset and toggle (zero-valued metrics removed from the input, see Q2); ticks, tooltips, ack arrows, ruler, legends and layout identical | RTT-zoom axis domain, ruler on whole pixels, right axis after a resize, button tooltip flip, geometry, font and 50 ms timing, focus ring (congestion §10) | Q2 bytes-in-flight drawn down to 0, Q11 `CWND:` in client tooltips, Q19 plot 10 px narrower |
| Multiplexing | DOM dumps identical at device pixel ratio 1 and 2, unzoomed and zoomed; tooltips of about 9,000 frames, detail lines and byte-range charts identical; all gestures, both checkboxes, multi-trace mode | Axes 0.5 px off on retina screens (d3-axis v3 offset), ctrl+wheel/pinch no longer zooms (d3-zoom v1 filter), button focus look; tooltip times now rounded to 1 ns, so they match qvis digit for digit (M22 revised) | M3, M4, M8, M10 legend "Request sent", M11, M17, Q11 (multiplexing X4) |
| Packetization | Lanes, colours, axes, labels, tooltips, zoom state and modal identical where qvis does not hit its own Q-F3 bug | Focus ring on "More info on this tool" and the modal's Close | Q-P1 packet sizes (and qvis's resulting Q-F3 losses: efficiency 86.61% in qvis vs 96.22% on the 10-stream client), Q-H3, Q-M1, Q-R1, D-PZ1 help bullets, D-PZ3, D-PZ4, re-layout on resize (packetization §10) |
| Stats | Every count equal in all 8 scenarios (incl. the TCP demo); boxes and styles equal; full-page pixel diffs 0 for all QUIC demos with the new rows masked; flow-control console series equal | Label glyph shifts (one text node per label, D1), bars animate on a file switch like qvis (position-based row keys, D2) | Added rows (Title, Serialization format, Diagnostics, Event schemas, QUIC version, ALPN), S12, Events histogram grouped by latest namespace (§9.4.1), Q1/Q3-Q9/Q19 (statistics §10) |

Quirks of hosted qvis or of the draft-02 conversion, not counted as differences (details in the specs and the legacy
converter report): packetization "max receiving size" 65527 in qvis (it cannot read draft-02 `max_udp_payload_size`)
vs 1452; exact frame edges in qvis for a packet's single unlogged frame (the converter derives its size); hosted qvis
cannot draw its own TCP demo (undefined sizes, endless loop), so TCP mode was checked against the converter goldens
instead; qvis's TypeErrors on early congestion button clicks and brushes (Q8, Q10).

Screenshots of the integration run: `tests/e2e/all-views.spec.ts` writes one per view (set `QVIS_SCREENSHOT_DIR`).

## Security review

Reviewed before release; all findings fixed, each with a test that fails without the fix.

- **XSS:** none found. Payloads in about 35 fields (titles, vantage points, group ids, event names, frame types,
  header names, ALPN, TraceError descriptions, list descriptions, upload file names, netlog files) through every view,
  selector option, tooltip, the modal and the download: no script ran, no `on*` attribute or `javascript:` link
  appeared. React and D3 `.text()` render data as text; the one `.html()` sink (packetization tooltip) escapes every
  value; file-list links pass `safeHref`.
- **Content-Security-Policy** (`vercel.json`, every path except the proxy): scripts only from the app's origin,
  `object-src 'none'`, `base-uri`/`form-action 'self'`. The production build runs every view under it without
  violations. Framing stays allowed, as in qvis (no logins or sensitive actions).
- **`/api/loadfiles` proxy:** browsers may use it only from the app's own origin (403 otherwise, unless
  `QVIS_PROXY_ALLOW_ORIGINS`); navigations and image/script/frame loads get 403 and responses carry
  `Cross-Origin-Resource-Policy: same-origin`; nested proxy chains stop after one hop (508); Fetch-standard bad ports
  get 400; IPv4-translated IPv6 addresses are blocked by the SSRF guard. Tests: `src/lib/loadfilesProxy.security.test.ts`.
- **Client-side abuse limits** (file-loading F10): one `?list=` / `?fileN=` link loads at most 100 files, 6 at a time
  (a 500-entry list used to start 500 fetches plus 500 proxy calls at once; now it is rejected before any fetch);
  gzip/brotli decompression stops at 512 MiB (a 1.8 KB double-gzip file used to inflate to 1 GiB; now it fails in
  about 0.4 s with "The decompressed file is larger than 512 MB"). Both re-checked in the browser against the dev
  server.
- **`__proto__` members:** kept as data in the parser (JSON-SEQ header and trace, contained single `trace`), the
  netlog converter (encryption levels, transport parameters, settings) and the download export; `Object.prototype`
  is never touched.
- **Open (deployment configuration, not code):** the proxy has no rate limit of its own, so scripts outside a browser
  can use it as a GET proxy (128 MB / 60 s per request). Add a Vercel Firewall rate-limit rule for `/api/loadfiles` on
  a public deployment (README "Deploying").

## App shell, file loading, converters

**Works.** Hash router with qvis URL semantics (pre-hash `?file=` migration, sticky query, hash re-encoded like
vue-router), main menu, toasts (vue-notification look and timing), file manager Options 1-5, upload (`.qlog`,
`.sqlog`, `.json`, `.netlog`, gz/br), URL loading with CORS-proxy fallback (`/api/loadfiles`), demo loading (Option 3:
5 generated quic-go demos, Option 4: 28 MB massive trace of a 50 MB download), export/download, the hidden `#/debug`
page. Strict parser: legacy files are rejected (X1), files with pre-final event names load with the DM3 warning. Chrome
netlog and tshark JSON (TCP/TLS/HTTP2) converters emit latest-draft-shaped qlog; their output was compared with hosted
qvis on the same inputs.

**Deviations (intended).**
- Bootstrap 5.3 with Bootstrap 4.3.1 parity overrides (`src/styles/global.css`): body font stack, list indent, modal
  frame, no tab colour transition, colours, spacing, button focus ring on any `:focus`, hover tooltips (`.qvis-tooltip`).
- Converters: T1+T2 mappings by default; T3 ("extended mappings") only via the `#/debug` checkbox (C2). Files without
  a QUIC session / TCP connection are rejected with an explanatory error toast (G10). Frame-level Chromium extension
  keys are not emitted (they would be CDDL-invalid; converters spec §10).
- A trace without `vantage_point` reads `unknown : …` in a `.sqlog` and `No VantagePoint set : unknown (flow =
  unknown) : …` in a `.qlog`. qvis did the same (its JSON-SEQ converter injected `{type: "unknown"}`), so it stays.
- A listed `event_schemas` entry without events is not reported (main-schema-14 allows it; quic-go lists `loglevel`
  in every trace, which put an info line in the Stats Diagnostics row of every demo).

**Open.**
- Below about 800 px the menu's "Request feature"/"Report issue" buttons overflow and the page scrolls sideways
  (hosted qvis does the same).
- `pcap`/`pcapng` need a backend (`VITE_PCAP_BACKEND_URL`); none is deployed.
- The private TCP/TLS/HTTP2 CDDL (`src/converters/tshark/tcp-tls-http2.cddl`) is not part of
  `scripts/validate-qlog.mjs`, which stays draft-only.
- Invisible DOM differences in the shared `ConnectionConfigurator`: Bootstrap 5 `.col` divs are `position: static`
  (4.3.1: `relative`), the select is `display: block` (4.3.1 `custom-select`: `inline-block`) and its margins collapse
  through the wrapper divs. Every visible box is identical (pixel diffs 0), so this was left alone.
- The proxy also runs outside Vercel: in `npm run dev` / `npm run preview` (Vite plugin `server/vite-plugin.ts`) and
  in the local server (`npm start`, `server/local-server.ts`), which also applies the `vercel.json` headers. Both use
  the unchanged `api/loadfiles.ts`, so its SSRF guard and caller policy hold locally too. Both local modes drop forged
  `X-Forwarded-*` headers (they are their own edge) and also refuse this machine's own addresses and known cloud
  metadata endpoints as proxy targets (`server/policy.ts`). The local server adds a Host-header allowlist (DNS
  rebinding; dev/preview rely on Vite's `allowedHosts`) and the opt-in `--allow-private` (this computer and private
  networks as targets; loopback bind only; same-origin fetches only; link-local and metadata addresses stay blocked).
  The e2e suite sets `QVIS_PROXY_ALLOW_HOSTS=e2e.invalid` for the dev server, so its proxy fetches nothing.
- Not verified on real hardware: Windows (covered by the CI GitHub Actions workflow on windows-latest,
  including the README commands in Windows PowerShell 5.1 and PowerShell 7), the Docker image (built and smoke-tested
  only in that workflow, Linux amd64; Docker Desktop and arm64 untested).
- Known: a client that disconnects before the upstream answers does not cancel the upstream request (the handler in
  `api/loadfiles.ts` does not observe `request.signal`; it stops at its 60 s timeout). Left as is to keep the
  production function unchanged.

## Sequence diagram (`#/sequence`)

**Works.** Configurator (one selector per column, latency offset, Add trace / −, time multiplier, alerts), automatic
client+server pairing and latency offset, GENERATED mirror for a single trace, arrows with frame chips and qvis's
aggregation, half arrow + red X for lost packets, inactivity markers, side labels, virtualized range rendering (only
the ranges around the viewport are in the DOM; after long jumps up to about 10 range groups stay, exactly as in qvis
(SQ29); 145k-event massive trace in about 1 s), event modal (raw JSON, deep link, recovery metrics fold), URL
parameters `focusOnConnection`/`focusOnEvent`, `focusOnPN`, `forceFull` (deep links land on the same scroll position
as qvis, S8). TCP traces from the tshark converter draw arrows (`transportNamespace`), HTTP/2 frames get the HTTP/3
label and colour.

**Deviations.** All spec FIXes (SQ1, SQ3-14, SQ18-20, SQ24-27, SQ35, LD2-LD7, X1, X2), notably the corrected offset
sign (SQ4) and scroll-independent lost-arrow slants (SQ12). Data diagnostics use `console.warn`. Duplicate traces after
"Add trace" are drawn once and the extra selector stays (SQ6 not written back, which would undo "Add trace").
Pre-final events are drawn as plain red/white chips without arrows. The drawing is cleared when the selected file is
removed. Full list of what the same-data check found: sequence spec S9.

**Open.** No re-layout on window resize (SQ21, as qvis). Extension proposals X3-X14 not implemented (EXT-OFF).

## Congestion graph (`#/congestion`)

**Works.** Axes SVG + canvas plots, step lines with markers, right congestion axis, RTT graph, cursor-anchored wheel
zoom with y auto-fit, pan, Zoom timerange, Zoom area, Reset zoom, Toggle congestion info, Toggle RTT zooming, ruler
(button and R key), pixel-colour hover tooltips, button tooltips (qvis's delay, flip, geometry and font),
device-pixel-ratio canvases, resize re-layout (including the right axis), notices for traces without usable data
(Q41). Canvases pixel-identical to hosted qvis on all demo traces.

**Deviations.** Q1-Q4, Q8-Q12, Q14, Q16-Q19, Q25, Q26, Q30, Q33, Q34, Q37, Q39-Q41, Q44 FIXes: per-connection start
offset, zero bytes-in-flight drawn, PN-space keys, no exceptions from brushes or early button clicks, loss tooltip
shows the sent size, plot sized from its host (10 px narrower than qvis at the same window width). Ruler text 14 px
(what hosted qvis renders; the spec first said 16 px). Above 50k packets rectangles and markers are batched per colour
(faster, anti-aliased edges may differ slightly). The RTT-zoom axis uses the values before the window only when the
window has no RTT sample (Q4 clarified).

**Open.** Hover picking is qvis's exact-colour method, so at full zoom-out some thin ACK columns show no tooltip (same
in qvis). Optional `aria-pressed` on the toggles not added.

## Multiplexing graph (`#/multiplexing`)

**Works.** Waterfall, multiplexed data-flow strip, byte ranges per STREAM frame, tooltips, waterfall click (stream
details line), strip click, wheel zoom, drag pan, double-click zoom, "Show waterfall"/"Show byte ranges" checkboxes,
multi-trace mode ("Load all connections at once", shown for `?multimultiplexing`, `localhost` or `:8080` as in qvis),
unknown-vantage-point guess (D-MX2), `quic:stream_data_moved`, HTTP/3 PRIORITY_UPDATE triangles. A golden e2e test
replays fixed gestures and compares the SVG tree with a capture from hosted qvis; further e2e tests cover device pixel
ratio 2 and ctrl+wheel.

**Deviations.** M3, M4, M5, M8, M10, M11, M17, M20-M22, M27, M32, M35, M36 FIXes and D-MX1/2/3 (e.g. legend "Request
sent"/"Request received", byte ranges work again after toggling, finite y axis fallback). Tooltip times are rounded to
1 ns (M22 revised: no float noise, otherwise qvis's digits). STREAM length only from `raw.payload_length`/`raw.length`.
Charts render synchronously (no 100 ms timeout).

**Open.** No resize handling (M28, as qvis). Multi-trace mode renders all panels in one go. No demo file contains an
HTTP/3 PRIORITY_UPDATE frame (only the hand-written fixture), see multiplexing spec §9.9 and `tools/qloggen`.

## Packetization diagram (`#/packetization`)

**Works.** Both directions (QUIC packets, frames, HTTP/3 frames, stream IDs lanes), efficiency and max receiving size
labels, tooltips, wheel zoom and drag pan, trace switching, "More info on this tool" modal (Close, ×, Esc, backdrop),
TCP+TLS+HTTP/2 mode for tshark-converted traces (golden numbers of converters §3.13 match exactly), large-trace toast
(N-PZ1) and error toasts. The pre-processor output was compared range by range with qvis's own pre-processor (FIXes
patched in) on all demo connections: identical.

**Deviations.** Q-P1/Q-P2, Q-F1..F5, Q-H1..H4 FIXes (correct payload accounting, PRIORITY_UPDATE varint size, frame
sizes from the latest `raw` members), D-PZ2 computed STREAM/CRYPTO/DATAGRAM headers, D-PZ4 note for an empty
direction, all diagnostics as `console.warn`, re-layout on resize (debounced), the info modal's two list paragraphs are
`div`s (React rejects `ul` in `p`; same pixels).

**Open.** The massive trace takes about 2-5 s to render (N-PZ1 toast warns); zooming it is slow (same algorithm as
qvis). Retransmitted STREAM data produces qvis's documented leftover warnings (E14). Optional ENH-1..9 not
implemented. Data-model `framesForPacket` (N3) does not exist; the pre-processor builds its own frame index.
Decision pending (see below): the size of a packet's single unlogged frame.

## Statistics (`#/stats`)

**Works.** File selector with auto-selection, File info table, one "Trace N info" section per real trace: vantage
point, H3 connection headers, event histogram with bootstrap-vue progress bars (animated on a file switch like qvis),
frames table, encryption levels, connection- and stream-level flow control (plus qvis's console series via
`console.debug`). Computed styles and pixels match hosted qvis.

**Deviations.** Q1, Q3-Q9, Q19 FIXes (Title row shows, header values rendered as text, no NaN rows, tables shown when
data exists). Summary row removed (S12); added rows Serialization format, Diagnostics, Event schemas, QUIC version,
ALPN. Strict names: events with pre-final names are listed in the Events histogram but not counted as frames or
packet types (statistics spec S16 as revised). S20 superseded: TLS records keep `packet_type` (converters C9), so the
TCP demo shows `1RTT 283` as in qvis.

**Open.** Decision pending (see below): the Events histogram grouping.

## Decisions left for the maintainer

- **Stats Events histogram grouping.** qvis grouped QUIC events into connectivity / transport / recovery / security;
  the latest drafts put them all under `quic`, so qvis-react shows one `quic` cell spanning 16+ rows in first-seen
  order. Counts and bars are identical, but the table is harder to scan. A presentation-only regrouping by the
  pre-final categories would be possible.
- **Packetization: a packet's single unlogged frame.** qvis-react keeps qvis's guess (Q-F6 PRESERVE: 50/50 ACK/PADDING
  split in Initial packets, small yellow fillers, negative CRYPTO headers). Giving the one frame without a known size
  `payloadLength` minus the others (an ENH in `renderer/quicFrameSizes.ts`) would look better and would match what
  hosted qvis shows for the converted demos, but changes Q-F6, the spec 3.6.11 worked example and its tests.
- **Proxy rate limit:** a Vercel Firewall rule for `/api/loadfiles` (deployment setting).

## Cross-cutting open items

- Shared helpers: HTTP/3 field/frame helpers now live in `src/qlog/schema/h3.ts`. Remaining local helpers that could
  be shared: `u64` variants (multiplexing, packetization, converters) and STREAM length (`streamFrameDataLength`,
  `frameDataLength`).
- The loader could flag non-conforming events once (`QlogEvent`) so Stats and the sequence diagram need not recompute
  `isNonconformingName`.
- Demo generation: add a scenario with HTTP/3 priorities (PRIORITY_UPDATE) to `tools/qloggen`. qvis's massive demo was
  about a 100 MB transfer; ours is 50 MB (the Option 4 text now says so).
