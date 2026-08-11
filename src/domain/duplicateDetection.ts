import { isCanonicalUuid } from './canonicalUuid';
import {
  decodeVersionedContract,
  type ContractDecodeResult,
} from './compatibility';
import { DomainError } from './errors';
import { isValidUnicodeScalarString, utf8ByteCount } from './mainAppImport';
import type { InclusionMode } from './models';

export const CONTENT_NORMALIZATION_SCHEMA_VERSION = 1 as const;
export const IMAGE_PERCEPTUAL_HASH_SCHEMA_VERSION = 1 as const;
export const DUPLICATE_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const TEXT_FINGERPRINT_SAMPLE_SIZE = 128 as const;

export const DUPLICATE_DETECTOR_CONFIG_V1 = {
  schemaVersion: 1,
  exactBinaryAlgorithm: 'sha256-v1',
  normalizationVersion: 'text-normalization-v1',
  textFingerprintAlgorithm: 'bottom-k-fnv1a32-5gram-v1',
  textSimilarityThreshold: 0.82,
  imageFingerprintAlgorithm: 'dhash-64-v1',
  imageHammingDistanceThreshold: 8,
  minimumTextCharacters: 20,
} as const;

export type NormalizedContentKindV1 = 'prose' | 'code' | 'mixed';

export type ContentNormalizationWarningV1 =
  | 'UNICODE_NORMALIZED'
  | 'LINE_ENDINGS_NORMALIZED'
  | 'OCR_ARTIFACT_REMOVED'
  | 'PROSE_WHITESPACE_NORMALIZED'
  | 'REPEATED_BLANK_LINES_COLLAPSED'
  | 'WRAPPED_WORD_REJOINED';

export interface NormalizedContentV1 {
  readonly schemaVersion: typeof CONTENT_NORMALIZATION_SCHEMA_VERSION;
  readonly normalizationVersion: 'text-normalization-v1';
  readonly contentKind: NormalizedContentKindV1;
  readonly text: string;
  readonly characterCount: number;
  readonly utf8ByteCount: number;
  readonly warnings: readonly ContentNormalizationWarningV1[];
}

export interface NormalizedTextFingerprintV1 {
  readonly schemaVersion: 1;
  readonly algorithm: 'bottom-k-fnv1a32-5gram-v1';
  readonly shingleSize: 5;
  readonly sampleSize: typeof TEXT_FINGERPRINT_SAMPLE_SIZE;
  readonly shingleCount: number;
  readonly hashes: readonly string[];
}

export interface ImagePerceptualHashV1 {
  readonly schemaVersion: typeof IMAGE_PERCEPTUAL_HASH_SCHEMA_VERSION;
  readonly algorithm: 'dhash-64-v1';
  readonly hash: string;
  readonly sampleWidth: 9;
  readonly sampleHeight: 8;
  readonly orientationApplied: true;
  readonly durationMs: number;
  readonly revision: '1';
}

export interface DuplicateAnalysisItemV1 {
  readonly schemaVersion: typeof DUPLICATE_ANALYSIS_SCHEMA_VERSION;
  readonly packId: string;
  readonly itemId: string;
  readonly originalSha256?: string;
  readonly originalByteCount: number;
  readonly normalizedArtifactId: string;
  readonly normalizedSha256: string;
  readonly normalizedByteCount: number;
  readonly normalizedCharacterCount: number;
  readonly contentKind: NormalizedContentKindV1;
  readonly textFingerprint: NormalizedTextFingerprintV1;
  readonly imageFingerprint?: ImagePerceptualHashV1;
  readonly analyzedAt: string;
}

export type DuplicateReasonV1 = 'exact-binary' | 'near-image' | 'similar-text';

export interface DuplicateSuggestionV1 {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly packId: string;
  readonly leftItemId: string;
  readonly rightItemId: string;
  readonly reason: DuplicateReasonV1;
  readonly confidence: number;
  readonly expectedBytesSaved: number;
  readonly expectedCharactersSaved: number;
}

