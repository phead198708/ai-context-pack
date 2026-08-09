import type { OCRResultV1 } from './contracts';
import type { NativeAdapter } from './nativeAdapter';
import {
  isOCRErrorCode,
  OCRTaskError,
  type OCRErrorCode,
  type OCRRequestV1,
  type OCRTaskProgressV1,
} from './ocr';

export interface OCRTaskHandle {
  readonly taskId: string;
  readonly result: Promise<OCRResultV1>;
  cancel(): Promise<void>;
}

type OCRNativeAdapter = Pick<
  NativeAdapter,
  'recognizeText' | 'cancelTextRecognition'
>;

/** Serializes OCR work for a bounded app-lifetime memory footprint. */
export class OCRTaskRunner {
  private chain = Promise.resolve();

  constructor(private readonly native: OCRNativeAdapter) {}

  start(
    request: OCRRequestV1,
    onProgress: (progress: OCRTaskProgressV1) => void,
  ): OCRTaskHandle {
    let cancelRequested = false;
    let nativeStarted = false;
    let completedUnits: 0 | 1 = 0;
    let terminal = false;
    let cancellation: Promise<void> | undefined;
    const publish = (progress: OCRTaskProgressV1): void => {
      try {
        onProgress(progress);
      } catch {
        // A presentation callback cannot corrupt or cancel native processing.
      }
    };
    const cancelled = (): never => {
      terminal = true;
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: 'cancelled',
        completedUnits,
        totalUnits: 2,
        errorCode: 'OCR_CANCELLED',
      });
      throw new OCRTaskError('OCR_CANCELLED');
    };
    const execute = async (): Promise<OCRResultV1> => {
      if (cancelRequested) return cancelled();
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: 'running',
        phase: 'decode',
        completedUnits: 0,
        totalUnits: 2,
      });
      await Promise.resolve();
      if (cancelRequested) return cancelled();
      completedUnits = 1;
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: 'running',
        phase: 'recognize',
        completedUnits,
        totalUnits: 2,
      });
      if (cancelRequested) return cancelled();
      nativeStarted = true;
      let value: OCRResultV1;
      try {
        value = await this.native.recognizeText(request);
      } catch (error) {
        const code = ocrErrorCode(error);
        if (cancelRequested || code === 'OCR_CANCELLED') return cancelled();
        terminal = true;
        publish({
          schemaVersion: 1,
          taskId: request.taskId,
          status: 'failed',
          completedUnits,
          totalUnits: 2,
          errorCode: code,
        });
        throw new OCRTaskError(code);
      }
      if (cancelRequested) return cancelled();
      terminal = true;
      publish({
        schemaVersion: 1,
        taskId: request.taskId,
        status: 'succeeded',
        completedUnits: 2,
        totalUnits: 2,
      });
      return value;
    };

    publish({
      schemaVersion: 1,
      taskId: request.taskId,
      status: 'queued',
      completedUnits: 0,
      totalUnits: 2,
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
        if (terminal || cancelRequested) {
          await cancellation;
          return;
        }
        cancelRequested = true;
        if (nativeStarted) {
          cancellation = this.native.cancelTextRecognition(request.taskId);
          await cancellation;
        }
      },
    };
  }
}

function ocrErrorCode(error: unknown): OCRErrorCode {
  if (typeof error !== 'object' || error === null)
    return 'OCR_RECOGNITION_FAILED';
  const code = (error as { readonly code?: unknown }).code;
  return isOCRErrorCode(code) ? code : 'OCR_RECOGNITION_FAILED';
}
