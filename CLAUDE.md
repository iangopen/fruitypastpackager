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

- FL Studio format version drift — event layout has changed across major FL versions; the header's format-version field must gate any version-specific parsing. Confirmed in Session 1 (see Findings Log) — this is not theoretical.
- Sample path resolution will be the most time-consuming part of the whole project, not the parser. Budget for it accordingly.
- Third-party synth preset extraction is not expected to generalize — do not sink session time into it beyond the planned spike.

## Findings log

**Session 1 (Parser):**

- **Open / unresolved — event ID 172 payload width.** ID 172 sits in the generic dword (4-byte) range by the ID-range heuristic, but at least one FL version (25.2.5) appears to write it with a narrower payload — reading it as a dword desyncs the stream by one byte, silently swallowing the project title and tempo event with no error (symptom: ~63 bogus ChanEnabled events, tempo missing). The one occurrence found so far is genuinely ambiguous: bytes `ac 01 01 00` parse identically in total length whether read as (172, 3-byte payload) or as (172, 1-byte payload) followed by (event 1, 1-byte payload) — both land on the same next offset, so this single instance cannot distinguish the two hypotheses. Do not treat this as settled. First task of Session 2 is to resolve it with cross-file evidence (see Session 2 prompt).
- **Note struct layout confirmed** (24 bytes each): position = u32 LE @ offset 0, flags = u16 LE @ offset 4, rack channel = u16 LE @ offset 6, length = u32 LE @ offset 8, key = u8 @ offset 12, velocity = u8 @ offset 20. Bytes 13–19 and 21–23 not yet decoded (likely fine pitch / mod X/Y) — decode these in Session 5 (MIDI export), not before.
- **Sample paths can carry a `%FLStudioFactoryData%`-style variable prefix.** The Session 3 resolver needs to expand this as an additional case alongside the direct/sibling/basename-index/fuzzy-match chain already planned.
- **Text event 203 (name field) can appear outside its owning channel's scope.** Current parser uses first-occurrence-wins within a context to avoid a mixer effect name leaking into the last-seen channel. Revisit if a wrong channel name shows up downstream.
- Verified against a real project (`beatbattlesecondmay132026.flp`): 18 channels, 7 patterns, tempo 134, PPQ 96, 4/4, zero warnings. Generator-plugin channels (e.g. FLEX Bass) and audio-clip channels are already distinguished correctly.
- Full-drive sweep: 26 `.flp` files found, 26 clean (channel counts match header), 0 warnings, 0 errors. Note: only one of those 26 files is known to contain event 172, and that instance is the ambiguous one above — so this sweep does not yet independently confirm the payload-width decision.

**Session 2 (Scanner + index):**

- **Event ID 172 payload width — still formally unresolved, narrowed to two candidates, proceeding on 3 bytes with a standing warning.** Cross-file sweep of **553 `.flp` files** spanning FL **10.9 → 25.2.5** (the three FL installs' demo/render-test/template corpora plus Ian's own projects):
  - Event 172 appears in **27 files, all FL 25.2.3.5164 or 25.2.5.5319**. It does not exist in any earlier version. Every one of the 27 occurrences is byte-identical: `ac 01 01 00 c0`, always in the project header between event 28 and the event-192 version banner.
  - **Exhaustive width test** (payload 0, 1, 2, 3, 4, 5, 6, and varint-prefixed, whole-file validation against: stream must terminate exactly on the `FLdt` boundary, `NewChan` count must equal the header channel count, `ChanEnabled` count must equal it too, every note blob must be a multiple of 24): **only widths 1 and 3 parse.** All others, including the generic dword rule (4) and a varint reading, fail on all 27 files. The generic ID-range rule is therefore definitively wrong for this ID.
  - **The divergence test found no divergent occurrence.** H_A (3-byte payload) and H_B (1-byte payload + a following event 1) land on the same next offset whenever the byte at +2 is byte-class, which it is in all 27 cases (`0x01`). So no file distinguishes them, and the question is not settled by direct evidence.
  - **Strong circumstantial evidence favours H_A:** event ID **1 occurs exactly zero times** across all 553 files and all 15 years of format versions. H_B requires FL to have invented a use for ID 1 at the same moment it added 172, always with payload `0x00`, always in that one header slot. H_A requires one new event. The header-slot evolution supports this reading — new IDs get inserted into that same region over time (`199,28,200…` → `199,159,28,37,200…` → `199,159,169,28,37,200…` → `199,159,169,28,172,192,37,200…`).
  - **Decision:** keep 3 bytes, hardcoded as an explicit exception to the ID-range rule in `src/parser/events.ts`. Because it is an assumption and not a proof, `FlpProject.hasEvent172` is set on any project containing it, `projects.has_event_172` records it per row, and `scan_runs.event_172_files` / `event_172_warning` record it per run — so the assumption is queryable rather than invisible. **This changes nothing about the fields we currently extract either way** (both widths produce identical downstream parses); it would only matter if 172's payload is ever decoded for meaning.
