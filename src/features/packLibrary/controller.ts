import { DomainError } from '../../domain/errors';
import type { ContextItem, ContextPack } from '../../domain/models';
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

export type RemovedOriginalDisposition = 'preserve' | 'release';

export class PackLibraryController {
  private chain = Promise.resolve();

  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async load(selectedPackId?: string): Promise<PackLibrarySnapshot> {
    const repository = await this.getRepository();
    // Expo SQLite uses one app-lifetime connection. Do not overlap snapshot reads that may
    // open exclusive transactions on that connection.
    const graphs = await repository.listPackGraphs();
    const artifacts = await repository.listArtifactRecords();
    const imports = await repository.listImportDetails();
    return buildPackLibrarySnapshot(graphs, artifacts, imports, selectedPackId);
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
          state: packStateAfterReorder(graph.pack.state),
        },
        items: reordered.map(item =>
          item.state === 'packaged'
            ? {
                ...item,
                state: transitionItem(item.state, 'invalidate-package'),
              }
            : item,
        ),
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
        return { pack: graph.pack, items };
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
      const items = replaceItem(graph.items, itemId, current => ({
        ...current,
        state: restoreItemCheckpoint(
          current.state,
          stateAtRetryCheckpoint(plan!.stage),
        ),
      }));
      await repository.savePackGraph({
        pack: updatedPack(
          { ...graph.pack, state: packStateForRetry(graph.pack.state) },
          items,
          this.timestamp(graph.pack),
        ),
        items,
        expectedRevision: graph.revision,
      });
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
      const items = graph.items.map(item => {
        if (!['failed', 'cancelled', 'recovering'].includes(item.state))
          return item;
        const plan = retryPlanForItem(
          packId,
          item,
          artifacts.filter(value => value.itemId === item.id),
        );
        // Provider-less failures stay in the retained-source import retry flow.
        if (plan.stage === 'import') return item;
        plans.push(plan);
        return {
          ...item,
          state: restoreItemCheckpoint(
            item.state,
            stateAtRetryCheckpoint(plan.stage),
          ),
        };
      });
      const hasRunnableCheckpoint =
        plans.length > 0 ||
        items.some(item =>
          [
            'received',
            'imported',
            'extracted',
            'analyzed',
            'reviewed',
          ].includes(item.state),
        );
      if (!hasRunnableCheckpoint)
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      await repository.savePackGraph({
        pack: updatedPack(
          { ...graph.pack, state: packStateForRetry(graph.pack.state) },
          items,
          this.timestamp(graph.pack),
        ),
        items,
        expectedRevision: graph.revision,
      });
      return plans;
    });
  }

  cancelProcessing(packId: string): Promise<void> {
    return this.mutate(packId, graph => {
      if (!['processing', 'recovering'].includes(graph.pack.state))
        throw new DomainError('DOMAIN_INVALID_TRANSITION');
      return {
        pack: {
          ...graph.pack,
          state: transitionPack(graph.pack.state, 'cancel'),
        },
        // Item state is the last durable checkpoint, not a running-task flag. The Pack
        // cancellation gate stops queued work while preserving the exact resume point.
        items: graph.items,
      };
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
    return Date.parse(value) < Date.parse(pack.createdAt)
      ? pack.createdAt
      : value;
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

function packStateAfterReorder(
  state: ContextPack['state'],
): ContextPack['state'] {
  if (state === 'ready' || state === 'exporting' || state === 'exported')
    return transitionPack(state, 'restart-packaging');
  return state;
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
