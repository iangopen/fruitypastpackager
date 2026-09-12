-- Drumkit Extractor index schema.
--
-- Scanning and exporting are separate phases: this database is written once per
-- scan and read many times by the exporter, so it stores what the .flp actually
-- said, not conclusions drawn from it. Anything requiring a judgement call
-- (does this sample path resolve? what category is this? what's the content
-- hash?) gets a column here but is left NULL for the session that owns it.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per invocation of `scan`. Keeps the history of runs so an incremental
-- rescan can later ask "what changed since the last run?".
CREATE TABLE IF NOT EXISTS scan_runs (
  id                INTEGER PRIMARY KEY,
  root              TEXT    NOT NULL,
  started_at        TEXT    NOT NULL,          -- ISO 8601, UTC
  finished_at       TEXT,
  status            TEXT    NOT NULL DEFAULT 'running',  -- running | completed | failed
  dirs_visited      INTEGER NOT NULL DEFAULT 0,
  dirs_errored      INTEGER NOT NULL DEFAULT 0,
  files_found       INTEGER NOT NULL DEFAULT 0,
  files_parsed      INTEGER NOT NULL DEFAULT 0,
  files_errored     INTEGER NOT NULL DEFAULT 0,
  -- Number of projects in this run that contained event ID 172, whose payload
  -- width is assumed rather than proven. See the Findings Log in CLAUDE.md.
  event_172_files   INTEGER NOT NULL DEFAULT 0,
  event_172_warning TEXT,
  notes             TEXT                        -- JSON array of run-level messages
);

-- One row per .flp file. Keyed by path so a rescan updates in place rather than
-- accumulating duplicate rows; child rows are deleted and rewritten.
CREATE TABLE IF NOT EXISTS projects (
  id                  INTEGER PRIMARY KEY,
  path                TEXT    NOT NULL UNIQUE,
  file_name           TEXT    NOT NULL,
  file_size           INTEGER NOT NULL,
  file_mtime          TEXT    NOT NULL,        -- ISO 8601, UTC
  first_seen_run_id   INTEGER NOT NULL REFERENCES scan_runs(id),
  last_seen_run_id    INTEGER NOT NULL REFERENCES scan_runs(id),

  parse_ok            INTEGER NOT NULL,        -- 0/1
  parse_error         TEXT,

  format_version      INTEGER,
  fl_version          TEXT,
  fl_version_build    INTEGER,
  ppq                 INTEGER,
  tempo               REAL,
  time_sig_numerator  INTEGER,
  time_sig_denominator INTEGER,
  title               TEXT,
  comment             TEXT,
  project_path        TEXT,

  channel_count       INTEGER,
  pattern_count       INTEGER,
  note_count          INTEGER,
  event_count         INTEGER,
  has_event_172       INTEGER NOT NULL DEFAULT 0,
  warnings            TEXT                     -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_projects_run      ON projects(last_seen_run_id);
CREATE INDEX IF NOT EXISTS idx_projects_parse_ok ON projects(parse_ok);

-- Distinct raw sample path strings, exactly as stored in the .flp.
--
-- Deduplicated on the raw string, which is deliberately case- and
-- separator-sensitive: normalising here would destroy evidence the resolver
-- needs. The resolver (a later session) fills in the resolution columns; until
-- then every row is honestly 'unresolved' rather than assumed present.
CREATE TABLE IF NOT EXISTS sample_refs (
  id                INTEGER PRIMARY KEY,
  raw_path          TEXT    NOT NULL UNIQUE,
  base_name         TEXT    NOT NULL,          -- cheap derivation, useful for the basename index later
  has_path_variable INTEGER NOT NULL DEFAULT 0, -- e.g. %FLStudioFactoryData%
  resolution_status TEXT    NOT NULL DEFAULT 'unresolved',
  resolved_path     TEXT,
  resolved_at       TEXT,
  content_hash      TEXT                        -- filled by the content store session
);

CREATE INDEX IF NOT EXISTS idx_sample_refs_base   ON sample_refs(base_name);
CREATE INDEX IF NOT EXISTS idx_sample_refs_status ON sample_refs(resolution_status);

-- One row per rack channel in a project.
CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL,              -- FL's own rack channel id
  name          TEXT,
  type          TEXT,                          -- Sampler | AudioClip | GeneratorPlugin | ...
  type_id       INTEGER,
  plugin_name   TEXT,
  sample_ref_id INTEGER REFERENCES sample_refs(id)
);

CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id);
CREATE INDEX IF NOT EXISTS idx_channels_sample  ON channels(sample_ref_id);
CREATE INDEX IF NOT EXISTS idx_channels_rack    ON channels(project_id, channel_index);

CREATE TABLE IF NOT EXISTS patterns (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pattern_index INTEGER NOT NULL,              -- FL's own pattern number
  name          TEXT,
  note_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_id);

-- Individual notes. Only the fields confirmed against real files are stored;
-- the still-undecoded bytes of the note struct (13-19, 21-23, likely fine pitch
-- and mod X/Y) are deliberately absent rather than guessed at.
CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY,
  pattern_id   INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rack_channel INTEGER NOT NULL,               -- joins to channels.channel_index
  position     INTEGER NOT NULL,               -- ticks, relative to PPQ
  length       INTEGER NOT NULL,               -- ticks
  key          INTEGER NOT NULL,               -- MIDI-style note number
  velocity     INTEGER NOT NULL,
  flags        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_pattern ON notes(pattern_id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_channel ON notes(project_id, rack_channel);

-- Directories and files the crawler could not read. Recorded rather than
-- swallowed: a run that skipped half the disk should be visible as such.
CREATE TABLE IF NOT EXISTS scan_errors (
  id          INTEGER PRIMARY KEY,
  scan_run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  path        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,                -- directory | file | parse
  message     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scan_errors_run ON scan_errors(scan_run_id);
