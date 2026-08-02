export type ShareImportResult = 'complete' | 'failed';

export function shareImportErrorCode(result: unknown): string | null {
  if (result === 'complete') return null;
  return result === 'failed'
    ? 'SHARE_IMPORT_FAILED'
    : 'SHARE_IMPORT_EVENT_INVALID';
}
