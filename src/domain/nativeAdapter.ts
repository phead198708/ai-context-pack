import type {
  ImportManifestV1,
  OCRResultV1,
  PDFProbeResultV1,
} from './contracts';
export interface NativeAdapter {
  readonly available: boolean;
  scanInbox(): Promise<readonly ImportManifestV1[]>;
  consumePendingShareResult(): Promise<unknown>;
  recognizeText(
    fileUri: string,
    script: 'latin' | 'chinese',
  ): Promise<OCRResultV1>;
  probePdf(fileUri: string): Promise<PDFProbeResultV1>;
}
