import type { ContextItem, ContextPack } from '../src/domain/models';
import type {
  PersistedArtifactRecord,
  PersistedPackGraph,
  ProductionPersistenceRepository,
  SavePackGraphInput,
} from '../src/infrastructure/persistence/contracts';
import { PackLibraryController } from '../src/features/packLibrary/controller';
import type { PackProcessingScheduler } from '../src/features/packLibrary/processing';

const packId = '123e4567-e89b-42d3-a456-426614174000';
const firstId = '223e4567-e89b-42d3-a456-426614174000';
const secondId = '323e4567-e89b-42d3-a456-426614174000';
const thirdId = '423e4567-e89b-42d3-a456-426614174000';

function fixture(): PersistedPackGraph {
  const pack: ContextPack = {
    id: packId,
    schemaVersion: 1,
    title: 'Fixture',
    userInstruction: '',
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
    state: 'failed',
    budget: {
      preset: 'balanced',
      maxOutputBytes: 10_485_760,
      minimumImageLongestEdge: 1_280,
      imageQuality: 0.82,
      estimatorVersion: 'v1',
    },
    estimatedTokens: 0,
    orderedItemIds: [firstId, secondId],
    exportRecordIds: [],
    warningCodes: [],
  };
  const items: ContextItem[] = [firstId, secondId].map((id, sortIndex) => ({
    id,
    packId,
    sourceType: 'image',
    mediaType: 'image/png',
    originalSha256: String(sortIndex + 1).repeat(64),
    originalRelativePath: `Packs/${packId}/originals/${id}.bin`,
    artifactIds: [id],
    state: sortIndex === 1 ? 'failed' : 'imported',
    ...(sortIndex === 1 ? { retryStage: 'extract' as const } : {}),
    riskFindingIds: [],
    inclusionMode: 'original',
    sortIndex,
  }));
  return { pack, items, revision: 7 };
}

function original(itemId: string): PersistedArtifactRecord {
  return {
    id: itemId,
    itemId,
    kind: 'original',
    relativePath: `Packs/${packId}/originals/${itemId}.bin`,
    mediaType: 'image/png',
    byteCount: 10,
    sha256: 'a'.repeat(64),
    processorVersion: {
      processor: 'fixture',
      version: '1',
      contractVersion: 1,
    },
    createdAt: '2026-08-10T00:00:00Z',
    immutable: true,
  };
}

function repository(graph = fixture()) {
  const saves: SavePackGraphInput[] = [];
  const value = {
    findPackGraph: jest.fn().mockResolvedValue(graph),
    listPackGraphs: jest.fn().mockResolvedValue([graph]),
    listArtifactRecords: jest
      .fn()
      .mockResolvedValue([original(firstId), original(secondId)]),
    listImportDetails: jest.fn().mockResolvedValue([]),
    findDuplicateAnalysis: jest.fn().mockResolvedValue({
      manifest: null,
      analyses: [],
      suggestions: [],
      decisions: [],
    }),
    saveDuplicateDecisions: jest.fn().mockResolvedValue(undefined),
    restoreDuplicateDecision: jest.fn().mockResolvedValue(undefined),
    savePackGraph: jest.fn(async (input: SavePackGraphInput) => {
      saves.push(input);
      return graph.revision + 1;
    }),
  } as unknown as ProductionPersistenceRepository;
  return { value, saves };
}

function scheduler(): jest.Mocked<PackProcessingScheduler> {
  return {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
}

function graphWithPackagedItems(
  state: ContextPack['state'],
): PersistedPackGraph {
  const graph = fixture();
  return {
    ...graph,
    pack: { ...graph.pack, state },
    items: graph.items.map(item => {
      const checkpoint = { ...item };
      delete checkpoint.retryStage;
      return { ...checkpoint, state: 'packaged' as const };
    }),
  };
}

test('serializes rename/reorder and persists downstream order', async () => {
  const repo = repository();
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:01Z',
  );

  await controller.renamePack(packId, ' Renamed ');
  await controller.reorderItem(packId, secondId, 0);

  expect(repo.saves[0]?.pack.title).toBe('Renamed');
  expect(repo.saves[1]?.pack.orderedItemIds).toEqual([secondId, firstId]);
  expect(repo.saves[1]?.items.map(item => item.sortIndex)).toEqual([0, 1]);
  expect(repo.saves.every(save => save.expectedRevision === 7)).toBe(true);
});

