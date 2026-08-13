import { createCanonicalUuid } from '../../domain/canonicalUuid';
import {
  DomainError,
  isDomainErrorCode,
  type DomainErrorCode,
} from '../../domain/errors';
import type { Artifact } from '../../domain/models';
import {
  fingerprintNormalizedTextAsyncV1,
  normalizeContentAsyncV1,
  type DuplicateAnalysisItemV1,
  type ImagePerceptualHashV1,
  type NormalizedContentV1,
} from '../../domain/duplicateDetection';
import { DERIVED_TEXT_MAXIMUM_UTF8_BYTES } from '../../domain/contracts';
import type { NativeAdapter } from '../../domain/nativeAdapter';
import { OCRTaskRunner } from '../../domain/ocrTask';
import { PDFTaskRunner } from '../../domain/pdfExtraction';
import type {
  PersistedPipelineRun,
  ProductionPersistenceRepository,
  StartPipelineRunInput,
} from '../../infrastructure/persistence/contracts';
import { ownedDerivedPath } from '../../infrastructure/persistence/ownedPaths';
import {
  startCleanupLeaseHeartbeat,
  type CleanupLeaseHeartbeat,
} from '../../infrastructure/persistence/cleanupLeaseHeartbeat';
import { acquireArtifactLifecycleMutex } from '../../infrastructure/persistence/artifactLifecycleMutex';
import { monotonicNowMilliseconds } from '../../infrastructure/persistence/operationalLeaseClock';

export interface PackStageWorkHandle {
  readonly result: Promise<Artifact | undefined>;
  /** Present only for an analyze-stage derivative and settled atomically with it. */
  readonly analysis?: Promise<DuplicateAnalysisItemV1>;
  /** Rejects when a worker-owned publication fence is lost. */
  readonly fence?: Promise<never>;
  readonly publicationLeaseOwnerId?: string;
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
  /** Resolves after every run queued before this call reaches a durable settlement. */
  waitForIdle(): Promise<void>;
  cancel(packId: string, updatedAt: string): Promise<void>;
  recover(): Promise<void>;
}

export interface RecoveredPackProcessingCompletion {
  readonly packId: string;
  readonly itemId: string;
  readonly stage: StartPipelineRunInput['stage'];
  readonly outcome: 'completed' | 'failed';
}

