import { DomainError } from './errors';

const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

export function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function compareIsoDateTimes(left: string, right: string): number {
  const leftParts = timestampParts(left);
  const rightParts = timestampParts(right);
  const seconds = compareCanonicalParts(leftParts.seconds, rightParts.seconds);
  return seconds === 0
    ? compareCanonicalParts(leftParts.fraction, rightParts.fraction)
    : seconds;
}

export function latestIsoDateTime(values: readonly string[]): string {
  if (values.length === 0) throw new DomainError('SCHEMA_INVALID');
  return values.reduce((latest, value) =>
    compareIsoDateTimes(value, latest) > 0 ? value : latest,
  );
}

function timestampParts(value: string): {
  readonly seconds: string;
  readonly fraction: string;
} {
  const match = ISO_DATE_TIME.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)))
    throw new DomainError('SCHEMA_INVALID');
  return {
    seconds: match[1]!,
    fraction: (match[2] ?? '').padEnd(9, '0'),
  };
}

function compareCanonicalParts(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
