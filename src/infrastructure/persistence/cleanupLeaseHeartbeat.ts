import { DomainError } from '../../domain/errors';
import type { CleanupLeaseRepository } from './contracts';
import { monotonicNowMilliseconds } from './operationalLeaseClock';

export interface CleanupLeaseHeartbeat {
  readonly failure: Promise<never>;
  assertOwned(): void;
  stop(): Promise<unknown | undefined>;
}

/** Keeps the global cleanup/publication lease valid until its critical section joins. */
export function startCleanupLeaseHeartbeat(
  repository: CleanupLeaseRepository,
  ownerId: string,
  initialObservedAt: string,
  leaseDurationMs: number,
  now: () => string,
  monotonicNow: () => number = monotonicNowMilliseconds,
): CleanupLeaseHeartbeat {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0)
    throw new DomainError('SCHEMA_INVALID');
  requireTimestamp(initialObservedAt);
  const intervalMs = Math.max(1, Math.floor(leaseDurationMs / 3));
  let localDeadline = requireMonotonicNow(monotonicNow) + leaseDurationMs;
  let stopped = false;
  let failed = false;
  let failureValue: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();
  let failureObserved = false;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const recordFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    failureValue = error;
    if (failureObserved) rejectFailure(error);
  };
  const recordSynchronousFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    failureValue = error;
  };
  const checkLocalExpiry = (): void => {
    if (failed) return;
    try {
      if (requireMonotonicNow(monotonicNow) >= localDeadline)
        recordSynchronousFailure(new DomainError('PERSISTENCE_CONFLICT'));
    } catch (error) {
      recordSynchronousFailure(error);
    }
  };
  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = (async () => {
        const wallClock = now();
        requireTimestamp(wallClock);
        const renewedAt = wallClock;
        const renewed = await repository.renewCleanupLease(
          ownerId,
          renewedAt,
          new Date(Date.parse(renewedAt) + leaseDurationMs).toISOString(),
        );
        if (!renewed) throw new DomainError('PERSISTENCE_CONFLICT');
        localDeadline = requireMonotonicNow(monotonicNow) + leaseDurationMs;
      })();
      inFlight.then(() => {
        if (!stopped) schedule();
      }, recordFailure);
    }, intervalMs);
    // Node-only test/runtime convenience; React Native timeout handles are numeric.
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  schedule();
  return {
    get failure() {
      failureObserved = true;
      return failed ? Promise.reject(failureValue) : failure;
    },
    assertOwned: () => {
      // Timers do not run while the app/event loop is suspended. Detect the
      // elapsed local TTL synchronously before allowing any post-await native
      // or database mutation, even if the delayed renewal callback has not run.
      checkLocalExpiry();
      if (failed)
        throw failureValue instanceof Error
          ? failureValue
          : new DomainError('PERSISTENCE_CONFLICT');
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight.catch(() => undefined);
      checkLocalExpiry();
      return failed ? failureValue : undefined;
    },
  };
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new DomainError('SCHEMA_INVALID');
}

function requireMonotonicNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0)
    throw new DomainError('SCHEMA_INVALID');
  return value;
}
