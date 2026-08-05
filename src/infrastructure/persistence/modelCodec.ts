import { isCanonicalUuid } from '../../domain/canonicalUuid';
import { DOMAIN_ERROR_CATALOG, DomainError } from '../../domain/errors';
import type {
  Artifact,
  Budget,
  ContextItem,
  ContextPack,
  ExportRecord,
  FindingLocation,
  ProcessorVersion,
  RiskFinding,
} from '../../domain/models';
import { isOwnedArtifactPath } from './ownedPaths';
import type { SavePackGraphInput } from './contracts';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MEDIA_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const PACK_STATES = new Set([
  'draft',
  'processing',
  'review-required',
  'ready',
  'exporting',
  'exported',
  'recovering',
  'failed',
  'cancelled',
]);
const ITEM_STATES = new Set([
  'received',
  'imported',
  'extracted',
  'analyzed',
  'review-required',
  'reviewed',
  'packaged',
  'recovering',
  'failed',
  'cancelled',
]);
const SOURCE_TYPES = new Set(['image', 'pdf', 'text', 'url']);
const INCLUSION_MODES = new Set(['original', 'extracted', 'both', 'excluded']);
const BUDGET_PRESETS = new Set(['quality', 'balanced', 'compact', 'custom']);
const RISK_CATEGORIES = new Set([
  'api-key',
  'bearer-token',
  'jwt',
  'private-key',
  'url-credential',
  'email',
  'phone',
  'ip-address',
  'payment-card',
]);
const EXPORT_FORMATS = new Set([
  'markdown',
  'pdf',
  'attachment-bundle',
  'clipboard',
]);
const EXPORT_STATUSES = new Set(['running', 'complete', 'failed', 'cancelled']);
const ARTIFACT_KINDS = new Set([
  'original',
  'ocr-text',
  'pdf-page-text',
  'compressed-image',
  'redacted-image',
  'preview',
  'export',
]);

export function assertPackGraph(input: SavePackGraphInput): void {
  assertContextPack(input.pack);
  if (
    input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1)
  )
    invalid();
  const itemIds = new Set<string>();
  const indexes = new Set<number>();
  for (const item of input.items) {
    assertContextItem(item);
    if (
      item.packId !== input.pack.id ||
      itemIds.has(item.id) ||
      indexes.has(item.sortIndex)
    )
      invalid();
    itemIds.add(item.id);
    indexes.add(item.sortIndex);
  }
  const ordered = [...input.items]
    .sort((left, right) => left.sortIndex - right.sortIndex)
    .map(item => item.id);
  if (
    ordered.some((id, index) => input.pack.orderedItemIds[index] !== id) ||
    ordered.length !== input.pack.orderedItemIds.length ||
    ordered.some((_, index) => index !== input.items[index]?.sortIndex)
  )
    invalid();
}

export function assertContextPack(pack: ContextPack): void {
  if (
    !isCanonicalUuid(pack.id) ||
    pack.schemaVersion !== 1 ||
    typeof pack.title !== 'string' ||
    typeof pack.userInstruction !== 'string' ||
    !isIsoDateTime(pack.createdAt) ||
    !isIsoDateTime(pack.updatedAt) ||
    Date.parse(pack.updatedAt) < Date.parse(pack.createdAt) ||
    !PACK_STATES.has(pack.state) ||
    !isBudget(pack.budget) ||
    !Number.isSafeInteger(pack.estimatedTokens) ||
    pack.estimatedTokens < 0 ||
    !isUniqueCanonicalIdArray(pack.orderedItemIds) ||
    !isUniqueCanonicalIdArray(pack.exportRecordIds) ||
    !isSafeCodeArray(pack.warningCodes)
  )
    invalid();
}

export function assertContextItem(item: ContextItem): void {
  if (
    !isCanonicalUuid(item.id) ||
    !isCanonicalUuid(item.packId) ||
    !SOURCE_TYPES.has(item.sourceType) ||
    !MEDIA_TYPE.test(item.mediaType) ||
    (item.originalDisplayName !== undefined &&
      typeof item.originalDisplayName !== 'string') ||
    (item.originalSha256 !== undefined && !SHA256.test(item.originalSha256)) ||
    (item.originalRelativePath !== undefined &&
      !isOwnedArtifactPath(item.originalRelativePath)) ||
    !isUniqueCanonicalIdArray(item.artifactIds) ||
    !ITEM_STATES.has(item.state) ||
    !isUniqueCanonicalIdArray(item.riskFindingIds) ||
    !INCLUSION_MODES.has(item.inclusionMode) ||
    !Number.isSafeInteger(item.sortIndex) ||
    item.sortIndex < 0
  )
    invalid();
}

export function assertArtifact(artifact: Artifact): void {
  if (
    !isCanonicalUuid(artifact.id) ||
    (artifact.itemId !== undefined && !isCanonicalUuid(artifact.itemId)) ||
    (artifact.kind === 'original' && artifact.itemId === undefined) ||
    !ARTIFACT_KINDS.has(artifact.kind) ||
    !isOwnedArtifactPath(artifact.relativePath) ||
    !MEDIA_TYPE.test(artifact.mediaType) ||
    !Number.isSafeInteger(artifact.byteCount) ||
    artifact.byteCount < 0 ||
    !SHA256.test(artifact.sha256) ||
    !isProcessorVersion(artifact.processorVersion) ||
    !isIsoDateTime(artifact.createdAt) ||
    artifact.immutable !== true
  )
    invalid();
}

