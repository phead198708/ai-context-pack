import { DomainError } from '../../domain/errors';
import type {
  Artifact,
  ContextItem,
  ContextPack,
  PipelineStage,
} from '../../domain/models';
import type {
  PersistedArtifactRecord,
  PersistedImportDetail,
  PersistedPackGraph,
} from '../../infrastructure/persistence/contracts';
import {
  calculateDuplicateSavingsV1,
  groupDuplicateSuggestionsV1,
  type DuplicateAnalysisSnapshotV1,
  type DuplicateDecisionChoiceV1,
  type DuplicateReasonV1,
} from '../../domain/duplicateDetection';

export const PACK_LIBRARY_SECTIONS = [
  'draft',
  'processing',
  'review-required',
  'ready',
  'exported',
  'failed',
  'cancelled',
] as const;

export type PackLibrarySection = (typeof PACK_LIBRARY_SECTIONS)[number];

export interface PackCompleteness {
  readonly total: number;
  readonly complete: number;
  readonly processing: number;
  readonly reviewRequired: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface PackLibraryRow {
  readonly id: string;
  readonly title: string;
  readonly state: ContextPack['state'];
  readonly section: PackLibrarySection;
  readonly updatedAt: string;
  readonly completeness: PackCompleteness;
  readonly warningCount: number;
}

export interface PackItemRow {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: ContextItem['sourceType'];
  readonly mediaType: string;
  readonly byteCount: number;
  readonly state: ContextItem['state'];
  readonly stage: PipelineStage;
  readonly progress: number;
  readonly warningCodes: readonly string[];
  readonly errorCode?: string;
  readonly duplicateOfItemId?: string;
  readonly retryStage?: PipelineStage;
}

export interface PackDetailSnapshot {
  readonly pack: ContextPack;
  readonly revision: number;
  readonly items: readonly PackItemRow[];
  readonly completeness: PackCompleteness;
  readonly duplicateReview?: DuplicateReviewSnapshot;
}

export interface DuplicateReviewItemRow {
  readonly id: string;
  readonly displayName: string;
  readonly contentKind: 'prose' | 'code' | 'mixed';
  readonly normalizedCharacterCount: number;
  readonly normalizedByteCount: number;
  readonly choice: DuplicateDecisionChoiceV1 | 'keep';
}

export interface DuplicateReviewGroupRow {
  readonly key: string;
  readonly reasons: readonly DuplicateReasonV1[];
  readonly confidence: number;
  readonly expectedBytesSaved: number;
  readonly expectedCharactersSaved: number;
  readonly items: readonly DuplicateReviewItemRow[];
}

export interface DuplicateReviewSnapshot {
  readonly normalizationVersion: string;
  readonly detectorVersion: number;
  readonly groups: readonly DuplicateReviewGroupRow[];
  readonly actualBytesSaved: number;
  readonly actualCharactersSaved: number;
}

export interface PackLibrarySnapshot {
  readonly sections: Readonly<
    Record<PackLibrarySection, readonly PackLibraryRow[]>
  >;
  readonly selected?: PackDetailSnapshot;
}

export interface RetryPlan {
  readonly packId: string;
  readonly itemId: string;
  readonly stage: PipelineStage;
  readonly completedArtifactIds: readonly string[];
}

const extractionKinds = new Set<Artifact['kind']>([
  'ocr-text',
  'pdf-page-text',
]);

export function buildPackLibrarySnapshot(
  graphs: readonly PersistedPackGraph[],
  artifacts: readonly PersistedArtifactRecord[],
  imports: readonly PersistedImportDetail[],
  selectedPackId?: string,
  duplicateAnalysis?: DuplicateAnalysisSnapshotV1,
): PackLibrarySnapshot {
  const artifactsByItem = groupArtifactsByItem(artifacts);
  const errorsByItem = new Map<string, string>();
  for (const imported of imports)
    for (const item of imported.items)
      if (item.errorCode && !errorsByItem.has(item.id))
        errorsByItem.set(item.id, item.errorCode);

  const sections: Record<PackLibrarySection, PackLibraryRow[]> = {
    draft: [],
    processing: [],
    'review-required': [],
    ready: [],
    exported: [],
    failed: [],
    cancelled: [],
  };
  for (const graph of graphs) {
    const completeness = summarizeCompleteness(graph.items);
    sections[packSection(graph.pack.state)].push({
      id: graph.pack.id,
      title: graph.pack.title,
      state: graph.pack.state,
      section: packSection(graph.pack.state),
      updatedAt: graph.pack.updatedAt,
      completeness,
      warningCount:
        graph.pack.warningCodes.length +
        completeness.reviewRequired +
        completeness.failed,
    });
  }
  const selectedGraph = selectedPackId
    ? graphs.find(graph => graph.pack.id === selectedPackId)
    : graphs[0];
  return {
    sections,
    ...(selectedGraph
      ? {
          selected: buildPackDetail(
            selectedGraph,
            artifactsByItem,
            errorsByItem,
            duplicateAnalysis,
          ),
        }
      : {}),
  };
}

export function packSection(state: ContextPack['state']): PackLibrarySection {
  if (state === 'exporting' || state === 'recovering') return 'processing';
  return state;
}

export function summarizeCompleteness(
  items: readonly ContextItem[],
): PackCompleteness {
  return {
    total: items.length,
    complete: items.filter(item => item.state === 'packaged').length,
    processing: items.filter(item =>
      [
        'received',
        'imported',
        'extracted',
        'analyzed',
        'reviewed',
        'recovering',
      ].includes(item.state),
    ).length,
    reviewRequired: items.filter(item => item.state === 'review-required')
      .length,
    failed: items.filter(item => item.state === 'failed').length,
    cancelled: items.filter(item => item.state === 'cancelled').length,
  };
}

export function retryPlanForItem(
  packId: string,
  item: ContextItem,
  artifacts: readonly PersistedArtifactRecord[],
): RetryPlan {
  const stage = retryStageForItem(item, artifacts);
  return {
    packId,
    itemId: item.id,
    stage,
    completedArtifactIds: artifacts.map(artifact => artifact.id),
  };
}

export function stateAtRetryCheckpoint(
  stage: PipelineStage,
): ContextItem['state'] {
  const values: Record<PipelineStage, ContextItem['state']> = {
    import: 'received',
    extract: 'imported',
    analyze: 'extracted',
    review: 'analyzed',
    package: 'reviewed',
  };
  return values[stage];
}

export function reorderContextItems(
  items: readonly ContextItem[],
  itemId: string,
  targetIndex: number,
): readonly ContextItem[] {
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0)
    throw new DomainError('SCHEMA_INVALID');
  const currentIndex = items.findIndex(item => item.id === itemId);
  if (currentIndex < 0 || targetIndex >= items.length)
    throw new DomainError('PERSISTENCE_CONFLICT');
  const reordered = [...items];
  const [moved] = reordered.splice(currentIndex, 1);
  if (!moved) throw new DomainError('PERSISTENCE_CONFLICT');
  reordered.splice(targetIndex, 0, moved);
  return reordered.map((item, sortIndex) => ({ ...item, sortIndex }));
}

