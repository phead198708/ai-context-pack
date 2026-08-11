jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import type { ImportManifestV1 } from '../src/domain/contracts';
import type {
  ContextItem,
  ContextPack,
  ExportRecord,
  RiskFinding,
} from '../src/domain/models';
import { ownedDerivedPath } from '../src/infrastructure/persistence/ownedPaths';
import { ExpoSqlitePersistenceRepository } from '../src/infrastructure/persistence/sqlite';

type SqlValue = string | number | null;
interface NodeStatement {
  run(...params: readonly SqlValue[]): { readonly changes: number | bigint };
  get(...params: readonly SqlValue[]): unknown;
  all(...params: readonly SqlValue[]): readonly unknown[];
}
interface NodeDatabase {
  exec(source: string): void;
  prepare(source: string): NodeStatement;
  close(): void;
}
interface NodeSqliteModule {
  new (path: string): NodeDatabase;
}

const { DatabaseSync } = require('node:sqlite') as {
  readonly DatabaseSync: NodeSqliteModule;
};
const { mkdtempSync, rmSync } = require('node:fs') as {
  readonly mkdtempSync: (prefix: string) => string;
  readonly rmSync: (
    path: string,
    options: { readonly recursive: boolean; readonly force: boolean },
  ) => void;
};
const { tmpdir } = require('node:os') as {
  readonly tmpdir: () => string;
};
const { join } = require('node:path') as {
  readonly join: (...parts: readonly string[]) => string;
};

const packId = '123e4567-e89b-42d3-a456-426614174000';
const ingestionId = '223e4567-e89b-42d3-a456-426614174000';
const firstItemId = '323e4567-e89b-42d3-a456-426614174000';
const secondItemId = '423e4567-e89b-42d3-a456-426614174000';
const derivedId = '523e4567-e89b-42d3-a456-426614174000';
const findingId = '623e4567-e89b-42d3-a456-426614174000';
const exportId = '723e4567-e89b-42d3-a456-426614174000';
const emptyPackId = '823e4567-e89b-42d3-a456-426614174000';
const appendedIngestionId = '923e4567-e89b-42d3-a456-426614174000';
const appendedItemId = 'a23e4567-e89b-42d3-a456-426614174000';
const oldQuarantineId = 'b23e4567-e89b-42d3-a456-426614174000';
const recentQuarantineId = 'c23e4567-e89b-42d3-a456-426614174000';
const mainAppPackId = 'd23e4567-e89b-42d3-a456-426614174000';
const mainAppIngestionId = 'e23e4567-e89b-42d3-a456-426614174000';
const mainAppImageId = 'f23e4567-e89b-42d3-a456-426614174000';
const mainAppPdfId = 'd33e4567-e89b-42d3-a456-426614174000';
const mainAppTextId = 'e33e4567-e89b-42d3-a456-426614174000';
const mainAppUrlId = 'f33e4567-e89b-42d3-a456-426614174000';
const createdAt = '2026-08-05T00:00:00Z';

class NodeSqlConnection {
  private chain = Promise.resolve();

  constructor(readonly database: NodeDatabase) {}

  async exec(source: string): Promise<void> {
    this.database.exec(source);
  }

  async run(source: string, params: readonly SqlValue[] = []) {
    const result = this.database.prepare(source).run(...params);
    return { changes: Number(result.changes) };
  }

  async first<T>(
    source: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    return (
      (this.database.prepare(source).get(...params) as T | undefined) ?? null
    );
  }

  async all<T>(
    source: string,
    params: readonly SqlValue[] = [],
  ): Promise<readonly T[]> {
    return this.database.prepare(source).all(...params) as readonly T[];
  }

