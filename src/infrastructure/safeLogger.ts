export type SafeLogEvent =
  | 'inbox_scan'
  | 'import_completed'
  | 'import_failed'
  | 'ocr_completed'
  | 'pdf_probe_completed';

export type SafeErrorCode =
  | 'INBOX_SCAN_FAILED'
  | 'NATIVE_ADAPTER_UNAVAILABLE'
  | 'NATIVE_MANIFEST_INVALID'
  | 'NATIVE_OCR_RESULT_INVALID'
  | 'NATIVE_PDF_RESULT_INVALID'
  | 'OCR_IMAGE_DECODE_FAILED'
  | 'OCR_RECOGNITION_FAILED'
  | 'SHARE_COPY_FAILED'
  | 'SHARE_IMPORT_FAILED'
  | 'SHARE_IMPORT_EVENT_INVALID';

export type SafeEngine =
  | 'apple-vision'
  | 'ml-kit-latin'
  | 'ml-kit-chinese'
  | 'pdfkit'
  | 'pdf-renderer';

export interface SafeLogFields {
  readonly code?: SafeErrorCode;
  readonly count?: number;
  readonly bytes?: number;
  readonly durationMs?: number;
  readonly version?: string;
  readonly engine?: SafeEngine;
  readonly anonymousId?: string;
}

export type SafeLogSink = (serializedRecord: string) => void;

const allowedEvents = new Set<SafeLogEvent>([
  'inbox_scan',
  'import_completed',
  'import_failed',
  'ocr_completed',
  'pdf_probe_completed',
]);
const allowedCodes = new Set<SafeErrorCode>([
  'INBOX_SCAN_FAILED',
  'NATIVE_ADAPTER_UNAVAILABLE',
  'NATIVE_MANIFEST_INVALID',
  'NATIVE_OCR_RESULT_INVALID',
  'NATIVE_PDF_RESULT_INVALID',
  'OCR_IMAGE_DECODE_FAILED',
  'OCR_RECOGNITION_FAILED',
  'SHARE_COPY_FAILED',
  'SHARE_IMPORT_FAILED',
  'SHARE_IMPORT_EVENT_INVALID',
]);
const allowedEngines = new Set<SafeEngine>([
  'apple-vision',
  'ml-kit-latin',
  'ml-kit-chinese',
  'pdfkit',
  'pdf-renderer',
]);
const allowedKeys = new Set<keyof SafeLogFields>([
  'code',
  'count',
  'bytes',
  'durationMs',
  'version',
  'engine',
  'anonymousId',
]);
const versionPattern = /^[0-9]+(?:\.[0-9]+){0,3}$/;
const anonymousIdPattern =
  /^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function assertPlainFields(
  fields: unknown,
): asserts fields is Record<string, unknown> {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('UNSAFE_LOG_FIELDS');
  }
  const prototype = Object.getPrototypeOf(fields) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('UNSAFE_LOG_FIELDS');
  }
  for (const key of Reflect.ownKeys(fields)) {
    if (
      typeof key !== 'string' ||
      !allowedKeys.has(key as keyof SafeLogFields)
    ) {
      throw new Error(`UNSAFE_LOG_FIELD:${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error(`UNSAFE_LOG_FIELD:${key}`);
    }
  }
}

function optionalString(
  fields: Record<string, unknown>,
  key: 'code' | 'version' | 'engine' | 'anonymousId',
): string | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`UNSAFE_LOG_VALUE:${key}`);
  return value;
}

function optionalNumber(
  fields: Record<string, unknown>,
  key: 'count' | 'bytes' | 'durationMs',
): number | undefined {
  const value = fields[key];
  if (
    value === undefined ||
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    ((key === 'count' || key === 'bytes') && !Number.isInteger(value))
  ) {
    if (value === undefined) return undefined;
    throw new Error(`UNSAFE_LOG_VALUE:${key}`);
  }
  return value;
}

export function serializeSafeLog(event: unknown, fields: unknown = {}): string {
  if (typeof event !== 'string' || !allowedEvents.has(event as SafeLogEvent)) {
    throw new Error('UNSAFE_LOG_EVENT');
  }
  assertPlainFields(fields);

  const code = optionalString(fields, 'code');
  if (code !== undefined && !allowedCodes.has(code as SafeErrorCode)) {
    throw new Error('UNSAFE_LOG_VALUE:code');
  }
  const engine = optionalString(fields, 'engine');
  if (engine !== undefined && !allowedEngines.has(engine as SafeEngine)) {
    throw new Error('UNSAFE_LOG_VALUE:engine');
  }
  const version = optionalString(fields, 'version');
  if (
    version !== undefined &&
    (version.length > 32 || !versionPattern.test(version))
  ) {
    throw new Error('UNSAFE_LOG_VALUE:version');
  }
  const anonymousId = optionalString(fields, 'anonymousId');
  if (anonymousId !== undefined && !anonymousIdPattern.test(anonymousId)) {
    throw new Error('UNSAFE_LOG_VALUE:anonymousId');
  }

  const count = optionalNumber(fields, 'count');
  const bytes = optionalNumber(fields, 'bytes');
  const durationMs = optionalNumber(fields, 'durationMs');
  const record: Record<string, string | number> = { event };
  if (code !== undefined) record.code = code;
  if (count !== undefined) record.count = count;
  if (bytes !== undefined) record.bytes = bytes;
  if (durationMs !== undefined) record.durationMs = durationMs;
  if (version !== undefined) record.version = version;
  if (engine !== undefined) record.engine = engine;
  if (anonymousId !== undefined) record.anonymousId = anonymousId;
  return JSON.stringify(record);
}

const consoleSink: SafeLogSink = serializedRecord => {
  console.info('[AIContextPack]', serializedRecord);
};

export function safeLog(
  event: SafeLogEvent,
  fields: SafeLogFields = {},
  sink: SafeLogSink = consoleSink,
): void {
  sink(serializeSafeLog(event, fields));
}
