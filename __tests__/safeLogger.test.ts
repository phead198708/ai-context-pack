import { safeLog } from '../src/infrastructure/safeLogger';
test('safe logger rejects content-shaped fields', () => {
  expect(() =>
    safeLog('import_completed', { filename: 'fixture.png' } as never),
  ).toThrow('UNSAFE_LOG_FIELD:filename');
});

test('safe logger rejects user-controlled strings in approved fields', () => {
  expect(() =>
    safeLog('ocr_completed', { code: 'secret text' } as never),
  ).toThrow('UNSAFE_LOG_VALUE:code');
  expect(() =>
    safeLog('import_completed', { anonymousId: 'fixture.png' }),
  ).toThrow('UNSAFE_LOG_VALUE:anonymousId');
  expect(() => safeLog('fixture text' as never)).toThrow('UNSAFE_LOG_EVENT');
});

test('safe logger accepts constrained metadata', () => {
  const spy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  safeLog('ocr_completed', {
    engine: 'ml-kit-latin',
    durationMs: 12,
    version: '16.0.1',
    anonymousId: 'f'.repeat(64),
  });
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
