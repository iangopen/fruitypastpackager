/**
 * Generic FLP event-stream reader.
 *
 * An .flp file is two chunks: `FLhd` (fixed 6-byte header) and `FLdt` (a flat
 * event stream). Every event is a one-byte ID followed by a payload whose width
 * is determined by the ID's numeric range:
 *
 *   0-63    1 byte   (byte)
 *   64-127  2 bytes  (word)
 *   128-191 4 bytes  (dword)
 *   192-255 variable, preceded by a 7-bit little-endian varint size
 *
 * That property is what makes the format skippable: an event we do not
 * understand still tells us its own length, so we never lose sync. We read the
 * whole stream generically and only interpret the handful of IDs we care about.
 */

/** Payload width class implied by an event ID's numeric range. */
export type EventKind = 'byte' | 'word' | 'dword' | 'text';

export interface FlpEvent {
  readonly id: number;
  readonly kind: EventKind;
  /** Byte offset of the event ID within the file. */
  readonly offset: number;
  readonly data: Buffer;
}

/**
 * Payload widths that deviate from the range rule above.
 *
 * Empirically derived, not guessed: FL Studio 25.2.5 writes event 172 once in
 * the project header with a 3-byte payload, even though 172 falls in the dword
 * range. Reading it as 4 bytes desynchronises the stream by one byte, which
 * swallows the project title and tempo events before the stream happens to
 * resynchronise later. Verified across 26 real projects (FL 24.2.2 and 25.2.5):
 * with this override every file's stream terminates exactly on the chunk
 * boundary and the channel-event count matches the header's channel count;
 * without it, several files fail outright.
 */
const WIDTH_OVERRIDES = new Map<number, number>([[172, 3]]);

export function kindOf(id: number): EventKind {
  if (id < 64) return 'byte';
  if (id < 128) return 'word';
  if (id < 192) return 'dword';
  return 'text';
}

/** Thrown when the byte stream cannot be walked as a valid event sequence. */
export class FlpParseError extends Error {}

/**
 * Walks the event stream from `start` to `end`, yielding every event.
 * Payloads are subarray views over `buf` — no copying.
 */
export function readEvents(buf: Buffer, start: number, end: number): FlpEvent[] {
  const events: FlpEvent[] = [];
  let p = start;

  while (p < end) {
    const offset = p;
    const id = buf[p];
    if (id === undefined) break;
    p += 1;

    const kind = kindOf(id);
    let size: number;

    if (kind === 'text') {
      // 7-bit varint, little-endian, high bit = continuation.
      size = 0;
      let shift = 0;
      for (;;) {
        if (p >= end) throw new FlpParseError(`truncated varint size at offset ${offset}`);
        const b = buf[p]!;
        p += 1;
        size |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
        if (shift > 28) throw new FlpParseError(`varint size too large at offset ${offset}`);
      }
    } else {
      size = WIDTH_OVERRIDES.get(id) ?? (kind === 'byte' ? 1 : kind === 'word' ? 2 : 4);
    }

    if (p + size > end) {
      throw new FlpParseError(
        `event ${id} at offset ${offset} claims ${size} bytes but only ${end - p} remain`,
      );
    }

    events.push({ id, kind, offset, data: buf.subarray(p, p + size) });
    p += size;
  }

  return events;
}

/**
 * Decodes a text-event payload.
 *
 * FL Studio 12+ writes text events as UTF-16LE; older versions used single-byte
 * ASCII, and the version event (199) stays ASCII even in current versions. We
 * sniff rather than trust the header, since one wrong guess yields mojibake
 * that would silently poison sample paths.
 */
export function decodeText(data: Buffer): string {
  if (data.length === 0) return '';
  const utf16 = data.length >= 2 && data.length % 2 === 0 && data[1] === 0x00;
  const s = utf16 ? data.toString('utf16le') : data.toString('latin1');
  return s.replace(/\0+$/, '');
}
