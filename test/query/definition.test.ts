import { describe, expect, it } from 'vitest';
import type { DddQueryDefinition } from '../../src/contract';
import {
  buildDefinedFilter,
  buildDefinedQueryOptions,
  findFilterDefinition,
  isFilterDateTimeLiteral,
  isFilterValueValidForColumnKind,
  QueryValidationError,
  validateExpand,
  validateFilter,
  validateOrderBy,
  validateSelect,
} from '../../src/query';

const books: DddQueryDefinition = {
  filters: [
    { name: 'id', path: 'id', columnKind: 'int', operators: ['eq', 'ne', 'in', 'ni', 'gt', 'lt'] },
    {
      name: 'title',
      path: 'title',
      columnKind: 'translatable',
      supportsFulltext: false,
      operators: ['eq', 'ne'],
      valueRules: { eq: 'wildcard-required', ne: 'wildcard-required' },
    },
    { name: 'summary', path: 'summary', columnKind: 'translatable-searchable', supportsFulltext: true },
    { name: 'isAvailable', path: 'isAvailable', columnKind: 'bool', operators: ['eq', 'ne'] },
    { name: 'metadata', path: 'metadata', columnKind: 'json', valueRules: { eq: 'null-only' } },
    {
      name: 'created',
      path: 'changeHistory.createdTime',
      columnKind: 'datetime',
      temporalKind: 'MOMENT',
      operators: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'bw'],
    },
    { name: 'releaseDay', path: 'releaseDay', columnKind: 'datetime', temporalKind: 'DAY' },
    { name: 'status', path: 'status', columnKind: 'string', options: ['DRAFT', 'PUBLISHED'] },
    { name: 'publisherName', path: null, columnKind: 'string', requiresExpand: 'publisher' },
  ],
  orderBy: ['id', 'title', 'created'],
  expand: [
    {
      name: 'author',
      filters: [{ name: 'name', path: 'name', columnKind: 'string' }],
      orderBy: ['name'],
      expand: [{ name: 'books', maxTop: 10 }],
    },
    { name: 'publisher' },
    { name: 'coverSvg', computed: true },
  ],
  select: ['id', 'title'],
  top: 50,
  maxTop: 1000,
};

const codes = (issues: { code: string }[]) => issues.map(issue => issue.code);

describe('filter definitions', () => {
  it('finds direct and dotted definitions through expands', () => {
    expect(findFilterDefinition(books, 'id')?.columnKind).toBe('int');
    expect(findFilterDefinition(books, 'author.name')?.columnKind).toBe('string');
    expect(findFilterDefinition(books, 'author.missing')).toBeUndefined();
    expect(findFilterDefinition(books, 'nope')).toBeUndefined();
  });

  it('accepts valid filters', () => {
    expect(validateFilter(books, { property: 'id', operator: 'in', value: [1, '2'] })).toEqual([]);
    expect(validateFilter(books, { property: 'title', operator: 'eq', value: '*dune*' })).toEqual([]);
    expect(validateFilter(books, { property: 'title', operator: 'eq', value: null })).toEqual([]);
    expect(validateFilter(books, { property: 'summary', operator: 'ft', value: 'desert planet' })).toEqual([]);
    expect(validateFilter(books, { property: 'isAvailable', operator: 'eq', value: true })).toEqual([]);
    expect(validateFilter(books, { property: 'created', operator: 'bw', value: ['2026-01-01', '2026-01-31 23:59:59'] })).toEqual([]);
    expect(validateFilter(books, { property: 'id', operator: 'eq', value: '*4*' })).toEqual([]);
    expect(validateFilter(books, { property: 'metadata', operator: 'eq', value: null })).toEqual([]);
    expect(
      validateFilter(books, { property: 'author.name', operator: 'eq', value: 'Herbert' }, { expand: 'author' }),
    ).toEqual([]);
  });

  it('reports what the backend answers with 400', () => {
    expect(codes(validateFilter(books, { property: 'nope', operator: 'eq', value: 'x' }))).toEqual(['unknown-property']);
    expect(codes(validateFilter(books, { property: 'id', operator: 'eq', value: 'abc' }))).toEqual(['column-kind']);
    expect(codes(validateFilter(books, { property: 'id', operator: 'in', value: ['1', 'x'] }))).toEqual(['column-kind']);
    expect(codes(validateFilter(books, { property: 'id', operator: 'bw', value: ['1', '2'] }))).toEqual([
      'operator-not-allowed',
    ]);
    expect(codes(validateFilter(books, { property: 'title', operator: 'eq', value: 'Dune' }))).toEqual([
      'column-kind',
      'value-rule',
    ]);
    expect(codes(validateFilter(books, { property: 'title', operator: 'ft', value: 'dune' }))).toEqual([
      'operator-not-allowed',
      'fulltext-not-supported',
    ]);
    expect(codes(validateFilter(books, { property: 'metadata', operator: 'eq', value: '{}' }))).toEqual([
      'column-kind',
      'value-rule',
    ]);
    expect(codes(validateFilter(books, { property: 'isAvailable', operator: 'eq', value: 'yes' }))).toEqual([
      'column-kind',
    ]);
    expect(codes(validateFilter(books, { property: 'created', operator: 'ge', value: '2026-13-45' }))).toEqual([
      'column-kind',
    ]);
    expect(codes(validateFilter(books, { property: 'created', operator: 'gt', value: null }))).toEqual([
      'invalid-value-shape',
    ]);
    expect(codes(validateFilter(books, { property: 'status', operator: 'in', value: ['DRAFT', 'GONE'] }))).toEqual([
      'option-not-allowed',
    ]);
    expect(codes(validateFilter(books, { property: 'publisherName', operator: 'eq', value: 'x' }))).toEqual([
      'expand-required',
    ]);
    expect(
      codes(validateFilter(books, { property: 'publisherName', operator: 'eq', value: 'x' }, { expand: ['publisher'] })),
    ).toEqual([]);
    expect(codes(validateFilter(books, { property: 'author.name', operator: 'eq', value: 'x' }))).toEqual([
      'expand-required',
    ]);
  });

  it('buildDefinedFilter validates, then builds; DAY dates become Y-m-d', () => {
    expect(buildDefinedFilter(books, 'id', 'in', [1, 2])).toBe("id in ['1','2']");
    expect(buildDefinedFilter(books, 'releaseDay', 'eq', new Date(Date.UTC(2026, 9, 31, 22)))).toBe(
      "releaseDay eq '2026-10-31'",
    );
    expect(buildDefinedFilter(books, 'created', 'ge', new Date(Date.UTC(2026, 9, 31, 22)))).toBe(
      "created ge '2026-10-31 22:00:00'",
    );
    expect(() => buildDefinedFilter(books, 'id', 'eq', 'abc')).toThrow(QueryValidationError);
    try {
      buildDefinedFilter(books, 'title', 'eq', 'Dune');
    } catch (error) {
      expect((error as QueryValidationError).issues.length).toBe(2);
    }
  });
});

