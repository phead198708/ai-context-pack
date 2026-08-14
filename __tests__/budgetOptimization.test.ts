import {
  BUDGET_PRESETS,
  CONTEXT_BUDGET_ESTIMATOR_VERSION,
  budgetForPreset,
  completeBudgetOptimizationResultV1,
  createBudgetOptimizationPlanV1,
  estimatePackBudgetV1,
  isBudgetOptimizationResultV1,
  isImageCompressionInspectionV1,
  isImageCompressionResultV1,
  type BudgetSourceItemV1,
} from '../src/domain/budgetOptimization';
import { DomainError } from '../src/domain/errors';

const packId = id(900);
const createdAt = '2026-08-14T00:00:00Z';

describe('versioned Pack budget estimator', () => {
  test('reports bytes, images, pages, characters, and a labelled token estimate', () => {
    const items: BudgetSourceItemV1[] = [
      imageItem(1, 1_200_000, 1_800, 600),
      {
        itemId: id(2),
        sourceType: 'pdf',
        included: true,
        includeOriginal: true,
        includeExtracted: true,
        sourceByteCount: 800_000,
        textCharacterCount: 4_001,
        textUtf8ByteCount: 4_400,
        pdfPageCount: 3,
      },
      {
        itemId: id(3),
        sourceType: 'text',
        included: false,
        includeOriginal: false,
        includeExtracted: false,
        sourceByteCount: 900,
        textCharacterCount: 900,
        textUtf8ByteCount: 900,
        pdfPageCount: 0,
      },
    ];

    expect(estimatePackBudgetV1(items)).toEqual({
      schemaVersion: 1,
      estimatorVersion: CONTEXT_BUDGET_ESTIMATOR_VERSION,
      isEstimate: true,
      sourceBytes: 2_000_900,
      predictedOutputBytes: 2_004_500,
      imageCount: 1,
      pdfPageCount: 3,
      textCharacterCount: 4_101,
      estimatedTokens: 2_567,
    });
  });

  test.each([10, 20, 50])(
    'creates a stable, bounded synthetic %i-screenshot plan',
    count => {
      const items = Array.from({ length: count }, (_, index) =>
        imageItem(index + 1, 1_400_000 + index * 101, 1_800, 600),
      );
      const create = () =>
        createBudgetOptimizationPlanV1({
          planId: id(800),
          packId,
          packRevision: 4,
          createdAt,
          budget: BUDGET_PRESETS.compact,
          items,
          createArtifactId: itemId =>
            id(100 + items.findIndex(item => item.itemId === itemId)),
        });
      const first = create();
      const second = create();

      expect(second).toEqual(first);
      expect(first.actions).toHaveLength(count);
      expect(first.actions.every(action => action.kind === 'compress')).toBe(
        true,
      );
      expect(
        first.actions.every(
          action =>
            action.kind !== 'compress' ||
            action.targetLongestEdge >=
              BUDGET_PRESETS.compact.minimumImageLongestEdge,
        ),
      ).toBe(true);
    },
  );

  test('preserves transparent images as PNG with an explicit alpha contract', () => {
    const item = imageItem(1, 4_000_000, 2_000, 1_000, true);
    const plan = createBudgetOptimizationPlanV1({
      planId: id(800),
      packId,
      packRevision: 1,
      createdAt,
      budget: BUDGET_PRESETS.balanced,
      items: [item],
      createArtifactId: () => id(100),
    });

    expect(plan.actions[0]).toMatchObject({
      kind: 'compress',
      outputMediaType: 'image/png',
      preserveAlpha: true,
      quality: 1,
    });
  });

  test('estimates image tokens from the planned dimensions rather than the source', () => {
    const item = imageItem(1, 2_000_000, 1_800, 600);
    const before = estimatePackBudgetV1([item]);
    const plan = createBudgetOptimizationPlanV1({
      planId: id(800),
      packId,
      packRevision: 1,
      createdAt,
      budget: BUDGET_PRESETS.compact,
      items: [item],
      createArtifactId: () => id(100),
    });

    expect(plan.actions[0]).toMatchObject({
      kind: 'compress',
      targetWidth: 1_280,
      targetHeight: 427,
    });
    expect(plan.estimate.estimatedTokens).toBe(620);
    expect(plan.estimate.estimatedTokens).toBeLessThan(before.estimatedTokens);
  });

  test('terminates with actionable recommendations when fixed text exceeds the budget', () => {
    const plan = createBudgetOptimizationPlanV1({
      planId: id(800),
      packId,
      packRevision: 1,
      createdAt,
      budget: budgetForPreset('custom', 1_048_576),
      items: [
        {
          itemId: id(1),
          sourceType: 'text',
          included: true,
          includeOriginal: false,
          includeExtracted: true,
          sourceByteCount: 2_000_000,
          textCharacterCount: 2_000_000,
          textUtf8ByteCount: 2_000_000,
          pdfPageCount: 0,
        },
      ],
      createArtifactId: () => id(100),
    });

    expect(plan.withinBudget).toBe(false);
    expect(plan.recommendations).toEqual([
      'lower-quality',
      'ocr-only',
      'split-pack',
      'remove-items',
    ]);
  });

  test('records predicted versus actual savings without hiding overshoot', () => {
    const item = imageItem(1, 2_000_000, 1_800, 600);
    const plan = createBudgetOptimizationPlanV1({
      planId: id(800),
      packId,
      packRevision: 1,
      createdAt,
      budget: BUDGET_PRESETS.balanced,
      items: [item],
      createArtifactId: () => id(100),
    });
    const action = plan.actions[0]!;
    const actual = action.predictedOutputBytes + 12_345;
    const result = completeBudgetOptimizationResultV1({
      plan,
      completedAt: '2026-08-14T01:02:03Z',
      items: [
        {
          itemId: item.itemId,
          action: action.kind === 'keep' ? 'keep' : 'compressed',
          predictedOutputBytes: action.predictedOutputBytes,
          actualOutputBytes: actual,
          actualSavingsBytes: item.sourceByteCount - actual,
          deviationBytes: 12_345,
          ...(action.kind === 'compress'
            ? { artifactId: action.outputArtifactId }
            : {}),
        },
      ],
    });

    expect(result.deviationBytes).toBe(12_345);
    expect(result.actualOutputBytes).toBe(actual + item.textUtf8ByteCount);
    expect(isBudgetOptimizationResultV1(result)).toBe(true);
    expect(() =>
      completeBudgetOptimizationResultV1({
        plan,
        completedAt: '2026-08-14T01:02:03Z',
        items: [{ ...result.items[0]!, deviationBytes: 0 }],
      }),
    ).toThrow(new DomainError('SCHEMA_INVALID'));
    expect(() =>
      completeBudgetOptimizationResultV1({
        plan,
        completedAt: '2026-08-13T23:59:59Z',
        items: result.items,
      }),
    ).toThrow(new DomainError('SCHEMA_INVALID'));
  });

  test('rejects completion before the plan at sub-millisecond precision', () => {
    const item = imageItem(1, 2_000_000, 1_800, 600);
    const plan = createBudgetOptimizationPlanV1({
      planId: id(800),
      packId,
      packRevision: 1,
      createdAt: '2026-08-14T00:00:00.000000999Z',
      budget: BUDGET_PRESETS.compact,
      items: [item],
      createArtifactId: () => id(100),
    });
    const action = plan.actions[0]!;

    expect(() =>
      completeBudgetOptimizationResultV1({
        plan,
        completedAt: '2026-08-14T00:00:00.000000001Z',
        items: [
          {
            itemId: action.itemId,
            action: action.kind === 'compress' ? 'compressed' : 'keep',
            predictedOutputBytes: action.predictedOutputBytes,
            actualOutputBytes: action.predictedOutputBytes,
            actualSavingsBytes:
              action.sourceByteCount - action.predictedOutputBytes,
            deviationBytes: 0,
            ...(action.kind === 'compress'
              ? { artifactId: action.outputArtifactId }
              : {}),
          },
        ],
      }),
    ).toThrow(new DomainError('SCHEMA_INVALID'));
  });

  test('rejects invalid custom bounds and malformed native payloads', () => {
    expect(() => budgetForPreset('custom', 1_000)).toThrow(
      new DomainError('SCHEMA_INVALID'),
    );
    expect(
      isImageCompressionInspectionV1({
        ...imageItem(1, 100, 10, 10).image,
        animated: true,
      }),
    ).toBe(false);
    expect(
      isImageCompressionResultV1({
        schemaVersion: 1,
        taskId: id(1),
        sourceSha256: 'a'.repeat(64),
        temporaryFileUri: 'https://example.invalid/output.jpg',
        outputByteCount: 1,
        outputSha256: 'b'.repeat(64),
        width: 1,
        height: 1,
        mediaType: 'image/jpeg',
        quality: 0.8,
        alphaPreserved: false,
        engine: 'core-graphics',
        revision: '1',
        durationMs: 1,
      }),
    ).toBe(false);
    expect(() =>
      createBudgetOptimizationPlanV1({
        planId: id(800),
        packId,
        packRevision: 1,
        createdAt,
        budget: {
          ...BUDGET_PRESETS.balanced,
          targetImageLongestEdge: 1_000_000,
        },
        items: [imageItem(1, 100, 10, 10)],
        createArtifactId: () => id(100),
      }),
    ).toThrow(new DomainError('SCHEMA_INVALID'));
    const largeImage = imageItem(2, 2_000_000, 3_000, 2_000);
    expect(() =>
      createBudgetOptimizationPlanV1({
        planId: id(800),
        packId,
        packRevision: 1,
        createdAt,
        budget: BUDGET_PRESETS.compact,
        items: [largeImage],
        createArtifactId: () => largeImage.itemId,
      }),
    ).toThrow(new DomainError('SCHEMA_INVALID'));
  });

  test.each([
    ['original', true, false, 2_000_000, 0, 10],
    ['extracted', false, true, 1_000, 1_000, 0],
    ['both', true, true, 2_001_000, 1_000, 10],
    ['excluded', false, false, 0, 0, 0],
  ] as const)(
    'counts every %s PDF representation exactly once',
    (_mode, includeOriginal, includeExtracted, output, characters, pages) => {
      expect(
        estimatePackBudgetV1([
          {
            itemId: id(40),
            sourceType: 'pdf',
            included: includeOriginal || includeExtracted,
            includeOriginal,
            includeExtracted,
            sourceByteCount: 2_000_000,
            textCharacterCount: 1_000,
            textUtf8ByteCount: 1_000,
            pdfPageCount: 10,
          },
        ]),
      ).toMatchObject({
        sourceBytes: 2_000_000,
        predictedOutputBytes: output,
        textCharacterCount: characters,
        pdfPageCount: pages,
      });
    },
  );

  test('does not replace an empty extracted representation with source bytes', () => {
    expect(
      estimatePackBudgetV1([
        {
          itemId: id(41),
          sourceType: 'text',
          included: true,
          includeOriginal: false,
          includeExtracted: true,
          sourceByteCount: 2_000_000,
          textCharacterCount: 0,
          textUtf8ByteCount: 0,
          pdfPageCount: 0,
        },
      ]).predictedOutputBytes,
    ).toBe(0);
  });
});

function imageItem(
  index: number,
  sourceByteCount: number,
  width: number,
  height: number,
  hasAlpha = false,
): BudgetSourceItemV1 {
  return {
    itemId: id(index),
    sourceType: 'image',
    included: true,
    includeOriginal: true,
    includeExtracted: true,
    sourceByteCount,
    textCharacterCount: 100,
    textUtf8ByteCount: 100,
    pdfPageCount: 0,
    image: {
      schemaVersion: 1,
      sourceByteCount,
      sourceSha256: index.toString(16).padStart(64, '0'),
      sourceMediaType: hasAlpha ? 'image/png' : 'image/jpeg',
      width,
      height,
      hasAlpha,
      animated: false,
      orientationApplied: true,
      revision: '1',
    },
  };
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
