import type { Artifact, ContextItem, ContextPack } from '../src/domain/models';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import { DomainError } from '../src/domain/errors';
import type {
  PersistedArtifactRecord,
  PersistedPipelineRun,
  ProductionPersistenceRepository,
} from '../src/infrastructure/persistence/contracts';
import {
  CompositePackStageWorker,
  NativeDuplicateAnalysisStageWorker,
} from '../src/features/packLibrary/processing';

const packId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const extractedText =
  'Synthetic OCR content with   repeated spacing and enough text for a fingerprint.';
const normalizedText =
  'Synthetic OCR content with repeated spacing and enough text for a fingerprint.';

function pack(): ContextPack {
  return {
    id: packId,
    schemaVersion: 1,
    title: 'Synthetic analysis',
    userInstruction: '',
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
    state: 'processing',
    budget: {
      preset: 'balanced',
      maxOutputBytes: 10_485_760,
      minimumImageLongestEdge: 1_280,
      imageQuality: 0.82,
      estimatorVersion: 'v1',
    },
    estimatedTokens: 0,
    orderedItemIds: [itemId],
    exportRecordIds: [],
    warningCodes: [],
  };
}

const item: ContextItem = {
  id: itemId,
  packId,
  sourceType: 'image',
  mediaType: 'image/png',
  originalSha256: 'a'.repeat(64),
  originalRelativePath: `Packs/${packId}/originals/${itemId}.bin`,
  artifactIds: [itemId],
  state: 'extracted',
  riskFindingIds: [],
  inclusionMode: 'both',
  sortIndex: 0,
};

const original: PersistedArtifactRecord = {
  id: itemId,
  itemId,
  kind: 'original',
  relativePath: `Packs/${packId}/originals/${itemId}.bin`,
  mediaType: 'image/png',
  byteCount: 1_024,
  sha256: 'a'.repeat(64),
  processorVersion: {
    processor: 'fixture-import',
    version: '1',
    contractVersion: 1,
  },
  createdAt: '2026-08-11T00:00:00Z',
  immutable: true,
};

const extracted: PersistedArtifactRecord = {
  id: '44444444-4444-4444-8444-444444444444',
  itemId,
  kind: 'ocr-text',
  relativePath: `Packs/${packId}/derived/44444444-4444-4444-8444-444444444444.txt`,
  mediaType: 'text/plain',
  byteCount: 80,
  sha256: 'b'.repeat(64),
  processorVersion: {
    processor: 'fixture-ocr',
    version: '1',
    contractVersion: 1,
  },
  createdAt: '2026-08-11T00:00:01Z',
  immutable: true,
};

function repository(): jest.Mocked<ProductionPersistenceRepository> {
  return {
    findPackGraph: jest.fn().mockResolvedValue({
      pack: pack(),
      items: [item],
      revision: 3,
    }),
    listArtifactRecords: jest.fn().mockResolvedValue([original, extracted]),
    acquireCleanupLeaseForPipelineRun: jest.fn().mockResolvedValue(true),
    renewPipelineRunClaim: jest.fn().mockResolvedValue(true),
    renewCleanupLease: jest.fn().mockResolvedValue(true),
    releaseCleanupLease: jest.fn().mockResolvedValue(undefined),
    recordQuarantine: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ProductionPersistenceRepository>;
}

function native(): jest.Mocked<NativeAdapter> {
  return {
    available: true,
    verifyArtifact: jest.fn(async (relativePath, byteCount, sha256) => ({
      relativePath,
      status: 'verified' as const,
      byteCount,
      sha256,
    })),
    resolveOwnedArtifactFileUri: jest.fn(
      async relativePath => `file:///sandbox/${relativePath}`,
    ),
    readPlainTextFile: jest.fn(async uri => ({
      schemaVersion: 1,
      text: uri.endsWith(`/${runId}.txt`) ? normalizedText : extractedText,
      byteCount: uri.endsWith(`/${runId}.txt`) ? 78 : 80,
      encoding: 'utf-8' as const,
      revision: '1' as const,
    })),
    hashImagePerceptually: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      algorithm: 'dhash-64-v1',
      hash: '0123456789abcdef',
      sampleWidth: 9,
      sampleHeight: 8,
      orientationApplied: true,
      durationMs: 1,
      revision: '1',
    }),
    cancelImagePerceptualHash: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact: jest.fn().mockResolvedValue({
      relativePath: `Packs/${packId}/derived/${runId}.txt`,
      byteCount: 78,
      sha256: 'c'.repeat(64),
      created: true,
    }),
    quarantineOwnedArtifact: jest.fn(),
  } as unknown as jest.Mocked<NativeAdapter>;
}

