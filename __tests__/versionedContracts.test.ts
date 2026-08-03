import type { AnySchema, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {
  CONTRACT_COMPATIBILITY_POLICY,
  decodeVersionedContract,
  requireVersionedContract,
  type ContractDecodeResult,
} from '../src/domain/compatibility';
import {
  decodeExportManifestV1,
  decodeImportManifestV1,
  decodeOCRResultV1,
  decodePDFPageExtractionV1,
  decodePipelineCheckpointV1,
  decodeRiskFindingV1,
  isExportManifestV1,
  isImportManifestV1,
  isOCRResultV1,
  isPDFPageExtractionV1,
  isPipelineCheckpointV1,
  isRiskFindingV1,
} from '../src/domain/validation';

const { readFileSync, readdirSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
  readonly readdirSync: (path: string) => string[];
}>('fs');
const { join } = jest.requireActual<{
  readonly join: (...parts: string[]) => string;
}>('path');

const fixtureDirectory = join(process.cwd(), 'fixtures', 'contracts');
const schemaDirectory = join(process.cwd(), 'schemas', 'contracts', 'v1');

function loadJson(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object fixture');
  return value as Record<string, unknown>;
}

type Decoder = (value: unknown) => ContractDecodeResult<unknown>;
type RuntimeValidator = (value: unknown) => boolean;

const contracts: readonly {
  readonly fixture: string;
  readonly schema: string;
  readonly validate: RuntimeValidator;
  readonly decode: Decoder;
}[] = [
  {
    fixture: 'import-manifest-v1.json',
    schema: 'import-manifest-v1.schema.json',
    validate: isImportManifestV1,
    decode: value => decodeImportManifestV1(value),
  },
  {
    fixture: 'ocr-result-v1.json',
    schema: 'ocr-result-v1.schema.json',
    validate: isOCRResultV1,
    decode: value => decodeOCRResultV1(value),
  },
  {
    fixture: 'pdf-page-extraction-v1.json',
    schema: 'pdf-page-extraction-v1.schema.json',
    validate: isPDFPageExtractionV1,
    decode: value => decodePDFPageExtractionV1(value),
  },
  {
    fixture: 'pipeline-checkpoint-v1.json',
    schema: 'pipeline-checkpoint-v1.schema.json',
    validate: isPipelineCheckpointV1,
    decode: value => decodePipelineCheckpointV1(value),
  },
  {
    fixture: 'risk-finding-v1.json',
    schema: 'risk-finding-v1.schema.json',
    validate: isRiskFindingV1,
    decode: value => decodeRiskFindingV1(value),
  },
  {
    fixture: 'export-manifest-v1.json',
    schema: 'export-manifest-v1.schema.json',
    validate: isExportManifestV1,
    decode: value => decodeExportManifestV1(value),
  },
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const compiledContracts = contracts.map(contract => ({
  ...contract,
  validateSchema: ajv.compile(
    loadJson(schemaDirectory, contract.schema) as AnySchema,
  ) as ValidateFunction,
}));

function contractForFixture(fixture: string) {
  const contract = compiledContracts.find(
    candidate => candidate.fixture === fixture,
  );
  if (contract === undefined) throw new Error(`Unknown fixture: ${fixture}`);
  return contract;
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) throw new Error(`Expected ${key} array`);
  return candidate;
}

function firstRecordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return objectValue(arrayField(value, key)[0]);
}

type NegativeAuthority = 'structural-schema' | 'semantic-runtime';

