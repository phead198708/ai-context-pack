import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_VENDOR_FINGERPRINT,
  VendoredImageSizeError,
  computeVendorFingerprint,
  runSecurityProbes,
  verifyRepositoryVendor,
  verifyVendoredImageSizeState,
} from './verify-vendored-image-size.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'));

function state() {
  return {
    packageJson: readJson('package.json'),
    packageLock: readJson('package-lock.json'),
    vendorPackage: readJson('vendor/image-size/package.json'),
  };
}

function expectRule(action, rule) {
  assert.throws(action, error => {
    assert.ok(error instanceof VendoredImageSizeError);
    assert.equal(error.rule, rule);
    return true;
  });
}

test('the repository vendor tree, lock topology, and security probes pass', () => {
  assert.equal(computeVendorFingerprint(), APPROVED_VENDOR_FINGERPRINT);
  assert.deepEqual(verifyRepositoryVendor(), {
    package: '@aicp/image-size@1.2.1',
    advisoriesPatched: 2,
  });
  runSecurityProbes(join(root, 'vendor/image-size/dist/index.js'));
});

test('root pin and override drift fail closed', () => {
  for (const mutate of [
    value => delete value.packageJson.dependencies['image-size'],
    value => (value.packageJson.overrides['image-size'] = '1.2.1'),
  ]) {
    const value = state();
    mutate(value);
    expectRule(
      () =>
        verifyVendoredImageSizeState(
          value.packageJson,
          value.packageLock,
          value.vendorPackage,
          APPROVED_VENDOR_FINGERPRINT,
        ),
      'VENDORED_IMAGE_SIZE_ROOT_PIN_DRIFT',
    );
  }
});

test('alternate registry copies and lock identity drift fail closed', () => {
  const alternate = state();
  alternate.packageLock.packages['node_modules/metro/node_modules/image-size'] =
    { version: '1.2.1' };
  expectRule(
    () =>
      verifyVendoredImageSizeState(
        alternate.packageJson,
        alternate.packageLock,
        alternate.vendorPackage,
        APPROVED_VENDOR_FINGERPRINT,
      ),
    'VENDORED_IMAGE_SIZE_LOCK_DRIFT',
  );

  const link = state();
  link.packageLock.packages['node_modules/image-size'].resolved =
    'https://registry.npmjs.org/image-size/-/image-size-1.2.1.tgz';
  expectRule(
    () =>
      verifyVendoredImageSizeState(
        link.packageJson,
        link.packageLock,
        link.vendorPackage,
        APPROVED_VENDOR_FINGERPRINT,
      ),
    'VENDORED_IMAGE_SIZE_LOCK_DRIFT',
  );
});

test('Metro edge, manifest, queue, and vendor bytes are pinned', () => {
  for (const [mutate, rule] of [
    [
      value =>
        (value.packageLock.packages['node_modules/metro'].dependencies[
          'image-size'
        ] = '^2.0.0'),
      'VENDORED_IMAGE_SIZE_METRO_EDGE_DRIFT',
    ],
    [
      value => (value.vendorPackage.name = 'image-size'),
      'VENDORED_IMAGE_SIZE_MANIFEST_DRIFT',
    ],
    [
      value =>
        (value.packageLock.packages['node_modules/queue'].integrity =
          'sha512-ATTACKER'),
      'VENDORED_IMAGE_SIZE_QUEUE_DRIFT',
    ],
  ]) {
    const value = state();
    mutate(value);
    expectRule(
      () =>
        verifyVendoredImageSizeState(
          value.packageJson,
          value.packageLock,
          value.vendorPackage,
          APPROVED_VENDOR_FINGERPRINT,
        ),
      rule,
    );
  }

  const value = state();
  expectRule(
    () =>
      verifyVendoredImageSizeState(
        value.packageJson,
        value.packageLock,
        value.vendorPackage,
        '0'.repeat(64),
      ),
    'VENDORED_IMAGE_SIZE_TREE_DRIFT',
  );
});
