import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { t, type AppLocale } from '../../ui/i18n';
import { colors, spacing, typography } from '../../ui/tokens';
import {
  budgetForPreset,
  type BudgetRecommendationV1,
  type BudgetOptimizationPlanV1,
  type BudgetOptimizationResultV1,
} from '../../domain/budgetOptimization';
import type { BudgetPreset } from '../../domain/models';
import type { PackLibraryController } from './controller';
import {
  PACK_LIBRARY_SECTIONS,
  type PackCompleteness,
  type PackItemRow,
  type PackLibrarySection,
  type PackLibrarySnapshot,
} from './domain';

type ScreenLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: PackLibrarySnapshot }
  | { readonly kind: 'error'; readonly code: string };

const ACTUAL_OVER_BUDGET_RECOMMENDATIONS = [
  'lower-quality',
  'ocr-only',
  'split-pack',
  'remove-items',
] as const satisfies readonly BudgetRecommendationV1[];

export interface PackSelectionLoadState {
  controlledPackId: string | undefined;
  activePackId: string | undefined;
  loadGeneration: number;
}

/** Render-time synchronization closes the commit-to-passive-effect stale-load window. */
export function synchronizeControlledPackSelection(
  state: PackSelectionLoadState,
  selectedPackId: string | undefined,
): void {
  if (state.controlledPackId === selectedPackId) return;
  state.controlledPackId = selectedPackId;
  state.activePackId = selectedPackId;
  state.loadGeneration += 1;
}