function buildPackDetail(
  graph: PersistedPackGraph,
  artifactsByItem: ReadonlyMap<string, readonly PersistedArtifactRecord[]>,
  errorsByItem: ReadonlyMap<string, string>,
  duplicateAnalysis?: DuplicateAnalysisSnapshotV1,
): PackDetailSnapshot {
  const firstByHash = new Map<string, string>();
  const rows = graph.items.map(item => {
    const itemArtifacts = artifactsByItem.get(item.id) ?? [];
    const original = itemArtifacts.find(
      artifact => artifact.kind === 'original',
    );
    const prior = item.originalSha256
      ? firstByHash.get(item.originalSha256)
      : undefined;
    if (item.originalSha256 && !prior)
      firstByHash.set(item.originalSha256, item.id);
    const warningCodes = [
      ...(prior ? ['DUPLICATE_ORIGINAL'] : []),
      ...(item.state === 'review-required'
        ? ['LOW_CONFIDENCE_REVIEW_REQUIRED']
        : []),
    ];
    const derivedRetryStage =
      item.state === 'failed' ||
      item.state === 'cancelled' ||
      item.state === 'recovering'
        ? retryStageForItem(item, itemArtifacts)
        : undefined;
    // Import failures without an owned original remain in the existing retained-source retry
    // flow. Changing only their state would create a provider-less, non-executable item.
    const retryStage =
      derivedRetryStage === 'import' ? undefined : derivedRetryStage;
    const errorCode =
      errorsByItem.get(item.id) ??
      (item.state === 'failed' ? 'PIPELINE_STAGE_FAILED' : undefined);
    return {
      id: item.id,
      displayName:
        item.originalDisplayName ?? `${item.sourceType} ${item.sortIndex + 1}`,
      sourceType: item.sourceType,
      mediaType: item.mediaType,
      byteCount: original?.byteCount ?? 0,
      state: item.state,
      stage: stageForItem(item, itemArtifacts),
      progress: progressForItem(item, itemArtifacts),
      warningCodes,
      ...(errorCode ? { errorCode } : {}),
      ...(prior ? { duplicateOfItemId: prior } : {}),
      ...(retryStage ? { retryStage } : {}),
    };
  });
  return {
    pack: graph.pack,
    revision: graph.revision,
    items: rows,
    completeness: summarizeCompleteness(graph.items),
    ...(duplicateAnalysis?.manifest
      ? {
          duplicateReview: buildDuplicateReview(graph.items, duplicateAnalysis),
        }
      : {}),
  };
}

