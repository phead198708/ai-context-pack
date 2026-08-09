import { DomainError } from '../src/domain/errors';
import {
  extractURL,
  isPlainTextExtractionV1,
  normalizePlainText,
  PLAIN_TEXT_MAXIMUM_BYTES,
  URL_MAXIMUM_BYTES,
} from '../src/domain/extraction';

describe('plain-text extraction', () => {
  test('normalizes BOM, line endings, and unsafe controls without changing indentation', () => {
    const source = '\uFEFF标题\r\n```ts\r\n\tconst emoji = "👩🏽‍💻";\u0000\r```';

    expect(normalizePlainText(source)).toEqual({
      schemaVersion: 1,
      kind: 'plain-text',
      text: '标题\n```ts\n\tconst emoji = "👩🏽‍💻";\uFFFD\n```',
      characterCount: 39,
      sourceByteCount: 56,
      encoding: 'utf-8',
      warnings: [
        'TEXT_BOM_REMOVED',
        'TEXT_LINE_ENDINGS_NORMALIZED',
        'TEXT_UNSAFE_CONTROL_REPLACED',
      ],
    });
  });

  test('preserves Chinese, emoji, combining characters, spaces, and fenced code', () => {
    const source = '中文 👩🏽‍💻 e\u0301\n```python\n    print("ok")\n```';
    const result = normalizePlainText(source);

    expect(result.text).toBe(source);
    expect(result.characterCount).toBe(source.length);
    expect(result.warnings).toEqual([]);
  });

  test('fails closed on invalid Unicode, mismatched bytes, and the first over-limit byte', () => {
    expect(() => normalizePlainText('\uD800')).toThrow(
      new DomainError('TEXT_INVALID_UTF8'),
    );
    expect(() => normalizePlainText('abc', 2)).toThrow(
      new DomainError('TEXT_INVALID_UTF8'),
    );
    expect(() =>
      normalizePlainText('a'.repeat(PLAIN_TEXT_MAXIMUM_BYTES + 1)),
    ).toThrow(new DomainError('TEXT_TOO_LARGE'));
  });

  test('rejects forged results that are not bounded normalized text', () => {
    const valid = normalizePlainText('    const value = "中文 👩🏽‍💻";');
    expect(isPlainTextExtractionV1(valid)).toBe(true);

    for (const result of [
      { ...valid, text: 'abc\r', characterCount: 4, sourceByteCount: 4 },
      { ...valid, text: '\u0000', characterCount: 1, sourceByteCount: 1 },
      { ...valid, text: '\uFEFFabc', characterCount: 4, sourceByteCount: 6 },
      { ...valid, text: 'four', characterCount: 4, sourceByteCount: 3 },
    ])
      expect(isPlainTextExtractionV1(result)).toBe(false);
  });
});

describe('URL extraction', () => {
  test('preserves the exact URL and metadata while redacting normal display', () => {
    const original =
      'https://user:secret@example.test/a%20path?token=abc&token=二&empty=#private';
    const result = extractURL(original, {
      title: '标题\r\nTitle',
      selectedText: '    const value = "👩🏽‍💻";',
    });

    expect(result.originalUrl).toBe(original);
    expect(result.displayUrl).toBe(
      'https://[REDACTED]@example.test/a%20path?token=[REDACTED]&token=[REDACTED]&empty=[REDACTED]#[REDACTED]',
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 'url',
      scheme: 'https',
      host: 'example.test',
      path: '/a%20path',
      title: { text: '标题\nTitle' },
      selectedText: { text: '    const value = "👩🏽‍💻";' },
      warnings: [
        'URL_CREDENTIAL_REDACTED',
        'URL_QUERY_VALUES_REDACTED',
        'URL_FRAGMENT_REDACTED',
      ],
    });
  });

  test('does not fetch, crawl, resolve, or otherwise require network APIs', () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = jest.fn(() => {
      throw new Error('network must not be called');
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchSpy,
    });
    try {
      expect(extractURL('https://offline.invalid/path?q=secret')).toMatchObject(
        {
          originalUrl: 'https://offline.invalid/path?q=secret',
          displayUrl: 'https://offline.invalid/path?q=[REDACTED]',
        },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      });
    }
  });

  test('preserves a long URL locally while keeping its long query value out of display', () => {
    const longPath = 'p'.repeat(32_768);
    const longSecret = 's'.repeat(8_192);
    const original = `https://example.test/${longPath}?token=${longSecret}`;

    const result = extractURL(original);

    expect(result.originalUrl).toBe(original);
    expect(result.path).toBe(`/${longPath}`);
    expect(result.displayUrl).toBe(
      `https://example.test/${longPath}?token=[REDACTED]`,
    );
    expect(result.displayUrl).not.toContain(longSecret);
  });

  test('rejects unsafe schemes, whitespace/control injection, and over-limit URLs', () => {
    for (const invalid of [
      'file:///private/document.pdf',
      `${'java'}script:alert(1)`,
      ' https://example.test',
      'https://example.test/path\nheader: value',
      'https://',
    ])
      expect(() => extractURL(invalid)).toThrow(new DomainError('URL_INVALID'));

    expect(() =>
      extractURL(`https://example.test/${'a'.repeat(URL_MAXIMUM_BYTES)}`),
    ).toThrow(new DomainError('URL_TOO_LONG'));
  });
});
