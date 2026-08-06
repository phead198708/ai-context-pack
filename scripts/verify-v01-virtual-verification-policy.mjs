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
const requirementTerm = String.raw`\b(?:requires?|required|must(?:n['’]t)?|shall|mandatory)\b`;
const nounRequirementTerm = String.raw`\brequirements?\b`;
const policyRequirementTerm = String.raw`(?:${requirementTerm}|${nounRequirementTerm})`;
const allowancePredicateTerm = String.raw`\b(?:(?:is|are|was|were|be|remain(?:s|ed)?)\s+(?:allowed|permitted|optional)|may|can|allows?|permits?)\b`;
const physicalDeviceActivity = String.raw`(?:${physicalDeviceTerm}${requirementClauseGap}${verificationActivityTerm}|${verificationActivityTerm}${requirementClauseGap}${physicalDeviceTerm})`;
const explicitlyAbsentPhysicalDeviceActivity = new RegExp(
  String.raw`\bno\b${requirementClauseGap}${physicalDeviceActivity}`,
  'i',
);
const negatedClauseGap = String.raw`(?:(?!\band\b|${policyRequirementTerm})[^\r\n.!?。！？;；]){0,80}`;
const boundedModalModifier = String.raw`(?:(?:actually|again|always|automatically|ever|explicitly|independently|necessarily|normally|ordinarily|otherwise|still)\s+){0,3}`;
const modalNegatedComplement = String.raw`(?:${physicalDeviceActivity}|(?:be|become|remain)\s+(?:(?:a|an|the)\s+)?(?:required|mandatory|requirements?)|(?:require|mandate|perform|provide|collect)\s+${physicalDeviceActivity}|(?:be\s+)?(?:accepted|classified|counted|described|reported|represented|treated)\s+as\s+${physicalDeviceActivity})`;
const modalNegatedRequirement = new RegExp(
  String.raw`\b(?:must|shall|should|will|would|can|could)\s+(?:not|never)\s+${boundedModalModifier}${modalNegatedComplement}`,
  'i',
);
const auxiliaryNegatedRequirement = new RegExp(
  String.raw`\b(?:does?|do|is|are|was|were|has|have|had)\s+(?:not|never)\b${negatedClauseGap}${policyRequirementTerm}`,
  'i',
);
const noLongerRequirement = new RegExp(
  String.raw`\b(?:is|are|was|were)\s+no longer\b${negatedClauseGap}${policyRequirementTerm}`,
  'i',
);
const directNotRequirement = new RegExp(
  String.raw`\bnot\b${negatedClauseGap}${policyRequirementTerm}`,
  'i',
);
const contractedAuxiliaryNegatedRequirement = new RegExp(
  String.raw`\b(?:is|are|was|were|do|does|did|has|have|had)n['’]t\b${negatedClauseGap}${policyRequirementTerm}`,
  'i',
);
const contractedModalNegatedRequirement = new RegExp(
  String.raw`\b(?:(?:must|should|would|could)n['’]t|can['’]t|won['’]t|shan['’]t)\s+${boundedModalModifier}${modalNegatedComplement}`,
  'i',
);
const independentRequirement = new RegExp(requirementTerm, 'i');
const independentAllowance = new RegExp(allowancePredicateTerm, 'i');
const independentPolicyPredicate = new RegExp(
  `(?:${policyRequirementTerm}|${allowancePredicateTerm})`,
  'i',
);
const physicalDeviceActivityMatcher = new RegExp(physicalDeviceActivity, 'i');
const requirementToActivityBoundary =
  /\b(?:after|although|because|before|even\s+if|if|once|since|though|unless|until|when(?:ever)?|whereas|while)\b/iu;
