# Issue #3 native-boundary and PDF feasibility evidence

## Boundary

`src/domain` owns versioned TypeScript DTOs and validation without importing React Native. `NativeAdapter` accepts controlled local file URIs and returns DTOs. The `ContextNative` local Expo module implements the boundary in Swift and Kotlin under the New Architecture. Images and PDFs never cross the bridge as byte arrays.

The iOS Share Extension accepts one image, resolves the selected UTI to a MIME type, copies at most 50 MB to the App Group Inbox with rollback on any failure, writes a minimal manifest atomically, reports success/failure, and exits. It does not launch React Native or attempt to open the containing app. Android performs the same bounded, transactional copy on background I/O while the shared content URI is valid and then routes through the single-task main activity. Heavy OCR/PDF work is available only from the main application adapter.

Both platforms build imports under an Inbox-adjacent staging root, publish the completed ingestion directory atomically only after its manifest is durable, and leave the discoverable Inbox free of live partial writes. Native scanners preserve fresh staging transactions for active writers; when a staging or legacy incomplete transaction is at least 24 hours old, they remove it and throw `INBOX_RECOVERY_REQUIRED` instead of reporting an empty Inbox. They also fail closed when a manifest is unreadable, malformed, points outside the application-owned Inbox, claims a copied file that is missing or has a different byte count, or when Inbox traversal is partial. iOS distinguishes a genuinely absent Inbox from an unavailable App Group. The TypeScript boundary independently validates schema version, timestamps, MIME types, owned local-file URI shape, non-negative safe-integer byte counts, and finite OCR metrics before exposing a DTO. Valid manifests are ordered by creation time with a stable ingestion-ID tie-breaker. Android prefers the provider-resolved concrete MIME, rejects shares without a usable image MIME or stream, converts provider failures to stable errors, durably queues the latest completion result for cold-start JavaScript consumption, and neutralizes accepted share intents to prevent task-restoration duplicates. A generation gate and failure latch prevent both older scans and subsequent lifecycle refreshes from overwriting share failures. iOS Vision receives the source image's EXIF orientation.

## PDF feasibility

- iOS opens a local file using PDFKit, rejects files above 50 MB or 25 pages, counts pages with embedded text, and marks remaining pages for sequential render plus Vision fallback.
- Android opens a local file with `PdfRenderer`, rejects files above 50 MB or 25 pages, uses `PdfRenderer.Page.getTextContents()` on API 35+ to count embedded-text pages, and marks only pages without embedded text for sequential render plus bundled ML Kit fallback. API 24–34 marks every page for page rendering because the platform has no embedded-text API.
- The spike never retains full-document bitmaps. Production extraction, page checkpoints, cancellation, corrupted/encrypted classification, and benchmarks across the supported API/device matrix remain Issue #11.

Synthetic one-page text and scanned fixtures are stored under `fixtures/`. `PdfProbeInstrumentedTest` runs both fixtures on API 35+ and proves the text page is classified as embedded while the scanned page is classified for rendered fallback. The expected MVP bounds are 25 pages and 52,428,800 bytes.

## Privacy-safe diagnostics

Normal logs may contain only event names, stable error codes, counts, byte sizes, durations, versions, engine identifiers, and irreversible IDs. They must not contain imported text, OCR output, filenames, URLs, provider URIs, or fixture text. Native import/OCR code emits no normal logs.

## Dependency review

| Dependency                     | Pin / source                  | Purpose                             | Architecture / maintenance                          | License              | Privacy, size, and platform impact                                                 |
| ------------------------------ | ----------------------------- | ----------------------------------- | --------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| React Native                   | 0.86.2                        | Shared runtime                      | New Architecture baseline, maintained by Meta       | MIT                  | Hermes/native runtime on both platforms; no content network path                   |
| Expo                           | 57.0.12                       | Modules API, CLI, autolinking       | SDK 57 supports RN 0.86; maintained by Expo         | MIT                  | Adds local module infrastructure on both platforms                                 |
| @expo/cli / metro-config       | 57.0.14 / 57.0.8              | Exact local build / lock entry pins | Maintained SDK 57 tooling; dev / optional lock pin  | MIT                  | Consumed through Expo; no app-binary or imported-content runtime path              |
| @aicp/image-size security fork | upstream 1.2.1 + local guards | Metro repository-asset dimensions   | CommonJS 1.x compatibility; replace on upstream fix | MIT                  | Approximately 236 KB in-tree; build-only, no native binary, network, or permission |
| React Native Community CLI     | 20.2.0                        | Native development commands         | RN 0.86-compatible maintained patch line            | MIT                  | Development-only; no release binary or content network path                        |
| uuid (xcode-scoped override)   | 11.1.1                        | Patched Xcode project identifiers   | Maintained release; scoped to xcode build tooling   | MIT                  | Removes the vulnerable uuid 7 tool path; no app runtime or product permission      |
| expo-dev-client                | 57.0.11                       | Development builds                  | Maintained SDK module, New Architecture compatible  | MIT                  | Debug-only workflow; no release core dependency on Expo Go                         |
| expo-status-bar                | 57.0.1                        | Shared status-bar UI                | Maintained SDK module                               | MIT                  | Negligible; no content access                                                      |
| react-native-safe-area-context | 5.7.0                         | Safe layout                         | Maintained, New Architecture compatible             | MIT                  | Small native/UI dependency on both platforms                                       |
| ML Kit text recognition        | 16.0.1 Latin + Chinese        | Offline Android OCR spike           | Current Google bundled v2 artifacts                 | Google APIs terms    | Roughly 4 MB per bundled script/architecture; no model download or content upload  |
| Vision / PDFKit / PdfRenderer  | Platform SDK                  | Offline OCR/PDF probe               | OS-supported APIs                                   | Platform SDK terms   | No third-party binary; device-local content processing                             |
| AndroidX Test runner / JUnit   | 1.7.0 / 1.3.0 / 4.13.2        | Native regression and fixture tests | Test-only maintained AndroidX/JUnit tooling         | Apache-2.0 / EPL-1.0 | Debug-test dependency only; no release binary or content network path              |

No archive/share wrapper, remote service, analytics SDK, or experimental incoming-share package is added.

`npm run audit:ci` first verifies the complete local `@aicp/image-size` tree, its Metro/lock topology, and timeout-bounded ICNS/JXL/HEIF denial-of-service regressions, then requires zero npm findings at every severity with zero exceptions. `docs/development/ci.md` records the exact patch, dependency impact, controls, and upstream-removal trigger. The React Native CLI 20.2.0 compatible patch removes the former `fast-xml-parser` path, while the xcode-scoped `uuid` 11.1.1 override removes the former UUID advisory without adding a runtime dependency.
