# ADR-0002: SQLite metadata, owned files, and dual-Inbox recovery

- Status: Accepted and implemented for production persistence
- Date: 2026-08-03
- Production implementation: 2026-08-05
- Decision owners: repository maintainers
- Scope: Issue #5 decision and Issue #7 production implementation

## Context

Incoming shares begin outside the React Native persistence transaction. The iOS Share Extension writes to an App Group while the containing app owns its durable files. Android must copy provider content before URI permission expires, but its Inbox is already app-private. On either platform the process can stop between copying bytes, publishing a manifest, moving files, and committing metadata.

The design must not store binaries or provider URIs in SQLite, must not persist absolute paths, and must never make an uncommitted Inbox disappear.

## Decision

Use `expo-sqlite` 57.0.1 behind the shared `PersistenceRepository` boundary. SQLite stores internal IDs, state, references, exact-manifest SHA-256 fingerprints, recovery journal entries, and application-owned relative paths. Native Swift/Kotlin code performs Inbox-to-owned-storage handoff because it must coordinate App Group writers, stream and synchronize large files, inspect free space, and publish with same-volume atomic rename.

The database uses:

- `foreign_keys=ON`, WAL journal mode, `synchronous=FULL`, and a 5-second busy timeout;
- exclusive async transactions for migrations, import commits, and reference-aware deletes;
- immutable `PRAGMA user_version` migrations from empty → v1 → v2 → v3 → v4 → v5;
- a unique `imports.ingestion_id` idempotency key plus exact-byte manifest SHA-256 and complete persisted-artifact-set replay checks;
- `artifact_references` rather than inferred liveness;
- no `BLOB` content columns.

The v1 schema creates packs, imports, ordered import items, artifacts, references, and recovery journal rows. The v2 migration adds `last_verified_at` and cleanup indexes. The v3 migration adds the production Pack graph and optimistic revision, nullable item ownership for Pack-level export/preview artifacts, a one-original-per-item index, ordered ContextItems, RiskFindings, ExportRecords, recovery diagnostics, quarantine metadata, and a cleanup lease. The v3 artifact-table rebuild preserves v1/v2 rows, references, processor metadata, and foreign-key integrity. The v4 migration persists the exact retry stage independently from terminal item state; legacy rows receive the earliest safe stage derivable from immutable evidence. The v5 migration records explicit original-release disposition and durable pipeline run tokens, allowing restart recovery and late-success rejection without confusing intentional deletion with storage loss. Unknown newer `user_version` values fail with `SCHEMA_VERSION_UNSUPPORTED`; migration hooks expose only version/phase metadata.

One app-lifetime `ExpoSqlitePersistenceRepository` instance owns the connection. It implements the `ContextPack`, `ContextItem`, `RiskFinding`, `ExportRecord`, artifact-record, recovery, diagnostic, quarantine, cleanup-lease, and development-reset repository boundaries. Pack graphs use monotonic optimistic revisions; a stale writer fails with `PERSISTENCE_CONFLICT`, and ordered items are replaced atomically within the winning revision transaction.

## File ownership and paths

Durable logical paths are:

- `Packs/<pack-id>/originals/<item-id>.bin`
- `Packs/<pack-id>/derived/<artifact-id>.<controlled-extension>`
- `Packs/<pack-id>/exports/<export-id>.<controlled-extension>`
- `Packs/<pack-id>/previews/<preview-id>.<controlled-extension>`

iOS resolves these under `Library/Application Support/AIContextPack`. Android resolves them under `filesDir`. SQLite stores only the logical relative path. Leaves use canonical internal UUIDs, never provider names or user filenames. Absolute paths, backslashes, percent-encoded aliases, empty segments, and traversal segments fail the shared path policy.

App Group and app-private Inbox files remain immutable sources until database commit. Provider URIs are never returned as durable references.

## Commit and recovery protocol

