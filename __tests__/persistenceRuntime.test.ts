jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../src/infrastructure/nativeAdapter', () => ({
  nativeAdapter: {},
}));

import type {
  ImportManifestV1,
  NativePlainTextFileV1,
  OCRCapabilitiesV1,
  OCRResultV1,
  PDFDocumentInfoV1,
  PDFPageExtractionV1,
  PDFProbeResultV1,
} from '../src/domain/contracts';
import type {
  NativeAdapter,
  NativeArtifactStorageUsage,
  NativeHandoffResult,
} from '../src/domain/nativeAdapter';
import type {
  PendingShareEvent,
  RecoveryEvent,
} from '../src/domain/shareImportResult';
import type {
  CleanupCandidate,
  CommitImportInput,
  PersistedArtifactRecord,
  PersistedImportDetail,
  PersistedImportSummary,
  PersistedPackGraph,
  ProductionPersistenceRepository,
  QuarantineRecordInput,
  RecoveryDiagnostic,
  RecoveryDiagnosticInput,
  RecoveryJournalEntry,
  SavePackGraphInput,
  StorageUsageSummary,
} from '../src/infrastructure/persistence/contracts';
import {
  createEmptyDraftPack,
  ProductionInboxManifestProcessor,
} from '../src/infrastructure/persistence/runtime';
import { ownedOriginalPath } from '../src/infrastructure/persistence/ownedPaths';

const firstIngestion = '123e4567-e89b-42d3-a456-426614174000';
const secondIngestion = '223e4567-e89b-42d3-a456-426614174000';
const firstItem = '323e4567-e89b-42d3-a456-426614174000';
const secondItem = '423e4567-e89b-42d3-a456-426614174000';

function manifest(
  ingestionId: string,
  itemId: string,
  createdAt: string,
): ImportManifestV1 {
  return {
    schemaVersion: 1,
    ingestionId,
    createdAt,
    source: 'android-share-intent',
    status: 'complete',
    items: [
      {
        id: itemId,
        order: 0,
        mediaType: 'image/png',
        status: 'copied',
        byteCount: 4,
        relativePath: `${itemId}.bin`,
        sha256: 'a'.repeat(64),
      },
    ],
  };
}

function packGraph(id: string, createdAt: string): PersistedPackGraph {
  return {
    pack: {
      id,
      schemaVersion: 1,
      title: 'Context Pack',
      userInstruction: '',
      createdAt,
      updatedAt: createdAt,
      state: 'draft',
      budget: {
        preset: 'balanced',
        maxOutputBytes: 25 * 1024 * 1024,
        minimumImageLongestEdge: 1_280,
        imageQuality: 0.82,
        estimatorVersion: '1',
      },
      estimatedTokens: 0,
      orderedItemIds: [],
      exportRecordIds: [],
      warningCodes: [],
    },
    items: [],
    revision: 1,
  };
}

class RuntimeRepository implements ProductionPersistenceRepository {
  readonly imports = new Map<string, PersistedImportSummary>();
  readonly importDetails = new Map<string, PersistedImportDetail>();
  readonly recoveries = new Map<string, RecoveryJournalEntry>();
  readonly artifacts: PersistedArtifactRecord[] = [];
  readonly diagnostics: RecoveryDiagnosticInput[] = [];
  readonly commits: string[] = [];
  readonly quarantines: QuarantineRecordInput[] = [];
  readonly packGraphs: PersistedPackGraph[] = [];
  readonly savedPackInputs: SavePackGraphInput[] = [];
  createdCount = 0;
  leaseHeld = false;

  async initialize() {}

  async findImport(id: string) {
    return this.imports.get(id) ?? null;
  }

  async listImportDetails() {
    return [...this.importDetails.values()];
  }

