# qlog main schema: implementation digest

**Covers:** `draft-ietf-quic-qlog-main-schema-14`, "qlog: Structured Logging for Network Protocols". Published 6 July 2026, expires 7 January 2027.
**Cross-checked against:** the editor's copy, `quicwg/qlog` `draft-ietf-quic-qlog-main-schema.md` at commit `71e0358` (2026-11-01).
**Audience:** implementers of the qvis-react loader, data model and every view that reads qlog. Together with the QUIC and HTTP/3 event digests in this directory, this document is the qlog input contract for qvis-react.

Tags used below:

| Tag | Meaning |
|---|---|
| **[SPEC]** | Normative content of draft -14. CDDL is copied verbatim. |
| **[ED]** | The editor's copy differs from -14 here. See section 26. |
| **[INTERP]** | Our reading of something the draft leaves silent or ambiguous. |
| **[QVIS]** | How original qvis behaves. Paths are relative to `qvis/visualizations/` (for example `src/data/QlogLoaderV2.ts:82`). |
| **[REC]** | Recommendation for qvis-react. |

Section numbers such as "§7.1" refer to draft -14.

---

## 0. Cheat sheet

| Item | Value |
|---|---|
| File schema URI, contained JSON (`QlogFile`) | `urn:ietf:params:qlog:file:contained` |
| File schema URI, streaming (`QlogFileSeq`) | `urn:ietf:params:qlog:file:sequential` |
| Media type, JSON | `application/qlog+json`; extension SHOULD be `.qlog` |
| Media type, JSON Text Sequences | `application/qlog+json-seq`; extension SHOULD be `.sqlog` |
| JSON-SEQ record separator | `<RS>` = U+001E (0x1E). Each record starts with RS and ends with LF (0x0A). |
| Event name format | `"<namespace>:<event_type>"`, for example `quic:packet_sent` |
| Generic event schema URIs (this draft) | `urn:ietf:params:qlog:events:loglevel`, `urn:ietf:params:qlog:events:simulation` |
| Protocol event schema URIs (sibling drafts) | `urn:ietf:params:qlog:events:quic`, `urn:ietf:params:qlog:events:http3`, `urn:ietf:params:qlog:events:http`. Draft implementations MUST append `-NN`, for example `urn:ietf:params:qlog:events:quic-13` (quic-events-13 §2.1, h3-events-13 §2.1 and §5.1). |
| Time unit | milliseconds, as `float64` (sub-ms resolution through the fraction) |
| `time_format` values | `"relative_to_epoch"` (default), `"relative_to_previous_event"` |
| `clock_type` values | `"system"` (default), `"monotonic"`, or any other text |
| `epoch` values | an RFC 3339 date-time, or `"unknown"`. The CDDL `.default` is `"1970-01-01T00:00:00.000Z"`. |
| `VantagePointType` | `"client"`, `"server"`, `"network"`, `"unknown"` |
| `VantagePointFlow` | `"client"`, `"server"`, `"unknown"` |
| Importance levels | Core > Base > Extra |
| Environment variables (loggers) | `QLOGDIR` (directory; MUST end with a separator), `QLOGFILE` (full path including the extension) |
| Field names | MUST be lowercase in JSON and JSON-SEQ |
| uint64 in JSON | number, or a JSON **string** (I-JSON). Parsers SHOULD accept both. |
| Binary data | `hexstring`: lowercase, even-length hex (`([0-9a-f]{2})*`) |

Required members, which every other member is optional to:

| Structure | Required members |
|---|---|
| `LogFile` (both file types) | `file_schema`, `serialization_format` |
| `QlogFile` | none beyond `LogFile`. `traces` is optional, and if present it holds at least 1 entry. |
| `QlogFileSeq` | `trace` |
| `Trace` | `event_schemas` (at least 1), `events` (0 or more) |
| `TraceSeq` | `event_schemas` (at least 1) |
| `TraceError` | `error_description` |
| `VantagePoint` | `type` |
| `Event` | `time`, `name`, `data` |
| `ReferenceTime` | `clock_type`, `epoch` |
| `LogLevelInfo`, `LogLevelDebug`, `LogLevelVerbose` | `message` |

---

## 1. Conventions and CDDL (§1.1, §1.2)

**[SPEC]** All qlog documents define their structures in CDDL (RFC 8610). The main schema uses `text`, `uint`, `float32`, `float64`, `bool` and `any`; the `.default`, `.size` and `.regexp` control operators; the `~` unwrap operator; and the `$` / `$$` extension-point syntax.

Custom types, verbatim (Figure 1):

```cddl
; CDDL's uint is defined as being 64-bit in size
; but for many protocol fields it is better to be restrictive
; and explicit
uint8 = uint .size 1
uint16 = uint .size 2
uint32 = uint .size 4
uint64 = uint .size 8

; an even-length lowercase string of hexadecimally encoded bytes
; examples: 82dc, 027339, 4cdbfd9bf0
; this is needed because the default CDDL binary string (bytes/bstr)
; is only CBOR and not JSON compatible
hexstring = text .regexp "([0-9a-f]{2})*"
```

- **[SPEC]** "All timestamps and time-related values (e.g., offsets) in qlog are logged as `float64` in the millisecond resolution." There is no `time_units` setting any more. Microsecond logging is not a thing.
- **[SPEC]** Member order is not significant, either in the CDDL or in JSON and JSON-SEQ, and "qlog tools MUST NOT assume so" ([ED]: "MUST NOT depend on it"). **Consequence:** a tool cannot rely on `file_schema` appearing first. Sniffing is only a hint; the final decision is made after the parse.
- **[INTERP]** CDDL `.regexp` uses XSD regular expressions, which are implicitly anchored. In JavaScript, `hexstring` is `/^([0-9a-f]{2})*$/`.
- CDDL notation reminders: `? x` means optional; `A / B` is a union; `[* T]` is an array of 0 or more; `[+ T]` is an array of 1 or more; `* text => any` allows arbitrary extra string-keyed members (an open JSON object).

---

## 2. Design overview (§2)

The logical hierarchy is: **log file → trace(s) → event(s)**.

- An abstract `LogFile` class (§3) has two concrete schemas: `QlogFile` (§4, contained, JSON) and `QlogFileSeq` (§5, streaming, JSON-SEQ).
- A **trace** conventionally holds the events of one data flow (for example one QUIC connection) at one vantage point (§6). [ED] softens this to "typically", so one trace can contain several connections, separated by `group_id`.
- **Events** (§7) derive from an abstract `Event` class. Concrete events are defined by **event schemas**, which declare or extend a **namespace** (§8).
- The design favours cheap logging over cheap consumption: "A flexible format that can reduce log producer overhead, at the cost of increased complexity for consumers (e.g. tools)". That is why tools must handle `common_fields`, delta timestamps, string-encoded uint64 and the other variations covered below.

---

## 3. Abstract LogFile (§3, §3.1)

```cddl
LogFile = {
    file_schema: text
    serialization_format: text
    ? title: text
    ? description: text
}
```

- **[SPEC]** `file_schema` (required) identifies the concrete log file schema and MUST be an **absolute URI**.
- **[SPEC]** `serialization_format` (required) is a **media type** (RFC 2046) and is **case-insensitive**.
- **[SPEC]** `file_schema` and `serialization_format`, with their values, SHOULD appear in the **first 256 characters/bytes** of the file. It is a SHOULD, not a MUST, and member order is not significant (see section 1).
- **[SPEC]** `title` and `description` are free text about the file.

File schema URI rules (§3.1):
- **[SPEC]** Schemas defined by RFCs MUST register a URI in the "qlog log file schema URIs" registry and SHOULD use `urn:ietf:params:qlog:file:<schema-identifier>`, where the identifier is globally unique and uses only URI unreserved characters (`A-Z a-z 0-9 - . _ ~`). This draft registers `urn:ietf:params:qlog:file:contained` and `urn:ietf:params:qlog:file:sequential`.
- **[SPEC]** Private or non-standard schemas MAY register, MUST NOT use the `urn:ietf:params:qlog:file:` form, and, when the URI contains a domain name, SHOULD include a month-date `mmyyyy` (for example `https://example.org/072024/globallyuniquelogfileschema`). The URI does not need to be dereferenceable.
- **[SPEC]** Note that, unlike event schema URIs, the **file schema URIs carry no `-NN` draft suffix rule**. Draft-14 implementations use the plain URNs above.

---

## 4. QlogFile: contained JSON (§4)

```cddl
QlogFile = {
    ~LogFile
    ? traces: [+ Trace /
                TraceError]
}
```

- **[SPEC]** Schema URI: `urn:ietf:params:qlog:file:contained`. JSON serialization (§11.1). Media type `application/qlog+json`.
- **[SPEC]** `traces` is **optional**. When present, it is an array of 1 or more items, and each item is either a `Trace` or a `TraceError`.
- **[SPEC]** JSON is not streamable. A logger that dies before writing the closing `]}]}` leaves a file most JSON parsers reject. `QlogFileSeq` exists for streaming.

