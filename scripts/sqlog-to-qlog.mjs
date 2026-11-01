#!/usr/bin/env node
// Merges qlog JSON-SEQ files (.sqlog, QlogFileSeq) into one contained JSON qlog
// file (.qlog, QlogFile), as defined by draft-ietf-quic-qlog-main-schema-14:
//
//   QlogFileSeq = { ~LogFile, trace: TraceSeq }        one TraceSeq header record + one record per Event
//   QlogFile    = { ~LogFile, ? traces: [+ Trace / TraceError] }
//   Trace       = { ? title, ? description, ? common_fields, ? vantage_point, event_schemas, events: [* Event] }
//
// Every input file becomes one Trace: its TraceSeq header fields (kept as is)
// followed by "events" holding the file's event records in their original order.
// Event records are copied verbatim, so numbers keep their exact text.
//
// Usage: node scripts/sqlog-to-qlog.mjs [options] <in.sqlog>... > out.qlog
// No npm dependencies; Node 18+.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const SEQ_SCHEMA = 'urn:ietf:params:qlog:file:sequential';
const SEQ_FORMAT = 'application/qlog+json-seq';
const CONTAINED_SCHEMA = 'urn:ietf:params:qlog:file:contained';
const CONTAINED_FORMAT = 'application/qlog+json';
const RS = '\x1e';

function usage(code) {
  (code ? process.stderr : process.stdout).write(`usage: sqlog-to-qlog.mjs [options] <in.sqlog>...

Merges one or more qlog JSON-SEQ files (QlogFileSeq) into one contained JSON
qlog file (QlogFile, file_schema "${CONTAINED_SCHEMA}",
serialization_format "${CONTAINED_FORMAT}"). Each input becomes one entry of
"traces", in the order given: its TraceSeq header plus its events.

options:
  -o, --output <file>      write to <file> instead of stdout
  --title <text>           QlogFile title (default: the inputs' common title)
  --description <text>     QlogFile description (default: names the input files)
  --trace-title <text>     override the title of the next input's trace (repeatable,
                           applies to the inputs in order)
  --drop-truncated         ignore a truncated (unparsable) last record of an input,
                           as RFC 7464 permits, instead of failing
  --compact                no line breaks (default: one event per line)
  -h, --help               show this help
`);
  process.exit(code);
}

const opts = { output: null, title: null, description: null, traceTitles: [], dropTruncated: false, compact: false, inputs: [] };
{
  const a = process.argv.slice(2);
  const str = (i) => (a[i] === undefined ? usage(2) : a[i]);
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '-o': case '--output': opts.output = str(++i); break;
      case '--title': opts.title = str(++i); break;
      case '--description': opts.description = str(++i); break;
      case '--trace-title': opts.traceTitles.push(str(++i)); break;
      case '--drop-truncated': opts.dropTruncated = true; break;
      case '--compact': opts.compact = true; break;
      case '-h': case '--help': usage(0); break;
      default:
        if (a[i].startsWith('-') && a[i] !== '-') usage(2);
        opts.inputs.push(a[i]);
    }
  }
  if (opts.inputs.length === 0) usage(2);
}

function fail(msg) {
  process.stderr.write(`sqlog-to-qlog: ${msg}\n`);
  process.exit(1);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Splits a JSON-SEQ text (RFC 7464) into its records' JSON texts.
function readSeq(file) {
  let text = readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trimStart().startsWith(RS)) {
    fail(`${file}: not a JSON text sequence (records must start with the RS character 0x1E)`);
  }
  const records = text.split(RS).slice(1).map((r) => r.trim());
  const parsed = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i] === '') continue; // empty record (e.g. a doubled RS)
    try {
      parsed.push({ text: records[i], value: JSON.parse(records[i]) });
    } catch (err) {
      if (i === records.length - 1 && opts.dropTruncated) {
        process.stderr.write(`sqlog-to-qlog: ${file}: dropping truncated last record (${err.message})\n`);
        continue;
      }
      fail(`${file}: record ${i + 1} is not valid JSON (${err.message})${i === records.length - 1 ? '; use --drop-truncated to ignore a truncated last record' : ''}`);
    }
  }
  return parsed;
}

const traces = [];
const titles = new Set();
opts.inputs.forEach((file, idx) => {
  const records = readSeq(file);
  if (records.length === 0) fail(`${file}: empty file`);
  const header = records[0].value;
  if (!isObject(header) || !isObject(header.trace)) {
    fail(`${file}: the first record is not a QlogFileSeq header (it has no "trace" object)`);
  }
  if (header.file_schema !== SEQ_SCHEMA) {
    fail(`${file}: file_schema is ${JSON.stringify(header.file_schema)}, expected "${SEQ_SCHEMA}"`);
  }
  if (header.serialization_format !== SEQ_FORMAT) {
    fail(`${file}: serialization_format is ${JSON.stringify(header.serialization_format)}, expected "${SEQ_FORMAT}"`);
  }
  if (header.title !== undefined) titles.add(header.title);
  const trace = { ...header.trace };
  if (opts.traceTitles[idx] !== undefined) trace.title = opts.traceTitles[idx];
  if ('events' in trace) fail(`${file}: the TraceSeq header unexpectedly contains "events"`);
  const events = [];
  for (let i = 1; i < records.length; i++) {
    if (!isObject(records[i].value)) fail(`${file}: record ${i + 1} is not a JSON object`);
    events.push(records[i].text);
  }
  traces.push({ trace, events });
});

const file = {
  file_schema: CONTAINED_SCHEMA,
  serialization_format: CONTAINED_FORMAT,
  title: opts.title ?? (titles.size === 1 ? [...titles][0] : 'Merged qlog traces'),
  description: opts.description ??
    `Contained qlog file with ${traces.length} trace${traces.length === 1 ? '' : 's'}, merged from ${opts.inputs.map((f) => basename(f)).join(', ')}`,
};

// Serialize. The trace headers are re-serialized with JSON.stringify (they only
// hold small values); the event records are inserted as their original text.
const nl = opts.compact ? '' : '\n';
const ind = (n) => (opts.compact ? '' : '  '.repeat(n));
const sep = opts.compact ? ':' : ': ';
const parts = ['{', nl];
for (const [k, v] of Object.entries(file)) parts.push(ind(1), JSON.stringify(k), sep, JSON.stringify(v), ',', nl);
parts.push(ind(1), '"traces"', sep, '[', nl);
traces.forEach(({ trace, events }, ti) => {
  parts.push(ind(2), '{', nl);
  for (const [k, v] of Object.entries(trace)) parts.push(ind(3), JSON.stringify(k), sep, JSON.stringify(v), ',', nl);
  parts.push(ind(3), '"events"', sep, '[', nl);
  events.forEach((e, i) => parts.push(ind(4), e, i < events.length - 1 ? ',' : '', nl));
  parts.push(ind(3), ']', nl, ind(2), '}', ti < traces.length - 1 ? ',' : '', nl);
});
parts.push(ind(1), ']', nl, '}', nl);
const out = parts.join('');

JSON.parse(out); // sanity check: the result is one valid JSON text
if (opts.output) writeFileSync(opts.output, out);
else process.stdout.write(out);
process.stderr.write(
  `sqlog-to-qlog: ${traces.length} trace(s), ${traces.reduce((n, t) => n + t.events.length, 0)} events` +
    (opts.output ? ` -> ${opts.output} (${Buffer.byteLength(out)} bytes)` : '') + '\n',
);
