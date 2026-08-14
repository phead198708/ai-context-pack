import { BUDGET_PRESETS } from '../src/domain/budgetOptimization';
import type { Artifact, ContextItem, ContextPack } from '../src/domain/models';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import { PackBudgetOptimizationService } from '../src/features/packLibrary/budgetOptimization';
import type {
  ProductionPersistenceRepository,
  RegisterPublishedArtifactInput,
  SavePackGraphInput,
} from '../src/infrastructure/persistence/contracts';

const packId = '123e4567-e89b-42d3-a456-426614174000';
const itemId = '223e4567-e89b-42d3-a456-426614174000';
const originalId = '323e4567-e89b-42d3-a456-426614174000';
const taskId = '423e4567-e89b-42d3-a456-426614174000';
const planId = '523e4567-e89b-42d3-a456-426614174000';
const derivativeId = '623e4567-e89b-42d3-a456-426614174000';
const secondItemId = '723e4567-e89b-42d3-a456-426614174000';
const secondOriginalId = '823e4567-e89b-42d3-a456-426614174000';
const secondTaskId = '923e4567-e89b-42d3-a456-426614174000';
const secondDerivativeId = 'a23e4567-e89b-42d3-a456-426614174000';

const pack: ContextPack = {
  id: packId,
  schemaVersion: 1,
  title: 'Budget fixture',
  userInstruction: '',
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
  state: 'review-required',
  budget: BUDGET_PRESETS.balanced,
  estimatedTokens: 0,
  orderedItemIds: [itemId],
  exportRecordIds: [],
  warningCodes: [],
};

const item: ContextItem = {
  id: itemId,
  packId,
  sourceType: 'image',
  mediaType: 'image/jpeg',
  originalSha256: 'a'.repeat(64),
  originalRelativePath: `Packs/${packId}/originals/${itemId}.bin`,
  artifactIds: [originalId],
  state: 'analyzed',
  riskFindingIds: [],
  inclusionMode: 'both',
  sortIndex: 0,
};

const original: Artifact = {
  id: originalId,
  itemId,
  kind: 'original',
  relativePath: item.originalRelativePath!,
  mediaType: 'image/jpeg',
  byteCount: 2_000_000,
  sha256: 'a'.repeat(64),
  processorVersion: {
    processor: 'fixture',
    version: '1',
    contractVersion: 1,
  },
  createdAt: pack.createdAt,
  immutable: true,
};

