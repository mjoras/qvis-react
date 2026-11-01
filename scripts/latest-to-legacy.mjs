#!/usr/bin/env node
// Down-converts latest-draft qlog to qlog draft-02, the format the ORIGINAL qvis
// (qvis.quictools.info) renders best, so that the same connection can be shown in
// the old qvis and in qvis-react and the screenshots compared.
//
//   input : qlog per draft-ietf-quic-qlog-main-schema-14, -quic-events-13,
//           -h3-events-13; contained JSON (.qlog, QlogFile) or JSON-SEQ (.sqlog,
//           QlogFileSeq). Any number of files.
//   output: ONE contained draft-02 JSON file (qlog_version "draft-02",
//           qlog_format "JSON") holding every trace of every input, in order.
//
// Target format: draft-marx-qlog-main-schema-02 and
// draft-marx-qlog-event-definitions-quic-h3-02, as read by qvis'
// QlogLoaderV2 / DirectEventParser (src/data/QlogLoaderV2.ts, QlogSchema02.ts).
// Event names become "category:type" with the draft-02 categories
// (connectivity, security, transport, recovery, http, generic, simulation).
//
// Time: each trace is mapped onto the qvis time model so that both tools show
// identical relative and absolute times (docs/dev/parity/data-model.md §3.16.3):
//   case R (reference_time with a dated epoch, e.g. quic-go "system" clock):
//       time_format "relative", reference_time = epoch in Unix ms (string),
//       times copied verbatim. qvis: relativeTime = t, absoluteTime = epoch + t.
//   case A (Unix epoch, or no reference_time): time_format "absolute", times
//       copied verbatim. qvis: relativeTime = t - t_first, absoluteTime = t.
//   case U (epoch "unknown", monotonic clock): time_format "relative",
//       reference_time "0", times shifted so the first event is at 0. This is
//       what qvis-react shows for such traces (relative and absolute time both
//       start at 0) and it keeps qvis' sequence-diagram fallback alignment
//       working (configuration.time_offset would disable it, so it is not used).
//   relative_to_previous_event (delta) times are decoded first. Events are
//   stable-sorted on the resolved time (qvis would alert() and sort otherwise).
//
// qvis hints (on by default, --no-qvis-hints drops them). draft-02 allows extra
// fields everywhere; these are fields that qvis reads but the draft-02 text names
// differently or not at all. Without them some views stay empty or wrong:
//   - frames[].frame_size: total wire size of every frame of a packet, written
//     only when the size of EVERY frame of that packet is known (from raw.length,
//     PADDING raw.payload_length, or a computed STREAM/CRYPTO/DATAGRAM header,
//     incl. the LEN-bit rule), or when exactly one non-STREAM frame has no size
//     (it is then raw.payload_length minus the others). Where every size is
//     logged/computable these are qvis-react's sizes (src/components/
//     packetizationdiagram/renderer/quicFrameSizes.ts); qvis then uses its
//     "explicit" sizing mode. Without it, qvis' guesstimate mode drops the frames
//     of most packets (Q-P1 + Q-F3) and whole HTTP/3 frames vanish.
//   - frame "length" on new_connection_id (CID length) and new_token (token
//     length): QlogSchema02 / draft-02-era producers used "length"; the draft-02
//     text says connection_id_length / token.length (both are written).
//   - http frame_created/frame_parsed "byte_length" (string): qvis'
//     packetization diagram reads it; draft-02 calls it "length" (both written).
//   - priority_update frame "element_id" + "value": the shape qvis' multiplexing
//     waterfall reads (priority_field_value is kept too).
//
// Values are never compensated for qvis bugs (e.g. qvis treats raw.payload_length
// as including the AEAD tag; draft-02 and the latest drafts both exclude it).
// qlog_version / qlog_format are written first; if a title or description inside
// the first 1024 characters contains "NDJSON" or "JSON-SEQ" (e.g. quic-go's
// "qlog JSON-SEQ file written by ..."), whitespace is inserted after qlog_format,
// because qvis sniffs the serialization from those characters.
//
// Usage: node scripts/latest-to-legacy.mjs [options] <in.qlog|in.sqlog>... [-o out.qlog]
// No npm dependencies; Node 18+. Also importable: convertLatestToLegacy(), etc.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RS = '\x1e';
const TOOL = 'latest-to-legacy';
const LATEST_CONTAINED = 'urn:ietf:params:qlog:file:contained';
const LATEST_SEQUENTIAL = 'urn:ietf:params:qlog:file:sequential';

// ---------------------------------------------------------------------------
// small helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** uint64 (number or decimal string) -> number; anything else -> undefined */
function u64(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return Number(v);
  return undefined;
}

/** QUIC varint size (RFC 9000 §16), minimal encoding */
const vlie = (v) => (v <= 63 ? 1 : v <= 16383 ? 2 : v <= 1073741823 ? 4 : 8);

const hexLen = (h) => (typeof h === 'string' ? Math.floor(h.replace(/^0x/i, '').length / 2) : undefined);
const hexToLatin1 = (h) => h.replace(/^0x/i, '').replace(/../g, (b) => String.fromCharCode(parseInt(b, 16)));

/** copies every key of src not listed in `skip` into dst (keeps extension fields) */
function copyRest(src, dst, skip) {
  if (!isObj(src)) return dst;
  for (const [k, v] of Object.entries(src)) {
    if (!skip.includes(k) && !(k in dst)) dst[k] = v;
  }
  return dst;
}

/** sets dst[k] = v unless v is undefined */
function put(dst, k, v) {
  if (v !== undefined) dst[k] = v;
  return dst;
}

// RFC 3339 -> ms since the Unix epoch, keeping sub-ms precision (main-schema digest P9)
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
function parseRfc3339Ms(s) {
  if (typeof s !== 'string') return null;
  const m = RFC3339.exec(s.trim());
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const [, Y, Mo, D, h, mi, sec, frac, z, sign, oh, om] = m;
  const d = new Date(0);
  d.setUTCFullYear(+Y, +Mo - 1, +D);
  d.setUTCHours(+h, +mi, Math.min(+sec, 59), 0);
  let ms = d.getTime() + (frac ? parseFloat(frac) * 1000 : 0);
  if (z !== 'Z' && z !== 'z') ms -= (sign === '+' ? 1 : -1) * (+oh * 60 + +om) * 60000;
  return ms;
}

