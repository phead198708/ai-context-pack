import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowRoot = join(repositoryRoot, '.github', 'workflows');
const linuxWorkflow = readFileSync(join(workflowRoot, 'linux.yml'), 'utf8');
const macosWorkflow = readFileSync(join(workflowRoot, 'macos.yml'), 'utf8');
const packageManifest = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
);
const packageLock = JSON.parse(
  readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'),
);
const androidNativeBuild = readFileSync(
  join(repositoryRoot, 'modules/context-native/android/build.gradle'),
  'utf8',
);
const developmentSetup = readFileSync(
  join(repositoryRoot, 'docs/development/setup.md'),
  'utf8',
);
const architectureDecision = readFileSync(
  join(repositoryRoot, 'docs/adr/0001-react-native-cross-platform.md'),
  'utf8',
);
const api24InstrumentationPath = join(
  repositoryRoot,
  'scripts',
  'run-android-api24-instrumentation.sh',
);
const api24Instrumentation = readFileSync(api24InstrumentationPath, 'utf8');
const rubyVersion = readFileSync(
  join(repositoryRoot, '.ruby-version'),
  'utf8',
).trim();
const cocoaPodsShimPath = join(
  repositoryRoot,
  'scripts',
  'cocoapods-bin',
  'pod',
);
const cocoaPodsShim = readFileSync(cocoaPodsShimPath, 'utf8');
const workflows = readdirSync(workflowRoot)
  .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

if (JSON.stringify(workflows) !== JSON.stringify(['linux.yml', 'macos.yml'])) {
  throw new Error('WORKFLOW_INVENTORY_INVALID');
}

const all = workflows
  .map(name => readFileSync(join(workflowRoot, name), 'utf8'))
  .join('\n');
const forbiddenPatterns = [
  /\bsecrets\s*\./i,
  /\bsecrets\s*\[/i,
  /\bsecrets\s*:\s*inherit\b/i,
  // Reject the identifier anywhere in workflow source, including comments and quoted/braced
  // expressions, so source formatting cannot create a parser-boundary bypass.
  /\bsecrets\b/i,
];
const secretPolicyExamples = [
  '${{ secrets.TOKEN }}',
  "${{ secrets['TOKEN'] }}",
  '${{ toJSON(secrets) }}',
  "${{ format('{0}', toJSON(secrets)) }}",
  'secrets: inherit',
];
if (
  secretPolicyExamples.some(
    example => !forbiddenPatterns.some(pattern => pattern.test(example)),
  )
) {
  throw new Error('WORKFLOW_SECRET_POLICY_SELF_TEST_FAILED');
}

const permissionScopes = new Set([
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'security-events',
  'statuses',
]);
const isRecord = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const allowedWorkflowTriggers = new Set([
  'pull_request',
  'push',
  'workflow_dispatch',
]);
const immutableActionReferencePattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
const expectedAndroidInstrumentationRunCommands = [
  '"${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" "emulator" "system-images;android-24;default;x86_64" "system-images;android-34;default;x86_64" "system-images;android-35;default;x86_64"',
  'sudo chown "$(id -u):$(id -g)" /dev/kvm test -r /dev/kvm test -w /dev/kvm',
  'scripts/run-android-api24-instrumentation.sh',
  './android/gradlew -p android --no-daemon --stacktrace -PreactNativeArchitectures=x86_64 :context-native:ciApi34DebugAndroidTest :context-native:ciApi35DebugAndroidTest',
];
const allowedLinuxWorkflowEnvironment = new Set([
  'NODE_VERSION',
  'NPM_VERSION',
  'JAVA_VERSION',
  'NODE_ENV',
]);
const allowedMacosWorkflowEnvironment = new Set([
  'NODE_VERSION',
  'NPM_VERSION',
  'NODE_ENV',
  'DEVELOPER_DIR',
]);
const expectedGatedExecutionDigests = {
  'linux.yml': {
    jobId: 'android',
    digest: 'b64bac1d872c9a52432d7fca81fcce8b23ae1b55b37ab8508fcbc4b0d2d02e46',
  },
  'macos.yml': {
    jobId: 'ios',
    digest: 'b39d8b1e7b596fd4ef08bbf372b209fd1b0521953098c9f5cec405772d09f5af',
  },
};
const expectedNpmAuditJobDigest =
  '899c9b0d4d8244c9d3b9938be03368fcf844db659a6a70f64d99a97b608e7bed';

function parseWorkflow(source, name) {
  try {
    return parse(source, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    throw new Error(`WORKFLOW_YAML_INVALID:${name}`);
  }
}

function containsRawNpmAudit(command) {
  const normalized = command.replace(/\\\r?\n/g, ' ');
  const segments = normalized.split(/(?:&&|\|\||[;|&()\n])/);
  for (const segment of segments) {
    const tokens = segment.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
    for (const [index, rawToken] of tokens.entries()) {
      const token = rawToken.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
      if (token !== 'npm' && !token.endsWith('/npm')) continue;
      const argumentsAfterNpm = tokens
        .slice(index + 1)
        .map(candidate =>
          candidate.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'),
        );
      if (argumentsAfterNpm.includes('audit')) return true;
    }
  }
  return false;
}

function assertNpmAuditPolicyWorkflow(source, name) {
  const workflow = parseWorkflow(source, name);
  const shared = workflow?.jobs?.shared;
  if (
    !isRecord(workflow) ||
    !isRecord(workflow.jobs) ||
    !isRecord(shared) ||
    shared.name !== 'Shared' ||
    shared['runs-on'] !== 'ubuntu-24.04' ||
    shared['timeout-minutes'] !== 30 ||
    !Array.isArray(shared.steps)
  ) {
    throw new Error(`WORKFLOW_NPM_AUDIT_POLICY_INVALID:${name}:structure`);
  }
  for (const property of [
    'if',
    'continue-on-error',
    'needs',
    'strategy',
    'container',
    'services',
    'defaults',
    'env',
  ]) {
    if (Object.hasOwn(shared, property)) {
      throw new Error(
        `WORKFLOW_NPM_AUDIT_POLICY_INVALID:${name}:shared:${property}`,
      );
    }
  }

  const references = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const [index, step] of job.steps.entries()) {
      if (!isRecord(step) || typeof step.run !== 'string') continue;
      if (containsRawNpmAudit(step.run)) {
        throw new Error(
          `WORKFLOW_NPM_AUDIT_POLICY_INVALID:${name}:${jobId}:${index}:raw`,
        );
      }
      if (/\baudit:ci\b/.test(step.run)) {
        references.push({ jobId, index, step });
      }
    }
  }
  if (references.length !== 1) {
    throw new Error(`WORKFLOW_NPM_AUDIT_POLICY_INVALID:${name}:count`);
  }
  const [{ jobId, index, step }] = references;
  if (
    jobId !== 'shared' ||
    step.name !== 'Audit high-severity npm findings' ||
    step.run.trim() !== 'npm run audit:ci' ||
    JSON.stringify(Object.keys(step).sort()) !== JSON.stringify(['name', 'run'])
  ) {
    throw new Error(
      `WORKFLOW_NPM_AUDIT_POLICY_INVALID:${name}:${jobId}:${index}:gate`,
    );
  }
}

