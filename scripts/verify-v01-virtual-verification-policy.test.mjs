import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_MANIFEST_SHA256,
  EXPECTED_SCHEMA_SHA256,
  POLICY_FILE_LIMIT_BYTES,
  STDIN_LIMIT_BYTES,
  PolicyError,
  canonicalManifestPath,
  canonicalSchemaPath,
  formatPolicyError,
  loadPolicyFiles,
  parseInventoryText,
  validateManifest,
  verifyInventory,
} from './verify-v01-virtual-verification-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      'fixtures/governance/v01-verification-policy-cases.json',
    ),
    'utf8',
  ),
);
const canonical = loadPolicyFiles();

function clone(value) {
  return structuredClone(value);
}

function makeInventory() {
  return fixture.requiredIssueNumbers.map(number => ({
    number,
    repository_url: `https://api.github.com/repos/${canonical.manifest.githubInventory.repository}`,
    title: `${fixture.titlePrefix} ${number}`,
    body: fixture.defaultBody,
    labels: [{ name: 'type:task' }, 'platform:shared'],
  }));
}

function expectRule(action, rule, context = {}) {
  assert.throws(action, error => {
    assert.ok(error instanceof PolicyError);
    assert.equal(error.rule, rule);
    for (const [key, value] of Object.entries(context)) {
      assert.equal(error.context[key], value);
    }
    return true;
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('canonical manifest and schema pass pinned integrity and schema checks', () => {
  assert.equal(canonical.manifest.schemaVersion, 1);
  assert.equal(canonical.manifest.verificationEnvironment, 'virtual-only');
  assert.equal(canonical.manifest.physicalDeviceEvidenceRequired, false);
  assert.equal(
    digest(readFileSync(canonicalManifestPath)),
    EXPECTED_MANIFEST_SHA256,
  );
  assert.equal(
    digest(readFileSync(canonicalSchemaPath)),
    EXPECTED_SCHEMA_SHA256,
  );
});

test('manifest requires a known schema version', () => {
  const missing = clone(canonical.manifest);
  delete missing.schemaVersion;
  expectRule(
    () => validateManifest(canonical.schema, missing),
    'POLICY_SCHEMA_VERSION_MISSING',
    { field: 'schemaVersion' },
  );

  const unknown = clone(canonical.manifest);
  unknown.schemaVersion = 2;
  expectRule(
    () => validateManifest(canonical.schema, unknown),
    'POLICY_SCHEMA_VERSION_UNSUPPORTED',
    { field: 'schemaVersion' },
  );
});

test('manifest rejects non-virtual or physical-evidence policies', () => {
  const environment = clone(canonical.manifest);
  environment.verificationEnvironment = 'physical';
  expectRule(
    () => validateManifest(canonical.schema, environment),
    'POLICY_MANIFEST_INVALID',
    { field: 'verificationEnvironment' },
  );

  const physical = clone(canonical.manifest);
  physical.physicalDeviceEvidenceRequired = true;
  expectRule(
    () => validateManifest(canonical.schema, physical),
    'POLICY_MANIFEST_INVALID',
    { field: 'physicalDeviceEvidenceRequired' },
  );
});

test('manifest rejects type errors and unknown critical fields', () => {
  const wrongType = clone(canonical.manifest);
  wrongType.githubInventory.requireValidLabels = 'true';
  expectRule(
    () => validateManifest(canonical.schema, wrongType),
    'POLICY_MANIFEST_INVALID',
    { field: 'githubInventory.requireValidLabels' },
  );

  const unknownField = clone(canonical.manifest);
  unknownField.unreviewedPolicy = true;
  expectRule(
    () => validateManifest(canonical.schema, unknownField),
    'POLICY_MANIFEST_INVALID',
    { field: 'manifest' },
  );
});

test('exact 23-record inventory passes independent of record order', () => {
  const records = makeInventory();
  assert.deepEqual(verifyInventory(canonical.manifest, records), {
    records: 23,
    physicalGateLabels: 0,
  });
  assert.deepEqual(
    verifyInventory(canonical.manifest, records.toReversed()),
    verifyInventory(canonical.manifest, records),
  );
  const labelsReordered = clone(records);
  labelsReordered[0].labels.reverse();
  assert.deepEqual(
    verifyInventory(canonical.manifest, labelsReordered),
    verifyInventory(canonical.manifest, records),
  );
});

test('transport records outside the canonical range do not enter inventory', () => {
  const records = makeInventory();
  records.push({
    number: 37,
    title: 'Out-of-range issue',
    body: 'Transport envelope only.',
    labels: [],
  });
  records.push({
    number: 38,
    title: 'Out-of-range pull request',
    body: 'Transport envelope only.',
    labels: [],
    pull_request: {},
  });
  assert.equal(verifyInventory(canonical.manifest, records).records, 23);
});

test('inventory records must identify the canonical repository', () => {
  const correct = makeInventory();
  assert.equal(verifyInventory(canonical.manifest, correct).records, 23);

  const missing = makeInventory();
  delete missing[0].repository_url;
  expectRule(
    () => verifyInventory(canonical.manifest, missing),
    'INVENTORY_REPOSITORY_MISMATCH',
    { issue: 2 },
  );

  const wrong = makeInventory();
  const wrongRepository = 'https://api.github.com/repos/synthetic/other';
  wrong[0].repository_url = wrongRepository;
  expectRule(
    () => verifyInventory(canonical.manifest, wrong),
    'INVENTORY_REPOSITORY_MISMATCH',
    { issue: 2 },
  );

  let diagnostic;
  try {
    verifyInventory(canonical.manifest, wrong);
  } catch (error) {
    diagnostic = formatPolicyError(error);
  }
  assert.equal(
    diagnostic,
    'V01_POLICY_ERROR rule=INVENTORY_REPOSITORY_MISMATCH issue=2',
  );
  assert.doesNotMatch(diagnostic, new RegExp(wrongRepository));
});

test('inventory rejects missing Epic and required Issues', () => {
  for (const number of [2, 3, 24]) {
    expectRule(
      () =>
        verifyInventory(
          canonical.manifest,
          makeInventory().filter(record => record.number !== number),
        ),
      'INVENTORY_RECORD_MISSING',
      { issue: number },
    );
  }
});

test('inventory rejects duplicates and in-range pull requests', () => {
  const duplicate = makeInventory();
  duplicate.push(clone(duplicate[0]));
  expectRule(
    () => verifyInventory(canonical.manifest, duplicate),
    'INVENTORY_RECORD_DUPLICATE',
    { issue: 2 },
  );

  const pullRequest = makeInventory();
  pullRequest[1].pull_request = {};
  expectRule(
    () => verifyInventory(canonical.manifest, pullRequest),
    'INVENTORY_PULL_REQUEST_FORBIDDEN',
    { issue: 3 },
  );
});

test('inventory rejects malformed transport records', () => {
  for (const record of [null, [], {}, { number: '2' }]) {
    expectRule(
      () => verifyInventory(canonical.manifest, [...makeInventory(), record]),
      'INVENTORY_RECORD_INVALID',
    );
  }
});

test('inventory rejects missing, empty, and type-invalid titles', () => {
  for (const value of [undefined, '', '   ', 37]) {
    const records = makeInventory();
    if (value === undefined) delete records[0].title;
    else records[0].title = value;
    expectRule(
      () => verifyInventory(canonical.manifest, records),
      'INVENTORY_FIELD_INVALID',
      { issue: 2, field: 'title' },
    );
  }
});

test('inventory rejects missing, empty, and type-invalid bodies', () => {
  for (const value of [undefined, '', '   ', false]) {
    const records = makeInventory();
    if (value === undefined) delete records[0].body;
    else records[0].body = value;
    expectRule(
      () => verifyInventory(canonical.manifest, records),
      'INVENTORY_FIELD_INVALID',
      { issue: 2, field: 'body' },
    );
  }
});

test('inventory rejects missing or malformed labels', () => {
  for (const value of [undefined, 'type:task', [null], [{}], [{ name: '' }]]) {
    const records = makeInventory();
    if (value === undefined) delete records[0].labels;
    else records[0].labels = value;
    expectRule(
      () => verifyInventory(canonical.manifest, records),
      'INVENTORY_FIELD_INVALID',
      { issue: 2, field: 'labels' },
    );
  }
});

test('forbidden label fails regardless of casing, order, or representation', () => {
  for (const labels of [
    ['test:device-required', 'type:task'],
    [{ name: 'type:task' }, { name: 'test:device-required' }],
    ['type:task', 'Test:Device-Required'],
    [{ name: 'TEST:DEVICE-REQUIRED' }, { name: 'type:task' }],
  ]) {
    const records = makeInventory();
    records[22].labels = labels;
    expectRule(
      () => verifyInventory(canonical.manifest, records),
      'INVENTORY_FORBIDDEN_LABEL',
      { issue: 24, field: 'labels' },
    );
  }

  const manifest = clone(canonical.manifest);
  manifest.githubInventory.forbiddenLabels = ['TEST:DEVICE-REQUIRED'];
  const records = makeInventory();
  records[0].labels = ['Test:Device-Required'];
  expectRule(
    () => verifyInventory(manifest, records),
    'INVENTORY_FORBIDDEN_LABEL',
    { issue: 2, field: 'labels' },
  );
});

test('free-form prose does not influence structured policy', () => {
  for (const prose of fixture.proseInvariance) {
    const records = makeInventory();
    records[0].title = prose;
    records[0].body = prose;
    assert.equal(verifyInventory(canonical.manifest, records).records, 23);
  }
});

test('malformed and oversized stdin fail closed', () => {
  expectRule(() => parseInventoryText('{'), 'STDIN_JSON_INVALID');
  expectRule(
    () => parseInventoryText('x'.repeat(STDIN_LIMIT_BYTES + 1)),
    'STDIN_TOO_LARGE',
  );
});

test('diagnostics contain only stable structural context', () => {
  const records = makeInventory();
  const secret = 'SYNTHETIC_SHOULD_NOT_APPEAR';
  records[0].title = secret;
  records[0].body = secret;
  records[0].labels = [{ name: 'test:device-required' }];

  let captured;
  try {
    verifyInventory(canonical.manifest, records);
  } catch (error) {
    captured = formatPolicyError(error);
  }
  assert.equal(
    captured,
    'V01_POLICY_ERROR rule=INVENTORY_FORBIDDEN_LABEL issue=2 field=labels',
  );
  assert.doesNotMatch(captured, new RegExp(secret));
});

test('same failures produce identical diagnostics', () => {
  const format = () =>
    formatPolicyError(
      new PolicyError('INVENTORY_FIELD_INVALID', {
        issue: 2,
        field: 'title',
      }),
    );
  assert.equal(format(), format());
});

test('missing, corrupt, and oversized policy files fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aicp-policy-'));
  const manifestPath = join(directory, 'manifest.json');
  const schemaPath = join(directory, 'schema.json');
  const manifestBytes = readFileSync(canonicalManifestPath);
  const schemaBytes = readFileSync(canonicalSchemaPath);
  writeFileSync(schemaPath, schemaBytes);

  try {
    expectRule(
      () => loadPolicyFiles({ manifestPath, schemaPath }),
      'POLICY_FILE_MISSING',
      { field: 'manifest' },
    );

    writeFileSync(manifestPath, '{}');
    expectRule(
      () => loadPolicyFiles({ manifestPath, schemaPath }),
      'POLICY_FILE_HASH_MISMATCH',
      { field: 'manifest' },
    );

    const invalidJson = Buffer.from('{');
    writeFileSync(manifestPath, invalidJson);
    expectRule(
      () =>
        loadPolicyFiles({
          manifestPath,
          schemaPath,
          expectedManifestHash: digest(invalidJson),
        }),
      'POLICY_JSON_INVALID',
      { field: 'manifest' },
    );

    const oversized = Buffer.alloc(POLICY_FILE_LIMIT_BYTES + 1, 0x20);
    writeFileSync(manifestPath, oversized);
    expectRule(
      () =>
        loadPolicyFiles({
          manifestPath,
          schemaPath,
          expectedManifestHash: digest(oversized),
        }),
      'POLICY_FILE_TOO_LARGE',
      { field: 'manifest' },
    );

    writeFileSync(manifestPath, manifestBytes);
    rmSync(schemaPath);
    expectRule(
      () => loadPolicyFiles({ manifestPath, schemaPath }),
      'POLICY_FILE_MISSING',
      { field: 'schema' },
    );

    writeFileSync(schemaPath, '{}');
    expectRule(
      () => loadPolicyFiles({ manifestPath, schemaPath }),
      'POLICY_FILE_HASH_MISMATCH',
      { field: 'schema' },
    );

    writeFileSync(schemaPath, invalidJson);
    expectRule(
      () =>
        loadPolicyFiles({
          manifestPath,
          schemaPath,
          expectedSchemaHash: digest(invalidJson),
        }),
      'POLICY_JSON_INVALID',
      { field: 'schema' },
    );

    const invalidSchema = Buffer.from('{"type":7}');
    writeFileSync(schemaPath, invalidSchema);
    expectRule(
      () =>
        loadPolicyFiles({
          manifestPath,
          schemaPath,
          expectedSchemaHash: digest(invalidSchema),
        }),
      'POLICY_SCHEMA_INVALID',
      { field: 'schema' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verifier source has no network or subprocess implementation', () => {
  const source = readFileSync(
    join(repositoryRoot, 'scripts/verify-v01-virtual-verification-policy.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /node:(?:http|https|net|tls|dns|child_process)|\bfetch\s*\(|\bexec(?:File|Sync)?\s*\(|\bspawn\s*\(/,
  );
});
