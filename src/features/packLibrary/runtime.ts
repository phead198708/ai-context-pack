import { productionRepository } from '../../infrastructure/persistence/runtime';
import { nativeAdapter } from '../../infrastructure/nativeAdapter';
import type { DomainErrorCode } from '../../domain/errors';
import { PackLibraryController } from './controller';
import {
  DurablePackProcessingCoordinator,
  NativeExtractionStageWorker,
} from './processing';

export type PackProcessingFailureListener = (code: DomainErrorCode) => void;

const processingFailureListeners = new Set<PackProcessingFailureListener>();

export function subscribePackProcessingFailures(
  listener: PackProcessingFailureListener,
): () => void {
  processingFailureListeners.add(listener);
  return () => processingFailureListeners.delete(listener);
}

function publishProcessingFailure(code: DomainErrorCode): void {
  for (const listener of processingFailureListeners) {
    try {
      listener(code);
    } catch {
      // A presentation observer cannot break durable processing.
    }
  }
}

const processingCoordinator = new DurablePackProcessingCoordinator(
  productionRepository,
  new NativeExtractionStageWorker(productionRepository, nativeAdapter),
  undefined,
  undefined,
  ({ code }) => publishProcessingFailure(code),
);

export const packLibraryController = new PackLibraryController(
  productionRepository,
  undefined,
  processingCoordinator,
);
