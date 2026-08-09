import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];

export const AUDIT_STDIN_LIMIT_BYTES = 2 * 1024 * 1024;

export class AuditPolicyError extends Error {
  constructor(rule) {
    super(rule);
    this.name = 'AuditPolicyError';
    this.rule = rule;
  }
}

function fail(rule) {
  throw new AuditPolicyError(rule);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAdvisorySeverity(via) {
  if (typeof via === 'string') return;
  if (!isRecord(via) || typeof via.severity !== 'string') {
    fail('AUDIT_REPORT_INVALID');
  }
  if (via.severity === 'critical') fail('AUDIT_UNAPPROVED_CRITICAL');
  if (via.severity === 'high') fail('AUDIT_UNAPPROVED_HIGH');
  if (!severities.includes(via.severity)) fail('AUDIT_REPORT_INVALID');
}

function validateVulnerability(name, vulnerability) {
  if (
    !isRecord(vulnerability) ||
    vulnerability.name !== name ||
    !severities.includes(vulnerability.severity) ||
    typeof vulnerability.isDirect !== 'boolean' ||
    !Array.isArray(vulnerability.via) ||
    !Array.isArray(vulnerability.effects) ||
    !vulnerability.effects.every(value => typeof value === 'string') ||
    !Array.isArray(vulnerability.nodes) ||
    !vulnerability.nodes.every(value => typeof value === 'string') ||
    typeof vulnerability.range !== 'string'
  ) {
    fail('AUDIT_REPORT_INVALID');
  }
  vulnerability.via.forEach(validateAdvisorySeverity);
  if (vulnerability.severity === 'critical') fail('AUDIT_UNAPPROVED_CRITICAL');
  if (vulnerability.severity === 'high') fail('AUDIT_UNAPPROVED_HIGH');
}

export function parseAuditText(text) {
  if (Buffer.byteLength(text, 'utf8') > AUDIT_STDIN_LIMIT_BYTES) {
    fail('STDIN_TOO_LARGE');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('STDIN_JSON_INVALID');
  }
}

export function verifyAuditReport(report) {
  if (
    !isRecord(report) ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities) ||
    Object.hasOwn(report, 'error')
  ) {
    fail('AUDIT_REPORT_INVALID');
  }

  const counts = report.metadata.vulnerabilities;
  if (
    JSON.stringify(Object.keys(counts).sort()) !==
      JSON.stringify([...severities, 'total'].sort()) ||
    ![...severities, 'total'].every(
      severity => Number.isInteger(counts[severity]) && counts[severity] >= 0,
    ) ||
    severities.reduce((total, severity) => total + counts[severity], 0) !==
      counts.total
  ) {
    fail('AUDIT_METADATA_INVALID');
  }

  const actualCounts = Object.fromEntries(
    severities.map(severity => [severity, 0]),
  );
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    validateVulnerability(name, vulnerability);
    actualCounts[vulnerability.severity] += 1;
  }
  if (
    severities.some(severity => actualCounts[severity] !== counts[severity]) ||
    Object.keys(report.vulnerabilities).length !== counts.total
  ) {
    fail('AUDIT_METADATA_INVALID');
  }
  if (counts.total !== 0) fail('AUDIT_NOT_CLEAN');

  return { vulnerabilities: 0, exceptions: 0 };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > AUDIT_STDIN_LIMIT_BYTES) fail('STDIN_TOO_LARGE');
    chunks.push(chunk);
  }
  const result = verifyAuditReport(
    parseAuditText(Buffer.concat(chunks).toString('utf8')),
  );
  stdout.write(
    `npm audit policy passed: ${result.vulnerabilities} vulnerabilities; ${result.exceptions} exceptions.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.rule ?? 'AUDIT_POLICY_FAILED'}\n`);
    process.exitCode = 1;
  });
}
