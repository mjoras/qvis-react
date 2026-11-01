// Wire error code -> qlog error name tables (converters spec section 8.5.5, decision C10).

/** RFC 9000 section 20.1 (quic-13 $TransportError). */
const TRANSPORT_ERROR_NAMES: Readonly<Record<number, string>> = {
    0x0: "no_error",
    0x1: "internal_error",
    0x2: "connection_refused",
    0x3: "flow_control_error",
    0x4: "stream_limit_error",
    0x5: "stream_state_error",
    0x6: "final_size_error",
    0x7: "frame_encoding_error",
    0x8: "transport_parameter_error",
    0x9: "connection_id_limit_error",
    0xa: "protocol_violation",
    0xb: "invalid_token",
    0xc: "application_error",
    0xd: "crypto_buffer_exceeded",
    0xe: "key_update_error",
    0xf: "aead_limit_reached",
    0x10: "no_viable_path",
};

/**
 * RFC 9114 section 8.1 with the names of h3-13 HTTP3ApplicationError. Codes that only the editor's copy names
 * (0x10e http_message_error, 0x200-0x202 qpack_*, 0x33 http_datagram_error) are deliberately absent: they become
 * `error: "unknown"` + `error_code`, which keeps the output valid against the strict -13 CDDL.
 */
const H3_APP_ERROR_NAMES: Readonly<Record<number, string>> = {
    0x100: "http_no_error",
    0x101: "http_general_protocol_error",
    0x102: "http_internal_error",
    0x103: "http_stream_creation_error",
    0x104: "http_closed_critical_stream",
    0x105: "http_frame_unexpected",
    0x106: "http_frame_error",
    0x107: "http_excessive_load",
    0x108: "http_id_error",
    0x109: "http_settings_error",
    0x10a: "http_missing_settings",
    0x10b: "http_request_rejected",
    0x10c: "http_request_cancelled",
    0x10d: "http_request_incomplete",
    0x10f: "http_connect_error",
    0x110: "http_version_fallback",
};

export function transportErrorName(code: number | undefined): string | undefined {
    return code === undefined ? undefined : TRANSPORT_ERROR_NAMES[code];
}

/** 0x100-0x1ff -> "crypto_error_0x1NN" (quic-13 CryptoError, lowercase hex). */
export function cryptoErrorName(code: number | undefined): string | undefined {
    if (code === undefined || code < 0x100 || code > 0x1ff) return undefined;
    return "crypto_error_0x" + code.toString(16);
}

export function h3AppErrorName(code: number | undefined): string | undefined {
    return code === undefined ? undefined : H3_APP_ERROR_NAMES[code];
}
