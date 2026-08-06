import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const POLICY_FILE_LIMIT_BYTES = 64 * 1024;
export const STDIN_LIMIT_BYTES = 1024 * 1024;
export const EXPECTED_MANIFEST_SHA256 =
  '0a9c5d551c5bde33e4925df43307433734405fe3dca2498715630ea1a00b97b3';
export const EXPECTED_SCHEMA_SHA256 =
  'e91d52103954bf1cde270bc56614a58cff92d07b202e7edcfc3de3ade75e8494';

export const canonicalManifestPath = join(
  repositoryRoot,
  'governance/v01-verification-policy.json',
);
export const canonicalSchemaPath = join(
  repositoryRoot,
  'schemas/governance/v1/v01-verification-policy-v1.schema.json',
);

export class PolicyError extends Error {
  constructor(rule, context = {}) {
    super(rule);
    this.name = 'PolicyError';
    this.rule = rule;
    this.context = context;
  }
}

function fail(rule, context = {}) {
  throw new PolicyError(rule, context);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPolicyFile(
  path,
  kind,
  expectedHash,
  limit = POLICY_FILE_LIMIT_BYTES,
) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(
      error?.code === 'ENOENT'
        ? 'POLICY_FILE_MISSING'
        : 'POLICY_FILE_OPEN_FAILED',
      {
        field: kind,
      },
    );
  }

  let bytes;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail('POLICY_FILE_TYPE_INVALID', { field: kind });
    if (stat.size > limit) fail('POLICY_FILE_TOO_LARGE', { field: kind });

    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) fail('POLICY_FILE_READ_FAILED', { field: kind });
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
      fail('POLICY_FILE_TOO_LARGE', { field: kind });
    }
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    fail('POLICY_FILE_READ_FAILED', { field: kind });
  } finally {
    closeSync(descriptor);
  }

  if (sha256(bytes) !== expectedHash) {
    fail('POLICY_FILE_HASH_MISMATCH', { field: kind });
  }

  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('POLICY_JSON_INVALID', { field: kind });
  }
}

function safeSchemaField(validationError) {
  const path = validationError?.instancePath;
  if (typeof path !== 'string' || path.length === 0) return 'manifest';
  const parts = path
    .split('/')
    .slice(1)
    .filter(part => /^[A-Za-z][A-Za-z0-9]*$/.test(part));
  return parts.length > 0 ? parts.join('.') : 'manifest';
}

export function validateManifest(schema, manifest) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  ) {
    fail('POLICY_MANIFEST_INVALID', { field: 'manifest' });
  }
  if (!Object.hasOwn(manifest, 'schemaVersion')) {
    fail('POLICY_SCHEMA_VERSION_MISSING', { field: 'schemaVersion' });
  }
  if (manifest.schemaVersion !== 1) {
    fail('POLICY_SCHEMA_VERSION_UNSUPPORTED', { field: 'schemaVersion' });
  }

  let validate;
  try {
    validate = new Ajv2020({ allErrors: false, strict: true }).compile(schema);
  } catch {
    fail('POLICY_SCHEMA_INVALID', { field: 'schema' });
  }
  if (!validate(manifest)) {
    fail('POLICY_MANIFEST_INVALID', {
      field: safeSchemaField(validate.errors?.[0]),
    });
  }
  return manifest;
}

export function loadPolicyFiles({
  manifestPath = canonicalManifestPath,
  schemaPath = canonicalSchemaPath,
  expectedManifestHash = EXPECTED_MANIFEST_SHA256,
  expectedSchemaHash = EXPECTED_SCHEMA_SHA256,
  fileLimit = POLICY_FILE_LIMIT_BYTES,
} = {}) {
  const manifest = readPolicyFile(
    manifestPath,
    'manifest',
    expectedManifestHash,
    fileLimit,
  );
  const schema = readPolicyFile(
    schemaPath,
    'schema',
    expectedSchemaHash,
    fileLimit,
  );
  return { manifest: validateManifest(schema, manifest), schema };
}

function validateTextField(record, number, field) {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVENTORY_FIELD_INVALID', { issue: number, field });
  }
}

