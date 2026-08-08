import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedSeverities = new Set([
  'info',
  'low',
  'moderate',
  'high',
  'critical',
]);
const severityRank = new Map(
  ['info', 'low', 'moderate', 'high', 'critical'].map((severity, index) => [
    severity,
    index,
  ]),
);

export const AUDIT_STDIN_LIMIT_BYTES = 2 * 1024 * 1024;
export const APPROVED_LOCK_FINGERPRINT =
  '667e53421e194ac6a4fb790d27652b6e4ec36bfcd008af80f5a86493ac76fe19';

export const APPROVED_ADVISORIES = Object.freeze([
  Object.freeze({
    source: 1138808,
    name: 'image-size',
    dependency: 'image-size',
    title:
      'image-size: ICNS parser allows denial of service through an infinite loop',
    url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
    severity: 'high',
    cwe: Object.freeze(['CWE-835']),
    cvss: Object.freeze({
      score: 7.5,
      vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
    }),
    range: '<=2.0.2',
  }),
  Object.freeze({
    source: 1138809,
    name: 'image-size',
    dependency: 'image-size',
    title:
      'image-size: JXL and HEIF parsers allow denial of service through infinite loops',
    url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
    severity: 'high',
    cwe: Object.freeze(['CWE-835']),
    cvss: Object.freeze({
      score: 7.5,
      vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
    }),
    range: '<=2.0.2',
  }),
]);

export const APPROVED_HIGH_PACKAGES = Object.freeze([
  '@expo/cli',
  '@expo/metro',
  '@expo/metro-config',
  '@react-native/community-cli-plugin',
  '@react-native/metro-config',
  '@react-native/new-app-screen',
  '@react-native/virtualized-lists',
  'expo',
  'image-size',
  'metro',
  'metro-config',
  'metro-transform-worker',
  'react-native',
]);

const expoDowngrade = Object.freeze({
  name: 'expo',
  version: '53.0.27',
  isSemVerMajor: true,
});
const reactNativeDowngrade = Object.freeze({
  name: 'react-native',
  version: '0.72.17',
  isSemVerMajor: true,
});
const newAppScreenDowngrade = Object.freeze({
  name: '@react-native/new-app-screen',
  version: '0.84.1',
  isSemVerMajor: true,
});
const expoCliDowngrade = Object.freeze({
  name: '@expo/cli',
  version: '0.24.24',
  isSemVerMajor: true,
});
const expoMetroConfigDowngrade = Object.freeze({
  name: '@expo/metro-config',
  version: '0.20.18',
  isSemVerMajor: true,
});

