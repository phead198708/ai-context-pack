import {
  decodeVersionedContract,
  type ContractDecodeResult,
} from './compatibility';
import type {
  ExportManifestV1,
  ImportItemV1,
  ImportManifestV1,
  NormalizedBoundsV1,
  OCRCapabilitiesV1,
  OCRBlockV1,
  OCRResultV1,
  PDFPageExtractionV1,
  PDFProbeResultV1,
  PipelineCheckpointV1,
  RiskFindingV1,
} from './contracts';
import { DOMAIN_ERROR_CATALOG, type DomainErrorCode } from './errors';
import { isCanonicalUuid } from './canonicalUuid';

const mediaTypePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const isoDateTimePattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/;
const safeRelativePathPattern =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

export const IMPORT_MANIFEST_MAX_ITEMS = 128;
export const IMPORT_MANIFEST_MAX_MEDIA_TYPE_LENGTH = 127;
export const IMPORT_MANIFEST_MAX_RETRY_BYTES = 52_428_800;
export const OCR_RESULT_MAX_BLOCKS = 10_000;
export const OCR_RESULT_MAX_TEXT_LENGTH = 1_000_000;
export const OCR_RESULT_MAX_BLOCK_TEXT_LENGTH = 100_000;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  );
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !isoDateTimePattern.test(value))
    return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isMediaType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= IMPORT_MANIFEST_MAX_MEDIA_TYPE_LENGTH &&
    mediaTypePattern.test(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value);
}

export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !safeRelativePathPattern.test(value))
    return false;
  return value.split('/').every(segment => segment !== '.' && segment !== '..');
}

function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DOMAIN_ERROR_CATALOG, value)
  );
}

export function isNormalizedBoundsV1(
  value: unknown,
): value is NormalizedBoundsV1 {
  if (!record(value) || !hasOnlyKeys(value, ['x', 'y', 'width', 'height']))
    return false;
  const componentsValid = ['x', 'y', 'width', 'height'].every(
    key =>
      typeof value[key] === 'number' &&
      Number.isFinite(value[key]) &&
      (value[key] as number) >= 0 &&
      (value[key] as number) <= 1,
  );
  return (
    componentsValid &&
    (value.x as number) + (value.width as number) <= 1.000_001 &&
    (value.y as number) + (value.height as number) <= 1.000_001
  );
}

function isOCRBlockV1(value: unknown): value is OCRBlockV1 {
  return (
    record(value) &&
    hasOnlyKeys(value, ['text', 'bounds'], ['confidence', 'language']) &&
    isNonEmptyString(value.text) &&
    value.text.length <= OCR_RESULT_MAX_BLOCK_TEXT_LENGTH &&
    isNormalizedBoundsV1(value.bounds) &&
    (value.confidence === undefined ||
      (typeof value.confidence === 'number' &&
        Number.isFinite(value.confidence) &&
        value.confidence >= 0 &&
        value.confidence <= 1)) &&
    (value.language === undefined || isNonEmptyString(value.language))
  );
}