- **Crawler bug worth remembering — resolve links before queueing, not after.** Two Windows-specific traps, both of which silently *lose whole subtrees* instead of erroring:
  1. `C:\Documents and Settings` is an ACL-denied junction to `C:\Users`. Queueing the link path while recording its *resolved* path in the visited set let the junction claim `C:\Users`; the real `C:\Users` was then skipped as an already-seen duplicate, and reading the junction failed with EPERM. **Every user profile vanished from the scan** — a whole-drive run reported a confident, clean 527 files while missing all 26 of Ian's actual projects. Fix: push the resolved real path, so the dedup key and the traversal path are the same thing.
  2. OneDrive cloud-backed folders (and junctions) are **reparse points for which a `Dirent` reports `isDirectory()`, `isFile()` and `isSymbolicLink()` all false.** Anything not classifiable from the dirent must get a real `statSync` before being discarded. `C:\Users\iango\OneDrive` is one of these.
  - Lesson for later sessions: a crawl that reports zero errors is not evidence it found everything. Cross-check counts against an independent tool (`find`) when the tree matters.
- **Notes are now decoded and indexed**, using the Session 1 confirmed offsets only. The still-undecoded note bytes (13–19, 21–23) are deliberately not stored — Session 5 owns them.
- **`sample_refs` dedups on the exact raw string**, deliberately not case- or separator-normalised: normalising here would destroy evidence the resolver needs. Expect near-duplicate rows that differ only by case; that is the resolver's problem to reconcile, not the scanner's.
- Verified: full scan of `…\FL Studio\Projects` → 26 files found, 26 parsed, 0 errors, 393 channels, 61 patterns, 3098 notes, 108 distinct raw sample paths, 25 files carrying event 172. Whole-drive stress run → 104,804 directories, 46 unreadable (all EPERM system dirs), 36 symlink loops skipped, 557 files found, 554 parsed, 3 errored (deliberately corrupted fixtures), 265,208 notes, in ~80s.

**Session 3 (Resolver + content store):**

- **FL path variables resolved from FL's own config, not hardcoded.** There are **three**, not one — Session 2 only surfaced `%FLStudioFactoryData%` because Ian's own projects happen to use it plus `%FLStudioUserData%`; the wider corpus adds a legacy third. All confirmed empirically (each mapping checked by opening a real file at the expanded path):

  | variable | expands to | how |
  |---|---|---|
  | `%FLStudioFactoryData%` | `<Install path>` e.g. `C:\Program Files\Image-Line\FL Studio 2025` | registry `HKCU\Software\Image-Line\Shared\Paths\Install path` |
  | `%FLStudioData%` (legacy, pre-FL-20 projects) | `<Install path>\Data` | verified against all three installs |
  | `%FLStudioUserData%` | `<Shared data>\FL Studio` e.g. `…\Documents\Image-Line\FL Studio` | registry `…\Shared\Paths\Shared data`, then append `FL Studio` |

  Note `%FLStudioFactoryData%` paths continue with `\Data\…` while `%FLStudioData%` paths do **not** — the legacy variable already points one level deeper. Getting this backwards silently fails to resolve ~1100 refs. FL's own registry uses the variable in `BackPicFileName`, which is how the mapping was confirmed rather than guessed. Multiple FL versions coexist (21, 2024, 2025); all install roots are offered as candidates and the first that exists wins, so demo projects saved against older installs still resolve. `src/resolver/variables.ts` degrades to empty lists if the registry is absent — resolution then just loses that one strategy.
