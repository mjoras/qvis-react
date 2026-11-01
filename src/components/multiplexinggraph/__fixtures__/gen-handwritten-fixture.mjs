// Usage: node src/components/multiplexinggraph/__fixtures__/gen-handwritten-fixture.mjs tests/fixtures/latest/multiplexing-handwritten-client.sqlog
// (then: node scripts/validate-qlog.mjs <file>)
// Generates tests/fixtures/latest/multiplexing-handwritten-client.sqlog: a small, strictly conforming latest-draft client
// trace exercising every multiplexing feature quic-go does not log (stream_data_moved, priority header, PRIORITY_UPDATE)
// plus all arrival types (Normal, Future, Retransmit, Reordered, Duplicate).
import fs from "node:fs";
const out = process.argv[2];
const RS = "\x1e";
const header = {
    file_schema: "urn:ietf:params:qlog:file:sequential",
    serialization_format: "application/qlog+json-seq",
    title: "qvis-react multiplexing fixture",
    description:
        "Hand-written latest-draft HTTP/3 client trace for the multiplexing graph (moved data, priorities, arrival types)",
    trace: {
        title: "hand-written client",
        common_fields: {
            group_id: "4d75785f66697874",
            time_format: "relative_to_epoch",
            reference_time: { clock_type: "monotonic", epoch: "unknown" },
        },
        vantage_point: { name: "multiplexing fixture", type: "client" },
        event_schemas: ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"],
    },
};
const ev = [];
const e = (time, name, data) => ev.push({ time, name, data });
let spn = 0;
let rpn = 0;
const stream = (stream_id, offset, length, fin) => {
    const f = { frame_type: "stream", stream_id };
    if (offset !== undefined) f.offset = offset;
    if (fin) f.fin = true;
    f.raw = { length };
    return f;
};
const sent = (t, frames, pn = spn++) =>
    e(t, "quic:packet_sent", { header: { packet_type: "1RTT", packet_number: pn }, frames, raw: { length: 1252 } });
const recv = (t, frames, pn = rpn++) =>
    e(t, "quic:packet_received", {
        header: pn === null ? { packet_type: "1RTT" } : { packet_type: "1RTT", packet_number: pn },
        frames,
        raw: { length: 1252 },
    });
const moved = (t, stream_id, offset, length, extra = {}) =>
    e(t, "quic:stream_data_moved", {
        stream_id,
        offset,
        from: "transport",
        to: "application",
        raw: { length },
        ...extra,
    });
const fieldsFor = (path, extra) => [
    { name: ":method", value: "GET" },
    { name: ":scheme", value: "https" },
    { name: ":authority", value: "example.org" },
    { name: ":path", value: path },
    ...extra,
];

e(0, "quic:connection_started", {
    local: { ip_v4: "127.0.0.1", port_v4: 50000 },
    remote: { ip_v4: "127.0.0.1", port_v4: 443 },
});
e(9.5, "http3:frame_created", { stream_id: 2, frame: { frame_type: "settings", settings: [] } });
// PRIORITY_UPDATE for stream 8 before its HEADERS: "FRAME: u=1, i -> HEADER: u=3"
e(9.75, "http3:frame_created", {
    stream_id: 2,
    frame: { frame_type: "priority_update", stream_id: 8, priority_field_value: "u=1, i" },
});
e(10, "http3:frame_created", {
    stream_id: 0,
    frame: { frame_type: "headers", headers: fieldsFor("/index.html", [{ name: "priority", value: "u=0" }]) },
});
sent(10.25, [stream(2, 0, 12), stream(0, undefined, 40, true)]);
// name_bytes instead of name ("priority" in hex)
e(11, "http3:frame_created", {
    stream_id: 4,
    frame: {
        frame_type: "headers",
        headers: fieldsFor("/style.css", [{ name_bytes: "7072696f72697479", value: "u=2" }]),
    },
});
sent(11.25, [stream(4, undefined, 38, true)]);
e(12, "http3:frame_created", {
    stream_id: 8,
    frame: { frame_type: "headers", headers: fieldsFor("/app.js", [{ name: "priority", value: "u=3" }]) },
});
sent(12.25, [stream(8, undefined, 36, true)]);
// push-only PRIORITY_UPDATE: ignored by the waterfall
e(12.5, "http3:frame_created", {
    stream_id: 2,
    frame: { frame_type: "priority_update", push_id: 1, priority_field_value: "u=7" },
});

// responses (client receives data)
recv(40, [
    stream(3, 0, 10),
    stream(0, undefined, 1000),
    { frame_type: "max_stream_data", stream_id: 0, maximum: 65536 },
]);
moved(40.1, 0, 0, 1000);
recv(41, [stream(4, 0, 1000)]);
moved(41.1, 4, 0, 1000);
recv(42, [stream(8, 0, 1000)]);
recv(43, [stream(0, 2000, 1000)]); // Future: gap [1000, 2000]
recv(44, [stream(4, 1000, 1000)]);
recv(45, [stream(0, 1000, 1000)]); // Retransmit (fills the gap of 43, 2 ms; a stream's first fill is never Reordered)
moved(45.1, 0, 1000, 2000);
recv(46, [stream(8, 1000, 1000)]);
moved(46.1, 8, 0, 2000);
recv(50, [stream(4, 1000, 1000)]); // Duplicate
recv(60, [stream(8, 3000, 1000)]); // Future: gap [2000, 3000]
recv(100, [stream(8, 2000, 1000)]); // Retransmit (40 ms)
moved(100.1, 8, 2000, 2000);
recv(101, [stream(8, 5000, 1000)]); // Future: gap [4000, 5000]
recv(102, [stream(8, 4000, 1000)]); // Reordered (1 ms; avg 20.5)
moved(102.1, 8, 4000, 2000);
// no packet number logged: tooltip "packet number undefined"
recv(103, [stream(0, 3000, 500, true), stream(4, 2000, 500, true)], null);
moved(103.1, 0, 3000, 500);
moved(103.2, 4, 1000, 1500);
e(103.3, "quic:stream_data_moved", {
    stream_id: 0,
    offset: 3500,
    from: "transport",
    to: "application",
    additional_info: "fin_set",
});
e(103.4, "quic:stream_data_moved", { stream_id: 4, offset: 0, from: "transport", to: "network", raw: { length: 38 } });
// zero-length FIN-only frame: Duplicate
recv(104, [stream(8, 6000, 0, true)]);
e(104.5, "quic:packet_lost", { header: { packet_type: "1RTT", packet_number: 2 }, frames: [stream(8, 0, 36, true)] });
sent(105, [{ frame_type: "ack", acked_ranges: [[0, 14]] }]);
e(110, "quic:connection_closed", { initiator: "local", application_error: "http_no_error" });

fs.writeFileSync(out, [header, ...ev].map((o) => RS + JSON.stringify(o) + "\n").join(""));
console.log("wrote", out, ev.length, "events");
