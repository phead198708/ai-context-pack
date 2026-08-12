jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import {
  DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
  type ImportManifestV1,
} from '../src/domain/contracts';
import type { Artifact, ContextItem } from '../src/domain/models';
import { DomainError } from '../src/domain/errors';
import {
  fingerprintNormalizedTextV1,
  normalizeContentV1,
  type DuplicateAnalysisItemV1,
} from '../src/domain/duplicateDetection';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import { PackLibraryController } from '../src/features/packLibrary/controller';
import {
  DurablePackProcessingCoordinator,
  joinBoundedPdfPageText,
  NativeExtractionStageWorker,
  type PackStageWorker,
  type PackStageWorkHandle,
} from '../src/features/packLibrary/processing';
import type { PersistedPipelineRun } from '../src/infrastructure/persistence/contracts';
import { ownedDerivedPath } from '../src/infrastructure/persistence/ownedPaths';
import {
  ReferenceAwareCleanup,
  ScheduledReferenceAwareCleanup,
} from '../src/infrastructure/persistence/recovery';
import { PublishedArtifactCoordinator } from '../src/infrastructure/persistence/artifactStore';
import { ExpoSqlitePersistenceRepository } from '../src/infrastructure/persistence/sqlite';

type SqlValue = string | number | null;
interface NodeStatement {
  run(...params: readonly SqlValue[]): { readonly changes: number | bigint };
  get(...params: readonly SqlValue[]): unknown;
  all(...params: readonly SqlValue[]): readonly unknown[];
}
interface NodeDatabase {
  exec(source: string): void;
  prepare(source: string): NodeStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  readonly DatabaseSync: new (path: string) => NodeDatabase;
};

class NodeSqlConnection {
  private chain = Promise.resolve();
  constructor(private readonly database: NodeDatabase) {}
  async exec(source: string) {
    this.database.exec(source);
  }
  async run(source: string, params: readonly SqlValue[] = []) {
    const result = this.database.prepare(source).run(...params);
    return { changes: Number(result.changes) };
  }
  async first<T>(source: string, params: readonly SqlValue[] = []) {
    return (
      (this.database.prepare(source).get(...params) as T | undefined) ?? null
    );
  }
  async all<T>(source: string, params: readonly SqlValue[] = []) {
    return this.database.prepare(source).all(...params) as readonly T[];
  }
  exclusive<T>(
    task: (transaction: NodeSqlConnection) => Promise<T>,
  ): Promise<T> {
    const work = this.chain.then(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const value = await task(this);
        this.database.exec('COMMIT');
        return value;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
    this.chain = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
}

class DelayedExclusiveConnection {
  private nextGate:
    | {
        readonly entered: ReturnType<typeof deferred<void>>;
        readonly release: ReturnType<typeof deferred<void>>;
      }
    | undefined;

  constructor(private readonly delegate: NodeSqlConnection) {}

  exec(source: string) {
    return this.delegate.exec(source);
  }

  run(source: string, params: readonly SqlValue[] = []) {
    return this.delegate.run(source, params);
  }

  first<T>(source: string, params: readonly SqlValue[] = []) {
    return this.delegate.first<T>(source, params);
  }

  all<T>(source: string, params: readonly SqlValue[] = []) {
    return this.delegate.all<T>(source, params);
  }

  delayNextExclusive() {
    const gate = { entered: deferred<void>(), release: deferred<void>() };
    this.nextGate = gate;
    return gate;
  }

  async exclusive<T>(
    task: (transaction: NodeSqlConnection) => Promise<T>,
  ): Promise<T> {
    const gate = this.nextGate;
    this.nextGate = undefined;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    return this.delegate.exclusive(task);
  }
}

class RunObservingConnection {
  constructor(
    private readonly delegate: NodeSqlConnection,
    private readonly afterRun: (source: string) => void,
  ) {}

  exec(source: string) {
    return this.delegate.exec(source);
  }

  run(source: string, params: readonly SqlValue[] = []) {
    return this.delegate.run(source, params);
  }

  first<T>(source: string, params: readonly SqlValue[] = []) {
    return this.delegate.first<T>(source, params);
  }

  all<T>(source: string, params: readonly SqlValue[] = []) {
    return this.delegate.all<T>(source, params);
  }

  exclusive<T>(
    task: (transaction: NodeSqlConnection) => Promise<T>,
  ): Promise<T> {
    return this.delegate.exclusive(transaction =>
      task({
        exec: source => transaction.exec(source),
        run: async (source, params = []) => {
          const result = await transaction.run(source, params);
          this.afterRun(source);
          return result;
        },
        first: (source, params = []) => transaction.first(source, params),
        all: (source, params = []) => transaction.all(source, params),
      } as NodeSqlConnection),
    );
  }
}

const packId = '123e4567-e89b-42d3-a456-426614174000';
const itemId = '223e4567-e89b-42d3-a456-426614174000';
const ingestionId = '323e4567-e89b-42d3-a456-426614174000';
const now = '2026-08-11T00:00:00Z';
const operationalSessionId = '333e4567-e89b-42d3-a456-426614174000';
let operationalMilliseconds = 0;

function claimExpiresAt(observedAt: string, durationMs = 5 * 60 * 1_000) {
  return new Date(Date.parse(observedAt) + durationMs).toISOString();
}

function verifiedOriginal() {
  return jest.fn(
    async (relativePath: string, byteCount: number, sha256: string) => ({
      relativePath,
      status: 'verified' as const,
      byteCount,
      sha256,
    }),
  );
}

function imagePublicationNative(
  writeTextArtifact: jest.Mock,
  quarantineOwnedArtifact: jest.Mock,
): NativeAdapter {
  return {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.png'),
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    recognizeText: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      text: 'synthetic OCR text',
      blocks: [],
      durationMs: 1,
      engine: 'apple-vision',
      revision: '3',
      recognitionLevel: 'accurate',
      warnings: [],
    }),
    cancelTextRecognition: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact,
    quarantineOwnedArtifact,
  } as unknown as NativeAdapter;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class DeferredWorker implements PackStageWorker {
  readonly starts: PersistedPipelineRun[] = [];
  readonly cancellations: string[] = [];
  rejectCancellation = false;
  readonly results = new Map<
    string,
    ReturnType<typeof deferred<Artifact | undefined>>
  >();

  supports(stage: PersistedPipelineRun['stage']): boolean {
    return stage === 'extract';
  }

  start(run: PersistedPipelineRun): PackStageWorkHandle {
    this.starts.push(run);
    const result = deferred<Artifact | undefined>();
    this.results.set(run.id, result);
    const publicationOwnerId = run.id;
    return {
      result: result.promise.then(async artifact => {
        if (artifact) {
          const acquired = await repository.acquireCleanupLeaseForPipelineRun(
            run.id,
            run.claimVersion,
            publicationOwnerId,
            now,
            '2026-08-11T00:10:00Z',
          );
          if (!acquired) throw new DomainError('PERSISTENCE_CONFLICT');
        }
        return artifact;
      }),
      publicationLeaseOwnerId: publicationOwnerId,
      cancel: async () => {
        this.cancellations.push(run.id);
        if (this.rejectCancellation)
          throw new Error('synthetic-cancel-failure');
      },
      finalize: async () => repository.releaseCleanupLease(publicationOwnerId),
    };
  }

  artifact(run: PersistedPipelineRun): Artifact {
    return {
      id: run.id,
      itemId: run.itemId,
      kind: 'ocr-text',
      relativePath: ownedDerivedPath(run.packId, run.id, 'txt'),
      mediaType: 'text/plain',
      byteCount: 4,
      sha256: 'b'.repeat(64),
      processorVersion: {
        processor: 'fixture-extraction',
        version: '1',
        contractVersion: 1,
      },
      createdAt: run.startedAt,
      immutable: true,
    };
  }
}

let database: NodeDatabase;
let repository: ExpoSqlitePersistenceRepository;

beforeEach(async () => {
  operationalMilliseconds = 0;
  database = new DatabaseSync(':memory:');
  repository = new ExpoSqlitePersistenceRepository(
    new NodeSqlConnection(database) as never,
    undefined,
    false,
    {
      sessionId: operationalSessionId,
      nowMilliseconds: () => operationalMilliseconds,
    },
  );
  await repository.initialize();
  await seedSingleItem(packId, itemId, ingestionId, 'image/png');
  const graph = (await repository.findPackGraph(packId))!;
  const failed: ContextItem = {
    ...graph.items[0]!,
    state: 'failed',
    retryStage: 'extract',
  };
  await repository.savePackGraph({
    pack: {
      ...graph.pack,
      state: 'failed',
      updatedAt: now,
      orderedItemIds: [itemId],
    },
    items: [failed],
    expectedRevision: graph.revision,
  });
});

async function seedSingleItem(
  seededPackId: string,
  seededItemId: string,
  seededIngestionId: string,
  mediaType: string,
): Promise<void> {
  const manifest: ImportManifestV1 = {
    schemaVersion: 1,
    ingestionId: seededIngestionId,
    createdAt: now,
    source: 'main-app-picker',
    status: 'complete',
    items: [
      {
        id: seededItemId,
        order: 0,
        mediaType,
        status: 'copied',
        byteCount: 4,
        relativePath: `${seededItemId}.bin`,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  await repository.commitImport({
    packId: seededPackId,
    manifest,
    manifestFingerprint: 'c'.repeat(64),
    artifacts: [
      {
        id: seededItemId,
        itemId: seededItemId,
        relativePath: `Packs/${seededPackId}/originals/${seededItemId}.bin`,
        mediaType,
        byteCount: 4,
        sha256: 'a'.repeat(64),
      },
    ],
  });
}

async function persistAndClaim(
  run: PersistedPipelineRun,
): Promise<PersistedPipelineRun> {
  const input = {
    id: run.id,
    packId: run.packId,
    itemId: run.itemId,
    stage: run.stage,
    startedAt: run.startedAt,
  } as const;
  const graph = (await repository.findPackGraph(run.packId))!;
  await repository.savePackGraph({
    pack: {
      ...graph.pack,
      state: 'processing',
      updatedAt: run.startedAt,
    },
    items: graph.items.map(item => {
      if (item.id !== run.itemId) return item;
      const withoutRetryStage = { ...item };
      delete withoutRetryStage.retryStage;
      return {
        ...withoutRetryStage,
        state:
          run.stage === 'analyze'
            ? ('extracted' as const)
            : ('imported' as const),
        updatedAt: run.startedAt,
      };
    }),
    expectedRevision: graph.revision,
    startedPipelineRuns: [input],
  });
  const claimVersion = await repository.markPipelineRunRunning(
    run.id,
    run.claimVersion,
    run.updatedAt,
    run.updatedAt,
    claimExpiresAt(run.updatedAt),
  );
  if (claimVersion === null) throw new Error('synthetic-claim-failed');
  return { ...run, status: 'running', claimVersion };
}

afterEach(() => database.close());

test('executes and atomically settles the exact durable retry run', async () => {
  const worker = new DeferredWorker();
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  const controller = new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  );

  await controller.retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect((await repository.findPackGraph(packId))?.items[0]).toMatchObject({
    state: 'extracted',
    artifactIds: expect.arrayContaining([itemId, run.id]),
  });
  expect(await repository.listRunnablePipelineRuns()).toEqual([]);
});

test('cancellation rejects a late native success and keeps the durable checkpoint', async () => {
  const worker = new DeferredWorker();
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  const controller = new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  );

  await controller.retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  await controller.cancelProcessing(packId);
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect(worker.cancellations).toEqual([run.id]);
  expect(await repository.findPackGraph(packId)).toEqual(
    expect.objectContaining({
      pack: expect.objectContaining({ state: 'cancelled' }),
      items: [expect.objectContaining({ state: 'imported' })],
    }),
  );
  expect(await repository.listArtifactRecords()).toHaveLength(1);
});

test('durable cancellation remains successful when the native cancel request fails', async () => {
  const worker = new DeferredWorker();
  worker.rejectCancellation = true;
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  const controller = new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  );

  await controller.retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  await expect(controller.cancelProcessing(packId)).resolves.toBeUndefined();
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect(worker.cancellations).toEqual([run.id]);
  expect((await repository.findPackGraph(packId))?.pack.state).toBe(
    'cancelled',
  );
  expect(await repository.listArtifactRecords()).toHaveLength(1);
});

test('removing an item cancels its durable run and rejects a late native success', async () => {
  const worker = new DeferredWorker();
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  const controller = new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  );

  await controller.retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  await controller.removeItem(packId, itemId, 'preserve');
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect((await repository.findPackGraph(packId))?.items).toEqual([]);
  expect(await repository.listRunnablePipelineRuns()).toEqual([]);
  expect(await repository.listArtifactRecords()).toEqual([
    expect.objectContaining({ id: itemId, kind: 'original' }),
  ]);
});

