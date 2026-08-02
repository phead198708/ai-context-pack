import type { ImportManifestV1 } from '../src/domain/contracts';
import {
  InboxEventWorkflow,
  type InboxWorkflowState,
} from '../src/domain/inboxEventWorkflow';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import type { PendingShareEvent } from '../src/domain/shareImportResult';
import { NativeBoundaryError } from '../src/infrastructure/createNativeAdapter';

const ids = [
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
];
const manifest = { ingestionId: 'visible' } as ImportManifestV1;
const event = (
  index: number,
  result: 'complete' | 'failed',
  extra: Partial<PendingShareEvent> = {},
): PendingShareEvent => ({
  schemaVersion: 1,
  id: ids[index]!,
  result,
  ...extra,
});

function harness(overrides: Partial<NativeAdapter> = {}) {
  const native: NativeAdapter = {
    available: true,
    scanInbox: jest.fn().mockResolvedValue([manifest]),
    getPendingShareEvents: jest.fn().mockResolvedValue([]),
    ackPendingShareEvent: jest.fn().mockResolvedValue(undefined),
    ackEphemeralShareEvent: jest.fn().mockResolvedValue(undefined),
    getPendingRecoveryEvent: jest.fn().mockResolvedValue(null),
    ackRecoveryEvent: jest.fn().mockResolvedValue(undefined),
    recognizeText: jest.fn(),
    probePdf: jest.fn(),
    ...overrides,
  };
  const states: InboxWorkflowState[] = [];
  const view = {
    setState: (state: InboxWorkflowState) => states.push(state),
    showNewestImport: jest.fn(),
  };
  return {
    native,
    states,
    view,
    workflow: new InboxEventWorkflow(native, view),
  };
}

