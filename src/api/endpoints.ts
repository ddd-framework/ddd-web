import type { Api, ApiModules, EndpointDefinitions } from '@reduxjs/toolkit/query';
import type { DddBaseQuery } from './baseQuery';
import type { DddAuthResponse, DddLoginRequest, DddRefreshRequest } from '../auth/types';

/** Options of {@link createAuthEndpoints}. */
export interface DddAuthEndpointsOptions {
  /** e.g. `/api/admin/common/auth/login` */
  loginPath: string;
  /** e.g. `/api/admin/common/auth/refresh` */
  refreshPath: string;
}

/**
 * Injects `authLogin` and `authRefresh` mutations for the DDD auth endpoints into an existing API.
 * Pure `injectEndpoints`, no React; with an API created by `@reduxjs/toolkit/query/react` the usual hooks
 * (`useAuthLoginMutation`, …) are generated as for any endpoint.
 *
 * The API must use the base query from {@link createDddBaseQuery}.
 *
 * Prefer the endpoints of your generated SDK when it already has them; this is for apps without one.
 */
export function createAuthEndpoints<
  Definitions extends EndpointDefinitions,
  ReducerPath extends string,
  TagTypes extends string,
  Enhancers extends keyof ApiModules<any, any, any, any>,
>(api: Api<DddBaseQuery, Definitions, ReducerPath, TagTypes, Enhancers>, options: DddAuthEndpointsOptions) {
  return api.injectEndpoints({
    endpoints: (build) => ({
      authLogin: build.mutation<DddAuthResponse, DddLoginRequest>({
        query: (body) => ({ url: options.loginPath, method: 'POST', body }),
      }),
      authRefresh: build.mutation<DddAuthResponse, DddRefreshRequest>({
        query: (body) => ({ url: options.refreshPath, method: 'POST', body }),
      }),
    }),
  });
}
