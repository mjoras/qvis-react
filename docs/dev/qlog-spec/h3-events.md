# HTTP/3 (and HTTP Capsule) qlog events: implementation digest

Digest of **draft-ietf-quic-qlog-h3-events-13** for qvis-react, with a mapping from the old qlog draft-02 HTTP events that qvis reads and a list of differences from the editor's copy.

| Item | Value |
|---|---|
| Published draft | `draft-ietf-quic-qlog-h3-events-13`, dated 6 July 2026, expires 7 January 2027 |
| Editors | R. Marx (Akamai), L. Niccolini (Meta), M. Seemann, L. Pardue (Cloudflare in -13, Apple in the editor's copy) |
| Source text | `ref/drafts/draft-ietf-quic-qlog-h3-events-13.txt` (paths in this document are relative to the scratchpad `ref/` folder unless they are qvis paths) |
| Editor's copy | `ref/qlog-wg/draft-ietf-quic-qlog-h3-events.md` (`docname: draft-ietf-quic-qlog-h3-events-latest`). It has no "Since -13" change-log entry. |
| Companion drafts | main schema -14 and QUIC events -13. **Erratum:** -13's own References section still cites `draft-ietf-quic-qlog-main-schema-13` and `draft-ietf-quic-qlog-quic-events-12`. Treat main-schema-14 and quic-events-13 as authoritative. |
| qvis reference | `ref/qvis/visualizations/src/...`; citations below use `path:line` relative to `src/`. |

Section numbers such as "§3.5" refer to the -13 draft.

---

## 0. TL;DR for implementers

1. The document defines **two namespaces**:
   - **`http3`** (HTTP/3 events). Schema URI `urn:ietf:params:qlog:events:http3`.
   - **`http`** (Capsule Protocol events). Schema URI `urn:ietf:params:qlog:events:http`.
2. Event `name` = `<namespace>:<event_type>`, for example `"http3:frame_created"` (main-schema-14 §8: "The value of a qlog event name field MUST be the concatenation of namespace identifier, colon (':'), and event type identifier"). There is **no `category` field** any more.
3. **Do not confuse namespaces.** In old qvis, category `http` meant HTTP/3 (`QlogSchema02.ts:140`). In the new drafts, `http` means the Capsule Protocol and HTTP/3 is `http3`. Never map `http:*` to HTTP/3 handling.
4. These are the 11 events. The ones qvis visualizes are frame_created and frame_parsed, plus parameters_set, which the sequence diagram labels and colors:

   | name | importance | qvis uses it |
   |---|---|---|
   | `http3:parameters_set` | Base | sequence diagram (label + color) |
   | `http3:parameters_restored` | Base | generic display only |
   | `http3:stream_type_set` | Base | generic display only (the netlog converter emits it) |
   | `http3:priority_updated` | Base | generic display only (did not exist before) |
   | `http3:frame_created` | **Core** | **multiplexing (waterfall, simulation), sequence, stats, packetization** |
   | `http3:frame_parsed` | **Core** | **same as above** |
   | `http3:datagram_created` | Base | generic display only |
   | `http3:datagram_parsed` | Base | generic display only |
   | `http3:push_resolved` | Extra | generic display only |
   | `http:capsule_created` | Core | generic display only (new) |
   | `http:capsule_parsed` | Core | generic display only (new) |

5. Breaking field changes that affect qvis code paths:
   - `byte_length` (event level) becomes **`frame.raw.payload_length`**, or is derived from `frame.raw.length`.
   - Event-level `raw` (hex string) becomes **`frame.raw.data`**. `raw` is now a `RawInfo` object **inside the frame**.
   - PRIORITY_UPDATE `frame.element_id` becomes **`frame.stream_id`** or **`frame.push_id`**, and `frame.value` becomes **`frame.priority_field_value`**.
   - GOAWAY `stream_id` becomes **`id`**.
   - `stream_type_set.new` becomes **`stream_type`**, `"data"` becomes **`"request"`**, and `owner` becomes **`initiator`**.
   - `parameters_set.owner` becomes `initiator`, and `max_header_list_size` becomes `max_field_section_size`.
   - Header entries (`HTTP3HTTPField`) have **all fields optional**: `name` / `name_bytes` / `value` / `value_bytes`.
   - IDs are **uint64 numbers** (they may arrive as JSON strings, per main-schema-14 §11.3), not strings.
   - Old `data_moved` becomes **`quic:stream_data_moved`**, with the length in `raw.length`.
6. Accept the **union** of -13 and the editor's copy (Section 11). For example, accept both `"http_early_response"` and `"http_message_error"`, accept `unknown_settings`, and accept `raw` on ORIGIN frames.

---

## 1. Scope (Section 1)

The document covers:

- Core HTTP/3 ([RFC 9114]).
- Extended CONNECT ([RFC 9220]).
- PRIORITY_UPDATE (Section 7 of [RFC 9218]).
- ORIGIN ([RFC 9412]).
- HTTP/3 Datagrams (Section 2.1 of [RFC 9297]).
- The HTTP Capsule Protocol (Section 3 of [RFC 9297]), in the separate `http` namespace.

It does **not** cover:

- **QPACK.** All QPACK events were removed in h3-events-06 (#335). The latest drafts have no `qpack` namespace.
- HTTP/2.
- WebTransport.
- The data movement between HTTP and QUIC. That is in QUIC events: `quic:stream_data_moved`, `quic:datagram_data_moved`.

### 1.1 Usage with QUIC (§1.1)

- The HTTP/3 events can be logged with or without the QUIC events.
- When they are logged together, the QUIC document's guidance on file naming and trace separation takes precedence.
- Without QUIC events, an implementation is recommended to assign a globally unique ID per HTTP/3 connection. That ID is used as `group_id` and as the filename, optionally with a vantage-point suffix, for example `abcd1234_server.qlog`.

### 1.2 Notational conventions (§1.2)

- The CDDL uses the qlog extensions from main schema §1.2.
- Imported from the main schema: `name`, `namespace`, `type`, `data`, `group_id`, `RawInfo`, and the time-related fields.
- The definitions are serialization-agnostic.

The base types come from main-schema-14 Figure 1:

```cddl
uint16 = uint .size 2
uint64 = uint .size 8
; an even-length lowercase string of hexadecimally encoded bytes
hexstring = text .regexp "([0-9a-f]{2})*"
```

`RawInfo` comes from main-schema-14, Figure 40:

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

For an HTTP/3 frame:

- `raw.length` = frame type varint + length varint + payload.
- `raw.payload_length` = payload only. This is the old qvis `byte_length`.
- `raw.data` is the frame bytes, possibly truncated.
- If `data` is present and `length` is absent, the data is the full value, so length = `data.length / 2` (main-schema-14 §11.4).

**JSON numbers (main-schema-14 §11.3):** "serializers MAY encode uint64 values using JSON strings. qlog parsers, therefore, SHOULD support parsing of uint64 values from JSON strings or JSON numbers". Every `uint64` below, including `stream_id`, `push_id`, `frame_type_bytes`, and setting `value`, can be a JSON number **or** a numeric string.

### 1.3 Importance levels (main-schema-14 §8.3)

| Level | Meaning |
|---|---|
| **Core** | "SHOULD be present in all qlog files for a given protocol". Tools "SHOULD expect and add support for these events", but SHOULD NOT expect every Core event in every trace. |
| **Base** | "MAY be present". Tools "SHOULD at least add support for showing the contents of these events". |
| **Extra** | Mostly for low-level implementation debugging. Tools "MAY add support". |

### 1.4 Tooling expectations (main-schema-14 §8.4)

"Tools SHOULD allow for the presence of unknown event fields and make an effort to visualize even unknown data if possible, otherwise they MUST ignore it." Every event defined here ends with a `* $$<socket>` group socket, so arbitrary extra keys are legal everywhere.

---

## 2. Namespaces, schema URIs, and draft identification

| | HTTP/3 (§2) | HTTP / Capsule (§5) |
|---|---|---|
| Namespace identifier | `http3` | `http` |
| Final RFC schema URI | `urn:ietf:params:qlog:events:http3` | `urn:ietf:params:qlog:events:http` |
| URI for draft -13 implementations | `urn:ietf:params:qlog:events:http3-13` | `urn:ietf:params:qlog:events:http-13` |
| Event types (IANA, §9) | parameters_set, parameters_restored, stream_type_set, priority_updated, frame_created, frame_parsed, datagram_created, datagram_parsed, push_resolved | capsule_created, capsule_parsed |

§2.1 and §5.1 (to be removed in the RFC) say: "Implementations of draft versions of the event schema MUST append the string "-" and the corresponding draft number to the URI ... The namespace identifier itself is not affected by this requirement."

Consequences for qvis-react:

- Event names are always `http3:…` and `http:…`, never `http3-13:…`.
- Schema URIs appear in the trace's `event_schemas` array (main-schema-14). That array is a **hint**, not a guarantee (main-schema-14 §8.1 and §15).
- **Detect HTTP/3 support from event names, not only from `event_schemas`.** Accept `urn:ietf:params:qlog:events:http3` with or without any `-NN` suffix. Do the same for `…:http`.

Both namespaces extend `$ProtocolEventData` (main-schema-14 §8.2). Figure 1 and Figure 28, verbatim:

```cddl
HTTP3EventData = HTTP3ParametersSet /
              HTTP3ParametersRestored /
              HTTP3StreamTypeSet /
              HTTP3PriorityUpdated /
              HTTP3FrameCreated /
              HTTP3FrameParsed /
              HTTP3DatagramCreated /
              HTTP3DatagramParsed /
              HTTP3PushResolved

$ProtocolEventData /= HTTP3EventData
```

```cddl
HTTPEventData = HTTPCapsuleCreated /
                HTTPCapsuleParsed

$ProtocolEventData /= HTTPEventData
```

### 2.1 Relationship to QUIC events (§3 intro)

- "HTTP events are logged when a certain condition happens at the application layer, and there isn't always a one to one mapping between HTTP and QUIC events."
- The exchange of data between HTTP and QUIC is logged with **`quic:stream_data_moved`** and **`quic:datagram_data_moved`**.
- "HTTP/3 frame headers are represented by the frame_created and frame_parsed events. Subsequent frame payload data transfer is indicated by stream_data_moved events."
- "stream_data_moved events can appear before frame_parsed events because implementations need to read data from a stream in order to parse the frame header."

Ordering consequences that qvis already handles. Keep that handling, see `PacketizationQUICPreProcessor.ts:58-205` and `:408-449`:

- `frame_created` usually appears **before** the `quic:packet_sent` that carries it.
- `frame_parsed` usually appears **after** the `quic:packet_received` events that carry its header.
- A large frame has **one** `frame_*` event, logged for its header. Its payload can span many QUIC packets with no further HTTP/3 events.

---

## 3. HTTP/3 events (namespace `http3`)

The CDDL in this section is verbatim from -13. The editor's-copy differences are marked with "**Editor's copy:**".

### 3.1 `http3:parameters_set` (Base, §3.1)

- Contains HTTP/3 and QPACK-level settings, "mostly those received from the HTTP/3 SETTINGS frame".
- The settings are typically set once. They may be set at different times, so a trace can contain **multiple** `parameters_set` events with different fields set.
- `initiator` is `"local"` for settings this endpoint sent and `"remote"` for settings it received.
  - **Erratum in -13:** the prose says received settings "have the value "received"". That is not a legal `Initiator` value. The editor's copy fixes it to `"remote"`. Treat any value other than `"local"` as remote.

```cddl
HTTP3ParametersSet = {
    ? initiator: Initiator

    ; RFC9114
    ? max_field_section_size: uint64

    ; RFC9204
    ? max_table_capacity: uint64
    ? blocked_streams_count: uint64

    ; RFC9220 (SETTINGS_ENABLE_CONNECT_PROTOCOL)
    ? extended_connect: uint16

    ; RFC9297 (SETTINGS_H3_DATAGRAM)
    ? h3_datagram: uint16

    ; qlog-specific
    ; indicates whether this implementation waits for a SETTINGS
    ; frame before processing requests
    ? waits_for_settings: bool

    * $$http3-parametersset-extension
}
```

- -13 says: "The parameters_set event can contain any number of unspecified fields. This allows for representation of reserved settings (aka GREASE) or ad-hoc support for extension settings that do not have a related qlog schema definition."
- Field-to-SETTINGS mapping:

  | Field | Setting | ID |
  |---|---|---|
  | `max_field_section_size` | SETTINGS_MAX_FIELD_SECTION_SIZE | 0x06 |
  | `max_table_capacity` | SETTINGS_QPACK_MAX_TABLE_CAPACITY | 0x01 |
  | `blocked_streams_count` | SETTINGS_QPACK_BLOCKED_STREAMS | 0x07 |
  | `extended_connect` | SETTINGS_ENABLE_CONNECT_PROTOCOL | 0x08 |
  | `h3_datagram` | SETTINGS_H3_DATAGRAM | 0x33 |

- **Editor's copy:**
  - `extended_connect` and `h3_datagram` are `uint64` instead of `uint16`.
  - A new field `? unknown_settings: [* HTTP3Setting]` holds "settings that this implementation does not recognize, including reserved (GREASE) settings". Each entry's `name` is `"unknown"` or `"reserved"`, and `name_bytes` holds the setting identifier.
  - The "any number of unspecified fields" paragraph is replaced. Extension settings go through `$$http3-parametersset-extension`.
- **qvis parity:** the sequence diagram shows `"<N> HTTP/3 parameters set"`, where N = `Object.keys(data).length`. That count includes `initiator` and any extra keys (`SequenceDiagramD3Renderer.ts:2050-2065`). The event color is the `max_data` color `["#5f0984","#FFFFFF"]` (`:1956-1962`).

### 3.2 `http3:parameters_restored` (Base, §3.2)

When using 0-RTT, a client reuses the server's SETTINGS from a previous connection. This event shows which settings were restored and their values.

```cddl
HTTP3ParametersRestored = {
    ; RFC9114
    ? max_field_section_size: uint64

    ; RFC9204
    ? max_table_capacity: uint64
    ? blocked_streams_count: uint64

    ; RFC9220 (SETTINGS_ENABLE_CONNECT_PROTOCOL)
    ? extended_connect: uint16

    ; RFC9297 (SETTINGS_H3_DATAGRAM)
    ? h3_datagram: uint16

    * $$http3-parametersrestored-extension
}
```

- There is no `initiator`. These are always the remote (server) settings as remembered by the client.
- **Editor's copy:**
  - The prose is rewritten to reference RFC 9114 §7.2.4.2, and adds "When the server's SETTINGS frame arrives, the settings it carries can be logged with the `parameters_set` event".
  - `extended_connect` and `h3_datagram` are `uint64`.
- **qvis parity:** qvis has no handling. The event shows as a generic event, using the default red color `["#FF0000","#FFFFFF"]` and the label = event type name.

### 3.3 `http3:stream_type_set` (Base, §3.3)

- Emitted when an HTTP/3 stream type becomes known (RFC 9114 §6.1 and §6.2).
- "Client bidirectional streams always have a stream_type value of "request". Server bidirectional streams have no defined use, although extensions could change that."
- Unidirectional streams start with a varint type. For unknown types, use `"unknown"` with `stream_type_bytes` = the numeric value without varint encoding.
- `$HTTP3StreamType` is a type socket and can be extended.

```cddl
HTTP3StreamTypeSet = {
    ? initiator: Initiator
    stream_id: uint64
    stream_type: $HTTP3StreamType

    ; only when stream_type === "unknown"
    ? stream_type_bytes: uint64

    ; only when stream_type === "push"
    ? associated_push_id: uint64

    * $$http3-streamtypeset-extension
}

$HTTP3StreamType /=   "request" /
                      "control" /
                      "push" /
                      "reserved" /
                      "unknown" /
                      "qpack_encode" /
                      "qpack_decode"
```

- `initiator` gives the side that opened the stream (local or remote). It was `owner` in older drafts.
- **Editor's copy:**
  - `stream_type_bytes` applies "only when stream_type === "unknown" or "reserved"".
  - The prose adds: "for a reserved type (Section 6.2.3 of RFC9114), it can be "reserved"".
- **qvis parity:** qvis consumes nothing from this event. It shows as a generic event. The netlog converter *produces* it (Section 10.7). qvis decides "data stream versus control stream" purely by `stream_id % 4 === 0` (`multiplexinggraph/renderer/MultiplexingGraphDataHelper.ts:5-7`), not from this event.

### 3.4 `http3:priority_updated` (Base, §3.4)

- Emitted when a request or push stream's priority is initialized or updated through RFC 9218 mechanisms.
- The update can come from signals (HEADERS `priority` field, PRIORITY_UPDATE frames) or from local policy. `trigger` and `reason` optionally capture why.

```cddl
HTTP3PriorityUpdated = {
    ; if the prioritized element is a request stream
    ? stream_id: uint64

    ; if the prioritized element is a push stream
    ? push_id: uint64

    ? old: HTTP3Priority
    new: HTTP3Priority

    ? trigger: "client_signal_received" /
                "local" /
                "other"

    ? reason: "client_signal_only" /
               "client_server_merged" /
               "local_policy" /
               "other"

    * $$http3-priorityupdated-extension
}
```

- `HTTP3Priority = text` is defined in §4.2.10, for example `"u=5, i"`.
- **Editor's copy:** the prose is reworded. The CDDL is identical.
- **qvis parity:** the event did not exist for qvis (the old `dependency_update` was HTTP/2-style and unused). It shows as a generic event. The waterfall builds priority info from HEADERS and PRIORITY_UPDATE **frames**, not from this event (Section 10.6.1). Using `priority_updated` there is an optional enhancement, not part of parity.

### 3.5 `http3:frame_created` (Core, §3.5)

- "emitted when the HTTP/3 framing actually happens".
- "does not necessarily coincide with HTTP/3 data getting passed to the QUIC layer. For that, see the stream_data_moved event".

```cddl
HTTP3FrameCreated = {
    stream_id: uint64
    frame: $HTTP3Frame

    * $$http3-framecreated-extension
}
```

**Editor's copy:** "emitted when an HTTP/3 frame is created". The CDDL is identical.

### 3.6 `http3:frame_parsed` (Core, §3.6)

- "emitted when the HTTP/3 frame is parsed".
- "not necessarily the same as when the HTTP/3 data is actually received on the QUIC layer".

```cddl
HTTP3FrameParsed = {
    stream_id: uint64
    frame: $HTTP3Frame

    * $$http3-frameparsed-extension
}
```

**Editor's copy:** "does not necessarily coincide with HTTP/3 data being passed from the QUIC layer". The CDDL is identical.

Notes for both frame events:

- `stream_id` is the QUIC stream the frame travels on.
  - For SETTINGS, GOAWAY, MAX_PUSH_ID, CANCEL_PUSH, PRIORITY_UPDATE, and ORIGIN, this is the **control stream** (for example 2 or 3), not the stream the frame is about.
- There are **no** event-level `byte_length`, `length`, or `raw` fields any more. Sizes live in `frame.raw` (see Section 4).

### 3.7 `http3:datagram_created` (Base, §3.7)

- Emitted when an HTTP/3 Datagram (RFC 9297 §2.1) is created.
- Content beyond the Quarter Stream ID is protocol-specific and can be added through the extension socket.
- Does not necessarily coincide with hand-off to QUIC. For that, see `quic:datagram_data_moved`.

```cddl
HTTP3DatagramCreated = {
    quarter_stream_id: uint64
    ? raw: RawInfo

    * $$http3-datagramcreated-extension
}
```

### 3.8 `http3:datagram_parsed` (Base, §3.8)

```cddl
HTTP3DatagramParsed = {
    quarter_stream_id: uint64
    ? raw: RawInfo

    * $$http3-datagramparsed-extension
}
```

`quarter_stream_id` = the associated client-initiated bidirectional request stream ID ÷ 4 (RFC 9297 §2.1). Display it as `stream_id = quarter_stream_id * 4`. qvis has no handling for either datagram event; they show as generic events.

### 3.9 `http3:push_resolved` (Extra, §3.9)

Emitted when a pushed resource (RFC 9114 §4.6) is claimed (used) or abandoned (rejected) by the application on top of HTTP/3, for example a browser.

```cddl
HTTP3PushResolved = {
    ? push_id: uint64

    ; in case this is logged from a place that does not have access
    ; to the push_id
    ? stream_id: uint64
    decision: HTTP3PushDecision

    * $$http3-pushresolved-extension
}

HTTP3PushDecision = "claimed" /
                 "abandoned"
```

qvis has no handling; it shows as a generic event.

---

## 4. HTTP/3 data types (§4)

### 4.1 Initiator (§4.1)

```cddl
Initiator = "local" /
            "remote"
```

(QUIC events -13 defines the same `Initiator`.)

### 4.2 `$HTTP3Frame` (§4.2)

```cddl
; The HTTP3Frame is any key-value map (e.g., JSON object)
$HTTP3Frame /= {
    * text => any
}
```

```cddl
HTTP3BaseFrames = HTTP3DataFrame /
                  HTTP3HeadersFrame /
                  HTTP3CancelPushFrame /
                  HTTP3SettingsFrame /
                  HTTP3PushPromiseFrame /
                  HTTP3GoawayFrame /
                  HTTP3MaxPushIDFrame /
                  HTTP3ReservedFrame /
                  HTTP3UnknownFrame

HTTP3ExtensionFrames = HTTP3PriorityUpdateFrame /
                       HTTP3OriginFrame

$HTTP3Frame /= HTTP3BaseFrames / HTTP3ExtensionFrames
```

Because the socket also allows `{* text => any}`, **any object is a valid frame**. Code must handle unknown `frame_type` strings (for example WebTransport frames from extensions) and a missing `frame_type`. Never crash; show the `frame_type` string, or "unknown".

| `frame_type` | CDDL type | Required fields | Optional fields | Wire type (RFC) |
|---|---|---|---|---|
| `"data"` | HTTP3DataFrame | none | raw | 0x00 |
| `"headers"` | HTTP3HeadersFrame | headers | raw | 0x01 |
| `"cancel_push"` | HTTP3CancelPushFrame | push_id | raw | 0x03 |
| `"settings"` | HTTP3SettingsFrame | settings | raw | 0x04 |
| `"push_promise"` | HTTP3PushPromiseFrame | push_id, headers | raw | 0x05 |
| `"goaway"` | HTTP3GoawayFrame | id | raw | 0x07 |
| `"max_push_id"` | HTTP3MaxPushIDFrame | push_id | raw | 0x0d |
| `"reserved"` | HTTP3ReservedFrame | frame_type_bytes | raw | 0x02, 0x06, 0x08, 0x09 (HTTP/2 legacy); 0x1f·N+0x21 (GREASE) |
| `"unknown"` | HTTP3UnknownFrame | frame_type_bytes | raw | anything else |
| `"priority_update"` | HTTP3PriorityUpdateFrame | priority_field_value | stream_id, push_id, raw | 0xF0700 (request stream), 0xF0701 (push stream) [RFC 9218] |
| `"origin"` | HTTP3OriginFrame | origin_entries | raw (editor's copy only) | 0x0c [RFC 9412] |

#### 4.2.1 HTTP3DataFrame

```cddl
HTTP3DataFrame = {
    frame_type: "data"
    ? raw: RawInfo
}
```

#### 4.2.2 HTTP3HeadersFrame and HTTP3HTTPField

- "The payload of an HTTP/3 HEADERS frame is the QPACK-encoding of an HTTP field section ... HTTP3HeadersFrame, in contrast, contains the HTTP field section without QPACK encoding."
- `raw.payload_length` is still the **QPACK-encoded** payload size on the wire.

```cddl
HTTP3HTTPField = {
    ? name: text
    ? name_bytes: hexstring
    ? value: text
    ? value_bytes: hexstring
}
```

```cddl
HTTP3HeadersFrame = {
    frame_type: "headers"
    headers: [* HTTP3HTTPField]
    ? raw: RawInfo
}
```

The example from -13 Figure 17, verbatim. It contains a bug: `:path` should be `/index.html`; the editor's copy fixes this.

```
headers: [
  {
    "name": ":path",
    "value": "/"
  },
  {
    "name": ":method",
    "value": "GET"
  },
  {
    "name": ":authority",
    "value": "example.org"
  },
  {
    "name": ":scheme",
    "value": "https"
  }
]
```

Rules from -13 §4.2.2:

- Characters allowed by RFC 9114 §4.2 and RFC 9110 §5.1 are logged in `name` and `value` (text).
- Characters outside that range "are unsafe for the text type and need to be logged using the name_bytes and value_bytes fields".
- "An instance of HTTP3HTTPField MUST include either the name or name_bytes field and MAY include both. An HTTP3HTTPField MAY include a value or value_bytes field or neither."

Implementation consequences:

- Use helpers for every header lookup: `fieldName(f) = f.name ?? hexToLatin1(f.name_bytes)` and `fieldValue(f) = f.value ?? (f.value_bytes ? hexToLatin1(f.value_bytes) : undefined)`.
- Header names are lowercase in HTTP/3; pseudo-headers start with `:`.
- qvis compares with `===` against `":method"`, `":path"`, `":authority"`, `":status"`, `"server"`, `"user-agent"`, and `"priority"`.

#### 4.2.3 HTTP3CancelPushFrame

```cddl
HTTP3CancelPushFrame = {
    frame_type: "cancel_push"
    push_id: uint64
    ? raw: RawInfo
}
```

#### 4.2.4 HTTP3SettingsFrame and HTTP3Setting

- Each setting's `name` is the Setting Name from the IANA "HTTP/3 Settings" registry, "as defined (or as would be defined if registered)".
- For unknown settings, use `name: "unknown"` with `name_bytes` = the numeric identifier without varint encoding.

```cddl
HTTP3SettingsFrame = {
    frame_type: "settings"
    settings: [* HTTP3Setting]
    ? raw: RawInfo
}

HTTP3Setting = {
    ? name: $HTTP3SettingsName
    ; only when name === "unknown"
    ? name_bytes: uint64

    value: uint64
}

$HTTP3SettingsName /= "settings_qpack_max_table_capacity" /
                   "settings_max_field_section_size" /
                   "settings_qpack_blocked_streams" /
                   "settings_enable_connect_protocol" /
                   "settings_h3_datagram" /
                   "reserved" /
                   "unknown"
```

| `name` | Wire ID | Source | Corresponding `parameters_set` field |
|---|---|---|---|
| `settings_qpack_max_table_capacity` | 0x01 | RFC 9204 | `max_table_capacity` |
| `settings_max_field_section_size` | 0x06 | RFC 9114 | `max_field_section_size` |
| `settings_qpack_blocked_streams` | 0x07 | RFC 9204 | `blocked_streams_count` |
| `settings_enable_connect_protocol` | 0x08 | RFC 9220 | `extended_connect` |
| `settings_h3_datagram` | 0x33 | RFC 9297 | `h3_datagram` |
| `reserved` | 0x00, 0x02 to 0x05 (HTTP/2 legacy), 0x1f·N+0x21 (GREASE) | RFC 9114 §7.2.4.1 and §11.2.2 | none |
| `unknown` | anything else | | none |

- Names are **lowercase snake_case**. Old qvis traces used uppercase `"SETTINGS_MAX_HEADER_LIST_SIZE"`.
- `name` itself is optional in the CDDL.
- **Editor's copy:**
  - `name_bytes` applies "only when name === "unknown" or "reserved"".
  - The prose adds: "for a reserved setting, it can be "reserved"".

#### 4.2.5 HTTP3PushPromiseFrame

```cddl
HTTP3PushPromiseFrame = {
    frame_type: "push_promise"
    push_id: uint64
    headers: [* HTTP3HTTPField]
    ? raw: RawInfo
}
```

#### 4.2.6 HTTP3GoawayFrame

```cddl
HTTP3GoawayFrame = {
    frame_type: "goaway"

    ; Either stream_id or push_id.
    ; This is implicit from the sender of the frame
    id: uint64
    ? raw: RawInfo
}
```

A GOAWAY sent by the server carries a client-initiated bidirectional stream ID. A GOAWAY sent by the client carries a push ID (RFC 9114 §5.2).

#### 4.2.7 HTTP3MaxPushIDFrame

```cddl
HTTP3MaxPushIDFrame = {
    frame_type: "max_push_id"
    push_id: uint64
    ? raw: RawInfo
}
```

#### 4.2.8 HTTP3ReservedFrame

"The frame_type_bytes field is the numerical value without variable-length integer encoding."

```cddl
HTTP3ReservedFrame = {
    frame_type: "reserved"
    frame_type_bytes: uint64
    ? raw: RawInfo
}
```

#### 4.2.9 HTTP3UnknownFrame

```cddl
HTTP3UnknownFrame = {
    frame_type: "unknown"
    frame_type_bytes: uint64
    ? raw: RawInfo
}
```

#### 4.2.10 HTTP3PriorityUpdateFrame and HTTP3Priority (priority structures)

The PRIORITY_UPDATE frame is defined in RFC 9218 §7.

```cddl
HTTP3PriorityUpdateFrame = {
    frame_type: "priority_update"

    ; if the prioritized element is a request stream
    ? stream_id: uint64

    ; if the prioritized element is a push stream
    ? push_id: uint64

    priority_field_value: HTTP3Priority
    ? raw: RawInfo
}

; The priority value in ASCII text, encoded using Structured Fields
; Example: u=5, i
HTTP3Priority = text
```

Two different stream IDs are involved:

- The **event-level** `data.stream_id` is the **control stream** that carries the frame.
- The **frame-level** `data.frame.stream_id` is the **prioritized request stream**.
- A push stream is prioritized with `frame.push_id` instead. The wire type is 0xF0701 in that case, and 0xF0700 for a request stream.

All priority-related structures in this draft:

- `HTTP3PriorityUpdateFrame` (this section).
- `HTTP3PriorityUpdated` (§3.4), with its `trigger` and `reason` enumerations.
- `HTTP3Priority = text`.
- The HTTP `priority` header, which appears as an ordinary `HTTP3HTTPField` with `name: "priority"` inside `headers`.

RFC 9218 background, not qlog normative but useful for display: the Structured Field dictionary has `u` (urgency 0 to 7, default 3) and `i` (incremental boolean, default false). `"u=5, i"` means urgency 5, incremental.

#### 4.2.11 HTTP3OriginFrame

The ORIGIN frame is defined in RFC 9412 §2.

```cddl
HTTP3OriginEntry = {
  origin_len: uint16
  ? ascii_origin: text
}

HTTP3OriginFrame = {
  frame_type: "origin"

  origin_entries: [* HTTP3OriginEntry]
}
```

-13 omits `raw` here, unlike every other frame. **Editor's copy** adds `? raw: RawInfo`. Accept it.

### 4.3 HTTP3ApplicationError (§4.3)

```cddl
HTTP3ApplicationError = "http_no_error" /
                       "http_general_protocol_error" /
                       "http_internal_error" /
                       "http_stream_creation_error" /
                       "http_closed_critical_stream" /
                       "http_frame_unexpected" /
                       "http_frame_error" /
                       "http_excessive_load" /
                       "http_id_error" /
                       "http_settings_error" /
                       "http_missing_settings" /
                       "http_request_rejected" /
                       "http_request_cancelled" /
                       "http_request_incomplete" /
                       "http_early_response" /
                       "http_connect_error" /
                       "http_version_fallback"
```

"The HTTP3ApplicationError extends the general $ApplicationError definition in the qlog QUIC document":

```cddl
; ensure HTTP errors are properly validated in QUIC events as well
; e.g., QUIC's ConnectionClose Frame
$ApplicationError /= HTTP3ApplicationError
```

The values appear in QUIC events -13, not in any `http3` event:

- `ConnectionCloseFrame.error` (when `error_space: "application"`).
- `ResetStreamFrame.error`, `ResetStreamAtFrame.error`, and `StopSendingFrame.error`.
- `quic:connection_closed.application_error`.

In each case, a numeric `error_code` is present when the string is `"unknown"`. `"unknown"` itself comes from QUIC's `$ApplicationError /= "unknown"`.

| qlog string | RFC name | Code |
|---|---|---|
| http_no_error | H3_NO_ERROR | 0x0100 |
| http_general_protocol_error | H3_GENERAL_PROTOCOL_ERROR | 0x0101 |
| http_internal_error | H3_INTERNAL_ERROR | 0x0102 |
| http_stream_creation_error | H3_STREAM_CREATION_ERROR | 0x0103 |
| http_closed_critical_stream | H3_CLOSED_CRITICAL_STREAM | 0x0104 |
| http_frame_unexpected | H3_FRAME_UNEXPECTED | 0x0105 |
| http_frame_error | H3_FRAME_ERROR | 0x0106 |
| http_excessive_load | H3_EXCESSIVE_LOAD | 0x0107 |
| http_id_error | H3_ID_ERROR | 0x0108 |
| http_settings_error | H3_SETTINGS_ERROR | 0x0109 |
| http_missing_settings | H3_MISSING_SETTINGS | 0x010a |
| http_request_rejected | H3_REQUEST_REJECTED | 0x010b |
| http_request_cancelled | H3_REQUEST_CANCELLED | 0x010c |
| http_request_incomplete | H3_REQUEST_INCOMPLETE | 0x010d |
| **http_early_response** (-13) / **http_message_error** (editor's copy) | H3_MESSAGE_ERROR (RFC 9114; earlier HTTP/3 drafts used "early response") | 0x010e |
| http_connect_error | H3_CONNECT_ERROR | 0x010f |
| http_version_fallback | H3_VERSION_FALLBACK | 0x0110 |
| *(editor's copy only)* qpack_decompression_failed | QPACK_DECOMPRESSION_FAILED (RFC 9204) | 0x0200 |
| *(editor's copy only)* qpack_encoder_stream_error | QPACK_ENCODER_STREAM_ERROR (RFC 9204) | 0x0201 |
| *(editor's copy only)* qpack_decoder_stream_error | QPACK_DECODER_STREAM_ERROR (RFC 9204) | 0x0202 |
| *(editor's copy only)* http_datagram_error | H3_DATAGRAM_ERROR (RFC 9297) | 0x33 |
| unknown (from QUIC) | any other value; numeric value in `error_code` | |

The mapping of `http_early_response` to 0x010e is corroborated by pcap2qlog (`pcap2qlog/src/parsers/ParserPCAP.ts:1093-1094`, which maps 0x010e to `http_early_response`). GREASE codes 0x1f·N+0x21 are reserved and appear as `"unknown"`.

---

## 5. HTTP (Capsule) events (namespace `http`, §5 and §6)

These are new; qvis has no counterpart.

### 5.1 `http:capsule_created` (Core, §6.1)

- Emitted when a Capsule is created (RFC 9297 §3).
- "In HTTP/3, capsules are sent inside DATA frames, so the frame_created event would be logged separately". The editor's copy says "can be logged separately".

```cddl
HTTPCapsuleCreated = {
    stream_id: uint64

    capsule: $HTTPCapsule

    * $$http-capsulecreated-extension
}
```

### 5.2 `http:capsule_parsed` (Core, §6.2)

```cddl
HTTPCapsuleParsed = {
    stream_id: uint64

    capsule: $HTTPCapsule

    * $$http-capsuleparsed-extension
}
```

### 5.3 `$HTTPCapsule` (§7.1)

```cddl
; The HTTPCapsule is any key-value map (e.g., JSON object)
$HTTPCapsule /= {
    * text => any
}
```

```cddl
HTTPBaseCapsules = HTTPCapsuleDatagram /
                   HTTPCapsuleUnknown

$HTTPCapsule /= HTTPBaseCapsules
```

```cddl
HTTPCapsuleDatagram = {
    capsule_type: "datagram"
    ? raw: RawInfo
}
```

"The capsule_type_value field is the numerical value without variable-length integer encoding."

```cddl
HTTPCapsuleUnknown = {
    capsule_type: "unknown"

    ? capsule_type_value: uint64
    ? raw: RawInfo
}
```

- The DATAGRAM capsule type is 0x00 (RFC 9297).
- **Naming inconsistency:** this uses `capsule_type_value`, whereas frames, streams, and settings use `*_bytes`, and the field is optional here. Both -13 and the editor's copy agree on this.
- Capsule events carry `data.capsule`, not `data.frame`. Code that counts "frames" by checking `data.frame` (as the qvis stats do) correctly ignores them.

---

## 6. IANA (§9) and security (§8)

- §9 registers the two schema URIs in the "qlog event schema URIs" registry, with the namespaces and event types listed in Section 2.
- §8: the security and privacy considerations of main-schema §14 apply. This matters for headers and `raw.data`; implementations may omit them.

---

## 7. Numeric code reference

These values come from the HTTP/3 RFCs, not the qlog draft. They are needed by visualizations such as packetization, which computes frame header sizes with varint lengths, and for showing `*_bytes` values.

**HTTP/3 frame types** (RFC 9114 §7.2 and §11.2.1, plus extensions):

| Frame | Code | Source |
|---|---|---|
| DATA | 0x00 | |
| HEADERS | 0x01 | |
| CANCEL_PUSH | 0x03 | |
| SETTINGS | 0x04 | |
| PUSH_PROMISE | 0x05 | |
| GOAWAY | 0x07 | |
| ORIGIN | 0x0c | RFC 9412 |
| MAX_PUSH_ID | 0x0d | |
| PRIORITY_UPDATE (request) | 0xF0700 | RFC 9218 |
| PRIORITY_UPDATE (push) | 0xF0701 | RFC 9218 |
| reserved (HTTP/2 legacy) | 0x02, 0x06, 0x08, 0x09 | |
| reserved (GREASE) | 0x1f·N+0x21 | |

**Unidirectional stream types** (RFC 9114 §6.2 and §11.2.4, RFC 9204 §4.2):

| Stream type | qlog value | Code |
|---|---|---|
| control | "control" | 0x00 |
| push | "push" | 0x01 |
| QPACK encoder | "qpack_encode" | 0x02 |
| QPACK decoder | "qpack_decode" | 0x03 |
| reserved (GREASE) | "reserved" | 0x1f·N+0x21 |

Bidirectional streams have no type byte; a client-initiated bidirectional stream is `"request"`.

**Settings:** see Section 4.2.4. **Errors:** see Section 4.3. **Capsules:** DATAGRAM = 0x00.

**Varint length** (RFC 9000 §16), used for H3 frame header sizes:

| Value range | Encoded size |
|---|---|
| ≤ 63 | 1 byte |
| ≤ 16383 | 2 bytes |
| ≤ 1073741823 | 4 bytes |
| otherwise | 8 bytes |

qvis has this as `PacketizationPreprocessor.VLIELength`, `packetizationdiagram/renderer/PacketizationDiagramModels.ts:111-137`.

**QUIC stream ID helpers** (RFC 9000 §2.1): `id & 0x3` gives

| Value | Stream kind |
|---|---|
| 0 | client-initiated bidirectional |
| 1 | server-initiated bidirectional |
| 2 | client-initiated unidirectional |
| 3 | server-initiated unidirectional |

qvis' `isDataStream` is `id % 4 === 0`. The packetization code treats (id+1)%4==0 and (id+2)%4==0 as control-stream data (`PacketizationQUICPreProcessor.ts:481-503`).

---

## 8. TypeScript types (implementation-ready)

This is a reader-side model covering the **union of -13 and the editor's copy**. All maps are open, because of the `$$` sockets.

```ts
// ---- primitives (main-schema-14) ----
/** uint64: JSON number OR decimal string (main-schema-14 §11.3). Normalize with toNumber/toBigInt. */
export type UInt64 = number | string;
/** even-length lowercase hex */
export type HexString = string;
export interface RawInfo {
  length?: UInt64;          // full entity incl. headers (H3: type varint + length varint + payload)
  payload_length?: UInt64;  // payload only (== old qvis byte_length)
  data?: HexString;         // possibly truncated
}
export type Initiator = 'local' | 'remote';

// ---- namespaces & names ----
export const NS_HTTP3 = 'http3';
export const NS_HTTP = 'http';                       // Capsule Protocol, NOT HTTP/3!
export const URI_HTTP3 = 'urn:ietf:params:qlog:events:http3'; // drafts: + '-13'
export const URI_HTTP = 'urn:ietf:params:qlog:events:http';   // drafts: + '-13'

export const HTTP3_EVENT_TYPES = [
  'parameters_set', 'parameters_restored', 'stream_type_set', 'priority_updated',
  'frame_created', 'frame_parsed', 'datagram_created', 'datagram_parsed', 'push_resolved',
] as const;
export type HTTP3EventType = typeof HTTP3_EVENT_TYPES[number];
export type HTTP3EventName = `http3:${HTTP3EventType}`;
export const HTTP_EVENT_TYPES = ['capsule_created', 'capsule_parsed'] as const;
export type HTTPEventName = `http:${typeof HTTP_EVENT_TYPES[number]}`;

export const IMPORTANCE: Record<HTTP3EventName | HTTPEventName, 'core' | 'base' | 'extra'> = {
  'http3:parameters_set': 'base', 'http3:parameters_restored': 'base',
  'http3:stream_type_set': 'base', 'http3:priority_updated': 'base',
  'http3:frame_created': 'core', 'http3:frame_parsed': 'core',
  'http3:datagram_created': 'base', 'http3:datagram_parsed': 'base',
  'http3:push_resolved': 'extra',
  'http:capsule_created': 'core', 'http:capsule_parsed': 'core',
};

type Ext = { [extension: string]: unknown };

// ---- event data ----
export interface HTTP3ParametersSet extends Ext {
  initiator?: Initiator;              // -13 prose typo says "received"; treat !== 'local' as remote
  max_field_section_size?: UInt64;
  max_table_capacity?: UInt64;
  blocked_streams_count?: UInt64;
  extended_connect?: UInt64;          // -13: uint16, editor's: uint64
  h3_datagram?: UInt64;               // -13: uint16, editor's: uint64
  waits_for_settings?: boolean;
  unknown_settings?: HTTP3Setting[];  // editor's copy only
}
export interface HTTP3ParametersRestored extends Ext {
  max_field_section_size?: UInt64;
  max_table_capacity?: UInt64;
  blocked_streams_count?: UInt64;
  extended_connect?: UInt64;
  h3_datagram?: UInt64;
}
export type HTTP3StreamType =
  | 'request' | 'control' | 'push' | 'reserved' | 'unknown' | 'qpack_encode' | 'qpack_decode'
  | (string & {});                    // $HTTP3StreamType is an extensible socket
export interface HTTP3StreamTypeSet extends Ext {
  initiator?: Initiator;
  stream_id: UInt64;
  stream_type: HTTP3StreamType;
  stream_type_bytes?: UInt64;         // when 'unknown' (editor's: or 'reserved')
  associated_push_id?: UInt64;        // when 'push'
}
export type HTTP3Priority = string;   // RFC 8941 structured field, e.g. "u=5, i"
export interface HTTP3PriorityUpdated extends Ext {
  stream_id?: UInt64;
  push_id?: UInt64;
  old?: HTTP3Priority;
  new: HTTP3Priority;
  trigger?: 'client_signal_received' | 'local' | 'other';
  reason?: 'client_signal_only' | 'client_server_merged' | 'local_policy' | 'other';
}
export interface HTTP3FrameCreated extends Ext { stream_id: UInt64; frame: HTTP3Frame; }
export interface HTTP3FrameParsed  extends Ext { stream_id: UInt64; frame: HTTP3Frame; }
export interface HTTP3DatagramCreated extends Ext { quarter_stream_id: UInt64; raw?: RawInfo; }
export interface HTTP3DatagramParsed  extends Ext { quarter_stream_id: UInt64; raw?: RawInfo; }
export type HTTP3PushDecision = 'claimed' | 'abandoned';
export interface HTTP3PushResolved extends Ext { push_id?: UInt64; stream_id?: UInt64; decision: HTTP3PushDecision; }

// ---- frames ----
export interface HTTP3HTTPField { name?: string; name_bytes?: HexString; value?: string; value_bytes?: HexString; }
export type HTTP3SettingsName =
  | 'settings_qpack_max_table_capacity' | 'settings_max_field_section_size'
  | 'settings_qpack_blocked_streams' | 'settings_enable_connect_protocol'
  | 'settings_h3_datagram' | 'reserved' | 'unknown' | (string & {});
export interface HTTP3Setting { name?: HTTP3SettingsName; name_bytes?: UInt64; value: UInt64; }
export interface HTTP3OriginEntry { origin_len: number; ascii_origin?: string; }

export interface HTTP3DataFrame        { frame_type: 'data'; raw?: RawInfo; }
export interface HTTP3HeadersFrame     { frame_type: 'headers'; headers: HTTP3HTTPField[]; raw?: RawInfo; }
export interface HTTP3CancelPushFrame  { frame_type: 'cancel_push'; push_id: UInt64; raw?: RawInfo; }
export interface HTTP3SettingsFrame    { frame_type: 'settings'; settings: HTTP3Setting[]; raw?: RawInfo; }
export interface HTTP3PushPromiseFrame { frame_type: 'push_promise'; push_id: UInt64; headers: HTTP3HTTPField[]; raw?: RawInfo; }
export interface HTTP3GoawayFrame      { frame_type: 'goaway'; id: UInt64; raw?: RawInfo; }
export interface HTTP3MaxPushIDFrame   { frame_type: 'max_push_id'; push_id: UInt64; raw?: RawInfo; }
export interface HTTP3ReservedFrame    { frame_type: 'reserved'; frame_type_bytes: UInt64; raw?: RawInfo; }
export interface HTTP3UnknownFrame     { frame_type: 'unknown'; frame_type_bytes: UInt64; raw?: RawInfo; }
export interface HTTP3PriorityUpdateFrame {
  frame_type: 'priority_update'; stream_id?: UInt64; push_id?: UInt64;
  priority_field_value: HTTP3Priority; raw?: RawInfo;
}
export interface HTTP3OriginFrame { frame_type: 'origin'; origin_entries: HTTP3OriginEntry[]; raw?: RawInfo /* editor's copy */; }
/** $HTTP3Frame socket: anything goes */
export interface HTTP3GenericFrame { frame_type?: string; raw?: RawInfo; [k: string]: unknown; }
export type HTTP3Frame =
  | HTTP3DataFrame | HTTP3HeadersFrame | HTTP3CancelPushFrame | HTTP3SettingsFrame
  | HTTP3PushPromiseFrame | HTTP3GoawayFrame | HTTP3MaxPushIDFrame | HTTP3ReservedFrame
  | HTTP3UnknownFrame | HTTP3PriorityUpdateFrame | HTTP3OriginFrame | HTTP3GenericFrame;

export type HTTP3ApplicationError =
  | 'http_no_error' | 'http_general_protocol_error' | 'http_internal_error'
  | 'http_stream_creation_error' | 'http_closed_critical_stream' | 'http_frame_unexpected'
  | 'http_frame_error' | 'http_excessive_load' | 'http_id_error' | 'http_settings_error'
  | 'http_missing_settings' | 'http_request_rejected' | 'http_request_cancelled'
  | 'http_request_incomplete'
  | 'http_early_response'   // -13
  | 'http_message_error'    // editor's copy (same code 0x010e)
  | 'http_connect_error' | 'http_version_fallback'
  | 'qpack_decompression_failed' | 'qpack_encoder_stream_error' | 'qpack_decoder_stream_error'
  | 'http_datagram_error';  // last four: editor's copy only

// ---- capsules (namespace http) ----
export interface HTTPCapsuleDatagram { capsule_type: 'datagram'; raw?: RawInfo; }
export interface HTTPCapsuleUnknown  { capsule_type: 'unknown'; capsule_type_value?: UInt64; raw?: RawInfo; }
export interface HTTPGenericCapsule  { capsule_type?: string; [k: string]: unknown; }
export type HTTPCapsule = HTTPCapsuleDatagram | HTTPCapsuleUnknown | HTTPGenericCapsule;
export interface HTTPCapsuleCreated extends Ext { stream_id: UInt64; capsule: HTTPCapsule; }
export interface HTTPCapsuleParsed  extends Ext { stream_id: UInt64; capsule: HTTPCapsule; }
```

### 8.1 Helper semantics (recommended)

```ts
export function splitEventName(name: string): { ns: string; type: string } {
  const i = name.indexOf(':');
  return i < 0 ? { ns: '', type: name } : { ns: name.slice(0, i), type: name.slice(i + 1) };
}
export function u64(v: UInt64 | undefined): number | undefined {           // display/arith
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);                         // > 2^53 loses precision; OK for viz
  return Number.isFinite(n) ? n : undefined;
}
const hexToLatin1 = (h: string) => h.replace(/../g, (b) => String.fromCharCode(parseInt(b, 16)));
export const fieldName  = (f: HTTP3HTTPField) => f.name  ?? (f.name_bytes  !== undefined ? hexToLatin1(f.name_bytes)  : undefined);
export const fieldValue = (f: HTTP3HTTPField) => f.value ?? (f.value_bytes !== undefined ? hexToLatin1(f.value_bytes) : undefined);

/** wire frame type for varint-size computation (packetization); default 0 mirrors qvis */
export function h3FrameTypeNumber(f: HTTP3Frame): number {
  switch (f.frame_type) {
    case 'data': return 0x00; case 'headers': return 0x01; case 'cancel_push': return 0x03;
    case 'settings': return 0x04; case 'push_promise': return 0x05; case 'goaway': return 0x07;
    case 'origin': return 0x0c; case 'max_push_id': return 0x0d;
    case 'priority_update': return (f as HTTP3PriorityUpdateFrame).push_id !== undefined ? 0xF0701 : 0xF0700;
    case 'reserved': case 'unknown': return u64((f as HTTP3UnknownFrame).frame_type_bytes) ?? 0;
    default: return 0x00;
  }
}
export const vlieLength = (v: number) => (v <= 63 ? 1 : v <= 16383 ? 2 : v <= 1073741823 ? 4 : 8);

/** replacement for old qvis `byte_length` (= frame PAYLOAD length) */
export function h3FramePayloadLength(f: HTTP3Frame): number | undefined {
  const raw = f.raw;
  if (!raw) return undefined;
  const pl = u64(raw.payload_length);
  if (pl !== undefined) return pl;
  const total = u64(raw.length) ?? (raw.data !== undefined ? raw.data.length / 2 : undefined);
  if (total === undefined) return undefined;
  const t = vlieLength(h3FrameTypeNumber(f));
  for (const l of [1, 2, 4, 8]) {                 // unique solution assuming minimal varint encoding
    const p = total - t - l;
    if (p >= 0 && vlieLength(p) === l) return p;
  }
  return undefined;
}
```

Caveat: if an implementation uses non-minimal varint encodings for frame lengths, the payload derived from `raw.length` can be off by a few bytes. Prefer `raw.payload_length` whenever it is present.

### 8.2 Recommended tolerant-reader policy

- Dispatch on the full name: `ns === 'http3' && type === 'frame_created'`.
  - For **qvis parity** in the sequence-diagram color and label code, qvis matched on the **type part only** (Section 10.6.3). Reproduce that where noted.
- Normalize every `UInt64` through `u64()` before arithmetic or comparison. Compare stream IDs numerically or via `String(n)`.
- Unknown `frame_type`, `stream_type`, or `capsule_type` strings: display them as-is; never throw.
- Accept both `http_early_response` and `http_message_error`.
- Accept the `unknown_settings` array; accept extra keys everywhere.
- `HTTP3HTTPField` lookups always go through `fieldName()` and `fieldValue()`.

---

## 9. Change log of the h3 draft (for context)

From -13 "Change Log", identical in the editor's copy:

| Since | Changes |
|---|---|
| -12 | Added HTTP3OriginFrame (#504). Added Capsule Protocol support (#504). Editorial changes. |
| -11 | "Replaced all length fields with raw.length (#495)". "Renamed owner to initiator (#498)". |
| -09 | "Consistent use of RawInfo and _bytes fields to log raw data (#450)": `*_value` became `*_bytes`, except `capsule_type_value`, which came later. |
| -08 | Removed individual categories; every event is in the single `http3` namespace (#439). Protocol id changed from `HTTP3` to `HTTP/3` (#428). |
| -06 | ProtocolEventBody is now ProtocolEventData (#352). |
| -05 | **Removed all qpack event definitions (#335).** |
| -04 | Renamed the `http` category to `h3` (#300), later superseded by `http3`. `H3HTTPField.value` became optional (#296). Added RFC 9297 datagrams (#310), RFC 9218 priorities (#312), and RFC 9220 extended CONNECT (#325). |
| -03 | `raw_stream_type` to `stream_type_value`, and `raw_frame_type` to `frame_type_value` (#54), later becoming `*_bytes`. `max_header_list_size` to `max_field_section_size` (#282). |
| -02 | `HTTPStreamType` `data` to `request` (#222). Added stream type `unknown` (#227). Added `HTTPUnknownFrame` (#224). `old`/`new` replaced by `stream_type` in `stream_type_set` (#240). `HTTPFrame` became a CDDL plug type (#257). |
| -00 | TypeScript definitions became CDDL (#143). |
| draft-marx-…-01 | Moved `data_moved` from http to transport. Removed `push_allowed` from `http:parameters_set` (#110). |

---

## 10. Diff vs old qlog draft-02 HTTP events (as used by qvis)

"Old" here means `data/QlogSchema02.ts` (draft-02 schema, which qvis applies to all loaded files after upgrading draft-00 and draft-01) plus what qvis code actually reads. qvis-react supports **only** the new format. This mapping tells implementers what to read in place of each old access.

### 10.1 Envelope and naming

| Aspect | Old (qvis) | New |
|---|---|---|
| Category / namespace | `category: "http"`, or `name: "http:frame_created"` split on `:` (`data/QlogLoaderV2.ts:331-366`) | `name: "http3:frame_created"`. Namespace `"http3"`; there is no `category` field. |
| Enum | `EventCategory.http = "http"`, `EventCategory.qpack = "qpack"` (`data/QlogSchema02.ts:140-141`) | `"http3"`, plus `"http"` (Capsule Protocol). `qpack` no longer exists. |
| Lookup | `connection.lookup(EventCategory.http, HTTP3EventType.frame_created)` (`data/Connection.ts:154`; used at `components/stats/StatisticsConnectionRenderer.vue:321-322` and `components/multiplexinggraph/renderer/MultiplexingGraphD3SimulationRenderer.ts:96`) | `lookup('http3', 'frame_created')`, or lookup by full name `'http3:frame_created'` |
| Matching by type only | Many renderers test `evt.name === "frame_created"`. qvis' `name` getter strips the category. | Same type strings: `frame_created`, `frame_parsed`, `parameters_set`. The namespace is now `http3`. |
| Stats "Events" table | grouped by category: `http`, `qpack` (`StatisticsConnectionRenderer.vue:47-60`) | grouped by namespace: `http3`, `http` |
| Draft-01 legacy | `frame.id` became `stream_id`/`push_id`, and `frame.fields` became `headers` (`data/QlogLoader.ts:468-481`) | not applicable; old formats are not supported |

### 10.2 Event mapping (every old HTTP and QPACK event type in `QlogSchema02.ts:521-531,620-628`)

| Old event (category:type) | Old interface (`QlogSchema02.ts`) | New event | Notes |
|---|---|---|---|
| `http:parameters_set` | `IEventH3ParametersSet` :533-544 | `http3:parameters_set` | Field changes in Section 10.3.1 |
| `http:stream_type_set` | `IEventH3StreamTypeSet` :546-555 | `http3:stream_type_set` | Section 10.3.2 |
| `http:frame_created` | `IEventH3FrameCreated` :578-584 (and the shared `IEventH3Frame` :570-576) | `http3:frame_created` | Section 10.3.3 |
| `http:frame_parsed` | `IEventH3FrameParsed` :586-592 | `http3:frame_parsed` | Section 10.3.3 |
| `http:data_moved` (enum `HTTP3EventType.data_moved`) | `IEventH3DataMoved` :594-603 | **`quic:stream_data_moved`** (QUIC events -13 §5.15). For datagrams, `quic:datagram_data_moved`. | Field changes in Section 10.3.4. Moved to transport in draft-marx-…-01; qvis matched on type name only. |
| `http:data_received` (enum key `datagram_received`, value `"data_received"`) | no interface | no equivalent | Nearest: `quic:stream_data_moved`, or `http3:datagram_parsed` for HTTP Datagrams. qvis never consumed it. |
| `http:dependency_update` | no interface | no equivalent | HTTP/2-style dependency trees are gone. Nearest: `http3:priority_updated` (RFC 9218). Not consumed by qvis. |
| `http:push_resolved` | `IEventH3PushResolved` :604-609 | `http3:push_resolved` | `push_id`: number to uint64; `stream_id`: string to uint64; `decision` unchanged |
| `qpack:state_updated` | :632-640 | **removed** (#335) | Not consumed by qvis |
| `qpack:stream_state_updated` | :642-646 | **removed** | Not consumed by qvis |
| `qpack:dynamic_table_updated` | :648-658 | **removed** | Not consumed by qvis |
| `qpack:headers_encoded` / `headers_decoded` | :660-680 | **removed**. Decoded headers now appear only in `HTTP3HeadersFrame.headers` and `HTTP3PushPromiseFrame.headers`. | Not consumed by qvis |
| `qpack:instruction_sent` / `instruction_received` | :682-694 (instruction types :1077-1147, header-block types :1149-1192) | **removed** | Not consumed by qvis |
| (none) | | `http3:parameters_restored`, `http3:priority_updated`, `http3:datagram_created`, `http3:datagram_parsed`, `http:capsule_created`, `http:capsule_parsed` | New events; generic display only |

### 10.3 Field mapping per event

#### 10.3.1 `parameters_set` (`QlogSchema02.ts:533-544`)

| Old field | New field | Change |
|---|---|---|
| `owner?: "local"\|"remote"` | `initiator?: Initiator` | renamed (#498) |
| `max_header_list_size?: number` | `max_field_section_size?: uint64` | renamed (#282) |
| `max_table_capacity?: number` | `max_table_capacity?: uint64` | same name |
| `blocked_streams_count?: number` | `blocked_streams_count?: uint64` | same name |
| `push_allowed?: boolean` | removed | Derive from a MAX_PUSH_ID frame event if needed |
| `waits_for_settings?: boolean` | `waits_for_settings?: bool` | same |
| (none) | `extended_connect`, `h3_datagram`, and in the editor's copy `unknown_settings` | new |

#### 10.3.2 `stream_type_set` (`QlogSchema02.ts:546-564`)

| Old field | New field | Change |
|---|---|---|
| `stream_id: string` | `stream_id: uint64` | type |
| `owner?` | `initiator?` | renamed |
| `old?: H3StreamType` | removed | (#240) |
| `new: H3StreamType` | `stream_type: $HTTP3StreamType` | renamed (#240) |
| `associated_push_id?: number` (when `new == "push"`) | `associated_push_id?: uint64` (when `stream_type === "push"`) | same |
| (none) | `stream_type_bytes?: uint64` | new, for `"unknown"` (editor's copy: also `"reserved"`) |

Enum `H3StreamType` (`QlogSchema02.ts:557-564`):

| Old | New |
|---|---|
| `data` | **`request`** |
| `control` | `control` |
| `push` | `push` |
| `reserved` | `reserved` |
| `qpack_encode` | `qpack_encode` |
| `qpack_decode` | `qpack_decode` |
| (none) | `unknown` (new) |

#### 10.3.3 `frame_created` / `frame_parsed` (`QlogSchema02.ts:570-592`)

| Old field | New location | Change / qvis impact |
|---|---|---|
| `stream_id: string` | `stream_id: uint64` | type. qvis used `parseInt("" + x)` and `"" + x` keys; keep that or normalize with `u64`. |
| `frame: HTTP3Frame` | `frame: $HTTP3Frame` | frame shapes changed (Section 10.4) |
| `byte_length?: string` (**frame payload length**; confirmed by the example `draft-01/parallel_10_50KB_f5.qlog`: HEADERS `byte_length "36"`, DATA `"2623"`) | **`frame.raw.payload_length`**, or derived from `frame.raw.length` / `frame.raw.data` (Section 8.1 `h3FramePayloadLength`) | "Replaced all length fields with raw.length (#495)". Note that the location moved **into `frame`**. |
| `raw?: string` (hex, event level) | **`frame.raw.data`** (hexstring inside RawInfo) | moved and retyped |

#### 10.3.4 `data_moved` to `quic:stream_data_moved` (`QlogSchema02.ts:594-603`)

The new CDDL, verbatim from QUIC events -13 §5.15:

```cddl
QUICStreamDataMoved = {
    ? stream_id: uint64
    ? offset: uint64

    ? from: $DataLocation
    ? to: $DataLocation

    ? additional_info: $DataMovedAdditionalInfo

    ? raw: RawInfo

    * $$quic-streamdatamoved-extension
}

$DataLocation /=  "application" /
                  "transport" /
                  "network"

$DataMovedAdditionalInfo /= "fin_set" /
                            "stream_reset"
```

| Old field | New field | Change |
|---|---|---|
| `stream_id: string` | `stream_id?: uint64` | now optional |
| `offset?: string` | `offset?: uint64` | |
| `length?: number` | **`raw.length`** | "The raw.length field is used to reflect how many bytes were moved." |
| `from?: "application"\|"transport"` | `from?: $DataLocation` | adds `"network"` |
| `to?: "application"\|"transport"` | `to?: $DataLocation` | same |
| `raw?: string` (hex) | `raw.data` | |
| (none) | `additional_info?: "fin_set"\|"stream_reset"` | new. With `fin_set` or `stream_reset`, "the raw.length field can be omitted or have a zero value". |

#### 10.3.5 `push_resolved` (`QlogSchema02.ts:604-609`)

| Old | New |
|---|---|
| `push_id?: number` | `push_id?: uint64` |
| `stream_id?: string` | `stream_id?: uint64` |
| `decision: "claimed"\|"abandoned"` | `decision: HTTP3PushDecision` (same values) |

### 10.4 Frame mapping (`QlogSchema02.ts:980-1051`)

| Old `HTTP3FrameTypeName` / interface | Old fields | New frame | New fields / change |
|---|---|---|---|
| `data` / `IDataFrame` :996-1000 | `raw?: string` | HTTP3DataFrame | `raw?: RawInfo` (object; hex moves to `raw.data`) |
| `headers` / `IHeadersFrame` :1002-1005 | `headers: IHTTPHeader[]` | HTTP3HeadersFrame | `headers: HTTP3HTTPField[]`, plus `raw?` |
| `IHTTPHeader` :1007-1010 | `name: string` (required), `value: string` (required) | HTTP3HTTPField | all optional: `name`, `name_bytes` (hex), `value`, `value_bytes` (hex). The MUST rule is name or name_bytes. |
| `cancel_push` / `ICancelPushFrame` :1012-1015 | `push_id: string` | HTTP3CancelPushFrame | `push_id: uint64`, plus `raw?` |
| `settings` / `ISettingsFrame` :1017-1020 | `settings: Setting[]` | HTTP3SettingsFrame | `settings: HTTP3Setting[]`, plus `raw?` |
| `Setting` :1022-1025 | `name: "SETTINGS_MAX_HEADER_LIST_SIZE"\|"SETTINGS_NUM_PLACEHOLDERS"\|string`, `value: string` | HTTP3Setting | `name?` is lowercase (`settings_max_field_section_size`, etc.). `SETTINGS_NUM_PLACEHOLDERS` has no equivalent and appears as `"unknown"` with `name_bytes`. `value: uint64`. New `name_bytes?`. |
| `push_promise` / `IPushPromiseFrame` :1027-1032 | `push_id: string`, `headers` | HTTP3PushPromiseFrame | `push_id: uint64`, `headers: HTTP3HTTPField[]`, plus `raw?` |
| `goaway` / `IGoAwayFrame` :1034-1037 | **`stream_id: string`** | HTTP3GoawayFrame | **`id: uint64`** (a stream ID or a push ID, depending on sender), plus `raw?` |
| `max_push_id` / `IMaxPushIDFrame` :1039-1042 | `push_id: string` | HTTP3MaxPushIDFrame | `push_id: uint64`, plus `raw?` |
| `duplicate_push` / `IDuplicatePushFrame` :1044-1047 | `push_id: string` | **removed** (not in RFC 9114) | Would be logged as `"unknown"` with `frame_type_bytes` |
| `reserved` / `IReservedFrame` :1049-1051 | none | HTTP3ReservedFrame | **`frame_type_bytes: uint64` (required)**, plus `raw?` |
| `unknown` (enum :991; the union at :994 reuses the QUIC `IUnknownFrame` :970-975: `raw_frame_type: number`, `raw?: string`) | `raw_frame_type` | HTTP3UnknownFrame | **`frame_type_bytes: uint64`**, `raw?: RawInfo`. `raw_frame_type` became `frame_type_value` (-04) and then `frame_type_bytes` (-10). |
| `priority_update` (enum :989, **no interface**). The fields qvis reads come from an implementation-specific shape, documented in the comment at `components/multiplexinggraph/renderer/MultiplexingGraphD3WaterfallRenderer.ts:203`: `{"frame_type":"priority_update","element_id":8,"value":"u=1,i"}` | `element_id`, `value` | HTTP3PriorityUpdateFrame | `element_id` becomes **`stream_id`** (request) or **`push_id`** (push). `value` becomes **`priority_field_value`**. Plus `raw?`. |
| (none) | | HTTP3OriginFrame | new: `origin_entries: [{origin_len, ascii_origin?}]` |

**Application errors** (`QlogSchema02.ts:1053-1073`, enum key, then the old **string value**):

| Old key = old value | New string | Change |
|---|---|---|
| `http_no_error = "http_no_error"` | `http_no_error` | none |
| `http_general_protocol_error = "http_general_protocol_error"` | `http_general_protocol_error` | none |
| `http_internal_error = "http_internal_error"` | `http_internal_error` | none |
| `http_request_cancelled = "http_request_cancelled"` | `http_request_cancelled` | none |
| `http_request_incomplete = **"http_incomplete_request"**` | **`http_request_incomplete`** | string changed |
| `http_connect_error = "http_connect_error"` | `http_connect_error` | none |
| `http_frame_error = "http_frame_error"` | `http_frame_error` | none |
| `http_excessive_load = "http_excessive_load"` | `http_excessive_load` | none |
| `http_version_fallback = "http_version_fallback"` | `http_version_fallback` | none |
| `http_id_error = "http_id_error"` | `http_id_error` | none |
| `http_stream_creation_error = "http_stream_creation_error"` | `http_stream_creation_error` | none |
| `http_closed_critical_stream = "http_closed_critical_stream"` | `http_closed_critical_stream` | none |
| `http_early_response = "http_early_response"` | `http_early_response` (-13); `http_message_error` (editor's copy) | accept both |
| `http_missing_settings = "http_missing_settings"` | `http_missing_settings` | none |
| `http_frame_unexpected = **"http_unexpected_frame"**` | **`http_frame_unexpected`** | string changed |
| `http_request_rejected = "http_request_rejected"` | `http_request_rejected` | none |
| `http_settings_error = "http_settings_error"` | `http_settings_error` | none |
| `unknown = "unknown"` | `"unknown"` (QUIC `$ApplicationError`), with numeric `error_code` | moved to QUIC |
| (none) | `qpack_*`, `http_datagram_error` (editor's copy) | new |

Where errors appear: old QUIC frames used `error_code` for the string and `raw_error_code` for the number. QUIC -13 uses **`error`** for the string and **`error_code`** for the number, present only when `error === "unknown"`. That is a QUIC-events concern, but it affects the HTTP "clean close" check in Section 10.6.3.

### 10.5 Fields qvis read that no longer exist anywhere

| Old access | Where | New equivalent |
|---|---|---|
| `evt.data.byte_length` | `components/packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts:67`, `:412-415`; help text `components/packetizationdiagram/PacketizationDiagramConfigurator.vue:74` | `h3FramePayloadLength(evt.data.frame)` (Section 8.1) |
| `evt.data.frame.element_id` | `MultiplexingGraphD3WaterfallRenderer.ts:207` | `evt.data.frame.stream_id` (or `push_id`) |
| `evt.data.frame.value` (priority) | `MultiplexingGraphD3WaterfallRenderer.ts:223`, `:226` | `evt.data.frame.priority_field_value` |
| `frame.raw_frame_type` (H3 unknown) | `components/packetizationdiagram/renderer/PacketizationDiagramModels.ts:101-102` | `frame.frame_type_bytes` |
| `data.length` on `data_moved` | `components/multiplexinggraph/renderer/MultiplexingGraphD3CollapsedRenderer.ts:479` | `data.raw.length` on `quic:stream_data_moved` |
| `frame.error_code === "http_no_error"` and `frame.raw_error_code` | `components/sequencediagram/renderer/SequenceDiagramD3Renderer.ts:1827-1840` | `frame.error === "http_no_error"` and `frame.error_code` |

### 10.6 qvis usage inventory and what qvis-react must read

Paths are relative to `qvis/visualizations/src/`.

#### 10.6.1 Multiplexing graph: waterfall (`components/multiplexinggraph/renderer/MultiplexingGraphD3WaterfallRenderer.ts`)

- **Event selection (:105-115).**
  - Client vantage point: `h3EventType = frame_created`, with requests on `packet_sent` and data on `packet_received`, `directionText = "received"`.
  - Server: `frame_parsed`, with requests on `packet_received` and data on `packet_sent`, `directionText = "sent"`.
  - New: `http3:frame_created` / `http3:frame_parsed`; `quic:packet_sent` / `quic:packet_received`.
- **HEADERS (:169-198).** When `data.frame.frame_type === "headers"`:
  - `stream_id = parseInt("" + data.stream_id)`.
  - Set `headersIndex = dataFrameCount` and `headersTime = evt.relativeTime`.
  - For every header with `name === "priority"`, append `"HEADER: " + value`, joined with `" -> "`.
  - New: same, with `fieldName()` and `fieldValue()`.
- **PRIORITY_UPDATE (:199-228).** When `data.frame.frame_type === "priority_update"`:
  - Old: `stream_id = parseInt("" + data.frame.element_id)`. The comment at :204-206 says `data.stream_id` is the control stream and that a push `element_id` is not handled.
  - Set `priorityUpdateIndex` and `priorityUpdateTime`, and append `"FRAME: " + data.frame.value`.
  - **New:** prioritized stream = `u64(data.frame.stream_id)`; string = `"FRAME: " + data.frame.priority_field_value`.
  - If only `frame.push_id` is present, skip it. This matches qvis' "not handled" intent.
  - Optional enhancement: resolve push IDs to streams via `http3:stream_type_set.associated_push_id`.
- **Rendering (:448-477).**
  - HEADERS: a square marker at `headersIndex`.
  - PRIORITY_UPDATE: a triangle at `priorityUpdateIndex`.
  - Stream detail text (`components/multiplexinggraph/MultiplexingGraphCollapsedRenderer.vue:16-17`): `HTTP/3 HEADERS seen at {headersTime}ms. HTTP/3 PRIORITY Update seen at {priorityUpdateTime}ms. Priority info (if any): {priorityString}`.
- **Data streams.** Only streams with `id % 4 === 0` are considered (`MultiplexingGraphDataHelper.ts:5-7`).

#### 10.6.2 Multiplexing graph: simulation (`MultiplexingGraphD3SimulationRenderer.ts:91-124`) and collapsed (`MultiplexingGraphD3CollapsedRenderer.ts:463-511`)

- **Simulation:**
  - `lookup(http, frame_created)` for a client, `frame_parsed` for a server. New: `http3`.
  - Keep only frames with `frame_type === "headers"` and `isDataStream(stream_id)`.
  - Label = `method + " " + path` from `:method` and `:path`. A missing value prints `undefined`; keep that only if strict parity is desired.
- **Collapsed:**
  - Old: `event.name === "data_moved"`. New: `quic:stream_data_moved`.
  - Skip if `!isDataStream(data.stream_id)`.
  - **Exact old condition (:469):** `if (data.from !== "transport" && data.to !== "application") continue;`. That is AND, so it skips only when both fail. Preserve this exactly.
  - `movedOffset = data.offset`; old `movedLength = data.length` becomes **`data.raw?.length`**.
  - If the length is 0 or missing, qvis logs an error and skips (:481-484). New: skip silently when `additional_info` is set.
  - The event is linked to the last STREAM frame of the same stream (:491-497).

#### 10.6.3 Sequence diagram (`components/sequencediagram/renderer/SequenceDiagramD3Renderer.ts`)

**Colors (`eventTypeToColor`, :1941-1982).** Matched on the **type part only**:

| Event type | Color pair |
|---|---|
| `parameters_set` (any namespace) | `max_data` color `["#5f0984","#FFFFFF"]` |
| `frame_created`, `frame_parsed` | `stream` color `["#0468cc","#FFFFFF"]` |
| category `error` | `["#FF0000","#000000"]` |
| `warning`, `simulation` | `["#FFA500","#000000"]` |
| `debug`, `info`, `verbose` | `["#D3D3D3","#000000"]` |
| everything else (all other http3 and http events) | `["#FF0000","#FFFFFF"]` |

**Short labels (`eventToShortString`, :1984-2224).**

- `parameters_set` with category `http` produces `"<Object.keys(data).length> HTTP/3 parameters set"` (:2057-2058). New: namespace `http3`.
- `frame_parsed` and `frame_created` (:2122-2198):
  - `streamID = " (stream " + data.stream_id + ")"` if `stream_id` is defined.
  - If `data.frame.headers` exists, scan for `:method`/`method`, `:path`/`path`, `:authority`/`authority`, and `:status`/`status`. The names are accepted with or without the colon.
  - Build `status + " "`, `method + " "`, and `path + " "`. If any of these is set, append `streamID + " "`.
  - If authority is set and the shorthand is still empty, prepend `streamID + " "`; then append authority.
  - Return the shorthand if it is non-empty.
  - Otherwise return `frameType + " " + verb + streamID`, where `frameType = frame_type + " "` and `verb` is `"created"` or `"parsed"`. This produces a **double space**, for example `"data  parsed (stream 0)"`. Reproduce it for pixel parity.
- **Clean close (:1825-1849).** Old: `frame.error_code === "no_error" || === "http_no_error" || String(error_code) === "0"`, else `raw_error_code === "0"`. New: `frame.error === "no_error" || frame.error === "http_no_error" || String(frame.error_code) === "0"`.
- **Display style.** All non-packet events, including every `http3:*` and `http:*` event, are drawn as side labels (:1682-1738). The label comes from `eventToShortString`; the default case returns the event type name only, without the namespace (:2220-2221).

#### 10.6.4 Statistics (`components/stats/StatisticsConnectionRenderer.vue`)

- **"H3 connection headers" row (:23-28, computed :317-358).**
  - Iterate `[...lookup(http, frame_created), ...lookup(http, frame_parsed)]`. That is created first, then parsed, and **the last assignment wins**.
  - For events whose `data.frame.headers !== undefined`, pick `server`, `user-agent`, and `:authority`.
  - Output HTML: `User Agent <i><u>{ua ?? "unknown"}</u></i> connected to Server <i><u>{server ?? "unknown"}</u></i> at <i><u>{authority ?? "unknown authority"}</u></i>`.
  - The row is shown only if at least one of the three was found.
  - New: namespace `http3`; use `fieldName()` and `fieldValue()`.
- **Frame table (:410-430) and total frame count (:389-408).**
  - Every event with `data.frame` (H3) counts one frame of type `data.frame.frame_type`, in the same map as QUIC frame types (keyed by type string).
  - Capsule events (`data.capsule`) are not counted. Keep that behaviour.
- **Events table (:47-60):** rows grouped by namespace, which is now `http3` / `http`.

#### 10.6.5 Packetization diagram (`components/packetizationdiagram/renderer/PacketizationQUICPreProcessor.ts`, `PacketizationDiagramModels.ts`)

- **Direction (:14-29).**
  - Receiving: `packet_received` + `frame_parsed`. Sending: `packet_sent` + `frame_created`.
  - `HTTPHeadersSentEventType` is `frame_parsed` for a server and `frame_created` for a client.
  - New: `quic:*` and `http3:*`.
- **Per H3 frame event (:408-449).** Old: require `data.byte_length`, otherwise `console.error("H3 frame didn't have byte_length set! skipping...")`. New: require `h3FramePayloadLength(data.frame) !== undefined`.
- **Header size (:67-68).** `VLIELength(H3FrameTypeToNumber(frame)) + VLIELength(payloadLength)`.
  - New `H3FrameTypeToNumber` is `h3FrameTypeNumber` in Section 8.1.
  - qvis' version (`PacketizationDiagramModels.ts:48-108`) maps `reserved` to 0x02, `unknown` to `raw_frame_type`, and anything else to 0. Its default 0 for `priority_update` (really 0xF0700, a 4-byte varint) under-counts by 3 bytes.
  - **Recommendation:** use the correct codes. This is a deliberate small deviation and should be documented in parity notes.
- **Payload accounting (:182-198).**
  - DATA frames add `payloadLength` to `HTTPStreamInfo[stream].total_size`, for `streamID !== 0`.
  - DATA and HEADERS payloads add to `HTTPpayloadSize`, which is used for efficiency.
- **Stream info (:452-462).** On `HTTPHeadersSentEventType` HEADERS frames, store `{headers, total_size: 0}` per stream.
- **Tooltips (:557-606).**
  - `"H3 " + (isPayload ? "Payload #" : "Header #") + index + " (QUIC frame index: " + lowerLayerIndex + ") : frame size " + frame_length + ", partial size : " + size + "<br/>frame type: " + frame.frame_type + ", streamID: " + stream_id`.
  - If stream info exists: `method + ": " + path + "<br/>total resource size: " + total_size`.
  - The stream lane tooltip is `"H3 streamID: " + stream_id` plus the same stream info.
- **Help text (`PacketizationDiagramConfigurator.vue:70-74`).** Update `frame_parsed/frame_created : byte_length` to `http3:frame_parsed/http3:frame_created : frame.raw.payload_length (or frame.raw.length)`.

#### 10.6.6 Other references

- `components/filemanager/FileManagerContainer.vue:549-550`: a debug-only filter (`DEBUGfilter = false`) on `"http:frame_created"`. Line 550 is missing the `":"`, which is a qvis bug. Not needed in the port.
- `components/shared/helpers/ColorHelper.ts:3-91` and `packetizationdiagram/renderer/PacketizationDiagramDataHelper.ts:5`: stream-ID color LUT `"HTTP3"`. This is not event-schema related.
- The TCP/HTTP/2 mode uses a **qvis-custom** schema with category `"http2"` and `frame_created`/`frame_parsed` (`components/filemanager/pcapconverter/qlog_tcp_tls_h2.ts:3-31,131-143`; used at `packetizationdiagram/renderer/PacketizationTCPPreProcessor.ts:17-33`).
  - It is **not** part of the qlog drafts and is unaffected by this digest.
  - Keep it as an internal format. It must never be confused with `http3:*`; namespace `http2` is distinct.
  - Because qvis matches the sequence-diagram label by type only, H2 `frame_created` events also get the H3 label logic. Reproduce this only if parity for TCP traces is wanted.

### 10.7 Netlog converter (`components/filemanager/netlogconverter/netlogtoqlog.ts`)

The old converter emits draft-01-style events: array events with `event_fields: ["relative_time","category","event","data"]` and `qlog_version: "draft-01"` (:876-889). In qvis-react it should emit the **new** representation:

| Netlog event | Old output | New output |
|---|---|---|
| `HTTP3_{PEER,LOCAL}_CONTROL_STREAM_CREATED` (:699-719) | `http:stream_type_set {stream_id:"<n>", owner, new:"control"}` | `http3:stream_type_set {initiator: PEER→"remote" / LOCAL→"local", stream_id:n, stream_type:"control"}` |
| `HTTP3_{PEER,LOCAL}_QPACK_DECODER_STREAM_CREATED` (:721-741) | same with `new:"qpack_decode"` | `stream_type:"qpack_decode"` |
| `HTTP3_{PEER,LOCAL}_QPACK_ENCODER_STREAM_CREATED` (:743-764) | same with `new:"qpack_encode"` | `stream_type:"qpack_encode"` |
| `HTTP3_SETTINGS_{SENT,RECEIVED}` (:766-787) | `http:parameters_set {owner: SENT→local else remote, max_header_list_size: SETTINGS_MAX_HEADER_LIST_SIZE, max_table_capacity: SETTINGS_QPACK_MAX_TABLE_CAPACITY, blocked_streams_count: SETTINGS_QPACK_BLOCKED_STREAMS}` | `http3:parameters_set {initiator, max_field_section_size, max_table_capacity, blocked_streams_count}` |
| `HTTP3_MAX_PUSH_ID_{SENT,RECEIVED}` (:789-797) | builds a frame but **never emits it** (no-op) | no-op (parity) |
| `HTTP3_HEADERS_SENT` / `HTTP3_HEADERS_DECODED` (:799-814; `pushH3Frame` :181-196 chooses created if the type contains "SENT", else parsed) | `http:frame_created/parsed {stream_id:"<n>", frame:{frame_type:"headers", headers:[{name,value}]}}` | `http3:frame_created` (SENT) / `http3:frame_parsed` (DECODED) `{stream_id:n, frame:{frame_type:"headers", headers:[{name, value}]}}` |
| `HTTP3_PRIORITY_UPDATE_{SENT,RECEIVED}` (:816-821; params `prioritized_element_id`, `priority_field_value`, `type`, `netlog.ts:169-173`) | not supported (no-op) | no-op for parity. Optional: `http3:frame_created/parsed {frame:{frame_type:"priority_update", stream_id or push_id: prioritized_element_id, priority_field_value}}`, but the control stream ID is unknown. |
| `HTTP3_DATA_SENT` (:823-825) | no-op | no-op |
| `HTTP3_DATA_FRAME_RECEIVED` (:827-838) | `http:frame_parsed {stream_id:"<n>", frame:{frame_type:"data"}, byte_length:"<payload_length>"}` | `http3:frame_parsed {stream_id:n, frame:{frame_type:"data", raw:{payload_length: payload_length}}}` |
| `HTTP3_UNKNOWN_FRAME_RECEIVED`, `HTTP3_HEADERS_RECEIVED` (:840-847) | no-op | no-op. Optional: unknown frame becomes `frame:{frame_type:"unknown", frame_type_bytes: frame_type, raw:{payload_length}}` (`netlog.ts:180-184`). |

---

## 11. Diff vs editor's copy (`draft-ietf-quic-qlog-h3-events.md`)

The editor's copy has no new change-log section, so none of these changes are announced. The CDDL was diffed mechanically, ignoring kramdown `~~~` and `{: …}` artifacts.

### 11.1 Normative / CDDL differences

| Item | -13 (published) | Editor's copy | qvis-react action |
|---|---|---|---|
| `HTTP3ParametersSet.extended_connect` | `uint16` | `uint64` | accept any number |
| `HTTP3ParametersSet.h3_datagram` | `uint16` | `uint64` | accept any number |
| `HTTP3ParametersSet.unknown_settings` | absent ("any number of unspecified fields" prose instead) | `? unknown_settings: [* HTTP3Setting]`, with entries named "unknown" or "reserved" and `name_bytes` = the identifier | accept; display like SETTINGS entries |
| `HTTP3ParametersRestored.extended_connect` / `h3_datagram` | `uint16` | `uint64` | accept any number |
| `HTTP3StreamTypeSet.stream_type_bytes` comment | only when `"unknown"` | when `"unknown"` or `"reserved"` | read it whenever present |
| `HTTP3Setting.name_bytes` comment | only when `"unknown"` | when `"unknown"` or `"reserved"` | read it whenever present |
| `HTTP3OriginFrame` | no `raw` | `? raw: RawInfo` | accept `raw` |
| `HTTP3ApplicationError` | includes `"http_early_response"`; 17 values | `"http_early_response"` replaced by **`"http_message_error"`**; adds `"qpack_decompression_failed"`, `"qpack_encoder_stream_error"`, `"qpack_decoder_stream_error"` (RFC 9204) and `"http_datagram_error"` (RFC 9297); 21 values | accept all 22 strings |
| `parameters_set` `initiator` prose | "received settings have the value "received"" (typo) | "remote" for settings that it received | treat as `local` or `remote` |

### 11.2 Editorial and prose differences (no schema impact)

- **Abstract/Intro:** the editor's copy says "This document defines two event namespaces: `http3` … and `http` …". -13 says "The event namespace with identifier http3 is defined" (§1).
- **§1.1 Usage with QUIC:** the editor's copy defers to QLOG-QUIC "guidance … on group IDs, file names, and events without a known connection", drops "globally" from "globally unique identifier", and references QLOG-MAIN §7.3 for `group_id`.
- **§1.2:** the editor's copy imports "the event namespace and event type concepts; the name, data, group_id, and time-related fields; and the RawInfo type". -13 lists "name, namespace, type, data, group_id, RawInfo, and time-related fields".
- **parameters_restored:** rewritten; references RFC 9114 §7.2.4.2 and cross-references `parameters_set` for when the server SETTINGS arrive.
- **stream_type_set:** adds the reserved type (RFC 9114 §6.2.3).
- **priority_updated:** reworded ("the priority can follow signals from the client or server (see PRIORITIZATION), or local policy can change or override it").
- **frame_created** "is emitted when an HTTP/3 frame is created". In -13: "when the HTTP/3 framing actually happens".
- **frame_parsed / datagram_parsed** say "passed **from** the QUIC layer" instead of "actually received on the QUIC layer".
- **datagram_*** say "defined by the protocol that uses them" instead of "defined by the concrete protocol using HTTP datagrams".
- **push_resolved:** reworded ("a resource sent with server push … is claimed (used) or abandoned (rejected) … such as a web browser").
- **Headers example:** `:path` value fixed from `"/"` to `"/index.html"`, and `headers` is quoted as a JSON key.
- **HTTP3Settings prose:** adds "for a reserved setting, it can be "reserved"".
- **Reserved/Unknown frame prose:** "holds the numerical value of the frame type without variable-length integer encoding".
- **Figure title:** "HTTP3BaseFrames and HTTP3ExtensionFrames definition".
- **Capsule events:** "the `frame_created` event **can** be logged separately" (-13: "would be"); "passed from the transport layer".
- **IANA:** one combined paragraph, "registers two new entries".
- **Authors:** Lucas Pardue's affiliation is **Apple** (-13: Cloudflare).
- **References:** the editor's copy references RFC 9110 (display "HTTP") and RFC 9114 (display "HTTP/3") as normative, and uses `-latest` I-D references for QLOG-MAIN and QLOG-QUIC. -13 pins main-schema-13 and quic-events-12 (stale).
- The change log is identical (the latest entry is "Since -12").

---

## 12. Errata, ambiguities and gotchas (checklist)

1. **`http` namespace means the Capsule Protocol** in the new drafts. HTTP/3 is `http3`.
2. **-13 errata:**
   - The `parameters_set` initiator prose says "received".
   - The Figure 17 example has `:path` `"/"`.
   - `HTTP3OriginFrame` has no `raw`.
   - The References cite main-schema-13 and quic-events-12.
   - `http_early_response` is the old name for code 0x010e (RFC 9114: H3_MESSAGE_ERROR).
3. **`raw` moved into `frame`** for frame events; `byte_length` is gone. Use `frame.raw.payload_length`, falling back to `raw.length` or `raw.data`.
4. **Two stream IDs on PRIORITY_UPDATE:**
   - `data.stream_id` is the control stream.
   - `data.frame.stream_id` / `push_id` is the prioritized element.
   - The same applies to SETTINGS, GOAWAY, MAX_PUSH_ID, CANCEL_PUSH, and ORIGIN, which are all on the control stream.
5. **GOAWAY carries `id`**, not `stream_id`.
6. **HTTP fields:** `name` and `value` are optional. Fall back to the hex `name_bytes` and `value_bytes`.
7. **uint64 values may be strings.** Normalize them.
8. **Settings names are lowercase.** `name` is optional; `"unknown"`/`"reserved"` come with `name_bytes`.
9. **Inconsistent raw-type naming:**
   - Frames: `frame_type_bytes` (required on reserved/unknown).
   - Streams: `stream_type_bytes`.
   - Settings: `name_bytes`.
   - Capsules: `capsule_type_value` (optional).
10. **`$HTTP3Frame`, `$HTTPCapsule`, `$HTTP3StreamType` and `$HTTP3SettingsName` are open sockets.** Unknown strings and shapes are valid.
11. **No QPACK events exist.** Old `qpack:*` data has no successor. Decoded headers live only in HEADERS and PUSH_PROMISE frames.
12. **Ordering:**
    - `frame_created` comes before `packet_sent`.
    - `frame_parsed` comes after `packet_received`.
    - `stream_data_moved` can come before `frame_parsed`.
    - One frame event per H3 frame, even if the frame spans many packets.
13. **`quarter_stream_id`** is the request stream ID divided by 4.
14. **`parameters_set` may appear several times** (local and remote, and at different times). Do not assume a single event.
15. **Draft URIs** carry a `-NN` suffix in `event_schemas`; event names never do.

---

## 13. Source index

| What | Where |
|---|---|
| Published draft -13 | `ref/drafts/draft-ietf-quic-qlog-h3-events-13.txt`. Event table lines 179-214; CDDL at the lines listed in Sections 3 to 5 (309-1191); change log 1321-1549. |
| Editor's copy | `ref/qlog-wg/draft-ietf-quic-qlog-h3-events.md`. Diffs at lines 80-83, 114-123, 133-135, 214-252, 256-261, 293-308, 364, 385-386, 563-566, 613-627, 745, 753-776, 833, 853, 925-965, 35. |
| QUIC -13 `stream_data_moved` | `ref/drafts/draft-ietf-quic-qlog-quic-events-13.txt:1757-1822` |
| QUIC -13 `ConnectionCloseFrame` / `ApplicationError` | `:3175-3225`, `:3332-3350`; `connection_closed` `:622-640`; `Reset/StopSending` `:2898-2980` |
| Main-schema-14: `RawInfo` | `:2211-2226` |
| Main-schema-14: `hexstring` / `uint*` | `:259-267` |
| Main-schema-14: event name rule | `:1517-1521` |
| Main-schema-14: importance | §8.3 |
| Main-schema-14: tooling | §8.4 |
| Main-schema-14: JSON uint64 | §11.3 |
| Main-schema-14: truncation | §11.4 |
| qvis old schema | `src/data/QlogSchema02.ts:116-149, 513-694, 970-1192` |
| qvis consumers | Section 10.6 |
| pcap2qlog HTTP error mapping | `ref/pcap2qlog/src/parsers/ParserPCAP.ts:1062-1101` |
