import type {
  NativeAdapter,
  NativeHandoffResult,
} from '../domain/nativeAdapter';
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
import { isCanonicalUuid } from '../domain/canonicalUuid';
import { isOwnedArtifactPath } from './persistence/ownedPaths';

export interface NativeMethods {
  scanInbox(): Promise<unknown>;
  getPendingShareEvents?(): Promise<unknown>;
  ackPendingShareEvent?(id: string): Promise<unknown>;
  ackEphemeralShareEvent?(id: string): Promise<unknown>;
  getPendingRecoveryEvent?(): Promise<unknown>;
  ackRecoveryEvent?(id: string): Promise<unknown>;
  handoffInbox?(
    ingestionId: string,
    packId: string,
    requiredHeadroomBytes: number,
  ): Promise<unknown>;
  acknowledgeInbox?(ingestionId: string): Promise<unknown>;
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
          if (
            !Array.isArray(value) ||
            !value.every(isImportManifestV1) ||
            new Set(value.map(manifest => manifest.ingestionId)).size !==
              value.length
          )
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
        ackEphemeralShareEvent: async id => {
          if (!nativeModule.ackEphemeralShareEvent)
            throw new NativeBoundaryError('NATIVE_EPHEMERAL_ACK_UNAVAILABLE');
          if ((await nativeModule.ackEphemeralShareEvent(id)) !== true)
            throw new NativeBoundaryError('NATIVE_EPHEMERAL_ACK_FAILED');
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
        handoffInbox: async (ingestionId, packId, requiredHeadroomBytes) => {
          if (!nativeModule.handoffInbox)
            throw new NativeBoundaryError('NATIVE_HANDOFF_UNAVAILABLE');
          const value = await nativeModule.handoffInbox(
            ingestionId,
            packId,
            requiredHeadroomBytes,
          );
          if (!isNativeHandoffResult(value))
            throw new NativeBoundaryError('NATIVE_HANDOFF_INVALID');
          return value;
        },
        acknowledgeInbox: async ingestionId => {
          if (!nativeModule.acknowledgeInbox)
            throw new NativeBoundaryError('NATIVE_INBOX_ACK_UNAVAILABLE');
          if ((await nativeModule.acknowledgeInbox(ingestionId)) !== true)
            throw new NativeBoundaryError('NATIVE_INBOX_ACK_FAILED');
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
        ackEphemeralShareEvent: async () => undefined,
        getPendingRecoveryEvent: async () => null,
        ackRecoveryEvent: async () => undefined,
        handoffInbox: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        acknowledgeInbox: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
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

function isNativeHandoffArtifact(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const artifact = value as Record<string, unknown>;
  const keys = Object.keys(artifact);
  return (
    keys.every(key =>
      [
        'id',
        'itemId',
        'relativePath',
        'mediaType',
        'byteCount',
        'sha256',
      ].includes(key),
    ) &&
    isCanonicalUuid(artifact.id) &&
    artifact.itemId === artifact.id &&
    typeof artifact.relativePath === 'string' &&
    isOwnedArtifactPath(artifact.relativePath) &&
    typeof artifact.mediaType === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
      artifact.mediaType,
    ) &&
    typeof artifact.byteCount === 'number' &&
    Number.isSafeInteger(artifact.byteCount) &&
    artifact.byteCount >= 0 &&
    typeof artifact.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(artifact.sha256)
  );
}

function isNativeHandoffResult(value: unknown): value is NativeHandoffResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 3 &&
    Object.hasOwn(result, 'manifest') &&
    Object.hasOwn(result, 'manifestFingerprint') &&
    Object.hasOwn(result, 'artifacts') &&
    isImportManifestV1(result.manifest) &&
    typeof result.manifestFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(result.manifestFingerprint) &&
    Array.isArray(result.artifacts) &&
    result.artifacts.every(isNativeHandoffArtifact)
  );
}
