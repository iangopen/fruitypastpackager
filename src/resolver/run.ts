/**
 * Resolve orchestration: take every raw sample path in the index, run the
 * resolution chain, hash what resolved, and build the content-addressed
 * manifest.
 *
 * Reads sample_refs; never rewrites raw_path.
 */

import { dirname } from 'node:path';
import type { Db } from '../db/index.js';
import { HASH_ALGORITHM, hashBuffer, hashFile } from '../content/hash.js';
import { type Resolution, buildSampleIndex, emptyIndex, resolveSamplePath } from './resolve.js';
import { discoverFlPaths } from './variables.js';
import { readZip, readZipEntry } from './zip.js';
import type { SampleIndex } from './resolve.js';
import type { ZipContainer } from './zip.js';

export interface ResolveSummary {
  runId: number;
  refsTotal: number;
  byStatus: Record<string, number>;
  byStrategy: Record<string, number>;
  filesHashed: number;
  bytesHashed: number;
  hashErrors: number;
  distinctHashes: number;
  manifestRows: number;
  indexFiles: number;
  indexRoots: string[];
  flSources: string[];
  variableRefs: { total: number; resolved: number };
  elapsedMs: number;
}

export interface ResolveOptions {
  /** Extra directories to add to the basename index. */
  extraSampleDirs?: string[];
  /** Skip building the basename index (fast run of the cheap strategies). */
  skipIndex?: boolean;
  onProgress?: (done: number, total: number) => void;
}

interface RefRow {
  id: number;
  raw_path: string;
  base_name: string;
}

