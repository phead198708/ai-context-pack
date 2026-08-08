import { createCanonicalUuid } from './canonicalUuid';

export const MAIN_APP_IMPORT_MAX_ITEMS = 20;
export const MAIN_APP_IMPORT_MAX_BINARY_BYTES = 52_428_800;
export const MAIN_APP_IMPORT_MAX_TEXT_BYTES = 1_048_576;

export type MainAppImportInputKind = 'file' | 'text' | 'url';

interface MainAppImportInputBase {
  readonly id: string;
  readonly order: number;
  readonly kind: MainAppImportInputKind;
  readonly declaredMediaType: string;
  readonly byteCount: number;
}

export interface MainAppFileImportInput extends MainAppImportInputBase {
  readonly kind: 'file';
  /** Ephemeral app-cache URI; native ingestion removes it after commit. */
  readonly fileUri: string;
}

export interface MainAppTextImportInput extends MainAppImportInputBase {
  readonly kind: 'text' | 'url';
  readonly text: string;
}

export type MainAppImportInput =
  | MainAppFileImportInput
  | MainAppTextImportInput;

export interface MainAppPickerAsset {
  readonly uri: string;
  readonly mediaType?: string | null;
  readonly byteCount?: number | null;
}

export interface MainAppImportDraft {
  readonly ingestionId: string;
  readonly items: readonly MainAppImportInput[];
}

export type MainAppImportEditError =
  | 'IMPORT_EMPTY_TEXT'
  | 'IMPORT_URL_INVALID'
  | 'IMPORT_ITEM_LIMIT_EXCEEDED';

export type MainAppImportPreflightCode =
  | 'IMPORT_TYPE_UNSUPPORTED'
  | 'IMPORT_SIZE_LIMIT_EXCEEDED';

export interface MainAppImportPreflightItem {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly code?: MainAppImportPreflightCode;
}

export interface MainAppImportSummary {
  readonly selectedCount: number;
  readonly estimatedByteCount: number;
  readonly typeCounts: readonly {
    readonly mediaType: string;
    readonly count: number;
  }[];
  readonly items: readonly MainAppImportPreflightItem[];
  readonly source: 'main-app-picker' | 'main-app-text';
}

export interface MainAppImportEditResult {
  readonly draft: MainAppImportDraft;
  readonly error?: MainAppImportEditError;
}

const mediaTypePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function createMainAppImportDraft(
  createId: () => string = createCanonicalUuid,
): MainAppImportDraft {
  return { ingestionId: createId(), items: [] };
}

export function appendPickerAssets(
  draft: MainAppImportDraft,
  assets: readonly MainAppPickerAsset[],
  createId: () => string = createCanonicalUuid,
): MainAppImportEditResult {
  if (draft.items.length + assets.length > MAIN_APP_IMPORT_MAX_ITEMS)
    return { draft, error: 'IMPORT_ITEM_LIMIT_EXCEEDED' };
  const additions = assets.map<MainAppFileImportInput>((asset, index) => ({
    id: createId(),
    order: draft.items.length + index,
    kind: 'file',
    declaredMediaType: boundedMediaType(asset.mediaType),
    byteCount: boundedByteCount(asset.byteCount),
    fileUri: asset.uri,
  }));
  return { draft: { ...draft, items: [...draft.items, ...additions] } };
}

export function appendTextEntry(
  draft: MainAppImportDraft,
  kind: 'text' | 'url',
  value: string,
  createId: () => string = createCanonicalUuid,
): MainAppImportEditResult {
  if (draft.items.length >= MAIN_APP_IMPORT_MAX_ITEMS)
    return { draft, error: 'IMPORT_ITEM_LIMIT_EXCEEDED' };
  if (value.length === 0) return { draft, error: 'IMPORT_EMPTY_TEXT' };
  if (kind === 'url' && !isSupportedWebUrl(value))
    return { draft, error: 'IMPORT_URL_INVALID' };
  const item: MainAppTextImportInput = {
    id: createId(),
    order: draft.items.length,
    kind,
    declaredMediaType: kind === 'url' ? 'text/uri-list' : 'text/plain',
    byteCount: utf8ByteCount(value),
    text: value,
  };
  return { draft: { ...draft, items: [...draft.items, item] } };
}

