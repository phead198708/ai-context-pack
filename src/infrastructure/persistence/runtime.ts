import type { ImportManifestV1 } from '../../domain/contracts';
import { createCanonicalUuid } from '../../domain/canonicalUuid';
import { BUDGET_PRESETS } from '../../domain/budgetOptimization';
import { DomainError } from '../../domain/errors';
import type { ContextPack } from '../../domain/models';
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
  private readonly cleanupOwnerId = createCanonicalUuid();
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
    // Expo SQLite exposes one connection; keep snapshot reads serialized instead of starting
    // overlapping exclusive transactions on that connection.
    const graphs = await repository.listPackGraphs();
    const imports = await repository.listImportDetails();
    const importsByPack = new Map<string, (typeof imports)[number]>();
    // listImportDetails is newest-first. Preserve the newest durable result if future
    // workflows append more than one import to a Pack.
    for (const value of imports)
      if (!importsByPack.has(value.packId))
        importsByPack.set(value.packId, value);
    return graphs.map(({ pack, items }) => {
      const imported = importsByPack.get(pack.id);
      return {
        id: pack.id,
        schemaVersion: pack.schemaVersion,
        title: pack.title,
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
        state: pack.state,
        itemCount: items.length,
        ...(imported
          ? {
              import: {
                ingestionId: imported.ingestionId,
                status: imported.status,
                items: imported.items,
              },
            }
          : {}),
      };
    });
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

export async function createEmptyDraftPack(
  now: () => Date = () => new Date(),
  createId: () => string = createCanonicalUuid,
  getRepository: () => Promise<ProductionPersistenceRepository> = productionRepository,
): Promise<InboxPackSummary> {
  const id = createId();
  const timestamp = now().toISOString();
  const pack: ContextPack = {
    id,
    schemaVersion: 1,
    title: 'Context Pack',
    userInstruction: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    state: 'draft',
    budget: { ...BUDGET_PRESETS.balanced },
    estimatedTokens: 0,
    orderedItemIds: [],
    exportRecordIds: [],
    warningCodes: [],
  };
  const repository = await getRepository();
  await repository.savePackGraph({ pack, items: [] });
  return {
    id,
    schemaVersion: 1,
    title: pack.title,
    createdAt: timestamp,
    updatedAt: timestamp,
    state: 'draft',
    itemCount: 0,
  };
}
