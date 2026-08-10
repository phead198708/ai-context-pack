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
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const selectedPackIdRef = useRef(selectedPackId);
  const selectedPackIdPropRef = useRef(selectedPackId);
  if (selectedPackIdPropRef.current !== selectedPackId) {
    selectedPackIdPropRef.current = selectedPackId;
    selectedPackIdRef.current = selectedPackId;
  }
  const loadGeneration = useRef(0);
  const load = useCallback(
    async (packId?: string): Promise<void> => {
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      try {
        const snapshot = await controller.load(packId);
        if (generation !== loadGeneration.current) return;
        setLoadState({ kind: 'ready', snapshot });
        if (
          snapshot.selected &&
          snapshot.selected.pack.id !== selectedPackIdRef.current
        ) {
          selectedPackIdRef.current = snapshot.selected.pack.id;
          onSelectPack(snapshot.selected.pack.id);
        }
      } catch (error) {
        if (generation !== loadGeneration.current) return;
        setLoadState({ kind: 'error', code: errorCode(error) });
      }
    },
    [controller, onSelectPack],
  );
  useEffect(() => {
    setLoadState({ kind: 'loading' });
    run(load(selectedPackId));
    return () => {
      loadGeneration.current += 1;
    };
  }, [load, refreshKey, selectedPackId]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      const selectionAtStart = selectedPackIdRef.current;
      setBusy(true);
      try {
        await operation();
        await load(selectedPackIdRef.current);
        await onChanged();
      } catch (error) {
        if (selectionAtStart === selectedPackIdRef.current)
          setLoadState({ kind: 'error', code: errorCode(error) });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  if (loadState.kind === 'loading')
    return (
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
    );
  if (loadState.kind === 'error')
    return (
      <View style={styles.card} testID="pack-library-error">
        <Text accessibilityRole="alert" style={styles.error}>
          {`${t(locale, 'packLibraryUnavailable')} · ${loadState.code}`}
        </Text>
        <Button
          disabled={busy}
          label={t(locale, 'retry')}
          onPress={() => run(load(selectedPackIdRef.current))}
        />
      </View>
    );

  const detail = loadState.snapshot.selected;
  return (
    <View testID="pack-library" style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t(locale, 'packLibrary')}
      </Text>
      {PACK_LIBRARY_SECTIONS.map(section => (
        <LibrarySection
          key={section}
          locale={locale}
          rows={loadState.snapshot.sections[section]}
          section={section}
          select={packId => {
            selectedPackIdRef.current = packId;
            onSelectPack(packId);
            run(load(packId));
          }}
        />
      ))}
      {detail ? (
        <PackEditor
          busy={busy}
          controller={controller}
          detail={detail}
          locale={locale}
          mutate={mutate}
        />
      ) : (
        <Text style={styles.detail} testID="pack-library-no-selection">
          {t(locale, 'packNotSelected')}
        </Text>
      )}
    </View>
  );
}

function LibrarySection({
  locale,
  rows,
  section,
  select,
}: {
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
            key={row.id}
            onPress={() => select(row.id)}
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
  controller,
  detail,
  locale,
  mutate,
}: {
  readonly busy: boolean;
  readonly controller: PackLibraryController;
  readonly detail: NonNullable<PackLibrarySnapshot['selected']>;
  readonly locale: AppLocale;
  readonly mutate: (operation: () => Promise<unknown>) => Promise<void>;
}): React.JSX.Element {
  const [title, setTitle] = useState(detail.pack.title);
  const [instruction, setInstruction] = useState(detail.pack.userInstruction);
  useEffect(() => {
    setTitle(detail.pack.title);
    setInstruction(detail.pack.userInstruction);
  }, [
    detail.pack.id,
    detail.pack.title,
    detail.pack.userInstruction,
    detail.revision,
  ]);
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
        maxLength={120}
        onChangeText={setTitle}
        style={styles.input}
        value={title}
      />
      <Button
        disabled={busy}
        label={t(locale, 'savePackTitle')}
        onPress={() =>
          run(mutate(() => controller.renamePack(detail.pack.id, title)))
        }
      />
      <TextInput
        accessibilityLabel={t(locale, 'taskInstruction')}
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
            mutate(() =>
              controller.editInstruction(detail.pack.id, instruction),
            ),
          )
        }
      />
      {['processing', 'recovering'].includes(detail.pack.state) ? (
        <Button
          disabled={busy}
          label={t(locale, 'cancelProcessing')}
          onPress={() =>
            run(mutate(() => controller.cancelProcessing(detail.pack.id)))
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
  const [name, setName] = useState(item.displayName);
  useEffect(() => setName(item.displayName), [item.displayName, item.id]);
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
    [index, move, total],
  );
  const warningText =
    item.warningCodes.length > 0
      ? item.warningCodes.join(', ')
      : t(locale, 'noWarnings');
  return (
    <View style={styles.itemCard} testID={`pack-item-${item.id}`}>
      <View
        accessibilityLabel={t(locale, 'dragReorder', {
          item: item.displayName,
        })}
        accessibilityRole="adjustable"
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
        onAccessibilityAction={event =>
          move(index + (event.nativeEvent.actionName === 'moveUp' ? -1 : 1))
        }
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
            run(mutate(() => controller.renameItem(packId, item.id, name)))
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
});
