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
  | 'SHARE_COPY_FAILED';
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
]);
const allowedEngines = new Set<SafeEngine>([
  'apple-vision',
  'ml-kit-latin',
  'ml-kit-chinese',
  'pdfkit',
  'pdf-renderer',
]);
const allowedKey = /^(code|count|bytes|durationMs|version|engine|anonymousId)$/;
const versionPattern = /^[0-9]+(?:\.[0-9]+){0,3}$/;
const anonymousIdPattern =
  /^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function safeLog(event: SafeLogEvent, fields: SafeLogFields = {}): void {
  if (!allowedEvents.has(event)) throw new Error('UNSAFE_LOG_EVENT');
  const record = fields as Readonly<Record<string, unknown>>;
  const invalid = Object.keys(record).find(key => !allowedKey.test(key));
  if (invalid) throw new Error(`UNSAFE_LOG_FIELD:${invalid}`);
  if (fields.code !== undefined && !allowedCodes.has(fields.code))
    throw new Error('UNSAFE_LOG_VALUE:code');
  if (fields.engine !== undefined && !allowedEngines.has(fields.engine))
    throw new Error('UNSAFE_LOG_VALUE:engine');
  if (
    fields.version !== undefined &&
    (fields.version.length > 32 || !versionPattern.test(fields.version))
  )
    throw new Error('UNSAFE_LOG_VALUE:version');
  if (
    fields.anonymousId !== undefined &&
    !anonymousIdPattern.test(fields.anonymousId)
  )
    throw new Error('UNSAFE_LOG_VALUE:anonymousId');
  for (const key of ['count', 'bytes', 'durationMs'] as const) {
    const value = fields[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error(`UNSAFE_LOG_VALUE:${key}`);
  }
  console.info('[AIContextPack]', { event, ...fields });
}
