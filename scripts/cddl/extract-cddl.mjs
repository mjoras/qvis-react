#!/usr/bin/env node
// Extracts the normative CDDL from the PUBLISHED qlog Internet-Drafts and
// derives the event-name -> CDDL-type mapping.
//
//   node scripts/cddl/extract-cddl.mjs <ref-dir> [out-dir]
//   node scripts/cddl/extract-cddl.mjs --list <draft.xml>
//
// <ref-dir> must contain, for each draft below, the published .xml (the
// xml2rfc source, which tags CDDL as <sourcecode type="cddl">) AND the
// published .txt rendering. Both are available from
//   https://www.ietf.org/archive/id/<draft>.{xml,txt}
// Every extracted CDDL block is cross-checked against the .txt (whitespace
// normalised), so the output provably matches the published text.
//
// Outputs (in out-dir, default: the directory of this script):
//   main-schema-14.cddl, quic-events-13.cddl, h3-events-13.cddl
//   event-types.json   { "quic:packet_sent": "QUICPacketSent", ... }
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRAFTS = [
  { doc: 'draft-ietf-quic-qlog-main-schema-14', out: 'main-schema-14.cddl' },
  { doc: 'draft-ietf-quic-qlog-quic-events-13', out: 'quic-events-13.cddl' },
  { doc: 'draft-ietf-quic-qlog-h3-events-13', out: 'h3-events-13.cddl' },
];

// Each "<X>EventData" union is registered into $ProtocolEventData by exactly
// one namespace; the draft text states the namespace identifier for each.
const UNION_NAMESPACE = {
  LogLevelEventData: 'loglevel',
  SimulationEventData: 'simulation',
  QuicEventData: 'quic',
  HTTP3EventData: 'http3',
  HTTPEventData: 'http',
};

const CDATA = /<sourcecode\b([^>]*)><!\[CDATA\[([\s\S]*?)\]\]><\/sourcecode>/y;

// Walk the XML once, tracking the <section> / <figure> nesting, and collect
// every <sourcecode type="cddl"> plus <artwork> figures (examples).
function scan(xml) {
  const blocks = [];
  const sections = []; // stack of { name }
  let figure = null;
  const tok = /<section\b[^>]*>|<\/section>|<figure\b([^>]*)>|<\/figure>|<name>([\s\S]*?)<\/name>|<sourcecode\b|<artwork\b/g;
  let m;
  let pendingName = null; // 'section' | 'figure' : whose <name> comes next
  while ((m = tok.exec(xml))) {
    const t = m[0];
    if (t.startsWith('<section')) {
      sections.push({ name: '' });
      pendingName = 'section';
    } else if (t === '</section>') {
      sections.pop();
    } else if (t.startsWith('<figure')) {
      figure = { anchor: /anchor="([^"]*)"/.exec(m[1])?.[1] ?? '', name: '', kind: '?' };
      pendingName = 'figure';
    } else if (t === '</figure>') {
      if (figure && figure.kind !== 'cddl') blocks.push({ ...figure, type: figure.kind, body: null, section: sections.at(-1)?.name });
      figure = null;
    } else if (t.startsWith('<name>')) {
      const name = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (pendingName === 'section' && sections.length) sections.at(-1).name = name;
      else if (pendingName === 'figure' && figure) figure.name = name;
      pendingName = null;
    } else if (t === '<artwork') {
      if (figure) figure.kind = 'artwork';
    } else if (t === '<sourcecode') {
      CDATA.lastIndex = m.index;
      const sc = CDATA.exec(xml);
      if (!sc) throw new Error(`unparseable <sourcecode> at offset ${m.index}`);
      tok.lastIndex = CDATA.lastIndex;
      const type = /type="([^"]*)"/.exec(sc[1])?.[1] ?? '';
      if (figure) figure.kind = type;
      if (type !== 'cddl') continue;
      const line = xml.slice(0, m.index).split('\n').length;
      blocks.push({
        anchor: figure ? `#${figure.anchor}` : `(no figure, xml line ${line})`,
        name: figure?.name ?? '',
        type: 'cddl',
        body: sc[2].replace(/^\n+|\s+$/g, ''),
        section: sections.at(-1)?.name ?? '',
      });
    }
  }
  return blocks;
}

// Normalised published text: page headers/footers/form feeds removed and
// whitespace runs collapsed (the .txt re-wraps nothing inside figures, but
// page breaks can split a figure).
function normTxt(txt) {
  return txt
    .split('\n')
    .filter((l) => !/^\f/.test(l) && !/^\S.*\s{2,}Expires .*\[Page \d+\]$/.test(l) && !/^Internet-Draft\s{2,}.*\s{2,}\w+ \d{4}$/.test(l))
    .join('\n')
    .replace(/\s+/g, ' ');
}