const negativeContractCorpus: readonly {
  readonly name: string;
  readonly fixture: string;
  readonly authority: NegativeAuthority;
  readonly mutate: (
    fixture: Record<string, unknown>,
  ) => Record<string, unknown>;
}[] = [
  {
    name: 'import timestamp with a non-canonical offset',
    fixture: 'import-manifest-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({
      ...fixture,
      createdAt: '2026-01-01T08:00:00+08:00',
    }),
  },
  {
    name: 'import timestamp on a nonexistent Gregorian leap day',
    fixture: 'import-manifest-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({
      ...fixture,
      createdAt: '2026-02-29T00:00:00Z',
    }),
  },
  {
    name: 'import aggregate status inconsistent with copied items',
    fixture: 'import-manifest-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({ ...fixture, status: 'failed' }),
  },
  {
    name: 'import order inconsistent with array position',
    fixture: 'import-manifest-v1.json',
    authority: 'semantic-runtime',
    mutate: fixture => ({
      ...fixture,
      items: [{ ...firstRecordField(fixture, 'items'), order: 1 }],
    }),
  },
  {
    name: 'import path not bound to its item id',
    fixture: 'import-manifest-v1.json',
    authority: 'semantic-runtime',
    mutate: fixture => ({
      ...fixture,
      items: [
        {
          ...firstRecordField(fixture, 'items'),
          relativePath: '323e4567-e89b-42d3-a456-426614174000.bin',
        },
      ],
    }),
  },
  {
    name: 'OCR coordinate outside the normalized range',
    fixture: 'ocr-result-v1.json',
    authority: 'structural-schema',
    mutate: fixture => {
      const block = firstRecordField(fixture, 'blocks');
      return {
        ...fixture,
        blocks: [
          {
            ...block,
            bounds: { ...objectValue(block.bounds), x: 1.1 },
          },
        ],
      };
    },
  },
  {
    name: 'OCR rectangle extending beyond the normalized image',
    fixture: 'ocr-result-v1.json',
    authority: 'semantic-runtime',
    mutate: fixture => {
      const block = firstRecordField(fixture, 'blocks');
      return {
        ...fixture,
        blocks: [
          {
            ...block,
            bounds: { ...objectValue(block.bounds), x: 0.8, width: 0.5 },
          },
        ],
      };
    },
  },
  {
    name: 'legacy PDF characterCount field',
    fixture: 'pdf-page-extraction-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({ ...fixture, characterCount: 8 }),
  },
  {
    name: 'PDF block extending beyond the normalized page',
    fixture: 'pdf-page-extraction-v1.json',
    authority: 'semantic-runtime',
    mutate: fixture => ({
      ...fixture,
      blocks: [
        {
          text: '边界',
          bounds: { x: 0.8, y: 0.1, width: 0.5, height: 0.2 },
        },
      ],
    }),
  },
  {
    name: 'pipeline recovery checkpoint with the wrong resume action',
    fixture: 'pipeline-checkpoint-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({ ...fixture, resumeAction: 'continue' }),
  },
  {
    name: 'pipeline timestamp using normalized 24-hour rollover',
    fixture: 'pipeline-checkpoint-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({
      ...fixture,
      updatedAt: '2026-01-01T24:00:00Z',
    }),
  },
  {
    name: 'risk confidence outside the normalized range',
    fixture: 'risk-finding-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({ ...fixture, confidence: 1.1 }),
  },
  {
    name: 'risk rectangle extending beyond the normalized image',
    fixture: 'risk-finding-v1.json',
    authority: 'semantic-runtime',
    mutate: fixture => ({
      ...fixture,
      location: {
        kind: 'image-region',
        x: 0.8,
        y: 0.1,
        width: 0.5,
        height: 0.2,
      },
    }),
  },
  {
    name: 'export artifact with an unsafe relative path',
    fixture: 'export-manifest-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({
      ...fixture,
      artifacts: [
        {
          ...firstRecordField(fixture, 'artifacts'),
          relativePath: '../export.bin',
        },
      ],
    }),
  },
  {
    name: 'export timestamp on a nonexistent Gregorian day',
    fixture: 'export-manifest-v1.json',
    authority: 'structural-schema',
    mutate: fixture => ({
      ...fixture,
      createdAt: '2026-04-31T00:00:00Z',
    }),
  },
  {
    name: 'export artifacts with a duplicate projected id',
    fixture: 'export-manifest-v1.json',
    authority: 'semantic-runtime',
    mutate: fixture => {
      const artifact = firstRecordField(fixture, 'artifacts');
      return {
        ...fixture,
        artifacts: [
          artifact,
          {
            ...artifact,
            relativePath:
              'attachments/323e4567-e89b-42d3-a456-426614174000.bin',
          },
        ],
      };
    },
  },
];

