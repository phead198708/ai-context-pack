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
let appStateRemove: jest.Mock;
let inboxRemove: jest.Mock;
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
  role: 'button' | 'tab',
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
    hardwareBack = undefined;
    appStateRemove = jest.fn();
    inboxRemove = jest.fn();
    backRemove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      listener: (state: AppStateStatus) => void,
    ) => {
      appStateListener = listener;
      return { remove: appStateRemove };
    }) as typeof AppState.addEventListener);
    jest.spyOn(DeviceEventEmitter, 'addListener').mockImplementation(((
      _name: string,
      listener: (event: unknown) => void,
    ) => {
      inboxListener = listener;
      return { remove: inboxRemove };
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
    expect(BackHandler.addEventListener).toHaveBeenCalledWith(
      'hardwareBackPress',
      expect.any(Function),
    );

    act(() => renderer.unmount());
    expect(appStateRemove).toHaveBeenCalledTimes(1);
    expect(inboxRemove).toHaveBeenCalledTimes(1);
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
      fileUri,
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
      fileUri,
    ]);
    expect(renderedText(renderer)).toContain('Share import');
    expect(renderedText(renderer)).not.toContain('Cancel New Pack');
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
});
