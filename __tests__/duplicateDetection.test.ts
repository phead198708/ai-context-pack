import {
  DUPLICATE_DETECTOR_CONFIG_V1,
  buildDuplicateSuggestionsV1,
  calculateDuplicateSavingsV1,
  fingerprintNormalizedTextV1,
  groupDuplicateSuggestionsV1,
  imageHashDistanceV1,
  isDuplicateAnalysisItemV1,
  isDuplicateDecisionV1,
  isImagePerceptualHashV1,
  isNormalizedContentV1,
  normalizeContentV1,
  normalizedTextSimilarityV1,
  type DuplicateAnalysisItemV1,
  type DuplicateDecisionV1,
  type ImagePerceptualHashV1,
} from '../src/domain/duplicateDetection';

const { readFileSync } = jest.requireActual<{
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
}>('fs');
const { join } = jest.requireActual<{
  readonly join: (...parts: string[]) => string;
}>('path');

const PACK_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_IDS = [
  '22222222-2222-4222-8222-222222222221',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222223',
  '22222222-2222-4222-8222-222222222224',
] as const;
const ARTIFACT_IDS = [
  '33333333-3333-4333-8333-333333333331',
  '33333333-3333-4333-8333-333333333332',
  '33333333-3333-4333-8333-333333333333',
  '33333333-3333-4333-8333-333333333334',
] as const;
const SHA_A = 'a'.repeat(64);

function imageFingerprint(hash: string): ImagePerceptualHashV1 {
  return {
    schemaVersion: 1,
    algorithm: 'dhash-64-v1',
    hash,
    sampleWidth: 9,
    sampleHeight: 8,
    orientationApplied: true,
    durationMs: 2,
    revision: '1',
  };
}

