# Parity spec: converters (Chrome netlog → qlog, tshark JSON TCP/TLS/HTTP2 → qlog)

Subsystem: `src/components/filemanager/netlogconverter/*` and `src/components/filemanager/pcapconverter/*`, plus the
code that routes files into them and the code that consumes their output.

All qvis paths are relative to `qvis/visualizations/` at commit `3db6acf` (same checkout as `file-loading.md`).
`path:N` means a line in that file. This document replaces reading the converter source. Where it says
"verbatim", copy the string character for character.

Files read completely:

| File | Lines | Role |
|---|---|---|
| `src/components/filemanager/netlogconverter/netlog.ts` | 195 | netlog TypeScript shapes (params per event) |
| `src/components/filemanager/netlogconverter/netlogtoqlog.ts` | 894 | `NetlogToQlog.convert` (emits qlog `draft-01`) |
| `src/components/filemanager/pcapconverter/tcptoqlog.ts` | 699 | `TCPToQlog.convert` (emits qlog `draft-02-wip`) |
| `src/components/filemanager/pcapconverter/qlog_tcp_tls_h2.ts` | 193 | qvis-private TCP/TLS/HTTP2 "schema" |
| `src/components/filemanager/data/FileLoader.ts` | 313 | detection and routing into converters |
| `src/components/filemanager/utils/StreamingJSONParser.ts` | 309 | `parseJSONWithDeduplication` for tshark JSON |
| `src/components/packetizationdiagram/renderer/PacketizationTCPPreProcessor.ts` | 430 | the main consumer of TCP output |
| `src/components/packetizationdiagram/renderer/PacketizationDiagramModels.ts` | 202 | `extractRanges` |
| `public/standalone_data/tcp/wikipedia_Playstation.json` | 4.9 MB | only TCP example input (inspected with scripts) |

Read in part: `FileManagerContainer.vue`, `store/ConnectionStore.ts`, `data/QlogLoader.ts` (`fromDraft01`,
`fromDraft02`, `fix02Compatibility`, `EventFieldsParser`), `data/QlogSchemaConverter.ts`, `data/Connection.ts`,
`data/ConnectionGroup.ts`, `data/QlogSchema02.ts` (enums), `PacketizationDiagramD3Renderer.ts`,
`PacketizationDiagramConfigurator.vue`, `shared/helpers/ColorHelper.ts`, `PacketizationQUICPreProcessor.ts`,
`SequenceDiagramD3Renderer.ts`, `CongestionGraphD3Renderer.ts`, `StatisticsConnectionRenderer.vue` (the parts that
see converter output). Also: `pcap2qlog/README.md` and its structure, `qvis-server/src/controllers/FileFetchController.ts`
(netlog parts), and the current Chromium sources `net/quic/quic_event_logger.cc` and `net/quic/quic_http3_logger.cc`
(fetched 2026-11-01) for today's netlog parameter names.

Related specs: `ARCHITECTURE.md` (§0 fixes the product decisions used here: both converters are ported, QUIC/H3
output uses `quic:`/`http3:`, TCP output uses private `tcp:`/`tls:`/`http2:` namespaces), `file-loading.md` (§3.4
detection, §3.6 dedup parser, §8.9 D4/D5 are superseded by ARCHITECTURE §0), `data-model.md` (§3.16.3 time cases,
§3.16.6 `protocolHint`, §4.2 type-only name checks), `qlog-spec/*.md` (latest-draft digests).

Labels used below:

- **PARITY**: reproduce exactly.
- **FIX**: qvis behaviour is a bug; do it differently (the new behaviour is given).
- **NEW**: needed because the output format changes to the latest drafts.
- **T1 / T2 / T3** (converter mapping tiers, section 8.2): T1 = the qvis mapping, T2 = safe fixes enabled by
  default, T3 = extra mappings qvis never produced, behind an option that defaults to off.

---

## 1. Overview and user-facing purpose

qvis visualizes qlog. Two non-qlog inputs are converted into qlog in the browser so that the normal
visualizations can show them:

| Converter | Input | qvis output | Main consumers |
|---|---|---|---|
| `NetlogToQlog` | Chrome NetLog JSON from `chrome://net-export` (`.netlog`, or `.json` sniffed by content) | qlog `"draft-01"` with `event_fields` arrays, one trace per Chrome `QUIC_SESSION` source, category/event names `transport:*`, `recovery:*`, `http:*`, `info:marker` | every QUIC view: sequence diagram, congestion graph, multiplexing, packetization (QUIC path), stats |
| `TCPToQlog` | tshark/Wireshark "JSON" export (`tshark -T json`, ideally of a TLS-decrypted capture so HTTP/2 is dissected) | qlog `"draft-02-wip"` with `event_fields`, one trace per TCP connection, categories `transport` (TCP packets), `tls`, `http2` | the packetization diagram's TCP path (`PacketizationTCPPreProcessor`); incidentally the QUIC views (section 3.12) |

What the user sees: they upload or link a netlog or tshark JSON exactly like a qlog. The file appears in the file
list as one group. Each converted connection becomes a selectable trace. For netlog, the trace title is
`<host>-<connection_id>`. For tshark, it is `<client ip>:<port> -> <server ip>:<port> => <:authority> @ <n> TLS trailer size`.
The packetization diagram then shows TCP / TLS / HTTP/2 / stream lanes for TCP traces (its info modal advertises
this: "Also usable for TCP + TLS + HTTP/2").

What `pcap2qlog` is (and is not): it is the **server-side** QUIC pipeline (`tshark --no-duplicate-keys -r x.pcap -T json -o tls.keylog_file:x.keys`,
then `ParserPCAP.ts` turns the `quic` layers into `draft-02-wip` qlog with `protocol_type: "QUIC"`). It only
reads QUIC over UDP (`pcap2qlog/src/parsers/ParserPCAP.ts:97`, `:385-398`) and ignores TCP. The browser-side
`TCPToQlog` is a separate, much smaller converter for TCP+TLS+HTTP/2, written for the packetization diagram. Both
read the same tshark JSON dialect (`_source.layers.*`). qvis-react does not port pcap2qlog (ARCHITECTURE §0,
pcap row).

What changes in qvis-react (NEW, ARCHITECTURE §0): both converters are ported as pure TypeScript functions that
emit a **latest-draft** qlog object (`file_schema: "urn:ietf:params:qlog:file:contained"`, object events
`{time, name, data}`). The netlog output uses the standard `quic:` and `http3:` names from quic-events-13 /
h3-events-13. The TCP output uses private namespaces `tcp:`, `tls:`, `http2:` with private event-schema URIs
(main-schema-14 §8.1). The converted object then goes through the **same** latest-draft loader as any `.qlog`
file. There is no legacy-format path any more.

---

## 2. UI inventory

The converters have no UI of their own. These are all the places where they surface. Texts are verbatim.

### 2.1 File manager (owned by `file-loading.md` §2.4-2.5; listed here for completeness)

- Option 1 help text (`FileManagerContainer.vue:27`): "You can load .qlog, .sqlog, .netlog, .pcap (alongside
  separate .keys) and .pcapng (with embedded keys) files."
- Option 2 file input `accept=".qlog,.sqlog,.json,.netlog"` (`:51`). There is no `.pcap.json` in `accept`; tshark
  JSON is uploaded as `.json` (or via "All files").
- Option 2 help text (`:76-80`): "Upload currently supports .qlog, .sqlog, .json, and
  <a href="https://www.chromium.org/for-testers/providing-network-details">.netlog</a> files. No data is
  transfered to the server.<br/>Eventually we will also support .pcap, .pcapng and .qtr files.<br/>" and, in a
  `<span style="font-size: 12px;">`: "Note: Chrome netlog must be explicitly given the .netlog extension before
  uploading to qvis." QUIRK: this note is outdated. Content sniffing (`activeFieldTrialGroups`, section 3.1) also
  accepts Chrome's default export name `chrome-net-export-log.json`. PARITY: keep the text (file-loading decides).
- Upload validation toast (`:281-287`), title "Provide .qlog/.sqlog file", text
  `"We currently only support uploading .qlog/.sqlog files. " + file.name`. It fires for any name not ending in
  `.qlog .sqlog .json .netlog .qlognd`.

### 2.2 Toasts that converter runs end in (owned by `file-loading.md` §6.1)

| When | type | title | text |
|---|---|---|---|
| upload converted and loaded | success | `Uploaded file` | `"The uploaded file is now available for visualization " + name + ".<br/>Use the menu above to switch views."` |
| converter threw (any exception in `FileLoader.Load`) | error, 6000 ms | `Error uploading file` | `"Something went wrong. " + name + ". For more information, view the devtools console."` |
| converter output not loadable by `QlogLoader.fromJSON` | error, 6000 ms | `"ERROR parsing qlog file " + filename` | `"File was successfully loaded but could not be parsed.<br/>Make sure you have a well-formed qlog file.<br/>View the devtools JavaScript console for more information."` |

QUIRK: a converter that produces zero traces still gives the success toast. The group then has no connections
(section 6.3).

### 2.3 Blocking `alert()` dialogs reachable from converter input

| Source | Text (verbatim) | Trigger |
|---|---|---|
| `tcptoqlog.ts:509` | `"Unknown field found in TLS record: " + field` | one alert **per unknown key per record**. Newer Wireshark adds keys that are not on the allowlist, e.g. `tls.app_data_proto` (section 3.9.6). FIX: diagnostics instead (section 8.8). |
| `PacketizationDiagramModels.ts:187` | `"Remaining length < 0, CANNOT HAPPEN! " + remainingLength` | TCP preprocessor range bookkeeping (section 3.11) |
| `PacketizationDiagramModels.ts:197` | `"Trying to fill payloadranges that aren't there! " + remainingLength` | TLS/H2 sizes exceed TCP/TLS payload (TLS 1.3 without `content_type`, h2c, retransmissions) |
| `QlogLoader.ts:164` / `:351` | `"Loaded trace was not absolutely ordered on event timestamps. We performed a sort() in qvis, but this slows things down and isn't guaranteed to be stable if the timestamps aren't unique! The qlog spec requires absolutely ordered timestamps. See the console for more details."` | only if converter output were unordered. TCPToQlog sorts first, netlog is per-source ordered, so it does not normally fire. |

### 2.4 Where converted traces appear

- File list row (`FileManagerContainer.vue:146-164`): `group.filename` (upload name), and below it
  `group.getShorthand()`. The converters set no file `title` or `description`, so the shorthand is just
  `" (N connections)"` or `" (1 connection)"`, with a leading space (`ConnectionGroup.ts:39-60`). PARITY: the
  converters must not add a file-level `title`/`description` (that would change this row).
- Connection pickers show `getLongName()` = `"client : " + title` for converted traces, since both converters set
  `vantage_point: {type: "client"}` with no `name` (`Connection.ts`). PARITY: no `vantage_point.name`.
- Packetization diagram (TCP traces): four lanes named `TCP`, `TLS`, `HTTP/2`, `Stream IDs`. Tooltips and
  labels are in section 3.11.
- Packetization configurator info modal (`PacketizationDiagramConfigurator.vue:84-90`), verbatim:
  - `<h2>Also usable for TCP + TLS + HTTP/2</h2>`
  - "This visualization was first created for use with TCP + TLS + HTTP/2, as there the implementations are
    typically less well aggregated. This often leads to inefficiencies in how data is packed inside the
    different layers. If you want to use this tool with those protocols as well, create a decrypted trace (so
    HTTP/2 is decoded) using wireshark (or equivalent) and then output it as JSON (either from wireshark directly
    or using tshark). You can then upload that as a .json file using the qvis file manager. It has a built-in
    pcap-to-qlog convertor (or at least the basic of one for this purpose). See the qvis repository for a demo
    TCP file."
  - NEW: qvis-react should ship that demo input (`wikipedia_Playstation.json`, MIT, © 2019 Hasselt University -
    EDM; keep attribution) under `public/examples/tcp/`. Keep the sentence verbatim. Optionally link "demo TCP
    file" to it (decision C6).

---

## 3. Algorithms and data flow

### 3.1 Entry points and detection

All paths end in `FileLoader.Load(contents, name)` or a direct converter call.

| Path | Code | netlog | tshark JSON |
|---|---|---|---|
| Upload (Option 2) | `FileManagerContainer.vue:435` → `FileLoader.Load(file, file.name)` | yes | yes |
| URL direct fetch (Option 1, `?file=`) | `ConnectionStore.ts:181-195` → `FileLoader.Load(txt, urlToLoad)`. Only when the URL contains `.qlog`, `.sqlog`, `.netlog` or `.json` | yes | yes (URL contains `.json`) |
| URL via qvis-server `/loadfiles` | `ConnectionStore.ts:251-257`: if the proxied JSON has `constants` and `events` **and** the URL contains `.netlog`, call `NetlogToQlog.convert(root)` directly. Otherwise a string body goes to `FileLoader.Load` | yes | yes (string body) |
| `loadQlogDirectlyFromURL` (demos) | `ConnectionStore.ts:390-399`: if `parseQlogText` gives an array whose `[0]._source` exists, re-parse with `parseJSONWithDeduplication` and call `TCPToQlog.convert` | no | yes (all TCP demo calls are commented out, `:352-355`) |

`FileLoader` routing (`FileLoader.ts:58-130`):

1. **Extension**, longest-suffix-first allowlist (`:169-206`, first match wins, `endsWith`, case-sensitive):
   `.pcap.json` → `pcap_json`; `.netlog`, `.netlog.br`, `.netlog.brotli`, `.netlog.gz`, `.netlog.gzip`,
   `.netlog.zip` → `netlog`; `.qlog*` and `.json*` → `unclear`; anything else → throw
   `"File extension unsupported: " + name`.
2. **Sniff** for `unclear`, using the first 1024 characters (`:211-248`), in this order:
   `qlog_version` (qlog), then `activeFieldTrialGroups` → **netlog**, then `_source` AND `layers` →
   **pcap_json**, then the legacy qlog keys. Otherwise throw
   `"File format unsupported (for qlogs, make sure qlog_version and qlog_format are at the top of the file): " + name + " : " + firstFewCharacters`.
   - netlog: Chrome writes `{"constants":{"activeFieldTrialGroups":[...` first, because Chrome's JSON writer
     sorts dictionary keys and `activeFieldTrialGroups` sorts first in `constants`.
   - tshark: `[\n  {\n    "_index": "packets-…",\n    "_type": "doc",\n    "_score": null,\n    "_source": {\n      "layers": {`.
3. **Parse and convert** (`:121-130`):
   - `pcap_json`: `StreamingJSONParser.parseJSONWithDeduplication(text)` (a duplicate key becomes an array of all
     its values, in order; see `file-loading.md` §3.6), then `TCPToQLOG.convert(rawJSON)`.
   - `netlog`: plain `JSON.parse(text)`, then `NetlogToQLOG.convert(rawJSON)`. QUIRK: there is no truncation
     repair. A netlog that Chrome did not finish writing (no closing `]}`) throws, and the user gets the
     "Error uploading file" toast.
