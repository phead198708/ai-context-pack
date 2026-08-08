export {};

const { readFileSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
}>('node:fs');
const { join } = jest.requireActual<{
  readonly join: (...paths: readonly string[]) => string;
}>('node:path');

const source = (path: string): string =>
  readFileSync(join(process.cwd(), path), 'utf8');

describe('Issue #9 main-app entry-point boundaries', () => {
  test('configures system pickers without camera, microphone, or broad Android storage', () => {
    const app = JSON.parse(source('app.json')) as {
      expo: { plugins: readonly unknown[] };
    };
    const imagePicker = app.expo.plugins.find(
      plugin => Array.isArray(plugin) && plugin[0] === 'expo-image-picker',
    ) as [string, Record<string, unknown>] | undefined;
    const manifest = source('android/app/src/main/AndroidManifest.xml');

    expect(imagePicker?.[1]).toMatchObject({
      cameraPermission: false,
      microphonePermission: false,
    });
    expect(app.expo.plugins).toContain('expo-document-picker');
    for (const permission of [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ])
      expect(manifest).toContain(
        `android:name="${permission}" tools:node="remove"`,
      );
    expect(manifest).toContain(
      'android:name="android.hardware.camera" android:required="false"',
    );
    expect(manifest).not.toContain('android:enableOnBackInvokedCallback');
  });

  test('routes both native implementations through the existing atomic Inbox writer', () => {
    const swift = source(
      'modules/context-native/ios/MainAppImportPublisher.swift',
    );
    const kotlin = source(
      'modules/context-native/android/src/main/java/com/aicontextpack/nativebridge/MainAppImportPublisher.kt',
    );

    expect(swift).toContain('ShareIngestionSession(');
    expect(kotlin).toContain('ShareIngestionWriter.publish(');
    expect(`${swift}\n${kotlin}`).not.toMatch(
      /print\(|println\(|NSLog|Log\.[divew]\(/,
    );
    expect(`${swift}\n${kotlin}`).not.toMatch(
      /"filename"|"providerUri"|"localUri"/,
    );
  });

  test('uses cache-copy picker options and never persists display metadata in JS', () => {
    const picker = source('src/infrastructure/mainAppPickers.ts');

    expect(picker).toContain('allowsMultipleSelection: true');
    expect(picker).toContain('orderedSelection: true');
    expect(picker).toContain('selectionLimit: 20');
    expect(picker).toContain('copyToCacheDirectory: true');
    expect(picker).not.toMatch(/assetId:|fileName:|name:/);
  });
});
