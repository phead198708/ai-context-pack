import type {
  NativeArtifactStorageUsage,
  NativeAdapter,
  NativeArtifactVerification,
  NativeHandoffResult,
  NativeOwnedArtifact,
  NativePublishedArtifact,
  NativeQuarantinePurgeResult,
  NativeQuarantinedArtifact,
} from '../domain/nativeAdapter';
import type { MainAppImportInput } from '../domain/mainAppImport';
import {
  isValidUnicodeScalarString,
  MAIN_APP_IMPORT_MAX_TEXT_BYTES,
  utf8ByteCount,
} from '../domain/mainAppImport';
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
import {
  isOwnedArtifactPath,
  isOwnedArtifactStorePath,
} from './persistence/ownedPaths';

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
  publishMainAppImport?(
    ingestionId: string,
    source: 'main-app-picker' | 'main-app-text',
    inputs: readonly MainAppImportInput[],
  ): Promise<unknown>;
  stageMainAppPickerFiles?(fileUris: readonly string[]): Promise<unknown>;
  cleanupMainAppPickerTransients?(): Promise<unknown>;
  recoverMainAppPickerCache?(): Promise<unknown>;
  discardMainAppPickerFiles?(fileUris: readonly string[]): Promise<unknown>;
  publishArtifact?(
    sourceFileUri: string,
    relativePath: string,
    expectedByteCount: number | null,
    expectedSha256: string | null,
  ): Promise<unknown>;
  verifyArtifact?(
    relativePath: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<unknown>;
  listOwnedArtifacts?(): Promise<unknown>;
  removeOwnedArtifact?(relativePath: string): Promise<unknown>;
  quarantineOwnedArtifact?(relativePath: string): Promise<unknown>;
  purgeArtifactQuarantine?(olderThanEpochMs: number): Promise<unknown>;
  getArtifactStorageUsage?(): Promise<unknown>;
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
        publishMainAppImport: async (ingestionId, source, inputs) => {
          if (!nativeModule.publishMainAppImport)
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_UNAVAILABLE');
          if (!isValidMainAppImportInput(ingestionId, source, inputs))
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_INVALID');
          const value = await nativeModule.publishMainAppImport(
            ingestionId,
            source,
            inputs,
          );
          if (
            !isImportManifestV1(value) ||
            value.ingestionId !== ingestionId ||
            value.source !== source ||
            value.items.length !== inputs.length ||
            value.items.some(
              (item, index) =>
                item.id !== inputs[index]?.id || item.order !== index,
            )
          )
            throw new NativeBoundaryError(
              'NATIVE_MAIN_APP_IMPORT_RESULT_INVALID',
            );
          return value;
        },
        stageMainAppPickerFiles: async fileUris => {
          if (!nativeModule.stageMainAppPickerFiles)
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_UNAVAILABLE');
          requireFileUris(fileUris);
          if (
            fileUris.length === 0 ||
            fileUris.length > 20 ||
            new Set(fileUris).size !== fileUris.length
          )
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_INVALID');
          const value = await nativeModule.stageMainAppPickerFiles(fileUris);
          if (
            !Array.isArray(value) ||
            value.length !== fileUris.length ||
            value.length === 0 ||
            value.length > 20 ||
            value.some(
              uri => typeof uri !== 'string' || !uri.startsWith('file://'),
            ) ||
            new Set(value).size !== value.length
          )
            throw new NativeBoundaryError(
              'NATIVE_MAIN_APP_PICKER_STAGE_INVALID',
            );
          return value;
        },
        cleanupMainAppPickerTransients: async () => {
          if (!nativeModule.cleanupMainAppPickerTransients)
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_UNAVAILABLE');
          if ((await nativeModule.cleanupMainAppPickerTransients()) !== true)
            throw new NativeBoundaryError(
              'NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED',
            );
        },
        recoverMainAppPickerCache: async () => {
          if (!nativeModule.recoverMainAppPickerCache)
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_UNAVAILABLE');
          if ((await nativeModule.recoverMainAppPickerCache()) !== true)
            throw new NativeBoundaryError(
              'NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED',
            );
        },
        discardMainAppPickerFiles: async fileUris => {
          if (!nativeModule.discardMainAppPickerFiles)
            throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_UNAVAILABLE');
          requireFileUris(fileUris);
          if ((await nativeModule.discardMainAppPickerFiles(fileUris)) !== true)
            throw new NativeBoundaryError(
              'NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED',
            );
        },
        publishArtifact: async (
          sourceFileUri,
          relativePath,
          expectedByteCount,
          expectedSha256,
        ) => {
          if (!nativeModule.publishArtifact)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.publishArtifact(
            sourceFileUri,
            relativePath,
            expectedByteCount ?? null,
            expectedSha256 ?? null,
          );
          if (!isNativePublishedArtifact(value))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
        },
        verifyArtifact: async (
          relativePath,
          expectedByteCount,
          expectedSha256,
        ) => {
          if (!nativeModule.verifyArtifact)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.verifyArtifact(
            relativePath,
            expectedByteCount,
            expectedSha256,
          );
          if (!isNativeArtifactVerification(value))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
        },
        listOwnedArtifacts: async () => {
          if (!nativeModule.listOwnedArtifacts)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.listOwnedArtifacts();
          if (
            !Array.isArray(value) ||
            !value.every(isNativeOwnedArtifact) ||
            new Set(value.map(item => item.relativePath)).size !== value.length
          )
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
        },
        removeOwnedArtifact: async relativePath => {
          if (!nativeModule.removeOwnedArtifact)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          if ((await nativeModule.removeOwnedArtifact(relativePath)) !== true)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_REMOVE_FAILED');
        },
        quarantineOwnedArtifact: async relativePath => {
          if (!nativeModule.quarantineOwnedArtifact)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.quarantineOwnedArtifact(
            relativePath,
          );
          if (!isNativeQuarantinedArtifact(value))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
        },
        purgeArtifactQuarantine: async olderThanEpochMs => {
          if (!Number.isSafeInteger(olderThanEpochMs) || olderThanEpochMs < 0)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_INPUT_INVALID');
          if (!nativeModule.purgeArtifactQuarantine)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.purgeArtifactQuarantine(
            olderThanEpochMs,
          );
          if (!isNativeQuarantinePurgeResult(value))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
        },
        getArtifactStorageUsage: async () => {
          if (!nativeModule.getArtifactStorageUsage)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.getArtifactStorageUsage();
          if (!isNativeArtifactStorageUsage(value))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
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
        publishMainAppImport: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        stageMainAppPickerFiles: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        cleanupMainAppPickerTransients: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        recoverMainAppPickerCache: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        discardMainAppPickerFiles: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        publishArtifact: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        verifyArtifact: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        listOwnedArtifacts: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        removeOwnedArtifact: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        quarantineOwnedArtifact: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        purgeArtifactQuarantine: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        getArtifactStorageUsage: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        recognizeText: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        probePdf: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
      };

function isValidMainAppImportInput(
  ingestionId: string,
  source: string,
  inputs: readonly MainAppImportInput[],
): boolean {
  if (
    !isCanonicalUuid(ingestionId) ||
    (source !== 'main-app-picker' && source !== 'main-app-text') ||
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    inputs.length > 20 ||
    new Set(inputs.map(input => input.id)).size !== inputs.length
  )
    return false;
  const containsFile = inputs.some(
    input => input.kind === 'file' || input.kind === 'owned-file',
  );
  if ((source === 'main-app-picker') !== containsFile) return false;
  return inputs.every((input, index) => {
    const baseValid =
      isCanonicalUuid(input.id) &&
      input.order === index &&
      typeof input.declaredMediaType === 'string' &&
      input.declaredMediaType.length > 0 &&
      input.declaredMediaType.length <= 127 &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
        input.declaredMediaType,
      ) &&
      Number.isSafeInteger(input.byteCount) &&
      input.byteCount >= 0;
    if (!baseValid) return false;
    if (input.kind === 'file')
      return (
        Object.keys(input).length === 6 &&
        typeof input.fileUri === 'string' &&
        input.fileUri.startsWith('file://')
      );
    if (input.kind === 'owned-file')
      return (
        Object.keys(input).length === 7 &&
        typeof input.ownedRelativePath === 'string' &&
        isOwnedArtifactPath(input.ownedRelativePath) &&
        input.ownedRelativePath.includes('/originals/') &&
        typeof input.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(input.sha256)
      );
    if (
      (input.kind !== 'text' && input.kind !== 'url') ||
      Object.keys(input).length !== 6 ||
      typeof input.text !== 'string' ||
      input.text.length === 0 ||
      !isValidUnicodeScalarString(input.text) ||
      input.byteCount > MAIN_APP_IMPORT_MAX_TEXT_BYTES ||
      input.byteCount !== utf8ByteCount(input.text) ||
      input.declaredMediaType !==
        (input.kind === 'url' ? 'text/uri-list' : 'text/plain')
    )
      return false;
    if (input.kind === 'url') {
      try {
        if (
          input.text !== input.text.trim() ||
          !/^https?:\/\//i.test(input.text)
        )
          return false;
        const parsed = new URL(input.text);
        return (
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.host.length > 0
        );
      } catch {
        return false;
      }
    }
    return true;
  });
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === 'string') return value.code;
  return typeof value.message === 'string' &&
    value.message.includes('INBOX_RECOVERY_REQUIRED')
    ? 'INBOX_RECOVERY_REQUIRED'
    : undefined;
}

