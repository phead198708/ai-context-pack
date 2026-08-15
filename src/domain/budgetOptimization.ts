import { isCanonicalUuid } from './canonicalUuid';
import { DomainError } from './errors';
import { compareIsoDateTimes, isIsoDateTime } from './isoDateTime';
import {
  decodeVersionedContract,
  type ContractDecodeResult,
} from './compatibility';
import type {
  Budget,
  BudgetPreset,
  ContextItemSource,
  InclusionMode,
} from './models';

export const CONTEXT_BUDGET_ESTIMATOR_VERSION =
  'context-budget-estimator-v1' as const;
export const IMAGE_COMPRESSION_CONTRACT_VERSION = 1 as const;
export const IMAGE_COMPRESSION_PROCESSOR_VERSION =
  'image-compression-v1' as const;

const MEBIBYTE = 1_048_576;
const JPEG_MINIMUM_QUALITY = 0.58;
const JPEG_QUALITY_STEP = 0.06;
const MAXIMUM_BUDGET_IMAGE_LONGEST_EDGE = 4_096;
const SUPPORTED_SOURCE_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export interface PackBudgetEstimateV1 {
  readonly schemaVersion: 1;
  readonly estimatorVersion: typeof CONTEXT_BUDGET_ESTIMATOR_VERSION;
  readonly isEstimate: true;
  readonly sourceBytes: number;
  readonly predictedOutputBytes: number;
  readonly imageCount: number;
  readonly pdfPageCount: number;
  readonly textCharacterCount: number;
  readonly estimatedTokens: number;
}

export interface ImageCompressionInspectionV1 {
  readonly schemaVersion: 1;
  readonly sourceByteCount: number;
  readonly sourceSha256: string;
  readonly sourceMediaType: string;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly animated: false;
  readonly orientationApplied: true;
  readonly revision: string;
}

export interface BudgetSourceItemV1 {
  readonly itemId: string;
  readonly sourceType: ContextItemSource;
  readonly included: boolean;
  readonly includeOriginal: boolean;
  readonly includeExtracted: boolean;
  readonly sourceByteCount: number;
  readonly textCharacterCount: number;
  readonly textUtf8ByteCount: number;
  readonly pdfPageCount: number;
  readonly image?: ImageCompressionInspectionV1;
}

export interface BudgetItemExclusionV1 {
  readonly itemId: string;
  readonly baselineInclusionMode: Exclude<InclusionMode, 'excluded'>;
}

export type BudgetRecommendationV1 =
  | 'lower-quality'
  | 'ocr-only'
  | 'split-pack'
  | 'remove-items';

export interface KeepImageOptimizationActionV1 {
  readonly kind: 'keep';
  readonly itemId: string;
  readonly sourceByteCount: number;
  readonly predictedOutputBytes: number;
  readonly reason: 'already-efficient' | 'transparent-not-smaller';
}

export interface CompressImageOptimizationActionV1 {
  readonly kind: 'compress';
  readonly itemId: string;
  readonly outputArtifactId: string;
  readonly sourceByteCount: number;
  readonly sourceSha256: string;
  readonly sourceMediaType: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly targetLongestEdge: number;
  readonly quality: number;
  readonly outputMediaType: 'image/jpeg' | 'image/png';
  readonly preserveAlpha: boolean;
  readonly predictedOutputBytes: number;
}

export type ImageOptimizationActionV1 =
  | KeepImageOptimizationActionV1
  | CompressImageOptimizationActionV1;

export interface BudgetOptimizationPlanV1 {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly packId: string;
  readonly packRevision: number;
  readonly createdAt: string;
  readonly preset: BudgetPreset;
  readonly estimatorVersion: typeof CONTEXT_BUDGET_ESTIMATOR_VERSION;
  readonly compressionVersion: typeof IMAGE_COMPRESSION_PROCESSOR_VERSION;
  readonly budget: Budget;
  readonly estimate: PackBudgetEstimateV1;
  readonly withinBudget: boolean;
  readonly predictedSavingsBytes: number;
  readonly excludedItemIds: readonly string[];
  readonly actions: readonly ImageOptimizationActionV1[];
  readonly recommendations: readonly BudgetRecommendationV1[];
}

export interface BudgetOptimizationItemResultV1 {
  readonly itemId: string;
  readonly action: 'keep' | 'compressed';
  readonly predictedOutputBytes: number;
  readonly actualOutputBytes: number;
  readonly actualSavingsBytes: number;
  readonly deviationBytes: number;
  readonly artifactId?: string;
}

