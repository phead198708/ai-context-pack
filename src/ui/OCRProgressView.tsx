import React from 'react';
import { Text, View } from 'react-native';
import type { OCRTaskProgressV1 } from '../domain/ocr';

export interface OCRProgressViewProps {
  readonly progress: OCRTaskProgressV1;
}

/** Content-free OCR status surface reused by the Issue #12 editor workflow. */
export function OCRProgressView({ progress }: OCRProgressViewProps) {
  const message = statusMessage(progress);
  return (
    <View
      accessibilityLabel="OCR status"
      accessibilityLiveRegion="polite"
      accessibilityRole="summary"
    >
      <Text>{message}</Text>
      <Text>{`${progress.completedUnits}/${progress.totalUnits}`}</Text>
    </View>
  );
}

function statusMessage(progress: OCRTaskProgressV1): string {
  switch (progress.status) {
    case 'queued':
      return 'OCR queued';
    case 'running':
      return progress.phase === 'decode'
        ? 'Preparing image'
        : 'Recognizing text';
    case 'succeeded':
      return 'OCR complete';
    case 'cancelled':
      return `OCR cancelled (${progress.errorCode})`;
    case 'failed':
      return `OCR failed (${progress.errorCode})`;
  }
}
