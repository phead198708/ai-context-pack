import type {
  ImportManifestV1,
  OCRCapabilitiesV1,
  OCRResultV1,
  NativePlainTextFileV1,
  PDFDocumentInfoV1,
  PDFPageExtractionV1,
  PDFProbeResultV1,
} from './contracts';
import type { PendingShareEvent, RecoveryEvent } from './shareImportResult';
import type { MainAppImportDraft, MainAppImportInput } from './mainAppImport';
import type { OCRRequestV1 } from './ocr';
import type {
  PDFInspectionRequestV1,
  PDFPageExtractionRequestV1,
} from './pdfExtraction';
export interface NativeHandoffArtifact {
  readonly id: string;
  readonly itemId: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly sha256: string;
}
export interface NativeHandoffResult {
  readonly manifest: ImportManifestV1;
  readonly manifestFingerprint: string;
  readonly artifacts: readonly NativeHandoffArtifact[];
}
export interface NativePublishedArtifact {
  readonly relativePath: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly created: boolean;
}
export interface NativeArtifactVerification {
  readonly relativePath: string;
  readonly status: 'verified' | 'missing' | 'mismatch';
  readonly byteCount?: number;
  readonly sha256?: string;
}
export interface NativeOwnedArtifact {
  readonly relativePath: string;
  readonly byteCount: number;
}
export interface NativeArtifactStorageUsage {
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly quarantineCount: number;
  readonly quarantineBytes: number;
}
export interface NativeQuarantinedArtifact {
  readonly quarantined: boolean;
  readonly quarantineId?: string;
  readonly anonymousId?: string;
  readonly byteCount?: number;
}
export interface NativeQuarantinePurgeResult {
  readonly purgedCount: number;
  readonly purgedBytes: number;
}
export interface NativeAdapter {
  readonly available: boolean;
  scanInbox(): Promise<readonly ImportManifestV1[]>;
  getPendingShareEvents(): Promise<readonly PendingShareEvent[]>;
  ackPendingShareEvent(id: string): Promise<void>;
  ackEphemeralShareEvent(id: string): Promise<void>;
  getPendingRecoveryEvent(): Promise<RecoveryEvent | null>;
  ackRecoveryEvent(id: string): Promise<void>;
  handoffInbox(
    ingestionId: string,
    packId: string,
    requiredHeadroomBytes: number,
  ): Promise<NativeHandoffResult>;
  acknowledgeInbox(ingestionId: string): Promise<void>;
  publishMainAppImport(
    ingestionId: MainAppImportDraft['ingestionId'],
    source: 'main-app-picker' | 'main-app-text',
    inputs: readonly MainAppImportInput[],
  ): Promise<ImportManifestV1>;
  stageMainAppPickerFiles(
    fileUris: readonly string[],
  ): Promise<readonly string[]>;
  cleanupMainAppPickerTransients(): Promise<void>;
  recoverMainAppPickerCache(): Promise<void>;
  discardMainAppPickerFiles(fileUris: readonly string[]): Promise<void>;
  publishArtifact(
    sourceFileUri: string,
    relativePath: string,
    expectedByteCount?: number,
    expectedSha256?: string,
  ): Promise<NativePublishedArtifact>;
  verifyArtifact(
    relativePath: string,
    expectedByteCount: number,
    expectedSha256: string,
  ): Promise<NativeArtifactVerification>;
  listOwnedArtifacts(): Promise<readonly NativeOwnedArtifact[]>;
  removeOwnedArtifact(relativePath: string): Promise<void>;
  quarantineOwnedArtifact(
    relativePath: string,
  ): Promise<NativeQuarantinedArtifact>;
  purgeArtifactQuarantine(
    olderThanEpochMs: number,
  ): Promise<NativeQuarantinePurgeResult>;
  getArtifactStorageUsage(): Promise<NativeArtifactStorageUsage>;
  getOCRCapabilities(): Promise<OCRCapabilitiesV1>;
  recognizeText(request: OCRRequestV1): Promise<OCRResultV1>;
  cancelTextRecognition(taskId: string): Promise<void>;
  inspectPdf(request: PDFInspectionRequestV1): Promise<PDFDocumentInfoV1>;
  extractPdfPage(
    request: PDFPageExtractionRequestV1,
  ): Promise<PDFPageExtractionV1>;
  cancelPdfExtraction(taskId: string): Promise<void>;
  finishPdfExtraction(taskId: string): Promise<void>;
  readPlainTextFile(fileUri: string): Promise<NativePlainTextFileV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