export const APPROVED_HIGH_GRAPH = Object.freeze([
  Object.freeze({
    name: '@expo/cli',
    isDirect: true,
    via: Object.freeze(['package:@expo/metro', 'package:@expo/metro-config']),
    effects: Object.freeze([]),
    nodes: Object.freeze(['node_modules/@expo/cli']),
    range: '>=0.25.0-canary-20250612-338ef55',
  }),
  Object.freeze({
    name: '@expo/metro',
    isDirect: false,
    via: Object.freeze([
      'package:metro',
      'package:metro-config',
      'package:metro-transform-worker',
    ]),
    effects: Object.freeze(['@expo/cli', '@expo/metro-config', 'expo']),
    nodes: Object.freeze(['node_modules/@expo/metro']),
    range: '*',
  }),
  Object.freeze({
    name: '@expo/metro-config',
    isDirect: true,
    via: Object.freeze(['package:@expo/metro']),
    effects: Object.freeze(['expo']),
    nodes: Object.freeze(['node_modules/@expo/metro-config']),
    range: '>=0.21.0-canary-20250630-547cd82',
  }),
  Object.freeze({
    name: '@react-native/community-cli-plugin',
    isDirect: false,
    via: Object.freeze([
      'package:@react-native/metro-config',
      'package:metro',
      'package:metro-config',
    ]),
    effects: Object.freeze(['react-native']),
    nodes: Object.freeze(['node_modules/@react-native/community-cli-plugin']),
    range: '*',
  }),
  Object.freeze({
    name: '@react-native/metro-config',
    isDirect: true,
    via: Object.freeze(['package:metro-config']),
    effects: Object.freeze(['@react-native/community-cli-plugin']),
    nodes: Object.freeze(['node_modules/@react-native/metro-config']),
    range: '*',
  }),
  Object.freeze({
    name: '@react-native/new-app-screen',
    isDirect: true,
    via: Object.freeze(['package:react-native']),
    effects: Object.freeze([]),
    nodes: Object.freeze(['node_modules/@react-native/new-app-screen']),
    range: '>=0.85.0-nightly-20260108-1236b6be4',
  }),
  Object.freeze({
    name: '@react-native/virtualized-lists',
    isDirect: false,
    via: Object.freeze(['package:react-native']),
    effects: Object.freeze(['react-native']),
    nodes: Object.freeze(['node_modules/@react-native/virtualized-lists']),
    range: '>=0.85.0-nightly-20260108-1236b6be4',
  }),
  Object.freeze({
    name: 'expo',
    isDirect: true,
    via: Object.freeze([
      'package:@expo/cli',
      'package:@expo/metro',
      'package:@expo/metro-config',
    ]),
    effects: Object.freeze([]),
    nodes: Object.freeze(['node_modules/expo']),
    range:
      '52.0.0-canary-20240625-2333e70 - 52.0.0-canary-20241018-f71b3e0 || >=54.0.0-canary-20250611-f0afe80',
  }),
  Object.freeze({
    name: 'image-size',
    isDirect: false,
    via: Object.freeze(['advisory:1138808', 'advisory:1138809']),
    effects: Object.freeze(['metro']),
    nodes: Object.freeze(['node_modules/image-size']),
    range: '*',
  }),
  Object.freeze({
    name: 'metro',
    isDirect: false,
    via: Object.freeze([
      'package:image-size',
      'package:metro-config',
      'package:metro-transform-worker',
    ]),
    effects: Object.freeze([
      '@expo/metro',
      '@react-native/community-cli-plugin',
      'metro-config',
      'metro-transform-worker',
    ]),
    nodes: Object.freeze(['node_modules/metro']),
    range: '>=0.22.1',
  }),
  Object.freeze({
    name: 'metro-config',
    isDirect: false,
    via: Object.freeze(['package:metro']),
    effects: Object.freeze([
      '@react-native/community-cli-plugin',
      '@react-native/metro-config',
      'metro',
    ]),
    nodes: Object.freeze(['node_modules/metro-config']),
    range: '*',
  }),
  Object.freeze({
    name: 'metro-transform-worker',
    isDirect: false,
    via: Object.freeze(['package:metro']),
    effects: Object.freeze(['metro']),
    nodes: Object.freeze(['node_modules/metro-transform-worker']),
    range: '>=0.60.0',
  }),
  Object.freeze({
    name: 'react-native',
    isDirect: true,
    via: Object.freeze([
      'package:@react-native/community-cli-plugin',
      'package:@react-native/virtualized-lists',
    ]),
    effects: Object.freeze([
      '@react-native/new-app-screen',
      '@react-native/virtualized-lists',
    ]),
    nodes: Object.freeze(['node_modules/react-native']),
    range: '>=0.73.0-nightly-20230506-1af868c52',
  }),
]);

// npm 10.9.2 assigns the Expo cycle's `expo` effect to either edge while
// preserving the same nodes, via links, ranges, and directness. Admit only the
// two complete reports observed for this exact lock graph.
export const APPROVED_AUDIT_GRAPHS = Object.freeze([
  APPROVED_HIGH_GRAPH,
  Object.freeze(
    APPROVED_HIGH_GRAPH.map(entry => {
      if (entry.name === '@expo/cli') {
        return Object.freeze({ ...entry, effects: Object.freeze(['expo']) });
      }
      if (entry.name === '@expo/metro-config') {
        return Object.freeze({ ...entry, effects: Object.freeze([]) });
      }
      return entry;
    }),
  ),
]);