  exclusive<T>(
    task: (transaction: NodeSqlConnection) => Promise<T>,
  ): Promise<T> {
    const work = this.chain.then(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const value = await task(this);
        this.database.exec('COMMIT');
        return value;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
    this.chain = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
}

function manifest(): ImportManifestV1 {
  return {
    schemaVersion: 1,
    ingestionId,
    createdAt,
    source: 'android-share-intent',
    status: 'complete',
    items: [
      {
        id: firstItemId,
        order: 0,
        mediaType: 'Image/PNG',
        status: 'copied',
        byteCount: 4,
        relativePath: `${firstItemId}.bin`,
        sha256: 'a'.repeat(64),
      },
      {
        id: secondItemId,
        order: 1,
        mediaType: 'application/pdf',
        status: 'copied',
        byteCount: 8,
        relativePath: `${secondItemId}.bin`,
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

function updatedPack(
  current: ContextPack,
  items: readonly ContextItem[],
  title: string,
  updatedAt: string,
): ContextPack {
  return {
    ...current,
    title,
    updatedAt,
    orderedItemIds: items.map(item => item.id),
  };
}

describe('production repository against SQLite', () => {
  let directory: string;
  let databasePath: string;
  let database: NodeDatabase;
  let repository: ExpoSqlitePersistenceRepository;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ai-context-pack-repository-'));
    databasePath = join(directory, 'repository.db');
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();
    await repository.commitImport({
      packId,
      manifest: manifest(),
      manifestFingerprint: 'c'.repeat(64),
      artifacts: [
        {
          id: firstItemId,
          itemId: firstItemId,
          relativePath: `Packs/${packId}/originals/${firstItemId}.bin`,
          mediaType: 'Image/PNG',
          byteCount: 4,
          sha256: 'a'.repeat(64),
        },
        {
          id: secondItemId,
          itemId: secondItemId,
          relativePath: `Packs/${packId}/originals/${secondItemId}.bin`,
          mediaType: 'application/pdf',
          byteCount: 8,
          sha256: 'b'.repeat(64),
        },
      ],
    });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('persists order across restart, fails stale writers, and rolls back immutable metadata edits', async () => {
    const initial = await repository.findPackGraph(packId);
    expect(initial?.pack.orderedItemIds).toEqual([firstItemId, secondItemId]);
    expect(initial?.items[0]?.sourceType).toBe('image');
    const reversed = [
      { ...initial!.items[1]!, sortIndex: 0 },
      { ...initial!.items[0]!, sortIndex: 1 },
    ];
    const revision = await repository.savePackGraph({
      pack: updatedPack(
        initial!.pack,
        reversed,
        'reordered',
        '2026-08-05T00:00:01Z',
      ),
      items: reversed,
      expectedRevision: initial!.revision,
    });
    expect(revision).toBe(2);

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();
    const restarted = await repository.findPackGraph(packId);
    expect(restarted?.pack.orderedItemIds).toEqual([secondItemId, firstItemId]);

    const changedMedia = restarted!.items.map((item, index) =>
      index === 0
        ? { ...item, sourceType: 'text' as const, mediaType: 'text/plain' }
        : item,
    );
    await expect(
      repository.savePackGraph({
        pack: updatedPack(
          restarted!.pack,
          changedMedia,
          'must-roll-back',
          '2026-08-05T00:00:02Z',
        ),
        items: changedMedia,
        expectedRevision: restarted!.revision,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ARTIFACT_IMMUTABLE' });
    expect((await repository.findPackGraph(packId))?.revision).toBe(2);

    const writers = ['winner-a', 'winner-b'].map((title, index) =>
      repository.savePackGraph({
        pack: updatedPack(
          restarted!.pack,
          restarted!.items,
          title,
          `2026-08-05T00:00:0${index + 3}Z`,
        ),
        items: restarted!.items,
        expectedRevision: 2,
      }),
    );
    const results = await Promise.allSettled(writers);
    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(
      1,
    );
    expect((await repository.findPackGraph(packId))?.revision).toBe(3);
  });

  test('persists an exact terminal retry stage across repository restart', async () => {
    const initial = await repository.findPackGraph(packId);
    const failedItems = initial!.items.map(item =>
      item.id === firstItemId
        ? { ...item, state: 'failed' as const, retryStage: 'package' as const }
        : item,
    );
    await repository.savePackGraph({
      pack: {
        ...updatedPack(
          initial!.pack,
          failedItems,
          initial!.pack.title,
          '2026-08-05T00:00:01Z',
        ),
        state: 'failed',
      },
      items: failedItems,
      expectedRevision: initial!.revision,
    });

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    expect(
      (await repository.findPackGraph(packId))?.items.find(
        item => item.id === firstItemId,
      ),
    ).toMatchObject({ state: 'failed', retryStage: 'package' });
  });

  test('migrates a retained v3 import failure to the import retry checkpoint', async () => {
    database
      .prepare(
        "UPDATE import_items SET status = 'failed', error_code = 'IMPORT_COPY_FAILED' WHERE id = ?",
      )
      .run(firstItemId);
    database
      .prepare("UPDATE imports SET status = 'partial' WHERE ingestion_id = ?")
      .run(ingestionId);
    database
      .prepare("UPDATE context_items SET state = 'failed' WHERE id = ?")
      .run(firstItemId);
    database.exec('ALTER TABLE context_items DROP COLUMN retry_stage');
    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    database.exec('DROP TABLE pipeline_runs');
    database.exec('PRAGMA user_version = 3');

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    expect(
      (await repository.findPackGraph(packId))?.items.find(
        item => item.id === firstItemId,
      ),
    ).toMatchObject({ state: 'failed', retryStage: 'import' });
    await expect(repository.listImportDetails()).resolves.toEqual([
      expect.objectContaining({
        status: 'partial',
        items: expect.arrayContaining([
          expect.objectContaining({
            id: firstItemId,
            status: 'failed',
            retrySource: expect.objectContaining({
              relativePath: `Packs/${packId}/originals/${firstItemId}.bin`,
            }),
          }),
        ]),
      }),
    ]);
  });

  test('migrates a post-cleanup v4 destructive release without inventing retained bytes', async () => {
    const initial = await repository.findPackGraph(packId);
    const remaining = [{ ...initial!.items[1]!, sortIndex: 0 }];
    await repository.savePackGraph({
      pack: updatedPack(
        initial!.pack,
        remaining,
        'released first original',
        '2026-08-05T00:00:01Z',
      ),
      items: remaining,
      expectedRevision: initial!.revision,
      removedItemOriginalDisposition: 'release',
    });
    await expect(
      repository.deleteArtifactRecordIfUnreferenced(firstItemId),
    ).resolves.toBe(true);

    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    database.exec('DROP TABLE pipeline_runs');
    database.exec('PRAGMA user_version = 4');
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    await expect(repository.listImportDetails()).resolves.toEqual([
      expect.objectContaining({
        ingestionId,
        items: [
          expect.objectContaining({
            id: firstItemId,
            status: 'copied',
            originalReleased: true,
          }),
          expect.objectContaining({
            id: secondItemId,
            status: 'copied',
          }),
        ],
      }),
    ]);
  });

  test('migrates a pre-cleanup v4 destructive release while unreferenced bytes still exist', async () => {
    const initial = await repository.findPackGraph(packId);
    const remaining = [{ ...initial!.items[1]!, sortIndex: 0 }];
    await repository.savePackGraph({
      pack: updatedPack(
        initial!.pack,
        remaining,
        'released before cleanup',
        '2026-08-05T00:00:01Z',
      ),
      items: remaining,
      expectedRevision: initial!.revision,
      removedItemOriginalDisposition: 'release',
    });

    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    database.exec('DROP TABLE pipeline_runs');
    database.exec('PRAGMA user_version = 4');
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    expect((await repository.listImportDetails())[0]?.items[0]).toMatchObject({
      id: firstItemId,
      status: 'copied',
      originalReleased: true,
    });
    await expect(
      repository.deleteArtifactRecordIfUnreferenced(firstItemId),
    ).resolves.toBe(true);
    expect((await repository.listImportDetails())[0]?.items[0]).toMatchObject({
      id: firstItemId,
      originalReleased: true,
    });
  });

  test.each([['pre-cleanup', false] as const, ['post-cleanup', true] as const])(
    'migrates a %s v4 destructive release for a failed retry-source item',
    async (_phase, cleanBeforeMigration) => {
      database
        .prepare(
          "UPDATE import_items SET status = 'failed', error_code = 'IMPORT_COPY_FAILED' WHERE id = ?",
        )
        .run(firstItemId);
      database
        .prepare("UPDATE imports SET status = 'partial' WHERE ingestion_id = ?")
        .run(ingestionId);
      const initial = (await repository.findPackGraph(packId))!;
      const remaining = [{ ...initial.items[1]!, sortIndex: 0 }];
      await repository.savePackGraph({
        pack: updatedPack(
          initial.pack,
          remaining,
          'released failed original',
          '2026-08-05T00:00:01Z',
        ),
        items: remaining,
        expectedRevision: initial.revision,
        removedItemOriginalDisposition: 'release',
      });
      if (cleanBeforeMigration)
        await expect(
          repository.deleteArtifactRecordIfUnreferenced(firstItemId),
        ).resolves.toBe(true);

      database.exec(
        'ALTER TABLE import_items DROP COLUMN original_disposition',
      );
      database.exec('DROP TABLE pipeline_runs');
      database.exec('PRAGMA user_version = 4');
      database.close();
      database = new DatabaseSync(databasePath);
      repository = new ExpoSqlitePersistenceRepository(
        new NodeSqlConnection(database) as never,
      );
      await repository.initialize();

      expect((await repository.listImportDetails())[0]?.items[0]).toMatchObject(
        {
          id: firstItemId,
          status: 'failed',
          originalReleased: true,
        },
      );
      if (!cleanBeforeMigration)
        await expect(
          repository.deleteArtifactRecordIfUnreferenced(firstItemId),
        ).resolves.toBe(true);
    },
  );

  test('keeps a v4 failed removed item retained when its preserved reference is live', async () => {
    database
      .prepare(
        "UPDATE import_items SET status = 'failed', error_code = 'IMPORT_COPY_FAILED' WHERE id = ?",
      )
      .run(firstItemId);
    database
      .prepare("UPDATE imports SET status = 'partial' WHERE ingestion_id = ?")
      .run(ingestionId);
    const initial = (await repository.findPackGraph(packId))!;
    const remaining = [{ ...initial.items[1]!, sortIndex: 0 }];
    await repository.savePackGraph({
      pack: updatedPack(
        initial.pack,
        remaining,
        'preserved failed original',
        '2026-08-05T00:00:01Z',
      ),
      items: remaining,
      expectedRevision: initial.revision,
      removedItemOriginalDisposition: 'preserve',
    });

    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    database.exec('DROP TABLE pipeline_runs');
    database.exec('PRAGMA user_version = 4');
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    const preserved = (await repository.listImportDetails())[0]?.items[0];
    expect(preserved).toMatchObject({ id: firstItemId, status: 'failed' });
    expect(preserved).not.toHaveProperty('originalReleased');
    await expect(
      repository.deleteArtifactRecordIfUnreferenced(firstItemId),
    ).resolves.toBe(false);
  });

  test('keeps a v4 preserved removal retained through the v5 migration', async () => {
    const initial = await repository.findPackGraph(packId);
    const remaining = [{ ...initial!.items[1]!, sortIndex: 0 }];
    await repository.savePackGraph({
      pack: updatedPack(
        initial!.pack,
        remaining,
        'preserved first original',
        '2026-08-05T00:00:01Z',
      ),
      items: remaining,
      expectedRevision: initial!.revision,
      removedItemOriginalDisposition: 'preserve',
    });

    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    database.exec('DROP TABLE pipeline_runs');
    database.exec('PRAGMA user_version = 4');
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    const preserved = (await repository.listImportDetails())[0]?.items[0];
    expect(preserved).toMatchObject({ id: firstItemId, status: 'copied' });
    expect(preserved).not.toHaveProperty('originalReleased');
    await expect(
      repository.deleteArtifactRecordIfUnreferenced(firstItemId),
    ).resolves.toBe(false);
  });

  test('materializes photo, PDF, text, and URL main-app imports as ordered ContextItems', async () => {
    const items = [
      { id: mainAppImageId, mediaType: 'image/png', bytes: 4, hash: '1' },
      { id: mainAppPdfId, mediaType: 'application/pdf', bytes: 8, hash: '2' },
      { id: mainAppTextId, mediaType: 'text/plain', bytes: 12, hash: '3' },
      { id: mainAppUrlId, mediaType: 'text/uri-list', bytes: 24, hash: '4' },
    ] as const;
    await repository.commitImport({
      packId: mainAppPackId,
      manifest: {
        schemaVersion: 1,
        ingestionId: mainAppIngestionId,
        createdAt: '2026-08-05T00:00:01Z',
        source: 'main-app-picker',
        status: 'complete',
        items: items.map((item, order) => ({
          id: item.id,
          order,
          mediaType: item.mediaType,
          status: 'copied' as const,
          byteCount: item.bytes,
          relativePath: `${item.id}.bin`,
          sha256: item.hash.repeat(64),
        })),
      },
      manifestFingerprint: '5'.repeat(64),
      artifacts: items.map(item => ({
        id: item.id,
        itemId: item.id,
        relativePath: `Packs/${mainAppPackId}/originals/${item.id}.bin`,
        mediaType: item.mediaType,
        byteCount: item.bytes,
        sha256: item.hash.repeat(64),
      })),
    });

    const graph = await repository.findPackGraph(mainAppPackId);
    expect(graph?.pack.orderedItemIds).toEqual(items.map(item => item.id));
    expect(graph?.items.map(item => item.sourceType)).toEqual([
      'image',
      'pdf',
      'text',
      'url',
    ]);
    expect(graph?.items.map(item => item.state)).toEqual([
      'imported',
      'imported',
      'imported',
      'imported',
    ]);
    expect(
      graph?.items.every(item => item.originalDisplayName === undefined),
    ).toBe(true);
  });

  test('removing an item preserves its original reference by default across restart', async () => {
    const initial = await repository.findPackGraph(packId);
    const remaining = [{ ...initial!.items[1]!, sortIndex: 0 }];
    await repository.savePackGraph({
      pack: updatedPack(
        initial!.pack,
        remaining,
        'one item',
        '2026-08-05T00:00:01Z',
      ),
      items: remaining,
      expectedRevision: initial!.revision,
    });

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    expect(
      (await repository.findPackGraph(packId))?.pack.orderedItemIds,
    ).toEqual([secondItemId]);
    const candidates = await repository.listCleanupCandidates(
      '2026-08-06T00:00:00Z',
    );
    expect(candidates.map(candidate => candidate.artifactId)).not.toContain(
      firstItemId,
    );
    expect(await repository.listArtifactRecords()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstItemId })]),
    );
  });

  test('explicit destructive item removal releases only that original for reference-aware deletion', async () => {
    const initial = await repository.findPackGraph(packId);
    const remaining = [{ ...initial!.items[1]!, sortIndex: 0 }];
    await repository.savePackGraph({
      pack: updatedPack(
        initial!.pack,
        remaining,
        'one item',
        '2026-08-05T00:00:01Z',
      ),
      items: remaining,
      expectedRevision: initial!.revision,
      removedItemOriginalDisposition: 'release',
    });

    const candidates = await repository.listCleanupCandidates(
      '2026-08-06T00:00:00Z',
    );
    expect(candidates.map(candidate => candidate.artifactId)).toContain(
      firstItemId,
    );
    expect(candidates.map(candidate => candidate.artifactId)).not.toContain(
      secondItemId,
    );
    await expect(
      repository.deleteArtifactRecordIfUnreferenced(firstItemId),
    ).resolves.toBe(true);
    expect(await repository.listArtifactRecords()).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: firstItemId }),
      ]),
    );
    expect(
      (await repository.findPackGraph(packId))?.pack.orderedItemIds,
    ).toEqual([secondItemId]);

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    await expect(repository.listImportDetails()).resolves.toEqual([
      expect.objectContaining({
        ingestionId,
        items: [
          expect.objectContaining({
            id: firstItemId,
            status: 'copied',
            originalReleased: true,
          }),
          expect.objectContaining({ id: secondItemId, status: 'copied' }),
        ],
      }),
    ]);
  });

  test('round-trips risk/export records and releases only unreferenced artifacts on Pack deletion', async () => {
    const finding: RiskFinding = {
      id: findingId,
      itemId: firstItemId,
      detectorVersion: {
        processor: 'fixture-detector',
        version: '1',
        contractVersion: 1,
      },
      category: 'api-key',
      severity: 'high',
      confidence: 0.99,
      location: { kind: 'text-range', start: 0, length: 4 },
      createdAt: '2026-08-05T00:00:01Z',
    };
    await repository.saveRiskFinding(finding);
    expect(await repository.listRiskFindingsForItem(firstItemId)).toEqual([
      finding,
    ]);

    await repository.registerPublishedArtifact({
      packId,
      artifact: {
        id: derivedId,
        itemId: firstItemId,
        kind: 'ocr-text',
        relativePath: ownedDerivedPath(packId, derivedId, 'txt'),
        mediaType: 'text/plain',
        byteCount: 12,
        sha256: 'd'.repeat(64),
        processorVersion: {
          processor: 'fixture-ocr',
          version: '1',
          contractVersion: 1,
        },
        createdAt: '2026-08-05T00:00:02Z',
        immutable: true,
      },
    });
    await expect(repository.listImportDetails()).resolves.toEqual([
      expect.objectContaining({
        ingestionId,
        packId,
        itemCount: 2,
        artifactCount: 2,
        items: [
          expect.objectContaining({ id: firstItemId, status: 'copied' }),
          expect.objectContaining({ id: secondItemId, status: 'copied' }),
        ],
      }),
    ]);
    const record: ExportRecord = {
      id: exportId,
      packId,
      format: 'markdown',
      createdAt: '2026-08-05T00:00:03Z',
      preset: 'balanced',
      status: 'complete',
      manifestSha256: 'e'.repeat(64),
      artifactIds: [derivedId],
    };
    await repository.saveExportRecord(record);
    expect(await repository.listExportRecordsForPack(packId)).toEqual([record]);

    const graph = await repository.findPackGraph(packId);
    await expect(
      repository.deletePack(packId, graph!.revision),
    ).resolves.toEqual({
      removedItemCount: 2,
      releasedArtifactCount: 3,
    });
    expect(await repository.findPackGraph(packId)).toBeNull();
    expect(await repository.listRiskFindingsForItem(firstItemId)).toEqual([]);
    expect(await repository.listExportRecordsForPack(packId)).toEqual([]);

    const candidates = await repository.listCleanupCandidates(
      '2026-08-06T00:00:00Z',
    );
    expect(candidates.map(value => value.artifactId).sort()).toEqual(
      [firstItemId, secondItemId, derivedId].sort(),
    );
    for (const candidate of candidates)
      expect(
        await repository.deleteArtifactRecordIfUnreferenced(
          candidate.artifactId,
        ),
      ).toBe(true);
    expect(await repository.listArtifactRecords()).toEqual([]);
  });

  test('increments the optimistic revision when the first import appends to an existing empty Pack', async () => {
    const emptyPack: ContextPack = {
      id: emptyPackId,
      schemaVersion: 1,
      title: 'Empty Pack',
      userInstruction: '',
      createdAt,
      updatedAt: createdAt,
      state: 'draft',
      budget: {
        preset: 'balanced',
        maxOutputBytes: 10_485_760,
        minimumImageLongestEdge: 1_280,
        imageQuality: 0.82,
        estimatorVersion: 'v1',
      },
      estimatedTokens: 0,
      orderedItemIds: [],
      exportRecordIds: [],
      warningCodes: [],
    };
    await expect(
      repository.savePackGraph({ pack: emptyPack, items: [] }),
    ).resolves.toBe(1);

    await repository.commitImport({
      packId: emptyPackId,
      manifest: {
        schemaVersion: 1,
        ingestionId: appendedIngestionId,
        createdAt: '2026-08-05T00:00:01Z',
        source: 'ios-share-extension',
        status: 'complete',
        items: [
          {
            id: appendedItemId,
            order: 0,
            mediaType: 'text/plain',
            status: 'copied',
            byteCount: 3,
            relativePath: `${appendedItemId}.bin`,
            sha256: 'f'.repeat(64),
          },
        ],
      },
      manifestFingerprint: '0'.repeat(64),
      artifacts: [
        {
          id: appendedItemId,
          itemId: appendedItemId,
          relativePath: `Packs/${emptyPackId}/originals/${appendedItemId}.bin`,
          mediaType: 'text/plain',
          byteCount: 3,
          sha256: 'f'.repeat(64),
        },
      ],
    });

    const graph = await repository.findPackGraph(emptyPackId);
    expect(graph?.revision).toBe(2);
    expect(graph?.pack.orderedItemIds).toEqual([appendedItemId]);
  });

  test('maps malformed persisted values to recoverable storage divergence', async () => {
    database.exec(
      `UPDATE packs SET budget_json = 'not-json' WHERE id = '${packId}'`,
    );

    await expect(repository.findPackGraph(packId)).rejects.toMatchObject({
      code: 'STORAGE_DIVERGENCE_DETECTED',
    });
  });

  test('marks only quarantine records covered by the native mtime cutoff', async () => {
    await repository.recordQuarantine({
      id: oldQuarantineId,
      anonymousId: firstItemId,
      reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
      byteCount: 4,
      createdAt: '2026-08-01T00:00:00Z',
      purgeAfter: '2026-08-08T00:00:00Z',
    });
    await repository.recordQuarantine({
      id: recentQuarantineId,
      anonymousId: secondItemId,
      reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
      byteCount: 8,
      createdAt: '2026-08-05T00:00:00Z',
      purgeAfter: '2026-08-12T00:00:00Z',
    });

    await expect(
      repository.markQuarantinePurgedBefore(
        '2026-08-03T00:00:00Z',
        '2026-08-10T00:00:00Z',
      ),
    ).resolves.toBe(1);
    await expect(repository.getStorageUsage()).resolves.toMatchObject({
      quarantineCount: 1,
      quarantineBytes: 8,
    });
  });
});