test('controller mutations clamp a rolled-back clock to the latest Pack update', async () => {
  const base = fixture();
  const graph: PersistedPackGraph = {
    ...base,
    pack: { ...base.pack, updatedAt: '2026-08-10T00:10:00Z' },
  };
  const repo = repository(graph);
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:05:00Z',
  );

  await controller.renamePack(packId, 'Chronology preserved');

  expect(repo.saves[0]?.pack.updatedAt).toBe('2026-08-10T00:10:00Z');
});

test('reorder invalidates packaged rows and restarts downstream packaging', async () => {
  const readyGraph = graphWithPackagedItems('ready');
  const repo = repository(readyGraph);
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:01Z',
  );

  await controller.reorderItem(packId, secondId, 0);

  expect(repo.saves[0]?.pack.state).toBe('processing');
  expect(repo.saves[0]?.pack.orderedItemIds).toEqual([secondId, firstId]);
  expect(repo.saves[0]?.items.map(item => item.state)).toEqual([
    'reviewed',
    'reviewed',
  ]);
});

test('preserves originals by default and requires explicit release for destructive removal', async () => {
  const repo = repository();
  const controller = new PackLibraryController(async () => repo.value);

  await controller.removeItem(packId, firstId, 'preserve');
  await controller.removeItem(packId, firstId, 'release');

  expect(repo.saves[0]).toMatchObject({
    removedItemOriginalDisposition: 'preserve',
  });
  expect(repo.saves[1]).toMatchObject({
    removedItemOriginalDisposition: 'release',
  });
  expect(repo.saves[0]?.items.map(item => item.id)).toEqual([secondId]);
});

test.each(['ready', 'exporting', 'exported'] as const)(
  'removal from a %s Pack invalidates packaged output and restarts packaging',
  async state => {
    const repo = repository(graphWithPackagedItems(state));
    const controller = new PackLibraryController(async () => repo.value);

    await controller.removeItem(packId, firstId, 'preserve');

    expect(repo.saves[0]?.pack).toMatchObject({
      state: 'processing',
      orderedItemIds: [secondId],
    });
    expect(repo.saves[0]?.items).toEqual([
      expect.objectContaining({
        id: secondId,
        state: 'reviewed',
        sortIndex: 0,
      }),
    ]);
    expect(repo.saves[0]?.removedItemOriginalDisposition).toBe('preserve');
  },
);

test('retries at the durable extraction checkpoint without duplicating the original', async () => {
  const repo = repository();
  const processing = scheduler();
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:02Z',
    processing,
  );

  await expect(controller.retryItem(packId, secondId)).resolves.toEqual({
    packId,
    itemId: secondId,
    stage: 'extract',
    completedArtifactIds: [secondId],
  });
  expect(repo.saves).toHaveLength(1);
  expect(repo.saves[0]?.pack.state).toBe('processing');
  expect(repo.saves[0]?.startedPipelineRuns).toEqual([
    expect.objectContaining({
      packId,
      itemId: secondId,
      stage: 'extract',
      startedAt: '2026-08-10T00:00:02Z',
    }),
  ]);
  expect(processing.launch).toHaveBeenCalledWith(
    repo.saves[0]?.startedPipelineRuns,
  );
  expect(repo.saves[0]?.items.find(item => item.id === secondId)).toMatchObject(
    {
      state: 'imported',
      originalRelativePath: `Packs/${packId}/originals/${secondId}.bin`,
      artifactIds: [secondId],
    },
  );
});

