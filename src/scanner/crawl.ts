/**
 * Directory crawler.
 *
 * Walks a root looking for .flp files. The contract is that a hostile
 * filesystem must not be able to stop the run: symlink loops, permission
 * errors, disappearing files and absurdly deep trees are all recorded and
 * stepped over rather than thrown.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CrawlError {
  path: string;
  kind: 'directory' | 'file';
  message: string;
}

export interface CrawlStats {
  dirsVisited: number;
  dirsErrored: number;
  dirsSkippedAsLoop: number;
  maxDepthReached: number;
  queueHighWater: number;
}

export interface CrawlOptions {
  /** Give up descending past this depth. Guards against pathological trees. */
  maxDepth?: number;
  /**
   * Hard ceiling on the pending-directory frontier. The crawl is depth-first
   * precisely so this stays small, but a directory containing a million
   * subdirectories would still blow it up; hitting the cap stops descent
   * rather than exhausting memory.
   */
  maxQueue?: number;
  /** Directory names skipped outright. */
  skipDirs?: ReadonlySet<string>;
  /**
   * Which files to yield, by lowercased file name. Defaults to `.flp`.
   * The resolver reuses this walker to build its audio-file index.
   */
  matchFile?: (lowerName: string) => boolean;
  onError?: (err: CrawlError) => void;
  /**
   * Counters, mutated in place as the walk proceeds.
   *
   * Deliberately not the generator's return value: a `for...of` loop consumes
   * that return and discards it, so stats reported that way silently come back
   * as zeroes. An out-parameter is readable at any point, including after an
   * early `break`.
   */
  stats?: CrawlStats;
}

export function newCrawlStats(): CrawlStats {
  return {
    dirsVisited: 0,
    dirsErrored: 0,
    dirsSkippedAsLoop: 0,
    maxDepthReached: 0,
    queueHighWater: 0,
  };
}

const DEFAULT_SKIP = new Set([
  'node_modules',
  '.git',
  '$Recycle.Bin',
  'System Volume Information',
  'Windows',
]);

function message(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Yields every matching file path under `root` (.flp by default).
 *
 * Depth-first via an explicit stack: recursion would risk a stack overflow on a
 * deep tree, and a LIFO frontier keeps the pending queue proportional to depth
 * rather than to total directory count the way BFS would.
 */
export function* crawlForFlp(
  root: string,
  options: CrawlOptions = {},
): Generator<string, void, void> {
  const maxDepth = options.maxDepth ?? 64;
  const maxQueue = options.maxQueue ?? 100_000;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP;
  const matchFile = options.matchFile ?? ((n: string) => n.endsWith('.flp'));
  const onError = options.onError ?? (() => {});

  const stats = options.stats ?? newCrawlStats();

  // Symlink loop protection: a directory is identified by its resolved real
  // path, so a link pointing back up the tree resolves to somewhere already
  // visited and is skipped. Without this, `a/link -> a` walks forever.
  const seen = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [];

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    onError({ path: root, kind: 'directory', message: message(err) });
    stats.dirsErrored++;
    return;
  }
  stack.push({ dir: rootReal, depth: 0 });
  seen.add(rootReal.toLowerCase());

  while (stack.length > 0) {
    if (stack.length > stats.queueHighWater) stats.queueHighWater = stack.length;
    const entry = stack.pop();
    if (entry === undefined) break;
    const { dir, depth } = entry;
    if (depth > stats.maxDepthReached) stats.maxDepthReached = depth;

    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
      stats.dirsVisited++;
    } catch (err) {
      stats.dirsErrored++;
      onError({ path: dir, kind: 'directory', message: message(err) });
      continue;
    }

    for (const d of dirents) {
      const full = join(dir, d.name);

      // Anything we cannot classify straight from the dirent gets a real
      // stat() before we decide what it is.
      //
      // This is not just about symlinks. Windows exposes junctions AND OneDrive
      // cloud-backed folders as reparse points, and for those a Dirent reports
      // isDirectory(), isFile() and isSymbolicLink() ALL false. Trusting the
      // dirent alone silently skips the entire OneDrive tree — which on this
      // machine is where the real projects live.
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      if (!isDir && !isFile) {
        try {
          const st = statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (err) {
          // Broken link, offline cloud file, or a device entry: note and move on.
          onError({ path: full, kind: 'file', message: message(err) });
          continue;
        }
      }

      if (isDir) {
        if (skipDirs.has(d.name)) continue;
        if (depth + 1 > maxDepth) continue;
        if (stack.length >= maxQueue) {
          onError({
            path: full,
            kind: 'directory',
            message: `queue cap ${maxQueue} reached; not descending further here`,
          });
          continue;
        }
        let real: string;
        try {
          real = realpathSync(full);
        } catch (err) {
          stats.dirsErrored++;
          onError({ path: full, kind: 'directory', message: message(err) });
          continue;
        }
        // Windows paths are case-insensitive; lowercasing avoids treating
        // C:\Foo and C:\foo as two different directories.
        const key = real.toLowerCase();
        if (seen.has(key)) {
          stats.dirsSkippedAsLoop++;
          continue;
        }
        seen.add(key);
        // Descend into the RESOLVED path, not the link we arrived by. These
        // must be the same path or the walk loses whole subtrees: on Windows,
        // C:\Documents and Settings is an ACL-denied junction to C:\Users, so
        // queueing the link while marking its target as seen means the junction
        // claims C:\Users, the real C:\Users is then skipped as a duplicate,
        // and reading the junction fails with EPERM. Net effect: every user
        // profile silently vanishes from the scan.
        stack.push({ dir: real, depth: depth + 1 });
        continue;
      }

      if (isFile && matchFile(d.name.toLowerCase())) {
        yield full;
      }
    }
  }
}
