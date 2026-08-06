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
const requirementClauseGap = String.raw`[^\r\n!?。！？;；]{0,80}`;
const physicalDeviceTerm = String.raw`\bphysical[- ]devices?\b`;
const verificationActivityTerm = String.raw`\b(?:acceptance|evidence|tests?|testing|validat(?:e|ion)|verif(?:y|ication))\b`;
const requirementTerm = String.raw`\b(?:requires?|required|requirements?|must|shall|mandatory)\b`;
const allowancePredicateTerm = String.raw`\b(?:(?:is|are|was|were|be|remain(?:s|ed)?)\s+(?:allowed|permitted|optional)|may|can|allows?|permits?)\b`;
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
const contractedNegatedRequirement = new RegExp(
  String.raw`\b(?:(?:is|are|was|were|do|does|did|has|have|had|must|should|would|could)n['’]t|can['’]t|won['’]t|shan['’]t)\b${negatedClauseGap}(?:${requirementTerm}|${physicalDeviceActivity})`,
  'i',
);
const independentRequirement = new RegExp(requirementTerm, 'i');
const independentAllowance = new RegExp(allowancePredicateTerm, 'i');
const independentPolicyPredicate = new RegExp(
  `(?:${requirementTerm}|${allowancePredicateTerm})`,
  'i',
);
const physicalDeviceActivityMatcher = new RegExp(physicalDeviceActivity, 'i');
const outsideV01Qualifier =
  /\b(?:outside (?:of )?(?:the )?v0\.1(?: scope)?|post[- ]v0\.1)\b/iu;
