# ADR-0001: React Native cross-platform architecture

- Status: Accepted
- Date: 2026-08-01
- Decision owners: repository maintainers
- Scope: AI Context Pack v0.1

## Context

The original plan targeted an iOS/iPadOS-only Swift application. The product should cover Android without duplicating the full UI, domain model, privacy rules, and export workflow.

The application is not a simple form-based app. Its critical path includes system share entry points, large local files, OCR, PDF processing, pixel-level redaction, recovery, and strict privacy boundaries. A 100% JavaScript implementation would make several of these capabilities fragile or memory-heavy.

Expo SDK 57 provides React Native 0.86-compatible modules and New Architecture support. However, Expo's CNG app-extension support and incoming iOS share flow are documented as experimental, and the incoming iOS flow attempts to open the containing app using behavior that is not officially supported by Apple.

## Decision

Adopt a hybrid React Native architecture:

- React Native 0.86 + TypeScript strict owns shared UI, domain models, state machines, workflow orchestration, deterministic rules, and Markdown.
- Expo SDK 57 modules may be installed in the existing React Native project.
- `ios/` and `android/` are committed and maintained as production source.
- Swift/Kotlin modules own system entry points and resource-sensitive operations.
- iOS uses a native Swift Share Extension and App Group Inbox.
- Android uses native ACTION_SEND/ACTION_SEND_MULTIPLE handling and an app-private Inbox.
- iOS OCR uses Apple Vision; Android OCR uses ML Kit v2.
- iOS PDF handling uses PDFKit; Android uses PdfRenderer with OCR fallback.
- Redacted image exports are rendered and flattened natively.
- Native boundaries exchange file URIs and versioned DTOs, never complete image/PDF byte arrays.
- Incoming sharing does not depend on Expo's experimental iOS implementation.
- Expo Go is not a supported development or test environment.

## Supported baseline

- iOS/iPadOS 16.4+
- Android API 24+
- Android compileSdk/targetSdk 36
- Xcode 26.4+
- Node 22.13.x-compatible pinned Node 22 release
- React Native New Architecture and Hermes

## Consequences

Positive:

- Most product behavior and UI remain shared.
- System entry points and heavy work follow platform constraints.
- Native performance and recovery can be tested independently.
- Android becomes a first-class release target rather than a later port.

Costs:

- The team must maintain Xcode and Gradle projects.
- OCR/PDF engines can produce different results, requiring normalized contracts and platform-specific thresholds.
- CI needs macOS and Linux jobs.
- Every feature requires explicit shared/iOS/Android acceptance.
- React Native and Expo upgrades require native diff review.

## Rejected alternatives

### Native Swift first, Android later

Rejected because domain behavior, UI, privacy review, and exports would later be duplicated or rewritten.

### Pure Expo/CNG with experimental incoming sharing

Rejected for the core entry point because iOS app-extension generation and incoming-share behavior are experimental, and opening the containing app is not an Apple-supported contract.

### React Native with third-party share/OCR/PDF wrappers only

Rejected as a default because the product depends on these capabilities for privacy and data integrity. Unmaintained wrappers or bridge-heavy byte transfer are unacceptable.

### One OCR/PDF SDK on both platforms

Rejected for MVP because ML Kit OCR on iOS has significant per-script size impact, while Apple Vision/PDFKit are available locally. Platform adapters with a shared schema provide a better size/privacy tradeoff.

## Guardrails

- No `expo prebuild --clean` over hand-maintained native targets without an approved migration ADR.
- No unsupported automatic opening of the iOS containing app.
- No heavy processing inside the iOS Share Extension.
- No provider URI is treated as durable storage.
- No imported content, OCR text, filenames, URL query values, or detector matches in normal logs.
- No native dependency without New Architecture, maintenance, license, privacy, size, and security review.

## Phase 0 validation

Issue #3 must prove:

- Clean builds for iOS app, iOS Share Extension, and Android app.
- One-image share ingestion on both platforms.
- ImportManifestV1 parity.
- OCRResultV1 on both platforms.
- Android PDF fallback behavior and benchmark.
- CI, privacy-safe logging, recovery, and documented upgrade workflow.

## References

- [React Native 0.86](https://reactnative.dev/blog/2026/06/11/react-native-0.86)
- [Expo SDK support matrix](https://docs.expo.dev/versions/latest/)
- [Expo modules in an existing React Native project](https://docs.expo.dev/bare/installing-expo-modules/)
- [Expo Modules API](https://docs.expo.dev/modules/overview/)
- [Expo iOS app extensions](https://docs.expo.dev/build-reference/app-extensions/)
- [Expo Sharing](https://docs.expo.dev/versions/latest/sdk/sharing/)
- [Android receiving shared data](https://developer.android.com/training/sharing/receive)
- [ML Kit Text Recognition v2](https://developers.google.com/ml-kit/vision/text-recognition/v2)
