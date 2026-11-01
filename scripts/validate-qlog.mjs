#!/usr/bin/env node
// Strict validator for qlog files against the CDDL of the latest published
// qlog drafts: draft-ietf-quic-qlog-main-schema-14,
// draft-ietf-quic-qlog-quic-events-13 and draft-ietf-quic-qlog-h3-events-13.
//
// Usage: node scripts/validate-qlog.mjs [options] <file.sqlog|file.qlog>...
// See scripts/cddl/README.md. No npm dependencies; needs the Rust `cddl` CLI
// (https://crates.io/crates/cddl, tested with 0.10.7) via $CDDL_BIN or PATH.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

if (JSON.parse('1', (k, v, ctx) => ctx?.source) !== '1') {
  console.error('validate-qlog.mjs needs Node 22+ (JSON.parse source text access)');
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const CDDL_DIR = join(HERE, 'cddl');
const CDDL_SOURCES = ['main-schema-14.cddl', 'quic-events-13.cddl', 'h3-events-13.cddl'];

// Event schema URIs for the namespaces defined by the supported drafts.
// quic-events-13 / h3-events-13 "Draft Event Schema Identification": draft
// implementations MUST append "-<draft number>". main-schema-14 has no such
// rule for its loglevel/simulation schemas.
const NAMESPACE_SCHEMA = {
  loglevel: 'urn:ietf:params:qlog:events:loglevel',
  simulation: 'urn:ietf:params:qlog:events:simulation',
  quic: 'urn:ietf:params:qlog:events:quic-13',
  http3: 'urn:ietf:params:qlog:events:http3-13',
  http: 'urn:ietf:params:qlog:events:http-13',
};
const FORMATS = {
  seq: { fileSchema: 'urn:ietf:params:qlog:file:sequential', media: 'application/qlog+json-seq', rule: 'QlogFileSeq' },
  contained: { fileSchema: 'urn:ietf:params:qlog:file:contained', media: 'application/qlog+json', rule: 'QlogFile' },
};

// ---------------------------------------------------------------- CLI args
function usage(code) {
  (code ? process.stderr : process.stdout).write(`usage: validate-qlog.mjs [options] <file.sqlog|file.qlog>...

Validates qlog files (JSON-SEQ .sqlog or contained JSON .qlog) against the CDDL
of draft-ietf-quic-qlog-main-schema-14 + quic-events-13 + h3-events-13. Each
event's "data" is validated against the concrete type for its "name"
(quic:packet_sent -> QUICPacketSent, ...). Exit code 0 = all files pass,
1 = validation failures, 2 = usage/setup error.

options:
  --cddl-bin <path>        Rust cddl CLI (default: $CDDL_BIN, else "cddl" on PATH)
  --batch <n>              items per cddl invocation (default 250)
  --jobs <n>               parallel cddl invocations (default: CPU count)
  --max-report <n>         failing events printed per file (default 25, 0 = all)
  --max-messages <n>       messages printed per failing event (default 8, 0 = all)
  --detail <n>             re-validate union/array failures of only the first
                           n failing events per file for precise messages
                           (default: all; 0 = off)
  --allow-unknown-events   events not defined by the supported drafts are
                           warnings (envelope still validated), not errors
  -W, --warnings-as-errors exit non-zero on warnings too
  --json                   print a machine-readable JSON report on stdout
  --summary <n>            distinct issues listed in the per-file issue summary
                           (default 40, 0 = off)
  -q, --quiet              only print per-file summary lines
  --emit-cddl <file>       write the combined, adapted CDDL used for validation
  --emit-spec-cddl <file>  write the combined spec CDDL (verbatim, de-duplicated)
  --check-cddl             compile both combined CDDLs with the cddl CLI
  --self-test              run the built-in conformance checks of the validator
`);
  process.exit(code);
}

const opts = {
  cddlBin: process.env.CDDL_BIN || 'cddl',
  batch: 250,
  jobs: Math.max(1, availableParallelism?.() ?? 4),
  maxReport: 25,
  maxMessages: 8,
  summary: 40,
  detail: Infinity,
  allowUnknown: false,
  werror: false,
  json: false,
  quiet: false,
  emitCddl: null,
  emitSpecCddl: null,
  checkCddl: false,
  selfTest: false,
  files: [],
};
{
  const a = process.argv.slice(2);
  const num = (i) => {
    const n = Number(a[i]);
    if (!Number.isInteger(n) || n < 0) usage(2);
    return n;
  };
  const str = (i) => (a[i] === undefined ? usage(2) : a[i]);
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--cddl-bin': opts.cddlBin = str(++i); break;
      case '--batch': opts.batch = Math.max(1, num(++i)); break;
      case '--jobs': opts.jobs = Math.max(1, num(++i)); break;
      case '--max-report': opts.maxReport = num(++i); break;
      case '--max-messages': opts.maxMessages = num(++i); break;
      case '--detail': opts.detail = num(++i); break;
      case '--summary': opts.summary = num(++i); break;
      case '--allow-unknown-events': opts.allowUnknown = true; break;
      case '-W': case '--warnings-as-errors': opts.werror = true; break;
      case '--json': opts.json = true; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      case '--emit-cddl': opts.emitCddl = str(++i); break;
      case '--emit-spec-cddl': opts.emitSpecCddl = str(++i); break;
      case '--check-cddl': opts.checkCddl = true; break;
      case '--self-test': opts.selfTest = true; break;
      case '-h': case '--help': usage(0); break;
      default:
        if (a[i].startsWith('-')) usage(2);
        opts.files.push(a[i]);
    }
  }
  if (!opts.files.length && !opts.emitCddl && !opts.emitSpecCddl && !opts.checkCddl && !opts.selfTest) usage(2);
}

// ------------------------------------------------------------ CDDL building
// Split a CDDL line into code and comment, respecting string literals.
function splitComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === ';') return [line.slice(0, i), line.slice(i)];
  }
  return [line, ''];
}
const codeOf = (text) => text.split('\n').map((l) => splitComment(l)[0]).join('\n');
const RULE_START = /^([A-Za-z@_$][\w@.$-]*)\s*(\/\/=|\/=|=)/;
const STR = '"(?:[^"\\\\]|\\\\.)*"';
const IDENT_REF = /(?<![\w@.$-])([A-Za-z@_$][\w@.$-]*)/g;

// Top-level chunks: each starts at a rule definition in column 0; comments
// and blank lines belong to the preceding chunk.
function chunks(text, file) {
  const out = [{ name: null, op: null, lines: [], file }];
  for (const line of text.split('\n')) {
    const m = RULE_START.exec(splitComment(line)[0]);
    if (m) out.push({ name: m[1], op: m[2], lines: [], file });
    out.at(-1).lines.push(line);
  }
  return out;
}

