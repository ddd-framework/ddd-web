import type { OrderDirection } from '../contract/query-options';
import { QueryOptionsError } from './errors';
import { assertPropertyPath } from './literals';

/** One sort item: `'title'`, `'title desc'` or `{ property: 'title', direction: 'desc' }`. */
export type OrderByItem = string | { property: string; direction?: OrderDirection };

/** Sort input: one item or a list (applied in order). */
export type OrderByInput = OrderByItem | readonly OrderByItem[];

/** A parsed sort item. */
export interface OrderByEntry {
  property: string;
  direction?: OrderDirection;
}

/** Normalises one sort item; throws for an invalid property or direction. */
export function toOrderByEntry(item: OrderByItem): OrderByEntry {
  if (typeof item !== 'string') {
    assertPropertyPath(item.property, 'orderBy property');
    if (item.direction !== undefined && item.direction !== 'asc' && item.direction !== 'desc') {
      throw new QueryOptionsError(`Invalid orderBy direction '${String(item.direction)}'`);
    }
    return item.direction ? { property: item.property, direction: item.direction } : { property: item.property };
  }
  const parts = item.trim().split(/\s+/);
  if (parts.length > 2 || !parts[0]) {
    throw new QueryOptionsError(`Invalid orderBy item '${item}'`);
  }
  const property = parts[0];
  assertPropertyPath(property, 'orderBy property');
  if (parts[1] === undefined) {
    return { property };
  }
  const direction = parts[1].toLowerCase();
  if (direction !== 'asc' && direction !== 'desc') {
    throw new QueryOptionsError(`Invalid orderBy direction '${parts[1]}'`);
  }
  return { property, direction };
}

/** Normalises sort input to a list of entries. */
export function toOrderByEntries(input: OrderByInput | null | undefined): OrderByEntry[] {
  if (input === null || input === undefined) {
    return [];
  }
  const items: readonly OrderByItem[] = Array.isArray(input) ? input : [input as OrderByItem];
  return items.map(toOrderByEntry);
}

/**
 * Builds the `orderBy` value, e.g. `title asc,id desc`; `undefined` for no items. Mirrors
 * `OrderByOptions::fromString()`: items split on `,`, property and direction split on ONE space, direction `asc` /
 * `desc` (case-insensitive, default asc). Dot-notation (`author.name`) and the fulltext `<property>Score` suffix are
 * plain property paths here.
 */
export function buildOrderBy(input: OrderByInput | null | undefined): string | undefined {
  const entries = toOrderByEntries(input);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(entry => (entry.direction ? `${entry.property} ${entry.direction}` : entry.property)).join(',');
}
