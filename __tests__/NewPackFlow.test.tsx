import React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { ImportManifestV1 } from '../src/domain/contracts';
import type {
  MainAppImportDraft,
  MainAppImportInput,
} from '../src/domain/mainAppImport';
import {
  MAIN_APP_IMPORT_MAX_ITEMS,
  MAIN_APP_IMPORT_MAX_TEXT_BYTES,
} from '../src/domain/mainAppImport';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import type { MainAppPicker } from '../src/infrastructure/mainAppPickers';
import { NewPackFlow, type NewPackFlowHandle } from '../src/ui/NewPackFlow';

const ingestionId = '123e4567-e89b-42d3-a456-426614174000';

function nativeAdapter(): jest.Mocked<NativeAdapter> {
  return {
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
    stageMainAppPickerFiles: jest.fn(async fileUris => fileUris),
    cleanupMainAppPickerTransients: jest.fn().mockResolvedValue(undefined),
    recoverMainAppPickerCache: jest.fn().mockResolvedValue(undefined),
    discardMainAppPickerFiles: jest.fn().mockResolvedValue(undefined),
    publishArtifact: jest.fn(),
    verifyArtifact: jest.fn(),
    listOwnedArtifacts: jest.fn(),
    removeOwnedArtifact: jest.fn(),
    quarantineOwnedArtifact: jest.fn(),
    purgeArtifactQuarantine: jest.fn(),
    getArtifactStorageUsage: jest.fn(),
    recognizeText: jest.fn(),
    probePdf: jest.fn(),
  };
}

function picker(): jest.Mocked<MainAppPicker> {
  return { pickPhotos: jest.fn(), pickFiles: jest.fn() };
}

function draft(items: readonly MainAppImportInput[] = []): MainAppImportDraft {
  return { ingestionId, items };
}

type RenderProps = Omit<
  React.ComponentProps<typeof NewPackFlow>,
  'creationReady'
> & {
  readonly creationReady?: boolean;
};

async function render(
  props: RenderProps,
  ref?: React.Ref<NewPackFlowHandle>,
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      <NewPackFlow
        {...props}
        ref={ref}
        creationReady={props.creationReady ?? true}
      />,
    );
  });
  return renderer as ReactTestRenderer;
}

function byLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance {
  return renderer.root.find(node => node.props.accessibilityLabel === label);
}

function text(renderer: ReactTestRenderer): string {
  return instanceText(renderer.root);
}

function instanceText(node: ReactTestInstance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : instanceText(child)))
    .join('\n');
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    await node.props.onPress();
  });
}

async function change(node: ReactTestInstance, value: string): Promise<void> {
  await act(async () => node.props.onChangeText(value));
}

