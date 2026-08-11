import {
  DomainError,
  isDomainErrorCode,
  type DomainErrorCode,
} from '../../domain/errors';
import {
  createCanonicalUuid,
  isCanonicalUuid,
} from '../../domain/canonicalUuid';
import type {
  NativeInboxHandoff,
  OwnedArtifactFileStore,
  PersistenceRepository,
  PersistenceRecoveryPhase,
  CleanupLeaseRepository,
  QuarantineRepository,
  RecoveryDiagnosticsRepository,
} from './contracts';
import {
  assertOwnedArtifactPath,
  ownedArtifactPackId,
  ownedOriginalPath,
} from './ownedPaths';
import { startCleanupLeaseHeartbeat } from './cleanupLeaseHeartbeat';
import { acquireArtifactLifecycleMutex } from './artifactLifecycleMutex';
import { monotonicNowMilliseconds } from './operationalLeaseClock';

const DISK_HEADROOM_BYTES = 16 * 1024 * 1024;

export type PersistenceInterruptionPoint =
  | 'before-copy'
  | 'during-copy'
  | 'after-file-close'
  | 'before-manifest-rename'
  | 'before-db-commit';

export interface RecoveryImportRequest {
  readonly packId: string;
  readonly ingestionId: string;
}

export class InboxPersistenceCoordinator {
  constructor(
    private readonly repository: PersistenceRepository,
    private readonly nativeHandoff: NativeInboxHandoff,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly interruptionHook: (
      point: PersistenceInterruptionPoint,
    ) => Promise<void> = async () => undefined,
    private readonly diagnostics?: RecoveryDiagnosticsRepository,
  ) {}

  async recover(
    request: RecoveryImportRequest,
  ): Promise<'created' | 'replayed'> {
    requireIdentifier(request.packId);
    requireIdentifier(request.ingestionId);
    await this.repository.initialize();
    let phase: PersistenceRecoveryPhase = 'discovered';
    try {
      await this.repository.recordRecovery({
        ingestionId: request.ingestionId,
        packId: request.packId,
        phase,
        updatedAt: this.now(),
      });
      await this.interruptionHook('before-copy');
      phase = 'handoff-started';
      await this.repository.recordRecovery({
        ingestionId: request.ingestionId,
        packId: request.packId,
        phase,
        updatedAt: this.now(),
      });
      const handoff = await this.nativeHandoff.handoffInbox(
        request.ingestionId,
        request.packId,
        DISK_HEADROOM_BYTES,
      );
      requireFingerprint(handoff.manifestFingerprint);
      if (handoff.manifest.ingestionId !== request.ingestionId)
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      const { artifacts } = handoff;
      artifacts.forEach(artifact =>
        assertOwnedArtifactPath(artifact.relativePath),
      );
      const artifactBackedItems = handoff.manifest.items.filter(
        item =>
          item.status === 'copied' ||
          (item.status === 'failed' &&
            item.retryByteCount !== undefined &&
            item.retrySha256 !== undefined),
      );
      const itemsById = new Map(
        handoff.manifest.items.map(item => [item.id, item] as const),
      );
      const artifactIds = new Set(artifacts.map(artifact => artifact.itemId));
      if (
        artifacts.length < artifactBackedItems.length ||
        artifacts.length > handoff.manifest.items.length ||
        artifactIds.size !== artifacts.length ||
        artifacts.some(
          artifact =>
            artifact.relativePath !==
              ownedOriginalPath(request.packId, artifact.itemId) ||
            (() => {
              const item = itemsById.get(artifact.itemId);
              return (
                !item ||
                item.mediaType !== artifact.mediaType ||
                (item.status === 'copied' &&
                  (item.byteCount !== artifact.byteCount ||
                    (item.sha256 !== undefined &&
                      item.sha256 !== artifact.sha256))) ||
                (item.status === 'failed' &&
                  (item.retryByteCount === undefined ||
                    item.retrySha256 === undefined ||
                    item.retryByteCount !== artifact.byteCount ||
                    item.retrySha256 !== artifact.sha256))
              );
            })(),
        ) ||
        artifactBackedItems.some(item => !artifactIds.has(item.id))
      )
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      phase = 'files-published';
      await this.repository.recordRecovery({
        ingestionId: request.ingestionId,
        packId: request.packId,
        phase,
        updatedAt: this.now(),
      });
      await this.interruptionHook('before-db-commit');
      const result = await this.repository.commitImport({
        packId: request.packId,
        manifest: handoff.manifest,
        manifestFingerprint: handoff.manifestFingerprint,
        artifacts,
      });
      phase = 'database-committed';
      await this.nativeHandoff.acknowledgeInbox(request.ingestionId);
      return result;
    } catch (error) {
      const occurredAt = this.now();
      const code = recoveryErrorCode(error);
      try {
        await this.repository.recordRecovery({
          ingestionId: request.ingestionId,
          packId: request.packId,
          phase,
          updatedAt: occurredAt,
          errorCode: code,
        });
        await this.diagnostics?.recordRecoveryDiagnostic({
          id: request.ingestionId,
          scope: 'inbox',
          anonymousId: request.ingestionId,
          code,
          phase,
          occurredAt,
        });
      } catch {
        // Preserve the causal error. Both durable Inbox and published owned
        // files remain available for a later scan even if diagnostics fail.
      }
      throw error;
    }
  }
}

