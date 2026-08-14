import React, { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { PackLibraryController } from '../src/features/packLibrary/controller';
import {
  PackLibraryScreen,
  synchronizeControlledPackSelection,
} from '../src/features/packLibrary/PackLibraryScreen';
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
        targetImageLongestEdge: 1_280,
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

test('controlled selection synchronization invalidates a pending load synchronously', () => {
  const state = {
    controlledPackId: packId,
    activePackId: packId,
    loadGeneration: 7,
  };
  const pendingGeneration = state.loadGeneration;
  const otherPackId = 'a23e4567-e89b-42d3-a456-426614174000';

  synchronizeControlledPackSelection(state, otherPackId);

  expect(state).toEqual({
    controlledPackId: otherPackId,
    activePackId: otherPackId,
    loadGeneration: 8,
  });
  expect(state.loadGeneration).not.toBe(pendingGeneration);
  synchronizeControlledPackSelection(state, otherPackId);
  expect(state.loadGeneration).toBe(8);
});

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
    analyzePack: jest.fn().mockResolvedValue(1),
    reviewDuplicateGroup: jest.fn().mockResolvedValue(undefined),
    restoreDuplicateDecision: jest.fn().mockResolvedValue(undefined),
    cancelProcessing: jest.fn().mockResolvedValue(undefined),
    previewBudget: jest.fn(),
    applyBudget: jest.fn(),
    cancelBudget: jest.fn(),
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

test('renders side-by-side duplicate review and wires reversible actions', async () => {
  const value = controller();
  value.load.mockResolvedValue({
    ...snapshot,
    selected: {
      ...snapshot.selected!,
      duplicateReview: {
        normalizationVersion: 'text-normalization-v1',
        detectorVersion: 1,
        actualBytesSaved: 128,
        actualCharactersSaved: 64,
        standaloneDecisions: [
          {
            id: itemIds[2],
            displayName: 'Stranded choice',
            contentKind: 'code',
            normalizedCharacterCount: 48,
            normalizedByteCount: 48,
            choice: 'exclude',
          },
        ],
        groups: [
          {
            key: `${itemIds[0]}:${itemIds[4]}`,
            reasons: ['near-image'],
            confidence: 0.98,
            expectedBytesSaved: 128,
            expectedCharactersSaved: 64,
            items: [
              {
                id: itemIds[0],
                displayName: 'Complete image',
                contentKind: 'prose',
                normalizedCharacterCount: 80,
                normalizedByteCount: 80,
                choice: 'preferred',
              },
              {
                id: itemIds[4],
                displayName: 'Duplicate image',
                contentKind: 'prose',
                normalizedCharacterCount: 80,
                normalizedByteCount: 80,
                choice: 'exclude',
              },
            ],
          },
        ],
      },
    },
  });
  const renderer = await render(value);

  expect(
    renderer.root.findByProps({ testID: 'duplicate-review' }),
  ).toBeDefined();
  expect(
    renderer.root.findByProps({ testID: 'duplicate-actual-savings' }),
  ).toBeDefined();
  expect(
    renderer.root.findByProps({ testID: `duplicate-preview-${itemIds[0]}` }),
  ).toBeDefined();
  expect(
    renderer.root.findByProps({ testID: `duplicate-preview-${itemIds[0]}` })
      .props.accessible,
  ).not.toBe(true);
  expect(
    renderer.root.findByProps({ testID: `duplicate-preview-${itemIds[4]}` }),
  ).toBeDefined();

  await press(button(renderer, 'Prefer Complete image'));
  expect(value.reviewDuplicateGroup).toHaveBeenCalledWith(
    packId,
    [itemIds[0], itemIds[4]],
    { kind: 'preferred', itemId: itemIds[0] },
  );
  await press(button(renderer, 'Keep all candidates'));
  expect(value.reviewDuplicateGroup).toHaveBeenCalledWith(
    packId,
    [itemIds[0], itemIds[4]],
    { kind: 'keep-all' },
  );
  expect(
    renderer.root.findByProps({ testID: 'duplicate-standalone-decisions' }),
  ).toBeDefined();
  await press(button(renderer, 'Restore Stranded choice'));
  expect(value.restoreDuplicateDecision).toHaveBeenCalledWith(
    packId,
    itemIds[2],
  );

  const chineseRenderer = await render(value, 'zh-Hans');
  const chinese = text(chineseRenderer.root);
  expect(chinese).toContain('视觉近似图片');
  expect(chinese).toContain('正文');
  expect(chinese).toContain('首选');
  expect(chinese).not.toContain('near-image');
  expect(chinese).not.toContain('prose');
  expect(chinese).not.toContain('preferred');
});

test('renders all required library views and every partial-failure item state', async () => {
  const value = controller();
  const renderer = await render(value);
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
  expect(dragHandle.props.accessibilityValue).toEqual({
    min: 1,
    max: itemIds.length,
    now: 2,
  });
  expect(dragHandle.props.accessibilityActions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'increment' }),
      expect.objectContaining({ name: 'decrement' }),
      expect.objectContaining({ name: 'moveUp' }),
      expect.objectContaining({ name: 'moveDown' }),
    ]),
  );
  expect(dragHandle.props.onMoveShouldSetResponder).toEqual(
    expect.any(Function),
  );
  expect(dragHandle.props.onStartShouldSetResponder()).toBe(true);
  await act(async () => {
    dragHandle.props.onAccessibilityAction({
      nativeEvent: { actionName: 'increment' },
    });
    await Promise.resolve();
  });
  expect(value.reorderItem).toHaveBeenCalledWith(packId, itemIds[1], 2);
  act(() => renderer.unmount());
});

