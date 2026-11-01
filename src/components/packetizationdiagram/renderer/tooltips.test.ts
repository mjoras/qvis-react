import type { PacketizationRange } from "./PacketizationDiagramModels";
import { FILLER_FRAME_TYPE } from "./quicFrameSizes";
import {
    esc,
    http2RangeToString,
    http2StreamRangeToString,
    httpFrameRangeToString,
    quicFrameRangeToString,
    quicRangeToString,
    streamRangeToString,
    tcpRangeToString,
    tlsRangeToString,
    type HTTPStreamInfoMap,
} from "./tooltips";

function range(r: Partial<PacketizationRange>): PacketizationRange {
    return { start: 0, size: 0, isPayload: false, index: 0, lowerLayerIndex: -1, color: "black", ...r };
}

const info: HTTPStreamInfoMap = new Map([
    [
        0,
        {
            headers: [
                { name: ":method", value: "GET" },
                { name: ":path", value: "/index.html" },
            ],
            total_size: 2623,
        },
    ],
]);

describe("QUIC + HTTP/3 tooltips (byte-exact)", () => {
    it("packets lane: header, payload, trailer", () => {
        const rawPacket = { header: { packet_type: "1RTT", packet_number: 5 } };
        expect(quicRangeToString(range({ size: 12, contentType: "1RTT", rawPacket }))).toBe(
            "QUIC Header #0 : size 12<br/>Packet type : 1RTT, Packet nr : 5<br/>",
        );
        expect(quicRangeToString(range({ size: 1224, isPayload: true, contentType: "1RTT", rawPacket }))).toBe(
            "QUIC Payload #0 : size 1224<br/>Packet type : 1RTT, Packet nr : 5<br/>",
        );
        expect(quicRangeToString(range({ size: 16, index: 3, contentType: "1RTT", rawPacket }))).toBe(
            "QUIC Trailer (authentication tag) #3 : size 16<br/>Packet type : 1RTT, Packet nr : 5<br/>",
        );
    });

    it("packets lane: missing packet number prints undefined", () => {
        expect(
            quicRangeToString(
                range({ size: 4, contentType: "retry", rawPacket: { header: { packet_type: "retry" } } }),
            ),
        ).toBe("QUIC Header #0 : size 4<br/>Packet type : retry, Packet nr : undefined<br/>");
    });

    it("frames lane: frame, filler, FIN bit", () => {
        expect(
            quicFrameRangeToString(
                range({
                    size: 1200,
                    index: 1,
                    isPayload: true,
                    contentType: "stream",
                    rawPacket: { stream_id: 0, fin: true },
                }),
            ),
        ).toBe("QUIC Frame #1 : size 1200<br/>Frame type : stream, stream ID: 0<br/><b>FIN BIT SET</b>");
        expect(quicFrameRangeToString(range({ size: 11, contentType: "ack", rawPacket: { frame_type: "ack" } }))).toBe(
            "QUIC Frame #0 : size 11<br/>Frame type : ack, stream ID: none<br/>",
        );
        expect(
            quicFrameRangeToString(
                range({
                    size: 12,
                    index: -1,
                    contentType: FILLER_FRAME_TYPE,
                    rawPacket: { frame_type: FILLER_FRAME_TYPE },
                }),
            ),
        ).toBe(
            "QUIC Frame #-1 : size 12<br/>Frame type : qvis-injected FILLER (deal with incorrectly guesstimated frame size), stream ID: none<br/>",
        );
    });

    it("HTTP/3 lane with STREAMINFO", () => {
        const rawPacket = { stream_id: 0, frame: { frame_type: "headers" } };
        expect(
            httpFrameRangeToString(
                range({ size: 2, index: 0, lowerLayerIndex: 0, extra: { frame_length: 38 }, rawPacket }),
                info,
            ),
        ).toBe(
            "H3 Header #0 (QUIC frame index: 0) : frame size 38, partial size : 2<br/>frame type: headers, streamID: 0<br/>GET: /index.html<br/>total resource size: 2623<br/>",
        );
        expect(
            httpFrameRangeToString(
                range({
                    size: 36,
                    isPayload: true,
                    lowerLayerIndex: 1,
                    extra: { frame_length: 38 },
                    rawPacket: { stream_id: 3, frame: { frame_type: "settings" } },
                }),
                info,
            ),
        ).toBe(
            "H3 Payload #0 (QUIC frame index: 1) : frame size 38, partial size : 36<br/>frame type: settings, streamID: 3",
        );
    });

    it("stream lane", () => {
        expect(streamRangeToString(range({ rawPacket: { stream_id: "0" } }), info)).toBe(
            "H3 streamID: 0<br/>GET: /index.html<br/>total resource size: 2623<br/>",
        );
        expect(streamRangeToString(range({ rawPacket: { stream_id: 2 } }), info)).toBe("H3 streamID: 2");
    });

    it("Q-H8: last :method / :path wins; missing ones print empty; name_bytes / value_bytes are decoded", () => {
        const m: HTTPStreamInfoMap = new Map([
            [
                4,
                {
                    headers: [
                        { name: ":path", value: "/a" },
                        { name_bytes: "3a70617468", value_bytes: "2f62" },
                    ],
                    total_size: 0,
                },
            ],
        ]);
        expect(streamRangeToString(range({ rawPacket: { stream_id: 4 } }), m)).toBe(
            "H3 streamID: 4<br/>: /b<br/>total resource size: 0<br/>",
        );
    });

    it("Q-X1: interpolated values are HTML-escaped", () => {
        const m: HTTPStreamInfoMap = new Map([
            [
                0,
                {
                    headers: [
                        { name: ":method", value: "GET" },
                        { name: ":path", value: "<img src=x onerror=alert(1)>" },
                    ],
                    total_size: 0,
                },
            ],
        ]);
        const html = streamRangeToString(range({ rawPacket: { stream_id: 0 } }), m);
        expect(html).toBe("H3 streamID: 0<br/>GET: &lt;img src=x onerror=alert(1)&gt;<br/>total resource size: 0<br/>");
        const div = document.createElement("div");
        div.innerHTML = html;
        expect(div.querySelector("img")).toBeNull();
        expect(div.textContent).toContain("<img src=x onerror=alert(1)>");
        expect(esc(`a&b"'`)).toBe("a&amp;b&quot;&#39;");
        expect(
            quicFrameRangeToString(range({ size: 1, contentType: "<b>x</b>", rawPacket: { stream_id: "<i>" } })),
        ).toBe("QUIC Frame #0 : size 1<br/>Frame type : &lt;b&gt;x&lt;/b&gt;, stream ID: &lt;i&gt;<br/>");
    });
});

