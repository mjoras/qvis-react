// Netlog converter helpers: ACK ranges (converters spec 3.5 / 8.5.2), transport parameters (8.5.1, 8.9.3, 9.9.8),
// HTTP/3 headers (8.5.3) and settings (8.5.4), error names (8.5.5).

import { describe, expect, it } from "vitest";
import { calculateAckRanges } from "./ackRanges";
import { cryptoErrorName, h3AppErrorName, transportErrorName } from "./errors";
import { mapSettings, parseHeaders } from "./h3";
import { parseChromiumTransportParameters } from "./transportParams";
import { versionLabelToHex } from "./mapEvent";

describe("calculateAckRanges (section 3.5, T2 column)", () => {
    const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    it.each([
        ["consecutive missing", 2115, 2050, range(2056, 2114), [[2050, 2055], [2115]]],
        [
            "gaps",
            20,
            3,
            [6, 7, 8, 11],
            [
                [3, 5],
                [9, 10],
                [12, 20],
            ],
        ],
        ["single missing", 20, 11, [12], [[11], [13, 20]]],
        ["nothing missing", 20, 20, [], [[20]]],
        ["two single gaps", 20, 3, [5, 7], [[3, 4], [6], [8, 20]]],
        ["first missing == smallest (qvis: inverted [3,2])", 20, 3, [3, 4], [[5, 20]]],
    ])("%s", (_name, largest, smallest, missing, expected) => {
        const r = calculateAckRanges(largest, smallest, missing);
        expect(r.ranges).toEqual(expected);
        expect(r.noSmallest).toBe(false);
    });

    it("tolerates a missing smallest_observed (old Chrome bug 1112925; qvis threw)", () => {
        expect(calculateAckRanges(10, undefined, [])).toEqual({ ranges: [[10]], noSmallest: true });
        expect(calculateAckRanges(10, undefined, [4, 5]).ranges).toEqual([[6, 10]]);
    });

    it("does not mutate the input (Q23) and sorts unsorted lists", () => {
        const missing = [11, 6, 8, 7];
        expect(calculateAckRanges(20, 3, missing).ranges).toEqual([
            [3, 5],
            [9, 10],
            [12, 20],
        ]);
        expect(missing).toEqual([11, 6, 8, 7]);
    });

    it("accepts numeric strings (NetLogNumberValue)", () => {
        expect(calculateAckRanges(20, 3, ["6", "7"]).ranges).toEqual([
            [3, 5],
            [8, 20],
        ]);
    });
});

describe("parseChromiumTransportParameters (section 8.5.1)", () => {
    it("parses the qvis example string", () => {
        const s =
            "[Client max_idle_timeout 30000 max_udp_payload_size 1472 initial_max_data 15728640 initial_max_stream_data_bidi_local 6291456 initial_max_streams_bidi 100 initial_source_connection_id 0a0b0c0d]";
        expect(parseChromiumTransportParameters(s)).toEqual({
            max_idle_timeout: 30000,
            max_udp_payload_size: 1472,
            initial_max_data: 15728640,
            initial_max_stream_data_bidi_local: 6291456,
            initial_max_streams_bidi: 100,
            initial_source_connection_id: "0a0b0c0d",
            chromium_raw: s,
        });
    });

    it("parses the messy vector of section 8.9.3", () => {
        const s =
            "[Server max_idle_timeout 30000 stateless_reset_token 00112233445566778899aabbccddeeff max_udp_payload_size 1472 initial_max_data 786432 disable_active_migration active_connection_id_limit 4 initial_source_connection_id ab12 original_destination_connection_id 0102 google_handshake_message length: 13 0x4143=0102 legacy[version 00000001 [00000001]]]";
        expect(parseChromiumTransportParameters(s)).toEqual({
            max_idle_timeout: 30000,
            stateless_reset_token: "00112233445566778899aabbccddeeff",
            max_udp_payload_size: 1472,
            initial_max_data: 786432,
            disable_active_migration: true,
            active_connection_id_limit: 4,
            initial_source_connection_id: "ab12",
            original_destination_connection_id: "0102",
            unknown_parameters: [{ id: 16707, value: "0102" }],
            chromium_extra: { google_handshake_message: "length: 13", legacy: "[version 00000001 [00000001]]" },
            chromium_raw: s,
        });
    });

    it("maps the 2020 (pre-RFC) names", () => {
        const r = parseChromiumTransportParameters("[Client idle_timeout 30 max_packet_size 1350]");
        expect(r.max_idle_timeout).toBe(30);
        expect(r.max_udp_payload_size).toBe(1350);
        expect(r.chromium_extra).toBeUndefined();
    });

    it("handles flags, quoted values and reliable_stream_reset (section 9.9.8)", () => {
        const s =
            '[Client max_idle_timeout 30000 reliable_stream_reset user_agent_id "Chrome/1 Linux" initial_max_data 10]';
        expect(parseChromiumTransportParameters(s)).toEqual({
            max_idle_timeout: 30000,
            reset_stream_at: true,
            initial_max_data: 10,
            chromium_extra: { user_agent_id: "Chrome/1 Linux" },
            chromium_raw: s,
        });
    });

    it("parses a real current-Chrome string (version group, empty CID printed as 0, trailing flag)", () => {
        const s =
            "[Client [chosen_version 00000001 other_versions 00000001] max_idle_timeout 30000 max_udp_payload_size 1472 initial_max_data 15728640 initial_max_streams_uni 103 initial_source_connection_id 0 max_datagram_frame_size 65536 google_connection_options ORIG key_update_not_yet_supported]";
        expect(parseChromiumTransportParameters(s)).toEqual({
            max_idle_timeout: 30000,
            max_udp_payload_size: 1472,
            initial_max_data: 15728640,
            initial_max_streams_uni: 103,
            initial_source_connection_id: "",
            max_datagram_frame_size: 65536,
            chromium_extra: {
                version_information: "[chosen_version 00000001 other_versions 00000001]",
                google_connection_options: "ORIG",
                key_update_not_yet_supported: true,
            },
            chromium_raw: s,
        });
    });

    it("keeps unsafe integers as decimal strings (C12) and non-hex ids in chromium_extra", () => {
        const r = parseChromiumTransportParameters(
            "[Server initial_max_data 18446744073709551615 retry_source_connection_id xyz preferred_address 1.2.3.4:443 [::1]:443 ab12 max_ack_delay 25]",
        );
        expect(r.initial_max_data).toBe("18446744073709551615");
        expect(r.retry_source_connection_id).toBeUndefined();
        expect(r.max_ack_delay).toBe(25);
        expect(r.chromium_extra).toEqual({
            retry_source_connection_id: "xyz",
            preferred_address: "1.2.3.4:443 [::1]:443 ab12",
        });
    });
});

