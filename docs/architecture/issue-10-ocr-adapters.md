# Issue #10 OCR adapters

## Contract and execution

`OCRResultV1` remains backward compatible with the Phase 0 fixture. Issue #10
adds optional `recognitionLevel` and `warnings` fields to the persisted V1
shape; production native results must provide both. The native boundary also
requires the full text to equal the ordered block text joined with newlines.
Bounds use normalized top-left preview coordinates and are sorted by row then
column.

`OCRTaskRunner` returns a handle immediately, emits content-free queued/decode/
recognize/terminal progress, and serializes native work to one image at a time.
Cancellation prevents queued work from starting. Apple Vision requests are
cancelled directly. ML Kit does not expose recognition-task cancellation, so
Android stops result delivery and closes the bounded recognizer after its Task
settles.

## Platform policy

| Platform | Engine                          | Bundling/readiness                                     | Modes                                             |
| -------- | ------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| iOS      | Vision revision 3               | OS framework; supported languages queried at runtime   | `accurate` default, `fast` available for previews |
| Android  | ML Kit Latin and Chinese 16.0.1 | Both recognizers bundled in the APK; no model download | `accurate`                                        |

Both adapters accept only controlled app-local regular files, reject symlinks,
and transfer only file URIs and versioned DTOs across the bridge. Normal limits
are 40 megapixels, 12,000 pixels per dimension, 50 MiB per file, 10,000 blocks,
and 1,000,000 output characters. Android lowers the pixel limit to 20
megapixels on low-RAM devices. Work is kept off the UI thread and never runs in
the iOS Share Extension.

## Acceptance thresholds

Synthetic fixtures are the only OCR content used by automated tests. Each
platform must recognize all critical English programming tokens (`TypeError`,
`E42`, and `retry import`) and both Simplified Chinese phrases (`合成测试` and
`重新导入`). Whitespace normalization is permitted; exact cross-engine text is
not required. Every non-empty result must have finite, in-range, ordered bounds.
The EXIF-oriented fixture must recognize the same critical English tokens.

Tests also cover corrupt input, oversized metadata, bounded concurrency,
cancellation, deterministic memory-pressure errors, and structured RN progress.
Recognized strings are never included as assertion messages, logs, snapshots,
artifact names, or diagnostics. Bundled Android models and the OS-local Vision
framework make the core path airplane-mode capable; virtual-device execution
evidence is recorded in the PR. Full VoiceOver and TalkBack task completion
remains a named manual virtual-device check under ADR-0003.
