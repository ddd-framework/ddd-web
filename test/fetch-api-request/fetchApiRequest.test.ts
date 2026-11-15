import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDddBaseQuery, DDD_FOREIGN_GLOBAL_REQUEST_MESSAGE } from '../../src/api';
import {
  FetchApiRequest,
  forgetFetchApiRequest,
  isFetchApiRequest,
  isFetchApiRequestConstructor,
  resolveFetchApiRequest,
} from '../../src/fetch-api-request';
import { json, makeApi } from '../api/helpers';

/** A global `Request` as MooTools 1.x installs it: an Ajax class, no Fetch API request. */
class MooToolsRequest {
  options: unknown;
  constructor(options?: unknown) {
    this.options = options;
  }
}

const NativeRequest = globalThis.Request;

afterEach(() => {
  vi.unstubAllGlobals();
  forgetFetchApiRequest();
});

describe('fetch-api-request', () => {
  it('tells the Fetch API request and its constructor from a foreign class of the same name', () => {
    expect(isFetchApiRequestConstructor(NativeRequest)).toBe(true);
    expect(isFetchApiRequestConstructor(MooToolsRequest)).toBe(false);
    expect(isFetchApiRequest(new NativeRequest('https://api.test/x'))).toBe(true);
    expect(isFetchApiRequest(new MooToolsRequest({ url: '/x' }))).toBe(false);
  });

  it('builds a Fetch API request with the global constructor when it is genuine', () => {
    expect(resolveFetchApiRequest()).toBe(NativeRequest);
    const request = new FetchApiRequest('https://api.test/items', { method: 'POST' });
    expect(isFetchApiRequest(request)).toBe(true);
    expect(request.method).toBe('POST');
  });

  it('builds through the constructor of a hidden frame when the global is foreign', () => {
    const appended: unknown[] = [];
    const frame = {
      hidden: false,
      tabIndex: 0,
      isConnected: true,
      setAttribute: vi.fn(),
      remove: vi.fn(),
      contentWindow: { Request: NativeRequest },
    };
    const body = { appendChild: (node: unknown) => appended.push(node) };
    vi.stubGlobal('Request', MooToolsRequest);
    vi.stubGlobal('document', { createElement: () => frame, body, documentElement: body, baseURI: 'https://app.test/page/' });

    const request = new FetchApiRequest('/api/client/items');

    expect(appended).toEqual([frame]);
    expect(frame.hidden).toBe(true);
    expect(isFetchApiRequest(request)).toBe(true);
    expect(request.url).toBe('https://app.test/api/client/items');
    new FetchApiRequest('/again');
    expect(appended).toHaveLength(1);

    frame.isConnected = false;
    new FetchApiRequest('/after-removal');
    expect(appended).toHaveLength(2);
  });

  it('throws a message naming the cause when no constructor is available', () => {
    vi.stubGlobal('Request', MooToolsRequest);
    vi.stubGlobal('document', undefined);
    expect(() => resolveFetchApiRequest()).toThrow(/MooTools or Prototype/);
  });
});

describe('createDddBaseQuery with a foreign global Request', () => {
  const createBaseQuery = (fetchFn: (input: RequestInfo) => Promise<Response>) =>
    createDddBaseQuery({
      baseUrl: 'https://api.test',
      refreshPath: '/api/client/common/auth/refresh',
      getTokens: () => ({ accessToken: 'token', refreshToken: 'refresh' }),
      setTokens: vi.fn(),
      onLogout: vi.fn(),
      fetchOptions: { fetchFn },
    });

  it('refuses the request with a message naming the cause instead of sending it to [object Object]', async () => {
    const fetchFn = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal('Request', MooToolsRequest);

    const result = await createBaseQuery(fetchFn)('/api/client/items', makeApi(), {});

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ status: 'FETCH_ERROR' });
    expect(String((result.error as { error?: unknown }).error)).toContain(DDD_FOREIGN_GLOBAL_REQUEST_MESSAGE);
  });

  it('sends a Fetch API request as before', async () => {
    const fetchFn = vi.fn(async () => json(200, { ok: true }));

    const result = await createBaseQuery(fetchFn)('/api/client/items', makeApi(), {});

    expect(result.data).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
