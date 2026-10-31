import { describe, expect, it } from 'vitest';
import { getErrorMessage } from '../src/api';
import { createLocalStorageTokenStorage, isExpired, type DddStorageLike } from '../src/auth';
import { parseDddDateTimeMs } from '../src/contract';
import {
  buildBetweenFilter,
  buildColumnSearchesKey,
  buildInFilter,
  buildNotInFilter,
  buildStaticArgsKey,
  combineFilters,
  topLevelJoinOperators,
} from '../src/query';
import { fakeJwt } from './api/helpers';
import { parseFilter } from './query/reference-parser';

describe('P2 regressions', () => {
  it('sees a join keyword right after a closing quote, bracket or number literal', () => {
    expect(topLevelJoinOperators("a eq '1'or b eq '2'")).toEqual(new Set(['or']));
    expect(topLevelJoinOperators("a in ['1']or b eq '2'")).toEqual(new Set(['or']));
    expect(topLevelJoinOperators('a eq 1or b eq 2')).toEqual(new Set(['or']));
    expect(topLevelJoinOperators("a eq nullor b eq '2'")).toEqual(new Set(['or']));
    const combined = combineFilters("tenant eq '7'", "a eq '1'or b eq '2'")!;
    expect(parseFilter(combined)).toEqual({
      join: 'and',
      left: { property: 'tenant', operator: 'eq', value: '7' },
      right: {
        join: 'or',
        left: { property: 'a', operator: 'eq', value: '1' },
        right: { property: 'b', operator: 'eq', value: '2' },
      },
    });
  });

  it('writes list items the backend can JSON-decode (control characters, quotes, backslashes)', () => {
    const values = ['line1\nline2', "O'Neil", 'tab\there', 'back\\slash', 'quote"d'];
    for (const filter of [buildInFilter('name', values), buildNotInFilter('name', values)]) {
      expect((parseFilter(filter) as { value: unknown }).value).toEqual(values);
    }
    expect((parseFilter(buildBetweenFilter('name', 'a\nb', 'c\rd')) as { value: unknown }).value).toEqual(['a\nb', 'c\rd']);
  });

  it('calendar-checks date-times that carry an offset', () => {
    expect(parseDddDateTimeMs('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseDddDateTimeMs('2026-13-01 00:00:00+02:00')).toBeNull();
    expect(parseDddDateTimeMs('2026-01-01T25:00:00Z')).toBeNull();
    expect(parseDddDateTimeMs('2026-02-28T23:00:00+01:00')).toBe(Date.UTC(2026, 1, 28, 22));
  });

  it('builds collision-free reset keys', () => {
    expect(buildStaticArgsKey({ a: '1&b=2' })).not.toBe(buildStaticArgsKey({ a: '1', b: '2' }));
    expect(buildStaticArgsKey({ a: '[1]' })).not.toBe(buildStaticArgsKey({ a: [1] }));
    expect(buildStaticArgsKey({ b: 2, a: 1 })).toBe(buildStaticArgsKey({ a: 1, b: 2 }));
    expect(buildColumnSearchesKey({ a: '1&b=2' })).not.toBe(buildColumnSearchesKey({ a: '1', b: '2' }));
  });

  it('never throws from an injected storage or a failing serializer', () => {
    const throwing: DddStorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const storage = createLocalStorageTokenStorage({ storage: throwing });
    expect(() => storage.write({ accessToken: 'a', refreshToken: 'r' })).not.toThrow();
    expect(storage.read()).toEqual({ accessToken: null, refreshToken: null });
    expect(() => storage.clear()).not.toThrow();

    const store = new Map<string, string>([['accessToken', 'old']]);
    const memory: DddStorageLike = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    };
    const failing = createLocalStorageTokenStorage({
      storage: memory,
      serialize: () => {
        throw new Error('cannot serialize');
      },
    });
    expect(() => failing.write({ accessToken: 'new' })).not.toThrow();
    expect(store.get('accessToken')).not.toBe('old'); // a stale token is not kept as if it were the new one
  });

  it('treats a present but invalid expiry claim as expired', () => {
    expect(isExpired(fakeJwt({ expiresAt: 'invalid' }))).toBe(true);
    expect(isExpired(fakeJwt({ exp: null, expiresAt: 'x' }))).toBe(true);
    expect(isExpired(fakeJwt({ accountId: 1 }))).toBe(false);
    expect(isExpired(fakeJwt({ expiresAt: Math.floor(Date.now() / 1000) + 600 }))).toBe(false);
  });

  it('uses a non-empty string body as the error message', () => {
    expect(getErrorMessage({ status: 400, data: 'Export failed' })).toBe('Export failed');
    expect(getErrorMessage({ status: 400, data: '   ' })).toBe('Request failed');
    expect(getErrorMessage({ status: 400, data: { error: 'Bad filter' } })).toBe('Bad filter');
  });
});
