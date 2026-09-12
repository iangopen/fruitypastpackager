/**
 * Minimal FLP reader: header fields, channel list, pattern list with note counts.
 *
 * This is a reader, not a round-tripper. We interpret only the events listed in
 * `EventId` below and skip everything else generically (see ./events.ts).
 */

import { readFileSync } from 'node:fs';
import { FlpParseError, decodeText, readEvents } from './events.js';

/** Event IDs this reader interprets. Everything else is skipped. */
const EventId = {
  ChanEnabled: 0,
  TimeSigNumerator: 17,
  TimeSigDenominator: 18,
  ChanType: 21,
  NewChan: 64,
  NewPattern: 65,
  LegacyTempo: 66,
  FineTempo: 156,
  TextChanNameLegacy: 192,
  TextPatternName: 193,
  TextTitle: 194,
  TextComment: 195,
  TextSampleFileName: 196,
  TextVersion: 199,
  TextPluginName: 201,
  TextProjectPath: 202,
  TextChanName: 203,
  PatternNotes: 224,
} as const;

/** Bytes per note struct inside a PatternNotes (224) blob. */
const NOTE_STRUCT_SIZE = 24;

/**
 * FL's channel type byte (event 21). Sample-based types (Sampler, AudioClip)
 * are the ones that carry a real audio file; plugin generators carry opaque
 * plugin state instead.
 */
const CHANNEL_TYPES = ['Sampler', 'Hybrid', 'GeneratorPlugin', 'Layer', 'AudioClip', 'Automation'];

function channelTypeName(t: number | undefined): string {
  if (t === undefined) return 'Unknown';
  return CHANNEL_TYPES[t] ?? `Unknown(${t})`;
}

export interface FlpChannel {
  id: number;
  name: string | null;
  type: string;
  typeId: number | null;
  /** Raw, unresolved path exactly as stored (may contain %FLStudioFactoryData% etc.). */
  samplePath: string | null;
  pluginName: string | null;
}

export interface FlpPattern {
  id: number;
  name: string | null;
  noteCount: number;
}

export interface FlpProject {
  file: string;
  header: {
    formatVersion: number;
    channelCountInHeader: number;
    ppq: number;
  };
  flVersion: string | null;
  flVersionBuild: number | null;
  title: string | null;
  comment: string | null;
  projectPath: string | null;
  tempo: number | null;
  timeSignature: { numerator: number; denominator: number } | null;
  channels: FlpChannel[];
  patterns: FlpPattern[];
  stats: {
    eventCount: number;
    /** Event IDs seen but not interpreted, with occurrence counts. */
    unhandledEventIds: Record<number, number>;
  };
  warnings: string[];
}

/** Splits the file into its FLhd header and the FLdt data-chunk bounds. */
function readChunks(buf: Buffer, warnings: string[]) {
  if (buf.length < 22) throw new FlpParseError('file too short to be an .flp');
  if (buf.toString('latin1', 0, 4) !== 'FLhd') throw new FlpParseError('missing FLhd magic');

  const headerSize = buf.readUInt32LE(4);
  if (headerSize !== 6) warnings.push(`unexpected FLhd size ${headerSize} (expected 6)`);

  const formatVersion = buf.readInt16LE(8);
  const channelCountInHeader = buf.readUInt16LE(10);
  const ppq = buf.readUInt16LE(12);

  const dataStart = 8 + headerSize;
  if (buf.toString('latin1', dataStart, dataStart + 4) !== 'FLdt') {
    throw new FlpParseError(`missing FLdt magic at offset ${dataStart}`);
  }
  const dataSize = buf.readUInt32LE(dataStart + 4);
  const eventsStart = dataStart + 8;
  let eventsEnd = eventsStart + dataSize;

  if (eventsEnd > buf.length) {
    warnings.push(`FLdt claims ${dataSize} bytes but only ${buf.length - eventsStart} present`);
    eventsEnd = buf.length;
  } else if (eventsEnd < buf.length) {
    warnings.push(`${buf.length - eventsEnd} trailing bytes after FLdt chunk`);
  }

  return { formatVersion, channelCountInHeader, ppq, eventsStart, eventsEnd };
}