function requireFileUris(fileUris: readonly string[]): void {
  if (
    !Array.isArray(fileUris) ||
    fileUris.some(uri => typeof uri !== 'string' || !uri.startsWith('file://'))
  )
    throw new NativeBoundaryError('NATIVE_MAIN_APP_IMPORT_INVALID');
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

function isNativePublishedArtifact(
  value: unknown,
): value is NativePublishedArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const artifact = value as Record<string, unknown>;
  return (
    Object.keys(artifact).length === 4 &&
    typeof artifact.relativePath === 'string' &&
    isOwnedArtifactPath(artifact.relativePath) &&
    isNonNegativeInteger(artifact.byteCount) &&
    typeof artifact.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    typeof artifact.created === 'boolean'
  );
}

function isNativeArtifactVerification(
  value: unknown,
): value is NativeArtifactVerification {
  if (typeof value !== 'object' || value === null) return false;
  const verification = value as Record<string, unknown>;
  const allowed = ['relativePath', 'status', 'byteCount', 'sha256'];
  if (
    !Object.keys(verification).every(key => allowed.includes(key)) ||
    typeof verification.relativePath !== 'string' ||
    !isOwnedArtifactPath(verification.relativePath) ||
    !['verified', 'missing', 'mismatch'].includes(
      typeof verification.status === 'string' ? verification.status : '',
    )
  )
    return false;
  if (verification.status === 'missing')
    return (
      verification.byteCount === undefined && verification.sha256 === undefined
    );
  return (
    isNonNegativeInteger(verification.byteCount) &&
    typeof verification.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(verification.sha256)
  );
}