test('rejects provider-less import retries instead of creating false progress', async () => {
  const graph = fixture();
  const failedBase = graph.items[1]!;
  const failedWithoutOriginal: ContextItem = {
    id: failedBase.id,
    packId: failedBase.packId,
    sourceType: failedBase.sourceType,
    mediaType: failedBase.mediaType,
    artifactIds: [],
    state: failedBase.state,
    retryStage: 'import',
    riskFindingIds: failedBase.riskFindingIds,
    inclusionMode: failedBase.inclusionMode,
    sortIndex: failedBase.sortIndex,
  };
  const repo = repository({
    ...graph,
    items: [graph.items[0]!, failedWithoutOriginal],
  });
  (repo.value.listArtifactRecords as jest.Mock).mockResolvedValue([
    original(firstId),
  ]);
  const controller = new PackLibraryController(async () => repo.value);

  await expect(controller.retryItem(packId, secondId)).rejects.toMatchObject({
    code: 'DOMAIN_INVALID_TRANSITION',
  });
  expect(repo.saves).toHaveLength(0);
});

test('cancels only active work through the shared state machines', async () => {
  const graph = fixture();
  const repo = repository({
    ...graph,
    pack: { ...graph.pack, state: 'processing' },
  });
  const processing = scheduler();
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:04Z',
    processing,
  );

  await controller.cancelProcessing(packId);

  expect(repo.saves[0]?.pack.state).toBe('cancelled');
  expect(repo.saves[0]?.cancelActivePipelineRuns).toBe(true);
  expect(processing.cancel).toHaveBeenCalledWith(
    packId,
    '2026-08-10T00:00:04Z',
  );
  expect(repo.saves[0]?.items.map(item => item.state)).toEqual([
    'imported',
    'failed',
  ]);
});

test('waits for every durable analyze run to settle before refreshing the caller', async () => {
  const base = fixture();
  const graph: PersistedPackGraph = {
    ...base,
    pack: { ...base.pack, state: 'processing' },
    items: base.items.map(item => {
      const checkpoint = { ...item };
      delete checkpoint.retryStage;
      return { ...checkpoint, state: 'extracted' as const };
    }),
  };
  const repo = repository(graph);
  const processing = scheduler();
  processing.supports.mockImplementation(
    stage => stage === 'extract' || stage === 'analyze',
  );
  let releaseIdle: (() => void) | undefined;
  processing.waitForIdle.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        releaseIdle = resolve;
      }),
  );
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:05Z',
    processing,
  );

  let settled = false;
  const result = controller.analyzePack(packId).then(value => {
    settled = true;
    return value;
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (processing.waitForIdle.mock.calls.length > 0) break;
    await Promise.resolve();
  }
  expect(settled).toBe(false);
  expect(repo.saves[0]?.startedPipelineRuns).toEqual([
    expect.objectContaining({ itemId: firstId, stage: 'analyze' }),
    expect.objectContaining({ itemId: secondId, stage: 'analyze' }),
  ]);
  expect(processing.launch).toHaveBeenCalledWith(
    repo.saves[0]?.startedPipelineRuns,
  );
  expect(processing.waitForIdle).toHaveBeenCalledTimes(1);
  releaseIdle?.();
  await expect(result).resolves.toBe(2);
});

test('keeps cancellation reachable while analyze settlement remains pending', async () => {
  const base = fixture();
  const graph: PersistedPackGraph = {
    ...base,
    pack: { ...base.pack, state: 'processing' },
    items: base.items.map(item => ({ ...item, state: 'extracted' as const })),
  };
  const repo = repository(graph);
  const processing = scheduler();
  processing.supports.mockReturnValue(true);
  let releaseIdle: (() => void) | undefined;
  processing.waitForIdle.mockImplementation(
    () => new Promise<void>(resolve => (releaseIdle = resolve)),
  );
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:05Z',
    processing,
  );

  const analysis = controller.analyzePack(packId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (processing.waitForIdle.mock.calls.length > 0) break;
    await Promise.resolve();
  }
  await expect(controller.cancelProcessing(packId)).resolves.toBeUndefined();
  expect(processing.cancel).toHaveBeenCalledTimes(1);
  expect(repo.saves.at(-1)?.cancelActivePipelineRuns).toBe(true);
  releaseIdle?.();
  await expect(analysis).resolves.toBe(2);
});

