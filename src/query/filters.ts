import { isValidDddDate } from '../contract/datetime';
import {
  isFilterOperator,
  isFulltextOperator,
  isListOperator,
  NULL_OPERATORS,
  type FilterOperator,
  type FulltextOperator,
  type ListOperator,
} from '../contract/operators';
import { QueryOptionsError } from './errors';
import {
  assertPropertyPath,
  formatFilterLiteral,
  type FilterScalar,
  type FilterValue,
} from './literals';
import { joinFilters } from './structure';

function isNullLike(value: FilterValue): boolean {
  return value === null || (typeof value === 'string' && value.toLowerCase() === 'null');
}

/**
 * Throws when the value shape does not fit the operator. Mirrors `FilterOptionsConstraintValidator::validate()`:
 * null only with `eq` / `ne`; a list only with `in` / `ni` / `bw`; `in` / `ni` / `bw` need a list; `bw` exactly two
 * items; `ft` / `fb` a non-empty string. Additionally refuses an empty `in` / `ni` list (an empty SQL IN list).
 */
export function assertValueFitsOperator(operator: FilterOperator, value: FilterValue): void {
  if (!isFilterOperator(operator)) {
    throw new QueryOptionsError(`Unknown filter operator '${String(operator)}'`);
  }
  const isList = Array.isArray(value);
  if (!isList && isNullLike(value) && !(NULL_OPERATORS as readonly string[]).includes(operator)) {
    throw new QueryOptionsError(`A null value is only allowed with ${NULL_OPERATORS.join(', ')} (got '${operator}')`);
  }
  if (isList && !isListOperator(operator)) {
    throw new QueryOptionsError(`A list value is only allowed with in, ni, bw (got '${operator}')`);
  }
  if (!isList && isListOperator(operator)) {
    throw new QueryOptionsError(`Operator '${operator}' needs a list value`);
  }
  if (isList) {
    const items = value as readonly FilterScalar[];
    if (operator === 'bw' && items.length !== 2) {
      throw new QueryOptionsError(`Operator 'bw' needs exactly 2 values (got ${items.length})`);
    }
    if (items.length === 0) {
      throw new QueryOptionsError(`Operator '${operator}' needs at least one value`);
    }
    if (items.some(item => Array.isArray(item))) {
      throw new QueryOptionsError(`List items of '${operator}' must be scalars`);
    }
  }
  if (isFulltextOperator(operator) && (typeof value !== 'string' || value.trim() === '')) {
    throw new QueryOptionsError(`Fulltext operator '${operator}' needs a non-empty string value`);
  }
}

/**
 * Builds one comparison `<property> <operator> <literal>`, e.g. `title eq 'O\'Brien'`, `id in ['1','2']`,
 * `published bw ['2026-01-01','2026-12-31']`. The value is written by `formatFilterLiteral()` (quoted, escaped,
 * bracket list for list operators), so callers never concatenate values themselves — the client-side counterpart of
 * `FiltersOptions::createExpression()`. Throws {@link QueryOptionsError} for an invalid property path or a value
 * shape the backend rejects.
 */
export function buildFieldFilter(property: string, value: FilterValue, operator: FilterOperator = 'eq'): string {
  assertPropertyPath(property, 'filter property');
  assertValueFitsOperator(operator, value);
  return `${property} ${operator} ${formatFilterLiteral(value)}`;
}

/** `<property> in|ni|bw [<values>]`; see {@link buildFieldFilter}. */
export function buildListFilter(property: string, operator: ListOperator, values: readonly FilterScalar[]): string {
  return buildFieldFilter(property, values, operator);
}

/** `<property> in [<values>]` — the value is one of the list. */
export function buildInFilter(property: string, values: readonly FilterScalar[]): string {
  return buildFieldFilter(property, values, 'in');
}

/** `<property> ni [<values>]` — the value is none of the list. */
export function buildNotInFilter(property: string, values: readonly FilterScalar[]): string {
  return buildFieldFilter(property, values, 'ni');
}

/** `<property> bw [<from>,<to>]` — inclusive range (SQL BETWEEN). */
export function buildBetweenFilter(property: string, from: FilterScalar, to: FilterScalar): string {
  return buildFieldFilter(property, [from, to], 'bw');
}

/** `<property> eq null` (IS NULL) or, with `negate`, `<property> ne null` (IS NOT NULL). */
export function buildNullFilter(property: string, negate = false): string {
  return buildFieldFilter(property, null, negate ? 'ne' : 'eq');
}

