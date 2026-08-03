import type {
  ImportManifestV1,
  OCRResultV1,
  PDFProbeResultV1,
} from './contracts';
import type { PendingShareEvent, RecoveryEvent } from './shareImportResult';
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
  recognizeText(
    fileUri: string,
    script: 'latin' | 'chinese',
  ): Promise<OCRResultV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
