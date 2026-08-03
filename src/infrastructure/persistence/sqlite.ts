import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { DomainError } from '../../domain/errors';
import { isCanonicalUuid } from '../../domain/canonicalUuid';
import { isImportManifestV1 } from '../../domain/validation';
import type {
  CleanupCandidate,
  CommitImportInput,
  PersistedImportSummary,
  PersistenceRepository,
  RecoveryJournalEntry,
} from './contracts';
import { PERSISTENCE_SCHEMA_VERSION } from './contracts';
import { PERSISTENCE_MIGRATIONS } from './migrations';
import { assertOwnedArtifactPath, ownedOriginalPath } from './ownedPaths';
import {
  artifactIdentitySetsEqual,
  type ArtifactIdentity,
} from './artifactIdentity';

type SqlValue = string | number | null;

interface SqlConnection {
  exec(source: string): Promise<void>;
  run(source: string, params?: readonly SqlValue[]): Promise<void>;
  first<T>(source: string, params?: readonly SqlValue[]): Promise<T | null>;
  all<T>(source: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  exclusive(task: (transaction: SqlConnection) => Promise<void>): Promise<void>;
}

class ExpoSqlConnection implements SqlConnection {
  constructor(private readonly database: SQLiteDatabase) {}

  exec(source: string): Promise<void> {
    return this.database.execAsync(source);
  }

  async run(source: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.database.runAsync(source, [...params]);
  }

  first<T>(
    source: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    return this.database.getFirstAsync<T>(source, [...params]);
  }

  all<T>(source: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.database.getAllAsync<T>(source, [...params]);
  }

  exclusive(
    task: (transaction: SqlConnection) => Promise<void>,
  ): Promise<void> {
    return this.database.withExclusiveTransactionAsync(async transaction => {
      await task(new ExpoSqlConnection(transaction));
    });
  }
}

const repositoryInstances = new Map<
  string,
  Promise<ExpoSqlitePersistenceRepository>
>();

export function openPersistenceRepository(
  databaseName = 'ai-context-pack.db',
): Promise<ExpoSqlitePersistenceRepository> {
  const existing = repositoryInstances.get(databaseName);
  if (existing) return existing;
  const opening = (async () => {
    const database = await openDatabaseAsync(databaseName);
    const repository = new ExpoSqlitePersistenceRepository(
      new ExpoSqlConnection(database),
    );
    await repository.initialize();
    return repository;
  })();
  repositoryInstances.set(databaseName, opening);
  opening.catch(() => repositoryInstances.delete(databaseName));
  return opening;
}

export class ExpoSqlitePersistenceRepository implements PersistenceRepository {
  constructor(private readonly connection: SqlConnection) {}

  async initialize(): Promise<void> {
    await this.connection.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;',
    );
    const row = await this.connection.first<{ user_version: number }>(
      'PRAGMA user_version',
    );
    let version = row?.user_version ?? 0;
    if (version > PERSISTENCE_SCHEMA_VERSION)
      throw new DomainError('SCHEMA_VERSION_UNSUPPORTED');
    while (version < PERSISTENCE_SCHEMA_VERSION) {
      const migration = PERSISTENCE_MIGRATIONS[version];
      if (!migration) throw new DomainError('SCHEMA_VERSION_UNSUPPORTED');
      await this.connection.exclusive(transaction =>
        transaction.exec(migration),
      );
      version += 1;
    }
  }

  async findImport(
    ingestionId: string,
  ): Promise<PersistedImportSummary | null> {
    const row = await this.connection.first<{
      ingestion_id: string;
      pack_id: string;
      manifest_fingerprint: string;
      status: PersistedImportSummary['status'];
      item_count: number;
      artifact_count: number;
    }>(
      `SELECT i.ingestion_id, i.pack_id, i.manifest_fingerprint, i.status,
        (SELECT COUNT(*) FROM import_items x WHERE x.ingestion_id = i.ingestion_id) AS item_count,
        (SELECT COUNT(*) FROM artifacts a JOIN import_items x ON x.id = a.item_id WHERE x.ingestion_id = i.ingestion_id) AS artifact_count
       FROM imports i WHERE i.ingestion_id = ?`,
      [ingestionId],
    );
    return row
      ? {
          ingestionId: row.ingestion_id,
          packId: row.pack_id,
          manifestFingerprint: row.manifest_fingerprint,
          status: row.status,
          itemCount: row.item_count,
          artifactCount: row.artifact_count,
        }
      : null;
  }

