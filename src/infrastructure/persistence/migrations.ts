export const PERSISTENCE_MIGRATIONS = [
  `
CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  ingestion_id TEXT PRIMARY KEY NOT NULL,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE RESTRICT,
  manifest_fingerprint TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY NOT NULL,
  ingestion_id TEXT NOT NULL REFERENCES imports(ingestion_id) ON DELETE RESTRICT,
  sort_index INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  UNIQUE (ingestion_id, sort_index)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES import_items(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_references (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  PRIMARY KEY (owner_type, owner_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS recovery_journal (
  ingestion_id TEXT PRIMARY KEY NOT NULL,
  pack_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_code TEXT
);
PRAGMA user_version = 1;
`,
  `
ALTER TABLE artifacts ADD COLUMN last_verified_at TEXT;
CREATE INDEX IF NOT EXISTS artifacts_created_at_index ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS artifact_references_artifact_index ON artifact_references(artifact_id);
PRAGMA user_version = 2;
`,
  `
ALTER TABLE packs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE packs ADD COLUMN title TEXT NOT NULL DEFAULT 'Context Pack';
ALTER TABLE packs ADD COLUMN user_instruction TEXT NOT NULL DEFAULT '';
ALTER TABLE packs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE packs ADD COLUMN state TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE packs ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{"preset":"balanced","maxOutputBytes":10485760,"minimumImageLongestEdge":1280,"imageQuality":0.82,"estimatorVersion":"v1"}';
ALTER TABLE packs ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0);
ALTER TABLE packs ADD COLUMN warning_codes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE packs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE packs ADD COLUMN deleted_at TEXT;
UPDATE packs SET updated_at = created_at WHERE updated_at = '';

-- v1 required every artifact to belong to an imported item. Production export
-- and preview artifacts may instead be Pack-level, so rebuild the table while
-- preserving every v1/v2 row and reference.
ALTER TABLE artifact_references RENAME TO artifact_references_v2;
ALTER TABLE artifacts RENAME TO artifacts_v2;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT REFERENCES import_items(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  kind TEXT NOT NULL,
  processor_version_json TEXT NOT NULL
);

INSERT INTO artifacts (
  id, item_id, relative_path, media_type, byte_count, sha256, created_at,
  last_verified_at, kind, processor_version_json
)
SELECT
  id, item_id, relative_path, media_type, byte_count, sha256, created_at,
  last_verified_at, 'original',
  '{"processor":"inbox-handoff","version":"1","contractVersion":1}'
FROM artifacts_v2;

CREATE TABLE artifact_references (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  PRIMARY KEY (owner_type, owner_id, artifact_id)
);

INSERT INTO artifact_references (owner_type, owner_id, artifact_id)
SELECT owner_type, owner_id, artifact_id FROM artifact_references_v2;

DROP TABLE artifact_references_v2;
DROP TABLE artifacts_v2;
CREATE INDEX artifacts_created_at_index ON artifacts(created_at);
CREATE INDEX artifact_references_artifact_index ON artifact_references(artifact_id);
CREATE UNIQUE INDEX artifacts_one_original_per_item_index
  ON artifacts(item_id) WHERE kind = 'original';

CREATE TABLE context_items (
  id TEXT PRIMARY KEY NOT NULL REFERENCES import_items(id) ON DELETE RESTRICT,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  media_type TEXT NOT NULL,
  original_display_name TEXT,
  original_sha256 TEXT,
  original_relative_path TEXT,
  state TEXT NOT NULL,
  inclusion_mode TEXT NOT NULL,
  sort_index INTEGER NOT NULL CHECK (sort_index >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (pack_id, sort_index)
);

INSERT INTO context_items (
  id, pack_id, source_type, media_type, original_sha256,
  original_relative_path, state, inclusion_mode, sort_index, created_at, updated_at
)
SELECT
  item.id,
  imported.pack_id,
  CASE
    WHEN lower(item.media_type) LIKE 'image/%' THEN 'image'
    WHEN lower(item.media_type) = 'application/pdf' THEN 'pdf'
    WHEN lower(item.media_type) = 'text/uri-list' THEN 'url'
    ELSE 'text'
  END,
  item.media_type,
  (SELECT artifact.sha256 FROM artifacts artifact WHERE artifact.item_id = item.id LIMIT 1),
  (SELECT artifact.relative_path FROM artifacts artifact WHERE artifact.item_id = item.id LIMIT 1),
  CASE WHEN item.status = 'copied' THEN 'imported' ELSE 'failed' END,
  'both',
  ROW_NUMBER() OVER (
    PARTITION BY imported.pack_id
    ORDER BY imported.created_at, item.sort_index, item.id
  ) - 1,
  imported.created_at,
  imported.created_at
FROM import_items item
JOIN imports imported ON imported.ingestion_id = item.ingestion_id;

CREATE TABLE risk_findings (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  detector_version_json TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  location_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE export_records (
  id TEXT PRIMARY KEY NOT NULL,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE RESTRICT,
  format TEXT NOT NULL,
  created_at TEXT NOT NULL,
  preset TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_sha256 TEXT,
  error_code TEXT
);

CREATE TABLE export_record_artifacts (
  export_id TEXT NOT NULL REFERENCES export_records(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  sort_index INTEGER NOT NULL CHECK (sort_index >= 0),
  PRIMARY KEY (export_id, artifact_id),
  UNIQUE (export_id, sort_index)
);

CREATE TABLE recovery_diagnostics (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  code TEXT NOT NULL,
  phase TEXT NOT NULL,
  first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  byte_count INTEGER CHECK (byte_count >= 0)
);

CREATE TABLE quarantine_records (
  id TEXT PRIMARY KEY NOT NULL,
  anonymous_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  created_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  purged_at TEXT
);

CREATE TABLE cleanup_leases (
  name TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX context_items_pack_order_index ON context_items(pack_id, sort_index);
CREATE INDEX risk_findings_item_index ON risk_findings(item_id);
CREATE INDEX export_records_pack_index ON export_records(pack_id, created_at);
CREATE INDEX recovery_diagnostics_last_index ON recovery_diagnostics(last_occurred_at);
CREATE INDEX quarantine_records_retention_index ON quarantine_records(purge_after, purged_at);
PRAGMA user_version = 3;
`,
  `
ALTER TABLE context_items ADD COLUMN retry_stage TEXT;

-- v3 terminal rows did not retain the prior state. Backfill the earliest safe
-- executable stage from immutable evidence; all v4 writes persist the exact stage.
UPDATE context_items
SET retry_stage = CASE
  WHEN EXISTS (
    SELECT 1 FROM import_items imported_item
    WHERE imported_item.id = context_items.id
      AND imported_item.status = 'failed'
  ) THEN 'import'
  WHEN original_relative_path IS NULL THEN 'import'
  WHEN EXISTS (
    SELECT 1 FROM artifacts artifact
    WHERE artifact.item_id = context_items.id
      AND artifact.kind IN ('ocr-text', 'pdf-page-text')
  ) THEN 'analyze'
  ELSE 'extract'
END
WHERE state IN ('recovering', 'failed', 'cancelled');

PRAGMA user_version = 4;
`,
  `
ALTER TABLE import_items ADD COLUMN original_disposition TEXT NOT NULL
  DEFAULT 'retained'
  CHECK (original_disposition IN ('retained', 'released', 'unavailable'));

-- Failed provider items may never have published an owned original. Preserve that
-- distinction separately from explicit user-authorized deletion.
UPDATE import_items
SET original_disposition = 'unavailable'
WHERE status = 'failed'
  AND NOT EXISTS (
    SELECT 1 FROM artifacts artifact
    WHERE artifact.item_id = import_items.id AND artifact.kind = 'original'
  );

-- v4 represented an explicit destructive release by removing the item from the
-- Pack/library graph. A copied row proves that bytes once existed; for a failed
-- row, an unreferenced original provides the same proof before physical cleanup.
-- Preserve provider-less failed rows already classified unavailable instead of
-- inventing destructive intent once both the graph row and bytes are absent.
UPDATE import_items
SET original_disposition = 'released'
WHERE original_disposition <> 'unavailable'
  AND NOT EXISTS (
    SELECT 1 FROM context_items context_item
    WHERE context_item.id = import_items.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM artifacts artifact
    JOIN artifact_references reference ON reference.artifact_id = artifact.id
    WHERE artifact.item_id = import_items.id
      AND artifact.kind = 'original'
  );

CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY NOT NULL,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL REFERENCES import_items(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('import', 'extract', 'analyze', 'review', 'package')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'recovering', 'succeeded', 'failed', 'cancelled')
  ),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claim_version INTEGER NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
  completed_at TEXT,
  error_code TEXT,
  CHECK (
    (status IN ('queued', 'running', 'recovering') AND completed_at IS NULL AND error_code IS NULL)
    OR (status IN ('succeeded', 'cancelled') AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
  )
);
CREATE INDEX pipeline_runs_runnable_index
  ON pipeline_runs(status, updated_at, id);
CREATE INDEX pipeline_runs_item_index
  ON pipeline_runs(pack_id, item_id, updated_at);
CREATE UNIQUE INDEX pipeline_runs_one_active_item
  ON pipeline_runs(pack_id, item_id)
  WHERE status IN ('queued', 'running', 'recovering');

PRAGMA user_version = 5;
`,
  `
ALTER TABLE pipeline_runs ADD COLUMN published_artifact_json TEXT;
PRAGMA user_version = 6;
`,
  `
ALTER TABLE pipeline_runs ADD COLUMN claim_session_id TEXT;
ALTER TABLE pipeline_runs ADD COLUMN claim_deadline_ms REAL;
ALTER TABLE cleanup_leases ADD COLUMN session_id TEXT;
ALTER TABLE cleanup_leases ADD COLUMN deadline_ms REAL;
DROP INDEX pipeline_runs_runnable_index;
CREATE INDEX pipeline_runs_runnable_index
  ON pipeline_runs(status, claim_session_id, claim_deadline_ms, updated_at, id);
PRAGMA user_version = 7;
`,
] as const;