- **Resolution results.** Personal projects (26, 108 raw paths): **84.3% resolved** (91), 0 ambiguous, 15.7% unresolved (17). Whole-drive corpus (557 projects, 1433 raw paths): **98.8% resolved** (1416), 0 ambiguous, 1.2% unresolved (17 — the same ones). **Every one of the 17 was verified genuinely deleted from disk**, not a resolver failure: the only remaining trace is a Windows Recent-items `.lnk`. So the resolver found 100% of the sample files that still exist. Do not chase this number higher without first checking the file exists.
- **Which strategies actually fire.** Whole-drive: variable-expansion 95.7%, direct 2.9%, basename-index 0.2%. Personal: variable-expansion 43.5%, direct 38.9%, basename-index 1.9%. **`direct-case-insensitive`, `project-sibling` and `fuzzy-basename-size` never fired on real data** — they are implemented and typechecked but unexercised, so treat them as unproven if one starts producing results later. The predicted case-only duplicates did not materialise in this corpus; the duplication that *did* show up is variable-vs-absolute and separator drift (see below).
- **Hash: BLAKE3** (via `hash-wasm`, no native toolchain). Measured here over 64MB: xxhash64 ~7100 MB/s, sha256 ~2200 MB/s (SHA-NI), BLAKE3 ~840 MB/s. XXH64 is ~8x faster but 64-bit, and a dedup collision does not error — it silently merges two different sounds, putting the wrong sample in an exported kit. Hashing is not the bottleneck anyway (1416 files / 468 MB hashed inside an 8.4s run that also indexed 19,364 files), so the 256-bit digest is cheap insurance. Recorded in `content_files.algorithm`, so a future switch is detectable.
- **Hash-keyed usage counting materially changes the answer.** 1416 resolved raw paths collapse to **1300 distinct contents** (116 merged). `Basic 808 Kick.wav` still tops both rankings (33 projects), so the headline did not change — but the mid-table reorders, and the biggest gainer is **`Attack Shaker 10.wv`: 3 projects by best single spelling, 11 by content.** Three distinct duplication classes, all real:
  1. legacy vs current variable — `%FLStudioData%\Patches\…` and `%FLStudioFactoryData%\Data\Patches\…` are the same file;
  2. separator drift — the same variable path written with `\` in one project and `/` in another;
  3. genuinely duplicated bytes — FL copies pack samples into per-demo `Used by demo projects\<song>\` folders, so the same audio exists at two real paths.
  Class 3 is why this must be keyed on hash and not on any amount of path normalisation.
- **Zipped projects: implemented, PARTIALLY verified — the FL-specific half is untested.** **None of the 557 .flp files on this machine is a ZIP container** (all 557 begin with `FLhd`), so no genuine FL "save with all files" archive was available. What *is* verified, against a synthetic archive: the ZIP reader (central directory, stored + deflate entries), scanner detection by magic bytes rather than extension, parsing the inner .flp (18 channels / 7 patterns / 95 notes, matching the loose copy), resolving samples from inside the container, and hashing decompressed bytes — those hashes match the on-disk originals byte for byte. What is **not** verified: that FL actually lays out its archives the way assumed (one .flp at the root, samples under `Audio/`, basename matching sufficient). Ambiguity throws rather than guessing. Revisit when a real zipped project appears.
- **Schema additions are additive migrations** (`src/db/migrate.ts`), run automatically on open, because a Session 2 database holds real scan results worth keeping. New: resolver columns on `sample_refs`, plus `content_files`, `sample_manifest`, `resolve_runs`. Raw path strings are never rewritten — resolution is stored alongside them.
