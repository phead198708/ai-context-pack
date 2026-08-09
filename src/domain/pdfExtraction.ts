import type {
  PDFDocumentInfoV1,
  PDFPageExtractionV1,
  OCRScriptV1,
} from './contracts';
import { PDF_MAXIMUM_BYTES, PDF_MAXIMUM_PAGES } from './contracts';
import { isCanonicalUuid } from './canonicalUuid';
import type { NativeAdapter } from './nativeAdapter';
import { isPDFDocumentInfoV1, isPDFPageExtractionV1 } from './validation';

export const PDF_ERROR_CODES = [
  'INVALID_LOCAL_FILE_URI',
  'PDF_CANCELLED',
  'PDF_CORRUPT',
  'PDF_ENCRYPTED',
  'PDF_EMPTY',
  'PDF_TOO_LARGE',
  'PDF_TOO_MANY_PAGES',
  'PDF_PAGE_OUT_OF_RANGE',
  'PDF_PAGE_EXTRACTION_FAILED',
  'PDF_RESOURCE_BUSY',
  'PDF_RESULT_INVALID',
  'PIPELINE_RECOVERY_REQUIRED',
  'RESOURCE_MEMORY_PRESSURE',
] as const;

export type PDFErrorCode = (typeof PDF_ERROR_CODES)[number];

export interface PDFExtractionRequestV1 {
  readonly taskId: string;
  readonly fileUri: string;
  readonly script: OCRScriptV1;
  /** Hash recorded for the immutable owned artifact selected for this run. */
  readonly sourceSha256: string;
  /** Previously committed outcomes, bound to the same task, script, and PDF hash. */
  readonly recoveryCheckpoint?: PDFExtractionCheckpointV1;
  /** Only failed pages may be selected; successful pages are never recomputed. */
  readonly retryFailedPageIndexes?: readonly number[];
}

export interface PDFPageExtractionRequestV1 {
  readonly taskId: string;
  readonly fileUri: string;
  /** Hash of the exact inspected PDF that this page must be read from. */
  readonly sourceSha256: string;
  readonly pageIndex: number;
  readonly script: OCRScriptV1;
}

export interface PDFInspectionRequestV1 {
  readonly taskId: string;
  readonly fileUri: string;
  /** Hash of the owned immutable PDF used to create the native source session. */
  readonly sourceSha256: string;
}

export type PDFCheckpointReasonV1 = 'periodic' | 'cancelled';

export interface PDFExtractionCheckpointV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sourceSha256: string;
  readonly script: OCRScriptV1;
  readonly pageCount: number;
  readonly pages: readonly PDFPageExtractionV1[];
  readonly reason: PDFCheckpointReasonV1;
}

export interface PDFExtractionResultV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly document: PDFDocumentInfoV1;
  readonly status: 'complete' | 'partial';
  readonly pages: readonly PDFPageExtractionV1[];
  readonly failedPageIndexes: readonly number[];
}

export type PDFExtractionReadinessV1 =
  | {
      readonly schemaVersion: 1;
      readonly status: 'ready';
      readonly failedPageIndexes: readonly [];
    }
  | {
      readonly schemaVersion: 1;
      readonly status: 'blocked';
      readonly failedPageIndexes: readonly number[];
      readonly errorCode: 'PDF_PAGE_EXTRACTION_FAILED';
    };

export type PDFTaskProgressV1 =
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'queued' | 'inspecting';
      readonly completedPages: 0;
      readonly totalPages?: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'extracting' | 'checkpointing';
      readonly pageIndex: number;
      readonly completedPages: number;
      readonly totalPages: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'succeeded';
      readonly completedPages: number;
      readonly totalPages: number;
      readonly failedPages: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'failed' | 'cancelled';
      readonly completedPages: number;
      readonly totalPages?: number;
      readonly errorCode: PDFErrorCode;
    };

export interface PDFTaskHandle {
  readonly taskId: string;
  readonly result: Promise<PDFExtractionResultV1>;
  cancel(): Promise<void>;
}

type PDFNativeAdapter = Pick<
  NativeAdapter,
  | 'inspectPdf'
  | 'extractPdfPage'
  | 'cancelPdfExtraction'
  | 'finishPdfExtraction'
>;

export class PDFTaskError extends Error {
  constructor(readonly code: PDFErrorCode) {
    super(code);
    this.name = 'PDFTaskError';
  }
}

/**
 * Serializes documents and pages so native code can hold at most one rendered
 * page bitmap. Checkpoint persistence is awaited before the next page starts.
 */
export class PDFTaskRunner {
  private chain = Promise.resolve();

