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
import { DEVELOPMENT_RESET_CONFIRMATION } from '../src/infrastructure/persistence/contracts';
import {
  DUPLICATE_DETECTOR_CONFIG_V1,
  buildDuplicateSuggestionsV1,
  fingerprintNormalizedTextV1,
  normalizeContentV1,
  type DuplicateAnalysisItemV1,
} from '../src/domain/duplicateDetection';
import { PackLibraryController } from '../src/features/packLibrary/controller';
import {
  BUDGET_PRESETS,
  createBudgetOptimizationPlanV1,
} from '../src/domain/budgetOptimization';

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
const secondDerivedId = '533e4567-e89b-42d3-a456-426614174000';
const findingId = '623e4567-e89b-42d3-a456-426614174000';
const exportId = '723e4567-e89b-42d3-a456-426614174000';
const emptyPackId = '823e4567-e89b-42d3-a456-426614174000';
const appendedIngestionId = '923e4567-e89b-42d3-a456-426614174000';
const appendedItemId = 'a23e4567-e89b-42d3-a456-426614174000';
const thirdIngestionId = 'a33e4567-e89b-42d3-a456-426614174000';
const thirdItemId = 'a43e4567-e89b-42d3-a456-426614174000';
const thirdDerivedId = 'a53e4567-e89b-42d3-a456-426614174000';
const oldQuarantineId = 'b23e4567-e89b-42d3-a456-426614174000';
const recentQuarantineId = 'c23e4567-e89b-42d3-a456-426614174000';
const cleanupMutationOwnerId = 'c33e4567-e89b-42d3-a456-426614174000';
const budgetDerivativeId = 'c43e4567-e89b-42d3-a456-426614174000';
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

  function dropV7OperationalLeaseColumns(): void {
    database.exec('DROP TABLE duplicate_decisions');
    database.exec('DROP TABLE duplicate_suggestions');
    database.exec('DROP TABLE duplicate_analysis_items');
    database.exec('DROP TABLE duplicate_analysis_manifests');
    database.exec('ALTER TABLE cleanup_leases DROP COLUMN session_id');
    database.exec('ALTER TABLE cleanup_leases DROP COLUMN deadline_ms');
  }

  async function acquireCleanupMutationLease(): Promise<string> {
    await repository.releaseCleanupLease(cleanupMutationOwnerId);
    await expect(
      repository.acquireCleanupLease(
        cleanupMutationOwnerId,
        '2026-08-11T00:00:00Z',
        '2026-08-11T01:00:00Z',
      ),
    ).resolves.toBe(true);
    return cleanupMutationOwnerId;
  }

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

  test('development reset drops v8 duplicate tables before replaying every migration', async () => {
    const resettable = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
      undefined,
      true,
    );
    await resettable.initialize();

    await expect(
      resettable.resetForDevelopment(DEVELOPMENT_RESET_CONFIRMATION),
    ).resolves.toBeUndefined();

    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 8,
    });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'duplicate_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'duplicate_analysis_items' },
      { name: 'duplicate_analysis_manifests' },
      { name: 'duplicate_decisions' },
      { name: 'duplicate_suggestions' },
    ]);
    await expect(resettable.listPackGraphs()).resolves.toEqual([]);
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
    dropV7OperationalLeaseColumns();
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
      repository.deleteArtifactRecordIfUnreferenced(
        firstItemId,
        await acquireCleanupMutationLease(),
      ),
    ).resolves.toBe(true);

    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    dropV7OperationalLeaseColumns();
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
    dropV7OperationalLeaseColumns();
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
      repository.deleteArtifactRecordIfUnreferenced(
        firstItemId,
        await acquireCleanupMutationLease(),
      ),
    ).resolves.toBe(true);
    expect((await repository.listImportDetails())[0]?.items[0]).toMatchObject({
      id: firstItemId,
      originalReleased: true,
    });
  });

  test.each([['pre-cleanup', false] as const, ['post-cleanup', true] as const])(
    'migrates a %s v4 destructive release for a failed retry-source item without inventing provenance',
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
          repository.deleteArtifactRecordIfUnreferenced(
            firstItemId,
            await acquireCleanupMutationLease(),
          ),
        ).resolves.toBe(true);

      database.exec(
        'ALTER TABLE import_items DROP COLUMN original_disposition',
      );
      dropV7OperationalLeaseColumns();
      database.exec('DROP TABLE pipeline_runs');
      database.exec('PRAGMA user_version = 4');
      database.close();
      database = new DatabaseSync(databasePath);
      repository = new ExpoSqlitePersistenceRepository(
        new NodeSqlConnection(database) as never,
      );
      await repository.initialize();

      const migrated = (await repository.listImportDetails())[0]?.items[0];
      expect(migrated).toMatchObject({ id: firstItemId, status: 'failed' });
      if (cleanBeforeMigration) {
        // Once both the v4 graph row and physical artifact are gone, explicit
        // release is indistinguishable from a provider-less failed import.
        // Preserve unavailable instead of inventing a destructive action.
        expect(migrated).not.toHaveProperty('originalReleased');
        expect(migrated).not.toHaveProperty('retrySource');
      } else {
        expect(migrated).toMatchObject({ originalReleased: true });
      }
      if (!cleanBeforeMigration)
        await expect(
          repository.deleteArtifactRecordIfUnreferenced(
            firstItemId,
            await acquireCleanupMutationLease(),
          ),
        ).resolves.toBe(true);
    },
  );

  test('keeps a provider-less v4 failed row unavailable after its graph row is gone', async () => {
    database
      .prepare(
        "UPDATE import_items SET status = 'failed', error_code = 'IMPORT_COPY_FAILED' WHERE id = ?",
      )
      .run(firstItemId);
    database
      .prepare("UPDATE imports SET status = 'partial' WHERE ingestion_id = ?")
      .run(ingestionId);
    database
      .prepare('DELETE FROM artifact_references WHERE artifact_id = ?')
      .run(firstItemId);
    database.prepare('DELETE FROM context_items WHERE id = ?').run(firstItemId);
    database.prepare('DELETE FROM artifacts WHERE id = ?').run(firstItemId);

    database.exec('ALTER TABLE import_items DROP COLUMN original_disposition');
    dropV7OperationalLeaseColumns();
    database.exec('DROP TABLE pipeline_runs');
    database.exec('PRAGMA user_version = 4');
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    const unavailable = (await repository.listImportDetails())[0]?.items[0];
    expect(unavailable).toMatchObject({
      id: firstItemId,
      status: 'failed',
      errorCode: 'IMPORT_COPY_FAILED',
    });
    expect(unavailable).not.toHaveProperty('originalReleased');
    expect(unavailable).not.toHaveProperty('retrySource');
  });

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
    dropV7OperationalLeaseColumns();
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
      repository.deleteArtifactRecordIfUnreferenced(
        firstItemId,
        await acquireCleanupMutationLease(),
      ),
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
    dropV7OperationalLeaseColumns();
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
      repository.deleteArtifactRecordIfUnreferenced(
        firstItemId,
        await acquireCleanupMutationLease(),
      ),
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
      repository.deleteArtifactRecordIfUnreferenced(
        firstItemId,
        await acquireCleanupMutationLease(),
      ),
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

    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-05T00:00:02Z',
        '2026-08-05T00:01:02Z',
      ),
    ).resolves.toBe(true);
    await repository.registerPublishedArtifact({
      packId,
      publicationLeaseOwnerId: exportId,
      publicationLeaseObservedAt: '2026-08-05T00:00:02Z',
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
    await repository.releaseCleanupLease(exportId);
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
          await acquireCleanupMutationLease(),
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
        targetImageLongestEdge: 1_280,
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

  test('restores a pending budget optimization plan after reopening SQLite', async () => {
    const graph = await repository.findPackGraph(packId);
    const pendingOptimization = createBudgetOptimizationPlanV1({
      planId: 'b43e4567-e89b-42d3-a456-426614174000',
      packId,
      packRevision: graph!.revision,
      createdAt: '2026-08-14T00:10:00Z',
      budget: BUDGET_PRESETS.compact,
      items: [
        {
          itemId: firstItemId,
          sourceType: 'text',
          included: true,
          includeOriginal: true,
          includeExtracted: false,
          sourceByteCount: 4,
          textCharacterCount: 0,
          textUtf8ByteCount: 0,
          pdfPageCount: 0,
        },
      ],
      exclusions: [],
      createArtifactId: () => 'c43e4567-e89b-42d3-a456-426614174000',
    });
    await repository.savePackGraph({
      pack: {
        ...graph!.pack,
        updatedAt: pendingOptimization.createdAt,
        budget: { ...graph!.pack.budget, pendingOptimization },
      },
      items: graph!.items,
      expectedRevision: graph!.revision,
    });

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    await expect(repository.findPackGraph(packId)).resolves.toMatchObject({
      pack: { budget: { pendingOptimization } },
    });
  });

  test('atomically reconciles duplicate decisions and restores budget exclusions across restarts', async () => {
    const graph = (await repository.findPackGraph(packId))!;
    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-05T00:00:03Z',
        '2026-08-05T00:01:03Z',
      ),
    ).resolves.toBe(true);
    await repository.registerPublishedArtifact({
      packId,
      publicationLeaseOwnerId: exportId,
      artifact: {
        id: budgetDerivativeId,
        itemId: firstItemId,
        kind: 'compressed-image',
        relativePath: ownedDerivedPath(packId, budgetDerivativeId, 'jpg'),
        mediaType: 'image/jpeg',
        byteCount: 2,
        sha256: '9'.repeat(64),
        processorVersion: {
          processor: 'image-compression',
          version: 'image-compression-v1',
          contractVersion: 1,
        },
        createdAt: '2026-08-05T00:00:03Z',
        immutable: true,
      },
    });
    await repository.releaseCleanupLease(exportId);
    const exclusionDecision = {
      schemaVersion: 1,
      packId,
      itemId: firstItemId,
      choice: 'keep',
      baselineInclusionMode: 'both',
      decidedAt: '2026-08-05T00:00:04Z',
    } as const;
    database
      .prepare(
        `INSERT INTO duplicate_decisions
          (item_id, pack_id, payload_json, decided_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        firstItemId,
        packId,
        JSON.stringify(exclusionDecision),
        exclusionDecision.decidedAt,
      );
    const exclusions = [
      { itemId: firstItemId, baselineInclusionMode: 'both' as const },
      { itemId: secondItemId, baselineInclusionMode: 'both' as const },
    ];
    const latestEstimate = {
      schemaVersion: 1 as const,
      estimatorVersion: 'context-budget-estimator-v1' as const,
      isEstimate: true as const,
      sourceBytes: 12,
      predictedOutputBytes: 0,
      imageCount: 0,
      pdfPageCount: 0,
      textCharacterCount: 0,
      estimatedTokens: 0,
    };
    const latestOptimization = {
      schemaVersion: 1 as const,
      planId: 'b43e4567-e89b-42d3-a456-426614174000',
      estimatorVersion: 'context-budget-estimator-v1' as const,
      compressionVersion: 'image-compression-v1' as const,
      completedAt: '2026-08-05T00:00:05Z',
      predictedOutputBytes: 0,
      actualOutputBytes: 0,
      predictedSavingsBytes: 12,
      actualSavingsBytes: 12,
      deviationBytes: 0,
      withinBudget: true,
      excludedItemIds: [firstItemId, secondItemId],
      items: [
        {
          itemId: firstItemId,
          action: 'compressed' as const,
          predictedOutputBytes: 2,
          actualOutputBytes: 2,
          actualSavingsBytes: 2,
          deviationBytes: 0,
          artifactId: budgetDerivativeId,
        },
      ],
    };

    await repository.savePackGraph({
      pack: {
        ...graph.pack,
        updatedAt: latestOptimization.completedAt,
        budget: {
          ...BUDGET_PRESETS.compact,
          exclusions,
          latestEstimate,
          latestOptimization,
        },
        estimatedTokens: 0,
      },
      items: graph.items.map(item => ({
        ...item,
        artifactIds:
          item.id === firstItemId
            ? [...item.artifactIds, budgetDerivativeId]
            : item.artifactIds,
        inclusionMode: 'excluded' as const,
      })),
      expectedRevision: graph.revision,
    });
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM duplicate_decisions WHERE item_id = ?',
        )
        .get(firstItemId),
    ).toEqual({ count: 1 });

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();
    await expect(repository.findPackGraph(packId)).resolves.toMatchObject({
      pack: { budget: { exclusions, latestOptimization } },
      items: [
        expect.objectContaining({
          id: firstItemId,
          inclusionMode: 'excluded',
        }),
        expect.objectContaining({
          id: secondItemId,
          inclusionMode: 'excluded',
        }),
      ],
    });
    expect(
      database
        .prepare(
          'SELECT payload_json FROM duplicate_decisions WHERE item_id = ?',
        )
        .get(firstItemId),
    ).toEqual({ payload_json: JSON.stringify(exclusionDecision) });

    database
      .prepare(
        `INSERT INTO duplicate_suggestions
          (suggestion_key, pack_id, left_item_id, right_item_id, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'budget-overlay-regression',
        packId,
        firstItemId,
        secondItemId,
        '{}',
      );
    const duplicateExclusion = {
      ...exclusionDecision,
      choice: 'exclude' as const,
      decidedAt: '2026-08-05T00:00:05.500Z',
    };
    await repository.saveDuplicateDecisions(packId, [duplicateExclusion]);
    await expect(repository.findPackGraph(packId)).resolves.toMatchObject({
      pack: { budget: { exclusions } },
      items: [
        expect.objectContaining({
          id: firstItemId,
          inclusionMode: 'excluded',
        }),
        expect.objectContaining({
          id: secondItemId,
          inclusionMode: 'excluded',
        }),
      ],
    });

    const controller = new PackLibraryController(
      async () => repository,
      () => '2026-08-05T00:00:06Z',
    );
    await controller.restoreBudgetExclusion(packId, firstItemId);
    let restored = (await repository.findPackGraph(packId))!;
    expect(restored.items.map(item => item.inclusionMode)).toEqual([
      'excluded',
      'excluded',
    ]);
    expect(restored.pack.budget).toMatchObject({
      exclusions: [exclusions[1]],
    });
    expect(restored.pack.budget.latestOptimization).toBeUndefined();
    await expect(
      repository.listCleanupCandidates('2026-08-05T00:00:06.250Z'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: budgetDerivativeId }),
      ]),
    );
    expect(
      database
        .prepare(
          'SELECT payload_json FROM duplicate_decisions WHERE item_id = ?',
        )
        .get(firstItemId),
    ).toEqual({ payload_json: JSON.stringify(duplicateExclusion) });
    await repository.restoreDuplicateDecision(
      packId,
      firstItemId,
      '2026-08-05T00:00:06.500Z',
    );
    restored = (await repository.findPackGraph(packId))!;
    expect(restored.items.map(item => item.inclusionMode)).toEqual([
      'both',
      'excluded',
    ]);

    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();
    const restartedController = new PackLibraryController(
      async () => repository,
      () => '2026-08-05T00:00:07Z',
    );
    await restartedController.restoreBudgetExclusion(packId, secondItemId);
    restored = (await repository.findPackGraph(packId))!;
    expect(restored.items.map(item => item.inclusionMode)).toEqual([
      'both',
      'both',
    ]);
    expect(restored.pack.budget.exclusions).toBeUndefined();
  });

  test('fails closed before releasing a completed derivative whose persisted identity is corrupted', async () => {
    const graph = (await repository.findPackGraph(packId))!;
    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-15T00:00:00Z',
        '2026-08-15T00:01:00Z',
      ),
    ).resolves.toBe(true);
    await repository.registerPublishedArtifact({
      packId,
      publicationLeaseOwnerId: exportId,
      artifact: {
        id: budgetDerivativeId,
        itemId: firstItemId,
        kind: 'compressed-image',
        relativePath: ownedDerivedPath(packId, budgetDerivativeId, 'jpg'),
        mediaType: 'image/jpeg',
        byteCount: 2,
        sha256: '9'.repeat(64),
        processorVersion: {
          processor: 'image-compression',
          version: 'image-compression-v1',
          contractVersion: 1,
        },
        createdAt: '2026-08-15T00:00:00Z',
        immutable: true,
      },
    });
    await repository.releaseCleanupLease(exportId);
    const exclusion = {
      itemId: firstItemId,
      baselineInclusionMode: 'both' as const,
    };
    const latestOptimization = {
      schemaVersion: 1 as const,
      planId: 'b43e4567-e89b-42d3-a456-426614174000',
      estimatorVersion: 'context-budget-estimator-v1' as const,
      compressionVersion: 'image-compression-v1' as const,
      completedAt: '2026-08-15T00:00:01Z',
      predictedOutputBytes: 2,
      actualOutputBytes: 2,
      predictedSavingsBytes: 2,
      actualSavingsBytes: 2,
      deviationBytes: 0,
      withinBudget: true,
      excludedItemIds: [firstItemId],
      items: [
        {
          itemId: firstItemId,
          action: 'compressed' as const,
          predictedOutputBytes: 2,
          actualOutputBytes: 2,
          actualSavingsBytes: 2,
          deviationBytes: 0,
          artifactId: budgetDerivativeId,
        },
      ],
    };
    await repository.savePackGraph({
      pack: {
        ...graph.pack,
        updatedAt: latestOptimization.completedAt,
        budget: {
          ...graph.pack.budget,
          exclusions: [exclusion],
          latestOptimization,
        },
      },
      items: graph.items.map(item => ({
        ...item,
        inclusionMode:
          item.id === firstItemId ? ('excluded' as const) : item.inclusionMode,
        artifactIds:
          item.id === firstItemId
            ? [...item.artifactIds, budgetDerivativeId]
            : item.artifactIds,
      })),
      expectedRevision: graph.revision,
    });
    const persistedBudget = JSON.parse(
      (
        database
          .prepare('SELECT budget_json FROM packs WHERE id = ?')
          .get(packId) as { budget_json: string }
      ).budget_json,
    ) as { latestOptimization: { items: [{ artifactId: string }] } };
    persistedBudget.latestOptimization.items[0].artifactId = firstItemId;
    database
      .prepare('UPDATE packs SET budget_json = ? WHERE id = ?')
      .run(JSON.stringify(persistedBudget), packId);

    await expect(
      repository.restoreBudgetExclusion(
        packId,
        firstItemId,
        '2026-08-15T00:00:02Z',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    expect(
      database
        .prepare(
          `SELECT artifact_id FROM artifact_references
           WHERE owner_type = 'pack' AND owner_id = ? ORDER BY artifact_id`,
        )
        .all(packId),
    ).toEqual(
      expect.arrayContaining([
        { artifact_id: firstItemId },
        { artifact_id: budgetDerivativeId },
      ]),
    );
  });

  test('atomically invalidates completed optimization and releases derivatives when Pack content is removed', async () => {
    const graph = (await repository.findPackGraph(packId))!;
    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-15T00:10:00Z',
        '2026-08-15T00:11:00Z',
      ),
    ).resolves.toBe(true);
    await repository.registerPublishedArtifact({
      packId,
      publicationLeaseOwnerId: exportId,
      artifact: {
        id: budgetDerivativeId,
        itemId: firstItemId,
        kind: 'compressed-image',
        relativePath: ownedDerivedPath(packId, budgetDerivativeId, 'jpg'),
        mediaType: 'image/jpeg',
        byteCount: 2,
        sha256: '9'.repeat(64),
        processorVersion: {
          processor: 'image-compression',
          version: 'image-compression-v1',
          contractVersion: 1,
        },
        createdAt: '2026-08-15T00:10:00Z',
        immutable: true,
      },
    });
    await repository.releaseCleanupLease(exportId);
    const latestEstimate = {
      schemaVersion: 1 as const,
      estimatorVersion: 'context-budget-estimator-v1' as const,
      isEstimate: true as const,
      sourceBytes: 12,
      predictedOutputBytes: 10,
      imageCount: 1,
      pdfPageCount: 1,
      textCharacterCount: 0,
      estimatedTokens: 0,
    };
    const latestOptimization = {
      schemaVersion: 1 as const,
      planId: 'b43e4567-e89b-42d3-a456-426614174000',
      estimatorVersion: 'context-budget-estimator-v1' as const,
      compressionVersion: 'image-compression-v1' as const,
      completedAt: '2026-08-15T00:10:01Z',
      predictedOutputBytes: 10,
      actualOutputBytes: 10,
      predictedSavingsBytes: 2,
      actualSavingsBytes: 2,
      deviationBytes: 0,
      withinBudget: true,
      excludedItemIds: [] as string[],
      items: [
        {
          itemId: firstItemId,
          action: 'compressed' as const,
          predictedOutputBytes: 2,
          actualOutputBytes: 2,
          actualSavingsBytes: 2,
          deviationBytes: 0,
          artifactId: budgetDerivativeId,
        },
      ],
    };
    const optimizedRevision = await repository.savePackGraph({
      pack: {
        ...graph.pack,
        updatedAt: latestOptimization.completedAt,
        budget: {
          ...graph.pack.budget,
          latestEstimate,
          latestOptimization,
        },
      },
      items: graph.items.map(item => ({
        ...item,
        artifactIds:
          item.id === firstItemId
            ? [...item.artifactIds, budgetDerivativeId]
            : item.artifactIds,
      })),
      expectedRevision: graph.revision,
    });
    const optimized = (await repository.findPackGraph(packId))!;
    expect(optimized.revision).toBe(optimizedRevision);

    const controller = new PackLibraryController(
      async () => repository,
      () => '2026-08-15T00:10:02Z',
    );
    await controller.removeItem(packId, secondItemId, 'preserve');

    const updated = (await repository.findPackGraph(packId))!;
    expect(updated.pack.budget.latestEstimate).toBeUndefined();
    expect(updated.pack.budget.latestOptimization).toBeUndefined();
    expect(updated.items).toEqual([
      expect.objectContaining({
        id: firstItemId,
        artifactIds: [firstItemId],
      }),
    ]);
    await expect(
      repository.listCleanupCandidates('2026-08-15T00:10:03Z'),
    ).resolves.toContainEqual(
      expect.objectContaining({ artifactId: budgetDerivativeId }),
    );
  });

  test('invalidates a stale optimization and releases its partial derivative in the same Pack mutation', async () => {
    const graph = await repository.findPackGraph(packId);
    const pendingOptimization = createBudgetOptimizationPlanV1({
      planId: 'b43e4567-e89b-42d3-a456-426614174000',
      packId,
      packRevision: graph!.revision,
      createdAt: '2026-08-14T00:10:00Z',
      budget: BUDGET_PRESETS.compact,
      items: [
        {
          itemId: firstItemId,
          sourceType: 'image',
          included: true,
          includeOriginal: true,
          includeExtracted: false,
          sourceByteCount: 4_000_000,
          textCharacterCount: 0,
          textUtf8ByteCount: 0,
          pdfPageCount: 0,
          image: {
            schemaVersion: 1,
            sourceByteCount: 4_000_000,
            sourceSha256: 'a'.repeat(64),
            sourceMediaType: 'image/png',
            width: 4_000,
            height: 3_000,
            hasAlpha: false,
            animated: false,
            orientationApplied: true,
            revision: '1',
          },
        },
      ],
      exclusions: [],
      createArtifactId: () => budgetDerivativeId,
    });
    expect(pendingOptimization.actions).toEqual([
      expect.objectContaining({
        kind: 'compress',
        outputArtifactId: budgetDerivativeId,
      }),
    ]);
    const checkpointRevision = await repository.savePackGraph({
      pack: {
        ...graph!.pack,
        updatedAt: pendingOptimization.createdAt,
        budget: { ...graph!.pack.budget, pendingOptimization },
      },
      items: graph!.items,
      expectedRevision: graph!.revision,
    });
    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-14T00:10:00Z',
        '2026-08-14T00:11:00Z',
      ),
    ).resolves.toBe(true);
    await repository.registerPublishedArtifact({
      packId,
      publicationLeaseOwnerId: exportId,
      budgetOptimizationFence: {
        planId: pendingOptimization.planId,
        expectedRevision: checkpointRevision,
      },
      artifact: {
        id: budgetDerivativeId,
        itemId: firstItemId,
        kind: 'compressed-image',
        relativePath: ownedDerivedPath(packId, budgetDerivativeId, 'jpg'),
        mediaType: 'image/jpeg',
        byteCount: 500_000,
        sha256: '9'.repeat(64),
        processorVersion: {
          processor: 'image-compression',
          version: 'image-compression-v1',
          contractVersion: 1,
        },
        createdAt: pendingOptimization.createdAt,
        immutable: true,
      },
    });
    await repository.releaseCleanupLease(exportId);
    const controller = new PackLibraryController(
      async () => repository,
      () => '2026-08-14T00:10:01Z',
    );

    await controller.renamePack(packId, 'Replacement plan enabled');

    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-14T00:10:01Z',
        '2026-08-14T00:11:01Z',
      ),
    ).resolves.toBe(true);
    await expect(
      repository.registerPublishedArtifact({
        packId,
        publicationLeaseOwnerId: exportId,
        budgetOptimizationFence: {
          planId: pendingOptimization.planId,
          expectedRevision: checkpointRevision,
        },
        artifact: {
          id: budgetDerivativeId,
          itemId: firstItemId,
          kind: 'compressed-image',
          relativePath: ownedDerivedPath(packId, budgetDerivativeId, 'jpg'),
          mediaType: 'image/jpeg',
          byteCount: 500_000,
          sha256: '9'.repeat(64),
          processorVersion: {
            processor: 'image-compression',
            version: 'image-compression-v1',
            contractVersion: 1,
          },
          createdAt: pendingOptimization.createdAt,
          immutable: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    await repository.releaseCleanupLease(exportId);

    const updated = await repository.findPackGraph(packId);
    expect(updated?.pack.budget.pendingOptimization).toBeUndefined();
    await expect(
      repository.listCleanupCandidates('2026-08-14T00:10:02Z'),
    ).resolves.toContainEqual(
      expect.objectContaining({ artifactId: budgetDerivativeId }),
    );
  });

  test('maps malformed persisted values to recoverable storage divergence', async () => {
    database.exec(
      `UPDATE packs SET budget_json = 'not-json' WHERE id = '${packId}'`,
    );

    await expect(repository.findPackGraph(packId)).rejects.toMatchObject({
      code: 'STORAGE_DIVERGENCE_DETECTED',
    });
  });

  test('persists detector output separately from reversible duplicate decisions', async () => {
    const normalized = normalizeContentV1(
      'Synthetic repeated context long enough for deterministic duplicate analysis.',
    );
    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-05T00:00:01Z',
        '2026-08-05T00:01:01Z',
      ),
    ).resolves.toBe(true);
    const artifacts = [
      { id: derivedId, itemId: firstItemId, sha256: 'd'.repeat(64) },
      { id: secondDerivedId, itemId: secondItemId, sha256: 'e'.repeat(64) },
    ] as const;
    for (const artifact of artifacts)
      await repository.registerPublishedArtifact({
        packId,
        publicationLeaseOwnerId: exportId,
        artifact: {
          id: artifact.id,
          itemId: artifact.itemId,
          kind: 'normalized-text',
          relativePath: ownedDerivedPath(packId, artifact.id, 'txt'),
          mediaType: 'text/plain',
          byteCount: normalized.utf8ByteCount,
          sha256: artifact.sha256,
          processorVersion: {
            processor: 'shared-content-normalization',
            version: 'text-normalization-v1',
            contractVersion: 1,
          },
          createdAt: '2026-08-05T00:00:02Z',
          immutable: true,
        },
      });
    await repository.releaseCleanupLease(exportId);
    const analyses: readonly DuplicateAnalysisItemV1[] = artifacts.map(
      (artifact, index) => ({
        schemaVersion: 1,
        packId,
        itemId: artifact.itemId,
        originalSha256: index === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
        originalByteCount: index === 0 ? 4 : 8,
        normalizedArtifactId: artifact.id,
        normalizedSha256: artifact.sha256,
        normalizedByteCount: normalized.utf8ByteCount,
        normalizedCharacterCount: normalized.characterCount,
        contentKind: normalized.contentKind,
        textFingerprint: fingerprintNormalizedTextV1(normalized),
        ...(index === 0
          ? {
              imageFingerprint: {
                schemaVersion: 1 as const,
                algorithm: 'dhash-64-v1' as const,
                hash: '0123456789abcdef',
                sampleWidth: 9 as const,
                sampleHeight: 8 as const,
                orientationApplied: true as const,
                durationMs: 0,
                revision: '1' as const,
              },
            }
          : {}),
        analyzedAt: `2026-08-05T00:00:0${index + 2}Z`,
      }),
    );
    const suggestions = buildDuplicateSuggestionsV1(analyses);
    await repository.replaceDuplicateAnalysis({
      manifest: {
        schemaVersion: 1,
        packId,
        config: DUPLICATE_DETECTOR_CONFIG_V1,
        analyzedAt: '2026-08-05T00:00:03Z',
        itemCount: 2,
        suggestionCount: suggestions.length,
      },
      analyses,
      suggestions,
    });
    expect(suggestions).toHaveLength(1);
    const mismatchedSuggestions = [
      {
        ...suggestions[0]!,
        expectedBytesSaved: suggestions[0]!.expectedBytesSaved + 1,
      },
    ];
    await expect(
      repository.replaceDuplicateAnalysis({
        manifest: {
          schemaVersion: 1,
          packId,
          config: DUPLICATE_DETECTOR_CONFIG_V1,
          analyzedAt: '2026-08-05T00:00:03Z',
          itemCount: 2,
          suggestionCount: mismatchedSuggestions.length,
        },
        analyses,
        suggestions: mismatchedSuggestions,
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    const forgedAnalyses = [
      { ...analyses[0]!, originalSha256: 'f'.repeat(64) },
      analyses[1]!,
    ];
    await expect(
      repository.replaceDuplicateAnalysis({
        manifest: {
          schemaVersion: 1,
          packId,
          config: DUPLICATE_DETECTOR_CONFIG_V1,
          analyzedAt: '2026-08-05T00:00:03Z',
          itemCount: 2,
          suggestionCount: buildDuplicateSuggestionsV1(forgedAnalyses).length,
        },
        analyses: forgedAnalyses,
        suggestions: buildDuplicateSuggestionsV1(forgedAnalyses),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });

    await repository.saveDuplicateDecisions(packId, [
      {
        schemaVersion: 1,
        packId,
        itemId: secondItemId,
        choice: 'exclude',
        baselineInclusionMode: 'both',
        decidedAt: '2026-08-05T00:00:04Z',
      },
    ]);
    const decidedGraph = (await repository.findPackGraph(packId))!;
    await expect(
      repository.savePackGraph({
        pack: decidedGraph.pack,
        items: decidedGraph.items.map(item =>
          item.id === secondItemId
            ? { ...item, inclusionMode: 'both' as const }
            : item,
        ),
        expectedRevision: decidedGraph.revision,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    const preservedGraph = await repository.findPackGraph(packId);
    expect(preservedGraph?.revision).toBe(decidedGraph.revision);
    expect(
      preservedGraph?.items.find(item => item.id === secondItemId)
        ?.inclusionMode,
    ).toBe('excluded');
    database
      .prepare('UPDATE context_items SET inclusion_mode = ? WHERE id = ?')
      .run('both', secondItemId);
    await expect(repository.findPackGraph(packId)).rejects.toMatchObject({
      code: 'STORAGE_DIVERGENCE_DETECTED',
    });
    database
      .prepare('UPDATE context_items SET inclusion_mode = ? WHERE id = ?')
      .run('excluded', secondItemId);
    database
      .prepare('INSERT INTO packs (id, created_at) VALUES (?, ?)')
      .run(emptyPackId, createdAt);
    database
      .prepare('UPDATE duplicate_decisions SET pack_id = ? WHERE item_id = ?')
      .run(emptyPackId, secondItemId);
    await expect(repository.findPackGraph(packId)).rejects.toMatchObject({
      code: 'STORAGE_DIVERGENCE_DETECTED',
    });
    database
      .prepare('UPDATE duplicate_decisions SET pack_id = ? WHERE item_id = ?')
      .run(packId, secondItemId);
    await repository.replaceDuplicateAnalysis({
      manifest: {
        schemaVersion: 1,
        packId,
        config: DUPLICATE_DETECTOR_CONFIG_V1,
        analyzedAt: '2026-08-05T00:00:03Z',
        itemCount: 2,
        suggestionCount: suggestions.length,
      },
      analyses,
      suggestions,
    });
    expect(await repository.findDuplicateAnalysis(packId)).toMatchObject({
      decisions: [
        expect.objectContaining({ itemId: secondItemId, choice: 'exclude' }),
      ],
    });
    await expect(
      repository.replaceDuplicateAnalysis({
        manifest: {
          schemaVersion: 1,
          packId,
          config: DUPLICATE_DETECTOR_CONFIG_V1,
          analyzedAt: analyses[0]!.analyzedAt,
          itemCount: 1,
          suggestionCount: 0,
        },
        analyses: [analyses[0]!],
        suggestions: [],
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    expect(
      (await repository.findPackGraph(packId))?.items.find(
        item => item.id === secondItemId,
      )?.inclusionMode,
    ).toBe('excluded');

    await repository.saveDuplicateDecisions(packId, [
      {
        schemaVersion: 1,
        packId,
        itemId: secondItemId,
        choice: 'keep',
        baselineInclusionMode: 'both',
        decidedAt: '2026-08-05T00:00:05Z',
      },
    ]);
    expect(
      (await repository.findPackGraph(packId))?.items.find(
        item => item.id === secondItemId,
      )?.inclusionMode,
    ).toBe('both');
    expect(
      database
        .prepare('SELECT updated_at FROM context_items WHERE id = ?')
        .get(secondItemId),
    ).toEqual({ updated_at: '2026-08-05T00:00:05Z' });

    await repository.saveDuplicateDecisions(packId, [
      {
        schemaVersion: 1,
        packId,
        itemId: firstItemId,
        choice: 'preferred',
        baselineInclusionMode: 'both',
        source: 'preferred-group',
        decidedAt: '2026-08-05T00:00:06Z',
      },
      {
        schemaVersion: 1,
        packId,
        itemId: secondItemId,
        choice: 'exclude',
        baselineInclusionMode: 'both',
        source: 'preferred-group',
        decidedAt: '2026-08-05T00:00:06Z',
      },
    ]);
    await repository.saveDuplicateDecisions(packId, [
      {
        schemaVersion: 1,
        packId,
        itemId: firstItemId,
        choice: 'exclude',
        baselineInclusionMode: 'both',
        source: 'preferred-group',
        decidedAt: '2026-08-05T00:00:07Z',
      },
      {
        schemaVersion: 1,
        packId,
        itemId: secondItemId,
        choice: 'preferred',
        baselineInclusionMode: 'both',
        source: 'preferred-group',
        decidedAt: '2026-08-05T00:00:07Z',
      },
    ]);
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();
    expect(await repository.findDuplicateAnalysis(packId)).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({
          itemId: firstItemId,
          choice: 'exclude',
          source: 'preferred-group',
        }),
        expect.objectContaining({
          itemId: secondItemId,
          choice: 'preferred',
          source: 'preferred-group',
        }),
      ]),
    });
    expect(
      (await repository.findPackGraph(packId))?.items.map(item => ({
        id: item.id,
        inclusionMode: item.inclusionMode,
      })),
    ).toEqual([
      { id: firstItemId, inclusionMode: 'excluded' },
      { id: secondItemId, inclusionMode: 'both' },
    ]);

    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(forgedAnalyses[0]), firstItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[0]), firstItemId);

    const impossibleFingerprint = {
      ...analyses[0]!,
      textFingerprint: {
        ...analyses[0]!.textFingerprint,
        shingleCount: 0,
      },
    };
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(impossibleFingerprint), firstItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[0]), firstItemId);

    const impossibleShingleCount = {
      ...analyses[0]!,
      textFingerprint: {
        ...analyses[0]!.textFingerprint,
        shingleCount: 1_000_000,
      },
    };
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(impossibleShingleCount), firstItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[0]), firstItemId);

    const overpopulatedFingerprint = {
      ...analyses[0]!,
      textFingerprint: {
        ...analyses[0]!.textFingerprint,
        shingleCount: 1,
        hashes: ['00000001', '00000002'],
      },
    };
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(overpopulatedFingerprint), firstItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[0]), firstItemId);

    for (const impossibleCounts of [
      {
        ...analyses[0]!,
        normalizedByteCount: 0,
        normalizedCharacterCount: 0,
      },
      {
        ...analyses[0]!,
        normalizedByteCount: 0,
        normalizedCharacterCount: 1,
      },
    ]) {
      database
        .prepare(
          'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
        )
        .run(JSON.stringify(impossibleCounts), firstItemId);
      await expect(
        repository.findDuplicateAnalysis(packId),
      ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    }
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[0]), firstItemId);

    const missingImageFingerprint = { ...analyses[0]! };
    delete (missingImageFingerprint as { imageFingerprint?: unknown })
      .imageFingerprint;
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(missingImageFingerprint), firstItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[0]), firstItemId);

    const nonImageWithFingerprint = {
      ...analyses[1]!,
      imageFingerprint: analyses[0]!.imageFingerprint,
    };
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(nonImageWithFingerprint), secondItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(analyses[1]), secondItemId);

    database
      .prepare(
        'UPDATE duplicate_analysis_items SET analyzed_at = ? WHERE item_id = ?',
      )
      .run('2026-08-05T00:00:04Z', firstItemId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_items SET analyzed_at = ? WHERE item_id = ?',
      )
      .run(analyses[0]!.analyzedAt, firstItemId);

    database
      .prepare(
        'UPDATE duplicate_suggestions SET payload_json = ? WHERE suggestion_key = ?',
      )
      .run(JSON.stringify(mismatchedSuggestions[0]), suggestions[0]!.key);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_suggestions SET payload_json = ? WHERE suggestion_key = ?',
      )
      .run(JSON.stringify(suggestions[0]), suggestions[0]!.key);

    const mismatchedManifest = {
      schemaVersion: 1,
      packId,
      config: DUPLICATE_DETECTOR_CONFIG_V1,
      analyzedAt: '2026-08-05T00:00:04Z',
      itemCount: 2,
      suggestionCount: suggestions.length,
    } as const;
    database
      .prepare(
        'UPDATE duplicate_analysis_manifests SET payload_json = ? WHERE pack_id = ?',
      )
      .run(JSON.stringify(mismatchedManifest), packId);
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_analysis_manifests SET payload_json = ? WHERE pack_id = ?',
      )
      .run(
        JSON.stringify({
          ...mismatchedManifest,
          analyzedAt: '2026-08-05T00:00:03Z',
        }),
        packId,
      );

    const decision = {
      schemaVersion: 1,
      packId,
      itemId: secondItemId,
      choice: 'keep',
      baselineInclusionMode: 'both',
      decidedAt: '2026-08-05T00:00:05Z',
    } as const;
    database
      .prepare(
        'UPDATE duplicate_decisions SET payload_json = ? WHERE item_id = ?',
      )
      .run(
        JSON.stringify({ ...decision, itemId: appendedItemId }),
        secondItemId,
      );
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    database
      .prepare(
        'UPDATE duplicate_decisions SET payload_json = ? WHERE item_id = ?',
      )
      .run(JSON.stringify(decision), secondItemId);

    await repository.saveDuplicateDecisions(packId, [
      {
        ...decision,
        choice: 'exclude',
        decidedAt: '2026-08-05T00:00:05.500Z',
      },
    ]);

    const graphBeforeRemoval = await repository.findPackGraph(packId);
    expect(graphBeforeRemoval).not.toBeNull();
    const remainingItems = graphBeforeRemoval!.items
      .filter(item => item.id === secondItemId)
      .map(item => ({ ...item, sortIndex: 0 }));
    await repository.savePackGraph({
      pack: {
        ...graphBeforeRemoval!.pack,
        orderedItemIds: [secondItemId],
        updatedAt: '2026-08-05T00:00:06Z',
      },
      items: remainingItems,
      expectedRevision: graphBeforeRemoval!.revision,
      removedItemOriginalDisposition: 'preserve',
    });
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).resolves.toMatchObject({
      manifest: { itemCount: 1, suggestionCount: 0 },
      analyses: [expect.objectContaining({ itemId: secondItemId })],
      suggestions: [],
      decisions: [
        expect.objectContaining({ itemId: secondItemId, choice: 'exclude' }),
      ],
    });
    expect(
      (await repository.findPackGraph(packId))?.items.find(
        item => item.id === secondItemId,
      )?.inclusionMode,
    ).toBe('excluded');

    database.exec(
      `DELETE FROM duplicate_suggestions WHERE pack_id = '${packId}';
       DELETE FROM duplicate_analysis_items WHERE pack_id = '${packId}';
       DELETE FROM duplicate_analysis_manifests WHERE pack_id = '${packId}';`,
    );
    await expect(
      repository.findDuplicateAnalysis(packId),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });

    await repository.restoreDuplicateDecision(
      packId,
      secondItemId,
      '2026-08-05T00:00:07Z',
    );
    expect(
      (await repository.findPackGraph(packId))?.items.find(
        item => item.id === secondItemId,
      )?.inclusionMode,
    ).toBe('both');
    await expect(repository.findDuplicateAnalysis(packId)).resolves.toEqual({
      manifest: null,
      analyses: [],
      suggestions: [],
      decisions: [],
    });
  });

  test('preserves a same-timestamp ambiguous source-less exclusion after restart', async () => {
    await repository.commitImport({
      packId,
      manifest: {
        schemaVersion: 1,
        ingestionId: thirdIngestionId,
        createdAt: '2026-08-05T00:00:01Z',
        source: 'main-app-picker',
        status: 'complete',
        items: [
          {
            id: thirdItemId,
            order: 0,
            mediaType: 'text/plain',
            status: 'copied',
            byteCount: 12,
            relativePath: `${thirdItemId}.bin`,
            sha256: '3'.repeat(64),
          },
        ],
      },
      manifestFingerprint: '3'.repeat(64),
      artifacts: [
        {
          id: thirdItemId,
          itemId: thirdItemId,
          relativePath: `Packs/${packId}/originals/${thirdItemId}.bin`,
          mediaType: 'text/plain',
          byteCount: 12,
          sha256: '3'.repeat(64),
        },
      ],
    });
    const normalized = normalizeContentV1(
      'Synthetic repeated context long enough for deterministic duplicate analysis.',
    );
    await expect(
      repository.acquireCleanupLease(
        exportId,
        '2026-08-05T00:00:01Z',
        '2026-08-05T00:01:01Z',
      ),
    ).resolves.toBe(true);
    const artifactInputs = [
      { id: derivedId, itemId: firstItemId, sha256: 'd'.repeat(64) },
      { id: secondDerivedId, itemId: secondItemId, sha256: 'e'.repeat(64) },
      { id: thirdDerivedId, itemId: thirdItemId, sha256: 'f'.repeat(64) },
    ] as const;
    for (const artifact of artifactInputs)
      await repository.registerPublishedArtifact({
        packId,
        publicationLeaseOwnerId: exportId,
        artifact: {
          id: artifact.id,
          itemId: artifact.itemId,
          kind: 'normalized-text',
          relativePath: ownedDerivedPath(packId, artifact.id, 'txt'),
          mediaType: 'text/plain',
          byteCount: normalized.utf8ByteCount,
          sha256: artifact.sha256,
          processorVersion: {
            processor: 'shared-content-normalization',
            version: 'text-normalization-v1',
            contractVersion: 1,
          },
          createdAt: '2026-08-05T00:00:02Z',
          immutable: true,
        },
      });
    await repository.releaseCleanupLease(exportId);
    const fingerprintSets = [
      [...Array.from({ length: 46 }, (_, value) => value), 50, 51, 52, 53],
      Array.from({ length: 50 }, (_, value) => value),
      [...Array.from({ length: 46 }, (_, value) => value + 4), 54, 55, 56, 57],
    ] as const;
    const analyses: readonly DuplicateAnalysisItemV1[] = artifactInputs.map(
      (artifact, index) => ({
        schemaVersion: 1,
        packId,
        itemId: artifact.itemId,
        originalSha256: ['a', 'b', '3'][index]!.repeat(64),
        originalByteCount: [4, 8, 12][index]!,
        normalizedArtifactId: artifact.id,
        normalizedSha256: artifact.sha256,
        normalizedByteCount: normalized.utf8ByteCount,
        normalizedCharacterCount: normalized.characterCount,
        contentKind: normalized.contentKind,
        textFingerprint: {
          schemaVersion: 1,
          algorithm: 'bottom-k-fnv1a32-5gram-v1',
          shingleSize: 5,
          sampleSize: 128,
          similarityCharacterCount: normalized.characterCount,
          shingleCount: normalized.characterCount - 4,
          hashes: fingerprintSets[index]!.map(value =>
            value.toString(16).padStart(8, '0'),
          ),
        },
        ...(index === 0
          ? {
              imageFingerprint: {
                schemaVersion: 1 as const,
                algorithm: 'dhash-64-v1' as const,
                hash: '0123456789abcdef',
                sampleWidth: 9 as const,
                sampleHeight: 8 as const,
                orientationApplied: true as const,
                durationMs: 0,
                revision: '1' as const,
              },
            }
          : {}),
        analyzedAt: `2026-08-05T00:00:0${index + 2}Z`,
      }),
    );
    const chainSuggestions = buildDuplicateSuggestionsV1(analyses);
    expect(
      chainSuggestions.map(suggestion => [
        suggestion.leftItemId,
        suggestion.rightItemId,
      ]),
    ).toEqual([
      [firstItemId, secondItemId],
      [secondItemId, thirdItemId],
    ]);
    await repository.replaceDuplicateAnalysis({
      manifest: {
        schemaVersion: 1,
        packId,
        config: DUPLICATE_DETECTOR_CONFIG_V1,
        analyzedAt: '2026-08-05T00:00:04Z',
        itemCount: 3,
        suggestionCount: chainSuggestions.length,
      },
      analyses,
      suggestions: chainSuggestions,
    });
    const baseline = 'both' as const;
    const legacy = [
      {
        schemaVersion: 1 as const,
        packId,
        itemId: firstItemId,
        choice: 'preferred' as const,
        baselineInclusionMode: baseline,
        decidedAt: '2026-08-05T00:00:06Z',
      },
      {
        schemaVersion: 1 as const,
        packId,
        itemId: secondItemId,
        choice: 'exclude' as const,
        baselineInclusionMode: baseline,
        decidedAt: '2026-08-05T00:00:06Z',
      },
      {
        schemaVersion: 1 as const,
        packId,
        itemId: thirdItemId,
        choice: 'exclude' as const,
        baselineInclusionMode: baseline,
        decidedAt: '2026-08-05T00:00:06Z',
      },
    ];
    for (const decision of legacy)
      database
        .prepare(
          `INSERT INTO duplicate_decisions
             (item_id, pack_id, payload_json, decided_at) VALUES (?, ?, ?, ?)`,
        )
        .run(
          decision.itemId,
          packId,
          JSON.stringify(decision),
          decision.decidedAt,
        );
    database.exec(
      `UPDATE context_items SET inclusion_mode = 'excluded'
       WHERE id IN ('${secondItemId}', '${thirdItemId}')`,
    );
    database.close();
    database = new DatabaseSync(databasePath);
    repository = new ExpoSqlitePersistenceRepository(
      new NodeSqlConnection(database) as never,
    );
    await repository.initialize();

    const controller = new PackLibraryController(
      async () => repository,
      () => '2026-08-05T00:00:07Z',
    );
    await controller.reviewDuplicateGroup(
      packId,
      [firstItemId, secondItemId, thirdItemId],
      { kind: 'preferred', itemId: firstItemId },
    );

    expect(
      (await repository.findPackGraph(packId))?.items.map(item => ({
        id: item.id,
        inclusionMode: item.inclusionMode,
      })),
    ).toEqual([
      { id: firstItemId, inclusionMode: 'both' },
      { id: secondItemId, inclusionMode: 'excluded' },
      { id: thirdItemId, inclusionMode: 'excluded' },
    ]);
    expect(await repository.findDuplicateAnalysis(packId)).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({
          itemId: thirdItemId,
          choice: 'exclude',
          decidedAt: '2026-08-05T00:00:06Z',
        }),
      ]),
    });
  });

  test('marks only quarantine records covered by the native mtime cutoff', async () => {
    await repository.recordQuarantine(
      {
        id: oldQuarantineId,
        anonymousId: firstItemId,
        reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
        byteCount: 4,
        createdAt: '2026-08-01T00:00:00Z',
        purgeAfter: '2026-08-08T00:00:00Z',
      },
      await acquireCleanupMutationLease(),
    );
    await repository.recordQuarantine(
      {
        id: recentQuarantineId,
        anonymousId: secondItemId,
        reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
        byteCount: 8,
        createdAt: '2026-08-05T00:00:00Z',
        purgeAfter: '2026-08-12T00:00:00Z',
      },
      await acquireCleanupMutationLease(),
    );

    await expect(
      repository.markQuarantinePurgedBefore(
        '2026-08-03T00:00:00Z',
        '2026-08-10T00:00:00Z',
        await acquireCleanupMutationLease(),
      ),
    ).resolves.toBe(1);
    await expect(repository.getStorageUsage()).resolves.toMatchObject({
      quarantineCount: 1,
      quarantineBytes: 8,
    });
  });
});
