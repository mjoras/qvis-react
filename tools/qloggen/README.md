# qloggen: demo qlog generator

`qloggen` generates the example qlog files of qvis-react: `public/examples/` and some of
`tests/fixtures/latest/`. It runs an HTTP/3 client and an HTTP/3 server, both
[quic-go](https://github.com/quic-go/quic-go), in one process. They talk through an emulated network path.
Each endpoint writes a qlog trace.

quic-go v0.64.1 does not log the latest qlog drafts. Its output mixes pre-final event names such as
`transport:packet_sent` and `recovery:metrics_updated` with legacy header fields such as `qlog_version: "0.3"`.
qvis-react only reads the latest drafts, so qloggen is built against quic-go v0.64.1 with
`quic-go-v0.64.1-qlog-latest.patch` applied. With the patch, quic-go writes qlog that strictly conforms to:

- draft-ietf-quic-qlog-main-schema-14
- draft-ietf-quic-qlog-quic-events-13
- draft-ietf-quic-qlog-h3-events-13

Every generated file is checked with `scripts/validate-qlog.mjs`, which validates against the CDDL of these drafts.

## Files

| File | What it is |
| --- | --- |
| `main.go` | The generator: HTTP/3 server and client, emulated network path, qlog file output. |
| `go.mod`, `go.sum` | Go module. `go.mod` replaces `github.com/quic-go/quic-go` with `./quic-go`, the patched checkout. |
| `quic-go-v0.64.1-qlog-latest.patch` | The quic-go patch, a `git diff` against the `v0.64.1` tag. |
| `scenarios.json` | The demo scenarios: qloggen arguments, titles, descriptions, output folder. |
| `generate.sh` | Regenerates every scenario, validates the files, writes the manifests, and copies the fixtures. |
| `make-index.mjs` | Writes `public/examples/index.json` and `public/examples/massive/index.json`. |
| `quic-go/` (not committed) | quic-go v0.64.1 with the patch applied. `generate.sh` creates it. |

## Regenerating the demo files

Requirements:

- Go 1.26 or newer.
- git.
- Node 22 or newer.
- The Rust `cddl` CLI 0.10.7, for validation. See `scripts/cddl/README.md`.

```sh
export CDDL_BIN=~/.local/cddl/bin/cddl   # or put cddl on PATH
tools/qloggen/generate.sh                # all scenarios, about a minute
tools/qloggen/generate.sh new_cid        # only some scenarios (the other files must exist)
```

`generate.sh` runs these steps:

1. If `tools/qloggen/quic-go` doesn't exist, it clones quic-go `v0.64.1` there and runs `git apply` with the
   patch. If the directory exists, it checks that exactly this patch is applied.
2. It builds `qloggen` into `tools/qloggen/.build/` (git-ignored). The build uses a copy of `go.mod` whose replace
   directive points to the checkout, and sets the quic-go version string to `v0.64.1+qlog-latest`. That string
   appears in each trace's `vantage_point.name`.
3. It runs every scenario of `scenarios.json`. Each run writes `<id>_client.sqlog` and `<id>_server.sqlog`. Then
   `scripts/sqlog-to-qlog.mjs` merges the two into `<id>.qlog`, a contained JSON `QlogFile` with both traces.
   A failed run is retried up to two times.
4. It validates every file with `scripts/validate-qlog.mjs`. `--no-validate` skips this step.
5. It writes the manifests. Then it copies the scenarios marked `fixture` to `tests/fixtures/latest/`.
   `--no-fixtures` skips the copy.

To build against another patched checkout, set `QUIC_GO_DIR=/path/to/quic-go`. A symlink at `tools/qloggen/quic-go`
also works.

### Applying the patch by hand

```sh
git clone --branch v0.64.1 https://github.com/quic-go/quic-go.git tools/qloggen/quic-go
git -C tools/qloggen/quic-go apply ../quic-go-v0.64.1-qlog-latest.patch
(cd tools/qloggen/quic-go && go test ./...)    # the patch updates quic-go's tests too
cd tools/qloggen
go build -ldflags "-X github.com/quic-go/quic-go/qlogwriter.quicGoVersion=v0.64.1+qlog-latest" -o .build/qloggen .
.build/qloggen -out /tmp/qlogs -name test -n 3 -size 100KB -loss 0.02 -bw 10Mbit
```

To update the patch after changing the checkout:

```sh
git -C tools/qloggen/quic-go add -N .          # include new files, if any
git -C tools/qloggen/quic-go diff v0.64.1 > tools/qloggen/quic-go-v0.64.1-qlog-latest.patch
```

## What the patch changes in quic-go

The patch touches the `qlog`, `qlogwriter` and `http3/qlog` packages, and the places in quic-go that record events.

- **Header.** It writes `QlogFileSeq` exactly as main-schema-14 defines it: `file_schema`, `serialization_format`,
  `title`, `description` and `trace`. It drops the legacy `qlog_version`, `qlog_format` and `code_version`
  fields. The `event_schemas` are `urn:ietf:params:qlog:events:quic-13`, `...:http3-13` and `...:loglevel`.
- **Time.** `reference_time` is `{clock_type: "system", epoch: <trace start as RFC 3339, millisecond precision>}`
  with `time_format: "relative_to_epoch"`. Event times are measured with Go's monotonic clock from that epoch. The
  epoch is real, so the client and server traces of one connection can be aligned.
- **Event names.** quic-events-13 and h3-events-13 names replace the pre-final `transport:*`, `recovery:*` and
  `security:*` names. Examples:
  - `quic:packet_sent`, `quic:recovery_metrics_updated`, `quic:timer_updated`, `quic:key_updated`.
  - `http3:frame_created`, `http3:frame_parsed`, `http3:stream_type_set`, `http3:parameters_set`.
  - Events without a draft definition become `loglevel:*`.
- **Event data.**
  - Packet headers, frames and `raw` (`length`, `payload_length`) follow the CDDL. STREAM and CRYPTO data lengths
    are in `raw`.
  - `datagram_id` marks coalesced packets.
  - Error codes and triggers use the draft's enumerations.
  - HTTP/3 HEADERS, DATA and SETTINGS frames carry their fields and `raw` lengths.
- **New events.**
  - `quic:connection_id_updated`: `initiator: "remote"` when the endpoint switches the Destination Connection ID it
    sends with. This happens during the handshake, after a Retry, and on rotation to a NEW_CONNECTION_ID.
    `initiator: "local"` when the peer starts using another of the endpoint's connection IDs.
  - `quic:stream_data_moved`: one event per stream `Read` by the application, with `from: "transport"` and
    `to: "application"`. It carries the offset and `raw.length`, plus `additional_info: "fin_set"` or
    `"stream_reset"` when the end of the stream reaches the application.

## Scenarios

Every scenario is one HTTP/3 connection. `GET /file-<n>.bin` requests send `priority: u=3, i`. Responses carry
`content-length`. All scenarios use the default `-seed 1`.

The sizes below are from the committed generation.

| Scenario | qloggen arguments | Files (size) |
| --- | --- | --- |
| `new_cid`: CID updates; the qvis `new_cid` demo | `-n 1 -size 20KB -rtt 30ms` | `.qlog` 50 KB, client 23 KB, server 25 KB |
| `10_parallel_streams`: 10 × 50 KB, 5% loss; qvis `parallel_10_50KB_f5` | `-n 10 -size 50KB -loss 0.05 -rtt 40ms` | `.qlog` 584 KB, client 254 KB, server 309 KB |
| `doublevantage_100ms`: both vantage points in one file | `-n 1 -size 1MB -rtt 100ms -bw 20Mbit -loss 0.01` | `.qlog` 1.16 MB, client 463 KB, server 653 KB |
| `multistream_loss`: congestion control, slow start overshoot, recovery | `-n 6 -size 300KB -loss 0.02 -bw 4Mbit -rtt 50ms` | `.qlog` 2.08 MB, client 871 KB, server 1.14 MB |
| `baseline`: one 1 MB download, no loss | `-n 1 -size 1MB -rtt 40ms` | `.qlog` 963 KB, client 386 KB, server 544 KB |
| `massive` (in `massive/`): 50 MB download for performance tests | `-n 1 -size 50MB -rtt 20ms -bw 100Mbit` | server 29.6 MB, client 23.2 MB |

The manifests follow `src/loading/demo.ts`. Each is a JSON array of `{file, title, description, size}`, with
`file` relative to the manifest's folder and `size` in bytes.

- `public/examples/index.json` lists the merged `.qlog` of the five small scenarios. "Load example .qlog files"
  loads every entry.
- `public/examples/massive/index.json` lists `massive_server.sqlog`, which the massive demo button loads. `massive_client.sqlog` is generated too but is not committed (git-ignored, 23 MB).

Entries also have informational members that the app ignores: `id`, `traces`, `events`, `duration_ms`, the
qloggen command line in `scenario`, and the single-endpoint `.sqlog` files in `variants`.

`10_parallel_streams` keeps the name under which qvis showed its parallel demo (`DEMO_10_parallel_streams.qlog`).
The packetization diagram's help text refers to that name (see `docs/dev/parity/_gaps.md` G4).

The `tests/fixtures/latest/` copies are the `new_cid`, `10_parallel_streams` and `baseline` files.

## The emulated network

The client sends to a UDP proxy. The proxy forwards every datagram through a link, one link per direction:

1. **Random loss** with probability `-loss` (or `-loss-up` and `-loss-down`), drawn from a PRNG seeded with `-seed`.
2. **A bottleneck** if `-bw` is set: a FIFO queue drained at `-bw` bits per second. It drops packets when the
   queued bytes would exceed `-queue`, which defaults to one bandwidth-delay product and is at least 16 KB.
   This produces slow start overshoot, queueing delay (a growing RTT) and congestion losses.
3. **A delay** of `-rtt / 2`.

Packets are delivered in order. Every client address gets its own upstream socket, like a NAT. A client that
migrates (`-migrate`) therefore appears at the server with a new address.

Once all responses are received, random loss stops, so both endpoints log a clean `connection_closed`.
`-loss-during-close` keeps the loss.

Other options:

- `-sequential` and `-stagger`: request timing.
- `-priority`: the priority header value.
- `-cid-len`: connection ID length; the default is 8.
- `-migrate <delay>`: client migration with PATH_CHALLENGE and PATH_RESPONSE. quic-go keeps using the old
  connection ID on the new path and logs no `quic:tuple_assigned` events, so no scenario uses this option.

Run `.build/qloggen -h` for all flags.

### Reproducibility

The loss decisions are seeded, so a scenario drops nearly the same packets on every run. Some things still differ
between runs: timing, connection IDs, keys, ports and the exact interleaving of packets. Two generations of a
scenario are therefore similar but not byte-identical. Event counts and file sizes vary by a few percent.

## Notes on the traces

- quic-go closes HTTP/3 connections with application error code 0. The QUIC layer doesn't know the HTTP/3 error
  names, so `quic:connection_closed` logs `application_error: "unknown"` with `error_code: 0`.
- The `loglevel` event schema is listed even when a trace has no `loglevel:*` events. qvis-react reports that as
  info-level `schema.unused`.
- The HTTP/3 layer reads frame headers byte by byte, so `quic:stream_data_moved` shows many 1-byte moves between
  the larger DATA payload reads.
