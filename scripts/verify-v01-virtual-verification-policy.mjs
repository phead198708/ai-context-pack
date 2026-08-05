import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyPaths = [
  '.github/labels.yml',
  '.github/pull_request_template.md',
  'README.md',
  'docs/MASTER-GOAL.md',
  'docs/adr/0001-react-native-cross-platform.md',
  'docs/adr/0002-sqlite-file-storage-and-inbox-recovery.md',
  'docs/adr/0003-v0.1-virtual-device-verification.md',
  'docs/wiki/Architecture.md',
  'docs/wiki/Labels.md',
  'docs/wiki/Product-Spec.md',
  'docs/wiki/Roadmap.md',
];
const staleRequirementRules = [
  {
    id: 'low-end-device-tier',
    pattern:
      /\b(?:low[- ]end|low[- ]spec(?:ification)?|entry[- ]level)\b.{0,80}\b(?:device|hardware|phone|tablet)s?\b/i,
  },
  {
    id: 'current-flagship-tier',
    pattern: /\bcurrent flagship(?: devices?)?\b/i,
  },
  {
    id: 'flagship-device-tier',
    pattern:
      /\b(?:flagship|high[- ]end)\b.{0,80}\b(?:device|hardware|phone|tablet)s?\b/i,
  },
  {
    id: 'host-device-variations',
    pattern: /\bhost\s*\/\s*device variations\b/i,
  },
  {
    id: 'hardware-tier-evidence',
    pattern:
      /\bhardware[- ]tier(?:s|ed)?\b.{0,80}\b(?:benchmark|evidence|matrix|requirement)s?\b/i,
  },
  {
    id: 'representative-physical-device',
    pattern: /\brepresentative physical devices?\b/i,
  },
  {
    id: 'real-iphone-ipad',
    pattern: /\breal iPhone\s*\/\s*iPad\b/i,
  },
  {
    id: 'physical-emulated-device',
    pattern: /\bphysical\s*\/\s*emulated devices?\b/i,
  },
  {
    id: 'physical-evidence-attached',
    pattern: /\bphysical-device evidence is attached\b/i,
  },
  {
    id: 'physical-share-hosts',
    pattern: /\bphysical-device share hosts\b/i,
  },
  {
    id: 'zh-real-device-evidence',
    pattern: /必须提供真实设备证据/u,
  },
  {
    id: 'zh-low-tier-device',
    pattern: /低(?:端|规格).{0,40}(?:设备|手机|平板)/u,
  },
  {
    id: 'zh-flagship-device',
    pattern: /旗舰.{0,40}(?:设备|手机|平板)/u,
  },
];

const argumentsList = process.argv.slice(2);
if (
  argumentsList.length > 1 ||
  (argumentsList.length === 1 && argumentsList[0] !== '--issues-stdin')
) {
  throw new Error('V01_VIRTUAL_POLICY_ARGUMENT_INVALID');
}

assertRuleSelfTests();

for (const relativePath of policyPaths) {
  assertNoStaleRequirement(
    readFileSync(join(repositoryRoot, relativePath), 'utf8'),
    relativePath,
  );
}

let issueCount = 'not-provided';
let physicalGateLabels = 'not-checked';
if (argumentsList[0] === '--issues-stdin') {
  const issues = parseIssuePayload(readFileSync(0, 'utf8'));
  const expectedNumbers = Array.from({ length: 22 }, (_, index) => index + 3);
  const v01Issues = issues
    .filter(
      issue =>
        Number.isInteger(issue?.number) &&
        issue.number >= 3 &&
        issue.number <= 24 &&
        issue.pull_request === undefined,
    )
    .sort((left, right) => left.number - right.number);
  const actualNumbers = v01Issues.map(issue => issue.number);
  if (JSON.stringify(actualNumbers) !== JSON.stringify(expectedNumbers)) {
    throw new Error('V01_VIRTUAL_POLICY_ISSUE_INVENTORY_INVALID');
  }

  physicalGateLabels = 0;
  for (const issue of v01Issues) {
    if (typeof issue.title !== 'string' || issue.title.trim().length === 0) {
      throw new Error(
        `V01_VIRTUAL_POLICY_ISSUE_TITLE_INVALID:github-issue-${issue.number}`,
      );
    }
    assertNoStaleRequirement(issue.title, `github-issue-${issue.number}-title`);
    assertNoStaleRequirement(
      String(issue.body ?? ''),
      `github-issue-${issue.number}-body`,
    );
    if (!Array.isArray(issue.labels)) {
      throw new Error(
        `V01_VIRTUAL_POLICY_ISSUE_LABELS_INVALID:github-issue-${issue.number}`,
      );
    }
    const labelNames = issue.labels.map(label =>
      typeof label === 'string' ? label : String(label?.name ?? ''),
    );
    if (labelNames.includes('test:device-required')) {
      physicalGateLabels += 1;
      throw new Error(
        `V01_VIRTUAL_POLICY_PHYSICAL_LABEL:github-issue-${issue.number}`,
      );
    }
  }
  issueCount = v01Issues.length;
}

console.info(
  `V01_VIRTUAL_POLICY files=${policyPaths.length} issues=${issueCount} physicalGateLabels=${physicalGateLabels} result=pass`,
);

function assertNoStaleRequirement(source, sourceName) {
  const lines = source.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const matchedRule = staleRequirementRules.find(rule =>
      rule.pattern.test(line),
    );
    if (matchedRule) {
      throw new Error(
        `V01_VIRTUAL_POLICY_STALE_REQUIREMENT:${sourceName}:${index + 1}:${
          matchedRule.id
        }`,
      );
    }
  }
  const normalized = source.replace(/\s+/gu, ' ');
  const normalizedRule = staleRequirementRules.find(rule =>
    rule.pattern.test(normalized),
  );
  if (normalizedRule) {
    throw new Error(
      `V01_VIRTUAL_POLICY_STALE_REQUIREMENT:${sourceName}:normalized:${normalizedRule.id}`,
    );
  }
}

function parseIssuePayload(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('V01_VIRTUAL_POLICY_ISSUE_JSON_INVALID');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('V01_VIRTUAL_POLICY_ISSUE_JSON_INVALID');
  }
  return parsed;
}

function assertRuleSelfTests() {
  const staleExamples = [
    'Benchmark on a low-end supported device and current flagship.',
    'Benchmark on a current\nflagship.',
    'Cover iOS and Android host/device variations.',
    'Attach evidence from representative physical devices.',
    'Use hardware-tier benchmark evidence.',
    'Compare hardware tiers benchmark and matrix results.',
    '必须提供真实设备证据。',
    '在低规格支持设备和当前旗舰设备上验证。',
  ];
  for (const example of staleExamples) {
    const normalized = example.replace(/\s+/gu, ' ');
    if (!staleRequirementRules.some(rule => rule.pattern.test(normalized))) {
      throw new Error('V01_VIRTUAL_POLICY_SELF_TEST_MISSED_STALE');
    }
  }

  const allowedExamples = [
    'v0.1 does not require physical hardware.',
    'The physical-device label remains available outside v0.1.',
    'Use named minimum/current Simulator and Emulator profiles.',
    'Virtual results make no physical-hardware compatibility claim.',
  ];
  for (const example of allowedExamples) {
    if (staleRequirementRules.some(rule => rule.pattern.test(example))) {
      throw new Error('V01_VIRTUAL_POLICY_SELF_TEST_REJECTED_ALLOWED');
    }
  }
}