test('a replacement coordinator resumes a queued run after restart', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  );
  await controller.retryItem(packId, itemId);
  expect(await repository.listRunnablePipelineRuns()).toEqual([
    expect.objectContaining({ itemId, stage: 'extract', status: 'queued' }),
  ]);

  const worker = new DeferredWorker();
  const recoveredCompletions: {
    readonly packId: string;
    readonly itemId: string;
    readonly stage: 'import' | 'extract' | 'analyze' | 'review' | 'package';
    readonly outcome: 'completed' | 'failed';
  }[] = [];
  const replacement = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
    undefined,
    undefined,
    undefined,
    completion => recoveredCompletions.push(completion),
  );
  await replacement.recover();
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await replacement.waitForIdle();

  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
  expect(recoveredCompletions).toEqual([
    { packId, itemId, stage: 'extract', outcome: 'completed' },
  ]);
});

test('a recovered stage failure refreshes the library after durable failure settlement', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  await new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  ).retryItem(packId, itemId);

  const worker = new DeferredWorker();
  const recoveredSettlements: {
    readonly packId: string;
    readonly itemId: string;
    readonly stage: 'import' | 'extract' | 'analyze' | 'review' | 'package';
    readonly outcome: 'completed' | 'failed';
  }[] = [];
  const replacement = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
    undefined,
    undefined,
    undefined,
    settlement => recoveredSettlements.push(settlement),
  );
  await replacement.recover();
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.reject(new DomainError('PIPELINE_STAGE_FAILED'));
  await replacement.waitForIdle();

  expect((await repository.findPackGraph(packId))?.items[0]).toMatchObject({
    state: 'failed',
    retryStage: 'extract',
  });
  expect(recoveredSettlements).toEqual([
    { packId, itemId, stage: 'extract', outcome: 'failed' },
  ]);
});

test('the durable claim token permits only one coordinator to execute a queued run', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  await new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  ).retryItem(packId, itemId);
  const queued = (await repository.listRunnablePipelineRuns())[0]!;
  const input = {
    id: queued.id,
    packId: queued.packId,
    itemId: queued.itemId,
    stage: queued.stage,
    startedAt: queued.startedAt,
  };
  const firstWorker = new DeferredWorker();
  const secondWorker = new DeferredWorker();
  const first = new DurablePackProcessingCoordinator(
    async () => repository,
    firstWorker,
    () => now,
  );
  const second = new DurablePackProcessingCoordinator(
    async () => repository,
    secondWorker,
    () => now,
  );

  first.launch([input]);
  second.launch([input]);
  await waitFor(
    () => firstWorker.starts.length + secondWorker.starts.length === 1,
  );
  const winner = firstWorker.starts.length === 1 ? firstWorker : secondWorker;
  const run = winner.starts[0]!;
  winner.results.get(run.id)!.resolve(winner.artifact(run));
  await Promise.all([first.waitForIdle(), second.waitForIdle()]);

  expect(firstWorker.starts.length + secondWorker.starts.length).toBe(1);
  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
});

test('cleanup lease ownership is claim-specific and a stale owner cannot release a replacement lease', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  await new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  ).retryItem(packId, itemId);
  const queued = (await repository.listRunnablePipelineRuns())[0]!;
  const firstClaim = await repository.markPipelineRunRunning(
    queued.id,
    queued.claimVersion,
    now,
    now,
    '2026-08-11T00:01:00Z',
  );
  expect(firstClaim).toBe(1);
  const firstOwner = '423e4567-e89b-42d3-a456-426614174000';
  const replacementOwner = '523e4567-e89b-42d3-a456-426614174000';
  const competingOwner = '623e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      queued.id,
      firstClaim!,
      firstOwner,
      now,
      '2026-08-11T00:01:00Z',
    ),
  ).resolves.toBe(true);

  operationalMilliseconds = 60_000;
  const replacementClaim = await repository.markPipelineRunRunning(
    queued.id,
    firstClaim!,
    '2026-08-11T00:02:00Z',
    '2026-08-11T00:02:00Z',
    '2026-08-11T00:07:00Z',
  );
  expect(replacementClaim).toBe(2);
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      queued.id,
      replacementClaim!,
      replacementOwner,
      '2026-08-11T00:02:00Z',
      '2026-08-11T00:04:00Z',
    ),
  ).resolves.toBe(true);

  await repository.releaseCleanupLease(firstOwner);
  await expect(
    repository.acquireCleanupLease(
      competingOwner,
      '2026-08-11T00:03:00Z',
      '2026-08-11T00:05:00Z',
    ),
  ).resolves.toBe(false);
  operationalMilliseconds = 61_000;
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      queued.id,
      firstClaim!,
      firstOwner,
      '2026-08-11T00:05:00Z',
      '2026-08-11T00:06:00Z',
    ),
  ).resolves.toBe(false);
});

test('future Pack chronology cannot expire an active wall-clock cleanup lease', async () => {
  const future = '2026-08-11T00:10:00Z';
  const run = await persistAndClaim({
    id: 'b93e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: future,
    updatedAt: future,
    claimVersion: 0,
  });
  const cleanupOwner = 'c03e4567-e89b-42d3-a456-426614174000';
  const publicationOwner = 'd03e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLease(
      cleanupOwner,
      '2026-08-11T00:00:00Z',
      '2026-08-11T00:01:00Z',
    ),
  ).resolves.toBe(true);

  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      run.claimVersion,
      publicationOwner,
      '2026-08-11T00:00:30Z',
      '2026-08-11T00:01:30Z',
    ),
  ).resolves.toBe(false);
  expect(
    database
      .prepare(
        "SELECT owner_id, acquired_at, expires_at FROM cleanup_leases WHERE name = 'artifact-cleanup'",
      )
      .get(),
  ).toEqual({
    owner_id: cleanupOwner,
    acquired_at: '2026-08-11T00:00:00Z',
    expires_at: '2026-08-11T00:01:00Z',
  });

  operationalMilliseconds = 61_000;
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      run.claimVersion,
      publicationOwner,
      '2026-08-11T00:01:01Z',
      '2026-08-11T00:02:01Z',
    ),
  ).resolves.toBe(true);
  expect(
    database
      .prepare(
        "SELECT owner_id, acquired_at, expires_at FROM cleanup_leases WHERE name = 'artifact-cleanup'",
      )
      .get(),
  ).toEqual({
    owner_id: publicationOwner,
    acquired_at: '2026-08-11T00:01:01Z',
    expires_at: '2026-08-11T00:02:01Z',
  });
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: 'f'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: future,
    immutable: true,
  };
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: future,
      artifact,
      publicationLeaseOwnerId: publicationOwner,
      publicationLeaseObservedAt: '2026-08-11T00:01:30Z',
    }),
  ).resolves.toBe(true);
  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: future,
      artifact,
      publicationLeaseOwnerId: publicationOwner,
      publicationLeaseObservedAt: '2026-08-11T00:01:30Z',
    }),
  ).resolves.toBe(true);
  await repository.releaseCleanupLease(publicationOwner);
});

test('cleanup lease renewal is owner-CAS fenced and rebases after clock rollback', async () => {
  const owner = 'c93e4567-e89b-42d3-a456-426614174000';
  const otherOwner = 'd93e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLease(
      owner,
      '2026-08-11T01:00:00Z',
      '2026-08-11T01:05:00Z',
    ),
  ).resolves.toBe(true);
  await expect(
    repository.renewCleanupLease(
      otherOwner,
      '2026-08-11T00:01:00Z',
      '2026-08-11T00:06:00Z',
    ),
  ).resolves.toBe(false);
  await expect(
    repository.renewCleanupLease(
      owner,
      '2026-08-11T00:01:00Z',
      '2026-08-11T00:06:00Z',
    ),
  ).resolves.toBe(true);
  expect(
    database
      .prepare(
        "SELECT owner_id, acquired_at, expires_at FROM cleanup_leases WHERE name = 'artifact-cleanup'",
      )
      .get(),
  ).toEqual({
    owner_id: owner,
    acquired_at: '2026-08-11T00:01:00Z',
    expires_at: '2026-08-11T00:06:00Z',
  });
  operationalMilliseconds = 299_000;
  await expect(
    repository.acquireCleanupLease(
      otherOwner,
      '2026-08-11T00:05:59Z',
      '2026-08-11T00:10:59Z',
    ),
  ).resolves.toBe(false);
  operationalMilliseconds = 301_000;
  await expect(
    repository.acquireCleanupLease(
      otherOwner,
      '2026-08-11T00:06:01Z',
      '2026-08-11T00:11:01Z',
    ),
  ).resolves.toBe(true);
  await repository.releaseCleanupLease(otherOwner);
});

test('future domain chronology cannot postpone a crashed claim on the wall clock', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  await new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  ).retryItem(packId, itemId);
  const queued = (await repository.listRunnablePipelineRuns())[0]!;
  const futureDomainAt = '2027-08-11T00:00:00Z';
  const firstClaim = await repository.markPipelineRunRunning(
    queued.id,
    queued.claimVersion,
    futureDomainAt,
    now,
    '2026-08-11T00:00:00.900Z',
  );
  expect(firstClaim).toBe(1);
  expect(
    database
      .prepare(
        `SELECT updated_at, claim_session_id, claim_deadline_ms
         FROM pipeline_runs WHERE id = ?`,
      )
      .get(queued.id),
  ).toEqual({
    updated_at: futureDomainAt,
    claim_session_id: operationalSessionId,
    claim_deadline_ms: 900,
  });
  operationalMilliseconds = 899;
  await expect(
    repository.listRunnablePipelineRuns('2026-08-11T00:00:00.899Z'),
  ).resolves.toEqual([]);
  operationalMilliseconds = 900;
  await expect(
    repository.listRunnablePipelineRuns('2026-08-11T00:00:00.900Z'),
  ).resolves.toEqual([
    expect.objectContaining({
      id: queued.id,
      updatedAt: futureDomainAt,
      claimVersion: firstClaim,
    }),
  ]);
  await expect(
    repository.markPipelineRunRunning(
      queued.id,
      firstClaim!,
      futureDomainAt,
      '2026-08-11T00:00:00.900Z',
      '2026-08-11T00:00:01.800Z',
    ),
  ).resolves.toBe(2);
});

