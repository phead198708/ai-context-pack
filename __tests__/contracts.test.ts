import { isImportManifestV1, isOCRResultV1 } from '../src/domain/validation';
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
            localUri: 'file:///internal/item-001.png',
            status: 'copied',
          },
        ],
      }),
    ).toBe(true);
  });
  test('rejects breaking manifest versions', () => {
    expect(isImportManifestV1({ schemaVersion: 2, items: [] })).toBe(false);
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
});
