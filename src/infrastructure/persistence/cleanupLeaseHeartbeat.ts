import { DomainError } from '../../domain/errors';
import type { CleanupLeaseRepository } from './contracts';

export interface CleanupLeaseHeartbeat {
  readonly failure: Promise<never>;
  assertOwned(): void;
  stop(): Promise<unknown | undefined>;
}

/** Keeps the global cleanup/publication lease valid until its critical section joins. */
export function startCleanupLeaseHeartbeat(
  repository: CleanupLeaseRepository,
  ownerId: string,
  initialLogicalAt: string,
  leaseDurationMs: number,
  now: () => string,
): CleanupLeaseHeartbeat {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0)
    throw new DomainError('SCHEMA_INVALID');
  requireTimestamp(initialLogicalAt);
  const intervalMs = Math.max(1, Math.floor(leaseDurationMs / 3));
  let logicalAt = initialLogicalAt;
  let stopped = false;
  let failed = false;
  let failureValue: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // A caller may only need synchronous assertOwned checks; keep the rejection
  // observable without producing an unhandled-rejection side effect.
  failure.catch(() => undefined);
  const recordFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    failureValue = error;
    rejectFailure(error);
  };
  const checkLocalExpiry = (): void => {
    if (failed) return;
    try {
      const observedAt = now();
      requireTimestamp(observedAt);
      if (Date.parse(observedAt) >= Date.parse(logicalAt) + leaseDurationMs)
        recordFailure(new DomainError('PERSISTENCE_CONFLICT'));
    } catch (error) {
      recordFailure(error);
    }
  };
  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = (async () => {
        const wallClock = now();
        requireTimestamp(wallClock);
        const intervalFloor = new Date(
          Date.parse(logicalAt) + intervalMs,
        ).toISOString();
        const renewedAt = latestTimestamp([
          wallClock,
          logicalAt,
          intervalFloor,
        ]);
        const renewed = await repository.renewCleanupLease(
          ownerId,
          renewedAt,
          new Date(Date.parse(renewedAt) + leaseDurationMs).toISOString(),
        );
        if (!renewed) throw new DomainError('PERSISTENCE_CONFLICT');
        logicalAt = renewedAt;
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
    failure,
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

function latestTimestamp(values: readonly string[]): string {
  values.forEach(requireTimestamp);
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new DomainError('SCHEMA_INVALID');
}