1. The native Inbox writer owns a per-ingestion cross-process lock.
2. It copies provider bytes to staging partial files, synchronizes them, validates size/hash, writes a partial manifest, and publishes the ingestion only by atomic rename.
3. The main app rescans and semantically validates the published manifest.
4. Handoff snapshots and validates only the requested immutable ingestion while holding the writer registry lock. It does not rescan unrelated Inbox directories, so another ingestion's ACK rename cannot invalidate the snapshot.
5. Native handoff checks `sum(byteCount for destinations not yet published) + 16 MiB headroom` against available storage before creating a destination. Replay never budgets already-published bytes again.
6. Native code creates the complete owned hierarchy one level at a time and synchronizes every directory plus its parent before it can return artifacts. On iOS this includes a missing `Library/Application Support` entry and `AIContextPack` root; no multi-level precreation bypasses the durability helper. Each artifact is streamed to `<item-id>.bin.partial`, synchronized, size/hash checked, atomically renamed, and followed by a destination-directory synchronization. On replay, an existing destination is accepted only when its computed SHA-256 matches the current source, even if the manifest omitted an expected hash.
7. The same native call returns the validated manifest, SHA-256 of its exact bytes, and the bound artifact list. JavaScript cannot supply or substitute the fingerprint.
8. The repository commits the import, items, artifacts, references, and journal removal in one exclusive SQLite transaction. An existing import replays only when pack, exact manifest fingerprint, and the canonical artifact set (IDs, item IDs, relative paths, media types, byte counts, and SHA-256 values) all match.
9. Only after commit does the app ACK the ingestion. Under the writer registry lock, ACK atomically renames the live ingestion into the same-volume, scanner-invisible `InboxAckTombstones` sibling, synchronizes both parent directories, then removes the tombstone as best-effort cleanup. Missing live targets are idempotent success and retry leftover tombstone cleanup. Every native-module start also sweeps canonical tombstones on a utility thread under the same registry lock, so cleanup no longer depends on an ingestion event surviving ACK.
10. Bootstrap and lifecycle refresh load the ordered persisted Pack graphs after recovery. The UI therefore treats SQLite as its source of truth; an empty post-ACK Inbox scan or cold restart cannot make a committed Pack disappear.

If the app stops before step 8, the published owned file and original Inbox both remain. Replay revalidates an existing destination without requiring its bytes as free space and commits once. If it stops after step 8 but before step 9, the unique ingestion ID and matching manifest/artifact identities produce `replayed`, then ACK removes the source. If ACK stops after its rename, scanners cannot observe a partial deletion and native-start maintenance removes the tombstone independently. Any fingerprint or artifact-set mismatch fails as `ARTIFACT_INTEGRITY_FAILED` without ACK.

## iOS coordination decision

Keep the existing stable registry file plus per-ingestion POSIX advisory locks for the App Group. Do not add `NSFileCoordinator` for v0.1. Writers publish only immutable ingestion directories; targeted handoff snapshots, ACK rename, and tombstone sweep take the same registry lock; the durable destination is outside the App Group. This removes concurrent mutable-file coordination from the protocol while still preventing a snapshot or cleanup pass from racing a registry-coordinated rename.

## Cleanup and quarantine policy

- A database artifact is eligible only after the retention cutoff and only when it has no reference.
- Cleanup reads candidates, then rechecks references inside the delete transaction. A cleanup/recovery race therefore preserves the artifact.
- Referenced files are never deleted.
- Cleanup snapshots owned files before it reads all database-known paths and active recovery Pack IDs. Since recovery journals before publishing, files that are recent, referenced, or awaiting a recovery commit cannot be mistaken for orphans.
- Files under an owned root that have no database record and no active recovery are moved to quarantine, not silently deleted. A later diagnostic/retention task may purge quarantine explicitly.
- Inbox corruption and unknown versions remain diagnosable through stable codes and quarantine metadata; normal logging is limited to codes, counts, byte sizes, durations, and irreversible IDs.
- Native owned-file mutations are serialized across app/worker instances with an in-process registry plus a cross-process file lock. Quarantine and retention purge share that lock, so a newly quarantined file cannot be purged before its recorded timestamp. Native file mtime and SQLite quarantine creation time are evaluated against the same retention cutoff before the file and its metadata record are marked purged.
- Production cleanup and derived/export publication share one database lifecycle lease, closing the verified-file/SQLite-registration orphan race. Strictly named atomic-write `.partial` files remain enumerable, count toward native usage, and are quarantined when stale; active-recovery Pack paths remain protected. Cleanup uses a 24-hour unreferenced-artifact cutoff and a seven-day quarantine retention period. A lease holder releases in `finally` or expires after five minutes; another cleanup caller returns `lease-held`, while a publisher fails with retryable `PERSISTENCE_CONFLICT` before mutating files.
- A first app-lifetime artifact audit hashes every database-known file. Missing or mismatched bytes are represented as `STORAGE_DIVERGENCE_DETECTED`, recorded with metadata-only diagnostics when possible, and surfaced for recovery instead of crashing.

