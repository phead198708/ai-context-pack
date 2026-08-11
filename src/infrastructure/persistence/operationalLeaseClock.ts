import { createCanonicalUuid } from '../../domain/canonicalUuid';
import { DomainError } from '../../domain/errors';

/**
 * Operational ownership must not depend on the user-adjustable wall clock.
 * A new process receives a new session ID, so leases from a terminated process
 * are stale immediately. Within one process, monotonic deadlines survive wall
 * clock corrections and timer suspension.
 */
export interface OperationalLeaseClock {
  readonly sessionId: string;
  nowMilliseconds(): number;
}

let fallbackMilliseconds = 0;

export function monotonicNowMilliseconds(): number {
  const performanceNow = (
    globalThis as { readonly performance?: { now(): number } }
  ).performance?.now();
  if (Number.isFinite(performanceNow) && performanceNow !== undefined)
    return performanceNow;
  // The fallback is deliberately nondecreasing. Process replacement is fenced
  // by sessionId, so it does not need to remain comparable across restarts.
  fallbackMilliseconds = Math.max(fallbackMilliseconds + 1, Date.now());
  return fallbackMilliseconds;
}

export const processOperationalLeaseClock: OperationalLeaseClock = {
  sessionId: createCanonicalUuid(),
  nowMilliseconds: monotonicNowMilliseconds,
};

export function observeOperationalMilliseconds(
  clock: OperationalLeaseClock,
): number {
  const value = clock.nowMilliseconds();
  if (!Number.isFinite(value) || value < 0)
    throw new DomainError('SCHEMA_INVALID');
  return value;
}
