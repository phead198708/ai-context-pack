import type { ImportManifestV1 } from './contracts';
import { isCanonicalUuid } from './canonicalUuid';
import type { ContextPack } from './models';
import {
  isPendingShareEvent,
  type PendingShareEvent,
} from './shareImportResult';
import type { NativeAdapter } from './nativeAdapter';

export type InboxWorkflowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly warningCode?: string }
  | {
      readonly kind: 'ready';
      readonly manifests: readonly ImportManifestV1[];
      /** Present in production; persisted Packs are the display source of truth. */
      readonly packs?: readonly InboxPackSummary[];
      /** A failed share item remains retryable without hiding successfully persisted Packs. */
      readonly warningCode?: string;
    }
  | { readonly kind: 'error'; readonly code: string };

export interface InboxPackSummary {
  readonly id: string;
  readonly schemaVersion: ContextPack['schemaVersion'];
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ContextPack['state'];
  readonly itemCount: number;
  readonly import?: InboxPersistedImportSummary;
}

export interface InboxPersistedImportSummary {
  readonly ingestionId: string;
  readonly status: ImportManifestV1['status'];
  readonly items: readonly {
    readonly id: string;
    readonly order: number;
    readonly mediaType: string;
    readonly status: ImportManifestV1['items'][number]['status'];
    readonly errorCode?: string;
    readonly retrySource?: {
      readonly relativePath: string;
      readonly byteCount: number;
      readonly sha256: string;
    };
  }[];
}

export interface InboxWorkflowView {
  setState(state: InboxWorkflowState): void;
  showNewestImport(): void;
}

export interface InboxManifestProcessor {
  process(manifests: readonly ImportManifestV1[]): Promise<void>;
  /** Hydrates the durable product state after Inbox recovery and ACK. */
  listPersistedPacks?(): Promise<readonly InboxPackSummary[]>;
}

const passthroughManifestProcessor: InboxManifestProcessor = {
  process: async () => undefined,
};

/** Serializes cold/live/lifecycle inputs so event IDs have one owner and one ACK path. */
export class InboxEventWorkflow {
  private chain = Promise.resolve();
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, PendingShareEvent>();
  private readonly completes = new Map<string, PendingShareEvent>();
  private readonly blockers = new Map<string, string>();
  private pickerCacheRecovered = false;

  constructor(
    private readonly native: NativeAdapter,
    private readonly view: InboxWorkflowView,
    private readonly manifestProcessor: InboxManifestProcessor = passthroughManifestProcessor,
  ) {}