test('process replacement immediately reclaims prior-session claims and cleanup leases after clock rollback', async () => {
  const run = await persistAndClaim({
    id: 'a43e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  });
  const oldOwner = 'b43e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      run.claimVersion,
      oldOwner,
      '2026-08-11T01:00:00Z',
      '2026-08-11T01:05:00Z',
    ),
  ).resolves.toBe(true);

  const replacementSessionId = 'c43e4567-e89b-42d3-a456-426614174000';
  const replacement = new ExpoSqlitePersistenceRepository(
    new NodeSqlConnection(database) as never,
    undefined,
    false,
    {
      sessionId: replacementSessionId,
      nowMilliseconds: () => 0,
    },
  );
  await replacement.initialize();
  await expect(replacement.listRunnablePipelineRuns()).resolves.toEqual([
    expect.objectContaining({ id: run.id, claimVersion: run.claimVersion }),
  ]);
  const replacementClaim = await replacement.markPipelineRunRunning(
    run.id,
    run.claimVersion,
    run.updatedAt,
    '2026-08-11T00:01:00Z',
    '2026-08-11T00:06:00Z',
  );
  expect(replacementClaim).toBe(run.claimVersion + 1);
  const replacementOwner = 'd43e4567-e89b-42d3-a456-426614174000';
  await expect(
    replacement.acquireCleanupLeaseForPipelineRun(
      run.id,
      replacementClaim!,
      replacementOwner,
      '2026-08-11T00:01:00Z',
      '2026-08-11T00:06:00Z',
    ),
  ).resolves.toBe(true);
  await expect(
    repository.renewCleanupLease(
      oldOwner,
      '2026-08-11T01:01:00Z',
      '2026-08-11T01:06:00Z',
    ),
  ).resolves.toBe(false);
  await expect(
    repository.failPipelineRun({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: '2026-08-11T01:01:00Z',
      errorCode: 'PIPELINE_STAGE_FAILED',
    }),
  ).resolves.toBe(false);
  await replacement.releaseCleanupLease(replacementOwner);
});

test('checkpoint, completion, and registration observe expiry inside their queued transaction', async () => {
  const run = await persistAndClaim({
    id: 'e43e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  });
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: '9'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  const delayedConnection = new DelayedExclusiveConnection(
    new NodeSqlConnection(database),
  );
  const delayedRepository = new ExpoSqlitePersistenceRepository(
    delayedConnection as never,
    undefined,
    false,
    {
      sessionId: operationalSessionId,
      nowMilliseconds: () => operationalMilliseconds,
    },
  );
  await delayedRepository.initialize();

  const checkpointOwner = 'f43e4567-e89b-42d3-a456-426614174000';
  await repository.acquireCleanupLeaseForPipelineRun(
    run.id,
    run.claimVersion,
    checkpointOwner,
    now,
    '2026-08-11T00:01:00Z',
  );
  let gate = delayedConnection.delayNextExclusive();
  const staleCheckpoint = delayedRepository.checkpointPipelineRunArtifact({
    runId: run.id,
    claimVersion: run.claimVersion,
    updatedAt: now,
    artifact,
    publicationLeaseOwnerId: checkpointOwner,
    publicationLeaseObservedAt: now,
  });
  await gate.entered.promise;
  operationalMilliseconds = 60_000;
  gate.release.resolve();
  await expect(staleCheckpoint).resolves.toBe(false);

  const completionOwner = '053e4567-e89b-42d3-a456-426614174000';
  await repository.acquireCleanupLeaseForPipelineRun(
    run.id,
    run.claimVersion,
    completionOwner,
    '2026-08-11T00:01:00Z',
    '2026-08-11T00:02:00Z',
  );
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: '2026-08-11T00:01:00Z',
      artifact,
      publicationLeaseOwnerId: completionOwner,
    }),
  ).resolves.toBe(true);
  gate = delayedConnection.delayNextExclusive();
  const staleCompletion = delayedRepository.completePipelineRun({
    runId: run.id,
    claimVersion: run.claimVersion,
    updatedAt: '2026-08-11T00:01:00Z',
    artifact,
    publicationLeaseOwnerId: completionOwner,
    publicationLeaseObservedAt: '2026-08-11T00:01:00Z',
  });
  await gate.entered.promise;
  operationalMilliseconds = 120_000;
  gate.release.resolve();
  await expect(staleCompletion).resolves.toBe(false);

  const registrationOwner = '153e4567-e89b-42d3-a456-426614174000';
  await repository.acquireCleanupLease(
    registrationOwner,
    '2026-08-11T00:02:00Z',
    '2026-08-11T00:03:00Z',
  );
  gate = delayedConnection.delayNextExclusive();
  const staleRegistration = delayedRepository.registerPublishedArtifact({
    packId,
    artifact,
    publicationLeaseOwnerId: registrationOwner,
    publicationLeaseObservedAt: '2026-08-11T00:02:00Z',
  });
  await gate.entered.promise;
  operationalMilliseconds = 180_000;
  gate.release.resolve();
  await expect(staleRegistration).rejects.toMatchObject({
    code: 'PERSISTENCE_CONFLICT',
  });
});

test('settlement and failure roll back when ownership expires after their final awaited mutation', async () => {
  const run = await persistAndClaim({
    id: '253e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  });
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: '8'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  const publicationOwner = '353e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      run.claimVersion,
      publicationOwner,
      now,
      '2026-08-11T00:01:00Z',
    ),
  ).resolves.toBe(true);
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: now,
      artifact,
      publicationLeaseOwnerId: publicationOwner,
    }),
  ).resolves.toBe(true);

  let expireAfterPackUpdate = true;
  const observingRepository = new ExpoSqlitePersistenceRepository(
    new RunObservingConnection(new NodeSqlConnection(database), source => {
      if (
        expireAfterPackUpdate &&
        source.includes('UPDATE packs SET updated_at')
      ) {
        operationalMilliseconds = 60_000;
        expireAfterPackUpdate = false;
      }
    }) as never,
    undefined,
    false,
    {
      sessionId: operationalSessionId,
      nowMilliseconds: () => operationalMilliseconds,
    },
  );
  await observingRepository.initialize();
  await expect(
    observingRepository.completePipelineRun({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: now,
      artifact,
      publicationLeaseOwnerId: publicationOwner,
    }),
  ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
  expect(await repository.listArtifactRecords()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: run.id })]),
  );
  expect(
    database
      .prepare('SELECT status FROM pipeline_runs WHERE id = ?')
      .get(run.id),
  ).toEqual({ status: 'running' });

  operationalMilliseconds = 60_001;
  const renewed = await repository.renewPipelineRunClaim(
    run.id,
    run.claimVersion,
    '2026-08-11T00:01:00Z',
    '2026-08-11T00:01:00Z',
    '2026-08-11T00:02:00Z',
  );
  expect(renewed).toBe(true);
  const failureRepository = new ExpoSqlitePersistenceRepository(
    new RunObservingConnection(new NodeSqlConnection(database), source => {
      if (source.includes("UPDATE packs SET state = 'failed'"))
        operationalMilliseconds = 120_001;
    }) as never,
    undefined,
    false,
    {
      sessionId: operationalSessionId,
      nowMilliseconds: () => operationalMilliseconds,
    },
  );
  await failureRepository.initialize();
  await expect(
    failureRepository.failPipelineRun({
      runId: run.id,
      claimVersion: run.claimVersion,
      updatedAt: '2026-08-11T00:01:00Z',
      errorCode: 'PIPELINE_STAGE_FAILED',
    }),
  ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
  expect(
    database
      .prepare('SELECT status FROM pipeline_runs WHERE id = ?')
      .get(run.id),
  ).toEqual({ status: 'running' });
  expect(
    database.prepare('SELECT state FROM packs WHERE id = ?').get(packId),
  ).toEqual({ state: 'processing' });
});

test('queued cleanup database mutations reject an expired lease before committing', async () => {
  const delayedConnection = new DelayedExclusiveConnection(
    new NodeSqlConnection(database),
  );
  const delayedRepository = new ExpoSqlitePersistenceRepository(
    delayedConnection as never,
    undefined,
    false,
    {
      sessionId: operationalSessionId,
      nowMilliseconds: () => operationalMilliseconds,
    },
  );
  await delayedRepository.initialize();
  const publicationOwner = '553e4567-e89b-42d3-a456-426614174000';
  const artifactId = '653e4567-e89b-42d3-a456-426614174000';
  const artifact: Artifact = {
    id: artifactId,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, artifactId, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: '7'.repeat(64),
    processorVersion: {
      processor: 'fixture-publication',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  await expect(
    repository.acquireCleanupLease(
      publicationOwner,
      now,
      '2026-08-11T00:01:00Z',
    ),
  ).resolves.toBe(true);
  await repository.registerPublishedArtifact({
    packId,
    artifact,
    publicationLeaseOwnerId: publicationOwner,
  });
  await repository.releaseCleanupLease(publicationOwner);

  const delayPastLease = async <T>(
    ownerId: string,
    mutation: () => Promise<T>,
  ): Promise<void> => {
    const observedAt = operationalMilliseconds;
    await expect(
      repository.acquireCleanupLease(
        ownerId,
        new Date(Date.parse(now) + observedAt).toISOString(),
        new Date(Date.parse(now) + observedAt + 10).toISOString(),
      ),
    ).resolves.toBe(true);
    const gate = delayedConnection.delayNextExclusive();
    const pending = mutation();
    await gate.entered.promise;
    operationalMilliseconds = observedAt + 10;
    gate.release.resolve();
    await expect(pending).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
  };

  const deleteOwner = '753e4567-e89b-42d3-a456-426614174000';
  await delayPastLease(deleteOwner, () =>
    delayedRepository.deleteArtifactRecordIfUnreferenced(
      artifactId,
      deleteOwner,
    ),
  );
  expect(await repository.listArtifactRecords()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: artifactId })]),
  );

  const quarantineOwner = '853e4567-e89b-42d3-a456-426614174000';
  await delayPastLease(quarantineOwner, () =>
    delayedRepository.recordQuarantine(
      {
        id: '953e4567-e89b-42d3-a456-426614174000',
        anonymousId: artifactId,
        reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
        byteCount: 4,
        createdAt: now,
        purgeAfter: '2026-08-18T00:00:00Z',
      },
      quarantineOwner,
    ),
  );
  await expect(repository.getStorageUsage()).resolves.toMatchObject({
    quarantineCount: 0,
  });

  const recordOwner = 'a53e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLease(
      recordOwner,
      '2026-08-11T00:00:00.020Z',
      '2026-08-11T00:00:01.020Z',
    ),
  ).resolves.toBe(true);
  await repository.recordQuarantine(
    {
      id: 'b53e4567-e89b-42d3-a456-426614174000',
      anonymousId: artifactId,
      reasonCode: 'STORAGE_DIVERGENCE_DETECTED',
      byteCount: 4,
      createdAt: now,
      purgeAfter: '2026-08-18T00:00:00Z',
    },
    recordOwner,
  );
  await repository.releaseCleanupLease(recordOwner);
  const purgeOwner = 'c53e4567-e89b-42d3-a456-426614174000';
  await delayPastLease(purgeOwner, () =>
    delayedRepository.markQuarantinePurgedBefore(
      '2026-08-12T00:00:00Z',
      '2026-08-12T00:00:00Z',
      purgeOwner,
    ),
  );
  await expect(repository.getStorageUsage()).resolves.toMatchObject({
    quarantineCount: 1,
  });
});

test('publication checkpoints are exact-claim idempotent and reject descriptor changes', async () => {
  const run: PersistedPipelineRun = {
    id: '493e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const claimed = await persistAndClaim(run);
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: 'a'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  const publicationOwnerId = 'e83e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      claimed.claimVersion,
      publicationOwnerId,
      now,
      '2026-08-11T00:10:00Z',
    ),
  ).resolves.toBe(true);

  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      publicationLeaseOwnerId: publicationOwnerId,
      publicationLeaseObservedAt: now,
    }),
  ).resolves.toBe(true);
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      publicationLeaseOwnerId: publicationOwnerId,
      publicationLeaseObservedAt: now,
    }),
  ).resolves.toBe(true);
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact: { ...artifact, sha256: 'b'.repeat(64) },
      publicationLeaseOwnerId: publicationOwnerId,
      publicationLeaseObservedAt: now,
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_ARTIFACT_IMMUTABLE' });

  operationalMilliseconds = 300_000;
  const replacementClaim = await repository.markPipelineRunRunning(
    run.id,
    claimed.claimVersion,
    '2026-08-11T00:06:00Z',
    '2026-08-11T00:06:00Z',
    '2026-08-11T00:11:00Z',
  );
  expect(replacementClaim).toBe(claimed.claimVersion + 1);
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: '2026-08-11T00:06:00Z',
      artifact,
      publicationLeaseOwnerId: publicationOwnerId,
      publicationLeaseObservedAt: now,
    }),
  ).resolves.toBe(false);
});