test('preferred duplicate choice excludes peers without deleting originals', async () => {
  const repo = repository();
  const suggestion = {
    schemaVersion: 1 as const,
    key: `exact-binary:${firstId}:${secondId}`,
    packId,
    leftItemId: firstId,
    rightItemId: secondId,
    reason: 'exact-binary' as const,
    confidence: 1,
    expectedBytesSaved: 10,
    expectedCharactersSaved: 0,
  };
  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: {
      schemaVersion: 1,
      packId,
      config: {
        schemaVersion: 1,
        exactBinaryAlgorithm: 'sha256-v1',
        normalizationVersion: 'text-normalization-v1',
        textFingerprintAlgorithm: 'bottom-k-fnv1a32-5gram-v1',
        textSimilarityThreshold: 0.82,
        imageFingerprintAlgorithm: 'dhash-64-v1',
        imageHammingDistanceThreshold: 8,
        minimumTextCharacters: 20,
      },
      analyzedAt: '2026-08-10T00:00:05Z',
      itemCount: 2,
      suggestionCount: 1,
    },
    analyses: [],
    suggestions: [suggestion],
    decisions: [],
  });
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:06Z',
  );

  await controller.reviewDuplicateGroup(packId, [secondId, firstId], {
    kind: 'preferred',
    itemId: firstId,
  });

  expect(repo.value.saveDuplicateDecisions).toHaveBeenCalledWith(packId, [
    expect.objectContaining({
      itemId: secondId,
      choice: 'exclude',
      baselineInclusionMode: 'original',
    }),
    expect.objectContaining({
      itemId: firstId,
      choice: 'preferred',
      baselineInclusionMode: 'original',
    }),
  ]);
  expect(repo.saves).toHaveLength(0);
});

test('preferred duplicate choice leaves non-adjacent members of a suggestion chain unchanged', async () => {
  const base = fixture();
  const thirdItem: ContextItem = {
    ...base.items[0]!,
    id: thirdId,
    originalSha256: '3'.repeat(64),
    originalRelativePath: `Packs/${packId}/originals/${thirdId}.bin`,
    artifactIds: [thirdId],
    sortIndex: 2,
  };
  const repo = repository({
    ...base,
    pack: {
      ...base.pack,
      orderedItemIds: [...base.pack.orderedItemIds, thirdId],
    },
    items: [...base.items, thirdItem],
  });
  const suggestion = (leftItemId: string, rightItemId: string) => ({
    schemaVersion: 1 as const,
    key: `exact-binary:${leftItemId}:${rightItemId}`,
    packId,
    leftItemId,
    rightItemId,
    reason: 'exact-binary' as const,
    confidence: 1,
    expectedBytesSaved: 10,
    expectedCharactersSaved: 0,
  });
  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: null,
    analyses: [],
    suggestions: [suggestion(firstId, secondId), suggestion(secondId, thirdId)],
    decisions: [],
  });
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:06Z',
  );

  await controller.reviewDuplicateGroup(packId, [thirdId, secondId, firstId], {
    kind: 'preferred',
    itemId: firstId,
  });

  expect(repo.value.saveDuplicateDecisions).toHaveBeenCalledWith(packId, [
    expect.objectContaining({ itemId: secondId, choice: 'exclude' }),
    expect.objectContaining({ itemId: firstId, choice: 'preferred' }),
  ]);
  expect(repo.value.saveDuplicateDecisions).not.toHaveBeenCalledWith(
    packId,
    expect.arrayContaining([expect.objectContaining({ itemId: thirdId })]),
  );

  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: null,
    analyses: [],
    suggestions: [suggestion(firstId, secondId), suggestion(secondId, thirdId)],
    decisions: [
      {
        schemaVersion: 1,
        packId,
        itemId: secondId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        decidedAt: '2026-08-10T00:00:05Z',
      },
    ],
  });
  (repo.value.saveDuplicateDecisions as jest.Mock).mockClear();
  await controller.reviewDuplicateGroup(packId, [firstId, secondId, thirdId], {
    kind: 'preferred',
    itemId: firstId,
  });
  expect(repo.value.saveDuplicateDecisions).toHaveBeenCalledWith(
    packId,
    expect.arrayContaining([
      expect.objectContaining({
        itemId: secondId,
        choice: 'exclude',
        source: 'standalone',
      }),
    ]),
  );
});

