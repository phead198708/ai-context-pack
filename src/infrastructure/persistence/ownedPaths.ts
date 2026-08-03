import { isCanonicalUuid } from '../../domain/canonicalUuid';

const OWNED_AREAS = new Set(['originals', 'derived', 'exports', 'previews']);
const SAFE_LEAF = /^[0-9a-f-]{36}\.(?:bin|jpg|png|pdf|txt|json|md|zip)$/;

export function ownedOriginalPath(packId: string, itemId: string): string {
  requireCanonicalId(packId);
  requireCanonicalId(itemId);
  return `Packs/${packId}/originals/${itemId}.bin`;
}

export function isOwnedArtifactPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('%') ||
    value.split('/').some(segment => segment === '' || segment === '..')
  )
    return false;
  const segments = value.split('/');
  if (segments.length !== 4 || segments[0] !== 'Packs') return false;
  const packId = segments[1];
  const area = segments[2];
  const leaf = segments[3];
  if (!packId || !area || !leaf) return false;
  const leafId = leaf.slice(0, 36);
  return (
    isCanonicalUuid(packId) &&
    OWNED_AREAS.has(area) &&
    SAFE_LEAF.test(leaf) &&
    isCanonicalUuid(leafId)
  );
}

export function assertOwnedArtifactPath(value: string): void {
  if (!isOwnedArtifactPath(value)) throw new Error('OWNED_PATH_INVALID');
}

export function ownedArtifactPackId(value: string): string | null {
  if (!isOwnedArtifactPath(value)) return null;
  return value.split('/')[1] ?? null;
}

function requireCanonicalId(value: string): void {
  if (!isCanonicalUuid(value)) throw new Error('IDENTIFIER_INVALID');
}
