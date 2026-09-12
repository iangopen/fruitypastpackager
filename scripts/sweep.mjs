// Sanity sweep: parse every .flp found and report plausibility per file.
import { execFileSync } from 'node:child_process';
const files = process.argv.slice(2);
let ok = 0, warn = 0, bad = 0;
for (const f of files) {
  try {
    const out = execFileSync('node', ['--import', 'tsx', 'src/cli.ts', 'parse', f], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    const p = JSON.parse(out);
    const samples = p.channels.filter(c => c.samplePath).length;
    const notes = p.patterns.reduce((a, x) => a + x.noteCount, 0);
    console.log(
      f.split(/[\/]/).pop().slice(0, 40).padEnd(42),
      'v' + String(p.flVersion).padEnd(12),
      `ppq=${String(p.header.ppq).padEnd(4)}`,
      `bpm=${String(p.tempo).padEnd(7)}`,
      `sig=${p.timeSignature?.numerator}/${p.timeSignature?.denominator}`,
      `ch=${String(p.channels.length).padStart(3)}`,
      `smp=${String(samples).padStart(3)}`,
      `pat=${String(p.patterns.length).padStart(3)}`,
      `notes=${String(notes).padStart(5)}`,
      p.warnings.length ? 'WARN: ' + p.warnings.join('; ') : '',
    );
    p.warnings.length ? warn++ : ok++;
  } catch (e) {
    bad++;
    console.log(f.split(/[\/]/).pop().slice(0, 40).padEnd(42), 'ERROR', String(e.stderr || e.message).trim().split('\n')[0]);
  }
}
console.log(`\n${ok} clean, ${warn} with warnings, ${bad} errors, ${files.length} total`);