function isCopiedImportItemV1(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ImportItemV1 {
  return (
    hasOnlyKeys(
      value,
      ['id', 'order', 'mediaType', 'status', 'byteCount', 'relativePath'],
      ['sha256'],
    ) &&
    value.status === 'copied' &&
    isCanonicalUuid(value.id) &&
    isNonNegativeInteger(value.order) &&
    isMediaType(value.mediaType) &&
    isNonNegativeInteger(value.byteCount) &&
    isSafeRelativePath(value.relativePath) &&
    value.relativePath === `${value.id}.bin` &&
    (value.sha256 === undefined || isSha256(value.sha256))
  );
}

function isFailedImportItemV1(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ImportItemV1 {
  return (
    hasOnlyKeys(
      value,
      ['id', 'order', 'mediaType', 'status', 'byteCount', 'errorCode'],
      ['retryByteCount', 'retrySha256'],
    ) &&
    value.status === 'failed' &&
    isCanonicalUuid(value.id) &&
    isNonNegativeInteger(value.order) &&
    isMediaType(value.mediaType) &&
    value.byteCount === 0 &&
    isDomainErrorCode(value.errorCode) &&
    ((value.retryByteCount === undefined && value.retrySha256 === undefined) ||
      (isNonNegativeInteger(value.retryByteCount) &&
        value.retryByteCount <= IMPORT_MANIFEST_MAX_RETRY_BYTES &&
        isSha256(value.retrySha256)))
  );
}

function isImportItemV1(value: unknown): value is ImportItemV1 {
  return (
    record(value) &&
    (isCopiedImportItemV1(value) || isFailedImportItemV1(value))
  );
}

export function isImportManifestV1(value: unknown): value is ImportManifestV1 {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'ingestionId',
      'createdAt',
      'source',
      'status',
      'items',
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalUuid(value.ingestionId) ||
    !isIsoDateTime(value.createdAt) ||
    (value.source !== 'ios-share-extension' &&
      value.source !== 'android-share-intent' &&
      value.source !== 'main-app-picker' &&
      value.source !== 'main-app-text') ||
    (value.status !== 'complete' &&
      value.status !== 'partial' &&
      value.status !== 'failed') ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > IMPORT_MANIFEST_MAX_ITEMS ||
    !value.items.every(isImportItemV1)
  )
    return false;

  const items = value.items as readonly ImportItemV1[];
  if (
    items.some((item, index) => item.order !== index) ||
    new Set(items.map(item => item.id)).size !== items.length
  )
    return false;

  const copied = items.filter(item => item.status === 'copied').length;
  const failed = items.length - copied;
  return (
    (value.status === 'complete' && copied > 0 && failed === 0) ||
    (value.status === 'partial' && copied > 0 && failed > 0) ||
    (value.status === 'failed' && copied === 0 && failed > 0)
  );
}

export function decodeImportManifestV1(
  value: unknown,
): ContractDecodeResult<ImportManifestV1> {
  return decodeVersionedContract('importManifest', value, isImportManifestV1);
}

export function isOCRResultV1(value: unknown): value is OCRResultV1 {
  if (
    !record(value) ||
    !hasOnlyKeys(
      value,
      ['schemaVersion', 'text', 'blocks', 'durationMs', 'engine', 'revision'],
      ['recognitionLevel', 'warnings'],
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.text !== 'string' ||
    value.text.length > OCR_RESULT_MAX_TEXT_LENGTH ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > OCR_RESULT_MAX_BLOCKS ||
    !value.blocks.every(isOCRBlockV1) ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    (value.engine !== 'apple-vision' &&
      value.engine !== 'ml-kit-latin' &&
      value.engine !== 'ml-kit-chinese') ||
    !isNonEmptyString(value.revision) ||
    (value.recognitionLevel !== undefined &&
      value.recognitionLevel !== 'accurate' &&
      value.recognitionLevel !== 'fast') ||
    (value.warnings !== undefined &&
      (!Array.isArray(value.warnings) ||
        value.warnings.some(
          warning =>
            warning !== 'OCR_LANGUAGE_FALLBACK' &&
            warning !== 'OCR_LOW_CONFIDENCE',
        ) ||
        new Set(value.warnings).size !== value.warnings.length))
  )
    return false;
  return true;
}

export function isOCRCapabilitiesV1(
  value: unknown,
): value is OCRCapabilitiesV1 {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'engines',
      'maximumPixelCount',
      'maximumDimension',
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.engines) ||
    value.engines.length === 0 ||
    value.engines.length > 3 ||
    !isNonNegativeInteger(value.maximumPixelCount) ||
    value.maximumPixelCount === 0 ||
    !isNonNegativeInteger(value.maximumDimension) ||
    value.maximumDimension === 0
  )
    return false;
  const engines = value.engines;
  if (
    new Set(engines.map(engine => (record(engine) ? engine.engine : undefined)))
      .size !== engines.length
  )
    return false;
  return engines.every(
    engine =>
      record(engine) &&
      hasOnlyKeys(engine, [
        'engine',
        'revision',
        'scripts',
        'recognitionLevels',
        'ready',
        'offline',
      ]) &&
      (engine.engine === 'apple-vision' ||
        engine.engine === 'ml-kit-latin' ||
        engine.engine === 'ml-kit-chinese') &&
      isNonEmptyString(engine.revision) &&
      Array.isArray(engine.scripts) &&
      engine.scripts.every(
        script => script === 'latin' || script === 'chinese',
      ) &&
      new Set(engine.scripts).size === engine.scripts.length &&
      Array.isArray(engine.recognitionLevels) &&
      engine.recognitionLevels.length > 0 &&
      engine.recognitionLevels.every(
        level => level === 'accurate' || level === 'fast',
      ) &&
      new Set(engine.recognitionLevels).size ===
        engine.recognitionLevels.length &&
      typeof engine.ready === 'boolean' &&
      engine.offline === true,
  );
}

