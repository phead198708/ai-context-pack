import {
  DOMAIN_ERROR_CATALOG,
  DomainError,
  domainErrorDefinition,
  type ErrorCategory,
  type ErrorDisposition,
} from '../src/domain/errors';
import {
  ITEM_COMMANDS,
  ITEM_STATES,
  ITEM_TRANSITIONS,
  PACK_COMMANDS,
  PACK_STATES,
  PACK_TRANSITIONS,
  restoreItemCheckpoint,
  transitionItem,
  transitionPack,
} from '../src/domain/stateMachines';

const allowedPackPairs = new Set(
  PACK_TRANSITIONS.map(({ from, command }) => `${from}:${command}`),
);
const invalidPackTransitions = PACK_STATES.flatMap(from =>
  PACK_COMMANDS.filter(
    command => !allowedPackPairs.has(`${from}:${command}`),
  ).map(command => ({ from, command })),
);

const allowedItemPairs = new Set(
  ITEM_TRANSITIONS.map(({ from, command }) => `${from}:${command}`),
);
const invalidItemTransitions = ITEM_STATES.flatMap(from =>
  ITEM_COMMANDS.filter(
    command => !allowedItemPairs.has(`${from}:${command}`),
  ).map(command => ({ from, command })),
);

describe('immutable domain state machines', () => {
  test.each(PACK_TRANSITIONS)(
    'allows Pack $from --$command--> $to',
    ({ from, command, to }) => {
      expect(transitionPack(from, command)).toBe(to);
      expect(from).not.toBe(to);
    },
  );

  test.each(invalidPackTransitions)(
    'rejects Pack $from --$command',
    ({ from, command }) => {
      expect(() => transitionPack(from, command)).toThrow(
        expect.objectContaining({ code: 'DOMAIN_INVALID_TRANSITION' }),
      );
    },
  );

  test.each(ITEM_TRANSITIONS)(
    'allows Item $from --$command--> $to',
    ({ from, command, to }) => {
      expect(transitionItem(from, command)).toBe(to);
      expect(from).not.toBe(to);
    },
  );

  test.each(invalidItemTransitions)(
    'rejects Item $from --$command',
    ({ from, command }) => {
      expect(() => transitionItem(from, command)).toThrow(
        expect.objectContaining({ code: 'DOMAIN_INVALID_TRANSITION' }),
      );
    },
  );

  test('has no ambiguous state-command pair', () => {
    expect(allowedPackPairs.size).toBe(PACK_TRANSITIONS.length);
    expect(allowedItemPairs.size).toBe(ITEM_TRANSITIONS.length);
  });

  test('models cancellation, retry, partial failure, review, and recovery as commands', () => {
    expect(PACK_COMMANDS).toEqual(
      expect.arrayContaining([
        'cancel',
        'retry',
        'restart-packaging',
        'record-partial-failure',
        'require-review',
        'start-recovery',
        'resume-recovery',
      ]),
    );
    expect(ITEM_COMMANDS).toEqual(
      expect.arrayContaining([
        'cancel',
        'retry',
        'invalidate-package',
        'require-review',
        'start-recovery',
        'resume-recovery',
      ]),
    );
  });

  test('restores only recoverable items to a durable completed checkpoint', () => {
    expect(restoreItemCheckpoint('failed', 'extracted')).toBe('extracted');
    expect(restoreItemCheckpoint('cancelled', 'imported')).toBe('imported');
    expect(restoreItemCheckpoint('recovering', 'reviewed')).toBe('reviewed');
    expect(() => restoreItemCheckpoint('imported', 'extracted')).toThrow(
      expect.objectContaining({ code: 'DOMAIN_INVALID_TRANSITION' }),
    );
    expect(() => restoreItemCheckpoint('failed', 'failed')).toThrow(
      expect.objectContaining({ code: 'DOMAIN_INVALID_TRANSITION' }),
    );
  });
});

describe('stable domain error catalogue', () => {
  test('classifies every code by disposition and category', () => {
    const dispositions = new Set<ErrorDisposition>();
    const categories = new Set<ErrorCategory>();

    for (const code of Object.keys(
      DOMAIN_ERROR_CATALOG,
    ) as (keyof typeof DOMAIN_ERROR_CATALOG)[]) {
      const definition = domainErrorDefinition(code);
      expect(definition.code).toBe(code);
      dispositions.add(definition.disposition);
      categories.add(definition.category);
    }

    expect(dispositions).toEqual(
      new Set(['retryable', 'terminal', 'user-action-required']),
    );
    expect(categories).toEqual(
      new Set([
        'integrity',
        'privacy',
        'resource',
        'input',
        'platform',
        'state',
      ]),
    );
  });

  test('carries stable metadata on thrown domain errors', () => {
    const error = new DomainError('RESOURCE_LOW_DISK');
    expect(error).toMatchObject({
      code: 'RESOURCE_LOW_DISK',
      disposition: 'user-action-required',
      category: 'resource',
    });
  });
});
