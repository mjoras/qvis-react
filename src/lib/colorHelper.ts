// Port of qvis `components/shared/helpers/ColorHelper.ts` (parity/app-shell.md §3.7).
// Pure and synchronous: D3 renderers call it inside `.attr("fill", ...)` callbacks.
// Colors inspired by Kelly's 22 colour chart (http://artshacker.com/wp-content/uploads/2014/12/Kellys-22-colour-chart.jpg).

export type StreamProtocol = "HTTP2" | "HTTP3";

const H2_STREAM_ID_COLORS: ReadonlyMap<string, string> = new Map<string, string>([
    ["0", "#FF0000"], // bright red
    ["1", "#E1DA4C"], // yellow
    ["3", "#6B067F"], // purple
    ["5", "#E17426"], // orange
    ["7", "#914ca8"], // purple
    ["9", "#99CBDF"], // light blue
    ["11", "#C72737"], // red
    ["13", "#BBC585"], // buff
    ["15", "#7D787A"], // grey
    ["17", "#6CAD58"], // green
    ["19", "#D580AA"], // pink
    ["21", "#4C61B9"], // blue
    ["23", "#D38E75"], // yellowish pink
    ["25", "#46198C"], // violet
    ["27", "#C8A454"], // oker
]);

// keyed by client-initiated bidirectional stream IDs 0, 4, 8, ...
const H3_STREAM_ID_COLORS: ReadonlyMap<string, string> = new Map<string, string>([
    ["0", "#E1DA4C"], // yellow
    ["4", "#6B067F"], // purple
    ["8", "#E17426"], // orange
    ["12", "#914ca8"], // purple
    ["16", "#99CBDF"], // light blue
    ["20", "#C72737"], // red
    ["24", "#BBC585"], // buff
    ["28", "#7D787A"], // grey
    ["32", "#6CAD58"], // green
    ["36", "#D580AA"], // pink
    ["40", "#4C61B9"], // blue
    ["44", "#D38E75"], // yellowish pink
    ["48", "#46198C"], // violet
    ["52", "#C8A454"], // oker
]);

/** Fallback for stream IDs without a palette entry (CSS named color, #FFF0F5). */
export const FALLBACK_STREAM_COLOR = "lavenderblush";

/**
 * Maps a stream ID (always passed as a decimal string, e.g. `"" + id`) to `[fill, "black"]`.
 * Exact qvis algorithm: exact string lookup first, then parseInt (so "04" -> 4, "4.7" -> 4), modulo
 * 28 (HTTP2, when > 27) or 56 (HTTP3, when > 52), then lookup again, else lavenderblush.
 */
export function streamIdToColor(streamID: string, protocol: StreamProtocol): [string, "black"] {
    const lut = protocol === "HTTP2" ? H2_STREAM_ID_COLORS : H3_STREAM_ID_COLORS;

    const exact = lut.get(streamID);
    if (exact !== undefined) {
        return [exact, "black"];
    }

    let n = parseInt(streamID, 10);
    if (protocol === "HTTP2") {
        if (n > 27) {
            n = n % 28;
        }
    } else if (n > 52) {
        n = n % 56; // 14 colors * 4: cycles through client-bidi stream IDs
    }

    const cycled = lut.get("" + n);
    return cycled !== undefined ? [cycled, "black"] : [FALLBACK_STREAM_COLOR, "black"];
}

/** Sibling helper of MultiplexingGraphDataHelper: client-initiated bidirectional (request) stream. */
export function isDataStream(streamID: string): boolean {
    return parseInt(streamID, 10) % 4 === 0;
}

/** Porting aid mirroring the original static class API (`ColorHelper.StreamIDToColor(id, "HTTP3")[0]`). */
export const ColorHelper = {
    StreamIDToColor: streamIdToColor,
} as const;
