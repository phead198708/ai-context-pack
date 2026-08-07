import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
  type InboxWorkflowState,
} from './src/domain/inboxEventWorkflow';
import type { ImportManifestV1 } from './src/domain/contracts';
import { nativeAdapter } from './src/infrastructure/nativeAdapter';
import { persistenceInboxProcessor } from './src/infrastructure/persistence/runtime';
import { colors, spacing, typography } from './src/ui/tokens';

type Screen = 'inbox' | 'detail' | 'diagnostics';
type LoadState = InboxWorkflowState;

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('inbox');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const setWorkflowState = useCallback((value: LoadState) => {
    setState(value);
    if (value.kind === 'error') setScreen('inbox');
  }, []);
  const workflow = useRef<InboxEventWorkflow | null>(null);
  if (!workflow.current)
    workflow.current = new InboxEventWorkflow(
      nativeAdapter,
      {
        setState: setWorkflowState,
        showNewestImport: () => setScreen('detail'),
      },
      persistenceInboxProcessor,
    );
  useEffect(() => {
    workflow.current?.bootstrap();
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') workflow.current?.appBecameActive();
    });
    const inboxSubscription = DeviceEventEmitter.addListener(
      'AIContextPackInboxChanged',
      (event: unknown) => {
        workflow.current?.receive(event);
      },
    );
    return () => {
      subscription.remove();
      inboxSubscription.remove();
    };
  }, []);
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          AI Context Pack
        </Text>
        <Text style={styles.subtitle}>Local-first import foundation</Text>
      </View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {(['inbox', 'detail', 'diagnostics'] as const).map(value => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: screen === value }}
            key={value}
            onPress={() => setScreen(value)}
            style={[styles.tab, screen === value && styles.selectedTab]}
          >
            <Text style={styles.tabText}>{value}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {screen === 'inbox' && (
          <Inbox
            state={state}
            onRetry={() => {
              workflow.current?.retry();
            }}
          />
        )}
        {screen === 'detail' && <ImportDetail state={state} />}
        {screen === 'diagnostics' && <Diagnostics />}
      </ScrollView>
    </SafeAreaView>
  );
}

function Inbox({
  state,
  onRetry,
}: {
  state: LoadState;
  onRetry: () => void;
}): React.JSX.Element {
  if (state.kind === 'loading')
    return (
      <StateCard title="Scanning Inbox">
        <ActivityIndicator color={colors.accent} />
      </StateCard>
    );
  if (state.kind === 'error')
    return (
      <StateCard title="Inbox unavailable" detail={state.code}>
        <Action label="Retry" onPress={onRetry} />
      </StateCard>
    );
  if (state.kind === 'empty')
    return (
      <StateCard
        title="Inbox is empty"
        detail="Share a synthetic image to this app, then open it again."
      />
    );
  if (state.packs)
    return (
      <View>
        {state.packs.map(pack => (
          <StateCard
            key={pack.id}
            title={pack.title}
            detail={`${pack.itemCount} item · ${pack.state}`}
          />
        ))}
      </View>
    );
  return (
    <View>
      {state.manifests.map(manifest => (
        <StateCard
          key={manifest.ingestionId}
          title="Share import"
          detail={manifestSummary(manifest)}
        />
      ))}
    </View>
  );
}

function ImportDetail({ state }: { state: LoadState }): React.JSX.Element {
  const pack = state.kind === 'ready' ? state.packs?.[0] : undefined;
  const manifest = state.kind === 'ready' ? state.manifests[0] : undefined;
  return (
    <StateCard
      title="Import detail"
      detail={
        pack
          ? `ID ${pack.id}\nSchema ${pack.schemaVersion}\nItems ${pack.itemCount}`
          : manifest
          ? `ID ${manifest.ingestionId}\nSchema ${
              manifest.schemaVersion
            }\n${manifestSummary(manifest)}\n${manifestTypeSummary(manifest)}`
          : 'No import selected.'
      }
    />
  );
}

function manifestSummary(manifest: ImportManifestV1): string {
  const copied = manifest.items.filter(item => item.status === 'copied').length;
  const rejected = manifest.items.filter(
    item =>
      item.status === 'failed' &&
      (item.errorCode === 'IMPORT_TYPE_UNSUPPORTED' ||
        item.errorCode === 'IMPORT_SIZE_LIMIT_EXCEEDED'),
  ).length;
  const failed = manifest.items.length - copied - rejected;
  return `${copied} accepted · ${rejected} rejected · ${failed} failed · ${manifest.status}`;
}

function manifestTypeSummary(manifest: ImportManifestV1): string {
  const counts = new Map<string, number>();
  manifest.items.forEach(item =>
    counts.set(item.mediaType, (counts.get(item.mediaType) ?? 0) + 1),
  );
  const values = [...counts.entries()].map(
    ([mediaType, count]) => `${mediaType} × ${count}`,
  );
  return values.length === 0 ? 'Types none' : `Types ${values.join(', ')}`;
}

function Diagnostics(): React.JSX.Element {
  return (
    <StateCard
      title="Diagnostics"
      detail={`React Native: 0.86\nArchitecture: New\nHermes: enabled\nNative boundary: ${
        nativeAdapter.available ? 'available' : 'preview fallback'
      }\nPrivacy logging: metadata only`}
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
}: {
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.action}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  title: { ...typography.title, color: colors.text },
  subtitle: { ...typography.body, color: colors.muted },
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
  content: { padding: spacing.lg },
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
});
export default App;
