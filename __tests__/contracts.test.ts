import {
  isImportManifestV1,
  isOCRResultV1,
  isPDFProbeResultV1,
} from '../src/domain/validation';
import { newestManifestsFirst } from '../src/domain/importOrdering';
import type { ImportManifestV1 } from '../src/domain/contracts';
import { shareImportErrorCode } from '../src/domain/shareImportResult';
describe('versioned native contracts', () => {
  test('accepts the shared minimal manifest fixture', () => {
    expect(
      isImportManifestV1({
        schemaVersion: 1,
        ingestionId: 'synthetic-001',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'ios-share-extension',
        status: 'complete',
        items: [
          {
            id: 'item-001',
            mediaType: 'image/png',
            byteCount: 128,
            localUri: 'file:///internal/Inbox/synthetic-001/item-001.png',
            status: 'copied',
          },
        ],
      }),
    ).toBe(true);
  });
  test('rejects breaking manifest versions', () => {
    expect(isImportManifestV1({ schemaVersion: 2, items: [] })).toBe(false);
  });
  test.each([
    'content://provider/item',
    'https://example.com/item.png',
    'file:///tmp/item.png',
  ])('rejects non-owned manifest URI %s', localUri => {
    expect(
      isImportManifestV1({
        schemaVersion: 1,
        ingestionId: 'synthetic-001',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'android-share-intent',
        status: 'complete',
        items: [
          {
            id: 'item-001',
            mediaType: 'image/png',
            byteCount: 128,
            localUri,
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
          ingestionId: 'synthetic-001',
          createdAt: '2026-01-01T00:00:00Z',
          source: 'ios-share-extension',
          status: 'complete',
          items: [
            {
              id: 'item-001',
              mediaType: 'image/png',
              byteCount,
              localUri:
                'file:///private/container/Inbox/synthetic-001/item-001.bin',
              status: 'copied',
            },
          ],
        }),
      ).toBe(false);
    },
  );
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
    const manifest = (ingestionId: string, createdAt: string) =>
      ({ ingestionId, createdAt } as ImportManifestV1);
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
  });
});