test('previews a versioned budget plan and reports actual compression savings', async () => {
  const value = controller();
  const plan = {
    schemaVersion: 1 as const,
    planId: 'a23e4567-e89b-42d3-a456-426614174000',
    packId,
    packRevision: 3,
    createdAt: '2026-08-10T00:00:01Z',
    preset: 'compact' as const,
    estimatorVersion: 'context-budget-estimator-v1' as const,
    compressionVersion: 'image-compression-v1' as const,
    budget: {
      preset: 'compact' as const,
      maxOutputBytes: 5_242_880,
      minimumImageLongestEdge: 720,
      targetImageLongestEdge: 1_280,
      imageQuality: 0.7,
      estimatorVersion: 'context-budget-estimator-v1' as const,
    },
    estimate: {
      schemaVersion: 1 as const,
      estimatorVersion: 'context-budget-estimator-v1' as const,
      isEstimate: true as const,
      sourceBytes: 1_024,
      predictedOutputBytes: 512,
      imageCount: 1,
      pdfPageCount: 2,
      textCharacterCount: 400,
      estimatedTokens: 526,
    },
    withinBudget: true,
    predictedSavingsBytes: 512,
    excludedItemIds: [itemIds[1]],
    actions: [
      {
        kind: 'compress' as const,
        itemId: itemIds[0],
        outputArtifactId: 'b23e4567-e89b-42d3-a456-426614174000',
        sourceByteCount: 1_024,
        sourceSha256: 'a'.repeat(64),
        sourceMediaType: 'image/png',
        sourceWidth: 640,
        sourceHeight: 480,
        targetWidth: 320,
        targetHeight: 240,
        targetLongestEdge: 320,
        quality: 1,
        outputMediaType: 'image/png' as const,
        preserveAlpha: true,
        predictedOutputBytes: 512,
      },
    ],
    recommendations: [],
  };
  const result = {
    schemaVersion: 1 as const,
    planId: plan.planId,
    estimatorVersion: plan.estimatorVersion,
    compressionVersion: plan.compressionVersion,
    completedAt: '2026-08-10T00:00:02Z',
    predictedOutputBytes: 512,
    actualOutputBytes: 480,
    predictedSavingsBytes: 512,
    actualSavingsBytes: 544,
    deviationBytes: -32,
    withinBudget: true,
    excludedItemIds: plan.excludedItemIds,
    items: [
      {
        itemId: itemIds[0],
        action: 'compressed' as const,
        predictedOutputBytes: 512,
        actualOutputBytes: 480,
        actualSavingsBytes: 544,
        deviationBytes: -32,
        artifactId: 'b23e4567-e89b-42d3-a456-426614174000',
      },
    ],
  };
  value.previewBudget.mockResolvedValue(plan);
  let finishApply: ((value: typeof result) => void) | undefined;
  value.applyBudget.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishApply = resolve;
      }),
  );
  const renderer = await render(value);

  await press(button(renderer, 'Compact'));
  await press(button(renderer, 'Exclude Processing PDF from plan'));
  await press(button(renderer, 'Preview optimization plan'));
  expect(value.previewBudget).toHaveBeenCalledWith(packId, plan.budget, [
    itemIds[1],
  ]);
  expect(
    text(renderer.root.findByProps({ testID: 'budget-estimator-version' })),
  ).toContain('context-budget-estimator-v1');
  expect(
    text(renderer.root.findByProps({ testID: 'budget-estimate-summary' })),
  ).toContain('526');
  expect(
    renderer.root.findByProps({ testID: `budget-action-${itemIds[0]}` }),
  ).toBeDefined();
  expect(
    text(renderer.root.findByProps({ testID: 'budget-excluded-summary' })),
  ).toContain('Processing PDF');

  await press(button(renderer, 'Create compressed derivatives'));
  expect(value.applyBudget).toHaveBeenCalledWith(plan);
  const cancel = button(renderer, 'Cancel budget optimization');
  expect(cancel.props.accessibilityState?.disabled).toBe(false);
  await press(cancel);
  expect(value.cancelBudget).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishApply?.(result);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(
    text(renderer.root.findByProps({ testID: 'budget-actual-summary' })),
  ).toContain('480');
  expect(
    text(renderer.root.findByProps({ testID: 'budget-actual-summary' })),
  ).toContain('-32');
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

