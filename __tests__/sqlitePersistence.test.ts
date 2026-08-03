jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import type { ImportManifestV1 } from '../src/domain/contracts';
import type { CommitImportInput } from '../src/infrastructure/persistence/contracts';
import { ExpoSqlitePersistenceRepository } from '../src/infrastructure/persistence/sqlite';

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
        } as T;
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
      return [];
    },
    exclusive: async task => task(connection),
  };
  return { connection, statements };
}

describe('ExpoSqlitePersistenceRepository replay identity', () => {
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
});
