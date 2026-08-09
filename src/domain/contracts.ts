import type { DomainErrorCode } from './errors';
import type { ExportFormat, PipelineStage, RiskCategory } from './models';

export const IMPORT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const OCR_RESULT_SCHEMA_VERSION = 1 as const;
export const PDF_PAGE_EXTRACTION_SCHEMA_VERSION = 1 as const;
export const PIPELINE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const RISK_FINDING_SCHEMA_VERSION = 1 as const;
export const EXPORT_MANIFEST_SCHEMA_VERSION = 1 as const;

interface ImportItemBaseV1 {
  readonly id: string;
  readonly order: number;
  readonly mediaType: string;
}

export interface CopiedImportItemV1 extends ImportItemBaseV1 {
  readonly status: 'copied';
  readonly byteCount: number;
  readonly relativePath: string;
  readonly sha256?: string;
}

export interface FailedImportItemV1 extends ImportItemBaseV1 {
  readonly status: 'failed';
  readonly byteCount: 0;
  readonly errorCode: DomainErrorCode;
  /** Present only when complete bounded retry bytes were retained in the atomic Inbox. */
  readonly retryByteCount?: number;
  readonly retrySha256?: string;
}

export type ImportItemV1 = CopiedImportItemV1 | FailedImportItemV1;

export type ImportSourceV1 =
  | 'ios-share-extension'
  | 'android-share-intent'
  | 'main-app-picker'
  | 'main-app-text';

export interface ImportManifestV1 {
  readonly schemaVersion: 1;
  readonly ingestionId: string;
  readonly createdAt: string;
  readonly source: ImportSourceV1;
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

export type OCRScriptV1 = 'latin' | 'chinese';
export type OCRRecognitionLevelV1 = 'accurate' | 'fast';
export type OCRWarningV1 = 'OCR_LANGUAGE_FALLBACK' | 'OCR_LOW_CONFIDENCE';

export type OCREngineV1 = 'apple-vision' | 'ml-kit-latin' | 'ml-kit-chinese';

export interface OCRResultV1 {
  readonly schemaVersion: 1;
  readonly text: string;
  readonly blocks: readonly OCRBlockV1[];
  readonly durationMs: number;
  readonly engine: OCREngineV1;
  readonly revision: string;
  /** Added compatibly in Issue #10; production native adapters always populate it. */
  readonly recognitionLevel?: OCRRecognitionLevelV1;
  /** Added compatibly in Issue #10; production native adapters always populate it. */
  readonly warnings?: readonly OCRWarningV1[];
}

export interface OCREngineCapabilityV1 {
  readonly engine: OCREngineV1;
  readonly revision: string;
  readonly scripts: readonly OCRScriptV1[];
  readonly recognitionLevels: readonly OCRRecognitionLevelV1[];
  readonly ready: boolean;
  readonly offline: true;
}

export interface OCRCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly engines: readonly OCREngineCapabilityV1[];
  readonly maximumPixelCount: number;
  readonly maximumDimension: number;
}

interface PDFPageExtractionBaseV1 {
  readonly schemaVersion: 1;
  readonly pageIndex: number;
  readonly method: 'embedded-text' | 'rendered-ocr';
  readonly engine: 'pdfkit' | 'pdf-renderer' | 'apple-vision' | 'ml-kit';
  readonly revision: string;
  readonly durationMs: number;
}

export interface CompletePDFPageExtractionV1 extends PDFPageExtractionBaseV1 {
  readonly status: 'complete';
  readonly text: string;
  readonly blocks: readonly OCRBlockV1[];
}

export interface FailedPDFPageExtractionV1 extends PDFPageExtractionBaseV1 {
  readonly status: 'failed';
  readonly errorCode: DomainErrorCode;
}

export type PDFPageExtractionV1 =
  | CompletePDFPageExtractionV1
  | FailedPDFPageExtractionV1;

export type CheckpointReason =
  | 'periodic'
  | 'backgrounded'
  | 'cancelled'
  | 'stage-failure'
  | 'recovery';

export type CheckpointResumeAction =
  | 'continue'
  | 'retry-stage'
  | 'recover-stage';

export interface PipelineCheckpointV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly packId: string;
  readonly itemId?: string;
  readonly stage: PipelineStage;
  readonly reason: CheckpointReason;
  readonly resumeAction: CheckpointResumeAction;
  readonly completedArtifactIds: readonly string[];
  readonly processor: string;
  readonly processorVersion: string;
  readonly updatedAt: string;
  readonly errorCode?: DomainErrorCode;
}

export type FindingLocationV1 =
  | {
      readonly kind: 'text-range';
      readonly start: number;
      readonly length: number;
    }
  | ({ readonly kind: 'image-region' } & NormalizedBoundsV1);

export interface RiskFindingV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly itemId: string;
  readonly detector: string;
  readonly detectorVersion: string;
  readonly category: RiskCategory;
  readonly severity: 'low' | 'medium' | 'high';
  readonly confidence: number;
  readonly location: FindingLocationV1;
  readonly decision: 'pending' | 'keep' | 'redact';
}

export interface ExportArtifactV1 {
  readonly id: string;
  readonly kind: 'markdown' | 'pdf' | 'attachment';
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly sha256: string;
}

export interface ExportManifestV1 {
  readonly schemaVersion: 1;
  readonly exportId: string;
  readonly packId: string;
  readonly createdAt: string;
  readonly format: ExportFormat;
  readonly artifacts: readonly ExportArtifactV1[];
  readonly privacyReview: {
    readonly status: 'complete';
    readonly decisionSetSha256: string;
  };
}

/** Issue #3 probe contract retained until PDF extraction replaces it. */
export interface PDFProbeResultV1 {
  readonly pageCount: number;
  readonly embeddedTextPages: number;
  readonly renderedFallbackPages: number;
  readonly engine: 'pdfkit' | 'pdf-renderer';
  readonly limit: { readonly pages: 25; readonly bytes: 52_428_800 };
}
