#!/usr/bin/env python3
"""Generates the hand-built tshark `-T json` fixtures of the converters package.

tshark is not available in this environment, so these fixtures are written by hand following the layer structure of
real tshark output (see the qvis TCP demo wikipedia_Playstation.json.gz in this folder and converters spec 3.8):

  tls13-h2-duplicate-keys.json      what `tshark -T json -o tls.keylog_file:...` writes: repeated keys in one object
                                    ("tls", "tls.record", "http2.stream", "http2.header", "ip.addr", ...)
  tls13-h2-no-duplicate-keys.json   the same capture as `--no-duplicate-keys` writes it (repeats merged into arrays)
  udp-quic-only.json                a QUIC (UDP) capture: no TCP connection at all

Capture: a TLS 1.3 (AES-GCM, 17-byte trailer = 16-byte tag + inner content type) HTTP/2 GET of https://example.com/
over IPv4, plus a second (IPv6) connection that only sends a SYN, and a DNS packet that must be skipped.

Run: python3 tests/fixtures/tshark/make-fixtures.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


class D:
    """An ordered JSON object that may contain duplicate keys."""

    def __init__(self, *pairs):
        self.pairs = list(pairs)


def dump(v, merge, indent=0):
    pad = "  " * indent
    if isinstance(v, D):
        pairs = v.pairs
        if merge:  # --no-duplicate-keys: repeated keys become arrays
            merged = {}
            order = []
            for k, x in pairs:
                if k in merged:
                    if not isinstance(merged[k], list) or k not in multi:
                        merged[k] = [merged[k]]
                        multi.add(k)
                    merged[k].append(x)
                else:
                    merged[k] = x
                    order.append(k)
            pairs = [(k, merged[k]) for k in order]
            multi.clear()
        if not pairs:
            return "{}"
        inner = ",\n".join(pad + "  " + json.dumps(k) + ": " + dump(x, merge, indent + 1) for k, x in pairs)
        return "{\n" + inner + "\n" + pad + "}"
    if isinstance(v, list):
        if not v:
            return "[]"
        inner = ",\n".join(pad + "  " + dump(x, merge, indent + 1) for x in v)
        return "[\n" + inner + "\n" + pad + "]"
    return json.dumps(v)


multi = set()

CLIENT4, SERVER4 = "10.0.0.1", "93.184.216.34"
CLIENT6, SERVER6 = "2001:db8::1", "2001:db8::2"


def frame(n, t, protocols):
    return D(
        ("frame.time", "Nov 14, 2023 22:13:%09.6f000 UTC" % (20 + t)),
        ("frame.time_epoch", "1700000000.%09d" % round(t * 1e9)),
        ("frame.number", str(n)),
        ("frame.protocols", protocols),
    )


def ip4(src, dst):
    return D(("ip.version", "4"), ("ip.src", src), ("ip.addr", src), ("ip.dst", dst), ("ip.addr", dst))


def ip6(src, dst):
    return D(("ipv6.src", src), ("ipv6.addr", src), ("ipv6.dst", dst), ("ipv6.addr", dst))


def tcp(sport, dport, seq, ack, length, hdr, flags):
    names = ["fin", "syn", "reset", "push", "ack"]
    return D(
        ("tcp.srcport", str(sport)),
        ("tcp.dstport", str(dport)),
        ("tcp.port", str(sport)),
        ("tcp.port", str(dport)),
        ("tcp.len", str(length)),
        ("tcp.seq", str(seq)),
        ("tcp.ack", str(ack)),
        ("tcp.hdr_len", str(hdr)),
        ("tcp.flags_tree", D(*[("tcp.flags." + n, "1" if n in flags else "0") for n in names])),
        ("tcp.window_size", "64256"),
    )


def record(content_type, length, opaque=None, app_data=False, extra=()):
    pairs = []
    if opaque is not None:
        pairs.append(("tls.record.opaque_type", opaque))
    pairs += [("tls.record.version", "0x00000303"), ("tls.record.length", str(length))]
    if content_type is not None:
        pairs.append(("tls.record.content_type", content_type))
    if app_data:
        pairs.append(("tls.app_data", ":".join(["ab"] * length)))
    pairs += list(extra)
    return D(*pairs)


def h2(ftype, length, stream, flags="0x00", end_stream=None, headers=None):
    pairs = [("http2.length", str(length)), ("http2.type", str(ftype)), ("http2.flags", flags)]
    if end_stream is not None:
        pairs.append(("http2.flags_tree", D(("http2.flags.end_stream", end_stream))))
    pairs.append(("http2.streamid", str(stream)))
    for name, value in headers or []:
        pairs.append(
            (
                "http2.header",
                D(("http2.header.name", name), ("http2.header.value", value), ("http2.header.repr", "Literal")),
            )
        )
    return D(*pairs)


def stream(f):
    return ("http2.stream", f)


def packet(n, t, layers):
    return D(
        ("_index", "packets-2023-11-14"),
        ("_type", "doc"),
        ("_score", None),
        ("_source", D(("layers", D(*layers)))),
    )


C, S = (CLIENT4, 50000), (SERVER4, 443)


def to_server(seq, ack, length, hdr, flags):
    return [("ip", ip4(C[0], S[0])), ("tcp", tcp(C[1], S[1], seq, ack, length, hdr, flags))]


def to_client(seq, ack, length, hdr, flags):
    return [("ip", ip4(S[0], C[0])), ("tcp", tcp(S[1], C[1], seq, ack, length, hdr, flags))]


GET = [(":method", "GET"), (":authority", "example.com"), (":scheme", "https"), (":path", "/")]
RESP = [(":status", "200"), ("content-type", "text/html")]

packets = [
    packet(1, 0.0001, [("frame", frame(1, 0.0001, "eth:ethertype:ip:tcp"))] + to_server(0, 0, 0, 40, {"syn"})),
    packet(2, 0.0201, [("frame", frame(2, 0.0201, "eth:ethertype:ip:tcp"))] + to_client(0, 1, 0, 40, {"syn", "ack"})),
    packet(3, 0.0202, [("frame", frame(3, 0.0202, "eth:ethertype:ip:tcp"))] + to_server(1, 1, 0, 32, {"ack"})),
    # ClientHello
    packet(
        4,
        0.0203,
        [("frame", frame(4, 0.0203, "eth:ethertype:ip:tcp:tls"))]
        + to_server(1, 1, 517, 32, {"ack", "push"})
        + [("tls", D(("tls.record", record("22", 512, extra=[("tls.handshake", D(("tls.handshake.type", "1")))]))))],
    ),
    # ServerHello + ChangeCipherSpec + encrypted handshake (decrypted inner type 22)
    packet(
        5,
        0.0400,
        [("frame", frame(5, 0.0400, "eth:ethertype:ip:tcp:tls"))]
        + to_client(1, 518, 5 + 122 + 5 + 1 + 5 + 1000, 32, {"ack", "push"})
        + [
            (
                "tls",
                D(
                    ("tls.record", record("22", 122, extra=[("tls.handshake", D(("tls.handshake.type", "2")))])),
                    ("tls.record", record("20", 1, extra=[("tls.change_cipher_spec", "")])),
                    ("tls.record", record("22", 1000, opaque="23", extra=[("tls.handshake", D(("tls.handshake.type", "8")))])),
                ),
            )
        ],
    ),
    # client CCS + Finished + application record with the connection preface, SETTINGS, WINDOW_UPDATE, HEADERS
    packet(
        6,
        0.0410,
        [("frame", frame(6, 0.0410, "eth:ethertype:ip:tcp:tls:http2"))]
        + to_server(518, 1139, 6 + 58 + 125, 32, {"ack", "push"})
        + [
            ("tls", D(("tls.record", record("20", 1, extra=[("tls.change_cipher_spec", "")])))),
            ("tls", D(("tls.record", record("22", 53, opaque="23", extra=[("tls.handshake", D(("tls.handshake.type", "20")))])))),
            ("tls", D(("tls.record", record("23", 120, opaque="23", app_data=True)))),
            (
                "http2",
                D(
                    stream(D(("http2.magic", "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"))),
                    stream(h2(4, 18, 0)),
                    stream(h2(8, 4, 0)),
                    stream(h2(1, 30, 1, "0x05", "1", GET)),
                ),
            ),
        ],
    ),
    # server SETTINGS alone in one record: 44 - (18 + 9) = 17 -> trailer estimate
    packet(
        7,
        0.0600,
        [("frame", frame(7, 0.0600, "eth:ethertype:ip:tcp:tls:http2"))]
        + to_client(1139, 707, 49, 32, {"ack", "push"})
        + [("tls", D(("tls.record", record("23", 44, opaque="23", app_data=True)))), ("http2", D(stream(h2(4, 18, 0))))],
    ),
    # server HEADERS + DATA (END_STREAM) in one record
    packet(
        8,
        0.0610,
        [("frame", frame(8, 0.0610, "eth:ethertype:ip:tcp:tls:http2"))]
        + to_client(1188, 707, 160, 32, {"ack", "push"})
        + [
            ("tls", D(("tls.record", record("23", 155, opaque="23", app_data=True)))),
            (
                "http2",
                D(stream(h2(1, 20, 1, "0x04", "0", RESP)), stream(h2(0, 100, 1, "0x01", "1"))),
            ),
        ],
    ),
    packet(9, 0.0615, [("frame", frame(9, 0.0615, "eth:ethertype:ip:tcp"))] + to_server(707, 1348, 0, 32, {"ack"})),
    # client SETTINGS ACK: 26 - (0 + 9) = 17, consistent with the estimate
    packet(
        10,
        0.0620,
        [("frame", frame(10, 0.0620, "eth:ethertype:ip:tcp:tls:http2"))]
        + to_server(707, 1348, 31, 32, {"ack", "push"})
        + [("tls", D(("tls.record", record("23", 26, opaque="23", app_data=True)))), ("http2", D(stream(h2(4, 0, 0, "0x01"))))],
    ),
    # a second connection over IPv6 that only sends a SYN
    packet(
        11,
        0.0700,
        [
            ("frame", frame(11, 0.0700, "eth:ethertype:ipv6:tcp")),
            ("ipv6", ip6(CLIENT6, SERVER6)),
            ("tcp", tcp(50001, 443, 0, 0, 0, 40, {"syn"})),
        ],
    ),
    # DNS: no TCP layer, skipped
    packet(
        12,
        0.0710,
        [
            ("frame", frame(12, 0.0710, "eth:ethertype:ip:udp:dns")),
            ("ip", ip4(CLIENT4, "10.0.0.53")),
            ("udp", D(("udp.srcport", "53000"), ("udp.dstport", "53"))),
            ("dns", D(("dns.id", "0x1234"))),
        ],
    ),
]

quic_only = [
    packet(
        1,
        0.001,
        [
            ("frame", frame(1, 0.001, "eth:ethertype:ip:udp:quic")),
            ("ip", ip4(CLIENT4, SERVER4)),
            ("udp", D(("udp.srcport", "50000"), ("udp.dstport", "443"), ("udp.length", "1208"))),
            ("quic", D(("quic.header_form", "1"), ("quic.long.packet_type", "0"), ("quic.packet_length", "1200"))),
        ],
    ),
    packet(
        2,
        0.021,
        [
            ("frame", frame(2, 0.021, "eth:ethertype:ip:udp:quic")),
            ("ip", ip4(SERVER4, CLIENT4)),
            ("udp", D(("udp.srcport", "443"), ("udp.dstport", "50000"), ("udp.length", "1208"))),
            ("quic", D(("quic.header_form", "1"), ("quic.long.packet_type", "0"), ("quic.packet_length", "1200"))),
        ],
    ),
]

for name, data, merge in [
    ("tls13-h2-duplicate-keys.json", packets, False),
    ("tls13-h2-no-duplicate-keys.json", packets, True),
    ("udp-quic-only.json", quic_only, True),
]:
    with open(os.path.join(HERE, name), "w") as f:
        f.write(dump(data, merge) + "\n")
    print("wrote", name)
