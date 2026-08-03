# ADR-0002: SQLite metadata, owned files, and dual-Inbox recovery

- Status: Accepted for the Phase 0 persistence spike
- Date: 2026-08-03
- Decision owners: repository maintainers
- Scope: Issue #5; production wiring is owned by Issue #7

## Context

Incoming shares begin outside the React Native persistence transaction. The iOS Share Extension writes to an App Group while the containing app owns its durable files. Android must copy provider content before URI permission expires, but its Inbox is already app-private. On either platform the process can stop between copying bytes, publishing a manifest, moving files, and committing metadata.

The design must not store binaries or provider URIs in SQLite, must not persist absolute paths, and must never make an uncommitted Inbox disappear.

## Decision

Use `expo-sqlite` 57.0.1 behind the shared `PersistenceRepository` boundary. SQLite stores internal IDs, state, references, exact-manifest SHA-256 fingerprints, recovery journal entries, and application-owned relative paths. Native Swift/Kotlin code performs Inbox-to-owned-storage handoff because it must coordinate App Group writers, stream and synchronize large files, inspect free space, and publish with same-volume atomic rename.

The database uses:

- `foreign_keys=ON`, WAL journal mode, `synchronous=FULL`, and a 5-second busy timeout;
- exclusive async transactions for migrations, import commits, and reference-aware deletes;
- `PRAGMA user_version` migrations from empty → v1 → v2;
- a unique `imports.ingestion_id` idempotency key plus exact-byte manifest SHA-256 and complete persisted-artifact-set replay checks;
- `artifact_references` rather than inferred liveness;
- no `BLOB` content columns.

The v1 schema creates packs, imports, ordered import items, artifacts, references, and recovery journal rows. The v2 migration adds `last_verified_at` and cleanup indexes. Unknown newer `user_version` values fail with `SCHEMA_VERSION_UNSUPPORTED`.

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
4. Native handoff checks `sum(byteCount for destinations not yet published) + 16 MiB headroom` against available storage before creating a destination. Replay never budgets already-published bytes again.
5. Native code creates the `Packs/<pack-id>/originals` hierarchy one level at a time and synchronizes every new directory plus its parent before it can return artifacts. Each artifact is streamed to `<item-id>.bin.partial`, synchronized, size/hash checked, atomically renamed, and followed by a destination-directory synchronization. On replay, an existing destination is accepted only when its computed SHA-256 matches the current source, even if the manifest omitted an expected hash.
6. The same native call returns the validated manifest, SHA-256 of its exact bytes, and the bound artifact list. JavaScript cannot supply or substitute the fingerprint.
7. The repository commits the import, items, artifacts, references, and journal removal in one exclusive SQLite transaction. An existing import replays only when pack, exact manifest fingerprint, and the canonical artifact set (IDs, item IDs, relative paths, media types, byte counts, and SHA-256 values) all match.
8. Only after commit does the app ACK the ingestion. Under the writer registry lock, ACK atomically renames the live ingestion into the same-volume, scanner-invisible `InboxAckTombstones` sibling, synchronizes both parent directories, then removes the tombstone as best-effort cleanup. Missing live targets are idempotent success and retry leftover tombstone cleanup.

If the app stops before step 7, the published owned file and original Inbox both remain. Replay revalidates an existing destination without requiring its bytes as free space and commits once. If it stops after step 7 but before step 8, the unique ingestion ID and matching manifest/artifact identities produce `replayed`, then ACK removes the source. If ACK stops after its rename, scanners cannot observe a partial deletion and a later ACK removes the tombstone. Any fingerprint or artifact-set mismatch fails as `ARTIFACT_INTEGRITY_FAILED` without ACK.

## iOS coordination decision

Keep the existing stable registry file plus per-ingestion POSIX advisory locks for the App Group. Do not add `NSFileCoordinator` for v0.1. Writers publish only immutable ingestion directories; scanners and ACK take the same registry lock; the durable destination is outside the App Group. This removes concurrent mutable-file coordination from the protocol while still preventing a scanner or cleanup pass from treating an active writer as abandoned.

## Cleanup and quarantine policy

