import {
  MAIN_APP_IMPORT_MAX_BINARY_BYTES,
  MAIN_APP_IMPORT_MAX_TEXT_BYTES,
  appendPickerAssets,
  appendTextEntry,
  createMainAppImportDraft,
  createRetryMainAppImportDraft,
  moveImportItem,
  pickerFileUris,
  removeImportItem,
  summarizeMainAppImport,
  utf8ByteCount,
} from '../src/domain/mainAppImport';

const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
const ids = Array.from(
  { length: 24 },
  (_, index) =>
    `${String(index + 2).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
);

function idFactory(): () => string {
  let index = 0;
  return () => ids[index++]!;
}

describe('main-app import draft', () => {
  test('hydrates a new ingestion from immutable failed-item retry sources', () => {
    const createId = idFactory();
    const draft = createRetryMainAppImportDraft(
      [
        {
          mediaType: 'image/png',
          byteCount: 4,
          ownedRelativePath: `Packs/${ingestionId}/originals/${ids[0]}.bin`,
          sha256: 'a'.repeat(64),
        },
      ],
      createId,
    );

    expect(draft).toEqual({
      ingestionId: ids[0],
      items: [
        {
          id: ids[1],
          order: 0,
          kind: 'owned-file',
          declaredMediaType: 'image/png',
          byteCount: 4,
          ownedRelativePath: `Packs/${ingestionId}/originals/${ids[0]}.bin`,
          sha256: 'a'.repeat(64),
        },
      ],
    });
    expect(pickerFileUris(draft)).toEqual([]);
    expect(summarizeMainAppImport(draft)).toMatchObject({
      selectedCount: 1,
      source: 'main-app-picker',
    });
  });
  test('preserves picker order and exposes count, types, size, and unsupported items', () => {
    const created = createMainAppImportDraft(() => ingestionId);
    const edited = appendPickerAssets(
      created,
      [
        {
          uri: 'file:///cache/first.png',
          mediaType: 'image/png',
          byteCount: 3,
        },
        {
          uri: 'file:///cache/second.pdf',
          mediaType: 'application/pdf',
          byteCount: 5,
        },
        {
          uri: 'file:///cache/third.zip',
          mediaType: 'application/zip',
          byteCount: 7,
        },
      ],
      idFactory(),
    );

    expect(edited.error).toBeUndefined();
    expect(edited.draft.items.map(item => item.order)).toEqual([0, 1, 2]);
    expect(pickerFileUris(edited.draft)).toEqual([
      'file:///cache/first.png',
      'file:///cache/second.pdf',
      'file:///cache/third.zip',
    ]);
    expect(summarizeMainAppImport(edited.draft)).toMatchObject({
      selectedCount: 3,
      estimatedByteCount: 15,
      source: 'main-app-picker',
      items: [
        { label: 'Photo 1' },
        { label: 'File 2' },
        { label: 'File 3', code: 'IMPORT_TYPE_UNSUPPORTED' },
      ],
    });
  });

  test('round-trips English, Chinese, emoji, code indentation, and a long URL exactly', () => {
    const text =
      'English 中文 🧪\nfunction fixture() {\n    return "保持缩进";\n}\n';
    const url = `https://example.invalid/${'路径/'.repeat(128)}?q=${'x'.repeat(
      2048,
    )}`;
    const createId = idFactory();
    let draft = createMainAppImportDraft(() => ingestionId);

    draft = appendTextEntry(draft, 'text', text, createId).draft;
    draft = appendTextEntry(draft, 'url', url, createId).draft;

    expect(draft.items).toEqual([
      expect.objectContaining({
        kind: 'text',
        text,
        byteCount: utf8ByteCount(text),
        declaredMediaType: 'text/plain',
      }),
      expect.objectContaining({
        kind: 'url',
        text: url,
        byteCount: utf8ByteCount(url),
        declaredMediaType: 'text/uri-list',
      }),
    ]);
    expect(summarizeMainAppImport(draft).source).toBe('main-app-text');
    expect(utf8ByteCount('A中🧪')).toBe(8);
  });

  test('rejects empty text, non-http URLs, and the twenty-first item without mutation', () => {
    const empty = createMainAppImportDraft(() => ingestionId);
    expect(appendTextEntry(empty, 'text', '').error).toBe('IMPORT_EMPTY_TEXT');
    expect(appendTextEntry(empty, 'url', 'file:///private/value').error).toBe(
      'IMPORT_URL_INVALID',
    );
    expect(appendTextEntry(empty, 'url', 'http:example.invalid').error).toBe(
      'IMPORT_URL_INVALID',
    );
    expect(
      appendTextEntry(empty, 'url', ' https://example.invalid').error,
    ).toBe('IMPORT_URL_INVALID');
    const full = appendPickerAssets(
      empty,
      Array.from({ length: 20 }, (_, index) => ({
        uri: `file:///cache/${index}.png`,
        mediaType: 'image/png',
        byteCount: 1,
      })),
      idFactory(),
    ).draft;
    const overflow = appendTextEntry(full, 'text', 'extra', () => ids[23]!);
    expect(overflow).toEqual({
      draft: full,
      error: 'IMPORT_ITEM_LIMIT_EXCEEDED',
    });
  });

  test('rejects oversized inline content before it enters the draft', () => {
    const empty = createMainAppImportDraft(() => ingestionId);
    const oversized = 'x'.repeat(MAIN_APP_IMPORT_MAX_TEXT_BYTES + 1);

    expect(appendTextEntry(empty, 'text', oversized)).toEqual({
      draft: empty,
      error: 'IMPORT_SIZE_LIMIT_EXCEEDED',
    });
    expect(
      appendTextEntry(empty, 'url', `https://example.invalid/${oversized}`),
    ).toEqual({
      draft: empty,
      error: 'IMPORT_SIZE_LIMIT_EXCEEDED',
    });
  });

  test('allows correction while reindexing and marks over-limit items before processing', () => {
    const createId = idFactory();
    let draft = appendPickerAssets(
      createMainAppImportDraft(() => ingestionId),
      [
        { uri: 'file:///cache/a.png', mediaType: 'image/png', byteCount: 1 },
        {
          uri: 'file:///cache/b.pdf',
          mediaType: 'application/pdf',
          byteCount: MAIN_APP_IMPORT_MAX_BINARY_BYTES + 1,
        },
      ],
      createId,
    ).draft;
    draft = appendTextEntry(draft, 'text', 'third', createId).draft;
    const moved = moveImportItem(draft, draft.items[2]!.id, -1);
    const removed = removeImportItem(moved, moved.items[0]!.id);

    expect(moved.items.map(item => item.kind)).toEqual([
      'file',
      'text',
      'file',
    ]);
    expect(removed.items.map(item => item.order)).toEqual([0, 1]);
    expect(summarizeMainAppImport(moved).items[2]).toMatchObject({
      code: 'IMPORT_SIZE_LIMIT_EXCEEDED',
    });
  });
});