function fixture(
  now: () => string = () => '2026-08-14T00:00:01Z',
  includeSecondImage = false,
) {
  const secondItem: ContextItem = {
    ...item,
    id: secondItemId,
    originalSha256: 'c'.repeat(64),
    originalRelativePath: `Packs/${packId}/originals/${secondItemId}.bin`,
    artifactIds: [secondOriginalId],
    sortIndex: 1,
  };
  const secondOriginal: Artifact = {
    ...original,
    id: secondOriginalId,
    itemId: secondItemId,
    relativePath: secondItem.originalRelativePath!,
    sha256: secondItem.originalSha256!,
  };
  const sourceItems = includeSecondImage ? [item, secondItem] : [item];
  const artifacts: Artifact[] = includeSecondImage
    ? [original, secondOriginal]
    : [original];
  const saves: SavePackGraphInput[] = [];
  const registered: RegisterPublishedArtifactInput[] = [];
  const graph = () => ({
    pack: includeSecondImage
      ? { ...pack, orderedItemIds: [itemId, secondItemId] }
      : pack,
    items: sourceItems.map(sourceItem => ({
      ...sourceItem,
      artifactIds: artifacts
        .filter(value => value.itemId === sourceItem.id)
        .map(value => value.id),
    })),
    revision: 7,
  });
  const repository = {
    findPackGraph: jest.fn(async () => graph()),
    listArtifactRecords: jest.fn(async () => artifacts),
    findDuplicateAnalysis: jest.fn().mockResolvedValue({
      manifest: null,
      analyses: sourceItems.map(sourceItem => ({
        itemId: sourceItem.id,
        normalizedCharacterCount: 400,
        normalizedByteCount: 500,
      })),
      suggestions: [],
      decisions: [],
    }),
    acquireCleanupLease: jest.fn().mockResolvedValue(true),
    renewCleanupLease: jest.fn().mockResolvedValue(true),
    releaseCleanupLease: jest.fn().mockResolvedValue(undefined),
    registerPublishedArtifact: jest.fn(
      async (input: RegisterPublishedArtifactInput) => {
        registered.push(input);
        if (artifacts.some(artifact => artifact.id === input.artifact.id))
          return 'replayed' as const;
        artifacts.push(input.artifact);
        return 'created' as const;
      },
    ),
    recordRecoveryDiagnostic: jest.fn().mockResolvedValue(undefined),
    savePackGraph: jest.fn(async (input: SavePackGraphInput) => {
      saves.push(input);
      return 8;
    }),
  } as unknown as ProductionPersistenceRepository;
  const native = {
    available: true,
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/original.bin'),
    inspectImageForCompression: jest.fn(
      async (
        _taskId: string,
        _fileUri: string,
        sourceByteCount: number,
        sourceSha256: string,
      ) => ({
        schemaVersion: 1 as const,
        sourceByteCount,
        sourceSha256,
        sourceMediaType: 'image/jpeg',
        width: 2_000,
        height: 1_000,
        hasAlpha: false,
        animated: false as const,
        orientationApplied: true as const,
        revision: '1',
      }),
    ),
    compressImage: jest.fn(async request => ({
      schemaVersion: 1 as const,
      taskId: request.taskId,
      sourceSha256: request.expectedSha256,
      temporaryFileUri: `file:///temporary/${request.taskId}.jpg`,
      outputByteCount: 500_000,
      outputSha256:
        request.expectedSha256 === original.sha256
          ? 'b'.repeat(64)
          : 'd'.repeat(64),
      width: request.targetWidth,
      height: request.targetHeight,
      mediaType: request.outputMediaType,
      quality: request.quality,
      alphaPreserved: request.preserveAlpha,
      engine: 'android-bitmap' as const,
      revision: '1',
      durationMs: 12,
    })),
    cancelImageCompression: jest.fn().mockResolvedValue(undefined),
    finishImageCompression: jest.fn().mockResolvedValue(undefined),
    publishArtifact: jest.fn(
      async (
        _source: string,
        relativePath: string,
        expectedByteCount?: number,
        expectedSha256?: string,
      ) => ({
        relativePath,
        byteCount: expectedByteCount!,
        sha256: expectedSha256!,
        created: true,
      }),
    ),
  } as unknown as jest.Mocked<NativeAdapter>;
  const ids = includeSecondImage
    ? [taskId, secondTaskId, planId, derivativeId, secondDerivativeId]
    : [taskId, planId, derivativeId];
  const service = new PackBudgetOptimizationService(
    async () => repository,
    native,
    now,
    () => ids.shift()!,
  );
  return { service, native, repository, saves, registered };
}

test('previews metrics before encoding and publishes an immutable derivative', async () => {
  const { service, native, saves, registered } = fixture();

  const plan = await service.preview(packId, BUDGET_PRESETS.compact);

  expect(plan.planId).toBe(planId);
  expect(plan.estimate).toMatchObject({
    sourceBytes: 2_000_000,
    imageCount: 1,
    textCharacterCount: 400,
    estimatorVersion: 'context-budget-estimator-v1',
  });
  expect(plan.actions).toEqual([
    expect.objectContaining({
      kind: 'compress',
      outputArtifactId: derivativeId,
      targetWidth: 1_280,
      targetHeight: 640,
      outputMediaType: 'image/jpeg',
      preserveAlpha: false,
    }),
  ]);

  const result = await service.apply(plan);

  expect(result.actualOutputBytes).toBe(500_500);
  expect(native.finishImageCompression).toHaveBeenCalledWith(derivativeId);
  expect(registered[0]?.artifact).toMatchObject({
    id: derivativeId,
    itemId,
    kind: 'compressed-image',
    immutable: true,
    byteCount: 500_000,
    sha256: 'b'.repeat(64),
  });
  expect(saves[0]?.pack.budget.latestOptimization).toEqual(result);
  expect(saves[0]?.pack.estimatedTokens).toBe(plan.estimate.estimatedTokens);
  expect(saves[0]?.items[0]?.artifactIds).toEqual([originalId, derivativeId]);
});

test('always finishes the native temporary output when publication fails', async () => {
  const { service, native } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  native.publishArtifact.mockRejectedValueOnce(new Error('synthetic publish'));

  await expect(service.apply(plan)).rejects.toThrow('synthetic publish');
  expect(native.finishImageCompression).toHaveBeenCalledWith(derivativeId);
});

