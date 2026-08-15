import { DomainError } from '../src/domain/errors';
import {
  compareIsoDateTimes,
  isIsoDateTime,
  latestIsoDateTime,
} from '../src/domain/isoDateTime';

describe('canonical UTC timestamps', () => {
  test('accepts real leap days and rejects normalized calendar dates', () => {
    expect(isIsoDateTime('2024-02-29T23:59:59.123456789Z')).toBe(true);
    expect(isIsoDateTime('2026-02-29T00:00:00Z')).toBe(false);
    expect(isIsoDateTime('2026-02-30T00:00:00Z')).toBe(false);
    expect(isIsoDateTime('2026-04-31T00:00:00Z')).toBe(false);
    expect(isIsoDateTime('2026-13-01T00:00:00Z')).toBe(false);
    expect(isIsoDateTime('2026-01-01T24:00:00Z')).toBe(false);
  });

  test('orders valid instants at all nine supported fractional digits', () => {
    const earlier = '2026-03-01T00:00:00.000000001Z';
    const later = '2026-03-01T00:00:00.000000999Z';

    expect(compareIsoDateTimes(earlier, later)).toBe(-1);
    expect(compareIsoDateTimes(later, earlier)).toBe(1);
    expect(latestIsoDateTime([later, earlier])).toBe(later);
  });

  test('fails closed before comparing an invalid encoded instant', () => {
    expect(() =>
      latestIsoDateTime(['2026-02-30T00:00:00Z', '2026-03-01T00:00:00Z']),
    ).toThrow(new DomainError('SCHEMA_INVALID'));
  });
});
