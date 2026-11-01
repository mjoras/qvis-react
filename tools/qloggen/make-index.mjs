#!/usr/bin/env node
// Writes the demo manifests of qvis-react from scenarios.json and the generated files:
//   <examples>/index.json          one entry per scenario in public/examples/ (loaded by "Load example .qlog files")
//   <examples>/massive/index.json  one entry per scenario in public/examples/massive/ (the first one is loaded by
//                                  the massive demo button)
// Each manifest is an array of {file, title, description, size} (see src/loading/demo.ts), where file is relative
// to the manifest's folder and size is in bytes. The other members (id, traces, events, duration_ms, scenario,
// variants) are informational; the app ignores them.
//
// Usage: node tools/qloggen/make-index.mjs [examples-dir]   (default: public/examples next to tools/)
import { readFileSync, writeFileSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = process.argv[2] ?? join(HERE, '..', '..', 'public', 'examples');
const { scenarios } = JSON.parse(readFileSync(join(HERE, 'scenarios.json'), 'utf8'));
const GENERATOR = 'tools/qloggen: quic-go v0.64.1 + quic-go-v0.64.1-qlog-latest.patch (qlog main-schema-14, quic-events-13, h3-events-13)';

// Number of events and time of the last event of a JSON-SEQ file (the header is not an event).
function seqStats(path) {
  const text = readFileSync(path, 'utf8');
  let records = 0;
  for (let i = text.indexOf('\x1e'); i !== -1; i = text.indexOf('\x1e', i + 1)) records++;
  const last = JSON.parse(text.slice(text.lastIndexOf('\x1e') + 1));
  return { events: records - 1, duration_ms: Math.round(last.time ?? 0) };
}

// The first bytes of a file, to read the vantage point type from a .sqlog header.
function head(path, n = 4096) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(n, fstatSync(fd).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const manifests = new Map(); // dir -> entries
for (const sc of scenarios) {
  const dir = join(EXAMPLES, sc.dir);
  const files = {
    client: `${sc.id}_client.sqlog`,
    server: `${sc.id}_server.sqlog`,
    qlog: sc.qlog ? `${sc.id}.qlog` : undefined,
  };
  for (const f of Object.values(files)) {
    if (f !== undefined && !existsSync(join(dir, f))) throw new Error(`missing ${join(dir, f)} (run generate.sh first)`);
  }
  const variants = [];
  const stats = {};
  for (const vp of ['client', 'server']) {
    const path = join(dir, files[vp]);
    stats[vp] = seqStats(path);
    if (!head(path).includes(`"type":"${vp}"`)) throw new Error(`${path}: expected the ${vp} vantage point`);
    variants.push({ file: files[vp], format: 'JSON-SEQ', vantage_point: vp, size: statSync(path).size, events: stats[vp].events });
  }
  if (files.qlog) {
    variants.unshift({
      file: files.qlog,
      format: 'JSON',
      vantage_points: ['client', 'server'],
      size: statSync(join(dir, files.qlog)).size,
      events: stats.client.events + stats.server.events,
    });
  }
  const demoFile = sc.demo === 'qlog' ? files.qlog : files.server;
  const demo = variants.find((v) => v.file === demoFile);
  const entry = {
    file: demoFile,
    title: sc.title,
    description: sc.description,
    size: demo.size,
    id: sc.id,
    traces: sc.demo === 'qlog' ? 2 : 1,
    events: demo.events,
    duration_ms: Math.max(stats.client.duration_ms, stats.server.duration_ms),
    scenario: ['qloggen', ...sc.args].join(' '),
    generator: GENERATOR,
    variants: variants.filter((v) => v.file !== demoFile),
  };
  if (!manifests.has(sc.dir)) manifests.set(sc.dir, []);
  manifests.get(sc.dir).push(entry);
}

for (const [dir, entries] of manifests) {
  const path = join(EXAMPLES, dir, 'index.json');
  writeFileSync(path, JSON.stringify(entries, null, 2) + '\n');
  console.log(`wrote ${path} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
}
