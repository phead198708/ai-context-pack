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
  areOCRBlocksInReadingOrder,
  isImportManifestV1,
  isNativePlainTextFileV1,
  isOCRCapabilitiesV1,
  isOCRResultV1,
  isPDFDocumentInfoV1,
  isPDFPageExtractionV1,
  isPDFProbeResultV1,
  ocrBlocksMatchText,
  PLAIN_TEXT_FILE_MAX_BYTES,
} from '../domain/validation';
import { DERIVED_TEXT_MAXIMUM_UTF8_BYTES } from '../domain/contracts';
import {
  isOCRErrorCode,
  isOCRRequestV1,
  type OCRErrorCode,
} from '../domain/ocr';
import {
  isPDFErrorCode,
  type PDFErrorCode,
  type PDFInspectionRequestV1,
  type PDFPageExtractionRequestV1,
} from '../domain/pdfExtraction';
import {
  isPendingShareEvent,
  isRecoveryEvent,
} from '../domain/shareImportResult';
import { isCanonicalUuid } from '../domain/canonicalUuid';
import {
  isOwnedArtifactPath,
  isOwnedArtifactStorePath,
} from './persistence/ownedPaths';
import { isImagePerceptualHashV1 } from '../domain/duplicateDetection';
import {
  isImageCompressionInspectionV1,
  isImageCompressionRequestV1,
  isImageCompressionResultV1,
} from '../domain/budgetOptimization';

