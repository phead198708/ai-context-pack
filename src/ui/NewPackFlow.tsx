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
  type MainAppImportInput,
} from '../domain/mainAppImport';
import type { NativeAdapter } from '../domain/nativeAdapter';
import type { MainAppPicker } from '../infrastructure/mainAppPickers';
import { t, type AppLocale } from './i18n';
import { colors, spacing, typography } from './tokens';

export interface NewPackFlowProps {
  readonly native: NativeAdapter;
  readonly picker: MainAppPicker;
  readonly onCancel: () => void;
  readonly onImported: (manifest: ImportManifestV1) => Promise<void>;
  readonly createDraft?: () => MainAppImportDraft;
  readonly locale?: AppLocale;
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
    locale = 'en',
  },
  ref,
): React.JSX.Element {
  const [draft, setDraft] = useState(createDraft);
  const [textEntry, setTextEntry] = useState('');
  const [urlEntry, setUrlEntry] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportManifestV1>();
  const [publicationCommitted, setPublicationCommitted] = useState(false);
  const [transientCleanupRequired, setTransientCleanupRequired] =
    useState(false);
  const [pendingCleanupUris, setPendingCleanupUris] = useState<
    readonly string[]
  >([]);
  const summary = useMemo(() => summarizeMainAppImport(draft), [draft]);

  const cancel = useCallback(async () => {
    if (busy || publicationCommitted) return;
    setBusy(true);
    try {
      if (transientCleanupRequired) {
        await native.cleanupMainAppPickerTransients();
        setTransientCleanupRequired(false);
      }
      const fileUris = uniqueUris(pickerFileUris(draft), pendingCleanupUris);
      if (fileUris.length > 0) await native.discardMainAppPickerFiles(fileUris);
      setPendingCleanupUris([]);
      onCancel();
    } catch (error) {
      setMessage(stableErrorCode(error, 'MAIN_APP_IMPORT_CLEANUP_FAILED'));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    draft,
    native,
    onCancel,
    pendingCleanupUris,
    publicationCommitted,
    transientCleanupRequired,
  ]);

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
          {t(locale, 'importStatusTitle', {
            status: localizedImportStatus(locale, result.status),
          })}
        </Text>
        <Text style={styles.body}>
          {result.items.filter(item => item.status === 'copied').length}{' '}
          {t(locale, 'accepted')} ·{' '}
          {result.items.filter(item => item.status === 'failed').length}{' '}
          {t(locale, 'failed')}
        </Text>
        {result.items.map(item => (
          <View key={item.id} style={styles.item}>
            <Text style={styles.itemTitle}>
              {t(locale, 'item')} {item.order + 1}
            </Text>
            <Text style={styles.body}>
              {item.mediaType} ·{' '}
              {item.status === 'copied'
                ? t(locale, 'copied')
                : t(locale, 'failed')}
              {item.status === 'failed' ? ` · ${item.errorCode}` : ''}
            </Text>
          </View>
        ))}
        <FlowButton label={t(locale, 'done')} onPress={onCancel} />
      </View>
    );

  const pick = async (kind: 'photos' | 'files') => {
    setBusy(true);
    setMessage(undefined);
    try {
      // Completed selections live in our isolated staging directory. The Expo-owned transient
      // directories can therefore be swept before and after every picker operation without
      // deleting an existing draft selection.
      await native.cleanupMainAppPickerTransients();
      setTransientCleanupRequired(false);
      const picked =
        kind === 'photos'
          ? await picker.pickPhotos()
          : await picker.pickFiles();
      if (picked.canceled) {
        await native.cleanupMainAppPickerTransients();
        setMessage(t(locale, 'selectionCanceled'));
        return;
      }
      const stagedUris = await native.stageMainAppPickerFiles(
        picked.assets.map(asset => asset.uri),
      );
      const stagedAssets = picked.assets.map((asset, index) => ({
        ...asset,
        uri: stagedUris[index]!,
      }));
      const edited = appendPickerAssets(draft, stagedAssets);
      if (edited.error) {
        const rejectedUris = stagedAssets.map(asset => asset.uri);
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
      const pickerCode = stableErrorCode(error, 'PICKER_FAILED');
      try {
        await native.cleanupMainAppPickerTransients();
        setTransientCleanupRequired(false);
        setMessage(pickerCode);
      } catch (cleanupError) {
        setTransientCleanupRequired(true);
        setMessage(
          stableErrorCode(cleanupError, 'MAIN_APP_IMPORT_CLEANUP_FAILED'),
        );
      }
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
    if ((pendingCleanupUris.length === 0 && !transientCleanupRequired) || busy)
      return;
    setBusy(true);
    try {
      if (transientCleanupRequired) {
        await native.cleanupMainAppPickerTransients();
        setTransientCleanupRequired(false);
      }
      if (pendingCleanupUris.length > 0)
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
    let nativePublicationReturned = false;
    try {
      const manifest = await native.publishMainAppImport(
        draft.ingestionId,
        summary.source,
        draft.items,
      );
      nativePublicationReturned = true;
      setPublicationCommitted(true);
      await onImported(manifest);
      setResult(manifest);
    } catch (error) {
      const code = stableErrorCode(error, 'MAIN_APP_IMPORT_FAILED');
      if (
        nativePublicationReturned ||
        code === 'MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED'
      )
        setPublicationCommitted(true);
      setMessage(code);
    } finally {
      setBusy(false);
    }
  };

  if (publicationCommitted)
    return (
      <View accessibilityLiveRegion="polite" style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>
          {t(locale, 'recoveryRequired')}
        </Text>
        <Text style={styles.body}>{t(locale, 'recoveryDetail')}</Text>
        {message ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {message}
          </Text>
        ) : null}
        {busy ? <ActivityIndicator color={colors.accent} /> : null}
        <FlowButton
          disabled={busy}
          label={t(locale, 'retryImportRecovery')}
          onPress={commit}
        />
      </View>
    );

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t(locale, 'newPack')}
      </Text>
      <Text style={styles.body}>{t(locale, 'newPackDetail')}</Text>
      <View style={styles.row}>
        <FlowButton
          disabled={busy}
          label={t(locale, 'addPhotos')}
          onPress={() => pick('photos')}
        />
        <FlowButton
          disabled={busy}
          label={t(locale, 'addFiles')}
          onPress={() => pick('files')}
        />
      </View>
      <TextInput
        accessibilityLabel={t(locale, 'textToAdd')}
        multiline
        onChangeText={setTextEntry}
        placeholder={t(locale, 'textPlaceholder')}
        placeholderTextColor={colors.muted}
        style={[styles.input, styles.multiline]}
        value={textEntry}
      />
      <FlowButton
        disabled={busy || textEntry.length === 0}
        label={t(locale, 'addText')}
        onPress={() => addEntry('text')}
      />
      <TextInput
        accessibilityLabel={t(locale, 'urlToAdd')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={setUrlEntry}
        placeholder={t(locale, 'urlPlaceholder')}
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={urlEntry}
      />
      <FlowButton
        disabled={busy || urlEntry.length === 0}
        label={t(locale, 'addUrl')}
        onPress={() => addEntry('url')}
      />

      <View accessibilityLiveRegion="polite" style={styles.summary}>
        <Text style={styles.itemTitle}>
          {t(locale, 'selected', {
            count: summary.selectedCount,
            bytes: formatBytes(summary.estimatedByteCount),
          })}
        </Text>
        <Text style={styles.body}>
          {summary.typeCounts.length === 0
            ? t(locale, 'supportedTypes')
            : summary.typeCounts
                .map(value => `${value.mediaType} × ${value.count}`)
                .join(' · ')}
        </Text>
      </View>

      {summary.items.map(item => {
        const label = localizedItemLabel(locale, draft.items[item.order]!);
        return (
          <View key={item.id} style={styles.item}>
            <Text style={styles.itemTitle}>{label}</Text>
            <Text style={styles.body}>
              {item.mediaType} · {formatBytes(item.byteCount)}
              {item.code ? ` · ${item.code}` : ''}
            </Text>
            <View style={styles.row}>
              <FlowButton
                disabled={busy || item.order === 0}
                label={t(locale, 'moveUp', { item: label })}
                onPress={() =>
                  setDraft(current => moveImportItem(current, item.id, -1))
                }
              />
              <FlowButton
                disabled={busy || item.order === summary.items.length - 1}
                label={t(locale, 'moveDown', { item: label })}
                onPress={() =>
                  setDraft(current => moveImportItem(current, item.id, 1))
                }
              />
              <FlowButton
                disabled={busy}
                label={t(locale, 'removeItem', { item: label })}
                onPress={() => remove(item.id)}
              />
            </View>
          </View>
        );
      })}

      {message ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {message}
        </Text>
      ) : null}
      {pendingCleanupUris.length > 0 || transientCleanupRequired ? (
        <FlowButton
          disabled={busy}
          label={t(locale, 'retryTemporaryCleanup')}
          onPress={retryPendingCleanup}
        />
      ) : null}
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      <View style={styles.row}>
        <FlowButton
          disabled={
            busy ||
            draft.items.length === 0 ||
            pendingCleanupUris.length > 0 ||
            transientCleanupRequired
          }
          label={t(locale, 'importPack')}
          onPress={commit}
        />
        <FlowButton
          disabled={busy}
          label={t(locale, 'cancelNewPack')}
          onPress={cancel}
        />
      </View>
      {draft.items.length === 0 ? (
        <Text style={styles.body}>{t(locale, 'emptyImportHelp')}</Text>
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

function localizedImportStatus(
  locale: AppLocale,
  status: ImportManifestV1['status'],
): string {
  if (status === 'complete') return t(locale, 'statusComplete');
  if (status === 'partial') return t(locale, 'statusPartial');
  return t(locale, 'statusFailed');
}

function localizedItemLabel(
  locale: AppLocale,
  item: MainAppImportInput,
): string {
  const position = item.order + 1;
  if (item.kind === 'text') return t(locale, 'textItem', { position });
  if (item.kind === 'url') return t(locale, 'urlItem', { position });
  return t(
    locale,
    item.declaredMediaType.startsWith('image/') ? 'photoItem' : 'fileItem',
    { position },
  );
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
