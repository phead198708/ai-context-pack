import React from 'react';
import {
  AppState,
  type AppStateStatus,
  DeviceEventEmitter,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import App from '../App';
import type { ImportManifestV1 } from '../src/domain/contracts';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import { NativeBoundaryError } from '../src/infrastructure/createNativeAdapter';
import { nativeAdapter } from '../src/infrastructure/nativeAdapter';

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
    recognizeText: jest.fn(),
    probePdf: jest.fn(),
  },
}));

const mockNative = nativeAdapter as jest.Mocked<NativeAdapter>;
const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
const eventId = '223e4567-e89b-42d3-a456-426614174000';
const manifest: ImportManifestV1 = {
  schemaVersion: 1,
  ingestionId,
  createdAt: '2026-01-01T00:00:00Z',
  source: 'android-share-intent',
  status: 'complete',
  items: [],
};

let appStateListener: ((state: AppStateStatus) => void) | undefined;
let inboxListener: ((event: unknown) => void) | undefined;
let appStateRemove: jest.Mock;
let inboxRemove: jest.Mock;

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
    appStateListener = undefined;
    inboxListener = undefined;
    appStateRemove = jest.fn();
    inboxRemove = jest.fn();
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
    mockNative.scanInbox.mockResolvedValue([]);
    mockNative.getPendingShareEvents.mockResolvedValue([]);
    mockNative.ackPendingShareEvent.mockResolvedValue(undefined);
    mockNative.ackEphemeralShareEvent.mockResolvedValue(undefined);
    mockNative.getPendingRecoveryEvent.mockResolvedValue(null);
    mockNative.ackRecoveryEvent.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  test('bootstraps through the native adapter and removes both listeners', async () => {
    mockNative.scanInbox.mockResolvedValue([manifest]);
    const renderer = await renderApp();

    expect(renderedText(renderer)).toContain('Image received');
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

    act(() => renderer.unmount());
    expect(appStateRemove).toHaveBeenCalledTimes(1);
    expect(inboxRemove).toHaveBeenCalledTimes(1);
  });

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
    expect(renderedText(renderer)).toContain('Image received');
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
    mockNative.scanInbox.mockResolvedValue([manifest]);

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
    act(() => renderer.unmount());
  });
});