test('analyze settlement atomically registers normalized text and versioned analysis', async () => {
  const run: PersistedPipelineRun = {
    id: '693e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'analyze',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const claimed = await persistAndClaim(run);
  const normalized = normalizeContentV1(
    'Synthetic duplicate-analysis text with enough stable characters.',
  );
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'normalized-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: normalized.utf8ByteCount,
    sha256: 'd'.repeat(64),
    processorVersion: {
      processor: 'shared-content-normalization',
      version: 'text-normalization-v1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  const analysis: DuplicateAnalysisItemV1 = {
    schemaVersion: 1,
    packId,
    itemId,
    originalSha256: 'a'.repeat(64),
    originalByteCount: 4,
    normalizedArtifactId: artifact.id,
    normalizedSha256: artifact.sha256,
    normalizedByteCount: artifact.byteCount,
    normalizedCharacterCount: normalized.characterCount,
    contentKind: normalized.contentKind,
    textFingerprint: fingerprintNormalizedTextV1(normalized),
    imageFingerprint: {
      schemaVersion: 1,
      algorithm: 'dhash-64-v1',
      hash: '0123456789abcdef',
      sampleWidth: 9,
      sampleHeight: 8,
      orientationApplied: true,
      durationMs: 0,
      revision: '1',
    },
    analyzedAt: now,
  };
  const owner = 'e93e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      claimed.claimVersion,
      owner,
      now,
      '2026-08-11T00:10:00Z',
    ),
  ).resolves.toBe(true);
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact: {
        ...artifact,
        processorVersion: {
          ...artifact.processorVersion,
          version: 'future-normalization',
        },
      },
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).resolves.toBe(true);

  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      analysis: {
        ...analysis,
        normalizedByteCount: 0,
        normalizedCharacterCount: 0,
      },
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      analysis: {
        ...analysis,
        textFingerprint: {
          ...analysis.textFingerprint,
          shingleCount: 1_000,
        },
      },
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  const analysisWithoutImageFingerprint = { ...analysis };
  delete (
    analysisWithoutImageFingerprint as {
      imageFingerprint?: DuplicateAnalysisItemV1['imageFingerprint'];
    }
  ).imageFingerprint;
  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      analysis: analysisWithoutImageFingerprint,
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_DIVERGENCE_DETECTED' });

  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      analysis: { ...analysis, normalizedSha256: 'e'.repeat(64) },
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  expect(
    database.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id),
  ).toBeUndefined();
  await expect(repository.findDuplicateAnalysis(packId)).resolves.toEqual({
    manifest: null,
    analyses: [],
    suggestions: [],
    decisions: [],
  });

  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      analysis,
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: now,
    }),
  ).resolves.toBe(true);
  await expect(repository.findDuplicateAnalysis(packId)).resolves.toMatchObject(
    {
      manifest: { packId, itemCount: 1, suggestionCount: 0 },
      analyses: [analysis],
      suggestions: [],
      decisions: [],
    },
  );
  await expect(repository.findPackGraph(packId)).resolves.toMatchObject({
    items: [{ id: itemId, state: 'analyzed' }],
  });
  await repository.releaseCleanupLease(owner);
});

test('extraction settlement is fenced when the publication lease owner changes', async () => {
  const run: PersistedPipelineRun = {
    id: 'f83e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const claimed = await persistAndClaim(run);
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: 'a'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  const owner = 'a73e4567-e89b-42d3-a456-426614174000';
  const replacementOwner = 'b73e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
    } as never),
  ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  await repository.acquireCleanupLeaseForPipelineRun(
    run.id,
    claimed.claimVersion,
    owner,
    now,
    '2026-08-11T00:01:00Z',
  );
  await repository.checkpointPipelineRunArtifact({
    runId: run.id,
    claimVersion: claimed.claimVersion,
    updatedAt: now,
    artifact,
    publicationLeaseOwnerId: owner,
    publicationLeaseObservedAt: now,
  });
  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
    } as never),
  ).resolves.toBe(false);
  operationalMilliseconds = 60_000;
  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: '2026-08-11T00:01:00Z',
      artifact,
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: '2026-08-11T00:01:00Z',
    }),
  ).resolves.toBe(false);
  await expect(
    repository.acquireCleanupLease(
      replacementOwner,
      '2026-08-11T00:02:00Z',
      '2026-08-11T00:03:00Z',
    ),
  ).resolves.toBe(true);

  await expect(
    repository.completePipelineRun({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: '2026-08-11T00:02:00Z',
      artifact,
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: '2026-08-11T00:02:00Z',
    }),
  ).resolves.toBe(false);
  operationalMilliseconds = 300_000;
  expect(
    (await repository.listRunnablePipelineRuns('2026-08-11T00:05:00Z'))[0],
  ).toMatchObject({
    id: run.id,
    status: 'running',
    publishedArtifact: artifact,
  });
  await repository.releaseCleanupLease(replacementOwner);
});

test('publication checkpoint fails closed when the matching lease owner has expired', async () => {
  const run: PersistedPipelineRun = {
    id: 'c73e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const claimed = await persistAndClaim(run);
  const owner = 'd73e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      claimed.claimVersion,
      owner,
      now,
      '2026-08-11T00:01:00Z',
    ),
  ).resolves.toBe(true);

  operationalMilliseconds = 60_000;
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: '2026-08-11T00:01:00Z',
      publicationLeaseOwnerId: owner,
      publicationLeaseObservedAt: '2026-08-11T00:01:00Z',
      artifact: {
        id: run.id,
        itemId,
        kind: 'ocr-text',
        relativePath: ownedDerivedPath(packId, run.id, 'txt'),
        mediaType: 'text/plain',
        byteCount: 4,
        sha256: 'a'.repeat(64),
        processorVersion: {
          processor: 'fixture-extraction',
          version: '1',
          contractVersion: 1,
        },
        createdAt: now,
        immutable: true,
      },
    }),
  ).resolves.toBe(false);
  await repository.releaseCleanupLease(owner);
});

test('checkpoint recovery lease contention stays recoverable instead of failing the run', async () => {
  const run: PersistedPipelineRun = {
    id: 'e73e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const claimed = await persistAndClaim(run);
  const artifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 4,
    sha256: 'e'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  const originalOwner = 'f73e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLeaseForPipelineRun(
      run.id,
      claimed.claimVersion,
      originalOwner,
      now,
      '2026-08-11T00:10:00Z',
    ),
  ).resolves.toBe(true);
  await expect(
    repository.checkpointPipelineRunArtifact({
      runId: run.id,
      claimVersion: claimed.claimVersion,
      updatedAt: now,
      artifact,
      publicationLeaseOwnerId: originalOwner,
      publicationLeaseObservedAt: now,
    }),
  ).resolves.toBe(true);

  const onUnexpectedFailure = jest.fn();
  const contending = new DurablePackProcessingCoordinator(
    async () => repository,
    new NativeExtractionStageWorker(
      async () => repository,
      {} as NativeAdapter,
      () => '2026-08-11T00:06:00Z',
    ),
    () => '2026-08-11T00:06:00Z',
    5 * 60 * 1_000,
    onUnexpectedFailure,
  );
  operationalMilliseconds = 300_000;
  await contending.recover();
  await contending.waitForIdle();

  expect(onUnexpectedFailure).toHaveBeenCalledWith({
    runId: run.id,
    code: 'PERSISTENCE_CONFLICT',
  });
  operationalMilliseconds = 600_000;
  expect(
    await repository.listRunnablePipelineRuns('2026-08-11T00:12:00Z'),
  ).toEqual([
    expect.objectContaining({
      id: run.id,
      status: 'running',
      claimVersion: claimed.claimVersion + 1,
      publishedArtifact: artifact,
    }),
  ]);
  await repository.releaseCleanupLease(originalOwner);

  const verifyArtifact = jest.fn(
    async (relativePath: string, byteCount: number, sha256: string) => ({
      relativePath,
      status: 'verified' as const,
      byteCount,
      sha256,
    }),
  );
  const resumed = new DurablePackProcessingCoordinator(
    async () => repository,
    new NativeExtractionStageWorker(
      async () => repository,
      { verifyArtifact } as unknown as NativeAdapter,
      () => '2026-08-11T00:12:00Z',
    ),
    () => '2026-08-11T00:12:00Z',
  );
  await resumed.recover();
  await resumed.waitForIdle();

  expect(verifyArtifact).toHaveBeenCalledWith(
    artifact.relativePath,
    artifact.byteCount,
    artifact.sha256,
  );
  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
});

test('fresh extraction publication contention stays recoverable and publishes once after the lease is released', async () => {
  const cleanupOwner = '173e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLease(cleanupOwner, now, '2026-08-11T00:10:00Z'),
  ).resolves.toBe(true);
  const writeTextArtifact = jest.fn().mockResolvedValue({
    relativePath: ownedDerivedPath(
      packId,
      '273e4567-e89b-42d3-a456-426614174000',
      'txt',
    ),
    byteCount: 18,
    sha256: 'b'.repeat(64),
    created: true,
  });
  const onUnexpectedFailure = jest.fn();
  const worker = new NativeExtractionStageWorker(
    async () => repository,
    imagePublicationNative(writeTextArtifact, jest.fn()),
    () => now,
  );
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
    5 * 60 * 1_000,
    onUnexpectedFailure,
    () => operationalMilliseconds,
  );
  const fail = jest.spyOn(repository, 'failPipelineRun');

  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await coordinator.waitForIdle();

  expect(writeTextArtifact).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
  expect(onUnexpectedFailure).toHaveBeenCalledWith({
    runId: expect.any(String),
    code: 'PERSISTENCE_CONFLICT',
  });
  expect((await repository.findPackGraph(packId))?.pack.state).toBe(
    'processing',
  );
  await expect(repository.listRunnablePipelineRuns()).resolves.toEqual([]);

  await repository.releaseCleanupLease(cleanupOwner);
  operationalMilliseconds = 5 * 60 * 1_000;
  await coordinator.recover();
  await coordinator.waitForIdle();

  expect(writeTextArtifact).toHaveBeenCalledTimes(1);
  expect(fail).not.toHaveBeenCalled();
  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
  await expect(repository.listRunnablePipelineRuns()).resolves.toEqual([]);
});

test('a replacement coordinator does not reclaim a live running claim', async () => {
  const firstWorker = new DeferredWorker();
  const first = new DurablePackProcessingCoordinator(
    async () => repository,
    firstWorker,
    () => now,
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    first,
  ).retryItem(packId, itemId);
  await waitFor(() => firstWorker.starts.length === 1);

  const replacementWorker = new DeferredWorker();
  const replacement = new DurablePackProcessingCoordinator(
    async () => repository,
    replacementWorker,
    () => now,
  );
  await replacement.recover();
  await replacement.waitForIdle();

  expect(replacementWorker.starts).toHaveLength(0);
  const run = firstWorker.starts[0]!;
  firstWorker.results.get(run.id)!.resolve(firstWorker.artifact(run));
  await first.waitForIdle();
  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
});

