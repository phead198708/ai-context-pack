import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(
  new URL('../src/infrastructure/persistence/migrations.ts', import.meta.url),
  'utf8',
);
const migrations = [...source.matchAll(/\n\s*`([\s\S]*?)`,/g)].map(
  match => match[1],
);
if (migrations.length !== 8)
  throw new Error('PERSISTENCE_MIGRATION_FIXTURE_INVALID');

const temporary = mkdtempSync(join(tmpdir(), 'ai-context-pack-migrations-'));
const database = join(temporary, 'spike.db');
try {
  execute(migrations[0]);
  execute(`
PRAGMA foreign_keys = ON;
INSERT INTO packs (id, created_at) VALUES ('223e4567-e89b-42d3-a456-426614174000', '2026-08-03T00:00:00Z');
INSERT INTO imports (
  ingestion_id, pack_id, manifest_fingerprint, manifest_version, source, status, created_at
) VALUES (
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
  '${'a'.repeat(
    64,
  )}', 1, 'android-share-intent', 'complete', '2026-08-03T00:00:00Z'
);
INSERT INTO import_items (
  id, ingestion_id, sort_index, media_type, status
) VALUES (
  '323e4567-e89b-42d3-a456-426614174000',
  '123e4567-e89b-42d3-a456-426614174000', 0, 'image/png', 'copied'
);
INSERT INTO artifacts (
  id, item_id, relative_path, media_type, byte_count, sha256, created_at
) VALUES (
  '423e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'Packs/223e4567-e89b-42d3-a456-426614174000/originals/323e4567-e89b-42d3-a456-426614174000.bin',
  'image/png', 3, '${'b'.repeat(64)}', '2026-08-03T00:00:00Z'
);
`);
  assertQuery('PRAGMA user_version;', '1');
  assertQuery('SELECT COUNT(*) FROM imports;', '1');

  execute(migrations[1]);
  assertQuery('PRAGMA user_version;', '2');
  assertQuery('SELECT COUNT(*) FROM imports;', '1');
  assertQuery(
    "SELECT COUNT(*) FROM pragma_table_info('artifacts') WHERE name = 'last_verified_at';",
    '1',
  );
  assertQuery(
    "SELECT type FROM pragma_table_info('artifacts') WHERE name = 'relative_path';",
    'TEXT',
  );
  execute(migrations[2]);
  assertQuery('PRAGMA user_version;', '3');
  assertQuery('SELECT COUNT(*) FROM imports;', '1');
  assertQuery('SELECT COUNT(*) FROM context_items;', '1');
  assertQuery(
    'SELECT pack_id || ":" || sort_index FROM context_items;',
    '223e4567-e89b-42d3-a456-426614174000:0',
  );
  assertQuery(
    "SELECT COUNT(*) FROM pragma_table_info('packs') WHERE name = 'revision';",
    '1',
  );
  assertQuery(
    "SELECT [notnull] FROM pragma_table_info('artifacts') WHERE name = 'item_id';",
    '0',
  );
  assertQuery(
    'SELECT processor_version_json FROM artifacts LIMIT 1;',
    '{"processor":"inbox-handoff","version":"1","contractVersion":1}',
  );
  assertQuery(
    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('risk_findings', 'export_records', 'recovery_diagnostics', 'cleanup_leases');",
    '4',
  );
  execute(`
UPDATE context_items SET state = 'failed';
INSERT INTO artifacts (
  id, item_id, relative_path, media_type, byte_count, sha256, created_at,
  kind, processor_version_json
) VALUES (
  '523e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'Packs/223e4567-e89b-42d3-a456-426614174000/derived/523e4567-e89b-42d3-a456-426614174000.txt',
  'text/plain', 3, '${'c'.repeat(64)}', '2026-08-03T00:00:01Z',
  'ocr-text', '{"processor":"fixture","version":"1","contractVersion":1}'
);
`);
  execute(migrations[3]);
  assertQuery('PRAGMA user_version;', '4');
  assertQuery(
    "SELECT COUNT(*) FROM pragma_table_info('context_items') WHERE name = 'retry_stage';",
    '1',
  );
  assertQuery('SELECT retry_stage FROM context_items;', 'analyze');
  execute(migrations[4]);
  assertQuery('PRAGMA user_version;', '5');
  assertQuery(
    "SELECT original_disposition FROM import_items WHERE id = '323e4567-e89b-42d3-a456-426614174000';",
    'retained',
  );
  assertQuery(
    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'pipeline_runs';",
    '1',
  );
  execute(`
INSERT INTO pipeline_runs (
  id, pack_id, item_id, stage, status, started_at, updated_at,
  claim_version, completed_at, error_code
) VALUES (
  '623e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  'extract', 'failed', '2026-08-03T00:00:02Z', '2026-08-03T00:00:03Z',
  1, '2026-08-03T00:00:03Z', 'PIPELINE_STAGE_FAILED'
);
`);
  execute(migrations[5]);
  assertQuery('PRAGMA user_version;', '6');
  assertQuery(
    "SELECT COUNT(*) FROM pragma_table_info('pipeline_runs') WHERE name = 'published_artifact_json';",
    '1',
  );
  assertQuery(
    "SELECT status || ':' || claim_version || ':' || (published_artifact_json IS NULL) FROM pipeline_runs WHERE id = '623e4567-e89b-42d3-a456-426614174000';",
    'failed:1:1',
  );
  execute(migrations[6]);
  assertQuery('PRAGMA user_version;', '7');
  assertQuery(
    "SELECT COUNT(*) FROM pragma_table_info('pipeline_runs') WHERE name IN ('claim_session_id', 'claim_deadline_ms');",
    '2',
  );
  assertQuery(
    "SELECT status || ':' || claim_version || ':' || (claim_session_id IS NULL) || ':' || (claim_deadline_ms IS NULL) FROM pipeline_runs WHERE id = '623e4567-e89b-42d3-a456-426614174000';",
    'failed:1:1:1',
  );
  execute(migrations[7]);
  assertQuery('PRAGMA user_version;', '8');
  assertQuery(
    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('duplicate_analysis_manifests', 'duplicate_analysis_items', 'duplicate_suggestions', 'duplicate_decisions');",
    '4',
  );
  const binaryColumns = query(
    `SELECT COUNT(*)
     FROM sqlite_schema AS schema
     JOIN pragma_table_info(schema.name) AS column
     WHERE schema.type = 'table'
       AND schema.name NOT LIKE 'sqlite_%'
       AND upper(trim(column.type)) LIKE '%BLOB%';`,
  );
  if (!/^\d+$/.test(binaryColumns) || Number(binaryColumns) !== 0)
    throw new Error('PERSISTENCE_BINARY_COLUMN_ASSERTION_FAILED');
  assertQuery('PRAGMA foreign_key_check;', '');
  process.stdout.write(
    `PERSISTENCE_MIGRATIONS versions=0->1->2->3->4->5->6->7->8 rowsPreserved=1 materializedItems=1 pipelineRunsPreserved=1 binaryColumns=${binaryColumns} result=pass\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function execute(sql) {
  const result = spawnSync('sqlite3', [database], {
    encoding: 'utf8',
    input: sql,
  });
  if (result.status !== 0)
    throw new Error(`PERSISTENCE_MIGRATION_FAILED:${result.stderr.trim()}`);
}

function assertQuery(sql, expected) {
  if (query(sql) !== expected)
    throw new Error('PERSISTENCE_MIGRATION_ASSERTION_FAILED');
}

function query(sql) {
  const result = spawnSync('sqlite3', [database, sql], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error('PERSISTENCE_MIGRATION_ASSERTION_FAILED');
  return result.stdout.trim();
}
