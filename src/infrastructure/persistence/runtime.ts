import type { ImportManifestV1 } from '../../domain/contracts';
import { DomainError } from '../../domain/errors';
import type {
  InboxManifestProcessor,
  InboxPackSummary,
} from '../../domain/inboxEventWorkflow';
import type { NativeAdapter } from '../../domain/nativeAdapter';
import { nativeAdapter } from '../nativeAdapter';
import {
  ArtifactIntegrityAuditor,
  NativeAtomicArtifactFileStore,
} from './artifactStore';
import type { ProductionPersistenceRepository } from './contracts';
import {
  InboxPersistenceCoordinator,
  ScheduledReferenceAwareCleanup,
} from './recovery';
import { openPersistenceRepository } from './sqlite';

export class ProductionInboxManifestProcessor
  implements InboxManifestProcessor
{
  private chain = Promise.resolve();
  private readonly cleanupOwnerId = createInternalUuid();
  private integrityAuditComplete = false;

  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository> = productionRepository,
    private readonly native: NativeAdapter = nativeAdapter,
  ) {}

  process(manifests: readonly ImportManifestV1[]): Promise<void> {
    const work = this.chain.then(
      () => this.processSerially(manifests),
      () => this.processSerially(manifests),
    );
    this.chain = work.catch(() => undefined);
    return work;
  }

  async listPersistedPacks(): Promise<readonly InboxPackSummary[]> {
    const repository = await this.getRepository();
    const graphs = await repository.listPackGraphs();
    return graphs.map(({ pack, items }) => ({
      id: pack.id,
      schemaVersion: pack.schemaVersion,
      title: pack.title,
      createdAt: pack.createdAt,
      updatedAt: pack.updatedAt,
      state: pack.state,
      itemCount: items.length,
    }));
  }

  private async processSerially(
    manifests: readonly ImportManifestV1[],
  ): Promise<void> {
    const repository = await this.getRepository();
    const files = new NativeAtomicArtifactFileStore(this.native);
    const coordinator = new InboxPersistenceCoordinator(
      repository,
      this.native,
      undefined,
      undefined,
      repository,
    );
    const ordered = [...manifests].sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.ingestionId.localeCompare(right.ingestionId),
    );
    for (const manifest of ordered) {
      const recovery = await repository.findRecovery(manifest.ingestionId);
      const existing = await repository.findImport(manifest.ingestionId);
      await coordinator.recover({
        ingestionId: manifest.ingestionId,
        // A share creates one Pack in Issue #7. Replays recover the persisted
        // mapping; using the ingestion UUID initially avoids a second durable
        // identity allocation before the manifest-bound handoff transaction.
        packId: recovery?.packId ?? existing?.packId ?? manifest.ingestionId,
      });
    }
    if (!this.integrityAuditComplete) {
      const audit = await new ArtifactIntegrityAuditor(repository, files).run();
      if (audit.issues.length > 0)
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      this.integrityAuditComplete = true;
    }
    await new ScheduledReferenceAwareCleanup(
      repository,
      files,
      this.cleanupOwnerId,
    ).run();
  }
}

let repositoryPromise: Promise<ProductionPersistenceRepository> | undefined;

export function productionRepository(): Promise<ProductionPersistenceRepository> {
  if (!repositoryPromise) {
    const opening = openPersistenceRepository();
    repositoryPromise = opening;
    opening.catch(() => {
      if (repositoryPromise === opening) repositoryPromise = undefined;
    });
  }
  return repositoryPromise;
}

export const persistenceInboxProcessor: InboxManifestProcessor =
  new ProductionInboxManifestProcessor();

function createInternalUuid(): string {
  const values = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
  values[12] = '4';
  values[16] = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${values.slice(0, 8).join('')}-${values
    .slice(8, 12)
    .join('')}-${values.slice(12, 16).join('')}-${values
    .slice(16, 20)
    .join('')}-${values.slice(20).join('')}`;
}