function buildDuplicateReview(
  items: readonly ContextItem[],
  snapshot: DuplicateAnalysisSnapshotV1,
): DuplicateReviewSnapshot {
  if (!snapshot.manifest) throw new DomainError('SCHEMA_INVALID');
  const itemById = new Map(items.map(item => [item.id, item]));
  const analysisById = new Map(
    snapshot.analyses.map(analysis => [analysis.itemId, analysis]),
  );
  const decisionsById = new Map(
    snapshot.decisions.map(decision => [decision.itemId, decision]),
  );
  const groups = groupDuplicateSuggestionsV1(snapshot.suggestions).map(
    group => ({
      key: group.key,
      reasons: [
        ...new Set(group.suggestions.map(value => value.reason)),
      ].sort(),
      confidence: group.suggestions.reduce(
        (maximum, value) => Math.max(maximum, value.confidence),
        0,
      ),
      expectedBytesSaved: group.expectedBytesSaved,
      expectedCharactersSaved: group.expectedCharactersSaved,
      items: group.itemIds.map(itemId => {
        const item = itemById.get(itemId);
        const analysis = analysisById.get(itemId);
        if (!item || !analysis) throw new DomainError('SCHEMA_INVALID');
        return {
          id: itemId,
          displayName:
            item.originalDisplayName ??
            `${item.sourceType} ${item.sortIndex + 1}`,
          contentKind: analysis.contentKind,
          normalizedCharacterCount: analysis.normalizedCharacterCount,
          normalizedByteCount: analysis.normalizedByteCount,
          choice: decisionsById.get(itemId)?.choice ?? 'keep',
        };
      }),
    }),
  );
  const actual = calculateDuplicateSavingsV1(
    snapshot.analyses,
    snapshot.decisions,
  );
  return {
    normalizationVersion: snapshot.manifest.config.normalizationVersion,
    detectorVersion: snapshot.manifest.schemaVersion,
    groups,
    actualBytesSaved: actual.bytes,
    actualCharactersSaved: actual.characters,
  };
}

function groupArtifactsByItem(
  artifacts: readonly PersistedArtifactRecord[],
): ReadonlyMap<string, readonly PersistedArtifactRecord[]> {
  const result = new Map<string, PersistedArtifactRecord[]>();
  for (const artifact of artifacts) {
    if (!artifact.itemId) continue;
    const existing = result.get(artifact.itemId) ?? [];
    existing.push(artifact);
    result.set(artifact.itemId, existing);
  }
  return result;
}

function retryStageForItem(
  item: ContextItem,
  artifacts: readonly PersistedArtifactRecord[],
): PipelineStage {
  if (item.retryStage) return item.retryStage;
  if (!artifacts.some(artifact => artifact.kind === 'original'))
    return 'import';
  if (!artifacts.some(artifact => extractionKinds.has(artifact.kind)))
    return 'extract';
  if (item.riskFindingIds.length === 0) return 'analyze';
  if (item.state !== 'reviewed' && item.state !== 'packaged') return 'review';
  return 'package';
}

function stageForItem(
  item: ContextItem,
  artifacts: readonly PersistedArtifactRecord[],
): PipelineStage {
  const stages: Partial<Record<ContextItem['state'], PipelineStage>> = {
    received: 'import',
    imported: 'extract',
    extracted: 'analyze',
    analyzed: 'review',
    'review-required': 'review',
    reviewed: 'package',
    packaged: 'package',
  };
  return stages[item.state] ?? retryStageForItem(item, artifacts);
}

function progressForItem(
  item: ContextItem,
  artifacts: readonly PersistedArtifactRecord[],
): number {
  const progress: Partial<Record<ContextItem['state'], number>> = {
    received: 0,
    imported: 20,
    extracted: 40,
    analyzed: 60,
    'review-required': 70,
    reviewed: 80,
    packaged: 100,
  };
  if (progress[item.state] !== undefined) return progress[item.state] as number;
  const checkpoint = retryStageForItem(item, artifacts);
  return { import: 0, extract: 20, analyze: 40, review: 60, package: 80 }[
    checkpoint
  ];
}
