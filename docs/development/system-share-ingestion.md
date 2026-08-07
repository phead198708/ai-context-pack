# System-share ingestion

Issue #8 replaces the single-image spike with production multi-item receivers. The iOS Share Extension and Android share Activity have the same durable boundary: each provider value is copied while its permission is valid, byte-validated, hashed, and represented in one ImportManifestV1. Provider URIs and display filenames are never persisted.

## Supported inputs and limits

| Input   | Detected durable media types                                 | Per-item limit |
| ------- | ------------------------------------------------------------ | -------------: |
| Image   | PNG, JPEG, GIF, BMP, TIFF, WebP, HEIC/HEIF, AVIF             |         50 MiB |
| PDF     | `application/pdf` with a PDF header in the first 1,024 bytes |         50 MiB |
| Text    | strict UTF-8 without binary control characters               |          1 MiB |
| Web URL | strict UTF-8 HTTP(S) URL with a host                         |          1 MiB |

One share copies at most 20 items. Items 21 through 128 are recorded as failed manifest items with `IMPORT_SIZE_LIMIT_EXCEEDED`; they are not silently omitted. A payload above the 128-item manifest bound rejects the whole transaction with that same stable code instead of allocating or publishing a truncated manifest. An unsupported detected type uses `IMPORT_TYPE_UNSUPPORTED`. Provider read loss uses `IMPORT_PROVIDER_PERMISSION_EXPIRED`, and other streaming failures use `IMPORT_COPY_FAILED`.

The declared provider MIME type is only a compatibility hint. Copied bytes must independently detect as a supported type, and a concrete declared type must agree with the detected type. MIME metadata is limited to 127 ASCII characters at collection, writing, schema, and native/shared validation boundaries; an absent, malformed, wildcard, or oversized hint becomes `application/octet-stream` and may resolve to any supported detected type. URL query values and imported text never enter diagnostics or logs.

## Atomic publication

1. Acquire the cross-process per-ingestion writer lock.
2. Create `InboxStaging/<ingestion-id>` below the application-owned container.
3. Stream each provider value through a 64 KiB buffer into `<item-id>.partial`, enforcing the limit while computing SHA-256.
4. Detect the copied bytes and rename accepted items to `<item-id>.bin`; record rejected/failed items without a path.
5. Synchronize `manifest.partial`, atomically rename it to `manifest.json`, then atomically rename the whole ingestion directory into `Inbox/<ingestion-id>`. That final rename is the visibility commit point; the parent directory is synchronized afterward, but a post-rename synchronization failure is reconciled as the already-visible committed import rather than falsely reporting failure.
6. Release provider access and writer ownership. The main application uses the existing oldest-first recovery/ACK transaction.

The production manifest reader rechecks item identity, order, path confinement, byte count, SHA-256, aggregate status, and the exact domain error catalog. Replaying the same ingestion ID reads the already-published manifest without reopening the provider. A process death before the final directory rename cannot expose a committed half-manifest; the existing recovery scanner owns abandoned staging cleanup.

## Platform entry points

### iOS/iPadOS

`ShareViewController` flattens `NSExtensionItem` attachments in host order and loads one representation at a time. It requests a temporary file representation for text, web URLs, and generic data, so untrusted `Data`/`String` values are never materialized in extension memory before the streaming limit. A `public.file-url` is loaded only as a strongly typed `NSURL` and its target bytes are streamed immediately; arbitrary object/data fallbacks are rejected. Activation rules expose up to 20 images/files/web URLs plus plain text. The extension only validates, copies, hashes, publishes the manifest, and displays accepted/rejected/failed counts. It does not start React Native, open the containing app, OCR, render PDF pages, compress, detect secrets, redact, or export.

### Android

`MainActivity` accepts `ACTION_SEND` and `ACTION_SEND_MULTIPLE`. ClipData values retain host order, then `EXTRA_STREAM` values are appended in list order. Occurrence counts remove only copies mirrored across the two carriers; intentional duplicate URIs within the authoritative host list remain distinct manifest items. Distinct text follows the URI values under the same mirror rule. ContentResolver streams are opened only inside the process-global serialized importer while temporary grants are valid. Each ingestion also holds a cross-process writer lock; a caller that times out before acquiring that lock never removes the active writer's staging directory. The Activity replaces its retained launch Intent with `ACTION_MAIN`, and only application-owned Inbox paths survive. A durable share-result event causes the React Native workflow to scan and open the import preview.

## Reproducible virtual host checks