Example (the editor's copy; syntactically valid JSON):

```json
{
    "file_schema": "urn:ietf:params:qlog:file:contained",
    "serialization_format": "application/qlog+json",
    "title": "Name of this particular qlog file (short)",
    "description": "Description for this group of traces (long)",
    "traces": [...]
}
```

### 4.1 Traces (§4.1)

- **[SPEC]** Several related traces (for example client, server and an on-path network observer) can be aggregated into one file by copying each component file's traces into a combined `traces` array.
- **[SPEC]** A capture at a single vantage point is expected to produce a single entry in `traces`.
- **[SPEC]** Events of different logical entities can also be combined inside a single trace with `group_id` (§7.3).

### 4.2 Trace (§4.2)

```cddl
Trace = {
    ? title: text
    ? description: text
    ? common_fields: CommonFields
    ? vantage_point: VantagePoint
    event_schemas: [+text]
    events: [* Event]
}
```

- **[SPEC]** `event_schemas` (required, at least 1) lists event schema URIs for the namespaces and types that appear in `events`. It is **a hint only**; see section 12.
- **[SPEC]** `events` (required) may be empty.
- **[SPEC]** "The semantics and context of the trace can mainly be deduced from the entries in the `common_fields` list and `vantage_point` field."
- **[INTERP]** `Trace` is a closed map in the CDDL (it has no `* text => any`). In practice, tools should still ignore unknown trace members rather than reject them (§13: tools MUST NOT error on unrecognised field names).

Example (editor's copy, corrected JSON):

```json
{
    "title": "Name of this particular trace (short)",
    "description": "Description for this trace (long)",
    "common_fields": {
        "odcid": "abcde1234",
        "time_format": "relative_to_epoch",
        "reference_time": {
            "clock_type": "system",
            "epoch": "1970-01-01T00:00:00.000Z"
        }
    },
    "vantage_point": {
        "name": "backend-67",
        "type": "server"
    },
    "event_schemas": ["urn:ietf:params:qlog:events:quic"],
    "events": [...]
}
```

### 4.3 TraceError (§4.3)

```cddl
TraceError = {
    error_description: text

    ; the original URI used for attempted find of the file
    ? uri: text
    ? vantage_point: VantagePoint
}
```

(In [ED], the comment reads "the original URI used in the attempt to find the file". The CDDL is otherwise identical.)

- **[SPEC]** Records a failed attempt to find or convert a component file during aggregation, instead of silently dropping it.
- **[INTERP]** Discriminate on the presence of `error_description`: a `Trace` never has it, and a `TraceError` has no `events`.
- **[QVIS]** A `TraceError` becomes a placeholder "connection" titled `"ERROR"` with description `uri + " : " + error_description` and no events (`src/data/QlogLoaderV2.ts:49-56`). For URL loads, a `TraceError` as the **first** trace aborts the whole load (`src/store/ConnectionStore.ts:274`).
- **[REC]** Keep the placeholder entry, and show the error text in the file manager and Stats view. Do not abort the other traces.

Example (fixed in [ED]: the -14 version has an unquoted key, `{ type: "server" }`):

```json
{
    "error_description": "File could not be found",
    "uri": "/srv/traces/today/latest.qlog",
    "vantage_point": { "type": "server" }
}
```

---

## 5. QlogFileSeq: streaming JSON Text Sequences (§5)

```cddl
QlogFileSeq = {
    ~LogFile
    trace: TraceSeq
}
```

```cddl
TraceSeq = {
    ? title: text
    ? description: text
    ? common_fields: CommonFields
    ? vantage_point: VantagePoint
    event_schemas: [+text]
}
```

- **[SPEC]** Schema URI: `urn:ietf:params:qlog:file:sequential`. Media type `application/qlog+json-seq`.
- **[SPEC]** A file holds exactly **one** trace. The `QlogFileSeq` object is the **first record** (the "header"). Every following record is one `Event`. `TraceSeq` is a `Trace` without `events`.
- **[SPEC]** `group_id` can still separate logical sources inside the single trace.

Example (`<RS>` stands for U+001E; every record ends with `\n`; a record may contain newlines internally):

```
<RS>{
    "file_schema": "urn:ietf:params:qlog:file:sequential",
    "serialization_format": "application/qlog+json-seq",
    "title": "Name of JSON Text Sequence qlog file (short)",
    "description": "Description for this trace file (long)",
    "trace": {
      "common_fields": {
        "group_id":"127ecc830d98f9d54a42c4f0842aa87e181a",
        "time_format": "relative_to_epoch",
        "reference_time": {
            "clock_type": "system",
            "epoch": "1970-01-01T00:00:00.000Z"
        }
      },
      "vantage_point": {
        "name":"backend-67",
        "type":"server"
      },
      "event_schemas": ["urn:ietf:params:qlog:events:quic",
                        "urn:ietf:params:qlog:events:http3"]
    }
}
<RS>{"time": 2, "name": "quic:parameters_set", "data": { ... } }
<RS>{"time": 7, "name": "quic:packet_sent", "data": { ... } }
...
```

---

## 6. VantagePoint (§6)

```cddl
VantagePoint = {
    ? name: text
    type: VantagePointType
    ? flow: VantagePointFlow
}

; client = endpoint which initiates the connection
; server = endpoint which accepts the connection
; network = observer in between client and server
VantagePointType = "client" /
                   "server" /
                   "network" /
                   "unknown"

; client = vantage point follows client data flow semantics
;          (a "packet sent" event goes towards the server)
; server = vantage point follows server data flow semantics
;          (a "packet sent" event goes towards the client)
; unknown = the flow's direction is unknown
VantagePointFlow = "client" /
                   "server" /
                   "unknown"
```

- **[SPEC]** `flow` is only required when `type` is `"network"`, for example for a trace generated from a packet capture. It disambiguates "packet sent" from "packet received": with `flow: "client"`, a sent packet travels towards the server.
- **[SPEC]** When a tool meets `"unknown"`, it can either infer the direction heuristically (in QUIC, the client always sends the first packet) or let the user switch between the client and server perspectives manually.
- **[SPEC]** `vantage_point` is **optional** on `Trace` and `TraceSeq` (it was required in old qlog).
- **[QVIS]** A missing `vantage_point` or `type` becomes `{type: "unknown", flow: "unknown", name: "No VantagePoint set"}` (`src/data/QlogLoaderV2.ts:138-144`). The perspective is `type` when that is `client` or `server`, otherwise `flow`, otherwise `"unknown"` (`src/data/Connection.ts:113-124`). The display name is built by `getLongName()` (`src/data/Connection.ts:163-186`), for example `"<name> : <type> (flow = <flow>) : <title> : <description>"`.
- **[REC]** Keep those semantics exactly; the sequence diagram's client/server pairing depends on them (`src/components/sequencediagram/SequenceDiagramConfigurator.vue:104-121`).

---

## 7. Abstract Event (§7)

```cddl
Event = {
    time: float64
    name: text
    data: $ProtocolEventData
    ? tuple: TupleID
    ? time_format: TimeFormat
    ? group_id: GroupID
    ? system_info: SystemInformation

    ; events can contain any amount of custom fields
    * text => any
}
```

- **[SPEC]** `time`, `name` and `data` are mandatory.
- **[SPEC]** `tuple`, `time_format`, `group_id` and `system_info` are optional. ([ED] adds `system_info` to the prose list; it was already in the -14 CDDL.)
- **[SPEC]** Events may carry **any custom members** (`* text => any`). For example, an implementation can add `"odcid"` to every event.
- **[SPEC]** Values duplicated across all events of a trace can be hoisted into `common_fields` (§7.5). Fields listed in `CommonFields`, notably `reference_time`, can therefore also appear **on individual events**; see section 11.

Example (with the -14 `"ODCID"` key lower-cased, as in [ED]):

```json
{
    "time": 1553986553572,
    "name": "quic:packet_sent",
    "data": { ... },
    "group_id": "127ecc830d98f9d54a42c4f0842aa87e181a",
    "time_format": "relative_to_epoch",
    "odcid": "127ecc830d98f9d54a42c4f0842aa87e181a"
}
```

---

## 8. Timestamps (§7.1)

### 8.1 `time`

- **[SPEC]** Every event MUST include `time`, a `float64` duration measured from a reference point. It "is typically used to represent a duration in milliseconds, with a fractional component to microsecond or nanosecond resolution". §1.2 states that all time values are milliseconds.
- **[SPEC]** Two types govern how `time` is interpreted:
  - `ReferenceTime`, optionally in a trace's `common_fields.reference_time`. It defines the epoch and the clock.
  - `TimeFormat`, optionally on the event itself or in `common_fields.time_format`. It defines how `time` relates to the epoch.
- **[SPEC]** "There is no requirement that events in the same trace use the same time format."

### 8.2 ReferenceTime

```cddl
ReferenceTime = {
    clock_type: "system" / "monotonic" / text .default "system"
    epoch: RFC3339DateTime / "unknown"

    ? wall_clock_time: RFC3339DateTime
}

RFC3339DateTime = text .default "1970-01-01T00:00:00.000Z"
```

- **[SPEC]** `clock_type` (required):
  - `"system"`: system time, measured against a chosen or well-known epoch. It can jump forwards or backwards.
  - `"monotonic"`: never goes backwards.
  - Other text values are allowed (`/ text`).
- **[SPEC]** `epoch` (required) is the start of the reference time.
  - With `"system"`, it SHOULD be an RFC 3339 date-time, but MAY be `"unknown"`.
  - With `"monotonic"`, it **MUST** be `"unknown"`.
- **[SPEC]** `wall_clock_time` (optional, RFC 3339) gives "an approximate date/time value that logging commenced at if the epoch value is 'unknown'". Converting timestamps to calendar time based on it "cannot be safely relied on".
- **[INTERP]** When `reference_time` is absent everywhere, use the CDDL defaults: `{clock_type: "system", epoch: "1970-01-01T00:00:00.000Z"}`, the Unix epoch. `time` then holds Unix milliseconds, the same meaning as old qlog's `time_format: "absolute"`.
- **[INTERP]** Treat a non-standard `clock_type` like `"monotonic"` when its epoch is `"unknown"`, and like `"system"` when its epoch is a date-time.
- **[INTERP]** `wall_clock_time` marks when logging started. For display, map it to the **first event** of the trace (after sorting). Use it only for informational labels such as "approx. start: …", never for cross-trace alignment.

### 8.3 TimeFormat

```cddl
TimeFormat = "relative_to_epoch" /
             "relative_to_previous_event" .default "relative_to_epoch"
```

- **[SPEC]** `relative_to_epoch` (the **default**) means `time` is a duration since `ReferenceTime.epoch`. This suits stateless loggers.
- **[SPEC]** `relative_to_previous_event` means `time` is a delta. "The first event in a trace is always relative to the ReferenceTime." This suits stateful loggers.
  - [ED] clarifies the delta as "the duration since the time of the previously logged event". The base is therefore the previous event's **resolved** time, not its raw `time` value, which matters when formats are mixed within a trace.
  - **[INTERP]** "Previous" means the previous event **in file order within the serialized trace**: not after sorting, and not within the `group_id` group.

### 8.4 Ordering

- **[SPEC -14]** "Events in each individual trace SHOULD be logged in strictly ascending timestamp order (though not necessarily absolute value, for the 'relative_to_previous_event' format). Tools MAY sort all events on the timestamp before processing them, though are not required to…"
- **[ED]** (#622, the current WG direction) changes this:
  - Events SHOULD be logged in **non-decreasing** time order, so no event has an earlier time than the one before it. Equal times are explicitly allowed. With `relative_to_previous_event`, no logged `time` is negative.
  - "Tools cannot rely on logs containing traces with events in time order."
  - "Several events can have the same time … The logged order of these events can still matter … A **stable sort**, which keeps events with the same time in their logged order, preserves it."
- **[SPEC]** Tools SHOULD NOT assume they can derive an absolute calendar timestamp, and should not rely on timestamps being consistent **across** traces, even traces from the same endpoint. The reference time MAY be minimised or anonymised for privacy.

### 8.5 Examples (condensed from Figures 18-20)

| Case | `common_fields` | Event `time` values | Meaning |
|---|---|---|---|
| Absolute Unix ms | `time_format: relative_to_epoch`, `reference_time: {clock_type: system, epoch: "1970-01-01T00:00:00.000Z"}` | 1553986553572, 1553986553577, 1553986553587, 1553986553597 | Unix ms |
| Delta | `time_format: relative_to_previous_event`, same reference | 1553986553572, 5, 10, 10 | Resolves to …572, …577, …587, …597 |
| Monotonic | `time_format: relative_to_epoch`, `reference_time: {clock_type: monotonic, epoch: "unknown", wall_clock_time: "2024-10-10T10:10:10.000Z"}` | 0, 5, 15, 25 | Durations on an unknown base; logging began at about 2024-10-10T10:10:10Z |

---

## 9. Tuple (§7.2)

```cddl
TupleID = text .default ""
```

- **[SPEC]** Identifies a single network four-tuple (a "path"). It is used to associate events with a path, for example during QUIC connection migration or multipath.
- **[SPEC]** The value and its mapping to addresses and ports are left to extension schemas. QUIC uses `quic:tuple_assigned` (quic-events §4.7) to tie a `TupleID` to concrete tuple details.
- **[SPEC]** It is optional per event, and may be logged only when salient (for example for PATH_CHALLENGE/PATH_RESPONSE, or the first packet on a new path). It is typically hoisted into `common_fields`.
- **[INTERP]** An event without `tuple`, with no `common_fields.tuple`, belongs to the default tuple `""`.
- History: this was `path` / `PathID` in main-schema-08 to -12, and was renamed to `tuple` in -13 (#491). qvis has no tuple or path support.

---

## 10. Grouping: `group_id` (§7.3)

```cddl
GroupID = text
```

- **[SPEC]** Splits events of separate logical entities inside **one** trace, for example a server logging all connections into one (streamed) file. The value is any string that is unique per logical group: QUIC ODCID hex, `"qos=premium"`, and so on.
- **[SPEC]** For per-path splitting inside one connection, prefer `tuple` to `group_id`.
- **[SPEC]** A trace with a single group typically logs `group_id` once, in `common_fields`.
- **[QVIS]**:
  - A trace is split when its **first** event has a `group_id` member (`src/data/QlogLoaderV2.ts:80-85`).
  - Each distinct value becomes a connection titled `"Group " + id + " : " + trace.title` (`src/data/QlogLoaderV2.ts:98-112`, `:135`).
  - Non-string ids are passed through `JSON.stringify` (`:100-102`).
  - The split connections share the parent's `vantage_point` and `common_fields`.
- **[REC]** Use the effective value `event.group_id ?? common_fields.group_id` (section 11). Split when at least one event defines its own `group_id` **and** more than one distinct effective value exists. Put events with no effective value into a group titled `"(no group_id)"`. Keep the qvis title format for parity.

---

## 11. SystemInformation (§7.4) and CommonFields (§7.5)

```cddl
SystemInformation = {
    ? processor_id: uint32
    ? process_id: uint32
    ? thread_id: uint32
}
```

- **[SPEC]** `system_info` records the CPU, process and thread an event happened on. Every member is optional. It is new compared to old qlog, and is display-only for qvis-react.

```cddl
CommonFields = {
    ? tuple: TupleID
    ? time_format: TimeFormat
    ? reference_time: ReferenceTime
    ? group_id: GroupID
    * text => any
}
```

- **[SPEC]** `common_fields` lists fields, with their values, that are shared by **all** events of the trace. It is an open dictionary.
- **[SPEC]** "unknown entries in this dictionary MUST be disregarded by the user and tools (i.e., the presence of an unknown field is explicitly NOT an error)."
- **[SPEC]** "Tools MUST be able to deal with these fields being defined either on each event individually or combined in common_fields."
- **[SPEC]** If even one event has a different value for a field, that field MUST NOT be placed in `common_fields`. In practice, `time` and `data` never are.
- **[SPEC]** Figure 24 shows `reference_time` repeated **inside each event** as the non-hoisted alternative. A per-event `reference_time` is therefore legal input, carried by the `* text => any` part of `Event`.
- **[INTERP] Resolution rule.** For any top-level event field `k`, the effective value is `event[k]` when present, otherwise `common_fields[k]`, otherwise the CDDL default. This applies at least to `time_format`, `reference_time`, `group_id`, `tuple` and `system_info`, and generically to any custom key (for example `odcid`).
- **[REC]** Implement this as a lookup function, not by spreading `common_fields` into every event (that would cost memory on large traces).

---

## 12. Event names, namespaces and event schemas (§8, §8.1)

- **[SPEC]** Concrete event types belong to exactly one **namespace** and have a non-empty text identifier. -14 says "registered". [ED] (#614) drops the registration requirement for private schemas, and adds that a private schema whose types are not listed in the registry "cannot rely on its event names being unique".
- **[SPEC]** Namespace identifiers are non-empty, globally unique, and use only URI unreserved characters (`A-Za-z0-9-._~`), so **a namespace never contains `:`**. Namespaces are mutable and can be extended with new events.
- **[SPEC]** `name` MUST be `namespace + ":" + event_type`, and MUST be globally unique.
- **[INTERP]** The event type identifier is "text" with no character restriction. **Split `name` at the first `:`**: the part before is the namespace and everything after is the type. qvis instead took `split(":")[1]` (`src/data/QlogLoaderV2.ts:355-362`), which drops anything after a second colon.
- **[SPEC]** An event schema contains **exactly one** of:
  - a definition of a new namespace, or
  - an extension of an existing namespace (new event or data types, or new fields on existing ones).

  One document may define several schemas.
- **[SPEC]** An event schema has exactly one absolute URI, which MUST include the namespace identifier. An **extension** schema's URI also carries an extension identifier as a URI **fragment** (`#…`, unreserved characters). -14 requires that identifier to be globally unique; [ED] requires it to be unique within the namespace. Event schemas are immutable once defined.
- **[SPEC]** URI forms:
  - RFC-defined new namespace: SHOULD be `urn:ietf:params:qlog:events:<namespace>`.
  - RFC-defined extension: SHOULD be `urn:ietf:params:qlog:events:<namespace>#<extension>`.
  - Private schemas MUST NOT use these URN forms. When a domain URI is used, it SHOULD include `mmyyyy`, for example `https://example.org/072024/customeventschema#customextension`.
- **[SPEC]** Implementations SHOULD list every event schema used in a trace in `Trace.event_schemas` / `TraceSeq.event_schemas`. The list is **a hint**:
  - a trace MAY contain events of schemas that are not listed, and
  - listed schemas need not have all their events present.

  "Tools MUST NOT treat either of these as an error."
- **[SPEC from the sibling drafts]** While the QUIC and HTTP/3 documents are drafts, implementations "MUST append the string '-' and the corresponding draft number to the URI", for example `urn:ietf:params:qlog:events:quic-13` and `urn:ietf:params:qlog:events:http3-13`. "The namespace identifier itself is not affected": event names stay `quic:…` and `http3:…`.

Example `event_schemas` (Figure 26):

```json
"event_schemas": [
  "urn:ietf:params:qlog:events:loglevel",
  "urn:ietf:params:qlog:events:simulation",
  "urn:ietf:params:qlog:events:rick",
  "urn:ietf:params:qlog:events:rick#astley",
  "urn:ietf:params:qlog:events:rick#moranis",
  "https://example.com/032024/pickle.html",
  "https://example.com/032024/pickle.html#lilly",
  "https://example.com/032025/cucumber.html"
]
```

Known namespaces for qvis-react:

| Namespace | Event schema URI (final, then draft form) | Defined in | Events |
|---|---|---|---|
| `loglevel` | `urn:ietf:params:qlog:events:loglevel` | main-schema §9.1 | `error`, `warning`, `info`, `debug`, `verbose` |
| `simulation` | `urn:ietf:params:qlog:events:simulation` | main-schema §9.2 | `scenario`, `marker` |
| `quic` | `urn:ietf:params:qlog:events:quic`, `…:quic-13` | quic-events-13 | see the QUIC digest |
| `http3` | `urn:ietf:params:qlog:events:http3`, `…:http3-13` | h3-events-13 | see the HTTP/3 digest |
| `http` | `urn:ietf:params:qlog:events:http`, `…:http-13` | h3-events-13 §5-6 (Capsule Protocol) | `capsule_created`, `capsule_parsed` |

**[REC]** Parse each `event_schemas` entry with a regex such as `^urn:ietf:params:qlog:events:(loglevel|simulation|quic|http3|http)(?:-(\d+))?(?:#(.+))?$`. Match the namespace against the **known list**, because a namespace may itself contain `-`. Keep unknown URIs verbatim for display in Stats.

---

## 13. Extending the data field (§8.2) and triggers (§8.2.1)

- **[SPEC]** `data` is a generic key-value map whose members are defined per concrete event type.
- **[SPEC]** There are two CDDL extension points:
  - **Type socket `$ProtocolEventData`** (the type of `Event.data`). It is an open enum; every concrete event data type is added with `$ProtocolEventData /= MyType`. Event schemas MUST extend it.
  - **Group socket `* $$<namespace>-<eventtype>-extension`** inside each event data map. Later schemas add fields with `$$x //= ( ? field: type )`, and several plugs may extend the same socket. New event types SHOULD include such a socket.

```cddl
; original definition in event schema A
MyNSEventX = {
    field_a: uint8

    * $$myns-eventx-extension
}

; later extension of EventX in event schema B
$$myns-eventx-extension //= (
  ? additional_field_b: bool
)

; another extension of EventX in event schema C
$$myns-eventx-extension //= (
  ? additional_field_c: text
)

; if schemas A, B and C are then used in conjunction,
; the combined MyNSEventX CDDL is equivalent to this:
MyNSEventX = {
    field_a: uint8

    ? additional_field_b: bool
    ? additional_field_c: text
}
```

- **Tool consequence [SPEC §8.4]:**
  - `data` objects may contain members the tool does not know (extension plugs).
  - New namespaces, event types and `trigger` values will appear.
  - "Tools SHOULD allow for the presence of unknown event fields and make an effort to visualize even unknown data if possible, otherwise they MUST ignore it."
- **[SPEC] Triggers:** where a cause is useful, event data SHOULD contain an optional string member named **`trigger`**, inside `data` (not at the event top level as in qlog draft-01). Example: `quic:packet_dropped.data.trigger`.
  - -14 Figure 30 lists `"key_unavailable"`; [ED] (#610/#620) uses `"keys_unavailable"`.
  - quic-events-13 itself uses `key_unavailable` for `packet_dropped` and `keys_unavailable` for `packet_buffered`.
  - **[REC]** Accept both spellings.

---

## 14. Event importance levels (§8.3)

- **Core:** SHOULD be present in all qlog files for a protocol (basic packet and frame creation and parsing, basic internal metrics). Tools SHOULD support them, but SHOULD NOT expect every Core event in every trace.
- **Base:** MAY be present. They add debugging detail and can mostly be inferred from Core. Tools SHOULD at least show their contents.
- **Extra:** MAY be present. They serve low-level implementation debugging. Tools MAY support them.
- **[SPEC]** Concrete event types SHOULD declare a level.
- **[SPEC]** An implementation that omits Core details (for performance or privacy) SHOULD log relevant Base events instead.
  - -14 example: no `packet_received` events, so log `packets_acked`.
  - [ED] example: omit STREAM frame details and log `stream_state_updated`.
- Importance of the generic events: `loglevel:error` Core, `loglevel:warning` Base, `loglevel:info` / `debug` / `verbose` Extra, `simulation:scenario` / `marker` Extra.

---

## 15. Generic event schemas (§9)

### 15.1 loglevel (`urn:ietf:params:qlog:events:loglevel`)

```cddl
LogLevelEventData = LogLevelError /
                    LogLevelWarning /
                    LogLevelInfo /
                    LogLevelDebug /
                    LogLevelVerbose

$ProtocolEventData /= LogLevelEventData
```

```cddl
LogLevelError = {
    ? code: uint64
    ? message: text

    * $$loglevel-error-extension
}
```

```cddl
LogLevelWarning = {
    ? code: uint64
    ? message: text

    * $$loglevel-warning-extension
}
```

```cddl
LogLevelInfo = {
    message: text

    * $$loglevel-info-extension
}
```

```cddl
LogLevelDebug = {
    message: text

    * $$loglevel-debug-extension
}
```

```cddl
LogLevelVerbose = {
    message: text

    * $$loglevel-verbose-extension
}
```

Event names: `loglevel:error` (internal error, possibly not reflected on the wire), `loglevel:warning`, `loglevel:info`, `loglevel:debug`, `loglevel:verbose`. `code` is a uint64, so it may arrive as a JSON string.

### 15.2 simulation (`urn:ietf:params:qlog:events:simulation`)

```cddl
SimulationEventData = SimulationScenario /
                SimulationMarker

$ProtocolEventData /= SimulationEventData
```

```cddl
SimulationScenario = {
    ? name: text
    ? details: {* text => any }

    * $$simulation-scenario-extension
}
```

```cddl
SimulationMarker = {
    ? type: text
    ? message: text

    * $$simulation-marker-extension
}
```

- `simulation:scenario` names the scenario under test. It can be used to aggregate several simulations into one trace, split by `group_id`.
- `simulation:marker` marks when emulated test conditions change, for example "at 3 s, 2% loss introduced; at 10 s, NAT rebind".
- **[QVIS]** Old qvis used `simulation:marker` with `{marker_type, message}` and `GenericEventType.marker` (`src/data/QlogSchema02.ts:736-739`). The new member names are `type` and `message`.

---

## 16. RawInfo (§10)

```cddl
RawInfo = {

    ; the full byte length of the entity (e.g., packet or frame),
    ; including possible headers and trailers
    ? length: uint64

    ; the byte length of the entity's payload,
    ; excluding possible headers or trailers
    ? payload_length: uint64

    ; the (potentially truncated) contents of the full entity,
    ; including headers and possibly trailers
    ? data: hexstring
}
```

- **[SPEC]** Appears as an optional member named `raw` wherever applicable (packets, frames, datagrams and so on). Every member is optional and may be logged independently.
- **[SPEC]** `raw.data` may be truncated (section 19). The length fields should give the real lengths even when `data` is omitted or truncated.
- **[SPEC]** Entities with an on-the-wire length field (a packet header, a QUIC STREAM frame) are "strongly recommended" to reuse `raw.length` instead of defining their own length field. This change (#495, "Replaced all length fields with raw.length") landed in -13. **The packet size therefore lives in `data.raw.length`**, as qvis already normalised (`src/data/QlogLoaderV2.ts:198-226`).
- **[SPEC]** There are no `header_length` or `trailer_length` fields.
  - Without trailers, `header_length = length - payload_length`.
  - With trailers, protocol documents define the calculation. QUIC treats the 16-byte AEAD tag as a trailer (quic-events, editor's copy, "RawInfo" note).

---

## 17. Serialization (§11)

### 17.1 JSON (§11.1)

- **[SPEC]** Uses `QlogFile`. Media type `application/qlog+json` (RFC 6839 `+json` suffix). Extension SHOULD be `.qlog`.
- **[SPEC]** UTF-8 for both the file and its strings (RFC 8259 §8.1).
- **[SPEC]** **All field names MUST be lowercase.**
- **[SPEC]** The CDDL-to-JSON mapping is RFC 8610 Appendix E.

### 17.2 JSON Text Sequences (§11.2, §11.2.1)

- **[SPEC]** Uses `QlogFileSeq`. Media type `application/qlog+json-seq` (RFC 8091 `+json-seq` suffix). Extension SHOULD be `.sqlog`, for "streaming" qlog.
- **[SPEC]** Every record is prefixed by RS (0x1E) and ends with LF (0x0A). A record may contain any number of newlines internally, as long as it ends with a newline before the next RS.
- **[SPEC]** Each qlog event is one record. The format does not need a wrapping `{…}` or `[…]`.
- **[SPEC]** Field names MUST be lowercase.
- **[SPEC]** Tooling: split the file into records and feed each one to a normal JSON parser.
- RFC 7464 parser rules that apply ([SPEC] by reference):
  - Multiple consecutive RS do not denote empty elements and can be ignored.
  - If one record fails to parse, the parser SHOULD **continue** with the rest of the sequence, and may report the failure.
  - A final record that lacks its LF may be truncated.

### 17.3 JSON interoperability: uint64 (§11.3)

- **[SPEC]** I-JSON / JavaScript represents integers exactly only within ±(2^53 − 1).
- **[SPEC]** Serializers **MAY encode uint64 values as JSON strings**. Parsers "SHOULD support parsing of uint64 values from JSON strings or JSON numbers", unless out-of-band information says neither side is I-JSON constrained.
- **[ED]** The CDDL describes uint64 values as numbers, so a log that uses strings must have those values converted to numbers before CDDL validation.
- **[REC]** Leave `data` untouched, so the raw-JSON views show what was actually logged. Expose helpers instead:
  - `asNumber(v)`: number → itself; decimal string → `Number(v)`; other → `NaN`.
  - `asBigInt(v)`: the exact form, for comparisons.

  Every view that does arithmetic on a uint64 member (packet numbers, stream IDs, offsets, lengths, error codes, `loglevel` `code`) MUST go through `asNumber`. Note that plain `JSON.parse` already loses precision on numeric literals above 2^53. qvis had the same limitation, so this is not a parity gap.

### 17.4 Truncated values (§11.4)

- **[SPEC]** Every `hexstring` field SHOULD have a companion length field, as `RawInfo` does with `length` and `data`.
- **[SPEC]** When the full value is logged, the length field may be omitted. Tools SHOULD then derive the length as `hex.length / 2`.

```
// both the content's value and its length are present
// (length is redundant)
{
    "content_length": 5,
    "content": "051428abff"
}

// only the content value is present, indicating it
// represents the content's full value. The byte
// length is obtained by calculating content.length / 2
{
    "content": "051428abff"
}

// only the length is present, meaning the value
// was omitted
{
    "content_length": 5
}

// both value and length are present, but the lengths
// do not match: the value was truncated to
// the first three bytes.
{
    "content_length": 5,
    "content": "051428"
}
```

**[REC]**
- byte length = `lengthField ?? hex.length / 2`
- truncated = `lengthField !== undefined && hex !== undefined && hex.length / 2 < lengthField`
- omitted = `lengthField !== undefined && hex === undefined`

### 17.5 Optimization (§11.5)

- **[SPEC]** JSON and JSON-SEQ compress very well (gzip, Brotli). New formats SHOULD define file extensions and media types, so tools need neither out-of-band information nor heuristics.
- **[QVIS]** For URL loads, qvis relies on the browser's transparent `Content-Encoding` decoding. The `.qlog.gz`, `.qlog.br` and `.qlog.zip` suffixes are recognised (`src/components/filemanager/data/FileLoader.ts:184-196`) but not decoded client-side. Local upload only accepts `.qlog`, `.sqlog`, `.json`, `.netlog` and `.qlognd` (`src/components/filemanager/FileManagerContainer.vue:51`, `:280`).

---

## 18. Methods of access and generation (§12)

- **[SPEC]** `QLOGFILE` is the full path of a single qlog file and MUST include the extension. `QLOGDIR` is a directory and MUST end with the directory separator.
- **[SPEC]** Implementations SHOULD support `QLOGDIR` and MAY support `QLOGFILE`. Prefer `QLOGDIR` when one process produces many files (for example one per connection).
- **[SPEC]** With `QLOGDIR`, the implementation chooses file names. For QUIC: ODCID followed by the vantage point type, for example `/srv/qlogs/abcde_server.qlog` and `/srv/qlogs/12345_server.qlog`.
- **[SPEC]** A server that writes every connection to a single `QLOGFILE` separates them with `group_id` values `"abcde"` and `"12345"`.
- **[REC]** A viewer does not use these variables. The `<odcid>_<vantage>.qlog` naming convention can, however, help pair client and server files in multi-file loads.

---

## 19. Tooling requirements (§13 and §8.4), as a qvis-react checklist

- [ ] **MUST** state which file and event schemas, serialization formats and compression methods are supported, along with other inputs (for example `.pcap`). -14 says "qlog version(s), qlog format(s)"; [ED] says "serialization format(s)".
  - qvis-react should list `urn:ietf:params:qlog:file:contained` (.qlog, `application/qlog+json`) and `…:sequential` (.sqlog, `application/qlog+json-seq`), and the event schemas `quic`(-NN), `http3`(-NN), `http`(-NN), `loglevel` and `simulation`.
  - This replaces the "You can load .qlog, .sqlog, …" text in `src/components/filemanager/FileManagerContainer.vue:27,76`.
- [ ] **SHOULD** support `.qlog` files in JSON at minimum.
- [ ] **SHOULD** document, per view, which `name` values and `data` members the view uses, for example the congestion graph's required events.
- [ ] **SHOULD** run a high-level check that the input matches the expected file and event schemas. If the data is insufficient for a view, show a **clear error** ("This trace has no `quic:packet_sent` events…").
- [ ] **MUST NOT** produce breaking errors for unrecognised field names or values.
- [ ] **SHOULD** show unknown events in context, for example on a timeline or in the Stats event table.
- [ ] **SHOULD** be robust to incomplete logs. Early events can be missing (circular buffers), and events can be omitted for privacy or size.
- [ ] (§8.4) **SHOULD** tolerate and try to visualise unknown fields, **MUST** otherwise ignore them.

---

## 20. Security and privacy (§14), as it applies to a viewer

- qlog can contain IP addresses and ports, connection IDs, CPU/process/thread ids, tokens, tickets and cookies, TLS keys, passwords and API tokens, high-resolution timings and sizes, and raw encrypted or plaintext payloads (for example HTTP field values and SNI).
- §14 recommends access control, auditing, retention policies and encryption at rest and in transit. The most sensitive data sits in `RawInfo` fields and in fields that log keys or plaintext ([ED]).
- **[REC]** Keep all parsing client-side, as qvis promised: "No data is transferred to the server" (`src/components/filemanager/FileManagerContainer.vue:76`). Never send qlog content to analytics or error reporting. A Sentry-style report may include counts and codes, never event payloads.

---

## 21. IANA (§15)

- URN sub-namespace `qlog`, under `urn:ietf:params:qlog`.
- Registry "qlog log file schema URIs" (Expert Review). Entries: `urn:ietf:params:qlog:file:contained` ("can contain several traces from multiple vantage points") and `urn:ietf:params:qlog:file:sequential` ("containing a single trace, optimized for sequential read and write access").
- Registry "qlog event schema URIs" (Expert Review). Template: URI, Namespace, Event Types, Description, Reference. [ED]: private schemas need not list their event types. Entries: `loglevel` (error, warning, info, debug, verbose) and `simulation` (scenario, marker).
- Media types:
  - `application/qlog+json`: extension `.qlog`, encoding "binary", no parameters.
  - `application/qlog+json-seq`: extension `.sqlog`, encoding "binary", no parameters.
  - [ED] adds fragment identifier considerations, which follow `application/json` and `application/json-seq` respectively.

---

## 22. Parsing rules for a tool

This is the normative algorithm for the qvis-react loader. The steps are numbered P1 to P15. "Diagnostics" are collected per file as `{level: "error" | "warning" | "info", code, message, count, traceIndex?, sample?}`, deduplicated by `code`, and shown **non-modally**. qvis used `alert()` and `console.error` (`src/data/QlogLoaderV2.ts:185`, `:257`).

### P1. Acquire bytes

- Inputs: a local `File`, a `fetch(url)` response (the qvis `?file=` / `?list=` query parameters; see the parity docs), or a demo file.
- **[REC]** Decompression:
  - `.gz` / `.gzip`: `DecompressionStream('gzip')`.
  - `.br` / `.brotli`: only through HTTP `Content-Encoding`, as in qvis.
  - Otherwise: pass the bytes through.
  - Strip compression suffixes before the extension checks.

### P2. Decode text

- `new TextDecoder('utf-8')`. The default `ignoreBOM: false` strips a leading BOM. Invalid sequences become U+FFFD; do not throw.
- For streaming JSON-SEQ, use `decoder.decode(chunk, {stream: true})`.

### P3. Detect the serialization

Content wins over the file extension, and the extension is only a hint.

```ts
export type Detected = "json" | "json-seq" | "json-lines" | "legacy" | "not-qlog";

export function detect(text: string): Detected {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;                 // defensive: stray BOM
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  const c = text[i];
  if (c === "\u001e") return "json-seq";                    // RFC 7464 record separator
  if (c !== "{") return "not-qlog";                         // e.g. "[" = tshark JSON, out of scope here
  const head = text.slice(i, i + 65536);                    // spec: header SHOULD be in first 256 bytes; order not guaranteed
  if (head.includes("\u001e")) return "json-seq";           // first record lacks its leading RS
  if (!head.includes('"file_schema"') && head.includes('"qlog_version"')) return "legacy";
  if (/"file_schema"\s*:\s*"urn:ietf:params:qlog:file:sequential"/.test(head) ||
      /"serialization_format"\s*:\s*"application\/qlog\+json-seq/i.test(head)) return "json-lines"; // seq header but no RS (lenient)
  return "json";
}
```

- `"json"` here means "try a contained parse". Because member order is not significant, `file_schema` may come after a huge `traces` array, so confirm in P6 after parsing.
- `"legacy"` is confirmed in P6 (the root has `qlog_version` and no `file_schema`).
- **[QVIS]** For comparison: qvis sniffed the first 1024 characters for `qlog_version`, `qlog_format`, `NDJSON` and `JSON-SEQ` (`src/components/filemanager/data/FileLoader.ts:211-248`, `:263`) and mapped extensions in `:169-197`.

### P4. Parse contained JSON (`QlogFile`)

1. Try `JSON.parse(text)`.
2. On failure, **[REC] recover a truncated file**. This is a parity feature: qvis falls back to the oboe streaming parser and keeps everything parsed up to the error (`src/components/filemanager/utils/StreamingJSONParser.ts:12-131`). The spec explicitly anticipates files missing their closing `]}]}`. Use a bracket-stack repair:

```ts
// Returns repaired JSON text, or null if unrecoverable.
export function repairTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inStr = false, esc = false, lastSafe = -1, closersAtSafe: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;                       // structurally broken, give up
      if (stack.length === 0) return text.slice(0, i + 1);       // complete root, ignore trailing garbage
      lastSafe = i; closersAtSafe = stack.slice();               // a value just closed: safe cut point
    }
  }
  if (lastSafe < 0) return null;
  return text.slice(0, lastSafe + 1) + closersAtSafe.reverse().join("");
}
```

3. After the repaired parse, drop the **last** event of the last trace if it lacks any of `time`, `name` or `data`.
4. Emit the warning `json.truncated-recovered` with the event count. If repair fails, emit an error ("not valid JSON") and stop.

### P5. Parse JSON-SEQ (`QlogFileSeq`)

```ts
export function parseJsonSeq(text: string, diag: Diag): unknown[] {
  const out: unknown[] = [];
  const parts = text.split("\u001e");
  for (let r = 0; r < parts.length; r++) {
    const raw = parts[r];
    const rec = raw.trim();
    if (rec.length === 0) continue;                 // leading chunk / consecutive RS: ignore (RFC 7464)
    try { out.push(JSON.parse(rec)); }
    catch {
      const last = r === parts.length - 1;
      diag.warn(last && !raw.endsWith("\n") ? "seq.truncated-final-record" : "seq.invalid-record",
                `JSON-SEQ record #${r} is not valid JSON and was skipped`, rec.slice(0, 200));
      // RFC 7464: SHOULD continue parsing the remainder
    }
  }
  return out;
}
```

- **Streaming variant [REC]:** read a `ReadableStream`, append decoded chunks to a buffer, split on `\u001e`, parse every part except the last (which may be incomplete), and keep the last part as the new buffer. Flush the buffer at EOF.
  - **Bug not to copy:** qvis `return`s from the chunk handler when a record fails to parse, which stalls the stream and silently drops the rest of the file (`src/components/filemanager/newlineconverter/textsequencejsontoqlog.ts:194-201`). qvis-react must continue.
- **`"json-lines"` (lenient, not in the spec):** when the header says sequential but the file has no RS, split on `\n` instead. Parse each non-empty line, and fall back to accumulating lines until `JSON.parse` succeeds, for pretty-printed records. Emit the warning `seq.no-record-separators`.
- **Header handling:**
  - `records[0]` MUST be the `QlogFileSeq` header, an object with `trace`.
  - If `records[0]` instead looks like an event (it has `name` and `time` but no `trace`), **[REC]** synthesise the header `{file_schema: sequential, serialization_format: "application/qlog+json-seq", trace: {event_schemas: [], vantage_point: {type: "unknown"}}}`, emit the warning `seq.missing-header`, and treat every record as an event. qvis aborted in this case (`textsequencejsontoqlog.ts:26-30`).
  - **[REC, optional]** A later record with both `file_schema` and `trace` (for example after `cat a.sqlog b.sqlog`) starts a new trace.
- **Normalisation:** convert to the same in-memory shape as a contained file: `{...headerWithoutTrace, traces: [{...header.trace, events: remainingRecords}]}`. This is exactly what qvis does (`textsequencejsontoqlog.ts:33-55`), and everything downstream (P6 onward) is then format-agnostic. Remember the original serialization for Stats.

### P6. Validate the file header

```ts
const CONTAINED = "urn:ietf:params:qlog:file:contained";
const SEQUENTIAL = "urn:ietf:params:qlog:file:sequential";
```

- `root` must be a JSON object; otherwise raise the error `file.not-object`.
- **Legacy:** if `root.qlog_version !== undefined && root.file_schema === undefined`, raise the error `file.legacy-qlog`: "This file uses legacy qlog (qlog_version '<v>'). qvis-react supports only draft-ietf-quic-qlog-main-schema-14 files (file_schema urn:ietf:params:qlog:file:contained / :sequential)." See section 27 and the open questions.
- `file_schema`:
  - `CONTAINED`: expect `traces`.
  - `SEQUENTIAL`: expect `trace`. A contained-parsed file carrying a sequential header and a single `trace` with an `events` member is accepted leniently.
  - Missing: warning `file.missing-file-schema`; infer from structure (`traces` means contained, `trace` means sequential).
  - Another absolute URI: warning `file.unknown-file-schema`; proceed if `traces` or `trace` exists.
- `serialization_format`:
  - Compare with `value.split(";")[0].trim().toLowerCase()`.
  - Missing: warning.
  - A value that does not match the detected bytes (for example `application/qlog+json` on JSON-SEQ bytes): warning only. The bytes win.
  - Lenient mapping: `json` → JSON, `json-seq` → SEQ.
- Keep `title` and `description`. They map to the qvis `ConnectionGroup.title` / `description` (`src/data/ConnectionGroup.ts`), and are shown in the file list as `getShorthand()` (`src/data/ConnectionGroup.ts:37-60`) and in Stats (`src/components/stats/StatisticsRenderer.vue:20-27`).
- Unknown top-level members are ignored, but kept for the raw view.

### P7. Normalise traces

- Contained: if `traces` is absent, the file has zero traces (info "file contains no traces"). If it is not an array, raise an error.
- For each entry:
  - `typeof entry.error_description === "string"`: a **TraceError** placeholder (see section 4.3).
  - Otherwise a **Trace**:
    - `event_schemas`: an array of strings. If missing or invalid, use `[]` and emit the warning `trace.missing-event-schemas`. **[REC, lenient]** The -10 to -11 changelog says "move event_schemas to Trace and TraceSeq", which implies (we infer) that it previously lived at the file level. Fall back to `root.event_schemas` if present.
    - `events`: an array. If missing, use `[]` and emit a warning.
    - `common_fields`: an object, or `{}`.
    - `vantage_point`: an object with a valid `type`. Otherwise apply the qvis default `{type: "unknown", flow: "unknown", name: "No VantagePoint set"}`. Keep an unknown `type` value raw for display, but treat it as `"unknown"` for perspective logic.
    - Unknown trace members are ignored.

### P8. Normalise events (per serialized trace, in **file order**, index `i`)

- A non-object entry: skip it, with the warning `event.not-object`.
- An empty object `{}`: skip it silently. This is the qvis "trailing comma" accommodation (`src/data/QlogLoaderV2.ts:93-96`, `:123-127`).
- `time`:
  - number: use it.
  - numeric string: `parseFloat`, with the warning `event.time-string`, once.
  - Anything else (missing or NaN): the warning `event.missing-time`. Set **resolved** time to the previous event's resolved time, or 0 for the first event, so the event keeps its logged position. Flag the event as `malformed`.
- `name`:
  - string: split at the **first** `:` into `namespace` and `type`.
  - No colon: namespace `"unknown"` and type = the whole name (qvis parity, `src/data/QlogLoaderV2.ts:331-341`), with the warning `event.name-without-namespace`.
  - Missing: `"unknown:unknown"`, with a warning.
- `data`:
  - A plain object: use it.
  - Missing: `{}`, with a warning.
  - Any other type: `{}` for typed access, keeping the raw value for display, with a warning.
- Effective shared fields: `eff(k) = ev[k] !== undefined ? ev[k] : common_fields[k]`, for `time_format`, `reference_time`, `group_id`, `tuple`, `system_info` and any custom key (section 11).
- Do **not** mutate or lower-case `data`. Keep the original object for the raw-JSON views.

### P9. Resolve timestamps (per serialized trace, file order)

```ts
const UNIX_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

// Step A: delta decoding -> "resolved" = ms since the (effective) epoch
let prev: number | undefined;
for (const ev of events) {
  const fmt = (eff(ev, "time_format") ?? "relative_to_epoch") as string;
  let t = ev.timeNumber;                                     // from P8; NaN if malformed
  let resolved: number;
  if (!Number.isFinite(t)) resolved = prev ?? 0;             // malformed (P8)
  else if (fmt === "relative_to_previous_event") resolved = prev === undefined ? t : prev + t;
  else {
    if (fmt !== "relative_to_epoch") diag.warn("event.unknown-time-format", fmt); // treat as relative_to_epoch
    resolved = t;
  }
  ev.resolvedTime = resolved;
  prev = resolved;
}

// Step B: epoch per event
function epochMsOf(ref: unknown): number | null {
  if (ref === undefined) return 0;                           // CDDL defaults: system clock, Unix epoch [INTERP]
  if (typeof ref !== "object" || ref === null) {             // legacy numeric reference_time (lenient)
    const n = Number(ref); return Number.isFinite(n) ? n : null;
  }
  const r = ref as { clock_type?: string; epoch?: string };
  if (r.epoch === undefined || r.epoch === "unknown") return null;
  if (r.clock_type === "monotonic") diag.warn("time.monotonic-with-epoch");   // spec: MUST be "unknown"; still honour it
  return parseRfc3339Ms(r.epoch);                            // null if unparseable (+ warning)
}

// RFC 3339 -> ms since Unix epoch, keeping sub-ms precision.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
export function parseRfc3339Ms(s: string): number | null {
  const m = RFC3339.exec(s.trim());
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  const [, Y, Mo, D, h, mi, sec, frac, z, sign, oh, om] = m;
  const d = new Date(0);
  d.setUTCFullYear(+Y, +Mo - 1, +D);                        // avoids Date.UTC's 0..99 => 19xx quirk
  d.setUTCHours(+h, +mi, Math.min(+sec, 59), 0);            // leap second 60 -> 59
  let ms = d.getTime() + (frac ? parseFloat(frac) * 1000 : 0);
  if (z !== "Z" && z !== "z") ms -= (sign === "+" ? 1 : -1) * ((+oh) * 60 + (+om)) * 60000;
  return ms;
}
```

- Absolute calendar time of an event: `epochMs(eff(ev, "reference_time")) + resolvedTime`, when the epoch is known.
- **Precision:** Unix-ms values near 1.7e12 have a float64 ulp of about 0.24 µs. Compute **relative** values as `resolved − resolvedStart`, in the resolved domain, never as the difference of two absolute values.

### P10. Order (per serialized trace, after P9)

- Check that `resolvedTime` is non-decreasing in file order.
- If it is not, run a **stable** sort by `resolvedTime`. `Array.prototype.sort` is stable since ES2019; tie-break on the original index anyway. Emit the warning `trace.reordered`.
  - **[QVIS]** qvis used an `alert()` for this, including the claim "the qlog spec requires absolutely ordered timestamps", which is no longer true (`src/data/QlogLoaderV2.ts:157-186`).
- Equal timestamps are legal: keep the logged order.
- Delta decoding always happens **before** sorting.

### P11. Split by group (per trace, after P9; before or after P10, which is equivalent with a stable sort)

- Use the rule in section 10. Each group becomes one internal "connection" with its parent trace's `title`, `description`, `vantage_point`, `common_fields` and `event_schemas`.
- With a single group, or no `group_id` at all, the result is one connection.

### P12. Derive the per-connection time model (qvis parity)

qvis views consume four values per event or connection:
- `relativeTime`: the x-axes of most views.
- `absoluteTime`: multi-trace alignment in the sequence diagram.
- `getAbsoluteStartTime()`.
- `getTimeTrackingMethod()`: `ABSOLUTE_TIME` or `RELATIVE_TIME`; `DELTA_TIME` was converted at load time (`src/data/QlogEventParser.ts:3-7`, `src/data/QlogLoaderV2.ts:276-507`).

**[REC]** Map the new time semantics onto that contract as follows. `epochMs` is that of the connection's effective `reference_time`: `common_fields`, else the first event's. `start` is the minimum `resolvedTime` (that is, the first event after P10).

| Case | Detect | `absoluteTime` | `relativeTime` | `absoluteStartTime` | method | Old-qlog equivalent |
|---|---|---|---|---|---|---|
| A: Unix epoch | `epochMs === 0`, including absent `reference_time` | `resolved` | `resolved − start` | `start` | ABSOLUTE | `time_format: "absolute"` |
| R: dated epoch | `epochMs` is a non-zero number | `epochMs + resolved` | `resolved` | `epochMs` | RELATIVE | `time_format: "relative"` + `reference_time` |
| U: unknown epoch | `epochMs === null` (monotonic, `"unknown"`, unparseable) | `resolved − start` | `resolved − start` | `0` | RELATIVE | `"relative"` without `reference_time`: qvis assumed 0 (`QlogLoaderV2.ts:455-459`) |

- Case U keeps the sequence diagram's "no reference_time" fallback working: it sets one side's reference to the other's start ±5 ms (`src/components/sequencediagram/renderer/SequenceDiagramD3Renderer.ts:624-639`). The trace also starts at 0 instead of at some arbitrary monotonic origin, which avoids absurd x-axis ranges. The congestion graph had to hack around exactly those (`src/components/congestiongraph/renderer/CongestionGraphD3Renderer.ts:522-533`).
- Case R reproduces qvis behaviour exactly, including `relativeTime` values that may start well above 0.
- `timeOffset` came from `configuration.time_offset`, which no longer exists (section 27). It is always `0` at load, and only UI state, such as the sequence-diagram manual offset, changes it.
- `timeToMilliseconds(x)` becomes `parseFloat(x)`, because there is no `time_units` any more.
- `setReferenceTime(ms)` sets `absoluteStartTime = ms` and recomputes `absoluteTime` for cases R and U (sequence diagram only).
- **Optional display value:** `calendarTime = epochMs !== null ? epochMs + resolved : (wall_clock_time ? parseRfc3339Ms(wall_clock_time) + (resolved − start) : null)`. It is informational only (section 8.2 [INTERP]).
- **Mixed per-event `reference_time` values** within one connection: compute `absoluteTime` per event from its own epoch, and derive the case from the connection-level reference. Emit the warning `time.mixed-reference-times`.

### P13. Unknown events and fields

- Keep **every** event, whatever its namespace or type. Index events by `namespace` → `type` → events. This is the equivalent of qvis `Connection.lookupTable` / `lookup(category, type)` (`src/data/Connection.ts:126-161`), with namespace in place of category.
- Unknown events MUST NOT break any view. They SHOULD appear in generic places: the Stats per-namespace/type table (`src/components/stats/StatisticsConnectionRenderer.vue:40-63`), event detail panes and timelines that show "other" events.
- Unknown members in `data`, the event, the trace or `common_fields` are preserved for raw display and otherwise ignored.

### P14. Event schema sanity check (diagnostics only)

- Compute the set of namespaces observed in events.
- `info` for namespaces observed without a matching `event_schemas` entry.
- ~~`info` for listed schemas whose namespace never appears.~~ Dropped at the final parity check: the spec allows it
  ("listed schemas need not have all their events present"), and quic-go lists `loglevel` in every trace, so the Stats
  Diagnostics row showed this line for every demo file.
- `info` for draft-suffixed URIs whose draft number differs from the supported one (for example `quic-12` while qvis-react targets `quic-13`).
- Never `error`: §8 says tools MUST NOT treat these as errors.

### P15. Per-view capability check

Each view declares the event names and `data` members it needs. If a connection lacks them, the view shows a clear message (§13). Example: "This trace contains no `quic:packet_sent` / `quic:packet_received` events; the congestion graph needs them."

---

## 23. Suggested TypeScript types (raw input shapes)

```ts
export const FILE_SCHEMA_CONTAINED = "urn:ietf:params:qlog:file:contained";
export const FILE_SCHEMA_SEQUENTIAL = "urn:ietf:params:qlog:file:sequential";
export const MEDIA_TYPE_JSON = "application/qlog+json";
export const MEDIA_TYPE_JSON_SEQ = "application/qlog+json-seq";
export const RECORD_SEPARATOR = "\u001e";

export type Uint64 = number | string;     // I-JSON: MAY be a decimal string
export type HexString = string;           // /^([0-9a-f]{2})*$/

export interface LogFile {
  file_schema: string;
  serialization_format: string;
  title?: string;
  description?: string;
}
export interface QlogFile extends LogFile { traces?: Array<Trace | TraceError>; }
export interface QlogFileSeq extends LogFile { trace: TraceSeq; }

export interface TraceSeq {
  title?: string;
  description?: string;
  common_fields?: CommonFields;
  vantage_point?: VantagePoint;
  event_schemas: string[];               // [+text]
}
export interface Trace extends TraceSeq { events: QlogEvent[]; }
export interface TraceError {
  error_description: string;
  uri?: string;
  vantage_point?: VantagePoint;
}

export type VantagePointType = "client" | "server" | "network" | "unknown";
export type VantagePointFlow = "client" | "server" | "unknown";
export interface VantagePoint { name?: string; type: VantagePointType; flow?: VantagePointFlow; }

export type ClockType = "system" | "monotonic" | (string & {});
export interface ReferenceTime {
  clock_type: ClockType;                  // .default "system"
  epoch: string;                          // RFC 3339 date-time or "unknown"
  wall_clock_time?: string;               // RFC 3339
}
export type TimeFormat = "relative_to_epoch" | "relative_to_previous_event";
export type TupleID = string;             // .default ""
export type GroupID = string;
export interface SystemInformation { processor_id?: number; process_id?: number; thread_id?: number; }

export interface CommonFields {
  tuple?: TupleID;
  time_format?: TimeFormat;
  reference_time?: ReferenceTime;
  group_id?: GroupID;
  [custom: string]: unknown;
}

export interface QlogEvent<D extends object = Record<string, unknown>> {
  time: number;                           // float64 ms
  name: string;                           // "namespace:event_type"
  data: D;
  tuple?: TupleID;
  time_format?: TimeFormat;
  group_id?: GroupID;
  system_info?: SystemInformation;
  reference_time?: ReferenceTime;         // legal via the CommonFields "on each event" rule (§7.5)
  [custom: string]: unknown;
}

export interface RawInfo { length?: Uint64; payload_length?: Uint64; data?: HexString; }

// loglevel namespace
export interface LogLevelError   { code?: Uint64; message?: string; [ext: string]: unknown; }
export interface LogLevelWarning { code?: Uint64; message?: string; [ext: string]: unknown; }
export interface LogLevelInfo    { message: string; [ext: string]: unknown; }
export interface LogLevelDebug   { message: string; [ext: string]: unknown; }
export interface LogLevelVerbose { message: string; [ext: string]: unknown; }
// simulation namespace
export interface SimulationScenario { name?: string; details?: Record<string, unknown>; [ext: string]: unknown; }
export interface SimulationMarker   { type?: string; message?: string; [ext: string]: unknown; }
```

Suggested normalised event, the output of P8 to P12:

```ts
export interface ParsedEvent {
  raw: QlogEvent;            // untouched input object
  index: number;             // original position in the serialized trace
  namespace: string;         // "quic"
  type: string;              // "packet_sent"
  name: string;              // "quic:packet_sent"
  data: Record<string, unknown>;
  resolvedTime: number;      // ms since effective epoch, after delta decoding
  relativeTime: number;      // P12
  absoluteTime: number;      // P12
  groupId?: string;          // effective
  tuple?: string;            // effective, default ""
  malformed?: string[];      // e.g. ["time"]
}
```

---

## 24. Pitfalls in the -14 text

These are errata; the editor's copy fixes them. Do not paste -14 examples into test fixtures without checking them.

1. **Invalid JSON in the examples:**
   - Trailing commas in Figures 6, 10, 18, 19, 20, 24 and 41.
   - The unquoted key `{ type: "server" }` in Figure 8.
   - The unquoted `additional_field: true` in Figure 29.
2. Figure 6 and Figure 15 use the uppercase key `"ODCID"`, which contradicts §11.1 ("all qlog field names MUST be lowercase"). [ED] uses `"odcid"`.
3. Figure 24 uses `"http:frame_parsed"`; the HTTP/3 namespace is `http3`. `http` is the Capsule Protocol namespace (h3-events-13 §5). [ED] uses `"http3:frame_parsed"`.
4. Figure 28 writes `MyNSEvent1 /= {`, a CDDL typo for `=`.
5. Figure 29 still shows `packet_size` inside `QUICPacketSent`, even though #495 moved all lengths to `raw.length`. [ED] shows `"raw": {"length": 1280}`.
6. The §16.2 informative references point at quic-events-12 and h3-events-12; the current drafts are -13.

---

## 25. Fixture checklist (what tests should cover)

- Contained file with 1 trace; with 3 traces (client, server, network+flow); with a `TraceError`; with `traces` absent.
- JSON-SEQ:
  - header plus events with multi-line records;
  - double RS;
  - an invalid record in the middle (must continue);
  - a truncated final record;
  - a missing header;
  - no RS at all (lenient json-lines).
- A truncated contained JSON file (missing `]}]}`); a file with trailing garbage after the root.
- Time:
  - Unix-epoch ms (case A);
  - a dated epoch (case R);
  - a monotonic `"unknown"` epoch with `wall_clock_time` (case U);
  - `relative_to_previous_event`;
  - a per-event `time_format` mix;
  - a per-event `reference_time`;
  - out-of-order events with equal timestamps (stable sort);
  - a negative delta.
- `group_id`:
  - in `common_fields` only (no split);
  - per event, with 2 groups;
  - per event, with some events missing it.
- uint64 as strings in `data` (`packet_number`, `stream_id`, `raw.length`) and as numbers.
- Unknown namespace events and unknown `data` members: no crash, and listed in Stats.
- `name` without a colon; `name` with two colons.
- `event_schemas` with draft-suffixed URIs (`quic-13`), extension fragments, private URIs, and missing entirely.
- A legacy `qlog_version: "0.3"` file: a clear error.

---

## 26. Diff vs the editor's copy

The editor's copy is `draft-ietf-quic-qlog-main-schema.md` @ `71e0358`, 2026-11-01. All **normative CDDL is identical**; this was verified programmatically. The only difference is the comment text in `TraceError`. Post-14 commits touching the main schema include #622 (shared timestamps and ordering), #614 (name-uniqueness rules), #610/#620 (`keys_unavailable`), an editorial QUIC file-naming change, and title-case headings.

| # | Location | -14 | Editor's copy | Affects parsing? |
|---|---|---|---|---|
| 1 | §7.1 ordering (#622) | "SHOULD be logged in strictly ascending timestamp order … Tools MAY sort …" | Non-decreasing order; equal timestamps explicitly allowed; "Tools cannot rely on … time order"; a **stable sort** preserves the logged order of equal times; with deltas, no logged `time` is negative | **Yes.** Always check order, use a stable sort, and never treat equal times as errors (P10). |
| 2 | §7.1 `relative_to_previous_event` | "A delta-encoded value, based on the previously logged value" | "the duration since the time of the previously logged event" | **Yes,** when formats are mixed: the base is the previous event's resolved time (P9). |
| 3 | §8.2.1 trigger example (#610/#620) | `"key_unavailable"` | `"keys_unavailable"` | **Yes** for `quic:packet_dropped` `data.trigger`: accept both. |
| 4 | §7.5 CommonFields example | `"http:frame_parsed"` | `"http3:frame_parsed"` | **Yes** (namespace confirmation): HTTP/3 events are `http3:*`. |
| 5 | §8.2 `QUICPacketSent` example | `? packet_size: uint16`, `header: QUICPacketHeader`, `? frames:[* QUICFrame]`; JSON has `"packet_size": 1280` | `header: PacketHeader`, `? frames: [* $QuicFrame]`, `? raw: RawInfo`; JSON has `"raw": {"length": 1280}`, plus `"stream_id": 0` on the stream frame | Indirectly: packet size is `data.raw.length`. |
| 6 | §5 QlogFileSeq | "the required 'trace' field contains a singular trace (Section 4.2)" | "contains a single TraceSeq" | Minor: the header's `trace` has no `events`. |
| 7 | §4.2 Trace | "a single trace only contains events for a single logical QUIC connection" | "typically contains" | Minor: do not assume one connection per trace (`group_id`). |
| 8 | §11.3 JSON interop | (none) | "A log that encodes them as JSON strings needs those values converted to numbers before it can be validated against the CDDL." | Yes, for any CDDL validator: normalise string uint64 first. |
| 9 | §8 name rules (#614) | Types and namespaces "MUST have a registered" identifier; extension identifier "globally-unique" | Registration only for RFC schemas; private schemas not listed "cannot rely on its event names being unique"; extension identifier unique **within the namespace** | No (do not assume private names are unique). |
| 10 | §7 prose | Optional fields: `time_format`, `tuple`, `group_id` | Adds `system_info` | No (already in the CDDL). |
| 11 | Examples | `"ODCID"`; trailing commas; unquoted keys | `"odcid"`; valid JSON | Test fixtures only. |
| 12 | §8.2 Figure 28 | `MyNSEvent1 /= {` | `MyNSEvent1 = {` | No. |
| 13 | §13 tooling | Indicate "qlog version(s), qlog format(s) …"; "default JSON format" | "serialization format(s) …"; "JSON format" | No (confirms there is no version concept). |
| 14 | §10 RawInfo | Lengths "should indicate the length of the full entity" | "should indicate the actual lengths as defined above" | No (clarifies that `payload_length` is still the payload length). |
| 15 | §4, §11.1 | "The default serialization format for QlogFile is JSON"; "JSON is the default qlog serialization" | "This document defines a JSON serialization for QlogFile"; sentence removed | No. |
| 16 | §8.3 importance example | No `packet_received`, so log `packets_acked` | Omit STREAM frame details, so log `stream_state_updated` | No. |
| 17 | §12.1 | ODCID naming "recommended" | "can use … see Section 1.1 of QLOG-QUIC" | No. |
| 18 | §14 | Prose | Restructured as bullets; adds keys and plaintext app data as most sensitive | No. |
| 19 | §15 | (none) | Media types gain "Fragment identifier considerations"; registry template: private schemas need not list event types | No. |
| 20 | §4.3 | Comment "used for attempted find of the file" | "used in the attempt to find the file" | No. |
| 21 | Front matter | L. Pardue: Cloudflare | Apple | No. |

**[REC]** Implement the union: everything accepted by -14 **plus** the editor's-copy clarifications (rows 1 to 4 and 8). None of them conflict on accepted input.

---

## 27. Diff vs old qlog (draft-02 / `qlog_version` "0.3", as used by qvis)

qvis accepts `qlog_version` in {`"draft-02"`, `"draft-02-RC1"`, `"qlog-03-WIP"`, `"0.3"`} through `QlogLoaderV2` (`src/data/QlogSchema02.ts:13`, `src/data/QlogLoader.ts:30-31`). It also accepts older `"0.1"`, `"draft-00"`, `"draft-01"` and `"draft-02-wip"` files through `QlogLoader` (`src/data/QlogLoader.ts:14-45`). The old types are in `src/data/QlogSchema02.ts`.

### 27.1 Side-by-side example

Old (qlog 0.3, contained):

```json
{
  "qlog_version": "0.3",
  "qlog_format": "JSON",
  "title": "t", "description": "d", "summary": { },
  "traces": [{
    "vantage_point": { "name": "srv", "type": "server" },
    "title": "conn 1", "description": "",
    "configuration": { "time_offset": "0", "time_units": "ms", "original_uris": [] },
    "common_fields": { "group_id": "7e37e4dcc6682da8", "protocol_type": "QUIC_HTTP3",
                       "reference_time": "1564658098991", "time_format": "relative" },
    "events": [ { "time": 0.5, "name": "transport:packet_sent", "data": { } } ]
  }]
}
```

New (main-schema-14, contained):

```json
{
  "file_schema": "urn:ietf:params:qlog:file:contained",
  "serialization_format": "application/qlog+json",
  "title": "t", "description": "d",
  "traces": [{
    "vantage_point": { "name": "srv", "type": "server" },
    "title": "conn 1", "description": "",
    "common_fields": { "group_id": "7e37e4dcc6682da8", "time_format": "relative_to_epoch",
                       "reference_time": { "clock_type": "system", "epoch": "2019-08-01T11:14:58.991Z" } },
    "event_schemas": [ "urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13" ],
    "events": [ { "time": 0.5, "name": "quic:packet_sent", "data": { } } ]
  }]
}
```

Old JSON-SEQ header record (qvis `textsequencejsontoqlog.ts:26`):
`<RS>{"qlog_version":"0.3","qlog_format":"JSON-SEQ","trace":{"vantage_point":{…},"common_fields":{…}}}`

New:
`<RS>{"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"application/qlog+json-seq","trace":{"vantage_point":{…},"common_fields":{…},"event_schemas":[…]}}`

### 27.2 File level

| Old (qvis `IQLog`, `QlogSchema02.ts:22-31`) | New | Notes for the tool |
|---|---|---|
| `qlog_version: string` (required; qvis rejects files without it: `QlogLoader.ts:39-43`, `ConnectionStore.ts:240,282,380`) | **Removed.** `file_schema: <absolute URI>` (required) | No version number. Identity comes from the file schema URI plus event schema URIs (draft suffix `-NN`). Old `qlog_version` "0.4" (from main-schema-06) is also legacy. |
| `qlog_format?: "JSON" \| "NDJSON" \| "JSON-SEQ"` (default JSON; `QlogSchema02.ts:16-20`) | `serialization_format: <media type>` (required, case-insensitive): `application/qlog+json` or `application/qlog+json-seq` | **NDJSON is gone** (replaced by JSON-SEQ in main-schema-01). |
| `title?`, `description?` | Same | |
| `summary?: any` | **Removed** (main-schema-06) | Stats "Summary" row disappears (`StatisticsRenderer.vue:32-35`). |
| `traces: Array<ITrace \| ITraceError>` (required) | `traces?: [+ Trace / TraceError]` (optional; at least 1 if present) | Handle absence. |
| JSON-SEQ header `{qlog_version, qlog_format: "JSON-SEQ", trace}` | `{file_schema: …:sequential, serialization_format: application/qlog+json-seq, trace: TraceSeq}` | Same record structure; new key names. |
| Stats shows "qlog version" (`StatisticsRenderer.vue:28-31`) | Show `file_schema`, `serialization_format` and each trace's `event_schemas` | Parity replacement. |

### 27.3 Trace level

| Old (`ITrace`, `QlogSchema02.ts:40-50`) | New `Trace` / `TraceSeq` | Notes |
|---|---|---|
| `vantage_point` (required) | `vantage_point?` (optional) | Values unchanged (`client`, `server`, `network`, `unknown`; `flow`). |
| `title?`, `description?` | Same | |
| `configuration?: {time_offset?, time_units?: "ms"\|"us", original_uris?, …}` (`QlogSchema02.ts:77-85`) | **Removed** (main-schema-06) | No `time_units`: always ms. qvis multiplied by 0.001 for `"us"` (`QlogLoaderV2.ts:430-432`). No `time_offset`: qvis treated a non-zero file offset as "manually set" (`SequenceDiagramD3Renderer.ts:600-603`); it is now always 0. `original_uris` has no replacement (`TraceError.uri` is the closest). |
| `common_fields?: {group_id?: string\|Array, protocol_type?: string, reference_time?: string, time_format?: "absolute"\|"relative"\|"delta", …}` (`QlogSchema02.ts:93-103`) | `common_fields?: {tuple?, time_format?: "relative_to_epoch"\|"relative_to_previous_event", reference_time?: ReferenceTime, group_id?: text, * any}` | See 27.5 for time. `protocol_type` became `protocol_types` (main-schema-10), which was then **removed** in favour of `event_schemas` (main-schema-11). qvis branched on `protocol_type` `"TCP"` / `"TCP_HTTP2"` (`CongestionGraphD3Renderer.ts:1288`, `PacketizationDiagramD3Renderer.ts:119`); derive the protocol from namespaces instead. `group_id` is text only (qvis stringified arrays). |
| (none) | `event_schemas: [+text]` (**required**) | New. A hint only. |
| `event_fields?: string[]`, with events as arrays (draft-01 CSV-like; removed in draft-02, but qvis still accepted it: `QlogLoaderV2.ts:60-66`, `EventFieldsParser` at `QlogLoader.ts:714-967`) | **Removed** | Events are always JSON objects. |
| `events: IEvent[]` | `events: [* Event]` (contained); separate records (JSON-SEQ) | |
| `ITraceError {error_description, uri (required), vantage_point?}` (`QlogSchema02.ts:33-38`) | `TraceError {error_description, uri?, vantage_point?}` | `uri` became optional. |

### 27.4 Event level

| Old (`IEvent`, `QlogSchema02.ts:52-62`) | New `Event` | Notes |
|---|---|---|
| `time: number` (semantics depend on `time_format`; possibly µs) | `time: float64` ms (required) | See 27.5. qvis tolerated string times through `parseFloat`; keep that leniency. |
| `name?: "category:type"`, or separate `category?` and `type?`; draft-01 arrays `[time, category, event, trigger, data]` | `name: "namespace:event_type"` (**required**) | No `category` or `type` members, and no `common_fields.category` / `name` fallbacks (`QlogLoaderV2.ts:394-400`). **Categories no longer exist** (main-schema-10, #439); namespaces belong to event schemas. |
| `data` | `data: $ProtocolEventData` (required) | Event data shapes changed substantially; see the QUIC and HTTP/3 digests. |
| `trigger` as a top-level event field (draft-01 `event_fields`) | `data.trigger` (string, RECOMMENDED convention) | Already in `data` in draft-02. |
| `[k: string]: any` (for example per-event `group_id` or `time_format`, which qvis **ignored** per event) | Officially: `tuple?`, `time_format?`, `group_id?`, `system_info?`, `* any`; plus any `CommonFields` key, `reference_time` included | **Per-event `time_format` and `reference_time` must now be honoured** (P8, P9). |
| (none) | `tuple?: TupleID` | New (formerly `path` in main-schema-08 to -12). |
| (none) | `system_info?: SystemInformation` | New (main-schema-06). |
| `group_id: string \| Array<any>` | `group_id: text` | |
| `IRawInfo {length?, payload_length?, data?}` (`QlogSchema02.ts:124-129`) | `RawInfo` (same members), `data: hexstring` | Same. Packet size is `raw.length`; qvis's auto-move of `header.packet_size` (`QlogLoaderV2.ts:198-226`) is no longer needed. |
| `quint64 = number \| string`, `qbytes = string` (`QlogSchema02.ts:121-122`) | `uint64` (number in the CDDL; MAY be a string in JSON), `hexstring` (lowercase, even length) | Same practical handling. |
| Uppercase names in draft-00 (`CATEGORY`, `EVENT_TYPE`), which qvis lower-cased (`QlogLoader.ts:814-835`) | All field names MUST be lowercase | No case folding needed. |

### 27.5 Time semantics

| Old `common_fields.time_format` | Old meaning (qvis: `QlogLoaderV2.ts:402-496`) | New equivalent | P12 case |
|---|---|---|---|
| `"absolute"`, or absent with no `reference_time` | `time` = ms since the Unix epoch | `relative_to_epoch` with `epoch: "1970-01-01T00:00:00.000Z"`, or no `reference_time` at all | A |
| `"relative"`, or absent with a `reference_time` | `time` = ms since `reference_time`, a **numeric string** of Unix ms; qvis also tried `Date.parse` (`QlogLoaderV2.ts:522-548`) | `relative_to_epoch` with `reference_time: {clock_type: "system", epoch: "<RFC 3339>"}` | R |
| `"relative"` without `reference_time` | qvis assumed 0 and logged an error (`QlogLoaderV2.ts:455-459`) | `reference_time.epoch: "unknown"` (for example a monotonic clock) | U |
| `"delta"` | `time` = delta to the previous event; the first event is relative to `reference_time` if present, otherwise absolute; converted at load (`QlogLoaderV2.ts:461-496`) | `relative_to_previous_event`; the first event is relative to `ReferenceTime` | per epoch |
| `configuration.time_units: "us"` | ×0.001 | Always ms | |
| `configuration.time_offset` | Added to every time | Removed | |
| `reference_time: "1564658098.991056"` (draft-01 sample: *seconds*, `public/standalone_data/draft-01/new_cid.qlog`) | `parseFloat` | An object `{clock_type, epoch, wall_clock_time?}` | |
| (none) | | `clock_type`: `system`, `monotonic`, … | New |
| (none) | | `wall_clock_time` | New |

Additional changes:
- Ordering: qvis treated out-of-order traces as a spec violation and showed an `alert()`. The new rules: SHOULD be non-decreasing, tools cannot rely on it, use a stable sort.
- Mixed formats: old qvis applied one format per trace. The new spec allows per-event `time_format`.

### 27.6 Categories to namespaces (headline mapping)

Only for the names qvis views use. The QUIC and HTTP/3 digests are authoritative for event names and data members.

| Old `category:event` (qvis enum) | New `name` |
|---|---|
| `connectivity:server_listening`, `connection_started`, `connection_id_updated`, `spin_bit_updated`, `connection_state_updated` | `quic:<same>` |
| (none) | `quic:connection_closed`, `quic:tuple_assigned`, `quic:mtu_updated` (new) |
| `transport:parameters_set` | `quic:parameters_set` (also `quic:parameters_restored`, `quic:version_information`, `quic:alpn_information`) |
| `transport:packet_sent` / `packet_received` / `packet_dropped` / `packet_buffered` | `quic:packet_sent` / `quic:packet_received` / `quic:packet_dropped` / `quic:packet_buffered` |
| `transport:datagrams_sent` / `datagrams_received` / `datagram_dropped` | `quic:udp_datagrams_sent` / `quic:udp_datagrams_received` / `quic:udp_datagram_dropped` |
| `transport:frames_processed` | `quic:frames_processed` (also `quic:frames_created`, `quic:frames_parsed`) |
| `transport:stream_state_updated` | `quic:stream_state_updated` |
| `http:data_moved` (`HTTP3EventType.data_moved`) | `quic:stream_data_moved` (and `quic:datagram_data_moved`) |
| `security:key_updated` / `key_retired` | `quic:key_updated` / `quic:key_discarded` |
| `recovery:parameters_set` | `quic:recovery_parameters_set` |
| `recovery:metrics_updated` | `quic:recovery_metrics_updated` |
| `recovery:congestion_state_updated` | `quic:congestion_state_updated` |
| `recovery:loss_timer_updated` / `loss_timer_set` / `loss_timer_triggered` | `quic:timer_updated` |
| `recovery:packet_lost` / `marked_for_retransmit` | `quic:packet_lost` / `quic:marked_for_retransmit` |
| `http:parameters_set`, `stream_type_set`, `frame_created`, `frame_parsed` | `http3:<same>` (plus `http3:parameters_restored`, `priority_updated`, `datagram_created`, `datagram_parsed`, `push_resolved`) |
| `http:dependency_update` | approximately `http3:priority_updated` (the priority scheme changed; see the HTTP/3 digest) |
| `qpack:*` (all) | **Removed** (h3-events changelog, "Removed all qpack event definitions (#335)") |
| `error:connection_error` / `application_error` / `internal_error` `{code?, description?}` | `loglevel:error {code?, message?}`; connection-level errors are also `quic:connection_closed` |
| `warning:internal_warning {code?, description?}` | `loglevel:warning {code?, message?}` |
| `info:message` / `debug:message` / `verbose:message` `{message}` | `loglevel:info` / `loglevel:debug` / `loglevel:verbose` `{message}` |
| `simulation:marker {marker_type, message?}` | `simulation:marker {type?, message?}` |
| `simulation:scenario` | `simulation:scenario {name?, details?}` |

**[REC]** Internally, replace qvis's `(category, eventType)` lookup key with `(namespace, type)`. Replace the `qlog.EventCategory.*` constants with namespace constants: about 44 call sites, mostly `transport` (23), `http` (11) and `recovery` (6).

### 27.7 Formats and extensions

| qvis (`FileLoader.ts:169-197`) | New spec |
|---|---|
| `.qlog`: JSON, or sniffed by `qlog_format` | `.qlog` = `application/qlog+json` (contained) |
| `.sqlog`, `.qlogseq`: JSON-SEQ | `.sqlog` = `application/qlog+json-seq` (sequential). `.qlogseq` is non-standard; accepting it is harmless. |
| `.qlognd`: NDJSON | Not in the spec. Only reachable through the lenient "json-lines" mode. |
| `.json`: sniff | Not in the spec; sniff the content. |
| `.netlog`, `.pcap.json`, `.pcap` + `.keys`, `.pcapng`: converted to **draft-01 / draft-02** qlog (`netlogtoqlog.ts:888`, `tcptoqlog.ts:31`, server-side pcap2qlog) | Out of scope for the main schema. If kept, these converters must emit the **new** format, or legacy handling is needed (open question). |

### 27.8 qvis behaviours to drop or replace

- The `alert()` on misordered timestamps and on draft-02 non-compliance (`QlogLoaderV2.ts:185`, `:257`). Use non-modal diagnostics instead.
- The draft-02 auto-fixes (`data.packet_type` → `header.packet_type`, `header.packet_size` → `raw.length`; `QlogLoaderV2.ts:188-241`). They are irrelevant for -14 input and can be dropped.
- Splitting only when the first event has `group_id` (`QlogLoaderV2.ts:82`). Use the effective-value rule (section 10).
- Ignoring per-event `time_format` and `reference_time`. Honour them (P9).
- Requiring `qlog_version` at load (`ConnectionStore.ts:282`, `:380`). Detect `file_schema` instead.

---

## 28. Open questions for the orchestrator

1. **Legacy input.** The user asked to support **only** the latest drafts, but "drop-in replacement" users will open old `qlog_version` 0.3 / 0.4 files (and qvis's own netlog and pcap converters produce draft-01/02). The recommended default is a clear, non-crashing error (P6). An optional legacy-to-14 converter is possible but out of scope unless requested.
2. **Event schema draft numbers.** Accept every `-NN` suffix and also the final URIs, with diagnostics only. Confirm whether -13 should be *the* target, given that the editor's copies are newer.
3. **Unknown-epoch time model (P12 case U).** Normalising to the first event (relative = absolute = `resolved − start`, start = 0) is our recommendation. Confirm it against the parity owners of the sequence diagram and the congestion graph.
4. **Lenient extensions.** These go beyond the spec but cost little: newline-delimited sequential files without RS, numeric `reference_time`, top-level `event_schemas`, extra headers in a JSON-SEQ file, `.qlogseq` and `.qlognd`. Recommended: keep them, each with a warning.
5. **Compression** of local uploads (`.gz` via `DecompressionStream`; Brotli has no portable browser API). qvis did not support it locally, so it is optional.