  bootstrap(): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.recoverPickerCache(false))) return;
      await this.refresh(false, false);
      const bootstrapManifests = this.lastScannedManifests;
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
      for (const event of events)
        await this.process(event, false, bootstrapManifests);
      this.lastScannedManifests = undefined;
    });
  }

  /** Pack creation stays fail-closed until native picker-cache recovery succeeds. */
  isPickerCacheRecovered(): boolean {
    return this.pickerCacheRecovered;
  }

  /**
   * Pack creation also stays closed while an operational Inbox failure is latched. A failed
   * share item is user-visible and independently retryable, so it does not poison unrelated
   * main-app imports.
   */
  isPackCreationReady(): boolean {
    return this.pickerCacheRecovered && !this.hasOperationalBlocker();
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
      await this.process(value, false, this.takeScannedManifests(value.id));
    });
  }

  appBecameActive(): Promise<void> {
    return this.enqueue(async () => {
      if (this.blockers.size === 0) await this.refresh(false, false);
    });
  }

  /**
   * Refreshes a just-published main-app import and reports persistence failure to its caller.
   * Lifecycle refreshes intentionally latch errors for the Inbox UI, while the import flow must
   * also know that publication is not yet complete so it cannot display a false success state.
   */
  async refreshForMainAppImport(): Promise<void> {
    let outcome:
      | { readonly ok: true }
      | { readonly ok: false; readonly code: string }
      | undefined;
    await this.enqueue(async () => {
      // A retry from the locked import flow must be allowed to clear a prior scan/persistence
      // latch. Other operational blockers remain visible and still make the result fail closed.
      const refreshed = await this.refresh(false, true);
      outcome =
        refreshed && !this.hasOperationalBlocker()
          ? { ok: true }
          : { ok: false, code: this.latestBlockerCode() };
    });
    if (!outcome || !outcome.ok)
      throw new InboxWorkflowRefreshError(
        outcome?.code ?? this.latestBlockerCode(),
      );
  }

  retry(): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.recoverPickerCache(true))) return;
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

      let completedRefresh = false;
      for (const event of [...this.completes.values()]) {
        if (!(await this.finishComplete(event, true))) return;
        completedRefresh = true;
      }
      if (
        !completedRefresh &&
        this.failures.size === 0 &&
        this.completes.size === 0
      )
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
    knownManifests?: readonly ImportManifestV1[],
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
      await this.finishComplete(event, retrying, knownManifests);
  }

  private async finishComplete(
    event: PendingShareEvent,
    retrying: boolean,
    knownManifests?: readonly ImportManifestV1[],
  ): Promise<boolean> {
    const manifests = knownManifests ?? (await this.scan(retrying));
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
    if (!this.hasOperationalBlocker()) {
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
    if (!this.hasOperationalBlocker()) {
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
      await this.manifestProcessor.process(manifests);
      this.lastPersistedPacks =
        await this.manifestProcessor.listPersistedPacks?.();
      this.lastScannedManifests = manifests;
      if (retrying) this.clear('scan');
      return manifests;
    } catch (error) {
      this.latch('scan', error, 'INBOX_SCAN_FAILED');
      return null;
    }
  }

  private async recoverPickerCache(retrying: boolean): Promise<boolean> {
    try {
      await this.native.recoverMainAppPickerCache();
      this.pickerCacheRecovered = true;
      if (retrying) this.clear('main-app-picker-cache');
      return true;
    } catch (error) {
      this.pickerCacheRecovered = false;
      this.latch(
        'main-app-picker-cache',
        error,
        'MAIN_APP_IMPORT_CLEANUP_FAILED',
      );
      return false;
    }
  }

  private lastScannedManifests: readonly ImportManifestV1[] | undefined;
  private lastPersistedPacks: readonly InboxPackSummary[] | undefined;

  private takeScannedManifests(
    ingestionId: string,
  ): readonly ImportManifestV1[] | undefined {
    const manifests = this.lastScannedManifests;
    if (!manifests?.some(manifest => manifest.ingestionId === ingestionId))
      return undefined;
    this.lastScannedManifests = manifests.filter(
      manifest => manifest.ingestionId !== ingestionId,
    );
    return manifests;
  }

  private show(manifests: readonly ImportManifestV1[]): void {
    const warningCode = this.latestFailureBlockerCode();
    if (this.lastPersistedPacks !== undefined) {
      this.view.setState(
        this.lastPersistedPacks.length === 0
          ? { kind: 'empty', ...(warningCode ? { warningCode } : {}) }
          : {
              kind: 'ready',
              manifests,
              packs: this.lastPersistedPacks,
              ...(warningCode ? { warningCode } : {}),
            },
      );
      return;
    }
    this.view.setState(
      manifests.length === 0
        ? { kind: 'empty', ...(warningCode ? { warningCode } : {}) }
        : {
            kind: 'ready',
            manifests,
            ...(warningCode ? { warningCode } : {}),
          },
    );
  }

  private hasOperationalBlocker(): boolean {
    return [...this.blockers.keys()].some(key => !key.startsWith('failure:'));
  }

  private latestBlockerCode(): string {
    return [...this.blockers.values()].at(-1) ?? 'INBOX_SCAN_FAILED';
  }

  private latestFailureBlockerCode(): string | undefined {
    return [...this.blockers]
      .filter(([key]) => key.startsWith('failure:'))
      .at(-1)?.[1];
  }

  private latch(key: string, error: unknown, fallback: string): void {
    const code = workflowErrorCode(error, fallback);
    if (this.blockers.get(key) === code) return;
    this.blockers.set(key, code);
    if (
      key.startsWith('failure:') &&
      (this.lastPersistedPacks !== undefined ||
        this.lastScannedManifests !== undefined)
    ) {
      this.show(this.lastScannedManifests ?? []);
      return;
    }
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

class InboxWorkflowRefreshError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'InboxWorkflowRefreshError';
    this.code = code;
  }
}

function validEventId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return isCanonicalUuid(value.id) ? value.id : null;
}

function workflowErrorCode(error: unknown, fallback: string): string {
  if (!isRecord(error)) return fallback;
  return typeof error.code === 'string' ? error.code : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
