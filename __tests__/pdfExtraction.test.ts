import type {
  PDFDocumentInfoV1,
  PDFPageExtractionV1,
} from '../src/domain/contracts';
import {
  getPDFExtractionReadiness,
  PDFTaskError,
  PDFTaskRunner,
  type PDFExtractionCheckpointV1,
  type PDFTaskHandle,
  type PDFTaskProgressV1,
} from '../src/domain/pdfExtraction';

const ids = [
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
] as const;
const sourceSha256 = 'a'.repeat(64);
const otherSourceSha256 = 'b'.repeat(64);

const document: PDFDocumentInfoV1 = {
  schemaVersion: 1,
  pageCount: 3,
  byteCount: 1024,
  sha256: sourceSha256,
  engine: 'pdfkit',
  revision: 'PDFKit',
  limit: { pages: 25, bytes: 52_428_800 },
};

function completePage(pageIndex: number): PDFPageExtractionV1 {
  const text = `page-${pageIndex}`;
  return {
    schemaVersion: 1,
    pageIndex,
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
}

function failedPage(pageIndex: number): PDFPageExtractionV1 {
  return {
    schemaVersion: 1,
    pageIndex,
    method: 'rendered-ocr',
    engine: 'apple-vision',
    revision: '3',
    durationMs: 1,
    characterCount: 0,
    warnings: ['PDF_PAGE_EXTRACTION_FAILED'],
    status: 'failed',
    errorCode: 'PDF_PAGE_EXTRACTION_FAILED',
  };
}

function request(taskId: string = ids[0]) {
  return {
    taskId,
    fileUri: 'file:///private/synthetic.pdf',
    script: 'latin' as const,
    sourceSha256,
  };
}

function recoveryCheckpoint(
  pages: readonly PDFPageExtractionV1[],
  overrides: Partial<PDFExtractionCheckpointV1> = {},
): PDFExtractionCheckpointV1 {
  return {
    schemaVersion: 1,
    taskId: ids[0],
    sourceSha256,
    script: 'latin',
    pageCount: document.pageCount,
    pages,
    reason: 'periodic',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PDFTaskRunner', () => {
  test('extracts pages sequentially and awaits every checkpoint', async () => {
    const checkpointGate = deferred<void>();
    const extractPdfPage = jest.fn(({ pageIndex }) =>
      Promise.resolve(completePage(pageIndex)),
    );
    const checkpoints: PDFExtractionCheckpointV1[] = [];
    const progress: PDFTaskProgressV1[] = [];
    const inspectPdf = jest.fn().mockResolvedValue(document);
    const finishPdfExtraction = jest.fn().mockResolvedValue(undefined);
    const runner = new PDFTaskRunner({
      inspectPdf,
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction,
    });

    const handle = runner.start(
      request(),
      async checkpoint => {
        checkpoints.push(checkpoint);
        if (checkpoint.pages.length === 1) await checkpointGate.promise;
      },
      value => progress.push(value),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(extractPdfPage).toHaveBeenCalledTimes(1);
    expect(extractPdfPage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha256 }),
    );
    checkpointGate.resolve();

    await expect(handle.result).resolves.toMatchObject({
      status: 'complete',
      failedPageIndexes: [],
      pages: [{ pageIndex: 0 }, { pageIndex: 1 }, { pageIndex: 2 }],
    });
    expect(inspectPdf).toHaveBeenCalledWith({
      taskId: ids[0],
      fileUri: request().fileUri,
      sourceSha256,
    });
    expect(finishPdfExtraction).toHaveBeenCalledTimes(1);
    expect(finishPdfExtraction).toHaveBeenCalledWith(ids[0]);
    expect(checkpoints.map(value => value.pages.length)).toEqual([1, 2, 3]);
    expect(progress.map(value => value.status)).toEqual([
      'queued',
      'inspecting',
      'extracting',
      'checkpointing',
      'extracting',
      'checkpointing',
      'extracting',
      'checkpointing',
      'succeeded',
    ]);
  });

  test('resumes successful pages and retries only explicitly selected failures', async () => {
    const extractPdfPage = jest.fn(({ pageIndex }) =>
      Promise.resolve(completePage(pageIndex)),
    );
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue(document),
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    const handle = runner.start(
      {
        ...request(),
        recoveryCheckpoint: recoveryCheckpoint([
          completePage(0),
          failedPage(1),
        ]),
        retryFailedPageIndexes: [1],
      },
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    );
    await expect(handle.result).resolves.toMatchObject({ status: 'complete' });
    expect(extractPdfPage.mock.calls.map(call => call[0].pageIndex)).toEqual([
      1, 2,
    ]);
  });

  test('fails closed when recovered pages belong to another PDF', async () => {
    const extractPdfPage = jest.fn();
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue({
        ...document,
        pageCount: 1,
        sha256: otherSourceSha256,
      }),
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    const handle = runner.start(
      {
        ...request(),
        sourceSha256: otherSourceSha256,
        recoveryCheckpoint: recoveryCheckpoint([completePage(0)], {
          pageCount: 1,
        }),
      },
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    );

    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_RESULT_INVALID'),
    );
    expect(extractPdfPage).not.toHaveBeenCalled();
  });

  test('fails closed when the selected artifact hash changed before inspection', async () => {
    const extractPdfPage = jest.fn();
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue({
        ...document,
        sha256: otherSourceSha256,
      }),
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    const handle = runner.start(
      request(),
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    );

    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_RESULT_INVALID'),
    );
    expect(extractPdfPage).not.toHaveBeenCalled();
  });

  test('binds every native page read to the inspected source hash', async () => {
    const checkpoint = jest.fn().mockResolvedValue(undefined);
    const extractPdfPage = jest.fn(requestValue => {
      expect(requestValue.sourceSha256).toBe(sourceSha256);
      return Promise.reject({ code: 'PDF_RESULT_INVALID' });
    });
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue({ ...document, pageCount: 1 }),
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    await expect(
      runner.start(request(), checkpoint, jest.fn()).result,
    ).rejects.toEqual(new PDFTaskError('PDF_RESULT_INVALID'));
    expect(extractPdfPage).toHaveBeenCalledTimes(1);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  test('keeps failed page outcomes visible and continues later pages', async () => {
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue(document),
      extractPdfPage: jest.fn(({ pageIndex }) =>
        Promise.resolve(
          pageIndex === 1 ? failedPage(1) : completePage(pageIndex),
        ),
      ),
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    const result = await runner.start(
      request(),
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    ).result;
    expect(result).toMatchObject({
      status: 'partial',
      failedPageIndexes: [1],
      pages: [
        { pageIndex: 0, status: 'complete' },
        {
          pageIndex: 1,
          status: 'failed',
          errorCode: 'PDF_PAGE_EXTRACTION_FAILED',
        },
        { pageIndex: 2, status: 'complete' },
      ],
    });
    expect(getPDFExtractionReadiness(result)).toEqual({
      schemaVersion: 1,
      status: 'blocked',
      failedPageIndexes: [1],
      errorCode: 'PDF_PAGE_EXTRACTION_FAILED',
    });
  });

  test('fails closed when export-readiness metadata omits a failed page', () => {
    expect(() =>
      getPDFExtractionReadiness({
        schemaVersion: 1,
        taskId: ids[0],
        document,
        status: 'complete',
        pages: [completePage(0), failedPage(1), completePage(2)],
        failedPageIndexes: [],
      }),
    ).toThrow(new PDFTaskError('PDF_RESULT_INVALID'));
  });

  test('fails closed when persisted export-readiness pages bypass static types', () => {
    const invalidPage = {
      ...completePage(0),
      characterCount: 99,
    } as PDFPageExtractionV1;
    expect(() =>
      getPDFExtractionReadiness({
        schemaVersion: 1,
        taskId: ids[0],
        document: { ...document, pageCount: 1 },
        status: 'complete',
        pages: [invalidPage],
        failedPageIndexes: [],
      }),
    ).toThrow(new PDFTaskError('PDF_RESULT_INVALID'));
  });

  test('fails closed when recovered/exported pages omit required Issue 11 provenance', () => {
    const pageWithoutProvenance = {
      ...completePage(0),
      characterCount: undefined,
      warnings: undefined,
    } as unknown as PDFPageExtractionV1;
    const onePageDocument = { ...document, pageCount: 1 };

    expect(() =>
      getPDFExtractionReadiness({
        schemaVersion: 1,
        taskId: ids[0],
        document: onePageDocument,
        status: 'complete',
        pages: [pageWithoutProvenance],
        failedPageIndexes: [],
      }),
    ).toThrow(new PDFTaskError('PDF_RESULT_INVALID'));
  });

  test('fails closed when export-readiness pages claim the other platform engine', () => {
    const crossPlatformPage = {
      ...completePage(0),
      method: 'rendered-ocr' as const,
      engine: 'ml-kit' as const,
      revision: '16.0.1',
    };
    expect(() =>
      getPDFExtractionReadiness({
        schemaVersion: 1,
        taskId: ids[0],
        document: { ...document, pageCount: 1 },
        status: 'complete',
        pages: [crossPlatformPage],
        failedPageIndexes: [],
      }),
    ).toThrow(new PDFTaskError('PDF_RESULT_INVALID'));
  });

  test('checkpoints cancellation and never starts a queued native page', async () => {
    const firstPage = deferred<PDFPageExtractionV1>();
    const cancelPdfExtraction = jest.fn().mockResolvedValue(undefined);
    const checkpoints: PDFExtractionCheckpointV1[] = [];
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue(document),
      extractPdfPage: jest.fn(() => firstPage.promise),
      cancelPdfExtraction,
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });
    const handle = runner.start(
      request(),
      async value => {
        checkpoints.push(value);
      },
      jest.fn(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const cancellation = handle.cancel();
    firstPage.reject({ code: 'PDF_CANCELLED' });
    await cancellation;

    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_CANCELLED'),
    );
    expect(cancelPdfExtraction).toHaveBeenCalledWith(ids[0]);
    expect(checkpoints.at(-1)).toMatchObject({
      reason: 'cancelled',
      pages: [],
    });
  });

  test('cancels task-scoped inspection and always releases its native source', async () => {
    const inspection = deferred<PDFDocumentInfoV1>();
    const cancelPdfExtraction = jest.fn().mockResolvedValue(undefined);
    const finishPdfExtraction = jest.fn().mockResolvedValue(undefined);
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn(() => inspection.promise),
      extractPdfPage: jest.fn(),
      cancelPdfExtraction,
      finishPdfExtraction,
    });
    const handle = runner.start(
      request(),
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    );
    await Promise.resolve();
    await Promise.resolve();

    const cancellation = handle.cancel();
    inspection.reject({ code: 'PDF_CANCELLED' });
    await cancellation;
    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_CANCELLED'),
    );
    expect(cancelPdfExtraction).toHaveBeenCalledWith(ids[0]);
    expect(finishPdfExtraction).toHaveBeenCalledTimes(1);
    expect(finishPdfExtraction).toHaveBeenCalledWith(ids[0]);
  });

  test('does not start native work after synchronous cancellation from extracting progress', async () => {
    const extractPdfPage = jest.fn();
    const checkpoints: PDFExtractionCheckpointV1[] = [];
    const progress: PDFTaskProgressV1[] = [];
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue({ ...document, pageCount: 1 }),
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });
    let handle!: PDFTaskHandle;
    let cancellation: Promise<void> | undefined;
    handle = runner.start(
      request(),
      async value => {
        checkpoints.push(value);
      },
      value => {
        progress.push(value);
        if (value.status === 'extracting') cancellation = handle.cancel();
      },
    );

    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_CANCELLED'),
    );
    await cancellation;
    expect(extractPdfPage).not.toHaveBeenCalled();
    expect(checkpoints).toEqual([
      expect.objectContaining({ reason: 'cancelled', pages: [] }),
    ]);
    expect(
      progress.filter(value =>
        ['succeeded', 'failed', 'cancelled'].includes(value.status),
      ),
    ).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        errorCode: 'PDF_CANCELLED',
      }),
    ]);
  });

  test('cancels after the final page checkpoint instead of publishing success', async () => {
    const progress: PDFTaskProgressV1[] = [];
    const checkpoints: PDFExtractionCheckpointV1[] = [];
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue({ ...document, pageCount: 1 }),
      extractPdfPage: jest.fn().mockResolvedValue(completePage(0)),
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });
    let handle!: PDFTaskHandle;
    handle = runner.start(
      request(),
      async value => {
        checkpoints.push(value);
        if (value.reason === 'periodic') await handle.cancel();
      },
      value => progress.push(value),
    );

    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_CANCELLED'),
    );
    expect(checkpoints.map(value => value.reason)).toEqual([
      'periodic',
      'cancelled',
    ]);
    expect(progress.some(value => value.status === 'succeeded')).toBe(false);
    expect(progress.at(-1)).toMatchObject({
      status: 'cancelled',
      errorCode: 'PDF_CANCELLED',
    });
  });

  test('cancels while the final native session cleanup is pending', async () => {
    const cleanup = deferred<void>();
    const cleanupStarted = deferred<void>();
    const checkpoints: PDFExtractionCheckpointV1[] = [];
    const progress: PDFTaskProgressV1[] = [];
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue({ ...document, pageCount: 1 }),
      extractPdfPage: jest.fn().mockResolvedValue(completePage(0)),
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn(() => {
        cleanupStarted.resolve();
        return cleanup.promise;
      }),
    });
    const handle = runner.start(
      request(),
      async value => {
        checkpoints.push(value);
      },
      value => progress.push(value),
    );

    await cleanupStarted.promise;
    await handle.cancel();
    cleanup.resolve();

    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PDF_CANCELLED'),
    );
    expect(checkpoints.map(value => value.reason)).toEqual([
      'periodic',
      'cancelled',
    ]);
    expect(
      progress.filter(value =>
        ['succeeded', 'failed', 'cancelled'].includes(value.status),
      ),
    ).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        errorCode: 'PDF_CANCELLED',
      }),
    ]);
  });

  test('fails closed when a checkpoint cannot be committed', async () => {
    const progress: PDFTaskProgressV1[] = [];
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue(document),
      extractPdfPage: jest.fn(({ pageIndex }) =>
        Promise.resolve(completePage(pageIndex)),
      ),
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    const handle = runner.start(
      request(),
      jest.fn().mockRejectedValue(new Error('synthetic storage failure')),
      value => progress.push(value),
    );
    await expect(handle.result).rejects.toEqual(
      new PDFTaskError('PIPELINE_RECOVERY_REQUIRED'),
    );
    expect(progress.at(-1)).toMatchObject({
      status: 'failed',
      errorCode: 'PIPELINE_RECOVERY_REQUIRED',
    });
  });

  test('rejects duplicate/out-of-range recovery and invalid retry targets with terminal progress', async () => {
    const progress: PDFTaskProgressV1[] = [];
    const runner = new PDFTaskRunner({
      inspectPdf: jest.fn().mockResolvedValue(document),
      extractPdfPage: jest.fn(),
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });
    const invalidRequests = [
      {
        ...request(),
        recoveryCheckpoint: recoveryCheckpoint([
          completePage(0),
          completePage(0),
        ]),
      },
      {
        ...request(),
        recoveryCheckpoint: recoveryCheckpoint([completePage(3)]),
      },
      {
        ...request(),
        recoveryCheckpoint: recoveryCheckpoint([completePage(0)]),
        retryFailedPageIndexes: [0],
      },
      {
        ...request(),
        recoveryCheckpoint: recoveryCheckpoint([
          { ...completePage(0), engine: 'pdf-renderer' as const },
        ]),
      },
    ];

    for (const invalid of invalidRequests) {
      const handle = runner.start(
        invalid,
        jest.fn().mockResolvedValue(undefined),
        value => progress.push(value),
      );
      await expect(handle.result).rejects.toEqual(
        new PDFTaskError('PDF_RESULT_INVALID'),
      );
    }
    expect(progress.filter(value => value.status === 'failed')).toHaveLength(4);
  });

  test('serializes documents so only one page bitmap can be active', async () => {
    const firstPage = deferred<PDFPageExtractionV1>();
    const inspectPdf = jest
      .fn()
      .mockResolvedValue({ ...document, pageCount: 1 });
    const extractPdfPage = jest
      .fn()
      .mockImplementationOnce(() => firstPage.promise)
      .mockResolvedValueOnce(completePage(0));
    const runner = new PDFTaskRunner({
      inspectPdf,
      extractPdfPage,
      cancelPdfExtraction: jest.fn(),
      finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    });

    const first = runner.start(
      request(ids[0]),
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    );
    const second = runner.start(
      request(ids[1]),
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(inspectPdf).toHaveBeenCalledTimes(1);
    firstPage.resolve(completePage(0));
    await first.result;
    await second.result;
    expect(inspectPdf).toHaveBeenCalledTimes(2);
    expect(extractPdfPage).toHaveBeenCalledTimes(2);
  });
});