const policyCoordinatorTerm = String.raw`(?:as well as|even though|nevertheless|nonetheless|however|whereas|although|while|though|because|but|yet|and|or|plus)`;
const coordinatedPolicyBoundary = new RegExp(
  `(?:[;；:：—–]\\s*|,\\s+(?:${policyCoordinatorTerm}\\s+)?|\\s+${policyCoordinatorTerm}\\s+)`,
  'giu',
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
    id: 'physical-device-requirement-interleaved',
    pattern: new RegExp(
      `(?:${verificationActivityTerm}${requirementClauseGap}${requirementTerm}${requirementClauseGap}${physicalDeviceTerm}|${physicalDeviceTerm}${requirementClauseGap}${requirementTerm}${requirementClauseGap}${verificationActivityTerm})`,
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
    .split(/\.(?=\s|$)|[!?。！？]/u)
    .map(clause => clause.trim())
    .filter(Boolean)
    .flatMap(splitCoordinatedRequirements);
}

function splitCoordinatedRequirements(clause) {
  const separators = clause.matchAll(coordinatedPolicyBoundary);
  for (const separator of separators) {
    const separatorIndex = separator.index;
    const left = clause.slice(0, separatorIndex).trim();
    const right = clause.slice(separatorIndex + separator[0].length).trim();
    const boundRight = inheritPhysicalDeviceActivity(left, right);
    const isHardBoundary = /[;；:：—–]|\b(?:but|however)\b/iu.test(
      separator[0],
    );
    const hasCoordinatedPolicies =
      hasIndependentPolicyStatement(left) &&
      hasIndependentPolicyStatement(boundRight) &&
      (hasPhysicalDeviceActivity(left) ||
        hasPhysicalDeviceActivity(boundRight));
    if (isHardBoundary || hasCoordinatedPolicies) {
      const scopedRight =
        !isHardBoundary &&
        hasLeadingOutsideV01Qualifier(left) &&
        !hasExplicitV01Scope(boundRight)
          ? `post-v0.1 ${boundRight}`
          : boundRight;
      return [
        ...splitCoordinatedRequirements(left),
        ...splitCoordinatedRequirements(scopedRight),
      ];
    }
  }
  return [clause];
}

function hasPhysicalDeviceActivity(source) {
  return physicalDeviceActivityMatcher.test(source);
}

function inheritPhysicalDeviceActivity(left, right) {
  if (
    !/^(?:(?:is|are|was|were|remain(?:s|ed)?)\b|(?:must|shall|may|can)\b|(?:required|mandatory)\b(?=\s*(?:(?:for|in|on|at|during|within|under|throughout|by|across|as part of)\b|$)))/iu.test(
      right,
    )
  ) {
    return right;
  }
  const activityMatch = physicalDeviceActivityMatcher.exec(left);
  return activityMatch === null ? right : `${activityMatch[0]} ${right}`;
}

function hasIndependentRequirement(source) {
  return independentRequirement.test(source);
}

function hasIndependentPolicyStatement(source) {
  return hasIndependentRequirement(source) || independentAllowance.test(source);
}

function hasLeadingOutsideV01Qualifier(source) {
  const outsideMatch = outsideV01Qualifier.exec(source);
  const predicateMatch = independentPolicyPredicate.exec(source);
  return (
    outsideMatch !== null &&
    predicateMatch !== null &&
    outsideMatch.index < predicateMatch.index
  );
}

function hasExplicitV01Scope(source) {
  if (outsideV01Qualifier.test(source)) {
    return true;
  }
  return hasAffirmativeV01Scope(source);
}

function hasAffirmativeV01Scope(source) {
  const requirementMatch = independentRequirement.exec(source);
  if (requirementMatch === null) {
    return false;
  }
  for (const match of source.matchAll(/\bv0\.1\b/giu)) {
    const prefix = source.slice(0, match.index);
    if (
      isOutsideV01QualifierOccurrence(prefix) ||
      isIncidentalV01Reference(prefix)
    ) {
      continue;
    }
    if (match.index < requirementMatch.index) {
      const beforeRequirement = source.slice(
        match.index + match[0].length,
        requirementMatch.index,
      );
      if (hasLeadingTargetV01ScopePrefix(prefix)) {
        return true;
      }
      if (outsideV01Qualifier.test(beforeRequirement)) {
        continue;
      }
      if (
        hasPhysicalDeviceActivity(beforeRequirement) ||
        !isContextualV01Subject(beforeRequirement)
      ) {
        return true;
      }
      continue;
    }
    const afterRequirement = source.slice(
      requirementMatch.index + requirementMatch[0].length,
      match.index,
    );
    if (
      hasDirectTargetV01Scope(afterRequirement) ||
      hasTargetV01VerbPrefix(afterRequirement) ||
      hasDirectV01Qualifier(afterRequirement)
    ) {
      return true;
    }
  }
  return false;
}

function isIncidentalV01Reference(prefix) {
  return (
    /\bfrom\b(?:(?!\bto\b)[^\r\n.!?。！？;；]){0,48}$/iu.test(prefix) ||
    /\b(?:(?:compare(?:d|s|ing)?|comparison)\s+(?:against|with|to)|against|versus|vs\.?|unlike|relative to|based on|because|since|given that|reference(?:d|s|ing)?(?:\s+(?:against|to))?)\s+(?:the\s+)?$/iu.test(
      prefix,
    )
  );
}

function isContextualV01Subject(suffix) {
  return /^\s*(?:(?:baseline|context|comparison|reference|source|lacks?|does(?:n['’]t| not)|cannot|can['’]t)\b|(?:is|was|remains?|serves?|served)\s+(?:the\s+)?(?:baseline|context|comparison|reference|source)\b)/iu.test(
    suffix,
  );
}

function hasLeadingTargetV01ScopePrefix(prefix) {
  return /(?:^|[.!?。！？;；:：—–]\s*|,\s*)\b(?:for|in|on|at|during|within|under|throughout|by|across|before|through|as part of)\s+(?:(?:all|the|a|our|version|release|target|stable|current|production)\s+){0,5}$/iu.test(
    prefix,
  );
}

function hasDirectTargetV01Scope(afterRequirement) {
  const scopeMatch =
    /\b(?:for|in|on|at|during|within|under|throughout|by|across|before|through|as part of)\b(?<modifier>[^\r\n.!?。！？;；:：—–]{0,48})$/iu.exec(
      afterRequirement,
    );
  if (
    scopeMatch === null ||
    !isNaturalVersionModifier(scopeMatch.groups?.modifier ?? '')
  ) {
    return false;
  }
  const predicatePrefix = afterRequirement.slice(0, scopeMatch.index);
  if (predicatePrefix.trim().length === 0) {
    return true;
  }
  if (
    /\b(?:because|since|given that|compare(?:d|s|ing)?|comparison|against|versus|vs\.?|relative to|reference(?:d|s|ing)?|baseline|behavior|failed|lacks?)\b/iu.test(
      predicatePrefix,
    )
  ) {
    return false;
  }
  return isScopeBoundToRequirementPredicate(predicatePrefix);
}

function hasDirectV01Qualifier(afterRequirement) {
  const normalized = afterRequirement.trim();
  return isNaturalVersionModifier(normalized);
}

function isNaturalVersionModifier(source) {
  const normalized = source.trim();
  return (
    normalized.length <= 48 &&
    !/\b(?:against|as|at|because|before|behavior|by|compare(?:d|s|ing)?|comparison|during|for|from|given|in|on|reference|relative|since|through|throughout|to|under|versus|via|while|with|within)\b|[,:：—–]/iu.test(
      normalized,
    )
  );
}

function isScopeBoundToRequirementPredicate(predicatePrefix) {
  if (predicatePrefix.trim().length === 0) {
    return true;
  }
  if (isSimpleTargetActionPhrase(predicatePrefix)) {
    return true;
  }
  const activityMatch = physicalDeviceActivityMatcher.exec(predicatePrefix);
  if (activityMatch === null) {
    return false;
  }
  const remainder = `${predicatePrefix.slice(
    0,
    activityMatch.index,
  )} ${predicatePrefix.slice(activityMatch.index + activityMatch[0].length)}`;
  return remainder.trim().length === 0 || isSimpleTargetActionPhrase(remainder);
}

function hasTargetV01VerbPrefix(prefix) {
  const actionMatch =
    /\b(?:ship(?:s|ped|ping)?|validat(?:e|es|ed|ing)|support(?:s|ed|ing)?|releas(?:e|es|ed|ing)|deliver(?:s|ed|ing)?|publish(?:es|ed|ing)?|deploy(?:s|ed|ing)?|launch(?:es|ed|ing)?|test(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|certif(?:y|ies|ied|ying)|accept(?:s|ed|ing)?|build(?:s|ing)?|submit(?:s|ted|ting)?|distribut(?:e|es|ed|ing)|enable(?:s|d|ing)?|target(?:s|ed|ing)?)\b(?<suffix>[^\r\n.!?。！？;；:：—–]{0,48})$/iu.exec(
      prefix,
    );
  if (
    actionMatch !== null &&
    isNaturalTargetModifier(actionMatch.groups?.suffix ?? '')
  ) {
    return true;
  }
  return /\b(?:migration|migrat(?:e|es|ed|ing)|upgrade|upgrad(?:e|es|ed|ing)|port(?:s|ed|ing)?|transition(?:s|ed|ing)?|mov(?:e|es|ed|ing))\b[^\r\n.!?。！？;；:：—–]{0,48}\bto\b[^\r\n.!?。！？;；:：—–]{0,48}$/iu.test(
    prefix,
  );
}

function isNaturalTargetModifier(source) {
  const normalized = source.trim().replace(/^to\s+/iu, '');
  return !/\b(?:against|as|at|because|before|behavior|by|compare(?:d|s|ing)?|comparison|during|for|from|given|in|on|reference|relative|since|through|throughout|to|under|versus|via|while|with|within)\b|[,:：—–]/iu.test(
    normalized,
  );
}

function isSimpleTargetActionPhrase(source) {
  return /^\s*(?:to\s+)?(?:ship(?:s|ped|ping)?|validat(?:e|es|ed|ing)|support(?:s|ed|ing)?|releas(?:e|es|ed|ing)|deliver(?:s|ed|ing)?|publish(?:es|ed|ing)?|deploy(?:s|ed|ing)?|launch(?:es|ed|ing)?|test(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|certif(?:y|ies|ied|ying)|accept(?:s|ed|ing)?|build(?:s|ing)?|submit(?:s|ted|ting)?|distribut(?:e|es|ed|ing)|enable(?:s|d|ing)?|target(?:s|ed|ing)?)\s*$/iu.test(
    source,
  );
}

function isOutsideV01QualifierOccurrence(prefix) {
  return /\b(?:post[- ]|outside (?:of )?(?:the )?)$/iu.test(prefix);
}

function isExplicitlyOutsideV01(clause) {
  return outsideV01Qualifier.test(clause) && !hasAffirmativeV01Scope(clause);
}

function isExplicitlyNegatedRequirement(clause) {
  return (
    modalNegatedRequirement.test(clause) ||
    auxiliaryNegatedRequirement.test(clause) ||
    noLongerRequirement.test(clause) ||
    directNotRequirement.test(clause) ||
    contractedNegatedRequirement.test(clause) ||
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
    'Physical-device validation is a requirement for v0.1.',
    'Physical-device validation remains one of the requirements for v0.1.',
    'Validation on physical devices is required.',
    'Validation is required on physical devices.',
    'Physical devices are required for validation.',
    'Testing must occur on physical devices.',
    'Post-v0.1 work requires physical-device evidence, but v0.1 requires physical-device testing.',
    'Physical-device testing is not required, but physical-device evidence is required.',
    'Physical-device testing is not required: physical-device evidence is required for v0.1.',
    'Physical-device testing is not required — physical-device evidence is required for v0.1.',
    'Physical-device testing is not required because physical-device evidence is required for v0.1.',
    'Physical-device testing is optional because physical-device evidence is a requirement for v0.1.',
    'Outside v0.1, testing on physical devices is required, and v0.1 physical-device evidence is required.',
    'Physical-device testing is not required for post-v0.1 work, and physical-device evidence is required for v0.1.',
    'Post-v0.1 documentation is required, and v0.1 physical-device testing is required.',
    'Post-v0.1 documentation is required, and physical-device testing for v0.1 migration is required.',
    'Physical-device testing is required for v0.1 to compare post-v0.1 behavior.',
    'Physical-device testing must not fail and is required.',
    'Physical-device testing is allowed outside v0.1. V0.1 requires physical-device testing.',
    'Physical-device testing is allowed outside v0.1 and physical-device evidence is required.',
    'Documentation is allowed outside v0.1 and physical-device evidence is required.',
    'Physical-device testing may occur outside v0.1 and physical-device evidence is required.',
    'Physical-device testing is allowed outside v0.1 while physical-device evidence is required.',
    'Physical-device testing is allowed outside v0.1 whereas physical-device evidence is required.',
    'Physical-device testing is allowed outside v0.1 yet physical-device evidence is required.',
    'Physical-device testing is required to ship v0.1 and compare post-v0.1 behavior.',
    'Physical-device testing is required to validate v0.1 and compare post-v0.1 behavior.',
    'Physical-device testing is required to support v0.1 and compare post-v0.1 behavior.',
    'Physical-device testing is required to ship the stable v0.1 release and compare post-v0.1 behavior.',
    'Physical-device testing is required to ship our production-ready stable v0.1 release.',
    'Physical-device testing is required in the long-term-supported v0.1 release.',
    'Physical-device testing is required for post-v0.1 migration to the stable v0.1 release.',
    'Physical-device testing is required for post-v0.1 migration to the long-term-supported stable v0.1 release.',
    'Physical-device testing is required while offline.',
    'Physical-device testing or validation is required.',
    'Physical-device testing is not required for post-v0.1 but is required for v0.1.',
    'Physical-device testing is allowed outside v0.1; is required for v0.1.',
    'Post-v0.1 notes apply; physical-device testing is required.',
    'Physical-device testing is not required for post-v0.1 work, and physical-device evidence is required.',
    'Requires physical-device\nvalidation evidence.',
    'Physical-device validation is\nrequired.',
    '必须提供真实设备证据。',
    '在低规格支持设备和当前旗舰设备上验证。',
  ];
  for (const [index, example] of staleExamples.entries()) {
    const normalized = example.replace(/\s+/gu, ' ');
    if (!findMatchedRule(normalized)) {
      throw new Error(`V01_VIRTUAL_POLICY_SELF_TEST_MISSED_STALE:${index}`);
    }
  }

  const allowedExamples = [
    'v0.1 does not require physical hardware.',
    'The physical-device label remains available outside v0.1.',
    'Post-v0.1 work may use physical-device validation evidence.',
    'Post-v0.1 work requires physical-device validation evidence.',
    'Outside v0.1, teams must test on physical devices.',
    'Physical-device validation is not required for v0.1.',
    'Physical-device validation is not a requirement for v0.1.',
    'No requirements for physical-device validation apply to v0.1.',
    'Physical-device testing must not be required for v0.1.',
    'Physical-device testing is no longer required for v0.1.',
    'Physical-device testing not required for v0.1.',
    "Physical-device testing isn't required for v0.1.",
    'Physical-device testing isn’t required for v0.1.',
    "v0.1 doesn't require testing on physical devices.",
    'v0.1 doesn’t require testing on physical devices.',
    'Post-v0.1 documentation is required, and post-v0.1 physical-device testing is required.',
    'Post-v0.1, documentation is required, and physical-device testing is required.',
    'Outside v0.1, documentation is required, and physical-device testing is required.',
    'Post-v0.1, documentation is required, and physical-device testing is required to validate migration from v0.1.',
    'Post-v0.1, documentation is allowed, and physical-device testing is required.',
    'Post-v0.1, physical-device testing is allowed, and physical-device evidence is required.',
    'Post-v0.1, physical-device testing is allowed, and is required.',
    'Post-v0.1, documentation is allowed while physical-device testing is required.',
    'Post-v0.1, physical-device testing or validation is required.',
    'Physical-device testing is required for post-v0.1 work to compare migration from v0.1.',
    'Physical-device testing is required for post-v0.1 work to compare against v0.1.',
    'Post-v0.1 work requires physical-device testing because v0.1 lacks this capability.',
    'Post-v0.1 work requires physical-device testing to compare behavior in v0.1.',
    'Post-v0.1 work requires physical-device testing to compare behavior in the stable v0.1 release.',
    'Post-v0.1 work requires physical-device testing to observe failures during the stable v0.1 release.',
    'Because validation failed in v0.1, post-v0.1 work requires physical-device testing.',
    'Because validation failed in the stable v0.1 release, post-v0.1 work requires physical-device testing.',
    'Post-v0.1 work requires physical-device testing for migration from the v0.1 release.',
    'Compared with v0.1, post-v0.1 work requires physical-device testing.',
    'The v0.1 baseline is incomplete, so post-v0.1 work requires physical-device testing.',
    'No physical-device evidence is required for v0.1.',
    'No validation on physical devices is required for v0.1.',
    'v0.1 does not require physical-device testing.',
    'Use named minimum/current Simulator and Emulator profiles.',
    'Virtual results make no physical-hardware compatibility claim.',
  ];
  for (const [index, example] of allowedExamples.entries()) {
    if (findMatchedRule(example)) {
      throw new Error(`V01_VIRTUAL_POLICY_SELF_TEST_REJECTED_ALLOWED:${index}`);
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