export async function resolveAll(
  db: Db,
  options: ResolveOptions = {},
): Promise<ResolveSummary> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const fl = discoverFlPaths();

  const runId = Number(
    db
      .prepare(
        'INSERT INTO resolve_runs (started_at, status, hash_algorithm, fl_path_sources) VALUES (?,?,?,?)',
      )
      .run(startedAt, 'running', HASH_ALGORITHM, JSON.stringify(fl.sources)).lastInsertRowid,
  );

  const refs = db
    .prepare('SELECT id, raw_path, base_name FROM sample_refs ORDER BY id')
    .all() as RefRow[];

  // Which projects reference each sample, so the sibling strategy knows where
  // to look. A path can be referenced from several projects.
  const projectDirsByRef = new Map<number, string[]>();
  for (const row of db
    .prepare(
      `SELECT DISTINCT c.sample_ref_id AS ref, p.path AS path
         FROM channels c JOIN projects p ON p.id = c.project_id
        WHERE c.sample_ref_id IS NOT NULL`,
    )
    .all() as Array<{ ref: number; path: string }>) {
    const dir = dirname(row.path);
    const list = projectDirsByRef.get(row.ref);
    if (list) {
      if (!list.includes(dir)) list.push(dir);
    } else {
      projectDirsByRef.set(row.ref, [dir]);
    }
  }

  // The basename index covers the places samples plausibly live: FL's factory
  // content, the user data tree, and every directory that holds an indexed
  // project. Building it is the expensive step, so it happens once.
  let index: SampleIndex = emptyIndex();
  if (!options.skipIndex) {
    const projectRoots = new Set<string>();
    for (const dirs of projectDirsByRef.values()) for (const d of dirs) projectRoots.add(d);
    const roots = [
      ...fl.installRoots,
      ...fl.userDataRoots,
      ...projectRoots,
      ...(options.extraSampleDirs ?? []),
    ];
    index = buildSampleIndex(roots);
  }

  const ctxBase = {
    fl,
    index,
    dirCache: new Map<string, Map<string, string>>(),
    zipCache: new Map<string, ZipContainer | null>(),
  };

  const updateRef = db.prepare(
    `UPDATE sample_refs
        SET resolution_status = ?, resolution_strategy = ?, resolution_detail = ?,
            resolved_path = ?, resolved_at = ?, file_size = ?, container_path = ?,
            content_hash = ?, resolve_run_id = ?
      WHERE id = ?`,
  );
  const upsertContent = db.prepare(
    `INSERT INTO content_files (hash, algorithm, file_size, first_seen_path, hashed_at)
     VALUES (?,?,?,?,?) ON CONFLICT(hash) DO NOTHING`,
  );
  const insertManifest = db.prepare(
    `INSERT INTO sample_manifest
       (hash, sample_ref_id, project_id, channel_id, channel_name, original_name, raw_path, resolved_path, container_path)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(hash, channel_id) DO NOTHING`,
  );
  const channelsForRef = db.prepare(
    `SELECT c.id AS channel_id, c.project_id, c.name AS channel_name
       FROM channels c WHERE c.sample_ref_id = ?`,
  );

  const byStatus: Record<string, number> = {};
  const byStrategy: Record<string, number> = {};
  let filesHashed = 0;
  let bytesHashed = 0;
  let hashErrors = 0;
  let manifestRows = 0;
  let variableTotal = 0;
  let variableResolved = 0;

  const nowIso = new Date().toISOString();

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (!ref) continue;
    options.onProgress?.(i + 1, refs.length);

    const isVariable = /^%[^%]+%/.test(ref.raw_path);
    if (isVariable) variableTotal++;

    const res: Resolution = resolveSamplePath(ref.raw_path, {
      ...ctxBase,
      projectDirs: projectDirsByRef.get(ref.id) ?? [],
    });

    byStatus[res.status] = (byStatus[res.status] ?? 0) + 1;
    if (res.strategy) byStrategy[res.strategy] = (byStrategy[res.strategy] ?? 0) + 1;
    if (isVariable && res.status === 'resolved') variableResolved++;

    // Hash whatever resolved, from disk or from inside the container.
    let hash: string | null = null;
    let size = res.fileSize;
    if (res.status === 'resolved' && res.resolvedPath) {
      try {
        if (res.containerPath) {
          const container = readZip(res.containerPath);
          const entry = container?.entries.find((e) => e.name === res.resolvedPath);
          const buf = container && entry ? readZipEntry(container, entry) : null;
          if (buf) {
            hash = await hashBuffer(buf);
            size = buf.length;
          } else {
            hashErrors++;
          }
        } else {
          hash = await hashFile(res.resolvedPath);
        }
        if (hash) {
          filesHashed++;
          bytesHashed += size ?? 0;
          upsertContent.run(hash, HASH_ALGORITHM, size ?? 0, res.resolvedPath, nowIso);
        }
      } catch {
        hashErrors++;
      }
    }

    updateRef.run(
      res.status,
      res.strategy,
      res.detail,
      res.resolvedPath,
      res.status === 'resolved' ? nowIso : null,
      size,
      res.containerPath,
      hash,
      runId,
      ref.id,
    );

    if (hash) {
      for (const ch of channelsForRef.all(ref.id) as Array<{
        channel_id: number;
        project_id: number;
        channel_name: string | null;
      }>) {
        insertManifest.run(
          hash,
          ref.id,
          ch.project_id,
          ch.channel_id,
          ch.channel_name,
          ref.base_name,
          ref.raw_path,
          res.resolvedPath,
          res.containerPath,
        );
        manifestRows++;
      }
    }
  }

  const distinctHashes = (
    db.prepare('SELECT COUNT(*) AS n FROM content_files').get() as { n: number }
  ).n;

  db.prepare(
    `UPDATE resolve_runs
        SET finished_at = ?, status = 'completed', refs_total = ?, refs_resolved = ?,
            refs_ambiguous = ?, refs_unresolved = ?, files_hashed = ?, bytes_hashed = ?,
            index_files = ?, index_roots = ?, notes = ?
      WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    refs.length,
    byStatus['resolved'] ?? 0,
    byStatus['ambiguous'] ?? 0,
    byStatus['unresolved'] ?? 0,
    filesHashed,
    bytesHashed,
    index.filesIndexed,
    JSON.stringify(index.rootsIndexed),
    JSON.stringify({ byStrategy, hashErrors, variableTotal, variableResolved }),
    runId,
  );

  return {
    runId,
    refsTotal: refs.length,
    byStatus,
    byStrategy,
    filesHashed,
    bytesHashed,
    hashErrors,
    distinctHashes,
    manifestRows,
    indexFiles: index.filesIndexed,
    indexRoots: index.rootsIndexed,
    flSources: fl.sources,
    variableRefs: { total: variableTotal, resolved: variableResolved },
    elapsedMs: Date.now() - started,
  };
}

export interface TopSample {
  hash: string;
  projects: number;
  channels: number;
  spellings: number;
  names: string;
  fileSize: number;
  examplePath: string;
}

/**
 * Top samples by distinct-project usage, keyed on content hash.
 *
 * Keying on the hash rather than the raw path string is the whole point: the
 * same audio referenced as `C:\kit\Kick.wav`, `c:\kit\kick.wav` and
 * `%FLStudioFactoryData%\...\Kick.wav` is one sample used three times, not
 * three samples used once.
 */
export function topSamplesByUsage(db: Db, limit = 10): TopSample[] {
  return db
    .prepare(
      `SELECT m.hash                              AS hash,
              COUNT(DISTINCT m.project_id)        AS projects,
              COUNT(DISTINCT m.channel_id)        AS channels,
              COUNT(DISTINCT m.raw_path)          AS spellings,
              GROUP_CONCAT(DISTINCT m.original_name) AS names,
              cf.file_size                        AS fileSize,
              MIN(m.resolved_path)                AS examplePath
         FROM sample_manifest m
         JOIN content_files cf ON cf.hash = m.hash
        GROUP BY m.hash
        ORDER BY projects DESC, channels DESC
        LIMIT ?`,
    )
    .all(limit) as TopSample[];
}