const activityFiniteFunctionalPredicate = String.raw`\b(?:am|are|can(?:not)?|could|did|do|does|had|has|have|is|may|might|must|shall|should|was|were|will|would)\b`;
const activityFiniteLexicalShape = String.raw`\b\p{L}{2,}(?:ed|s)\b`;
const activityFinitePredicate = new RegExp(
  `(?:${activityFiniteFunctionalPredicate}|${activityFiniteLexicalShape})`,
  'iu',
);
const activityAuxiliaryOrModal = new RegExp(
  `^${activityFiniteFunctionalPredicate}$`,
  'iu',
);
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
    id: 'physical-device-noun-requirement-leading',
    pattern: new RegExp(
      `${nounRequirementTerm}\\s*(?::|：|—|–|-|\\b(?:for|of|covering)\\b|\\bto\\s+(?:perform|provide|collect)\\b|\\bto\\b(?=\\s+(?:test|validate|verify)\\b))${requirementClauseGap}${physicalDeviceActivity}`,
      'i',
    ),
    allowsExplicitScopeOrNegation: true,
  },
  {
    id: 'physical-device-noun-requirement-trailing',
    pattern: new RegExp(
      `${physicalDeviceActivity}(?:\\s+${nounRequirementTerm}|\\s+\\b(?:is|are|was|were|be|becomes?|became|remains?|remained|constitutes?|constituted|forms?|formed|counts?|counted)\\b${requirementClauseGap}${nounRequirementTerm})`,
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
  const contextualLines = [];
  let activeOutsideScopeHeading;
  for (const [index, line] of lines.entries()) {
    const outsideScopeHeading = findOutsideV01ScopeHeading(line);
    if (outsideScopeHeading !== undefined) {
      activeOutsideScopeHeading = outsideScopeHeading;
      continue;
    }
    if (line.trim().length === 0) {
      continue;
    }
    const isMarkdownListItem = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line);
    if (/^\s*(?:>\s*)?#{1,6}\s+/u.test(line)) {
      activeOutsideScopeHeading = undefined;
    }
    const contextualLine =
      activeOutsideScopeHeading === undefined
        ? stripMarkdownListMarker(line)
        : `${activeOutsideScopeHeading}: ${stripMarkdownListMarker(line)}`;
    contextualLines.push(contextualLine);
    const matchedRule = findMatchedRule(contextualLine);
    if (matchedRule) {
      throw new Error(
        `V01_VIRTUAL_POLICY_STALE_REQUIREMENT:${sourceName}:${index + 1}:${
          matchedRule.id
        }`,
      );
    }
    if (!isMarkdownListItem) {
      activeOutsideScopeHeading = undefined;
    }
  }
  const normalized = contextualLines.join(' ').replace(/\s+/gu, ' ');
  const normalizedRule = findMatchedRule(normalized);
  if (normalizedRule) {
    throw new Error(
      `V01_VIRTUAL_POLICY_STALE_REQUIREMENT:${sourceName}:normalized:${normalizedRule.id}`,
    );
  }
}

