import { DomainError } from '../../domain/errors';
import {
  createCanonicalUuid,
  isCanonicalUuid,
} from '../../domain/canonicalUuid';
import type { Artifact } from '../../domain/models';
import type { NativeAdapter } from '../../domain/nativeAdapter';
import { DEVELOPMENT_RESET_CONFIRMATION } from './contracts';
import type {
  ArtifactRecordRepository,
  ArtifactFileUsage,
  ArtifactFileVerification,
  AtomicArtifactFileStore,
  CleanupLeaseRepository,
  OwnedArtifactFile,
  OwnedArtifactFileStore,
  QuarantinedArtifactFile,
  QuarantinePurgeResult,
  RecoveryDiagnosticsRepository,
  DevelopmentResetRepository,
  PublishArtifactInput,
  PublishedArtifactFile,
  RegisterPublishedArtifactInput,
} from './contracts';
import { assertArtifact } from './modelCodec';
import { startCleanupLeaseHeartbeat } from './cleanupLeaseHeartbeat';
import { acquireArtifactLifecycleMutex } from './artifactLifecycleMutex';
import { monotonicNowMilliseconds } from './operationalLeaseClock';
import {
  isOwnedArtifactPath,
  isOwnedArtifactStorePath,
  ownedArtifactId,
  ownedArtifactPackId,
  ownedOriginalPath,
} from './ownedPaths';

export class NativeAtomicArtifactFileStore implements AtomicArtifactFileStore {
  constructor(private readonly native: NativeAdapter) {}

  async publishArtifact(
    input: PublishArtifactInput,
  ): Promise<PublishedArtifactFile> {
    assertPublishInput(input);
    return this.native.publishArtifact(
      input.sourceFileUri,
      input.relativePath,
      input.expectedByteCount,
      input.expectedSha256,
    );
  }

  async verifyArtifact(
    relativePath: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<ArtifactFileVerification> {
    assertVerificationInput(relativePath, expectedByteCount, expectedSha256);
    return this.native.verifyArtifact(
      relativePath,
      expectedByteCount,
      expectedSha256,
    );
  }

  listOwnedFiles(): Promise<readonly OwnedArtifactFile[]> {
    return this.native.listOwnedArtifacts();
  }

  async removeOwnedFile(relativePath: string): Promise<void> {
    assertOwnedPath(relativePath);
    await this.native.removeOwnedArtifact(relativePath);
  }

  async quarantineOwnedFile(
    relativePath: string,
  ): Promise<QuarantinedArtifactFile | null> {
    assertOwnedPath(relativePath);
    const result = await this.native.quarantineOwnedArtifact(relativePath);
    if (!result.quarantined) return null;
    if (
      result.quarantineId === undefined ||
      result.anonymousId === undefined ||
      result.byteCount === undefined
    )
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
    return {
      quarantineId: result.quarantineId,
      anonymousId: result.anonymousId,
      byteCount: result.byteCount,
    };
  }

  purgeQuarantine(olderThanEpochMs: number): Promise<QuarantinePurgeResult> {
    if (!Number.isSafeInteger(olderThanEpochMs) || olderThanEpochMs < 0)
      throw new DomainError('SCHEMA_INVALID');
    return this.native.purgeArtifactQuarantine(olderThanEpochMs);
  }

  getStorageUsage(): Promise<ArtifactFileUsage> {
    return this.native.getArtifactStorageUsage();
  }
}

export interface PublishAndRegisterArtifactInput {
  readonly packId: string;
  readonly sourceFileUri: string;
  readonly artifact: Artifact;
  readonly budgetOptimizationFence?: RegisterPublishedArtifactInput['budgetOptimizationFence'];
}

/** Makes bytes domain-visible only after native hash verification and DB commit. */
export class PublishedArtifactCoordinator {
  constructor(
    private readonly repository: ArtifactRecordRepository &
      RecoveryDiagnosticsRepository &
      CleanupLeaseRepository,
    private readonly files: AtomicArtifactFileStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly leaseDurationMs = 5 * 60 * 1_000,
    private readonly monotonicNow: () => number = monotonicNowMilliseconds,
  ) {}