export interface BudgetOptimizationResultV1 {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly estimatorVersion: typeof CONTEXT_BUDGET_ESTIMATOR_VERSION;
  readonly compressionVersion: typeof IMAGE_COMPRESSION_PROCESSOR_VERSION;
  readonly completedAt: string;
  readonly predictedOutputBytes: number;
  readonly actualOutputBytes: number;
  readonly predictedSavingsBytes: number;
  readonly actualSavingsBytes: number;
  readonly deviationBytes: number;
  readonly withinBudget: boolean;
  readonly excludedItemIds: readonly string[];
  readonly items: readonly BudgetOptimizationItemResultV1[];
}

export interface ImageCompressionResultV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sourceSha256: string;
  readonly temporaryFileUri: string;
  readonly outputByteCount: number;
  readonly outputSha256: string;
  readonly width: number;
  readonly height: number;
  readonly mediaType: 'image/jpeg' | 'image/png';
  readonly quality: number;
  readonly alphaPreserved: boolean;
  readonly engine: 'core-graphics' | 'android-bitmap';
  readonly revision: string;
  readonly durationMs: number;
}

export interface ImageCompressionRequestV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly fileUri: string;
  readonly expectedByteCount: number;
  readonly expectedSha256: string;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly quality: number;
  readonly outputMediaType: 'image/jpeg' | 'image/png';
  readonly preserveAlpha: boolean;
}

export function isImageCompressionRequestV1(
  value: unknown,
): value is ImageCompressionRequestV1 {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      'schemaVersion',
      'taskId',
      'fileUri',
      'expectedByteCount',
      'expectedSha256',
      'targetWidth',
      'targetHeight',
      'quality',
      'outputMediaType',
      'preserveAlpha',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.taskId === 'string' &&
    isCanonicalUuid(value.taskId) &&
    typeof value.fileUri === 'string' &&
    value.fileUri.startsWith('file://') &&
    isPositiveSafeInteger(value.expectedByteCount) &&
    value.expectedByteCount <= 52_428_800 &&
    typeof value.expectedSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.expectedSha256) &&
    isPositiveSafeInteger(value.targetWidth) &&
    isPositiveSafeInteger(value.targetHeight) &&
    value.targetWidth * value.targetHeight <= 4_194_304 &&
    typeof value.quality === 'number' &&
    Number.isFinite(value.quality) &&
    value.quality >= 0.58 &&
    value.quality <= 1 &&
    (value.outputMediaType === 'image/jpeg' ||
      value.outputMediaType === 'image/png') &&
    typeof value.preserveAlpha === 'boolean' &&
    (value.outputMediaType === 'image/png') === value.preserveAlpha &&
    (value.outputMediaType !== 'image/png' || value.quality === 1)
  );
}

export const BUDGET_PRESETS = {
  quality: {
    preset: 'quality',
    maxOutputBytes: 20 * MEBIBYTE,
    minimumImageLongestEdge: 1_280,
    targetImageLongestEdge: 2_048,
    imageQuality: 0.9,
    estimatorVersion: CONTEXT_BUDGET_ESTIMATOR_VERSION,
  },
  balanced: {
    preset: 'balanced',
    maxOutputBytes: 10 * MEBIBYTE,
    minimumImageLongestEdge: 960,
    targetImageLongestEdge: 1_600,
    imageQuality: 0.82,
    estimatorVersion: CONTEXT_BUDGET_ESTIMATOR_VERSION,
  },
  compact: {
    preset: 'compact',
    maxOutputBytes: 5 * MEBIBYTE,
    minimumImageLongestEdge: 720,
    targetImageLongestEdge: 1_280,
    imageQuality: 0.7,
    estimatorVersion: CONTEXT_BUDGET_ESTIMATOR_VERSION,
  },
} as const satisfies Readonly<Record<Exclude<BudgetPreset, 'custom'>, Budget>>;

export function budgetForPreset(
  preset: BudgetPreset,
  customMaximumBytes?: number,
): Budget {
  if (preset === 'custom') {
    if (
      !Number.isSafeInteger(customMaximumBytes) ||
      customMaximumBytes === undefined ||
      customMaximumBytes < MEBIBYTE ||
      customMaximumBytes > 100 * MEBIBYTE
    )
      throw new DomainError('SCHEMA_INVALID');
    return {
      ...BUDGET_PRESETS.balanced,
      preset,
      maxOutputBytes: customMaximumBytes,
    };
  }
  return { ...BUDGET_PRESETS[preset] };
}

