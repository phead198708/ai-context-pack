/**
 * Serializes native ArtifactStore mutations inside one app process.
 *
 * SQLite's renewable lease remains the cross-instance/restart authority. This
 * non-expiring join lock closes the suspend/expiry hand-off window: a new lease
 * owner cannot start native mutation until the older in-process critical
 * section has returned and observed its lost/expired lease.
 */
let tail: Promise<void> = Promise.resolve();

export async function acquireArtifactLifecycleMutex(): Promise<() => void> {
  const previous = tail;
  let releaseCurrent!: () => void;
  tail = new Promise<void>(resolve => {
    releaseCurrent = resolve;
  });
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
  };
}
