import {
  DOMAIN_ERROR_CATALOG,
  type DomainErrorCode,
} from '../src/domain/errors';
import type {
  ExportRecord,
  ImportRecord,
  PipelineRun,
} from '../src/domain/models';

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
});
