import type { Artifact } from '../src/domain/models';
import type {
  ArtifactFileUsage,
  ArtifactFileVerification,
  ArtifactRecordRepository,
  AtomicArtifactFileStore,
  CleanupLeaseRepository,
  OwnedArtifactFile,
  PersistedArtifactRecord,
  PublishArtifactInput,
  PublishedArtifactFile,
  QuarantinedArtifactFile,
  QuarantinePurgeResult,
  RecoveryDiagnostic,
  RecoveryDiagnosticInput,
  RecoveryDiagnosticsRepository,
  RegisterPublishedArtifactInput,
  StorageUsageSummary,
} from '../src/infrastructure/persistence/contracts';
import {
  ArtifactIntegrityAuditor,
  DevelopmentPersistenceResetCoordinator,
  ProductionStorageUsageService,
  PublishedArtifactCoordinator,
} from '../src/infrastructure/persistence/artifactStore';
import { DEVELOPMENT_RESET_CONFIRMATION } from '../src/infrastructure/persistence/contracts';
import {
  ownedDerivedPath,
  ownedOriginalPath,
} from '../src/infrastructure/persistence/ownedPaths';

const packId = '123e4567-e89b-42d3-a456-426614174000';
const itemId = '223e4567-e89b-42d3-a456-426614174000';
const artifactId = '323e4567-e89b-42d3-a456-426614174000';
const now = '2026-08-05T00:00:00Z';

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: artifactId,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, artifactId, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: 'a'.repeat(64),
    processorVersion: {
      processor: 'fixture-ocr',
      version: '1.0.0',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
    ...overrides,
  };
}

class MemoryArtifactRepository
  implements
    ArtifactRecordRepository,
    RecoveryDiagnosticsRepository,
    CleanupLeaseRepository
{
  readonly artifacts: PersistedArtifactRecord[] = [];
  readonly diagnostics: RecoveryDiagnosticInput[] = [];
  readonly verified: string[] = [];
  registerError: Error | undefined;
  leaseHeld = false;

  async registerPublishedArtifact(input: RegisterPublishedArtifactInput) {
    if (this.registerError) throw this.registerError;
    const existing = this.artifacts.find(
      value => value.id === input.artifact.id,
    );
    if (existing) return 'replayed' as const;
    this.artifacts.push(input.artifact);
    return 'created' as const;
  }

  async listArtifactRecords() {
    return this.artifacts;
  }

  async markArtifactVerified(id: string) {
    this.verified.push(id);
  }

  async recordRecoveryDiagnostic(input: RecoveryDiagnosticInput) {
    this.diagnostics.push(input);
  }

  async listRecoveryDiagnostics(): Promise<readonly RecoveryDiagnostic[]> {
    return [];
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    return {
      artifactCount: this.artifacts.length,
      artifactBytes: this.artifacts.reduce(
        (total, value) => total + value.byteCount,
        0,
      ),
      referencedArtifactCount: this.artifacts.length,
      referencedArtifactBytes: this.artifacts.reduce(
        (total, value) => total + value.byteCount,
        0,
      ),
      recoveryCount: 0,
      quarantineCount: 0,
      quarantineBytes: 0,
    };
  }

  async acquireCleanupLease() {
    if (this.leaseHeld) return false;
    this.leaseHeld = true;
    return true;
  }

  async releaseCleanupLease() {
    this.leaseHeld = false;
  }
}

class MemoryArtifactFiles implements AtomicArtifactFileStore {
  readonly calls: string[] = [];
  verification: ArtifactFileVerification = {
    relativePath: ownedDerivedPath(packId, artifactId, 'txt'),
    status: 'verified',
    byteCount: 4,
    sha256: 'a'.repeat(64),
  };
  usage: ArtifactFileUsage = {
    artifactCount: 0,
    artifactBytes: 0,
    quarantineCount: 0,
    quarantineBytes: 0,
  };
  owned: OwnedArtifactFile[] = [];
  quarantined: string[] = [];
  purgeCutoff: number | undefined;

  async publishArtifact(
    input: PublishArtifactInput,
  ): Promise<PublishedArtifactFile> {
    this.calls.push('publish');
    return {
      relativePath: input.relativePath,
      byteCount: input.expectedByteCount ?? 0,
      sha256: input.expectedSha256 ?? '0'.repeat(64),
      created: true,
    };
  }

  async verifyArtifact(): Promise<ArtifactFileVerification> {
    this.calls.push('verify');
    return this.verification;
  }

  async listOwnedFiles(): Promise<readonly OwnedArtifactFile[]> {
    return [...this.owned];
  }

  async removeOwnedFile(): Promise<void> {
    this.calls.push('remove');
  }

  async quarantineOwnedFile(): Promise<QuarantinedArtifactFile | null> {
    const file = this.owned.shift();
    if (!file) return null;
    this.quarantined.push(file.relativePath);
    return {
      quarantineId: '423e4567-e89b-42d3-a456-426614174000',
      anonymousId: artifactId,
      byteCount: file.byteCount,
    };
  }

  async purgeQuarantine(
    olderThanEpochMs: number,
  ): Promise<QuarantinePurgeResult> {
    this.purgeCutoff = olderThanEpochMs;
    return { purgedCount: 0, purgedBytes: 0 };
  }

  async getStorageUsage(): Promise<ArtifactFileUsage> {
    return this.usage;
  }
}

