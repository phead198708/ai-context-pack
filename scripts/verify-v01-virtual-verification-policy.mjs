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
    id: 'physical-device-requirement-leading',
    pattern:
      /(?![^\r\n.!?。！？]{0,200}\b(?:outside (?:the )?v0\.1(?: scope)?|post[- ]v0\.1)\b)\b(?:(?<!not )(?<!never )(?:requires?|required)|must|shall)\b(?!\s+(?:not|never)\b)[^\r\n.!?。！？]{0,80}(?:\bphysical[- ]devices?\b[^\r\n.!?。！？]{0,80}\b(?:acceptance|evidence|tests?|testing|validat(?:e|ion)|verif(?:y|ication))\b|\b(?:acceptance|evidence|tests?|testing|validat(?:e|ion)|verif(?:y|ication))\b[^\r\n.!?。！？]{0,80}\bphysical[- ]devices?\b)/i,
  },
  {
    id: 'physical-device-requirement-trailing',
    pattern:
      /(?![^\r\n.!?。！？]{0,200}\b(?:outside (?:the )?v0\.1(?: scope)?|post[- ]v0\.1)\b)(?<!no )\bphysical[- ]devices?\b[^\r\n.!?。！？]{0,80}\b(?:acceptance|evidence|tests?|testing|validat(?:e|ion)|verif(?:y|ication))\b[^\r\n.!?。！？]{0,80}\b(?:(?<!not )(?<!never )(?:requires?|required)|must|shall|mandatory)\b(?!\s+(?:not|never)\b)/i,
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
assertIssueInventorySelfTests();

for (const relativePath of policyPaths) {
  assertNoStaleRequirement(
    readFileSync(join(repositoryRoot, relativePath), 'utf8'),
    relativePath,
  );
}

let issueCount = 'not-provided';
let physicalGateLabels = 'not-checked';
if (argumentsList[0] === '--issues-stdin') {
  const verification = assertIssueInventory(
    parseIssuePayload(readFileSync(0, 'utf8')),
  );
  issueCount = verification.issueCount;
  physicalGateLabels = verification.physicalGateLabels;
}

console.info(
  `V01_VIRTUAL_POLICY files=${policyPaths.length} issues=${issueCount} physicalGateLabels=${physicalGateLabels} result=pass`,
);

function assertIssueInventory(issues) {
  const expectedNumbers = Array.from({ length: 23 }, (_, index) => index + 2);
  const v01Issues = issues
    .filter(
      issue =>
        Number.isInteger(issue?.number) &&
        issue.number >= 2 &&
        issue.number <= 24 &&
        issue.pull_request === undefined,
    )
    .sort((left, right) => left.number - right.number);
  const actualNumbers = v01Issues.map(issue => issue.number);
  if (JSON.stringify(actualNumbers) !== JSON.stringify(expectedNumbers)) {
    throw new Error('V01_VIRTUAL_POLICY_ISSUE_INVENTORY_INVALID');
  }

  let matchingPhysicalGateLabels = 0;
  for (const issue of v01Issues) {
    if (typeof issue.title !== 'string' || issue.title.trim().length === 0) {
      throw new Error(
        `V01_VIRTUAL_POLICY_ISSUE_TITLE_INVALID:github-issue-${issue.number}`,
      );
    }
    if (typeof issue.body !== 'string' || issue.body.trim().length === 0) {
      throw new Error(
        `V01_VIRTUAL_POLICY_ISSUE_BODY_INVALID:github-issue-${issue.number}`,
      );
    }
    assertNoStaleRequirement(issue.title, `github-issue-${issue.number}-title`);
    assertNoStaleRequirement(issue.body, `github-issue-${issue.number}-body`);
    if (!Array.isArray(issue.labels)) {
      throw new Error(
        `V01_VIRTUAL_POLICY_ISSUE_LABELS_INVALID:github-issue-${issue.number}`,
      );
    }
    const labelNames = issue.labels.map(label => {
      const labelName = typeof label === 'string' ? label : label?.name;
      if (typeof labelName !== 'string' || labelName.trim().length === 0) {
        throw new Error(
          `V01_VIRTUAL_POLICY_ISSUE_LABEL_INVALID:github-issue-${issue.number}`,
        );
      }
      return labelName.trim();
    });
    if (labelNames.includes('test:device-required')) {
      matchingPhysicalGateLabels += 1;
      throw new Error(
        `V01_VIRTUAL_POLICY_PHYSICAL_LABEL:github-issue-${issue.number}`,
      );
    }
  }
  return {
    issueCount: v01Issues.length,
    physicalGateLabels: matchingPhysicalGateLabels,
  };
}

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
    'Requires physical-device validation evidence.',
    'Physical device evidence required.',
    'Teams must test on physical devices.',
    'Physical-device evidence must be attached.',
    'Physical-device verification is mandatory.',
    'Requires physical-device\nvalidation evidence.',
    'Physical-device validation is\nrequired.',
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
    'Post-v0.1 work may use physical-device validation evidence.',
    'Physical-device validation is not required for v0.1.',
    'v0.1 does not require physical-device testing.',
    'Use named minimum/current Simulator and Emulator profiles.',
    'Virtual results make no physical-hardware compatibility claim.',
  ];
  for (const example of allowedExamples) {
    if (staleRequirementRules.some(rule => rule.pattern.test(example))) {
      throw new Error('V01_VIRTUAL_POLICY_SELF_TEST_REJECTED_ALLOWED');
    }
  }
}

