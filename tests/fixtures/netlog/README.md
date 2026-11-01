# Chrome netlog fixtures (converters package)

| File | Origin |
| --- | --- |
| `mini.netlog`, `mini.expected.json` | Synthetic fixture and expected output of the converters spec, sections 8.9.1 and 8.9.2 (verbatim). |
| `cloudflare-quic.netlog` | Real netlog: Playwright chromium (HeadlessChrome 156) with `--log-net-log --net-log-capture-mode=Everything --enable-quic --origin-to-force-quic-on=cloudflare-quic.com:443`, loading https://cloudflare-quic.com/. One QUIC session. |
| `multi-session.netlog.gz` | Same setup, loading https://cloudflare-quic.com/ and https://www.google.com/. Three QUIC sessions. |

The real netlogs were reduced and scrubbed: only the constants the converter reads are kept (`activeFieldTrialGroups` stays first for the content sniff), all QUIC_SESSION events plus the first 40/100 events of other sources (without params), `bytes` params removed, `self_address` replaced by 192.0.2.10, `source_dependency` removed, and the values of `cookie`, `set-cookie`, `authorization`, `proxy-authorization`, `x-client-data` and `x-goog-*` headers replaced by Chrome's own elision text `[N bytes were stripped]`.
