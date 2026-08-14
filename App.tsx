import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  DeviceEventEmitter,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  InboxEventWorkflow,
  type InboxPersistedImportSummary,
  type InboxWorkflowState,
} from './src/domain/inboxEventWorkflow';
import type { ImportManifestV1 } from './src/domain/contracts';
import { isCanonicalUuid } from './src/domain/canonicalUuid';
import { isDomainErrorCode, type DomainErrorCode } from './src/domain/errors';
import {
  createRetryMainAppImportDraft,
  MAIN_APP_IMPORT_MAX_ITEMS,
  type MainAppImportDraft,
} from './src/domain/mainAppImport';
import { nativeAdapter } from './src/infrastructure/nativeAdapter';
import { mainAppPicker } from './src/infrastructure/mainAppPickers';
import {
  createEmptyDraftPack,
  persistenceInboxProcessor,
} from './src/infrastructure/persistence/runtime';
import { PackLibraryScreen } from './src/features/packLibrary/PackLibraryScreen';
import {
  packLibraryController,
  subscribeRecoveredPackProcessingCompletions,
  subscribePackProcessingFailures,
} from './src/features/packLibrary/runtime';
import { NewPackFlow, type NewPackFlowHandle } from './src/ui/NewPackFlow';
import { t, type AppLocale } from './src/ui/i18n';
import { colors, spacing, typography } from './src/ui/tokens';