export const APPROVED_HIGH_FIX_OPTIONS = Object.freeze([
  Object.freeze({
    name: '@expo/cli',
    values: Object.freeze([expoCliDowngrade]),
  }),
  Object.freeze({
    name: '@expo/metro',
    values: Object.freeze([
      expoCliDowngrade,
      expoDowngrade,
      expoMetroConfigDowngrade,
    ]),
  }),
  Object.freeze({
    name: '@expo/metro-config',
    values: Object.freeze([expoMetroConfigDowngrade]),
  }),
  Object.freeze({
    name: '@react-native/community-cli-plugin',
    values: Object.freeze([reactNativeDowngrade]),
  }),
  Object.freeze({
    name: '@react-native/metro-config',
    values: Object.freeze([reactNativeDowngrade]),
  }),
  Object.freeze({
    name: '@react-native/new-app-screen',
    values: Object.freeze([newAppScreenDowngrade]),
  }),
  Object.freeze({
    name: '@react-native/virtualized-lists',
    values: Object.freeze([reactNativeDowngrade]),
  }),
  Object.freeze({ name: 'expo', values: Object.freeze([expoDowngrade]) }),
  Object.freeze({
    name: 'image-size',
    values: Object.freeze([
      expoCliDowngrade,
      expoDowngrade,
      expoMetroConfigDowngrade,
      reactNativeDowngrade,
    ]),
  }),
  Object.freeze({
    name: 'metro',
    values: Object.freeze([
      expoCliDowngrade,
      expoDowngrade,
      expoMetroConfigDowngrade,
      reactNativeDowngrade,
    ]),
  }),
  Object.freeze({
    name: 'metro-config',
    values: Object.freeze([
      expoCliDowngrade,
      expoDowngrade,
      expoMetroConfigDowngrade,
      reactNativeDowngrade,
    ]),
  }),
  Object.freeze({
    name: 'metro-transform-worker',
    values: Object.freeze([
      expoCliDowngrade,
      expoDowngrade,
      expoMetroConfigDowngrade,
      reactNativeDowngrade,
    ]),
  }),
  Object.freeze({
    name: 'react-native',
    values: Object.freeze([reactNativeDowngrade]),
  }),
]);

