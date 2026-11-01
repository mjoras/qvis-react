# qvis-react

Tools and visualizations for QUIC and HTTP/3, built on [qlog](https://datatracker.ietf.org/wg/qlog/about/).

qvis-react is a React + TypeScript + D3 rewrite of [qvis](https://github.com/quiclog/qvis) by Robin Marx et al.
It is meant as a drop-in replacement: the same five tools, layouts, colours, interactions and URL parameters. The
difference is the input format. qvis-react reads **only the latest qlog drafts**, which are in the final phase of
standardization:

- [draft-ietf-quic-qlog-main-schema-14](https://datatracker.ietf.org/doc/draft-ietf-quic-qlog-main-schema/14/)
- [draft-ietf-quic-qlog-quic-events-13](https://datatracker.ietf.org/doc/draft-ietf-quic-qlog-quic-events/13/)
- [draft-ietf-quic-qlog-h3-events-13](https://datatracker.ietf.org/doc/draft-ietf-quic-qlog-h3-events/13/)

## Tools

| Route             | Tool                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `#/files`         | File manager: upload files, load files by URL, load the demo files, download loaded files                |
| `#/sequence`      | Sequence diagram: packets and frames between client and server over time                                 |
| `#/congestion`    | Congestion graph: data sent/acked/lost, congestion window, bytes in flight, flow control limits, RTT     |
| `#/multiplexing`  | Multiplexing graph: how HTTP/3 streams share the connection, waterfall and byte ranges                   |
| `#/packetization` | Packetization diagram: how HTTP/3 frames map onto QUIC frames and packets (and TLS/TCP for tshark input) |
| `#/stats`         | qlog statistics: file and trace info, event histogram, frames, flow control, HTTP/3 settings             |

## Supported input

| Input                                              | Notes                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.qlog`                                            | `QlogFile`: `file_schema` `urn:ietf:params:qlog:file:contained`, `serialization_format` `application/qlog+json`                                        |
| `.sqlog`                                           | `QlogFileSeq`: `file_schema` `urn:ietf:params:qlog:file:sequential`, `serialization_format` `application/qlog+json-seq` (RFC 7464 JSON text sequences) |
| `.netlog` / `.json` (Chrome net-export)            | Converted in the browser to latest-draft qlog (`quic:*`, `http3:*`)                                                                                    |
| tshark JSON (`tshark -T json`, TCP + TLS + HTTP/2) | Converted in the browser; the TCP stack uses the private namespaces `tcp:`, `tls:` and `http2:` (main-schema §8)                                       |
| `.gz`                                              | Decompressed in the browser                                                                                                                            |

Event names must be the ones defined by quic-events-13 and h3-events-13 (`quic:packet_sent`,
`quic:recovery_metrics_updated`, `http3:frame_created`, ...). qvis-react does not rename or alias pre-final names:

- Files in an old qlog format (`qlog_version` draft-00 to draft-02, 0.3, 0.4, without `file_schema`) are rejected with
  a message.
- Files with the new header but pre-final event names (for example `transport:packet_sent` or
  `recovery:metrics_updated`, as several implementations still write) load, with a warning listing those names. The
  visualizations do not interpret those events.
- pcap/pcapng captures are not supported, because decrypting them needs tshark on a server. Set
  `VITE_PCAP_BACKEND_URL` to a [qvis-server](https://github.com/quiclog/qvis-server)-compatible backend if you have
  one that emits latest-draft qlog.

Truncated files (a crashed or still-running endpoint) are repaired where possible, as in qvis.

## Loading files by URL

The same URL shapes as qvis work:

- `https://<host>/#/files?file=<url>`, also `https://<host>/?file=<url>` and `https://<host>/?file=<url>#/sequence`
- `?list=<url>`: a JSON list of files (pcap2qlog list format)
- `?file1=<url>&file2=<url>...`
- Sequence diagram: `focusOnConnection`, `focusOnEvent`, `focusOnPN`, `forceFull`
- Multiplexing graph: `multimultiplexing` shows "Load all connections at once"

The browser fetches the URL directly. If that fails (for example because the server sends no CORS headers), it
retries through the deployment's own proxy, `/api/loadfiles?file=<url>`, a Vercel Function. The proxy only fetches
public `http(s)` URLs and limits the response size.

Limits that qvis did not have (security review): one `?list=` or `?file1..N=` link loads at most 100 files, at most 6
at a time, and a compressed file may inflate to at most 512 MiB in the browser.

## Demo files

Option 3 ("Load example .qlog files") and Option 4 (the massive demo file) on `#/files` load the files in [`public/examples/`](public/examples/).
They were generated with [quic-go](https://github.com/quic-go/quic-go) v0.64.1 patched to write strictly conforming
latest-draft qlog (HTTP/3 included), and validated against the CDDL of the drafts. See
[`tools/qloggen/`](tools/qloggen/README.md) to regenerate them, and [`scripts/cddl/`](scripts/cddl/README.md) for the
validator (`node scripts/validate-qlog.mjs <file>`).

`scripts/latest-to-legacy.mjs` converts latest-draft files to draft-02, which the original qvis renders. We use it to
compare both tools on the same connection.

## Development

Requires Node 20 or newer.

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (Vitest)
npm run e2e          # browser smoke tests (Playwright; run `npx playwright install chromium` once)
npm run typecheck
npm run lint
npm run build        # static site in dist/
```

The design and the parity notes are in [`docs/dev/`](docs/dev/): `ARCHITECTURE.md` describes the code layout, and
`parity/*.md` describe, per tool, the qvis behaviour that qvis-react reproduces and how each input maps onto the latest
drafts.

## Deploying

The repository deploys to [Vercel](https://vercel.com) as is: a static Vite build plus the `api/loadfiles` function
(see `vercel.json`, which also maps qvis-server's `/loadfiles` path onto it). Any static host works for the app itself
(the build uses relative paths, so it also works from a subdirectory); without the function, files on servers without
CORS headers cannot be loaded by URL.

`vercel.json` also sends a Content-Security-Policy for the app (scripts only from the app's own origin, no plugins,
`base-uri` and `form-action` locked to the origin). Do not add inline `<script>` elements or inline event handlers:
production blocks them, while the dev server (no CSP) still runs them.

The proxy (`api/loadfiles.ts`) is meant for the app itself, not as a public CORS proxy:

- Browsers may use it only from the app's own origin (`Sec-Fetch-Site: same-origin`, or a matching `Origin`).
  Requests from other sites get 403, and so do navigations and image, script or frame loads (`Sec-Fetch-Dest` other
  than `empty`). Requests carrying the proxy's own User-Agent (nested proxy URLs) get 508, and the Fetch standard's
  bad ports (SMTP, IRC, SIP, ...) get 400.
- The function has no rate limit of its own: scripts outside a browser can still use it as a GET proxy (up to the size
  cap and 60 s per request). Add a rate-limit rule for `/api/loadfiles` in the Vercel Firewall of a public deployment.

Environment variables (all optional):

| Variable                                           | Effect                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QVIS_PROXY_MAX_BYTES`                             | response size cap in bytes (default 128 MB, counted after decoding)                                                                                                |
| `QVIS_PROXY_ALLOW_HOSTS` / `QVIS_PROXY_DENY_HOSTS` | comma-separated target host names, or `.suffix` entries                                                                                                            |
| `QVIS_PROXY_ALLOW_ORIGINS`                         | browser origins besides the app's own that may use the proxy (comma-separated, `*` = any); only needed when another deployment's `VITE_QVIS_PROXY_URL` points here |
| `VITE_QVIS_PROXY_URL` (build time)                 | proxy the app uses instead of its own `/api/loadfiles`                                                                                                             |
| `VITE_PCAP_BACKEND_URL` (build time)               | qvis-server-compatible backend for pcap/pcapng URLs                                                                                                                |

## Credits and license

qvis was created by [Robin Marx](https://github.com/rmarx) and contributors at Hasselt University (EDM). qvis-react
ports its visualizations and keeps its behaviour. MIT licensed, see [LICENSE](LICENSE).
