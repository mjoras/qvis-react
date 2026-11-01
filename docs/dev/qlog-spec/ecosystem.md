# qlog in the wild: what QUIC implementations emit (survey as of 2026-11-01)

Status: reference document for the qvis-react parser/normalizer. Downstream agents implementing
file loading, detection and normalization MUST read this together with the latest drafts:

- `draft-ietf-quic-qlog-main-schema-14` (6 July 2026)
- `draft-ietf-quic-qlog-quic-events-13`
- `draft-ietf-quic-qlog-h3-events-13`
- editor's copies in `scratchpad/ref/qlog-wg/*.md` (git HEAD 2026-11-01, `add a trigger to ecn_state_updated (#638)`)

Method: every claim below was checked against the implementation's default branch on GitHub on
2026-11-01 using `gh api repos/<owner>/<repo>/contents/<path>` (plus commit/tag history and issues).
Paths are repo-relative at default-branch HEAD. Line numbers are from that snapshot and will drift;
the quoted code is the evidence. qvis references are `src/...:line` relative to
`scratchpad/ref/qvis/visualizations/`.

---

## 0. TL;DR

1. Only three code bases currently emit the latest envelope (`file_schema` +
   `serialization_format`): quic-go (>= v0.56.0), cloudflare/quiche's `qlog` crate (>= quiche
   0.27.0, 2026-03-31) and its users (neqo/Firefox, quinn, tokio-quiche), and mvfst (since
   2025-11-25). Everyone else still writes `qlog_version` "0.3", "0.4", "draft-02" or "draft-00",
   or no qlog at all.
