/**
 * qlog QUIC event schema: draft-ietf-quic-qlog-quic-events-13 (namespace `quic`).
 *
 * Source of truth: the CDDL of the PUBLISHED draft (scripts/cddl/quic-events-13.cddl, extracted verbatim),
 * digested in docs/dev/qlog-spec/quic-events.md. Interface and type names are the CDDL rule names.
 *
 * Union with the editor's copy (ARCHITECTURE §0 "Editor's-copy clarifications"): fields and values that the
 * editor's copy adds or renames are accepted as extra OPTIONAL members, marked `@editors-copy` (digest §14):
 * `address_v4` / `address_v6` (IPAddressPort), `datagram_payload_checksum(s)`, packet_dropped trigger
 * `"keys_unavailable"`, `reordering_threshold: "disabled"`, `ecn_state_updated.trigger`. Nothing from -13 is removed
 * (e.g. `frames_processed`, `PacketHeader.length` stay).
 *
 * Mapping conventions:
 * - `uint64` -> {@link Uint64} (`number | string`, main-schema-14 §11.3); `uint8/16/32`, `float32/64` -> `number`.
 * - `hexstring` -> {@link HexString}; `text` -> `string`; `bool` -> `boolean`.
 * - `[* T]` and `[+ T]` -> `T[]` (non-emptiness is documented, not enforced, so converters can build arrays).
 * - CDDL type sockets (`$Name /= ...`, open enums) -> `Known | (string & {})`: the known values autocomplete,
 *   any other string is still valid input and MUST be displayed as-is. Closed CDDL choices stay closed unions.
 * - Group sockets (`* $$quic-<event>-extension`): extra members may appear at runtime. They are deliberately NOT
 *   modelled as an index signature (that would hide typos in consumers); use {@link Extensible} to read them.
 * - Required/optional exactly as in the CDDL. Real producers omit required fields: read defensively.
 */
import type { HexString, RawInfo, TupleID, Uint64 } from "./main";
import type { HTTP3ApplicationError } from "./h3";

/** A string that is not one of the known literals of an open enum (keeps literal autocompletion). */
export type OpenString = string & {};

/** Event data plus whatever extension members (`* $$...-extension` group sockets) a producer added. */
export type Extensible<T> = T & { readonly [extension: string]: unknown };

// ================================================================================================
// QUIC data types (-13 §8)
// ================================================================================================

/** -13 §8.1. e.g. "00000001" (v1). Some producers emit "0x00000001": normalize for display. */
export type QuicVersion = HexString;

/** -13 §8.2. The empty string is a valid zero-length CID. */
export type ConnectionID = HexString;

/** -13 §8.3 */
export type Initiator = "local" | "remote";

/** -13 §8.4: human readable ("127.0.0.1", "2001:db8::1"), raw bytes (hexstring), or a hashed/redacted form. */
export type IPAddress = string;

/**
 * @editors-copy Replaces IPAddress + port in the editor's copy: `{ ip, port }`, or one application-defined
 * redacted string for the whole pair.
 */
export type IPAddressPort = { ip: IPAddress; port: number } | string;

/** -13 §8.5. One half (direction) of a four-tuple. */
export interface TupleEndpointInfo {
    ip_v4?: IPAddress;
    /** uint16 */
    port_v4?: number;
    ip_v6?: IPAddress;
    /** uint16 */
    port_v6?: number;
    /** @editors-copy */
    address_v4?: IPAddressPort;
    /** @editors-copy */
    address_v6?: IPAddressPort;
    /** `[+ ConnectionID]` */
    connection_ids?: ConnectionID[];
}

/** -13 §8.6 `$PacketType` values (note the casing of `0RTT` / `1RTT`). */
export const PACKET_TYPES = [
    "initial",
    "handshake",
    "0RTT",
    "1RTT",
    "retry",
    "version_negotiation",
    "stateless_reset",
    "unknown",
] as const;
export type KnownPacketType = (typeof PACKET_TYPES)[number];
/** -13 §8.6 `$PacketType` (open socket). */
export type PacketType = KnownPacketType | OpenString;

/** -13 §8.7 `$PacketNumberSpace` values. */
export const PACKET_NUMBER_SPACES = ["initial", "handshake", "application_data"] as const;
export type KnownPacketNumberSpace = (typeof PACKET_NUMBER_SPACES)[number];
/** -13 §8.7 `$PacketNumberSpace` (open socket). */
export type PacketNumberSpace = KnownPacketNumberSpace | OpenString;

/** -13 §8.9 `$TokenType` (open socket). */
export type TokenType = "retry" | "resumption" | OpenString;

/** -13 §8.9 */
export interface Token {
    type?: TokenType;
    /** decoded fields included in the token (typically: peer's IP address, creation time) */
    details?: { [key: string]: any };
    raw?: RawInfo;
}