function canonicalizeForDigest(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonicalizeForDigest(value[key])]),
  );
}

function assertGatedExecutionStructure(
  source,
  name,
  jobId,
  expectedDigest,
  gateError,
) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}`);
  }
  const job = workflow.jobs[jobId];
  if (!isRecord(job)) {
    throw new Error(`${gateError}:${name}:${jobId}:structure`);
  }
  const executionStructure = {
    workflowEnvironment: workflow.env ?? null,
    job,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(executionStructure)))
    .digest('hex');
  if (digest !== expectedDigest) {
    throw new Error(`${gateError}:${name}:${jobId}:structure`);
  }
}

function assertWorkflowSecrets(source, name) {
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.test(source)) {
      throw new Error(`WORKFLOW_PRIVILEGE_INVALID:${name}:${forbidden.source}`);
    }
  }
  const decodedWorkflow = JSON.stringify(parseWorkflow(source, name));
  if (/\bsecrets\b/i.test(decodedWorkflow)) {
    throw new Error(`WORKFLOW_PRIVILEGE_INVALID:${name}:decoded-secrets`);
  }
}

function assertPermissionMapping(permissions, location, root = false) {
  if (!isRecord(permissions)) {
    throw new Error(`WORKFLOW_PERMISSION_INVALID:${location}`);
  }
  const entries = Object.entries(permissions);
  if (
    root &&
    (entries.length !== 1 ||
      entries[0][0] !== 'contents' ||
      entries[0][1] !== 'read')
  ) {
    throw new Error(`WORKFLOW_PERMISSION_INVALID:${location}`);
  }
  for (const [scope, access] of entries) {
    if (!permissionScopes.has(scope) || typeof access !== 'string') {
      throw new Error(`WORKFLOW_PERMISSION_INVALID:${location}:${scope}`);
    }
    if (access === 'none') continue;
    if (scope === 'contents' && access === 'read') continue;
    throw new Error(`WORKFLOW_PERMISSION_INVALID:${location}:${scope}`);
  }
}

function assertWorkflowPermissions(source, name) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}`);
  }
  assertPermissionMapping(workflow.permissions, `${name}:root`, true);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) {
      throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}:${jobName}`);
    }
    if (Object.hasOwn(job, 'permissions')) {
      assertPermissionMapping(job.permissions, `${name}:${jobName}`);
    }
  }
}

function assertWorkflowTriggers(source, name) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.on)) {
    throw new Error(`WORKFLOW_TRIGGER_INVALID:${name}`);
  }
  for (const trigger of Object.keys(workflow.on)) {
    if (!allowedWorkflowTriggers.has(trigger)) {
      throw new Error(`WORKFLOW_TRIGGER_INVALID:${name}:${trigger}`);
    }
  }
  for (const requiredTrigger of ['pull_request', 'push']) {
    if (!Object.hasOwn(workflow.on, requiredTrigger)) {
      throw new Error(`WORKFLOW_TRIGGER_MISSING:${name}:${requiredTrigger}`);
    }
  }
  const pullRequest = workflow.on.pull_request;
  if (
    pullRequest !== null &&
    (!isRecord(pullRequest) || Object.keys(pullRequest).length !== 0)
  ) {
    throw new Error(`WORKFLOW_TRIGGER_SCOPE_INVALID:${name}:pull_request`);
  }
  const push = workflow.on.push;
  if (
    !isRecord(push) ||
    Object.keys(push).length !== 1 ||
    !Array.isArray(push.branches) ||
    push.branches.length !== 1 ||
    push.branches[0] !== 'main'
  ) {
    throw new Error(`WORKFLOW_TRIGGER_SCOPE_INVALID:${name}:push`);
  }
}

function assertWorkflowActions(source, name) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}`);
  }
  const actionReferences = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) {
      throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}:${jobName}`);
    }
    if (Object.hasOwn(job, 'uses')) {
      actionReferences.push(job.uses);
    }
    if (!Object.hasOwn(job, 'steps')) continue;
    if (!Array.isArray(job.steps)) {
      throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}:${jobName}:steps`);
    }
    for (const [stepIndex, step] of job.steps.entries()) {
      if (!isRecord(step)) {
        throw new Error(
          `WORKFLOW_STRUCTURE_INVALID:${name}:${jobName}:steps:${stepIndex}`,
        );
      }
      if (Object.hasOwn(step, 'uses')) {
        actionReferences.push(step.uses);
      }
    }
  }
  if (
    actionReferences.length === 0 ||
    actionReferences.some(
      value =>
        typeof value !== 'string' ||
        !immutableActionReferencePattern.test(value),
    )
  ) {
    throw new Error(`WORKFLOW_ACTION_NOT_SHA_PINNED:${name}`);
  }
}

