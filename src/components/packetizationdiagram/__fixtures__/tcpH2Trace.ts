// Hand-written TCP + TLS + HTTP/2 trace in the shape the ported tshark converter emits (parity/converters.md §8.6.1,
// §8.7, §9.4): private namespaces tcp:/tls:/http2:, sizes in RawInfo, `capture_frame_number`, client vantage point,
// `common_fields.protocol_type: "TCP_HTTP2"`. Dependency-free so the Playwright e2e test can import it too.
//
// Client view of one HTTP/2 GET over TLS:
// sent      seg#4  (32 + 517)  handshake record (5 + 512)
//           seg#8  (32 + 0)    pure ACK (not drawn)
//           seg#9  (32 + 189)  change-cipherspec (5 + 1), handshake (5 + 53), application (5 + 103 + 17):
//                              magic (24), SETTINGS (9 + 18), WINDOW_UPDATE (9 + 4), HEADERS stream 1 (9 + 30)
// received  seg#5  (32 + 1400)
//           seg#6  (32 + 1400)  handshake record (5 + 2000) spanning seg#5 and seg#6
//           seg#7  (32 + 331)   application record (5 + 1104 + 17) spanning seg#6 and seg#7:
//                              SETTINGS (9 + 18), SETTINGS ack (9 + 0), HEADERS stream 1 (9 + 50), DATA stream 1 (9 + 1000)
//           seg#10 (32 + 0)     pure ACK (not drawn)

export const TCP_SCHEMA_URI = "https://github.com/mjoras/qvis-react/112026/tcp";
export const TLS_SCHEMA_URI = "https://github.com/mjoras/qvis-react/112026/tls";
export const HTTP2_SCHEMA_URI = "https://github.com/mjoras/qvis-react/112026/http2";

type Json = Record<string, any>;

function tcp(time: number, dir: "sent" | "received", frameNr: number, payloadLength: number): Json {
    return {
        time,
        name: "tcp:packet_" + dir,
        data: {
            header: { sequence_number: frameNr * 1000, header_length: 32, packet_type: "1RTT", packet_number: frameNr },
            raw: { length: 32 + payloadLength, payload_length: payloadLength },
            capture_frame_number: frameNr,
        },
    };
}

function tls(
    time: number,
    dir: "sent" | "received",
    frameNr: number,
    contentType: string,
    payloadLength: number,
    trailerLength: number,
): Json {
    return {
        time,
        name: dir === "sent" ? "tls:record_created" : "tls:record_parsed",
        data: {
            header: { content_type: contentType, header_length: 5, trailer_length: trailerLength, packet_type: "1RTT" },
            raw: { length: 5 + payloadLength + trailerLength, payload_length: payloadLength },
            capture_frame_number: frameNr,
        },
    };
}

function h2(time: number, dir: "sent" | "received", streamId: number, frame: Json, payloadLength: number): Json {
    const headerLength = frame.frame_type === "magic" ? 0 : 9;
    return {
        time,
        name: dir === "sent" ? "http2:frame_created" : "http2:frame_parsed",
        data: {
            stream_id: streamId,
            frame: { ...frame, raw: { length: headerLength + payloadLength, payload_length: payloadLength } },
        },
    };
}

export const REQUEST_HEADERS = [
    { name: ":method", value: "GET" },
    { name: ":path", value: "/index.html" },
    { name: ":authority", value: "example.org" },
    { name: ":scheme", value: "https" },
];

/** The converter-shaped events, in converter order (per entry: TCP, then TLS records, then H2 frames). */
export function tcpH2Events(): Json[] {
    return [
        tcp(1, "sent", 4, 517),
        tls(1, "sent", 4, "handshake", 512, 0),

        tcp(2, "received", 5, 1400),
        tcp(2.5, "received", 6, 1400),
        tls(2.5, "received", 6, "handshake", 2000, 0),

        tcp(3, "sent", 8, 0),

        tcp(4, "sent", 9, 189),
        tls(4, "sent", 9, "change-cipherspec", 1, 0),
        tls(4, "sent", 9, "handshake", 53, 0),
        tls(4, "sent", 9, "application", 103, 17),
        h2(4, "sent", -1, { frame_type: "magic" }, 24),
        h2(4, "sent", 0, { frame_type: "settings" }, 18),
        h2(4, "sent", 0, { frame_type: "window_update" }, 4),
        h2(4, "sent", 1, { frame_type: "headers", headers: REQUEST_HEADERS, stream_end: true }, 30),

        tcp(5, "received", 7, 331),
        tls(5, "received", 7, "application", 1104, 17),
        h2(5, "received", 0, { frame_type: "settings" }, 18),
        h2(5, "received", 0, { frame_type: "settings" }, 0),
        h2(5, "received", 1, { frame_type: "headers", headers: [{ name: ":status", value: "200" }] }, 50),
        h2(5, "received", 1, { frame_type: "data", stream_end: true }, 1000),

        tcp(6, "received", 10, 0),
    ];
}

/** A complete contained qlog file (main-schema-14 shape) holding the trace. */
export function tcpH2QlogFile(events: Json[] = tcpH2Events()): Json {
    return {
        file_schema: "urn:ietf:params:qlog:file:contained",
        serialization_format: "application/qlog+json",
        title: "packetization TCP test",
        traces: [
            {
                title: "10.0.0.1:50000 -> 93.184.216.34:443 => example.org @ 17 TLS trailer size",
                vantage_point: { type: "client" },
                common_fields: {
                    protocol_type: "TCP_HTTP2",
                    time_format: "relative_to_epoch",
                    reference_time: { clock_type: "system", epoch: "1970-01-01T00:00:00.000Z" },
                },
                event_schemas: [TCP_SCHEMA_URI, TLS_SCHEMA_URI, HTTP2_SCHEMA_URI],
                events,
            },
        ],
    };
}
