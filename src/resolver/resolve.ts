/**
 * Sample path resolution.
 *
 * Turns a raw path string, exactly as some .flp spelled it, into a real file on
 * disk. The strategies run in a fixed order from most to least trustworthy, and
 * the one that succeeded is recorded per reference — a resolution found by
 * fuzzy matching is not the same claim as one found by direct existence, and
 * the exporter deserves to know which it got.
 *
 * Nothing here rewrites the stored raw path. Resolution is additive.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crawlForFlp } from '../scanner/crawl.js';
import { type FlPaths, expandVariables, hasVariablePrefix } from './variables.js';
import { type ZipContainer, findEntryForSample, looksLikeZip, readZip } from './zip.js';

export const AUDIO_EXTENSIONS = [
  '.wav',
  '.ogg',
  '.mp3',
  '.flac',
  '.aif',
  '.aiff',
  '.wv',
  '.rex',
  '.rx2',
];

export function isAudioName(lowerName: string): boolean {
  return AUDIO_EXTENSIONS.some((e) => lowerName.endsWith(e));
}

/**
 * Ordered from strongest evidence to weakest. Stored per reference so a
 * downstream consumer can decide how much to trust a given resolution.
 */
export type Strategy =
  | 'variable-expansion'
  | 'direct'
  | 'direct-case-insensitive'
  | 'project-sibling'
  | 'basename-index'
  | 'fuzzy-basename-size'
  | 'zip-container';

export type ResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous';

export interface Resolution {
  status: ResolutionStatus;
  strategy: Strategy | null;
  resolvedPath: string | null;
  /** Set when the file lives inside a zipped project rather than on disk. */
  containerPath: string | null;
  fileSize: number | null;
  /** Why an ambiguous or unresolved reference ended that way. */
  detail: string | null;
}

const UNRESOLVED: Resolution = {
  status: 'unresolved',
  strategy: null,
  resolvedPath: null,
  containerPath: null,
  fileSize: null,
  detail: null,
};

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function ok(strategy: Strategy, path: string, containerPath: string | null = null): Resolution {
  return {
    status: 'resolved',
    strategy,
    resolvedPath: path,
    containerPath,
    fileSize: containerPath === null ? sizeOf(path) : null,
    detail: null,
  };
}

/**
 * Case-insensitive existence check.
 *
 * Windows is already case-insensitive, so this mostly matters for correctness
 * elsewhere — but Session 2 found raw rows differing only by case, and this
 * keeps the behaviour explicit rather than relying on the platform.
 */
function existsCaseInsensitive(path: string, dirCache: Map<string, Map<string, string>>): string | null {
  if (existsSync(path)) return path;
  const dir = dirname(path);
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  let listing = dirCache.get(dir.toLowerCase());
  if (listing === undefined) {
    listing = new Map();
    try {
      for (const name of readdirSync(dir)) listing.set(name.toLowerCase(), name);
    } catch {
      // Unreadable directory: nothing to match against.
    }
    dirCache.set(dir.toLowerCase(), listing);
  }
  const actual = listing.get(base);
  return actual === undefined ? null : join(dir, actual);
}

/**
 * Normalises a basename for fuzzy comparison: case, separators, FL's " #2"
 * duplicate suffix, and bracketed/parenthesised trailers all fall away.
 * Deliberately conservative — it must not collapse "kick 1" and "kick 2".
 */
export function fuzzyKey(baseName: string): string {
  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot).toLowerCase() : '';
  return (
    stem
      .toLowerCase()
      .replace(/\s+#\d+$/, '') // FL's duplicate-channel suffix
      .replace(/[\s_\-]+/g, '') // spacing/punctuation drift
      .replace(/\((?:copy|\d+)\)$/, '') + ext
  );
}

export interface SampleIndex {
  /** lowercased basename -> absolute paths */
  byBaseName: Map<string, string[]>;
  /** fuzzy key -> absolute paths */
  byFuzzyKey: Map<string, string[]>;
  filesIndexed: number;
  rootsIndexed: string[];
}

export function emptyIndex(): SampleIndex {
  return { byBaseName: new Map(), byFuzzyKey: new Map(), filesIndexed: 0, rootsIndexed: [] };
}

/**
 * Builds the basename index over the given roots. This is the expensive part
 * of resolution, so it is built once and reused for every reference.
 */
export function buildSampleIndex(roots: string[], onError?: (m: string) => void): SampleIndex {
  const index = emptyIndex();
  const seenPaths = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    index.rootsIndexed.push(root);
    for (const file of crawlForFlp(root, {
      matchFile: isAudioName,
      onError: (e) => onError?.(`${e.path}: ${e.message}`),
    })) {
      const key = file.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);

      const base = (file.split(/[\\/]/).pop() ?? '').toLowerCase();
      const list = index.byBaseName.get(base);
      if (list) list.push(file);
      else index.byBaseName.set(base, [file]);

      const fk = fuzzyKey(base);
      const flist = index.byFuzzyKey.get(fk);
      if (flist) flist.push(file);
      else index.byFuzzyKey.set(fk, [file]);

      index.filesIndexed++;
    }
  }
  return index;
}

export interface ResolveContext {
  fl: FlPaths;
  index: SampleIndex;
  /** Directories of the projects that reference this sample. */
  projectDirs: string[];
  dirCache: Map<string, Map<string, string>>;
  /** Cache of parsed zip containers, keyed by container path. */
  zipCache: Map<string, ZipContainer | null>;
  /**
   * Subdirectories under a project folder that FL uses for project-local
   * audio. Checked in addition to the project directory itself.
   */
  projectSubdirs?: string[];
}

