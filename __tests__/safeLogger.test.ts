import { safeLog } from '../src/infrastructure/safeLogger';
test('safe logger rejects content-shaped fields', () => {
  expect(() => safeLog('import', { filename: 'fixture.png' })).toThrow(
    'UNSAFE_LOG_FIELD:filename',
  );
});