test('a heartbeat keeps a long-running claim live for a quick replacement recovery', async () => {
  jest.useFakeTimers();
  let clock = Date.parse(now);
  try {
    const firstWorker = new DeferredWorker();
    const renew = jest.spyOn(repository, 'renewPipelineRunClaim');
    const first = new DurablePackProcessingCoordinator(
      async () => repository,
      firstWorker,
      () => new Date(clock).toISOString(),
      90,
      undefined,
      () => operationalMilliseconds,
    );
    await new PackLibraryController(
      async () => repository,
      () => new Date(clock).toISOString(),
      first,
    ).retryItem(packId, itemId);
    await flushPromises();
    expect(firstWorker.starts).toHaveLength(1);

    clock += 30;
    operationalMilliseconds += 30;
    jest.advanceTimersByTime(30);
    await flushPromises();
    expect(renew).toHaveBeenCalledWith(
      firstWorker.starts[0]!.id,
      firstWorker.starts[0]!.claimVersion,
      new Date(clock).toISOString(),
      new Date(clock).toISOString(),
      new Date(clock + 90).toISOString(),
    );

    const replacementWorker = new DeferredWorker();
    const replacement = new DurablePackProcessingCoordinator(
      async () => repository,
      replacementWorker,
      () => new Date(clock).toISOString(),
      90,
      undefined,
      () => operationalMilliseconds,
    );
    await replacement.recover();
    await replacement.waitForIdle();
    expect(replacementWorker.starts).toHaveLength(0);

    const run = firstWorker.starts[0]!;
    firstWorker.results.get(run.id)!.resolve(firstWorker.artifact(run));
    await first.waitForIdle();
  } finally {
    jest.useRealTimers();
  }
});

test('a lost heartbeat cancels native work and surfaces a durable diagnostic without stale settlement', async () => {
  jest.useFakeTimers();
  try {
    const worker = new DeferredWorker();
    const onUnexpectedFailure = jest.fn();
    jest.spyOn(repository, 'renewPipelineRunClaim').mockResolvedValue(false);
    const fail = jest.spyOn(repository, 'failPipelineRun');
    const coordinator = new DurablePackProcessingCoordinator(
      async () => repository,
      worker,
      () => now,
      30,
      onUnexpectedFailure,
      () => operationalMilliseconds,
    );
    await new PackLibraryController(
      async () => repository,
      () => now,
      coordinator,
    ).retryItem(packId, itemId);
    await flushPromises();
    expect(worker.starts).toHaveLength(1);

    operationalMilliseconds = 10;
    jest.advanceTimersByTime(10);
    await flushPromises();
    await coordinator.waitForIdle();

    expect(worker.cancellations).toEqual([worker.starts[0]!.id]);
    expect(fail).not.toHaveBeenCalled();
    expect(onUnexpectedFailure).toHaveBeenCalledWith({
      runId: worker.starts[0]!.id,
      code: 'PERSISTENCE_CONFLICT',
    });
    expect(await repository.listRecoveryDiagnostics()).toEqual([
      expect.objectContaining({
        anonymousId: worker.starts[0]!.id,
        code: 'PERSISTENCE_CONFLICT',
        phase: 'coordinator-execution',
      }),
    ]);
  } finally {
    jest.useRealTimers();
  }
});

test('a suspended expired claimant cannot checkpoint or settle a late worker success before its delayed timer runs', async () => {
  jest.useFakeTimers();
  try {
    const worker = new DeferredWorker();
    const checkpoint = jest.spyOn(repository, 'checkpointPipelineRunArtifact');
    const complete = jest.spyOn(repository, 'completePipelineRun');
    const coordinator = new DurablePackProcessingCoordinator(
      async () => repository,
      worker,
      () => now,
      90,
      undefined,
      () => operationalMilliseconds,
    );
    await new PackLibraryController(
      async () => repository,
      () => now,
      coordinator,
    ).retryItem(packId, itemId);
    await flushPromises();
    expect(worker.starts).toHaveLength(1);
    const run = worker.starts[0]!;

    // Model event-loop suspension: monotonic time advances past the deadline,
    // but the 30 ms heartbeat timer is deliberately not advanced.
    operationalMilliseconds = 91;
    worker.results.get(run.id)!.resolve(worker.artifact(run));
    await flushPromises();
    await coordinator.waitForIdle();

    expect(checkpoint).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(worker.cancellations).toEqual([run.id]);
    await expect(repository.listRunnablePipelineRuns()).resolves.toEqual([
      expect.objectContaining({ id: run.id, claimVersion: run.claimVersion }),
    ]);
  } finally {
    jest.useRealTimers();
  }
});

test('an expired running claim is recoverable and rejects its old late success', async () => {
  const firstWorker = new DeferredWorker();
  const first = new DurablePackProcessingCoordinator(
    async () => repository,
    firstWorker,
    () => now,
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    first,
  ).retryItem(packId, itemId);
  await waitFor(() => firstWorker.starts.length === 1);
  const oldRun = firstWorker.starts[0]!;

  const replacementWorker = new DeferredWorker();
  const replacement = new DurablePackProcessingCoordinator(
    async () => repository,
    replacementWorker,
    () => '2026-08-11T00:06:00Z',
  );
  operationalMilliseconds = 300_000;
  await replacement.recover();
  await waitFor(() => replacementWorker.starts.length === 1);
  const replacementRun = replacementWorker.starts[0]!;
  replacementWorker.results
    .get(replacementRun.id)!
    .resolve(replacementWorker.artifact(replacementRun));
  await replacement.waitForIdle();

  firstWorker.results.get(oldRun.id)!.resolve(firstWorker.artifact(oldRun));
  await first.waitForIdle();

  expect((await repository.findPackGraph(packId))?.items[0]).toMatchObject({
    state: 'extracted',
    artifactIds: expect.arrayContaining([itemId, replacementRun.id]),
  });
  expect(await repository.listArtifactRecords()).toHaveLength(2);
});

