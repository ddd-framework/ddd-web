import {
  fetchBaseQuery,
  type BaseQueryApi,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryArgs,
  type FetchBaseQueryError,
  type FetchBaseQueryMeta,
} from '@reduxjs/toolkit/query';
import type { DddTokens } from '../auth/types';
import { applyDebugParams, readDebugFlags, type DddDebugOptions } from './debug';
import { buildDddFormData, type DddMultipartFiles } from './multipart';
import { createDddRefresh, type DddRawBaseQuery, type DddRefreshFn, type DddReloginFn } from './refresh';

type MaybePromise<T> = T | Promise<T>;

/** Result of one refresh attempt: new tokens stored, session ended, session replaced while refreshing, or thrown. */
type RefreshOutcome = 'refreshed' | 'failed' | 'superseded' | 'error';

/** What `getTokens` can see: the request's Redux context (no dispatch). */
export type DddRequestContext = Pick<BaseQueryApi, 'getState' | 'extra' | 'endpoint' | 'type'>;

/** Context of the `headers` / `languageCode` hooks (RTK's `prepareHeaders` context). */
export type DddHeadersContext = Parameters<NonNullable<FetchBaseQueryArgs['prepareHeaders']>>[1];

/** Decides whether a failed request is worth a token refresh and one retry. */
export type DddShouldRefresh = (error: FetchBaseQueryError, request: FetchArgs) => boolean;

/** The base query type of a DDD api (what {@link createAuthEndpoints} and wrappers accept). */
export type DddBaseQuery = BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, {}, FetchBaseQueryMeta>;

/** One upload sent by {@link DddUploadingBaseQuery.upload}. */
export interface DddUploadRequest {
  /** Path relative to the base URL. */
  url: string;
  /** Default `POST`. */
  method?: string;
  /** JSON envelope, sent in the form field `body`; left out when `undefined`. */
  body?: unknown;
  /** File parts per form field (the `Parameter::FILES` properties of the request DTO). */
  files: DddMultipartFiles;
  /** Query parameters; `null` / `undefined` values are skipped. */
  params?: Record<string, unknown>;
  /** Bytes of the request body sent so far. Called again from 0 when the upload is repeated after a refresh. */
  onProgress?: (loaded: number, total: number) => void;
  /** Aborting cancels the request; the result is then the error of {@link isDddUploadAborted}. */
  signal?: AbortSignal;
  /**
   * Session this upload belongs to (see {@link DddBaseQueryOptions.getSessionKey}): it is only sent, and only
   * repeated after a refresh, while that session is the current one.
   */
  expectedSessionKey?: string | number;
}

/** Result of an upload: the shape an RTK `queryFn` returns. */
export type DddUploadResult = { data: unknown; error?: undefined } | { data?: undefined; error: FetchBaseQueryError };

/** The base query returned by {@link createDddBaseQuery}: a {@link DddBaseQuery} that can also upload with progress. */
export type DddUploadingBaseQuery = DddBaseQuery & {
  /**
   * Sends a multipart upload with progress (XMLHttpRequest: `fetch` reports no upload progress) through the same
   * session as every request: Bearer, `headers` / `languageCode` hooks, one shared refresh and one retry.
   *
   * @example
   * uploadAttachment: build.mutation<AttachmentResponse, { id: number; file: File; onProgress?: (loaded: number, total: number) => void }>({
   *   queryFn: ({ id, file, onProgress }, api, extraOptions) =>
   *     dddBaseQuery.upload({ url: `/api/client/items/${id}/attachments`, files: { attachmentFiles: [file] }, onProgress }, api, extraOptions) as
   *       Promise<{ data: AttachmentResponse } | { error: FetchBaseQueryError }>,
   * }),
   */
  upload: (request: DddUploadRequest, api: BaseQueryApi, extraOptions?: unknown) => Promise<DddUploadResult>;
};