describe('V1 contract fixtures and machine-readable schemas', () => {
  test.each(compiledContracts)(
    '$fixture passes both structural schema and semantic runtime validation',
    contract => {
      const fixture = loadJson(fixtureDirectory, contract.fixture);
      expect(contract.validateSchema(fixture)).toBe(true);
      expect(contract.validate(fixture)).toBe(true);
      expect(contract.decode(fixture)).toEqual({ ok: true, value: fixture });
    },
  );

  test.each(compiledContracts)(
    '$schema compiles as a documented structural JSON Schema',
    contract => {
      const schema = objectValue(loadJson(schemaDirectory, contract.schema));
      expect(schema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(schema.$id).toBe(
        `https://aicontextpack.local/schemas/contracts/v1/${contract.schema}`,
      );
      expect(schema.title).toMatch(/V1$/);
      expect(schema.$comment).toBe(
        `Structural V1 schema. Cross-field semantic authority: src/domain/validation.ts#${contract.validate.name}.`,
      );
    },
  );

  test('schema and fixture directories contain exactly the six required contracts', () => {
    expect(readdirSync(schemaDirectory).sort()).toEqual(
      compiledContracts.map(contract => contract.schema).sort(),
    );
    expect(
      readdirSync(fixtureDirectory)
        .filter(name => name.endsWith('-v1.json'))
        .sort(),
    ).toEqual(compiledContracts.map(contract => contract.fixture).sort());
  });

  test.each([
    ['import-manifest-v1.json', 'createdAt'],
    ['pipeline-checkpoint-v1.json', 'updatedAt'],
    ['export-manifest-v1.json', 'createdAt'],
  ] as const)(
    '%s accepts a real leap day with nanosecond precision',
    (fixtureName, timestampField) => {
      const contract = contractForFixture(fixtureName);
      const fixture = objectValue(loadJson(fixtureDirectory, fixtureName));
      const candidate = {
        ...fixture,
        [timestampField]: '2024-02-29T23:59:59.123456789Z',
      };

      expect(contract.validateSchema(candidate)).toBe(true);
      expect(contract.validate(candidate)).toBe(true);
      expect(contract.decode(candidate)).toEqual({
        ok: true,
        value: candidate,
      });
    },
  );
});

describe('compatibility and migration policy', () => {
  test.each(compiledContracts)(
    '$fixture rejects unknown breaking versions',
    contract => {
      const fixture = objectValue(loadJson(fixtureDirectory, contract.fixture));
      const unknownVersion = { ...fixture, schemaVersion: 2 };
      expect(contract.validateSchema(unknownVersion)).toBe(false);
      expect(contract.validate(unknownVersion)).toBe(false);
      expect(contract.decode(unknownVersion)).toEqual({
        ok: false,
        code: 'SCHEMA_VERSION_UNSUPPORTED',
      });
    },
  );

  test.each(compiledContracts)(
    '$fixture rejects a missing version as invalid',
    contract => {
      const fixture = objectValue(loadJson(fixtureDirectory, contract.fixture));
      const withoutVersion = { ...fixture };
      delete withoutVersion.schemaVersion;
      expect(contract.validateSchema(withoutVersion)).toBe(false);
      expect(contract.validate(withoutVersion)).toBe(false);
      expect(contract.decode(withoutVersion)).toEqual({
        ok: false,
        code: 'SCHEMA_INVALID',
      });
    },
  );

  test('requires explicit registered migration steps', () => {
    expect(CONTRACT_COMPATIBILITY_POLICY).toEqual({
      unknownVersion: 'reject',
      missingVersion: 'reject',
      currentVersion: 'validate-exactly',
      migration: 'explicit-registered-step-only',
    });
    const unsupported = decodeVersionedContract(
      'importManifest',
      { schemaVersion: 99 },
      isImportManifestV1,
    );
    expect(() => requireVersionedContract(unsupported)).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VERSION_UNSUPPORTED' }),
    );
  });
});

describe('structural schema and semantic runtime authority', () => {
  test.each(negativeContractCorpus)(
    '$name is rejected by $authority',
    negative => {
      const contract = contractForFixture(negative.fixture);
      const fixture = objectValue(loadJson(fixtureDirectory, negative.fixture));
      const candidate = negative.mutate(fixture);
      const schemaValid = contract.validateSchema(candidate);

      expect(schemaValid).toBe(negative.authority === 'semantic-runtime');
      expect(contract.validate(candidate)).toBe(false);
      expect(contract.decode(candidate)).toEqual({
        ok: false,
        code: 'SCHEMA_INVALID',
      });
    },
  );
});

describe('contract privacy and integrity constraints', () => {
  const ingestionId = '123e4567-e89b-42d3-a456-426614174000';
  const itemId = '223e4567-e89b-42d3-a456-426614174000';

  function copiedManifest(relativePath: string): unknown {
    return {
      schemaVersion: 1,
      ingestionId,
      createdAt: '2026-01-01T00:00:00Z',
      source: 'android-share-intent',
      status: 'complete',
      items: [
        {
          id: itemId,
          order: 0,
          mediaType: 'image/png',
          byteCount: 1,
          relativePath,
          status: 'copied',
        },
      ],
    };
  }

  test.each([
    'content://provider/private',
    'file:///private/container/item.bin',
    '/data/user/0/app/files/item.bin',
    '../item.bin',
    `nested/${itemId}.bin`,
  ])('rejects provider or machine path %s', path => {
    expect(isImportManifestV1(copiedManifest(path))).toBe(false);
  });

  test('rejects stale absolute-path fields even when relativePath is valid', () => {
    const fixture = objectValue(
      loadJson(fixtureDirectory, 'import-manifest-v1.json'),
    );
    const items = fixture.items;
    if (!Array.isArray(items)) throw new Error('Expected items');
    expect(
      isImportManifestV1({
        ...fixture,
        items: [
          {
            ...objectValue(items[0]),
            localUri: 'file:///private/container/item.bin',
          },
        ],
      }),
    ).toBe(false);
  });

  test('rejects matched secret material from RiskFindingV1', () => {
    const fixture = objectValue(
      loadJson(fixtureDirectory, 'risk-finding-v1.json'),
    );
    expect(
      isRiskFindingV1({ ...fixture, matchedText: 'fake-secret-value' }),
    ).toBe(false);
  });

  test.each([
    '/tmp/export.bin',
    '../export.bin',
    'attachments/../export.bin',
    'file:///tmp/export.bin',
  ])('rejects unsafe export artifact path %s', relativePath => {
    const fixture = objectValue(
      loadJson(fixtureDirectory, 'export-manifest-v1.json'),
    );
    const artifacts = fixture.artifacts;
    if (!Array.isArray(artifacts)) throw new Error('Expected artifacts');
    expect(
      isExportManifestV1({
        ...fixture,
        artifacts: [{ ...objectValue(artifacts[0]), relativePath }],
      }),
    ).toBe(false);
  });
});
