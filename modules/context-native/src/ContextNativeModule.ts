import { NativeModule, requireNativeModule } from 'expo';
import type {
  ImportManifestV1,
  OCRCapabilitiesV1,
  OCRRecognitionLevelV1,
  OCRResultV1,
  OCRScriptV1,
  NativePlainTextFileV1,
  PDFDocumentInfoV1,
  PDFPageExtractionV1,
  PDFProbeResultV1,
} from '../../../src/domain/contracts';
import type { MainAppImportInput } from '../../../src/domain/mainAppImport';
import type {
  NativeArtifactStorageUsage,
  NativeArtifactVerification,
  NativeOwnedArtifact,
  NativePublishedArtifact,
  NativeQuarantinePurgeResult,
  NativeQuarantinedArtifact,
} from '../../../src/domain/nativeAdapter';
import type {
  PendingShareEvent,
  RecoveryEvent,
} from '../../../src/domain/shareImportResult';
declare class ContextNativeModule extends NativeModule {
  scanInbox(): Promise<readonly ImportManifestV1[]>;
  getPendingShareEvents(): Promise<readonly PendingShareEvent[]>;
  ackPendingShareEvent(id: string): Promise<boolean>;
  ackEphemeralShareEvent(id: string): Promise<boolean>;
  getPendingRecoveryEvent(): Promise<RecoveryEvent | null>;
  ackRecoveryEvent(id: string): Promise<boolean>;
  handoffInbox(
    ingestionId: string,
    packId: string,
    requiredHeadroomBytes: number,
  ): Promise<unknown>;
  acknowledgeInbox(ingestionId: string): Promise<boolean>;
  publishMainAppImport(
    ingestionId: string,
    source: 'main-app-picker' | 'main-app-text',
    inputs: readonly MainAppImportInput[],
  ): Promise<ImportManifestV1>;
  stageMainAppPickerFiles(
    fileUris: readonly string[],
  ): Promise<readonly string[]>;
  cleanupMainAppPickerTransients(): Promise<boolean>;
  recoverMainAppPickerCache(): Promise<boolean>;
  discardMainAppPickerFiles(fileUris: readonly string[]): Promise<boolean>;
  publishArtifact(
    sourceFileUri: string,
    relativePath: string,
    expectedByteCount: number | null,
    expectedSha256: string | null,
  ): Promise<NativePublishedArtifact>;
  verifyArtifact(
    relativePath: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<NativeArtifactVerification>;
  listOwnedArtifacts(): Promise<readonly NativeOwnedArtifact[]>;
  removeOwnedArtifact(relativePath: string): Promise<boolean>;
  quarantineOwnedArtifact(
    relativePath: string,
  ): Promise<NativeQuarantinedArtifact>;
  purgeArtifactQuarantine(
    olderThanEpochMs: number,
  ): Promise<NativeQuarantinePurgeResult>;
  getArtifactStorageUsage(): Promise<NativeArtifactStorageUsage>;
  getOCRCapabilities(): Promise<OCRCapabilitiesV1>;
  recognizeText(
    taskId: string,
    fileUri: string,
    script: OCRScriptV1,
    recognitionLevel: OCRRecognitionLevelV1,
  ): Promise<OCRResultV1>;
  cancelTextRecognition(taskId: string): Promise<boolean>;
  inspectPdf(fileUri: string): Promise<PDFDocumentInfoV1>;
  extractPdfPage(
    taskId: string,
    fileUri: string,
    pageIndex: number,
    script: OCRScriptV1,
  ): Promise<PDFPageExtractionV1>;
  cancelPdfExtraction(taskId: string): Promise<boolean>;
  readPlainTextFile(fileUri: string): Promise<NativePlainTextFileV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
export default requireNativeModule<ContextNativeModule>('ContextNative');