export function decodeOCRResultV1(
  value: unknown,
): ContractDecodeResult<OCRResultV1> {
  return decodeVersionedContract('ocrResult', value, isOCRResultV1);
}

export function isPDFPageExtractionV1(
  value: unknown,
): value is PDFPageExtractionV1 {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !isNonNegativeInteger(value.pageIndex) ||
    (value.method !== 'embedded-text' && value.method !== 'rendered-ocr') ||
    (value.engine !== 'pdfkit' &&
      value.engine !== 'pdf-renderer' &&
      value.engine !== 'apple-vision' &&
      value.engine !== 'ml-kit') ||
    !isNonEmptyString(value.revision) ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  )
    return false;

  if (value.status === 'complete') {
    return (
      hasOnlyKeys(value, [
        'schemaVersion',
        'pageIndex',
        'method',
        'engine',
        'revision',
        'durationMs',
        'status',
        'text',
        'blocks',
      ]) &&
      typeof value.text === 'string' &&
      Array.isArray(value.blocks) &&
      value.blocks.every(isOCRBlockV1)
    );
  }
  return (
    value.status === 'failed' &&
    hasOnlyKeys(value, [
      'schemaVersion',
      'pageIndex',
      'method',
      'engine',
      'revision',
      'durationMs',
      'status',
      'errorCode',
    ]) &&
    isDomainErrorCode(value.errorCode)
  );
}

export function decodePDFPageExtractionV1(
  value: unknown,
): ContractDecodeResult<PDFPageExtractionV1> {
  return decodeVersionedContract(
    'pdfPageExtraction',
    value,
    isPDFPageExtractionV1,
  );
}

const pipelineStages = new Set([
  'import',
  'extract',
  'analyze',
  'review',
  'package',
]);

export function isPipelineCheckpointV1(
  value: unknown,
): value is PipelineCheckpointV1 {
  if (
    !record(value) ||
    !hasOnlyKeys(
      value,
      [
        'schemaVersion',
        'id',
        'runId',
        'packId',
        'stage',
        'reason',
        'resumeAction',
        'completedArtifactIds',
        'processor',
        'processorVersion',
        'updatedAt',
      ],
      ['itemId', 'errorCode'],
    ) ||
    value.schemaVersion !== 1 ||
    !isCanonicalUuid(value.id) ||
    !isCanonicalUuid(value.runId) ||
    !isCanonicalUuid(value.packId) ||
    (value.itemId !== undefined && !isCanonicalUuid(value.itemId)) ||
    typeof value.stage !== 'string' ||
    !pipelineStages.has(value.stage) ||
    !Array.isArray(value.completedArtifactIds) ||
    !value.completedArtifactIds.every(isCanonicalUuid) ||
    new Set(value.completedArtifactIds).size !==
      value.completedArtifactIds.length ||
    !isNonEmptyString(value.processor) ||
    !isNonEmptyString(value.processorVersion) ||
    !isIsoDateTime(value.updatedAt) ||
    (value.errorCode !== undefined && !isDomainErrorCode(value.errorCode))
  )
    return false;

  return (
    ((value.reason === 'periodic' || value.reason === 'backgrounded') &&
      value.resumeAction === 'continue' &&
      value.errorCode === undefined) ||
    (value.reason === 'cancelled' &&
      value.resumeAction === 'retry-stage' &&
      value.errorCode === undefined) ||
    (value.reason === 'stage-failure' &&
      value.resumeAction === 'retry-stage' &&
      value.errorCode !== undefined) ||
    (value.reason === 'recovery' &&
      value.resumeAction === 'recover-stage' &&
      value.errorCode !== undefined)
  );
}

export function decodePipelineCheckpointV1(
  value: unknown,
): ContractDecodeResult<PipelineCheckpointV1> {
  return decodeVersionedContract(
    'pipelineCheckpoint',
    value,
    isPipelineCheckpointV1,
  );
}

