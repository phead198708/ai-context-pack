import {
  createNativeAdapter,
  NativeBoundaryError,
} from '../src/infrastructure/createNativeAdapter';
import { MAIN_APP_IMPORT_MAX_TEXT_BYTES } from '../src/domain/mainAppImport';
import {
  DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
  type ImportManifestV1,
} from '../src/domain/contracts';
import { PLAIN_TEXT_FILE_MAX_BYTES } from '../src/domain/validation';

describe('native adapter runtime boundary', () => {
  const mockNativeModule = {
    scanInbox: jest.fn(),
    recognizeText: jest.fn(),
    probePdf: jest.fn(),
  };
  const adapter = createNativeAdapter(mockNativeModule);

  beforeEach(() => jest.clearAllMocks());

  test('rejects invalid manifests returned by native code', async () => {
    mockNativeModule.scanInbox.mockResolvedValue([
      { schemaVersion: 2, items: [] },
    ]);

    await expect(adapter.scanInbox()).rejects.toEqual(
      new NativeBoundaryError('NATIVE_MANIFEST_INVALID'),
    );
  });

  test('rejects duplicate ingestion IDs returned by native code', async () => {
    const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
    const manifest = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-01-01T00:00:00Z',
      source: 'android-share-intent',
      status: 'complete',
      items: [
        {
          id: '223e4567-e89b-42d3-a456-426614174000',
          order: 0,
          mediaType: 'image/png',
          byteCount: 1,
          relativePath: '223e4567-e89b-42d3-a456-426614174000.bin',
          status: 'copied',
        },
      ],
    };
    mockNativeModule.scanInbox.mockResolvedValue([manifest, manifest]);

    await expect(adapter.scanInbox()).rejects.toMatchObject({
      code: 'NATIVE_MANIFEST_INVALID',
    });
  });

  test('rejects invalid OCR and PDF DTOs', async () => {
    mockNativeModule.recognizeText.mockResolvedValue({ schemaVersion: 1 });
    mockNativeModule.probePdf.mockResolvedValue({ pageCount: 1 });

    await expect(
      adapter.recognizeText({
        taskId: '123e4567-e89b-42d3-a456-426614174000',
        fileUri: 'file:///fixture.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).rejects.toMatchObject({ code: 'OCR_RESULT_INVALID' });
    await expect(adapter.probePdf('file:///fixture.pdf')).rejects.toMatchObject(
      { code: 'NATIVE_PDF_RESULT_INVALID' },
    );
  });

  test('validates OCR capabilities and binds requests, results, and cancellation', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const capabilities = {
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin', 'chinese'],
          recognitionLevels: ['accurate', 'fast'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 12_000,
    };
    const result = {
      schemaVersion: 1,
      text: 'synthetic',
      blocks: [
        {
          text: 'synthetic',
          bounds: { x: 0, y: 0, width: 0.5, height: 0.1 },
        },
      ],
      durationMs: 1,
      engine: 'apple-vision',
      revision: '3',
      recognitionLevel: 'accurate',
      warnings: [],
    };
    const native = {
      ...mockNativeModule,
      getOCRCapabilities: jest.fn().mockResolvedValue(capabilities),
      recognizeText: jest.fn().mockResolvedValue(result),
      cancelTextRecognition: jest.fn().mockResolvedValue(true),
    };
    const guarded = createNativeAdapter(native);

    await expect(guarded.getOCRCapabilities()).resolves.toEqual(capabilities);
    await expect(
      guarded.recognizeText({
        taskId,
        fileUri: 'file:///cache/synthetic.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).resolves.toEqual(result);
    expect(native.recognizeText).toHaveBeenCalledWith(
      taskId,
      'file:///cache/synthetic.png',
      'latin',
      'accurate',
    );
    await expect(
      guarded.cancelTextRecognition(taskId),
    ).resolves.toBeUndefined();

    native.recognizeText.mockResolvedValue({
      ...result,
      recognitionLevel: 'fast',
    });
    await expect(
      guarded.recognizeText({
        taskId,
        fileUri: 'file:///cache/synthetic.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).rejects.toMatchObject({ code: 'OCR_RESULT_INVALID' });
  });

  test('validates image perceptual hashes and preserves only stable resource errors', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const result = {
      schemaVersion: 1,
      algorithm: 'dhash-64-v1',
      hash: '000000a810000000',
      sampleWidth: 9,
      sampleHeight: 8,
      orientationApplied: true,
      durationMs: 1,
      revision: '1',
    };
    const hashImagePerceptually = jest.fn().mockResolvedValue(result);
    const cancelImagePerceptualHash = jest.fn().mockResolvedValue(true);
    const guarded = createNativeAdapter({
      ...mockNativeModule,
      hashImagePerceptually,
      cancelImagePerceptualHash,
    });

    await expect(
      guarded.hashImagePerceptually?.(
        taskId,
        'file:///cache/synthetic.png',
        1024,
        'a'.repeat(64),
      ),
    ).resolves.toEqual(result);
    expect(hashImagePerceptually).toHaveBeenCalledWith(
      taskId,
      'file:///cache/synthetic.png',
      1024,
      'a'.repeat(64),
    );
    await expect(
      guarded.cancelImagePerceptualHash?.(taskId),
    ).resolves.toBeUndefined();
    expect(cancelImagePerceptualHash).toHaveBeenCalledWith(taskId);

    hashImagePerceptually.mockResolvedValue({ ...result, hash: 'invalid' });
    await expect(
      guarded.hashImagePerceptually?.(
        taskId,
        'file:///cache/synthetic.png',
        1024,
        'a'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'PROCESSOR_OUTPUT_INVALID' });

    hashImagePerceptually.mockRejectedValue({
      code: 'RESOURCE_MEMORY_PRESSURE',
    });
    await expect(
      guarded.hashImagePerceptually?.(
        taskId,
        'file:///cache/synthetic.png',
        1024,
        'a'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_MEMORY_PRESSURE' });

    hashImagePerceptually.mockRejectedValue({ code: 'PRIVATE_NATIVE_ERROR' });
    await expect(
      guarded.hashImagePerceptually?.(
        taskId,
        'file:///cache/synthetic.png',
        1024,
        'a'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'PROCESSOR_OUTPUT_INVALID' });
  });

  test('validates image compression inspection, output identity, and task lifecycle', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const sourceSha256 = 'a'.repeat(64);
    const inspection = {
      schemaVersion: 1,
      sourceByteCount: 1_024,
      sourceSha256,
      sourceMediaType: 'image/png',
      width: 640,
      height: 480,
      hasAlpha: true,
      animated: false,
      orientationApplied: true,
      revision: '1',
    };
    const request = {
      schemaVersion: 1 as const,
      taskId,
      fileUri: 'file:///cache/synthetic.png',
      expectedByteCount: 1_024,
      expectedSha256: sourceSha256,
      targetWidth: 320,
      targetHeight: 240,
      quality: 1,
      outputMediaType: 'image/png' as const,
      preserveAlpha: true,
    };
    const result = {
      schemaVersion: 1,
      taskId,
      sourceSha256,
      temporaryFileUri: `file:///cache/${taskId}.tmp`,
      outputByteCount: 512,
      outputSha256: 'b'.repeat(64),
      width: 320,
      height: 240,
      mediaType: 'image/png',
      quality: 1,
      alphaPreserved: true,
      engine: 'android-bitmap',
      revision: '1',
      durationMs: 2,
    };
    const native = {
      ...mockNativeModule,
      inspectImageForCompression: jest.fn().mockResolvedValue(inspection),
      compressImage: jest.fn().mockResolvedValue(result),
      cancelImageCompression: jest.fn().mockResolvedValue(true),
      finishImageCompression: jest.fn().mockResolvedValue(true),
    };
    const guarded = createNativeAdapter(native);

    await expect(
      guarded.inspectImageForCompression?.(
        taskId,
        request.fileUri,
        request.expectedByteCount,
        sourceSha256,
      ),
    ).resolves.toEqual(inspection);
    await expect(guarded.compressImage?.(request)).resolves.toEqual(result);
    expect(native.compressImage).toHaveBeenCalledWith(request);
    await expect(
      guarded.cancelImageCompression?.(taskId),
    ).resolves.toBeUndefined();
    await expect(
      guarded.finishImageCompression?.(taskId),
    ).resolves.toBeUndefined();

    native.inspectImageForCompression.mockResolvedValue({
      ...inspection,
      sourceSha256: 'c'.repeat(64),
    });
    await expect(
      guarded.inspectImageForCompression?.(
        taskId,
        request.fileUri,
        request.expectedByteCount,
        sourceSha256,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });

    native.compressImage.mockResolvedValue({ ...result, width: 319 });
    await expect(guarded.compressImage?.(request)).rejects.toMatchObject({
      code: 'PROCESSOR_OUTPUT_INVALID',
    });
    await expect(
      guarded.compressImage?.({ ...request, preserveAlpha: false }),
    ).rejects.toMatchObject({ code: 'PROCESSOR_OUTPUT_INVALID' });

    native.compressImage.mockRejectedValue({
      code: 'RESOURCE_MEMORY_PRESSURE',
    });
    await expect(guarded.compressImage?.(request)).rejects.toMatchObject({
      code: 'RESOURCE_MEMORY_PRESSURE',
    });
    native.compressImage.mockRejectedValue({ code: 'PRIVATE_NATIVE_ERROR' });
    await expect(guarded.compressImage?.(request)).rejects.toMatchObject({
      code: 'PROCESSOR_OUTPUT_INVALID',
    });

    native.cancelImageCompression.mockResolvedValue(false);
    await expect(
      guarded.cancelImageCompression?.(taskId),
    ).rejects.toMatchObject({
      code: 'PROCESSOR_OUTPUT_INVALID',
    });
  });

  test('validates and binds PDF inspection, page extraction, cancellation, and UTF-8 text reads', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const fileUri = 'file:///cache/synthetic.pdf';
    const document = {
      schemaVersion: 1,
      pageCount: 2,
      byteCount: 1024,
      sha256: 'a'.repeat(64),
      engine: 'pdfkit',
      revision: 'PDFKit',
      limit: { pages: 25, bytes: 52_428_800 },
    };
    const text = '中文 👩🏽‍💻';
    const page = {
      schemaVersion: 1,
      pageIndex: 1,
      method: 'embedded-text',
      engine: 'pdfkit',
      revision: 'PDFKit',
      durationMs: 1,
      characterCount: text.length,
      warnings: [],
      status: 'complete',
      text,
      blocks: [],
    };
    const native = {
      ...mockNativeModule,
      inspectPdf: jest.fn().mockResolvedValue(document),
      extractPdfPage: jest.fn().mockResolvedValue(page),
      cancelPdfExtraction: jest.fn().mockResolvedValue(true),
      finishPdfExtraction: jest.fn().mockResolvedValue(true),
      readPlainTextFile: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        text,
        byteCount: 22,
        encoding: 'utf-8',
        revision: '1',
      }),
    };
    const guarded = createNativeAdapter(native);

    await expect(
      guarded.inspectPdf({
        taskId,
        fileUri,
        sourceSha256: 'a'.repeat(64),
      }),
    ).resolves.toEqual(document);
    expect(native.inspectPdf).toHaveBeenCalledWith(
      taskId,
      fileUri,
      'a'.repeat(64),
    );
    await expect(
      guarded.extractPdfPage({
        taskId,
        fileUri,
        sourceSha256: 'a'.repeat(64),
        pageIndex: 1,
        script: 'chinese',
      }),
    ).resolves.toEqual(page);
    expect(native.extractPdfPage).toHaveBeenCalledWith(
      taskId,
      fileUri,
      'a'.repeat(64),
      1,
      'chinese',
    );
    await expect(guarded.cancelPdfExtraction(taskId)).resolves.toBeUndefined();
    await expect(guarded.finishPdfExtraction(taskId)).resolves.toBeUndefined();
    await expect(
      guarded.readPlainTextFile('file:///cache/synthetic.txt'),
    ).resolves.toMatchObject({ text, byteCount: 22 });
    expect(native.readPlainTextFile).toHaveBeenLastCalledWith(
      'file:///cache/synthetic.txt',
      PLAIN_TEXT_FILE_MAX_BYTES,
      null,
      null,
    );

    const derivedText = 'a'.repeat(PLAIN_TEXT_FILE_MAX_BYTES + 1);
    native.readPlainTextFile.mockResolvedValueOnce({
      schemaVersion: 1,
      text: derivedText,
      byteCount: derivedText.length,
      encoding: 'utf-8',
      revision: '1',
    });
    await expect(
      guarded.readPlainTextFile(
        'file:///cache/synthetic.txt',
        DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
      ),
    ).resolves.toMatchObject({ byteCount: PLAIN_TEXT_FILE_MAX_BYTES + 1 });
    await expect(
      guarded.readPlainTextFile(
        'file:///cache/synthetic.txt',
        DERIVED_TEXT_MAXIMUM_UTF8_BYTES + 1,
      ),
    ).rejects.toMatchObject({ code: 'TEXT_RESULT_INVALID' });
  });

  test('accepts only source-proven sparse embedded text reconciled with OCR blocks', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const sparsePage = {
      schemaVersion: 1,
      pageIndex: 0,
      method: 'rendered-ocr',
      engine: 'apple-vision',
      revision: '3',
      durationMs: 1,
      characterCount: 3,
      warnings: ['PDF_EMBEDDED_TEXT_SPARSE', 'PDF_PAGE_OCR_FALLBACK'],
      status: 'complete',
      text: 'A\n4',
      embeddedText: 'A',
      blocks: [{ text: '4', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 } }],
    };
    const extractPdfPage = jest.fn().mockResolvedValue(sparsePage);
    const guarded = createNativeAdapter({
      ...mockNativeModule,
      extractPdfPage,
    });
    const request = {
      taskId,
      fileUri: 'file:///cache/synthetic.pdf',
      sourceSha256: 'a'.repeat(64),
      pageIndex: 0,
      script: 'latin' as const,
    };

    await expect(guarded.extractPdfPage(request)).resolves.toEqual(sparsePage);
    extractPdfPage.mockResolvedValueOnce({
      ...sparsePage,
      embeddedText: 'B',
    });
    await expect(guarded.extractPdfPage(request)).rejects.toMatchObject({
      code: 'PDF_RESULT_INVALID',
    });
    const unprovenSparsePage = Object.fromEntries(
      Object.entries(sparsePage).filter(([key]) => key !== 'embeddedText'),
    );
    extractPdfPage.mockResolvedValueOnce(unprovenSparsePage);
    await expect(guarded.extractPdfPage(request)).rejects.toMatchObject({
      code: 'PDF_RESULT_INVALID',
    });
  });

  test('rejects rendered OCR text without supporting native blocks', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const forgedPage = {
      schemaVersion: 1,
      pageIndex: 0,
      method: 'rendered-ocr',
      engine: 'ml-kit',
      revision: '16.0.1',
      durationMs: 1,
      characterCount: 6,
      warnings: ['PDF_PAGE_OCR_FALLBACK'],
      status: 'complete',
      text: 'forged',
      blocks: [],
    };
    const guarded = createNativeAdapter({
      ...mockNativeModule,
      extractPdfPage: jest.fn().mockResolvedValue(forgedPage),
    });

    await expect(
      guarded.extractPdfPage({
        taskId,
        fileUri: 'file:///cache/synthetic.pdf',
        sourceSha256: 'a'.repeat(64),
        pageIndex: 0,
        script: 'latin',
      }),
    ).rejects.toMatchObject({ code: 'PDF_RESULT_INVALID' });
  });

  test('fails closed on invalid PDF/text requests, DTOs, and unknown native errors', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const native = {
      ...mockNativeModule,
      inspectPdf: jest.fn().mockResolvedValue({ pageCount: 1 }),
      extractPdfPage: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
      cancelPdfExtraction: jest.fn().mockResolvedValue(false),
      finishPdfExtraction: jest.fn().mockResolvedValue(false),
      readPlainTextFile: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        text: 'abc',
        byteCount: 2,
        encoding: 'utf-8',
        revision: '1',
      }),
    };
    const guarded = createNativeAdapter(native);

    await expect(
      guarded.inspectPdf({
        taskId,
        fileUri: 'content://provider/file',
        sourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PDF_RESULT_INVALID' });
    await expect(
      guarded.extractPdfPage({
        taskId,
        fileUri: 'file:///cache/synthetic.pdf',
        sourceSha256: 'a'.repeat(64),
        pageIndex: 25,
        script: 'latin',
      }),
    ).rejects.toMatchObject({ code: 'PDF_RESULT_INVALID' });
    await expect(
      guarded.extractPdfPage({
        taskId,
        fileUri: 'file:///cache/synthetic.pdf',
        sourceSha256: 'a'.repeat(64),
        pageIndex: 0,
        script: 'latin',
      }),
    ).rejects.toMatchObject({ code: 'PDF_RESULT_INVALID' });
    await expect(
      guarded.extractPdfPage({
        taskId,
        fileUri: 'file:///cache/synthetic.pdf',
        sourceSha256: 'A'.repeat(64),
        pageIndex: 0,
        script: 'latin',
      }),
    ).rejects.toMatchObject({ code: 'PDF_RESULT_INVALID' });
    await expect(guarded.cancelPdfExtraction(taskId)).rejects.toMatchObject({
      code: 'PDF_RESULT_INVALID',
    });
    await expect(guarded.finishPdfExtraction(taskId)).rejects.toMatchObject({
      code: 'PDF_RESULT_INVALID',
    });
    await expect(
      guarded.readPlainTextFile('file:///cache/synthetic.txt'),
    ).rejects.toMatchObject({ code: 'TEXT_RESULT_INVALID' });

    native.readPlainTextFile.mockRejectedValue({
      code: 'RESOURCE_MEMORY_PRESSURE',
    });
    await expect(
      guarded.readPlainTextFile('file:///cache/synthetic.txt'),
    ).rejects.toMatchObject({ code: 'RESOURCE_MEMORY_PRESSURE' });
    native.readPlainTextFile.mockRejectedValue({ code: 'TEXT_RESOURCE_BUSY' });
    await expect(
      guarded.readPlainTextFile('file:///cache/synthetic.txt'),
    ).rejects.toMatchObject({ code: 'TEXT_RESOURCE_BUSY' });
    native.readPlainTextFile.mockRejectedValue({
      code: 'PRIVATE_NATIVE_FAILURE',
    });
    await expect(
      guarded.readPlainTextFile('file:///cache/synthetic.txt'),
    ).rejects.toMatchObject({ code: 'TEXT_RESULT_INVALID' });

    native.inspectPdf.mockRejectedValue({ code: 'PDF_ENCRYPTED' });
    await expect(
      guarded.inspectPdf({
        taskId,
        fileUri: 'file:///cache/synthetic.pdf',
        sourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });
    native.inspectPdf.mockRejectedValue({ code: 'PRIVATE_NATIVE_FAILURE' });
    await expect(
      guarded.inspectPdf({
        taskId,
        fileUri: 'file:///cache/synthetic.pdf',
        sourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PDF_PAGE_EXTRACTION_FAILED' });
  });

  test('rejects mismatched OCR block text without allocating a joined copy', async () => {
    const taskId = '123e4567-e89b-42d3-a456-426614174000';
    const native = {
      ...mockNativeModule,
      recognizeText: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        text: 'first\nwrong',
        blocks: [
          {
            text: 'first',
            bounds: { x: 0, y: 0, width: 1, height: 0.5 },
          },
          {
            text: 'second',
            bounds: { x: 0, y: 0.5, width: 1, height: 0.5 },
          },
        ],
        durationMs: 1,
        engine: 'ml-kit-latin',
        revision: '16.0.1',
        recognitionLevel: 'accurate',
        warnings: [],
      }),
    };
    await expect(
      createNativeAdapter(native).recognizeText({
        taskId,
        fileUri: 'file:///cache/synthetic.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).rejects.toMatchObject({ code: 'OCR_RESULT_INVALID' });
  });

  test('rejects OCR blocks returned outside canonical reading order', async () => {
    const native = {
      ...mockNativeModule,
      recognizeText: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        text: 'second\nfirst',
        blocks: [
          {
            text: 'second',
            bounds: { x: 0, y: 0.5, width: 1, height: 0.25 },
          },
          {
            text: 'first',
            bounds: { x: 0, y: 0, width: 1, height: 0.25 },
          },
        ],
        durationMs: 1,
        engine: 'ml-kit-latin',
        revision: '16.0.1',
        recognitionLevel: 'accurate',
        warnings: [],
      }),
    };

    await expect(
      createNativeAdapter(native).recognizeText({
        taskId: '123e4567-e89b-42d3-a456-426614174000',
        fileUri: 'file:///cache/synthetic.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).rejects.toMatchObject({ code: 'OCR_RESULT_INVALID' });
  });

  test('accepts iOS canonical Unicode blocks ordered by UTF-16 code units', async () => {
    const result = {
      schemaVersion: 1,
      text: 'e\u0301\n\u00e9',
      blocks: [
        {
          text: 'e\u0301',
          bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        },
        {
          text: '\u00e9',
          bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        },
      ],
      durationMs: 1,
      engine: 'apple-vision',
      revision: '3',
      recognitionLevel: 'accurate',
      warnings: [],
    };
    const native = {
      ...mockNativeModule,
      recognizeText: jest.fn().mockResolvedValue(result),
    };

    await expect(
      createNativeAdapter(native).recognizeText({
        taskId: '123e4567-e89b-42d3-a456-426614174000',
        fileUri: 'file:///cache/synthetic.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).resolves.toEqual(result);
  });

  test('accepts a valid not-ready OCR capability and preserves stable OCR errors', async () => {
    const native = {
      ...mockNativeModule,
      getOCRCapabilities: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        engines: [
          {
            engine: 'apple-vision',
            revision: '3',
            scripts: [],
            recognitionLevels: ['accurate', 'fast'],
            ready: false,
            offline: true,
          },
        ],
        maximumPixelCount: 40_000_000,
        maximumDimension: 12_000,
      }),
      recognizeText: jest.fn().mockRejectedValue({ code: 'OCR_RESOURCE_BUSY' }),
    };
    const guarded = createNativeAdapter(native);
    await expect(guarded.getOCRCapabilities()).resolves.toMatchObject({
      engines: [expect.objectContaining({ ready: false, scripts: [] })],
    });
    await expect(
      guarded.recognizeText({
        taskId: '123e4567-e89b-42d3-a456-426614174000',
        fileUri: 'file:///cache/synthetic.png',
        script: 'latin',
        recognitionLevel: 'accurate',
      }),
    ).rejects.toMatchObject({ code: 'OCR_RESOURCE_BUSY' });
  });

  test('validates versioned share events before exposing them', async () => {
    const native = {
      ...mockNativeModule,
      getPendingShareEvents: jest
        .fn()
        .mockResolvedValue([
          { schemaVersion: 1, id: 'not-an-id', result: 'complete' },
        ]),
    };
    await expect(
      createNativeAdapter(native).getPendingShareEvents(),
    ).rejects.toMatchObject({
      code: 'NATIVE_SHARE_EVENT_INVALID',
    });
  });

  test('rejects uppercase event IDs at the native boundary', async () => {
    const uppercaseId = '123E4567-E89B-42D3-A456-426614174000';
    const shareNative = {
      ...mockNativeModule,
      getPendingShareEvents: jest
        .fn()
        .mockResolvedValue([
          { schemaVersion: 1, id: uppercaseId, result: 'complete' },
        ]),
    };
    const recoveryNative = {
      ...mockNativeModule,
      getPendingRecoveryEvent: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        id: uppercaseId,
        code: 'INBOX_RECOVERY_REQUIRED',
      }),
    };

    await expect(
      createNativeAdapter(shareNative).getPendingShareEvents(),
    ).rejects.toMatchObject({ code: 'NATIVE_SHARE_EVENT_INVALID' });
    await expect(
      createNativeAdapter(recoveryNative).getPendingRecoveryEvent(),
    ).rejects.toMatchObject({ code: 'NATIVE_RECOVERY_EVENT_INVALID' });
  });

  test('preserves the durable recovery error across the native boundary', async () => {
    mockNativeModule.scanInbox.mockRejectedValue({
      code: 'INBOX_RECOVERY_REQUIRED',
    });
    await expect(adapter.scanInbox()).rejects.toMatchObject({
      code: 'INBOX_RECOVERY_REQUIRED',
    });
  });

  test('requires explicit successful event acknowledgements', async () => {
    const native = {
      ...mockNativeModule,
      ackPendingShareEvent: jest.fn().mockResolvedValue(false),
      ackRecoveryEvent: jest.fn().mockResolvedValue(false),
    };
    const guarded = createNativeAdapter(native);
    await expect(guarded.ackPendingShareEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_SHARE_ACK_FAILED',
    });
    await expect(guarded.ackRecoveryEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_RECOVERY_ACK_FAILED',
    });
  });

  test('rejects acknowledgements when native methods are unavailable', async () => {
    await expect(adapter.ackPendingShareEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_SHARE_ACK_UNAVAILABLE',
    });
    await expect(adapter.ackRecoveryEvent('event')).rejects.toMatchObject({
      code: 'NATIVE_RECOVERY_ACK_UNAVAILABLE',
    });
  });

  test('validates native Inbox handoff paths and metadata', async () => {
    const itemId = '323e4567-e89b-42d3-a456-426614174000';
    const packId = '423e4567-e89b-42d3-a456-426614174000';
    const native = {
      ...mockNativeModule,
      handoffInbox: jest.fn().mockResolvedValue({
        manifest: {
          schemaVersion: 1,
          ingestionId: '123e4567-e89b-42d3-a456-426614174000',
          createdAt: '2026-08-03T00:00:00Z',
          source: 'android-share-intent',
          status: 'complete',
          items: [
            {
              id: itemId,
              order: 0,
              mediaType: 'image/png',
              status: 'copied',
              byteCount: 3,
              relativePath: `${itemId}.bin`,
              sha256: 'a'.repeat(64),
            },
          ],
        },
        manifestFingerprint: 'b'.repeat(64),
        artifacts: [
          {
            id: itemId,
            itemId,
            relativePath: `Packs/${packId}/originals/${itemId}.bin`,
            mediaType: 'image/png',
            byteCount: 3,
            sha256: 'a'.repeat(64),
          },
        ],
      }),
    };

    await expect(
      createNativeAdapter(native).handoffInbox('ingestion', packId, 3),
    ).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ id: itemId })],
    });
    native.handoffInbox.mockResolvedValue({
      manifest: {
        schemaVersion: 1,
        ingestionId: '123e4567-e89b-42d3-a456-426614174000',
        createdAt: '2026-08-03T00:00:00Z',
        source: 'android-share-intent',
        status: 'complete',
        items: [
          {
            id: itemId,
            order: 0,
            mediaType: 'image/png',
            status: 'copied',
            byteCount: 3,
            relativePath: `${itemId}.bin`,
          },
        ],
      },
      manifestFingerprint: 'b'.repeat(64),
      artifacts: [
        {
          id: itemId,
          itemId,
          relativePath: '../private-name.png',
          mediaType: 'image/png',
          byteCount: 3,
        },
      ],
    });
    await expect(
      createNativeAdapter(native).handoffInbox('ingestion', packId, 3),
    ).rejects.toMatchObject({ code: 'NATIVE_HANDOFF_INVALID' });
  });

  test('requires explicit Inbox handoff availability and acknowledgement', async () => {
    await expect(
      adapter.handoffInbox('ingestion', 'pack', 1),
    ).rejects.toMatchObject({
      code: 'NATIVE_HANDOFF_UNAVAILABLE',
    });
    await expect(adapter.acknowledgeInbox('ingestion')).rejects.toMatchObject({
      code: 'NATIVE_INBOX_ACK_UNAVAILABLE',
    });
    const guarded = createNativeAdapter({
      ...mockNativeModule,
      acknowledgeInbox: jest.fn().mockResolvedValue(false),
    });
    await expect(guarded.acknowledgeInbox('ingestion')).rejects.toMatchObject({
      code: 'NATIVE_INBOX_ACK_FAILED',
    });
  });

  test('validates ArtifactStore publication, quarantine, purge, and usage DTOs', async () => {
    const packId = '423e4567-e89b-42d3-a456-426614174000';
    const artifactId = '523e4567-e89b-42d3-a456-426614174000';
    const quarantineId = '623e4567-e89b-42d3-a456-426614174000';
    const relativePath = `Packs/${packId}/derived/${artifactId}.txt`;
    const partialPath = `${relativePath}.partial`;
    const native = {
      ...mockNativeModule,
      publishArtifact: jest.fn().mockResolvedValue({
        relativePath,
        byteCount: 3,
        sha256: 'a'.repeat(64),
        created: true,
      }),
      resolveOwnedArtifactFileUri: jest
        .fn()
        .mockResolvedValue('file:///owned-artifact.txt'),
      writeTextArtifact: jest.fn().mockResolvedValue({
        relativePath,
        byteCount: 3,
        sha256: 'a'.repeat(64),
        created: true,
      }),
      verifyArtifact: jest.fn().mockResolvedValue({
        relativePath,
        status: 'verified',
        byteCount: 3,
        sha256: 'a'.repeat(64),
      }),
      listOwnedArtifacts: jest.fn().mockResolvedValue([
        { relativePath, byteCount: 3 },
        { relativePath: partialPath, byteCount: 2 },
      ]),
      removeOwnedArtifact: jest.fn().mockResolvedValue(true),
      quarantineOwnedArtifact: jest.fn().mockResolvedValue({
        quarantined: true,
        quarantineId,
        anonymousId: artifactId,
        byteCount: 3,
      }),
      purgeArtifactQuarantine: jest
        .fn()
        .mockResolvedValue({ purgedCount: 1, purgedBytes: 3 }),
      getArtifactStorageUsage: jest.fn().mockResolvedValue({
        artifactCount: 2,
        artifactBytes: 5,
        quarantineCount: 0,
        quarantineBytes: 0,
      }),
    };
    const guarded = createNativeAdapter(native);

    await expect(
      guarded.publishArtifact(
        'file:///synthetic.txt',
        relativePath,
        3,
        'a'.repeat(64),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      guarded.resolveOwnedArtifactFileUri(relativePath),
    ).resolves.toBe('file:///owned-artifact.txt');
    await expect(
      guarded.writeTextArtifact(relativePath, 'abc'),
    ).resolves.toMatchObject({ relativePath, byteCount: 3 });
    expect(native.writeTextArtifact).toHaveBeenCalledWith(relativePath, 'abc');
    await expect(
      guarded.quarantineOwnedArtifact(relativePath),
    ).resolves.toEqual({
      quarantined: true,
      quarantineId,
      anonymousId: artifactId,
      byteCount: 3,
    });
    await expect(guarded.listOwnedArtifacts()).resolves.toEqual([
      { relativePath, byteCount: 3 },
      { relativePath: partialPath, byteCount: 2 },
    ]);
    await expect(guarded.purgeArtifactQuarantine(1)).resolves.toEqual({
      purgedCount: 1,
      purgedBytes: 3,
    });
    await expect(guarded.getArtifactStorageUsage()).resolves.toMatchObject({
      artifactCount: 2,
      artifactBytes: 5,
    });

    native.quarantineOwnedArtifact.mockResolvedValue({
      quarantined: true,
      quarantineId: 'not-a-uuid',
    });
    await expect(
      guarded.quarantineOwnedArtifact(relativePath),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_RESULT_INVALID' });
    await expect(guarded.purgeArtifactQuarantine(-1)).rejects.toMatchObject({
      code: 'NATIVE_ARTIFACT_INPUT_INVALID',
    });
    await expect(
      guarded.writeTextArtifact(relativePath, '\ud800'),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_INPUT_INVALID' });
  });

  test('validates and binds main-app inputs to the exact returned manifest', async () => {
    const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
    const fileId = '223e4567-e89b-42d3-a456-426614174000';
    const textId = '323e4567-e89b-42d3-a456-426614174000';
    const inputs = [
      {
        id: fileId,
        order: 0,
        kind: 'file' as const,
        declaredMediaType: 'application/pdf',
        byteCount: 4,
        fileUri: 'file:///cache/input.pdf',
      },
      {
        id: textId,
        order: 1,
        kind: 'text' as const,
        declaredMediaType: 'text/plain',
        byteCount: 8,
        text: 'A中🧪',
      },
    ];
    const returned = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-08-07T00:00:00Z',
      source: 'main-app-picker',
      status: 'complete',
      items: inputs.map(input => ({
        id: input.id,
        order: input.order,
        mediaType: input.declaredMediaType,
        status: 'copied',
        byteCount: input.byteCount,
        relativePath: `${input.id}.bin`,
      })),
    };
    const native = {
      ...mockNativeModule,
      publishMainAppImport: jest.fn().mockResolvedValue(returned),
      stageMainAppPickerFiles: jest
        .fn()
        .mockResolvedValue(['file:///cache/staged.bin']),
      cleanupMainAppPickerTransients: jest.fn().mockResolvedValue(true),
      recoverMainAppPickerCache: jest.fn().mockResolvedValue(true),
      discardMainAppPickerFiles: jest.fn().mockResolvedValue(true),
    };
    const guarded = createNativeAdapter(native);

    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-picker', inputs),
    ).resolves.toEqual(returned);
    expect(native.publishMainAppImport).toHaveBeenCalledWith(
      ingestionId,
      'main-app-picker',
      inputs,
    );
    await expect(
      guarded.stageMainAppPickerFiles([
        'file:///cache/DocumentPicker/input.pdf',
      ]),
    ).resolves.toEqual(['file:///cache/staged.bin']);
    await expect(
      guarded.cleanupMainAppPickerTransients(),
    ).resolves.toBeUndefined();
    await expect(guarded.recoverMainAppPickerCache()).resolves.toBeUndefined();
    await expect(
      guarded.discardMainAppPickerFiles(['file:///cache/input.pdf']),
    ).resolves.toBeUndefined();
  });

  test('fails closed on source, URL, UTF-8 length, cleanup, and result mismatches', async () => {
    const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
    const itemId = '223e4567-e89b-42d3-a456-426614174000';
    const native = {
      ...mockNativeModule,
      publishMainAppImport: jest.fn().mockResolvedValue({}),
      stageMainAppPickerFiles: jest.fn().mockResolvedValue([]),
      cleanupMainAppPickerTransients: jest.fn().mockResolvedValue(false),
      recoverMainAppPickerCache: jest.fn().mockResolvedValue(false),
      discardMainAppPickerFiles: jest.fn().mockResolvedValue(false),
    };
    const guarded = createNativeAdapter(native);
    const textInput = {
      id: itemId,
      order: 0,
      kind: 'text' as const,
      declaredMediaType: 'text/plain',
      byteCount: 8,
      text: 'A中🧪',
    };

    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-picker', [textInput]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-text', [
        { ...textInput, byteCount: 7 },
      ]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-text', [
        { ...textInput, byteCount: 3, text: '\ud800' },
      ]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-text', [
        {
          ...textInput,
          kind: 'url',
          declaredMediaType: 'text/uri-list',
          byteCount: 19,
          text: 'ftp://example.invalid',
        },
      ]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-text', [
        {
          ...textInput,
          kind: 'url',
          declaredMediaType: 'text/uri-list',
          byteCount: 20,
          text: 'http:example.invalid',
        },
      ]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-text', [
        {
          ...textInput,
          byteCount: MAIN_APP_IMPORT_MAX_TEXT_BYTES + 1,
          text: 'x'.repeat(MAIN_APP_IMPORT_MAX_TEXT_BYTES + 1),
        },
      ]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    expect(native.publishMainAppImport).not.toHaveBeenCalled();

    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-text', [textInput]),
    ).rejects.toMatchObject({
      code: 'NATIVE_MAIN_APP_IMPORT_RESULT_INVALID',
    });
    await expect(guarded.stageMainAppPickerFiles([])).rejects.toMatchObject({
      code: 'NATIVE_MAIN_APP_IMPORT_INVALID',
    });
    await expect(
      guarded.stageMainAppPickerFiles([
        'file:///cache/DocumentPicker/input.pdf',
      ]),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_PICKER_STAGE_INVALID' });
    await expect(
      guarded.cleanupMainAppPickerTransients(),
    ).rejects.toMatchObject({
      code: 'NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED',
    });
    await expect(guarded.recoverMainAppPickerCache()).rejects.toMatchObject({
      code: 'NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED',
    });
    await expect(
      guarded.discardMainAppPickerFiles(['content://provider/private']),
    ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    await expect(
      guarded.discardMainAppPickerFiles(['file:///cache/input.pdf']),
    ).rejects.toMatchObject({
      code: 'NATIVE_MAIN_APP_IMPORT_CLEANUP_FAILED',
    });
  });

  test('accepts only hash-bound app-owned failed-item retry sources', async () => {
    const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
    const packId = '223e4567-e89b-42d3-a456-426614174000';
    const sourceItemId = '323e4567-e89b-42d3-a456-426614174000';
    const itemId = '423e4567-e89b-42d3-a456-426614174000';
    const input = {
      id: itemId,
      order: 0,
      kind: 'owned-file' as const,
      declaredMediaType: 'image/png',
      byteCount: 8,
      ownedRelativePath: `Packs/${packId}/originals/${sourceItemId}.bin`,
      sha256: 'a'.repeat(64),
    };
    const returned: ImportManifestV1 = {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-08-09T00:00:00Z',
      source: 'main-app-picker',
      status: 'complete',
      items: [
        {
          id: itemId,
          order: 0,
          mediaType: 'image/png',
          status: 'copied',
          byteCount: 8,
          relativePath: `${itemId}.bin`,
        },
      ],
    };
    const native = {
      ...mockNativeModule,
      publishMainAppImport: jest.fn().mockResolvedValue(returned),
    };
    const guarded = createNativeAdapter(native);

    await expect(
      guarded.publishMainAppImport(ingestionId, 'main-app-picker', [input]),
    ).resolves.toEqual(returned);
    for (const invalid of [
      { ...input, ownedRelativePath: '../private.bin' },
      {
        ...input,
        ownedRelativePath: `Packs/${packId}/exports/${sourceItemId}.bin`,
      },
      { ...input, sha256: 'not-a-hash' },
    ])
      await expect(
        guarded.publishMainAppImport(ingestionId, 'main-app-picker', [invalid]),
      ).rejects.toMatchObject({ code: 'NATIVE_MAIN_APP_IMPORT_INVALID' });
    expect(native.publishMainAppImport).toHaveBeenCalledTimes(1);
  });
});
