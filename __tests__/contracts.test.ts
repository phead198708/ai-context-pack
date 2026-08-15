import {
  isImportManifestV1,
  isOCRResultV1,
  isPDFProbeResultV1,
} from '../src/domain/validation';
import { newestManifestsFirst } from '../src/domain/importOrdering';
import type { ImportManifestV1 } from '../src/domain/contracts';
import {
  isPendingShareEvent,
  isRecoveryEvent,
  shareImportErrorCode,
} from '../src/domain/shareImportResult';
import {
  LatestRequestGate,
  runLatestRequest,
  ShareFailureLatch,
} from '../src/domain/latestRequestGate';
import { DOMAIN_ERROR_CATALOG } from '../src/domain/errors';
describe('versioned native contracts', () => {
  const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
  const itemId = '223e4567-e89b-42d3-a456-426614174000';
  test('accepts the shared minimal manifest fixture', () => {
    expect(
      isImportManifestV1({
        schemaVersion: 1,
        ingestionId,
        createdAt: '2026-01-01T00:00:00Z',
        source: 'ios-share-extension',
        status: 'complete',
        items: [
          {
            id: itemId,
            order: 0,
            mediaType: 'image/png',
            byteCount: 128,
            relativePath: `${itemId}.bin`,
            status: 'copied',
          },
        ],
      }),
    ).toBe(true);
  });
  test('rejects breaking manifest versions', () => {
    expect(isImportManifestV1({ schemaVersion: 2, items: [] })).toBe(false);
  });
  test.each(['main-app-picker', 'main-app-text'] as const)(
    'accepts the versioned %s manifest source',
    source => {
      expect(
        isImportManifestV1({
          schemaVersion: 1,
          ingestionId,
          createdAt: '2026-08-07T00:00:00Z',
          source,
          status: 'complete',
          items: [
            {
              id: itemId,
              order: 0,
              mediaType: 'text/plain',
              status: 'copied',
              byteCount: 1,
              relativePath: `${itemId}.bin`,
            },
          ],
        }),
      ).toBe(true);
    },
  );
  test.each(Object.keys(DOMAIN_ERROR_CATALOG))(
    'accepts catalogued failed-item error code %s',
    errorCode => {
      expect(
        isImportManifestV1({
          schemaVersion: 1,
          ingestionId,
          createdAt: '2026-01-01T00:00:00Z',
          source: 'ios-share-extension',
          status: 'failed',
          items: [
            {
              id: itemId,
              order: 0,
              mediaType: 'application/octet-stream',
              byteCount: 0,
              status: 'failed',
              errorCode,
            },
          ],
        }),
      ).toBe(true);
    },
  );
  test('binds optional failed-item retry bytes as an all-or-nothing pair', () => {
    const failed = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-01-01T00:00:00Z',
      source: 'main-app-picker',
      status: 'failed',
      items: [
        {
          id: itemId,
          order: 0,
          mediaType: 'image/png',
          byteCount: 0,
          status: 'failed',
          errorCode: 'IMPORT_TYPE_UNSUPPORTED',
          retryByteCount: 8,
          retrySha256: 'a'.repeat(64),
        },
      ],
    };
    expect(isImportManifestV1(failed)).toBe(true);
    expect(
      isImportManifestV1({
        ...failed,
        items: [{ ...failed.items[0], retrySha256: undefined }],
      }),
    ).toBe(false);
    expect(
      isImportManifestV1({
        ...failed,
        items: [{ ...failed.items[0], retryByteCount: 52_428_801 }],
      }),
    ).toBe(false);
  });
  test.each([
    'content://provider/item',
    '/private/container/item.bin',
    'file:///tmp/item.bin',
  ])('rejects non-relative manifest path %s', relativePath => {
    expect(
      isImportManifestV1({
        schemaVersion: 1,
        ingestionId,
        createdAt: '2026-01-01T00:00:00Z',
        source: 'android-share-intent',
        status: 'complete',
        items: [
          {
            id: itemId,
            order: 0,
            mediaType: 'image/png',
            byteCount: 128,
            relativePath,
            status: 'copied',
          },
        ],
      }),
    ).toBe(false);
  });
  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid manifest byte count %s',
    byteCount => {
      expect(
        isImportManifestV1({
          schemaVersion: 1,
          ingestionId,
          createdAt: '2026-01-01T00:00:00Z',
          source: 'ios-share-extension',
          status: 'complete',
          items: [
            {
              id: itemId,
              order: 0,
              mediaType: 'image/png',
              byteCount,
              relativePath: `${itemId}.bin`,
              status: 'copied',
            },
          ],
        }),
      ).toBe(false);
    },
  );
  test.each([
    {
      id: '223e4567-e89b-42d3-a456-426614174000',
      path: '323e4567-e89b-42d3-a456-426614174000.bin',
    },
    {
      id: itemId,
      path: `nested/${itemId}.bin`,
    },
    {
      id: 'not-a-uuid',
      path: 'not-a-uuid.bin',
    },
  ])('rejects manifest item identity/path mismatch %#', ({ id, path }) => {
    expect(
      isImportManifestV1({
        schemaVersion: 1,
        ingestionId,
        createdAt: '2026-01-01T00:00:00Z',
        source: 'ios-share-extension',
        status: 'complete',
        items: [
          {
            id,
            order: 0,
            mediaType: 'image/png',
            byteCount: 1,
            relativePath: path,
            status: 'copied',
          },
        ],
      }),
    ).toBe(false);
  });
  test('validates normalized OCR bounds', () => {
    expect(
      isOCRResultV1({
        schemaVersion: 1,
        text: 'Synthetic fixture',
        blocks: [
          {
            text: 'Synthetic',
            bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          },
        ],
        durationMs: 4,
        engine: 'apple-vision',
        revision: '1',
      }),
    ).toBe(true);
    expect(
      isOCRResultV1({
        schemaVersion: 1,
        text: '',
        blocks: [{ text: '', bounds: { x: -1, y: 0, width: 1, height: 1 } }],
        durationMs: 1,
        engine: 'apple-vision',
        revision: '1',
      }),
    ).toBe(false);
  });
  test('rejects aggregate OCR block text before any joined allocation', () => {
    const blockText = 'x'.repeat(100_000);
    expect(
      isOCRResultV1({
        schemaVersion: 1,
        text: '',
        blocks: Array.from({ length: 11 }, () => ({
          text: blockText,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
        })),
        durationMs: 1,
        engine: 'apple-vision',
        revision: '1',
      }),
    ).toBe(false);
  });
  test.each([
    { durationMs: -1 },
    { durationMs: Number.NaN },
    { durationMs: Number.POSITIVE_INFINITY },
    { durationMs: 1, confidence: -0.1 },
    { durationMs: 1, confidence: 1.1 },
    { durationMs: 1, confidence: Number.NaN },
    { durationMs: 1, language: 42 },
  ])('rejects invalid OCR optional/numeric fields %#', fields => {
    const { confidence, language, ...resultFields } = fields;
    expect(
      isOCRResultV1({
        schemaVersion: 1,
        text: 'fixture',
        blocks: [
          {
            text: 'fixture',
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            ...(confidence === undefined ? {} : { confidence }),
            ...(language === undefined ? {} : { language }),
          },
        ],
        engine: 'apple-vision',
        revision: '1',
        ...resultFields,
      }),
    ).toBe(false);
  });
  test('validates PDF probe page accounting and engine', () => {
    expect(
      isPDFProbeResultV1({
        pageCount: 1,
        embeddedTextPages: 1,
        renderedFallbackPages: 0,
        engine: 'pdf-renderer',
        limit: { pages: 25, bytes: 52_428_800 },
      }),
    ).toBe(true);
    expect(
      isPDFProbeResultV1({
        pageCount: 1,
        embeddedTextPages: 1,
        renderedFallbackPages: 1,
        engine: 'pdf-renderer',
        limit: { pages: 25, bytes: 52_428_800 },
      }),
    ).toBe(false);
  });
  test('orders manifests newest-first with a stable tie-breaker', () => {
    const manifest = (id: string, createdAt: string) =>
      ({ ingestionId: id, createdAt } as ImportManifestV1);
    expect(
      newestManifestsFirst([
        manifest('a', '2026-01-01T00:00:00Z'),
        manifest('b', '2026-02-01T00:00:00Z'),
        manifest('c', '2026-02-01T00:00:00Z'),
      ]).map(value => value.ingestionId),
    ).toEqual(['c', 'b', 'a']);
  });
  test('maps failed and malformed native share events to stable errors', () => {
    expect(shareImportErrorCode('complete')).toBeNull();
    expect(shareImportErrorCode('failed')).toBe('SHARE_IMPORT_FAILED');
    expect(shareImportErrorCode('fixture text')).toBe(
      'SHARE_IMPORT_EVENT_INVALID',
    );
    expect(
      shareImportErrorCode({
        schemaVersion: 1,
        id: '123e4567-e89b-42d3-a456-426614174000',
        result: 'failed',
      }),
    ).toBe('SHARE_IMPORT_FAILED');
  });
  test.each([
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-8000-000000000000',
    '00000000-0000-4000-0000-000000000000',
    '123E4567-E89B-42D3-A456-426614174000',
  ])('rejects noncanonical metadata event ID %s', id => {
    expect(
      isPendingShareEvent({ schemaVersion: 1, id, result: 'complete' }),
    ).toBe(false);
    expect(
      isRecoveryEvent({
        schemaVersion: 1,
        id,
        code: 'INBOX_RECOVERY_REQUIRED',
      }),
    ).toBe(false);
  });
  test('accepts the privacy-safe compression startup recovery event', () => {
    expect(
      isRecoveryEvent({
        schemaVersion: 1,
        id: '123e4567-e89b-42d3-a456-426614174000',
        code: 'PIPELINE_RECOVERY_REQUIRED',
      }),
    ).toBe(true);
  });
  test('does not let a deferred scan overwrite an invalidating failure', async () => {
    const gate = new LatestRequestGate();
    let resolveScan: ((value: string) => void) | undefined;
    const scan = new Promise<string>(resolve => {
      resolveScan = resolve;
    });
    const visible: string[] = [];
    const pending = runLatestRequest(
      gate,
      () => scan,
      () => visible.push('loading'),
      value => visible.push(value),
      () => visible.push('scan-error'),
    );

    gate.invalidate();
    visible.push('share-error');
    resolveScan?.('ready');
    await pending;

    expect(visible).toEqual(['loading', 'share-error']);
  });
  test('suppresses lifecycle refreshes until retry or success clears failure', () => {
    const latch = new ShareFailureLatch();
    expect(latch.allowsAutomaticRefresh()).toBe(true);
    latch.recordFailure();
    expect(latch.allowsAutomaticRefresh()).toBe(false);
    latch.clear();
    expect(latch.allowsAutomaticRefresh()).toBe(true);
  });
});
