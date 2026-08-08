jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import {
  MainAppPickerError,
  mainAppPicker,
} from '../src/infrastructure/mainAppPickers';

const launchImageLibraryAsync =
  ImagePicker.launchImageLibraryAsync as jest.MockedFunction<
    typeof ImagePicker.launchImageLibraryAsync
  >;
const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.MockedFunction<
  typeof DocumentPicker.getDocumentAsync
>;

describe('main-app system pickers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses ordered multi-select Photos without camera or content metadata', async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/a.png',
          mimeType: 'image/png',
          fileSize: 42,
          fileName: 'private-name.png',
          assetId: 'provider-id',
          width: 1,
          height: 1,
          type: 'image',
        },
      ],
    });

    await expect(mainAppPicker.pickPhotos()).resolves.toEqual({
      canceled: false,
      assets: [
        { uri: 'file:///cache/a.png', mediaType: 'image/png', byteCount: 42 },
      ],
    });
    expect(launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: 20,
      quality: 1,
    });
  });

  test('copies multi-select documents into cache and preserves provider order', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/first.pdf',
          mimeType: 'application/pdf',
          size: 9,
          name: 'private.pdf',
          lastModified: 1,
        },
        {
          uri: 'file:///cache/second.txt',
          mimeType: 'text/plain',
          size: 5,
          name: 'private.txt',
          lastModified: 2,
        },
      ],
    });

    await expect(mainAppPicker.pickFiles()).resolves.toMatchObject({
      canceled: false,
      assets: [
        { uri: 'file:///cache/first.pdf' },
        { uri: 'file:///cache/second.txt' },
      ],
    });
    expect(getDocumentAsync).toHaveBeenCalledWith({
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: true,
    });
  });

  test('returns cancellation without assets and maps permission failures to a stable code', async () => {
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    getDocumentAsync.mockRejectedValue({ code: 'ERR_ACCESS_DENIED' });

    await expect(mainAppPicker.pickPhotos()).resolves.toEqual({
      canceled: true,
      assets: [],
    });
    await expect(mainAppPicker.pickFiles()).rejects.toEqual(
      new MainAppPickerError('PICKER_PERMISSION_DENIED'),
    );
  });
});