- A database artifact is eligible only after the retention cutoff and only when it has no reference.
- Cleanup reads candidates, then rechecks references inside the delete transaction. A cleanup/recovery race therefore preserves the artifact.
- Referenced files are never deleted.
- Cleanup snapshots owned files before it reads all database-known paths and active recovery Pack IDs. Since recovery journals before publishing, files that are recent, referenced, or awaiting a recovery commit cannot be mistaken for orphans.
- Files under an owned root that have no database record and no active recovery are moved to quarantine, not silently deleted. A later diagnostic/retention task may purge quarantine explicitly.
- Inbox corruption and unknown versions remain diagnosable through stable codes and quarantine metadata; normal logging is limited to codes, counts, byte sizes, durations, and irreversible IDs.

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
| v1 app database update              | v2 applied with rows preserved                                              | `npm run test:persistence-migrations`                         |
| Cleanup races recovery              | Transactional reference recheck wins; file retained                         | shared cleanup race test                                      |
| Replay with low free space          | Existing artifacts require only fixed headroom and remain replayable        | Swift/Kotlin published-destination budget tests               |
| New destination hierarchy           | Every new directory and parent is synchronized before handoff returns       | Swift/Kotlin injected directory-sync tests                    |
| Replay artifact hash mismatch       | Exact fingerprint alone is insufficient; journal retained and no ACK occurs | shared coordinator and SQLite repository tests                |
| ACK stops after atomic rename       | Live Inbox is absent; tombstone is scanner-invisible and retryable          | Swift/Kotlin acknowledgement interruption tests               |
| ACK tombstone deletion stops        | ACK remains successful; later ACK completes best-effort cleanup             | Swift/Kotlin tombstone deletion tests                         |

## Spike benchmarks

Synthetic filenames and bytes only; no OCR or PDF rendering was invoked.

| Harness                                                | 20 image artifacts (5 MiB total) | application/pdf artifact (49 MiB) | OCR runs |
| ------------------------------------------------------ | -------------------------------: | --------------------------------: | -------: |
| Swift Foundation/CryptoKit host harness, Apple Silicon |                            20 ms |                             82 ms |        0 |
| Pixel 9 Pro AVD, Android API 35                        |                           182 ms |                            150 ms |        0 |

These are Phase 0 correctness/baseline measurements, not release performance claims. Issue #5 still requires representative physical-device evidence because it carries `test:device-required`.

## Dependency review

`expo-sqlite` 57.0.1 is pinned by Expo SDK 57 and is maintained in the Expo monorepo under the MIT license. It supports the existing Expo Modules/New Architecture setup on iOS and Android. It performs local database access and adds no network permission, analytics, account, or remote service. Native SQLite code and the Expo module add binary size; the exact release-size delta must be recorded in Issue #7 release builds. `await-lock` 2.2.2 is its small JavaScript transitive dependency and does not access content or the network.

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

## Production work explicitly deferred to Issue #7

1. Wire one app-lifetime repository instance during bootstrap and surface migration failures in the Pack UI.
2. Invoke `InboxPersistenceCoordinator` for every validated Inbox ingestion and persist the production `ContextPack` fields required by Phase 1.
3. Add production migrations for Pack titles/instructions/budgets, pipeline runs/checkpoints, risk decisions, exports, and lifecycle timestamps as their owning issues land; never edit an applied migration.
4. Implement quarantine retention, user-visible diagnostics, storage totals, and a scheduled cleanup lease.
5. Add cancellation/background checkpoint wiring and retry UI without expanding native Share Extension work.
6. Add release database backup/restore/upgrade tests and measure SQLite/file size on physical low-end and flagship devices.
7. Record the `expo-sqlite` release binary-size delta and final license notice.

## Consequences

The shared layer owns persistence semantics and transactions; native code owns only controlled file handoff. Initial recovery keeps source and owned bytes until commit and may temporarily consume roughly twice the incoming content plus headroom. Replay budgets only missing destinations plus headroom. This is deliberate: low disk fails before copy without making a completed publish permanently unreplayable, and correctness takes priority over early cleanup.
