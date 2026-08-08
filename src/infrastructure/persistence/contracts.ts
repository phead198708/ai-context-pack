import type { ImportManifestV1 } from '../../domain/contracts';
import type { DomainErrorCode } from '../../domain/errors';
import type {
  Artifact,
  ContextItem,
  ContextPack,
  ExportRecord,
  RiskFinding,
} from '../../domain/models';
import type { NativeHandoffResult } from '../../domain/nativeAdapter';

export const PERSISTENCE_SCHEMA_VERSION = 3 as const;
export const DEVELOPMENT_RESET_CONFIRMATION =
  'RESET_AI_CONTEXT_PACK_DEVELOPMENT_DATA' as const;

export type PersistenceRecoveryPhase =
  | 'discovered'
  | 'handoff-started'
  | 'files-published'
  | 'database-committed'
  | 'quarantined';

export interface PersistedArtifactInput {
  readonly id: string;
  readonly itemId: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly sha256: string;
}

export interface CommitImportInput {
  readonly packId: string;
  readonly manifest: ImportManifestV1;
  /** SHA-256 of the exact, validated manifest bytes. */
  readonly manifestFingerprint: string;
  readonly artifacts: readonly PersistedArtifactInput[];
}

export interface PersistedImportSummary {
  readonly ingestionId: string;
  readonly packId: string;
  readonly manifestFingerprint: string;
  readonly status: ImportManifestV1['status'];
  readonly itemCount: number;
  readonly artifactCount: number;
}

export interface PersistedImportItemSummary {
  readonly id: string;
  readonly order: number;
  readonly mediaType: string;
  readonly status: ImportManifestV1['items'][number]['status'];
  readonly errorCode?: DomainErrorCode;
}

export interface PersistedImportDetail extends PersistedImportSummary {
  readonly createdAt: string;
  readonly items: readonly PersistedImportItemSummary[];
}

export interface RecoveryJournalEntry {
  readonly ingestionId: string;
  readonly packId: string;
  readonly phase: PersistenceRecoveryPhase;
  readonly updatedAt: string;
  readonly errorCode?: DomainErrorCode;
}

export interface CleanupCandidate {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly createdAt: string;
}

export interface PersistedPackGraph {
  readonly pack: ContextPack;
  readonly items: readonly ContextItem[];
  /** Monotonic optimistic-concurrency token; it is not user-visible. */
  readonly revision: number;
}

export interface SavePackGraphInput {
  readonly pack: ContextPack;
  readonly items: readonly ContextItem[];
  /** Omit only when creating a Pack; updates must supply the loaded revision. */
  readonly expectedRevision?: number;
}

export interface DeletePackResult {
  readonly removedItemCount: number;
  readonly releasedArtifactCount: number;
}

export interface PersistedArtifactRecord extends Artifact {
  readonly lastVerifiedAt?: string;
}

export interface RegisterPublishedArtifactInput {
  readonly packId: string;
  /** The native file store has already verified these immutable bytes. */
  readonly artifact: Artifact;
}

export interface StorageUsageSummary {
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly referencedArtifactCount: number;
  readonly referencedArtifactBytes: number;
  readonly recoveryCount: number;
  readonly quarantineCount: number;
  readonly quarantineBytes: number;
}

export type RecoveryDiagnosticScope =
  | 'migration'
  | 'inbox'
  | 'artifact'
  | 'cleanup';

export interface RecoveryDiagnosticInput {
  readonly id: string;
  readonly scope: RecoveryDiagnosticScope;
  /** Irreversible internal UUID or SHA-256 only; never a path or filename. */
  readonly anonymousId: string;
  readonly code: DomainErrorCode;
  readonly phase: string;
  readonly occurredAt: string;
  readonly byteCount?: number;
}

export interface RecoveryDiagnostic extends RecoveryDiagnosticInput {
  readonly occurrenceCount: number;
  readonly lastOccurredAt: string;
}

export interface ContextPackRepository {
  findPackGraph(packId: string): Promise<PersistedPackGraph | null>;
  listPackGraphs(): Promise<readonly PersistedPackGraph[]>;
  savePackGraph(input: SavePackGraphInput): Promise<number>;
  deletePack(
    packId: string,
    expectedRevision: number,
  ): Promise<DeletePackResult>;
}

export interface ContextItemRepository {
  listItemsForPack(packId: string): Promise<readonly ContextItem[]>;
}

export interface RiskFindingRepository {
  saveRiskFinding(finding: RiskFinding): Promise<void>;
  listRiskFindingsForItem(itemId: string): Promise<readonly RiskFinding[]>;
}

export interface ExportRecordRepository {
  saveExportRecord(record: ExportRecord): Promise<void>;
  listExportRecordsForPack(packId: string): Promise<readonly ExportRecord[]>;
}

export interface ArtifactRecordRepository {
  registerPublishedArtifact(
    input: RegisterPublishedArtifactInput,
  ): Promise<'created' | 'replayed'>;
  listArtifactRecords(): Promise<readonly PersistedArtifactRecord[]>;
  markArtifactVerified(artifactId: string, verifiedAt: string): Promise<void>;
}

