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
import {
  createRetryMainAppImportDraft,
  type MainAppImportDraft,
} from './src/domain/mainAppImport';
import { nativeAdapter } from './src/infrastructure/nativeAdapter';
import { mainAppPicker } from './src/infrastructure/mainAppPickers';
import {
  createEmptyDraftPack,
  persistenceInboxProcessor,
} from './src/infrastructure/persistence/runtime';
import { NewPackFlow, type NewPackFlowHandle } from './src/ui/NewPackFlow';
import { t, type AppLocale } from './src/ui/i18n';
import { colors, spacing, typography } from './src/ui/tokens';

type Screen = 'inbox' | 'detail' | 'diagnostics' | 'new-pack';
type LoadState = InboxWorkflowState;

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('inbox');
  const [locale, setLocale] = useState<AppLocale>('en');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [emptyDraftError, setEmptyDraftError] = useState<string>();
  const [creatingEmptyDraft, setCreatingEmptyDraft] = useState(false);
  const [packCreationReady, setPackCreationReady] = useState(false);
  const [retryDraft, setRetryDraft] = useState<MainAppImportDraft>();
  const [retryDraftError, setRetryDraftError] = useState<string>();
  const scrollView = useRef<ScrollView | null>(null);
  const newPackFlow = useRef<NewPackFlowHandle | null>(null);
  const screenRef = useRef<Screen>('inbox');
  const workflow = useRef<InboxEventWorkflow | null>(null);
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
  if (!workflow.current)
    workflow.current = new InboxEventWorkflow(
      nativeAdapter,
      {
        setState: setWorkflowState,
        showNewestImport: () => {
          if (screenRef.current !== 'new-pack') setScreen('detail');
        },
      },
      persistenceInboxProcessor,
    );
  useEffect(() => {
    let mounted = true;
    workflow.current?.bootstrap().finally(() => {
      if (mounted)
        setPackCreationReady(workflow.current?.isPackCreationReady() === true);
    });
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') workflow.current?.appBecameActive();
    });
    const inboxSubscription = DeviceEventEmitter.addListener(
      'AIContextPackInboxChanged',
      (event: unknown) => {
        workflow.current?.receive(event);
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
      subscription.remove();
      inboxSubscription.remove();
      backSubscription.remove();
    };
  }, []);
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
                disabled={!packCreationReady}
                label={t(locale, 'newPack')}
                onPress={() => {
                  setRetryDraft(undefined);
                  setRetryDraftError(undefined);
                  setScreen('new-pack');
                }}
              />
              <Action
                disabled={creatingEmptyDraft || !packCreationReady}
                label={t(locale, 'createEmptyDraft')}
                onPress={async () => {
                  setCreatingEmptyDraft(true);
                  setEmptyDraftError(undefined);
                  try {
                    await createEmptyDraftPack();
                    await workflow.current?.appBecameActive();
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
        <View style={styles.screenContent}>
          {screen === 'inbox' && (
            <Inbox
              locale={locale}
              state={state}
              onRetry={() => {
                workflow.current?.retry().finally(() => {
                  setPackCreationReady(
                    workflow.current?.isPackCreationReady() === true,
                  );
                });
              }}
            />
          )}
          {screen === 'detail' && (
            <ImportDetail
              {...(retryDraftError ? { retryError: retryDraftError } : {})}
              locale={locale}
              onRetryFailed={sources => {
                try {
                  setRetryDraft(createRetryMainAppImportDraft(sources));
                  setRetryDraftError(undefined);
                  setScreen('new-pack');
                } catch (error) {
                  setRetryDraftError(appErrorCode(error));
                }
              }}
              state={state}
            />
          )}
          {screen === 'diagnostics' && <Diagnostics locale={locale} />}
          {screen === 'new-pack' && (
            <NewPackFlow
              {...(retryDraft ? { createDraft: () => retryDraft } : {})}
              creationReady={packCreationReady}
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
  onRetryFailed,
  retryError,
  locale,
}: {
  state: LoadState;
  onRetryFailed: (
    sources: readonly {
      readonly mediaType: string;
      readonly byteCount: number;
      readonly ownedRelativePath: string;
      readonly sha256: string;
    }[],
  ) => void;
  retryError?: string;
  locale: AppLocale;
}): React.JSX.Element {
  const pack = state.kind === 'ready' ? state.packs?.[0] : undefined;
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
      {retrySources.length > 0 ? (
        <Action
          label={t(locale, 'retryFailedItems')}
          onPress={() => onRetryFailed(retrySources)}
        />
      ) : null}
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
}: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
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

function appErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null)
    return 'EMPTY_DRAFT_CREATE_FAILED';
  const value = error as { readonly code?: unknown };
  return typeof value.code === 'string'
    ? value.code
    : 'EMPTY_DRAFT_CREATE_FAILED';
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