function assertWorkflowCheckNames(source, name, expectedNames) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}`);
  }
  const actualNames = Object.values(workflow.jobs)
    .map(job => (isRecord(job) ? job.name : undefined))
    .sort();
  const sortedExpectedNames = [...expectedNames].sort();
  if (
    actualNames.some(jobName => typeof jobName !== 'string') ||
    JSON.stringify(actualNames) !== JSON.stringify(sortedExpectedNames)
  ) {
    throw new Error(`WORKFLOW_CHECK_NAMES_INVALID:${name}`);
  }
}

function normalizeRunCommand(command) {
  return command.trim().replace(/\s+/g, ' ');
}

function assertDefaultRunContextIsUnmodified(
  container,
  name,
  scope,
  gateError = 'WORKFLOW_ANDROID_INSTRUMENTATION_GATE_INVALID',
) {
  if (!Object.hasOwn(container, 'defaults')) return;
  if (!isRecord(container.defaults)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}:${scope}:defaults`);
  }
  if (!Object.hasOwn(container.defaults, 'run')) return;
  if (!isRecord(container.defaults.run)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}:${scope}:defaults:run`);
  }
  for (const property of ['shell', 'working-directory']) {
    if (Object.hasOwn(container.defaults.run, property)) {
      throw new Error(`${gateError}:${name}:${scope}:${property}`);
    }
  }
}

function assertRunEnvironmentIsSafe(
  container,
  name,
  scope,
  gateError,
  allowedKeys = new Set(),
) {
  if (!Object.hasOwn(container, 'env')) return;
  if (!isRecord(container.env)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}:${scope}:env`);
  }
  for (const key of Object.keys(container.env)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${gateError}:${name}:${scope}:env:${key}`);
    }
  }
}

function assertNoRunnerEnvironmentMutation(steps, name, scope, gateError) {
  const decodedSteps = JSON.stringify(steps);
  const forbidden = decodedSteps.match(
    /\b(?:BASH_ENV|GITHUB_ENV|GITHUB_PATH)\b/i,
  );
  if (forbidden) {
    throw new Error(
      `${gateError}:${name}:${scope}:runner-environment:${forbidden[0].toUpperCase()}`,
    );
  }
}

function assertAndroidInstrumentationSteps(source, name) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}`);
  }
  const gateError = 'WORKFLOW_ANDROID_INSTRUMENTATION_GATE_INVALID';
  assertDefaultRunContextIsUnmodified(workflow, name, 'workflow');
  assertRunEnvironmentIsSafe(
    workflow,
    name,
    'workflow',
    gateError,
    allowedLinuxWorkflowEnvironment,
  );
  const androidJobs = Object.entries(workflow.jobs).filter(
    ([, job]) => isRecord(job) && job.name === 'Android',
  );
  if (androidJobs.length !== 1) {
    throw new Error(`WORKFLOW_ANDROID_INSTRUMENTATION_MISSING:${name}:job`);
  }
  const [androidJobId, androidJob] = androidJobs[0];
  if (androidJob['runs-on'] !== 'ubuntu-24.04') {
    throw new Error(`${gateError}:${name}:${androidJobId}:runs-on`);
  }
  for (const property of [
    'if',
    'continue-on-error',
    'needs',
    'strategy',
    'container',
    'services',
  ]) {
    if (Object.hasOwn(androidJob, property)) {
      throw new Error(`${gateError}:${name}:${androidJobId}:${property}`);
    }
  }
  assertDefaultRunContextIsUnmodified(androidJob, name, androidJobId);
  assertRunEnvironmentIsSafe(androidJob, name, androidJobId, gateError);
  if (!Array.isArray(androidJob.steps)) {
    throw new Error(
      `WORKFLOW_ANDROID_INSTRUMENTATION_MISSING:${name}:${androidJobId}:steps`,
    );
  }
  assertNoRunnerEnvironmentMutation(
    androidJob.steps,
    name,
    androidJobId,
    gateError,
  );
  const runSteps = androidJob.steps.map((step, stepIndex) => {
    if (!isRecord(step)) {
      throw new Error(
        `WORKFLOW_STRUCTURE_INVALID:${name}:${androidJobId}:steps:${stepIndex}`,
      );
    }
    if (!Object.hasOwn(step, 'run')) return undefined;
    if (typeof step.run !== 'string') {
      throw new Error(
        `WORKFLOW_STRUCTURE_INVALID:${name}:${androidJobId}:steps:${stepIndex}:run`,
      );
    }
    return { command: normalizeRunCommand(step.run), step, stepIndex };
  });
  for (const command of expectedAndroidInstrumentationRunCommands) {
    const matches = runSteps.filter(runStep => runStep?.command === command);
    if (matches.length !== 1) {
      throw new Error(`WORKFLOW_ANDROID_INSTRUMENTATION_MISSING:${name}:steps`);
    }
    const [{ step, stepIndex }] = matches;
    for (const property of [
      'if',
      'continue-on-error',
      'shell',
      'working-directory',
    ]) {
      if (Object.hasOwn(step, property)) {
        throw new Error(
          `WORKFLOW_ANDROID_INSTRUMENTATION_GATE_INVALID:${name}:${androidJobId}:steps:${stepIndex}:${property}`,
        );
      }
    }
    assertRunEnvironmentIsSafe(
      step,
      name,
      `${androidJobId}:steps:${stepIndex}`,
      gateError,
    );
  }
}

