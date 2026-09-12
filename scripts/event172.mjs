/**
 * Resolve the event-172 payload-width question with cross-file evidence.
 *
 * Three competing rules for the width of event 172's payload:
 *   A: 3 bytes  (current assumption)
 *   B: 1 byte   (followed by whatever event comes next)
 *   C: 4 bytes  (the generic dword ID-range rule)
 *
 * For a single occurrence where the byte at +2 is itself a byte-class ID, A and
 * B consume the same total and are indistinguishable. They diverge as soon as
 * that byte is a word/dword/text-class ID. This walks every reachable .flp,
 * counts divergent occurrences, and validates each whole-file parse against
 * structural invariants that a desynchronised stream cannot satisfy.
 *
 * Usage: node scripts/event172.mjs <file-list.txt>
 */

import { readFileSync } from 'node:fs';

const HYPOTHESES = { A: 3, B: 1, C: 4 };

function chunks(buf) {
  if (buf.length < 22 || buf.toString('latin1', 0, 4) !== 'FLhd') return null;
  const headerSize = buf.readUInt32LE(4);
  const nch = buf.readUInt16LE(10);
  const dataStart = 8 + headerSize;
  if (buf.toString('latin1', dataStart, dataStart + 4) !== 'FLdt') return null;
  const size = buf.readUInt32LE(dataStart + 4);
  const start = dataStart + 8;
  return { nch, start, end: Math.min(start + size, buf.length), declaredEnd: start + size };
}

/** Walks the stream with a given width for event 172. Returns null on desync. */
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
        if (sh > 28) return null;
      } while (b & 0x80);
    }
    if (q + size > c.end) return null; // overruns the chunk: desynced
    evs.push({ id, off: p, size, data: buf.subarray(q, q + size) });
    p = q + size;
  }
  return p === c.end ? evs : null;
}

/**
 * Structural invariants a correctly-synced stream must satisfy. A one-byte
 * desync reliably breaks these: it manufactures long runs of bogus low-ID
 * events out of UTF-16 text and mismatches the header's channel count.
 */
function validate(evs, c) {
  if (!evs) return { ok: false, why: 'desync/overrun' };
  const count = (id) => evs.reduce((n, e) => n + (e.id === id ? 1 : 0), 0);
  const newChan = count(64);
  const chanEnabled = count(0);
  const notesOk = evs.every((e) => e.id !== 224 || e.size % 24 === 0);
  if (newChan !== c.nch) return { ok: false, why: `NewChan ${newChan} != header ${c.nch}` };
  if (chanEnabled !== c.nch) return { ok: false, why: `ChanEnabled ${chanEnabled} != ${c.nch}` };
  if (!notesOk) return { ok: false, why: 'note blob not a multiple of 24' };
  return { ok: true };
}

const files = readFileSync(process.argv[2], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

const occurrences = [];
const perFile = [];
let unreadable = 0;
let noEvent172 = 0;

for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    unreadable++;
    continue;
  }
  const c = chunks(buf);
  if (!c) {
    unreadable++;
    continue;
  }

  const res = {};
  for (const [name, w] of Object.entries(HYPOTHESES)) {
    res[name] = validate(walk(buf, c, w), c);
  }

  // Enumerate 172 occurrences using whichever hypothesis produced a valid
  // parse, so offsets are trustworthy.
  const good = Object.entries(HYPOTHESES).find(([n]) => res[n].ok);
  const evs = good ? walk(buf, c, HYPOTHESES[good[0]]) : null;
  const hits = evs ? evs.filter((e) => e.id === 172) : [];
  if (hits.length === 0) noEvent172++;

  for (const h of hits) {
    // Under B, the byte at off+2 is read as the next event's ID.
    const nextIdUnderB = buf[h.off + 2];
    const classB = nextIdUnderB < 64 ? 'byte' : nextIdUnderB < 128 ? 'word' : nextIdUnderB < 192 ? 'dword' : 'text';
    occurrences.push({
      file: f,
      off: h.off,
      bytes: [...buf.subarray(h.off, h.off + 6)],
      nextIdUnderB,
      classB,
      // A and B land on the same offset only when B's next event is byte-class.
      ambiguous: classB === 'byte',
    });
  }

  perFile.push({ f, res, hits: hits.length, ver: version(buf, c) });
}

function version(buf, c) {
  // Event 199 is the first event and holds the ASCII version string.
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

// ---- report ----
const tally = (name) => perFile.filter((x) => x.res[name].ok).length;
console.log(`files scanned: ${files.length}  unreadable/not-flp: ${unreadable}  parseable: ${perFile.length}`);
console.log(`files containing event 172: ${perFile.length - noEvent172}   total occurrences: ${occurrences.length}`);
console.log(`\nwhole-file validation passes:`);
for (const name of Object.keys(HYPOTHESES)) {
  console.log(`  H_${name} (172 = ${HYPOTHESES[name]}-byte payload): ${tally(name)} / ${perFile.length}`);
}

const divergent = occurrences.filter((o) => !o.ambiguous);
console.log(`\noccurrences where A and B diverge (byte at +2 is not byte-class): ${divergent.length}`);
for (const d of divergent.slice(0, 15)) {
  console.log(
    `  ${d.file.split(/[\\/]/).pop().slice(0, 44).padEnd(46)} off=${d.off} bytes=${d.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')} nextIdUnderB=${d.nextIdUnderB} (${d.classB})`,
  );
}

// Files where the hypotheses actually disagree on whole-file validity.
const decisive = perFile.filter((x) => x.res.A.ok !== x.res.B.ok);
console.log(`\nfiles where H_A and H_B disagree on validity: ${decisive.length}`);
for (const d of decisive.slice(0, 15)) {
  console.log(
    `  ${d.f.split(/[\\/]/).pop().slice(0, 40).padEnd(42)} v${d.ver.padEnd(12)} 172x${d.hits}  A=${d.res.A.ok ? 'PASS' : 'FAIL:' + d.res.A.why}  B=${d.res.B.ok ? 'PASS' : 'FAIL:' + d.res.B.why}`,
  );
}

// Version distribution of files containing 172.
const byVer = new Map();
for (const x of perFile) {
  const k = `${x.ver} ${x.hits > 0 ? 'has172' : 'no172'}`;
  byVer.set(k, (byVer.get(k) ?? 0) + 1);
}
console.log('\nversion x event-172 presence:');
for (const [k, v] of [...byVer].sort()) console.log(`  ${k.padEnd(26)} ${v}`);

const noneValid = perFile.filter((x) => !x.res.A.ok && !x.res.B.ok && !x.res.C.ok);
console.log(`\nfiles no hypothesis parses: ${noneValid.length}`);
for (const d of noneValid.slice(0, 10)) console.log(`  ${d.f} v${d.ver} A=${d.res.A.why} C=${d.res.C.why}`);
