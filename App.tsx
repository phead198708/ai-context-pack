import React, { useEffect, useState } from 'react';
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
import type { ImportManifestV1 } from './src/domain/contracts';
import { nativeAdapter } from './src/infrastructure/nativeAdapter';
import { colors, spacing, typography } from './src/ui/tokens';

type Screen = 'inbox' | 'detail' | 'diagnostics';
type LoadState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; manifests: readonly ImportManifestV1[] }
  | { kind: 'error'; code: string };

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('inbox');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const refresh = async (showNewestImport = false): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const manifests = await nativeAdapter.scanInbox();
      setState(
        manifests.length === 0
          ? { kind: 'empty' }
          : { kind: 'ready', manifests },
      );
      if (showNewestImport && manifests.length > 0) setScreen('detail');
    } catch {
      setState({ kind: 'error', code: 'INBOX_SCAN_FAILED' });
    }
  };
  useEffect(() => {
    refresh(true).catch(() =>
      setState({ kind: 'error', code: 'INBOX_SCAN_FAILED' }),
    );
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active')
        refresh(true).catch(() =>
          setState({ kind: 'error', code: 'INBOX_SCAN_FAILED' }),
        );
    });
    const inboxSubscription = DeviceEventEmitter.addListener(
      'AIContextPackInboxChanged',
      () => {
        refresh(true).catch(() =>
          setState({ kind: 'error', code: 'INBOX_SCAN_FAILED' }),
        );
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
            onRetry={() =>
              refresh().catch(() =>
                setState({ kind: 'error', code: 'INBOX_SCAN_FAILED' }),
              )
            }
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
  return (
    <View>
      {state.manifests.map(manifest => (
        <StateCard
          key={manifest.ingestionId}
          title="Image received"
          detail={`${manifest.items.length} item · ${manifest.status}`}
        />
      ))}
    </View>
  );
}

function ImportDetail({ state }: { state: LoadState }): React.JSX.Element {
  const manifest = state.kind === 'ready' ? state.manifests[0] : undefined;
  return (
    <StateCard
      title="Import detail"
      detail={
        manifest
          ? `ID ${manifest.ingestionId}\nSchema ${manifest.schemaVersion}\nItems ${manifest.items.length}`
          : 'No import selected.'
      }
    />
  );
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
