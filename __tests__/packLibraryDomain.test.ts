import type { ContextItem, ContextPack } from '../src/domain/models';
import type {
  PersistedArtifactRecord,
  PersistedPackGraph,
} from '../src/infrastructure/persistence/contracts';
import {
  buildPackLibrarySnapshot,
  packSection,
  reorderContextItems,
  retryPlanForItem,
  stateAtRetryCheckpoint,
} from '../src/features/packLibrary/domain';

const packId = '123e4567-e89b-42d3-a456-426614174000';
const itemIds = [
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  '423e4567-e89b-42d3-a456-426614174000',
  '523e4567-e89b-42d3-a456-426614174000',
  '623e4567-e89b-42d3-a456-426614174000',
] as const;

function pack(state: ContextPack['state'] = 'processing'): ContextPack {
  return {
    id: packId,
    schemaVersion: 1,
    title: 'Mixed Pack',
    userInstruction: 'Summarize',
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:01Z',
    state,
    budget: {
      preset: 'balanced',
      maxOutputBytes: 10_485_760,
      minimumImageLongestEdge: 1_280,
      imageQuality: 0.82,
      estimatorVersion: 'v1',
    },
    estimatedTokens: 0,
    orderedItemIds: itemIds,
    exportRecordIds: [],
    warningCodes: [],
  };
}

function item(
  index: number,
  state: ContextItem['state'],
  sha = String(index + 1).repeat(64),
): ContextItem {
  return {
    id: itemIds[index]!,
    packId,
    sourceType: index === 1 ? 'pdf' : 'image',
    mediaType: index === 1 ? 'application/pdf' : 'image/png',
    originalSha256: sha,
    originalRelativePath: `Packs/${packId}/originals/${itemIds[index]}.bin`,
    artifactIds: [itemIds[index]!],
    state,
    riskFindingIds:
      state === 'review-required'
        ? ['723e4567-e89b-42d3-a456-426614174000']
        : [],
    inclusionMode: 'original',
    sortIndex: index,
  };
}

function artifact(
  index: number,
  kind: PersistedArtifactRecord['kind'] = 'original',
): PersistedArtifactRecord {
  return {
    id: itemIds[index]!,
    itemId: itemIds[index]!,
    kind,
    relativePath: `Packs/${packId}/${
      kind === 'original' ? 'originals' : 'derived'
    }/${itemIds[index]}.${kind === 'original' ? 'bin' : 'txt'}`,
    mediaType: kind === 'original' ? 'image/png' : 'text/plain',
    byteCount: 128 + index,
    sha256: String(index + 1).repeat(64),
    processorVersion: {
      processor: 'fixture',
      version: '1',
      contractVersion: 1,
    },
    createdAt: '2026-08-10T00:00:00Z',
    immutable: true,
  };
}

test('renders successful, processing, failed, duplicate, and low-confidence items without omission', () => {
  const duplicateHash = 'a'.repeat(64);
  const items = [
    item(0, 'packaged', duplicateHash),
    item(1, 'imported'),
    item(2, 'failed'),
    item(3, 'review-required'),
    item(4, 'extracted', duplicateHash),
  ];
  const graph: PersistedPackGraph = { pack: pack(), items, revision: 4 };
  const snapshot = buildPackLibrarySnapshot(
    [graph],
    items.map((_value, index) => artifact(index)),
    [
      {
        ingestionId: '823e4567-e89b-42d3-a456-426614174000',
        packId,
        manifestFingerprint: 'f'.repeat(64),
        status: 'partial',
        itemCount: 5,
        artifactCount: 5,
        createdAt: '2026-08-10T00:00:00Z',
        items: [
          {
            id: itemIds[2],
            order: 2,
            mediaType: 'image/png',
            status: 'failed',
            errorCode: 'IMPORT_COPY_FAILED',
          },
        ],
      },
    ],
    packId,
  );

  expect(snapshot.sections.processing).toHaveLength(1);
  expect(snapshot.selected?.items).toHaveLength(5);
  expect(snapshot.selected?.items[2]).toMatchObject({
    state: 'failed',
    errorCode: 'IMPORT_COPY_FAILED',
    retryStage: 'extract',
  });
  expect(snapshot.selected?.items[3]?.warningCodes).toContain(
    'LOW_CONFIDENCE_REVIEW_REQUIRED',
  );
  expect(snapshot.selected?.items[4]).toMatchObject({
    duplicateOfItemId: itemIds[0],
    warningCodes: ['DUPLICATE_ORIGINAL'],
  });
  expect(snapshot.selected?.completeness).toEqual({
    total: 5,
    complete: 1,
    processing: 2,
    reviewRequired: 1,
    failed: 1,
    cancelled: 0,
  });
});

test('maps exporting/recovering into Processing and keeps every required library view', () => {
  expect(packSection('exporting')).toBe('processing');
  expect(packSection('recovering')).toBe('processing');
  for (const state of [
    'draft',
    'processing',
    'review-required',
    'ready',
    'exported',
    'failed',
    'cancelled',
  ] as const)
    expect(packSection(state)).toBe(state);
});

test('reorders deterministically and derives retry from durable artifacts', () => {
  const items = [item(0, 'imported'), item(1, 'failed')];
  const reordered = reorderContextItems(items, itemIds[1], 0);
  expect(reordered.map(value => [value.id, value.sortIndex])).toEqual([
    [itemIds[1], 0],
    [itemIds[0], 1],
  ]);
  const extracted: PersistedArtifactRecord = {
    ...artifact(1, 'ocr-text'),
    id: '923e4567-e89b-42d3-a456-426614174000',
  };
  const plan = retryPlanForItem(packId, items[1]!, [artifact(1), extracted]);
  expect(plan).toEqual({
    packId,
    itemId: itemIds[1],
    stage: 'analyze',
    completedArtifactIds: [itemIds[1], extracted.id],
  });
  expect(stateAtRetryCheckpoint(plan.stage)).toBe('extracted');
});

test('does not fall back to a different Pack or expose a provider-less import retry', () => {
  const withOriginal = item(0, 'failed');
  const failed: ContextItem = {
    id: withOriginal.id,
    packId: withOriginal.packId,
    sourceType: withOriginal.sourceType,
    mediaType: withOriginal.mediaType,
    artifactIds: [],
    state: withOriginal.state,
    riskFindingIds: withOriginal.riskFindingIds,
    inclusionMode: withOriginal.inclusionMode,
    sortIndex: withOriginal.sortIndex,
  };
  const graph: PersistedPackGraph = {
    pack: { ...pack('failed'), orderedItemIds: [failed.id] },
    items: [failed],
    revision: 1,
  };
  const unknownPackId = 'a23e4567-e89b-42d3-a456-426614174000';

  expect(
    buildPackLibrarySnapshot([graph], [], [], unknownPackId).selected,
  ).toBeUndefined();
  expect(
    buildPackLibrarySnapshot([graph], [], [], packId).selected?.items[0],
  ).toMatchObject({
    state: 'failed',
    stage: 'import',
    errorCode: 'PIPELINE_STAGE_FAILED',
  });
  expect(
    buildPackLibrarySnapshot([graph], [], [], packId).selected?.items[0]
      ?.retryStage,
  ).toBeUndefined();
});
