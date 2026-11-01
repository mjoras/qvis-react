import { connectionFromEvents, ev, groupFromRoot } from "../__fixtures__/build";
import { tcpH2QlogFile } from "../__fixtures__/tcpH2Trace";
import PacketizationDiagramD3Renderer from "./PacketizationDiagramD3Renderer";
import { PacketizationDirection } from "./PacketizationDiagramModels";

const { sending, receiving } = PacketizationDirection;

function setup(width = 1600) {
    document.body.innerHTML = "";
    const top = document.createElement("div");
    const bottom = document.createElement("div");
    const tip = document.createElement("div");
    tip.id = "packetization-packet-tooltip";
    document.body.append(top, bottom, tip);
    for (const el of [top, bottom]) Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
    return {
        top,
        bottom,
        tip,
        rTop: new PacketizationDiagramD3Renderer(top, tip, "packetization-clip-top"),
        rBottom: new PacketizationDiagramD3Renderer(bottom, tip, "packetization-clip-bottom"),
    };
}

const texts = (el: HTMLElement) =>
    [...el.querySelectorAll("text")].map((t) => t.textContent ?? "").filter((t) => !/^[\d,.−-]+$/.test(t));

const quicEvents = () => [
    ev("quic:parameters_set", { initiator: "remote", max_udp_payload_size: 1472 }),
    ev("http3:frame_created", {
        stream_id: 0,
        frame: {
            frame_type: "headers",
            headers: [
                { name: ":method", value: "GET" },
                { name: ":path", value: "/" },
            ],
            raw: { payload_length: 18 },
        },
    }),
    ev("quic:packet_sent", {
        header: { packet_type: "1RTT", packet_number: 1 },
        raw: { length: 60, payload_length: 22 },
        frames: [{ frame_type: "stream", stream_id: 0, offset: 0, fin: true, raw: { length: 20 } }],
    }),
    ev("quic:packet_received", {
        header: { packet_type: "1RTT", packet_number: 1 },
        raw: { length: 1252, payload_length: 1224 },
        frames: [
            { frame_type: "ack", acked_ranges: [[1, 1]] },
            { frame_type: "stream", stream_id: 0, offset: 0, raw: { length: 1200 } },
        ],
    }),
    ev("http3:frame_parsed", { stream_id: 0, frame: { frame_type: "headers", raw: { payload_length: 36 } } }),
    ev("http3:frame_parsed", { stream_id: 0, frame: { frame_type: "data", raw: { payload_length: 1159 } } }),
];

