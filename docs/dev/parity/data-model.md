# Parity spec: data model (groups, connections, events, time model, lookup, annotations)

Subsystem: the in-memory model that every qvis visualization reads: `QlogConnectionGroup` (one loaded file),
`QlogConnection` (one trace, or one `group_id` slice of a trace), the `IQlogEventParser` "cursor" that turns
raw events into `{relativeTime, absoluteTime, category, name, data}`, the loaders' trace-to-connection mapping,
the lookup table, the data that renderers attach to the model, and the non-loading parts of the Vuex store.

Sources (all paths relative to `qvis/visualizations/src/` unless stated otherwise):

- `data/Connection.ts` (187 lines), `data/ConnectionGroup.ts` (61), `data/QlogEventParser.ts` (29)
- `data/QlogLoader.ts` (1027: dispatch, legacy loaders, `EventFieldsParser`, `PreSpecEventParser`)
- `data/QlogLoaderV2.ts` (549: draft-02 / "0.3" loader, `DirectEventParser`)
- `data/QlogSchema.ts`, `data/QlogSchema01.ts`, `data/QlogSchema02.ts` (1192: enums and interfaces)
- `data/QlogSchemaConverter.ts` (164: export)
- `store/ConnectionStore.ts` (non-loading parts), `store/ConfigurationStore.ts`, `store.ts`
- `types/*.d.ts` (only Vue/TSX shims and `declare module "oboe"`; nothing model-related)
- every consumer under `components/**` and `views/**` (section 4.2 and 8.4)

Companion documents (read together; this document does not repeat their field-level detail):

- `docs/dev/qlog-spec/main-schema.md`: section 22 (parsing rules P1 to P15), section 23 (raw input types),
  section 27 (old qlog vs. -14). The new loader pipeline in section 3.16 below implements P6 to P14.
- `docs/dev/qlog-spec/quic-events.md`: section 13 (old vs. new QUIC events and fields), 13.6 (per-site port
  table), 15 (names real producers still emit; informational only: qvis-react does not alias them, section 9).
- `docs/dev/qlog-spec/h3-events.md`: section 10 (old vs. new HTTP/3 events), 10.6 (per-site port table).
- `docs/dev/parity/file-loading.md`: produces the `LoadedQlog` object that this subsystem consumes (its
  section 3.14), owns the store's add/remove/download and the load notifications.
- `docs/dev/parity/app-shell.md`: owns the shared trace selector (`ConnectionConfigurator`) UI, routing, and
  notifications host.
- `docs/dev/ARCHITECTURE.md` §0 and §3.1: product decisions that **override** parts of this document (strict
  latest drafts: no alias table, no data fix-ups, `event.nonconforming-name` / DM3). Section 9 below is written
  against those overrides and is the authoritative old-to-new name and field mapping for this subsystem.

Legend used throughout:

| Tag | Meaning |
|---|---|
| **PARITY** | Reproduce exactly (observable behaviour, label text, ordering). |
| **FIX** | qvis bug or hazard; the React version deliberately behaves differently (documented). |
| **NEW** | Behaviour required by the latest drafts that qvis never had. |
| **DROP** | qvis code path that only existed for legacy qlog versions; do not port. |
| **DEAD** | qvis code that is never executed in the shipped app (imported but unused, or commented out). |

---

## 1. Overview and user-facing purpose

### 1.1 What the user sees

The user never sees "the data model" directly, but every page is a view on it:

- **File manager** lists one row per loaded file (a `QlogConnectionGroup`) with `filename` or a URL link and
  the group's shorthand, for example `My title : some description (2 connections)`.
- **Every visualization** has a trace selector whose options are built from groups and connections
  (`filename`, `title`, `description`, `vantagePoint.{name,type,flow}`).
- **Sequence diagram, congestion graph, multiplexing graph, packetization diagram, stats** all iterate a
  connection's events, look up events by (category, event type), and read `relativeTime` / `absoluteTime` /
  `data` through the event parser.
- **Stats** shows the per-file metadata (`filename`, `title`, `description`, `version`, `summary`, trace count,
  total event count) and per trace the vantage point, event count and a category/event-type histogram that is
  literally the connection's lookup table.

### 1.2 Object graph in qvis

```
Vuex store "connections" (ConnectionStore)
  grouplist: QlogConnectionGroup[]          one entry per loaded file (insertion order)
  outstandingRequests: number               in-flight loads, drives "Loading files..." alerts

QlogConnectionGroup                         one qlog FILE (name is misleading: unrelated to group_id)
  version, format, filename, title, description, URL, URLshort, summary
  connections: QlogConnection[]             one per trace, or per group_id inside a trace,
                                            plus "ERROR" placeholders for TraceErrors,
                                            plus auto-generated clones added later by the sequence diagram

QlogConnection                              one TRACE (or one group_id slice of it)
  parent, title, description, vantagePoint, commonFields, configuration, eventFieldNames, wasAutoGenerated
  events: IQlogRawEvent[]                   the RAW events from the JSON (arrays for event_fields files,
                                            objects for draft-02 "normal" JSON), sorted by time if needed
  lookupTable: Map<category, Map<eventType, rawEvent[]>>   built lazily
  eventParser: IQlogEventParser             a CURSOR: parser.load(raw) points it at one raw event and
                                            returns itself; its getters then read that event
```

Raw events are never wrapped. The parser is a single mutable cursor per connection
(`connection.parseEvent(raw)` = `eventParser.load(raw)`), so the object returned by `parseEvent()` changes
meaning on the next `parseEvent()` call (section 3.4). Renderers attach their own derived data directly onto
raw event objects and onto connection objects (section 3.13).

### 1.3 What changes in qvis-react

qvis-react only loads the latest drafts (main-schema-14, quic-events-13, h3-events-13). Consequences for the
model:

- No `qlog_version` dispatch, no `event_fields` arrays, no `configuration.time_units` / `time_offset`, no
  per-category events (`transport:*`, `recovery:*`, `http:*`): event names are `namespace:event_type`
  (`quic:packet_sent`, `http3:frame_created`, `loglevel:error`, `simulation:marker`).
- Timestamps follow `time_format` (`relative_to_epoch` | `relative_to_previous_event`) and an object
  `reference_time` (`clock_type`, `epoch`, `wall_clock_time`), both settable per event or in `common_fields`.
- The model should expose **normalized event objects** (`QlogEvent`: namespace, type, data, relativeTime,
  absoluteTime, ...) instead of a cursor parser. This removes the cursor hazard while keeping the same
  information the views consume.
- `alert()` calls in the loader become non-modal diagnostics plus at most two warning toasts (section 6.3).
- The views keep the same algorithms; only the lookup keys (`namespace`, `type`) and a few data member names
  change (section 4; the complete old-to-new mapping is section 9).

---

## 2. UI inventory

The data model renders nothing itself, but it is the single source of many user-visible strings. Every string
below must be reproduced exactly (**PARITY**) unless tagged otherwise.

### 2.1 Labels computed from model fields

| Where shown | Formula (verbatim logic) | Source |
|---|---|---|
| File list, second line (small text, 0.8em) | `group.getShorthand()`, see 3.2.3 | `ConnectionGroup.ts:37-60`, `FileManagerContainer.vue:155` |
| File list, first line | `group.URL` non-empty: link `<a href=URL>{URLshort}</a>`; else `group.filename` | `FileManagerContainer.vue:148-153` |
| Multiplexing graph, per-trace `<h4>` | `connection.parent.filename + " : " + connection.getLongName()`, see 3.3.4 | `MultiplexingGraphCollapsedRenderer.vue:5` |
| Trace selector, group option (separate-select mode) | `group.filename + " (" + (group.title ? group.title + " : " : "") + group.description + ")"` | `ConnectionConfigurator.vue:125` |
| Trace selector, connection option (separate-select mode) | identical to `getLongName()` but computed inline | `ConnectionConfigurator.vue:136-157` |
| Trace selector, combined mode | group header `{value: null, text: group.filename, disabled: !allowGroupSelection}`, then per connection `"↳ " + <getLongName() formula>` | `ConnectionConfigurator.vue:167-193` |
| Trace selector, combined mode header row | `selectedConnection.parent.filename + " (" + selectedConnection.parent.description + ")"` | `ConnectionConfigurator.vue:23` |
| Trace selector mode switch | more than 30 combined options switches to two selects | `ConnectionConfigurator.vue:114-118` |
| Sequence diagram column header line 1 (y=20) | not generated and `parent.URL` truthy: SVG link to `parent.URL` (target `_blank`, underlined) with text `parent.URLshort`; else text `(wasAutoGenerated ? "GENERATED: " : "") + parent.filename` | `SequenceDiagramD3Renderer.ts:262-291` |
| Sequence diagram column header line 2 (y=40) | `vantagePoint.type`, or for `network`: `"network : from " + vantagePoint.flow + "'s viewpoint"` | `SequenceDiagramD3Renderer.ts:298-309` |
| Stats "File info" table | rows `Filename` (if `filename !== ''`), `Title` (if `title !== ''`), `Description` (if `description !== ''`), `qlog version` = `group.version` (always), `Summary` = `JSON.stringify(group.summary, null, 4)` (if it has keys), `Trace count` = non-generated connections, `Total event count` = sum of `getEvents().length` over non-generated connections | `StatisticsRenderer.vue:16-43,82-96` |
| Stats "Trace N info" | `Title` row condition is `connection.title && connection.title > 0` (bug: never true for normal strings, section 7), `Description` (if non-empty), `Vantage point`: `name` + `<br/>` if `name !== ''`, then `type` or `"network : with " + flow + " perspective"`; `Event count` = `getEvents().length` | `StatisticsConnectionRenderer.vue:3-31` |
| Stats "Events" histogram | rows from `connection.getLookupTable()`: `Category` (rowspan = number of types), `Event type`, `Event count`, progress bar `value = count`, `max = getEvents().length`, `precision 2`, `show-progress`. Order = first-seen order (Map insertion) | `StatisticsConnectionRenderer.vue:40-60` |
| Stats flow-control headings | `Local (` + `vantagePoint.type` + `)`, `Remote (` + (`type === "client"` ? `"server"` : `"client"`) + `)`, same for `Local Streams (...)`, `Remote Streams (...)` | `StatisticsConnectionRenderer.vue:156,170,202,225` |

### 2.2 Strings the loader writes into the model (PARITY unless tagged)

| String | When | Source |
|---|---|---|
| `"ERROR"` (connection title) and `uri + " : " + error_description` (description) | a `traces[]` entry has `error_description !== undefined` | `QlogLoaderV2.ts:49-56` |
| `"Group " + groupID + " : "` (title prefix, then the trace title is appended) | `group_id` splitting | `QlogLoaderV2.ts:108`, `:135` |
| `vantagePoint = {type: "unknown", flow: "unknown", name: "No VantagePoint set"}` | trace has no `vantage_point`, or it has no `type` | `QlogLoaderV2.ts:138-144` |
| connection `title` = trace `title` or `""`; `description` = trace `description` or `""` | always | `QlogLoaderV2.ts:135-136` |
| group `title` = file `title` or `""`; `description` = `description` or `""`; `format` = `"" + qlog_format` or `"JSON"`; `version` = `qlog_version` | always | `QlogLoaderV2.ts:39-43` |

FIX in qvis-react: when `uri` is absent (it is optional in -14) the description is just `error_description`
instead of `"undefined : ..."`.

### 2.3 Strings renderers write into the model (they show up in selectors afterwards)

| String | Written by | Effect |
|---|---|---|
| `"Simulated, autogenerated trace : " + title` / `+ description` | sequence diagram, when only one trace is selected (`SequenceDiagramD3Renderer.ts:466-468`) | The clone is **added to the parent group** (constructor side effect, section 3.3.5) and therefore appears in every trace selector and in `getShorthand()`'s connection count. |
| clone `vantagePoint.name = "GENERATED"`, `wasAutoGenerated = true` | same, `:469-470` | Selector label starts with `GENERATED : client : Simulated, autogenerated trace : ...` |
| original `vantagePoint.name = "vantage point type was unknown, pretending it's " + guess` and clone `vantagePoint.name = "vantage point type was unknown, pretending it's " + clone.type` | same, when the trace's vantage point type is neither client nor server nor has such a flow (`:528-531`) | The ORIGINAL connection's label changes permanently (shared object, see 7.Q8). |
| `"Cloned trace : "` prefixes | `SequenceDiagramCanvasRenderer.ts:40-41` | **DEAD** (canvas renderer never instantiated). |

### 2.4 Blocking dialogs and console output from the loader (qvis, verbatim)

`alert()` texts (blocking; **FIX**: replaced by toasts in qvis-react, section 6.3):

```
Loaded trace was not absolutely ordered on event timestamps. We performed a sort() in qvis, but this slows things down and isn't guaranteed to be stable if the timestamps aren't unique! The qlog spec requires absolutely ordered timestamps. See the console for more details.
```

```
 ERROR: non-compliant qlog draft-02 trace! \n\n<message 1>\n\n<message 2>...\n\nqvis has attempted to auto-fix these things, so thing should mostly still work.
```

(leading space and the typo "so thing should" are in the original; `QlogLoaderV2.ts:257`). The per-trace
messages are listed in section 6.1.

### 2.5 Interactions owned elsewhere but driven by model semantics

- Default selection in every view: `store.groups[0].getConnections()[0]` (stats: `store.groups[0]`), applied on
  `mounted()` and `updated()` when the view's config is empty and at least one group exists
  (`SequenceDiagramConfigurator.vue:241-256`, `CongestionGraphConfigurator.vue:116-137`,
  `MultiplexingGraphConfigurator.vue:109-124`, `PacketizationDiagramConfigurator.vue:160-175`,
  `StatisticsConfigurator.vue:57-72`). This can pick an `ERROR` placeholder or a generated clone.
- Empty-state alerts in every configurator: `outstandingRequestCount === 0 && groups.length === 0` gives the
  danger alert `Please load a trace file to visualize it`; else `groups.length === 0` gives the warning alert
  `Loading files...` (verbatim, e.g. `SequenceDiagramConfigurator.vue:46-47`).
- Sequence diagram configurator alert `The selected trace has an unknown vantage point. We guessed it based on
  heuristics, but this could be wrong!` when `connections[0]` (or `[1]` if `[0]` is generated) has events and
  `vantagePoint.type === "unknown"` (`SequenceDiagramConfigurator.vue:44`, `:73-87`).
- "Trace might take long to render" warn toast when the first selected connection has more than 10000 events
  (`SequenceDiagramRenderer.vue:165-175`, `PacketizationDiagramRenderer.vue:68-78`). Text: title
  `Trace might take long to render`, text `Some large traces can take a long time to render. Please be patient.`

---

## 3. Algorithms and data flow

### 3.1 Lifecycle

1. A loader (file-loading spec) produces a parsed JSON object.
2. `ConnectionStore.addGroupFromQlogFile({fileContentsJSON, fileInfo})` (`ConnectionStore.ts:69-90`) calls
   `QlogLoader.fromJSON(json)`. On `undefined` it shows the "ERROR parsing qlog file" toast (owned by
   file-loading). Otherwise it sets `group.filename = fileInfo.filename`, `group.URL = fileInfo.URL`,
   `group.URLshort = fileInfo.URLshort` (the last two become `undefined` when absent, overwriting the `""`
   defaults) and commits `addGroup` (push).
3. The loader **mutates the input JSON in place** and keeps references to it: connection `events` is the very
   array from the JSON (minus a trailing empty element), `vantagePoint` is the trace's `vantage_point` object,
   `commonFields` is `common_fields`. Draft-02 auto-fixes rewrite `data` objects in place.
4. Views select connections (configs in `ConfigurationStore`, which survive route changes) and read the model.
   Renderers mutate it (annotations, clones, renames, frame-size backfill: section 3.13).