  async commitImport(input: CommitImportInput) {
    this.commits.push(input.manifest.ingestionId);
    const existing = this.imports.get(input.manifest.ingestionId);
    this.recoveries.delete(input.manifest.ingestionId);
    if (existing) return 'replayed' as const;
    this.createdCount += 1;
    this.imports.set(input.manifest.ingestionId, {
      ingestionId: input.manifest.ingestionId,
      packId: input.packId,
      manifestFingerprint: input.manifestFingerprint,
      status: input.manifest.status,
      itemCount: input.manifest.items.length,
      artifactCount: input.artifacts.length,
    });
    this.importDetails.set(input.manifest.ingestionId, {
      ...this.imports.get(input.manifest.ingestionId)!,
      createdAt: input.manifest.createdAt,
      items: input.manifest.items.map(item => ({
        id: item.id,
        order: item.order,
        mediaType: item.mediaType,
        status: item.status,
        ...(item.status === 'failed' ? { errorCode: item.errorCode } : {}),
      })),
    });
    for (const value of input.artifacts)
      this.artifacts.push({
        ...value,
        kind: 'original',
        processorVersion: {
          processor: 'inbox-handoff',
          version: '1',
          contractVersion: 1,
        },
        createdAt: input.manifest.createdAt,
        lastVerifiedAt: input.manifest.createdAt,
        immutable: true,
      });
    return 'created' as const;
  }

  async recordRecovery(entry: RecoveryJournalEntry) {
    this.recoveries.set(entry.ingestionId, entry);
  }

  async findRecovery(id: string) {
    return this.recoveries.get(id) ?? null;
  }

  async listReferencedRelativePaths() {
    return new Set(this.artifacts.map(value => value.relativePath));
  }

  async listKnownRelativePaths() {
    return new Set(this.artifacts.map(value => value.relativePath));
  }

  async listRecoveringPackIds() {
    return new Set([...this.recoveries.values()].map(value => value.packId));
  }

  async listCleanupCandidates(): Promise<readonly CleanupCandidate[]> {
    return [];
  }

  async deleteArtifactRecordIfUnreferenced() {
    return false;
  }

  async findPackGraph(): Promise<PersistedPackGraph | null> {
    return null;
  }

  async listPackGraphs(): Promise<readonly PersistedPackGraph[]> {
    return this.packGraphs;
  }

  async savePackGraph(input: SavePackGraphInput) {
    this.savedPackInputs.push(input);
    return 1;
  }

  async deletePack() {
    return { removedItemCount: 0, releasedArtifactCount: 0 };
  }

  async startPipelineRun() {}

  async listRunnablePipelineRuns() {
    return [];
  }

  async markPipelineRunRunning() {
    return null;
  }

  async renewPipelineRunClaim() {
    return false;
  }

  async completePipelineRun() {
    return false;
  }

  async failPipelineRun() {
    return false;
  }

  async cancelPipelineRuns() {
    return 0;
  }

  async listItemsForPack() {
    return [];
  }

  async saveRiskFinding() {}

  async listRiskFindingsForItem() {
    return [];
  }

  async saveExportRecord() {}

  async listExportRecordsForPack() {
    return [];
  }

  async registerPublishedArtifact() {
    return 'created' as const;
  }

  async listArtifactRecords() {
    return this.artifacts;
  }

  async markArtifactVerified() {}

  async recordRecoveryDiagnostic(input: RecoveryDiagnosticInput) {
    this.diagnostics.push(input);
  }

  async listRecoveryDiagnostics(): Promise<readonly RecoveryDiagnostic[]> {
    return [];
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    const bytes = this.artifacts.reduce(
      (total, value) => total + value.byteCount,
      0,
    );
    return {
      artifactCount: this.artifacts.length,
      artifactBytes: bytes,
      referencedArtifactCount: this.artifacts.length,
      referencedArtifactBytes: bytes,
      recoveryCount: this.recoveries.size,
      quarantineCount: this.quarantines.length,
      quarantineBytes: this.quarantines.reduce(
        (total, value) => total + value.byteCount,
        0,
      ),
    };
  }

  async recordQuarantine(input: QuarantineRecordInput) {
    this.quarantines.push(input);
  }

  async markQuarantinePurgedBefore() {
    return 0;
  }

  async acquireCleanupLease() {
    if (this.leaseHeld) return false;
    this.leaseHeld = true;
    return true;
  }