export function PackLibraryScreen({
  controller,
  locale,
  selectedPackId,
  refreshKey,
  onSelectPack,
  onChanged,
}: {
  readonly controller: PackLibraryController;
  readonly locale: AppLocale;
  readonly selectedPackId?: string;
  readonly refreshKey: string;
  readonly onSelectPack: (packId: string) => void;
  readonly onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [loadState, setLoadState] = useState<ScreenLoadState>({
    kind: 'loading',
  });
  const [mutationErrorCode, setMutationErrorCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [budgetApplyingPackId, setBudgetApplyingPackId] = useState<
    string | undefined
  >(undefined);
  const busyRef = useRef(false);
  const cancellingRef = useRef(false);
  const budgetApplyingPackIdRef = useRef<string | undefined>(undefined);
  const selectionLoadStateRef = useRef<PackSelectionLoadState>({
    controlledPackId: selectedPackId,
    activePackId: selectedPackId,
    loadGeneration: 0,
  });
  const selectionLoadState = selectionLoadStateRef.current;
  const effectiveSelectedPackId = budgetApplyingPackId ?? selectedPackId;
  synchronizeControlledPackSelection(
    selectionLoadState,
    effectiveSelectedPackId,
  );
  const load = useCallback(
    async (packId?: string): Promise<void> => {
      const generation = selectionLoadState.loadGeneration + 1;
      selectionLoadState.loadGeneration = generation;
      try {
        const snapshot = await controller.load(packId);
        if (generation !== selectionLoadState.loadGeneration) return;
        setLoadState({ kind: 'ready', snapshot });
        if (
          snapshot.selected &&
          snapshot.selected.pack.id !== selectionLoadState.activePackId
        ) {
          selectionLoadState.activePackId = snapshot.selected.pack.id;
          onSelectPack(snapshot.selected.pack.id);
        }
      } catch (error) {
        if (generation !== selectionLoadState.loadGeneration) return;
        setLoadState({ kind: 'error', code: errorCode(error) });
      }
    },
    [controller, onSelectPack, selectionLoadState],
  );
  useEffect(() => {
    setLoadState({ kind: 'loading' });
    run(load(effectiveSelectedPackId));
    return () => {
      selectionLoadState.loadGeneration += 1;
    };
  }, [effectiveSelectedPackId, load, refreshKey, selectionLoadState]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setMutationErrorCode(undefined);
      setBusy(true);
      try {
        await operation();
        await load(selectionLoadState.activePackId);
        await onChanged();
      } catch (error) {
        setMutationErrorCode(errorCode(error));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [load, onChanged, selectionLoadState],
  );

  const cancelProcessing = useCallback(
    async (packId: string): Promise<void> => {
      if (cancellingRef.current) return;
      cancellingRef.current = true;
      setCancelling(true);
      setMutationErrorCode(undefined);
      try {
        // Cancellation intentionally bypasses the general mutation lock. An
        // analysis mutation remains busy until its native work settles.
        await controller.cancelProcessing(packId);
        await load(selectionLoadState.activePackId);
        await onChanged();
      } catch (error) {
        setMutationErrorCode(errorCode(error));
      } finally {
        cancellingRef.current = false;
        setCancelling(false);
      }
    },
    [controller, load, onChanged, selectionLoadState],
  );

  const setBudgetApplying = useCallback(
    (packId: string, applying: boolean): void => {
      if (applying) {
        budgetApplyingPackIdRef.current = packId;
        setBudgetApplyingPackId(packId);
      } else if (budgetApplyingPackIdRef.current === packId) {
        budgetApplyingPackIdRef.current = undefined;
        setBudgetApplyingPackId(undefined);
      }
    },
    [],
  );

  const mutationError = mutationErrorCode ? (
    <MutationErrorBanner
      code={mutationErrorCode}
      dismiss={() => setMutationErrorCode(undefined)}
      locale={locale}
    />
  ) : null;

  if (loadState.kind === 'loading')
    return (
      <View style={styles.container}>
        {mutationError}
        <View
          accessibilityLabel={t(locale, 'packLibraryLoading')}
          style={styles.card}
          testID="pack-library-loading"
        >
          <Text accessibilityRole="header" style={styles.heading}>
            {t(locale, 'packLibraryLoading')}
          </Text>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    );
  if (loadState.kind === 'error')
    return (
      <View style={styles.container}>
        {mutationError}
        <View style={styles.card} testID="pack-library-error">
          <Text accessibilityRole="alert" style={styles.error}>
            {`${t(locale, 'packLibraryUnavailable')} · ${loadState.code}`}
          </Text>
          <Button
            disabled={busy}
            label={t(locale, 'retry')}
            onPress={() => run(load(selectionLoadState.activePackId))}
          />
        </View>
      </View>
    );

  const detail = loadState.snapshot.selected;
  return (
    <View testID="pack-library" style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t(locale, 'packLibrary')}
      </Text>
      {mutationError}
      {PACK_LIBRARY_SECTIONS.map(section => (
        <LibrarySection
          disabled={budgetApplyingPackId !== undefined}
          key={section}
          locale={locale}
          rows={loadState.snapshot.sections[section]}
          section={section}
          select={packId => {
            if (budgetApplyingPackIdRef.current !== undefined) return;
            selectionLoadState.activePackId = packId;
            onSelectPack(packId);
            run(load(packId));
          }}
        />
      ))}
      {detail ? (
        <PackEditor
          busy={busy}
          cancelling={cancelling}
          cancelProcessing={cancelProcessing}
          controller={controller}
          detail={detail}
          key={detail.pack.id}
          locale={locale}
          mutate={mutate}
          setBudgetApplying={setBudgetApplying}
        />
      ) : (
        <Text style={styles.detail} testID="pack-library-no-selection">
          {t(locale, 'packNotSelected')}
        </Text>
      )}
    </View>
  );
}

function MutationErrorBanner({
  code,
  dismiss,
  locale,
}: {
  readonly code: string;
  readonly dismiss: () => void;
  readonly locale: AppLocale;
}): React.JSX.Element {
  return (
    <View style={styles.card} testID="pack-library-mutation-error">
      <Text accessibilityRole="alert" style={styles.error}>
        {`${t(locale, 'packActionError')} · ${code}`}
      </Text>
      <Button
        disabled={false}
        label={t(locale, 'dismissError')}
        onPress={dismiss}
      />
    </View>
  );
}

function LibrarySection({
  disabled,
  locale,
  rows,
  section,
  select,
}: {
  readonly disabled: boolean;
  readonly locale: AppLocale;
  readonly rows: PackLibrarySnapshot['sections'][PackLibrarySection];
  readonly section: PackLibrarySection;
  readonly select: (packId: string) => void;
}): React.JSX.Element {
  return (
    <View
      accessibilityLabel={`${sectionLabel(locale, section)}, ${t(
        locale,
        'packCount',
        { count: rows.length },
      )}`}
      style={styles.card}
      testID={`pack-section-${section}`}
    >
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {`${sectionLabel(locale, section)} · ${rows.length}`}
      </Text>
      {rows.length === 0 ? (
        <Text style={styles.detail}>{t(locale, 'packLibraryEmpty')}</Text>
      ) : (
        rows.map(row => (
          <Pressable
            accessibilityLabel={t(locale, 'openPack', { title: row.title })}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            key={row.id}
            onPress={() => {
              if (!disabled) select(row.id);
            }}
            style={styles.packRow}
            testID={`pack-row-${row.id}`}
          >
            <Text style={styles.label}>{row.title}</Text>
            <Text style={styles.detail}>
              {completenessText(locale, row.completeness)}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

function PackEditor({
  busy,
  cancelling,
  cancelProcessing,
  controller,
  detail,
  locale,
  mutate,
  setBudgetApplying,
}: {
  readonly busy: boolean;
  readonly cancelling: boolean;
  readonly cancelProcessing: (packId: string) => Promise<void>;
  readonly controller: PackLibraryController;
  readonly detail: NonNullable<PackLibrarySnapshot['selected']>;
  readonly locale: AppLocale;
  readonly mutate: (operation: () => Promise<unknown>) => Promise<void>;
  readonly setBudgetApplying: (packId: string, applying: boolean) => void;
}): React.JSX.Element {
  const [title, setTitle, acknowledgeTitle] = usePersistedDraft(
    detail.pack.title,
  );
  const [instruction, setInstruction, acknowledgeInstruction] =
    usePersistedDraft(detail.pack.userInstruction);
  return (
    <View style={styles.editor} testID={`pack-editor-${detail.pack.id}`}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t(locale, 'packEditor')}
      </Text>
      <Text
        accessibilityLabel={`${detail.pack.title}, ${localizedPackState(
          locale,
          detail.pack.state,
        )}, ${completenessText(locale, detail.completeness)}`}
        style={styles.detail}
      >
        {`${localizedPackState(locale, detail.pack.state)} · ${completenessText(
          locale,
          detail.completeness,
        )}`}
      </Text>
      <TextInput
        accessibilityLabel={t(locale, 'packTitle')}
        editable={!busy}
        maxLength={120}
        onChangeText={setTitle}
        style={styles.input}
        value={title}
      />
      <Button
        disabled={busy}
        label={t(locale, 'savePackTitle')}
        onPress={() =>
          run(
            mutate(async () => {
              await controller.renamePack(detail.pack.id, title);
              acknowledgeTitle(title.trim());
            }),
          )
        }
      />
      <TextInput
        accessibilityLabel={t(locale, 'taskInstruction')}
        editable={!busy}
        maxLength={4_000}
        multiline
        onChangeText={setInstruction}
        style={[styles.input, styles.multilineInput]}
        value={instruction}
      />
      <Button
        disabled={busy}
        label={t(locale, 'saveInstruction')}
        onPress={() =>
          run(
            mutate(async () => {
              await controller.editInstruction(detail.pack.id, instruction);
              acknowledgeInstruction(instruction);
            }),
          )
        }
      />
      <BudgetOptimizationReview
        busy={busy}
        controller={controller}
        key={detail.pack.id}
        locale={locale}
        mutate={mutate}
        pack={detail.pack}
        items={detail.items}
        setBudgetApplying={setBudgetApplying}
      />
      {['processing', 'recovering'].includes(detail.pack.state) ? (
        <Button
          disabled={cancelling}
          label={t(locale, 'cancelProcessing')}
          onPress={() => run(cancelProcessing(detail.pack.id))}
        />
      ) : null}
      {['processing', 'recovering'].includes(detail.pack.state) &&
      detail.items.some(item => item.state === 'extracted') ? (
        <Button
          disabled={busy}
          label={t(locale, 'analyzeDuplicates')}
          onPress={() =>
            run(mutate(() => controller.analyzePack(detail.pack.id)))
          }
        />
      ) : null}
      {['failed', 'cancelled'].includes(detail.pack.state) ? (
        <Button
          disabled={busy}
          label={t(locale, 'retryPack')}
          onPress={() =>
            run(mutate(() => controller.retryPack(detail.pack.id)))
          }
        />
      ) : null}
      {detail.duplicateReview ? (
        <DuplicateReview
          busy={busy}
          controller={controller}
          locale={locale}
          mutate={mutate}
          packId={detail.pack.id}
          review={detail.duplicateReview}
        />
      ) : null}
      {detail.items.map((item, index) => (
        <ItemEditorRow
          busy={busy}
          controller={controller}
          index={index}
          item={item}
          key={item.id}
          locale={locale}
          mutate={mutate}
          packId={detail.pack.id}
          total={detail.items.length}
        />
      ))}
    </View>
  );
}

function BudgetOptimizationReview({
  busy,
  controller,
  locale,
  mutate,
  pack,
  items,
  setBudgetApplying,
}: {
  readonly busy: boolean;
  readonly controller: PackLibraryController;
  readonly locale: AppLocale;
  readonly mutate: (operation: () => Promise<unknown>) => Promise<void>;
  readonly pack: NonNullable<PackLibrarySnapshot['selected']>['pack'];
  readonly items: readonly PackItemRow[];
  readonly setBudgetApplying: (packId: string, applying: boolean) => void;
}): React.JSX.Element {
  const pendingPlan = pack.budget.pendingOptimization;
  const [preset, setPreset] = useState<BudgetPreset>(
    pendingPlan?.preset ?? pack.budget.preset,
  );
  const [customMiB, setCustomMiB] = useState(
    String(
      Math.max(
        1,
        Math.round(
          (pendingPlan?.budget.maxOutputBytes ?? pack.budget.maxOutputBytes) /
            1_048_576,
        ),
      ),
    ),
  );
  const [plan, setPlan] = useState<BudgetOptimizationPlanV1 | undefined>(
    pendingPlan,
  );
  const [result, setResult] = useState<BudgetOptimizationResultV1>();
  const [applying, setApplying] = useState(false);
  const fixedExcludedItemIds = useMemo(
    () =>
      new Set(
        items
          .filter(item => item.inclusionMode === 'excluded')
          .map(item => item.id),
      ),
    [items],
  );
  const budgetExcludedItemIds = useMemo(
    () =>
      new Set(
        (pack.budget.exclusions ?? []).map(exclusion => exclusion.itemId),
      ),
    [pack.budget.exclusions],
  );
  const itemNameById = useMemo(
    () => new Map(items.map(item => [item.id, item.displayName])),
    [items],
  );
  const [excludedItemIds, setExcludedItemIds] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...fixedExcludedItemIds,
        ...(pendingPlan?.excludedItemIds ?? []),
      ]),
  );
  const priorFixedExcludedItemIds = useRef(fixedExcludedItemIds);
  useEffect(() => {
    setExcludedItemIds(current => {
      const next = new Set(current);
      for (const itemId of priorFixedExcludedItemIds.current)
        if (!fixedExcludedItemIds.has(itemId)) next.delete(itemId);
      for (const itemId of fixedExcludedItemIds) next.add(itemId);
      return next;
    });
    priorFixedExcludedItemIds.current = fixedExcludedItemIds;
  }, [fixedExcludedItemIds]);
  const choose = (value: BudgetPreset): void => {
    setPreset(value);
    setPlan(undefined);
    setResult(undefined);
  };
  const selectedBudget = (): ReturnType<typeof budgetForPreset> =>
    budgetForPreset(
      preset,
      preset === 'custom'
        ? Math.round(Number(customMiB) * 1_048_576)
        : undefined,
    );
  const actual = result ?? pack.budget.latestOptimization;
  const toggleExclusion = (itemId: string): void => {
    if (fixedExcludedItemIds.has(itemId)) return;
    setExcludedItemIds(current => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    setPlan(undefined);
    setResult(undefined);
  };
  return (
    <View style={styles.card} testID="budget-optimization">
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {t(locale, 'budgetOptimization')}
      </Text>
      <Text style={styles.detail} testID="budget-estimator-version">
        {t(locale, 'budgetEstimatorVersion', {
          version: plan?.estimatorVersion ?? pack.budget.estimatorVersion,
        })}
      </Text>
      <Text style={styles.detail}>{t(locale, 'budgetEstimateNotice')}</Text>
      <View style={styles.actions}>
        <Button
          disabled={busy || pendingPlan !== undefined}
          label={t(locale, 'budgetPresetQuality')}
          onPress={() => choose('quality')}
        />
        <Button
          disabled={busy || pendingPlan !== undefined}
          label={t(locale, 'budgetPresetBalanced')}
          onPress={() => choose('balanced')}
        />
        <Button
          disabled={busy || pendingPlan !== undefined}
          label={t(locale, 'budgetPresetCompact')}
          onPress={() => choose('compact')}
        />
        <Button
          disabled={busy || pendingPlan !== undefined}
          label={t(locale, 'budgetPresetCustom')}
          onPress={() => choose('custom')}
        />
      </View>
      {preset === 'custom' ? (
        <TextInput
          accessibilityLabel={t(locale, 'budgetCustomMiB')}
          editable={!busy && pendingPlan === undefined}
          keyboardType="number-pad"
          maxLength={3}
          onChangeText={value => {
            setCustomMiB(value);
            setPlan(undefined);
          }}
          style={styles.input}
          value={customMiB}
        />
      ) : null}
      <View style={styles.actions} testID="budget-exclusions">
        {items.map(item =>
          fixedExcludedItemIds.has(item.id) ? (
            budgetExcludedItemIds.has(item.id) ? (
              <Button
                disabled={busy || pendingPlan !== undefined}
                key={item.id}
                label={t(locale, 'budgetRestoreExcludedItem', {
                  item: item.displayName,
                })}
                onPress={() =>
                  run(
                    mutate(async () => {
                      await controller.restoreBudgetExclusion(pack.id, item.id);
                      setResult(undefined);
                      setPlan(undefined);
                    }),
                  )
                }
              />
            ) : (
              <Text key={item.id} style={styles.detail}>
                {t(locale, 'budgetAlreadyExcluded', {
                  item: item.displayName,
                })}
              </Text>
            )
          ) : (
            <Button
              disabled={busy || pendingPlan !== undefined}
              key={item.id}
              label={t(
                locale,
                excludedItemIds.has(item.id)
                  ? 'budgetIncludeItem'
                  : 'budgetExcludeItem',
                { item: item.displayName },
              )}
              onPress={() => toggleExclusion(item.id)}
            />
          ),
        )}
      </View>
      <Button
        disabled={
          busy ||
          pendingPlan !== undefined ||
          (preset === 'custom' &&
            (!Number.isFinite(Number(customMiB)) || Number(customMiB) < 1))
        }
        label={t(locale, 'previewBudget')}
        onPress={() =>
          run(
            mutate(async () => {
              const value = await controller.previewBudget(
                pack.id,
                selectedBudget(),
                [...excludedItemIds].sort(),
              );
              setPlan(value);
              setResult(undefined);
            }),
          )
        }
      />
      {plan ? (
        <View testID="budget-plan">
          <Text style={styles.detail} testID="budget-estimate-summary">
            {t(locale, 'budgetEstimateSummary', {
              source: plan.estimate.sourceBytes,
              output: plan.estimate.predictedOutputBytes,
              images: plan.estimate.imageCount,
              pages: plan.estimate.pdfPageCount,
              characters: plan.estimate.textCharacterCount,
              tokens: plan.estimate.estimatedTokens,
            })}
          </Text>
          <Text style={plan.withinBudget ? styles.detail : styles.warning}>
            {t(
              locale,
              plan.withinBudget ? 'budgetPlanWithin' : 'budgetPlanOver',
            )}
          </Text>
          {plan.excludedItemIds.length > 0 ? (
            <Text style={styles.detail} testID="budget-excluded-summary">
              {t(locale, 'budgetExcludedSummary', {
                values: plan.excludedItemIds
                  .map(itemId => itemNameById.get(itemId) ?? itemId)
                  .join(', '),
              })}
            </Text>
          ) : null}
          {plan.actions.map(action => (
            <Text
              key={action.itemId}
              style={styles.detail}
              testID={`budget-action-${action.itemId}`}
            >
              {action.kind === 'compress'
                ? t(locale, 'budgetActionCompress', {
                    item: itemNameById.get(action.itemId) ?? action.itemId,
                    source: action.sourceByteCount,
                    output: action.predictedOutputBytes,
                    width: action.targetWidth,
                    height: action.targetHeight,
                    format: action.outputMediaType,
                    quality: action.quality,
                  })
                : t(locale, 'budgetActionKeep', {
                    item: itemNameById.get(action.itemId) ?? action.itemId,
                    bytes: action.sourceByteCount,
                  })}
            </Text>
          ))}
          {plan.recommendations.length > 0 ? (
            <Text style={styles.warning} testID="budget-recommendations">
              {t(locale, 'budgetRecommendations', {
                values: plan.recommendations.join(', '),
              })}
            </Text>
          ) : null}
          <Button
            disabled={busy || !plan.withinBudget}
            label={t(locale, 'applyBudget')}
            onPress={() =>
              run(
                mutate(async () => {
                  setApplying(true);
                  setBudgetApplying(pack.id, true);
                  try {
                    setResult(await controller.applyBudget(plan));
                    setPlan(undefined);
                  } finally {
                    setApplying(false);
                    setBudgetApplying(pack.id, false);
                  }
                }),
              )
            }
          />
          {applying ? (
            <Button
              disabled={false}
              label={t(locale, 'cancelBudget')}
              onPress={() => controller.cancelBudget()}
            />
          ) : null}
        </View>
      ) : null}
      {actual ? (
        <>
          <Text style={styles.detail} testID="budget-actual-summary">
            {t(locale, 'budgetActualSummary', {
              output: actual.actualOutputBytes,
              savings: actual.actualSavingsBytes,
              deviation: actual.deviationBytes,
            })}
          </Text>
          {!actual.withinBudget ? (
            <View accessibilityRole="alert" testID="budget-actual-over-alert">
              <Text style={styles.warning}>
                {t(locale, 'budgetActualOver', {
                  output: actual.actualOutputBytes,
                  maximum: pack.budget.maxOutputBytes,
                })}
              </Text>
              <Text style={styles.warning} testID="budget-actual-remediation">
                {t(locale, 'budgetRecommendations', {
                  values: ACTUAL_OVER_BUDGET_RECOMMENDATIONS.join(', '),
                })}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function DuplicateReview({
  busy,
  controller,
  locale,
  mutate,
  packId,
  review,
}: {
  readonly busy: boolean;
  readonly controller: PackLibraryController;
  readonly locale: AppLocale;
  readonly mutate: (operation: () => Promise<unknown>) => Promise<void>;
  readonly packId: string;
  readonly review: NonNullable<
    NonNullable<PackLibrarySnapshot['selected']>['duplicateReview']
  >;
}): React.JSX.Element {
  return (
    <View style={styles.card} testID="duplicate-review">
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {t(locale, 'duplicateReview')}
      </Text>
      <Text style={styles.detail} testID="duplicate-detector-version">
        {t(locale, 'duplicateDetectorVersion', {
          detector: review.detectorVersion,
          normalization: review.normalizationVersion,
        })}
      </Text>
      <Text style={styles.detail} testID="duplicate-actual-savings">
        {t(locale, 'duplicateActualSavings', {
          bytes: review.actualBytesSaved,
          characters: review.actualCharactersSaved,
        })}
      </Text>
      <Text style={styles.detail}>{t(locale, 'duplicateSafetyNotice')}</Text>
      {review.groups.length === 0 ? (
        <Text style={styles.detail}>{t(locale, 'duplicateNone')}</Text>
      ) : (
        review.groups.map(group => (
          <View
            key={group.key}
            style={styles.duplicateGroup}
            testID={`duplicate-group-${group.key}`}
          >
            <Text style={styles.label}>
              {t(locale, 'duplicateCandidateSummary', {
                reason: group.reasons
                  .map(reason => localizedDuplicateReason(locale, reason))
                  .join(', '),
                confidence: Math.round(group.confidence * 100),
                bytes: group.expectedBytesSaved,
                characters: group.expectedCharactersSaved,
              })}
            </Text>
            <View style={styles.comparisonRow}>
              {group.items.map(item => (
                <View
                  key={item.id}
                  style={styles.comparisonCard}
                  testID={`duplicate-preview-${item.id}`}
                >
                  <Text style={styles.label}>{item.displayName}</Text>
                  <Text
                    accessible
                    accessibilityLabel={duplicateItemSummary(locale, item)}
                    style={styles.detail}
                  >
                    {t(locale, 'duplicateItemPreview', {
                      item: item.displayName,
                      kind: localizedDuplicateKind(locale, item.contentKind),
                      characters: item.normalizedCharacterCount,
                      bytes: item.normalizedByteCount,
                      choice: localizedDuplicateChoice(locale, item.choice),
                    })}
                  </Text>
                  <View style={styles.actions}>
                    <Button
                      disabled={busy}
                      label={t(locale, 'duplicateExclude', {
                        item: item.displayName,
                      })}
                      onPress={() =>
                        run(
                          mutate(() =>
                            controller.reviewDuplicateGroup(
                              packId,
                              group.items.map(value => value.id),
                              { kind: 'exclude', itemId: item.id },
                            ),
                          ),
                        )
                      }
                    />
                    <Button
                      disabled={busy}
                      label={t(locale, 'duplicatePreferred', {
                        item: item.displayName,
                      })}
                      onPress={() =>
                        run(
                          mutate(() =>
                            controller.reviewDuplicateGroup(
                              packId,
                              group.items.map(value => value.id),
                              { kind: 'preferred', itemId: item.id },
                            ),
                          ),
                        )
                      }
                    />
                  </View>
                </View>
              ))}
            </View>
            <Button
              disabled={busy}
              label={t(locale, 'duplicateKeepAll')}
              onPress={() =>
                run(
                  mutate(() =>
                    controller.reviewDuplicateGroup(
                      packId,
                      group.items.map(value => value.id),
                      { kind: 'keep-all' },
                    ),
                  ),
                )
              }
            />
          </View>
        ))
      )}
      {review.standaloneDecisions.length > 0 ? (
        <View testID="duplicate-standalone-decisions">
          <Text accessibilityRole="header" style={styles.label}>
            {t(locale, 'duplicateStandaloneDecisions')}
          </Text>
          <Text style={styles.detail}>
            {t(locale, 'duplicateStandaloneDecisionHelp')}
          </Text>
          {review.standaloneDecisions.map(item => (
            <View key={item.id} style={styles.duplicateGroup}>
              <Text style={styles.detail}>
                {t(locale, 'duplicateItemPreview', {
                  item: item.displayName,
                  kind: localizedDuplicateKind(locale, item.contentKind),
                  characters: item.normalizedCharacterCount,
                  bytes: item.normalizedByteCount,
                  choice: localizedDuplicateChoice(locale, item.choice),
                })}
              </Text>
              <Button
                disabled={busy}
                label={t(locale, 'duplicateRestore', {
                  item: item.displayName,
                })}
                onPress={() =>
                  run(
                    mutate(() =>
                      controller.restoreDuplicateDecision(packId, item.id),
                    ),
                  )
                }
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function duplicateItemSummary(
  locale: AppLocale,
  item: {
    readonly displayName: string;
    readonly contentKind: 'prose' | 'code' | 'mixed';
    readonly normalizedCharacterCount: number;
    readonly normalizedByteCount: number;
    readonly choice: 'keep' | 'exclude' | 'preferred';
  },
): string {
  return t(locale, 'duplicateItemPreview', {
    item: item.displayName,
    kind: localizedDuplicateKind(locale, item.contentKind),
    characters: item.normalizedCharacterCount,
    bytes: item.normalizedByteCount,
    choice: localizedDuplicateChoice(locale, item.choice),
  });
}

function localizedDuplicateReason(
  locale: AppLocale,
  reason: 'exact-binary' | 'near-image' | 'similar-text',
): string {
  return t(
    locale,
    reason === 'exact-binary'
      ? 'duplicateReasonExactBinary'
      : reason === 'near-image'
      ? 'duplicateReasonNearImage'
      : 'duplicateReasonSimilarText',
  );
}

function localizedDuplicateKind(
  locale: AppLocale,
  kind: 'prose' | 'code' | 'mixed',
): string {
  return t(
    locale,
    kind === 'prose'
      ? 'duplicateKindProse'
      : kind === 'code'
      ? 'duplicateKindCode'
      : 'duplicateKindMixed',
  );
}

function localizedDuplicateChoice(
  locale: AppLocale,
  choice: 'keep' | 'exclude' | 'preferred',
): string {
  return t(
    locale,
    choice === 'keep'
      ? 'duplicateChoiceKeep'
      : choice === 'exclude'
      ? 'duplicateChoiceExclude'
      : 'duplicateChoicePreferred',
  );
}

function ItemEditorRow({
  busy,
  controller,
  index,
  item,
  locale,
  mutate,
  packId,
  total,
}: {
  readonly busy: boolean;
  readonly controller: PackLibraryController;
  readonly index: number;
  readonly item: PackItemRow;
  readonly locale: AppLocale;
  readonly mutate: (operation: () => Promise<unknown>) => Promise<void>;
  readonly packId: string;
  readonly total: number;
}): React.JSX.Element {
  const [name, setName, acknowledgeName] = usePersistedDraft(item.displayName);
  const move = useCallback(
    (target: number) => {
      if (busy || target < 0 || target >= total || target === index) return;
      run(mutate(() => controller.reorderItem(packId, item.id, target)));
    },
    [busy, controller, index, item.id, mutate, packId, total],
  );
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Claim touches that start on the dedicated handle before the parent
        // ScrollView can intercept the vertical gesture.
        onStartShouldSetPanResponder: () => !busy,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > 8,
        onPanResponderRelease: (_event, gesture) =>
          move(
            Math.max(
              0,
              Math.min(total - 1, index + Math.round(gesture.dy / 72)),
            ),
          ),
      }),
    [busy, index, move, total],
  );
  const warningText =
    item.warningCodes.length > 0
      ? item.warningCodes.join(', ')
      : t(locale, 'noWarnings');
  return (
    <View style={styles.itemCard} testID={`pack-item-${item.id}`}>
      <View
        accessibilityActions={[
          {
            name: 'increment',
            label: t(locale, 'moveDown', { item: item.displayName }),
          },
          {
            name: 'decrement',
            label: t(locale, 'moveUp', { item: item.displayName }),
          },
          {
            name: 'moveUp',
            label: t(locale, 'moveUp', { item: item.displayName }),
          },
          {
            name: 'moveDown',
            label: t(locale, 'moveDown', { item: item.displayName }),
          },
        ]}
        accessibilityLabel={t(locale, 'dragReorder', {
          item: item.displayName,
        })}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 1, max: total, now: index + 1 }}
        onAccessibilityAction={event => {
          const action = event.nativeEvent.actionName;
          if (action === 'decrement' || action === 'moveUp') move(index - 1);
          if (action === 'increment' || action === 'moveDown') move(index + 1);
        }}
        style={styles.dragHandle}
        testID={`drag-${item.id}`}
        {...panResponder.panHandlers}
      >
        <Text style={styles.label}>↕ {index + 1}</Text>
      </View>
      <View
        accessibilityActions={[
          {
            name: 'moveUp',
            label: t(locale, 'moveUp', { item: item.displayName }),
          },
          {
            name: 'moveDown',
            label: t(locale, 'moveDown', { item: item.displayName }),
          },
        ]}
        accessibilityLabel={t(locale, 'itemAccessibility', {
          item: item.displayName,
          state: localizedItemState(locale, item.state),
          stage: localizedStage(locale, item.stage),
          progress: item.progress,
          warnings: item.warningCodes.length,
          error: item.errorCode ?? t(locale, 'noError'),
        })}
        accessible
        onAccessibilityAction={event => {
          const action = event.nativeEvent.actionName;
          if (action === 'moveUp') move(index - 1);
          if (action === 'moveDown') move(index + 1);
        }}
        testID={`item-summary-${item.id}`}
      >
        <Text style={styles.label}>{item.displayName}</Text>
        <Text style={styles.detail}>
          {t(locale, 'itemMetadata', {
            source: localizedSource(locale, item.sourceType),
            type: item.mediaType,
            bytes: t(locale, 'bytes', { count: item.byteCount }),
            stage: localizedStage(locale, item.stage),
            progress: item.progress,
            state: localizedItemState(locale, item.state),
          })}
        </Text>
      </View>
      {item.warningCodes.length > 0 ? (
        <Text accessibilityRole="alert" style={styles.warning}>
          {t(locale, 'warnings', { warnings: warningText })}
        </Text>
      ) : null}
      {item.errorCode ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t(locale, 'itemError', { code: item.errorCode })}
        </Text>
      ) : null}
      <TextInput
        accessibilityLabel={`${t(locale, 'itemName')} ${index + 1}`}
        editable={!busy}
        maxLength={160}
        onChangeText={setName}
        style={styles.input}
        value={name}
      />
      <View style={styles.actions}>
        <Button
          disabled={busy}
          label={`${t(locale, 'saveItemName')} ${index + 1}`}
          onPress={() =>
            run(
              mutate(async () => {
                await controller.renameItem(packId, item.id, name);
                acknowledgeName(name.trim());
              }),
            )
          }
        />
        <Button
          disabled={busy || index === 0}
          label={t(locale, 'moveUp', { item: item.displayName })}
          onPress={() => move(index - 1)}
        />
        <Button
          disabled={busy || index === total - 1}
          label={t(locale, 'moveDown', { item: item.displayName })}
          onPress={() => move(index + 1)}
        />
        {item.retryStage ? (
          <Button
            disabled={busy}
            label={t(locale, 'retryStage', {
              stage: localizedStage(locale, item.retryStage),
            })}
            onPress={() =>
              run(mutate(() => controller.retryItem(packId, item.id)))
            }
          />
        ) : null}
        <Button
          disabled={busy}
          label={`${t(locale, 'removeFromPack')} ${index + 1}`}
          onPress={() =>
            run(
              mutate(() => controller.removeItem(packId, item.id, 'preserve')),
            )
          }
        />
        {item.byteCount > 0 ? (
          <Button
            disabled={busy}
            label={`${t(locale, 'deleteOriginal')} ${index + 1}`}
            onPress={() =>
              Alert.alert(
                t(locale, 'deleteOriginalTitle'),
                t(locale, 'deleteOriginalDetail'),
                [
                  { text: t(locale, 'keepOriginal'), style: 'cancel' },
                  {
                    text: t(locale, 'deletePermanently'),
                    style: 'destructive',
                    onPress: () =>
                      run(
                        mutate(() =>
                          controller.removeItem(packId, item.id, 'release'),
                        ),
                      ),
                  },
                ],
              )
            }
          />
        ) : null}
      </View>
    </View>
  );
}

/** Preserve edits to one field while an unrelated mutation refreshes the graph. */
function usePersistedDraft(
  persistedValue: string,
): readonly [
  string,
  (value: string) => void,
  (persistedValue: string) => void,
] {
  const [value, setValue] = useState(persistedValue);
  const dirty = useRef(false);
  useEffect(() => {
    setValue(current => {
      if (current === persistedValue) {
        dirty.current = false;
        return current;
      }
      return dirty.current ? current : persistedValue;
    });
  }, [persistedValue]);
  const change = useCallback((next: string) => {
    dirty.current = true;
    setValue(next);
  }, []);
  const acknowledge = useCallback((nextPersistedValue: string) => {
    dirty.current = false;
    setValue(nextPersistedValue);
  }, []);
  return [value, change, acknowledge] as const;
}

function Button({
  disabled,
  label,
  onPress,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function sectionLabel(locale: AppLocale, section: PackLibrarySection): string {
  const keys = {
    draft: 'sectionDraft',
    processing: 'sectionProcessing',
    'review-required': 'sectionReviewRequired',
    ready: 'sectionReady',
    exported: 'sectionExported',
    failed: 'sectionFailed',
    cancelled: 'sectionCancelled',
  } as const;
  return t(locale, keys[section]);
}

function completenessText(locale: AppLocale, value: PackCompleteness): string {
  return t(locale, 'completeness', {
    complete: value.complete,
    total: value.total,
    processing: value.processing,
    review: value.reviewRequired,
    failed: value.failed,
    cancelled: value.cancelled,
  });
}

function localizedPackState(
  locale: AppLocale,
  state: NonNullable<PackLibrarySnapshot['selected']>['pack']['state'],
): string {
  const keys = {
    draft: 'stateDraft',
    processing: 'stateProcessing',
    'review-required': 'stateReviewRequired',
    ready: 'stateReady',
    exporting: 'stateExporting',
    exported: 'stateExported',
    recovering: 'stateRecovering',
    failed: 'stateFailed',
    cancelled: 'stateCancelled',
  } as const;
  return t(locale, keys[state]);
}

function localizedItemState(
  locale: AppLocale,
  state: PackItemRow['state'],
): string {
  const keys = {
    received: 'itemStateReceived',
    imported: 'itemStateImported',
    extracted: 'itemStateExtracted',
    analyzed: 'itemStateAnalyzed',
    'review-required': 'stateReviewRequired',
    reviewed: 'itemStateReviewed',
    packaged: 'itemStatePackaged',
    recovering: 'stateRecovering',
    failed: 'stateFailed',
    cancelled: 'stateCancelled',
  } as const;
  return t(locale, keys[state]);
}

function localizedStage(
  locale: AppLocale,
  stage: PackItemRow['stage'],
): string {
  const keys = {
    import: 'stageImport',
    extract: 'stageExtract',
    analyze: 'stageAnalyze',
    review: 'stageReview',
    package: 'stagePackage',
  } as const;
  return t(locale, keys[stage]);
}

function localizedSource(
  locale: AppLocale,
  source: PackItemRow['sourceType'],
): string {
  const keys = {
    image: 'sourceImage',
    pdf: 'sourcePdf',
    text: 'sourceText',
    url: 'sourceUrl',
  } as const;
  return t(locale, keys[source]);
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null)
    return 'STORAGE_WRITE_FAILED';
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : 'STORAGE_WRITE_FAILED';
}

function run(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  editor: { gap: spacing.md, marginTop: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    gap: spacing.sm,
    padding: spacing.md,
  },
  itemCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    gap: spacing.sm,
    padding: spacing.md,
  },
  packRow: {
    borderColor: colors.muted,
    borderRadius: 10,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  heading: { ...typography.heading, color: colors.text },
  sectionTitle: { ...typography.label, color: colors.text },
  label: { ...typography.label, color: colors.text },
  detail: { ...typography.body, color: colors.muted },
  warning: { ...typography.body, color: '#FDE68A' },
  error: { ...typography.body, color: '#FCA5A5' },
  input: {
    ...typography.body,
    backgroundColor: colors.background,
    borderColor: colors.muted,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    padding: spacing.sm,
  },
  multilineInput: { minHeight: 96, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  buttonText: { ...typography.label, color: colors.text },
  disabled: { opacity: 0.45 },
  dragHandle: {
    alignSelf: 'flex-start',
    borderColor: colors.muted,
    borderRadius: 8,
    borderWidth: 1,
    padding: spacing.sm,
  },
  duplicateGroup: {
    borderColor: colors.muted,
    borderRadius: 10,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  comparisonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  comparisonCard: {
    backgroundColor: colors.background,
    borderRadius: 10,
    flexBasis: 240,
    flexGrow: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
});
