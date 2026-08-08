import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { MainAppPickerAsset } from '../domain/mainAppImport';

export type MainAppPickerResult =
  | { readonly canceled: true; readonly assets: readonly [] }
  | {
      readonly canceled: false;
      readonly assets: readonly MainAppPickerAsset[];
    };

export type MainAppPickerErrorCode =
  | 'PICKER_PERMISSION_DENIED'
  | 'PICKER_FAILED';

export class MainAppPickerError extends Error {
  constructor(readonly code: MainAppPickerErrorCode) {
    super(code);
    this.name = 'MainAppPickerError';
  }
}

export interface MainAppPicker {
  pickPhotos(): Promise<MainAppPickerResult>;
  pickFiles(): Promise<MainAppPickerResult>;
}

export const mainAppPicker: MainAppPicker = {
  async pickPhotos() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: 20,
        quality: 1,
      });
      if (result.canceled) return { canceled: true, assets: [] };
      return {
        canceled: false,
        assets: result.assets.map(asset => ({
          uri: asset.uri,
          mediaType: asset.mimeType ?? 'application/octet-stream',
          byteCount: asset.fileSize ?? null,
        })),
      };
    } catch (error) {
      throw pickerError(error);
    }
  },

  async pickFiles() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled) return { canceled: true, assets: [] };
      return {
        canceled: false,
        assets: result.assets.map(asset => ({
          uri: asset.uri,
          mediaType: asset.mimeType ?? 'application/octet-stream',
          byteCount: asset.size ?? null,
        })),
      };
    } catch (error) {
      throw pickerError(error);
    }
  },
};

function pickerError(error: unknown): MainAppPickerError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return new MainAppPickerError(
    typeof code === 'string' &&
    (code.includes('PERMISSION') || code.includes('ACCESS'))
      ? 'PICKER_PERMISSION_DENIED'
      : 'PICKER_FAILED',
  );
}
