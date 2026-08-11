jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import type { ImportManifestV1 } from '../src/domain/contracts';
import type { Artifact, ContextItem } from '../src/domain/models';
import type { NativeAdapter } from '../src/domain/nativeAdapter';
import { PackLibraryController } from '../src/features/packLibrary/controller';
import {
  DurablePackProcessingCoordinator,
  NativeExtractionStageWorker,
  type PackStageWorker,
  type PackStageWorkHandle,
} from '../src/features/packLibrary/processing';
import type { PersistedPipelineRun } from '../src/infrastructure/persistence/contracts';
import { ownedDerivedPath } from '../src/infrastructure/persistence/ownedPaths';
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

const packId = '123e4567-e89b-42d3-a456-426614174000';
const itemId = '223e4567-e89b-42d3-a456-426614174000';
const ingestionId = '323e4567-e89b-42d3-a456-426614174000';
const now = '2026-08-11T00:00:00Z';

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
    return {
      result: result.promise,
      cancel: async () => {
        this.cancellations.push(run.id);
        if (this.rejectCancellation)
          throw new Error('synthetic-cancel-failure');
      },
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
  database = new DatabaseSync(':memory:');
  repository = new ExpoSqlitePersistenceRepository(
    new NodeSqlConnection(database) as never,
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
  const replacement = new DurablePackProcessingCoordinator(
    async () => repository,
    worker,
    () => now,
  );
  await replacement.recover();
  await waitFor(() => worker.starts.length === 1);
  const run = worker.starts[0]!;
  worker.results.get(run.id)!.resolve(worker.artifact(run));
  await replacement.waitForIdle();

  expect((await repository.findPackGraph(packId))?.items[0]?.state).toBe(
    'extracted',
  );
});

test('the durable claim token permits only one coordinator to execute a queued run', async () => {
  const paused = {
    supports: jest.fn(stage => stage === 'extract'),
    launch: jest.fn(),
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
  const handle = worker.start(run);

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

  await expect(worker.start(run).result).rejects.toMatchObject({
    code: 'ARTIFACT_INTEGRITY_FAILED',
  });
  expect(resolveOwnedArtifactFileUri).not.toHaveBeenCalled();
  expect(recognizeText).not.toHaveBeenCalled();
  expect(writeTextArtifact).not.toHaveBeenCalled();
});

test('derivative publication holds the global cleanup lease until settlement finalizes', async () => {
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
    () => now,
  );
  const handle = worker.start(run);

  await expect(handle.result).resolves.toBeDefined();
  await expect(
    repository.acquireCleanupLease(otherOwner, now, '2026-08-11T00:01:00Z'),
  ).resolves.toBe(false);
  await handle.finalize?.();
  await expect(
    repository.acquireCleanupLease(otherOwner, now, '2026-08-11T00:01:00Z'),
  ).resolves.toBe(true);
  await repository.releaseCleanupLease(otherOwner);
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
  const handle = worker.start(run);

  await expect(handle.result).resolves.toMatchObject({
    id: run.id,
    itemId: textItemId,
    kind: 'ocr-text',
    processorVersion: { version: '1' },
  });
  expect(readPlainTextFile).toHaveBeenCalledWith('file:///owned/synthetic.txt');
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
  const handle = worker.start(run);

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new Error('synthetic-timeout');
}