## Interruption and failure matrix

| Scenario                            | Expected result                                                             | Reproducible evidence                                         |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Before copy                         | Journal only; Inbox preserved                                               | shared coordinator test                                       |
| During copy                         | Partial remains recoverable; replay replaces it                             | Swift/Kotlin native handoff tests                             |
| After file close                    | Closed partial is revalidated or replaced                                   | Swift/Kotlin native handoff tests                             |
| Before manifest/publish rename      | Staging is not imported; recovery event is durable                          | existing Inbox recovery tests plus shared interruption matrix |
| Before DB commit                    | Published owned file and Inbox remain; replay commits once                  | shared coordinator test                                       |
| Duplicate replay                    | One import row; matching fingerprint; idempotent ACK                        | shared and native tests                                       |
| Corrupt/unknown manifest            | Fail closed with stable schema code; no content log                         | native manifest suites                                        |
| Expired Android provider permission | Successful files remain; failed item is explicit; no commit of a half-state | shared injected failure and Android importer tests            |
| Low disk                            | `RESOURCE_LOW_DISK` before destination creation; Inbox retained             | shared, Swift, and Kotlin tests                               |
| v1/v2/v3 app database update        | v4 applied with rows, references, order, and safe retry backfill preserved  | `npm run test:persistence-migrations`                         |
| Empty/legacy/restart/concurrent DB  | 0→1→2→3→4, ordered restart, one-of-two CAS, rollback, backup/restore pass   | `npm run test:persistence-production`                         |
| Cleanup races recovery              | Transactional reference recheck wins; file retained                         | shared cleanup race test                                      |
| Replay with low free space          | Existing artifacts require only fixed headroom and remain replayable        | Swift/Kotlin published-destination budget tests               |
| New destination hierarchy           | Every new directory and parent is synchronized before handoff returns       | Swift/Kotlin injected directory-sync tests                    |
| Fresh iOS Application Support       | Missing ancestor and owned root are created one level at a time and synced  | Swift fresh-install ancestor test                             |
| Replay artifact hash mismatch       | Exact fingerprint alone is insufficient; journal retained and no ACK occurs | shared coordinator and SQLite repository tests                |
| ACK stops after atomic rename       | Live Inbox is absent; tombstone is scanner-invisible and retryable          | Swift/Kotlin acknowledgement interruption tests               |
| ACK tombstone deletion stops        | ACK remains successful; native-start sweep retries without an ingestion     | Swift/Kotlin startup sweep interruption/deletion/fsync tests  |
| Handoff races another ingestion ACK | Target snapshot is registry-serialized; unrelated ACK waits, then succeeds  | Swift/Kotlin two-ingestion concurrency tests                  |

## Spike benchmarks

Synthetic filenames and bytes only; no OCR or PDF rendering was invoked.

| Harness                                                | 20 image artifacts (5 MiB total) | application/pdf artifact (49 MiB) | OCR runs |
| ------------------------------------------------------ | -------------------------------: | --------------------------------: | -------: |
| Swift Foundation/CryptoKit host harness, Apple Silicon |                            27 ms |                            194 ms |        0 |
| Pixel 9 Pro AVD, Android API 35                        |                           123 ms |                            131 ms |        0 |

These are Phase 0 correctness/baseline measurements, not physical-hardware release performance claims. Under [ADR-0003](0003-v0.1-virtual-device-verification.md), the named host harness and Pixel 9 Pro AVD are accepted v0.1 evidence; Issue #5 no longer carries a physical-device acceptance gate.

## Dependency review

`expo-sqlite` 57.0.1 is pinned by Expo SDK 57 and is maintained in the Expo monorepo under the MIT license. It supports the existing Expo Modules/New Architecture setup on iOS and Android. It performs local database access and adds no network permission, analytics, account, or remote service. Native SQLite code and the Expo module add binary size; Issue #7 records the exact isolated Release delta below. `await-lock` 2.2.2 is its small JavaScript transitive dependency and does not access content or the network.

