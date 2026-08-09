import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_STDIN_LIMIT_BYTES,
  AuditPolicyError,
  parseAuditText,
  verifyAuditReport,
} from './verify-npm-audit-policy.mjs';

function cleanReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
}

function vulnerability(severity, via = []) {
  return {
    name: 'synthetic',
    severity,
    isDirect: false,
    via,
    effects: [],
    nodes: ['node_modules/synthetic'],
    range: '*',
    fixAvailable: false,
  };
}

function expectRule(action, rule) {
  assert.throws(action, error => {
    assert.ok(error instanceof AuditPolicyError);
    assert.equal(error.rule, rule);
    return true;
  });
}

test('a completely clean npm audit report passes without exceptions', () => {
  assert.deepEqual(verifyAuditReport(cleanReport()), {
    vulnerabilities: 0,
    exceptions: 0,
  });
});

for (const severity of ['info', 'low', 'moderate']) {
  test(`${severity} findings fail the all-severity clean gate`, () => {
    const report = cleanReport();
    report.vulnerabilities.synthetic = vulnerability(severity);
    report.metadata.vulnerabilities[severity] = 1;
    report.metadata.vulnerabilities.total = 1;
    expectRule(() => verifyAuditReport(report), 'AUDIT_NOT_CLEAN');
  });
}

test('top-level high and critical findings fail with stable rules', () => {
  for (const [severity, rule] of [
    ['high', 'AUDIT_UNAPPROVED_HIGH'],
    ['critical', 'AUDIT_UNAPPROVED_CRITICAL'],
  ]) {
    const report = cleanReport();
    report.vulnerabilities.synthetic = vulnerability(severity);
    report.metadata.vulnerabilities[severity] = 1;
    report.metadata.vulnerabilities.total = 1;
    expectRule(() => verifyAuditReport(report), rule);
  }
});

test('nested high and critical advisories cannot hide below moderate records', () => {
  for (const [severity, rule] of [
    ['high', 'AUDIT_UNAPPROVED_HIGH'],
    ['critical', 'AUDIT_UNAPPROVED_CRITICAL'],
  ]) {
    const report = cleanReport();
    report.vulnerabilities.synthetic = vulnerability('moderate', [
      { severity },
    ]);
    report.metadata.vulnerabilities.moderate = 1;
    report.metadata.vulnerabilities.total = 1;
    expectRule(() => verifyAuditReport(report), rule);
  }
});

test('metadata and record structure drift fail closed', () => {
  const countDrift = cleanReport();
  countDrift.metadata.vulnerabilities.total = 1;
  expectRule(() => verifyAuditReport(countDrift), 'AUDIT_METADATA_INVALID');

  const malformed = cleanReport();
  malformed.vulnerabilities.synthetic = { severity: 'low' };
  malformed.metadata.vulnerabilities.low = 1;
  malformed.metadata.vulnerabilities.total = 1;
  expectRule(() => verifyAuditReport(malformed), 'AUDIT_REPORT_INVALID');

  const errorEnvelope = cleanReport();
  errorEnvelope.error = { code: 'EAUDIT' };
  expectRule(() => verifyAuditReport(errorEnvelope), 'AUDIT_REPORT_INVALID');
});

test('malformed and oversized input fail closed', () => {
  expectRule(() => parseAuditText('{'), 'STDIN_JSON_INVALID');
  expectRule(
    () => parseAuditText('x'.repeat(AUDIT_STDIN_LIMIT_BYTES + 1)),
    'STDIN_TOO_LARGE',
  );
});
