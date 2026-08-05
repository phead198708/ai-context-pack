import { safeLog, serializeSafeLog } from '../src/infrastructure/safeLogger';

const forbiddenFields = [
  'text',
  'ocrText',
  'filename',
  'url',
  'fileBytes',
  'detectorMatch',
] as const;

describe('privacy-safe shared logger', () => {
  test.each(forbiddenFields)(
    'rejects content field %s before the sink',
    key => {
      const sink = jest.fn();
      expect(() =>
        safeLog(
          'import_completed',
          { [key]: 'synthetic-private-value' } as never,
          sink,
        ),
      ).toThrow(`UNSAFE_LOG_FIELD:${key}`);
      expect(sink).not.toHaveBeenCalled();
    },
  );

  test('rejects symbol keys, accessors, arrays, and non-plain objects', () => {
    const symbolFields = { [Symbol('text')]: 'synthetic-private-value' };
    const accessorFields = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => 'synthetic-private-value',
    });
    expect(() => serializeSafeLog('inbox_scan', symbolFields)).toThrow(
      'UNSAFE_LOG_FIELD:Symbol(text)',
    );
    expect(() => serializeSafeLog('inbox_scan', accessorFields)).toThrow(
      'UNSAFE_LOG_FIELD:version',
    );
    expect(() => serializeSafeLog('inbox_scan', [])).toThrow(
      'UNSAFE_LOG_FIELDS',
    );
    expect(() => serializeSafeLog('inbox_scan', new Date())).toThrow(
      'UNSAFE_LOG_FIELDS',
    );
  });

  test('rejects user-controlled strings in approved fields', () => {
    expect(() =>
      serializeSafeLog('ocr_completed', { code: 'secret text' }),
    ).toThrow('UNSAFE_LOG_VALUE:code');
    expect(() =>
      serializeSafeLog('ocr_completed', { version: 'private/path' }),
    ).toThrow('UNSAFE_LOG_VALUE:version');
    expect(() =>
      serializeSafeLog('import_completed', { anonymousId: 'fixture.png' }),
    ).toThrow('UNSAFE_LOG_VALUE:anonymousId');
    expect(() => serializeSafeLog('fixture text')).toThrow('UNSAFE_LOG_EVENT');
  });

  test.each([
    ['count', -1],
    ['count', 1.5],
    ['bytes', Number.MAX_SAFE_INTEGER + 1],
    ['durationMs', Number.NaN],
    ['durationMs', Number.POSITIVE_INFINITY],
  ])('rejects unsafe numeric %s=%s', (key, value) => {
    expect(() => serializeSafeLog('inbox_scan', { [key]: value })).toThrow(
      `UNSAFE_LOG_VALUE:${key}`,
    );
  });

  test('serializes only normalized allowlisted metadata', () => {
    const sink = jest.fn();
    safeLog(
      'ocr_completed',
      {
        engine: 'ml-kit-latin',
        durationMs: 12.5,
        version: '16.0.1',
        anonymousId: 'f'.repeat(64),
      },
      sink,
    );
    expect(sink).toHaveBeenCalledWith(
      `{"event":"ocr_completed","durationMs":12.5,"version":"16.0.1","engine":"ml-kit-latin","anonymousId":"${'f'.repeat(
        64,
      )}"}`,
    );
  });
});