export function estimatePackBudgetV1(
  items: readonly BudgetSourceItemV1[],
  predictedImageOutputBytes?: ReadonlyMap<string, number>,
): PackBudgetEstimateV1 {
  assertUniqueBudgetItems(items);
  let sourceBytes = 0;
  let predictedOutputBytes = 0;
  let imageCount = 0;
  let pdfPageCount = 0;
  let textCharacterCount = 0;
  let estimatedTokens = 0;
  for (const item of items) {
    sourceBytes = safeAdd(sourceBytes, item.sourceByteCount);
    if (!item.included) continue;
    if (item.includeExtracted) {
      textCharacterCount = safeAdd(textCharacterCount, item.textCharacterCount);
      predictedOutputBytes = safeAdd(
        predictedOutputBytes,
        item.textUtf8ByteCount,
      );
      estimatedTokens = safeAdd(
        estimatedTokens,
        Math.ceil(item.textCharacterCount / 4),
      );
    }
    if (item.includeOriginal) {
      predictedOutputBytes = safeAdd(
        predictedOutputBytes,
        item.image
          ? predictedImageOutputBytes?.get(item.itemId) ?? item.sourceByteCount
          : item.sourceByteCount,
      );
      pdfPageCount = safeAdd(pdfPageCount, item.pdfPageCount);
      estimatedTokens = safeAdd(estimatedTokens, item.pdfPageCount * 32);
    }
    if (item.includeOriginal && item.image) {
      imageCount = safeAdd(imageCount, 1);
      estimatedTokens = safeAdd(
        estimatedTokens,
        imageTokenEstimate(item.image.width, item.image.height),
      );
    }
  }
  return {
    schemaVersion: 1,
    estimatorVersion: CONTEXT_BUDGET_ESTIMATOR_VERSION,
    isEstimate: true,
    sourceBytes,
    predictedOutputBytes,
    imageCount,
    pdfPageCount,
    textCharacterCount,
    estimatedTokens,
  };
}

