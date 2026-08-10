import React from 'react';
import {
  AppState,
  type AppStateStatus,
  BackHandler,
  DeviceEventEmitter,
  ScrollView,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import App from '../App';
import type { ImportManifestV1 } from '../src/domain/contracts';
import type {
  InboxManifestProcessor,
  InboxPackSummary,
} from '../src/domain/inboxEventWorkflow';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import { NativeBoundaryError } from '../src/infrastructure/createNativeAdapter';
import { nativeAdapter } from '../src/infrastructure/nativeAdapter';
import type { MainAppPicker } from '../src/infrastructure/mainAppPickers';
import { mainAppPicker } from '../src/infrastructure/mainAppPickers';
import {
  createEmptyDraftPack,
  persistenceInboxProcessor,
} from '../src/infrastructure/persistence/runtime';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('../src/infrastructure/nativeAdapter', () => ({
  nativeAdapter: {
    available: true,
    scanInbox: jest.fn(),
    getPendingShareEvents: jest.fn(),
    ackPendingShareEvent: jest.fn(),
    ackEphemeralShareEvent: jest.fn(),
    getPendingRecoveryEvent: jest.fn(),
    ackRecoveryEvent: jest.fn(),
    handoffInbox: jest.fn(),
    acknowledgeInbox: jest.fn(),
    publishMainAppImport: jest.fn(),
    stageMainAppPickerFiles: jest.fn(),
    cleanupMainAppPickerTransients: jest.fn(),
    recoverMainAppPickerCache: jest.fn(),
    discardMainAppPickerFiles: jest.fn(),
    publishArtifact: jest.fn(),
    verifyArtifact: jest.fn(),
    listOwnedArtifacts: jest.fn(),
    removeOwnedArtifact: jest.fn(),
    quarantineOwnedArtifact: jest.fn(),
    purgeArtifactQuarantine: jest.fn(),
    getArtifactStorageUsage: jest.fn(),
    recognizeText: jest.fn(),
    probePdf: jest.fn(),
  },
}));
jest.mock('../src/infrastructure/persistence/runtime', () => ({
  createEmptyDraftPack: jest.fn(),
  persistenceInboxProcessor: {
    process: jest.fn().mockResolvedValue(undefined),
    listPersistedPacks: jest.fn(),
  },
}));
jest.mock('../src/infrastructure/mainAppPickers', () => ({
  mainAppPicker: {
    pickPhotos: jest.fn(),
    pickFiles: jest.fn(),
  },
}));
jest.mock('../src/features/packLibrary/runtime', () => ({
  packLibraryController: {
    load: jest.fn().mockResolvedValue({
      sections: {
        draft: [],
        processing: [],
        'review-required': [],
        ready: [],
        exported: [],
        failed: [],
        cancelled: [],
      },
    }),
    renamePack: jest.fn(),
    editInstruction: jest.fn(),
    renameItem: jest.fn(),
    reorderItem: jest.fn(),
    removeItem: jest.fn(),
    retryItem: jest.fn(),
    cancelProcessing: jest.fn(),
  },
}));

const mockNative = nativeAdapter as jest.Mocked<NativeAdapter>;
const mockMainAppPicker = mainAppPicker as jest.Mocked<MainAppPicker>;
const mockPersistenceInboxProcessor =
  persistenceInboxProcessor as InboxManifestProcessor & {
    process: jest.Mock;
    listPersistedPacks: jest.Mock;
  };
const mockCreateEmptyDraftPack = createEmptyDraftPack as jest.MockedFunction<
  typeof createEmptyDraftPack
>;
const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
const eventId = '223e4567-e89b-42d3-a456-426614174000';
const newerPackId = '623e4567-e89b-42d3-a456-426614174000';
const manifest: ImportManifestV1 = {
  schemaVersion: 1,
  ingestionId,
  createdAt: '2026-01-01T00:00:00Z',
  source: 'android-share-intent',
  status: 'complete',
  items: [],
};
const partialManifest: ImportManifestV1 = {
  ...manifest,
  status: 'partial',
  items: [
    {
      id: '323e4567-e89b-42d3-a456-426614174000',
      order: 0,
      mediaType: 'image/png',
      status: 'copied',
      byteCount: 128,
      relativePath: '323e4567-e89b-42d3-a456-426614174000.bin',
    },
    {
      id: '423e4567-e89b-42d3-a456-426614174000',
      order: 1,
      mediaType: 'application/zip',
      status: 'failed',
      byteCount: 0,
      errorCode: 'IMPORT_TYPE_UNSUPPORTED',
    },
    {
      id: '523e4567-e89b-42d3-a456-426614174000',
      order: 2,
      mediaType: 'text/plain',
      status: 'failed',
      byteCount: 0,
      errorCode: 'IMPORT_COPY_FAILED',
    },
  ],
};
const persistedPack: InboxPackSummary = {
  id: ingestionId,
  schemaVersion: 1,
  title: 'Context Pack',
  createdAt: manifest.createdAt,
  updatedAt: manifest.createdAt,
  state: 'draft',
  itemCount: 0,
};

let appStateListener: ((state: AppStateStatus) => void) | undefined;
let inboxListener: ((event: unknown) => void) | undefined;
let openPackListener: ((event: unknown) => void) | undefined;
let appStateRemove: jest.Mock;
let inboxRemove: jest.Mock;
let openPackRemove: jest.Mock;
let backRemove: jest.Mock;
let hardwareBack:
  | Parameters<typeof BackHandler.addEventListener>[1]
  | undefined;

async function flushWorkflow(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function renderApp(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
    await flushWorkflow();
  });
  return renderer as ReactTestRenderer;
}

