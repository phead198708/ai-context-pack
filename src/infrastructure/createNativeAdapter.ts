import type { NativeAdapter } from '../domain/nativeAdapter';
import { newestManifestsFirst } from '../domain/importOrdering';
import {
  isImportManifestV1,
  isOCRResultV1,
  isPDFProbeResultV1,
} from '../domain/validation';

export interface NativeMethods {
  scanInbox(): Promise<unknown>;
  consumePendingShareResult?(): Promise<unknown>;
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
          const value = await nativeModule.scanInbox();
          if (!Array.isArray(value) || !value.every(isImportManifestV1))
            throw new NativeBoundaryError('NATIVE_MANIFEST_INVALID');
          return newestManifestsFirst(value);
        },
        consumePendingShareResult: async () =>
          nativeModule.consumePendingShareResult?.() ?? null,
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
        consumePendingShareResult: async () => null,
        recognizeText: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        probePdf: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
      };