function findOutsideV01ScopeHeading(source) {
  const heading = source
    .trim()
    .replace(/^(?:>\s*)?(?:#{1,6}\s+)?/u, '')
    .replace(/\s*[:：—–]\s*$/u, '')
    .trim();
  return isOutsideV01ScopeOnlyHeading(heading) ? heading : undefined;
}

function stripMarkdownListMarker(source) {
  return source.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '').trim();
}

function findMatchedRule(source) {
  for (const clause of splitRequirementClauses(source)) {
    for (const rule of staleRequirementRules) {
      const ruleMatch = rule.pattern.exec(clause);
      if (ruleMatch === null) {
        continue;
      }
      if (
        rule.allowsExplicitScopeOrNegation &&
        !isRequirementBoundToPhysicalActivity(clause, ruleMatch)
      ) {
        continue;
      }
      if (
        rule.allowsExplicitScopeOrNegation &&
        (isExplicitlyOutsideV01(clause, ruleMatch) ||
          isExplicitlyNegatedRequirement(clause, ruleMatch))
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
      const scopeOnlyHeading = isOutsideV01ScopeOnlyHeading(left);
      const scopedRight =
        ((!isHardBoundary && hasLeadingOutsideV01Qualifier(left)) ||
          scopeOnlyHeading) &&
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

function hasIndependentPolicyStatement(source) {
  return Array.from(
    source.matchAll(new RegExp(independentPolicyPredicate.source, 'giu')),
  ).some(predicate => !isInsideAttachedPolicyModifier(source, predicate.index));
}

function isInsideAttachedPolicyModifier(source, predicateIndex) {
  const prefix = source.slice(0, predicateIndex);
  return (
    /\b(?:that|which|who|whose)\b[^,;；:：—–]{0,80}$/iu.test(prefix) ||
    /\bto\b[^,;；:：—–]{0,48}$/iu.test(prefix)
  );
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

function isOutsideV01ScopeOnlyHeading(source) {
  const normalizedSource = source
    .trim()
    .replace(/^(?:>\s*)?(?:#{1,6}\s+)?/u, '');
  if (
    hasPhysicalDeviceActivity(normalizedSource) ||
    independentRequirement.test(normalizedSource) ||
    independentAllowance.test(normalizedSource)
  ) {
    return false;
  }
  const scopeNoun =
    '(?:activities|items|milestone|phase|planning|release|requirements?|roadmap|scope|tasks|verification|work)';
  const outsideScope =
    '(?:outside (?:of )?(?:the )?v0\\.1(?: scope)?|post[- ]v0\\.1)';
  return new RegExp(
    `^\\s*(?:for\\s+(?:the\\s+)?)?(?:${outsideScope}(?:\\s+${scopeNoun})?|${scopeNoun}\\s+${outsideScope})\\s*$`,
    'iu',
  ).test(normalizedSource);
}

function hasExplicitV01Scope(source) {
  if (outsideV01Qualifier.test(source)) {
    return true;
  }
  return hasAffirmativeV01Scope(source);
}

function hasAffirmativeV01Scope(source, matchedRule) {
  const requirementMatch =
    findMatchedRequirement(source, matchedRule) ??
    independentRequirement.exec(source);
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
        hasTargetV01VerbPrefix(prefix) ||
        isV01BoundToFollowingRequirement(beforeRequirement)
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

function isV01BoundToFollowingRequirement(beforeRequirement) {
  const normalized = beforeRequirement.trim();
  if (normalized.length === 0) {
    return true;
  }
  if (isContextualV01Subject(beforeRequirement)) {
    return false;
  }
  const activityMatch = physicalDeviceActivityMatcher.exec(beforeRequirement);
  if (activityMatch === null) {
    return isSimpleV01PredicatePrefix(normalized);
  }
  const beforeActivity = beforeRequirement.slice(0, activityMatch.index).trim();
  const afterActivity = beforeRequirement
    .slice(activityMatch.index + activityMatch[0].length)
    .trim();
  return (
    isSimpleV01PredicatePrefix(beforeActivity) &&
    /^(?:(?:is|are|was|were|be|becomes?|became|remains?|remained|has|have|had)\s*)?$/iu.test(
      afterActivity,
    )
  );
}

function isSimpleV01PredicatePrefix(source) {
  if (source.length === 0) {
    return true;
  }
  if (source.length > 64 || /[,;；:：—–]/u.test(source)) {
    return false;
  }
  if (
    new RegExp(policyRequirementTerm, 'iu').test(source) ||
    /\b(?:although|because|documents?|explains?|notes?|states?|that|though|whereas|which|while|why)\b/iu.test(
      source,
    )
  ) {
    return false;
  }
  return source.split(/\s+/u).length <= 5;
}

function findMatchedRequirement(source, matchedRule) {
  const activity = findMatchedPhysicalActivity(matchedRule);
  if (activity === undefined) {
    return undefined;
  }
  const candidates = Array.from(
    source.matchAll(new RegExp(policyRequirementTerm, 'giu')),
  );
  return candidates.reduce((closest, candidate) => {
    if (candidate.index === undefined) {
      return closest;
    }
    const candidateEnd = candidate.index + candidate[0].length;
    const distance =
      candidateEnd < activity.index
        ? activity.index - candidateEnd
        : candidate.index > activity.index + activity[0].length
        ? candidate.index - (activity.index + activity[0].length)
        : 0;
    if (
      distance > 80 ||
      (closest !== undefined && closest.distance <= distance)
    ) {
      return closest;
    }
    return {
      0: candidate[0],
      index: candidate.index,
      distance,
    };
  }, undefined);
}

function findMatchedPhysicalActivity(matchedRule) {
  if (matchedRule === undefined) {
    return undefined;
  }
  const relativeActivity = physicalDeviceActivityMatcher.exec(matchedRule[0]);
  if (relativeActivity === null) {
    return undefined;
  }
  return {
    0: relativeActivity[0],
    index: matchedRule.index + relativeActivity.index,
  };
}

function isRequirementBoundToPhysicalActivity(source, matchedRule) {
  const requirement = findMatchedRequirement(source, matchedRule);
  const activity = findMatchedPhysicalActivity(matchedRule);
  if (requirement === undefined || activity === undefined) {
    return false;
  }
  const requirementEnd = requirement.index + requirement[0].length;
  const activityEnd = activity.index + activity[0].length;
  if (requirement.index < activityEnd && requirementEnd > activity.index) {
    return true;
  }
  if (requirementEnd <= activity.index) {
    const between = source.slice(requirementEnd, activity.index);
    if (!requirementToActivityBoundary.test(between)) {
      return true;
    }
    return !(
      hasIndependentActivityPredicate(source.slice(activityEnd), activity[0]) &&
      isPhysicalActivityExplicitlyOutsideV01(source, activity)
    );
  }
  const between = source.slice(activityEnd, requirement.index);
  const boundary = requirementToActivityBoundary.exec(between);
  if (boundary === null) {
    return true;
  }
  if (hasCoordinatedSharedActivitySubject(between, boundary)) {
    return true;
  }
  return !(
    hasIndependentActivityPredicate(
      between.slice(0, boundary.index),
      activity[0],
    ) && isPhysicalActivityExplicitlyOutsideV01(source, activity)
  );
}

function hasCoordinatedSharedActivitySubject(source, boundary) {
  const afterBoundary = source.slice(boundary.index + boundary[0].length);
  return /\b(?:and|but|or|yet)\s+(?:(?:am|are|be|becomes?|is|remains?|was|were)\s*)?$/iu.test(
    afterBoundary,
  );
}

function isPhysicalActivityExplicitlyOutsideV01(source, activity) {
  const prefix = source.slice(0, activity.index);
  const qualifiers = Array.from(
    prefix.matchAll(new RegExp(outsideV01Qualifier.source, 'giu')),
  );
  const qualifier = qualifiers.at(-1);
  if (qualifier === undefined) {
    return false;
  }
  const betweenQualifierAndActivity = prefix.slice(
    qualifier.index + qualifier[0].length,
  );
  return (
    betweenQualifierAndActivity.length <= 64 &&
    !new RegExp(policyRequirementTerm, 'iu').test(betweenQualifierAndActivity)
  );
}

function hasIndependentActivityPredicate(source, activitySource) {
  let predicate = source.trim();

  // Comma-delimited relative and conditional material modifies the activity;
  // only a predicate that resumes after that material can sever the binding.
  const delimitedModifier =
    /^,?\s*(?:although|as|even\s+if|if|though|when(?:ever)?|whereas|which|while|who|whose)\b[^,\r\n]{0,80},\s*/iu;
  while (delimitedModifier.test(predicate)) {
    predicate = predicate.replace(delimitedModifier, '').trim();
  }
  predicate = predicate.replace(/^,\s*/u, '').trim();
  predicate = predicate
    .replace(
      /^(?:(?:also|always|currently|eventually|generally|later|never|normally|now|occasionally|often|previously|rarely|sometimes|soon|still|then|typically|usually|\p{L}+ly)\s+){1,3}/iu,
      '',
    )
    .trim();
  if (predicate.length === 0) {
    return false;
  }

  predicate = consumeLeadingAttachedActivityModifier(predicate);
  if (predicate.length === 0) {
    return false;
  }

  // Prepositional and subordinate material without a resumed predicate remains
  // attached to the physical activity rather than severing its requirement.
  if (
    /^(?:after|although|as|at|before|because|by|during|for|from|if|in|of|on|once|since|though|under|unless|until|when(?:ever)?|whereas|while|with|without|within)\b/iu.test(
      predicate,
    )
  ) {
    return false;
  }

  if (new RegExp(`^${activityFinitePredicate.source}`, 'iu').test(predicate)) {
    return true;
  }
  return (
    /\btests\b/iu.test(activitySource) &&
    /^(?!\p{L}+(?:ing|tion|ment|ness|ity|ics|ence|ance|al|ure)\b)\p{L}{2,}\b/iu.test(
      predicate,
    )
  );
}

function consumeLeadingAttachedActivityModifier(source) {
  const reducedRelative =
    /^(?<participle>\p{L}+(?<!e)ed)\b(?<remainder>[\s\S]*)$/iu.exec(source);
  if (reducedRelative !== null) {
    const remainder = reducedRelative.groups?.remainder ?? '';
    const resumedPredicate = activityFinitePredicate.exec(remainder);
    if (resumedPredicate === null) {
      return '';
    }
    const beforeResumedPredicate = remainder.slice(0, resumedPredicate.index);
    return /\b(?:and|or|plus|as well as)\b/iu.test(beforeResumedPredicate)
      ? ''
      : remainder.slice(resumedPredicate.index).trim();
  }
  if (!/^(?:that|to|which|who|whose)\b/iu.test(source)) {
    return source;
  }
  const infinitive = /^to\s+\p{L}+(?<remainder>[\s\S]*)$/iu.exec(source);
  if (infinitive !== null) {
    const remainder = infinitive.groups?.remainder ?? '';
    const resumedPredicate = activityFinitePredicate.exec(remainder);
    if (resumedPredicate === null) {
      return '';
    }
    const beforeResumedPredicate = remainder.slice(0, resumedPredicate.index);
    return /\b(?:and|or|plus|as well as)\b/iu.test(beforeResumedPredicate)
      ? ''
      : remainder.slice(resumedPredicate.index).trim();
  }
  const predicates = Array.from(
    source.matchAll(new RegExp(activityFinitePredicate.source, 'giu')),
  );
  if (predicates.length < 2) {
    return '';
  }
  const attachedPredicate = predicates[0];
  let resumedPredicateIndex = 1;
  const auxiliaryComplement = predicates[1];
  if (activityAuxiliaryOrModal.test(attachedPredicate[0])) {
    const betweenAuxiliaryAndComplement = source.slice(
      attachedPredicate.index + attachedPredicate[0].length,
      auxiliaryComplement.index,
    );
    if (
      /^\s*(?:(?:not|never|\p{L}+ly)\s+){0,3}$/iu.test(
        betweenAuxiliaryAndComplement,
      )
    ) {
      resumedPredicateIndex += 1;
    }
  }
  for (const resumedPredicate of predicates.slice(resumedPredicateIndex)) {
    const betweenPredicates = source.slice(
      attachedPredicate.index + attachedPredicate[0].length,
      resumedPredicate.index,
    );
    if (/\b(?:and|or|plus|as well as)\b/iu.test(betweenPredicates)) {
      return '';
    }
    return source.slice(resumedPredicate.index).trim();
  }
  return '';
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

function isExplicitlyOutsideV01(clause, matchedRule) {
  return (
    outsideV01Qualifier.test(clause) &&
    !hasAffirmativeV01Scope(clause, matchedRule)
  );
}

function isExplicitlyNegatedRequirement(clause, matchedRule) {
  const requirement = findMatchedRequirement(clause, matchedRule);
  if (requirement === undefined) {
    return false;
  }
  const requirementEnd = requirement.index + requirement[0].length;
  const negations = [
    modalNegatedRequirement,
    auxiliaryNegatedRequirement,
    noLongerRequirement,
    directNotRequirement,
    contractedAuxiliaryNegatedRequirement,
    contractedModalNegatedRequirement,
  ];
  const requirementIsNegated = negations.some(pattern =>
    Array.from(
      clause.matchAll(new RegExp(pattern.source, `${pattern.flags}g`)),
    ).some(
      negation =>
        negation.index !== undefined &&
        negation.index <= requirement.index &&
        negation.index + negation[0].length >= requirementEnd,
    ),
  );
  if (requirementIsNegated) {
    return true;
  }
  const activity = findMatchedPhysicalActivity(matchedRule);
  if (activity === undefined) {
    return false;
  }
  const activityEnd = activity.index + activity[0].length;
  return Array.from(
    clause.matchAll(
      new RegExp(
        explicitlyAbsentPhysicalDeviceActivity.source,
        `${explicitlyAbsentPhysicalDeviceActivity.flags}g`,
      ),
    ),
  ).some(
    negation =>
      negation.index !== undefined &&
      negation.index <= activity.index &&
      negation.index + negation[0].length >= activityEnd,
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
    'Documentation is not required even if physical-device testing is required for v0.1.',
    "Documentation isn't required even if v0.1 requires physical-device testing.",
    'Outside v0.1, testing on physical devices is required, and v0.1 physical-device evidence is required.',
    'Physical-device testing is not required for post-v0.1 work, and physical-device evidence is required for v0.1.',
    'Post-v0.1 documentation is required, and v0.1 physical-device testing is required.',
    'Post-v0.1 documentation is required, and physical-device testing for v0.1 migration is required.',
    'Physical-device testing is required for v0.1 to compare post-v0.1 behavior.',
    'Physical-device testing must not fail and is required.',
    'Physical-device testing must not fail.',
    'Physical-device testing must not fail even if documentation is required.',
    "Physical-device testing mustn't fail even if documentation is required.",
    'Physical-device testing mustn’t fail even if documentation is required.',
    "Physical-device testing mustn't ever fail even if documentation is required.",
    'Physical-device testing mustn’t ever fail even if documentation is required.',
    'v0.1 requires, if available, physical-device testing.',
    'v0.1 requires, when possible, validation on physical devices.',
    'v0.1 requires, if available, physical-device testing that runs offline.',
    'v0.1 requires, if available, physical-device testing that can run offline.',
    'v0.1 requires, if available, physical-device testing to run nightly.',
    'v0.1 requires, if available, physical-device testing workflows.',
    'v0.1 requires, if available, physical-device validation plans.',
    'v0.1 requires, if available, physical-device testing results.',
    'v0.1 requires, if available, physical-device testing procedures.',
    'Physical-device testing before release is required for v0.1.',
    'Physical-device testing that runs offline before release is required for v0.1.',
    'Physical-device testing that can run offline before release is required for v0.1.',
    'Physical-device testing, which runs offline, before release is required for v0.1.',
    'Physical-device testing to begin before release is required for v0.1.',
    'Physical-device testing performed before release is required.',
    'Physical-device testing begins before release and is required for v0.1.',
    'Post-v0.1 physical-device testing performed before release is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and is required for v0.1.',
    'v0.1 requires physical-device testing before post-v0.1 documentation begins.',
    'v0.1 physical-device testing is required before post-v0.1 documentation begins.',
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
    'A v0.1 requirement to test on physical devices.',
    'A v0.1 requirement to validate on physical devices.',
    'A v0.1 requirement to verify on physical devices.',
    'Physical-device testing is required while offline.',
    'Physical-device testing or validation is required.',
    'Physical-device testing is not required for post-v0.1 but is required for v0.1.',
    'Physical-device testing is allowed outside v0.1; is required for v0.1.',
    'Post-v0.1 notes apply; physical-device testing is required.',
    'Post-v0.1 documentation is required: physical-device testing is required.',
    'For v0.1 work: physical-device testing is required.',
    'v0.1: physical-device testing is required.',
    'Post-v0.1: physical-device testing is required for v0.1.',
    'For post-v0.1 work: physical-device testing is required for v0.1.',
    'The post-v0.1 documentation requirement explains why v0.1 work requires physical-device testing.',
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
    'Post-v0.1: physical-device testing is required.',
    'Outside v0.1 — physical-device testing is required.',
    'Physical-device validation is not required for v0.1.',
    'Physical-device validation is not a requirement for v0.1.',
    'No requirements for physical-device validation apply to v0.1.',
    'Documentation is required even if physical-device testing is not required for v0.1.',
    'Physical-device testing is not required for v0.1 even if documentation is required.',
    'Physical-device testing must not be required for v0.1.',
    'Physical-device testing must not be required even if documentation is required.',
    "Physical-device testing mustn't be required even if documentation is required.",
    'Physical-device testing mustn’t be required even if documentation is required.',
    "Physical-device testing mustn't ever be required for v0.1.",
    'Physical-device testing mustn’t ever be required for v0.1.',
    'Physical-device testing must not ever be required for v0.1.',
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
    'The v0.1 documentation requirement explains why post-v0.1 work requires physical-device testing.',
    'The v0.1 documentation requirement states that physical-device testing is required for post-v0.1 work.',
    'v0.1 documentation is required before post-v0.1 physical-device testing begins.',
    'v0.1 documentation is required after post-v0.1 physical-device testing ends.',
    'Post-v0.1 physical-device testing begins before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing ends after v0.1 documentation is required.',
    'v0.1 documentation is required before post-v0.1 physical-device testing proceeds.',
    'v0.1 documentation is required before post-v0.1 physical-device tests proceed.',
    'v0.1 documentation is required before post-v0.1 physical-device testing, which runs offline, proceeds.',
    'Post-v0.1 physical-device testing proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing that runs offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing that can run offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing to run nightly proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing performed offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing begins before release and v0.1 documentation is required.',
    'Post-v0.1 physical-device testing, if available, is required.',
    'A post-v0.1 requirement to test on physical devices.',
    'A v0.1 requirement not to test on physical devices.',
    'Post-v0.1 work requires physical-device testing for migration from the v0.1 release.',
    'Compared with v0.1, post-v0.1 work requires physical-device testing.',
    'The v0.1 baseline is incomplete, so post-v0.1 work requires physical-device testing.',
    'No physical-device evidence is required for v0.1.',
    'No validation on physical devices is required for v0.1.',
    'v0.1 does not require physical-device testing.',
    'For post-v0.1 work: physical-device testing is required.',
    'Post-v0.1 work: physical-device testing is required.',
    'For the post-v0.1 release — physical-device testing is required.',
    'For work outside v0.1: physical-device testing is required.',
    'Post-v0.1 requirements: physical-device testing is required.',
    'Use named minimum/current Simulator and Emulator profiles.',
    'Virtual results make no physical-hardware compatibility claim.',
  ];
  for (const [index, example] of allowedExamples.entries()) {
    if (findMatchedRule(example)) {
      throw new Error(`V01_VIRTUAL_POLICY_SELF_TEST_REJECTED_ALLOWED:${index}`);
    }
  }

  const multilineAllowedSources = [
    'For post-v0.1 work:\n- Physical-device testing is required.',
    'Post-v0.1 requirements:\n- Physical-device testing is required.',
    '## For the post-v0.1 release:\n\n1. Documentation is required.\n2. Physical-device testing is required.',
  ];
  for (const [index, example] of multilineAllowedSources.entries()) {
    try {
      assertNoStaleRequirement(example, `multiline-allowed-${index}`);
    } catch {
      throw new Error(
        `V01_VIRTUAL_POLICY_SELF_TEST_REJECTED_MULTILINE_ALLOWED:${index}`,
      );
    }
  }

  const multilineStaleSources = [
    'For post-v0.1 work:\n- Physical-device testing is required for v0.1.',
    'Post-v0.1 requirements:\n- Documentation is required.\n- Physical-device testing is required for v0.1.',
    'For v0.1 work:\n- Physical-device testing is required.',
  ];
  for (const [index, example] of multilineStaleSources.entries()) {
    try {
      assertNoStaleRequirement(example, `multiline-stale-${index}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('V01_VIRTUAL_POLICY_STALE_REQUIREMENT:')
      ) {
        continue;
      }
    }
    throw new Error(
      `V01_VIRTUAL_POLICY_SELF_TEST_MISSED_MULTILINE_STALE:${index}`,
    );
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