export interface NativeMethods {
  scanInbox(): Promise<unknown>;
  getPendingShareEvents?(): Promise<unknown>;
  ackPendingShareEvent?(id: string): Promise<unknown>;
  ackEphemeralShareEvent?(id: string): Promise<unknown>;
  getPendingRecoveryEvent?(): Promise<unknown>;
  ackRecoveryEvent?(id: string): Promise<unknown>;
  retryRecoveryEvent?(id: string): Promise<unknown>;
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
  resolveOwnedArtifactFileUri?(relativePath: string): Promise<unknown>;
  writeTextArtifact?(relativePath: string, text: string): Promise<unknown>;
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
  getOCRCapabilities?(): Promise<unknown>;
  hashImagePerceptually?(
    taskId: string,
    fileUri: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<unknown>;
  cancelImagePerceptualHash?(taskId: string): Promise<unknown>;
  inspectImageForCompression?(
    taskId: string,
    fileUri: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<unknown>;
  compressImage?(request: {
    readonly schemaVersion: 1;
    readonly taskId: string;
    readonly fileUri: string;
    readonly expectedByteCount: number;
    readonly expectedSha256: string;
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly quality: number;
    readonly outputMediaType: 'image/jpeg' | 'image/png';
    readonly preserveAlpha: boolean;
  }): Promise<unknown>;
  cancelImageCompression?(taskId: string): Promise<unknown>;
  finishImageCompression?(taskId: string): Promise<unknown>;
  recognizeText(
    taskId: string,
    uri: string,
    script: 'latin' | 'chinese',
    recognitionLevel: 'accurate' | 'fast',
  ): Promise<unknown>;
  cancelTextRecognition?(taskId: string): Promise<unknown>;
  inspectPdf?(
    taskId: string,
    uri: string,
    sourceSha256: string,
  ): Promise<unknown>;
  extractPdfPage?(
    taskId: string,
    uri: string,
    sourceSha256: string,
    pageIndex: number,
    script: 'latin' | 'chinese',
  ): Promise<unknown>;
  cancelPdfExtraction?(taskId: string): Promise<unknown>;
  finishPdfExtraction?(taskId: string): Promise<unknown>;
  readPlainTextFile?(
    uri: string,
    maximumBytes: number,
    expectedByteCount: number | null,
    expectedSha256: string | null,
  ): Promise<unknown>;
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
        retryRecoveryEvent: async id => {
          if (!nativeModule.retryRecoveryEvent)
            throw new NativeBoundaryError('NATIVE_RECOVERY_ACK_UNAVAILABLE');
          if ((await nativeModule.retryRecoveryEvent(id)) !== true)
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
        resolveOwnedArtifactFileUri: async relativePath => {
          if (!isOwnedArtifactPath(relativePath))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_INPUT_INVALID');
          if (!nativeModule.resolveOwnedArtifactFileUri)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.resolveOwnedArtifactFileUri(
            relativePath,
          );
          if (typeof value !== 'string' || !value.startsWith('file://'))
            throw new NativeBoundaryError('NATIVE_ARTIFACT_RESULT_INVALID');
          return value;
        },
        writeTextArtifact: async (relativePath, text) => {
          if (
            !isOwnedArtifactPath(relativePath) ||
            !relativePath.endsWith('.txt') ||
            !isValidUnicodeScalarString(text)
          )
            throw new NativeBoundaryError('NATIVE_ARTIFACT_INPUT_INVALID');
          if (!nativeModule.writeTextArtifact)
            throw new NativeBoundaryError('NATIVE_ARTIFACT_STORE_UNAVAILABLE');
          const value = await nativeModule.writeTextArtifact(
            relativePath,
            text,
          );
          if (
            !isNativePublishedArtifact(value) ||
            value.relativePath !== relativePath
          )
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
        getOCRCapabilities: async () => {
          if (!nativeModule.getOCRCapabilities)
            throw new NativeBoundaryError('OCR_ENGINE_UNAVAILABLE');
          const value = await nativeModule.getOCRCapabilities();
          if (!isOCRCapabilitiesV1(value))
            throw new NativeBoundaryError('OCR_RESULT_INVALID');
          return value;
        },
        hashImagePerceptually: async (
          taskId,
          fileUri,
          expectedByteCount,
          expectedSha256,
        ) => {
          if (!nativeModule.hashImagePerceptually)
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          if (
            !isCanonicalUuid(taskId) ||
            !Number.isSafeInteger(expectedByteCount) ||
            expectedByteCount <= 0 ||
            !/^[0-9a-f]{64}$/.test(expectedSha256)
          )
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          requireControlledFileUri(fileUri, 'PROCESSOR_OUTPUT_INVALID');
          let value: unknown;
          try {
            value = await nativeModule.hashImagePerceptually(
              taskId,
              fileUri,
              expectedByteCount,
              expectedSha256,
            );
          } catch (error) {
            const code = nativeErrorCode(error);
            throw new NativeBoundaryError(
              code === 'RESOURCE_MEMORY_PRESSURE' ||
              code === 'PIPELINE_STAGE_FAILED' ||
              code === 'ARTIFACT_INTEGRITY_FAILED' ||
              code === 'INVALID_LOCAL_FILE_URI'
                ? code
                : 'PROCESSOR_OUTPUT_INVALID',
            );
          }
          if (!isImagePerceptualHashV1(value))
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          return value;
        },
        cancelImagePerceptualHash: async taskId => {
          if (!isCanonicalUuid(taskId))
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          if (!nativeModule.cancelImagePerceptualHash)
            throw new NativeBoundaryError('PIPELINE_STAGE_FAILED');
          let acknowledged: unknown;
          try {
            acknowledged = await nativeModule.cancelImagePerceptualHash(taskId);
          } catch (error) {
            const code = nativeErrorCode(error);
            throw new NativeBoundaryError(
              code === 'PIPELINE_STAGE_FAILED'
                ? code
                : 'PROCESSOR_OUTPUT_INVALID',
            );
          }
          if (acknowledged !== true)
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
        },
        inspectImageForCompression: async (
          taskId,
          fileUri,
          expectedByteCount,
          expectedSha256,
        ) => {
          if (!nativeModule.inspectImageForCompression)
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          assertImageProcessorSource(
            taskId,
            fileUri,
            expectedByteCount,
            expectedSha256,
          );
          let value: unknown;
          try {
            value = await nativeModule.inspectImageForCompression(
              taskId,
              fileUri,
              expectedByteCount,
              expectedSha256,
            );
          } catch (error) {
            throw nativeImageCompressionBoundaryError(error);
          }
          if (!isImageCompressionInspectionV1(value))
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          if (
            value.sourceByteCount !== expectedByteCount ||
            value.sourceSha256 !== expectedSha256
          )
            throw new NativeBoundaryError('ARTIFACT_INTEGRITY_FAILED');
          return value;
        },
        compressImage: async request => {
          if (
            !nativeModule.compressImage ||
            !isImageCompressionRequestV1(request)
          )
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          requireControlledFileUri(request.fileUri, 'PROCESSOR_OUTPUT_INVALID');
          let value: unknown;
          try {
            value = await nativeModule.compressImage(request);
          } catch (error) {
            throw nativeImageCompressionBoundaryError(error);
          }
          if (!isImageCompressionResultV1(value))
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          if (
            value.taskId !== request.taskId ||
            value.sourceSha256 !== request.expectedSha256 ||
            value.width !== request.targetWidth ||
            value.height !== request.targetHeight ||
            value.mediaType !== request.outputMediaType ||
            value.quality !== request.quality ||
            value.alphaPreserved !== request.preserveAlpha
          )
            throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
          return value;
        },
        cancelImageCompression: async taskId => {
          await requireTrueImageTaskResult(
            taskId,
            nativeModule.cancelImageCompression,
          );
        },
        finishImageCompression: async taskId => {
          await requireTrueImageTaskResult(
            taskId,
            nativeModule.finishImageCompression,
          );
        },
        recognizeText: async request => {
          if (!isOCRRequestV1(request))
            throw new NativeBoundaryError('OCR_RESULT_INVALID');
          let value: unknown;
          try {
            value = await nativeModule.recognizeText(
              request.taskId,
              request.fileUri,
              request.script,
              request.recognitionLevel,
            );
          } catch (error) {
            throw nativeOCRBoundaryError(error);
          }
          if (
            !isOCRResultV1(value) ||
            value.recognitionLevel !== request.recognitionLevel ||
            !Array.isArray(value.warnings) ||
            !areOCRBlocksInReadingOrder(value.blocks) ||
            !ocrBlocksMatchText(value.blocks, value.text) ||
            (value.engine === 'ml-kit-latin' && request.script !== 'latin') ||
            (value.engine === 'ml-kit-chinese' && request.script !== 'chinese')
          )
            throw new NativeBoundaryError('OCR_RESULT_INVALID');
          return value;
        },
        cancelTextRecognition: async taskId => {
          if (!isCanonicalUuid(taskId))
            throw new NativeBoundaryError('OCR_RESULT_INVALID');
          if (!nativeModule.cancelTextRecognition)
            throw new NativeBoundaryError('OCR_ENGINE_UNAVAILABLE');
          let acknowledged: unknown;
          try {
            acknowledged = await nativeModule.cancelTextRecognition(taskId);
          } catch (error) {
            throw nativeOCRBoundaryError(error);
          }
          if (acknowledged !== true)
            throw new NativeBoundaryError('OCR_RESULT_INVALID');
        },
        inspectPdf: async request => {
          if (!nativeModule.inspectPdf)
            throw new NativeBoundaryError('PDF_PAGE_EXTRACTION_FAILED');
          requirePDFInspectionRequest(request);
          let value: unknown;
          try {
            value = await nativeModule.inspectPdf(
              request.taskId,
              request.fileUri,
              request.sourceSha256,
            );
          } catch (error) {
            throw nativePDFBoundaryError(error);
          }
          if (!isPDFDocumentInfoV1(value))
            throw new NativeBoundaryError('PDF_RESULT_INVALID');
          return value;
        },
        extractPdfPage: async request => {
          if (!nativeModule.extractPdfPage)
            throw new NativeBoundaryError('PDF_PAGE_EXTRACTION_FAILED');
          requirePDFPageRequest(request);
          let value: unknown;
          try {
            value = await nativeModule.extractPdfPage(
              request.taskId,
              request.fileUri,
              request.sourceSha256,
              request.pageIndex,
              request.script,
            );
          } catch (error) {
            throw nativePDFBoundaryError(error);
          }
          if (
            !isPDFPageExtractionV1(value) ||
            value.pageIndex !== request.pageIndex ||
            typeof value.characterCount !== 'number' ||
            !Array.isArray(value.warnings)
          )
            throw new NativeBoundaryError('PDF_RESULT_INVALID');
          return value;
        },
        cancelPdfExtraction: async taskId => {
          if (!isCanonicalUuid(taskId))
            throw new NativeBoundaryError('PDF_RESULT_INVALID');
          if (!nativeModule.cancelPdfExtraction)
            throw new NativeBoundaryError('PDF_PAGE_EXTRACTION_FAILED');
          let acknowledged: unknown;
          try {
            acknowledged = await nativeModule.cancelPdfExtraction(taskId);
          } catch (error) {
            throw nativePDFBoundaryError(error);
          }
          if (acknowledged !== true)
            throw new NativeBoundaryError('PDF_RESULT_INVALID');
        },
        finishPdfExtraction: async taskId => {
          if (!isCanonicalUuid(taskId))
            throw new NativeBoundaryError('PDF_RESULT_INVALID');
          if (!nativeModule.finishPdfExtraction)
            throw new NativeBoundaryError('PDF_PAGE_EXTRACTION_FAILED');
          let acknowledged: unknown;
          try {
            acknowledged = await nativeModule.finishPdfExtraction(taskId);
          } catch (error) {
            throw nativePDFBoundaryError(error);
          }
          if (acknowledged !== true)
            throw new NativeBoundaryError('PDF_RESULT_INVALID');
        },
        readPlainTextFile: async (
          fileUri,
          maximumBytes = PLAIN_TEXT_FILE_MAX_BYTES,
          expectedByteCount,
          expectedSha256,
        ) => {
          if (!nativeModule.readPlainTextFile)
            throw new NativeBoundaryError('TEXT_RESULT_INVALID');
          requireControlledFileUri(fileUri, 'TEXT_RESULT_INVALID');
          if (
            !Number.isSafeInteger(maximumBytes) ||
            maximumBytes <= 0 ||
            maximumBytes > DERIVED_TEXT_MAXIMUM_UTF8_BYTES
          )
            throw new NativeBoundaryError('TEXT_RESULT_INVALID');
          const hasExpectedByteCount = expectedByteCount !== undefined;
          const hasExpectedSha256 = expectedSha256 !== undefined;
          if (
            hasExpectedByteCount !== hasExpectedSha256 ||
            (hasExpectedByteCount &&
              (!Number.isSafeInteger(expectedByteCount) ||
                (expectedByteCount as number) < 0 ||
                (expectedByteCount as number) > maximumBytes ||
                !/^[0-9a-f]{64}$/.test(expectedSha256 as string)))
          )
            throw new NativeBoundaryError('TEXT_RESULT_INVALID');
          let value: unknown;
          try {
            value = await nativeModule.readPlainTextFile(
              fileUri,
              maximumBytes,
              expectedByteCount ?? null,
              expectedSha256 ?? null,
            );
          } catch (error) {
            const code = nativeErrorCode(error);
            throw new NativeBoundaryError(
              code === 'TEXT_INVALID_UTF8' ||
              code === 'TEXT_TOO_LARGE' ||
              code === 'TEXT_RESOURCE_BUSY' ||
              code === 'RESOURCE_MEMORY_PRESSURE' ||
              code === 'ARTIFACT_INTEGRITY_FAILED' ||
              code === 'INVALID_LOCAL_FILE_URI'
                ? code
                : 'TEXT_RESULT_INVALID',
            );
          }
          if (!isNativePlainTextFileV1(value, maximumBytes))
            throw new NativeBoundaryError('TEXT_RESULT_INVALID');
          if (
            expectedByteCount !== undefined &&
            value.byteCount !== expectedByteCount
          )
            throw new NativeBoundaryError('ARTIFACT_INTEGRITY_FAILED');
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
        retryRecoveryEvent: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
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
        resolveOwnedArtifactFileUri: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        writeTextArtifact: async () => {
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
        getOCRCapabilities: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        hashImagePerceptually: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        cancelImagePerceptualHash: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        inspectImageForCompression: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        compressImage: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        cancelImageCompression: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        finishImageCompression: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        recognizeText: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        cancelTextRecognition: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        inspectPdf: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        extractPdfPage: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        cancelPdfExtraction: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        finishPdfExtraction: async () => {
          throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
        },
        readPlainTextFile: async () => {
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

function nativeOCRBoundaryError(error: unknown): NativeBoundaryError {
  const code = nativeErrorCode(error);
  return new NativeBoundaryError(
    isOCRErrorCode(code) ? (code as OCRErrorCode) : 'OCR_RECOGNITION_FAILED',
  );
}

function nativePDFBoundaryError(error: unknown): NativeBoundaryError {
  const code = nativeErrorCode(error);
  return new NativeBoundaryError(
    isPDFErrorCode(code)
      ? (code as PDFErrorCode)
      : 'PDF_PAGE_EXTRACTION_FAILED',
  );
}

function requirePDFPageRequest(request: PDFPageExtractionRequestV1): void {
  if (
    !isCanonicalUuid(request.taskId) ||
    typeof request.sourceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(request.sourceSha256) ||
    !Number.isSafeInteger(request.pageIndex) ||
    request.pageIndex < 0 ||
    request.pageIndex >= 25 ||
    (request.script !== 'latin' && request.script !== 'chinese')
  )
    throw new NativeBoundaryError('PDF_RESULT_INVALID');
  requireControlledFileUri(request.fileUri, 'PDF_RESULT_INVALID');
}

function requirePDFInspectionRequest(request: PDFInspectionRequestV1): void {
  if (
    !isCanonicalUuid(request.taskId) ||
    typeof request.sourceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(request.sourceSha256)
  )
    throw new NativeBoundaryError('PDF_RESULT_INVALID');
  requireControlledFileUri(request.fileUri, 'PDF_RESULT_INVALID');
}

function requireControlledFileUri(fileUri: string, code: string): void {
  if (typeof fileUri !== 'string' || !fileUri.startsWith('file://'))
    throw new NativeBoundaryError(code);
}

function assertImageProcessorSource(
  taskId: string,
  fileUri: string,
  expectedByteCount: number,
  expectedSha256: string,
): void {
  if (
    !isCanonicalUuid(taskId) ||
    !Number.isSafeInteger(expectedByteCount) ||
    expectedByteCount <= 0 ||
    expectedByteCount > 52_428_800 ||
    !/^[0-9a-f]{64}$/.test(expectedSha256)
  )
    throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
  requireControlledFileUri(fileUri, 'PROCESSOR_OUTPUT_INVALID');
}

async function requireTrueImageTaskResult(
  taskId: string,
  operation: ((taskId: string) => Promise<unknown>) | undefined,
): Promise<void> {
  if (!isCanonicalUuid(taskId) || !operation)
    throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
  let value: unknown;
  try {
    value = await operation(taskId);
  } catch (error) {
    throw nativeImageCompressionBoundaryError(error);
  }
  if (value !== true) throw new NativeBoundaryError('PROCESSOR_OUTPUT_INVALID');
}

function nativeImageCompressionBoundaryError(
  error: unknown,
): NativeBoundaryError {
  const code = nativeErrorCode(error);
  return new NativeBoundaryError(
    code === 'ARTIFACT_INTEGRITY_FAILED' ||
    code === 'RESOURCE_MEMORY_PRESSURE' ||
    code === 'PIPELINE_STAGE_FAILED' ||
    code === 'PIPELINE_RECOVERY_REQUIRED' ||
    code === 'PROCESSOR_OUTPUT_INVALID'
      ? code
      : 'PROCESSOR_OUTPUT_INVALID',
  );
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