export function createBudgetOptimizationPlanV1(input: {
  readonly planId: string;
  readonly packId: string;
  readonly packRevision: number;
  readonly createdAt: string;
  readonly budget: Budget;
  readonly items: readonly BudgetSourceItemV1[];
  readonly exclusions: readonly BudgetItemExclusionV1[];
  readonly createArtifactId: (itemId: string) => string;
}): BudgetOptimizationPlanV1 {
  if (
    !isCanonicalUuid(input.planId) ||
    !isCanonicalUuid(input.packId) ||
    !Number.isSafeInteger(input.packRevision) ||
    input.packRevision < 1 ||
    !isIsoDateTime(input.createdAt) ||
    !isSupportedBudget(input.budget)
  )
    throw new DomainError('SCHEMA_INVALID');
  const planBudget = { ...input.budget };
  delete planBudget.pendingOptimization;
  assertUniqueBudgetItems(input.items);
  if (!isBudgetItemExclusionArrayV1(input.exclusions))
    throw new DomainError('SCHEMA_INVALID');
  const images = input.items.filter(
    (
      item,
    ): item is BudgetSourceItemV1 & {
      readonly image: ImageCompressionInspectionV1;
    } => item.included && item.image !== undefined,
  );
  const candidates = finiteCompressionCandidates(input.budget);
  let selected = candidates.at(-1)!;
  let selectedPredictions = new Map<string, number>();
  for (const candidate of candidates) {
    const predictions = new Map(
      images.map(item => [
        item.itemId,
        predictImageOutputBytes(item.image, candidate.edge, candidate.quality),
      ]),
    );
    selected = candidate;
    selectedPredictions = predictions;
    if (
      estimatePackBudgetV1(input.items, predictions).predictedOutputBytes <=
      input.budget.maxOutputBytes
    )
      break;
  }
  const actions = images.map(item => {
    const image = item.image;
    const predictedOutputBytes = selectedPredictions.get(item.itemId)!;
    const resized = scaledDimensions(image.width, image.height, selected.edge);
    const shouldKeep =
      resized.width === image.width &&
      resized.height === image.height &&
      predictedOutputBytes >= image.sourceByteCount;
    if (shouldKeep) {
      return {
        kind: 'keep',
        itemId: item.itemId,
        sourceByteCount: image.sourceByteCount,
        predictedOutputBytes: image.sourceByteCount,
        reason: image.hasAlpha
          ? 'transparent-not-smaller'
          : 'already-efficient',
      } satisfies KeepImageOptimizationActionV1;
    }
    const outputArtifactId = input.createArtifactId(item.itemId);
    if (!isCanonicalUuid(outputArtifactId))
      throw new DomainError('SCHEMA_INVALID');
    return {
      kind: 'compress',
      itemId: item.itemId,
      outputArtifactId,
      sourceByteCount: image.sourceByteCount,
      sourceSha256: image.sourceSha256,
      sourceMediaType: image.sourceMediaType,
      sourceWidth: image.width,
      sourceHeight: image.height,
      targetWidth: resized.width,
      targetHeight: resized.height,
      targetLongestEdge: selected.edge,
      quality: image.hasAlpha ? 1 : selected.quality,
      outputMediaType: image.hasAlpha ? 'image/png' : 'image/jpeg',
      preserveAlpha: image.hasAlpha,
      predictedOutputBytes,
    } satisfies CompressImageOptimizationActionV1;
  });
  const outputArtifactIds = actions.flatMap(action =>
    action.kind === 'compress' ? [action.outputArtifactId] : [],
  );
  const reservedIds = new Set([
    input.packId,
    input.planId,
    ...input.items.map(item => item.itemId),
  ]);
  if (
    new Set(outputArtifactIds).size !== outputArtifactIds.length ||
    outputArtifactIds.some(artifactId => reservedIds.has(artifactId))
  )
    throw new DomainError('SCHEMA_INVALID');
  const effectivePredictions = new Map(
    actions.map(action => [action.itemId, action.predictedOutputBytes]),
  );
  const actionByItem = new Map(actions.map(action => [action.itemId, action]));
  const estimatedItems = input.items.map(item => {
    const action = actionByItem.get(item.itemId);
    return action?.kind === 'compress' && item.image
      ? {
          ...item,
          image: {
            ...item.image,
            width: action.targetWidth,
            height: action.targetHeight,
          },
        }
      : item;
  });
  const estimate = estimatePackBudgetV1(estimatedItems, effectivePredictions);
  const withinBudget =
    estimate.predictedOutputBytes <= input.budget.maxOutputBytes;
  const excludedItemIds = input.items
    .filter(item => !item.included)
    .map(item => item.itemId)
    .sort();
  if (
    input.exclusions.some(
      exclusion => !excludedItemIds.includes(exclusion.itemId),
    )
  )
    throw new DomainError('SCHEMA_INVALID');
  if (input.exclusions.length > 0)
    planBudget.exclusions = input.exclusions.map(exclusion => ({
      ...exclusion,
    }));
  else delete planBudget.exclusions;
  return {
    schemaVersion: 1,
    planId: input.planId,
    packId: input.packId,
    packRevision: input.packRevision,
    createdAt: input.createdAt,
    preset: input.budget.preset,
    estimatorVersion: CONTEXT_BUDGET_ESTIMATOR_VERSION,
    compressionVersion: IMAGE_COMPRESSION_PROCESSOR_VERSION,
    budget: planBudget,
    estimate,
    withinBudget,
    predictedSavingsBytes: Math.max(
      0,
      estimate.sourceBytes - estimate.predictedOutputBytes,
    ),
    excludedItemIds,
    actions,
    recommendations: withinBudget
      ? []
      : ['lower-quality', 'ocr-only', 'split-pack', 'remove-items'],
  };
}

export function completeBudgetOptimizationResultV1(input: {
  readonly plan: BudgetOptimizationPlanV1;
  readonly completedAt: string;
  readonly items: readonly BudgetOptimizationItemResultV1[];
}): BudgetOptimizationResultV1 {
  if (
    !isIsoDateTime(input.completedAt) ||
    compareIsoDateTimes(input.completedAt, input.plan.createdAt) < 0 ||
    input.items.length !== input.plan.actions.length ||
    input.items.some(result => {
      const action = input.plan.actions.find(
        candidate => candidate.itemId === result.itemId,
      );
      return (
        !action ||
        result.action !==
          (action.kind === 'compress' ? 'compressed' : 'keep') ||
        result.predictedOutputBytes !== action.predictedOutputBytes ||
        result.actualSavingsBytes !==
          Math.max(0, action.sourceByteCount - result.actualOutputBytes) ||
        result.deviationBytes !==
          result.actualOutputBytes - result.predictedOutputBytes ||
        (action.kind === 'compress'
          ? result.artifactId !== action.outputArtifactId
          : result.artifactId !== undefined)
      );
    }) ||
    new Set(input.items.map(item => item.itemId)).size !== input.items.length
  )
    throw new DomainError('SCHEMA_INVALID');
  const nonImageBytes =
    input.plan.estimate.predictedOutputBytes -
    input.plan.actions.reduce(
      (sum, action) => safeAdd(sum, action.predictedOutputBytes),
      0,
    );
  const actualOutputBytes = input.items.reduce(
    (sum, item) => safeAdd(sum, item.actualOutputBytes),
    nonImageBytes,
  );
  return {
    schemaVersion: 1,
    planId: input.plan.planId,
    estimatorVersion: input.plan.estimatorVersion,
    compressionVersion: input.plan.compressionVersion,
    completedAt: input.completedAt,
    predictedOutputBytes: input.plan.estimate.predictedOutputBytes,
    actualOutputBytes,
    predictedSavingsBytes: input.plan.predictedSavingsBytes,
    actualSavingsBytes: Math.max(
      0,
      input.plan.estimate.sourceBytes - actualOutputBytes,
    ),
    deviationBytes:
      actualOutputBytes - input.plan.estimate.predictedOutputBytes,
    withinBudget: actualOutputBytes <= input.plan.budget.maxOutputBytes,
    excludedItemIds: input.plan.excludedItemIds,
    items: input.items,
  };
}

