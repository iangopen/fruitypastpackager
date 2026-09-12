/**
 * Follow-up to event172.mjs: if the divergence test finds no divergent
 * occurrence, decide between H_A (172 = 3-byte payload) and H_B (172 = 1-byte
 * payload, followed by a real event 1) on parsimony grounds instead.
 *
 * The question H_B has to answer: does event ID 1 exist as a real event
 * anywhere else in the corpus? If ID 1 never occurs in 553 files across FL
 * 10.9 -> 25.2, H_B requires FL to have introduced a brand-new use of ID 1 at
 * the exact moment it introduced 172, always with the same payload, always in
 * the same header slot -- while H_A requires only one new event.
 */

import { readFileSync } from 'node:fs';

function chunks(buf) {
  if (buf.length < 22 || buf.toString('latin1', 0, 4) !== 'FLhd') return null;
  const headerSize = buf.readUInt32LE(4);
  const dataStart = 8 + headerSize;
  if (buf.toString('latin1', dataStart, dataStart + 4) !== 'FLdt') return null;
  const size = buf.readUInt32LE(dataStart + 4);
  const start = dataStart + 8;
  return { nch: buf.readUInt16LE(10), start, end: Math.min(start + size, buf.length) };
}

function walk(buf, c, width172) {
  const evs = [];
  let p = c.start;
  while (p < c.end) {
    const id = buf[p];
    let q = p + 1;
    let size;
    if (id === 172) size = width172;
    else if (id < 64) size = 1;
    else if (id < 128) size = 2;
    else if (id < 192) size = 4;
    else {
      size = 0;
      let sh = 0;
      let b;
      do {
        if (q >= c.end) return null;
        b = buf[q++];
        size |= (b & 0x7f) << sh;
        sh += 7;
      } while (b & 0x80);
    }
    if (q + size > c.end) return null;
    evs.push({ id, off: p, size, data: buf.subarray(q, q + size) });
    p = q + size;
  }
  return p === c.end ? evs : null;
}

function version(buf, c) {
  if (buf[c.start] !== 199) return '?';
  let p = c.start + 1;
  let size = 0;
  let sh = 0;
  let b;
  do {
    b = buf[p++];
    size |= (b & 0x7f) << sh;
    sh += 7;
  } while (b & 0x80);
  return buf.toString('latin1', p, p + size).replace(/\0/g, '');
}

const files = readFileSync(process.argv[2], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

const patterns = new Map(); // exact byte pattern at each 172 -> count
const id1Sites = []; // every occurrence of event ID 1, under H_A
const headerSeqs = new Map(); // version -> first 8 event ids
let with172 = 0;

for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    continue;
  }
  const c = chunks(buf);
  if (!c) continue;
  const evs = walk(buf, c, 3) ?? walk(buf, c, 1);
  if (!evs) continue;
  const ver = version(buf, c);

  const seq = evs.slice(0, 8).map((e) => e.id).join(',');
  const key = `${ver.split('.').slice(0, 2).join('.')}`;
  if (!headerSeqs.has(key)) headerSeqs.set(key, new Map());
  const m = headerSeqs.get(key);
  m.set(seq, (m.get(seq) ?? 0) + 1);

  const hits = evs.filter((e) => e.id === 172);
  if (hits.length) with172++;
  for (const h of hits) {
    const pat = [...buf.subarray(h.off, h.off + 5)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const k = `${pat}  (v${ver})`;
    patterns.set(k, (patterns.get(k) ?? 0) + 1);
  }

  // Under H_A, does ID 1 ever appear as a real event?
  for (const e of evs) {
    if (e.id === 1) id1Sites.push({ f, ver, off: e.off, val: e.data[0] });
  }
}

console.log(`files with event 172: ${with172}`);
console.log('\nexact byte patterns at each 172 occurrence (172, then 4 following bytes):');
for (const [k, v] of [...patterns].sort()) console.log(`  ${k}  x${v}`);

console.log(`\noccurrences of event ID 1 anywhere in the corpus (parsed under H_A): ${id1Sites.length}`);
const byVer = new Map();
for (const s of id1Sites) byVer.set(s.ver, (byVer.get(s.ver) ?? 0) + 1);
for (const [k, v] of [...byVer].sort()) console.log(`  v${k}: ${v}`);

console.log('\nfirst 8 event IDs of the stream, by FL major.minor:');
for (const [ver, m] of [...headerSeqs].sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))) {
  for (const [seq, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    console.log(`  v${ver.padEnd(8)} x${String(n).padStart(3)}  ${seq}`);
  }
}