/** epoch of a latest-draft ReferenceTime in Unix ms; 0 = Unix epoch / absent; null = unknown */
function epochMsOf(ref) {
  if (ref === undefined) return 0; // CDDL defaults: system clock, Unix epoch
  if (!isObj(ref)) {
    const n = Number(ref);
    return Number.isFinite(n) ? n : null;
  }
  if (ref.epoch === undefined || ref.epoch === 'unknown') return null;
  return parseRfc3339Ms(ref.epoch);
}

// ---------------------------------------------------------------------------
// diagnostics

class Diag {
  constructor() {
    this.messages = [];
    this.counts = new Map();
  }
  warn(msg) {
    this.messages.push(msg);
  }
  once(key, msg) {
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    if (n === 1) this.messages.push(msg);
  }
}

// ---------------------------------------------------------------------------
// input parsing

/**
 * Parses one latest-draft file (contained JSON or JSON-SEQ) into
 * { header, traces: [{ trace, events } | { error }] }.
 */
export function parseLatest(text, name = 'input', diag = new Diag()) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmed = text.trimStart();
  let header;
  let traces = [];

  const parseSeq = () => {
    let records = text.split(RS).map((s) => s.trim()).filter(Boolean);
    if (records.length === 1 && !trimmed.startsWith(RS)) {
      // no record separators: tolerate newline-delimited records
      records = text.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    const objs = [];
    records.forEach((r, i) => {
      try {
        objs.push(JSON.parse(r));
      } catch (e) {
        if (i === records.length - 1) diag.warn(`${name}: ignoring truncated last record (${e.message})`);
        else throw new Error(`${name}: record ${i + 1} is not valid JSON: ${e.message}`);
      }
    });
    if (!objs.length || !isObj(objs[0])) throw new Error(`${name}: empty JSON-SEQ file`);
    header = objs[0];
    if (!isObj(header.trace)) throw new Error(`${name}: JSON-SEQ header record has no "trace" object`);
    traces = [{ trace: header.trace, events: objs.slice(1) }];
  };

  if (trimmed.startsWith(RS)) {
    parseSeq();
  } else {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = undefined;
    }
    if (obj === undefined) {
      parseSeq();
    } else {
      header = obj;
      if (Array.isArray(obj.traces)) {
        traces = obj.traces.map((t) =>
          isObj(t) && typeof t.error_description === 'string' ? { error: t } : { trace: t, events: Array.isArray(t.events) ? t.events : [] },
        );
      } else if (isObj(obj.trace)) {
        traces = [{ trace: obj.trace, events: Array.isArray(obj.events) ? obj.events : [] }];
      } else if (obj.traces === undefined) {
        traces = [];
      } else {
        throw new Error(`${name}: "traces" is not an array`);
      }
    }
  }

  if (!isObj(header)) throw new Error(`${name}: not a qlog file`);
  if (header.qlog_version !== undefined) {
    throw new Error(`${name}: has qlog_version "${header.qlog_version}"; this tool converts latest-draft qlog (file_schema) only`);
  }
  if (header.file_schema !== LATEST_CONTAINED && header.file_schema !== LATEST_SEQUENTIAL) {
    diag.warn(`${name}: unexpected file_schema ${JSON.stringify(header.file_schema)} (converting anyway)`);
  }
  return { header, traces };
}

// ---------------------------------------------------------------------------
// shared data mappers (latest -> draft-02)

/** Token {type?, details?, raw?: RawInfo} -> draft-02 Token {type?, length?, data?, details?} */
function mapToken(t) {
  if (!isObj(t)) return t;
  const out = {};
  put(out, 'type', t.type);
  put(out, 'length', u64(t.raw?.length) ?? hexLen(t.raw?.data));
  put(out, 'data', t.raw?.data);
  put(out, 'details', t.details);
  return copyRest(t, out, ['type', 'details', 'raw']);
}

/** StatelessResetToken (hexstring) -> draft-02 Token */
function mapResetToken(hex) {
  if (typeof hex !== 'string') return hex;
  return { type: 'stateless_reset', length: hexLen(hex), data: hex };
}

/** PacketHeader: draft-02 has the same members; the -13 additions are kept as extra fields */
function mapHeader(h) {
  if (!isObj(h)) return h;
  const out = {};
  put(out, 'packet_type', h.packet_type);
  put(out, 'packet_number', h.packet_number);
  put(out, 'flags', h.flags);
  if (h.token !== undefined) out.token = mapToken(h.token);
  put(out, 'length', h.length);
  for (const k of ['version', 'scil', 'dcil', 'scid', 'dcid']) put(out, k, h[k]);
  return copyRest(h, out, ['token']);
}

/** RawInfo is identical in draft-02 */
const mapRaw = (r) => (isObj(r) ? { ...r } : r);

/** text form of an error that may be "unknown" + numeric error_code (latest) */
function errorCode(error, code) {
  if (error !== undefined && !(error === 'unknown' && code !== undefined)) return error;
  return code;
}

// ---- QUIC frames ----------------------------------------------------------

const DATA_FRAMES = new Set(['stream', 'crypto', 'datagram']);

/** draft-02 frame.length semantics (data length of STREAM/CRYPTO, token / CID length) */
function frameDataLength(f) {
  if (!isObj(f)) return undefined;
  switch (f.frame_type) {
    case 'stream':
    case 'crypto':
    case 'datagram':
      return u64(f.raw?.payload_length) ?? u64(f.raw?.length) ?? u64(f.length);
    case 'new_token':
      return u64(f.token?.raw?.length) ?? hexLen(f.token?.raw?.data);
    case 'new_connection_id':
      return u64(f.connection_id_length) ?? hexLen(f.connection_id);
    default:
      return undefined;
  }
}