export interface QuarantineRecordInput {
  readonly id: string;
  /** Irreversible internal artifact UUID only; never a path or filename. */
  readonly anonymousId: string;
  readonly reasonCode: DomainErrorCode;
  readonly byteCount: number;
  readonly createdAt: string;
  readonly purgeAfter: string;
}

export interface QuarantineRepository {
  recordQuarantine(input: QuarantineRecordInput): Promise<void>;
  /** Marks records quarantined at or before the native mtime cutoff. */
  markQuarantinePurgedBefore(
    quarantinedBefore: string,
    purgedAt: string,
  ): Promise<number>;
}

export interface RecoveryDiagnosticsRepository {
  recordRecoveryDiagnostic(input: RecoveryDiagnosticInput): Promise<void>;
  listRecoveryDiagnostics(): Promise<readonly RecoveryDiagnostic[]>;
  getStorageUsage(): Promise<StorageUsageSummary>;
}

export interface CleanupLeaseRepository {
  acquireCleanupLease(
    ownerId: string,
    acquiredAt: string,
    expiresAt: string,
  ): Promise<boolean>;
  releaseCleanupLease(ownerId: string): Promise<void>;
}

export interface DevelopmentResetRepository {
  resetForDevelopment(
    confirmation: typeof DEVELOPMENT_RESET_CONFIRMATION,
  ): Promise<void>;
}

export interface PersistenceRepository {
  initialize(): Promise<void>;
  findImport(ingestionId: string): Promise<PersistedImportSummary | null>;
  listImportDetails(): Promise<readonly PersistedImportDetail[]>;
  commitImport(input: CommitImportInput): Promise<'created' | 'replayed'>;
  recordRecovery(entry: RecoveryJournalEntry): Promise<void>;
  findRecovery(ingestionId: string): Promise<RecoveryJournalEntry | null>;
  listReferencedRelativePaths(): Promise<ReadonlySet<string>>;
  listKnownRelativePaths(): Promise<ReadonlySet<string>>;
  listRecoveringPackIds(): Promise<ReadonlySet<string>>;
  listCleanupCandidates(
    olderThan: string,
  ): Promise<readonly CleanupCandidate[]>;
  deleteArtifactRecordIfUnreferenced(artifactId: string): Promise<boolean>;
}

export interface ProductionPersistenceRepository
  extends PersistenceRepository,
    ContextPackRepository,
    ContextItemRepository,
    RiskFindingRepository,
    ExportRecordRepository,
    ArtifactRecordRepository,
    RecoveryDiagnosticsRepository,
    QuarantineRepository,
    CleanupLeaseRepository,
    DevelopmentResetRepository {}

export interface NativeInboxHandoff {
  handoffInbox(
    ingestionId: string,
    packId: string,
    requiredHeadroomBytes: number,
  ): Promise<NativeHandoffResult>;
  acknowledgeInbox(ingestionId: string): Promise<void>;
}

export interface OwnedArtifactFileStore {
  listOwnedFiles(): Promise<readonly OwnedArtifactFile[]>;
  removeOwnedFile(relativePath: string): Promise<void>;
  quarantineOwnedFile(
    relativePath: string,
  ): Promise<QuarantinedArtifactFile | null>;
  purgeQuarantine(olderThanEpochMs: number): Promise<QuarantinePurgeResult>;
}

export interface OwnedArtifactFile {
  readonly relativePath: string;
  readonly byteCount: number;
}

export interface QuarantinedArtifactFile {
  readonly quarantineId: string;
  readonly anonymousId: string;
  readonly byteCount: number;
}

export interface QuarantinePurgeResult {
  readonly purgedCount: number;
  readonly purgedBytes: number;
}

export interface PublishArtifactInput {
  readonly sourceFileUri: string;
  readonly relativePath: string;
  readonly expectedByteCount?: number;
  readonly expectedSha256?: string;
}

export interface PublishedArtifactFile {
  readonly relativePath: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly created: boolean;
}

export interface ArtifactFileVerification {
  readonly relativePath: string;
  readonly status: 'verified' | 'missing' | 'mismatch';
  readonly byteCount?: number;
  readonly sha256?: string;
}

export interface ArtifactFileUsage {
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly quarantineCount: number;
  readonly quarantineBytes: number;
}

export interface AtomicArtifactFileStore extends OwnedArtifactFileStore {
  publishArtifact(input: PublishArtifactInput): Promise<PublishedArtifactFile>;
  verifyArtifact(
    relativePath: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<ArtifactFileVerification>;
  getStorageUsage(): Promise<ArtifactFileUsage>;
}

export interface PersistenceMigrationEvent {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly phase: 'starting' | 'applied';
}

export type PersistenceMigrationHook = (
  event: PersistenceMigrationEvent,
) => void | Promise<void>;