export interface DuplicateSuggestionGroupV1 {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly itemIds: readonly string[];
  readonly suggestions: readonly DuplicateSuggestionV1[];
  readonly expectedBytesSaved: number;
  readonly expectedCharactersSaved: number;
}

export type DuplicateDecisionChoiceV1 = 'keep' | 'exclude' | 'preferred';

export interface DuplicateDecisionV1 {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly itemId: string;
  readonly choice: DuplicateDecisionChoiceV1;
  /** Restored by Keep/Preferred so duplicate review remains reversible. */
  readonly baselineInclusionMode: InclusionMode;
  readonly decidedAt: string;
}

export interface DuplicateAnalysisManifestV1 {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly config: typeof DUPLICATE_DETECTOR_CONFIG_V1;
  readonly analyzedAt: string;
  readonly itemCount: number;
  readonly suggestionCount: number;
}

export interface DuplicateAnalysisSnapshotV1 {
  readonly manifest: DuplicateAnalysisManifestV1 | null;
  readonly analyses: readonly DuplicateAnalysisItemV1[];
  readonly suggestions: readonly DuplicateSuggestionV1[];
  readonly decisions: readonly DuplicateDecisionV1[];
}

export interface DuplicateSavingsV1 {
  readonly bytes: number;
  readonly characters: number;
}