/** computed STREAM/CRYPTO/DATAGRAM header length (minimal varints, Length field present) */
function dataFrameHeaderLength(f, len) {
  switch (f.frame_type) {
    case 'stream': {
      const off = u64(f.offset) ?? 0;
      return 1 + vlie(u64(f.stream_id) ?? 0) + (off > 0 ? vlie(off) : 0) + vlie(len);
    }
    case 'crypto':
      return 1 + vlie(u64(f.offset) ?? 0) + vlie(len);
    case 'datagram':
      return 1 + vlie(len);
  }
  return 1;
}

/** total wire size of a latest-draft frame, or undefined when unknown */
function frameWireInfo(f) {
  if (!isObj(f)) return undefined;
  const rawLen = u64(f.raw?.length);
  const rawPl = u64(f.raw?.payload_length);
  if (f.frame_type === 'padding') {
    const v = rawPl ?? rawLen;
    return v === undefined ? undefined : { size: v, computed: false };
  }
  if (DATA_FRAMES.has(f.frame_type)) {
    if (rawLen !== undefined && rawPl !== undefined && rawLen > rawPl) return { size: rawLen, computed: false };
    const len = frameDataLength(f);
    if (len === undefined) return undefined;
    return { size: dataFrameHeaderLength(f, len) + len, computed: true };
  }
  return rawLen === undefined ? undefined : { size: rawLen, computed: false };
}

/**
 * packet payload length as qvis-react derives it (quicFrameSizes.splitPacket);
 * `logged` is false when it is qvis' 4-byte-header estimate instead of raw.payload_length
 */
function packetPayloadLength(raw, packetType) {
  const total = u64(raw?.length);
  if (total === undefined) return { payload: undefined, logged: false };
  const pl = u64(raw?.payload_length);
  const TAG = 16;
  if (pl) {
    if (packetType === 'version_negotiation') return { payload: pl, logged: true };
    return { payload: total - pl - TAG < 1 ? pl - TAG : pl, logged: true };
  }
  return { payload: total - Math.min(4, total) - TAG, logged: false };
}

/**
 * frame_size per frame (qvis "explicit" mode), or null when any frame's size is
 * unknown (then qvis guesstimates, as qvis-react does).
 *
 * One exception: a packet in which exactly ONE frame (not a STREAM frame) has no
 * logged size, typically the ACK of an ACK-only or ACK+STREAM packet. Its size
 * follows exactly from the logged raw.payload_length minus the other frames'
 * sizes (the payload is nothing but frames). For a single-frame packet this is
 * also what qvis-react's guesstimate gives it (the whole leftover goes to that
 * frame); for multi-frame packets qvis-react guesstimates (STREAM = 1 + length,
 * rest shared), so the frame boundaries differ by a few bytes while the STREAM
 * payload bytes per stream are identical. qvis' own guesstimate cannot handle
 * such packets: it subtracts the AEAD tag from raw.payload_length (Q-P1), the
 * leftover goes negative and qvis then drops all frames of the packet (Q-F3),
 * which also loses their STREAM bytes and with them whole HTTP/3 DATA frames.
 * Packets with two or more unsized frames get no frame_size (no guessing).
 */
function frameSizes(frames, { payload: payloadLength, logged }) {
  if (!frames.length) return null;
  const wire = frames.map(frameWireInfo);
  if (!wire.every((w) => w !== undefined)) {
    const unknown = [];
    wire.forEach((w, i) => w === undefined && unknown.push(i));
    const u = unknown[0];
    if (unknown.length !== 1 || !logged || payloadLength === undefined || !isObj(frames[u]) || frames[u].frame_type === 'stream') return null;
    const known = wire.reduce((a, w) => a + (w ? w.size : 0), 0);
    const rest = payloadLength - known;
    if (!(rest > 0)) return null;
    const sizes = wire.map((w) => (w ? w.size : rest));
    return sizes;
  }
  const sizes = wire.map((w) => w.size);
  if (payloadLength !== undefined) {
    // LEN-bit rule (packetization-diagram.md §9.4.3): the last STREAM/DATAGRAM frame may omit its Length field
    const offset = payloadLength - sizes.reduce((a, b) => a + b, 0);
    const i = frames.length - 1;
    const last = frames[i];
    const len = frameDataLength(last);
    if (offset < 0 && wire[i].computed && (last.frame_type === 'stream' || last.frame_type === 'datagram') && len !== undefined && -offset === vlie(len)) {
      sizes[i] -= -offset;
    }
  }
  return sizes;
}

