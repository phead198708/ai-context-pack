import {
  completeBudgetOptimizationResultV1,
  createBudgetOptimizationPlanV1,
  type BudgetOptimizationItemResultV1,
  type BudgetOptimizationPlanV1,
  type BudgetOptimizationResultV1,
  type BudgetSourceItemV1,
} from '../../domain/budgetOptimization';
import { createCanonicalUuid } from '../../domain/canonicalUuid';
import { DomainError } from '../../domain/errors';
import type { Artifact, Budget } from '../../domain/models';
import type { NativeAdapter } from '../../domain/nativeAdapter';
import {
  NativeAtomicArtifactFileStore,
  PublishedArtifactCoordinator,
} from '../../infrastructure/persistence/artifactStore';
import type { ProductionPersistenceRepository } from '../../infrastructure/persistence/contracts';
import { ownedDerivedPath } from '../../infrastructure/persistence/ownedPaths';

export interface BudgetOptimizationApplyOptions {
  readonly signal?: AbortSignal;
}

export class PackBudgetOptimizationService {
  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly native: NativeAdapter,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = createCanonicalUuid,
  ) {}

  async preview(
    packId: string,
    budget: Budget,
    excludedItemIds: readonly string[] = [],
  ): Promise<BudgetOptimizationPlanV1> {
    const repository = await this.getRepository();
    const graph = await repository.findPackGraph(packId);
    if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
    const [artifacts, duplicateAnalysis] = await Promise.all([
      repository.listArtifactRecords(),
      repository.findDuplicateAnalysis(packId),
    ]);
    const exclusions = new Set(excludedItemIds);
    if (
      exclusions.size !== excludedItemIds.length ||
      excludedItemIds.some(
        excludedId => !graph.items.some(item => item.id === excludedId),
      )
    )
      throw new DomainError('SCHEMA_INVALID');
    const analyses = new Map(
      duplicateAnalysis.analyses.map(analysis => [analysis.itemId, analysis]),
    );
    const originalByItem = new Map(
      artifacts
        .filter(
          (
            artifact,
          ): artifact is typeof artifact & { readonly itemId: string } =>
            artifact.kind === 'original' && artifact.itemId !== undefined,
        )
        .map(artifact => [artifact.itemId, artifact]),
    );
    const items: BudgetSourceItemV1[] = [];
    for (const item of graph.items) {
      const included =
        item.inclusionMode !== 'excluded' && !exclusions.has(item.id);
      const includesOriginal =
        included && ['original', 'both'].includes(item.inclusionMode);
      const includesExtracted =
        included && ['extracted', 'both'].includes(item.inclusionMode);
      const original = originalByItem.get(item.id);
      if (included && !original)
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      const analysis = analyses.get(item.id);
      let pdfPageCount = 0;
      if (includesOriginal && item.sourceType === 'pdf' && original) {
        const taskId = this.createId();
        const fileUri = await this.native.resolveOwnedArtifactFileUri(
          original.relativePath,
        );
        try {
          const document = await this.native.inspectPdf({
            taskId,
            fileUri,
            sourceSha256: original.sha256,
          });
          pdfPageCount = document.pageCount;
        } finally {
          // Cleanup is part of the native contract. Surfacing its failure avoids
          // silently retaining a temporary document after a successful probe.
          await this.native.finishPdfExtraction(taskId);
        }
      }
      let image: BudgetSourceItemV1['image'];
      if (includesOriginal && item.sourceType === 'image' && original) {
        if (!this.native.inspectImageForCompression)
          throw new DomainError('DOMAIN_INVALID_TRANSITION');
        const taskId = this.createId();
        image = await this.native.inspectImageForCompression(
          taskId,
          await this.native.resolveOwnedArtifactFileUri(original.relativePath),
          original.byteCount,
          original.sha256,
        );
      }
      items.push({
        itemId: item.id,
        sourceType: item.sourceType,
        included,
        includeOriginal: includesOriginal,
        includeExtracted: includesExtracted,
        sourceByteCount: original?.byteCount ?? 0,
        textCharacterCount: includesExtracted
          ? analysis?.normalizedCharacterCount ?? 0
          : 0,
        textUtf8ByteCount: includesExtracted
          ? analysis?.normalizedByteCount ?? 0
          : 0,
        pdfPageCount,
        ...(image ? { image } : {}),
      });
    }
    return createBudgetOptimizationPlanV1({
      planId: this.createId(),
      packId,
      packRevision: graph.revision,
      createdAt: validTimestamp(this.now(), graph.pack.updatedAt),
      budget,
      items,
      createArtifactId: () => this.createId(),
    });
  }

  async apply(
    plan: BudgetOptimizationPlanV1,
    options: BudgetOptimizationApplyOptions = {},
  ): Promise<BudgetOptimizationResultV1> {
    const repository = await this.getRepository();
    const graph = await repository.findPackGraph(plan.packId);
    if (!graph || graph.revision !== plan.packRevision)
      throw new DomainError('PERSISTENCE_CONFLICT');
    const artifacts = await repository.listArtifactRecords();
    const originals = new Map(
      artifacts
        .filter(
          (
            artifact,
          ): artifact is typeof artifact & { readonly itemId: string } =>
            artifact.kind === 'original' && artifact.itemId !== undefined,
        )
        .map(artifact => [artifact.itemId, artifact]),
    );
    const coordinator = new PublishedArtifactCoordinator(
      repository,
      new NativeAtomicArtifactFileStore(this.native),
      this.now,
    );
    const results: BudgetOptimizationItemResultV1[] = [];
    let activeTaskId: string | undefined;
    let cancellation: Promise<void> | undefined;
    const abort = (): void => {
      if (activeTaskId && this.native.cancelImageCompression) {
        const requested = this.native.cancelImageCompression(activeTaskId);
        cancellation = requested;
        // Observe immediately so a native bridge rejection cannot become an
        // unhandled promise while the encoder is still settling. Awaiting the
        // original promise below preserves its rejection for the caller.
        requested.catch(() => undefined);
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      for (const action of plan.actions) {
        if (options.signal?.aborted)
          throw new DomainError('PIPELINE_STAGE_FAILED');
        const original = originals.get(action.itemId);
        if (!original) throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
        if (action.kind === 'keep') {
          results.push({
            itemId: action.itemId,
            action: 'keep',
            predictedOutputBytes: action.predictedOutputBytes,
            actualOutputBytes: original.byteCount,
            actualSavingsBytes: 0,
            deviationBytes: original.byteCount - action.predictedOutputBytes,
          });
          continue;
        }
        if (
          !this.native.compressImage ||
          !this.native.cancelImageCompression ||
          !this.native.finishImageCompression
        )
          throw new DomainError('DOMAIN_INVALID_TRANSITION');
        activeTaskId = action.outputArtifactId;
        cancellation = undefined;
        try {
          const value = await this.native.compressImage({
            schemaVersion: 1,
            taskId: action.outputArtifactId,
            fileUri: await this.native.resolveOwnedArtifactFileUri(
              original.relativePath,
            ),
            expectedByteCount: original.byteCount,
            expectedSha256: original.sha256,
            targetWidth: action.targetWidth,
            targetHeight: action.targetHeight,
            quality: action.quality,
            outputMediaType: action.outputMediaType,
            preserveAlpha: action.preserveAlpha,
          });
          if (options.signal?.aborted) {
            await cancellation;
            throw new DomainError('PIPELINE_STAGE_FAILED');
          }
          const artifact: Artifact = {
            id: action.outputArtifactId,
            itemId: action.itemId,
            kind: 'compressed-image',
            relativePath: ownedDerivedPath(
              plan.packId,
              action.outputArtifactId,
              value.mediaType === 'image/png' ? 'png' : 'jpg',
            ),
            mediaType: value.mediaType,
            byteCount: value.outputByteCount,
            sha256: value.outputSha256,
            processorVersion: {
              processor: 'native-image-compression',
              version: plan.compressionVersion,
              contractVersion: value.schemaVersion,
              engine: value.engine,
              engineRevision: value.revision,
            },
            createdAt: plan.createdAt,
            immutable: true,
          };
          await coordinator.publish({
            packId: plan.packId,
            sourceFileUri: value.temporaryFileUri,
            artifact,
          });
          results.push({
            itemId: action.itemId,
            action: 'compressed',
            predictedOutputBytes: action.predictedOutputBytes,
            actualOutputBytes: value.outputByteCount,
            actualSavingsBytes: Math.max(
              0,
              original.byteCount - value.outputByteCount,
            ),
            deviationBytes: value.outputByteCount - action.predictedOutputBytes,
            artifactId: artifact.id,
          });
        } finally {
          // Native cancellation and task cleanup must be ordered: finishing a
          // still-cancelling task could remove its registry entry before the
          // worker has made its partial output non-discoverable.
          await awaitCancellationBestEffort(cancellation);
          await this.native.finishImageCompression(action.outputArtifactId);
          activeTaskId = undefined;
        }
      }
      const result = completeBudgetOptimizationResultV1({
        plan,
        completedAt: validTimestamp(this.now(), graph.pack.updatedAt),
        items: results,
      });
      const refreshed = await repository.findPackGraph(plan.packId);
      if (!refreshed || refreshed.revision !== plan.packRevision)
        throw new DomainError('PERSISTENCE_CONFLICT');
      const excluded = new Set(plan.excludedItemIds);
      if (
        excluded.size !== plan.excludedItemIds.length ||
        plan.excludedItemIds.some(
          excludedId => !refreshed.items.some(item => item.id === excludedId),
        )
      )
        throw new DomainError('SCHEMA_INVALID');
      await repository.savePackGraph({
        pack: {
          ...refreshed.pack,
          updatedAt: validTimestamp(this.now(), refreshed.pack.updatedAt),
          budget: {
            ...plan.budget,
            latestEstimate: plan.estimate,
            latestOptimization: result,
          },
          estimatedTokens: plan.estimate.estimatedTokens,
        },
        items: refreshed.items.map(item =>
          excluded.has(item.id)
            ? { ...item, inclusionMode: 'excluded' as const }
            : item,
        ),
        expectedRevision: refreshed.revision,
      });
      return result;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

function validTimestamp(value: string, floor: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new DomainError('SCHEMA_INVALID');
  return Date.parse(value) < Date.parse(floor) ? floor : value;
}

async function awaitCancellationBestEffort(
  cancellation: Promise<void> | undefined,
): Promise<void> {
  if (cancellation) await cancellation.catch(() => undefined);
}