test('switching preferred restores stale group exclusions but preserves standalone exclusions', async () => {
  const base = fixture();
  const thirdItem: ContextItem = {
    ...base.items[0]!,
    id: thirdId,
    originalSha256: '3'.repeat(64),
    originalRelativePath: `Packs/${packId}/originals/${thirdId}.bin`,
    artifactIds: [thirdId],
    inclusionMode: 'excluded',
    sortIndex: 2,
  };
  const repo = repository({
    ...base,
    pack: {
      ...base.pack,
      orderedItemIds: [...base.pack.orderedItemIds, thirdId],
    },
    items: [...base.items, thirdItem],
  });
  const suggestion = (leftItemId: string, rightItemId: string) => ({
    schemaVersion: 1 as const,
    key: `exact-binary:${leftItemId}:${rightItemId}`,
    packId,
    leftItemId,
    rightItemId,
    reason: 'exact-binary' as const,
    confidence: 1,
    expectedBytesSaved: 10,
    expectedCharactersSaved: 0,
  });
  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: null,
    analyses: [],
    suggestions: [suggestion(firstId, secondId), suggestion(secondId, thirdId)],
    decisions: [
      {
        schemaVersion: 1,
        packId,
        itemId: firstId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        source: 'preferred-group',
        decidedAt: '2026-08-10T00:00:05Z',
      },
      {
        schemaVersion: 1,
        packId,
        itemId: secondId,
        choice: 'preferred',
        baselineInclusionMode: 'original',
        source: 'preferred-group',
        decidedAt: '2026-08-10T00:00:05Z',
      },
      {
        schemaVersion: 1,
        packId,
        itemId: thirdId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        source: 'preferred-group',
        decidedAt: '2026-08-10T00:00:05Z',
      },
    ],
  });
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:06Z',
  );

  await controller.reviewDuplicateGroup(packId, [firstId, secondId, thirdId], {
    kind: 'preferred',
    itemId: firstId,
  });

  expect(repo.value.saveDuplicateDecisions).toHaveBeenCalledWith(packId, [
    expect.objectContaining({
      itemId: firstId,
      choice: 'preferred',
      source: 'preferred-group',
    }),
    expect.objectContaining({
      itemId: secondId,
      choice: 'exclude',
      source: 'preferred-group',
    }),
    expect.objectContaining({
      itemId: thirdId,
      choice: 'keep',
      source: 'preferred-group',
    }),
  ]);

  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: null,
    analyses: [],
    suggestions: [suggestion(firstId, secondId), suggestion(secondId, thirdId)],
    decisions: [
      {
        schemaVersion: 1,
        packId,
        itemId: thirdId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        source: 'standalone',
        decidedAt: '2026-08-10T00:00:05Z',
      },
    ],
  });
  (repo.value.saveDuplicateDecisions as jest.Mock).mockClear();
  await controller.reviewDuplicateGroup(packId, [firstId, secondId, thirdId], {
    kind: 'preferred',
    itemId: firstId,
  });
  expect(repo.value.saveDuplicateDecisions).not.toHaveBeenCalledWith(
    packId,
    expect.arrayContaining([expect.objectContaining({ itemId: thirdId })]),
  );
});

