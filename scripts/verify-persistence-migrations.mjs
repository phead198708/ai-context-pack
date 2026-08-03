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
if (migrations.length !== 2)
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
  process.stdout.write(
    'PERSISTENCE_MIGRATIONS versions=0->1->2 rowsPreserved=1 binaryColumns=0 result=pass\n',
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
  const result = spawnSync('sqlite3', [database, sql], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.stdout.trim() !== expected)
    throw new Error('PERSISTENCE_MIGRATION_ASSERTION_FAILED');
}
