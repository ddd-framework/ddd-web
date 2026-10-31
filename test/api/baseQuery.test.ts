import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import { describe, expect, it, vi } from 'vitest';
import { createDddBaseQuery, type DddBaseQueryOptions } from '../../src/api';
import type { DddTokens } from '../../src/auth';
import { json, makeApi } from './helpers';

const REFRESH = '/api/staff/common/auth/refresh';

/**
 * A fake backend: `/refresh` swaps the access token, every other route answers 401 unless the bearer is the current
 * valid token. Each handler can be overridden.
 */
const setup = (overrides: Partial<DddBaseQueryOptions> = {}, backend: { refreshStatus?: number; denyStatus?: number; denyBody?: unknown } = {}) => {
  const tokens: DddTokens = { accessToken: 'old', refreshToken: 'r1' };
  let validToken = 'new';
  const requests: Request[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo) => {
    const request = input as Request;
    requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const url = new URL(request.url);
    if (url.pathname === REFRESH) {
      if (backend.refreshStatus) return json(backend.refreshStatus, { error: 'Invalid refresh token' });
      const body = (await request.json()) as { refreshToken: string };
      validToken = 'new';
      return json(200, { accessToken: validToken, refreshToken: `${body.refreshToken}+` });
    }
    if (request.headers.get('authorization') === `Bearer ${validToken}` && tokens.accessToken === validToken) {
      return json(200, { ok: true, path: url.pathname });
    }
    return json(backend.denyStatus ?? 401, backend.denyBody ?? { error: 'Unauthorized' });
  });
  const setTokens = vi.fn((next: DddTokens): void => void Object.assign(tokens, next));
  const onLogout = vi.fn(() => {
    tokens.accessToken = null;
    tokens.refreshToken = null;
  });
  const baseQuery = createDddBaseQuery({
    baseUrl: 'https://api.test',
    refreshPath: REFRESH,
    getTokens: () => tokens,
    setTokens,
    onLogout,
    fetchOptions: { fetchFn },
    ...overrides,
  });
  const refreshCalls = () => requests.filter((request) => new URL(request.url).pathname === REFRESH).length;
  return { baseQuery, fetchFn, requests, tokens, setTokens, onLogout, refreshCalls };
};

