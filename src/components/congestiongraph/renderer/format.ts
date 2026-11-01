// Number / text formats of the congestion graph (parity/congestion-graph.md §2.4, §2.6, §3.9, §3.10). Pure.

import type { CgPacket, CongestionModel, Pt } from "./congestionModel";

/**
 * qvis y-axis "K" format (R:672-709): `12000 -> "12K"`, `12010 -> "12010"`, `1000 -> "1000"`, `0.4 -> "0"`.
 * No "M" suffix and no decimals.
 */
export function kFormat(val: number | { valueOf(): number }): string {
    const nr: number = typeof val === "number" ? val : val.valueOf();
    if (nr > 1000 || nr < -1000) {
        if (Math.round(nr) % 1000 === 0) {
            return Math.round(nr / 1000) + "K";
        }
        return Math.round(nr).toString();
    }
    return Math.round(nr).toString();
}

/**
 * FIX Q5 (partial): the RTT y axis keeps the K-format for integer tick values (identical to qvis for the usual RTT
 * ranges) and uses d3's default tick format for fractional ones instead of rounding them to duplicate integers.
 */
export function rttTickFormat(defaultFormat: (n: number) => string): (val: number | { valueOf(): number }) => string {
    return (val) => {
        const nr = typeof val === "number" ? val : val.valueOf();
        return Number.isInteger(nr) ? kFormat(nr) : defaultFormat(nr).replace(/−/g, "-");
    };
}

export interface RulerTexts {
    time: string;
    bytes: string;
    rate: string;
}

/**
 * Ruler measurement (R:205-235). Times and byte offsets are rounded before subtracting (PARITY: coarse short spans);
 * all units are decimal; negative values never get unit scaling.
 */
export function rulerTexts(
    startTimeMs: number,
    endTimeMs: number,
    startBytesIn: number,
    endBytesIn: number,
): RulerTexts {
    const startTime = Math.round(startTimeMs);
    const endTime = Math.round(endTimeMs);
    const timeDifference = endTime - startTime;

    const startBytes = Math.round(startBytesIn);
    const endBytes = Math.round(endBytesIn);
    const bytesDifference = endBytes - startBytes;

    let timeText = timeDifference + " ms";
    if (timeDifference > 10000) {
        timeText = (timeDifference / 1000).toFixed(2) + "s";
    }

    let bytesText = bytesDifference + " bytes";
    if (bytesDifference > 2000000) {
        // larger than 2MB
        bytesText = (bytesDifference / 1000000).toFixed(2) + " MB";
    } else if (bytesDifference > 10000) {
        // larger than 10 KB
        bytesText = Math.round(bytesDifference / 1000) + " KB";
    }

    const bits = (endBytes - startBytes) * 8;
    let rate = bits / 1000 / ((endTime - startTime) / 1000); // bits per ms -> Kbit/s
    let rateText = Math.round(rate) + " Kbps";
    if (rate > 1000) {
        rate = bits / 1000000 / ((endTime - startTime) / 1000);
        rateText = rate.toFixed(2) + " Mbps";
    }

    return { time: timeText, bytes: bytesText, rate: rateText };
}

// ------------------------------------------------------------------------------------------------ tooltip

/** The five `<p>` lines of `#packetInfo`; `packetSize` may hold several lines (qvis joined them with `<br/>`). */
export interface TooltipContent {
    timestamp: string;
    packetNr: string;
    packetSize: string[];
    ackedFrom: string;
    ackedTo: string;
}

function header(ev: { data: any } | undefined): Record<string, unknown> | undefined {
    const h = ev?.data?.header;
    return h !== null && typeof h === "object" ? (h as Record<string, unknown>) : undefined;
}

/** Logged `raw.length` when it is a JSON number or decimal string (tooltips print the logged value), else `fallback`. */
function loggedSize(data: any, fallback: number | undefined): string {
    const len = data?.raw?.length;
    if (typeof len === "number" || (typeof len === "string" && /^\s*\d+\s*$/.test(len))) return String(len);
    return String(fallback);
}

/**
 * Step-series lookup for the sent-packet tooltip (R:1603-1641): the value of the step `[a, b)` containing `t`.
 * FIX Q11: also checks the last step pair (qvis looped to `length - 2`).
 */
export function stepValueAt(series: readonly Pt[], t: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < series.length - 1; ++i) {
        const a = series[i];
        const b = series[i + 1];
        if (a[0] <= t && b[0] > t) out.push(a[1]);
    }
    return out;
}

/** Tooltip of a sent packet (blue). */
export function sentTooltip(model: CongestionModel, p: CgPacket): TooltipContent {
    const h = header(p.event);
    const lines = ["PacketSize: " + loggedSize(p.event.data, p.size)];
    for (const v of stepValueAt(model.cwnd, p.t)) lines.push("CWND: " + v + " bytes");
    for (const v of stepValueAt(model.bytes, p.t)) lines.push("In flight: " + v + " bytes");
    for (const v of stepValueAt(model.latestRTT, p.t)) lines.push("RTT: " + v + " ms");
    for (const v of stepValueAt(model.smoothedRTT, p.t)) lines.push("sRTT: " + v + " ms");
    return {
        timestamp: "Timestamp: " + p.t,
        packetNr: "PacketNr: " + (h ? h.packet_type : "") + " " + (h ? h.packet_number : "?"),
        packetSize: lines,
        ackedFrom: "",
        ackedTo: "",
    };
}

/** Tooltip of the first ACK of a packet (green). "Acked from/to" are byte offsets (Q28, PARITY). */
export function ackTooltip(p: CgPacket): TooltipContent {
    // the received packet that carried the ACK; a quic:packets_acked fallback ACK has no header -> "PacketNr:  ?" (Q37)
    const h = header(p.ackEvent);
    return {
        timestamp: "Timestamp: " + p.ackT,
        packetNr: "PacketNr: " + (h ? h.packet_type : "") + " " + (h ? h.packet_number : "?"),
        packetSize: [],
        ackedFrom: "Acked from: " + p.from,
        ackedTo: "Acked to: " + p.to,
    };
}

/** Tooltip of the loss of a packet (red). FIX Q25: the size comes from the matched sent packet. */
export function lossTooltip(p: CgPacket): TooltipContent {
    const h = header(p.lossEvent);
    const lossData = p.lossEvent?.data;
    const lossRaw = lossData?.raw;
    const size =
        lossRaw !== null && typeof lossRaw === "object" && lossRaw.length !== undefined
            ? loggedSize(lossData, p.size)
            : loggedSize(p.event.data, p.size);
    return {
        timestamp: "Timestamp: " + p.lossT,
        packetNr: "PacketNr: " + (h ? h.packet_type : "") + " " + (h ? (h.packet_number ?? "unknown") : "unknown"),
        packetSize: ["PacketSize: " + size],
        ackedFrom: "",
        ackedTo: "",
    };
}