export const APPROVED_HIGH_LOCK_TOPOLOGY = Object.freeze([
  Object.freeze({
    name: '@expo/cli',
    path: 'node_modules/@expo/cli',
    version: '57.0.13',
    resolved: 'https://registry.npmjs.org/@expo/cli/-/cli-57.0.13.tgz',
    integrity:
      'sha512-8gjLMyx+s0dLeDHlcfjM9D9x5yrCU5C6516rmC7q/Wiyuj1fxgr/cbDSmjdpQKkjlvvfvNwtRyMk2zhvhPohiw==',
    license: 'MIT',
    dependencies: Object.freeze({
      '@expo/config': '~57.0.6',
      '@expo/config-plugins': '~57.0.7',
      '@expo/inline-modules': '^0.1.4',
      '@expo/metro': '~56.0.0',
      '@expo/metro-config': '~57.0.7',
      '@expo/prebuild-config': '^57.0.10',
    }),
  }),
  Object.freeze({
    name: '@expo/metro',
    path: 'node_modules/@expo/metro',
    version: '56.0.0',
    resolved: 'https://registry.npmjs.org/@expo/metro/-/metro-56.0.0.tgz',
    integrity:
      'sha512-5gIgQHtEpjjvsjKfVtIv23a98LLRV0/y07PDShEwYSytAMlE3FSF8RHXqtHc1sUJL6dn7hnuIBpIbrLXXuVi0A==',
    license: 'MIT',
    dependencies: Object.freeze({
      metro: '0.84.4',
      'metro-config': '0.84.4',
      'metro-transform-worker': '0.84.4',
    }),
  }),
  Object.freeze({
    name: '@expo/metro-config',
    path: 'node_modules/@expo/metro-config',
    version: '57.0.7',
    resolved:
      'https://registry.npmjs.org/@expo/metro-config/-/metro-config-57.0.7.tgz',
    integrity:
      'sha512-bVfEkg4zF1cA62OqAdYXmFOooJ6TB/I+REi7Se6Ct+PbSC+89TwSqWXnYx34L08eIs4z+1ilgbATakTZpgefmQ==',
    license: 'MIT',
    dependencies: Object.freeze({
      '@expo/config': '~57.0.6',
      '@expo/metro': '~56.0.0',
    }),
  }),
  Object.freeze({
    name: '@react-native/community-cli-plugin',
    path: 'node_modules/@react-native/community-cli-plugin',
    version: '0.86.2',
    resolved:
      'https://registry.npmjs.org/@react-native/community-cli-plugin/-/community-cli-plugin-0.86.2.tgz',
    integrity:
      'sha512-YHXNKoM6Y/HjREySZ5arET2xgiHgg67r1MdwJB//MPJAJ0Xc5g0u6UHxY9VzsHO3Y07dre6s0BinYwjt1SEWvQ==',
    license: 'MIT',
    dependencies: Object.freeze({
      metro: '^0.84.3',
      'metro-config': '^0.84.3',
    }),
  }),
  Object.freeze({
    name: '@react-native/metro-config',
    path: 'node_modules/@react-native/metro-config',
    version: '0.86.2',
    resolved:
      'https://registry.npmjs.org/@react-native/metro-config/-/metro-config-0.86.2.tgz',
    integrity:
      'sha512-hJno256j+MS0b3JD1aD3ouTGZVacKNVBuXL2atMQQ8BZ060vl1ptnZ83y569aDW+/rgFSOcqn6ydKeSz4uUKQQ==',
    license: 'MIT',
    dependencies: Object.freeze({ 'metro-config': '^0.84.3' }),
  }),
  Object.freeze({
    name: '@react-native/new-app-screen',
    path: 'node_modules/@react-native/new-app-screen',
    version: '0.86.2',
    resolved:
      'https://registry.npmjs.org/@react-native/new-app-screen/-/new-app-screen-0.86.2.tgz',
    integrity:
      'sha512-tUFp4Jd2+C6uQM/0hQ7LfPgjL1V/IA9k0KbVJeme8mxulM2v2E0CEWp7WVczOma++/znbjE5eAvZnCUBqrimJA==',
    license: 'MIT',
    dependencies: Object.freeze({}),
  }),
  Object.freeze({
    name: '@react-native/virtualized-lists',
    path: 'node_modules/@react-native/virtualized-lists',
    version: '0.86.2',
    resolved:
      'https://registry.npmjs.org/@react-native/virtualized-lists/-/virtualized-lists-0.86.2.tgz',
    integrity:
      'sha512-uO0J72gh3EvE+1/GHRk18QRyBDTRHRB0AraAfojsRjbT7VMuJwKrZYaKGshavoaEud6aw00ZB9/8mTMIKjjcAw==',
    license: 'MIT',
    dependencies: Object.freeze({}),
  }),
  Object.freeze({
    name: 'expo',
    path: 'node_modules/expo',
    version: '57.0.11',
    resolved: 'https://registry.npmjs.org/expo/-/expo-57.0.11.tgz',
    integrity:
      'sha512-R97257N39Dw0kQFuI4/RvYx95GQ+dmePdo8hxcMOjDxAT4VcCckjILJeAWCE19Jxjb92hZ5NDXAfDPkkV1RB9w==',
    license: 'MIT',
    dependencies: Object.freeze({
      '@expo/cli': '^57.0.13',
      '@expo/config': '~57.0.6',
      '@expo/config-plugins': '~57.0.7',
      '@expo/local-build-cache-provider': '^57.0.5',
      '@expo/metro': '~56.0.0',
      '@expo/metro-config': '~57.0.7',
    }),
  }),
  Object.freeze({
    name: 'image-size',
    path: 'node_modules/image-size',
    version: '1.2.1',
    resolved: 'https://registry.npmjs.org/image-size/-/image-size-1.2.1.tgz',
    integrity:
      'sha512-rH+46sQJ2dlwfjfhCyNx5thzrv+dtmBIhPHk0zgRUukHzZ/kRueTJXoYYsclBaKcSMBWuGbOFXtioLpzTb5euw==',
    license: 'MIT',
    dependencies: Object.freeze({}),
  }),
  Object.freeze({
    name: 'metro',
    path: 'node_modules/metro',
    version: '0.84.4',
    resolved: 'https://registry.npmjs.org/metro/-/metro-0.84.4.tgz',
    integrity:
      'sha512-8ETTubqfD6ornDy2zYDvRcKnVDOXdFJsjetYDBsY4oAsb6NJkiwFR+FaMESyGppFmQUyBQA4H4sFGxzcQSGtFA==',
    license: 'MIT',
    dependencies: Object.freeze({
      'image-size': '^1.0.2',
      'metro-config': '0.84.4',
      'metro-transform-worker': '0.84.4',
    }),
  }),
  Object.freeze({
    name: 'metro-config',
    path: 'node_modules/metro-config',
    version: '0.84.4',
    resolved:
      'https://registry.npmjs.org/metro-config/-/metro-config-0.84.4.tgz',
    integrity:
      'sha512-PMotGDjXcXLWo2TMRH+VR99phFNgYTwqh4OoieIKK3yTJa1Jmkl+fZJxDO0jfBvNF+WESHciHvpNuBtXaF3B0Q==',
    license: 'MIT',
    dependencies: Object.freeze({ metro: '0.84.4' }),
  }),
  Object.freeze({
    name: 'metro-transform-worker',
    path: 'node_modules/metro-transform-worker',
    version: '0.84.4',
    resolved:
      'https://registry.npmjs.org/metro-transform-worker/-/metro-transform-worker-0.84.4.tgz',
    integrity:
      'sha512-W1IYMvvXTu4MxYr7d9h7CeG2vpIr3bmLLIavkPY4O1ilzDrvS8z/NEe6y+pC44Ff7raMXQgYSfdqDUwN/i39gg==',
    license: 'MIT',
    dependencies: Object.freeze({ metro: '0.84.4' }),
  }),
  Object.freeze({
    name: 'react-native',
    path: 'node_modules/react-native',
    version: '0.86.2',
    resolved:
      'https://registry.npmjs.org/react-native/-/react-native-0.86.2.tgz',
    integrity:
      'sha512-zbJXGZpwfZGA79Z9ob6Atvfx4nAQL8yJBa35s58E4Oo+khPykfQP2sTeumkKbjwajFYfVayg8pj7Il9nIfTk7A==',
    license: 'MIT',
    dependencies: Object.freeze({
      '@react-native/community-cli-plugin': '0.86.2',
      '@react-native/virtualized-lists': '0.86.2',
    }),
  }),
]);

