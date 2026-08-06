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
const requirementClauseGap = String.raw`[^\r\n.!?。！？;；]{0,80}`;
const physicalDeviceTerm = String.raw`\bphysical[- ]devices?\b`;
const verificationActivityTerm = String.raw`\b(?:acceptance|evidence|tests?|testing|validat(?:e|ion)|verif(?:y|ication))\b`;
const requirementTerm = String.raw`\b(?:requires?|required|must|shall|mandatory)\b`;
const physicalDeviceActivity = String.raw`(?:${physicalDeviceTerm}${requirementClauseGap}${verificationActivityTerm}|${verificationActivityTerm}${requirementClauseGap}${physicalDeviceTerm})`;
const explicitlyAbsentPhysicalDeviceActivity = new RegExp(
  String.raw`\bno\b${requirementClauseGap}${physicalDeviceActivity}`,
  'i',
);
const negatedClauseGap = String.raw`(?:(?!\band\b)[^\r\n.!?。！？;；]){0,80}`;
const modalNegatedRequirement = new RegExp(
  String.raw`\b(?:must|shall|should|will|would|can|could)\s+(?:not|never)\b${negatedClauseGap}(?:${requirementTerm}|${physicalDeviceActivity})`,
  'i',
);
const auxiliaryNegatedRequirement = new RegExp(
  String.raw`\b(?:does?|do|is|are|was|were|has|have|had)\s+(?:not|never)\b${negatedClauseGap}${requirementTerm}`,
  'i',
);
const noLongerRequirement = new RegExp(
  String.raw`\b(?:is|are|was|were)\s+no longer\b${negatedClauseGap}${requirementTerm}`,
  'i',
);
const directNotRequirement = new RegExp(
  String.raw`\bnot\b${negatedClauseGap}${requirementTerm}`,
  'i',
);
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
    pattern: new RegExp(
      `${requirementTerm}${requirementClauseGap}${physicalDeviceActivity}`,
      'i',
    ),
    allowsExplicitScopeOrNegation: true,
  },
  {
    id: 'physical-device-requirement-trailing',
    pattern: new RegExp(
      `${physicalDeviceActivity}${requirementClauseGap}${requirementTerm}`,
      'i',
    ),
    allowsExplicitScopeOrNegation: true,
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
    const matchedRule = findMatchedRule(line);
    if (matchedRule) {
      throw new Error(
        `V01_VIRTUAL_POLICY_STALE_REQUIREMENT:${sourceName}:${index + 1}:${
          matchedRule.id
        }`,
      );
    }
  }
  const normalized = source.replace(/\s+/gu, ' ');
  const normalizedRule = findMatchedRule(normalized);
  if (normalizedRule) {
    throw new Error(
      `V01_VIRTUAL_POLICY_STALE_REQUIREMENT:${sourceName}:normalized:${normalizedRule.id}`,
    );
  }
}

function findMatchedRule(source) {
  for (const clause of splitRequirementClauses(source)) {
    for (const rule of staleRequirementRules) {
      if (!rule.pattern.test(clause)) {
        continue;
      }
      if (
        rule.allowsExplicitScopeOrNegation &&
        (isExplicitlyOutsideV01(clause) ||
          isExplicitlyNegatedRequirement(clause))
      ) {
        continue;
      }
      return rule;
    }
  }
  return undefined;
}

function splitRequirementClauses(source) {
  return source
    .split(/\.(?=\s|$)|[!?。！？;；]|\b(?:but|however)\b/iu)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function isExplicitlyOutsideV01(clause) {
  return /\b(?:outside (?:of )?(?:the )?v0\.1(?: scope)?|post[- ]v0\.1)\b/iu.test(
    clause,
  );
}

function isExplicitlyNegatedRequirement(clause) {
  return (
    modalNegatedRequirement.test(clause) ||
    auxiliaryNegatedRequirement.test(clause) ||
    noLongerRequirement.test(clause) ||
    directNotRequirement.test(clause) ||
    explicitlyAbsentPhysicalDeviceActivity.test(clause)
  );
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
    'Validation on physical devices is required.',
    'Post-v0.1 work requires physical-device evidence, but v0.1 requires physical-device testing.',
    'Physical-device testing is not required, but physical-device evidence is required.',
    'Physical-device testing must not fail and is required.',
    'Physical-device testing is allowed outside v0.1. V0.1 requires physical-device testing.',
    'Requires physical-device\nvalidation evidence.',
    'Physical-device validation is\nrequired.',
    '必须提供真实设备证据。',
    '在低规格支持设备和当前旗舰设备上验证。',
  ];
  for (const example of staleExamples) {
    const normalized = example.replace(/\s+/gu, ' ');
    if (!findMatchedRule(normalized)) {
      throw new Error('V01_VIRTUAL_POLICY_SELF_TEST_MISSED_STALE');
    }
  }

  const allowedExamples = [
    'v0.1 does not require physical hardware.',
    'The physical-device label remains available outside v0.1.',
    'Post-v0.1 work may use physical-device validation evidence.',
    'Post-v0.1 work requires physical-device validation evidence.',
    'Outside v0.1, teams must test on physical devices.',
    'Physical-device validation is not required for v0.1.',
    'Physical-device testing must not be required for v0.1.',
    'Physical-device testing is no longer required for v0.1.',
    'Physical-device testing not required for v0.1.',
    'No physical-device evidence is required for v0.1.',
    'No validation on physical devices is required for v0.1.',
    'v0.1 does not require physical-device testing.',
    'Use named minimum/current Simulator and Emulator profiles.',
    'Virtual results make no physical-hardware compatibility claim.',
  ];
  for (const example of allowedExamples) {
    if (findMatchedRule(example)) {
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