4. The result goes to `store.addGroupFromQlogFile` → `QlogLoader.fromJSON` (section 3.7 for netlog's
   `"draft-01"`, section 3.10 for TCP's `"draft-02-wip"`).

NEW detection in qvis-react: `file-loading.md` §3.14 step 3 keeps the netlog and tshark sniff rules, with a
4096-character window. They are checked after the latest-draft and legacy-qlog checks. Both converters run
**before** the latest-draft loader, and their output is a normal `QlogFile` object.

### 3.2 Chrome NetLog input format

Top level (Chrome `FileNetLogObserver` / net-export):

```json
{
  "constants": {
    "activeFieldTrialGroups": [ ... ],
    "clientInfo": { ... },
    "logEventPhase": { "PHASE_BEGIN": 1, "PHASE_END": 2, "PHASE_NONE": 0 },
    "logEventTypes": { "QUIC_SESSION": 234, "QUIC_SESSION_ACK_FRAME_SENT": 249, ... },
    "logSourceType": { "QUIC_SESSION": 11, "URL_REQUEST": 1, ... },
    "timeTickOffset": "1600000000000",
    ...
  },
  "events": [
    { "phase": 1, "source": {"id": 16, "start_time": "300131887", "type": 11},
      "time": "300131887", "type": 234, "params": { ... } },
    ...
  ],
  "polledData": { ... }
}
```

- `constants.logEventTypes`, `logSourceType` and `logEventPhase` map **name → number**. Events carry only the
  numbers. qvis inverts the three maps (`invertMap`, `netlogtoqlog.ts:75-84`, via `Object.entries`).
- `event.time` and `source.start_time` are **strings of integer milliseconds** on Chrome's monotonic `TimeTicks`
  clock, with an arbitrary origin. `constants.timeTickOffset` (also a string) is the number of ms to add to get
  Unix-epoch ms. qvis ignores it (`:215-216`, "TODO: Use this timeTickOffset for accurate absolute start time").
  NetLog time resolution is **1 ms**, so many events share a timestamp.
- `NetLogNumberValue` serialization: an integer that fits in int32 is a JSON number. A larger one (offsets,
  `sent_time_us`, `detection_time_us`) is a **decimal string**. qvis reads such fields only via `.toString()`, so
  both forms work. The port must use a `num(x)` helper (`Number(x)` for number or numeric string).
- `params` exists only on events that have parameters. The keys per event type are in `netlog.ts` (2020 Chrome)
  and in the table in section 3.4 (2020 and current names).

### 3.3 `NetlogToQlog.convert(netlogJSON)` step by step (`netlogtoqlog.ts:202-893`)

```
log("NetlogToQlog: converting file with " + events.length + " events")
event_types = invert(constants.logEventTypes); source_types = invert(constants.logSourceType)
phases      = invert(constants.logEventPhase)
connectionMap = new Map<sourceId, QUICConnection>()            // insertion order = trace order
for event of events (file order):
  source_type = source_types.get(event.source.type)
  if undefined: console.error("netlog2qlog:convert : unknown source type!", ...); continue
  if source_type !== "QUIC_SESSION": continue                    // silently drop everything else
  event_type = event_types.get(event.type)
  if undefined: console.error("netlog2qlog:convert : unknown event type!", ...); continue
  phase = phases.get(event.phase)
  if undefined: console.error("netlog2qlog:convert : unknown event phase!", ...); continue
  connection = connectionMap.get(source.id)
  if not found:
     if event_type !== "QUIC_SESSION": console.warn("netlogtoqlog:convert : new connection found, but first event was not QUIC_SESSION! Not sure this will work...", ...)
     if phase !== "PHASE_BEGIN":       console.warn("netlogtoqlog:convert : connection starting in phase other than PHASE_BEGIN! Not sure this will work...", ...)
     connection = new QUICConnection(session = params, sourceId, startTime = +event.time)
  time = +event.time - connection.startTime                      // integer ms relative to the session's first event
  qlogEvent = [time]
  switch (event_type) { ... section 3.4 ... }                    // pushes [time, category, event, data] or buffers frames
after loop:
  for conn of connectionMap.values():
    if conn.qlogEvents.length > 0:
       traces.push({ title: conn.title, vantage_point: {type: "client"},
                     event_fields: ["relative_time","category","event","data"],
                     common_fields: { protocol_type: "QUIC_HTTP3", reference_time: conn.startTime.toString() },
                     events: conn.qlogEvents })
    else console.warn("netlogtoqlog:convert : QUIC connection found but not events logged for this one for some reason... netlog sometimes has QUIC_SESSION_CLOSED events due to timeouts and those are not linked to the real original connection at this time, which is the likely source of this warning.", conn)
return { qlog_version: "draft-01", traces }
```

`QUICConnection` (`:132-197`):

- `title = \`${session.host}-${session.connection_id}\`` (`:148`). `session` is the `params` of the connection's
  **first** event. If that event is not `QUIC_SESSION`, the title becomes `"undefined-undefined"` (QUIRK).
- `txQUICFrames`: frames logged by `*_FRAME_SENT` **before** their `QUIC_SESSION_PACKET_SENT` (Chrome logs
  frames as they are added to the packet being built, then the packet). `PACKET_SENT` takes a shallow copy of every
  buffered frame and clears the buffer.
- `rxQUICFrames` and `rxPacket`: for receiving, Chrome logs `QUIC_SESSION_PACKET_RECEIVED` (UDP datagram size)
  first, then `QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED` (packet number and type), then
  `QUIC_SESSION_PACKET_AUTHENTICATED`, then the `*_FRAME_RECEIVED` events. So qvis:
  1. On `PACKET_RECEIVED`: push a placeholder `packet_received` event **right away** (so its time and position
     are those of `PACKET_RECEIVED`). If a previous `rxPacket` exists, give it a copy of `rxQUICFrames` as
     `frames`. Then make the new placeholder the current `rxPacket` and clear `rxQUICFrames`.
  2. On `UNAUTHENTICATED_PACKET_HEADER_RECEIVED`: write `packet_type` and `packet_number` into the current
     `rxPacket.header`. If there is no `rxPacket` yet, create one that is **not** pushed to the trace (QUIRK:
     that packet never appears).
  3. Frames go to `rxQUICFrames`.
  QUIRK: the **last** received packet of every connection never gets its frames, because frames are only attached
  when the next `PACKET_RECEIVED` arrives. Leftover `txQUICFrames` at the end are also dropped. FIX (T2): flush at
  end of input (section 8.4).
- `pushFrame(event_type, frame)` (`:173-179`): `event_type.indexOf('SENT') >= 0` → tx buffer, else rx buffer.
- `pushH3Frame(event_type, frame, qlogEvent)` (`:181-196`): pushes `[time, "http", "frame_created"|"frame_parsed", frame]`
  immediately ("SENT" in the name → `frame_created`).

### 3.4 NetLog event → qvis qlog mapping (T1 = PARITY content; the new names are in section 8.4)

All rows only apply to events whose source type is `QUIC_SESSION`. "buffer tx/rx" means `pushFrame`. Numeric
values that qvis stringified are marked `"…"`. 2020 param names come from `netlog.ts`. "Current Chrome" names
come from `quic_event_logger.cc` / `quic_http3_logger.cc` on main as of 2026-11.

| NetLog event type | Params used (2020 → current Chrome) | qvis output (old schema) | Line |
|---|---|---|---|
| `QUIC_SESSION` (BEGIN/END) | `host`, `connection_id` (title only) | none (`continue` after the connection is created) | :294-308 |
| `QUIC_SESSION_TRANSPORT_PARAMETERS_SENT` | `quic_transport_parameters` (string) | `[t, "transport", "parameters_set", {owner:"local", <key>:"<value>", ...}]` (section 3.6) | :310-327 |
| `QUIC_SESSION_TRANSPORT_PARAMETERS_RECEIVED` | same | same with `owner:"remote"` | :585-599 |
| `QUIC_SESSION_CRYPTO_FRAME_SENT` / `_RECEIVED` | `offset`, `data_length` (`encryption_level`, `bytes` ignored) | buffer: `{frame_type:"crypto", offset:"…", length:"…"}` | :329-339 |
| `QUIC_SESSION_PADDING_FRAME_SENT` / `_RECEIVED` | (`num_padding_bytes` ignored) | buffer: `{frame_type:"padding"}` | :341-349 |
| `QUIC_SESSION_PING_FRAME_SENT` / `_RECEIVED` | none | buffer: `{frame_type:"ping"}` | :351-358 |
| `QUIC_SESSION_STREAM_FRAME_SENT` / `_RECEIVED` | `stream_id`, `offset`, `length`, `fin` | buffer: `{frame_type:"stream", stream_id:"…", offset:"…", length:"…", fin}` | :360-372 |
| `QUIC_SESSION_ACK_FRAME_SENT` / `_RECEIVED` | `largest_observed`, `smallest_observed`, `missing_packets` (`delta_time_largest_observed_us`, `received_packet_times`, ECN `ECT0/ECT1/CE` ignored) | buffer: `{frame_type:"ack", acked_ranges:[["a","b"], ...]}` (section 3.5) | :374-391 |
| `QUIC_SESSION_WINDOW_UPDATE_FRAME_SENT` / `_RECEIVED` | `stream_id`, `byte_offset` | `stream_id === -1`: `{frame_type:"max_data", maximum:"…"}`; else `{frame_type:"max_stream_data", stream_id:"…", maximum:"…"}` | :393-411 |
| `QUIC_SESSION_RST_STREAM_FRAME_SENT` / `_RECEIVED` | `stream_id`, `quic_rst_stream_error`, `offset` (current Chrome also has `ietf_error_code`) | buffer: `{frame_type:"reset_stream", stream_id:"…", error_code:<quic_rst_stream_error>, final_size:"<offset>"}` | :413-424 |
| `QUIC_SESSION_STOP_SENDING_FRAME_SENT` / `_RECEIVED` | 2020: `application_error_code`, `stream_id`. Current: `quic_rst_stream_error`, `ietf_error_code`, `stream_id` | buffer: `{frame_type:"stop_sending", stream_id:"…", error_code:<application_error_code>}`. QUIRK: with current Chrome, `error_code` is `undefined` (key dropped by JSON) | :426-436 |
| `QUIC_SESSION_CRYPTO_HANDSHAKE_MESSAGE_SENT` / `_RECEIVED` | none used | none ("Don't know what qlogschema frame to use here") | :438-443 |
| `QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT` | `quic_error`, `details` (current also `quic_wire_error`, `close_type`, `transport_close_frame_type`) | tx buffer: `{frame_type:"connection_close", error_space:"transport_error", error_code:quic_error, raw_error_code:quic_error, reason:details}`. QUIRK: always transport space, and `quic_error` is Chromium's internal `QuicErrorCode`, not the wire code | :445-456 |
| `QUIC_SESSION_PACKET_SENT` | `encryption_level`, `packet_number`, `size` (`sent_time_us`, `transmission_type`, `batch_id` ignored) | `[t, "transport", "packet_sent", {header:{packet_type, packet_number:"…"}, frames:[copy of tx buffer], raw:{length:size}}]`, then clear the tx buffer. `packet_type` per table 3.4a | :458-498 |
| `QUIC_SESSION_COALESCED_PACKET_SENT` | (`info` ignored) | none | :500-503 |
| `QUIC_SESSION_PACKET_RECEIVED` | `size` (`peer_address`, `self_address` ignored) | `[t, "transport", "packet_received", {header:{packet_type:"unknown", packet_number:""}, is_coalesced:false, raw:{length:size}}]` pushed now; frames attached later (3.3) | :505-544 |
| `QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED` | `long_header_type`, `packet_number` (`connection_id`, `header_format` ignored) | mutates the current `rxPacket.header`: `packet_type` per table 3.4b, `packet_number:"…"` | :546-583 |
| `QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED` | none | none. QUIRK: the frame is not added to the packet | :601-604 |
| `QUIC_SESSION_PACKET_LOST` | `packet_number` (`transmission_type`, `detection_time_us` ignored) | `[t, "recovery", "packet_lost", {header:{packet_type:"unknown", packet_number:"…"}}]` | :606-625 |
| `QUIC_SESSION_CLOSED` | none used | none | :627-630 |
| `QUIC_SESSION_CLOSE_ON_ERROR` | none | none | :632-634 |
| `QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET` | none | none (the `packet_buffered` mapping is commented out) | :636-645 |
| `QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET` | `encryption_level` | `[t, "transport", "packet_dropped", {header:{packet_type: "ENCRYPTION_HANDSHAKE" ? "handshake" : "unknown", packet_number:""}}]` | :647-668 |
| `QUIC_CHROMIUM_CLIENT_STREAM_SEND_REQUEST_HEADERS`, `QUIC_CHROMIUM_CLIENT_STREAM_READ_RESPONSE_HEADERS` | none | none | :670-673 |
| `QUIC_SESSION_ATTEMPTING_TO_PROCESS_UNDECRYPTABLE_PACKET`, `QUIC_SESSION_PACKET_AUTHENTICATED`, `QUIC_SESSION_VERSION_NEGOTIATED`, `QUIC_SESSION_STREAM_FRAME_COALESCED`, `QUIC_SESSION_CERTIFICATE_VERIFIED` | none | none (silently) | :675-697 |
| `HTTP3_PEER_CONTROL_STREAM_CREATED` / `HTTP3_LOCAL_CONTROL_STREAM_CREATED` | `stream_id` | `[t, "http", "stream_type_set", {stream_id:"…", owner: PEER?"remote":"local", new:"control"}]` | :699-719 |
| `HTTP3_*_QPACK_DECODER_STREAM_CREATED` | `stream_id` | same, `new:"qpack_decode"` | :721-741 |
| `HTTP3_*_QPACK_ENCODER_STREAM_CREATED` | `stream_id` | same, `new:"qpack_encode"` | :743-764 |
| `HTTP3_SETTINGS_RECEIVED` / `_SENT` | 2020 keys `SETTINGS_MAX_HEADER_LIST_SIZE`, `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, `SETTINGS_QPACK_BLOCKED_STREAMS`. Current Chrome uses quiche `H3SettingsToString` names (`SETTINGS_MAX_FIELD_SECTION_SIZE`, …; unrecognized ids look like `UNSUPPORTED_SETTINGS_TYPE(<n>)`, verify on a real log) | `[t, "http", "parameters_set", {owner: SENT?"local":"remote", max_header_list_size, max_table_capacity, blocked_streams_count}]`. QUIRK: with current Chrome `max_header_list_size` is `undefined` | :766-787 |
| `HTTP3_MAX_PUSH_ID_RECEIVED` / `_SENT` | `push_id` | none. QUIRK: a frame object is built and discarded (dead code) | :789-797 |
| `HTTP3_HEADERS_SENT` | `stream_id`, `headers` | `[t, "http", "frame_created", {stream_id:"…", frame:{frame_type:"headers", headers}}]` | :799-814 |
| `HTTP3_HEADERS_DECODED` | `stream_id`, `headers` | same, `frame_parsed` | :799-814 |
| `HTTP3_PRIORITY_UPDATE_RECEIVED` / `_SENT` | none used | none ("Not supported yet") | :816-821 |
| `HTTP3_DATA_SENT` | none used | none | :823-825 |
| `HTTP3_DATA_FRAME_RECEIVED` | `stream_id`, `payload_length` | `[t, "http", "frame_parsed", {stream_id:"…", frame:{frame_type:"data"}, byte_length:"<payload_length>"}]` | :827-838 |
| `HTTP3_UNKNOWN_FRAME_RECEIVED` | none used | none | :840-842 |
| `HTTP3_HEADERS_RECEIVED` | none used | none ("Not in use") | :844-847 |
| `CERT_VERIFIER_REQUEST` | phase | `[t, "info", "marker", "CERT_VERIFIER_REQUEST BEGIN"]` when phase is `PHASE_BEGIN`, else `"CERT_VERIFIER_REQUEST END"` (`data` is a **string**; `PHASE_NONE` also gives "END") | :849-860 |
| anything else on a QUIC_SESSION source | — | none; `console.warn("netlog2qlog:convert : unknown QUIC event, not supported yet!", event, event_type)` **per event** | :862-866 |

Events that hit the warning branch with current Chrome include `QUIC_SESSION_CONNECTION_CLOSE_FRAME_RECEIVED`,
`*_NEW_CONNECTION_ID_FRAME_*`, `*_RETIRE_CONNECTION_ID_FRAME_*`, `*_MAX_STREAMS_FRAME_*`,
`*_STREAMS_BLOCKED_FRAME_*`, `*_BLOCKED_FRAME_*`, `*_GOAWAY_FRAME_*`, `*_MESSAGE_FRAME_*`, `*_NEW_TOKEN_FRAME_*`,
`*_PATH_CHALLENGE/RESPONSE_FRAME_*`, `*_MTU_DISCOVERY_FRAME_SENT`, `*_STOP_WAITING_FRAME_SENT`,
`QUIC_SESSION_HANDSHAKE_DONE_FRAME_SENT`, `QUIC_SESSION_DUPLICATE_PACKET_RECEIVED`,
`QUIC_SESSION_VERSION_NEGOTIATION_PACKET_RECEIVED`, `QUIC_SESSION_TRANSPORT_PARAMETERS_RESUMED`,
`QUIC_SESSION_ZERO_RTT_REJECTED`, `QUIC_SESSION_CERTIFICATE_VERIFY_FAILED`, `QUIC_CONGESTION_CONTROL_CONFIGURED`,
`HTTP3_GOAWAY_*`, `HTTP3_SETTINGS_RESUMED`. PARITY consequence: none of these frames appear inside the packets in
qvis.

Table 3.4a, `encryption_level` → `packet_type` for `PACKET_SENT` (`:460-475`):

| netlog | qlog |
|---|---|
| `ENCRYPTION_INITIAL` | `initial` |
| `ENCRYPTION_HANDSHAKE` | `handshake` |
| `ENCRYPTION_ZERO_RTT` | `0RTT` |
| `ENCRYPTION_FORWARD_SECURE` | `1RTT` |
| other | `unknown` + `console.error("netlog2qlog:convert: unknown packet type sent", encryption_level)` |

Table 3.4b, `long_header_type` → `packet_type` for `UNAUTHENTICATED_PACKET_HEADER_RECEIVED` (`:548-565`):

| netlog | qlog |
|---|---|
| `INITIAL` | `initial` |
| `HANDSHAKE` | `handshake` |
| `ZERO_RTT_PROTECTED` | `0RTT` |
| `RETRY` | `retry` |
| `VERSION_NEGOTIATION` | `version_negotiation` |
| `INVALID_PACKET_TYPE` | `unknown` |
| absent or anything else (short header, gQUIC) | `1RTT` |

HTTP/3 header lists (`:802-804`): `Object.entries(params.headers).map(([key, value]) => ({name: key, value}))`.
2020 Chrome logged `headers` as an object `{":method": "GET", ...}`, which gives proper name/value pairs.
**Current Chrome logs a list of `"name: value"` strings** (`ElideQuicHeaderListForNetLog` → `base::Value::List`
of `StrCat({key, ": ", value})`). With that, `Object.entries` gives `{name: "0", value: ":method: GET"}`, and so
on (QUIRK, effectively a bug: the sequence diagram's "GET /path" labels and the multiplexing/packetization
request-to-stream mapping silently stop working for modern netlogs). FIX (T2) in section 8.5.3.

### 3.5 `calculateAckRanges(largest, smallest, missing)` (`:93-130`)

Converts Chrome's "largest/smallest observed + list of missing packet numbers" into inclusive acked ranges:

```ts
if (missing.length === 0) return [[smallest, largest]];
missing.sort((a, b) => a - b);                     // in place (mutates the event params)
result = [[smallest, missing[0] - 1]];
for (i = 0; i < missing.length - 1; i++)
  if (missing[i + 1] !== missing[i] + 1) result.push([missing[i] + 1, missing[i + 1] - 1]);
result.push([missing[missing.length - 1] + 1, largest]);
```

Each number is then stringified (`acked_ranges: [["3","5"], ...]`). Test vectors from the comments (`:206-210`;
the first comment's expected `[2155,2155]` is a typo for `[2115,2115]`):

| largest, smallest, missing | qvis result | T2 result (numbers, single-element form) |
|---|---|---|
| 2115, 2050, [2056…2114] (consecutive) | `[[2050,2055],[2115,2115]]` | `[[2050,2055],[2115]]` |
| 20, 3, [6,7,8,11] | `[[3,5],[9,10],[12,20]]` | same |
| 20, 11, [12] | `[[11,11],[13,20]]` | `[[11],[13,20]]` |
| 20, 20, [] | `[[20,20]]` | `[[20]]` |
| 20, 3, [5,7] | `[[3,4],[6,6],[8,20]]` | `[[3,4],[6],[8,20]]` |
| 20, 3, [3,4] (first missing == smallest) | `[[3,2],[5,20]]` (invalid first range) | `[[5,20]]` (drop ranges with from > to) |
| 10, undefined, [] (old Chrome bug 1112925, no `smallest_observed`) | **throws** `TypeError` on `undefined.toString()`; the whole upload fails | `[[10]]` plus diagnostic `netlog.ack.no-smallest-observed` (section 8.5.2) |

### 3.6 Transport-parameter string (`:311-326`, `:586-598`)

Chrome logs `quic_transport_parameters` as quiche's `TransportParameters::ToString()`, for example
`"[Client max_idle_timeout 30000 max_udp_payload_size 1472 initial_max_data 15728640 initial_max_stream_data_bidi_local 6291456 initial_max_streams_bidi 100 initial_source_connection_id 0a0b0c0d]"`.

qvis: `str.split(" ").slice(1)`, then pairs `(tokens[i], tokens[i+1])` become `data[key] = value` (strings).
QUIRKs:

- The last value keeps the closing `]` (`"0a0b0c0d]"`).
- quiche omits integer parameters that have their default value, so keys come and go.
- Flag parameters without a value (`disable_active_migration`), multi-token values
  (`google_handshake_message length: N`, `legacy[version …]`, `preferred_address …`), and custom parameters
  (`0x<id>=<hex>`) shift the pairing. Every key after them is then garbage (worked example in section 8.9.3).
- 2020 Chrome used pre-RFC names (`idle_timeout`, `max_packet_size`). The QUIC packetization preprocessor reads
  `data.max_packet_size` with `owner` (`PacketizationQUICPreProcessor.ts:464-477`) for its
  "max receiving size client/server" labels. The stats view reads `initial_max_data`,
  `initial_max_stream_data_bidi_local`, `initial_max_stream_data_bidi_remote` and `initial_max_stream_data_uni`
  with `owner` and `parseInt` (`StatisticsConnectionRenderer.vue:466-525`).
- FIX (T2): a robust tokenizer with a name map (section 8.5.1).

### 3.7 How qvis loads netlog output (`QlogLoader.fromDraft01`, `QlogLoader.ts:172-353`)

- `qlog_version: "draft-01"` → `fromDraft01`. Each trace is one connection (there is no `group_id`).
- `EventFieldsParser.init`: `relative_time` is present, so `RELATIVE_TIME`. `addTime = parseFloat(reference_time)`
  is the session's start tick in ms. So `relativeTime = time` (ms since the session's first netlog event, the
  `QUIC_SESSION` BEGIN, which itself is **not** emitted). `absoluteTime = time + startTick`. That puts all traces
  of one netlog on the same tick base, so multi-trace alignment works.
- For every event, `data.type` / `data.packet_type` legacy fix-ups (do nothing for netlog output), then
  `fix02Compatibility(data)`. For netlog output that is a no-op, since there is no `packet_type` at the top level
  and no `header.packet_size` / `header.payload_length`.
- Semi-01 heuristics: the first `parameters_set` event stops the scan with `needsUpgrade = false`, so there is no
  upgrade.
- Order check plus `alert` (section 2.3). Netlog events are logged in time order per source, so this does not
  fire.
- Display: the `info:marker` events with string `data` show as **"marker"** in the sequence diagram's side
  labels (`SequenceDiagramD3Renderer.ts:2201-2216`: `evt.data.message` is undefined, so it returns `evt.name`).

### 3.8 tshark JSON input format (`wikipedia_Playstation.json`)

Produced by `tshark -r capture.pcapng -T json [-o tls.keylog_file:keys] [--no-duplicate-keys]` (or Wireshark
"Export Packet Dissections → As JSON"). It is an array of packets:

```json
[
  { "_index": "packets-2020-02-20", "_type": "doc", "_score": null,
    "_source": { "layers": {
      "frame": { "frame.time_epoch": "1582210168.496779237", "frame.number": "1", "frame.protocols": "eth:ethertype:ip:tcp", ... },
      "eth":   { ... },
      "ip":    { "ip.src": "172.18.15.26", "ip.dst": "91.198.174.208", ... },          // or "ipv6": { "ipv6.src", "ipv6.dst" }
      "tcp":   { "tcp.srcport": "38080", "tcp.dstport": "443", "tcp.len": "0", "tcp.seq": "221198172",
                 "tcp.hdr_len": "40", "tcp.flags_tree": {...}, ... },
      "tcp.segments": { ... },                                   // optional: TCP reassembly info
      "tls":   <dict | array | "Transport Layer Security">,       // optional
      "tls.segments": { "tls.segment": [...], "tls.reassembled.length": "27", ... },   // optional, sibling of "tls"
      "http2": <dict | array | "HyperText Transfer Protocol 2">   // optional
    } } }
]
```

All values are **strings** (numbers too). Observed shapes in the example file (183 packets, scripts in the
scratchpad):

- Layer key sets: 116× `eth, frame, ip, tcp`; 27× `+ http2, tcp.segments, tls, tls.segments`; 23× `+ http2, tls`;
  9× `+ http2, tls, tls.segments`; 7× `+ tls`; 1× `+ tcp.segments, tls`.
- The file has **no duplicate keys** (it was exported with `--no-duplicate-keys`, so repeats are already arrays,
  e.g. `ip.addr: [..]`). Exports without that flag repeat keys such as `"tls"` and `"http2.stream"` inside one
  object. Hence the dedup parser.
- `tls` is a dict 40×, an array of 2 24× (11 of them with an empty second element `{}`), and the string
  `"Transport Layer Security"` 3× (TCP segments that only carry continuation bytes of a record).
- A TLS dict is `{ "tls.record": <record | [records]>, ["tls.segment.data": "<hex>" | [hex, hex]] }`.
- A record: `tls.record.content_type` (`"20"`/`"21"`/`"22"`/`"23"`), `tls.record.version` (`"0x00000303"`),
  `tls.record.length` (decimal string), plus one of `tls.app_data` (`"aa:bb:…"`), `tls.handshake`,
  `tls.change_cipher_spec`.
- `http2` is a dict 22×, the string `"HyperText Transfer Protocol 2"` 5×, and an array of 2/4/6/8/10 elements 32×,
  often with trailing `{}` elements (incomplete frames).
- An http2 node: `{ "http2.stream": <frame | [frames]> }`. A frame has `http2.length`, `http2.type` (decimal
  string), `http2.flags`, `http2.flags_tree` (`http2.flags.end_stream`: `"0"`/`"1"`, …), `http2.streamid`,
  optionally `http2.header: [{http2.header.name, http2.header.value, …}]` (HEADERS), `http2.data.data`
  (DATA), `http2.settings`, `http2.window_update.window_size_increment`, …
- The client connection preface is a pseudo-frame `{ "http2.magic": "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" }` inside
  `http2.stream`.
- HTTP/2 frames that complete in a later TCP segment are attached by tshark to the packet where reassembly
  completes. Their TLS record also appears there (`tls.segments` lists the frames involved).

### 3.9 `TCPToQlog.convert(pcapJSON)` step by step (`tcptoqlog.ts:27-158`)

```
log("TCPToQlog: converting file with " + pcapJSON.length + " events")
qlogFile = { qlog_version: "draft-02-wip", traces: [] }
connectionMap = new Map<string, TCPConnection>()                  // key "ip:port" of the CLIENT side only
for entry of pcapJSON:
  L = entry._source?.layers
  if !entry._source || !L || (!L.ip && !L.ipv6) || !L.tcp: continue // non-TCP (DNS, QUIC/UDP, ARP, …) silently skipped
  IP = L.ip ?? L.ipv6; src = IP["ip.src"|"ipv6.src"]; dst = IP["ip.dst"|"ipv6.dst"]
  conn = map.get(src + ":" + tcp.srcport); direction = sending
  if !conn: conn = map.get(dst + ":" + tcp.dstport); direction = receiving
  if !conn:                                                          // first packet seen = client → server
     direction = sending
     conn = { qlog: { vantage_point: {type: "client"}, event_fields: ["time","category","event","data"],
                      common_fields: {protocol_type: "TCP_HTTP2"}, events: [],
                      title: src + ":" + srcport + " -> " + dst + ":" + dstport },
              probable_url: undefined, TLSAppDataTrailerSize: undefined, TLSRecordsToBeAdjustedForTrailerSize: [],
              DEBUG_HTTPtotalSize: 0, DEBUG_TLSpayloadSize: 0,
              timestampTracker: { sending: {time:-1, seq:-1}, receiving: {time:-1, seq:-1} } }
     map.set(src + ":" + srcport, conn)
     log("Created new connection #", map.size, src + ":" + srcport, " => ", dst + ":" + dstport)
  addEntry(conn, direction, L)                                       // 3.9.1-3.9.7
  conn.DEBUG_originalEntries.push(entry)                             // memory only, never used
finalize per connection (map insertion order):                       // 3.9.8
return qlogFile
```

Connection keying QUIRKs:
- Only one endpoint (`ip:port`) is the key. The first packet seen decides who is "client". A capture that starts
  with a server→client packet makes the server the "client" (`direction` and the title are flipped).
- A packet is "sending" if its source endpoint is a key. Otherwise it is "receiving" if its destination endpoint
  is a key. Unrelated flows sharing an endpoint string merge into one trace.

#### 3.9.1 Timestamp and per-direction ordering (`:164-193`)

```
timestamp = parseFloat(L.frame["frame.time_epoch"])      // SECONDS since Unix epoch, float
seqNr     = parseInt(L.tcp["tcp.seq"], 10)
tr = conn.timestampTracker[direction]
if seqNr < tr.seq: console.error("UNORDERED SEQ NUMBERS", timestamp, " : ", seqNr, " < ", tr)        // log only
if timestamp < tr.time:
   if seqNr > tr.seq: timestamp = tr.time + 0.000001 (1 µs); console.warn("Mismatched timestamps, but sequence numbers were correctly ordered: faking timestamp instead"); tr = {timestamp, seqNr}
   else:              console.error("UNORDERED TIMESTAMPS", timestamp, " : ", seqNr, " < ", tr)     // tracker NOT updated, timestamp kept
else: tr = {timestamp, seqNr}
```

The comment at `:166-168` explains why: capture timestamps can be badly ordered (for example a SYN/ACK appearing
after the ACK reply). Frame-number ordering was tried and abandoned.

QUIRK (time unit): the event `time` is in **seconds**. The trace has `"time"` in `event_fields` with no
`configuration.time_units`, so `EventFieldsParser` treats the values as **milliseconds** (`timeMultiplier = 1`).
Every TCP trace is shown 1000× compressed in time-based views (relativeTime 0.472 "ms" for a 472 ms capture). The
packetization diagram is unaffected, since its x-axis is bytes. FIX (T2): emit ms (section 8.6).

#### 3.9.2 TCP packet event (`:196-228`), always emitted first for the entry

```ts
[timestamp, "transport", direction === sending ? "packet_sent" : "packet_received", {
  header: {
    packet_type: "1RTT",                               // "QUIC qlog compat mode"
    packet_number: parseInt(frame["frame.number"]),    // capture frame number
    sequence_number: parseInt(tcp["tcp.seq"]),
    payload_length: parseInt(tcp["tcp.len"]),
    header_length: parseInt(tcp["tcp.hdr_len"]),
  },
  raw: { length: hdr_len + len },
}]
```

Note `EventCategory.tcp = "transport"` in `qlog_tcp_tls_h2.ts:4`. TCP packets reuse QUIC's category name.

#### 3.9.3 TLS record extraction (`:230-307`)

Only when `L.tls` exists and is not a string. With `TLS = L.tls`, records are collected into `TLSrecords` by
`extractRecords(obj)`:

```
if Object.keys(obj).length === 0: console.warn("tcp2qlog: empty TLS record... ignoring", obj, entry); return
if obj["tls.record"]:                       // truthy
   if Array: for el: extractRecords(el)
   else: TLSrecords.push(obj["tls.record"])  // pushed as-is, no length check
else if obj["tls.record.length"]: TLSrecords.push(obj)
else: try { for (el of obj) extractRecords(el) }   // arrays
      catch: console.error("TLS object was not iterable, skipping. Typically only if we have TLS Unknown Record!", obj, entry)
```

Entry point:
- `TLS.length === 2` and `Object.keys(TLS[1]).length === 0`: `extractRecords(TLS[0])` (drop the empty second element).
- `TLS.length === 2` otherwise: `extractRecords(TLS)`.
- `TLS.length > 2`: `console.error("tcptoqlog: More than two TLS entries... what is happening?", TLS)`, then `extractRecords(TLS)`.
- otherwise (dict): `extractRecords(TLS)`.
- If no records result: `console.error("tcptoqlog: No tls.record... what is happening?", TLS)` and **return from
  `addEntry`**. The TCP event was already pushed, but this entry's HTTP/2 frames are dropped (QUIRK).

QUIRK (latent crash): a string element inside a TLS array recurses forever (`for…of` over a string yields
one-character strings, whose `Object.keys` length is 1). The result is a `RangeError` (stack overflow) and the
upload fails. The HTTP/2 walker guards against this. The TLS walker does not. Not present in the example. FIX
(T2): skip strings.

#### 3.9.4 HTTP/2 frame extraction (`:309-358`)

Only when `L.http2` exists and is not a string. `extractFrames(obj)`:

```
if Object.keys(obj).length === 0: console.warn("tcp2qlog: empty HTTP/2 frame... ignoring (expected if TLS record contains a small piece of the H2 frame. Look at the tls.segment.data array contents: 2nd entry should be +- 9 bytes)", entry); return
if obj["http2.magic"]: obj["http2.length"] = "24"; obj["http2.type"] = "magic"     // MUTATES the input
if obj["http2.stream"]:
   if Array: for el: extractFrames(el)
   else: HTTPframes.push(obj["http2.stream"])          // pushed as-is: a lone magic here is NOT patched (QUIRK)