5. `removeGroup(group)` splices it from `grouplist`. Nothing else is cleaned (selections in view configs keep
   pointing at the removed group's connections: 7.Q17).

Vue reactivity: the group list and the connection/group objects are deep-reactive Vuex state, but
`events`, `lookupTable` and the event parser are tagged `_isVue = true` to stop Vue from observing them
(`Connection.ts:43`, `:48`, `:92`, `:108`; `clone()` `:65`). Rationale in `Connection.ts:74-90`: observing
millions of events was too slow, and observing the parser's `currentEvent` caused infinite render loops when a
template called `connection.parseEvent(evt).name`.

### 3.2 `QlogConnectionGroup` (`data/ConnectionGroup.ts`)

"Basically the wrapper for a single qlog file, which contains multiple traces" (`:3-5`). Unrelated to
`group_id` despite the name.

#### 3.2.1 Fields

| Field | Type | Default (ctor `:22-32`) | Set by | Read by |
|---|---|---|---|---|
| `version` | string | `""` | loader: `qlog_version` | Stats `qlog version` row; export (`QlogSchemaConverter.ts:47`) |
| `format` | string | `"JSON"` | V2 loader: `qlog_format ? "" + qlog_format : "JSON"` | nobody |
| `filename` | string | `""` | store (`fileInfo.filename`) | selectors, Stats, file list, seq diagram header, multiplexing `<h4>`, multiplexing "select all" sort, packetization "select all" `DEMO` filter, demo-loaded checks (`indexOf("DEMO") === 0`, `"MASSIVE_DEMO_mvfst_large"`), console messages |
| `title` | string | `""` | loader: file `title` | selectors, Stats, `getShorthand()`, export |
| `description` | string | `""` | loader: file `description` | selectors, Stats, `getShorthand()`, export, seq-diagram debug renderer (DEAD) |
| `URL` | string | `""` (then `fileInfo.URL`, possibly `undefined`) | store | file list link, sequence-diagram header link and "Direct link to this event" builder, download filename |
| `URLshort` | string | `""` (same) | store | file list link text, sequence-diagram header text |
| `summary` | any | `{}` | **nobody** (the V2 loader does not copy `summary`) | Stats `Summary` row (therefore never shown), export |
| `connections` (private) | `QlogConnection[]` | `[]` | `addConnection()` (called from the `QlogConnection` constructor) | `getConnections()` |

#### 3.2.2 Methods

- `addConnection(connection)`: `connections.push(connection)` (`:34`). Called **only** by the
  `QlogConnection` constructor (`Connection.ts:45`), so constructing a connection registers it.
- `getConnections()`: returns the internal array itself (`:35`). Callers never mutate it directly.
- `getShorthand()`:

```ts
// ConnectionGroup.ts:37-60 (verbatim logic)
let output = "";
if (this.title) output += this.title;
if (this.description) {
    if (this.description.length <= 50) output += " : " + this.description;
    else output += " : " + this.description.substr(0, 50) + "...";
}
if (this.connections.length !== 1) output += " (" + this.connections.length + " connections)";
else output += " (1 connection)";
return output;
```

Note: the count includes `ERROR` placeholders and auto-generated clones (7.Q11). An untitled file without a
description renders as `" (1 connection)"` with a leading space.

### 3.3 `QlogConnection` (`data/Connection.ts`)

#### 3.3.1 Fields

| Field | Type | Default (ctor `:32-49` and initializers `:14-16`) | Set by loader (V2 `:133-155`) | Notes |
|---|---|---|---|---|
| `parent` | `QlogConnectionGroup` | ctor arg | | constructor calls `parent.addConnection(this)` |
| `title` | string | `""` | `+= trace.title ?? ""` (after optional `"Group X : "` prefix) | |
| `description` | string | `""` | `+= trace.description ?? ""` | |
| `eventFieldNames` | string[] | `[]` | only for `event_fields` traces | drives `EventFieldsParser` and export conversion |
| `commonFields` | object | `{}` | `trace.common_fields!` (can become `undefined`) | consumers always guard `commonFields && ...` |
| `configuration` | object | `{time_offset: "0", time_units: "ms", original_uris: []}` | `trace.configuration \|\| {}` | read by parsers (`time_units`, `time_offset`) and export |
| `vantagePoint` | `{name?, type, flow?}` | `{type: "unknown", flow: "unknown"}` | `trace.vantage_point \|\| {}` then defaults (2.2) | shared object reference with the JSON and with all `group_id` slices of the same trace |
| `wasAutoGenerated` | boolean | `false` | | set `true` only on sequence-diagram clones |
| `events` (private) | `IQlogRawEvent[]` (typed `any[][]` but objects for draft-02) | `[]` tagged `_isVue` | `setEvents(trace.events)` or `push` per group slice | |
| `lookupTable` (private) | `Map<string, Map<string, IQlogRawEvent[]>>` | empty Map tagged `_isVue` | built lazily | |
| `eventParser` (private) | `IQlogEventParser` | unset | `setEventParser(new DirectEventParser())` etc. | `ERROR` placeholders never get one |

#### 3.3.2 Methods

| Method | Behaviour | Lines |
|---|---|---|
| `constructor(parent)` | sets defaults, `parent.addConnection(this)` | `:32-49` |
| `clone()` | deep clone, see 3.3.5 | `:53-71` |
| `setEventParser(parser)` | `parser._isVue = true; this.eventParser = parser; parser.init(this)` | `:73-95` |
| `getEventParser()` | returns the parser. Comment: use directly when `parseEvent()` is "too slow due to Vue's ReactiveGetter" | `:99-101` |
| `parseEvent(evt)` | `return this.eventParser.load(evt)`: points the shared cursor at `evt`, returns the cursor | `:103-105` |
| `setEvents(events)` | tags `_isVue`, replaces the array | `:107-110` |
| `getEvents()` | returns the internal array (mutable; loaders push into it, the sequence diagram reads indices) | `:111` |
| `getVantagePointPerspective()` | see 3.3.3 | `:113-124` |
| `setupLookupTable()` | builds the table once, see 3.12 | `:126-146` |
| `getLookupTable()` | `setupLookupTable(); return lookupTable` | `:148-152` |
| `lookup(category, eventType)` | returns the array from the table or `[]`. **Does not build the table**: callers must call `setupLookupTable()` first | `:154-161` |
| `getLongName()` | see 3.3.4 | `:163-186` |

#### 3.3.3 `getVantagePointPerspective()`

```ts
if (vp.type === "server" || vp.type === "client") return vp.type;
// "network" or "unknown": look at flow (also robust for "unknown", which should not have a flow)
return vp.flow ? vp.flow : "unknown";
```

Used by the sequence diagram configurator only (`SequenceDiagramConfigurator.vue:109-110,133,136`).

#### 3.3.4 `getLongName()` (and the identical inline copy in `ConnectionConfigurator.vue:136-155`)

```ts
let s = "";
if (this.vantagePoint) {                              // always truthy in practice
    if (this.vantagePoint.name) s += this.vantagePoint.name + " : ";
    s += this.vantagePoint.type ? this.vantagePoint.type : "UNKNOWN";
    s += (this.vantagePoint && this.vantagePoint.flow) ? " (flow = " + this.vantagePoint.flow + ") : " : " : ";
}
if (this.title) s += this.title;
if (this.description) s += " : " + this.description;
return s;
```

Examples (PARITY):

| vantage point | title | description | result |
|---|---|---|---|
| `{type: "client"}` | `"conn"` | `""` | `client : conn` |
| `{name: "aioquic client", type: "client"}` | `""` | `"d"` | `aioquic client : client :  : d` (two spaces) |
| loader default for missing VP | `""` | `""` | `No VantagePoint set : unknown (flow = unknown) : ` |
| `{type: "network", flow: "client"}` | `"t"` | `""` | `network (flow = client) : t` |
| ERROR placeholder (ctor default VP, no name) | `ERROR` | `uri : desc` | `unknown (flow = unknown) : ERROR : uri : desc` |

#### 3.3.5 `clone()` (deep copy, used by the sequence diagram only)

```ts
// Connection.ts:53-71
const output = new QlogConnection(this.parent);          // SIDE EFFECT: appended to parent.connections
output.title = this.title;
output.description = this.description;
output.eventFieldNames = this.eventFieldNames.slice();
output.commonFields  = JSON.parse(JSON.stringify(this.commonFields || []));   // undefined becomes [] (7.Q13)
output.configuration = JSON.parse(JSON.stringify(this.configuration || {}));
output.vantagePoint  = JSON.parse(JSON.stringify(this.vantagePoint || {}));
const events = JSON.parse(JSON.stringify(this.events || []));                  // drops non-enumerable `qvis`
events._isVue = true;
output.events = events;
output.eventParser = this.eventParser;                   // SHARED parser instance, not re-initialised
return output;
```

Consequences: the clone has its own (empty) lookup table, built later from its own (renamed) events; it shares
the parser, so the parser's time base (`addTime`, `subtractTime`) is shared; enumerable properties renderers
put on object events (for example `timeText`, 3.13) are copied into the clone.

### 3.4 `IQlogEventParser` contract (`data/QlogEventParser.ts`)

```ts
export enum TimeTrackingMethod { ABSOLUTE_TIME, RELATIVE_TIME, DELTA_TIME }   // numeric 0, 1, 2

export interface IQlogEventParser {
    readonly relativeTime: number;   // ms, "trace-local" time
    readonly absoluteTime: number;   // ms, comparable across traces
    readonly category: string;
             name: string;           // settable: used to rename events of cloned traces
    readonly data: any | undefined;
    readonly timeOffset: number;     // ms, from configuration.time_offset
    timeToMilliseconds(time: string | number): number;   // converts a value in the trace's time unit to ms
    getAbsoluteStartTime(): number;
    init(connection: QlogConnection): void;
    load(evt: IQlogRawEvent): IQlogEventParser;          // sets the cursor, returns `this`
    getTimeTrackingMethod(): TimeTrackingMethod;
    setReferenceTime(time: number): void;                // ms; "should not be needed normally"
}
export type IQlogRawEvent = Array<any>;                  // objects for draft-02 traces, despite the type
```

**Cursor hazard (PARITY of results, FIX of mechanism).** `load()` stores the raw event in the parser and returns
the same parser object. `const a = c.parseEvent(x); const b = c.parseEvent(y);` leaves `a === b`, both reading
`y`. Every consumer therefore copies values out immediately (comments at
`CongestionGraphD3Renderer.ts:1581`, `SequenceDiagramD3Renderer.ts:115`). Sorting works because the comparator
reads `.absoluteTime` right after each `parseEvent` call (`QlogLoaderV2.ts:174`). The new model (3.16) uses
per-event objects so the hazard disappears; see 7.Q1 for a place where qvis got it wrong (the sequence diagram's
vantage-point guess always answers "server").

### 3.5 `DirectEventParser` (draft-02, "0.3": object events; `QlogLoaderV2.ts:267-549`)

State: `timeTrackingMethod = ABSOLUTE_TIME`, `addTime = 0`, `subtractTime = 0`, `timeMultiplier = 1`,
`_timeOffset = 0`, `categoryCommon = "unknown"`, `nameCommon = "unknown"`, `currentEvent`.

`init(trace)` (`:391-507`), in this order:

1. `currentEvent = undefined`.
2. If `trace.commonFields`:
   - `categoryCommon = commonFields.category` if truthy; `nameCommon = commonFields.name` if truthy (not
     lower-cased).
   - `time_format`: `"relative"` gives RELATIVE, `"delta"` gives DELTA, any other truthy value gives ABSOLUTE.
   - No `time_format`: `reference_time !== undefined` gives RELATIVE plus `console.warn` (6.1); otherwise
     ABSOLUTE.
   - If `commonFields` is falsy the method stays ABSOLUTE.
3. `timeMultiplier = 0.001` if `configuration.time_units === "us"`.
4. ABSOLUTE: `addTime = 0`, `subtractTime = parseFloat(events[0].time)` (crashes on zero events; the loader
   already crashed earlier, 7.Q5).
5. RELATIVE: `addTime = parseReferenceTime(commonFields.reference_time, multiplier)`, `subtractTime = 0`; if
   there is no `reference_time`: `console.error` and both 0.
6. DELTA: switches the method to ABSOLUTE, then rewrites the event times **in place** into absolute values:
   - with `reference_time`: `subtractTime = parseReferenceTime(ref)`, `events[0].time = parseFloat(events[0].time)
     + subtractTime`;
   - without: `subtractTime = parseFloat(events[0].time)`;
   - then for `i >= 1`: `events[i].time = parseFloat(events[i].time) + previousTime`, `previousTime =
     events[i].time` (starting from `previousTime = subtractTime`).

   Note: with a `reference_time` the loop starts from `subtractTime`, not from the rewritten `events[0].time`,
   so event 1 is relative to the reference instead of to event 0 (7.Q6).
7. `_timeOffset = parseFloat(configuration.time_offset) * multiplier` if `time_offset` is truthy.
8. `addTime *= multiplier; subtractTime *= multiplier`.

Getters (`m` = multiplier, `t` = `parseFloat(evt.time)`, all in ms):

| Getter | Formula | If `evt.time === undefined` |
|---|---|---|
| `relativeTime` | `t*m - subtractTime + _timeOffset` | `0` |
| `absoluteTime` | `t*m + addTime + _timeOffset` | `0` |
| `getAbsoluteStartTime()` | RELATIVE: `addTime`; ABSOLUTE: `subtractTime`; else `console.error(...)` and `0` | |
| `timeOffset` | `_timeOffset` | |
| `timeToMilliseconds(x)` | `parseFloat(x) * m` | |
| `getTimeTrackingMethod()` | `timeTrackingMethod` (never DELTA after init) | |
| `setReferenceTime(ms)` | `addTime = ms` (no multiplier; must already be ms) | |
| `category` | `evt.category` if truthy; else `evt.name.split(":")[0]` if `evt.name`; else `categoryCommon` | |
| `name` (get) | `evt.name === undefined`: `nameCommon`; else `split(":")`: `split[1]` if length > 1 else `split[0]` | |
| `name` (set) | if `evt.name` defined: `evt.name = evt.name.replace(currentName, val)` (first occurrence) | |
| `data` | `evt.data` (or `undefined`) | |

So for the usual draft-02 cases:

| Trace | relativeTime | absoluteTime | absolute start |
|---|---|---|---|
| ABSOLUTE (`time` = Unix ms) | `t - t0` (t0 = first event in array order at init) | `t` | `t0` |
| RELATIVE with ref R | `t` | `R + t` | `R` |
| RELATIVE without ref | `t` | `t` | `0` |
| DELTA (converted) | cumulative minus first | cumulative | first (or R) |

`parseReferenceTime(refTimeIn, multiplier)` (`:522-548`): if `refTimeIn` is a string containing `":"` or `"-"`,
`console.warn(...)` and return `Date.parse(ref)` (or `Date.parse(ref) * 1000` when the multiplier is not 1);
otherwise `parseFloat(ref)`, with `NaN` mapped to `0` (comment: "Newer draft versions define reference_time as a
struct. This code makes no attempt to parse the struct, but simply prevents us from stumbling over it.").

### 3.6 `EventFieldsParser` (event_fields arrays; `QlogLoader.ts:714-967`; DROP)

Used for draft-00, draft-01, draft-02-wip and draft-02 traces that still carry `event_fields`. Kept here only so
the porting team understands old behaviour and old demo files.

- Column indices from lower-cased `eventFieldNames`: `category`, `event_type` (else `event`), `data`, and time:
  `time` (ABSOLUTE), else `relative_time` (RELATIVE), else `delta_time` (DELTA converted to ABSOLUTE in place,
  with string concatenation bug for string times: `allEvents[0][timeIndex] += subtractTime`, 7.Q6), else
  `console.error` and all times 0.
- `category` / `name` getters **lower-case** the value; with a missing column they return
  `common_fields.category || CATEGORY` / `common_fields.event || EVENT_TYPE` (lower-cased) or `"unknown"`.
- `data` returns a **new `{}`** if there is no data column.
- Time math identical to 3.5 (same `addTime` / `subtractTime` / `timeMultiplier` / `time_offset` scheme;
  `parseReferenceTime` without the `NaN` guard).

### 3.7 `PreSpecEventParser` (qlog_version `"0.1"`; `QlogLoader.ts:970-1027`; DROP)

`relativeTime = absoluteTime = parseFloat(evt[0])`, `category = evt[1]`, `name = evt[2]`, `trigger = evt[3]`,
`data = evt[4]`, start time 0, `timeOffset = 0`, RELATIVE, `timeToMilliseconds = parseFloat`, `setReferenceTime`
no-op. Also used by `DEBUG_LoadRandomFile` (`ConnectionStore.ts:92-114`).

### 3.8 Loader dispatch (`QlogLoader.fromJSON`, `QlogLoader.ts:14-45`)

| `qlog_version` | Loader |
|---|---|
| `"0.1"` | `fromPreSpec` (DROP) |
| `"draft-00"` | `fromDraft00` (DROP) |
| `"draft-01"` | `fromDraft01` (DROP) |
| `"draft-02-wip"` | `fromDraft02` (legacy class, DROP) |
| `"draft-02"`, `"draft-02-RC1"`, `"qlog-03-WIP"`, `"0.3"` (`QlogSchema02.ts:13`) | `QlogLoaderV2.fromJSON` |
| anything else | `console.error("QlogLoader: Unknown qlog version! Only draft-00, draft-01, draft-02-wip, draft-02 and 0.3 are supported!", version, json)`, return `undefined` |
| missing / falsy json | `console.error("QlogLoader: qlog files MUST have a qlog_version field in their top-level object!", json)`, return `undefined` |

Every latest-draft file (no `qlog_version`, has `file_schema`) is rejected by qvis with the "ERROR parsing qlog
file" toast. qvis also rejects `"0.4"`.

### 3.9 `QlogLoaderV2.fromDraft02(json)` step by step (`QlogLoaderV2.ts:33-263`)

1. `console.log("QlogLoaderV2:fromDraft02 : ", fileContents, fileContents.traces)`.
2. `group = new QlogConnectionGroup()`; `version`, `format`, `title`, `description` per 2.2.
3. For each `jsonconnection` of `traces` (file order):
   1. **TraceError** (`error_description !== undefined`): `new QlogConnection(group)` (registered),
      `title = "ERROR"`, `description = uri + " : " + error_description`; `continue` (no parser, no events, ctor
      default vantage point `{type: "unknown", flow: "unknown"}` without name).
   2. `usesEventFields = event_fields !== undefined && event_fields.length > 0`.
   3. **Split decision**: event_fields: `groupIDKey = event_fields.indexOf("group_id")`, split if `>= 0`. Object
      events: split if `events.length > 0 && events[0]["group_id"] !== undefined` (first event only).
      `common_fields.group_id` is never considered.
   4. **Split**: for each event: skip if `event.length === 0 || Object.keys(event).length === 0`;
      `groupID = event[groupIDKey]`, `JSON.stringify` if not a string (so `undefined` stays `undefined` and
      becomes a Map key; title `"Group undefined : "`); first occurrence creates a connection titled
      `"Group " + groupID + " : "`; push the event. Connection order = first-seen order.
   5. **No split**: one connection; `setEvents(trace.events)` (the JSON array itself); if the **last** element
      is empty (`length === 0` or no keys) remove it (`splice`). Crashes with `TypeError` when `events` is empty or
      missing (7.Q5).
   6. For each connection created from this trace (title/description append, vantage point default, see 2.2):
      `commonFields = trace.common_fields!`; `configuration = trace.configuration || {}`; parser =
      `EventFieldsParser` (with `eventFieldNames = event_fields`) or `DirectEventParser`.
   7. **Ordering check** (`:157-186`): `minimumTime = -1`; for each event in array order, if
      `absoluteTime >= minimumTime` update the minimum, else `misOrdered = true`, `console.error(... "timestamps
      were not in the correct order!", ...)` and stop. If misordered: `events.sort((a, b) =>
      parse(a).absoluteTime - parse(b).absoluteTime)` (in place, on the JSON array), `console.error(...)`, create
      a **new** parser of the same kind (the ABSOLUTE start time may have changed), `alert(...)` (2.4).
   8. **Draft-02 compliance pass** (`:188-258`, per event, mutating `data` in place):
      - `data.header.packet_size` truthy: message once, then `data.raw.length = packet_size`, delete it.
      - `data.header.payload_length` truthy: message once, `data.raw.payload_length = ...`, delete it.
      - `data.packet_type` truthy: message once, `data.header.packet_type = data.packet_type`, delete it.
      - `usesEventFields`: deprecation message.
      - `qlog_format` missing or empty: message (per connection).
      - Any message: `console.error("QlogLoaderV2:fromDraft02: ERROR: non-compliant qlog draft-02 trace:")`, each
        message via `console.error`, then the `alert` (2.4). One alert **per connection**.
4. Return the group.

### 3.10 Legacy loaders (DROP; summary only)

`fromDraft01` / `fromDraft02` (wip) / `fromDraft00` / `fromPreSpec` (`QlogLoader.ts:47-709`) share the split and
ordering logic above (event_fields only) and add upgrades: `data.type` / `data.packet_type` case fixes,
`fix02Compatibility` (packet_type into header, packet_size and payload_length into raw), "semi-01" heuristics,
and `fixPreviousInto01` event renames (`connection_new` to `connection_started`, `metric_update` to
`metrics_updated`, `datagram_sent` to `datagrams_sent`, `cipher_update`/`version_update`/`alpn_update`/
`transport_parameters_update` to `parameters_set`, `onertt` to `"1RTT"`, `frame.id` to `stream_id`/`push_id`,
`frame.fields` to `headers`, ...). draft-00 upper-case vantage types are mapped; `NETWORK` gets `flow: client`.
None of this is needed for latest-draft input. The four demo files under `public/standalone_data/draft-00|01`
must be converted offline to -14 (file-loading 8.7).

### 3.11 Ordering and sorting summary

- Check on `absoluteTime` in array order, starting from `-1` (so a first event with `absoluteTime < -1` is
  reported as misordered even when ordered: 7.Q7).
- Sort is in place, by `absoluteTime`, using `Array.prototype.sort` (stable in all current engines, despite the
  alert text), then the parser is re-created. For DELTA traces the re-init converts the already-converted times
  again (7.Q6).
- Group slices are checked and sorted independently.
- After loading nothing re-sorts; lookup arrays inherit the array order.

### 3.12 Lookup table (`Connection.ts:126-161`)

```ts
setupLookupTable() {
    if (this.lookupTable.size !== 0) return;                 // built once; never invalidated
    for (const evt of this.events) {                         // array order (post-sort)
        const category  = this.parseEvent(evt).category;
        const eventType = this.parseEvent(evt).name;
        // Map<category, Map<eventType, rawEvent[]>>, insertion order = first occurrence
        ...push(evt);
    }
}
lookup(category, eventType) { return table.get(category)?.get(eventType) ?? []; }   // does NOT build
```

- Keys are whatever the parser returns: lower-cased for `event_fields` traces, verbatim for draft-02 object
  events (`"transport"`, `"recovery"`, `"http"`).
- The arrays hold the same raw event objects as `getEvents()`, so annotations written through one path are visible
  through the other (the sequence diagram depends on that, 3.13).
- A connection with zero events "rebuilds" (no-op) on every call.
- Builders: `setupLookupTable()` is called by the sequence diagram (`SequenceDiagramD3Renderer.ts:216`, `:493`),
  congestion graph (`:1079`), multiplexing renderers (`MultiplexingGraphD3WaterfallRenderer.ts:58`,
  `MultiplexingGraphD3CollapsedRenderer.ts:94`, `MultiplexingGraphD3SimulationRenderer.ts:49`), packetization
  (`PacketizationDiagramD3Renderer.ts:60`), and Stats (`StatisticsConnectionRenderer.vue:318`, and via
  `getLookupTable()` in the template `:47`).

### 3.13 Data that renderers attach to (or change in) the model

qvis treats the model as a scratchpad. qvis-react must keep the same information but store it in side
structures (3.16.9) so the raw data stays clean and exportable.

| Writer | Target | What | Persistence | Lines |
|---|---|---|---|---|
| Sequence diagram | raw event | non-enumerable `qvis.sequencediagram` (via `Object.defineProperty(obj, "qvis", {enumerable: false, value: {}})`): `y` (pixel row), `rightTarget` / `leftTarget` (raw event on the neighbouring trace that this `packet_sent` arrives at), `packetLost` (`"rightTarget"` or `"leftTarget"` direction of a presumed loss), `focusInfo` (`{connectionIndex, eventIndex}` set when clicked) | across renders; `rightTarget`/`leftTarget` are reset per render (`:1047-1048`) but `packetLost` never is (mostly harmless: the renderer checks the two targets before `packetLost`; events skipped for a missing `header`/`packet_number` keep all old values) | `SequenceDiagramD3Renderer.ts:571-579`, `:968`, `:1047-1081`, `:109` |
| Sequence diagram | raw event | **enumerable** `timeText` = `time.toFixed(2)` | forever; leaks into JSON detail modal and export for object events (7.Q12) | `:852` |
| Sequence diagram | connection | non-enumerable `qvis.sequencediagram.generatedSibling` (original and clone point at each other), `manualTimeOffset` (ms, the computed or user-entered latency offset of the right-hand trace) | forever | `:454-462`, `:557-560`, `:605-621`, `:782-783` |
| Sequence diagram | cloned connection | event renames through `parseEvent(evt).name = ...`: `packet_sent` and `packet_received` swapped, every other event renamed to `"ignoreseq"` (so `"transport:packet_sent"` becomes `"transport:ignoreseq"`) | forever (clone only) | `:542-555` |
| Sequence diagram | parser | `setReferenceTime(otherStart ± 5)` when one trace is RELATIVE with start 0 | forever (shared with clone) | `:628-639` |
| Sequence diagram | `vantagePoint.name` | 2.3 | forever | `:469`, `:528-531` |
| Congestion graph | raw event | non-enumerable `qvis.congestion = {from, to, correspondingPackets: [], correspondingAck?, correspondingLoss?}`: byte range of each sent/received packet (cumulative `raw.length`, 1-based inclusive), first ACKing packet, loss event, and back-pointers | forever; `correspondingPackets` of loss events grows by one entry per render (7.Q14) | `CongestionGraphD3Renderer.ts:1117-1394`, `:1875-1885` |
| Packetization (QUIC) | raw `data` | `data.raw.length = data.raw.data.length` if missing (hex string length, i.e. 2x bytes: 7.Q15); per frame `frame_size`, `header_size`, `payload_size`; **inserts** a filler frame `{header_size: offset, payload_size: 0, frame_type: "qvis-injected FILLER (deal with incorrectly guesstimated frame size)", qvis: {sequence: {hide: true}}}` at the front of `data.frames` when sizes don't add up | forever; filler can be inserted again on each render | `PacketizationQUICPreProcessor.ts:226-325`, `:611-690` |
| Sequence diagram (reader) | frames | skips frames with `qvis.sequence.hide` (the packetization filler) | | `SequenceDiagramD3Renderer.ts:1637` |
| VUEDebug page | raw event, title | `getEvents()[0][2] = "Event was changed"`, `connections[0].title = ...`, `events.splice(...)` | debug only | `views/VUEDebug.vue:73-87` |

### 3.14 Export (`QlogSchemaConverter.Convert01to02`, `QlogSchemaConverter.ts:7-120`)

Reads `group.title`, `description`, `summary`, `version`; per connection (skipping `wasAutoGenerated`):
`vantagePoint` (possibly renamed by the sequence diagram), `title`, `description`, `configuration`,
`commonFields` (or `{}`), and `getEvents()` as-is for draft-02-family groups (so sorted order, `group_id` slices
as separate traces, ERROR placeholders as empty traces, enumerable renderer extras like `timeText` and
packetization filler frames included). The qvis-react export format is specified in file-loading 3.11; the model
must supply what it needs (3.16.12, `QlogConnection.rawTrace`, `QlogEvent.raw`).

### 3.15 Store (non-loading parts) and per-view configuration

`ConnectionStore` (`store/ConnectionStore.ts`):

| Member | Kind | Behaviour |
|---|---|---|
| `grouplist` | state | `QlogConnectionGroup[]`, insertion order |
| `outstandingRequests` | state | number of in-flight loads |
| `groups` | getter | returns `grouplist` |
| `outstandingRequestCount` | getter | returns `outstandingRequests` |
| `adjustOutstandingRequestCount(amount)` | mutation | `+= amount` |
| `addGroup(group)` | mutation | `console.log("ConnectionStore Mutation for adding group", group)`; push |
| `deleteGroup(group)` | mutation | splice by `indexOf`, no-op if absent |
| `removeGroup(group)` | action | commits `deleteGroup` |
| `addGroupFromQlogFile` | action | 3.1 step 2 |
| `DEBUG_LoadRandomFile(filename)` | action | builds a group with `description = filename`, 1..6 connections titled `"Connection " + i`, 1..3 events `[j, "testcat", "Connection #i - Event #j", "dummytrigger", {dummy: true}]`, `PreSpecEventParser` (only for `#/debug`) |

`ConfigurationStore` (`store/ConfigurationStore.ts`) holds one config object per view, created once and kept
across route changes:

| View | Config field holding model references |
|---|---|
| Congestion | `congestionGraphConfig.connection: QlogConnection \| undefined` (+ non-reactive `renderer`) |
| Sequence | `sequenceDiagramConfig.connections: {connection, timeOffset}[]`, `timeResolution = 1` |
| Stats | `statisticsConfig.group: QlogConnectionGroup \| undefined` |
| Multiplexing | `multiplexingGraphConfig.connections: QlogConnection[]`, `collapsed = true`, `showwaterfall = true`, `showbyteranges = true` |
| Packetization | `packetizationDiagramConfig.connections: QlogConnection[]`, `collapsed = true` |

`SequenceDiagramConfig.createConnectionWithTimeoffset(c)` = `{connection: c, timeOffset: c.getEventParser() ?
c.getEventParser().timeOffset : 0}` (`SequenceDiagramConfig.ts:17-22`).

### 3.16 NEW: the qvis-react data model

#### 3.16.1 Goals and constraints

1. Same information and the same ordering semantics the views consume today (relative/absolute time, start time,
   time tracking method, per-type lookup in first-seen order, vantage point and perspective, labels, clones).
2. Latest drafts only: `file_schema` / `serialization_format`, `namespace:event_type` names, `time_format`,
   object `reference_time`, effective common fields, `group_id`, `tuple`.
3. No cursor: one `QlogEvent` object per event, created once at load. Raw JSON objects are kept by reference and
   **never mutated** (export and "raw JSON" views show exactly what was loaded).
4. Framework-agnostic plain TypeScript classes (no React, no D3 imports). Renderers stay imperative D3 and read
   the model synchronously in hot loops, so the model must not be wrapped in proxies (no Immer, MobX, Valtio).
5. Load cost close to one `JSON.parse` plus one linear pass; no deep clones of event data.

#### 3.16.2 Pipeline

Input: `LoadedQlog` from file-loading 3.14 (already parsed; contained or sequential normalized to `{...header,
traces: [...]}`). Output: `QlogConnectionGroup` with `diagnostics`.

```
QlogLoader.fromJSON(loaded, fileInfo?) -> QlogConnectionGroup | undefined
  A. validate root (main-schema digest P6). Fatal (return undefined + console.error): not an object;
     neither `traces` array nor `trace` object. Legacy `qlog_version` files never reach here
     (file-loading rejects them with LegacyQlogError).
  B. group = new QlogConnectionGroup(); group.fileSchema, serializationFormat, title ?? "", description ?? "",
     version = fileSchema (display), format = serializationFormat, summary = {} (PARITY: never populated)
  C. for each traces[i] (file order):
       TraceError  -> placeholder connection (3.16.6)
       Trace       -> normalise trace (P7) -> normalise events (P8; no aliases, see the 3.16.4 override)
                   -> resolve times in FILE order (P9, delta decoding per serialized trace)
                   -> split by group (3.16.5)
                   -> per slice: stable sort (3.16.7), timing (3.16.3), index (3.16.8)
  D. diagnostics: collected per file, deduplicated by code (main-schema digest section 22 conventions);
     console.warn each once; the store shows the toasts in 6.3.
```

#### 3.16.3 Time model (the `IQlogEventParser` time contract, re-derived)

Per event, after P9 (main-schema digest): `resolvedTime` = ms relative to the event's effective
`reference_time.epoch`, after delta decoding (`relative_to_previous_event` is decoded against the previous event
**in the serialized trace**, before splitting and sorting).

Per connection (slice), with `start` = minimum `resolvedTime` (first event after sorting) and `epochMs` from the
slice's effective `reference_time` (`common_fields.reference_time`, else the first event's):

| Case | Detect | `relativeTime` | `absoluteTime` | `getAbsoluteStartTime()` | `getTimeTrackingMethod()` | qvis equivalent |
|---|---|---|---|---|---|---|
| A | `epochMs === 0` (epoch `1970-01-01T00:00:00Z`, or no `reference_time` at all: CDDL defaults) | `resolved - start` | `resolved` | `start` | `ABSOLUTE_TIME` | `time_format: "absolute"` |
| R | `epochMs` is a finite non-zero number | `resolved` | `epochMs + resolved` | `epochMs` | `RELATIVE_TIME` | `"relative"` + `reference_time` |
| U | `epochMs === null` (`epoch: "unknown"`, monotonic clock, unparseable) | `resolved - start` | `resolved - start + refOverride` | `refOverride` (initially `0`) | `RELATIVE_TIME` | `"relative"` without `reference_time` (qvis assumed 0) |

Implementation (O(1) per access, supports `setReferenceTime` without touching events):

```ts
class ConnectionTiming {
  method: TimeTrackingMethod;           // ABSOLUTE_TIME or RELATIVE_TIME; DELTA_TIME is never produced
  relativeZero: number;                 // A: start   R: 0          U: start
  absoluteShift: number;                // A: 0       R: epochMs    U: -start
  absoluteStart: number;                // A: start   R: epochMs    U: 0
  readonly timeOffset = 0;              // configuration.time_offset no longer exists
  getAbsoluteStartTime() { return this.absoluteStart; }
  getTimeTrackingMethod() { return this.method; }
  setReferenceTime(ms: number) {        // qvis: addTime = ms. Only meaningful for R and U.
    if (this.method !== TimeTrackingMethod.RELATIVE_TIME) return;   // qvis changed absoluteTime even for
                                                                    // ABSOLUTE traces; never called that way
    this.absoluteShift += ms - this.absoluteStart;
    this.absoluteStart = ms;
  }
  timeToMilliseconds(v: number | string) { return parseFloat(v as string); }   // units are always ms now
}
// QlogEvent:
get relativeTime() { return this.resolvedTime - this.conn.timing.relativeZero; }
get absoluteTime() { return this.resolvedTime + this.conn.timing.absoluteShift; }
```

Notes:

- Mixed per-event `reference_time` values in one slice: the case comes from the slice-level reference; events
  whose own epoch differs get `resolvedTime` pre-shifted onto the slice epoch (`resolved + (eventEpoch -
  sliceEpoch)`) so the getters stay uniform; diagnostic `time.mixed-reference-times`.
- Precision: compute `relativeTime` in the resolved domain (never as a difference of two Unix-ms values).
- Case R reproduces qvis exactly, including relative times that start far above 0 (the congestion graph's
  `> 3000 ms` start-offset hack keeps working, `CongestionGraphD3Renderer.ts:527-535`).
- Case U normalizes to the first event (qvis did not), which is what the sequence diagram's "no reference_time"
  fallback (`setReferenceTime(other ± 5)`) assumes anyway. Decision D3 in 8.8.
- Optional (decision D4): treat case A as U when `start < 1e10` (a "Unix ms" value before 1970-04-27 is almost
  certainly a producer that logs relative times without a `reference_time`). qvis did not do this (it treated
  such traces as absolute), so it is off by default.

#### 3.16.4 Event normalization

Per raw event `ev` (file order, index `i`):

1. Not an object: skip, diagnostic `event.not-object` (covers `event_fields` arrays in a -14 file: also emit
   `trace.event-fields-unsupported` once). `{}`: skip silently (qvis trailing-comma accommodation, now applied to
   every position: FIX of 7.Q4).
2. `loggedName = eff(ev, "name")` where `eff(ev, k) = ev[k] !== undefined ? ev[k] : common_fields[k]`.
   Lenient: if `ev.category` exists and `name` has no colon, use `category + ":" + name`.
3. Canonical name: apply the alias table of quic-events digest section 15 (intermediate names such as
   `quic:metrics_updated`, `recovery:metrics_updated`, `quic:loss_timer_updated`, `transport:packet_sent`,
   `http:frame_created` to `http3:frame_created`, `quic:datagrams_sent`, ...). Store both `loggedName` and
   `fullName`.
4. Split `fullName` at the **first** colon into `namespace` and `type`. No colon: `namespace = "unknown"`,
   `type = fullName` (FIX: qvis showed the whole name as the category). Missing: `"unknown:unknown"`.
   No lower-casing (PARITY with `DirectEventParser`).
5. `data`: `eff(ev, "data")` if it is a plain object, else `{}` (diagnostic; the raw value stays in `raw`). If an
   alias data fix-up applies (quic digest 15.3: `cwnd` to `congestion_window`, `owner` to `initiator`,
   `timeout` to `delta`, `length` to `raw.length`, ...), `data` is a **shallow copy** with the fix-ups applied;
   otherwise `data === raw.data` (no copy). Never mutate `raw.data`.
6. `time`: number, or numeric string (`parseFloat`, diagnostic once), else malformed (resolved time = previous
   event's, or 0; `malformed: ["time"]`).
7. `groupId = eff(ev, "group_id")` (non-strings through `JSON.stringify`, PARITY), `tuple = eff(ev, "tuple") ??
   ""`, `timeFormat = eff(ev, "time_format") ?? "relative_to_epoch"`, `referenceTime = eff(ev,
   "reference_time")`.

uint64 values in `data` may be numbers or decimal strings (I-JSON). The model does not coerce them; consumers keep
qvis's `"" + x` / `parseInt(x, 10)` comparisons.

> **Override (ARCHITECTURE §3.1, normative).** Step 2's lenient `category + ":" + name` join, step 3 (alias table)
> and the fix-up part of step 5 are **dropped**: `fullName === loggedName`, `namespace`/`type` come from splitting
> the logged name at the first colon, and `data === raw.data` always (shallow copies never happen). Events whose
> namespace is a pre-final category (`transport`, `recovery`, `security`, `connectivity`, `http` other than the
> capsule events, `qpack`) or whose `quic:`/`http3:` type is not defined by quic-events-13 / h3-events-13 raise the
> warning `event.nonconforming-name` (count + up to 5 samples), which becomes toast DM3 (6.3). Legacy data members
> (`header.packet_size`, ...) are reported, never moved (9.6). Section 9 gives the full mapping.

#### 3.16.5 Splitting a trace into connections (`group_id`)

PARITY-oriented rule (decision D2):

- Split when **at least one event carries its own `group_id` member** (qvis: when the first event does). Each
  distinct effective value (event value, else `common_fields.group_id`, else the literal `"(no group_id)"`)
  becomes one connection, in first-appearance order, titled `"Group " + id + " : " + (trace.title ?? "")`
  (PARITY, including the single-group case where qvis also prefixed the title).
- `common_fields.group_id` alone never splits and never prefixes (PARITY).
- The main-schema digest (section 10) recommends splitting only when more than one distinct value exists; that
  would drop the `"Group X : "` prefix for single-group traces. This document recommends the parity rule above.
- Every slice shares the trace's `title`, `description`, `vantage_point` (deep-copied per slice: FIX of 7.Q8),
  `common_fields`, `event_schemas`; `connection.groupId` = the slice's id (or `undefined` when not split).
- Delta decoding (`relative_to_previous_event`) happens before splitting (spec: relative to the previously
  logged event).

#### 3.16.6 Trace normalization, TraceErrors, vantage points

- TraceError (`typeof error_description === "string"`): placeholder connection with `title = "ERROR"`,
  `description = (uri !== undefined ? uri + " : " : "") + error_description` (FIX for absent `uri`),
  `isError = true`, zero events, vantage point from the TraceError's optional `vantage_point`, else the ctor default
  `{type: "unknown", flow: "unknown"}` without name (PARITY).
- Trace `vantage_point`: if missing, not an object, or without `type`, use `{type: "unknown", flow: "unknown",
  name: "No VantagePoint set"}` (PARITY). qvis overwrote a provided `name` in the "object without type" case;
  keep a provided name (FIX, minor). Otherwise copy `{name, type, flow}` as given (unknown `type` strings are kept
  for display; `perspective` treats them as `"unknown"`).
- `title` / `description`: strings or `""`. `common_fields`: object or `{}` (never `undefined`: FIX of 7.Q13).
  `event_schemas`: string array or `[]` (diagnostic).
- `protocolHint` (replaces `common_fields.protocol_type`, which -14 removed): `common_fields.protocol_type` if
  present (keeps the qvis-internal `"TCP_HTTP2"` / `"TCP"` / `"QUIC_HTTP3"` values from converters working), else
  derived from the observed namespaces (`tcp` + `http2` gives `"TCP_HTTP2"`, `tcp` gives `"TCP"`), else
  `"QUIC_HTTP3"` when `event_schemas` or observed namespaces include `quic` or `http3`, else `"unknown"`. Together
  with the derived `transportNamespace` (`"tcp"` for TCP hints, else `"quic"`) this keeps converter TCP traces
  working in the views that qvis supported them in (9.10).

#### 3.16.7 Ordering

- Per slice, after resolving times: if `resolvedTime` is not non-decreasing in file order, stable-sort by
  `resolvedTime` with the original index as tie-breaker (equal times keep the logged order), diagnostic
  `trace.reordered` (warning; toast in 6.3).
- Malformed times were already replaced by the previous event's time, so they keep their position.
- Delta decoding is never re-applied (FIX of 7.Q6).
- `QlogEvent.index` = position in `connection.events` after sorting (the value the sequence diagram's
  `focusOnEvent` URL parameter refers to, PARITY), `QlogEvent.originalIndex` = position in `trace.events`.

#### 3.16.8 Lookup index

Built eagerly at load (one pass), in `connection.events` order:
`Map<namespace, Map<type, QlogEvent[]>>`, insertion order = first occurrence (PARITY with qvis
`setupLookupTable`). Also a flat `Map<fullName, QlogEvent[]>` view is unnecessary: `lookup(ns, type)` is O(1).

- `lookup(namespace, type)`: the array or a shared frozen empty array. Always valid (no "forgot to call
  `setupLookupTable`" failure mode).
- `getLookupTable()`: returns the map (Stats histogram).
- `setupLookupTable()`: kept as a no-op for porting convenience (or delete the calls).
- Clones get their own index built from their transformed names (3.16.10).

#### 3.16.9 Annotations (replacing `qvis` namespaces and in-place mutation)

- `QlogEvent.ext: Partial<EventExtensions>` lazily created plain object, never serialized (export and detail
  views use `raw`). Typed slots:
  - `ext.sequence?: {y?: number; rightTarget?: QlogEvent; leftTarget?: QlogEvent; packetLost?: "rightTarget" |
    "leftTarget"; focusInfo?: EventPointer; timeText?: string}`
  - `ext.congestion?: {from: number; to: number; correspondingPackets: QlogEvent[]; correspondingAck?: QlogEvent;
    correspondingLoss?: QlogEvent}`
  - `ext.packetization?: {frameSizes?: FrameSizeInfo[]; fillerHeaderSize?: number}` (instead of mutating
    `data.frames` and inserting filler frames; the sequence diagram then has nothing to hide)
- `QlogConnection.ext: Partial<ConnectionExtensions>`: `sequence?: {generatedSibling?: QlogConnection;
  manualTimeOffset?: number}`.
- Each renderer resets the slots it recomputes at the start of its pass (FIX of 7.Q14).

#### 3.16.10 Simulated peer traces (sequence diagram clones)

```ts
// returns a NEW connection, registered in the same group (PARITY: it appears in selectors), wasAutoGenerated left false
connection.clone(transform?: (ev: QlogEvent) => { namespace: string; type: string })
```

- `raw` objects are shared (no JSON deep clone needed because nothing mutates raw); `QlogEvent` wrappers, `ext`,
  `title`, `description`, `vantagePoint`, `commonFields`, `timing` are copied; the lookup index is built from the
  transformed `namespace`/`type`; `fullName = namespace + ":" + type`.
- The sequence diagram calls `clone(ev => ev.type === "packet_sent" ? {namespace: ev.namespace, type:
  "packet_received"} : ev.type === "packet_received" ? {..., type: "packet_sent"} : {..., type: "ignoreseq"})`,
  then sets `title`, `description`, `vantagePoint`, `wasAutoGenerated = true` (exact strings in 2.3).
- Registration goes through `group.addConnection()` which emits a model change (3.16.11) so selectors re-render
  (Vue did this through reactivity).

#### 3.16.11 Change notification

Model objects are mutable class instances; React learns about changes through a revision counter, not through
object identity:

- `QlogConnectionGroup.addConnection()`, `QlogConnection.setTitle/setDescription/setVantagePoint` (used by the
  sequence diagram's renames), `ConnectionTiming.setReferenceTime()` call `modelEvents.emit()`.
- The connection store subscribes and increments `revision`; selector components read `revision` (zustand
  selector) so their option lists recompute. Event arrays are never put in React state.

#### 3.16.12 TypeScript API (normative shape)

```ts
// src/model/QlogEvent.ts
export class QlogEvent {
  readonly conn: QlogConnection;
  readonly raw: Readonly<Record<string, unknown>>;   // untouched input object (export, detail modal)
  readonly originalIndex: number;                    // index in trace.events
  index: number;                                     // index in conn.events (set after sort)
  readonly loggedName: string;                       // as logged
  readonly fullName: string;                         // canonical "quic:packet_sent"
  readonly namespace: string;                        // "quic"  (qvis: category)
  readonly type: string;                             // "packet_sent" (qvis: name)
  readonly data: any;                                // normalised data (=== raw.data unless fixed up)
  readonly time: number;                             // as logged (number), NaN if malformed
  readonly resolvedTime: number;                     // ms since effective epoch, delta-decoded
  readonly groupId?: string;
  readonly tuple: string;                            // "" default
  readonly malformed?: readonly string[];
  ext?: Partial<EventExtensions>;
  get relativeTime(): number;                        // 3.16.3
  get absoluteTime(): number;                        // 3.16.3
  get timeOffset(): number;                          // always 0 (qvis parser.timeOffset)
  timeToMilliseconds(v: number | string): number;    // parseFloat
  is(fullName: string): boolean;                     // this.fullName === fullName
}

// src/model/QlogConnection.ts
export class QlogConnection {
  readonly parent: QlogConnectionGroup;
  title: string; description: string;                // mutate via setters (change notification)
  vantagePoint: VantagePoint;                        // own copy
  readonly commonFields: Record<string, unknown>;    // {} default
  readonly eventSchemas: readonly string[];
  readonly groupId?: string;                         // set for group_id slices
  readonly traceIndex: number;                       // index in file.traces
  readonly rawTrace?: Readonly<Record<string, unknown>>;   // for export (undefined for clones)
  readonly isError: boolean;                         // TraceError placeholder
  readonly traceError?: { error_description: string; uri?: string; vantage_point?: VantagePoint };
  readonly protocolHint: "QUIC_HTTP3" | "TCP_HTTP2" | "TCP" | "unknown" | string;
  readonly transportNamespace: "quic" | "tcp";       // 9.10: namespace of packet_sent/packet_received for this trace
  wasAutoGenerated: boolean;
  readonly timing: ConnectionTiming;
  ext?: Partial<ConnectionExtensions>;

  getEvents(): readonly QlogEvent[];
  lookup(namespace: string, type: string): readonly QlogEvent[];
  getLookupTable(): ReadonlyMap<string, ReadonlyMap<string, readonly QlogEvent[]>>;
  setupLookupTable(): void;                          // no-op (porting aid)
  getVantagePointPerspective(): "client" | "server" | "unknown";   // 3.3.3 logic; unknown type strings -> flow/unknown
  getLongName(): string;                             // 3.3.4, verbatim formula
  clone(transform?: (ev: QlogEvent) => { namespace: string; type: string }): QlogConnection;   // 3.16.10
  // porting shims (optional, remove when all views are ported):
  parseEvent(ev: QlogEvent): QlogEvent;             // identity
  getEventParser(): ConnectionTiming & { load(ev: QlogEvent): QlogEvent };
  // derived helpers (new, optional):
  readonly startTime: number;                        // = timing.getAbsoluteStartTime()
  timeRange(): { minRelative: number; maxRelative: number } | undefined;
}

// src/model/QlogConnectionGroup.ts
export class QlogConnectionGroup {
  fileSchema: string;                                // "urn:ietf:params:qlog:file:contained" | "...:sequential" | other
  serializationFormat: string;                       // lower-cased media type
  version: string;                                   // display string for Stats "qlog version" (= fileSchema)
  format: string;                                    // = serializationFormat (qvis field name kept)
  filename = ""; title = ""; description = ""; URL = ""; URLshort = "";
  summary: Record<string, unknown> = {};             // PARITY: always empty
  readonly diagnostics: Diagnostic[];
  readonly eventSchemas: readonly string[];          // union over traces
  addConnection(c: QlogConnection): void;            // emits a model change
  getConnections(): readonly QlogConnection[];
  getRealConnections(): readonly QlogConnection[];   // !wasAutoGenerated (Stats, export, shorthand: see 7.Q11)
  getShorthand(): string;                            // 3.2.2 formula
}

export interface VantagePoint { name?: string; type: "client" | "server" | "network" | "unknown" | string;
                                flow?: "client" | "server" | "unknown" | string; }
export enum TimeTrackingMethod { ABSOLUTE_TIME, RELATIVE_TIME, DELTA_TIME }   // numeric values kept
export interface EventPointer { connectionIndex: number; eventIndex?: number; packetNumber?: number; }
export interface Diagnostic { level: "error" | "warning" | "info"; code: string; message: string; count: number;
                              traceIndex?: number; sample?: unknown; }
```

#### 3.16.13 Old API to new API

| qvis | qvis-react | Notes |
|---|---|---|
| `conn.getEvents()` (raw) | `conn.getEvents()` (`QlogEvent[]`) | |
| `conn.parseEvent(raw).X` | `ev.X` | no cursor |
| `.category` | `.namespace` | values change: `transport`/`recovery`/`connectivity`/`security` become `quic`; `http` becomes `http3`; `error`/`warning`/`info`/`debug`/`verbose` become `loglevel` (the level moves to `type`) |
| `.name` | `.type` | values mostly unchanged; renamed types in section 4.2 |
| `.name = x` (clone rename) | `conn.clone(transform)` | |
| `.data` | `.data` | `undefined` never happens (`{}` default) |
| `.relativeTime` / `.absoluteTime` | same | 3.16.3 |
| `.timeToMilliseconds(x)` | same (`parseFloat`) | |
| `.timeOffset` | same (0) | |
| `conn.getEventParser().load(raw)` | `ev` | |
| `getEventParser().getAbsoluteStartTime()` / `getTimeTrackingMethod()` / `setReferenceTime()` / `timeOffset` | `conn.timing.*` | |
| `conn.setupLookupTable(); conn.lookup(EventCategory.transport, TransportEventType.packet_sent)` | `conn.lookup(NS.quic, QUIC.packet_sent)` | |
| `conn.getLookupTable()` | same | keys are namespaces |
| `conn.commonFields.protocol_type` | `conn.protocolHint` | |
| `conn.eventFieldNames`, `conn.configuration` | removed | |
| `(raw as any).qvis.X` / `(conn as any).qvis.X` | `ev.ext.X` / `conn.ext.X` | |
| `(raw as any).timeText` | `ev.ext.sequence.timeText` | |
| `group.version`, `group.format` | same names, new values | |
| `qlog.EventCategory.*`, `qlog.TransportEventType.*`, ... | `src/model/names.ts` constants (`NS`, `QUIC`, `HTTP3`, `LOGLEVEL`, `SIMULATION`) | |

---

## 4. Event and field consumption

### 4.1 Fields the data model itself reads

| Old (qvis, draft-02 / 0.3) | Used for | New (-14) | Notes |
|---|---|---|---|
| `qlog_version` | loader dispatch, `group.version` | `file_schema` (+ `serialization_format`) | legacy files rejected by file-loading |
| `qlog_format` | `group.format` | `serialization_format` | |
| `title`, `description` (file) | group labels | same | |
| `summary` | (never copied) | removed | `summary` stays `{}` |
| `traces[]` | one or more connections each | `traces[]` (contained) / `trace` (sequential, normalized) | |
| `traces[].error_description`, `uri` | ERROR placeholder | same (`uri` optional) | |
| `traces[].title`, `description` | connection labels | same | |
| `traces[].vantage_point.{name,type,flow}` | perspective, labels, sent/received semantics | same | `flow` only meaningful for `network` |
| `traces[].configuration.time_units` (`"us"`) | time multiplier 0.001 | removed (always ms) | |
| `traces[].configuration.time_offset` | added to every time; `getEventParser().timeOffset` is also the initial sequence-diagram offset (`SequenceDiagramConfig.ts:17-22`) and a non-zero value skips automatic latency alignment (`SequenceDiagramD3Renderer.ts:599-603`) | removed | `timeOffset` is always 0, so alignment is always eligible (9.3) |
| `traces[].configuration.original_uris` | export only | removed | |
| `traces[].common_fields.time_format` (`absolute`/`relative`/`delta`) | time model | `time_format` (`relative_to_epoch`/`relative_to_previous_event`), also per event | 3.16.3 |
| `traces[].common_fields.reference_time` (numeric string, date string) | time model | object `{clock_type, epoch, wall_clock_time?}`, also per event | numeric legacy values accepted leniently (main-schema digest P9) |
| `traces[].common_fields.group_id` | (ignored by qvis) | effective `group_id` | 3.16.5 |
| `traces[].common_fields.protocol_type` | `"TCP_HTTP2"` packetization path, `"TCP"` congestion log | removed (`event_schemas`) | `protocolHint` |
| `traces[].common_fields.category` / `name` | default category/name (`QlogLoaderV2.ts:394-400`) | `category`: none; `name`: any common field via `eff()` | |
| (none) | | `traces[].event_schemas` | stored, diagnostics, `protocolHint` input |
| `traces[].event_fields` | `EventFieldsParser` | removed | diagnostic, events skipped |
| `traces[].events` (`jsonconnection.events`; empty or missing crashed qvis, Q5) | the raw event array (kept by reference) | `events: [* Event]` (required, may be empty; separate records in JSON-SEQ) | zero-event connection |
| `events[].time` | all time values | `time` (float64 ms) | |
| `events[].name` (`"category:type"`), `events[].category` | category/type (`QlogLoaderV2.ts:329-366`) | `name` (`"namespace:type"`); no `category` member | `category` is ignored (ARCHITECTURE §3.1) |
| `events[].data` | everything | `data` | |
| `events[].group_id` | splitting (first event decides) | per-event or common `group_id` | |
| (none) | | `events[].tuple`, `system_info`, `time_format`, `reference_time` | stored |
| `data.header.packet_size`, `data.header.payload_length`, `data.packet_type` | draft-02 auto-fix | `raw.length`, `raw.payload_length`, `header.packet_type` | no fix-ups (ARCHITECTURE §3.1): the legacy members are reported as `event.legacy-field` and not read (9.6) |

### 4.2 Lookups and event-name checks per consumer (old key to new key)

All `lookup()` calls and `parseEvent().name/category` comparisons in shipped code. "type-only" means qvis compared
only the event type (not the category). qvis-react compares **full names** everywhere (namespace + type, constants
from `names.ts`; 9.1 rule 3, 9.8). The one place where qvis's type-only matching mattered across categories was
converter output (TCP packets logged under `transport`, HTTP/2 frames under `http2`); that is preserved through
`connection.transportNamespace` and the `http2` exception in 9.10, not through type-only matching.

| Consumer (file:line) | Old key | New key | Purpose |
|---|---|---|---|
| CongestionGraphD3Renderer.ts:1081 | `lookup(transport, packet_sent)` | `lookup(quic, packet_sent)` | sent packets, byte ranges |
| :1082 | `lookup(transport, packet_received)` | `lookup(quic, packet_received)` | received packets, ACK frames, flow control frames |
| :1083 | `lookup(recovery, packet_lost)` | `lookup(quic, packet_lost)` | loss markers |
| :1084 | `lookup(recovery, metrics_updated)` | `lookup(quic, recovery_metrics_updated)` | cwnd, bytes in flight, RTTs |
| :1085 | `lookup(transport, parameters_set)` | `lookup(quic, parameters_set)` | initial flow-control limits (`owner` to `initiator`) |
| SequenceDiagramD3Renderer.ts:85-86 | type-only `packet_sent` / `packet_received` | same types (namespace `quic`) | click redirect from generated trace |
| :112, :121 | type-only `metrics_updated` | `recovery_metrics_updated` | aggregated metrics in modal |
| :494-495 | `lookup(transport, packet_sent/packet_received)` | `lookup(quic, ...)` | vantage-point guess |
| :545-549 | type-only rename on clone | same (via `clone(transform)`) | |
| :651, :674 | `lookup(recovery, metrics_updated)` | `lookup(quic, recovery_metrics_updated)` | latency estimate (`latest_rtt`, `smoothed_rtt`) |
| :709, :724, :733 | type-only `packet_received` / `packet_sent` | same | initial-packet clock alignment |
| :1104-1105 | `lookup(transport, packet_sent / packet_received)` | `lookup(quic, ...)` | arrows |
| :1170 | type-only `packet_sent` | same | `focusOnPN` |
| :1371 | `ignoreseq` | same (clone-only type) | hide events on generated trace |
| :1682-1683 | type-only not `packet_sent`/`packet_received` | same | side labels for other events |
| :1943-1981 `eventTypeToColor` | types `connection_id_updated`, `spin_bit_updated`, `connection_state_updated`, `metrics_updated`, `parameters_set` (any category), `loss_timer_updated`, `frame_created`, `frame_parsed`, `datagrams_sent`, `datagrams_received`; categories `error`, `warning`, `simulation`, `debug`, `info`, `verbose` | types `connection_id_updated`, `spin_bit_updated`, `connection_state_updated`, `recovery_metrics_updated`, `parameters_set` + `recovery_parameters_set`, `timer_updated`, `frame_created`, `frame_parsed`, `udp_datagrams_sent`, `udp_datagrams_received`; `loglevel:error`, `loglevel:warning`, `simulation:*`, `loglevel:debug/info/verbose` | colours (sequence-diagram spec) |
| :1984-2224 `eventToShortString` | types above plus `packet_lost`, `congestion_state_updated`, `info`/`debug`/`warning`/`error`/`verbose`/`connection_error`/`internal_error`/`application_error`/`internal_warning`/`marker`/`message`; `parameters_set` label chosen by category `recovery`/`transport`/`http` | `quic:recovery_parameters_set` gives "recovery parameters set", `quic:parameters_set` "transport parameters set", `http3:parameters_set` "HTTP/3 parameters set"; loglevel types; `simulation:marker` | short labels (sequence-diagram spec) |
| StatisticsConnectionRenderer.vue:321-322 | `lookup(http, frame_created / frame_parsed)` | `lookup(http3, ...)` | "H3 connection headers" row |
| :466, :474, :505, :521 | `category === transport` and `name === parameters_set` / `packet_sent` / `packet_received` | `namespace === quic` and same types | flow-control tables |
| :47 template | whole lookup table | whole index (namespaces) | events histogram |
| MultiplexingGraphD3WaterfallRenderer.ts:105-112, :162, :243, :270-315 | type-only `packet_sent`, `packet_received`, `frame_created`, `frame_parsed` | same types | waterfall |
| MultiplexingGraphD3CollapsedRenderer.ts:165-170, :407 | type-only `packet_received` / `packet_sent` | same | data flow |
| :463 | type-only `data_moved` (enum `HTTP3EventType.data_moved`) | `quic:stream_data_moved` (type changes) | byte ranges |
| MultiplexingGraphD3SimulationRenderer.ts:91-96 (DEAD) | `lookup(http, frame_created/parsed)` | `lookup(http3, ...)` | not rendered |
| PacketizationQUICPreProcessor.ts:14-29, :213, :408, :452, :464 | type-only `packet_received`/`packet_sent`, `frame_parsed`/`frame_created`, `parameters_set` | same types (namespaces `quic`, `http3`); `parameters_set` should be restricted to `quic` (qvis also matched `http:parameters_set` and `recovery:parameters_set`, harmless because they lack `max_packet_size`) | lanes |
| PacketizationTCPPreProcessor.ts:15-33, :62, :104, :194, :317 | type-only `packet_*` (category `transport`), `record_*` (`tls`), `frame_*` (`http2`) (qvis TCP schema, `pcapconverter/qlog_tcp_tls_h2.ts:3-7`) | `tcp:packet_sent/received`, `tls:record_created/parsed`, `http2:frame_created/parsed` (ported converter, ARCHITECTURE §0; 9.10) | TCP lanes |
| StatisticsConnectionRenderer.vue:389-445 (`totalFrameCount`, `frameLUT`, `encryptionLUT`) | **no name check (shape-based)**: every event with `data.frames` (QUIC frames), `data.frame` (H3 frame) or `data.header.packet_type` | unchanged (shape-based). In -13 this also counts `quic:frames_created/parsed/processed`, `quic:packet_lost`, `quic:marked_for_retransmit` frames and `quic:packet_dropped/buffered/lost` headers, exactly as qvis counted their draft-02 counterparts; `http:capsule_*` (`data.capsule`) is not counted | Stats frame and encryption-level tables |
| SequenceDiagramD3Renderer.ts:2201-2216 | label `evt.category + ": " + data.message` for the generic types | prefix = `type` for `loglevel:*`, `"simulation"` for `simulation:marker` (9.8) | side labels |
| SequenceDiagramCanvasRenderer.ts:56-61 (DEAD) | type-only rename | n/a | |
| SequenceDiagramSimpleRenderer.vue:11 (DEAD) | `parseEvent().time` (does not exist), `.category`, `.name`, `.trigger`, `data.header.version` | n/a | |
| FileManagerContainer.vue:542-554 (DEAD, `DEBUGfilter = false`) | full names `transport:packet_sent`, `transport:packet_received`, `transport:parameters_set`, `http:frame_created`, `"http" + "frame_parsed"` (missing colon, qvis bug), substring `session_ticket_used` | n/a | download filter (debug only) |
| views/VUEDebug.vue:16 | `parseEvent(e).name` | `e.type` | debug page |

### 4.3 Data members consumed (summary; field-level port tables live in the digests)

| Consumer | Old members | New members (renames in bold) | Digest |
|---|---|---|---|
| Congestion | `raw.length`, `header.packet_type`, `header.packet_number`, frames `ack.acked_ranges`, `max_data.maximum`, `max_stream_data.{stream_id,maximum}`; params `owner`, `initial_max_data`, `initial_max_stream_data_bidi_remote`; metrics `bytes_in_flight`, `cwnd`/`congestion_window`, `min_rtt`, `smoothed_rtt`, `latest_rtt` (through `timeToMilliseconds`); `packet_lost.raw.length` (tooltip) | **`initiator`**; **`congestion_window`** (`cwnd` is not a -13 member: the model never rewrites it; an in-view fallback is the view spec's call); RTTs already ms; lost-packet size from the matching `packet_sent` (no `raw` on `packet_lost`) | quic 13.6 |
| Sequence | `header.{packet_type,packet_number}`, `frames` (all fields of `frameToShortString`: `ack.acked_ranges`, `stream.{stream_id,fin}`, `connection_close.{error_code,raw_error_code,reason}`, `max_*.maximum`, `*_blocked.limit`, `stream_type`, `reset_stream`/`stop_sending` `{stream_id,error_code}`), `spin_bit_updated.state`, metrics keys (`cwnd`, `smoothed_rtt`, `bytes_in_flight`, `ssthresh` for the label; every key for the popup fold and the key count), `parameters_set` key count, `connection_state_updated.new`, timer `delta`/`timeout`/`event_type`/`packet_number_space`/`timer_type`, `packet_lost.header`, `congestion_state_updated.new`, H3 `stream_id`, `frame.{frame_type,headers}`, loglevel `message` | **`quic:timer_updated`** (`timeout` to `delta`), frame **`error`**/**`error_code`** (was `error_code`/`raw_error_code`), `application_close` folded into `connection_close`, metrics **`congestion_window`**, `simulation:marker.message` | quic 13.6, h3 10.6.3 |
| Stats | `frames[].frame_type`, `frame.frame_type`, `header.packet_type` (any event, shape-based, 4.2), params `owner` + `initial_max_data`, `initial_max_stream_data_bidi_local`, `initial_max_stream_data_bidi_remote`, `initial_max_stream_data_uni`, `max_data.maximum`, `max_stream_data.{stream_id,maximum}`, H3 headers `server`/`user-agent`/`:authority` | **`initiator`**; header names via `fieldName()`/`fieldValue()` | quic 13.6, h3 10.6.4 |
| Multiplexing | stream frame `stream_id`, `offset`, `length`, `header.packet_number`; H3 `stream_id`, `frame.headers` (`priority`), PRIORITY_UPDATE `element_id`, `value`; `data_moved.{stream_id,offset,length,from,to}` | **`raw.length`** (frames and `stream_data_moved`), `offset ?? 0`; PRIORITY_UPDATE **`stream_id`** / **`priority_field_value`** | quic 13.6, h3 10.6.1-2 |
| Packetization | `raw.{length,payload_length,data}`, `header.packet_type`/`packet_number`, frames `frame_size`/`length`/`stream_id`/`fin`, H3 `byte_length` (`PacketizationQUICPreProcessor.ts:67`, `:412-415`), `stream_id`, `frame.{frame_type,headers}`, H3 unknown frame `raw_frame_type` (`PacketizationDiagramModels.ts:101-102`); params `owner` + `max_packet_size` (`:464-476`) | **`initiator` + `max_udp_payload_size`**; frames **`raw.length`**; H3 **`frame.raw.payload_length`**; H3 unknown **`frame_type_bytes`**; `frame_size`/`header_size`/`payload_size` are qvis-internal (4.4) | quic 13.6, h3 10.6.5 |

### 4.4 Implementation-specific, legacy and qvis-internal fields

| Field | Origin | Status in qvis-react |
|---|---|---|
| `common_fields.protocol_type` (`"TCP_HTTP2"`, `"TCP"`, `"QUIC_HTTP3"`) | qvis TCP / netlog converters, draft-01/02 | read into `protocolHint` if present |
| `event_fields`, `relative_time`, `delta_time`, `event_type`, upper-case `CATEGORY`/`EVENT_TYPE` | draft-00/01 | DROP (diagnostic) |
| `configuration.*` | draft-01/02 | DROP |
| `qvis` property on events/connections, `timeText` | renderers | replaced by `ext` (3.16.9) |
| `frame_size`, `header_size`, `payload_size`, filler frames | packetization | `ext.packetization` (no mutation) |
| `trigger` as 4th array element | pre-spec 0.1 | DROP |
| top-level event `trigger` member | draft-01 (read only by the DEAD `SequenceDiagramSimpleRenderer.vue:11`) | DROP (latest: `data.trigger`) |
| event type `ignoreseq` (`"<ns>:ignoreseq"`) | sequence-diagram clones (`SequenceDiagramD3Renderer.ts:73`, `:553`, `:1371`) | kept as a clone-only internal type; never loaded, never a draft name (9.8) |
| `common_fields.protocol_type` written by qvis converters | `pcapconverter/tcptoqlog.ts:69` (`"TCP_HTTP2"`), `netlogconverter/netlogtoqlog.ts:878` (`"QUIC_HTTP3"`) | still honoured as a custom common field (9.10) |
| `_isVue` | Vue reactivity hack | DROP |

---

## 5. URL query parameters and global state

### 5.1 Query parameters whose meaning depends on the model

The model reads none directly. These depend on its ordering semantics and must keep working (drop-in links):

| Parameter | Owner | Model dependency |
|---|---|---|
| `file`, `list`, `file1..N`, `secrets*` | file-loading | produce groups; `file` also sets `group.URL` / `URLshort` |
| `focusOnConnection` + `focusOnEvent` | sequence diagram (`SequenceDiagramRenderer.vue:60-62`) | `focusOnEvent` = index into `connection.getEvents()` **after** loader sorting and `group_id` splitting (3.16.7 keeps this) |
| `focusOnPN` (+ optional `focusOnConnection`) | sequence diagram (`:63-71`) | first `packet_sent` whose `"" + header.packet_number === "" + pn` (only if `packet_number` truthy). Because the renderer tests `if (focusOn.packetNumber)` and `if (focusOn.eventIndex)` (`SequenceDiagramD3Renderer.ts:1162`, `:1182`, `:1187`), PN 0 and event index 0 can never be focused (sequence-diagram quirk) |
| `#...forceFull` in the hash | sequence diagram (`SequenceDiagramD3Renderer.ts:1242`) | none |
| `multimultiplexing` anywhere in the URL | multiplexing "Load all connections at once" button (`MultiplexingGraphConfigurator.vue:69-74`) | concatenates `getConnections()` of all groups, sorted by `parent.filename` |

The "Direct link to this event" (sequence diagram modal) is `https://qvis.quictools.info?#/sequence?` + `file=` +
`URL` (or `file1=...&file2=...` for several distinct `parent.URL`s) + `&focusOnConnection=` + index +
`&focusOnEvent=` + `focusInfo.eventIndex` (`SequenceDiagramRenderer.vue:103-134`). Owned by the sequence-diagram
spec; it relies on `group.URL` and event indices from this model.

### 5.2 Global state

| State | qvis | qvis-react |
|---|---|---|
| Loaded files | `ConnectionStore.grouplist` (Vuex, deep reactive except events) | zustand `connectionStore.groups` (array identity changes on add/remove) + `revision` counter for in-place model changes (3.16.11) |
| In-flight loads | `outstandingRequests` | `outstandingRequests` (file-loading) |
| Per-view selections | `ConfigurationStore.*Config` objects, survive route changes | zustand `viewConfigStore` with the same fields; selections referencing removed groups are cleared on `removeGroup` (FIX 7.Q17) |
| Renderer scratch data | on model objects (`qvis`) | `ext` slots on model objects |
| `window.holblockinfo` | set to `[]` by "select all" buttons (paper debugging) | DROP |

---

## 6. Edge cases, error handling, notifications

### 6.1 qvis messages (verbatim, for reference; `console.*` unless noted)

Loader (`QlogLoaderV2.ts`):

- `QlogLoaderV2: Unknown qlog version! Only draft-02,draft-02-RC1,qlog-03-WIP,0.3 are supported!` (array
  stringification, no spaces), `QlogLoaderV2: qlog files MUST have a qlog_version field in their top-level
  object!`
- `QlogLoaderV2:fromDraft02 : ` (log)
- `QlogLoaderV2:draft02 : timestamps were not in the correct order!` (`absoluteTime`, `" < "`, minimum, event)
- `QlogLoaderV2:draft02 : manually sorted trace on timestamps!`
- compliance messages (each pushed once per connection):
  - `events had data.header.packet_size set, use data.raw.length instead (example: <category>:<name>)`
  - `events had data.header.payload_length set, use data.raw.payload_length instead (example: <category>:<name>)`
  - `events had data.packet_type set: use data.header.packet_type instead (example: <category>:<name>)`
  - `Trace still uses event_fields. This method is deprecated in draft-02, though qvis still supports it. Better to use the more traditional -02 JSON or NDJSON formats instead.`
  - `Trace does not specify a qlog_format entry, which is required in draft-02. JSON was assumed.`
  - header line `QlogLoaderV2:fromDraft02: ERROR: non-compliant qlog draft-02 trace:`
- `DirectEventParser`: `QlogLoaderV2:Parse: the trace sets reference_time but doesn't set time_format! This is
  needed starting in draft-02, please change your qlogs! We pretend here that time_format was set to "relative".`
  (warn); `QlogLoaderV2: Using time_format === "relative" but no reference_time found in common_fields. Assuming
  0.`; `QlogLoaderV2: DELTA_TIME requires all events to be set before setEventParser is called... was not the case
  here!`; `QlogLoaderV2: No time_format present in qlog file. Pick one of either absolute, relative or delta in
  common_fields` (unreachable); `QlogLoader: No proper startTime present in qlog file. This tool doesn't support
  delta_time yet!`; `QlogLoader:parseReferenceTime: We think reference_time is not in 'milliseconds since epoch'
  as a number, but rather as a time string. That is not really supported, though we'll try to parse it here!`
  (warn).

Consumers (model-related):

- `SequenceDiagram:calculateConnections : trace <filename>:<perspective> did not have <type> events, which are
  needed`
- `SequenceDiagramD3Renderer:setup : None of the selected traces have events in them, cannot render`
- `SequenceDiagramD3Renderer:calculateTimeOffsets : Client had no reference_time set, trying to fix by using the
  server-side reftime. HERE BE DRAGONS!` (and the `Server ...` variant)
- `CongestionGraphD3Renderer:parseQlog : There were <n> sent packets with invalid size! They were not used!`
  (and `received`), `... There were <n> packets acked that we didn't send. If this is a TCP trace with SACKs, that
  is expected for now.` (only when `protocol_type !== "TCP"`)

### 6.2 Edge cases: qvis behaviour and qvis-react behaviour

| Case | qvis | qvis-react |
|---|---|---|
| Trace with `events: []` or no `events` | `TypeError` in the loader; no group; upload path still shows the "Uploaded file" success toast because the rejected action is not awaited | connection with 0 events (diagnostic `trace.no-events`, info); views show their empty state |
| Trace is a TraceError | `ERROR` placeholder; multiplexing/packetization crash on `getEventParser().load` when it is selected | placeholder with zero events and a valid `timing` (start 0); views treat it as empty |
| No `vantage_point` | `{unknown, unknown, "No VantagePoint set"}` | same |
| `vantage_point.type: "network"` without `flow` | perspective `unknown` | same |
| `group_id` on later events only | not split | split (3.16.5) |
| Events missing `group_id` in a split trace | slice `"Group undefined : "` | slice `"Group (no group_id) : "` (or common value) |
| Empty `{}` events | only a trailing one removed (non-split); all skipped (split) | all skipped |
| Event without `time` | relative/absolute 0 | previous event's time, `malformed` |
| Event without `name` | category/name `"unknown"` (or common values) | `unknown:unknown` (or common `name`) |
| Event `name` without colon | category = name = whole string | namespace `unknown`, type = whole string |
| Event without `data` | `data` undefined (consumers mostly guard) | `{}` |
| Unordered timestamps | in-place sort + blocking alert | stable sort + warn toast (6.3) |
| Equal timestamps | kept (stable sort in practice) | kept |
| `relative_to_previous_event` | n/a (old `"delta"` converted in place, re-converted after sort) | decoded once, before sort |
| `reference_time.epoch: "unknown"` / monotonic | n/a (`parseFloat(object)` gives 0) | case U |
| `reference_time` as a number/numeric string (non-compliant) | parsed as ms | accepted leniently with a warning (main-schema digest P9) |
| Very large traces | Vue bypass via `_isVue` | no React state for events; precomputed wrappers |
| Duplicate selection of the same connection | allowed | allowed |
| Group removed while selected | stale references keep rendering | selections cleared (FIX) |

### 6.3 qvis-react notifications from the data model (NEW)

Shown by the store after a successful `fromJSON` (at most one toast per kind per file; `type: "warn"`, default
duration; plain text). Message keys must be stable for tests.

| Id | Condition | Title | Text |
|---|---|---|---|
| DM1 | any slice had `trace.reordered` | `Trace events were not ordered by time` | `Loaded trace was not ordered on event timestamps. qvis sorted the events by timestamp (stable sort: events with equal timestamps keep their logged order). See the console for more details.` |
| DM2 | any `warning`-level diagnostic other than DM1 and DM3 | `Non-compliant qlog file <filename>` | `This file does not fully follow the qlog drafts:` + newline + up to 5 messages (one per line, `count > 1` appended as ` (<count>x)`) + `...and <n> more.` if needed + newline + `qvis has attempted to auto-fix these things, so things should mostly still work.` |
| DM3 | `event.nonconforming-name` (ARCHITECTURE §3.1 item 2, verbatim) | `Unsupported qlog event names in <filename>` | `This file contains <n> events whose names are not defined by the latest qlog drafts (e.g. <samples>). qvis only supports draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13 event names; the visualizations do not interpret these events.` |

`info` diagnostics (unknown namespaces, missing `event_schemas` entries, draft-number mismatches) only go to the
console and to the Stats page if its spec chooses to show them.

Diagnostic codes used by this subsystem (in addition to those owned by main-schema digest P6 to P14):
`trace.no-events` (info), `trace.event-fields-unsupported` (warning), `trace.reordered` (warning),
`trace.missing-vantage-point` (info), `event.not-object`, `event.missing-time`, `event.time-string`,
`event.name-without-namespace`, `event.missing-data` (warnings), `event.nonconforming-name` (warning, DM3; with up
to 5 sample names), `event.legacy-field` (warning, DM2; 9.6), `time.mixed-reference-times` (warning),
`time.legacy-reference-time` (warning), `time.unknown-epoch` (info), `file.no-traces` (info),
`file.missing-serialization-format` and `file.serialization-format-mismatch` (warnings). `event.alias-applied` is
**withdrawn** (no alias table, ARCHITECTURE §3.1).

---

## 7. Known bugs and quirks

| # | Quirk | qvis location | Decision |
|---|---|---|---|
| Q1 | Cursor parser: values change on the next `parseEvent`. Most sites copy values out in time (e.g. the congestion graph draw and hover loops), but the sequence diagram's unknown-vantage-point heuristic stores the cursor itself as `firstInitialSent` and `firstInitialReceived` (both are the same parser object, now pointing at the received event), so `firstInitialSent.absoluteTime < firstInitialReceived.absoluteTime` is always false and the guess is **always "server"** whenever both initials exist | `Connection.ts:103-105`; `SequenceDiagramD3Renderer.ts:497-526` | FIX the mechanism (per-event objects). The guess itself is the sequence-diagram spec's call: comparing real times flips client-side traces with unknown vantage points to the correct side (recommended FIX, visible change) |
| Q2 | `lookup()` returns `[]` silently if `setupLookupTable()` was not called first | `Connection.ts:154-161` | FIX (eager index) |
| Q3 | Lookup table is built once and never invalidated (sorting or renames after the first build are not reflected) | `:126-129` | FIX (built after sort; clones build their own) |
| Q4 | Only the last empty `{}` event is removed in non-split traces | `QlogLoaderV2.ts:123-127` | FIX (skip all) |
| Q5 | Zero-event or missing `events` traces crash the loader (`lastEvent.length` on `undefined`), whole file lost, success toast still shown on upload | `QlogLoaderV2.ts:121-125` | FIX |
| Q6 | Delta conversion mutates times in place, is re-applied when the parser is re-created after sorting, and with `reference_time` event 1 is computed from the reference instead of event 0; EventFieldsParser concatenates strings (`+=`) | `QlogLoaderV2.ts:461-496`, `QlogLoader.ts:880` | FIX (decode once, spec semantics) |
| Q7 | Order check starts at `minimumTime = -1`: traces with first `absoluteTime < -1` always trigger the alert | `QlogLoaderV2.ts:158-171` | FIX |
| Q8 | `vantagePoint` is shared by reference between the JSON and all `group_id` slices; the sequence diagram's rename of an unknown vantage point (2.3) therefore renames every slice and leaks into export | `QlogLoaderV2.ts:138`, `SequenceDiagramD3Renderer.ts:528` | FIX sharing (own copy per slice); PRESERVE the rename itself on the selected connection (it is user-visible information) |
| Q9 | `group_id` split decided by the first event only; missing ids give `"Group undefined : "` | `QlogLoaderV2.ts:80-112` | FIX (3.16.5) |
| Q10 | `clone()` registers the clone in the parent group (constructor side effect) | `Connection.ts:56` | PRESERVE (generated traces are selectable, and the sequence configurator logic relies on it) |
| Q11 | `getShorthand()` counts generated clones and ERROR placeholders, so the file list changes from `(1 connection)` to `(2 connections)` after viewing a single trace in the sequence diagram | `ConnectionGroup.ts:52-57` | FIX recommended: count `getRealConnections()` (decision D5; strict parity keeps the qvis count) |
| Q12 | Enumerable `timeText` written on raw events: appears in the event-detail modal JSON and in downloads for object events | `SequenceDiagramD3Renderer.ts:852` | FIX (`ext`, modal shows `raw`) |
| Q13 | `commonFields` can be `undefined`; `clone()` turns `undefined` into `[]` | `QlogLoaderV2.ts:146`, `Connection.ts:61` | FIX (`{}` default) |
| Q14 | Congestion graph never resets `qvis.congestion`; `correspondingPackets` of loss events grows on every re-render; first-render ACK links persist | `CongestionGraphD3Renderer.ts:1374-1394` | FIX (reset per pass) |
| Q15 | Packetization mutates raw data (`raw.length = raw.data.length` = hex characters, i.e. double the bytes; frame sizes; filler frame inserted repeatedly); the filler then needs a sequence-diagram special case | `PacketizationQUICPreProcessor.ts:226-325` | FIX (side data; correct hex length = `raw.data.length / 2`, decision for the packetization spec) |
| Q16 | `group.summary` is never populated, so the Stats `Summary` row never appears | `QlogLoaderV2.ts:39-43` | PRESERVE (summary no longer exists in -14) |
| Q17 | Removing a group does not clear view selections that reference it | `ConnectionStore.ts:44-51` | FIX |
| Q18 | ERROR placeholder has no parser: multiplexing and packetization throw when it is selected (also the default selection if the first trace is an error) | `QlogLoaderV2.ts:52-55`, `MultiplexingGraphD3CollapsedRenderer.ts:151-155` | FIX (valid empty connection) |
| Q19 | `DirectEventParser` does not lower-case; `EventFieldsParser` does | `QlogLoaderV2.ts:331-363` | PRESERVE no lower-casing |
| Q20 | Stats Title row condition `connection.title && connection.title > 0` never true for text titles | `StatisticsConnectionRenderer.vue:7` | Stats spec decides; recommended FIX (`title.length > 0`) |
| Q21 | `parseReferenceTime` treats any string containing `"-"` as a date (negative numbers included) | `QlogLoaderV2.ts:528-541` | DROP (object `reference_time`) |
| Q22 | `setReferenceTime` on an ABSOLUTE trace changes `absoluteTime` but not `getAbsoluteStartTime()` | `QlogLoaderV2.ts:509-514` | FIX (only RELATIVE) |
| Q23 | Clones share the original's parser, so `setReferenceTime` on one affects both | `Connection.ts:68` | FIX (copied timing) |
| Q24 | Sequence-diagram click handler precedence: `(wasAutoGenerated && name === packet_sent) \|\| name === packet_received` | `SequenceDiagramD3Renderer.ts:84-86` | Harmless: only `packet_sent` events ever get a `rightTarget` (3.13), so the extra `packet_received` branch never switches events. PRESERVE the effective behaviour (sequence-diagram spec) |
| Q25 | `connection.getEvents()` exposes the mutable internal array; VUEDebug splices it | `Connection.ts:111` | FIX (readonly array type) |

---

## 8. Porting notes for React

### 8.1 Module breakdown

```
src/model/
  names.ts               NS = {quic, http3, http, loglevel, simulation}; QUIC.* / HTTP3.* / LOGLEVEL.* type constants;
                         fullName helpers. Replaces data/QlogSchema02.ts enums (event part only).
  types.ts               raw input types (main-schema digest section 23), VantagePoint, EventPointer, Diagnostic
  (no aliases.ts)        withdrawn by ARCHITECTURE §3.1; non-conforming-name and legacy-field detection (9.1, 9.6)
                         live in QlogLoader.ts and use the generated constants in names.ts
  time.ts                parseRfc3339Ms, epochMsOf, resolveTimes(events), ConnectionTiming (3.16.3)
  QlogEvent.ts           class QlogEvent
  QlogConnection.ts      class QlogConnection (+ getLongName, perspective, clone, lookup)
  QlogConnectionGroup.ts class QlogConnectionGroup (+ getShorthand)
  QlogLoader.ts          fromJSON(loaded) -> group | undefined (3.16.2), pure, no DOM
  diagnostics.ts         Diagnostics collector (dedupe by code), toast builders DM1/DM2
  labels.ts              connectionOptionLabel(c), groupOptionLabel(g), seqHeaderVantageText(c), statsVantageText(c)
  modelEvents.ts         tiny emitter for in-place changes (3.16.11)
  index.ts
src/store/
  connectionStore.ts     groups, outstandingRequests, revision, addGroup/removeGroup (file-loading 8.2)
  viewConfigStore.ts     per-view selections (ConfigurationStore equivalent), cleared on removeGroup
```

### 8.2 React integration rules

- Keep model instances as plain class instances in zustand; never `structuredClone`, freeze, or proxy them.
- Components read `groups` and `revision`; derive option lists with `useMemo([groups, revision])`.
- D3 renderers stay imperative classes (as in qvis) that receive `QlogConnection` objects and read
  `getEvents()`, `lookup()`, `ev.relativeTime` in loops; the React wrapper owns the DOM container, calls
  `render(connection(s), config)` in an effect keyed on the selection and `revision`, and disposes listeners.
- The default-selection logic of each configurator (2.5) becomes a small hook
  `useDefaultSelection(view)` that runs when the selection is empty and `groups.length > 0`.
- Generated clones: created by the sequence-diagram renderer through `connection.clone(transform)`; the emitted
  change bumps `revision` so selectors show the `GENERATED` entry (PARITY).

### 8.3 Performance budget

- One `QlogEvent` per event (about 12 fields plus a prototype). For the 31 MB "massive" demo this is the dominant
  cost after `JSON.parse`; keep the constructor monomorphic (assign every field, in the same order, always).
- `relativeTime` / `absoluteTime` are getters over `resolvedTime` (no per-event recomputation on
  `setReferenceTime`).
- `data` is always shared with `raw.data` (no fix-ups, ARCHITECTURE §3.1).
- Index building, sorting check and splitting are single passes; sort only when needed.
- Target: `fromJSON` time no more than about the `JSON.parse` time for the same file (measure in a vitest bench
  with a generated 200k-event trace).

### 8.4 Consumer port checklist (every shipped consumer)

| Consumer | Model APIs used in qvis | Port notes |
|---|---|---|
| `shared/ConnectionConfigurator.vue` | `allGroups[*].{filename,title,description,getConnections()}`, `connection.{parent,title,description,vantagePoint.{name,type,flow}}`, identity comparisons | `labels.ts`; selector spec in app-shell 2.5 |
| `sequencediagram/SequenceDiagramConfigurator.vue` | `store.groups`, `outstandingRequestCount`, `wasAutoGenerated`, `getEvents().length`, `vantagePoint.type`, `parent.getConnections()` (+ `.filter(!wasAutoGenerated)`, `indexOf`), `getVantagePointPerspective()` | unchanged API |
| `sequencediagram/data/SequenceDiagramConfig.ts` | `getEventParser().timeOffset` | `conn.timing.timeOffset` (0) |
| `sequencediagram/SequenceDiagramRenderer.vue` | `connections[0].connection.getEvents().length`, raw event JSON for the modal, `event.qvis.sequencediagram.focusInfo`, `parent.URL` | modal prints `ev.raw`; `ev.ext.sequence.focusInfo` |
| `sequencediagram/renderer/SequenceDiagramD3Renderer.ts` | `getEvents`, `parseEvent` (`name`, `category`, `data`, `relativeTime`, `absoluteTime`, `timeToMilliseconds`), `getEventParser()` (`load`, `timeOffset`, `getAbsoluteStartTime`, `getTimeTrackingMethod`, `setReferenceTime`), `setupLookupTable`, `lookup`, `clone`, `wasAutoGenerated`, `title`/`description`/`vantagePoint` writes, `parent.{URL,URLshort,filename}`, raw and connection annotations | `QlogEvent` fields, `conn.timing`, `conn.clone(transform)`, `ext` |
| `sequencediagram/renderer/SequenceDiagramCanvasRenderer.ts` | clone, renames, `relativeTime`, annotations | DEAD: do not port |
| `sequencediagram/SequenceDiagramSimpleRenderer.vue` | `connection.name` (does not exist), `parseEvent().time` (does not exist), `.trigger` | DEAD: do not port |
| `congestiongraph/CongestionGraphConfigurator.vue` | `store.groups`, `outstandingRequestCount`, `vantagePoint.{type,flow}` (`isClientSideTrace`, only used by a commented-out button), `groups[0].getConnections()[0]` | unchanged |
| `congestiongraph/CongestionGraphRenderer.vue` | `config.connection` (deep watch) | effect keyed on selection + `revision` |
| `congestiongraph/renderer/CongestionGraphD3Renderer.ts` | `getEvents()[0]` + `relativeTime` (start offset), `setupLookupTable`, five `lookup`s, `parseEvent` (`data`, `relativeTime`, `timeToMilliseconds`), `commonFields.protocol_type`, raw annotations | `lookup(NS.quic, ...)`, `protocolHint`, `ext.congestion` |
| `stats/StatisticsConfigurator.vue` | `store.groups`, `outstandingRequestCount`, `groups[0]` | unchanged |
| `stats/StatisticsRenderer.vue` | `group.{filename,title,description,version,summary,getConnections()}`, `wasAutoGenerated`, `getEvents().length` | `getRealConnections()`; `version` is now the file schema |
| `stats/StatisticsConnectionRenderer.vue` | `title`, `description`, `vantagePoint.*`, `getEvents()` (+ length), `getLookupTable()`, `setupLookupTable`, `lookup(http, ...)`, `parseEvent` (`data`, `category`, `name`, `relativeTime`) | namespaces in the histogram (`quic`, `http3`, `loglevel`, ...) |
| `multiplexinggraph/MultiplexingGraphConfigurator.vue` | `store.groups`, `getConnections()`, `parent.filename` sort, `groups[0].getConnections()[0]` | unchanged |
| `multiplexinggraph/MultiplexingGraphRenderer.vue` | `config.connections` | unchanged |
| `multiplexinggraph/MultiplexingGraphCollapsedRenderer.vue` | `parent.filename`, `getLongName()` | unchanged |
| `multiplexinggraph/renderer/MultiplexingGraphD3WaterfallRenderer.ts` | `setupLookupTable`, `vantagePoint.type`, `getEvents`, `parseEvent` (`name`, `data`, `relativeTime`) | `ev.type`, field renames (4.3) |
| `multiplexinggraph/renderer/MultiplexingGraphD3CollapsedRenderer.ts` | `setupLookupTable`, `getEventParser().load(first/last).absoluteTime` (log only; crashes on ERROR placeholders), `vantagePoint.type`, `getEvents`, `parseEvent` | drop the log computation or use `timeRange()`; `quic:stream_data_moved` |
| `multiplexinggraph/renderer/MultiplexingGraphD3SimulationRenderer.ts` | `setupLookupTable`, `getEventParser`, `lookup(http, ...)` | DEAD (FIFO lane hidden and renderer not instantiated) |
| `multiplexinggraph/renderer/MultiplexingGraphD3ByterangesRenderer.ts` | declares `connection` but uses derived arrays only | no model API |
| `packetizationdiagram/PacketizationDiagramConfigurator.vue` | `store.groups`, `group.filename.indexOf("DEMO")`, `getConnections()`, `groups[0].getConnections()[0]` | unchanged |
| `packetizationdiagram/PacketizationDiagramRenderer.vue` | `connections[0].getEvents().length` | unchanged |
| `packetizationdiagram/renderer/PacketizationDiagramD3Renderer.ts` | `setupLookupTable`, `commonFields.protocol_type === "TCP_HTTP2"`, `vantagePoint.type` | `protocolHint` |
| `packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts` | `vantagePoint.type`, `getEvents`, `parseEvent` (`name`, `data`), raw mutations | `ext.packetization`, renames (4.3) |
| `packetizationdiagram/renderer/PacketizationTCPPreProcessor.ts` | `vantagePoint.type`, `getEvents`, `parseEvent` | reachable through the ported tshark converter (ARCHITECTURE §0): `tcp:`/`tls:`/`http2:` names (9.10) |
| `filemanager/FileManagerContainer.vue` | `store.groups`, `group.{URL,URLshort,filename,getShorthand()}`, `removeGroup`, `Convert01to02(group)` (reads `title`, `description`, `summary`, `version`, `wasAutoGenerated`, `vantagePoint`, `title`, `description`, `configuration`, `commonFields`, `eventFieldNames`, `getEvents()`), `filename` checks for demo files | export via `rawTrace` / `ev.raw` (file-loading 3.11) |
| `filemanager/**` converters, `FileLoader.ts`, `StreamingJSONParser.ts` | none (produce JSON) | |
| `views/VUEDebug.vue` | `store.groups`, `deleteGroup`, `DEBUG_LoadRandomFile`, `getConnections`, `getEvents`, `parseEvent().name`, title and raw mutations | app-shell 2.7 decides; needs a debug-only group factory |
| `App.vue` | `store.loadFilesFromServer(query)` | file-loading |

### 8.5 What stays imperative

Nothing in this subsystem uses D3. The only imperative contract is that renderers read the model synchronously
and write only to `ext` slots and through the explicit mutators (`clone`, `setTitle`, `setDescription`,
`setVantagePoint`, `timing.setReferenceTime`) that emit change events.

### 8.6 Tests (vitest)

Fixtures (hand-written -14 files, tiny):

1. Contained file, one client trace, `relative_to_epoch` with dated epoch (case R): `relativeTime === time`,
   `absoluteTime === epochMs + time`, start = epoch.
2. Same without `reference_time` and Unix-ms times (case A): relative from first event.
3. `epoch: "unknown"`, monotonic (case U): relative from first event, absolute start 0; `setReferenceTime(1000)`
   shifts `absoluteTime` by 1000.
4. `relative_to_previous_event` with an out-of-order delta (negative): decoded once, then stable-sorted, DM1
   diagnostic, equal times keep logged order.
5. Per-event `time_format` mix.
6. `group_id` per event with two values and one event without: three slices in first-seen order, titles
   `"Group a : T"`, `"Group b : T"`, `"Group (no group_id) : T"`; delta decoding across slices uses file order.
7. `group_id` only in `common_fields`: no split, no prefix.
8. TraceError with and without `uri`; vantage point defaults; zero-event trace.
9. Event name without colon, missing name, missing data, `{}` events in the middle.
10. No alias normalization (ARCHITECTURE §3.1): `transport:packet_sent` and `quic:metrics_updated` (with `cwnd`)
    keep their logged names (`namespace` `transport` / `quic`, `type` `packet_sent` / `metrics_updated`),
    `data === raw.data`, `lookup("quic", "packet_sent")` and `lookup("quic", "recovery_metrics_updated")` are empty,
    and one `event.nonconforming-name` diagnostic (count 2, both samples) produces DM3. More cases in 9.14.
11. Lookup order equals first-seen order; `getLookupTable()` namespaces.
12. `getLongName()` and `getShorthand()` exact strings (table in 3.3.4 and 3.2.2).
13. `clone(transform)`: registered in parent, own index with swapped types, `ignoreseq`, raw shared, `ext`
    independent, change event emitted.
14. Export round trip (with file-loading): raw objects unchanged after a full render cycle of every view.

### 8.7 Open decisions (with recommendations)

| Id | Decision | Recommendation |
|---|---|---|
| D1 | Keep `category`/`name` aliases on `QlogEvent` to ease porting | No: use `namespace`/`type` so half-ported comparisons fail loudly in TypeScript (category values changed anyway). Provide only `parseEvent()` identity and `getEventParser()` shims. |
| D2 | `group_id` split rule | Parity rule in 3.16.5 (split whenever events carry their own `group_id`), not the main-schema digest's "more than one value" rule. |
| D3 | Case U normalization (relative and absolute from the first event) | Yes (matches main-schema digest P12). |
| D4 | Heuristic "epoch default but tiny times" means case U | Off by default (parity); revisit if real files misalign in the sequence diagram. |
| D5 | `getShorthand()` connection count | Count real connections (FIX Q11). |
| D6 | Alias table for intermediate event names | **Reversed by ARCHITECTURE §3.1: off.** No name aliasing and no data fix-ups; non-conforming names raise `event.nonconforming-name` (DM3) and legacy members raise `event.legacy-field` (DM2). Section 9 is the porting map. |
| D7 | Show diagnostics in Stats | Up to the Stats spec; the model exposes `group.diagnostics`. |
| D8 | `group.version` display value | `fileSchema`; the Stats spec may render `fileSchema + " (" + serializationFormat + ")"` under the verbatim label `qlog version`. |
| D9 | TCP traces from the ported tshark converter | `transportNamespace` + `protocolHint` derivation (9.10), so the views qvis ran on TCP traces keep working. |
| D10 | Vantage-point guess when Initials carry no `packet_number` | Recommended FIX (9.9): fall back to "first Initial sent before first Initial received". Owned by the sequence-diagram spec (Q1). |

---

## 9. Mapping to latest qlog drafts

This section maps **every** old-schema (qlog draft-02 / `qlog_version` "0.3" and older) file, trace and event
member that this subsystem reads, and every lookup key, event-type check and category check that its consumers make
through the model (section 4), to the latest drafts:

- draft-ietf-quic-qlog-main-schema-14 (digest `qlog-spec/main-schema.md`, section 27 is the old-vs-new diff),
- draft-ietf-quic-qlog-quic-events-13 (digest `qlog-spec/quic-events.md`, section 13),
- draft-ietf-quic-qlog-h3-events-13 (digest `qlog-spec/h3-events.md`, section 10).

The digests hold the CDDL and the full per-event field tables. This section owns names, paths, absence semantics and
the model's behaviour; the view specs (sequence-diagram, congestion-graph, multiplexing-graph, packetization,
stats) own how a member is rendered.

### 9.1 Ground rules (normative)

1. **Targets.** -14 / -13 / -13, plus the editor's copies where they do not conflict (ARCHITECTURE §0). The union
   points that touch this subsystem and its consumers:

   | -14 / -13 | Editor's copy | Rule |
   |---|---|---|
   | `quic:frames_processed` exists | removed | accept; it is a normal event (Stats counts its frames, 4.2) |
   | `datagram_id` (packet events), `datagram_ids` (UDP events) | `datagram_payload_checksum`, `datagram_payload_checksums` | read both (`coalescingKey`, 9.12 N4) |
   | `packet_dropped.trigger: "key_unavailable"` | `"keys_unavailable"` | both; display raw |
   | `PacketHeader.length` (long-header Length field) | removed | never use it as the packet size |
   | `ip_v4`/`port_v4`/`ip_v6`/`port_v6` | `address_v4`/`address_v6` (`{ip, port}` or a redacted string) | both; display only |
   | `recovery_parameters_set.reordering_threshold: uint16` | `uint16 / "disabled"` | both |
   | `ecn_state_updated` without `trigger` | with `trigger` | both |
   | `http_early_response` | `http_message_error` | both |
   | H3 `extended_connect`, `h3_datagram`: uint16 | uint64, plus `unknown_settings` | both |
   | main-schema ordering "strictly ascending" | "non-decreasing", stable sort | editor's copy (3.16.7) |

2. **No runtime aliasing, no data fix-ups** (ARCHITECTURE §0 and §3.1, which reverse D6 and 3.16.4 steps
   2-lenient/3/5). `QlogEvent.fullName === loggedName`; `namespace` and `type` are the logged name split at the
   first colon; `data === raw.data`. The "Old" columns below are for **porting qvis code**, never for rewriting
   input. A -14 file that still uses pre-final names (for example current quic-go output: `file_schema` plus
   `transport:packet_sent`, `recovery:metrics_updated`) loads normally: its events keep their logged namespace,
   appear in the Stats histogram and in raw JSON views, are not found by the views' lookups, and raise
   `event.nonconforming-name` (DM3, 6.3). Non-conforming means: namespace `transport`, `recovery`, `security`,
   `connectivity`, `qpack`, or `http` with a type other than `capsule_created`/`capsule_parsed` (each unless the
   trace's `event_schemas` lists `urn:ietf:params:qlog:events:<that namespace>` with any `-NN` suffix or fragment,
   ARCHITECTURE §3.1 item 2), or namespace `quic`/`http3` with a type not defined by quic-events-13 / h3-events-13
   (constants generated into `names.ts`).
   `loglevel`, `simulation`, converter namespaces (`tcp`, `tls`, `http2`) and any other custom namespace are never
   flagged (custom namespaces are legal, main-schema-14 §8). Clones are not loaded, so `ignoreseq` is never flagged.
3. **Matching.** Consumers compare `namespace` and `type` against `names.ts` constants (`NS.quic`,
   `QUIC.packet_sent`, ...). Every qvis "type-only" check (4.2) becomes a full-name check with the namespaces given
   in 9.7 and 9.8. The only multi-namespace cases are converter traces (9.10).
4. **uint64.** Any uint64 member may be a JSON number or a decimal string (main-schema-14 §11.3). The model never
   coerces `data`. Consumers keep qvis's `"" + x` equality and `parseInt(x, 10)` / `parseFloat(x)` arithmetic, or
   use `toNumber()` from `src/qlog/uint64.ts`. Precision loss above 2^53 is acceptable for plotting.
5. **Absence is normal.** Nearly every data member is optional in the CDDL, and producers omit even required ones
   (quic-events digest section 2). The model never throws on a missing member and never writes a default into
   `data`. Each table below says what happens when the event or the member is absent.
6. **Time values are milliseconds everywhere** (main-schema-14 §1.2): `time`, RTTs, `delta`, `ack_delay`,
   `initial_rtt`, `max_ack_delay`. `timeToMilliseconds(x)` is `parseFloat(x)`; no unit scaling exists.

Tags as in the legend, plus **NONE**: no equivalent in the latest drafts (the row gives the behaviour).

### 9.2 File level

| Old (qvis) | Model field | Latest (main-schema-14) | Semantic differences | When absent or invalid | Tag |
|---|---|---|---|---|---|
| `qlog_version`, dispatch on `"0.1"`, `"draft-00"`, `"draft-01"`, `"draft-02-wip"`, `"draft-02"`, `"draft-02-RC1"`, `"qlog-03-WIP"`, `"0.3"` (3.8) | `group.version` (Stats `qlog version` row) | `file_schema` (required absolute URI): `urn:ietf:params:qlog:file:contained` \| `urn:ietf:params:qlog:file:sequential` | No version number exists. The file schema names the container; the event vocabulary version is the `-NN` suffix of each `event_schemas` URI (`urn:ietf:params:qlog:events:quic-13`). `group.fileSchema = group.version = ` the `file_schema` string (D8). A header with **both** `file_schema` and `qlog_version`/`qlog_format` (quic-go) is a -14 file: `file_schema` wins, the legacy members are ignored (kept in `LoadedQlog.root`). `qlog_version` without `file_schema` never reaches the model (`LegacyQlogError`, toast X1, file-loading). | Missing: warning `file.missing-file-schema`; the parser infers contained (`traces`) or sequential (`trace`), and `fileSchema`/`version` hold the inferred URI. Unknown URI: warning `file.unknown-file-schema`; loaded when `traces`/`trace` exists; `version` shows the logged URI. | FIX (dispatch DROP) |
| `qlog_format` (`"JSON"` \| `"NDJSON"` \| `"JSON-SEQ"`; `group.format = "" + qlog_format` or `"JSON"`) | `group.format`, `group.serializationFormat` | `serialization_format` (required, case-insensitive media type): `application/qlog+json` \| `application/qlog+json-seq` | NDJSON no longer exists. Stored as `value.split(";")[0].trim().toLowerCase()`. The bytes decide the framing (main-schema P3), never this member. Display-only mapping of the literals `json` / `json-seq` (quiche, neqo, quinn write `"JSON-SEQ"`) to the media types. | Missing: warning `file.missing-serialization-format`; `format` = the media type of `LoadedQlog.serialization` (the analogue of qvis's `"JSON"` default). Disagrees with the bytes: warning `file.serialization-format-mismatch`; the bytes win. | PARITY (values change) |
| `title`, `description` | `group.title`, `group.description` | same (optional text) | none | `""` | PARITY |
| `summary` | `group.summary` | **NONE** (removed in main-schema-06) | qvis never copied it (Q16) | always `{}`; the Stats `Summary` row never renders | NONE |
| `traces` (required) | `group.getConnections()` | `traces?: [+ Trace / TraceError]` (contained); `trace: TraceSeq` plus one record per event (sequential, normalized by the parser to `traces: [{...trace, events}]`) | `traces` is optional | Absent: group with zero connections, info `file.no-traces` (qvis: TypeError, file lost). Not an array: error, `fromJSON` returns `undefined`. The default-selection hook (8.2) skips groups without connections instead of selecting `undefined`. | FIX |
| (none) | — | extra top-level members (quic-go `code_version`, ...) | open map | kept in `LoadedQlog.root`; display only | NEW |

### 9.3 Trace level

| Old (qvis) | Model field | Latest | Semantic differences | When absent or invalid | Tag |
|---|---|---|---|---|---|
| `traces[].error_description`, `uri` | ERROR placeholder (`title`, `description`, `isError`, `traceError`) | `TraceError {error_description, uri?, vantage_point?}` | `uri` became optional; a TraceError may carry a `vantage_point` | Discriminate on `typeof error_description === "string"`. No `uri`: description = `error_description` (FIX, 2.2). No `vantage_point`: ctor default `{type: "unknown", flow: "unknown"}` without name (PARITY). | PARITY / FIX |
| `traces[].title`, `description` | `connection.title`, `description` | same | none | `""` | PARITY |
| `traces[].vantage_point.{name,type,flow}` | `vantagePoint`, `getVantagePointPerspective()`, labels | `vantage_point?: {name?, type, flow?}`; `type` ∈ `client` \| `server` \| `network` \| `unknown`; `flow` ∈ `client` \| `server` \| `unknown` | Optional now (was required). Same values and the same sent/received semantics (`flow: "client"`: a `packet_sent` travels towards the server); `flow` is only needed for `network`. | Missing, not an object or no `type`: `{type: "unknown", flow: "unknown", name: "No VantagePoint set"}` (PARITY; a provided `name` is kept, FIX). Values outside the enum (quic-go endpoint traces `"transport"`, msquic `"CLIENT"`): displayed verbatim, perspective `"unknown"` (no case folding). | PARITY |
| `configuration.time_units` (`"us"`: ×0.001) | parser multiplier, `timeToMilliseconds` | **NONE** (removed in main-schema-06) | all times are ms | `timeToMilliseconds = parseFloat` | NONE |
| `configuration.time_offset` (ms added to every time; `getEventParser().timeOffset`) | `timing.timeOffset` | **NONE** | qvis also used it as the initial sequence-diagram offset (`SequenceDiagramConfig.ts:20`) and, when non-zero, to skip automatic latency alignment (`SequenceDiagramD3Renderer.ts:599-603`) | Always `0`: the offset field starts at 0 and auto alignment is always eligible. That is what qvis did for every file without `time_offset` (all real-world files). Do not invent a replacement member. | NONE |
| `configuration.original_uris` | export only | **NONE** (closest: `TraceError.uri`) | — | not stored; the export writes no `configuration` (file-loading 3.11) | NONE |
| `common_fields.time_format`: `"absolute"` \| `"relative"` \| `"delta"` (trace-wide) | `timing.method`, `relativeTime`, `absoluteTime` | `time_format`: `"relative_to_epoch"` (default) \| `"relative_to_previous_event"`, in `common_fields` **or per event** | `absolute` = `relative_to_epoch` with the Unix epoch or no `reference_time` (case A, 3.16.3); `relative` + reference = `relative_to_epoch` + dated epoch (case R); `relative` without reference = `epoch: "unknown"` (case U); `delta` = `relative_to_previous_event` (first event relative to the epoch; base = the previous event's **resolved** time in file order). Formats may differ per event. | Absent: `relative_to_epoch`. Any other value, including the legacy literals `"absolute"`, `"relative"` and `"delta"`: treated as `relative_to_epoch`, warning `event.unknown-time-format` (main-schema P9; strict, no legacy mapping). | FIX |
| `common_fields.reference_time` (numeric Unix-ms string; seconds in draft-01 samples; date string) | `timing.absoluteShift`, `absoluteStart` | `reference_time: {clock_type: "system" \| "monotonic" \| text, epoch: RFC3339 \| "unknown", wall_clock_time?: RFC3339}`, in `common_fields` **or per event** | Object instead of a number. `epoch: "unknown"` (mandatory for monotonic clocks) has no qvis equivalent: case U. `wall_clock_time` is informational (9.12 N14), never used for alignment. | Absent everywhere: CDDL defaults (system clock, Unix epoch) = case A. Number or numeric string: epoch in ms (lenient, P9) + warning `time.legacy-reference-time`. Unparseable `epoch` or non-numeric string: case U + warning. | FIX |
| `common_fields.group_id` (ignored by qvis) | `connection.groupId` | `group_id` (text), common or per event | effective value = event, else common | Alone it never splits and never prefixes (3.16.5, PARITY); in a split trace it is the id of events without their own | PARITY |
| `common_fields.protocol_type` (`"TCP_HTTP2"`, `"TCP"`, `"QUIC_HTTP3"`) | `connection.protocolHint` | **NONE** (became `protocol_types` in main-schema-10, removed in -11 in favour of `event_schemas`) | — | still read as a custom common field when present; else derived (9.10) | NONE |
| `common_fields.category`, `common_fields.name` (`DirectEventParser` defaults; draft-00 `CATEGORY`/`EVENT_TYPE`) | category/name fallback | `category`: **NONE**. `name`: legal in the open `CommonFields` map | categories do not exist | `category` ignored. `name` through `eff(ev, "name")` (main-schema-14 §7.5: fields may be defined per event or in `common_fields`) | NONE / PARITY |
| `common_fields` (object, could be `undefined`) | `connection.commonFields` | `common_fields?`: open map with `tuple?`, `time_format?`, `reference_time?`, `group_id?` and custom keys (`odcid`) | any of these may also appear per event | `{}` (FIX Q13) | PARITY |
| `event_fields` (draft-01 CSV-like arrays, `EventFieldsParser`) | `eventFieldNames` | **NONE** (events are always objects) | — | array events skipped: `event.not-object` + `trace.event-fields-unsupported` once (the parser normally rejects such files first) | DROP |
| `events` (required; missing or empty crashed qvis, Q5) | `connection.getEvents()` | `events: [* Event]` (required, may be empty; separate records in JSON-SEQ) | — | missing: `[]` + warning; empty: info `trace.no-events` | FIX |
| (none) | `connection.eventSchemas`, `group.eventSchemas` | `event_schemas: [+ text]` (required, hint only) | — | missing or invalid: `[]` + warning `trace.missing-event-schemas`; disagreement with observed namespaces: infos only (P14) | NEW |

### 9.4 Event level (envelope)

| Old (qvis) | Model field | Latest | Semantic differences | When absent or invalid | Tag |
|---|---|---|---|---|---|
| `time` (unit by `time_units`, meaning by trace `time_format`) | `time`, `resolvedTime`, `relativeTime`, `absoluteTime` | `time: float64` ms (required) | meaning comes from the event's effective `time_format` and `reference_time` (3.16.3) | numeric string: `parseFloat` + `event.time-string` (once). Missing or NaN: previous resolved time (0 for the first), `malformed: ["time"]`, warning `event.missing-time` | FIX |
| `relative_time`, `delta_time` (event_fields columns) | — | **NONE** | — | — | DROP |
| `name` = `"category:type"` | `loggedName`, `fullName`, `namespace`, `type` | `name` = `"namespace:event_type"` (required) | split at the **first** colon (qvis kept `split(":")[1]`); categories map to namespaces as in 9.5, but the model does not rewrite them | missing: `eff(ev, "name")`, else `"unknown:unknown"` + warning. No colon: namespace `"unknown"`, type = whole name, warning `event.name-without-namespace` | FIX |
| `category` member (with `name` holding the type) | — | **NONE** | — | ignored (no `category + ":" + name` join); the event becomes `unknown:<name>` | DROP |
| `event`, `event_type` members (draft-00/01) | — | **NONE** | — | ignored | DROP |
| `data` | `data` | `data` (required object; `$ProtocolEventData`) | shapes changed per event (9.7, digests) | missing or non-object: `{}` (raw value kept in `raw`), warning `event.missing-data` | PARITY |
| `group_id` per event (split decided by the **first** event) | `groupId`, slicing | `group_id` per event or common (text) | split when **any** event carries its own (3.16.5) | non-string: `JSON.stringify` (PARITY). Events without an effective id in a split trace: slice `"(no group_id)"` | FIX |
| `trigger` as a top-level member (draft-01; read only by the DEAD `SequenceDiagramSimpleRenderer.vue:11`) | — | `data.trigger` (per-event-type string) | — | not modelled; views read `data.trigger` | DROP |
| (none) | `tuple` | `tuple: TupleID` (text, default `""`), per event or common | ties an event to a network path (4-tuple); was `path` in main-schema-08..12 | `""`. quic-go writes `tuple` inside `data`: not hoisted (no fix-ups); visible in the raw JSON | NEW |
| (none) | effective per event | `time_format`, `reference_time` per event | honoured (qvis ignored per-event values) | inherit from `common_fields`, then defaults | NEW |
| (none) | `raw.system_info` | `system_info: {processor_id?, process_id?, thread_id?}` | display only | — | NEW |
| custom members (`odcid`, ...) | `raw` | `* text => any` | display only; `eff(ev, k)` for consumers that want one | — | PARITY |

### 9.5 Categories to namespaces

| qvis category | Latest namespace | Type changes that matter to consumers |
|---|---|---|
| `transport` | `quic` | `datagrams_sent` / `datagrams_received` / `datagram_dropped` become `udp_datagrams_sent` / `udp_datagrams_received` / `udp_datagram_dropped`; `data_moved` becomes `stream_data_moved`; unchanged: `packet_sent`, `packet_received`, `packet_dropped`, `packet_buffered`, `parameters_set`, `frames_processed`, `stream_state_updated`; new: `version_information`, `alpn_information`, `parameters_restored`, `packets_acked`, `frames_created`, `frames_parsed`, `datagram_data_moved`, `*_data_blocked_updated`, `migration_state_updated`, `timer_updated` |
| `connectivity` | `quic` | unchanged: `server_listening`, `connection_started`, `connection_id_updated`, `spin_bit_updated`, `connection_state_updated`; new: `connection_closed`, `tuple_assigned`, `mtu_updated` |
| `security` | `quic` | `key_retired` becomes `key_discarded`; `key_updated` unchanged |
| `recovery` | `quic` | `metrics_updated` becomes `recovery_metrics_updated`; `parameters_set` becomes `recovery_parameters_set`; `loss_timer_set` / `loss_timer_triggered` / `loss_timer_updated` become `timer_updated`; unchanged: `packet_lost`, `congestion_state_updated`, `marked_for_retransmit`; new: `ecn_state_updated` |
| `http` (meant HTTP/3) | `http3` | unchanged: `parameters_set`, `stream_type_set`, `frame_created`, `frame_parsed`, `push_resolved`; `data_moved` becomes `quic:stream_data_moved`; `data_received`, `dependency_update`: **NONE**; new: `parameters_restored`, `priority_updated`, `datagram_created`, `datagram_parsed` |
| (none) | `http` | the latest `http` namespace is the **Capsule Protocol** only (`http:capsule_created`, `http:capsule_parsed`). Any other `http:*` name in a -14 file is a pre-final name (DM3), never HTTP/3. |
| `qpack` | **NONE** (removed in h3-events-06) | decoded headers live only in HEADERS / PUSH_PROMISE frames |
| `error` | `loglevel` | `connection_error`, `application_error`, `internal_error` become `loglevel:error {code?, message?}` (old `description` becomes `message`); connection-level errors are also `quic:connection_closed` |
| `warning` | `loglevel` | `internal_warning` becomes `loglevel:warning {code?, message?}` |
| `info`, `debug`, `verbose` | `loglevel` | `message` becomes `loglevel:info` / `loglevel:debug` / `loglevel:verbose` `{message}` |
| `simulation` | `simulation` | `marker {marker_type, message?}` becomes `simulation:marker {type?, message?}`; new `simulation:scenario {name?, details?}` |
| `transport` (TCP packets), `tls`, `http2` from qvis's TCP converter | `tcp`, `tls`, `http2` (private namespaces of the ported converter) | 9.10 |

`names.ts` (ARCHITECTURE §3.1 item 4) exports `NS = {quic, http3, http, loglevel, simulation, tcp, tls, http2}` and,
generated from the drafts, every quic-events-13 and h3-events-13 type plus `LOGLEVEL.*` and `SIMULATION.*`.

### 9.6 Draft-02 auto-fixes

qvis rewrote `data` in place (3.9 step 8). The members it moved do not exist in the drafts, and qvis-react never
rewrites `data`. To keep the user-visible part of qvis's compliance check (2.4: "non-compliant ... trace"), the
loader reports each pattern once per file, without fixing it:

| qvis auto-fix | Latest member | qvis-react behaviour | Diagnostic (`event.legacy-field`, warning, listed in DM2) |
|---|---|---|---|
| `data.header.packet_size` moved to `data.raw.length` | `data.raw.length` | not read: views see no packet size (the congestion graph counts the packet as "invalid size" and skips it) | `events had data.header.packet_size set; the qlog drafts use data.raw.length (example: <loggedName>)` |
| `data.header.payload_length` moved to `data.raw.payload_length` | `data.raw.payload_length` | not read | `events had data.header.payload_length set; the qlog drafts use data.raw.payload_length (example: <loggedName>)` |
| top-level `data.packet_type` moved to `data.header.packet_type` | `data.header.packet_type` | not read (no PN-space key, no Initial detection, not in the Stats encryption table) | `events had data.packet_type set; the qlog drafts use data.header.packet_type (example: <loggedName>)` |
| "Trace still uses event_fields ..." | — | `trace.event-fields-unsupported` | existing code |
| "Trace does not specify a qlog_format entry ..." | `serialization_format` | `file.missing-serialization-format` | existing code |

Checks run in the single load pass on every event whose `data` is an object (qvis checked every event too): three
property reads per event. `data.header.length` is a legal -13 member (the long-header Length field: packet number
plus payload): it is neither reported nor used as a size.

### 9.7 Lookups through the model: keys and members

Old `lookup(category, type)` becomes `lookup(NS.x, X.type)`; members are paths inside `data`.

| # | Old key (sites) | New key | Members read: old to latest | Semantic differences | Event or member absent | Tag |
|---|---|---|---|---|---|---|
| L1 | `transport:packet_sent` (Congestion :1081; Seq :494, :1104-1105; type-only elsewhere, 9.8) | `quic:packet_sent` | `header.packet_type`: same; `header.packet_number`: same (uint64, optional); `raw.length`: same; `frames[]`: same (`$QuicFrame[]`, optional) | `raw.length` = full packet size (header + payload + 16-byte AEAD tag for protected types). `frames` may be absent when the producer logs frames separately (`quic:frames_created` + `packet_numbers`, 9.12 N3). `is_coalesced` is gone (`datagram_id` / `datagram_payload_checksum`). New, not consumed: `trigger`, `is_mtu_probe_packet`, `supported_versions`, `stateless_reset_token`. | No events: each view's empty state or console message (P15). No `header`: skipped by PN logic (seq diagram logs `SequenceDiagram:calculateConnections : event data does not have the header field, which is required`, PARITY). No `packet_number`: no PN matching or linking (no error for `retry`, `version_negotiation`, `stateless_reset`, which never have one). No `raw.length`: the congestion graph skips it as "invalid size". | PARITY |
| L2 | `transport:packet_received` (Congestion :1082; Seq :495, :1105) | `quic:packet_received` | as L1; frames read by consumers: `ack.acked_ranges`, `max_data.maximum`, `max_stream_data.{stream_id,maximum}`, `stream.{stream_id,offset,raw.length,fin}` | `acked_ranges` = `[[from, to] \| [n], ...]`, inclusive, not necessarily ordered (the format qvis already handled), uint64. `trigger: "keys_available"` marks a packet already reported by `quic:packet_buffered` (do not sum both). | as L1 | PARITY |
| L3 | `recovery:packet_lost` (Congestion :1083) | `quic:packet_lost` | `header.packet_type`, `header.packet_number`: same (header optional, SHOULD carry both); `raw.length`: **NONE** (no `raw` on `packet_lost`) | match the sent packet on (PN space of `packet_type`, `packet_number`) and take the size from that `quic:packet_sent` (congestion-graph Q25). New: `frames?`, `is_mtu_probe_packet` (not a congestion signal), `trigger` (`reordering_threshold`, `time_threshold`, `pto_expired`). | no `header` or PN: no loss marker; the sequence label falls back to the type name `packet_lost` | PARITY (+ FIX for size) |
| L4 | `recovery:metrics_updated` (Congestion :1084; Seq :651, :674; type-only :112, :121, colour, label) | `quic:recovery_metrics_updated` | `cwnd`: **`congestion_window`** (`cwnd` is not a -13 member; the model never rewrites it; in-view fallbacks are the view spec's call, sequence-diagram SQ18); `bytes_in_flight`, `min_rtt`, `smoothed_rtt`, `latest_rtt`: same names | RTTs are float ms, never scaled. Events are **sparse**: only changed metrics, at least one per event; fold earlier events for the full state (as the seq-diagram click handler does). Removed: `max_ack_delay` (now only the `quic:parameters_set` transport parameter), `in_recovery` (use `quic:congestion_state_updated`). New: `rtt_variance`, `pto_count`, `ssthresh` (already in the seq label), `packets_in_flight`, `pacing_rate`. | absent member = unchanged since the previous event (carry forward, never 0). No events: no cwnd/RTT lines; the seq-diagram alignment falls back to the Initial packets. | PARITY |
| L5 | `transport:parameters_set` (Congestion :1085; Stats :466, :505 with category `transport`; Packetization :464 type-only) | `quic:parameters_set` | `owner`: **`initiator`** (`"local"` \| `"remote"`); `initial_max_data`, `initial_max_stream_data_bidi_local`, `initial_max_stream_data_bidi_remote`, `initial_max_stream_data_uni`: same names; `max_packet_size`: **`max_udp_payload_size`** | cumulative: several events per connection are normal; one initiator per event (local and remote MUST be separate events); an unmentioned setting is unchanged. `max_idle_timeout`, `max_ack_delay` are ms. | no `initiator`: matches neither side (qvis: no `owner` never matched), PARITY. Parameter absent: the congestion graph skips it (`if (data.initial_max_data)`, `CongestionGraphD3Renderer.ts:1099-1105`, PARITY); Stats pushes `parseInt(undefined, 10)` = NaN (`StatisticsConnectionRenderer.vue:466-470`, `:505-513`); the Stats spec decides (recommended FIX: skip the value). No `max_udp_payload_size`: packetization keeps its default 65527 (also the RFC 9000 default). | PARITY |
| L6 | `recovery:parameters_set` (type-only `parameters_set`: seq colour and label) | `quic:recovery_parameters_set` | key count only | `timer_granularity` required; `reordering_threshold` may be `"disabled"` | — | PARITY |
| L7 | `http:parameters_set` (type-only: seq colour and label) | `http3:parameters_set` | key count only (`owner` became `initiator`, `max_header_list_size` became `max_field_section_size`, `push_allowed` removed) | the count includes `initiator` and extension keys, as before | — | PARITY |
| L8 | `http:frame_created`, `http:frame_parsed` (Stats :321-322; DEAD Simulation :96; type-only in seq, multiplexing, packetization) | `http3:frame_created`, `http3:frame_parsed` | `stream_id`: same (uint64; the control stream for SETTINGS, GOAWAY, PRIORITY_UPDATE, ...); `frame.frame_type`: same; `frame.headers[].{name,value}`: `HTTP3HTTPField {name?, name_bytes?, value?, value_bytes?}` (read through `fieldName()` / `fieldValue()`, h3 digest 8.1); event-level `byte_length`: **`frame.raw.payload_length`** (`h3FramePayloadLength()`); event-level hex `raw`: `frame.raw.data`; PRIORITY_UPDATE `element_id` / `value`: **`stream_id`** (or `push_id`) / **`priority_field_value`**; GOAWAY `stream_id`: `id`; H3 unknown frame `raw_frame_type`: `frame_type_bytes` | not to be confused with `quic:frames_created` / `quic:frames_parsed` (QUIC frames, plural) | no `frame`: skipped (Stats `if (!evt.frame) continue`, PARITY). No payload length: packetization skips the frame with its console error (text updated to `frame.raw.payload_length`). | PARITY |
| L9 | type `data_moved`, any category (Multiplexing collapsed :463) | `quic:stream_data_moved` | `stream_id`: same (now optional); `offset`: same; `length`: **`raw.length`**; `from`, `to`: same (`$DataLocation` adds `"network"`) | new `additional_info: "fin_set" \| "stream_reset"`, with which `raw.length` may be 0 or absent; HTTP Datagram payloads use `quic:datagram_data_moved` (not consumed) | missing `stream_id`, `offset` or length: skipped (multiplexing spec) | PARITY |
| L10 | whole lookup table (Stats :47) | `getLookupTable()` | — | keys are namespaces and types **as logged**: `quic`, `http3`, `http`, `loglevel`, `simulation`, converter and custom namespaces, and pre-final ones such as `transport` in non-conforming files; first-seen order | — | PARITY |

### 9.8 Type-only name checks and category checks

qvis compared `parseEvent(e).name` (the type) and sometimes `.category`. qvis-react compares the **full** name.

| qvis check (sites) | Latest full name(s) | Semantic differences and notes |
|---|---|---|
| `packet_sent`, `packet_received` (Seq :85-86, :709-734, :1170, :1682-1683; Multiplexing waterfall :105-113, :243-315, collapsed :165-170, :407; Packetization :14-29, :213; Stats :474, :521 with category `transport`) | `quic:packet_sent`, `quic:packet_received` (`tcp:` for converter traces, 9.10) | the clone transform swaps the two types and keeps the namespace (3.16.10) |
| `metrics_updated` (Seq :112, :121, colour :1956, label :1994) | `quic:recovery_metrics_updated` | L4 |
| `parameters_set` (Seq colour :1957-1959, any category; label :2050-2063, by category; Packetization :464, any category; Stats :466, :505, category `transport`) | `quic:parameters_set` (label "transport parameters set"), `quic:recovery_parameters_set` ("recovery parameters set"), `http3:parameters_set` ("HTTP/3 parameters set") | the label is chosen by full name; the `"UNKNOWN parameters set"` branch is reached only by other `*:parameters_set` names (pre-final or custom), see the sequence-diagram spec. Packetization: only `quic:parameters_set` (FIX; qvis also matched the recovery and HTTP variants, harmlessly). |
| `connection_id_updated` (colour :1943) | `quic:connection_id_updated` | name only; data restructured (`src_*`/`dst_*` became `initiator` + `old`/`new`), not consumed |
| `spin_bit_updated` (colour :1946; label :1990, `state`) | `quic:spin_bit_updated` | `state: bool` unchanged; SHOULD be logged only on change |
| `connection_state_updated` + `data.new` (colour :1949-1954 for `closed`/`draining`; label :2078) | `quic:connection_state_updated` | old enum `attempted, reset, handshake, active, keepalive, draining, closed` (`QlogSchema02.ts:267-275`); latest Base `attempted, handshake_started, handshake_complete, closed`, Granular `peer_validated, early_write, handshake_confirmed, closing, draining, closed`, custom strings allowed (display raw). `closed` and `draining` still exist, so the colour rule works unchanged; `closing` is new (sequence-diagram spec decides; PARITY keeps the two values). `handshake`, `active`, `reset`, `keepalive` have no latest value. |
| string `"loss_timer_updated"` (colour :1960; label :2082-2097) | `quic:timer_updated` | `timeout` became `delta` (float ms from this event's time); `event_type` `set` \| `expired` \| `cancelled` (same); `packet_number_space` same; `timer_type` extended (`ack`, `pto`, `loss_timeout`, `path_validation`, `handshake_timeout`, `idle_timeout`, custom such as quic-go `path_probe`); new `timer_id`. The draft-01 enum values `loss_timer_set` / `loss_timer_triggered` were never checked by any view. |
| `datagrams_sent`, `datagrams_received` (colour :1967-1968) | `quic:udp_datagrams_sent`, `quic:udp_datagrams_received` | name only; data: `byte_length` became `raw[i].length` (array, UDP payload only), `count`, sticky `ecn[]`, `datagram_ids[]` (editor's copy `datagram_payload_checksums[]`) |
| `frame_created`, `frame_parsed` (Seq colour :1963-1964, label :2122-2198; Multiplexing waterfall :107-113, :162; Packetization :15-28, :408, :452) | `http3:frame_created`, `http3:frame_parsed` (`http2:` for converter TCP traces, 9.10) | L8 |
| `data_moved` (Multiplexing collapsed :463) | `quic:stream_data_moved` | L9 |
| `packet_lost` (label :2099) | `quic:packet_lost` | L3 |
| `congestion_state_updated` (label :2113) | `quic:congestion_state_updated` | `new` is free text (quic-go: `slow_start`, `congestion_avoidance`, `recovery`, `application_limited`); new `trigger` |
| `ignoreseq` (Seq :1371; clone-only) | `<original namespace>:ignoreseq` | qvis-internal type made by the clone transform (3.16.10); never a draft name, never loaded, never flagged; a selected clone's Stats histogram lists it (PARITY) |
| label types `info`, `debug`, `warning`, `error`, `verbose`, `connection_error`, `internal_error`, `application_error`, `internal_warning`, `marker`, `message`, printed as `category + ": " + data.message` (:2201-2216) | `loglevel:error`, `loglevel:warning`, `loglevel:info`, `loglevel:debug`, `loglevel:verbose`, `simulation:marker` | the level moved from the category into the type. Label prefix = `type` for `loglevel:*` (reproduces the old `"info: ..."` / `"error: ..."` text) and `"simulation"` for `simulation:marker`. `message` is optional on `loglevel:error` / `loglevel:warning`; without it the type name is shown, as qvis did. Old error-category events carried `description`, so qvis showed only their type; the new ones carry `message`. `simulation:scenario` (new) takes the default branch (`scenario`). |
| category `error` (colour :1971) | `loglevel:error` | test `namespace === "loglevel" && type === "error"` |
| category `warning` or `simulation` (colour :1974) | `loglevel:warning`; namespace `simulation` (`marker`, `scenario`) | |
| category `debug`, `info`, `verbose` (colour :1977) | `loglevel:debug`, `loglevel:info`, `loglevel:verbose` | |
| category `transport` + type (Stats :466, :474, :505, :521) | namespace `quic` (or `transportNamespace` for the packet events, 9.10) + type | |
| DEAD: `FileManagerContainer.vue:546-551`, `SequenceDiagramCanvasRenderer.ts:56-61`, `SequenceDiagramSimpleRenderer.vue:11`, `MultiplexingGraphD3SimulationRenderer.ts:91-96` | — | not ported |

### 9.9 Header fields used for model-level heuristics

| Old | Latest | Used for | Differences | When absent |
|---|---|---|---|---|
| `data.header.packet_type` | same path; `$PacketType`: `initial`, `handshake`, `0RTT`, `1RTT`, `retry`, `version_negotiation`, `stateless_reset`, `unknown` (+ `packet_type_bytes` for `unknown`) | Initial detection (vantage guess, latency alignment), arrow and ACK matching keys (type + PN), Stats encryption table (any event with a header) | same values and casing as qvis. The PN space is not logged: `initial` gives initial, `handshake` gives handshake, `0RTT` and `1RTT` give application_data. | it is the only required PacketHeader member; a header without it never matches and is not counted |
| `data.header.packet_number` | same path; uint64, **optional**, number or decimal string | vantage guess (`"" + pn === "0"` on an Initial, `SequenceDiagramD3Renderer.ts:497-526`), latency alignment (`firstInitialReceivedPN`, default `"0"`, `:703-740`), `focusOnPN` (`"" + pn === "" + focus`, only when `pn` is truthy, `:1162-1180`), arrow matching (same `packet_type` and `"" + pn` equal, `:1038-1063`) | qvis's string comparisons work unchanged for numbers and strings | never present on `retry`, `version_negotiation`, `stateless_reset`. If a producer omits it on Initials, the vantage guess finds no PN-0 Initial and answers `"server"` (PARITY default). Recommended FIX (D10): fall back to the first `quic:packet_sent` Initial vs. the first `quic:packet_received` Initial regardless of PN (main-schema-14 §6: "the client always sends the first packet"). |
| (none) | `header.length` (-13 only) | — | long-header Length field (packet number + payload), **not** the packet size; removed in the editor's copy | never used for sizes |
| (none) | `header.{spin_bit, key_phase, key_phase_bit, packet_number_length, token, version, scil, dcil, scid, dcid}` | — | not consumed by any view (raw JSON only) | — |
| (none) | `datagram_id` (-13) / `datagram_payload_checksum` (editor's copy) on packet events | — | equal `datagram_id` = coalesced into one UDP datagram (trace-local); the checksum is a CRC32c of the UDP payload and can match the same datagram **across** client and server traces | optional `coalescingKey()` (9.12 N4); not used for parity |

### 9.10 Converter namespaces, `protocolHint` and `transportNamespace` (D9)

qvis's TCP converter wrote TCP packets under category **`transport`** (`pcapconverter/qlog_tcp_tls_h2.ts:3-7`:
`EventCategory.tcp = "transport"`), plus `tls:record_*` and `http2:frame_*`, with `common_fields.protocol_type:
"TCP_HTTP2"` (`tcptoqlog.ts:69`). So `lookup(transport, packet_sent)` returned TCP packets, and the sequence diagram,
the congestion graph and Stats worked on TCP traces, while the packetization diagram branched on `protocol_type ===
"TCP_HTTP2"` (`PacketizationDiagramD3Renderer.ts:119`). The netlog converter writes `protocol_type: "QUIC_HTTP3"`
(`netlogtoqlog.ts:878`).

The ported converters emit `quic:`/`http3:` for QUIC and `tcp:packet_sent` / `tcp:packet_received`,
`tls:record_created` / `tls:record_parsed`, `http2:frame_created` / `http2:frame_parsed` for TCP (ARCHITECTURE §0).
To keep TCP parity:

1. `protocolHint` (3.16.6): `common_fields.protocol_type` when it is a string (the TCP converter SHOULD keep
   writing `"TCP_HTTP2"` there; `CommonFields` is an open map), else from the observed namespaces: `tcp` and `http2`
   give `"TCP_HTTP2"`, `tcp` alone gives `"TCP"`, `quic` or `http3` (or a quic/http3 `event_schemas` entry) give
   `"QUIC_HTTP3"`, otherwise `"unknown"`.
2. `transportNamespace = (protocolHint === "TCP_HTTP2" || protocolHint === "TCP") ? "tcp" : "quic"`. Views that
   looked up `transport:packet_*` in qvis use `lookup(conn.transportNamespace, QUIC.packet_sent)` and compare
   `ev.namespace === conn.transportNamespace` (sequence diagram arrows and vantage logic, congestion graph, Stats
   packet counters). The packetization TCP pre-processor reads `tcp:`, `tls:`, `http2:` directly and is selected by
   `protocolHint === "TCP_HTTP2"`.
3. The sequence-diagram frame label and colour for `frame_created` / `frame_parsed` apply to `http3:` and, on
   converter traces, `http2:` (qvis matched both by type).
4. `tcp`, `tls`, `http2` are not pre-final categories, so they never trigger DM3. The converter MUST NOT reuse
   `transport`, which is flagged.

### 9.11 Old members with no latest equivalent (consolidated)

| Old member or event | Read by (qvis) | Behaviour in qvis-react |
|---|---|---|
| `summary` | Stats | `{}`; the row stays hidden (PARITY) |
| `configuration.time_units`, `time_offset`, `original_uris` | parsers, sequence diagram, export | ms always; offset 0; not exported (9.3) |
| `common_fields.protocol_type` | congestion console gate, packetization TCP branch | custom common field if present, else derived (9.10); the congestion `!== "TCP"` console gate is dropped |
| `common_fields.category` / `name` defaults, `category` member, `event` / `event_type`, `event_fields`, `relative_time` / `delta_time`, top-level `trigger` | parsers | ignored (9.3, 9.4) |
| `is_coalesced` | — | — (`datagram_id` / `datagram_payload_checksum`) |
| metrics `max_ack_delay`, `in_recovery` | — | `quic:parameters_set.max_ack_delay`, `quic:congestion_state_updated` |
| `packet_lost.raw.length` | congestion tooltip | size of the matching `quic:packet_sent` (L3) |
| H3 `byte_length`, event-level `raw` (hex) | packetization | `frame.raw.payload_length`, `frame.raw.data` (L8) |
| PRIORITY_UPDATE `element_id`, `value` | multiplexing waterfall | `stream_id` / `push_id`, `priority_field_value`; push-only updates are skipped |
| `data_moved.length` | multiplexing collapsed | `raw.length` (L9) |
| STREAM / CRYPTO / DATAGRAM frame `length` | multiplexing, packetization | `raw.length` (quic-events-13 §8.13 and its `frames_*` example: the frame's Length field); view specs read through `streamFrameDataLength()`; the model does not move `length` into `raw` |
| `cwnd` | congestion, seq label | `congestion_window` |
| loss timer `timeout` | seq label | `delta` |
| `owner` | congestion, Stats, packetization | `initiator` |
| `max_packet_size` | packetization | `max_udp_payload_size` |
| `connection_close.error_code` (string) / `raw_error_code` | seq frame label | `error` (string) / `error_code` (number, present when `error === "unknown"`); `error_space` `transport_error` / `application_error` became `transport` / `application` |
| frame type `application_close` | seq colour | `connection_close` with `error_space: "application"` |
| `unknown_frame_type` + `raw_frame_type` (QUIC), `raw_frame_type` (H3) | seq default colour, packetization | frame type `unknown` + `frame_type_bytes` |
| ConnectionState `handshake`, `active`, `reset`, `keepalive` | seq label | no latest value (rendered raw if logged) |
| `qpack:*`, `http:data_received`, `http:dependency_update` | — | removed |
| error-category `description`, marker `marker_type` | (labels used only `message`) | `message`, `type` |
| H3 stream type `data`, `push_allowed`, `SETTINGS_NUM_PLACEHOLDERS`, `duplicate_push` frame, application error strings `http_incomplete_request` / `http_unexpected_frame` | — | `request`; removed; `unknown` + `name_bytes`; `unknown` frame; `http_request_incomplete` / `http_frame_unexpected` |

### 9.12 New in the latest drafts that the model should surface

None of these changes what qvis showed (the views stay PARITY by default), but each is cheap to expose and lets the
views stay faithful to the drafts when their specs opt in.

| Id | New item | Model support | Natural view use (off unless a view spec opts in) | Tag |
|---|---|---|---|---|
| N1 | `tuple` + `quic:tuple_assigned {tuple_id, tuple_remote?, tuple_local?}` (replaces `path` / `path_assigned`) | `QlogEvent.tuple` (effective, default `""`); lazy `connection.getTuples(): ReadonlyMap<string, {local?, remote?, abandoned: boolean, firstSeen: number}>` built from `quic:tuple_assigned` (first event creates, later events update with latest-wins, both endpoints omitted = abandoned) | tuple id in the seq-diagram popup or side label; Stats tuple count | NEW |
| N2 | `quic:packets_acked {packet_number_space? (default application_data), packet_numbers?}` | `lookup(NS.quic, "packets_acked")` | congestion-graph ACK marking without duplicate-ACK processing (congestion-graph Q37; parity keeps ACK frames) | NEW |
| N3 | `quic:frames_created`, `quic:frames_parsed`, `quic:frames_processed` `{frames, packet_numbers?}` | lazy `connection.framesForPacket(direction: "sent" \| "received", pnSpace, pn): readonly QuicFrame[]` (`frames[i]` belongs to `packet_numbers[i]`; PN space defaults to application_data; `frames_created` = sent, `frames_parsed` and `frames_processed` = received, quic digest 4.14.3) | views that read `packet_*.data.frames` may merge these when a packet event has none. Stats (shape-based, 4.2) already counts these frames, so producers that log frames both ways are double counted (PARITY with qvis's `frames_processed`). | NEW |
| N4 | `quic:udp_datagrams_sent` / `received` / `udp_datagram_dropped`, `datagram_id`, `datagram_payload_checksum(s)` | `coalescingKey(ev): {kind: "id" \| "checksum", value: number} \| undefined` = `datagram_payload_checksum ?? datagram_id` | mark coalesced packets; cross-trace arrow matching by checksum | NEW |
| N5 | new `quic:recovery_metrics_updated` members `rtt_variance`, `pto_count`, `packets_in_flight`, `pacing_rate` | passthrough | already visible in the seq-diagram popup fold and label; congestion graph could plot `pacing_rate` | PARITY |
| N6 | new QUIC frames `reset_stream_at {stream_id, error, error_code?, final_size, reliable_size}`, `handshake_done`, `datagram {raw.length}`, `unknown {frame_type_bytes}`; extension frames in the wild (`ack_frequency`, `immediate_ack`) | passthrough (frames are open maps) | Stats frame table counts them automatically (keyed by `frame_type`). Seq diagram: recommend the `reset_stream` colour and a `"reset stream at"` label for `reset_stream_at` (sequence-diagram spec owns it). | NEW |
| N7 | `quic:connection_closed {initiator?, connection_error?, application_error?, error_code?, internal_code?, reason?, trigger?}`, `quic:version_information`, `quic:alpn_information` (ALPN objects `{byte_value?, string_value?}`) | passthrough | Stats: chosen version, ALPN and close reason; seq diagram: default label | NEW |
| N8 | `quic:recovery_parameters_set`, `quic:parameters_restored`, `http3:parameters_restored` | passthrough | `parameters_restored` (0-RTT, implicitly remote, no `initiator`) could seed the remote flow-control lines | NEW |
| N9 | `quic:stream_data_moved.additional_info`, `quic:datagram_data_moved` | passthrough | multiplexing: skip zero-length `fin_set` / `stream_reset` moves silently | PARITY+ |
| N10 | `quic:connection_data_blocked_updated`, `quic:stream_data_blocked_updated`, `quic:datagram_data_blocked_updated` | passthrough | flow-control "blocked" markers in the congestion graph | NEW |
| N11 | `quic:mtu_updated`, `quic:ecn_state_updated`, `quic:migration_state_updated`, `quic:key_updated` / `quic:key_discarded` (`key_phase`), `quic:stream_state_updated` (granular states), `quic:packet_dropped` / `quic:packet_buffered` triggers, `quic:connection_started {local, remote}`, `quic:server_listening`, `quic:marked_for_retransmit` | passthrough | generic side labels and the Stats histogram (unknown or unused events MUST NOT break views, P13) | PARITY |
| N12 | `http3:priority_updated`, `http3:stream_type_set {stream_type, associated_push_id?}`, `http3:datagram_created` / `parsed {quarter_stream_id}`, `http3:push_resolved`, `http:capsule_created` / `parsed` | passthrough | waterfall could use `priority_updated` and resolve push IDs via `stream_type_set`; the rest generic | NEW |
| N13 | `loglevel:*`, `simulation:scenario` | passthrough | labels and colours per 9.8 | PARITY |
| N14 | `event_schemas`, `reference_time.clock_type` / `wall_clock_time`, `system_info` | `connection.eventSchemas`, `group.eventSchemas`; `connection.calendarStart?: number` = `parseRfc3339Ms(wall_clock_time)` when the epoch is unknown (informational only, main-schema digest 8.2) | Stats "File info" / "Trace info" rows (Stats spec decides) | NEW |
| N15 | `group_id` recommended to be the ODCID (quic-events-13 §1.4) | `connection.groupId` | the sequence configurator could pair client and server traces with equal `groupId` (qvis TODO, `SequenceDiagramConfigurator.vue:216-217`) | NEW |

### 9.13 Latest names referenced by this subsystem and its consumers (checklist for `names.ts`)

- Packets and recovery: `quic:packet_sent`, `quic:packet_received`, `quic:packet_lost`,
  `quic:recovery_metrics_updated`, `quic:parameters_set`, `quic:recovery_parameters_set`,
  `quic:congestion_state_updated`, `quic:timer_updated`.
- Connectivity: `quic:connection_id_updated`, `quic:spin_bit_updated`, `quic:connection_state_updated`.
- Datagrams and data movement: `quic:udp_datagrams_sent`, `quic:udp_datagrams_received`, `quic:stream_data_moved`.
- HTTP/3: `http3:parameters_set`, `http3:frame_created`, `http3:frame_parsed`.
- Generic: `loglevel:error`, `loglevel:warning`, `loglevel:info`, `loglevel:debug`, `loglevel:verbose`,
  `simulation:marker`, `simulation:scenario`.
- Converters (9.10): `tcp:packet_sent`, `tcp:packet_received`, `tls:record_created`, `tls:record_parsed`,
  `http2:frame_created`, `http2:frame_parsed`.
- Clone-only internal type: `ignoreseq` (any namespace).
- Optional (9.12): `quic:tuple_assigned`, `quic:packets_acked`, `quic:frames_created`, `quic:frames_parsed`,
  `quic:frames_processed`, `quic:udp_datagram_dropped`, `quic:parameters_restored`, `quic:connection_closed`,
  `quic:version_information`, `quic:alpn_information`.

### 9.14 Tests to add (vitest, in addition to 8.6)

1. quic-go-style file (`file_schema` plus `qlog_version: "0.3"`, names `transport:packet_sent`,
   `recovery:metrics_updated`, `security:key_updated`): loads; `group.version` is the file schema; the Stats lookup
   table has namespaces `transport`, `recovery`, `security`; `lookup("quic", "packet_sent")` is empty; one
   `event.nonconforming-name` with 3 samples; DM3 text exact.
2. `http:frame_created` gives DM3, `http:capsule_parsed` does not; `quic:frames_processed` and `quic:packets_acked`
   do not; `loglevel:debug`, `simulation:marker`, `tcp:packet_sent` and `mvfst:foo` do not.
3. `data.header.packet_size`, `data.header.payload_length`, top-level `data.packet_type`: three
   `event.legacy-field` messages (exact text from 9.6), `raw.data` untouched, `data.raw` stays undefined.
4. `data.header.length` alone produces no diagnostic.
5. Legacy `common_fields.time_format: "delta"` in a -14 file: treated as `relative_to_epoch`,
   `event.unknown-time-format` warning; numeric `reference_time` gives `time.legacy-reference-time` and case R.
6. File without `traces`: group with 0 connections, `file.no-traces`; the default-selection hook selects nothing.
7. `serialization_format` missing on JSON-SEQ bytes: `format === "application/qlog+json-seq"` + warning;
   `"JSON-SEQ"` literal displays as the media type.
8. Converter TCP trace (`tcp:packet_sent`, `http2:frame_created`, `common_fields.protocol_type: "TCP_HTTP2"`):
   `protocolHint === "TCP_HTTP2"`, `transportNamespace === "tcp"`; without `protocol_type` the same hint is derived
   from the namespaces.
9. `packet_number` as `"0"` (string) and `0` (number) both satisfy the PN-0 Initial check (`"" + pn === "0"`).
10. Stats shape-based counters on a -13 trace: frames inside `quic:frames_parsed` and `quic:packet_lost` and the
    headers of `quic:packet_dropped` are counted.

---

## Addendum (critic)

Findings of the completeness review (`_gaps.md`). Where this addendum contradicts the body, **this addendum wins**.

### M1. Strict names: other specs aligned (G1)

This spec's §9.1 rule 2 (no aliasing, no fix-ups) is the reference. Stale statements in other specs that assumed an
alias pass have been overridden by their own addenda: app-shell A1, sequence-diagram S1/S2, file-loading F1. The qlog
digests' alias tables (`qlog-spec/ecosystem.md` §6.4-6.6, `qlog-spec/quic-events.md` §15) are **informational**:
they describe what producers emit and are never an implementation instruction (G14). The same holds for
`packetLength()`'s `header.packet_size` / `header.length` fallbacks, which congestion F1 also rejects.

### M2. Files without traces (G10): amends §9.2 row `traces` and §9.14 item 6

file-loading §3.14 step 5 is canonical and implemented. A file whose `traces` is absent or `[]` is **rejected by the
parser** (`QlogParseError`, code `file.no-traces`, message "File contains no traces"). No group is added and the
load-failure toast shows. `fromJSON` keeps tolerating a root without traces as defensive code, but that path is
unreachable for files.

- §9.2: "Absent: group with zero connections, info `file.no-traces` (qvis: TypeError, file lost)" becomes "Absent or
  `[]`: rejected by the parser (file-loading §3.14 step 5)".
- §9.14 item 6 becomes a unit test of `QlogLoader.fromJSON` on a hand-built `LoadedQlog` (not a file load), or is
  dropped.
- app-shell §9.12 F4 ("a group always has at least one connection") therefore holds.

### M3. One rule for legacy members in consumers (G11): extends §9.6

§9.6 states that legacy members are "not read". This applies to **every consumer**, not only the three auto-fix
members. Consumers read only quic-events-13 / h3-events-13 members:

- The shared STREAM/CRYPTO/DATAGRAM data-length accessor is
  `streamFrameDataLength(f) = toNum(f.raw?.payload_length) ?? toNum(f.raw?.length)`, with **no** top-level `length`
  fallback.
- No `cwnd`, `timeout`, `onertt`/`zerortt`, colon-less header names or `raw_error_code` fallbacks (sequence-diagram
  addendum S4).
- `header.packet_size` and `header.length` are never a packet size (congestion F1).

Extend the `event.legacy-field` warning (DM2) with two more once-per-file patterns, checked in the same single pass,
so users learn why sizes or labels are missing:

| Pattern | Message |
|---|---|
| a `stream`, `crypto` or `datagram` frame inside `data.frames` with a top-level `length` and no `raw` | `frames had a top-level length; the qlog drafts use frame.raw.length (example: <loggedName>)` |
| `quic:recovery_metrics_updated` with `cwnd` | `events had data.cwnd set; the qlog drafts use data.congestion_window (example: <loggedName>)` |

The frame check costs one extra loop over `data.frames` only for events that have them. Cap it at the first match
per file to keep the budget of §8.3.
