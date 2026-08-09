import type { OCRResultV1 } from '../src/domain/contracts';
import { OCRTaskError, type OCRTaskProgressV1 } from '../src/domain/ocr';
import { OCRTaskRunner } from '../src/domain/ocrTask';

const ids = [
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
] as const;

const result: OCRResultV1 = {
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

function request(taskId: string) {
  return {
    taskId,
    fileUri: 'file:///private/synthetic.png',
    script: 'latin' as const,
    recognitionLevel: 'accurate' as const,
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

describe('OCRTaskRunner', () => {
  test('returns immediately, reports structured progress, and serializes work', async () => {
    const first = deferred<OCRResultV1>();
    const recognizeText = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(result);
    const runner = new OCRTaskRunner({
      recognizeText,
      cancelTextRecognition: jest.fn(),
    });
    const firstProgress: OCRTaskProgressV1[] = [];
    const secondProgress: OCRTaskProgressV1[] = [];

    const firstHandle = runner.start(request(ids[0]), value =>
      firstProgress.push(value),
    );
    const secondHandle = runner.start(request(ids[1]), value =>
      secondProgress.push(value),
    );

    expect(firstProgress[0]?.status).toBe('queued');
    expect(secondProgress).toEqual([
      expect.objectContaining({ status: 'queued', taskId: ids[1] }),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(recognizeText).toHaveBeenCalledTimes(1);
    first.resolve(result);
    await expect(firstHandle.result).resolves.toBe(result);
    await expect(secondHandle.result).resolves.toBe(result);
    expect(recognizeText).toHaveBeenCalledTimes(2);
    expect(firstProgress.map(value => value.status)).toEqual([
      'queued',
      'running',
      'running',
      'succeeded',
    ]);
    expect(secondProgress.at(-1)?.status).toBe('succeeded');
  });

  test('cancels queued work without starting native OCR', async () => {
    const first = deferred<OCRResultV1>();
    const recognizeText = jest.fn(() => first.promise);
    const cancelTextRecognition = jest.fn();
    const runner = new OCRTaskRunner({
      recognizeText,
      cancelTextRecognition,
    });
    const active = runner.start(request(ids[0]), jest.fn());
    const queuedProgress: OCRTaskProgressV1[] = [];
    const queued = runner.start(request(ids[1]), value =>
      queuedProgress.push(value),
    );

    await queued.cancel();
    first.resolve(result);
    await active.result;
    await expect(queued.result).rejects.toEqual(
      new OCRTaskError('OCR_CANCELLED'),
    );
    expect(recognizeText).toHaveBeenCalledTimes(1);
    expect(cancelTextRecognition).not.toHaveBeenCalled();
    expect(queuedProgress.at(-1)).toMatchObject({
      status: 'cancelled',
      errorCode: 'OCR_CANCELLED',
    });
  });

  test('forwards in-flight cancellation and normalizes unknown failures', async () => {
    const active = deferred<OCRResultV1>();
    const recognizeText = jest.fn(() => active.promise);
    const cancelTextRecognition = jest.fn().mockResolvedValue(undefined);
    const runner = new OCRTaskRunner({
      recognizeText,
      cancelTextRecognition,
    });
    const progress: OCRTaskProgressV1[] = [];
    const handle = runner.start(request(ids[0]), value => progress.push(value));
    await Promise.resolve();
    await Promise.resolve();
    await handle.cancel();
    active.reject(new Error('synthetic native failure'));
    await expect(handle.result).rejects.toEqual(
      new OCRTaskError('OCR_CANCELLED'),
    );
    expect(cancelTextRecognition).toHaveBeenCalledWith(ids[0]);
    expect(progress.at(-1)).toMatchObject({ status: 'cancelled' });

    const failedProgress: OCRTaskProgressV1[] = [];
    const failed = new OCRTaskRunner({
      recognizeText: jest.fn().mockRejectedValue(new Error('synthetic')),
      cancelTextRecognition: jest.fn(),
    }).start(request(ids[1]), value => failedProgress.push(value));
    await expect(failed.result).rejects.toEqual(
      new OCRTaskError('OCR_RECOGNITION_FAILED'),
    );
    expect(failedProgress.at(-1)).toMatchObject({
      status: 'failed',
      errorCode: 'OCR_RECOGNITION_FAILED',
    });
  });

  test('publishes one cancellation when native OCR succeeds after cancel', async () => {
    const active = deferred<OCRResultV1>();
    const cancelTextRecognition = jest.fn().mockResolvedValue(undefined);
    const runner = new OCRTaskRunner({
      recognizeText: jest.fn(() => active.promise),
      cancelTextRecognition,
    });
    const progress: OCRTaskProgressV1[] = [];
    const handle = runner.start(request(ids[0]), value => progress.push(value));
    await Promise.resolve();
    await Promise.resolve();

    await handle.cancel();
    active.resolve(result);

    await expect(handle.result).rejects.toEqual(
      new OCRTaskError('OCR_CANCELLED'),
    );
    expect(cancelTextRecognition).toHaveBeenCalledWith(ids[0]);
    expect(progress.filter(value => value.status === 'cancelled')).toEqual([
      expect.objectContaining({
        taskId: ids[0],
        errorCode: 'OCR_CANCELLED',
      }),
    ]);
    expect(progress.some(value => value.status === 'succeeded')).toBe(false);
  });
});
