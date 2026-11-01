# QUIC event schema digest: draft-ietf-quic-qlog-quic-events-13

Implementation-ready digest of the qlog QUIC event schema for qvis-react.
qvis-react parses only the latest qlog drafts. This document is the single
reference for the `quic` namespace. Use it with the main-schema digest (file
envelope, `time`, `name`, `data`, `tuple`, `group_id`) and the HTTP/3 digest
(the `http3` namespace).

Sources, in order of authority:

| Source | Path (scratchpad `ref/`) | Notes |
|---|---|---|
| Published draft -13 (6 July 2026) | `ref/drafts/draft-ietf-quic-qlog-quic-events-13.txt` | **Normative target.** Line numbers `-13:NNNN` refer to this file (`grep -n` numbering). |
| Editor's copy (markdown + CDDL) | `ref/qlog-wg/draft-ietf-quic-qlog-quic-events.md` | Newer than -13. Differences that affect parsing are in [section 14](#14-diff-vs-editors-copy). Line refs are written `ed:NNNN`. |
| Main schema -14 | `ref/drafts/draft-ietf-quic-qlog-main-schema-14.txt` | RawInfo, hexstring, TupleID, importance levels, uint64-as-string. Line refs are written `main:NNNN`. |
| qvis (Vue 2) source | `ref/qvis/visualizations/src/...` | Old draft-02 types are in `data/QlogSchema02.ts`. Line refs are written `path:line`. |

All CDDL in sections 3 to 9 was copied from -13. The script
`scratchpad/scripts/extract_cddl.py` extracted it mechanically and removed page
breaks. Only the 3-space RFC indent was removed. Comments, spacing quirks, and
typos are kept as published, for example `? initial_rtt:float32` and the 3-space
`? old` in QUICECNStateUpdated.

---

## 0. TL;DR for implementers

1. **Event names are `quic:<event_type>`.** -13 has no per-category names such
   as `transport:`, `recovery:`, `connectivity:`, or `security:`. One namespace
   holds everything. Some names changed, not just the prefix:
   - `recovery:metrics_updated` → `quic:recovery_metrics_updated`
   - `recovery:parameters_set` → `quic:recovery_parameters_set`
   - `transport:parameters_set` → `quic:parameters_set`
   - `*:datagrams_sent` → `quic:udp_datagrams_sent`
   - `loss_timer_updated` → `quic:timer_updated`
   - `key_retired` → `quic:key_discarded`
   - `path_assigned` → `quic:tuple_assigned`
   - `data_moved` → `quic:stream_data_moved`
2. **Packet size is `data.raw.length`.** Header plus payload plus the 16-byte
   AEAD tag, from main-schema RawInfo. `data.raw.payload_length` is the payload
   without header or tag. `header.packet_size` no longer exists. For
   `initial`, `handshake`, and `0RTT`, -13 still has a `header.length`. That is
   the long-header *Length* field (packet number plus payload), **not** the
   packet size. The editor's copy removes it.
3. **The packet number is `data.header.packet_number`.** It is uint64 and
   optional. It is absent for `retry`, `version_negotiation`, and
   `stateless_reset`. The packet number space is not logged: infer it from
   `header.packet_type`.
4. **Frame payload lengths moved to `frame.raw.length`.** This applies to STREAM,
   CRYPTO, and DATAGRAM frames (formerly `frame.length`). `raw` is REQUIRED on
   CryptoFrame. PADDING uses `raw.payload_length` for the padding byte count.
5. **ACK ranges are `[[from,to], [n], ...]`.** Ranges can be one or two
   elements, are inclusive, and are not necessarily ordered.
6. **Error fields were renamed.** The string enum is now `error`. The numeric raw
   code is now `error_code`, which used to be the enum. This applies to
   CONNECTION_CLOSE, RESET_STREAM, RESET_STREAM_AT, and STOP_SENDING. On
   `connection_closed` the fields are `connection_error`, `application_error`,
   and `error_code`.
7. **`owner` is now `initiator`.** This applies to `parameters_set`,
   `connection_closed`, and `connection_id_updated`.
8. **All durations are in ms.** This covers RTTs, `ack_delay`, `delta`, and
   `initial_rtt`. Event `time` is float64 ms. There is no `time_units` scaling.
