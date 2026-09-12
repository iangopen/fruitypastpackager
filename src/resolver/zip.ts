/**
 * Minimal ZIP container reader, for FL's "save with all files" / zipped-loop
 * packages.
 *
 * VERIFICATION STATUS: written defensively from the ZIP format, NOT verified
 * against a genuine FL-produced zipped project. None of the 557 .flp files
 * reachable on this machine is a ZIP container (every one begins with `FLhd`),
 * so the container layout FL actually writes — where it puts the .flp, whether
 * samples keep their original directory structure — is unconfirmed. The ZIP
 * parsing itself is exercised by a synthetic archive in the test fixture; the
 * FL-specific assumptions are not. Treat this path as untested until a real
 * zipped project turns up.
 *
 * Only the central directory is parsed, and only stored (0) and deflated (8)
 * entries are supported — the two methods ZIP writers in practice emit. Node's
 * zlib covers deflate, so this needs no dependency.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

export interface ZipContainer {
  path: string;
  entries: ZipEntry[];
}

/** True if the file begins with a local-file-header signature. */
export function looksLikeZip(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 0) < 4) return false;
    return b.readUInt32LE(0) === SIG_LOCAL;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads the central directory. Returns null if the file is not a usable zip. */
export function readZip(path: string): ZipContainer | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size < 22) return null;
    fd = openSync(path, 'r');

    // The end-of-central-directory record sits at the very end, after an
    // optional comment of up to 64KB, so scan backwards for its signature.
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) return null;

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { path, entries };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Extracts one entry's bytes. Returns null if the method is unsupported. */
export function readZipEntry(container: ZipContainer, entry: ZipEntry): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(container.path, 'r');

    // The central directory's name/extra lengths can differ from the local
    // header's, so the data offset must come from the local header itself.
    const lh = Buffer.alloc(30);
    readSync(fd, lh, 0, 30, entry.localHeaderOffset);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) return null;
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entry.compressedSize);
    readSync(fd, raw, 0, entry.compressedSize, dataStart);

    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const AUDIO_RE = /\.(wav|ogg|mp3|flac|aif|aiff|wv|rex|rx2)$/i;

/**
 * Finds the entry inside a container that a raw sample path refers to.
 *
 * Matching is by basename, case-insensitively: a container flattens or
 * re-roots paths, so the stored absolute path will not match an entry name
 * literally. Ambiguity (two entries with the same basename) resolves to null
 * rather than to a guess.
 */
export function findEntryForSample(container: ZipContainer, rawPath: string): ZipEntry | null {
  const base = (rawPath.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (base.length === 0) return null;
  const matches = container.entries.filter(
    (e) => (e.name.split(/[\\/]/).pop() ?? '').toLowerCase() === base,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Lists the audio entries in a container. */
export function audioEntries(container: ZipContainer): ZipEntry[] {
  return container.entries.filter((e) => AUDIO_RE.test(e.name));
}
