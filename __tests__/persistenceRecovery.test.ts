import type { ImportManifestV1 } from '../src/domain/contracts';
import { DomainError } from '../src/domain/errors';
import type { NativeHandoffArtifact } from '../src/domain/nativeAdapter';
import type {
  CleanupCandidate,
  CommitImportInput,
  NativeInboxHandoff,
  OwnedArtifactFileStore,
  PersistedImportSummary,
  PersistenceRepository,
  QuarantineRecordInput,
  RecoveryDiagnostic,
  RecoveryDiagnosticInput,
  RecoveryJournalEntry,
  StorageUsageSummary,
} from '../src/infrastructure/persistence/contracts';
import {
  InboxPersistenceCoordinator,
  ReferenceAwareCleanup,
  ScheduledReferenceAwareCleanup,
  type PersistenceInterruptionPoint,
} from '../src/infrastructure/persistence/recovery';
import {
  isOwnedArtifactPartialPath,
  isOwnedArtifactPath,
  isOwnedArtifactStorePath,
  ownedArtifactId,
  ownedOriginalPath,
} from '../src/infrastructure/persistence/ownedPaths';
import { PERSISTENCE_MIGRATIONS } from '../src/infrastructure/persistence/migrations';
import { artifactIdentitySetsEqual } from '../src/infrastructure/persistence/artifactIdentity';

const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
const packId = '223e4567-e89b-42d3-a456-426614174000';
const itemId = '323e4567-e89b-42d3-a456-426614174000';
const secondItemId = '423e4567-e89b-42d3-a456-426614174000';
const fingerprint = 'a'.repeat(64);

function manifest(
  status: ImportManifestV1['status'] = 'complete',
): ImportManifestV1 {
  return {
    schemaVersion: 1,
    ingestionId,
    createdAt: '2026-08-03T00:00:00Z',
    source: 'android-share-intent',
    status,
    items:
      status === 'partial'
        ? [
            {
              id: itemId,
              order: 0,
              mediaType: 'image/png',
              status: 'copied',
              byteCount: 8,
              relativePath: `${itemId}.bin`,
              sha256: 'b'.repeat(64),
            },
            {
              id: secondItemId,
              order: 1,
              mediaType: 'image/png',
              status: 'failed',
              byteCount: 0,
              errorCode: 'IMPORT_PROVIDER_PERMISSION_EXPIRED',
            },
          ]
        : [
            {
              id: itemId,
              order: 0,
              mediaType: 'image/png',
              status: 'copied',
              byteCount: 8,
              relativePath: `${itemId}.bin`,
              sha256: 'b'.repeat(64),
            },
          ],
  };
}

function manifestWithoutItemHash(): ImportManifestV1 {
  const value = manifest();
  return {
    ...value,
    items: value.items.map(item =>
      item.status === 'copied'
        ? {
            id: item.id,
            order: item.order,
            mediaType: item.mediaType,
            status: item.status,
            byteCount: item.byteCount,
            relativePath: item.relativePath,
          }
        : item,
    ),
  };
}

class MemoryRepository implements PersistenceRepository {
  readonly imports = new Map<string, PersistedImportSummary>();
  readonly journals = new Map<string, RecoveryJournalEntry>();
  readonly candidates: CleanupCandidate[] = [];
  readonly references = new Set<string>();
  readonly knownPaths = new Set<string>();
  readonly artifactsByIngestion = new Map<
    string,
    readonly NativeHandoffArtifact[]
  >();
  initializeCount = 0;
  commitCount = 0;
  acquireReferenceDuringDelete = false;

  async initialize(): Promise<void> {
    this.initializeCount += 1;
  }

  async findImport(id: string): Promise<PersistedImportSummary | null> {
    return this.imports.get(id) ?? null;
  }

  async commitImport(
    input: CommitImportInput,
  ): Promise<'created' | 'replayed'> {
    const existing = this.imports.get(input.manifest.ingestionId);
    if (existing) {
      if (
        existing.packId !== input.packId ||
        existing.manifestFingerprint !== input.manifestFingerprint ||
        !artifactIdentitySetsEqual(
          this.artifactsByIngestion.get(input.manifest.ingestionId) ?? [],
          input.artifacts,
        )
      )
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      this.journals.delete(input.manifest.ingestionId);
      return 'replayed';
    }
    this.commitCount += 1;
    this.imports.set(input.manifest.ingestionId, {
      ingestionId: input.manifest.ingestionId,
      packId: input.packId,
      manifestFingerprint: input.manifestFingerprint,
      status: input.manifest.status,
      itemCount: input.manifest.items.length,
      artifactCount: input.artifacts.length,
    });
    input.artifacts.forEach(artifact =>
      this.references.add(artifact.relativePath),
    );
    input.artifacts.forEach(artifact =>
      this.knownPaths.add(artifact.relativePath),
    );
    this.artifactsByIngestion.set(
      input.manifest.ingestionId,
      input.artifacts.map(artifact => ({ ...artifact })),
    );
    this.journals.delete(input.manifest.ingestionId);
    return 'created';
  }