// These non-printing ranges are the exact normalization inputs under test.
/* eslint-disable no-control-regex */
const unsafeControl =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
/* eslint-enable no-control-regex */
const ocrArtifact = /[\u00AD\u200B-\u200D\u2060]/g;
const fenceLine = /^\s*(`{3,}|~{3,})/;
const safeSha256 = /^[0-9a-f]{64}$/;
const safeHash32 = /^[0-9a-f]{8}$/;
const safePerceptualHash = /^[0-9a-f]{16}$/;
const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function normalizeContentV1(source: string): NormalizedContentV1 {
  if (typeof source !== 'string' || !isValidUnicodeScalarString(source))
    throw new DomainError('SCHEMA_INVALID');
  const warnings = new Set<ContentNormalizationWarningV1>();
  let value = source;
  if (value.includes('\r')) {
    value = value.replace(/\r\n?/g, '\n');
    warnings.add('LINE_ENDINGS_NORMALIZED');
  }

  // Classification deliberately precedes Unicode/OCR prose cleanup. Code bytes
  // are semantic and v1 changes only their line-ending representation.
  const classificationValue = value.startsWith('\uFEFF')
    ? value.slice(1)
    : value;
  const lines = value.split('\n');
  const classificationLines = classificationValue.split('\n');
  const fenced = classificationLines.some(line => fenceLine.test(line));
  const codeSignals = classificationLines.filter(isCodeSignalLine).length;
  const meaningfulLines = classificationLines.filter(
    line => line.trim().length > 0,
  ).length;
  const codeLike =
    fenced ||
    (codeSignals > 0 && codeSignals / Math.max(meaningfulLines, 1) >= 0.34);
  const contentKind: NormalizedContentKindV1 = fenced
    ? hasProseOutsideFences(classificationLines)
      ? 'mixed'
      : 'code'
    : codeLike
    ? 'code'
    : 'prose';

  const normalized =
    contentKind === 'code'
      ? value
      : fenced
      ? normalizeMixedFencedContent(lines, warnings)
      : normalizeProseLines(lines, warnings);
  return {
    schemaVersion: CONTENT_NORMALIZATION_SCHEMA_VERSION,
    normalizationVersion: 'text-normalization-v1',
    contentKind,
    text: normalized,
    characterCount: normalized.length,
    utf8ByteCount: utf8ByteCount(normalized),
    warnings: [...warnings].sort(),
  };
}

export function fingerprintNormalizedTextV1(
  normalized: NormalizedContentV1,
): NormalizedTextFingerprintV1 {
  if (!isNormalizedContentV1(normalized))
    throw new DomainError('SCHEMA_INVALID');
  const similaritySource =
    normalized.contentKind === 'prose'
      ? normalized.text.toLowerCase().replace(/\s+/g, ' ').trim()
      : normalized.text;
  const codePoints = Array.from(similaritySource);
  const shingleSize = 5;
  const shingleCount =
    codePoints.length === 0
      ? 0
      : Math.max(1, codePoints.length - shingleSize + 1);
  const sample: number[] = [];
  const sampled = new Set<number>();
  for (let index = 0; index < shingleCount; index += 1) {
    const shingle = codePoints
      .slice(index, Math.min(index + shingleSize, codePoints.length))
      .join('');
    const hash = fnv1a32(shingle);
    if (sampled.has(hash)) continue;
    if (
      sample.length === TEXT_FINGERPRINT_SAMPLE_SIZE &&
      hash >= sample[sample.length - 1]!
    )
      continue;
    const position = lowerBound(sample, hash);
    sample.splice(position, 0, hash);
    sampled.add(hash);
    if (sample.length > TEXT_FINGERPRINT_SAMPLE_SIZE) {
      const removed = sample.pop();
      if (removed !== undefined) sampled.delete(removed);
    }
  }
  return {
    schemaVersion: 1,
    algorithm: 'bottom-k-fnv1a32-5gram-v1',
    shingleSize: 5,
    sampleSize: TEXT_FINGERPRINT_SAMPLE_SIZE,
    shingleCount,
    hashes: sample.map(hash => hash.toString(16).padStart(8, '0')),
  };
}

export function normalizedTextSimilarityV1(
  left: NormalizedTextFingerprintV1,
  right: NormalizedTextFingerprintV1,
): number {
  if (
    !isNormalizedTextFingerprintV1(left) ||
    !isNormalizedTextFingerprintV1(right)
  )
    throw new DomainError('SCHEMA_INVALID');
  if (left.hashes.length === 0 || right.hashes.length === 0) return 0;
  const rightHashes = new Set(right.hashes);
  const intersection = left.hashes.filter(hash => rightHashes.has(hash)).length;
  const union = new Set([...left.hashes, ...right.hashes]).size;
  return union === 0 ? 0 : roundConfidence(intersection / union);
}

export function imageHashDistanceV1(
  left: ImagePerceptualHashV1,
  right: ImagePerceptualHashV1,
): number {
  if (!isImagePerceptualHashV1(left) || !isImagePerceptualHashV1(right))
    throw new DomainError('SCHEMA_INVALID');
  let distance = 0;
  /* eslint-disable no-bitwise -- nibble XOR/popcount is the versioned dHash distance contract. */
  for (let index = 0; index < left.hash.length; index += 1) {
    let value =
      Number.parseInt(left.hash[index]!, 16) ^
      Number.parseInt(right.hash[index]!, 16);
    while (value > 0) {
      distance += value & 1;
      value >>>= 1;
    }
  }
  /* eslint-enable no-bitwise */
  return distance;
}

export function buildDuplicateSuggestionsV1(
  analyses: readonly DuplicateAnalysisItemV1[],
): readonly DuplicateSuggestionV1[] {
  if (!Array.isArray(analyses) || !analyses.every(isDuplicateAnalysisItemV1))
    throw new DomainError('SCHEMA_INVALID');
  const ordered = [...analyses].sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
  if (new Set(ordered.map(value => value.itemId)).size !== ordered.length)
    throw new DomainError('SCHEMA_INVALID');
  const suggestions: DuplicateSuggestionV1[] = [];
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < ordered.length;
      rightIndex += 1
    ) {
      const left = ordered[leftIndex]!;
      const right = ordered[rightIndex]!;
      if (left.packId !== right.packId) throw new DomainError('SCHEMA_INVALID');
      const candidate = duplicateCandidate(left, right);
      if (candidate) suggestions.push(candidate);
    }
  }
  return suggestions;
}

export function groupDuplicateSuggestionsV1(
  suggestions: readonly DuplicateSuggestionV1[],
): readonly DuplicateSuggestionGroupV1[] {
  if (
    !Array.isArray(suggestions) ||
    !suggestions.every(isDuplicateSuggestionV1)
  )
    throw new DomainError('SCHEMA_INVALID');
  const adjacency = new Map<string, Set<string>>();
  for (const suggestion of suggestions) {
    const left = adjacency.get(suggestion.leftItemId) ?? new Set<string>();
    const right = adjacency.get(suggestion.rightItemId) ?? new Set<string>();
    left.add(suggestion.rightItemId);
    right.add(suggestion.leftItemId);
    adjacency.set(suggestion.leftItemId, left);
    adjacency.set(suggestion.rightItemId, right);
  }
  const visited = new Set<string>();
  const groups: DuplicateSuggestionGroupV1[] = [];
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const pending = [start];
    const itemIds: string[] = [];
    while (pending.length > 0) {
      const itemId = pending.pop()!;
      if (visited.has(itemId)) continue;
      visited.add(itemId);
      itemIds.push(itemId);
      for (const neighbor of adjacency.get(itemId) ?? [])
        pending.push(neighbor);
    }
    itemIds.sort();
    const members = suggestions.filter(
      value =>
        itemIds.includes(value.leftItemId) &&
        itemIds.includes(value.rightItemId),
    );
    groups.push({
      schemaVersion: 1,
      key: itemIds.join(':'),
      itemIds,
      suggestions: members,
      expectedBytesSaved: maximumSpanningTreeSavings(
        itemIds,
        members,
        value => value.expectedBytesSaved,
      ),
      expectedCharactersSaved: maximumSpanningTreeSavings(
        itemIds,
        members,
        value => value.expectedCharactersSaved,
      ),
    });
  }
  return groups;
}

function maximumSpanningTreeSavings(
  itemIds: readonly string[],
  suggestions: readonly DuplicateSuggestionV1[],
  weight: (suggestion: DuplicateSuggestionV1) => number,
): number {
  if (itemIds.length < 2) return 0;
  const visited = new Set([itemIds[0]!]);
  let total = 0;
  while (visited.size < itemIds.length) {
    const candidate = suggestions
      .filter(suggestion => {
        const leftVisited = visited.has(suggestion.leftItemId);
        const rightVisited = visited.has(suggestion.rightItemId);
        return leftVisited !== rightVisited;
      })
      .sort((left, right) => {
        const byWeight = weight(right) - weight(left);
        return byWeight !== 0 ? byWeight : left.key.localeCompare(right.key);
      })[0];
    if (!candidate) throw new DomainError('SCHEMA_INVALID');
    total += weight(candidate);
    visited.add(
      visited.has(candidate.leftItemId)
        ? candidate.rightItemId
        : candidate.leftItemId,
    );
  }
  return total;
}

export function calculateDuplicateSavingsV1(
  analyses: readonly DuplicateAnalysisItemV1[],
  decisions: readonly DuplicateDecisionV1[],
): DuplicateSavingsV1 {
  if (
    !analyses.every(isDuplicateAnalysisItemV1) ||
    !decisions.every(isDuplicateDecisionV1)
  )
    throw new DomainError('SCHEMA_INVALID');
  const byItem = new Map(analyses.map(value => [value.itemId, value]));
  let bytes = 0;
  let characters = 0;
  for (const decision of decisions) {
    if (decision.choice !== 'exclude') continue;
    const analysis = byItem.get(decision.itemId);
    if (!analysis) continue;
    if (
      decision.baselineInclusionMode === 'original' ||
      decision.baselineInclusionMode === 'both'
    )
      bytes += analysis.originalByteCount;
    if (
      decision.baselineInclusionMode === 'extracted' ||
      decision.baselineInclusionMode === 'both'
    ) {
      bytes += analysis.normalizedByteCount;
      characters += analysis.normalizedCharacterCount;
    }
  }
  return { bytes, characters };
}

export function isNormalizedContentV1(
  value: unknown,
): value is NormalizedContentV1 {
  if (!isRecord(value)) return false;
  const warnings = value.warnings;
  return (
    exactKeys(value, [
      'schemaVersion',
      'normalizationVersion',
      'contentKind',
      'text',
      'characterCount',
      'utf8ByteCount',
      'warnings',
    ]) &&
    value.schemaVersion === 1 &&
    value.normalizationVersion === 'text-normalization-v1' &&
    (value.contentKind === 'prose' ||
      value.contentKind === 'code' ||
      value.contentKind === 'mixed') &&
    typeof value.text === 'string' &&
    isValidUnicodeScalarString(value.text) &&
    value.characterCount === value.text.length &&
    value.utf8ByteCount === utf8ByteCount(value.text) &&
    Array.isArray(warnings) &&
    warnings.every(isNormalizationWarning) &&
    new Set(warnings).size === warnings.length
  );
}

export function isNormalizedTextFingerprintV1(
  value: unknown,
): value is NormalizedTextFingerprintV1 {
  if (!isRecord(value)) return false;
  const hashes = value.hashes;
  return (
    exactKeys(value, [
      'schemaVersion',
      'algorithm',
      'shingleSize',
      'sampleSize',
      'shingleCount',
      'hashes',
    ]) &&
    value.schemaVersion === 1 &&
    value.algorithm === 'bottom-k-fnv1a32-5gram-v1' &&
    value.shingleSize === 5 &&
    value.sampleSize === TEXT_FINGERPRINT_SAMPLE_SIZE &&
    isNonNegativeInteger(value.shingleCount) &&
    Array.isArray(hashes) &&
    hashes.length <= TEXT_FINGERPRINT_SAMPLE_SIZE &&
    ((value.shingleCount === 0 && hashes.length === 0) ||
      ((value.shingleCount as number) > 0 && hashes.length > 0)) &&
    hashes.every(hash => typeof hash === 'string' && safeHash32.test(hash)) &&
    new Set(hashes).size === hashes.length &&
    hashes.every((hash, index) => index === 0 || hashes[index - 1]! < hash)
  );
}

export function isImagePerceptualHashV1(
  value: unknown,
): value is ImagePerceptualHashV1 {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'schemaVersion',
      'algorithm',
      'hash',
      'sampleWidth',
      'sampleHeight',
      'orientationApplied',
      'durationMs',
      'revision',
    ]) &&
    value.schemaVersion === 1 &&
    value.algorithm === 'dhash-64-v1' &&
    typeof value.hash === 'string' &&
    safePerceptualHash.test(value.hash) &&
    value.sampleWidth === 9 &&
    value.sampleHeight === 8 &&
    value.orientationApplied === true &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    value.revision === '1'
  );
}

export function decodeImagePerceptualHashV1(
  value: unknown,
): ContractDecodeResult<ImagePerceptualHashV1> {
  return decodeVersionedContract(
    'imagePerceptualHash',
    value,
    isImagePerceptualHashV1,
  );
}

export function isDuplicateAnalysisItemV1(
  value: unknown,
): value is DuplicateAnalysisItemV1 {
  if (!isRecord(value)) return false;
  const allowed = [
    'schemaVersion',
    'packId',
    'itemId',
    'originalSha256',
    'originalByteCount',
    'normalizedArtifactId',
    'normalizedSha256',
    'normalizedByteCount',
    'normalizedCharacterCount',
    'contentKind',
    'textFingerprint',
    'imageFingerprint',
    'analyzedAt',
  ];
  return (
    Object.keys(value).every(key => allowed.includes(key)) &&
    value.schemaVersion === 1 &&
    typeof value.packId === 'string' &&
    isCanonicalUuid(value.packId) &&
    typeof value.itemId === 'string' &&
    isCanonicalUuid(value.itemId) &&
    (value.originalSha256 === undefined ||
      (typeof value.originalSha256 === 'string' &&
        safeSha256.test(value.originalSha256))) &&
    isNonNegativeInteger(value.originalByteCount) &&
    typeof value.normalizedArtifactId === 'string' &&
    isCanonicalUuid(value.normalizedArtifactId) &&
    typeof value.normalizedSha256 === 'string' &&
    safeSha256.test(value.normalizedSha256) &&
    isNonNegativeInteger(value.normalizedByteCount) &&
    isNonNegativeInteger(value.normalizedCharacterCount) &&
    (value.contentKind === 'prose' ||
      value.contentKind === 'code' ||
      value.contentKind === 'mixed') &&
    isNormalizedTextFingerprintV1(value.textFingerprint) &&
    (value.imageFingerprint === undefined ||
      isImagePerceptualHashV1(value.imageFingerprint)) &&
    typeof value.analyzedAt === 'string' &&
    isIsoDateTime(value.analyzedAt)
  );
}

export function isDuplicateSuggestionV1(
  value: unknown,
): value is DuplicateSuggestionV1 {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'schemaVersion',
      'key',
      'packId',
      'leftItemId',
      'rightItemId',
      'reason',
      'confidence',
      'expectedBytesSaved',
      'expectedCharactersSaved',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.key === 'string' &&
    /^[a-z-]+:[0-9a-f-]+:[0-9a-f-]+$/.test(value.key) &&
    typeof value.packId === 'string' &&
    isCanonicalUuid(value.packId) &&
    typeof value.leftItemId === 'string' &&
    isCanonicalUuid(value.leftItemId) &&
    typeof value.rightItemId === 'string' &&
    isCanonicalUuid(value.rightItemId) &&
    value.leftItemId < value.rightItemId &&
    (value.reason === 'exact-binary' ||
      value.reason === 'near-image' ||
      value.reason === 'similar-text') &&
    value.key === `${value.reason}:${value.leftItemId}:${value.rightItemId}` &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    isNonNegativeInteger(value.expectedBytesSaved) &&
    isNonNegativeInteger(value.expectedCharactersSaved)
  );
}

export function isDuplicateAnalysisManifestV1(
  value: unknown,
): value is DuplicateAnalysisManifestV1 {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'schemaVersion',
      'packId',
      'config',
      'analyzedAt',
      'itemCount',
      'suggestionCount',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.packId === 'string' &&
    isCanonicalUuid(value.packId) &&
    isDuplicateDetectorConfigV1(value.config) &&
    typeof value.analyzedAt === 'string' &&
    isIsoDateTime(value.analyzedAt) &&
    isNonNegativeInteger(value.itemCount) &&
    isNonNegativeInteger(value.suggestionCount)
  );
}

export function isDuplicateDecisionV1(
  value: unknown,
): value is DuplicateDecisionV1 {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'schemaVersion',
      'packId',
      'itemId',
      'choice',
      'baselineInclusionMode',
      'decidedAt',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.packId === 'string' &&
    isCanonicalUuid(value.packId) &&
    typeof value.itemId === 'string' &&
    isCanonicalUuid(value.itemId) &&
    (value.choice === 'keep' ||
      value.choice === 'exclude' ||
      value.choice === 'preferred') &&
    isInclusionMode(value.baselineInclusionMode) &&
    typeof value.decidedAt === 'string' &&
    isIsoDateTime(value.decidedAt)
  );
}

function duplicateCandidate(
  left: DuplicateAnalysisItemV1,
  right: DuplicateAnalysisItemV1,
): DuplicateSuggestionV1 | undefined {
  let reason: DuplicateReasonV1 | undefined;
  let confidence = 0;
  let expectedBytesSaved = 0;
  let expectedCharactersSaved = 0;
  if (
    left.originalSha256 !== undefined &&
    left.originalSha256 === right.originalSha256
  ) {
    reason = 'exact-binary';
    confidence = 1;
    expectedBytesSaved = Math.min(
      left.originalByteCount,
      right.originalByteCount,
    );
  } else if (left.imageFingerprint && right.imageFingerprint) {
    const distance = imageHashDistanceV1(
      left.imageFingerprint,
      right.imageFingerprint,
    );
    if (
      distance <= DUPLICATE_DETECTOR_CONFIG_V1.imageHammingDistanceThreshold
    ) {
      reason = 'near-image';
      confidence = roundConfidence(1 - distance / 64);
      expectedBytesSaved = Math.min(
        left.originalByteCount,
        right.originalByteCount,
      );
    }
  }
  if (
    reason === undefined &&
    Math.min(left.normalizedCharacterCount, right.normalizedCharacterCount) >=
      DUPLICATE_DETECTOR_CONFIG_V1.minimumTextCharacters
  ) {
    const similarity = normalizedTextSimilarityV1(
      left.textFingerprint,
      right.textFingerprint,
    );
    if (similarity >= DUPLICATE_DETECTOR_CONFIG_V1.textSimilarityThreshold) {
      reason = 'similar-text';
      confidence = similarity;
      expectedBytesSaved = Math.min(
        left.normalizedByteCount,
        right.normalizedByteCount,
      );
      expectedCharactersSaved = Math.min(
        left.normalizedCharacterCount,
        right.normalizedCharacterCount,
      );
    }
  }
  if (!reason) return undefined;
  return {
    schemaVersion: 1,
    key: `${reason}:${left.itemId}:${right.itemId}`,
    packId: left.packId,
    leftItemId: left.itemId,
    rightItemId: right.itemId,
    reason,
    confidence,
    expectedBytesSaved,
    expectedCharactersSaved,
  };
}

function normalizeMixedFencedContent(
  lines: readonly string[],
  warnings: Set<ContentNormalizationWarningV1>,
): string {
  const output: string[] = [];
  let prose: string[] = [];
  let fence:
    | { readonly character: string; readonly length: number }
    | undefined;
  const flushProse = (): void => {
    if (prose.length === 0) return;
    output.push(normalizeProseLines(prose, warnings));
    prose = [];
  };
  for (const line of lines) {
    const marker = line.match(fenceLine)?.[1];
    if (!fence && marker) {
      flushProse();
      fence = { character: marker[0]!, length: marker.length };
      output.push(line);
      continue;
    }
    if (fence && isClosingFenceLine(line, fence)) {
      output.push(line);
      fence = undefined;
      continue;
    }
    if (fence) output.push(line);
    else prose.push(line);
  }
  flushProse();
  return output.join('\n');
}

function hasProseOutsideFences(lines: readonly string[]): boolean {
  let fence:
    | { readonly character: string; readonly length: number }
    | undefined;
  for (const line of lines) {
    const marker = line.match(fenceLine)?.[1];
    if (!fence && marker) {
      fence = { character: marker[0]!, length: marker.length };
      continue;
    }
    if (fence && isClosingFenceLine(line, fence)) {
      fence = undefined;
      continue;
    }
    if (!fence && line.trim().length > 0) return true;
  }
  return false;
}

function isClosingFenceLine(
  line: string,
  fence: { readonly character: string; readonly length: number },
): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length &&
    [...trimmed].every(character => character === fence.character)
  );
}

function normalizeProseLines(
  lines: readonly string[],
  warnings: Set<ContentNormalizationWarningV1>,
): string {
  const normalized = lines.map((line, index) => {
    let prepared = line;
    if (index === 0 && prepared.startsWith('\uFEFF')) {
      prepared = prepared.slice(1);
      warnings.add('OCR_ARTIFACT_REMOVED');
    }
    const safe = prepared.replace(unsafeControl, '\uFFFD');
    if (safe !== prepared) warnings.add('OCR_ARTIFACT_REMOVED');
    const compatibility = safe.normalize('NFKC');
    if (compatibility !== safe) warnings.add('UNICODE_NORMALIZED');
    const artifactsRemoved = compatibility
      .replace(ocrArtifact, '')
      .replace(/\u00A0/g, ' ');
    if (artifactsRemoved !== compatibility)
      warnings.add('OCR_ARTIFACT_REMOVED');
    const compact = artifactsRemoved.replace(/[\t ]+/g, ' ').trim();
    if (compact !== artifactsRemoved)
      warnings.add('PROSE_WHITESPACE_NORMALIZED');
    return compact;
  });
  const rejoined: string[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const line = normalized[index]!;
    const next = normalized[index + 1];
    if (line.endsWith('-') && next && /^\p{Ll}/u.test(next)) {
      rejoined.push(`${line.slice(0, -1)}${next}`);
      warnings.add('WRAPPED_WORD_REJOINED');
      index += 1;
    } else rejoined.push(line);
  }
  return collapseBlankLines(rejoined.join('\n'), warnings);
}

function collapseBlankLines(
  value: string,
  warnings: Set<ContentNormalizationWarningV1>,
): string {
  const collapsed = value.replace(/\n{3,}/g, '\n\n');
  if (collapsed !== value) warnings.add('REPEATED_BLANK_LINES_COLLAPSED');
  return collapsed;
}

function isCodeSignalLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return (
    fenceLine.test(line) ||
    /^\s+(?:\S|$)/.test(line) ||
    /(?:=>|::|\{\s*$|[;{}]\s*$|^\s*(?:const|let|var|func|class|interface|type|import|export|def|fun|if|for|while)\b)/.test(
      line,
    )
  );
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  /* eslint-disable no-bitwise -- FNV-1a v1 requires unsigned 32-bit arithmetic. */
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const unsigned = hash >>> 0;
  /* eslint-enable no-bitwise */
  return unsigned;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isNormalizationWarning(
  value: unknown,
): value is ContentNormalizationWarningV1 {
  return (
    value === 'UNICODE_NORMALIZED' ||
    value === 'LINE_ENDINGS_NORMALIZED' ||
    value === 'OCR_ARTIFACT_REMOVED' ||
    value === 'PROSE_WHITESPACE_NORMALIZED' ||
    value === 'REPEATED_BLANK_LINES_COLLAPSED' ||
    value === 'WRAPPED_WORD_REJOINED'
  );
}

function isDuplicateDetectorConfigV1(
  value: unknown,
): value is typeof DUPLICATE_DETECTOR_CONFIG_V1 {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'schemaVersion',
      'exactBinaryAlgorithm',
      'normalizationVersion',
      'textFingerprintAlgorithm',
      'textSimilarityThreshold',
      'imageFingerprintAlgorithm',
      'imageHammingDistanceThreshold',
      'minimumTextCharacters',
    ]) &&
    value.schemaVersion === DUPLICATE_DETECTOR_CONFIG_V1.schemaVersion &&
    value.exactBinaryAlgorithm ===
      DUPLICATE_DETECTOR_CONFIG_V1.exactBinaryAlgorithm &&
    value.normalizationVersion ===
      DUPLICATE_DETECTOR_CONFIG_V1.normalizationVersion &&
    value.textFingerprintAlgorithm ===
      DUPLICATE_DETECTOR_CONFIG_V1.textFingerprintAlgorithm &&
    value.textSimilarityThreshold ===
      DUPLICATE_DETECTOR_CONFIG_V1.textSimilarityThreshold &&
    value.imageFingerprintAlgorithm ===
      DUPLICATE_DETECTOR_CONFIG_V1.imageFingerprintAlgorithm &&
    value.imageHammingDistanceThreshold ===
      DUPLICATE_DETECTOR_CONFIG_V1.imageHammingDistanceThreshold &&
    value.minimumTextCharacters ===
      DUPLICATE_DETECTOR_CONFIG_V1.minimumTextCharacters
  );
}

function isInclusionMode(value: unknown): value is InclusionMode {
  return (
    value === 'original' ||
    value === 'extracted' ||
    value === 'both' ||
    value === 'excluded'
  );
}

function isIsoDateTime(value: string): boolean {
  return isoDateTime.test(value) && Number.isFinite(Date.parse(value));
}

function roundConfidence(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && keys.every(key => expected.includes(key))
  );
}
