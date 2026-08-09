import type { OCRRecognitionLevelV1, OCRScriptV1 } from './contracts';
import { isCanonicalUuid } from './canonicalUuid';

export const OCR_MAXIMUM_PIXEL_COUNT = 40_000_000;
export const OCR_MAXIMUM_DIMENSION = 12_000;

export const OCR_ERROR_CODES = [
  'INVALID_LOCAL_FILE_URI',
  'OCR_CANCELLED',
  'OCR_ENGINE_UNAVAILABLE',
  'OCR_IMAGE_DECODE_FAILED',
  'OCR_IMAGE_TOO_LARGE',
  'OCR_LANGUAGE_UNAVAILABLE',
  'OCR_RECOGNITION_FAILED',
  'OCR_RESOURCE_BUSY',
  'OCR_RESULT_INVALID',
  'RESOURCE_MEMORY_PRESSURE',
] as const;

export type OCRErrorCode = (typeof OCR_ERROR_CODES)[number];

export interface OCRRequestV1 {
  readonly taskId: string;
  readonly fileUri: string;
  readonly script: OCRScriptV1;
  readonly recognitionLevel: OCRRecognitionLevelV1;
}

export type OCRTaskProgressV1 =
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'queued';
      readonly completedUnits: 0;
      readonly totalUnits: 2;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'running';
      readonly phase: 'decode' | 'recognize';
      readonly completedUnits: 0 | 1;
      readonly totalUnits: 2;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'succeeded';
      readonly completedUnits: 2;
      readonly totalUnits: 2;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: string;
      readonly status: 'failed' | 'cancelled';
      readonly completedUnits: number;
      readonly totalUnits: 2;
      readonly errorCode: OCRErrorCode;
    };

export function isOCRErrorCode(value: unknown): value is OCRErrorCode {
  return (
    typeof value === 'string' &&
    (OCR_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isOCRRequestV1(value: unknown): value is OCRRequestV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 4 &&
    isCanonicalUuid(request.taskId) &&
    typeof request.fileUri === 'string' &&
    request.fileUri.startsWith('file://') &&
    (request.script === 'latin' || request.script === 'chinese') &&
    (request.recognitionLevel === 'accurate' ||
      request.recognitionLevel === 'fast')
  );
}

export class OCRTaskError extends Error {
  constructor(readonly code: OCRErrorCode) {
    super(code);
    this.name = 'OCRTaskError';
  }
}
