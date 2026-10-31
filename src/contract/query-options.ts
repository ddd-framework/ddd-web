/**
 * QueryOptions request parameters as the backend reads them.
 *
 * The names are matched verbatim against the request DTO properties (`DtoQueryOptionsTrait`): `filters`, `orderBy`,
 * `expand`, `select`, `top`, `skip` — no `$` prefix. `top` defaults to 50 on the backend (`QueryOptions::$top`).
 */
export interface QueryOptionsParams {
  /** Filter expression, e.g. `name eq 'Dune' and year ge '1965'`. */
  filters?: string;
  /** Comma-separated sort list, e.g. `title asc,id desc`. */
  orderBy?: string;
  /** Comma-separated expand list with optional `(…)` clauses, e.g. `author(select=id,name;top=5)`. */
  expand?: string;
  /** Comma-separated property list, e.g. `id,title`. */
  select?: string;
  /** Page size (backend default 50, capped by `maxTop` where declared). */
  top?: number;
  /** Offset. */
  skip?: number;
}

/** Sort direction accepted by `orderBy` (case-insensitive on the backend, `OrderByOption::__construct`). */
export type OrderDirection = 'asc' | 'desc';

/** Default page size of the backend when `top` is absent (`QueryOptions::$top = 50`). */
export const DEFAULT_TOP = 50;
