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
  finalize?(): Promise<void>;
}

export interface PackStageWorker {
  supports(stage: StartPipelineRunInput['stage']): boolean;
  start(run: PersistedPipelineRun): PackStageWorkHandle;
}

export interface PackProcessingScheduler {
  supports(stage: StartPipelineRunInput['stage']): boolean;
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
    private readonly claimLeaseMs = 5 * 60 * 1_000,
    private readonly onUnexpectedFailure?: (input: {
      readonly runId: string;
      readonly code: DomainErrorCode;
    }) => void,
  ) {
    if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs <= 0)
      throw new DomainError('SCHEMA_INVALID');
  }

  supports(stage: StartPipelineRunInput['stage']): boolean {
    return this.worker.supports(stage);
  }

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
    const recoveryAt = this.timestamp();
    const runs = await repository.listRunnablePipelineRuns(
      this.staleRunningBefore(recoveryAt),
    );
    for (const run of runs) this.schedule({ ...run, status: 'recovering' });
  }

  async waitForIdle(): Promise<void> {
    for (;;) {
      const pending = this.chain;
      await pending;
      if (pending === this.chain) return;
    }
  }

  private schedule(run: PersistedPipelineRun, unexpectedRetryCount = 0): void {
    if (this.active.has(run.id)) return;
    const execute = async (): Promise<void> => {
      let repository: ProductionPersistenceRepository | undefined;
      let claimVersion: number | null = null;
      let handle: PackStageWorkHandle | undefined;
      let packCreatedAt = run.startedAt;
      try {
        repository = await this.getRepository();
        const graph = await repository.findPackGraph(run.packId);
        if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
        packCreatedAt = graph.pack.createdAt;
        const claimAt = this.timestamp(packCreatedAt);
        claimVersion = await repository.markPipelineRunRunning(
          run.id,
          run.claimVersion,
          claimAt,
          this.staleRunningBefore(claimAt),
        );
        if (claimVersion === null) return;
        handle = this.worker.start(run);
      } catch (error) {
        await this.reportUnexpectedFailure(
          run,
          error,
          repository,
          claimVersion,
          packCreatedAt,
        );
        if (claimVersion === null && unexpectedRetryCount < 1)
          this.schedule(run, unexpectedRetryCount + 1);
        return;
      }
      this.active.set(run.id, { packId: run.packId, handle });
      try {
        const artifact = await handle.result;
        await repository.completePipelineRun({
          runId: run.id,
          claimVersion,
          updatedAt: this.timestamp(packCreatedAt),
          ...(artifact ? { artifact } : {}),
        });
      } catch (error) {
        try {
          await repository.failPipelineRun({
            runId: run.id,
            claimVersion,
            updatedAt: this.timestamp(packCreatedAt),
            errorCode: processingErrorCode(error),
          });
        } catch (settlementError) {
          await this.reportUnexpectedFailure(
            run,
            settlementError,
            repository,
            claimVersion,
            packCreatedAt,
          );
        }
      } finally {
        this.active.delete(run.id);
        try {
          await handle.finalize?.();
        } catch (error) {
          await this.reportUnexpectedFailure(
            run,
            error,
            repository,
            claimVersion,
            packCreatedAt,
          );
        }
      }
    };
    const work = this.chain.then(execute, execute);
    this.chain = work.then(
      () => undefined,
      () => undefined,
    );
  }

  private timestamp(minimum?: string): string {
    const value = this.now();
    const valueEpoch = Date.parse(value);
    const minimumEpoch =
      minimum === undefined ? valueEpoch : Date.parse(minimum);
    if (!Number.isFinite(valueEpoch) || !Number.isFinite(minimumEpoch))
      throw new DomainError('SCHEMA_INVALID');
    return valueEpoch < minimumEpoch ? minimum! : value;
  }

  private staleRunningBefore(value: string): string {
    return new Date(Date.parse(value) - this.claimLeaseMs).toISOString();
  }

  private async reportUnexpectedFailure(
    run: PersistedPipelineRun,
    error: unknown,
    repository: ProductionPersistenceRepository | undefined,
    claimVersion: number | null,
    packCreatedAt: string,
  ): Promise<void> {
    const code = processingErrorCode(error);
    const occurredAt = this.timestamp(packCreatedAt);
    if (repository && claimVersion !== null) {
      try {
        await repository.failPipelineRun({
          runId: run.id,
          claimVersion,
          updatedAt: occurredAt,
          errorCode: code,
        });
      } catch {
        // Preserve the original coordinator error. A runnable token remains
        // durably recoverable after the database becomes available again.
      }
    }
    if (repository) {
      try {
        await repository.recordRecoveryDiagnostic({
          id: run.id,
          scope: 'pipeline',
          anonymousId: run.id,
          code,
          phase: 'coordinator-execution',
          occurredAt,
        });
      } catch {
        // The callback below still surfaces a stable in-process signal when
        // the same SQLite failure also prevents diagnostic persistence.
      }
    }
    try {
      this.onUnexpectedFailure?.({ runId: run.id, code });
    } catch {
      // Observers must not break the serial processing chain.
    }
  }
}

