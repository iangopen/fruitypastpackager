#!/usr/bin/env node
/**
 * drumkit-extractor CLI.
 *
 *   parse   <path-to-flp>   print a JSON summary of a single project file
 *   scan    <root-dir>      crawl a directory tree and index every .flp found
 *   resolve                 resolve indexed sample paths to real files and hash them
 *   top     [n]             most-reused samples, keyed on content hash
 */

import { resolve } from 'node:path';
import { DEFAULT_DB_PATH, openDb } from './db/index.js';
import { FlpParseError } from './parser/events.js';
import { parseFlpFile } from './parser/flp.js';
import { resolveAll, topSamplesByUsage } from './resolver/run.js';
import { EVENT_172_WARNING, scan } from './scanner/scan.js';

const USAGE = `drumkit-extractor

Usage:
  drumkit-extractor parse   <path-to-flp>  print a JSON summary of one project
  drumkit-extractor scan    <root-dir>     index every .flp under a directory
  drumkit-extractor resolve                resolve sample paths, hash, build manifest
  drumkit-extractor top     [n]            most-reused samples by content hash

Options:
  --db <path>       index database path (default ${DEFAULT_DB_PATH})
  --quiet           omit the unhandled-event-id histogram (parse)
  --notes           include decoded notes in the JSON (parse)
  --no-notes        index note counts only, skip individual notes (scan)
  --progress        print progress (scan, resolve)
  --sample-dir <p>  extra directory for the basename index (resolve, repeatable)
  --skip-index      skip building the basename index (resolve)
`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const v = args[i + 1];
    if (a === name && v !== undefined) out.push(v);
  });
  return out;
}

function positional(args: string[]): string | undefined {
  // Skip the command itself, any --flags, and any value consumed by a flag.
  const consumed = new Set<string>();
  const dbValue = flagValue(args, '--db');
  if (dbValue !== undefined) consumed.add(dbValue);
  for (const v of flagValues(args, '--sample-dir')) consumed.add(v);
  return args.find((a, i) => i > 0 && !a.startsWith('--') && !consumed.has(a));
}