export class AuditPolicyError extends Error {
  constructor(rule) {
    super(rule);
    this.name = 'AuditPolicyError';
    this.rule = rule;
  }
}

function fail(rule) {
  throw new AuditPolicyError(rule);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactStrings(value, expected) {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string') &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort())
  );
}

function advisoryProjection(value) {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.source) ||
    typeof value.name !== 'string' ||
    typeof value.dependency !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.severity !== 'string' ||
    !allowedSeverities.has(value.severity) ||
    !Array.isArray(value.cwe) ||
    !value.cwe.every(item => typeof item === 'string') ||
    !isRecord(value.cvss) ||
    typeof value.cvss.score !== 'number' ||
    typeof value.cvss.vectorString !== 'string' ||
    typeof value.range !== 'string'
  ) {
    fail('AUDIT_REPORT_INVALID');
  }
  return {
    source: value.source,
    name: value.name,
    dependency: value.dependency,
    title: value.title,
    url: value.url,
    severity: value.severity,
    cwe: [...value.cwe].sort(),
    cvss: {
      score: value.cvss.score,
      vectorString: value.cvss.vectorString,
    },
    range: value.range,
  };
}

function fixProjection(value) {
  if (typeof value === 'boolean') return value;
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['isSemVerMajor', 'name', 'version']) ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.isSemVerMajor !== 'boolean'
  ) {
    fail('AUDIT_REPORT_INVALID');
  }
  return {
    name: value.name,
    version: value.version,
    isSemVerMajor: value.isSemVerMajor,
  };
}

