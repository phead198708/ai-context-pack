# Shared domain and V1 contracts

Issue #4 establishes the framework-independent domain vocabulary and the contracts that cross the React Native/native boundary. Production persistence is intentionally deferred to Issue #5.

## Domain ownership

`src/domain` owns immutable definitions for:

- `ContextPack`, `ContextItem`, `Artifact`, `ImportRecord`, `PipelineRun`
- `RiskFinding`, `ReviewDecision`, `ExportRecord`, `Budget`
- `ProcessorVersion`, Pack states, Item states, and stable error semantics

The domain must not import React, React Native, Expo, UI, repositories, native modules, Node/file APIs, or platform SDKs. ESLint and `domainBoundaries.test.ts` enforce that rule.

Binary files remain outside domain DTOs and SQLite. Domain records use internal IDs and application-relative paths only. Provider URIs and machine absolute paths are transient infrastructure inputs and are forbidden in durable DTOs.

## State machines

The complete transition tables are exported from `src/domain/stateMachines.ts`. A `(state, command)` pair has exactly one result or throws `DOMAIN_INVALID_TRANSITION`; there is no permissive fallback.

Pack commands explicitly include:

- `record-partial-failure` and `require-review`
- `cancel` and `retry`
- `start-recovery` and `resume-recovery`
- processing, ready, export, completion, and failure transitions

Item commands explicitly include:

- received → imported → extracted → analyzed → reviewed → packaged
- `require-review`
- `cancel`, `retry`, `start-recovery`, and `resume-recovery`

Retry and recovery return to the idempotent pipeline entry. `PipelineCheckpointV1.stage`, `reason`, and `resumeAction` identify the stable stage to replay; no cancellation/retry/recovery behavior is inferred from booleans.

Tests execute every allowed transition and every invalid state-command pair.

## Contract registry

| Contract             | Semantic runtime validator                | Structural JSON Schema                                                                                | Canonical fixture                                                                     |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ImportManifestV1     | `contracts.ts` / `isImportManifestV1`     | [`import-manifest-v1.schema.json`](../../schemas/contracts/v1/import-manifest-v1.schema.json)         | [`import-manifest-v1.json`](../../fixtures/contracts/import-manifest-v1.json)         |
| OCRResultV1          | `contracts.ts` / `isOCRResultV1`          | [`ocr-result-v1.schema.json`](../../schemas/contracts/v1/ocr-result-v1.schema.json)                   | [`ocr-result-v1.json`](../../fixtures/contracts/ocr-result-v1.json)                   |
| PDFPageExtractionV1  | `contracts.ts` / `isPDFPageExtractionV1`  | [`pdf-page-extraction-v1.schema.json`](../../schemas/contracts/v1/pdf-page-extraction-v1.schema.json) | [`pdf-page-extraction-v1.json`](../../fixtures/contracts/pdf-page-extraction-v1.json) |
| PipelineCheckpointV1 | `contracts.ts` / `isPipelineCheckpointV1` | [`pipeline-checkpoint-v1.schema.json`](../../schemas/contracts/v1/pipeline-checkpoint-v1.schema.json) | [`pipeline-checkpoint-v1.json`](../../fixtures/contracts/pipeline-checkpoint-v1.json) |
| RiskFindingV1        | `contracts.ts` / `isRiskFindingV1`        | [`risk-finding-v1.schema.json`](../../schemas/contracts/v1/risk-finding-v1.schema.json)               | [`risk-finding-v1.json`](../../fixtures/contracts/risk-finding-v1.json)               |
| ExportManifestV1     | `contracts.ts` / `isExportManifestV1`     | [`export-manifest-v1.schema.json`](../../schemas/contracts/v1/export-manifest-v1.schema.json)         | [`export-manifest-v1.json`](../../fixtures/contracts/export-manifest-v1.json)         |

The Swift and Kotlin test encoders construct all six payloads independently and compare their canonical JSON with these same repository fixtures.

