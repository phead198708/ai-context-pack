import type { ImportManifestV1 } from './contracts';
import {
  isPendingShareEvent,
  type PendingShareEvent,
} from './shareImportResult';
import type { NativeAdapter } from './nativeAdapter';

export type InboxWorkflowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly manifests: readonly ImportManifestV1[] }
  | { readonly kind: 'error'; readonly code: string };

export interface InboxWorkflowView {
  setState(state: InboxWorkflowState): void;
  showNewestImport(): void;
}

/** Serializes cold/live/lifecycle inputs so event IDs have one owner and one ACK path. */
export class InboxEventWorkflow {
  private chain = Promise.resolve();
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, PendingShareEvent>();
  private readonly completes = new Map<string, PendingShareEvent>();
  private readonly blockers = new Map<string, string>();

  constructor(
    private readonly native: NativeAdapter,
    private readonly view: InboxWorkflowView,
  ) {}

  bootstrap(): Promise<void> {
    return this.enqueue(async () => {
      await this.refresh(false, false);
      let events: readonly PendingShareEvent[];
      try {
        events = await this.native.getPendingShareEvents();
      } catch (error) {
        this.latch(
          'event-store',
          error,
          'NATIVE_SHARE_EVENT_STORE_READ_FAILED',
        );
        return;
      }
      for (const event of events) await this.process(event);
    });
  }

  receive(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (!isPendingShareEvent(value)) {
        this.latch(
          `invalid:${validEventId(value) ?? 'live'}`,
          null,
          'NATIVE_SHARE_EVENT_INVALID',
        );
        return;
      }
      await this.process(value);
    });
  }

  appBecameActive(): Promise<void> {
    return this.enqueue(async () => {
      if (this.blockers.size === 0) await this.refresh(false, false);
    });
  }

  retry(): Promise<void> {
    return this.enqueue(async () => {
      let events: readonly PendingShareEvent[];
      try {
        events = await this.native.getPendingShareEvents();
        this.clear('event-store');
        this.clearPrefix('invalid:');
      } catch (error) {
        this.latch(
          'event-store',
          error,
          'NATIVE_SHARE_EVENT_STORE_READ_FAILED',
        );
        return;
      }
      for (const event of events) await this.process(event, true);

      for (const [id, event] of [...this.failures]) {
        try {
          if (event.durable === false)
            await this.native.ackEphemeralShareEvent(id);
          else await this.native.ackPendingShareEvent(id);
          this.failures.delete(id);
          this.clear(`failure:${id}`);
        } catch (error) {
          this.latch(
            `failure:${id}`,
            error,
            event.durable === false
              ? 'NATIVE_EPHEMERAL_ACK_FAILED'
              : 'NATIVE_SHARE_ACK_FAILED',
          );
          return;
        }
      }

      try {
        let recovery = await this.native.getPendingRecoveryEvent();
        while (recovery) {
          await this.native.ackRecoveryEvent(recovery.id);
          this.clear(`recovery:${recovery.id}`);
          recovery = await this.native.getPendingRecoveryEvent();
        }
        this.clear('recovery-ack');
      } catch (error) {
        this.latch('recovery-ack', error, 'NATIVE_RECOVERY_ACK_FAILED');
        return;
      }

      for (const event of [...this.completes.values()])
        if (!(await this.finishComplete(event, true))) return;
      if (this.failures.size === 0 && this.completes.size === 0)
        await this.refresh(false, true);
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const guarded = async () => {
      try {
        await work();
      } catch (error) {
        this.latch('unexpected', error, 'INBOX_WORKFLOW_UNEXPECTED');
      }
    };
    const result = this.chain.then(guarded, guarded);
    this.chain = result;
    return result;
  }

  private async process(
    event: PendingShareEvent,
    retrying = false,
  ): Promise<void> {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (event.result === 'failed') {
      this.failures.set(event.id, event);
      this.latch(
        `failure:${event.id}`,
        null,
        event.code ?? 'SHARE_IMPORT_FAILED',
      );
      return;
    }
    this.completes.set(event.id, event);
    if (retrying || !this.hasOperationalBlocker())
      await this.finishComplete(event, retrying);
  }

  private async finishComplete(
    event: PendingShareEvent,
    retrying: boolean,
  ): Promise<boolean> {
    const manifests = await this.scan(retrying);
    if (!manifests) return false;
    try {
      if (event.durable === false)
        await this.native.ackEphemeralShareEvent(event.id);
      else await this.native.ackPendingShareEvent(event.id);
      this.completes.delete(event.id);
      this.clear(`complete-ack:${event.id}`);
    } catch (error) {
      this.latch(
        `complete-ack:${event.id}`,
        error,
        event.durable === false
          ? 'NATIVE_EPHEMERAL_ACK_FAILED'
          : 'NATIVE_SHARE_ACK_FAILED',
      );
      return false;
    }
    if (this.blockers.size === 0) {
      this.show(manifests);
      if (manifests.length > 0) this.view.showNewestImport();
    }
    return true;
  }

  private async refresh(
    showNewest: boolean,
    retrying: boolean,
  ): Promise<boolean> {
    const manifests = await this.scan(retrying);
    if (!manifests) return false;
    if (retrying) this.clear('unexpected');
    if (this.blockers.size === 0) {
      this.show(manifests);
      if (showNewest && manifests.length > 0) this.view.showNewestImport();
    }
    return true;
  }

  private async scan(
    retrying: boolean,
  ): Promise<readonly ImportManifestV1[] | null> {
    if (this.blockers.size === 0) this.view.setState({ kind: 'loading' });
    try {
      const recovery = await this.native.getPendingRecoveryEvent();
      if (recovery) {
        this.latch(`recovery:${recovery.id}`, null, recovery.code);
        return null;
      }
      const manifests = await this.native.scanInbox();
      if (retrying) this.clear('scan');
      return manifests;
    } catch (error) {
      this.latch('scan', error, 'INBOX_SCAN_FAILED');
      return null;
    }
  }

  private show(manifests: readonly ImportManifestV1[]): void {
    this.view.setState(
      manifests.length === 0 ? { kind: 'empty' } : { kind: 'ready', manifests },
    );
  }

  private hasOperationalBlocker(): boolean {
    return [...this.blockers.keys()].some(key => !key.startsWith('failure:'));
  }

  private latch(key: string, error: unknown, fallback: string): void {
    const code = workflowErrorCode(error, fallback);
    if (this.blockers.get(key) === code) return;
    this.blockers.set(key, code);
    this.view.setState({ kind: 'error', code });
  }

  private clear(key: string): void {
    this.blockers.delete(key);
  }

  private clearPrefix(prefix: string): void {
    for (const key of this.blockers.keys())
      if (key.startsWith(prefix)) this.blockers.delete(key);
  }
}

function validEventId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
    ? id
    : null;
}

function workflowErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) return fallback;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : fallback;
}
