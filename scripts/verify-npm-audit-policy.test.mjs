import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPROVED_ADVISORIES,
  APPROVED_HIGH_FIX_OPTIONS,
  APPROVED_HIGH_GRAPH,
  APPROVED_HIGH_LOCK_TOPOLOGY,
  APPROVED_HIGH_PACKAGES,
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
      ...Object.fromEntries(
        APPROVED_HIGH_LOCK_TOPOLOGY.map(entry => [
          entry.path,
          {
            version: entry.version,
            resolved: entry.resolved,
            integrity: entry.integrity,
            license: entry.license,
            dependencies: clone(entry.dependencies),
          },
        ]),
      ),
    },
  };
}

function makeReport() {
  const vulnerabilities = Object.fromEntries(
    APPROVED_HIGH_GRAPH.map((entry, index) => [
      entry.name,
      {
        name: entry.name,
        severity: 'high',
        isDirect: entry.isDirect,
        via: entry.via.map(via => {
          if (via.startsWith('package:')) return via.slice('package:'.length);
          const source = Number(via.slice('advisory:'.length));
          return clone(
            APPROVED_ADVISORIES.find(advisory => advisory.source === source),
          );
        }),
        effects: clone(entry.effects),
        nodes: clone(entry.nodes),
        range: entry.range,
        fixAvailable: clone(APPROVED_HIGH_FIX_OPTIONS[index].values[0]),
      },
    ]),
  );
  const referencedPackages = new Set(
    APPROVED_HIGH_GRAPH.flatMap(entry =>
      entry.via
        .filter(via => via.startsWith('package:'))
        .map(via => via.slice('package:'.length)),
    ),
  );
  for (const name of referencedPackages) {
    if (Object.hasOwn(vulnerabilities, name)) continue;
    vulnerabilities[name] = {
      name,
      severity: 'moderate',
      isDirect: false,
      via: [],
      effects: [],
      nodes: [`node_modules/${name}`],
      range: 'synthetic',
      fixAvailable: false,
    };
  }
  const moderateCount = Object.values(vulnerabilities).filter(
    vulnerability => vulnerability.severity === 'moderate',
  ).length;
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: moderateCount,
        high: APPROVED_HIGH_PACKAGES.length,
        critical: 0,
        total: Object.keys(vulnerabilities).length,
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
  report.metadata.vulnerabilities.moderate = 0;
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

test('nested high or critical advisories cannot hide below a lower top-level severity', () => {
  for (const severity of ['high', 'critical']) {
    const hidden = makeReport();
    hidden.vulnerabilities = {
      'synthetic-moderate': {
        name: 'synthetic-moderate',
        severity: 'moderate',
        isDirect: false,
        via: [
          {
            ...clone(APPROVED_ADVISORIES[0]),
            source: 9999999,
            severity,
          },
        ],
        effects: [],
        nodes: ['node_modules/synthetic-moderate'],
        range: '*',
        fixAvailable: false,
      },
    };
    hidden.metadata.vulnerabilities = {
      info: 0,
      low: 0,
      moderate: 1,
      high: 0,
      critical: 0,
      total: 1,
    };
    expectRule(
      () => verifyAuditReport(hidden, makeLock()),
      severity === 'critical'
        ? 'AUDIT_UNAPPROVED_CRITICAL'
        : 'AUDIT_SEVERITY_INCONSISTENT',
    );
  }
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
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const effect = makeReport();
  effect.vulnerabilities['image-size'].effects = ['runtime-consumer'];
  expectRule(
    () => verifyAuditReport(effect, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const fix = makeReport();
  fix.vulnerabilities['image-size'].fixAvailable = true;
  expectRule(() => verifyAuditReport(fix, makeLock()), 'AUDIT_FIX_GRAPH_DRIFT');

  for (const { name, values } of APPROVED_HIGH_FIX_OPTIONS) {
    for (const value of values) {
      const report = makeReport();
      report.vulnerabilities[name].fixAvailable = clone(value);
      assert.equal(verifyAuditReport(report, makeLock()).exceptions, 2);
    }
  }

  const lock = makeLock();
  lock.packages['node_modules/image-size'].version = '2.0.2';
  expectRule(
    () => verifyAuditReport(makeReport(), lock),
    'AUDIT_EXCEPTION_LOCK_DRIFT',
  );
});

test('compatible fixes on every propagated high package fail closed', () => {
  for (const name of APPROVED_HIGH_PACKAGES) {
    const report = makeReport();
    report.vulnerabilities[name].fixAvailable = {
      name,
      version: '999.0.0',
      isSemVerMajor: false,
    };
    expectRule(
      () => verifyAuditReport(report, makeLock()),
      'AUDIT_FIX_GRAPH_DRIFT',
    );
  }
});

test('the complete propagation topology and lock identities fail closed on drift', () => {
  const changedVia = makeReport();
  changedVia.vulnerabilities['@expo/metro'].via.push('image-size');
  expectRule(
    () => verifyAuditReport(changedVia, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const alternateNode = makeReport();
  alternateNode.vulnerabilities.metro.nodes.push(
    'node_modules/synthetic/node_modules/metro',
  );
  expectRule(
    () => verifyAuditReport(alternateNode, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const alternateLockPath = makeLock();
  alternateLockPath.packages['node_modules/synthetic/node_modules/metro'] =
    clone(alternateLockPath.packages['node_modules/metro']);
  expectRule(
    () => verifyAuditReport(makeReport(), alternateLockPath),
    'AUDIT_EXCEPTION_LOCK_DRIFT',
  );

  for (const path of [
    'node_modules/metro',
    'node_modules/@expo/metro',
    'node_modules/expo',
  ]) {
    const changedIntegrity = makeLock();
    changedIntegrity.packages[path].integrity = 'sha512-ATTACKER';
    expectRule(
      () => verifyAuditReport(makeReport(), changedIntegrity),
      'AUDIT_EXCEPTION_LOCK_DRIFT',
    );
  }
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
