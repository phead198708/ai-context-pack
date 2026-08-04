import { readFileSync, readdirSync, statSync } from 'node:fs';
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

function parseWorkflow(source, name) {
  try {
    return parse(source, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    throw new Error(`WORKFLOW_YAML_INVALID:${name}`);
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

for (const name of workflows) {
  const workflow = readFileSync(join(workflowRoot, name), 'utf8');
  assertWorkflowSecrets(workflow, name);
  assertWorkflowPermissions(workflow, name);
  assertWorkflowTriggers(workflow, name);
  assertWorkflowActions(workflow, name);
  assertWorkflowCheckNames(workflow, name, expectedWorkflowCheckNames[name]);
}
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
if (!all.includes('run: npm test -- --ci')) {
  throw new Error('WORKFLOW_MACOS_SHARED_TEST_MISSING');
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
  !linuxWorkflow.includes(
    '"${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"',
  ) ||
  !linuxWorkflow.includes('"emulator"') ||
  !linuxWorkflow.includes('"system-images;android-34;default;x86_64"') ||
  !linuxWorkflow.includes('"system-images;android-35;default;x86_64"') ||
  !linuxWorkflow.includes(':context-native:ciApi34DebugAndroidTest') ||
  !linuxWorkflow.includes(':context-native:ciApi35DebugAndroidTest') ||
  !linuxWorkflow.includes('sudo chown "$(id -u):$(id -g)" /dev/kvm')
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
  !macosWorkflow.includes("xcodebuild -version | grep -Fx 'Xcode 26.6'")
) {
  throw new Error('WORKFLOW_XCODE_PIN_INVALID');
}

console.info(
  `WORKFLOW_POLICY files=${workflows.length} permissions=read actionPins=sha result=pass`,
);