Use synthetic fixtures only. Record the exact simulator/runtime or AVD/API, host macOS/toolchain, app configuration, accepted/rejected/failed counts, elapsed time, peak memory when available, and missing host capability.

### iOS Simulator

1. Install a clean Debug build containing `ShareExtension.appex` on the named Simulator.
2. From available Photos, Files, and Safari paths, share a single image, 20 images, a PDF, plain text, and an HTTP(S) URL.
3. Include a mixed/unsupported Files share when the runtime exposes it.
4. Confirm the extension count summary, then launch the containing app manually and verify the same ordered preview/import.
5. Inspect the App Group Inbox: only generated UUID directory/file names, final `.bin` artifacts, and one valid manifest may be visible.

The Simulator may lack a particular host application or multi-select share integration. Record that exact limitation; do not mark the unavailable path as passed.

### Android Emulator

1. Install a clean Debug APK on the named AVD.
2. Exercise Photos/Files/Chrome share paths for one image, 20 images, PDF, text, URL, mixed/unsupported input, and repeated delivery.
3. Confirm the app opens the import preview with accepted/rejected/failed counts and ordered media types.
4. Revoke or allow the source grant to expire after publication, restart the app, and verify the import remains readable from the app-private Inbox.
5. Confirm no provider URI, filename, query value, or content appears in logcat.

Host packages vary by system image. Missing Google Photos/Chrome or unavailable multi-select integrations remain named virtual-environment limitations under ADR-0003.

## Issue #8 virtual verification record

Verification on 2026-08-07 used synthetic content only and did not use a physical device.

- iOS: iPhone 16 Simulator on iOS 18.1 exercised image, PDF, plain-text, and HTTP(S) URL host flows through the available Photos, Files, and Safari share paths. The extension published an App Group manifest and the containing app opened the matching import preview. A clean generic Simulator build produced both `AIContextPack.app` and its embedded `ShareExtension.appex`; both products contained `arm64` and `x86_64` slices and passed strict signature verification. The committed application and extension entitlements use the same App Group. The Simulator environment did not expose every mixed/multi-select host combination, so 20-item, unsupported-item, replay, interruption, and expired-provider cases are additionally enforced by Swift contract tests; the expiry case now invokes a failing `NSItemProvider` file-representation entry path rather than injecting only an error code.
- iOS extension memory: after a synthetic file-backed Simulator host share, the actual `AIContextPack.app/PlugIns/ShareExtension.appex/ShareExtension` process was measured with `footprint --pid <pid> --format bytes --noCategories`: footprint 31,607,304 bytes, `phys_footprint` 31,623,688 bytes, and peak `phys_footprint` 35,129,912 bytes. This is real extension-process evidence, distinct from the macOS package stress harness below. Photos accepted a selection of 20 synthetic 5,243,018-byte BMP files, but its bottom share action was not exposed to the Simulator automation accessibility tree, so the final 20-photo host tap remains a named manual Simulator check rather than a claimed pass.
- Android: Pixel 9 Pro AVD on API 35 exercised an image from Photos, a PDF from Files, and an HTTP(S) URL from Chrome. The app opened the import preview after each share, and only the copied app-private Inbox artifacts were required after provider access ended. The Files UI did not expose a pure-text share action in this AVD; text ingestion is covered by collector/writer instrumentation and shared contract tests.
- Automated native evidence: Swift Package Manager passed 88 tests. An isolated 20-by-5-MiB ingestion benchmark copied 100 MiB in 384 ms with a reusable 64 KiB input buffer and 1,654,808 bytes of sampled physical-footprint growth. The benchmark samples current `TASK_VM_INFO.phys_footprint` at ingestion checkpoints; it does not subtract process-lifetime high-water marks, which can conceal growth when earlier tests already raised the baseline. Android passed 43 JVM tests and reported 88 instrumentation tests on `Pixel_9_Pro(AVD) - 15`, with zero failures/errors and one API-conditioned PDF fallback test skipped on API 35. The full Android app/native unit, lint, and Debug build invocation completed 631 Gradle tasks successfully.
- Shared evidence: format, lint, strict TypeScript, 16 Jest suites/466 tests, 21 schema fixtures, persistence migrations, production persistence, workflow security, and the 20-case v0.1 structured-policy suite passed. `npm audit --audit-level=high` exited zero with no high/critical finding. Expo Doctor passed 18/19 checks; its only failure was the external compatibility metadata expecting `expo ~57.0.11` while the repository intentionally remains pinned to `57.0.10` in this issue.
