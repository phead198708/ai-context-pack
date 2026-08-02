export const IMPORT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const OCR_RESULT_SCHEMA_VERSION = 1 as const;
export interface ImportItemV1 {
  readonly id: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly localUri: string;
  readonly status: 'copied' | 'failed';
  readonly errorCode?: string;
}
export interface ImportManifestV1 {
  readonly schemaVersion: 1;
  readonly ingestionId: string;
  readonly createdAt: string;
  readonly source: 'ios-share-extension' | 'android-share-intent';
  readonly status: 'complete' | 'partial' | 'failed';
  readonly items: readonly ImportItemV1[];
}
export interface NormalizedBoundsV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface OCRBlockV1 {
  readonly text: string;
  readonly bounds: NormalizedBoundsV1;
  readonly confidence?: number;
  readonly language?: string;
}
export interface OCRResultV1 {
  readonly schemaVersion: 1;
  readonly text: string;
  readonly blocks: readonly OCRBlockV1[];
  readonly durationMs: number;
  readonly engine: 'apple-vision' | 'ml-kit-latin' | 'ml-kit-chinese';
  readonly revision: string;
}
export interface PDFProbeResultV1 {
  readonly pageCount: number;
  readonly embeddedTextPages: number;
  readonly renderedFallbackPages: number;
  readonly engine: 'pdfkit' | 'pdf-renderer';
  readonly limit: { readonly pages: 25; readonly bytes: 52_428_800 };
}
