import type { ImportManifestV1 } from '../../domain/contracts';
import type { DomainErrorCode } from '../../domain/errors';
import type { NativeHandoffResult } from '../../domain/nativeAdapter';

export const PERSISTENCE_SCHEMA_VERSION = 2 as const;

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

export interface PersistenceRepository {
  initialize(): Promise<void>;
  findImport(ingestionId: string): Promise<PersistedImportSummary | null>;
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

export interface NativeInboxHandoff {
  handoffInbox(
    ingestionId: string,
    packId: string,
    requiredHeadroomBytes: number,
  ): Promise<NativeHandoffResult>;
  acknowledgeInbox(ingestionId: string): Promise<void>;
}

export interface OwnedArtifactFileStore {
  listOwnedFiles(): Promise<readonly string[]>;
  removeOwnedFile(relativePath: string): Promise<void>;
  quarantineOwnedFile(relativePath: string): Promise<void>;
}