test('keeps Cancel enabled and dispatches it while duplicate analysis is pending', async () => {
  let finishAnalysis: (() => void) | undefined;
  const value = controller();
  value.analyzePack.mockReturnValue(
    new Promise(resolve => {
      finishAnalysis = () => resolve(1);
    }),
  );
  const renderer = await render(value);

  await press(button(renderer, 'Analyze normalized content'));
  const cancel = button(renderer, 'Cancel processing');
  expect(cancel.props.accessibilityState?.disabled).not.toBe(true);
  await press(cancel);
  expect(value.cancelProcessing).toHaveBeenCalledWith(packId);

  await act(async () => {
    finishAnalysis?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => renderer.unmount());
});

test('locks editor fields while a mutation is pending so reload cannot discard late typing', async () => {
  let finishMutation: (() => void) | undefined;
  const value = controller();
  value.renamePack.mockReturnValue(
    new Promise(resolve => {
      finishMutation = resolve;
    }),
  );
  const renderer = await render(value);

  expect(
    renderer.root.findAllByType(TextInput).every(input => input.props.editable),
  ).toBe(true);

  await press(button(renderer, 'Save Pack title'));

  expect(
    renderer.root
      .findAllByType(TextInput)
      .every(input => input.props.editable === false),
  ).toBe(true);

  await act(async () => {
    finishMutation?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    renderer.root.findAllByType(TextInput).every(input => input.props.editable),
  ).toBe(true);
  act(() => renderer.unmount());
});

test('preserves an unsaved instruction when saving the Pack title refreshes the graph', async () => {
  const value = controller();
  value.load.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
    ...snapshot,
    selected: {
      ...snapshot.selected!,
      pack: { ...snapshot.selected!.pack, title: 'Renamed Pack' },
      revision: snapshot.selected!.revision + 1,
    },
  });
  const renderer = await render(value);
  const inputs = () => renderer.root.findAllByType(TextInput);
  const title = inputs().find(
    node => node.props.accessibilityLabel === 'Pack title',
  )!;
  const instruction = inputs().find(
    node => node.props.accessibilityLabel === 'Task instruction',
  )!;

  act(() => {
    instruction.props.onChangeText('Unsaved instruction');
    title.props.onChangeText('Renamed Pack');
  });
  await press(button(renderer, 'Save Pack title'));

  expect(
    inputs().find(node => node.props.accessibilityLabel === 'Task instruction')!
      .props.value,
  ).toBe('Unsaved instruction');
  expect(
    inputs().find(node => node.props.accessibilityLabel === 'Pack title')!.props
      .value,
  ).toBe('Renamed Pack');
  act(() => renderer.unmount());
});