function run(publishedArtifact?: Artifact): PersistedPipelineRun {
  return {
    id: runId,
    packId,
    itemId,
    stage: 'analyze',
    startedAt: '2026-08-11T00:00:02Z',
    status: 'running',
    updatedAt: '2026-08-11T00:00:02Z',
    claimVersion: 1,
    ...(publishedArtifact ? { publishedArtifact } : {}),
  };
}

test('analysis worker publishes a normalized derivative and matching versioned record', async () => {
  const repo = repository();
  const adapter = native();
  const worker = new NativeDuplicateAnalysisStageWorker(
    async () => repo,
    adapter,
    () => '2026-08-11T00:00:03Z',
    60_000,
  );
  const handle = worker.start(run());

  const [artifact, analysis] = await Promise.all([
    handle.result,
    handle.analysis,
  ]);

  expect(artifact).toMatchObject({
    id: runId,
    itemId,
    kind: 'normalized-text',
    sha256: 'c'.repeat(64),
  });
  expect(analysis).toMatchObject({
    schemaVersion: 1,
    packId,
    itemId,
    originalSha256: 'a'.repeat(64),
    normalizedArtifactId: runId,
    normalizedSha256: 'c'.repeat(64),
    imageFingerprint: { hash: '0123456789abcdef' },
    analyzedAt: '2026-08-11T00:00:03Z',
  });
  expect(adapter.writeTextArtifact).toHaveBeenCalledWith(
    `Packs/${packId}/derived/${runId}.txt`,
    normalizedText,
  );
  expect(adapter.hashImagePerceptually).toHaveBeenCalledWith(
    runId,
    `file:///sandbox/${original.relativePath}`,
    original.byteCount,
    original.sha256,
  );
  await handle.finalize?.();
  expect(repo.releaseCleanupLease).toHaveBeenCalledWith(
    handle.publicationLeaseOwnerId,
  );
});

test('analysis cancellation interrupts an active native perceptual hash by run ID', async () => {
  const repo = repository();
  const adapter = native();
  const hashImagePerceptually =
    adapter.hashImagePerceptually as jest.MockedFunction<
      NonNullable<NativeAdapter['hashImagePerceptually']>
    >;
  let rejectHash: ((error: unknown) => void) | undefined;
  hashImagePerceptually.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectHash = reject;
      }),
  );
  const worker = new NativeDuplicateAnalysisStageWorker(
    async () => repo,
    adapter,
  );
  const handle = worker.start(run());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (hashImagePerceptually.mock.calls.length > 0) break;
    await Promise.resolve();
  }
  expect(hashImagePerceptually).toHaveBeenCalledTimes(1);

  await handle.cancel();

  expect(adapter.cancelImagePerceptualHash).toHaveBeenCalledWith(runId);
  rejectHash?.(new DomainError('PIPELINE_STAGE_FAILED'));
  await expect(handle.result).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  await expect(handle.analysis).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(adapter.writeTextArtifact).not.toHaveBeenCalled();
  await handle.finalize?.();
});

