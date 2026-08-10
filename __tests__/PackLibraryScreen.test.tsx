import React, { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { PackLibraryController } from '../src/features/packLibrary/controller';
import { PackLibraryScreen } from '../src/features/packLibrary/PackLibraryScreen';
import type { PackLibrarySnapshot } from '../src/features/packLibrary/domain';

const packId = '123e4567-e89b-42d3-a456-426614174000';
const itemIds = [
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  '423e4567-e89b-42d3-a456-426614174000',
  '523e4567-e89b-42d3-a456-426614174000',
  '623e4567-e89b-42d3-a456-426614174000',
] as const;

const completeness = {
  total: 5,
  complete: 1,
  processing: 2,
  reviewRequired: 1,
  failed: 1,
  cancelled: 0,
} as const;

const snapshot: PackLibrarySnapshot = {
  sections: {
    draft: [],
    processing: [
      {
        id: packId,
        title: 'Mixed Pack',
        state: 'processing',
        section: 'processing',
        updatedAt: '2026-08-10T00:00:01Z',
        completeness,
        warningCount: 2,
      },
    ],
    'review-required': [],
    ready: [],
    exported: [],
    failed: [],
    cancelled: [],
  },
  selected: {
    pack: {
      id: packId,
      schemaVersion: 1,
      title: 'Mixed Pack',
      userInstruction: 'Summarize',
      createdAt: '2026-08-10T00:00:00Z',
      updatedAt: '2026-08-10T00:00:01Z',
      state: 'processing',
      budget: {
        preset: 'balanced',
        maxOutputBytes: 10_485_760,
        minimumImageLongestEdge: 1_280,
        imageQuality: 0.82,
        estimatorVersion: 'v1',
      },
      estimatedTokens: 0,
      orderedItemIds: itemIds,
      exportRecordIds: [],
      warningCodes: [],
    },
    revision: 3,
    completeness,
    items: [
      {
        id: itemIds[0],
        displayName: 'Complete image',
        sourceType: 'image',
        mediaType: 'image/png',
        byteCount: 128,
        state: 'packaged',
        stage: 'package',
        progress: 100,
        warningCodes: [],
      },
      {
        id: itemIds[1],
        displayName: 'Processing PDF',
        sourceType: 'pdf',
        mediaType: 'application/pdf',
        byteCount: 256,
        state: 'imported',
        stage: 'extract',
        progress: 20,
        warningCodes: [],
      },
      {
        id: itemIds[2],
        displayName: 'Failed image',
        sourceType: 'image',
        mediaType: 'image/png',
        byteCount: 64,
        state: 'failed',
        stage: 'extract',
        progress: 20,
        warningCodes: [],
        errorCode: 'PIPELINE_STAGE_FAILED',
        retryStage: 'extract',
      },
      {
        id: itemIds[3],
        displayName: 'Low confidence',
        sourceType: 'image',
        mediaType: 'image/png',
        byteCount: 96,
        state: 'review-required',
        stage: 'review',
        progress: 70,
        warningCodes: ['LOW_CONFIDENCE_REVIEW_REQUIRED'],
      },
      {
        id: itemIds[4],
        displayName: 'Duplicate image',
        sourceType: 'image',
        mediaType: 'image/png',
        byteCount: 128,
        state: 'extracted',
        stage: 'analyze',
        progress: 40,
        warningCodes: ['DUPLICATE_ORIGINAL'],
        duplicateOfItemId: itemIds[0],
      },
    ],
  },
};

function controller(): jest.Mocked<PackLibraryController> {
  return {
    load: jest.fn().mockResolvedValue(snapshot),
    renamePack: jest.fn().mockResolvedValue(undefined),
    editInstruction: jest.fn().mockResolvedValue(undefined),
    renameItem: jest.fn().mockResolvedValue(undefined),
    reorderItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
    retryItem: jest.fn().mockResolvedValue({
      packId,
      itemId: itemIds[2],
      stage: 'extract',
      completedArtifactIds: [itemIds[2]],
    }),
    retryPack: jest.fn().mockResolvedValue([]),
    cancelProcessing: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<PackLibraryController>;
}

async function render(
  value: jest.Mocked<PackLibraryController>,
  locale: 'en' | 'zh-Hans' = 'en',
  onChanged: () => Promise<void> = async () => undefined,
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  const select = jest.fn();
  await act(async () => {
    renderer = TestRenderer.create(
      <PackLibraryScreen
        controller={value}
        locale={locale}
        onChanged={onChanged}
        onSelectPack={select}
        refreshKey="fixture"
        selectedPackId={packId}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer as ReactTestRenderer;
}

function text(node: ReactTestInstance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : text(child)))
    .join('');
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const value = renderer.root
    .findAll(node => node.props.accessibilityRole === 'button')
    .find(node => node.props.accessibilityLabel === label);
  if (!value) throw new Error(`Missing button ${label}`);
  return value;
}

async function press(value: ReactTestInstance): Promise<void> {
  await act(async () => {
    value.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('exposes stable loading, error recovery, and empty-state identifiers', async () => {
  const pending = controller();
  pending.load.mockReturnValue(new Promise(() => undefined));
  let loadingRenderer: ReactTestRenderer | undefined;
  act(() => {
    loadingRenderer = TestRenderer.create(
      <PackLibraryScreen
        controller={pending}
        locale="en"
        onChanged={async () => undefined}
        onSelectPack={jest.fn()}
        refreshKey="loading"
        selectedPackId={packId}
      />,
    );
  });
  expect(
    loadingRenderer!.root.findByProps({ testID: 'pack-library-loading' }),
  ).toBeDefined();
  act(() => loadingRenderer!.unmount());

  const failed = controller();
  failed.load.mockRejectedValueOnce(new Error('synthetic failure'));
  const errorRenderer = await render(failed);
  expect(
    errorRenderer.root.findByProps({ testID: 'pack-library-error' }),
  ).toBeDefined();
  await press(button(errorRenderer, 'Retry'));
  expect(failed.load).toHaveBeenCalledTimes(2);
  act(() => errorRenderer.unmount());

  const empty = controller();
  empty.load.mockResolvedValue({
    sections: {
      draft: [],
      processing: [],
      'review-required': [],
      ready: [],
      exported: [],
      failed: [],
      cancelled: [],
    },
  });
  const emptyRenderer = await render(empty);
  expect(
    emptyRenderer.root.findByProps({ testID: 'pack-library-no-selection' }),
  ).toBeDefined();
  act(() => emptyRenderer.unmount());
});

test('renders all required library views and every partial-failure item state', async () => {
  const renderer = await render(controller());
  const rendered = text(renderer.root);

  for (const section of [
    'Draft · 0',
    'Processing · 1',
    'Review required · 0',
    'Ready · 0',
    'Exported · 0',
    'Failed · 0',
    'Cancelled · 0',
  ])
    expect(rendered).toContain(section);
  for (const name of [
    'Complete image',
    'Processing PDF',
    'Failed image',
    'Low confidence',
    'Duplicate image',
  ])
    expect(rendered).toContain(name);
  expect(rendered).toContain('PIPELINE_STAGE_FAILED');
  expect(rendered).toContain('LOW_CONFIDENCE_REVIEW_REQUIRED');
  expect(rendered).toContain('DUPLICATE_ORIGINAL');
  expect(rendered).toContain(
    '1/5 complete · 2 processing · 1 review · 1 failed · 0 cancelled',
  );
  const failed = renderer.root.findByProps({
    testID: `item-summary-${itemIds[2]}`,
  });
  expect(failed.props.accessibilityLabel).toContain(
    'status failed, stage extract, progress 20 percent',
  );
  expect(
    renderer.root.findByProps({ testID: `pack-item-${itemIds[2]}` }).props
      .accessible,
  ).toBeUndefined();
  expect(button(renderer, 'Save item name 3')).toBeDefined();
  expect(button(renderer, 'Retry from extract')).toBeDefined();
  expect(button(renderer, 'Remove from Pack 3')).toBeDefined();
  const dragHandle = renderer.root.findByProps({
    testID: `drag-${itemIds[1]}`,
  });
  expect(dragHandle.props.accessibilityRole).toBe('adjustable');
  expect(dragHandle.props.onMoveShouldSetResponder).toEqual(
    expect.any(Function),
  );
  act(() => renderer.unmount());
});

test('localizes Pack and item accessibility state in Simplified Chinese', async () => {
  const renderer = await render(controller(), 'zh-Hans');

  expect(text(renderer.root)).toContain('上下文包资料库');
  expect(text(renderer.root)).toContain('处理中 · 1');
  expect(text(renderer.root)).toContain('从提取阶段重试');
  const failed = renderer.root.findByProps({
    testID: `item-summary-${itemIds[2]}`,
  });
  expect(failed.props.accessibilityLabel).toContain(
    '状态失败，阶段提取，进度百分之20',
  );
  act(() => renderer.unmount());
});

test('supports rename, persisted reorder, retry, cancel, and non-destructive removal', async () => {
  const value = controller();
  const onChanged = jest.fn().mockResolvedValue(undefined);
  const renderer = await render(value, 'en', onChanged);
  const title = renderer.root
    .findAllByType(TextInput)
    .find(node => node.props.accessibilityLabel === 'Pack title')!;

  act(() => title.props.onChangeText('Renamed Pack'));
  await press(button(renderer, 'Save Pack title'));
  await press(button(renderer, 'Move Processing PDF up'));
  await press(button(renderer, 'Retry from extract'));
  await press(button(renderer, 'Remove from Pack 1'));
  await press(button(renderer, 'Cancel processing'));

  expect(value.renamePack).toHaveBeenCalledWith(packId, 'Renamed Pack');
  expect(value.reorderItem).toHaveBeenCalledWith(packId, itemIds[1], 0);
  expect(value.retryItem).toHaveBeenCalledWith(packId, itemIds[2]);
  expect(value.removeItem).toHaveBeenCalledWith(packId, itemIds[0], 'preserve');
  expect(value.cancelProcessing).toHaveBeenCalledWith(packId);
  expect(onChanged).toHaveBeenCalledTimes(5);
  act(() => renderer.unmount());
});

test('resumes a cancelled Pack from its durable item checkpoints', async () => {
  const value = controller();
  value.load.mockResolvedValue({
    ...snapshot,
    selected: {
      ...snapshot.selected!,
      pack: { ...snapshot.selected!.pack, state: 'cancelled' },
    },
  });
  const renderer = await render(value);

  await press(button(renderer, 'Retry Pack processing'));

  expect(value.retryPack).toHaveBeenCalledWith(packId);
  act(() => renderer.unmount());
});

test('requires explicit confirmation before releasing an original', async () => {
  const value = controller();
  const renderer = await render(value);
  let actions: Parameters<typeof Alert.alert>[2];
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) => {
      actions = buttons;
    });

  await press(button(renderer, 'Delete local original 1'));
  expect(alert).toHaveBeenCalledWith(
    'Permanently delete local original?',
    expect.stringContaining('cannot be undone'),
    expect.any(Array),
  );
  expect(value.removeItem).not.toHaveBeenCalled();

  await act(async () => {
    actions?.find(action => action.style === 'destructive')?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(value.removeItem).toHaveBeenCalledWith(packId, itemIds[0], 'release');
  alert.mockRestore();
  act(() => renderer.unmount());
});

test('ignores a stale Pack load when rapid selection resolves out of order', async () => {
  const otherPackId = 'a23e4567-e89b-42d3-a456-426614174000';
  const otherSnapshot: PackLibrarySnapshot = {
    ...snapshot,
    selected: {
      ...snapshot.selected!,
      pack: {
        ...snapshot.selected!.pack,
        id: otherPackId,
        title: 'Other Pack',
      },
    },
  };
  const bothRows: PackLibrarySnapshot = {
    ...snapshot,
    sections: {
      ...snapshot.sections,
      processing: [
        ...snapshot.sections.processing,
        {
          ...snapshot.sections.processing[0]!,
          id: otherPackId,
          title: 'Other Pack',
        },
      ],
    },
  };
  let resolveOther: ((value: PackLibrarySnapshot) => void) | undefined;
  let resolveOriginal: ((value: PackLibrarySnapshot) => void) | undefined;
  const value = controller();
  value.load
    .mockResolvedValueOnce(bothRows)
    .mockReturnValueOnce(
      new Promise(resolve => {
        resolveOther = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise(resolve => {
        resolveOriginal = resolve;
      }),
    );
  const renderer = await render(value);

  act(() => button(renderer, 'Open Other Pack').props.onPress());
  act(() => button(renderer, 'Open Mixed Pack').props.onPress());
  await act(async () => {
    resolveOriginal?.(bothRows);
    await Promise.resolve();
    resolveOther?.(otherSnapshot);
    await Promise.resolve();
  });

  expect(
    renderer.root.findAll(
      node =>
        node.type === View && node.props.testID === `pack-editor-${packId}`,
    ),
  ).toHaveLength(1);
  expect(
    renderer.root.findAll(
      node =>
        node.type === View &&
        node.props.testID === `pack-editor-${otherPackId}`,
    ),
  ).toHaveLength(0);
  act(() => renderer.unmount());
});

test('does not restore a mutated Pack after the user selects a newer Pack', async () => {
  const otherPackId = 'a23e4567-e89b-42d3-a456-426614174000';
  const row = snapshot.sections.processing[0]!;
  const sections = {
    ...snapshot.sections,
    processing: [row, { ...row, id: otherPackId, title: 'Other Pack' }],
  };
  const otherSnapshot: PackLibrarySnapshot = {
    ...snapshot,
    sections,
    selected: {
      ...snapshot.selected!,
      pack: {
        ...snapshot.selected!.pack,
        id: otherPackId,
        title: 'Other Pack',
      },
    },
  };
  const originalSnapshot: PackLibrarySnapshot = { ...snapshot, sections };
  let finishMutation: (() => void) | undefined;
  const value = controller();
  value.load.mockImplementation(async selected =>
    selected === otherPackId ? otherSnapshot : originalSnapshot,
  );
  value.renamePack.mockReturnValue(
    new Promise(resolve => {
      finishMutation = resolve;
    }),
  );

  function Harness(): React.JSX.Element {
    const [selected, setSelected] = useState(packId);
    return (
      <PackLibraryScreen
        controller={value}
        locale="en"
        onChanged={async () => undefined}
        onSelectPack={setSelected}
        refreshKey="mutation-selection"
        selectedPackId={selected}
      />
    );
  }

  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
    await Promise.resolve();
    await Promise.resolve();
  });
  await press(button(renderer!, 'Save Pack title'));
  await press(button(renderer!, 'Open Other Pack'));
  expect(
    renderer!.root.findByProps({ testID: `pack-editor-${otherPackId}` }),
  ).toBeDefined();

  await act(async () => {
    finishMutation?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(value.load.mock.calls.at(-1)?.[0]).toBe(otherPackId);
  expect(
    renderer!.root.findByProps({ testID: `pack-editor-${otherPackId}` }),
  ).toBeDefined();
  expect(
    renderer!.root.findAllByProps({ testID: `pack-editor-${packId}` }),
  ).toHaveLength(0);
  act(() => renderer!.unmount());
});