/** `error.error` of an upload cancelled through its `signal`. */
export const DDD_UPLOAD_ABORTED = 'DDD_UPLOAD_ABORTED';

/** True for the error of an upload that was cancelled through its `signal`. */
export const isDddUploadAborted = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { status?: unknown; error?: unknown }).status === 'CUSTOM_ERROR' &&
  (error as { error?: unknown }).error === DDD_UPLOAD_ABORTED;

/** `error.error` of a request that was not sent because it was bound to a session that is no longer the current one. */
export const DDD_SESSION_CHANGED = 'DDD_SESSION_CHANGED';

/** True for the error of a request that was not sent because its session is no longer the current one. */
export const isDddSessionChanged = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { status?: unknown }).status === 'CUSTOM_ERROR' &&
  (error as { error?: unknown }).error === DDD_SESSION_CHANGED;

/** Request header that carries the expected session key to the base query; it is removed before the request is sent. */
export const DDD_EXPECTED_SESSION_KEY_HEADER = 'x-ddd-expected-session-key';

/**
 * `extraOptions` the base query reads: what binds the requests of an endpoint to a session (see
 * {@link DddBaseQueryOptions.getSessionKey}).
 */
export interface DddSessionBindingOptions {
  /** Binds each request to the session that is current when the request starts. */
  bindToSession?: boolean;
  /** Binds the request to this session (a `queryFn` passes it on to the base query). */
  expectedSessionKey?: string | number;
}

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
  /**
   * Identifies the current session by a value that survives a token refresh: the account id, or a counter the app
   * raises on every login and logout; `null` without a session. Never the access token: it changes with each refresh.
   *
   * With it a request can be bound to a session. A bound request is sent, and repeated after a refresh, only while
   * that session is the current one; otherwise it is answered with the error of {@link isDddSessionChanged}, without
   * a network call, a refresh or a logout. A request is bound by one of:
   * - {@link withDddExpectedSessionKey} in the endpoint's `query` (the session the caller prepared the request for),
   * - `expectedSessionKey` of an upload ({@link DddUploadRequest}),
   * - `extraOptions: { bindToSession: true }` on the endpoint: the session that is current when the request starts.
   *
   * Requests that are not bound are sent as without this option.
   *
   * @example
   * getSessionKey: ({ getState }) => (getState() as RootState).auth.accountId,
   *
   * // An endpoint whose body belongs to the account it was prepared for:
   * saveDraft: build.mutation<void, { accountId: number; draft: Draft }>({
   *   query: ({ accountId, draft }) =>
   *     withDddExpectedSessionKey({ url: '/api/client/drafts', method: 'POST', body: { draft } }, accountId),
   * }),
   */
  getSessionKey?: (context: DddRequestContext) => MaybePromise<string | number | null | undefined>;
  /** Custom refresh. Default: {@link createDddRefresh} on `refreshPath`. */
  refresh?: DddRefreshFn;
  /** Refresh endpoint for the default refresh, e.g. `/api/admin/common/auth/refresh`. Required without `refresh`. */
  refreshPath?: string;
  /**
   * Re-opens the session when the refresh cannot: no refresh token is stored (guest, impersonation or device
   * sessions), or the refresh token was rejected. Return the new tokens, or `null` to end the session (`onLogout`).
   * Without it a refresh-worthy failure without refresh token logs out directly.
   *
   * @example
   * // A guest session is re-opened from its stored credential:
   * relogin: async ({ baseQuery, api, extraOptions }) => {
   *   const credential = readGuestCredential();
   *   if (!credential) return null;
   *   const result = await baseQuery({ url: '/api/public/common/auth/guest', method: 'POST', body: { credential } }, api, extraOptions as {});
   *   const data = result.data as { accessToken?: string; refreshToken?: string | null } | undefined;
   *   return data?.accessToken ? { accessToken: data.accessToken, refreshToken: data.refreshToken ?? null } : null;
   * },
   */
  relogin?: DddReloginFn;
  /** Creates the request object of an upload. Default `new XMLHttpRequest()`. */
  createUploadRequest?: () => XMLHttpRequest;
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