test('preserves ambiguous source-less exclusions even at the preferred timestamp', async () => {
  const base = fixture();
  const thirdItem: ContextItem = {
    ...base.items[0]!,
    id: thirdId,
    originalSha256: '3'.repeat(64),
    originalRelativePath: `Packs/${packId}/originals/${thirdId}.bin`,
    artifactIds: [thirdId],
    inclusionMode: 'excluded',
    sortIndex: 2,
  };
  const repo = repository({
    ...base,
    pack: {
      ...base.pack,
      orderedItemIds: [...base.pack.orderedItemIds, thirdId],
    },
    items: [...base.items, thirdItem],
  });
  const suggestion = (leftItemId: string, rightItemId: string) => ({
    schemaVersion: 1 as const,
    key: `exact-binary:${leftItemId}:${rightItemId}`,
    packId,
    leftItemId,
    rightItemId,
    reason: 'exact-binary' as const,
    confidence: 1,
    expectedBytesSaved: 10,
    expectedCharactersSaved: 0,
  });
  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: null,
    analyses: [],
    suggestions: [suggestion(firstId, secondId), suggestion(secondId, thirdId)],
    decisions: [
      {
        schemaVersion: 1,
        packId,
        itemId: firstId,
        choice: 'preferred',
        baselineInclusionMode: 'original',
        decidedAt: '2026-08-10T00:00:06Z',
      },
      {
        schemaVersion: 1,
        packId,
        itemId: secondId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        decidedAt: '2026-08-10T00:00:06Z',
      },
      {
        schemaVersion: 1,
        packId,
        itemId: thirdId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        decidedAt: '2026-08-10T00:00:06Z',
      },
    ],
  });
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:07Z',
  );

  await controller.reviewDuplicateGroup(packId, [firstId, secondId, thirdId], {
    kind: 'preferred',
    itemId: firstId,
  });

  expect(repo.value.saveDuplicateDecisions).toHaveBeenCalledWith(packId, [
    expect.objectContaining({
      itemId: firstId,
      choice: 'preferred',
      source: 'preferred-group',
    }),
    expect.objectContaining({
      itemId: secondId,
      choice: 'exclude',
      source: 'standalone',
    }),
  ]);
  expect(repo.value.saveDuplicateDecisions).not.toHaveBeenCalledWith(
    packId,
    expect.arrayContaining([expect.objectContaining({ itemId: thirdId })]),
  );
});

test('restores a durable duplicate choice without requiring a current suggestion group', async () => {
  const repo = repository();
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:07Z',
  );

  await controller.restoreDuplicateDecision(packId, secondId);

  expect(repo.value.restoreDuplicateDecision).toHaveBeenCalledWith(
    packId,
    secondId,
    '2026-08-10T00:00:07Z',
  );
});

