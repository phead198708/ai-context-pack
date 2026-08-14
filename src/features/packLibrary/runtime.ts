import { productionRepository } from '../../infrastructure/persistence/runtime';
import { nativeAdapter } from '../../infrastructure/nativeAdapter';
import type { DomainErrorCode } from '../../domain/errors';
import { PackLibraryController } from './controller';
import {
  CompositePackStageWorker,
  DurablePackProcessingCoordinator,
  NativeDuplicateAnalysisStageWorker,
  NativeExtractionStageWorker,
  type RecoveredPackProcessingCompletion,
} from './processing';

export type PackProcessingFailureListener = (code: DomainErrorCode) => void;
export type PackProcessingCompletionListener = (
  input: RecoveredPackProcessingCompletion,
) => void;

const processingFailureListeners = new Set<PackProcessingFailureListener>();
const processingCompletionListeners =
  new Set<PackProcessingCompletionListener>();

export function subscribePackProcessingFailures(
  listener: PackProcessingFailureListener,
): () => void {
  processingFailureListeners.add(listener);
  return () => processingFailureListeners.delete(listener);
}

export function subscribeRecoveredPackProcessingCompletions(
  listener: PackProcessingCompletionListener,
): () => void {
  processingCompletionListeners.add(listener);
  return () => processingCompletionListeners.delete(listener);
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

function publishRecoveredProcessingCompletion(
  input: RecoveredPackProcessingCompletion,
): void {
  for (const listener of processingCompletionListeners) {
    try {
      listener(input);
    } catch {
      // A presentation observer cannot break durable processing.
    }
  }
}

const processingCoordinator = new DurablePackProcessingCoordinator(
  productionRepository,
  new CompositePackStageWorker([
    new NativeExtractionStageWorker(productionRepository, nativeAdapter),
    new NativeDuplicateAnalysisStageWorker(productionRepository, nativeAdapter),
  ]),
  undefined,
  undefined,
  ({ code }) => publishProcessingFailure(code),
  undefined,
  input => publishRecoveredProcessingCompletion(input),
);

export const packLibraryController = new PackLibraryController(
  productionRepository,
  undefined,
  processingCoordinator,
);