else if obj["http2.length"]: HTTPframes.push(obj)     // "0" is a truthy string, so 0-length frames are kept
else if typeof obj !== "string": try { for (el of obj) extractFrames(el) } catch: console.error("HTTP/2 object was not iterable, skipping. Haven't seen this before!", obj, entry)
// strings inside arrays: silently ignored
```

In the example file this warning fires 51 times (trailing `{}` elements). That is expected.

#### 3.9.5 Size sanity check (`:366-384`, "DEBUG: REMOVE")

Sums `tls.record.length` of `content_type === "23"` records and `http2.length` of all frames. If they differ by
more than 500: `console.warn("Weird inconsistencies between frame sizes", recordLength, httpLength, entry)`. Log
only.

#### 3.9.6 TLS record events and trailer estimation (`:386-549`), per record, in order

1. Category `tls`. Event `record_created` (sending) or `record_parsed` (receiving).
2. `content_type`: from `tls.record.content_type` (`"23"` → `application`, `"22"` → `handshake`, `"21"` →
   `alert`, `"20"` → `change-cipherspec`, missing/other → `unknown`). The fallback to `tls.record.opaque_type` is
   commented out (`:403-406`, "keep this off for now").
3. If `tls.record.length` is missing: `console.error("no tls.record.length set... weird", record)`.
   `recordLength = parseInt(tls.record.length)` (NaN if missing).
4. If `tls.app_data` exists: `appDataLength = (app_data.length + 1) / 3` (colon-hex string to bytes). If it
   differs from `recordLength`: `console.error("tcptoqlog: Record length is different from app_data length", …)`.
   For an `application` record without `tls.app_data`:
   `console.error("tcptoqlog: TLS application record without app data... weird?", record, TLS)`.
5. **Trailer estimation** (the core heuristic). `fullPayloadLength = recordLength` (record body, which includes
   the AEAD tag and, for TLS 1.3, the inner content-type byte, but not the 5-byte header).
   `totalH2payloadLength = Σ over ALL HTTP/2 frames of this TCP entry of (parseInt(http2.length) + 9)` (the magic
   counts as 24 + 9 = 33, QUIRK). Estimate only if **all** of:
   - `content_type === "application"`
   - `TLSrecords.length === HTTPframes.length` (same count of records and frames in this TCP entry)
   - `fullPayloadLength - totalH2payloadLength > 0`
   - `!L["tls.segments"]` and `!TLS["tls.segment.data"]` (the record and frames are not reassembled across segments)

   Then `suggested = fullPayloadLength - totalH2payloadLength`:
   - `suggested ∉ {16, 17, 8, 24}`: `console.error("TCPToQlog: TLS trailer size is not 16, 17, 8 or 24: potential error! TODO: actually check with negotiated cipher what is expected here!", suggested)`, no estimate.
   - else if no estimate yet: `conn.TLSAppDataTrailerSize = suggested`,
     `console.log("TCPToQlog: TLS trailer size estimated", …)`. Then **retroactively adjust** every record in
     `TLSRecordsToBeAdjustedForTrailerSize` (all `application` records created before the estimate):
     `header.trailer_length = T; header.payload_length -= T` (`console.error("TCPToQlog: adjusting for TLS trailer size lead to negative size...", r)`
     if < 0), and `DEBUG_TLSpayloadSize -= T`. Then clear the list.
   - else if it differs from the existing estimate:
     `console.error("TCPToQlog: guesstimated TLS trailer size was inconsistent", T, "!=", suggested, …)`. The first
     estimate is kept.

   With one record and N frames, the counts match only if N = 1. With several records and the same number of
   frames, every record is compared with the sum of all frames, so the difference is usually ≤ 0 and skipped.
   Meaning of the accepted values: 16 = a 16-byte AEAD tag with no explicit nonce (TLS 1.2 ChaCha20-Poly1305;
   the example file gives 16); 17 = TLS 1.3 tag + 1-byte inner content type; 24 = TLS 1.2 AES-GCM (8-byte
   explicit nonce + 16-byte tag; the nonce actually precedes the payload but is counted as "trailer"); 8 =
   CCM_8 tag.
6. `trailerSize = (T && content_type === "application") ? T : 0`.
7. Field allowlist (`:506-512`): for every key of the record not in
   `["tls.record.content_type", "tls.record.opaque_type", "tls.record.length", "tls.record.version", "tls.app_data", "tls.handshake", "tls.change_cipher_spec", "tls.handshake.fragments", "tls.alert_message", "tls.reassembled_in", "tls.handshake.reassembled_in"]`:
   `alert("Unknown field found in TLS record: " + field)` and
   `console.error("Unknown field found in TLS record: ", field, expectedRecordFields, entry)`.
8. Event data:

```ts
{ header: {
    packet_type: "1RTT", packet_number: "",            // "QUIC qlog compat mode, not needed"
    content_type,                                       // "handshake"|"alert"|"application"|"change-cipherspec"|"unknown"
    header_length: 5,                                   // TLS record header, always 5
    trailer_length: trailerSize,
    payload_length: recordLength - trailerSize,
    DEBUG_wiresharkFrameNumber: parseInt(frame["frame.number"]),
} }
```

9. If `application` and no estimate yet, remember the object for later adjustment. If `application`,
   `DEBUG_TLSpayloadSize += recordLength - trailerSize`. If `payload_length === 0`:
   `console.error("TLS record without payload... seems weird", record)`.

#### 3.9.7 HTTP/2 frame events (`:553-697`), per frame, in order

- Category `http2`. Event `frame_created` (sending) or `frame_parsed` (receiving). The comment at `:580-583`
  notes that in an implementation `frame_created` would come before `packet_sent`. Here it comes after, which the
  packetization logic relies on.
- `frame_type` from `http2.type`: `"0"` data, `"1"` headers, `"2"` priority, `"3"` reset_stream, `"4"` settings,
  `"5"` push_promise, `"6"` ping, `"7"` go_away, `"8"` window_update, `"9"` continuation, `"magic"` magic, other
  → unknown (`HTTP2FrameTypeName`, `qlog_tcp_tls_h2.ts:131-144`).
- `frameLength = parseInt(http2.length)`. `headerLength = 9`, or `0` for magic.
- headers frames: `headers = for (h of frame["http2.header"]) {name: h["http2.header.name"], value: h["http2.header.value"]}`.
  QUIRK (crash): if `http2.header` is missing (HPACK not decodable, e.g. the capture started mid-connection) or is
  a single object instead of an array, `for…of` throws a `TypeError` and the whole upload fails. For the
  `:authority` header: the first value becomes `conn.probable_url`. A different later value gives
  `console.error("Trying to guess URL for connection, but getting conflicting values", value, conn)`.
- headers and data frames: if `flags_tree["http2.flags.end_stream"]` is present (`"0"` or `"1"`, both truthy),
  `stream_end = (value === "1")`.
- data frames: `byte_length = frameLength`.
- Event data:

```ts
{ stream_id: type !== "magic" ? parseInt(frame["http2.streamid"]) : -1,
  payload_length: frameLength, header_length: headerLength,
  frame: { frame_type, [headers], [stream_end], [byte_length] } }
```

- `DEBUG_HTTPtotalSize += headerLength + frameLength`.

#### 3.9.8 Finalization (`:100-154`)

Per connection:
1. `title += " => " + (probable_url ?? "Unknown URL")`.
2. If no trailer estimate: `console.error("TCPToQlog: unable to estimate TLS trailer size from this trace... " + title)`.
   Else `title += " @ " + T + " TLS trailer size"`. Example:
   `172.18.15.26:38080 -> 91.198.174.208:443 => upload.wikimedia.org @ 16 TLS trailer size`.
3. `events.sort((a, b) => a[0] - b[0])`: a stable sort on the (possibly faked) timestamp. Within one entry, TCP,
   then TLS records, then H2 frames all share one timestamp and keep that order. Across directions, interleaving is
   by time.
4. Debug ordering check (`:119-144`): dead code. It reads `evt[3].sequence_number`, which does not exist
   (`sequence_number` is in `header`), so "BADLY ORDERED SEQ NRS send"/"recv" never prints.
5. Push the trace. If `DEBUG_HTTPtotalSize !== DEBUG_TLSpayloadSize`:
   `console.error("HTTP doesn't fully fill TLS", "TLS: ", tls, "HTTP: ", http, tls - http)`.
6. After all: `console.warn("TCPToQlog: remember to add support for HTTP/2 padding to be fully compliant!")` and
   `console.log("TCPToQlog : done converting pcap", connectionMap.values())`.

Traces with zero events cannot happen here: every connection has at least its first TCP event.

### 3.10 How qvis loads TCP output (`QlogLoader.fromDraft02`, `QlogLoader.ts:47-169`)

- `"draft-02-wip"` → `fromDraft02`. `EventFieldsParser`: `time` present, so ABSOLUTE_TIME. `subtractTime = events[0].time`.
  `relativeTime = time - first` (in seconds, read as ms: section 3.9.1).
- **QUIRK / BUG (confirmed by a static port, section 8.9.4):** for every event, `fix02Compatibility(data)`
  (`:359-394`) does: `if (data.header.payload_length) { data.raw = data.raw || {}; data.raw.payload_length = data.header.payload_length; delete data.header.payload_length; }`.
  So every TCP packet with a payload, and every TLS record with a payload, **loses `header.payload_length`**.
  `PacketizationTCPPreProcessor` reads `data.header.payload_length`:
  - TCP: `payload_length === 0` is false for `undefined`, so `length = header_length + undefined = NaN`.
  - TLS: `Math.max(0, undefined) = NaN`. `extractRanges(ranges, NaN)` never reaches `remainingLength === 0`, and
    each loop iteration `shift`s one range and `unshift`s a split remainder, so the **loop never terminates while
    ranges remain**.

  Result: on qvis HEAD the packetization diagram for TCP traces hangs or renders NaN. The field move came in with
  commit `d62e85a` (2021-01-06, "Deal with field moved from header.payload_length to raw.payload_length"),
  which updated the QUIC path but not `PacketizationTCPPreProcessor` (last changed in 2020). PARITY target = the
  **intended pre-2021 behaviour** (section 3.11, golden numbers in section 3.13). In the new format, payload lengths live in
  `raw.payload_length` and the preprocessor reads them from there (section 8.7).
- The order check passes (already sorted).

### 3.11 Main consumer: `PacketizationTCPPreProcessor.process(conn, direction)` (`PacketizationTCPPreProcessor.ts:10-343`)

Selected by `PacketizationDiagramD3Renderer.renderLive` when `connection.commonFields.protocol_type === "TCP_HTTP2"`
(`PacketizationDiagramD3Renderer.ts:119-124`). Otherwise the QUIC preprocessor is used. The renderer draws the
top diagram with `receiving` and the bottom diagram with `sending` (`PacketizationDiagramRenderer.vue:50-51`).
Rendering mechanics are in the packetization spec. This section fixes the **data contract** with the converter.

Event selection (type-only name comparisons, category ignored):

| direction | TCP | TLS | HTTP/2 |
|---|---|---|---|
| receiving (top) | `packet_received` | `record_parsed` | `frame_parsed` |
| sending (bottom) | `packet_sent` | `record_created` | `frame_created` |

`HTTPHeadersSentEventType` (request headers that name a stream's resource): `frame_parsed` if the vantage point is
`server`, `frame_created` if `client`, `undefined` otherwise. The converter always says `client`, so it is
`frame_created`, independent of `direction`.

Algorithm (one pass over `getEvents()` in order):

```
TCPmax = 0; TCPindex = TLSindex = HTTPindex = 0
TCPPayloadRanges = []  (FIFO of {start,size});  TLSPayloadRanges = []
for event:
  if name == TCP:
     if header.payload_length === 0: continue                             // pure ACK/SYN/FIN
     TCPData += {index:TCPindex, isPayload:false, start:TCPmax, size:header_length, color: even?"black":"grey", lowerLayerIndex:-1, rawPacket:data}
     TCPData += {index:TCPindex, isPayload:true,  start:TCPmax+header_length, size:payload_length, same color}
     TCPPayloadRanges.push({start:TCPmax+header_length, size:payload_length})
     TCPmax += header_length + payload_length; TCPindex++
  else if name == TLS:
     payload = max(0, header.payload_length); recordLength = header_length + payload + trailer_length
     for r of extractRanges(TCPPayloadRanges, header_length): TLSData += {isPayload:false, contentType, index:TLSindex, lowerLayerIndex:TCPindex-1, start, size, color: even?"red":"pink", extra:{DEBUG_wiresharkFrameNumber, record_length, payload_length}, rawPacket}
     for r of extractRanges(TCPPayloadRanges, payload):       TLSData += {isPayload:true, ...same}; if contentType=="application": TLSPayloadRanges.push(r copy)
     if trailer_length != 0: for r of extractRanges(TCPPayloadRanges, trailer_length): TLSData += {isPayload:false, ...same}
     TLSindex++
  else if name == HTTP:
     if header_length > 0:                                                // magic has 0
        for r of extractRanges(TLSPayloadRanges, header_length):
           HTTPData   += {isPayload:false, contentType:data.content_type /*always undefined*/, index:HTTPindex, lowerLayerIndex:TLSindex-1, start, size, color: even?"blue":"lightblue", extra:{frame_length:header_length+payload_length}, rawPacket}
           if stream_id !== undefined: StreamData += {isPayload:true /*sic*/, ..., color: StreamIDToColor(""+stream_id, "HTTP2")[0]}
     if payload_length > 0:
        for r of extractRanges(TLSPayloadRanges, payload_length): HTTPData += {isPayload:true,...}; StreamData += {...}
        if frame.frame_type == "data" and stream_id != 0:
           if HTTPStreamInfo.has(id): HTTPStreamInfo.get(id).total_size += payload_length
           else console.error("PacketizationTCPPreprocessor: trying to increase payload size sum, but streamID not yet known! Potentially Server Push (which we don't support yet)", …)
     else if frame.frame_type != "settings": console.warn("PacketizationTCPPreprocessor: Found HTTP frame without payload length... potential error?", data)
     HTTPindex++
  if name == HTTPHeadersSentEventType and data.frame.frame_type == "headers":   // separate if: also runs for HTTP events of the other direction
     if !HTTPStreamInfo.has(stream_id): HTTPStreamInfo.set(stream_id, {headers: frame.headers, total_size: 0})
     else console.error("PacketizationTCPPreprocessor: HTTPStreamInfo already had an entry for this stream", …)
after: if TCPPayloadRanges or TLSPayloadRanges non-empty: console.error("PacketizationTCPPreprocessor: Not all payload ranges were used up!", …)
       if TLS payload total != HTTP total: console.error("TLS payload size != HTTP payload size", "TLS: ", a, "HTTP: ", b, "Diff : ", |a-b|)
lanes (index 0 = bottom):
  { name: "TCP",        CSSClassName: "tcppacket",    ranges: TCPData,    rangeToString: tcpRangeToString }
  { name: "TLS",        CSSClassName: "tlspacket",    ranges: TLSData,    rangeToString: tlsRangeToString }
  { name: "HTTP/2",     CSSClassName: "httppacket",   ranges: HTTPData,   rangeToString: r => httpRangeToString(r, HTTPStreamInfo) }
  { name: "Stream IDs", CSSClassName: "streampacket", ranges: StreamData, rangeToString: r => streamRangeToString(r, HTTPStreamInfo), heightModifier: 0.6 }
```

`extractRanges(ranges, size)` (`PacketizationDiagramModels.ts:139-201`) consumes `size` bytes from the front of
the FIFO. Whole ranges are moved to the output. The last range is split, and its remainder goes back to the
front. `size === 0` → `console.warn("Trying to extract ranges for size 0... potential error? Skipping...")`,
returns `[]`. Splitting a 5-byte header → `console.warn("Splitting a header range... server is being bad/naive?", size)`.
The sanity `alert`s are in section 2.3. This is why the design works: TLS consumes the TCP byte stream in order,
and HTTP/2 consumes the application-record payload byte stream in order, independent of which TCP packet tshark
attached a record or frame to.

Stream colours (`ColorHelper.StreamIDToColor(id, "HTTP2")`): LUT `0 #FF0000`, `1 #E1DA4C`, `3 #6B067F`,
`5 #E17426`, `7 #914ca8`, `9 #99CBDF`, `11 #C72737`, `13 #BBC585`, `15 #7D787A`, `17 #6CAD58`, `19 #D580AA`,
`21 #4C61B9`, `23 #D38E75`, `25 #46198C`, `27 #C8A454`. Ids > 27 use `id % 28`. Anything not found (even ids,
`-1` for magic) → `"lavenderblush"`.

Tooltips (verbatim, HTML):

- TCP: `"TCP " + (isPayload ? "Payload #" : "Header #") + index + " : packet size " + size + "<br/>"`
- TLS: `"TLS " + (isPayload ? "Payload #" : (size > 5 ? "Trailer (MAC/auth tag/padding/content type) " : "Header #")) + index + " (TCP index: " + lowerLayerIndex + ") : record size " + extra.record_length + ", partial size " + size + "<br/>"`,
  then `"Wireshark frame number (DEBUG): " + n + "<br/>"` if `DEBUG_wiresharkFrameNumber` is truthy, then
  `"content type: " + contentType`. QUIRK: a trailer piece of ≤ 5 bytes is labelled "Header #".
- HTTP/2: `"H2 " + (isPayload ? "Payload #" : "Header #") + " (TLS index: " + lowerLayerIndex + ") : frame size " + rawPacket.payload_length + ", partial size : " + size + "<br/>" + "frame type: " + rawPacket.frame.frame_type + ", streamID: " + rawPacket.stream_id`,
  then `"<br/><b>STREAM END BIT SET</b>"` if `frame.stream_end`, then, if the stream is in `HTTPStreamInfo`,
  `"<br/>" + method + ": " + path + "<br/>" + "total resource size: " + total_size + "<br/>"` (from the `:method`
  and `:path` headers). QUIRK: no index number after "#".
- Stream IDs: `"H2 streamID: " + rawPacket.stream_id` plus the same STREAM END and method/path/total parts.

Renderer texts for TCP traces: lane labels as above. Bottom legend `"Bytes received"` (top diagram) /
`"Bytes sent"` (bottom). Flow label `"Data received by client from server (trace vantagepoint = client)"` (top)
and `"Data sent from client to server (trace vantagepoint = client)"` (bottom). There are no
`max receiving size …` or `efficiency …` labels, since the TCP lanes do not set `max_size_local` / `efficiency`.

### 3.12 Incidental consumers

- **Netlog output** is ordinary QUIC/H3 qlog. It feeds every QUIC view through the normal lookups:
  `transport:packet_sent/received` (frames, `raw.length`), `recovery:packet_lost`, `transport:parameters_set`
  (`owner`, `initial_max_*`, `max_packet_size`), `http:frame_created/parsed` (`headers`, `byte_length`),
  `http:stream_type_set`, `http:parameters_set`. Lost packets have `packet_type: "unknown"`, so the congestion
  graph cannot match them to sent packets and logs "Packet was LOST that we didn't send... ignoring"
  (`CongestionGraphD3Renderer.ts:1385-1389`). In qvis, netlog losses do not show in the congestion graph. PARITY
  by default (T3 can resolve the type, section 8.4).
