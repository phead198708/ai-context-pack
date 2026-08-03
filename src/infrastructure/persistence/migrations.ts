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
] as const;
