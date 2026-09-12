# scripts/

One-off spikes, kept as the evidence trail behind parser decisions. Each has its
own throwaway event walker on purpose — they are meant to be run against real
`.flp` files without depending on `src/`, so they stay valid even if the parser
changes underneath them.

- `dump-events.mjs <flp>` — walk the raw event stream, print an ID histogram.
  `VERBOSE=1` prints every event.
- `align.mjs <flp>` — compares parses started at two offsets. This is what
  surfaced the one-byte desync in FL 25 files.
- `validate-rule.mjs <flp...>` — checks the event-172 width override against a
  corpus: stream must terminate exactly on the chunk boundary and channel
  counts must match the header.
- `sweep.mjs <flp...>` — runs the real CLI over many projects and prints a
  one-line plausibility summary each.