export function assertRiskFinding(finding: RiskFinding): void {
  if (
    !isCanonicalUuid(finding.id) ||
    !isCanonicalUuid(finding.itemId) ||
    !isProcessorVersion(finding.detectorVersion) ||
    !RISK_CATEGORIES.has(finding.category) ||
    !['low', 'medium', 'high'].includes(finding.severity) ||
    !Number.isFinite(finding.confidence) ||
    finding.confidence < 0 ||
    finding.confidence > 1 ||
    !isFindingLocation(finding.location) ||
    !isIsoDateTime(finding.createdAt)
  )
    invalid();
}

export function assertExportRecord(record: ExportRecord): void {
  if (
    !isCanonicalUuid(record.id) ||
    !isCanonicalUuid(record.packId) ||
    !EXPORT_FORMATS.has(record.format) ||
    !isIsoDateTime(record.createdAt) ||
    !BUDGET_PRESETS.has(record.preset) ||
    !EXPORT_STATUSES.has(record.status) ||
    (record.manifestSha256 !== undefined &&
      !SHA256.test(record.manifestSha256)) ||
    !isUniqueCanonicalIdArray(record.artifactIds) ||
    (record.errorCode !== undefined &&
      !Object.hasOwn(DOMAIN_ERROR_CATALOG, record.errorCode))
  )
    invalid();
}

export function encodeBudget(value: Budget): string {
  if (!isBudget(value)) invalid();
  return JSON.stringify(value);
}

export function decodeBudget(value: string): Budget {
  const parsed = parseJson(value);
  if (!isBudget(parsed)) invalid();
  return parsed;
}

export function encodeProcessorVersion(value: ProcessorVersion): string {
  if (!isProcessorVersion(value)) invalid();
  return JSON.stringify(value);
}

export function decodeProcessorVersion(value: string): ProcessorVersion {
  const parsed = parseJson(value);
  if (!isProcessorVersion(parsed)) invalid();
  return parsed;
}

export function encodeFindingLocation(value: FindingLocation): string {
  if (!isFindingLocation(value)) invalid();
  return JSON.stringify(value);
}

export function decodeFindingLocation(value: string): FindingLocation {
  const parsed = parseJson(value);
  if (!isFindingLocation(parsed)) invalid();
  return parsed;
}

export function encodeStringArray(value: readonly string[]): string {
  if (!value.every(item => typeof item === 'string')) invalid();
  return JSON.stringify(value);
}

export function decodeStringArray(value: string): readonly string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string'))
    invalid();
  return parsed;
}

export function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBudget(value: unknown): value is Budget {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      'preset',
      'maxOutputBytes',
      'minimumImageLongestEdge',
      'imageQuality',
      'estimatorVersion',
    ]) &&
    typeof value.preset === 'string' &&
    BUDGET_PRESETS.has(value.preset) &&
    isNonNegativeInteger(value.maxOutputBytes) &&
    isNonNegativeInteger(value.minimumImageLongestEdge) &&
    typeof value.imageQuality === 'number' &&
    Number.isFinite(value.imageQuality) &&
    value.imageQuality >= 0 &&
    value.imageQuality <= 1 &&
    typeof value.estimatorVersion === 'string' &&
    SAFE_VERSION.test(value.estimatorVersion)
  );
}

function isProcessorVersion(value: unknown): value is ProcessorVersion {
  if (!isRecord(value)) return false;
  const allowed = [
    'processor',
    'version',
    'contractVersion',
    'engine',
    'engineRevision',
  ];
  return (
    Object.keys(value).every(key => allowed.includes(key)) &&
    typeof value.processor === 'string' &&
    SAFE_VERSION.test(value.processor) &&
    typeof value.version === 'string' &&
    SAFE_VERSION.test(value.version) &&
    isPositiveInteger(value.contractVersion) &&
    (value.engine === undefined ||
      (typeof value.engine === 'string' && SAFE_VERSION.test(value.engine))) &&
    (value.engineRevision === undefined ||
      (typeof value.engineRevision === 'string' &&
        SAFE_VERSION.test(value.engineRevision)))
  );
}

function isFindingLocation(value: unknown): value is FindingLocation {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'text-range')
    return (
      exactKeys(value, ['kind', 'start', 'length']) &&
      isNonNegativeInteger(value.start) &&
      isPositiveInteger(value.length)
    );
  const { x, y, width, height } = value;
  return (
    value.kind === 'image-region' &&
    exactKeys(value, ['kind', 'x', 'y', 'width', 'height']) &&
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1 &&
    y + height <= 1
  );
}

function isUniqueCanonicalIdArray(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every(isCanonicalUuid) &&
    new Set(value).size === value.length
  );
}

function isSafeCodeArray(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every(item => SAFE_CODE.test(item)) &&
    new Set(value).size === value.length
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    invalid();
  }
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

function invalid(): never {
  throw new DomainError('SCHEMA_INVALID');
}
