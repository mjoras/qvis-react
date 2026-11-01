// parseChromiumTransportParameters (converters spec section 8.5.1, FIX of Q13).
//
// Chrome logs quiche's TransportParameters::ToString(), e.g.
//   "[Client max_idle_timeout 30000 max_udp_payload_size 1472 ... initial_source_connection_id 0a0b0c0d]".
// qvis split on " " and paired tokens, which breaks on flags (disable_active_migration), multi-token values
// (google_handshake_message length: N, legacy[...], preferred_address ...) and custom parameters (0x<id>=<hex>), and
// kept the closing "]" on the last value. This tokenizer maps the RFC 9000 parameters to quic-13 QUICParametersSet
// fields and keeps everything else in the `chromium_extra` / `chromium_raw` extension fields (decision C11).

import { u64 } from "../common/num";
import { ownValue, setOwn } from "../common/own";

const INT_PARAMS = new Set([
    "max_idle_timeout",
    "max_udp_payload_size",
    "initial_max_data",
    "initial_max_stream_data_bidi_local",
    "initial_max_stream_data_bidi_remote",
    "initial_max_stream_data_uni",
    "initial_max_streams_bidi",
    "initial_max_streams_uni",
    "ack_delay_exponent",
    "max_ack_delay",
    "active_connection_id_limit",
    "max_datagram_frame_size",
]);

const HEX_PARAMS = new Set([
    "original_destination_connection_id",
    "initial_source_connection_id",
    "retry_source_connection_id",
    "stateless_reset_token",
]);

const FLAGS = new Set(["disable_active_migration", "reliable_stream_reset", "key_update_not_yet_supported"]);

/** 2020 (pre-RFC) quiche names -> RFC 9000 names; `null` = Chromium-only parameter (goes to chromium_extra). */
const ALIASES: Readonly<Record<string, string | null>> = {
    idle_timeout: "max_idle_timeout",
    max_packet_size: "max_udp_payload_size",
    initial_round_trip_time: null,
    user_agent_id: null,
};

const OTHER_KNOWN = [
    "google_connection_options",
    "google_handshake_message",
    "initial_round_trip_time",
    "min_ack_delay_us",
    "user_agent_id",
    "preferred_address",
];

const KNOWN_KEYS = new Set<string>([...INT_PARAMS, ...HEX_PARAMS, ...FLAGS, ...Object.keys(ALIASES), ...OTHER_KNOWN]);

const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const CUSTOM_RE = /^0x([0-9a-f]+)=(.*)$/i;

function countChar(s: string, c: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === c) n++;
    return n;
}

export interface UnknownParameterOut {
    id: number | string;
    value?: string;
}

/**
 * Returns the QUICParametersSet fields (without `initiator`, which comes from the event type), plus
 * `unknown_parameters`, `chromium_extra` (Chromium/Google-only parameters) and `chromium_raw` (the input string).
 */
