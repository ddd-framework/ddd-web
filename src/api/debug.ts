import type { FetchArgs } from '@reduxjs/toolkit/query';

/**
 * Debug passthrough: flags present in the page URL (`?debug`, `?noCache`, `?xdebug`, `?errorsAsJson`) are forwarded to
 * every API request as the query parameters a DDD backend understands.
 */
export interface DddDebugOptions {
  /** Where the flags come from. Default: `window.location.search` (nothing outside a browser). */
  searchParams?: () => URLSearchParams | null | undefined;
  /** Value of `XDEBUG_SESSION` when `?xdebug` is set. Default `1`. */
  xdebugSessionKey?: string;
}

/** The debug flags active for one request. */
export interface DddDebugFlags {
  debug: boolean;
  noCache: boolean;
  xdebug: boolean;
  errorsAsJson: boolean;
}

const defaultSearchParams = (): URLSearchParams | null =>
  typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : null;

/** Reads the active debug flags. */
export function readDebugFlags(options: DddDebugOptions = {}): DddDebugFlags {
  const params = (options.searchParams ?? defaultSearchParams)() ?? null;
  return {
    debug: params?.has('debug') ?? false,
    noCache: params?.has('noCache') ?? false,
    xdebug: params?.has('xdebug') ?? false,
    errorsAsJson: params?.has('errorsAsJson') ?? false,
  };
}

const appendToUrl = (url: string, key: string, value: string): string =>
  new RegExp(`[?&]${key}=`, 'i').test(url)
    ? url
    : `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;

/**
 * Adds the query parameters for the active debug flags to a request, never overwriting a parameter the caller set.
 */
export function applyDebugParams(
  args: string | FetchArgs,
  flags: DddDebugFlags,
  xdebugSessionKey = '1',
): string | FetchArgs {
  const extra: Array<[string, string]> = [];
  if (flags.debug) extra.push(['debug', 'true']);
  if (flags.noCache) extra.push(['noCache', 'true']);
  if (flags.xdebug) extra.push(['XDEBUG_SESSION', xdebugSessionKey]);
  if (flags.errorsAsJson) extra.push(['errors_as_json', '1']);
  if (extra.length === 0) return args;

  if (typeof args === 'string') {
    return extra.reduce((url, [key, value]) => appendToUrl(url, key, value), args);
  }
  const params: Record<string, unknown> = { ...(args.params ?? {}) };
  for (const [key, value] of extra) {
    if (params[key] === undefined && !new RegExp(`[?&]${key}=`, 'i').test(args.url)) params[key] = value;
  }
  return { ...args, params };
}