describe('orderBy / expand / select / top against the definition', () => {
  it('validates orderBy', () => {
    expect(validateOrderBy(books, ['id desc', 'created', 'summaryScore desc', 'author.name'])).toEqual([]);
    expect(codes(validateOrderBy(books, 'status'))).toEqual(['unknown-order-by']);
    expect(validateOrderBy({}, 'anything')).toEqual([]);
  });

  it('validates nested expands, computed fields and expand maxTop', () => {
    expect(validateExpand(books, ['author.books', 'coverSvg'])).toEqual([]);
    expect(codes(validateExpand(books, 'reviews'))).toEqual(['unknown-expand']);
    expect(codes(validateExpand(books, 'author.reviews'))).toEqual(['unknown-expand']);
    expect(codes(validateExpand(books, { coverSvg: { top: 1 } }))).toEqual(['computed-expand-clauses']);
    expect(codes(validateExpand(books, { author: { expand: { books: { top: 11 } } } }))).toEqual(['top-exceeds-max']);
    expect(codes(validateExpand(books, { author: { orderBy: 'age' } }))).toEqual(['unknown-order-by']);
  });

  it('validates select', () => {
    expect(validateSelect(books, ['id'])).toEqual([]);
    expect(codes(validateSelect(books, 'id,isbn'))).toEqual(['unknown-select']);
    expect(codes(validateSelect({}, ['id']))).toEqual(['select-not-supported']);
    expect(validateSelect({ select: true }, ['anything'])).toEqual([]);
  });

  it('buildDefinedQueryOptions honours maxTop', () => {
    expect(buildDefinedQueryOptions(books, { top: 1000, orderBy: 'id desc' })).toEqual({ top: 1000, orderBy: 'id desc' });
    expect(() => buildDefinedQueryOptions(books, { top: 1001 })).toThrow(/at most 1000/);
    expect(buildDefinedQueryOptions(books, { top: 5000 }, { topOverflow: 'clamp' })).toEqual({ top: 1000 });
    expect(() => buildDefinedQueryOptions(books, { expand: 'reviews' })).toThrow(QueryValidationError);
  });
});

describe('value checks', () => {
  it('mirrors isFilterDateTimeLiteral', () => {
    for (const valid of [
      '2026-10-31',
      '2026-10-31 12:00:00',
      '2026-10-31 12:00',
      '2026-10-31T12:00:00',
      '2026-10-31T12:00:00+02:00',
      '2026-10-31 12:00:00Z',
      '2024-02-29',
    ]) {
      expect(isFilterDateTimeLiteral(valid), valid).toBe(true);
    }
    for (const invalid of ['2026-13-45', '2026-02-30', '2026-10', '2026-10-31 24:00:00', '2026-10-31T12:00', 'x']) {
      expect(isFilterDateTimeLiteral(invalid), invalid).toBe(false);
    }
  });

  it('mirrors isFilterValueValidForColumnKind', () => {
    expect(isFilterValueValidForColumnKind('-3.5', 'int')).toBe(true);
    expect(isFilterValueValidForColumnKind('1e3', 'float')).toBe(false);
    expect(isFilterValueValidForColumnKind('TRUE', 'bool')).toBe(true);
    expect(isFilterValueValidForColumnKind('anything', 'string')).toBe(true);
    expect(isFilterValueValidForColumnKind(null, 'int')).toBe(true);
  });
});
