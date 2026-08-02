import type {
  ImportManifestV1,
  NormalizedBoundsV1,
  OCRResultV1,
} from './contracts';
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
export function isNormalizedBoundsV1(
  value: unknown,
): value is NormalizedBoundsV1 {
  if (!isObject(value)) return false;
  return ['x', 'y', 'width', 'height'].every(
    key =>
      typeof value[key] === 'number' &&
      (value[key] as number) >= 0 &&
      (value[key] as number) <= 1,
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
        typeof item.byteCount === 'number' &&
        typeof item.localUri === 'string' &&
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
    typeof value.engine === 'string' &&
    typeof value.revision === 'string' &&
    value.blocks.every(
      block =>
        isObject(block) &&
        typeof block.text === 'string' &&
        isNormalizedBoundsV1(block.bounds),
    )
  );
}
