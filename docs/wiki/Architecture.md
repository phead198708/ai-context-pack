# Technical Architecture — AI Context Pack

## 1. Accepted baseline

- React Native 0.86, React 19, TypeScript strict, Hermes, React Native New Architecture.
- Expo SDK 57 modules may be used in an existing React Native project.
- The repository commits and owns `ios/` and `android/`; native projects are production source.
- iOS/iPadOS 16.4+, Android API 24+, Android compileSdk/targetSdk 36.
- Swift and Kotlin native adapters use Expo Modules API unless a lower-level Turbo Module/C++ requirement is approved by ADR.
- No Expo Go. Development builds and release builds are required for native integration testing.
- No developer backend, cloud OCR, remote LLM, or content analytics in MVP.

Decision records: [ADR-0001](../adr/0001-react-native-cross-platform.md) and [ADR-0003](../adr/0003-v0.1-virtual-device-verification.md).

## 2. Architectural principle

React Native owns product behavior that should remain identical across platforms. Native code owns OS entry points and resource-sensitive processing.

The JS/native boundary passes file URIs, versioned manifests, structured results, progress, cancellation, and stable error codes. It must not pass complete image/PDF byte arrays or user content through logs.

## 3. Repository and module boundaries

### React Native application

- `src/app`: composition, navigation, lifecycle, dependency wiring.
- `src/domain`: ContextPack, ContextItem, RiskFinding, ExportRecord, state machines, errors, schemas.
- `src/features`: inbox, editor, privacy review, preview, export, settings.
- `src/infrastructure`: repositories, SQLite migrations, file abstractions, native adapters.
- `src/ui`: design tokens and accessible shared components.

The domain layer must not import React Native UI or native modules directly.

### Native entry points

#### iOS Share Extension

Reads NSItemProvider values, validates types, copies content atomically into an App Group Inbox, writes ImportManifestV1, reports the result, and exits quickly.

It does not start React Native, OCR, render PDF, compress images, detect sensitive data, export, or attempt unsupported automatic opening of the containing app.

#### Android share receiver

Handles ACTION_SEND and ACTION_SEND_MULTIPLE, reads through ContentResolver, copies every accepted content URI into the app-private Inbox while permission is valid, writes ImportManifestV1, and routes the main application to import preview.

### Native processing modules

- `ContextOCR`: Vision on iOS; ML Kit v2 on Android.
- `ContextPDF`: PDFKit on iOS; PdfRenderer with OCR fallback on Android.
- `ContextImage`: large-image decode, perceptual hash, flatten redactions, controlled compression.
- `ContextExport`: platform PDF rendering and native archive/share operations where required.

Each module accepts controlled file URIs and returns a versioned DTO. Platform engines may differ; contracts and privacy guarantees may not.

## 4. Data and storage

- SQLite stores metadata, migrations, checkpoints, references, decisions, and export history.
- The file system stores originals, immutable derivatives, previews, exports, and temporary Inbox data.
- Binary content is never stored in SQLite.
- Database rows store internal IDs and relative paths, not provider URIs or development-machine absolute paths.

Logical layout:

- `Application Support/Packs/<pack-id>/originals`
- `Application Support/Packs/<pack-id>/derived`
- `Application Support/Packs/<pack-id>/exports`
- iOS: `App Group/Inbox/<ingestion-id>`
- Android: `files/Inbox/<ingestion-id>`
- `Caches/Previews`

Every import begins with an atomic, schema-versioned ImportManifestV1. Provider files are copied before permission can expire. A recovery scan is idempotent.

Production system-share ingestion is documented in [System-share ingestion](../development/system-share-ingestion.md). Both entry points preserve provider order, accept at most 20 copied items, stream through bounded buffers, detect supported bytes independently of filenames/provider MIME, compute SHA-256, and publish the full ingestion directory atomically. Failed and rejected items remain visible in the manifest with stable codes. Replaying an ingestion ID never reopens the provider.

Persistence, file ownership, migration, locking, cleanup, and replay details are fixed by [ADR-0002](../adr/0002-sqlite-file-storage-and-inbox-recovery.md).

Production persistence uses one app-lifetime Expo SQLite connection at schema v7. Repository boundaries cover Pack graphs, ordered ContextItems with durable terminal retry stages and independently expiring run claims, explicit original-release disposition, RiskFindings, ExportRecords, artifacts, recovery journals, diagnostics, quarantine records, and cleanup leases. Pack updates use optimistic revisions inside exclusive transactions; unknown newer schemas, stale revisions, relationship violations, and artifact-integrity mismatches fail closed with stable codes.

Native `ArtifactStore` implementations own streaming file publication. They accept only sandbox-controlled `file://` sources and canonical internal relative destinations, write and synchronize a `.partial`, verify byte count and SHA-256, publish by same-volume atomic rename, and synchronize the destination directory. Domain-visible artifact metadata is committed only after native verification. Existing originals and their source/media identity are immutable, and replay succeeds only for identical bytes.

At bootstrap and foreground recovery, validated Inbox manifests are processed oldest-first through one serialized production processor. SQLite commit happens before native ACK. A first app-lifetime integrity audit represents missing or mismatched files as recoverable storage divergence. Scheduled cleanup and derived/export publication share a database lifecycle lease; cleanup rechecks references transactionally, protects active recovery Pack IDs, moves unknown files to native quarantine, and purges them only after the explicit retention period. Diagnostics contain stable codes, counts, byte sizes, phases, and irreversible internal IDs—never content, filenames, provider URIs, or absolute paths.

## 5. Shared contracts

Required versioned schemas:

