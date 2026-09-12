#!/usr/bin/env node
/**
 * drumkit-extractor CLI.
 *
 *   parse <path-to-flp>   print a JSON summary of a single project file
 *   scan  <root-dir>      crawl a directory tree and index every .flp found
 */

import { resolve } from 'node:path';
import { DEFAULT_DB_PATH, openDb } from './db/index.js';
import { FlpParseError } from './parser/events.js';
import { parseFlpFile } from './parser/flp.js';
import { EVENT_172_WARNING, scan } from './scanner/scan.js';

const USAGE = `drumkit-extractor

Usage:
  drumkit-extractor parse <path-to-flp>   print a JSON summary of one project
  drumkit-extractor scan  <root-dir>      index every .flp under a directory

Options:
  --quiet          omit the unhandled-event-id histogram (parse)
  --notes          include decoded notes in the JSON (parse)
  --db <path>      index database path (scan; default ${DEFAULT_DB_PATH})
  --no-notes       index note counts only, skip individual notes (scan)
  --progress       print each file as it is indexed (scan)
`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  // Skip the command itself, any --flags, and any value consumed by --db.
  const dbValue = flagValue(args, '--db');
  return args.find((a, i) => i > 0 && !a.startsWith('--') && a !== dbValue);
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

function main(argv: string[]): number {
  const args = argv.slice(2);
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === 'parse') return cmdParse(args);
  if (command === 'scan') return cmdScan(args);

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

process.exitCode = main(process.argv);