### Structural and semantic validation

The Draft 2020-12 schemas are the machine-readable structural layer: required and unknown fields, primitive ranges, enums, canonical identifiers, safe path syntax, aggregate import composition, and checkpoint reason/action combinations. Jest compiles every schema with Ajv and runs all six canonical fixtures plus the structural portion of the negative corpus through it.

The exported TypeScript validator named in each schema's `$comment` is the semantic authority. Consumers must run it after structural validation. Standard Draft 2020-12 cannot portably express projected uniqueness, an import path equal to `<item.id>.bin`, array position equal to `item.order`, or sums such as `x + width <= 1`; the negative corpus proves these payloads pass the structural schema and fail the semantic authority. Native import readers mirror the relevant `ImportManifestV1` semantic checks at the platform boundary.

V1 timestamps use canonical UTC `YYYY-MM-DDTHH:mm:ss[.fraction]Z` with one to nine optional fractional digits. The date must exist in the proleptic Gregorian calendar, hours are `00`–`23`, and minutes/seconds are `00`–`59`; rollover forms such as `24:00:00`, leap-second `:60`, and parser-normalized nonexistent dates are invalid. JSON Schema, TypeScript, Swift, and Kotlin exercise the same calendar rules, including valid leap-day and nanosecond-precision cases.

`PDFPageExtractionV1.text` is a JSON Unicode string and deliberately has no redundant `characterCount`. JavaScript/Kotlin UTF-16 length and Swift grapheme counts differ for emoji and combining sequences, so persisting a derived count would make V1 platform-dependent. The canonical fixture contains Simplified Chinese, an emoji sequence, and a combining sequence to exercise exact Swift/Kotlin/TypeScript payload parity.

### Import path rule

`ImportManifestV1` stores an item-relative generated filename such as `<item-uuid>.bin`. Both native scanners require strict JSON syntax before contract validation, resolve the item only below the ingestion directory, and verify its file byte count. When `sha256` is present they stream the owned file through SHA-256 and compare the lowercase digest. Missing files, byte-count mismatches, unreadable item bytes, and digest mismatches are `ARTIFACT_INTEGRITY_FAILED`; malformed contract syntax or fields remain `SCHEMA_INVALID`. The readers also reject `localUri`, provider URIs, absolute paths, traversal, nested paths, item/path identity mismatch, duplicate item IDs, and inconsistent aggregate status.

Infrastructure may resolve a validated relative path to a controlled file URL at the moment a native processor needs it. That URL is not persisted back into the contract.

### Privacy shape

- `RiskFindingV1` contains category, confidence, and coordinates/range only; it rejects matched secret text and requires image regions to have positive width and height so a redaction decision always covers pixels.
- `ExportManifestV1` is an explicit relative-path artifact allowlist and requires a completed privacy-review hash.
- Hashes are lowercase SHA-256. UUIDs are lowercase canonical versions 1–5 with RFC variant bits.

## Compatibility and migration policy

All six contracts currently support exactly `schemaVersion: 1`.

- Missing versions are `SCHEMA_INVALID`.
- Unknown numeric versions are `SCHEMA_VERSION_UNSUPPORTED` and fail closed.
- Readers never guess forward compatibility or silently strip unknown data.
- A migration must be an explicit, registered, pure `Vn → Vn+1` step with old/new fixtures and rollback evidence.
- A breaking shape change requires a new schema version; V1 fixtures remain immutable after release.
- Infrastructure migrations may change storage layout but must decode the old DTO before producing the next version.

The executable policy lives in `compatibility.ts`; runtime decoders return stable failure codes and `requireVersionedContract` converts failures to `DomainError` when exception semantics are needed.

## Issue #5 handoff

Issue #5 must implement repositories and migrations behind interfaces that consume these domain types. It must decide SQLite tables, reference tracking, relative-path roots, atomic transaction boundaries, cleanup/quarantine policy, and checkpoint persistence without adding infrastructure imports to `src/domain`.