test('analysis cancellation interrupts near-limit newline-dense normalization before native work', async () => {
  const repo = repository();
  const adapter = native();
  const maximumText = 'a\n'.repeat(8 * 1_024 * 1_024);
  repo.listArtifactRecords.mockResolvedValue([
    original,
    { ...extracted, byteCount: maximumText.length },
  ]);
  adapter.readPlainTextFile.mockResolvedValueOnce({
    schemaVersion: 1,
    text: maximumText,
    byteCount: maximumText.length,
    encoding: 'utf-8',
    revision: '1',
  });
  const worker = new NativeDuplicateAnalysisStageWorker(
    async () => repo,
    adapter,
  );
  const handle = worker.start(run());
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (adapter.readPlainTextFile.mock.calls.length > 0) break;
    await Promise.resolve();
  }
  expect(adapter.readPlainTextFile).toHaveBeenCalledTimes(1);
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  await handle.cancel();

  await expect(handle.result).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  await expect(handle.analysis).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(adapter.hashImagePerceptually).not.toHaveBeenCalled();
  expect(adapter.writeTextArtifact).not.toHaveBeenCalled();
  await handle.finalize?.();
});

test('analysis worker fails closed when extracted text bytes diverge from the verified artifact', async () => {
  const repo = repository();
  const adapter = native();
  adapter.readPlainTextFile.mockResolvedValueOnce({
    schemaVersion: 1,
    text: extractedText,
    byteCount: 79,
    encoding: 'utf-8',
    revision: '1',
  });
  const worker = new NativeDuplicateAnalysisStageWorker(
    async () => repo,
    adapter,
  );
  const handle = worker.start(run());

  await expect(handle.result).rejects.toMatchObject({
    code: 'ARTIFACT_INTEGRITY_FAILED',
  });
  await expect(handle.analysis).rejects.toMatchObject({
    code: 'ARTIFACT_INTEGRITY_FAILED',
  });
  await handle.finalize?.();
  expect(adapter.writeTextArtifact).not.toHaveBeenCalled();
});

test('analysis recovery binds a normalized checkpoint to its exact persisted content', async () => {
  const repo = repository();
  const adapter = native();
  adapter.readPlainTextFile
    .mockResolvedValueOnce({
      schemaVersion: 1,
      text: extractedText,
      byteCount: 80,
      encoding: 'utf-8',
      revision: '1',
    })
    .mockResolvedValueOnce({
      schemaVersion: 1,
      text: `${normalizedText} changed`,
      byteCount: 86,
      encoding: 'utf-8',
      revision: '1',
    });
  const checkpoint: Artifact = {
    id: runId,
    itemId,
    kind: 'normalized-text',
    relativePath: `Packs/${packId}/derived/${runId}.txt`,
    mediaType: 'text/plain',
    byteCount: 78,
    sha256: 'c'.repeat(64),
    processorVersion: {
      processor: 'shared-content-normalization',
      version: 'text-normalization-v1',
      contractVersion: 1,
    },
    createdAt: '2026-08-11T00:00:02Z',
    immutable: true,
  };
  const worker = new NativeDuplicateAnalysisStageWorker(
    async () => repo,
    adapter,
  );
  const handle = worker.start(run(checkpoint));

  await expect(handle.result).rejects.toMatchObject({
    code: 'ARTIFACT_INTEGRITY_FAILED',
  });
  await expect(handle.analysis).rejects.toMatchObject({
    code: 'ARTIFACT_INTEGRITY_FAILED',
  });
  await handle.finalize?.();
  expect(adapter.writeTextArtifact).not.toHaveBeenCalled();
});

test('composite routing exposes analyze exactly once and rejects unsupported stages', () => {
  const worker = new NativeDuplicateAnalysisStageWorker(
    async () => repository(),
    native(),
  );
  const composite = new CompositePackStageWorker([worker]);

  expect(composite.supports('analyze')).toBe(true);
  expect(composite.supports('review')).toBe(false);
  expect(() => composite.start({ ...run(), stage: 'review' })).toThrow(
    'PIPELINE_STAGE_FAILED',
  );
});