  constructor(private readonly native: PDFNativeAdapter) {}

  start(
    request: PDFExtractionRequestV1,
    onCheckpoint: (checkpoint: PDFExtractionCheckpointV1) => Promise<void>,
    onProgress: (progress: PDFTaskProgressV1) => void,
  ): PDFTaskHandle {
    if (!isPDFExtractionRequestV1(request))
      throw new PDFTaskError('PDF_RESULT_INVALID');
    let cancelled = false;
    let nativeActive = false;
    let terminal = false;
    let nativeSessionRequested = false;
    let nativeSessionClosed = false;
    let cancellation: Promise<void> | undefined;
    let completedPages = 0;
    let totalPages: number | undefined;
    const publish = (progress: PDFTaskProgressV1): void => {
      try {
        onProgress(progress);
      } catch {
        // Presentation callbacks cannot affect extraction or checkpoints.
      }
    };
    const fail = (code: PDFErrorCode): never => {
      terminal = true;
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: code === 'PDF_CANCELLED' ? 'cancelled' : 'failed',
        completedPages,
        ...(totalPages === undefined ? {} : { totalPages }),
        errorCode: code,
      });
      throw new PDFTaskError(code);
    };
    const checkpoint = async (
      pages: readonly PDFPageExtractionV1[],
      reason: PDFCheckpointReasonV1,
    ): Promise<void> => {
      if (totalPages === undefined) return;
      const pageIndex = pages.at(-1)?.pageIndex ?? 0;
      if (reason === 'periodic') {
        publish({
          schemaVersion: 1,
          taskId: request.taskId,
          status: 'checkpointing',
          pageIndex,
          completedPages: pages.length,
          totalPages,
        });
      }
      try {
        await onCheckpoint({
          schemaVersion: 1,
          taskId: request.taskId,
          sourceSha256: request.sourceSha256,
          script: request.script,
          pageCount: totalPages,
          pages,
          reason,
        });
      } catch {
        fail('PIPELINE_RECOVERY_REQUIRED');
      }
    };
    const cancelNow = async (
      pages: readonly PDFPageExtractionV1[],
    ): Promise<never> => {
      await checkpoint(pages, 'cancelled');
      return fail('PDF_CANCELLED');
    };
    const closeNativeSession = async (): Promise<void> => {
      if (!nativeSessionRequested || nativeSessionClosed) return;
      await this.native.finishPdfExtraction(request.taskId);
      nativeSessionClosed = true;
    };
    const executeCore = async (): Promise<PDFExtractionResultV1> => {
      if (cancelled) return cancelNow([]);
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: 'inspecting',
        completedPages: 0,
      });
      if (cancelled) return cancelNow([]);
      let document: PDFDocumentInfoV1;
      nativeActive = true;
      nativeSessionRequested = true;
      try {
        document = await this.native.inspectPdf({
          taskId: request.taskId,
          fileUri: request.fileUri,
          sourceSha256: request.sourceSha256,
        });
      } catch (error) {
        nativeActive = false;
        return fail(pdfErrorCode(error));
      }
      nativeActive = false;
      if (!isPDFDocumentInfoV1(document)) return fail('PDF_RESULT_INVALID');
      if (document.sha256 !== request.sourceSha256)
        return fail('PDF_RESULT_INVALID');
      totalPages = document.pageCount;
      let pages: Map<number, PDFPageExtractionV1>;
      try {
        pages = recoverPages(request, document);
      } catch (error) {
        return fail(pdfErrorCode(error));
      }
      completedPages = pages.size;
      if (cancelled) return cancelNow(sortedPages(pages));

      for (let pageIndex = 0; pageIndex < document.pageCount; pageIndex += 1) {
        if (pages.has(pageIndex)) continue;
        if (cancelled) return cancelNow(sortedPages(pages));
        publish({
          schemaVersion: 1,
          taskId: request.taskId,
          status: 'extracting',
          pageIndex,
          completedPages,
          totalPages: document.pageCount,
        });
        if (cancelled) return cancelNow(sortedPages(pages));
        nativeActive = true;
        let page: PDFPageExtractionV1;
        try {
          page = await this.native.extractPdfPage({
            taskId: request.taskId,
            fileUri: request.fileUri,
            sourceSha256: request.sourceSha256,
            pageIndex,
            script: request.script,
          });
        } catch (error) {
          nativeActive = false;
          if (cancelled || pdfErrorCode(error) === 'PDF_CANCELLED')
            return cancelNow(sortedPages(pages));
          return fail(pdfErrorCode(error));
        }
        nativeActive = false;
        if (cancelled) return cancelNow(sortedPages(pages));
        if (
          !isProductionPDFPage(page) ||
          page.pageIndex !== pageIndex ||
          pages.has(pageIndex) ||
          !pageMatchesDocument(page, document)
        )
          return fail('PDF_RESULT_INVALID');
        pages.set(pageIndex, page);
        completedPages = pages.size;
        await checkpoint(sortedPages(pages), 'periodic');
        if (cancelled) return cancelNow(sortedPages(pages));
      }

      const ordered = sortedPages(pages);
      if (cancelled) return cancelNow(ordered);
      const failedPageIndexes = ordered
        .filter(page => page.status === 'failed')
        .map(page => page.pageIndex);
      try {
        await closeNativeSession();
      } catch {
        return fail('PDF_RESULT_INVALID');
      }
      terminal = true;
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: 'succeeded',
        completedPages: ordered.length,
        totalPages: document.pageCount,
        failedPages: failedPageIndexes.length,
      });
      return {
        schemaVersion: 1,
        taskId: request.taskId,
        document,
        status: failedPageIndexes.length === 0 ? 'complete' : 'partial',
        pages: ordered,
        failedPageIndexes,
      };
    };
    const execute = async (): Promise<PDFExtractionResultV1> => {
      try {
        return await executeCore();
      } finally {
        nativeActive = false;
        try {
          await closeNativeSession();
        } catch {
          // The primary stable failure remains authoritative. Successful runs
          // close before publishing their terminal event above.
        }
      }
    };

    publish({
      schemaVersion: 1,
      taskId: request.taskId,
      status: 'queued',
      completedPages: 0,
    });
    const result = this.chain.then(execute, execute);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return {
      taskId: request.taskId,
      result,
      cancel: async () => {
        if (terminal || cancelled) {
          await cancellation;
          return;
        }
        cancelled = true;
        if (nativeActive) {
          cancellation = this.native.cancelPdfExtraction(request.taskId);
          await cancellation;
        }
      },
    };
  }
}