export function isPackBudgetEstimateV1(
  value: unknown,
): value is PackBudgetEstimateV1 {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      'schemaVersion',
      'estimatorVersion',
      'isEstimate',
      'sourceBytes',
      'predictedOutputBytes',
      'imageCount',
      'pdfPageCount',
      'textCharacterCount',
      'estimatedTokens',
    ]) &&
    value.schemaVersion === 1 &&
    value.estimatorVersion === CONTEXT_BUDGET_ESTIMATOR_VERSION &&
    value.isEstimate === true &&
    [
      value.sourceBytes,
      value.predictedOutputBytes,
      value.imageCount,
      value.pdfPageCount,
      value.textCharacterCount,
      value.estimatedTokens,
    ].every(isNonNegativeSafeInteger)
  );
}

export function isBudgetOptimizationPlanV1(
  value: unknown,
): value is BudgetOptimizationPlanV1 {
  if (!isRecord(value)) return false;
  const keys = [
    'schemaVersion',
    'planId',
    'packId',
    'packRevision',
    'createdAt',
    'preset',
    'estimatorVersion',
    'compressionVersion',
    'budget',
    'estimate',
    'withinBudget',
    'predictedSavingsBytes',
    'excludedItemIds',
    'actions',
    'recommendations',
  ];
  const actions = Array.isArray(value.actions) ? value.actions : [];
  if (!isSortedUniqueCanonicalIds(value.excludedItemIds)) return false;
  const excludedItemIds = value.excludedItemIds;
  const outputArtifactIds = actions.flatMap(action =>
    isRecord(action) &&
    action.kind === 'compress' &&
    typeof action.outputArtifactId === 'string'
      ? [action.outputArtifactId]
      : [],
  );
  const reservedIds = new Set([
    value.packId,
    value.planId,
    ...actions.flatMap(action =>
      isRecord(action) && typeof action.itemId === 'string'
        ? [action.itemId]
        : [],
    ),
  ]);
  if (
    !exactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    !isCanonicalUuid(value.planId) ||
    !isCanonicalUuid(value.packId) ||
    !isPositiveSafeInteger(value.packRevision) ||
    !isIsoDateTime(value.createdAt) ||
    !isPlanBudget(value.budget) ||
    value.preset !== value.budget.preset ||
    value.estimatorVersion !== CONTEXT_BUDGET_ESTIMATOR_VERSION ||
    value.compressionVersion !== IMAGE_COMPRESSION_PROCESSOR_VERSION ||
    !isPackBudgetEstimateV1(value.estimate) ||
    typeof value.withinBudget !== 'boolean' ||
    value.withinBudget !==
      value.estimate.predictedOutputBytes <= value.budget.maxOutputBytes ||
    !isNonNegativeSafeInteger(value.predictedSavingsBytes) ||
    value.predictedSavingsBytes !==
      Math.max(
        0,
        value.estimate.sourceBytes - value.estimate.predictedOutputBytes,
      ) ||
    (value.budget.exclusions ?? []).some(
      exclusion => !excludedItemIds.includes(exclusion.itemId),
    ) ||
    !Array.isArray(value.actions) ||
    !value.actions.every(isImageOptimizationActionV1) ||
    new Set(value.actions.map(action => action.itemId)).size !==
      value.actions.length ||
    new Set(outputArtifactIds).size !== outputArtifactIds.length ||
    outputArtifactIds.some(artifactId => reservedIds.has(artifactId)) ||
    !Array.isArray(value.recommendations) ||
    !value.recommendations.every(isBudgetRecommendationV1) ||
    new Set(value.recommendations).size !== value.recommendations.length
  )
    return false;
  return true;
}

