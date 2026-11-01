# Developer documentation

| Document | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Code layout, store/router/model APIs, React and D3 conventions, testing contract |
| [`STATUS.md`](STATUS.md) | Per view: what works, intended differences from qvis, open items, security review |
| [`parity/*.md`](parity/) | Per tool: qvis behaviour reproduced by qvis-react (UI inventory, algorithms, edge cases, PRESERVE/FIX decisions) and the mapping of every consumed event and field to the latest qlog drafts. [`parity/_gaps.md`](parity/_gaps.md) records cross-spec decisions. |
| [`qlog-spec/*.md`](qlog-spec/) | Digests of draft-ietf-quic-qlog-main-schema-14, quic-events-13 and h3-events-13, plus a survey of what implementations emit |

These documents were written while porting. Paths of the form `ref/...` or `scratchpad/ref/...` refer to local
reference checkouts used at the time:

- `ref/qvis/` is [quiclog/qvis](https://github.com/quiclog/qvis) (the original; `visualizations/src/...` paths are
  relative to that repository),
- `ref/qlog-wg/` is the editor's copies in [quicwg/qlog](https://github.com/quicwg/qlog) (2026-11-01),
- `ref/drafts/` is the published `.txt` drafts from the IETF datatracker,
- `ref/qvis-server/` and `ref/pcap2qlog/` are [quiclog/qvis-server](https://github.com/quiclog/qvis-server) and
  [quiclog/pcap2qlog](https://github.com/quiclog/pcap2qlog).

Other `scratchpad/...` paths name throwaway verification scripts that are not part of this repository.