export function isPDFExtractionRequestV1(
  value: unknown,
): value is PDFExtractionRequestV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const request = value as Record<string, unknown>;
  const allowed = new Set([
    'taskId',
    'fileUri',
    'script',
    'sourceSha256',
    'recoveryCheckpoint',
    'retryFailedPageIndexes',
  ]);
  return (
    Object.keys(request).every(key => allowed.has(key)) &&
    isCanonicalUuid(request.taskId) &&
    typeof request.fileUri === 'string' &&
    request.fileUri.startsWith('file://') &&
    (request.script === 'latin' || request.script === 'chinese') &&
    isSha256(request.sourceSha256) &&
    (request.recoveryCheckpoint === undefined ||
      isPDFExtractionCheckpointV1(request.recoveryCheckpoint)) &&
    (request.retryFailedPageIndexes === undefined ||
      (Array.isArray(request.retryFailedPageIndexes) &&
        request.retryFailedPageIndexes.every(
          page => Number.isSafeInteger(page) && page >= 0,
        ) &&
        new Set(request.retryFailedPageIndexes).size ===
          request.retryFailedPageIndexes.length))
  );
}

export function isPDFExtractionCheckpointV1(
  value: unknown,
): value is PDFExtractionCheckpointV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const checkpoint = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'taskId',
    'sourceSha256',
    'script',
    'pageCount',
    'pages',
    'reason',
  ]);
  return (
    Object.keys(checkpoint).every(key => allowed.has(key)) &&
    checkpoint.schemaVersion === 1 &&
    isCanonicalUuid(checkpoint.taskId) &&
    isSha256(checkpoint.sourceSha256) &&
    (checkpoint.script === 'latin' || checkpoint.script === 'chinese') &&
    Number.isSafeInteger(checkpoint.pageCount) &&
    (checkpoint.pageCount as number) > 0 &&
    (checkpoint.pageCount as number) <= PDF_MAXIMUM_PAGES &&
    Array.isArray(checkpoint.pages) &&
    checkpoint.pages.length <= (checkpoint.pageCount as number) &&
    checkpoint.pages.every(isProductionPDFPage) &&
    (checkpoint.reason === 'periodic' || checkpoint.reason === 'cancelled')
  );
}

