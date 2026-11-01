// The three legend boxes of qvis CongestionGraphRenderer.vue (parity/congestion-graph.md §2.3): static, always
// visible, translucent while hovered (class hiddenLegend, toggled on the element like qvis did on evt.target).

import type { CSSProperties, MouseEvent } from "react";

const BOX_STYLE: CSSProperties = {
    padding: "5px",
    border: "1px solid black",
    backgroundColor: "white",
    position: "absolute",
    zIndex: 100,
};

const ITEM_STYLE: CSSProperties = { padding: 0, margin: "10px 0" };
const RTT_ITEM_STYLE: CSSProperties = { padding: 0, margin: "3px 15px", display: "inline" };

function swatch(color: string, width: number): CSSProperties {
    return {
        width: width + "px",
        height: "8px",
        backgroundColor: color,
        display: "inline-block",
        marginRight: "1px",
        verticalAlign: "middle",
    };
}

function hideLegend(evt: MouseEvent<HTMLDivElement>): void {
    evt.currentTarget.classList.add("hiddenLegend");
}

function showLegend(evt: MouseEvent<HTMLDivElement>): void {
    evt.currentTarget.classList.remove("hiddenLegend");
}

interface Item {
    color: string;
    label: string;
}

const PACKET_ITEMS: Item[] = [
    { color: "blue", label: ": Data sent (includes retransmits)" },
    { color: "#6B8E23", label: ": Data acknowledged" },
    { color: "red", label: ": Data lost" },
    { color: "#a80f3a", label: ": Connection flow control limit" },
    { color: "#ff69b4", label: ": Sum of stream flow control limits" },
];

const METRIC_ITEMS: Item[] = [
    { color: "#8A2BE2", label: ": Congestion window" },
    { color: "#808000", label: ": Bytes in flight" },
];

const RTT_ITEMS: Item[] = [
    { color: "#C96480", label: ": Min RTT" },
    { color: "#ff9900", label: ": Latest RTT" },
    { color: "#8a554a", label: ": Smoothed RTT" },
];

function Legend(props: {
    id: string;
    position: CSSProperties;
    items: Item[];
    itemStyle: CSSProperties;
    swatchWidth: number;
}) {
    return (
        <div
            id={props.id}
            style={{ ...BOX_STYLE, ...props.position }}
            onMouseEnter={hideLegend}
            onMouseLeave={showLegend}
        >
            {props.items.map((item) => (
                // qvis' template whitespace, kept: `<p> <span></span> : Label </p>`. It is invisible in the block
                // legends, but in the inline RTT legend the trailing space widens each item (qvis: 491.2px box)
                <p key={item.label} style={props.itemStyle}>
                    {" "}
                    <span style={swatch(item.color, props.swatchWidth)}></span>
                    {" " + item.label + " "}
                </p>
            ))}
        </div>
    );
}

export default function CongestionGraphLegends() {
    return (
        <>
            <Legend
                id="legendPackets"
                position={{ top: "10px", left: "80px" }}
                items={PACKET_ITEMS}
                itemStyle={ITEM_STYLE}
                swatchWidth={12}
            />
            <Legend
                id="legendMetrics"
                position={{ top: "440px", right: "50px" }}
                items={METRIC_ITEMS}
                itemStyle={ITEM_STYLE}
                swatchWidth={12}
            />
            <Legend
                id="legendRTT"
                position={{ top: "795px", right: "50px" }}
                items={RTT_ITEMS}
                itemStyle={RTT_ITEM_STYLE}
                swatchWidth={32}
            />
        </>
    );
}

export { CongestionGraphLegends };
