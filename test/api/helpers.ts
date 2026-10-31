import type { BaseQueryApi } from '@reduxjs/toolkit/query';
import { vi } from 'vitest';

/** Minimal RTK BaseQueryApi for calling a base query directly. */
export const makeApi = (type: 'query' | 'mutation' = 'query', state: unknown = {}): BaseQueryApi => ({
  signal: new AbortController().signal,
  abort: vi.fn(),
  dispatch: vi.fn() as unknown as BaseQueryApi['dispatch'],
  getState: () => state,
  extra: undefined,
  endpoint: 'testEndpoint',
  type,
});

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Creates a fake JWT whose payload is `claims` (unsigned). */
export const fakeJwt = (claims: Record<string, unknown>): string => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
};