9. **uint64 values may be JSON strings**
   ([main:2419-2423](#19-json-value-handling)). Parse defensively.
10. **Real producers still emit intermediate names.** quic-go master emits
    `transport:packet_sent`, `recovery:metrics_updated`, `security:key_updated`,
    and stream frames with a top-level `length`. quiche emits
    `quic:datagrams_sent` and `quic:key_retired`. Normalize through the alias
    table in [section 15](#15-intermediate-names-in-real-implementations-and-alias-table).

---

## 1. Schema identification and naming

### 1.1 Namespace, event name, schema URI

- Namespace identifier: `quic` (-13:212-217, -13:308-314).
- Final-RFC event schema URI: `urn:ietf:params:qlog:events:quic` (-13:313-314,
  IANA -13:3404-3439).
- Event `name` value: the namespace identifier, a colon, then the event type
  identifier. Example: `quic:packet_sent` (main:1517-1521, which says this
  "MUST be the concatenation"). The event type identifier is the section
  heading name (-13:511-514).
- The Connectivity, Transport, Security, and Recovery subdivisions exist "purely
  for readability" (-13:512-514). **They are not part of the name.**
- All event `data` types extend the main-schema `$ProtocolEventData` type socket
  through `QuicEventData` (Figure 1).

```cddl
QuicEventData = QUICServerListening /
                QUICConnectionStarted /
                QUICConnectionClosed /
                QUICConnectionIDUpdated /
                QUICSpinBitUpdated /
                QUICConnectionStateUpdated /
                QUICTupleAssigned /
                QUICMTUUpdated /
                QUICVersionInformation /
                QUICALPNInformation /
                QUICParametersSet /
                QUICParametersRestored /
                QUICPacketSent /
                QUICPacketReceived /
                QUICPacketDropped /
                QUICPacketBuffered /
                QUICPacketsAcked /
                QUICUDPDatagramsSent /
                QUICUDPDatagramsReceived /
                QUICUDPDatagramDropped /
                QUICStreamStateUpdated /
                QUICFramesCreated /
                QUICFramesParsed /
                QUICFramesProcessed /
                QUICStreamDataMoved /
                QUICDatagramDataMoved /
                QUICConnectionDataBlockedUpdated /
                QUICStreamDataBlockedUpdated /
                QUICDatagramDataBlockedUpdated /
                QUICMigrationStateUpdated /
                QUICTimerUpdated /
                QUICKeyUpdated /
                QUICKeyDiscarded /
                QUICRecoveryParametersSet /
                QUICRecoveryMetricsUpdated /
                QUICCongestionStateUpdated /
                QUICPacketLost /
                QUICMarkedForRetransmit /
                QUICECNStateUpdated

$ProtocolEventData /= QuicEventData
```

### 1.2 Draft event schema identification (-13:316-330)

- Until the RFC is published, implementations **MUST NOT** use
  `urn:ietf:params:qlog:events:quic`.
- A draft implementation **MUST** append `-` and the draft number. Example:
  draft 07 is `urn:ietf:params:qlog:events:quic-07`, so this draft is
  `urn:ietf:params:qlog:events:quic-13`.
- "The namespace identifier itself is not affected by this requirement." Event
  names stay `quic:...` whatever the draft number.
- Extensions to the namespace use a fragment, for example
  `urn:ietf:params:qlog:events:quic#new-frame-extension` (main:1489-1493,
  main:1531-1537, main:1608-1611).
- The trace's `event_schemas` field (main:573-590) is a **hint only**. A trace
  MAY contain events from schemas it does not list, and listed schemas may have
  no events. "Tools MUST NOT treat either of these as an error"
  (main:1546-1554).

Observed values in the wild:

| Producer | Value |
|---|---|
| quiche qlog crate (master) | `QUIC_URI = "urn:ietf:params:qlog:events:quic-12"`, `HTTP3_URI = "urn:ietf:params:qlog:events:http3-12"` |
| quic-go master | Writes `event_schemas` only when a schema is registered. The trace header also carries legacy `qlog_version: "0.3"` and `qlog_format: "JSON-SEQ"` next to `file_schema` and `serialization_format`. See [section 15](#15-intermediate-names-in-real-implementations-and-alias-table). |

### 1.3 Recommended detection algorithm for qvis-react

```ts
// matches final, draft-numbered, and extension URIs
const QUIC_SCHEMA_RE = /^urn:ietf:params:qlog:events:quic(?:-(\d+))?(?:#(.+))?$/;
// e.g. "urn:ietf:params:qlog:events:quic-13" -> draft 13
//      "urn:ietf:params:qlog:events:quic"    -> RFC (treat as >= 13)
//      "urn:ietf:params:qlog:events:quic#foo" -> extension "foo"
```

- Treat any event whose `name` starts with `quic:` as a QUIC event, whether or
  not `event_schemas` lists a quic URI.
- Accept every draft number. Do not reject files on a draft mismatch: show a
  non-blocking notice at most.
- Event-name normalization (aliases from older drafts or implementations) runs
  **before** dispatch. See [section 15](#15-intermediate-names-in-real-implementations-and-alias-table).
- Split `name` on the **first** `:` only. Event type identifiers never contain
  `:`. qvis splits on every `:` and takes `[0]` and `[1]` (QlogLoaderV2.ts:329-363).

### 1.4 group_id and file naming (-13:233-243)

- The RECOMMENDED `group_id` value is the **ODCID**: the Original Destination
  Connection ID that the client chooses for its first Initial. It is the only
  value that never changes during a connection, and it can link Retry and
  Version Negotiation packets to the connection.
- The RECOMMENDED filename or file identifier is the ODCID, optionally suffixed
  with the vantage point. Example: `abcd1234_server.qlog`.
- Tools can use the ODCID (group_id or filename) to pair client and server
  traces, for example in the sequence diagram. qvis left this as a TODO
  (SequenceDiagramConfigurator.vue:216-217).

### 1.5 Raw packet info and the AEAD tag (-13:245-252)

For RawInfo lengths related to QUIC packets, the AEAD tag counts as a **16-byte
trailer**. The editor's copy (ed:93-97) narrows this to protected packets only:
Initial, 0-RTT, Handshake, and 1-RTT. Retry, Version Negotiation, and Stateless
Reset have no AEAD trailer under this rule.

RawInfo (main:2211-2224, quoted for convenience):

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

Main schema rules for RawInfo:

- All RawInfo fields are optional.
- If logged, the lengths describe the full entity even when `data` is truncated
  or omitted.
- On-wire length fields SHOULD be reused as `raw.length` (main:2228-2245).
- There is no `header_length` field. For QUIC protected packets:
  `header_length = raw.length - raw.payload_length - 16`.

### 1.6 Events that belong to no single connection (-13:254-275)

Some events cannot be tied to a connection, especially at a server. An example
is `packet_dropped` with trigger `connection_unknown`. Producers may:

- log them in a separate endpoint-wide trace, or use a special group_id;
- log them in the most recently used trace;
- use the four-tuple heuristically;
- buffer them until they can be assigned.

Tools must therefore tolerate stray events in a trace, and traces with no
connection-level events at all.

### 1.7 Importance levels (main:1909-1955)

| Level | Meaning |
|---|---|
| **Core** | SHOULD be present in all qlog files. Tools SHOULD support these, but SHOULD NOT expect every Core event in every trace. |
| **Base** | MAY be present. Tools SHOULD at least show their contents. |
| **Extra** | MAY be present. Tools MAY support them. |

### 1.8 CDDL notation and primitive types

| Notation | Meaning |
|---|---|
| `? f: T` | Optional field. |
| `f: T` | Required field. |
| `[* T]` | Array of zero or more T. |
| `[+ T]` | Array of one or more T. |
| `[1*2 T]` | Array of 1 to 2 T. |
| `A / B` | Choice. |
| `$Name /= ...` | Extensible type socket (open enum or open union). |
| `* $$name` | Extensible group socket: extensions may add fields. |
| `.default v` | Value to assume when absent. |
| `.size n` | Size constraint. |
| `.regexp "..."` | Regex constraint. |
| `{* text => any}` | Free-form map. |

Primitive types:

| Type | Meaning |
|---|---|
| `uint8`, `uint16`, `uint32`, `uint64` | Unsigned integers. |
| `float32`, `float64` | Floating point. |
| `bool` | Boolean. |
| `text` | String. |
| `hexstring` | `text .regexp "([0-9a-f]{2})*"` (main:267). Lowercase, even-length, no `0x` prefix. |
| `any` | Any value. |

### 1.9 JSON value handling

- **uint64 may be a JSON string.** "serializers MAY encode uint64 values using
  JSON strings. qlog parsers, therefore, SHOULD support parsing of uint64 values
  from JSON strings or JSON numbers" (main:2419-2423).
  - Recommended helper: `toNum(v) = typeof v === "string" ? Number(v) : v`.
  - Keep the original value for display when it exceeds 2^53.
  - qvis already does `parseInt("" + x, 10)` throughout.
- **Times are in ms.** "All timestamps and time-related values (e.g., offsets)
  in qlog are logged as float64 in the millisecond resolution" (main:271-272).
  Main-schema -14 removed `time_units` (main:3297).
  - Do **not** apply qvis's `timeToMilliseconds()` scaling to RTTs or `delta`
    (CongestionGraphD3Renderer.ts:1423, SequenceDiagramD3Renderer.ts:662).
  - Under latest drafts the multiplier is always 1.
- **Hexstrings are not consistent across producers.** Producers sometimes emit
  uppercase hex or a `0x` prefix, notably in versions such as `"0x00000001"` or
  `"00000001"`. Normalize for display and do not reject.
- **Unknown fields MUST be tolerated.** Every event and type has a
  `* $$...-extension` group socket.

---

## 2. Event overview (all 39 events in -13)

"Req." lists the REQUIRED data fields. All other fields are optional.

| # | Name | Importance | -13 § | CDDL type | Req. data fields | Has `trigger` |
|---|---|---|---|---|---|---|
| 1 | `quic:server_listening` | Extra | 4.1 | QUICServerListening | none | no |
| 2 | `quic:connection_started` | Base | 4.2 | QUICConnectionStarted | `local`, `remote` | no |
| 3 | `quic:connection_closed` | Base | 4.3 | QUICConnectionClosed | none | yes |
| 4 | `quic:connection_id_updated` | Base | 4.4 | QUICConnectionIDUpdated | `initiator` | no |
| 5 | `quic:spin_bit_updated` | Base | 4.5 | QUICSpinBitUpdated | `state` | no |
| 6 | `quic:connection_state_updated` | Base | 4.6 | QUICConnectionStateUpdated | `new` | no |
| 7 | `quic:tuple_assigned` | Base | 4.7 | QUICTupleAssigned | `tuple_id` | no |
| 8 | `quic:mtu_updated` | Extra | 4.8 | QUICMTUUpdated | `new` | no |
| 9 | `quic:version_information` | Core | 5.1 | QUICVersionInformation | none | no |
| 10 | `quic:alpn_information` | Core | 5.2 | QUICALPNInformation | none | no |
| 11 | `quic:parameters_set` | Core | 5.3 | QUICParametersSet | none | no |
| 12 | `quic:parameters_restored` | Base | 5.4 | QUICParametersRestored | none | no |
| 13 | `quic:packet_sent` | Core | 5.5 | QUICPacketSent | `header` | yes |
| 14 | `quic:packet_received` | Core | 5.6 | QUICPacketReceived | `header` | yes |
| 15 | `quic:packet_dropped` | Base | 5.7 | QUICPacketDropped | none | yes |
| 16 | `quic:packet_buffered` | Base | 5.8 | QUICPacketBuffered | none | yes |
| 17 | `quic:packets_acked` | Extra | 5.9 | QUICPacketsAcked | none | no |
| 18 | `quic:udp_datagrams_sent` | Extra | 5.10 | QUICUDPDatagramsSent | none | no |
| 19 | `quic:udp_datagrams_received` | Extra | 5.11 | QUICUDPDatagramsReceived | none | no |
| 20 | `quic:udp_datagram_dropped` | Extra | 5.12 | QUICUDPDatagramDropped | none | no |
| 21 | `quic:stream_state_updated` | Base | 5.13 | QUICStreamStateUpdated | `stream_id`, `new`, `stream_side` | yes |
| 22 | `quic:frames_created` | Extra | 5.14.1 | QUICFramesCreated | `frames` | no |
| 23 | `quic:frames_parsed` | Extra | 5.14.2 | QUICFramesParsed | `frames` | no |
| 24 | `quic:frames_processed` | Extra | 5.14.3 | QUICFramesProcessed | `frames` | no (**removed in editor's copy**) |
| 25 | `quic:stream_data_moved` | Base | 5.15 | QUICStreamDataMoved | none | no |
| 26 | `quic:datagram_data_moved` | Base | 5.16 | QUICDatagramDataMoved | none | no |
| 27 | `quic:connection_data_blocked_updated` | Extra | 5.17 | QUICConnectionDataBlockedUpdated | `new` | no (`reason`) |
| 28 | `quic:stream_data_blocked_updated` | Extra | 5.18 | QUICStreamDataBlockedUpdated | `new`, `stream_id` | no (`reason`) |
| 29 | `quic:datagram_data_blocked_updated` | Extra | 5.19 | QUICDatagramDataBlockedUpdated | `new` | no (`reason`) |
| 30 | `quic:migration_state_updated` | Extra | 5.20 | QUICMigrationStateUpdated | `new` | no |
| 31 | `quic:timer_updated` | Extra | 5.21 | QUICTimerUpdated | `event_type` | no |
| 32 | `quic:key_updated` | Base | 6.1 | QUICKeyUpdated | `key_type` | yes |
| 33 | `quic:key_discarded` | Base | 6.2 | QUICKeyDiscarded | `key_type` | yes |
| 34 | `quic:recovery_parameters_set` | Base | 7.1 | QUICRecoveryParametersSet | `timer_granularity` | no |
| 35 | `quic:recovery_metrics_updated` | Core | 7.2 | QUICRecoveryMetricsUpdated | none (at least one metric guaranteed) | no |
| 36 | `quic:congestion_state_updated` | Base | 7.3 | QUICCongestionStateUpdated | `new` | yes (free text) |
| 37 | `quic:packet_lost` | Core | 7.4 | QUICPacketLost | none | yes |
| 38 | `quic:marked_for_retransmit` | Extra | 7.5 | QUICMarkedForRetransmit | `frames` (non-empty) | no |
| 39 | `quic:ecn_state_updated` | Extra | 7.6 | QUICECNStateUpdated | `new` | no (**editor's copy adds `trigger: text`**) |

Do not treat required fields as hard validation errors. Real producers omit
them, for example quic-go's `packet_lost` without frames. Render whatever is
present.

---

## 3. Connectivity events (-13 §4)

### 3.1 `quic:server_listening` (Extra) (-13:518-539)

Emitted when the server starts accepting connections.

```cddl
QUICServerListening = {
    ? ip_v4: IPAddress
    ? port_v4: uint16
    ? ip_v6: IPAddress
    ? port_v6: uint16

    ; the server will always answer client initials with a retry
    ; (no 1-RTT connection setups by choice)
    ? retry_required: bool

    * $$quic-serverlistening-extension
}
```

Some stacks cannot log IP or port because they do not own sockets. In the
editor's copy, the four `ip_*`/`port_*` fields become
`? address_v4: IPAddressPort` and `? address_v6: IPAddressPort`.

### 3.2 `quic:connection_started` (Base) (-13:541-566)

Emitted for both an attempted connection (client perspective) and an accepted
connection (server perspective). It overlaps with `connection_state_updated`
but carries endpoint data.

```cddl
QUICConnectionStarted = {
    local: TupleEndpointInfo
    remote: TupleEndpointInfo

    * $$quic-connectionstarted-extension
}
```

- `local` and `remote` are TupleEndpointInfo ([§7.5](#75-tupleendpointinfo)).
  Every field inside them is optional.
- The editor's copy (ed:300-303) says a stack without socket access can log only
  `connection_ids`.
- This event describes the initial tuple, which has TupleID `""`.

### 3.3 `quic:connection_closed` (Base) (-13:568-654)

Logged when the local endpoint:

- silently discards the connection after an idle timeout;
- sends CONNECTION_CLOSE and enters the closing state;
- receives CONNECTION_CLOSE and enters the draining state; or
- receives a Stateless Reset.

Later transitions, such as leaving closing or draining, are logged with
`connection_state_updated`.

```cddl
QUICConnectionClosed = {

    ; which side closed the connection
    ? initiator: Initiator
    ? connection_error: $TransportError /
                        CryptoError
    ? application_error: $ApplicationError

    ; if connection_error or application_error === "unknown"
    ? error_code: uint64

    ? internal_code: uint64
    ? reason: text
    ? trigger:
        "idle_timeout" /
        "application" /
        "error" /
        "version_mismatch" /
        ; when received from peer
        "stateless_reset" /
        "aborted" /
        ; when it is unclear what triggered the CONNECTION_CLOSE
        "unspecified"

    * $$quic-connectionclosed-extension
}
```

Semantics:

- Several error fields can be set at once: a QUIC-level error plus a finer
  `internal_code`.
- If the code has no known string, `connection_error` or `application_error` is
  `"unknown"`, and `error_code` holds the raw numeric value (not varint
  encoded).
- Producers SHOULD use the most descriptive `trigger` available.
- Display rule for "clean" closes. Treat the close as clean when either is true:
  - `connection_error === "no_error"`;
  - `application_error` is the HTTP/3 `"http_no_error"` (http3 digest).

  The old qvis logic also checked `"" + error_code === "0"`
  (SequenceDiagramD3Renderer.ts:1827-1833).

### 3.4 `quic:connection_id_updated` (Base) (-13:656-685)

Emitted when either side updates its current connection ID. This is cheaper
than logging the CID in every packet.

The event is viewed from the endpoint that applies the new ID:

- the endpoint receives a new CID from the peer: `initiator: "remote"`;
- the endpoint updates its own CID: `initiator: "local"`.

```cddl
QUICConnectionIDUpdated = {
    initiator: Initiator
    ? old: ConnectionID
    ? new: ConnectionID

    * $$quic-connectionidupdated-extension
}
```

### 3.5 `quic:spin_bit_updated` (Base) (-13:687-700)

Emitted when the latency spin bit **changes** value (RFC 9000 §17.4). It SHOULD
NOT be emitted when the bit is set to its current value.

```cddl
QUICSpinBitUpdated = {
    state: bool

    * $$quic-spinbitupdated-extension
}
```

### 3.6 `quic:connection_state_updated` (Base) (-13:702-797)

Tracks progress through the handshake and the close procedure.

```cddl
QUICConnectionStateUpdated = {
    ? old: $ConnectionState
    new: $ConnectionState

    * $$quic-connectionstateupdated-extension
}

BaseConnectionStates =
    ; Initial packet sent/received
    "attempted" /

    ; Handshake packet sent/received
    "handshake_started" /

    ; Both sent a TLS Finished message
    ; and verified the peer's TLS Finished message
    ; 1-RTT packets can be sent
    ; RFC 9001 Section 4.1.1
    "handshake_complete" /

    ; CONNECTION_CLOSE sent/received,
    ; stateless reset received or idle timeout
    "closed"

GranularConnectionStates =
    ; RFC 9000 Section 8.1
    ; client sent Handshake packet OR
    ; client used connection ID chosen by the server OR
    ; client used valid address validation token
    "peer_validated" /

    ; 1-RTT data can be sent by the server,
    ; but handshake is not done yet
    ; (server has sent TLS Finished; sometimes called 0.5 RTT data)
    "early_write" /

    ; HANDSHAKE_DONE sent/received.
    ; RFC 9001 Section 4.1.2
    "handshake_confirmed" /

    ; CONNECTION_CLOSE sent
    "closing" /

    ; CONNECTION_CLOSE received
    "draining" /

    ; draining or closing period done, connection state discarded
    "closed"

$ConnectionState /= BaseConnectionStates / GranularConnectionStates
```

- Implementations SHOULD log Base states mainly and add Granular states for
  in-depth debugging. Tools SHOULD handle both equally.
- `$ConnectionState` is a socket. Implementations may emit **custom states**,
  and tools SHOULD handle them like the predefined ones, for example by showing
  the raw string.
- `"closed"` appears in both groups.
- qvis colors `new === "closed" || new === "draining"` like CONNECTION_CLOSE
  (SequenceDiagramD3Renderer.ts:1949-1954). Recommendation for latest drafts:
  include `"closing"` too.

### 3.7 `quic:tuple_assigned` (Base) (-13:799-860)

Associates a TupleID with the details of a network tuple. Each event can carry a
top-level `tuple` field holding a TupleID (main §7.2: `TupleID = text .default
""`).

```cddl
QUICTupleAssigned = {
    tuple_id: TupleID

    ; the information for traffic going towards the remote receiver
    ? tuple_remote: TupleEndpointInfo

    ; the information for traffic coming in at the local endpoint
    ? tuple_local: TupleEndpointInfo

    * $$quic-tupleassigned-extension
}
```

Semantics:

- `""` is a valid TupleID. It is the **default** for events without a `tuple`
  field and the implicit ID of the initial (handshake) tuple. Details can be
  attached to it with `tuple_id: ""`.
- The tuple_id value is implementation-chosen: an incrementing integer, the
  first DCID or its sequence number, or a hash of the IPs.
- A TupleID can appear in several `tuple_assigned` events:
  - first occurrence: the tuple is **created**;
  - later occurrences: the tuple is **updated**, and the latest event wins;
  - an occurrence with both `tuple_local` and `tuple_remote` omitted: the tuple
    is **abandoned**.

### 3.8 `quic:mtu_updated` (Extra) (-13:862-879)

The estimated Path MTU was updated, as part of PMTU discovery.

```cddl
QUICMTUUpdated = {
    ? old: uint32
    new: uint32

    ; at some point, MTU discovery stops, as a "good enough"
    ; packet size has been found
    ? done: bool .default false

    * $$quic-mtuupdated-extension
}
```

---

## 4. Transport events (-13 §5)

### 4.1 `quic:version_information` (Core) (-13:883-935)

Aggregates version negotiation information. It can also log supported versions
when no negotiation happens.

```cddl
QUICVersionInformation = {
    ? server_versions: [+ QuicVersion]
    ? client_versions: [+ QuicVersion]
    ? chosen_version: QuicVersion

    * $$quic-versioninformation-extension
}
```

Intended use (-13:915-935):

| Who | When | Fields |
|---|---|---|
| Client | Sends Initial | `client_versions`, `chosen_version` |
| Server | Receives a client Initial with a supported version | `server_versions`, `chosen_version` |
| Server | Receives an unsupported version | `server_versions`, and `client_versions` set to `[attempted]`. No `chosen_version`, meaning no overlap. |
| Client | Receives Version Negotiation | `client_versions`, `server_versions` (from the VN packet), and `chosen_version` set to the version for the next Initial. `chosen_version` is absent if there is no overlap. |

The editor's copy notes that `server_versions` can contain reserved (greased)
versions taken from the VN packet (ed:589-592).

### 4.2 `quic:alpn_information` (Core) (-13:937-991)

```cddl
QUICALPNInformation = {
    ? server_alpns: [* ALPNIdentifier]
    ? client_alpns: [* ALPNIdentifier]
    ? chosen_alpn: ALPNIdentifier

    * $$quic-alpninformation-extension
}

ALPNIdentifier = {
  ? byte_value: hexstring
  ? string_value: text
}
```

ALPN identifiers:

- Producers SHOULD log at least one form and MAY log both or neither.
- **ALPN values are objects, not strings.** Display
  `string_value ?? hex-decoded(byte_value)`.

Intended use (-13:976-991):

- The client logs `client_alpns` when sending its Initial.
- The server logs `server_alpns`, `client_alpns`, and `chosen_alpn`.
- The client logs `chosen_alpn` on receiving the server Initial.
- Alternatively, the client logs a single event with both `client_alpns` and
  `chosen_alpn`.

### 4.3 `quic:parameters_set` (Core) (-13:993-1111)

Groups settings from transport parameters, TLS, and other sources.

```cddl
QUICParametersSet = {
    ? initiator: Initiator

    ; true if valid session ticket was received
    ? resumption_allowed: bool

    ; true if early data extension was enabled on the TLS layer
    ? early_data_enabled: bool

    ; e.g., "AES_128_GCM_SHA256"
    ? tls_cipher: text

    ; RFC9000
    ? original_destination_connection_id: ConnectionID
    ? initial_source_connection_id: ConnectionID
    ? retry_source_connection_id: ConnectionID
    ? stateless_reset_token: StatelessResetToken
    ? disable_active_migration: bool
    ? max_idle_timeout: uint64
    ? max_udp_payload_size: uint64
    ? ack_delay_exponent: uint64
    ? max_ack_delay: uint64
    ? active_connection_id_limit: uint64
    ? initial_max_data: uint64
    ? initial_max_stream_data_bidi_local: uint64
    ? initial_max_stream_data_bidi_remote: uint64
    ? initial_max_stream_data_uni: uint64
    ? initial_max_streams_bidi: uint64
    ? initial_max_streams_uni: uint64
    ? preferred_address: PreferredAddress
    ? unknown_parameters: [* UnknownParameter]

    ; RFC9221
    ? max_datagram_frame_size: uint64

    ; RFC9287
    ; true if present, absent or false if extension not negotiated
    ? grease_quic_bit: bool

    ; draft-ietf-quic-reliable-stream-reset
    ; true if present, absent or false if extension not negotiated
    ? reset_stream_at: bool

    * $$quic-parametersset-extension
}

PreferredAddress = {
    ? ip_v4: IPAddress
    ? port_v4: uint16
    ? ip_v6: IPAddress
    ? port_v6: uint16
    connection_id: ConnectionID
    stateless_reset_token: StatelessResetToken
}

UnknownParameter = {
    id: uint64
    ? value: hexstring
}
```

Semantics (-13:1001-1041):

- **`initiator` MUST be correct for every setting in the event.** Local and
  remote settings MUST be in separate events. `initiator: "remote"` means
  "values the peer told us", which is what qvis's flow-control lines use
  (CongestionGraphD3Renderer.ts:1100-1106).
- **The model is cumulative.** Each setting starts as absent or at its default.
  A later event that includes a setting supersedes the earlier value. A setting
  not mentioned is **unchanged**. Several `parameters_set` events per connection
  are normal: build a per-initiator merged state over time.
- `unknown_parameters` holds unrecognized transport parameters (GREASE, private,
  or experimental ones).
- For 0-RTT, the restored values come from `parameters_restored`, and updated
  values come from `parameters_set` as usual.
- `max_idle_timeout` and `max_ack_delay` are in ms. They are QUIC transport
  parameter units, carried as uint64.
- In the editor's copy, PreferredAddress uses `address_v4` and `address_v6`
  (IPAddressPort).

### 4.4 `quic:parameters_restored` (Base) (-13:1125-1162)

The client restored server transport parameters for 0-RTT.

```cddl
QUICParametersRestored = {

    ; RFC9000
    ? disable_active_migration: bool
    ? max_idle_timeout: uint64
    ? max_udp_payload_size: uint64
    ? active_connection_id_limit: uint64
    ? initial_max_data: uint64
    ? initial_max_stream_data_bidi_local: uint64
    ? initial_max_stream_data_bidi_remote: uint64
    ? initial_max_stream_data_uni: uint64
    ? initial_max_streams_bidi: uint64
    ? initial_max_streams_uni: uint64

    ; RFC9221
    ? max_datagram_frame_size: uint64

    ; RFC9287
    ; can only be restored at the client.
    ; servers MUST NOT restore this parameter!
    ? grease_quic_bit: bool

    * $$quic-parametersrestored-extension
}
```

This event has no `initiator`. The values are implicitly the remote (server)
parameters as remembered by the client.

### 4.5 `quic:packet_sent` (Core) (-13:1164-1218)

```cddl
QUICPacketSent = {
    header: PacketHeader
    ? frames: [* $QuicFrame]

    ; only if header.packet_type === "stateless_reset"
    ; is always 128 bits in length.
    ? stateless_reset_token: StatelessResetToken

    ; only if header.packet_type === "version_negotiation"
    ? supported_versions: [+ QuicVersion]
    ? raw: RawInfo
    ? datagram_id: uint32
    ? is_mtu_probe_packet: bool .default false

    ? trigger:
      ; RFC 9002 Section 6.1.1
      "retransmit_reordered" /
      ; RFC 9002 Section 6.1.2
      "retransmit_timeout" /
      ; RFC 9002 Section 6.2.4
      "pto_probe" /
      ; RFC 9002 6.2.3
      "retransmit_crypto" /
      ; needed for some CCs to figure out bandwidth allocations
      ; when there are no normal sends
      "cc_bandwidth_probe"

    * $$quic-packetsent-extension
}
```

- The encryption level and packet number space are **not logged**. Infer them
  from `header.packet_type` (see [§11](#11-cheat-sheet-sizes-lengths-packet-numbers-pn-spaces)).
- `datagram_id` tracks coalescing ([§10](#10-packet-coalescing)). In the
  editor's copy it is `datagram_payload_checksum`.
- `raw.length` is the packet size and `raw.payload_length` is the payload size
  ([§11](#11-cheat-sheet-sizes-lengths-packet-numbers-pn-spaces)).
- `frames` is optional. Producers may log frames separately with
  `frames_created`.

### 4.6 `quic:packet_received` (Core) (-13:1220-1265)

```cddl
QUICPacketReceived = {
    header: PacketHeader
    ? frames: [* $QuicFrame]

    ; only if header.packet_type === "stateless_reset"
    ; Is always 128 bits in length.
    ? stateless_reset_token: StatelessResetToken

    ; only if header.packet_type === "version_negotiation"
    ? supported_versions: [+ QuicVersion]
    ? raw: RawInfo
    ? datagram_id: uint32

    ? trigger:
        ; if packet was buffered because it couldn't be
        ; decrypted before
        "keys_available"

    * $$quic-packetreceived-extension
}
```

`trigger: "keys_available"` means the packet was earlier reported by
`packet_buffered`, so the same packet can appear twice: buffered, then received.
Do not count it twice for byte totals if `packet_buffered` events are also
summed.

### 4.7 `quic:packet_dropped` (Base) (-13:1267-1350)

```cddl
QUICPacketDropped = {

    ; Primarily packet_type should be filled here,
    ; as other fields might not be decryptable or parsable
    ? header: PacketHeader
    ? raw: RawInfo
    ? datagram_id: uint32
    ? details: {* text => any}
    ? trigger:
        "internal_error" /
        "rejected" /
        "unsupported" /
        "invalid" /
        "duplicate" /
        "connection_unknown" /
        "decryption_failure" /
        "key_unavailable" /
        "general"

    * $$quic-packetdropped-extension
}
```

Trigger examples (-13:1317-1338):

| Trigger | Example situations |
|---|---|
| `internal_error` | Not initialized, out of memory. |
| `rejected` | Limits reached, DDoS protection, unwilling to track more paths, duplicate packet. |
| `unsupported` | Unknown or unsupported version (see -13 §1.3). |
| `invalid` | Parse or validation error. |
| `duplicate` | Duplicate packet. |
| `connection_unknown` | No known connection or CID. |
| `decryption_failure` | Decryption failed. |
| `key_unavailable` | Decryption key unavailable. **The editor's copy renames it `keys_unavailable`.** |
| `general` | Anything else. |

`details` is an implementation-specific free-form map. `header` is optional and
often holds only `packet_type`.

### 4.8 `quic:packet_buffered` (Base) (-13:1352-1381)

```cddl
QUICPacketBuffered = {

    ; primarily packet_type should be filled here as other elements
    ; might not be available yet
    ? header: PacketHeader
    ? raw: RawInfo
    ? datagram_id: uint32
    ? trigger:
        ; indicates the parser cannot keep up, temporarily buffers
        ; packet for later processing
        "backpressure" /
        ; if packet cannot be decrypted because the proper keys were
        ; not yet available
        "keys_unavailable"

    * $$quic-packetbuffered-extension
}
```

### 4.9 `quic:packets_acked` (Extra) (-13:1383-1416)

Emitted when one or more sent packets are acknowledged **for the first time**.
This avoids the duplicate-ACK processing that qvis does in the congestion graph.

```cddl
QUICPacketsAcked = {
    ? packet_number_space: $PacketNumberSpace
    ? packet_numbers: [+ uint64]

    * $$quic-packetsacked-extension
}
```

If `packet_number_space` is omitted, it **defaults to `"application_data"`**.

### 4.10 `quic:udp_datagrams_sent` (Extra) (-13:1418-1450)

One or more UDP datagrams were passed to the socket.

```cddl
QUICUDPDatagramsSent = {

    ; to support passing multiple at once
    ? count: uint16

    ; The RawInfo fields do not include the UDP headers,
    ; only the UDP payload
    ? raw: [+ RawInfo]

    ; ECN bits in the IP header
    ; if not set, defaults to the value used on the last
    ; QUICUDPDatagramsSent event
    ? ecn: [+ ECN]

    ? datagram_ids: [+ uint32]

    * $$quic-udpdatagramssent-extension
}
```

- `raw` is an **array**, one RawInfo per datagram. RawInfo excludes UDP headers.
- `ecn` is an array and is **sticky**: if absent, it inherits the value from
  the previous `udp_datagrams_sent` event. quiche emits a single `ecn` value
  rather than an array, so accept both.
- `datagram_ids` maps to packet `datagram_id`s ([§10](#10-packet-coalescing)).
  In the editor's copy it is `datagram_payload_checksums`.

### 4.11 `quic:udp_datagrams_received` (Extra) (-13:1461-1489)

```cddl
QUICUDPDatagramsReceived = {

    ; to support passing multiple at once
    ? count: uint16

    ; The RawInfo fields do not include the UDP headers,
    ; only the UDP payload
    ? raw: [+ RawInfo]

    ; ECN bits in the IP header
    ; if not set, defaults to the value on the last
    ; QUICUDPDatagramsReceived event
    ? ecn: [+ ECN]

    ? datagram_ids: [+ uint32]

    * $$quic-udpdatagramsreceived-extension
}
```

### 4.12 `quic:udp_datagram_dropped` (Extra) (-13:1491-1508)

Use this when the datagram has no valid QUIC packet. A valid QUIC packet dropped
for another reason uses `packet_dropped`.

```cddl
QUICUDPDatagramDropped = {

    ; The RawInfo fields do not include the UDP headers,
    ; only the UDP payload
    ? raw: RawInfo

    * $$quic-udpdatagramdropped-extension
}
```

Here `raw` is a single RawInfo, not an array.

### 4.13 `quic:stream_state_updated` (Base) (-13:1517-1632)

```cddl
StreamType = "unidirectional" /
             "bidirectional"

QUICStreamStateUpdated = {
    stream_id: uint64
    ? stream_type: StreamType
    ? old: $StreamState
    new: $StreamState
    stream_side: "sending" /
                 "receiving"
    ? trigger:
      ; stream state change was initiated by a local action
      "local" /
      ; stream state change was initiated by a remote action
      "remote"

    * $$quic-streamstateupdated-extension
}

BaseStreamStates =  "idle" /
                    "open" /
                    "closed"

GranularStreamStates =
    ; bidirectional stream states, RFC 9000 Section 3.4.
    "half_closed_local" /
    "half_closed_remote" /
    ; sending-side stream states, RFC 9000 Section 3.1.
    "ready" /
    "send" /
    "data_sent" /
    "reset_sent" /
    "reset_received" /
    ; receive-side stream states, RFC 9000 Section 3.2.
    "receive" /
    "size_known" /
    "data_read" /
    "reset_read" /
    ; both-side states
    "data_received" /
    ; qlog-defined: memory actually freed
    "destroyed"

$StreamState /= BaseStreamStates / GranularStreamStates
```

- `stream_side` is **required**. When both sides change at once, two events
  SHOULD be logged.
- `stream_type` is optional. Derive it from the stream ID when absent: bit 0x2
  set means unidirectional. Bit 0x1 gives the initiator: 0 is the client, 1 is
  the server.
- `trigger: "local"` or `"remote"` says who initiated the change, for example
  RESET_STREAM versus STOP_SENDING.
- Producers SHOULD log Base states mainly. Tools handle both groups equally and
  should show unknown (socket) values verbatim.

### 4.14 Frame-related events (-13:1634-1693)

These events log frames independently of packets.

- It is RECOMMENDED to avoid duplicate frame information, but a trace **may**
  contain both packet and frame events.
- **`packet_numbers` mapping**: `frames[i]` belongs to the packet with number
  `packet_numbers[i]`. When `packet_numbers` is present, every frame MUST have
  an entry at the same index. Neither array carries a packet number space; infer
  it from context, normally application_data.
- Frame events omit packet-level information such as the encryption level. Use
  the packet events for that.

Example (-13:1663-1674):

```json
"frames":[
  {"frame_type":"stream","stream_id":0,"offset":0,"raw":{"length":5}},
  {"frame_type":"stream","stream_id":0,"offset":5,"raw":{"length":5}},
  {"frame_type":"stream","stream_id":1,"offset":0,"raw":{"length":9}},
  {"frame_type":"stream","stream_id":1,"offset":9,"raw":{"length":9}}
  ],
"packet_numbers":[
  1,
  1,
  2,
  2
]
```

This example **confirms that the STREAM frame `raw.length` is the stream data
length**: the offsets advance by `raw.length`.

#### 4.14.1 `quic:frames_created` (Extra) (-13:1695-1707)

```cddl
QUICFramesCreated = {
    frames: [* $QuicFrame]
    ? packet_numbers: [* uint64]

    * $$quic-framescreated-extension
}
```

#### 4.14.2 `quic:frames_parsed` (Extra) (-13:1709-1721)

```cddl
QUICFramesParsed = {
    frames: [* $QuicFrame]
    ? packet_numbers: [* uint64]

    * $$quic-framesparsed-extension
}
```

#### 4.14.3 `quic:frames_processed` (Extra) (-13:1723-1755)

Frames have been **processed** at the receiver. This can happen later than
parsing, for example after buffering. The event exists so that specific-purpose
events are not needed. For example, no "packets acknowledged" event is needed
because the ACK frame holds the information.

```cddl
QUICFramesProcessed = {
    frames: [* $QuicFrame]
    ? packet_numbers: [* uint64]

    * $$quic-framesprocessed-extension
}
```

**The editor's copy removes `frames_processed` entirely**, leaving only
`frames_created` and `frames_parsed`. Its change log still says "Split
frames_processed into 3 events (#513)". Older drafts used `frames_processed` for
everything. Recommendation: accept it, and treat it as receive-side
(`frames_parsed`-like) for direction-dependent views.

### 4.15 `quic:stream_data_moved` (Base) (-13:1757-1822)

Stream data moved between layers, for example HTTP/3 to QUIC stream buffers or
the reverse.

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

- **`raw.length` is the number of bytes moved.** It excludes packet and frame
  headers (MUST).
- With `additional_info` set to `fin_set` or `stream_reset`, `raw.length` can be
  absent or 0.
- This replaces the old `transport:data_moved` and `http:data_moved`, which had
  top-level `length`. qvis's multiplexing "collapsed" renderer consumes it
  (MultiplexingGraphD3CollapsedRenderer.ts:463-482) and only uses moves with
  `from: "transport"` to `to: "application"`.

### 4.16 `quic:datagram_data_moved` (Base) (-13:1824-1873)

```cddl
QUICDatagramDataMoved = {
    ? from: $DataLocation
    ? to: $DataLocation
    ? raw: RawInfo

    * $$quic-datagramdatamoved-extension
}
```

`raw.length` is the number of bytes moved. It excludes headers (MUST). Use this
event only for RFC 9221 DATAGRAM frame data.

### 4.17 `quic:connection_data_blocked_updated` (Extra) (-13:1875-1928)

The connection became blocked or unblocked for sending.

```cddl
QUICConnectionDataBlockedUpdated = {
    ? old: $BlockedState
    new: $BlockedState

    ? reason: $BlockedReason
}

$BlockedState /= "blocked" /
               "unblocked"

$BlockedReason /= "scheduling" /
                  "pacing" /
                  "amplification_protection" /
                  "congestion_control" /
                  "connection_flow_control" /
                  "stream_flow_control" /
                  "stream_id" /
                  "application"
```

In -13 this event and the next two have no `$$` extension socket. The editor's
copy adds one, so unknown fields should be tolerated anyway.

### 4.18 `quic:stream_data_blocked_updated` (Extra) (-13:1930-1945)

```cddl
QUICStreamDataBlockedUpdated = {
    ? old: $BlockedState
    new: $BlockedState

    stream_id: uint64

    ? reason: $BlockedReason
}
```

### 4.19 `quic:datagram_data_blocked_updated` (Extra) (-13:1947-1972)

```cddl
QUICDatagramDataBlockedUpdated = {
    ? old: $BlockedState
    new: $BlockedState

    ? reason: $BlockedReason
}
```

### 4.20 `quic:migration_state_updated` (Extra) (-13:1974-2055)

Progress of a client connection migration. Producers that log per-path
information here SHOULD also emit `tuple_assigned`, which is the ground truth.

```cddl
QUICMigrationStateUpdated = {
    ? old: MigrationState
    new: MigrationState

    ? tuple_id: TupleID

    ; the information for traffic going towards the remote receiver
    ? tuple_remote: TupleEndpointInfo

    ; the information for traffic coming in at the local endpoint
    ? tuple_local: TupleEndpointInfo

    * $$quic-migrationstateupdated-extension
}

; Note that MigrationState does not describe a full state machine
; These entries are not necessarily chronological,
; nor will they always all appear during
; a connection migration attempt.
MigrationState =
    ; probing packets are sent, migration not initiated yet
    "probing_started" /
    ; did not get reply to probing packets,
    ; discarding path as an option
    "probing_abandoned" /
    ; received reply to probing packets, path is migration candidate
    "probing_successful" /
    ; non-probing packets are sent, attempting migration
    "migration_started" /
    ; something went wrong during the migration, abandoning attempt
    "migration_abandoned" /
    ; new path is now fully used, old path is discarded
    "migration_complete"
```

### 4.21 `quic:timer_updated` (Extra) (-13:2057-2123)

A timer changed state. `event_type` takes three values:

- `set`: the timer is set, with `delta` in ms until it fires;
- `expired`: the timer expired;
- `cancelled`: the timer was cancelled.

A new `set` event updates an active timer's timeout.

Timer types:

- `ack`: the RFC 9002 §6.1.2 time-threshold loss timeout;
- `pto`: the RFC 9002 §6.2 probe timeout;
- `loss_timeout`: the multi-modal loss detection timer of RFC 9002 Appendix A.8;
- custom types are allowed through the `$TimerType` socket.

```cddl
; a non-exhaustive list of typically employed timers
$TimerType /= "ack" /
              "pto" /
              "loss_timeout" /
              "path_validation" /
              "handshake_timeout" /
              "idle_timeout"

QUICTimerUpdated = {
    ? timer_type: $TimerType

    ; to disambiguate in case there are multiple timers
    ; of the same type
    ? timer_id: uint64

    ; if used for recovery timers, this can be useful information
    ? packet_number_space: $PacketNumberSpace
    event_type: "set" /
                "expired" /
                "cancelled"

    ; if event_type === "set": delta time is in ms from
    ; this event's timestamp until when the timer should trigger
    ? delta: float32

    * $$quic-timerupdated-extension
}
```

This replaces the draft-02 `recovery:loss_timer_updated` event, whose fields
were `timer_type`, `packet_number_space`, `event_type`, and `delta`. qvis
renders it as `"<pnspace> <TIMER_TYPE> timer <event_type> @ <time+delta>"`
(SequenceDiagramD3Renderer.ts:2082-2097). quic-go also emits
`timer_type: "path_probe"`, which is a socket value.

---

## 5. Security events (-13 §6)

### 5.1 `quic:key_updated` (Base) (-13:2135-2161)

```cddl
QUICKeyUpdated = {
    key_type: $KeyType
    ? old: hexstring
    ? new: hexstring

    ; needed for 1RTT key updates
    ? key_phase: uint64
    ? trigger:
        ; (e.g., initial, handshake and 0-RTT keys
        ; are generated by TLS)
        "tls" /
        "remote_update" /
        "local_update"

    * $$quic-keyupdated-extension
}
```

`key_phase` is the **full** key phase counter (@M and @N in RFC 9001 Figure 9).
The header Key Phase bit is its least significant bit. This field was formerly
`generation`.

### 5.2 `quic:key_discarded` (Base) (-13:2163-2205)

```cddl
QUICKeyDiscarded = {
    key_type: $KeyType
    ? key: hexstring

    ; needed for 1RTT key updates
    ? key_phase: uint64
    ? trigger:
        ; (e.g., initial, handshake and 0-RTT keys
        ; are generated by TLS)
        "tls" /
        "remote_update" /
        "local_update"

    * $$quic-keydiscarded-extension
}
```

This event was formerly `security:key_retired`, and quiche still emits
`quic:key_retired`.

---

## 6. Recovery events (-13 §7)

The spec asks tools for robustness: "Tool creators SHOULD make an effort to
support and visualize even unknown data in these events (e.g., plot unknown
congestion states by name on a timeline visualization)" (-13:2209-2213).

### 6.1 `quic:recovery_parameters_set` (Base) (-13:2215-2281)

```cddl
QUICRecoveryParametersSet = {

    ; Loss detection, see RFC 9002 Appendix A.2
    ; in amount of packets
    ? reordering_threshold: uint16

    ; as RTT multiplier
    ? time_threshold: float32

    ; in ms
    timer_granularity: uint16

    ; in ms
    ? initial_rtt:float32

    ; congestion control, see RFC 9002 Appendix B.2
    ; in bytes. Note that this could be updated after pmtud
    ? max_datagram_size: uint32

    ; in bytes
    ? initial_congestion_window: uint64

    ; Note that this could change when max_datagram_size changes
    ; in bytes
    ? minimum_congestion_window: uint64
    ? loss_reduction_factor: float32

    ; as PTO multiplier
    ? persistent_congestion_threshold: uint16

    * $$quic-recoveryparametersset-extension
}
```

- The event can contain any number of additional, unspecified fields.
- It MAY be emitted more than once.
- The editor's copy allows `reordering_threshold: uint16 / "disabled"`, and
  quic-go already emits `"disabled"`.

### 6.2 `quic:recovery_metrics_updated` (Core) (-13:2283-2346)

Emitted when one or more observable recovery metrics change. It SHOULD bundle
simultaneous updates, so each event is only guaranteed to contain **at least
one** metric.

```cddl
QUICRecoveryMetricsUpdated = {

    ; Loss detection, see RFC 9002 Appendix A.3
    ; all following rtt fields are expressed in ms
    ? min_rtt: float32
    ? smoothed_rtt: float32
    ? latest_rtt: float32
    ? rtt_variance: float32
    ? pto_count: uint16

    ; Congestion control, see RFC 9002 Appendix B.2.
    ; in bytes
    ? congestion_window: uint64
    ? bytes_in_flight: uint64

    ; in bytes
    ? ssthresh: uint64

    ; qlog defined
    ; sum of all packet number spaces
    ? packets_in_flight: uint64

    ; in bits per second
    ? pacing_rate: uint64

    * $$quic-recoverymetricsupdated-extension
}
```

Semantics:

- Producers MAY repeat unchanged values but SHOULD log only real changes.
- Additional fields are allowed.
- **Metrics are sparse deltas.** To get the full state at time t, fold all
  earlier events, as qvis does on click (SequenceDiagramD3Renderer.ts:112-130).
- RTT values are ms. Do not scale them by a time unit.
- qvis also accepted the very old `cwnd` key next to `congestion_window`
  (CongestionGraphD3Renderer.ts:1409-1419). Under latest drafts only
  `congestion_window` applies. Keep `cwnd` as an alias if cheap.

### 6.3 `quic:congestion_state_updated` (Base) (-13:2357-2386)

```cddl
QUICCongestionStateUpdated = {
    ? old: text
    new: text
    ? trigger: text

    * $$quic-congestionstateupdated-extension
}
```

- The values are intentionally free text.
- -13 gives these NewReno examples: Slow Start, Congestion Avoidance,
  Application Limited, Recovery. The editor's copy gives slow start, recovery,
  congestion avoidance.
- quic-go emits `slow_start`, `congestion_avoidance`, `recovery`, and
  `application_limited`.
- `trigger` SHOULD be logged if several causes are possible.
- qvis displays `"Congestion state: " + new.replace("_"," ")`
  (SequenceDiagramD3Renderer.ts:2113-2116).

### 6.4 `quic:packet_lost` (Core) (-13:2388-2431)

Loss detection declared a packet lost. Populating `trigger` is RECOMMENDED.

```cddl
QUICPacketLost = {

    ; should include at least the packet_type and packet_number
    ? header: PacketHeader

    ; not all implementations will keep track of full
    ; packets, so these are optional
    ? frames: [* $QuicFrame]
    ? is_mtu_probe_packet: bool .default false
    ? trigger:
        "reordering_threshold" /
        "time_threshold" /
        ; RFC 9002 Section 6.2.4 paragraph 6, MAY
        "pto_expired"

    * $$quic-packetlost-extension
}
```

- Match a lost packet to its sent packet with the key
  `(PN space of header.packet_type, header.packet_number)`.
- `packet_lost` has **no `raw`**, so the size comes from the matching
  `packet_sent`. qvis displays `parsedLostPacket.data.raw.length`, which is
  always unknown under -13 (CongestionGraphD3Renderer.ts:1691).
- `is_mtu_probe_packet` loss is not a congestion signal.

### 6.5 `quic:marked_for_retransmit` (Extra) (-13:2433-2475)

Which data was marked for retransmission, expressed as frames. These frames may
never appear on the wire.

```cddl
QUICMarkedForRetransmit = {
    frames: [+ $QuicFrame]

    * $$quic-markedforretransmit-extension
}
```

### 6.6 `quic:ecn_state_updated` (Extra) (-13:2477-2501)

Progress of the ECN validation state machine (RFC 9000 Appendix A.4).

```cddl
QUICECNStateUpdated = {
   ? old: ECNState
    new: ECNState

    * $$quic-ecnstateupdated-extension
}

ECNState =
  ; ECN testing in progress
  "testing" /
  ; ECN state unknown, waiting for acknowledgements
  ; for testing packets
  "unknown" /
  ; ECN testing failed
  "failed" /
  ; testing was successful
  "capable"
```

The editor's copy adds `? trigger: text`, and quic-go emits it.

---

## 7. QUIC data types (-13 §8)

### 7.1 QuicVersion

```cddl
QuicVersion = hexstring
```

Examples: `"00000001"` for v1 and `"6b3343cf"` for v2. Some producers emit
`"0x00000001"`, so normalize.

### 7.2 ConnectionID

```cddl
ConnectionID = hexstring
```

The empty string is a valid zero-length CID.

### 7.3 Initiator

```cddl
Initiator = "local" /
            "remote"
```

### 7.4 IPAddress

```cddl
; an IPAddress can either be a "human readable" form
; (e.g., "127.0.0.1" for v4 or
; "2001:0db8:85a3:0000:0000:8a2e:0370:7334" for v6) or
; use a raw byte-form (as the string forms can be ambiguous).
; Additionally, a hash-based or redacted representation
; can be used if needed for privacy or security reasons.
IPAddress = text /
            hexstring
```

The editor's copy replaces IPAddress with IPAddressPort. See
[§14](#14-diff-vs-editors-copy).

### 7.5 TupleEndpointInfo

One half, or direction, of a four-tuple. Structures SHOULD include two
instances.

```cddl
TupleEndpointInfo = {
    ? ip_v4: IPAddress
    ? port_v4: uint16
    ? ip_v6: IPAddress
    ? port_v6: uint16

    ; Even though usually only a single ConnectionID
    ; is associated with a given tuple/path at a time,
    ; there are situations where there can be an overlap
    ; or a need to keep track of previous ConnectionIDs
    ? connection_ids: [+ ConnectionID]

    * $$quic-tupleendpointinfo-extension
}
```

### 7.6 PacketType

```cddl
$PacketType /=  "initial" /
                "handshake" /
                "0RTT" /
                "1RTT" /
                "retry" /
                "version_negotiation" /
                "stateless_reset" /
                "unknown"
```

The values are identical to qvis `QlogSchema02.ts:395-404`. Note the casing:
`0RTT` and `1RTT`.

### 7.7 PacketNumberSpace

```cddl
$PacketNumberSpace /= "initial" /
                      "handshake" /
                      "application_data"
```

### 7.8 PacketHeader

Notes (-13:2602-2621):

- An unknown numeric packet type uses `packet_type: "unknown"`, with the raw
  value in `packet_type_bytes` (not varint encoded).
- The fixed and reserved bits are omitted because they must be 0. Invalid
  values can be seen in `raw.data`.
- Extensions that use those bits create new events.
- For long-header `initial`, `handshake`, and `0RTT` packets, -13 says "the
  length field of the packet header is logged in the qlog raw.length field".
  See the ambiguity note in
  [§11](#11-cheat-sheet-sizes-lengths-packet-numbers-pn-spaces).

```cddl
PacketHeader = {
    packet_type: $PacketType

    ; only if packet_type === "unknown"
    ? packet_type_bytes: uint64

    ; only if packet_type === "1RTT"
    ? spin_bit: bool

    ; only if packet_type === "1RTT", and if the key phase was
    ; determined from the key_phase_bit
    ? key_phase: uint64

    ; only if packet_type === "1RTT", and if key_phase is not set
    ? key_phase_bit: bool

    ; only if packet_type === "initial" || "handshake" || "0RTT" ||
    ;                         "1RTT"
    ? packet_number_length: uint8

    ; only if packet_type === "initial" || "handshake" || "0RTT" ||
    ;                         "1RTT"
    ? packet_number: uint64

    ; only if packet_type === "initial" || "retry"
    ? token: Token

    ; only if packet_type === "initial" || "handshake" || "0RTT"
    ; Signifies length of the packet_number plus the payload
    ? length: uint16

    ; only if present in the header.
    ; if correctly using transport:connection_id_updated events,
    ; dcid can be skipped for 1RTT packets
    ? version: QuicVersion
    ? scil: uint8
    ? dcil: uint8
    ? scid: ConnectionID
    ? dcid: ConnectionID

    * $$quic-packetheader-extension
}
```

- Only `packet_type` is required. `packet_number` is optional even for packet
  types that carry one, although qvis logs an error when it is missing
  (SequenceDiagramD3Renderer.ts:1038-1046).
- `dcid` may be omitted on 1RTT packets when `connection_id_updated` is used.
- The comment still says `transport:connection_id_updated`, a leftover from the
  old naming. The editor's copy fixes it to `connection_id_updated`.

### 7.9 Token

```cddl
Token = {
    ? type: $TokenType

    ; decoded fields included in the token
    ; (typically: peer's IP address, creation time)
    ? details: {
      * text => any
    }
    ? raw: RawInfo

    * $$quic-token-extension
}

$TokenType /= "retry" /
              "resumption"
```

- The token in an Initial is either a Retry token or a NEW_TOKEN (resumption)
  token.
- `details` holds implementation-specific decoded metadata.
- quic-go writes `{"raw":{"data":"<hex>"}}`.

### 7.10 StatelessResetToken

```cddl
StatelessResetToken = hexstring .size 16
```

- The token is carried in stateless reset packets, in transport parameters, and
  in NEW_CONNECTION_ID frames.
- The token is 16 bytes, which is 32 hex characters. `.size 16` on a text
  string would literally mean 16 characters, which is a known spec bug. The
  editor's copy changes it to `hexstring` with the comment "always 16 bytes".
  **Do not validate the length.**

### 7.11 KeyType

```cddl
$KeyType /= "server_initial_secret" /
            "client_initial_secret" /
            "server_handshake_secret" /
            "client_handshake_secret" /
            "server_0rtt_secret" /
            "client_0rtt_secret" /
            "server_1rtt_secret" /
            "client_1rtt_secret"
```

The values are identical to qvis `QlogSchema02.ts:195-207`.

### 7.12 ECN

```cddl
ECN = "Not-ECT" / "ECT(1)" / "ECT(0)" / "CE"
```

These are the ECN codepoints in the IP header.

---

## 8. QUIC frames (-13 §8.13)

`$QuicFrame` is an open type socket. **Any object is a valid frame.** Dispatch
on `frame_type` and render unknown frame types generically.

```cddl
; The QuicFrame is any key-value map (e.g., JSON object)
$QuicFrame /= {
    * text => any
}
```

```cddl
QuicBaseFrames =  PaddingFrame /
                  PingFrame /
                  AckFrame /
                  ResetStreamFrame /
                  ResetStreamAtFrame /
                  StopSendingFrame /
                  CryptoFrame /
                  NewTokenFrame /
                  StreamFrame /
                  MaxDataFrame /
                  MaxStreamDataFrame /
                  MaxStreamsFrame /
                  DataBlockedFrame /
                  StreamDataBlockedFrame /
                  StreamsBlockedFrame /
                  NewConnectionIDFrame /
                  RetireConnectionIDFrame /
                  PathChallengeFrame /
                  PathResponseFrame /
                  ConnectionCloseFrame /
                  HandshakeDoneFrame /
                  UnknownFrame /
                  DatagramFrame

$QuicFrame /= QuicBaseFrames
```

Frame type strings in -13:

`padding`, `ping`, `ack`, `reset_stream`, `reset_stream_at`, `stop_sending`,
`crypto`, `new_token`, `stream`, `max_data`, `max_stream_data`, `max_streams`,
`data_blocked`, `stream_data_blocked`, `streams_blocked`, `new_connection_id`,
`retire_connection_id`, `path_challenge`, `path_response`, `connection_close`,
`handshake_done`, `unknown`, `datagram`

Extension frames seen in the wild include quic-go's `ack_frequency`
(`sequence_number`, `ack_eliciting_threshold`, `request_max_ack_delay`,
`reordering_threshold`) and `immediate_ack`.

Every frame has an optional `raw: RawInfo`, except CRYPTO, where `raw` is
**required**.

### 8.1 PaddingFrame (-13:2807-2823)

A single PaddingFrame SHOULD stand in for all padding in the packet, with
`raw.payload_length` set to the number of PADDING bytes (frames).

```cddl
PaddingFrame = {
    frame_type: "padding"
    ? raw: RawInfo
}
```

Padding byte count: `raw.payload_length ?? raw.length ?? legacy length ??
payload_length`. The last two are older-draft names.

### 8.2 PingFrame

```cddl
PingFrame = {
    frame_type: "ping"
    ? raw: RawInfo
}
```

### 8.3 AckFrame (-13:2834-2894)

```cddl
; either a single number (e.g., [1]) or two numbers (e.g., [1,2]).
; For two numbers:
; the first number is "from": lowest packet number in interval
; the second number is "to": up to and including the highest
; packet number in the interval
AckRange = [1*2 uint64]

AckFrame = {
    frame_type: "ack"

    ; in ms
    ? ack_delay: float32

    ; e.g., looks like [[1,2],[4,5], [7], [10,22]] serialized
    ? acked_ranges: [+ AckRange]

    ; ECN (explicit congestion notification) related fields
    ; (not always present)
    ? ect1: uint64
    ? ect0: uint64
    ? ce: uint64
    ? raw: RawInfo
}
```

Range rules:

- **Ranges need not be ordered.** `[[5,9],[1,4]]` is valid.
- `[120,120]` is legal, but producers SHOULD log `[120]`. **Tools MUST accept
  both.**
- Each range is inclusive: `[from, to]` with from ≤ to.

Other notes:

- The acked PN space is that of the packet that **carries** the ACK. An ACK in
  a 1RTT packet acknowledges application_data packets, which include 0RTT.
- `ack_delay` is in ms and has already been decoded. It is not the raw
  exponent-scaled value.
- qvis parsing (CongestionGraphD3Renderer.ts:1244-1255,
  SequenceDiagramD3Renderer.ts:1796-1815) already handles one- and
  two-element ranges, with values as strings or numbers.

### 8.4 ResetStreamFrame (-13:2896-2930)

If the code has no known `$ApplicationError` string, `error` is `"unknown"` and
`error_code` holds the numeric value.

```cddl
ResetStreamFrame = {
    frame_type: "reset_stream"
    stream_id: uint64
    error: $ApplicationError

    ; if error === "unknown"
    ? error_code: uint64

    ; in bytes
    final_size: uint64
    ? raw: RawInfo
}
```

### 8.5 ResetStreamAtFrame (-13:2932-2956)

This frame comes from draft-ietf-quic-reliable-stream-reset. The -13 prose says
"captured in the error_code_bytes field", but the CDDL uses `error_code`. The
**CDDL is authoritative**, and the editor's copy fixes the prose.

```cddl
ResetStreamAtFrame = {
    frame_type: "reset_stream_at"
    stream_id: uint64
    error: $ApplicationError

    ; if error === "unknown"
    ? error_code: uint64

    ; in bytes
    final_size: uint64

    ; in bytes
    reliable_size: uint64

    ? raw: RawInfo
}
```

### 8.6 StopSendingFrame (-13:2958-2984)

```cddl
StopSendingFrame = {
    frame_type: "stop_sending"
    stream_id: uint64
    error: $ApplicationError

    ; if error === "unknown"
    ? error_code: uint64

    ? raw: RawInfo
}
```

### 8.7 CryptoFrame (-13:2986-2998)

The CRYPTO frame's Length field **MUST** be logged as `raw.length`, so `raw` is
required. The other `raw` sub-fields are optional.

```cddl
CryptoFrame = {
    frame_type: "crypto"
    offset: uint64
    raw: RawInfo
}
```

### 8.8 NewTokenFrame

```cddl
NewTokenFrame = {
  frame_type: "new_token"
  token: Token
  ? raw: RawInfo
}
```

The token length is `token.raw.length`. The old `length` field and the hex-string
`token` became a Token object.

### 8.9 StreamFrame (-13:3010-3037)

If the STREAM frame has a Length field, it **MUST** be logged as `raw.length`.
Without one, the implementation MAY compute the length and log it as
`raw.length`.

```cddl
StreamFrame = {
    frame_type: "stream"
    stream_id: uint64
    ? offset: uint64 .default 0
    ? fin: bool .default false
    ? raw: RawInfo
}
```

- `offset` defaults to 0 and `fin` defaults to false.
- The data length is `raw.length`. It was a required `length` in draft-02.
- The byte range covered is `[offset, offset + raw.length - 1]`.
- See [§11](#11-cheat-sheet-sizes-lengths-packet-numbers-pn-spaces) for the
  recommended fallback chain.

### 8.10 MaxDataFrame

```cddl
MaxDataFrame = {
  frame_type: "max_data"
  maximum: uint64
  ? raw: RawInfo
}
```

### 8.11 MaxStreamDataFrame

```cddl
MaxStreamDataFrame = {
  frame_type: "max_stream_data"
  stream_id: uint64
  maximum: uint64
  ? raw: RawInfo
}
```

### 8.12 MaxStreamsFrame

```cddl
MaxStreamsFrame = {
  frame_type: "max_streams"
  stream_type: StreamType
  maximum: uint64
  ? raw: RawInfo
}
```

### 8.13 DataBlockedFrame

```cddl
DataBlockedFrame = {
  frame_type: "data_blocked"
  limit: uint64
  ? raw: RawInfo
}
```

### 8.14 StreamDataBlockedFrame

```cddl
StreamDataBlockedFrame = {
  frame_type: "stream_data_blocked"
  stream_id: uint64
  limit: uint64
  ? raw: RawInfo
}
```

### 8.15 StreamsBlockedFrame

```cddl
StreamsBlockedFrame = {
  frame_type: "streams_blocked"
  stream_type: StreamType
  limit: uint64
  ? raw: RawInfo
}
```

### 8.16 NewConnectionIDFrame

```cddl
NewConnectionIDFrame = {
  frame_type: "new_connection_id"
  sequence_number: uint64
  retire_prior_to: uint64

  ; mainly used if e.g., for privacy reasons the full
  ; connection_id cannot be logged
  ? connection_id_length: uint8
  connection_id: ConnectionID
  ? stateless_reset_token: StatelessResetToken
  ? raw: RawInfo
}
```

The old draft-02 names were `length` and `reset_token`.

### 8.17 RetireConnectionIDFrame

```cddl
RetireConnectionIDFrame = {
  frame_type: "retire_connection_id"
  sequence_number: uint64
  ? raw: RawInfo
}
```

### 8.18 PathChallengeFrame

```cddl
PathChallengeFrame = {
  frame_type: "path_challenge"

  ; always 64 bits
  ? data: hexstring
  ? raw: RawInfo
}
```

### 8.19 PathResponseFrame

```cddl
PathResponseFrame = {
  frame_type: "path_response"

  ; always 64 bits
  ? data: hexstring
  ? raw: RawInfo
}
```

### 8.20 ConnectionCloseFrame (-13:3175-3225)

Notes:

- An unknown error code goes in `error_code`, numerically.
- `trigger_frame_type` applies only to the transport variant (type 0x1c). Log a
  known frame type as its string, for example `"stream"`, and an unknown one as
  a uint64. The editor's copy (ed:2336-2340) clarifies the garbled -13 prose.
- The reason phrase goes in `reason` (UTF-8) or `reason_bytes` (hex).
  Producers SHOULD log at least one and MAY log both.

```cddl
ErrorSpace = "transport" /
             "application"

ConnectionCloseFrame = {
    frame_type: "connection_close"
    ? error_space: ErrorSpace
    ? error: $TransportError / CryptoError /
             $ApplicationError

    ; if error === "unknown"
    ? error_code: uint64

    ? reason: text
    ? reason_bytes: hexstring

    ; when error_space === "transport"
    ? trigger_frame_type: uint64 /
                          text
    ? raw: RawInfo
}
```

The old draft-02 `application_close` frame type no longer exists. It is now
`connection_close` with `error_space: "application"`.

### 8.21 HandshakeDoneFrame

```cddl
HandshakeDoneFrame = {
  frame_type: "handshake_done"
  ? raw: RawInfo
}
```

### 8.22 UnknownFrame

`frame_type_bytes` is the numeric frame type, not varint encoded.

```cddl
UnknownFrame = {
    frame_type: "unknown"
    frame_type_bytes: uint64
    ? raw: RawInfo
}
```

### 8.23 DatagramFrame (-13:3261-3275)

This is the RFC 9221 DATAGRAM frame. If it has a Length field, that length MUST
be logged as `raw.length`. Otherwise the implementation MAY compute the length.

```cddl
DatagramFrame = {
    frame_type: "datagram"
    ? raw: RawInfo
}
```

---

## 9. Errors (-13 §8.13.24-26)

### 9.1 TransportError

```cddl
$TransportError /= "no_error" /
                 "internal_error" /
                 "connection_refused" /
                 "flow_control_error" /
                 "stream_limit_error" /
                 "stream_state_error" /
                 "final_size_error" /
                 "frame_encoding_error" /
                 "transport_parameter_error" /
                 "connection_id_limit_error" /
                 "protocol_violation" /
                 "invalid_token" /
                 "application_error" /
                 "crypto_buffer_exceeded" /
                 "key_update_error" /
                 "aead_limit_reached" /
                 "no_viable_path" /
                 "unknown"
                 ; there is no value to reflect CRYPTO_ERROR
                 ; use the CryptoError type instead
```

### 9.2 ApplicationError

`$ApplicationError` is a socket with the single base value `"unknown"`.
Application-level schemas MUST extend it. HTTP/3 does so with
`HTTP3ApplicationError`, for example `"http_no_error"`; see the h3 digest.

```cddl
$ApplicationError /= "unknown"
```

Example extension:

```cddl
$ApplicationError /= "new_error_name" /
                     "another_new_error_name"
```

### 9.3 CryptoError

The error string is `crypto_error_` plus the QUIC code in hex: 0x100 plus the
TLS alert, zero-padded. The editor's copy specifies lowercase hex and gives the
example `crypto_error_0x128` for handshake_failure.

```cddl
; all strings from "crypto_error_0x100" to "crypto_error_0x1ff"
CryptoError = text .regexp "crypto_error_0x1[0-9a-f][0-9a-f]"
```

quic-go formats these as `crypto_error_%#x`, which produces the same output.

---

## 10. Packet coalescing

Source: -13 §9 (-13:3383-3397).

Several QUIC packets can share one UDP datagram, especially during the
handshake. Neither QUIC nor UDP marks this, so qlog defines a "datagram
identifier":

- packet events (`packet_sent`, `packet_received`, `packet_dropped`,
  `packet_buffered`) carry `datagram_id: uint32`;
- UDP events (`udp_datagrams_sent`, `udp_datagrams_received`) carry
  `datagram_ids: [+ uint32]`;
- **events with the same `datagram_id` were coalesced into the same datagram.**
  Values are implementation-chosen and only locally unique, so they **cannot be
  correlated across traces**;
- `udp_datagrams_*` `datagram_ids[i]` pairs with `raw[i]`, and with `ecn[i]`
  when the arrays have equal length.

The old draft-02 `is_coalesced: bool` field is gone. "Coalesced" now means
"another packet event has the same datagram_id".

The **editor's copy** replaces the mechanism:

- `datagram_payload_checksum: uint32` is a **CRC32c of the UDP payload** (per
  RFC 9868 §11.3);
- `datagram_payload_checksums: [+ uint32]` is the per-datagram equivalent;
- because the value comes from content, it **can** match the same datagram
  across client and server traces. Collisions are possible but rare.

quic-go master already emits `datagram_payload_checksum`. quiche emits
`datagram_id` and `datagram_ids`.

**Recommendation:** read `coalescingKey = datagram_payload_checksum ??
datagram_id` and keep track of which kind it is. Use it for cross-trace matching
only when it is a checksum.

---

## 11. Cheat sheet: sizes, lengths, packet numbers, PN spaces

| What | Latest path (-13) | Fallbacks to accept (older or real-world) | Notes |
|---|---|---|---|
| Packet size on wire (header + payload + AEAD tag) | `packet_*.data.raw.length` | `data.header.packet_size` (draft-01/02), `data.raw.length` as a string | qvis requires it to place packets in the congestion graph (CongestionGraphD3Renderer.ts:1120-1126). Missing means the packet is skipped. |
| Packet payload size (no header, no tag) | `data.raw.payload_length` | `data.header.payload_length` | For protected packets, `header_len = raw.length - raw.payload_length - 16`. |
| Long-header Length field (PN + payload) | `data.header.length` (-13 only) | none | **Not** the packet size. Removed in the editor's copy. Ignore for sizing. |
| Packet number | `data.header.packet_number` (uint64, optional) | numeric string | Absent for retry, VN, and stateless_reset. |
| Packet number length | `data.header.packet_number_length` | none | Optional. |
| PN space | inferred: `initial`→`initial`, `handshake`→`handshake`, `0RTT`/`1RTT`→`application_data` | none | `packets_acked` and `timer_updated` carry it explicitly. `packets_acked` defaults to application_data. |
| Lost packet identity | `packet_lost.data.header.{packet_type,packet_number}` | none | No raw size: look it up from `packet_sent`. |
| First-time acked PNs | `packets_acked.data.packet_numbers[]` + `packet_number_space` | derive from ACK frames | |
| Frame-event packet linkage | `frames_*.data.packet_numbers[i]` ↔ `frames[i]` | none | |
| STREAM data length | `frame.raw.length` | `frame.raw.payload_length`, **`frame.length`** (draft-02; quic-go master still emits it) | Recommended: `dataLen = raw.payload_length ?? raw.length ?? length`. A producer following main-schema RawInfo semantics would put the frame total in `raw.length` and the data length in `payload_length`. |
| CRYPTO data length | `frame.raw.length` (required) | `frame.length` (quic-go) | Same chain as STREAM. |
| DATAGRAM data length | `frame.raw.length` | `frame.length` (quic-go) | Same chain. |
| PADDING byte count | `frame.raw.payload_length` | `frame.raw.length`, `frame.length`, `frame.payload_length` | One frame per packet. |
| NEW_TOKEN token length | `frame.token.raw.length` | `frame.length` | |
| NEW_CONNECTION_ID CID length | `frame.connection_id_length` | `frame.length` | |
| Stream bytes moved between layers | `stream_data_moved.data.raw.length` | `data_moved.data.length` | |
| UDP datagram sizes | `udp_datagrams_*.data.raw[i].length` | `byte_length` (draft-01) | UDP payload only. |

**Spec ambiguities to note in the code:**

1. -13 §8.8 (-13:2618-2621) says the long-header Length field "is logged in the
   qlog raw.length field". Main-schema RawInfo (main:2211-2224) defines
   `raw.length` as the full entity length. Every known producer logs the full
   packet size in `raw.length`: quic-go writes "length ... for the full packet,
   including header and AEAD tag" and "payload_length, which excludes the tag".
   **Treat `raw.length` on packet events as the full packet size.**
2. The STREAM, CRYPTO, and DATAGRAM rule ("Length field MUST be logged in
   raw.length") gives `raw.length` a data-length meaning on those frames. The
   -13 example at -13:1663-1674 confirms it. This conflicts with the generic
   RawInfo meaning, hence the fallback chain above.
3. qvis's packetization diagram computes
   `payloadLength = raw.payload_length - 16` and
   `headerLength = raw.length - payloadLength`
   (PacketizationQUICPreProcessor.ts:236-254). That treats `payload_length` as
   *including* the 16-byte tag. Under -13 semantics (payload excludes the
   trailer), the correct values are `payload = raw.payload_length` and
   `header = raw.length - raw.payload_length - 16`. This is a parity decision:
   flag it to the packetization implementer.

---

## 12. Extension points and tolerance rules

Every `* $$quic-<event>-extension` group socket means "extra fields may appear".
These sockets are listed in each CDDL block. -13 lacks them on the three
`*_data_blocked_updated` events, and the editor's copy adds them. The `$...`
type sockets are open enums or unions:

- `$ProtocolEventData`, `$QuicFrame`
- `$PacketType`, `$PacketNumberSpace`, `$KeyType`, `$TokenType`
- `$TransportError`, `$ApplicationError`
- `$ConnectionState`, `$StreamState`
- `$DataLocation`, `$DataMovedAdditionalInfo`
- `$BlockedState`, `$BlockedReason`
- `$TimerType`

Tool rules:

1. Unknown event names, including unknown `quic:*` events: show them generically
   (name plus JSON). Never drop the trace.
2. Unknown fields: ignore them for logic, but show them in detail panes.
3. Unknown enum values: display the raw string. -13 explicitly requires this for
   connection and stream states (-13:714-717, -13:794-797, -13:1629-1632) and
   for recovery data (-13:2209-2213).
4. Unknown `frame_type`: show the name, color it as "unknown" (qvis default red,
   SequenceDiagramD3Renderer.ts:1783-1788), and count it in statistics.

---

## 13. Diff vs old qlog draft-02 QUIC events (`QlogSchema02.ts`)

qvis's `QlogSchema02.ts` is a mix of draft-01 and draft-02 types. Its
`versionAliases` are `draft-02`, `draft-02-RC1`, `qlog-03-WIP`, and `0.3`
(QlogSchema02.ts:10-14). The tables below map **every** QUIC event and every
frame and field name in that file to the latest draft. A few draft-02 spec
events that qvis references by string, not enum, are included as well:
`loss_timer_updated` (SequenceDiagramD3Renderer.ts:1960, 2082) and `data_moved`
(through `HTTP3EventType.data_moved`).

### 13.1 Top-level naming change

| Old (draft-02) | Latest |
|---|---|
| `name: "<category>:<event>"`, or `category` + `event`/`name` fields | `name: "quic:<event>"`. There is no category field. |
| Categories `connectivity`, `transport`, `security`, `recovery` (QlogSchema02.ts:135-149) | One namespace, `quic` |
| `Connection.lookup(category, name)` keyed by category (Connection.ts:126-161) | Key by `"quic"` + event type, or by the full name. |
| Events disambiguated by category, for example `transport:parameters_set` versus `recovery:parameters_set` (SequenceDiagramD3Renderer.ts:2050-2064) | Distinct names: `quic:parameters_set` versus `quic:recovery_parameters_set` |

### 13.2 Event mapping (every old event)

| Old (category:name) | QlogSchema02.ts | Latest name | Status |
|---|---|---|---|
| `connectivity:server_listening` | `ConnectivityEventType.server_listening` (:152), `IEventServerListening` (:224-234) | `quic:server_listening` | Fields changed (§13.3). |
| `connectivity:connection_started` | :153, `IEventConnectionStarted` (:236-248) | `quic:connection_started` | **Restructured** into `local` and `remote` TupleEndpointInfo. |
| `connectivity:connection_id_updated` | :154, `IEventConnectionIDUpdated` (:250-256) | `quic:connection_id_updated` | **Restructured**: `src_*`/`dst_*` become `initiator` + `old`/`new`. |
| `connectivity:spin_bit_updated` | :155, `IEventSpinBitUpdated` (:258-260) | `quic:spin_bit_updated` | Same (`state`). |
| `connectivity:connection_state_updated` | :156, `IEventConnectionStateUpdated` (:262-265) | `quic:connection_state_updated` | Same fields. The state enum changed (§13.5). |
| `connectivity:connection_closed` / `transport:connection_closed` (draft-02 spec; not in QlogSchema02) | none | `quic:connection_closed` | |
| `transport:parameters_set` | `TransportEventType.parameters_set` (:160), `IEventTransportParametersSet` (:297-325) | `quic:parameters_set` | Several fields renamed. |
| `transport:datagrams_sent` | :162, `IEventDatagramsSent` (:343-346) | `quic:udp_datagrams_sent` | **Renamed.** `byte_length` becomes `raw[].length`. |
| `transport:datagrams_received` | :163, `IEventDatagramsReceived` (:338-341) | `quic:udp_datagrams_received` | **Renamed.** |
| `transport:datagram_dropped` | :164, `IEventDatagramDropped` (:348-350) | `quic:udp_datagram_dropped` | **Renamed.** `byte_length` becomes `raw.length`. |
| `transport:packet_sent` | :166, `IEventPacketSent` (:374-381) | `quic:packet_sent` | `is_coalesced` removed. Several fields added. |
| `transport:packet_received` | :167, `IEventPacketReceived` (:365-372) | `quic:packet_received` | Same changes as `packet_sent`. |
| `transport:packet_dropped` | :168, `IEventPacketDropped` (:383-387) | `quic:packet_dropped` | Triggers changed. |
| `transport:packet_buffered` | :169, `IEventPacketBuffered` (:389-393) | `quic:packet_buffered` | `header` is now optional. `trigger` added. |
| `transport:frames_processed` | :171, `IEventFramesProcessed` (:444-446) | `quic:frames_processed` (-13). Removed in the editor's copy, where `frames_created` and `frames_parsed` take over. | `packet_numbers` added. |
| `transport:stream_state_updated` | :173, `IEventStreamStateUpdated` (:406-414) | `quic:stream_state_updated` | `stream_side` is now required. `trigger` added. |
| `transport:version_information`, `transport:alpn_information`, `transport:parameters_restored`, `transport:packets_acked` (draft-02 spec only) | none | `quic:version_information`, `quic:alpn_information`, `quic:parameters_restored`, `quic:packets_acked` | ALPN values are now ALPNIdentifier objects. |
| `transport:data_moved` / `http:data_moved` | `HTTP3EventType.data_moved` (:528), `IEventH3DataMoved` (:594-603) | `quic:stream_data_moved` | **Renamed and moved.** `length` becomes `raw.length`. `from` and `to` gain `"network"`. `raw` (hex) becomes `raw.data`. |
| `security:key_updated` | `SecurityEventType.key_updated` (:177), `IEventKeyUpdated` (:280-285) | `quic:key_updated` | `generation` becomes `key_phase`. `new` is now optional. `trigger` added. |
| `security:key_retired` | :178, `IEventKeyRetired` (:287-291) | `quic:key_discarded` | **Renamed.** `generation` becomes `key_phase`. `key` is now optional. |
| `recovery:parameters_set` | `RecoveryEventType.parameters_set` (:182), `IEventRecoveryParametersSet` (:451-464) | `quic:recovery_parameters_set` | **Renamed.** `timer_granularity` is now required. |
| `recovery:metrics_updated` | :183, `IEventMetricsUpdated` (:466-487) | `quic:recovery_metrics_updated` | **Renamed.** `max_ack_delay` and `in_recovery` removed. |
| `recovery:congestion_state_updated` | :184, `IEventCongestionStateUpdated` (:489-492) | `quic:congestion_state_updated` | `trigger` added. |
| `recovery:loss_timer_set` (draft-01) | :186, `IEventLossTimerSet` (:494-497) | `quic:timer_updated` with `event_type: "set"` | `timeout` becomes `delta`. |
| `recovery:loss_timer_triggered` (draft-01) | :187, `IEventLossTimerExpired` (:499-501) | `quic:timer_updated` with `event_type: "expired"` | |
| `recovery:loss_timer_updated` (draft-02 spec; string literal in qvis) | none | `quic:timer_updated` | Same field names, plus `timer_id`. The `timer_type` set is extended. |
| `recovery:packet_lost` | :189, `IEventPacketLost` (:503-507) | `quic:packet_lost` | `is_mtu_probe_packet` and `trigger` added. |
| `recovery:marked_for_retransmit` | :190, `IEventMarkedForRetransmit` (:509-511) | `quic:marked_for_retransmit` | `frames` must be non-empty. |
| none | none | `quic:tuple_assigned`, `quic:mtu_updated`, `quic:frames_created`, `quic:frames_parsed`, `quic:datagram_data_moved`, `quic:connection_data_blocked_updated`, `quic:stream_data_blocked_updated`, `quic:datagram_data_blocked_updated`, `quic:migration_state_updated`, `quic:ecn_state_updated` | **New** events with no draft-02 equivalent. |

Generic and other old categories (`error`, `warning`, `info`, `debug`,
`verbose`, `simulation`; QlogSchema02.ts:143-148, 699-739) are **not** in the
quic namespace. The main schema covers them in the `loglevel` and `simulation`
namespaces. The old `generic:connection_error` and
`generic:application_error` events map best onto `quic:connection_closed`
(`connection_error`, `application_error`, `reason`).

### 13.3 Field mapping per event

**server_listening** (QlogSchema02.ts:224-234):

| Old field | Latest |
|---|---|
| `ip_v4`, `ip_v6`, `port_v4`, `port_v6` | Same in -13. Editor's copy: `address_v4: {ip, port}`, `address_v6: {ip, port}` |
| `quic_versions` | Removed. Use `quic:version_information.server_versions`. |
| `alpn_values` | Removed. Use `quic:alpn_information.server_alpns`. |
| `stateless_reset_required` | `retry_required` |

**connection_started** (QlogSchema02.ts:236-248):

| Old field | Latest |
|---|---|
| `ip_version` | Implied by which of `ip_v4` or `ip_v6` is set. |
| `src_ip`, `src_port` | `local.ip_v4`/`ip_v6`, `local.port_v4`/`port_v6`. Heuristic: "src" is the logging endpoint. |
| `dst_ip`, `dst_port` | `remote.ip_v*`, `remote.port_v*` |
| `src_cid`, `dst_cid` | `local.connection_ids[0]`, `remote.connection_ids[0]` |
| `protocol` | Removed. |
| `quic_version` | Removed. Use `quic:version_information.chosen_version`. |

**connection_id_updated** (QlogSchema02.ts:250-256):

| Old field | Latest |
|---|---|
| `src_old`, `src_new` | `initiator: "local"`, `old`, `new` (heuristic) |
| `dst_old`, `dst_new` | `initiator: "remote"`, `old`, `new` (heuristic) |
| draft-02 spec `owner` | `initiator` |

**connection_state_updated** (QlogSchema02.ts:262-265): `old` and `new` are
unchanged. The enum changed (§13.5).

**key_updated** (QlogSchema02.ts:280-285):

| Old field | Latest |
|---|---|
| `key_type` | Same |
| `old` | Same |
| `new` (was required) | Optional |
| `generation` | `key_phase` |
| none | New `trigger` |

**key_retired → key_discarded** (QlogSchema02.ts:287-291):

| Old field | Latest |
|---|---|
| `key_type` | Same |
| `key` (was required) | Optional |
| `generation` | `key_phase` |
| none | New `trigger` |

**parameters_set** (QlogSchema02.ts:297-325):

| Old field | Latest |
|---|---|
| `owner` | **`initiator`**. qvis reads it at CongestionGraphD3Renderer.ts:1100, StatisticsConnectionRenderer.vue:467, 506, and PacketizationQUICPreProcessor.ts:468, 473. |
| `resumption_allowed`, `early_data_enabled`, `tls_cipher` | Same |
| `alpn` | Removed. Use `quic:alpn_information.chosen_alpn`. |
| `version` | Removed. Use `quic:version_information.chosen_version`. |
| `original_connection_id` | `original_destination_connection_id` |
| `stateless_reset_token` | Same (StatelessResetToken) |
| `disable_active_migration` | Same |
| `idle_timeout` | `max_idle_timeout` |
| `max_packet_size` | **`max_udp_payload_size`**. qvis uses it for packetization max size (PacketizationQUICPreProcessor.ts:469-475). |
| `ack_delay_exponent`, `max_ack_delay`, `active_connection_id_limit` | Same (uint64) |
| `initial_max_data`, `initial_max_stream_data_bidi_local`, `initial_max_stream_data_bidi_remote`, `initial_max_stream_data_uni`, `initial_max_streams_bidi`, `initial_max_streams_uni` | Same names. Typed `string` in qvis, uint64 now: numbers, or strings per I-JSON. |
| `preferred_address.{ip_v4, ip_v6, port_v4, port_v6, connection_id, stateless_reset_token}` | Same in -13, with ports now uint16 numbers rather than strings. Editor's copy: `address_v4`/`address_v6`. |
| none | New: `initial_source_connection_id`, `retry_source_connection_id`, `unknown_parameters`, `max_datagram_frame_size`, `grease_quic_bit`, `reset_stream_at` |

**datagrams_sent / datagrams_received → udp_datagrams_*** (QlogSchema02.ts:338-346):

| Old field | Latest |
|---|---|
| `count` | Same |
| `byte_length` | `raw: [+ RawInfo]`, one per datagram. Total = Σ `raw[i].length`. |
| none | New `ecn[]` and `datagram_ids[]` |

**datagram_dropped → udp_datagram_dropped** (QlogSchema02.ts:348-350):
`byte_length` becomes `raw.length`.

**packet_sent / packet_received** (QlogSchema02.ts:356-381):

| Old field | Latest |
|---|---|
| `header` | Same, but PacketHeader changed (below). |
| `frames` | Same |
| `is_coalesced` | **Removed.** Use `datagram_id`, or `datagram_payload_checksum` in the editor's copy. |
| `raw: IRawInfo{length, payload_length, data}` | Same RawInfo. Typed `number` in qvis, now uint64. |
| none | New: `stateless_reset_token`, `supported_versions`, `datagram_id`, `trigger`, and `is_mtu_probe_packet` (sent only) |

**packet_dropped** (QlogSchema02.ts:383-387): `header` and `raw` are the same.
New: `datagram_id`, `details`, and `trigger`.

**packet_buffered** (QlogSchema02.ts:389-393): `header` changed from required to
optional. `raw` is the same. New: `datagram_id` and `trigger`.

**PacketHeader** (QlogSchema02.ts:770-786, plus auto-fixes in
QlogLoaderV2.ts:198-240):

| Old field | Latest |
|---|---|
| `packet_type` | Same values |
| `packet_number: quint64` (required) | `packet_number: uint64`, now optional |
| `payload_length` (header) | `raw.payload_length` on the event. qvis already migrated it (QlogLoaderV2.ts:213-225). |
| `packet_size` (header, draft-01) | `raw.length` on the event (QlogLoaderV2.ts:199-211) |
| `version`, `scid`, `dcid` | Same (hexstring) |
| `scil`, `dcil` (typed string in qvis) | uint8 numbers |
| draft-02 spec `flags` (first byte) | Split into `spin_bit` and `key_phase_bit`. Also new: `key_phase`. |
| draft-02 spec `token`, `length` | `token` (now a Token object), `length` (-13 only) |
| top-level `data.packet_type` (draft-01) | `data.header.packet_type` (QlogLoaderV2.ts:228-240) |
| none | New: `packet_type_bytes` and `packet_number_length` |

**stream_state_updated** (QlogSchema02.ts:406-442):

| Old field | Latest |
|---|---|
| `stream_id: string` | uint64 |
| `stream_type` | Same |
| `old`, `new` | Same names. Values are strings. **qvis's `StreamState` is a numeric TS enum** (no string initializers), so do not port it. |
| `stream_side` (optional) | **Required** |
| none | New `trigger` |

**frames_processed** (QlogSchema02.ts:444-446): `frames` changed from optional to
required. New: `packet_numbers`.

**recovery parameters_set → recovery_parameters_set** (QlogSchema02.ts:451-464):
all field names are unchanged.

- `timer_granularity` is now **required**.
- `timer_granularity` and `initial_rtt` were "ms or us depending on
  configuration" and are now **always ms**.

**metrics_updated → recovery_metrics_updated** (QlogSchema02.ts:466-487):

| Old field | Latest |
|---|---|
| `min_rtt`, `smoothed_rtt`, `latest_rtt`, `rtt_variance` | Same. Now always ms (float32). |
| `max_ack_delay` | **Removed.** It is the transport parameter `quic:parameters_set.max_ack_delay`. |
| `pto_count`, `congestion_window`, `bytes_in_flight`, `ssthresh`, `packets_in_flight`, `pacing_rate` | Same |
| `in_recovery` | **Removed.** Use `quic:congestion_state_updated`. |
| `cwnd` (pre-draft-01, still read by qvis) | `congestion_window` |

**congestion_state_updated** (QlogSchema02.ts:489-492): `old` and `new` are the
same (free text). New: `trigger`.

**loss_timer_set / loss_timer_triggered / loss_timer_updated → timer_updated**
(QlogSchema02.ts:494-501):

| Old field | Latest |
|---|---|
| `timer_type: "ack" \| "pto"` | `timer_type: $TimerType`. Adds `loss_timeout`, `path_validation`, `handshake_timeout`, `idle_timeout`, and custom values. |
| `timeout` | `delta` (ms) |
| event name `loss_timer_set` | `event_type: "set"` |
| event name `loss_timer_triggered` | `event_type: "expired"` |
| `packet_number_space` (draft-02) | Same |
| none | New `timer_id` |

**packet_lost** (QlogSchema02.ts:503-507): `header` and `frames` are the same.
New: `is_mtu_probe_packet` and `trigger`.

**marked_for_retransmit** (QlogSchema02.ts:509-511): `frames` is the same and
must be non-empty.

**data_moved → stream_data_moved** (QlogSchema02.ts:594-603):

| Old field | Latest |
|---|---|
| `stream_id: string` | uint64, now optional |
| `offset: string` | uint64 |
| `length: number` | **`raw.length`** |
| `from`, `to`: `"application" \| "transport"` | `$DataLocation`, which adds `"network"` |
| `raw: string` (hex) | `raw.data` |
| none | New `additional_info` |

### 13.4 Frame mapping (QlogSchema02.ts:745-975)

| Old `frame_type` (`QUICFrameTypeName`) | Old fields | Latest `frame_type` | Latest fields and notes |
|---|---|---|---|
| `padding` | none | `padding` | `raw.payload_length` is the padding byte count. |
| `ping` | none | `ping` | `raw` |
| `ack` | `ack_delay: string`, `acked_ranges: [string,string][]`, `ect1`, `ect0`, `ce` | `ack` | `ack_delay: float32` (ms). `acked_ranges: [[from,to] or [n]]` as uint64. `ect1`, `ect0`, `ce`, `raw`. |
| `reset_stream` | `stream_id`, `error_code: ApplicationError\|number`, `final_size` | `reset_stream` | `stream_id`, **`error`** ($ApplicationError), **`error_code`** (uint64, when error is "unknown"), `final_size`, `raw` |
| none | none | `reset_stream_at` | **New:** `stream_id`, `error`, `error_code`, `final_size`, `reliable_size`, `raw` |
| `stop_sending` | `stream_id`, `error_code` | `stop_sending` | `stream_id`, **`error`**, **`error_code`**, `raw` |
| `crypto` | `offset`, `length` | `crypto` | `offset`, **`raw.length`** (raw required) |
| `new_token` | `length`, `token: string` | `new_token` | **`token: Token`** (`{type?, details?, raw?}`), `raw`. Old `length` becomes `token.raw.length`. Old hex `token` becomes `token.raw.data`. |
| `stream` | `stream_id`, `offset`, `length`, `fin`, `raw: string` | `stream` | `stream_id`, `offset` (default 0), `fin` (default false), **`raw.length`**. Old `raw` hex becomes `raw.data`. |
| `max_data` | `maximum` | `max_data` | Same, plus `raw` |
| `max_stream_data` | `stream_id`, `maximum` | `max_stream_data` | Same, plus `raw` |
| `max_streams` | `stream_type`, `maximum` | `max_streams` | Same, plus `raw` |
| `data_blocked` | `limit` | `data_blocked` | Same, plus `raw` |
| `stream_data_blocked` | `stream_id`, `limit` | `stream_data_blocked` | Same, plus `raw` |
| `streams_blocked` | `stream_type`, `limit` | `streams_blocked` | Same, plus `raw` |
| `new_connection_id` | `sequence_number`, `retire_prior_to`, `length`, `connection_id`, `reset_token` | `new_connection_id` | `sequence_number`, `retire_prior_to`, **`connection_id_length`**, `connection_id`, **`stateless_reset_token`**, `raw` |
| `retire_connection_id` | `sequence_number` | `retire_connection_id` | Same, plus `raw` |
| `path_challenge` | `data` | `path_challenge` | Same (8-byte hex), plus `raw` |
| `path_response` | `data` | `path_response` | Same, plus `raw` |
| `connection_close` | `error_space: "transport_error"\|"application_error"`, `error_code`, `raw_error_code`, `reason`, `trigger_frame_type: number` | `connection_close` | `error_space: "transport"\|"application"`, **`error`** (was `error_code`), **`error_code`** (was `raw_error_code`), `reason`, `reason_bytes` (new), `trigger_frame_type: uint64\|text`, `raw` |
| `application_close` | Same as connection_close | **`connection_close`** with `error_space: "application"` | Removed frame type. |
| `unknown_frame_type` | `raw_frame_type`, `raw: string` | **`unknown`** | **`frame_type_bytes`**, `raw` (RawInfo) |
| none | none | `handshake_done` | **New:** `raw` |
| none | none | `datagram` | **New:** `raw.length` is the datagram data length. |

**Watch out: `error_code` changed meaning.** In draft-02 it was the string enum
or a number. In -13 it is always the numeric raw code and appears only when
`error` is `"unknown"`. Normalization (the qvis display logic at
SequenceDiagramD3Renderer.ts:1825-1849 and 1907-1933 should be rewritten this
way):

```
displayError = frame.error ?? (typeof frame.error_code === "string" ? frame.error_code : undefined)
numericCode  = typeof frame.error_code === "number" || /^\d+$/.test(frame.error_code)
                 ? Number(frame.error_code) : (frame.raw_error_code ?? frame.error_code_value ?? frame.error_code_bytes)
clean        = displayError === "no_error" || displayError === "http_no_error" || numericCode === 0
```

### 13.5 Enum and value mapping

**PacketType**: unchanged
(`initial|handshake|0RTT|1RTT|retry|version_negotiation|stateless_reset|unknown`).

**KeyType**: unchanged.

**ErrorSpace** (QlogSchema02.ts:934-937):

| qvis enum | Latest |
|---|---|
| `transport_error` | `transport` |
| `application_error` | `application` |

**TransportError** (QlogSchema02.ts:950-964):

| Old value | Latest |
|---|---|
| `no_error`, `internal_error`, `flow_control_error`, `stream_limit_error`, `stream_state_error`, `final_size_error`, `frame_encoding_error`, `transport_parameter_error`, `protocol_violation`, `crypto_buffer_exceeded`, `unknown` | Same |
| `server_busy` | `connection_refused` |
| `invalid_migration` | Removed (closest: `protocol_violation`) |
| none | New: `connection_id_limit_error`, `invalid_token`, `application_error`, `key_update_error`, `aead_limit_reached`, `no_viable_path` |

**CryptoError** (QlogSchema02.ts:966-968; prefix `crypto_error_`): latest is
`crypto_error_0x1XX`, with lowercase hex and the `0x` prefix.

**ApplicationError** (QlogSchema02.ts:1053-1073): moved to the h3 digest
(`HTTP3ApplicationError`). Base value: `"unknown"`.

**ConnectionState** (QlogSchema02.ts:267-275, draft-01 values):

| Old value | Latest |
|---|---|
| `attempted` | `attempted` |
| `handshake` | `handshake_started` |
| `active` | `handshake_complete` (closest match) |
| `draining` | `draining` |
| `closed` | `closed` |
| `reset`, `keepalive` | No equivalent: render as custom states |
| none | New: `peer_validated`, `early_write`, `handshake_confirmed`, `closing` |

**StreamState** (QlogSchema02.ts:416-442): the names are the same as the latest
Base and Granular union. qvis's TS enum is numeric, so use string literals in
the rewrite.

**packet_dropped trigger**: the draft-02 values are still emitted by quic-go
master. Map them as follows:

| Old trigger | Latest |
|---|---|
| `key_unavailable` | `key_unavailable` (editor's copy: `keys_unavailable`) |
| `unknown_connection_id` | `connection_unknown` |
| `header_parse_error` | `invalid` |
| `payload_decrypt_error` | `decryption_failure` |
| `protocol_violation` | `invalid` |
| `dos_prevention` | `rejected` |
| `unsupported_version` | `unsupported` |
| `unexpected_packet` | `invalid` |
| `unexpected_source_connection_id` | `invalid` |
| `unexpected_version` | `unsupported` |
| `duplicate` | `duplicate` |
| `invalid_initial` | `invalid` |

Display the original string in any case.

**Value types**: qvis typed many uint64 fields as `string` (`quint64 = number |
string`, QlogSchema02.ts:121). Latest types are numbers, but strings are still
allowed (I-JSON). Keep using `toNum()`.

### 13.6 Where qvis consumes QUIC fields, and the latest path

Use this table to port each visualization 1:1.

| qvis site | Old access | Latest access |
|---|---|---|
| Connection.ts:126-161, QlogLoaderV2.ts:329-363 | category/name split, lookup by category | `name.split(":",2)`, `lookup("quic", type)`, after alias normalization |
| CongestionGraphD3Renderer.ts:1081-1085 | `lookup(transport, packet_sent)`, `lookup(transport, packet_received)`, `lookup(recovery, packet_lost)`, `lookup(recovery, metrics_updated)`, `lookup(transport, parameters_set)` | `quic:packet_sent`, `quic:packet_received`, `quic:packet_lost`, `quic:recovery_metrics_updated`, `quic:parameters_set` |
| CongestionGraphD3Renderer.ts:1100-1106 | `data.owner === "remote"`, `initial_max_data`, `initial_max_stream_data_bidi_remote` | `data.initiator === "remote"`, same parameter names. **Fold cumulative parameters_set state.** |
| CongestionGraphD3Renderer.ts:1120-1137, 1165-1178 | `data.raw.length`, `data.header.packet_type`, `data.header.packet_number` | Same paths |
| CongestionGraphD3Renderer.ts:1202-1229 | frames `ack`, `max_data.maximum`, `max_stream_data.{stream_id,maximum}` | Same |
| CongestionGraphD3Renderer.ts:1240-1285, 1325-1364 | `frame.acked_ranges` ([a,b] or [a]); lookup keyed by **packet_type** of the carrying packet | Same format. Note: the latest spec ties ACKs to the PN space. qvis's per-packet_type keying misses 0RTT packets acked in 1RTT. Decide whether to keep 1:1 parity or fix this. |
| CongestionGraphD3Renderer.ts:1403-1440, 1832-1860 | `bytes_in_flight`, `cwnd` or `congestion_window`, `min_rtt`, `smoothed_rtt`, `latest_rtt` through `timeToMilliseconds()` | Same names, already in ms |
| CongestionGraphD3Renderer.ts:1601, 1691 | `raw.length` on sent and lost packets | Sent: same. Lost: look up the matching `packet_sent`. |
| SequenceDiagramD3Renderer.ts:85-86, 494-515, 545-549, 709-734, 1038-1063, 1101-1105, 1170-1172, 1566 | `packet_sent`/`packet_received` names; `header.packet_type`/`packet_number`; renaming sent↔received for synthesized traces | `quic:packet_sent`/`quic:packet_received`. The rename-by-substring setter still works on `"quic:packet_sent"`. |
| SequenceDiagramD3Renderer.ts:112-130, 651-695 | `metrics_updated` fold; `latest_rtt`/`smoothed_rtt` for clock alignment | `quic:recovery_metrics_updated`, same fields, ms |
| SequenceDiagramD3Renderer.ts:1791-1939 (`frameToShortString`) | ack `acked_ranges`; stream `stream_id` + `fin`; connection_close `error_code`/`raw_error_code`/`reason`; max_* `maximum`; *_blocked `limit`; reset_stream/stop_sending `error_code` | Same except errors: use `error ?? error_code` (§13.4). `application_close` becomes `connection_close`. |
| SequenceDiagramD3Renderer.ts:1941-1982 (`eventTypeToColor`) | `connection_id_updated`, `spin_bit_updated`, `connection_state_updated(new ∈ {closed,draining})`, `metrics_updated`, transport, recovery and http `parameters_set`, `loss_timer_updated`, `datagrams_sent`/`received` | `quic:connection_id_updated`, `quic:spin_bit_updated`, `quic:connection_state_updated`, `quic:recovery_metrics_updated`, `quic:parameters_set`, `quic:recovery_parameters_set`, `http3:parameters_set`, `quic:timer_updated`, `quic:udp_datagrams_sent`/`received` |
| SequenceDiagramD3Renderer.ts:1984-2120 (`eventToShortString`) | spin `state`; metrics `cwnd`/`smoothed_rtt`/`bytes_in_flight`/`ssthresh`; parameters_set count by category; `connection_state_updated.new`; `loss_timer_updated` (`delta`/`timeout`, `event_type`, `packet_number_space`, `timer_type`); `packet_lost.header`; `congestion_state_updated.new` | Same fields under the new names. parameters_set labels: `quic:parameters_set` → "transport parameters set", `quic:recovery_parameters_set` → "recovery parameters set". |
| PacketizationQUICPreProcessor.ts:213-300 | `data.raw.{length,payload_length,data}`, `header.packet_type`, 16-byte trailer | Same paths. See §11, ambiguity 3. |
| PacketizationQUICPreProcessor.ts:466-476 | `transport:parameters_set` `owner` + `max_packet_size` | `quic:parameters_set` `initiator` + **`max_udp_payload_size`** |
| PacketizationQUICPreProcessor.ts:541, 549-550 | `header.packet_number`; frame `stream_id`, `fin` | Same |
| PacketizationQUICPreProcessor.ts:640-690 | `frame.length` (STREAM/CRYPTO) | `frame.raw.length` (fallback chain, §11) |
| MultiplexingGraphD3CollapsedRenderer.ts:411-451 | stream frame `offset`, `length`, `stream_id`; `header.packet_number` | `offset ?? 0`, `raw.length`, `stream_id` |
| MultiplexingGraphD3CollapsedRenderer.ts:463-482 | `data_moved` with `stream_id`, `offset`, `length`, `from`, `to` | `quic:stream_data_moved` with `stream_id`, `offset`, **`raw.length`**, `from`, `to` |
| MultiplexingGraphD3WaterfallRenderer.ts:105-112, 330 | `packet_sent`/`packet_received`; `streamFrame.length` | `quic:*`; `raw.length` |
| MultiplexingGraphD3ByterangesRenderer.ts:92, 200-215 | derived `offset`/`length` | Derived from the above |
| StatisticsConnectionRenderer.vue:394-440 | `data.frames[].frame_type`, `data.header.packet_type` | Same |
| StatisticsConnectionRenderer.vue:462-534 | `transport:parameters_set` `owner` + `initial_max_*`; `max_data`/`max_stream_data` frames | `quic:parameters_set` `initiator` + same names |

---

## 14. Diff vs editor's copy

The editor's copy is `ref/qlog-wg/draft-ietf-quic-qlog-quic-events.md`
(`docname: draft-ietf-quic-qlog-quic-events-latest`). The list below covers
every difference that matters for parsing. The
`scratchpad/scripts/cddldiff.py` CDDL line diff found these, followed by a
manual check. The rest is editorial rewording.

| # | Area | -13 | Editor's copy | Parser impact |
|---|---|---|---|---|
| E1 | Event list | `quic:frames_processed` (§5.14.3), in Table 1, `QuicEventData`, and IANA | **Removed** from all three (ed:163-203, ed:211-248, ed:2501-2539). Prose mentions only frames_created/parsed (ed:1118-1119), and the example is "frames_parsed" (ed:1133). | Accept `frames_processed` and treat it as receive-side. |
| E2 | IP and port encoding | `IPAddress = text / hexstring` plus separate `port_*` | **`IPAddressPort = { ip: text / hexstring, port: uint16 } / text`** (ed:1797-1811). The whole pair can be one redacted string. | Support both. |
| E3 | `server_listening` | `ip_v4`, `port_v4`, `ip_v6`, `port_v6` | `address_v4: IPAddressPort`, `address_v6: IPAddressPort` (ed:267-276) | Normalize. |
| E4 | `TupleEndpointInfo` (connection_started local/remote, tuple_assigned, migration_state_updated) | `ip_v4`, `port_v4`, `ip_v6`, `port_v6`, `connection_ids` | `address_v4`, `address_v6`, `connection_ids` (ed:1824-1835). The prose adds that a stack may log only `connection_ids` (ed:300-303). | Normalize. quic-go already emits `address_v4`/`address_v6`. |
| E5 | `PreferredAddress` | `ip_v4`, `port_v4`, `ip_v6`, `port_v6` | `address_v4`, `address_v6` (ed:723-728) | Normalize. |
| E6 | Coalescing on packet events (sent, received, dropped, buffered) | `datagram_id: uint32` (locally unique id) | **`datagram_payload_checksum: uint32`**: a CRC32c of the UDP payload, per RFC 9868 §11.3 (ed:2473-2483) | Read both. The checksum allows cross-trace matching. |
| E7 | Coalescing on UDP events | `datagram_ids: [+ uint32]` | **`datagram_payload_checksums: [+ uint32]`** | Read both. |
| E8 | `packet_dropped.trigger` | `"key_unavailable"` | **`"keys_unavailable"`** (ed:873, 893) | Accept both. Display as-is. |
| E9 | `PacketHeader.length` | `? length: uint16` (PN + payload) | **Removed.** Only `raw.length`. | Ignore `header.length` for sizing. |
| E10 | `StatelessResetToken` | `hexstring .size 16` | `hexstring` ("always 16 bytes") (ed:1953-1957). Also dropped: the "always 128 bits" comments on packet_sent and packet_received. | Do not validate the length. |
| E11 | `*_data_blocked_updated` | No extension socket | `* $$quic-{connection,stream,datagram}datablockedupdated-extension` (ed:1292, 1323, 1340) | Tolerate extra fields. Harmless. |
| E12 | `recovery_parameters_set.reordering_threshold` | `uint16` | **`uint16 / "disabled"`** (ed:1542-1550) | The value may be a string. quic-go emits it. |
| E13 | `ecn_state_updated` | `old`, `new` | Adds **`? trigger: text`** (ed:1748-1754, 1769-1770) | Display it if present. |
| E14 | `GranularStreamStates` | `reset_received` listed under sending-side states | `reset_received` moved to "both-side states" (ed:1093-1095) | Same value set. No impact. |
| E15 | `GranularConnectionStates` "draining" | "CONNECTION_CLOSE received" | "CONNECTION_CLOSE or Stateless Reset received" (ed:472); stateless reset leads to the draining state (ed:323) | Semantic only. |
| E16 | `ResetStreamAtFrame` prose | Mentions `error_code_bytes` (inconsistent with its CDDL) | Fixed to `error`/`error_code` (ed:2118-2120) | Use the CDDL. |
| E17 | `ConnectionCloseFrame.trigger_frame_type` prose | Garbled ("string value is used in the error field") | Known types as frame-type strings ("stream"), unknown types as numbers, transport variant 0x1c only (ed:2336-2340) | Accept number or string. |
| E18 | `CryptoError` prose | "hex-encoded and zero-padded" | Lowercase hex. Example `crypto_error_0x128` (ed:2461-2465). | Match case-insensitively. |
| E19 | PathChallenge/PathResponse comment | "always 64 bits" | "always 8 bytes" | None |
| E20 | `PacketHeader` comment | "transport:connection_id_updated" | "connection_id_updated" | None, but confirms there is no `transport:` prefix. |
| E21 | `version_information` prose | Intended-use bullets | Rewritten. `server_versions` may include reserved (greased) versions from the VN packet (ed:589-592). | Don't treat greased versions as errors. |
| E22 | `alpn_information` prose | 4 bullets | The client usually logs twice. The server logs once with all three fields (ed:632-637). | None |
| E23 | `timer_updated` prose | `ack`/`pto`/`loss_timeout` explanation | Clarified mapping to RFC 9002 §6 and A.8 (ed:1415-1421) | None |
| E24 | `congestion_state_updated` prose | NewReno examples include "Application Limited" | NewReno has 3 states (slow start, recovery, congestion avoidance) (ed:1641-1645) | None (free text) |
| E25 | `packet_lost` | Inline comments | Comments removed; prose explains the triggers (ed:1686-1703) | Same fields |
| E26 | References | none | `RESET-STREAM-AT` normative ref (ed:70). Pardue's affiliation changed. | None |
| E27 | Change log | Same | **Still says "Split frames_processed into 3 events (#513)"** although the current text has 2 | Stale. Trust the body. |

**Recommendation.** Parse a union of -13 and the editor's copy:

- canonicalize addresses to an internal
  `{ v4?: {ip?, port?, redacted?}, v6?: {...}, connection_ids? }`;
- read `datagram_payload_checksum ?? datagram_id`;
- accept both `key_unavailable` and `keys_unavailable`;
- accept `reordering_threshold === "disabled"`;
- accept `frames_processed`.

---

## 15. Intermediate names in real implementations and alias table

### 15.1 Observed producers

Snapshots were taken 2026-11-01 from the GitHub master branches through raw
file fetches. Versions change, so treat these as examples rather than
guarantees.

**quic-go** (`qlog/event.go`, `qlog/frame.go`, `qlog/packet_header.go`,
`qlog/types.go`, `qlogwriter/trace.go`). It has **draft-13-era data structures
with old category prefixes**.

Header:

- `file_schema: "urn:ietf:params:qlog:file:sequential"`,
  `serialization_format: "application/qlog+json-seq"`;
- also the legacy `qlog_format: "JSON-SEQ"` and `qlog_version: "0.3"`;
- `title: "quic-go qlog"`;
- `reference_time` is an object (`clock_type: "monotonic"`, `epoch: "unknown"`,
  `wall_clock_time`);
- `event_schemas` is written only when a schema is registered.

Event names, as written:

- `transport:connection_started` (with `local`/`remote` using
  `address_v4`/`address_v6`)
- `transport:tuple_assigned`
- `transport:version_information`
- `transport:connection_closed` (`initiator`, `connection_error`,
  `application_error`, `error_code`, `reason`, `trigger`)
- `transport:packet_sent` and `transport:packet_received` (`header`, `raw`,
  `datagram_payload_checksum`, `frames`, `ecn`, `trigger`,
  `is_mtu_probe_packet`, `tuple`). Version Negotiation packets also use these
  names, with `supported_versions`.
- `transport:packet_buffered`
- `transport:packet_dropped` (old draft-02 trigger values)
- `quic:datagram_dropped` (`direction`, `raw`, `trigger`): **non-standard**
- `transport:priority_updated`: non-standard
- `recovery:mtu_updated` (`new`, `done`)
- `quic:recovery_parameters_set`: already canonical, with
  `reordering_threshold: "disabled"`
- `recovery:metrics_updated`, also used for a `pto_count`-only update
- `recovery:packet_lost`
- `recovery:spurious_loss`: non-standard
- `security:key_updated` and `security:key_discarded` (`key_phase`)
- `transport:parameters_set` and `transport:parameters_restored` (`initiator`,
  latest parameter names, `preferred_address.address_v4`)
- `recovery:loss_timer_updated` (`event_type`, `timer_type` with values
  `ack`/`pto`/`path_probe`, `packet_number_space`, `delta`)
- `recovery:congestion_state_updated`
- `recovery:ecn_state_updated` (`new`, `trigger`)
- `transport:alpn_information`
- `transport:debug` and `transport:<custom>`: non-standard

Frames:

- latest names, with `error`/`error_code` on connection_close only;
- **`length` at top level on stream, crypto, and datagram frames** instead of
  `raw.length`;
- reset_stream and stop_sending: `error_code` as an integer, **no `error`**;
- `reset_stream_at` when `reliable_size > 0`;
- ack ranges `[n]` or `[a,b]`;
- extension frames `ack_frequency` and `immediate_ack`;
- no padding frame encoder.

PacketHeader fields: `packet_type`, `packet_number`, `version`, `scid`, `dcid`,
`key_phase_bit`, `token` (`{"raw":{"data":hex}}`).

**quiche / tokio-quiche / neqo** (Cloudflare `qlog` crate,
`qlog/src/events/mod.rs` and `quic.rs`). It has **`quic:` names, partly
from -12**:

- `QUIC_URI = "urn:ietf:params:qlog:events:quic-12"`;
- all events are `quic:*`, with these deviations from -13:
  - `quic:datagrams_sent`, `quic:datagrams_received`, `quic:datagram_dropped`
    (not `udp_`);
  - `quic:key_retired` (not `key_discarded`);
  - `quic:frames_processed`;
- frames follow -13: `raw` on stream and crypto, `error`/`error_code`, AckRange
  `[n]` or `[a,b]`;
- `ConnectionIdUpdated` uses **`owner`**, not `initiator`;
- `UdpDatagramsSent.ecn` is a **single value**;
- PacketSent has the extra `send_at_time`;
- `datagram_id` and `datagram_ids` are used (not checksums);
- `server_listening` uses `ip_v4`/`port_v4`.

**Older producers** that pre-date latest drafts and are out of scope for parsing:

- mvfst: draft-00 `event_fields` arrays, `recovery`/`metric_update`, `cwnd`;
- pcap2qlog: `draft-01`/`draft-02-wip` (pcap2qlog source);
- older quic-go, aioquic, lsquic: `qlog_version` `draft-02`/`0.3`, names such as
  `transport:packet_sent` with draft-02 data.

A drop-in qvis replacement will be fed these files. The normalizer below covers
the `transport:`/`recovery:`/`security:`/`connectivity:` naming at no cost.
Whether to accept full draft-01/02 *data* layouts is a product decision; see
[§17](#17-open-questions).

### 15.2 Event-name alias table

Algorithm:

1. Split `name` on the first `:` into `prefix` and `type`.
2. If `prefix ∈ {transport, connectivity, security, recovery, quic}`, look up
   `(prefix, type)` in the table below.
3. Otherwise, if `prefix` is one of those namespaces, use `quic:<type>`.
4. Otherwise, leave the name untouched (http3, loglevel, simulation, unknown).
5. If the event uses separate `category` and `event`/`name` fields, build
   `category:name` first.

| Observed name(s) | Canonical (-13) | Data fix-ups |
|---|---|---|
| `recovery:metrics_updated`, `quic:metrics_updated`, `recovery:metric_update` | `quic:recovery_metrics_updated` | `cwnd` becomes `congestion_window` |
| `recovery:parameters_set` | `quic:recovery_parameters_set` | none |
| `transport:parameters_set`, `quic:parameters_set` | `quic:parameters_set` | `owner` becomes `initiator`; `max_packet_size` becomes `max_udp_payload_size`; `idle_timeout` becomes `max_idle_timeout`; `original_connection_id` becomes `original_destination_connection_id` |
| `transport:parameters_restored` | `quic:parameters_restored` | none |
| `recovery:loss_timer_updated`, `quic:loss_timer_updated` | `quic:timer_updated` | `timeout` becomes `delta` |
| `recovery:loss_timer_set` | `quic:timer_updated` | `event_type = "set"`; `timeout` becomes `delta` |
| `recovery:loss_timer_triggered`, `recovery:loss_timer_expired` | `quic:timer_updated` | `event_type = "expired"` |
| `transport:datagrams_sent`, `quic:datagrams_sent` | `quic:udp_datagrams_sent` | `byte_length` becomes `raw = [{length}]`; scalar `ecn` becomes `[ecn]` |
| `transport:datagrams_received`, `quic:datagrams_received` | `quic:udp_datagrams_received` | Same as above |
| `transport:datagram_dropped`, `quic:datagram_dropped` | `quic:udp_datagram_dropped` | `byte_length` becomes `raw.length`; keep quic-go `direction` and `trigger` as extras |
| `security:key_retired`, `quic:key_retired` | `quic:key_discarded` | `generation` becomes `key_phase` |
| `security:key_updated` | `quic:key_updated` | `generation` becomes `key_phase` |
| `security:key_discarded` | `quic:key_discarded` | `generation` becomes `key_phase` |
| `connectivity:path_assigned`, `quic:path_assigned`, `transport:path_assigned` | `quic:tuple_assigned` | `path_id` becomes `tuple_id`; `path_local` becomes `tuple_local`; `path_remote` becomes `tuple_remote` |
| `transport:data_moved`, `http:data_moved`, `http3:data_moved`, `quic:data_moved` | `quic:stream_data_moved` | `length` becomes `raw.length`; hex `raw` string becomes `raw.data` |
| `transport:frames_processed` | `quic:frames_processed` | `packet_number` (scalar, old) becomes `packet_numbers` (repeat it per frame) |
| `transport:connection_started`, `connectivity:connection_started` | `quic:connection_started` | Old flat `src_*`/`dst_*` become `local`/`remote` (§13.3) |
| `transport:connection_closed`, `connectivity:connection_closed` | `quic:connection_closed` | `owner` becomes `initiator`; `connection_code` becomes `connection_error`; `application_code` becomes `application_error`. A numeric `*_code` becomes `"unknown"` + `error_code`. |
| `connectivity:connection_id_updated`, `transport:connection_id_updated` | `quic:connection_id_updated` | `owner` becomes `initiator`; `src_*`/`dst_*` per §13.3 |
| `connectivity:spin_bit_updated` | `quic:spin_bit_updated` | none |
| `connectivity:connection_state_updated`, `transport:connection_state_updated` | `quic:connection_state_updated` | none |
| `connectivity:server_listening`, `transport:server_listening` | `quic:server_listening` | `stateless_reset_required` becomes `retry_required` |
| `connectivity:mtu_updated`, `recovery:mtu_updated`, `transport:mtu_updated` | `quic:mtu_updated` | none |
| `transport:version_information`, `transport:alpn_information` | `quic:version_information`, `quic:alpn_information` | A plain-string ALPN `x` becomes `{string_value: x}` |
| `transport:packet_sent`, `transport:packet_received`, `transport:packet_dropped`, `transport:packet_buffered`, `transport:packets_acked` | `quic:<same>` | Packet fix-ups (§15.3) |
| `transport:stream_state_updated` | `quic:stream_state_updated` | none |
| `transport:stream_data_moved`, `transport:datagram_data_moved`, `transport:migration_state_updated`, `connectivity:migration_state_updated` | `quic:<same>` | none |
| `recovery:congestion_state_updated`, `recovery:packet_lost`, `recovery:marked_for_retransmit`, `recovery:ecn_state_updated` | `quic:<same>` | none |
| `transport:udp_datagrams_sent`, `transport:udp_datagrams_received`, `transport:udp_datagram_dropped` | `quic:<same>` | none |
| `transport:timer_updated`, `recovery:timer_updated` | `quic:timer_updated` | none |
| `recovery:spurious_loss`, `transport:priority_updated`, `transport:debug`, other unknown `transport:*` or `recovery:*` | Rewrite the prefix to `quic:` but treat the event as **unknown** (generic rendering) | none |

**Store the original name next to the canonical one** so the UI can show "as
logged" in detail panes.

### 15.3 Field and value normalization table (applied after the name alias)

| Scope | If you see | Set |
|---|---|---|
| any packet event | `header.packet_size` | `raw.length` (delete from header) |
| any packet event | `header.payload_length` | `raw.payload_length` |
| any packet event | `data.packet_type` (top level) | `header.packet_type` |
| any packet event | `datagram_payload_checksum` | Keep. Also expose `coalescingKey`. |
| any packet event | `is_coalesced: true` (old) | Keep as a hint. No canonical field. |
| `packet_dropped` | `trigger: keys_unavailable` | Canonical -13 value is `key_unavailable` (either may be shown) |
| `packet_dropped` | old draft-02 trigger strings | §13.5 mapping (for grouping only). Show the original. |
| PacketHeader | `packet_type_value` | `packet_type_bytes` |
| PacketHeader | `version` with `0x` prefix | Strip for comparisons |
| stream, crypto, datagram frame | `length` (top level) and no `raw` | `raw = { length }` |
| stream frame | `raw` is a string (old hex) | `raw = { data: <string> }` |
| padding frame | `length` or `payload_length` (top level) | `raw.payload_length` |
| new_token frame | `token` is a string, plus `length` | `token = { raw: { data: token, length } }` |
| new_connection_id frame | `length` | `connection_id_length` |
| new_connection_id frame | `reset_token` | `stateless_reset_token` |
| unknown frame | `frame_type: "unknown_frame_type"` | `frame_type: "unknown"` |
| unknown frame | `raw_frame_type` or `frame_type_value` | `frame_type_bytes` |
| connection_close frame | `frame_type: "application_close"` | `frame_type: "connection_close"`, `error_space: "application"` |
| connection_close frame | `error_space: transport_error` or `application_error` | `transport` or `application` |
| connection_close frame | no `error`, and `error_code` is a non-numeric string | `error = error_code`, `error_code = raw_error_code ?? error_code_value ?? error_code_bytes` |
| reset_stream, stop_sending, reset_stream_at | no `error`, and `error_code` is a string | `error = error_code`, `error_code = error_code_value ?? error_code_bytes` |
| reset_stream, stop_sending, reset_stream_at | no `error`, and `error_code` is a number (quic-go) | `error = "unknown"`, keep `error_code` |
| ack frame | `acked_ranges` entries as strings | `toNum` each entry |
| ack frame | `ack_delay` as a string | `Number(...)` |
| `connection_closed` | `connection_code`, `application_code` | `connection_error`, `application_error` |
| `connection_closed` | `owner` | `initiator` |
| `connection_id_updated` | `owner` (quiche) | `initiator` |
| `key_*` | `generation` | `key_phase` |
| `tuple_assigned`, `migration_state_updated`, `connection_started` | `path_id`, `path_local`, `path_remote` | `tuple_id`, `tuple_local`, `tuple_remote` |
| TupleEndpointInfo, PreferredAddress, server_listening | `address_v4` / `address_v6` (an `{ip,port}` object or a string) | Internal `{v4:{ip,port}|{redacted}, v6:...}`. Also fill `ip_v4`/`port_v4` for -13 consumers. |
| TupleEndpointInfo, PreferredAddress, server_listening | `ip_v4` / `port_v4` | Internal form, as above |
| `udp_datagrams_*` | `ecn` is a scalar | `[ecn]` |
| `udp_datagrams_*` | `byte_length` | `raw: [{ length: byte_length }]` |
| `recovery_metrics_updated` | `cwnd` | `congestion_window` |
| `timer_updated` | `timeout` | `delta` |
| event top level | `path` | `tuple` (main schema; see the main-schema digest) |

### 15.4 Recommended normalization pipeline (TypeScript sketch)

```ts
type Raw = { name?: string; category?: string; event?: string; data?: any; [k: string]: any };

const LEGACY_PREFIXES = new Set(["transport", "connectivity", "security", "recovery", "quic"]);

// (oldPrefix or "*") + ":" + type  ->  canonical quic type
const QUIC_NAME_ALIASES: Record<string, string> = {
  "recovery:metrics_updated": "recovery_metrics_updated",
  "quic:metrics_updated": "recovery_metrics_updated",
  "recovery:metric_update": "recovery_metrics_updated",
  "recovery:parameters_set": "recovery_parameters_set",
  "*:loss_timer_updated": "timer_updated",
  "*:loss_timer_set": "timer_updated",
  "*:loss_timer_triggered": "timer_updated",
  "*:loss_timer_expired": "timer_updated",
  "*:datagrams_sent": "udp_datagrams_sent",
  "*:datagrams_received": "udp_datagrams_received",
  "*:datagram_dropped": "udp_datagram_dropped",
  "*:key_retired": "key_discarded",
  "*:path_assigned": "tuple_assigned",
  "*:data_moved": "stream_data_moved",
};

export function canonicalQuicName(evt: Raw): { ns: string; type: string; original: string } {
  let full = evt.name ?? "";
  if (evt.category && !full.includes(":")) full = `${evt.category}:${full || evt.event}`;
  const i = full.indexOf(":");
  const prefix = i >= 0 ? full.slice(0, i) : "";
  const type = i >= 0 ? full.slice(i + 1) : full;
  // http:data_moved / http3:data_moved also become quic:stream_data_moved
  if ((prefix === "http" || prefix === "http3") && type === "data_moved")
    return { ns: "quic", type: "stream_data_moved", original: full };
  if (!LEGACY_PREFIXES.has(prefix)) return { ns: prefix, type, original: full };
  const mapped = QUIC_NAME_ALIASES[`${prefix}:${type}`] ?? QUIC_NAME_ALIASES[`*:${type}`] ?? type;
  return { ns: "quic", type: mapped, original: full };
}
// Afterwards apply the §15.3 data fix-ups keyed on the canonical type
// (e.g. loss_timer_set -> data.event_type ??= "set").
```

The `recovery:parameters_set` versus `transport:parameters_set` split only works
because the table is keyed on **prefix plus type**. Do not apply the `*:` wildcard
to `parameters_set`.

---

## 16. Draft history quick reference

This history comes from the -13 change log (-13:3533-3816). Use it to tell which
alias belongs to which era.

| Since | Change that affects parsing |
|---|---|
| draft-marx-…-00 → -01 | Lowercase names. `packet_type` instead of `type`. Triggers moved into `data`. |
| draft-marx-…-01 → -02 (the "draft-02" qvis supports) | `packet_size` moved to `raw.length`. `packet_type` moved into `header`. `connection_closed`, `version_information`, `alpn_information`, `parameters_restored`, `packets_acked` added. `loss_timer_*` merged into `loss_timer_updated`. `data_moved` moved to transport. `datagram_ids` added. |
| quic-events-02 → -03 | `key_retired` renamed `key_discarded`. MTU events added. `packet_number` optional. `QuicFrame` became a type socket. |
| -03 → -04 | `UnknownFrame.raw_frame_type` renamed `frame_type_value`. `ConnectionCloseFrame.raw_error_code` renamed `error_code_value`. `packet_dropped` triggers changed. |
| -04 → -05 | **`transport` category renamed `quic`.** `connectivity`, `security`, and `recovery` stayed. GREASE bit and DATAGRAM support added. Migration events removed temporarily. |
| -05 → -06 | ECN events added. `key_updated.new` became optional. |
| -06 → -07 | `path_assigned` and `migration_state_updated` added. `generation` renamed `key_phase`. `retry_token` removed from packet_sent and packet_received. ALPN handling updated. `key_unavailable` trigger added. |
| -08 → -09 | **All events moved into the `quic` namespace.** `recovery:metrics_updated` became `quic:recovery_metrics_updated` and `recovery:parameters_set` became `quic:recovery_parameters_set`. `unknown_parameters` added. |
| -09 → -10 | `connection_started` uses PathEndpointInfo. `_bytes` fields introduced (`*_value` became `*_bytes`). |
| -11 → -12 | uint64 widening. **`error`/`error_code` rename (#473).** **All length fields became `raw.length` (#495).** **`loss_timer_updated` became `timer_updated` (#496).** **`path_assigned` became `tuple_assigned` (#491).** `stream_state_updated` reworked. **`owner` became `initiator` (#498).** PacketHeader flags split (#478). |
| -12 → -13 | **`frames_processed` split into `frames_created`, `frames_parsed`, and `frames_processed` (#513).** |

Some names do not appear in the change log, notably
`connection_code`/`application_code` (connection_closed, about -05 to -11) and
`datagrams_*` → `udp_datagrams_*` (about -06). These were inferred from
implementations (quiche's -12 crate still uses `datagrams_*`) and from the -13
schema. They are marked approximate.

---

## 17. Open questions

1. **Accepting legacy files.** Should qvis-react accept draft-01/02-era *data
   layouts*? Examples are the `src_*`/`dst_*` layout of connection_started and
   `ip_version`. A true drop-in replacement will be fed such files, including
   older quic-go output. The name aliasing in §15.2 is cheap. Full data
   conversion is extra scope.
2. **Packetization header and payload split.** Should the new UI keep qvis's
   current computation (`payload_length - 16`) for visual parity, or use the
   -13 semantics (`header = length - payload_length - 16`)? See §11,
   ambiguity 3.
3. **ACK matching key.** The congestion graph keys ACK matching by packet_type
   (CongestionGraphD3Renderer.ts:1132-1137, 1262). Should we keep it for 1:1
   parity, or switch to PN space, which correctly maps 0RTT packets acknowledged
   by 1RTT ACKs?
4. **Canonical internal shape for addresses.** The proposal is to normalize both
   to `{v4?:{ip?,port?,redacted?}, v6?:..., connection_ids?}`. This needs
   agreement with the main-schema and h3 digests.
5. **`frames_processed` in direction-dependent views.** -13 has it and the
   editor's copy drops it. Treat it as receive-side, or show it in both
   directions?
6. **Producer snapshot.** The quic-go and quiche details come from master
   branches on 2026-11-01. Re-verify against the versions users actually run if
   behavior depends on them.