const DEFAULT_PROJECT_SUBDIRS = ['', 'Audio', 'Samples', 'Audio\\Recorded', 'Rendered'];

/**
 * Runs the resolution chain for one raw path.
 *
 * Order is deliberate and matches CLAUDE.md, with variable expansion inserted
 * ahead of the direct check because it is an identifiable, documented case
 * rather than a fallback guess.
 */
export function resolveSamplePath(raw: string, ctx: ResolveContext): Resolution {
  const baseName = raw.split(/[\\/]/).pop() ?? raw;
  if (baseName.length === 0) return { ...UNRESOLVED, detail: 'empty path' };

  // 0. Zipped project container. Checked first for projects that are
  //    containers, since for those the filesystem copy may not exist at all.
  for (const projectDir of ctx.projectDirs) {
    const container = loadContainerFor(projectDir, ctx);
    if (container) {
      const entry = findEntryForSample(container, raw);
      if (entry) return ok('zip-container', entry.name, container.path);
    }
  }

  // 1. Path-variable expansion (%FLStudioFactoryData% and friends).
  if (hasVariablePrefix(raw)) {
    for (const candidate of expandVariables(raw, ctx.fl)) {
      const hit = existsCaseInsensitive(candidate, ctx.dirCache);
      if (hit) return ok('variable-expansion', hit);
    }
    // Fall through: an unexpandable variable can still match by basename.
  }

  // 2. Direct existence, exactly as stored.
  if (!hasVariablePrefix(raw) && existsSync(raw)) {
    const st = sizeOf(raw);
    if (st !== null) return ok('direct', raw);
  }

  // 3. Direct existence, case-insensitively.
  if (!hasVariablePrefix(raw)) {
    const hit = existsCaseInsensitive(raw, ctx.dirCache);
    if (hit) return ok('direct-case-insensitive', hit);
  }

  // 4. Sibling of the referencing project. Covers relative paths and projects
  //    that were moved wholesale with their audio alongside them.
  const subdirs = ctx.projectSubdirs ?? DEFAULT_PROJECT_SUBDIRS;
  for (const projectDir of ctx.projectDirs) {
    for (const sub of subdirs) {
      const candidate = join(projectDir, sub, baseName);
      const hit = existsCaseInsensitive(candidate, ctx.dirCache);
      if (hit) return ok('project-sibling', hit);
    }
    // A stored relative path resolved against the project directory.
    if (!/^([a-zA-Z]:|[\\/]|%)/.test(raw)) {
      const hit = existsCaseInsensitive(join(projectDir, raw), ctx.dirCache);
      if (hit) return ok('project-sibling', hit);
    }
  }

  // 5. Basename index over known sample directories.
  const exact = ctx.index.byBaseName.get(baseName.toLowerCase());
  if (exact && exact.length > 0) {
    if (exact.length === 1 && exact[0]) return ok('basename-index', exact[0]);
    const distinct = distinctBySize(exact);
    if (distinct.length === 1 && distinct[0]) return ok('basename-index', distinct[0]);
    // Several same-named files of different sizes: a guess here would be a
    // wrong sample in the kit, which is worse than an honest gap.
    return {
      ...UNRESOLVED,
      status: 'ambiguous',
      detail: `${exact.length} files share this name with ${distinct.length} distinct sizes`,
    };
  }

  // 6. Fuzzy basename, disambiguated by file size.
  const fuzzy = ctx.index.byFuzzyKey.get(fuzzyKey(baseName));
  if (fuzzy && fuzzy.length > 0) {
    if (fuzzy.length === 1 && fuzzy[0]) return ok('fuzzy-basename-size', fuzzy[0]);
    const distinct = distinctBySize(fuzzy);
    if (distinct.length === 1 && distinct[0]) return ok('fuzzy-basename-size', distinct[0]);
    return {
      ...UNRESOLVED,
      status: 'ambiguous',
      detail: `${fuzzy.length} fuzzy matches with ${distinct.length} distinct sizes`,
    };
  }

  return { ...UNRESOLVED, detail: 'no candidate found' };
}

/**
 * Collapses candidates that are the same size — same-sized same-named files are
 * overwhelmingly the same content, so picking any one of them is safe. Returns
 * one representative per distinct size.
 */
function distinctBySize(paths: string[]): string[] {
  const bySize = new Map<number, string>();
  for (const p of paths) {
    const s = sizeOf(p);
    if (s === null) continue;
    if (!bySize.has(s)) bySize.set(s, p);
  }
  return [...bySize.values()];
}

/** Finds and caches a zip container for a project directory, if one exists. */
function loadContainerFor(projectDir: string, ctx: ResolveContext): ZipContainer | null {
  const cached = ctx.zipCache.get(projectDir.toLowerCase());
  if (cached !== undefined) return cached;

  let found: ZipContainer | null = null;
  try {
    for (const name of readdirSync(projectDir)) {
      const full = join(projectDir, name);
      if (!/\.(flp|zip)$/i.test(name)) continue;
      if (!looksLikeZip(full)) continue;
      found = readZip(full);
      if (found) break;
    }
  } catch {
    // Unreadable project directory: no container.
  }
  ctx.zipCache.set(projectDir.toLowerCase(), found);
  return found;
}
