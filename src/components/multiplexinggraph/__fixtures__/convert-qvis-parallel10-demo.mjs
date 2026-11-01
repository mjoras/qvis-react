// Usage: node src/components/multiplexinggraph/__fixtures__/convert-qvis-parallel10-demo.mjs \
//            <qvis>/visualizations/public/standalone_data/draft-01/parallel_10_50KB_f5.qlog \
//            tests/fixtures/latest/multiplexing-aioquic-parallel10-client.sqlog
// (then: node scripts/validate-qlog.mjs <file>)
// Offline conversion of qvis's demo public/standalone_data/draft-01/parallel_10_50KB_f5.qlog (aioquic client,
// qlog draft-01) to a strictly conforming latest-draft JSON-SEQ trace, reduced to what the multiplexing graph reads:
// quic:packet_sent / quic:packet_received (header + STREAM frames with raw.length) and http3:frame_created /
// http3:frame_parsed (HEADERS and DATA frames). Times are kept (relative ms to the draft-01 reference_time).
import fs from "node:fs";
const [, , src, out] = process.argv;
const d = JSON.parse(fs.readFileSync(src, "utf8"));
const t = d.traces[0];
const fields = t.event_fields;
const ix = (n) => fields.indexOf(n);
const refMs = Number(t.common_fields.reference_time);
const num = (v) => (v === undefined ? undefined : Number(v));
const header = {
    file_schema: "urn:ietf:params:qlog:file:sequential",
    serialization_format: "application/qlog+json-seq",
    title: "qvis demo parallel_10_50KB_f5 (converted)",
    description:
        "qvis standalone_data/draft-01/parallel_10_50KB_f5.qlog (aioquic 0.8.4 client, 10 x 50 KB in parallel) converted offline to the latest qlog drafts, reduced to packet STREAM frames and HTTP/3 HEADERS/DATA frames (multiplexing parity fixture)",
    trace: {
        title: "aioquic client (converted from qlog draft-01)",
        description: t.description,
        common_fields: {
            group_id: t.common_fields.ODCID,
            time_format: "relative_to_epoch",
            reference_time: { clock_type: "system", epoch: new Date(refMs).toISOString() },
        },
        vantage_point: { name: t.vantage_point.name, type: t.vantage_point.type },
        event_schemas: ["urn:ietf:params:qlog:events:quic-13", "urn:ietf:params:qlog:events:http3-13"],
    },
};
const outEvents = [];
for (const e of t.events) {
    const time = Number(e[ix("relative_time")]);
    const cat = e[ix("category")];
    const type = e[ix("event_type")];
    const data = e[ix("data")];
    if (cat === "transport" && (type === "packet_sent" || type === "packet_received")) {
        const h = { packet_type: data.packet_type };
        if (data.header?.packet_number !== undefined) h.packet_number = num(data.header.packet_number);
        const frames = (data.frames ?? [])
            .filter((f) => f.frame_type === "stream")
            .map((f) => {
                const o = { frame_type: "stream", stream_id: num(f.stream_id), offset: num(f.offset) };
                if (f.fin) o.fin = true;
                o.raw = { length: num(f.length) };
                return o;
            });
        const nd = { header: h };
        if (frames.length > 0) nd.frames = frames;
        if (data.header?.packet_size !== undefined) nd.raw = { length: num(data.header.packet_size) };
        outEvents.push({ time, name: "quic:" + type, data: nd });
    } else if (cat === "http" && (type === "frame_created" || type === "frame_parsed")) {
        const f = data.frame;
        let frame;
        if (f.frame_type === "headers")
            frame = { frame_type: "headers", headers: f.headers.map((x) => ({ name: x.name, value: x.value })) };
        else if (f.frame_type === "data") frame = { frame_type: "data" };
        else continue;
        if (data.byte_length !== undefined) frame.raw = { length: num(data.byte_length) };
        outEvents.push({ time, name: "http3:" + type, data: { stream_id: num(data.stream_id), frame } });
    }
}
fs.writeFileSync(out, [header, ...outEvents].map((o) => "\x1e" + JSON.stringify(o) + "\n").join(""));
console.log("wrote", out, outEvents.length, "events");