function isNativeOwnedArtifact(value: unknown): value is NativeOwnedArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const artifact = value as Record<string, unknown>;
  return (
    Object.keys(artifact).length === 2 &&
    typeof artifact.relativePath === 'string' &&
    isOwnedArtifactStorePath(artifact.relativePath) &&
    isNonNegativeInteger(artifact.byteCount)
  );
}

function isNativeArtifactStorageUsage(
  value: unknown,
): value is NativeArtifactStorageUsage {
  if (typeof value !== 'object' || value === null) return false;
  const usage = value as Record<string, unknown>;
  return (
    Object.keys(usage).length === 4 &&
    isNonNegativeInteger(usage.artifactCount) &&
    isNonNegativeInteger(usage.artifactBytes) &&
    isNonNegativeInteger(usage.quarantineCount) &&
    isNonNegativeInteger(usage.quarantineBytes)
  );
}

function isNativeQuarantinedArtifact(
  value: unknown,
): value is NativeQuarantinedArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.quarantined === false) return Object.keys(result).length === 1;
  return (
    result.quarantined === true &&
    Object.keys(result).length === 4 &&
    typeof result.quarantineId === 'string' &&
    isCanonicalUuid(result.quarantineId) &&
    typeof result.anonymousId === 'string' &&
    isCanonicalUuid(result.anonymousId) &&
    isNonNegativeInteger(result.byteCount)
  );
}

function isNativeQuarantinePurgeResult(
  value: unknown,
): value is NativeQuarantinePurgeResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 2 &&
    isNonNegativeInteger(result.purgedCount) &&
    isNonNegativeInteger(result.purgedBytes)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