describe('NewPackFlow interactions', () => {
  test('locks add and first-publication actions when operational readiness is revoked', async () => {
    const native = nativeAdapter();
    const input: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'text',
      declaredMediaType: 'text/plain',
      byteCount: 7,
      text: 'fixture',
    };
    const renderer = await render({
      native,
      picker: picker(),
      creationReady: false,
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft([input]),
    });

    for (const label of [
      'Add Photos',
      'Add Files',
      'Add Text',
      'Add URL',
      'Import Pack',
    ])
      expect(byLabel(renderer, label).props.accessibilityState).toEqual({
        disabled: true,
      });
    expect(byLabel(renderer, 'Text to add').props.editable).toBe(false);
    expect(byLabel(renderer, 'URL to add').props.editable).toBe(false);

    await press(byLabel(renderer, 'Import Pack'));
    expect(native.publishMainAppImport).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('keeps empty import disabled and picker cancellation creates no Pack or temp cleanup', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    const onCancel = jest.fn();
    systemPicker.pickPhotos.mockResolvedValue({ canceled: true, assets: [] });
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel,
      onImported: jest.fn(),
      createDraft: () => draft(),
    });

    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: true,
    });
    await press(byLabel(renderer, 'Add Photos'));

    expect(text(renderer)).toContain(
      'Selection canceled. No Pack or temporary item was created.',
    );
    expect(native.publishMainAppImport).not.toHaveBeenCalled();
    expect(native.discardMainAppPickerFiles).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('adds picker, exact pasted text and URL, allows reorder, and shows mixed result states', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    const onImported = jest.fn().mockResolvedValue(undefined);
    const privateText = '中文 🧪\n    const code = true;';
    const longUrl = `https://example.invalid/${'segment/'.repeat(100)}`;
    systemPicker.pickFiles.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/private-name.pdf',
          mediaType: 'application/pdf',
          byteCount: 9,
        },
      ],
    });
    native.publishMainAppImport.mockImplementation(
      async (id, source, inputs): Promise<ImportManifestV1> => ({
        schemaVersion: 1,
        ingestionId: id,
        createdAt: '2026-08-07T00:00:00Z',
        source,
        status: 'partial',
        items: inputs.map((input, order) =>
          order === 1
            ? {
                id: input.id,
                order,
                mediaType: input.declaredMediaType,
                status: 'failed',
                byteCount: 0,
                errorCode: 'IMPORT_TYPE_UNSUPPORTED',
              }
            : {
                id: input.id,
                order,
                mediaType: input.declaredMediaType,
                status: 'copied',
                byteCount: input.byteCount,
                relativePath: `${input.id}.bin`,
              },
        ),
      }),
    );
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel: jest.fn(),
      onImported,
      createDraft: () => draft(),
    });

    await press(byLabel(renderer, 'Add Files'));
    await change(byLabel(renderer, 'Text to add'), privateText);
    await press(byLabel(renderer, 'Add Text'));
    await change(byLabel(renderer, 'URL to add'), longUrl);
    await press(byLabel(renderer, 'Add URL'));
    await press(byLabel(renderer, 'Move URL 3 up'));

    expect(text(renderer).replace(/\s+/g, ' ')).toContain('3 selected');
    expect(text(renderer)).not.toContain('private-name.pdf');
    expect(text(renderer)).not.toContain(privateText);
    expect(text(renderer)).not.toContain(longUrl);

    await press(byLabel(renderer, 'Import Pack'));

    expect(native.publishMainAppImport).toHaveBeenCalledWith(
      ingestionId,
      'main-app-picker',
      expect.any(Array),
    );
    const sent = native.publishMainAppImport.mock.calls[0]![2];
    expect(sent.map(item => item.kind)).toEqual(['file', 'url', 'text']);
    expect(sent[1]).toMatchObject({ kind: 'url', text: longUrl, order: 1 });
    expect(sent[2]).toMatchObject({
      kind: 'text',
      text: privateText,
      order: 2,
    });
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial' }),
    );
    const normalizedResult = text(renderer).replace(/[·\s]+/g, ' ');
    expect(normalizedResult).toContain('Import partial');
    expect(normalizedResult).toContain('2 accepted 1 failed');
    expect(text(renderer)).toContain('IMPORT_TYPE_UNSUPPORTED');
    act(() => renderer.unmount());
  });

  test('rejects isolated surrogates before pasted text reaches native publication', async () => {
    const native = nativeAdapter();
    const renderer = await render({
      native,
      picker: picker(),
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft(),
    });

    await change(byLabel(renderer, 'Text to add'), '\ud800');
    await press(byLabel(renderer, 'Add Text'));

    expect(text(renderer)).toContain('MAIN_APP_IMPORT_INPUT_INVALID');
    expect(text(renderer).replace(/\s+/g, ' ')).toContain('0 selected');
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(native.publishMainAppImport).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('removes and cancels only after controlled picker files are discarded', async () => {
    const native = nativeAdapter();
    const onCancel = jest.fn();
    const items: readonly MainAppImportInput[] = [
      {
        id: '223e4567-e89b-42d3-a456-426614174000',
        order: 0,
        kind: 'file',
        declaredMediaType: 'image/png',
        byteCount: 4,
        fileUri: 'file:///cache/first.png',
      },
      {
        id: '323e4567-e89b-42d3-a456-426614174000',
        order: 1,
        kind: 'file',
        declaredMediaType: 'application/pdf',
        byteCount: 5,
        fileUri: 'file:///cache/second.pdf',
      },
    ];
    const renderer = await render({
      native,
      picker: picker(),
      onCancel,
      onImported: jest.fn(),
      createDraft: () => draft(items),
    });

    await press(byLabel(renderer, 'Remove Photo 1'));
    expect(native.discardMainAppPickerFiles).toHaveBeenCalledWith([
      'file:///cache/first.png',
    ]);
    await press(byLabel(renderer, 'Cancel New Pack'));
    expect(native.discardMainAppPickerFiles).toHaveBeenLastCalledWith([
      'file:///cache/second.pdf',
    ]);
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  test('preflights the combined document item limit before staging', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    const existing: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'text',
      declaredMediaType: 'text/plain',
      byteCount: 1,
      text: 'x',
    };
    systemPicker.pickFiles.mockResolvedValue({
      canceled: false,
      assets: Array.from({ length: MAIN_APP_IMPORT_MAX_ITEMS }, (_, index) => ({
        uri: `file:///provider/document-${index}.pdf`,
        mediaType: 'application/pdf',
        byteCount: 4,
      })),
    });
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft([existing]),
    });

    await press(byLabel(renderer, 'Add Files'));

    expect(text(renderer)).toContain('IMPORT_ITEM_LIMIT_EXCEEDED');
    expect(native.stageMainAppPickerFiles).not.toHaveBeenCalled();
    expect(native.discardMainAppPickerFiles).not.toHaveBeenCalled();
    expect(native.cleanupMainAppPickerTransients).toHaveBeenCalledTimes(2);
    expect(text(renderer).replace(/\s+/g, ' ')).toContain('1 selected');
    act(() => renderer.unmount());
  });

  test('retains failed over-limit transient cleanup for retry before import can proceed', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    const onCancel = jest.fn();
    const fullDraft = draft(
      Array.from({ length: 20 }, (_, order) => ({
        id: `${String(order + 1).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
        order,
        kind: 'text' as const,
        declaredMediaType: 'text/plain',
        byteCount: 1,
        text: 'x',
      })),
    );
    systemPicker.pickFiles.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/overflow.pdf',
          mediaType: 'application/pdf',
          byteCount: 4,
        },
      ],
    });
    native.cleanupMainAppPickerTransients
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ code: 'MAIN_APP_IMPORT_CLEANUP_FAILED' })
      .mockResolvedValueOnce(undefined);
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel,
      onImported: jest.fn(),
      createDraft: () => fullDraft,
    });

    await press(byLabel(renderer, 'Add Files'));
    expect(text(renderer)).toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(native.stageMainAppPickerFiles).not.toHaveBeenCalled();
    expect(native.discardMainAppPickerFiles).not.toHaveBeenCalled();
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(byLabel(renderer, 'Retry Temporary Cleanup')).toBeDefined();
    expect(onCancel).not.toHaveBeenCalled();

    await press(byLabel(renderer, 'Retry Temporary Cleanup'));
    expect(native.cleanupMainAppPickerTransients).toHaveBeenCalledTimes(3);
    expect(text(renderer)).not.toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: false,
    });

    await press(byLabel(renderer, 'Cancel New Pack'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  test('does not exit cancellation until selected-file cleanup succeeds', async () => {
    const native = nativeAdapter();
    const onCancel = jest.fn();
    const item: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'file',
      declaredMediaType: 'application/pdf',
      byteCount: 4,
      fileUri: 'file:///cache/retry-cancel.pdf',
    };
    native.discardMainAppPickerFiles
      .mockRejectedValueOnce({ code: 'MAIN_APP_IMPORT_CLEANUP_FAILED' })
      .mockResolvedValueOnce(undefined);
    const renderer = await render({
      native,
      picker: picker(),
      onCancel,
      onImported: jest.fn(),
      createDraft: () => draft([item]),
    });

    await press(byLabel(renderer, 'Cancel New Pack'));
    expect(text(renderer)).toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(onCancel).not.toHaveBeenCalled();

    await press(byLabel(renderer, 'Cancel New Pack'));
    expect(native.discardMainAppPickerFiles).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  test('keeps a selected item when remove cleanup fails and permits retry', async () => {
    const native = nativeAdapter();
    const item: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'file',
      declaredMediaType: 'image/png',
      byteCount: 4,
      fileUri: 'file:///cache/retry-remove.png',
    };
    native.discardMainAppPickerFiles
      .mockRejectedValueOnce({ code: 'MAIN_APP_IMPORT_CLEANUP_FAILED' })
      .mockResolvedValueOnce(undefined);
    const renderer = await render({
      native,
      picker: picker(),
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft([item]),
    });

    await press(byLabel(renderer, 'Remove Photo 1'));
    expect(text(renderer)).toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(byLabel(renderer, 'Remove Photo 1')).toBeDefined();

    await press(byLabel(renderer, 'Remove Photo 1'));
    expect(text(renderer).replace(/\s+/g, ' ')).toContain('0 selected');
    expect(native.discardMainAppPickerFiles).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  test('makes permission denial visible without leaking provider details', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    systemPicker.pickFiles.mockRejectedValue({
      code: 'PICKER_PERMISSION_DENIED',
    });
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft(),
    });

    await press(byLabel(renderer, 'Add Files'));
    expect(text(renderer)).toContain('PICKER_PERMISSION_DENIED');
    expect(native.cleanupMainAppPickerTransients).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  test('blocks after picker failure until transient cache cleanup succeeds', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    systemPicker.pickFiles.mockRejectedValue({ code: 'PICKER_FAILED' });
    native.cleanupMainAppPickerTransients
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ code: 'MAIN_APP_IMPORT_CLEANUP_FAILED' })
      .mockResolvedValueOnce(undefined);
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft(),
    });

    await press(byLabel(renderer, 'Add Files'));

    expect(text(renderer)).toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(byLabel(renderer, 'Retry Temporary Cleanup')).toBeDefined();
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: true,
    });

    await press(byLabel(renderer, 'Retry Temporary Cleanup'));

    expect(native.cleanupMainAppPickerTransients).toHaveBeenCalledTimes(3);
    expect(text(renderer)).not.toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(native.publishMainAppImport).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('fully recovers completed staging when the bridge rejects its result', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    const existingFile: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'file',
      declaredMediaType: 'image/png',
      byteCount: 4,
      fileUri: 'file:///cache/existing.bin',
    };
    const retainedText: MainAppImportInput = {
      id: '323e4567-e89b-42d3-a456-426614174000',
      order: 1,
      kind: 'text',
      declaredMediaType: 'text/plain',
      byteCount: 7,
      text: 'fixture',
    };
    systemPicker.pickFiles.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/provider.bin',
          mediaType: 'application/pdf',
          byteCount: 8,
        },
      ],
    });
    native.stageMainAppPickerFiles.mockRejectedValue({
      code: 'NATIVE_MAIN_APP_PICKER_STAGE_INVALID',
    });
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft([existingFile, retainedText]),
    });

    await press(byLabel(renderer, 'Add Files'));

    expect(native.recoverMainAppPickerCache).toHaveBeenCalledTimes(1);
    expect(text(renderer)).toContain('NATIVE_MAIN_APP_PICKER_STAGE_INVALID');
    expect(text(renderer).replace(/\s+/g, ' ')).toContain('1 selected');
    expect(text(renderer)).toContain('Text 1');
    expect(text(renderer)).not.toContain('Photo 1');
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: false,
    });
    act(() => renderer.unmount());
  });

  test('locks the whole draft until rejected completed staging is recovered', async () => {
    const native = nativeAdapter();
    const systemPicker = picker();
    const existingFile: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'file',
      declaredMediaType: 'image/png',
      byteCount: 4,
      fileUri: 'file:///cache/existing.bin',
    };
    systemPicker.pickFiles.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/provider.bin',
          mediaType: 'application/pdf',
          byteCount: 8,
        },
      ],
    });
    native.stageMainAppPickerFiles.mockRejectedValue({
      code: 'NATIVE_MAIN_APP_PICKER_STAGE_INVALID',
    });
    native.recoverMainAppPickerCache
      .mockRejectedValueOnce({ code: 'MAIN_APP_IMPORT_CLEANUP_FAILED' })
      .mockResolvedValueOnce(undefined);
    const renderer = await render({
      native,
      picker: systemPicker,
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft([existingFile]),
    });

    await press(byLabel(renderer, 'Add Files'));

    expect(text(renderer)).toContain('MAIN_APP_IMPORT_CLEANUP_FAILED');
    expect(byLabel(renderer, 'Retry Temporary Cleanup')).toBeDefined();
    expect(byLabel(renderer, 'Add Files').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(
      byLabel(renderer, 'Remove Photo 1').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: true,
    });

    await press(byLabel(renderer, 'Retry Temporary Cleanup'));

    expect(native.recoverMainAppPickerCache).toHaveBeenCalledTimes(2);
    expect(text(renderer).replace(/\s+/g, ' ')).toContain('0 selected');
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Retry Temporary Cleanup',
      ),
    ).toHaveLength(0);
    expect(byLabel(renderer, 'Add Files').props.accessibilityState).toEqual({
      disabled: false,
    });
    act(() => renderer.unmount());
  });

  test('rejects oversized inline text without retaining or publishing it', async () => {
    const native = nativeAdapter();
    const renderer = await render({
      native,
      picker: picker(),
      onCancel: jest.fn(),
      onImported: jest.fn(),
      createDraft: () => draft(),
    });

    await change(
      byLabel(renderer, 'Text to add'),
      'x'.repeat(MAIN_APP_IMPORT_MAX_TEXT_BYTES + 1),
    );
    await press(byLabel(renderer, 'Add Text'));

    expect(text(renderer)).toContain('IMPORT_SIZE_LIMIT_EXCEEDED');
    expect(text(renderer).replace(/\s+/g, ' ')).toContain('0 selected');
    expect(byLabel(renderer, 'Import Pack').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(native.publishMainAppImport).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('keeps a committed Inbox import retryable when app persistence refresh fails', async () => {
    const native = nativeAdapter();
    const input: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'text',
      declaredMediaType: 'text/plain',
      byteCount: 7,
      text: 'fixture',
    };
    native.publishMainAppImport.mockResolvedValue({
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-08-07T00:00:00Z',
      source: 'main-app-text',
      status: 'complete',
      items: [
        {
          id: input.id,
          order: 0,
          mediaType: 'text/plain',
          status: 'copied',
          byteCount: 7,
          relativePath: `${input.id}.bin`,
        },
      ],
    });
    const onImported = jest
      .fn()
      .mockRejectedValueOnce({ code: 'STORAGE_WRITE_FAILED' })
      .mockResolvedValueOnce(undefined);
    const renderer = await render({
      native,
      picker: picker(),
      onCancel: jest.fn(),
      onImported,
      createDraft: () => draft([input]),
    });

    await press(byLabel(renderer, 'Import Pack'));

    expect(text(renderer)).toContain('STORAGE_WRITE_FAILED');
    expect(text(renderer)).toContain('Import recovery required');
    expect(text(renderer)).not.toContain('Import complete');
    expect(
      byLabel(renderer, 'Retry Import Recovery').props.accessibilityState,
    ).toEqual({
      disabled: false,
    });
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Cancel New Pack',
      ),
    ).toHaveLength(0);

    await press(byLabel(renderer, 'Retry Import Recovery'));
    expect(native.publishMainAppImport).toHaveBeenCalledTimes(2);
    expect(onImported).toHaveBeenCalledTimes(2);
    expect(text(renderer).replace(/[·\s]+/g, ' ')).toContain('Import complete');
    act(() => renderer.unmount());
  });

  test('locks cancellation after native reports committed cache-cleanup recovery', async () => {
    const native = nativeAdapter();
    const onCancel = jest.fn();
    const onImported = jest.fn().mockResolvedValue(undefined);
    const input: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'file',
      declaredMediaType: 'image/png',
      byteCount: 8,
      fileUri: 'file:///cache/committed-cleanup.png',
    };
    const committed: ImportManifestV1 = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-08-07T00:00:00Z',
      source: 'main-app-picker',
      status: 'complete',
      items: [
        {
          id: input.id,
          order: 0,
          mediaType: input.declaredMediaType,
          status: 'copied',
          byteCount: input.byteCount,
          relativePath: `${input.id}.bin`,
        },
      ],
    };
    native.publishMainAppImport
      .mockRejectedValueOnce({
        code: 'MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED',
      })
      .mockResolvedValueOnce(committed);
    const renderer = await render({
      native,
      picker: picker(),
      onCancel,
      onImported,
      createDraft: () => draft([input]),
    });

    await press(byLabel(renderer, 'Import Pack'));

    expect(text(renderer)).toContain(
      'MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED',
    );
    expect(text(renderer)).toContain('Import recovery required');
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Cancel New Pack',
      ),
    ).toHaveLength(0);
    expect(onCancel).not.toHaveBeenCalled();

    await press(byLabel(renderer, 'Retry Import Recovery'));

    expect(native.publishMainAppImport).toHaveBeenCalledTimes(2);
    expect(onImported).toHaveBeenCalledWith(committed);
    expect(text(renderer).replace(/[·\s]+/g, ' ')).toContain('Import complete');
    expect(onCancel).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('locks cancel and back after post-commit validation failure and retries idempotently', async () => {
    const native = nativeAdapter();
    const flowRef = React.createRef<NewPackFlowHandle>();
    const onCancel = jest.fn();
    const onImported = jest.fn().mockResolvedValue(undefined);
    const input: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'text',
      declaredMediaType: 'text/plain',
      byteCount: 7,
      text: 'fixture',
    };
    const committed: ImportManifestV1 = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-08-07T00:00:00Z',
      source: 'main-app-text',
      status: 'complete',
      items: [
        {
          id: input.id,
          order: 0,
          mediaType: input.declaredMediaType,
          status: 'copied',
          byteCount: input.byteCount,
          relativePath: `${input.id}.bin`,
        },
      ],
    };
    native.publishMainAppImport
      .mockRejectedValueOnce({
        code: 'MAIN_APP_IMPORT_COMMITTED_RECOVERY_REQUIRED',
      })
      .mockResolvedValueOnce(committed);
    const renderer = await render(
      {
        native,
        picker: picker(),
        onCancel,
        onImported,
        createDraft: () => draft([input]),
      },
      flowRef,
    );

    await press(byLabel(renderer, 'Import Pack'));

    expect(text(renderer)).toContain(
      'MAIN_APP_IMPORT_COMMITTED_RECOVERY_REQUIRED',
    );
    expect(text(renderer)).toContain('Import recovery required');
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Cancel New Pack',
      ),
    ).toHaveLength(0);
    await act(async () => {
      await flowRef.current?.cancel();
    });
    expect(onCancel).not.toHaveBeenCalled();

    await press(byLabel(renderer, 'Retry Import Recovery'));

    expect(native.publishMainAppImport).toHaveBeenCalledTimes(2);
    expect(native.publishMainAppImport.mock.calls.map(call => call[0])).toEqual(
      [ingestionId, ingestionId],
    );
    expect(onImported).toHaveBeenCalledWith(committed);
    expect(text(renderer).replace(/[·\s]+/g, ' ')).toContain('Import complete');
    expect(onCancel).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  test('locks cancellation when native publication returns an invalid committed result', async () => {
    const native = nativeAdapter();
    const onCancel = jest.fn();
    const onImported = jest.fn().mockResolvedValue(undefined);
    const input: MainAppImportInput = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      order: 0,
      kind: 'text',
      declaredMediaType: 'text/plain',
      byteCount: 7,
      text: 'fixture',
    };
    const committed: ImportManifestV1 = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-08-07T00:00:00Z',
      source: 'main-app-text',
      status: 'complete',
      items: [
        {
          id: input.id,
          order: 0,
          mediaType: input.declaredMediaType,
          status: 'copied',
          byteCount: input.byteCount,
          relativePath: `${input.id}.bin`,
        },
      ],
    };
    native.publishMainAppImport
      .mockRejectedValueOnce({
        code: 'NATIVE_MAIN_APP_IMPORT_RESULT_INVALID',
      })
      .mockResolvedValueOnce(committed);
    const renderer = await render({
      native,
      picker: picker(),
      onCancel,
      onImported,
      createDraft: () => draft([input]),
    });

    await press(byLabel(renderer, 'Import Pack'));

    expect(text(renderer)).toContain('NATIVE_MAIN_APP_IMPORT_RESULT_INVALID');
    expect(text(renderer)).toContain('Import recovery required');
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Cancel New Pack',
      ),
    ).toHaveLength(0);
    expect(onCancel).not.toHaveBeenCalled();

    await press(byLabel(renderer, 'Retry Import Recovery'));

    expect(native.publishMainAppImport).toHaveBeenCalledTimes(2);
    expect(onImported).toHaveBeenCalledWith(committed);
    expect(text(renderer).replace(/[·\s]+/g, ' ')).toContain('Import complete');
    expect(onCancel).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