function mapFrame(f, hints) {
  if (!isObj(f)) return f;
  const t = f.frame_type;
  const out = { frame_type: t };
  switch (t) {
    case 'padding':
      // draft-02: length = total frame length (optional). Not written: qvis reads a frame's
      // "length" as data length and would draw the padding as payload (qvis-react: header-only).
      put(out, 'payload_length', u64(f.raw?.payload_length) ?? u64(f.raw?.length));
      return copyRest(f, out, ['raw']);
    case 'ping':
    case 'handshake_done':
      return copyRest(f, out, ['raw']);
    case 'ack':
      for (const k of ['ack_delay', 'acked_ranges', 'ect1', 'ect0', 'ce']) put(out, k, f[k]);
      return copyRest(f, out, ['raw']);
    case 'reset_stream':
    case 'stop_sending':
    case 'reset_stream_at':
      put(out, 'stream_id', f.stream_id);
      put(out, 'error_code', errorCode(f.error, f.error_code));
      put(out, 'final_size', f.final_size);
      put(out, 'reliable_size', f.reliable_size);
      return copyRest(f, out, ['raw', 'error', 'error_code']);
    case 'crypto':
      put(out, 'offset', f.offset ?? 0);
      put(out, 'length', frameDataLength(f));
      return copyRest(f, out, ['raw']);
    case 'new_token':
      if (f.token !== undefined) out.token = mapToken(f.token);
      if (hints) put(out, 'length', frameDataLength(f));
      return copyRest(f, out, ['raw']);
    case 'stream':
      put(out, 'stream_id', f.stream_id);
      out.offset = f.offset ?? 0; // draft-02: offset and length MUST always be set
      put(out, 'length', frameDataLength(f));
      if (f.fin === true) out.fin = true; // draft-02: MUST only be set if true
      put(out, 'raw', f.raw?.data); // draft-02 StreamFrame.raw is bytes
      return copyRest(f, out, ['raw', 'fin', 'length']);
    case 'max_data':
    case 'data_blocked':
    case 'max_stream_data':
    case 'stream_data_blocked':
    case 'max_streams':
    case 'streams_blocked':
      for (const k of ['stream_type', 'stream_id', 'maximum', 'limit']) put(out, k, f[k]);
      return copyRest(f, out, ['raw']);
    case 'new_connection_id':
      for (const k of ['sequence_number', 'retire_prior_to', 'connection_id_length', 'connection_id']) put(out, k, f[k]);
      if (f.stateless_reset_token !== undefined) out.stateless_reset_token = mapResetToken(f.stateless_reset_token);
      if (hints) put(out, 'length', frameDataLength(f));
      return copyRest(f, out, ['raw']);
    case 'retire_connection_id':
      put(out, 'sequence_number', f.sequence_number);
      return copyRest(f, out, ['raw']);
    case 'path_challenge':
    case 'path_response':
      put(out, 'data', f.data);
      return copyRest(f, out, ['raw']);
    case 'connection_close':
      put(out, 'error_space', f.error_space);
      put(out, 'error_code', errorCode(f.error, f.error_code));
      put(out, 'raw_error_code', u64(f.error_code));
      put(out, 'reason', f.reason ?? (typeof f.reason_bytes === 'string' ? hexToLatin1(f.reason_bytes) : undefined));
      put(out, 'trigger_frame_type', f.trigger_frame_type);
      return copyRest(f, out, ['raw', 'error', 'error_code']);
    case 'datagram':
      put(out, 'length', frameDataLength(f));
      put(out, 'raw', f.raw?.data);
      return copyRest(f, out, ['raw']);
    case 'unknown':
      put(out, 'raw_frame_type', f.frame_type_bytes);
      put(out, 'raw_length', u64(f.raw?.length));
      put(out, 'raw', f.raw?.data);
      return copyRest(f, out, ['raw', 'frame_type_bytes']);
    default:
      // extension frames (ack_frequency, immediate_ack, ...): verbatim
      return { ...f };
  }
}

/** maps a frames array; adds frame_size (qvis hint) when every frame's size is known */
function mapFrames(frames, hints, payloadInfo) {
  if (!Array.isArray(frames)) return frames;
  const out = frames.map((f) => mapFrame(f, hints));
  if (hints) {
    const sizes = frameSizes(frames, payloadInfo);
    if (sizes) out.forEach((f, i) => isObj(f) && (f.frame_size = sizes[i]));
  }
  return out;
}

// ---- HTTP/3 ---------------------------------------------------------------

const fieldName = (h) => (h.name !== undefined ? h.name : typeof h.name_bytes === 'string' ? hexToLatin1(h.name_bytes) : undefined);
const fieldValue = (h) => (h.value !== undefined ? h.value : typeof h.value_bytes === 'string' ? hexToLatin1(h.value_bytes) : undefined);

function mapHTTPField(h) {
  if (!isObj(h)) return h;
  const out = {};
  put(out, 'name', fieldName(h));
  put(out, 'value', fieldValue(h));
  return copyRest(h, out, []);
}

function h3FrameTypeNumber(f) {
  switch (f?.frame_type) {
    case 'data': return 0x00;
    case 'headers': return 0x01;
    case 'cancel_push': return 0x03;
    case 'settings': return 0x04;
    case 'push_promise': return 0x05;
    case 'goaway': return 0x07;
    case 'origin': return 0x0c;
    case 'max_push_id': return 0x0d;
    case 'priority_update': return f.push_id !== undefined ? 0xf0701 : 0xf0700;
    case 'reserved':
    case 'unknown': return u64(f.frame_type_bytes) ?? 0;
    default: return 0x00;
  }
}

/** HTTP/3 frame PAYLOAD length (draft-02 event "length"), as qvis-react's h3FramePayloadLength */
function h3FramePayloadLength(f) {
  const raw = f?.raw;
  if (!isObj(raw)) return undefined;
  const pl = u64(raw.payload_length);
  if (pl !== undefined) return pl;
  const total = u64(raw.length) ?? (typeof raw.data === 'string' ? raw.data.length / 2 : undefined);
  if (total === undefined) return undefined;
  const t = vlie(h3FrameTypeNumber(f));
  for (const l of [1, 2, 4, 8]) {
    const p = total - t - l;
    if (p >= 0 && vlie(p) === l) return p;
  }
  return undefined;
}

function mapH3Frame(f, hints) {
  if (!isObj(f)) return f;
  const out = { frame_type: f.frame_type };
  switch (f.frame_type) {
    case 'data':
      put(out, 'raw', f.raw?.data); // draft-02 DataFrame.raw is bytes
      break;
    case 'headers':
    case 'push_promise':
      put(out, 'push_id', f.push_id);
      if (Array.isArray(f.headers)) out.headers = f.headers.map(mapHTTPField);
      break;
    case 'settings':
      if (Array.isArray(f.settings)) {
        out.settings = f.settings.map((s) => {
          if (!isObj(s)) return s;
          const o = {};
          put(o, 'name', s.name ?? (s.name_bytes !== undefined ? 'unknown' : undefined));
          put(o, 'value', s.value === undefined ? undefined : String(s.value)); // draft-02 Setting.value is a string
          return copyRest(s, o, []);
        });
      }
      break;
    case 'goaway':
      put(out, 'stream_id', f.id); // draft-02 GoAwayFrame.stream_id
      break;
    case 'cancel_push':
    case 'max_push_id':
      put(out, 'push_id', f.push_id);
      break;
    case 'priority_update':
      put(out, 'stream_id', f.stream_id);
      put(out, 'push_id', f.push_id);
      put(out, 'priority_field_value', f.priority_field_value);
      if (hints && f.stream_id !== undefined) {
        // the (aioquic-era) shape qvis' multiplexing waterfall reads
        out.element_id = f.stream_id;
        put(out, 'value', f.priority_field_value);
      }
      break;
    case 'reserved':
    case 'unknown':
      put(out, 'raw_frame_type', f.frame_type_bytes);
      break;
  }
  return copyRest(f, out, ['raw', 'id', 'frame_type_bytes']);
}

