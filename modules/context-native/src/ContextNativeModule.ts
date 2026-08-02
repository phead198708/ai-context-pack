import { NativeModule, requireNativeModule } from 'expo';
import type {
  ImportManifestV1,
  OCRResultV1,
  PDFProbeResultV1,
} from '../../../src/domain/contracts';
import type {
  PendingShareEvent,
  RecoveryEvent,
} from '../../../src/domain/shareImportResult';
declare class ContextNativeModule extends NativeModule {
  scanInbox(): Promise<readonly ImportManifestV1[]>;
  getPendingShareEvents(): Promise<readonly PendingShareEvent[]>;
  ackPendingShareEvent(id: string): Promise<boolean>;
  getPendingRecoveryEvent(): Promise<RecoveryEvent | null>;
  ackRecoveryEvent(id: string): Promise<boolean>;
  recognizeText(
    fileUri: string,
    script: 'latin' | 'chinese',
  ): Promise<OCRResultV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
export default requireNativeModule<ContextNativeModule>('ContextNative');
