import { DomainError } from './errors';

const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && timestampPartsOrNull(value) !== null;
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
  const parts = timestampPartsOrNull(value);
  if (!parts) throw new DomainError('SCHEMA_INVALID');
  return parts;
}

function timestampPartsOrNull(value: string): {
  readonly seconds: string;
  readonly fraction: string;
} | null {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return null;
  const [date, time] = match[1]!.split('T');
  const [yearText, monthText, dayText] = date!.split('-');
  const [hourText, minuteText, secondText] = time!.split(':');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  return {
    seconds: match[1]!,
    fraction: (match[2] ?? '').padEnd(9, '0'),
  };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function compareCanonicalParts(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
