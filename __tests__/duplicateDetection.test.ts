import {
  DUPLICATE_DETECTOR_CONFIG_V1,
  buildDuplicateSuggestionsV1,
  calculateDuplicateSavingsV1,
  fingerprintNormalizedTextAsyncV1,
  fingerprintNormalizedTextV1,
  groupDuplicateSuggestionsV1,
  imageHashDistanceV1,
  isDuplicateAnalysisItemV1,
  isDuplicateDecisionV1,
  isImagePerceptualHashV1,
  isNormalizedContentV1,
  normalizeContentAsyncV1,
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

  it('preserves semantic joiners in prose and ambiguous assignment whitespace', () => {
    expect(normalizeContentV1('Engineer 👩‍💻 profile').text).toBe(
      'Engineer 👩‍💻 profile',
    );
    expect(normalizeContentV1('می\u200Cخواهم').text).toBe('می\u200Cخواهم');
    for (const assignment of [
      'value = "a  b"',
      'value += "a  b"',
      "VALUE='a  b'",
      'message: "a  b"',
      'print("a  b")',
      'logger.info("a  b");',
    ]) {
      expect(normalizeContentV1(assignment)).toMatchObject({
        contentKind: 'code',
        text: assignment,
        warnings: [],
      });
    }
    expect(normalizeContentV1('Note: this is ordinary  prose')).toMatchObject({
      contentKind: 'prose',
      text: 'Note: this is ordinary prose',
    });
    expect(normalizeContentV1('Note: hello')).toMatchObject({
      contentKind: 'prose',
      text: 'Note: hello',
    });
  });

  it('keeps call-only and augmented-assignment literal whitespace distinct', () => {
    for (const [oneSpace, twoSpaces] of [
      ['print("a b")', 'print("a  b")'],
      ['value += "a b"', 'value += "a  b"'],
      ['mask &= lookup["a b"]', 'mask &= lookup["a  b"]'],
      ['flags |= lookup["a b"]', 'flags |= lookup["a  b"]'],
      ['value ^= lookup["a b"]', 'value ^= lookup["a  b"]'],
      ['value //= lookup["a b"]', 'value //= lookup["a  b"]'],
      ['matrix @= lookup["a b"]', 'matrix @= lookup["a  b"]'],
      ['throw new Error("a b")', 'throw new Error("a  b")'],
    ] as const) {
      const normalizedOne = normalizeContentV1(oneSpace);
      const normalizedTwo = normalizeContentV1(twoSpaces);
      expect(normalizedOne.contentKind).toBe('code');
      expect(normalizedTwo).toMatchObject({
        contentKind: 'code',
        text: twoSpaces,
        warnings: [],
      });
      expect(normalizedOne.text).not.toBe(normalizedTwo.text);
    }
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

  it('normalizes maximum-size newline-dense text with bounded yields and cancellation', async () => {
    const maximumBytes = 16 * 1_024 * 1_024;
    const seed = 'synthetic newline-dense row\n';
    const maximumDerivedText = seed
      .repeat(Math.ceil(maximumBytes / seed.length))
      .slice(0, maximumBytes);
    let yields = 0;
    const normalized = await normalizeContentAsyncV1(maximumDerivedText, {
      yieldEveryCodeUnits: 32_768,
      yieldControl: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(normalized).toMatchObject({
      contentKind: 'prose',
      characterCount: maximumBytes,
      utf8ByteCount: maximumBytes,
    });
    expect(yields).toBeGreaterThan(1_000);

    let cancelled = false;
    await expect(
      normalizeContentAsyncV1('synthetic line\n'.repeat(65_536), {
        yieldEveryCodeUnits: 4_096,
        isCancelled: () => cancelled,
        yieldControl: () => {
          cancelled = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_FAILED' });
  });

  it('normalizes giant single-line prose cooperatively without changing its semantic kind', async () => {
    const giantLine = `Caf\u0065\u0301\u200B${'  synthetic prose'.repeat(
      8_192,
    )}  `;
    const sync = normalizeContentV1(giantLine);
    let yields = 0;
    const async = await normalizeContentAsyncV1(giantLine, {
      yieldEveryCodeUnits: 4_096,
      yieldControl: () => {
        yields += 1;
        return Promise.resolve();
      },
    });

    expect(async).toEqual(sync);
    expect(async).toMatchObject({
      contentKind: 'prose',
      warnings: expect.arrayContaining([
        'OCR_ARTIFACT_REMOVED',
        'PROSE_WHITESPACE_NORMALIZED',
        'UNICODE_NORMALIZED',
      ]),
    });
    expect(async.text.startsWith('Café synthetic prose')).toBe(true);
    expect(async.text).not.toContain('  ');
    expect(yields).toBeGreaterThan(10);
  });

  it('checks cancellation while scanning a maximum-size line before classification', async () => {
    const source = ' '.repeat(16 * 1_024 * 1_024);
    let yields = 0;
    let cancelled = false;

    await expect(
      normalizeContentAsyncV1(source, {
        yieldEveryCodeUnits: 32_768,
        isCancelled: () => cancelled,
        yieldControl: () => {
          yields += 1;
          // The first 512 yields validate Unicode. This cancellation must be
          // observed by the following cooperative line-boundary scan.
          if (yields === 513) cancelled = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_FAILED' });
    expect(yields).toBe(513);
  });

  it('ignores a leading BOM consistently when its first line has no content', async () => {
    const source = '\uFEFF   \nSynthetic  prose';

    expect(await normalizeContentAsyncV1(source)).toEqual(
      normalizeContentV1(source),
    );
  });

  it('preserves an assignment whose operator falls beyond the bounded prefix', async () => {
    const source = `value${' '.repeat(32 * 1_024 + 257)}= "a  b"`;
    const sync = normalizeContentV1(source);
    const async = await normalizeContentAsyncV1(source);

    expect(sync).toMatchObject({ contentKind: 'code', text: source });
    expect(async).toEqual(sync);
  });

  it('preserves a call whose opening marker falls beyond the bounded prefix', async () => {
    const source = `foo${' '.repeat(32 * 1_024 + 257)}("a  b")`;
    const sync = normalizeContentV1(source);
    const async = await normalizeContentAsyncV1(source);

    expect(sync).toMatchObject({ contentKind: 'code', text: source });
    expect(async).toEqual(sync);
  });

  it('preserves Unicode normalization across a long-line segment boundary', async () => {
    const source = `${'a'.repeat(32 * 1_024 - 1)}e\u0301  synthetic`;

    expect(await normalizeContentAsyncV1(source)).toEqual(
      normalizeContentV1(source),
    );
    expect(
      (await normalizeContentAsyncV1(source)).text.endsWith('é synthetic'),
    ).toBe(true);
  });

  it('keeps wrapped-line chains linear and cancellable during incremental joining', async () => {
    const repetitions = Math.floor((16 * 1_024 * 1_024) / 3);
    const source = 'a-\n'.repeat(repetitions);
    let completionYields = 0;
    const completed = await normalizeContentAsyncV1(source, {
      yieldEveryCodeUnits: 32_768,
      yieldControl: () => {
        completionYields += 1;
        return Promise.resolve();
      },
    });
    expect(completed).toMatchObject({
      contentKind: 'prose',
      characterCount: repetitions + 2,
      warnings: expect.arrayContaining(['WRAPPED_WORD_REJOINED']),
    });
    expect(completed.text.startsWith('a'.repeat(1_024))).toBe(true);
    expect(completed.text.endsWith('-\n')).toBe(true);
    expect(completionYields).toBeGreaterThan(1_000);

    let yields = 0;
    let cancelled = false;

    await expect(
      normalizeContentAsyncV1(source, {
        yieldEveryCodeUnits: 1_024,
        isCancelled: () => cancelled,
        yieldControl: () => {
          yields += 1;
          if (yields === 1_070) cancelled = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_FAILED' });
    expect(yields).toBe(1_070);
  });

  it('keeps async normalization identical for prose, code, and mixed input', async () => {
    for (const source of [
      'Caf\u0065\u0301\r\nwrapped hy-\r\nphen',
      'a-\na-\na-\na-',
      'mask &= lookup["a  b"]\r\nthrow new Error("c  d")',
      'Intro  prose\n```ts\nconst value = "a  b";\n```\nDone.',
    ]) {
      expect(await normalizeContentAsyncV1(source)).toEqual(
        normalizeContentV1(source),
      );
    }
  });
});

describe('Issue #13 deterministic duplicate suggestions', () => {
  it('streams large fingerprints with parity, cooperative yields, and cancellation', async () => {
    const normalized = normalizeContentV1(
      'Repeated synthetic context for bounded fingerprint work. '.repeat(4_096),
    );
    let yields = 0;
    const streamed = await fingerprintNormalizedTextAsyncV1(normalized, {
      yieldEveryCodePoints: 257,
      yieldControl: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(streamed).toEqual(fingerprintNormalizedTextV1(normalized));
    expect(yields).toBeGreaterThan(100);

    let cancelled = false;
    await expect(
      fingerprintNormalizedTextAsyncV1(normalized, {
        yieldEveryCodePoints: 64,
        isCancelled: () => cancelled,
        yieldControl: () => {
          cancelled = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_FAILED' });
  });

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
          shingleCount: 1,
          hashes: ['00000001', '00000002'],
        },
      }),
    ).toBe(false);
    expect(
      isDuplicateAnalysisItemV1({
        ...valid,
        textFingerprint: {
          ...valid.textFingerprint,
          shingleCount: 0,
          hashes: [],
        },
      }),
    ).toBe(false);
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
      isDuplicateAnalysisItemV1({
        ...valid,
        normalizedByteCount: 0,
        normalizedCharacterCount: 0,
      }),
    ).toBe(false);
    expect(
      isDuplicateAnalysisItemV1({
        ...valid,
        normalizedByteCount: 0,
        normalizedCharacterCount: 1,
      }),
    ).toBe(false);
    expect(
      isDuplicateAnalysisItemV1({
        ...valid,
        normalizedByteCount: 1,
        normalizedCharacterCount: 1,
        textFingerprint: {
          ...valid.textFingerprint,
          shingleCount: 1_000,
        },
      }),
    ).toBe(false);
    expect(isDuplicateAnalysisItemV1(analysis(0, 'a'))).toBe(true);
    const whitespace = normalizeContentV1('\n\n');
    expect(whitespace).toMatchObject({
      text: '',
      characterCount: 0,
      utf8ByteCount: 0,
    });
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
