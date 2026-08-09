import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { OCRProgressView } from '../src/ui/OCRProgressView';

describe('OCRProgressView', () => {
  test('renders accessible structured progress without source content', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <OCRProgressView
          progress={{
            schemaVersion: 1,
            taskId: '123e4567-e89b-42d3-a456-426614174000',
            status: 'running',
            phase: 'recognize',
            completedUnits: 1,
            totalUnits: 2,
          }}
        />,
      );
    });
    const root = renderer!.root;
    const status = root.find(
      node => node.props.accessibilityLabel === 'Recognizing text, 1 of 2',
    );
    expect(status.props.accessibilityLiveRegion).toBe('polite');
    expect(renderer!.toJSON()).toEqual(
      expect.objectContaining({ type: 'View' }),
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('file://');

    await act(async () => {
      renderer!.update(
        <OCRProgressView
          progress={{
            schemaVersion: 1,
            taskId: '123e4567-e89b-42d3-a456-426614174000',
            status: 'failed',
            completedUnits: 1,
            totalUnits: 2,
            errorCode: 'OCR_IMAGE_DECODE_FAILED',
          }}
        />,
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      'OCR_IMAGE_DECODE_FAILED',
    );
    expect(
      renderer!.root.find(
        node =>
          node.props.accessibilityLabel ===
          'OCR failed (OCR_IMAGE_DECODE_FAILED), 1 of 2',
      ),
    ).toBeDefined();
  });

  test('announces localized Simplified Chinese status and progress', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <OCRProgressView
          locale="zh-Hans"
          progress={{
            schemaVersion: 1,
            taskId: '123e4567-e89b-42d3-a456-426614174000',
            status: 'running',
            phase: 'decode',
            completedUnits: 0,
            totalUnits: 2,
          }}
        />,
      );
    });
    expect(
      renderer!.root.find(
        node => node.props.accessibilityLabel === '正在准备图片, 已完成 0/2',
      ),
    ).toBeDefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain('正在准备图片');
    expect(JSON.stringify(renderer!.toJSON())).toContain('已完成 0/2');
  });
});