  async commitImport(
    input: CommitImportInput,
  ): Promise<'created' | 'replayed'> {
    if (
      !isCanonicalUuid(input.packId) ||
      !isImportManifestV1(input.manifest) ||
      !/^[0-9a-f]{64}$/.test(input.manifestFingerprint)
    )
      throw new DomainError('SCHEMA_INVALID');
    const copiedItems = new Set(
      input.manifest.items
        .filter(item => item.status === 'copied')
        .map(item => item.id),
    );
    const copiedItemsById = new Map(
      input.manifest.items
        .filter(item => item.status === 'copied')
        .map(item => [item.id, item] as const),
    );
    const artifactIds = new Set(input.artifacts.map(artifact => artifact.id));
    if (
      input.artifacts.length !== copiedItems.size ||
      artifactIds.size !== input.artifacts.length ||
      input.artifacts.some(artifact => {
        const item = copiedItemsById.get(artifact.itemId);
        return (
          !isCanonicalUuid(artifact.id) ||
          artifact.id !== artifact.itemId ||
          !item ||
          artifact.relativePath !==
            ownedOriginalPath(input.packId, artifact.itemId) ||
          artifact.mediaType !== item.mediaType ||
          !Number.isSafeInteger(artifact.byteCount) ||
          artifact.byteCount < 0 ||
          artifact.byteCount !== item.byteCount ||
          !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
          (item.sha256 !== undefined && item.sha256 !== artifact.sha256)
        );
      })
    )
      throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
    input.artifacts.forEach(artifact =>
      assertOwnedArtifactPath(artifact.relativePath),
    );
    let outcome: 'created' | 'replayed' = 'created';
    await this.connection.exclusive(async transaction => {
      const existing = await transaction.first<{
        pack_id: string;
        manifest_fingerprint: string;
      }>(
        'SELECT pack_id, manifest_fingerprint FROM imports WHERE ingestion_id = ?',
        [input.manifest.ingestionId],
      );
      if (existing) {
        if (
          existing.pack_id !== input.packId ||
          existing.manifest_fingerprint !== input.manifestFingerprint
        )
          throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
        const persistedRows = await transaction.all<{
          id: string;
          item_id: string;
          relative_path: string;
          media_type: string;
          byte_count: number;
          sha256: string;
        }>(
          `SELECT a.id, a.item_id, a.relative_path, a.media_type, a.byte_count, a.sha256
           FROM artifacts a
           JOIN import_items item ON item.id = a.item_id
           WHERE item.ingestion_id = ?`,
          [input.manifest.ingestionId],
        );
        const persistedArtifacts: ArtifactIdentity[] = persistedRows.map(
          row => ({
            id: row.id,
            itemId: row.item_id,
            relativePath: row.relative_path,
            mediaType: row.media_type,
            byteCount: row.byte_count,
            sha256: row.sha256,
          }),
        );
        if (!artifactIdentitySetsEqual(persistedArtifacts, input.artifacts))
          throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
        await transaction.run(
          'DELETE FROM recovery_journal WHERE ingestion_id = ?',
          [input.manifest.ingestionId],
        );
        outcome = 'replayed';
        return;
      }
      await transaction.run(
        'INSERT OR IGNORE INTO packs (id, created_at) VALUES (?, ?)',
        [input.packId, input.manifest.createdAt],
      );
      await transaction.run(
        `INSERT INTO imports
          (ingestion_id, pack_id, manifest_fingerprint, manifest_version, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.manifest.ingestionId,
          input.packId,
          input.manifestFingerprint,
          input.manifest.schemaVersion,
          input.manifest.source,
          input.manifest.status,
          input.manifest.createdAt,
        ],
      );
      for (const item of input.manifest.items) {
        await transaction.run(
          `INSERT INTO import_items
            (id, ingestion_id, sort_index, media_type, status, error_code)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            input.manifest.ingestionId,
            item.order,
            item.mediaType,
            item.status,
            item.status === 'failed' ? item.errorCode : null,
          ],
        );
      }
      for (const artifact of input.artifacts) {
        await transaction.run(
          `INSERT INTO artifacts
            (id, item_id, relative_path, media_type, byte_count, sha256, created_at, last_verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            artifact.id,
            artifact.itemId,
            artifact.relativePath,
            artifact.mediaType,
            artifact.byteCount,
            artifact.sha256,
            input.manifest.createdAt,
            input.manifest.createdAt,
          ],
        );
        await transaction.run(
          `INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
           VALUES ('pack', ?, ?)`,
          [input.packId, artifact.id],
        );
      }
      await transaction.run(
        'DELETE FROM recovery_journal WHERE ingestion_id = ?',
        [input.manifest.ingestionId],
      );
    });
    return outcome;
  }

  recordRecovery(entry: RecoveryJournalEntry): Promise<void> {
    return this.connection.run(
      `INSERT INTO recovery_journal (ingestion_id, pack_id, phase, updated_at, error_code)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ingestion_id) DO UPDATE SET
         pack_id = excluded.pack_id,
         phase = excluded.phase,
         updated_at = excluded.updated_at,
         error_code = excluded.error_code`,
      [
        entry.ingestionId,
        entry.packId,
        entry.phase,
        entry.updatedAt,
        entry.errorCode ?? null,
      ],
    );
  }

  async findRecovery(
    ingestionId: string,
  ): Promise<RecoveryJournalEntry | null> {
    const row = await this.connection.first<{
      ingestion_id: string;
      pack_id: string;
      phase: RecoveryJournalEntry['phase'];
      updated_at: string;
      error_code: RecoveryJournalEntry['errorCode'] | null;
    }>(
      'SELECT ingestion_id, pack_id, phase, updated_at, error_code FROM recovery_journal WHERE ingestion_id = ?',
      [ingestionId],
    );
    if (!row) return null;
    return {
      ingestionId: row.ingestion_id,
      packId: row.pack_id,
      phase: row.phase,
      updatedAt: row.updated_at,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    };
  }

  async listReferencedRelativePaths(): Promise<ReadonlySet<string>> {
    const rows = await this.connection.all<{ relative_path: string }>(
      `SELECT DISTINCT a.relative_path FROM artifacts a
       JOIN artifact_references r ON r.artifact_id = a.id`,
    );
    return new Set(rows.map(row => row.relative_path));
  }

  async listKnownRelativePaths(): Promise<ReadonlySet<string>> {
    const rows = await this.connection.all<{ relative_path: string }>(
      'SELECT relative_path FROM artifacts',
    );
    return new Set(rows.map(row => row.relative_path));
  }

  async listRecoveringPackIds(): Promise<ReadonlySet<string>> {
    const rows = await this.connection.all<{ pack_id: string }>(
      "SELECT DISTINCT pack_id FROM recovery_journal WHERE phase <> 'quarantined'",
    );
    return new Set(rows.map(row => row.pack_id));
  }

  listCleanupCandidates(
    olderThan: string,
  ): Promise<readonly CleanupCandidate[]> {
    return this.connection.all<CleanupCandidate>(
      `SELECT a.id AS artifactId, a.relative_path AS relativePath, a.created_at AS createdAt
       FROM artifacts a
       LEFT JOIN artifact_references r ON r.artifact_id = a.id
       WHERE r.artifact_id IS NULL AND a.created_at < ?`,
      [olderThan],
    );
  }

  async deleteArtifactRecordIfUnreferenced(
    artifactId: string,
  ): Promise<boolean> {
    let deleted = false;
    await this.connection.exclusive(async transaction => {
      const reference = await transaction.first<{ found: number }>(
        'SELECT 1 AS found FROM artifact_references WHERE artifact_id = ? LIMIT 1',
        [artifactId],
      );
      if (reference) return;
      await transaction.run('DELETE FROM artifacts WHERE id = ?', [artifactId]);
      deleted = true;
    });
    return deleted;
  }
}
