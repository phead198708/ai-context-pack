import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const source = readFileSync(
  new URL('../src/infrastructure/persistence/migrations.ts', import.meta.url),
  'utf8',
);
const migrations = [...source.matchAll(/\n\s*`([\s\S]*?)`,/g)].map(
  match => match[1],
);
if (migrations.length !== 3)
  throw new Error('PRODUCTION_PERSISTENCE_MIGRATION_FIXTURE_INVALID');

const temporary = mkdtempSync(join(tmpdir(), 'ai-context-pack-production-'));
const database = join(temporary, 'production.db');
const backup = join(temporary, 'production-backup.db');
const packId = '123e4567-e89b-42d3-a456-426614174000';
const ingestionA = '223e4567-e89b-42d3-a456-426614174000';
const ingestionB = '323e4567-e89b-42d3-a456-426614174000';
const itemA = '423e4567-e89b-42d3-a456-426614174000';
const itemB = '523e4567-e89b-42d3-a456-426614174000';
const artifactA = itemA;
const artifactB = itemB;
const derivedArtifact = '623e4567-e89b-42d3-a456-426614174000';
const exportId = '723e4567-e89b-42d3-a456-426614174000';
const interruptedPack = '823e4567-e89b-42d3-a456-426614174000';

try {
  execute(migrations[0]);
  execute(`
PRAGMA foreign_keys = ON;
INSERT INTO packs (id, created_at) VALUES ('${packId}', '2026-08-05T00:00:00Z');
INSERT INTO imports (
  ingestion_id, pack_id, manifest_fingerprint, manifest_version, source, status, created_at
) VALUES
  ('${ingestionA}', '${packId}', '${'a'.repeat(
    64,
  )}', 1, 'android-share-intent', 'complete', '2026-08-05T00:00:02Z'),
  ('${ingestionB}', '${packId}', '${'b'.repeat(
    64,
  )}', 1, 'ios-share-extension', 'complete', '2026-08-05T00:00:01Z');
INSERT INTO import_items (id, ingestion_id, sort_index, media_type, status) VALUES
  ('${itemA}', '${ingestionA}', 0, 'image/png', 'copied'),
  ('${itemB}', '${ingestionB}', 0, 'Application/PDF', 'copied');
INSERT INTO artifacts (
  id, item_id, relative_path, media_type, byte_count, sha256, created_at
) VALUES
  ('${artifactA}', '${itemA}', 'Packs/${packId}/originals/${itemA}.bin', 'image/png', 3, '${'c'.repeat(
    64,
  )}', '2026-08-05T00:00:02Z'),
  ('${artifactB}', '${itemB}', 'Packs/${packId}/originals/${itemB}.bin', 'Application/PDF', 4, '${'d'.repeat(
    64,
  )}', '2026-08-05T00:00:01Z');
INSERT INTO artifact_references (owner_type, owner_id, artifact_id) VALUES
  ('pack', '${packId}', '${artifactA}'),
  ('pack', '${packId}', '${artifactB}');
`);
  execute(migrations[1]);
  execute(migrations[2]);

  assertQuery('PRAGMA user_version;', '3');
  assertQuery('SELECT COUNT(*) FROM imports;', '2');
  assertQuery('SELECT COUNT(*) FROM artifacts;', '2');
  assertQuery('SELECT COUNT(*) FROM artifact_references;', '2');
  assertQuery(
    'SELECT group_concat(id, ",") FROM (SELECT id FROM context_items ORDER BY sort_index);',
    `${itemB},${itemA}`,
  );
  assertQuery(
    `SELECT source_type FROM context_items WHERE id = '${itemB}';`,
    'pdf',
  );
  assertQuery(
    "SELECT [notnull] FROM pragma_table_info('artifacts') WHERE name = 'item_id';",
    '0',
  );
  assertQuery('PRAGMA foreign_key_check;', '');

  execute(`
PRAGMA foreign_keys = ON;
INSERT INTO artifacts (
  id, item_id, relative_path, media_type, byte_count, sha256, created_at,
  last_verified_at, kind, processor_version_json
) VALUES (
  '${derivedArtifact}', NULL,
  'Packs/${packId}/exports/${derivedArtifact}.zip',
  'application/zip', 5, '${'e'.repeat(64)}', '2026-08-05T00:00:03Z',
  '2026-08-05T00:00:03Z', 'export',
  '{"processor":"fixture-export","version":"1","contractVersion":1}'
);
INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
VALUES ('pack', '${packId}', '${derivedArtifact}');
INSERT INTO export_records (
  id, pack_id, format, created_at, preset, status, manifest_sha256
) VALUES (
  '${exportId}', '${packId}', 'attachment-bundle', '2026-08-05T00:00:03Z',
  'balanced', 'complete', '${'f'.repeat(64)}'
);
INSERT INTO export_record_artifacts (export_id, artifact_id, sort_index)
VALUES ('${exportId}', '${derivedArtifact}', 0);
INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
VALUES ('export', '${exportId}', '${derivedArtifact}');
`);
  assertQuery(
    `SELECT item_id IS NULL FROM artifacts WHERE id = '${derivedArtifact}';`,
    '1',
  );

  await verifyConcurrentOptimisticUpdate();
  assertQuery(`SELECT title FROM packs WHERE id = '${packId}';`, 'winner');
  assertQuery(`SELECT revision FROM packs WHERE id = '${packId}';`, '2');

  executeExpectingFailure(`
.bail on
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
INSERT INTO packs (id, created_at) VALUES ('${interruptedPack}', '2026-08-05T00:00:04Z');
INSERT INTO imports (
  ingestion_id, pack_id, manifest_fingerprint, manifest_version, source, status, created_at
) VALUES (
  '923e4567-e89b-42d3-a456-426614174000',
  'a23e4567-e89b-42d3-a456-426614174000',
  '${'0'.repeat(
    64,
  )}', 1, 'android-share-intent', 'complete', '2026-08-05T00:00:04Z'
);
COMMIT;
`);
  assertQuery(
    `SELECT COUNT(*) FROM packs WHERE id = '${interruptedPack}';`,
    '0',
  );

  assertQuery(
    `SELECT COUNT(*) FROM artifacts
     WHERE relative_path LIKE '/%'
        OR instr(relative_path, '\\') > 0
        OR instr(relative_path, '..') > 0
        OR lower(relative_path) LIKE '%file:%'
        OR lower(relative_path) LIKE '%content:%';`,
    '0',
  );
  assertQuery(
    `SELECT COUNT(*)
     FROM sqlite_schema AS schema
     JOIN pragma_table_info(schema.name) AS column
     WHERE schema.type = 'table' AND schema.name NOT LIKE 'sqlite_%'
       AND upper(trim(column.type)) LIKE '%BLOB%';`,
    '0',
  );
  assertQuery(
    `SELECT COUNT(*) FROM sqlite_schema
     WHERE lower(COALESCE(sql, '')) LIKE '%provider_uri%'
        OR lower(COALESCE(sql, '')) LIKE '%absolute_path%';`,
    '0',
  );
  assertQuery('PRAGMA integrity_check;', 'ok');
  assertQuery('PRAGMA foreign_key_check;', '');

  execute(`VACUUM INTO '${sqlString(backup)}';`);
  assertQueryOn(backup, 'PRAGMA integrity_check;', 'ok');
  assertQueryOn(
    backup,
    'SELECT group_concat(id, ",") FROM (SELECT id FROM context_items ORDER BY sort_index);',
    `${itemB},${itemA}`,
  );

  execute(`
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM artifact_references
 WHERE (owner_type = 'pack' AND owner_id = '${packId}')
    OR (owner_type = 'export' AND owner_id IN
      (SELECT id FROM export_records WHERE pack_id = '${packId}'));
DELETE FROM export_records WHERE pack_id = '${packId}';
DELETE FROM context_items WHERE pack_id = '${packId}';
UPDATE packs SET title = '', user_instruction = '', warning_codes_json = '[]',
  state = 'cancelled', deleted_at = '2026-08-05T00:00:05Z', revision = revision + 1
WHERE id = '${packId}' AND revision = 2 AND deleted_at IS NULL;
COMMIT;
`);
  assertQuery('SELECT COUNT(*) FROM artifact_references;', '0');
  assertQuery('SELECT COUNT(*) FROM artifacts;', '3');
  execute(
    'DELETE FROM artifacts WHERE id NOT IN (SELECT artifact_id FROM artifact_references);',
  );
  assertQuery('SELECT COUNT(*) FROM artifacts;', '0');
  assertQuery('PRAGMA foreign_key_check;', '');

  process.stdout.write(
    `PRODUCTION_PERSISTENCE versions=0->1->2->3 rowsPreserved=2 ` +
      `orderedRestart=pass concurrentCas=1-of-2 rollback=pass ` +
      `backupRestore=pass referenceCleanup=pass databaseBytes=${
        statSync(database).size
      } result=pass\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

async function verifyConcurrentOptimisticUpdate() {
  const first = spawn('sqlite3', [database], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let firstOutput = '';
  let firstError = '';
  first.stdout.setEncoding('utf8');
  first.stderr.setEncoding('utf8');
  first.stdout.on('data', value => {
    firstOutput += value;
  });
  first.stderr.on('data', value => {
    firstError += value;
  });
  first.stdin.write(
    `.bail on\nPRAGMA foreign_keys=ON;\nPRAGMA busy_timeout=5000;\nBEGIN IMMEDIATE;\nSELECT revision FROM packs WHERE id='${packId}';\n`,
  );
  await waitForOutput(() => firstOutput.includes('1\n'));

  const second = spawn('sqlite3', [database], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let secondOutput = '';
  let secondError = '';
  second.stdout.setEncoding('utf8');
  second.stderr.setEncoding('utf8');
  second.stdout.on('data', value => {
    secondOutput += value;
  });
  second.stderr.on('data', value => {
    secondError += value;
  });
  second.stdin.end(
    `.bail on\nPRAGMA foreign_keys=ON;\nPRAGMA busy_timeout=5000;\n` +
      `UPDATE packs SET title='loser', revision=revision+1 WHERE id='${packId}' AND revision=1;\n` +
      `SELECT changes();\n`,
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  first.stdin.end(
    `UPDATE packs SET title='winner', revision=revision+1 WHERE id='${packId}' AND revision=1;\n` +
      `SELECT changes();\nCOMMIT;\n`,
  );
  const [firstStatus, secondStatus] = await Promise.all([
    exitStatus(first),
    exitStatus(second),
  ]);
  if (
    firstStatus !== 0 ||
    secondStatus !== 0 ||
    firstError.trim() !== '' ||
    secondError.trim() !== '' ||
    firstOutput.trim().split(/\s+/).at(-1) !== '1' ||
    secondOutput.trim().split(/\s+/).at(-1) !== '0'
  )
    throw new Error('PRODUCTION_PERSISTENCE_CONCURRENT_CAS_FAILED');
}

function execute(sql) {
  const result = spawnSync('sqlite3', [database], {
    encoding: 'utf8',
    input: sql,
  });
  if (result.status !== 0)
    throw new Error(
      `PRODUCTION_PERSISTENCE_SQL_FAILED:${result.stderr.trim()}`,
    );
}

function executeExpectingFailure(sql) {
  const result = spawnSync('sqlite3', [database], {
    encoding: 'utf8',
    input: sql,
  });
  if (result.status === 0)
    throw new Error('PRODUCTION_PERSISTENCE_EXPECTED_FAILURE_MISSING');
}

function assertQuery(sql, expected) {
  assertQueryOn(database, sql, expected);
}

function assertQueryOn(target, sql, expected) {
  const result = spawnSync('sqlite3', [target, sql], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== expected)
    throw new Error(
      `PRODUCTION_PERSISTENCE_ASSERTION_FAILED:${result.stdout.trim()}:${result.stderr.trim()}`,
    );
}

function sqlString(value) {
  return value.replaceAll("'", "''");
}

function exitStatus(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

async function waitForOutput(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('PRODUCTION_PERSISTENCE_CONCURRENT_SETUP_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
