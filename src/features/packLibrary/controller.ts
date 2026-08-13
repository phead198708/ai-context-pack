import { DomainError } from '../../domain/errors';
import type { ContextItem, ContextPack } from '../../domain/models';
import {
  groupDuplicateSuggestionsV1,
  type DuplicateDecisionChoiceV1,
  type DuplicateDecisionV1,
} from '../../domain/duplicateDetection';
import {
  restoreItemCheckpoint,
  transitionItem,
  transitionPack,
} from '../../domain/stateMachines';
import type { ProductionPersistenceRepository } from '../../infrastructure/persistence/contracts';
import {
  buildPackLibrarySnapshot,
  reorderContextItems,
  retryPlanForItem,
  stateAtRetryCheckpoint,
  type PackLibrarySnapshot,
  type RetryPlan,
} from './domain';
import { createPipelineRun, type PackProcessingScheduler } from './processing';

export type RemovedOriginalDisposition = 'preserve' | 'release';

export class PackLibraryController {
  private chain = Promise.resolve();

  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly processing?: PackProcessingScheduler,
  ) {}

  recoverProcessing(): Promise<void> {
    return this.processing?.recover() ?? Promise.resolve();
  }

  async load(selectedPackId?: string): Promise<PackLibrarySnapshot> {
    const repository = await this.getRepository();
    // Expo SQLite uses one app-lifetime connection. Do not overlap snapshot reads that may
    // open exclusive transactions on that connection.
    const graphs = await repository.listPackGraphs();
    const artifacts = await repository.listArtifactRecords();
    const imports = await repository.listImportDetails();
    const selectedId = selectedPackId ?? graphs[0]?.pack.id;
    const duplicateAnalysis = selectedId
      ? await repository.findDuplicateAnalysis(selectedId)
      : undefined;
    return buildPackLibrarySnapshot(
      graphs,
      artifacts,
      imports,
      selectedPackId,
      duplicateAnalysis,
    );
  }

  renamePack(packId: string, title: string): Promise<void> {
    const value = boundedUserText(title, 120, false);
    return this.mutate(packId, graph => ({
      pack: { ...graph.pack, title: value },
      items: graph.items,
    }));
  }

  editInstruction(packId: string, instruction: string): Promise<void> {
    const value = boundedUserText(instruction, 4_000, true);
    return this.mutate(packId, graph => ({
      pack: { ...graph.pack, userInstruction: value },
      items: graph.items,
    }));
  }

  renameItem(packId: string, itemId: string, name: string): Promise<void> {
    const value = boundedUserText(name, 160, false);
    return this.mutate(packId, graph => ({
      pack: graph.pack,
      items: replaceItem(graph.items, itemId, item => ({
        ...item,
        originalDisplayName: value,
      })),
    }));
  }

  reorderItem(
    packId: string,
    itemId: string,
    targetIndex: number,
  ): Promise<void> {
    return this.mutate(packId, graph => {
      const reordered = reorderContextItems(graph.items, itemId, targetIndex);
      return {
        pack: {
          ...graph.pack,
          state: packStateAfterPackagingInputChange(graph.pack.state),
        },
        items: invalidatePackagedItems(reordered),
      };
    });
  }

  removeItem(
    packId: string,
    itemId: string,
    originalDisposition: RemovedOriginalDisposition,
  ): Promise<void> {
    return this.mutate(
      packId,
      graph => {
        if (!graph.items.some(item => item.id === itemId))
          throw new DomainError('PERSISTENCE_CONFLICT');
        const items = graph.items
          .filter(item => item.id !== itemId)
          .map((item, sortIndex) => ({ ...item, sortIndex }));
        return {
          pack: {
            ...graph.pack,
            state: packStateAfterPackagingInputChange(graph.pack.state),
          },
          items: invalidatePackagedItems(items),
        };
      },
      originalDisposition,
    );
  }

  retryItem(packId: string, itemId: string): Promise<RetryPlan> {
    let plan: RetryPlan | undefined;
    return this.enqueue(async () => {
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      const artifacts = await repository.listArtifactRecords();
      if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
      const item = graph.items.find(candidate => candidate.id === itemId);
      if (!item || !['failed', 'cancelled', 'recovering'].includes(item.state))
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const itemArtifacts = artifacts.filter(value => value.itemId === item.id);
      plan = retryPlanForItem(packId, item, itemArtifacts);
      if (plan.stage === 'import')
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      if (this.processing && !this.processing.supports(plan.stage))
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const items = replaceItem(graph.items, itemId, current => ({
        ...withoutRetryStage(current),
        state: restoreItemCheckpoint(
          current.state,
          stateAtRetryCheckpoint(plan!.stage),
        ),
      }));
      const updatedAt = this.timestamp(graph.pack);
      const runs = this.processing ? [createPipelineRun(plan!, updatedAt)] : [];
      await repository.savePackGraph({
        pack: updatedPack(
          { ...graph.pack, state: packStateForRetry(graph.pack.state) },
          items,
          updatedAt,
        ),
        items,
        expectedRevision: graph.revision,
        ...(runs.length > 0 ? { startedPipelineRuns: runs } : {}),
      });
      this.processing?.launch(runs);
      return plan;
    });
  }

  retryPack(packId: string): Promise<readonly RetryPlan[]> {
    return this.enqueue(async () => {
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      const artifacts = await repository.listArtifactRecords();
      if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
      const plans: RetryPlan[] = [];
      let hasBlockedFailedItem = false;
      const items = graph.items.map(item => {
        if (!['failed', 'cancelled', 'recovering'].includes(item.state))
          return item;
        const plan = retryPlanForItem(
          packId,
          item,
          artifacts.filter(value => value.itemId === item.id),
        );
        // Provider-less failures stay in the retained-source import retry flow.
        if (
          plan.stage === 'import' ||
          (this.processing && !this.processing.supports(plan.stage))
        ) {
          hasBlockedFailedItem = true;
          return item;
        }
        plans.push(plan);
        return {
          ...withoutRetryStage(item),
          state: restoreItemCheckpoint(
            item.state,
            stateAtRetryCheckpoint(plan.stage),
          ),
        };
      });
      // Pack Retry is atomic across every terminal item. Starting executable
      // siblings while retaining one unsupported failure would move the Pack
      // out of `failed` and strand the blocked item without a Retry entry.
      if (hasBlockedFailedItem)
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      for (const item of items) {
        if (
          plans.some(plan => plan.itemId === item.id) ||
          ![
            'received',
            'imported',
            'extracted',
            'analyzed',
            'reviewed',
          ].includes(item.state)
        )
          continue;
        const plan = retryPlanForItem(
          packId,
          item,
          artifacts.filter(value => value.itemId === item.id),
        );
        if (
          plan.stage !== 'import' &&
          (!this.processing || this.processing.supports(plan.stage))
        )
          plans.push(plan);
      }
      const allPackaged =
        items.length > 0 && items.every(item => item.state === 'packaged');
      const hasRunnableCheckpoint =
        plans.length > 0 ||
        (!this.processing &&
          items.some(item =>
            [
              'received',
              'imported',
              'extracted',
              'analyzed',
              'reviewed',
            ].includes(item.state),
          )) ||
        // A failed Pack whose items are all packaged represents a pack-level
        // packaging/export checkpoint. Retrying must reactivate that checkpoint
        // without fabricating item work or silently accepting a failed item.
        allPackaged;
      if (!hasRunnableCheckpoint)
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const updatedAt = this.timestamp(graph.pack);
      const runs = this.processing
        ? plans.map(plan => createPipelineRun(plan, updatedAt))
        : [];
      const retriedPackState = packStateForRetry(graph.pack.state);
      await repository.savePackGraph({
        pack: updatedPack(
          {
            ...graph.pack,
            state: allPackaged
              ? transitionPack(retriedPackState, 'mark-ready')
              : retriedPackState,
          },
          items,
          updatedAt,
        ),
        items,
        expectedRevision: graph.revision,
        ...(runs.length > 0 ? { startedPipelineRuns: runs } : {}),
      });
      this.processing?.launch(runs);
      return plans;
    });
  }

  async analyzePack(packId: string): Promise<number> {
    const durableRuns = await this.enqueue(async () => {
      if (!this.processing?.supports('analyze'))
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      if (!graph || !['processing', 'recovering'].includes(graph.pack.state))
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const candidates = graph.items.filter(item => item.state === 'extracted');
      if (candidates.length === 0)
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const updatedAt = this.timestamp(graph.pack);
      const runs = candidates.map(item =>
        createPipelineRun(
          { packId, itemId: item.id, stage: 'analyze' },
          updatedAt,
        ),
      );
      await repository.savePackGraph({
        pack: updatedPack(graph.pack, graph.items, updatedAt),
        items: graph.items,
        expectedRevision: graph.revision,
        startedPipelineRuns: runs,
      });
      this.processing.launch(runs);
      return runs;
    });
    // Only durable run creation is serialized. Settlement can take seconds and
    // must not hold the controller queue that makes cancellation durable.
    await this.processing!.waitForIdle();
    return durableRuns.length;
  }

  reviewDuplicateGroup(
    packId: string,
    groupItemIds: readonly string[],
    action:
      | { readonly kind: 'keep-all' }
      | {
          readonly kind: 'exclude' | 'preferred';
          readonly itemId: string;
        },
  ): Promise<void> {
    return this.enqueue(async () => {
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
      const snapshot = await repository.findDuplicateAnalysis(packId);
      const matching = groupDuplicateSuggestionsV1(snapshot.suggestions).find(
        group => sameStringSet(group.itemIds, groupItemIds),
      );
      if (!matching || groupItemIds.length < 2)
        throw new DomainError('SCHEMA_INVALID');
      if (action.kind !== 'keep-all' && !groupItemIds.includes(action.itemId))
        throw new DomainError('SCHEMA_INVALID');
      const priorById = new Map(
        snapshot.decisions.map(decision => [decision.itemId, decision]),
      );
      const itemById = new Map(graph.items.map(item => [item.id, item]));
      const decidedAt = this.timestamp(graph.pack);
      const createDecision = (
        itemId: string,
        choice: DuplicateDecisionChoiceV1,
        source: DuplicateDecisionV1['source'] = 'standalone',
      ): DuplicateDecisionV1 => {
        const item = itemById.get(itemId);
        if (!item) throw new DomainError('PERSISTENCE_CONFLICT');
        return {
          schemaVersion: 1,
          packId,
          itemId,
          choice,
          baselineInclusionMode:
            priorById.get(itemId)?.baselineInclusionMode ?? item.inclusionMode,
          source,
          decidedAt,
        };
      };
      const preferredCoverageIds = new Set(
        action.kind === 'preferred'
          ? matching.suggestions.flatMap(suggestion => {
              if (suggestion.leftItemId === action.itemId)
                return [suggestion.rightItemId];
              if (suggestion.rightItemId === action.itemId)
                return [suggestion.leftItemId];
              return [];
            })
          : [],
      );
      // Before provenance existed, a Preferred action wrote its group rows with
      // one timestamp. A source-less exclusion from any other timestamp is
      // ambiguous: it may be older group history or a later standalone privacy
      // choice. Preserve that ambiguity rather than silently restoring content
      // the user may have explicitly excluded.
      const legacyPreferredDecisionTimes = new Set(
        groupItemIds.flatMap(itemId => {
          const prior = priorById.get(itemId);
          return prior?.choice === 'preferred' && prior.source === undefined
            ? [prior.decidedAt]
            : [];
        }),
      );
      const wasPreferredGroupDecision = (
        decision: DuplicateDecisionV1 | undefined,
      ): boolean =>
        decision?.source === 'preferred-group' ||
        (decision !== undefined &&
          decision.source === undefined &&
          legacyPreferredDecisionTimes.has(decision.decidedAt));
      const decisions =
        action.kind === 'keep-all'
          ? groupItemIds.map(itemId => createDecision(itemId, 'keep'))
          : action.kind === 'exclude'
          ? [createDecision(action.itemId, 'exclude')]
          : groupItemIds.flatMap(itemId => {
              if (itemId === action.itemId)
                return [createDecision(itemId, 'preferred', 'preferred-group')];
              if (preferredCoverageIds.has(itemId)) {
                const prior = priorById.get(itemId);
                return [
                  createDecision(
                    itemId,
                    'exclude',
                    prior?.choice === 'exclude' &&
                      !wasPreferredGroupDecision(prior)
                      ? 'standalone'
                      : 'preferred-group',
                  ),
                ];
              }
              const prior = priorById.get(itemId);
              return wasPreferredGroupDecision(prior)
                ? [createDecision(itemId, 'keep', 'preferred-group')]
                : [];
            });
      await repository.saveDuplicateDecisions(packId, decisions);
    });
  }

  restoreDuplicateDecision(packId: string, itemId: string): Promise<void> {
    return this.enqueue(async () => {
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      if (!graph || !graph.items.some(item => item.id === itemId))
        throw new DomainError('PERSISTENCE_CONFLICT');
      await repository.restoreDuplicateDecision(
        packId,
        itemId,
        this.timestamp(graph.pack),
      );
    });
  }

  cancelProcessing(packId: string): Promise<void> {
    return this.enqueue(async () => {
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
      if (!['processing', 'recovering'].includes(graph.pack.state))
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      const updatedAt = this.timestamp(graph.pack);
      await repository.savePackGraph({
        pack: updatedPack(
          {
            ...graph.pack,
            state: transitionPack(graph.pack.state, 'cancel'),
          },
          graph.items,
          updatedAt,
        ),
        items: graph.items,
        expectedRevision: graph.revision,
        cancelActivePipelineRuns: true,
      });
      await this.processing?.cancel(packId, updatedAt);
    });
  }

  private mutate(
    packId: string,
    change: (
      graph: NonNullable<
        Awaited<ReturnType<ProductionPersistenceRepository['findPackGraph']>>
      >,
    ) => { readonly pack: ContextPack; readonly items: readonly ContextItem[] },
    removedItemOriginalDisposition: RemovedOriginalDisposition = 'preserve',
  ): Promise<void> {
    return this.enqueue(async () => {
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(packId);
      if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
      const changed = change(graph);
      await repository.savePackGraph({
        pack: updatedPack(
          changed.pack,
          changed.items,
          this.timestamp(changed.pack),
        ),
        items: changed.items,
        expectedRevision: graph.revision,
        removedItemOriginalDisposition,
      });
    });
  }

  private timestamp(pack: ContextPack): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value)))
      throw new DomainError('SCHEMA_INVALID');
    return [value, pack.createdAt, pack.updatedAt].reduce((latest, candidate) =>
      Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
    );
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const work = this.chain.then(task, task);
    this.chain = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
}

