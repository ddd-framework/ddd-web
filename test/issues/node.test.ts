import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssuesReporter, IssuesTransportRequest } from '../../src/issues';
import {
  createNodeIssuesReporter,
  createServerRequestErrorHandler,
  installNodeIssueCapture,
} from '../../src/issues/node';
import { createFakeIssuesClock } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

const createFakeReporter = () => {
  const captured: { error: unknown; kind: string | undefined; extra: unknown }[] = [];
  let flushCount = 0;
  const reporter: IssuesReporter = {
    captureError: (error, kind, extra) => void captured.push({ error, kind, extra }),
    addBreadcrumb: vi.fn(),
    setRoute: vi.fn(),
    setAuthorizationReader: vi.fn(),
    flush: async () => {
      flushCount++;
    },
    getQueuedEventCount: () => 0,
  };
  return { reporter, captured, flushCount: () => flushCount };
};

describe('issues node adapter', () => {
  it('sends to <apiBaseUrl><reportPath> with the server token, Node user agent and release', async () => {
    const requests: IssuesTransportRequest[] = [];
    const { clock, advance } = createFakeIssuesClock();
    const reporter = createNodeIssuesReporter({
      app: 'web',
      apiBaseUrl: 'http://api.internal:8080/',
      serverToken: 'server-secret',
      release: () => 'web-9',
      clock,
      transport: async (request) => {
        requests.push(request);
        return { status: 200 };
      },
    });
    reporter.captureError(
      Object.assign(new Error('ssr failed'), {
        stack: 'Error: ssr failed\n    at render (/srv/app/.next/server/chunks/ssr/a.js:1:2)\n    at x (/srv/app/node_modules/lib/i.js:1:1)',
      }),
      'server-request',
    );
    await advance(2_000);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('http://api.internal:8080/api/public/common/issues/report');
    expect(request?.keepalive).toBe(false);
    expect(request?.headers['X-Issues-Server-Token']).toBe('server-secret');
    const body = JSON.parse(request?.body ?? '{}');
    expect(body.report.client).toMatchObject({ runtime: 'node', app: 'web', release: 'web-9', userAgent: `Node.js ${process.version}` });
    expect(body.report.events.elements[0].frames.elements.map((frame: { inApp: boolean }) => frame.inApp)).toEqual([true, false]);
  });

  it('sends nothing without an API base URL and uses the global fetch by default', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const { clock, advance } = createFakeIssuesClock();
    const unconfigured = createNodeIssuesReporter({ app: 'web', apiBaseUrl: null, clock });
    unconfigured.captureError(new Error('nowhere'));
    await advance(2_000);
    expect(fetchStub).not.toHaveBeenCalled();

    const configured = createNodeIssuesReporter({ app: 'web', apiBaseUrl: () => 'https://api.example.com/custom/report', clock });
    configured.captureError(new Error('somewhere'));
    await advance(2_000);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/custom/report');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
  });

  it('turns a request error into a server-request capture with pattern, redacted path, method and digest tag', () => {
    const { reporter, captured } = createFakeReporter();
    const onRequestError = createServerRequestErrorHandler(() => reporter);
    const error = Object.assign(new Error('render failed'), { digest: 'd-1' });
    onRequestError(error, { path: '/invitations/abc?token=x', method: 'GET' }, { routePath: '/invitations/[code]', routerKind: 'App Router', routeType: 'render' });
    expect(captured).toEqual([
      {
        error,
        kind: 'server-request',
        extra: {
          routePattern: '/invitations/[code]',
          url: '/invitations/[redacted]?token=[redacted]',
          requestMethod: 'GET',
          tags: { digest: 'd-1', routerKind: 'App Router', routeType: 'render', renderSource: undefined },
        },
      },
    ]);
    expect(() => createServerRequestErrorHandler(() => null)(error, { path: '/', method: 'GET' })).not.toThrow();
  });

  it('installs process hooks: uncaught exceptions observed, rejections only on request, flush before exit', () => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    vi.stubGlobal('process', {
      version: 'v22.0.0',
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      off: (event: string, listener: (...args: unknown[]) => void) =>
        listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)),
    });
    const { reporter, captured, flushCount } = createFakeReporter();
    const uninstall = installNodeIssueCapture(reporter);
    expect([...listeners.keys()].sort()).toEqual(['beforeExit', 'uncaughtExceptionMonitor']);
    listeners.get('uncaughtExceptionMonitor')?.[0]?.(new Error('crash'));
    listeners.get('beforeExit')?.[0]?.();
    expect(captured.map((capture) => capture.kind)).toEqual(['error']);
    expect(flushCount()).toBe(2);
    uninstall();
    expect([...listeners.values()].every((registered) => registered.length === 0)).toBe(true);

    const uninstallWithRejections = installNodeIssueCapture(reporter, { unhandledRejections: true });
    listeners.get('unhandledRejection')?.[0]?.('nope');
    expect(captured.map((capture) => capture.kind)).toEqual(['error', 'unhandledrejection']);
    uninstallWithRejections();
  });
});
