import {
  DOMAIN_ERROR_CATALOG,
  type DomainErrorCode,
} from '../src/domain/errors';
import type {
  ExportRecord,
  ImportRecord,
  PipelineRun,
} from '../src/domain/models';

const { readFileSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
}>('fs');
const { join } = jest.requireActual<{
  readonly join: (...parts: readonly string[]) => string;
}>('path');

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;

const persistedErrorTypeAssertions: readonly [
  Equal<ImportRecord['errorCodes'], readonly DomainErrorCode[]>,
  Equal<Exclude<PipelineRun['errorCode'], undefined>, DomainErrorCode>,
  Equal<Exclude<ExportRecord['errorCode'], undefined>, DomainErrorCode>,
] = [true, true, true];

describe('persisted domain error boundaries', () => {
  test('accept only catalogued DomainErrorCode values', () => {
    const importErrors: ImportRecord['errorCodes'] = ['IMPORT_PARTIAL_FAILURE'];
    const pipelineError: Exclude<PipelineRun['errorCode'], undefined> =
      'PIPELINE_STAGE_FAILED';
    const exportError: Exclude<ExportRecord['errorCode'], undefined> =
      'PRIVACY_EXPORT_BLOCKED';

    expect(persistedErrorTypeAssertions).toEqual([true, true, true]);
    expect(
      [...importErrors, pipelineError, exportError].every(code =>
        Object.prototype.hasOwnProperty.call(DOMAIN_ERROR_CATALOG, code),
      ),
    ).toBe(true);
  });

  test('keeps Swift, Kotlin, and documented manifest error mirrors exact', () => {
    const expected = Object.keys(DOMAIN_ERROR_CATALOG).sort();
    const swift = readFileSync(
      join(
        process.cwd(),
        'modules/context-native/ios/InboxManifestValidator.swift',
      ),
      'utf8',
    );
    const kotlin = readFileSync(
      join(
        process.cwd(),
        'modules/context-native/android/src/main/java/com/aicontextpack/nativebridge/ContextNativeModule.kt',
      ),
      'utf8',
    );
    const documentation = readFileSync(
      join(process.cwd(), 'docs/architecture/error-catalog.md'),
      'utf8',
    );

    expect(
      quotedCodesInBlock(
        swift,
        'private static let stableErrorCodes: Set<String> = [',
        '\n  ]',
      ),
    ).toEqual(expected);
    expect(
      quotedCodesInBlock(
        kotlin,
        'private val stableErrorCodes = setOf(',
        '\n  )',
      ),
    ).toEqual(expected);
    expect(
      [...documentation.matchAll(/^\| `([A-Z][A-Z0-9_]*)`\s+\|/gm)]
        .map(match => match[1]!)
        .sort(),
    ).toEqual(expected);
  });
});

function quotedCodesInBlock(
  source: string,
  startMarker: string,
  endMarker: string,
): string[] {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error('ERROR_CATALOG_MIRROR_MISSING');
  return [
    ...source
      .slice(start + startMarker.length, end)
      .matchAll(/"([A-Z][A-Z0-9_]*)"/g),
  ]
    .map(match => match[1]!)
    .sort();
}
