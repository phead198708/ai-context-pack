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