  async acquireCleanupLeaseForPipelineRun() {
    return this.acquireCleanupLease();
  }

  async releaseCleanupLease() {
    this.leaseHeld = false;
  }

  async resetForDevelopment() {}
}

class RuntimeNative implements NativeAdapter {
  readonly available = true;
  readonly manifests = new Map<string, ImportManifestV1>();
  readonly handoffs: string[] = [];
  readonly acknowledgements: string[] = [];
  activeHandoffs = 0;
  maximumActiveHandoffs = 0;
  delayHandoffs = false;

  async scanInbox() {
    return [...this.manifests.values()];
  }

  async getPendingShareEvents(): Promise<readonly PendingShareEvent[]> {
    return [];
  }

  async ackPendingShareEvent() {}
  async ackEphemeralShareEvent() {}
  async getPendingRecoveryEvent(): Promise<RecoveryEvent | null> {
    return null;
  }
  async ackRecoveryEvent() {}

  async handoffInbox(
    ingestionId: string,
    packId: string,
  ): Promise<NativeHandoffResult> {
    this.activeHandoffs += 1;
    this.maximumActiveHandoffs = Math.max(
      this.maximumActiveHandoffs,
      this.activeHandoffs,
    );
    if (this.delayHandoffs)
      await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
    const value = this.manifests.get(ingestionId);
    if (!value) throw new Error('synthetic-manifest-missing');
    const copied = value.items[0];
    if (!copied || copied.status !== 'copied')
      throw new Error('synthetic-item-missing');
    this.handoffs.push(ingestionId);
    this.activeHandoffs -= 1;
    return {
      manifest: value,
      manifestFingerprint: ingestionId.replaceAll('-', '').padEnd(64, '0'),
      artifacts: [
        {
          id: copied.id,
          itemId: copied.id,
          relativePath: ownedOriginalPath(packId, copied.id),
          mediaType: copied.mediaType,
          byteCount: copied.byteCount,
          sha256: copied.sha256 ?? 'a'.repeat(64),
        },
      ],
    };
  }

  async acknowledgeInbox(id: string) {
    this.acknowledgements.push(id);
  }

  async publishMainAppImport(): Promise<ImportManifestV1> {
    throw new Error('unused-main-app-import');
  }

  async stageMainAppPickerFiles(fileUris: readonly string[]) {
    return fileUris;
  }

  async cleanupMainAppPickerTransients() {}

  async recoverMainAppPickerCache() {}

  async discardMainAppPickerFiles() {}

  async publishArtifact(
    _sourceFileUri: string,
    relativePath: string,
    expectedByteCount = 0,
    expectedSha256 = '0'.repeat(64),
  ) {
    return {
      relativePath,
      byteCount: expectedByteCount,
      sha256: expectedSha256,
      created: true,
    };
  }

  async resolveOwnedArtifactFileUri(relativePath: string) {
    return `file:///${relativePath}`;
  }

  async writeTextArtifact(relativePath: string) {
    return {
      relativePath,
      byteCount: 0,
      sha256: '0'.repeat(64),
      created: true,
    };
  }

  async verifyArtifact(
    relativePath: string,
    expectedByteCount: number,
    expectedSha256: string,
  ) {
    return {
      relativePath,
      status: 'verified' as const,
      byteCount: expectedByteCount,
      sha256: expectedSha256,
    };
  }

  async listOwnedArtifacts() {
    return [];
  }

  async removeOwnedArtifact() {}

  async quarantineOwnedArtifact() {
    return { quarantined: false } as const;
  }

  async purgeArtifactQuarantine() {
    return { purgedCount: 0, purgedBytes: 0 };
  }

  async getArtifactStorageUsage(): Promise<NativeArtifactStorageUsage> {
    return {
      artifactCount: 0,
      artifactBytes: 0,
      quarantineCount: 0,
      quarantineBytes: 0,
    };
  }

  async recognizeText(): Promise<OCRResultV1> {
    throw new Error('unused');
  }