interface ClaimHeartbeat {
  readonly failure: Promise<never>;
  assertOwned(): void;
  stop(): Promise<unknown | undefined>;
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
    private readonly monotonicNow: () => number = monotonicNowMilliseconds,
    private readonly onRecoveredCompletion?: (
      input: RecoveredPackProcessingCompletion,
    ) => void,
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
    const recoveryAt = validatedTimestamp(this.now());
    const runs = await repository.listRunnablePipelineRuns(recoveryAt);
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
      let heartbeat: ClaimHeartbeat | undefined;
      let packCreatedAt = run.startedAt;
      try {
        repository = await this.getRepository();
        const graph = await repository.findPackGraph(run.packId);
        if (!graph) throw new DomainError('PERSISTENCE_CONFLICT');
        packCreatedAt = graph.pack.createdAt;
        const item = graph.items.find(value => value.id === run.itemId);
        if (!item) throw new DomainError('PERSISTENCE_CONFLICT');
        const claimObservedAt = validatedTimestamp(this.now());
        const claimAt = latestTimestamp([
          claimObservedAt,
          packCreatedAt,
          graph.pack.updatedAt,
          run.startedAt,
          run.updatedAt,
        ]);
        claimVersion = await repository.markPipelineRunRunning(
          run.id,
          run.claimVersion,
          claimAt,
          claimObservedAt,
          new Date(
            Date.parse(claimObservedAt) + this.claimLeaseMs,
          ).toISOString(),
        );
        if (claimVersion === null) return;
        const claimedRun: PersistedPipelineRun = {
          ...run,
          status: 'running',
          updatedAt: claimAt,
          claimVersion,
        };
        handle = this.worker.start(claimedRun);
        heartbeat = this.startClaimHeartbeat(repository, claimedRun, claimAt);
      } catch (error) {
        if (
          repository &&
          claimVersion === null &&
          (await this.isDurablyCancelled(repository, run.id))
        )
          return;
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
        let artifact: Artifact | undefined;
        try {
          artifact = await Promise.race([
            handle.result,
            heartbeat.failure,
            ...(handle.fence ? [handle.fence] : []),
          ]);
          heartbeat.assertOwned();
        } catch (error) {
          const heartbeatFailure = await heartbeat.stop();
          if (heartbeatFailure !== undefined) {
            await Promise.allSettled([handle.cancel()]);
            if (await this.isDurablyCancelled(repository, run.id)) return;
            await this.reportUnexpectedFailure(
              run,
              heartbeatFailure,
              repository,
              claimVersion,
              packCreatedAt,
              false,
            );
            return;
          }
          if (processingErrorCode(error) === 'PERSISTENCE_CONFLICT') {
            if (await this.isDurablyCancelled(repository, run.id)) return;
            // Another still-valid cleanup/publisher may hold the global lease,
            // or this claimant may have lost one of its ownership fences. Do
            // not convert routine contention into a terminal run: the running
            // claim becomes stale and recovery retries either the fresh stage
            // or its durable checkpoint after the owner joins/releases.
            await this.reportUnexpectedFailure(
              run,
              error,
              repository,
              claimVersion,
              packCreatedAt,
              false,
            );
            return;
          }
          try {
            heartbeat.assertOwned();
            if (
              processingErrorCode(error) === 'PIPELINE_STAGE_FAILED' &&
              (await this.isDurablyCancelled(repository, run.id))
            )
              return;
            const failed = await repository.failPipelineRun({
              runId: run.id,
              claimVersion,
              updatedAt: this.timestamp(packCreatedAt),
              errorCode: processingErrorCode(error),
            });
            heartbeat.assertOwned();
            if (!failed) {
              if (await this.isDurablyCancelled(repository, run.id)) return;
              throw new DomainError('PERSISTENCE_CONFLICT');
            }
            if (run.status === 'recovering')
              this.publishRecoveredCompletion({
                packId: run.packId,
                itemId: run.itemId,
                stage: run.stage,
                outcome: 'failed',
              });
          } catch (settlementError) {
            await this.reportUnexpectedFailure(
              run,
              settlementError,
              repository,
              claimVersion,
              packCreatedAt,
              false,
            );
          }
          return;
        }
        if (artifact) {
          try {
            heartbeat.assertOwned();
            if (!handle.publicationLeaseOwnerId)
              throw new DomainError('PERSISTENCE_CONFLICT');
            const checkpoint = repository.checkpointPipelineRunArtifact({
              runId: run.id,
              claimVersion,
              updatedAt: this.timestamp(packCreatedAt),
              artifact,
              publicationLeaseOwnerId: handle.publicationLeaseOwnerId,
            });
            const checkpointed = await Promise.race([
              checkpoint,
              ...(handle.fence ? [handle.fence] : []),
            ]);
            heartbeat.assertOwned();
            if (!checkpointed) {
              if (await this.isDurablyCancelled(repository, run.id)) return;
              throw new DomainError('PERSISTENCE_CONFLICT');
            }
          } catch (checkpointError) {
            await heartbeat.stop();
            await this.reportUnexpectedFailure(
              run,
              checkpointError,
              repository,
              claimVersion,
              packCreatedAt,
              false,
            );
            return;
          }
        }
        let analysis: DuplicateAnalysisItemV1 | undefined;
        if (handle.analysis) {
          try {
            analysis = await Promise.race([
              handle.analysis,
              heartbeat.failure,
              ...(handle.fence ? [handle.fence] : []),
            ]);
            heartbeat.assertOwned();
          } catch (analysisError) {
            if (
              processingErrorCode(analysisError) === 'PIPELINE_STAGE_FAILED' &&
              (await this.isDurablyCancelled(repository, run.id))
            )
              return;
            await this.reportUnexpectedFailure(
              run,
              analysisError,
              repository,
              claimVersion,
              packCreatedAt,
              false,
            );
            return;
          }
        }
        try {
          heartbeat.assertOwned();
          const completed = await repository.completePipelineRun({
            runId: run.id,
            claimVersion,
            updatedAt: this.timestamp(packCreatedAt),
            ...(artifact ? { artifact } : {}),
            ...(analysis ? { analysis } : {}),
            ...(artifact && handle.publicationLeaseOwnerId
              ? {
                  publicationLeaseOwnerId: handle.publicationLeaseOwnerId,
                }
              : {}),
          });
          heartbeat.assertOwned();
          if (!completed) {
            if (await this.isDurablyCancelled(repository, run.id)) return;
            throw new DomainError('PERSISTENCE_CONFLICT');
          }
          if (run.status === 'recovering')
            this.publishRecoveredCompletion({
              packId: run.packId,
              itemId: run.itemId,
              stage: run.stage,
              outcome: 'completed',
            });
        } catch (settlementError) {
          await this.reportUnexpectedFailure(
            run,
            settlementError,
            repository,
            claimVersion,
            packCreatedAt,
            false,
          );
        }
      } finally {
        this.active.delete(run.id);
        await heartbeat.stop();
        try {
          await handle.finalize?.();
        } catch (error) {
          await this.reportUnexpectedFailure(
            run,
            error,
            repository,
            claimVersion,
            packCreatedAt,
            false,
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

  private timestamp(...minimums: readonly string[]): string {
    const value = this.now();
    const valueEpoch = Date.parse(value);
    if (!Number.isFinite(valueEpoch)) throw new DomainError('SCHEMA_INVALID');
    return latestTimestamp([value, ...minimums]);
  }

  private publishRecoveredCompletion(
    input: RecoveredPackProcessingCompletion,
  ): void {
    try {
      this.onRecoveredCompletion?.(input);
    } catch {
      // A presentation observer cannot invalidate durable settlement.
    }
  }

  private startClaimHeartbeat(
    repository: ProductionPersistenceRepository,
    run: PersistedPipelineRun,
    chronologyFloor: string,
  ): ClaimHeartbeat {
    const intervalMs = Math.max(1, Math.floor(this.claimLeaseMs / 3));
    let stopped = false;
    let failed = false;
    let failureValue: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = Promise.resolve();
    let localDeadline = this.observedMonotonicNow() + this.claimLeaseMs;
    let logicalAt = latestTimestamp([run.updatedAt, chronologyFloor]);
    let rejectFailure!: (error: unknown) => void;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    const recordFailure = (error: unknown): void => {
      if (failed) return;
      failed = true;
      failureValue = error;
      rejectFailure(error);
    };
    const schedule = (): void => {
      timer = setTimeout(() => {
        inFlight = (async () => {
          const claimObservedAt = validatedTimestamp(this.now());
          const intervalFloor = new Date(
            Date.parse(logicalAt) + intervalMs,
          ).toISOString();
          const renewedAt = latestTimestamp([
            claimObservedAt,
            chronologyFloor,
            logicalAt,
            intervalFloor,
          ]);
          const renewed = await repository.renewPipelineRunClaim(
            run.id,
            run.claimVersion,
            renewedAt,
            claimObservedAt,
            new Date(
              Date.parse(claimObservedAt) + this.claimLeaseMs,
            ).toISOString(),
          );
          if (!renewed) throw new DomainError('PERSISTENCE_CONFLICT');
          logicalAt = renewedAt;
          localDeadline = this.observedMonotonicNow() + this.claimLeaseMs;
        })();
        inFlight.then(() => {
          if (!stopped) schedule();
        }, recordFailure);
      }, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    };
    schedule();
    return {
      failure,
      assertOwned: () => {
        if (!failed && this.observedMonotonicNow() >= localDeadline)
          recordFailure(new DomainError('PERSISTENCE_CONFLICT'));
        if (failed)
          throw failureValue instanceof Error
            ? failureValue
            : new DomainError('PERSISTENCE_CONFLICT');
      },
      stop: async () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        await inFlight.catch(() => undefined);
        if (!failed && this.observedMonotonicNow() >= localDeadline)
          recordFailure(new DomainError('PERSISTENCE_CONFLICT'));
        return failed ? failureValue : undefined;
      },
    };
  }

  private observedMonotonicNow(): number {
    const value = this.monotonicNow();
    if (!Number.isFinite(value) || value < 0)
      throw new DomainError('SCHEMA_INVALID');
    return value;
  }

  private async reportUnexpectedFailure(
    run: PersistedPipelineRun,
    error: unknown,
    repository: ProductionPersistenceRepository | undefined,
    claimVersion: number | null,
    packCreatedAt: string,
    settleRun = true,
  ): Promise<void> {
    const code = processingErrorCode(error);
    const occurredAt = this.timestamp(packCreatedAt);
    if (settleRun && repository && claimVersion !== null) {
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

  private async isDurablyCancelled(
    repository: ProductionPersistenceRepository,
    runId: string,
  ): Promise<boolean> {
    try {
      return await repository.pipelineRunIsCancelled(runId);
    } catch {
      // A failed status read is not proof of an expected cancellation. The
      // caller continues through the normal diagnostic path instead.
      return false;
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
    let publicationHeartbeat: CleanupLeaseHeartbeat | undefined;
    let releasePublicationLifecycleMutex: (() => void) | undefined;
    let rejectPublicationFence!: (error: unknown) => void;
    const publicationFence = new Promise<never>((_resolve, reject) => {
      rejectPublicationFence = reject;
    });
    publicationFence.catch(() => undefined);
    const publicationOwnerId = createCanonicalUuid();
    const assertPublicationLease = (): void => {
      if (!publicationLeaseHeld || !publicationHeartbeat)
        throw new DomainError('PERSISTENCE_CONFLICT');
      publicationHeartbeat.assertOwned();
    };
    const releasePublicationLease = async (): Promise<unknown | undefined> => {
      if (!publicationLeaseHeld || !repository) return undefined;
      const heartbeatFailure = await publicationHeartbeat?.stop();
      publicationLeaseHeld = false;
      try {
        await repository.releaseCleanupLease(publicationOwnerId);
      } finally {
        releasePublicationLifecycleMutex?.();
        releasePublicationLifecycleMutex = undefined;
      }
      return heartbeatFailure;
    };
    const acquirePublicationLease = async (): Promise<void> => {
      if (!repository) throw new DomainError('PERSISTENCE_CONFLICT');
      // The global cleanup/publication lease is an operational wall-clock
      // mutex. Domain chronology may remain ahead after a clock correction,
      // but it must never make another live cleanup owner's TTL look expired.
      const acquiredAt = validatedTimestamp(this.now());
      publicationLeaseHeld = await repository.acquireCleanupLeaseForPipelineRun(
        run.id,
        run.claimVersion,
        publicationOwnerId,
        acquiredAt,
        new Date(
          Date.parse(acquiredAt) + this.publicationLeaseMs,
        ).toISOString(),
      );
      if (!publicationLeaseHeld) throw new DomainError('PERSISTENCE_CONFLICT');
      publicationHeartbeat = startCleanupLeaseHeartbeat(
        repository,
        publicationOwnerId,
        acquiredAt,
        this.publicationLeaseMs,
        this.now,
      );
      publicationHeartbeat.failure.catch(rejectPublicationFence);
      releasePublicationLifecycleMutex = await acquireArtifactLifecycleMutex();
      assertPublicationLease();
    };
    const assertPipelineClaim = async (
      chronologyFloor: string,
    ): Promise<void> => {
      if (!repository) throw new DomainError('PERSISTENCE_CONFLICT');
      const observedAt = validatedTimestamp(this.now());
      const renewed = await repository.renewPipelineRunClaim(
        run.id,
        run.claimVersion,
        latestTimestamp([observedAt, chronologyFloor, run.updatedAt]),
        observedAt,
        new Date(
          Date.parse(observedAt) + this.publicationLeaseMs,
        ).toISOString(),
      );
      if (!renewed) throw new DomainError('PERSISTENCE_CONFLICT');
    };
    const result = (async (): Promise<Artifact | undefined> => {
      if (run.stage !== 'extract')
        throw new DomainError('PIPELINE_STAGE_FAILED');
      repository = await this.getRepository();
      const graph = await repository.findPackGraph(run.packId);
      const item = graph?.items.find(value => value.id === run.itemId);
      if (!graph || !item) throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      const chronologyFloor = latestTimestamp([
        graph.pack.createdAt,
        graph.pack.updatedAt,
        run.startedAt,
        run.updatedAt,
      ]);
      if (run.publishedArtifact) {
        await acquirePublicationLease();
        const checkpoint = run.publishedArtifact;
        const verification = await this.native.verifyArtifact(
          checkpoint.relativePath,
          checkpoint.byteCount,
          checkpoint.sha256,
        );
        if (
          verification.status !== 'verified' ||
          verification.relativePath !== checkpoint.relativePath ||
          verification.byteCount !== checkpoint.byteCount ||
          verification.sha256 !== checkpoint.sha256
        )
          throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
        return checkpoint;
      }
      const artifacts = await repository.listArtifactRecords();
      const original = artifacts.find(
        value => value.itemId === run.itemId && value.kind === 'original',
      );
      if (!original) throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
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
        text = joinBoundedPdfPageText(
          value.pages
            .filter(page => page.status === 'complete')
            .map(page => page.text),
        );
        processorVersion = value.document.revision;
      } else {
        const value = await this.native.readPlainTextFile(
          fileUri,
          undefined,
          original.byteCount,
          original.sha256,
        );
        text = value.text;
        processorVersion = value.revision;
      }
      if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
      await acquirePublicationLease();
      const relativePath = ownedDerivedPath(run.packId, run.id, 'txt');
      const currentArtifacts = await repository.listArtifactRecords();
      await assertPipelineClaim(chronologyFloor);
      assertPublicationLease();
      if (
        currentArtifacts.some(
          artifact => artifact.relativePath === relativePath,
        )
      )
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      const quarantineAndRewrite = async (): Promise<
        Awaited<ReturnType<NativeAdapter['writeTextArtifact']>>
      > => {
        if (!repository) throw new DomainError('PERSISTENCE_CONFLICT');
        const authoritativeArtifacts = await repository.listArtifactRecords();
        await assertPipelineClaim(chronologyFloor);
        assertPublicationLease();
        if (
          authoritativeArtifacts.some(
            artifact => artifact.relativePath === relativePath,
          )
        )
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        const quarantined = await this.native.quarantineOwnedArtifact(
          relativePath,
        );
        await assertPipelineClaim(chronologyFloor);
        assertPublicationLease();
        if (
          !quarantined.quarantined ||
          quarantined.quarantineId === undefined ||
          quarantined.anonymousId === undefined ||
          quarantined.byteCount === undefined
        )
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        const quarantinedAt = validatedTimestamp(this.now(), chronologyFloor);
        await repository.recordQuarantine(
          {
            id: quarantined.quarantineId,
            anonymousId: quarantined.anonymousId,
            reasonCode: 'STORAGE_ARTIFACT_IMMUTABLE',
            byteCount: quarantined.byteCount,
            createdAt: quarantinedAt,
            purgeAfter: new Date(
              Date.parse(quarantinedAt) + 7 * 24 * 60 * 60 * 1_000,
            ).toISOString(),
          },
          publicationOwnerId,
        );
        await assertPipelineClaim(chronologyFloor);
        assertPublicationLease();
        const replacement = await this.native.writeTextArtifact(
          relativePath,
          text,
        );
        assertPublicationLease();
        if (!replacement.created)
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        return replacement;
      };
      let published: Awaited<ReturnType<NativeAdapter['writeTextArtifact']>>;
      let initialPublication:
        | Awaited<ReturnType<NativeAdapter['writeTextArtifact']>>
        | undefined;
      try {
        await assertPipelineClaim(chronologyFloor);
        assertPublicationLease();
        initialPublication = await this.native.writeTextArtifact(
          relativePath,
          text,
        );
      } catch (error) {
        if (processingErrorCode(error) !== 'STORAGE_ARTIFACT_IMMUTABLE')
          throw error;
      }
      assertPublicationLease();
      published =
        initialPublication?.created === true
          ? initialPublication
          : await quarantineAndRewrite();
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
      fence: publicationFence,
      publicationLeaseOwnerId: publicationOwnerId,
      cancel: async () => {
        cancelled = true;
        await cancelActive?.();
      },
      finalize: async () => {
        // Cancellation cannot interrupt an in-flight atomic publication. Keep
        // its global lease until the worker promise observes the native result
        // so cleanup never races bytes that are still being renamed/fsynced.
        await result.catch(() => undefined);
        const heartbeatFailure = await releasePublicationLease();
        if (heartbeatFailure !== undefined)
          throw new DomainError('PERSISTENCE_CONFLICT');
      },
    };
  }
}

/** Routes a stage to exactly one worker so stacked native boundaries stay isolated. */
export class CompositePackStageWorker implements PackStageWorker {
  constructor(private readonly workers: readonly PackStageWorker[]) {
    if (workers.length === 0) throw new DomainError('SCHEMA_INVALID');
  }

  supports(stage: StartPipelineRunInput['stage']): boolean {
    return this.workers.some(worker => worker.supports(stage));
  }

  start(run: PersistedPipelineRun): PackStageWorkHandle {
    const matches = this.workers.filter(worker => worker.supports(run.stage));
    if (matches.length !== 1) throw new DomainError('PIPELINE_STAGE_FAILED');
    return matches[0]!.start(run);
  }
}

/**
 * Produces the immutable normalized-text derivative and its detector record.
 * User decisions are deliberately absent: SQLite settles detector output while
 * retaining the separately persisted review intent.
 */
export class NativeDuplicateAnalysisStageWorker implements PackStageWorker {
  constructor(
    private readonly getRepository: () => Promise<ProductionPersistenceRepository>,
    private readonly native: NativeAdapter,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly publicationLeaseMs = 5 * 60 * 1_000,
  ) {
    if (!Number.isSafeInteger(publicationLeaseMs) || publicationLeaseMs <= 0)
      throw new DomainError('SCHEMA_INVALID');
  }

  supports(stage: StartPipelineRunInput['stage']): boolean {
    return stage === 'analyze';
  }

  start(run: PersistedPipelineRun): PackStageWorkHandle {
    let cancelled = false;
    let repository: ProductionPersistenceRepository | undefined;
    let publicationLeaseHeld = false;
    let publicationHeartbeat: CleanupLeaseHeartbeat | undefined;
    let releasePublicationLifecycleMutex: (() => void) | undefined;
    let rejectPublicationFence!: (error: unknown) => void;
    let normalized: NormalizedContentV1 | undefined;
    let imageFingerprint: ImagePerceptualHashV1 | undefined;
    let originalByteCount: number | undefined;
    let originalSha256: string | undefined;
    let analyzedAt: string | undefined;
    let imageHashActive = false;
    const publicationFence = new Promise<never>((_resolve, reject) => {
      rejectPublicationFence = reject;
    });
    publicationFence.catch(() => undefined);
    const publicationOwnerId = createCanonicalUuid();
    const assertPublicationLease = (): void => {
      if (!publicationLeaseHeld || !publicationHeartbeat)
        throw new DomainError('PERSISTENCE_CONFLICT');
      publicationHeartbeat.assertOwned();
    };
    const releasePublicationLease = async (): Promise<unknown | undefined> => {
      if (!publicationLeaseHeld || !repository) return undefined;
      const heartbeatFailure = await publicationHeartbeat?.stop();
      publicationLeaseHeld = false;
      try {
        await repository.releaseCleanupLease(publicationOwnerId);
      } finally {
        releasePublicationLifecycleMutex?.();
        releasePublicationLifecycleMutex = undefined;
      }
      return heartbeatFailure;
    };
    const acquirePublicationLease = async (): Promise<void> => {
      if (!repository) throw new DomainError('PERSISTENCE_CONFLICT');
      const acquiredAt = validatedTimestamp(this.now());
      publicationLeaseHeld = await repository.acquireCleanupLeaseForPipelineRun(
        run.id,
        run.claimVersion,
        publicationOwnerId,
        acquiredAt,
        new Date(
          Date.parse(acquiredAt) + this.publicationLeaseMs,
        ).toISOString(),
      );
      if (!publicationLeaseHeld) throw new DomainError('PERSISTENCE_CONFLICT');
      publicationHeartbeat = startCleanupLeaseHeartbeat(
        repository,
        publicationOwnerId,
        acquiredAt,
        this.publicationLeaseMs,
        this.now,
      );
      publicationHeartbeat.failure.catch(rejectPublicationFence);
      releasePublicationLifecycleMutex = await acquireArtifactLifecycleMutex();
      assertPublicationLease();
    };
    const assertPipelineClaim = async (
      chronologyFloor: string,
    ): Promise<void> => {
      if (!repository) throw new DomainError('PERSISTENCE_CONFLICT');
      const observedAt = validatedTimestamp(this.now());
      const renewed = await repository.renewPipelineRunClaim(
        run.id,
        run.claimVersion,
        latestTimestamp([observedAt, chronologyFloor, run.updatedAt]),
        observedAt,
        new Date(
          Date.parse(observedAt) + this.publicationLeaseMs,
        ).toISOString(),
      );
      if (!renewed) throw new DomainError('PERSISTENCE_CONFLICT');
    };
    const result = (async (): Promise<Artifact | undefined> => {
      if (run.stage !== 'analyze')
        throw new DomainError('PIPELINE_STAGE_FAILED');
      repository = await this.getRepository();
      const graph = await repository.findPackGraph(run.packId);
      const item = graph?.items.find(value => value.id === run.itemId);
      if (!graph || !item || item.state !== 'extracted')
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      const chronologyFloor = latestTimestamp([
        graph.pack.createdAt,
        graph.pack.updatedAt,
        run.startedAt,
        run.updatedAt,
      ]);
      const artifacts = await repository.listArtifactRecords();
      const original = artifacts.find(
        value => value.itemId === item.id && value.kind === 'original',
      );
      const extracted = artifacts
        .filter(
          value =>
            value.itemId === item.id &&
            (value.kind === 'ocr-text' || value.kind === 'pdf-page-text'),
        )
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .at(-1);
      if (!original || !extracted)
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      await verifyAnalysisSource(this.native, original);
      await verifyAnalysisSource(this.native, extracted);
      originalByteCount = original.byteCount;
      originalSha256 = original.sha256;
      const extractedUri = await this.native.resolveOwnedArtifactFileUri(
        extracted.relativePath,
      );
      const source = await this.native.readPlainTextFile(
        extractedUri,
        DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
        extracted.byteCount,
        extracted.sha256,
      );
      if (source.byteCount !== extracted.byteCount)
        throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
      normalized = await normalizeContentAsyncV1(source.text, {
        isCancelled: () => cancelled,
      });
      if (item.sourceType === 'image') {
        if (
          !this.native.hashImagePerceptually ||
          !this.native.cancelImagePerceptualHash
        )
          throw new DomainError('PIPELINE_STAGE_FAILED');
        const originalUri = await this.native.resolveOwnedArtifactFileUri(
          original.relativePath,
        );
        if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
        imageHashActive = true;
        try {
          imageFingerprint = await this.native.hashImagePerceptually(
            run.id,
            originalUri,
            original.byteCount,
            original.sha256,
          );
        } finally {
          imageHashActive = false;
        }
      }
      analyzedAt = validatedTimestamp(this.now(), chronologyFloor);
      if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
      await acquirePublicationLease();
      if (run.publishedArtifact) {
        const checkpoint = run.publishedArtifact;
        if (
          checkpoint.id !== run.id ||
          checkpoint.itemId !== run.itemId ||
          checkpoint.kind !== 'normalized-text' ||
          checkpoint.processorVersion.processor !==
            'shared-content-normalization' ||
          checkpoint.processorVersion.version !== 'text-normalization-v1' ||
          checkpoint.processorVersion.contractVersion !== 1
        )
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        await verifyNormalizedArtifactContent(
          this.native,
          checkpoint,
          normalized,
        );
        return checkpoint;
      }
      const relativePath = ownedDerivedPath(run.packId, run.id, 'txt');
      await assertPipelineClaim(chronologyFloor);
      assertPublicationLease();
      const authoritativeArtifacts = await repository.listArtifactRecords();
      if (
        authoritativeArtifacts.some(
          artifact => artifact.relativePath === relativePath,
        )
      )
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      let published: Awaited<ReturnType<NativeAdapter['writeTextArtifact']>>;
      try {
        published = await this.native.writeTextArtifact(
          relativePath,
          normalized.text,
        );
      } catch (error) {
        if (processingErrorCode(error) !== 'STORAGE_ARTIFACT_IMMUTABLE')
          throw error;
        published = { relativePath, byteCount: 0, sha256: '', created: false };
      }
      assertPublicationLease();
      if (!published.created) {
        const refreshedArtifacts = await repository.listArtifactRecords();
        await assertPipelineClaim(chronologyFloor);
        assertPublicationLease();
        if (
          refreshedArtifacts.some(
            artifact => artifact.relativePath === relativePath,
          )
        )
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        const quarantined = await this.native.quarantineOwnedArtifact(
          relativePath,
        );
        if (
          !quarantined.quarantined ||
          quarantined.quarantineId === undefined ||
          quarantined.anonymousId === undefined ||
          quarantined.byteCount === undefined
        )
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
        const quarantinedAt = validatedTimestamp(this.now(), chronologyFloor);
        await repository.recordQuarantine(
          {
            id: quarantined.quarantineId,
            anonymousId: quarantined.anonymousId,
            reasonCode: 'STORAGE_ARTIFACT_IMMUTABLE',
            byteCount: quarantined.byteCount,
            createdAt: quarantinedAt,
            purgeAfter: new Date(
              Date.parse(quarantinedAt) + 7 * 24 * 60 * 60 * 1_000,
            ).toISOString(),
          },
          publicationOwnerId,
        );
        await assertPipelineClaim(chronologyFloor);
        assertPublicationLease();
        published = await this.native.writeTextArtifact(
          relativePath,
          normalized.text,
        );
        if (!published.created)
          throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      }
      if (cancelled) throw new DomainError('PIPELINE_STAGE_FAILED');
      const artifact: Artifact = {
        id: run.id,
        itemId: run.itemId,
        kind: 'normalized-text',
        relativePath,
        mediaType: 'text/plain',
        byteCount: published.byteCount,
        sha256: published.sha256,
        processorVersion: {
          processor: 'shared-content-normalization',
          version: 'text-normalization-v1',
          contractVersion: 1,
        },
        createdAt: run.startedAt,
        immutable: true,
      };
      await verifyNormalizedArtifactContent(this.native, artifact, normalized);
      return artifact;
    })();
    const analysis = (async (): Promise<DuplicateAnalysisItemV1> => {
      const artifact = await result;
      if (
        !artifact ||
        !normalized ||
        originalByteCount === undefined ||
        originalSha256 === undefined ||
        analyzedAt === undefined
      )
        throw new DomainError('STORAGE_DIVERGENCE_DETECTED');
      return {
        schemaVersion: 1,
        packId: run.packId,
        itemId: run.itemId,
        originalSha256,
        originalByteCount,
        normalizedArtifactId: artifact.id,
        normalizedSha256: artifact.sha256,
        normalizedByteCount: artifact.byteCount,
        normalizedCharacterCount: normalized.characterCount,
        contentKind: normalized.contentKind,
        textFingerprint: await fingerprintNormalizedTextAsyncV1(normalized, {
          isCancelled: () => cancelled,
        }),
        ...(imageFingerprint ? { imageFingerprint } : {}),
        analyzedAt,
      };
    })();
    // The coordinator settles result before it awaits this dependent branch.
    // Observe rejection immediately so React Native never reports the same
    // analysis failure as a second unhandled rejection; callers still receive
    // the original rejected promise.
    analysis.catch(() => undefined);
    return {
      result,
      analysis,
      fence: publicationFence,
      publicationLeaseOwnerId: publicationOwnerId,
      cancel: async () => {
        cancelled = true;
        if (imageHashActive)
          await this.native.cancelImagePerceptualHash?.(run.id);
      },
      finalize: async () => {
        await Promise.allSettled([result, analysis]);
        const heartbeatFailure = await releasePublicationLease();
        if (heartbeatFailure !== undefined)
          throw new DomainError('PERSISTENCE_CONFLICT');
      },
    };
  }
}

async function verifyAnalysisSource(
  native: NativeAdapter,
  artifact: Artifact,
): Promise<void> {
  const verification = await native.verifyArtifact(
    artifact.relativePath,
    artifact.byteCount,
    artifact.sha256,
  );
  if (
    verification.status !== 'verified' ||
    verification.relativePath !== artifact.relativePath ||
    verification.byteCount !== artifact.byteCount ||
    verification.sha256 !== artifact.sha256
  )
    throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
}

async function verifyNormalizedArtifactContent(
  native: NativeAdapter,
  artifact: Artifact,
  normalized: NormalizedContentV1,
): Promise<void> {
  if (artifact.byteCount !== normalized.utf8ByteCount)
    throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
  await verifyAnalysisSource(native, artifact);
  const uri = await native.resolveOwnedArtifactFileUri(artifact.relativePath);
  const persisted = await native.readPlainTextFile(
    uri,
    DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
    artifact.byteCount,
    artifact.sha256,
  );
  if (
    persisted.byteCount !== normalized.utf8ByteCount ||
    persisted.text !== normalized.text
  )
    throw new DomainError('ARTIFACT_INTEGRITY_FAILED');
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

export function joinBoundedPdfPageText(pageTexts: readonly string[]): string {
  let byteCount = 0;
  for (let index = 0; index < pageTexts.length; index += 1) {
    if (index > 0) byteCount += 2;
    byteCount += utf8ByteCount(pageTexts[index]!);
    if (byteCount > DERIVED_TEXT_MAXIMUM_UTF8_BYTES)
      throw new DomainError('PDF_TOO_LARGE');
  }
  return pageTexts.join('\n\n');
}

function utf8ByteCount(value: string): number {
  let byteCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) byteCount += 1;
    else if (unit <= 0x7ff) byteCount += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      byteCount += 4;
      index += 1;
    } else byteCount += 3;
  }
  return byteCount;
}

function validatedTimestamp(value: string, minimum?: string): string {
  const valueEpoch = Date.parse(value);
  const minimumEpoch = minimum === undefined ? valueEpoch : Date.parse(minimum);
  if (!Number.isFinite(valueEpoch) || !Number.isFinite(minimumEpoch))
    throw new DomainError('SCHEMA_INVALID');
  return valueEpoch < minimumEpoch ? minimum! : value;
}

function latestTimestamp(values: readonly string[]): string {
  if (values.length === 0) throw new DomainError('SCHEMA_INVALID');
  values.forEach(value => {
    if (!Number.isFinite(Date.parse(value)))
      throw new DomainError('SCHEMA_INVALID');
  });
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}