function assertMacosSharedTestStep(source, name) {
  const workflow = parseWorkflow(source, name);
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`WORKFLOW_STRUCTURE_INVALID:${name}`);
  }
  const gateError = 'WORKFLOW_MACOS_SHARED_TEST_GATE_INVALID';
  assertDefaultRunContextIsUnmodified(workflow, name, 'workflow', gateError);
  assertRunEnvironmentIsSafe(
    workflow,
    name,
    'workflow',
    gateError,
    allowedMacosWorkflowEnvironment,
  );
  const iosJobs = Object.entries(workflow.jobs).filter(
    ([, job]) => isRecord(job) && job.name === 'iOS app & Share Extension',
  );
  if (iosJobs.length !== 1) {
    throw new Error(`WORKFLOW_MACOS_SHARED_TEST_MISSING:${name}:job`);
  }
  const [iosJobId, iosJob] = iosJobs[0];
  if (iosJob['runs-on'] !== 'macos-26') {
    throw new Error(`${gateError}:${name}:${iosJobId}:runs-on`);
  }
  for (const property of [
    'if',
    'continue-on-error',
    'needs',
    'strategy',
    'container',
    'services',
  ]) {
    if (Object.hasOwn(iosJob, property)) {
      throw new Error(`${gateError}:${name}:${iosJobId}:${property}`);
    }
  }
  assertDefaultRunContextIsUnmodified(iosJob, name, iosJobId, gateError);
  assertRunEnvironmentIsSafe(iosJob, name, iosJobId, gateError);
  if (!Array.isArray(iosJob.steps)) {
    throw new Error(
      `WORKFLOW_MACOS_SHARED_TEST_MISSING:${name}:${iosJobId}:steps`,
    );
  }
  assertNoRunnerEnvironmentMutation(iosJob.steps, name, iosJobId, gateError);
  const matches = iosJob.steps
    .map((step, stepIndex) => {
      if (!isRecord(step)) {
        throw new Error(
          `WORKFLOW_STRUCTURE_INVALID:${name}:${iosJobId}:steps:${stepIndex}`,
        );
      }
      if (!Object.hasOwn(step, 'run')) return undefined;
      if (typeof step.run !== 'string') {
        throw new Error(
          `WORKFLOW_STRUCTURE_INVALID:${name}:${iosJobId}:steps:${stepIndex}:run`,
        );
      }
      return { command: normalizeRunCommand(step.run), step, stepIndex };
    })
    .filter(runStep => runStep?.command === 'npm test -- --ci');
  if (matches.length !== 1) {
    throw new Error(
      `WORKFLOW_MACOS_SHARED_TEST_MISSING:${name}:${iosJobId}:step`,
    );
  }
  const [{ step, stepIndex }] = matches;
  for (const property of [
    'if',
    'continue-on-error',
    'shell',
    'working-directory',
  ]) {
    if (Object.hasOwn(step, property)) {
      throw new Error(
        `${gateError}:${name}:${iosJobId}:steps:${stepIndex}:${property}`,
      );
    }
  }
  assertRunEnvironmentIsSafe(
    step,
    name,
    `${iosJobId}:steps:${stepIndex}`,
    gateError,
  );
}

const permissionPolicyRejectedExamples = [
  'permissions: { contents: "write" }\njobs: { test: { runs-on: ubuntu-latest } }',
  "permissions: 'write-all'\njobs: { test: { runs-on: ubuntu-latest } }",
  "permissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    permissions: { contents: 'write' }",
  'permissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    permissions: { actions: read }',
];
for (const [index, example] of permissionPolicyRejectedExamples.entries()) {
  let rejectedByPermissionPolicy = false;
  try {
    assertWorkflowPermissions(example, `self-test-rejected-${index}`);
  } catch (error) {
    rejectedByPermissionPolicy =
      error instanceof Error &&
      error.message.startsWith('WORKFLOW_PERMISSION_INVALID:');
  }
  if (!rejectedByPermissionPolicy) {
    throw new Error('WORKFLOW_PERMISSION_POLICY_SELF_TEST_FAILED');
  }
}
assertWorkflowPermissions(
  'permissions: { contents: "read" }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    permissions: { contents: "none" }',
  'self-test-allowed',
);

const triggerPolicyRejectedExamples = [
  'on:\n  pull_request:\n  push: { branches: [main] }\n  "pull_request_target":\n',
  'on:\n  pull_request:\n  workflow_dispatch:\n',
  'on:\n  pull_request: { branches: [release-only] }\n  push: { branches: [main] }\n',
  'on:\n  pull_request:\n  push: { branches: [release-only] }\n',
];
for (const [index, example] of triggerPolicyRejectedExamples.entries()) {
  let rejectedByTriggerPolicy = false;
  try {
    assertWorkflowTriggers(example, `self-test-rejected-${index}`);
  } catch (error) {
    rejectedByTriggerPolicy =
      error instanceof Error &&
      (error.message.startsWith('WORKFLOW_TRIGGER_INVALID:') ||
        error.message.startsWith('WORKFLOW_TRIGGER_MISSING:') ||
        error.message.startsWith('WORKFLOW_TRIGGER_SCOPE_INVALID:'));
  }
  if (!rejectedByTriggerPolicy) {
    throw new Error('WORKFLOW_TRIGGER_POLICY_SELF_TEST_FAILED');
  }
}
assertWorkflowTriggers(
  'on:\n  pull_request:\n  push: { branches: [main] }\n  workflow_dispatch:\n',
  'self-test-allowed',
);

const decodedSecretPolicyExample =
  'jobs:\n  test:\n    steps:\n      - run: "${{ secr\\u0065ts.TOKEN }}"\n';
if (
  forbiddenPatterns.some(pattern => pattern.test(decodedSecretPolicyExample))
) {
  throw new Error('WORKFLOW_SECRET_DECODED_SELF_TEST_INVALID');
}
let decodedSecretRejected = false;
try {
  assertWorkflowSecrets(decodedSecretPolicyExample, 'self-test-rejected');
} catch (error) {
  decodedSecretRejected =
    error instanceof Error &&
    error.message ===
      'WORKFLOW_PRIVILEGE_INVALID:self-test-rejected:decoded-secrets';
}
if (!decodedSecretRejected) {
  throw new Error('WORKFLOW_SECRET_DECODED_SELF_TEST_FAILED');
}