export function isBudgetOptimizationResultV1(
  value: unknown,
): value is BudgetOptimizationResultV1 {
  if (!isRecord(value)) return false;
  const allowed = [
    'schemaVersion',
    'planId',
    'estimatorVersion',
    'compressionVersion',
    'completedAt',
    'predictedOutputBytes',
    'actualOutputBytes',
    'predictedSavingsBytes',
    'actualSavingsBytes',
    'deviationBytes',
    'withinBudget',
    'excludedItemIds',
    'items',
  ];
  return (
    Object.keys(value).every(key => allowed.includes(key)) &&
    Object.keys(value).length === allowed.length &&
    value.schemaVersion === 1 &&
    typeof value.planId === 'string' &&
    isCanonicalUuid(value.planId) &&
    value.estimatorVersion === CONTEXT_BUDGET_ESTIMATOR_VERSION &&
    value.compressionVersion === IMAGE_COMPRESSION_PROCESSOR_VERSION &&
    isIsoDateTime(value.completedAt) &&
    [
      value.predictedOutputBytes,
      value.actualOutputBytes,
      value.predictedSavingsBytes,
      value.actualSavingsBytes,
    ].every(isNonNegativeSafeInteger) &&
    Number.isSafeInteger(value.deviationBytes) &&
    typeof value.withinBudget === 'boolean' &&
    isSortedUniqueCanonicalIds(value.excludedItemIds) &&
    Array.isArray(value.items) &&
    value.items.every(isBudgetOptimizationItemResultV1) &&
    new Set(value.items.map(item => item.itemId)).size === value.items.length
  );
}

export function isImageCompressionInspectionV1(
  value: unknown,
): value is ImageCompressionInspectionV1 {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      'schemaVersion',
      'sourceByteCount',
      'sourceSha256',
      'sourceMediaType',
      'width',
      'height',
      'hasAlpha',
      'animated',
      'orientationApplied',
      'revision',
    ]) &&
    value.schemaVersion === 1 &&
    isPositiveSafeInteger(value.sourceByteCount) &&
    value.sourceByteCount <= 52_428_800 &&
    typeof value.sourceSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sourceSha256) &&
    typeof value.sourceMediaType === 'string' &&
    SUPPORTED_SOURCE_IMAGE_MEDIA_TYPES.has(value.sourceMediaType) &&
    isPositiveSafeInteger(value.width) &&
    isPositiveSafeInteger(value.height) &&
    value.width * value.height <= 16_000_000 &&
    typeof value.hasAlpha === 'boolean' &&
    value.animated === false &&
    value.orientationApplied === true &&
    typeof value.revision === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/.test(value.revision)
  );
}

export function isImageCompressionResultV1(
  value: unknown,
): value is ImageCompressionResultV1 {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      'schemaVersion',
      'taskId',
      'sourceSha256',
      'temporaryFileUri',
      'outputByteCount',
      'outputSha256',
      'width',
      'height',
      'mediaType',
      'quality',
      'alphaPreserved',
      'engine',
      'revision',
      'durationMs',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.taskId === 'string' &&
    isCanonicalUuid(value.taskId) &&
    typeof value.sourceSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sourceSha256) &&
    typeof value.temporaryFileUri === 'string' &&
    value.temporaryFileUri.startsWith('file://') &&
    isPositiveSafeInteger(value.outputByteCount) &&
    value.outputByteCount <= 52_428_800 &&
    typeof value.outputSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.outputSha256) &&
    isPositiveSafeInteger(value.width) &&
    isPositiveSafeInteger(value.height) &&
    value.width * value.height <= 4_194_304 &&
    (value.mediaType === 'image/jpeg' || value.mediaType === 'image/png') &&
    typeof value.quality === 'number' &&
    Number.isFinite(value.quality) &&
    value.quality >= JPEG_MINIMUM_QUALITY &&
    value.quality <= 1 &&
    typeof value.alphaPreserved === 'boolean' &&
    (value.mediaType === 'image/png') === value.alphaPreserved &&
    (value.mediaType !== 'image/png' || value.quality === 1) &&
    (value.engine === 'core-graphics' || value.engine === 'android-bitmap') &&
    typeof value.revision === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/.test(value.revision) &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

export function decodeImageCompressionInspectionV1(
  value: unknown,
): ContractDecodeResult<ImageCompressionInspectionV1> {
  return decodeVersionedContract(
    'imageCompressionInspection',
    value,
    isImageCompressionInspectionV1,
  );
}

export function decodeImageCompressionResultV1(
  value: unknown,
): ContractDecodeResult<ImageCompressionResultV1> {
  return decodeVersionedContract(
    'imageCompressionResult',
    value,
    isImageCompressionResultV1,
  );
}