- ImportManifestV1
- OCRResultV1
- PDFPageExtractionV1
- PipelineCheckpointV1
- RiskFindingV1
- ExportManifestV1

Shared tests compile every structural JSON Schema and then apply the exported TypeScript semantic validator. Swift and Kotlin independently encode the same canonical fixtures, while native boundary readers mirror the semantic rules they consume. Cross-field invariants that standard JSON Schema cannot express are explicitly tested against the runtime semantic authority. Compatibility rules require readers to reject unknown breaking versions explicitly rather than guess.

Canonical documentation:

- [Shared domain, schemas, fixtures, and compatibility policy](../architecture/shared-domain-contracts.md)
- [Stable error catalog and retry/terminal/user-action semantics](../architecture/error-catalog.md)

## 6. Processing pipeline

Pack state:

`Draft → Processing → ReviewRequired | Ready → Exporting → Exported`

Any active state may enter `Failed` or `Cancelled` and resume from a consistent checkpoint.

Item stage:

`Received → Imported → Extracted → Analyzed → Reviewed → Packaged`

Rules:

- Each stage is deterministic where practical and idempotent.
- Each stage records input hash, processor/engine version, output hash, duration, and structured error.
- Failure is item-level; the Pack exposes incomplete status.
- Cancellation stops new work and preserves consistent completed artifacts.
- Heavy work runs in bounded native workers; the RN UI receives throttled progress events.
- The app checkpoints on background transition and does not promise unlimited background execution.

## 7. Platform extraction strategy

### OCR

- iOS: Apple Vision.
- Android: ML Kit v2 with bundled Latin and Chinese models.
- Results normalize coordinates to a platform-independent orientation and range.
- Golden fixtures assert contract and task-critical strings, not byte-identical engine output.

### PDF

- iOS: PDFKit embedded text, page render + Vision fallback.
- Android API 35+: PdfRenderer text contents when available.
- Android API 24–34 and scanned pages: PdfRenderer page render + ML Kit.
- MVP cap: 25 pages and 50 MB until benchmarks justify changes.
- Page processing is sequential or tightly bounded; full-document bitmaps are forbidden.

## 8. Privacy and threat model

Primary risks:

- Original sensitive content entering exports.
- Visual overlays that do not destroy underlying pixels.
- Logs, crash data, filenames, URIs, manifests, or previews leaking content.
- Malicious archive paths or filenames.
- Stale iOS App Group / Android Inbox files.
- Provider URI expiration and partial imports.
- Platform behavior diverging so one platform silently bypasses a privacy gate.

Controls:

- Redacted image exports are newly rendered and flattened by native code.
- Privacy-safe logging accepts enums, counts, byte sizes, durations, app version, engine version, and irreversible IDs only.
- Export uses an explicit reviewed artifact allowlist.
- Pending high-risk findings block normal export.
- Paths are internal-ID generated; display names are sanitized.
- Cleanup is reference-aware, recoverable, and idempotent.
- CI contains platform parity, schema, detector, and export regression tests.

## 9. Testing and CI

### Shared

- TypeScript typecheck, lint, domain/state-machine tests, schema/property tests, Markdown round-trip, detector corpus.
- React Native component tests for shared workflows.
- Identical JSON contract fixtures for both platforms.

### iOS

- XCTest for Inbox/manifest, native adapters, redaction renderer, PDF and OCR fixtures.
- Build main app and Share Extension on macOS CI.
- Simulator host matrix: Photos, Files, Safari where available in the named runtime.

### Android

- JUnit/instrumentation tests for Inbox/manifest, native adapters, URI permission loss, redaction, PDF and OCR fixtures.
- Linux CI builds debug app and runs unit tests.
- Emulator host matrix: Photos/Google Photos, Files, Chrome where available in the named system image.

### End to end

- One image, multiple images, PDF, text, URL, unsupported content, duplicate import, interruption/restart.
- Virtual-device matrix includes iOS 16.4/current Simulator runtimes and Android API 24/35/36 Emulator/AVD profiles; v0.1 does not require physical hardware.
- Performance matrix records time, peak memory where available, output size, cancellation, and low-disk behavior with the virtual profile and host identified. Thermal, battery, camera, sensor, unavailable host-app, and store-install limitations are reported explicitly rather than inferred from the virtual environment.
- VoiceOver/TalkBack, font scaling, localization, airplane mode, lifecycle, interruption, install/upgrade/delete, and low-resource scenarios use Simulator/Emulator controls or deterministic injection when supported.
- Store readiness uses signed store artifacts plus App Store Connect/TestFlight and Google Play upload, processing, metadata, policy, and track evidence. Separate Release-configured Simulator/Emulator artifacts cover supported install/upgrade/delete flows; a physical TestFlight or Play installation is outside v0.1 acceptance.

## 10. Dependency discipline

- Pin dependencies and commit the lockfile.
- Use `npx expo install` for compatible Expo/RN packages and run Expo Doctor after dependency changes.
- Every new native dependency requires compatibility, maintenance, license, privacy, size, and New Architecture review.
- Do not use an unmaintained share-extension wrapper for a core system entry point.
- Do not use Expo's experimental incoming iOS share behavior as a product dependency.
- Do not run `expo prebuild --clean` over hand-maintained native targets without an approved ADR and reproducible migration proof.

## 11. Open decisions owned by Phase 0

- Validate committed-native-project workflow and upgrade procedure.
- Validate App Group and Android Inbox recovery with identical manifest contracts.
- Benchmark Android PDF OCR fallback.
- Select native ZIP implementation after security/license review.
- Confirm token estimator approach.
- Define release signing without committing team IDs or credentials.
