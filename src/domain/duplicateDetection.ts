import { isCanonicalUuid } from './canonicalUuid';
import {
  decodeVersionedContract,
  type ContractDecodeResult,
} from './compatibility';
import { DERIVED_TEXT_MAXIMUM_UTF8_BYTES } from './contracts';
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
  /** Exact code-point count after v1 similarity folding. */
  readonly similarityCharacterCount: number;
  readonly shingleCount: number;
  readonly hashes: readonly string[];
}

export interface TextFingerprintWorkOptionsV1 {
  /** Checked before work, after every host yield, and before publication. */
  readonly isCancelled?: () => boolean;
  /** Injectable for deterministic tests; production yields to the host timer queue. */
  readonly yieldControl?: () => Promise<void>;
  readonly yieldEveryCodePoints?: number;
}

export interface ContentNormalizationWorkOptionsV1 {
  /** Checked before work, after every host yield, and before publication. */
  readonly isCancelled?: () => boolean;
  /** Injectable for deterministic tests; production yields to the host timer queue. */
  readonly yieldControl?: () => Promise<void>;
  readonly yieldEveryCodeUnits?: number;
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
  /** Preferred-group exclusions are reconciled together; standalone choices survive. */
  readonly source?: 'standalone' | 'preferred-group';
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
// ZWJ/ZWNJ are semantic in emoji and joining scripts. Only remove the
// explicitly non-semantic OCR artifacts in this versioned contract.
const ocrArtifact = /[\u00AD\u200B\u2060]/g;
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

  const normalizedCandidate =
    contentKind === 'code'
      ? value
      : fenced
      ? normalizeMixedFencedContent(lines, warnings)
      : normalizeProseLines(lines, warnings);
  const normalized =
    contentKind === 'prose' && !lineHasNonWhitespace(normalizedCandidate)
      ? ''
      : normalizedCandidate;
  const normalizedUtf8ByteCount = utf8ByteCount(normalized);
  if (normalizedUtf8ByteCount > DERIVED_TEXT_MAXIMUM_UTF8_BYTES)
    throw new DomainError('RESOURCE_MEMORY_PRESSURE');
  return {
    schemaVersion: CONTENT_NORMALIZATION_SCHEMA_VERSION,
    normalizationVersion: 'text-normalization-v1',
    contentKind,
    text: normalized,
    characterCount: normalized.length,
    utf8ByteCount: normalizedUtf8ByteCount,
    warnings: [...warnings].sort(),
  };
}

/**
 * Produces the v1 normalization contract without retaining line arrays. The
 * source and final normalized string are the only size-proportional values;
 * classification and prose folding retain at most one bounded line/chunk and
 * yield cooperatively between chunks.
 */
export async function normalizeContentAsyncV1(
  source: string,
  options: ContentNormalizationWorkOptionsV1 = {},
): Promise<NormalizedContentV1> {
  if (typeof source !== 'string') throw new DomainError('SCHEMA_INVALID');
  const work = new CooperativeTextWorkController(options);
  const hasCarriageReturn = await assertValidUnicodeScalarStringAsync(
    source,
    work,
  );
  const warnings = new Set<ContentNormalizationWarningV1>();
  if (hasCarriageReturn) warnings.add('LINE_ENDINGS_NORMALIZED');

  let fenced = false;
  let fence:
    | { readonly character: string; readonly length: number }
    | undefined;
  let proseOutsideFences = false;
  let codeSignals = 0;
  let meaningfulLines = 0;
  let lineIndex = 0;
  for await (const scanned of canonicalSourceLinesAsync(source, work)) {
    const line = scanned.value;
    const classifiedLine =
      lineIndex === 0 && line.startsWith('\uFEFF') ? line.slice(1) : line;
    const meaningful = scanned.hasNonWhitespace;
    const marker = await fenceDescriptorForLineBounded(classifiedLine, work);
    if (!fence && marker) {
      fenced = true;
      fence = marker;
    } else if (
      fence &&
      (await isClosingFenceLineBounded(classifiedLine, fence, work))
    ) {
      fence = undefined;
    } else if (!fence && meaningful) {
      proseOutsideFences = true;
    }
    if (meaningful) meaningfulLines += 1;
    if (await isCodeSignalLineBounded(classifiedLine, work)) codeSignals += 1;
    lineIndex += 1;
  }
  const codeLike =
    fenced ||
    (codeSignals > 0 && codeSignals / Math.max(meaningfulLines, 1) >= 0.34);
  const contentKind: NormalizedContentKindV1 = fenced
    ? proseOutsideFences
      ? 'mixed'
      : 'code'
    : codeLike
    ? 'code'
    : 'prose';

  const writer = new IncrementalLineWriter(
    warnings,
    work,
    DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
  );
  if (contentKind === 'code') {
    for await (const line of canonicalSourceLinesAsync(source, work))
      await writer.writeLine(line.value, false);
  } else if (contentKind === 'prose') {
    const prose = new IncrementalProseNormalizer(writer, warnings, work);
    let sourceLineIndex = 0;
    for await (const line of canonicalSourceLinesAsync(source, work)) {
      await prose.push(line.value, sourceLineIndex === 0);
      sourceLineIndex += 1;
    }
    await prose.flush();
  } else {
    let activeFence:
      | { readonly character: string; readonly length: number }
      | undefined;
    let prose = new IncrementalProseNormalizer(writer, warnings, work);
    let proseLineIndex = 0;
    for await (const scanned of canonicalSourceLinesAsync(source, work)) {
      const line = scanned.value;
      const marker = await fenceDescriptorForLineBounded(line, work);
      if (!activeFence && marker) {
        await prose.flush();
        activeFence = marker;
        await writer.writeLine(line, false);
      } else if (
        activeFence &&
        (await isClosingFenceLineBounded(line, activeFence, work))
      ) {
        await writer.writeLine(line, false);
        activeFence = undefined;
        prose = new IncrementalProseNormalizer(writer, warnings, work);
        proseLineIndex = 0;
      } else if (activeFence) await writer.writeLine(line, false);
      else {
        await prose.push(line, proseLineIndex === 0);
        proseLineIndex += 1;
      }
    }
    await prose.flush();
  }
  work.assertActive();
  const built = writer.finish();
  const normalized =
    contentKind === 'prose' && !lineHasNonWhitespace(built) ? '' : built;
  work.assertActive();
  return {
    schemaVersion: CONTENT_NORMALIZATION_SCHEMA_VERSION,
    normalizationVersion: 'text-normalization-v1',
    contentKind,
    text: normalized,
    characterCount: normalized.length,
    utf8ByteCount: await utf8ByteCountAsync(normalized, work),
    warnings: [...warnings].sort(),
  };
}