function pct(n: number, total: number): string {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function cmdParse(args: string[]): number {
  const target = positional(args);
  if (target === undefined) {
    process.stderr.write(`parse requires a path to an .flp file\n\n${USAGE}`);
    return 1;
  }

  try {
    const project = parseFlpFile(resolve(target), { includeNotes: args.includes('--notes') });
    const output: Record<string, unknown> = { ...project };
    if (args.includes('--quiet')) {
      output['stats'] = { eventCount: project.stats.eventCount };
    }
    if (!args.includes('--notes')) {
      output['patterns'] = project.patterns.map(({ notes: _notes, ...rest }) => rest);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return project.warnings.length > 0 ? 2 : 0;
  } catch (err) {
    if (err instanceof FlpParseError) {
      process.stderr.write(`parse error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function cmdScan(args: string[]): number {
  const root = positional(args);
  if (root === undefined) {
    process.stderr.write(`scan requires a root directory\n\n${USAGE}`);
    return 1;
  }
  const dbPath = flagValue(args, '--db') ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);

  const started = Date.now();
  try {
    const summary = scan(db, resolve(root), {
      includeNotes: !args.includes('--no-notes'),
      ...(args.includes('--progress')
        ? { onProgress: (n: number, p: string) => process.stderr.write(`[${n}] ${p}\n`) }
        : {}),
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    const out = process.stdout;
    out.write(`\nScan complete (run #${summary.runId}) in ${secs}s\n`);
    out.write(`  database              ${resolve(dbPath)}\n`);
    out.write(`  root                  ${summary.root}\n`);
    out.write(`  directories visited   ${summary.crawl.dirsVisited}\n`);
    out.write(`  directories errored   ${summary.crawl.dirsErrored}\n`);
    out.write(`  symlink loops skipped ${summary.crawl.dirsSkippedAsLoop}\n`);
    out.write(`  .flp files found      ${summary.filesFound}\n`);
    out.write(`  parsed successfully   ${summary.filesParsed}\n`);
    out.write(`  errored               ${summary.filesErrored}\n`);
    out.write(`  channels indexed      ${summary.channelsIndexed}\n`);
    out.write(`  patterns indexed      ${summary.patternsIndexed}\n`);
    out.write(`  notes indexed         ${summary.notesIndexed}\n`);
    out.write(`  distinct sample paths ${summary.distinctSamplePaths}\n`);
    out.write(`  files w/ event 172    ${summary.event172Files}\n`);

    if (summary.event172Files > 0) {
      out.write(`\n  WARNING: ${EVENT_172_WARNING}\n`);
    }
    if (summary.errors.length > 0) {
      out.write(`\n  ${summary.errors.length} error(s) recorded in scan_errors:\n`);
      for (const e of summary.errors.slice(0, 20)) {
        out.write(`    [${e.kind}] ${e.path}\n      ${e.message}\n`);
      }
      if (summary.errors.length > 20) {
        out.write(`    ... and ${summary.errors.length - 20} more\n`);
      }
    }
    return summary.filesErrored > 0 ? 2 : 0;
  } finally {
    db.close();
  }
}

async function cmdResolve(args: string[]): Promise<number> {
  const dbPath = flagValue(args, '--db') ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  try {
    const summary = await resolveAll(db, {
      extraSampleDirs: flagValues(args, '--sample-dir'),
      skipIndex: args.includes('--skip-index'),
      ...(args.includes('--progress')
        ? {
            onProgress: (done: number, total: number) => {
              if (done % 25 === 0 || done === total) {
                process.stderr.write(`\r  resolving ${done}/${total}   `);
              }
            },
          }
        : {}),
    });
    if (args.includes('--progress')) process.stderr.write('\n');

    const out = process.stdout;
    const total = summary.refsTotal;
    out.write(
      `\nResolve complete (run #${summary.runId}) in ${(summary.elapsedMs / 1000).toFixed(1)}s\n`,
    );
    out.write('  FL path sources\n');
    for (const s of summary.flSources) out.write(`    - ${s}\n`);
    out.write(
      `  basename index        ${summary.indexFiles} audio files across ${summary.indexRoots.length} roots\n`,
    );
    out.write(`\n  raw sample paths      ${total}\n`);
    for (const status of ['resolved', 'ambiguous', 'unresolved']) {
      const n = summary.byStatus[status] ?? 0;
      out.write(`    ${status.padEnd(18)}${String(n).padStart(5)}  ${pct(n, total)}\n`);
    }
    out.write('\n  by strategy (which one succeeded)\n');
    const strategies = Object.entries(summary.byStrategy).sort((a, b) => b[1] - a[1]);
    if (strategies.length === 0) out.write('    (none)\n');
    for (const [name, n] of strategies) {
      out.write(`    ${name.padEnd(24)}${String(n).padStart(5)}  ${pct(n, total)}\n`);
    }
    out.write(
      `\n  %variable% paths      ${summary.variableRefs.resolved}/${summary.variableRefs.total} resolved\n`,
    );
    out.write(
      `  files hashed          ${summary.filesHashed} (${(summary.bytesHashed / 1e6).toFixed(1)} MB)\n`,
    );
    out.write(`  hash errors           ${summary.hashErrors}\n`);
    out.write(`  distinct contents     ${summary.distinctHashes}\n`);
    out.write(`  manifest rows         ${summary.manifestRows}\n`);
    return (summary.byStatus['unresolved'] ?? 0) > 0 ? 2 : 0;
  } finally {
    db.close();
  }
}

function cmdTop(args: string[]): number {
  const dbPath = flagValue(args, '--db') ?? DEFAULT_DB_PATH;
  const n = Number(positional(args) ?? '10');
  const db = openDb(dbPath);
  try {
    const rows = topSamplesByUsage(db, Number.isFinite(n) && n > 0 ? n : 10);
    const out = process.stdout;
    if (rows.length === 0) {
      out.write('No manifest rows yet - run `resolve` first.\n');
      return 1;
    }
    out.write(`\nTop ${rows.length} most-reused samples, keyed on content hash\n\n`);
    out.write('  rank  projects  chans  spellings  size        name\n');
    out.write('  ----  --------  -----  ---------  ----------  ----\n');
    rows.forEach((r, i) => {
      const names = (r.names ?? '').split(',');
      const shown = names[0] ?? '(unnamed)';
      const extra =
        names.length > 1 ? `   [+${names.length - 1} other name${names.length > 2 ? 's' : ''}]` : '';
      out.write(
        `  ${String(i + 1).padStart(4)}  ${String(r.projects).padStart(8)}  ` +
          `${String(r.channels).padStart(5)}  ${String(r.spellings).padStart(9)}  ` +
          `${(r.fileSize / 1024).toFixed(0).padStart(7)} KB  ${shown}${extra}\n`,
      );
    });
    out.write(
      '\n  "spellings" = distinct raw path strings that resolved to this same content.\n',
    );
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === 'parse') return cmdParse(args);
  if (command === 'scan') return cmdScan(args);
  if (command === 'resolve') return cmdResolve(args);
  if (command === 'top') return cmdTop(args);

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

main(process.argv).then((code) => {
  process.exitCode = code;
});