describe('createDddBaseQuery', () => {
  it('requires refresh or refreshPath', () => {
    expect(() =>
      createDddBaseQuery({ baseUrl: 'x', getTokens: () => null, setTokens: vi.fn(), onLogout: vi.fn() }),
    ).toThrow(/refreshPath/);
  });

  it('injects the bearer, languageCode and custom headers', async () => {
    const { baseQuery, requests, tokens } = setup({
      languageCode: ({ type }) => (type === 'mutation' ? 'fr' : 'en'),
      headers: (headers) => {
        headers.set('x-app', 'demo');
      },
    });
    tokens.accessToken = 'new';
    await baseQuery({ url: '/api/items', params: { a: 1, b: null } }, makeApi('query'), {});
    await baseQuery({ url: '/api/items', method: 'POST', body: {} }, makeApi('mutation'), {});
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer new');
    expect(requests[0]!.headers.get('languageCode')).toBe('en');
    expect(requests[0]!.headers.get('x-app')).toBe('demo');
    expect(requests[0]!.url).toBe('https://api.test/api/items?a=1');
    expect(requests[1]!.headers.get('languageCode')).toBe('fr');
  });

  it('sends no bearer without an access token and keeps a caller-set authorization header', async () => {
    const { baseQuery, requests, tokens } = setup();
    tokens.accessToken = null;
    tokens.refreshToken = null;
    await baseQuery('/api/public', makeApi(), {});
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    tokens.accessToken = 'new';
    await baseQuery({ url: '/api/x', headers: { authorization: 'Bearer explicit' } }, makeApi(), {});
    expect(requests[1]!.headers.get('authorization')).toBe('Bearer explicit');
  });

  it('401 → one refresh → one retry with the new token', async () => {
    const { baseQuery, requests, setTokens, onLogout, refreshCalls } = setup();
    const result = await baseQuery('/api/items', makeApi(), {});
    expect(result.data).toEqual({ ok: true, path: '/api/items' });
    expect(refreshCalls()).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.headers.get('authorization')).toBe('Bearer new');
    expect(setTokens).toHaveBeenCalledWith({ accessToken: 'new', refreshToken: 'r1+' }, expect.anything());
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('retries only once even when the retry fails again', async () => {
    const refresh = vi.fn(async () => ({ accessToken: 'still-invalid', refreshToken: 'r2' }));
    const { baseQuery, requests } = setup({ refresh });
    const result = await baseQuery('/api/items', makeApi(), {});
    expect((result.error as FetchBaseQueryError).status).toBe(401);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
  });

  it('concurrent 401s share one refresh and each retries once', async () => {
    const { baseQuery, requests, refreshCalls } = setup();
    const results = await Promise.all(['/a', '/b', '/c', '/d'].map((url) => baseQuery(url, makeApi(), {})));
    expect(results.every((result) => (result.data as { ok?: boolean })?.ok)).toBe(true);
    expect(refreshCalls()).toBe(1);
    expect(requests).toHaveLength(4 + 1 + 4);
  });

  it('a request started during a refresh waits for it and uses the new token', async () => {
    const { baseQuery, requests, refreshCalls } = setup();
    const first = baseQuery('/a', makeApi(), {});
    await new Promise((resolve) => setTimeout(resolve, 7)); // first got its 401, refresh in flight
    const second = await baseQuery('/b', makeApi(), {});
    await first;
    expect((second.data as { ok: boolean }).ok).toBe(true);
    expect(refreshCalls()).toBe(1);
    const secondRequests = requests.filter((request) => request.url.endsWith('/b'));
    expect(secondRequests).toHaveLength(1);
    expect(secondRequests[0]!.headers.get('authorization')).toBe('Bearer new');
  });

  it('refresh failure → onLogout once, original error returned', async () => {
    const { baseQuery, onLogout, requests } = setup({}, { refreshStatus: 401 });
    const results = await Promise.all([baseQuery('/a', makeApi(), {}), baseQuery('/b', makeApi(), {})]);
    expect(results.map((result) => (result.error as FetchBaseQueryError).status)).toEqual([401, 401]);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3); // two originals + one refresh, no retries
  });

  it('a refresh that returns the same access token still retries every waiting request', async () => {
    // e.g. a backend that re-validates the session but keeps the token string
    let refreshed = false;
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo) => {
      const request = input as Request;
      const url = new URL(request.url);
      requests.push(url.pathname);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (url.pathname === REFRESH) {
        refreshed = true;
        return json(200, { accessToken: 'same', refreshToken: 'r1' });
      }
      return refreshed ? json(200, { ok: true }) : json(401, { error: 'Unauthorized' });
    });
    const tokens: DddTokens = { accessToken: 'same', refreshToken: 'r1' };
    const baseQuery = createDddBaseQuery({
      baseUrl: 'https://api.test',
      refreshPath: REFRESH,
      getTokens: () => tokens,
      setTokens: (next) => void Object.assign(tokens, next),
      onLogout: vi.fn(),
      fetchOptions: { fetchFn },
    });
    const results = await Promise.all(['/a', '/b', '/c'].map((url) => baseQuery(url, makeApi(), {})));
    expect(results.map((result) => (result.data as { ok?: boolean } | undefined)?.ok)).toEqual([true, true, true]);
    expect(requests.filter((pathname) => pathname === REFRESH)).toHaveLength(1);
  });

  it('a 401 arriving after a failed refresh does not log out a second time', async () => {
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const fetchFn = vi.fn(async (input: RequestInfo) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (url.pathname === '/slow') await slowGate;
      else await new Promise((resolve) => setTimeout(resolve, 5));
      if (url.pathname === REFRESH) return json(401, { error: 'Invalid refresh token' });
      return json(401, { error: 'Unauthorized' });
    });
    const onLogout = vi.fn();
    const tokens: DddTokens = { accessToken: 'old', refreshToken: 'r1' };
    const baseQuery = createDddBaseQuery({
      baseUrl: 'https://api.test',
      refreshPath: REFRESH,
      getTokens: () => tokens,
      setTokens: (next) => void Object.assign(tokens, next),
      onLogout,
      fetchOptions: { fetchFn },
    });
    const slow = baseQuery('/slow', makeApi(), {});
    await baseQuery('/fast', makeApi(), {}); // 401 → refresh rejected → logout
    expect(onLogout).toHaveBeenCalledTimes(1);
    releaseSlow();
    const late = await slow; // its 401 belongs to the session that already failed
    expect((late.error as FetchBaseQueryError).status).toBe(401);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('discards a refresh result when the session was logged out while the refresh ran', async () => {
    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const tokens: DddTokens = { accessToken: 'old', refreshToken: 'r1' };
    const setTokens = vi.fn((next: DddTokens): void => void Object.assign(tokens, next));
    const fetchFn = vi.fn(async () => json(401, { error: 'Unauthorized' }));
    const baseQuery = createDddBaseQuery({
      baseUrl: 'https://api.test',
      refresh: async () => {
        await refreshGate;
        return { accessToken: 'new', refreshToken: 'r2' };
      },
      getTokens: () => tokens,
      setTokens,
      onLogout: vi.fn(),
      fetchOptions: { fetchFn },
    });
    const pending = baseQuery('/a', makeApi(), {});
    await new Promise((resolve) => setTimeout(resolve, 5)); // refresh in flight
    tokens.accessToken = null; // the user logs out meanwhile
    tokens.refreshToken = null;
    releaseRefresh();
    const result = await pending;
    expect(setTokens).not.toHaveBeenCalled();
    expect(tokens).toEqual({ accessToken: null, refreshToken: null });
    expect((result.error as FetchBaseQueryError).status).toBe(401);
  });

  it('missing refresh token → onLogout without calling the refresh endpoint', async () => {
    const { baseQuery, onLogout, tokens, refreshCalls } = setup();
    tokens.refreshToken = null;
    await baseQuery('/a', makeApi(), {});
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(refreshCalls()).toBe(0);
  });

  it('does not refresh on 403 by default', async () => {
    const { baseQuery, refreshCalls, onLogout } = setup({}, { denyStatus: 403 });
    const result = await baseQuery('/a', makeApi(), {});
    expect((result.error as FetchBaseQueryError).status).toBe(403);
    expect(refreshCalls()).toBe(0);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('never refreshes for the auth endpoints themselves', async () => {
    const { baseQuery, refreshCalls } = setup();
    await baseQuery({ url: '/api/staff/common/auth/login', method: 'POST', body: {} }, makeApi('mutation'), {});
    expect(refreshCalls()).toBe(0);
  });

  describe('custom shouldRefresh: 401/403 except business refusals', () => {
    const isBusinessRefusal = (error: FetchBaseQueryError) =>
      String((error.data as { code?: string } | undefined)?.code ?? '').startsWith('PLAN_');
    const shouldRefresh = (error: FetchBaseQueryError) =>
      (error.status === 401 || error.status === 403) && !isBusinessRefusal(error);

    it('refreshes on a plain 403', async () => {
      const { baseQuery, refreshCalls } = setup({ shouldRefresh }, { denyStatus: 403 });
      const result = await baseQuery('/a', makeApi(), {});
      expect(refreshCalls()).toBe(1);
      expect(result.data).toEqual({ ok: true, path: '/a' });
    });

    it('does not refresh on an excluded 403', async () => {
      const { baseQuery, refreshCalls, onLogout } = setup(
        { shouldRefresh },
        { denyStatus: 403, denyBody: { error: 'Not in your plan', code: 'PLAN_EXPORT' } },
      );
      const result = await baseQuery('/a', makeApi(), {});
      expect(refreshCalls()).toBe(0);
      expect(onLogout).not.toHaveBeenCalled();
      expect((result.error as FetchBaseQueryError).status).toBe(403);
    });
  });

  it('debug passthrough forwards page flags as query parameters', async () => {
    const { baseQuery, requests, tokens } = setup({
      debug: { searchParams: () => new URLSearchParams('?debug&noCache&xdebug&errorsAsJson'), xdebugSessionKey: 'k' },
    });
    tokens.accessToken = 'new';
    await baseQuery({ url: '/a', params: { noCache: 'false' } }, makeApi(), {});
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get('debug')).toBe('true');
    expect(url.searchParams.get('noCache')).toBe('false');
    expect(url.searchParams.get('XDEBUG_SESSION')).toBe('k');
    expect(url.searchParams.get('errors_as_json')).toBe('1');
    expect(requests[0]!.headers.get('x-debug')).toBe('true');
  });

  it('debug is off by default', async () => {
    const { baseQuery, requests } = setup();
    await baseQuery('/a?x=1', makeApi(), {});
    expect(new URL(requests[0]!.url).search).toBe('?x=1');
  });
});