const toHeaders = (source: FetchArgs['headers']): Headers => {
  const headers = new Headers();
  if (source instanceof Headers) source.forEach((value, key) => headers.set(key, value));
  else if (Array.isArray(source)) source.forEach(([key, value]) => key !== undefined && headers.set(key, value ?? ''));
  else if (source) Object.entries(source).forEach(([key, value]) => value !== undefined && headers.set(key, value));
  return headers;
};

const withBearer = (args: FetchArgs, accessToken: string | null | undefined): FetchArgs => {
  if (!accessToken) return args;
  const headers = toHeaders(args.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${accessToken}`);
  return { ...args, headers };
};

/**
 * Binds a request to a session: the base query sends it, and repeats it after a refresh, only while
 * `expectedSessionKey` is the key of the current session ({@link DddBaseQueryOptions.getSessionKey}). The key travels
 * in a request header that the base query removes before sending.
 */
export const withDddExpectedSessionKey = (request: string | FetchArgs, expectedSessionKey: string | number): FetchArgs => {
  const args = toFetchArgs(request);
  const headers = toHeaders(args.headers);
  headers.set(DDD_EXPECTED_SESSION_KEY_HEADER, String(expectedSessionKey));
  return { ...args, headers };
};

/** Splits the expected session key off a request; the returned request no longer carries the header. */
const takeExpectedSessionKey = (args: FetchArgs): { request: FetchArgs; expectedSessionKey: string | null } => {
  if (!args.headers) return { request: args, expectedSessionKey: null };
  const headers = toHeaders(args.headers);
  const expectedSessionKey = headers.get(DDD_EXPECTED_SESSION_KEY_HEADER);
  if (expectedSessionKey === null) return { request: args, expectedSessionKey: null };
  headers.delete(DDD_EXPECTED_SESSION_KEY_HEADER);
  return { request: { ...args, headers }, expectedSessionKey };
};

/**
 * Creates the RTK Query base query for a DDD backend.
 *
 * - Sends `Authorization: Bearer <accessToken>` from `getTokens()`.
 * - On a refresh-worthy failure (`shouldRefresh`, default 401) runs ONE shared refresh and retries the request exactly
 *   once. Concurrent failures share that refresh and its result; a request whose failure predates a refresh that
 *   finished meanwhile reuses that refresh's result instead of refreshing again.
 * - No refresh token, or a rejected refresh → `relogin()` when given; without it, or when it returns `null`,
 *   `onLogout()` once for that session and the original error is returned.
 * - A refresh whose session was logged out or replaced while it ran is discarded (no `setTokens`, no retry).
 * - A request bound to a session (`getSessionKey`) is not sent once another session is the current one.
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
export function createDddBaseQuery(options: DddBaseQueryOptions): DddUploadingBaseQuery {
  const { getTokens, setTokens, onLogout, getSessionKey, headers: headersHook, languageCode, fetchOptions, relogin } = options;
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

  /**
   * Refresh coordination. Every finished refresh attempt starts a new session generation and records its outcome; a
   * request remembers the generation it started in. A refresh-worthy failure in the current generation runs (or
   * joins) the one refresh of that generation; a failure from an older generation reuses the recorded outcome, so a
   * late 401 after a failed refresh neither refreshes nor logs out again.
   */
  let generation = 0;
  let lastOutcome: RefreshOutcome | null = null;
  let inflight: Promise<void> | null = null;

  const currentAccessToken = async (api: BaseQueryApi): Promise<string | null> =>
    (await getTokens(api))?.accessToken ?? null;

  const currentSessionKey = async (api: BaseQueryApi): Promise<string | null> => {
    const sessionKey = await (getSessionKey as NonNullable<typeof getSessionKey>)(api);
    return sessionKey === null || sessionKey === undefined ? null : String(sessionKey);
  };

  /**
   * The session a request is bound to, or `undefined` for a request that is not bound. Called when the request
   * starts, before it waits for a running refresh.
   */
  const resolveBoundSessionKey = async (
    requestSessionKey: string | number | null | undefined,
    api: BaseQueryApi,
    extraOptions: unknown,
  ): Promise<string | null | undefined> => {
    const binding = (extraOptions ?? {}) as DddSessionBindingOptions;
    const expectedSessionKey = requestSessionKey ?? binding.expectedSessionKey ?? null;
    if (expectedSessionKey === null && !binding.bindToSession) return undefined;
    if (!getSessionKey) {
      throw new Error('createDddBaseQuery: a request is bound to a session, pass `getSessionKey`.');
    }
    return expectedSessionKey === null ? currentSessionKey(api) : String(expectedSessionKey);
  };

  /** True when the request may be sent now: it is not bound, or its session is still the current one. */
  const isBoundSessionCurrent = async (boundSessionKey: string | null | undefined, api: BaseQueryApi): Promise<boolean> =>
    boundSessionKey === undefined || (await currentSessionKey(api)) === boundSessionKey;

  const sessionChanged = { error: { status: 'CUSTOM_ERROR' as const, error: DDD_SESSION_CHANGED } };

  const runRefresh = async (api: BaseQueryApi, extraOptions: unknown): Promise<RefreshOutcome> => {
    const before = await getTokens(api);
    const refreshToken = before?.refreshToken ?? null;
    const accessTokenBefore = before?.accessToken ?? null;
    let pair = refreshToken ? await refresh({ refreshToken, baseQuery: rawBaseQuery, api, extraOptions }) : null;
    if (!pair?.accessToken && relogin) {
      pair = await relogin({
        reason: refreshToken ? 'refresh-rejected' : 'no-refresh-token',
        baseQuery: rawBaseQuery,
        api,
        extraOptions,
      });
    }
    // The session may have ended (logout) or changed (another login) while the refresh ran: its result belongs to
    // a session that is gone and must not be stored.
    const after = await getTokens(api);
    if ((after?.refreshToken ?? null) !== refreshToken) return 'superseded';
    // A session without refresh token is identified by its access token.
    if (refreshToken === null && (after?.accessToken ?? null) !== accessTokenBefore) return 'superseded';
    if (!pair?.accessToken) {
      await onLogout(api);
      return 'failed';
    }
    await setTokens({ accessToken: pair.accessToken, refreshToken: pair.refreshToken ?? refreshToken }, api);
    return 'refreshed';
  };

  /** Runs or joins the refresh of `startGeneration`; returns the outcome that applies to a request of that generation. */
  const recover = async (startGeneration: number, api: BaseQueryApi, extraOptions: unknown): Promise<RefreshOutcome | null> => {
    if (generation === startGeneration && !inflight) {
      inflight = (async () => {
        try {
          lastOutcome = await runRefresh(api, extraOptions);
        } catch (error) {
          lastOutcome = 'error';
          throw error;
        } finally {
          generation++;
          inflight = null;
        }
      })();
    }
    if (inflight) await inflight;
    return lastOutcome;
  };

  /**
   * One attempt: reads the token, then checks the bound session as the last step before sending, so a session that
   * changed while the request waited is seen.
   */
  const sendRequest = async (
    request: FetchArgs,
    boundSessionKey: string | null | undefined,
    api: BaseQueryApi,
    extraOptions: {},
  ): Promise<Awaited<ReturnType<DddRawBaseQuery>>> => {
    const authorizedRequest = withBearer(request, await currentAccessToken(api));
    if (!(await isBoundSessionCurrent(boundSessionKey, api))) return sessionChanged;
    return rawBaseQuery(authorizedRequest, api, extraOptions);
  };

  const baseQuery: DddBaseQuery = async (args, api, extraOptions) => {
    const { request, expectedSessionKey } = takeExpectedSessionKey(toFetchArgs(args));
    const boundSessionKey = await resolveBoundSessionKey(expectedSessionKey, api, extraOptions);
    // A request started during a refresh waits for it and then sends the current token.
    while (inflight) await inflight.catch(() => undefined);
    const startGeneration = generation;
    const result = await sendRequest(request, boundSessionKey, api, extraOptions);
    if (!result.error || isDddSessionChanged(result.error) || !shouldRefresh(result.error, request)) return result;
    if ((await recover(startGeneration, api, extraOptions)) !== 'refreshed') return result;
    return sendRequest(request, boundSessionKey, api, extraOptions);
  };

  /** Headers of an upload: Bearer, then the same hooks as a fetch request. No content type: the runtime sets it. */
  const uploadHeaders = async (request: DddUploadRequest, api: BaseQueryApi, extraOptions: unknown): Promise<Headers> => {
    const headers = new Headers();
    const accessToken = await currentAccessToken(api);
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    const context = {
      getState: api.getState,
      extra: api.extra,
      endpoint: api.endpoint,
      type: api.type,
      forced: api.forced,
      arg: { url: request.url, method: request.method ?? 'POST' },
      extraOptions,
    } as DddHeadersContext;
    const language = languageCode?.(context);
    if (language) headers.set('languageCode', language);
    if (debugOptions && readDebugFlags(debugOptions).debug) headers.set('x-debug', 'true');
    return (await headersHook?.(headers, context)) ?? headers;
  };

  const sendUpload = async (
    request: DddUploadRequest,
    boundSessionKey: string | null | undefined,
    api: BaseQueryApi,
    extraOptions: unknown,
  ): Promise<DddUploadResult> => {
    const headers = await uploadHeaders(request, api, extraOptions);
    if (!(await isBoundSessionCurrent(boundSessionKey, api))) return sessionChanged;
    const query = request.params ? dddParamsSerializer(request.params) : '';
    const url = `${options.baseUrl.replace(/\/+$/, '')}/${request.url.replace(/^\/+/, '')}${query ? `${request.url.includes('?') ? '&' : '?'}${query}` : ''}`;
    return new Promise<DddUploadResult>((resolve) => {
      const { signal, onProgress } = request;
      const aborted: DddUploadResult = { error: { status: 'CUSTOM_ERROR', error: DDD_UPLOAD_ABORTED } };
      if (signal?.aborted) return resolve(aborted);
      const xhr = options.createUploadRequest ? options.createUploadRequest() : new XMLHttpRequest();
      const onAbort = (): void => xhr.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (result: DddUploadResult): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      xhr.open(request.method ?? 'POST', url);
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded, event.total);
        };
      }
      xhr.onload = () => {
        const text = xhr.responseText;
        let data: unknown;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          data = text;
        }
        if (xhr.status >= 200 && xhr.status < 300) finish({ data: data ?? null });
        else finish({ error: { status: xhr.status, data } });
      };
      xhr.onerror = () => finish({ error: { status: 'FETCH_ERROR', error: 'The upload did not reach the server.' } });
      xhr.onabort = () => finish(aborted);
      xhr.send(buildDddFormData(request.body, request.files));
    });
  };

  const upload: DddUploadingBaseQuery['upload'] = async (request, api, extraOptions) => {
    const boundSessionKey = await resolveBoundSessionKey(request.expectedSessionKey, api, extraOptions);
    while (inflight) await inflight.catch(() => undefined);
    const startGeneration = generation;
    const result = await sendUpload(request, boundSessionKey, api, extraOptions);
    if (!result.error || isDddSessionChanged(result.error)) return result;
    if (!shouldRefresh(result.error, { url: request.url, method: request.method ?? 'POST' })) return result;
    if ((await recover(startGeneration, api, extraOptions)) !== 'refreshed') return result;
    return sendUpload(request, boundSessionKey, api, extraOptions);
  };

  return Object.assign(baseQuery, { upload });
}
