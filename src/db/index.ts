/**
 * SQLite index. Synchronous throughout (better-sqlite3), which suits a
 * filesystem crawl: there is no concurrency to exploit and transactions stay
 * simple.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Opens (creating if needed) the index database, applies the schema, and runs
 * any pending additive migrations so an older database from a previous session
 * keeps its data and simply gains the new columns.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  // Read from the source tree so the schema stays a plain .sql file rather than
  // a string baked into TypeScript.
  const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

export const DEFAULT_DB_PATH = 'drumkit-index.db';
