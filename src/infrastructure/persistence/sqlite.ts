import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { isCanonicalUuid } from '../../domain/canonicalUuid';
import type { ImportManifestV1 } from '../../domain/contracts';
import {
  DomainError,
  isDomainErrorCode,
  type DomainErrorCode,
} from '../../domain/errors';
import type {
  Artifact,
  ContextItem,
  ContextPack,
  ExportRecord,
  RiskFinding,
} from '../../domain/models';
import { isImportManifestV1 } from '../../domain/validation';
import {
  DEVELOPMENT_RESET_CONFIRMATION,
  PERSISTENCE_SCHEMA_VERSION,
  type CleanupCandidate,
  type CommitImportInput,
  type DeletePackResult,
  type PersistedArtifactRecord,
  type PersistedImportDetail,
  type PersistedImportSummary,
  type PersistedPackGraph,
  type PersistenceMigrationHook,
  type ProductionPersistenceRepository,
  type RecoveryDiagnostic,
  type RecoveryDiagnosticInput,
  type RecoveryJournalEntry,
  type RegisterPublishedArtifactInput,
  type SavePackGraphInput,
  type QuarantineRecordInput,
  type StorageUsageSummary,
} from './contracts';
import {
  artifactIdentitySetsEqual,
  type ArtifactIdentity,
} from './artifactIdentity';
import { PERSISTENCE_MIGRATIONS } from './migrations';
import {
  assertContextItem,
  assertContextPack,
  assertArtifact,
  assertExportRecord,
  assertPackGraph,
  assertRiskFinding,
  decodeBudget,
  decodeFindingLocation,
  decodeProcessorVersion,
  decodeStringArray,
  encodeBudget,
  encodeFindingLocation,
  encodeProcessorVersion,
  encodeStringArray,
  isIsoDateTime,
} from './modelCodec';
import {
  assertOwnedArtifactPath,
  ownedArtifactId,
  ownedArtifactPackId,
  ownedOriginalPath,
} from './ownedPaths';

type SqlValue = string | number | null;

interface SqlRunResult {
  readonly changes: number;
}