  async publish(
    input: PublishAndRegisterArtifactInput,
  ): Promise<'created' | 'replayed'> {
    assertPublishAndRegisterInput(input);
    // The lease owner is an acquisition token, not the stable artifact ID.
    // A replay after expiry must not let an older suspended publisher renew or
    // release the replacement publisher's lease (ABA fencing).
    const publicationOwnerId = createCanonicalUuid();
    const acquiredAt = this.now();
    const lease = await this.repository.acquireCleanupLease(
      publicationOwnerId,
      acquiredAt,
      new Date(Date.parse(acquiredAt) + this.leaseDurationMs).toISOString(),
    );
    if (!lease) throw new DomainError('PERSISTENCE_CONFLICT');
    const heartbeat = startCleanupLeaseHeartbeat(
      this.repository,
      publicationOwnerId,
      acquiredAt,
      this.leaseDurationMs,
      this.now,
      this.monotonicNow,
    );
    const releaseLifecycleMutex = await acquireArtifactLifecycleMutex();
    try {
      heartbeat.assertOwned();
      const published = await this.files.publishArtifact({
        sourceFileUri: input.sourceFileUri,
        relativePath: input.artifact.relativePath,
        expectedByteCount: input.artifact.byteCount,
        expectedSha256: input.artifact.sha256,
      });
      heartbeat.assertOwned();
      if (
        published.relativePath !== input.artifact.relativePath ||
        published.byteCount !== input.artifact.byteCount ||
        published.sha256 !== input.artifact.sha256
      )
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      try {
        const result = await this.repository.registerPublishedArtifact({
          packId: input.packId,
          artifact: input.artifact,
          ...(input.budgetOptimizationFence
            ? { budgetOptimizationFence: input.budgetOptimizationFence }
            : {}),
          publicationLeaseOwnerId: publicationOwnerId,
        });
        heartbeat.assertOwned();
        return result;
      } catch (error) {
        try {
          await this.repository.recordRecoveryDiagnostic({
            id: input.artifact.id,
            scope: 'artifact',
            anonymousId: input.artifact.id,
            code: 'PIPELINE_RECOVERY_REQUIRED',
            phase: 'database-registration',
            occurredAt: this.now(),
            byteCount: input.artifact.byteCount,
          });
        } catch {
          // The immutable file remains an orphan so startup cleanup can
          // quarantine it; diagnostics must not replace the causal DB error.
        }
        throw error;
      }
    } finally {
      try {
        const heartbeatFailure = await heartbeat.stop();
        try {
          await this.repository.releaseCleanupLease(publicationOwnerId);
        } catch {
          await recordDiagnosticBestEffort(this.repository, {
            id: input.artifact.id,
            scope: 'cleanup',
            anonymousId: input.artifact.id,
            code: 'STORAGE_WRITE_FAILED',
            phase: 'publication-lease-release',
            occurredAt: this.now(),
            byteCount: input.artifact.byteCount,
          });
        }
        if (heartbeatFailure !== undefined)
          throw new DomainError('PERSISTENCE_CONFLICT');
      } finally {
        releaseLifecycleMutex();
      }
    }
  }
}

export interface ArtifactIntegrityIssue {
  readonly artifactId: string;
  readonly status: 'missing' | 'mismatch' | 'verification-failed';
}

export interface ArtifactIntegrityAuditResult {
  readonly verified: number;
  readonly issues: readonly ArtifactIntegrityIssue[];
}

/** Detects database/file divergence without exposing paths or crashing startup. */
export class ArtifactIntegrityAuditor {
  constructor(
    private readonly repository: ArtifactRecordRepository &
      RecoveryDiagnosticsRepository,
    private readonly files: AtomicArtifactFileStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(): Promise<ArtifactIntegrityAuditResult> {
    const artifacts = await this.repository.listArtifactRecords();
    const issues: ArtifactIntegrityIssue[] = [];
    let verified = 0;
    for (const artifact of artifacts) {
      const occurredAt = this.now();
      let result: ArtifactFileVerification;
      try {
        result = await this.files.verifyArtifact(
          artifact.relativePath,
          artifact.byteCount,
          artifact.sha256,
        );
      } catch {
        issues.push({
          artifactId: artifact.id,
          status: 'verification-failed',
        });
        await recordDiagnosticBestEffort(this.repository, {
          id: artifact.id,
          scope: 'artifact',
          anonymousId: artifact.id,
          code: 'STORAGE_WRITE_FAILED',
          phase: 'verification-failed',
          occurredAt,
          byteCount: artifact.byteCount,
        });
        continue;
      }
      if (result.status === 'verified') {
        try {
          await this.repository.markArtifactVerified(artifact.id, occurredAt);
          verified += 1;
        } catch {
          issues.push({
            artifactId: artifact.id,
            status: 'verification-failed',
          });
          await recordDiagnosticBestEffort(this.repository, {
            id: artifact.id,
            scope: 'artifact',
            anonymousId: artifact.id,
            code: 'STORAGE_WRITE_FAILED',
            phase: 'verification-metadata',
            occurredAt,
            byteCount: artifact.byteCount,
          });
        }
        continue;
      }
      issues.push({ artifactId: artifact.id, status: result.status });
      await recordDiagnosticBestEffort(this.repository, {
        id: artifact.id,
        scope: 'artifact',
        anonymousId: artifact.id,
        code: 'STORAGE_DIVERGENCE_DETECTED',
        phase:
          result.status === 'missing' ? 'artifact-missing' : 'hash-mismatch',
        occurredAt,
        byteCount: artifact.byteCount,
      });
    }
    return { verified, issues };
  }
}

async function recordDiagnosticBestEffort(
  repository: RecoveryDiagnosticsRepository,
  input: Parameters<
    RecoveryDiagnosticsRepository['recordRecoveryDiagnostic']
  >[0],
): Promise<void> {
  try {
    await repository.recordRecoveryDiagnostic(input);
  } catch {
    // Integrity issues remain recoverable even when their metadata write fails.
  }
}

export interface ProductionStorageUsage {
  readonly database: Awaited<
    ReturnType<RecoveryDiagnosticsRepository['getStorageUsage']>
  >;
  readonly files: ArtifactFileUsage;
  readonly divergent: boolean;
}

export class ProductionStorageUsageService {
  constructor(
    private readonly repository: RecoveryDiagnosticsRepository,
    private readonly files: AtomicArtifactFileStore,
  ) {}