- **TCP output** uses category `transport` and the names `packet_sent`/`packet_received`, so QUIC views pick it up
  as if it were QUIC. The sequence diagram draws TCP packets as arrows labelled `"1RTT : <frame number>"`. The
  congestion graph plots `raw.length` per "packet number" = capture frame number, with no ACK information (no
  frames). The stats view counts them. Type-only checks (`data-model.md` §4.2) also match `http2:frame_created`
  (for example the sequence diagram's HEADERS short label). This was never designed, but users saw it. Decision C4
  (section 8.11) keeps it with a data-model alias.

### 3.13 Golden values for `wikipedia_Playstation.json` (qvis TCPToQlog semantics, computed with a faithful port)

| Item | Value |
|---|---|
| Entries / TCP entries | 183 / 183 |
| Traces | 1 |
| Title | `172.18.15.26:38080 -> 91.198.174.208:443 => upload.wikimedia.org @ 16 TLS trailer size` |
| Events | 394: `packet_sent` 68, `packet_received` 115, `record_created` 28, `record_parsed` 72, `frame_created` 54, `frame_parsed` 57 |
| Trailer estimate | 16, from capture frame 29. 21 earlier application records (frames 14-26, 28) retroactively adjusted |
| TLS content types | application 89, handshake 9, change-cipherspec 2 |
| HTTP/2 frame types | headers 44, data 32, window_update 24, priority 6, settings 4, magic 1 |
| Stream ids (count) | -1 (1), 0 (6), 3/5/7/9/11/13 (1 each), 15…57 odd (4-5 each) |
| TCP payload bytes | sent 3599, received 130494 |
| Σ TLS application payload (after trailer) | 127506 = Σ HTTP/2 (header + payload) 127506 (no "HTTP doesn't fully fill TLS") |
| Time (raw seconds) | first `1582210168.496779237`, last `1582210168.968980487` (span 472.20125 ms) |
| Console | 51× "empty HTTP/2 frame", 1× trailer estimated. No ordering warnings, no alerts |
| Packetization, receiving (top) | lanes TCP 214 ranges (107 data packets), TLS 296, HTTP/2 196, Stream IDs 196; xMax 133918 bytes; all ranges consumed, no alerts |
| Packetization, sending (bottom) | TCP 38 (19 data packets), TLS 80, HTTP/2 106, Stream IDs 106; xMax 4207 |
| `HTTPStreamInfo.total_size` (receiving) | 15:4333, 17:394, 19:13370, 21:11310, 23:7414, 25:11716, 27:426, 29:477, 31:532, 33:203, 35:10007, 37:8553, 39:11664, 41:11031, 43:590, 45:4001, 47:140, 49:7854, 51:9168, 53:4741, 55:416, 57:1436 |

---

## 4. Event and field consumption

### 4.1 NetLog fields read

| Location | Fields | Use |
|---|---|---|
| `constants` | `logEventTypes`, `logSourceType`, `logEventPhase` (`timeTickOffset` read but unused) | number→name maps |
| `events[]` | `source.type`, `source.id`, `type`, `phase`, `time`, `params` | routing, grouping, time |
| params per event | see the table in section 3.4 | mapping |

### 4.2 tshark fields read

| Path under `_source.layers` | Use |
|---|---|
| `ip.src`, `ip.dst` / `ipv6.src`, `ipv6.dst` | connection key, title |
| `tcp.srcport`, `tcp.dstport` | connection key, title |
| `tcp.seq` | ordering checks, `header.sequence_number` |
| `tcp.len`, `tcp.hdr_len` | payload/header length |
| `frame.time_epoch` | event time |
| `frame.number` | `header.packet_number` (TCP), `DEBUG_wiresharkFrameNumber` (TLS) |
| `tls` (dict/array/string), `tls.record`, `tls.record.content_type`, `tls.record.length`, `tls.app_data`, `tls.segment.data` (presence) | TLS records |
| `tls.segments` (presence) | trailer heuristic guard |
| `http2`, `http2.stream`, `http2.magic`, `http2.length`, `http2.type`, `http2.streamid`, `http2.flags_tree.http2.flags.end_stream`, `http2.header[].http2.header.name/value` | HTTP/2 frames |

### 4.3 Old output fields → consumers (re-verified against the qvis source)

qvis matched most events on the **type part only** (`evt.name` is the text after the category, `data-model.md`
§4.2), and several consumers scan **every** event of a trace for a member ("shape" below). The converter output
therefore reached more views than its authors designed. Every row below was checked in the source; paths are
relative to `src/components/`. Section 9 gives the latest-draft path for each row.

Abbreviations: `SEQ` = `sequencediagram/renderer/SequenceDiagramD3Renderer.ts`, `CG` =
`congestiongraph/renderer/CongestionGraphD3Renderer.ts`, `ST` = `stats/StatisticsConnectionRenderer.vue`, `PQ` =
`packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts`, `PT` = `.../PacketizationTCPPreProcessor.ts`,
`MX*` = `multiplexinggraph/renderer/MultiplexingGraphD3{Collapsed,Waterfall,Simulation,Byteranges}Renderer.ts`.

#### 4.3.1 TCP converter output

| Old event + field | Consumer (qvis line) | Use |
|---|---|---|
| trace `common_fields.protocol_type === "TCP_HTTP2"` | `packetizationdiagram/renderer/PacketizationDiagramD3Renderer.ts:119-124` | selects `PT` instead of `PQ` |
| trace `common_fields.protocol_type !== "TCP"` | `CG:1288` | gates one console message; never fires for TCP traces (no ACK frames) |
| trace `vantage_point.type` (`"client"`) | `PT:26-32`; packetization flow labels | `HTTPHeadersSentEventType = frame_created`; "(trace vantagepoint = client)" |
| `transport:packet_sent/received` `header.payload_length`, `header.header_length` | `PT:62-103` | TCP lane ranges and payload FIFO; `payload_length === 0` skips pure ACKs |
| same, `raw.length` | `CG:1120-1126`, `CG:1165-1167` | sent / received byte staircases (truthiness: 0 or missing skips the packet) |
| same, `header.packet_type` (`"1RTT"`) and `header.packet_number` (capture frame number) | `CG:1132-1137`, `CG:1173-1178` (map keys); `SEQ:1038-1068` (arrow matching across traces), `SEQ:1566` (chip `"1RTT : <n>"`), focus-on-PN; `ST:432-445` `encryptionLUT` (shape) | arrows, points, "Encryption levels" count |
| same, `header.sequence_number` | nothing (`tcptoqlog.ts:119-144` dead debug check) | — |
| `tls:record_*` `header.header_length`, `header.payload_length`, `header.trailer_length`, `header.content_type` | `PT:104-193`, tooltip `PT:354-368` | TLS lane, application-payload FIFO, "content type: …" |
| `tls:record_*` `header.DEBUG_wiresharkFrameNumber` | `PT:127`, `:151`, `:182`, tooltip `PT:360-361` | "Wireshark frame number (DEBUG): …" |
| `tls:record_*` `header.packet_type` (`"1RTT"`, "QUIC qlog compat mode") | `ST:432-445` `encryptionLUT` (shape: every event with `data.header.packet_type`) | **counted as `1RTT`**: the example file shows `1RTT` 283 (183 TCP packets + 100 TLS records). The earlier version of this table said "nothing"; that was wrong |
| `tls:record_*` `header.packet_number` (`""`) | nothing | — |
| `tls:record_*` (name only) | `SEQ:2220-2222` default label (type name `record_created` / `record_parsed`), default red `["#FF0000","#FFFFFF"]`; Stats events table | side labels |
| `http2:frame_*` `header_length`, `payload_length`, `stream_id`, `frame.frame_type`, `frame.headers` (`:method`, `:path`), `frame.stream_end` | `PT:194-327`, tooltips `PT:370-430` | HTTP/2 and Stream IDs lanes, `HTTPStreamInfo` |
| `http2:frame_*` `stream_id`, `frame.frame_type`, `frame.headers[].name/value` (`:method`/`method`, `:path`/`path`, `:authority`/`authority`, `:status`/`status`) | `SEQ:2122-2198` label and `SEQ:1963-1966` blue colour (type-only match on `frame_created` / `frame_parsed`) | side labels such as `"GET /wiki/X (stream 15)"` or `"data  parsed (stream 15)"` |
| `http2:frame_*` `frame.frame_type` | `ST:389-430` `totalFrameCount` / `frameLUT` (shape: every event with `data.frame`) | HTTP/2 frame types in the Frames histogram (example: headers 44, data 32, window_update 24, priority 6, settings 4, magic 1) |
| `http2:frame_*` `frame.headers` | **not** `ST:317-358` (H3 header row looks up category `http`; the TCP category is `http2`) | — |
| `http2:frame_*` `frame.byte_length` | nothing | — |
| any TCP / TLS / H2 event | multiplexing graph: nothing (no `frames`, no `data_moved`; H3 lookups use category `http`) | empty panels |

#### 4.3.2 Netlog converter output

| Old event + field | Consumer (qvis line) | Use |
|---|---|---|
| trace `common_fields.reference_time` (start tick, ms string) | `data/QlogLoader.ts` `EventFieldsParser` (`fromDraft01`) | `absoluteTime = time + tick`; cross-trace alignment |
| trace `common_fields.protocol_type: "QUIC_HTTP3"` | `PacketizationDiagramD3Renderer.ts:119-124` (not `TCP_HTTP2` → `PQ`); `CG:1288` gate | routing only |
| trace `vantage_point.type` (`"client"`) | `PQ:23-29` (`HTTPHeadersSentEventType = frame_created`); `MXWaterfall:105-115` and `MXSimulation:91-100` (client: `frame_created`, data on `packet_received`); sequence diagram column | perspective |
| `transport:packet_sent/received` `header.packet_type`, `header.packet_number` | `SEQ:494-515`, `:1038-1068`, `:1566`, vantage guess; `CG:1132-1137`, `:1173-1178`; ACK matching keyed by the **carrying** received packet's type `CG:1262`, `:1346`; `MXCollapsed:440` (`packetNumber`); `PQ` tooltips; `ST:432-445` | arrows, ACK/loss matching, Encryption levels |
| same, `raw.length` | `CG:1120-1126`, `:1165-1167`; `PQ:217-254` (no `raw.payload_length` in netlog output, so header = `min(4, length)`, payload = `length - header - 16`, trailer 16) | byte offsets, QUIC packet lane |
| same, `frames[].frame_type` (every frame) | `ST:389-430` (shape); `SEQ:1752-1939` frame chips (`frameToShortString`) and colours (`frameTypeToColor`); `PQ:305-400` frame lane | counts, chips, lanes |
| frame `stream` `stream_id`, `offset`, `length`, `fin` (strings except `fin`) | `MXCollapsed:405-451` (`isDataStream(stream_id)`, `offset`, `length`), `MXByteranges:92`, `:200-215`, `MXWaterfall:253`; `PQ:367-392`, `:644-648`, `:686-689` (`frame_size = 1 + length`, payload ranges per stream, FIN tooltip); `SEQ:1820-1822` `"stream <id>[ FIN]"` | multiplexing, packetization, chips |
| frame `crypto` `length` (`offset` unused) | `PQ:686-689` (`if (frame.length)` splits header and payload; CRYPTO frames get the leftover share as `frame_size`, so the header part can be negative) | packetization |
| frame `ack` `acked_ranges` (`[["a","b"]]`, strings) | `CG:1240-1285` (`parseInt`, ACK→sent matching); `SEQ:1794-1818` chip `"ack 3-5,9"` | ACK lines, chips |
| frame `max_data` `maximum` | `CG:1205-1211` (received packets only, `parseFloat`); `ST:474-483` (received = remote, sent = local); `SEQ:1861-1868` `"max data N"` | FC lines and tables |
| frame `max_stream_data` `stream_id`, `maximum` | `CG:1213-1229` (sum over streams); `ST:521-545`; `SEQ:1851-1858` (truthiness on both) | FC lines and tables |
| frame `reset_stream` `stream_id`, `error_code` (`final_size` unused) | `SEQ:1907-1919` `"reset stream N (code)"` | chip |
| frame `stop_sending` `stream_id`, `error_code` | `SEQ:1921-1933` | chip |
| frame `connection_close` `error_code`, `raw_error_code`, `reason` (`error_space` unused) | `SEQ:1825-1849` `"connection_close : clean"` / `"connection_close <code> : <reason>"` | chip |
| frames `padding`, `ping` | frame_type only | chips, counts |
| `transport:parameters_set` `owner` + `initial_max_data`, `initial_max_stream_data_bidi_local`, `initial_max_stream_data_bidi_remote`, `initial_max_stream_data_uni` | `ST:466-472`, `ST:505-517` (`parseInt`, `NaN` when absent) | Stats flow-control tables |
| `transport:parameters_set` `owner === "remote"` + `initial_max_data`, `initial_max_stream_data_bidi_remote` | `CG:1094-1107` (truthiness, `parseFloat`; the trailing `]` quirk of section 3.6 is harmless here because `parseFloat("123]") === 123`) | congestion graph flow-control lines (omitted from the earlier version of this table) |
| `transport:parameters_set` `owner` + `max_packet_size` | `PQ:464-478` | "max receiving size" labels; 2020 Chrome only. Current Chrome logs `max_udp_payload_size`, so qvis showed the 65527 default |
| `transport:parameters_set` (key count) | `SEQ:2050-2065` `Object.keys(data).length + " transport parameters set"`, purple `SEQ:1956-1962` | side label |
| `recovery:packet_lost` `header.packet_type` (`"unknown"`), `header.packet_number` | `CG:1370-1393` (no sent map for type `unknown` → "Packet was LOST that we didn't send... ignoring"); `SEQ:2099-2111` `"unknown packet lost #N"`; `ST:432-445` | label; loss not plotted |
| `transport:packet_dropped` `header.packet_type` (`packet_number: ""` unused) | `ST:432-445`; `SEQ` default label `packet_dropped` | count, label |
| `http:stream_type_set` | **no field is read** (`multiplexinggraph/renderer/MultiplexingGraphDataHelper.ts:5-7` classifies data streams by `stream_id % 4 === 0`); `SEQ` default label `stream_type_set`; Stats events table. The earlier version of this table claimed multiplexing/packetization use; that was wrong | display only |
| `http:parameters_set` (key count) | `SEQ:2050-2065` `N + " HTTP/3 parameters set"`. N is **always 4** for netlog output: the object literal at `netlogtoqlog.ts:776-781` creates all four keys even when their value is `undefined` | side label |
| `http:frame_created/parsed` `stream_id`, `frame.frame_type`, `frame.headers` | `SEQ:2122-2198`; `MXSimulation:91-124` (`:method` + `:path`); `MXWaterfall:160-198` (HEADERS marker, `priority` header); `ST:317-358` (`server`, `user-agent`, `:authority`); `PQ:452-462` (`HTTPStreamInfo`) | labels, waterfall, H3 header row, tooltips |
| `http:frame_parsed` DATA `byte_length` | `PQ:408-449`, `PQ:67` (header varint size), DATA `total_size` `PQ:182-198`. HEADERS have none → "H3 frame didn't have byte_length set! skipping..." | H3 lane |
| `http:frame_*` `frame.frame_type` | `ST:389-430` (shape) | Frames histogram |
| `info:marker` (string `data`) | `SEQ:2201-2216` → label `"marker"` (no `data.message`); colour by category `info` → lightgrey `["#D3D3D3","#000000"]` (`SEQ:1977-1979`); Stats events table (`info` → `marker`) | side label |

### 4.4 Inputs the port reads beyond qvis (T2/T3, section 8)

| Input | Tier | Used for |
|---|---|---|
| netlog `constants.timeTickOffset` | NEW | `reference_time.epoch` (8.4) |
| netlog `ietf_error_code` (RST_STREAM, STOP_SENDING), `quic_wire_error`, `close_type` (CONNECTION_CLOSE) | T2 | wire error names (8.5.5) |
| netlog `SETTINGS_MAX_FIELD_SECTION_SIZE` | T2 | `max_field_section_size` (8.5.4) |
| netlog `headers` as a list of `"name: value"` strings | T2 | 8.5.3 |
| netlog `delta_time_largest_observed_us`, `ECT0`/`ECT1`/`CE`, `num_padding_bytes`, `transmission_type`, `transport_close_frame_type`, `from_peer`, `quic_error`/`details` (CLOSED), HEADERS_RECEIVED `payload_length`, PRIORITY_UPDATE `type`/`prioritized_element_id`/`priority_field_value`, UNKNOWN_FRAME `frame_type`/`payload_length`, GOAWAY `stream_id`, MAX_PUSH_ID / CANCEL_PUSH `push_id`, frame params of NEW_CONNECTION_ID, RETIRE_CONNECTION_ID, MAX_STREAMS, STREAMS_BLOCKED, PATH_*, NEW_TOKEN, MESSAGE, `versions` / `version`, PACKET_RECEIVED `peer_address` / `self_address` | T3 | 8.4 and 9.7 |
| tshark `tls.record.version` | T2 | `header.version` |
| tshark `frame.time_utc` / `frame.time` | T2 | time fallback (8.6.3) |
| tshark `tls.record.opaque_type`, `tcp.ack`, `tcp.window_size`, `tcp.flags_tree.tcp.flags.{syn,ack,fin,reset,push}`, `http2.type` 10/12/16 | T3 | 8.6.4 |

---

## 5. URL query parameters and global state

- No query parameter is specific to the converters. `?file=<url>` with a URL containing `.netlog` or `.json`
  reaches them through `FileLoader.Load(text, url)` (extension or sniff on the URL string). `?list=`, `?file1=`
  and pcap URLs go to the backend (`file-loading.md` §5.1).
- Global state: none. Both converters are static, stateless functions with function-local maps. The only shared
  static state they touch indirectly is `ColorHelper`'s lazily filled LUTs (consumer side).
- qvis-react: converters are pure functions in `src/converters/*` (no store, no DOM, no `alert`, no
  `console.*` in normal paths). They return `{ qlog, diagnostics }`. The loading layer (`src/loading/`) shows
  toasts from the diagnostics (section 8.8).

---

## 6. Edge cases, error handling, notifications

### 6.1 Exceptions → user-visible result

Any exception thrown inside a converter rejects `FileLoader.Load`. The upload shows "Error uploading file". The
URL path shows `"ERROR loading URL " + url` (`ConnectionStore.ts:329-335`). Known throwing inputs:

| Converter | Input | Exception |
|---|---|---|
| netlog | truncated file (Chrome still writing or crashed) | `JSON.parse` SyntaxError (before the converter) |
| netlog | missing `constants` / `events` | TypeError |
| netlog | ACK without `smallest_observed` | TypeError `undefined.toString()` |
| netlog | `QUIC_SESSION_STREAM_FRAME_*` without `offset` etc. | TypeError |
| tshark | HEADERS frame without `http2.header`, or a single header object | TypeError (not iterable) |
| tshark | string inside a `tls` array | RangeError (infinite recursion) |
| tshark | input not an array | TypeError (`for…of`) |

### 6.2 Console catalogue (verbatim; qvis-react turns these into diagnostics, section 8.8)

netlog: see sections 3.3 and 3.4 (`netlog2qlog:convert : unknown source type!`, `… unknown event type!`,
`… unknown event phase!`, `netlogtoqlog:convert : new connection found, but first event was not QUIC_SESSION! Not sure this will work...`,
`netlogtoqlog:convert : connection starting in phase other than PHASE_BEGIN! Not sure this will work...`,
`netlog2qlog:convert : could not match event to connection` (unreachable), `netlog2qlog:convert: unknown packet type sent`,
`netlog2qlog:convert : unknown QUIC event, not supported yet!`, `netlogtoqlog:convert : QUIC connection found but not events logged for this one ...`).

tshark: see sections 3.9.1-3.9.8 (`UNORDERED SEQ NUMBERS`, `Mismatched timestamps, but sequence numbers were correctly ordered: faking timestamp instead`,
`UNORDERED TIMESTAMPS`, `tcp2qlog: empty TLS record... ignoring`, `TLS object was not iterable, skipping. Typically only if we have TLS Unknown Record!`,
`tcptoqlog: More than two TLS entries... what is happening?`, `tcptoqlog: No tls.record... what is happening?`,
`tcp2qlog: empty HTTP/2 frame... ignoring (expected if TLS record contains a small piece of the H2 frame. Look at the tls.segment.data array contents: 2nd entry should be +- 9 bytes)`,
`HTTP/2 object was not iterable, skipping. Haven't seen this before!`, `Weird inconsistencies between frame sizes`,
`no tls.record.length set... weird`, `tcptoqlog: Record length is different from app_data length`,
`tcptoqlog: TLS application record without app data... weird?`, `TCPToQlog: TLS trailer size is not 16, 17, 8 or 24: potential error! TODO: actually check with negotiated cipher what is expected here!`,
`TCPToQlog: TLS trailer size estimated`, `TCPToQlog: adjusting for TLS trailer size lead to negative size...`,
`TCPToQlog: guesstimated TLS trailer size was inconsistent`, `Unknown field found in TLS record: ` (+ alert),
`TLS record without payload... seems weird`, `Trying to guess URL for connection, but getting conflicting values`,
`TCPToQlog: unable to estimate TLS trailer size from this trace... `, `HTTP doesn't fully fill TLS`,
`TCPToQlog: remember to add support for HTTP/2 padding to be fully compliant!`, `TCPToQlog : done converting pcap`,
`Created new connection #`, `TCPToQlog: converting file with N events`).

### 6.3 Edge-case table

| Case | qvis behaviour | qvis-react |
|---|---|---|
| netlog with no QUIC sessions (TCP/H2-only browsing) | zero traces; success toast; group " (0 connections)" | PARITY output (zero traces) + warning toast `"No QUIC connections found in this Chrome netlog."` (NEW, section 8.8) |
| netlog session with no mapped events (e.g. timeout-only `QUIC_SESSION_CLOSED`) | trace dropped + console.warn | PARITY (dropped) + info diagnostic |
| netlog source starts mid-session (capture started late) | title `undefined-undefined` (or `<host>-undefined`), warnings | FIX (T2): title from the first event with `host`, else `"QUIC session " + sourceId` (decision C7) |
| netlog truncated | upload fails | FIX: repair (section 8.5.6) |
| netlog `params.headers` as list (current Chrome) | garbage header pairs | FIX (T2): parse `"name: value"` strings |
| last received packet's frames | lost | FIX (T2): flush |
| coalesced received datagram (several UNAUTHENTICATED headers after one PACKET_RECEIVED) | one `packet_received` with the last header and all frames merged; size = datagram size | PARITY (T1/T2); T3 splits |
| netlog times | integer ms, many equal | PARITY; ordering kept by stable sort |
| tshark JSON of a QUIC-only capture | zero traces (UDP skipped); success toast | PARITY output + warning toast `"No TCP connections found in this tshark JSON. QUIC captures need pcap2qlog (not available in this deployment)."` |
| tshark capture not decrypted | TLS records `application` with no `http2` layer; no H2 frames; trailer never estimated (title without " @ …"); TLS lane only | PARITY |
| TLS 1.3 records with only `tls.record.opaque_type` | `content_type: "unknown"`; no TLS payload ranges; H2 extraction alerts "Trying to fill payloadranges that aren't there!" | PARITY by default; T3 option uses `opaque_type` |
| HTTP/2 over cleartext (h2c, no TLS) | H2 frames but no TLS records; packetization alerts | PARITY (documented limitation); diagnostic `tshark.h2-without-tls` |
| TCP retransmissions / out-of-order segments | payload counted twice; packetization ranges misalign; console errors | PARITY (limitation); diagnostic counts `tshark.seq-unordered` |
| Capture starting with server→client packet | roles flipped (server treated as client) | PARITY; diagnostic `tshark.first-packet-from-server-port` when the first packet's src port is 443/80 and dst port is not |
| Multiple TCP connections | one trace each, in first-seen order | PARITY |
| Wireshark versions adding TLS record keys (`tls.app_data_proto`, …) | one `alert()` per key per record | FIX: one aggregated warning diagnostic, no alert |

---

## 7. Known bugs and quirks (decisions)

| # | Quirk | Where | Decision |
|---|---|---|---|
| Q1 | TCP event times are seconds but read as ms (1000× compressed time axis) | `tcptoqlog.ts:164`, loader | FIX: emit ms |
| Q2 | Loader `fix02Compatibility` moves `header.payload_length` to `raw`, which breaks or hangs the TCP packetization | `QlogLoader.ts:375-393` (commit `d62e85a`) | FIX: the new schema stores it in `raw.payload_length`, and the TCP preprocessor reads it there |
| Q3 | `alert()` per unknown TLS record key | `tcptoqlog.ts:509` | FIX: aggregated diagnostic |
| Q4 | HEADERS without/with single `http2.header` crashes the conversion | `:642` | FIX: normalise to array |
| Q5 | String inside a TLS array → infinite recursion | `:245-279` | FIX: skip strings |
| Q6 | Lone magic as a single `http2.stream` object is not patched (NaN lengths) | `:330-338` | FIX: patch magic wherever it appears |
| Q7 | "No tls.record" returns early and drops the entry's HTTP/2 frames | `:302-306` | PARITY (keep the frames dropped; diagnostic) |
| Q8 | Trailer heuristic compares each record with the sum of all frames; magic counted with +9 | `:441-487` | PARITY (it defines the title and all TLS sizes) |
| Q9 | Debug sequence-order check is dead code | `:119-144` | drop |
| Q10 | Connection keyed by one endpoint; first packet decides the client | `:55-91` | PARITY (diagnostic, see 6.3) |
| Q11 | Last received packet loses its frames; leftover tx frames dropped | `netlogtoqlog.ts:505-544` | FIX (T2): flush at end |
| Q12 | H3 headers list format → `{name:"0", value:":method: GET"}` | `:802-804` | FIX (T2) |
| Q13 | Transport parameter pairing breaks on flags/multi-token values; trailing `]` | `:311-326` | FIX (T2): tokenizer |
| Q14 | `max_header_list_size` undefined for current Chrome (`SETTINGS_MAX_FIELD_SECTION_SIZE`) | `:776-781` | FIX (T2): accept both |
| Q15 | STOP_SENDING `error_code` undefined for current Chrome | `:428-434` | FIX (T2): `ietf_error_code ?? application_error_code ?? quic_rst_stream_error` |
| Q16 | CONNECTION_CLOSE always transport space; internal `quic_error` as code | `:445-456` | FIX (T2): `close_type`, `quic_wire_error` |
| Q17 | ACK without `smallest_observed` crashes; first range can be inverted | `:93-130` | FIX (T2) |
| Q18 | HANDSHAKE_DONE, MAX_PUSH_ID, PRIORITY_UPDATE, DATA_SENT, GOAWAY, unknown H3 frames, NEW_CONNECTION_ID etc. not emitted | various | PARITY (T1/T2); T3 option |
| Q19 | `packet_lost`/`packet_dropped` types mostly `unknown` | `:606-668` | T2: `packet_dropped` maps all four encryption levels; `packet_lost` stays `unknown` (T3 resolves) |
| Q20 | `timeTickOffset` ignored (no absolute time) | `:215-216` | FIX (NEW): `reference_time.epoch` from it (no visible change in relative times) |
| Q21 | Marker `data` is a bare string (shows "marker") | `:849-860` | NEW: `loglevel:info {message}` (decision C8, section 9.3.10). Sequence label becomes `"info: CERT_VERIFIER_REQUEST BEGIN"`; the lightgrey colour is unchanged |
| Q22 | Unknown-event warning per event (huge console spam on real netlogs) | `:864` | FIX: one aggregated diagnostic per event type |
| Q23 | `missing_packets.sort` mutates the input | `:101` | do not mutate inputs (copy) |
| Q24 | Upload note "Chrome netlog must be explicitly given the .netlog extension" is outdated | `FileManagerContainer.vue:79` | PARITY text (file-loading owns it) |
| Q25 | `Download` of a converted group emits draft-02 via `Convert01to02`; the netlog marker string becomes `{"0":"C","1":"E",…}` | `QlogSchemaConverter.ts:126-129` | FIX: Download serializes the converter's latest-draft output (file-loading §3.11) |

---

## 8. Porting notes for React (qvis-react)

### 8.1 Module breakdown

```
src/converters/
  common/
    diagnostics.ts        re-export of src/qlog/parse/diagnostics.ts (Diagnostic, DiagnosticCollector); helper countOnce(code)
    num.ts                num(x): number | undefined  (number, numeric string; NaN → undefined)
    envelope.ts           makeQlogFile(traces), constants FILE_SCHEMA_CONTAINED, SERIALIZATION_JSON
  netlog/
    index.ts              export function convertNetlog(input: unknown, opts?: NetlogConvertOptions): ConverterResult
    types.ts              NetLog input shapes (port of netlog.ts, both 2020 and current param names, all optional)
    session.ts            per-source state: trace builder, tx/rx frame buffers, rx packet, h3 control stream ids
    mapEvent.ts           the big switch (section 8.4), one function per event family
    ackRanges.ts          calculateAckRanges + T2 guards (section 8.5.2)
    transportParams.ts    parseChromiumTransportParameters (section 8.5.1)
    h3.ts                 headers parsing (8.5.3), settings mapping (8.5.4)
    errors.ts             wire error code → qlog string tables (8.5.5)
    repair.ts             truncated-netlog repair (8.5.6)
  tshark/
    index.ts              export function convertTshark(input: unknown, opts?: TsharkConvertOptions): ConverterResult
    parseTsharkJson.ts    dedup JSON parse (file-loading §3.6 rule) — or import from src/loading if implemented there
    connection.ts         TCPConnection state (keying, timestamp tracker, trailer estimate, probable URL)
    tls.ts                collectTlsRecords(layer), contentType(), trailer heuristic
    http2.ts              collectH2Frames(layer), frameTypeName(), headers
    schema.ts             private schema URIs + TS types for tcp:/tls:/http2: data (section 8.6.1)
    time.ts               epochSecondsStringToMs
src/components/packetizationdiagram/renderer/PacketizationTCPPreProcessor.ts   (consumer, section 8.7)
```

`ConverterResult = { qlog: QlogFile; diagnostics: Diagnostic[]; stats: Record<string, number> }`. The loading
layer passes `qlog` to `loadQlogFile`/`normalize` (the same object path a parsed `.qlog` takes). It also keeps
`qlog` on the group for Download. Converters must be synchronous, pure, and worker-safe (no DOM, no `window`), so
they can move into a Worker later (file-loading D11).

### 8.2 Options and tiers

```ts
interface NetlogConvertOptions {
  extended?: boolean;            // T3 mappings (default false)
  splitCoalescedReceived?: boolean; // T3 (default false; implies nothing else)
}
interface TsharkConvertOptions {
  extended?: boolean;            // T3: tcp flags/ack/window, opaque_type fallback, h2 type names ≥ 10
}
```

T1 is the mapping qvis had. T2 fixes are always on, with no option. They only change crashing, garbage or
missing-but-obviously-intended output. T3 adds information qvis never showed, and it changes what views draw, so
it stays off by default for parity.

### 8.3 Output envelope (both converters)

```json
{
  "file_schema": "urn:ietf:params:qlog:file:contained",
  "serialization_format": "application/qlog+json",
  "traces": [ <Trace>, ... ]
}
```

No `title`/`description` at file level (section 2.4). No `qlog_version`. Trace:

```json
{
  "title": "<see each converter>",
  "vantage_point": { "type": "client" },
  "common_fields": {
    "protocol_type": "QUIC_HTTP3" | "TCP_HTTP2",
    "time_format": "relative_to_epoch",
    "reference_time": { ... }
  },
  "event_schemas": [ ... ],
  "events": [ { "time": <ms float>, "name": "<ns>:<type>", "data": { ... } }, ... ]
}
```

`event_schemas` lists exactly the schemas used by the trace (decision C13, section 9.1 rule 8), including the private
`#chromium` extension URI whenever a `chromium_*` event-data field is emitted (C11).

`common_fields.protocol_type` is a custom common field (allowed: `CommonFields` has `* text => any`, and unknown
entries MUST be ignored by other tools). qvis-react reads it into `protocolHint` (`data-model.md` §3.16.6). That
keeps the packetization TCP switch and the congestion graph's `"TCP"` check working without new plumbing. Event
order: tshark output is stable-sorted by time before emission, so the loader never reorders it. Netlog output is
emitted in input order. Chrome logs in time order, and on the rare exception the loader's stable sort
(`data-model.md` §3.16.7) applies, exactly as qvis's loader sort did.

### 8.4 NEW netlog mapping (complete)

Trace per `QUIC_SESSION` source (insertion order of first event). Traces with zero events are dropped (PARITY).

- `title`: T1 `` `${host}-${connection_id}` ``. T2: if `connection_id` is undefined, use `host`. If `host` is
  undefined (source started mid-session), use `"QUIC session " + source.id`.
- `vantage_point`: `{type: "client"}`.
- `common_fields`: `protocol_type: "QUIC_HTTP3"`, `time_format: "relative_to_epoch"`, `reference_time`:
  - `timeTickOffset` parses as a finite number: `{clock_type: "system", epoch: new Date(timeTickOffset + startTick).toISOString()}`
    (both are integer ms, so the ISO string is exact). In `data-model.md` §3.16.3 this is **case R**:
    `relativeTime = time` (identical to qvis), `absoluteTime` = Unix ms (cross-trace alignment as in qvis).
  - otherwise: `{clock_type: "monotonic", epoch: "unknown"}` (case U: relative times then start at the first
    emitted event; a sub-ms to few-ms shift vs qvis, diagnostic `netlog.no-time-tick-offset`).
- `event_schemas` (C13, section 9.1 rule 8): `"urn:ietf:params:qlog:events:quic-13"` if a `quic:` event was emitted,
  `"urn:ietf:params:qlog:events:http3-13"` if an `http3:` event was emitted, `"urn:ietf:params:qlog:events:loglevel"`
  if a `loglevel:info` marker was emitted, and `` `${QVIS_SCHEMA_BASE}/quic#chromium` `` if any event data carries a
  `chromium_*` field (C11; `/http3#chromium` for the T3 `chromium_settings`), in that order. Use the URI constants in
  `src/model/names.ts` (`EVENT_SCHEMA_URI` + `EVENT_SCHEMA_DRAFT`). The `-13` suffix is required for draft
  implementations (quic-13 §2.1, h3-13 §2.1).
- Event `time` = `num(event.time) - startTick` (ms, integer). `startTick` = time of the session's first event
  (PARITY).

Mapping table (`buffer` = per-session tx/rx frame buffer as in section 3.3; all numbers are read via `num()` and written per C12, section 9.1 rule 3: a JSON number, or the original decimal string when the value is not a safe integer):

| NetLog event | Tier | New qlog |
|---|---|---|
| `QUIC_SESSION` | T1 | creates the trace, no event. T3: `quic:version_information {client_versions:[…]}` from `versions` (a list of Chrome version labels such as `RFCv1`, split on spaces/commas), each label mapped to hex as in section 9.7 (`RFCv1` → `00000001`, `RFCv2` → `6b3343cf`, `draft29` → `ff00001d`, 4-character gQUIC labels → hex of their ASCII bytes); unknown labels are skipped, and nothing is emitted when no label maps |
| `QUIC_SESSION_TRANSPORT_PARAMETERS_SENT` / `_RECEIVED` | T1+T2 | `quic:parameters_set {initiator: "local"/"remote", …parseChromiumTransportParameters(str)}` (8.5.1) |
| `QUIC_SESSION_TRANSPORT_PARAMETERS_RESUMED` | T3 | `quic:parameters_restored {…same parse, restricted to QUICParametersRestored keys}` |
| `*_CRYPTO_FRAME_*` | T1 | buffer `{frame_type:"crypto", offset, raw:{length: data_length}}` |
| `*_PADDING_FRAME_*` | T1 | buffer `{frame_type:"padding"}`. T3 adds `raw:{payload_length: num_padding_bytes}` |
| `*_PING_FRAME_*` | T1 | buffer `{frame_type:"ping"}` |
| `*_STREAM_FRAME_*` | T1 | buffer `{frame_type:"stream", stream_id, offset, fin, raw:{length}}` |
| `*_ACK_FRAME_*` | T1+T2 | buffer `{frame_type:"ack", acked_ranges}` (8.5.2). T3 adds `ack_delay: delta_time_largest_observed_us / 1000` (ms) and `ect0/ect1/ce` from `ECT0/ECT1/CE` |
| `*_WINDOW_UPDATE_FRAME_*` | T1 | `stream_id === -1` → `{frame_type:"max_data", maximum: byte_offset}`; else `{frame_type:"max_stream_data", stream_id, maximum: byte_offset}` (gQUIC uses stream 0 for the connection; PARITY: still treated as stream 0) |
| `*_RST_STREAM_FRAME_*` | T1+T2 | buffer `{frame_type:"reset_stream", stream_id, final_size: offset, …err}`. With `code = ietf_error_code`: `error = h3AppErrorName(code) ?? "unknown"` (+ `error_code: code` when unknown). Without it: `error: "unknown", error_code: quic_rst_stream_error`. Always also `chromium_rst_stream_error: quic_rst_stream_error` (extension) |
| `*_STOP_SENDING_FRAME_*` | T1+T2 | buffer `{frame_type:"stop_sending", stream_id, …err}`. `code = ietf_error_code ?? application_error_code`. If defined, map as above. Else `error:"unknown", error_code: quic_rst_stream_error` (if defined) |
| `*_CRYPTO_HANDSHAKE_MESSAGE_*` | T1 | nothing |
| `QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT` | T1+T2 | tx buffer `{frame_type:"connection_close", error_space, error, [error_code], reason: details, chromium_quic_error: quic_error}`. `error_space = close_type === "Application" ? "application" : "transport"`. `wire = quic_wire_error ?? quic_error`. transport: `error = transportErrorName(wire) ?? cryptoErrorName(wire) ?? "unknown"`; application: `error = h3AppErrorName(wire) ?? "unknown"`. `error_code: wire` only when `error === "unknown"`. T3 adds `trigger_frame_type: transport_close_frame_type` |
| `QUIC_SESSION_CONNECTION_CLOSE_FRAME_RECEIVED` | T3 | rx buffer, same mapping |
| `QUIC_SESSION_PACKET_SENT` | T1 | `quic:packet_sent {header:{packet_type (table 3.4a), packet_number}, frames: tx buffer (moved), raw:{length: size}}`. `packet_number` omitted if not numeric. T3 adds `trigger: "pto_probe"` when `transmission_type === "PTO_RETRANSMISSION"`. Other transmission types do not map unambiguously to a quic-13 trigger: omit them |
| `QUIC_SESSION_COALESCED_PACKET_SENT` | T1 | nothing |
| `QUIC_SESSION_PACKET_RECEIVED` | T1 | push `quic:packet_received {header:{packet_type:"unknown"}, raw:{length: size}}` now. Attach the previous rx packet's frames (`frames: rx buffer`), then make this one current. (`is_coalesced` is dropped: not in the schema.) |
| `QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED` | T1 | set `header.packet_type` (table 3.4b) and `header.packet_number` on the current rx packet. No current packet: create one, not emitted (PARITY). T3 with `splitCoalescedReceived`: if the current packet already got a header from an earlier UNAUTHENTICATED event, finish it (attach the rx buffer) and push a **new** `quic:packet_received {header}` at this time without `raw` |
| `QUIC_SESSION_HANDSHAKE_DONE_FRAME_RECEIVED` | T3 | rx buffer `{frame_type:"handshake_done"}` (T1: nothing) |
| `QUIC_SESSION_PACKET_LOST` | T1 | `quic:packet_lost {header:{packet_type:"unknown", packet_number}}`. T3: `packet_type` = type of the latest earlier `packet_sent` with the same `packet_number` (if found), and `trigger` omitted |
| `QUIC_SESSION_CLOSED` | T3 | `quic:connection_closed {initiator: from_peer ? "remote" : "local", internal_code: quic_error, reason: details}` (T1: nothing) |
| `QUIC_SESSION_CLOSE_ON_ERROR` | T1 | nothing |
| `QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET` | T3 | `quic:packet_buffered {header:{packet_type: levelToType(encryption_level)}, trigger:"keys_unavailable"}` |
| `QUIC_SESSION_DROPPED_UNDECRYPTABLE_PACKET` | T1+T2 | `quic:packet_dropped {header:{packet_type: levelToType(encryption_level)}, trigger:"key_unavailable"}`. `levelToType` = table 3.4a with `unknown` fallback (T2: all four levels; qvis only HANDSHAKE). Trigger spelling: -13 is `key_unavailable`, the editor's copy is `keys_unavailable`. The loader accepts both (ARCHITECTURE §0); emit the -13 spelling |
| `QUIC_CHROMIUM_CLIENT_STREAM_*`, `…_ATTEMPTING_TO_PROCESS_UNDECRYPTABLE_PACKET`, `…_PACKET_AUTHENTICATED`, `…_VERSION_NEGOTIATED`, `…_STREAM_FRAME_COALESCED`, `…_CERTIFICATE_VERIFIED` | T1 | nothing (no diagnostic: known and intentionally ignored) |
| `HTTP3_{PEER,LOCAL}_CONTROL_STREAM_CREATED` | T1 | `http3:stream_type_set {initiator: PEER ? "remote" : "local", stream_id, stream_type:"control"}`; remember the control stream id per side (T3 uses it) |
| `HTTP3_*_QPACK_DECODER_STREAM_CREATED` | T1 | same, `stream_type:"qpack_decode"` |
| `HTTP3_*_QPACK_ENCODER_STREAM_CREATED` | T1 | same, `stream_type:"qpack_encode"` |
| `HTTP3_SETTINGS_SENT` / `_RECEIVED` | T1+T2 | `http3:parameters_set {initiator: SENT ? "local" : "remote", …mapSettings(params)}` (8.5.4) |
| `HTTP3_SETTINGS_RESUMED` | T3 | `http3:parameters_restored {…mapSettings}` |
| `HTTP3_MAX_PUSH_ID_SENT` / `_RECEIVED` | T3 | `http3:frame_created`/`frame_parsed {stream_id: control stream id of that side, frame:{frame_type:"max_push_id", push_id}}`; skip if the control stream id is unknown |
| `HTTP3_HEADERS_SENT` | T1+T2 | `http3:frame_created {stream_id, frame:{frame_type:"headers", headers: parseHeaders(params.headers)}}` |
| `HTTP3_HEADERS_DECODED` | T1+T2 | `http3:frame_parsed`, same |
| `HTTP3_HEADERS_RECEIVED` | T3 | remember `payload_length` (the parameter name in Chromium's `net_log_event_type_list.h`; also accept `compressed_headers_length`) per stream; the next `HEADERS_DECODED` on that stream gets `frame.raw = {payload_length}` |
| `HTTP3_PRIORITY_UPDATE_SENT` / `_RECEIVED` | T3 | created/parsed on the control stream: `{frame_type:"priority_update", stream_id: prioritized_element_id (when params.type is absent or "request_stream"), push_id (when "push_stream"), priority_field_value}` |
| `HTTP3_DATA_SENT` | T3 | `http3:frame_created {stream_id, frame:{frame_type:"data", raw:{payload_length}}}` |
| `HTTP3_DATA_FRAME_RECEIVED` | T1 | `http3:frame_parsed {stream_id, frame:{frame_type:"data", raw:{payload_length}}}` (old `byte_length` → `frame.raw.payload_length`) |
| `HTTP3_UNKNOWN_FRAME_RECEIVED` | T3 | `http3:frame_parsed {stream_id, frame:{frame_type:"unknown", frame_type_bytes: frame_type, raw:{payload_length}}}` |
| `HTTP3_GOAWAY_SENT` / `_RECEIVED` | T3 | created/parsed on the control stream `{frame_type:"goaway", id: stream_id}` |
| `CERT_VERIFIER_REQUEST` | T1 | `loglevel:info {message:"CERT_VERIFIER_REQUEST BEGIN"}` for `PHASE_BEGIN`, else `{message:"CERT_VERIFIER_REQUEST END"}` (PARITY: `PHASE_NONE` also gives END). Decision C8, section 9.3.10 |
| Current-Chrome frame events (T3 only) | T3 | buffer: `NEW_CONNECTION_ID` → `{frame_type:"new_connection_id", sequence_number, retire_prior_to, connection_id}`; `RETIRE_CONNECTION_ID` → `{frame_type:"retire_connection_id", sequence_number}`; `MAX_STREAMS` → `{frame_type:"max_streams", stream_type: is_unidirectional ? "unidirectional" : "bidirectional", maximum: stream_count}`; `STREAMS_BLOCKED` → `{frame_type:"streams_blocked", stream_type, limit: stream_count}`; `PATH_CHALLENGE`/`PATH_RESPONSE` → `{frame_type, data}` (hex, if a string); `NEW_TOKEN` → `{frame_type:"new_token", token:{raw:{data}}}`; `MESSAGE_FRAME` → `{frame_type:"datagram", raw:{length: message_length}}`; `MTU_DISCOVERY_FRAME_SENT` → `{frame_type:"ping"}` + packet-level `is_mtu_probe_packet: true` on the next `packet_sent`. `BLOCKED`, `STOP_WAITING`, gQUIC `GOAWAY`: nothing (no qlog equivalent with the required fields) |
| Further T3 rows | T3 | specified in section 9.7: `QUIC_SESSION_VERSION_NEGOTIATED` / `…_VERSION_NEGOTIATION_PACKET_RECEIVED` (`version_information`, `supported_versions`), `QUIC_SESSION_CRYPTO_HANDSHAKE_COMPLETE` (`connection_state_updated`), `QUIC_SESSION_DUPLICATE_PACKET_RECEIVED` (`packet_dropped` / `duplicate`), `HTTP3_CANCEL_PUSH_RECEIVED`, `QUIC_SESSION_ORIGIN_FRAME_RECEIVED`, `datagram_id` + `udp_datagrams_received` with `splitCoalescedReceived`. With `extended: false` these stay in the "nothing" behaviour of T1 (no diagnostic) |
| anything else | — | nothing; diagnostic `netlog.unsupported-event` counted per type (one info diagnostic listing `type ×count`) |

End of input (T2): for each session, if the current rx packet exists and the rx buffer is non-empty, attach the
buffer as its `frames`. If the tx buffer is non-empty, drop it with diagnostic `netlog.unsent-frames` (count).

`frames` presence: T1 emits `frames` on every `packet_sent` (possibly `[]`). On `packet_received` it emits
`frames` only once attached (qvis left the key absent on the last packet). With T2 every received packet that had
frames gets them. A received packet with none gets `frames: []` at flush time.

### 8.5 NEW netlog helpers

#### 8.5.1 `parseChromiumTransportParameters(s)`

```
t = s.trim(); strip one leading "[" and one trailing "]"
tokens = t.split(/\s+/).filter(nonEmpty)
if tokens[0] is "Client" or "Server": shift            // perspective; initiator comes from the event type, not from this
out = {}; extra = {}; unknown = []
i = 0
while i < tokens.length:
  tok = tokens[i]
  if tok contains "[":                                  // bracketed group, e.g. "legacy[version", "versions[chosen"
     key = tok.slice(0, tok.indexOf("[")) || "group"; depth = count("[") - count("]") in tok; buf = [tok]; i++
     while depth > 0 and i < len: depth += count("[")-count("]") in tokens[i]; buf.push(tokens[i]); i++
     extra[key] = buf.join(" ").slice(key.length); continue
  if /^0x[0-9a-f]+=/i.test(tok): unknown.push({id: parseInt(before "=", 16), value: after "=" (lowercase, omit if empty)}); i++; continue
  if tok in FLAGS: setFlag(tok); i++; continue
  if tok === "google_handshake_message" and tokens[i+1] === "length:": extra[tok] = "length: " + tokens[i+2]; i += 3; continue
  if tok === "preferred_address": collect tokens until the next token that is a KNOWN key; extra[tok] = joined; continue
  if i + 1 >= len or tokens[i+1] is a KNOWN key: setFlag(tok); i++; continue   // generic flag rule (section 9.3.1)
  if tokens[i+1] starts with '"':                     // quoted value, e.g. user_agent_id "Chrome/120 Linux x86_64"
     join tokens[i+1..j] with " " up to the first token j that ends with '"' (or the last token); strip the quotes
     put(tok, joined); i = j + 1; continue
  put(tok, tokens[i+1]); i += 2
setFlag(tok):
  if tok === "disable_active_migration": out.disable_active_migration = true
  else if tok === "reliable_stream_reset": out.reset_stream_at = true   // -13 QUICParametersSet.reset_stream_at
  else extra[tok] = true                                                // e.g. key_update_not_yet_supported
put(key, value):
  name = ALIASES[key] ?? key            // ALIASES: idle_timeout→max_idle_timeout, max_packet_size→max_udp_payload_size,
                                         //          initial_round_trip_time→(extra), user_agent_id→(extra)
  if name in INT_PARAMS: out[name] = Number(value) (if finite; else extra[key] = value)
  else if name in HEX_PARAMS: out[name] = value.toLowerCase().replace(/^0x/, "")
  else extra[key] = value
result = { ...out, ...(unknown.length ? {unknown_parameters: unknown} : {}), ...(nonEmpty(extra) ? {chromium_extra: extra} : {}) }
```

- `INT_PARAMS` = `max_idle_timeout, max_udp_payload_size, initial_max_data, initial_max_stream_data_bidi_local,
  initial_max_stream_data_bidi_remote, initial_max_stream_data_uni, initial_max_streams_bidi,
  initial_max_streams_uni, ack_delay_exponent, max_ack_delay, active_connection_id_limit, max_datagram_frame_size`.
- `HEX_PARAMS` = `original_destination_connection_id, initial_source_connection_id, retry_source_connection_id,
  stateless_reset_token`.
- `FLAGS` = `disable_active_migration, reliable_stream_reset, key_update_not_yet_supported` (quiche prints these
  without a value; verify `reliable_stream_reset` / `key_update_not_yet_supported` on a real log, the generic flag
  rule covers any other value-less key).
- Known keys (for the `preferred_address` stop rule and the generic flag rule) = INT ∪ HEX ∪ FLAGS ∪ alias keys ∪
  `{google_connection_options, google_handshake_message, initial_round_trip_time, min_ack_delay_us, user_agent_id,
  preferred_address}`.
- `chromium_extra` is a `$$quic-parametersset-extension` field. Also always include `chromium_raw: s` (the
  original string) so nothing is lost.
- QUIC packetization parity: the React QUIC preprocessor reads `max_udp_payload_size` with `initiator` where qvis
  read `max_packet_size` with `owner`. The alias above makes 2020 netlogs behave as in qvis.

#### 8.5.2 ACK ranges

```ts
function ackRanges(largest: number, smallest: number | undefined, missingIn: number[] | undefined): AckRange[] {
  const missing = [...(missingIn ?? [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const pairs: [number, number][] = [];
  if (smallest === undefined) diag("netlog.ack.no-smallest-observed");
  if (missing.length === 0) pairs.push([smallest ?? largest, largest]);
  else {
    if (smallest !== undefined) pairs.push([smallest, missing[0] - 1]);
    for (let i = 0; i < missing.length - 1; i++)
      if (missing[i + 1] !== missing[i] + 1) pairs.push([missing[i] + 1, missing[i + 1] - 1]);
    pairs.push([missing[missing.length - 1] + 1, largest]);
  }
  return pairs.filter(([a, b]) => a <= b).map(([a, b]) => (a === b ? [a] : [a, b]));
}
```

Single-element ranges are emitted as `[n]` (quic-13 AckFrame: "implementations SHOULD log [120]"). Consumers
accept both forms anyway.

#### 8.5.3 HTTP/3 headers

```ts
function parseHeaders(h: unknown): HTTP3HTTPField[] {
  if (Array.isArray(h)) return h.map(s => {
    const str = String(s); const k = str.indexOf(": ", 1);      // from 1: pseudo-headers start with ':'
    return k < 0 ? { name: str } : { name: str.slice(0, k), value: str.slice(k + 2) };
  });
  if (h && typeof h === "object") return Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));  // 2020 format (PARITY)
  return [];
}
```

Elided values (capture mode "strip private information") look like `"[N bytes were stripped]"`. Keep them as
values.

#### 8.5.4 HTTP/3 settings

| NetLog key | `http3:parameters_set` field | Tier |
|---|---|---|
| `SETTINGS_MAX_HEADER_LIST_SIZE`, `SETTINGS_MAX_FIELD_SECTION_SIZE` | `max_field_section_size` | T1/T2 |
| `SETTINGS_QPACK_MAX_TABLE_CAPACITY` | `max_table_capacity` | T1 |
| `SETTINGS_QPACK_BLOCKED_STREAMS` | `blocked_streams_count` | T1 |
| `SETTINGS_ENABLE_CONNECT_PROTOCOL` | `extended_connect` | T3 |
| `SETTINGS_H3_DATAGRAM` | `h3_datagram` | T3 |
| `UNSUPPORTED_SETTINGS_TYPE(<n>)` or a decimal/hex id | `unknown_settings: [{name: isReserved(n) ? "reserved" : "unknown", name_bytes: n, value}]` (editor's-copy field) | T3 |
| any other string key | `chromium_settings: {<key>: value}` (extension) | T3 |

`isReserved(n)` = `n >= 0x21 && (n - 0x21) % 0x1f === 0`. Missing keys stay absent (as in qvis, where
`undefined` was dropped by JSON).

#### 8.5.5 Error-code tables

- Transport (RFC 9000 §20.1): `0x0 no_error, 0x1 internal_error, 0x2 connection_refused, 0x3 flow_control_error,
  0x4 stream_limit_error, 0x5 stream_state_error, 0x6 final_size_error, 0x7 frame_encoding_error,
  0x8 transport_parameter_error, 0x9 connection_id_limit_error, 0xa protocol_violation, 0xb invalid_token,
  0xc application_error, 0xd crypto_buffer_exceeded, 0xe key_update_error, 0xf aead_limit_reached,
  0x10 no_viable_path`. `0x100–0x1ff` → `"crypto_error_0x" + code.toString(16)` (lowercase, quic-13 CryptoError).
- HTTP/3 application (RFC 9114 §8.1; names per h3-13 `HTTP3ApplicationError`, h3-13:1013-1029; decision C10):
  `0x100 http_no_error, 0x101 http_general_protocol_error, 0x102 http_internal_error,
  0x103 http_stream_creation_error, 0x104 http_closed_critical_stream, 0x105 http_frame_unexpected,
  0x106 http_frame_error, 0x107 http_excessive_load, 0x108 http_id_error, 0x109 http_settings_error,
  0x10a http_missing_settings, 0x10b http_request_rejected, 0x10c http_request_cancelled,
  0x10d http_request_incomplete, 0x10f http_connect_error, 0x110 http_version_fallback`.
  **Not** emitted as names, because h3-13 does not define them (only the editor's copy does): `0x10e`
  (`http_message_error`), `0x200`-`0x202` (`qpack_*`), `0x33` (`http_datagram_error`). These codes and every other
  unknown code become `error: "unknown"` with `error_code: <code>`. That keeps the output valid against the strict
  -13 CDDL validator. h3-13's `http_early_response` has no RFC 9114 code and is never emitted. The qvis-react
  **loader** still accepts the editor's-copy names from other producers (ARCHITECTURE §0 union rule).

#### 8.5.6 Truncated netlog repair (NEW)

If `JSON.parse` fails and the text starts (after whitespace/BOM) with `{"constants"`, then: cut back to the end of
the last complete object in the `"events"` array (the last `}` that closes an element at array depth, found with
the same bracket/string state machine as `file-loading.md` §3.5 option (b)), strip a trailing comma, append
`]}`, and parse again. On success, emit the warning diagnostic `netlog.repaired-truncated` (toast in 8.8). Chrome's
own netlog viewer does the same.

### 8.6 NEW tshark (TCP/TLS/HTTP2) mapping (complete)

#### 8.6.1 Private event schemas (main-schema-14 §8.1 rules)

Private URIs (not under `urn:ietf:params:qlog:`, with a domain and an `mmyyyy` date). Keep them in **one**
constants module (`src/converters/tshark/schema.ts`) so the final value can change in one place (decision C1):

```ts
export const QVIS_SCHEMA_BASE = "https://github.com/mjoras/qvis-react/112026";
export const TCP_SCHEMA_URI   = `${QVIS_SCHEMA_BASE}/tcp`;     // namespace "tcp"
export const TLS_SCHEMA_URI   = `${QVIS_SCHEMA_BASE}/tls`;     // namespace "tls"
export const HTTP2_SCHEMA_URI = `${QVIS_SCHEMA_BASE}/http2`;   // namespace "http2"
```

Document these schemas in `docs/schemas/tcp-tls-http2.md` (CDDL below, copied verbatim). Detection of TCP traces
in the app never depends on the exact URI. It uses `protocolHint === "TCP_HTTP2"` (from `common_fields.protocol_type`)
or, as a fallback, the presence of `tcp:` events.

```cddl
; namespace "tcp", schema https://github.com/mjoras/qvis-react/112026/tcp
TCPEventData = TCPPacketSent / TCPPacketReceived
$ProtocolEventData /= TCPEventData

; tcp:packet_sent and tcp:packet_received (identical shape)
TCPPacketSent = {
    header: TCPPacketHeader
    ; length = TCP header + payload; payload_length = TCP payload (tcp.len)
    raw: RawInfo
    ; capture frame number (tshark frame.number), 1-based
    ? capture_frame_number: uint64
    * $$tcp-packetsent-extension
}
TCPPacketReceived = TCPPacketSent

TCPPacketHeader = {
    sequence_number: uint32          ; tcp.seq (relative or raw, as exported)
    header_length: uint16            ; tcp.hdr_len
    ; qvis compatibility (QUIC-shaped views): always "1RTT"; packet_number = capture frame number
    ? packet_type: "1RTT"
    ? packet_number: uint64
    ; T3 (extended) only
    ? acknowledgement_number: uint32 ; tcp.ack
    ? window_size: uint32            ; tcp.window_size
    ? flags: { ? syn: bool, ? ack: bool, ? fin: bool, ? rst: bool, ? psh: bool }
}

; namespace "tls", schema https://github.com/mjoras/qvis-react/112026/tls
TLSEventData = TLSRecordCreated / TLSRecordParsed
$ProtocolEventData /= TLSEventData

; tls:record_created (sent) and tls:record_parsed (received)
TLSRecordCreated = {
    header: TLSRecordHeader
    ; length = header_length + payload_length + trailer_length (= 5 + tls.record.length)
    ; payload_length = tls.record.length - trailer_length
    raw: RawInfo
    ? capture_frame_number: uint64
    * $$tls-recordcreated-extension
}
TLSRecordParsed = TLSRecordCreated

TLSRecordHeader = {
    content_type: "handshake" / "alert" / "application" / "change-cipherspec" / "unknown"
    header_length: uint8             ; always 5
    trailer_length: uint16           ; estimated AEAD tag (+ TLS 1.3 inner type); 0 if not application or not estimated
    ? version: hexstring             ; tls.record.version, e.g. "0303"
    ; qvis compatibility (decision C9): always "1RTT", so the Stats "Encryption levels" count matches qvis
    ? packet_type: "1RTT"
}

; namespace "http2", schema https://github.com/mjoras/qvis-react/112026/http2
HTTP2EventData = HTTP2FrameCreated / HTTP2FrameParsed
$ProtocolEventData /= HTTP2EventData

; http2:frame_created (sent) and http2:frame_parsed (received)
HTTP2FrameCreated = {
    stream_id: int                   ; -1 for the connection preface ("magic")
    frame: HTTP2Frame
    * $$http2-framecreated-extension
}
HTTP2FrameParsed = HTTP2FrameCreated

HTTP2Frame = {
    frame_type: "data" / "headers" / "priority" / "reset_stream" / "settings" / "push_promise" /
                "ping" / "go_away" / "window_update" / "continuation" / "magic" / "unknown"
    ? frame_type_bytes: uint8        ; numeric type when frame_type is "unknown"
    ? headers: [* { ? name: text, ? value: text }]   ; headers frames only (decoded by tshark)
    ? stream_end: bool               ; data/headers frames when the END_STREAM flag field is present
    ; length = 9 + http2.length (24 for magic); payload_length = http2.length (incl. padding)
    raw: RawInfo
}
```

Value choices kept for parity: `"change-cipherspec"`, `"go_away"`, `"reset_stream"` and `"magic"` show up
verbatim in tooltips ("content type: …", "frame type: …"). `stream_id: -1` for magic keeps the lavenderblush
stream-lane segment and the "streamID: -1" tooltip.

#### 8.6.2 Trace

- `title`: exactly as qvis (section 3.9.8), built from the same parts.
- `vantage_point`: `{type: "client"}`.
- `common_fields`: `protocol_type: "TCP_HTTP2"`, `time_format: "relative_to_epoch"`,
  `reference_time: {clock_type: "system", epoch: "1970-01-01T00:00:00.000Z"}` → `data-model.md` case A
  (`relativeTime = time - first`, `absoluteTime` = Unix ms).
- `event_schemas`: `[TCP_SCHEMA_URI, TLS_SCHEMA_URI, HTTP2_SCHEMA_URI]`.

#### 8.6.3 Time (FIX of Q1)

```ts
export function epochSecondsStringToMs(s: unknown): number {      // "1582210168.496779237" -> 1582210168496.779237
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(String(s));
  if (!m) return NaN;
  const ns = (m[2] ?? "").padEnd(9, "0").slice(0, 9);
  return Number(m[1]) * 1000 + Number(ns) / 1e6;
}
```

- If NaN: try `Date.parse(frame["frame.time_utc"] ?? frame["frame.time"])` (newer Wireshark ISO strings). If that
  also fails, use the previous event's time in that direction (diagnostic `tshark.bad-timestamp`).
- The per-direction tracker (3.9.1) runs in ms. The fake step is `+0.001` ms (1 µs, same as qvis).
- The final stable sort is by ms time (equal times keep TCP → TLS → H2 and entry order).

#### 8.6.4 Mapping table

| tshark | Tier | New qlog |
|---|---|---|
| packet with ip/ipv6 + tcp | T1 | `tcp:packet_sent` (sending) / `tcp:packet_received` (receiving): `{header:{sequence_number: int(tcp.seq), header_length: int(tcp.hdr_len), packet_type:"1RTT", packet_number: int(frame.number)}, raw:{length: hdr_len + len, payload_length: int(tcp.len)}, capture_frame_number: int(frame.number)}`. T3 adds `acknowledgement_number`, `window_size`, `flags` (from `tcp.flags_tree.tcp.flags.{syn,ack,fin,reset,push}` = `"1"`) |
| each TLS record (3.9.3, with the T2 string skip) | T1 | `tls:record_created`/`tls:record_parsed`: `{header:{content_type, header_length:5, trailer_length: trailerSize, packet_type:"1RTT"}, raw:{length: 5 + recordLength, payload_length: recordLength - trailerSize}, capture_frame_number}` (`packet_type` per C9, section 9.4). T2 adds `header.version` (strip `0x0000` → `"0303"`). T3: if `tls.record.content_type` is absent, use `tls.record.opaque_type` |
| trailer estimate (3.9.6 step 5, unchanged) | T1 | retroactive adjustment mutates `header.trailer_length = T` and `raw.payload_length -= T` of the remembered event objects (before output). `raw.length` is unchanged |
| each HTTP/2 frame (3.9.4, T2: magic patched anywhere; strings skipped) | T1 | `http2:frame_created`/`http2:frame_parsed`: `{stream_id, frame:{frame_type, raw:{length: headerLength + frameLength, payload_length: frameLength}, [headers], [stream_end]}}`. T2: `headers = asArray(http2.header)` (missing → `[]`, diagnostic `tshark.headers-missing`). T2: `frame_type_bytes` for unknown types. T3: types `"10"`→`altsvc`, `"12"`→`origin`, `"16"`→`priority_update` |
| `:authority` header | T1 | `probable_url` for the title (first value wins) |
| `header.payload_length` (old TCP/TLS), `payload_length`/`header_length` (old H2), `byte_length`, `DEBUG_wiresharkFrameNumber`, TLS `packet_type`/`packet_number` | NEW | removed; see the field map in 8.7 |

Everything else (connection keying, direction, which records/frames are extracted, early return on "No
tls.record", trailer heuristic and accepted sizes `{16, 17, 8, 24}`, title format, stable sort) is PARITY.

### 8.7 TCP packetization preprocessor port (data contract)

Port `PacketizationTCPPreProcessor` line by line (section 3.11), changing only the field access:

| qvis | qvis-react |
|---|---|
| `event.name === "packet_received"` / `"packet_sent"` | `ev.name === "tcp:packet_received"` / `"tcp:packet_sent"` |
| `"record_parsed"` / `"record_created"` | `"tls:record_parsed"` / `"tls:record_created"` |
| `"frame_parsed"` / `"frame_created"` (and `HTTPHeadersSentEventType`) | `"http2:frame_parsed"` / `"http2:frame_created"` |
| TCP `data.header.payload_length` | `data.raw.payload_length` |
| TCP `data.header.header_length` | `data.header.header_length` (fallback `raw.length - raw.payload_length`) |
| TLS `data.header.payload_length` | `data.raw.payload_length` |
| TLS `data.header.header_length`, `trailer_length`, `content_type` | unchanged (`data.header.*`) |
| TLS `data.header.DEBUG_wiresharkFrameNumber` | `data.capture_frame_number` (tooltip text unchanged: "Wireshark frame number (DEBUG): ") |
| H2 `data.payload_length` | `data.frame.raw.payload_length` |
| H2 `data.header_length` | `data.frame.raw.length - data.frame.raw.payload_length` |
| H2 `data.stream_id`, `data.frame.frame_type`, `data.frame.headers`, `data.frame.stream_end` | unchanged |
| tooltip `rawPacket.payload_length` ("frame size ") | `rawPacket.frame.raw.payload_length` |
| renderer switch `commonFields.protocol_type === "TCP_HTTP2"` | `connection.protocolHint === "TCP_HTTP2"` |

Keep the type-matching semantics: TCP-preprocessor matching is on full names now, which is equivalent for
converter output. Keep every `console.*` as a debug log (not a toast). Replace the two `alert`s in `extractRanges`
as specified by the packetization spec. Golden numbers in section 3.13 must match exactly (unit test).

### 8.8 Diagnostics (replace console/alert) and NEW user messages

Diagnostic codes (severity, aggregated by code with counts; first 3 examples kept for the debug view):

| Code | Sev. | Converter |
|---|---|---|
| `netlog.unknown-source-type`, `netlog.unknown-event-type`, `netlog.unknown-phase` | warn | netlog |
| `netlog.session-without-begin` | warn | netlog |
| `netlog.unknown-encryption-level` | warn | netlog |
| `netlog.unsupported-event` (per type) | info | netlog |
| `netlog.empty-session-dropped` | info | netlog |
| `netlog.ack.no-smallest-observed` | warn | netlog |
| `netlog.unsent-frames` | info | netlog |
| `netlog.no-time-tick-offset` | info | netlog |
| `netlog.repaired-truncated` | warn | netlog |
| `netlog.missing-field` (per `"<event>.<field>"`; section 9.1 rule 6) | info | netlog |
| `tshark.seq-unordered`, `tshark.timestamp-faked`, `tshark.timestamp-unordered`, `tshark.bad-timestamp` | info/warn | tshark |
| `tshark.no-tls-record` (entry's H2 frames dropped) | warn | tshark |
| `tshark.tls-unknown-record-field` (lists field names) | info | tshark |
| `tshark.trailer-unexpected-size`, `tshark.trailer-inconsistent`, `tshark.trailer-not-estimated` | warn | tshark |
| `tshark.headers-missing`, `tshark.conflicting-authority`, `tshark.h2-without-tls` | warn | tshark |
| `tshark.http-tls-size-mismatch` | warn | tshark |
| `tshark.first-packet-from-server-port` | warn | tshark |
| `tshark.missing-field` (per `"<layer>.<field>"`; section 9.1 rule 6) | info | tshark |

NEW toasts (shown by the loading layer after a successful load; plain text, qvis style, `type: "warn"`,
6000 ms; only for warn-level codes or zero traces):

- Zero QUIC sessions: title `Chrome netlog contains no QUIC connections`, text `No QUIC connections found in this Chrome netlog.`
- Zero TCP connections: title `No TCP connections found`, text `No TCP connections found in this tshark JSON. QUIC captures need pcap2qlog (not available in this deployment).`
- Truncated netlog repaired: title `Netlog was truncated`, text `The netlog file was not closed properly; events up to the cut-off were loaded.`
- Any other warn-level converter diagnostics: title `Converted with warnings`, text `<file name> was converted, but some input could not be interpreted. See the debug page for details.`

### 8.9 Tests (Vitest; fixtures in `tests/fixtures/converters/`)

1. **ACK ranges**: every row of the table in section 3.5 (T2 column).
2. **Transport parameters**:
   - qvis example string (section 3.6) → `{max_idle_timeout:30000, max_udp_payload_size:1472, initial_max_data:15728640, initial_max_stream_data_bidi_local:6291456, initial_max_streams_bidi:100, initial_source_connection_id:"0a0b0c0d", chromium_raw:<input>}`.
   - Messy string (section 8.9.3) parses as specified.
   - 2020 names `idle_timeout`/`max_packet_size` map to the RFC names.
3. **Netlog end-to-end**: the synthetic fixture 8.9.1 gives the expected output 8.9.2 (deep-equal). That output
   also validates with `scripts/validate-qlog.mjs` against the -14/-13 CDDL. Event-data extension keys
   (`chromium_raw`, `chromium_extra`, `chromium_settings`) sit in `$$…-extension` group sockets, which the
   drafts leave empty, so the validator either defines those sockets as `(* text => any)` or strips `chromium_*`
   keys from event `data` before validating. Frame-level extras (`chromium_rst_stream_error`,
   `chromium_quic_error`) are already legal because `$QuicFrame /= { * text => any }`. TCP output is validated
   against the private CDDL in 8.6.1 (added to the validator's schema set), not against the IETF CDDL.
4. **Headers**: list form, object form, value containing `": "`, `":status: 200"`, an entry without a separator.
5. **tshark golden** (`public/examples/tcp/wikipedia_Playstation.json` or a fixture copy): every row of section 3.13
   with the new names (event counts by name, title, trailer 16 from capture frame 29, 21 adjusted records, byte
   sums). First event `time` ≈ `1582210168496.779` (toBeCloseTo 3 decimals), span 472.20125 ms.
6. **TCP packetization** on that output: section 3.13 lane counts, xMax and `HTTPStreamInfo` totals for both
   directions, no alerts, no leftover ranges.
7. **tshark robustness**: HEADERS without `http2.header` and with a single header object (no throw); a string inside
   a `tls` array (no throw); a lone magic `http2.stream` object (lengths 24/24); duplicate-key input through the
   dedup parser gives the same output as `--no-duplicate-keys` input.
8. **Detection**: `chrome-net-export-log.json` (sniff) and `x.netlog` both reach `convertNetlog`. A `.json` starting
   with `[{"_index"…"_source"…"layers"` reaches `convertTshark`.

#### 8.9.1 Synthetic netlog fixture (`tests/fixtures/converters/mini.netlog`)

```json
{
  "constants": {
    "activeFieldTrialGroups": [],
    "logEventPhase": {"PHASE_BEGIN": 1, "PHASE_END": 2, "PHASE_NONE": 0},
    "logSourceType": {"NONE": 0, "URL_REQUEST": 1, "QUIC_SESSION": 11},
    "logEventTypes": {
      "URL_REQUEST_START_JOB": 2, "QUIC_SESSION": 234,
      "QUIC_SESSION_TRANSPORT_PARAMETERS_SENT": 300, "QUIC_SESSION_CRYPTO_FRAME_SENT": 301,
      "QUIC_SESSION_PADDING_FRAME_SENT": 302, "QUIC_SESSION_PACKET_SENT": 303,
      "HTTP3_LOCAL_CONTROL_STREAM_CREATED": 304, "HTTP3_SETTINGS_SENT": 305, "HTTP3_HEADERS_SENT": 306,
      "QUIC_SESSION_PACKET_RECEIVED": 307, "QUIC_SESSION_UNAUTHENTICATED_PACKET_HEADER_RECEIVED": 308,
      "QUIC_SESSION_ACK_FRAME_RECEIVED": 309, "QUIC_SESSION_CRYPTO_FRAME_RECEIVED": 310,
      "QUIC_SESSION_STREAM_FRAME_RECEIVED": 311, "HTTP3_HEADERS_DECODED": 312,
      "HTTP3_DATA_FRAME_RECEIVED": 313, "CERT_VERIFIER_REQUEST": 314, "QUIC_SESSION_PACKET_LOST": 315
    },
    "timeTickOffset": "1600000000000"
  },
  "events": [
    {"phase":1,"source":{"id":7,"start_time":"5000","type":11},"time":"5000","type":234,"params":{"host":"example.org","port":443,"connection_id":"0102030405060708","versions":"RFCv1"}},
    {"phase":0,"source":{"id":3,"start_time":"4990","type":1},"time":"5000","type":2},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5001","type":300,"params":{"quic_transport_parameters":"[Client max_idle_timeout 30000 max_udp_payload_size 1472 initial_max_data 15728640 initial_max_stream_data_bidi_local 6291456 initial_max_streams_bidi 100 initial_source_connection_id 0a0b0c0d]"}},
    {"phase":1,"source":{"id":7,"start_time":"5000","type":11},"time":"5001","type":314},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5002","type":301,"params":{"encryption_level":"ENCRYPTION_INITIAL","data_length":290,"offset":0}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5002","type":302,"params":{"num_padding_bytes":905}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5002","type":303,"params":{"encryption_level":"ENCRYPTION_INITIAL","packet_number":1,"size":1250,"transmission_type":"NOT_RETRANSMISSION","sent_time_us":"5002000"}},
    {"phase":2,"source":{"id":7,"start_time":"5000","type":11},"time":"5003","type":314},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5004","type":304,"params":{"stream_id":2}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5004","type":305,"params":{"SETTINGS_MAX_FIELD_SECTION_SIZE":262144,"SETTINGS_QPACK_MAX_TABLE_CAPACITY":0,"SETTINGS_QPACK_BLOCKED_STREAMS":0}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5004","type":306,"params":{"stream_id":0,"headers":[":method: GET",":authority: example.org",":path: /",":scheme: https"]}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5030","type":307,"params":{"peer_address":"192.0.2.1:443","self_address":"10.0.0.1:50000","size":1200}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5030","type":308,"params":{"connection_id":"0102030405060708","header_format":"IETF_QUIC_LONG_HEADER_PACKET","long_header_type":"INITIAL","packet_number":1}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5030","type":309,"params":{"largest_observed":1,"smallest_observed":1,"missing_packets":[],"delta_time_largest_observed_us":250,"received_packet_times":[]}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5030","type":310,"params":{"encryption_level":"ENCRYPTION_INITIAL","data_length":90,"offset":0}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5045","type":307,"params":{"peer_address":"192.0.2.1:443","self_address":"10.0.0.1:50000","size":400}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5045","type":308,"params":{"connection_id":"0102030405060708","header_format":"IETF_QUIC_SHORT_HEADER_PACKET","packet_number":5}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5045","type":311,"params":{"stream_id":0,"fin":true,"offset":0,"length":300}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5046","type":312,"params":{"stream_id":0,"headers":[":status: 200","content-type: text/html"]}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5046","type":313,"params":{"stream_id":0,"payload_length":250}},
    {"phase":0,"source":{"id":7,"start_time":"5000","type":11},"time":"5100","type":315,"params":{"packet_number":1,"transmission_type":"NOT_RETRANSMISSION","detection_time_us":"5100000"}}
  ]
}
```

#### 8.9.2 Expected output (default options: T1 + T2)

```json
{
  "file_schema": "urn:ietf:params:qlog:file:contained",
  "serialization_format": "application/qlog+json",
  "traces": [{
    "title": "example.org-0102030405060708",
    "vantage_point": {"type": "client"},
    "common_fields": {
      "protocol_type": "QUIC_HTTP3",
      "time_format": "relative_to_epoch",
      "reference_time": {"clock_type": "system", "epoch": "2020-09-13T12:26:45.000Z"}
    },
    "event_schemas": ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13", "urn:ietf:params:qlog:events:loglevel", "https://github.com/mjoras/qvis-react/112026/quic#chromium"],
    "events": [
      {"time": 1, "name": "quic:parameters_set", "data": {"initiator": "local", "max_idle_timeout": 30000, "max_udp_payload_size": 1472, "initial_max_data": 15728640, "initial_max_stream_data_bidi_local": 6291456, "initial_max_streams_bidi": 100, "initial_source_connection_id": "0a0b0c0d", "chromium_raw": "[Client max_idle_timeout 30000 max_udp_payload_size 1472 initial_max_data 15728640 initial_max_stream_data_bidi_local 6291456 initial_max_streams_bidi 100 initial_source_connection_id 0a0b0c0d]"}},
      {"time": 1, "name": "loglevel:info", "data": {"message": "CERT_VERIFIER_REQUEST BEGIN"}},
      {"time": 2, "name": "quic:packet_sent", "data": {"header": {"packet_type": "initial", "packet_number": 1}, "frames": [{"frame_type": "crypto", "offset": 0, "raw": {"length": 290}}, {"frame_type": "padding"}], "raw": {"length": 1250}}},
      {"time": 3, "name": "loglevel:info", "data": {"message": "CERT_VERIFIER_REQUEST END"}},
      {"time": 4, "name": "http3:stream_type_set", "data": {"initiator": "local", "stream_id": 2, "stream_type": "control"}},
      {"time": 4, "name": "http3:parameters_set", "data": {"initiator": "local", "max_field_section_size": 262144, "max_table_capacity": 0, "blocked_streams_count": 0}},
      {"time": 4, "name": "http3:frame_created", "data": {"stream_id": 0, "frame": {"frame_type": "headers", "headers": [{"name": ":method", "value": "GET"}, {"name": ":authority", "value": "example.org"}, {"name": ":path", "value": "/"}, {"name": ":scheme", "value": "https"}]}}},
      {"time": 30, "name": "quic:packet_received", "data": {"header": {"packet_type": "initial", "packet_number": 1}, "raw": {"length": 1200}, "frames": [{"frame_type": "ack", "acked_ranges": [[1]]}, {"frame_type": "crypto", "offset": 0, "raw": {"length": 90}}]}},
      {"time": 45, "name": "quic:packet_received", "data": {"header": {"packet_type": "1RTT", "packet_number": 5}, "raw": {"length": 400}, "frames": [{"frame_type": "stream", "stream_id": 0, "offset": 0, "fin": true, "raw": {"length": 300}}]}},
      {"time": 46, "name": "http3:frame_parsed", "data": {"stream_id": 0, "frame": {"frame_type": "headers", "headers": [{"name": ":status", "value": "200"}, {"name": "content-type", "value": "text/html"}]}}},
      {"time": 46, "name": "http3:frame_parsed", "data": {"stream_id": 0, "frame": {"frame_type": "data", "raw": {"payload_length": 250}}}},
      {"time": 100, "name": "quic:packet_lost", "data": {"header": {"packet_type": "unknown", "packet_number": 1}}}
    ]
  }]
}
```

Diagnostics: none at warn level (the URL_REQUEST source is skipped silently). For comparison, qvis produced for
the same input: `info:marker` string data; `owner` / `new` fields; string numbers; the `initial_source_connection_id`
value `"0a0b0c0d]"`; headers `[{name:"0", value:":method: GET"}, …]`; no `max_header_list_size`; and **no frames**
on the packet at time 45.

#### 8.9.3 Messy transport-parameter vector

Input: `"[Server max_idle_timeout 30000 stateless_reset_token 00112233445566778899aabbccddeeff max_udp_payload_size 1472 initial_max_data 786432 disable_active_migration active_connection_id_limit 4 initial_source_connection_id ab12 original_destination_connection_id 0102 google_handshake_message length: 13 0x4143=0102 legacy[version 00000001 [00000001]]]"`

Expected (plus `initiator` from the event): `{max_idle_timeout:30000, stateless_reset_token:"00112233445566778899aabbccddeeff", max_udp_payload_size:1472, initial_max_data:786432, disable_active_migration:true, active_connection_id_limit:4, initial_source_connection_id:"ab12", original_destination_connection_id:"0102", unknown_parameters:[{id:16707, value:"0102"}], chromium_extra:{google_handshake_message:"length: 13", legacy:"[version 00000001 [00000001]]"}, chromium_raw:<input>}`.

qvis produced: `{…, disable_active_migration:"active_connection_id_limit", "4":"initial_source_connection_id", "ab12":"original_destination_connection_id", "0102":"google_handshake_message", "length:":"13", "0x4143=0102":"legacy[version", "00000001":"[00000001]]]"}`.

#### 8.9.4 Reference scripts

The faithful Python ports used to produce the golden numbers (TCPToQlog, PacketizationTCPPreProcessor, and the
`fix02Compatibility` hang) were run from the session scratchpad. Re-derive them in Vitest from the TypeScript
port. The numbers in section 3.13 are the oracle.

### 8.10 D3 and React notes

- The converters contain no D3 and no React. They are data transforms only.
- The packetization renderer stays imperative (D3 v7 class), per the packetization spec. Only the TCP
  preprocessor's field access changes (8.7).
- Large inputs: tshark JSON for a page load is 5-50 MB, and netlogs can be 100+ MB. Keep the converters
  single-pass and O(n). Do not deep-copy event objects. The one exception is the frame copies on packet
  emission, which are shallow. Do not keep `DEBUG_originalEntries`.

### 8.11 Open decisions (with recommended defaults)

| id | Decision | Recommendation |
|---|---|---|
| C1 | Private schema URI base for `tcp:`/`tls:`/`http2:` | `https://github.com/mjoras/qvis-react/112026` (owner-controlled path, mmyyyy = 112026). Change in one constant if the project gets its own domain |
| C2 | Default tier | T1 + T2 on; T3 behind `extended` (off). Expose a "Convert with extended mappings" checkbox only on the debug page (not on the file manager, to keep its UI verbatim) |
| C3 | Netlog time when `timeTickOffset` is missing | monotonic/unknown epoch (case U); accept the small shift |
| C4 | Show TCP packets in QUIC views like qvis did (3.12) | yes, through `data-model.md` §9.10: views look up `lookup(conn.transportNamespace, "packet_sent" / "packet_received")`, where `transportNamespace` is `"tcp"` for `protocolHint` `TCP_HTTP2` / `TCP`. TCP headers carry `packet_type: "1RTT"` and `packet_number` = capture frame number, exactly the qvis shape. The sequence-diagram, congestion and Stats specs must adopt it (section 9.5) |
| C5 | `simulation:marker` vs `loglevel:info` for CERT_VERIFIER | **Superseded by C8** (`loglevel:info`). The earlier recommendation was `simulation:marker` |
| C6 | Ship the TCP demo input and link it from the packetization modal | ship `public/examples/tcp/wikipedia_Playstation.json` (MIT, attribution); keep the modal sentence verbatim, add no link unless the packetization spec wants one |
| C7 | Netlog title fallbacks (T2) | as in 8.4 (`host`, or `"QUIC session <id>"`) |
| C8 | Latest-draft event for the netlog `info:marker` (CERT_VERIFIER_REQUEST) | `loglevel:info {message}` (section 9.3.10) |
| C9 | TLS records keep `header.packet_type: "1RTT"` | yes, a compat field in the private TLS schema, so the Stats "Encryption levels" count stays 1:1 (section 9.4) |
| C10 | HTTP/3 error names the netlog converter emits | only names that exist in h3-events-13; other codes become `error: "unknown"` + `error_code` (section 9.3.6, 8.5.5) |
| C11 | Declaring the `chromium_*` event-data fields | list a private extension schema `${QVIS_SCHEMA_BASE}/quic#chromium` (and `/http3#chromium` for T3 settings) in `event_schemas` whenever such a field is emitted (section 9.1) |
| C12 | JSON type of uint64 values | numbers; the decimal string only when the value is not a safe integer (section 9.1) |
| C13 | `event_schemas` content | exactly the schemas used by that trace's events and fields (section 9.1) |

---

## 9. Mapping to latest qlog drafts

This section is the field-level contract between the two converters, the latest qlog drafts and the qvis-react
views. For every old-schema event and field that the converter output fed in qvis (section 4.3), it gives the
latest-draft event name, the field path, the semantic differences, the behaviour when the input lacks the value, and
the view-level consequence. It also lists what has no equivalent and what the latest drafts add that the converters
could emit. Where this section changed an earlier decision, sections 4, 7 and 8 were edited in place and the change is
listed in 9.8.

Draft references are line numbers in the published texts under `the published draft texts (ietf.org)`: `main-14:N`
(draft-ietf-quic-qlog-main-schema-14), `quic-13:N` (draft-ietf-quic-qlog-quic-events-13), `h3-13:N`
(draft-ietf-quic-qlog-h3-events-13). "ed" means the editor's copies in `scratchpad/ref/qlog-wg/`. Background is in
`docs/dev/qlog-spec/{main-schema,quic-events,h3-events,ecosystem}.md`. qvis line references use the abbreviations of
section 4.3.

### 9.1 Ground rules for all converter output

1. **Envelope.** `QlogFile` (main-14:484): `file_schema: "urn:ietf:params:qlog:file:contained"`,
   `serialization_format: "application/qlog+json"`, `traces: [Trace]` (main-14:568). Never emit `qlog_version`,
   `qlog_format`, `event_fields`, `configuration` or `summary`. Events are objects `{time, name, data}`.
2. **Names.** `name` is `namespace + ":" + type`, taken from quic-13, h3-13 or main-14 §9 (`loglevel`), or one of the
   private namespaces `tcp`, `tls`, `http2`. qvis-react never aliases names (ARCHITECTURE §3.1). The model flags the
   pre-final categories `transport`, `recovery`, `info`, … and unknown types in the `quic`, `http3` and `http`
   namespaces as non-conforming (`src/model/names.ts:223-253`, `src/model/conformance.ts:69-75`, toast DM3). `http`
   is now the HTTP **Capsule** namespace (h3-13 §5), so qvis's `http:stream_type_set` would also be flagged. The
   converters therefore emit **no** old name.
3. **Numbers (C12).** Every uint64 is a JSON number when `Number.isSafeInteger(v)`. Otherwise it is the decimal string
   as Chrome or tshark gave it. Both forms are legal (main-14:2419-2423) and every consumer reads through
   `u64()` / `toNum()`. qvis stringified most numbers (`"…"` in section 3.4). Floats (ms times, `ack_delay`) are
   numbers.
4. **Time.** `time` is float64 milliseconds (main-14:272). `common_fields.time_format: "relative_to_epoch"`
   (main-14:1000) and `common_fields.reference_time` is a `ReferenceTime` object (main-14:964).
5. **Closed data maps.** In the CDDL every event `data` map is closed apart from its `* $$…-extension` socket. A field
   that -13/-14 do not define may only appear (a) inside a QUIC frame object, because `$QuicFrame /= {* text => any}`
   is open (quic-13 §8.13; for example `chromium_rst_stream_error`), or (b) in event data as a field of the declared
   private extension schema (C11). That covers `chromium_raw`, `chromium_extra` and the T3-only `chromium_settings`.
   The extension URIs are `${QVIS_SCHEMA_BASE}/quic#chromium` and `${QVIS_SCHEMA_BASE}/http3#chromium`. They follow
   main-14:1616 (private URI with a domain and `mmyyyy`; the fragment names the extension; the path names the extended
   namespace). Put them next to the TCP/TLS/H2 URIs in one constants module. Move `QVIS_SCHEMA_BASE` from
   `tshark/schema.ts` to `src/converters/common/envelope.ts` and re-export it. Side effect to know about:
   `src/model/conformance.ts:41-58` matches private URIs by **substring** (`uri.includes(namespace)`). A trace that
   lists `…/quic#chromium` is therefore treated as extending `quic`, and, because every `https://` URI contains
   `"http"`, as extending `http` as well, so unknown `quic:*` / `http:*` names in that trace would not raise DM3. The
   converters emit no such names, so the output is unaffected. The model owner should match the namespace as a whole
   path segment instead (recorded here, not a converter task).
6. **Required members and missing input.** A member that the CDDL requires is always emitted when the input has the
   value. When the input lacks it, the member is **omitted**, never invented. The info diagnostic
   `netlog.missing-field` (or `tshark.missing-field`) is counted per `"<event>.<field>"`. The documented exceptions
   are PARITY placeholders such as `packet_type: "unknown"`, which are legal values.
7. **Enumerations** use the exact -13 spelling. `$PacketType` uses `"0RTT"` and `"1RTT"` (quic-13:2637).
   `packet_dropped` uses the trigger `"key_unavailable"` (quic-13:1309) and `packet_buffered` uses
   `"keys_unavailable"` (quic-13:1373). `$TransportError` is at quic-13:3309, `CryptoError` at quic-13:3379, and
   `HTTP3ApplicationError` at h3-13:1013 (C10).
8. **`event_schemas` (C13)** lists exactly the schemas used by the trace, in this order:
   `urn:ietf:params:qlog:events:quic-13`, `urn:ietf:params:qlog:events:http3-13` (the `-13` suffix is mandatory for
   draft implementations: quic-13:325, h3-13:294), `urn:ietf:params:qlog:events:loglevel` (main-14 has no suffix
   rule), then the private extension URIs of rule 5. A netlog session without HTTP/3 events therefore does not list
   `http3-13`. That keeps the P14 schema check (`checkEventSchemas`, "unused schema") quiet. TCP traces list the
   three private URIs of 8.6.1.

### 9.2 File and trace level

| qvis output | Latest-draft output | Semantics and parity notes |
|---|---|---|
| `qlog_version: "draft-01"` (netlog) / `"draft-02-wip"` (TCP) | `file_schema`, `serialization_format` (main-14:484) | no file `title` / `description` (2.4 PARITY) |
| trace `event_fields: ["relative_time" \| "time", "category", "event", "data"]`, array events | object events `{time, name, data}` | — |
| netlog `common_fields.reference_time: "<startTick>"` (string ms, read as `addTime` by `EventFieldsParser`) | `reference_time: {clock_type: "system", epoch: new Date(timeTickOffset + startTick).toISOString()}`; `time = tick - startTick` | `relativeTime` is identical to qvis. `absoluteTime` becomes real Unix ms instead of Chrome ticks. Cross-trace alignment is unchanged, because all traces of one netlog share `timeTickOffset`. Without `timeTickOffset`, use `{clock_type: "monotonic", epoch: "unknown"}`: main-14:964ff says a monotonic clock MUST use `"unknown"` (data-model case U, decision C3) |
| TCP: no `reference_time`, `"time"` in **seconds** read as ms (Q1) | `reference_time: {clock_type: "system", epoch: "1970-01-01T00:00:00.000Z"}`, `time` = Unix ms float | FIX: time-based views show the real 472.2 ms span of the example instead of 0.472 |
| `common_fields.protocol_type: "QUIC_HTTP3"` / `"TCP_HTTP2"` | the same key in `common_fields`, kept as a **custom common field**. `CommonFields` ends in `* text => any` and other tools MUST disregard unknown entries (main-14:1465-1470) | `QlogConnection.protocolHint` reads it (`src/model/QlogConnection.ts:200-206`). That getter derives only `QUIC_HTTP3` from namespaces. It does **not** derive `TCP_HTTP2` from `tcp:` events, which data-model §9.10 item 1 asks for. So the TCP converter MUST write `protocol_type` (it does). The packetization spec's TCP-mode rule ("presence of `tcp:packet_*`", packetization §3.3) holds too, because the converter writes both. ecosystem §6.3 "ignore `protocol_type`" refers to quiche's **array** value, which `protocolHint` already ignores (`typeof pt === "string"`) |
| `vantage_point: {type: "client"}` | the same (main-14:794) | PARITY. For tshark captures, `{type: "network", flow: "client"}` would be more precise. It would make `HTTPHeadersSentEventType` undefined (`PT:26-32`) and change the flow labels, so it is not adopted |
| trace `title` | `Trace.title` (main-14:568) | PARITY strings |
| — | `event_schemas` | C13 |

### 9.3 Netlog output, event by event

#### 9.3.1 `transport:parameters_set` → `quic:parameters_set` (Core, quic-13:1043)

| qvis field | Latest field | Semantics / change | Input lacks it | Consumers in qvis-react |
|---|---|---|---|---|
| `owner: "local" \| "remote"` | `initiator` (`Initiator`, quic-13 §8.3) | Same values, still taken from the event type (`…_SENT` → `local`, `…_RECEIVED` → `remote`) and never from the `Client`/`Server` word in the string. -13 requires one initiator per event, which holds | always set | Stats FC (`ST:466-472`, `:505-517`), congestion FC lines (`initiator === "remote"`, `CG:1094-1107`), QUIC packetization labels (`PQ:464-478`) |
| `max_idle_timeout`; 2020 `idle_timeout` (string) | `max_idle_timeout` (uint64, ms) | rename (alias) and number | omitted. quiche omits parameters that have their default value | display only |
| `max_packet_size` (2020); current Chrome `max_udp_payload_size` (qvis kept it but never read it) | `max_udp_payload_size` | rename (alias). qvis read only `max_packet_size`, so for current Chrome the "max receiving size client/server" labels change from the 65527 default to the real value (T2, visible, correct) | omitted. The PQ default 65527 is the RFC 9000 default, so absence means 65527 | packetization labels |
| `initial_max_data` | the same, uint64 | number | omitted. The RFC default is 0, but consumers **skip** an absent value (congestion: PARITY truthiness; Stats: Q4 FIX, qvis pushed `NaN`) | Stats, congestion graph |
| `initial_max_stream_data_bidi_local`, `_bidi_remote`, `_uni` | the same | number | omitted, skipped | Stats (all three); congestion uses `_bidi_remote` |
| `initial_max_streams_bidi`, `_uni`, `ack_delay_exponent`, `max_ack_delay` (ms), `active_connection_id_limit`, `max_datagram_frame_size` | the same names | number | omitted | display |
| `original_destination_connection_id`, `initial_source_connection_id`, `retry_source_connection_id`, `stateless_reset_token` (string; the last token kept a trailing `]`) | the same names, lowercase hexstring without `0x` | Q13 FIX | omitted | display |
| `disable_active_migration` (qvis paired it with the next token) | `disable_active_migration: true` | flag | omitted (means false) | display |
| (flag `reliable_stream_reset` in current quiche; verify on a real log) | **`reset_stream_at: true`** (NEW in -13, quic-13:1043 "draft-ietf-quic-reliable-stream-reset") | flag | omitted | display |
| `0x<id>=<hex>` custom parameters (garbage in qvis) | `unknown_parameters: [{id, value}]` (quic-13:1106) | — | omitted | display |
| `preferred_address …` | `chromium_extra.preferred_address` (text) | -13 `PreferredAddress` needs a parsed IP, port, CID and token. Chrome's text form is not a stable grammar, so it is not parsed | omitted | display |
| Chromium/Google-only parameters (`google_connection_options`, `initial_round_trip_time`, `user_agent_id`, `google_handshake_message`, `min_ack_delay_us`, `legacy[…]`, `versions[…]`, `key_update_not_yet_supported`) | `chromium_extra: {…}` (extension, C11) | **no -13 equivalent** | omitted | display |
| (whole string) | `chromium_raw` (extension, C11) | lossless debugging aid | — | display |
| key count | `Object.keys(data).length` | qvis: 1 + the number of token pairs, including garbage pairs. New: `initiator` + standard keys + `unknown_parameters` + `chromium_extra` + `chromium_raw`. The sequence label "N transport parameters set" (`SEQ:2050-2065`) **differs**: 7 in qvis and 8 now for the 8.9 fixture. Accepted: for real Chrome strings qvis's N was an artefact of the broken pairing (section 3.6) | — | sequence label |

-13 semantics to respect: the model is cumulative per initiator, and a setting that an event does not mention is
**unchanged** (quic-13 §5.3). Chrome logs one SENT and one RECEIVED string per connection, so the converter never
merges. Consumers that fold several events must not treat an absent key as 0.
`QUIC_SESSION_TRANSPORT_PARAMETERS_RESUMED` → `quic:parameters_restored` (T3, quic-13:1137; no `initiator`, the values
are implicitly the remote parameters).

#### 9.3.2 `transport:packet_sent` → `quic:packet_sent` (Core, quic-13:1181)

| qvis field | Latest field | Semantics / change | Input lacks it | Consumers |
|---|---|---|---|---|
| `header.packet_type` (table 3.4a) | `header.packet_type` (`PacketHeader`, quic-13:2637) | same values and casing | an unknown `encryption_level` gives `"unknown"` and `netlog.unknown-encryption-level` (PARITY value) | SEQ chips and vantage guess, CG map keys, Stats Encryption levels |
| `header.packet_number: "<n>"` | `header.packet_number: n` (uint64, **optional** in -13) | Number. The PN space is not logged; it is implied by `packet_type` (Initial, Handshake and application-data numbers overlap) | omitted plus `netlog.missing-field` (qvis threw a TypeError) | SEQ arrows (skipped with a console error), CG keys |
| `frames: [...]` (tx buffer, possibly `[]`) | `frames: [$QuicFrame]` (optional in -13) | frames per 9.3.6; always emitted on sent packets (PARITY) | `[]` | every view |
| `raw.length: size` | `raw.length` (RawInfo, main-14:2211) | Chrome `size` is the encrypted packet length including the header and the 16-byte AEAD tag, which is what RawInfo.length means for packets (quic-13:245-252: the AEAD tag counts as a 16-byte trailer) | omit `raw`. CG and PQ skip the packet, as qvis did with `length: undefined` | CG byte axis, PQ |
| — | `raw.payload_length` | **not in netlog**, so omitted. PQ falls back to header = `min(4, length)` (PARITY) | — | PQ |
| (`transmission_type` ignored) | `trigger` | T3: `"pto_probe"` for `PTO_RETRANSMISSION`; other transmission types have no unambiguous -13 trigger, so omit | — | display |
| — | `is_mtu_probe_packet`, `datagram_id` | T3 only (8.4: MTU_DISCOVERY frame). `datagram_id` is not derivable on the send side (`COALESCED_PACKET_SENT.info` is free text) | — | — |

#### 9.3.3 `transport:packet_received` → `quic:packet_received` (Core, quic-13:1237)

| qvis field | Latest field | Semantics / change | Input lacks it | Consumers |
|---|---|---|---|---|
| `header.packet_type: "unknown"` placeholder, then table 3.4b | `header.packet_type` | same | stays `"unknown"` when no UNAUTHENTICATED header follows (legal `$PacketType`) | as 9.3.2 |
| `header.packet_number: ""` placeholder, then `"<n>"` | `header.packet_number: n`, **omitted** while unknown | `""` is not a uint64 | omitted. SEQ logs its "header.packet_number" console error and draws no arrow. In qvis `""` matched nothing either, so the visible result is the same | SEQ, CG |
| `is_coalesced: false` | **removed**: no -13 field. Coalescing is expressed with `datagram_id` (quic-13 §9, quic-13:3383-3397; ed: `datagram_payload_checksum`) | see 9.6 | — | nothing read it |
| `raw.length: size` | `raw.length` | **Semantic difference**: Chrome's `size` is the UDP datagram payload. It equals the QUIC packet size only when the datagram is not coalesced, while -13 means the packet's own length. PARITY: keep `size` (CG received bytes, PQ). T3 `splitCoalescedReceived` leaves `raw` on the first packet of the datagram only | omit `raw` | CG, PQ |
| `frames` (attached when the next PACKET_RECEIVED arrives) | `frames` | T2 flush at end of input (Q11). A received packet that never got frames gets `[]` at flush | `[]` | CG now also processes the **last** received packet's ACK frames (visible on short traces). Stats counts its frames |
| — | `trigger: "keys_available"` | no reliable netlog signal: ATTEMPTING_TO_PROCESS_UNDECRYPTABLE_PACKET does not say which later PACKET_RECEIVED it belongs to. Not emitted | — | — |

#### 9.3.4 `recovery:packet_lost` → `quic:packet_lost` (Core, quic-13:2413)

| qvis field | Latest field | Semantics / change | Input lacks it | Consumers |
|---|---|---|---|---|
| `header.packet_type: "unknown"` | the same; `"unknown"` is a `$PacketType` | -13: "should include at least the packet_type and packet_number". Chrome's PACKET_LOST has no encryption level | — | CG: there is no sent map for type `unknown`, so the loss is **not plotted** ("Packet was LOST that we didn't send... ignoring", PARITY). SEQ label `"unknown packet lost #N"` (`SEQ:2099-2111`, PARITY). Stats counts `unknown` |
| `header.packet_number: "<n>"` | number | — | omitted, so the SEQ label falls back to `packet_lost` | — |
| — | `trigger` (`reordering_threshold` / `time_threshold` / `pto_expired`) | Chrome does not log the detection reason, so omitted | — | — |
| — | `frames`, `is_mtu_probe_packet` | no source | — | — |
| — | T3 `packet_type` resolution | the latest earlier `quic:packet_sent` with the same `packet_number`. This is a heuristic because PN spaces overlap, so it stays T3 | — | with T3 the CG plots netlog losses |

-13 `packet_lost` has no `raw`. The CG tooltip takes the size from the matched `quic:packet_sent` (data-model L3). For
netlog that match fails in T1/T2 anyway.

#### 9.3.5 `transport:packet_dropped` → `quic:packet_dropped` (Base, quic-13:1293)

| qvis field | Latest field | Semantics / change | Consumers |
|---|---|---|---|
| `header.packet_type` (`ENCRYPTION_HANDSHAKE` → `handshake`, everything else `unknown`) | `header.packet_type = levelToType(encryption_level)` for all four levels (T2) | -13: the header is optional and "primarily packet_type should be filled" | Stats Encryption-level counts move from `unknown` to `initial` / `0RTT` / `1RTT` where Chrome said so (T2, visible). SEQ label `packet_dropped` unchanged |
| `header.packet_number: ""` | omitted | not a uint64, and Chrome does not know it | — |
| — | `trigger: "key_unavailable"` (quic-13:1309; ed `keys_unavailable`) | NEW, semantically exact ("decryption key was unavailable", quic-13:1336) | display |
| — | `raw`, `datagram_id`, `details` | no source | — |

T3: `QUIC_SESSION_BUFFERED_UNDECRYPTABLE_PACKET` → `quic:packet_buffered {header: {packet_type}, trigger:
"keys_unavailable"}` (quic-13:1360, :1373).

#### 9.3.6 QUIC frames inside packet events (`$QuicFrame`, quic-13 §8.13)

| qvis frame | Latest frame (quic-13 line) | Field mapping | Input lacks it | Consumers and visible effect |
|---|---|---|---|---|
| `{frame_type: "crypto", offset: "o", length: "l"}` | CryptoFrame (2992): `offset` and `raw` **required** | `offset: o`, `raw: {length: l}`. quic-13:2988: "The length field of the Crypto frame MUST be logged in the qlog raw.length field" | no `offset`: omit it. No `data_length`: emit `raw: {}` so the required member exists | PQ reads `streamFrameDataLength(f) = raw.payload_length ?? raw.length ?? length` and gets the same split as qvis |
| `{frame_type: "padding"}` | PaddingFrame (2818) | the same. T3: `raw: {payload_length: num_padding_bytes}` (one PADDING frame SHOULD stand for all padding) | — | PQ gives it a share of the leftover bytes (PARITY) |
| `{frame_type: "ping"}` | PingFrame (2827) | the same | — | chip, count |
| `{frame_type: "stream", stream_id: "s", offset: "o", length: "l", fin}` | StreamFrame (3029): `stream_id` required, `offset` `.default 0`, `fin` `.default false` | `stream_id: s`, `offset: o`, `fin`, `raw: {length: l}` (quic-13:3012) | no `offset`: omit (readers apply `?? 0`). No `length`: omit `raw` (MX skips the frame; PQ sizes it like a non-STREAM frame). No `stream_id`: drop the frame and count `netlog.missing-field` | MX collapsed/byteranges/waterfall, PQ, SEQ chip `"stream s[ FIN]"` unchanged |
| `{frame_type: "ack", acked_ranges: [["a","b"], …]}` | AckFrame (2868) | `acked_ranges: [[a, b] \| [a]]` as numbers. A range with a == b is `[a]` (quic-13:2893: SHOULD log `[120]`, tools MUST accept both). Ranges with from > to are dropped (T2, 8.5.2) | no `largest_observed`: omit `acked_ranges` (optional) and count `netlog.missing-field`. No `smallest_observed`: 8.5.2 | CG ACK matching (`parseInt` accepts both forms). SEQ chip unchanged, because qvis printed `[a, a]` as `a` too |
| (`delta_time_largest_observed_us` ignored) | `ack_delay` (float32, **ms**) | T3: µs / 1000 | — | not read |
| (ECN `ECT0` / `ECT1` / `CE` ignored) | `ect0` / `ect1` / `ce` | T3 | — | not read |
| `{frame_type: "max_data", maximum: "m"}` | MaxDataFrame (3041) | `maximum: m` | no `byte_offset`: frame without `maximum` (consumers test `!== undefined`) | CG FC line (received packets), Stats connection FC, SEQ `"max data m"` |
| `{frame_type: "max_stream_data", stream_id: "s", maximum: "m"}` | MaxStreamDataFrame (3051) | numbers | as above | qvis tested truthiness on **strings**, so stream `"0"` printed `"max data m (stream 0)"`. With numbers that output survives only because of the sequence-diagram FIX SQ13 (`!== undefined`). Do not drop SQ13 |
| `{frame_type: "reset_stream", stream_id, error_code: <quic_rst_stream_error, a Chromium-internal code>, final_size: "<offset>"}` | ResetStreamFrame (2917): `stream_id`, `error` (required, `$ApplicationError`), `error_code` (when `error` is `"unknown"`), `final_size` (required) | `error = h3AppErrorName(ietf_error_code) ?? "unknown"`; `error_code = ietf_error_code` only when unknown. Without `ietf_error_code` (2020 Chrome): `error: "unknown", error_code: quic_rst_stream_error`. Frame-level extension `chromium_rst_stream_error: quic_rst_stream_error` (allowed: open frame map) | no `offset`: omit `final_size` and count `netlog.missing-field` | SEQ chip goes from qvis `"reset stream 4 (6)"` (internal code) to `"reset stream 4 (http_request_cancelled)"` (T2, visible, correct wire semantics) |
| `{frame_type: "stop_sending", stream_id, error_code: <application_error_code>}` (`undefined` with current Chrome) | StopSendingFrame (2973): `stream_id`, `error` (required), `error_code` | code = `ietf_error_code ?? application_error_code`, mapped as above; otherwise `error: "unknown"` plus `error_code: quic_rst_stream_error` when present | none at all: `error: "unknown"` alone (still valid) | qvis `"stop sending 4"` → `"stop sending 4 (http_request_cancelled)"` (T2, visible) |
| `{frame_type: "connection_close", error_space: "transport_error", error_code: quic_error, raw_error_code: quic_error, reason}` | ConnectionCloseFrame (3207): `error_space` (`"transport"` / `"application"`), `error`, `error_code` (when unknown), `reason`, `trigger_frame_type` | `error_space` from `close_type`. Old `error_code` (string or enum) → new `error`; old `raw_error_code` → new `error_code`, only when `error === "unknown"`. Uses the **wire** code `quic_wire_error ?? quic_error` (8.4). `chromium_quic_error` frame extension. T3 `trigger_frame_type` | no `details`: omit `reason` | SEQ chip goes from qvis `"connection_close 25 : …"` (Chromium `QuicErrorCode`) to `"connection_close : clean"` for wire code 0, else `"connection_close <name> : <reason>"` (T2, visible) |
| — | HandshakeDoneFrame (3229), NewConnectionIDFrame (3117), RetireConnectionIDFrame (3143), MaxStreamsFrame (3062), StreamsBlockedFrame (3106), PathChallenge/ResponseFrame (3153ff), NewTokenFrame (3002), DatagramFrame (3270, from MESSAGE) | T3 only (8.4) | — | SEQ chips, Stats counts, PQ frame lane |
| — | ResetStreamAtFrame (2939), DataBlockedFrame / StreamDataBlockedFrame, UnknownFrame (3253) | **no netlog source**. Chrome has no RESET_STREAM_AT event; `BLOCKED_FRAME` has no `limit`; unknown QUIC frames are not logged | — | — |

Frame-level error names follow C10. Transport names use quic-13:3309 (`no_error` … `no_viable_path`); 0x100-0x1ff
becomes `crypto_error_0x1NN` in lowercase (quic-13:3379). HTTP/3 names use h3-13:1013-1029. Codes that exist only in
the editor's copy (`http_message_error` 0x10e, `qpack_decompression_failed` 0x200, `qpack_encoder_stream_error` 0x201,
`qpack_decoder_stream_error` 0x202, `http_datagram_error` 0x33) are emitted as `error: "unknown"` with `error_code`.
This keeps converter output valid against the strict -13 validator (`scripts/validate-qlog.mjs`). -13's own
`http_early_response` has no RFC 9114 code, so it is never emitted.

#### 9.3.7 `http:stream_type_set` → `http3:stream_type_set` (Base, h3-13:463)

| qvis field | Latest field | Semantics / change | Input lacks it |
|---|---|---|---|
| `owner` | `initiator` | the side that **opened** the stream: `HTTP3_PEER_*` → `remote`, `HTTP3_LOCAL_*` → `local` | always set |
| `new: "control" \| "qpack_encode" \| "qpack_decode"` | `stream_type` (`$HTTP3StreamType`) | same values. The old `data` would be `request`; netlog never produces it | — |
| `stream_id: "n"` | `stream_id: n` (required) | number | skip the event and count `netlog.missing-field` (qvis threw a TypeError) |
| — | `stream_type_bytes`, `associated_push_id` | not applicable | — |

Consumers: no view reads a field (4.3.2). The event shows as the default SEQ label `stream_type_set` and in the Stats
events table under namespace `http3`.

#### 9.3.8 `http:parameters_set` → `http3:parameters_set` (Base, h3-13:365)

| qvis field | Latest field | Semantics / change |
|---|---|---|
| `owner` | `initiator` | `HTTP3_SETTINGS_SENT` → `local`, `…_RECEIVED` → `remote`. -13's prose calls received settings "received", an erratum; ed: `remote` |
| `max_header_list_size` (from `SETTINGS_MAX_HEADER_LIST_SIZE`; `undefined` with current Chrome) | `max_field_section_size` from `SETTINGS_MAX_FIELD_SECTION_SIZE ?? SETTINGS_MAX_HEADER_LIST_SIZE` | rename (RFC 9114 name), T2 (Q14) |
| `max_table_capacity` | the same | — |
| `blocked_streams_count` | the same | — |
| — | `extended_connect`, `h3_datagram` | T3 from `SETTINGS_ENABLE_CONNECT_PROTOCOL` / `SETTINGS_H3_DATAGRAM` (8.5.4) |
| — | `unknown_settings` (editor's copy only), `chromium_settings` (extension, C11) | T3. -13 itself permits "any number of unspecified fields" in prose (h3-13:399) |
| key count | `Object.keys(data).length` | qvis: always 4 (the keys exist with `undefined` values). New: 1 + the keys that are present, so `"4 HTTP/3 parameters set"` whenever Chrome logs all three settings (the normal case) and fewer otherwise |

An absent setting is omitted.

#### 9.3.9 `http:frame_created` / `http:frame_parsed` → `http3:frame_created` / `http3:frame_parsed` (Core, h3-13:542, :569)

| qvis field | Latest field | Semantics / change | Input lacks it |
|---|---|---|---|
| `stream_id: "n"` | `stream_id: n` (required) | number | skip the event and count `netlog.missing-field` |
| HEADERS `frame: {frame_type: "headers", headers: [{name, value}]}` | HTTP3HeadersFrame (h3-13:742): `headers: [HTTP3HTTPField]` (h3-13:733; `name` / `value` text, all optional; an entry MUST carry `name` or `name_bytes`) | T2 parsing of the list format (8.5.3). An entry without `": "` becomes `{name}`. Chrome logs text, so `name_bytes` / `value_bytes` are never needed | `headers: []` |
| — | HEADERS `frame.raw` | no length on `HTTP3_HEADERS_SENT` / `_DECODED`. T3: `HTTP3_HEADERS_RECEIVED.payload_length` (the param name in `net_log_event_type_list.h`; accept `compressed_headers_length` as an alias) → `frame.raw.payload_length` on the next `HEADERS_DECODED` of that stream | — |
| DATA `frame: {frame_type: "data"}` plus event-level `byte_length: "<payload_length>"` | HTTP3DataFrame (h3-13:711): **`frame.raw.payload_length`** | moved into the frame. It is the frame payload; `frame.raw.length` (type varint + length varint + payload) is not emitted | no `payload_length`: frame without `raw`. PQ then skips it like qvis skipped a missing `byte_length` |
| created vs parsed by `"SENT"` in the netlog type | the same rule | — | — |

Consumers: PQ `h3FramePayloadLength(frame)` (HEADERS without `raw` are skipped with the qvis console message, PARITY),
MX simulation/waterfall headers, SEQ labels, Stats H3 header row through `fieldName()` / `fieldValue()`.

#### 9.3.10 `info:marker` (string `data`) → `loglevel:info` (Extra, main-14:2092), decision C8

```json
{"time": 1, "name": "loglevel:info", "data": {"message": "CERT_VERIFIER_REQUEST BEGIN"}}
```

`PHASE_BEGIN` gives `"CERT_VERIFIER_REQUEST BEGIN"`. Every other phase, including `PHASE_NONE`, gives
`"CERT_VERIFIER_REQUEST END"` (PARITY).

Why `loglevel:info` and not `simulation:marker` (the former C5):

| Criterion | qvis | `loglevel:info {message}` (chosen) | `simulation:marker {type, message}` | `simulation:marker {type}` |
|---|---|---|---|---|
| Semantics | category `info` | "unstructured string messages" (main-14 §9.1.3): exact | "specific emulation conditions … (e.g., … 2% packet loss is introduced)" (main-14 §9.2.2): wrong | wrong |
| SEQ colour | lightgrey (category `info`) | lightgrey: PARITY | orange | orange |
| SEQ label | `"marker"` (artefact: `data.message` undefined) | `"info: CERT_VERIFIER_REQUEST BEGIN"` | `"simulation: CERT_VERIFIER_REQUEST BEGIN"` | `"marker"` |
| Stats events table | `info` → `marker` | `loglevel` → `info` | `simulation` → `marker` | `simulation` → `marker` |

`LogLevelInfo.message` is required (main-14:2092), so the label cannot stay `"marker"`. The new label is the
informative form that qvis would have shown if the data had been an object. It is documented as Q21.

### 9.4 TCP output (private namespaces), field by field

No IETF qlog draft defines TCP, TLS-record or HTTP/2 events (h3-13 §1 excludes HTTP/2). The converter keeps qvis's
model under the private namespaces of 8.6.1, uses main-14 RawInfo (main-14:2211) for every length, and adds no
fields beyond 8.6.1 except the C9 compat field.

| qvis event.field | Latest-draft-shaped output | Notes | Input lacks it | Consumers |
|---|---|---|---|---|
| `transport:packet_sent` / `packet_received` | `tcp:packet_sent` / `tcp:packet_received` | category `transport` is pre-final and would raise DM3 | — | `PT`; SEQ, CG and Stats through `transportNamespace` (9.5) |
| `header.payload_length` (`tcp.len`; lost to `fix02Compatibility`, Q2) | `raw.payload_length` | RawInfo "payload excluding headers" | no `tcp.len`: omit and count `tshark.missing-field`. `PT` treats a missing value as 0 (skip, FIX: qvis produced `NaN`) | `PT` |
| `header.header_length` (`tcp.hdr_len`) | `header.header_length` | private (RawInfo has no header length, main-14 §10) | readers fall back to `raw.length - raw.payload_length` | `PT` |
| `raw.length` (hdr + len) | `raw.length` | the same | omitted when both inputs are missing | CG |
| `header.sequence_number` | the same | not read | — | none |
| `header.packet_type: "1RTT"` | the same (compat) | lets QUIC-shaped views treat TCP segments as qvis did | — | SEQ chip `"1RTT : n"`, CG keys, Stats |
| `header.packet_number` (`frame.number`) | the same, plus `capture_frame_number` | — | — | SEQ, CG |
| `tls:record_created` / `record_parsed` `header.content_type` | the same | values verbatim (`"change-cipherspec"` …) for tooltips | `"unknown"` (PARITY) | `PT` |
| `header.header_length: 5` | the same | — | — | `PT` |
| `header.payload_length` | `raw.payload_length` (= `recordLength - trailer`) | the retroactive trailer adjustment mutates it (8.6.4) | missing `tls.record.length`: omit and count `tshark.missing-field` (qvis: `NaN`) | `PT` |
| `header.trailer_length` | the same | — | — | `PT` |
| `header.DEBUG_wiresharkFrameNumber` | `capture_frame_number` (event data) | tooltip text unchanged | — | `PT` tooltip |
| `header.packet_type: "1RTT"` | **kept** (C9). Add `? packet_type: "1RTT"` to `TLSRecordHeader` in 8.6.1 | Stats `encryptionLUT` scans every event (shape). Without it the example shows `1RTT` 183 instead of qvis's 283 | — | Stats |
| `header.packet_number: ""` | dropped | not read anywhere | — | none |
| — | `raw.length = 5 + recordLength`, `header.version` (T2) | — | — | display |
| `http2:frame_created` / `frame_parsed` `stream_id` (-1 for magic) | the same | -1 keeps the lavenderblush segment and the "streamID: -1" tooltip | — | `PT`, SEQ |
| `payload_length` | `frame.raw.payload_length` | — | — | `PT` |
| `header_length` (9, or 0 for magic) | derived as `frame.raw.length - frame.raw.payload_length` | — | — | `PT` |
| `frame.frame_type`, `frame.headers`, `frame.stream_end` | the same | T2: `headers` is always an array (Q4) | `headers: []` | `PT`, SEQ label, Stats |
| `frame.byte_length` | dropped (equal to `payload_length` for DATA) | not read | — | none |

**Supersedes** packetization-diagram.md §4 rows "TCP: … `data.header.{header_length, payload_length}` … same fields
(converter-defined)" and "TLS: … same". The contract is 8.7: payload lengths in `raw.payload_length`, the frame number
in `capture_frame_number`. Recommendation for `PT`: read `raw.payload_length ?? header.payload_length` and
`capture_frame_number ?? header.DEBUG_wiresharkFrameNumber`, so either form works.

### 9.5 Consumer contract per view (cross-spec obligations)

| View | Reads from netlog output | Reads from TCP output | Obligations on other specs |
|---|---|---|---|
| Sequence diagram | `quic:packet_sent/received` `header.packet_type`, `header.packet_number`, `frames[]` (9.3.6 fields); `quic:packet_lost` header; `quic:parameters_set` / `http3:parameters_set` key count; `http3:frame_*` `stream_id`, `frame.frame_type`, `frame.headers`; `loglevel:info.message`; other events by name | `tcp:packet_*` as arrows, `http2:frame_*` labels and blue colour, `tls:record_*` default red labels | qvis drew TCP arrows and H2 labels through type-only matching (3.12). data-model §9.10 items 2-3 (`transportNamespace`, `http2:` frame labels) and C4 keep this. **sequence-diagram.md does not yet mention them**: it must look up `conn.transportNamespace` for packet events and apply the `frame_created` / `frame_parsed` label and colour to `http2:` on converter traces. SQ13 (`!== undefined`) is required for stream-0 labels (9.3.6) |
| Congestion graph | `quic:packet_sent/received` `raw.length`, `header.packet_type`, `header.packet_number`, frames `ack.acked_ranges`, `max_data.maximum`, `max_stream_data.{stream_id, maximum}`; `quic:parameters_set` with `initiator === "remote"` (`initial_max_data`, `initial_max_stream_data_bidi_remote`); `quic:packet_lost` header | `tcp:packet_*` `raw.length`, `header.packet_type`, `header.packet_number` | No `quic:recovery_metrics_updated` exists in either output, so the RTT and cwnd panels stay empty (PARITY, 9.6). TCP plotting needs `transportNamespace` (data-model §9.10). congestion-graph.md §4 drops the `!== "TCP"` console gate (its `common_fields.protocol_type` row), which is consistent |
| Multiplexing graph | `quic:packet_*` STREAM frames (`stream_id`, `offset ?? 0`, `streamFrameDataLength`, `fin`), `header.packet_number`; `http3:frame_created` (client) HEADERS `:method`, `:path`, `priority` | nothing (PARITY, multiplexing-graph.md §9.1 table) | netlog output has no `quic:stream_data_moved` and no PRIORITY_UPDATE frames (T1/T2), as in qvis |
| Packetization diagram | `quic:packet_*` `raw.length` (no `payload_length`), `header.packet_type`, `frames[]`; `quic:parameters_set` `initiator` + `max_udp_payload_size`; `http3:frame_*` `frame.raw.payload_length` (DATA), HEADERS `headers`; trace `vantage_point.type` | `tcp:` / `tls:` / `http2:` per 8.7; mode from `protocolHint === "TCP_HTTP2"` | packetization-diagram.md §4 TCP/TLS/H2 rows are superseded by 8.7 and 9.4 |
| Statistics | shape scans: `header.packet_type` on every event (including `quic:packet_lost` `"unknown"` and `quic:packet_dropped`), `data.frames[].frame_type`, `data.frame.frame_type`; FC from `quic:parameters_set` and MAX_DATA / MAX_STREAM_DATA by direction; H3 header row from `http3:frame_*` headers | shape scans count `tcp:` and `tls:` (C9) `header.packet_type` and `http2:` `frame.frame_type` | statistics.md §3.6 states "`tcp:` / `tls:` … count too", which C9 makes true |

### 9.6 Old members and inputs with no latest-draft equivalent

| Old member / netlog or tshark input | Why there is no equivalent | Behaviour in qvis-react |
|---|---|---|
| `qlog_version`, `event_fields`, array events, string `reference_time` | removed from main-schema | 9.2 |
| category `transport` / `recovery` / `http` / `info` | single namespaces `quic`, `http3`; `http` is the Capsule namespace | 9.1 rule 2 |
| `owner` (transport and HTTP/3 parameters, stream type) | renamed `initiator` | 9.3.1, 9.3.7, 9.3.8 |
| `stream_type_set.new` | renamed `stream_type` | 9.3.7 |
| `max_packet_size`, `idle_timeout`, `max_header_list_size` | renamed `max_udp_payload_size`, `max_idle_timeout`, `max_field_section_size` | aliases at conversion |
| `is_coalesced` | replaced by `datagram_id` (ed: `datagram_payload_checksum`) | dropped. T3 `splitCoalescedReceived` sets `datagram_id` (9.7) |
| `header.packet_number: ""` placeholders | `""` is not a uint64 | omitted |
| `error_space: "transport_error" \| "application_error"` | values `transport` / `application` | renamed |
| old `error_code` (string) / `raw_error_code` (number) on frames | now `error` (string) / `error_code` (number, only when unknown) | 9.3.6 |
| Chromium-internal error codes (`quic_rst_stream_error`, `quic_error`) | not wire codes | frame extensions `chromium_rst_stream_error`, `chromium_quic_error`; T3 `quic:connection_closed.internal_code` |
| H3 event-level `byte_length` | moved to `frame.raw.payload_length` | 9.3.9 |
| `info:marker` with string `data` | event data must be an object; `info` is not a namespace | `loglevel:info {message}` (C8) |
| `common_fields.protocol_type` | removed in main-schema-11 in favour of `event_schemas` | kept as a custom common field (9.2) |
| Chrome/Google transport parameters, `preferred_address` text | not defined by -13 | `chromium_extra` (C11) |
| Chrome HTTP/3 settings outside -13 | -13 allows ad-hoc fields in prose only | T3 `chromium_settings` / `unknown_settings` |
| QUIC `raw.payload_length` for netlog packets | Chrome does not log it | absent; PQ fallback (PARITY) |
| RTT, cwnd, bytes in flight (`quic:recovery_metrics_updated`) | Chrome logs no per-event recovery state. Deriving `latest_rtt` from ACK receipt minus `sent_time_us` would put converter estimates into a Core event that by definition reports the implementation's own state, with only 1 ms receive resolution | **not emitted**. The congestion RTT/cwnd panels stay empty for netlogs, as in qvis |
| `QUIC_CONGESTION_CONTROL_CONFIGURED` (`congestion_control_type`, `use_pacing`, `initial_congestion_window` in packets) | `quic:recovery_parameters_set` requires `timer_granularity` (unknown) and wants the window in bytes | not emitted (no faithful mapping) |
| `quic:packet_lost.trigger`, `quic:packet_received.trigger` | no netlog source | omitted |
| TCP, TLS records, HTTP/2 | no IETF qlog schema | private namespaces (9.4) |
| TCP `sequence_number`, TLS `trailer_length` / `header_length`, H2 `stream_id: -1` | private | 8.6.1 |

### 9.7 New in the latest drafts: what the converters could emit

T1/T2 output does not change for any of these, because qvis showed none of them and every added event appears in the
sequence diagram and the Stats tables. The rows marked T3 are specified for `extended: true`. "Not adopted" rows are
recorded so nobody re-derives them.

| Latest-draft feature | Source | Decision | Effect when enabled |
|---|---|---|---|
| `quic:version_information` (Core, quic-13:905) | `QUIC_SESSION.versions` (Chrome labels, e.g. `"RFCv1"`), `QUIC_SESSION_VERSION_NEGOTIATED.version`, `…_VERSION_NEGOTIATION_PACKET_RECEIVED.versions` | T3. Map labels to hex: `RFCv1` → `00000001`, `RFCv2` → `6b3343cf`, `draft29` → `ff00001d`; a 4-character gQUIC label (`Q050`, `T051`, `Q046`, …) → the hex of its ASCII bytes (`Q050` → `51303530`); skip unknown labels. BEGIN gives `client_versions`; VERSION_NEGOTIATED gives `chosen_version`; a VN packet gives `server_versions` (8.4 row updated) | SEQ label `version_information` |
| `supported_versions` on a VN `packet_received` | `…_VERSION_NEGOTIATION_PACKET_RECEIVED.versions` | T3 (label mapping above) | popup only |
| `quic:connection_closed` (Base, quic-13:621) | `QUIC_SESSION_CLOSED` (`quic_error`, `details`, `from_peer`) | T3 (8.4): `initiator`, `internal_code`, `reason`. `trigger` is not mapped, because a QuicErrorCode → trigger table would be guesswork | SEQ label |
| `quic:connection_state_updated` `handshake_complete` (quic-13:719, :744) | `QUIC_SESSION_CRYPTO_HANDSHAKE_COMPLETE` | T3: `{new: "handshake_complete"}` | SEQ label "Connection state: handshake_complete" |
| `quic:packet_dropped` trigger `duplicate` | `QUIC_SESSION_DUPLICATE_PACKET_RECEIVED.packet_sequence_number` | T3: `{header: {packet_type: <type of the current rx packet>, packet_number}, trigger: "duplicate"}` | Stats count, SEQ label |
| `quic:packet_buffered` | `…_BUFFERED_UNDECRYPTABLE_PACKET` | T3 (8.4) | SEQ label |
| `datagram_id` + `quic:udp_datagrams_received` (Extra, quic-13:1467), replacing `is_coalesced` | `PACKET_RECEIVED` (one UDP datagram) followed by several UNAUTHENTICATED headers | T3 with `splitCoalescedReceived`: `datagram_id` = per-session counter of PACKET_RECEIVED, set on every `quic:packet_received` split from it; emit `quic:udp_datagrams_received {count: 1, raw: [{length: size}], datagram_ids: [id]}` just before the first packet. The send side is not derivable | SEQ label `udp_datagrams_received` (white chip) |
| `quic:tuple_assigned` + event-level `tuple` (quic-13:816; replaces main-schema ≤ 12 `path`) | `PACKET_RECEIVED.peer_address` / `self_address` | T3, **deferred**. On the first PACKET_RECEIVED emit `{tuple_id: "", tuple_local: {ip_v4 \| ip_v6, port_v4 \| port_v6}, tuple_remote: {…}}`. When the pair changes (migration), emit a new `tuple_id` (`"1"`, `"2"`, …) and set `tuple` on later events. No qvis view reads `tuple`, so implement only when a view needs it | SEQ labels |
| `quic:connection_started` | QUIC_SESSION BEGIN plus the first PACKET_RECEIVED addresses | not adopted: the addresses are known only at the first received packet, so the event time would be wrong | — |
| `quic:frames_created` / `frames_parsed` / `frames_processed` (quic-13:1700ff; `frames_processed` removed in ed) | — | not used. Netlog frames always belong to a packet. Frames without one (leftover tx frames, rx frames before the first PACKET_RECEIVED) were never confirmed on the wire, so they are dropped with a diagnostic (8.4) rather than logged as frame events | — |
| `quic:packets_acked` (Extra, quic-13:1405) | derivable from ACK frames | not emitted: it duplicates the ACK frames, and the congestion graph derives first-time acks itself | — |
| `quic:recovery_metrics_updated`, `recovery_parameters_set`, `congestion_state_updated` | none | not emitted (9.6) | — |
| `quic:key_updated` (quic-13:2139) | `QUIC_SESSION_KEY_UPDATE.reason` | not adopted: `key_type` is required and Chrome does not say which direction or phase | — |
| new frames: `reset_stream_at`, `datagram`, `handshake_done`, `new_token` as a Token object, … | MESSAGE → `datagram`; HANDSHAKE_DONE (received); NEW_TOKEN; no RESET_STREAM_AT source | T3 (8.4) | SEQ chips, Stats, PQ |
| `http3:frame_*` `cancel_push` (h3-13:803) | `HTTP3_CANCEL_PUSH_RECEIVED.push_id` | T3: `http3:frame_parsed {stream_id: <peer control stream>, frame: {frame_type: "cancel_push", push_id}}`; skip when the peer control stream id is unknown | SEQ label |
| `http3:frame_*` `origin` (h3-13:985) | `QUIC_SESSION_ORIGIN_FRAME_RECEIVED.origins` | T3: `frame_parsed` on the peer control stream, `{frame_type: "origin", origin_entries: origins.map(o => ({origin_len: o.length, ascii_origin: o}))}` | SEQ label |
| `http3:priority_updated` | — | not used; T3 emits PRIORITY_UPDATE **frames** (8.4), which the waterfall reads | waterfall triangles |
| `TraceError` (main-14 §4.3) | sessions without events | not adopted: qvis dropped them (PARITY, `netlog.empty-session-dropped`) | — |
| TCP / TLS / HTTP/2 | — | nothing new in the drafts. RawInfo is already used | — |

### 9.8 Decisions and edits made by this section

- New decisions C8–C13 (8.11). C5 is superseded by C8.
- Section 4.3 was rewritten after re-checking the source. The earlier table missed: the TLS `packet_type` count in
  Stats; the HTTP/2 frame counts and labels; the congestion-graph flow-control lines from `transport:parameters_set`;
  the parameters key-count labels; and the per-view frame fields. It also wrongly claimed that `http:stream_type_set`
  fed stream classification. Section 4.4 is new.
- 8.3 / 8.4: `event_schemas` per C13 and C11, the marker row per C8, the `HTTP3_HEADERS_RECEIVED` parameter name
  (`payload_length`), the T3 `version_information` label mapping, and a pointer to 9.7.
- 8.5.1: generic flag rule, quoted values, `reliable_stream_reset` → `reset_stream_at`.
- 8.5.5: HTTP/3 names restricted to h3-13 (C10).
- 8.6.1 / 8.6.4: `TLSRecordHeader.packet_type` (C9).
- 8.8: diagnostics `netlog.missing-field`, `tshark.missing-field`.
- 8.9.2: expected output updated (markers, `event_schemas`).
- 7 Q21: the new target is `loglevel:info`.

### 9.9 Additional tests

1. **Strict validation.** Run the 8.9.2 output through `scripts/validate-qlog.mjs` after removing `chromium_*` keys
   from event `data`. It must pass with no `--allow-unknown-events`. TCP output passes only the envelope and private
   schema checks.
2. **Conformance.** Loading converter output raises **no** `event.nonconforming-name` diagnostic (no DM3 toast), and
   P14 reports no unused or unlisted schema, for the 8.9.1 fixture and for the TCP example.
3. **protocolHint.** Netlog traces give `"QUIC_HTTP3"` and TCP traces give `"TCP_HTTP2"`.
4. **Stats parity (TCP example).** Encryption levels `1RTT` 283 (C9); Frames histogram as in 4.3.1.
5. **Sequence labels (netlog fixture).** `"8 transport parameters set"`, `"4 HTTP/3 parameters set"`,
   `"info: CERT_VERIFIER_REQUEST BEGIN"` in lightgrey, `"unknown packet lost #1"`; a STREAM chip `"stream 0 FIN"`.
6. **Error names (C10).** RST_STREAM with `ietf_error_code` 0x10c → `error: "http_request_cancelled"`, no
   `error_code`. With 0x10e → `error: "unknown", error_code: 270`. CONNECTION_CLOSE with `quic_wire_error` 0x128 in
   transport space → `error: "crypto_error_0x128"`.
7. **uint64 (C12).** A netlog `offset` of `"9007199254740993"` stays the string `"9007199254740993"`; `"42"` becomes
   `42`.
8. **Tokenizer.** `"[Client max_idle_timeout 30000 reliable_stream_reset user_agent_id \"Chrome/1 Linux\" initial_max_data 10]"`
   → `{max_idle_timeout: 30000, reset_stream_at: true, initial_max_data: 10, chromium_extra: {user_agent_id: "Chrome/1 Linux"}, chromium_raw: <input>}`
   (plus `initiator` from the event). The 8.9.3 messy vector keeps its expected output under the refined tokenizer.

### 9.10 Summary: latest-draft events and fields that the converter output feeds

- `quic:parameters_set` — `initiator`, `max_udp_payload_size`, `initial_max_data`,
  `initial_max_stream_data_bidi_local/_bidi_remote/_uni`, `max_idle_timeout`, the other RFC 9000 parameters,
  `reset_stream_at`, `unknown_parameters`; extension `chromium_raw`, `chromium_extra`; key count.
- `quic:packet_sent` / `quic:packet_received` — `header.packet_type`, `header.packet_number`, `frames[]`,
  `raw.length` (no `raw.payload_length`).
- `quic:packet_lost` — `header.packet_type` (`"unknown"`), `header.packet_number`.
- `quic:packet_dropped` — `header.packet_type`, `trigger: "key_unavailable"`.
- Frames — `crypto {offset, raw.length}`, `padding`, `ping`, `stream {stream_id, offset, fin, raw.length}`,
  `ack {acked_ranges [[a,b]|[a]]}`, `max_data {maximum}`, `max_stream_data {stream_id, maximum}`,
  `reset_stream {stream_id, error, error_code?, final_size}`, `stop_sending {stream_id, error, error_code?}`,
  `connection_close {error_space, error, error_code?, reason}`.
- `http3:stream_type_set` — `initiator`, `stream_id`, `stream_type`.
- `http3:parameters_set` — `initiator`, `max_field_section_size`, `max_table_capacity`, `blocked_streams_count`; key
  count.
- `http3:frame_created` / `http3:frame_parsed` — `stream_id`; `frame.frame_type` `headers` (`headers[{name, value}]`)
  or `data` (`raw.payload_length`).
- `loglevel:info` — `message`.
- Trace — `common_fields.protocol_type` (custom), `common_fields.reference_time {clock_type, epoch}`,
  `common_fields.time_format`, `vantage_point.type`, `title`, `event_schemas`.
- `tcp:packet_sent` / `tcp:packet_received` — `header.{sequence_number, header_length, packet_type: "1RTT",
  packet_number}`, `raw.{length, payload_length}`, `capture_frame_number`.
- `tls:record_created` / `tls:record_parsed` — `header.{content_type, header_length, trailer_length,
  packet_type: "1RTT", version?}`, `raw.{length, payload_length}`, `capture_frame_number`.
- `http2:frame_created` / `http2:frame_parsed` — `stream_id`, `frame.{frame_type, headers?, stream_end?,
  raw.{length, payload_length}}`.

## 10. Integration addendum (as built)

- **Frame-level Chromium extension keys are not emitted.** `chromium_rst_stream_error` and `chromium_quic_error`
  (§8.4, §8.9 test 3, §9.3 rows above) rely on `$QuicFrame /= {* text => any}`, which is an illustrative figure that
  the normative CDDL (and `scripts/validate-qlog.mjs`, `scripts/cddl/README.md`) excludes. Emitting them would make the
  output CDDL-invalid, so read those rows as "not emitted". A future version must declare them through a private
  extension schema instead.
- **Zero QUIC sessions / zero TCP connections** reject the file with the error toast ("Error uploading file" + the
  §8.8 explanatory text), because the loader never adds empty groups (gaps G10).
- **C2:** the debug page (`#/debug`) has the "Convert with extended mappings" checkbox
  (`setExtendedConversion()` in `src/loading/fileLoader.ts`); it applies to files loaded afterwards.
- **C6:** `public/examples/tcp/wikipedia_Playstation.json` is shipped with its MIT attribution
  (`public/examples/tcp/README.md`). It is not listed in `public/examples/index.json`, so Option 3 is unchanged.
- The private TCP/TLS/HTTP2 CDDL lives in `src/converters/tshark/tcp-tls-http2.cddl` (validated by the converter
  tests when `CDDL_BIN` is set); `scripts/validate-qlog.mjs` stays draft-only.