const H3_STREAM_TYPE = { request: 'data', qpack_encode: 'qpack_encode', qpack_decode: 'qpack_decode', encoder: 'qpack_encode', decoder: 'qpack_decode' };

function mapH3Settings(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'initiator') out.owner = v;
    else if (k === 'max_field_section_size') out.max_header_list_size = v; // RFC 9114 rename
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// event mapping

const alpnText = (a) => (isObj(a) ? a.string_value ?? (typeof a.byte_value === 'string' ? hexToLatin1(a.byte_value) : undefined) : a);

/** renames `initiator` to draft-02 `owner` in place of the key (keeps key order and count) */
function ownerFirst(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) out[k === 'initiator' ? 'owner' : k] = v;
  return out;
}

/** each mapper returns [draft-02 name, draft-02 data] */
const QUIC = {
  // connectivity
  server_listening: (d) => ['connectivity:server_listening', { ...d }],
  connection_started: (d) => {
    const l = isObj(d.local) ? d.local : {};
    const r = isObj(d.remote) ? d.remote : {};
    const out = {};
    const v4 = l.ip_v4 !== undefined || r.ip_v4 !== undefined;
    const v6 = l.ip_v6 !== undefined || r.ip_v6 !== undefined;
    put(out, 'ip_version', v4 ? 'v4' : v6 ? 'v6' : undefined);
    put(out, 'src_ip', v4 ? l.ip_v4 : l.ip_v6);
    put(out, 'dst_ip', v4 ? r.ip_v4 : r.ip_v6);
    out.protocol = 'QUIC';
    put(out, 'src_port', v4 ? l.port_v4 : l.port_v6);
    put(out, 'dst_port', v4 ? r.port_v4 : r.port_v6);
    put(out, 'src_cid', l.connection_ids?.[0]);
    put(out, 'dst_cid', r.connection_ids?.[0]);
    return ['connectivity:connection_started', copyRest(d, out, ['local', 'remote'])];
  },
  connection_closed: (d) => {
    const out = {};
    put(out, 'owner', d.initiator);
    if (d.connection_error !== undefined) put(out, 'connection_code', errorCode(d.connection_error, d.error_code));
    if (d.application_error !== undefined) put(out, 'application_code', errorCode(d.application_error, d.error_code));
    put(out, 'internal_code', d.internal_code);
    put(out, 'reason', d.reason);
    put(out, 'trigger', d.trigger);
    const skip = ['initiator', 'connection_error', 'application_error', 'internal_code', 'reason', 'trigger'];
    if (d.connection_error !== undefined || d.application_error !== undefined) skip.push('error_code');
    return ['connectivity:connection_closed', copyRest(d, out, skip)];
  },
  connection_id_updated: (d) => ['connectivity:connection_id_updated', ownerFirst(d)],
  spin_bit_updated: (d) => ['connectivity:spin_bit_updated', { ...d }],
  connection_state_updated: (d) => ['connectivity:connection_state_updated', { ...d }],
  tuple_assigned: (d) => ['connectivity:tuple_assigned', { ...d }],
  migration_state_updated: (d) => ['connectivity:migration_state_updated', { ...d }],
  // security
  key_updated: (d) => {
    const out = { key_type: d.key_type };
    put(out, 'old', d.old);
    put(out, 'new', d.new);
    put(out, 'generation', d.key_phase);
    put(out, 'trigger', d.trigger);
    return ['security:key_updated', copyRest(d, out, ['key_phase'])];
  },
  key_discarded: (d) => {
    const out = { key_type: d.key_type };
    put(out, 'key', d.key);
    put(out, 'generation', d.key_phase);
    put(out, 'trigger', d.trigger);
    return ['security:key_retired', copyRest(d, out, ['key_phase'])];
  },
  // transport
  version_information: (d) => ['transport:version_information', { ...d }],
  alpn_information: (d) => {
    const out = {};
    if (Array.isArray(d.server_alpns)) out.server_alpns = d.server_alpns.map(alpnText);
    if (Array.isArray(d.client_alpns)) out.client_alpns = d.client_alpns.map(alpnText);
    if (d.chosen_alpn !== undefined) out.chosen_alpn = alpnText(d.chosen_alpn);
    return ['transport:alpn_information', copyRest(d, out, [])];
  },
  parameters_set: (d) => {
    const out = ownerFirst(d);
    if (typeof out.stateless_reset_token === 'string') out.stateless_reset_token = mapResetToken(out.stateless_reset_token);
    if (isObj(out.preferred_address) && typeof out.preferred_address.stateless_reset_token === 'string') {
      out.preferred_address = { ...out.preferred_address, stateless_reset_token: mapResetToken(out.preferred_address.stateless_reset_token) };
    }
    return ['transport:parameters_set', out];
  },
  parameters_restored: (d) => ['transport:parameters_restored', { ...d }],
  packet_sent: (d, ctx) => ['transport:packet_sent', mapPacket(d, ctx)],
  packet_received: (d, ctx) => ['transport:packet_received', mapPacket(d, ctx)],
  packet_dropped: (d, ctx) => ['transport:packet_dropped', mapPacket(d, ctx)],
  packet_buffered: (d, ctx) => ['transport:packet_buffered', mapPacket(d, ctx)],
  packets_acked: (d) => ['transport:packets_acked', { ...d }],
  udp_datagrams_sent: (d) => ['transport:datagrams_sent', { ...d }],
  udp_datagrams_received: (d) => ['transport:datagrams_received', { ...d }],
  udp_datagram_dropped: (d) => ['transport:datagram_dropped', { ...d }],
  stream_state_updated: (d) => ['transport:stream_state_updated', { ...d }],
  frames_created: (d, ctx) => ['transport:frames_created', mapFramesEvent(d, ctx)],
  frames_parsed: (d, ctx) => ['transport:frames_parsed', mapFramesEvent(d, ctx)],
  frames_processed: (d, ctx) => ['transport:frames_processed', mapFramesEvent(d, ctx)],
  stream_data_moved: (d) => ['transport:data_moved', mapDataMoved(d)],
  datagram_data_moved: (d) => ['transport:datagram_data_moved', mapDataMoved(d)],
  connection_data_blocked_updated: (d) => ['transport:connection_data_blocked_updated', { ...d }],
  stream_data_blocked_updated: (d) => ['transport:stream_data_blocked_updated', { ...d }],
  datagram_data_blocked_updated: (d) => ['transport:datagram_data_blocked_updated', { ...d }],
  mtu_updated: (d) => ['transport:mtu_updated', { ...d }],
  // recovery
  recovery_parameters_set: (d) => ['recovery:parameters_set', { ...d }],
  recovery_metrics_updated: (d) => ['recovery:metrics_updated', { ...d }],
  congestion_state_updated: (d) => ['recovery:congestion_state_updated', { ...d }],
  timer_updated: (d) => ['recovery:loss_timer_updated', { ...d }],
  packet_lost: (d, ctx) => {
    const out = {};
    if (d.header !== undefined) out.header = mapHeader(d.header);
    if (Array.isArray(d.frames) && d.frames.length) out.frames = d.frames.map((f) => mapFrame(f, ctx.hints));
    return ['recovery:packet_lost', copyRest(d, out, ['header', 'frames'])];
  },
  marked_for_retransmit: (d, ctx) => ['recovery:marked_for_retransmit', copyRest(d, { frames: Array.isArray(d.frames) ? d.frames.map((f) => mapFrame(f, ctx.hints)) : d.frames }, [])],
  ecn_state_updated: (d) => ['recovery:ecn_state_updated', { ...d }],
};

