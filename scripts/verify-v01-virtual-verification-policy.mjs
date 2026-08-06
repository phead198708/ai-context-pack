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
const requirementTerm = String.raw`\b(?:calls?\s+for|(?:has|have|had)\s+to|compulsory|demand(?:s|ed)?|essential|mandat(?:e|es|ed)|need(?:s|ed)?|necessitat(?:e|es|ed)|necessary|obligatory|oblige(?:s|d)?|requires?|required|must(?:n['’]t)?|shall|mandatory)\b`;
const nounRequirementTerm = String.raw`\brequirements?\b`;
const policyRequirementTerm = String.raw`(?:${requirementTerm}|${nounRequirementTerm})`;
const allowancePredicateTerm = String.raw`\b(?:(?:is|are|was|were|be|remain(?:s|ed)?)\s+(?:allowed|permitted|optional)|may|can|allows?|permits?)\b`;
const physicalDeviceActivity = String.raw`(?:${physicalDeviceTerm}${requirementClauseGap}${verificationActivityTerm}|${verificationActivityTerm}${requirementClauseGap}${physicalDeviceTerm})`;
const explicitlyAbsentPhysicalDeviceActivity = new RegExp(
  String.raw`\bno\b${requirementClauseGap}${physicalDeviceActivity}`,
  'i',
);
const negatedClauseGap = String.raw`(?:(?!\band\b|${policyRequirementTerm}|${physicalDeviceTerm}|${verificationActivityTerm})[^\r\n.!?。！？;；]){0,80}`;
const modalModifierTerm = String.raw`actually|again|always|automatically|ever|explicitly|independently|necessarily|normally|ordinarily|otherwise|still`;
const boundedModalModifier = String.raw`(?:(?:${modalModifierTerm})\s+){0,3}`;
const boundedCopulaModifier = String.raw`(?:(?:\p{L}+(?:[-'’]\p{L}+)*)\s+){0,3}`;
const negatingCopulaModifierTerm = String.raw`barely|hardly|never|no|nor|not|rarely|scarcely|seldom`;
const boundedNonNegatingCopulaModifier = String.raw`(?:(?!(?:${negatingCopulaModifierTerm})\b)(?:\p{L}+(?:[-'’]\p{L}+)*)\s+){0,3}`;
const sharedPolicyModifierTerm = String.raw`actually|again|always|automatically|eventually|ever|explicitly|independently|later|necessarily|normally|now|occasionally|often|ordinarily|otherwise|previously|rarely|sometimes|soon|still|then|typically|usually`;
const sharedPolicyModifier = String.raw`(?:(?:${sharedPolicyModifierTerm})\s+){0,3}`;
// Open derived-adverb morphology avoids treating every noun ending in `-ly`
// as a shared modifier. The shape is based on productive adjective suffixes
// and consonant-final adjective stems rather than either an adverb allowlist or
// a noun denylist.
const derivedAdverbStem = String.raw`(?:\p{L}{2,}(?:al|ant|ary|en|ent|ful|ic|ible|ive|less|ous)|\p{L}{2,}(?:ck|ct|ft|gh|ld|nd|ng|pt|rd|rm|st))`;
const openSharedPolicyModifier = String.raw`(?:(?:${derivedAdverbStem})ly\s+){1,3}`;
const modalNegatedComplement = String.raw`(?:${physicalDeviceActivity}|(?:be|become|remain)\s+(?:(?:a|an|the)\s+)?(?:compulsory|essential|mandatory|necessary|obligatory|required|requirements?)|(?:require|mandate|perform|provide|collect)\s+${physicalDeviceActivity}|(?:be\s+)?(?:accepted|classified|counted|described|reported|represented|treated)\s+as\s+${physicalDeviceActivity})`;
const modalNegatedRequirement = new RegExp(
  String.raw`\b(?:must|shall|should|will|would|can|could|need)\s+(?:not|never)\s+${boundedModalModifier}${modalNegatedComplement}`,
  'i',
);
const occurrencePlatformContext = String.raw`(?:across|for|in|on|within)\s+(?:(?:all|both|each|the|these|those|two)\s+)?(?:android|apps?|ios|platforms?|systems?|targets?)(?:\s+(?:and|or)\s+(?:android|apps?|ios|platforms?|systems?|targets?))?`;
const occurrenceSubjectModifier = String.raw`(?:(?:actually|explicitly|independently|itself|normally|offline|online|ordinarily|otherwise|still|\p{L}+ly)\s+|${occurrencePlatformContext}\s+){0,3}`;
const needNegatedPhysicalActivityOccurrence = new RegExp(
  String.raw`${physicalDeviceActivity}\s+${occurrenceSubjectModifier}need\s+(?:not|never)\s+${boundedModalModifier}(?:happen|occur|take\s+place)\b`,
  'iu',
);
const auxiliaryNegatedRequirement = new RegExp(
  String.raw`\b(?:does?|do|is|are|was|were|has|have|had)\s+(?:not|never)\b${negatedClauseGap}${policyRequirementTerm}`,
  'i',
);
const physicalActivityObjectDeterminer = String.raw`(?:(?:(?:all|any|each|either|every|her|his|its|my|our|some|that|the|their|these|this|those|your)|\p{L}+(?:[-'’]\p{L}+)*['’]s)\s+)?`;
const auxiliaryNegatedPhysicalActivityObjectRequirement = new RegExp(
  String.raw`\b(?:(?:do|does|did)\s+(?:not|never)|(?:do|does|did)n['’]t)\s+${boundedModalModifier}(?:accept|classify|count|describe|report|represent|treat)\s+${physicalActivityObjectDeterminer}${physicalDeviceActivity}\s+as\s+(?:being\s+)?(?:(?:a|an|the)\s+)?${policyRequirementTerm}`,
  'i',
);
const noLongerRequirement = new RegExp(
  String.raw`\b(?:(?:is|are|was|were)\s+|(?:can|could|may|might|must|shall|should|will|would)\s+${boundedNonNegatingCopulaModifier})no longer\b${negatedClauseGap}${policyRequirementTerm}`,
  'iu',
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
const boundaryCopulaPredicate = String.raw`(?:am|are|be|became|becomes?|is|remain(?:s|ed)?|was|were|(?:can|could|may|might|must|shall|should|will|would)\s+${boundedCopulaModifier}(?:be|become|remain))`;
const activityFiniteFunctionalPredicate = String.raw`\b(?:am|are|can(?:not)?|could|did|do|does|had|has|have|is|may|might|must|shall|should|was|were|will|would)\b`;
const activityFiniteLexicalPredicate = String.raw`\b(?:advanc(?:e|ed|es)|begin(?:s)?|collect(?:ed|s)?|complet(?:e|ed|es)|contain(?:ed|s)?|continu(?:e|ed|es)|creat(?:e|ed|es)|end(?:ed|s)?|execut(?:e|ed|es)|exist(?:ed|s)?|fail(?:ed|s)?|finish(?:ed|es)?|generat(?:e|ed|es)|happen(?:ed|s)?|includ(?:e|ed|es)|launch(?:ed|es)?|mov(?:e|ed|es)|occur(?:red|s)?|operat(?:e|ed|es)|pass(?:ed|es)?|persist(?:ed|s)?|proceed(?:ed|s)?|process(?:ed|es)?|produc(?:e|ed|es)|read(?:s)?|record(?:ed|s)?|remain(?:ed|s)?|requir(?:e|ed|es)|restart(?:ed|s)?|resum(?:e|ed|es)|return(?:ed|s)?|run(?:s)?|ship(?:ped|s)?|start(?:ed|s)?|stop(?:ped|s)?|stor(?:e|ed|es)|succeed(?:ed|s)?|tak(?:e|es)|test(?:ed|s)?|transition(?:ed|s)?|us(?:e|ed|es)|validat(?:e|ed|es)|verif(?:y|ied|ies)|wait(?:ed|s)?|work(?:ed|s)?|writ(?:e|es))\b`;
const activityIrregularFinitePredicate = String.raw`\b(?:became|began|came|fell|got|grew|ran|rose|took|went|wrote)\b`;
const activityFinitePredicate = new RegExp(
  `(?:${activityFiniteFunctionalPredicate}|${activityFiniteLexicalPredicate}|${activityIrregularFinitePredicate})`,
  'iu',
);
const openInflectedActivityPredicate =
  /^(?<predicate>\p{L}{2,}(?:ed|s|ies))\b/iu;
const irregularReducedActivityModifier = String.raw`(?:begun|built|done|given|held|made|run|seen|taken|written)`;
const reducedActivityModifier = String.raw`(?:(?!(?:bleed|breed|failed|feed|happened|heed|need|occurred|persisted|proceeded|read|seed|speed|succeeded|waited|worked)\b)\p{L}+ed|${irregularReducedActivityModifier})`;
const passiveActivityModifier = String.raw`(?:(?:offline|online|\p{L}+ly)\s+){0,3}`;
const passiveTemporalAgentLead = String.raw`deadline|end|evening|final|launch|milestone|morning|night|noon|release|schedule|time|today|tomorrow|week|weekend|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|last|next|this`;
const passiveAgentPhraseBoundary = String.raw`after|although|as|at|before|because|by|during|for|from|if|in|of|on|once|since|though|under|unless|until|when(?:ever)?|whereas|while|with|without|within`;
const passiveAgentiveRoleHead = String.raw`(?:\p{L}{2,}(?:eers?|ers?|ors?|ists?|ysts?|ians?|ants?|ents?|ees?)|assurance|engineering|groups?|management|operations|personnel|qa|staff|teams?)`;
const activityBoundaryOrAttachment =
  /^(?:after|although|as|at|before|because|by|during|for|from|if|in|of|on|once|since|though|under|unless|until|when(?:ever)?|whereas|while|with|without|within)\b/iu;
const outsideV01Qualifier =
  /\b(?:outside (?:of )?(?:the )?v0\.1(?: scope)?|post[- ]v0\.1)\b/iu;
const policyCoordinatorTerm = String.raw`(?:as well as|even though|nevertheless|nonetheless|however|whereas|although|while|though|because|despite|but|yet|and|or|plus)`;
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
  const scopeHeadings = [];
  for (const [index, line] of lines.entries()) {
    const markdownListIndent = findMarkdownListIndent(line);
    const isMarkdownListItem = markdownListIndent !== undefined;
    if (isMarkdownListItem) {
      while (
        scopeHeadings.at(-1)?.listIndent !== undefined &&
        scopeHeadings.at(-1).listIndent >= markdownListIndent
      ) {
        scopeHeadings.pop();
      }
      for (const scopeHeading of scopeHeadings) {
        scopeHeading.hasListChildren = true;
      }
    } else if (/^\s*(?:>\s*)?#{1,6}\s+/u.test(line)) {
      scopeHeadings.length = 0;
    } else if (
      line.trim().length > 0 &&
      scopeHeadings.at(-1)?.hasListChildren
    ) {
      scopeHeadings.length = 0;
    }
    const outsideScopeHeading = findOutsideV01ScopeHeading(line);
    if (outsideScopeHeading !== undefined) {
      if (!isMarkdownListItem) {
        scopeHeadings.length = 0;
      }
      scopeHeadings.push({
        hasListChildren: false,
        heading: outsideScopeHeading,
        listIndent: isMarkdownListItem ? markdownListIndent : -1,
      });
      continue;
    }
    const affirmativeScopeHeading = findAffirmativeV01ScopeHeading(line);
    if (affirmativeScopeHeading !== undefined) {
      if (!isMarkdownListItem) {
        scopeHeadings.length = 0;
      }
      scopeHeadings.push({
        hasListChildren: false,
        heading: affirmativeScopeHeading,
        listIndent: isMarkdownListItem ? markdownListIndent : -1,
      });
      continue;
    }
    if (line.trim().length === 0) {
      continue;
    }
    const activeScopeHeading = scopeHeadings.at(-1)?.heading;
    const contextualLine =
      activeScopeHeading === undefined
        ? stripMarkdownListMarker(line)
        : `${activeScopeHeading}: ${stripMarkdownListMarker(line)}`;
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
      scopeHeadings.length = 0;
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

function findMarkdownListIndent(source) {
  const unquotedSource = stripMarkdownBlockquotePrefix(source);
  const listItem = /^(?<indent>\s*)(?:[-*+]\s+|\d+[.)]\s+)/u.exec(
    unquotedSource,
  );
  return listItem === null
    ? undefined
    : (listItem.groups?.indent ?? '').replaceAll('\t', '  ').length;
}

function findOutsideV01ScopeHeading(source) {
  const heading = normalizeScopeHeading(source);
  return isOutsideV01ScopeOnlyHeading(heading) ? heading : undefined;
}

function findAffirmativeV01ScopeHeading(source) {
  const heading = normalizeScopeHeading(source);
  return isAffirmativeV01ScopeOnlyHeading(heading) ? heading : undefined;
}

function normalizeScopeHeading(source) {
  return stripMarkdownListMarker(source)
    .replace(/^(?:>\s*)?(?:#{1,6}\s+)?/u, '')
    .replace(/\s*[:：—–]\s*$/u, '')
    .trim();
}

function stripMarkdownListMarker(source) {
  return stripMarkdownBlockquotePrefix(source)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '')
    .trim();
}

function stripMarkdownBlockquotePrefix(source) {
  return source.replace(/^(?:\s*>\s?)+/u, '');
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
  clause = normalizeBalancedDashActivityModifiers(clause);
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
    const hasExplicitNewPolicySubject =
      hasIndependentPhysicalActivityStatement(left) &&
      hasIndependentPolicyStatement(right) &&
      classifyPolicySubjectBeforeRequirement(right) === 'new';
    if (
      isHardBoundary ||
      hasCoordinatedPolicies ||
      hasExplicitNewPolicySubject
    ) {
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

function normalizeBalancedDashActivityModifiers(source) {
  const attachedModifier = new RegExp(
    String.raw`(?<activity>${physicalDeviceActivity})\s*(?<dash>[—–])\s*(?<modifier>(?:(?![—–]|${policyRequirementTerm}|${allowancePredicateTerm})[^\r\n.!?。！？;；]){1,120}?)\s*\k<dash>\s*(?=${boundaryCopulaPredicate}\b)`,
    'giu',
  );
  return source.replace(attachedModifier, (...replacement) => {
    const groups = replacement.at(-1);
    return `${groups.activity}, ${groups.modifier.trim()}, `;
  });
}

function hasPhysicalDeviceActivity(source) {
  return physicalDeviceActivityMatcher.test(source);
}

function hasIndependentPhysicalActivityStatement(source) {
  const activity = physicalDeviceActivityMatcher.exec(source);
  return (
    activity !== null &&
    hasIndependentActivityPredicate(
      source.slice(activity.index + activity[0].length),
      { activitySource: activity[0] },
    )
  );
}

function inheritPhysicalDeviceActivity(left, right) {
  const activityMatch = physicalDeviceActivityMatcher.exec(left);
  if (activityMatch === null) {
    return right;
  }
  const requirementAdjective = String.raw`(?:compulsory|essential|mandatory|necessary|obligatory|required)`;
  const sharedPolicyCore = String.raw`(?:(?:being|becoming|remaining)\s+${requirementAdjective}\b|${boundaryCopulaPredicate}\b|${requirementAdjective}\b(?=\s*(?:(?:for|in|on|at|during|within|under|throughout|by|across|as part of)\b|$)))`;
  const nonBareSharedCopula = String.raw`(?:became|becomes?|remain(?:s|ed)?|(?:can|could|may|might|must|shall|should|will|would)\s+${boundedCopulaModifier}(?:be|become|remain))`;
  // An open -ly modifier is ambiguous before a bare copula (`assembly is`),
  // but is structurally adverbial before a continuing or modal copula.
  const sharedPolicyPredicate = String.raw`(?:${sharedPolicyModifier}${sharedPolicyCore}|${openSharedPolicyModifier}(?:(?:being|becoming|remaining)\s+${requirementAdjective}\b|${nonBareSharedCopula}\b))`;
  const anaphoricContinuation = new RegExp(
    String.raw`^(?:it|itself|that|this|they|themselves|these|those)\s+(?<predicate>${sharedPolicyPredicate}.*)$`,
    'iu',
  ).exec(right);
  if (anaphoricContinuation !== null) {
    return `${activityMatch[0]} ${
      anaphoricContinuation.groups?.predicate ?? ''
    }`.trim();
  }
  if (new RegExp(String.raw`^${sharedPolicyPredicate}`, 'iu').test(right)) {
    return `${activityMatch[0]} ${right}`;
  }
  return right;
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

function classifyPolicySubjectBeforeRequirement(source) {
  const requirement = independentPolicyPredicate.exec(source);
  if (requirement === null) {
    return 'unknown';
  }
  const subject = source
    .slice(0, requirement.index)
    .replace(/^\s*(?:although|and|but|or|though|whereas|while|yet)\b/iu, '')
    .replace(new RegExp(String.raw`\b${boundaryCopulaPredicate}\s*$`, 'iu'), '')
    .trim();
  return classifyPossibleRequirementSubject(subject, true);
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

function isAffirmativeV01ScopeOnlyHeading(source) {
  if (
    outsideV01Qualifier.test(source) ||
    hasPhysicalDeviceActivity(source) ||
    independentRequirement.test(source) ||
    independentAllowance.test(source)
  ) {
    return false;
  }
  const scopeNoun =
    '(?:activities|items|milestone|phase|planning|release|requirements?|roadmap|scope|tasks|verification|work)';
  return new RegExp(
    String.raw`^\s*(?:for\s+(?:the\s+)?)?(?:v0\.1(?:\s+scope)?(?:\s+${scopeNoun})?|${scopeNoun}(?:\s+for)?\s+(?:the\s+)?v0\.1(?:\s+scope)?)\s*$`,
    'iu',
  ).test(source);
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
  const matchedRuleEnd = matchedRule.index + matchedRule[0].length;
  const activityEnd = activity.index + activity[0].length;
  const activitySubjectCandidates = candidates.filter(candidate => {
    if (candidate.index === undefined || candidate.index < activityEnd) {
      return false;
    }
    const beforeCandidate = source.slice(activityEnd, candidate.index);
    return (
      beforeCandidate.length <= 48 &&
      /^\s*(?:(?:actually|again|always|am|are|automatically|be|became|become|becomes|can|could|ever|explicitly|independently|is|may|might|must|necessarily|never|normally|not|ordinarily|otherwise|remain|remained|remains|shall|should|still|was|were|will|would|\p{L}+ly)\s+){0,5}$/iu.test(
        beforeCandidate,
      )
    );
  });
  const containedCandidates = candidates.filter(
    candidate =>
      candidate.index !== undefined &&
      candidate.index >= matchedRule.index &&
      candidate.index + candidate[0].length <= matchedRuleEnd,
  );
  const scopedCandidates = Array.from(
    new Set([...containedCandidates, ...activitySubjectCandidates]),
  );
  const candidatePool =
    scopedCandidates.length > 0 ? scopedCandidates : candidates;
  return candidatePool.reduce((closest, candidate) => {
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
      hasIndependentActivityPredicate(source.slice(activityEnd), {
        activitySource: activity[0],
      }) && isPhysicalActivityExplicitlyOutsideV01(source, activity)
    );
  }
  const between = source.slice(activityEnd, requirement.index);
  const boundary = requirementToActivityBoundary.exec(between);
  if (boundary === null) {
    return true;
  }
  const subjectRelationship = classifyRequirementSubjectAfterBoundary(
    between,
    boundary,
  );
  const hasIndependentPredicate = hasIndependentActivityPredicate(
    between.slice(0, boundary.index),
    {
      activitySource: activity[0],
      preferAttachedParticiple: true,
      explicitBoundarySubject: subjectRelationship === 'new',
    },
  );
  if (subjectRelationship === 'shared') {
    return true;
  }
  if (subjectRelationship === 'new') {
    return !hasIndependentPredicate;
  }
  return !(
    hasIndependentPredicate &&
    isPhysicalActivityExplicitlyOutsideV01(source, activity)
  );
}

function classifyRequirementSubjectAfterBoundary(source, boundary) {
  const afterBoundaryWithPredicate = source
    .slice(boundary.index + boundary[0].length)
    .trim();
  const trailingPredicate = new RegExp(
    String.raw`\b(?<predicate>${boundaryCopulaPredicate})\s*$`,
    'iu',
  ).exec(afterBoundaryWithPredicate);
  const afterBoundary = afterBoundaryWithPredicate
    .replace(new RegExp(String.raw`\b${boundaryCopulaPredicate}\s*$`, 'iu'), '')
    .trim();
  const coordinatedTail =
    /\b(?:although|and|but|or|though|whereas|while|yet)\s*(?<tail>[^,;；:：—–]*)$/iu.exec(
      afterBoundary,
    );
  if (coordinatedTail !== null) {
    const tail = coordinatedTail.groups?.tail.trim() ?? '';
    return classifyPossibleRequirementSubject(tail, true);
  }
  const afterBoundaryWords = afterBoundary.split(/\s+/u);
  for (
    let modifierCount = 1;
    modifierCount <= Math.min(4, afterBoundaryWords.length);
    modifierCount += 1
  ) {
    if (
      isSubjectContinuationModifierPhrase(
        afterBoundaryWords.slice(-modifierCount).join(' '),
      )
    ) {
      return 'shared';
    }
  }
  const classification = classifyPossibleRequirementSubject(
    afterBoundary,
    false,
  );
  if (classification !== 'unknown') {
    return classification;
  }
  const predicate = trailingPredicate?.groups?.predicate ?? '';
  const hasModalCopula =
    /^(?:can|could|may|might|must|shall|should|will|would)\b/iu.test(predicate);
  const isBareSubject =
    /^\p{L}+(?:[-'’]\p{L}+)*(?:\s+\p{L}+(?:[-'’]\p{L}+)*){0,3}$/iu.test(
      afterBoundary,
    );
  if (
    isBareSubject &&
    (hasModalCopula || /^(?:became|becomes|is|remains|was)$/iu.test(predicate))
  ) {
    return 'new';
  }
  if (
    isBareSubject &&
    isPluralBoundarySubject(afterBoundary) &&
    (hasModalCopula || /^(?:are|become|remain|were)$/iu.test(predicate))
  ) {
    return 'new';
  }
  return 'unknown';
}

function isPluralBoundarySubject(source) {
  const head = source.trim().split(/\s+/u).at(-1)?.toLocaleLowerCase('en-US');
  if (head === undefined) {
    return false;
  }
  if (
    /^(?:aircraft|children|criteria|data|fish|media|men|offspring|people|personnel|phenomena|police|series|sheep|species|staff|women)$/u.test(
      head,
    )
  ) {
    return true;
  }
  return !/(?:is|ss|us)$/u.test(head) && /s$/u.test(head);
}

function classifyPossibleRequirementSubject(source, followsCoordinator) {
  const normalized = source.trim();
  if (normalized.length === 0) {
    return 'shared';
  }
  if (
    /^(?:it|itself|that|this|these|they|those)(?:\s+(?:again|alone|itself|themselves))?$/iu.test(
      normalized,
    )
  ) {
    return 'shared';
  }
  if (isSubjectContinuationModifierPhrase(normalized)) {
    return 'shared';
  }
  if (
    /\bv0\.1\b\s+\p{L}/iu.test(normalized) ||
    /^(?:(?:a|an|another|any|each|either|every|its|my|neither|no|our|some|the|their|your)\s+|(?:these|this|those|that)\s+\p{L})/iu.test(
      normalized,
    )
  ) {
    return 'new';
  }
  return followsCoordinator ? 'new' : 'unknown';
}

function isSubjectContinuationModifierPhrase(source) {
  const words = source.split(/\s+/u);
  return (
    words.length <= 4 &&
    words.every(word =>
      /^(?:again|also|ever|later|never|now|once|still|then|yet|\p{L}+ly|\p{L}*(?:after|before|ward|wards))$/iu.test(
        word,
      ),
    )
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

function hasIndependentActivityPredicate(
  source,
  {
    activitySource = '',
    preferAttachedParticiple = false,
    explicitBoundarySubject = false,
  } = {},
) {
  let predicate = source.trim();
  const hasLeadingComma = /^,\s*/u.test(predicate);

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

  const prepositionalRelative =
    /^(?:by|with)\s+(?:(?!\b(?:that|which|who|whose)\b)[^,;；:：—–]){1,64}(?=(?:that|which|who|whose)\b)/iu.exec(
      predicate,
    );
  if (prepositionalRelative !== null) {
    predicate = predicate.slice(prepositionalRelative[0].length).trim();
  }

  // A reduced passive followed by its own modifier remains attached even
  // without delimiting commas. A bare participle can still be finite (for
  // example, `testing completed before documentation is required`), so only
  // consume it here when a bounded adverbial modifier plus a non-temporal
  // `by` agent supplies positive passive evidence.
  if (
    preferAttachedParticiple &&
    explicitBoundarySubject &&
    matchLeadingPassiveActivityModifier(predicate) !== undefined
  ) {
    predicate = consumeLeadingAttachedActivityModifier(predicate, true);
    if (predicate.length === 0) {
      return false;
    }
  }

  if (
    explicitBoundarySubject &&
    !hasLeadingComma &&
    (!new RegExp(`^${irregularReducedActivityModifier}\\b`, 'iu').test(
      predicate,
    ) ||
      /\b(?:devices|tests)\b/iu.test(activitySource)) &&
    new RegExp(`^${activityFinitePredicate.source}`, 'iu').test(predicate)
  ) {
    return true;
  }

  if (
    preferAttachedParticiple &&
    !explicitBoundarySubject &&
    /\btests\b/iu.test(activitySource) &&
    /^failed\b/iu.test(predicate)
  ) {
    predicate = findResumedActivityPredicate(predicate, 'failed'.length);
    if (predicate.length === 0) {
      return false;
    }
  }

  predicate = consumeLeadingAttachedActivityModifier(
    predicate,
    preferAttachedParticiple,
  );
  if (predicate.length === 0) {
    return false;
  }

  // Prepositional and subordinate material without a resumed predicate remains
  // attached to the physical activity rather than severing its requirement.
  if (activityBoundaryOrAttachment.test(predicate)) {
    return false;
  }

  if (new RegExp(`^${activityFinitePredicate.source}`, 'iu').test(predicate)) {
    return true;
  }

  const openInflectedPredicate = openInflectedActivityPredicate.exec(predicate);
  if (openInflectedPredicate !== null) {
    const remainder = predicate.slice(openInflectedPredicate[0].length).trim();
    if (
      preferAttachedParticiple &&
      new RegExp(`^${reducedActivityModifier}\\b`, 'iu').test(remainder)
    ) {
      return hasIndependentActivityPredicate(remainder, {
        activitySource,
        preferAttachedParticiple: true,
        explicitBoundarySubject,
      });
    }
    return (
      remainder.length > 0 && !activityBoundaryOrAttachment.test(remainder)
    );
  }

  // A plural activity subject admits an uninflected finite predicate. This is
  // deliberately structural rather than a closed verb list: the governance
  // scanner must not reject new, ordinary activity verbs merely because its
  // corpus has not seen them before.
  return (
    /\b(?:devices|tests)\b/iu.test(activitySource) &&
    /^(?!\b(?:and|or|plus)\b)\p{L}{2,}\b/iu.test(predicate)
  );
}

function consumeLeadingAttachedActivityModifier(
  source,
  preferAttachedParticiple,
) {
  const reducedRelative = new RegExp(
    preferAttachedParticiple
      ? String.raw`^(?<participle>${reducedActivityModifier})\b`
      : String.raw`^(?<participle>${irregularReducedActivityModifier})\b`,
    'iu',
  ).exec(source);
  if (reducedRelative !== null) {
    const participleEnd =
      reducedRelative.groups?.participle.length ?? reducedRelative[0].length;
    const passiveAgent = preferAttachedParticiple
      ? matchLeadingPassiveActivityAgent(source.slice(participleEnd))
      : undefined;
    return findResumedActivityPredicate(
      source,
      participleEnd + (passiveAgent?.length ?? 0),
    );
  }
  const infinitive = /^(?<modifier>to\s+\p{L}+)\b/iu.exec(source);
  if (infinitive !== null) {
    return findResumedActivityPredicate(
      source,
      infinitive.groups?.modifier.length ?? infinitive[0].length,
    );
  }
  const possessiveRelative = new RegExp(
    String.raw`^whose\s+\p{L}+\s+(?:(?:${activityFiniteFunctionalPredicate})\s+(?:(?:not|never|quite|very|\p{L}+ly)\s+){0,3})?\p{L}+\b`,
    'iu',
  ).exec(source);
  if (possessiveRelative !== null) {
    return findResumedActivityPredicate(source, possessiveRelative[0].length);
  }
  const relative = new RegExp(
    String.raw`^(?:that|which|who)\s+(?:(?:${activityFiniteFunctionalPredicate})\s+(?:(?:not|never|quite|very|\p{L}+ly)\s+){0,3})?\p{L}+\b`,
    'iu',
  ).exec(source);
  if (relative !== null) {
    return findResumedActivityPredicate(source, relative[0].length);
  }
  return source;
}

function matchLeadingPassiveActivityModifier(source) {
  const reducedRelative = new RegExp(
    String.raw`^(?<participle>${reducedActivityModifier})\b`,
    'iu',
  ).exec(source);
  if (reducedRelative === null) {
    return undefined;
  }
  const participleEnd =
    reducedRelative.groups?.participle.length ?? reducedRelative[0].length;
  const agent = matchLeadingPassiveActivityAgent(source.slice(participleEnd));
  return agent === undefined
    ? undefined
    : { length: participleEnd + agent.length };
}

function matchLeadingPassiveActivityAgent(source) {
  const byPrefix = new RegExp(
    String.raw`^\s+${passiveActivityModifier}by\s+`,
    'iu',
  ).exec(source);
  if (byPrefix === null) {
    return undefined;
  }
  let cursor = byPrefix[0].length;
  const article = /^(?:a|an|our|the|their)\s+/iu.exec(source.slice(cursor));
  cursor += article?.[0].length ?? 0;
  const firstToken = /^\p{L}+(?:[-'’]\p{L}+)*/u.exec(source.slice(cursor));
  if (firstToken === null) {
    return undefined;
  }
  cursor += firstToken[0].length;
  const agentTokens = [firstToken[0]];
  const agentEnds = [cursor];
  while (agentTokens.length < 5) {
    if (
      new RegExp(
        String.raw`^\s+(?:${passiveAgentPhraseBoundary})\b`,
        'iu',
      ).test(source.slice(cursor))
    ) {
      break;
    }
    const nextToken =
      /^\s+(?<token>[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*)/u.exec(
        source.slice(cursor),
      );
    const token = nextToken?.groups?.token;
    if (token === undefined) {
      break;
    }
    cursor += nextToken[0].length;
    agentTokens.push(token);
    agentEnds.push(cursor);
  }
  if (
    !new RegExp(String.raw`^(?:${passiveTemporalAgentLead})$`, 'iu').test(
      agentTokens[0],
    )
  ) {
    return { length: agentEnds.at(-1) };
  }
  const hasAgentiveRoleHead = agentTokens.some(
    (token, index) =>
      index > 0 &&
      new RegExp(String.raw`^(?:${passiveAgentiveRoleHead})$`, 'iu').test(
        token,
      ),
  );
  if (!hasAgentiveRoleHead) {
    return undefined;
  }
  // Inspect the complete phrase: temporal prefixes such as `Final Release` or
  // `Release Candidate` may introduce a productively agentive role head in
  // either normal lowercase prose or title case. Without an agentive head,
  // the phrase remains an open milestone name (`Next Sprint`, ...).
  return { length: agentEnds.at(-1) };
}

function findResumedActivityPredicate(source, attachedEnd) {
  const resumedPredicates = Array.from(
    source.matchAll(new RegExp(activityFinitePredicate.source, 'giu')),
  ).filter(predicate => {
    if (predicate.index < attachedEnd) {
      return false;
    }
    const beforePredicate = source.slice(attachedEnd, predicate.index);
    return !/^\s*(?:in\s+order\s+)?to(?:\s+\p{L}+(?:[-'’]\p{L}+)*){0,3}\s*$/iu.test(
      beforePredicate,
    );
  });
  for (const resumedPredicate of resumedPredicates) {
    const beforeResumedPredicate = source.slice(
      attachedEnd,
      resumedPredicate.index,
    );
    if (/\b(?:and|or|plus|as well as)\b/iu.test(beforeResumedPredicate)) {
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
  if (
    /^\s*(?:(?:again|always|automatically|eventually|ever|explicitly|independently|necessarily|normally|ordinarily|otherwise|still|\p{L}+ly)\s+){0,3}(?:be|become|remain)\s+(?:(?:a|an|the)\s+)?(?:mandatory|required|requirements?)\s*$/iu.test(
      predicatePrefix,
    )
  ) {
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
  if (hasAdditionalNegationAroundNoLonger(clause, requirement)) {
    return false;
  }
  const negations = [
    needNegatedPhysicalActivityOccurrence,
    modalNegatedRequirement,
    auxiliaryNegatedPhysicalActivityObjectRequirement,
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

function hasAdditionalNegationAroundNoLonger(clause, requirement) {
  const requirementEnd = requirement.index + requirement[0].length;
  const relevantClause = clause.slice(
    Math.max(0, requirement.index - 120),
    requirementEnd,
  );
  const additionalNegation = new RegExp(
    String.raw`\b(?:${negatingCopulaModifierTerm})\b|n['’]t\b`,
    'iu',
  );
  return Array.from(relevantClause.matchAll(/\bno longer\b/giu)).some(
    noLonger => {
      if (noLonger.index === undefined) {
        return false;
      }
      const before = relevantClause.slice(
        Math.max(0, noLonger.index - 80),
        noLonger.index,
      );
      const after = relevantClause.slice(noLonger.index + noLonger[0].length);
      return additionalNegation.test(before) || additionalNegation.test(after);
    },
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
    'v0.1 mandates physical-device testing.',
    'v0.1 demands physical-device testing.',
    'v0.1 calls for physical-device testing.',
    'v0.1 needs physical-device testing.',
    'v0.1 has to test on physical devices.',
    'Physical-device testing is mandated for v0.1.',
    'Physical-device testing is compulsory for v0.1.',
    'Physical-device testing is obligatory for v0.1.',
    'Physical-device testing is necessary for v0.1.',
    'Physical-device testing is needed for v0.1.',
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
    'Physical-device testing need not fail and is required for v0.1.',
    'Physical-device testing need not occur and is required for v0.1.',
    'Physical-device testing need not occur despite being required for v0.1.',
    'Physical-device testing need not occur despite still being required for v0.1.',
    'Physical-device testing need not occur although eventually being required for v0.1.',
    'Physical-device testing need not occur but later becomes mandatory for v0.1.',
    'Physical-device testing need not occur, but will still be mandatory for v0.1.',
    'Physical-device testing need not occur, but will soon be mandatory for v0.1.',
    'Physical-device testing need not occur, but generally remains mandatory for v0.1.',
    'Physical-device testing need not occur, but frequently remains mandatory for v0.1.',
    'Physical-device testing need not occur, but hardly remains mandatory for v0.1.',
    'Physical-device testing need not occur, but quickly remains mandatory for v0.1.',
    'Physical-device testing need not occur, but carefully remains mandatory for v0.1.',
    'Physical-device testing need not occur, but suddenly remains mandatory for v0.1.',
    'Physical-device testing need not occur, but suddenly will become mandatory for v0.1.',
    'Physical-device testing will not no longer be mandatory for v0.1.',
    'Physical-device testing will never no longer be mandatory for v0.1.',
    'Physical-device testing will rarely no longer be mandatory for v0.1.',
    'Physical-device testing is not no longer mandatory for v0.1.',
    "Physical-device testing isn't no longer mandatory for v0.1.",
    'Physical-device testing will no longer not be mandatory for v0.1.',
    'Physical-device testing generally is required for v0.1.',
    'Physical-device testing unexpectedly remains mandatory for v0.1.',
    'Physical-device testing need not occur although it is required for v0.1.',
    'Physical-device testing need not occur; it is required for v0.1.',
    'Physical-device testing is optional; will be required for v0.1.',
    'Documentation need not happen alongside physical-device testing on both platforms, which remains mandatory for v0.1.',
    'Documentation need not occur alongside physical-device testing on both platforms, which remains mandatory for v0.1.',
    'Documentation need not happen before physical-device testing becomes mandatory for v0.1.',
    'Documentation is not required before physical-device testing becomes mandatory for v0.1.',
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
    'Physical-device testing before final release is required for v0.1.',
    'Physical-device testing that runs offline before release is required for v0.1.',
    'Physical-device testing that can run offline before release is required for v0.1.',
    'Physical-device testing, which runs offline, before release is required for v0.1.',
    'Physical-device testing to begin before release is required for v0.1.',
    'Physical-device testing performed before release is required.',
    'Physical-device testing begins before release and is required for v0.1.',
    'Post-v0.1 physical-device testing performed before release is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and is required for v0.1.',
    'Post-v0.1 physical-device testing workflows before release are required for v0.1.',
    'Post-v0.1 physical-device testing workflows scheduled before release are required for v0.1.',
    'Post-v0.1 physical-device testing workflows scheduled to run offline before release are required for v0.1.',
    'Post-v0.1 physical-device testing workflows scheduled to always run offline before release are required for v0.1.',
    'Post-v0.1 physical-device testing workflows scheduled to just run offline before release are required for v0.1.',
    'Post-v0.1 physical-device testing workflows scheduled to often run offline before release are required for v0.1.',
    'Post-v0.1 physical-device testing workflows scheduled to sometimes run offline before release are required for v0.1.',
    'The physical-device testing scheduled before the final release becomes required for v0.1.',
    'The physical-device testing workflows scheduled before the final release become required for v0.1.',
    'The physical-device testing, completed offline before the final release, becomes required for v0.1.',
    'The physical-device testing, executed offline before the final release, becomes required for v0.1.',
    'The physical-device testing — completed offline before the final release — becomes required for v0.1.',
    'The physical-device testing – executed offline before the final release – becomes required for v0.1.',
    'The physical-device testing (completed offline before the final release) becomes required for v0.1.',
    'The physical-device testing completed by QA before release is required for v0.1.',
    'The physical-device testing executed by QA before release is required for v0.1.',
    'The physical-device testing completed successfully by QA before release is required for v0.1.',
    'The physical-device testing executed offline by QA before release is required for v0.1.',
    'The physical-device testing completed by Release Engineering before shipment is required for v0.1.',
    'The physical-device testing executed by Launch Operations before shipment is required for v0.1.',
    'The physical-device testing completed by Release Coordinators before shipment is required for v0.1.',
    'The physical-device testing completed by Release Analysts before shipment is required for v0.1.',
    'The physical-device testing completed by Final Reviewers before shipment is required for v0.1.',
    'The physical-device testing completed by Final Release Coordinators before shipment is required for v0.1.',
    'The physical-device testing completed by Release Candidate Managers before shipment is required for v0.1.',
    'The physical-device testing completed by release engineers before shipment is required for v0.1.',
    'The physical-device testing completed by Release Quality Assurance before shipment is required for v0.1.',
    'Post-v0.1 physical-device tests failed deliberately before release are required for v0.1.',
    'Post-v0.1 physical-device tests failed before release and will be mandatory for v0.1.',
    'Post-v0.1 physical-device tests failed before release and will soon be mandatory for v0.1.',
    'Post-v0.1 physical-device tests failed before release and will eventually become mandatory for v0.1.',
    'Post-v0.1 physical-device tests failed before release and will very soon be mandatory for v0.1.',
    'Post-v0.1 physical-device validation plans before release are required for v0.1.',
    'Post-v0.1 physical-device testing that runs on devices before release is required for v0.1.',
    'Post-v0.1 physical-device testing that uses workflows before release is required for v0.1.',
    'Post-v0.1 physical-device testing whose scheduler runs on devices before release is required for v0.1.',
    'Post-v0.1 physical-device validation done before release is required for v0.1.',
    'Post-v0.1 physical-device testing guaranteed before release is required for v0.1.',
    'Post-v0.1 physical-device testing run offline before release is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and later is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release then is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and must be required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and it is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and this is required for v0.1.',
    'Post-v0.1 physical-device testing begins before release and that is required for v0.1.',
    'Physical-device testing begins before release and afterwards is required for v0.1.',
    'Physical-device testing begins before release and once again is required for v0.1.',
    'Physical-device testing begins before release and thereafter is required for v0.1.',
    'Post-v0.1 physical-device testing must eventually be required for v0.1.',
    'Post-v0.1 physical-device testing must still remain required for v0.1.',
    'Post-v0.1 physical-device testing must automatically become required for v0.1.',
    'v0.1 requires physical-device testing before post-v0.1 documentation begins.',
    'v0.1 requires physical-device testing not required after release.',
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
    'v0.1 treats any physical-device testing as required.',
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
    'Post-v0.1 work mandates physical-device testing.',
    'Post-v0.1 work demands physical-device testing.',
    'Post-v0.1 work calls for physical-device testing.',
    'Post-v0.1 work needs physical-device testing.',
    'Post-v0.1 work has to test on physical devices.',
    'v0.1 does not mandate physical-device testing.',
    'v0.1 does not demand physical-device testing.',
    'v0.1 does not need physical-device testing.',
    "v0.1 doesn't need physical-device testing.",
    'v0.1 does not have to test on physical devices.',
    'v0.1 does not treat physical-device testing as required.',
    'v0.1 does not classify physical-device testing as mandatory.',
    "v0.1 doesn't count physical-device testing as a requirement.",
    'v0.1 doesn’t describe physical-device testing as being required.',
    'v0.1 does not treat the physical-device testing as required.',
    'v0.1 does not classify any physical-device testing as mandatory.',
    'v0.1 does not count these physical-device tests as requirements.',
    'v0.1 does not treat its physical-device testing as required.',
    'v0.1 does not classify our physical-device tests as mandatory.',
    "v0.1 does not count the team's physical-device tests as requirements.",
    'Physical-device testing is not mandated for v0.1.',
    'Physical-device testing is not compulsory for v0.1.',
    'Physical-device testing is not obligatory for v0.1.',
    'Physical-device testing is not necessary for v0.1.',
    'Physical-device testing is not needed for v0.1.',
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
    'Physical-device testing need not occur for v0.1.',
    'Physical-device testing need never happen for v0.1.',
    'Physical-device testing need not ever take place for v0.1.',
    'Physical-device testing need not be required for v0.1.',
    'Physical-device testing on both platforms need not occur for v0.1.',
    'Physical-device testing itself normally need not occur for v0.1.',
    'Physical-device testing generally need not occur for v0.1.',
    'Physical-device testing unexpectedly need never happen for v0.1.',
    'Validation on physical devices across both platforms need never happen for v0.1.',
    'Physical-device testing on both iOS and Android need not take place for v0.1.',
    'Physical-device testing need not occur although documentation is required for v0.1.',
    'Physical-device testing need not occur; documentation is required for v0.1.',
    'Physical-device testing is optional; documentation will be required for v0.1.',
    'Physical-device testing need not occur, but assembly is required for v0.1.',
    'Physical-device testing need not occur, but supply is required for v0.1.',
    'Physical-device testing need not occur, but family is required for v0.1.',
    'Physical-device testing need not occur, but assembly remains required for v0.1.',
    'Physical-device testing need not occur, but supply will be required for v0.1.',
    'Physical-device testing need not occur, but family becomes mandatory for v0.1.',
    'Physical-device testing need not occur, but July remains mandatory for v0.1.',
    'Physical-device testing need not occur, but anomaly remains mandatory for v0.1.',
    'Physical-device testing need not occur, but monopoly remains mandatory for v0.1.',
    'Physical-device testing need not occur, but butterfly remains mandatory for v0.1.',
    'Physical-device testing need not occur, but nightly remains mandatory for v0.1.',
    'Physical-device testing is no longer required for v0.1.',
    'Physical-device testing will no longer be mandatory for v0.1.',
    'Physical-device testing need not occur, but will no longer be mandatory for v0.1.',
    'Physical-device testing will soon no longer be mandatory for v0.1.',
    'Physical-device testing will eventually no longer be mandatory for v0.1.',
    'Physical-device testing may now no longer be mandatory for v0.1.',
    'Physical-device testing will very soon no longer be mandatory for v0.1.',
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
    'v0.1 documentation is required before post-v0.1 physical-device testing workflows proceed.',
    'v0.1 documentation is required before post-v0.1 physical-device testing workflows scheduled offline proceed.',
    'v0.1 documentation is required before post-v0.1 physical-device testing workflows scheduled to run offline proceed.',
    'v0.1 documentation is required before post-v0.1 physical-device testing workflows scheduled to always run offline proceed.',
    'v0.1 documentation is required before post-v0.1 physical-device testing workflows scheduled to just run offline proceed.',
    'v0.1 documentation is required before post-v0.1 physical-device validation plans begin.',
    'v0.1 documentation is required before post-v0.1 physical-device testing procedures start.',
    'Post-v0.1 physical-device testing proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing scans logs before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing checks results before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing captures metrics before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing reports results before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing measures latency before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing retries failures before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing workflows failed before release notes become mandatory in v0.1.',
    'Post-v0.1 physical-device testing workflows happened before release notes become mandatory in v0.1.',
    'Post-v0.1 physical-device testing workflows occurred before release notes become mandatory in v0.1.',
    'Post-v0.1 physical-device testing failed before documentation is required for v0.1.',
    'Post-v0.1 physical-device tests failed before documentation is required for v0.1.',
    'Post-v0.1 physical-device tests failed before release notes are required for v0.1.',
    'Post-v0.1 physical-device tests failed before builds are required for v0.1.',
    'Post-v0.1 physical-device tests failed before the release becomes required for v0.1.',
    'Post-v0.1 physical-device tests failed before release notes remain mandatory in v0.1.',
    'Post-v0.1 physical-device tests failed before release notes will be mandatory in v0.1.',
    'Post-v0.1 physical-device tests failed before release notes will soon be mandatory in v0.1.',
    'Post-v0.1 physical-device tests failed before release notes will eventually become mandatory in v0.1.',
    'Post-v0.1 physical-device tests failed before release notes will very soon be mandatory in v0.1.',
    'Post-v0.1 physical-device testing completed before documentation will be required in v0.1.',
    'Post-v0.1 physical-device testing failed before personnel are required for v0.1.',
    'Post-v0.1 physical-device testing failed before staff are required for v0.1.',
    'Post-v0.1 physical-device testing that runs offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing that can run offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing to run nightly proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing performed offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing begins before release and v0.1 documentation is required.',
    'Post-v0.1 physical-device testing that runs on devices proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing that uses workflows proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing whose scheduler runs offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device validation done offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing guaranteed offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing by operators who work offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing with a workflow which runs offline proceeds before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing began before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing became available before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing ran before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing uses devices before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing stopped before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed all checks before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed successfully before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing executed all checks before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed all checks by QA before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed successfully by Tuesday before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed by Final Release before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed by Release Candidate before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed by Next Tuesday before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing completed by Next Sprint before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing proceeded before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing launched before v0.1 documentation is required.',
    'Post-v0.1 physical-device testing proceeds, and v0.1 documentation is required.',
    'Physical-device testing begins before release and v0.1 documentation is required.',
    'Physical-device testing begins before release and documentation is required.',
    'Post-v0.1 physical-device testing begins before release and v0.1 documentation must be required.',
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
    'Post-v0.1 requirements:\n- Documentation:\n  - Physical-device testing is required.',
    'v0.1 release:\n- Physical-device testing is not required.',
    'Post-v0.1 requirements:\n- v0.1 release:\n  - Documentation is required.\n- Physical-device testing is required.',
    'For post-v0.1 work:\n- Documentation is required.\n\nPhysical-device testing is not required.',
    '> Post-v0.1 requirements:\n> - Documentation is required.\n> - Physical-device testing is required.',
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
    'Post-v0.1 requirements:\n- v0.1 release:\n  - Physical-device testing is required.',
    'Post-v0.1 requirements:\n- For v0.1 work:\n  - Physical-device testing is required.',
    'Post-v0.1 requirements:\n  - ## v0.1 verification:\n    - Physical-device testing is required.',
    'For post-v0.1 work:\n- Documentation is required.\n\nPhysical-device testing is required.',
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