const actionPolicyRejectedExamples = [
  'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - "uses": owner/action@main\n',
  'jobs:\n  test:\n    uses: owner/action@main@0123456789abcdef0123456789abcdef01234567\n',
];
for (const [index, example] of actionPolicyRejectedExamples.entries()) {
  let mutableActionRejected = false;
  try {
    assertWorkflowActions(example, `self-test-rejected-${index}`);
  } catch (error) {
    mutableActionRejected =
      error instanceof Error &&
      error.message ===
        `WORKFLOW_ACTION_NOT_SHA_PINNED:self-test-rejected-${index}`;
  }
  if (!mutableActionRejected) {
    throw new Error('WORKFLOW_ACTION_POLICY_SELF_TEST_FAILED');
  }
}
assertWorkflowActions(
  'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - "uses": owner/action@0123456789abcdef0123456789abcdef01234567\n',
  'self-test-allowed',
);

const expectedWorkflowCheckNames = {
  'linux.yml': [
    'Shared',
    'Contracts & privacy',
    'Android',
    'Dependency review',
  ],
  'macos.yml': ['iOS app & Share Extension'],
};
let renamedCheckRejected = false;
try {
  assertWorkflowCheckNames(
    'jobs:\n  shared:\n    name: Shared checks # name: Shared\n    runs-on: ubuntu-latest\n',
    'self-test-rejected',
    ['Shared'],
  );
} catch (error) {
  renamedCheckRejected =
    error instanceof Error &&
    error.message === 'WORKFLOW_CHECK_NAMES_INVALID:self-test-rejected';
}
if (!renamedCheckRejected) {
  throw new Error('WORKFLOW_CHECK_NAMES_SELF_TEST_FAILED');
}
assertWorkflowCheckNames(
  'jobs:\n  shared:\n    "name": Shared\n    runs-on: ubuntu-latest\n',
  'self-test-allowed',
  ['Shared'],
);

const androidInstrumentationCommentOnlyExample = `
jobs:
  android:
    name: Android
    runs-on: ubuntu-24.04
    steps:
      - run: echo no-instrumentation
${expectedAndroidInstrumentationRunCommands
  .map(command => `# run: ${command}`)
  .join('\n')}
`;
const androidInstrumentationWrongJobExample = JSON.stringify({
  jobs: {
    android: {
      name: 'Android',
      'runs-on': 'ubuntu-24.04',
      steps: [{ run: 'echo no-instrumentation' }],
    },
    unrelated: {
      name: 'Unrelated',
      runsOn: 'ubuntu-latest',
      steps: expectedAndroidInstrumentationRunCommands.map(run => ({ run })),
    },
  },
});
for (const [index, example] of [
  androidInstrumentationCommentOnlyExample,
  androidInstrumentationWrongJobExample,
].entries()) {
  let missingInstrumentationRejected = false;
  try {
    assertAndroidInstrumentationSteps(example, `self-test-rejected-${index}`);
  } catch (error) {
    missingInstrumentationRejected =
      error instanceof Error &&
      error.message.startsWith(
        `WORKFLOW_ANDROID_INSTRUMENTATION_MISSING:self-test-rejected-${index}:`,
      );
  }
  if (!missingInstrumentationRejected) {
    throw new Error('WORKFLOW_ANDROID_INSTRUMENTATION_SELF_TEST_FAILED');
  }
}
assertAndroidInstrumentationSteps(
  JSON.stringify({
    jobs: {
      android: {
        name: 'Android',
        'runs-on': 'ubuntu-24.04',
        steps: expectedAndroidInstrumentationRunCommands.map(run => ({ run })),
      },
    },
  }),
  'self-test-allowed',
);

function instrumentationWorkflowWithMutation(mutate) {
  const workflow = {
    jobs: {
      android: {
        name: 'Android',
        'runs-on': 'ubuntu-24.04',
        steps: expectedAndroidInstrumentationRunCommands.map(run => ({ run })),
      },
    },
  };
  mutate(workflow);
  return JSON.stringify(workflow);
}

const androidInstrumentationGateRejectedExamples = [
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android['runs-on'] = 'self-hosted';
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.if = false;
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android['continue-on-error'] = true;
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.needs = 'dependency-review';
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.strategy = { matrix: { include: [] } };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.container = 'untrusted/image:latest';
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.services = { fake: { image: 'fake:latest' } };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.env = { BASH_ENV: './nested/change-directory.sh' };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.env = {
      BASH_ENV: './nested/change-directory.sh',
    };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps.unshift({
      run: 'printf "BASH_ENV=./nested/startup.sh\\n" >> "$GITHUB_ENV"',
    });
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps.unshift({
      run: 'printf "./nested/bin\\n" >> "$GITHUB_PATH"',
    });
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps.unshift({
      run: 'echo harmless',
      env: { BASH_ENV: './nested/startup.sh' },
    });
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.defaults = { run: { shell: 'echo {0}' } };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.defaults = { run: { shell: 'echo {0}' } };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.defaults = { run: { 'working-directory': 'nested' } };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.defaults = {
      run: { 'working-directory': 'nested' },
    };
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps[0].if = false;
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps[0]['continue-on-error'] = true;
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps[0].shell = 'echo {0}';
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps[0]['working-directory'] = 'nested';
  }),
  instrumentationWorkflowWithMutation(workflow => {
    workflow.jobs.android.steps[0].env = {
      BASH_ENV: './nested/change-directory.sh',
    };
  }),
];
for (const [
  index,
  example,
] of androidInstrumentationGateRejectedExamples.entries()) {
  let unsafeGateRejected = false;
  try {
    assertAndroidInstrumentationSteps(
      example,
      `self-test-unsafe-gate-${index}`,
    );
  } catch (error) {
    unsafeGateRejected =
      error instanceof Error &&
      error.message.startsWith(
        `WORKFLOW_ANDROID_INSTRUMENTATION_GATE_INVALID:self-test-unsafe-gate-${index}:`,
      );
  }
  if (!unsafeGateRejected) {
    throw new Error('WORKFLOW_ANDROID_INSTRUMENTATION_GATE_SELF_TEST_FAILED');
  }
}

const macosSharedTestCommentOnlyExample = `
jobs:
  ios:
    name: iOS app & Share Extension
    runs-on: macos-26
    steps:
      - run: echo no-shared-tests
