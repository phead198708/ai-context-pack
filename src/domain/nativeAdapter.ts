import type {
  ImportManifestV1,
  OCRResultV1,
  PDFProbeResultV1,
} from './contracts';
import type { PendingShareEvent, RecoveryEvent } from './shareImportResult';
export interface NativeAdapter {
  readonly available: boolean;
  scanInbox(): Promise<readonly ImportManifestV1[]>;
  getPendingShareEvents(): Promise<readonly PendingShareEvent[]>;
  ackPendingShareEvent(id: string): Promise<void>;
  getPendingRecoveryEvent(): Promise<RecoveryEvent | null>;
  ackRecoveryEvent(id: string): Promise<void>;
  recognizeText(
    fileUri: string,
    script: 'latin' | 'chinese',
  ): Promise<OCRResultV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