describe('production ArtifactStore orchestration', () => {
  test('hash-verifies immutable bytes before making the artifact visible in SQLite', async () => {
    const repository = new MemoryArtifactRepository();
    const files = new MemoryArtifactFiles();
    const order: string[] = [];
    const originalRegister =
      repository.registerPublishedArtifact.bind(repository);
    repository.registerPublishedArtifact = async input => {
      order.push('database');
      return originalRegister(input);
    };
    files.publishArtifact = async input => {
      order.push('native');
      return {
        relativePath: input.relativePath,
        byteCount: 4,
        sha256: 'a'.repeat(64),
        created: true,
      };
    };

    await expect(
      new PublishedArtifactCoordinator(repository, files).publish({
        packId,
        sourceFileUri: 'file:///synthetic-source.txt',
        artifact: artifact(),
      }),
    ).resolves.toBe('created');

    expect(order).toEqual(['native', 'database']);
    expect(repository.artifacts).toEqual([artifact()]);
    expect(repository.leaseHeld).toBe(false);
    expect(files.calls).not.toContain('remove');
  });

  test('does not publish while cleanup owns the cross-caller lifecycle lease', async () => {
    const repository = new MemoryArtifactRepository();
    repository.leaseHeld = true;
    const files = new MemoryArtifactFiles();

    await expect(
      new PublishedArtifactCoordinator(repository, files, () => now).publish({
        packId,
        sourceFileUri: 'file:///synthetic-source.txt',
        artifact: artifact(),
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });

    expect(files.calls).toEqual([]);
    expect(repository.artifacts).toEqual([]);
  });

  test('rejects a second original identity before any native file mutation', async () => {
    const repository = new MemoryArtifactRepository();
    const files = new MemoryArtifactFiles();

    await expect(
      new PublishedArtifactCoordinator(repository, files, () => now).publish({
        packId,
        sourceFileUri: 'file:///synthetic-source.txt',
        artifact: artifact({
          kind: 'original',
          relativePath: ownedOriginalPath(packId, artifactId),
        }),
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });

    expect(files.calls).toEqual([]);
    expect(repository.leaseHeld).toBe(false);
  });

  test('keeps a published orphan recoverable when DB registration fails', async () => {
    const repository = new MemoryArtifactRepository();
    repository.registerError = new Error('synthetic-db-failure');
    const files = new MemoryArtifactFiles();

    await expect(
      new PublishedArtifactCoordinator(repository, files, () => now).publish({
        packId,
        sourceFileUri: 'file:///synthetic-source.txt',
        artifact: artifact(),
      }),
    ).rejects.toThrow('synthetic-db-failure');

    expect(repository.diagnostics).toEqual([
      expect.objectContaining({
        anonymousId: artifactId,
        code: 'PIPELINE_RECOVERY_REQUIRED',
        phase: 'database-registration',
      }),
    ]);
    expect(repository.leaseHeld).toBe(false);
    expect(files.calls).not.toContain('remove');
  });

  test.each(['missing', 'mismatch'] as const)(
    'represents %s database/file divergence without throwing',
    async status => {
      const repository = new MemoryArtifactRepository();
      repository.artifacts.push(artifact());
      const files = new MemoryArtifactFiles();
      files.verification = {
        relativePath: artifact().relativePath,
        status,
        ...(status === 'mismatch'
          ? { byteCount: 4, sha256: 'b'.repeat(64) }
          : {}),
      };

      await expect(
        new ArtifactIntegrityAuditor(repository, files, () => now).run(),
      ).resolves.toEqual({
        verified: 0,
        issues: [{ artifactId, status }],
      });
      expect(repository.diagnostics[0]).toMatchObject({
        anonymousId: artifactId,
        code: 'STORAGE_DIVERGENCE_DETECTED',
      });
    },
  );

  test('exposes DB and file totals with an explicit divergence bit', async () => {
    const repository = new MemoryArtifactRepository();
    repository.artifacts.push(artifact());
    const files = new MemoryArtifactFiles();
    files.usage = {
      artifactCount: 2,
      artifactBytes: 8,
      quarantineCount: 0,
      quarantineBytes: 0,
    };

    const usage = await new ProductionStorageUsageService(
      repository,
      files,
    ).getStorageUsage();

    expect(usage.database.artifactCount).toBe(1);
    expect(usage.files.artifactCount).toBe(2);
    expect(usage.divergent).toBe(true);
  });

  test('development reset is explicit and clears files before rebuilding SQLite', async () => {
    const files = new MemoryArtifactFiles();
    files.owned.push({ relativePath: artifact().relativePath, byteCount: 4 });
    files.owned.push({
      relativePath: `${artifact().relativePath}.partial`,
      byteCount: 2,
    });
    const calls: string[] = [];
    const resetRepository = {
      resetForDevelopment: async (
        confirmation: typeof DEVELOPMENT_RESET_CONFIRMATION,
      ) => {
        expect(confirmation).toBe(DEVELOPMENT_RESET_CONFIRMATION);
        calls.push('database');
      },
    };
    const reset = new DevelopmentPersistenceResetCoordinator(
      resetRepository,
      files,
    );

    await expect(reset.reset(DEVELOPMENT_RESET_CONFIRMATION)).resolves.toBe(
      undefined,
    );

    expect(files.quarantined).toEqual([
      artifact().relativePath,
      `${artifact().relativePath}.partial`,
    ]);
    expect(files.purgeCutoff).toBe(Number.MAX_SAFE_INTEGER);
    expect(calls).toEqual(['database']);
  });
});