const riskCategories = new Set([
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

function isFindingLocationV1(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.kind === 'text-range') {
    return (
      hasOnlyKeys(value, ['kind', 'start', 'length']) &&
      isNonNegativeInteger(value.start) &&
      Number.isSafeInteger(value.length) &&
      (value.length as number) > 0
    );
  }
  if (value.kind !== 'image-region') return false;
  if (!hasOnlyKeys(value, ['kind', 'x', 'y', 'width', 'height'])) return false;
  const bounds: unknown = {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
  return isNormalizedBoundsV1(bounds) && bounds.width > 0 && bounds.height > 0;
}

export function isRiskFindingV1(value: unknown): value is RiskFindingV1 {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      'schemaVersion',
      'id',
      'itemId',
      'detector',
      'detectorVersion',
      'category',
      'severity',
      'confidence',
      'location',
      'decision',
    ]) &&
    value.schemaVersion === 1 &&
    isCanonicalUuid(value.id) &&
    isCanonicalUuid(value.itemId) &&
    isNonEmptyString(value.detector) &&
    isNonEmptyString(value.detectorVersion) &&
    typeof value.category === 'string' &&
    riskCategories.has(value.category) &&
    (value.severity === 'low' ||
      value.severity === 'medium' ||
      value.severity === 'high') &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    isFindingLocationV1(value.location) &&
    (value.decision === 'pending' ||
      value.decision === 'keep' ||
      value.decision === 'redact')
  );
}

export function decodeRiskFindingV1(
  value: unknown,
): ContractDecodeResult<RiskFindingV1> {
  return decodeVersionedContract('riskFinding', value, isRiskFindingV1);
}

const exportFormats = new Set([
  'markdown',
  'pdf',
  'attachment-bundle',
  'clipboard',
]);

function isExportArtifactV1(value: unknown): boolean {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      'id',
      'kind',
      'relativePath',
      'mediaType',
      'byteCount',
      'sha256',
    ]) &&
    isCanonicalUuid(value.id) &&
    (value.kind === 'markdown' ||
      value.kind === 'pdf' ||
      value.kind === 'attachment') &&
    isSafeRelativePath(value.relativePath) &&
    isMediaType(value.mediaType) &&
    isNonNegativeInteger(value.byteCount) &&
    isSha256(value.sha256)
  );
}

export function isExportManifestV1(value: unknown): value is ExportManifestV1 {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'exportId',
      'packId',
      'createdAt',
      'format',
      'artifacts',
      'privacyReview',
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalUuid(value.exportId) ||
    !isCanonicalUuid(value.packId) ||
    !isIsoDateTime(value.createdAt) ||
    typeof value.format !== 'string' ||
    !exportFormats.has(value.format) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    !value.artifacts.every(isExportArtifactV1) ||
    !record(value.privacyReview) ||
    !hasOnlyKeys(value.privacyReview, ['status', 'decisionSetSha256']) ||
    value.privacyReview.status !== 'complete' ||
    !isSha256(value.privacyReview.decisionSetSha256)
  )
    return false;

  const artifacts = value.artifacts as readonly {
    readonly id: string;
    readonly relativePath: string;
  }[];
  return (
    new Set(artifacts.map(artifact => artifact.id)).size === artifacts.length &&
    new Set(artifacts.map(artifact => artifact.relativePath)).size ===
      artifacts.length
  );
}

export function decodeExportManifestV1(
  value: unknown,
): ContractDecodeResult<ExportManifestV1> {
  return decodeVersionedContract('exportManifest', value, isExportManifestV1);
}

export function isPDFProbeResultV1(value: unknown): value is PDFProbeResultV1 {
  if (!record(value) || !record(value.limit)) return false;
  return (
    isNonNegativeInteger(value.pageCount) &&
    isNonNegativeInteger(value.embeddedTextPages) &&
    isNonNegativeInteger(value.renderedFallbackPages) &&
    (value.embeddedTextPages as number) +
      (value.renderedFallbackPages as number) ===
      value.pageCount &&
    (value.engine === 'pdfkit' || value.engine === 'pdf-renderer') &&
    value.limit.pages === 25 &&
    value.limit.bytes === 52_428_800
  );
}