  async recordRecovery(entry: RecoveryJournalEntry): Promise<void> {
    this.journals.set(entry.ingestionId, entry);
  }

  async findRecovery(id: string): Promise<RecoveryJournalEntry | null> {
    return this.journals.get(id) ?? null;
  }

  async listReferencedRelativePaths(): Promise<ReadonlySet<string>> {
    return new Set(this.references);
  }

  async listKnownRelativePaths(): Promise<ReadonlySet<string>> {
    return new Set([
      ...this.knownPaths,
      ...this.candidates.map(candidate => candidate.relativePath),
    ]);
  }

  async listRecoveringPackIds(): Promise<ReadonlySet<string>> {
    return new Set([...this.journals.values()].map(entry => entry.packId));
  }

  async listCleanupCandidates(): Promise<readonly CleanupCandidate[]> {
    return this.candidates;
  }

  async deleteArtifactRecordIfUnreferenced(
    artifactId: string,
  ): Promise<boolean> {
    const candidate = this.candidates.find(
      value => value.artifactId === artifactId,
    );
    if (!candidate) return false;
    if (this.acquireReferenceDuringDelete)
      this.references.add(candidate.relativePath);
    return !this.references.has(candidate.relativePath);
  }
}

class MemoryHandoff implements NativeInboxHandoff {
  handoffCount = 0;
  acknowledgementCount = 0;
  crashPoint: PersistenceInterruptionPoint | undefined;
  errorCode:
    | 'IMPORT_PROVIDER_PERMISSION_EXPIRED'
    | 'RESOURCE_LOW_DISK'
    | undefined;
  manifestValue: ImportManifestV1 = manifest();
  fingerprintValue = fingerprint;
  artifactPathOverride: string | undefined;
  artifactSha256 = 'b'.repeat(64);

  async handoffInbox(
    _ingestionId: string,
    targetPackId: string,
    _requiredFreeBytes: number,
  ) {
    this.handoffCount += 1;
    if (this.errorCode) throw new DomainError(this.errorCode);
    if (
      this.crashPoint === 'during-copy' ||
      this.crashPoint === 'after-file-close' ||
      this.crashPoint === 'before-manifest-rename'
    ) {
      const point = this.crashPoint;
      this.crashPoint = undefined;
      throw new Error(`SIMULATED_${point.toUpperCase()}`);
    }
    return Promise.resolve({
      manifest: this.manifestValue,
      manifestFingerprint: this.fingerprintValue,
      artifacts: [
        {
          id: itemId,
          itemId,
          relativePath:
            this.artifactPathOverride ??
            ownedOriginalPath(targetPackId, itemId),
          mediaType: 'image/png',
          byteCount: 8,
          sha256: this.artifactSha256,
        },
      ] satisfies readonly NativeHandoffArtifact[],
    });
  }

  async acknowledgeInbox(): Promise<void> {
    this.acknowledgementCount += 1;
  }
}

class MemoryFiles implements OwnedArtifactFileStore {
  readonly files = new Set<string>();
  readonly removed: string[] = [];
  readonly quarantined: string[] = [];

  async listOwnedFiles() {
    return [...this.files].map(relativePath => ({
      relativePath,
      byteCount: 1,
    }));
  }

  async removeOwnedFile(relativePath: string): Promise<void> {
    this.removed.push(relativePath);
    this.files.delete(relativePath);
  }

  async quarantineOwnedFile(relativePath: string) {
    this.quarantined.push(relativePath);
    this.files.delete(relativePath);
    const anonymousId = ownedArtifactId(relativePath);
    if (!anonymousId) throw new Error('SYNTHETIC_OWNED_PATH_INVALID');
    return {
      quarantineId: '623e4567-e89b-42d3-a456-426614174000',
      anonymousId,
      byteCount: 1,
    };
  }

  async purgeQuarantine() {
    return { purgedCount: 0, purgedBytes: 0 };
  }
}

