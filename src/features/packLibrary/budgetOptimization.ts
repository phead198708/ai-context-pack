import {
  completeBudgetOptimizationResultV1,
  createBudgetOptimizationPlanV1,
  type BudgetOptimizationItemResultV1,
  type BudgetOptimizationPlanV1,
  type BudgetOptimizationResultV1,
  type BudgetSourceItemV1,
  type BudgetItemExclusionV1,
} from '../../domain/budgetOptimization';
import { createCanonicalUuid } from '../../domain/canonicalUuid';
import { DomainError } from '../../domain/errors';
import { latestIsoDateTime } from '../../domain/isoDateTime';
import type { Artifact, Budget } from '../../domain/models';
import type { NativeAdapter } from '../../domain/nativeAdapter';
import {
  NativeAtomicArtifactFileStore,
  PublishedArtifactCoordinator,
} from '../../infrastructure/persistence/artifactStore';
import type {
  PersistedArtifactRecord,
  ProductionPersistenceRepository,
} from '../../infrastructure/persistence/contracts';
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
    if (graph.pack.budget.pendingOptimization) {
      assertRecoverableCheckpoint(
        graph.pack.id,
        graph.revision,
        graph.pack.budget.pendingOptimization,
      );
      return graph.pack.budget.pendingOptimization;
    }
    const [artifacts, duplicateAnalysis] = await Promise.all([
      repository.listArtifactRecords(),
      repository.findDuplicateAnalysis(packId),
    ]);
    const requestedExclusions = new Set(excludedItemIds);
    if (
      requestedExclusions.size !== excludedItemIds.length ||
      excludedItemIds.some(
        excludedId => !graph.items.some(item => item.id === excludedId),
      )
    )
      throw new DomainError('SCHEMA_INVALID');
    const priorExclusions = new Map(
      (graph.pack.budget.exclusions ?? []).map(exclusion => [
        exclusion.itemId,
        exclusion,
      ]),
    );
    for (const exclusion of priorExclusions.values()) {
      const excludedItem = graph.items.find(
        item => item.id === exclusion.itemId,
      );
      if (!excludedItem || excludedItem.inclusionMode !== 'excluded')
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
    }
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
    const budgetExclusions: BudgetItemExclusionV1[] = [];
    for (const item of graph.items) {
      const included =
        item.inclusionMode !== 'excluded' && !requestedExclusions.has(item.id);
      const priorExclusion = priorExclusions.get(item.id);
      if (priorExclusion) budgetExclusions.push(priorExclusion);
      else if (!included && item.inclusionMode !== 'excluded')
        budgetExclusions.push({
          itemId: item.id,
          baselineInclusionMode: item.inclusionMode,
        });
      const includesOriginal =
        included && ['original', 'both'].includes(item.inclusionMode);
      const includesExtracted =
        included && ['extracted', 'both'].includes(item.inclusionMode);
      const original = originalByItem.get(item.id);
      if (included && !original)
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      const analysis = analyses.get(item.id);
      if (includesExtracted && !analysis)
        throw new DomainError('PIPELINE_RECOVERY_REQUIRED');
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
      exclusions: budgetExclusions.sort((left, right) =>
        left.itemId < right.itemId ? -1 : 1,
      ),
      createArtifactId: () => this.createId(),
    });
  }

  async apply(
    plan: BudgetOptimizationPlanV1,
    options: BudgetOptimizationApplyOptions = {},
  ): Promise<BudgetOptimizationResultV1> {
    throwIfAborted(options.signal);
    const repository = await this.getRepository();
    throwIfAborted(options.signal);
    let graph = await repository.findPackGraph(plan.packId);
    if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
    const pending = graph.pack.budget.pendingOptimization;
    if (pending && !samePlan(pending, plan))
      throw new DomainError('PERSISTENCE_CONFLICT');
    if (pending)
      assertRecoverableCheckpoint(graph.pack.id, graph.revision, pending);
    if (!pending) {
      if (graph.revision !== plan.packRevision)
        throw new DomainError('PERSISTENCE_CONFLICT');
      const updatedAt = monotonicTimestamp(this.now(), [
        graph.pack.updatedAt,
        plan.createdAt,
      ]);
      const checkpointPack = {
        ...graph.pack,
        updatedAt,
        budget: { ...graph.pack.budget, pendingOptimization: plan },
      };
      const revision = await repository.savePackGraph({
        pack: checkpointPack,
        items: graph.items,
        expectedRevision: graph.revision,
      });
      assertRecoverableCheckpoint(checkpointPack.id, revision, plan);
      graph = { pack: checkpointPack, items: graph.items, revision };
    }
    const effectivePlan = graph.pack.budget.pendingOptimization;
    if (!effectivePlan || !samePlan(effectivePlan, plan))
      throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
    throwIfAborted(options.signal);
    const artifacts = await repository.listArtifactRecords();
    throwIfAborted(options.signal);
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
      for (const action of effectivePlan.actions) {
        throwIfAborted(options.signal);
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
        const checkpoint = artifacts.find(
          artifact => artifact.id === action.outputArtifactId,
        );
        if (checkpoint) {
          await verifyCheckpointArtifact(this.native, checkpoint);
          throwIfAborted(options.signal);
          results.push(
            resultFromCheckpoint(effectivePlan, action, original, checkpoint),
          );
          continue;
        }
        if (
          !this.native.compressImage ||
          !this.native.cancelImageCompression ||
          !this.native.finishImageCompression
        )
          throw new DomainError('DOMAIN_INVALID_TRANSITION');
        const fileUri = await this.native.resolveOwnedArtifactFileUri(
          original.relativePath,
        );
        throwIfAborted(options.signal);
        activeTaskId = action.outputArtifactId;
        cancellation = undefined;
        try {
          const value = await this.native.compressImage({
            schemaVersion: 1,
            taskId: action.outputArtifactId,
            fileUri,
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
              effectivePlan.packId,
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
            createdAt: effectivePlan.createdAt,
            immutable: true,
          };
          await coordinator.publish({
            packId: effectivePlan.packId,
            sourceFileUri: value.temporaryFileUri,
            artifact,
          });
          throwIfAborted(options.signal);
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
        throwIfAborted(options.signal);
      }
      const result = completeBudgetOptimizationResultV1({
        plan: effectivePlan,
        completedAt: monotonicTimestamp(this.now(), [
          graph.pack.updatedAt,
          effectivePlan.createdAt,
        ]),
        items: results,
      });
      const refreshed = await repository.findPackGraph(effectivePlan.packId);
      if (
        !refreshed ||
        refreshed.revision !== graph.revision ||
        !refreshed.pack.budget.pendingOptimization ||
        !samePlan(refreshed.pack.budget.pendingOptimization, effectivePlan)
      )
        throw new DomainError('PERSISTENCE_CONFLICT');
      const excluded = new Set(effectivePlan.excludedItemIds);
      if (
        excluded.size !== effectivePlan.excludedItemIds.length ||
        effectivePlan.excludedItemIds.some(
          excludedId => !refreshed.items.some(item => item.id === excludedId),
        )
      )
        throw new DomainError('SCHEMA_INVALID');
      // The graph save below is the irreversible optimization commit point.
      // Observe cancellation immediately before entering it; once it succeeds,
      // the durable result is authoritative even if the caller later aborts.
      throwIfAborted(options.signal);
      await repository.savePackGraph({
        pack: {
          ...refreshed.pack,
          updatedAt: monotonicTimestamp(this.now(), [
            refreshed.pack.updatedAt,
            effectivePlan.createdAt,
            result.completedAt,
          ]),
          budget: {
            ...effectivePlan.budget,
            latestEstimate: effectivePlan.estimate,
            latestOptimization: result,
          },
          estimatedTokens: effectivePlan.estimate.estimatedTokens,
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

function monotonicTimestamp(value: string, floors: readonly string[]): string {
  return latestIsoDateTime([value, ...floors]);
}

function validTimestamp(value: string, floor: string): string {
  return monotonicTimestamp(value, [floor]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DomainError('PIPELINE_STAGE_FAILED');
}

function samePlan(
  left: BudgetOptimizationPlanV1,
  right: BudgetOptimizationPlanV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRecoverableCheckpoint(
  packId: string,
  revision: number,
  plan: BudgetOptimizationPlanV1,
): void {
  if (plan.packId !== packId)
    throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  if (
    plan.packRevision >= Number.MAX_SAFE_INTEGER ||
    revision !== plan.packRevision + 1
  )
    throw new DomainError('PERSISTENCE_CONFLICT');
}

async function verifyCheckpointArtifact(
  native: NativeAdapter,
  artifact: PersistedArtifactRecord,
): Promise<void> {
  const verification = await native.verifyArtifact(
    artifact.relativePath,
    artifact.byteCount,
    artifact.sha256,
  );
  if (
    verification.status !== 'verified' ||
    verification.relativePath !== artifact.relativePath ||
    verification.byteCount !== artifact.byteCount ||
    verification.sha256 !== artifact.sha256
  )
    throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
}

function resultFromCheckpoint(
  plan: BudgetOptimizationPlanV1,
  action: Extract<
    BudgetOptimizationPlanV1['actions'][number],
    { kind: 'compress' }
  >,
  original: Artifact,
  artifact: PersistedArtifactRecord,
): BudgetOptimizationItemResultV1 {
  const expectedPath = ownedDerivedPath(
    plan.packId,
    action.outputArtifactId,
    artifact.mediaType === 'image/png' ? 'png' : 'jpg',
  );
  if (
    artifact.itemId !== action.itemId ||
    artifact.kind !== 'compressed-image' ||
    artifact.mediaType !== action.outputMediaType ||
    artifact.relativePath !== expectedPath ||
    (artifact.mediaType !== 'image/jpeg' &&
      artifact.mediaType !== 'image/png') ||
    artifact.createdAt !== plan.createdAt ||
    artifact.processorVersion.processor !== 'native-image-compression' ||
    artifact.processorVersion.version !== plan.compressionVersion ||
    artifact.processorVersion.contractVersion !== 1 ||
    !Number.isSafeInteger(artifact.byteCount) ||
    artifact.byteCount <= 0 ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  )
    throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
  return {
    itemId: action.itemId,
    action: 'compressed',
    predictedOutputBytes: action.predictedOutputBytes,
    actualOutputBytes: artifact.byteCount,
    actualSavingsBytes: Math.max(0, original.byteCount - artifact.byteCount),
    deviationBytes: artifact.byteCount - action.predictedOutputBytes,
    artifactId: artifact.id,
  };
}

async function awaitCancellationBestEffort(
  cancellation: Promise<void> | undefined,
): Promise<void> {
  if (cancellation) await cancellation.catch(() => undefined);
}