test('unexpected coordinator database failures are surfaced and retried once', async () => {
  const worker = new DeferredWorker();
  const onUnexpectedFailure = jest.fn();
  jest
    .spyOn(repository, 'markPipelineRunRunning')
    .mockRejectedValueOnce(new Error('synthetic-database-failure'));
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
    5 * 60 * 1_000,
    onUnexpectedFailure,
  );

  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect(worker.starts).toHaveLength(1);
  expect(onUnexpectedFailure).toHaveBeenCalledWith({
    runId: expect.any(String),
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(await repository.listRunnablePipelineRuns()).toEqual([]);
  expect(await repository.listRecoveryDiagnostics()).toEqual([
    expect.objectContaining({
      scope: 'pipeline',
      phase: 'coordinator-execution',
      code: 'PIPELINE_STAGE_FAILED',
    }),
  ]);
  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
});

test('completion settlement rejection is diagnosed without converting successful worker output into a stage failure', async () => {
  const worker = new DeferredWorker();
  const onUnexpectedFailure = jest.fn();
  const complete = jest
    .spyOn(repository, 'completePipelineRun')
    .mockRejectedValueOnce(
      new Error('synthetic-completion-settlement-failure'),
    );
  const fail = jest.spyOn(repository, 'failPipelineRun');
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
    5 * 60 * 1_000,
    onUnexpectedFailure,
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect(complete).toHaveBeenCalledTimes(1);
  expect(fail).not.toHaveBeenCalled();
  expect(onUnexpectedFailure).toHaveBeenCalledWith({
    runId: run.id,
    code: 'PIPELINE_STAGE_FAILED',
  });
  expect(await repository.listRecoveryDiagnostics()).toEqual([
    expect.objectContaining({
      anonymousId: run.id,
      code: 'PIPELINE_STAGE_FAILED',
      phase: 'coordinator-execution',
    }),
  ]);

  operationalMilliseconds = 300_000;
  const checkpointed = await repository.listRunnablePipelineRuns(
    '2026-08-11T00:06:00Z',
  );
  expect(checkpointed).toEqual([
    expect.objectContaining({
      id: run.id,
      publishedArtifact: worker.artifact(run),
    }),
  ]);
  expect(await repository.listKnownRelativePaths()).toContain(
    worker.artifact(run).relativePath,
  );
  const quarantineCheckpoint = jest.fn();
  await new ReferenceAwareCleanup(
    repository,
    {
      listOwnedFiles: jest.fn().mockResolvedValue([
        {
          relativePath: worker.artifact(run).relativePath,
          byteCount: worker.artifact(run).byteCount,
        },
      ]),
      removeOwnedFile: jest.fn(),
      quarantineOwnedFile: quarantineCheckpoint,
      purgeQuarantine: jest.fn(),
    },
    'e73e4567-e89b-42d3-a456-426614174000',
  ).run('2026-08-10T00:00:00Z');
  expect(quarantineCheckpoint).not.toHaveBeenCalled();

  const verifyArtifact = jest.fn(
    async (relativePath: string, byteCount: number, sha256: string) => ({
      relativePath,
      status: 'verified' as const,
      byteCount,
      sha256,
    }),
  );
  const recognizeText = jest.fn();
  const writeTextArtifact = jest.fn();
  const replacementWorker = new NativeExtractionStageWorker(
    async () => repository,
    {
      verifyArtifact,
      recognizeText,
      writeTextArtifact,
    } as unknown as NativeAdapter,
    () => '2026-08-11T00:06:00Z',
  );
  const replacement = new DurablePackProcessingCoordinator(
    async () => repository,
    replacementWorker,
    () => '2026-08-11T00:06:00Z',
  );
  await replacement.recover();
  await replacement.waitForIdle();
  expect(verifyArtifact).toHaveBeenCalledWith(
    worker.artifact(run).relativePath,
    worker.artifact(run).byteCount,
    worker.artifact(run).sha256,
  );
  expect(recognizeText).not.toHaveBeenCalled();
  expect(writeTextArtifact).not.toHaveBeenCalled();
  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
});

test('claim heartbeat remains active while completion waits on SQLite', async () => {
  jest.useFakeTimers();
  try {
    const worker = new DeferredWorker();
    const completeStarted = deferred<void>();
    const allowCompletion = deferred<void>();
    const originalComplete = repository.completePipelineRun.bind(repository);
    jest
      .spyOn(repository, 'completePipelineRun')
      .mockImplementation(async input => {
        completeStarted.resolve();
        await allowCompletion.promise;
        return originalComplete(input);
      });
    let clockMs = Date.parse(now);
    const timestamp = () => new Date(clockMs).toISOString();
    const coordinator = new DurablePackProcessingCoordinator(
      async () => repository,
      worker,
      timestamp,
      900,
    );
    await new PackLibraryController(
      async () => repository,
      timestamp,
      coordinator,
    ).retryItem(packId, itemId);
    for (
      let attempt = 0;
      attempt < 20 && worker.starts.length === 0;
      attempt += 1
    )
      await Promise.resolve();
    expect(worker.starts).toHaveLength(1);
    const run = worker.starts[0]!;
    worker.results.get(run.id)!.resolve(worker.artifact(run));
    await completeStarted.promise;

    for (let interval = 0; interval < 4; interval += 1) {
      clockMs += 300;
      await jest.advanceTimersByTimeAsync(300);
    }
    await expect(
      repository.markPipelineRunRunning(
        run.id,
        run.claimVersion,
        timestamp(),
        timestamp(),
        new Date(clockMs + 900).toISOString(),
      ),
    ).resolves.toBeNull();

    allowCompletion.resolve();
    await coordinator.waitForIdle();
    expect((await repository.findPackGraph(packId))?.items[0]).toMatchObject({
      state: 'extracted',
      artifactIds: expect.arrayContaining([run.id]),
    });
  } finally {
    jest.useRealTimers();
  }
});

test('a false completion CAS result is surfaced and leaves the checkpoint recoverable', async () => {
  const worker = new DeferredWorker();
  const onUnexpectedFailure = jest.fn();
  const complete = jest
    .spyOn(repository, 'completePipelineRun')
    .mockResolvedValueOnce(false);
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
    5 * 60 * 1_000,
    onUnexpectedFailure,
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  expect(complete).toHaveBeenCalledTimes(1);
  expect(onUnexpectedFailure).toHaveBeenCalledWith({
    runId: run.id,
    code: 'PERSISTENCE_CONFLICT',
  });
  operationalMilliseconds = 300_000;
  expect(
    await repository.listRunnablePipelineRuns('2026-08-11T00:06:00Z'),
  ).toEqual([
    expect.objectContaining({
      id: run.id,
      publishedArtifact: worker.artifact(run),
    }),
  ]);
});

test('settlement timestamps never move behind the latest persisted heartbeat', async () => {
  const worker = new DeferredWorker();
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  const latestHeartbeat = '2026-08-11T00:10:00Z';
  await expect(
    repository.renewPipelineRunClaim(
      run.id,
      run.claimVersion,
      latestHeartbeat,
      now,
      claimExpiresAt(now),
    ),
  ).resolves.toBe(true);

  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  const graph = (await repository.findPackGraph(packId))!;
  expect(graph.pack.updatedAt).toBe(latestHeartbeat);
  expect(
    database
      .prepare('SELECT updated_at FROM context_items WHERE id = ?')
      .get(itemId),
  ).toEqual({ updated_at: latestHeartbeat });
  const settled = database
    .prepare('SELECT updated_at, completed_at FROM pipeline_runs WHERE id = ?')
    .get(run.id) as { updated_at: string; completed_at: string };
  expect(settled).toEqual({
    updated_at: latestHeartbeat,
    completed_at: latestHeartbeat,
  });
});

test('failure timestamps never move behind the latest persisted heartbeat', async () => {
  const worker = new DeferredWorker();
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  const latestHeartbeat = '2026-08-11T00:10:00Z';
  await repository.renewPipelineRunClaim(
    run.id,
    run.claimVersion,
    latestHeartbeat,
    now,
    claimExpiresAt(now),
  );

  worker.results
    .get(run.id)!
    .reject(new Error('synthetic-stage-failure-after-clock-rollback'));
  await coordinator.waitForIdle();

  const graph = (await repository.findPackGraph(packId))!;
  expect(graph.pack.updatedAt).toBe(latestHeartbeat);
  expect(
    database
      .prepare('SELECT updated_at FROM context_items WHERE id = ?')
      .get(itemId),
  ).toEqual({ updated_at: latestHeartbeat });
  const settled = database
    .prepare('SELECT updated_at, completed_at FROM pipeline_runs WHERE id = ?')
    .get(run.id) as { updated_at: string; completed_at: string };
  expect(settled).toEqual({
    updated_at: latestHeartbeat,
    completed_at: latestHeartbeat,
  });
});

test('failing one run never moves a later-heartbeat sibling or Pack backward', async () => {
  const siblingItemId = 'e93e4567-e89b-42d3-a456-426614174000';
  const siblingIngestionId = 'f93e4567-e89b-42d3-a456-426614174000';
  const laterSiblingItemId = 'a03e4567-e89b-42d3-a456-426614174000';
  const laterSiblingIngestionId = 'b03e4567-e89b-42d3-a456-426614174000';
  await seedSingleItem(packId, siblingItemId, siblingIngestionId, 'image/png');
  await seedSingleItem(
    packId,
    laterSiblingItemId,
    laterSiblingIngestionId,
    'image/png',
  );
  const graph = (await repository.findPackGraph(packId))!;
  const failedItems = graph.items.map(value => ({
    ...value,
    state: 'failed' as const,
    retryStage: 'extract' as const,
  }));
  await repository.savePackGraph({
    pack: {
      ...graph.pack,
      state: 'failed',
      updatedAt: now,
      orderedItemIds: failedItems.map(value => value.id),
    },
    items: failedItems,
    expectedRevision: graph.revision,
  });
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  await new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  ).retryPack(packId);
  const runs = await repository.listRunnablePipelineRuns();
  const failing = runs.find(value => value.itemId === itemId)!;
  const sibling = runs.find(value => value.itemId === siblingItemId)!;
  const laterSibling = runs.find(value => value.itemId === laterSiblingItemId)!;
  const failingClaim = await repository.markPipelineRunRunning(
    failing.id,
    failing.claimVersion,
    now,
    now,
    claimExpiresAt(now),
  );
  const siblingClaim = await repository.markPipelineRunRunning(
    sibling.id,
    sibling.claimVersion,
    now,
    now,
    claimExpiresAt(now),
  );
  const laterSiblingClaim = await repository.markPipelineRunRunning(
    laterSibling.id,
    laterSibling.claimVersion,
    now,
    now,
    claimExpiresAt(now),
  );
  expect(failingClaim).toBe(1);
  expect(siblingClaim).toBe(1);
  expect(laterSiblingClaim).toBe(1);
  const siblingHeartbeat = '2026-08-11T00:10:00Z';
  const latestHeartbeat = '2026-08-11T00:10:00.500Z';
  await expect(
    repository.renewPipelineRunClaim(
      sibling.id,
      siblingClaim!,
      siblingHeartbeat,
      now,
      claimExpiresAt(now),
    ),
  ).resolves.toBe(true);
  await expect(
    repository.renewPipelineRunClaim(
      laterSibling.id,
      laterSiblingClaim!,
      latestHeartbeat,
      now,
      claimExpiresAt(now),
    ),
  ).resolves.toBe(true);

  await expect(
    repository.failPipelineRun({
      runId: failing.id,
      claimVersion: failingClaim!,
      updatedAt: '2026-08-11T00:05:00Z',
      errorCode: 'PIPELINE_STAGE_FAILED',
    }),
  ).resolves.toBe(true);

  expect(
    database
      .prepare(
        'SELECT status, updated_at, completed_at FROM pipeline_runs WHERE id = ?',
      )
      .get(sibling.id),
  ).toEqual({
    status: 'cancelled',
    updated_at: latestHeartbeat,
    completed_at: latestHeartbeat,
  });
  expect(
    database
      .prepare(
        'SELECT status, updated_at, completed_at FROM pipeline_runs WHERE id = ?',
      )
      .get(laterSibling.id),
  ).toEqual({
    status: 'cancelled',
    updated_at: latestHeartbeat,
    completed_at: latestHeartbeat,
  });
  expect((await repository.findPackGraph(packId))?.pack.updatedAt).toBe(
    latestHeartbeat,
  );
});

test('coordinator timestamps never move the Pack before its creation time', async () => {
  const worker = new DeferredWorker();
  const coordinator = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => '2026-08-10T00:00:00Z',
  );
  await new PackLibraryController(
    async () => repository,
    () => now,
    coordinator,
  ).retryItem(packId, itemId);
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await coordinator.waitForIdle();

  const graph = await repository.findPackGraph(packId);
  expect(graph?.pack.updatedAt).toBe(now);
  expect(Date.parse(graph!.pack.updatedAt)).toBeGreaterThanOrEqual(
    Date.parse(graph!.pack.createdAt),
  );
  expect(graph?.items[0]?.state).toBe('extracted');
});

test('claim heartbeats advance logically when the wall clock rolls backward', async () => {
  jest.useFakeTimers();
  try {
    let wallClock = now;
    const worker = new DeferredWorker();
    const coordinator = new DurablePackProcessingCoordinator(
      async () => repository,
      worker,
      () => wallClock,
      900,
      undefined,
      () => operationalMilliseconds,
    );
    await new PackLibraryController(
      async () => repository,
      () => wallClock,
      coordinator,
    ).retryItem(packId, itemId);
    await flushPromises();
    expect(worker.starts).toHaveLength(1);
    const run = worker.starts[0]!;

    wallClock = '2026-08-10T00:00:00Z';
    operationalMilliseconds = 300;
    await jest.advanceTimersByTimeAsync(300);
    const heartbeat = database
      .prepare('SELECT updated_at FROM pipeline_runs WHERE id = ?')
      .get(run.id) as { updated_at: string };
    expect(Date.parse(heartbeat.updated_at)).toBeGreaterThan(Date.parse(now));

    worker.results.get(run.id)!.resolve(worker.artifact(run));
    await flushPromises();
    await coordinator.waitForIdle();
  } finally {
    jest.useRealTimers();
  }
});

test('the production extraction worker reads the owned original and publishes immutable OCR text', async () => {
  const run: PersistedPipelineRun = {
    id: '423e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const resolveOwnedArtifactFileUri = jest
    .fn()
    .mockResolvedValue('file:///owned/synthetic.png');
  const recognizeText = jest.fn().mockResolvedValue({
    schemaVersion: 1,
    text: 'synthetic OCR text',
    blocks: [],
    durationMs: 1,
    engine: 'apple-vision',
    revision: '3',
    recognitionLevel: 'accurate',
    warnings: [],
  });
  const writeTextArtifact = jest.fn().mockResolvedValue({
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    byteCount: 18,
    sha256: 'd'.repeat(64),
    created: true,
  });
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri,
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate', 'fast'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    recognizeText,
    cancelTextRecognition: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact,
  } as unknown as NativeAdapter;
  const worker = new NativeExtractionStageWorker(
    async () => repository,
    native,
  );
  const handle = worker.start(await persistAndClaim(run));

  await expect(handle.result).resolves.toEqual({
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    mediaType: 'text/plain',
    byteCount: 18,
    sha256: 'd'.repeat(64),
    processorVersion: {
      processor: 'native-phase1-extraction',
      version: '3',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  });
  expect(resolveOwnedArtifactFileUri).toHaveBeenCalledWith(
    `Packs/${packId}/originals/${itemId}.bin`,
  );
  expect(recognizeText).toHaveBeenCalledWith({
    taskId: run.id,
    fileUri: 'file:///owned/synthetic.png',
    script: 'latin',
    recognitionLevel: 'accurate',
  });
  expect(writeTextArtifact).toHaveBeenCalledWith(
    ownedDerivedPath(packId, run.id, 'txt'),
    'synthetic OCR text',
  );
  await handle.finalize?.();
});

test('the production extraction worker fails before reading an unverified original', async () => {
  const run: PersistedPipelineRun = {
    id: '433e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const resolveOwnedArtifactFileUri = jest.fn();
  const recognizeText = jest.fn();
  const writeTextArtifact = jest.fn();
  const native = {
    verifyArtifact: jest.fn().mockResolvedValue({
      relativePath: `Packs/${packId}/originals/${itemId}.bin`,
      status: 'mismatch',
      byteCount: 5,
      sha256: 'f'.repeat(64),
    }),
    resolveOwnedArtifactFileUri,
    recognizeText,
    writeTextArtifact,
  } as unknown as NativeAdapter;
  const worker = new NativeExtractionStageWorker(
    async () => repository,
    native,
  );

  await expect(
    worker.start(await persistAndClaim(run)).result,
  ).rejects.toMatchObject({
    code: 'ARTIFACT_INTEGRITY_FAILED',
  });
  expect(resolveOwnedArtifactFileUri).not.toHaveBeenCalled();
  expect(recognizeText).not.toHaveBeenCalled();
  expect(writeTextArtifact).not.toHaveBeenCalled();
});

test('the production worker revalidates the exact claim immediately before publication', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    recover: jest.fn().mockResolvedValue(undefined),
  };
  await new PackLibraryController(
    async () => repository,
    () => now,
    paused,
  ).retryItem(packId, itemId);
  const queued = (await repository.listRunnablePipelineRuns())[0]!;
  const firstClaim = await repository.markPipelineRunRunning(
    queued.id,
    queued.claimVersion,
    now,
    now,
    claimExpiresAt(now),
  );
  const run: PersistedPipelineRun = {
    ...queued,
    status: 'running',
    updatedAt: now,
    claimVersion: firstClaim!,
  };
  const recognition = deferred<{
    schemaVersion: 1;
    text: string;
    blocks: [];
    durationMs: number;
    engine: 'apple-vision';
    revision: string;
    recognitionLevel: 'accurate';
    warnings: [];
  }>();
  const writeTextArtifact = jest.fn();
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.png'),
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    recognizeText: jest.fn().mockReturnValue(recognition.promise),
    cancelTextRecognition: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact,
  } as unknown as NativeAdapter;
  const handle = new NativeExtractionStageWorker(
    async () => repository,
    native,
  ).start(run);
  await waitFor(
    () => (native.recognizeText as jest.Mock).mock.calls.length === 1,
  );

  operationalMilliseconds = 300_000;
  await expect(
    repository.markPipelineRunRunning(
      run.id,
      run.claimVersion,
      '2026-08-11T00:06:00Z',
      '2026-08-11T00:06:00Z',
      '2026-08-11T00:11:00Z',
    ),
  ).resolves.toBe(2);
  recognition.resolve({
    schemaVersion: 1,
    text: 'stale output',
    blocks: [],
    durationMs: 1,
    engine: 'apple-vision',
    revision: '3',
    recognitionLevel: 'accurate',
    warnings: [],
  });

  await expect(handle.result).rejects.toMatchObject({
    code: 'PERSISTENCE_CONFLICT',
  });
  expect(writeTextArtifact).not.toHaveBeenCalled();
});

