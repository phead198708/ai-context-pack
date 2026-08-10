import { DomainError } from './errors';
import type { ItemState, PackState } from './models';

export const PACK_STATES = [
  'draft',
  'processing',
  'review-required',
  'ready',
  'exporting',
  'exported',
  'recovering',
  'failed',
  'cancelled',
] as const satisfies readonly PackState[];

export const PACK_COMMANDS = [
  'start-processing',
  'require-review',
  'record-partial-failure',
  'resolve-review',
  'mark-ready',
  'start-export',
  'complete-export',
  'fail',
  'cancel',
  'retry',
  'restart-packaging',
  'start-recovery',
  'resume-recovery',
] as const;

export type PackCommand = (typeof PACK_COMMANDS)[number];

export interface PackTransition {
  readonly from: PackState;
  readonly command: PackCommand;
  readonly to: PackState;
}

export const PACK_TRANSITIONS: readonly PackTransition[] = [
  { from: 'draft', command: 'start-processing', to: 'processing' },
  { from: 'processing', command: 'require-review', to: 'review-required' },
  {
    from: 'processing',
    command: 'record-partial-failure',
    to: 'review-required',
  },
  { from: 'processing', command: 'mark-ready', to: 'ready' },
  { from: 'review-required', command: 'resolve-review', to: 'ready' },
  { from: 'review-required', command: 'retry', to: 'processing' },
  { from: 'ready', command: 'start-export', to: 'exporting' },
  { from: 'exporting', command: 'complete-export', to: 'exported' },
  { from: 'processing', command: 'fail', to: 'failed' },
  { from: 'review-required', command: 'fail', to: 'failed' },
  { from: 'ready', command: 'fail', to: 'failed' },
  { from: 'exporting', command: 'fail', to: 'failed' },
  { from: 'recovering', command: 'fail', to: 'failed' },
  { from: 'processing', command: 'cancel', to: 'cancelled' },
  { from: 'review-required', command: 'cancel', to: 'cancelled' },
  { from: 'exporting', command: 'cancel', to: 'cancelled' },
  { from: 'recovering', command: 'cancel', to: 'cancelled' },
  { from: 'failed', command: 'retry', to: 'processing' },
  { from: 'cancelled', command: 'retry', to: 'processing' },
  { from: 'ready', command: 'restart-packaging', to: 'processing' },
  { from: 'exporting', command: 'restart-packaging', to: 'processing' },
  { from: 'exported', command: 'restart-packaging', to: 'processing' },
  { from: 'processing', command: 'start-recovery', to: 'recovering' },
  { from: 'exporting', command: 'start-recovery', to: 'recovering' },
  { from: 'failed', command: 'start-recovery', to: 'recovering' },
  { from: 'cancelled', command: 'start-recovery', to: 'recovering' },
  { from: 'recovering', command: 'resume-recovery', to: 'processing' },
];

export function transitionPack(
  from: PackState,
  command: PackCommand,
): PackState {
  const transition = PACK_TRANSITIONS.find(
    candidate => candidate.from === from && candidate.command === command,
  );
  if (!transition) throw new DomainError('DOMAIN_INVALID_TRANSITION');
  return transition.to;
}

export const ITEM_STATES = [
  'received',
  'imported',
  'extracted',
  'analyzed',
  'review-required',
  'reviewed',
  'packaged',
  'recovering',
  'failed',
  'cancelled',
] as const satisfies readonly ItemState[];

export const ITEM_COMMANDS = [
  'mark-imported',
  'mark-extracted',
  'mark-analyzed',
  'require-review',
  'mark-reviewed',
  'mark-packaged',
  'fail',
  'cancel',
  'retry',
  'invalidate-package',
  'start-recovery',
  'resume-recovery',
] as const;

export type ItemCommand = (typeof ITEM_COMMANDS)[number];

export interface ItemTransition {
  readonly from: ItemState;
  readonly command: ItemCommand;
  readonly to: ItemState;
}

const itemActiveStates: readonly ItemState[] = [
  'received',
  'imported',
  'extracted',
  'analyzed',
  'review-required',
  'reviewed',
  'recovering',
];

const itemRecoverableStates: readonly ItemState[] = [
  'imported',
  'extracted',
  'analyzed',
  'review-required',
  'reviewed',
  'failed',
  'cancelled',
];

export const ITEM_TRANSITIONS: readonly ItemTransition[] = [
  { from: 'received', command: 'mark-imported', to: 'imported' },
  { from: 'imported', command: 'mark-extracted', to: 'extracted' },
  { from: 'extracted', command: 'mark-analyzed', to: 'analyzed' },
  { from: 'analyzed', command: 'require-review', to: 'review-required' },
  { from: 'analyzed', command: 'mark-reviewed', to: 'reviewed' },
  { from: 'review-required', command: 'mark-reviewed', to: 'reviewed' },
  { from: 'reviewed', command: 'mark-packaged', to: 'packaged' },
  ...itemActiveStates.map(from => ({
    from,
    command: 'fail' as const,
    to: 'failed' as const,
  })),
  ...itemActiveStates.map(from => ({
    from,
    command: 'cancel' as const,
    to: 'cancelled' as const,
  })),
  { from: 'failed', command: 'retry', to: 'received' },
  { from: 'cancelled', command: 'retry', to: 'received' },
  { from: 'packaged', command: 'invalidate-package', to: 'reviewed' },
  ...itemRecoverableStates.map(from => ({
    from,
    command: 'start-recovery' as const,
    to: 'recovering' as const,
  })),
  { from: 'recovering', command: 'resume-recovery', to: 'received' },
];

export function transitionItem(
  from: ItemState,
  command: ItemCommand,
): ItemState {
  const transition = ITEM_TRANSITIONS.find(
    candidate => candidate.from === from && candidate.command === command,
  );
  if (!transition) throw new DomainError('DOMAIN_INVALID_TRANSITION');
  return transition.to;
}

const ITEM_CHECKPOINT_STATES = new Set<ItemState>([
  'received',
  'imported',
  'extracted',
  'analyzed',
  'reviewed',
]);

/** Restores a failed/cancelled recovery to its last durable completed stage. */
export function restoreItemCheckpoint(
  from: ItemState,
  checkpoint: ItemState,
): ItemState {
  if (
    !['failed', 'cancelled', 'recovering'].includes(from) ||
    !ITEM_CHECKPOINT_STATES.has(checkpoint)
  )
    throw new DomainError('DOMAIN_INVALID_TRANSITION');
  return checkpoint;
}
