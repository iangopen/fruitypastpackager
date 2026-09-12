/**
 * Scan orchestration: crawl a root, parse every .flp found, write the results
 * into the index.
 *
 * Each file gets its own error boundary. One corrupt project must not end the
 * run; it is recorded as a failed row and the crawl continues.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '../db/index.js';
import type { FlpProject } from '../parser/flp.js';
import { parseFlpBuffer, parseFlpFile } from '../parser/flp.js';
import { looksLikeZip, readZip, readZipEntry } from '../resolver/zip.js';
import { type CrawlError, type CrawlStats, crawlForFlp, newCrawlStats } from './crawl.js';

/**
 * Event 172's payload width is assumed, not proven — widths 1 and 3 both parse
 * every known file identically. Any project containing it is flagged so the
 * assumption stays visible in the data rather than silently riding along.
 * See the Findings Log in CLAUDE.md.
 */
export const EVENT_172_WARNING =
  'event ID 172 encountered: payload width is assumed to be 3 bytes; ' +
  'a 1-byte payload followed by an event-1 byte is equally consistent with all ' +
  'known files. Downstream rows from these projects rest on that assumption.';

export interface ScanSummary {
  runId: number;
  root: string;
  startedAt: string;
  finishedAt: string;
  filesFound: number;
  filesParsed: number;
  filesErrored: number;
  channelsIndexed: number;
  patternsIndexed: number;
  notesIndexed: number;
  distinctSamplePaths: number;
  event172Files: number;
  crawl: CrawlStats;
  errors: Array<{ path: string; kind: string; message: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parses the .flp stored inside a zipped project container.
 *
 * UNTESTED against a real FL archive: no .flp on this machine is a ZIP
 * container, so the assumption that the archive holds exactly one .flp is
 * taken from the format's documented behaviour, not observed. Ambiguity throws
 * rather than picking one.
 */
function parseZippedProject(file: string, includeNotes: boolean): FlpProject {
  const container = readZip(file);
  if (!container) throw new Error('looks like a zip container but the archive could not be read');
  const inner = container.entries.filter((e) => e.name.toLowerCase().endsWith('.flp'));
  if (inner.length === 0) throw new Error('zip container holds no .flp');
  if (inner.length > 1) {
    throw new Error(`zip container holds ${inner.length} .flp files; cannot tell which is the project`);
  }
  const entry = inner[0];
  if (!entry) throw new Error('zip container holds no .flp');
  const buf = readZipEntry(container, entry);
  if (!buf) throw new Error(`could not extract ${entry.name} from container`);
  const project = parseFlpBuffer(buf, file, { includeNotes });
  project.warnings.push(`project read from zip container entry ${entry.name}`);
  return project;
}

/** Marks a raw path that carries an FL path variable such as %FLStudioFactoryData%. */
function hasPathVariable(raw: string): boolean {
  return /%[^%\\/]+%/.test(raw);
}

function baseNameOf(raw: string): string {
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] ?? raw;
}

export interface ScanOptions {
  includeNotes?: boolean;
  onProgress?: (found: number, path: string) => void;
}

export function scan(db: Db, root: string, options: ScanOptions = {}): ScanSummary {
  const includeNotes = options.includeNotes ?? true;
  const startedAt = nowIso();

  const runId = Number(
    db
      .prepare('INSERT INTO scan_runs (root, started_at, status) VALUES (?, ?, ?)')
      .run(root, startedAt, 'running').lastInsertRowid,
  );

  const stmt = {
    insertError: db.prepare(
      'INSERT INTO scan_errors (scan_run_id, path, kind, message) VALUES (?, ?, ?, ?)',
    ),
    findSampleRef: db.prepare('SELECT id FROM sample_refs WHERE raw_path = ?'),
    insertSampleRef: db.prepare(
      'INSERT INTO sample_refs (raw_path, base_name, has_path_variable) VALUES (?, ?, ?)',
    ),
    deleteProject: db.prepare('DELETE FROM projects WHERE path = ?'),
    findProject: db.prepare('SELECT id, first_seen_run_id FROM projects WHERE path = ?'),
    insertProject: db.prepare(`
      INSERT INTO projects (
        path, file_name, file_size, file_mtime, first_seen_run_id, last_seen_run_id,
        parse_ok, parse_error, format_version, fl_version, fl_version_build, ppq, tempo,
        time_sig_numerator, time_sig_denominator, title, comment, project_path,
        channel_count, pattern_count, note_count, event_count, has_event_172, warnings
      ) VALUES (
        @path, @file_name, @file_size, @file_mtime, @first_seen_run_id, @last_seen_run_id,
        @parse_ok, @parse_error, @format_version, @fl_version, @fl_version_build, @ppq, @tempo,
        @time_sig_numerator, @time_sig_denominator, @title, @comment, @project_path,
        @channel_count, @pattern_count, @note_count, @event_count, @has_event_172, @warnings
      )`),
    insertChannel: db.prepare(`
      INSERT INTO channels (project_id, channel_index, name, type, type_id, plugin_name, sample_ref_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertPattern: db.prepare(
      'INSERT INTO patterns (project_id, pattern_index, name, note_count) VALUES (?, ?, ?, ?)',
    ),
    insertNote: db.prepare(`
      INSERT INTO notes (pattern_id, project_id, rack_channel, position, length, key, velocity, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  };

  const errors: ScanSummary['errors'] = [];
  const recordError = (path: string, kind: string, msg: string) => {
    errors.push({ path, kind, message: msg });
    stmt.insertError.run(runId, path, kind, msg);
  };

  const crawlErrors: CrawlError[] = [];
  const crawlStats: CrawlStats = newCrawlStats();
  const iter = crawlForFlp(root, { onError: (e) => crawlErrors.push(e), stats: crawlStats });

  let filesFound = 0;
  let filesParsed = 0;
  let filesErrored = 0;
  let channelsIndexed = 0;
  let patternsIndexed = 0;
  let notesIndexed = 0;
  let event172Files = 0;

  /** Interns a raw sample path, returning its sample_refs id. */
  const sampleRefId = (raw: string): number => {
    const found = stmt.findSampleRef.get(raw) as { id: number } | undefined;
    if (found) return found.id;
    return Number(
      stmt.insertSampleRef.run(raw, baseNameOf(raw), hasPathVariable(raw) ? 1 : 0).lastInsertRowid,
    );
  };

  const insertProjectRow = (
    file: string,
    stat: { size: number; mtime: Date },
    parsed: FlpProject | null,
    parseError: string | null,
  ): void => {
    // A rescan replaces the project and its children rather than duplicating
    // them; scan_runs keeps the history of runs instead.
    const existing = stmt.findProject.get(file) as
      | { id: number; first_seen_run_id: number }
      | undefined;
    const firstSeen = existing?.first_seen_run_id ?? runId;
    if (existing) stmt.deleteProject.run(file);

    const noteTotal = parsed ? parsed.patterns.reduce((a, p) => a + p.noteCount, 0) : null;

    const projectId = Number(
      stmt.insertProject.run({
        path: file,
        file_name: basename(file),
        file_size: stat.size,
        file_mtime: stat.mtime.toISOString(),
        first_seen_run_id: firstSeen,
        last_seen_run_id: runId,
        parse_ok: parsed ? 1 : 0,
        parse_error: parseError,
        format_version: parsed?.header.formatVersion ?? null,
        fl_version: parsed?.flVersion ?? null,
        fl_version_build: parsed?.flVersionBuild ?? null,
        ppq: parsed?.header.ppq ?? null,
        tempo: parsed?.tempo ?? null,
        time_sig_numerator: parsed?.timeSignature?.numerator ?? null,
        time_sig_denominator: parsed?.timeSignature?.denominator ?? null,
        title: parsed?.title ?? null,
        comment: parsed?.comment ?? null,
        project_path: parsed?.projectPath ?? null,
        channel_count: parsed?.channels.length ?? null,
        pattern_count: parsed?.patterns.length ?? null,
        note_count: noteTotal,
        event_count: parsed?.stats.eventCount ?? null,
        has_event_172: parsed?.hasEvent172 ? 1 : 0,
        warnings: parsed ? JSON.stringify(parsed.warnings) : null,
      }).lastInsertRowid,
    );

    if (!parsed) return;

    for (const ch of parsed.channels) {
      const refId = ch.samplePath !== null ? sampleRefId(ch.samplePath) : null;
      stmt.insertChannel.run(
        projectId,
        ch.id,
        ch.name,
        ch.type,
        ch.typeId,
        ch.pluginName,
        refId,
      );
      channelsIndexed++;
    }

    for (const pat of parsed.patterns) {
      const patternId = Number(
        stmt.insertPattern.run(projectId, pat.id, pat.name, pat.noteCount).lastInsertRowid,
      );
      patternsIndexed++;
      for (const n of pat.notes) {
        stmt.insertNote.run(
          patternId,
          projectId,
          n.rackChannel,
          n.position,
          n.length,
          n.key,
          n.velocity,
          n.flags,
        );
        notesIndexed++;
      }
    }
  };

  // One transaction per file: a failure rolls back only that project's rows,
  // and the crawl keeps going.
  const indexOne = db.transaction(insertProjectRow);

  for (const file of iter) {
    filesFound++;
    options.onProgress?.(filesFound, file);

    let stat;
    try {
      stat = statSync(file);
    } catch (err) {
      filesErrored++;
      recordError(file, 'file', err instanceof Error ? err.message : String(err));
      continue;
    }

    let parsed: FlpProject | null = null;
    let parseError: string | null = null;
    try {
      // A "save with all files" project is a ZIP container whose .flp lives
      // inside it. Detect that by magic bytes rather than extension, since FL
      // keeps the .flp extension on the container.
      parsed = looksLikeZip(file)
        ? parseZippedProject(file, includeNotes)
        : parseFlpFile(file, { includeNotes });
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    try {
      indexOne(file, stat, parsed, parseError);
    } catch (err) {
      // An insert failure is a real problem, but still only this file's problem.
      filesErrored++;
      recordError(file, 'file', `index write failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (parsed) {
      filesParsed++;
      if (parsed.hasEvent172) event172Files++;
    } else {
      filesErrored++;
      recordError(file, 'parse', parseError ?? 'unknown parse failure');
    }
  }

  for (const e of crawlErrors) recordError(e.path, e.kind, e.message);

  const distinctSamplePaths = (
    db.prepare('SELECT COUNT(*) AS n FROM sample_refs').get() as { n: number }
  ).n;

  const finishedAt = nowIso();
  db.prepare(
    `UPDATE scan_runs SET finished_at = ?, status = ?, dirs_visited = ?, dirs_errored = ?,
       files_found = ?, files_parsed = ?, files_errored = ?, event_172_files = ?,
       event_172_warning = ?, notes = ?
     WHERE id = ?`,
  ).run(
    finishedAt,
    'completed',
    crawlStats.dirsVisited,
    crawlStats.dirsErrored,
    filesFound,
    filesParsed,
    filesErrored,
    event172Files,
    event172Files > 0 ? EVENT_172_WARNING : null,
    JSON.stringify({
      dirsSkippedAsLoop: crawlStats.dirsSkippedAsLoop,
      maxDepthReached: crawlStats.maxDepthReached,
      queueHighWater: crawlStats.queueHighWater,
      includeNotes,
    }),
    runId,
  );

  return {
    runId,
    root,
    startedAt,
    finishedAt,
    filesFound,
    filesParsed,
    filesErrored,
    channelsIndexed,
    patternsIndexed,
    notesIndexed,
    distinctSamplePaths,
    event172Files,
    crawl: crawlStats,
    errors,
  };
}
