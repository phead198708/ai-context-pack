const { readFileSync, readdirSync, statSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
  readonly readdirSync: (path: string) => string[];
  readonly statSync: (path: string) => { readonly isDirectory: () => boolean };
}>('fs');
const { join, relative } = jest.requireActual<{
  readonly join: (...parts: string[]) => string;
  readonly relative: (from: string, to: string) => string;
}>('path');

const domainRoot = join(process.cwd(), 'src', 'domain');
const forbiddenImports = [
  /^react$/,
  /^react-native(?:\/|$)/,
  /^expo(?:\/|$|-)/,
  /^node:/,
  /(?:^|\/)infrastructure(?:\/|$)/,
  /(?:^|\/)repositor(?:y|ies)(?:\/|$)/,
  /(?:^|\/)ui(?:\/|$)/,
  /(?:^|\/)features(?:\/|$)/,
  /(?:^|\/)app(?:\/|$)/,
  /modules\/context-native/,
];

function isForbiddenDomainImport(specifier: string): boolean {
  return forbiddenImports.some(pattern => pattern.test(specifier));
}

function filesBelow(directory: string): readonly string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

describe('domain dependency boundary', () => {
  test('does not import UI, repositories, file APIs, React Native, Expo, or native modules', () => {
    const violations: string[] = [];
    const importPattern =
      /(?:import|export)\s+(?:type\s+)?(?:[^'";]+from\s+)?['"]([^'"]+)['"]/g;

    for (const file of filesBelow(domainRoot).filter(path =>
      path.endsWith('.ts'),
    )) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier !== undefined && isForbiddenDomainImport(specifier))
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test.each([
    '../repository/contextPackRepository',
    '../repositories/contextPackRepository',
    '../../repository/contextPackRepository',
    '@app/repositories/contextPackRepository',
  ])('rejects seeded repository import %s', specifier => {
    expect(isForbiddenDomainImport(specifier)).toBe(true);
  });
});
