import { describe, expect, it, vi } from 'vitest';
import {
  createDddBaseQuery,
  DDD_EXPECTED_SESSION_KEY_HEADER,
  DDD_SESSION_CHANGED,
  isDddSessionChanged,
  withDddExpectedSessionKey,
  type DddBaseQueryOptions,
} from '../../src/api';
import type { DddTokens } from '../../src/auth';
import { json, makeApi } from './helpers';

const REFRESH = '/api/client/common/auth/refresh';

/**
 * A fake backend with two accounts: a bearer is valid while it is in `validTokens`; `/refresh` answers after
 * `refreshDelay` ms with the next token of the account the refresh token belongs to.
 */
const setup = (overrides: Partial<DddBaseQueryOptions> = {}, refreshDelay = 20) => {
  const session: { accountId: number | null; tokens: DddTokens } = {
    accountId: 1,
    tokens: { accessToken: 'a-old', refreshToken: 'a-refresh' },
  };
  const validTokens = new Set(['a-new', 'b-token']);
  const requests: Request[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo) => {
    const request = input as Request;
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === REFRESH) {
      await new Promise((resolve) => setTimeout(resolve, refreshDelay));
      return json(200, { accessToken: 'a-new', refreshToken: 'a-refresh' });
    }
    const bearer = (request.headers.get('authorization') ?? '').replace('Bearer ', '');
    return validTokens.has(bearer) ? json(200, { storedFor: bearer }) : json(401, { error: 'Unauthorized' });
  });
  const onLogout = vi.fn();
  const baseQuery = createDddBaseQuery({
    baseUrl: 'https://api.test',
    refreshPath: REFRESH,
    getTokens: () => session.tokens,
    setTokens: (next) => void (session.tokens = { ...next }),
    onLogout,
    getSessionKey: () => session.accountId,
    fetchOptions: { fetchFn },
    ...overrides,
  });
  const switchToAccountB = (): void => {
    session.accountId = 2;
    session.tokens = { accessToken: 'b-token', refreshToken: 'b-refresh' };
  };
  const sent = () => requests.filter((request) => new URL(request.url).pathname !== REFRESH);
  return { baseQuery, session, requests, sent, onLogout, switchToAccountB, fetchFn };
};

const save = { url: '/api/client/drafts', method: 'POST', body: { draft: 'of account 1' } };

describe('createDddBaseQuery: requests bound to a session', () => {
  it('sends a bound request while its session is current and removes the key header', async () => {
    const { baseQuery, session, sent } = setup();
    session.tokens.accessToken = 'a-new';
    const result = await baseQuery(withDddExpectedSessionKey(save, 1), makeApi('mutation'), {});
    expect(result.data).toEqual({ storedFor: 'a-new' });
    expect(sent()[0]!.headers.has(DDD_EXPECTED_SESSION_KEY_HEADER)).toBe(false);
  });

  it('does not send a request prepared for another session', async () => {
    const { baseQuery, sent, onLogout, switchToAccountB } = setup();
    switchToAccountB();
    const result = await baseQuery(withDddExpectedSessionKey(save, 1), makeApi('mutation'), {});
    expect(result.error).toEqual({ status: 'CUSTOM_ERROR', error: DDD_SESSION_CHANGED });
    expect(isDddSessionChanged(result.error)).toBe(true);
    expect(sent()).toHaveLength(0);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('does not send a request whose session changed while it waited for a running refresh', async () => {
    const { baseQuery, sent, switchToAccountB, requests } = setup();
    const first = baseQuery('/api/client/items', makeApi(), {}); // 401 → starts the refresh
    await vi.waitFor(() => expect(requests.some((request) => new URL(request.url).pathname === REFRESH)).toBe(true));
    const bound = baseQuery(withDddExpectedSessionKey(save, 1), makeApi('mutation'), {}); // waits for the refresh
    const boundAtStart = baseQuery(save, makeApi('mutation'), { bindToSession: true });
    const unbound = baseQuery(save, makeApi('mutation'), {});
    switchToAccountB();
    await first;
    expect((await bound).error).toEqual({ status: 'CUSTOM_ERROR', error: DDD_SESSION_CHANGED });
    expect((await boundAtStart).error).toEqual({ status: 'CUSTOM_ERROR', error: DDD_SESSION_CHANGED });
    // without a binding the request goes out with the current session, as before
    expect((await unbound).data).toEqual({ storedFor: 'b-token' });
    expect(sent().filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('repeats a bound request after a refresh of the same session', async () => {
    const { baseQuery, sent } = setup();
    const result = await baseQuery(withDddExpectedSessionKey(save, 1), makeApi('mutation'), {});
    expect(result.data).toEqual({ storedFor: 'a-new' });
    expect(sent().map((request) => request.headers.get('authorization'))).toEqual(['Bearer a-old', 'Bearer a-new']);
  });

  it('does not repeat a bound request when the recovery ends in another session', async () => {
    const { baseQuery, sent, session, onLogout } = setup({
      // an app refresh that falls back to a login of another account
      refresh: async () => {
        session.accountId = 2;
        return { accessToken: 'b-token', refreshToken: 'a-refresh' };
      },
    });
    const result = await baseQuery(save, makeApi('mutation'), { bindToSession: true });
    expect(isDddSessionChanged(result.error)).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('binds a request without a session to "no session"', async () => {
    const { baseQuery, session, sent } = setup();
    session.accountId = null;
    session.tokens = { accessToken: null, refreshToken: null };
    const open = await baseQuery('/api/public/info', makeApi(), { bindToSession: true });
    expect(open.error).toMatchObject({ status: 401 });
    expect(sent()).toHaveLength(1);
  });

  it('reads the expected key from extraOptions and from an upload', async () => {
    const { baseQuery, switchToAccountB, sent } = setup({ createUploadRequest: () => { throw new Error('must not be created'); } });
    switchToAccountB();
    const viaExtraOptions = await baseQuery(save, makeApi('mutation'), { expectedSessionKey: 1 });
    expect(isDddSessionChanged(viaExtraOptions.error)).toBe(true);
    const upload = await baseQuery.upload(
      { url: '/api/client/files', files: { files: new File(['abc'], 'a.txt') }, expectedSessionKey: 1 },
      makeApi('mutation'),
    );
    expect(isDddSessionChanged(upload.error)).toBe(true);
    expect(sent()).toHaveLength(0);
  });

  it('fails loudly when a request is bound but getSessionKey is missing', async () => {
    const { baseQuery } = setup({ getSessionKey: undefined });
    await expect(baseQuery(withDddExpectedSessionKey(save, 1), makeApi('mutation'), {})).rejects.toThrow(/getSessionKey/);
    await expect(baseQuery(save, makeApi('mutation'), { bindToSession: true })).rejects.toThrow(/getSessionKey/);
  });
});
