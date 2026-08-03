export interface ArtifactIdentity {
  readonly id: string;
  readonly itemId: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly sha256: string;
}

export function artifactIdentitySetsEqual(
  left: readonly ArtifactIdentity[],
  right: readonly ArtifactIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map(artifact => [artifact.id, artifact]));
  if (rightById.size !== right.length) return false;
  return left.every(artifact => {
    const other = rightById.get(artifact.id);
    return (
      other !== undefined &&
      artifact.itemId === other.itemId &&
      artifact.relativePath === other.relativePath &&
      artifact.mediaType === other.mediaType &&
      artifact.byteCount === other.byteCount &&
      artifact.sha256 === other.sha256
    );
  });
}