/**
 * -13 §8.10 (`hexstring .size 16`). Always 16 bytes = 32 hex characters; the `.size 16` is a known spec bug
 * (the editor's copy drops it), so do not validate the length.
 */
export type StatelessResetToken = HexString;

/** -13 §8.8 */
export interface PacketHeader {
    packet_type: PacketType;
    /** uint64; only if packet_type === "unknown" (not varint encoded) */
    packet_type_bytes?: Uint64;
    /** only if packet_type === "1RTT" */
    spin_bit?: boolean;
    /** uint64; only if packet_type === "1RTT", and if the key phase was determined from the key_phase_bit */
    key_phase?: Uint64;
    /** only if packet_type === "1RTT", and if key_phase is not set */
    key_phase_bit?: boolean;
    /** uint8; only if packet_type is initial, handshake, 0RTT or 1RTT */
    packet_number_length?: number;
    /** uint64; only if packet_type is initial, handshake, 0RTT or 1RTT */
    packet_number?: Uint64;
    /** only if packet_type === "initial" || "retry" */
    token?: Token;
    /**
     * uint16; only if packet_type is initial, handshake or 0RTT. The long-header Length field (packet number plus
     * payload), NOT the packet size (that is `raw.length` of the packet event). Removed in the editor's copy.
     */
    length?: number;
    version?: QuicVersion;
    /** uint8 */
    scil?: number;
    /** uint8 */
    dcil?: number;
    scid?: ConnectionID;
    dcid?: ConnectionID;
}

/** -13 §8.11 `$KeyType` values. */
export const KEY_TYPES = [
    "server_initial_secret",
    "client_initial_secret",
    "server_handshake_secret",
    "client_handshake_secret",
    "server_0rtt_secret",
    "client_0rtt_secret",
    "server_1rtt_secret",
    "client_1rtt_secret",
] as const;
export type KnownKeyType = (typeof KEY_TYPES)[number];
/** -13 §8.11 `$KeyType` (open socket). */
export type KeyType = KnownKeyType | OpenString;

/** -13 §8.12 ECN codepoints in the IP header. */
export type ECN = "Not-ECT" | "ECT(1)" | "ECT(0)" | "CE";

/** -13 §5.2 */
export interface ALPNIdentifier {
    byte_value?: HexString;
    string_value?: string;
}

/** -13 §5.3 */
export interface PreferredAddress {
    ip_v4?: IPAddress;
    /** uint16 */
    port_v4?: number;
    ip_v6?: IPAddress;
    /** uint16 */
    port_v6?: number;
    /** @editors-copy */
    address_v4?: IPAddressPort;
    /** @editors-copy */
    address_v6?: IPAddressPort;
    connection_id: ConnectionID;
    stateless_reset_token: StatelessResetToken;
}

/** -13 §5.3 */
export interface UnknownParameter {
    id: Uint64;
    value?: HexString;
}

/** -13 §4.6 BaseConnectionStates */
export type BaseConnectionState = "attempted" | "handshake_started" | "handshake_complete" | "closed";
/** -13 §4.6 GranularConnectionStates */
export type GranularConnectionState =
    "peer_validated" | "early_write" | "handshake_confirmed" | "closing" | "draining" | "closed";
/** -13 §4.6 `$ConnectionState` (open socket). */
export type ConnectionState = BaseConnectionState | GranularConnectionState | OpenString;

/** -13 §5.13 */
export type StreamType = "unidirectional" | "bidirectional";

/** -13 §5.13 BaseStreamStates */
export type BaseStreamState = "idle" | "open" | "closed";
/** -13 §5.13 GranularStreamStates */
export type GranularStreamState =
    | "half_closed_local"
    | "half_closed_remote"
    | "ready"
    | "send"
    | "data_sent"
    | "reset_sent"
    | "reset_received"
    | "receive"
    | "size_known"
    | "data_read"
    | "reset_read"
    | "data_received"
    | "destroyed";
/** -13 §5.13 `$StreamState` (open socket). */
export type StreamState = BaseStreamState | GranularStreamState | OpenString;

/** -13 §5.15 `$DataLocation` (open socket). */
export type DataLocation = "application" | "transport" | "network" | OpenString;

/** -13 §5.15 `$DataMovedAdditionalInfo` (open socket). */
export type DataMovedAdditionalInfo = "fin_set" | "stream_reset" | OpenString;

/** -13 §5.17 `$BlockedState` (open socket). */
export type BlockedState = "blocked" | "unblocked" | OpenString;

/** -13 §5.17 `$BlockedReason` (open socket). */
export type BlockedReason =
    | "scheduling"
    | "pacing"
    | "amplification_protection"
    | "congestion_control"
    | "connection_flow_control"
    | "stream_flow_control"
    | "stream_id"
    | "application"
    | OpenString;