const HTTP3 = {
  parameters_set: (d) => ['http:parameters_set', mapH3Settings(d)],
  parameters_restored: (d) => ['http:parameters_restored', mapH3Settings(d)],
  stream_type_set: (d) => {
    const out = { stream_id: d.stream_id };
    put(out, 'owner', d.initiator);
    put(out, 'new', d.stream_type === undefined ? undefined : H3_STREAM_TYPE[d.stream_type] ?? d.stream_type);
    put(out, 'associated_push_id', d.associated_push_id);
    return ['http:stream_type_set', copyRest(d, out, ['initiator', 'stream_type'])];
  },
  priority_updated: (d) => ['http:priority_updated', { ...d }],
  frame_created: (d, ctx) => ['http:frame_created', mapH3FrameEvent(d, ctx)],
  frame_parsed: (d, ctx) => ['http:frame_parsed', mapH3FrameEvent(d, ctx)],
  datagram_created: (d) => ['http:datagram_created', { ...d }],
  datagram_parsed: (d) => ['http:datagram_parsed', { ...d }],
  push_resolved: (d) => ['http:push_resolved', { ...d }],
};

function mapPacket(d, ctx) {
  const out = {};
  if (d.header !== undefined) out.header = mapHeader(d.header);
  if (Array.isArray(d.frames)) {
    // an empty array is legal in -13 but crashes qvis' packetization diagram (Q-F5); draft-02 frames is optional
    if (d.frames.length) out.frames = mapFrames(d.frames, ctx.hints, packetPayloadLength(d.raw, d.header?.packet_type));
    else ctx.diag.once('empty-frames', `${ctx.where}: dropped empty "frames" arrays (qvis cannot handle them)`);
  }
  for (const k of ['is_coalesced']) put(out, k, d[k]);
  if (d.retry_token !== undefined) out.retry_token = mapToken(d.retry_token);
  put(out, 'stateless_reset_token', d.stateless_reset_token);
  put(out, 'supported_versions', d.supported_versions);
  if (d.raw !== undefined) out.raw = mapRaw(d.raw);
  put(out, 'datagram_id', d.datagram_id);
  put(out, 'trigger', d.trigger);
  return copyRest(d, out, ['header', 'frames', 'retry_token', 'raw']);
}

function mapFramesEvent(d, ctx) {
  const out = {};
  if (Array.isArray(d.frames)) out.frames = d.frames.map((f) => mapFrame(f, ctx.hints));
  if (Array.isArray(d.packet_numbers) && d.packet_numbers.length === 1) out.packet_number = d.packet_numbers[0];
  return copyRest(d, out, ['frames']);
}

function mapDataMoved(d) {
  const out = {};
  for (const k of ['stream_id', 'offset']) put(out, k, d[k]);
  put(out, 'length', u64(d.raw?.length) ?? hexLen(d.raw?.data));
  for (const k of ['from', 'to']) put(out, k, d[k]);
  put(out, 'data', d.raw?.data);
  return copyRest(d, out, ['raw']);
}

function mapH3FrameEvent(d, ctx) {
  const out = { stream_id: d.stream_id };
  const len = h3FramePayloadLength(d.frame);
  put(out, 'length', len);
  out.frame = mapH3Frame(d.frame, ctx.hints);
  if (isObj(d.frame?.raw)) out.raw = mapRaw(d.frame.raw); // draft-02: RawInfo on the event
  if (ctx.hints && len !== undefined) out.byte_length = String(len); // qvis packetization reads byte_length
  return copyRest(d, out, ['frame']);
}

const LOGLEVELS = new Set(['error', 'warning', 'info', 'debug', 'verbose']);

/** maps one latest-draft event name + data to draft-02 [name, data] */
export function mapEvent(name, data, ctx) {
  const d = isObj(data) ? data : {};
  const i = typeof name === 'string' ? name.indexOf(':') : -1;
  const ns = i >= 0 ? name.slice(0, i) : '';
  const type = i >= 0 ? name.slice(i + 1) : name;
  let mapper;
  if (ns === 'quic') mapper = QUIC[type];
  else if (ns === 'http3') mapper = HTTP3[type];
  if (mapper) return mapper(d, ctx);

  if (ns === 'loglevel' && LOGLEVELS.has(type)) return [`generic:${type}`, { ...d }]; // draft-02 §7.1
  if (ns === 'quic') {
    ctx.diag.once('unknown:' + name, `${ctx.where}: no draft-02 equivalent for "${name}", kept as transport:${type}`);
    return [`transport:${type}`, { ...d }];
  }
  if (ns === 'http3') {
    ctx.diag.once('unknown:' + name, `${ctx.where}: no draft-02 equivalent for "${name}", kept as http:${type}`);
    return [`http:${type}`, { ...d }];
  }
  if (ns !== 'simulation' && ns !== 'http' && ns !== 'loglevel') {
    ctx.diag.once('verbatim:' + name, `${ctx.where}: "${name}" is not a latest-draft QUIC/HTTP3 event, copied verbatim`);
  }
  return [name, isObj(data) ? { ...data } : data];
}