test('derivative publication holds the global cleanup lease until settlement finalizes', async () => {
  const wallClockNow = '2026-08-10T00:00:00Z';
  const run: PersistedPipelineRun = {
    id: '443e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const otherOwner = '453e4567-e89b-42d3-a456-426614174000';
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.png'),
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    recognizeText: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      text: 'synthetic OCR text',
      blocks: [],
      durationMs: 1,
      engine: 'apple-vision',
      revision: '3',
      recognitionLevel: 'accurate',
      warnings: [],
    }),
    cancelTextRecognition: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact: jest.fn().mockResolvedValue({
      relativePath: ownedDerivedPath(packId, run.id, 'txt'),
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: true,
    }),
  } as unknown as NativeAdapter;
  const worker = new NativeExtractionStageWorker(
    async () => repository,
    native,
    () => wallClockNow,
  );
  const handle = worker.start(await persistAndClaim(run));

  await expect(handle.result).resolves.toBeDefined();
  expect(
    database
      .prepare(
        "SELECT acquired_at, expires_at FROM cleanup_leases WHERE name = 'artifact-cleanup'",
      )
      .get(),
  ).toEqual({
    acquired_at: wallClockNow,
    expires_at: '2026-08-10T00:05:00.000Z',
  });
  await expect(
    repository.acquireCleanupLease(
      otherOwner,
      wallClockNow,
      '2026-08-10T00:01:00Z',
    ),
  ).resolves.toBe(false);
  await handle.finalize?.();
  await expect(
    repository.acquireCleanupLease(
      otherOwner,
      wallClockNow,
      '2026-08-10T00:01:00Z',
    ),
  ).resolves.toBe(true);
  await repository.releaseCleanupLease(otherOwner);
});

test('cancellation keeps the cleanup lease until an in-flight native publication settles', async () => {
  const run: PersistedPipelineRun = {
    id: '453e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const pendingWrite = deferred<{
    relativePath: string;
    byteCount: number;
    sha256: string;
    created: boolean;
  }>();
  const writeTextArtifact = jest.fn().mockReturnValue(pendingWrite.promise);
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.png'),
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    recognizeText: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      text: 'synthetic OCR text',
      blocks: [],
      durationMs: 1,
      engine: 'apple-vision',
      revision: '3',
      recognitionLevel: 'accurate',
      warnings: [],
    }),
    cancelTextRecognition: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact,
  } as unknown as NativeAdapter;
  const handle = new NativeExtractionStageWorker(
    async () => repository,
    native,
  ).start(await persistAndClaim(run));
  await waitFor(() => writeTextArtifact.mock.calls.length === 1);

  await handle.cancel();
  let finalized = false;
  const finalization = handle.finalize?.().then(() => {
    finalized = true;
  });
  await Promise.resolve();
  expect(finalized).toBe(false);
  const otherOwner = '463e4567-e89b-42d3-a456-426614174000';
  await expect(
    repository.acquireCleanupLease(otherOwner, now, '2026-08-11T00:01:00Z'),
  ).resolves.toBe(false);

  pendingWrite.resolve({
    relativePath: ownedDerivedPath(packId, run.id, 'txt'),
    byteCount: 18,
    sha256: 'd'.repeat(64),
    created: true,
  });
  await expect(handle.result).rejects.toMatchObject({
    code: 'PIPELINE_STAGE_FAILED',
  });
  await finalization;
  expect(finalized).toBe(true);
  await expect(
    repository.acquireCleanupLease(otherOwner, now, '2026-08-11T00:01:00Z'),
  ).resolves.toBe(true);
  await repository.releaseCleanupLease(otherOwner);
});

test('publication rechecks its local cleanup fence after awaited claim renewal and before native write', async () => {
  jest.useFakeTimers();
  const performanceNow = jest.spyOn(
    (
      globalThis as unknown as {
        readonly performance: { now(): number };
      }
    ).performance,
    'now',
  );
  try {
    let publicationMonotonicMs = 0;
    performanceNow.mockImplementation(() => publicationMonotonicMs);
    const run: PersistedPipelineRun = {
      id: 'a63e4567-e89b-42d3-a456-426614174000',
      packId,
      itemId,
      stage: 'extract',
      status: 'queued',
      startedAt: now,
      updatedAt: now,
      claimVersion: 0,
    };
    const claimed = await persistAndClaim(run);
    const secondRenewalStarted = deferred<void>();
    const secondRenewal = deferred<boolean>();
    const realRenew = repository.renewPipelineRunClaim.bind(repository);
    let renewalCount = 0;
    jest
      .spyOn(repository, 'renewPipelineRunClaim')
      .mockImplementation(async (...args) => {
        renewalCount += 1;
        if (renewalCount === 2) {
          secondRenewalStarted.resolve();
          return secondRenewal.promise;
        }
        return realRenew(...args);
      });
    const writeTextArtifact = jest.fn().mockResolvedValue({
      relativePath: ownedDerivedPath(packId, run.id, 'txt'),
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: true,
    });
    const handle = new NativeExtractionStageWorker(
      async () => repository,
      imagePublicationNative(writeTextArtifact, jest.fn()),
      () => now,
      10,
    ).start(claimed);

    await secondRenewalStarted.promise;
    publicationMonotonicMs = 10;
    secondRenewal.resolve(true);

    await expect(handle.result).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    expect(writeTextArtifact).not.toHaveBeenCalled();
    await expect(handle.finalize?.()).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
  } finally {
    performanceNow.mockRestore();
    jest.useRealTimers();
  }
});

test('publication renews its cleanup fence across lease expiry until native write joins', async () => {
  jest.useFakeTimers();
  try {
    const run: PersistedPipelineRun = {
      id: 'a93e4567-e89b-42d3-a456-426614174000',
      packId,
      itemId,
      stage: 'extract',
      status: 'queued',
      startedAt: now,
      updatedAt: now,
      claimVersion: 0,
    };
    const pendingWrite = deferred<{
      relativePath: string;
      byteCount: number;
      sha256: string;
      created: boolean;
    }>();
    const writeStarted = deferred<void>();
    const writeTextArtifact = jest.fn().mockImplementation(() => {
      writeStarted.resolve();
      return pendingWrite.promise;
    });
    let clockMs = Date.parse(now);
    const handle = new NativeExtractionStageWorker(
      async () => repository,
      imagePublicationNative(writeTextArtifact, jest.fn()),
      () => new Date(clockMs).toISOString(),
      900,
    ).start(await persistAndClaim(run));
    await writeStarted.promise;

    for (let interval = 0; interval < 4; interval += 1) {
      clockMs += 300;
      await jest.advanceTimersByTimeAsync(300);
    }
    const competingOwner = 'b93e4567-e89b-42d3-a456-426614174000';
    await expect(
      repository.acquireCleanupLease(
        competingOwner,
        new Date(clockMs).toISOString(),
        new Date(clockMs + 100).toISOString(),
      ),
    ).resolves.toBe(false);

    pendingWrite.resolve({
      relativePath: ownedDerivedPath(packId, run.id, 'txt'),
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: true,
    });
    await expect(handle.result).resolves.toBeDefined();
    await handle.finalize?.();
    await expect(
      repository.acquireCleanupLease(
        competingOwner,
        new Date(clockMs).toISOString(),
        new Date(clockMs + 100).toISOString(),
      ),
    ).resolves.toBe(true);
    await repository.releaseCleanupLease(competingOwner);
  } finally {
    jest.useRealTimers();
  }
});

test('publication fails closed after cleanup lease renewal ownership is lost', async () => {
  jest.useFakeTimers();
  try {
    const run: PersistedPipelineRun = {
      id: 'c83e4567-e89b-42d3-a456-426614174000',
      packId,
      itemId,
      stage: 'extract',
      status: 'queued',
      startedAt: now,
      updatedAt: now,
      claimVersion: 0,
    };
    const pendingWrite = deferred<{
      relativePath: string;
      byteCount: number;
      sha256: string;
      created: boolean;
    }>();
    const writeStarted = deferred<void>();
    const writeTextArtifact = jest.fn().mockImplementation(() => {
      writeStarted.resolve();
      return pendingWrite.promise;
    });
    const renew = jest
      .spyOn(repository, 'renewCleanupLease')
      .mockResolvedValueOnce(false);
    let clockMs = Date.parse(now);
    const handle = new NativeExtractionStageWorker(
      async () => repository,
      imagePublicationNative(writeTextArtifact, jest.fn()),
      () => new Date(clockMs).toISOString(),
      900,
    ).start(await persistAndClaim(run));
    await writeStarted.promise;

    clockMs += 300;
    await jest.advanceTimersByTimeAsync(300);
    await expect(handle.fence).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    expect(renew).toHaveBeenCalledTimes(1);

    pendingWrite.resolve({
      relativePath: ownedDerivedPath(packId, run.id, 'txt'),
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: true,
    });
    await expect(handle.result).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    await expect(handle.finalize?.()).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
  } finally {
    jest.useRealTimers();
  }
});