export function fingerprintNormalizedTextV1(
  normalized: NormalizedContentV1,
): NormalizedTextFingerprintV1 {
  if (!isNormalizedContentV1(normalized))
    throw new DomainError('SCHEMA_INVALID');
  const accumulator = new TextFingerprintAccumulatorV1();
  for (const codePoint of similarityCodePoints(normalized))
    accumulator.append(codePoint);
  return accumulator.finish();
}

/**
 * Computes the same v1 contract without materializing a code-point array or a
 * shingle per input position. Long inputs yield cooperatively so UI events and
 * durable cancellation can run between bounded chunks.
 */
export async function fingerprintNormalizedTextAsyncV1(
  normalized: NormalizedContentV1,
  options: TextFingerprintWorkOptionsV1 = {},
): Promise<NormalizedTextFingerprintV1> {
  const yieldEvery = options.yieldEveryCodePoints ?? 32_768;
  if (!Number.isSafeInteger(yieldEvery) || yieldEvery <= 0)
    throw new DomainError('SCHEMA_INVALID');
  const validated = await validateNormalizedContentForFingerprintAsyncV1(
    normalized,
    options,
    yieldEvery,
  );
  assertFingerprintWorkActive(options);
  const accumulator = new TextFingerprintAccumulatorV1();
  let visited = 0;
  for await (const codePoint of similarityCodePointsAsync(
    validated,
    options,
    yieldEvery,
  )) {
    accumulator.append(codePoint);
    visited += 1;
    if (visited % yieldEvery !== 0) continue;
    await (options.yieldControl ?? yieldTextFingerprintWorkToHost)();
    assertFingerprintWorkActive(options);
  }
  assertFingerprintWorkActive(options);
  return accumulator.finish();
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
  if (!isNormalizedContentShapeV1(value)) return false;
  return (
    isValidUnicodeScalarString(value.text) &&
    value.utf8ByteCount === utf8ByteCount(value.text)
  );
}

function isNormalizedContentShapeV1(
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
    value.characterCount === value.text.length &&
    isNonNegativeInteger(value.utf8ByteCount) &&
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
      'similarityCharacterCount',
      'shingleCount',
      'hashes',
    ]) &&
    value.schemaVersion === 1 &&
    value.algorithm === 'bottom-k-fnv1a32-5gram-v1' &&
    value.shingleSize === 5 &&
    value.sampleSize === TEXT_FINGERPRINT_SAMPLE_SIZE &&
    isNonNegativeInteger(value.similarityCharacterCount) &&
    isNonNegativeInteger(value.shingleCount) &&
    value.shingleCount ===
      (value.similarityCharacterCount === 0
        ? 0
        : Math.max(1, value.similarityCharacterCount - 4)) &&
    Array.isArray(hashes) &&
    hashes.length <=
      Math.min(TEXT_FINGERPRINT_SAMPLE_SIZE, value.shingleCount) &&
    ((value.shingleCount === 0 && hashes.length === 0) ||
      (value.shingleCount > 0 && hashes.length > 0)) &&
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
    duplicateAnalysisCountsAreConsistent(
      value.normalizedByteCount,
      value.normalizedCharacterCount,
      value.textFingerprint,
    ) &&
    (value.imageFingerprint === undefined ||
      isImagePerceptualHashV1(value.imageFingerprint)) &&
    typeof value.analyzedAt === 'string' &&
    isIsoDateTime(value.analyzedAt)
  );
}

function duplicateAnalysisCountsAreConsistent(
  normalizedByteCount: unknown,
  normalizedCharacterCount: unknown,
  fingerprint: unknown,
): boolean {
  if (
    !isNonNegativeInteger(normalizedByteCount) ||
    !isNonNegativeInteger(normalizedCharacterCount) ||
    !isNormalizedTextFingerprintV1(fingerprint)
  )
    return false;
  if (normalizedCharacterCount === 0)
    return (
      normalizedByteCount === 0 &&
      fingerprint.similarityCharacterCount === 0 &&
      fingerprint.shingleCount === 0
    );
  return (
    normalizedByteCount >= normalizedCharacterCount &&
    fingerprint.similarityCharacterCount >= 1 &&
    fingerprint.similarityCharacterCount <= normalizedByteCount
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
  const decisionKeys = [
    'schemaVersion',
    'packId',
    'itemId',
    'choice',
    'baselineInclusionMode',
    ...(value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'source' in value
      ? ['source']
      : []),
    'decidedAt',
  ];
  return (
    isRecord(value) &&
    exactKeys(value, decisionKeys) &&
    value.schemaVersion === 1 &&
    typeof value.packId === 'string' &&
    isCanonicalUuid(value.packId) &&
    typeof value.itemId === 'string' &&
    isCanonicalUuid(value.itemId) &&
    (value.choice === 'keep' ||
      value.choice === 'exclude' ||
      value.choice === 'preferred') &&
    isInclusionMode(value.baselineInclusionMode) &&
    (value.source === undefined ||
      value.source === 'standalone' ||
      value.source === 'preferred-group') &&
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
  const output = new ChunkedStringBuilder();
  let hasOutput = false;
  let prose: string[] = [];
  let fence:
    | { readonly character: string; readonly length: number }
    | undefined;
  const appendOutput = (value: string): void => {
    if (hasOutput) output.append('\n');
    output.append(value);
    hasOutput = true;
  };
  const flushProse = (): void => {
    if (prose.length === 0) return;
    appendOutput(normalizeProseLines(prose, warnings));
    prose = [];
  };
  for (const line of lines) {
    const marker = line.match(fenceLine)?.[1];
    if (!fence && marker) {
      flushProse();
      fence = { character: marker[0]!, length: marker.length };
      appendOutput(line);
      continue;
    }
    if (fence && isClosingFenceLine(line, fence)) {
      appendOutput(line);
      fence = undefined;
      continue;
    }
    if (fence) appendOutput(line);
    else prose.push(line);
  }
  flushProse();
  return output.finish();
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
  const writer = new SynchronousLineWriter(warnings);
  let pending: ChunkedStringBuilder | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index]!;
    const line =
      sourceLine.length <= NORMALIZATION_SEGMENT_CODE_UNITS
        ? normalizeSingleProseLine(sourceLine, index === 0, warnings)
        : normalizeLongProseLine(sourceLine, index === 0, warnings);
    if (pending?.endsWith('-') && line.length > 0 && /^\p{Ll}/u.test(line)) {
      pending.removeLastCodeUnit();
      pending.append(line);
      warnings.add('WRAPPED_WORD_REJOINED');
      continue;
    }
    if (pending !== undefined) writer.writeLine(pending.finish());
    pending = new ChunkedStringBuilder();
    pending.append(line);
  }
  if (pending !== undefined) writer.writeLine(pending.finish());
  return writer.finish();
}

const NORMALIZATION_SEGMENT_CODE_UNITS = 32 * 1_024;
const NORMALIZATION_OUTPUT_CHUNK_CODE_UNITS = 64 * 1_024;

