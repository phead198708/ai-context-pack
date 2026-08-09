import React, { useEffect } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';
import type { OCRTaskProgressV1 } from '../domain/ocr';
import { t, type AppLocale } from './i18n';

export interface OCRProgressViewProps {
  readonly progress: OCRTaskProgressV1;
  readonly locale?: AppLocale;
}

/** Content-free OCR status surface reused by the Issue #12 editor workflow. */
export function OCRProgressView({
  progress,
  locale = 'en',
}: OCRProgressViewProps) {
  const message = statusMessage(progress, locale);
  const completed = t(locale, 'ocrProgress', {
    completed: progress.completedUnits,
    total: progress.totalUnits,
  });
  const announcement = `${message}, ${completed}`;
  useEffect(() => {
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(announcement, {
        queue: true,
      });
    }
  }, [announcement]);
  return (
    <View
      accessibilityLabel={announcement}
      accessibilityLiveRegion="polite"
      accessibilityRole="summary"
    >
      <Text>{message}</Text>
      <Text>{`${progress.completedUnits}/${progress.totalUnits}`}</Text>
    </View>
  );
}

function statusMessage(progress: OCRTaskProgressV1, locale: AppLocale): string {
  switch (progress.status) {
    case 'queued':
      return t(locale, 'ocrQueued');
    case 'running':
      return progress.phase === 'decode'
        ? t(locale, 'ocrPreparingImage')
        : t(locale, 'ocrRecognizingText');
    case 'succeeded':
      return t(locale, 'ocrComplete');
    case 'cancelled':
      return t(locale, 'ocrCancelled', { code: progress.errorCode });
    case 'failed':
      return t(locale, 'ocrFailed', { code: progress.errorCode });
  }
}
