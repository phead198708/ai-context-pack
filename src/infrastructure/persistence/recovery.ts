import { DomainError } from '../../domain/errors';
import { isCanonicalUuid } from '../../domain/canonicalUuid';
import type {
  NativeInboxHandoff,
  OwnedArtifactFileStore,
  PersistenceRepository,
} from './contracts';
import {
  assertOwnedArtifactPath,
  ownedArtifactPackId,
  ownedOriginalPath,
} from './ownedPaths';

const DISK_HEADROOM_BYTES = 16 * 1024 * 1024;

export type PersistenceInterruptionPoint =
  | 'before-copy'
  | 'during-copy'
  | 'after-file-close'
  | 'before-manifest-rename'
  | 'before-db-commit';

export interface RecoveryImportRequest {
  readonly packId: string;
  readonly ingestionId: string;
}

export class InboxPersistenceCoordinator {
  constructor(
    private readonly repository: PersistenceRepository,
    private readonly nativeHandoff: NativeInboxHandoff,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly interruptionHook: (
      point: PersistenceInterruptionPoint,
    ) => Promise<void> = async () => undefined,
  ) {}

  async recover(
    request: RecoveryImportRequest,
  ): Promise<'created' | 'replayed'> {
    requireIdentifier(request.packId);
    requireIdentifier(request.ingestionId);
    await this.repository.initialize();
    await this.repository.recordRecovery({
      ingestionId: request.ingestionId,
      packId: request.packId,
      phase: 'discovered',
      updatedAt: this.now(),
    });
    await this.interruptionHook('before-copy');
    await this.repository.recordRecovery({
      ingestionId: request.ingestionId,
      packId: request.packId,
      phase: 'handoff-started',
      updatedAt: this.now(),
    });
    const handoff = await this.nativeHandoff.handoffInbox(
      request.ingestionId,
      request.packId,
      DISK_HEADROOM_BYTES,
    );
    requireFingerprint(handoff.manifestFingerprint);
    if (handoff.manifest.ingestionId !== request.ingestionId)
      throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
    const { artifacts } = handoff;
    artifacts.forEach(artifact =>
      assertOwnedArtifactPath(artifact.relativePath),
    );
    const copiedItems = handoff.manifest.items.filter(
      item => item.status === 'copied',
    );
    const artifactIds = new Set(artifacts.map(artifact => artifact.itemId));
    if (
      artifacts.length !== copiedItems.length ||
      artifactIds.size !== artifacts.length ||
      artifacts.some(
        artifact =>
          artifact.relativePath !==
            ownedOriginalPath(request.packId, artifact.itemId) ||
          !copiedItems.some(
            item =>
              item.id === artifact.itemId &&
              item.byteCount === artifact.byteCount &&
              item.mediaType === artifact.mediaType &&
              (item.sha256 === undefined || item.sha256 === artifact.sha256),
          ),
      ) ||
      copiedItems.some(item => !artifactIds.has(item.id))
    )
      throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
    await this.repository.recordRecovery({
      ingestionId: request.ingestionId,
      packId: request.packId,
      phase: 'files-published',
      updatedAt: this.now(),
    });
    await this.interruptionHook('before-db-commit');
    const result = await this.repository.commitImport({
      packId: request.packId,
      manifest: handoff.manifest,
      manifestFingerprint: handoff.manifestFingerprint,
      artifacts,
    });
    await this.nativeHandoff.acknowledgeInbox(request.ingestionId);
    return result;
  }
}

export class ReferenceAwareCleanup {
  constructor(
    private readonly repository: PersistenceRepository,
    private readonly files: OwnedArtifactFileStore,
  ) {}

  async run(olderThan: string): Promise<{
    readonly deleted: number;
    readonly quarantined: number;
  }> {
    const references = await this.repository.listReferencedRelativePaths();
    const candidates = await this.repository.listCleanupCandidates(olderThan);
    let deleted = 0;
    for (const candidate of candidates) {
      if (references.has(candidate.relativePath)) continue;
      const removed = await this.repository.deleteArtifactRecordIfUnreferenced(
        candidate.artifactId,
      );
      if (!removed) continue;
      await this.files.removeOwnedFile(candidate.relativePath);
      deleted += 1;
    }
    // Snapshot files first. Recovery records its journal before it can publish
    // a new file, so the later database snapshot cannot miss a listed file
    // that belongs to an active recovery.
    const ownedFiles = await this.files.listOwnedFiles();
    const [known, recoveringPackIds] = await Promise.all([
      this.repository.listKnownRelativePaths(),
      this.repository.listRecoveringPackIds(),
    ]);
    let quarantined = 0;
    for (const path of ownedFiles) {
      if (known.has(path)) continue;
      const filePackId = ownedArtifactPackId(path);
      if (filePackId && recoveringPackIds.has(filePackId)) continue;
      await this.files.quarantineOwnedFile(path);
      quarantined += 1;
    }
    return { deleted, quarantined };
  }
}

function requireIdentifier(value: string): void {
  if (!isCanonicalUuid(value)) throw new DomainError('SCHEMA_INVALID');
}

function requireFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new DomainError('SCHEMA_INVALID');
}
