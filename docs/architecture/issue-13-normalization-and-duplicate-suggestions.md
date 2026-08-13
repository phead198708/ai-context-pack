# Issue #13: normalization and duplicate suggestions

Issue #13 adds a deterministic, local-only analyze stage without changing the
Phase 1 extraction boundary.

## Versioned algorithms

- Text normalization: `text-normalization-v1` applies Unicode NFC/NFKC where
  appropriate, canonical line endings, OCR-artifact removal, bounded prose
  whitespace cleanup, repeated blank-line collapse, and wrapped-word repair.
  Fenced or code-like content keeps indentation and semantic whitespace.
- Exact duplicates: SHA-256 of immutable originals.
- Similar text: bottom-k FNV-1a 32-bit hashes over normalized five-code-point
  shingles, with a 128-hash sample and a `0.82` Jaccard threshold.
- Near images: orientation-normalized 64-bit difference hash (`dhash-64-v1`)
  over a 9×8 grayscale sample, with Hamming distance at most eight.

`DuplicateAnalysisManifestV1` records the complete detector configuration.
`ImagePerceptualHashV1` is the native parity contract. Unknown fields,
versions, algorithms, malformed hashes, and integrity mismatches fail closed.

## Durable workflow

The analyze run reads a verified extraction artifact, writes an immutable
`normalized-text` derivative, checkpoints it using the same fenced publication
lease as extraction, and atomically settles the versioned analysis record.
SQLite schema v8 rebuilds suggestions from every valid per-item record while
leaving `duplicate_decisions` untouched. This makes interruption recovery
idempotent and prevents reanalysis from erasing user intent.

Suggestions are advisory. The UI starts with every original retained and offers
Keep all, Exclude, and Preferred actions with reason, confidence, expected
savings, side-by-side metadata previews, and actual post-selection savings.
No action deletes originals; decisions only update reversible inclusion modes.

## Privacy and bounds

All processing is on-device and file-URI based. SQLite stores fingerprints,
hashes, counts, versions, and internal IDs—not extracted text, image pixels,
provider URIs, display names, or binary buffers. Native image decoding rejects
files over 50 MiB or 16 million source pixels. The v1 hasher uses integer box
averages over identical source-coordinate partitions on both platforms before
computing the 9×8 hash. iOS decodes one orientation-normalized source at a time
(at most about 64 MiB of RGBA pixels). Android decodes fixed regions of at most
one million pixels, checks cancellation between regions and rows, and never
retains the complete decoded bitmap for region-decodable formats. Formats that
require Android's whole-image fallback are decoded with a power-of-two sample
size that caps the retained bitmap at one million pixels while preserving the
accepted 16-million-source-pixel contract, and use bounded cancellable source
reads. The v0.1 Pack item cap bounds pairwise candidate comparison.

## Synthetic acceptance measurements

- The versioned corpus contains five positive and four hard-negative text/image
  pairs. At the accepted `0.82` text and eight-bit image thresholds it records
  100% precision and 100% recall; the sequential-error-screen negative remains
  unmatched.
- The exact-SHA fixture is deterministic at 100% confidence regardless of
  input order. The 20-item maximum comparison is also order-independent and
  completes within the one-second local regression budget.
- `ocr-english.png` and its EXIF-rotated JPEG counterpart both produce the
  cross-platform golden dHash `000000a810000000` in XCTest and Pixel 9 Pro API
  35 instrumentation.
- A representative synthetic prose input containing decomposed `Café`, CRLF,
  a soft wrap, zero-width OCR noise, and repeated blank lines normalizes to
  composed `Café`, LF, a rejoined word, removed noise, and at most one blank
  line. Fenced and indented code fixtures remain byte-for-byte unchanged after
  the canonical line-ending boundary.