function sortedRecord(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function highGraphProjection(name, vulnerability) {
  return {
    name,
    isDirect: vulnerability.isDirect,
    via: vulnerability.via
      .map(via =>
        typeof via === 'string' ? `package:${via}` : `advisory:${via.source}`,
      )
      .sort(),
    effects: [...vulnerability.effects].sort(),
    nodes: [...vulnerability.nodes].sort(),
    range: vulnerability.range,
  };
}

function verifyExceptionLock(packageLock) {
  if (
    !isRecord(packageLock) ||
    packageLock.lockfileVersion !== 3 ||
    !isRecord(packageLock.packages)
  ) {
    fail('AUDIT_LOCK_INVALID');
  }
  if (
    createHash('sha256').update(JSON.stringify(packageLock)).digest('hex') !==
    APPROVED_LOCK_FINGERPRINT
  )
    fail('AUDIT_EXCEPTION_LOCK_DRIFT');
  const packages = packageLock.packages;
  const root = packages[''];
  if (
    !isRecord(root) ||
    root.devDependencies?.['@expo/cli'] !== '57.0.13' ||
    root.devDependencies?.['@react-native-community/cli'] !== '20.2.0' ||
    root.devDependencies?.['@react-native-community/cli-platform-android'] !==
      '20.2.0' ||
    root.devDependencies?.['@react-native-community/cli-platform-ios'] !==
      '20.2.0' ||
    root.optionalDependencies?.['@expo/metro-config'] !== '57.0.7' ||
    root.dependencies?.['image-size'] !== undefined ||
    root.devDependencies?.['image-size'] !== undefined ||
    root.optionalDependencies?.['image-size'] !== undefined ||
    root.peerDependencies?.['image-size'] !== undefined
  ) {
    fail('AUDIT_EXCEPTION_LOCK_DRIFT');
  }

  const relevantDependencies = new Set(
    APPROVED_HIGH_LOCK_TOPOLOGY.flatMap(entry =>
      Object.keys(entry.dependencies),
    ),
  );
  for (const expected of APPROVED_HIGH_LOCK_TOPOLOGY) {
    const entry = packages[expected.path];
    const suffix = `node_modules/${expected.name}`;
    const matchingPaths = Object.keys(packages)
      .filter(path => path === suffix || path.endsWith(`/${suffix}`))
      .sort();
    const actualDependencies = isRecord(entry?.dependencies)
      ? sortedRecord(
          Object.fromEntries(
            Object.entries(entry.dependencies).filter(([name]) =>
              relevantDependencies.has(name),
            ),
          ),
        )
      : {};
    if (
      matchingPaths.length !== 1 ||
      matchingPaths[0] !== expected.path ||
      !isRecord(entry) ||
      entry.version !== expected.version ||
      entry.resolved !== expected.resolved ||
      entry.integrity !== expected.integrity ||
      entry.license !== expected.license ||
      JSON.stringify(actualDependencies) !==
        JSON.stringify(sortedRecord(expected.dependencies))
    ) {
      fail('AUDIT_EXCEPTION_LOCK_DRIFT');
    }
  }
}

function rootDependencyNames(packageLock) {
  const root = packageLock.packages[''];
  return new Set([
    ...Object.keys(isRecord(root.dependencies) ? root.dependencies : {}),
    ...Object.keys(isRecord(root.devDependencies) ? root.devDependencies : {}),
    ...Object.keys(
      isRecord(root.optionalDependencies) ? root.optionalDependencies : {},
    ),
  ]);
}

function lockNodesFor(name, vulnerability, packageLock) {
  const suffix = `node_modules/${name}`;
  const nodes = [...new Set(vulnerability.nodes)].sort();
  if (
    nodes.length === 0 ||
    nodes.some(path => path !== suffix && !path.endsWith(`/${suffix}`))
  ) {
    fail('AUDIT_HIGH_GRAPH_DRIFT');
  }
  return nodes.map(path => {
    const entry = packageLock.packages[path];
    if (
      !isRecord(entry) ||
      typeof entry.version !== 'string' ||
      typeof entry.resolved !== 'string' ||
      typeof entry.integrity !== 'string' ||
      typeof entry.license !== 'string'
    ) {
      fail('AUDIT_HIGH_GRAPH_DRIFT');
    }
    return entry;
  });
}

function dependencyNames(entry) {
  return new Set([
    ...Object.keys(isRecord(entry.dependencies) ? entry.dependencies : {}),
    ...Object.keys(
      isRecord(entry.optionalDependencies) ? entry.optionalDependencies : {},
    ),
    ...Object.keys(
      isRecord(entry.peerDependencies) ? entry.peerDependencies : {},
    ),
  ]);
}

function reachesApprovedAdvisory(name, vulnerabilities, visiting = new Set()) {
  if (visiting.has(name)) return false;
  const next = new Set(visiting);
  next.add(name);
  return vulnerabilities[name].via.some(via => {
    if (typeof via !== 'string') {
      const projected = advisoryProjection(via);
      return APPROVED_ADVISORIES.some(
        approved => JSON.stringify(projected) === JSON.stringify(approved),
      );
    }
    return reachesApprovedAdvisory(via, vulnerabilities, next);
  });
}

function connectedToFixTarget(
  name,
  fixName,
  vulnerabilities,
  visiting = new Set(),
) {
  if (name === fixName) return true;
  if (visiting.has(name)) return false;
  const next = new Set(visiting);
  next.add(name);
  const vulnerability = vulnerabilities[name];
  if (!isRecord(vulnerability)) return false;
  return [...vulnerability.via, ...vulnerability.effects].some(adjacent =>
    typeof adjacent === 'string'
      ? connectedToFixTarget(adjacent, fixName, vulnerabilities, next)
      : false,
  );
}

function approvedFixValues(name, vulnerabilities) {
  const pinned = APPROVED_HIGH_FIX_OPTIONS.find(option => option.name === name);
  if (pinned) return pinned.values;
  return APPROVED_HIGH_FIX_OPTIONS.flatMap(option => option.values).filter(
    (value, index, values) =>
      values.findIndex(
        candidate => JSON.stringify(candidate) === JSON.stringify(value),
      ) === index && connectedToFixTarget(name, value.name, vulnerabilities),
  );
}

function verifyPropagatedHighGraph(vulnerabilities, packageLock) {
  const highNames = Object.keys(vulnerabilities).sort();
  const highSet = new Set(highNames);
  if (APPROVED_HIGH_PACKAGES.some(name => !highSet.has(name))) {
    fail('AUDIT_HIGH_GRAPH_DRIFT');
  }
  const directNames = rootDependencyNames(packageLock);
  for (const name of highNames) {
    const vulnerability = vulnerabilities[name];
    if (
      vulnerability.severity !== 'high' ||
      vulnerability.isDirect !== directNames.has(name) ||
      vulnerability.range.length === 0 ||
      !reachesApprovedAdvisory(name, vulnerabilities)
    ) {
      fail('AUDIT_HIGH_GRAPH_DRIFT');
    }
    const entries = lockNodesFor(name, vulnerability, packageLock);
    for (const via of vulnerability.via) {
      if (typeof via !== 'string') continue;
      if (
        !highSet.has(via) ||
        !entries.some(entry => dependencyNames(entry).has(via))
      ) {
        fail('AUDIT_HIGH_GRAPH_DRIFT');
      }
    }
    for (const effect of vulnerability.effects) {
      if (
        !highSet.has(effect) ||
        !vulnerabilities[effect].via.some(via => via === name)
      ) {
        fail('AUDIT_HIGH_GRAPH_DRIFT');
      }
    }
    const actualFix = fixProjection(vulnerability.fixAvailable);
    const fixValues = approvedFixValues(name, vulnerabilities);
    if (
      !isRecord(actualFix) ||
      actualFix.isSemVerMajor !== true ||
      !fixValues.some(
        approved => JSON.stringify(approved) === JSON.stringify(actualFix),
      )
    ) {
      fail('AUDIT_FIX_GRAPH_DRIFT');
    }
  }
}

function validateVulnerabilityRecord(name, vulnerability, vulnerabilities) {
  if (
    !isRecord(vulnerability) ||
    vulnerability.name !== name ||
    !allowedSeverities.has(vulnerability.severity) ||
    typeof vulnerability.isDirect !== 'boolean' ||
    !Array.isArray(vulnerability.via) ||
    !Array.isArray(vulnerability.effects) ||
    !vulnerability.effects.every(item => typeof item === 'string') ||
    !Array.isArray(vulnerability.nodes) ||
    !vulnerability.nodes.every(item => typeof item === 'string') ||
    typeof vulnerability.range !== 'string'
  ) {
    fail('AUDIT_REPORT_INVALID');
  }
  fixProjection(vulnerability.fixAvailable);
  for (const via of vulnerability.via) {
    if (typeof via === 'string') {
      if (!Object.hasOwn(vulnerabilities, via)) fail('AUDIT_REPORT_INVALID');
      continue;
    }
    advisoryProjection(via);
  }
}

export function verifyAuditReport(report, packageLock) {
  if (
    !isRecord(report) ||
    Object.hasOwn(report, 'error') ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities)
  ) {
    fail('AUDIT_REPORT_INVALID');
  }

  const vulnerabilities = report.vulnerabilities;
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    validateVulnerabilityRecord(name, vulnerability, vulnerabilities);
  }

  const directHighAdvisories = [];
  for (const vulnerability of Object.values(vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (!isRecord(via)) continue;
      const advisory = advisoryProjection(via);
      if (advisory.severity === 'critical') {
        fail('AUDIT_UNAPPROVED_CRITICAL');
      }
      if (
        advisory.severity === 'high' &&
        vulnerability.severity !== 'high' &&
        vulnerability.severity !== 'critical'
      ) {
        fail('AUDIT_SEVERITY_INCONSISTENT');
      }
      if (advisory.severity === 'high') {
        directHighAdvisories.push(advisory);
      }
    }
  }

  const criticalNames = Object.entries(vulnerabilities)
    .filter(([, value]) => value.severity === 'critical')
    .map(([name]) => name)
    .sort();
  if (criticalNames.length > 0) fail('AUDIT_UNAPPROVED_CRITICAL');

  for (const vulnerability of Object.values(vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (
        typeof via === 'string' &&
        severityRank.get(vulnerability.severity) <
          severityRank.get(vulnerabilities[via].severity)
      ) {
        fail('AUDIT_SEVERITY_INCONSISTENT');
      }
    }
  }

  const highNames = Object.entries(vulnerabilities)
    .filter(([, value]) => value.severity === 'high')
    .map(([name]) => name)
    .sort();
  const metadata = report.metadata.vulnerabilities;
  const actualSeverityCounts = Object.fromEntries(
    [...allowedSeverities].map(severity => [
      severity,
      Object.values(vulnerabilities).filter(
        vulnerability => vulnerability.severity === severity,
      ).length,
    ]),
  );
  if (
    [...allowedSeverities].some(
      severity =>
        !Number.isInteger(metadata[severity]) ||
        metadata[severity] < 0 ||
        metadata[severity] !== actualSeverityCounts[severity],
    ) ||
    !Number.isInteger(metadata.total) ||
    metadata.total !== Object.keys(vulnerabilities).length
  ) {
    fail('AUDIT_METADATA_INVALID');
  }

  if (highNames.length === 0) {
    if (Object.keys(vulnerabilities).length !== 0) {
      fail('AUDIT_HIGH_GRAPH_DRIFT');
    }
    return { highPackages: 0, exceptions: 0 };
  }
  if (highNames.length !== Object.keys(vulnerabilities).length)
    fail('AUDIT_HIGH_GRAPH_DRIFT');

  directHighAdvisories.sort((left, right) => left.source - right.source);
  if (
    JSON.stringify(directHighAdvisories) !== JSON.stringify(APPROVED_ADVISORIES)
  ) {
    fail('AUDIT_UNAPPROVED_ADVISORY');
  }

  verifyExceptionLock(packageLock);
  verifyPropagatedHighGraph(vulnerabilities, packageLock);
  return {
    highPackages: highNames.length,
    exceptions: directHighAdvisories.length,
  };
}

