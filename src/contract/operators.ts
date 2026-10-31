/**
 * Filter operators of the DDD `filters` grammar.
 *
 * Mirrors `FiltersOptions::OPERATORS` in DDD Core: two-letter, case-insensitive operators. Comparison operators take a
 * single scalar, list operators take a list (`bw` exactly two items), fulltext operators take a non-empty search string.
 */
export type ComparisonOperator = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';

/** Operators whose value is a list: `in`, `ni` (not in), `bw` (between, exactly two items). */
export type ListOperator = 'in' | 'ni' | 'bw';

/** Fulltext operators (MATCH AGAINST): `ft` natural language mode, `fb` boolean mode. */
export type FulltextOperator = 'ft' | 'fb';

/** Every operator the backend parser accepts. */
export type FilterOperator = ComparisonOperator | ListOperator | FulltextOperator;

/** Join operators connecting two filter terms. */
export type FilterJoinOperator = 'and' | 'or';

/** Mirrors `FiltersOptions::OPERATORS`. */
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'gt',
  'ge',
  'lt',
  'le',
  'in',
  'ni',
  'bw',
  'ft',
  'fb',
];

/** Mirrors `FiltersOptions::ALLOWED_OPERATORS_ON_ARRAY_VALUE`. */
export const LIST_OPERATORS: readonly ListOperator[] = ['in', 'ni', 'bw'];

/** Mirrors `FiltersOptions::FULLTEXT_OPERATORS`. */
export const FULLTEXT_OPERATORS: readonly FulltextOperator[] = ['ft', 'fb'];

/** Mirrors `FiltersOptions::ALLOWED_OPERATORS_ON_NULL_VALUE`: a null value is only allowed with `eq` / `ne`. */
export const NULL_OPERATORS: readonly ComparisonOperator[] = ['eq', 'ne'];

/** Whether `value` is one of the operators the backend parser accepts (case-sensitive, lowercase). */
export function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'string' && (FILTER_OPERATORS as readonly string[]).includes(value);
}

/** Whether the operator takes a list value (`in`, `ni`, `bw`). */
export function isListOperator(operator: FilterOperator): operator is ListOperator {
  return (LIST_OPERATORS as readonly string[]).includes(operator);
}

/** Whether the operator is a fulltext operator (`ft`, `fb`). */
export function isFulltextOperator(operator: FilterOperator): operator is FulltextOperator {
  return (FULLTEXT_OPERATORS as readonly string[]).includes(operator);
}