/** -13 §5.20. Not a full state machine; entries are not necessarily chronological. */
export type MigrationState =
    | "probing_started"
    | "probing_abandoned"
    | "probing_successful"
    | "migration_started"
    | "migration_abandoned"
    | "migration_complete";

/** -13 §5.21 `$TimerType` (open socket; a non-exhaustive list of typically employed timers). */
export type TimerType =
    "ack" | "pto" | "loss_timeout" | "path_validation" | "handshake_timeout" | "idle_timeout" | OpenString;

/** -13 §7.6 */
export type ECNState = "testing" | "unknown" | "failed" | "capable";

// ================================================================================================
// Errors (-13 §8.13.24 - §8.13.26)
// ================================================================================================

/** -13 §8.13.24 `$TransportError` values. There is no value for CRYPTO_ERROR: see {@link CryptoError}. */
export const TRANSPORT_ERRORS = [
    "no_error",
    "internal_error",
    "connection_refused",
    "flow_control_error",
    "stream_limit_error",
    "stream_state_error",
    "final_size_error",
    "frame_encoding_error",
    "transport_parameter_error",
    "connection_id_limit_error",
    "protocol_violation",
    "invalid_token",
    "application_error",
    "crypto_buffer_exceeded",
    "key_update_error",
    "aead_limit_reached",
    "no_viable_path",
    "unknown",
] as const;
export type KnownTransportError = (typeof TRANSPORT_ERRORS)[number];
/** -13 §8.13.24 `$TransportError` (open socket). */
export type TransportError = KnownTransportError | OpenString;

/**
 * -13 §8.13.26: all strings from "crypto_error_0x100" to "crypto_error_0x1ff"
 * (`text .regexp "crypto_error_0x1[0-9a-f][0-9a-f]"`). Match case-insensitively (digest §14 E18).
 */
export type CryptoError = `crypto_error_0x${string}`;

/**
 * -13 §8.13.25 `$ApplicationError` (open socket): `"unknown"` plus the values that application protocols add,
 * here HTTP/3 (h3-events-13 §4.3 `$ApplicationError /= HTTP3ApplicationError`).
 */
export type ApplicationError = "unknown" | HTTP3ApplicationError | OpenString;

/** -13 §8.13.20 */
export type ErrorSpace = "transport" | "application";

// ================================================================================================
// QUIC frames (-13 §8.13)
// ================================================================================================

/** -13 §8.13.1. One PaddingFrame SHOULD stand for all padding in the packet; byte count in `raw.payload_length`. */
export interface PaddingFrame {
    frame_type: "padding";
    raw?: RawInfo;
}

/** -13 §8.13.2 */
export interface PingFrame {
    frame_type: "ping";
    raw?: RawInfo;
}

/**
 * -13 §8.13.3 `AckRange = [1*2 uint64]`: either `[n]` or `[from, to]` (inclusive, `from` = lowest packet number).
 * Ranges are not necessarily ordered.
 */
export type AckRange = [from: Uint64, to?: Uint64];

