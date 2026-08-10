import { createCanonicalUuid } from '../../domain/canonicalUuid';
import {
  DomainError,
  isDomainErrorCode,
  type DomainErrorCode,
} from '../../domain/errors';
import type { Artifact } from '../../domain/models';
import type { NativeAdapter } from '../../domain/nativeAdapter';
import { OCRTaskRunner } from '../../domain/ocrTask';
import { PDFTaskRunner } from '../../domain/pdfExtraction';
import type {
  PersistedPipelineRun,
  ProductionPersistenceRepository,
  StartPipelineRunInput,
} from '../../infrastructure/persistence/contracts';
import { ownedDerivedPath } from '../../infrastructure/persistence/ownedPaths';

export interface PackStageWorkHandle {
  readonly result: Promise<Artifact | undefined>;
  cancel(): Promise<void>;
}

export interface PackStageWorker {
  start(run: PersistedPipelineRun): PackStageWorkHandle;
}

export interface PackProcessingScheduler {
  launch(runs: readonly StartPipelineRunInput[]): void;
  cancel(packId: string, updatedAt: string): Promise<void>;
  recover(): Promise<void>;
}

/**
 * Runs one stage at a time and settles the durable run token transactionally.
 * A cancellation or newer run invalidates late native completion in SQLite.
 */
export class DurablePackProcessingCoordinator
  implements PackProcessingScheduler
{
  private chain = Promise.resolve();
  private readonly active = new Map<
    string,
    { readonly packId: string; readonly handle: PackStageWorkHandle }
  >();

  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly worker: PackStageWorker,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  launch(runs: readonly StartPipelineRunInput[]): void {
    for (const run of runs) {
      const persisted: PersistedPipelineRun = {
        ...run,
        status: 'queued',
        updatedAt: run.startedAt,
        claimVersion: 0,
      };
      this.schedule(persisted);
    }
  }

  async cancel(packId: string, updatedAt: string): Promise<void> {
    const repository = await this.getRepository();
    await repository.cancelPipelineRuns(packId, updatedAt);
    await Promise.allSettled(
      [...this.active.values()]
        .filter(value => value.packId === packId)
        .map(value => value.handle.cancel()),
    );
  }

  async recover(): Promise<void> {
    const repository = await this.getRepository();
    const runs = await repository.listRunnablePipelineRuns();
    for (const run of runs) this.schedule({ ...run, status: 'recovering' });
  }

  async waitForIdle(): Promise<void> {
    await this.chain;
  }

  private schedule(run: PersistedPipelineRun): void {
    if (this.active.has(run.id)) return;
    const execute = async (): Promise<void> => {
      const repository = await this.getRepository();
      const claimVersion = await repository.markPipelineRunRunning(
        run.id,
        run.claimVersion,
        this.timestamp(),
      );
      if (claimVersion === null) return;
      let handle: PackStageWorkHandle;
      try {
        handle = this.worker.start(run);
      } catch (error) {
        await repository.failPipelineRun({
          runId: run.id,
          claimVersion,
          updatedAt: this.timestamp(),
          errorCode: processingErrorCode(error),
        });
        return;
      }
      this.active.set(run.id, { packId: run.packId, handle });
      try {
        const artifact = await handle.result;
        await repository.completePipelineRun({
          runId: run.id,
          claimVersion,
          updatedAt: this.timestamp(),
          ...(artifact ? { artifact } : {}),
        });
      } catch (error) {
        await repository.failPipelineRun({
          runId: run.id,
          claimVersion,
          updatedAt: this.timestamp(),
          errorCode: processingErrorCode(error),
        });
      } finally {
        this.active.delete(run.id);
      }
    };
    const work = this.chain.then(execute, execute);
    this.chain = work.then(
      () => undefined,
      () => undefined,
    );
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value)))
      throw new DomainError('SCHEMA_INVALID');
    return value;
  }
}

