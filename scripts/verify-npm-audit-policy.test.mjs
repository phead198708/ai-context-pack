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
const approvedPackageLock = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package-lock.json'),
    'utf8',
  ),
);

function clone(value) {
  return structuredClone(value);
}

function makeLock() {
  return clone(approvedPackageLock);
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

  const alternateExpoCycle = makeReport();
  alternateExpoCycle.vulnerabilities['@expo/cli'].effects = ['expo'];
  alternateExpoCycle.vulnerabilities['@expo/metro-config'].effects = [];
  assert.equal(verifyAuditReport(alternateExpoCycle, makeLock()).exceptions, 2);

  for (const approved of APPROVED_HIGH_FIX_OPTIONS) {
    for (const value of approved.values) {
      const report = makeReport();
      report.vulnerabilities[approved.name].fixAvailable = clone(value);
      assert.equal(verifyAuditReport(report, makeLock()).exceptions, 2);
    }
  }
});

test('registry-expanded propagation passes only through the pinned lock graph', () => {
  const report = makeReport();
  for (const name of ['expo-image-picker', 'expo-document-picker']) {
    report.vulnerabilities[name] = {
      name,
      severity: 'high',
      isDirect: true,
      via: ['expo'],
      effects: [],
      nodes: [`node_modules/${name}`],
      range: '*',
      fixAvailable: clone(
        APPROVED_HIGH_FIX_OPTIONS.find(value => value.name === 'expo')
          .values[0],
      ),
    };
    report.vulnerabilities.expo.effects.push(name);
    report.metadata.vulnerabilities.high += 1;
    report.metadata.vulnerabilities.total += 1;
  }
  assert.deepEqual(verifyAuditReport(report, makeLock()), {
    highPackages: 15,
    exceptions: 2,
  });

  const expandedNoFix = clone(report);
  for (const name of ['expo-image-picker', 'expo-document-picker']) {
    expandedNoFix.vulnerabilities[name].range = '';
    expandedNoFix.vulnerabilities[name].fixAvailable = false;
  }
  assert.deepEqual(verifyAuditReport(expandedNoFix, makeLock()), {
    highPackages: 15,
    exceptions: 2,
  });

  const expandedCompatibleFix = clone(expandedNoFix);
  expandedCompatibleFix.vulnerabilities[
    'expo-image-picker'
  ].fixAvailable = true;
  expectRule(
    () => verifyAuditReport(expandedCompatibleFix, makeLock()),
    'AUDIT_FIX_GRAPH_DRIFT',
  );

  const forged = clone(report);
  forged.vulnerabilities['expo-image-picker'].via = ['image-size'];
  expectRule(
    () => verifyAuditReport(forged, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const swappedFix = clone(report);
  swappedFix.vulnerabilities['expo-image-picker'].fixAvailable = clone(
    APPROVED_HIGH_FIX_OPTIONS.find(value => value.name === 'react-native')
      .values[0],
  );
  expectRule(
    () => verifyAuditReport(swappedFix, makeLock()),
    'AUDIT_FIX_GRAPH_DRIFT',
  );

  const compatibleFix = clone(report);
  compatibleFix.vulnerabilities['expo-image-picker'].fixAvailable = true;
  expectRule(
    () => verifyAuditReport(compatibleFix, makeLock()),
    'AUDIT_FIX_GRAPH_DRIFT',
  );

  const forgedRange = clone(report);
  forgedRange.vulnerabilities['expo-image-picker'].range = '>=0.0.0';
  expectRule(
    () => verifyAuditReport(forgedRange, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  for (const target of ['@expo/cli', '@expo/metro-config']) {
    const reachableFix = clone(report);
    reachableFix.vulnerabilities['expo-image-picker'].fixAvailable = clone(
      APPROVED_HIGH_FIX_OPTIONS.find(value => value.name === target).values[0],
    );
    expectRule(
      () => verifyAuditReport(reachableFix, makeLock()),
      'AUDIT_FIX_GRAPH_DRIFT',
    );
  }
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

test('a no-high report must be completely clean across every severity', () => {
  for (const severity of ['info', 'low', 'moderate']) {
    const report = makeReport();
    report.vulnerabilities = {
      'unexpected-package': {
        name: 'unexpected-package',
        severity,
        isDirect: false,
        via: [],
        effects: [],
        nodes: ['node_modules/unexpected-package'],
        range: '*',
        fixAvailable: false,
      },
    };
    report.metadata.vulnerabilities = {
      info: severity === 'info' ? 1 : 0,
      low: severity === 'low' ? 1 : 0,
      moderate: severity === 'moderate' ? 1 : 0,
      high: 0,
      critical: 0,
      total: 1,
    };
    expectRule(() => verifyAuditReport(report, {}), 'AUDIT_HIGH_GRAPH_DRIFT');
  }
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
    const booleanFix = makeReport();
    booleanFix.vulnerabilities[name].fixAvailable = true;
    expectRule(
      () => verifyAuditReport(booleanFix, makeLock()),
      'AUDIT_FIX_GRAPH_DRIFT',
    );

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

  const wrongPinnedMajor = makeReport();
  wrongPinnedMajor.vulnerabilities['@expo/cli'].fixAvailable = clone(
    APPROVED_HIGH_FIX_OPTIONS.find(value => value.name === 'expo').values[0],
  );
  expectRule(
    () => verifyAuditReport(wrongPinnedMajor, makeLock()),
    'AUDIT_FIX_GRAPH_DRIFT',
  );
});

test('lower-severity records cannot hide alternate high propagation paths', () => {
  const lowerSeverity = makeReport();
  lowerSeverity.vulnerabilities['@expo/config'] = {
    name: '@expo/config',
    severity: 'moderate',
    isDirect: false,
    via: ['image-size'],
    effects: ['@expo/cli'],
    nodes: ['node_modules/@expo/config'],
    range: '*',
    fixAvailable: false,
  };
  lowerSeverity.metadata.vulnerabilities.moderate = 1;
  lowerSeverity.metadata.vulnerabilities.total += 1;
  expectRule(
    () => verifyAuditReport(lowerSeverity, makeLock()),
    'AUDIT_SEVERITY_INCONSISTENT',
  );

  const unrelatedModerate = makeReport();
  unrelatedModerate.vulnerabilities['synthetic-moderate'] = {
    name: 'synthetic-moderate',
    severity: 'moderate',
    isDirect: false,
    via: [],
    effects: [],
    nodes: ['node_modules/synthetic-moderate'],
    range: '*',
    fixAvailable: false,
  };
  unrelatedModerate.metadata.vulnerabilities.moderate = 1;
  unrelatedModerate.metadata.vulnerabilities.total += 1;
  expectRule(
    () => verifyAuditReport(unrelatedModerate, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );
});

test('the complete propagation topology and lock identities fail closed on drift', () => {
  const changedVia = makeReport();
  changedVia.vulnerabilities['@expo/metro'].via.push('image-size');
  expectRule(
    () => verifyAuditReport(changedVia, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const changedRange = makeReport();
  changedRange.vulnerabilities['@expo/cli'].range = 'forged-range';
  expectRule(
    () => verifyAuditReport(changedRange, makeLock()),
    'AUDIT_HIGH_GRAPH_DRIFT',
  );

  const missingEffect = makeReport();
  missingEffect.vulnerabilities['@expo/metro'].effects =
    missingEffect.vulnerabilities['@expo/metro'].effects.filter(
      effect => effect !== '@expo/cli',
    );
  expectRule(
    () => verifyAuditReport(missingEffect, makeLock()),
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

  const missingRootPin = makeLock();
  delete missingRootPin.packages[''].optionalDependencies['@expo/metro-config'];
  expectRule(
    () => verifyAuditReport(makeReport(), missingRootPin),
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
