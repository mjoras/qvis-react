// Chip colours of the sequence diagram (qvis SequenceDiagramD3Renderer.ts:1752-1789, :1941-1982;
// parity/sequence-diagram.md §3.13, §9.2). Every function returns [background, text].

import type { QlogEvent } from "@/model/QlogEvent";
import { HTTP3_EVENTS, QUIC_EVENTS } from "@/model/names";
import { LATEST_EXTENSIONS, levelOf } from "./labels";

export type ChipColors = readonly [background: string, text: string];

/** Arrow (and lost half-arrow) colour, client to server ("right"). */
export const COLOR_RIGHT = "#0468cc";
/** Arrow (and lost half-arrow) colour, server to client ("left"). */
export const COLOR_LEFT = "#a80f3a";
/** Packet chip on arrow labels: dark grey on light grey. */
export const PACKET_CHIP_COLORS: ChipColors = ["#d6d8db", "#383d41"];

const RED_WHITE: ChipColors = ["#FF0000", "#FFFFFF"];

const FRAME_COLORS: ReadonlyMap<string, ChipColors> = new Map<string, ChipColors>([
    ["ack", ["#03ad25", "#FFFFFF"]], // green
    ["stream", ["#0468cc", "#FFFFFF"]], // blue
    ["crypto", ["#0468cc", "#FFFFFF"]], // blue

    ["padding", ["#ff69b4", "#FFFFFF"]], // pink

    ["connection_close", ["#a80f3a", "#FFFFFF"]], // dark red
    ["reset_stream", ["#a80f3a", "#FFFFFF"]], // dark red
    ["application_close", ["#a80f3a", "#FFFFFF"]], // dark red (legacy)
    ["stop_sending", ["#a80f3a", "#FFFFFF"]], // dark red

    ["new_connection_id", ["#068484", "#FFFFFF"]], // dark green
    ["retire_connection_id", ["#068484", "#FFFFFF"]], // dark green

    ["ping", ["#d6dd02", "#000000"]], // ugly yellow
    ["path_challenge", ["#d6dd02", "#000000"]], // ugly yellow
    ["path_response", ["#d6dd02", "#000000"]], // ugly yellow

    ["max_data", ["#5f0984", "#FFFFFF"]], // dark purple
    ["max_stream_data", ["#5f0984", "#FFFFFF"]], // dark purple
    ["max_streams", ["#5f0984", "#FFFFFF"]], // dark purple
    ["data_blocked", ["#5f0984", "#FFFFFF"]], // dark purple
    ["streams_blocked", ["#5f0984", "#FFFFFF"]], // dark purple
    ["stream_data_blocked", ["#5f0984", "#FFFFFF"]], // dark purple
]);

/** `frameTypeToColor` (`:1752-1789`), plus X1: `reset_stream_at` dark red. */
export function frameTypeToColor(frameType: unknown, extensions: boolean = LATEST_EXTENSIONS): ChipColors {
    if (typeof frameType === "string") {
        const c = FRAME_COLORS.get(frameType);
        if (c !== undefined) return c;
        if (extensions && frameType === "reset_stream_at") return FRAME_COLORS.get("reset_stream")!;
    }
    return RED_WHITE;
}

/** `eventTypeToColor` (`:1941-1982`): an if/else-if chain, evaluated in this order (§9.2). */
export function eventTypeToColor(
    e: Pick<QlogEvent, "fullName" | "namespace" | "type" | "data">,
    extensions: boolean = LATEST_EXTENSIONS,
): ChipColors {
    switch (e.fullName) {
        case QUIC_EVENTS.connection_id_updated:
            return frameTypeToColor("new_connection_id"); // teal
        case QUIC_EVENTS.spin_bit_updated:
            return frameTypeToColor("ping"); // yellow
        case QUIC_EVENTS.connection_state_updated: {
            const s = e.data ? e.data.new : undefined;
            if (s === "closed" || s === "draining" || (extensions && s === "closing")) {
                return frameTypeToColor("connection_close"); // dark red (X2: closing)
            }
            return RED_WHITE; // SQ22: any other state falls out of the qvis chain
        }
        case QUIC_EVENTS.recovery_metrics_updated:
        case QUIC_EVENTS.recovery_parameters_set:
        case QUIC_EVENTS.timer_updated:
            return frameTypeToColor("max_data"); // purple
        case HTTP3_EVENTS.frame_created:
        case HTTP3_EVENTS.frame_parsed:
        case "http2:frame_created": // converter TCP traces (data-model §9.10)
        case "http2:frame_parsed":
            return frameTypeToColor("stream"); // blue
        case QUIC_EVENTS.udp_datagrams_sent:
        case QUIC_EVENTS.udp_datagrams_received:
            return ["#FFFFFF", "#000000"];
    }
    if (e.type === "parameters_set") return frameTypeToColor("max_data"); // any namespace (qvis: type-only)

    const level = levelOf(e);
    if (level === "error") return ["#FF0000", "#000000"];
    if (level === "warning" || level === "simulation") return ["#FFA500", "#000000"]; // orange
    if (level === "debug" || level === "info" || level === "verbose") return ["#D3D3D3", "#000000"]; // lightgrey

    return RED_WHITE;
}