export function parseFlpBuffer(buf: Buffer, file: string): FlpProject {
  const warnings: string[] = [];
  const { formatVersion, channelCountInHeader, ppq, eventsStart, eventsEnd } = readChunks(
    buf,
    warnings,
  );

  const events = readEvents(buf, eventsStart, eventsEnd);

  const project: FlpProject = {
    file,
    header: { formatVersion, channelCountInHeader, ppq },
    flVersion: null,
    flVersionBuild: null,
    title: null,
    comment: null,
    projectPath: null,
    tempo: null,
    timeSignature: null,
    channels: [],
    patterns: [],
    stats: { eventCount: events.length, unhandledEventIds: {} },
    warnings,
  };

  // FL's stream is sectional and order-dependent: a NewChan/NewPattern event
  // opens a context, and the events that follow describe that channel/pattern
  // until the next context-opening event. Patterns are written before channels,
  // and a pattern is revisited later (notes in one pass, name in another), so
  // patterns are keyed by id and merged rather than appended.
  let currentChannel: FlpChannel | null = null;
  let currentPattern: FlpPattern | null = null;
  const patternsById = new Map<number, FlpPattern>();
  const handled = new Set<number>(Object.values(EventId));

  // Trailing events after the last channel (mixer inserts, playlist) still fall
  // inside that channel's open context, so a field is only taken once: the
  // first occurrence within a context is the one that belongs to it.
  const setOnce = (ch: FlpChannel, key: 'name' | 'samplePath' | 'pluginName', value: string) => {
    if (ch[key] === null) ch[key] = value;
  };

  let numerator: number | null = null;
  let denominator: number | null = null;

  for (const ev of events) {
    const { id, data } = ev;
    if (!handled.has(id)) {
      project.stats.unhandledEventIds[id] = (project.stats.unhandledEventIds[id] ?? 0) + 1;
      continue;
    }

    switch (id) {
      case EventId.NewChan: {
        currentPattern = null;
        currentChannel = {
          id: data.readUInt16LE(0),
          name: null,
          type: 'Unknown',
          typeId: null,
          samplePath: null,
          pluginName: null,
        };
        project.channels.push(currentChannel);
        break;
      }

      case EventId.NewPattern: {
        currentChannel = null;
        const patId = data.readUInt16LE(0);
        let pat = patternsById.get(patId);
        if (!pat) {
          pat = { id: patId, name: null, noteCount: 0 };
          patternsById.set(patId, pat);
        }
        currentPattern = pat;
        break;
      }

      case EventId.PatternNotes: {
        if (!currentPattern) {
          warnings.push(`note block of ${data.length} bytes outside any pattern context`);
          break;
        }
        if (data.length % NOTE_STRUCT_SIZE !== 0) {
          warnings.push(
            `pattern ${currentPattern.id}: note blob ${data.length} bytes is not a multiple of ${NOTE_STRUCT_SIZE}`,
          );
        }
        currentPattern.noteCount += Math.floor(data.length / NOTE_STRUCT_SIZE);
        break;
      }

      case EventId.TextPatternName:
        if (currentPattern && currentPattern.name === null) currentPattern.name = decodeText(data);
        break;

      case EventId.ChanType:
        if (currentChannel && currentChannel.typeId === null) {
          currentChannel.typeId = data[0] ?? null;
          currentChannel.type = channelTypeName(data[0]);
        }
        break;

      case EventId.TextChanName:
        if (currentChannel) setOnce(currentChannel, 'name', decodeText(data));
        break;

      case EventId.TextChanNameLegacy:
        // In FL 12+ this ID carries the project's version banner instead; only
        // treat it as a channel name when a channel context is actually open.
        if (currentChannel) setOnce(currentChannel, 'name', decodeText(data));
        break;

      case EventId.TextSampleFileName:
        if (currentChannel) setOnce(currentChannel, 'samplePath', decodeText(data));
        break;

      case EventId.TextPluginName:
        // An empty payload is still this channel's own event, and claiming the
        // slot is what stops a later mixer-effect name from being attributed here.
        if (currentChannel) setOnce(currentChannel, 'pluginName', decodeText(data));
        break;

      case EventId.FineTempo:
        // Stored in millibeats-per-minute.
        project.tempo = data.readUInt32LE(0) / 1000;
        break;

      case EventId.LegacyTempo:
        if (project.tempo === null) project.tempo = data.readUInt16LE(0);
        break;

      case EventId.TimeSigNumerator:
        if (numerator === null) numerator = data[0] ?? null;
        break;

      case EventId.TimeSigDenominator:
        if (denominator === null) denominator = data[0] ?? null;
        break;

      case EventId.TextVersion:
        project.flVersion = decodeText(data);
        break;

      case EventId.TextTitle:
        if (project.title === null) {
          const t = decodeText(data);
          project.title = t.length > 0 ? t : null;
        }
        break;

      case EventId.TextComment:
        if (project.comment === null) {
          const c = decodeText(data);
          project.comment = c.length > 0 ? c : null;
        }
        break;

      case EventId.TextProjectPath:
        if (project.projectPath === null) project.projectPath = decodeText(data);
        break;

      default:
        // ChanEnabled and friends: recognised, deliberately not modelled yet.
        break;
    }
  }

  if (numerator !== null && denominator !== null) {
    project.timeSignature = { numerator, denominator };
  }

  const build = project.flVersion?.split('.').at(-1);
  project.flVersionBuild = build !== undefined && /^\d+$/.test(build) ? Number(build) : null;

  project.patterns = [...patternsById.values()].sort((a, b) => a.id - b.id);

  // An empty plugin name was only ever a marker to stop a later mixer-effect
  // name claiming the slot; it is not information worth reporting.
  for (const ch of project.channels) {
    if (ch.pluginName === '') ch.pluginName = null;
  }

  // Structural sanity checks: these are how we know the generic walk stayed in
  // sync, since a desynchronised stream produces nonsense counts.
  if (project.channels.length !== channelCountInHeader) {
    warnings.push(
      `header declares ${channelCountInHeader} channels but stream contains ${project.channels.length}`,
    );
  }
  if (project.tempo === null) warnings.push('no tempo event found');
  if (project.timeSignature === null) warnings.push('no time signature events found');

  return project;
}

export function parseFlpFile(path: string): FlpProject {
  return parseFlpBuffer(readFileSync(path), path);
}