describe('InboxEventWorkflow integration', () => {
  test('failed then complete keeps the failure visible and durable', async () => {
    const h = harness();
    await h.workflow.receive(event(0, 'failed'));
    await h.workflow.receive(event(1, 'complete'));
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'SHARE_IMPORT_FAILED',
    });
    expect(h.native.ackPendingShareEvent).toHaveBeenCalledWith(ids[1]);
    expect(h.native.ackPendingShareEvent).not.toHaveBeenCalledWith(ids[0]);
  });

  test('complete then failed finishes with failure and retains its ID', async () => {
    const h = harness();
    await h.workflow.receive(event(0, 'complete'));
    await h.workflow.receive(event(1, 'failed'));
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'SHARE_IMPORT_FAILED',
    });
    await h.workflow.retry();
    expect(h.native.ackPendingShareEvent).toHaveBeenCalledWith(ids[1]);
  });

  test('deduplicates the same cold and live event ID', async () => {
    const duplicate = event(0, 'complete');
    const h = harness({
      getPendingShareEvents: jest.fn().mockResolvedValue([duplicate]),
    });
    await h.workflow.bootstrap();
    await h.workflow.receive(duplicate);
    expect(h.native.ackPendingShareEvent).toHaveBeenCalledTimes(1);
  });

  test('Retry commits partial failed ACK progress before a later ACK fails', async () => {
    const ack = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new NativeBoundaryError('NATIVE_SHARE_ACK_FAILED'))
      .mockResolvedValue(undefined);
    const h = harness({ ackPendingShareEvent: ack });
    await h.workflow.receive(event(0, 'failed'));
    await h.workflow.receive(event(1, 'failed'));
    await h.workflow.retry();
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_ACK_FAILED',
    });
    await h.workflow.retry();
    expect(ack.mock.calls.map(call => call[0])).toEqual([
      ids[0],
      ids[1],
      ids[1],
    ]);
  });

  test('ACKs complete only after its manifest refresh succeeds', async () => {
    const order: string[] = [];
    const h = harness({
      scanInbox: jest.fn(async () => {
        order.push('refresh');
        return [manifest];
      }),
      ackPendingShareEvent: jest.fn(async () => {
        order.push('ack');
      }),
    });
    await h.workflow.receive(event(0, 'complete'));
    expect(order).toEqual(['refresh', 'ack']);
  });

  test('retains complete across recovery and ACKs it after one Retry', async () => {
    const recovery = {
      schemaVersion: 1 as const,
      id: ids[2]!,
      code: 'INBOX_RECOVERY_REQUIRED' as const,
    };
    let pendingRecovery: typeof recovery | null = recovery;
    const h = harness({
      getPendingRecoveryEvent: jest.fn(() => Promise.resolve(pendingRecovery)),
      ackRecoveryEvent: jest.fn(async () => {
        pendingRecovery = null;
      }),
    });
    await h.workflow.receive(event(0, 'complete'));
    expect(h.native.ackPendingShareEvent).not.toHaveBeenCalled();
    await h.workflow.retry();
    expect(h.native.ackRecoveryEvent).toHaveBeenCalledWith(ids[2]);
    expect(h.native.ackPendingShareEvent).toHaveBeenCalledWith(ids[0]);
  });

  test('preserves false and missing ACK method error codes from the adapter', async () => {
    const falseAck = harness({
      ackPendingShareEvent: jest
        .fn()
        .mockRejectedValue(new NativeBoundaryError('NATIVE_SHARE_ACK_FAILED')),
    });
    await falseAck.workflow.receive(event(0, 'complete'));
    expect(falseAck.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_ACK_FAILED',
    });
    const missing = harness({
      ackPendingShareEvent: jest
        .fn()
        .mockRejectedValue(
          new NativeBoundaryError('NATIVE_SHARE_ACK_UNAVAILABLE'),
        ),
    });
    await missing.workflow.receive(event(0, 'complete'));
    expect(missing.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_ACK_UNAVAILABLE',
    });
  });

  test('surfaces event store read failure without synthesizing invalid input', async () => {
    const h = harness({
      getPendingShareEvents: jest
        .fn()
        .mockRejectedValue(
          new NativeBoundaryError('NATIVE_SHARE_EVENT_STORE_READ_FAILED'),
        ),
    });
    await h.workflow.bootstrap();
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_EVENT_STORE_READ_FAILED',
    });
  });

  test('fails closed on malformed live event', async () => {
    const h = harness();
    await h.workflow.receive({
      schemaVersion: 1,
      id: ids[0]!,
      result: 'unknown',
    });
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_EVENT_INVALID',
    });
  });

  test('one Retry acknowledges every recovery event', async () => {
    const recoveries = [
      {
        schemaVersion: 1 as const,
        id: ids[0]!,
        code: 'INBOX_RECOVERY_REQUIRED' as const,
      },
      {
        schemaVersion: 1 as const,
        id: ids[1]!,
        code: 'INBOX_RECOVERY_REQUIRED' as const,
      },
      null,
    ];
    const h = harness({
      getPendingRecoveryEvent: jest
        .fn()
        .mockImplementation(() => Promise.resolve(recoveries.shift())),
    });
    await h.workflow.retry();
    expect(h.native.ackRecoveryEvent).toHaveBeenCalledTimes(2);
  });

  test('AppState refresh cannot overwrite an unacknowledged failure', async () => {
    const h = harness();
    await h.workflow.receive(event(0, 'failed'));
    await h.workflow.appBecameActive();
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'SHARE_IMPORT_FAILED',
    });
  });

  test('ephemeral persistence fallback uses only the in-memory ACK', async () => {
    const h = harness();
    await h.workflow.receive(
      event(0, 'failed', {
        durable: false,
        code: 'SHARE_RESULT_PERSIST_FAILED',
      }),
    );
    await h.workflow.retry();
    expect(h.native.ackPendingShareEvent).not.toHaveBeenCalled();
    expect(h.native.ackEphemeralShareEvent).toHaveBeenCalledWith(ids[0]);
  });
});
