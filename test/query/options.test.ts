import { describe, expect, it } from 'vitest';
import {
  buildColumnSearchesKey,
  buildExpand,
  buildOrderBy,
  buildQueryOptions,
  buildSelect,
  buildStaticArgsKey,
  expandedProperties,
  normalizeSkip,
  normalizeTop,
  pageToSkip,
  QueryOptionsError,
  sanitizeColumnSearches,
  sanitizeSearchInput,
  toExpandTree,
} from '../../src/query';

describe('buildOrderBy', () => {
  it('joins items with a comma and one space before the direction', () => {
    expect(buildOrderBy('title')).toBe('title');
    expect(buildOrderBy(['title asc', { property: 'id', direction: 'desc' }])).toBe('title asc,id desc');
    expect(buildOrderBy('  author.name   DESC ')).toBe('author.name desc');
    expect(buildOrderBy('titleScore desc')).toBe('titleScore desc');
    expect(buildOrderBy([])).toBeUndefined();
    expect(buildOrderBy(undefined)).toBeUndefined();
  });

  it('rejects invalid items', () => {
    expect(() => buildOrderBy('title sideways')).toThrow(QueryOptionsError);
    expect(() => buildOrderBy('title desc extra')).toThrow(QueryOptionsError);
    expect(() => buildOrderBy('title,id')).toThrow(QueryOptionsError);
    expect(() => buildOrderBy({ property: 'title', direction: 'up' as never })).toThrow(QueryOptionsError);
  });
});

describe('buildSelect', () => {
  it('joins unique fields with a comma', () => {
    expect(buildSelect(['id', 'title', 'id'])).toBe('id,title');
    expect(buildSelect(' id , author.name ')).toBe('id,author.name');
    expect(buildSelect([])).toBeUndefined();
    expect(() => buildSelect(['id', "title eq 'x'"])).toThrow(QueryOptionsError);
  });
});

describe('top / skip', () => {
  it('validates top and honours maxTop', () => {
    expect(normalizeTop(undefined)).toBeUndefined();
    expect(normalizeTop(10)).toBe(10);
    expect(normalizeTop(1000, { maxTop: 1000 })).toBe(1000);
    expect(() => normalizeTop(1001, { maxTop: 1000 })).toThrow(/at most 1000/);
    expect(normalizeTop(5000, { maxTop: 1000, overflow: 'clamp' })).toBe(1000);
    expect(() => normalizeTop(0)).toThrow(QueryOptionsError);
    expect(() => normalizeTop(2.5)).toThrow(QueryOptionsError);
  });

  it('validates skip', () => {
    expect(normalizeSkip(0)).toBe(0);
    expect(normalizeSkip(null)).toBeUndefined();
    expect(() => normalizeSkip(-1)).toThrow(QueryOptionsError);
    expect(pageToSkip(3, 25)).toBe(75);
  });
});

describe('buildExpand', () => {
  it('builds plain lists', () => {
    expect(buildExpand('author')).toBe('author');
    expect(buildExpand(['author', 'reviews'])).toBe('author,reviews');
    expect(buildExpand('author, reviews')).toBe('author,reviews');
    expect(buildExpand([])).toBeUndefined();
  });

  it('builds clauses separated by semicolons', () => {
    expect(
      buildExpand({
        property: 'reviews',
        filters: ["rating ge '4'", "visible eq '1'"],
        orderBy: 'created desc',
        select: ['id', 'rating'],
        top: 5,
        skip: 10,
      }),
    ).toBe("reviews(filters=rating ge '4' and visible eq '1';orderBy=created desc;select=id,rating;top=5;skip=10)");
  });

  it('builds nested expands from objects, maps and dotted paths', () => {
    expect(buildExpand({ author: { select: 'id,name', expand: { books: { top: 3 } } } })).toBe(
      'author(select=id,name;expand=books(top=3))',
    );
    expect(buildExpand('author.books.reviews')).toBe('author(expand=books(expand=reviews))');
    expect(buildExpand(['author.books', { property: 'author', select: ['id'] }, 'author.awards'])).toBe(
      'author(select=id;expand=books,awards)',
    );
    expect(
      buildExpand({ author: { expand: [{ property: 'books', expand: 'reviews', top: 2 }, 'awards'] }, series: true }),
    ).toBe('author(expand=books(top=2;expand=reviews),awards),series');
  });

  it('groups or clauses inside expand filters', () => {
    expect(buildExpand({ reviews: { filters: ["a eq '1' or b eq '2'", "c eq '3'"] } })).toBe(
      "reviews(filters=(a eq '1' or b eq '2') and c eq '3')",
    );
  });

  it('rejects what the backend expand regexes cannot carry', () => {
    expect(() => buildExpand('author.name-x')).toThrow(QueryOptionsError);
    expect(() => buildExpand({ reviews: { filters: "text eq 'a;b'" } })).toThrow(/;/);
    expect(() => buildExpand({ reviews: { filters: "text eq 'a(b'" } })).toThrow(/parentheses/);
    expect(() => buildExpand({ reviews: { filters: "text eq 'expand=x'" } })).toThrow(/expand=/);
    expect(() => buildExpand({ reviews: { top: 0 } })).toThrow(QueryOptionsError);
  });

  it('exposes the normalised tree', () => {
    expect(expandedProperties(['author.books', 'series'])).toEqual(['author', 'series']);
    expect(toExpandTree({ author: { top: 2 } })).toEqual([{ property: 'author', top: 2, children: [] }]);
  });
});

describe('buildQueryOptions', () => {
  it('uses the wire names without $ and drops empty parts', () => {
    expect(
      buildQueryOptions({
        filters: ["status eq 'PUBLISHED'", "title eq '*x*' or subtitle eq '*x*'", undefined],
        orderBy: [{ property: 'title' }],
        expand: 'author',
        select: ['id', 'title'],
        top: 20,
        skip: 40,
      }),
    ).toEqual({
      filters: "status eq 'PUBLISHED' and (title eq '*x*' or subtitle eq '*x*')",
      orderBy: 'title',
      expand: 'author',
      select: 'id,title',
      top: 20,
      skip: 40,
    });
    expect(buildQueryOptions({ filters: '', orderBy: [], select: [], expand: null, top: null })).toEqual({});
    expect(buildQueryOptions({ filters: "id eq '1'" })).toEqual({ filters: "id eq '1'" });
  });

  it('honours maxTop', () => {
    expect(() => buildQueryOptions({ top: 200 }, { maxTop: 100 })).toThrow(QueryOptionsError);
    expect(buildQueryOptions({ top: 200 }, { maxTop: 100, topOverflow: 'clamp' })).toEqual({ top: 100 });
  });
});

describe('sanitizers and reset keys', () => {
  it('sanitizes search input', () => {
    expect(sanitizeSearchInput('  dune ')).toBe('dune ');
    expect(sanitizeColumnSearches({ title: '  x', author: '   ' })).toEqual({ title: 'x' });
  });

  it('builds stable keys', () => {
    expect(buildStaticArgsKey(undefined)).toBe('');
    expect(buildStaticArgsKey({ b: 2, a: 'x', c: null, d: true })).toBe('[["a","x"],["b",2],["c",null],["d",true]]');
    expect(buildStaticArgsKey({ ids: [1, 2] })).toBe('[["ids",[1,2]]]');
    expect(buildColumnSearchesKey({ title: 'x', author: '', isbn: '1' })).toBe('[["isbn","1"],["title","x"]]');
  });
});