const stripComments = (s) => s.replace(/;[^\n]*/g, '');
const definedRules = (body) => [...stripComments(body).matchAll(/^([A-Za-z$][\w$.-]*)\s*(?:\/\/=|\/=|=)/gm)].map((m) => m[1]);

function unionMembers(cddl, rule) {
  const m = new RegExp(`^${rule}\\s*=([\\s\\S]*?)(?=^\\S)`, 'm').exec(stripComments(cddl) + '\nX');
  return m ? m[1].split('/').map((s) => s.trim()).filter(Boolean) : [];
}

const args = process.argv.slice(2);
if (args[0] === '--list') {
  for (const b of scan(readFileSync(args[1], 'utf8'))) console.log(`${b.type.padEnd(8)} ${b.anchor}  ${b.name}  [section: ${b.section}]`);
  process.exit(0);
}
const refDir = args[0];
const outDir = args[1] ?? dirname(fileURLToPath(import.meta.url));
if (!refDir) {
  console.error('usage: extract-cddl.mjs <ref-dir-with-published-xml-and-txt> [out-dir]');
  process.exit(2);
}
const find = (doc, ext) => {
  const f = readdirSync(refDir, { recursive: true }).find((p) => String(p).endsWith(`${doc}.${ext}`));
  if (!f) throw new Error(`${doc}.${ext} not found under ${refDir}`);
  return join(refDir, String(f));
};

let failed = false;
const eventTypes = {};
const allCddl = [];
const perDraftBlocks = [];
for (const { doc, out } of DRAFTS) {
  const xml = readFileSync(find(doc, 'xml'), 'utf8');
  if (!xml.includes(`docName="${doc}"`)) throw new Error(`${doc}.xml has wrong docName`);
  const txt = normTxt(readFileSync(find(doc, 'txt'), 'utf8'));
  if (!txt.includes(doc)) throw new Error(`${doc}.txt does not look like ${doc}`);
  const blocks = scan(xml).filter((b) => b.type === 'cddl');
  const parts = [
    `; CDDL extracted verbatim from the published ${doc}`,
    `; (every <sourcecode type="cddl"> block of https://www.ietf.org/archive/id/${doc}.xml,`,
    `;  each cross-checked against the published .txt).`,
    `; Generated by scripts/cddl/extract-cddl.mjs -- do not edit by hand.`,
    '',
  ];
  let bad = 0;
  for (const b of blocks) {
    if (!txt.includes(b.body.replace(/\s+/g, ' ').trim())) {
      bad++;
      console.error(`  MISMATCH vs published txt: ${doc} ${b.anchor} (${b.name})`);
    }
    parts.push(`; ---- ${b.anchor}${b.name ? ': ' + b.name : ''}`, b.body, '');
  }
  writeFileSync(join(outDir, out), parts.join('\n'));
  console.error(`${doc}: ${blocks.length} CDDL blocks -> ${out}${bad ? `, ${bad} MISMATCHES` : ' (all match the published txt)'}`);
  failed ||= bad > 0;
  allCddl.push(parts.join('\n'));
  perDraftBlocks.push({ doc, xml, blocks });
}

// Event name -> type: the event type identifier is the heading of the section
// holding the type's definition figure, and the type must be a member of one
// of the per-namespace "<X>EventData" unions.
const cddlAll = allCddl.join('\n');
const typeToNs = {};
for (const [union, ns] of Object.entries(UNION_NAMESPACE)) {
  const members = unionMembers(cddlAll, union);
  if (!members.length) throw new Error(`union ${union} not found`);
  for (const t of members) typeToNs[t] = ns;
}
for (const { doc, xml, blocks } of perDraftBlocks) {
  for (const b of blocks) {
    const types = definedRules(b.body).filter((r) => r in typeToNs);
    if (types.length > 1) throw new Error(`${doc} ${b.anchor}: defines several event types: ${types}`);
    const t = types[0];
    if (!t) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(b.section)) throw new Error(`${doc}: ${t} is in non-event section "${b.section}"`);
    const name = `${typeToNs[t]}:${b.section}`;
    if (eventTypes[name] && eventTypes[name] !== t) throw new Error(`duplicate mapping for ${name}`);
    eventTypes[name] = t;
  }
  // Cross-check against the "Name value" overview tables where a draft has them.
  for (const m of xml.matchAll(/<td align="left">([a-z0-9]+:[a-z0-9_]+)<\/td>/g)) {
    if (!eventTypes[m[1]]) {
      console.error(`  ${doc}: event ${m[1]} from the overview table has no CDDL type`);
      failed = true;
    }
  }
}
for (const t of Object.keys(typeToNs)) {
  if (!Object.values(eventTypes).includes(t)) {
    console.error(`  union member ${t} has no event name`);
    failed = true;
  }
}
writeFileSync(join(outDir, 'event-types.json'), JSON.stringify(eventTypes, null, 2) + '\n');
console.error(`event-types.json: ${Object.keys(eventTypes).length} event types`);
process.exit(failed ? 1 : 0);