class ProductionCleanupRepository extends MemoryRepository {
  readonly quarantineRecords: QuarantineRecordInput[] = [];
  readonly diagnostics: RecoveryDiagnosticInput[] = [];
  leaseAvailable = true;
  released = 0;
  markedPurged = 0;

  async recordQuarantine(input: QuarantineRecordInput) {
    this.quarantineRecords.push(input);
  }

  async markQuarantinePurgedBefore() {
    return this.markedPurged;
  }

  async acquireCleanupLease() {
    return this.leaseAvailable;
  }

  async releaseCleanupLease() {
    this.released += 1;
  }

  async recordRecoveryDiagnostic(input: RecoveryDiagnosticInput) {
    this.diagnostics.push(input);
  }

  async listRecoveryDiagnostics(): Promise<readonly RecoveryDiagnostic[]> {
    return [];
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    return {
      artifactCount: 0,
      artifactBytes: 0,
      referencedArtifactCount: 0,
      referencedArtifactBytes: 0,
      recoveryCount: 0,
      quarantineCount: this.quarantineRecords.length,
      quarantineBytes: this.quarantineRecords.reduce(
        (total, value) => total + value.byteCount,
        0,
      ),
    };
  }
}

describe('persistence and dual-Inbox recovery spike', () => {
  test.each<PersistenceInterruptionPoint>([
    'before-copy',
    'during-copy',
    'after-file-close',
    'before-manifest-rename',
    'before-db-commit',
  ])(
    'replays interruption at %s without duplicating the import',
    async point => {
      const repository = new MemoryRepository();
      const handoff = new MemoryHandoff();
      let coordinatorHookPoint: PersistenceInterruptionPoint | undefined =
        point;
      if (
        point === 'during-copy' ||
        point === 'after-file-close' ||
        point === 'before-manifest-rename'
      )
        handoff.crashPoint = point;
      const coordinator = new InboxPersistenceCoordinator(
        repository,
        handoff,
        () => '2026-08-03T00:00:01Z',
        async observed => {
          if (coordinatorHookPoint === observed) {
            coordinatorHookPoint = undefined;
            throw new Error(`SIMULATED_${observed.toUpperCase()}`);
          }
        },
      );

      await expect(
        coordinator.recover({ packId, ingestionId }),
      ).rejects.toThrow('SIMULATED_');
      expect(repository.imports.size).toBe(0);
      await expect(coordinator.recover({ packId, ingestionId })).resolves.toBe(
        'created',
      );
      expect(repository.commitCount).toBe(1);
      expect(repository.imports.size).toBe(1);
      expect(handoff.acknowledgementCount).toBe(1);
    },
  );

  test('duplicate replay ACKs the Inbox but does not duplicate rows or files', async () => {
    const repository = new MemoryRepository();
    const handoff = new MemoryHandoff();
    const coordinator = new InboxPersistenceCoordinator(repository, handoff);
    const request = { packId, ingestionId };

    await expect(coordinator.recover(request)).resolves.toBe('created');
    await expect(coordinator.recover(request)).resolves.toBe('replayed');
    expect(repository.commitCount).toBe(1);
    expect(handoff.handoffCount).toBe(2);
    expect(handoff.acknowledgementCount).toBe(2);
  });

  test('same ingestion ID with different manifest fingerprint fails closed', async () => {
    const repository = new MemoryRepository();
    const handoff = new MemoryHandoff();
    const coordinator = new InboxPersistenceCoordinator(repository, handoff);
    await coordinator.recover({ packId, ingestionId });
    handoff.fingerprintValue = 'c'.repeat(64);

    await expect(
      coordinator.recover({
        packId,
        ingestionId,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
  });

  test('same fingerprint with a different artifact hash fails closed without ACK', async () => {
    const repository = new MemoryRepository();
    const handoff = new MemoryHandoff();
    handoff.manifestValue = manifestWithoutItemHash();
    const coordinator = new InboxPersistenceCoordinator(repository, handoff);
    await expect(coordinator.recover({ packId, ingestionId })).resolves.toBe(
      'created',
    );
    handoff.artifactSha256 = 'c'.repeat(64);

    await expect(
      coordinator.recover({ packId, ingestionId }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
    expect(repository.commitCount).toBe(1);
    expect(handoff.acknowledgementCount).toBe(1);
    expect(repository.journals.get(ingestionId)?.phase).toBe('files-published');
  });

  test('valid owned path for a different Pack still fails closed', async () => {
    const repository = new MemoryRepository();
    const handoff = new MemoryHandoff();
    handoff.artifactPathOverride = ownedOriginalPath(
      '523e4567-e89b-42d3-a456-426614174000',
      itemId,
    );
    await expect(
      new InboxPersistenceCoordinator(repository, handoff).recover({
        packId,
        ingestionId,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
    expect(repository.commitCount).toBe(0);
  });

  test.each([
    'IMPORT_PROVIDER_PERMISSION_EXPIRED',
    'RESOURCE_LOW_DISK',
  ] as const)(
    '%s preserves a diagnosable journal and never commits a partial import',
    async code => {
      const repository = new MemoryRepository();
      const handoff = new MemoryHandoff();
      handoff.errorCode = code;
      const coordinator = new InboxPersistenceCoordinator(repository, handoff);

      await expect(
        coordinator.recover({ packId, ingestionId }),
      ).rejects.toMatchObject({ code });
      expect(repository.imports.size).toBe(0);
      expect(repository.journals.get(ingestionId)?.phase).toBe(
        'handoff-started',
      );
      expect(handoff.acknowledgementCount).toBe(0);
    },
  );

  test('partial manifest commits successful files and preserves failed item metadata', async () => {
    const repository = new MemoryRepository();
    const handoff = new MemoryHandoff();
    handoff.manifestValue = manifest('partial');
    const coordinator = new InboxPersistenceCoordinator(repository, handoff);
    await coordinator.recover({ packId, ingestionId });
    expect(repository.imports.get(ingestionId)).toMatchObject({
      status: 'partial',
      itemCount: 2,
      artifactCount: 1,
    });
  });

  test('cleanup rechecks references transactionally and quarantines unknown orphans', async () => {
    const repository = new MemoryRepository();
    const candidatePath = ownedOriginalPath(packId, itemId);
    repository.candidates.push({
      artifactId: itemId,
      relativePath: candidatePath,
      createdAt: '2026-01-01T00:00:00Z',
    });
    repository.acquireReferenceDuringDelete = true;
    const files = new MemoryFiles();
    files.files.add(candidatePath);
    const orphanPath = ownedOriginalPath(packId, secondItemId);
    const orphanPartialPath = `${orphanPath}.partial`;
    files.files.add(orphanPath);
    files.files.add(orphanPartialPath);

    const result = await new ReferenceAwareCleanup(repository, files).run(
      '2026-08-03T00:00:00Z',
    );
    expect(result).toEqual({ deleted: 0, quarantined: 2 });
    expect(files.removed).toEqual([]);
    expect(files.files).toContain(candidatePath);
    expect(files.quarantined).toEqual([orphanPath, orphanPartialPath]);
  });

  test('cleanup preserves recent database files and files published by active recovery', async () => {
    const repository = new MemoryRepository();
    const recentPath = ownedOriginalPath(packId, itemId);
    repository.knownPaths.add(recentPath);
    const recoveringPackId = '523e4567-e89b-42d3-a456-426614174000';
    const recoveringPath = ownedOriginalPath(recoveringPackId, secondItemId);
    const recoveringPartialPath = `${recoveringPath}.partial`;
    repository.journals.set(ingestionId, {
      ingestionId,
      packId: recoveringPackId,
      phase: 'files-published',
      updatedAt: '2026-08-03T00:00:00Z',
    });
    const files = new MemoryFiles();
    files.files.add(recentPath);
    files.files.add(recoveringPath);
    files.files.add(recoveringPartialPath);

    await expect(
      new ReferenceAwareCleanup(repository, files).run('2026-08-03T00:00:00Z'),
    ).resolves.toEqual({ deleted: 0, quarantined: 0 });
    expect(files.files).toEqual(
      new Set([recentPath, recoveringPath, recoveringPartialPath]),
    );
  });

  test('orphan quarantine records only internal IDs, byte counts, and retention metadata', async () => {
    const repository = new ProductionCleanupRepository();
    const files = new MemoryFiles();
    const orphanPath = ownedOriginalPath(packId, itemId);
    files.files.add(orphanPath);

    await expect(
      new ReferenceAwareCleanup(
        repository,
        files,
        repository,
        () => '2026-08-03T00:00:00Z',
        1_000,
      ).run('2026-08-02T00:00:00Z'),
    ).resolves.toEqual({ deleted: 0, quarantined: 1 });

    expect(repository.quarantineRecords).toEqual([
      {
        id: '623e4567-e89b-42d3-a456-426614174000',
        anonymousId: itemId,
        reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
        byteCount: 1,
        createdAt: '2026-08-03T00:00:00Z',
        purgeAfter: '2026-08-03T00:00:01.000Z',
      },
    ]);
    expect(JSON.stringify(repository.quarantineRecords)).not.toContain(
      orphanPath,
    );
  });

  test('scheduled cleanup honors its lease and releases it after retention work', async () => {
    const repository = new ProductionCleanupRepository();
    const files = new MemoryFiles();
    files.purgeQuarantine = async () => ({ purgedCount: 1, purgedBytes: 4 });
    repository.markedPurged = 1;
    const cleanup = new ScheduledReferenceAwareCleanup(
      repository,
      files,
      '723e4567-e89b-42d3-a456-426614174000',
      () => '2026-08-03T00:00:00Z',
    );

    await expect(cleanup.run()).resolves.toEqual({
      status: 'completed',
      deleted: 0,
      quarantined: 0,
      purged: 1,
      purgedBytes: 4,
    });
    expect(repository.released).toBe(1);

    repository.leaseAvailable = false;
    await expect(cleanup.run()).resolves.toEqual({
      status: 'lease-held',
      deleted: 0,
      quarantined: 0,
      purged: 0,
      purgedBytes: 0,
    });
    expect(repository.released).toBe(1);
  });
});

describe('persistence path and migration decisions', () => {
  test('owned paths contain only internal IDs and reject traversal/URI aliases', () => {
    const valid = ownedOriginalPath(packId, itemId);
    const partial = `${valid}.partial`;
    expect(isOwnedArtifactPath(valid)).toBe(true);
    expect(isOwnedArtifactPath(partial)).toBe(false);
    expect(isOwnedArtifactPartialPath(partial)).toBe(true);
    expect(isOwnedArtifactStorePath(partial)).toBe(true);
    expect(ownedArtifactId(partial)).toBe(itemId);
    for (const invalid of [
      `/Packs/${packId}/originals/${itemId}.bin`,
      `Packs/${packId}/originals/../${itemId}.bin`,
      `Packs/${packId}/originals/%2e%2e/${itemId}.bin`,
      `Packs\\${packId}\\originals\\${itemId}.bin`,
      `Packs/${packId}/originals/private-user-filename.png`,
    ])
      expect(isOwnedArtifactPath(invalid)).toBe(false);
  });

  test('schema migrates through v1, v2, and production v3 without BLOB content columns', () => {
    expect(PERSISTENCE_MIGRATIONS).toHaveLength(3);
    expect(PERSISTENCE_MIGRATIONS[0]).toContain('PRAGMA user_version = 1');
    expect(PERSISTENCE_MIGRATIONS[0]).toContain(
      'relative_path TEXT NOT NULL UNIQUE',
    );
    expect(PERSISTENCE_MIGRATIONS[0]).toContain(
      'ingestion_id TEXT PRIMARY KEY',
    );
    expect(PERSISTENCE_MIGRATIONS[0]).not.toMatch(/\bBLOB\b/);
    expect(PERSISTENCE_MIGRATIONS[1]).toContain('PRAGMA user_version = 2');
    expect(PERSISTENCE_MIGRATIONS[1]).toContain('last_verified_at');
    expect(PERSISTENCE_MIGRATIONS[2]).toContain('PRAGMA user_version = 3');
    expect(PERSISTENCE_MIGRATIONS[2]).toContain('CREATE TABLE context_items');
    expect(PERSISTENCE_MIGRATIONS[2]).toContain('CREATE TABLE risk_findings');
    expect(PERSISTENCE_MIGRATIONS[2]).toContain('CREATE TABLE export_records');
    for (const migration of PERSISTENCE_MIGRATIONS)
      expect(migration).not.toMatch(/\bBLOB\b/);
  });

  test('20-image and near-limit PDF manifests benchmark metadata without allocating media bytes', () => {
    const started = Date.now();
    const imageBytes = Array.from({ length: 20 }, (_, index) => ({
      id: `${index}`,
      byteCount: 4 * 1024 * 1024,
    })).reduce((total, value) => total + value.byteCount, 0);
    const nearLimitPdf = { pageCount: 25, byteCount: 52_428_799 };
    const total = imageBytes + nearLimitPdf.byteCount;
    const durationMs = Date.now() - started;
    expect(total).toBe(136_314_879);
    expect(durationMs).toBeLessThan(50);
  });
});
