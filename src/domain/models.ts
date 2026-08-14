import type { DomainErrorCode } from './errors';
import type {
  BudgetOptimizationPlanV1,
  BudgetOptimizationResultV1,
  PackBudgetEstimateV1,
} from './budgetOptimization';

export type PackId = string;
export type ItemId = string;
export type ArtifactId = string;
export type ImportRecordId = string;
export type PipelineRunId = string;
export type RiskFindingId = string;
export type ReviewDecisionId = string;
export type ExportRecordId = string;

export type PackState =
  | 'draft'
  | 'processing'
  | 'review-required'
  | 'ready'
  | 'exporting'
  | 'exported'
  | 'recovering'
  | 'failed'
  | 'cancelled';

export type ItemState =
  | 'received'
  | 'imported'
  | 'extracted'
  | 'analyzed'
  | 'review-required'
  | 'reviewed'
  | 'packaged'
  | 'recovering'
  | 'failed'
  | 'cancelled';

export interface ProcessorVersion {
  readonly processor: string;
  readonly version: string;
  readonly contractVersion: number;
  readonly engine?: string;
  readonly engineRevision?: string;
}

export type BudgetPreset = 'quality' | 'balanced' | 'compact' | 'custom';

export interface Budget {
  readonly preset: BudgetPreset;
  readonly maxOutputBytes: number;
  readonly minimumImageLongestEdge: number;
  readonly targetImageLongestEdge: number;
  readonly imageQuality: number;
  readonly estimatorVersion: string;
  readonly latestEstimate?: PackBudgetEstimateV1;
  readonly latestOptimization?: BudgetOptimizationResultV1;
  /** Durable exact-plan checkpoint until optimization commits to the Pack. */
  readonly pendingOptimization?: BudgetOptimizationPlanV1;
}

export interface ContextPack {
  readonly id: PackId;
  readonly schemaVersion: 1;
  readonly title: string;
  readonly userInstruction: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: PackState;
  readonly budget: Budget;
  readonly estimatedTokens: number;
  readonly orderedItemIds: readonly ItemId[];
  readonly exportRecordIds: readonly ExportRecordId[];
  readonly warningCodes: readonly string[];
}

export type ContextItemSource = 'image' | 'pdf' | 'text' | 'url';
export type InclusionMode = 'original' | 'extracted' | 'both' | 'excluded';

export interface ContextItem {
  readonly id: ItemId;
  readonly packId: PackId;
  readonly sourceType: ContextItemSource;
  readonly mediaType: string;
  readonly originalDisplayName?: string;
  readonly originalSha256?: string;
  /** Failed imports do not have an application-owned original yet. */
  readonly originalRelativePath?: string;
  readonly artifactIds: readonly ArtifactId[];
  readonly state: ItemState;
  /** Required for terminal/recovery states so retry survives loss of the prior state. */
  readonly retryStage?: PipelineStage;
  readonly riskFindingIds: readonly RiskFindingId[];
  readonly inclusionMode: InclusionMode;
  readonly sortIndex: number;
}

export type ArtifactKind =
  | 'original'
  | 'ocr-text'
  | 'pdf-page-text'
  | 'normalized-text'
  | 'compressed-image'
  | 'redacted-image'
  | 'preview'
  | 'export';

export interface Artifact {
  readonly id: ArtifactId;
  readonly itemId?: ItemId;
  readonly kind: ArtifactKind;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly processorVersion: ProcessorVersion;
  readonly createdAt: string;
  readonly immutable: true;
}

export interface ImportRecord {
  readonly id: ImportRecordId;
  readonly packId: PackId;
  readonly ingestionId: string;
  readonly source:
    | 'ios-share-extension'
    | 'android-share-intent'
    | 'main-app-picker'
    | 'main-app-text';
  readonly manifestVersion: number;
  readonly createdAt: string;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly itemIds: readonly ItemId[];
  readonly errorCodes: readonly DomainErrorCode[];
}

export type PipelineStage =
  | 'import'
  | 'extract'
  | 'analyze'
  | 'review'
  | 'package';

export type PipelineRunStatus =
  | 'queued'
  | 'running'
  | 'checkpointed'
  | 'recovering'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface PipelineRun {
  readonly id: PipelineRunId;
  readonly packId: PackId;
  readonly itemId?: ItemId;
  readonly stage: PipelineStage;
  readonly status: PipelineRunStatus;
  readonly attempt: number;
  readonly processorVersion: ProcessorVersion;
  readonly checkpointId?: string;
  readonly errorCode?: DomainErrorCode;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type RiskCategory =
  | 'api-key'
  | 'bearer-token'
  | 'jwt'
  | 'private-key'
  | 'url-credential'
  | 'email'
  | 'phone'
  | 'ip-address'
  | 'payment-card';

export type FindingLocation =
  | {
      readonly kind: 'text-range';
      readonly start: number;
      readonly length: number;
    }
  | {
      readonly kind: 'image-region';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export interface RiskFinding {
  readonly id: RiskFindingId;
  readonly itemId: ItemId;
  readonly detectorVersion: ProcessorVersion;
  readonly category: RiskCategory;
  readonly severity: 'low' | 'medium' | 'high';
  readonly confidence: number;
  readonly location: FindingLocation;
  readonly createdAt: string;
}

export interface ReviewDecision {
  readonly id: ReviewDecisionId;
  readonly findingId: RiskFindingId;
  readonly decision: 'pending' | 'keep' | 'redact';
  readonly decidedAt?: string;
}

export type ExportFormat =
  | 'markdown'
  | 'pdf'
  | 'attachment-bundle'
  | 'clipboard';

export interface ExportRecord {
  readonly id: ExportRecordId;
  readonly packId: PackId;
  readonly format: ExportFormat;
  readonly createdAt: string;
  readonly preset: BudgetPreset;
  readonly status: 'running' | 'complete' | 'failed' | 'cancelled';
  readonly manifestSha256?: string;
  readonly artifactIds: readonly ArtifactId[];
  readonly errorCode?: DomainErrorCode;
}
