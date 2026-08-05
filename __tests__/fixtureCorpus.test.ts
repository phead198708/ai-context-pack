import archiveCases from '../fixtures/corpus/archive-path-cases.json';
import importManifestCases from '../fixtures/corpus/import-manifest-cases.json';
import privacyCorpus from '../fixtures/corpus/privacy-detector-corpus.json';
import transitionCases from '../fixtures/corpus/state-machine-transitions.json';
import textUrlCases from '../fixtures/corpus/text-url-cases.json';
import traversalManifest from '../fixtures/malformed/import-manifest-path-traversal.json';
import unknownVersionManifest from '../fixtures/malformed/import-manifest-unknown-version.json';
import {
  ITEM_TRANSITIONS,
  PACK_TRANSITIONS,
} from '../src/domain/stateMachines';
import { isImportManifestV1 } from '../src/domain/validation';

describe('synthetic fixture corpus', () => {
  test('covers Unicode text, URLs, and malicious filenames', () => {
    expect(textUrlCases.cases).toHaveLength(2);
    expect(
      textUrlCases.cases.some(value =>
        /[\u{1F300}-\u{1FAFF}]/u.test(value.text),
      ),
    ).toBe(true);
    expect(
      textUrlCases.cases.some(value => /[\u3400-\u9FFF]/u.test(value.text)),
    ).toBe(true);
    expect(
      textUrlCases.cases.every(value =>
        new URL(value.url).hostname.endsWith('.invalid'),
      ),
    ).toBe(true);
    expect(textUrlCases.maliciousFilenames).toEqual(
      expect.arrayContaining([
        expect.stringContaining('../'),
        expect.stringContaining('\\'),
        expect.stringContaining('\u0000'),
      ]),
    );
  });

  test('binds manifest fixtures to semantic validation', () => {
    for (const fixture of importManifestCases.cases) {
      expect(isImportManifestV1(fixture.manifest)).toBe(fixture.expectedValid);
    }
    expect(isImportManifestV1(traversalManifest)).toBe(false);
    expect(isImportManifestV1(unknownVersionManifest)).toBe(false);
  });

  test('binds transition fixtures to the canonical state machines', () => {
    expect(PACK_TRANSITIONS).toEqual(
      expect.arrayContaining(transitionCases.pack),
    );
    expect(ITEM_TRANSITIONS).toEqual(
      expect.arrayContaining(transitionCases.item),
    );
    for (const rejected of transitionCases.rejected) {
      const transitions =
        rejected.kind === 'pack' ? PACK_TRANSITIONS : ITEM_TRANSITIONS;
      expect(
        transitions.some(
          value =>
            value.from === rejected.from && value.command === rejected.command,
        ),
      ).toBe(false);
    }
  });

  test('contains fake-only privacy positives and useful negatives', () => {
    expect(privacyCorpus.syntheticOnly).toBe(true);
    expect(
      new Set(privacyCorpus.positive.map(value => value.category)),
    ).toEqual(
      new Set([
        'api-key',
        'bearer-token',
        'jwt',
        'private-key-header',
        'url-credential',
        'email',
        'phone',
        'ipv4',
        'ipv6',
        'card-candidate',
      ]),
    );
    expect(
      privacyCorpus.positive.every(value => value.provenance.length > 0),
    ).toBe(true);
    expect(privacyCorpus.negative).toHaveLength(4);
  });

  test('covers safe and traversal archive paths', () => {
    expect(archiveCases.cases.filter(value => value.accepted)).toHaveLength(2);
    expect(archiveCases.cases.filter(value => !value.accepted)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('../') }),
        expect.objectContaining({ path: expect.stringContaining('%2e%2e') }),
        expect.objectContaining({ path: expect.stringContaining('\u0000') }),
      ]),
    );
  });
});