class CooperativeTextWorkController {
  private readonly yieldEvery: number;
  private pendingCodeUnits = 0;

  constructor(private readonly options: ContentNormalizationWorkOptionsV1) {
    this.yieldEvery = options.yieldEveryCodeUnits ?? 32_768;
    if (!Number.isSafeInteger(this.yieldEvery) || this.yieldEvery <= 0)
      throw new DomainError('SCHEMA_INVALID');
    this.assertActive();
  }

  assertActive(): void {
    if (this.options.isCancelled?.())
      throw new DomainError('PIPELINE_STAGE_FAILED');
  }

  async advance(codeUnits: number): Promise<void> {
    this.pendingCodeUnits += codeUnits;
    if (this.pendingCodeUnits < this.yieldEvery) return;
    this.pendingCodeUnits %= this.yieldEvery;
    await (this.options.yieldControl ?? yieldTextFingerprintWorkToHost)();
    this.assertActive();
  }
}

class ChunkedStringBuilder {
  private readonly chunks: string[] = [];
  private readonly fragments: string[] = [];
  private fragmentLength = 0;
  private byteCount = 0;

  append(value: string): void {
    if (value.length === 0) return;
    for (const chunk of boundedOutputChunks(value))
      this.appendWithUtf8ByteCount(chunk, utf8ByteCount(chunk));
  }

  appendWithUtf8ByteCount(value: string, appendedBytes: number): void {
    if (value.length === 0) return;
    if (this.byteCount + appendedBytes > DERIVED_TEXT_MAXIMUM_UTF8_BYTES)
      throw new DomainError('RESOURCE_MEMORY_PRESSURE');
    this.byteCount += appendedBytes;
    for (const chunk of boundedOutputChunks(value)) {
      this.fragments.push(chunk);
      this.fragmentLength += chunk.length;
      if (this.fragmentLength >= NORMALIZATION_OUTPUT_CHUNK_CODE_UNITS)
        this.flush();
    }
  }

  isEmpty(): boolean {
    return this.chunks.length === 0 && this.fragments.length === 0;
  }

  endsWith(character: string): boolean {
    const fragment = this.fragments.at(-1);
    if (fragment) return fragment.endsWith(character);
    return this.chunks.at(-1)?.endsWith(character) ?? false;
  }

  removeLastCodeUnit(): void {
    const fragments = this.fragments;
    const fragment = fragments.at(-1);
    if (fragment) {
      fragments[fragments.length - 1] = fragment.slice(0, -1);
      this.fragmentLength -= 1;
      this.byteCount -= 1;
      if (fragments.at(-1)?.length === 0) fragments.pop();
      return;
    }
    const chunk = this.chunks.at(-1);
    if (!chunk) return;
    this.chunks[this.chunks.length - 1] = chunk.slice(0, -1);
    this.byteCount -= 1;
    if (this.chunks.at(-1)?.length === 0) this.chunks.pop();
  }

  drainTo(target: ChunkedStringBuilder): void {
    this.flush();
    for (const chunk of this.chunks) target.append(chunk);
    this.chunks.length = 0;
    this.byteCount = 0;
  }

  finish(): string {
    return this.finishWithUtf8ByteCount().text;
  }

  finishWithUtf8ByteCount(): {
    readonly text: string;
    readonly utf8ByteCount: number;
  } {
    this.flush();
    return { text: this.chunks.join(''), utf8ByteCount: this.byteCount };
  }

  private flush(): void {
    if (this.fragments.length === 0) return;
    this.chunks.push(this.fragments.join(''));
    this.fragments.length = 0;
    this.fragmentLength = 0;
  }
}

function* boundedOutputChunks(value: string): Generator<string> {
  let start = 0;
  while (start < value.length) {
    let end = Math.min(
      value.length,
      start + NORMALIZATION_OUTPUT_CHUNK_CODE_UNITS,
    );
    if (end < value.length && isLowSurrogate(value.charCodeAt(end))) end -= 1;
    yield value.slice(start, end);
    start = end;
  }
}

class IncrementalLineWriter {
  private readonly output = new ChunkedStringBuilder();
  private hasLine = false;
  private trailingNewlines = 0;
  private outputUtf8Bytes = 0;

  constructor(
    private readonly warnings: Set<ContentNormalizationWarningV1>,
    private readonly work: CooperativeTextWorkController,
    private readonly maximumUtf8Bytes: number,
  ) {}

  private appendBounded(value: string): void {
    const appendedBytes = utf8ByteCount(value);
    const nextBytes = this.outputUtf8Bytes + appendedBytes;
    if (nextBytes > this.maximumUtf8Bytes)
      throw new DomainError('RESOURCE_MEMORY_PRESSURE');
    this.outputUtf8Bytes = nextBytes;
    this.output.appendWithUtf8ByteCount(value, appendedBytes);
  }

  async writeLine(
    line: string,
    collapseBlankSeparators: boolean,
  ): Promise<void> {
    if (this.hasLine) {
      if (collapseBlankSeparators && this.trailingNewlines >= 2) {
        this.warnings.add('REPEATED_BLANK_LINES_COLLAPSED');
      } else {
        this.appendBounded('\n');
        this.trailingNewlines += 1;
      }
    }
    this.hasLine = true;
    for (const chunk of boundedOutputChunks(line)) {
      this.appendBounded(chunk);
      this.trailingNewlines = 0;
      await this.work.advance(chunk.length);
    }
    if (line.length === 0) await this.work.advance(1);
  }

  finish(): string {
    return this.output.finish();
  }
}

class SynchronousLineWriter {
  private readonly output = new ChunkedStringBuilder();
  private hasLine = false;
  private trailingNewlines = 0;

  constructor(private readonly warnings: Set<ContentNormalizationWarningV1>) {}

  writeLine(line: string): void {
    if (this.hasLine) {
      if (this.trailingNewlines >= 2)
        this.warnings.add('REPEATED_BLANK_LINES_COLLAPSED');
      else {
        this.output.append('\n');
        this.trailingNewlines += 1;
      }
    }
    this.hasLine = true;
    for (const chunk of boundedOutputChunks(line)) this.output.append(chunk);
    if (line.length > 0) this.trailingNewlines = 0;
  }

  finish(): string {
    return this.output.finish();
  }
}

class IncrementalProseNormalizer {
  private pending: ChunkedStringBuilder | undefined;

  constructor(
    private readonly writer: IncrementalLineWriter,
    private readonly warnings: Set<ContentNormalizationWarningV1>,
    private readonly work: CooperativeTextWorkController,
  ) {}

