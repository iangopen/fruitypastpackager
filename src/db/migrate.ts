/**
 * Additive schema migrations.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which does nothing for a table
 * that already exists with an older column set. A Session 2 database holds real
 * scan results that must not be thrown away and re-derived, so new columns are
 * added in place instead.
 *
 * Every migration here is additive. Nothing rewrites the raw path strings the
 * scanner stored.
 */

import type { Db } from './index.js';

function columnNames(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function addColumn(db: Db, table: string, column: string, decl: string): boolean {
  if (columnNames(db, table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

/** Applies pending migrations. Returns a description of what changed. */
export function migrate(db: Db): string[] {
  const applied: string[] = [];

  // --- resolver columns on sample_refs -------------------------------------
  const sampleRefCols: Array<[string, string]> = [
    ['resolution_strategy', 'TEXT'],
    ['resolution_detail', 'TEXT'],
    ['file_size', 'INTEGER'],
    // Set when the sample lives inside a zipped project rather than on disk.
    ['container_path', 'TEXT'],
    ['resolve_run_id', 'INTEGER'],
  ];
  for (const [name, decl] of sampleRefCols) {
    if (addColumn(db, 'sample_refs', name, decl)) applied.push(`sample_refs.${name}`);
  }

  // --- content store --------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_files (
      hash            TEXT    PRIMARY KEY,
      algorithm       TEXT    NOT NULL,
      file_size       INTEGER NOT NULL,
      first_seen_path TEXT    NOT NULL,
      hashed_at       TEXT    NOT NULL
    );

    -- The content-addressed manifest: one row per (content, place it appeared).
    -- This is what makes "this kick is in 47 projects" a first-class query, and
    -- it is keyed on hash so the same audio counts once however many different
    -- path spellings referred to it.
    CREATE TABLE IF NOT EXISTS sample_manifest (
      id             INTEGER PRIMARY KEY,
      hash           TEXT    NOT NULL REFERENCES content_files(hash) ON DELETE CASCADE,
      sample_ref_id  INTEGER NOT NULL REFERENCES sample_refs(id) ON DELETE CASCADE,
      project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      channel_id     INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      channel_name   TEXT,
      original_name  TEXT    NOT NULL,   -- basename as the .flp spelled it
      raw_path       TEXT    NOT NULL,   -- the full raw string, unmodified
      resolved_path  TEXT    NOT NULL,
      container_path TEXT,
      UNIQUE(hash, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_manifest_hash    ON sample_manifest(hash);
    CREATE INDEX IF NOT EXISTS idx_manifest_project ON sample_manifest(project_id);
    CREATE INDEX IF NOT EXISTS idx_manifest_name    ON sample_manifest(original_name);

    CREATE TABLE IF NOT EXISTS resolve_runs (
      id                 INTEGER PRIMARY KEY,
      started_at         TEXT    NOT NULL,
      finished_at        TEXT,
      status             TEXT    NOT NULL DEFAULT 'running',
      hash_algorithm     TEXT,
      refs_total         INTEGER NOT NULL DEFAULT 0,
      refs_resolved      INTEGER NOT NULL DEFAULT 0,
      refs_ambiguous     INTEGER NOT NULL DEFAULT 0,
      refs_unresolved    INTEGER NOT NULL DEFAULT 0,
      files_hashed       INTEGER NOT NULL DEFAULT 0,
      bytes_hashed       INTEGER NOT NULL DEFAULT 0,
      index_files        INTEGER NOT NULL DEFAULT 0,
      index_roots        TEXT,
      fl_path_sources    TEXT,
      notes              TEXT
    );
  `);
  applied.push('content_files, sample_manifest, resolve_runs');

  return applied;
}
