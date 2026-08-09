import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(repositoryRoot, 'vendor', 'image-size');

export const APPROVED_VENDOR_FINGERPRINT =
  '293b3615cd7c3ab67e2ec565775d50d9d842219b3b5533c47ad2ef978ae6273d';

export class VendoredImageSizeError extends Error {
  constructor(rule) {
    super(rule);
    this.name = 'VendoredImageSizeError';
    this.rule = rule;
  }
}

function fail(rule) {
  throw new VendoredImageSizeError(rule);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  return JSON.stringify(value);
}

export function computeVendorFingerprint(root = vendorRoot) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else fail('VENDORED_IMAGE_SIZE_TREE_INVALID');
    }
  };
  visit(root);
  files.sort();
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyVendoredImageSizeState(
  packageJson,
  packageLock,
  vendorPackage,
  fingerprint,
) {
  if (
    !isRecord(packageJson) ||
    packageJson.dependencies?.['image-size'] !== 'file:vendor/image-size' ||
    packageJson.overrides?.['image-size'] !== '$image-size'
  ) {
    fail('VENDORED_IMAGE_SIZE_ROOT_PIN_DRIFT');
  }
  if (
    !isRecord(packageLock) ||
    packageLock.lockfileVersion !== 3 ||
    !isRecord(packageLock.packages)
  ) {
    fail('VENDORED_IMAGE_SIZE_LOCK_INVALID');
  }
  const packages = packageLock.packages;
  if (
    packages['']?.dependencies?.['image-size'] !== 'file:vendor/image-size' ||
    stable(packages['node_modules/image-size']) !==
      stable({ resolved: 'vendor/image-size', link: true })
  ) {
    fail('VENDORED_IMAGE_SIZE_LOCK_DRIFT');
  }
  const imagePaths = Object.keys(packages).filter(
    path =>
      path === 'node_modules/image-size' ||
      path.endsWith('/node_modules/image-size'),
  );
  if (stable(imagePaths.sort()) !== stable(['node_modules/image-size'])) {
    fail('VENDORED_IMAGE_SIZE_LOCK_DRIFT');
  }

  const expectedVendorLock = {
    name: '@aicp/image-size',
    version: '1.2.1',
    license: 'MIT',
    dependencies: { queue: '6.0.2' },
    bin: { 'image-size': 'bin/image-size.js' },
    engines: { node: '>=16.x' },
  };
  if (stable(packages['vendor/image-size']) !== stable(expectedVendorLock)) {
    fail('VENDORED_IMAGE_SIZE_LOCK_DRIFT');
  }
  const metro = packages['node_modules/metro'];
  if (
    !isRecord(metro) ||
    metro.version !== '0.84.4' ||
    metro.resolved !== 'https://registry.npmjs.org/metro/-/metro-0.84.4.tgz' ||
    metro.integrity !==
      'sha512-8ETTubqfD6ornDy2zYDvRcKnVDOXdFJsjetYDBsY4oAsb6NJkiwFR+FaMESyGppFmQUyBQA4H4sFGxzcQSGtFA==' ||
    metro.dependencies?.['image-size'] !== '^1.0.2'
  ) {
    fail('VENDORED_IMAGE_SIZE_METRO_EDGE_DRIFT');
  }
  const queue = packages['node_modules/queue'];
  if (
    !isRecord(queue) ||
    queue.version !== '6.0.2' ||
    queue.resolved !== 'https://registry.npmjs.org/queue/-/queue-6.0.2.tgz' ||
    queue.integrity !==
      'sha512-iHZWu+q3IdFZFX36ro/lKBkSvfkztY5Y7HMiPlOUjhupPcG2JMfst2KKEpu5XndviX/3UhFbRngUPNKtgvtZiA=='
  ) {
    fail('VENDORED_IMAGE_SIZE_QUEUE_DRIFT');
  }

  const expectedPatch = {
    upstream: 'image-size@1.2.1',
    advisories: ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'],
    scope: 'Reject non-advancing BMFF boxes and ICNS entries before parsing.',
  };
  if (
    !isRecord(vendorPackage) ||
    vendorPackage.name !== '@aicp/image-size' ||
    vendorPackage.version !== '1.2.1' ||
    vendorPackage.license !== 'MIT' ||
    stable(vendorPackage.dependencies) !== stable({ queue: '6.0.2' }) ||
    stable(vendorPackage.aicpSecurityPatch) !== stable(expectedPatch) ||
    Object.hasOwn(vendorPackage, 'devDependencies') ||
    Object.hasOwn(vendorPackage, 'scripts')
  ) {
    fail('VENDORED_IMAGE_SIZE_MANIFEST_DRIFT');
  }
  if (fingerprint !== APPROVED_VENDOR_FINGERPRINT) {
    fail('VENDORED_IMAGE_SIZE_TREE_DRIFT');
  }
  return { package: '@aicp/image-size@1.2.1', advisoriesPatched: 2 };
}

export function runSecurityProbes(modulePath) {
  const script = String.raw`
    const imageSize = require(process.argv[1]);
    const expectReject = (name, bytes) => {
      try { imageSize(Uint8Array.from(bytes)); }
      catch { return; }
      throw new Error(name + ' payload was accepted');
    };
    expectReject('ICNS', [
      0x69,0x63,0x6e,0x73, 0x00,0x00,0x00,0x10,
      0x69,0x73,0x33,0x32, 0x00,0x00,0x00,0x00,
    ]);
    expectReject('JXL', [
      0x00,0x00,0x00,0x0c, 0x4a,0x58,0x4c,0x20,
      0x0d,0x0a,0x87,0x0a,
      0x00,0x00,0x00,0x14, 0x66,0x74,0x79,0x70,
      0x6a,0x78,0x6c,0x20, 0x00,0x00,0x00,0x00,
      0x6a,0x78,0x6c,0x20,
      0x00,0x00,0x00,0x00, 0x6a,0x78,0x6c,0x70,
      0x00,0x00,0x00,0x00,
    ]);
    expectReject('HEIF', [
      0x00,0x00,0x00,0x10, 0x66,0x74,0x79,0x70,
      0x61,0x76,0x69,0x66, 0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x24, 0x6d,0x65,0x74,0x61,
      0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x08, 0x69,0x70,0x72,0x70,
      0x00,0x00,0x00,0x14, 0x69,0x70,0x63,0x6f,
      0x00,0x00,0x00,0x00, 0x69,0x73,0x70,0x65,
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
    ]);
  `;
  const result = spawnSync(process.execPath, ['-e', script, modulePath], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    fail('VENDORED_IMAGE_SIZE_PROBE_TIMEOUT');
  }
  if (result.status !== 0) {
    fail('VENDORED_IMAGE_SIZE_PROBE_FAILED');
  }
}

export function verifyRepositoryVendor() {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const packageLock = JSON.parse(
    readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'),
  );
  const vendorPackage = JSON.parse(
    readFileSync(join(vendorRoot, 'package.json'), 'utf8'),
  );
  const result = verifyVendoredImageSizeState(
    packageJson,
    packageLock,
    vendorPackage,
    computeVendorFingerprint(),
  );
  runSecurityProbes(join(vendorRoot, 'dist', 'index.js'));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyRepositoryVendor();
    process.stdout.write(
      `vendored image-size verified: ${result.package}; ${result.advisoriesPatched} patched advisories.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.rule ?? 'VENDORED_IMAGE_SIZE_FAILED'}\n`);
    process.exitCode = 1;
  }
}
