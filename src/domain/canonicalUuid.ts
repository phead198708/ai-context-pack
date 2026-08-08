const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && canonicalUuidPattern.test(value);
}

/** Product identifiers are opaque correlation keys, not authentication secrets. */
export function createCanonicalUuid(
  random: () => number = Math.random,
): string {
  const values = Array.from({ length: 32 }, () =>
    Math.floor(random() * 16).toString(16),
  );
  values[12] = '4';
  values[16] = (8 + Math.floor(random() * 4)).toString(16);
  return `${values.slice(0, 8).join('')}-${values
    .slice(8, 12)
    .join('')}-${values.slice(12, 16).join('')}-${values
    .slice(16, 20)
    .join('')}-${values.slice(20).join('')}`;
}
