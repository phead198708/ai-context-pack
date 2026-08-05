import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = join(repositoryRoot, 'fixtures');
const inventoryPath = join(fixturesRoot, 'provenance.json');
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));

if (inventory.schemaVersion !== 1 || inventory.syntheticOnly !== true) {
  throw new Error('FIXTURE_POLICY_INVALID');
}
if (!Array.isArray(inventory.files))
  throw new Error('FIXTURE_INVENTORY_INVALID');

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `FIXTURE_TYPE_INVALID:${relative(fixturesRoot, absolute)}`,
      );
    }
    return [relative(fixturesRoot, absolute).split(sep).join('/')];
  });
}

const excluded = new Set(['README.md', 'provenance.json']);
const actualPaths = walk(fixturesRoot)
  .filter(path => !excluded.has(path))
  .sort();
const entries = inventory.files;
const inventoryPaths = entries.map(entry => entry.path).sort();
if (new Set(inventoryPaths).size !== inventoryPaths.length) {
  throw new Error('FIXTURE_INVENTORY_DUPLICATE');
}
if (JSON.stringify(actualPaths) !== JSON.stringify(inventoryPaths)) {
  throw new Error('FIXTURE_INVENTORY_DRIFT');
}

for (const entry of entries) {
  if (
    typeof entry.path !== 'string' ||
    entry.path.startsWith('/') ||
    entry.path.split('/').includes('..') ||
    typeof entry.purpose !== 'string' ||
    entry.purpose.length === 0 ||
    typeof entry.source !== 'string' ||
    entry.source.length === 0 ||
    entry.license !== 'MIT' ||
    !/^[0-9a-f]{64}$/.test(entry.sha256)
  ) {
    throw new Error(`FIXTURE_PROVENANCE_INVALID:${String(entry.path)}`);
  }
  const absolute = join(fixturesRoot, entry.path);
  if (!lstatSync(absolute).isFile())
    throw new Error(`FIXTURE_NOT_FILE:${entry.path}`);
  const actualHash = createHash('sha256')
    .update(readFileSync(absolute))
    .digest('hex');
  if (actualHash !== entry.sha256)
    throw new Error(`FIXTURE_HASH_MISMATCH:${entry.path}`);
}

const truncated = readFileSync(
  join(fixturesRoot, 'malformed/truncated.json.invalid'),
  'utf8',
);
try {
  JSON.parse(truncated);
  throw new Error('MALFORMED_FIXTURE_UNEXPECTEDLY_VALID');
} catch (error) {
  if (error instanceof SyntaxError) {
    // Expected: this fixture proves parser rejection without entering normal logs.
  } else {
    throw error;
  }
}

console.info(
  `FIXTURE_POLICY files=${entries.length} synthetic=true result=pass`,
);
