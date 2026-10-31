import { describe, expect, it } from 'vitest';
import {
  anyOfFilters,
  buildBetweenFilter,
  buildContainsFilter,
  buildFieldFilter,
  buildFullDayFilter,
  buildFulltextFilter,
  buildInFilter,
  buildIntEqFilter,
  buildListFilter,
  buildNotInFilter,
  buildNullFilter,
  combineFilters,
  escapeFilterString,
  escapeOData,
  formatFilterLiteral,
  groupFilter,
  QueryOptionsError,
  toBooleanPrefix,
  topLevelJoinOperators,
} from '../../src/query';
import { parseFilter } from './reference-parser';

describe('escaping', () => {
  it('escapes quotes and backslashes the way the backend parser reads them', () => {
    expect(escapeFilterString("O'Brien")).toBe("O\\'Brien");
    expect(escapeFilterString('C:\\')).toBe('C:\\\\');
    expect(escapeFilterString("a\\'b")).toBe("a\\\\\\'b");
    expect(escapeOData).toBe(escapeFilterString);
  });

  it('round-trips awkward strings through the reference parser', () => {
    const samples = ["O'Brien", 'C:\\', "\\'", "it's a \\ test ''", 'and or eq', '"double"', '(paren', 'semi;colon'];
    for (const sample of samples) {
      expect(parseFilter(buildFieldFilter('title', sample))).toEqual({
        property: 'title',
        operator: 'eq',
        value: sample,
      });
    }
  });

  it('regression: never doubles quotes (the backend ends the literal at the second quote)', () => {
    expect(buildFieldFilter('title', "O'Brien")).toBe("title eq 'O\\'Brien'");
    expect(buildFieldFilter('title', "O'Brien")).not.toContain("''");
  });

  it('quotes every scalar, writes null bare, bools as 1/0, dates as UTC DDD date-times', () => {
    expect(formatFilterLiteral(12)).toBe("'12'");
    expect(formatFilterLiteral(-5)).toBe("'-5'");
    expect(formatFilterLiteral(2.5)).toBe("'2.5'");
    expect(formatFilterLiteral(true)).toBe("'1'");
    expect(formatFilterLiteral(false)).toBe("'0'");
    expect(formatFilterLiteral(null)).toBe('null');
    expect(formatFilterLiteral(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("'2026-01-02 03:04:05'");
    expect(formatFilterLiteral(['a', 1, null])).toBe("['a','1',null]");
    expect(() => formatFilterLiteral(Number.NaN)).toThrow(QueryOptionsError);
    expect(() => formatFilterLiteral(1e21)).toThrow(QueryOptionsError);
  });
});

describe('buildFieldFilter', () => {
  it('builds comparisons with eq by default', () => {
    expect(buildFieldFilter('title', 'Dune')).toBe("title eq 'Dune'");
    expect(buildFieldFilter('author.name', 'Herbert', 'ne')).toBe("author.name ne 'Herbert'");
    expect(buildFieldFilter('pages', 300, 'ge')).toBe("pages ge '300'");
  });

  it('rejects invalid property paths', () => {
    expect(() => buildFieldFilter("title eq 'x' or id", 'y')).toThrow(QueryOptionsError);
    expect(() => buildFieldFilter('', 'y')).toThrow(QueryOptionsError);
    expect(() => buildFieldFilter('a..b', 'y')).toThrow(QueryOptionsError);
  });

  it('enforces the value shape per operator (FilterOptionsConstraintValidator)', () => {
    expect(() => buildFieldFilter('title', null, 'gt')).toThrow(/null/);
    expect(() => buildFieldFilter('title', 'NULL', 'lt')).toThrow(/null/);
    expect(() => buildFieldFilter('id', ['1', '2'], 'eq')).toThrow(/list/);
    expect(() => buildFieldFilter('id', '1', 'in')).toThrow(/list/);
    expect(() => buildFieldFilter('year', ['1'], 'bw')).toThrow(/exactly 2/);
    expect(() => buildFieldFilter('id', [], 'in')).toThrow(/at least one/);
    expect(() => buildFieldFilter('title', ' ', 'ft')).toThrow(/non-empty/);
    expect(() => buildFieldFilter('title', 'x', 'xx' as never)).toThrow(/Unknown/);
  });
});

describe('list operators (regression: in built a wildcard string)', () => {
  it('builds in / ni as bracket lists the backend decodes to arrays', () => {
    const inFilter = buildInFilter('id', [1, 2]);
    expect(inFilter).toBe("id in ['1','2']");
    expect(inFilter).not.toContain('*');
    expect(parseFilter(inFilter)).toEqual({ property: 'id', operator: 'in', value: ['1', '2'] });

    const niFilter = buildNotInFilter('status', ['DRAFT', "O'Neil"]);
    expect(niFilter).toBe("status ni ['DRAFT','O\\'Neil']");
    expect(parseFilter(niFilter)).toEqual({ property: 'status', operator: 'ni', value: ['DRAFT', "O'Neil"] });

    expect(buildListFilter('id', 'in', ['7'])).toBe("id in ['7']");
  });

  it('builds bw with exactly two items', () => {
    const between = buildBetweenFilter('published', '2026-01-01', '2026-12-31');
    expect(between).toBe("published bw ['2026-01-01','2026-12-31']");
    expect(parseFilter(between)).toEqual({
      property: 'published',
      operator: 'bw',
      value: ['2026-01-01', '2026-12-31'],
    });
  });

  it('keeps backslashes and double quotes inside list items intact', () => {
    const filter = buildInFilter('path', ['C:\\', 'say "hi"']);
    expect(parseFilter(filter)).toEqual({ property: 'path', operator: 'in', value: ['C:\\', 'say "hi"'] });
  });
});

describe('null, contains and fulltext builders', () => {
  it('builds null comparisons', () => {
    expect(buildNullFilter('deletedAt')).toBe('deletedAt eq null');
    expect(buildNullFilter('deletedAt', true)).toBe('deletedAt ne null');
  });

  it('builds wildcard contains filters', () => {
    expect(buildContainsFilter('title', ' dune ')).toBe("title eq '*dune*'");
    expect(buildContainsFilter('title', 'dune', true)).toBe("title ne '*dune*'");
    expect(buildContainsFilter('title', '   ')).toBeUndefined();
  });

  it('builds fulltext filters', () => {
    expect(toBooleanPrefix(' dune  messiah* ')).toBe('dune* messiah*');
    expect(buildFulltextFilter('title', 'dune messiah')).toBe("title ft 'dune messiah'");
    expect(buildFulltextFilter('title', 'dune messiah', { mode: 'fb' })).toBe("title fb 'dune* messiah*'");
    expect(buildFulltextFilter('title', '+dune -messiah', { mode: 'fb', prefix: false })).toBe(
      "title fb '+dune -messiah'",
    );
    expect(buildFulltextFilter('title', '')).toBeUndefined();
  });
});

describe('buildIntEqFilter', () => {
  it('builds only for numeric terms', () => {
    expect(buildIntEqFilter('12', 'id')).toBe("id eq '12'");
    expect(buildIntEqFilter('abc', 'id')).toBeUndefined();
    expect(buildIntEqFilter('-1', 'id')).toBeUndefined();
    expect(buildIntEqFilter('#12', 'id', { stripLeadingChar: '#' })).toBe("id eq '12'");
    expect(buildIntEqFilter('n12', 'id', { stripLeadingChar: 'n' })).toBe("id eq '12'");
    expect(buildIntEqFilter('#', 'id', { stripLeadingChar: '#' })).toBeUndefined();
  });
});

describe('buildFullDayFilter (regression: accepted impossible dates)', () => {
  it('builds a full UTC day for a real date', () => {
    expect(buildFullDayFilter('2026-10-31', 'created')).toBe(
      "created bw ['2026-10-31 00:00:00','2026-10-31 23:59:59']",
    );
    expect(buildFullDayFilter('2024-02-29', 'created')).toBeDefined();
  });

  it('rejects partial and impossible dates', () => {
    expect(buildFullDayFilter('2026-13-45', 'created')).toBeUndefined();
    expect(buildFullDayFilter('2026-02-30', 'created')).toBeUndefined();
    expect(buildFullDayFilter('2025-02-29', 'created')).toBeUndefined();
    expect(buildFullDayFilter('2026-00-10', 'created')).toBeUndefined();
    expect(buildFullDayFilter('2026-10', 'created')).toBeUndefined();
    expect(buildFullDayFilter("2026-10-31' or 1 eq '1", 'created')).toBeUndefined();
  });
});

describe('combineFilters (regression: or clauses were not grouped)', () => {
  it('skips empty parts', () => {
    expect(combineFilters()).toBeUndefined();
    expect(combineFilters(undefined, '', null, false)).toBeUndefined();
    expect(combineFilters("a eq '1'", undefined)).toBe("a eq '1'");
  });

  it('parenthesises clauses containing a top-level or', () => {
    const search = "title eq '*x*' or author.name eq '*x*'";
    const combined = combineFilters("status eq 'PUBLISHED'", search);
    expect(combined).toBe("status eq 'PUBLISHED' and (title eq '*x*' or author.name eq '*x*')");
    expect(parseFilter(combined as string)).toEqual({
      join: 'and',
      left: { property: 'status', operator: 'eq', value: 'PUBLISHED' },
      right: {
        join: 'or',
        left: { property: 'title', operator: 'eq', value: '*x*' },
        right: { property: 'author.name', operator: 'eq', value: '*x*' },
      },
    });
  });

  it('groups the or clause also when it comes first', () => {
    expect(combineFilters("a eq '1' or b eq '2'", "c eq '3'")).toBe("(a eq '1' or b eq '2') and c eq '3'");
  });

  it('does not wrap and-only or already grouped clauses, and ignores or inside literals', () => {
    expect(combineFilters("a eq '1' and b eq '2'", "c eq 'x or y'")).toBe(
      "a eq '1' and b eq '2' and c eq 'x or y'",
    );
    expect(combineFilters("(a eq '1' or b eq '2')", "c eq '3'")).toBe("(a eq '1' or b eq '2') and c eq '3'");
    expect(combineFilters("a in ['x or y']", "order eq '1'")).toBe("a in ['x or y'] and order eq '1'");
  });

  it('detects top-level join operators case-insensitively and around parentheses', () => {
    expect([...topLevelJoinOperators("a eq '1' OR b eq '2'")]).toEqual(['or']);
    expect([...topLevelJoinOperators("(a eq '1')or(b eq '2')")]).toEqual(['or']);
    expect([...topLevelJoinOperators("brand eq 'x' and orders eq 'y'")]).toEqual(['and']);
    expect([...topLevelJoinOperators("t eq 'it\\'s or not'")]).toEqual([]);
  });
});

describe('anyOfFilters', () => {
  it('or-joins and groups and-clauses', () => {
    expect(anyOfFilters("a eq '1'", "b eq '2' and c eq '3'")).toBe("a eq '1' or (b eq '2' and c eq '3')");
    expect(anyOfFilters(undefined)).toBeUndefined();
    expect(groupFilter("a eq '1'")).toBe("(a eq '1')");
  });

  it('nests correctly inside combineFilters', () => {
    const any = anyOfFilters(buildInFilter('id', [1, 2]), buildNullFilter('parentId'));
    expect(combineFilters("visible eq '1'", any)).toBe("visible eq '1' and (id in ['1','2'] or parentId eq null)");
  });
});
