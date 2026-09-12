/**
 * Builds a synthetic "zipped project" to exercise the ZIP container code path.
 *
 * This validates the ZIP reader (central directory parsing, stored + deflated
 * entries, basename matching). It does NOT validate the FL-specific
 * assumptions about how FL lays out a real "save with all files" archive,
 * because no such archive exists on this machine to check against.
 *
 * Usage: node scripts/zip-fixture.mjs <out.flp> <source.flp> <sample...>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const [outPath, flpPath, ...samples] = process.argv.slice(2);
if (!outPath || !flpPath) {
  console.error('usage: node scripts/zip-fixture.mjs <out> <source.flp> <sample...>');
  process.exit(1);
}

const files = [
  { name: basename(flpPath), data: readFileSync(flpPath), deflate: true },
  ...samples.map((s, i) => ({
    name: `Audio/${basename(s)}`,
    data: readFileSync(s),
    // Mix methods so both code paths get exercised.
    deflate: i % 2 === 0,
  })),
];

const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const raw = f.deflate ? deflateRawSync(f.data) : f.data;
  const method = f.deflate ? 8 : 0;
  const crc = crc32(f.data);
  const nameBuf = Buffer.from(f.name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, nameBuf, raw);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(raw.length, 20);
  cd.writeUInt32LE(f.data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + raw.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, eocd]));
console.log(`wrote ${outPath} with ${files.length} entries:`);
for (const f of files) console.log(`   ${f.deflate ? 'deflate' : 'stored '}  ${f.name}`);