function isBudgetOptimizationItemResultV1(
  value: unknown,
): value is BudgetOptimizationItemResultV1 {
  if (!isRecord(value)) return false;
  const allowed = [
    'itemId',
    'action',
    'predictedOutputBytes',
    'actualOutputBytes',
    'actualSavingsBytes',
    'deviationBytes',
    'artifactId',
  ];
  return (
    Object.keys(value).every(key => allowed.includes(key)) &&
    typeof value.itemId === 'string' &&
    isCanonicalUuid(value.itemId) &&
    (value.action === 'keep' || value.action === 'compressed') &&
    [
      value.predictedOutputBytes,
      value.actualOutputBytes,
      value.actualSavingsBytes,
    ].every(isNonNegativeSafeInteger) &&
    Number.isSafeInteger(value.deviationBytes) &&
    (value.artifactId === undefined ||
      (typeof value.artifactId === 'string' &&
        isCanonicalUuid(value.artifactId))) &&
    (value.action === 'compressed') === (value.artifactId !== undefined)
  );
}

function isPlanBudget(value: unknown): value is Budget {
  if (!isRecord(value)) return false;
  const allowed = [
    'preset',
    'maxOutputBytes',
    'minimumImageLongestEdge',
    'targetImageLongestEdge',
    'imageQuality',
    'estimatorVersion',
    'latestEstimate',
    'latestOptimization',
    'exclusions',
  ];
  return (
    Object.keys(value).every(key => allowed.includes(key)) &&
    isSupportedBudget(value as unknown as Budget) &&
    (value.latestEstimate === undefined ||
      isPackBudgetEstimateV1(value.latestEstimate)) &&
    (value.latestOptimization === undefined ||
      isBudgetOptimizationResultV1(value.latestOptimization)) &&
    (value.exclusions === undefined ||
      isBudgetItemExclusionArrayV1(value.exclusions))
  );
}

export function isBudgetItemExclusionV1(
  value: unknown,
): value is BudgetItemExclusionV1 {
  return (
    isRecord(value) &&
    exactKeys(value, ['itemId', 'baselineInclusionMode']) &&
    isCanonicalUuid(value.itemId) &&
    (value.baselineInclusionMode === 'original' ||
      value.baselineInclusionMode === 'extracted' ||
      value.baselineInclusionMode === 'both')
  );
}

export function isBudgetItemExclusionArrayV1(
  value: unknown,
): value is readonly BudgetItemExclusionV1[] {
  return (
    Array.isArray(value) &&
    value.every(isBudgetItemExclusionV1) &&
    value.every(
      (exclusion, index) =>
        index === 0 || value[index - 1]!.itemId < exclusion.itemId,
    )
  );
}

function isBudgetRecommendationV1(
  value: unknown,
): value is BudgetRecommendationV1 {
  return (
    value === 'lower-quality' ||
    value === 'ocr-only' ||
    value === 'split-pack' ||
    value === 'remove-items'
  );
}

function isImageOptimizationActionV1(
  value: unknown,
): value is ImageOptimizationActionV1 {
  if (!isRecord(value) || !isCanonicalUuid(value.itemId)) return false;
  if (value.kind === 'keep')
    return (
      exactKeys(value, [
        'kind',
        'itemId',
        'sourceByteCount',
        'predictedOutputBytes',
        'reason',
      ]) &&
      isPositiveSafeInteger(value.sourceByteCount) &&
      isPositiveSafeInteger(value.predictedOutputBytes) &&
      (value.reason === 'already-efficient' ||
        value.reason === 'transparent-not-smaller')
    );
  return (
    value.kind === 'compress' &&
    exactKeys(value, [
      'kind',
      'itemId',
      'outputArtifactId',
      'sourceByteCount',
      'sourceSha256',
      'sourceMediaType',
      'sourceWidth',
      'sourceHeight',
      'targetWidth',
      'targetHeight',
      'targetLongestEdge',
      'quality',
      'outputMediaType',
      'preserveAlpha',
      'predictedOutputBytes',
    ]) &&
    isCanonicalUuid(value.outputArtifactId) &&
    isPositiveSafeInteger(value.sourceByteCount) &&
    typeof value.sourceSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sourceSha256) &&
    typeof value.sourceMediaType === 'string' &&
    SUPPORTED_SOURCE_IMAGE_MEDIA_TYPES.has(value.sourceMediaType) &&
    [
      value.sourceWidth,
      value.sourceHeight,
      value.targetWidth,
      value.targetHeight,
      value.targetLongestEdge,
      value.predictedOutputBytes,
    ].every(isPositiveSafeInteger) &&
    typeof value.quality === 'number' &&
    Number.isFinite(value.quality) &&
    value.quality >= JPEG_MINIMUM_QUALITY &&
    value.quality <= 1 &&
    (value.outputMediaType === 'image/jpeg' ||
      value.outputMediaType === 'image/png') &&
    typeof value.preserveAlpha === 'boolean'
  );
}

