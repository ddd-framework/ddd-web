import {
  fetchBaseQuery,
  type BaseQueryApi,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryArgs,
  type FetchBaseQueryError,
  type FetchBaseQueryMeta,
} from '@reduxjs/toolkit/query';
import { Mutex } from 'async-mutex';
import type { DddTokens } from '../auth/types';
import { applyDebugParams, readDebugFlags, type DddDebugOptions } from './debug';
import { createDddRefresh, type DddRawBaseQuery, type DddRefreshFn } from './refresh';

type MaybePromise<T> = T | Promise<T>;

/** What `getTokens` can see: the request's Redux context (no dispatch). */
export type DddRequestContext = Pick<BaseQueryApi, 'getState' | 'extra' | 'endpoint' | 'type'>;

/** Context of the `headers` / `languageCode` hooks (RTK's `prepareHeaders` context). */
export type DddHeadersContext = Parameters<NonNullable<FetchBaseQueryArgs['prepareHeaders']>>[1];

/** Decides whether a failed request is worth a token refresh and one retry. */
export type DddShouldRefresh = (error: FetchBaseQueryError, request: FetchArgs) => boolean;

/** The base query returned by {@link createDddBaseQuery}. */
export type DddBaseQuery = BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, {}, FetchBaseQueryMeta>;

/** Options of {@link createDddBaseQuery}. */
export interface DddBaseQueryOptions {
  /** API origin, e.g. `https://api.example.com`. Request URLs are relative to it. */
  baseUrl: string;
  /** Current tokens, typically read from the Redux state (`context.getState()`) or a {@link TokenStorage}. */
  getTokens: (context: DddRequestContext) => MaybePromise<Partial<DddTokens> | null | undefined>;
  /** Stores a freshly refreshed token pair (dispatch a Redux action, write storage, …). */
  setTokens: (tokens: DddTokens, api: BaseQueryApi) => MaybePromise<void>;
  /** Called once when the session cannot be recovered (no refresh token, or the refresh was rejected). */
  onLogout: (api: BaseQueryApi) => MaybePromise<void>;
  /** Custom refresh. Default: {@link createDddRefresh} on `refreshPath`. */
  refresh?: DddRefreshFn;
  /** Refresh endpoint for the default refresh, e.g. `/api/admin/common/auth/refresh`. Required without `refresh`. */
  refreshPath?: string;
  /**
   * Adds or changes headers after the Bearer header is set; return value as in RTK's `prepareHeaders`.
   * `context.type` tells reads (`query`) from writes (`mutation`).
   */
  headers?: (headers: Headers, context: DddHeadersContext) => MaybePromise<Headers | void>;
  /**
   * Shortcut for the DDD `languageCode` header. Return e.g. the form's editing language for mutations and the UI
   * language for queries; a falsy value sends no header.
   */
  languageCode?: (context: DddHeadersContext) => string | null | undefined;
  /**
   * Decides whether a failed request triggers a refresh and one retry. Default {@link defaultShouldRefresh}
   * (status 401, auth endpoints excluded).
   *
   * @example
   * // Also refresh on 403, except for 403s that are business refusals:
   * shouldRefresh: (error, request) =>
   *   (error.status === 401 || error.status === 403) && !isBusinessRefusal(error) && !isDddAuthRequest(request)
   */
  shouldRefresh?: DddShouldRefresh;
  /** Debug passthrough of page URL flags (`?debug`, `?noCache`, `?xdebug`, `?errorsAsJson`). Default off. */
  debug?: boolean | DddDebugOptions;
  /** Further `fetchBaseQuery` options (`fetchFn`, `timeout`, `credentials`, `paramsSerializer`, …). */
  fetchOptions?: Omit<FetchBaseQueryArgs, 'baseUrl' | 'prepareHeaders'>;
}

/** URL path of a request argument. */
export const getRequestUrl = (request: string | FetchArgs): string =>
  typeof request === 'string' ? request : request.url;

/** True for the DDD auth endpoints (`…/common/auth/…`); they never trigger a refresh, they ARE the recovery. */
export const isDddAuthRequest = (request: string | FetchArgs): boolean =>
  getRequestUrl(request).includes('/common/auth/');

/** Default refresh decision: HTTP 401 on anything but an auth endpoint. */
export const defaultShouldRefresh: DddShouldRefresh = (error, request) =>
  error.status === 401 && !isDddAuthRequest(request);

/**
 * Query-string serializer that skips `null` / `undefined` values (the generated SDK passes every optional parameter).
 */
export const dddParamsSerializer = (params: Record<string, unknown>): string =>
  Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

const toFetchArgs = (args: string | FetchArgs): FetchArgs => (typeof args === 'string' ? { url: args } : args);

