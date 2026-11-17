import type { IssuesTransport } from './types';

/** The part of the Fetch API the transport uses (browser, Node 18+, React Native). */
export type IssuesFetchFunction = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    keepalive?: boolean;
    credentials?: 'omit' | 'same-origin' | 'include';
    signal?: unknown;
  },
) => Promise<{ status: number }>;

export interface FetchIssuesTransportOptions {
  /** Read at send time; default the global `fetch` as it is then. */
  fetch?: () => IssuesFetchFunction | undefined;
  /** Default `omit`: the report carries a bearer when there is a session, never cookies. */
  credentials?: 'omit' | 'same-origin' | 'include';
  /** Aborts a request that takes longer (where `AbortSignal.timeout` exists); default none. */
  timeoutMs?: number;
}

interface AbortSignalWithTimeout {
  timeout?: (milliseconds: number) => unknown;
}

/** POSTs with `fetch`. Rejects on a network error, like `fetch` itself. Touches no global before the first send. */
export const createFetchIssuesTransport = (options: FetchIssuesTransportOptions = {}): IssuesTransport => {
  return async (request) => {
    const fetchFunction =
      options.fetch?.() ?? (globalThis as unknown as { fetch?: IssuesFetchFunction }).fetch;
    if (typeof fetchFunction !== 'function') throw new Error('No fetch function available for the issues transport');
    const abortSignalClass = (globalThis as unknown as { AbortSignal?: AbortSignalWithTimeout }).AbortSignal;
    const signal =
      options.timeoutMs !== undefined && typeof abortSignalClass?.timeout === 'function'
        ? abortSignalClass.timeout(options.timeoutMs)
        : undefined;
    const response = await fetchFunction(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      credentials: options.credentials ?? 'omit',
      ...(request.keepalive ? { keepalive: true } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    return { status: response.status };
  };
};
