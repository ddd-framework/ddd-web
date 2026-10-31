import { QueryOptionsError } from './errors';

/** What to do with a `top` above `maxTop`: `throw` (default) or `clamp` to `maxTop`. */
export type TopOverflow = 'throw' | 'clamp';

/** Options of {@link normalizeTop}. */
export interface TopOptions {
  /** Upper bound (`#[QueryOptions(maxTop: …)]`, `x-ddd-query.maxTop`); null/undefined = none. */
  maxTop?: number | null;
  overflow?: TopOverflow;
}

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new QueryOptionsError(`${name} must be an integer (got ${String(value)})`);
  }
}

/**
 * Validates `top`. Mirrors `AppliedQueryOptions::setTop()`: above `maxTop` the backend answers 400, so this throws
 * (or clamps with `overflow: 'clamp'`); below 1 the backend raises to 1, so this throws for a non-positive value
 * instead of silently changing it. `undefined` stays `undefined` (backend default 50).
 */
export function normalizeTop(top: number | null | undefined, options: TopOptions = {}): number | undefined {
  if (top === null || top === undefined) {
    return undefined;
  }
  assertInteger('top', top);
  if (top < 1) {
    throw new QueryOptionsError(`top must be at least 1 (got ${top})`);
  }
  const maxTop = options.maxTop;
  if (maxTop !== null && maxTop !== undefined && top > maxTop) {
    if (options.overflow === 'clamp') {
      return maxTop;
    }
    throw new QueryOptionsError(`top may be at most ${maxTop} here (got ${top})`);
  }
  return top;
}

/**
 * Validates `skip`: a non-negative integer (`AppliedQueryOptions::setSkip()` clamps below 0). `undefined` and `0` stay
 * as given.
 */
export function normalizeSkip(skip: number | null | undefined): number | undefined {
  if (skip === null || skip === undefined) {
    return undefined;
  }
  assertInteger('skip', skip);
  if (skip < 0) {
    throw new QueryOptionsError(`skip must not be negative (got ${skip})`);
  }
  return skip;
}

/** `skip` for a zero-based page index and page size: `pageIndex * pageSize`. */
export function pageToSkip(pageIndex: number, pageSize: number): number {
  assertInteger('pageIndex', pageIndex);
  assertInteger('pageSize', pageSize);
  return Math.max(0, pageIndex) * Math.max(1, pageSize);
}