// ---------------------------------------------------------------------------
// trace conversion

/**
 * Converts one latest-draft trace (Trace or TraceSeq + its events) into a
 * draft-02 Trace. Returns { trace, info }.
 */
export function convertTrace(trace, events, { hints = true, source = undefined, diag = new Diag(), where = 'trace' } = {}) {
  const common = isObj(trace.common_fields) ? trace.common_fields : {};
  const ctx = { hints, diag, where };

  // P8/P9: effective time_format / reference_time, delta decoding, per-event epochs
  const eff = (ev, k) => (ev[k] !== undefined ? ev[k] : common[k]);
  const traceRef = common.reference_time !== undefined ? common.reference_time : events.find((e) => isObj(e) && e.reference_time !== undefined)?.reference_time;
  const traceEpoch = epochMsOf(traceRef);
  let prev;
  let mixedEpochs = false;
  const items = [];
  events.forEach((ev, index) => {
    if (!isObj(ev)) {
      diag.once('not-object', `${where}: skipped non-object event entries`);
      return;
    }
    if (Object.keys(ev).length === 0) return; // qvis "trailing comma" accommodation
    let t = typeof ev.time === 'number' ? ev.time : typeof ev.time === 'string' ? parseFloat(ev.time) : NaN;
    const fmt = eff(ev, 'time_format') ?? 'relative_to_epoch';
    let resolved;
    if (!Number.isFinite(t)) {
      diag.once('missing-time', `${where}: events without a valid time keep the previous event's time`);
      resolved = prev ?? 0;
    } else if (fmt === 'relative_to_previous_event') resolved = prev === undefined ? t : prev + t;
    else resolved = t;
    prev = resolved;
    // an event with its own, different epoch: shift onto the trace epoch (data-model §3.16.3)
    if (ev.reference_time !== undefined) {
      const e = epochMsOf(ev.reference_time);
      if (e !== traceEpoch) {
        mixedEpochs = true;
        if (e !== null && traceEpoch !== null) resolved += e - traceEpoch;
      }
    }
    items.push({ ev, index, resolved });
  });
  if (mixedEpochs) diag.warn(`${where}: events with differing reference_time epochs were shifted onto the trace epoch`);

  // P10: stable sort on the resolved time
  let reordered = false;
  for (let k = 1; k < items.length; k++) {
    if (items[k].resolved < items[k - 1].resolved) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    items.sort((a, b) => a.resolved - b.resolved || a.index - b.index);
    diag.warn(`${where}: events were not in time order; stable-sorted on their timestamp (qvis-react does the same)`);
  }

  // P12: time case
  let timeCase;
  const legacyCommon = {};
  if (traceEpoch === null) timeCase = 'U';
  else if (traceEpoch === 0) timeCase = 'A';
  else timeCase = 'R';

  // case U: every group (connection) starts at 0
  const groupKey = (ev) => {
    const g = ev.group_id;
    return g === undefined ? '' : typeof g === 'string' ? g : JSON.stringify(g);
  };
  const groupStart = new Map();
  if (timeCase === 'U') {
    for (const it of items) {
      const g = groupKey(it.ev);
      if (!groupStart.has(g)) groupStart.set(g, it.resolved);
    }
  }

  if (common.group_id !== undefined) legacyCommon.group_id = common.group_id;
  const schemas = Array.isArray(trace.event_schemas) ? trace.event_schemas : [];
  const hasQuic = schemas.some((s) => /:quic(-\d+)?$/.test(s));
  const hasH3 = schemas.some((s) => /:http3(-\d+)?$/.test(s));
  if (hasQuic) legacyCommon.protocol_type = hasH3 ? 'QUIC_HTTP3' : 'QUIC';
  if (timeCase === 'R') {
    legacyCommon.time_format = 'relative';
    legacyCommon.reference_time = String(traceEpoch);
  } else if (timeCase === 'A') {
    legacyCommon.time_format = 'absolute';
  } else {
    legacyCommon.time_format = 'relative';
    legacyCommon.reference_time = '0';
  }
  // other (custom) common fields are kept
  copyRest(common, legacyCommon, ['time_format', 'reference_time', 'group_id']);

  const outEvents = items.map(({ ev, resolved }) => {
    const time = timeCase === 'U' ? resolved - groupStart.get(groupKey(ev)) : resolved;
    const [name, data] = mapEvent(ev.name, ev.data, ctx);
    const out = { time, name, data };
    // per-event extras (group_id, tuple, system_info, custom); time fields are resolved above
    copyRest(ev, out, ['time', 'name', 'data', 'time_format', 'reference_time']);
    return out;
  });

  const out = {};
  put(out, 'title', trace.title);
  put(out, 'description', trace.description);
  const configuration = {};
  if (source !== undefined) configuration.original_uris = [source];
  configuration[TOOL] = {
    converted_from: 'draft-ietf-quic-qlog-main-schema-14 / quic-events-13 / h3-events-13',
    event_schemas: schemas,
    common_fields: common,
    time_case: timeCase,
  };
  out.configuration = configuration;
  out.common_fields = legacyCommon;
  if (isObj(trace.vantage_point)) out.vantage_point = { ...trace.vantage_point };
  copyRest(trace, out, ['title', 'description', 'common_fields', 'vantage_point', 'event_schemas', 'events']);
  out.events = outEvents;

  return { trace: out, info: { events: outEvents.length, timeCase, reordered } };
}

// ---------------------------------------------------------------------------
// file conversion

