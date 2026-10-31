import { formatDddDateTime } from '../contract/datetime';
import { QueryOptionsError } from './errors';

/** A scalar filter value. A `Date` is written as a DDD date-time (`Y-m-d H:i:s`, UTC). */
export type FilterScalar = string | number | boolean | Date | null;

/** A filter value: a scalar, or a list for `in` / `ni` / `bw`. */
export type FilterValue = FilterScalar | readonly FilterScalar[];

/**
 * Escapes text for use inside a single-quoted filter literal.
 *
 * Mirrors `FiltersOptionsParser::parseLiteral()`: inside `'…'` exactly two escapes exist, `\'` (a quote) and `\\`
 * (one backslash); the literal ends at the first unescaped quote. Same rule as `FiltersOptions::toCanonicalLiteral()`.
 * (Doubling quotes, `''`, is NOT understood by the backend: it ends the literal.)
 */
export function escapeFilterString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Alias of {@link escapeFilterString}, kept for code ported from OData-style helpers. */
export const escapeOData = escapeFilterString;

/**
 * The string form of a scalar as the backend validates it (`FiltersOptions::getFilterValueAsString()`):
 * a bool is `1` / `0`, a `Date` a UTC DDD date-time, a number its decimal form. Throws for a non-finite number or one
 * that only has an exponent form (the column-kind check accepts `-?\d+(\.\d+)?` only).
 */
export function filterScalarToString(value: Exclude<FilterScalar, null>): string {
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (value instanceof Date) {
    return formatDddDateTime(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new QueryOptionsError(`Filter value ${String(value)} is not a finite number`);
    }
    const text = String(value);
    if (/e/i.test(text)) {
      throw new QueryOptionsError(`Filter value ${text} has no plain decimal form; pass it as a string`);
    }
    return text;
  }
  return value;
}

/**
 * Writes one scalar literal: `null` for null, every other scalar single-quoted and escaped.
 *
 * The backend rule is "every scalar MUST be wrapped in single quotes" (`FiltersOptions::getSyntaxDocumentation()`):
 * the parser only reads unsigned unquoted numbers (`-5` fails), so numbers are quoted too; the column-kind check
 * judges a quoted literal by content (`id eq '12'` is an int).
 */
export function formatFilterScalar(value: FilterScalar): string {
  if (value === null) {
    return 'null';
  }
  return `'${escapeFilterString(filterScalarToString(value))}'`;
}

/**
 * Writes one list item as a JSON value: a double-quoted JSON string (every scalar is written as its string form, as
 * in {@link formatFilterScalar}) or `null`. `FiltersOptionsParser::parseArrayLiteral()` keeps the escapes of a
 * double-quoted item and JSON-decodes the list, so every character — also newlines and other control characters,
 * which a single-quoted item cannot carry — arrives unchanged.
 */
export function formatFilterListItem(value: FilterScalar): string {
  return value === null ? 'null' : JSON.stringify(filterScalarToString(value));
}

/**
 * Writes a filter literal: a scalar via {@link formatFilterScalar}, a list as `["a","b"]` (bracket list of JSON
 * items, see {@link formatFilterListItem}).
 */
export function formatFilterLiteral(value: FilterValue): string {
  if (Array.isArray(value)) {
    return `[${(value as readonly FilterScalar[]).map(formatFilterListItem).join(',')}]`;
  }
  return formatFilterScalar(value as FilterScalar);
}

const PROPERTY_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/**
 * Throws unless `property` is a valid filter / orderBy / select property path. Mirrors
 * `FiltersOptionsParser::parseIdentifier()`: letters, digits, `_` and `.` (dot-notation through expands).
 */
export function assertPropertyPath(property: string, context = 'property'): void {
  if (!PROPERTY_PATH.test(property)) {
    throw new QueryOptionsError(`Invalid ${context} '${property}': use letters, digits, '_' and '.' only`);
  }
}
