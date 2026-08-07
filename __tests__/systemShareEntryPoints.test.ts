export {};

const { readFileSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
}>('node:fs');
const { join } = jest.requireActual<{
  readonly join: (...paths: readonly string[]) => string;
}>('node:path');

const repository = process.cwd();
const source = (relativePath: string): string =>
  readFileSync(join(repository, relativePath), 'utf8');

describe('Issue #8 system-share entry-point boundaries', () => {
  test('iOS activation rules cover the four MVP inputs and twenty items', () => {
    const plist = source('ios/ShareExtension/Info.plist');

    expect(plist).toContain('NSExtensionActivationSupportsImageWithMaxCount');
    expect(plist).toContain('NSExtensionActivationSupportsFileWithMaxCount');
    expect(plist).toContain('NSExtensionActivationSupportsText');
    expect(plist).toContain('NSExtensionActivationSupportsWebURLWithMaxCount');
    expect(plist.match(/<integer>20<\/integer>/g)).toHaveLength(3);
  });

  test('Android registers SEND and SEND_MULTIPLE without provider persistence', () => {
    const manifest = source('android/app/src/main/AndroidManifest.xml');
    const importer = source(
      'android/app/src/main/java/com/aicontextpack/ShareInboxImporter.kt',
    );
    const collector = source(
      'modules/context-native/android/src/main/java/com/aicontextpack/nativebridge/ShareIntentInputCollector.kt',
    );

    expect(manifest).toContain('android.intent.action.SEND');
    expect(manifest).toContain('android.intent.action.SEND_MULTIPLE');
    for (const mediaType of [
      'image/*',
      'application/pdf',
      'text/plain',
      'text/uri-list',
      '*/*',
    ])
      expect(manifest).toContain(`android:mimeType="${mediaType}"`);
    expect(collector).toContain('contentResolver.openInputStream(uri)');
    expect(importer.indexOf('executor.execute')).toBeLessThan(
      importer.indexOf('val inputs = collectInputs'),
    );
    expect(`${importer}\n${collector}`).not.toMatch(
      /takePersistableUriPermission|providerUri|localUri/,
    );
  });

  test('the iOS extension performs no processing or containing-app launch', () => {
    const controller = source('ios/ShareExtension/ShareViewController.swift');
    const writer = source('modules/context-native/ios/ShareIngestion.swift');
    const extensionSources = `${controller}\n${writer}`;

    expect(extensionSources).not.toMatch(
      /UIApplication|extensionContext\?\.open|Vision|PDFKit|OCR|compress|redact|export/i,
    );
    expect(controller).toContain('completeRequest(returningItems: nil)');
    expect(controller).not.toContain('.loadItem(');
    expect(controller).toContain('private let ingestionQueue = DispatchQueue(');
    expect(controller).toMatch(
      /private func startSession\(\)[\s\S]*dispatchPrecondition\(condition: \.onQueue\(ingestionQueue\)\)[\s\S]*ShareIngestionSession/,
    );
    expect(controller).toMatch(
      /ShareProviderFileLoader\.load[\s\S]*performOnIngestionQueueSynchronously/,
    );
    expect(controller).toContain('ingestionQueue.sync(execute: operation)');
    expect(controller).toMatch(
      /private func consumeProviderResult[\s\S]*dispatchPrecondition\(condition: \.onQueue\(ingestionQueue\)\)[\s\S]*session\.recordFile/,
    );
    expect(writer).toContain('loadFileRepresentation');
    expect(writer).toContain('loadObject(ofClass: NSURL.self)');
    expect(writer).toContain('64 * 1024');
    expect(writer).toContain('manifest.partial');
  });

  test('native writers persist only generated identities and metadata', () => {
    const writers = [
      source('modules/context-native/ios/ShareIngestion.swift'),
      source(
        'modules/context-native/android/src/main/java/com/aicontextpack/nativebridge/ShareIngestionWriter.kt',
      ),
    ].join('\n');

    expect(writers).not.toMatch(/print\(|println\(|NSLog|Log\.[divew]\(/);
    expect(writers).not.toMatch(/"providerUri"|"localUri"|"filename"/);
    expect(writers).toContain('IMPORT_SIZE_LIMIT_EXCEEDED');
    expect(writers).toContain('sha256');
  });
});
