# Stable domain error catalog

Error definitions live in `src/domain/errors.ts`. Codes are stable API values; UI copy is localized separately and must never be used as control flow.

Disposition describes what can resolve the error:

- `retryable`: the same safe operation may be attempted again.
- `terminal`: the current input/state cannot continue without a new version or repaired integrity state.
- `user-action-required`: the user must reselect input, review privacy state, free storage, or choose a different action.

Category identifies the protection boundary. It does not contain user content.

| Code                                 | Disposition          | Category  |
| ------------------------------------ | -------------------- | --------- |
| `DOMAIN_INVALID_TRANSITION`          | terminal             | state     |
| `SCHEMA_INVALID`                     | terminal             | integrity |
| `SCHEMA_VERSION_UNSUPPORTED`         | terminal             | integrity |
| `ARTIFACT_INTEGRITY_FAILED`          | terminal             | integrity |
| `IMPORT_PROVIDER_PERMISSION_EXPIRED` | user-action-required | platform  |
| `IMPORT_TYPE_UNSUPPORTED`            | user-action-required | input     |
| `IMPORT_COPY_FAILED`                 | retryable            | resource  |
| `IMPORT_PARTIAL_FAILURE`             | user-action-required | input     |
| `PIPELINE_STAGE_FAILED`              | retryable            | state     |
| `PROCESSOR_OUTPUT_INVALID`           | terminal             | integrity |
| `PIPELINE_RECOVERY_REQUIRED`         | retryable            | integrity |
| `PRIVACY_REVIEW_REQUIRED`            | user-action-required | privacy   |
| `PRIVACY_EXPORT_BLOCKED`             | user-action-required | privacy   |
| `RESOURCE_LOW_DISK`                  | user-action-required | resource  |
| `RESOURCE_MEMORY_PRESSURE`           | retryable            | resource  |
| `STORAGE_WRITE_FAILED`               | retryable            | resource  |

New codes require tests, documentation, and a compatibility review. Renaming or reclassifying an existing code is a breaking contract change. Errors and diagnostics may include irreversible IDs, enum values, counts, byte sizes, durations, and processor versions; they must not include imported text, OCR output, filenames, full URLs, file bytes, or detector match values.
