# Main-app import (Issue #9)

Issue #9 adds user-initiated import from the containing React Native app. It does not add a second ingestion pipeline. Photos, documents, pasted text, and pasted HTTP(S) URLs all produce the versioned `ImportManifestV1` contract and enter the same native atomic Inbox writers, persistence handoff, Pack creation, recovery, and acknowledgement path used by system sharing.

## Data flow and ownership

1. `NewPackFlow` collects ordered selections and shows count, declared type, estimated bytes, size/type rejection, and correction controls before publication. It never renders a selected filename, pasted content, or full URL.
2. `expo-image-picker` uses the system photo picker with ordered multi-selection and a 20-item limit. `expo-document-picker` uses the platform document picker with multiple selection and `copyToCacheDirectory: true`. Only cache `file://` URIs, media type, and byte estimate cross into the draft; display names and provider identifiers are discarded.
3. Pasted text and URLs remain exact UTF-8 values in memory. URLs must have an HTTP or HTTPS scheme. The JS boundary and both native implementations independently bind kind, media type, UTF-8 byte count, UUID, order, item count, and source.
4. Native code accepts picker files only below the app cache root, rejects symbolic-link/path escapes, and immediately streams them through `ShareIngestionSession` (iOS) or `ShareIngestionWriter` (Android). The Inbox owns immutable anonymous copies after commit. Picker cache copies are removed only after a committed/replayed manifest or explicitly when the user removes/cancels a selection; a failed publish keeps them available for retry. Post-commit cleanup fails closed with `MAIN_APP_IMPORT_CLEANUP_FAILED`; retry replays the committed manifest and retries cleanup without duplicating the import.
5. A stale or revoked provider becomes a visible `IMPORT_PROVIDER_PERMISSION_EXPIRED` item. Unsupported or oversized items are visible failures; successful siblings remain committed in order. Replay uses the already-published manifest and does not reopen a provider.
6. Normal import rejects an empty input list. An intentionally empty Pack is available only through the separate **Create Empty Draft** action and is persisted directly as an empty `draft` Pack graph.

The two added manifest source values are `main-app-picker` for any selection containing a file and `main-app-text` for inline-only input. They are additive v1 enum values supported by TypeScript, JSON Schema, Swift, and Kotlin validators.

## Permission and privacy behavior

- iOS uses the system Photos/document selection UI and copies selected values into app-controlled cache before native ingestion. Limited Photos access is compatible because only explicitly returned selections are used. Security-scoped provider URLs are not stored or reused.
- Android uses the system Photo Picker and Storage Access Framework. The merged app manifest explicitly removes camera, microphone, and legacy broad storage permissions introduced by transitive manifests.
- `MainActivity` temporarily opts out of predictive-back callbacks because its existing custom ReactActivity fallback bypasses React Native `BackHandler` under target SDK 36. Compatibility back dispatch remains enabled, so hardware back can run the same cache cleanup as the visible Cancel action. Removing this activity-level opt-out requires migrating that native fallback to a supported predictive-back callback first.
- Import is local-only and requires no backend, remote AI, telemetry, or additional network request. Existing privacy-safe logging rules remain unchanged; native errors expose only stable codes.
- Cancellation creates no Pack. The visible Cancel action and Android hardware back both use the same controlled cleanup path. While selected cache files exist, global tabs and unrelated header actions are hidden, and concurrent Inbox navigation cannot unmount the flow. Cleanup must succeed before the flow exits; cleanup errors remain visible and keep the user in the flow. URI-only cleanup work for an over-limit picker result is retained in memory and retried on cancellation, so a failed first cleanup cannot silently orphan an app-cache copy.

## Stable operational codes

| Boundary           | Codes                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Draft and picker   | `IMPORT_EMPTY_TEXT`, `IMPORT_URL_INVALID`, `IMPORT_ITEM_LIMIT_EXCEEDED`, `PICKER_PERMISSION_DENIED`, `PICKER_FAILED`                     |
| Native publication | `MAIN_APP_IMPORT_INPUT_INVALID`, `PIPELINE_RECOVERY_REQUIRED`, `STORAGE_WRITE_FAILED`                                                    |
| Cleanup            | `MAIN_APP_IMPORT_CLEANUP_FAILED`, `NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED`                                                                |
| JS/native contract | `NATIVE_MAIN_APP_IMPORT_UNAVAILABLE`, `NATIVE_MAIN_APP_IMPORT_INVALID`, `NATIVE_MAIN_APP_IMPORT_RESULT_INVALID`                          |
| Per-item manifest  | `IMPORT_TYPE_UNSUPPORTED`, `IMPORT_SIZE_LIMIT_EXCEEDED`, `IMPORT_PROVIDER_PERMISSION_EXPIRED`, plus the existing v1 import error catalog |

