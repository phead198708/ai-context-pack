import type { ImportManifestV1 } from '../src/domain/contracts';
import {
  InboxEventWorkflow,
  type InboxManifestProcessor,
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

function harness(
  overrides: Partial<NativeAdapter> = {},
  processor?: InboxManifestProcessor,
) {
  const native: NativeAdapter = {
    available: true,
    scanInbox: jest.fn().mockResolvedValue([manifest]),
    getPendingShareEvents: jest.fn().mockResolvedValue([]),
    ackPendingShareEvent: jest.fn().mockResolvedValue(undefined),
    ackEphemeralShareEvent: jest.fn().mockResolvedValue(undefined),
    getPendingRecoveryEvent: jest.fn().mockResolvedValue(null),
    ackRecoveryEvent: jest.fn().mockResolvedValue(undefined),
    handoffInbox: jest.fn().mockResolvedValue([]),
    acknowledgeInbox: jest.fn().mockResolvedValue(undefined),
    publishMainAppImport: jest.fn(),
    stageMainAppPickerFiles: jest.fn(),
    cleanupMainAppPickerTransients: jest.fn(),
    recoverMainAppPickerCache: jest.fn().mockResolvedValue(undefined),
    discardMainAppPickerFiles: jest.fn(),
    publishArtifact: jest.fn(),
    verifyArtifact: jest.fn(),
    listOwnedArtifacts: jest.fn(),
    removeOwnedArtifact: jest.fn(),
    quarantineOwnedArtifact: jest.fn(),
    purgeArtifactQuarantine: jest.fn(),
    getArtifactStorageUsage: jest.fn(),
    getOCRCapabilities: jest.fn(),
    recognizeText: jest.fn(),
    cancelTextRecognition: jest.fn(),
    inspectPdf: jest.fn(),
    extractPdfPage: jest.fn(),
    cancelPdfExtraction: jest.fn(),
    readPlainTextFile: jest.fn(),
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
    workflow: new InboxEventWorkflow(native, view, processor),
  };
}

describe('InboxEventWorkflow integration', () => {
  test('failed then complete keeps the failure visible and durable', async () => {
    const h = harness();
    await h.workflow.receive(event(0, 'failed'));
    await h.workflow.receive(event(1, 'complete'));
    expect(h.states.at(-1)).toEqual({
      kind: 'ready',
      manifests: [manifest],
      warningCode: 'SHARE_IMPORT_FAILED',
    });
    expect(h.native.ackPendingShareEvent).toHaveBeenCalledWith(ids[1]);
    expect(h.native.ackPendingShareEvent).not.toHaveBeenCalledWith(ids[0]);
  });

  test('complete then failed retains the visible import with a warning and its ID', async () => {
    const h = harness();
    await h.workflow.receive(event(0, 'complete'));
    await h.workflow.receive(event(1, 'failed'));
    expect(h.states.at(-1)).toEqual({
      kind: 'ready',
      manifests: [manifest],
      warningCode: 'SHARE_IMPORT_FAILED',
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

  test('fails closed on cold-start picker-cache recovery and Retry clears it', async () => {
    const recover = jest
      .fn()
      .mockRejectedValueOnce({ code: 'STORAGE_WRITE_FAILED' })
      .mockResolvedValueOnce(undefined);
    const h = harness({ recoverMainAppPickerCache: recover });

    await h.workflow.bootstrap();

    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'STORAGE_WRITE_FAILED',
    });
    expect(h.native.scanInbox).not.toHaveBeenCalled();
    expect(h.workflow.isPickerCacheRecovered()).toBe(false);

    await h.workflow.retry();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(h.native.scanInbox).toHaveBeenCalledTimes(1);
    expect(h.workflow.isPickerCacheRecovered()).toBe(true);
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
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

  test('fails closed on uppercase live event ID', async () => {
    const scan = jest.fn().mockResolvedValue([manifest]);
    const h = harness({ scanInbox: scan });

    await h.workflow.receive({
      schemaVersion: 1,
      id: ids[0]!.toUpperCase(),
      result: 'complete',
    });
    await h.workflow.appBecameActive();

    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_EVENT_INVALID',
    });
    expect(scan).not.toHaveBeenCalled();
    expect(h.native.ackPendingShareEvent).not.toHaveBeenCalled();
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

  test('invalid live event remains latched across AppState active', async () => {
    const scan = jest.fn().mockResolvedValue([manifest]);
    const h = harness({ scanInbox: scan });
    await h.workflow.receive({
      schemaVersion: 1,
      id: ids[0],
      result: 'unknown',
    });

    await h.workflow.appBecameActive();

    expect(scan).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_EVENT_INVALID',
    });
  });

  test('event-store read failure remains latched across AppState active', async () => {
    const scan = jest.fn().mockResolvedValue([manifest]);
    const h = harness({
      scanInbox: scan,
      getPendingShareEvents: jest
        .fn()
        .mockRejectedValue(
          new NativeBoundaryError('NATIVE_SHARE_EVENT_STORE_READ_FAILED'),
        ),
    });
    await h.workflow.bootstrap();

    await h.workflow.appBecameActive();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_EVENT_STORE_READ_FAILED',
    });
  });

  test('complete ACK failure remains latched across AppState active', async () => {
    const scan = jest.fn().mockResolvedValue([manifest]);
    const h = harness({
      scanInbox: scan,
      ackPendingShareEvent: jest
        .fn()
        .mockRejectedValue(new NativeBoundaryError('NATIVE_SHARE_ACK_FAILED')),
    });
    await h.workflow.receive(event(0, 'complete'));

    await h.workflow.appBecameActive();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_ACK_FAILED',
    });
  });

  test('recovery ACK failure remains latched across AppState active', async () => {
    const recovery = {
      schemaVersion: 1 as const,
      id: ids[2]!,
      code: 'INBOX_RECOVERY_REQUIRED' as const,
    };
    const getRecovery = jest.fn().mockResolvedValue(recovery);
    const h = harness({
      getPendingRecoveryEvent: getRecovery,
      ackRecoveryEvent: jest
        .fn()
        .mockRejectedValue(
          new NativeBoundaryError('NATIVE_RECOVERY_ACK_FAILED'),
        ),
    });
    await h.workflow.receive(event(0, 'complete'));
    await h.workflow.retry();
    const callsAfterRetry = getRecovery.mock.calls.length;

    await h.workflow.appBecameActive();

    expect(getRecovery).toHaveBeenCalledTimes(callsAfterRetry);
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_RECOVERY_ACK_FAILED',
    });
  });

  test('failed Retry preserves the more specific ACK error latch', async () => {
    const ack = jest
      .fn()
      .mockRejectedValue(
        new NativeBoundaryError('NATIVE_SHARE_ACK_UNAVAILABLE'),
      );
    const h = harness({ ackPendingShareEvent: ack });
    await h.workflow.receive(event(0, 'failed'));

    await h.workflow.retry();
    await h.workflow.retry();

    expect(ack).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_SHARE_ACK_UNAVAILABLE',
    });
  });

  test('successful Retry clears an ACK latch and allows later AppState refresh', async () => {
    const scan = jest.fn().mockResolvedValue([manifest]);
    const ack = jest
      .fn()
      .mockRejectedValueOnce(new NativeBoundaryError('NATIVE_SHARE_ACK_FAILED'))
      .mockResolvedValue(undefined);
    const h = harness({ scanInbox: scan, ackPendingShareEvent: ack });
    await h.workflow.receive(event(0, 'complete'));
    await h.workflow.appBecameActive();
    expect(scan).toHaveBeenCalledTimes(1);

    await h.workflow.retry();
    const callsAfterRetry = scan.mock.calls.length;
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });

    await h.workflow.appBecameActive();
    expect(scan).toHaveBeenCalledTimes(callsAfterRetry + 1);
  });

  test('duplicate invalid event ID creates only one blocking latch', async () => {
    const h = harness();
    const invalid = { schemaVersion: 1, id: ids[0], result: 'unknown' };

    await h.workflow.receive(invalid);
    await h.workflow.receive(invalid);

    expect(h.states).toEqual([
      { kind: 'error', code: 'NATIVE_SHARE_EVENT_INVALID' },
    ]);
  });

  test('scan failure is not retried by AppState and clears after explicit Retry', async () => {
    const scan = jest
      .fn()
      .mockRejectedValueOnce(new NativeBoundaryError('NATIVE_MANIFEST_INVALID'))
      .mockResolvedValue([manifest]);
    const h = harness({ scanInbox: scan });
    await h.workflow.bootstrap();

    await h.workflow.appBecameActive();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_MANIFEST_INVALID',
    });
    expect(h.workflow.isPackCreationReady()).toBe(false);

    await h.workflow.retry();
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
    expect(h.workflow.isPackCreationReady()).toBe(true);
  });

  test('a visible failed-share item does not block unrelated Pack creation', async () => {
    const h = harness();
    await h.workflow.bootstrap();
    expect(h.workflow.isPackCreationReady()).toBe(true);

    await h.workflow.receive(
      event(0, 'failed', { code: 'SHARE_IMPORT_FAILED' }),
    );

    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'SHARE_IMPORT_FAILED',
    });
    expect(h.workflow.isPackCreationReady()).toBe(true);
  });

  test('a failed share arriving last keeps persisted Packs visible with a warning', async () => {
    const packs = [
      {
        id: ids[2]!,
        schemaVersion: 1 as const,
        title: 'Context Pack',
        createdAt: '2026-08-03T00:00:00Z',
        updatedAt: '2026-08-03T00:00:00Z',
        state: 'draft' as const,
        itemCount: 1,
      },
    ];
    const h = harness(
      {},
      {
        process: jest.fn().mockResolvedValue(undefined),
        listPersistedPacks: jest.fn().mockResolvedValue(packs),
      },
    );
    await h.workflow.bootstrap();

    await h.workflow.receive(event(0, 'failed'));

    expect(h.states.at(-1)).toEqual({
      kind: 'ready',
      manifests: [],
      packs,
      warningCode: 'SHARE_IMPORT_FAILED',
    });
  });

  test('a failed share cannot mask an already latched operational error', async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce([manifest])
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'));
    const h = harness({ scanInbox: scan });
    await h.workflow.bootstrap();

    await h.workflow.appBecameActive();
    await h.workflow.receive(event(0, 'failed'));

    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'STORAGE_WRITE_FAILED',
    });
  });

  test('committed recovery reports the operational cause ahead of a later failure warning', async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce([manifest])
      .mockRejectedValue(new NativeBoundaryError('STORAGE_WRITE_FAILED'));
    const h = harness({ scanInbox: scan });
    await h.workflow.bootstrap();
    await h.workflow.appBecameActive();
    await h.workflow.receive(event(0, 'failed'));

    await expect(h.workflow.refreshForMainAppImport()).rejects.toMatchObject({
      code: 'STORAGE_WRITE_FAILED',
    });
  });

  test('main-app refresh rejects with the latched persistence code and retries it', async () => {
    const process = jest
      .fn()
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'))
      .mockResolvedValueOnce(undefined);
    const h = harness({}, { process });

    await expect(h.workflow.refreshForMainAppImport()).rejects.toMatchObject({
      code: 'STORAGE_WRITE_FAILED',
    });
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'STORAGE_WRITE_FAILED',
    });

    await expect(h.workflow.refreshForMainAppImport()).resolves.toBeUndefined();
    expect(process).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
  });

  test('committed recovery clears a live invalid-event blocker before refreshing', async () => {
    const h = harness();
    await h.workflow.bootstrap();
    await h.workflow.receive({
      schemaVersion: 1,
      id: ids[0],
      result: 'unknown',
    });

    await expect(h.workflow.refreshForMainAppImport()).resolves.toBeUndefined();

    expect(h.native.getPendingShareEvents).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
  });

  test('committed recovery retries a complete-event ACK blocker', async () => {
    const ack = jest
      .fn()
      .mockRejectedValueOnce(new NativeBoundaryError('NATIVE_SHARE_ACK_FAILED'))
      .mockResolvedValueOnce(undefined);
    const h = harness({ ackPendingShareEvent: ack });
    await h.workflow.receive(event(0, 'complete'));

    await expect(h.workflow.refreshForMainAppImport()).resolves.toBeUndefined();

    expect(ack).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
  });

  test('a committed main-app import refresh ignores an older failed share item', async () => {
    const h = harness();
    await h.workflow.receive(
      event(0, 'failed', { code: 'SHARE_IMPORT_FAILED' }),
    );

    await expect(h.workflow.refreshForMainAppImport()).resolves.toBeUndefined();
    expect(h.native.scanInbox).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({
      kind: 'ready',
      manifests: [manifest],
      warningCode: 'SHARE_IMPORT_FAILED',
    });
  });

  test('created-Pack refresh scans through a historical warning and returns the requested Pack', async () => {
    const oldPack = {
      id: ids[0]!,
      schemaVersion: 1 as const,
      title: 'Older Pack',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      state: 'draft' as const,
      itemCount: 0,
    };
    const createdPack = {
      ...oldPack,
      id: ids[2]!,
      title: 'Created Pack',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const listPersistedPacks = jest
      .fn()
      .mockResolvedValueOnce([oldPack])
      .mockResolvedValueOnce([oldPack, createdPack]);
    const h = harness(
      {},
      {
        process: jest.fn().mockResolvedValue(undefined),
        listPersistedPacks,
      },
    );
    await h.workflow.bootstrap();
    await h.workflow.receive(
      event(0, 'failed', { code: 'SHARE_IMPORT_FAILED' }),
    );

    await expect(
      h.workflow.refreshForCreatedPack(createdPack.id),
    ).resolves.toEqual(createdPack);

    expect(h.native.scanInbox).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual({
      kind: 'ready',
      manifests: [manifest],
      packs: [oldPack, createdPack],
      warningCode: 'SHARE_IMPORT_FAILED',
    });
  });

  test('created-Pack refresh rejects an operational scan failure', async () => {
    const scanInbox = jest
      .fn()
      .mockResolvedValueOnce([manifest])
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'));
    const h = harness(
      { scanInbox },
      {
        process: jest.fn().mockResolvedValue(undefined),
        listPersistedPacks: jest.fn().mockResolvedValue([]),
      },
    );
    await h.workflow.bootstrap();

    await expect(
      h.workflow.refreshForCreatedPack(ids[2]!),
    ).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });

    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'STORAGE_WRITE_FAILED',
    });
  });

  test('created-Pack refresh fails closed when the requested Pack is absent', async () => {
    const h = harness(
      {},
      {
        process: jest.fn().mockResolvedValue(undefined),
        listPersistedPacks: jest.fn().mockResolvedValue([]),
      },
    );
    await h.workflow.bootstrap();

    await expect(
      h.workflow.refreshForCreatedPack(ids[2]!),
    ).rejects.toMatchObject({ code: 'INBOX_SCAN_FAILED' });

    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'INBOX_SCAN_FAILED',
    });
  });

  test('durable persistence completes before a successful share event is ACKed', async () => {
    const order: string[] = [];
    const pending = event(0, 'complete');
    const h = harness(
      {
        getPendingShareEvents: jest.fn().mockResolvedValue([pending]),
        ackPendingShareEvent: jest.fn().mockImplementation(async () => {
          order.push('event-ack');
        }),
      },
      {
        process: jest.fn().mockImplementation(async () => {
          order.push('persistence');
        }),
      },
    );

    await h.workflow.bootstrap();

    expect(order).toEqual(['persistence', 'event-ack']);
  });

  test('reuses only the lifecycle scan matching a live Android event after Inbox ACK', async () => {
    const pending = event(0, 'complete');
    const matchingManifest = {
      ...manifest,
      ingestionId: pending.id,
    } as ImportManifestV1;
    const process = jest.fn().mockResolvedValue(undefined);
    const scanInbox = jest
      .fn()
      .mockResolvedValueOnce([matchingManifest])
      .mockResolvedValueOnce([]);
    const h = harness({ scanInbox }, { process });

    await h.workflow.appBecameActive();
    await h.workflow.receive(pending);

    expect(scanInbox).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({
      kind: 'ready',
      manifests: [matchingManifest],
    });
  });

  test('migration failure remains retryable and prevents event ACK until persistence succeeds', async () => {
    const pending = event(0, 'complete');
    const process = jest
      .fn()
      .mockRejectedValueOnce(
        new NativeBoundaryError('SCHEMA_VERSION_UNSUPPORTED'),
      )
      .mockResolvedValue(undefined);
    const ack = jest.fn().mockResolvedValue(undefined);
    const h = harness(
      {
        getPendingShareEvents: jest.fn().mockResolvedValue([pending]),
        ackPendingShareEvent: ack,
      },
      { process },
    );

    await h.workflow.bootstrap();
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'SCHEMA_VERSION_UNSUPPORTED',
    });
    expect(ack).not.toHaveBeenCalled();

    await h.workflow.retry();
    expect(process).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
  });

  test('ephemeral ACK failure keeps its exact code until Retry succeeds', async () => {
    const ack = jest
      .fn()
      .mockRejectedValueOnce(
        new NativeBoundaryError('NATIVE_EPHEMERAL_ACK_UNAVAILABLE'),
      )
      .mockResolvedValue(undefined);
    const h = harness({ ackEphemeralShareEvent: ack });
    await h.workflow.receive(
      event(0, 'failed', {
        durable: false,
        code: 'SHARE_RESULT_PERSIST_FAILED',
      }),
    );

    await h.workflow.retry();
    expect(h.states.at(-1)).toEqual({
      kind: 'error',
      code: 'NATIVE_EPHEMERAL_ACK_UNAVAILABLE',
    });
    await h.workflow.retry();
    expect(ack).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toEqual({ kind: 'ready', manifests: [manifest] });
  });
});