  async push(line: string, firstSourceLine: boolean): Promise<void> {
    await this.work.advance(line.length + 1);
    const normalized =
      line.length <= NORMALIZATION_SEGMENT_CODE_UNITS
        ? await normalizedProseLineAsync(
            normalizeSingleProseLine(line, firstSourceLine, this.warnings),
            this.work,
          )
        : await normalizeLongProseLineAsync(
            line,
            firstSourceLine,
            this.warnings,
            this.work,
          );
    if (
      this.pending?.endsWith('-') &&
      normalized.text.length > 0 &&
      /^\p{Ll}/u.test(normalized.text)
    ) {
      this.pending.removeLastCodeUnit();
      this.pending.appendWithUtf8ByteCount(
        normalized.text,
        normalized.utf8ByteCount,
      );
      this.warnings.add('WRAPPED_WORD_REJOINED');
      return;
    }
    if (this.pending !== undefined)
      await this.writer.writeLine(this.pending.finish(), true);
    this.pending = new ChunkedStringBuilder();
    this.pending.appendWithUtf8ByteCount(
      normalized.text,
      normalized.utf8ByteCount,
    );
  }

  async flush(): Promise<void> {
    if (this.pending === undefined) return;
    await this.writer.writeLine(this.pending.finish(), true);
    this.pending = undefined;
  }
}

function normalizeSingleProseLine(
  line: string,
  firstSourceLine: boolean,
  warnings: Set<ContentNormalizationWarningV1>,
): string {
  let prepared = line;
  if (firstSourceLine && prepared.startsWith('\uFEFF')) {
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
  if (artifactsRemoved !== compatibility) warnings.add('OCR_ARTIFACT_REMOVED');
  const compact = artifactsRemoved.replace(/[\t ]+/g, ' ').trim();
  if (compact !== artifactsRemoved) warnings.add('PROSE_WHITESPACE_NORMALIZED');
  return compact;
}

function normalizeLongProseLine(
  line: string,
  firstSourceLine: boolean,
  warnings: Set<ContentNormalizationWarningV1>,
): string {
  let prepared = line;
  if (firstSourceLine && prepared.startsWith('\uFEFF')) {
    prepared = prepared.slice(1);
    warnings.add('OCR_ARTIFACT_REMOVED');
  }
  const output = new ChunkedStringBuilder();
  const pendingTrailingWhitespace = new ChunkedStringBuilder();
  let hasContent = false;
  for (const segment of normalizationSafeSegments(prepared)) {
    const compact = normalizeProseSegment(
      segment,
      hasContent,
      pendingTrailingWhitespace,
      output,
      warnings,
    );
    if (compact) hasContent = true;
  }
  if (!pendingTrailingWhitespace.isEmpty())
    warnings.add('PROSE_WHITESPACE_NORMALIZED');
  return output.finish();
}

async function normalizeLongProseLineAsync(
  line: string,
  firstSourceLine: boolean,
  warnings: Set<ContentNormalizationWarningV1>,
  work: CooperativeTextWorkController,
): Promise<NormalizedProseLine> {
  let prepared = line;
  if (firstSourceLine && prepared.startsWith('\uFEFF')) {
    prepared = prepared.slice(1);
    warnings.add('OCR_ARTIFACT_REMOVED');
  }
  const output = new ChunkedStringBuilder();
  const pendingTrailingWhitespace = new ChunkedStringBuilder();
  let hasContent = false;
  for (const segment of normalizationSafeSegments(prepared)) {
    const compact = normalizeProseSegment(
      segment,
      hasContent,
      pendingTrailingWhitespace,
      output,
      warnings,
    );
    if (compact) hasContent = true;
    await work.advance(segment.length);
  }
  if (!pendingTrailingWhitespace.isEmpty())
    warnings.add('PROSE_WHITESPACE_NORMALIZED');
  return output.finishWithUtf8ByteCount();
}

interface NormalizedProseLine {
  readonly text: string;
  readonly utf8ByteCount: number;
}

async function normalizedProseLineAsync(
  text: string,
  work: CooperativeTextWorkController,
): Promise<NormalizedProseLine> {
  let byteCount = 0;
  for (const chunk of boundedOutputChunks(text)) {
    byteCount += utf8ByteCount(chunk);
    await work.advance(chunk.length);
  }
  return { text, utf8ByteCount: byteCount };
}

function normalizeProseSegment(
  segment: string,
  hasContent: boolean,
  pendingTrailingWhitespace: ChunkedStringBuilder,
  output: ChunkedStringBuilder,
  warnings: Set<ContentNormalizationWarningV1>,
): boolean {
  const safe = segment.replace(unsafeControl, '\uFFFD');
  if (safe !== segment) warnings.add('OCR_ARTIFACT_REMOVED');
  const compatibility = safe.normalize('NFKC');
  if (compatibility !== safe) warnings.add('UNICODE_NORMALIZED');
  const artifactsRemoved = compatibility
    .replace(ocrArtifact, '')
    .replace(/\u00A0/g, ' ');
  if (artifactsRemoved !== compatibility) warnings.add('OCR_ARTIFACT_REMOVED');
  let compact = artifactsRemoved.replace(/[\t ]+/g, ' ');
  if (compact !== artifactsRemoved) warnings.add('PROSE_WHITESPACE_NORMALIZED');
  if (!hasContent) {
    const leadingTrimmed = compact.replace(/^\s+/u, '');
    if (leadingTrimmed !== compact) warnings.add('PROSE_WHITESPACE_NORMALIZED');
    compact = leadingTrimmed;
  }
  if (
    (pendingTrailingWhitespace.endsWith(' ') ||
      (pendingTrailingWhitespace.isEmpty() && output.endsWith(' '))) &&
    compact.startsWith(' ')
  ) {
    compact = compact.slice(1);
    warnings.add('PROSE_WHITESPACE_NORMALIZED');
  }
  const trailingWhitespace = compact.match(/\s+$/u)?.[0] ?? '';
  const body =
    trailingWhitespace.length === 0
      ? compact
      : compact.slice(0, -trailingWhitespace.length);
  if (body.length > 0) {
    pendingTrailingWhitespace.drainTo(output);
    output.append(body);
  }
  pendingTrailingWhitespace.append(trailingWhitespace);
  return body.length > 0;
}

function* normalizationSafeSegments(value: string): Generator<string> {
  let start = 0;
  while (value.length - start > NORMALIZATION_SEGMENT_CODE_UNITS) {
    let end = start + NORMALIZATION_SEGMENT_CODE_UNITS;
    if (isLowSurrogate(value.charCodeAt(end))) end += 1;
    const maximumEnd = Math.min(
      value.length,
      start + NORMALIZATION_OUTPUT_CHUNK_CODE_UNITS,
    );
    while (end < maximumEnd && !isNormalizationBoundary(value, end))
      end += codePointLengthAt(value, end);
    if (end >= maximumEnd && !isNormalizationBoundary(value, end))
      throw new DomainError('RESOURCE_MEMORY_PRESSURE');
    yield value.slice(start, end);
    start = end;
  }
  yield value.slice(start);
}

function isNormalizationBoundary(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return true;
  const right = codePointStringAt(value, index);
  // NFKD exposes compatibility characters such as halfwidth voiced marks as
  // non-starters. A boundary before any such decomposition would discard the
  // earlier canonical starter needed for composition after reordering.
  if (/^\p{M}/u.test(right.normalize('NFKD'))) return false;
  const leftIndex = previousCodePointIndex(value, index);
  const leftCharacter = codePointStringAt(value, leftIndex);
  if (
    `${leftCharacter}${right}`.normalize('NFKC') !==
    `${leftCharacter.normalize('NFKC')}${right.normalize('NFKC')}`
  )
    return false;
  const left = value.codePointAt(leftIndex)!;
  const rightValue = value.codePointAt(index)!;
  if (isHangulLeadingJamo(left) && isHangulVowelJamo(rightValue)) return false;
  if (
    (isHangulVowelJamo(left) || isHangulSyllableWithoutTail(left)) &&
    isHangulTrailingJamo(rightValue)
  )
    return false;
  return true;
}

function codePointLengthAt(value: string, index: number): number {
  return (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

function codePointStringAt(value: string, index: number): string {
  const codePoint = value.codePointAt(index);
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint);
}

function previousCodePointIndex(value: string, index: number): number {
  return index > 1 && isLowSurrogate(value.charCodeAt(index - 1))
    ? index - 2
    : index - 1;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function isHangulLeadingJamo(value: number): boolean {
  return value >= 0x1100 && value <= 0x115f;
}

function isHangulVowelJamo(value: number): boolean {
  return value >= 0x1160 && value <= 0x11a7;
}

function isHangulTrailingJamo(value: number): boolean {
  return value >= 0x11a8 && value <= 0x11ff;
}

function isHangulSyllableWithoutTail(value: number): boolean {
  return value >= 0xac00 && value <= 0xd7a3 && (value - 0xac00) % 28 === 0;
}

interface CanonicalSourceLineScan {
  readonly value: string;
  readonly hasNonWhitespace: boolean;
}

/** Scans even a newline-free maximum-size source in cancellable chunks. */
async function* canonicalSourceLinesAsync(
  source: string,
  work: CooperativeTextWorkController,
): AsyncGenerator<CanonicalSourceLineScan> {
  let start = 0;
  let sinceCheckpoint = 0;
  let hasNonWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const unit = source.charCodeAt(index);
    if (unit !== 0x0a && unit !== 0x0d) {
      if (!(index === 0 && unit === 0xfeff) && !/\s/u.test(source[index]!))
        hasNonWhitespace = true;
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= NORMALIZATION_SEGMENT_CODE_UNITS) {
        await work.advance(sinceCheckpoint);
        sinceCheckpoint = 0;
      }
      continue;
    }
    const lineEnd = index;
    sinceCheckpoint += 1;
    if (unit === 0x0d && source.charCodeAt(index + 1) === 0x0a) {
      index += 1;
      sinceCheckpoint += 1;
    }
    if (sinceCheckpoint > 0) {
      await work.advance(sinceCheckpoint);
      sinceCheckpoint = 0;
    }
    yield { value: source.slice(start, lineEnd), hasNonWhitespace };
    start = index + 1;
    hasNonWhitespace = false;
  }
  if (sinceCheckpoint > 0) await work.advance(sinceCheckpoint);
  yield { value: source.slice(start), hasNonWhitespace };
}

function lineHasNonWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1)
    if (!/\s/u.test(value[index]!)) return true;
  return false;
}