test('keeps a stranded durable choice visible after its suggestion group disappears', async () => {
  const base = fixture();
  const graph: PersistedPackGraph = {
    ...base,
    items: [
      {
        ...base.items[1]!,
        originalDisplayName: 'Remaining item',
        inclusionMode: 'excluded',
        sortIndex: 0,
      },
    ],
    pack: { ...base.pack, orderedItemIds: [secondId] },
  };
  const repo = repository(graph);
  (repo.value.findDuplicateAnalysis as jest.Mock).mockResolvedValue({
    manifest: {
      schemaVersion: 1,
      packId,
      config: {
        schemaVersion: 1,
        exactBinaryAlgorithm: 'sha256-v1',
        normalizationVersion: 'text-normalization-v1',
        textFingerprintAlgorithm: 'bottom-k-fnv1a32-5gram-v1',
        textSimilarityThreshold: 0.82,
        imageFingerprintAlgorithm: 'dhash-64-v1',
        imageHammingDistanceThreshold: 8,
        minimumTextCharacters: 20,
      },
      analyzedAt: '2026-08-10T00:00:05Z',
      itemCount: 1,
      suggestionCount: 0,
    },
    analyses: [
      {
        schemaVersion: 1,
        packId,
        itemId: secondId,
        originalByteCount: 128,
        normalizedArtifactId: '423e4567-e89b-42d3-a456-426614174000',
        normalizedSha256: 'c'.repeat(64),
        contentKind: 'prose',
        normalizedCharacterCount: 80,
        normalizedByteCount: 80,
        textFingerprint: {
          schemaVersion: 1,
          algorithm: 'bottom-k-fnv1a32-5gram-v1',
          shingleSize: 5,
          sampleSize: 128,
          similarityCharacterCount: 5,
          shingleCount: 1,
          hashes: ['12345678'],
        },
        analyzedAt: '2026-08-10T00:00:05Z',
      },
    ],
    suggestions: [],
    decisions: [
      {
        schemaVersion: 1,
        packId,
        itemId: secondId,
        choice: 'exclude',
        baselineInclusionMode: 'original',
        decidedAt: '2026-08-10T00:00:06Z',
      },
    ],
  });
  const controller = new PackLibraryController(async () => repo.value);

  await expect(controller.load(packId)).resolves.toMatchObject({
    selected: {
      duplicateReview: {
        groups: [],
        standaloneDecisions: [
          {
            id: secondId,
            displayName: 'Remaining item',
            choice: 'exclude',
          },
        ],
      },
    },
  });
});

test('Pack retry resumes item checkpoints while retaining immutable originals', async () => {
  const graph = fixture();
  const repo = repository({
    ...graph,
    pack: { ...graph.pack, state: 'cancelled' },
  });
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:03Z',
  );

  await expect(controller.retryPack(packId)).resolves.toEqual([
    {
      packId,
      itemId: secondId,
      stage: 'extract',
      completedArtifactIds: [secondId],
    },
    {
      packId,
      itemId: firstId,
      stage: 'extract',
      completedArtifactIds: [firstId],
    },
  ]);
  expect(repo.saves[0]?.pack.state).toBe('processing');
  expect(repo.saves[0]?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: secondId,
        state: 'imported',
        originalRelativePath: `Packs/${packId}/originals/${secondId}.bin`,
        artifactIds: [secondId],
      }),
    ]),
  );
});

test('Pack retry reactivates an export-level failure when every item is packaged', async () => {
  const repo = repository(graphWithPackagedItems('failed'));
  const controller = new PackLibraryController(async () => repo.value);

  await expect(controller.retryPack(packId)).resolves.toEqual([]);

  expect(repo.saves).toHaveLength(1);
  expect(repo.saves[0]?.pack.state).toBe('ready');
  expect(repo.saves[0]?.items.map(item => item.state)).toEqual([
    'packaged',
    'packaged',
  ]);
});

test('Pack retry does not hide a provider-less failed item behind a packaged item', async () => {
  const graph = graphWithPackagedItems('failed');
  const failed = graph.items[1]!;
  const failedWithoutOriginal: ContextItem = {
    id: failed.id,
    packId: failed.packId,
    sourceType: failed.sourceType,
    mediaType: failed.mediaType,
    ...(failed.originalDisplayName
      ? { originalDisplayName: failed.originalDisplayName }
      : {}),
    artifactIds: [],
    state: 'failed',
    retryStage: 'import',
    riskFindingIds: failed.riskFindingIds,
    inclusionMode: failed.inclusionMode,
    sortIndex: failed.sortIndex,
  };
  const repo = repository({
    ...graph,
    items: [graph.items[0]!, failedWithoutOriginal],
  });
  (repo.value.listArtifactRecords as jest.Mock).mockResolvedValue([
    original(firstId),
  ]);
  const controller = new PackLibraryController(async () => repo.value);

  await expect(controller.retryPack(packId)).rejects.toMatchObject({
    code: 'DOMAIN_INVALID_TRANSITION',
  });
  expect(repo.saves).toHaveLength(0);
});

