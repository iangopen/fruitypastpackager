import { readFileSync } from 'node:fs';
function walk(buf, override) {
  let p = 22; const evs = [];
  while (p < buf.length) {
    const id = buf[p]; let q = p + 1, size;
    const ov = override.get(id);
    if (ov !== undefined) size = ov;
    else if (id < 64) size = 1; else if (id < 128) size = 2; else if (id < 192) size = 4;
    else { size = 0; let sh = 0, b; do { if (q >= buf.length) return null; b = buf[q++]; size |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); }
    if (q + size > buf.length) return null;
    evs.push({ id, size, data: buf.subarray(q, q + size) });
    p = q + size;
  }
  return evs;
}
let pass = 0, fail = 0;
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const nch = buf.readUInt16LE(10);
  for (const [label, ov] of [['plain', new Map()], ['172=3', new Map([[172, 3]])]]) {
    const evs = walk(buf, ov);
    if (!evs) { console.log(f.split(/[\/]/).pop().slice(0,30), label, 'TRUNCATED'); continue; }
    const c = id => evs.filter(e => e.id === id).length;
    const notes = evs.filter(e => e.id === 224);
    const ok = c(0) === nch && c(64) === nch && c(203) === nch && notes.every(e => e.size % 24 === 0) && c(156) === 1;
    if (label === '172=3') { ok ? pass++ : fail++; if (!ok) console.log('FAIL', f.split(/[\/]/).pop(), `nch=${nch} id0=${c(0)} ch64=${c(64)} names=${c(203)} tempo=${c(156)}`); }
  }
}
console.log(`rule 172=3byte: ${pass} pass, ${fail} fail`);