interface SqlConnection {
  exec(source: string): Promise<void>;
  run(source: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  first<T>(source: string, params?: readonly SqlValue[]): Promise<T | null>;
  all<T>(source: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  exclusive<T>(task: (transaction: SqlConnection) => Promise<T>): Promise<T>;
}

class ExpoSqlConnection implements SqlConnection {
  constructor(private readonly database: SQLiteDatabase) {}

  exec(source: string): Promise<void> {
    return this.database.execAsync(source);
  }

  async run(
    source: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlRunResult> {
    const result = await this.database.runAsync(source, [...params]);
    return { changes: result.changes };
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

  async exclusive<T>(
    task: (transaction: SqlConnection) => Promise<T>,
  ): Promise<T> {
    let outcome: { readonly value: T } | undefined;
    await this.database.withExclusiveTransactionAsync(async transaction => {
      outcome = { value: await task(new ExpoSqlConnection(transaction)) };
    });
    if (outcome === undefined) throw new DomainError('STORAGE_WRITE_FAILED');
    return outcome.value;
  }
}

export interface OpenPersistenceRepositoryOptions {
  readonly migrationHook?: PersistenceMigrationHook;
  readonly allowDevelopmentReset?: boolean;
}

const repositoryInstances = new Map<
  string,
  Promise<ExpoSqlitePersistenceRepository>
>();

export function openPersistenceRepository(
  databaseName = 'ai-context-pack.db',
  options: OpenPersistenceRepositoryOptions = {},
): Promise<ExpoSqlitePersistenceRepository> {
  const existing = repositoryInstances.get(databaseName);
  if (existing) return existing;
  const opening = (async () => {
    const database = await openDatabaseAsync(databaseName);
    const repository = new ExpoSqlitePersistenceRepository(
      new ExpoSqlConnection(database),
      options.migrationHook,
      options.allowDevelopmentReset ??
        (typeof __DEV__ !== 'undefined' && __DEV__),
    );
    await repository.initialize();
    return repository;
  })();
  repositoryInstances.set(databaseName, opening);
  opening.catch(() => repositoryInstances.delete(databaseName));
  return opening;
}

export class ExpoSqlitePersistenceRepository
  implements ProductionPersistenceRepository
{
  private initialized = false;
  private initializing: Promise<void> | undefined;

  constructor(
    private readonly connection: SqlConnection,
    private readonly migrationHook?: PersistenceMigrationHook,
    private readonly allowDevelopmentReset = false,
  ) {}

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const tracked = this.initializeOnce().finally(() => {
      if (this.initializing === tracked) this.initializing = undefined;
    });
    this.initializing = tracked;
    return tracked;
  }

  private async initializeOnce(): Promise<void> {
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
      await this.migrationHook?.({
        fromVersion: version,
        toVersion: version + 1,
        phase: 'starting',
      });
      await this.connection.exclusive(transaction =>
        transaction.exec(migration),
      );
      await this.migrationHook?.({
        fromVersion: version,
        toVersion: version + 1,
        phase: 'applied',
      });
      version += 1;
    }
    this.initialized = true;
  }

  async findImport(
    ingestionId: string,
  ): Promise<PersistedImportSummary | null> {
    requireCanonicalId(ingestionId);
    const row = await this.connection.first<{
      ingestion_id: string;
      pack_id: string;
      manifest_fingerprint: string;
      status: string;
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
      ? decodePersisted(() => {
          requireCanonicalId(row.ingestion_id);
          requireCanonicalId(row.pack_id);
          if (
            !/^[0-9a-f]{64}$/.test(row.manifest_fingerprint) ||
            !Number.isSafeInteger(row.item_count) ||
            row.item_count < 0 ||
            !Number.isSafeInteger(row.artifact_count) ||
            row.artifact_count < 0
          )
            throw new DomainError('SCHEMA_INVALID');
          return {
            ingestionId: row.ingestion_id,
            packId: row.pack_id,
            manifestFingerprint: row.manifest_fingerprint,
            status: importStatus(row.status),
            itemCount: row.item_count,
            artifactCount: row.artifact_count,
          };
        })
      : null;
  }

  listImportDetails(): Promise<readonly PersistedImportDetail[]> {
    return this.connection.exclusive(async transaction => {
      const imports = await transaction.all<{
        ingestion_id: string;
        pack_id: string;
        manifest_fingerprint: string;
        status: string;
        created_at: string;
      }>(
        `SELECT ingestion_id, pack_id, manifest_fingerprint, status, created_at
         FROM imports ORDER BY created_at DESC, ingestion_id`,
      );
      const details: PersistedImportDetail[] = [];
      for (const row of imports) {
        const items = await transaction.all<{
          id: string;
          sort_index: number;
          media_type: string;
          status: string;
          error_code: string | null;
          artifact_count: number;
        }>(
          `SELECT item.id, item.sort_index, item.media_type, item.status, item.error_code,
             (SELECT COUNT(*) FROM artifacts artifact WHERE artifact.item_id = item.id) AS artifact_count
           FROM import_items item WHERE item.ingestion_id = ?
           ORDER BY item.sort_index, item.id`,
          [row.ingestion_id],
        );
        details.push(
          decodePersisted(() => {
            requireCanonicalId(row.ingestion_id);
            requireCanonicalId(row.pack_id);
            requireIsoDateTime(row.created_at);
            if (
              !/^[0-9a-f]{64}$/.test(row.manifest_fingerprint) ||
              items.length === 0 ||
              items.length > 20
            )
              throw new DomainError('SCHEMA_INVALID');
            const decodedItems = items.map((item, index) => {
              requireCanonicalId(item.id);
              if (
                item.sort_index !== index ||
                !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
                  item.media_type,
                ) ||
                item.media_type.length > 127 ||
                !Number.isSafeInteger(item.artifact_count) ||
                item.artifact_count < 0
              )
                throw new DomainError('SCHEMA_INVALID');
              const status = importItemStatus(item.status);
              if (
                (status === 'failed') !== (item.error_code !== null) ||
                (status === 'copied' && item.artifact_count !== 1) ||
                (status === 'failed' && item.artifact_count !== 0)
              )
                throw new DomainError('SCHEMA_INVALID');
              return {
                id: item.id,
                order: item.sort_index,
                mediaType: item.media_type,
                status,
                ...(item.error_code
                  ? { errorCode: domainErrorCode(item.error_code) }
                  : {}),
              };
            });
            const status = importStatus(row.status);
            const copied = decodedItems.filter(
              item => item.status === 'copied',
            ).length;
            const expectedStatus =
              copied === decodedItems.length
                ? 'complete'
                : copied === 0
                ? 'failed'
                : 'partial';
            if (status !== expectedStatus)
              throw new DomainError('SCHEMA_INVALID');
            return {
              ingestionId: row.ingestion_id,
              packId: row.pack_id,
              manifestFingerprint: row.manifest_fingerprint,
              status,
              itemCount: decodedItems.length,
              artifactCount: decodedItems.filter(
                item => item.status === 'copied',
              ).length,
              createdAt: row.created_at,
              items: decodedItems,
            };
          }),
        );
      }
      return details;
    });
  }

  async commitImport(
    input: CommitImportInput,
  ): Promise<'created' | 'replayed'> {
    validateCommitImport(input);
    let outcome: 'created' | 'replayed' = 'created';
    await this.connection.exclusive(async transaction => {
      const existing = await transaction.first<{
        pack_id: string;
        manifest_fingerprint: string;
        manifest_version: number;
        source: string;
        status: string;
        created_at: string;
      }>(
        `SELECT pack_id, manifest_fingerprint, manifest_version, source, status, created_at
         FROM imports WHERE ingestion_id = ?`,
        [input.manifest.ingestionId],
      );
      if (existing) {
        if (
          existing.pack_id !== input.packId ||
          existing.manifest_fingerprint !== input.manifestFingerprint ||
          existing.manifest_version !== input.manifest.schemaVersion ||
          existing.source !== input.manifest.source ||
          existing.status !== input.manifest.status ||
          existing.created_at !== input.manifest.createdAt
        )
          throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
        const persistedArtifacts = await loadImportArtifactIdentities(
          transaction,
          input.manifest.ingestionId,
        );
        if (!artifactIdentitySetsEqual(persistedArtifacts, input.artifacts))
          throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
        const materializedItems = await transaction.all<{
          id: string;
          import_order: number;
          import_status: string;
          import_error_code: string | null;
          pack_id: string;
          source_type: string;
          media_type: string;
          original_sha256: string | null;
          original_relative_path: string | null;
        }>(
          `SELECT imported_item.id, imported_item.sort_index AS import_order,
             imported_item.status AS import_status,
             imported_item.error_code AS import_error_code,
             item.pack_id, item.source_type, item.media_type,
             item.original_sha256, item.original_relative_path
           FROM import_items imported_item
           JOIN context_items item ON item.id = imported_item.id
           WHERE imported_item.ingestion_id = ?`,
          [input.manifest.ingestionId],
        );
        const materializedById = new Map(
          materializedItems.map(item => [item.id, item] as const),
        );
        const artifactsByItem = new Map(
          input.artifacts.map(artifact => [artifact.itemId, artifact] as const),
        );
        if (
          materializedItems.length !== input.manifest.items.length ||
          input.manifest.items.some(item => {
            const row = materializedById.get(item.id);
            const artifact = artifactsByItem.get(item.id);
            return (
              !row ||
              row.import_order !== item.order ||
              row.import_status !== item.status ||
              row.import_error_code !==
                (item.status === 'failed' ? item.errorCode : null) ||
              row.pack_id !== input.packId ||
              row.source_type !== sourceTypeForMediaType(item.mediaType) ||
              row.media_type !== item.mediaType ||
              row.original_sha256 !== (artifact?.sha256 ?? null) ||
              row.original_relative_path !== (artifact?.relativePath ?? null)
            );
          })
        )
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        await transaction.run(
          'DELETE FROM recovery_journal WHERE ingestion_id = ?',
          [input.manifest.ingestionId],
        );
        outcome = 'replayed';
        return;
      }

      const insertedPack = await transaction.run(
        `INSERT OR IGNORE INTO packs
          (id, created_at, schema_version, title, user_instruction, updated_at,
           state, budget_json, estimated_tokens, warning_codes_json, revision)
         VALUES (?, ?, 1, 'Context Pack', '', ?, 'draft', ?, 0, '[]', 1)`,
        [
          input.packId,
          input.manifest.createdAt,
          input.manifest.createdAt,
          DEFAULT_BUDGET_JSON,
        ],
      );
      const pack = await transaction.first<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM packs WHERE id = ?',
        [input.packId],
      );
      if (!pack || pack.deleted_at !== null)
        throw new DomainError('PERSISTENCE_CONFLICT');

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
      const orderStart =
        (
          await transaction.first<{ next_index: number }>(
            'SELECT COALESCE(MAX(sort_index) + 1, 0) AS next_index FROM context_items WHERE pack_id = ?',
            [input.packId],
          )
        )?.next_index ?? 0;
      const artifactsByItem = new Map(
        input.artifacts.map(artifact => [artifact.itemId, artifact] as const),
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
        const artifact = artifactsByItem.get(item.id);
        await transaction.run(
          `INSERT INTO context_items
            (id, pack_id, source_type, media_type, original_sha256,
             original_relative_path, state, inclusion_mode, sort_index,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'both', ?, ?, ?)`,
          [
            item.id,
            input.packId,
            sourceTypeForMediaType(item.mediaType),
            item.mediaType,
            artifact?.sha256 ?? null,
            artifact?.relativePath ?? null,
            item.status === 'copied' ? 'imported' : 'failed',
            orderStart + item.order,
            input.manifest.createdAt,
            input.manifest.createdAt,
          ],
        );
      }
      for (const artifact of input.artifacts) {
        await transaction.run(
          `INSERT INTO artifacts
            (id, item_id, relative_path, media_type, byte_count, sha256,
             created_at, last_verified_at, kind, processor_version_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'original', ?)`,
          [
            artifact.id,
            artifact.itemId,
            artifact.relativePath,
            artifact.mediaType,
            artifact.byteCount,
            artifact.sha256,
            input.manifest.createdAt,
            input.manifest.createdAt,
            INBOX_PROCESSOR_JSON,
          ],
        );
        await transaction.run(
          `INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
           VALUES ('pack', ?, ?)`,
          [input.packId, artifact.id],
        );
      }
      await transaction.run(
        `UPDATE packs
         SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END,
           revision = revision + ?
         WHERE id = ?`,
        [
          input.manifest.createdAt,
          input.manifest.createdAt,
          insertedPack.changes === 1 ? 0 : 1,
          input.packId,
        ],
      );
      await transaction.run(
        'DELETE FROM recovery_journal WHERE ingestion_id = ?',
        [input.manifest.ingestionId],
      );
    });
    return outcome;
  }

  recordRecovery(entry: RecoveryJournalEntry): Promise<void> {
    validateRecoveryEntry(entry);
    return this.connection
      .run(
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
      )
      .then(() => undefined);
  }

  async findRecovery(
    ingestionId: string,
  ): Promise<RecoveryJournalEntry | null> {
    requireCanonicalId(ingestionId);
    const row = await this.connection.first<{
      ingestion_id: string;
      pack_id: string;
      phase: string;
      updated_at: string;
      error_code: string | null;
    }>(
      'SELECT ingestion_id, pack_id, phase, updated_at, error_code FROM recovery_journal WHERE ingestion_id = ?',
      [ingestionId],
    );
    if (!row) return null;
    return decodePersisted(() => {
      const entry: RecoveryJournalEntry = {
        ingestionId: row.ingestion_id,
        packId: row.pack_id,
        phase: recoveryPhase(row.phase),
        updatedAt: row.updated_at,
        ...(row.error_code
          ? { errorCode: domainErrorCode(row.error_code) }
          : {}),
      };
      validateRecoveryEntry(entry);
      return entry;
    });
  }

  async findPackGraph(packId: string): Promise<PersistedPackGraph | null> {
    requireCanonicalId(packId);
    return this.connection.exclusive(transaction =>
      readPackGraph(transaction, packId),
    );
  }

  listPackGraphs(): Promise<readonly PersistedPackGraph[]> {
    return this.connection.exclusive(async transaction => {
      const rows = await transaction.all<{ id: string }>(
        'SELECT id FROM packs WHERE deleted_at IS NULL ORDER BY updated_at DESC, id',
      );
      const values: PersistedPackGraph[] = [];
      for (const row of rows) {
        const value = await readPackGraph(transaction, row.id);
        if (!value) throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        values.push(value);
      }
      return values;
    });
  }

  async listItemsForPack(packId: string): Promise<readonly ContextItem[]> {
    requireCanonicalId(packId);
    return this.connection.exclusive(transaction =>
      loadContextItems(transaction, packId),
    );
  }

  async savePackGraph(input: SavePackGraphInput): Promise<number> {
    assertPackGraph(input);
    return this.connection.exclusive(async transaction => {
      const existing = await transaction.first<{
        revision: number;
        deleted_at: string | null;
      }>('SELECT revision, deleted_at FROM packs WHERE id = ?', [
        input.pack.id,
      ]);
      let nextRevision: number;
      if (!existing) {
        if (input.expectedRevision !== undefined)
          throw new DomainError('PERSISTENCE_CONFLICT');
        await transaction.run(
          `INSERT INTO packs
            (id, created_at, schema_version, title, user_instruction, updated_at,
             state, budget_json, estimated_tokens, warning_codes_json, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          packSqlValues(input.pack),
        );
        nextRevision = 1;
      } else {
        if (
          existing.deleted_at !== null ||
          input.expectedRevision === undefined ||
          existing.revision !== input.expectedRevision
        )
          throw new DomainError('PERSISTENCE_CONFLICT');
        nextRevision = existing.revision + 1;
        const update = await transaction.run(
          `UPDATE packs SET schema_version = ?, title = ?, user_instruction = ?,
             updated_at = ?, state = ?, budget_json = ?, estimated_tokens = ?,
             warning_codes_json = ?, revision = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
          [
            input.pack.schemaVersion,
            input.pack.title,
            input.pack.userInstruction,
            input.pack.updatedAt,
            input.pack.state,
            encodeBudget(input.pack.budget),
            input.pack.estimatedTokens,
            encodeStringArray(input.pack.warningCodes),
            nextRevision,
            input.pack.id,
            input.expectedRevision,
          ],
        );
        if (update.changes !== 1) throw new DomainError('PERSISTENCE_CONFLICT');
      }
      await replaceContextItems(
        transaction,
        input.pack.id,
        input.items,
        input.pack.createdAt,
        input.pack.updatedAt,
      );
      return nextRevision;
    });
  }

  async deletePack(
    packId: string,
    expectedRevision: number,
  ): Promise<DeletePackResult> {
    requireCanonicalId(packId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new DomainError('SCHEMA_INVALID');
    return this.connection.exclusive(async transaction => {
      const pack = await transaction.first<{
        revision: number;
        deleted_at: string | null;
      }>('SELECT revision, deleted_at FROM packs WHERE id = ?', [packId]);
      if (
        !pack ||
        pack.deleted_at !== null ||
        pack.revision !== expectedRevision
      )
        throw new DomainError('PERSISTENCE_CONFLICT');
      const itemCount =
        (
          await transaction.first<{ count: number }>(
            'SELECT COUNT(*) AS count FROM context_items WHERE pack_id = ?',
            [packId],
          )
        )?.count ?? 0;
      const referenceCount =
        (
          await transaction.first<{ count: number }>(
            `SELECT COUNT(DISTINCT artifact_id) AS count FROM artifact_references
             WHERE (owner_type = 'pack' AND owner_id = ?)
                OR (owner_type = 'export' AND owner_id IN
                  (SELECT id FROM export_records WHERE pack_id = ?))`,
            [packId, packId],
          )
        )?.count ?? 0;
      await transaction.run(
        `DELETE FROM artifact_references
         WHERE (owner_type = 'pack' AND owner_id = ?)
            OR (owner_type = 'export' AND owner_id IN
              (SELECT id FROM export_records WHERE pack_id = ?))`,
        [packId, packId],
      );
      await transaction.run('DELETE FROM export_records WHERE pack_id = ?', [
        packId,
      ]);
      await transaction.run('DELETE FROM context_items WHERE pack_id = ?', [
        packId,
      ]);
      const deletedAt = new Date().toISOString();
      const update = await transaction.run(
        `UPDATE packs SET title = '', user_instruction = '', warning_codes_json = '[]',
           state = 'cancelled', updated_at = ?, deleted_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        [deletedAt, deletedAt, packId, expectedRevision],
      );
      if (update.changes !== 1) throw new DomainError('PERSISTENCE_CONFLICT');
      return {
        removedItemCount: itemCount,
        releasedArtifactCount: referenceCount,
      };
    });
  }

  async saveRiskFinding(finding: RiskFinding): Promise<void> {
    assertRiskFinding(finding);
    await this.connection.exclusive(async transaction => {
      const item = await transaction.first<{ id: string }>(
        `SELECT item.id FROM context_items item
         JOIN packs pack ON pack.id = item.pack_id
         WHERE item.id = ? AND pack.deleted_at IS NULL`,
        [finding.itemId],
      );
      if (!item) throw new DomainError('PERSISTENCE_CONFLICT');
      const existing = await transaction.first<{ item_id: string }>(
        'SELECT item_id FROM risk_findings WHERE id = ?',
        [finding.id],
      );
      if (existing && existing.item_id !== finding.itemId)
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      await transaction.run(
        `INSERT INTO risk_findings
          (id, item_id, detector_version_json, category, severity, confidence,
           location_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           detector_version_json = excluded.detector_version_json,
           category = excluded.category,
           severity = excluded.severity,
           confidence = excluded.confidence,
           location_json = excluded.location_json,
           created_at = excluded.created_at`,
        [
          finding.id,
          finding.itemId,
          encodeProcessorVersion(finding.detectorVersion),
          finding.category,
          finding.severity,
          finding.confidence,
          encodeFindingLocation(finding.location),
          finding.createdAt,
        ],
      );
    });
  }

  async listRiskFindingsForItem(
    itemId: string,
  ): Promise<readonly RiskFinding[]> {
    requireCanonicalId(itemId);
    const rows = await this.connection.all<RiskFindingRow>(
      `SELECT id, item_id, detector_version_json, category, severity,
         confidence, location_json, created_at
       FROM risk_findings WHERE item_id = ? ORDER BY created_at, id`,
      [itemId],
    );
    return rows.map(decodeRiskFindingRow);
  }

  async saveExportRecord(record: ExportRecord): Promise<void> {
    assertExportRecord(record);
    await this.connection.exclusive(async transaction => {
      const pack = await transaction.first<{ id: string }>(
        'SELECT id FROM packs WHERE id = ? AND deleted_at IS NULL',
        [record.packId],
      );
      if (!pack) throw new DomainError('PERSISTENCE_CONFLICT');
      const existing = await transaction.first<{ pack_id: string }>(
        'SELECT pack_id FROM export_records WHERE id = ?',
        [record.id],
      );
      if (existing && existing.pack_id !== record.packId)
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      await assertArtifactsReferencedByPack(
        transaction,
        record.packId,
        record.artifactIds,
      );
      await transaction.run(
        `INSERT INTO export_records
          (id, pack_id, format, created_at, preset, status, manifest_sha256, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           format = excluded.format,
           created_at = excluded.created_at,
           preset = excluded.preset,
           status = excluded.status,
           manifest_sha256 = excluded.manifest_sha256,
           error_code = excluded.error_code`,
        [
          record.id,
          record.packId,
          record.format,
          record.createdAt,
          record.preset,
          record.status,
          record.manifestSha256 ?? null,
          record.errorCode ?? null,
        ],
      );
      await transaction.run(
        "DELETE FROM artifact_references WHERE owner_type = 'export' AND owner_id = ?",
        [record.id],
      );
      await transaction.run(
        'DELETE FROM export_record_artifacts WHERE export_id = ?',
        [record.id],
      );
      for (const [index, artifactId] of record.artifactIds.entries()) {
        await transaction.run(
          'INSERT INTO export_record_artifacts (export_id, artifact_id, sort_index) VALUES (?, ?, ?)',
          [record.id, artifactId, index],
        );
        await transaction.run(
          `INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
           VALUES ('export', ?, ?)`,
          [record.id, artifactId],
        );
      }
    });
  }

  async listExportRecordsForPack(
    packId: string,
  ): Promise<readonly ExportRecord[]> {
    requireCanonicalId(packId);
    return this.connection.exclusive(async transaction => {
      const rows = await transaction.all<ExportRecordRow>(
        `SELECT id, pack_id, format, created_at, preset, status,
           manifest_sha256, error_code
         FROM export_records WHERE pack_id = ? ORDER BY created_at, id`,
        [packId],
      );
      const records: ExportRecord[] = [];
      for (const row of rows) {
        const artifacts = await transaction.all<{ artifact_id: string }>(
          `SELECT artifact_id FROM export_record_artifacts
           WHERE export_id = ? ORDER BY sort_index`,
          [row.id],
        );
        records.push(
          decodeExportRecordRow(
            row,
            artifacts.map(value => value.artifact_id),
          ),
        );
      }
      return records;
    });
  }

  async registerPublishedArtifact(
    input: RegisterPublishedArtifactInput,
  ): Promise<'created' | 'replayed'> {
    validatePublishedArtifact(input);
    return this.connection.exclusive(async transaction => {
      const pack = await transaction.first<{ id: string }>(
        'SELECT id FROM packs WHERE id = ? AND deleted_at IS NULL',
        [input.packId],
      );
      if (!pack) throw new DomainError('PERSISTENCE_CONFLICT');
      if (input.artifact.itemId !== undefined) {
        const item = await transaction.first<{ id: string }>(
          'SELECT id FROM context_items WHERE id = ? AND pack_id = ?',
          [input.artifact.itemId, input.packId],
        );
        if (!item) throw new DomainError('PERSISTENCE_CONFLICT');
      }
      if (input.artifact.kind === 'original') {
        const original = await transaction.first<{ id: string }>(
          "SELECT id FROM artifacts WHERE item_id = ? AND kind = 'original'",
          [input.artifact.itemId ?? null],
        );
        if (original && original.id !== input.artifact.id)
          throw new DomainError('STORAGE_ARTIFACT_IMMUTABLE');
      }
      const existing = await transaction.first<ArtifactRow>(
        `SELECT id, item_id, relative_path, media_type, byte_count, sha256,
           kind, processor_version_json, created_at, last_verified_at
         FROM artifacts WHERE id = ? OR relative_path = ?`,
        [input.artifact.id, input.artifact.relativePath],
      );
      if (existing) {
        if (!persistedArtifactEquals(existing, input.artifact))
          throw new DomainError('STORAGE_ARTIFACT_IMMUTABLE');
        await transaction.run(
          `INSERT OR IGNORE INTO artifact_references
            (owner_type, owner_id, artifact_id) VALUES ('pack', ?, ?)`,
          [input.packId, input.artifact.id],
        );
        return 'replayed';
      }
      await transaction.run(
        `INSERT INTO artifacts
          (id, item_id, relative_path, media_type, byte_count, sha256, created_at,
           last_verified_at, kind, processor_version_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.artifact.id,
          input.artifact.itemId ?? null,
          input.artifact.relativePath,
          input.artifact.mediaType,
          input.artifact.byteCount,
          input.artifact.sha256,
          input.artifact.createdAt,
          input.artifact.createdAt,
          input.artifact.kind,
          encodeProcessorVersion(input.artifact.processorVersion),
        ],
      );
      await transaction.run(
        `INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
         VALUES ('pack', ?, ?)`,
        [input.packId, input.artifact.id],
      );
      return 'created';
    });
  }

  async listArtifactRecords(): Promise<readonly PersistedArtifactRecord[]> {
    const rows = await this.connection.all<ArtifactRow>(
      `SELECT id, item_id, relative_path, media_type, byte_count, sha256,
         kind, processor_version_json, created_at, last_verified_at
       FROM artifacts ORDER BY created_at, id`,
    );
    return rows.map(row =>
      decodePersisted(() => {
        const artifact: PersistedArtifactRecord = {
          id: row.id,
          ...(row.item_id ? { itemId: row.item_id } : {}),
          relativePath: row.relative_path,
          mediaType: row.media_type,
          byteCount: row.byte_count,
          sha256: row.sha256,
          kind: artifactKind(row.kind),
          processorVersion: decodeProcessorVersion(row.processor_version_json),
          createdAt: row.created_at,
          immutable: true,
          ...(row.last_verified_at
            ? { lastVerifiedAt: row.last_verified_at }
            : {}),
        };
        assertArtifact(artifact);
        assertPersistedArtifactPathKind(artifact);
        if (
          artifact.lastVerifiedAt !== undefined &&
          !isIsoDateTime(artifact.lastVerifiedAt)
        )
          throw new DomainError('SCHEMA_INVALID');
        return artifact;
      }),
    );
  }

  async markArtifactVerified(
    artifactId: string,
    verifiedAt: string,
  ): Promise<void> {
    requireCanonicalId(artifactId);
    requireIsoDateTime(verifiedAt);
    const result = await this.connection.run(
      'UPDATE artifacts SET last_verified_at = ? WHERE id = ?',
      [verifiedAt, artifactId],
    );
    if (result.changes !== 1)
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  }

  async recordRecoveryDiagnostic(
    input: RecoveryDiagnosticInput,
  ): Promise<void> {
    validateDiagnostic(input);
    await this.connection.run(
      `INSERT INTO recovery_diagnostics
        (id, scope, anonymous_id, code, phase, first_occurred_at,
         last_occurred_at, occurrence_count, byte_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         scope = excluded.scope,
         anonymous_id = excluded.anonymous_id,
         code = excluded.code,
         phase = excluded.phase,
         last_occurred_at = excluded.last_occurred_at,
         occurrence_count = recovery_diagnostics.occurrence_count + 1,
         byte_count = excluded.byte_count`,
      [
        input.id,
        input.scope,
        input.anonymousId,
        input.code,
        input.phase,
        input.occurredAt,
        input.occurredAt,
        input.byteCount ?? null,
      ],
    );
  }

  async listRecoveryDiagnostics(): Promise<readonly RecoveryDiagnostic[]> {
    const rows = await this.connection.all<RecoveryDiagnosticRow>(
      `SELECT id, scope, anonymous_id, code, phase, first_occurred_at,
         last_occurred_at, occurrence_count, byte_count
       FROM recovery_diagnostics ORDER BY last_occurred_at DESC, id`,
    );
    return rows.map(row =>
      decodePersisted(() => {
        const value: RecoveryDiagnostic = {
          id: row.id,
          scope: diagnosticScope(row.scope),
          anonymousId: row.anonymous_id,
          code: domainErrorCode(row.code),
          phase: row.phase,
          occurredAt: row.first_occurred_at,
          occurrenceCount: row.occurrence_count,
          lastOccurredAt: row.last_occurred_at,
          ...(row.byte_count === null ? {} : { byteCount: row.byte_count }),
        };
        validateDiagnostic(value);
        if (
          !Number.isSafeInteger(value.occurrenceCount) ||
          value.occurrenceCount < 1 ||
          !isIsoDateTime(value.lastOccurredAt) ||
          Date.parse(value.lastOccurredAt) < Date.parse(value.occurredAt)
        )
          throw new DomainError('SCHEMA_INVALID');
        return value;
      }),
    );
  }

  async recordQuarantine(input: QuarantineRecordInput): Promise<void> {
    validateQuarantineRecord(input);
    await this.connection.run(
      `INSERT INTO quarantine_records
        (id, anonymous_id, reason_code, byte_count, created_at, purge_after, purged_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         anonymous_id = excluded.anonymous_id,
         reason_code = excluded.reason_code,
         byte_count = excluded.byte_count,
         created_at = excluded.created_at,
         purge_after = excluded.purge_after,
         purged_at = NULL`,
      [
        input.id,
        input.anonymousId,
        input.reasonCode,
        input.byteCount,
        input.createdAt,
        input.purgeAfter,
      ],
    );
  }

  async markQuarantinePurgedBefore(
    quarantinedBefore: string,
    purgedAt: string,
  ): Promise<number> {
    requireIsoDateTime(quarantinedBefore);
    requireIsoDateTime(purgedAt);
    const result = await this.connection.run(
      `UPDATE quarantine_records SET purged_at = ?
       WHERE purged_at IS NULL AND created_at <= ?`,
      [purgedAt, quarantinedBefore],
    );
    return result.changes;
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    const row = await this.connection.first<{
      artifact_count: number;
      artifact_bytes: number;
      referenced_count: number;
      referenced_bytes: number;
      recovery_count: number;
      quarantine_count: number;
      quarantine_bytes: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM artifacts) AS artifact_count,
        (SELECT COALESCE(SUM(byte_count), 0) FROM artifacts) AS artifact_bytes,
        (SELECT COUNT(DISTINCT artifact_id) FROM artifact_references) AS referenced_count,
        (SELECT COALESCE(SUM(byte_count), 0) FROM artifacts WHERE id IN
          (SELECT DISTINCT artifact_id FROM artifact_references)) AS referenced_bytes,
        (SELECT COUNT(*) FROM recovery_journal) AS recovery_count,
        (SELECT COUNT(*) FROM quarantine_records WHERE purged_at IS NULL) AS quarantine_count,
        (SELECT COALESCE(SUM(byte_count), 0) FROM quarantine_records WHERE purged_at IS NULL) AS quarantine_bytes`,
    );
    if (!row) throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
    return decodePersisted(() => {
      const values = [
        row.artifact_count,
        row.artifact_bytes,
        row.referenced_count,
        row.referenced_bytes,
        row.recovery_count,
        row.quarantine_count,
        row.quarantine_bytes,
      ];
      if (
        values.some(value => !Number.isSafeInteger(value) || value < 0) ||
        row.referenced_count > row.artifact_count ||
        row.referenced_bytes > row.artifact_bytes
      )
        throw new DomainError('SCHEMA_INVALID');
      return {
        artifactCount: row.artifact_count,
        artifactBytes: row.artifact_bytes,
        referencedArtifactCount: row.referenced_count,
        referencedArtifactBytes: row.referenced_bytes,
        recoveryCount: row.recovery_count,
        quarantineCount: row.quarantine_count,
        quarantineBytes: row.quarantine_bytes,
      };
    });
  }

  async acquireCleanupLease(
    ownerId: string,
    acquiredAt: string,
    expiresAt: string,
  ): Promise<boolean> {
    requireCanonicalId(ownerId);
    requireIsoDateTime(acquiredAt);
    requireIsoDateTime(expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(acquiredAt))
      throw new DomainError('SCHEMA_INVALID');
    return this.connection.exclusive(async transaction => {
      const existing = await transaction.first<{
        owner_id: string;
        expires_at: string;
      }>(
        "SELECT owner_id, expires_at FROM cleanup_leases WHERE name = 'artifact-cleanup'",
      );
      if (existing && Date.parse(existing.expires_at) > Date.parse(acquiredAt))
        return false;
      await transaction.run(
        `INSERT INTO cleanup_leases (name, owner_id, acquired_at, expires_at)
         VALUES ('artifact-cleanup', ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           owner_id = excluded.owner_id,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at`,
        [ownerId, acquiredAt, expiresAt],
      );
      return true;
    });
  }

  async releaseCleanupLease(ownerId: string): Promise<void> {
    requireCanonicalId(ownerId);
    await this.connection.run(
      "DELETE FROM cleanup_leases WHERE name = 'artifact-cleanup' AND owner_id = ?",
      [ownerId],
    );
  }

  async resetForDevelopment(
    confirmation: typeof DEVELOPMENT_RESET_CONFIRMATION,
  ): Promise<void> {
    if (
      !this.allowDevelopmentReset ||
      confirmation !== DEVELOPMENT_RESET_CONFIRMATION
    )
      throw new DomainError('DEVELOPMENT_RESET_FORBIDDEN');
    await this.connection.exclusive(transaction =>
      transaction.exec(`
        DROP TABLE IF EXISTS cleanup_leases;
        DROP TABLE IF EXISTS quarantine_records;
        DROP TABLE IF EXISTS recovery_diagnostics;
        DROP TABLE IF EXISTS export_record_artifacts;
        DROP TABLE IF EXISTS export_records;
        DROP TABLE IF EXISTS risk_findings;
        DROP TABLE IF EXISTS context_items;
        DROP TABLE IF EXISTS artifact_references;
        DROP TABLE IF EXISTS artifacts;
        DROP TABLE IF EXISTS import_items;
        DROP TABLE IF EXISTS imports;
        DROP TABLE IF EXISTS recovery_journal;
        DROP TABLE IF EXISTS packs;
        PRAGMA user_version = 0;
      `),
    );
    this.initialized = false;
    await this.initialize();
  }

  async listReferencedRelativePaths(): Promise<ReadonlySet<string>> {
    const rows = await this.connection.all<{ relative_path: string }>(
      `SELECT DISTINCT a.relative_path FROM artifacts a
       JOIN artifact_references r ON r.artifact_id = a.id`,
    );
    return decodePersisted(() => {
      rows.forEach(row => assertOwnedArtifactPath(row.relative_path));
      return new Set(rows.map(row => row.relative_path));
    });
  }

  async listKnownRelativePaths(): Promise<ReadonlySet<string>> {
    const rows = await this.connection.all<{ relative_path: string }>(
      'SELECT relative_path FROM artifacts',
    );
    return decodePersisted(() => {
      rows.forEach(row => assertOwnedArtifactPath(row.relative_path));
      return new Set(rows.map(row => row.relative_path));
    });
  }

  async listRecoveringPackIds(): Promise<ReadonlySet<string>> {
    const rows = await this.connection.all<{ pack_id: string }>(
      "SELECT DISTINCT pack_id FROM recovery_journal WHERE phase <> 'quarantined'",
    );
    return decodePersisted(() => {
      rows.forEach(row => requireCanonicalId(row.pack_id));
      return new Set(rows.map(row => row.pack_id));
    });
  }

  listCleanupCandidates(
    olderThan: string,
  ): Promise<readonly CleanupCandidate[]> {
    requireIsoDateTime(olderThan);
    return this.connection
      .all<CleanupCandidate>(
        `SELECT a.id AS artifactId, a.relative_path AS relativePath, a.created_at AS createdAt
       FROM artifacts a
       LEFT JOIN artifact_references r ON r.artifact_id = a.id
       WHERE r.artifact_id IS NULL AND a.created_at < ?`,
        [olderThan],
      )
      .then(rows =>
        decodePersisted(() => {
          rows.forEach(row => {
            requireCanonicalId(row.artifactId);
            assertOwnedArtifactPath(row.relativePath);
            requireIsoDateTime(row.createdAt);
          });
          return rows;
        }),
      );
  }

  async deleteArtifactRecordIfUnreferenced(
    artifactId: string,
  ): Promise<boolean> {
    requireCanonicalId(artifactId);
    return this.connection.exclusive(async transaction => {
      const reference = await transaction.first<{ found: number }>(
        'SELECT 1 AS found FROM artifact_references WHERE artifact_id = ? LIMIT 1',
        [artifactId],
      );
      if (reference) return false;
      const result = await transaction.run(
        'DELETE FROM artifacts WHERE id = ?',
        [artifactId],
      );
      return result.changes === 1;
    });
  }
}

const DEFAULT_BUDGET_JSON =
  '{"preset":"balanced","maxOutputBytes":10485760,"minimumImageLongestEdge":1280,"imageQuality":0.82,"estimatorVersion":"v1"}';
const INBOX_PROCESSOR_JSON =
  '{"processor":"inbox-handoff","version":"1","contractVersion":1}';

interface PackRow {
  readonly id: string;
  readonly schema_version: number;
  readonly title: string;
  readonly user_instruction: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state: string;
  readonly budget_json: string;
  readonly estimated_tokens: number;
  readonly warning_codes_json: string;
  readonly revision: number;
}

interface ContextItemRow {
  readonly id: string;
  readonly pack_id: string;
  readonly source_type: string;
  readonly media_type: string;
  readonly original_display_name: string | null;
  readonly original_sha256: string | null;
  readonly original_relative_path: string | null;
  readonly state: string;
  readonly inclusion_mode: string;
  readonly sort_index: number;
}

interface RiskFindingRow {
  readonly id: string;
  readonly item_id: string;
  readonly detector_version_json: string;
  readonly category: string;
  readonly severity: string;
  readonly confidence: number;
  readonly location_json: string;
  readonly created_at: string;
}

interface ExportRecordRow {
  readonly id: string;
  readonly pack_id: string;
  readonly format: string;
  readonly created_at: string;
  readonly preset: string;
  readonly status: string;
  readonly manifest_sha256: string | null;
  readonly error_code: string | null;
}

interface ArtifactRow {
  readonly id: string;
  readonly item_id: string | null;
  readonly relative_path: string;
  readonly media_type: string;
  readonly byte_count: number;
  readonly sha256: string;
  readonly kind: string;
  readonly processor_version_json: string;
  readonly created_at: string;
  readonly last_verified_at: string | null;
}

interface RecoveryDiagnosticRow {
  readonly id: string;
  readonly scope: string;
  readonly anonymous_id: string;
  readonly code: string;
  readonly phase: string;
  readonly first_occurred_at: string;
  readonly last_occurred_at: string;
  readonly occurrence_count: number;
  readonly byte_count: number | null;
}

async function readPackGraph(
  connection: SqlConnection,
  packId: string,
): Promise<PersistedPackGraph | null> {
  const row = await connection.first<PackRow>(
    `SELECT id, schema_version, title, user_instruction, created_at, updated_at,
       state, budget_json, estimated_tokens, warning_codes_json, revision
     FROM packs WHERE id = ? AND deleted_at IS NULL`,
    [packId],
  );
  if (!row) return null;
  const items = await loadContextItems(connection, packId);
  const exports = await connection.all<{ id: string }>(
    'SELECT id FROM export_records WHERE pack_id = ? ORDER BY created_at, id',
    [packId],
  );
  return decodePersisted(() => {
    const pack: ContextPack = {
      id: row.id,
      schemaVersion: requireSchemaVersionOne(row.schema_version),
      title: row.title,
      userInstruction: row.user_instruction,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: packState(row.state),
      budget: decodeBudget(row.budget_json),
      estimatedTokens: row.estimated_tokens,
      orderedItemIds: items.map(item => item.id),
      exportRecordIds: exports.map(value => value.id),
      warningCodes: decodeStringArray(row.warning_codes_json),
    };
    assertContextPack(pack);
    if (!Number.isSafeInteger(row.revision) || row.revision < 1)
      throw new DomainError('SCHEMA_INVALID');
    return { pack, items, revision: row.revision };
  });
}

async function loadContextItems(
  connection: SqlConnection,
  packId: string,
): Promise<readonly ContextItem[]> {
  const rows = await connection.all<ContextItemRow>(
    `SELECT id, pack_id, source_type, media_type, original_display_name,
       original_sha256, original_relative_path, state, inclusion_mode, sort_index
     FROM context_items WHERE pack_id = ? ORDER BY sort_index, id`,
    [packId],
  );
  const items: ContextItem[] = [];
  for (const row of rows) {
    const artifacts = await connection.all<{ id: string }>(
      'SELECT id FROM artifacts WHERE item_id = ? ORDER BY created_at, id',
      [row.id],
    );
    const findings = await connection.all<{ id: string }>(
      'SELECT id FROM risk_findings WHERE item_id = ? ORDER BY created_at, id',
      [row.id],
    );
    const item: ContextItem = {
      id: row.id,
      packId: row.pack_id,
      sourceType: contextItemSource(row.source_type),
      mediaType: row.media_type,
      ...(row.original_display_name
        ? { originalDisplayName: row.original_display_name }
        : {}),
      ...(row.original_sha256 ? { originalSha256: row.original_sha256 } : {}),
      ...(row.original_relative_path
        ? { originalRelativePath: row.original_relative_path }
        : {}),
      artifactIds: artifacts.map(value => value.id),
      state: itemState(row.state),
      riskFindingIds: findings.map(value => value.id),
      inclusionMode: inclusionMode(row.inclusion_mode),
      sortIndex: row.sort_index,
    };
    items.push(
      decodePersisted(() => {
        assertContextItem(item);
        if (item.sortIndex !== items.length)
          throw new DomainError('SCHEMA_INVALID');
        return item;
      }),
    );
  }
  return items;
}

async function replaceContextItems(
  transaction: SqlConnection,
  packId: string,
  items: readonly ContextItem[],
  createdAt: string,
  updatedAt: string,
): Promise<void> {
  const existing = await transaction.all<{ id: string }>(
    'SELECT id FROM context_items WHERE pack_id = ?',
    [packId],
  );
  await transaction.run(
    'UPDATE context_items SET sort_index = sort_index + 1000000000 WHERE pack_id = ?',
    [packId],
  );
  const retained = new Set(items.map(item => item.id));
  for (const row of existing) {
    if (retained.has(row.id)) continue;
    await transaction.run(
      `DELETE FROM artifact_references WHERE owner_type = 'pack' AND owner_id = ?
       AND artifact_id IN (SELECT id FROM artifacts WHERE item_id = ?)`,
      [packId, row.id],
    );
    await transaction.run('DELETE FROM context_items WHERE id = ?', [row.id]);
  }
  for (const item of items) {
    const imported = await transaction.first<{ id: string }>(
      `SELECT imported_item.id FROM import_items imported_item
       JOIN imports imported ON imported.ingestion_id = imported_item.ingestion_id
       WHERE imported_item.id = ? AND imported.pack_id = ?`,
      [item.id, packId],
    );
    if (!imported) throw new DomainError('PERSISTENCE_CONFLICT');
    const existingItem = await transaction.first<{
      pack_id: string;
      source_type: string;
      media_type: string;
      original_sha256: string | null;
      original_relative_path: string | null;
    }>(
      `SELECT pack_id, source_type, media_type, original_sha256, original_relative_path
       FROM context_items WHERE id = ?`,
      [item.id],
    );
    if (
      existingItem &&
      (existingItem.pack_id !== packId ||
        existingItem.source_type !== item.sourceType ||
        existingItem.media_type !== item.mediaType ||
        (existingItem.original_sha256 ?? undefined) !== item.originalSha256 ||
        (existingItem.original_relative_path ?? undefined) !==
          item.originalRelativePath)
    )
      throw new DomainError('STORAGE_ARTIFACT_IMMUTABLE');
    await assertItemRelationships(transaction, item);
    await transaction.run(
      `INSERT INTO context_items
        (id, pack_id, source_type, media_type, original_display_name,
         original_sha256, original_relative_path, state, inclusion_mode,
         sort_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_type = excluded.source_type,
         media_type = excluded.media_type,
         original_display_name = excluded.original_display_name,
         original_sha256 = excluded.original_sha256,
         original_relative_path = excluded.original_relative_path,
         state = excluded.state,
         inclusion_mode = excluded.inclusion_mode,
         sort_index = excluded.sort_index,
         updated_at = excluded.updated_at`,
      [
        item.id,
        item.packId,
        item.sourceType,
        item.mediaType,
        item.originalDisplayName ?? null,
        item.originalSha256 ?? null,
        item.originalRelativePath ?? null,
        item.state,
        item.inclusionMode,
        item.sortIndex,
        createdAt,
        updatedAt,
      ],
    );
  }
}

async function assertItemRelationships(
  transaction: SqlConnection,
  item: ContextItem,
): Promise<void> {
  const artifacts = await transaction.all<{
    id: string;
    kind: string;
    relative_path: string;
    sha256: string;
    referenced: number;
  }>(
    `SELECT artifact.id, artifact.kind, artifact.relative_path, artifact.sha256,
       EXISTS(
         SELECT 1 FROM artifact_references reference
         WHERE reference.artifact_id = artifact.id
           AND reference.owner_type = 'pack' AND reference.owner_id = ?
       ) AS referenced
     FROM artifacts artifact WHERE artifact.item_id = ? ORDER BY artifact.id`,
    [item.packId, item.id],
  );
  const findings = await transaction.all<{ id: string }>(
    'SELECT id FROM risk_findings WHERE item_id = ? ORDER BY id',
    [item.id],
  );
  if (
    artifacts.some(value => value.referenced !== 1) ||
    !sameStringSet(
      artifacts.map(value => value.id),
      item.artifactIds,
    ) ||
    !sameStringSet(
      findings.map(value => value.id),
      item.riskFindingIds,
    )
  )
    throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  const originals = artifacts.filter(value => value.kind === 'original');
  if (
    originals.length > 1 ||
    (originals[0]?.relative_path ?? undefined) !== item.originalRelativePath ||
    (originals[0]?.sha256 ?? undefined) !== item.originalSha256
  )
    throw new DomainError('STORAGE_ARTIFACT_IMMUTABLE');
}

async function assertArtifactsReferencedByPack(
  transaction: SqlConnection,
  packId: string,
  artifactIds: readonly string[],
): Promise<void> {
  for (const artifactId of artifactIds) {
    const row = await transaction.first<{ id: string }>(
      `SELECT artifact.id FROM artifacts artifact
       JOIN artifact_references reference ON reference.artifact_id = artifact.id
       WHERE artifact.id = ? AND reference.owner_type = 'pack' AND reference.owner_id = ?`,
      [artifactId, packId],
    );
    if (!row) throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
  }
}

async function loadImportArtifactIdentities(
  transaction: SqlConnection,
  ingestionId: string,
): Promise<readonly ArtifactIdentity[]> {
  const rows = await transaction.all<{
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
    [ingestionId],
  );
  return rows.map(row => ({
    id: row.id,
    itemId: row.item_id,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    byteCount: row.byte_count,
    sha256: row.sha256,
  }));
}

function validateCommitImport(input: CommitImportInput): void {
  if (
    !isCanonicalUuid(input.packId) ||
    !isImportManifestV1(input.manifest) ||
    !/^[0-9a-f]{64}$/.test(input.manifestFingerprint)
  )
    throw new DomainError('SCHEMA_INVALID');
  const copiedItems = input.manifest.items.filter(
    item => item.status === 'copied',
  );
  const copiedItemsById = new Map(
    copiedItems.map(item => [item.id, item] as const),
  );
  const artifactIds = new Set(input.artifacts.map(artifact => artifact.id));
  if (
    input.artifacts.length !== copiedItems.length ||
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
}

function validatePublishedArtifact(
  input: RegisterPublishedArtifactInput,
): void {
  requireCanonicalId(input.packId);
  assertArtifact(input.artifact);
  const expectedArea =
    input.artifact.kind === 'original'
      ? 'originals'
      : input.artifact.kind === 'preview'
      ? 'previews'
      : input.artifact.kind === 'export'
      ? 'exports'
      : 'derived';
  if (
    ownedArtifactPackId(input.artifact.relativePath) !== input.packId ||
    ownedArtifactId(input.artifact.relativePath) !== input.artifact.id ||
    input.artifact.relativePath.split('/')[2] !== expectedArea ||
    (input.artifact.kind === 'original' &&
      (input.artifact.itemId === undefined ||
        input.artifact.id !== input.artifact.itemId ||
        input.artifact.relativePath !==
          ownedOriginalPath(input.packId, input.artifact.itemId)))
  )
    throw new DomainError('SCHEMA_INVALID');
}

function assertPersistedArtifactPathKind(
  artifact: PersistedArtifactRecord,
): void {
  const packId = ownedArtifactPackId(artifact.relativePath);
  const expectedArea =
    artifact.kind === 'original'
      ? 'originals'
      : artifact.kind === 'preview'
      ? 'previews'
      : artifact.kind === 'export'
      ? 'exports'
      : 'derived';
  if (
    packId === null ||
    artifact.relativePath.split('/')[2] !== expectedArea ||
    ownedArtifactId(artifact.relativePath) !== artifact.id ||
    (artifact.kind === 'original' &&
      (artifact.itemId === undefined ||
        artifact.id !== artifact.itemId ||
        artifact.relativePath !== ownedOriginalPath(packId, artifact.itemId)))
  )
    throw new DomainError('SCHEMA_INVALID');
}

function persistedArtifactEquals(
  row: ArtifactRow,
  artifact: Artifact,
): boolean {
  return (
    row.id === artifact.id &&
    (row.item_id ?? undefined) === artifact.itemId &&
    row.relative_path === artifact.relativePath &&
    row.media_type === artifact.mediaType &&
    row.byte_count === artifact.byteCount &&
    row.sha256 === artifact.sha256 &&
    row.kind === artifact.kind &&
    row.processor_version_json ===
      encodeProcessorVersion(artifact.processorVersion) &&
    row.created_at === artifact.createdAt
  );
}

function validateRecoveryEntry(entry: RecoveryJournalEntry): void {
  requireCanonicalId(entry.ingestionId);
  requireCanonicalId(entry.packId);
  recoveryPhase(entry.phase);
  requireIsoDateTime(entry.updatedAt);
  if (entry.errorCode !== undefined) domainErrorCode(entry.errorCode);
}

function validateDiagnostic(input: RecoveryDiagnosticInput): void {
  requireCanonicalId(input.id);
  if (
    !isCanonicalUuid(input.anonymousId) &&
    !/^[0-9a-f]{64}$/.test(input.anonymousId)
  )
    throw new DomainError('SCHEMA_INVALID');
  diagnosticScope(input.scope);
  domainErrorCode(input.code);
  if (!/^[a-z0-9-]{1,64}$/.test(input.phase))
    throw new DomainError('SCHEMA_INVALID');
  requireIsoDateTime(input.occurredAt);
  if (
    input.byteCount !== undefined &&
    (!Number.isSafeInteger(input.byteCount) || input.byteCount < 0)
  )
    throw new DomainError('SCHEMA_INVALID');
}

function validateQuarantineRecord(input: QuarantineRecordInput): void {
  requireCanonicalId(input.id);
  requireCanonicalId(input.anonymousId);
  domainErrorCode(input.reasonCode);
  if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 0)
    throw new DomainError('SCHEMA_INVALID');
  requireIsoDateTime(input.createdAt);
  requireIsoDateTime(input.purgeAfter);
  if (Date.parse(input.purgeAfter) <= Date.parse(input.createdAt))
    throw new DomainError('SCHEMA_INVALID');
}

function packSqlValues(pack: ContextPack): readonly SqlValue[] {
  return [
    pack.id,
    pack.createdAt,
    pack.schemaVersion,
    pack.title,
    pack.userInstruction,
    pack.updatedAt,
    pack.state,
    encodeBudget(pack.budget),
    pack.estimatedTokens,
    encodeStringArray(pack.warningCodes),
  ];
}

function decodeRiskFindingRow(row: RiskFindingRow): RiskFinding {
  return decodePersisted(() => {
    const value: RiskFinding = {
      id: row.id,
      itemId: row.item_id,
      detectorVersion: decodeProcessorVersion(row.detector_version_json),
      category: riskCategory(row.category),
      severity: riskSeverity(row.severity),
      confidence: row.confidence,
      location: decodeFindingLocation(row.location_json),
      createdAt: row.created_at,
    };
    assertRiskFinding(value);
    return value;
  });
}

function decodeExportRecordRow(
  row: ExportRecordRow,
  artifactIds: readonly string[],
): ExportRecord {
  return decodePersisted(() => {
    const value: ExportRecord = {
      id: row.id,
      packId: row.pack_id,
      format: exportFormat(row.format),
      createdAt: row.created_at,
      preset: budgetPreset(row.preset),
      status: exportStatus(row.status),
      ...(row.manifest_sha256 ? { manifestSha256: row.manifest_sha256 } : {}),
      artifactIds,
      ...(row.error_code ? { errorCode: domainErrorCode(row.error_code) } : {}),
    };
    assertExportRecord(value);
    return value;
  });
}

function decodePersisted<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === 'SCHEMA_VERSION_UNSUPPORTED'
    )
      throw error;
    throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  }
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every(value => right.includes(value))
  );
}

function sourceTypeForMediaType(mediaType: string): ContextItem['sourceType'] {
  const normalized = mediaType.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized === 'text/uri-list') return 'url';
  return 'text';
}

function requireCanonicalId(value: string): void {
  if (!isCanonicalUuid(value)) throw new DomainError('SCHEMA_INVALID');
}

function requireIsoDateTime(value: string): void {
  if (!isIsoDateTime(value)) throw new DomainError('SCHEMA_INVALID');
}

function requireSchemaVersionOne(value: number): 1 {
  if (value !== 1) throw new DomainError('SCHEMA_VERSION_UNSUPPORTED');
  return 1;
}

function importStatus(value: string): PersistedImportSummary['status'] {
  if (value === 'complete' || value === 'partial' || value === 'failed')
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function importItemStatus(
  value: string,
): ImportManifestV1['items'][number]['status'] {
  if (value === 'copied' || value === 'failed') return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function recoveryPhase(value: string): RecoveryJournalEntry['phase'] {
  if (
    value === 'discovered' ||
    value === 'handoff-started' ||
    value === 'files-published' ||
    value === 'database-committed' ||
    value === 'quarantined'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function packState(value: string): ContextPack['state'] {
  switch (value) {
    case 'draft':
    case 'processing':
    case 'review-required':
    case 'ready':
    case 'exporting':
    case 'exported':
    case 'recovering':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  }
}

function itemState(value: string): ContextItem['state'] {
  switch (value) {
    case 'received':
    case 'imported':
    case 'extracted':
    case 'analyzed':
    case 'review-required':
    case 'reviewed':
    case 'packaged':
    case 'recovering':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  }
}

function contextItemSource(value: string): ContextItem['sourceType'] {
  if (
    value === 'image' ||
    value === 'pdf' ||
    value === 'text' ||
    value === 'url'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function inclusionMode(value: string): ContextItem['inclusionMode'] {
  if (
    value === 'original' ||
    value === 'extracted' ||
    value === 'both' ||
    value === 'excluded'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function riskCategory(value: string): RiskFinding['category'] {
  switch (value) {
    case 'api-key':
    case 'bearer-token':
    case 'jwt':
    case 'private-key':
    case 'url-credential':
    case 'email':
    case 'phone':
    case 'ip-address':
    case 'payment-card':
      return value;
    default:
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  }
}

function riskSeverity(value: string): RiskFinding['severity'] {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function exportFormat(value: string): ExportRecord['format'] {
  if (
    value === 'markdown' ||
    value === 'pdf' ||
    value === 'attachment-bundle' ||
    value === 'clipboard'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function exportStatus(value: string): ExportRecord['status'] {
  if (
    value === 'running' ||
    value === 'complete' ||
    value === 'failed' ||
    value === 'cancelled'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function budgetPreset(value: string): ExportRecord['preset'] {
  if (
    value === 'quality' ||
    value === 'balanced' ||
    value === 'compact' ||
    value === 'custom'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function artifactKind(value: string): PersistedArtifactRecord['kind'] {
  switch (value) {
    case 'original':
    case 'ocr-text':
    case 'pdf-page-text':
    case 'compressed-image':
    case 'redacted-image':
    case 'preview':
    case 'export':
      return value;
    default:
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  }
}

function domainErrorCode(value: string): DomainErrorCode {
  if (isDomainErrorCode(value)) return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}

function diagnosticScope(value: string): RecoveryDiagnostic['scope'] {
  if (
    value === 'migration' ||
    value === 'inbox' ||
    value === 'artifact' ||
    value === 'cleanup'
  )
    return value;
  throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
}