test('replays stable immutable metadata after a final Pack save failure', async () => {
  let tick = 1;
  const { service, repository, registered } = fixture(
    () => `2026-08-14T00:00:${String(tick++).padStart(2, '0')}Z`,
  );
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  (repository.savePackGraph as jest.Mock).mockRejectedValueOnce(
    new Error('synthetic Pack save'),
  );

  await expect(service.apply(plan)).rejects.toThrow('synthetic Pack save');
  await expect(service.apply(plan)).resolves.toMatchObject({
    planId: plan.planId,
  });

  const replayed = registered.filter(
    value => value.artifact.id === derivativeId,
  );
  expect(replayed).toHaveLength(2);
  expect(replayed.map(value => value.artifact.createdAt)).toEqual([
    plan.createdAt,
    plan.createdAt,
  ]);
  expect(replayed[1]?.artifact).toEqual(replayed[0]?.artifact);
});

test('replays a stable first derivative after the second publication fails', async () => {
  let tick = 1;
  const { service, native, registered } = fixture(
    () => `2026-08-14T00:01:${String(tick++).padStart(2, '0')}Z`,
    true,
  );
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  expect(plan.actions).toHaveLength(2);
  native.publishArtifact
    .mockImplementationOnce(
      async (
        _source: string,
        relativePath: string,
        expectedByteCount?: number,
        expectedSha256?: string,
      ) => ({
        relativePath,
        byteCount: expectedByteCount!,
        sha256: expectedSha256!,
        created: true,
      }),
    )
    .mockRejectedValueOnce(new Error('synthetic second publication'));

  await expect(service.apply(plan)).rejects.toThrow(
    'synthetic second publication',
  );
  await expect(service.apply(plan)).resolves.toMatchObject({
    planId: plan.planId,
  });

  const firstPublications = registered.filter(
    value => value.artifact.id === derivativeId,
  );
  expect(firstPublications).toHaveLength(2);
  expect(firstPublications[1]?.artifact).toEqual(
    firstPublications[0]?.artifact,
  );
  expect(firstPublications[0]?.artifact.createdAt).toBe(plan.createdAt);
});

test('previews and durably applies explicit item exclusions without encoding', async () => {
  const { service, native, saves } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact, [itemId]);

  expect(plan).toMatchObject({
    excludedItemIds: [itemId],
    actions: [],
    estimate: {
      sourceBytes: original.byteCount,
      predictedOutputBytes: 0,
      imageCount: 0,
    },
  });
  const result = await service.apply(plan);

  expect(result.actualOutputBytes).toBe(0);
  expect(result.actualSavingsBytes).toBe(original.byteCount);
  expect(native.compressImage).not.toHaveBeenCalled();
  expect(saves[0]?.items[0]?.inclusionMode).toBe('excluded');
});

const nonImageRepresentationCases = (['pdf', 'text', 'url'] as const).flatMap(
  sourceType =>
    (
      [
        ['original', 2_000_000],
        ['extracted', 1_000],
        ['both', 2_001_000],
        ['excluded', 0],
      ] as const
    ).map(([inclusionMode, expectedOutputBytes]) => ({
      sourceType,
      inclusionMode,
      expectedOutputBytes,
    })),
);