function updatedPack(
  pack: ContextPack,
  items: readonly ContextItem[],
  updatedAt: string,
): ContextPack {
  return {
    ...pack,
    updatedAt,
    orderedItemIds: items.map(item => item.id),
  };
}

function packStateForRetry(state: ContextPack['state']): ContextPack['state'] {
  if (state === 'failed' || state === 'cancelled')
    return transitionPack(state, 'retry');
  if (state === 'recovering') return transitionPack(state, 'resume-recovery');
  if (state === 'review-required') return transitionPack(state, 'retry');
  if (state === 'processing') return state;
  throw new DomainError('DOMAIN_INVALID_TRANSITION');
}

function packStateAfterPackagingInputChange(
  state: ContextPack['state'],
): ContextPack['state'] {
  if (state === 'ready' || state === 'exporting' || state === 'exported')
    return transitionPack(state, 'restart-packaging');
  return state;
}

function invalidatePackagedItems(
  items: readonly ContextItem[],
): readonly ContextItem[] {
  return items.map(item =>
    item.state === 'packaged'
      ? {
          ...item,
          state: transitionItem(item.state, 'invalidate-package'),
        }
      : item,
  );
}

function replaceItem(
  items: readonly ContextItem[],
  itemId: string,
  update: (item: ContextItem) => ContextItem,
): readonly ContextItem[] {
  let found = false;
  const values = items.map(item => {
    if (item.id !== itemId) return item;
    found = true;
    return update(item);
  });
  if (!found) throw new DomainError('PERSISTENCE_CONFLICT');
  return values;
}

function withoutRetryStage(item: ContextItem): ContextItem {
  const { retryStage, ...checkpoint } = item;
  if (!retryStage) throw new DomainError('DOMAIN_INVALID_TRANSITION');
  return checkpoint;
}

function boundedUserText(
  value: string,
  maximumLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || value.length > maximumLength)
    throw new DomainError('SCHEMA_INVALID');
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0)
    throw new DomainError('SCHEMA_INVALID');
  return allowEmpty ? value : normalized;
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
