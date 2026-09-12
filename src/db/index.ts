/**
 * SQLite index. Synchronous throughout (better-sqlite3), which suits a
 * filesystem crawl: there is no concurrency to exploit and transactions stay
 * simple.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Opens (creating if needed) the index database and applies the schema. */
export function openDb(path: string): Db {
  const db = new Database(path);
  // Read from the source tree so the schema stays a plain .sql file rather than
  // a string baked into TypeScript.
  const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export const DEFAULT_DB_PATH = 'drumkit-index.db';