describe("parseHeaders (section 8.5.3)", () => {
    it("parses current Chrome's list of 'name: value' strings", () => {
        expect(
            parseHeaders([":method: GET", ":status: 200", 'alt-svc: h3=":443"; ma=86400', "x: a: b", "bare", "e:"]),
        ).toEqual([
            { name: ":method", value: "GET" },
            { name: ":status", value: "200" },
            { name: "alt-svc", value: 'h3=":443"; ma=86400' },
            { name: "x", value: "a: b" },
            { name: "bare" },
            { name: "e:" },
        ]);
    });

    it("parses the 2020 object form (PARITY) and keeps elided values", () => {
        expect(parseHeaders({ ":method": "GET", cookie: "[12 bytes were stripped]", n: 3 })).toEqual([
            { name: ":method", value: "GET" },
            { name: "cookie", value: "[12 bytes were stripped]" },
            { name: "n", value: "3" },
        ]);
        expect(parseHeaders(undefined)).toEqual([]);
    });
});

describe("mapSettings (section 8.5.4)", () => {
    it("maps the T1/T2 settings and accepts both field-section names (Q14)", () => {
        expect(
            mapSettings(
                {
                    SETTINGS_MAX_FIELD_SECTION_SIZE: 262144,
                    SETTINGS_QPACK_MAX_TABLE_CAPACITY: 0,
                    SETTINGS_H3_DATAGRAM: 1,
                },
                false,
            ),
        ).toEqual({ max_field_section_size: 262144, max_table_capacity: 0 });
        expect(mapSettings({ SETTINGS_MAX_HEADER_LIST_SIZE: 100, SETTINGS_QPACK_BLOCKED_STREAMS: 16 }, false)).toEqual({
            max_field_section_size: 100,
            blocked_streams_count: 16,
        });
    });

    it("maps the T3 settings", () => {
        expect(
            mapSettings(
                {
                    SETTINGS_ENABLE_CONNECT_PROTOCOL: 1,
                    SETTINGS_H3_DATAGRAM: 1,
                    "UNSUPPORTED_SETTINGS_TYPE(64)": 7,
                    "UNSUPPORTED_SETTINGS_TYPE(31686856989)": 5, // GREASE: 0x1f * N + 0x21
                    "UNSUPPORTED_SETTINGS_TYPE(65)": 6,
                    SETTINGS_FOO: 3,
                },
                true,
            ),
        ).toEqual({
            extended_connect: 1,
            h3_datagram: 1,
            unknown_settings: [
                { name: "reserved", name_bytes: 64, value: 7 },
                { name: "reserved", name_bytes: 31686856989, value: 5 },
                { name: "unknown", name_bytes: 65, value: 6 },
            ],
            chromium_settings: { SETTINGS_FOO: 3 },
        });
    });
});

describe("error names (section 8.5.5, C10)", () => {
    it("maps transport, crypto and HTTP/3 codes", () => {
        expect(transportErrorName(0)).toBe("no_error");
        expect(transportErrorName(0x10)).toBe("no_viable_path");
        expect(transportErrorName(0x11)).toBeUndefined();
        expect(cryptoErrorName(0x128)).toBe("crypto_error_0x128");
        expect(cryptoErrorName(0x200)).toBeUndefined();
        expect(h3AppErrorName(0x10c)).toBe("http_request_cancelled");
        expect(h3AppErrorName(0x10e)).toBeUndefined(); // editor's copy only
        expect(h3AppErrorName(0x200)).toBeUndefined();
    });
});

describe("versionLabelToHex (section 9.7)", () => {
    it.each([
        ["RFCv1", "00000001"],
        ["RFCv2", "6b3343cf"],
        ["draft29", "ff00001d"],
        ["ff00001d", "ff00001d"],
        ["Q050", "51303530"],
        ["T051", "54303531"],
        ["nonsense", undefined],
    ])("%s", (label, hex) => {
        expect(versionLabelToHex(label)).toBe(hex);
    });
});
