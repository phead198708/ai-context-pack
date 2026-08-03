import { DomainError } from './errors';

export const CONTRACT_VERSIONS = {
  importManifest: 1,
  ocrResult: 1,
  pdfPageExtraction: 1,
  pipelineCheckpoint: 1,
  riskFinding: 1,
  exportManifest: 1,
} as const;

export type ContractName = keyof typeof CONTRACT_VERSIONS;

export const CONTRACT_COMPATIBILITY_POLICY = {
  unknownVersion: 'reject',
  missingVersion: 'reject',
  currentVersion: 'validate-exactly',
  migration: 'explicit-registered-step-only',
} as const;

export type ContractDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'SCHEMA_INVALID' | 'SCHEMA_VERSION_UNSUPPORTED';
    };

export function decodeVersionedContract<T>(
  contract: ContractName,
  value: unknown,
  validateCurrent: (candidate: unknown) => candidate is T,
): ContractDecodeResult<T> {
  const version = schemaVersion(value);
  if (version !== CONTRACT_VERSIONS[contract]) {
    return {
      ok: false,
      code:
        typeof version === 'number'
          ? 'SCHEMA_VERSION_UNSUPPORTED'
          : 'SCHEMA_INVALID',
    };
  }
  return validateCurrent(value)
    ? { ok: true, value }
    : { ok: false, code: 'SCHEMA_INVALID' };
}

export function requireVersionedContract<T>(
  result: ContractDecodeResult<T>,
): T {
  if (!result.ok) throw new DomainError(result.code);
  return result.value;
}

function schemaVersion(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { readonly schemaVersion?: unknown }).schemaVersion;
}
