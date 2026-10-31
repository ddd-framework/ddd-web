import { createApi } from '@reduxjs/toolkit/query';
import { describe, expect, it, vi } from 'vitest';
import { createAuthEndpoints, createDddBaseQuery } from '../../src/api';

describe('createAuthEndpoints', () => {
  it('injects login and refresh mutations without React', () => {
    const api = createApi({
      baseQuery: createDddBaseQuery({
        baseUrl: 'https://api.test',
        refreshPath: '/api/staff/common/auth/refresh',
        getTokens: () => null,
        setTokens: vi.fn(),
        onLogout: vi.fn(),
      }),
      endpoints: () => ({}),
    });
    const withAuth = createAuthEndpoints(api, {
      loginPath: '/api/staff/common/auth/login',
      refreshPath: '/api/staff/common/auth/refresh',
    });
    expect(typeof withAuth.endpoints.authLogin.initiate).toBe('function');
    expect(typeof withAuth.endpoints.authRefresh.initiate).toBe('function');
  });
});