test.each(nonImageRepresentationCases)(
  'persists exact $sourceType/$inclusionMode representation bytes',
  async ({ sourceType, inclusionMode, expectedOutputBytes }) => {
    const mediaType =
      sourceType === 'pdf'
        ? 'application/pdf'
        : sourceType === 'text'
        ? 'text/plain'
        : 'text/uri-list';
    const sourceItem: ContextItem = {
      ...item,
      sourceType,
      mediaType,
      inclusionMode,
    };
    const sourceArtifact: Artifact = {
      ...original,
      mediaType,
    };
    const graph = { pack, items: [sourceItem], revision: 7 };
    const saves: SavePackGraphInput[] = [];
    const repository = {
      findPackGraph: jest.fn().mockResolvedValue(graph),
      listArtifactRecords: jest.fn().mockResolvedValue([sourceArtifact]),
      findDuplicateAnalysis: jest.fn().mockResolvedValue({
        manifest: null,
        analyses: [
          {
            itemId,
            normalizedCharacterCount: 1_000,
            normalizedByteCount: 1_000,
          },
        ],
        suggestions: [],
        decisions: [],
      }),
      savePackGraph: jest.fn(async (input: SavePackGraphInput) => {
        saves.push(input);
        return 8;
      }),
    } as unknown as ProductionPersistenceRepository;
    const native = {
      available: true,
      resolveOwnedArtifactFileUri: jest
        .fn()
        .mockResolvedValue('file:///owned/source.bin'),
      inspectPdf: jest.fn().mockResolvedValue({ pageCount: 10 }),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<NativeAdapter>;
    const includeOriginal =
      inclusionMode === 'original' || inclusionMode === 'both';
    const ids =
      sourceType === 'pdf' && includeOriginal ? [taskId, planId] : [planId];
    const service = new PackBudgetOptimizationService(
      async () => repository,
      native,
      () => '2026-08-14T00:00:01Z',
      () => ids.shift()!,
    );

    const plan = await service.preview(packId, BUDGET_PRESETS.compact);
    const result = await service.apply(plan);

    expect(plan.estimate).toMatchObject({
      sourceBytes: 2_000_000,
      predictedOutputBytes: expectedOutputBytes,
      pdfPageCount: sourceType === 'pdf' && includeOriginal ? 10 : 0,
      textCharacterCount:
        inclusionMode === 'extracted' || inclusionMode === 'both' ? 1_000 : 0,
    });
    expect(result.actualOutputBytes).toBe(expectedOutputBytes);
    expect(saves[0]?.pack.budget.latestOptimization).toEqual(result);
  },
);

test('persists an empty extracted representation as zero output bytes', async () => {
  const sourceItem: ContextItem = {
    ...item,
    sourceType: 'text',
    mediaType: 'text/plain',
    inclusionMode: 'extracted',
  };
  const graph = { pack, items: [sourceItem], revision: 7 };
  const saves: SavePackGraphInput[] = [];
  const repository = {
    findPackGraph: jest.fn().mockResolvedValue(graph),
    listArtifactRecords: jest
      .fn()
      .mockResolvedValue([{ ...original, mediaType: 'text/plain' }]),
    findDuplicateAnalysis: jest.fn().mockResolvedValue({
      manifest: null,
      analyses: [
        {
          itemId,
          normalizedCharacterCount: 0,
          normalizedByteCount: 0,
        },
      ],
      suggestions: [],
      decisions: [],
    }),
    savePackGraph: jest.fn(async (input: SavePackGraphInput) => {
      saves.push(input);
      return 8;
    }),
  } as unknown as ProductionPersistenceRepository;
  const native = {
    available: true,
  } as unknown as jest.Mocked<NativeAdapter>;
  const service = new PackBudgetOptimizationService(
    async () => repository,
    native,
    () => '2026-08-14T00:00:01Z',
    () => planId,
  );

  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  const result = await service.apply(plan);

  expect(plan.estimate.predictedOutputBytes).toBe(0);
  expect(result.actualOutputBytes).toBe(0);
  expect(saves[0]?.pack.budget.latestOptimization).toEqual(result);
});

test('cancels active native encoding and never publishes its late result', async () => {
  const { service, native } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  let release:
    | ((
        value: Awaited<ReturnType<NonNullable<NativeAdapter['compressImage']>>>,
      ) => void)
    | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  let releaseCancellation: (() => void) | undefined;
  const cancelImageCompression =
    native.cancelImageCompression as jest.MockedFunction<
      NonNullable<NativeAdapter['cancelImageCompression']>
    >;
  cancelImageCompression.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        releaseCancellation = () => resolve();
      }),
  );
  const compressImage = native.compressImage as jest.MockedFunction<
    NonNullable<NativeAdapter['compressImage']>
  >;
  compressImage.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        markStarted?.();
        release = resolve;
      }),
  );
  const cancellation = new AbortController();
  const pending = service.apply(plan, { signal: cancellation.signal });
  const rejection = pending.then(
    () => undefined,
    error => error,
  );
  await started;

  cancellation.abort();
  expect(native.cancelImageCompression).toHaveBeenCalledWith(derivativeId);
  release?.({
    schemaVersion: 1,
    taskId: derivativeId,
    sourceSha256: original.sha256,
    temporaryFileUri: 'file:///temporary/late-output.jpg',
    outputByteCount: 500_000,
    outputSha256: 'b'.repeat(64),
    width: 1_280,
    height: 640,
    mediaType: 'image/jpeg',
    quality: 0.7,
    alphaPreserved: false,
    engine: 'android-bitmap',
    revision: '1',
    durationMs: 12,
  });

  await Promise.resolve();
  expect(native.finishImageCompression).not.toHaveBeenCalled();
  releaseCancellation?.();

  await expect(rejection).resolves.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(native.publishArtifact).not.toHaveBeenCalled();
  expect(native.finishImageCompression).toHaveBeenCalledWith(derivativeId);
});