# run: npm test -- --ci
`;
const macosSharedTestWrongJobExample = JSON.stringify({
  jobs: {
    ios: {
      name: 'iOS app & Share Extension',
      'runs-on': 'macos-26',
      steps: [{ run: 'echo no-shared-tests' }],
    },
    unrelated: {
      name: 'Unrelated',
      runsOn: 'ubuntu-latest',
      steps: [{ run: 'npm test -- --ci' }],
    },
  },
});
for (const [index, example] of [
  macosSharedTestCommentOnlyExample,
  macosSharedTestWrongJobExample,
].entries()) {
  let missingMacosSharedTestRejected = false;
  try {
    assertMacosSharedTestStep(example, `self-test-macos-missing-${index}`);
  } catch (error) {
    missingMacosSharedTestRejected =
      error instanceof Error &&
      error.message.startsWith(
        `WORKFLOW_MACOS_SHARED_TEST_MISSING:self-test-macos-missing-${index}:`,
      );
  }
  if (!missingMacosSharedTestRejected) {
    throw new Error('WORKFLOW_MACOS_SHARED_TEST_SELF_TEST_FAILED');
  }
}

function macosSharedTestWorkflowWithMutation(mutate) {
  const workflow = {
    jobs: {
      ios: {
        name: 'iOS app & Share Extension',
        'runs-on': 'macos-26',
        steps: [{ run: 'npm test -- --ci' }],
      },
    },
  };
  mutate(workflow);
  return JSON.stringify(workflow);
}

const macosSharedTestGateRejectedExamples = [
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios['runs-on'] = 'self-hosted';
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.if = false;
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.needs = 'unrelated';
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios['continue-on-error'] = true;
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.strategy = { matrix: { include: [] } };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.container = 'untrusted/image:latest';
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.services = { fake: { image: 'fake:latest' } };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.env = { BASH_ENV: './nested/change-directory.sh' };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.env = { BASH_ENV: './nested/change-directory.sh' };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps.unshift({
      run: 'printf "BASH_ENV=./nested/startup.sh\\n" >> "$GITHUB_ENV"',
    });
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps.unshift({
      run: 'printf "./nested/bin\\n" >> "$GITHUB_PATH"',
    });
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps.unshift({
      run: 'echo harmless',
      env: { BASH_ENV: './nested/startup.sh' },
    });
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.defaults = { run: { shell: 'echo {0}' } };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.defaults = { run: { shell: 'echo {0}' } };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.defaults = { run: { 'working-directory': 'nested' } };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.defaults = { run: { 'working-directory': 'nested' } };
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps[0].if = false;
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps[0]['continue-on-error'] = true;
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps[0].shell = 'echo {0}';
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps[0]['working-directory'] = 'nested';
  }),
  macosSharedTestWorkflowWithMutation(workflow => {
    workflow.jobs.ios.steps[0].env = {
      BASH_ENV: './nested/change-directory.sh',
    };
  }),
];
for (const [index, example] of macosSharedTestGateRejectedExamples.entries()) {
  let unsafeMacosSharedTestRejected = false;
  try {
    assertMacosSharedTestStep(example, `self-test-macos-gate-${index}`);
  } catch (error) {
    unsafeMacosSharedTestRejected =
      error instanceof Error &&
      error.message.startsWith(
        `WORKFLOW_MACOS_SHARED_TEST_GATE_INVALID:self-test-macos-gate-${index}:`,
      );
  }
  if (!unsafeMacosSharedTestRejected) {
    throw new Error('WORKFLOW_MACOS_SHARED_TEST_GATE_SELF_TEST_FAILED');
  }
}
assertMacosSharedTestStep(
  macosSharedTestWorkflowWithMutation(() => undefined),
  'self-test-macos-allowed',
);

const constructedRunnerEnvironmentStep = {
  name: 'Construct runner environment names at runtime',
  run: 'key=BASH; key="${key}_ENV"; file=GITHUB; file="${file}_ENV"; printf "%s=./nested/startup.sh\\n" "${key}" >> "${!file}"',
};
if (
  /\b(?:BASH_ENV|GITHUB_ENV|GITHUB_PATH)\b/i.test(
    JSON.stringify(constructedRunnerEnvironmentStep),
  )
) {
  throw new Error('WORKFLOW_GATED_JOB_STRUCTURE_SELF_TEST_INVALID');
}
const gatedJobStructureCases = [
  {
    source: linuxWorkflow,
    name: 'linux-audit.yml',
    jobId: 'shared',
    digest: expectedNpmAuditJobDigest,
    gateError: 'WORKFLOW_NPM_AUDIT_POLICY_INVALID',
  },
  {
    source: linuxWorkflow,
    name: 'linux.yml',
    gateError: 'WORKFLOW_ANDROID_INSTRUMENTATION_GATE_INVALID',
    ...expectedGatedExecutionDigests['linux.yml'],
  },
  {
    source: macosWorkflow,
    name: 'macos.yml',
    gateError: 'WORKFLOW_MACOS_SHARED_TEST_GATE_INVALID',
    ...expectedGatedExecutionDigests['macos.yml'],
  },
];
for (const {
  source,
  name,
  jobId,
  digest,
  gateError,
} of gatedJobStructureCases) {
  assertGatedExecutionStructure(source, name, jobId, digest, gateError);
  const mutatedWorkflow = parseWorkflow(source, `self-test-${name}`);
  const mutatedJob = isRecord(mutatedWorkflow?.jobs)
    ? mutatedWorkflow.jobs[jobId]
    : undefined;
  if (!isRecord(mutatedJob) || !Array.isArray(mutatedJob.steps)) {
    throw new Error('WORKFLOW_GATED_JOB_STRUCTURE_SELF_TEST_INVALID');
  }
  mutatedJob.steps.unshift(constructedRunnerEnvironmentStep);
  let constructedMutationRejected = false;
  try {
    assertGatedExecutionStructure(
      JSON.stringify(mutatedWorkflow),
      `self-test-${name}`,
      jobId,
      digest,
      gateError,
    );
  } catch (error) {
    constructedMutationRejected =
      error instanceof Error &&
      error.message === `${gateError}:self-test-${name}:${jobId}:structure`;
  }
  if (!constructedMutationRejected) {
    throw new Error('WORKFLOW_GATED_JOB_STRUCTURE_SELF_TEST_FAILED');
  }

  const environmentMutatedWorkflow = parseWorkflow(
    source,
    `self-test-${name}-workflow-environment`,
  );
  if (!isRecord(environmentMutatedWorkflow?.env)) {
    throw new Error('WORKFLOW_GATED_JOB_STRUCTURE_SELF_TEST_INVALID');
  }
  environmentMutatedWorkflow.env.NODE_VERSION = '22.13.2';
  let inheritedEnvironmentMutationRejected = false;
  try {
    assertGatedExecutionStructure(
      JSON.stringify(environmentMutatedWorkflow),
      `self-test-${name}-workflow-environment`,
      jobId,
      digest,
      gateError,
    );
  } catch (error) {
    inheritedEnvironmentMutationRejected =
      error instanceof Error &&
      error.message ===
        `${gateError}:self-test-${name}-workflow-environment:${jobId}:structure`;
  }
  if (!inheritedEnvironmentMutationRejected) {
    throw new Error('WORKFLOW_GATED_JOB_STRUCTURE_SELF_TEST_FAILED');
  }
}

for (const name of workflows) {
  const workflow = readFileSync(join(workflowRoot, name), 'utf8');
  assertWorkflowSecrets(workflow, name);
  assertWorkflowPermissions(workflow, name);
  assertWorkflowTriggers(workflow, name);
  assertWorkflowActions(workflow, name);
  assertWorkflowCheckNames(workflow, name, expectedWorkflowCheckNames[name]);
}
assertAndroidInstrumentationSteps(linuxWorkflow, 'linux.yml');
assertMacosSharedTestStep(macosWorkflow, 'macos.yml');
if ((all.match(/retention-days:\s*7/g) ?? []).length !== 3) {
  throw new Error('WORKFLOW_ARTIFACT_RETENTION_INVALID');
}
if (
  !all.includes(
    "hashFiles('Gemfile.lock', 'ios/Podfile.lock', 'package-lock.json')",
  )
) {
  throw new Error('WORKFLOW_NATIVE_CACHE_KEY_INVALID');
}
if (
  packageManifest.scripts?.ios !==
    'PATH="$PWD/scripts/cocoapods-bin:$PATH" BUNDLE_GEMFILE="$PWD/Gemfile" RUBYOPT=-rlogger expo run:ios' ||
  (statSync(cocoaPodsShimPath).mode & 0o111) === 0 ||
  !cocoaPodsShim.includes('export BUNDLE_GEMFILE="$repository_root/Gemfile"') ||
  !cocoaPodsShim.includes(
    `exec bundle exec ruby -rlogger -e 'load Gem.bin_path("cocoapods", "pod")' -- "$@"`,
  ) ||
  !macosWorkflow.includes(
    '- name: Verify the supported iOS entry point resolves locked CocoaPods',
  ) ||
  !macosWorkflow.includes(
    'entry_point_version="$(PATH="${GITHUB_WORKSPACE}/scripts/cocoapods-bin:${PATH}" pod --version)"',
  ) ||
  !macosWorkflow.includes(
    "ruby -rfileutils -e \"FileUtils.remove_dir('ios/Pods') if Dir.exist?('ios/Pods')\"",
  ) ||
  macosWorkflow.includes('            ios/Pods') ||
  !macosWorkflow.includes('run: test ! -e ios/Pods') ||
  !macosWorkflow.includes('npm run ios --') ||
  !macosWorkflow.includes('--device generic') ||
  !macosWorkflow.includes('--output "${RUNNER_TEMP}/expo-ios-build"') ||
  (macosWorkflow.match(/git diff --exit-code --/g) ?? []).length !== 2
) {
  throw new Error('WORKFLOW_EXPO_IOS_CLEAN_SMOKE_MISSING');
}
if (
  !all.includes(
    'run: bundle exec ruby -rlogger -rcocoapods scripts/verify-podspec-checksum.rb',
  )
) {
  throw new Error('WORKFLOW_PODSPEC_CHECKSUM_TEST_MISSING');
}
if (
  !all.includes(
    'run: bundle exec ruby -rlogger -S pod install --project-directory=ios --deployment',
  )
) {
  throw new Error('WORKFLOW_COCOAPODS_LOGGER_BOOT_INVALID');
}
if (
  packageManifest.devDependencies?.['expo-doctor'] !== '1.20.1' ||
  packageLock.packages?.['node_modules/expo-doctor']?.version !== '1.20.1' ||
  packageLock.packages?.['node_modules/expo-doctor']?.dev !== true ||
  !linuxWorkflow.includes('run: npm run doctor')
) {
  throw new Error('WORKFLOW_EXPO_DOCTOR_PIN_INVALID');
}

assertNpmAuditPolicyWorkflow(linuxWorkflow, 'linux.yml');
function auditWorkflowWithMutation(mutate) {
  const workflow = parseWorkflow(linuxWorkflow, 'self-test-audit-source');
  mutate(workflow);
  return JSON.stringify(workflow);
}
const auditWorkflowRejectedExamples = [
  auditWorkflowWithMutation(workflow => {
    const step = workflow.jobs.shared.steps.find(
      candidate => candidate.run === 'npm run audit:ci',
    );
    step.if = false;
    workflow.jobs.shared.steps.push({
      name: 'Weaker audit fallback',
      run: 'npm audit --audit-level=critical',
    });
  }),
  auditWorkflowWithMutation(workflow => {
    const step = workflow.jobs.shared.steps.find(
      candidate => candidate.run === 'npm run audit:ci',
    );
    step.run = 'npm audit --audit-level=critical';
  }),
  auditWorkflowWithMutation(workflow => {
    const [, nonSharedJob] = Object.entries(workflow.jobs).find(
      ([jobId, job]) => jobId !== 'shared' && Array.isArray(job.steps),
    );
    nonSharedJob.steps.push({
      name: 'Weaker audit with global npm option',
      run: 'npm --silent audit --audit-level=critical',
    });
  }),
  auditWorkflowWithMutation(workflow => {
    const [, nonSharedJob] = Object.entries(workflow.jobs).find(
      ([jobId, job]) => jobId !== 'shared' && Array.isArray(job.steps),
    );
    nonSharedJob.steps.push({
      name: 'Weaker audit through explicit npm path',
      run: '/usr/local/bin/npm --prefix . audit --audit-level=critical',
    });
  }),
  auditWorkflowWithMutation(workflow => {
    workflow.jobs.shared.steps.push({
      name: 'Duplicate policy gate',
      run: 'npm run audit:ci',
    });
  }),
  auditWorkflowWithMutation(workflow => {
    workflow.jobs.shared.if = false;
  }),
  auditWorkflowWithMutation(workflow => {
    const step = workflow.jobs.shared.steps.find(
      candidate => candidate.run === 'npm run audit:ci',
    );
    step['continue-on-error'] = true;
  }),
  auditWorkflowWithMutation(workflow => {
    const step = workflow.jobs.shared.steps.find(
      candidate => candidate.run === 'npm run audit:ci',
    );
    step.run = 'npm run audit:ci || true';
  }),
];
for (const [index, example] of auditWorkflowRejectedExamples.entries()) {
  let rejected = false;
  try {
    assertNpmAuditPolicyWorkflow(example, `self-test-audit-${index}`);
  } catch (error) {
    rejected =
      error instanceof Error &&
      error.message.startsWith('WORKFLOW_NPM_AUDIT_POLICY_INVALID:');
  }
  if (!rejected) {
    throw new Error('WORKFLOW_NPM_AUDIT_POLICY_SELF_TEST_FAILED');
  }
}
if (
  packageManifest.scripts?.['audit:ci'] !==
    'npm audit --json | node scripts/verify-npm-audit-policy.mjs' ||
  packageManifest.scripts?.['test:npm-audit-policy'] !==
    'node --test scripts/verify-npm-audit-policy.test.mjs' ||
  !packageManifest.scripts?.['test:workflows']?.includes(
    'npm run test:npm-audit-policy',
  )
) {
  throw new Error('WORKFLOW_NPM_AUDIT_POLICY_INVALID');
}
if (
  packageManifest.devDependencies?.yaml !== '2.9.0' ||
  packageLock.packages?.['']?.devDependencies?.yaml !== '2.9.0' ||
  packageLock.packages?.['node_modules/yaml']?.version !== '2.9.0' ||
  packageLock.packages?.['node_modules/yaml']?.integrity === undefined
) {
  throw new Error('WORKFLOW_YAML_PARSER_PIN_INVALID');
}
if (
  !androidNativeBuild.includes('ciApi34 {') ||
  !androidNativeBuild.includes('apiLevel = 34') ||
  !androidNativeBuild.includes('ciApi35 {') ||
  !androidNativeBuild.includes('apiLevel = 35') ||
  !androidNativeBuild.includes('systemImageSource = "aosp"') ||
  !androidNativeBuild.includes('testedAbi = "x86_64"') ||
  !androidNativeBuild.includes('"ciApi34Setup", "ciApi35Setup"') ||
  !androidNativeBuild.includes('task.testedAbi.set("x86_64")') ||
  (statSync(api24InstrumentationPath).mode & 0o111) === 0 ||
  !api24Instrumentation.includes('system-images;android-24;default;x86_64') ||
  !api24Instrumentation.includes('-no-snapshot') ||
  !api24Instrumentation.includes('-accel on') ||
  !api24Instrumentation.includes('-partition-size 4096') ||
  !api24Instrumentation.includes('sys.boot_completed') ||
  !api24Instrumentation.includes(':context-native:assembleDebugAndroidTest') ||
  !api24Instrumentation.includes('install --no-streaming -r -g') ||
  !api24Instrumentation.includes('shell am instrument -w') ||
  !api24Instrumentation.includes(
    'PdfProbeInstrumentedTest#usesRenderedFallbackForAllPagesBeforeApi35',
  )
) {
  throw new Error('WORKFLOW_ANDROID_INSTRUMENTATION_MISSING');
}
if (
  rubyVersion !== '3.4.9' ||
  !/^\s+ruby-version:\s+3\.4\.9$/m.test(macosWorkflow)
) {
  throw new Error('WORKFLOW_RUBY_PIN_INVALID');
}
if (
  !/^\s+runs-on:\s+macos-26$/m.test(macosWorkflow) ||
  !/^\s+DEVELOPER_DIR:\s+\/Applications\/Xcode_26\.6\.app\/Contents\/Developer$/m.test(
    macosWorkflow,
  ) ||
  !macosWorkflow.includes('-xcode-26.6-ruby-3.4.9-cocoapods-download-v1-') ||
  !macosWorkflow.includes("xcodebuild -version | grep -Fx 'Xcode 26.6'") ||
  !developmentSetup.includes(
    'Xcode 26.6 (the verified toolchain; ADR minimum is 26.4)',
  ) ||
  !developmentSetup.includes(
    'Xcode 26.3 cannot compile the locked Expo SDK 57 `expo-modules-jsi` package.',
  ) ||
  !architectureDecision.includes('- Xcode 26.4+')
) {
  throw new Error('WORKFLOW_XCODE_PIN_INVALID');
}

console.info(
  `WORKFLOW_POLICY files=${workflows.length} permissions=read actionPins=sha result=pass`,
);
