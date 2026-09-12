import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
function walk(start) {
  let p = start; const evs = [];
  while (p < buf.length) {
    const id = buf[p]; let q = p + 1, size;
    if (id < 64) size = 1; else if (id < 128) size = 2; else if (id < 192) size = 4;
    else { size = 0; let sh = 0, b; do { if (q >= buf.length) return { evs, end: -1 }; b = buf[q++]; size |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); }
    if (q + size > buf.length) return { evs, end: -1 };
    evs.push({ id, off: p, size, data: buf.subarray(q, q + size) });
    p = q + size;
  }
  return { evs, end: p };
}
for (const start of [22, 0x34]) {
  const { evs, end } = walk(start);
  const c = id => evs.filter(e => e.id === id).length;
  const notes = evs.filter(e => e.id === 224);
  console.log(`start=0x${start.toString(16)} end=${end} events=${evs.length} id0=${c(0)} newchan=${c(64)} chanName=${c(203)} sampleFile=${c(196)} noteBlocks=${notes.length} allNotes%24=${notes.every(e=>e.size%24===0)} has156=${c(156)}`);
}
// what is at 0x34?
console.log('bytes 0x2e-0x38:', [...buf.subarray(0x2e,0x39)].map(b=>b.toString(16).padStart(2,'0')).join(' '));