function finiteCompressionCandidates(
  budget: Budget,
): readonly { readonly edge: number; readonly quality: number }[] {
  const edges: number[] = [];
  let edge = budget.targetImageLongestEdge;
  while (edge > budget.minimumImageLongestEdge) {
    edges.push(edge);
    edge = Math.max(
      budget.minimumImageLongestEdge,
      Math.floor((edge - 1) / 160) * 160,
    );
  }
  edges.push(budget.minimumImageLongestEdge);
  const qualities: number[] = [];
  let quality = budget.imageQuality;
  while (quality > JPEG_MINIMUM_QUALITY) {
    qualities.push(roundHundredths(quality));
    quality -= JPEG_QUALITY_STEP;
  }
  qualities.push(JPEG_MINIMUM_QUALITY);
  return edges.flatMap(candidateEdge =>
    qualities.map(candidateQuality => ({
      edge: candidateEdge,
      quality: candidateQuality,
    })),
  );
}

function isSupportedBudget(value: Budget): boolean {
  return (
    ['quality', 'balanced', 'compact', 'custom'].includes(value.preset) &&
    Number.isSafeInteger(value.maxOutputBytes) &&
    value.maxOutputBytes >= MEBIBYTE &&
    value.maxOutputBytes <= 100 * MEBIBYTE &&
    Number.isSafeInteger(value.minimumImageLongestEdge) &&
    value.minimumImageLongestEdge > 0 &&
    Number.isSafeInteger(value.targetImageLongestEdge) &&
    value.targetImageLongestEdge >= value.minimumImageLongestEdge &&
    value.targetImageLongestEdge <= MAXIMUM_BUDGET_IMAGE_LONGEST_EDGE &&
    Number.isFinite(value.imageQuality) &&
    value.imageQuality >= JPEG_MINIMUM_QUALITY &&
    value.imageQuality <= 1 &&
    value.estimatorVersion === CONTEXT_BUDGET_ESTIMATOR_VERSION &&
    (value.exclusions === undefined ||
      isBudgetItemExclusionArrayV1(value.exclusions))
  );
}

function predictImageOutputBytes(
  image: ImageCompressionInspectionV1,
  targetLongestEdge: number,
  quality: number,
): number {
  const dimensions = scaledDimensions(
    image.width,
    image.height,
    targetLongestEdge,
  );
  const pixels = dimensions.width * dimensions.height;
  const predicted = image.hasAlpha
    ? Math.ceil(256 + pixels * 1.85)
    : Math.ceil(640 + pixels * (0.08 + quality * 0.24));
  return Math.max(1, Math.min(image.sourceByteCount, predicted));
}

function scaledDimensions(
  width: number,
  height: number,
  longestEdge: number,
): { readonly width: number; readonly height: number } {
  const sourceLongestEdge = Math.max(width, height);
  if (sourceLongestEdge <= longestEdge) return { width, height };
  const scale = longestEdge / sourceLongestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function imageTokenEstimate(width: number, height: number): number {
  return 85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512);
}

function assertUniqueBudgetItems(items: readonly BudgetSourceItemV1[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (
      !isCanonicalUuid(item.itemId) ||
      ids.has(item.itemId) ||
      !['image', 'pdf', 'text', 'url'].includes(item.sourceType) ||
      typeof item.included !== 'boolean' ||
      typeof item.includeOriginal !== 'boolean' ||
      typeof item.includeExtracted !== 'boolean' ||
      item.included !== (item.includeOriginal || item.includeExtracted) ||
      ![
        item.sourceByteCount,
        item.textCharacterCount,
        item.textUtf8ByteCount,
        item.pdfPageCount,
      ].every(isNonNegativeSafeInteger) ||
      (item.sourceType !== 'image' && item.image !== undefined) ||
      (item.image !== undefined &&
        !isImageCompressionInspectionV1(item.image)) ||
      (item.image !== undefined &&
        item.sourceByteCount !== item.image.sourceByteCount) ||
      (item.sourceType !== 'pdf' && item.pdfPageCount !== 0)
    )
      throw new DomainError('SCHEMA_INVALID');
    ids.add(item.itemId);
  }
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('SCHEMA_INVALID');
  return value;
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key))
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSortedUniqueCanonicalIds(
  value: unknown,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      itemId => typeof itemId === 'string' && isCanonicalUuid(itemId),
    ) &&
    new Set(value).size === value.length &&
    value.every((itemId, index) => index === 0 || value[index - 1]! < itemId)
  );
}