const withBearer = (args: FetchArgs, accessToken: string | null | undefined): FetchArgs => {
  if (!accessToken) return args;
  const headers = new Headers();
  const source = args.headers;
  if (source instanceof Headers) source.forEach((value, key) => headers.set(key, value));
  else if (Array.isArray(source)) source.forEach(([key, value]) => key !== undefined && headers.set(key, value ?? ''));
  else if (source) Object.entries(source).forEach(([key, value]) => value !== undefined && headers.set(key, value));
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${accessToken}`);
  return { ...args, headers };
};

/**
 * Creates the RTK Query base query for a DDD backend.
 *
 * - Sends `Authorization: Bearer <accessToken>` from `getTokens()`.
 * - On a refresh-worthy failure (`shouldRefresh`, default 401) runs ONE mutex-guarded refresh and retries the request
 *   exactly once. Concurrent failures wait for the same refresh; a request whose token was already replaced by a
 *   refresh that finished meanwhile retries without refreshing again.
 * - No refresh token, or a rejected refresh → `onLogout()` and the original error is returned.
 *
 * @example
 * export const baseApi = createApi({
 *   baseQuery: createDddBaseQuery({
 *     baseUrl: 'https://api.example.com',
 *     refreshPath: '/api/admin/common/auth/refresh',
 *     getTokens: ({ getState }) => (getState() as RootState).auth,
 *     setTokens: (tokens, { dispatch }) => dispatch(authActions.updateTokens(tokens)),
 *     onLogout: ({ dispatch }) => dispatch(authActions.logout()),
 *   }),
 *   endpoints: () => ({}),
 * });
 */
export function createDddBaseQuery(options: DddBaseQueryOptions): DddBaseQuery {
  const { getTokens, setTokens, onLogout, headers: headersHook, languageCode, fetchOptions } = options;
  const shouldRefresh = options.shouldRefresh ?? defaultShouldRefresh;
  if (!options.refresh && !options.refreshPath) {
    throw new Error('createDddBaseQuery: pass either `refresh` or `refreshPath`.');
  }
  const refresh = options.refresh ?? createDddRefresh(options.refreshPath as string);
  const debugOptions: DddDebugOptions | null =
    options.debug === true ? {} : options.debug ? options.debug : null;

  const fetchQuery = fetchBaseQuery({
    paramsSerializer: dddParamsSerializer,
    ...fetchOptions,
    baseUrl: options.baseUrl,
    prepareHeaders: async (headers, context) => {
      const language = languageCode?.(context);
      if (language) headers.set('languageCode', language);
      if (debugOptions && readDebugFlags(debugOptions).debug) headers.set('x-debug', 'true');
      return (await headersHook?.(headers, context)) ?? headers;
    },
  });

  /** One request without auth recovery: debug passthrough + fetch. */
  const rawBaseQuery: DddRawBaseQuery = (args, api, extraOptions) => {
    const finalArgs = debugOptions
      ? applyDebugParams(args, readDebugFlags(debugOptions), debugOptions.xdebugSessionKey)
      : args;
    return fetchQuery(finalArgs, api, extraOptions as {});
  };

  const mutex = new Mutex();

  const currentAccessToken = async (api: BaseQueryApi): Promise<string | null> =>
    (await getTokens(api))?.accessToken ?? null;

  /** Runs (or joins) the refresh. True when a newer access token than `usedToken` is available afterwards. */
  const recover = async (usedToken: string | null, api: BaseQueryApi, extraOptions: unknown): Promise<boolean> => {
    if (mutex.isLocked()) {
      await mutex.waitForUnlock();
      const token = await currentAccessToken(api);
      return token !== null && token !== usedToken;
    }
    return mutex.runExclusive(async () => {
      const tokens = await getTokens(api);
      const token = tokens?.accessToken ?? null;
      if (token !== null && token !== usedToken) return true; // refreshed by a request that finished just before
      const refreshToken = tokens?.refreshToken ?? null;
      const pair = refreshToken ? await refresh({ refreshToken, baseQuery: rawBaseQuery, api, extraOptions }) : null;
      if (!pair?.accessToken) {
        await onLogout(api);
        return false;
      }
      await setTokens({ accessToken: pair.accessToken, refreshToken: pair.refreshToken ?? refreshToken }, api);
      return true;
    });
  };

  return async (args, api, extraOptions) => {
    await mutex.waitForUnlock();
    const request = toFetchArgs(args);
    const usedToken = await currentAccessToken(api);
    let result = await rawBaseQuery(withBearer(request, usedToken), api, extraOptions);

    if (result.error && shouldRefresh(result.error, request)) {
      if (await recover(usedToken, api, extraOptions)) {
        result = await rawBaseQuery(withBearer(request, await currentAccessToken(api)), api, extraOptions);
      }
    }
    return result;
  };
}