async function assertValidUnicodeScalarStringAsync(
  source: string,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  let sinceCheckpoint = 0;
  let hasCarriageReturn = false;
  for (let index = 0; index < source.length; index += 1) {
    const unit = source.charCodeAt(index);
    if (unit === 0x0d) hasCarriageReturn = true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = source.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff))
        throw new DomainError('SCHEMA_INVALID');
      index += 1;
      sinceCheckpoint += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new DomainError('SCHEMA_INVALID');
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= 32_768) {
      await work.advance(sinceCheckpoint);
      sinceCheckpoint = 0;
    }
  }
  if (sinceCheckpoint > 0) await work.advance(sinceCheckpoint);
  work.assertActive();
  return hasCarriageReturn;
}

async function utf8ByteCountAsync(
  value: string,
  work: CooperativeTextWorkController,
): Promise<number> {
  let byteCount = 0;
  let sinceCheckpoint = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) byteCount += 1;
    else if (unit <= 0x7ff) byteCount += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      byteCount += 4;
      index += 1;
      sinceCheckpoint += 1;
    } else byteCount += 3;
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= 32_768) {
      await work.advance(sinceCheckpoint);
      sinceCheckpoint = 0;
    }
  }
  if (sinceCheckpoint > 0) await work.advance(sinceCheckpoint);
  work.assertActive();
  return byteCount;
}

async function validateNormalizedContentForFingerprintAsyncV1(
  value: unknown,
  options: TextFingerprintWorkOptionsV1,
  yieldEvery: number,
): Promise<NormalizedContentV1> {
  if (!isNormalizedContentShapeV1(value))
    throw new DomainError('SCHEMA_INVALID');
  assertFingerprintWorkActive(options);
  let byteCount = 0;
  let visited = 0;
  for (let index = 0; index < value.text.length; index += 1) {
    const unit = value.text.charCodeAt(index);
    if (unit <= 0x7f) byteCount += 1;
    else if (unit <= 0x7ff) byteCount += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff))
        throw new DomainError('SCHEMA_INVALID');
      byteCount += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new DomainError('SCHEMA_INVALID');
    else byteCount += 3;
    visited += 1;
    if (visited % yieldEvery !== 0) continue;
    await (options.yieldControl ?? yieldTextFingerprintWorkToHost)();
    assertFingerprintWorkActive(options);
  }
  assertFingerprintWorkActive(options);
  if (byteCount !== value.utf8ByteCount)
    throw new DomainError('SCHEMA_INVALID');
  return value;
}

function isCodeSignalLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return (
    fenceLine.test(line) ||
    /^\s+(?:\S|$)/.test(line) ||
    isAssignmentSignalLine(line) ||
    isCallExpressionSignalLine(line) ||
    /(?:=>|::|\{\s*$|[;{}]\s*$|^\s*(?:const|let|var|func|class|interface|type|import|export|def|fun|if|for|while)\b)/.test(
      line,
    )
  );
}

