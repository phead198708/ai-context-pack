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
  let sourceItems = includeSecondImage ? [item, secondItem] : [item];
  const artifacts: Artifact[] = includeSecondImage
    ? [original, secondOriginal]
    : [original];
  const saves: SavePackGraphInput[] = [];
  const registered: RegisterPublishedArtifactInput[] = [];
  let currentPack = includeSecondImage
    ? { ...pack, orderedItemIds: [itemId, secondItemId] }
    : pack;
  let currentRevision = 7;
  const graph = () => ({
    pack: currentPack,
    items: sourceItems.map(sourceItem => ({
      ...sourceItem,
      artifactIds: artifacts
        .filter(value => value.itemId === sourceItem.id)
        .map(value => value.id),
    })),
    revision: currentRevision,
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
      currentPack = input.pack;
      sourceItems = [...input.items];
      currentRevision += 1;
      return currentRevision;
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
    verifyArtifact: jest.fn(
      async (relativePath: string, byteCount: number, sha256: string) => ({
        relativePath,
        status: 'verified' as const,
        byteCount,
        sha256,
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
  return {
    service,
    native,
    repository,
    saves,
    registered,
    graph,
    advanceRevision: () => {
      currentRevision += 1;
    },
  };
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
  expect(registered[0]?.budgetOptimizationFence).toEqual({
    planId,
    expectedRevision: 8,
  });
  expect(saves[0]?.pack.budget.pendingOptimization).toEqual(plan);
  expect(saves.at(-1)?.pack.budget.latestOptimization).toEqual(result);
  expect(saves.at(-1)?.pack.budget.pendingOptimization).toBeUndefined();
  expect(saves.at(-1)?.pack.estimatedTokens).toBe(
    plan.estimate.estimatedTokens,
  );
  expect(saves.at(-1)?.items[0]?.artifactIds).toEqual([
    originalId,
    derivativeId,
  ]);
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
  const { service, native, repository, registered, graph } = fixture(
    () => `2026-08-14T00:00:${String(tick++).padStart(2, '0')}Z`,
  );
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  const save = repository.savePackGraph as jest.Mock;
  const commit = save.getMockImplementation()!;
  save
    .mockImplementationOnce(commit)
    .mockRejectedValueOnce(new Error('synthetic Pack save'));

  await expect(service.apply(plan)).rejects.toThrow('synthetic Pack save');
  const recoveredPlan = graph().pack.budget.pendingOptimization!;
  const restarted = new PackBudgetOptimizationService(
    async () => repository,
    native,
    () => `2026-08-14T00:01:${String(tick++).padStart(2, '0')}Z`,
  );
  await expect(restarted.apply(recoveredPlan)).resolves.toMatchObject({
    planId: plan.planId,
  });

  const replayed = registered.filter(
    value => value.artifact.id === derivativeId,
  );
  expect(replayed).toHaveLength(1);
  expect(replayed[0]?.artifact.createdAt).toBe(plan.createdAt);
  expect(native.compressImage).toHaveBeenCalledTimes(1);
  expect(native.verifyArtifact).toHaveBeenCalledWith(
    expect.stringContaining(derivativeId),
    500_000,
    'b'.repeat(64),
  );
});

test('fails closed when a registered checkpoint file is missing on recovery', async () => {
  const { service, native, repository, graph } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  const save = repository.savePackGraph as jest.Mock;
  const commit = save.getMockImplementation()!;
  save
    .mockImplementationOnce(commit)
    .mockRejectedValueOnce(new Error('synthetic Pack save'));

  await expect(service.apply(plan)).rejects.toThrow('synthetic Pack save');
  native.verifyArtifact.mockResolvedValueOnce({
    relativePath: `Packs/${packId}/derived/${derivativeId}.jpg`,
    status: 'missing',
  });
  const restarted = new PackBudgetOptimizationService(
    async () => repository,
    native,
  );

  await expect(
    restarted.apply(graph().pack.budget.pendingOptimization!),
  ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
  expect(native.compressImage).toHaveBeenCalledTimes(1);
});

test('rejects a pending plan after any later Pack revision', async () => {
  const { service, native, repository, graph, advanceRevision } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  native.resolveOwnedArtifactFileUri.mockRejectedValueOnce(
    new Error('synthetic URI failure'),
  );
  await expect(service.apply(plan)).rejects.toThrow('synthetic URI failure');
  const recoveredPlan = graph().pack.budget.pendingOptimization!;
  advanceRevision();
  const restarted = new PackBudgetOptimizationService(
    async () => repository,
    native,
  );

  await expect(
    restarted.preview(packId, BUDGET_PRESETS.compact),
  ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
  await expect(restarted.apply(recoveredPlan)).rejects.toMatchObject({
    code: 'PERSISTENCE_CONFLICT',
  });
  expect(native.compressImage).not.toHaveBeenCalled();
});

test('replays a stable first derivative after the second publication fails', async () => {
  let tick = 1;
  const { service, native, repository, registered, graph } = fixture(
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
  const recoveredPlan = graph().pack.budget.pendingOptimization!;
  const restarted = new PackBudgetOptimizationService(
    async () => repository,
    native,
    () => `2026-08-14T00:02:${String(tick++).padStart(2, '0')}Z`,
  );
  await expect(restarted.apply(recoveredPlan)).resolves.toMatchObject({
    planId: plan.planId,
  });

  const firstPublications = registered.filter(
    value => value.artifact.id === derivativeId,
  );
  expect(firstPublications).toHaveLength(1);
  expect(firstPublications[0]?.artifact.createdAt).toBe(plan.createdAt);
  expect(native.compressImage).toHaveBeenCalledTimes(3);
});

test('previews and durably applies explicit item exclusions without encoding', async () => {
  const { service, native, saves } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact, [itemId]);

  expect(plan).toMatchObject({
    excludedItemIds: [itemId],
    budget: {
      exclusions: [{ itemId, baselineInclusionMode: 'both' }],
    },
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
  expect(saves.at(-1)?.items[0]?.inclusionMode).toBe('excluded');
  expect(saves.at(-1)?.pack.budget.exclusions).toEqual([
    { itemId, baselineInclusionMode: 'both' },
  ]);
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
    let graph = { pack, items: [sourceItem], revision: 7 };
    const saves: SavePackGraphInput[] = [];
    const repository = {
      findPackGraph: jest.fn(async () => graph),
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
        graph = {
          pack: input.pack,
          items: [...input.items],
          revision: graph.revision + 1,
        };
        return graph.revision;
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
    expect(saves.at(-1)?.pack.budget.latestOptimization).toEqual(result);
  },
);

test('persists an empty extracted representation as zero output bytes', async () => {
  const sourceItem: ContextItem = {
    ...item,
    sourceType: 'text',
    mediaType: 'text/plain',
    inclusionMode: 'extracted',
  };
  let graph = { pack, items: [sourceItem], revision: 7 };
  const saves: SavePackGraphInput[] = [];
  const repository = {
    findPackGraph: jest.fn(async () => graph),
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
      graph = {
        pack: input.pack,
        items: [...input.items],
        revision: graph.revision + 1,
      };
      return graph.revision;
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
  expect(saves.at(-1)?.pack.budget.latestOptimization).toEqual(result);
});

const analysisReadinessCases = (
  ['image', 'pdf', 'text', 'url'] as const
).flatMap(sourceType =>
  (['original', 'extracted', 'both', 'excluded'] as const).flatMap(
    inclusionMode =>
      [false, true].map(analysisPresent => ({
        sourceType,
        inclusionMode,
        analysisPresent,
      })),
  ),
);

test.each(analysisReadinessCases)(
  'distinguishes analysis=$analysisPresent for $sourceType/$inclusionMode',
  async ({ sourceType, inclusionMode, analysisPresent }) => {
    const mediaType =
      sourceType === 'image'
        ? 'image/jpeg'
        : sourceType === 'pdf'
        ? 'application/pdf'
        : sourceType === 'url'
        ? 'text/uri-list'
        : 'text/plain';
    const sourceItem: ContextItem = {
      ...item,
      sourceType,
      mediaType,
      inclusionMode,
    };
    const repository = {
      findPackGraph: jest
        .fn()
        .mockResolvedValue({ pack, items: [sourceItem], revision: 7 }),
      listArtifactRecords: jest
        .fn()
        .mockResolvedValue([{ ...original, mediaType }]),
      findDuplicateAnalysis: jest.fn().mockResolvedValue({
        manifest: null,
        analyses: analysisPresent
          ? [
              {
                itemId,
                normalizedCharacterCount: 0,
                normalizedByteCount: 0,
              },
            ]
          : [],
        suggestions: [],
        decisions: [],
      }),
    } as unknown as ProductionPersistenceRepository;
    const native = {
      available: true,
      resolveOwnedArtifactFileUri: jest
        .fn()
        .mockResolvedValue('file:///owned/source.bin'),
      inspectPdf: jest.fn().mockResolvedValue({ pageCount: 2 }),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
      inspectImageForCompression: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        sourceByteCount: original.byteCount,
        sourceSha256: original.sha256,
        sourceMediaType: 'image/jpeg',
        width: 2_000,
        height: 1_000,
        hasAlpha: false,
        animated: false,
        orientationApplied: true,
        revision: '1',
      }),
    } as unknown as jest.Mocked<NativeAdapter>;
    let idCounter = 100;
    const service = new PackBudgetOptimizationService(
      async () => repository,
      native,
      () => '2026-08-14T00:00:01Z',
      () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`,
    );
    const needsAnalysis =
      inclusionMode === 'extracted' || inclusionMode === 'both';

    if (!analysisPresent && needsAnalysis) {
      await expect(
        service.preview(packId, BUDGET_PRESETS.compact),
      ).rejects.toMatchObject({ code: 'PIPELINE_RECOVERY_REQUIRED' });
      return;
    }
    const plan = await service.preview(packId, BUDGET_PRESETS.compact);
    expect(plan.estimate.textCharacterCount).toBe(0);
    if (inclusionMode === 'extracted' || inclusionMode === 'excluded')
      expect(plan.estimate.predictedOutputBytes).toBe(0);
  },
);

test('does not start native encoding after cancellation during URI resolution', async () => {
  const { service, native } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  let releaseUri: (() => void) | undefined;
  let markResolving: (() => void) | undefined;
  const resolving = new Promise<void>(resolve => (markResolving = resolve));
  native.resolveOwnedArtifactFileUri.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        markResolving?.();
        releaseUri = () => resolve('file:///owned/original.bin');
      }),
  );
  const cancellation = new AbortController();
  const pending = service.apply(plan, { signal: cancellation.signal });
  await resolving;

  cancellation.abort();
  releaseUri?.();

  await expect(pending).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(native.compressImage).not.toHaveBeenCalled();
});

test('checkpoints a published derivative when cancellation wins before Pack commit', async () => {
  const { service, native, registered, graph } = fixture();
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);
  let releasePublication: (() => void) | undefined;
  let markPublishing: (() => void) | undefined;
  const publishing = new Promise<void>(resolve => (markPublishing = resolve));
  native.publishArtifact.mockImplementationOnce(
    (_source, relativePath, expectedByteCount, expectedSha256) =>
      new Promise(resolve => {
        markPublishing?.();
        releasePublication = () =>
          resolve({
            relativePath,
            byteCount: expectedByteCount!,
            sha256: expectedSha256!,
            created: true,
          });
      }),
  );
  const cancellation = new AbortController();
  const pending = service.apply(plan, { signal: cancellation.signal });
  await publishing;

  cancellation.abort();
  releasePublication?.();

  await expect(pending).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(registered.map(value => value.artifact.id)).toEqual([derivativeId]);
  expect(graph().pack.budget.pendingOptimization).toEqual(plan);
  expect(graph().pack.budget.latestOptimization).toBeUndefined();
});

test('floors completion and Pack timestamps against the persisted plan', async () => {
  const times = [
    '2026-08-14T00:10:00.000000999Z',
    '2026-08-14T00:10:00.000000001Z',
    '2026-08-14T00:10:00.000000002Z',
    '2026-08-14T00:10:00.000000003Z',
    '2026-08-14T00:10:00.000000004Z',
  ];
  const { service, saves } = fixture(() => times.shift()!);
  const plan = await service.preview(packId, BUDGET_PRESETS.compact);

  const result = await service.apply(plan);

  expect(result.completedAt).toBe(plan.createdAt);
  expect(saves.at(-1)?.pack.updatedAt).toBe(plan.createdAt);
  expect(saves.at(-1)?.pack.budget.latestOptimization).toEqual(result);
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
