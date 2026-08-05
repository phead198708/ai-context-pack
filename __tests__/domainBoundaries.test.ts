const { readFileSync, readdirSync, statSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
  readonly readdirSync: (path: string) => string[];
  readonly statSync: (path: string) => { readonly isDirectory: () => boolean };
}>('fs');
const { join, relative } = jest.requireActual<{
  readonly join: (...parts: string[]) => string;
  readonly relative: (from: string, to: string) => string;
}>('path');
const ts = jest.requireActual<typeof import('typescript')>('typescript');

const domainRoot = join(process.cwd(), 'src', 'domain');
const forbiddenImports = [
  /^react$/,
  /^react-native(?:\/|$)/,
  /^expo(?:\/|$|-)/,
  /^node:/,
  /^fs(?:\/|$)/,
  /^path(?:\/|$)/,
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

function importedSpecifiers(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    'domain-boundary.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function addStringLiteral(node: import('typescript').Expression): void {
    if (ts.isStringLiteralLike(node)) specifiers.push(node.text);
  }

  function visit(node: import('typescript').Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      const specifier = node.arguments[0];
      if (specifier !== undefined) addStringLiteral(specifier);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function forbiddenDomainImports(source: string): readonly string[] {
  return importedSpecifiers(source).filter(isForbiddenDomainImport);
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

    for (const file of filesBelow(domainRoot).filter(
      path => path.endsWith('.ts') || path.endsWith('.tsx'),
    )) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of forbiddenDomainImports(source)) {
        violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test.each([
    'fs',
    'fs/promises',
    'path',
    'path/posix',
    '../repository/contextPackRepository',
    '../repositories/contextPackRepository',
    '../../repository/contextPackRepository',
    '@app/repositories/contextPackRepository',
  ])('rejects seeded repository import %s', specifier => {
    expect(isForbiddenDomainImport(specifier)).toBe(true);
  });

  test.each([
    ["await import('fs/promises')", 'fs/promises'],
    ["const path = require('path/posix')", 'path/posix'],
    ["import fileSystem = require('fs')", 'fs'],
    ["export { readFile } from 'node:fs/promises'", 'node:fs/promises'],
  ])('rejects the actual source form %s', (source, specifier) => {
    expect(forbiddenDomainImports(source)).toEqual([specifier]);
  });
});