// Combine the three drafts' CDDL. A rule defined with "=" in more than one
// draft (Initiator: quic-events-13 and h3-events-13) must be identical and is
// kept once; a conflicting redefinition is a hard error.
function combineSpec() {
  const seen = new Map();
  const parts = [];
  const notes = [];
  for (const f of CDDL_SOURCES) {
    for (const c of chunks(readFileSync(join(CDDL_DIR, f), 'utf8'), f)) {
      let body = c.lines.join('\n');
      if (c.op === '=') {
        const norm = codeOf(body).replace(/\s+/g, ' ').trim();
        const prev = seen.get(c.name);
        if (prev) {
          if (prev.norm !== norm) throw new Error(`conflicting definitions of ${c.name} in ${prev.file} and ${f}`);
          notes.push(`${c.name}: identical definition in ${prev.file} and ${f}, kept once`);
          body = c.lines.map((l) => (splitComment(l)[0].trim() ? `; [duplicate of ${prev.file}] ${l}` : l)).join('\n');
        } else seen.set(c.name, { norm, file: f });
      }
      parts.push(body);
    }
  }
  return { text: parts.join('\n'), notes };
}

// Adaptations so the Rust cddl crate (0.10.x) validates JSON the way RFC 8610
// specifies. All are applied to code only, never to comments or string
// literals, and each one is covered by --self-test.
//  1. member keys: RFC 8610 3.5.1 makes a bareword before ":" a text key, but
//     the crate resolves barewords that are also prelude type names (time,
//     uri, number, ...) as types, so e.g. Event's "time:" never matches.
//     Every bareword key is written as the equivalent quoted text key.
//  2. unwrap: the crate does not implement "~Map" (RFC 8610 3.7) inside a map
//     (QlogFile and QlogFileSeq use ~LogFile); replaced by an equivalent group
//     rule holding the map's entries.
//  3. uint: the crate accepts negative JSON integers as uint; "uint .size N"
//     is written as the equivalent range 0..(2^(8N)-1), bare uint as 0..2^64-1.
//  4. .regexp: RFC 8610 3.8.3 uses XSD regexps, which are implicitly anchored;
//     the crate matches unanchored (so "zz" would be a hexstring); wrapped as
//     ^(?:...)$.
//  5. numbers: RFC 8610 Appendix E (normative): JSON has one number type;
//     "uint"/"int" are a predicate that the number is integral (10, 10.0,
//     1e1, 100e-1 all match uint) and float16/32/64 only restrict the value
//     set, so integral numbers are floats too (e.g. "time": 1553986553572 in
//     main-schema-14 Figure 15). The crate types numbers by their JSON
//     spelling. So: float16/32/64 also accept int here, and every integral
//     number is rewritten (exactly, from its source text) to integer form
//     before validation (see canonicalNumber).
//  6. "hexstring .size N" (StatelessResetToken = hexstring .size 16): .size
//     on a text string counts bytes of text, but the intent ("always 128
//     bits") is N bytes = 2N hex digits (the WG's cddl_validate.sh strips this
//     .size; the editor's copy removed it in #621). Enforced as exactly N
//     hex-encoded bytes.
function mapCode(code, re, fn) {
  const all = new RegExp(`(${STR})|${re.source}`, 'g');
  return code.replace(all, (m, str, ...rest) => (str ? str : fn(m, ...rest)));
}
function adaptForJson(spec) {
  const counts = { keys: 0, unwrap: 0, uint: 0, regexp: 0, float: 0, hexsize: 0 };
  const sizes = new Set();
  const unwrapped = new Set();
  const lines = spec.split('\n').map((line) => {
    let [code, comment] = splitComment(line);
    code = code.replace(new RegExp(`\\.regexp\\s+(${STR})`, 'g'), (_, lit) => {
      counts.regexp++;
      return `.regexp "^(?:${lit.slice(1, -1)})$"`;
    });
    code = mapCode(code, /\bhexstring\s+\.size\s+(\d+)/, (_, n) => {
      counts.hexsize++;
      sizes.add(n);
      return `qvis-json-hexbytes-${n}`;
    });
    code = mapCode(code, /\bfloat(16|32|64)\b/, (_, bits) => {
      counts.float++;
      return `qvis-json-float${bits}`;
    });
    code = mapCode(code, /\buint(?:\s+\.size\s+(\d+))?(?![\w@.$-])/, (_, n) => {
      counts.uint++;
      return `0..${(2n ** (8n * BigInt(n ?? 8)) - 1n).toString()}`;
    });
    code = mapCode(code, /(^|[\s{(,?*+])([A-Za-z_@][\w@.-]*)(\s*):/, (_, pre, key, sp) => {
      counts.keys++;
      return `${pre}"${key}"${sp}:`;
    });
    code = mapCode(code, /~\s*([A-Za-z@_$][\w@.$-]*)/, (_, name) => {
      counts.unwrap++;
      unwrapped.add(name);
      return `qvis-unwrapped-${name}`;
    });
    return code + comment;
  });
  const text = lines.join('\n');
  const helpers = [
    '',
    '; ==== qvis JSON adaptation helpers (see scripts/validate-qlog.mjs) ====',
    'qvis-json-float16 = float16 / int',
    'qvis-json-float32 = float32 / int',
    'qvis-json-float64 = float64 / int',
    ...[...sizes].map((n) => `qvis-json-hexbytes-${n} = text .regexp "^(?:[0-9a-f]{2}){${n}}$"`),
  ];
  for (const name of unwrapped) {
    const c = chunks(text, '').find((x) => x.name === name && x.op === '=');
    const body = c && codeOf(c.lines.join('\n')).replace(RULE_START, '').trim();
    if (!body || !body.startsWith('{') || !body.endsWith('}')) throw new Error(`cannot unwrap ${name}: not a map rule`);
    helpers.push(`qvis-unwrapped-${name} = (${body.slice(1, -1).replace(/\s+$/, '')}\n)`);
  }
  return { text: text + helpers.join('\n') + '\n', counts };
}

// Per-event-type envelopes: the spec's Event rule with
// "data: $ProtocolEventData" narrowed to the concrete type for the name.
// Anything valid against such an envelope is valid against Event.
function eventEnvelopes(spec, types) {
  const ev = chunks(spec, '').find((c) => c.name === 'Event' && c.op === '=');
  if (!ev) throw new Error('Event rule not found');
  const body = ev.lines.join('\n');
  const DATA = /(?<![\w"])"?data"?\s*:\s*\$ProtocolEventData\b/g;
  if ((codeOf(body).match(DATA) ?? []).length !== 1) throw new Error('Event rule has no unique "data: $ProtocolEventData"');
  const mk = (rule, dataType) => body.replace(/^Event\s*=/, `${rule} =`).replace(DATA, `"data": ${dataType}`);
  const out = ['', '; ==== qvis per-event-type envelopes (Event with data narrowed by name) ===='];
  for (const t of new Set(types)) out.push(mk(`qvis-event-${t}`, t));
  out.push(mk('qvis-event-unknown', '{ * text => any }'));
  return out.join('\n') + '\n';
}

const EVENT_TYPES = JSON.parse(readFileSync(join(CDDL_DIR, 'event-types.json'), 'utf8'));
const spec = combineSpec();
const adapted = adaptForJson(spec.text);
const SCHEMA = adapted.text + eventEnvelopes(adapted.text, Object.values(EVENT_TYPES));

// Index of the adapted schema: rule chunks with their references, used to
// prune each batch's CDDL to the rules reachable from its root (the crate's
// cost grows with the size of the CDDL: pruning makes validation ~4x faster).
const IDX = (() => {
  const list = [];
  const byName = new Map();
  for (const c of chunks(SCHEMA, '')) {
    if (!c.name) continue;
    const code = codeOf(c.lines.join('\n'));
    const body = code.replace(RULE_START, '').trim();
    const refs = new Set([...body.replace(new RegExp(STR, 'g'), '""').matchAll(IDENT_REF)].map((m) => m[1]));
    const e = { name: c.name, op: c.op, code: code.split('\n').filter((l) => l.trim()).join('\n'), body, refs };
    list.push(e);
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(e);
  }
  return { list, byName };
})();

// Static check: every referenced type name is defined or a prelude type.
const PRELUDE = new Set('any uint nint int bstr bytes tstr text tdate time number biguint bignint bigint integer unsigned decfrac bigfloat eb64url eb64legacy eb16 encoded-cbor uri b64url b64legacy regexp mime-message cbor-any float16 float32 float64 float16-32 float32-64 float false true bool nil null undefined'.split(' '));
{
  const missing = [];
  // type sockets ($x) must have at least one definition; group sockets ($$x)
  // are extension points that may stay empty
  for (const c of IDX.list) for (const r of c.refs) if (!IDX.byName.has(r) && !PRELUDE.has(r) && !r.startsWith('$$')) missing.push(`${r} (in ${c.name})`);
  if (missing.length) throw new Error(`combined CDDL references undefined rules: ${missing.join(', ')}`);
}

const pruneCache = new Map();
function prunedSchema(roots) {
  const key = [...new Set(roots)].sort().join(' ');
  let text = pruneCache.get(key);
  if (text) return text;
  const keep = new Set(roots);
  const queue = [...keep];
  while (queue.length) {
    for (const c of IDX.byName.get(queue.pop()) ?? []) {
      for (const r of c.refs) {
        if (IDX.byName.has(r) && !keep.has(r)) {
          keep.add(r);
          queue.push(r);
        }
      }
    }
  }
  text = IDX.list.filter((c) => keep.has(c.name)).map((c) => c.code).join('\n') + '\n';
  pruneCache.set(key, text);
  return text;
}

// Discriminated unions ($QuicFrame by frame_type, $HTTP3Frame by frame_type,
// $HTTPCapsule by capsule_type, ...), derived from the CDDL: a type whose
// choices all resolve to maps sharing a required literal-valued member.
function unionMembers(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const defs = IDX.byName.get(name);
  if (!defs) return null;
  const out = [];
  for (const d of defs) {
    if (d.body.startsWith('{')) {
      out.push(name);
      continue;
    }
    for (const t of d.body.split('/').map((s) => s.trim())) {
      if (!/^[A-Za-z@_$][\w@.$-]*$/.test(t)) return null;
      const m = unionMembers(t, seen);
      if (!m) return null;
      out.push(...m);
    }
  }
  return out;
}
const discCache = new Map();
function discriminator(name) {
  if (discCache.has(name)) return discCache.get(name);
  let res = null;
  const members = unionMembers(name);
  if (members && members.length > 1) {
    const lits = members.map((m) => Object.fromEntries([...IDX.byName.get(m)[0].body.matchAll(/^\s*"([\w-]+)"\s*:\s*"([^"]*)"\s*$/gm)].map((x) => [x[1], x[2]])));
    const key = Object.keys(lits[0]).find((k) => lits.every((l) => k in l));
    if (key) {
      const values = new Map();
      members.forEach((m, i) => values.has(lits[i][key]) || values.set(lits[i][key], m));
      res = { name, key, values };
    }
  }
  discCache.set(name, res);
  return res;
}
const ALL_DISCRIMINATORS = [...IDX.byName.keys()].map(discriminator).filter(Boolean);

// ------------------------------------------------------------- cddl runner
function checkBin() {
  let v;
  try {
    v = execFileSync(opts.cddlBin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`cannot run cddl CLI "${opts.cddlBin}" (${e.code ?? e.message}). Install it with\n  cargo install cddl --root <dir>\nand set CDDL_BIN=<dir>/bin/cddl (or put it on PATH).`);
    process.exit(2);
  }
  if (!/^cddl \d+\.\d+/.test(v.trim())) {
    console.error(`"${opts.cddlBin}" does not look like the Rust cddl CLI (--version printed: ${v.trim()})`);
    process.exit(2);
  }
  return v.trim();
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let tmpRoot = null;
let tmpSeq = 0;
function tmp(name) {
  tmpRoot ??= mkdtempSync(join(tmpdir(), 'qvis-validate-'));
  return join(tmpRoot, `${tmpSeq++}-${name}`);
}
process.on('exit', () => tmpRoot && rmSync(tmpRoot, { recursive: true, force: true }));

function runCddl(args) {
  return new Promise((resolve, reject) => {
    execFile(opts.cddlBin, ['--ci', ...args], { maxBuffer: 1 << 30 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: err ? err.code : 0, out: stripAnsi(`${stdout}\n${stderr}`) });
    });
  });
}

let active = 0;
const waiters = [];
async function limited(fn) {
  while (active >= opts.jobs) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

// Rephrase cddl-rs messages that are misleading after the adaptations.
function clarify(msg) {
  if (/^string value cannot be validated against a range without the \.size control operator$/.test(msg)) return 'expected an unsigned integer, got a string';
  if (/^expected uint to be in range /.test(msg)) return msg.replace(/^expected uint to be/, 'expected an unsigned integer');
  return msg;
}

// Validate items [{ rule, json }] in one cddl invocation. The root rule is a
// map with one explicitly typed member per item, so every error carries a
// JSON location "/k<i>/..." identifying its item.
async function validateBatch(items) {
  const root = `qvis-batch = {\n${items.map((it, i) => `  "k${i}": ${it.rule}`).join('\n')}\n}\n`;
  const cddlPath = tmp('batch.cddl');
  const jsonPath = tmp('batch.json');
  writeFileSync(cddlPath, root + prunedSchema(items.map((it) => it.rule)));
  writeFileSync(jsonPath, `{${items.map((it, i) => `"k${i}":${it.json}`).join(',\n')}}`);
  const { code, out } = await limited(() => runCddl(['validate', '--cddl', cddlPath, '--json', jsonPath]));
  const results = items.map(() => []);
  if (code === 0 && /is successful/.test(out)) return { results, unattributed: [] };
  // --ci also prints a Debug-escaped copy of the message as 'Error: "..."'
  const m = /Validation of "[^"]*" failed: ([\s\S]*?)(?:\nError: "|$)/.exec(out);
  if (code !== 1 || !m) throw new Error(`cddl CLI failed unexpectedly (exit ${code}):\n${out.slice(0, 4000)}`);
  const unattributed = [];
  for (const raw of m[1].trim().split(/\n(?=error validating )/)) {
    const msg = raw.trim();
    // "error validating [type choice |group entry associated with rule "X" ]at JSON location /k<i>/<path>: <message>"
    const loc = /^error validating (.*?)at JSON location \/k(\d+)(\/[^:\s]*)?: ([\s\S]*)$/.exec(msg);
    if (loc && results[+loc[2]]) results[+loc[2]].push({ path: (loc[3] ?? '').slice(1), message: clarify(loc[4].replace(/\s+/g, ' ').trim()), choice: /type choice/.test(loc[1]) });
    else unattributed.push(msg);
  }
  return { results, unattributed };
}

// Validate any number of items, grouped by rule (smaller pruned CDDL per
// batch), batched and run in parallel. A batch with errors that cannot be
// attributed to an item is bisected until they can.
async function validateItems(items) {
  const results = new Array(items.length);
  const order = items.map((_, i) => i).sort((a, b) => (items[a].rule < items[b].rule ? -1 : items[a].rule > items[b].rule ? 1 : a - b));
  async function run(idx) {
    const r = await validateBatch(idx.map((i) => items[i]));
    if (r.unattributed.length && idx.length > 1) {
      const mid = idx.length >> 1;
      await Promise.all([run(idx.slice(0, mid)), run(idx.slice(mid))]);
      return;
    }
    r.results.forEach((errs, j) => (results[idx[j]] = errs));
    for (const message of r.unattributed) results[idx[0]].push({ path: '', message: message.replace(/\s+/g, ' '), choice: false });
  }
  const jobs = [];
  for (let lo = 0; lo < order.length; lo += opts.batch) jobs.push(run(order.slice(lo, lo + opts.batch)));
  await Promise.all(jobs);
  return results;
}

// ------------------------------------------------------------- file reading
// JSON parsing that keeps the exact source text of numbers: re-serialising
// never rounds integers above 2^53 or turns 0.1 into something else, and
// integral numbers are written in integer form (see adaptation 5).
class RawNum {
  constructor(s) {
    this.s = s;
  }
}
// Integral JSON numbers in integer form (exact decimal arithmetic on the
// source text): 10.0 -> 10, 1e1 -> 10, 100e-1 -> 10, -0.0 -> 0. Others as is.
function canonicalNumber(t) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(t);
  if (!m || (m[3] === undefined && m[4] === undefined && t !== '-0')) return t;
  const digits = m[2] + (m[3] ?? '');
  const point = m[2].length + Number(m[4] ?? 0); // digits before the decimal point
  if (point > 330) return t; // beyond float64 range anyway
  let int;
  if (point <= 0) int = /^0*$/.test(digits) ? '0' : null;
  else if (point >= digits.length) int = digits + '0'.repeat(point - digits.length);
  else int = /^0*$/.test(digits.slice(point)) ? digits.slice(0, point) : null;
  if (int === null) return t;
  int = int.replace(/^0+(?=\d)/, '');
  return int === '0' ? '0' : m[1] + int;
}
const parseRaw = (text) => JSON.parse(text, (k, v, ctx) => (typeof v === 'number' ? new RawNum(ctx.source) : v));
function ser(v) {
  if (v instanceof RawNum) return canonicalNumber(v.s);
  if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${ser(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RawNum);

function readQlog(path) {
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  const problems = []; // { level, where, message }
  if (!Buffer.from(text, 'utf8').equals(buf)) problems.push({ level: 'error', where: 'file', message: 'file is not valid UTF-8 (RFC 8259 Section 8.1)' });
  const first = text.trimStart()[0];
  const kind = first === '\x1e' || (first !== '{' && /\.sqlog$/i.test(path)) ? 'seq' : 'contained';
  const traces = []; // { label, trace, events: [{ index, value, json, parseError }] }
  let header = null;
  let headerJson = null;
  if (kind === 'seq') {
    if (!text.startsWith('\x1e')) problems.push({ level: 'error', where: 'file', message: 'JSON-SEQ file does not start with a record separator 0x1E (RFC 7464)' });
    // RFC 7464 2.1: consecutive RS do not denote empty elements; ignore them
    const records = text.split('\x1e').slice(1).filter((r) => r.trim() !== '');
    const events = [];
    records.forEach((raw, i) => {
      const where = i === 0 ? 'header record' : `event #${i - 1}`;
      const last = i === records.length - 1;
      if (!raw.endsWith('\n')) problems.push({ level: last ? 'warning' : 'error', where, message: `JSON-SEQ record not terminated by LF (RFC 7464)${last ? '; truncated file?' : ''}` });
      let value;
      try {
        value = parseRaw(raw);
      } catch (e) {
        if (i === 0) problems.push({ level: 'error', where, message: `invalid JSON: ${e.message}` });
        else events.push({ index: i - 1, value: null, json: null, parseError: e.message });
        return;
      }
      if (i === 0) {
        header = value;
        headerJson = ser(value);
      } else events.push({ index: i - 1, value, json: ser(value) });
    });
    if (!records.length) problems.push({ level: 'error', where: 'file', message: 'no JSON-SEQ records' });
    traces.push({ label: '', trace: isObj(header) && isObj(header.trace) ? header.trace : null, events });
  } else {
    let doc;
    try {
      doc = parseRaw(text);
    } catch (e) {
      problems.push({ level: 'error', where: 'file', message: `invalid JSON: ${e.message}` });
      return { kind, header: null, headerJson: null, traces, problems };
    }
    header = doc;
    // header = the file with each trace's events emptied ([* Event] allows [])
    const hdr = isObj(doc) ? { ...doc } : doc;
    if (isObj(doc) && Array.isArray(doc.traces)) {
      hdr.traces = doc.traces.map((t, ti) => {
        if (!isObj(t) || !Array.isArray(t.events)) return t;
        traces.push({ label: `trace #${ti} `, trace: t, events: t.events.map((value, index) => ({ index, value, json: ser(value) })) });
        return { ...t, events: [] };
      });
    }
    headerJson = ser(hdr);
  }
  return { kind, header, headerJson, traces, problems };
}

// --------------------------------------------------------- semantic checks
// Hint for names from older drafts (transport:packet_sent,
// recovery:metrics_updated, ...): the probable intended current name.
function suggestName(ns, type) {
  const known = Object.keys(EVENT_TYPES);
  return known.find((n) => n.endsWith(`:${type}`)) ?? known.find((n) => n.endsWith(`:${ns}_${type}`));
}

function semanticChecks(file, report) {
  const fmt = FORMATS[file.kind];
  const h = file.header;
  if (isObj(h)) {
    if (typeof h.file_schema === 'string' && h.file_schema !== fmt.fileSchema) {
      report({ level: 'error', where: 'header', message: `file_schema is "${h.file_schema}", expected "${fmt.fileSchema}" for a ${file.kind === 'seq' ? 'JSON-SEQ (.sqlog)' : 'JSON (.qlog)'} file` });
    }
    if (typeof h.serialization_format === 'string' && h.serialization_format.toLowerCase() !== fmt.media) {
      report({ level: 'error', where: 'header', message: `serialization_format is "${h.serialization_format}", expected "${fmt.media}"` });
    }
  }
  const nsOf = (uri) => /^urn:ietf:params:qlog:events:([^#-]+)/.exec(uri)?.[1];
  for (const t of file.traces) {
    const schemas = isObj(t.trace) && Array.isArray(t.trace.event_schemas) ? t.trace.event_schemas.filter((s) => typeof s === 'string') : [];
    for (const s of schemas) {
      const ns = nsOf(s);
      if (ns && NAMESPACE_SCHEMA[ns] && s !== NAMESPACE_SCHEMA[ns] && !s.startsWith(NAMESPACE_SCHEMA[ns] + '#')) {
        report({ level: 'error', where: `${t.label}event_schemas`, message: `"${s}" does not identify the supported draft; expected "${NAMESPACE_SCHEMA[ns]}"` });
      }
    }
    const seenNs = new Set();
    for (const ev of t.events) {
      ev.label = `${t.label}event #${ev.index}`;
      ev.rule = 'qvis-event-unknown';
      if (ev.parseError) continue;
      const name = isObj(ev.value) ? ev.value.name : undefined;
      if (typeof name !== 'string') continue; // reported by the CDDL check
      ev.name = name;
      const m = /^([^:]+):(.+)$/.exec(name);
      if (!m) {
        ev.semantic = { level: 'error', message: `name "${name}" is not "<namespace>:<event type>" (main-schema-14 Section 8)` };
        continue;
      }
      seenNs.add(m[1]);
      if (EVENT_TYPES[name]) {
        ev.rule = `qvis-event-${EVENT_TYPES[name]}`;
        continue;
      }
      const level = opts.allowUnknown ? 'warning' : 'error';
      const what = NAMESPACE_SCHEMA[m[1]] ? `is not an event type of namespace "${m[1]}"` : `uses namespace "${m[1]}", which is not defined`;
      const hint = suggestName(m[1], m[2]);
      ev.semantic = { level, message: `"${name}" ${what} in the supported drafts${hint ? ` (did you mean "${hint}"? data checked as ${EVENT_TYPES[hint]})` : ''}` };
      // still validate data against the probable intended type so one report
      // lists everything that needs fixing
      if (hint) {
        ev.rule = `qvis-event-${EVENT_TYPES[hint]}`;
        ev.assumed = hint;
      }
    }
    for (const ns of seenNs) {
      if (NAMESPACE_SCHEMA[ns] && !schemas.some((s) => nsOf(s) === ns)) {
        report({ level: 'warning', where: `${t.label}event_schemas`, message: `events of namespace "${ns}" are logged but "${NAMESPACE_SCHEMA[ns]}" is not listed (SHOULD, main-schema-14 Section 8)` });
      }
    }
  }
}

// ------------------------------------------- detail pass and condensation
const ARRAY_FAIL = /^array validation failed: (?:group (?:[*+?] |\d*\*\d* )?([$\w@.-]+) matched the first (\d+) element|element sequence does not match group (?:[*+?] |\d*\*\d* )?([$\w@.-]+) \(mismatch at element index (\d+)\))/;
const CHOICE_LIT = /^expected value "(.*)" got "(.*)"$/;
const MAX_ELEMENTS = 64;

function getAt(v, path) {
  for (const seg of path.split('/').filter(Boolean)) {
    if (Array.isArray(v)) v = v[Number(seg)];
    else if (isObj(v)) v = v[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    else return undefined;
  }
  return v;
}

// cddl-rs reports a failing array only as "matched the first N element(s)",
// and a failing type choice as one flood of messages per alternative. For
// arrays, re-validate each element from N on against the element type; for
// discriminated unions, against the member selected by the discriminator.
async function detailPass(failing) {
  const targets = []; // { ev, base, rule, value, remove(errs) }
  for (const ev of failing) {
    let value;
    try {
      value = parseRaw(ev.json);
    } catch {
      continue;
    }
    const resolve = (path, type) => {
      const v = getAt(value, path);
      const disc = type && discriminator(type);
      if (disc) {
        const d = isObj(v) ? v[disc.key] : undefined;
        const rule = disc.values.get(d);
        if (!rule) {
          return { message: `${disc.key} ${d === undefined ? 'missing' : JSON.stringify(d)}: not a ${disc.name} member; expected one of ${[...disc.values.keys()].map((x) => `"${x}"`).join(', ')}` };
        }
        return { rule, v };
      }
      return { rule: type, v };
    };
    for (const e of ev.errors) {
      const a = ARRAY_FAIL.exec(e.message);
      if (!a) continue;
      const type = a[1] ?? a[3];
      const from = Number(a[2] ?? a[4]);
      const arr = getAt(value, e.path);
      if (!Array.isArray(arr) || !IDX.byName.has(type)) continue;
      const subs = [];
      for (let i = from; i < Math.min(arr.length, from + MAX_ELEMENTS); i++) subs.push(resolve(`${e.path}/${i}`, type));
      targets.push({ ev, base: e.path, sub: subs.map((s, k) => ({ ...s, path: `${e.path}/${from + k}` })), drop: (x) => x === e });
    }
    // type-choice floods on a discriminator member: ".../frame_type: expected value "padding" got "crypto"", ...
    const floods = new Map();
    for (const e of ev.errors) {
      const m = e.choice && CHOICE_LIT.exec(e.message);
      const key = m && e.path.split('/').at(-1);
      if (!m || !ALL_DISCRIMINATORS.some((d) => d.key === key)) continue;
      const parent = e.path.split('/').slice(0, -1).join('/');
      if (!floods.has(parent)) floods.set(parent, { key, expected: new Set() });
      floods.get(parent).expected.add(m[1]);
    }
    for (const [parent, f] of floods) {
      const cands = ALL_DISCRIMINATORS.filter((d) => d.key === f.key && [...f.expected].every((x) => d.values.has(x))).sort((x, y) => x.values.size - y.values.size);
      if (!cands.length) continue;
      const s = resolve(parent, cands[0].name);
      targets.push({ ev, base: parent, sub: [{ ...s, path: parent }], drop: (x) => x.choice && (x.path === parent || x.path.startsWith(parent + '/')) });
    }
  }
  const items = [];
  for (const t of targets) for (const s of t.sub) if (s.rule) items.push({ rule: s.rule, json: ser(s.v), s });
  const res = items.length ? await validateItems(items) : [];
  res.forEach((errs, i) => (items[i].s.errors = errs));
  for (const t of targets) {
    const repl = [];
    for (const s of t.sub) {
      if (s.message) repl.push({ path: s.path, message: s.message, choice: false });
      for (const e of s.errors ?? []) repl.push({ path: `${s.path}${e.path ? '/' + e.path : ''}`, message: e.message, choice: e.choice, as: s.rule });
    }
    if (!repl.length) continue; // keep the original message
    const kept = t.ev.errors.filter((x) => !t.drop(x));
    const have = new Set(kept.map((x) => `${x.path}\0${x.message}`));
    t.ev.errors = kept.concat(repl.filter((x) => !have.has(`${x.path}\0${x.message}`)));
  }
}

// Collapse what remains of type-choice floods (e.g. enums of string literals,
// $TransportError / CryptoError / $ApplicationError) into one message per path.
function condense(errs) {
  const out = [];
  const choices = new Map();
  const seen = new Set();
  for (const e of errs) {
    const k = `${e.path}\0${e.message}\0${e.as ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (e.choice) {
      if (!choices.has(e.path)) choices.set(e.path, []);
      choices.get(e.path).push(e);
    } else out.push(e);
  }
  for (const [path, list] of choices) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    let got;
    const alts = [];
    for (const e of list) {
      let m;
      if ((m = CHOICE_LIT.exec(e.message))) {
        alts.push(`"${m[1]}"`);
        got ??= `"${m[2]}"`;
      } else if ((m = /^expected "(.*)" to match regex "(.*)"$/.exec(e.message))) {
        alts.push(`/${m[2]}/`);
        got ??= `"${m[1]}"`;
      } else if ((m = /^expected type (\S+), got (.*)$/.exec(e.message))) {
        alts.push(m[1]);
        got ??= m[2];
      } else alts.push(e.message);
    }
    const uniq = [...new Set(alts)];
    const shown = uniq.length > 12 ? `${uniq.slice(0, 12).join(' | ')} | … (${uniq.length - 12} more)` : uniq.join(' | ');
    out.push({ path, message: `no type choice matched${got ? ` ${got}` : ''}; expected ${shown}`, choice: true, as: list[0].as });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ----------------------------------------------------------------- files
async function validateFile(path) {
  const t0 = performance.now();
  const file = readQlog(path);
  const fileProblems = [...file.problems];
  semanticChecks(file, (p) => fileProblems.push(p));

  const items = [];
  if (file.headerJson != null) items.push({ rule: FORMATS[file.kind].rule, json: file.headerJson, ref: null });
  const events = file.traces.flatMap((t) => t.events);
  for (const ev of events) if (!ev.parseError) items.push({ rule: ev.rule, json: ev.json, ref: ev });
  const results = items.length ? await validateItems(items) : [];
  results.forEach((errs, i) => {
    if (!errs.length) return;
    if (items[i].ref) items[i].ref.errors = errs;
    else for (const e of condense(errs)) fileProblems.push({ level: 'error', where: `header${e.path ? '/' + e.path : ''}`, message: e.message });
  });
  const failing = events.filter((ev) => ev.errors?.length);
  if (opts.detail) await detailPass(failing.slice(0, opts.detail));

  const failures = [];
  const byName = new Map();
  const unknownWarn = new Map();
  for (const ev of events) {
    const msgs = [];
    if (ev.parseError) msgs.push({ path: '', message: `invalid JSON: ${ev.parseError}` });
    if (ev.semantic?.level === 'error') msgs.push({ path: 'name', message: ev.semantic.message });
    if (ev.errors) msgs.push(...condense(ev.errors));
    if (ev.semantic?.level === 'warning') {
      const w = unknownWarn.get(ev.name) ?? { n: 0, message: ev.semantic.message };
      w.n++;
      unknownWarn.set(ev.name, w);
    }
    if (!msgs.length) continue;
    failures.push({ index: ev.index, label: ev.label, name: ev.name ?? null, type: ev.rule === 'qvis-event-unknown' ? null : ev.rule.replace(/^qvis-event-/, ''), assumed: ev.assumed ?? null, errors: msgs });
    const k = ev.name ?? '(no name)';
    byName.set(k, (byName.get(k) ?? 0) + 1);
  }
  for (const [, w] of unknownWarn) fileProblems.push({ level: 'warning', where: 'events', message: `${w.n} × ${w.message}` });
  // distinct issues: event type + path pattern + message pattern, with counts
  const issues = new Map();
  for (const f of failures) {
    for (const e of f.errors) {
      const path = e.path.replace(/\/\d+(?=\/|$)/g, '/*');
      const msg = e.message
        .replace(/^(name: )?"[^"]*" (uses namespace|is not an event type)/, '$1<name> $2')
        .replace(/^expected "[^"]*" to match/, 'expected <value> to match')
        .replace(/^no type choice matched (?:"[^"]*"|\S+);/, 'no type choice matched <value>;')
        .replace(/, got -?[\d.e+]+$/, ', got <n>')
        .replace(/ got "[^"]*"$/, ' got <value>')
        .replace(/ got (-?[\d.e+]+)$/, ' got <n>');
      const key = `${f.assumed ?? f.name}\0${path}\0${e.as ?? ''}\0${msg}`;
      const it = issues.get(key) ?? { event: f.assumed ?? f.name, path, as: e.as ?? null, message: msg, count: 0, example: f.label };
      it.count++;
      issues.set(key, it);
    }
  }
  const errors = fileProblems.filter((p) => p.level === 'error').length + failures.length;
  const warnings = fileProblems.filter((p) => p.level === 'warning').length;
  return {
    file: path,
    format: file.kind === 'seq' ? 'JSON-SEQ (QlogFileSeq)' : 'JSON (QlogFile)',
    events: events.length,
    failedEvents: failures.length,
    errors,
    warnings,
    ok: errors === 0 && (!opts.werror || warnings === 0),
    fileProblems,
    failuresByName: Object.fromEntries([...byName].sort((a, b) => b[1] - a[1])),
    issues: [...issues.values()].sort((a, b) => b.count - a.count),
    failures,
    ms: Math.round(performance.now() - t0),
  };
}

function printReport(r) {
  const out = [];
  out.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}`);
  out.push(`      ${r.format}: ${r.events} events, ${r.failedEvents} failing events, ${r.errors - r.failedEvents} file-level errors, ${r.warnings} warnings (${r.ms} ms)`);
  if (!opts.quiet) {
    for (const p of r.fileProblems) out.push(`      ${p.level === 'error' ? 'ERROR' : 'warn '} ${p.where}: ${p.message}`);
    if (r.failedEvents) {
      out.push(`      failing events by name: ${Object.entries(r.failuresByName).map(([n, c]) => `${n} ×${c}`).join(', ')}`);
      const shown = opts.maxReport ? r.failures.slice(0, opts.maxReport) : r.failures;
      for (const f of shown) {
        out.push(`      ${f.label} ${f.name ? `"${f.name}"` : '(no name)'}${f.type ? ` -> ${f.type}${f.assumed ? ` (as ${f.assumed})` : ''}` : ''}:`);
        const msgs = opts.maxMessages ? f.errors.slice(0, opts.maxMessages) : f.errors;
        for (const e of msgs) {
          const m = e.message.length > 400 ? e.message.slice(0, 400) + '…' : e.message;
          out.push(`          ${e.path ? `/${e.path}` : '(event)'}${e.as ? ` [${e.as}]` : ''}: ${m}`);
        }
        if (msgs.length < f.errors.length) out.push(`          … ${f.errors.length - msgs.length} more`);
      }
      if (shown.length < r.failures.length) out.push(`      … ${r.failures.length - shown.length} more failing events (--max-report 0 shows all)`);
      if (opts.summary) {
        out.push(`      issue summary (${r.issues.length} distinct; count × event type  path [rule]: message):`);
        for (const it of r.issues.slice(0, opts.summary)) {
          out.push(`        ${String(it.count).padStart(6)} × ${it.event ?? '(no name)'}  ${it.path ? `/${it.path}` : '(event)'}${it.as ? ` [${it.as}]` : ''}: ${it.message.length > 200 ? it.message.slice(0, 200) + '…' : it.message}`);
        }
        if (r.issues.length > opts.summary) out.push(`        … ${r.issues.length - opts.summary} more (--summary 0 = off, --json for all)`);
      }
    }
  }
  console.log(out.join('\n'));
}

// -------------------------------------------------------------- self-test
// Proves that the validator (cddl-rs + the adaptations above) accepts and
// rejects what the published CDDL says it should.
async function selfTest() {
  const header = {
    file_schema: 'urn:ietf:params:qlog:file:sequential',
    serialization_format: 'application/qlog+json-seq',
    trace: { vantage_point: { type: 'client' }, event_schemas: ['urn:ietf:params:qlog:events:quic-13', 'urn:ietf:params:qlog:events:http3-13', 'urn:ietf:params:qlog:events:loglevel'] },
  };
  const ps = (data, extra = {}) => ({ time: 1.5, name: 'quic:packet_sent', data: { header: { packet_type: '1RTT', packet_number: 7 }, ...data }, ...extra });
  const frames = (...f) => ps({ frames: f });
  // [description, event (object or raw JSON text), null = must pass | RegExp matched against "path [as]: message"]
  const cases = [
    ['integer time (JSON number without fraction is a float64)', { time: 1553986553572, name: 'quic:packet_sent', data: { header: { packet_type: 'initial', packet_number: 0, version: '00000001', scid: 'aa', dcid: '0011' } } }, null],
    ['custom event fields (* text => any)', ps({}, { ODCID: '127ecc83', group_id: 'g' }), null],
    ['uint64 max value', ps({ header: { packet_type: '1RTT', packet_number: 18446744073709551615n } }), null],
    ['integral numbers as uint (RFC 8610 App. E: 10.0, 1e1, 100e-1)', '{"time":1,"name":"quic:packet_sent","data":{"header":{"packet_type":"1RTT","packet_number":10.0,"packet_number_length":1e1,"length":100e-1,"key_phase":-0}}}', null],
    ['new_connection_id with 16-byte stateless_reset_token', frames({ frame_type: 'new_connection_id', sequence_number: 1, retire_prior_to: 0, connection_id: 'aabb', stateless_reset_token: '00112233445566778899aabbccddeeff' }), null],
    ['connection_close with crypto_error_0x1a0', frames({ frame_type: 'connection_close', error_space: 'transport', error: 'crypto_error_0x1a0' }), null],
    ['connection_close with HTTP/3 application error', frames({ frame_type: 'connection_close', error_space: 'application', error: 'http_no_error' }), null],
    ['ack with [from,to] and [single] ranges, float ack_delay', frames({ frame_type: 'ack', ack_delay: 0.25, acked_ranges: [[1, 2], [4]] }), null],
    ['recovery_metrics_updated with int and float rtt', { time: 2, name: 'quic:recovery_metrics_updated', data: { smoothed_rtt: 25, latest_rtt: 24.5, congestion_window: 13500 } }, null],
    ['http3:frame_parsed settings', { time: 3, name: 'http3:frame_parsed', data: { stream_id: 3, frame: { frame_type: 'settings', settings: [{ name: 'settings_h3_datagram', value: 1 }] } } }, null],
    ['loglevel:info', { time: 4, name: 'loglevel:info', data: { message: 'hi' } }, null],
    ['negative uint', ps({ header: { packet_type: '1RTT', packet_number: -1 } }), /\/data\/header\/packet_number.*got -1/],
    ['uint8 overflow', ps({ header: { packet_type: '1RTT', packet_number_length: 256 } }), /packet_number_length.*0 <= value <= 255/],
    ['uint given as non-integral number', '{"time":1,"name":"quic:packet_sent","data":{"header":{"packet_type":"1RTT","packet_number":1.5,"length":15e-1}}}', /\/data\/header\/length: .*got 1\.5[\s\S]*\/data\/header\/packet_number: .*got 1\.5/],
    ['uint64 overflow written as 1.8446744073709551616e19', '{"time":1,"name":"quic:packet_sent","data":{"header":{"packet_type":"1RTT","packet_number":1.8446744073709551616e19}}}', /packet_number/],
    ['hexstring with non-hex chars', ps({ header: { packet_type: '1RTT', dcid: 'zz00' } }), /\/data\/header\/dcid.*regex/],
    ['hexstring with odd length', ps({ header: { packet_type: '1RTT', dcid: 'abc' } }), /dcid.*regex/],
    ['hexstring with uppercase', ps({ header: { packet_type: '1RTT', dcid: 'AB' } }), /dcid.*regex/],
    ['quic version as non-hexstring "1"', ps({ header: { packet_type: 'initial', version: '1' } }), /version.*regex/],
    ['8-byte stateless_reset_token', frames({ frame_type: 'new_connection_id', sequence_number: 1, retire_prior_to: 0, connection_id: 'aabb', stateless_reset_token: '0011223344556677' }), /frames\/0\/stateless_reset_token \[NewConnectionIDFrame\]/],
    ['unexpected key in data', ps({ datagram_payload_checksum: 5 }), /\/data: unexpected key "datagram_payload_checksum"/],
    ['missing required member', { time: 1, name: 'quic:connection_started', data: { local: {} } }, /\/data: object missing key: "?remote/],
    ['invalid enum value', ps({ header: { packet_type: 'one_rtt' } }), /packet_type.*no type choice matched "one_rtt"/],
    ['stream frame without stream_id (detail pass)', frames({ frame_type: 'ping' }, { frame_type: 'stream', offset: 0, length: 5 }), /frames\/1 \[StreamFrame\]: (object missing key: "?stream_id|unexpected key "length")/],
    ['second bad frame also reported', frames({ frame_type: 'crypto', offset: 0, length: 3 }, { frame_type: 'stream', stream_id: 0, length: 5 }), /frames\/1 \[StreamFrame\]: unexpected key "length"/],
    ['unknown frame_type', frames({ frame_type: 'foo' }), /frames\/0: frame_type "foo": not a \$QuicFrame member/],
    ['bad HTTP/3 frame (union outside an array)', { time: 1, name: 'http3:frame_created', data: { stream_id: 0, frame: { frame_type: 'headers', headers: [], length: 3 } } }, /\/data\/frame \[HTTP3HeadersFrame\]: unexpected key "length"/],
    ['crypto_error out of range', frames({ frame_type: 'connection_close', error: 'crypto_error_0x2a0' }), /frames\/0\/error \[ConnectionCloseFrame\]: no type choice matched "crypto_error_0x2a0"/],
    ['time as string', { time: '1', name: 'loglevel:info', data: { message: 'x' } }, /\/time/],
    ['missing data', { time: 1, name: 'loglevel:info' }, /missing key: "?data/],
    ['tuple of wrong type (":" is a cut)', ps({}, { tuple: 5 }), /\/tuple/],
    ['ack range with 3 numbers', frames({ frame_type: 'ack', acked_ranges: [[1, 2, 3]] }), /acked_ranges/],
    ['name without namespace', { time: 1, name: 'packet_sent', data: {} }, /name: name "packet_sent" is not/],
    ['unknown event type in quic namespace', { time: 1, name: 'quic:foo', data: {} }, /not an event type of namespace "quic"/],
    ['legacy name (data still checked)', { time: 1, name: 'transport:packet_sent', data: { header: { packet_type: 'initial', version: '1' } } }, /did you mean "quic:packet_sent"[\s\S]*version.*regex/],
    ['invalid JSON record', '{"time": 1, "name": ', /invalid JSON/],
  ];
  const big = (v) => (typeof v === 'bigint' ? `__BIG${v}__` : v);
  const toJson = (o) => JSON.stringify(o, (k, v) => big(v)).replace(/"__BIG(\d+)__"/g, '$1');
  const file = tmp('selftest.sqlog');
  writeFileSync(file, [header, ...cases.map((c) => c[1])].map((r) => `\x1e${typeof r === 'string' ? r : toJson(r)}\n`).join(''));
  const r = await validateFile(file);
  let bad = 0;
  const check = (ok, desc, detail) => {
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${desc}${ok ? '' : `\n        ${detail}`}`);
  };
  cases.forEach(([desc, , expect], i) => {
    const f = r.failures.find((x) => x.index === i);
    const text = f ? f.errors.map((e) => `/${e.path}${e.as ? ` [${e.as}]` : ''}: ${e.message}`).join('\n') : '';
    if (expect === null) check(!f, `accepts: ${desc}`, text);
    else check(f && expect.test(text), `rejects: ${desc}`, f ? `messages did not match ${expect}:\n${text}` : 'was accepted');
  });
  check(r.fileProblems.length === 0, 'accepts: QlogFileSeq header (~LogFile unwrap), no file-level problems', JSON.stringify(r.fileProblems));

  // header / file-level checks
  const fileCase = async (desc, content, re, name = 'case.sqlog') => {
    const p = tmp(name);
    writeFileSync(p, content);
    const x = await validateFile(p);
    const text = x.fileProblems.map((q) => `${q.where}: ${q.message}`).join('\n') + x.failures.map((f) => f.errors.map((e) => `${f.label} /${e.path}: ${e.message}`).join('\n')).join('\n');
    if (re === null) check(x.ok, `accepts: ${desc}`, text);
    else check(!x.ok && re.test(text), `rejects: ${desc}`, text || 'was accepted');
  };
  const ev = { time: 1, name: 'loglevel:info', data: { message: 'x' } };
  const seq = (h) => `\x1e${JSON.stringify(h)}\n\x1e${JSON.stringify(ev)}\n`;
  await fileCase('header with legacy qlog_version', seq({ ...header, qlog_version: '0.3' }), /header: unexpected key "qlog_version"/);
  await fileCase('header without file_schema', seq({ ...header, file_schema: undefined }), /header: object missing key: "?file_schema/);
  await fileCase('TraceSeq with an events array', seq({ ...header, trace: { ...header.trace, events: [] } }), /header\/trace: unexpected key "events"/);
  await fileCase('contained file_schema in a .sqlog', seq({ ...header, file_schema: 'urn:ietf:params:qlog:file:contained' }), /file_schema is/);
  await fileCase('event_schemas with quic-12', seq({ ...header, trace: { ...header.trace, event_schemas: ['urn:ietf:params:qlog:events:quic-12'] } }), /quic-12" does not identify/);
  await fileCase('JSON-SEQ record without trailing LF', `\x1e${JSON.stringify(header)}\x1e${JSON.stringify(ev)}\n`, /not terminated by LF/);
  const contained = (events) => JSON.stringify({ file_schema: 'urn:ietf:params:qlog:file:contained', serialization_format: 'application/qlog+json', traces: [{ vantage_point: { type: 'server' }, event_schemas: ['urn:ietf:params:qlog:events:quic-13'], events }] });
  await fileCase('contained .qlog (QlogFile)', contained([{ time: 0, name: 'quic:packet_sent', data: { header: { packet_type: 'initial', packet_number: 0 } } }]), null, 'case.qlog');
  await fileCase('bad event inside a contained .qlog', contained([ev, { time: 1, name: 'quic:packet_sent', data: { header: { packet_type: 'initial', packet_number: -5 } } }]), /trace #0 event #1 \/data\/header\/packet_number/, 'case.qlog');
  console.log(bad ? `\nself-test FAILED: ${bad} check(s)` : '\nself-test passed');
  return bad === 0;
}

// ------------------------------------------------------------------- main
const c = adapted.counts;
const banner = `CDDL: ${CDDL_SOURCES.join(' + ')}; cddl-rs/JSON adaptations: ${c.keys} keys quoted, ${c.unwrap} ~unwraps inlined, ${c.uint} uint -> ranges, ${c.regexp} .regexp anchored, ${c.float} floats accept JSON ints, ${c.hexsize} "hexstring .size N" -> N bytes`;
if (opts.emitSpecCddl) {
  writeFileSync(opts.emitSpecCddl, `; Combined CDDL of ${CDDL_SOURCES.join(', ')} (verbatim; identical duplicates kept once).\n; Generated by: node scripts/validate-qlog.mjs --emit-spec-cddl <file>\n${spec.notes.map((n) => `; note: ${n}\n`).join('')}\n${spec.text}`);
  console.error(`wrote ${opts.emitSpecCddl}`);
}
if (opts.emitCddl) {
  writeFileSync(opts.emitCddl, `; Combined + adapted CDDL used by scripts/validate-qlog.mjs\n; (${banner}).\n; Validation roots: QlogFileSeq, QlogFile, qvis-event-<Type>.\n; Generated by: node scripts/validate-qlog.mjs --emit-cddl <file>\n\n${SCHEMA}`);
  console.error(`wrote ${opts.emitCddl}`);
}
if (opts.checkCddl || opts.selfTest || opts.files.length) {
  const version = checkBin();
  let exit = 0;
  if (opts.checkCddl) {
    for (const [label, text] of [['spec', `qvis-root = QlogFileSeq / QlogFile\n${spec.text}`], ['adapted', `qvis-root = QlogFileSeq / QlogFile\n${SCHEMA}`]]) {
      const p = tmp(`${label}.cddl`);
      writeFileSync(p, text);
      const { code, out } = await runCddl(['compile-cddl', '--cddl', p]);
      const ok = code === 0 && /is conformant/.test(out);
      if (!ok) exit = 1;
      console.error(`${label} CDDL: ${ok ? 'compiles (conformant)' : `FAILED\n${out}`}`);
    }
  }
  if (opts.selfTest) {
    console.error(`${version}; ${banner}`);
    if (!(await selfTest())) exit = 1;
  }
  if (opts.files.length) {
    if (!opts.json && !opts.quiet) console.error(`${version}; ${banner}`);
    const reports = [];
    for (const f of opts.files) {
      let r;
      try {
        r = await validateFile(f);
      } catch (e) {
        r = { file: f, ok: false, errors: 1, warnings: 0, events: 0, failedEvents: 0, fileProblems: [{ level: 'error', where: 'file', message: e.message }], failures: [], failuresByName: {}, issues: [], format: '?', ms: 0 };
      }
      reports.push(r);
      if (!opts.json) printReport(r);
    }
    const failed = reports.filter((r) => !r.ok).length;
    if (opts.json) console.log(JSON.stringify({ drafts: CDDL_SOURCES, validator: version, adaptations: c, files: reports }, null, 2));
    else if (reports.length > 1) console.log(`\n${reports.length - failed}/${reports.length} files passed`);
    if (failed) exit = 1;
  }
  process.exitCode = exit;
}
