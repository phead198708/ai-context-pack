import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPROVED_ADVISORIES,
  APPROVED_HIGH_PACKAGES,
  APPROVED_INCOMPATIBLE_FIXES,
  AUDIT_STDIN_LIMIT_BYTES,
  AuditPolicyError,
  formatAuditPolicyError,
  parseAuditText,
  readStdinBounded,
  verifyAuditReport,
} from './verify-npm-audit-policy.mjs';

const verifierSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    'verify-npm-audit-policy.mjs',
  ),
  'utf8',
);

function clone(value) {
  return structuredClone(value);
}

function makeLock() {
  return {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { expo: '57.0.11' },
        devDependencies: { jest: '29.7.0' },
      },
      'node_modules/image-size': {
        version: '1.2.1',
        resolved:
          'https://registry.npmjs.org/image-size/-/image-size-1.2.1.tgz',
        integrity:
          'sha512-rH+46sQJ2dlwfjfhCyNx5thzrv+dtmBIhPHk0zgRUukHzZ/kRueTJXoYYsclBaKcSMBWuGbOFXtioLpzTb5euw==',
        license: 'MIT',
      },
      'node_modules/metro': {
        version: '0.84.4',
        dependencies: { 'image-size': '^1.0.2' },
      },
    },
  };
}

function makeReport() {
  const vulnerabilities = Object.fromEntries(
    APPROVED_HIGH_PACKAGES.map(name => [
      name,
      {
        name,
        severity: 'high',
        isDirect: false,
        via:
          name === 'image-size' ? clone(APPROVED_ADVISORIES) : ['image-size'],
        effects: name === 'image-size' ? ['metro'] : [],
        nodes: [`node_modules/${name}`],
        range: name === 'image-size' ? '*' : 'synthetic',
        fixAvailable:
          name === 'image-size'
            ? {
                name: 'react-native',
                version: '0.72.17',
                isSemVerMajor: true,
              }
            : true,
      },
    ]),
  );
  vulnerabilities['image-size'].nodes = ['node_modules/image-size'];
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: APPROVED_HIGH_PACKAGES.length,
        critical: 0,
        total: APPROVED_HIGH_PACKAGES.length,
      },
    },
  };
}

function expectRule(action, rule) {
  assert.throws(action, error => {
    assert.ok(error instanceof AuditPolicyError);
    assert.equal(error.rule, rule);
    return true;
  });
}

test('approved image-size advisories pass only on the pinned Metro lock path', () => {
  assert.deepEqual(verifyAuditReport(makeReport(), makeLock()), {
    highPackages: 13,
    exceptions: 2,
  });
});

test('a clean audit passes without consulting the temporary exception', () => {
  const report = makeReport();
  report.vulnerabilities = {};
  report.metadata.vulnerabilities.high = 0;
  report.metadata.vulnerabilities.total = 0;
  assert.deepEqual(verifyAuditReport(report, {}), {
    highPackages: 0,
    exceptions: 0,
  });
});

test('unknown high and every critical finding fail closed', () => {
  const unknown = makeReport();
  unknown.vulnerabilities['unknown-package'] = {
    name: 'unknown-package',
    severity: 'high',
    isDirect: false,
    via: ['image-size'],
    effects: [],
    nodes: ['node_modules/unknown-package'],
    range: '*',
    fixAvailable: false,
  };
  unknown.metadata.vulnerabilities.high += 1;
  unknown.metadata.vulnerabilities.total += 1;
  expectRule(
    () => verifyAuditReport(unknown, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const critical = makeReport();
  critical.vulnerabilities['image-size'].severity = 'critical';
  critical.metadata.vulnerabilities.high -= 1;
  critical.metadata.vulnerabilities.critical = 1;
  expectRule(
    () => verifyAuditReport(critical, makeLock()),
    'AUDIT_UNAPPROVED_CRITICAL',
  );
});

test('advisory identity and severity metadata cannot drift', () => {
  const advisory = makeReport();
  advisory.vulnerabilities['image-size'].via[0].url =
    'https://github.com/advisories/GHSA-synthetic';
  expectRule(
    () => verifyAuditReport(advisory, makeLock()),
    'AUDIT_UNAPPROVED_ADVISORY',
  );

  const metadata = makeReport();
  metadata.metadata.vulnerabilities.high = 12;
  expectRule(
    () => verifyAuditReport(metadata, makeLock()),
    'AUDIT_METADATA_INVALID',
  );
});

test('runtime exposure, fix metadata, and dependency-path drift fail closed', () => {
  const direct = makeReport();
  direct.vulnerabilities['image-size'].isDirect = true;
  expectRule(
    () => verifyAuditReport(direct, makeLock()),
    'AUDIT_EXCEPTION_SCOPE_DRIFT',
  );

  const effect = makeReport();
  effect.vulnerabilities['image-size'].effects = ['runtime-consumer'];
  expectRule(
    () => verifyAuditReport(effect, makeLock()),
    'AUDIT_EXCEPTION_SCOPE_DRIFT',
  );

  const fix = makeReport();
  fix.vulnerabilities['image-size'].fixAvailable = true;
  expectRule(
    () => verifyAuditReport(fix, makeLock()),
    'AUDIT_EXCEPTION_SCOPE_DRIFT',
  );

  for (const incompatibleFix of APPROVED_INCOMPATIBLE_FIXES) {
    const report = makeReport();
    report.vulnerabilities['image-size'].fixAvailable = clone(incompatibleFix);
    assert.equal(verifyAuditReport(report, makeLock()).exceptions, 2);
  }

  const lock = makeLock();
  lock.packages['node_modules/image-size'].version = '2.0.2';
  expectRule(
    () => verifyAuditReport(makeReport(), lock),
    'AUDIT_EXCEPTION_LOCK_DRIFT',
  );
});

test('malformed, oversized, and structurally incomplete input fails closed', async () => {
  expectRule(() => parseAuditText('{'), 'STDIN_JSON_INVALID');
  expectRule(
    () => parseAuditText('x'.repeat(AUDIT_STDIN_LIMIT_BYTES + 1)),
    'STDIN_TOO_LARGE',
  );
  expectRule(
    () => verifyAuditReport({ auditReportVersion: 2 }, makeLock()),
    'AUDIT_REPORT_INVALID',
  );
  const errorEnvelope = makeReport();
  errorEnvelope.error = { code: 'EAUDIT' };
  expectRule(
    () => verifyAuditReport(errorEnvelope, makeLock()),
    'AUDIT_REPORT_INVALID',
  );
  await assert.rejects(
    readStdinBounded(
      Readable.from([Buffer.alloc(AUDIT_STDIN_LIMIT_BYTES + 1)]),
    ),
    error =>
      error instanceof AuditPolicyError && error.rule === 'STDIN_TOO_LARGE',
  );
});

test('diagnostics expose only stable rule identifiers', () => {
  assert.equal(
    formatAuditPolicyError(new AuditPolicyError('AUDIT_UNAPPROVED_ADVISORY')),
    'NPM_AUDIT_POLICY_ERROR rule=AUDIT_UNAPPROVED_ADVISORY',
  );
  assert.equal(
    formatAuditPolicyError(new Error('synthetic secret')),
    'NPM_AUDIT_POLICY_ERROR rule=UNEXPECTED_FAILURE',
  );
});

test('policy verifier has no network or subprocess implementation', () => {
  assert.doesNotMatch(verifierSource, /node:(?:child_process|http|https|net)/);
  assert.doesNotMatch(verifierSource, /\b(?:fetch|XMLHttpRequest)\s*\(/);
});