function renderedText(renderer: ReactTestRenderer): string {
  return instanceText(renderer.root);
}

function instanceText(node: ReactTestInstance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : instanceText(child)))
    .join('\n');
}

function control(
  renderer: ReactTestRenderer,
  role: 'button' | 'radio' | 'tab',
  label: string,
): ReactTestInstance {
  const match = renderer.root
    .findAll(node => node.props.accessibilityRole === role)
    .find(node => instanceText(node).replaceAll('\n', '') === label);
  if (!match) throw new Error(`Missing ${role}: ${label}`);
  return match;
}

async function press(target: ReactTestInstance): Promise<void> {
  await act(async () => {
    target.props.onPress();
    await flushWorkflow();
  });
}

describe('App interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPersistenceInboxProcessor.process.mockResolvedValue(undefined);
    mockPersistenceInboxProcessor.listPersistedPacks.mockReset();
    appStateListener = undefined;
    inboxListener = undefined;
    openPackListener = undefined;
    hardwareBack = undefined;
    appStateRemove = jest.fn();
    inboxRemove = jest.fn();
    openPackRemove = jest.fn();
    backRemove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      listener: (state: AppStateStatus) => void,
    ) => {
      appStateListener = listener;
      return { remove: appStateRemove };
    }) as typeof AppState.addEventListener);
    jest.spyOn(DeviceEventEmitter, 'addListener').mockImplementation(((
      name: string,
      listener: (event: unknown) => void,
    ) => {
      if (name === 'AIContextPackInboxChanged') {
        inboxListener = listener;
        return { remove: inboxRemove };
      }
      openPackListener = listener;
      return { remove: openPackRemove };
    }) as unknown as typeof DeviceEventEmitter.addListener);
    jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_name, listener) => {
        hardwareBack = listener;
        return { remove: backRemove };
      });
    mockMainAppPicker.pickPhotos.mockReset().mockResolvedValue({
      canceled: true,
      assets: [],
    });
    mockMainAppPicker.pickFiles.mockReset().mockResolvedValue({
      canceled: true,
      assets: [],
    });
    mockNative.scanInbox.mockResolvedValue([]);
    mockNative.getPendingShareEvents.mockResolvedValue([]);
    mockNative.ackPendingShareEvent.mockResolvedValue(undefined);
    mockNative.ackEphemeralShareEvent.mockResolvedValue(undefined);
    mockNative.getPendingRecoveryEvent.mockResolvedValue(null);
    mockNative.ackRecoveryEvent.mockResolvedValue(undefined);
    mockNative.acknowledgeInbox.mockResolvedValue(undefined);
    mockNative.stageMainAppPickerFiles.mockImplementation(async fileUris =>
      fileUris.map((_, index) => `file:///cache/staged-${index}.bin`),
    );
    mockNative.cleanupMainAppPickerTransients.mockResolvedValue(undefined);
    mockNative.recoverMainAppPickerCache.mockResolvedValue(undefined);
    mockCreateEmptyDraftPack.mockResolvedValue(persistedPack);
  });

  afterEach(() => jest.restoreAllMocks());

  test('bootstraps through the native adapter and removes all listeners', async () => {
    mockNative.scanInbox.mockResolvedValue([manifest]);
    const renderer = await renderApp();

    expect(renderedText(renderer)).toContain('Share import');
    expect(mockNative.scanInbox).toHaveBeenCalledTimes(1);
    expect(mockNative.getPendingShareEvents).toHaveBeenCalledTimes(1);
    expect(AppState.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );
    expect(DeviceEventEmitter.addListener).toHaveBeenCalledWith(
      'AIContextPackInboxChanged',
      expect.any(Function),
    );
    expect(DeviceEventEmitter.addListener).toHaveBeenCalledWith(
      'AIContextPackOpenPack',
      expect.any(Function),
    );
    expect(BackHandler.addEventListener).toHaveBeenCalledWith(
      'hardwareBackPress',
      expect.any(Function),
    );

    act(() => renderer.unmount());
    expect(appStateRemove).toHaveBeenCalledTimes(1);
    expect(inboxRemove).toHaveBeenCalledTimes(1);
    expect(openPackRemove).toHaveBeenCalledTimes(1);
    expect(backRemove).toHaveBeenCalledTimes(1);
  }, 15_000);

  test('shows a metadata integrity error and Retry terminates after quarantine', async () => {
    mockNative.getPendingShareEvents
      .mockRejectedValueOnce(
        new NativeBoundaryError('NATIVE_EVENT_SCHEMA_INVALID'),
      )
      .mockResolvedValue([]);
    const renderer = await renderApp();

    expect(renderedText(renderer)).toContain('Inbox unavailable');
    expect(renderedText(renderer)).toContain('NATIVE_EVENT_SCHEMA_INVALID');

    await press(control(renderer, 'button', 'Retry'));

    expect(renderedText(renderer)).toContain('Inbox is empty');
    expect(mockNative.getPendingShareEvents).toHaveBeenCalledTimes(2);
    expect(mockNative.ackPendingShareEvent).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('switches between detail and diagnostics tabs', async () => {
    mockNative.scanInbox.mockResolvedValue([manifest]);
    const renderer = await renderApp();

    await press(control(renderer, 'tab', 'detail'));
    expect(renderedText(renderer)).toContain('Import detail');
    expect(renderedText(renderer)).toContain(`ID ${ingestionId}`);

    await press(control(renderer, 'tab', 'diagnostics'));
    expect(renderedText(renderer)).toContain('Diagnostics');
    expect(renderedText(renderer)).toContain('Native boundary: available');
    act(() => renderer.unmount());
  });

  test('refreshes only when AppState becomes active', async () => {
    mockNative.scanInbox
      .mockResolvedValueOnce([])
      .mockResolvedValue([manifest]);
    const renderer = await renderApp();

    await act(async () => {
      appStateListener?.('background');
      await flushWorkflow();
    });
    expect(mockNative.scanInbox).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.('active');
      await flushWorkflow();
    });
    expect(mockNative.scanInbox).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Share import');
    act(() => renderer.unmount());
  });

  test('keeps a bootstrapped error latched across AppState activation', async () => {
    mockNative.getPendingShareEvents.mockRejectedValue(
      new NativeBoundaryError('NATIVE_SHARE_EVENT_STORE_READ_FAILED'),
    );
    const renderer = await renderApp();

    await act(async () => {
      appStateListener?.('active');
      await flushWorkflow();
    });

    expect(mockNative.scanInbox).toHaveBeenCalledTimes(1);
    expect(renderedText(renderer)).toContain(
      'NATIVE_SHARE_EVENT_STORE_READ_FAILED',
    );
    act(() => renderer.unmount());
  });

  test('handles the native inbox event and opens the newest import', async () => {
    const renderer = await renderApp();
    mockNative.scanInbox.mockResolvedValue([partialManifest]);

    await act(async () => {
      inboxListener?.({
        schemaVersion: 1,
        id: eventId,
        result: 'complete',
      });
      await flushWorkflow();
    });

    expect(mockNative.ackPendingShareEvent).toHaveBeenCalledWith(eventId);
    expect(renderedText(renderer)).toContain('Import detail');
    expect(renderedText(renderer)).toContain(`ID ${ingestionId}`);
    expect(renderedText(renderer)).toContain(
      '1 accepted · 1 rejected · 1 failed · partial',
    );
    expect(renderedText(renderer)).toContain('image/png × 1');
    expect(renderedText(renderer)).toContain('application/zip × 1');
    act(() => renderer.unmount());
  });

  test('opens an exact Pack from a validated platform deep link and ignores malformed IDs', async () => {
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      { ...persistedPack, id: newerPackId },
      persistedPack,
    ]);
    const renderer = await renderApp();

    await act(async () => {
      openPackListener?.({ packId: '../not-a-pack' });
      await flushWorkflow();
    });
    expect(renderedText(renderer)).toContain('inbox');
    expect(renderedText(renderer)).not.toContain('Import detail');

    await act(async () => {
      openPackListener?.({ packId: ingestionId });
      await flushWorkflow();
    });
    expect(renderedText(renderer)).toContain('Import detail');
    expect(renderedText(renderer)).toContain(`ID ${ingestionId}`);
    expect(renderedText(renderer)).not.toContain(`ID ${newerPackId}`);
    act(() => renderer.unmount());
  });

  test('uses the newest persisted pack as detail authority after multi-import bootstrap', async () => {
    mockNative.scanInbox.mockResolvedValue([partialManifest, manifest]);
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      {
        ...persistedPack,
        id: newerPackId,
        updatedAt: '2026-01-02T00:00:00Z',
      },
      persistedPack,
    ]);
    const renderer = await renderApp();

    await press(control(renderer, 'tab', 'detail'));

    expect(renderedText(renderer)).toContain(`ID ${newerPackId}`);
    expect(renderedText(renderer)).not.toContain(`ID ${ingestionId}`);
    act(() => renderer.unmount());
  });

  test('keeps persisted rejected and failed item codes visible with a retry target', async () => {
    mockNative.scanInbox.mockResolvedValue([]);
    mockNative.publishMainAppImport.mockResolvedValue({
      ...manifest,
      source: 'main-app-picker',
    });
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      {
        ...persistedPack,
        itemCount: partialManifest.items.length,
        import: {
          ingestionId,
          status: partialManifest.status,
          items: partialManifest.items.map(item => ({
            id: item.id,
            order: item.order,
            mediaType: item.mediaType,
            status: item.status,
            ...(item.status === 'failed'
              ? {
                  errorCode: item.errorCode,
                  retrySource: {
                    relativePath: `Packs/${persistedPack.id}/originals/${item.id}.bin`,
                    byteCount: 4,
                    sha256: 'a'.repeat(64),
                  },
                }
              : {}),
          })),
        },
      },
    ]);
    const renderer = await renderApp();

    expect(renderedText(renderer)).toContain(
      '1 accepted · 1 rejected · 1 failed · partial',
    );
    await press(control(renderer, 'tab', 'detail'));
    expect(renderedText(renderer)).toContain('IMPORT_TYPE_UNSUPPORTED');
    expect(renderedText(renderer)).toContain('IMPORT_COPY_FAILED');
    await press(control(renderer, 'button', 'Retry failed items in New Pack'));
    expect(renderedText(renderer)).toContain('New Pack');
    expect(renderedText(renderer)).toContain('2 selected');
    await press(control(renderer, 'button', 'Import Pack'));
    expect(mockNative.publishMainAppImport).toHaveBeenCalledWith(
      expect.any(String),
      'main-app-picker',
      [
        expect.objectContaining({
          kind: 'owned-file',
          declaredMediaType: 'application/zip',
          ownedRelativePath: `Packs/${persistedPack.id}/originals/${
            partialManifest.items[1]!.id
          }.bin`,
          sha256: 'a'.repeat(64),
        }),
        expect.objectContaining({
          kind: 'owned-file',
          declaredMediaType: 'text/plain',
          ownedRelativePath: `Packs/${persistedPack.id}/originals/${
            partialManifest.items[2]!.id
          }.bin`,
          sha256: 'a'.repeat(64),
        }),
      ],
    );
    act(() => renderer.unmount());
  });

  test('makes every contract-sized failed-item retry batch actionable', async () => {
    const failedItems = Array.from({ length: 128 }, (_, index) => {
      const itemId = `${String(index + 10).padStart(
        8,
        '0',
      )}-e89b-42d3-a456-426614174000`;
      return {
        id: itemId,
        order: index,
        mediaType: 'image/png',
        status: 'failed' as const,
        errorCode: 'IMPORT_COPY_FAILED',
        retrySource: {
          relativePath: `Packs/${persistedPack.id}/originals/${itemId}.bin`,
          byteCount: 4,
          sha256: 'a'.repeat(64),
        },
      };
    });
    mockNative.scanInbox.mockResolvedValue([]);
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      {
        ...persistedPack,
        itemCount: failedItems.length,
        import: {
          ingestionId,
          status: 'failed',
          items: failedItems,
        },
      },
    ]);
    const renderer = await renderApp();

    await press(control(renderer, 'tab', 'detail'));
    control(renderer, 'button', 'Retry failed items in New Pack 1–20');
    await press(
      control(renderer, 'button', 'Retry failed items in New Pack 121–128'),
    );

    expect(renderedText(renderer)).toContain('8 selected');
    expect(renderedText(renderer)).not.toContain('IMPORT_ITEM_LIMIT_EXCEEDED');
    expect(renderedText(renderer)).toContain('New Pack');
    expect(mockNative.publishMainAppImport).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('keeps untouched retry batches reachable after a retry creates the newest Pack', async () => {
    const failedItems = Array.from({ length: 128 }, (_, index) => {
      const itemId = `${String(index + 10).padStart(
        8,
        '0',
      )}-e89b-42d3-a456-426614174000`;
      return {
        id: itemId,
        order: index,
        mediaType: 'image/png',
        status: 'failed' as const,
        errorCode: 'IMPORT_COPY_FAILED',
        retrySource: {
          relativePath: `Packs/${persistedPack.id}/originals/${itemId}.bin`,
          byteCount: 4,
          sha256: 'a'.repeat(64),
        },
      };
    });
    const original = {
      ...persistedPack,
      itemCount: failedItems.length,
      import: {
        ingestionId,
        status: 'failed' as const,
        items: failedItems,
      },
    };
    const retryPack = {
      ...persistedPack,
      id: newerPackId,
      updatedAt: '2026-01-02T00:00:00Z',
      itemCount: 20,
    };
    mockNative.scanInbox.mockResolvedValue([]);
    mockNative.publishMainAppImport.mockResolvedValue({
      ...manifest,
      ingestionId: newerPackId,
      source: 'main-app-picker',
    });
    mockPersistenceInboxProcessor.listPersistedPacks
      .mockResolvedValueOnce([original])
      .mockResolvedValue([retryPack, original]);
    const renderer = await renderApp();

    await press(control(renderer, 'tab', 'detail'));
    await press(
      control(renderer, 'button', 'Retry failed items in New Pack 1–20'),
    );
    await press(control(renderer, 'button', 'Import Pack'));
    await press(control(renderer, 'button', 'Done'));
    await press(control(renderer, 'tab', 'detail'));

    expect(renderedText(renderer)).toContain(`ID ${ingestionId}`);
    expect(renderedText(renderer)).not.toContain(`ID ${newerPackId}`);
    expect(
      control(renderer, 'radio', 'Select Pack 2').props.accessibilityState,
    ).toEqual({ disabled: false, selected: true });
    expect(
      control(renderer, 'button', 'Retry failed items in New Pack 121–128'),
    ).toBeDefined();

    await press(control(renderer, 'radio', 'Select Pack 1'));
    expect(renderedText(renderer)).toContain(`ID ${newerPackId}`);
    act(() => renderer.unmount());
  });

  test('keeps an ACKed import visible from persisted Packs across refresh and restart', async () => {
    mockNative.scanInbox
      .mockResolvedValueOnce([manifest])
      .mockResolvedValue([]);
    mockNative.getPendingShareEvents
      .mockResolvedValueOnce([
        { schemaVersion: 1, id: ingestionId, result: 'complete' },
      ])
      .mockResolvedValue([]);
    mockPersistenceInboxProcessor.process.mockImplementation(
      async (manifests: readonly ImportManifestV1[]) => {
        for (const value of manifests)
          await mockNative.acknowledgeInbox(value.ingestionId);
      },
    );
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      persistedPack,
    ]);

    const firstRenderer = await renderApp();
    expect(mockNative.acknowledgeInbox).toHaveBeenCalledWith(ingestionId);
    expect(mockNative.ackPendingShareEvent).toHaveBeenCalledWith(ingestionId);
    expect(
      mockPersistenceInboxProcessor.listPersistedPacks,
    ).toHaveBeenCalledTimes(1);
    expect(renderedText(firstRenderer)).toContain(`ID ${ingestionId}`);

    await act(async () => {
      appStateListener?.('active');
      await flushWorkflow();
    });
    expect(mockNative.scanInbox).toHaveBeenLastCalledWith();
    await press(control(firstRenderer, 'tab', 'inbox'));
    expect(renderedText(firstRenderer)).toContain('0 item · draft');
    expect(renderedText(firstRenderer)).not.toContain('Inbox is empty');
    act(() => firstRenderer.unmount());

    const restartedRenderer = await renderApp();
    expect(renderedText(restartedRenderer)).toContain('0 item · draft');
    expect(renderedText(restartedRenderer)).not.toContain('Inbox is empty');
    act(() => restartedRenderer.unmount());
  });

  test('opens the main-app import flow without creating an accidental empty Pack', async () => {
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'New Pack'));

    expect(renderedText(renderer)).toContain('Add photos, PDF or text files');
    expect(
      control(renderer, 'button', 'Import Pack').props.accessibilityState,
    ).toEqual({
      disabled: true,
    });
    expect(mockCreateEmptyDraftPack).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('keeps every Pack creation entry locked until native picker-cache recovery succeeds', async () => {
    mockNative.recoverMainAppPickerCache
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'))
      .mockResolvedValue(undefined);
    const renderer = await renderApp();

    expect(renderedText(renderer)).toContain('STORAGE_WRITE_FAILED');
    expect(
      control(renderer, 'button', 'New Pack').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: true });
    expect(mockCreateEmptyDraftPack).not.toHaveBeenCalled();

    await press(control(renderer, 'button', 'Retry'));

    expect(
      control(renderer, 'button', 'New Pack').props.accessibilityState,
    ).toEqual({ disabled: false });
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: false });
    act(() => renderer.unmount());
  });

  test('keeps Pack creation locked after recovery when Inbox operations still fail', async () => {
    mockNative.scanInbox
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'))
      .mockResolvedValue([]);
    const renderer = await renderApp();

    expect(renderedText(renderer)).toContain('STORAGE_WRITE_FAILED');
    expect(
      control(renderer, 'button', 'New Pack').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: true });

    await press(control(renderer, 'button', 'Retry'));

    expect(
      control(renderer, 'button', 'New Pack').props.accessibilityState,
    ).toEqual({ disabled: false });
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: false });
    act(() => renderer.unmount());
  });

  test('switches the shared interface and New Pack interaction labels to Simplified Chinese', async () => {
    const renderer = await renderApp();

    await press(control(renderer, 'radio', '简体中文'));

    expect(renderedText(renderer)).toContain('收件箱为空');
    expect(
      control(renderer, 'radio', '简体中文').props.accessibilityState,
    ).toEqual({
      disabled: false,
      selected: true,
    });
    await press(control(renderer, 'button', '新建上下文包'));
    expect(renderedText(renderer)).toContain(
      '添加照片、PDF 或文本文件、粘贴文本以及 HTTP(S) URL',
    );
    expect(control(renderer, 'button', '导入上下文包')).toBeDefined();
    act(() => renderer.unmount());
  });

  test('routes Android hardware back through selected-file cleanup before returning to Inbox', async () => {
    const fileUri = 'file:///cache/hardware-back.png';
    mockMainAppPicker.pickPhotos.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: fileUri,
          mediaType: 'image/png',
          byteCount: 4,
        },
      ],
    });
    mockNative.discardMainAppPickerFiles.mockResolvedValue(undefined);
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'New Pack'));
    await press(control(renderer, 'button', 'Add Photos'));

    await act(async () => {
      expect(hardwareBack?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(
        true,
      );
      await flushWorkflow();
    });

    expect(mockNative.discardMainAppPickerFiles).toHaveBeenCalledWith([
      'file:///cache/staged-0.bin',
    ]);
    expect(renderedText(renderer)).toContain('Inbox is empty');
    expect(renderedText(renderer)).not.toContain(
      'Add photos, PDF or text files',
    );
    act(() => renderer.unmount());
  });

  test('keeps selected cache files inside the flow when background import navigation arrives', async () => {
    const fileUri = 'file:///cache/navigation-guard.png';
    mockMainAppPicker.pickPhotos.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: fileUri,
          mediaType: 'image/png',
          byteCount: 4,
        },
      ],
    });
    mockNative.discardMainAppPickerFiles.mockResolvedValue(undefined);
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'New Pack'));
    await press(control(renderer, 'button', 'Add Photos'));

    expect(
      renderer.root.findAll(node => node.props.accessibilityRole === 'tab'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Create Empty Draft',
      ),
    ).toHaveLength(0);

    mockNative.scanInbox.mockResolvedValue([manifest]);
    await act(async () => {
      inboxListener?.({
        schemaVersion: 1,
        id: eventId,
        result: 'complete',
      });
      await flushWorkflow();
    });
    expect(renderedText(renderer).replace(/\s+/g, ' ')).toContain('1 selected');
    expect(renderedText(renderer)).toContain('Cancel New Pack');
    expect(mockNative.discardMainAppPickerFiles).not.toHaveBeenCalled();

    await press(control(renderer, 'button', 'Cancel New Pack'));
    expect(mockNative.discardMainAppPickerFiles).toHaveBeenCalledWith([
      'file:///cache/staged-0.bin',
    ]);
    expect(renderedText(renderer)).toContain('Share import');
    expect(renderedText(renderer)).not.toContain('Cancel New Pack');
    act(() => renderer.unmount());
  });

  test('keeps a committed main-app import in recovery when persistence refresh fails', async () => {
    const fileUri = 'file:///cache/persistence-recovery.png';
    const importedManifest: ImportManifestV1 = {
      ...manifest,
      source: 'main-app-picker',
      items: [
        {
          id: eventId,
          order: 0,
          mediaType: 'image/png',
          status: 'copied',
          byteCount: 8,
          relativePath: `${eventId}.bin`,
        },
      ],
    };
    mockMainAppPicker.pickPhotos.mockResolvedValue({
      canceled: false,
      assets: [{ uri: fileUri, mediaType: 'image/png', byteCount: 8 }],
    });
    mockNative.publishMainAppImport.mockResolvedValue(importedManifest);
    mockPersistenceInboxProcessor.process
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'))
      .mockResolvedValue(undefined);
    const renderer = await renderApp();
    mockNative.scanInbox.mockResolvedValue([importedManifest]);

    await press(control(renderer, 'button', 'New Pack'));
    await press(control(renderer, 'button', 'Add Photos'));
    await press(control(renderer, 'button', 'Import Pack'));

    expect(renderedText(renderer)).toContain('Import recovery required');
    expect(renderedText(renderer)).toContain('STORAGE_WRITE_FAILED');
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Cancel New Pack',
      ),
    ).toHaveLength(0);
    await act(async () => {
      expect(hardwareBack?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(
        true,
      );
      await flushWorkflow();
    });
    expect(renderedText(renderer)).toContain('Import recovery required');
    expect(mockNative.discardMainAppPickerFiles).not.toHaveBeenCalled();

    await press(control(renderer, 'button', 'Retry Import Recovery'));

    expect(mockNative.publishMainAppImport).toHaveBeenCalledTimes(2);
    expect(mockPersistenceInboxProcessor.process).toHaveBeenCalledTimes(3);
    expect(renderedText(renderer).replace(/[·\s]+/g, ' ')).toContain(
      'Import complete',
    );
    act(() => renderer.unmount());
  });

  test('committed recovery clears a raced live workflow blocker before completing', async () => {
    const fileUri = 'file:///cache/raced-workflow-recovery.png';
    const importedManifest: ImportManifestV1 = {
      ...manifest,
      source: 'main-app-picker',
      items: [
        {
          id: eventId,
          order: 0,
          mediaType: 'image/png',
          status: 'copied',
          byteCount: 8,
          relativePath: `${eventId}.bin`,
        },
      ],
    };
    mockMainAppPicker.pickPhotos.mockResolvedValue({
      canceled: false,
      assets: [{ uri: fileUri, mediaType: 'image/png', byteCount: 8 }],
    });
    let publicationCount = 0;
    mockNative.publishMainAppImport.mockImplementation(async () => {
      publicationCount += 1;
      if (publicationCount === 1) {
        inboxListener?.({
          schemaVersion: 1,
          id: eventId,
          result: 'unknown',
        });
        await flushWorkflow();
      }
      return importedManifest;
    });
    const renderer = await renderApp();
    mockNative.scanInbox.mockResolvedValue([importedManifest]);
    mockNative.getPendingShareEvents.mockRejectedValueOnce(
      new NativeBoundaryError('NATIVE_SHARE_EVENT_STORE_READ_FAILED'),
    );

    await press(control(renderer, 'button', 'New Pack'));
    await press(control(renderer, 'button', 'Add Photos'));
    await press(control(renderer, 'button', 'Import Pack'));

    expect(renderedText(renderer)).toContain('Import recovery required');
    expect(renderedText(renderer)).toContain(
      'NATIVE_SHARE_EVENT_STORE_READ_FAILED',
    );

    await press(control(renderer, 'button', 'Retry Import Recovery'));

    expect(mockNative.publishMainAppImport).toHaveBeenCalledTimes(2);
    expect(mockNative.getPendingShareEvents).toHaveBeenCalledTimes(3);
    expect(renderedText(renderer).replace(/[·\s]+/g, ' ')).toContain(
      'Import complete',
    );
    act(() => renderer.unmount());
  });

  test('locks an already-open New Pack after an operational workflow failure', async () => {
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'New Pack'));
    expect(
      control(renderer, 'button', 'Add Photos').props.accessibilityState,
    ).toEqual({ disabled: false });

    await act(async () => {
      inboxListener?.({
        schemaVersion: 1,
        id: eventId,
        result: 'unknown',
      });
      await flushWorkflow();
    });

    for (const label of [
      'Add Photos',
      'Add Files',
      'Add Text',
      'Add URL',
      'Import Pack',
    ])
      expect(
        control(renderer, 'button', label).props.accessibilityState,
      ).toEqual({ disabled: true });
    expect(mockNative.publishMainAppImport).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('keeps navigation and screen content in one Dynamic Type scroll surface', async () => {
    const renderer = await renderApp();
    const scrollSurface = renderer.root.findByType(ScrollView);

    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(1);
    expect(instanceText(scrollSurface)).toContain('New Pack');
    expect(instanceText(scrollSurface)).toContain('diagnostics');
    expect(instanceText(scrollSurface)).toContain('Inbox is empty');

    await press(control(renderer, 'button', 'New Pack'));
    expect(instanceText(scrollSurface)).toContain(
      'Import is disabled until at least one item is selected',
    );
    act(() => renderer.unmount());
  });

  test('creates an empty Pack only through the explicit Empty Draft action', async () => {
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      persistedPack,
    ]);
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'Create Empty Draft'));

    expect(mockCreateEmptyDraftPack).toHaveBeenCalledTimes(1);
    expect(mockNative.scanInbox).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Import detail');
    expect(renderedText(renderer)).toContain(`ID ${ingestionId}`);
    act(() => renderer.unmount());
  });

  test('clears a stale empty-draft refresh error after Retry recovers the created Pack', async () => {
    const createdPack = { ...persistedPack, id: newerPackId };
    mockCreateEmptyDraftPack.mockResolvedValue(createdPack);
    mockNative.scanInbox
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'))
      .mockResolvedValue([]);
    mockPersistenceInboxProcessor.listPersistedPacks
      .mockResolvedValueOnce([])
      .mockResolvedValue([createdPack]);
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'Create Empty Draft'));

    expect(renderedText(renderer)).toContain('STORAGE_WRITE_FAILED');
    await press(control(renderer, 'button', 'Retry'));

    expect(renderedText(renderer)).not.toContain('STORAGE_WRITE_FAILED');
    await press(control(renderer, 'tab', 'detail'));
    expect(renderedText(renderer)).toContain(`ID ${newerPackId}`);
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: false });
    act(() => renderer.unmount());
  });

  test('keeps Empty Draft recovery locked until Retry finds and selects the exact Pack', async () => {
    const createdPack = { ...persistedPack, id: newerPackId };
    mockCreateEmptyDraftPack.mockResolvedValue(createdPack);
    mockNative.scanInbox.mockResolvedValue([]);
    mockPersistenceInboxProcessor.listPersistedPacks
      .mockResolvedValueOnce([persistedPack])
      .mockResolvedValueOnce([persistedPack])
      .mockResolvedValueOnce([persistedPack])
      .mockResolvedValue([persistedPack, createdPack]);
    const renderer = await renderApp();
    await press(control(renderer, 'tab', 'detail'));
    expect(renderedText(renderer)).toContain(`ID ${ingestionId}`);

    await press(control(renderer, 'button', 'Create Empty Draft'));

    expect(renderedText(renderer)).toContain('INBOX_SCAN_FAILED');
    await press(control(renderer, 'button', 'Retry'));
    expect(renderedText(renderer)).toContain('INBOX_SCAN_FAILED');
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: true });

    await press(control(renderer, 'button', 'Retry'));

    expect(renderedText(renderer)).not.toContain('INBOX_SCAN_FAILED');
    expect(renderedText(renderer)).toContain(`ID ${newerPackId}`);
    expect(renderedText(renderer)).not.toContain(`ID ${ingestionId}`);
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: false });
    act(() => renderer.unmount());
  });

  test('keeps New Pack mutually exclusive while an empty draft is pending', async () => {
    let resolveCreate: ((pack: InboxPackSummary) => void) | undefined;
    const pendingCreate = new Promise<InboxPackSummary>(resolve => {
      resolveCreate = resolve;
    });
    mockCreateEmptyDraftPack.mockReturnValue(pendingCreate);
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([
      persistedPack,
    ]);
    const renderer = await renderApp();
    let pendingAction: Promise<void> | undefined;

    act(() => {
      pendingAction = control(
        renderer,
        'button',
        'Create Empty Draft',
      ).props.onPress();
    });

    expect(
      control(renderer, 'button', 'New Pack').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: true });
    await press(control(renderer, 'button', 'New Pack'));
    expect(renderedText(renderer)).not.toContain(
      'Add photos, PDF or text files',
    );
    expect(mockMainAppPicker.pickFiles).not.toHaveBeenCalled();
    expect(mockMainAppPicker.pickPhotos).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate?.(persistedPack);
      await pendingAction;
      await flushWorkflow();
    });
    expect(renderedText(renderer)).toContain('Import detail');
    act(() => renderer.unmount());
  });

  test('locks Detail retry Pack creation while an empty draft is pending', async () => {
    const failedItem = partialManifest.items[2]!;
    const retryPack = {
      ...persistedPack,
      itemCount: 1,
      import: {
        ingestionId,
        status: 'failed' as const,
        items: [
          {
            id: failedItem.id,
            order: 0,
            mediaType: failedItem.mediaType,
            status: 'failed' as const,
            errorCode: 'IMPORT_COPY_FAILED' as const,
            retrySource: {
              relativePath: `Packs/${persistedPack.id}/originals/${failedItem.id}.bin`,
              byteCount: 4,
              sha256: 'a'.repeat(64),
            },
          },
        ],
      },
    };
    const createdPack = { ...persistedPack, id: newerPackId };
    let resolveCreate: ((pack: InboxPackSummary) => void) | undefined;
    mockCreateEmptyDraftPack.mockReturnValue(
      new Promise<InboxPackSummary>(resolve => {
        resolveCreate = resolve;
      }),
    );
    mockPersistenceInboxProcessor.listPersistedPacks
      .mockResolvedValueOnce([retryPack])
      .mockResolvedValue([retryPack, createdPack]);
    const renderer = await renderApp();
    await press(control(renderer, 'tab', 'detail'));
    let pendingAction: Promise<void> | undefined;

    act(() => {
      pendingAction = control(
        renderer,
        'button',
        'Create Empty Draft',
      ).props.onPress();
    });

    expect(
      control(renderer, 'button', 'Retry failed items in New Pack').props
        .accessibilityState,
    ).toEqual({ disabled: true });
    await press(control(renderer, 'button', 'Retry failed items in New Pack'));
    expect(renderedText(renderer)).not.toContain(
      'Add photos, PDF or text files',
    );
    expect(mockMainAppPicker.pickFiles).not.toHaveBeenCalled();
    expect(mockMainAppPicker.pickPhotos).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate?.(createdPack);
      await pendingAction;
      await flushWorkflow();
    });
    expect(renderedText(renderer)).toContain(`ID ${newerPackId}`);
    act(() => renderer.unmount());
  });

  test('creates and selects an empty Pack while preserving a historical share warning', async () => {
    const createdPack = {
      ...persistedPack,
      id: newerPackId,
      updatedAt: '2026-01-02T00:00:00Z',
    };
    mockCreateEmptyDraftPack.mockResolvedValue(createdPack);
    mockPersistenceInboxProcessor.listPersistedPacks
      .mockResolvedValueOnce([persistedPack])
      .mockResolvedValueOnce([persistedPack, createdPack]);
    const renderer = await renderApp();
    await act(async () => {
      inboxListener?.({
        schemaVersion: 1,
        id: eventId,
        result: 'failed',
        code: 'SHARE_IMPORT_FAILED',
      });
      await flushWorkflow();
    });

    await press(control(renderer, 'button', 'Create Empty Draft'));

    expect(mockNative.scanInbox).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Import detail');
    expect(renderedText(renderer)).toContain(`ID ${newerPackId}`);
    expect(renderedText(renderer)).not.toContain(`ID ${ingestionId}`);
    await press(control(renderer, 'tab', 'inbox'));
    expect(renderedText(renderer)).toContain('SHARE_IMPORT_FAILED');
    act(() => renderer.unmount());
  });

  test('does not navigate to stale Detail when empty-Pack refresh fails', async () => {
    mockNative.scanInbox
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new NativeBoundaryError('STORAGE_WRITE_FAILED'));
    mockPersistenceInboxProcessor.listPersistedPacks.mockResolvedValue([]);
    const renderer = await renderApp();

    await press(control(renderer, 'button', 'Create Empty Draft'));

    expect(mockCreateEmptyDraftPack).toHaveBeenCalledTimes(1);
    expect(renderedText(renderer)).toContain('STORAGE_WRITE_FAILED');
    expect(renderedText(renderer)).toContain('Inbox unavailable');
    expect(renderedText(renderer)).not.toContain('Import detail');
    expect(
      control(renderer, 'button', 'Create Empty Draft').props
        .accessibilityState,
    ).toEqual({ disabled: true });
    act(() => renderer.unmount());
  });
});