export function parseChromiumTransportParameters(s: string): Record<string, unknown> {
    let t = s.trim();
    if (t.startsWith("[")) t = t.slice(1);
    if (t.endsWith("]")) t = t.slice(0, -1);
    const tokens = t.split(/\s+/).filter((x) => x.length > 0);
    // perspective; the initiator comes from the event type (..._SENT / ..._RECEIVED), not from this word
    if (tokens[0] === "Client" || tokens[0] === "Server") tokens.shift();

    const out: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    const unknown: UnknownParameterOut[] = [];

    const setFlag = (tok: string): void => {
        if (tok === "disable_active_migration") out.disable_active_migration = true;
        else if (tok === "reliable_stream_reset")
            out.reset_stream_at = true; // quic-13 QUICParametersSet.reset_stream_at
        else setOwn(extra, tok, true); // e.g. key_update_not_yet_supported
    };

    const put = (key: string, value: string): void => {
        const alias = ownValue(ALIASES, key);
        const name = alias === undefined ? key : alias;
        if (name === null) {
            setOwn(extra, key, value);
        } else if (INT_PARAMS.has(name)) {
            const v = u64(value);
            if (v !== undefined) out[name] = v;
            else setOwn(extra, key, value);
        } else if (HEX_PARAMS.has(name)) {
            let hex = value.toLowerCase().replace(/^0x/, "");
            if (hex === "0") hex = ""; // quiche prints an empty (zero-length) connection ID as "0"
            if (HEX_RE.test(hex)) out[name] = hex;
            else setOwn(extra, key, value);
        } else {
            setOwn(extra, key, value);
        }
    };

    let i = 0;
    while (i < tokens.length) {
        const tok = tokens[i];
        const bracket = tok.indexOf("[");
        if (bracket >= 0) {
            // bracketed group, e.g. "legacy[version 00000001 [00000001]]" or "[chosen_version ... other_versions ...]"
            const prefix = tok.slice(0, bracket);
            const key = prefix !== "" ? prefix : tok.startsWith("[chosen_version") ? "version_information" : "group";
            let depth = countChar(tok, "[") - countChar(tok, "]");
            const buf = [tok];
            i++;
            while (depth > 0 && i < tokens.length) {
                depth += countChar(tokens[i], "[") - countChar(tokens[i], "]");
                buf.push(tokens[i]);
                i++;
            }
            setOwn(extra, key, buf.join(" ").slice(prefix.length));
            continue;
        }
        const custom = CUSTOM_RE.exec(tok);
        if (custom !== null) {
            const id = BigInt("0x" + custom[1]);
            const entry: UnknownParameterOut = {
                id: id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString(),
            };
            const value = custom[2].toLowerCase().replace(/^0x/, "");
            if (value !== "") entry.value = value;
            unknown.push(entry);
            i++;
            continue;
        }
        if (FLAGS.has(tok)) {
            setFlag(tok);
            i++;
            continue;
        }
        if (tok === "google_handshake_message" && tokens[i + 1] === "length:") {
            setOwn(extra, tok, "length: " + (tokens[i + 2] ?? ""));
            i += 3;
            continue;
        }
        if (tok === "preferred_address") {
            const buf: string[] = [];
            i++;
            while (i < tokens.length && !KNOWN_KEYS.has(tokens[i])) buf.push(tokens[i++]);
            setOwn(extra, tok, buf.join(" "));
            continue;
        }
        if (i + 1 >= tokens.length || KNOWN_KEYS.has(tokens[i + 1])) {
            // generic flag rule: a key directly followed by another known key has no value
            setFlag(tok);
            i++;
            continue;
        }
        const next = tokens[i + 1];
        if (next.startsWith('"')) {
            // quoted value, e.g. user_agent_id "Chrome/120 Linux x86_64"
            let j = i + 1;
            while (j < tokens.length) {
                const tj = tokens[j];
                if (tj.endsWith('"') && (j > i + 1 || tj.length > 1)) break;
                j++;
            }
            if (j >= tokens.length) j = tokens.length - 1;
            let joined = tokens.slice(i + 1, j + 1).join(" ");
            joined = joined.slice(1);
            if (joined.endsWith('"')) joined = joined.slice(0, -1);
            put(tok, joined);
            i = j + 1;
            continue;
        }
        put(tok, next);
        i += 2;
    }

    const result: Record<string, unknown> = { ...out };
    if (unknown.length > 0) result.unknown_parameters = unknown;
    if (Object.keys(extra).length > 0) result.chromium_extra = extra;
    result.chromium_raw = s;
    return result;
}

/** QUICParametersRestored keys (quic-13 section 5.4), for the T3 `QUIC_SESSION_TRANSPORT_PARAMETERS_RESUMED` row. */
export const PARAMETERS_RESTORED_KEYS: ReadonlySet<string> = new Set([
    "disable_active_migration",
    "max_idle_timeout",
    "max_udp_payload_size",
    "active_connection_id_limit",
    "initial_max_data",
    "initial_max_stream_data_bidi_local",
    "initial_max_stream_data_bidi_remote",
    "initial_max_stream_data_uni",
    "initial_max_streams_bidi",
    "initial_max_streams_uni",
    "max_datagram_frame_size",
    "grease_quic_bit",
    "reset_stream_at",
    "chromium_raw",
    "chromium_extra",
]);
