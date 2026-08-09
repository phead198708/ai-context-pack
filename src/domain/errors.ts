export type ErrorDisposition =
  | 'retryable'
  | 'terminal'
  | 'user-action-required';

export type ErrorCategory =
  | 'integrity'
  | 'privacy'
  | 'resource'
  | 'input'
  | 'platform'
  | 'state';

export const DOMAIN_ERROR_CATALOG = {
  DOMAIN_INVALID_TRANSITION: {
    disposition: 'terminal',
    category: 'state',
  },
  SCHEMA_INVALID: {
    disposition: 'terminal',
    category: 'integrity',
  },
  SCHEMA_VERSION_UNSUPPORTED: {
    disposition: 'terminal',
    category: 'integrity',
  },
  ARTIFACT_INTEGRITY_FAILED: {
    disposition: 'terminal',
    category: 'integrity',
  },
  IMPORT_PROVIDER_PERMISSION_EXPIRED: {
    disposition: 'user-action-required',
    category: 'platform',
  },
  IMPORT_TYPE_UNSUPPORTED: {
    disposition: 'user-action-required',
    category: 'input',
  },
  IMPORT_COPY_FAILED: {
    disposition: 'retryable',
    category: 'resource',
  },
  IMPORT_SIZE_LIMIT_EXCEEDED: {
    disposition: 'user-action-required',
    category: 'input',
  },
  IMPORT_ITEM_LIMIT_EXCEEDED: {
    disposition: 'user-action-required',
    category: 'input',
  },
  IMPORT_PARTIAL_FAILURE: {
    disposition: 'user-action-required',
    category: 'input',
  },
  PIPELINE_STAGE_FAILED: {
    disposition: 'retryable',
    category: 'state',
  },
  PROCESSOR_OUTPUT_INVALID: {
    disposition: 'terminal',
    category: 'integrity',
  },
  PIPELINE_RECOVERY_REQUIRED: {
    disposition: 'retryable',
    category: 'integrity',
  },
  PRIVACY_REVIEW_REQUIRED: {
    disposition: 'user-action-required',
    category: 'privacy',
  },
  PRIVACY_EXPORT_BLOCKED: {
    disposition: 'user-action-required',
    category: 'privacy',
  },
  RESOURCE_LOW_DISK: {
    disposition: 'user-action-required',
    category: 'resource',
  },
  RESOURCE_MEMORY_PRESSURE: {
    disposition: 'retryable',
    category: 'resource',
  },
  STORAGE_WRITE_FAILED: {
    disposition: 'retryable',
    category: 'resource',
  },
  STORAGE_DIVERGENCE_DETECTED: {
    disposition: 'retryable',
    category: 'integrity',
  },
  STORAGE_ARTIFACT_IMMUTABLE: {
    disposition: 'terminal',
    category: 'integrity',
  },
  PERSISTENCE_CONFLICT: {
    disposition: 'retryable',
    category: 'state',
  },
  DEVELOPMENT_RESET_FORBIDDEN: {
    disposition: 'terminal',
    category: 'state',
  },
} as const satisfies Readonly<
  Record<
    string,
    { readonly disposition: ErrorDisposition; readonly category: ErrorCategory }
  >
>;

export type DomainErrorCode = keyof typeof DOMAIN_ERROR_CATALOG;

export function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return (
    typeof value === 'string' &&
    Object.keys(DOMAIN_ERROR_CATALOG).includes(value)
  );
}

export interface DomainErrorDefinition {
  readonly code: DomainErrorCode;
  readonly disposition: ErrorDisposition;
  readonly category: ErrorCategory;
}

export function domainErrorDefinition(
  code: DomainErrorCode,
): DomainErrorDefinition {
  return { code, ...DOMAIN_ERROR_CATALOG[code] };
}

export class DomainError extends Error {
  readonly disposition: ErrorDisposition;
  readonly category: ErrorCategory;

  constructor(readonly code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
    const definition = DOMAIN_ERROR_CATALOG[code];
    this.disposition = definition.disposition;
    this.category = definition.category;
  }
}
