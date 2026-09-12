#!/usr/bin/env node
/**
 * drumkit-extractor CLI.
 *
 * Currently one command:
 *   parse <path-to-flp>   print a JSON summary of a single project file
 */

import { resolve } from 'node:path';
import { FlpParseError } from './parser/events.js';
import { parseFlpFile } from './parser/flp.js';

const USAGE = `drumkit-extractor

Usage:
  drumkit-extractor parse <path-to-flp>

Options:
  --raw-events   include the unhandled-event-id histogram (default: on)
  --quiet        omit the unhandled-event-id histogram
`;

function main(argv: string[]): number {
  const args = argv.slice(2);
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command !== 'parse') {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const target = args.find((a, i) => i > 0 && !a.startsWith('--'));
  if (target === undefined) {
    process.stderr.write(`parse requires a path to an .flp file\n\n${USAGE}`);
    return 1;
  }

  try {
    const project = parseFlpFile(resolve(target));
    const output: Record<string, unknown> = { ...project };
    if (args.includes('--quiet')) {
      output['stats'] = { eventCount: project.stats.eventCount };
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

process.exitCode = main(process.argv);