describe("TCP + TLS + HTTP/2 tooltips (byte-exact)", () => {
    it("TCP", () => {
        expect(tcpRangeToString(range({ size: 32 }))).toBe("TCP Header #0 : packet size 32<br/>");
        expect(tcpRangeToString(range({ size: 1400, index: 2, isPayload: true }))).toBe(
            "TCP Payload #2 : packet size 1400<br/>",
        );
    });

    it("TLS: header, payload, trailer (Q-T2: small trailer pieces read 'Header #')", () => {
        const extra = { DEBUG_wiresharkFrameNumber: 9, record_length: 125, payload_length: 103 };
        expect(
            tlsRangeToString(range({ size: 5, index: 3, lowerLayerIndex: 1, contentType: "application", extra })),
        ).toBe(
            "TLS Header #3 (TCP index: 1) : record size 125, partial size 5<br/>Wireshark frame number (DEBUG): 9<br/>content type: application",
        );
        expect(
            tlsRangeToString(range({ size: 17, index: 3, lowerLayerIndex: 1, contentType: "application", extra })),
        ).toBe(
            "TLS Trailer (MAC/auth tag/padding/content type) 3 (TCP index: 1) : record size 125, partial size 17<br/>Wireshark frame number (DEBUG): 9<br/>content type: application",
        );
        expect(
            tlsRangeToString(
                range({
                    size: 103,
                    isPayload: true,
                    index: 3,
                    lowerLayerIndex: 1,
                    contentType: "application",
                    extra: { record_length: 125 },
                }),
            ),
        ).toBe("TLS Payload #3 (TCP index: 1) : record size 125, partial size 103<br/>content type: application");
    });

    it("HTTP/2 lane (Q-T2: no index, frame size = payload length) and stream lane", () => {
        const m: HTTPStreamInfoMap = new Map([
            [
                1,
                {
                    headers: [
                        { name: ":method", value: "GET" },
                        { name: ":path", value: "/" },
                    ],
                    total_size: 1000,
                },
            ],
        ]);
        const rawPacket = {
            stream_id: 1,
            frame: { frame_type: "data", stream_end: true, raw: { length: 1009, payload_length: 1000 } },
        };
        expect(
            http2RangeToString(range({ size: 686, isPayload: true, index: 7, lowerLayerIndex: 1, rawPacket }), m),
        ).toBe(
            "H2 Payload # (TLS index: 1) : frame size 1000, partial size : 686<br/>frame type: data, streamID: 1<br/><b>STREAM END BIT SET</b><br/>GET: /<br/>total resource size: 1000<br/>",
        );
        expect(http2StreamRangeToString(range({ rawPacket }), m)).toBe(
            "H2 streamID: 1<br/><b>STREAM END BIT SET</b><br/>GET: /<br/>total resource size: 1000<br/>",
        );
        expect(
            http2StreamRangeToString(range({ rawPacket: { stream_id: -1, frame: { frame_type: "magic" } } }), m),
        ).toBe("H2 streamID: -1");
    });
});