/** Executes the Phase 1 extraction boundary entirely on-device. */
export class NativeExtractionStageWorker implements PackStageWorker {
  private readonly ocr: OCRTaskRunner;
  private readonly pdf: PDFTaskRunner;

  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly native: NativeAdapter,
  ) {
    this.ocr = new OCRTaskRunner(native);
    this.pdf = new PDFTaskRunner(native);
  }

  start(run: PersistedPipelineRun): PackStageWorkHandle {
    let cancelled = false;
    let cancelActive: (() => Promise<void>) | undefined;
    const result = (async (): Promise<Artifact | undefined> => {
      if (run.stage !== 'extract')
        throw new DomainError('PIPELINE_STAGE_FAILED');
      const repository = await this.getRepository();
      const graph = await repository.findPackGraph(run.packId);
      const item = graph?.items.find(value => value.id === run.itemId);
      const artifacts = await repository.listArtifactRecords();
      const original = artifacts.find(
        value => value.itemId === run.itemId && value.kind === 'original',
      );
      if (!graph || !item || !original)
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      const fileUri = await this.native.resolveOwnedArtifactFileUri(
        original.relativePath,
      );
      if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
      let text: string;
      let processorVersion: string;
      if (item.sourceType === 'image') {
        const script = await preferredOCRScript(this.native);
        const handle = this.ocr.start(
          {
            taskId: run.id,
            fileUri,
            script,
            recognitionLevel: 'accurate',
          },
          () => undefined,
        );
        cancelActive = handle.cancel;
        if (cancelled) await handle.cancel();
        const value = await handle.result;
        text = value.text;
        processorVersion = value.revision;
      } else if (item.sourceType === 'pdf') {
        const script = await preferredOCRScript(this.native);
        const handle = this.pdf.start(
          {
            taskId: run.id,
            fileUri,
            sourceSha256: original.sha256,
            script,
          },
          async () => undefined,
          () => undefined,
        );
        cancelActive = handle.cancel;
        if (cancelled) await handle.cancel();
        const value = await handle.result;
        if (value.status !== 'complete')
          throw new DomainError('PDF_PAGE_EXTRACTION_FAILED');
        text = value.pages
          .filter(page => page.status === 'complete')
          .map(page => page.text)
          .join('\n\n');
        processorVersion = value.document.revision;
      } else {
        const value = await this.native.readPlainTextFile(fileUri);
        text = value.text;
        processorVersion = value.revision;
      }
      if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
      const relativePath = ownedDerivedPath(run.packId, run.id, 'txt');
      const published = await this.native.writeTextArtifact(relativePath, text);
      if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
      return {
        id: run.id,
        itemId: run.itemId,
        kind: item.sourceType === 'pdf' ? 'pdf-page-text' : 'ocr-text',
        relativePath,
        mediaType: 'text/plain',
        byteCount: published.byteCount,
        sha256: published.sha256,
        processorVersion: {
          processor: 'native-phase1-extraction',
          version: processorVersion,
          contractVersion: 1,
        },
        createdAt: run.startedAt,
        immutable: true,
      };
    })();
    return {
      result,
      cancel: async () => {
        cancelled = true;
        await cancelActive?.();
      },
    };
  }
}

export function createPipelineRun(
  plan: {
    readonly packId: string;
    readonly itemId: string;
    readonly stage: StartPipelineRunInput['stage'];
  },
  startedAt: string,
): StartPipelineRunInput {
  return {
    id: createCanonicalUuid(),
    packId: plan.packId,
    itemId: plan.itemId,
    stage: plan.stage,
    startedAt,
  };
}

async function preferredOCRScript(
  native: NativeAdapter,
): Promise<'latin' | 'chinese'> {
  const capabilities = await native.getOCRCapabilities();
  const engines = capabilities.engines.filter(engine => engine.ready);
  if (engines.some(engine => engine.scripts.includes('chinese')))
    return 'chinese';
  if (engines.some(engine => engine.scripts.includes('latin'))) return 'latin';
  throw new DomainError('PIPELINE_STAGE_FAILED');
}

function processingErrorCode(error: unknown): DomainErrorCode {
  if (error instanceof DomainError) return error.code;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (isDomainErrorCode(code)) return code;
  }
  return 'PIPELINE_STAGE_FAILED';
}
