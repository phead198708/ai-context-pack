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

  constructor(
    private readonly native: NativeAdapter,
    private readonly view: InboxWorkflowView,
  ) {}

  bootstrap(): Promise<void> {
    return this.enqueue(async () => {
      await this.refresh(false);
      let events: readonly PendingShareEvent[];
      try {
        events = await this.native.getPendingShareEvents();
      } catch (error) {
        this.fail(error, 'NATIVE_SHARE_EVENT_STORE_READ_FAILED');
        return;
      }
      for (const event of events) await this.process(event);
    });
  }

  receive(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (!isPendingShareEvent(value)) {
        this.view.setState({
          kind: 'error',
          code: 'NATIVE_SHARE_EVENT_INVALID',
        });
        return;
      }
      await this.process(value);
    });
  }

  appBecameActive(): Promise<void> {
    return this.enqueue(async () => {
      if (this.failures.size === 0) await this.refresh(false);
    });
  }

  retry(): Promise<void> {
    return this.enqueue(async () => {
      for (const [id, event] of [...this.failures]) {
        try {
          if (event.durable === false)
            await this.native.ackEphemeralShareEvent(id);
          else await this.native.ackPendingShareEvent(id);
          this.failures.delete(id);
        } catch (error) {
          this.fail(error, 'NATIVE_SHARE_ACK_FAILED');
          return;
        }
      }

      try {
        let recovery = await this.native.getPendingRecoveryEvent();
        while (recovery) {
          await this.native.ackRecoveryEvent(recovery.id);
          recovery = await this.native.getPendingRecoveryEvent();
        }
      } catch (error) {
        this.fail(error, 'NATIVE_RECOVERY_ACK_FAILED');
        return;
      }

      for (const event of [...this.completes.values()])
        if (!(await this.finishComplete(event))) return;
      if (this.failures.size === 0 && this.completes.size === 0)
        await this.refresh(false);
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async process(event: PendingShareEvent): Promise<void> {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (event.result === 'failed') {
      this.failures.set(event.id, event);
      this.view.setState({
        kind: 'error',
        code: event.code ?? 'SHARE_IMPORT_FAILED',
      });
      return;
    }
    this.completes.set(event.id, event);
    await this.finishComplete(event);
  }

  private async finishComplete(event: PendingShareEvent): Promise<boolean> {
    const manifests = await this.scan();
    if (!manifests) return false;
    try {
      if (event.durable === false)
        await this.native.ackEphemeralShareEvent(event.id);
      else await this.native.ackPendingShareEvent(event.id);
      this.completes.delete(event.id);
    } catch (error) {
      this.fail(error, 'NATIVE_SHARE_ACK_FAILED');
      return false;
    }
    if (this.failures.size === 0) {
      this.show(manifests);
      if (manifests.length > 0) this.view.showNewestImport();
    }
    return true;
  }

  private async refresh(showNewest: boolean): Promise<boolean> {
    const manifests = await this.scan();
    if (!manifests) return false;
    if (this.failures.size === 0) {
      this.show(manifests);
      if (showNewest && manifests.length > 0) this.view.showNewestImport();
    }
    return true;
  }

  private async scan(): Promise<readonly ImportManifestV1[] | null> {
    if (this.failures.size === 0) this.view.setState({ kind: 'loading' });
    try {
      const recovery = await this.native.getPendingRecoveryEvent();
      if (recovery) {
        this.view.setState({ kind: 'error', code: recovery.code });
        return null;
      }
      return await this.native.scanInbox();
    } catch (error) {
      this.fail(error, 'INBOX_SCAN_FAILED');
      return null;
    }
  }

  private show(manifests: readonly ImportManifestV1[]): void {
    this.view.setState(
      manifests.length === 0 ? { kind: 'empty' } : { kind: 'ready', manifests },
    );
  }

  private fail(error: unknown, fallback: string): void {
    this.view.setState({
      kind: 'error',
      code: workflowErrorCode(error, fallback),
    });
  }
}

function workflowErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) return fallback;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : fallback;
}
