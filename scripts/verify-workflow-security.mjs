import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const rubyVersion = readFileSync(
  join(repositoryRoot, '.ruby-version'),
  'utf8',
).trim();
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
  /pull_request_target\s*:/,
  /\bsecrets\s*\./i,
  /\bsecrets\s*\[/i,
  /\bsecrets\s*:\s*inherit\b/i,
  /\$\{\{[^}]*\bsecrets\b[^}]*\}\}/i,
  /permissions:\s*write-all/,
  /permissions:[\s\S]*?\b(?:actions|checks|contents|deployments|id-token|issues|packages|pages|pull-requests|security-events|statuses):\s*write\b/,
];
const secretPolicyExamples = [
  '${{ secrets.TOKEN }}',
  "${{ secrets['TOKEN'] }}",
  '${{ toJSON(secrets) }}',
  'secrets: inherit',
];
if (
  secretPolicyExamples.some(
    example => !forbiddenPatterns.some(pattern => pattern.test(example)),
  )
) {
  throw new Error('WORKFLOW_SECRET_POLICY_SELF_TEST_FAILED');
}
for (const forbidden of forbiddenPatterns) {
  if (forbidden.test(all))
    throw new Error(`WORKFLOW_PRIVILEGE_INVALID:${forbidden.source}`);
}

for (const name of workflows) {
  const workflow = readFileSync(join(workflowRoot, name), 'utf8');
  if (!/^permissions:\n  contents: read$/m.test(workflow)) {
    throw new Error(`WORKFLOW_PERMISSION_MISSING:${name}`);
  }
  if (!/^  pull_request:$/m.test(workflow) || !/^  push:$/m.test(workflow)) {
    throw new Error(`WORKFLOW_TRIGGER_MISSING:${name}`);
  }
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
  !all.includes(
    'run: bundle exec ruby -rcocoapods scripts/verify-podspec-checksum.rb',
  )
) {
  throw new Error('WORKFLOW_PODSPEC_CHECKSUM_TEST_MISSING');
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
  !macosWorkflow.includes('-xcode-26.6-ruby-3.4.9-pods-') ||
  !macosWorkflow.includes("xcodebuild -version | grep -Fx 'Xcode 26.6'")
) {
  throw new Error('WORKFLOW_XCODE_PIN_INVALID');
}

console.info(
  `WORKFLOW_POLICY files=${workflows.length} permissions=read actionPins=sha result=pass`,
);
