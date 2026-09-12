# CLAUDE.md — Drumkit Extractor

Persistent context for Claude Code sessions on this project. Read this before touching any code.

## What this is

A tool that scans every FL Studio project (`.flp`) on Ian's machine and builds organized, deduplicated drumkit folders (samples + MIDI) from what those projects actually contain. Not a VST — a standalone CLI/tool. The batch scan, resolve, and export work is a filesystem job, not a real-time audio plugin, so it never runs inside FL Studio's plugin host.

## Standing decisions (do not relitigate without discussion)

- **Language/runtime:** TypeScript on Node.js. One language across every session — no Python detour. The FLP format is skippable-event-based, so a from-scratch TS reader is the right size of effort (roughly 400–600 lines for the core reader).
- **Index and export are separate phases.** Scanning writes to a local SQLite database once; exporting reads from that database and can be re-run with different layouts without ever re-parsing a project. Never merge these into a single scan-and-write-folders pass.
- **Parser is a reader, not a round-tripper.** FLP is a flat event stream; each event's ID range tells you its payload width, so unknown events can be skipped without losing sync. We do not need to model or re-serialize the whole format — only the events listed under Parser below.
- **Source files are read-only, always.** The tool never writes into a `.flp`, a project's sample folder, or anything under Ian's existing project directories. All output goes to a separate destination tree.
- **SQLite via `better-sqlite3`** for the index (synchronous, fast, no ORM needed at this scale).
- **Hashing via a fast non-cryptographic hash** (blake3 or xxhash — pick one in the hashing session) for content-addressed dedup. Not SHA-256; we're hashing tens of thousands of files.
- **MIDI is split by channel, never one file per pattern.** A pattern contains simultaneous notes for multiple rack channels; a combined dump is useless. PPQ, tempo, and time signature come from the project header/events, not assumed defaults.
- **Classification is confidence-scored, with an explicit `Unsorted` bucket.** A wrong guess in a category folder is worse than an honest unsorted pile — never force a low-confidence sample into a category.
- **Kit/instrument export scope:** sample-based channels (Sampler, Slicex, FPC, DirectWave — anything pointing at a real audio file) are fully in scope. Third-party synth plugin state is an opaque blob tied to the exact plugin+version installed — `.fst` preset export is a spike to validate, not a committed feature, and never advertised as portable across machines.

## Architecture (build in this order — see Roadmap)

1. **Parser** — reads one `.flp`: header (format version, PPQ, tempo, time signature), channel list (id, name, type, raw sample path if applicable), pattern list with note arrays (position, length, key, velocity, rack channel, fine pitch/mod — the last two have no MIDI equivalent and get dropped or mapped to CC later).
2. **Scanner + index** — directory crawler (handles symlink loops, permission errors, slow volumes) feeding the parser, writing to SQLite. Tables: `projects`, `channels`, `patterns`, `notes`, `sample_refs`, `scan_runs`.
3. **Resolver** — turns a raw sample path string into a real file on disk. Order: direct existence check → sibling directory of the project → basename index of known sample directories → fuzzy match on basename + file size. Handles zipped "save with all files" projects (samples embedded in the container) as a second code path. Every reference gets a resolution status; never silently drop unresolved ones.
4. **Content store / dedup** — hash every resolved file, store content-addressed, keep a manifest mapping each hash to every name/path/project/channel it ever appeared under. This is also where usage-frequency ("this kick appears in 47 projects") comes from — a first-class feature, not a side effect.
5. **Exporter** — query the index, materialize a folder tree per a layout template (by-project, by-usage-rank, by-category once classification exists). Collision-safe naming, provenance sidecar JSON per file.
6. **MIDI export** — decode note structs, scale by PPQ, split by channel, write `.mid` (via a JS MIDI-writing library), inject tempo/time signature.
7. **Classifier v1** — rule-based: channel name + original filename + source folder path against keyword sets (kick/snare/hat/perc/clap/etc.), with a confidence score. Below threshold → `Unsorted`.
8. **Review UI** — minimal local web app (React, since that's the home stack) to browse `Unsorted` and correct/confirm categories. Corrections persist as overrides in SQLite and double as the labeled set for v2.
9. **Classifier v2** — adds audio features (duration, spectral centroid, low-band energy ratio, transient shape) and rhythmic-context (position within the pattern grid — a channel hit on every downbeat is a kick; dense sixteenths are a hat). This signal only exists because we have the project file, not just a folder of wavs. Evaluate against v1's human-corrected labels.
10. **Kit formats + polish** — SFZ export (plain text, playable everywhere) first; `.fst` transplant spike second, clearly marked exploratory. Then near-duplicate (not just exact-hash) detection, incremental rescan (only new/changed files since last `scan_runs` entry), and packaging.

## Session discipline

- One component per Claude Code session. Do not let a session creep into the next component even if there's time left.
- Every session ends with **real executed output** pasted back for review — a script run against an actual `.flp`, actual scan counts, actual export tree — never just `tsc --noEmit` or "it should work."
- Explore-first for anything touching the parser or resolver: confirm the actual byte layout/behavior against a real project file before writing code that assumes a layout.
- If something breaks and survives one fix attempt, diagnose before patching again.
- Git commit at the end of every session, once verification output is in hand.

## Known risk areas (flag if you hit these)

- FL Studio format version drift — event layout has changed across major FL versions; the header's format-version field must gate any version-specific parsing.
- Sample path resolution will be the most time-consuming part of the whole project, not the parser. Budget for it accordingly.
- Third-party synth preset extraction is not expected to generalize — do not sink session time into it beyond the planned spike.