test('packaging retry restores reviewed without repeating analysis or review', async () => {
  const graph = fixture();
  const packagingFailure: PersistedPackGraph = {
    ...graph,
    items: graph.items.map(item => {
      if (item.id === secondId)
        return { ...item, state: 'failed', retryStage: 'package' };
      const packaged = { ...item };
      delete packaged.retryStage;
      return { ...packaged, state: 'packaged' };
    }),
  };
  const repo = repository(packagingFailure);
  const controller = new PackLibraryController(async () => repo.value);

  await expect(controller.retryItem(packId, secondId)).resolves.toMatchObject({
    stage: 'package',
  });
  expect(repo.saves[0]?.items.find(item => item.id === secondId)).toMatchObject(
    {
      state: 'reviewed',
    },
  );
  expect(
    repo.saves[0]?.items.find(item => item.id === secondId)?.retryStage,
  ).toBeUndefined();
});

test('production retry rejects stages that have no executable worker', async () => {
  const graph = fixture();
  const packagingFailure: PersistedPackGraph = {
    ...graph,
    items: graph.items.map(item => {
      if (item.id === secondId)
        return { ...item, state: 'failed', retryStage: 'package' };
      const packaged = { ...item };
      delete packaged.retryStage;
      return { ...packaged, state: 'packaged' };
    }),
  };
  const repo = repository(packagingFailure);
  const processing = scheduler();
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:03Z',
    processing,
  );

  await expect(controller.retryItem(packId, secondId)).rejects.toMatchObject({
    code: 'DOMAIN_INVALID_TRANSITION',
  });
  await expect(controller.retryPack(packId)).rejects.toMatchObject({
    code: 'DOMAIN_INVALID_TRANSITION',
  });
  expect(processing.supports).toHaveBeenCalledWith('package');
  expect(processing.launch).not.toHaveBeenCalled();
  expect(repo.saves).toHaveLength(0);
});

test('Pack retry rejects the whole mixed retry when any failed item has no worker', async () => {
  const graph = fixture();
  const extractFailure = graph.items[1]!;
  const packageFailure: ContextItem = {
    ...graph.items[0]!,
    state: 'failed',
    retryStage: 'package',
  };
  const repo = repository({
    ...graph,
    items: [packageFailure, extractFailure],
  });
  const processing = scheduler();
  const controller = new PackLibraryController(
    async () => repo.value,
    () => '2026-08-10T00:00:03Z',
    processing,
  );

  await expect(controller.retryPack(packId)).rejects.toMatchObject({
    code: 'DOMAIN_INVALID_TRANSITION',
  });

  expect(processing.supports).toHaveBeenCalledWith('package');
  expect(processing.supports).toHaveBeenCalledWith('extract');
  expect(processing.launch).not.toHaveBeenCalled();
  expect(repo.saves).toHaveLength(0);
});

test('Pack retry fails closed when every failed item requires retained-source import', async () => {
  const graph = fixture();
  const providerlessItems: ContextItem[] = graph.items.map(item => ({
    id: item.id,
    packId: item.packId,
    sourceType: item.sourceType,
    mediaType: item.mediaType,
    ...(item.originalDisplayName
      ? { originalDisplayName: item.originalDisplayName }
      : {}),
    artifactIds: [],
    state: 'failed',
    retryStage: 'import',
    riskFindingIds: item.riskFindingIds,
    inclusionMode: item.inclusionMode,
    sortIndex: item.sortIndex,
  }));
  const repo = repository({
    ...graph,
    items: providerlessItems,
    pack: {
      ...graph.pack,
      orderedItemIds: providerlessItems.map(item => item.id),
    },
  });
  (repo.value.listArtifactRecords as jest.Mock).mockResolvedValue([]);
  const controller = new PackLibraryController(async () => repo.value);

  await expect(controller.retryPack(packId)).rejects.toMatchObject({
    code: 'DOMAIN_INVALID_TRANSITION',
  });
  expect(repo.saves).toHaveLength(0);
});
