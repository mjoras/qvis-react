// Latest-draft HTTP/3 accessors used by the packetization diagram (qlog-spec/h3-events.md §8.1). The HTTP/3 helpers
// are shared in src/qlog/schema/h3.ts; this module re-exports them next to the packetization-local u64().

import { toNumber } from "@/qlog/uint64";

export {
    fieldName,
    fieldValue,
    h3FrameHeaderLength,
    h3FramePayloadLength,
    h3FrameTypeNumber,
    vlieLength,
} from "@/qlog/schema/h3";

/** uint64 (number or decimal string) -> number; anything else (absent, malformed) -> undefined. */
export function u64(v: unknown): number | undefined {
    if (v === undefined || v === null) return undefined;
    const n = toNumber(v);
    return Number.isFinite(n) ? n : undefined;
}
