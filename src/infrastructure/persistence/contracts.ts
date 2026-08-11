import type { ImportManifestV1 } from '../../domain/contracts';
import type { DomainErrorCode } from '../../domain/errors';
import type {
  Artifact,
  ContextItem,
  ContextPack,
  ExportRecord,
  PipelineStage,
  RiskFinding,
} from '../../domain/models';
import type { NativeHandoffResult } from '../../domain/nativeAdapter';

export const PERSISTENCE_SCHEMA_VERSION = 6 as const;
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
  /** True only after an explicit destructive local-original release. */
  readonly originalReleased?: true;
  readonly retrySource?: {
    readonly relativePath: string;
    readonly byteCount: number;
    readonly sha256: string;
  };
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
  /**
   * Removing an item normally retains its immutable original as a detached local-library
   * artifact. Destructive release is opt-in and must be guarded by explicit UI confirmation.
   */
  readonly removedItemOriginalDisposition?: 'preserve' | 'release';
  /** Runs inserted in the same transaction as the restored item checkpoints. */
  readonly startedPipelineRuns?: readonly StartPipelineRunInput[];
  /** Cancels active runs atomically with the Pack cancellation transition. */
  readonly cancelActivePipelineRuns?: true;
}

export interface StartPipelineRunInput {
  readonly id: string;
  readonly packId: string;
  readonly itemId: string;
  readonly stage: PipelineStage;
  readonly startedAt: string;
}

export interface PersistedPipelineRun extends StartPipelineRunInput {
  readonly status: 'queued' | 'running' | 'recovering';
  readonly updatedAt: string;
  /** Monotonic claim token; only its current owner may settle the run. */
  readonly claimVersion: number;
  /**
   * Immutable derivative published by this run but not yet registered in the
   * Pack graph. Recovery must verify and settle this exact descriptor instead
   * of rerunning extraction.
   */
  readonly publishedArtifact?: Artifact;
}

export interface CheckpointPipelineRunArtifactInput {
  readonly runId: string;
  readonly claimVersion: number;
  readonly updatedAt: string;
  readonly artifact: Artifact;
}

export interface CompletePipelineRunInput {
  readonly runId: string;
  readonly claimVersion: number;
  readonly updatedAt: string;
  readonly artifact?: Artifact;
}

export interface FailPipelineRunInput {
  readonly runId: string;
  readonly claimVersion: number;
  readonly updatedAt: string;
  readonly errorCode: DomainErrorCode;
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
  | 'cleanup'
  | 'pipeline';

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
  startPipelineRun(input: StartPipelineRunInput): Promise<void>;
  listRunnablePipelineRuns(
    staleRunningBefore?: string,
  ): Promise<readonly PersistedPipelineRun[]>;
  markPipelineRunRunning(
    runId: string,
    expectedClaimVersion: number,
    updatedAt: string,
    staleRunningBefore: string,
  ): Promise<number | null>;
  renewPipelineRunClaim(
    runId: string,
    claimVersion: number,
    updatedAt: string,
  ): Promise<boolean>;
  checkpointPipelineRunArtifact(
    input: CheckpointPipelineRunArtifactInput,
  ): Promise<boolean>;
  completePipelineRun(input: CompletePipelineRunInput): Promise<boolean>;
  failPipelineRun(input: FailPipelineRunInput): Promise<boolean>;
  cancelPipelineRuns(packId: string, updatedAt: string): Promise<number>;
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
  acquireCleanupLeaseForPipelineRun(
    runId: string,
    claimVersion: number,
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