function labelNames(record, number) {
  if (!Array.isArray(record.labels)) {
    fail('INVENTORY_FIELD_INVALID', { issue: number, field: 'labels' });
  }
  return record.labels.map(label => {
    const name =
      typeof label === 'string'
        ? label
        : label !== null && typeof label === 'object' && !Array.isArray(label)
        ? label.name
        : null;
    if (typeof name !== 'string' || name.trim().length === 0) {
      fail('INVENTORY_FIELD_INVALID', { issue: number, field: 'labels' });
    }
    return name;
  });
}

export function verifyInventory(manifest, envelope) {
  if (!Array.isArray(envelope)) fail('INVENTORY_ENVELOPE_INVALID');

  const required = manifest.githubInventory.requiredIssueNumbers;
  const requiredSet = new Set(required);
  const expectedRepositoryUrl = `https://api.github.com/repos/${manifest.githubInventory.repository}`;
  const records = new Map();

  for (const record of envelope) {
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      !Number.isInteger(record.number)
    ) {
      fail('INVENTORY_RECORD_INVALID');
    }
    if (!requiredSet.has(record.number)) continue;
    if (record.repository_url !== expectedRepositoryUrl) {
      fail('INVENTORY_REPOSITORY_MISMATCH', { issue: record.number });
    }
    if (Object.hasOwn(record, 'pull_request')) {
      fail('INVENTORY_PULL_REQUEST_FORBIDDEN', { issue: record.number });
    }
    if (records.has(record.number)) {
      fail('INVENTORY_RECORD_DUPLICATE', { issue: record.number });
    }
    records.set(record.number, record);
  }

  for (const number of required) {
    const record = records.get(number);
    if (record === undefined)
      fail('INVENTORY_RECORD_MISSING', { issue: number });
    validateTextField(record, number, 'title');
    validateTextField(record, number, 'body');
    const names = labelNames(record, number);
    if (
      names.some(name =>
        manifest.githubInventory.forbiddenLabels.includes(name),
      )
    ) {
      fail('INVENTORY_FORBIDDEN_LABEL', { issue: number, field: 'labels' });
    }
  }

  if (records.size !== required.length) fail('INVENTORY_CARDINALITY_INVALID');
  return { records: records.size, physicalGateLabels: 0 };
}

export function parseInventoryText(text, limit = STDIN_LIMIT_BYTES) {
  if (typeof text !== 'string') fail('INVENTORY_ENVELOPE_INVALID');
  if (Buffer.byteLength(text, 'utf8') > limit) fail('STDIN_TOO_LARGE');
  try {
    return JSON.parse(text);
  } catch {
    fail('STDIN_JSON_INVALID');
  }
}

export async function readStdinBounded(stream, limit = STDIN_LIMIT_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) fail('STDIN_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export function formatPolicyError(error) {
  const safeError =
    error instanceof PolicyError
      ? error
      : new PolicyError('UNEXPECTED_FAILURE');
  const fields = [`rule=${safeError.rule}`];
  if (Number.isInteger(safeError.context.issue)) {
    fields.push(`issue=${safeError.context.issue}`);
  }
  if (
    typeof safeError.context.field === 'string' &&
    /^[A-Za-z][A-Za-z0-9.]*$/.test(safeError.context.field)
  ) {
    fields.push(`field=${safeError.context.field}`);
  }
  return `V01_POLICY_ERROR ${fields.join(' ')}`;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (
    argumentsList.length > 1 ||
    (argumentsList.length === 1 && argumentsList[0] !== '--issues-stdin')
  ) {
    fail('CLI_USAGE_INVALID');
  }

  const { manifest } = loadPolicyFiles();
  if (argumentsList[0] === '--issues-stdin') {
    const text = await readStdinBounded(process.stdin);
    const summary = verifyInventory(manifest, parseInventoryText(text));
    console.info(
      `V01_POLICY result=pass schemaVersion=1 records=${summary.records} physicalGateLabels=0`,
    );
    return;
  }
  console.info('V01_POLICY result=pass schemaVersion=1 policy=canonical');
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(error => {
    console.error(formatPolicyError(error));
    process.exitCode = 1;
  });
}
