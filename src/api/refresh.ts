import type { BaseQueryApi, BaseQueryFn, FetchArgs, FetchBaseQueryError, FetchBaseQueryMeta } from '@reduxjs/toolkit/query';
import type { DddAuthResponse, DddTokens } from '../auth/types';

/** The raw (non-refreshing) base query handed to a refresh function. */
export type DddRawBaseQuery = BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError, {}, FetchBaseQueryMeta>;

/** Everything a refresh function needs. */
export interface DddRefreshContext {
  /** The refresh token currently stored. */
  refreshToken: string;
  /** The underlying fetch base query (no auth retry, Bearer of the current access token still applied). */
  baseQuery: DddRawBaseQuery;
  api: BaseQueryApi;
  extraOptions: unknown;
}

/**
 * Exchanges a refresh token for a new token pair.
 *
 * @returns the new pair, or `null` when the refresh token was rejected (the base query then logs out).
 *          A missing `refreshToken` in the result keeps the stored one.
 */
export type DddRefreshFn = (context: DddRefreshContext) => Promise<DddTokens | null>;

/**
 * The default {@link DddRefreshFn}: `POST <path>` with `{ refreshToken }`, expecting the DDD `AuthPostResponseDto`
 * `{ accessToken, refreshToken }`. DDD refresh tokens are stateless and re-issued with a renewed lifetime.
 *
 * @param path refresh endpoint relative to the base URL, e.g. `/api/admin/common/auth/refresh`
 */
export function createDddRefresh(path: string): DddRefreshFn {
  return async ({ refreshToken, baseQuery, api, extraOptions }) => {
    const result = await baseQuery({ url: path, method: 'POST', body: { refreshToken } }, api, extraOptions as {});
    const payload = result.data as DddAuthResponse | undefined;
    if (result.error || !payload?.accessToken) return null;
    return { accessToken: payload.accessToken, refreshToken: payload.refreshToken ?? refreshToken };
  };
}
