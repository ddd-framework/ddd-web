import type { DddColumnKind } from '../contract/extensions';

/** Days in a month of a year (proleptic Gregorian). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const FILTER_DATE_TIME =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?: (\d{1,2}):(\d{2})(?::(\d{2})(Z|[+-]\d{2}:?\d{2})?)?)|(?:T(\d{1,2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})?))?$/;

/**
 * Whether a string is a date-time filter literal the backend accepts. Mirrors `FiltersOptions::isFilterDateTimeLiteral()`
 * over `DateTime::MODEL_INPUT_FORMATS` plus `Y-m-d`: `Y-m-d H:i:sP`, `Y-m-d\TH:i:sP`, `Y-m-d H:i:s`, `Y-m-d H:i`,
 * `Y-m-d\TH:i:s`, `Y-m-d` (offset or `Z`); a date the calendar lacks (`2026-13-45`) fails.
 */
export function isFilterDateTimeLiteral(value: string): boolean {
  const match = FILTER_DATE_TIME.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  const hours = match[4] ?? match[8];
  const minutes = match[5] ?? match[9];
  const seconds = match[6] ?? match[10];
  if (hours !== undefined && Number(hours) > 23) return false;
  if (minutes !== undefined && Number(minutes) > 59) return false;
  if (seconds !== undefined && Number(seconds) > 59) return false;
  return true;
}

/**
 * Whether one value (its string form) fits a scalar column kind. Mirrors
 * `FiltersOptions::isFilterValueValidForColumnKind()`: int / float `-?\d+(\.\d+)?` (a decimal is accepted on an int
 * column), bool `1|0|true|false` (case-insensitive), datetime {@link isFilterDateTimeLiteral}; every other kind and
 * null pass.
 */
export function isFilterValueValidForColumnKind(value: string | null, columnKind: DddColumnKind): boolean {
  if (value === null) {
    return true;
  }
  switch (columnKind) {
    case 'int':
    case 'float':
      return /^-?\d+(\.\d+)?$/.test(value);
    case 'bool':
      return /^(1|0|true|false)$/i.test(value);
    case 'datetime':
      return isFilterDateTimeLiteral(value);
    default:
      return true;
  }
}
