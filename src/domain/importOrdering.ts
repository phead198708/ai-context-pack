import type { ImportManifestV1 } from './contracts';

export function newestManifestsFirst(
  manifests: readonly ImportManifestV1[],
): readonly ImportManifestV1[] {
  return [...manifests].sort((left, right) => {
    const timeDifference =
      Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return timeDifference || right.ingestionId.localeCompare(left.ingestionId);
  });
}