async function isCodeSignalLineBounded(
  line: string,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  if (line.length <= NORMALIZATION_SEGMENT_CODE_UNITS)
    return isCodeSignalLine(line);
  const contentStart = await skipLineCharacters(
    line,
    0,
    isWhitespaceCharacter,
    work,
  );
  if (contentStart === line.length) return false;
  if (contentStart > 0) return true;
  if (await fenceDescriptorForLineBounded(line, work)) return true;
  if (await hasInfixCodeSignalLineBounded(line, work)) return true;
  if (await hasTerminalCodeSignalLineBounded(line, work)) return true;
  if (hasLeadingCodeKeyword(line, contentStart)) return true;
  if (await isLongAssignmentSignalLine(line, contentStart, work)) return true;
  return isLongCallExpressionSignalLine(line, contentStart, work);
}

async function hasInfixCodeSignalLineBounded(
  line: string,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  let checkpoint = 0;
  for (let index = 0; index < line.length - 1; index += 1) {
    const left = line[index];
    const right = line[index + 1];
    if ((left === '=' && right === '>') || (left === ':' && right === ':'))
      return true;
    if (index - checkpoint < NORMALIZATION_SEGMENT_CODE_UNITS) continue;
    await work.advance(index - checkpoint);
    checkpoint = index;
  }
  if (line.length > checkpoint) await work.advance(line.length - checkpoint);
  return false;
}

async function hasTerminalCodeSignalLineBounded(
  line: string,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  const terminal = await skipLineCharactersBackward(
    line,
    line.length,
    isWhitespaceCharacter,
    work,
  );
  return terminal > 0 && ';{}'.includes(line[terminal - 1]!);
}

function hasLeadingCodeKeyword(line: string, start: number): boolean {
  for (const keyword of [
    'const',
    'let',
    'var',
    'func',
    'class',
    'interface',
    'type',
    'import',
    'export',
    'def',
    'fun',
    'if',
    'for',
    'while',
  ] as const)
    if (
      line.startsWith(keyword, start) &&
      !isAsciiWordCharacter(line[start + keyword.length] ?? '')
    )
      return true;
  return false;
}

const assignmentOperators = [
  '>>>=',
  '**=',
  '??=',
  '&&=',
  '||=',
  '<<=',
  '>>=',
  '//=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '@=',
  ':=',
  '=',
] as const;