/**
 * inputs: [{ name, text }] -> { file, report }.
 * options: { hints = true, title, description }
 */
export function convertLatestToLegacy(inputs, { hints = true, title, description } = {}) {
  const diag = new Diag();
  const traces = [];
  const report = [];
  const headers = [];
  for (const { name, text } of inputs) {
    const parsed = parseLatest(text, name, diag);
    headers.push(parsed.header);
    parsed.traces.forEach((t, i) => {
      const where = `${name}#${i}`;
      if (t.error) {
        const e = {};
        put(e, 'error_description', t.error.error_description);
        put(e, 'uri', t.error.uri);
        if (isObj(t.error.vantage_point)) e.vantage_point = { ...t.error.vantage_point };
        traces.push(copyRest(t.error, e, []));
        report.push({ where, error: t.error.error_description });
        return;
      }
      const { trace, info } = convertTrace(t.trace, t.events, { hints, source: name, diag, where });
      traces.push(trace);
      report.push({ where, vantage: trace.vantage_point?.type, ...info });
    });
  }

  const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x.length))];
  const titles = uniq(headers.map((h) => h.title));
  const descs = uniq(headers.map((h) => h.description));
  const file = { qlog_version: 'draft-02', qlog_format: 'JSON' };
  const t = title ?? (titles.length <= 1 ? titles[0] : titles.join(' + '));
  const d = description ?? (descs.length <= 1 ? descs[0] : descs.join(' | '));
  put(file, 'title', t);
  put(file, 'description', d);
  file.traces = traces;
  return { file, report, diagnostics: diag.messages };
}

/**
 * qvis picks the parser by searching the first 1024 characters for "NDJSON", then
 * "JSON-SEQ", then "JSON" (FileLoader.GuesstimateFileTypeFromHeader), so a title
 * or description such as "qlog JSON-SEQ file written by ..." in that window makes
 * it stream-parse a contained JSON file and fail. In that case, whitespace (valid
 * JSON, no value changes) pushes everything after qlog_format past the window.
 */
function guardFormatSniffing(text) {
  const fmt = text.indexOf('"qlog_format"');
  const afterFmt = text.indexOf(',', fmt) + 1;
  if (fmt < 0 || afterFmt <= 0 || afterFmt > 1024) return text;
  if (!/NDJSON|JSON-SEQ/.test(text.slice(afterFmt, 1024))) return text;
  return text.slice(0, afterFmt) + '\n' + ' '.repeat(1024) + text.slice(afterFmt);
}

/** JSON text with one event per line (qlog_version and qlog_format first, as qvis requires) */
export function serialize(file, opts = {}) {
  return guardFormatSniffing(serializeRaw(file, opts));
}

function serializeRaw(file, { compact = false } = {}) {
  if (compact) return JSON.stringify(file);
  const lines = ['{'];
  const top = Object.entries(file).filter(([k]) => k !== 'traces');
  for (const [k, v] of top) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push('  "traces": [');
  file.traces.forEach((tr, ti) => {
    const last = ti === file.traces.length - 1;
    if (!Array.isArray(tr.events)) {
      lines.push(`    ${JSON.stringify(tr)}${last ? '' : ','}`);
      return;
    }
    lines.push('    {');
    for (const [k, v] of Object.entries(tr)) {
      if (k !== 'events') lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    }
    lines.push('      "events": [');
    tr.events.forEach((e, ei) => lines.push(`        ${JSON.stringify(e)}${ei === tr.events.length - 1 ? '' : ','}`));
    lines.push('      ]');
    lines.push(`    }${last ? '' : ','}`);
  });
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI

function usage(code) {
  (code ? process.stderr : process.stdout).write(`usage: latest-to-legacy.mjs [options] <in.qlog|in.sqlog>...

Converts latest-draft qlog (main-schema-14, quic-events-13, h3-events-13;
contained .qlog or JSON-SEQ .sqlog) into ONE qlog draft-02 JSON file
(qlog_version "draft-02") with all traces, for the original qvis.

options:
  -o, --output <file>    write to <file> instead of stdout
  --title <text>         file title (default: the inputs' title(s))
  --description <text>   file description (default: the inputs' description(s))
  --no-qvis-hints        omit the qvis-only helper fields (frame_size, byte_length,
                         new_connection_id/new_token length, priority_update
                         element_id/value); pure draft-02 field names only
  --compact              no line breaks (default: one event per line)
  -q, --quiet            no conversion report on stderr
  -h, --help             show this help
`);
  process.exit(code);
}

function main(argv) {
  const opts = { output: null, title: undefined, description: undefined, hints: true, compact: false, quiet: false, inputs: [] };
  const str = (i) => (argv[i] === undefined ? usage(2) : argv[i]);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '-o': case '--output': opts.output = str(++i); break;
      case '--title': opts.title = str(++i); break;
      case '--description': opts.description = str(++i); break;
      case '--no-qvis-hints': opts.hints = false; break;
      case '--compact': opts.compact = true; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': usage(0); break;
      default:
        if (argv[i].startsWith('-')) usage(2);
        opts.inputs.push(argv[i]);
    }
  }
  if (!opts.inputs.length) usage(2);

  let result;
  try {
    const inputs = opts.inputs.map((f) => ({ name: basename(f), text: readFileSync(f, 'utf8') }));
    result = convertLatestToLegacy(inputs, opts);
  } catch (e) {
    process.stderr.write(`${TOOL}: ${e.message}\n`);
    process.exit(1);
  }
  const text = serialize(result.file, opts);
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);

  if (!opts.quiet) {
    for (const r of result.report) {
      process.stderr.write(
        r.error
          ? `${TOOL}: ${r.where}: TraceError "${r.error}"\n`
          : `${TOOL}: ${r.where}: ${r.vantage ?? 'unknown'} trace, ${r.events} events, time case ${r.timeCase}${r.reordered ? ', re-sorted' : ''}\n`,
      );
    }
    for (const m of result.diagnostics) process.stderr.write(`${TOOL}: ${m}\n`);
    if (opts.output) process.stderr.write(`${TOOL}: wrote ${opts.output} (${text.length} bytes)\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