export function parseAuditText(text, limit = AUDIT_STDIN_LIMIT_BYTES) {
  if (typeof text !== 'string') fail('AUDIT_REPORT_INVALID');
  if (Buffer.byteLength(text, 'utf8') > limit) fail('STDIN_TOO_LARGE');
  try {
    return JSON.parse(text);
  } catch {
    fail('STDIN_JSON_INVALID');
  }
}

export async function readStdinBounded(
  stream,
  limit = AUDIT_STDIN_LIMIT_BYTES,
) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) fail('STDIN_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export function formatAuditPolicyError(error) {
  const rule =
    error instanceof AuditPolicyError ? error.rule : 'UNEXPECTED_FAILURE';
  return `NPM_AUDIT_POLICY_ERROR rule=${rule}`;
}

async function main() {
  if (process.argv.length !== 2) fail('CLI_USAGE_INVALID');
  const text = await readStdinBounded(process.stdin);
  const report = parseAuditText(text);
  let packageLock;
  try {
    packageLock = JSON.parse(
      readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'),
    );
  } catch {
    fail('AUDIT_LOCK_INVALID');
  }
  const summary = verifyAuditReport(report, packageLock);
  console.info(
    `NPM_AUDIT_POLICY result=pass highPackages=${summary.highPackages} approvedExceptions=${summary.exceptions}`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(error => {
    console.error(formatAuditPolicyError(error));
    process.exitCode = 1;
  });
}