  async getOCRCapabilities(): Promise<OCRCapabilitiesV1> {
    throw new Error('unused');
  }

  async cancelTextRecognition() {}

  async inspectPdf(): Promise<PDFDocumentInfoV1> {
    throw new Error('unused');
  }

  async extractPdfPage(): Promise<PDFPageExtractionV1> {
    throw new Error('unused');
  }

  async cancelPdfExtraction() {}

  async finishPdfExtraction() {}

  async readPlainTextFile(): Promise<NativePlainTextFileV1> {
    throw new Error('unused');
  }

  async probePdf(): Promise<PDFProbeResultV1> {
    throw new Error('unused');
  }
}

describe('production Inbox persistence runtime', () => {
  test('creates an intentionally empty Draft only through the explicit helper', async () => {
    const repository = new RuntimeRepository();
    const createdAt = new Date('2026-08-07T08:00:00.000Z');

    await expect(
      createEmptyDraftPack(
        () => createdAt,
        () => firstIngestion,
        async () => repository,
      ),
    ).resolves.toEqual({
      id: firstIngestion,
      schemaVersion: 1,
      title: 'Context Pack',
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      state: 'draft',
      itemCount: 0,
    });
    expect(repository.savedPackInputs).toEqual([
      expect.objectContaining({
        items: [],
        pack: expect.objectContaining({
          id: firstIngestion,
          orderedItemIds: [],
          state: 'draft',
        }),
      }),
    ]);
  });

  test('projects persisted Pack graphs for product hydration after Inbox ACK', async () => {
    const repository = new RuntimeRepository();
    repository.packGraphs.push(
      packGraph(firstIngestion, '2026-08-05T00:00:00Z'),
    );
    const processor = new ProductionInboxManifestProcessor(
      async () => repository,
      new RuntimeNative(),
    );

    await expect(processor.listPersistedPacks()).resolves.toEqual([
      {
        id: firstIngestion,
        schemaVersion: 1,
        title: 'Context Pack',
        createdAt: '2026-08-05T00:00:00Z',
        updatedAt: '2026-08-05T00:00:00Z',
        state: 'draft',
        itemCount: 0,
      },
    ]);
  });

  test('processes every manifest oldest-first and replays exactly once after app restart', async () => {
    const repository = new RuntimeRepository();
    const native = new RuntimeNative();
    const older = manifest(firstIngestion, firstItem, '2026-08-05T00:00:00Z');
    const newer = manifest(secondIngestion, secondItem, '2026-08-05T00:00:01Z');
    native.manifests.set(older.ingestionId, older);
    native.manifests.set(newer.ingestionId, newer);
    const repositoryFactory = async () => repository;

    await new ProductionInboxManifestProcessor(
      repositoryFactory,
      native,
    ).process([newer, older]);
    await new ProductionInboxManifestProcessor(
      repositoryFactory,
      native,
    ).process([newer, older]);

    expect(native.handoffs).toEqual([
      firstIngestion,
      secondIngestion,
      firstIngestion,
      secondIngestion,
    ]);
    expect(repository.createdCount).toBe(2);
    expect(repository.imports.size).toBe(2);
    expect(repository.commits).toHaveLength(4);
    expect(native.acknowledgements).toHaveLength(4);
  });

  test('serializes concurrent lifecycle scans on one app-lifetime processor', async () => {
    const repository = new RuntimeRepository();
    const native = new RuntimeNative();
    native.delayHandoffs = true;
    const older = manifest(firstIngestion, firstItem, '2026-08-05T00:00:00Z');
    const newer = manifest(secondIngestion, secondItem, '2026-08-05T00:00:01Z');
    native.manifests.set(older.ingestionId, older);
    native.manifests.set(newer.ingestionId, newer);
    const processor = new ProductionInboxManifestProcessor(
      async () => repository,
      native,
    );

    await Promise.all([processor.process([older]), processor.process([newer])]);

    expect(native.maximumActiveHandoffs).toBe(1);
    expect(native.handoffs).toEqual([firstIngestion, secondIngestion]);
  });
});
