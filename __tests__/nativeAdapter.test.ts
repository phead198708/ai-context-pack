import {
  createNativeAdapter,
  NativeBoundaryError,
} from '../src/infrastructure/createNativeAdapter';

describe('native adapter runtime boundary', () => {
  const mockNativeModule = {
    scanInbox: jest.fn(),
    recognizeText: jest.fn(),
    probePdf: jest.fn(),
  };
  const adapter = createNativeAdapter(mockNativeModule);

  beforeEach(() => jest.clearAllMocks());

  test('rejects invalid manifests returned by native code', async () => {
    mockNativeModule.scanInbox.mockResolvedValue([
      { schemaVersion: 2, items: [] },
    ]);

    await expect(adapter.scanInbox()).rejects.toEqual(
      new NativeBoundaryError('NATIVE_MANIFEST_INVALID'),
    );
  });

  test('rejects duplicate ingestion IDs returned by native code', async () => {
    const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
    const manifest = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-01-01T00:00:00Z',
      source: 'android-share-intent',
      status: 'complete',
      items: [
        {
          id: 'item',
          mediaType: 'image/png',
          byteCount: 1,
          localUri: `file:///data/Inbox/${ingestionId}/item.bin`,
          status: 'copied',
        },
      ],
    };
    mockNativeModule.scanInbox.mockResolvedValue([manifest, manifest]);

    await expect(adapter.scanInbox()).rejects.toMatchObject({
      code: 'NATIVE_MANIFEST_INVALID',
    });
  });

  test('rejects invalid OCR and PDF DTOs', async () => {
    mockNativeModule.recognizeText.mockResolvedValue({ schemaVersion: 1 });
    mockNativeModule.probePdf.mockResolvedValue({ pageCount: 1 });

    await expect(
      adapter.recognizeText('file:///fixture.png', 'latin'),
    ).rejects.toMatchObject({ code: 'NATIVE_OCR_RESULT_INVALID' });
    await expect(adapter.probePdf('file:///fixture.pdf')).rejects.toMatchObject(
      { code: 'NATIVE_PDF_RESULT_INVALID' },
    );
  });

  test('validates versioned share events before exposing them', async () => {
    const native = {
      ...mockNativeModule,
      getPendingShareEvents: jest
        .fn()
        .mockResolvedValue([
          { schemaVersion: 1, id: 'not-an-id', result: 'complete' },
        ]),
    };
    await expect(
      createNativeAdapter(native).getPendingShareEvents(),
    ).rejects.toMatchObject({
      code: 'NATIVE_SHARE_EVENT_INVALID',
    });
  });

  test('rejects uppercase event IDs at the native boundary', async () => {
    const uppercaseId = '123E4567-E89B-42D3-A456-426614174000';
    const shareNative = {
      ...mockNativeModule,
      getPendingShareEvents: jest
        .fn()
        .mockResolvedValue([
          { schemaVersion: 1, id: uppercaseId, result: 'complete' },
        ]),
    };
    const recoveryNative = {
      ...mockNativeModule,
      getPendingRecoveryEvent: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        id: uppercaseId,
        code: 'INBOX_RECOVERY_REQUIRED',
      }),
    };

    await expect(
      createNativeAdapter(shareNative).getPendingShareEvents(),
    ).rejects.toMatchObject({ code: 'NATIVE_SHARE_EVENT_INVALID' });
    await expect(
      createNativeAdapter(recoveryNative).getPendingRecoveryEvent(),
    ).rejects.toMatchObject({ code: 'NATIVE_RECOVERY_EVENT_INVALID' });
  });

  test('preserves the durable recovery error across the native boundary', async () => {
    mockNativeModule.scanInbox.mockRejectedValue({
      code: 'INBOX_RECOVERY_REQUIRED',
    });
    await expect(adapter.scanInbox()).rejects.toMatchObject({
      code: 'INBOX_RECOVERY_REQUIRED',
    });
  });

  test('requires explicit successful event acknowledgements', async () => {
    const native = {
      ...mockNativeModule,
      ackPendingShareEvent: jest.fn().mockResolvedValue(false),
      ackRecoveryEvent: jest.fn().mockResolvedValue(false),
    };
    const guarded = createNativeAdapter(native);
    await expect(guarded.ackPendingShareEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_SHARE_ACK_FAILED',
    });
    await expect(guarded.ackRecoveryEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_RECOVERY_ACK_FAILED',
    });
  });

  test('rejects acknowledgements when native methods are unavailable', async () => {
    await expect(adapter.ackPendingShareEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_SHARE_ACK_UNAVAILABLE',
    });
    await expect(adapter.ackRecoveryEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_RECOVERY_ACK_UNAVAILABLE',
    });
  });
});
