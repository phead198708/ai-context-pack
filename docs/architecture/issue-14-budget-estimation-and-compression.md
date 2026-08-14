# Issue #14 — budget estimation and image compression

Issue #14 adds a deterministic pre-encode budget planner in shared TypeScript and bounded native image encoders on iOS and Android. Originals remain immutable; every successful compression is published as a new `compressed-image` artifact through the existing atomic artifact coordinator.

## Shared estimator and presets

`context-budget-estimator-v1` records that all displayed token counts are estimates. It counts original source bytes, included predicted-output bytes, included images, included PDF pages, included normalized text characters, and estimated tokens. Its token heuristic is intentionally generic rather than a promise about a proprietary tokenizer:

```text
ceil(text characters / 4)
+ 32 tokens per PDF page
+ 85 + 170 × ceil(width / 512) × ceil(height / 512) per image
```

Quality, Balanced, and Compact target 20 MiB, 10 MiB, and 5 MiB respectively. A custom preset accepts a 1–100 MiB maximum. The planner evaluates a finite ordered set of longest-edge/quality candidates, never an unbounded retry loop. It will not go below the preset readability edge or JPEG quality 0.58. Transparent inputs remain PNG at quality 1. When the bounded candidates cannot meet the selected maximum, the UI reports that result and recommends lower quality, OCR-only output, Pack splitting, or item removal.

The plan binds the Pack revision, records a sorted set of excluded item IDs, and allocates derivative artifact IDs before encoding. Source bytes always describe the original Pack, while predicted output and token counts exclude user-selected or previously excluded items. Applying a stale plan fails closed. After publication, the Pack stores both the predicted estimate and the actual output, savings, deviation from the estimate, and applied exclusions.

## Native compression boundary

`ImageCompressionInspectionV1` and `ImageCompressionResultV1` are versioned DTOs with shared JSON Schemas and independently encoded Swift/Kotlin fixtures. The boundary passes controlled file URIs and hashes, never image bytes.

Both platforms:

- verify an immutable, no-follow source snapshot against the durable byte count and SHA-256;
- reject animation and inputs above the 16-million-source-pixel policy;
- cap retained output pixels at 4,194,304;
- preserve alpha as PNG and use JPEG only for opaque output;
- write a task-scoped `.partial`, synchronize it, then rename it to a complete temporary output;
- hash the complete derivative before returning its DTO;
- support cooperative task cancellation and explicit temporary-output disposal.

iOS uses ImageIO/Core Graphics. Android uses bounds-first decode with cancellation-aware streams and power-of-two sampling selected only as an allocation strategy; the requested final dimensions and orientation are rendered into the output bitmap. Heavy processing runs in the containing app native module, never in the iOS Share Extension.

## Failure and recovery behavior

- Cancellation leaves no valid-looking partial derivative.
- Source integrity, unknown schema, unsupported animation, decode, output publication, and cleanup failures remain visible through stable errors.
- A published derivative is immutable and registered before the Pack's latest budget result is updated.
- A Pack revision change invalidates the plan rather than applying it to different content.
- Native temporary stores purge inherited files on startup and retain only task-scoped current-process work until explicit finish.

## Verification and benchmark interpretation

Synthetic fixtures cover deterministic planning, impossible budgets, transparency, malformed native results, UI estimate/version labels, publication failure cleanup, output readability, source immutability, and cancellation cleanup. Native benchmark tests process 10, 20, and 50 generated screenshots and record input bytes, output bytes, elapsed time, and observed process peak memory.

The benchmark measurements are host/Simulator/Emulator evidence under ADR-0003. They are useful for regression comparison but are not physical-device thermal or memory claims. Exact commands, toolchain/runtime names, results, and measurements are recorded in the Draft PR evidence.

## Scope

No dependency, lockfile, database schema, migration version, network, logging, permission, Share Extension processing, video compression, cloud optimizer, or destination-specific tokenizer is introduced.
