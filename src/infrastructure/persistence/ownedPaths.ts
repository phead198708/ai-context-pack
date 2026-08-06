import { isCanonicalUuid } from '../../domain/canonicalUuid';

const OWNED_AREAS = new Set(['originals', 'derived', 'exports', 'previews']);
const CONTROLLED_EXTENSIONS = new Set([
  'bin',
  'heic',
  'jpeg',
  'jpg',
  'json',
  'md',
  'pdf',
  'png',
  'txt',
  'zip',
]);
const SAFE_LEAF =
  /^[0-9a-f-]{36}\.(?:bin|heic|jpeg|jpg|json|md|pdf|png|txt|zip)$/;
const SAFE_PARTIAL_LEAF =
  /^[0-9a-f-]{36}\.(?:bin|heic|jpeg|jpg|json|md|pdf|png|txt|zip)\.partial$/;
const INBOX_ITEM_LEAF = /^[0-9a-f-]{36}\.bin$/;

export function ownedOriginalPath(packId: string, itemId: string): string {
  requireCanonicalId(packId);
  requireCanonicalId(itemId);
  return `Packs/${packId}/originals/${itemId}.bin`;
}

export function ownedDerivedPath(
  packId: string,
  artifactId: string,
  extension: string,
): string {
  return ownedAreaPath(packId, 'derived', artifactId, extension);
}

export function ownedExportPath(
  packId: string,
  exportId: string,
  extension: string,
): string {
  return ownedAreaPath(packId, 'exports', exportId, extension);
}

export function ownedPreviewPath(
  packId: string,
  previewId: string,
  extension: string,
): string {
  return ownedAreaPath(packId, 'previews', previewId, extension);
}

export function inboxManifestPath(ingestionId: string): string {
  requireCanonicalId(ingestionId);
  return `Inbox/${ingestionId}/manifest.json`;
}

export function inboxItemPath(ingestionId: string, itemId: string): string {
  requireCanonicalId(ingestionId);
  requireCanonicalId(itemId);
  return `Inbox/${ingestionId}/${itemId}.bin`;
}

export function isInboxPath(value: string): boolean {
  if (hasUnsafePathSyntax(value)) return false;
  const segments = value.split('/');
  if (
    segments.length !== 3 ||
    segments[0] !== 'Inbox' ||
    !isCanonicalUuid(segments[1])
  )
    return false;
  const leaf = segments[2]!;
  return (
    leaf === 'manifest.json' ||
    (INBOX_ITEM_LEAF.test(leaf) && isCanonicalUuid(leaf.slice(0, 36)))
  );
}

export function isOwnedArtifactPath(value: string): boolean {
  return isOwnedPathWithLeaf(value, SAFE_LEAF);
}

export function isOwnedArtifactPartialPath(value: string): boolean {
  return isOwnedPathWithLeaf(value, SAFE_PARTIAL_LEAF);
}

/** Paths that the native store may enumerate for cleanup and reset. */
export function isOwnedArtifactStorePath(value: string): boolean {
  return isOwnedArtifactPath(value) || isOwnedArtifactPartialPath(value);
}

function isOwnedPathWithLeaf(value: string, leafPattern: RegExp): boolean {
  if (hasUnsafePathSyntax(value)) return false;
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
    leafPattern.test(leaf) &&
    isCanonicalUuid(leafId)
  );
}

export function assertOwnedArtifactPath(value: string): void {
  if (!isOwnedArtifactPath(value)) throw new Error('OWNED_PATH_INVALID');
}

export function ownedArtifactPackId(value: string): string | null {
  if (!isOwnedArtifactStorePath(value)) return null;
  return value.split('/')[1] ?? null;
}

export function ownedArtifactId(value: string): string | null {
  if (!isOwnedArtifactStorePath(value)) return null;
  return value.split('/')[3]?.slice(0, 36) ?? null;
}

function requireCanonicalId(value: string): void {
  if (!isCanonicalUuid(value)) throw new Error('IDENTIFIER_INVALID');
}

function ownedAreaPath(
  packId: string,
  area: 'derived' | 'exports' | 'previews',
  artifactId: string,
  extension: string,
): string {
  requireCanonicalId(packId);
  requireCanonicalId(artifactId);
  if (!CONTROLLED_EXTENSIONS.has(extension))
    throw new Error('ARTIFACT_EXTENSION_INVALID');
  return `Packs/${packId}/${area}/${artifactId}.${extension}`;
}

function hasUnsafePathSyntax(value: string): boolean {
  return (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('%') ||
    value.split('/').some(segment => segment === '' || segment === '..')
  );
}