  async getStorageUsage(): Promise<ProductionStorageUsage> {
    const [database, files] = await Promise.all([
      this.repository.getStorageUsage(),
      this.files.getStorageUsage(),
    ]);
    return {
      database,
      files,
      divergent:
        database.artifactCount !== files.artifactCount ||
        database.artifactBytes !== files.artifactBytes ||
        database.quarantineCount !== files.quarantineCount ||
        database.quarantineBytes !== files.quarantineBytes,
    };
  }
}

/** Explicit development-only reset; it is never selected as recovery policy. */
export class DevelopmentPersistenceResetCoordinator {
  constructor(
    private readonly repository: DevelopmentResetRepository,
    private readonly files: OwnedArtifactFileStore,
  ) {}

  async reset(
    confirmation: typeof DEVELOPMENT_RESET_CONFIRMATION,
  ): Promise<void> {
    if (confirmation !== DEVELOPMENT_RESET_CONFIRMATION)
      throw new DomainError('DEVELOPMENT_RESET_FORBIDDEN');
    const files = await this.files.listOwnedFiles();
    for (const file of files)
      await this.files.quarantineOwnedFile(file.relativePath);
    await this.files.purgeQuarantine(Number.MAX_SAFE_INTEGER);
    await this.repository.resetForDevelopment(confirmation);
  }
}

function assertPublishInput(input: PublishArtifactInput): void {
  if (
    !input.sourceFileUri.startsWith('file://') ||
    !isOwnedArtifactPath(input.relativePath) ||
    (input.expectedByteCount !== undefined &&
      (!Number.isSafeInteger(input.expectedByteCount) ||
        input.expectedByteCount < 0)) ||
    (input.expectedSha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(input.expectedSha256))
  )
    throw new DomainError('SCHEMA_INVALID');
}

function assertVerificationInput(
  relativePath: string,
  expectedByteCount: number,
  expectedSha256: string,
): void {
  if (
    !isOwnedArtifactPath(relativePath) ||
    !Number.isSafeInteger(expectedByteCount) ||
    expectedByteCount < 0 ||
    !/^[0-9a-f]{64}$/.test(expectedSha256)
  )
    throw new DomainError('SCHEMA_INVALID');
}

function assertOwnedPath(relativePath: string): void {
  if (!isOwnedArtifactStorePath(relativePath))
    throw new DomainError('SCHEMA_INVALID');
}

function assertPublishAndRegisterInput(
  input: PublishAndRegisterArtifactInput,
): void {
  assertArtifact(input.artifact);
  if (
    input.budgetOptimizationFence !== undefined &&
    (!isCanonicalUuid(input.budgetOptimizationFence.planId) ||
      !Number.isSafeInteger(input.budgetOptimizationFence.expectedRevision) ||
      input.budgetOptimizationFence.expectedRevision < 1)
  )
    throw new DomainError('SCHEMA_INVALID');
  const area = input.artifact.relativePath.split('/')[2];
  const expectedArea =
    input.artifact.kind === 'original'
      ? 'originals'
      : input.artifact.kind === 'preview'
      ? 'previews'
      : input.artifact.kind === 'export'
      ? 'exports'
      : 'derived';
  if (
    ownedArtifactPackId(input.artifact.relativePath) !== input.packId ||
    ownedArtifactId(input.artifact.relativePath) !== input.artifact.id ||
    area !== expectedArea ||
    (input.artifact.kind === 'original' &&
      (input.artifact.itemId === undefined ||
        input.artifact.id !== input.artifact.itemId ||
        input.artifact.relativePath !==
          ownedOriginalPath(input.packId, input.artifact.itemId)))
  )
    throw new DomainError('SCHEMA_INVALID');
  assertPublishInput({
    sourceFileUri: input.sourceFileUri,
    relativePath: input.artifact.relativePath,
    expectedByteCount: input.artifact.byteCount,
    expectedSha256: input.artifact.sha256,
  });
}
