jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import type { ImportManifestV1 } from '../src/domain/contracts';
import type { Artifact } from '../src/domain/models';
import type { CommitImportInput } from '../src/infrastructure/persistence/contracts';
import { DEVELOPMENT_RESET_CONFIRMATION } from '../src/infrastructure/persistence/contracts';
import { IMPORT_MANIFEST_MAX_ITEMS } from '../src/domain/validation';
import { ExpoSqlitePersistenceRepository } from '../src/infrastructure/persistence/sqlite';
import { ownedDerivedPath } from '../src/infrastructure/persistence/ownedPaths';

type SqlValue = string | number | null;

interface FakeConnection {
  exec(source: string): Promise<void>;
  run(source: string, params?: readonly SqlValue[]): Promise<void>;
  first<T>(source: string, params?: readonly SqlValue[]): Promise<T | null>;
  all<T>(source: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  exclusive(
    task: (transaction: FakeConnection) => Promise<void>,
  ): Promise<void>;
}

const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
const packId = '223e4567-e89b-42d3-a456-426614174000';
const itemId = '323e4567-e89b-42d3-a456-426614174000';

function replayInput(sha256: string): CommitImportInput {
  const manifest: ImportManifestV1 = {
    schemaVersion: 1,
    ingestionId,
    createdAt: '2026-08-03T00:00:00Z',
    source: 'android-share-intent',
    status: 'complete',
    items: [
      {
        id: itemId,
        order: 0,
        mediaType: 'image/png',
        status: 'copied',
        byteCount: 8,
        relativePath: `${itemId}.bin`,
      },
    ],
  };
  return {
    packId,
    manifest,
    manifestFingerprint: 'a'.repeat(64),
    artifacts: [
      {
        id: itemId,
        itemId,
        relativePath: `Packs/${packId}/originals/${itemId}.bin`,
        mediaType: 'image/png',
        byteCount: 8,
        sha256,
      },
    ],
  };
}

function existingImportConnection(persistedSha256: string): {
  readonly connection: FakeConnection;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const connection: FakeConnection = {
    exec: async () => undefined,
    run: async source => {
      statements.push(source);
    },
    first: async <T>(source: string) => {
      if (source.includes('SELECT pack_id, manifest_fingerprint'))
        return {
          pack_id: packId,
          manifest_fingerprint: 'a'.repeat(64),
          manifest_version: 1,
          source: 'android-share-intent',
          status: 'complete',
          created_at: '2026-08-03T00:00:00Z',
        } as T;
      if (source.includes('SELECT COUNT(*) AS count FROM context_items'))
        return { count: 1 } as T;
      return null;
    },
    all: async <T>(source: string) => {
      if (source.includes('FROM artifacts a'))
        return [
          {
            id: itemId,
            item_id: itemId,
            relative_path: `Packs/${packId}/originals/${itemId}.bin`,
            media_type: 'image/png',
            byte_count: 8,
            sha256: persistedSha256,
          } as T,
        ];
      if (source.includes('FROM import_items imported_item'))
        return [
          {
            id: itemId,
            import_order: 0,
            import_status: 'copied',
            import_error_code: null,
            pack_id: packId,
            source_type: 'image',
            media_type: 'image/png',
            original_sha256: persistedSha256,
            original_relative_path: `Packs/${packId}/originals/${itemId}.bin`,
            retry_stage: null,
          } as T,
        ];
      return [];
    },
    exclusive: async task => task(connection),
  };
  return { connection, statements };
}

describe('ExpoSqlitePersistenceRepository replay identity', () => {
  test('applies the production migration through observable hooks', async () => {
    const executed: string[] = [];
    const events: string[] = [];
    const connection = {
      exec: async (source: string) => {
        executed.push(source);
      },
      run: async () => ({ changes: 1 }),
      first: async <T>(source: string) =>
        source === 'PRAGMA user_version' ? ({ user_version: 2 } as T) : null,
      all: async <T>() => [] as T[],
      exclusive: async <T>(task: (transaction: unknown) => Promise<T>) =>
        task(connection),
    };
    const repository = new ExpoSqlitePersistenceRepository(
      connection as never,
      event => {
        events.push(`${event.fromVersion}->${event.toVersion}:${event.phase}`);
      },
    );

    await expect(repository.initialize()).resolves.toBe(undefined);

    expect(events).toEqual([
      '2->3:starting',
      '2->3:applied',
      '3->4:starting',
      '3->4:applied',
      '4->5:starting',
      '4->5:applied',
      '5->6:starting',
      '5->6:applied',
    ]);
    expect(executed[0]).toContain('PRAGMA foreign_keys = ON');
    expect(executed[1]).toContain('PRAGMA user_version = 3');
    expect(executed[2]).toContain('PRAGMA user_version = 4');
    expect(executed[3]).toContain('PRAGMA user_version = 5');
    expect(executed[4]).toContain('PRAGMA user_version = 6');
  });

  test('rejects a different artifact hash before deleting the recovery journal', async () => {
    const { connection, statements } = existingImportConnection('b'.repeat(64));
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    await expect(
      repository.commitImport(replayInput('c'.repeat(64))),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
    expect(statements).toEqual([]);
  });

  test('accepts the exact persisted artifact set and clears the journal', async () => {
    const { connection, statements } = existingImportConnection('b'.repeat(64));
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    await expect(
      repository.commitImport(replayInput('b'.repeat(64))),
    ).resolves.toBe('replayed');
    expect(statements).toEqual([
      'DELETE FROM recovery_journal WHERE ingestion_id = ?',
    ]);
  });

  test.each([
    ['retry byte count', 9, 'b'.repeat(64)],
    ['retry sha256', 8, 'c'.repeat(64)],
  ] as const)(
    'rejects failed-item artifact metadata that diverges from %s',
    async (_label, retryByteCount, retrySha256) => {
      const { connection, statements } = existingImportConnection(
        'b'.repeat(64),
      );
      const original = replayInput('b'.repeat(64));
      const input: CommitImportInput = {
        ...original,
        manifest: {
          ...original.manifest,
          status: 'failed',
          items: [
            {
              id: itemId,
              order: 0,
              mediaType: 'image/png',
              status: 'failed',
              byteCount: 0,
              errorCode: 'IMPORT_PROVIDER_PERMISSION_EXPIRED',
              retryByteCount,
              retrySha256,
            },
          ],
        },
      };
      const repository = new ExpoSqlitePersistenceRepository(
        connection as never,
      );

      await expect(repository.commitImport(input)).rejects.toMatchObject({
        code: 'ARTIFACT_INTEGRITY_FAILED',
      });
      expect(statements).toEqual([]);
    },
  );

  test('rejects a replay when its materialized context item is missing', async () => {
    const { connection, statements } = existingImportConnection('b'.repeat(64));
    const loadAll = connection.all;
    connection.all = async <T>(source: string) => {
      if (source.includes('FROM import_items imported_item')) return [];
      return loadAll<T>(source);
    };
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    await expect(
      repository.commitImport(replayInput('b'.repeat(64))),
    ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });
    expect(statements).toEqual([]);
  });

  test('rejects replay when persisted import metadata diverges from its fingerprint-bound manifest', async () => {
    const { connection, statements } = existingImportConnection('b'.repeat(64));
    const loadFirst = connection.first;
    connection.first = async <T>(
      source: string,
      params?: readonly SqlValue[],
    ) => {
      const value = await loadFirst<T>(source, params);
      if (source.includes('SELECT pack_id, manifest_fingerprint') && value)
        return { ...value, status: 'partial' } as T;
      return value;
    };
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    await expect(
      repository.commitImport(replayInput('b'.repeat(64))),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
    expect(statements).toEqual([]);
  });

  test('rehydrates durable partial-item failures for Inbox visibility', async () => {
    const failedItemId = '423e4567-e89b-42d3-a456-426614174000';
    let swapRetryOwner = false;
    let retryOriginalReleased = false;
    const connection = {
      exec: async () => undefined,
      run: async () => ({ changes: 0 }),
      first: async <T>() => null as T | null,
      all: async <T>(source: string) =>
        (source.includes('FROM imports ORDER BY')
          ? [
              {
                ingestion_id: ingestionId,
                pack_id: packId,
                manifest_fingerprint: 'a'.repeat(64),
                status: 'partial',
                created_at: '2026-08-03T00:00:00Z',
              },
            ]
          : source.includes('FROM import_items item')
          ? [
              {
                id: itemId,
                sort_index: 0,
                media_type: 'image/png',
                status: 'copied',
                error_code: null,
                original_disposition: 'retained',
                artifact_count: 1,
                artifact_relative_path: `Packs/${packId}/originals/${itemId}.bin`,
                artifact_byte_count: 4,
                artifact_sha256: 'b'.repeat(64),
              },
              {
                id: failedItemId,
                sort_index: 1,
                media_type: 'application/zip',
                status: 'failed',
                error_code: 'IMPORT_TYPE_UNSUPPORTED',
                original_disposition: retryOriginalReleased
                  ? 'released'
                  : 'retained',
                artifact_count: 1,
                artifact_relative_path: swapRetryOwner
                  ? `Packs/${packId}/originals/${itemId}.bin`
                  : `Packs/${packId}/originals/${failedItemId}.bin`,
                artifact_byte_count: 7,
                artifact_sha256: 'c'.repeat(64),
              },
            ]
          : []) as T[],
      exclusive: async <T>(task: (transaction: unknown) => Promise<T>) =>
        task(connection),
    };
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    await expect(repository.listImportDetails()).resolves.toEqual([
      {
        ingestionId,
        packId,
        manifestFingerprint: 'a'.repeat(64),
        status: 'partial',
        itemCount: 2,
        artifactCount: 2,
        createdAt: '2026-08-03T00:00:00Z',
        items: [
          {
            id: itemId,
            order: 0,
            mediaType: 'image/png',
            status: 'copied',
          },
          {
            id: failedItemId,
            order: 1,
            mediaType: 'application/zip',
            status: 'failed',
            errorCode: 'IMPORT_TYPE_UNSUPPORTED',
            retrySource: {
              relativePath: `Packs/${packId}/originals/${failedItemId}.bin`,
              byteCount: 7,
              sha256: 'c'.repeat(64),
            },
          },
        ],
      },
    ]);

    retryOriginalReleased = true;
    await expect(repository.listImportDetails()).resolves.toEqual([
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: failedItemId,
            status: 'failed',
            originalReleased: true,
          }),
        ]),
      }),
    ]);
    expect(
      (await repository.listImportDetails())[0]?.items[1],
    ).not.toHaveProperty('retrySource');

    retryOriginalReleased = false;
    swapRetryOwner = true;
    await expect(repository.listImportDetails()).rejects.toMatchObject({
      code: 'STORAGE_DIVERGENCE_DETECTED',
    });
  });

  test('rehydrates the contract maximum of 128 reported share items', async () => {
    const items = Array.from(
      { length: IMPORT_MANIFEST_MAX_ITEMS },
      (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        sort_index: index,
        media_type: 'application/octet-stream',
        status: 'failed',
        error_code: 'IMPORT_TYPE_UNSUPPORTED',
        original_disposition: 'unavailable',
        artifact_count: 0,
        artifact_relative_path: null,
        artifact_byte_count: null,
        artifact_sha256: null,
      }),
    );
    const connection = {
      exec: async () => undefined,
      run: async () => ({ changes: 0 }),
      first: async <T>() => null as T | null,
      all: async <T>(source: string) =>
        (source.includes('FROM imports ORDER BY')
          ? [
              {
                ingestion_id: ingestionId,
                pack_id: packId,
                manifest_fingerprint: 'a'.repeat(64),
                status: 'failed',
                created_at: '2026-08-03T00:00:00Z',
              },
            ]
          : source.includes('FROM import_items item')
          ? items
          : []) as T[],
      exclusive: async <T>(task: (transaction: unknown) => Promise<T>) =>
        task(connection),
    };
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    const details = await repository.listImportDetails();

    expect(details).toHaveLength(1);
    expect(details[0]?.itemCount).toBe(IMPORT_MANIFEST_MAX_ITEMS);
    expect(details[0]?.items).toHaveLength(IMPORT_MANIFEST_MAX_ITEMS);
  });

  test('registers an exact verified derivative and rejects immutable replacement', async () => {
    const artifactId = '423e4567-e89b-42d3-a456-426614174000';
    const publicationOwnerId = '523e4567-e89b-42d3-a456-426614174000';
    const value: Artifact = {
      id: artifactId,
      itemId,
      kind: 'ocr-text',
      relativePath: ownedDerivedPath(packId, artifactId, 'txt'),
      mediaType: 'text/plain',
      byteCount: 3,
      sha256: 'd'.repeat(64),
      processorVersion: {
        processor: 'fixture-ocr',
        version: '1',
        contractVersion: 1,
      },
      createdAt: '2026-08-05T00:00:00Z',
      immutable: true,
    };
    const statements: { source: string; params: readonly SqlValue[] }[] = [];
    let existing: Record<string, unknown> | null = null;
    const connection = {
      exec: async () => undefined,
      run: async (source: string, params: readonly SqlValue[] = []) => {
        statements.push({ source, params });
        return { changes: 1 };
      },
      first: async <T>(source: string) => {
        if (source.includes('FROM cleanup_leases'))
          return {
            owner_id: publicationOwnerId,
            expires_at: '2026-08-05T00:01:00Z',
          } as T;
        if (source.includes('FROM packs')) return { id: packId } as T;
        if (source.includes('FROM context_items')) return { id: itemId } as T;
        if (source.includes('FROM artifacts WHERE id')) return existing as T;
        return null;
      },
      all: async <T>() => [] as T[],
      exclusive: async <T>(task: (transaction: unknown) => Promise<T>) =>
        task(connection),
    };
    const repository = new ExpoSqlitePersistenceRepository(connection as never);

    await expect(
      repository.registerPublishedArtifact({
        packId,
        artifact: value,
      } as never),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    await expect(
      repository.registerPublishedArtifact({
        packId,
        artifact: value,
        publicationLeaseOwnerId: publicationOwnerId,
        publicationLeaseObservedAt: value.createdAt,
      }),
    ).resolves.toBe('created');
    expect(statements[0]?.params).toEqual([
      artifactId,
      itemId,
      value.relativePath,
      'text/plain',
      3,
      'd'.repeat(64),
      '2026-08-05T00:00:00Z',
      '2026-08-05T00:00:00Z',
      'ocr-text',
      JSON.stringify(value.processorVersion),
    ]);

    statements.length = 0;
    existing = {
      id: value.id,
      item_id: value.itemId,
      relative_path: value.relativePath,
      media_type: value.mediaType,
      byte_count: value.byteCount,
      sha256: 'e'.repeat(64),
      kind: value.kind,
      processor_version_json: JSON.stringify(value.processorVersion),
      created_at: value.createdAt,
      last_verified_at: value.createdAt,
    };
    await expect(
      repository.registerPublishedArtifact({
        packId,
        artifact: value,
        publicationLeaseOwnerId: publicationOwnerId,
        publicationLeaseObservedAt: value.createdAt,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ARTIFACT_IMMUTABLE' });
    expect(statements).toEqual([]);
  });

  test('stores diagnostics with metadata-only parameter binding and forbids production reset', async () => {
    const calls: { source: string; params: readonly SqlValue[] }[] = [];
    const connection = {
      exec: async () => undefined,
      run: async (source: string, params: readonly SqlValue[] = []) => {
        calls.push({ source, params });
        return { changes: 1 };
      },
      first: async <T>() => null as T | null,
      all: async <T>() => [] as T[],
      exclusive: async <T>(task: (transaction: unknown) => Promise<T>) =>
        task(connection),
    };
    const repository = new ExpoSqlitePersistenceRepository(
      connection as never,
      undefined,
      false,
    );

    await repository.recordRecoveryDiagnostic({
      id: ingestionId,
      scope: 'inbox',
      anonymousId: ingestionId,
      code: 'RESOURCE_LOW_DISK',
      phase: 'handoff-started',
      occurredAt: '2026-08-05T00:00:00Z',
      byteCount: 3,
    });
    expect(calls[0]?.params).toEqual([
      ingestionId,
      'inbox',
      ingestionId,
      'RESOURCE_LOW_DISK',
      'handoff-started',
      '2026-08-05T00:00:00Z',
      '2026-08-05T00:00:00Z',
      3,
    ]);
    expect(JSON.stringify(calls[0]?.params)).not.toContain('file://');
    await expect(
      repository.resetForDevelopment(DEVELOPMENT_RESET_CONFIRMATION),
    ).rejects.toMatchObject({ code: 'DEVELOPMENT_RESET_FORBIDDEN' });
  });
});
