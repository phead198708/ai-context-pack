import { DomainError } from './errors';
import { isValidUnicodeScalarString, utf8ByteCount } from './mainAppImport';

export const PLAIN_TEXT_MAXIMUM_BYTES = 1_048_576;
export const URL_MAXIMUM_BYTES = 65_536;

export type TextNormalizationWarningV1 =
  | 'TEXT_BOM_REMOVED'
  | 'TEXT_LINE_ENDINGS_NORMALIZED'
  | 'TEXT_UNSAFE_CONTROL_REPLACED';

export interface PlainTextExtractionV1 {
  readonly schemaVersion: 1;
  readonly kind: 'plain-text';
  readonly text: string;
  /** UTF-16 code units, matching the PDF page contract. */
  readonly characterCount: number;
  readonly sourceByteCount: number;
  readonly encoding: 'utf-8';
  readonly warnings: readonly TextNormalizationWarningV1[];
}

export type URLExtractionWarningV1 =
  | 'URL_CREDENTIAL_REDACTED'
  | 'URL_QUERY_VALUES_REDACTED'
  | 'URL_FRAGMENT_REDACTED';

export interface URLShareMetadataV1 {
  readonly title?: string;
  readonly selectedText?: string;
}

export interface URLExtractionV1 {
  readonly schemaVersion: 1;
  readonly kind: 'url';
  /** Exact validated input; it must never be used for normal display/logging. */
  readonly originalUrl: string;
  readonly displayUrl: string;
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly path: string;
  readonly title?: PlainTextExtractionV1;
  readonly selectedText?: PlainTextExtractionV1;
  readonly warnings: readonly URLExtractionWarningV1[];
}

function isUnsafeControlCodeUnit(code: number): boolean {
  return (
    code <= 0x0008 ||
    code === 0x000b ||
    code === 0x000c ||
    (code >= 0x000e && code <= 0x001f) ||
    (code >= 0x007f && code <= 0x009f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function containsUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isUnsafeControlCodeUnit(value.charCodeAt(index))) return true;
  }
  return false;
}

function replaceUnsafeControls(value: string): string {
  let result = '';
  let safeStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!isUnsafeControlCodeUnit(value.charCodeAt(index))) continue;
    result += `${value.slice(safeStart, index)}\uFFFD`;
    safeStart = index + 1;
  }
  return safeStart === 0 ? value : result + value.slice(safeStart);
}

export function normalizePlainText(
  source: string,
  sourceByteCount?: number,
): PlainTextExtractionV1 {
  if (typeof source !== 'string' || !isValidUnicodeScalarString(source))
    throw new DomainError('TEXT_INVALID_UTF8');
  const actualByteCount = utf8ByteCount(source);
  const declaredByteCount = sourceByteCount ?? actualByteCount;
  if (
    !Number.isSafeInteger(declaredByteCount) ||
    declaredByteCount < 0 ||
    declaredByteCount > PLAIN_TEXT_MAXIMUM_BYTES ||
    actualByteCount !== declaredByteCount
  )
    throw new DomainError(
      declaredByteCount > PLAIN_TEXT_MAXIMUM_BYTES
        ? 'TEXT_TOO_LARGE'
        : 'TEXT_INVALID_UTF8',
    );

  const warnings: TextNormalizationWarningV1[] = [];
  let text = source;
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
    warnings.push('TEXT_BOM_REMOVED');
  }
  if (text.includes('\r')) {
    text = text.replace(/\r\n?/g, '\n');
    warnings.push('TEXT_LINE_ENDINGS_NORMALIZED');
  }
  if (containsUnsafeControl(text)) {
    text = replaceUnsafeControls(text);
    warnings.push('TEXT_UNSAFE_CONTROL_REPLACED');
  }

  return {
    schemaVersion: 1,
    kind: 'plain-text',
    text,
    characterCount: text.length,
    sourceByteCount: declaredByteCount,
    encoding: 'utf-8',
    warnings,
  };
}

export function extractURL(
  originalUrl: string,
  metadata: URLShareMetadataV1 = {},
): URLExtractionV1 {
  if (
    typeof originalUrl !== 'string' ||
    originalUrl.length === 0 ||
    originalUrl !== originalUrl.trim() ||
    !isValidUnicodeScalarString(originalUrl)
  )
    throw new DomainError('URL_INVALID');
  if (utf8ByteCount(originalUrl) > URL_MAXIMUM_BYTES)
    throw new DomainError('URL_TOO_LONG');
  if (containsUnsafeControl(originalUrl) || /[\r\n\t]/.test(originalUrl)) {
    throw new DomainError('URL_INVALID');
  }

  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    throw new DomainError('URL_INVALID');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0
  )
    throw new DomainError('URL_INVALID');

  const warnings: URLExtractionWarningV1[] = [];
  const authority =
    parsed.username.length > 0 || parsed.password.length > 0
      ? (() => {
          warnings.push('URL_CREDENTIAL_REDACTED');
          return `[REDACTED]@${parsed.host}`;
        })()
      : parsed.host;
  const query = [...parsed.searchParams.keys()];
  const queryDisplay = query.length
    ? `?${query.map(key => `${encodeURIComponent(key)}=[REDACTED]`).join('&')}`
    : '';
  if (query.length > 0) warnings.push('URL_QUERY_VALUES_REDACTED');
  const fragment = parsed.hash.length > 0 ? '#[REDACTED]' : '';
  if (fragment.length > 0) warnings.push('URL_FRAGMENT_REDACTED');
  const displayUrl = `${parsed.protocol}//${authority}${parsed.pathname}${queryDisplay}${fragment}`;

  return {
    schemaVersion: 1,
    kind: 'url',
    originalUrl,
    displayUrl,
    scheme: parsed.protocol === 'https:' ? 'https' : 'http',
    host: parsed.host,
    path: parsed.pathname,
    ...(metadata.title === undefined
      ? {}
      : { title: normalizePlainText(metadata.title) }),
    ...(metadata.selectedText === undefined
      ? {}
      : { selectedText: normalizePlainText(metadata.selectedText) }),
    warnings,
  };
}

export function isPlainTextExtractionV1(
  value: unknown,
): value is PlainTextExtractionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 7 &&
    result.schemaVersion === 1 &&
    result.kind === 'plain-text' &&
    typeof result.text === 'string' &&
    isValidUnicodeScalarString(result.text) &&
    !result.text.startsWith('\uFEFF') &&
    !result.text.includes('\r') &&
    !containsUnsafeControl(result.text) &&
    result.characterCount === result.text.length &&
    Number.isSafeInteger(result.sourceByteCount) &&
    (result.sourceByteCount as number) >= 0 &&
    (result.sourceByteCount as number) <= PLAIN_TEXT_MAXIMUM_BYTES &&
    result.text.length <= (result.sourceByteCount as number) &&
    result.encoding === 'utf-8' &&
    Array.isArray(result.warnings) &&
    result.warnings.every(
      warning =>
        warning === 'TEXT_BOM_REMOVED' ||
        warning === 'TEXT_LINE_ENDINGS_NORMALIZED' ||
        warning === 'TEXT_UNSAFE_CONTROL_REPLACED',
    ) &&
    new Set(result.warnings).size === result.warnings.length
  );
}
