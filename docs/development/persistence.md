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
| v4      | Exact terminal-item retry stage, retained independently from the failed/cancelled/recovering state                                                          |
| v5      | Original retention/release disposition plus durable pipeline runs, monotonic claim versions, recovery leases, cancellation, and atomic stage settlement     |
| v6      | Immutable published-artifact checkpoint for crash-safe extraction settlement                                                                                |

Opening a database newer than v6 fails with `SCHEMA_VERSION_UNSUPPORTED`. Migration hooks emit version and phase only. The production repository exposes ContextPack, ContextItem, RiskFinding, ExportRecord, artifact, recovery, diagnostics, quarantine, lease, durable-pipeline, and development-reset boundaries. Pack graph writes use a monotonic revision; exactly one concurrent compare-and-swap succeeds. Persisted-row decoding is fail-closed: malformed values become retryable `STORAGE_DIVERGENCE_DETECTED`, while an unknown newer schema remains `SCHEMA_VERSION_UNSUPPORTED`.

Schema v5 records each imported original as `retained`, `released`, or `unavailable`. Migration from v4 recognizes explicit destructive removal from the absence of the ContextItem and any live original reference while an unreferenced original still proves that bytes once existed. A preserved removal has a `library-item` reference and remains retained. If a failed v4 row has neither graph provenance nor original bytes, the migration preserves `unavailable`: that state is indistinguishable from a provider-less failure, so it must not invent a destructive user action. Durable `pipeline_runs` are inserted atomically with retry-checkpoint restoration, claimed through a monotonic compare-and-swap token, renewed through SQLite completion, and completed or failed in the same transaction that advances the item and Pack. Schema v6 adds the published Artifact checkpoint: recovery verifies and settles that exact file without rerunning extraction, and cleanup treats the active checkpoint path as known. A replacement that encounters the still-valid original publication lease leaves the checkpoint runnable rather than converting contention into terminal failure. Settlement timestamps are clamped to the latest persisted Pack, item, run-start, and heartbeat timestamp. Cleanup-lease acquisition and expiry remain on their supplied wall-clock timeline rather than Pack chronology, so a future domain timestamp cannot evict a live cleanup owner. The heartbeat synchronously rejects a locally expired lease after app/event-loop suspension, while the process-wide native lifecycle mutex joins the old critical section before a replacement owner mutates files. Artifact registration, extraction checkpoint, and extraction settlement also revalidate the current unexpired owner inside their SQLite transactions. A stale claim, a missing owner, or a false completion compare-and-swap result cannot silently publish or settle.

## Atomic artifact lifecycle

Durable artifact rows contain only canonical internal IDs and relative paths:

- `Packs/<pack-id>/originals/<item-id>.bin`
- `Packs/<pack-id>/derived/<artifact-id>.<controlled-extension>`
- `Packs/<pack-id>/exports/<export-id>.<controlled-extension>`
- `Packs/<pack-id>/previews/<preview-id>.<controlled-extension>`

Native publication rejects traversal, aliases, non-canonical IDs, uncontrolled extensions, sources outside the app sandbox, and symlinks. It streams into `.partial`, synchronizes, verifies expected size/SHA-256, atomically renames, and synchronizes the parent directory. An existing destination is accepted only when its bytes are identical. SQLite enforces at most one original per item; source type, media type, original hash, and original path cannot be rewritten through a Pack update. `PublishedArtifactCoordinator` and scheduled cleanup share the renewable database lifecycle lease, so cleanup cannot quarantine a verified file between native publication and SQLite registration; every acquisition uses a fresh operation token and registration requires that same unexpired owner in its transaction. A database failure deliberately leaves an orphan that the integrity/cleanup path can recover after the lease is released or expires.

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

Scheduled cleanup and derived/export publication are serialized by a renewable, owner-fenced database lifecycle lease. Each critical section renews before the bounded expiry; ownership or renewal loss aborts the database transition, and the caller joins any in-flight native mutation before releasing its owner token. Cleanup applies a 24-hour unreferenced-artifact cutoff, rechecks references inside the delete transaction, protects Pack IDs with active recovery journals, quarantines unknown files, and purges quarantine after seven days. Native file mtime and SQLite quarantine `created_at` use the same retention cutoff before bytes and records are marked purged, so newly quarantined bytes remain visible in storage totals. Native quarantine and purge share a cross-caller lock. Cleanup diagnostics contain stable codes, phases, byte counts, counts, and irreversible internal IDs only.

Removing an item through the Pack editor preserves its immutable original by default. The same
exclusive graph transaction inserts a `library-item` artifact reference before releasing that
item's Pack references; derived artifacts may then follow normal reference-aware retention.
Explicit destructive removal instead releases the original reference after React Native obtains
confirmation. Physical deletion remains owned by reference-aware cleanup so restart, recovery,
and cleanup cannot race a UI transaction. See
[Pack library and editor shell](pack-library-editor.md).

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

`test:persistence-production` uses the system SQLite CLI and real files/processes to verify 0→1→2→3→4→5→6 migration, row/processor/reference, release-disposition, pipeline-run, and published-checkpoint preservation, ordered restart, one-of-two concurrent revision/claim success, interrupted transaction rollback, backup/restore, Pack-level artifacts, pipeline settlement, reference cleanup, foreign keys, and absence of BLOB/provider/absolute-path persistence. Jest also runs the repository implementation against Node 22's SQLite engine to cover restart ordering, immutable-source rollback, stale-writer and stale-claim rejection, renewable lease fencing, Pack-append revisioning, risk/export round trips, failed/copied pre/post-cleanup release migration, reference release, cleanup, and corrupted-row error mapping.

Clean app, Share Extension, Android build, virtual-device profile, release-size comparison, and exact test counts belong in the Issue #7 Draft PR evidence. The repository-wide local CI equivalents remain in [CI, merge checks, and local equivalents](ci.md).
