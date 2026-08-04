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

function parseWorkflow(source, name) {
  try {
    return parse(source, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    throw new Error(`WORKFLOW_YAML_INVALID:${name}`);
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
  'on:\n  pull_request:\n  push:\n  "pull_request_target":\n',
  'on:\n  pull_request:\n  workflow_dispatch:\n',
];
for (const [index, example] of triggerPolicyRejectedExamples.entries()) {
  let rejectedByTriggerPolicy = false;
  try {
    assertWorkflowTriggers(example, `self-test-rejected-${index}`);
  } catch (error) {
    rejectedByTriggerPolicy =
      error instanceof Error &&
      (error.message.startsWith('WORKFLOW_TRIGGER_INVALID:') ||
        error.message.startsWith('WORKFLOW_TRIGGER_MISSING:'));
  }
  if (!rejectedByTriggerPolicy) {
    throw new Error('WORKFLOW_TRIGGER_POLICY_SELF_TEST_FAILED');
  }
}
assertWorkflowTriggers(
  'on:\n  pull_request:\n  push:\n  workflow_dispatch:\n',
  'self-test-allowed',
);

for (const forbidden of forbiddenPatterns) {
  if (forbidden.test(all))
    throw new Error(`WORKFLOW_PRIVILEGE_INVALID:${forbidden.source}`);
}

for (const name of workflows) {
  const workflow = readFileSync(join(workflowRoot, name), 'utf8');
  assertWorkflowPermissions(workflow, name);
  assertWorkflowTriggers(workflow, name);
  const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(
    match => match[1],
  );
  if (uses.length === 0 || uses.some(value => !/@[0-9a-f]{40}$/.test(value))) {
    throw new Error(`WORKFLOW_ACTION_NOT_SHA_PINNED:${name}`);
  }
}

for (const stableCheck of [
  'name: Shared',
  'name: Contracts & privacy',
  'name: Android',
  'name: Dependency review',
  'name: iOS app & Share Extension',
]) {
  if (!all.includes(stableCheck))
    throw new Error(`WORKFLOW_CHECK_MISSING:${stableCheck}`);
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
  !androidNativeBuild.includes('ciApi35 {') ||
  !androidNativeBuild.includes('apiLevel = 35') ||
  !androidNativeBuild.includes('systemImageSource = "aosp"') ||
  !androidNativeBuild.includes('testedAbi = "x86_64"') ||
  !androidNativeBuild.includes('task.testedAbi.set("x86_64")') ||
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
