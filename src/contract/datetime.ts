/**
 * DDD date and date-time wire format.
 *
 * `DDD\Infrastructure\Base\DateTime\DateTime::jsonSerialize()` writes `Y-m-d H:i:s` (`DateTime::SIMPLE`): a UTC
 * wall-clock reading WITHOUT offset. `new Date('2026-01-02 03:04:05')` would read it as local time, so these helpers
 * parse and format it explicitly as UTC. `DDD\Infrastructure\Base\DateTime\Date` writes `Y-m-d` (`Date::DATE`).
 */

/** A DDD date-time string, `YYYY-MM-DD HH:MM:SS` in UTC. */
export type DddDateTimeString = string;

/** A DDD date string, `YYYY-MM-DD`. */
export type DddDateString = string;

const OFFSETLESS_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch ms of a calendar-checked UTC date-time, or null when a component is out of range (e.g. 2026-02-30). */
function utcMs(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0,
): number | null {
  if (month < 1 || month > 12 || day < 1 || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

/**
 * Whether `value` is a real calendar date in `YYYY-MM-DD` form (rejects `2026-13-45`, `2026-02-30`).
 * Mirrors the date check of `FiltersOptions::isFilterDateTimeLiteral()` (a date the formats parse but the calendar
 * lacks fails).
 */
export function isValidDddDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  return match !== null && utcMs(Number(match[1]), Number(match[2]), Number(match[3])) !== null;
}

/**
 * Parses a DDD date-time to epoch ms. Offset-less values (`Y-m-d H:i:s`, `Y-m-d\TH:i:s`, `Y-m-d H:i`, optional
 * fraction) and plain dates (`Y-m-d`, midnight) are read as UTC; values carrying an offset or `Z` are parsed as
 * given. All forms are calendar-checked. Returns `null` for absent or invalid input.
 */
export function parseDddDateTimeMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const dateTime = OFFSETLESS_DATETIME.exec(trimmed);
  if (dateTime) {
    const fraction = dateTime[7] ? Math.floor(Number(`0${dateTime[7]}`) * 1000) : 0;
    return utcMs(
      Number(dateTime[1]),
      Number(dateTime[2]),
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5]),
      Number(dateTime[6] ?? 0),
      fraction,
    );
  }
  const date = DATE_ONLY.exec(trimmed);
  if (date) {
    return utcMs(Number(date[1]), Number(date[2]), Number(date[3]));
  }
  const withOffset = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(trimmed);
  // The calendar check applies to the written components as well (2026-02-30T00:00:00Z is invalid, not March 2nd).
  if (
    !withOffset ||
    utcMs(
      Number(withOffset[1]),
      Number(withOffset[2]),
      Number(withOffset[3]),
      Number(withOffset[4]),
      Number(withOffset[5]),
      Number(withOffset[6] ?? 0),
    ) === null
  ) {
    return null;
  }
  const parsed = Date.parse(trimmed.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Parses a DDD date-time to a `Date` (see {@link parseDddDateTimeMs}); `null` for absent or invalid input. */
export function parseDddDateTime(value: string | null | undefined): Date | null {
  const ms = parseDddDateTimeMs(value);
  return ms === null ? null : new Date(ms);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function toDate(value: Date | number): Date {
  const date = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date');
  }
  return date;
}

/** Formats an instant as a DDD date-time (`Y-m-d H:i:s`, UTC, seconds truncated). Throws on an invalid date. */
export function formatDddDateTime(value: Date | number): DddDateTimeString {
  const date = toDate(value);
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** Formats an instant as a DDD date (`Y-m-d`, the UTC calendar day). Throws on an invalid date. */
export function formatDddDate(value: Date | number): DddDateString {
  const date = toDate(value);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
