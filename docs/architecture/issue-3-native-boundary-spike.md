# Issue #3 native-boundary and PDF feasibility evidence

## Boundary

`src/domain` owns versioned TypeScript DTOs and validation without importing React Native. `NativeAdapter` accepts controlled local file URIs and returns DTOs. The `ContextNative` local Expo module implements the boundary in Swift and Kotlin under the New Architecture. Images and PDFs never cross the bridge as byte arrays.

The iOS Share Extension accepts one image, copies it atomically to the App Group Inbox, writes a minimal manifest, reports success/failure, and exits. It does not launch React Native or attempt to open the containing app. Android performs the same bounded copy while the shared content URI is valid and then routes through the single-task main activity. Heavy OCR/PDF work is available only from the main application adapter.

## PDF feasibility

- iOS opens a local file using PDFKit, rejects files above 50 MB or 25 pages, counts pages with embedded text, and marks remaining pages for sequential render plus Vision fallback.
- Android opens a local file with `PdfRenderer`, rejects files above 50 MB or 25 pages, uses `PdfRenderer.Page.getTextContents()` on API 35+ to count embedded-text pages, and marks only pages without embedded text for sequential render plus bundled ML Kit fallback. API 24–34 marks every page for page rendering because the platform has no embedded-text API.
- The spike never retains full-document bitmaps. Production extraction, page checkpoints, cancellation, corrupted/encrypted classification, and benchmarks across the supported API/device matrix remain Issue #11.

Synthetic one-page text and scanned fixtures are stored under `fixtures/`. `PdfProbeInstrumentedTest` runs both fixtures on API 35+ and proves the text page is classified as embedded while the scanned page is classified for rendered fallback. The expected MVP bounds are 25 pages and 52,428,800 bytes.

## Privacy-safe diagnostics

Normal logs may contain only event names, stable error codes, counts, byte sizes, durations, versions, engine identifiers, and irreversible IDs. They must not contain imported text, OCR output, filenames, URLs, provider URIs, or fixture text. Native import/OCR code emits no normal logs.

## Dependency review

| Dependency                     | Pin / source           | Purpose                             | Architecture / maintenance                         | License              | Privacy, size, and platform impact                                                |
| ------------------------------ | ---------------------- | ----------------------------------- | -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| React Native                   | 0.86.2                 | Shared runtime                      | New Architecture baseline, maintained by Meta      | MIT                  | Hermes/native runtime on both platforms; no content network path                  |
| Expo                           | 57.0.9                 | Modules API, CLI, autolinking       | SDK 57 supports RN 0.86; maintained by Expo        | MIT                  | Adds local module infrastructure on both platforms                                |
| expo-dev-client                | 57.0.10                | Development builds                  | Maintained SDK module, New Architecture compatible | MIT                  | Debug-only workflow; no release core dependency on Expo Go                        |
| expo-status-bar                | 57.0.1                 | Shared status-bar UI                | Maintained SDK module                              | MIT                  | Negligible; no content access                                                     |
| react-native-safe-area-context | 5.7.0                  | Safe layout                         | Maintained, New Architecture compatible            | MIT                  | Small native/UI dependency on both platforms                                      |
| ML Kit text recognition        | 16.0.1 Latin + Chinese | Offline Android OCR spike           | Current Google bundled v2 artifacts                | Google APIs terms    | Roughly 4 MB per bundled script/architecture; no model download or content upload |
| Vision / PDFKit / PdfRenderer  | Platform SDK           | Offline OCR/PDF probe               | OS-supported APIs                                  | Platform SDK terms   | No third-party binary; device-local content processing                            |
| AndroidX Test runner / JUnit   | 1.7.0 / 1.3.0 / 4.13.2 | Native regression and fixture tests | Test-only maintained AndroidX/JUnit tooling        | Apache-2.0 / EPL-1.0 | Debug-test dependency only; no release binary or content network path             |

No archive/share wrapper, remote service, analytics SDK, or experimental incoming-share package is added.

`npm audit` currently reports no high or critical findings. Its moderate findings are transitive Expo/React Native CLI build-tool advisories (`fast-xml-parser` and `uuid` paths); they do not process imported content at runtime, and no compatible direct upgrade is available without leaving the pinned RN/Expo baseline. They remain visible for dependency-refresh work rather than being hidden with a forced, breaking upgrade.