/** Executes the Phase 1 extraction boundary entirely on-device. */
export class NativeExtractionStageWorker implements PackStageWorker {
  private readonly ocr: OCRTaskRunner;
  private readonly pdf: PDFTaskRunner;

  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly native: NativeAdapter,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly publicationLeaseMs = 5 * 60 * 1_000,
  ) {
    if (!Number.isSafeInteger(publicationLeaseMs) || publicationLeaseMs <= 0)
      throw new DomainError('SCHEMA_INVALID');
    this.ocr = new OCRTaskRunner(native);
    this.pdf = new PDFTaskRunner(native);
  }

  supports(stage: StartPipelineRunInput['stage']): boolean {
    return stage === 'extract';
  }

  start(run: PersistedPipelineRun): PackStageWorkHandle {
    let cancelled = false;
    let cancelActive: (() => Promise<void>) | undefined;
    let repository: ProductionPersistenceRepository | undefined;
    let publicationLeaseHeld = false;
    const releasePublicationLease = async (): Promise<void> => {
      if (!publicationLeaseHeld || !repository) return;
      publicationLeaseHeld = false;
      await repository.releaseCleanupLease(run.id);
    };
    const result = (async (): Promise<Artifact | undefined> => {
      try {
        if (run.stage !== 'extract')
          throw new DomainError('PIPELINE_STAGE_FAILED');
        repository = await this.getRepository();
        const graph = await repository.findPackGraph(run.packId);
        const item = graph?.items.find(value => value.id === run.itemId);
        const artifacts = await repository.listArtifactRecords();
        const original = artifacts.find(
          value => value.itemId === run.itemId && value.kind === 'original',
        );
        if (!graph || !item || !original)
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        const verification = await this.native.verifyArtifact(
          original.relativePath,
          original.byteCount,
          original.sha256,
        );
        if (
          verification.status !== 'verified' ||
          verification.relativePath !== original.relativePath ||
          verification.byteCount !== original.byteCount ||
          verification.sha256 !== original.sha256
        )
          throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
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
        const acquiredAt = validatedTimestamp(this.now());
        publicationLeaseHeld = await repository.acquireCleanupLease(
          run.id,
          acquiredAt,
          new Date(
            Date.parse(acquiredAt) + this.publicationLeaseMs,
          ).toISOString(),
        );
        if (!publicationLeaseHeld)
          throw new DomainError('PERSISTENCE_CONFLICT');
        const relativePath = ownedDerivedPath(run.packId, run.id, 'txt');
        const published = await this.native.writeTextArtifact(
          relativePath,
          text,
        );
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
      } catch (error) {
        try {
          await releasePublicationLease();
        } catch {
          // The global lease expires durably; preserve the extraction error.
        }
        throw error;
      }
    })();
    return {
      result,
      cancel: async () => {
        cancelled = true;
        await cancelActive?.();
      },
      finalize: releasePublicationLease,
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

function validatedTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new DomainError('SCHEMA_INVALID');
  return value;
}
