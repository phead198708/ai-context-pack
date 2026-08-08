# Production persistence and recovery

Issue #7 promotes the Phase 0 persistence decision in [ADR-0002](../adr/0002-sqlite-file-storage-and-inbox-recovery.md) to the production runtime. This document is the operational guide for migrations, recovery, cleanup, diagnostics, and development reset.

## Runtime ownership

- `productionRepository()` opens one retryable app-lifetime `ExpoSqlitePersistenceRepository` and one SQLite connection.
- `ProductionInboxManifestProcessor` serializes bootstrap, AppState, and native-event scans, processes manifests oldest-first, performs the first app-lifetime artifact-integrity audit, runs scheduled cleanup, and hydrates `listPackGraphs()` for the UI. Persisted Packs remain the display source of truth after native Inbox ACK and on cold restart.
- Swift/Kotlin owns streaming file writes, cross-caller locks, free-space checks, hashing, `fsync`, atomic rename, and quarantine retention. TypeScript owns transaction ordering, idempotency, repositories, diagnostics, and recovery policy.
- The bridge passes controlled `file://` URIs, internal relative paths, hashes, byte counts, and versioned DTOs. It never passes artifact bytes or persists provider URIs.

## Schema and repositories

`PRAGMA user_version` advances only through immutable migrations:

| Version | Contents                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1      | Packs, imports, ordered import items, artifacts, references, and recovery journal                                                                           |
| v2      | Artifact verification timestamp and cleanup indexes                                                                                                         |
| v3      | Production Pack graph/revision, ordered ContextItems, RiskFindings, ExportRecords, Pack-level artifacts, diagnostics, quarantine records, and cleanup lease |

Opening a database newer than v3 fails with `SCHEMA_VERSION_UNSUPPORTED`. Migration hooks emit version and phase only. The production repository exposes ContextPack, ContextItem, RiskFinding, ExportRecord, artifact, recovery, diagnostics, quarantine, lease, and development-reset boundaries. Pack graph writes use a monotonic revision; exactly one concurrent compare-and-swap succeeds. Persisted-row decoding is fail-closed: malformed values become retryable `STORAGE_DIVERGENCE_DETECTED`, while an unknown newer schema remains `SCHEMA_VERSION_UNSUPPORTED`.

## Atomic artifact lifecycle

Durable artifact rows contain only canonical internal IDs and relative paths:

- `Packs/<pack-id>/originals/<item-id>.bin`
- `Packs/<pack-id>/derived/<artifact-id>.<controlled-extension>`
- `Packs/<pack-id>/exports/<export-id>.<controlled-extension>`
- `Packs/<pack-id>/previews/<preview-id>.<controlled-extension>`

Native publication rejects traversal, aliases, non-canonical IDs, uncontrolled extensions, sources outside the app sandbox, and symlinks. It streams into `.partial`, synchronizes, verifies expected size/SHA-256, atomically renames, and synchronizes the parent directory. An existing destination is accepted only when its bytes are identical. SQLite enforces at most one original per item; source type, media type, original hash, and original path cannot be rewritten through a Pack update. `PublishedArtifactCoordinator` and scheduled cleanup share the database lifecycle lease, so cleanup cannot quarantine a verified file between native publication and SQLite registration. A database failure deliberately leaves an orphan that the integrity/cleanup path can recover after the lease is released or expires.

## Inbox exactly-once recovery

For each manifest:

1. Journal `discovered` and `handoff-started` before native publication.
2. Native handoff validates the exact manifest bytes, every copied artifact, and any bounded failed-item `.retry` source, checks the full missing-byte budget plus 16 MiB headroom, and publishes immutable originals. A copied item requires exactly one original; a failed item permits zero or one retained original.
3. Journal `files-published`; commit the import, Pack, items, artifacts, references, and journal removal in one exclusive transaction.
4. ACK only after commit. Exact replay returns `replayed`; any manifest/artifact identity mismatch fails with `ARTIFACT_INTEGRITY_FAILED` and retains recovery material.
5. Load the ordered persisted Pack graphs for display. A later empty native Inbox scan cannot hide an already committed Pack.

Malformed, corrupt, identity-mismatched, or unsupported published Inbox entries are atomically moved to a scanner-invisible quarantine name generated from an internal UUID. The original stable error is surfaced, and later valid entries continue to be scanned. No provider or display filename is reused.

## Divergence, cleanup, and storage totals

The first app-lifetime integrity audit hashes every database-known artifact. Missing or mismatched files produce `STORAGE_DIVERGENCE_DETECTED` and metadata-only diagnostics instead of a crash. Native owned-file enumeration includes strictly named `<artifact>.<ext>.partial` files, so interrupted publications contribute to storage usage and are quarantined by scheduled cleanup or removed by the explicit development reset. Storage usage exposes database and native totals plus an explicit `divergent` flag.

Scheduled cleanup and derived/export publication are serialized by a five-minute database lifecycle lease. Cleanup applies a 24-hour unreferenced-artifact cutoff, rechecks references inside the delete transaction, protects Pack IDs with active recovery journals, quarantines unknown files, and purges quarantine after seven days. Native file mtime and SQLite quarantine `created_at` use the same retention cutoff before bytes and records are marked purged, so newly quarantined bytes remain visible in storage totals. Native quarantine and purge share a cross-caller lock. Cleanup diagnostics contain stable codes, phases, byte counts, counts, and irreversible internal IDs only.

## Development reset

Reset is not a recovery fallback. It requires a development build and the exact literal `RESET_AI_CONTEXT_PACK_DEVELOPMENT_DATA`. Production builds always return `DEVELOPMENT_RESET_FORBIDDEN`. The coordinator quarantines/removes owned files before resetting the development database so stale bytes cannot silently reappear.

## Verification

Use synthetic fixtures only:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test -- --runInBand
npm run test:persistence-migrations
npm run test:persistence-production
swift test --package-path modules/context-native/ios
./android/gradlew -p android :context-native:connectedDebugAndroidTest :app:testDebugUnitTest
```

`test:persistence-production` uses the system SQLite CLI and real files/processes to verify 0→1→2→3 migration, row/processor/reference preservation, ordered restart, one-of-two concurrent revision success, interrupted transaction rollback, backup/restore, Pack-level artifacts, reference cleanup, foreign keys, and absence of BLOB/provider/absolute-path persistence. Jest also runs the repository implementation against Node 22's SQLite engine to cover restart ordering, immutable-source rollback, stale-writer rejection, Pack-append revisioning, risk/export round trips, reference release, cleanup, and corrupted-row error mapping.

Clean app, Share Extension, Android build, virtual-device profile, release-size comparison, and exact test counts belong in the Issue #7 Draft PR evidence. The repository-wide local CI equivalents remain in [CI, merge checks, and local equivalents](ci.md).