/**
 * `<property> eq '*<term>*'` — a LIKE "contains" match. `*` is the only wildcard on the backend (LIKE's own `%`, `_`
 * are literal, `FiltersOptions::getFiltersExpressionForDoctrineQueryBuilder()`); a `*` in the term cannot be matched
 * literally and acts as a wildcard too. Returns `undefined` for a blank term.
 */
export function buildContainsFilter(property: string, term: string, negate = false): string | undefined {
  const trimmed = term.trim();
  if (!trimmed) {
    return undefined;
  }
  return buildFieldFilter(property, `*${trimmed}*`, negate ? 'ne' : 'eq');
}

/** Appends `*` to each word for boolean-mode fulltext prefix matching: `dune mess` → `dune* mess*`. */
export function toBooleanPrefix(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(word => (word.endsWith('*') ? word : `${word}*`))
    .join(' ');
}

/** Options of {@link buildFulltextFilter}. */
export interface FulltextFilterOptions {
  /** `ft` natural language mode (default) or `fb` boolean mode. */
  mode?: FulltextOperator;
  /** In boolean mode, append `*` to every word (prefix match). Default `true` for `fb`. */
  prefix?: boolean;
}

/**
 * `<property> ft|fb '<term>'` — fulltext search (MATCH AGAINST). Requires a FULLTEXT index on the backend
 * (`FiltersDefinition::$supportsFulltext`). Returns `undefined` for a blank term.
 */
export function buildFulltextFilter(
  property: string,
  term: string,
  options: FulltextFilterOptions = {},
): string | undefined {
  const mode = options.mode ?? 'ft';
  const trimmed = term.trim();
  if (!trimmed) {
    return undefined;
  }
  const usePrefix = options.prefix ?? mode === 'fb';
  return buildFieldFilter(property, mode === 'fb' && usePrefix ? toBooleanPrefix(trimmed) : trimmed, mode);
}

/** Options of {@link buildIntEqFilter}. */
export interface IntEqFilterOptions {
  /** A literal prefix to strip before the check, e.g. `#` in `#12`. */
  stripLeadingChar?: string;
}

/**
 * `<property> eq '<n>'` for a search term over an int column. Returns `undefined` unless the (optionally prefix-
 * stripped) term is purely numeric: the backend answers 400 for a non-numeric value on an int column
 * (`FiltersOptions::isFilterValueValidForColumnKind()`), so the clause is omitted instead.
 */
export function buildIntEqFilter(
  rawValue: string,
  property: string,
  options: IntEqFilterOptions = {},
): string | undefined {
  const prefix = options.stripLeadingChar;
  const term = prefix && rawValue.startsWith(prefix) ? rawValue.slice(prefix.length) : rawValue;
  if (!/^\d+$/.test(term)) {
    return undefined;
  }
  return buildFieldFilter(property, term, 'eq');
}

/**
 * `<property> bw ['<day> 00:00:00','<day> 23:59:59']` — a full UTC calendar day on a date-time column. Returns
 * `undefined` unless `rawValue` is a real `YYYY-MM-DD` date: a partial date (`2026-10`) or one the calendar lacks
 * (`2026-13-45`, `2026-02-30`) would answer 400 (`FiltersOptions::isFilterDateTimeLiteral()`).
 */
export function buildFullDayFilter(rawValue: string, property: string): string | undefined {
  const day = rawValue.trim();
  if (!isValidDddDate(day)) {
    return undefined;
  }
  return buildBetweenFilter(property, `${day} 00:00:00`, `${day} 23:59:59`);
}

/**
 * AND-joins filter clauses, skipping empty ones; `undefined` when none remain. A clause that contains a top-level
 * `or` is parenthesised first: the backend parser has no precedence (`FiltersOptionsParser::parseExpression()` reads
 * left to right), so `x and a or b` would mean `(x and a) or b`.
 */
export function combineFilters(...parts: ReadonlyArray<string | null | undefined | false>): string | undefined {
  return joinFilters('and', parts.filter((part): part is string => typeof part === 'string'));
}

/**
 * OR-joins filter clauses, skipping empty ones; `undefined` when none remain. A clause with a top-level `and` is
 * parenthesised (no precedence on the backend). The result is not wrapped; {@link combineFilters} groups it when it
 * is AND-joined with other clauses.
 */
export function anyOfFilters(...parts: ReadonlyArray<string | null | undefined | false>): string | undefined {
  return joinFilters('or', parts.filter((part): part is string => typeof part === 'string'));
}