test('acknowledges normalized rename drafts so later persisted values replace them', async () => {
  const value = controller();
  const withCanonicalTitle: PackLibrarySnapshot = {
    ...snapshot,
    selected: {
      ...snapshot.selected!,
      pack: { ...snapshot.selected!.pack, title: 'Renamed' },
      revision: 4,
    },
  };
  const withCanonicalNames: PackLibrarySnapshot = {
    ...withCanonicalTitle,
    selected: {
      ...withCanonicalTitle.selected!,
      items: withCanonicalTitle.selected!.items.map((item, index) =>
        index === 0 ? { ...item, displayName: 'Renamed item' } : item,
      ),
      revision: 5,
    },
  };
  const withExternalValues: PackLibrarySnapshot = {
    ...withCanonicalNames,
    selected: {
      ...withCanonicalNames.selected!,
      pack: {
        ...withCanonicalNames.selected!.pack,
        title: 'Externally updated Pack',
      },
      items: withCanonicalNames.selected!.items.map((item, index) =>
        index === 0
          ? { ...item, displayName: 'Externally updated item' }
          : item,
      ),
      revision: 6,
    },
  };
  value.load
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce(withCanonicalTitle)
    .mockResolvedValueOnce(withCanonicalNames)
    .mockResolvedValueOnce(withExternalValues);
  const renderer = await render(value);
  const input = (label: string) =>
    renderer.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === label)!;

  act(() => input('Pack title').props.onChangeText(' Renamed '));
  await press(button(renderer, 'Save Pack title'));
  expect(value.renamePack).toHaveBeenCalledWith(packId, ' Renamed ');
  expect(input('Pack title').props.value).toBe('Renamed');

  act(() => input('Item name 1').props.onChangeText(' Renamed item '));
  await press(button(renderer, 'Save item name 1'));
  expect(value.renameItem).toHaveBeenCalledWith(
    packId,
    itemIds[0],
    ' Renamed item ',
  );
  expect(input('Item name 1').props.value).toBe('Renamed item');

  await press(button(renderer, 'Save task instruction'));
  expect(input('Pack title').props.value).toBe('Externally updated Pack');
  expect(input('Item name 1').props.value).toBe('Externally updated item');
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

test('invalidates a pending Pack load during the render that receives a newer controlled selection', async () => {
  const otherPackId = 'a23e4567-e89b-42d3-a456-426614174000';
  const row = snapshot.sections.processing[0]!;
  const sections = {
    ...snapshot.sections,
    processing: [row, { ...row, id: otherPackId, title: 'Other Pack' }],
  };
  const originalSnapshot: PackLibrarySnapshot = { ...snapshot, sections };
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
  let resolvePendingOriginal:
    | ((value: PackLibrarySnapshot) => void)
    | undefined;
  const value = controller();
  value.load
    .mockResolvedValueOnce(originalSnapshot)
    .mockReturnValueOnce(
      new Promise(resolve => {
        resolvePendingOriginal = resolve;
      }),
    )
    .mockResolvedValueOnce(otherSnapshot);
  const select = jest.fn();
  const properties = (selectedPackId: string): React.JSX.Element => (
    <PackLibraryScreen
      controller={value}
      locale="en"
      onChanged={async () => undefined}
      onSelectPack={select}
      refreshKey="controlled-selection"
      selectedPackId={selectedPackId}
    />
  );

  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(properties(packId));
    await Promise.resolve();
    await Promise.resolve();
  });
  await press(button(renderer!, 'Save Pack title'));
  expect(value.load).toHaveBeenCalledTimes(2);

  await act(async () => {
    renderer!.update(properties(otherPackId));
    resolvePendingOriginal?.(originalSnapshot);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(select).not.toHaveBeenCalledWith(packId);
  expect(
    renderer!.root.findByProps({ testID: `pack-editor-${otherPackId}` }),
  ).toBeDefined();
  act(() => renderer!.unmount());
});

test('keeps the newer Pack selected while surfacing a late mutation failure', async () => {
  const otherPackId = 'a23e4567-e89b-42d3-a456-426614174000';
  const row = snapshot.sections.processing[0]!;
  const sections = {
    ...snapshot.sections,
    processing: [row, { ...row, id: otherPackId, title: 'Other Pack' }],
  };
  const originalSnapshot: PackLibrarySnapshot = { ...snapshot, sections };
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
  let rejectMutation: ((reason: unknown) => void) | undefined;
  const value = controller();
  value.load.mockImplementation(async selected =>
    selected === otherPackId ? otherSnapshot : originalSnapshot,
  );
  value.renamePack.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectMutation = reject;
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
        refreshKey="mutation-error"
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
  await act(async () => {
    rejectMutation?.(
      Object.assign(new Error('synthetic failure'), {
        code: 'PERSISTENCE_CONFLICT',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    renderer!.root.findByProps({ testID: `pack-editor-${otherPackId}` }),
  ).toBeDefined();
  expect(
    text(renderer!.root.findByProps({ testID: 'pack-library-mutation-error' })),
  ).toContain('Pack action error · PERSISTENCE_CONFLICT');
  await press(button(renderer!, 'Dismiss error'));
  expect(
    renderer!.root.findAllByProps({
      testID: 'pack-library-mutation-error',
    }),
  ).toHaveLength(0);
  act(() => renderer!.unmount());
});
