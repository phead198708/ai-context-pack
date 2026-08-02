import type { NativeAdapter } from '../domain/nativeAdapter';
import { newestManifestsFirst } from '../domain/importOrdering';
import {
  isImportManifestV1,
  isOCRResultV1,
  isPDFProbeResultV1,
} from '../domain/validation';
import {
  isPendingShareEvent,
  isRecoveryEvent,
} from '../domain/shareImportResult';

export interface NativeMethods {
  scanInbox(): Promise<unknown>;
  getPendingShareEvents?(): Promise<unknown>;
  ackPendingShareEvent?(id: string): Promise<unknown>;
  getPendingRecoveryEvent?(): Promise<unknown>;
  ackRecoveryEvent?(id: string): Promise<unknown>;
  recognizeText(uri: string, script: 'latin' | 'chinese'): Promise<unknown>;
  probePdf(uri: string): Promise<unknown>;
}

export class NativeBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'NativeBoundaryError';
  }
}

export const createNativeAdapter = (
  nativeModule: NativeMethods | null,
): NativeAdapter =>
  nativeModule
    ? {
        available: true,
        scanInbox: async () => {
          let value: unknown;
          try {
            value = await nativeModule.scanInbox();
          } catch (error) {
            if (nativeErrorCode(error) === 'INBOX_RECOVERY_REQUIRED')
              throw new NativeBoundaryError('INBOX_RECOVERY_REQUIRED');
            throw error;
          }
          if (!Array.isArray(value) || !value.every(isImportManifestV1))
            throw new NativeBoundaryError('NATIVE_MANIFEST_INVALID');
          return newestManifestsFirst(value);
        },
        getPendingShareEvents: async () => {
          const value = (await nativeModule.getPendingShareEvents?.()) ?? [];
          if (!Array.isArray(value) || !value.every(isPendingShareEvent))
            throw new NativeBoundaryError('NATIVE_SHARE_EVENT_INVALID');
          return value;
        },
        ackPendingShareEvent: async id => {
          if (!nativeModule.ackPendingShareEvent)
            throw new NativeBoundaryError('NATIVE_SHARE_ACK_UNAVAILABLE');
          if ((await nativeModule.ackPendingShareEvent(id)) !== true)
            throw new NativeBoundaryError('NATIVE_SHARE_ACK_FAILED');
        },
        getPendingRecoveryEvent: async () => {
          const value =
            (await nativeModule.getPendingRecoveryEvent?.()) ?? null;
          if (value !== null && !isRecoveryEvent(value))
            throw new NativeBoundaryError('NATIVE_RECOVERY_EVENT_INVALID');
          return value;
        },
        ackRecoveryEvent: async id => {
          if (!nativeModule.ackRecoveryEvent)
            throw new NativeBoundaryError('NATIVE_RECOVERY_ACK_UNAVAILABLE');
          if ((await nativeModule.ackRecoveryEvent(id)) !== true)
            throw new NativeBoundaryError('NATIVE_RECOVERY_ACK_FAILED');
        },
        recognizeText: async (uri, script) => {
          const value = await nativeModule.recognizeText(uri, script);
          if (!isOCRResultV1(value))
            throw new NativeBoundaryError('NATIVE_OCR_RESULT_INVALID');
          return value;
        },
        probePdf: async uri => {
          const value = await nativeModule.probePdf(uri);
          if (!isPDFProbeResultV1(value))
            throw new NativeBoundaryError('NATIVE_PDF_RESULT_INVALID');
          return value;
        },
      }
    : {
        available: false,
        scanInbox: async () => [],
        getPendingShareEvents: async () => [],
        ackPendingShareEvent: async () => undefined,
        getPendingRecoveryEvent: async () => null,
        ackRecoveryEvent: async () => undefined,
        recognizeText: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        probePdf: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
      };

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === 'string') return value.code;
  return typeof value.message === 'string' &&
    value.message.includes('INBOX_RECOVERY_REQUIRED')
    ? 'INBOX_RECOVERY_REQUIRED'
    : undefined;
}