function assertIssueInventorySelfTests() {
  const syntheticIssues = Array.from({ length: 23 }, (_, index) => ({
    number: index + 2,
    title: `Synthetic v0.1 issue ${index + 2}`,
    body: 'Virtual-only verification policy.',
    labels: [],
  }));
  const verified = assertIssueInventory(syntheticIssues);
  if (verified.issueCount !== 23 || verified.physicalGateLabels !== 0) {
    throw new Error('V01_VIRTUAL_POLICY_SELF_TEST_INVENTORY_PASS_INVALID');
  }

  assertIssueInventoryFailure(
    syntheticIssues.filter(issue => issue.number !== 2),
    'V01_VIRTUAL_POLICY_ISSUE_INVENTORY_INVALID',
  );
  assertIssueInventoryFailure(
    [...syntheticIssues, syntheticIssues[0]],
    'V01_VIRTUAL_POLICY_ISSUE_INVENTORY_INVALID',
  );
  assertIssueInventoryFailure(
    syntheticIssues.map(issue =>
      issue.number === 2 ? { ...issue, body: null } : issue,
    ),
    'V01_VIRTUAL_POLICY_ISSUE_BODY_INVALID:github-issue-2',
  );
  assertIssueInventoryFailure(
    syntheticIssues.map(issue =>
      issue.number === 2 ? { ...issue, labels: [{ name: '' }] } : issue,
    ),
    'V01_VIRTUAL_POLICY_ISSUE_LABEL_INVALID:github-issue-2',
  );
  assertIssueInventoryFailure(
    syntheticIssues.map(issue =>
      issue.number === 2
        ? { ...issue, labels: ['test:device-required'] }
        : issue,
    ),
    'V01_VIRTUAL_POLICY_PHYSICAL_LABEL:github-issue-2',
  );
  assertIssueInventoryFailure(
    syntheticIssues.map(issue =>
      issue.number === 2
        ? { ...issue, title: 'Must test on physical devices.' }
        : issue,
    ),
    'V01_VIRTUAL_POLICY_STALE_REQUIREMENT:github-issue-2-title:1:physical-device-requirement-leading',
  );
  assertIssueInventoryFailure(
    syntheticIssues.map(issue =>
      issue.number === 2
        ? { ...issue, body: 'Requires physical-device validation evidence.' }
        : issue,
    ),
    'V01_VIRTUAL_POLICY_STALE_REQUIREMENT:github-issue-2-body:1:physical-device-requirement-leading',
  );
}

function assertIssueInventoryFailure(issues, expectedError) {
  try {
    assertIssueInventory(issues);
  } catch (error) {
    if (error instanceof Error && error.message === expectedError) {
      return;
    }
  }
  throw new Error('V01_VIRTUAL_POLICY_SELF_TEST_EXPECTED_FAILURE_MISSING');
}
