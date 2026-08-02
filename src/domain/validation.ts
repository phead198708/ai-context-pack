import type {
  ImportManifestV1,
  NormalizedBoundsV1,
  OCRResultV1,
  PDFProbeResultV1,
} from './contracts';
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isOwnedInboxFileUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const inboxIndex = segments.lastIndexOf('Inbox');
    return (
      url.protocol === 'file:' &&
      url.hostname === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      inboxIndex >= 0 &&
      segments.length >= inboxIndex + 3 &&
      !segments.some(segment => segment === '.' || segment === '..')
    );
  } catch {
    return false;
  }
}
export function isNormalizedBoundsV1(
  value: unknown,
): value is NormalizedBoundsV1 {
  if (!isObject(value)) return false;
  const componentsValid = ['x', 'y', 'width', 'height'].every(
    key =>
      typeof value[key] === 'number' &&
      (value[key] as number) >= 0 &&
      (value[key] as number) <= 1,
  );
  return (
    componentsValid &&
    (value.x as number) + (value.width as number) <= 1.000_001 &&
    (value.y as number) + (value.height as number) <= 1.000_001
  );
}
export function isImportManifestV1(value: unknown): value is ImportManifestV1 {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.items)
  )
    return false;
  return (
    typeof value.ingestionId === 'string' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.source === 'ios-share-extension' ||
      value.source === 'android-share-intent') &&
    (value.status === 'complete' ||
      value.status === 'partial' ||
      value.status === 'failed') &&
    value.items.every(
      item =>
        isObject(item) &&
        typeof item.id === 'string' &&
        typeof item.mediaType === 'string' &&
        /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
          item.mediaType,
        ) &&
        Number.isSafeInteger(item.byteCount) &&
        (item.byteCount as number) >= 0 &&
        isOwnedInboxFileUri(item.localUri) &&
        (item.status === 'copied' || item.status === 'failed'),
    )
  );
}
export function isOCRResultV1(value: unknown): value is OCRResultV1 {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.blocks)
  )
    return false;
  return (
    typeof value.text === 'string' &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.engine === 'apple-vision' ||
      value.engine === 'ml-kit-latin' ||
      value.engine === 'ml-kit-chinese') &&
    typeof value.revision === 'string' &&
    value.blocks.every(
      block =>
        isObject(block) &&
        typeof block.text === 'string' &&
        isNormalizedBoundsV1(block.bounds) &&
        (block.confidence === undefined ||
          (typeof block.confidence === 'number' &&
            Number.isFinite(block.confidence) &&
            block.confidence >= 0 &&
            block.confidence <= 1)) &&
        (block.language === undefined || typeof block.language === 'string'),
    )
  );
}

export function isPDFProbeResultV1(value: unknown): value is PDFProbeResultV1 {
  if (!isObject(value) || !isObject(value.limit)) return false;
  return (
    Number.isInteger(value.pageCount) &&
    (value.pageCount as number) >= 0 &&
    Number.isInteger(value.embeddedTextPages) &&
    (value.embeddedTextPages as number) >= 0 &&
    Number.isInteger(value.renderedFallbackPages) &&
    (value.renderedFallbackPages as number) >= 0 &&
    (value.embeddedTextPages as number) +
      (value.renderedFallbackPages as number) ===
      value.pageCount &&
    (value.engine === 'pdfkit' || value.engine === 'pdf-renderer') &&
    value.limit.pages === 25 &&
    value.limit.bytes === 52_428_800
  );
}