type Screen = 'inbox' | 'detail' | 'diagnostics' | 'new-pack';
type LoadState = InboxWorkflowState;
const PIPELINE_RECOVERY_POLL_MS = 60_000;
const PIPELINE_RECOVERY_RETRY_MS = 1_000;

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('inbox');
  const [locale, setLocale] = useState<AppLocale>('en');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [emptyDraftError, setEmptyDraftError] = useState<string>();
  const [pendingEmptyDraftPackId, setPendingEmptyDraftPackId] =
    useState<string>();
  const [creatingEmptyDraft, setCreatingEmptyDraft] = useState(false);
  const [packCreationReady, setPackCreationReady] = useState(false);
  const [selectedDetailPackId, setSelectedDetailPackId] = useState<string>();
  const [retryDraft, setRetryDraft] = useState<MainAppImportDraft>();
  const [retryDraftError, setRetryDraftError] = useState<string>();
  const [pipelineRecoveryError, setPipelineRecoveryError] = useState<string>();
  const [processingRefreshRevision, setProcessingRefreshRevision] = useState(0);
  const scrollView = useRef<ScrollView | null>(null);
  const newPackFlow = useRef<NewPackFlowHandle | null>(null);
  const screenRef = useRef<Screen>('inbox');
  const workflow = useRef<InboxEventWorkflow | null>(null);
  const appMounted = useRef(true);
  const processingRecoveryInFlight = useRef<Promise<boolean> | null>(null);
  screenRef.current = screen;
  const setWorkflowState = useCallback((value: LoadState) => {
    setState(value);
    setPackCreationReady(
      value.kind !== 'loading' &&
        workflow.current?.isPackCreationReady() === true,
    );
    if (value.kind === 'error' && screenRef.current !== 'new-pack')
      setScreen('inbox');
  }, []);
  const selectDetailPack = useCallback((packId: string) => {
    setSelectedDetailPackId(packId);
    setRetryDraftError(undefined);
  }, []);
  const refreshAfterPackMutation = useCallback(
    () => workflow.current?.appBecameActive() ?? Promise.resolve(),
    [],
  );
  const recoverProcessing = useCallback((): Promise<boolean> => {
    if (processingRecoveryInFlight.current)
      return processingRecoveryInFlight.current;
    let attempt: Promise<boolean>;
    attempt = packLibraryController
      .recoverProcessing()
      .then(() => true)
      .catch(error => {
        if (appMounted.current)
          setPipelineRecoveryError(
            appErrorCode(error, 'PIPELINE_RECOVERY_REQUIRED'),
          );
        return false;
      })
      .finally(() => {
        if (processingRecoveryInFlight.current === attempt)
          processingRecoveryInFlight.current = null;
      });
    processingRecoveryInFlight.current = attempt;
    return attempt;
  }, []);
  if (!workflow.current)
    workflow.current = new InboxEventWorkflow(
      nativeAdapter,
      {
        setState: setWorkflowState,
        showNewestImport: () => {
          if (screenRef.current !== 'new-pack') {
            setSelectedDetailPackId(undefined);
            setScreen('detail');
          }
        },
      },
      persistenceInboxProcessor,
    );
  const effectivePackCreationReady = packCreationReady && !creatingEmptyDraft;
  useEffect(() => {
    let mounted = true;
    appMounted.current = true;
    let recoveryRetry: ReturnType<typeof setTimeout> | undefined;
    const recoverWithBoundedRetry = async (): Promise<void> => {
      const recovered = await recoverProcessing();
      if (!recovered && mounted && recoveryRetry === undefined)
        recoveryRetry = setTimeout(() => {
          recoveryRetry = undefined;
          if (mounted) recoverProcessing().catch(() => undefined);
        }, PIPELINE_RECOVERY_RETRY_MS);
    };
    const unsubscribeProcessingFailures = subscribePackProcessingFailures(
      code => {
        if (mounted) setPipelineRecoveryError(code);
      },
    );
    const unsubscribeProcessingCompletions =
      subscribeRecoveredPackProcessingCompletions(() => {
        if (mounted) setProcessingRefreshRevision(value => value + 1);
      });
    recoverWithBoundedRetry().catch(() => undefined);
    const recoveryPoll = setInterval(
      () => recoverWithBoundedRetry().catch(() => undefined),
      PIPELINE_RECOVERY_POLL_MS,
    );
    workflow.current?.bootstrap().finally(() => {
      if (mounted)
        setPackCreationReady(workflow.current?.isPackCreationReady() === true);
    });
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') {
        workflow.current?.appBecameActive();
        recoverWithBoundedRetry().catch(() => undefined);
      }
    });
    const inboxSubscription = DeviceEventEmitter.addListener(
      'AIContextPackInboxChanged',
      (event: unknown) => {
        workflow.current?.receive(event);
      },
    );
    const openPackSubscription = DeviceEventEmitter.addListener(
      'AIContextPackOpenPack',
      (event: unknown) => {
        if (
          screenRef.current === 'new-pack' ||
          typeof event !== 'object' ||
          event === null
        )
          return;
        const packId = (event as { readonly packId?: unknown }).packId;
        if (!isCanonicalUuid(packId)) return;
        setSelectedDetailPackId(packId);
        setRetryDraftError(undefined);
        setScreen('detail');
      },
    );
    const backSubscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (screenRef.current !== 'new-pack') return false;
        newPackFlow.current?.cancel().catch(() => undefined);
        return true;
      },
    );
    return () => {
      mounted = false;
      appMounted.current = false;
      clearInterval(recoveryPoll);
      if (recoveryRetry !== undefined) clearTimeout(recoveryRetry);
      subscription.remove();
      inboxSubscription.remove();
      openPackSubscription.remove();
      backSubscription.remove();
      unsubscribeProcessingFailures();
      unsubscribeProcessingCompletions();
    };
  }, [recoverProcessing]);
  useEffect(() => {
    scrollView.current?.scrollTo({ animated: false, y: 0 });
  }, [screen]);
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView
        ref={scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            AI Context Pack
          </Text>
          <Text style={styles.subtitle}>{t(locale, 'appSubtitle')}</Text>
          <View accessibilityRole="radiogroup" style={styles.headerActions}>
            <Action
              label={t(locale, 'languageEnglish')}
              onPress={() => setLocale('en')}
              role="radio"
              selected={locale === 'en'}
            />
            <Action
              label={t(locale, 'languageChinese')}
              onPress={() => setLocale('zh-Hans')}
              role="radio"
              selected={locale === 'zh-Hans'}
            />
          </View>
          {screen !== 'new-pack' ? (
            <View style={styles.headerActions}>
              <Action
                disabled={!effectivePackCreationReady}
                label={t(locale, 'newPack')}
                onPress={() => {
                  if (!effectivePackCreationReady) return;
                  setSelectedDetailPackId(undefined);
                  setRetryDraft(undefined);
                  setRetryDraftError(undefined);
                  setScreen('new-pack');
                }}
              />
              <Action
                disabled={!effectivePackCreationReady}
                label={t(locale, 'createEmptyDraft')}
                onPress={async () => {
                  if (!effectivePackCreationReady) return;
                  setCreatingEmptyDraft(true);
                  setEmptyDraftError(undefined);
                  setPendingEmptyDraftPackId(undefined);
                  try {
                    const created = await createEmptyDraftPack();
                    setPendingEmptyDraftPackId(created.id);
                    const activeWorkflow = workflow.current;
                    if (!activeWorkflow) {
                      setEmptyDraftError('INBOX_SCAN_FAILED');
                      return;
                    }
                    const refreshed =
                      await activeWorkflow.refreshForCreatedPack(created.id);
                    setSelectedDetailPackId(refreshed.id);
                    setPendingEmptyDraftPackId(undefined);
                    setScreen('detail');
                  } catch (error) {
                    setEmptyDraftError(appErrorCode(error));
                  } finally {
                    setCreatingEmptyDraft(false);
                  }
                }}
              />
            </View>
          ) : null}
          {emptyDraftError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {emptyDraftError}
            </Text>
          ) : null}
        </View>
        {screen !== 'new-pack' ? (
          <View accessibilityRole="tablist" style={styles.tabs}>
            {(['inbox', 'detail', 'diagnostics'] as const).map(value => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: screen === value }}
                key={value}
                onPress={() => setScreen(value)}
                style={[styles.tab, screen === value && styles.selectedTab]}
              >
                <Text style={styles.tabText}>{tabLabel(locale, value)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {pipelineRecoveryError ? (
          <StateCard
            alert
            title={t(locale, 'processingRecoveryUnavailable')}
            detail={pipelineRecoveryError}
          >
            <Action
              label={t(locale, 'retry')}
              onPress={() => {
                recoverProcessing()
                  .then(recovered => {
                    if (recovered && appMounted.current)
                      setPipelineRecoveryError(undefined);
                  })
                  .catch(() => undefined);
              }}
            />
          </StateCard>
        ) : null}
        <View style={styles.screenContent}>
          {screen === 'inbox' && (
            <Inbox
              locale={locale}
              state={state}
              onRetry={() => {
                const activeWorkflow = workflow.current;
                if (!activeWorkflow) return;
                if (pendingEmptyDraftPackId) {
                  activeWorkflow
                    .refreshForCreatedPack(pendingEmptyDraftPackId)
                    .then(pack => {
                      setSelectedDetailPackId(pack.id);
                      setPendingEmptyDraftPackId(undefined);
                      setEmptyDraftError(undefined);
                      setScreen('detail');
                    })
                    .catch(error => setEmptyDraftError(appErrorCode(error)))
                    .finally(() => {
                      setPackCreationReady(
                        activeWorkflow.isPackCreationReady(),
                      );
                    });
                  return;
                }
                activeWorkflow.retry().finally(() => {
                  const creationReady = activeWorkflow.isPackCreationReady();
                  setPackCreationReady(creationReady);
                  if (creationReady) setEmptyDraftError(undefined);
                });
              }}
            />
          )}
          {screen === 'detail' && (
            <View style={styles.detailStack}>
              <PackLibraryScreen
                controller={packLibraryController}
                locale={locale}
                onChanged={refreshAfterPackMutation}
                onSelectPack={selectDetailPack}
                refreshKey={`${packLibraryRefreshKey(
                  state,
                )}:processing-${processingRefreshRevision}`}
                {...(selectedDetailPackId
                  ? { selectedPackId: selectedDetailPackId }
                  : {})}
              />
              <ImportDetail
                {...(retryDraftError ? { retryError: retryDraftError } : {})}
                creationReady={effectivePackCreationReady}
                locale={locale}
                onRetryFailed={(packId, sources) => {
                  if (!effectivePackCreationReady) return;
                  try {
                    setSelectedDetailPackId(packId);
                    setRetryDraft(createRetryMainAppImportDraft(sources));
                    setRetryDraftError(undefined);
                    setScreen('new-pack');
                  } catch (error) {
                    setRetryDraftError(appErrorCode(error));
                  }
                }}
                onSelectPack={selectDetailPack}
                {...(selectedDetailPackId
                  ? { selectedPackId: selectedDetailPackId }
                  : {})}
                state={state}
              />
            </View>
          )}
          {screen === 'diagnostics' && <Diagnostics locale={locale} />}
          {screen === 'new-pack' && (
            <NewPackFlow
              {...(retryDraft ? { createDraft: () => retryDraft } : {})}
              creationReady={effectivePackCreationReady}
              key={retryDraft?.ingestionId ?? 'new-pack'}
              native={nativeAdapter}
              locale={locale}
              onCancel={() => {
                setRetryDraft(undefined);
                setScreen('inbox');
              }}
              onImported={async () => {
                await workflow.current?.refreshForMainAppImport();
              }}
              picker={mainAppPicker}
              ref={newPackFlow}
            />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Inbox({
  state,
  onRetry,
  locale,
}: {
  state: LoadState;
  onRetry: () => void;
  locale: AppLocale;
}): React.JSX.Element {
  if (state.kind === 'loading')
    return (
      <StateCard title={t(locale, 'scanningInbox')}>
        <ActivityIndicator color={colors.accent} />
      </StateCard>
    );
  if (state.kind === 'error')
    return (
      <StateCard title={t(locale, 'inboxUnavailable')} detail={state.code}>
        <Action label={t(locale, 'retry')} onPress={onRetry} />
      </StateCard>
    );
  if (state.kind === 'empty')
    return (
      <View>
        {state.warningCode ? (
          <StateCard
            title={t(locale, 'inboxUnavailable')}
            detail={state.warningCode}
          >
            <Action label={t(locale, 'retry')} onPress={onRetry} />
          </StateCard>
        ) : null}
        <StateCard
          title={t(locale, 'inboxEmpty')}
          detail={t(locale, 'inboxEmptyDetail')}
        />
      </View>
    );
  if (state.packs)
    return (
      <View>
        {state.warningCode ? (
          <StateCard
            title={t(locale, 'inboxUnavailable')}
            detail={state.warningCode}
          >
            <Action label={t(locale, 'retry')} onPress={onRetry} />
          </StateCard>
        ) : null}
        {state.packs.map(pack => (
          <StateCard
            key={pack.id}
            title={pack.title}
            detail={`${t(locale, 'itemState', {
              count: pack.itemCount,
              state: localizedPackState(locale, pack.state),
            })}${
              pack.import
                ? `\n${persistedImportSummary(locale, pack.import)}`
                : ''
            }`}
          />
        ))}
      </View>
    );
  return (
    <View>
      {state.warningCode ? (
        <StateCard
          title={t(locale, 'inboxUnavailable')}
          detail={state.warningCode}
        >
          <Action label={t(locale, 'retry')} onPress={onRetry} />
        </StateCard>
      ) : null}
      {state.manifests.map(manifest => (
        <StateCard
          key={manifest.ingestionId}
          title={t(locale, 'shareImport')}
          detail={manifestSummary(locale, manifest)}
        />
      ))}
    </View>
  );
}

function ImportDetail({
  state,
  creationReady,
  onRetryFailed,
  onSelectPack,
  selectedPackId,
  retryError,
  locale,
}: {
  state: LoadState;
  creationReady: boolean;
  onRetryFailed: (
    packId: string,
    sources: readonly {
      readonly mediaType: string;
      readonly byteCount: number;
      readonly ownedRelativePath: string;
      readonly sha256: string;
    }[],
  ) => void;
  onSelectPack: (packId: string) => void;
  selectedPackId?: string;
  retryError?: string;
  locale: AppLocale;
}): React.JSX.Element {
  const packs = state.kind === 'ready' ? state.packs ?? [] : [];
  const pack = selectedPackId
    ? packs.find(value => value.id === selectedPackId)
    : packs[0];
  const manifest = state.kind === 'ready' ? state.manifests[0] : undefined;
  const persistedImport = pack?.import;
  const retrySources =
    persistedImport?.items.flatMap(item =>
      item.status === 'failed' && item.retrySource
        ? [
            {
              mediaType: item.mediaType,
              byteCount: item.retrySource.byteCount,
              ownedRelativePath: item.retrySource.relativePath,
              sha256: item.retrySource.sha256,
            },
          ]
        : [],
    ) ?? [];
  const retryBatches = Array.from(
    { length: Math.ceil(retrySources.length / MAIN_APP_IMPORT_MAX_ITEMS) },
    (_, index) => {
      const start = index * MAIN_APP_IMPORT_MAX_ITEMS;
      const end = Math.min(
        start + MAIN_APP_IMPORT_MAX_ITEMS,
        retrySources.length,
      );
      return {
        start,
        end,
        sources: retrySources.slice(start, end),
      };
    },
  );
  return (
    <StateCard
      title={t(locale, 'importDetail')}
      detail={
        pack
          ? `${t(locale, 'id')} ${pack.id}\n${t(locale, 'schema')} ${
              pack.schemaVersion
            }\n${t(locale, 'items')} ${pack.itemCount}${
              persistedImport
                ? `\n${persistedImportSummary(
                    locale,
                    persistedImport,
                  )}\n${persistedImportItemSummary(locale, persistedImport)}`
                : ''
            }`
          : manifest
          ? `${t(locale, 'id')} ${manifest.ingestionId}\n${t(
              locale,
              'schema',
            )} ${manifest.schemaVersion}\n${manifestSummary(
              locale,
              manifest,
            )}\n${manifestTypeSummary(
              locale,
              manifest,
            )}\n${manifestFailedItemSummary(locale, manifest)}`
          : t(locale, 'noImportSelected')
      }
    >
      {packs.length > 1 ? (
        <View accessibilityRole="radiogroup" style={styles.detailPackChoices}>
          {packs.map((candidate, index) => (
            <Action
              key={candidate.id}
              label={t(locale, 'selectPack', { position: index + 1 })}
              onPress={() => onSelectPack(candidate.id)}
              role="radio"
              selected={candidate.id === pack?.id}
            />
          ))}
        </View>
      ) : null}
      {retryBatches.map(batch => (
        <Action
          disabled={!creationReady}
          key={`${batch.start}-${batch.end}`}
          label={`${t(locale, 'retryFailedItems')}${
            retryBatches.length > 1 ? ` ${batch.start + 1}–${batch.end}` : ''
          }`}
          onPress={() => {
            if (creationReady && pack) onRetryFailed(pack.id, batch.sources);
          }}
        />
      ))}
      {retryError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {retryError}
        </Text>
      ) : null}
    </StateCard>
  );
}

function manifestSummary(
  locale: AppLocale,
  manifest: ImportManifestV1,
): string {
  const copied = manifest.items.filter(item => item.status === 'copied').length;
  const rejected = manifest.items.filter(
    item =>
      item.status === 'failed' &&
      (item.errorCode === 'IMPORT_TYPE_UNSUPPORTED' ||
        item.errorCode === 'IMPORT_SIZE_LIMIT_EXCEEDED'),
  ).length;
  const failed = manifest.items.length - copied - rejected;
  return `${copied} ${t(locale, 'accepted')} · ${rejected} ${t(
    locale,
    'rejected',
  )} · ${failed} ${t(locale, 'failed')} · ${localizedImportStatus(
    locale,
    manifest.status,
  )}`;
}

function manifestTypeSummary(
  locale: AppLocale,
  manifest: ImportManifestV1,
): string {
  const counts = new Map<string, number>();
  manifest.items.forEach(item =>
    counts.set(item.mediaType, (counts.get(item.mediaType) ?? 0) + 1),
  );
  const values = [...counts.entries()].map(
    ([mediaType, count]) => `${mediaType} × ${count}`,
  );
  return values.length === 0
    ? t(locale, 'typesNone')
    : t(locale, 'types', { types: values.join(', ') });
}

function persistedImportSummary(
  locale: AppLocale,
  value: InboxPersistedImportSummary,
): string {
  const copied = value.items.filter(item => item.status === 'copied').length;
  const rejected = value.items.filter(
    item =>
      item.status === 'failed' &&
      (item.errorCode === 'IMPORT_TYPE_UNSUPPORTED' ||
        item.errorCode === 'IMPORT_SIZE_LIMIT_EXCEEDED'),
  ).length;
  return `${copied} ${t(locale, 'accepted')} · ${rejected} ${t(
    locale,
    'rejected',
  )} · ${value.items.length - copied - rejected} ${t(
    locale,
    'failed',
  )} · ${localizedImportStatus(locale, value.status)}`;
}

function persistedImportItemSummary(
  locale: AppLocale,
  value: InboxPersistedImportSummary,
): string {
  const failures = value.items.filter(item => item.status === 'failed');
  return failures.length === 0
    ? t(locale, 'importErrorsNone')
    : failures
        .map(
          item =>
            `${t(locale, 'item')} ${item.order + 1} · ${item.mediaType} · ${
              item.errorCode ?? 'IMPORT_COPY_FAILED'
            }`,
        )
        .join('\n');
}

function manifestFailedItemSummary(
  locale: AppLocale,
  manifest: ImportManifestV1,
): string {
  const failures = manifest.items.filter(item => item.status === 'failed');
  return failures.length === 0
    ? t(locale, 'importErrorsNone')
    : failures
        .map(
          item =>
            `${t(locale, 'item')} ${item.order + 1} · ${item.mediaType} · ${
              item.errorCode
            }`,
        )
        .join('\n');
}

function Diagnostics({ locale }: { locale: AppLocale }): React.JSX.Element {
  return (
    <StateCard
      title={t(locale, 'diagnostics')}
      detail={t(locale, 'diagnosticsDetail', {
        boundary: t(
          locale,
          nativeAdapter.available ? 'nativeAvailable' : 'nativeFallback',
        ),
      })}
    />
  );
}

function StateCard({
  title,
  detail,
  children,
  alert = false,
}: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
  alert?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <View
        accessibilityLiveRegion={alert ? 'assertive' : undefined}
        accessibilityRole={alert ? 'alert' : undefined}
        accessible={alert || undefined}
      >
        <Text style={styles.cardTitle}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {children}
    </View>
  );
}
function Action({
  label,
  onPress,
  disabled = false,
  selected,
  role = 'button',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  role?: 'button' | 'radio';
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole={role}
      accessibilityState={{
        disabled,
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabledAction]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function tabLabel(
  locale: AppLocale,
  screen: Exclude<Screen, 'new-pack'>,
): string {
  if (screen === 'inbox') return t(locale, 'tabInbox');
  if (screen === 'detail') return t(locale, 'tabDetail');
  return t(locale, 'tabDiagnostics');
}

function localizedImportStatus(
  locale: AppLocale,
  status: ImportManifestV1['status'],
): string {
  if (status === 'complete') return t(locale, 'statusComplete');
  if (status === 'partial') return t(locale, 'statusPartial');
  return t(locale, 'statusFailed');
}

function localizedPackState(
  locale: AppLocale,
  state: NonNullable<
    Extract<LoadState, { kind: 'ready' }>['packs']
  >[number]['state'],
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

function appErrorCode(
  error: unknown,
  fallback:
    | DomainErrorCode
    | 'EMPTY_DRAFT_CREATE_FAILED' = 'EMPTY_DRAFT_CREATE_FAILED',
): DomainErrorCode | 'EMPTY_DRAFT_CREATE_FAILED' {
  if (typeof error !== 'object' || error === null) return fallback;
  const value = error as { readonly code?: unknown };
  return isDomainErrorCode(value.code) ? value.code : fallback;
}

function packLibraryRefreshKey(state: LoadState): string {
  if (state.kind !== 'ready') return state.kind;
  return (state.packs ?? [])
    .map(pack => `${pack.id}:${pack.updatedAt}:${pack.state}:${pack.itemCount}`)
    .join('|');
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  title: { ...typography.title, color: colors.text },
  subtitle: { ...typography.body, color: colors.muted },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  tab: {
    padding: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  selectedTab: { backgroundColor: colors.accent },
  tabText: {
    ...typography.label,
    color: colors.text,
    textTransform: 'capitalize',
  },
  content: { flexGrow: 1, paddingBottom: spacing.lg },
  screenContent: { padding: spacing.lg },
  detailPackChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  detailStack: { gap: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { ...typography.heading, color: colors.text },
  detail: { ...typography.body, color: colors.muted },
  action: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionText: { ...typography.label, color: colors.text },
  disabledAction: { opacity: 0.45 },
  error: { ...typography.body, color: '#FCA5A5' },
});
export default App;