export class ReferenceAwareCleanup {
  constructor(
    private readonly repository: PersistenceRepository,
    private readonly files: OwnedArtifactFileStore,
    private readonly cleanupLeaseOwnerId: string,
    private readonly quarantine?: QuarantineRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly quarantineRetentionMs = 7 * 24 * 60 * 60 * 1_000,
    private readonly assertLease: () => void = () => undefined,
  ) {
    requireIdentifier(cleanupLeaseOwnerId);
  }

  async run(olderThan: string): Promise<{
    readonly deleted: number;
    readonly quarantined: number;
  }> {
    this.assertLease();
    const references = await this.repository.listReferencedRelativePaths();
    this.assertLease();
    const candidates = await this.repository.listCleanupCandidates(olderThan);
    this.assertLease();
    let deleted = 0;
    for (const candidate of candidates) {
      if (references.has(candidate.relativePath)) continue;
      this.assertLease();
      const removed = await this.repository.deleteArtifactRecordIfUnreferenced(
        candidate.artifactId,
        this.cleanupLeaseOwnerId,
      );
      this.assertLease();
      if (!removed) continue;
      await this.files.removeOwnedFile(candidate.relativePath);
      this.assertLease();
      deleted += 1;
    }
    // Snapshot files first. Recovery records its journal before it can publish
    // a new file, so the later database snapshot cannot miss a listed file
    // that belongs to an active recovery.
    const ownedFiles = await this.files.listOwnedFiles();
    this.assertLease();
    const [known, recoveringPackIds] = await Promise.all([
      this.repository.listKnownRelativePaths(),
      this.repository.listRecoveringPackIds(),
    ]);
    this.assertLease();
    let quarantined = 0;
    for (const file of ownedFiles) {
      const path = file.relativePath;
      if (known.has(path)) continue;
      const filePackId = ownedArtifactPackId(path);
      if (filePackId && recoveringPackIds.has(filePackId)) continue;
      this.assertLease();
      const result = await this.files.quarantineOwnedFile(path);
      this.assertLease();
      if (!result) continue;
      const createdAt = this.now();
      await this.quarantine?.recordQuarantine(
        {
          id: result.quarantineId,
          anonymousId: result.anonymousId,
          reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
          byteCount: result.byteCount,
          createdAt,
          purgeAfter: new Date(
            Date.parse(createdAt) + this.quarantineRetentionMs,
          ).toISOString(),
        },
        this.cleanupLeaseOwnerId,
      );
      this.assertLease();
      quarantined += 1;
    }
    return { deleted, quarantined };
  }
}

export interface ScheduledCleanupResult {
  readonly status: 'completed' | 'lease-held';
  readonly deleted: number;
  readonly quarantined: number;
  readonly purged: number;
  readonly purgedBytes: number;
}