Issue #7 measured the native autolink delta using identical source, production JavaScript bundle, architecture, and Release configuration; the comparison copy changed only `expo.autolinking.exclude: ["expo-sqlite"]`. On Apple Silicon with Xcode 26.6, Node 22.13.1, and the iOS Simulator arm64 Release target, the main executable increased from 2,915,808 to 5,899,664 bytes: **+2,983,856 bytes**. The uncompressed `.app` increased from 55,328 to 58,244 KiB: **+2,916 KiB (5.270%)**. The embedded Share Extension executable stayed 305,376 bytes: **0-byte delta**. With Android SDK 36, Gradle 9.3.1, JDK 22, Node 22.13.1, and an arm64-v8a Release AAB, the bundle increased from 26,405,826 to 27,333,723 bytes: **+927,897 bytes (3.514%)**. Of that AAB delta, `libexpo-sqlite.so` is 1,830,224 bytes uncompressed and 884,123 bytes compressed; the remainder is module registration/bytecode and bundle metadata. The Pixel 9 Pro/API 35 AVD was used for separate Android runtime verification, not to build the AAB. These are reproducible virtual-target build measurements, not physical-device performance evidence.

No separate file-system wrapper is selected. Resource-sensitive handoff remains in the existing first-party `ContextNative` Swift/Kotlin module.

## Rejected alternatives

- **Binaries in SQLite:** rejected due to transaction size, memory, backup, migration, and bridge pressure.
- **Durable provider/App Group paths:** rejected because provider grants expire and App Group Inbox is a recoverable handoff area, not Pack storage.
- **Absolute paths in rows:** rejected because container roots change across reinstall, simulator/device, restore, and platform.
- **JavaScript file copy:** rejected because cross-process locking, fsync, disk checks, and resource-bounded streaming are native responsibilities.
- **Nonexclusive `withTransactionAsync`:** rejected because unrelated async queries can enter the transaction; persistence writes use `withExclusiveTransactionAsync`.
- **Delete Inbox before DB commit:** rejected because a database failure would silently lose the only recoverable source.
- **Age-only cleanup:** rejected because it can race recovery and delete live content.
- **`NSFileCoordinator` for all App Group reads:** rejected for the immutable publish protocol; POSIX ownership locks and atomic rename are the smaller cross-process contract.

## Issue #7 production implementation

Issue #7 completes the production work owned by this ADR:

1. One retryable app-lifetime repository is wired during bootstrap; migration and recovery failures use stable UI error codes and the existing Retry interaction.
2. Every validated Inbox manifest is processed oldest-first through `InboxPersistenceCoordinator`. SQLite commit precedes ACK, and duplicate exact replays are idempotent.
3. Schema v3 persists production Pack fields, ordered items, risk decisions, exports, artifact identities, lifecycle timestamps, diagnostics, quarantine, and cleanup leases without editing v1/v2.
4. Native `ArtifactStore` publishes through partial write, file synchronization, size/SHA-256 verification, atomic rename, directory synchronization, and immutable replay checks before SQLite registration.
5. Reference-aware cleanup, seven-day quarantine retention, storage totals/divergence reporting, and a cross-caller lifecycle lease shared by publication and cleanup are implemented.
6. Deterministic development reset requires both a development build and the literal `RESET_AI_CONTEXT_PACK_DEVELOPMENT_DATA`; it is never an automatic production recovery path.
7. Real SQLite verification covers upgrade, repository restart, immutable-source rollback, concurrent compare-and-swap, Pack-append revisioning, risk/export round trips, corrupted-row mapping, interrupted transaction rollback, backup/restore, reference cleanup, and absence of BLOB/provider/absolute-path persistence. The release-size results and license review are recorded above.
8. Bootstrap, AppState refresh, and cold restart hydrate the persisted Pack projection after recovery, so the transient Inbox scan never replaces committed product state with an empty view.

Issue #12 extends the schema to v4: terminal item rows require a durable retry stage, packaging
failures can resume from `reviewed`, and retry clears the terminal-only marker in the same graph
transaction. The migration backfills only the earliest safe stage provable from v3 artifacts.

Cancellation/background pipeline checkpoints beyond Inbox recovery remain owned by their later processing issues. User-facing storage-management UI remains explicitly out of scope for Issue #7.

## Consequences

The shared layer owns persistence semantics and transactions; native code owns only controlled file handoff. Initial recovery keeps source and owned bytes until commit and may temporarily consume roughly twice the incoming content plus headroom. Replay budgets only missing destinations plus headroom. This is deliberate: low disk fails before copy without making a completed publish permanently unreplayable, and correctness takes priority over early cleanup.
