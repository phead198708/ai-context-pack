import { productionRepository } from '../../infrastructure/persistence/runtime';
import { PackLibraryController } from './controller';

export const packLibraryController = new PackLibraryController(
  productionRepository,
);