/** Serializes cleanup across callers and applies the explicit quarantine TTL. */
export class ScheduledReferenceAwareCleanup {
  constructor(
    private readonly repository: PersistenceRepository &
      CleanupLeaseRepository &
      QuarantineRepository &
      RecoveryDiagnosticsRepository,
    private readonly files: OwnedArtifactFileStore,
    private readonly ownerId: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly artifactRetentionMs = 24 * 60 * 60 * 1_000,
    private readonly quarantineRetentionMs = 7 * 24 * 60 * 60 * 1_000,
    private readonly leaseDurationMs = 5 * 60 * 1_000,
    private readonly monotonicNow: () => number = monotonicNowMilliseconds,
  ) {
    requireIdentifier(ownerId);
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0)
      throw new DomainError('SCHEMA_INVALID');
  }

  async run(): Promise<ScheduledCleanupResult> {
    // Each acquisition gets a fresh fencing identity. Reusing the process-level
    // diagnostic ID would allow an older suspended run to renew/release a newer
    // run after the original TTL expires.
    const leaseOwnerId = createCanonicalUuid();
    const acquiredAt = this.now();
    const acquiredEpoch = Date.parse(acquiredAt);
    const lease = await this.repository.acquireCleanupLease(
      leaseOwnerId,
      acquiredAt,
      new Date(acquiredEpoch + this.leaseDurationMs).toISOString(),
    );
    if (!lease)
      return {
        status: 'lease-held',
        deleted: 0,
        quarantined: 0,
        purged: 0,
        purgedBytes: 0,
      };
    const heartbeat = startCleanupLeaseHeartbeat(
      this.repository,
      leaseOwnerId,
      acquiredAt,
      this.leaseDurationMs,
      this.now,
      this.monotonicNow,
    );
    const releaseLifecycleMutex = await acquireArtifactLifecycleMutex();
    try {
      heartbeat.assertOwned();
      const cleanup = await new ReferenceAwareCleanup(
        this.repository,
        this.files,
        leaseOwnerId,
        this.repository,
        this.now,
        this.quarantineRetentionMs,
        heartbeat.assertOwned,
      ).run(new Date(acquiredEpoch - this.artifactRetentionMs).toISOString());
      heartbeat.assertOwned();
      const quarantineCutoffEpoch = acquiredEpoch - this.quarantineRetentionMs;
      const quarantineCutoff = new Date(quarantineCutoffEpoch).toISOString();
      const purged = await this.files.purgeQuarantine(quarantineCutoffEpoch);
      heartbeat.assertOwned();
      const marked = await this.repository.markQuarantinePurgedBefore(
        quarantineCutoff,
        acquiredAt,
        leaseOwnerId,
      );
      heartbeat.assertOwned();
      if (marked !== purged.purgedCount) {
        await this.repository.recordRecoveryDiagnostic({
          id: this.ownerId,
          scope: 'cleanup',
          anonymousId: this.ownerId,
          code: 'STORAGE_DIVERGENCE_DETECTED',
          phase: 'quarantine-retention',
          occurredAt: acquiredAt,
        });
        heartbeat.assertOwned();
      }
      const heartbeatFailure = await heartbeat.stop();
      if (heartbeatFailure !== undefined)
        throw new DomainError('PERSISTENCE_CONFLICT');
      return {
        status: 'completed',
        ...cleanup,
        purged: purged.purgedCount,
        purgedBytes: purged.purgedBytes,
      };
    } finally {
      try {
        await heartbeat.stop();
        await this.repository.releaseCleanupLease(leaseOwnerId);
      } finally {
        releaseLifecycleMutex();
      }
    }
  }
}

function requireIdentifier(value: string): void {
  if (!isCanonicalUuid(value)) throw new DomainError('SCHEMA_INVALID');
}

function requireFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new DomainError('SCHEMA_INVALID');
}

function recoveryErrorCode(error: unknown): DomainErrorCode {
  if (error instanceof DomainError) return error.code;
  if (isRecord(error) && isDomainErrorCode(error.code)) return error.code;
  return 'PIPELINE_RECOVERY_REQUIRED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
