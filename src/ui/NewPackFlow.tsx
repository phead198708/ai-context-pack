import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ImportManifestV1 } from '../domain/contracts';
import {
  appendPickerAssets,
  appendTextEntry,
  createMainAppImportDraft,
  moveImportItem,
  pickerFileUris,
  removeImportItem,
  summarizeMainAppImport,
  type MainAppImportDraft,
} from '../domain/mainAppImport';
import type { NativeAdapter } from '../domain/nativeAdapter';
import type { MainAppPicker } from '../infrastructure/mainAppPickers';
import { colors, spacing, typography } from './tokens';

export interface NewPackFlowProps {
  readonly native: NativeAdapter;
  readonly picker: MainAppPicker;
  readonly onCancel: () => void;
  readonly onImported: (manifest: ImportManifestV1) => Promise<void>;
  readonly createDraft?: () => MainAppImportDraft;
}

export interface NewPackFlowHandle {
  cancel(): Promise<void>;
}

export const NewPackFlow = React.forwardRef<
  NewPackFlowHandle,
  NewPackFlowProps
>(function NewPackFlowComponent(
  {
    native,
    picker,
    onCancel,
    onImported,
    createDraft = createMainAppImportDraft,
  },
  ref,
): React.JSX.Element {
  const [draft, setDraft] = useState(createDraft);
  const [textEntry, setTextEntry] = useState('');
  const [urlEntry, setUrlEntry] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportManifestV1>();
  const [pendingCleanupUris, setPendingCleanupUris] = useState<
    readonly string[]
  >([]);
  const summary = useMemo(() => summarizeMainAppImport(draft), [draft]);

  const cancel = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fileUris = uniqueUris(pickerFileUris(draft), pendingCleanupUris);
      if (fileUris.length > 0) await native.discardMainAppPickerFiles(fileUris);
      setPendingCleanupUris([]);
      onCancel();
    } catch (error) {
      setMessage(stableErrorCode(error, 'MAIN_APP_IMPORT_CLEANUP_FAILED'));
    } finally {
      setBusy(false);
    }
  }, [busy, draft, native, onCancel, pendingCleanupUris]);

  React.useImperativeHandle(
    ref,
    () => ({
      cancel,
    }),
    [cancel],
  );

  if (result)
    return (
      <View accessibilityLiveRegion="polite" style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>
          Import {result.status}
        </Text>
        <Text style={styles.body}>
          {result.items.filter(item => item.status === 'copied').length}{' '}
          accepted ·{' '}
          {result.items.filter(item => item.status === 'failed').length} failed
        </Text>
        {result.items.map(item => (
          <View key={item.id} style={styles.item}>
            <Text style={styles.itemTitle}>Item {item.order + 1}</Text>
            <Text style={styles.body}>
              {item.mediaType} · {item.status}
              {item.status === 'failed' ? ` · ${item.errorCode}` : ''}
            </Text>
          </View>
        ))}
        <FlowButton label="Done" onPress={onCancel} />
      </View>
    );

  const pick = async (kind: 'photos' | 'files') => {
    setBusy(true);
    setMessage(undefined);
    try {
      const picked =
        kind === 'photos'
          ? await picker.pickPhotos()
          : await picker.pickFiles();
      if (picked.canceled) {
        setMessage(
          'Selection canceled. No Pack or temporary item was created.',
        );
        return;
      }
      const edited = appendPickerAssets(draft, picked.assets);
      if (edited.error) {
        const rejectedUris = picked.assets.map(asset => asset.uri);
        try {
          await native.discardMainAppPickerFiles(rejectedUris);
        } catch (error) {
          setPendingCleanupUris(current => uniqueUris(current, rejectedUris));
          throw error;
        }
        setMessage(edited.error);
        return;
      }
      setDraft(edited.draft);
    } catch (error) {
      setMessage(stableErrorCode(error, 'PICKER_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  const addEntry = (kind: 'text' | 'url') => {
    const value = kind === 'text' ? textEntry : urlEntry;
    const edited = appendTextEntry(draft, kind, value);
    if (edited.error) {
      setMessage(edited.error);
      return;
    }
    setDraft(edited.draft);
    setMessage(undefined);
    if (kind === 'text') setTextEntry('');
    else setUrlEntry('');
  };

  const remove = async (id: string) => {
    const item = draft.items.find(value => value.id === id);
    if (!item) return;
    setBusy(true);
    try {
      if (item.kind === 'file')
        await native.discardMainAppPickerFiles([item.fileUri]);
      setDraft(current => removeImportItem(current, id));
      setMessage(undefined);
    } catch (error) {
      setMessage(stableErrorCode(error, 'MAIN_APP_IMPORT_CLEANUP_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  const retryPendingCleanup = async () => {
    if (pendingCleanupUris.length === 0 || busy) return;
    setBusy(true);
    try {
      await native.discardMainAppPickerFiles(pendingCleanupUris);
      setPendingCleanupUris([]);
      setMessage(undefined);
    } catch (error) {
      setMessage(stableErrorCode(error, 'MAIN_APP_IMPORT_CLEANUP_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (draft.items.length === 0 || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const manifest = await native.publishMainAppImport(
        draft.ingestionId,
        summary.source,
        draft.items,
      );
      await onImported(manifest);
      setResult(manifest);
    } catch (error) {
      setMessage(stableErrorCode(error, 'MAIN_APP_IMPORT_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        New Pack
      </Text>
      <Text style={styles.body}>
        Add photos, PDF or text files, pasted text, and HTTP(S) URLs. Supported
        content is copied locally before processing.
      </Text>
      <View style={styles.row}>
        <FlowButton
          disabled={busy}
          label="Add Photos"
          onPress={() => pick('photos')}
        />
        <FlowButton
          disabled={busy}
          label="Add Files"
          onPress={() => pick('files')}
        />
      </View>
      <TextInput
        accessibilityLabel="Text to add"
        multiline
        onChangeText={setTextEntry}
        placeholder="Paste text, code, 中文, or emoji"
        placeholderTextColor={colors.muted}
        style={[styles.input, styles.multiline]}
        value={textEntry}
      />
      <FlowButton
        disabled={busy || textEntry.length === 0}
        label="Add Text"
        onPress={() => addEntry('text')}
      />
      <TextInput
        accessibilityLabel="URL to add"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={setUrlEntry}
        placeholder="https://example.invalid/path"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={urlEntry}
      />
      <FlowButton
        disabled={busy || urlEntry.length === 0}
        label="Add URL"
        onPress={() => addEntry('url')}
      />

      <View accessibilityLiveRegion="polite" style={styles.summary}>
        <Text style={styles.itemTitle}>
          {summary.selectedCount} selected ·{' '}
          {formatBytes(summary.estimatedByteCount)} estimated
        </Text>
        <Text style={styles.body}>
          {summary.typeCounts.length === 0
            ? 'Supported types: images, PDF, plain text, URLs'
            : summary.typeCounts
                .map(value => `${value.mediaType} × ${value.count}`)
                .join(' · ')}
        </Text>
      </View>

      {summary.items.map(item => (
        <View key={item.id} style={styles.item}>
          <Text style={styles.itemTitle}>{item.label}</Text>
          <Text style={styles.body}>
            {item.mediaType} · {formatBytes(item.byteCount)}
            {item.code ? ` · ${item.code}` : ''}
          </Text>
          <View style={styles.row}>
            <FlowButton
              disabled={busy || item.order === 0}
              label={`Move ${item.label} up`}
              onPress={() =>
                setDraft(current => moveImportItem(current, item.id, -1))
              }
            />
            <FlowButton
              disabled={busy || item.order === summary.items.length - 1}
              label={`Move ${item.label} down`}
              onPress={() =>
                setDraft(current => moveImportItem(current, item.id, 1))
              }
            />
            <FlowButton
              disabled={busy}
              label={`Remove ${item.label}`}
              onPress={() => remove(item.id)}
            />
          </View>
        </View>
      ))}

      {message ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {message}
        </Text>
      ) : null}
      {pendingCleanupUris.length > 0 ? (
        <FlowButton
          disabled={busy}
          label="Retry Temporary Cleanup"
          onPress={retryPendingCleanup}
        />
      ) : null}
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      <View style={styles.row}>
        <FlowButton
          disabled={
            busy || draft.items.length === 0 || pendingCleanupUris.length > 0
          }
          label="Import Pack"
          onPress={commit}
        />
        <FlowButton disabled={busy} label="Cancel New Pack" onPress={cancel} />
      </View>
      {draft.items.length === 0 ? (
        <Text style={styles.body}>
          Import is disabled until at least one item is selected. Use the
          separate Empty Draft action if you want an intentionally empty Pack.
        </Text>
      ) : null}
    </View>
  );
});

function FlowButton({
  label,
  onPress,
  disabled = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
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

function stableErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) return fallback;
  const value = error as { readonly code?: unknown };
  return typeof value.code === 'string' ? value.code : fallback;
}

function uniqueUris(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  return [...new Set([...first, ...second])];
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  heading: { ...typography.heading, color: colors.text },
  body: { ...typography.body, color: colors.muted },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: {
    ...typography.body,
    borderColor: colors.muted,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    minHeight: 48,
    padding: spacing.sm,
  },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  summary: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    gap: spacing.sm,
    padding: spacing.md,
  },
  item: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    gap: spacing.sm,
    padding: spacing.md,
  },
  itemTitle: { ...typography.label, color: colors.text },
  error: { ...typography.body, color: '#FCA5A5' },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  disabled: { opacity: 0.45 },
  buttonText: { ...typography.label, color: colors.text },
});
