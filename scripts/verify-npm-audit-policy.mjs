import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedSeverities = new Set([
  'info',
  'low',
  'moderate',
  'high',
  'critical',
]);

export const AUDIT_STDIN_LIMIT_BYTES = 2 * 1024 * 1024;

export const APPROVED_ADVISORIES = Object.freeze([
  Object.freeze({
    source: 1138808,
    name: 'image-size',
    dependency: 'image-size',
    title:
      'image-size: ICNS parser allows denial of service through an infinite loop',
    url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
    severity: 'high',
    cwe: Object.freeze(['CWE-835']),
    cvss: Object.freeze({
      score: 7.5,
      vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
    }),
    range: '<=2.0.2',
  }),
  Object.freeze({
    source: 1138809,
    name: 'image-size',
    dependency: 'image-size',
    title:
      'image-size: JXL and HEIF parsers allow denial of service through infinite loops',
    url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
    severity: 'high',
    cwe: Object.freeze(['CWE-835']),
    cvss: Object.freeze({
      score: 7.5,
      vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
    }),
    range: '<=2.0.2',
  }),
]);

export const APPROVED_HIGH_PACKAGES = Object.freeze([
  '@expo/cli',
  '@expo/metro',
  '@expo/metro-config',
  '@react-native/community-cli-plugin',
  '@react-native/metro-config',
  '@react-native/new-app-screen',
  '@react-native/virtualized-lists',
  'expo',
  'image-size',
  'metro',
  'metro-config',
  'metro-transform-worker',
  'react-native',
]);

export const APPROVED_INCOMPATIBLE_FIXES = Object.freeze([
  Object.freeze({
    name: 'expo',
    version: '53.0.27',
    isSemVerMajor: true,
  }),
  Object.freeze({
    name: 'react-native',
    version: '0.72.17',
    isSemVerMajor: true,
  }),
]);

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

function exactStrings(value, expected) {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string') &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort())
  );
}

function advisoryProjection(value) {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.source) ||
    typeof value.name !== 'string' ||
    typeof value.dependency !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.severity !== 'string' ||
    !Array.isArray(value.cwe) ||
    !value.cwe.every(item => typeof item === 'string') ||
    !isRecord(value.cvss) ||
    typeof value.cvss.score !== 'number' ||
    typeof value.cvss.vectorString !== 'string' ||
    typeof value.range !== 'string'
  ) {
    fail('AUDIT_REPORT_INVALID');
  }
  return {
    source: value.source,
    name: value.name,
    dependency: value.dependency,
    title: value.title,
    url: value.url,
    severity: value.severity,
    cwe: [...value.cwe].sort(),
    cvss: {
      score: value.cvss.score,
      vectorString: value.cvss.vectorString,
    },
    range: value.range,
  };
}

function verifyExceptionLock(packageLock) {
  if (
    !isRecord(packageLock) ||
    packageLock.lockfileVersion !== 3 ||
    !isRecord(packageLock.packages)
  ) {
    fail('AUDIT_LOCK_INVALID');
  }
  const root = packageLock.packages[''];
  const imageSize = packageLock.packages['node_modules/image-size'];
  const metro = packageLock.packages['node_modules/metro'];
  if (
    !isRecord(root) ||
    !isRecord(imageSize) ||
    !isRecord(metro) ||
    imageSize.version !== '1.2.1' ||
    imageSize.resolved !==
      'https://registry.npmjs.org/image-size/-/image-size-1.2.1.tgz' ||
    imageSize.integrity !==
      'sha512-rH+46sQJ2dlwfjfhCyNx5thzrv+dtmBIhPHk0zgRUukHzZ/kRueTJXoYYsclBaKcSMBWuGbOFXtioLpzTb5euw==' ||
    imageSize.license !== 'MIT' ||
    metro.version !== '0.84.4' ||
    !isRecord(metro.dependencies) ||
    metro.dependencies['image-size'] !== '^1.0.2' ||
    root.dependencies?.['image-size'] !== undefined ||
    root.devDependencies?.['image-size'] !== undefined ||
    root.optionalDependencies?.['image-size'] !== undefined ||
    root.peerDependencies?.['image-size'] !== undefined
  ) {
    fail('AUDIT_EXCEPTION_LOCK_DRIFT');
  }
}

function validateVulnerabilityRecord(name, vulnerability, vulnerabilities) {
  if (
    !isRecord(vulnerability) ||
    vulnerability.name !== name ||
    !allowedSeverities.has(vulnerability.severity) ||
    typeof vulnerability.isDirect !== 'boolean' ||
    !Array.isArray(vulnerability.via) ||
    !Array.isArray(vulnerability.effects) ||
    !vulnerability.effects.every(item => typeof item === 'string') ||
    !Array.isArray(vulnerability.nodes) ||
    !vulnerability.nodes.every(item => typeof item === 'string') ||
    typeof vulnerability.range !== 'string'
  ) {
    fail('AUDIT_REPORT_INVALID');
  }
  for (const via of vulnerability.via) {
    if (typeof via === 'string') {
      if (!Object.hasOwn(vulnerabilities, via)) fail('AUDIT_REPORT_INVALID');
      continue;
    }
    advisoryProjection(via);
  }
}

