export type ShareImportResult = 'complete' | 'failed';
export type ShareImportErrorCode =
  | 'SHARE_IMPORT_FAILED'
  | 'SHARE_IMPORT_INTERRUPTED'
  | 'SHARE_IMPORT_RECOVERY_REQUIRED'
  | 'SHARE_RESULT_PERSIST_FAILED'
  | 'SHARE_EPHEMERAL_QUEUE_OVERFLOW'
  | 'SHARE_TRANSACTION_STORE_READ_FAILED'
  | 'SHARE_TRANSACTION_SCHEMA_INVALID'
  | 'SHARE_TRANSACTION_STORE_WRITE_FAILED'
  | 'SHARE_TRANSACTION_QUARANTINE_FAILED'
  | 'SHARE_TRANSACTION_TRANSITION_FAILED'
  | 'SHARE_TRANSACTION_TERMINAL_CONFLICT'
  | 'SHARE_TRANSACTION_RECONCILE_FAILED';
export interface PendingShareEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly result: ShareImportResult;
  readonly durable?: boolean;
  readonly code?: ShareImportErrorCode;
}
export interface RecoveryEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly code: 'INBOX_RECOVERY_REQUIRED';
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const shareImportErrorCodes: ReadonlySet<ShareImportErrorCode> = new Set([
  'SHARE_IMPORT_FAILED',
  'SHARE_IMPORT_INTERRUPTED',
  'SHARE_IMPORT_RECOVERY_REQUIRED',
  'SHARE_RESULT_PERSIST_FAILED',
  'SHARE_EPHEMERAL_QUEUE_OVERFLOW',
  'SHARE_TRANSACTION_STORE_READ_FAILED',
  'SHARE_TRANSACTION_SCHEMA_INVALID',
  'SHARE_TRANSACTION_STORE_WRITE_FAILED',
  'SHARE_TRANSACTION_QUARANTINE_FAILED',
  'SHARE_TRANSACTION_TRANSITION_FAILED',
  'SHARE_TRANSACTION_TERMINAL_CONFLICT',
  'SHARE_TRANSACTION_RECONCILE_FAILED',
]);

export const isPendingShareEvent = (
  value: unknown,
): value is PendingShareEvent =>
  record(value) &&
  value.schemaVersion === 1 &&
  typeof value.id === 'string' &&
  uuid.test(value.id) &&
  (value.result === 'complete' || value.result === 'failed') &&
  (value.durable === undefined || typeof value.durable === 'boolean') &&
  (value.code === undefined ||
    (typeof value.code === 'string' &&
      shareImportErrorCodes.has(value.code as ShareImportErrorCode))) &&
  (value.durable !== false ||
    (value.result === 'failed' && value.code !== undefined));

export const isRecoveryEvent = (value: unknown): value is RecoveryEvent =>
  record(value) &&
  value.schemaVersion === 1 &&
  typeof value.id === 'string' &&
  uuid.test(value.id) &&
  value.code === 'INBOX_RECOVERY_REQUIRED';

export function shareImportErrorCode(result: unknown): string | null {
  if (isPendingShareEvent(result)) result = result.result;
  if (result === 'complete') return null;
  return result === 'failed'
    ? 'SHARE_IMPORT_FAILED'
    : 'SHARE_IMPORT_EVENT_INVALID';
}