function analysis(
  index: number,
  text: string,
  overrides: Partial<DuplicateAnalysisItemV1> = {},
): DuplicateAnalysisItemV1 {
  const normalized = normalizeContentV1(text);
  return {
    schemaVersion: 1,
    packId: PACK_ID,
    itemId: ITEM_IDS[index]!,
    originalByteCount: 1_024,
    normalizedArtifactId: ARTIFACT_IDS[index]!,
    normalizedSha256: `${index + 1}`.repeat(64),
    normalizedByteCount: normalized.utf8ByteCount,
    normalizedCharacterCount: normalized.characterCount,
    contentKind: normalized.contentKind,
    textFingerprint: fingerprintNormalizedTextV1(normalized),
    analyzedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('Issue #13 versioned content normalization', () => {
  it('normalizes Unicode, line endings, OCR artifacts, blank lines, and wrapped prose', () => {
    const normalized = normalizeContentV1(
      '\uFEFFCaf\u0065\u0301\r\nThis is a hy-\r\nphenated\u200B line.\r\n\r\n\r\nDone.  ',
    );

    expect(normalized).toEqual({
      schemaVersion: 1,
      normalizationVersion: 'text-normalization-v1',
      contentKind: 'prose',
      text: 'Café\nThis is a hyphenated line.\n\nDone.',
      characterCount: 38,
      utf8ByteCount: 39,
      warnings: [
        'LINE_ENDINGS_NORMALIZED',
        'OCR_ARTIFACT_REMOVED',
        'PROSE_WHITESPACE_NORMALIZED',
        'REPEATED_BLANK_LINES_COLLAPSED',
        'UNICODE_NORMALIZED',
        'WRAPPED_WORD_REJOINED',
      ],
    });
    expect(isNormalizedContentV1(normalized)).toBe(true);
  });

  it('preserves semantic indentation and fenced-code bytes', () => {
    const code = [
      '```ts',
      'function example() {',
      '  const nested = true;',
      '',
      '  return nested;',
      '}',
      '```',
    ].join('\n');
    const normalized = normalizeContentV1(code);

    expect(normalized.contentKind).toBe('code');
    expect(normalized.text).toBe(code);
    expect(normalized.warnings).toEqual([]);
  });

  it('preserves indentation for unfenced code-like content', () => {
    const code = 'function example() {\n  if (ready) {\n    run();\n  }\n}';
    expect(normalizeContentV1(code).text).toBe(code);
  });

  it('preserves semantic blank runs and fence-like code bytes', () => {
    const fenced = [
      '```text',
      'first',
      '',
      '',
      '',
      '```not-a-closing-fence',
      'second',
      '```',
    ].join('\n');
    const unfenced = 'const first = 1;\n\n\n\nconst second = 2;';

    expect(normalizeContentV1(fenced)).toMatchObject({
      contentKind: 'code',
      text: fenced,
      warnings: [],
    });
    expect(normalizeContentV1(unfenced)).toMatchObject({
      contentKind: 'code',
      text: unfenced,
      warnings: [],
    });
  });

  it('preserves single-line structured code instead of prose-compacting it', () => {
    const code = '{"message": "semantic  spacing", "ready": true}';
    expect(normalizeContentV1(code)).toMatchObject({
      contentKind: 'code',
      text: code,
      warnings: [],
    });
    const oneSpace = normalizeContentV1('const password = "a b";');
    const twoSpaces = normalizeContentV1('const password = "a  b";');
    expect(oneSpace.text).not.toBe(twoSpaces.text);
    expect(
      normalizedTextSimilarityV1(
        fingerprintNormalizedTextV1(oneSpace),
        fingerprintNormalizedTextV1(twoSpaces),
      ),
    ).toBeLessThan(1);
  });

  it('does not NFC-compose semantic code bytes', () => {
    const decomposed = 'const label = "Cafe\u0301";';
    expect(normalizeContentV1(decomposed)).toMatchObject({
      contentKind: 'code',
      text: decomposed,
      warnings: [],
    });
  });

  it('fails closed on invalid Unicode scalars and unknown validator keys', () => {
    expect(() => normalizeContentV1('\uD800')).toThrow('SCHEMA_INVALID');
    expect(
      isNormalizedContentV1({
        ...normalizeContentV1('safe value'),
        futureField: true,
      }),
    ).toBe(false);
  });
});

describe('Issue #13 deterministic duplicate suggestions', () => {
  it('meets the versioned synthetic corpus precision and recall gates', () => {
    const corpus = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'fixtures',
          'corpus',
          'duplicate-detection-cases.json',
        ),
        'utf8',
      ),
    ) as {
      readonly acceptedMinimumPrecision: number;
      readonly acceptedMinimumRecall: number;
      readonly textPairs: readonly {
        readonly expectedDuplicate: boolean;
        readonly left: string;
        readonly right: string;
      }[];
      readonly imageHashPairs: readonly {
        readonly expectedDuplicate: boolean;
        readonly left: string;
        readonly right: string;
      }[];
    };
    const predictions = [
      ...corpus.textPairs.map(pair => ({
        expected: pair.expectedDuplicate,
        predicted:
          normalizedTextSimilarityV1(
            fingerprintNormalizedTextV1(normalizeContentV1(pair.left)),
            fingerprintNormalizedTextV1(normalizeContentV1(pair.right)),
          ) >= DUPLICATE_DETECTOR_CONFIG_V1.textSimilarityThreshold,
      })),
      ...corpus.imageHashPairs.map(pair => ({
        expected: pair.expectedDuplicate,
        predicted:
          imageHashDistanceV1(
            imageFingerprint(pair.left),
            imageFingerprint(pair.right),
          ) <= DUPLICATE_DETECTOR_CONFIG_V1.imageHammingDistanceThreshold,
      })),
    ];
    const truePositive = predictions.filter(
      value => value.expected && value.predicted,
    ).length;
    const falsePositive = predictions.filter(
      value => !value.expected && value.predicted,
    ).length;
    const falseNegative = predictions.filter(
      value => value.expected && !value.predicted,
    ).length;
    const precision = truePositive / (truePositive + falsePositive);
    const recall = truePositive / (truePositive + falseNegative);

    expect(precision).toBeGreaterThanOrEqual(corpus.acceptedMinimumPrecision);
    expect(recall).toBeGreaterThanOrEqual(corpus.acceptedMinimumRecall);
  });

  it('detects exact source duplicates deterministically at 100% confidence', () => {
    const first = analysis(0, 'first distinct extracted value', {
      originalSha256: SHA_A,
    });
    const second = analysis(1, 'second distinct extracted value', {
      originalSha256: SHA_A,
      originalByteCount: 900,
    });

    expect(buildDuplicateSuggestionsV1([second, first])).toEqual([
      {
        schemaVersion: 1,
        key: `exact-binary:${ITEM_IDS[0]}:${ITEM_IDS[1]}`,
        packId: PACK_ID,
        leftItemId: ITEM_IDS[0],
        rightItemId: ITEM_IDS[1],
        reason: 'exact-binary',
        confidence: 1,
        expectedBytesSaved: 900,
        expectedCharactersSaved: 0,
      },
    ]);
  });

  it('detects near-image fixtures within the parity threshold and rejects hard negatives', () => {
    expect(
      imageHashDistanceV1(
        imageFingerprint('0123456789abcdef'),
        imageFingerprint('0123456789abcdee'),
      ),
    ).toBe(1);
    expect(
      buildDuplicateSuggestionsV1([
        analysis(0, '', {
          imageFingerprint: imageFingerprint('0123456789abcdef'),
        }),
        analysis(1, '', {
          imageFingerprint: imageFingerprint('0123456789abcdee'),
        }),
        analysis(2, '', {
          imageFingerprint: imageFingerprint('fedcba9876543210'),
        }),
      ]).map(value => [value.leftItemId, value.rightItemId, value.reason]),
    ).toEqual([[ITEM_IDS[0], ITEM_IDS[1], 'near-image']]);
  });

  it('meets the accepted synthetic similar-text precision and recall threshold', () => {
    const positivePairs = [
      [
        'Flight receipt total is USD 129.40. Reservation ABC123 leaves at 09:30 from Gate 4.',
        'Flight receipt total is USD 129.40. Reservation ABC123 leaves at 09:30 from Gate 5.',
      ],
      [
        'Project notes: verify the import queue, preserve the original file, and publish an immutable derivative.',
        'Project notes: verify the import queue, preserve the original file and publish an immutable derivative.',
      ],
      [
        '会议记录：确认离线导入、保留原始文件，并在用户审核后生成不可变的派生内容；同时记录检测器版本、候选原因、置信度和实际节省空间，保证重新分析不会覆盖用户选择。',
        '会议记录：确认离线导入，保留原始文件，并在用户审核后生成不可变的派生内容；同时记录检测器版本、候选原因、置信度和实际节省空间，保证重新分析不会覆盖用户选择。',
      ],
    ] as const;
    const negatives = [
      'Sequential error screen: payment failed and no attachment was received.',
      'Sequential error screen: upload failed after permission expired.',
      'A weather forecast with temperatures and no receipt information.',
    ] as const;
    const positiveScores = positivePairs.map(([left, right]) =>
      normalizedTextSimilarityV1(
        fingerprintNormalizedTextV1(normalizeContentV1(left)),
        fingerprintNormalizedTextV1(normalizeContentV1(right)),
      ),
    );
    const negativeScores = negatives
      .slice(1)
      .map((right, index) =>
        normalizedTextSimilarityV1(
          fingerprintNormalizedTextV1(normalizeContentV1(negatives[index]!)),
          fingerprintNormalizedTextV1(normalizeContentV1(right)),
        ),
      );

    expect(
      positiveScores.filter(
        score => score >= DUPLICATE_DETECTOR_CONFIG_V1.textSimilarityThreshold,
      ),
    ).toHaveLength(positivePairs.length);
    expect(
      negativeScores.filter(
        score => score >= DUPLICATE_DETECTOR_CONFIG_V1.textSimilarityThreshold,
      ),
    ).toHaveLength(0);
  });

  it('groups candidates, defaults to keeping every original, and reports actual selected savings', () => {
    const analyses = [
      analysis(
        0,
        'same sufficiently long normalized content for duplicate grouping',
        {
          originalSha256: SHA_A,
        },
      ),
      analysis(
        1,
        'same sufficiently long normalized content for duplicate grouping',
        {
          originalSha256: SHA_A,
          originalByteCount: 900,
        },
      ),
    ];
    const suggestions = buildDuplicateSuggestionsV1(analyses);
    const groups = groupDuplicateSuggestionsV1(suggestions);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.itemIds).toEqual([ITEM_IDS[0], ITEM_IDS[1]]);
    expect(calculateDuplicateSavingsV1(analyses, [])).toEqual({
      bytes: 0,
      characters: 0,
    });

    const decision: DuplicateDecisionV1 = {
      schemaVersion: 1,
      packId: PACK_ID,
      itemId: ITEM_IDS[1],
      choice: 'exclude',
      baselineInclusionMode: 'both',
      decidedAt: '2026-08-11T00:01:00.000Z',
    };
    expect(isDuplicateDecisionV1(decision)).toBe(true);
    expect(calculateDuplicateSavingsV1(analyses, [decision])).toEqual({
      bytes: 900 + analyses[1]!.normalizedByteCount,
      characters: analyses[1]!.normalizedCharacterCount,
    });
    expect(analyses[1]?.originalSha256).toBe(SHA_A);
  });

  it('aggregates group savings across every non-representative member', () => {
    const suggestions = [
      {
        schemaVersion: 1 as const,
        key: `similar-text:${ITEM_IDS[0]}:${ITEM_IDS[1]}`,
        packId: PACK_ID,
        leftItemId: ITEM_IDS[0],
        rightItemId: ITEM_IDS[1],
        reason: 'similar-text' as const,
        confidence: 0.9,
        expectedBytesSaved: 100,
        expectedCharactersSaved: 80,
      },
      {
        schemaVersion: 1 as const,
        key: `similar-text:${ITEM_IDS[1]}:${ITEM_IDS[2]}`,
        packId: PACK_ID,
        leftItemId: ITEM_IDS[1],
        rightItemId: ITEM_IDS[2],
        reason: 'similar-text' as const,
        confidence: 0.9,
        expectedBytesSaved: 240,
        expectedCharactersSaved: 200,
      },
      {
        schemaVersion: 1 as const,
        key: `similar-text:${ITEM_IDS[0]}:${ITEM_IDS[2]}`,
        packId: PACK_ID,
        leftItemId: ITEM_IDS[0],
        rightItemId: ITEM_IDS[2],
        reason: 'similar-text' as const,
        confidence: 0.9,
        expectedBytesSaved: 100,
        expectedCharactersSaved: 80,
      },
    ];

    expect(groupDuplicateSuggestionsV1(suggestions)[0]).toMatchObject({
      expectedBytesSaved: 340,
      expectedCharactersSaved: 280,
    });
  });

  it('rejects malformed hashes and analysis records without silently excluding items', () => {
    expect(isImagePerceptualHashV1(imageFingerprint('not-a-safe-hash'))).toBe(
      false,
    );
    expect(
      isDuplicateAnalysisItemV1({
        ...analysis(0, 'valid analysis content long enough to fingerprint'),
        originalByteCount: -1,
      }),
    ).toBe(false);
    const valid = analysis(
      0,
      'valid analysis content long enough to fingerprint',
    );
    expect(
      isDuplicateAnalysisItemV1({
        ...valid,
        textFingerprint: {
          ...valid.textFingerprint,
          shingleCount: 0,
        },
      }),
    ).toBe(false);
    expect(
      isDuplicateAnalysisItemV1({
        ...valid,
        textFingerprint: {
          ...valid.textFingerprint,
          hashes: [],
        },
      }),
    ).toBe(false);
    expect(
      buildDuplicateSuggestionsV1([
        analysis(0, 'payment failed on screen one with code 1001'),
        analysis(1, 'payment failed on screen two with code 1002'),
      ]),
    ).toEqual([]);
  });

  it('keeps a bounded deterministic comparison loop for the v0.1 item limit', () => {
    const start = Date.now();
    const values = Array.from({ length: 20 }, (_, index) =>
      analysis(
        index % ITEM_IDS.length,
        `Unique synthetic content ${index} with enough characters for deterministic fingerprinting.`,
        {
          itemId: `22222222-2222-4222-8222-${String(index + 1).padStart(
            12,
            '0',
          )}`,
          normalizedArtifactId: `33333333-3333-4333-8333-${String(
            index + 1,
          ).padStart(12, '0')}`,
          normalizedSha256: index.toString(16).padStart(64, '0'),
        },
      ),
    );

    const first = buildDuplicateSuggestionsV1(values);
    expect(buildDuplicateSuggestionsV1([...values].reverse())).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