2. Even the "latest" emitters are not clean:
   - quic-go still names events `transport:*`, `recovery:*` and `security:*`. Its maintainer
     says this is because qvis does not understand `quic:*` (quic-go issue #5348).
   - quic-go also appends `"qlog_version":"0.3","qlog_format":"JSON-SEQ"` to the latest header,
     again for qvis.
   - quiche writes `"serialization_format":"JSON-SEQ"`, which is not a media type. It also writes
     the `quic:datagrams_sent`/`quic:datagrams_received`/`quic:key_retired` names and the
     removed `protocol_types` field.
   - mvfst writes unversioned event-schema URNs and a private `urn:ietf:params:qlog:events:mvfst`
     namespace. It also emits several non-standard `quic:*` names (`quic:packet_ack`,
     `quic:loss_timer_updated`, `quic:datagram_received`, and others), and its `stream_id`s are
     JSON strings.
   - quinn writes `"event_schemas":[]`, omits `common_fields` and `reference_time`, uses vantage
     point `unknown`, and may put several connections in one file, separated only by per-event
     `group_id`.
3. Every draft-versioned event-schema URI seen in the wild carries a `-NN` suffix, for example
   `urn:ietf:params:qlog:events:quic-12`, as the drafts require until RFC publication. The parser
   MUST match on the namespace and ignore the suffix.
4. The real-world corpus that a latest-draft-only viewer must handle well:
   - `.sqlog` JSON-SEQ (RS-prefixed records): quic-go, quiche, neqo, quinn, Go x/net, ngtcp2,
     OpenSSL
   - `.qlog` contained JSON: mvfst, aioquic, picoquic, kwik
   - compressed variants: `.sqlog.gz`, `.sqlog.zst` (quiche), `.qlog.gz` (mvfst)
   - truncated or unterminated files from streaming writers
5. Recommendation, detailed in section 6:
   - Accept every file that has `file_schema`, even if it also has `qlog_version`.
   - Normalize event-name prefixes (`transport|connectivity|recovery|security` to `quic`,
     `h3|http` to `http3`, `generic` to `loglevel` or `simulation`) and roughly 25 renamed
     events and fields cheaply at load time.
   - Reject files that have `qlog_version` but no `file_schema`, and files using `event_fields`,
     with a precise message that names the producer and points to legacy qvis.
   - Chromium NetLog stays a separate converter path (parity), and its output MUST be
     latest-draft qlog.

---

## 1. Target format recap (what "latest" means for detection)

Normative identifiers from main-schema-14:

| Item | Latest value(s) | Source |
|---|---|---|
| `file_schema` (contained JSON) | `urn:ietf:params:qlog:file:contained` | main-14 §4 |
| `file_schema` (streaming) | `urn:ietf:params:qlog:file:sequential` | main-14 §5 |
| `serialization_format` | media type, case-insensitive: `application/qlog+json`, `application/qlog+json-seq` | main-14 §3, §11.1, §11.2 |
| Extensions | `.qlog` (JSON), `.sqlog` (JSON-SEQ) | main-14 §11.1, §11.2 |
| JSON-SEQ framing | RFC 7464: each record = `0x1E` + JSON text + `0x0A` | main-14 §11.2 |
| Trace (contained) | `{title?, description?, common_fields?, vantage_point?, event_schemas:[+text], events:[*Event]}` | main-14 §4.2 |
| TraceSeq (sequential) | same minus `events`; events follow as separate records | main-14 §5.1 |
| TraceError | `{error_description, uri?, vantage_point?}` inside `traces` | main-14 §4.3 |
| Event | `{time: float64, name: text, data, tuple?, time_format?, group_id?, system_info?, *custom}` | main-14 §7 |
| Event name | `<namespace>:<event_type>`, e.g. `quic:packet_sent`, `http3:frame_created`, `http:capsule_parsed`, `loglevel:debug`, `simulation:marker` | main-14 §8, quic-13 Table 1, h3-13 Tables 1-2 |
| `reference_time` | object `{clock_type: "system"/"monotonic"/text, epoch: RFC3339/"unknown", wall_clock_time?}` | main-14 §7.1 Fig. 16 |
| `time_format` | `relative_to_epoch` (default) / `relative_to_previous_event` | main-14 §7.1 Fig. 17 |
| `tuple` (was `path` before main-13) | TupleID text, default `""` | main-14 §7.2 |
| `event_schemas` | `urn:ietf:params:qlog:events:<ns>`; drafts MUST append `-<draftnum>`, e.g. `...:quic-12` | quic-13 §2.1, h3-13 §2.1 |
| uint64 in JSON | number OR string; parsers SHOULD accept both | main-14 §11.3 |
| ACK ranges | `[a,b]` or `[a]`; tools MUST handle both | quic-13 AckFrame |

Namespace history (from the drafts' change logs), which tells us which legacy prefixes are
unambiguous to alias:

- quic-events-05: category `transport` renamed to `quic` (#302).
- quic-events-09 / main-10: categories removed entirely (#439). All QUIC events became `quic:*`:
  - `recovery:metrics_updated` became `quic:recovery_metrics_updated`.
  - `recovery:parameters_set` became `quic:recovery_parameters_set`.
  - `connectivity:*`, `security:*` and `recovery:*` all moved into `quic:`.
- quic-events-12:
  - `loss_timer_updated` became `timer_updated` (#496).
  - `path_assigned` became `tuple_assigned` (#491).
  - `owner` became `initiator` (#498).
  - all `length` fields became `raw.length` (#495).
  - error fields were renamed (#473).
  - PacketHeader flags were split (#478).
- quic-events-13: `frames_processed` was split into `frames_created`, `frames_parsed` and
  `frames_processed` (#513).
- h3-events:
  - h3-05: `http` renamed to `h3` (#300).
  - h3-06: qpack events removed (#335).
  - h3-09: categories removed, namespace became `http3` (#439).
  - h3-13: a new, separate `http` namespace was added that holds only `capsule_created` and
    `capsule_parsed` (#504).
- main-schema:
  - main-06: `qlog_version` went to "0.4" and `summary` and `configuration` were removed.
  - main-10: timestamps were reworked (#433). `qlog_version`/`qlog_format` became
    `file_schema`/`serialization_format`.
  - main-11: `protocol_types` was removed in favor of `event_schemas` (#449).
  - main-13: Path became Tuple (#491).

---

## 2. Summary matrix

Legend for the last column:

- **A**: native latest; accept as-is.
- **A+N**: latest envelope; accept with normalization (aliases and shims, see section 6).
- **R**: legacy envelope; reject with a clear message (section 6.7).
- **C**: separate converter path (parity feature).
- **–**: emits no qlog.

| Implementation (version surveyed) | Envelope written | serialization | `event_schemas` | Event name style | `time` | `reference_time` / `time_format` | group / tuple | Ext / default filename | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **quic-go** (master, v0.64.1 2026-10-19; envelope since v0.56.0) | `file_schema: ...:file:sequential` **plus** legacy `qlog_format:"JSON-SEQ"`, `qlog_version:"0.3"` at end of header | `application/qlog+json-seq` | `quic-12`, `http3-12` (only schemas registered by linked packages) | Mixed: `transport:*`, `recovery:*`, `security:*`, a few `quic:*`; `http3:*` | float ms, ns precision, since trace start | `{clock_type:"monotonic", epoch:"unknown", wall_clock_time: RFC3339Nano}`; no time_format | `common_fields.group_id` = ODCID hex; `tuple` written **inside `data`** | `.sqlog`, `<odcid>_<client\|server>.sqlog` | A+N |
| **cloudflare/quiche** `qlog` crate 0.18.2 (quiche >= 0.27.0) | `file_schema` sequential (streamer) or contained (`Qlog` struct) | `"JSON-SEQ"` (not a media type) | `quic-12`, `http3-12`, `loglevel-13` | `quic:*`, `http3:*`, `loglevel:*`; but `quic:datagrams_sent/received`, `quic:key_retired` | float ms, ms/µs/ns precision (quiche lib uses µs) | monotonic + `wall_clock_time`; `time_format` optional | `common_fields.group_id/tuple` (optional); event-level `group_id` supported | `.sqlog`, `.sqlog.gz`, `.sqlog.zst`; apps: `<role>-<id>.sqlog` | A+N |
| **mozilla/neqo** 0.34.0 (qlog 0.18.1) / Firefox | as quiche | `"JSON-SEQ"` | `quic-12` | as quiche (`quic:*`) | float ms, µs precision | monotonic; `time_format:"relative_to_epoch"`; also `protocol_types:["QUIC"]` | none | `.sqlog` in `$TMPDIR/qlog_$PID` (Firefox pref `network.http.http3.enable_qlog`) | A+N |
| **quinn** quinn-proto 0.12.0 (`qlog` feature, qlog 0.18) | as quiche | `"JSON-SEQ"` | **`[]` (empty)** | `quic:*` | float ms, ns precision | **no `common_fields`** (no reference_time) | **per-event `group_id`** (orig. remote CID); one stream may hold many connections; vantage `unknown` | app-chosen writer | A+N |
| **mvfst** (main 2026-10-29; envelope since 2025-11-25) | `file_schema: ...:file:contained` | `application/qlog+json` | `urn:ietf:params:qlog:events:quic` (**unversioned**), `...:http3`, **`...:mvfst`** | `quic:*` (several non-standard names) + `mvfst:*` | float ms = steady_clock µs / 1000 (**large, since boot**) | `{clock_type:"monotonic", epoch:"unknown"}`, `time_format:"relative_to_epoch"` | `common_fields.odcid` / `scid` (custom keys, not `group_id`) | `.qlog` / `.qlog.gz`, `<dcid>.qlog`; streaming mode can leave JSON unterminated | A+N |
| **picoquic** (master 2026-11-01) | `qlog_version:"draft-00"`, `event_fields` arrays | JSON (implicit) | n/a | `[t, "transport", "packet_sent", {...}]` rows | integer **µs** (`configuration.time_units:"us"`) | `common_fields.reference_time` = **string** µs | `path_id` column optional | `.qlog`, `<cid>.<client\|server>.qlog` | R |
| **ngtcp2** v1.25.0 (+ curl, nghttp2, Node.js) | `qlog_format:"JSON-SEQ"`, `qlog_version:"0.3"` | JSON-SEQ (RS) | n/a | `transport:*`, `recovery:*` | **integer ms** | `reference_time:0`, `time_format:"relative"`, `protocol_type:["QUIC"]` | `common_fields.group_id` = ODCID | `.sqlog` (examples: `<scid>.sqlog`) | R |
| **aioquic** (main 2026-11-01) | `qlog_format:"JSON"`, `qlog_version:"0.3"` | JSON | n/a | `transport:*`, `recovery:*`, `security:*`, `connectivity:*`, `http:*` | float ms **since Unix epoch** (absolute) | none (`common_fields:{ODCID}` only) | `ODCID` | `.qlog`, `<ODCID>.qlog` | R |
| **lsquic** (master 2026-11-01) | not a file: pre-draft rows printed into the text debug log (`qlog` log module) | text | n/a | `[t,"TRANSPORT","PACKET_RX","LINE",{...}]` | µs | n/a | n/a | n/a (docs: "At the moment, it is out of date") | R (not qlog) |
| **msquic** | no native qlog (ETW/LTTng). `src/tools/etw` (`--conn_qlog`) can write `conn.qlog` with `qlog_version:"draft-00"`, `time_units:"ms"`, `event_fields` (`CATEGORY`, `EVENT_TYPE`) | JSON | n/a | uppercase | ms | – | `group_id` = CorrelationId | `conn.qlog` | – / R |
| **s2n-quic** | no qlog output (event subscriber API modeled on draft-marx-...-02; issue #1199 open since 2022) | – | – | – | – | – | – | – | – |
| **Chromium / Chrome** | no qlog. NetLog JSON (`chrome://net-export`), `constants.logEventTypes`, ~147 `QUIC_*` event types | JSON | – | `QUIC_SESSION_PACKET_SENT`, ... | ms ticks | `constants.timeTickOffset` | source IDs | `.json` / `.netlog` | C |
| Go `golang.org/x/net/quic` | `qlog_version:"0.3"`, `qlog_format:"JSON-SEQ"` (comment: "qvis only supports up to 0.3") | JSON-SEQ | n/a | `connectivity:*`, `transport:*`, `recovery:*` | duration ms | `time_format:"relative"`, `reference_time` | `group_id` | `<group_id>_<vantage>.sqlog` | R |
| OpenSSL QUIC (3.5+) | `qlog_version:"0.3"`, `qlog_format:"JSON-SEQ"` | JSON-SEQ | n/a | `connectivity:*`, `transport:*`, `recovery:*` | **integer ms, `time_format:"delta"`** (first event absolute epoch ms) | none | `group_id`, `system_info` | `<odcid>_<role>.sqlog` | R |
| Tencent tquic | `qlog_version:"0.4"`, `qlog_format:"JSON-SEQ"` | JSON-SEQ | n/a | `connectivity:*`, `quic:*`, `recovery:*`, `security:*`, `h3:*`, `qpack:*`, `generic:*` | float ms | – | – | **`.qlog` containing JSON-SEQ**, `<trace_id>.qlog` | R |
| Alibaba xquic | text log, converted by `scripts/qlog_parser.py` to `qlog_version:"0.4"`, `qlog_format:"JSON"` | JSON | n/a | `connectivity:`, `quic:`, `security:`, `recovery:`, `h3:` | absolute | `time_format:"absolute"` | `ODCID` | script output | R |
| kwik (Java) | `qlog_version:"draft-02"`, `qlog_format:"JSON"` | JSON | n/a | `transport:*`, `recovery:*` | integer ms | `time_format:"relative"`, `reference_time` epoch ms number | `ODCID` | `<cid>.qlog` | R |
| Haskell `quic` | `qlog_format:"NDJSON"`, `qlog_version:"draft-02"` | NDJSON | n/a | `transport:*`, `recovery:*`, `connectivity:*`, bare `debug` | – | – | – | – | R |

Practical consequence: once rejected legacy files are excluded, a strict latest-only viewer accepts
output from quic-go >= 0.56, quiche >= 0.27, current neqo/Firefox, quinn and mvfst. It refuses
ngtcp2 (and therefore curl, nghttp2 and Node.js), aioquic, picoquic, OpenSSL, Go x/net/quic,
tquic, kwik, Haskell quic, xquic, older quic-go, and older quiche/Firefox. Open question Q1 covers
this policy.

---

## 3. Per-implementation details and evidence

### 3.1 quic-go (`github.com/quic-go/quic-go`, packages `qlogwriter/` and `qlog/`)

- Versions:
  - Default branch pushed 2026-11-01; latest release v0.64.1 (2026-10-19).
  - The new header landed in `qlogwriter: implement the draft-12 trace header (#5360)` on
    2025-10-08 and ships in v0.56.0 and later.
  - v0.55.0 and earlier wrote `qlog_format:"JSON-SEQ", qlog_version:"0.3"` only, at
    `qlog/trace.go:46-47` on v0.54.0. Many deployed binaries, such as Caddy builds from 2025,
    still produce those files.
- Header: `qlogwriter/trace.go:58-123` (`traceHeader.Encode`).

  ```go
  h.WriteToken(jsontext.String("file_schema"))
  h.WriteToken(jsontext.String("urn:ietf:params:qlog:file:sequential"))
  h.WriteToken(jsontext.String("serialization_format"))
  h.WriteToken(jsontext.String("application/qlog+json-seq"))
  h.WriteToken(jsontext.String("title"))
  h.WriteToken(jsontext.String("quic-go qlog"))
  h.WriteToken(jsontext.String("code_version"))      // custom top-level field
  ...
  // ---- reference_time
  h.WriteToken(jsontext.String("clock_type")); h.WriteToken(jsontext.String("monotonic"))
  h.WriteToken(jsontext.String("epoch"));      h.WriteToken(jsontext.String("unknown"))
  h.WriteToken(jsontext.String("wall_clock_time"))
  h.WriteToken(jsontext.String(l.ReferenceTime.Format(time.RFC3339Nano)))
  ...
  // The following fields are not required by the qlog draft anymore,
  // but qvis still requires them to be present.
  h.WriteToken(jsontext.String("qlog_format"));  h.WriteToken(jsontext.String("JSON-SEQ"))
  h.WriteToken(jsontext.String("qlog_version")); h.WriteToken(jsontext.String("0.3"))
  ```

  Consequence: detection MUST give `file_schema` precedence over `qlog_version` (section 6.2).
- `vantage_point`: `{type: "client"|"server"}` for connection traces. `NewFileSeq` (endpoint-level,
  non-connection traces) uses the **non-standard type `"transport"`**
  (`qlogwriter/writer.go`, `newFileSeq(w, "transport", ...)`). No `name`.
- `common_fields`:
  - `group_id` is the ODCID in hex, present only if valid.
  - `reference_time` is as above.
  - There is no `time_format`, so the default `relative_to_epoch` applies.
- `event_schemas`: whatever packages registered.
  - `qlog/qlog_dir.go:16`: `const EventSchema = "urn:ietf:params:qlog:events:quic-12"`
  - `http3/qlog/event.go:12`: `"urn:ietf:params:qlog:events:http3-12"`
- Event records (`qlogwriter/writer.go:166-185`): RS, then `{"time":<ms float>,"name":...,"data":{...}}`.
  The time is `float64(e.Time.Sub(t.referenceTime).Nanoseconds()) / 1e6`. Nothing else is written
  at event level: no `group_id`, `tuple` or `time_format`.
- Event names (all `Name()` methods in `qlog/event.go`):
  - `transport:`: `connection_started`, `tuple_assigned`, `version_information`,
    `connection_closed`, `packet_sent`, `packet_received` (VN packets too), `packet_buffered`,
    `packet_dropped`, `priority_updated`, `parameters_set`, `parameters_restored`,
    `alpn_information`, `debug`, and `transport:<anything>` for `DebugEvent`.
  - `recovery:`: `mtu_updated`, `metrics_updated` (also emitted for a lone `pto_count`),
    `packet_lost`, `spurious_loss` (non-standard), `loss_timer_updated`,
    `congestion_state_updated`, `ecn_state_updated`.
  - `security:`: `key_updated`, `key_discarded`.
  - `quic:`: `datagram_dropped` (latest name is `udp_datagram_dropped`), `recovery_parameters_set`.
  - `http3:`: `frame_parsed`, `frame_created`, `datagram_created`, `datagram_parsed`.
  - Upstream tracking issue #5348 "qlog: rename `transport` events" (open). Maintainer comment:
    "Not supported by qvis yet". The prefixes are kept deliberately for qvis.
- Data-level deviations from quic-13:
  - `tuple` is written **inside `data`** for `packet_sent`/`packet_received`
    (`qlog/event.go:283,334`), not at event level as main-14 §7.2 defines.
  - STREAM, CRYPTO and DATAGRAM frames log a top-level **`length`**, not `raw.length` or
    `raw.payload_length` (`qlog/frame.go:247,275,520`):
    ```go
    h.WriteToken(jsontext.String("stream_id")); ...
    h.WriteToken(jsontext.String("offset")); ...
    h.WriteToken(jsontext.String("length"))
    ```
  - `reset_stream`/`reset_stream_at` log a numeric `error_code` without `error`
    (`qlog/frame.go:213-216`).
  - CONNECTION_CLOSE uses the current schema (`error_space`, `error`, `error_code` when unknown,
    `reason`/`reason_bytes`, `trigger_frame_type`) since #6073, 2026-11-01.
  - `connection_closed` uses `initiator`, `connection_error`, `application_error`, `error_code`,
    `reason`, `trigger` (current).
  - `RawInfo` at packet level is `{length, payload_length}` (current).
  - HTTP/3 frames carry `raw` inside the `frame` object (current).
  - Header: `packet_type`, `packet_number`, `version` (hex string), `scid`, `dcid`,
    `key_phase_bit`, `token:{raw:{data}}` (current).
  - Version lists are hex strings without `0x`.
- Ordering: issue #5955 "qlog: events can be written out of order" (closed 2026-10-22). Older
  files may be slightly unordered, so sort them (section 5.9).

### 3.2 cloudflare/quiche — `qlog` crate (also used by neqo, quinn, tokio-quiche)

- Crate `qlog` 0.18.2 (`qlog/Cargo.toml`).
  - The envelope switch shows in tag `0.27.0` (2026-03-31). `qlog/src/lib.rs` at tags 0.20.0
    through 0.26.0 still has `QLOG_VERSION: &str = "0.3"` and event names `transport:*`,
    `connectivity:*`, `recovery:*`, `security:*`, `http:*`, `qpack:*`, `generic:*`.
  - The pre-2026 names include `transport:data_moved`, `transport:datagrams_sent`,
    `security:key_retired`, `recovery:loss_timer_updated`, `generic:message` and `generic:marker`.
- Constants (`qlog/src/lib.rs:439-453`, `qlog/src/events/mod.rs:39-42`):
  ```rust
  pub const QLOGFILE_URI: &str = "urn:ietf:params:qlog:file:contained";
  pub const QLOGFILESEQ_URI: &str = "urn:ietf:params:qlog:file:sequential";
  pub const SQLOG_EXT: &str = ".sqlog";
  pub const SQLOG_GZ_EXT: &str = ".sqlog.gz";
  pub const SQLOG_ZST_EXT: &str = ".sqlog.zst";
  pub const LOGLEVEL_URI: &str = "urn:ietf:params:qlog:events:loglevel-13";
  pub const QUIC_URI: &str = "urn:ietf:params:qlog:events:quic-12";
  pub const HTTP3_URI: &str = "urn:ietf:params:qlog:events:http3-12";
  ```
- Streamer header (`qlog/src/streamer.rs:118-124`): **`serialization_format: "JSON-SEQ"`**, which
  is not the media type `application/qlog+json-seq`. Records are written as
  `write_all(b"\x1e")`, JSON, then `"\n"`.
  - `add_event_now_pretty` / `add_event_with_instant_pretty` write **pretty-printed multi-line
    records**. Never split JSON-SEQ on newlines.
- Event time (`qlog/src/streamer.rs:33-70`): milliseconds since the streamer `start_time`, with
  selectable precision.
  - `MilliSeconds` gives values like `1.0`.
  - `MicroSeconds` gives 3 decimals.
  - `NanoSeconds` gives 6 decimals.
  - quiche itself uses `MicroSeconds` (`quiche/src/lib.rs`, `set_qlog_with_level`).
- `CommonFields` struct (`qlog/src/lib.rs:617-625`): `tuple`, `group_id`, **`protocol_types`**
  (removed from the spec in main-11), `reference_time` (non-optional in the struct, so a defaulted
  struct serializes `{"clock_type":"","epoch":""}`), and `time_format`.
- `ReferenceTime::new_monotonic` gives `{clock_type:"monotonic", epoch:"unknown", wall_clock_time?}`.
- `VantagePoint.flow` is typed as `VantagePointType`, which also allows `"network"` as a value.
- Event struct (`qlog/src/events/mod.rs:58-90`): `time`, flattened `name`+`data`, flattened
  `ex_data` (arbitrary extra top-level keys), `group_id`, `time_format`. No `tuple` at event level.
- Event names (`qlog/src/events/mod.rs:435-605`, serde renames):
  - `quic:` + `server_listening`, `connection_started`, `connection_closed`,
    `connection_id_updated`, `spin_bit_updated`, `connection_state_updated`, `tuple_assigned`,
    `mtu_updated`, `version_information`, `alpn_information`, `parameters_set`,
    `parameters_restored`, `packet_sent`, `packet_received`, `packet_dropped`, `packet_buffered`,
    `packets_acked`, `stream_state_updated`, `frames_processed`, `stream_data_moved`,
    `datagram_data_moved`, `connection_data_blocked_updated`, `stream_data_blocked_updated`,
    `datagram_data_blocked_updated`, `migration_state_updated`, `key_updated`,
    `recovery_parameters_set`, `recovery_metrics_updated`, `congestion_state_updated`,
    `timer_updated`, `packet_lost`, `marked_for_retransmit`, `ecn_state_updated`.
  - **Deviations:**
    ```rust
    #[serde(rename = "quic:datagrams_sent")]      QuicUdpDatagramsSent(...)     // latest: quic:udp_datagrams_sent
    #[serde(rename = "quic:datagrams_received")]  QuicUdpDatagramsReceived(...) // latest: quic:udp_datagrams_received
    #[serde(rename = "quic:datagram_dropped")]    QuicUdpDatagramDropped(...)   // latest: quic:udp_datagram_dropped
    #[serde(rename = "quic:key_retired")]         QuicKeyDiscarded(...)         // latest: quic:key_discarded
    ```
  - No `frames_created`/`frames_parsed` (quic-13 split).
  - `http3:` + `parameters_set`, `parameters_restored`, `stream_type_set`, `priority_updated`,
    `frame_created`, `frame_parsed`, `datagram_created`, `datagram_parsed`, `push_resolved`.
  - `loglevel:` + `error`, `warning`, `info`, `debug`, `verbose`.
- Data deviations:
  - `ConnectionIdUpdated` still uses **`owner`** (latest: `initiator`, `qlog/src/events/quic.rs:405`).
  - `PacketHeader` has a legacy **`length: Option<u16>`** plus `scil`/`dcil`
    (`qlog/src/events/quic.rs:128-147`).
  - STREAM and CRYPTO frames put the data length in **`raw.payload_length`**, with `raw.length`
    absent (`quiche/src/frame.rs:935-960`):
    ```rust
    Frame::Stream { stream_id, data } => QuicFrame::Stream { stream_id: *stream_id,
        offset: Some(data.off()), fin: data.fin().then_some(true),
        raw: Some(Box::new(RawInfo { length: None, payload_length: Some(data.len() as u64), data: None })) },
    ```
  - PADDING also uses `raw.payload_length`.
- quiche library setup (`quiche/src/lib.rs`, `set_qlog_with_level`):
  - TraceSeq has the app-supplied title and description, and `vantage_point {type: client|server}`
    with no name.
  - `event_schemas` is `[QUIC_URI, HTTP3_URI]`.
  - Common fields are monotonic with `wall_clock_time`.
- Filenames: quiche apps use `format!("{role}-{id}.sqlog")` (`apps/src/common.rs:153`). The
  `qlog::writer` module supports `.sqlog`, `.sqlog.gz` and `.sqlog.zst`, and `qlog::reader`
  dispatches on these compound suffixes.

### 3.3 mozilla/neqo (Firefox's HTTP/3 stack)

- neqo 0.34.0 depends on `qlog = { version = "0.18.1" }` (`Cargo.toml:40`), so the envelope and
  names are quiche's. Exact header bytes (`test-fixture/src/lib.rs:641-645`):
  ```text
  \u{1e}{"file_schema":"urn:ietf:params:qlog:file:sequential","serialization_format":"JSON-SEQ",
  "trace":{"title":"neqo-Client trace","description":"neqo-Client trace","common_fields":
  {"protocol_types":["QUIC"],"reference_time":{"clock_type":"monotonic","epoch":"unknown"},
  "time_format":"relative_to_epoch"},"vantage_point":{"name":"neqo-Client","type":"client"},
  "event_schemas":["urn:ietf:params:qlog:events:quic-12"]}}\n
  ```
  In real files `wall_clock_time` is also present, from `ReferenceTime::new_monotonic(Some(SystemTime::now()))`.
- Event example (`neqo-common/src/qlog.rs` tests):
  `\u{1e}{"time":0.0,"name":"quic:spin_bit_updated","data":{"state":true}}\n`.
- Uses `EventTimePrecision::MicroSeconds`. The file is `<prefix>.sqlog`.
- Events used (`neqo-transport/src/qlog.rs`): `quic:connection_started`, `connection_closed`,
  `connection_state_updated`, `version_information`, `parameters_set`,
  `recovery_parameters_set`, `packet_sent`, `packet_received`, `packet_dropped`, `packets_acked`,
  `packet_lost`, `recovery_metrics_updated`, `congestion_state_updated`, `timer_updated`,
  `mtu_updated`. **No HTTP/3 events.**
- `event_schemas` only lists `quic-12`.
- Firefox: about:config `network.http.http3.enable_qlog=true` writes files to
  `$TMPDIR/qlog_$PID/`. The Firefox docs (`netwerk/docs/http/logging.md:357-362`) tell users to
  open them at qvis.quictools.info, which cannot parse them today because there is no
  `qlog_version` and the file is JSON-SEQ. This is a key user story for this project.
- Firefox builds whose neqo predates the qlog 0.17/0.18 upgrade emit qlog 0.3 (`transport:*`).

### 3.4 quinn (`quinn-rs/quinn`)

- `quinn-proto` 0.12.0 has an optional `qlog` feature using `qlog = "0.18"`.
- Setup (`quinn-proto/src/config/transport.rs:604-628`):
  ```rust
  let trace = qlog::TraceSeq::new(self.title.clone(), self.description.clone(),
      None,                                                      // no common_fields => no reference_time
      Some(qlog::VantagePoint { name: None, ty: qlog::VantagePointType::Unknown, flow: None }),
      vec![],                                                    // EMPTY event_schemas (spec: [+text])
  );
  ... qlog::streamer::EventTimePrecision::NanoSeconds,
  ```
- Per-event grouping (`quinn-proto/src/connection/qlog.rs:33-41`):
  `event.group_id = Some(Box::new(orig_rem_cid.to_string()));`. A `QlogStream` is cloneable and
  can be shared by several connections, so one file can interleave connections and the viewer
  must split by `group_id`.
- Events: `quic:recovery_metrics_updated`, `quic:packet_lost`, `quic:packet_sent`,
  `quic:packet_received`.

### 3.5 mvfst (facebook/mvfst)

- The qlog migration landed in "Migrate mvfst qlog to IETF qlog main schema v0.4", 2025-11-25.
  It was followed by "Remove 'time_units' field, default to ms" and "Stop using protocol_type in
  favor of event_schemas" (both 2026-07-14).
- Constants (`quic/logging/QLoggerConstants.h:70-86`):
  ```cpp
  constexpr auto kQLogVersion = "0.4";                       // constant still present, no longer written
  constexpr auto kQLogFileSchemaURI = "urn:ietf:params:qlog:file:contained";
  constexpr auto kQLogSerializationFormat = "application/qlog+json";
  constexpr auto kQLogEventSchemaURI = "urn:ietf:params:qlog:events:quic";       // unversioned
  constexpr auto kQLogHTTP3EventSchemaURI = "urn:ietf:params:qlog:events:http3"; // unversioned
  constexpr auto kQLogMvfstEventSchemaURI = "urn:ietf:params:qlog:events:mvfst"; // private ns in IETF URN space
  constexpr auto kQLogTitle = "mvfst qlog"; ...
  ```
- File (`quic/logging/FileQLogger.cpp:491-532`): `traces[0]` has these `common_fields`:
  - `odcid` (custom, lower-case)
  - `scid` (custom)
  - `reference_time:{clock_type:"monotonic", epoch:"unknown"}`
  - `time_format:"relative_to_epoch"`

  There is **no `group_id`**.
- **Key order is not guaranteed.** The output comes from `folly::dynamic` objects, which are hash
  maps, so `file_schema` is not necessarily within the first 256 bytes. It may even follow
  `traces`. Never classify by prefix-sniffing alone.
- Times (`quic/logging/QLoggerTypes.cpp:403` and others): `event["time"] = refTime.count() / 1000.0;`
  where `refTime = steady_clock::now().time_since_epoch()` in µs (`BaseQLogger.cpp:97`).
  Values are therefore **milliseconds since an arbitrary monotonic origin, typically boot**, for
  example `123456789.123`. The first event is not 0.
- Output files (`FileQLogger.cpp:42-55`, `FileQLogger.h:27-28`): `<dcid>.qlog`, or
  `<dcid>.qlog.gz` with gzip stream compression.
  - In streaming mode the header is written up to `"events":[`, events are appended, and the
    closing brackets are written at finish. A crashed process leaves **unterminated JSON**.
- Event names (`QLoggerTypes.cpp:1303-1356`, `toQlogEventName`):
  - `quic:packet_sent`, `quic:packet_received`, `quic:connection_closed`.
  - `quic:congestion_state_updated` is used for CongestionMetricUpdate, AppIdleUpdate and
    AppLimitedUpdate, each with different data.
  - `quic:packet_dropped`, `quic:packet_buffered`, `quic:recovery_metrics_updated`,
    `quic:stream_state_updated`, `quic:connection_state_updated`, `quic:packet_lost`.
  - **Non-standard:**
    - `quic:datagram_received` (singular; the data is `{raw:{length}}` as an object)
    - `quic:loss_timer_updated` (data `{largest_sent, alarm_count, outstanding_packets, type}`)
    - `quic:packet_ack` (data `{packet_num_space, packet_num}`)
    - `quic:connection_migrated`, `quic:path_validated`, `quic:stream_priority_updated`
  - **Custom namespace:** `mvfst:transport_summary`, `mvfst:pacing_metric_update`,
    `mvfst:pacing_observation`, `mvfst:bandwidth_est_update`, `mvfst:l4s_weight_update`,
    `mvfst:network_path_model_update`.
- Data shape surprises:
  - `quic:packet_lost` = `{largest_lost_packet_num, lost_bytes, lost_packets}`: aggregate, **no
    `header`** (`QLoggerTypes.cpp:906-919`).
  - STREAM frame `stream_id` is a **JSON string** (`QLoggerTypes.cpp:198`:
    `d["stream_id"] = folly::to<std::string>(streamId);`), and data length is in `raw.length`
    (`:200-205`).
  - `rst_stream` logs `error:"unknown"` plus `error_code`.
  - Packet events log `header.packet_type`, `header.packet_number`, `raw.length` and `frames`.
  - Metrics are ms floats: `microsecondsToMilliseconds(...)`.

### 3.6 picoquic (private-octopus/picoquic)

- Still writes the **draft-00 "event_fields" format** (`loglib/qlog.c:1605-1617`, identical in
  `loglib/qlog_fns.c:937-948`):
  ```c
  fprintf(f, "{ \"qlog_version\": \"draft-00\", \"title\": \"picoquic\", \"traces\": [\n");
  fprintf(f, "{ \"vantage_point\": { \"name\": \"backend-67\", \"type\": \"%s\" },\n", client_mode?"client":"server");
  fprintf(f, "\"event_fields\": [\"relative_time\", \"path_id\", \"category\", \"event\", \"data\"],\n"); // or without path_id
  fprintf(f, "\"configuration\": {\"time_units\": \"us\"},\n");
  fprintf(f, "\"common_fields\": { \"protocol_type\": \"QUIC_HTTP3\", \"reference_time\": \"%"PRIu64"\"},\n", ctx->start_time);
  ```
  Events are arrays: `[<delta µs>, ("<path_id>",) "transport", "packet_sent", {...}]` (`qlog.c:140-147`).
- Categories and events: `transport:` `parameters_set`, `packet_dropped`, `packet_buffered`,
  `datagram_sent`, `datagram_received`, `spin_bit_updated`, `packet_sent`, `packet_received`;
  `recovery:` `packet_lost`, `congestion_state_updated`, `metrics_updated`; `info:message`.
- Filenames: `<cid>.<client|server>.qlog` or `<cid>.qlog` (`qlog_fns.c:915-920`).
- Upstream issue #2042 "Evolve QLOG" (open) discusses dropping binlog/text log, but no schema upgrade.

### 3.7 ngtcp2 (also curl `--qlog`/`QLOGDIR`, nghttp2 tools, Node.js QUIC)

- `lib/ngtcp2_qlog.c:165-202` (v1.25.0, current master):
  ```c
  "\"common_fields\":{\"protocol_type\":[\"QUIC\"],\"time_format\":\"relative\",\"reference_time\":0,\"group_id\":"
  ...
  "\"trace\":{\"vantage_point\":{\"name\":\"ngtcp2\",\"type\":"
  ...
  p = write_verbatim(p, "\x1E{\"qlog_format\":\"JSON-SEQ\",\"qlog_version\":\"0.3\",");
  ```
- Times are **integer milliseconds**: `ts / NGTCP2_MILLISECONDS` (`:69-75`), so there is no
  sub-ms resolution.
- Names: `transport:packet_sent`, `transport:packet_received`, `transport:parameters_set` (with
  `owner`), `recovery:metrics_updated`, `recovery:packet_lost`.
- Example clients and servers write `<scid hex>.sqlog`.

### 3.8 aioquic (aiortc/aioquic)

- `src/aioquic/quic/logger.py`:
  ```python
  QLOG_VERSION = "0.3"
  ...
  def encode_time(self, seconds: float) -> float:
      return seconds * 1000            # absolute Unix-epoch ms (time.time())
  def log_event(self, *, category: str, event: str, data: dict) -> None:
      self._events.append({"data": data, "name": category + ":" + event, "time": self.encode_time(time.time())})
  ...
  return {"qlog_format": "JSON", "qlog_version": QLOG_VERSION, "traces": [...]}
  ```
- Trace: `{common_fields:{ODCID}, events, vantage_point:{name:"aioquic", type}}`. There is no
  `reference_time` or `time_format`. The file is `<ODCID>.qlog`.
- Names: `transport:` `packet_sent`, `packet_received`, `packet_dropped`, `parameters_set`,
  `datagrams_sent`, `datagrams_received`, `version_information`, `alpn_information`;
  `recovery:` `metrics_updated`, `packet_lost`; `security:` `key_updated`, `key_retired`;
  `connectivity:spin_bit_updated`; `http:` `frame_created`, `frame_parsed`, `stream_type_set`.

### 3.9 lsquic (litespeedtech/lsquic)

- `src/liblsquic/lsquic_qlog.c` prints pre-draft rows via the logger module `qlog`. They are
  embedded in the regular text debug log, not written as a file:
  ```c
  LCID("[%" PRIu64 ",\"TRANSPORT\",\"PACKET_RX\",\"LINE\",{\"raw\":\"%s%s\",\"header\":{\"type\":\"%s\",\"payload_length\":\"%d\",\"packet_number\":\"%" PRIu64 "\"}%s}]", ...
  ```
- `docs/apiref.rst:2620`: "*qlog*: QLOG output. At the moment, it is out of date." This is not
  ingestible.

### 3.10 msquic (microsoft/msquic)

- No native qlog. Issue #1158 "Support qlog Logging Format" (open) says that adding qlog directly
  "has been deemed not to be an option", and that the way forward is ETW/LTTng to qlog conversion.
- The ETW analysis tool (`quicetw --conn_qlog`) converts an ETW trace into `conn.qlog` in
  pre-draft form:
  - `src/tools/etw/main.c:535-541` writes `QjWriteString(Qj, "qlog_version", "draft-00")` and
    `"time_units": "ms"`.
  - `src/tools/etw/cxn.c:143-170` writes `vantage_point.type` as `"CLIENT"`/`"SERVER"`
    (uppercase) and `event_fields:["relative_time","CATEGORY","EVENT_TYPE","DATA"]`.

  It has `qlog_version` but no `file_schema`, so it is legacy and must be rejected.

### 3.11 s2n-quic (aws/s2n-quic)

- No qlog writer. The event types in `quic/s2n-quic-core/events/*.rs` cite
  `draft-marx-qlog-event-definitions-quic-h3-02`, but output goes through the `event::Subscriber`
  trait (tracing, metrics). Issue #1199 "events: Implement a qlog Event Subscriber" has been open
  since 2022.

### 3.12 Chromium (NetLog, not qlog)

- Chromium (`chromium/chromium`) has no qlog code: a code search for "qlog" only hits unrelated
  test data, and `google/quiche` has none either. Chrome exports **NetLog JSON** via
  `chrome://net-export`.
- The file has a top-level `constants` object containing `logFormatVersion: 1`,
  `logEventTypes`, `logSourceType`, `logEventPhase` and `timeTickOffset`
  (`net/log/net_log_util.cc:67,145-149,265,274,324`), plus an `events` array.
- QUIC event types are listed in `net/log/net_log_event_type_list.h`: 147 `QUIC_*` types, for
  example `QUIC_SESSION_PACKET_SENT`, `QUIC_SESSION_PACKET_RECEIVED`,
  `QUIC_SESSION_STREAM_FRAME_SENT`, `QUIC_SESSION_ACK_FRAME_RECEIVED`,
  `QUIC_SESSION_TRANSPORT_PARAMETERS_SENT`, `QUIC_SESSION_PACKET_LOST`,
  `QUIC_SESSION_CONNECTION_CLOSE_FRAME_SENT`, `QUIC_SESSION_CLOSED`.
- qvis converts NetLog in the browser (`src/components/filemanager/netlogconverter/netlogtoqlog.ts`).
  It detects NetLog by `activeFieldTrialGroups` in the first bytes (`FileLoader.ts:234-236`) and
  outputs **draft-01** qlog: `qlog_version:"draft-01"`, `event_fields`, `transport`/`recovery`/`http`
  categories (`netlogtoqlog.ts:870-893`).
- **Parity requirement:** the React port keeps the NetLog import, but its converter MUST emit the
  latest model (contained file schema, `quic:*`/`http3:*` names, `relative_to_epoch`), so the
  converter output never trips the legacy rejection path.

### 3.13 Other notable emitters (all legacy; reject)

| Stack | Evidence |
|---|---|
| Go `golang.org/x/net/quic` | `quic/qlog/qlog.go:191-195`: `// At the time of writing this comment the most recent version is 0.4, but qvis only supports up to 0.3.` followed by `writeStringField("qlog_version", "0.3"); writeStringField("qlog_format", "JSON-SEQ")`. `common_fields`: `protocol_type:["QUIC"]`, `time_format:"relative"`, `reference_time`. Names `connectivity:connection_started`, `connectivity:connection_closed`, `connectivity:packet_dropped`, `transport:packet_received`, `transport:packet_sent`. Files `<group_id>_<vantage>.sqlog`. |
| OpenSSL QUIC | `ssl/quic/qlog.c:296-321`: `"qlog_version":"0.3"`, `"qlog_format":"JSON-SEQ"`, `common_fields:{time_format:"delta", protocol_type:["QUIC"], group_id, system_info:{process_id}}`, vantage name `"OpenSSL/<ver> (<platform>)"`. Event time is written **after** `data` as integer ms: first event absolute (`ossl_time2ms(event_time)`), later events deltas. Names `connectivity:connection_started/closed/state_updated`, `transport:packet_sent/received`, `recovery:packet_lost`. Files `<odcid>_<role>.sqlog`. |
| Tencent tquic | `src/qlog/qlog.rs:30-35`: `QLOG_VERSION: &str = "0.4"` (comment: "for draft-ietf-quic-qlog-main-schema-07"), `JSON_SEQ_FORMAT = "JSON-SEQ"`. Names mix `connectivity:`, `quic:`, `recovery:`, `security:`, `h3:`, `qpack:`, `generic:`. Writes JSON-SEQ to **`<trace_id>.qlog`**. `tools/script/tquic_qvis.sh` converts to qvis-compatible JSON by rewriting `"quic:"` to `"transport:"` and `"0.4"` to `"0.3"`, so `*.qvis.json` files with that shape exist in the wild. |
| Alibaba xquic | `scripts/qlog_parser.py:963-964`: post-processes xquic text logs into `{"qlog_version":"0.4","qlog_format":"JSON",...}` with `common_fields:{ODCID, time_format:"absolute"}`. |
| kwik (Java) | `qlog/src/main/java/tech/kwik/qlog/ConnectionQLog.java:126-205`: `qlog_version:"draft-02"`, `qlog_format:"JSON"`, `time_format:"relative"`, `reference_time:<epoch ms number>`, integer-ms times, `transport:packet_*`, `recovery:packet_lost`, `recovery:metrics_updated`. File `<cid>.qlog`. |
| Haskell `quic` (kazu-yamamoto) | `Network/QUIC/Qlog.hs`: `{"qlog_format":"NDJSON","qlog_version":"draft-02","title":"Haskell quic qlog",...}`, names `transport:*`, `recovery:*` (incl. `recovery:loss_timer_updated`), `connectivity:connection_id_updated`, bare `"debug"`. |

HAProxy and nginx have no qlog support (code search for "qlog" is empty).

---

## 4. What qvis (the original) does today, and why that matters

- **Version gate:**
  - `src/data/QlogLoaderV2.ts:14-28` accepts only `qlog_version` in
    `["draft-02", "draft-02-RC1", "qlog-03-WIP", "0.3"]` (`src/data/QlogSchema02.ts:13`).
  - Older versions go through `QlogLoader` (draft-00/01).
  - Files without `qlog_version` are refused: `"qlog files MUST have a qlog_version field in
    their top-level object!"`.

  This is why quic-go and tquic write fake `0.3` fields.
- **Sniffing:**
  - `src/components/filemanager/data/FileLoader.ts:211-246` looks only at the first 1024
    characters for `qlog_version`/`qlog_format`, `NDJSON` or `JSON-SEQ`, `activeFieldTrialGroups`
    (NetLog), and `_source`+`layers` (tshark pcap JSON).
  - As a fallback it accepts any of `traces`, `event_fields`, `vantage_point` or `common_fields`
    as "normal JSON".
  - A latest-format neqo/quiche `.sqlog` with no `qlog_version` takes the `.sqlog`-extension
    path, since `.sqlog` maps to JSON-SEQ in the extension table at `FileLoader.ts:168-197`. It
    then fails the `header.qlog_version === undefined` check in
    `src/components/filemanager/newlineconverter/textsequencejsontoqlog.ts:26`.
- **Extensions allow-list** (`FileLoader.ts:168-197`):
  - JSON-SEQ: `.sqlog`, `.qlogseq`
  - NDJSON: `.qlognd`
  - tshark pcap JSON: `.pcap.json`
  - NetLog: `.netlog` and its `.br`, `.brotli`, `.gz`, `.gzip` and `.zip` variants
  - Ambiguous, resolved by sniffing: `.qlog` and `.json`, each with the same compressed variants
- **Truncation tolerance:** `src/components/filemanager/utils/StreamingJSONParser.ts:12-26` tries
  `JSON.parse` and falls back to oboe streaming to salvage unterminated files. This matters for
  mvfst streaming files and killed processes, and it is a parity requirement.
- **Category coupling:** visualizations look events up by `(category, type)`, with the category
  taken from `name.split(":")[0]` (`src/data/QlogLoaderV2.ts:331-366`). Examples:
  - `qlog.EventCategory.transport` in `SequenceDiagramD3Renderer.ts:494-495`,
    `CongestionGraphD3Renderer.ts:1081-1085`, `StatisticsConnectionRenderer.vue:466-505` and
    `FileManagerContainer.vue:546-550`
  - `recovery` in `CongestionGraphD3Renderer.ts:1083-1084`
  - `http` in `MultiplexingGraphD3SimulationRenderer.ts:96` and
    `StatisticsConnectionRenderer.vue:321-322`

  `quic:packet_sent` therefore never matches, which is the root cause of quic-go issue #5348.
  In the React port, visualizations MUST look up **canonical latest names** only
  (`quic:packet_sent`, `quic:recovery_metrics_updated`, `http3:frame_created`, ...). Legacy and
  intermediate names are mapped once, at load time (section 6.4).
- **Field coupling:**
  - `MultiplexingGraphD3ByterangesRenderer.ts:92,214` and
    `MultiplexingGraphD3CollapsedRenderer.ts:433` read `frame.offset` and **`frame.length`** of
    STREAM frames. That is the legacy field; latest uses `raw.payload_length`/`raw.length`.
  - `PacketizationQUICPreProcessor.ts:217-244` reads `data.raw.length`/`raw.payload_length`, and
    `:615-617` reads legacy `frame.frame_size`.
  - `PacketizationQUICPreProcessor.ts:469-475` reads `max_packet_size` (latest:
    `max_udp_payload_size`).
  - The React port MUST use the accessor helpers in section 6.6 instead of raw field reads.
- **group_id split:** `src/data/QlogLoaderV2.ts:68-110` splits a trace into per-group connections
  only if `events[0].group_id` is defined. See section 5.8 for the more robust rule.

---

## 5. Cross-cutting robustness requirements (observed deviations)

1. **Header precedence.** A header object may contain both `file_schema` and
   `qlog_version`/`qlog_format` (quic-go). `file_schema` wins. Ignore `qlog_version` and
   `qlog_format` when `file_schema` is present.
2. **`serialization_format` values seen:** `application/qlog+json-seq` (quic-go),
   `application/qlog+json` (mvfst) and `JSON-SEQ` (quiche, neqo, quinn, tokio-quiche).
   - Compare case-insensitively and treat it as informational.
   - Framing is decided by content sniffing (leading `0x1E` means JSON-SEQ), never by this field
     or by the extension. tquic, for example, writes JSON-SEQ into `.qlog`.
3. **`file_schema` may not be near the start** (mvfst, hash-ordered keys). Main-14 §3 only says
   "SHOULD be in the first 256 bytes". Decide after parsing the header object or record, not by
   substring search.
4. **JSON-SEQ framing variants:**
   - Canonical: RS + compact JSON + LF.
   - quiche `*_pretty`: RS + multi-line JSON + LF.
   - Historical NDJSON with no RS: Haskell, old drafts. These are legacy and rejected, but the
     sniffer must not crash on them.
   - Split on `0x1E`, trim whitespace, skip empty chunks, and `JSON.parse` each chunk.
   - A final chunk that fails to parse is a truncated tail: drop it with a warning.
5. **Contained JSON truncation** (mvfst streaming, crashes): try `JSON.parse`. On failure, use a
   tolerant streaming parse, or a cheap repair: cut back to the last complete event object, then
   append the missing `]}` / `]}]}` closers. Keep the salvaged events and warn (qvis parity:
   `StreamingJSONParser.ts:12-26`).
6. **Compression** (sniff magic bytes first, then extension):
   - gzip `1F 8B` (mvfst `.qlog.gz`, quiche `.sqlog.gz`): use the native `DecompressionStream('gzip')`.
   - zstd `28 B5 2F FD` (quiche `.sqlog.zst`): needs a small JS decoder such as `fzstd`.
   - qvis parity also lists `.br`, `.brotli` and `.zip` for `.qlog`, `.json` and `.netlog`
     (`FileLoader.ts:168-197`). Brotli has no magic number, so it can only be chosen by extension.
7. **`event_schemas`:**
   - Versioned (`...:quic-12`, `...:http3-12`, `...:loglevel-13`), unversioned (`...:quic`,
     mvfst), private (`...:mvfst`), **empty** (quinn) or missing.
   - Parse with
     `^urn:ietf:params:qlog:events:([A-Za-z0-9_.-]+?)(?:-(\d+))?(?:#(.+))?$`.
   - Never reject on these values. Use them only for display and as a hint.
   - Events are classified by their own name prefix.
8. **Multiple connections per trace.**
   - quinn writes per-event `group_id` on a possibly shared stream.
   - Effective group = `event.group_id ?? common_fields.group_id`.
   - Split the trace into one logical connection per distinct effective group when there are 2 or
     more distinct values, or when per-event `group_id` exists on any event, not only `events[0]`.
   - Label each connection with group id + trace title.
   - Events without any group_id go into a trace-level "(ungrouped)" connection only if one or
     more such events exist.
9. **Ordering.** Writers can be multi-threaded, and quic-go #5955 fixed out-of-order writes only
   in 2026-10.
   - After resolving `relative_to_previous_event` deltas, stable-sort events by absolute time.
   - Count and report how many were out of order (main-14 §7.1 "Tools MAY sort").
10. **Time bases:**
    - **Units:** always ms floats in accepted producers. They are integer ms in some legacy
      producers, which are rejected.
    - **Origins:**
      - Trace start: quic-go, quiche, neqo, quinn.
      - Boot or monotonic epoch: mvfst, where values around 1e8 are normal.
      - Unix epoch: aioquic, rejected.
    - Show time relative to the first event of the trace, as qvis does, and keep the original
      value for tooltips and raw view.
    - Use `wall_clock_time` (quic-go, quiche, neqo) only as an informational absolute timestamp.
11. **`reference_time` shapes:**
    - Object (latest).
    - Object with empty strings: a defaulted quiche `CommonFields`.
    - Absent: quinn.
    - Legacy: number (ngtcp2 `0`, kwik epoch ms) or numeric string (picoquic µs).
    - Treat empty or unknown `clock_type` as `"system"` and empty `epoch` as `"unknown"`.
12. **`tuple` placement:** `event.tuple ?? event.data?.tuple ?? common_fields.tuple ?? ""`. quic-go
    puts it in `data`.
13. **`vantage_point`:**
    - Lowercase the `type`.
    - Map unknown values (quic-go endpoint traces use `"transport"`, msquic uses uppercase) to
      `"unknown"`.
    - quinn always writes `unknown`.
    - For `unknown`, infer the side heuristically as main-14 §6 suggests: the first
      `quic:packet_sent` of type `initial` before any `quic:packet_received` means client. The
      user can override this. This is a qvis parity item; see the sequence diagram's
      vantage-point handling at `SequenceDiagramConfigurator.vue:113`.
14. **uint64 as strings** (main-14 §11.3):
    - mvfst `stream_id`; legacy `packet_number`/`offset`/`length` strings.
    - Coerce with a `toNum(v)` helper: number passthrough; numeric string to Number; otherwise
      `undefined`.
    - Values above 2^53 lose precision, which is acceptable for visualization. Keep the original
      string for display when `typeof v === "string"`.
15. **Partial metric updates.**
    - quic-go emits `metrics_updated` with only `pto_count`. Other producers omit unchanged fields.
    - The congestion graph and stats must carry forward the last known value per field, not treat
      missing as 0.
16. **Same name, different data shape** (do not crash; validate per field):
    - mvfst `quic:packet_lost` without `header`.
    - mvfst `quic:congestion_state_updated` with `{new, trigger}` only.
    - quic-go `reset_stream` without `error`.
    - quiche `connection_id_updated` with `owner`.
    - quic-go and quiche `connection_started` (latest `{local, remote}`) vs legacy
      `{ip_version, src_ip, dst_ip, src_port, dst_port, ...}`.
17. **Custom events and namespaces.** Pass them through unchanged and show them in generic views
    (event list, stats counters, raw view). They do not drive specialized visualizations.
    - `mvfst:*`
    - mvfst `quic:packet_ack`, `quic:connection_migrated`, `quic:path_validated`,
      `quic:stream_priority_updated`
    - quic-go `recovery:spurious_loss`, `transport:priority_updated`, `transport:<custom>` debug
      events

---

## 6. Recommended compatibility normalization

### 6.1 Policy tiers

| Tier | Input | Action |
|---|---|---|
| **T0 native** | `file_schema` = contained/sequential, latest names | Load. |
| **T1 normalize** | `file_schema` present (even with `qlog_version` alongside); any of the aliases in 6.3-6.5 | Load; rewrite names and fields in a single normalization pass; record each alias kind hit in a per-file "compatibility notes" list, which the file manager can show as an info badge (e.g. "12,345 events used legacy name prefix `transport:`; mapped to `quic:`"). |
| **T2 convert** | Chromium NetLog JSON; tshark pcap JSON (qvis-server path) | Existing qvis features; converters MUST output latest-draft qlog. |
| **T3 reject** | `qlog_version`/`qlog_format` without `file_schema`; `event_fields`; non-JSON; unknown `file_schema` URI | Refuse with a specific, actionable message (6.7). Do not partially load. |

Rationale: the user's brief limits the input format to the latest drafts. T1 covers emitters
whose envelope is latest but whose event vocabulary lags, which describes every
latest-envelope emitter today (quic-go, quiche, neqo, quinn, mvfst). Aliasing is a pure lookup at
load time and does not leak legacy handling into visualizations.

### 6.2 Detection algorithm (normative for the loader)

```text
input: File | URL response (bytes) + filename

1. Decompress
   - magic 1F 8B             -> gzip (DecompressionStream)
   - magic 28 B5 2F FD       -> zstd (fzstd)
   - magic 50 4B 03 04       -> zip (fflate); take first entry ending in .qlog/.sqlog/.json/.netlog
   - else if name ends .br/.brotli -> brotli (JS decoder); else raw
   Strip compression suffixes from the name for later hints.
2. Decode UTF-8 (strip BOM). Let c = first non-whitespace char.
3. If c == '\x1E' (RS) -> JSON-SEQ path:
     records = split on '\x1E', trim, drop empty; header = JSON.parse(records[0]).
     If records[0] fails to parse -> T3 "Not a valid JSON-SEQ qlog file" (show first 200 chars).
     For i>0: parse; on failure: if last -> drop (truncated tail warning) else -> skip + warn.
     classify(header)
4. Else if c == '{' or '[' :
     try obj = JSON.parse(all). On failure:
        a) if the first line parses on its own and is an object with qlog_version|qlog_format  -> NDJSON legacy -> T3
        b) else tolerant/truncation-salvage parse (5.5); warn.
     If obj is an Array:
        if obj[0]?._source?.layers -> tshark pcap JSON -> T2 (pcap converter)
        else -> T3 unknown
     classify(obj)
5. Else -> T3 "Not a qlog/NetLog file" (e.g. lsquic text log, pcap binary — suggest qvis-server/pcap2qlog for pcap).

classify(o):
  if typeof o.file_schema === "string":
      s = o.file_schema.trim().toLowerCase()
      if s === "urn:ietf:params:qlog:file:sequential": expect o.trace (TraceSeq); events = following records
          (if events are instead found in o.trace.events, accept them too)
      elif s === "urn:ietf:params:qlog:file:contained": expect o.traces (array); TraceError entries allowed
          (if o.trace is present instead and o.traces absent, accept as single trace + note)
      else -> T3 "Unsupported file_schema '<s>'"
      -> T0/T1 (ignore qlog_version/qlog_format if present)
  elif o.constants?.logEventTypes !== undefined && Array.isArray(o.events) -> Chromium NetLog -> T2
  elif "qlog_version" in o || "qlog_format" in o || any(trace.event_fields) || o.trace?.event_fields
      -> T3 legacy (6.7), with producer hint
  elif ("traces" in o || "trace" in o) -> T3 "qlog file without file_schema (pre-draft-10 format)"
  else -> T3 unknown JSON
```

Notes:

- Never rely on the filename extension for the decision. Use it only to choose a decompressor for
  brotli and to make error messages clearer. The qvis extension allow-list
  (`FileLoader.ts:168-197`) should be kept as an "accept for upload" filter, extended with
  `.sqlog.gz`, `.sqlog.zst`, `.qlog.gz`, `.qlog.zst`, `.json.zst` and `.sqlog.br`.
- Do not use the 1024-byte prefix sniffing that qvis does at `FileLoader.ts:211-246`. It
  misclassifies mvfst output (late `file_schema`) and quic-go output (contains `qlog_version`).

### 6.3 Envelope / trace-level normalization (T1)

| Observed | Producer | Normalize to |
|---|---|---|
| `serialization_format: "JSON-SEQ"` / `"JSON"` / `"NDJSON"`, any case | quiche, neqo, quinn | `application/qlog+json-seq` / `application/qlog+json` (display only) |
| `qlog_version`, `qlog_format` alongside `file_schema` | quic-go | drop (keep in "raw header" view) |
| custom top-level keys (`code_version`, ...) | quic-go | keep as metadata; show in file info |
| `common_fields.protocol_types` / `protocol_type` | quiche, neqo | ignore (removed in main-11) |
| `common_fields.ODCID` / `odcid` / `scid` | mvfst (aioquic legacy) | keep; use `odcid ?? ODCID` as fallback connection label and as fallback group id **only for display** (not for splitting) |
| `event_schemas: []` or missing | quinn | treat as unknown; derive the namespaces actually used from event names |
| `event_schemas` unversioned / `-NN` suffixed / private | mvfst / all others | parse (5.7); no validation failure |
| `vantage_point.type` uppercase or non-standard (`"transport"`) | msquic, quic-go endpoint traces | lowercase; non-`client/server/network/unknown` becomes `unknown`; keep the original in metadata |
| `vantage_point` missing | – | `{type: "unknown"}` + heuristic (5.13) |
| `reference_time` object with `""` fields | quiche default `CommonFields` | `clock_type` `""` becomes `"system"`, `epoch` `""` becomes `"unknown"` |
| `reference_time` number or numeric string (only legacy observed) | ngtcp2, kwik, picoquic | if ever seen with `file_schema`: `{clock_type:"system", epoch: new Date(ms).toISOString()}` + compatibility note |
| `time_format: "relative"` / `"delta"` / `"absolute"` (legacy) | (legacy only) | `relative_to_epoch` / `relative_to_previous_event` / `relative_to_epoch` with epoch 1970 |
| `time_format` per event | allowed by spec | honor per event (spec main-14 §7.1: formats may differ per event) |
| `tuple` in `data` | quic-go | hoist to event-level `tuple` if event-level absent |
| `path` (event-level, main-schema <= 12) | intermediate drafts | rename to `tuple` |
| `group_id` non-string (number) | – | `String(v)` (JSON.stringify for objects), as qvis does at `QlogLoaderV2.ts:98-100` |
| `system_info` | OpenSSL (legacy) | keep, display only |
| `TraceError` entries in `traces` | spec | show as error rows in the file manager (qvis parity: `QlogLoaderV2.ts:49-56`) |

### 6.4 Event-name aliases (T1)

Apply to every event `name`, after trimming. Matching is on the exact full legacy name first,
then the generic prefix rule. The canonical result is the only name visualizations ever see. Keep
`originalName` on the normalized event for the raw/JSON view and for the compatibility notes.

**Exact-name table** (legacy or intermediate name to canonical latest name). These win over
prefix rules because the event name itself changed.

| Legacy / intermediate name(s) | Canonical (latest) | Seen in |
|---|---|---|
| `recovery:metrics_updated`, `quic:metrics_updated` | `quic:recovery_metrics_updated` | quic-go, ngtcp2, aioquic, tquic, Haskell, kwik |
| `recovery:parameters_set` | `quic:recovery_parameters_set` | quiche<=0.26, tquic |
| `recovery:loss_timer_updated`, `quic:loss_timer_updated` | `quic:timer_updated` (data compatible: `event_type`, `timer_type`, `packet_number_space`, `delta`) | quic-go, mvfst*, tquic, Haskell |
| `transport:datagrams_sent`, `quic:datagrams_sent` | `quic:udp_datagrams_sent` | quiche (current!), aioquic, tquic |
| `transport:datagrams_received`, `quic:datagrams_received` | `quic:udp_datagrams_received` | quiche (current!), aioquic, tquic |
| `transport:datagram_dropped`, `quic:datagram_dropped` | `quic:udp_datagram_dropped` | quic-go (current!), quiche (current!), tquic |
| `quic:datagram_received` (singular) | `quic:udp_datagrams_received` + data shim: wrap `raw` object into array | mvfst |
| `transport:data_moved`, `quic:data_moved`, `http:data_moved` | `quic:stream_data_moved` | quiche<=0.26, older drafts |
| `security:key_retired`, `quic:key_retired`, `security:key_discarded` | `quic:key_discarded` | quiche (current!), aioquic, tquic, quic-go |
| `connectivity:path_assigned`, `quic:path_assigned` | `quic:tuple_assigned` + field shim (6.5) | intermediate drafts (10-11) |
| `transport:frames_processed` | `quic:frames_processed` | quiche<=0.26 |
| `generic:error`, `generic:internal_error`, `generic:connection_error`, `generic:application_error` | `loglevel:error` | quiche<=0.26, tquic |
| `generic:warning`, `generic:internal_warning` | `loglevel:warning` | tquic |
| `generic:info`, `generic:message` | `loglevel:info` | quiche<=0.26, tquic |
| `generic:debug`, `transport:debug` | `loglevel:debug` (quic-go data `{message}` already matches) | tquic, quic-go |
| `generic:verbose` | `loglevel:verbose` | tquic |
| `generic:marker` | `simulation:marker` | quiche<=0.26, tquic |
| `http:capsule_created`, `http:capsule_parsed` | **unchanged** (valid latest `http` namespace) | h3-13 |

*mvfst's `quic:loss_timer_updated` data is `{largest_sent, alarm_count, outstanding_packets,
type}`, which does not match TimerUpdated. Alias the name, but treat it as a timer event with
unknown fields. Charts that need `event_type` must skip it gracefully.

**Prefix rules** (applied when no exact rule matched). Replace only the namespace and keep the
event type.

| Legacy prefix | Canonical prefix | Notes |
|---|---|---|
| `transport:` | `quic:` | category renamed in quic-events-05; quic-go (current), ngtcp2, aioquic, Go x/net, OpenSSL, kwik, Haskell |
| `connectivity:` | `quic:` | categories removed in quic-events-09 |
| `recovery:` | `quic:` | e.g. `recovery:packet_lost`, `recovery:congestion_state_updated`, `recovery:marked_for_retransmit`, `recovery:ecn_state_updated`, `recovery:mtu_updated` (quic-go) |
| `security:` | `quic:` | `security:key_updated` becomes `quic:key_updated` |
| `h3:` | `http3:` | h3-events 05-08 era (tquic, xquic) |
| `http:` | `http3:` | **except** `http:capsule_created` / `http:capsule_parsed` (exact rule above). In latest drafts the `http` namespace contains *only* the capsule events, so any other `http:*` is unambiguously the old HTTP/3 category (aioquic, quiche<=0.26). |
| `simulation:`, `loglevel:`, `quic:`, `http3:` | unchanged | already canonical |
| `qpack:` | unchanged (no latest equivalent; removed in h3-06) | treat as custom |
| no `:` at all (e.g. `"debug"`) | `loglevel:<name>` if name in {error, warning, info, debug, verbose}; else unchanged | Haskell (legacy) |
| anything else (`mvfst:`, unknown) | unchanged | custom namespace; pass through |

After prefix mapping, names that stay non-canonical within `quic:` (mvfst `quic:packet_ack`,
`quic:connection_migrated`, `quic:path_validated`, `quic:stream_priority_updated`; quic-go
`quic:spurious_loss` (from `recovery:`) and `quic:priority_updated` (from `transport:`)) are
**left as-is** and treated as custom. Do NOT guess mappings such as
`packet_ack`→`packets_acked`, because the data shapes differ.

Implementation sketch:

```ts
const EXACT: Record<string, string> = { "recovery:metrics_updated": "quic:recovery_metrics_updated", /* ...table... */ };
const PREFIX: Record<string, string> = { transport: "quic", connectivity: "quic", recovery: "quic", security: "quic", h3: "http3", http: "http3" };
const LOGLEVELS = new Set(["error", "warning", "info", "debug", "verbose"]);
export function canonicalEventName(raw: string): { name: string; aliased: boolean } {
  const n = raw.trim();
  const exact = EXACT[n]; if (exact) return { name: exact, aliased: true };
  const i = n.indexOf(":");
  if (i < 0) return LOGLEVELS.has(n) ? { name: `loglevel:${n}`, aliased: true } : { name: n, aliased: false };
  const ns = n.slice(0, i), type = n.slice(i + 1);
  if (ns === "http" && (type === "capsule_created" || type === "capsule_parsed")) return { name: n, aliased: false };
  const mapped = PREFIX[ns];
  if (!mapped) return { name: n, aliased: false };
  const candidate = `${mapped}:${type}`;
  return { name: EXACT[candidate] ?? candidate, aliased: true };  // re-run exact table on the new name (e.g. quic:datagrams_sent)
}
```

### 6.5 Data-field shims (T1)

These are cheap, local and lossless. Apply them only when the canonical field is absent, so a
correct field is never overwritten. Record each shim in the compatibility notes.

| Where (canonical event / object) | Legacy field(s) | Canonical | Producers |
|---|---|---|---|
| any event `data` with side info: `quic:parameters_set`, `quic:parameters_restored`, `quic:connection_id_updated`, `quic:connection_closed`, `quic:stream_state_updated`, `http3:stream_type_set`, `http3:parameters_set` | `owner` | `initiator` (values `local`/`remote` unchanged) | quiche (`connection_id_updated`, current), ngtcp2, kwik |
| `quic:key_updated`, `quic:key_discarded` | `generation` | `key_phase` | legacy; qvis `QlogSchema02.ts:280-291` |
| `quic:tuple_assigned` (from `path_assigned`) | `path_id`, `path_remote`, `path_local` | `tuple_id`, `tuple_remote`, `tuple_local` | intermediate drafts |
| `quic:connection_closed` | `connection_code` (string or number), `application_code`, `error_code_value` | `connection_error` (string), or `connection_error:"unknown"` + `error_code` (number); same pattern for `application_error`; `error_code_value` becomes `error_code` | quic-events <= 11 |
| ConnectionCloseFrame (`frame_type:"connection_close"`) | `error_code` as string, `raw_error_code` / `error_code_value` | `error` = that string; `error_code` = `raw_error_code ?? error_code_value` | legacy; qvis `QlogSchema02.ts:939-948` |
| ResetStream / ResetStreamAt / StopSending frames | numeric `error_code` without `error` | add `error:"unknown"` (keep `error_code`) | quic-go (current) |
| UnknownFrame | `raw_frame_type` / `frame_type_value` | `frame_type_bytes` | legacy |
| `http3:stream_type_set` | `raw_stream_type` / `stream_type_value` | `stream_type_bytes` | legacy |
| `http3:frame_created` / `http3:frame_parsed` | `data.byte_length` / `data.length` at event level | `data.frame.raw.length` (if absent) | legacy h3; qvis `QlogSchema02.ts:578-592` |
| any `raw` | `raw` as hex string | `raw = { data: <string> }` | legacy (qvis-era) |
| `quic:packet_sent` / `received` / `dropped` / `buffered` / `lost` | `data.header.packet_size`, `data.packet_size` | `data.raw.length` | legacy |
| same | `data.header.payload_length` | `data.raw.payload_length` | legacy (qvis `QlogSchema02.ts:774`), lsquic |
| same | `data.header.length` (quiche PacketHeader legacy field) | keep; use as `raw.length` fallback **only** if `raw.length` absent | quiche (current struct) |
| `quic:parameters_set` | `max_packet_size` | `max_udp_payload_size` | legacy; read by qvis `PacketizationQUICPreProcessor.ts:469-475` |
| `quic:udp_datagrams_sent` / `received` | `raw` as a single object | `raw: [obj]` | mvfst (`datagram_received`) |
| STREAM / CRYPTO / DATAGRAM frames | top-level `length` (number or string) | `raw.payload_length` (if absent) | quic-go (current), legacy |
| any frame | `frame_size` | `raw.length` (if absent) | legacy draft-02 (qvis `PacketizationQUICPreProcessor.ts:615-617`) |
| AckFrame | `acked_ranges` entries as `[n]` or `[a,b]`, numbers or strings | normalize to `[from, to]` numbers in accessor | all |

Explicitly **not** shimmed. Leave as-is and handle defensively in consumers:

- legacy `connection_started` address fields
- mvfst aggregate `packet_lost`
- mvfst timer data
- quic-go `priority_updated`

### 6.6 Accessor helpers (to be used by all visualizations instead of raw field reads)

```ts
toNum(v: unknown): number | undefined            // number | numeric string -> number
streamFrameDataLength(f): number | undefined     // f.raw?.payload_length ?? f.raw?.length ?? f.length ?? f.payload_length
frameWireLength(f): number | undefined           // f.raw?.length ?? f.frame_size
packetLength(evData): number | undefined         // raw?.length ?? header?.packet_size ?? packet_size ?? header?.length
packetPayloadLength(evData): number | undefined  // raw?.payload_length ?? header?.payload_length
ackRanges(f): Array<[number, number]>            // [[a],[b,c]] -> [[a,a],[b,c]] (any order allowed by spec)
eventTuple(e, trace): string                     // e.tuple ?? e.data?.tuple ?? trace.common_fields?.tuple ?? ""
eventGroup(e, trace): string | undefined         // e.group_id ?? trace.common_fields?.group_id
closeError(dataOrFrame): { space?, name?, code? } // connection_error/application_error/error + error_code (+ legacy codes)
```

STREAM length precedence (`raw.payload_length` before `raw.length`) is deliberate:

- quiche logs the data length only in `payload_length`.
- mvfst logs it in `raw.length`.
- quic-go logs it in `length`.
- quic-13 says the frame's Length field goes in `raw.length`.

All of these refer to the stream data byte count. The multiplexing and packetization views
consume `streamFrameDataLength`.

### 6.7 Rejections (T3) and exact user-facing messages

Show the message in the file manager error area, the same place qvis shows load errors. Include
a "details" disclosure with the first 300 characters of the header.

| Condition | Producer hint (match on header) | Message |
|---|---|---|
| `qlog_version` present and `file_schema` absent | `vantage_point.name == "ngtcp2"` → ngtcp2 (also curl/nghttp2/Node.js); `"aioquic"`; `title == "picoquic"`; name starts with `"OpenSSL/"`; `name == "go quic"` → Go x/net/quic; `name == "kwik"`; `title == "Haskell quic qlog"`; trace `title == "xquic qlog"`; `vantage_point.type` uppercase (`CLIENT`/`SERVER`) → msquic ETW tool; `qlog_version == "0.4"` + JSON-SEQ → likely tquic; `title == "quic-go qlog"` → quic-go < v0.56; `title` contains `"Quiche"`/`"quiche"` → quiche < 0.27 | "This file uses qlog version `<v>` (`<format>`), an older pre-standard format<, written by <producer>>. qvis-react only supports the IETF qlog drafts main-schema-14 / quic-events-13 / h3-events-13 (files with a `file_schema` field). Upgrade the implementation (for example quic-go >= v0.56, quiche >= 0.27) or open this file in legacy qvis at https://qvis.quictools.info." |
| `event_fields` present (draft-00/01 CSV-like rows) | picoquic, msquic ETW tool, qvis' own draft-01 netlog output | "This file uses the qlog draft-00/01 `event_fields` format<, written by picoquic>. qvis-react only supports the latest qlog drafts; open it in legacy qvis at https://qvis.quictools.info." |
| `qlog_format: "NDJSON"` or first line parses as JSON but RS is absent and no `file_schema` | Haskell quic, legacy | "Newline-delimited (NDJSON) qlog was replaced by JSON-SEQ (`.sqlog`) in qlog draft main-schema-01. This file is not supported." |
| JSON-SEQ or JSON with `file_schema` of an unknown value | – | "Unsupported qlog file_schema `<value>`. Supported: urn:ietf:params:qlog:file:contained, urn:ietf:params:qlog:file:sequential." |
| JSON with `traces`/`trace` but no `file_schema` or `qlog_version` | hand-made | "This looks like a qlog file but is missing the required `file_schema` field (qlog main-schema-14 §3)." |
| Not JSON at all | lsquic debug log, binary pcap | "Not a qlog, NetLog or tshark-JSON file. For packet captures (.pcap/.pcapng) use the pcap import (qvis-server / pcap2qlog)." Mirror whatever pcap path the parity plan keeps. |
| Header object has `file_schema` but zero parsable events | truncated at start | Not a rejection: load the empty trace and warn "No events could be parsed (file truncated?)". |

### 6.8 Things the normalizer must NOT do

- Must not reject on `event_schemas` content, on `serialization_format` mismatch, or on missing
  optional fields.
- Must not reorder or drop unknown fields. Keep them, so the raw-JSON panels show what the
  producer wrote.
- Must not alias `quic:*` custom names to standard names with different data shapes (see the end
  of 6.4).
- Must not convert time units. All accepted producers use ms. Just resolve
  `relative_to_previous_event` deltas into absolute values and keep the raw value.

---

## 7. Test fixtures to create (synthetic, from the evidence above)

Do not vendor third-party log files. Hand-write minimal fixtures that reproduce each producer's
exact header bytes and quirks under `src/**/__fixtures__/ecosystem/`:

| Fixture | Must exercise |
|---|---|
| `quic-go.sqlog` | header with `file_schema` + trailing `qlog_version:"0.3"`; `transport:`/`recovery:`/`security:`/`quic:datagram_dropped` names; `tuple` in `data`; STREAM frame `length`; numeric `reset_stream.error_code` without `error`; metrics update with only `pto_count`; two events out of order |
| `quic-go-endpoint.sqlog` | `vantage_point.type:"transport"`, no `group_id` |
| `quiche.sqlog` | `serialization_format:"JSON-SEQ"`, `protocol_types`, monotonic `wall_clock_time`, `quic:datagrams_sent`, `quic:key_retired`, `connection_id_updated.owner`, STREAM `raw.payload_length`, one pretty-printed multi-line record, `http3:*` events |
| `quiche.sqlog.gz`, `quiche.sqlog.zst` | decompression by magic bytes |
| `neqo.sqlog` | exact header from section 3.3, `event_schemas:["...quic-12"]` |
| `quinn.sqlog` | `event_schemas:[]`, no `common_fields`, vantage `unknown`, two interleaved connections via per-event `group_id` |
| `mvfst.qlog` | contained; `file_schema` placed **after** `traces`; unversioned + `mvfst` event schemas; `odcid`/`scid`; times around 1.2e8; `stream_id` strings; `mvfst:*` and `quic:packet_ack` events; aggregate `quic:packet_lost`; `quic:datagram_received` |
| `mvfst-truncated.qlog` | unterminated JSON (missing `]}]}`), last event cut mid-object |
| `mvfst.qlog.gz` | gzip |
| `truncated-tail.sqlog` | last JSON-SEQ record cut off |
| Reject fixtures | `ngtcp2-0.3.sqlog`, `aioquic-0.3.qlog`, `picoquic-draft00.qlog` (`event_fields`), `tquic-0.4.qlog` (JSON-SEQ in `.qlog`), `haskell-ndjson.qlog`, `go-xnet-0.3.sqlog`, `openssl-0.3.sqlog`, `lsquic.log` (text) → each asserts the specific message and producer hint |
| `chrome.netlog.json` | NetLog detection by `constants.logEventTypes`; converter output must pass the T0 validator (no aliases needed) |

Also add a property test: running `canonicalEventName` on every canonical name in quic-13 Table
1, h3-13 Tables 1-2 and main-14 §9 returns the name unchanged, with `aliased:false`.

---

## 8. Source index (for re-verification)

| Implementation | Files read (default branch, 2026-11-01) |
|---|---|
| quic-go | `qlogwriter/trace.go`, `qlogwriter/writer.go`, `qlogwriter/event_schemas.go`, `qlog/qlog_dir.go`, `qlog/event.go`, `qlog/frame.go`, `qlog/packet_header.go`, `qlog/types.go`, `http3/qlog/event.go`, `http3/qlog/frame.go`; tags v0.54.0-v0.57.0; issues #5348, #5955 |
| quiche | `qlog/Cargo.toml`, `qlog/src/lib.rs`, `qlog/src/events/{mod,quic,http3}.rs`, `qlog/src/streamer.rs`, `qlog/src/reader.rs`, `qlog/src/writer.rs`, `quiche/src/lib.rs` (`set_qlog_with_level`), `quiche/src/frame.rs`, `apps/src/common.rs`; tags 0.20.0-0.28.0 |
| neqo | `Cargo.toml`, `neqo-common/src/qlog.rs`, `neqo-transport/src/qlog.rs`, `test-fixture/src/lib.rs`; Firefox `netwerk/docs/http/logging.md` |
| quinn | `quinn-proto/Cargo.toml`, `Cargo.toml`, `quinn-proto/src/connection/qlog.rs`, `quinn-proto/src/config/transport.rs` |
| mvfst | `quic/logging/{FileQLogger.cpp,FileQLogger.h,QLoggerConstants.h,QLoggerConstants.cpp,QLoggerTypes.h,QLoggerTypes.cpp,BaseQLogger.cpp}`; commit history of `FileQLogger.cpp` |
| picoquic | `loglib/qlog.c`, `loglib/qlog_fns.c`, `loglib/autoqlog.c`; issue #2042 |
| ngtcp2 | `lib/ngtcp2_qlog.c`, `examples/client.cc`, `examples/server.cc`; release v1.25.0 |
| aioquic | `src/aioquic/quic/logger.py`, `src/aioquic/quic/connection.py`, `src/aioquic/quic/recovery.py`, `src/aioquic/h3/connection.py` |
| lsquic | `src/liblsquic/lsquic_qlog.c`, `docs/apiref.rst` |
| msquic | `src/tools/etw/cxn.c`, `src/tools/etw/qjson.h`; issue #1158 |
| s2n-quic | code search; `quic/s2n-quic-core/events/connection.rs`; issue #1199 |
| Chromium | `net/log/net_log_event_type_list.h`, `net/log/net_log_util.cc`; code search for "qlog" in `chromium/chromium` and `google/quiche` (no hits) |
| Go x/net | `quic/qlog/qlog.go`, `quic/qlog/json_writer.go`, `quic/qlog.go` |
| OpenSSL | `ssl/quic/qlog.c`, `ssl/quic/qlog_event_helpers.c` |
| tquic | `src/qlog/qlog.rs`, `src/qlog/events.rs`, `tools/src/bin/tquic_client.rs`, `tools/script/tquic_qvis.sh` |
| xquic | `scripts/qlog_parser.py`, `docs/Features.md` |
| kwik | `qlog/src/main/java/tech/kwik/qlog/ConnectionQLog.java` |
| Haskell quic | `Network/QUIC/Qlog.hs` |
| qvis | `src/data/QlogLoaderV2.ts`, `src/data/QlogSchema02.ts`, `src/components/filemanager/data/FileLoader.ts`, `src/components/filemanager/utils/StreamingJSONParser.ts`, `src/components/filemanager/newlineconverter/*.ts`, `src/components/filemanager/netlogconverter/netlogtoqlog.ts`, renderers cited in section 4 |

---

## 9. Open questions for the orchestrator / user

1. **Strictness vs. reach (main policy decision).**
   - Rejecting `qlog_version` 0.3/0.4 files follows the brief. It also means qvis-react cannot
     open qlogs from ngtcp2 (and so curl, nghttp2 and Node.js), aioquic, OpenSSL, Go x/net/quic,
     picoquic, tquic, kwik, or quic-go < v0.56 and quiche < 0.27.
   - That is a large share of today's files, including most QUIC interop-runner artifacts.
   - Event-name aliasing already exists for T1. A bounded "legacy 0.3/0.4 upgrader" would only
     need to map the header and time (`reference_time` number, `time_format`
     relative/delta/absolute) and could live behind a feature flag. It would still exclude
     `event_fields` and NDJSON.
   - Recommendation: ship strict, as the user asked, keep the upgrader out of v1, and raise it
     with the user before launch.
2. **"Drop-in replacement" vs. latest-only.** qvis's bundled demo files in
   `public/standalone_data/draft-00|draft-01|prespec|tcp` are all legacy. The parity plan must
   say whether the React version ships new latest-draft demo files, for example ones generated
   synthetically, or converted once offline, which is recommended. Shipping legacy files would
   trip T3.
3. **TCP/HTTP2 qlog** (`public/standalone_data/tcp`, `src/components/filemanager/pcapconverter/tcptoqlog.ts`,
   `qlog_tcp_tls_h2.ts`): no latest IETF draft covers TCP/TLS/HTTP2 events. If those
   visualizations must keep parity, the converter output needs a private event schema URI, for
   example `https://qvis-react.dev/112026/tcp` per main-14 §3.1 private URI rules, rather than an
   IETF URN. This needs a decision.
4. **zstd/brotli dependency weight.** Adding `fzstd` (about 8 KB) and a brotli decoder is
   recommended for `.sqlog.zst` (quiche writer) and qvis `.br` parity. Confirm that adding these
   dependencies is acceptable.
5. **Vantage-point inference.** Should inference for `unknown` (quinn, quic-go endpoint traces)
   run automatically or only on user request? qvis lets users swap perspectives manually in the
   sequence diagram.