export function removeImportItem(
  draft: MainAppImportDraft,
  id: string,
): MainAppImportDraft {
  return {
    ...draft,
    items: draft.items
      .filter(item => item.id !== id)
      .map((item, order) => ({ ...item, order })),
  };
}

export function moveImportItem(
  draft: MainAppImportDraft,
  id: string,
  direction: -1 | 1,
): MainAppImportDraft {
  const index = draft.items.findIndex(item => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= draft.items.length) return draft;
  const items = [...draft.items];
  [items[index], items[target]] = [items[target]!, items[index]!];
  return {
    ...draft,
    items: items.map((item, order) => ({ ...item, order })),
  };
}

export function summarizeMainAppImport(
  draft: MainAppImportDraft,
): MainAppImportSummary {
  const typeCounts = new Map<string, number>();
  const items = draft.items.map<MainAppImportPreflightItem>(item => {
    typeCounts.set(
      item.declaredMediaType,
      (typeCounts.get(item.declaredMediaType) ?? 0) + 1,
    );
    const code = preflightCode(item);
    return {
      id: item.id,
      order: item.order,
      label: itemLabel(item),
      mediaType: item.declaredMediaType,
      byteCount: item.byteCount,
      ...(code ? { code } : {}),
    };
  });
  return {
    selectedCount: items.length,
    estimatedByteCount: items.reduce(
      (total, item) => total + item.byteCount,
      0,
    ),
    typeCounts: [...typeCounts].map(([mediaType, count]) => ({
      mediaType,
      count,
    })),
    items,
    source: draft.items.every(item => item.kind !== 'file')
      ? 'main-app-text'
      : 'main-app-picker',
  };
}

export function pickerFileUris(draft: MainAppImportDraft): readonly string[] {
  return draft.items.flatMap(item =>
    item.kind === 'file' ? [item.fileUri] : [],
  );
}

function boundedMediaType(value: string | null | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 127 ||
    !mediaTypePattern.test(value)
  )
    return 'application/octet-stream';
  return value.toLowerCase();
}

function boundedByteCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function preflightCode(
  item: MainAppImportInput,
): MainAppImportPreflightCode | undefined {
  const maximum =
    item.declaredMediaType === 'text/plain' ||
    item.declaredMediaType === 'text/uri-list'
      ? MAIN_APP_IMPORT_MAX_TEXT_BYTES
      : MAIN_APP_IMPORT_MAX_BINARY_BYTES;
  if (item.byteCount > maximum) return 'IMPORT_SIZE_LIMIT_EXCEEDED';
  if (!knownSupportedType(item.declaredMediaType))
    return 'IMPORT_TYPE_UNSUPPORTED';
  return undefined;
}

function knownSupportedType(mediaType: string): boolean {
  return (
    mediaType === 'application/octet-stream' ||
    mediaType === 'application/pdf' ||
    mediaType === 'text/plain' ||
    mediaType === 'text/uri-list' ||
    mediaType.startsWith('image/')
  );
}

function itemLabel(item: MainAppImportInput): string {
  const position = item.order + 1;
  if (item.kind === 'text') return `Text ${position}`;
  if (item.kind === 'url') return `URL ${position}`;
  return item.declaredMediaType.startsWith('image/')
    ? `Photo ${position}`
    : `File ${position}`;
}

function isSupportedWebUrl(value: string): boolean {
  if (value !== value.trim() || !/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host.length > 0
    );
  } catch {
    return false;
  }
}

export function utf8ByteCount(value: string): number {
  let count = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    count +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
        ? 3
        : 4;
  }
  return count;
}
