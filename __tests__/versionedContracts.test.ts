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

const contracts: readonly {
  readonly fixture: string;
  readonly schema: string;
  readonly validate: (value: unknown) => boolean;
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

describe('V1 contract fixtures and machine-readable schemas', () => {
  test.each(contracts)('$fixture passes its runtime validator', contract => {
    const fixture = loadJson(fixtureDirectory, contract.fixture);
    expect(contract.validate(fixture)).toBe(true);
    expect(contract.decode(fixture)).toEqual({ ok: true, value: fixture });
  });

  test.each(contracts)(
    '$schema is a versioned JSON Schema document',
    contract => {
      const schema = objectValue(loadJson(schemaDirectory, contract.schema));
      expect(schema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(schema.$id).toBe(
        `https://aicontextpack.local/schemas/contracts/v1/${contract.schema}`,
      );
      expect(schema.title).toMatch(/V1$/);
    },
  );

  test('schema and fixture directories contain exactly the six required contracts', () => {
    expect(readdirSync(schemaDirectory).sort()).toEqual(
      contracts.map(contract => contract.schema).sort(),
    );
    expect(
      readdirSync(fixtureDirectory)
        .filter(name => name.endsWith('-v1.json'))
        .sort(),
    ).toEqual(contracts.map(contract => contract.fixture).sort());
  });
});

describe('compatibility and migration policy', () => {
  test.each(contracts)(
    '$fixture rejects unknown breaking versions',
    contract => {
      const fixture = objectValue(loadJson(fixtureDirectory, contract.fixture));
      expect(contract.decode({ ...fixture, schemaVersion: 2 })).toEqual({
        ok: false,
        code: 'SCHEMA_VERSION_UNSUPPORTED',
      });
    },
  );

  test.each(contracts)(
    '$fixture rejects a missing version as invalid',
    contract => {
      const fixture = objectValue(loadJson(fixtureDirectory, contract.fixture));
      const withoutVersion = { ...fixture };
      delete withoutVersion.schemaVersion;
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
