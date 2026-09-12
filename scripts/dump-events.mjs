// Spike: dump the raw FLdt event stream (id, width class, size) to validate layout.
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2]);
console.log('magic', buf.toString('latin1', 0, 4), 'hdrsize', buf.readUInt32LE(4),
  'format', buf.readInt16LE(8), 'nch', buf.readUInt16LE(10), 'ppq', buf.readUInt16LE(12));
console.log('data magic', buf.toString('latin1', 14, 18), 'datasize', buf.readUInt32LE(18));

let p = 22;
const end = buf.length;
const counts = new Map();
while (p < end) {
  const id = buf[p++];
  let size = 0, kind;
  if (id < 64) { kind = 'byte'; size = 1; }
  else if (id < 128) { kind = 'word'; size = 2; }
  else if (id < 192) { kind = 'dword'; size = 4; }
  else {
    kind = 'var';
    size = 0; let shift = 0, b;
    do { b = buf[p++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  }
  const data = buf.subarray(p, p + size);
  p += size;
  counts.set(id, (counts.get(id) ?? 0) + 1);
  if (process.env.VERBOSE) {
    let preview = '';
    if (kind === 'var') preview = JSON.stringify(data.toString('utf16le').replace(/\0+$/, '')).slice(0, 70);
    else preview = String(kind === 'byte' ? data[0] : kind === 'word' ? data.readUInt16LE(0) : data.readUInt32LE(0));
    console.log(id, kind, size, preview);
  }
}
console.log('final pos', p, 'len', end);
console.log('event id counts:', [...counts].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}:${v}`).join(' '));