async function isLongAssignmentSignalLine(
  line: string,
  contentStart: number,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  let index = contentStart;
  if (
    line.startsWith('export', index) &&
    isWhitespaceCharacter(line[index + 'export'.length] ?? '')
  )
    index = await skipLineCharacters(
      line,
      index + 'export'.length,
      isWhitespaceCharacter,
      work,
    );
  if (!isIdentifierStartCharacter(line[index] ?? '')) return false;
  const target = await scanAssignmentTarget(line, index, work);
  index = target.end;
  index = await skipLineCharacters(line, index, isWhitespaceCharacter, work);
  if (line[index] === ':' && target.colonEligible) {
    index = await skipLineCharacters(
      line,
      index + 1,
      isWhitespaceCharacter,
      work,
    );
    if (/^["'[{]/.test(line[index] ?? '')) return true;
    if (
      (line[index] === '+' || line[index] === '-') &&
      isAsciiDigit(line[index + 1] ?? '')
    )
      return true;
    if (isAsciiDigit(line[index] ?? '')) return true;
    for (const literal of ['true', 'false', 'null'] as const)
      if (
        line
          .slice(index, index + literal.length)
          .toLowerCase()
          .startsWith(literal) &&
        !isAsciiWordCharacter(line[index + literal.length] ?? '')
      )
        return true;
  }
  const operator = assignmentOperators.find(candidate =>
    line.startsWith(candidate, index),
  );
  if (!operator) return false;
  index = await skipLineCharacters(
    line,
    index + operator.length,
    isWhitespaceCharacter,
    work,
  );
  return index < line.length && !isWhitespaceCharacter(line[index]!);
}

async function scanAssignmentTarget(
  line: string,
  start: number,
  work: CooperativeTextWorkController,
): Promise<{ readonly end: number; readonly colonEligible: boolean }> {
  let index = start + 1;
  let checkpoint = index;
  let colonEligible = line[start] !== '$';
  while (index < line.length && isAssignmentTargetCharacter(line[index]!)) {
    if ("$[]'".includes(line[index]!)) colonEligible = false;
    index += 1;
    if (index - checkpoint < NORMALIZATION_SEGMENT_CODE_UNITS) continue;
    await work.advance(index - checkpoint);
    checkpoint = index;
  }
  if (index > checkpoint) await work.advance(index - checkpoint);
  return { end: index, colonEligible };
}

async function isLongCallExpressionSignalLine(
  line: string,
  contentStart: number,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  let index = await callExpressionIdentifierStartAsync(
    line,
    contentStart,
    work,
  );
  if (!isIdentifierStartCharacter(line[index] ?? '')) return false;
  index = await skipLineCharacters(
    line,
    index + 1,
    isIdentifierCharacter,
    work,
  );
  while (line[index] === '.' || line.startsWith('?.', index)) {
    index += line[index] === '.' ? 1 : 2;
    if (!isIdentifierStartCharacter(line[index] ?? '')) return false;
    index = await skipLineCharacters(
      line,
      index + 1,
      isIdentifierCharacter,
      work,
    );
  }
  index = await skipLineCharacters(line, index, isWhitespaceCharacter, work);
  if (line[index] !== '(') return false;
  const terminal = await callExpressionTerminalIndex(line, work);
  if (terminal <= index || line[terminal] !== ')') return false;
  return !(await containsRegexLineTerminator(line, index + 1, terminal, work));
}

async function callExpressionTerminalIndex(
  line: string,
  work: CooperativeTextWorkController,
): Promise<number> {
  let index = await skipLineCharactersBackward(
    line,
    line.length,
    isWhitespaceCharacter,
    work,
  );
  if (line[index - 1] === ';')
    index = await skipLineCharactersBackward(
      line,
      index - 1,
      isWhitespaceCharacter,
      work,
    );
  return index - 1;
}

async function containsRegexLineTerminator(
  line: string,
  start: number,
  end: number,
  work: CooperativeTextWorkController,
): Promise<boolean> {
  let checkpoint = start;
  for (let index = start; index < end; index += 1) {
    const value = line.charCodeAt(index);
    if (
      value === 0x0a ||
      value === 0x0d ||
      value === 0x2028 ||
      value === 0x2029
    )
      return true;
    if (index - checkpoint < NORMALIZATION_SEGMENT_CODE_UNITS) continue;
    await work.advance(index - checkpoint);
    checkpoint = index;
  }
  if (end > checkpoint) await work.advance(end - checkpoint);
  return false;
}

async function skipLineCharacters(
  line: string,
  start: number,
  predicate: (value: string) => boolean,
  work: CooperativeTextWorkController,
): Promise<number> {
  let index = start;
  let checkpoint = start;
  while (index < line.length && predicate(line[index]!)) {
    index += 1;
    if (index - checkpoint >= NORMALIZATION_SEGMENT_CODE_UNITS) {
      await work.advance(index - checkpoint);
      checkpoint = index;
    }
  }
  if (index > checkpoint) await work.advance(index - checkpoint);
  return index;
}

async function skipLineCharactersBackward(
  line: string,
  start: number,
  predicate: (value: string) => boolean,
  work: CooperativeTextWorkController,
): Promise<number> {
  let index = start;
  let checkpoint = start;
  while (index > 0 && predicate(line[index - 1]!)) {
    index -= 1;
    if (checkpoint - index >= NORMALIZATION_SEGMENT_CODE_UNITS) {
      await work.advance(checkpoint - index);
      checkpoint = index;
    }
  }
  if (checkpoint > index) await work.advance(checkpoint - index);
  return index;
}

function isWhitespaceCharacter(value: string): boolean {
  return value.length > 0 && /\s/u.test(value);
}

function isIdentifierStartCharacter(value: string): boolean {
  return /[A-Za-z_$]/.test(value);
}

function isIdentifierCharacter(value: string): boolean {
  return /[\w$]/.test(value);
}

function isAssignmentTargetCharacter(value: string): boolean {
  return /[\w.$[\]'-]/.test(value);
}

function isAsciiDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function isAsciiWordCharacter(value: string): boolean {
  return /[A-Za-z0-9_]/.test(value);
}

async function fenceDescriptorForLineBounded(
  line: string,
  work: CooperativeTextWorkController,
): Promise<
  { readonly character: string; readonly length: number } | undefined
> {
  const start = await skipLineCharacters(line, 0, isWhitespaceCharacter, work);
  const character = line[start];
  if (character !== '`' && character !== '~') return undefined;
  const end = await skipLineCharacters(
    line,
    start,
    value => value === character,
    work,
  );
  return end - start >= 3 ? { character, length: end - start } : undefined;
}

async function isClosingFenceLineBounded(
  line: string,
  fence: { readonly character: string; readonly length: number },
  work: CooperativeTextWorkController,
): Promise<boolean> {
  const start = await skipLineCharacters(line, 0, isWhitespaceCharacter, work);
  const end = await skipLineCharacters(
    line,
    start,
    value => value === fence.character,
    work,
  );
  if (end - start < fence.length) return false;
  return (
    (await skipLineCharacters(line, end, isWhitespaceCharacter, work)) ===
    line.length
  );
}

function isCallExpressionSignalLine(line: string): boolean {
  let index = skipLineCharactersSync(line, 0, isWhitespaceCharacter);
  index = callExpressionIdentifierStartSync(line, index);
  if (!isIdentifierStartCharacter(line[index] ?? '')) return false;
  index = skipLineCharactersSync(line, index + 1, isIdentifierCharacter);
  while (line[index] === '.' || line.startsWith('?.', index)) {
    index += line[index] === '.' ? 1 : 2;
    if (!isIdentifierStartCharacter(line[index] ?? '')) return false;
    index = skipLineCharactersSync(line, index + 1, isIdentifierCharacter);
  }
  index = skipLineCharactersSync(line, index, isWhitespaceCharacter);
  if (line[index] !== '(') return false;
  const terminal = callExpressionTerminalIndexSync(line);
  if (terminal <= index || line[terminal] !== ')') return false;
  return !containsRegexLineTerminatorSync(line, index + 1, terminal);
}

interface CallExpressionPrefix {
  readonly length: number;
  readonly allowsNew: boolean;
}

function callExpressionPrefixAt(
  line: string,
  index: number,
): CallExpressionPrefix | undefined {
  for (const prefix of ['await', 'return', 'yield', 'throw'] as const)
    if (
      line.startsWith(prefix, index) &&
      isWhitespaceCharacter(line[index + prefix.length] ?? '')
    )
      return { length: prefix.length, allowsNew: true };
  for (const prefix of ['raise', 'new'] as const)
    if (
      line.startsWith(prefix, index) &&
      isWhitespaceCharacter(line[index + prefix.length] ?? '')
    )
      return { length: prefix.length, allowsNew: false };
  return undefined;
}

function callExpressionIdentifierStartSync(
  line: string,
  start: number,
): number {
  const prefix = callExpressionPrefixAt(line, start);
  if (!prefix) return start;
  let index = skipLineCharactersSync(
    line,
    start + prefix.length,
    isWhitespaceCharacter,
  );
  if (
    prefix.allowsNew &&
    line.startsWith('new', index) &&
    isWhitespaceCharacter(line[index + 'new'.length] ?? '')
  )
    index = skipLineCharactersSync(
      line,
      index + 'new'.length,
      isWhitespaceCharacter,
    );
  return index;
}

async function callExpressionIdentifierStartAsync(
  line: string,
  start: number,
  work: CooperativeTextWorkController,
): Promise<number> {
  const prefix = callExpressionPrefixAt(line, start);
  if (!prefix) return start;
  let index = await skipLineCharacters(
    line,
    start + prefix.length,
    isWhitespaceCharacter,
    work,
  );
  if (
    prefix.allowsNew &&
    line.startsWith('new', index) &&
    isWhitespaceCharacter(line[index + 'new'.length] ?? '')
  )
    index = await skipLineCharacters(
      line,
      index + 'new'.length,
      isWhitespaceCharacter,
      work,
    );
  return index;
}

function callExpressionTerminalIndexSync(line: string): number {
  let index = skipLineCharactersBackwardSync(
    line,
    line.length,
    isWhitespaceCharacter,
  );
  if (line[index - 1] === ';')
    index = skipLineCharactersBackwardSync(
      line,
      index - 1,
      isWhitespaceCharacter,
    );
  return index - 1;
}

function containsRegexLineTerminatorSync(
  line: string,
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index += 1) {
    const value = line.charCodeAt(index);
    if (
      value === 0x0a ||
      value === 0x0d ||
      value === 0x2028 ||
      value === 0x2029
    )
      return true;
  }
  return false;
}

function skipLineCharactersSync(
  line: string,
  start: number,
  predicate: (value: string) => boolean,
): number {
  let index = start;
  while (index < line.length && predicate(line[index]!)) index += 1;
  return index;
}

function skipLineCharactersBackwardSync(
  line: string,
  start: number,
  predicate: (value: string) => boolean,
): number {
  let index = start;
  while (index > 0 && predicate(line[index - 1]!)) index -= 1;
  return index;
}

function isAssignmentSignalLine(line: string): boolean {
  return (
    /^\s*(?:export\s+)?[A-Za-z_$][\w.$[\]'-]*\s*(?:=|\+=|-=|\*=|\/=|\/{2}=|%=|&=|\|=|\^=|@=|:=|\?\?=|&&=|\|\|=|<<=|>>=|>>>=|\*\*=)\s*\S/.test(
      line,
    ) ||
    /^\s*[A-Za-z_][\w.-]*\s*:\s*(?:["'[{]|[-+]?\d|true\b|false\b|null\b)/i.test(
      line,
    )
  );
}

function* similarityCodePoints(
  normalized: NormalizedContentV1,
): Generator<string> {
  let emitted = false;
  let pendingWhitespace = false;
  let precededByCased = false;
  for (
    let index = 0;
    index < normalized.text.length;
    index += codePointLengthAt(normalized.text, index)
  ) {
    const sourceCodePoint = codePointStringAt(normalized.text, index);
    const folded =
      normalized.contentKind === 'prose'
        ? lowercaseCodePointWithContext(
            normalized.text,
            index,
            sourceCodePoint,
            precededByCased,
          )
        : sourceCodePoint;
    for (const codePoint of folded) {
      if (normalized.contentKind === 'prose' && /^\s$/u.test(codePoint)) {
        if (emitted) pendingWhitespace = true;
        continue;
      }
      if (pendingWhitespace) yield ' ';
      yield codePoint;
      emitted = true;
      pendingWhitespace = false;
    }
    precededByCased = updateCasedContext(precededByCased, sourceCodePoint);
  }
}

async function* similarityCodePointsAsync(
  normalized: NormalizedContentV1,
  options: TextFingerprintWorkOptionsV1,
  yieldEvery: number,
): AsyncGenerator<string> {
  let emitted = false;
  let pendingWhitespace = false;
  let precededByCased = false;
  for (
    let index = 0;
    index < normalized.text.length;
    index += codePointLengthAt(normalized.text, index)
  ) {
    const sourceCodePoint = codePointStringAt(normalized.text, index);
    const folded =
      normalized.contentKind === 'prose'
        ? await lowercaseCodePointWithContextAsync(
            normalized.text,
            index,
            sourceCodePoint,
            precededByCased,
            options,
            yieldEvery,
          )
        : sourceCodePoint;
    for (const codePoint of folded) {
      if (normalized.contentKind === 'prose' && /^\s$/u.test(codePoint)) {
        if (emitted) pendingWhitespace = true;
        continue;
      }
      if (pendingWhitespace) yield ' ';
      yield codePoint;
      emitted = true;
      pendingWhitespace = false;
    }
    precededByCased = updateCasedContext(precededByCased, sourceCodePoint);
  }
}

function lowercaseCodePointWithContext(
  value: string,
  index: number,
  codePoint: string,
  precededByCased: boolean,
): string {
  if (codePoint !== '\u03A3' || !precededByCased)
    return codePoint.toLowerCase();
  return hasFollowingCasedCharacter(value, index + codePoint.length)
    ? '\u03C3'
    : '\u03C2';
}

async function lowercaseCodePointWithContextAsync(
  value: string,
  index: number,
  codePoint: string,
  precededByCased: boolean,
  options: TextFingerprintWorkOptionsV1,
  yieldEvery: number,
): Promise<string> {
  if (codePoint !== '\u03A3' || !precededByCased)
    return codePoint.toLowerCase();
  return (await hasFollowingCasedCharacterAsync(
    value,
    index + codePoint.length,
    options,
    yieldEvery,
  ))
    ? '\u03C3'
    : '\u03C2';
}

function hasFollowingCasedCharacter(value: string, start: number): boolean {
  for (
    let index = start;
    index < value.length;
    index += codePointLengthAt(value, index)
  ) {
    const codePoint = codePointStringAt(value, index);
    if (/^\p{Case_Ignorable}$/u.test(codePoint)) continue;
    return /^\p{Cased}$/u.test(codePoint);
  }
  return false;
}

async function hasFollowingCasedCharacterAsync(
  value: string,
  start: number,
  options: TextFingerprintWorkOptionsV1,
  yieldEvery: number,
): Promise<boolean> {
  let visited = 0;
  for (
    let index = start;
    index < value.length;
    index += codePointLengthAt(value, index)
  ) {
    const codePoint = codePointStringAt(value, index);
    if (!/^\p{Case_Ignorable}$/u.test(codePoint))
      return /^\p{Cased}$/u.test(codePoint);
    visited += codePoint.length;
    if (visited < yieldEvery) continue;
    visited %= yieldEvery;
    await (options.yieldControl ?? yieldTextFingerprintWorkToHost)();
    assertFingerprintWorkActive(options);
  }
  return false;
}

function updateCasedContext(
  precededByCased: boolean,
  codePoint: string,
): boolean {
  if (/^\p{Case_Ignorable}$/u.test(codePoint)) return precededByCased;
  return /^\p{Cased}$/u.test(codePoint);
}

class TextFingerprintAccumulatorV1 {
  private readonly sample: number[] = [];
  private readonly sampled = new Set<number>();
  private readonly window: string[] = [];
  private codePointCount = 0;

  append(codePoint: string): void {
    this.codePointCount += 1;
    if (this.window.length === 5) this.window.shift();
    this.window.push(codePoint);
    if (this.window.length === 5) this.addHash(fnv1a32Parts(this.window));
  }

  finish(): NormalizedTextFingerprintV1 {
    if (this.codePointCount > 0 && this.codePointCount < 5)
      this.addHash(fnv1a32Parts(this.window));
    return {
      schemaVersion: 1,
      algorithm: 'bottom-k-fnv1a32-5gram-v1',
      shingleSize: 5,
      sampleSize: TEXT_FINGERPRINT_SAMPLE_SIZE,
      similarityCharacterCount: this.codePointCount,
      shingleCount:
        this.codePointCount === 0 ? 0 : Math.max(1, this.codePointCount - 4),
      hashes: this.sample.map(hash => hash.toString(16).padStart(8, '0')),
    };
  }

  private addHash(hash: number): void {
    if (this.sampled.has(hash)) return;
    if (
      this.sample.length === TEXT_FINGERPRINT_SAMPLE_SIZE &&
      hash >= this.sample[this.sample.length - 1]!
    )
      return;
    const position = lowerBound(this.sample, hash);
    this.sample.splice(position, 0, hash);
    this.sampled.add(hash);
    if (this.sample.length <= TEXT_FINGERPRINT_SAMPLE_SIZE) return;
    const removed = this.sample.pop();
    if (removed !== undefined) this.sampled.delete(removed);
  }
}

function fnv1a32Parts(parts: readonly string[]): number {
  let hash = 0x811c9dc5;
  /* eslint-disable no-bitwise -- FNV-1a v1 requires unsigned 32-bit arithmetic. */
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  const unsigned = hash >>> 0;
  /* eslint-enable no-bitwise */
  return unsigned;
}

function assertFingerprintWorkActive(
  options: TextFingerprintWorkOptionsV1,
): void {
  if (options.isCancelled?.()) throw new DomainError('PIPELINE_STAGE_FAILED');
}

function yieldTextFingerprintWorkToHost(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
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
