import type { QueryOptionsParams } from '../contract/query-options';
import { buildExpand, type ExpandInput } from './expand';
import { combineFilters } from './filters';
import { buildOrderBy, type OrderByInput } from './order-by';
import { normalizeSkip, normalizeTop, type TopOverflow } from './paging';
import { buildSelect, type SelectInput } from './select';

/** Input of {@link buildQueryOptions}. */
export interface QueryOptionsInput {
  /** One filter expression or a list of clauses (AND-combined, `or` clauses parenthesised). */
  filters?: string | ReadonlyArray<string | null | undefined | false> | null;
  orderBy?: OrderByInput | null;
  expand?: ExpandInput | null;
  select?: SelectInput | null;
  top?: number | null;
  skip?: number | null;
}

/** Options of {@link buildQueryOptions}. */
export interface BuildQueryOptionsOptions {
  /** Upper bound for `top` (`x-ddd-query.maxTop`). */
  maxTop?: number | null;
  /** Above `maxTop`: `throw` (default, the backend would answer 400) or `clamp`. */
  topOverflow?: TopOverflow;
}

/**
 * Builds the QueryOptions request parameters with the wire names the backend reads (`filters`, `orderBy`,
 * `expand`, `select`, `top`, `skip` — no `$` prefix, `DtoQueryOptionsTrait`). Empty parts are left out, so the result
 * can be spread into a query-argument object directly.
 */
export function buildQueryOptions(
  input: QueryOptionsInput,
  options: BuildQueryOptionsOptions = {},
): QueryOptionsParams {
  const params: QueryOptionsParams = {};
  const filterList = typeof input.filters === 'string' ? [input.filters] : (input.filters ?? []);
  const filters = combineFilters(...filterList);
  if (filters) params.filters = filters;
  const orderBy = buildOrderBy(input.orderBy);
  if (orderBy) params.orderBy = orderBy;
  const expand = buildExpand(input.expand);
  if (expand) params.expand = expand;
  const select = buildSelect(input.select);
  if (select) params.select = select;
  const top = normalizeTop(input.top, { maxTop: options.maxTop, overflow: options.topOverflow });
  if (top !== undefined) params.top = top;
  const skip = normalizeSkip(input.skip);
  if (skip !== undefined) params.skip = skip;
  return params;
}