The UI uses `MAIN_APP_IMPORT_FAILED` only as a privacy-safe fallback when an unexpected rejected value has no stable `code`; it never displays a native exception message or picker/provider path.

## Dependency review

| Dependency             | Pin            | Purpose                                                      | New Architecture and maintenance                                                                                         | License | Privacy / platform / size impact                                                                                                                                     |
| ---------------------- | -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo-image-picker`    | `57.0.8` exact | System photo multi-selection and app-cache results           | Official Expo SDK 57 module; autolinked through Expo Modules and compatible with the repository's New Architecture setup | MIT     | No remote service. Adds iOS/Android picker adapters; camera and microphone permission strings are disabled. Published package unpacked size is approximately 479 KB. |
| `expo-document-picker` | `57.0.1` exact | System document multi-selection with controlled cache copies | Official Expo SDK 57 module; autolinked through Expo Modules and compatible with the repository's New Architecture setup | MIT     | No remote service. Adds iOS UIDocumentPicker and Android SAF adapters; no broad storage permission. Published package unpacked size is approximately 120 KB.         |

Both versions match the versions bundled for Expo SDK 57. No dependency is used for the security-critical native cache-confinement or atomic publication boundary; those checks remain repository-owned Swift/Kotlin code. `package-lock.json` records the complete resolved graph for dependency review.

## Verification map

- Draft/order/preflight/UTF-8 behavior: `__tests__/mainAppImport.test.ts`
- Picker options, cancellation, permission error mapping, and metadata minimization: `__tests__/mainAppPickers.test.ts`
- RN controls, correction, cleanup, empty protection, per-item result, and accessibility state: `__tests__/NewPackFlow.test.tsx` and `__tests__/App.test.tsx`
- JS/native DTO fail-closed validation: `__tests__/nativeAdapter.test.ts`
- Explicit empty Draft persistence: `__tests__/persistenceRuntime.test.ts`
- iOS shared writer, stale provider, mixed results, replay, failed-publish retry retention, content integrity, cache cleanup, and path rejection: `MainAppImportPublisherTests.swift`
- Android parity for the same behaviors: `MainAppImportPublisherInstrumentedTest.kt`
- Manifest contract parity: shared schema/contract tests plus Swift and Kotlin production validators.

## Virtual-device evidence

- **Android:** `Pixel_9_Pro(AVD) - API 35` opened the platform Photo Picker and selected two synthetic PNG assets in order. The New Pack summary showed `2 selected`, `image/png × 2`, and both ordered item controls. Android hardware Back returned to Inbox only after both `ImagePicker` cache copies were absent. The same AVD opened `com.google.android.documentsui`; cancel returned to New Pack with `Selection canceled. No Pack or temporary item was created.`, and the app cache contained no picker file.
- **iOS:** `iPhone 16 Simulator - iOS 18.1` opened the private-access Photos picker and Files document picker. Photos returned two synthetic 5 MiB BMP assets in selection order and the New Pack summary showed `2 selected · 10.0 MB estimated` plus `image/bmp × 2`. A separate one-photo run completed through the shared native Inbox and persistence workflow as `1 accepted · 0 failed`, `image/bmp · copied`. Canceling Photos or Files created no Pack and left no picker-named file below the app cache or temporary directory.
- **Accessibility scaling:** Android font scale `2.0` and iOS largest accessibility Dynamic Type were exercised on the committed scrollable layout. Controls remained reachable by scrolling; picker, edit, Import, Cancel, Empty Draft, tabs, and result controls expose explicit accessibility roles, labels, and disabled/selected state in RN interaction tests.
- All screenshots contain only synthetic fixtures. The Draft PR evidence comment carries the representative system-picker, cancellation, result, and scaling screenshots; their SHA-256 values are recorded there so the evidence remains identifiable.

Simulator/AVD evidence must still exercise the real system picker surfaces for photos and documents, cancellation, denied/limited access, mixed inputs, correction, and restart recovery. Under ADR-0003, no physical-device evidence is required for v0.1.
