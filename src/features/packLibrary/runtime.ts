import { productionRepository } from '../../infrastructure/persistence/runtime';
import { nativeAdapter } from '../../infrastructure/nativeAdapter';
import { PackLibraryController } from './controller';
import {
  DurablePackProcessingCoordinator,
  NativeExtractionStageWorker,
} from './processing';

const processingCoordinator = new DurablePackProcessingCoordinator(
  productionRepository,
  new NativeExtractionStageWorker(productionRepository, nativeAdapter),
);

export const packLibraryController = new PackLibraryController(
  productionRepository,
  undefined,
  processingCoordinator,
);