function reachesImageSize(name, vulnerabilities, visiting = new Set()) {
  if (name === 'image-size') return true;
  if (visiting.has(name)) return false;
  visiting.add(name);
  const vulnerability = vulnerabilities[name];
  const reaches = vulnerability.via.some(
    via =>
      typeof via === 'string' &&
      reachesImageSize(via, vulnerabilities, new Set(visiting)),
  );
  return reaches;
}

export function verifyAuditReport(report, packageLock) {
  if (
    !isRecord(report) ||
    Object.hasOwn(report, 'error') ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities)
  ) {
    fail('AUDIT_REPORT_INVALID');
  }

  const vulnerabilities = report.vulnerabilities;
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    validateVulnerabilityRecord(name, vulnerability, vulnerabilities);
  }

  const criticalNames = Object.entries(vulnerabilities)
    .filter(([, value]) => value.severity === 'critical')
    .map(([name]) => name)
    .sort();
  if (criticalNames.length > 0) fail('AUDIT_UNAPPROVED_CRITICAL');

  const highNames = Object.entries(vulnerabilities)
    .filter(([, value]) => value.severity === 'high')
    .map(([name]) => name)
    .sort();
  const metadata = report.metadata.vulnerabilities;
  const actualSeverityCounts = Object.fromEntries(
    [...allowedSeverities].map(severity => [
      severity,
      Object.values(vulnerabilities).filter(
        vulnerability => vulnerability.severity === severity,
      ).length,
    ]),
  );
  if (
    [...allowedSeverities].some(
      severity =>
        !Number.isInteger(metadata[severity]) ||
        metadata[severity] < 0 ||
        metadata[severity] !== actualSeverityCounts[severity],
    ) ||
    !Number.isInteger(metadata.total) ||
    metadata.total !== Object.keys(vulnerabilities).length
  ) {
    fail('AUDIT_METADATA_INVALID');
  }

  if (highNames.length === 0) {
    return { highPackages: 0, exceptions: 0 };
  }
  if (!exactStrings(highNames, APPROVED_HIGH_PACKAGES)) {
    fail('AUDIT_HIGH_GRAPH_DRIFT');
  }

  const directHighAdvisories = [];
  for (const vulnerability of Object.values(vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (
        isRecord(via) &&
        (via.severity === 'high' || via.severity === 'critical')
      ) {
        directHighAdvisories.push(advisoryProjection(via));
      }
    }
  }
  directHighAdvisories.sort((left, right) => left.source - right.source);
  if (
    JSON.stringify(directHighAdvisories) !== JSON.stringify(APPROVED_ADVISORIES)
  ) {
    fail('AUDIT_UNAPPROVED_ADVISORY');
  }

  const imageSize = vulnerabilities['image-size'];
  if (
    imageSize.isDirect !== false ||
    !exactStrings(imageSize.effects, ['metro']) ||
    !exactStrings(imageSize.nodes, ['node_modules/image-size']) ||
    imageSize.range !== '*' ||
    !isRecord(imageSize.fixAvailable) ||
    !APPROVED_INCOMPATIBLE_FIXES.some(
      fix => JSON.stringify(fix) === JSON.stringify(imageSize.fixAvailable),
    ) ||
    imageSize.via.some(via => !isRecord(via))
  ) {
    fail('AUDIT_EXCEPTION_SCOPE_DRIFT');
  }
  if (
    highNames.some(
      name =>
        name !== 'image-size' &&
        vulnerabilities[name].via.some(via => isRecord(via)),
    ) ||
    highNames.some(name => !reachesImageSize(name, vulnerabilities))
  ) {
    fail('AUDIT_HIGH_GRAPH_DRIFT');
  }

  verifyExceptionLock(packageLock);
  return {
    highPackages: highNames.length,
    exceptions: directHighAdvisories.length,
  };
}

export function parseAuditText(text, limit = AUDIT_STDIN_LIMIT_BYTES) {
  if (typeof text !== 'string') fail('AUDIT_REPORT_INVALID');
  if (Buffer.byteLength(text, 'utf8') > limit) fail('STDIN_TOO_LARGE');
  try {
    return JSON.parse(text);
  } catch {
    fail('STDIN_JSON_INVALID');
  }
}

export async function readStdinBounded(
  stream,
  limit = AUDIT_STDIN_LIMIT_BYTES,
) {
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

export function formatAuditPolicyError(error) {
  const rule =
    error instanceof AuditPolicyError ? error.rule : 'UNEXPECTED_FAILURE';
  return `NPM_AUDIT_POLICY_ERROR rule=${rule}`;
}

async function main() {
  if (process.argv.length !== 2) fail('CLI_USAGE_INVALID');
  const text = await readStdinBounded(process.stdin);
  const report = parseAuditText(text);
  let packageLock;
  try {
    packageLock = JSON.parse(
      readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'),
    );
  } catch {
    fail('AUDIT_LOCK_INVALID');
  }
  const summary = verifyAuditReport(report, packageLock);
  console.info(
    `NPM_AUDIT_POLICY result=pass highPackages=${summary.highPackages} approvedExceptions=${summary.exceptions}`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(error => {
    console.error(formatAuditPolicyError(error));
    process.exitCode = 1;
  });
}