describe("PacketizationDiagramD3Renderer (jsdom)", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        vi.restoreAllMocks();
    });

    it("svg geometry, labels and texts of a client trace", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { top, bottom, rTop, rBottom } = setup();
        const conn = connectionFromEvents(quicEvents());
        rTop.render(conn, receiving);
        rBottom.render(conn, sending);

        const svg = top.querySelector("svg")!;
        expect(svg.getAttribute("width")).toBe("1600");
        expect(svg.getAttribute("height")).toBe("170");
        expect(svg.getAttribute("font-family")).toBe("Trebuchet-ms");
        expect(svg.querySelector("g")!.getAttribute("transform")).toBe("translate(100,30)");

        expect(texts(top)).toEqual([
            "QUIC packets",
            "QUIC frames",
            "HTTP/3",
            "Stream IDs",
            "Bytes received",
            "max receiving size client: 65527",
            "max receiving size server: 1472",
            "efficiency " + (((36 + 1159) / 1252) * 100).toFixed(2) + "%",
            "Data received by client from server (trace vantagepoint = client)",
        ]);
        expect(texts(bottom)).toContain("Bytes sent");
        expect(texts(bottom)).toContain("Data sent from client to server (trace vantagepoint = client)");

        expect(top.querySelectorAll("rect.quicpacket")).toHaveLength(3);
        expect(top.querySelectorAll("rect.quicframe")).toHaveLength(4); // filler, ack, stream header + payload
        expect(top.querySelectorAll("rect.httpframe")).toHaveLength(4);
        expect(top.querySelectorAll("rect.streampacket")).toHaveLength(4);

        // unique clip ids (Q-R1)
        expect(top.querySelector("clipPath")!.id).toBe("packetization-clip-top");
        expect(bottom.querySelector("clipPath")!.id).toBe("packetization-clip-bottom");
        expect(top.querySelector("g[clip-path]")!.getAttribute("clip-path")).toBe("url(#packetization-clip-top)");
        expect(top.querySelector("clipPath rect")!.getAttribute("width")).toBe(String(1600 - 100 - 80));

        // lane label geometry and style
        const label = [...top.querySelectorAll("text")].find((t) => t.textContent === "QUIC packets")!;
        expect(label.getAttribute("x")).toBe("-5");
        expect(Number(label.getAttribute("y"))).toBeCloseTo(75 + 25 / 1.75);
        expect(label.style.fontSize).toBe("14px");
        expect(label.style.textAnchor).toBe("end");
        expect(label.getAttribute("fill")).toBe("#000000");

        // rect geometry: header 60% high and bottom aligned, payload full lane, stream lane 15px at the top
        const [header, payload] = [...top.querySelectorAll<SVGRectElement>("rect.quicpacket")];
        expect([header.getAttribute("y"), header.getAttribute("height")]).toEqual(["85", "15"]);
        expect([payload.getAttribute("y"), payload.getAttribute("height")]).toEqual(["75", "25"]);
        expect(header.getAttribute("x")).toBe("-0.3");
        expect(header.getAttribute("fill")).toBe("black");
        const stream = top.querySelector<SVGRectElement>("rect.streampacket")!;
        expect([stream.getAttribute("y"), stream.getAttribute("height")]).toEqual(["0", "15"]);
        expect(top.querySelector("rect.quicframe")!.getAttribute("fill")).toBe("yellow");
        expect(top.querySelector(".packetization-empty-note")).toBeNull();
    });

    it("hover shows the escaped tooltip at pageX + 15 / pageY - 75", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { top, tip, rTop } = setup();
        rTop.render(connectionFromEvents(quicEvents()), receiving);
        expect(tip.style.position).toBe("absolute");
        expect(tip.style.opacity).toBe("0");
        expect(tip.style.background).toBe("lightsteelblue");

        const rect = top.querySelectorAll("rect.quicpacket")[0];
        rect.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 200, clientY: 300 }));
        expect(tip.innerHTML).toBe("QUIC Header #0 : size 12<br>Packet type : 1RTT, Packet nr : 1<br>");
        expect(tip.style.left).toBe("215px");
        expect(tip.style.top).toBe("225px");
    });

    it("server and unknown vantage points: local/remote names and flow label", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { top, rTop } = setup();
        rTop.render(connectionFromEvents(quicEvents(), { vantage_point: { type: "server" } }), receiving);
        expect(texts(top)).toContain("max receiving size server: 65527");
        expect(texts(top)).toContain("max receiving size client: 1472");
        expect(texts(top)).toContain("Data received by server from client (trace vantagepoint = server)");

        rTop.render(connectionFromEvents(quicEvents(), { vantage_point: { type: "network" } }), receiving);
        expect(texts(top)).toContain("max receiving size client: 65527");
        expect([...top.querySelectorAll("text")].some((t) => t.textContent === "")).toBe(true); // empty flow label
        expect(top.querySelectorAll("svg")).toHaveLength(1); // re-render replaces the svg
    });

    it("empty direction: centered D-PZ4 note, no NaN attributes", () => {
        const { top, rTop } = setup();
        rTop.render(
            connectionFromEvents([
                ev("transport:packet_received", { header: { packet_type: "1RTT" }, raw: { length: 10 } }),
            ]),
            receiving,
        );
        const note = top.querySelector(".packetization-empty-note text")!;
        expect(note.textContent).toBe(
            "This trace uses pre-standard event names (transport:packet_received); only quic:packet_received is supported",
        );
        expect(note.getAttribute("x")).toBe(String((1600 - 180) / 2));
        expect(note.getAttribute("y")).toBe("50");
        expect(note.getAttribute("fill")).toBe("#6c757d");
        expect(texts(top)).not.toContain(expect.stringContaining("efficiency"));
        // E3 geometry: a single tick "0" in the middle (d3 v5 format; d3 v7 would print "0.000000")
        const ticks = [...top.querySelectorAll(".tick")];
        expect(ticks.map((t) => t.textContent)).toEqual(["0"]);
        expect(ticks[0].getAttribute("transform")).toBe("translate(" + ((1600 - 180) / 2 + 0.5) + ",0)");
        for (const el of top.querySelectorAll("*")) {
            for (const attr of el.getAttributeNames()) expect(el.getAttribute(attr)).not.toContain("NaN");
        }
    });

    it("negative sizes are drawn with width 0 (E7)", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { top, rTop } = setup();
        rTop.render(
            connectionFromEvents([
                ev("quic:packet_received", { header: { packet_type: "1RTT" }, raw: { length: 10 } }),
            ]),
            receiving,
        );
        const widths = [...top.querySelectorAll("rect.quicpacket")].map((r) => Number(r.getAttribute("width")));
        expect(widths).toHaveLength(3);
        expect(widths[1]).toBe(0);
    });

    it("TCP mode lanes and no QUIC-only labels", () => {
        const { top, rTop } = setup();
        rTop.render(groupFromRoot(tcpH2QlogFile()).getConnections()[0], receiving);
        expect(texts(top)).toEqual([
            "TCP",
            "TLS",
            "HTTP/2",
            "Stream IDs",
            "Bytes received",
            "Data received by client from server (trace vantagepoint = client)",
        ]);
        expect(top.querySelectorAll("rect.tcppacket")).toHaveLength(6);
        expect(top.querySelectorAll("rect.tlspacket")).toHaveLength(7);
        expect(top.querySelectorAll("rect.httppacket")).toHaveLength(8);
    });

    it("clear / dispose remove the svg", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { top, rTop } = setup();
        rTop.render(connectionFromEvents(quicEvents()), receiving);
        expect(rTop.getRenderedWidth()).toBe(1600);
        rTop.clear();
        expect(top.children).toHaveLength(0);
        expect(rTop.getRenderedWidth()).toBeUndefined();
        rTop.render(connectionFromEvents(quicEvents()), receiving);
        rTop.dispose();
        expect(top.children).toHaveLength(0);
    });
});
