import { NativeModule, requireNativeModule } from 'expo';
import type {
  ImportManifestV1,
  OCRResultV1,
  PDFProbeResultV1,
} from '../../../src/domain/contracts';
declare class ContextNativeModule extends NativeModule {
  scanInbox(): Promise<readonly ImportManifestV1[]>;
  consumePendingShareResult(): Promise<string | null>;
  recognizeText(
    fileUri: string,
    script: 'latin' | 'chinese',
  ): Promise<OCRResultV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
export default requireNativeModule<ContextNativeModule>('ContextNative');