/** -13 §8.13.3 */
export interface AckFrame {
    frame_type: "ack";
    /** float32, in ms */
    ack_delay?: number;
    /** `[+ AckRange]`, e.g. `[[1,2],[4,5],[7],[10,22]]` */
    acked_ranges?: AckRange[];
    ect1?: Uint64;
    ect0?: Uint64;
    ce?: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.4 */
export interface ResetStreamFrame {
    frame_type: "reset_stream";
    stream_id: Uint64;
    error: ApplicationError;
    /** if error === "unknown" */
    error_code?: Uint64;
    /** in bytes */
    final_size: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.5 */
export interface ResetStreamAtFrame {
    frame_type: "reset_stream_at";
    stream_id: Uint64;
    error: ApplicationError;
    /** if error === "unknown" */
    error_code?: Uint64;
    /** in bytes */
    final_size: Uint64;
    /** in bytes */
    reliable_size: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.6 */
export interface StopSendingFrame {
    frame_type: "stop_sending";
    stream_id: Uint64;
    error: ApplicationError;
    /** if error === "unknown" */
    error_code?: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.7. `raw` is REQUIRED here; the crypto data length is `raw.payload_length`. */
export interface CryptoFrame {
    frame_type: "crypto";
    offset: Uint64;
    raw: RawInfo;
}

/** -13 §8.13.8 */
export interface NewTokenFrame {
    frame_type: "new_token";
    token: Token;
    raw?: RawInfo;
}

/** -13 §8.13.9. The stream data length is `raw.payload_length`. */
export interface StreamFrame {
    frame_type: "stream";
    stream_id: Uint64;
    /** `.default 0` */
    offset?: Uint64;
    /** `.default false` */
    fin?: boolean;
    raw?: RawInfo;
}

/** -13 §8.13.10 */
export interface MaxDataFrame {
    frame_type: "max_data";
    maximum: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.11 */
export interface MaxStreamDataFrame {
    frame_type: "max_stream_data";
    stream_id: Uint64;
    maximum: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.12 */
export interface MaxStreamsFrame {
    frame_type: "max_streams";
    stream_type: StreamType;
    maximum: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.13 */
export interface DataBlockedFrame {
    frame_type: "data_blocked";
    limit: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.14 */
export interface StreamDataBlockedFrame {
    frame_type: "stream_data_blocked";
    stream_id: Uint64;
    limit: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.15 */
export interface StreamsBlockedFrame {
    frame_type: "streams_blocked";
    stream_type: StreamType;
    limit: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.16 */
export interface NewConnectionIDFrame {
    frame_type: "new_connection_id";
    sequence_number: Uint64;
    retire_prior_to: Uint64;
    /** uint8; mainly used if, e.g. for privacy reasons, the full connection_id cannot be logged */
    connection_id_length?: number;
    connection_id: ConnectionID;
    stateless_reset_token?: StatelessResetToken;
    raw?: RawInfo;
}

/** -13 §8.13.17 */
export interface RetireConnectionIDFrame {
    frame_type: "retire_connection_id";
    sequence_number: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.18 */
export interface PathChallengeFrame {
    frame_type: "path_challenge";
    /** always 64 bits */
    data?: HexString;
    raw?: RawInfo;
}

/** -13 §8.13.19 */
export interface PathResponseFrame {
    frame_type: "path_response";
    /** always 64 bits */
    data?: HexString;
    raw?: RawInfo;
}

/** -13 §8.13.20 */
export interface ConnectionCloseFrame {
    frame_type: "connection_close";
    error_space?: ErrorSpace;
    error?: TransportError | CryptoError | ApplicationError;
    /** if error === "unknown" */
    error_code?: Uint64;
    reason?: string;
    reason_bytes?: HexString;
    /** when error_space === "transport": a frame type string ("stream") for known types, a number otherwise */
    trigger_frame_type?: Uint64 | string;
    raw?: RawInfo;
}

/** -13 §8.13.21 */
export interface HandshakeDoneFrame {
    frame_type: "handshake_done";
    raw?: RawInfo;
}

/** -13 §8.13.22 */
export interface UnknownFrame {
    frame_type: "unknown";
    /** uint64, not varint encoded */
    frame_type_bytes: Uint64;
    raw?: RawInfo;
}

/** -13 §8.13.23. The datagram payload length is `raw.payload_length`. */
export interface DatagramFrame {
    frame_type: "datagram";
    raw?: RawInfo;
}

/** -13 §8.13 `QuicBaseFrames`, discriminated on `frame_type`. */
export type QuicFrame =
    | PaddingFrame
    | PingFrame
    | AckFrame
    | ResetStreamFrame
    | ResetStreamAtFrame
    | StopSendingFrame
    | CryptoFrame
    | NewTokenFrame
    | StreamFrame
    | MaxDataFrame
    | MaxStreamDataFrame
    | MaxStreamsFrame
    | DataBlockedFrame
    | StreamDataBlockedFrame
    | StreamsBlockedFrame
    | NewConnectionIDFrame
    | RetireConnectionIDFrame
    | PathChallengeFrame
    | PathResponseFrame
    | ConnectionCloseFrame
    | HandshakeDoneFrame
    | UnknownFrame
    | DatagramFrame;

/** Every `frame_type` value of {@link QuicFrame}, in -13 order. */
export const QUIC_FRAME_TYPES = [
    "padding",
    "ping",
    "ack",
    "reset_stream",
    "reset_stream_at",
    "stop_sending",
    "crypto",
    "new_token",
    "stream",
    "max_data",
    "max_stream_data",
    "max_streams",
    "data_blocked",
    "stream_data_blocked",
    "streams_blocked",
    "new_connection_id",
    "retire_connection_id",
    "path_challenge",
    "path_response",
    "connection_close",
    "handshake_done",
    "unknown",
    "datagram",
] as const satisfies readonly QuicFrame["frame_type"][];
export type QuicFrameType = QuicFrame["frame_type"];

/** The frame with the given `frame_type`, e.g. `QuicFrameOf<"ack">` is {@link AckFrame}. */
export type QuicFrameOf<T extends QuicFrameType> = Extract<QuicFrame, { frame_type: T }>;

/**
 * `$QuicFrame /= { * text => any }`: the socket admits any map. Frames defined by extensions (e.g. quic-go's
 * `ack_frequency`, `immediate_ack`) have this shape. Kept out of {@link QuicFrame} so that switching on
 * `frame_type` narrows; consumers must still have a default branch for unknown frame types at runtime.
 */
export interface QuicExtensionFrame {
    frame_type?: string;
    raw?: RawInfo;
    [field: string]: any;
}

const QUIC_FRAME_TYPE_SET: ReadonlySet<string> = new Set(QUIC_FRAME_TYPES);

/** True if `frame.frame_type` is one of the frame types defined by -13. */
export function isQuicFrame(frame: QuicFrame | QuicExtensionFrame): frame is QuicFrame {
    return typeof frame.frame_type === "string" && QUIC_FRAME_TYPE_SET.has(frame.frame_type);
}

// ================================================================================================
// Connectivity events (-13 §4)
// ================================================================================================

/** quic:server_listening (Extra, -13 §4.1) */
export interface QUICServerListening {
    ip_v4?: IPAddress;
    /** uint16 */
    port_v4?: number;
    ip_v6?: IPAddress;
    /** uint16 */
    port_v6?: number;
    /** @editors-copy */
    address_v4?: IPAddressPort;
    /** @editors-copy */
    address_v6?: IPAddressPort;
    /** the server will always answer client initials with a retry (no 1-RTT connection setups by choice) */
    retry_required?: boolean;
}

/** quic:connection_started (Base, -13 §4.2) */
export interface QUICConnectionStarted {
    local: TupleEndpointInfo;
    remote: TupleEndpointInfo;
}

/** -13 §4.3 `connection_closed.trigger` */
export type QUICConnectionClosedTrigger =
    "idle_timeout" | "application" | "error" | "version_mismatch" | "stateless_reset" | "aborted" | "unspecified";

/** quic:connection_closed (Base, -13 §4.3) */
export interface QUICConnectionClosed {
    /** which side closed the connection */
    initiator?: Initiator;
    connection_error?: TransportError | CryptoError;
    application_error?: ApplicationError;
    /** if connection_error or application_error === "unknown" */
    error_code?: Uint64;
    internal_code?: Uint64;
    reason?: string;
    trigger?: QUICConnectionClosedTrigger;
}

/** quic:connection_id_updated (Base, -13 §4.4) */
export interface QUICConnectionIDUpdated {
    initiator: Initiator;
    old?: ConnectionID;
    new?: ConnectionID;
}

/** quic:spin_bit_updated (Base, -13 §4.5) */
export interface QUICSpinBitUpdated {
    state: boolean;
}

/** quic:connection_state_updated (Base, -13 §4.6) */
export interface QUICConnectionStateUpdated {
    old?: ConnectionState;
    new: ConnectionState;
}

/** quic:tuple_assigned (Base, -13 §4.7) */
export interface QUICTupleAssigned {
    tuple_id: TupleID;
    /** the information for traffic going towards the remote receiver */
    tuple_remote?: TupleEndpointInfo;
    /** the information for traffic coming in at the local endpoint */
    tuple_local?: TupleEndpointInfo;
}

/** quic:mtu_updated (Extra, -13 §4.8) */
export interface QUICMTUUpdated {
    /** uint32 */
    old?: number;
    /** uint32 */
    new: number;
    /** `.default false`; MTU discovery stopped because a "good enough" packet size was found */
    done?: boolean;
}

// ================================================================================================
// Transport events (-13 §5)
// ================================================================================================

/** quic:version_information (Core, -13 §5.1) */
export interface QUICVersionInformation {
    /** `[+ QuicVersion]`; may include reserved (greased) versions */
    server_versions?: QuicVersion[];
    /** `[+ QuicVersion]` */
    client_versions?: QuicVersion[];
    chosen_version?: QuicVersion;
}

/** quic:alpn_information (Core, -13 §5.2) */
export interface QUICALPNInformation {
    server_alpns?: ALPNIdentifier[];
    client_alpns?: ALPNIdentifier[];
    chosen_alpn?: ALPNIdentifier;
}

/** quic:parameters_set (Core, -13 §5.3) */
export interface QUICParametersSet {
    initiator?: Initiator;
    /** true if valid session ticket was received */
    resumption_allowed?: boolean;
    /** true if early data extension was enabled on the TLS layer */
    early_data_enabled?: boolean;
    /** e.g. "AES_128_GCM_SHA256" */
    tls_cipher?: string;
    // RFC 9000
    original_destination_connection_id?: ConnectionID;
    initial_source_connection_id?: ConnectionID;
    retry_source_connection_id?: ConnectionID;
    stateless_reset_token?: StatelessResetToken;
    disable_active_migration?: boolean;
    max_idle_timeout?: Uint64;
    max_udp_payload_size?: Uint64;
    ack_delay_exponent?: Uint64;
    max_ack_delay?: Uint64;
    active_connection_id_limit?: Uint64;
    initial_max_data?: Uint64;
    initial_max_stream_data_bidi_local?: Uint64;
    initial_max_stream_data_bidi_remote?: Uint64;
    initial_max_stream_data_uni?: Uint64;
    initial_max_streams_bidi?: Uint64;
    initial_max_streams_uni?: Uint64;
    preferred_address?: PreferredAddress;
    unknown_parameters?: UnknownParameter[];
    /** RFC 9221 */
    max_datagram_frame_size?: Uint64;
    /** RFC 9287: true if present, absent or false if extension not negotiated */
    grease_quic_bit?: boolean;
    /** draft-ietf-quic-reliable-stream-reset: true if present, absent or false if extension not negotiated */
    reset_stream_at?: boolean;
}

/** quic:parameters_restored (Base, -13 §5.4) */
export interface QUICParametersRestored {
    // RFC 9000
    disable_active_migration?: boolean;
    max_idle_timeout?: Uint64;
    max_udp_payload_size?: Uint64;
    active_connection_id_limit?: Uint64;
    initial_max_data?: Uint64;
    initial_max_stream_data_bidi_local?: Uint64;
    initial_max_stream_data_bidi_remote?: Uint64;
    initial_max_stream_data_uni?: Uint64;
    initial_max_streams_bidi?: Uint64;
    initial_max_streams_uni?: Uint64;
    /** RFC 9221 */
    max_datagram_frame_size?: Uint64;
    /** RFC 9287; can only be restored at the client */
    grease_quic_bit?: boolean;
}

/** -13 §5.5 `packet_sent.trigger` */
export type QUICPacketSentTrigger =
    "retransmit_reordered" | "retransmit_timeout" | "pto_probe" | "retransmit_crypto" | "cc_bandwidth_probe";

/** quic:packet_sent (Core, -13 §5.5). Packet size: `raw.length` (header + payload + 16-byte AEAD tag). */
export interface QUICPacketSent {
    header: PacketHeader;
    frames?: QuicFrame[];
    /** only if header.packet_type === "stateless_reset"; always 128 bits */
    stateless_reset_token?: StatelessResetToken;
    /** `[+ QuicVersion]`; only if header.packet_type === "version_negotiation" */
    supported_versions?: QuicVersion[];
    raw?: RawInfo;
    /** uint32, locally unique id of the UDP datagram (coalescing) */
    datagram_id?: number;
    /** @editors-copy uint32 CRC32c of the UDP payload (replaces datagram_id) */
    datagram_payload_checksum?: number;
    /** `.default false` */
    is_mtu_probe_packet?: boolean;
    trigger?: QUICPacketSentTrigger;
}

/** -13 §5.6 `packet_received.trigger` */
export type QUICPacketReceivedTrigger = "keys_available";

/** quic:packet_received (Core, -13 §5.6) */
export interface QUICPacketReceived {
    header: PacketHeader;
    frames?: QuicFrame[];
    /** only if header.packet_type === "stateless_reset"; always 128 bits */
    stateless_reset_token?: StatelessResetToken;
    /** `[+ QuicVersion]`; only if header.packet_type === "version_negotiation" */
    supported_versions?: QuicVersion[];
    raw?: RawInfo;
    /** uint32 */
    datagram_id?: number;
    /** @editors-copy uint32 */
    datagram_payload_checksum?: number;
    /** "keys_available": the packet was buffered because it could not be decrypted before */
    trigger?: QUICPacketReceivedTrigger;
}

/**
 * -13 §5.7 `packet_dropped.trigger`. -13 spells `"key_unavailable"`; the editor's copy (and main-schema-14's
 * example) `"keys_unavailable"`: both are accepted.
 */
export type QUICPacketDroppedTrigger =
    | "internal_error"
    | "rejected"
    | "unsupported"
    | "invalid"
    | "duplicate"
    | "connection_unknown"
    | "decryption_failure"
    | "key_unavailable"
    | "keys_unavailable"
    | "general";

/** quic:packet_dropped (Base, -13 §5.7) */
export interface QUICPacketDropped {
    /** primarily packet_type, as other fields might not be decryptable or parsable */
    header?: PacketHeader;
    raw?: RawInfo;
    /** uint32 */
    datagram_id?: number;
    /** @editors-copy uint32 */
    datagram_payload_checksum?: number;
    details?: { [key: string]: any };
    trigger?: QUICPacketDroppedTrigger;
}

/** -13 §5.8 `packet_buffered.trigger` */
export type QUICPacketBufferedTrigger = "backpressure" | "keys_unavailable";

/** quic:packet_buffered (Base, -13 §5.8) */
export interface QUICPacketBuffered {
    /** primarily packet_type, as other elements might not be available yet */
    header?: PacketHeader;
    raw?: RawInfo;
    /** uint32 */
    datagram_id?: number;
    /** @editors-copy uint32 */
    datagram_payload_checksum?: number;
    trigger?: QUICPacketBufferedTrigger;
}

/** quic:packets_acked (Extra, -13 §5.9) */
export interface QUICPacketsAcked {
    packet_number_space?: PacketNumberSpace;
    /** `[+ uint64]` */
    packet_numbers?: Uint64[];
}

/** quic:udp_datagrams_sent (Extra, -13 §5.10). RawInfo covers the UDP payload only. */
export interface QUICUDPDatagramsSent {
    /** uint16; to support passing multiple at once */
    count?: number;
    /** `[+ RawInfo]` */
    raw?: RawInfo[];
    /** `[+ ECN]`; if not set, defaults to the value used on the last udp_datagrams_sent event */
    ecn?: ECN[];
    /** `[+ uint32]` */
    datagram_ids?: number[];
    /** @editors-copy `[+ uint32]` */
    datagram_payload_checksums?: number[];
}

/** quic:udp_datagrams_received (Extra, -13 §5.11). RawInfo covers the UDP payload only. */
export interface QUICUDPDatagramsReceived {
    /** uint16 */
    count?: number;
    /** `[+ RawInfo]` */
    raw?: RawInfo[];
    /** `[+ ECN]`; if not set, defaults to the value on the last udp_datagrams_received event */
    ecn?: ECN[];
    /** `[+ uint32]` */
    datagram_ids?: number[];
    /** @editors-copy `[+ uint32]` */
    datagram_payload_checksums?: number[];
}

/** quic:udp_datagram_dropped (Extra, -13 §5.12). RawInfo covers the UDP payload only. */
export interface QUICUDPDatagramDropped {
    raw?: RawInfo;
}

/** quic:stream_state_updated (Base, -13 §5.13) */
export interface QUICStreamStateUpdated {
    stream_id: Uint64;
    stream_type?: StreamType;
    old?: StreamState;
    new: StreamState;
    stream_side: "sending" | "receiving";
    /** stream state change was initiated by a local or a remote action */
    trigger?: "local" | "remote";
}

/** quic:frames_created (Extra, -13 §5.14.1) */
export interface QUICFramesCreated {
    frames: QuicFrame[];
    packet_numbers?: Uint64[];
}

/** quic:frames_parsed (Extra, -13 §5.14.2) */
export interface QUICFramesParsed {
    frames: QuicFrame[];
    packet_numbers?: Uint64[];
}

/** quic:frames_processed (Extra, -13 §5.14.3; removed in the editor's copy, still accepted) */
export interface QUICFramesProcessed {
    frames: QuicFrame[];
    packet_numbers?: Uint64[];
}

/** quic:stream_data_moved (Base, -13 §5.15). Byte count: `raw.length`. */
export interface QUICStreamDataMoved {
    stream_id?: Uint64;
    offset?: Uint64;
    from?: DataLocation;
    to?: DataLocation;
    additional_info?: DataMovedAdditionalInfo;
    raw?: RawInfo;
}

/** quic:datagram_data_moved (Base, -13 §5.16) */
export interface QUICDatagramDataMoved {
    from?: DataLocation;
    to?: DataLocation;
    raw?: RawInfo;
}

/** quic:connection_data_blocked_updated (Extra, -13 §5.17) */
export interface QUICConnectionDataBlockedUpdated {
    old?: BlockedState;
    new: BlockedState;
    reason?: BlockedReason;
}

/** quic:stream_data_blocked_updated (Extra, -13 §5.18) */
export interface QUICStreamDataBlockedUpdated {
    old?: BlockedState;
    new: BlockedState;
    stream_id: Uint64;
    reason?: BlockedReason;
}

/** quic:datagram_data_blocked_updated (Extra, -13 §5.19) */
export interface QUICDatagramDataBlockedUpdated {
    old?: BlockedState;
    new: BlockedState;
    reason?: BlockedReason;
}

/** quic:migration_state_updated (Extra, -13 §5.20) */
export interface QUICMigrationStateUpdated {
    old?: MigrationState;
    new: MigrationState;
    tuple_id?: TupleID;
    /** the information for traffic going towards the remote receiver */
    tuple_remote?: TupleEndpointInfo;
    /** the information for traffic coming in at the local endpoint */
    tuple_local?: TupleEndpointInfo;
}

/** quic:timer_updated (Extra, -13 §5.21) */
export interface QUICTimerUpdated {
    timer_type?: TimerType;
    /** uint64; to disambiguate in case there are multiple timers of the same type */
    timer_id?: Uint64;
    packet_number_space?: PacketNumberSpace;
    event_type: "set" | "expired" | "cancelled";
    /** float32; if event_type === "set": ms from this event's timestamp until the timer should trigger */
    delta?: number;
}

// ================================================================================================
// Security events (-13 §6)
// ================================================================================================

/** -13 §6.1/§6.2 key event trigger (initial, handshake and 0-RTT keys are generated by TLS) */
export type QUICKeyTrigger = "tls" | "remote_update" | "local_update";

/** quic:key_updated (Base, -13 §6.1) */
export interface QUICKeyUpdated {
    key_type: KeyType;
    old?: HexString;
    new?: HexString;
    /** uint64; needed for 1RTT key updates */
    key_phase?: Uint64;
    trigger?: QUICKeyTrigger;
}

/** quic:key_discarded (Base, -13 §6.2) */
export interface QUICKeyDiscarded {
    key_type: KeyType;
    key?: HexString;
    /** uint64; needed for 1RTT key updates */
    key_phase?: Uint64;
    trigger?: QUICKeyTrigger;
}

// ================================================================================================
// Recovery events (-13 §7)
// ================================================================================================

/** quic:recovery_parameters_set (Base, -13 §7.1) */
export interface QUICRecoveryParametersSet {
    /** uint16, in amount of packets; `"disabled"` is @editors-copy (quic-go emits it) */
    reordering_threshold?: number | "disabled";
    /** float32, as RTT multiplier */
    time_threshold?: number;
    /** uint16, in ms */
    timer_granularity: number;
    /** float32, in ms */
    initial_rtt?: number;
    /** uint32, in bytes; could be updated after PMTUD */
    max_datagram_size?: number;
    /** in bytes */
    initial_congestion_window?: Uint64;
    /** in bytes; could change when max_datagram_size changes */
    minimum_congestion_window?: Uint64;
    /** float32 */
    loss_reduction_factor?: number;
    /** uint16, as PTO multiplier */
    persistent_congestion_threshold?: number;
}

/** quic:recovery_metrics_updated (Core, -13 §7.2). All RTT fields are float32 ms. */
export interface QUICRecoveryMetricsUpdated {
    min_rtt?: number;
    smoothed_rtt?: number;
    latest_rtt?: number;
    rtt_variance?: number;
    /** uint16 */
    pto_count?: number;
    /** in bytes */
    congestion_window?: Uint64;
    /** in bytes */
    bytes_in_flight?: Uint64;
    /** in bytes */
    ssthresh?: Uint64;
    /** sum of all packet number spaces */
    packets_in_flight?: Uint64;
    /** in bits per second */
    pacing_rate?: Uint64;
}

/** quic:congestion_state_updated (Base, -13 §7.3). States and trigger are free text. */
export interface QUICCongestionStateUpdated {
    old?: string;
    new: string;
    trigger?: string;
}

/** -13 §7.4 `packet_lost.trigger` */
export type QUICPacketLostTrigger = "reordering_threshold" | "time_threshold" | "pto_expired";

/** quic:packet_lost (Core, -13 §7.4) */
export interface QUICPacketLost {
    /** should include at least the packet_type and packet_number */
    header?: PacketHeader;
    /** not all implementations keep track of full packets, so these are optional */
    frames?: QuicFrame[];
    /** `.default false` */
    is_mtu_probe_packet?: boolean;
    trigger?: QUICPacketLostTrigger;
}

/** quic:marked_for_retransmit (Extra, -13 §7.5) */
export interface QUICMarkedForRetransmit {
    /** `[+ $QuicFrame]` */
    frames: QuicFrame[];
}

/** quic:ecn_state_updated (Extra, -13 §7.6) */
export interface QUICECNStateUpdated {
    old?: ECNState;
    new: ECNState;
    /** @editors-copy */
    trigger?: string;
}

/** -13 §2 `QuicEventData`: every `quic:*` event data type. */
export type QuicEventData =
    | QUICServerListening
    | QUICConnectionStarted
    | QUICConnectionClosed
    | QUICConnectionIDUpdated
    | QUICSpinBitUpdated
    | QUICConnectionStateUpdated
    | QUICTupleAssigned
    | QUICMTUUpdated
    | QUICVersionInformation
    | QUICALPNInformation
    | QUICParametersSet
    | QUICParametersRestored
    | QUICPacketSent
    | QUICPacketReceived
    | QUICPacketDropped
    | QUICPacketBuffered
    | QUICPacketsAcked
    | QUICUDPDatagramsSent
    | QUICUDPDatagramsReceived
    | QUICUDPDatagramDropped
    | QUICStreamStateUpdated
    | QUICFramesCreated
    | QUICFramesParsed
    | QUICFramesProcessed
    | QUICStreamDataMoved
    | QUICDatagramDataMoved
    | QUICConnectionDataBlockedUpdated
    | QUICStreamDataBlockedUpdated
    | QUICDatagramDataBlockedUpdated
    | QUICMigrationStateUpdated
    | QUICTimerUpdated
    | QUICKeyUpdated
    | QUICKeyDiscarded
    | QUICRecoveryParametersSet
    | QUICRecoveryMetricsUpdated
    | QUICCongestionStateUpdated
    | QUICPacketLost
    | QUICMarkedForRetransmit
    | QUICECNStateUpdated;