export function getPDFExtractionReadiness(
  result: PDFExtractionResultV1,
): PDFExtractionReadinessV1 {
  if (
    result.schemaVersion !== 1 ||
    !isCanonicalUuid(result.taskId) ||
    !isPDFDocumentInfoV1(result.document) ||
    (result.status !== 'complete' && result.status !== 'partial') ||
    !Array.isArray(result.pages) ||
    !result.pages.every(isProductionPDFPage) ||
    !Array.isArray(result.failedPageIndexes) ||
    !result.failedPageIndexes.every(
      pageIndex => Number.isSafeInteger(pageIndex) && pageIndex >= 0,
    )
  )
    throw new PDFTaskError('PDF_RESULT_INVALID');
  const failedPageIndexes = result.pages
    .filter(page => page.status === 'failed')
    .map(page => page.pageIndex);
  if (
    result.pages.length !== result.document.pageCount ||
    result.pages.some((page, index) => page.pageIndex !== index) ||
    result.pages.some(page => !pageMatchesDocument(page, result.document)) ||
    failedPageIndexes.length !== result.failedPageIndexes.length ||
    failedPageIndexes.some(
      (pageIndex, index) => pageIndex !== result.failedPageIndexes[index],
    ) ||
    (result.status === 'complete') !== (failedPageIndexes.length === 0)
  )
    throw new PDFTaskError('PDF_RESULT_INVALID');
  return failedPageIndexes.length === 0
    ? { schemaVersion: 1, status: 'ready', failedPageIndexes: [] }
    : {
        schemaVersion: 1,
        status: 'blocked',
        failedPageIndexes,
        errorCode: 'PDF_PAGE_EXTRACTION_FAILED',
      };
}

function recoverPages(
  request: PDFExtractionRequestV1,
  document: PDFDocumentInfoV1,
): Map<number, PDFPageExtractionV1> {
  const pages = new Map<number, PDFPageExtractionV1>();
  const checkpoint = request.recoveryCheckpoint;
  if (
    checkpoint !== undefined &&
    (checkpoint.taskId !== request.taskId ||
      checkpoint.sourceSha256 !== request.sourceSha256 ||
      checkpoint.sourceSha256 !== document.sha256 ||
      checkpoint.script !== request.script ||
      checkpoint.pageCount !== document.pageCount)
  )
    throw new PDFTaskError('PDF_RESULT_INVALID');
  for (const page of checkpoint?.pages ?? []) {
    if (
      page.pageIndex >= document.pageCount ||
      pages.has(page.pageIndex) ||
      !pageMatchesDocument(page, document)
    )
      throw new PDFTaskError('PDF_RESULT_INVALID');
    pages.set(page.pageIndex, page);
  }
  for (const pageIndex of request.retryFailedPageIndexes ?? []) {
    const page = pages.get(pageIndex);
    if (page?.status !== 'failed') throw new PDFTaskError('PDF_RESULT_INVALID');
    pages.delete(pageIndex);
  }
  return pages;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The structural V1 decoder keeps these Issue #11 additions optional for
 * backward compatibility. New extraction, recovery, and export paths require
 * the complete provenance record and therefore fail closed when either field
 * is absent.
 */
function isProductionPDFPage(value: unknown): value is PDFPageExtractionV1 {
  return (
    isPDFPageExtractionV1(value) &&
    typeof value.characterCount === 'number' &&
    Array.isArray(value.warnings) &&
    (value.status !== 'complete' ||
      !value.warnings.includes('PDF_EMBEDDED_TEXT_SPARSE') ||
      typeof value.embeddedText === 'string')
  );
}

function pageMatchesDocument(
  page: PDFPageExtractionV1,
  document: PDFDocumentInfoV1,
): boolean {
  return document.engine === 'pdfkit'
    ? page.engine === 'pdfkit' || page.engine === 'apple-vision'
    : page.engine === 'pdf-renderer' || page.engine === 'ml-kit';
}

function sortedPages(
  pages: ReadonlyMap<number, PDFPageExtractionV1>,
): readonly PDFPageExtractionV1[] {
  return [...pages.values()].sort(
    (left, right) => left.pageIndex - right.pageIndex,
  );
}

export function isPDFErrorCode(value: unknown): value is PDFErrorCode {
  return (
    typeof value === 'string' &&
    (PDF_ERROR_CODES as readonly string[]).includes(value)
  );
}

function pdfErrorCode(error: unknown): PDFErrorCode {
  if (error instanceof PDFTaskError) return error.code;
  if (typeof error !== 'object' || error === null)
    return 'PDF_PAGE_EXTRACTION_FAILED';
  const code = (error as { readonly code?: unknown }).code;
  return isPDFErrorCode(code) ? code : 'PDF_PAGE_EXTRACTION_FAILED';
}

export const PDF_LIMITS = {
  pages: PDF_MAXIMUM_PAGES,
  bytes: PDF_MAXIMUM_BYTES,
} as const;