test('a publisher takeover waits for suspended cleanup to fence before native mutation', async () => {
  jest.useFakeTimers();
  try {
    const artifactId = 'd93e4567-e89b-42d3-a456-426614174000';
    const relativePath = ownedDerivedPath(packId, artifactId, 'txt');
    const listingStarted = deferred<void>();
    const listing =
      deferred<
        readonly { readonly relativePath: string; readonly byteCount: number }[]
      >();
    const quarantineOwnedFile = jest.fn();
    const cleanupFiles = {
      listOwnedFiles: jest.fn().mockImplementation(() => {
        listingStarted.resolve();
        return listing.promise;
      }),
      removeOwnedFile: jest.fn(),
      quarantineOwnedFile,
      purgeQuarantine: jest
        .fn()
        .mockResolvedValue({ purgedCount: 0, purgedBytes: 0 }),
    };
    let clockMs = Date.parse(now);
    const cleanup = new ScheduledReferenceAwareCleanup(
      repository,
      cleanupFiles,
      'e93e4567-e89b-42d3-a456-426614174000',
      () => new Date(clockMs).toISOString(),
      1_000,
      7 * 24 * 60 * 60 * 1_000,
      900,
      () => operationalMilliseconds,
    );
    const staleCleanup = cleanup.run();
    await listingStarted.promise;

    // The old timer never runs while suspended. A new publisher legitimately
    // takes the expired SQLite lease, but must still wait on the process-level
    // native lifecycle mutex until cleanup observes its stale TTL and exits.
    clockMs += 901;
    operationalMilliseconds += 901;
    const publishArtifact = jest.fn().mockResolvedValue({
      relativePath,
      byteCount: 4,
      sha256: 'd'.repeat(64),
      created: true,
    });
    const publication = new PublishedArtifactCoordinator(
      repository,
      { publishArtifact } as never,
      () => new Date(clockMs).toISOString(),
      900,
      () => operationalMilliseconds,
    ).publish({
      packId,
      sourceFileUri: 'file:///synthetic-source.txt',
      artifact: {
        id: artifactId,
        itemId,
        kind: 'ocr-text',
        relativePath,
        mediaType: 'text/plain',
        byteCount: 4,
        sha256: 'd'.repeat(64),
        processorVersion: {
          processor: 'fixture-publication',
          version: '1',
          contractVersion: 1,
        },
        createdAt: now,
        immutable: true,
      },
    });
    let acquiredAt: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      acquiredAt = (
        database
          .prepare(
            "SELECT acquired_at FROM cleanup_leases WHERE name = 'artifact-cleanup'",
          )
          .get() as { acquired_at?: string } | undefined
      )?.acquired_at;
      if (acquiredAt === new Date(clockMs).toISOString()) break;
      await Promise.resolve();
    }
    expect(acquiredAt).toBe(new Date(clockMs).toISOString());
    expect(publishArtifact).not.toHaveBeenCalled();

    listing.resolve([{ relativePath, byteCount: 4 }]);
    await expect(staleCleanup).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    await expect(publication).resolves.toBe('created');
    expect(quarantineOwnedFile).not.toHaveBeenCalled();
    expect(publishArtifact).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('an uncheckpointed immutable publication orphan is quarantined and replaced under the current claim', async () => {
  const run: PersistedPipelineRun = {
    id: '463e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const relativePath = ownedDerivedPath(packId, run.id, 'txt');
  const writeTextArtifact = jest
    .fn()
    .mockRejectedValueOnce(new DomainError('STORAGE_ARTIFACT_IMMUTABLE'))
    .mockResolvedValue({
      relativePath,
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: true,
    });
  const quarantineOwnedArtifact = jest.fn().mockResolvedValue({
    quarantined: true,
    quarantineId: '473e4567-e89b-42d3-a456-426614174000',
    anonymousId: '483e4567-e89b-42d3-a456-426614174000',
    byteCount: 17,
  });
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.png'),
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    recognizeText: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      text: 'synthetic OCR text',
      blocks: [],
      durationMs: 1,
      engine: 'apple-vision',
      revision: '3',
      recognitionLevel: 'accurate',
      warnings: [],
    }),
    cancelTextRecognition: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact,
    quarantineOwnedArtifact,
  } as unknown as NativeAdapter;
  const handle = new NativeExtractionStageWorker(
    async () => repository,
    native,
  ).start(await persistAndClaim(run));

  await expect(handle.result).resolves.toMatchObject({
    id: run.id,
    relativePath,
    sha256: 'd'.repeat(64),
  });
  expect(writeTextArtifact).toHaveBeenCalledTimes(2);
  expect(quarantineOwnedArtifact).toHaveBeenCalledWith(relativePath);
  expect(
    database.prepare('SELECT COUNT(*) AS count FROM quarantine_records').get(),
  ).toEqual({ count: 1 });
  await handle.finalize?.();
});

test('an identical created-false orphan is audited, quarantined, and rewritten exactly once', async () => {
  const run: PersistedPipelineRun = {
    id: '493e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const relativePath = ownedDerivedPath(packId, run.id, 'txt');
  const writeTextArtifact = jest
    .fn()
    .mockResolvedValueOnce({
      relativePath,
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: false,
    })
    .mockResolvedValueOnce({
      relativePath,
      byteCount: 18,
      sha256: 'd'.repeat(64),
      created: true,
    });
  const quarantineOwnedArtifact = jest.fn().mockResolvedValue({
    quarantined: true,
    quarantineId: '593e4567-e89b-42d3-a456-426614174000',
    anonymousId: '693e4567-e89b-42d3-a456-426614174000',
    byteCount: 18,
  });
  const handle = new NativeExtractionStageWorker(
    async () => repository,
    imagePublicationNative(writeTextArtifact, quarantineOwnedArtifact),
  ).start(await persistAndClaim(run));

  await expect(handle.result).resolves.toMatchObject({
    id: run.id,
    relativePath,
    sha256: 'd'.repeat(64),
  });
  expect(writeTextArtifact).toHaveBeenCalledTimes(2);
  expect(quarantineOwnedArtifact).toHaveBeenCalledTimes(1);
  expect(
    database.prepare('SELECT COUNT(*) AS count FROM quarantine_records').get(),
  ).toEqual({ count: 1 });
  await handle.finalize?.();
});

test('an immutable conflict never quarantines a path registered after the initial snapshot', async () => {
  const run: PersistedPipelineRun = {
    id: '793e4567-e89b-42d3-a456-426614174000',
    packId,
    itemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const relativePath = ownedDerivedPath(packId, run.id, 'txt');
  const registeredArtifact: Artifact = {
    id: run.id,
    itemId,
    kind: 'ocr-text',
    relativePath,
    mediaType: 'text/plain',
    byteCount: 18,
    sha256: 'd'.repeat(64),
    processorVersion: {
      processor: 'fixture-extraction',
      version: '1',
      contractVersion: 1,
    },
    createdAt: now,
    immutable: true,
  };
  let publicationOwnerId: string | undefined;
  const writeTextArtifact = jest.fn().mockImplementation(async () => {
    if (!publicationOwnerId) throw new DomainError('PERSISTENCE_CONFLICT');
    await repository.registerPublishedArtifact({
      packId,
      artifact: registeredArtifact,
      publicationLeaseOwnerId: publicationOwnerId,
      publicationLeaseObservedAt: now,
    });
    throw new DomainError('STORAGE_ARTIFACT_IMMUTABLE');
  });
  const quarantineOwnedArtifact = jest.fn();
  const handle = new NativeExtractionStageWorker(
    async () => repository,
    imagePublicationNative(writeTextArtifact, quarantineOwnedArtifact),
  ).start(await persistAndClaim(run));
  publicationOwnerId = handle.publicationLeaseOwnerId;

  await expect(handle.result).rejects.toMatchObject({
    code: 'STORAGE_DIVERGENCE_DETECTED',
  });
  expect(quarantineOwnedArtifact).not.toHaveBeenCalled();
  await handle.finalize?.();
});

test('the production extraction worker publishes bounded plain-text input without OCR', async () => {
  const textPackId = '523e4567-e89b-42d3-a456-426614174000';
  const textItemId = '623e4567-e89b-42d3-a456-426614174000';
  await seedSingleItem(
    textPackId,
    textItemId,
    '723e4567-e89b-42d3-a456-426614174000',
    'text/plain',
  );
  const run: PersistedPipelineRun = {
    id: '823e4567-e89b-42d3-a456-426614174000',
    packId: textPackId,
    itemId: textItemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const readPlainTextFile = jest.fn().mockResolvedValue({
    schemaVersion: 1,
    text: 'synthetic text',
    byteCount: 14,
    encoding: 'utf-8',
    revision: '1',
  });
  const writeTextArtifact = jest.fn().mockResolvedValue({
    relativePath: ownedDerivedPath(textPackId, run.id, 'txt'),
    byteCount: 14,
    sha256: 'e'.repeat(64),
    created: true,
  });
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.txt'),
    readPlainTextFile,
    writeTextArtifact,
  } as unknown as NativeAdapter;
  const worker = new NativeExtractionStageWorker(
    async () => repository,
    native,
  );
  const handle = worker.start(await persistAndClaim(run));

  await expect(handle.result).resolves.toMatchObject({
    id: run.id,
    itemId: textItemId,
    kind: 'ocr-text',
    processorVersion: { version: '1' },
  });
  expect(readPlainTextFile).toHaveBeenCalledWith(
    'file:///owned/synthetic.txt',
    undefined,
    4,
    'a'.repeat(64),
  );
  expect(writeTextArtifact).toHaveBeenCalledWith(
    ownedDerivedPath(textPackId, run.id, 'txt'),
    'synthetic text',
  );
  await handle.finalize?.();
});

test('the production extraction worker publishes all completed PDF page text in order', async () => {
  const pdfPackId = '923e4567-e89b-42d3-a456-426614174000';
  const pdfItemId = 'a23e4567-e89b-42d3-a456-426614174000';
  await seedSingleItem(
    pdfPackId,
    pdfItemId,
    'b23e4567-e89b-42d3-a456-426614174000',
    'application/pdf',
  );
  const run: PersistedPipelineRun = {
    id: 'c23e4567-e89b-42d3-a456-426614174000',
    packId: pdfPackId,
    itemId: pdfItemId,
    stage: 'extract',
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    claimVersion: 0,
  };
  const extractPdfPage = jest.fn(({ pageIndex }: { pageIndex: number }) =>
    Promise.resolve({
      schemaVersion: 1,
      pageIndex,
      method: 'embedded-text',
      engine: 'pdfkit',
      revision: 'PDFKit',
      durationMs: 1,
      characterCount: 6,
      warnings: [],
      status: 'complete',
      text: `page-${pageIndex}`,
      blocks: [],
    }),
  );
  const writeTextArtifact = jest.fn().mockResolvedValue({
    relativePath: ownedDerivedPath(pdfPackId, run.id, 'txt'),
    byteCount: 14,
    sha256: 'f'.repeat(64),
    created: true,
  });
  const native = {
    verifyArtifact: verifiedOriginal(),
    resolveOwnedArtifactFileUri: jest
      .fn()
      .mockResolvedValue('file:///owned/synthetic.pdf'),
    getOCRCapabilities: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      engines: [
        {
          engine: 'apple-vision',
          revision: '3',
          scripts: ['latin'],
          recognitionLevels: ['accurate'],
          ready: true,
          offline: true,
        },
      ],
      maximumPixelCount: 40_000_000,
      maximumDimension: 16_384,
    }),
    inspectPdf: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      pageCount: 2,
      byteCount: 4,
      sha256: 'a'.repeat(64),
      engine: 'pdfkit',
      revision: 'PDFKit',
      limit: { pages: 25, bytes: 52_428_800 },
    }),
    extractPdfPage,
    cancelPdfExtraction: jest.fn().mockResolvedValue(undefined),
    finishPdfExtraction: jest.fn().mockResolvedValue(undefined),
    writeTextArtifact,
  } as unknown as NativeAdapter;
  const worker = new NativeExtractionStageWorker(
    async () => repository,
    native,
  );
  const handle = worker.start(await persistAndClaim(run));

  await expect(handle.result).resolves.toMatchObject({
    id: run.id,
    itemId: pdfItemId,
    kind: 'pdf-page-text',
    processorVersion: { version: 'PDFKit' },
  });
  expect(extractPdfPage.mock.calls.map(call => call[0].pageIndex)).toEqual([
    0, 1,
  ]);
  expect(writeTextArtifact).toHaveBeenCalledWith(
    ownedDerivedPath(pdfPackId, run.id, 'txt'),
    'page-0\n\npage-1',
  );
  await handle.finalize?.();
});

test('PDF aggregate text accepts the exact native writer bound and rejects one byte over', () => {
  const exact = 'a'.repeat(DERIVED_TEXT_MAXIMUM_UTF8_BYTES);
  expect(joinBoundedPdfPageText([exact])).toHaveLength(
    DERIVED_TEXT_MAXIMUM_UTF8_BYTES,
  );
  expect(() => joinBoundedPdfPageText([exact, 'b'])).toThrow('PDF_TOO_LARGE');
  expect(() =>
    joinBoundedPdfPageText([
      'a'.repeat(DERIVED_TEXT_MAXIMUM_UTF8_BYTES - 4),
      '界',
    ]),
  ).toThrow('PDF_TOO_LARGE');
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new Error('synthetic-timeout');
}

async function flushPromises(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
}
