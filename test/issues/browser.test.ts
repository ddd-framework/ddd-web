import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssuesReporter, IssuesTransportRequest } from '../../src/issues';
import {
  captureRenderError,
  createBeaconIssuesTransport,
  createBrowserIssuesReporter,
  createBrowserIssuesRouteTracker,
  describeIssuesClickTarget,
  installBrowserIssueCapture,
  readOrCreateIssuesTabId,
  type IssuesBrowserWindow,
} from '../../src/issues/browser';
import { createFakeIssuesClock, settle } from './helpers';

/** A fake page: an EventTarget with fetch, document, location, navigator, storage and console. */
const createFakeBrowserWindow = (fetchImplementation: (url: string, init?: RequestInit) => Promise<Response>) => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const storage = new Map<string, string>();
  const beacons: { url: string; data: unknown }[] = [];
  const consoleErrors: unknown[][] = [];
  const fakeDocument = Object.assign(documentTarget, { visibilityState: 'visible' });
  const fakeWindow = Object.assign(windowTarget, {
    fetch: vi.fn(fetchImplementation) as unknown as typeof fetch,
    document: fakeDocument,
    location: { href: 'https://app.example.com/books/7?token=abc', origin: 'https://app.example.com' },
    navigator: {
      webdriver: false,
      language: 'en-GB',
      sendBeacon: (url: string, data?: unknown) => {
        beacons.push({ url, data });
        return true;
      },
    },
    innerWidth: 1280,
    innerHeight: 720,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    console: { error: (...args: unknown[]) => void consoleErrors.push(args) },
  });
  return { fakeWindow: fakeWindow as unknown as IssuesBrowserWindow & EventTarget, fakeDocument, storage, beacons, consoleErrors };
};

const createFakeReporter = () => {
  const captured: { error: unknown; kind: string | undefined }[] = [];
  const breadcrumbs: { category: string; message: string; url: string | null; status: number | null }[] = [];
  const flushes: (boolean | undefined)[] = [];
  const reporter: IssuesReporter = {
    captureError: (error, kind) => void captured.push({ error, kind }),
    addBreadcrumb: (breadcrumb) => void breadcrumbs.push(breadcrumb),
    setRoute: vi.fn(),
    setAuthorizationReader: vi.fn(),
    flush: async (options) => void flushes.push(options?.unloading),
    getQueuedEventCount: () => 0,
  };
  return { reporter, captured, breadcrumbs, flushes };
};

const uninstallers: (() => void)[] = [];
afterEach(() => {
  for (const uninstall of uninstallers.splice(0)) uninstall();
});

describe('issues browser adapter', () => {
  it('captures uncaught errors and unhandled rejections, flushes on pagehide and when hidden', () => {
    const { fakeWindow, fakeDocument } = createFakeBrowserWindow(async () => new Response(null, { status: 200 }));
    const { reporter, captured, flushes } = createFakeReporter();
    uninstallers.push(installBrowserIssueCapture(reporter, { browserWindow: fakeWindow }));

    const thrown = new TypeError('boom');
    fakeWindow.dispatchEvent(Object.assign(new Event('error'), { error: thrown }));
    fakeWindow.dispatchEvent(
      Object.assign(new Event('error'), { error: null, message: 'Opaque', filename: 'https://app.example.com/a.js', lineno: 3, colno: 9 }),
    );
    fakeWindow.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejected' }));
    expect(captured[0]).toEqual({ error: thrown, kind: 'error' });
    expect((captured[1]?.error as Error).stack).toBe('Error: Opaque\n    at https://app.example.com/a.js:3:9');
    expect(captured[2]).toEqual({ error: 'rejected', kind: 'unhandledrejection' });

    fakeWindow.dispatchEvent(new Event('pagehide'));
    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(flushes).toEqual([true, true]);
  });

  it('adds breadcrumbs for failed requests, console.error and clicks, never for the report endpoint; uninstall restores', async () => {
    const { fakeWindow, consoleErrors } = createFakeBrowserWindow(async (url) => {
      if (url.includes('offline')) throw new TypeError('Failed to fetch');
      if (url.includes('aborted')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return new Response(null, { status: url.includes('missing') ? 404 : 200 });
    });
    const originalFetch = fakeWindow.fetch;
    const originalConsoleError = fakeWindow.console?.error;
    const { reporter, breadcrumbs } = createFakeReporter();
    const uninstall = installBrowserIssueCapture(reporter, { browserWindow: fakeWindow, now: () => '2026-01-01T00:00:00.000Z' });
    expect(installBrowserIssueCapture(reporter, { browserWindow: fakeWindow })).toBeTypeOf('function');

    await fakeWindow.fetch('https://api.example.com/books/missing', { method: 'post' });
    await fakeWindow.fetch('https://api.example.com/books/ok');
    await fakeWindow.fetch('https://api.example.com/api/public/common/issues/report?x', { method: 'POST' });
    await expect(fakeWindow.fetch('https://api.example.com/offline')).rejects.toThrow('Failed to fetch');
    await expect(fakeWindow.fetch('https://api.example.com/aborted')).rejects.toThrow('aborted');
    fakeWindow.console?.error('Request failed for ana@example.com', { detail: 1 });

    const button = {
      tagName: 'SPAN',
      getAttribute: () => null,
      closest: (selector: string) =>
        selector === '[data-issues-action]'
          ? { tagName: 'BUTTON', getAttribute: (name: string) => (name === 'data-issues-action' ? 'save-book' : null), closest: () => null }
          : null,
    };
    fakeWindow.dispatchEvent(Object.assign(new Event('click'), {}));
    const clickEvent = new Event('click');
    Object.defineProperty(clickEvent, 'target', { value: button });
    fakeWindow.dispatchEvent(clickEvent);

    expect(breadcrumbs.map((breadcrumb) => [breadcrumb.category, breadcrumb.message, breadcrumb.status])).toEqual([
      ['fetch', 'POST 404', 404],
      ['fetch', 'GET network-error', null],
      ['console', 'Request failed for [email]', null],
      ['ui', 'save-book', null],
    ]);
    expect(consoleErrors).toHaveLength(1);

    uninstall();
    expect(fakeWindow.fetch).toBe(originalFetch);
    expect(fakeWindow.console?.error).toBe(originalConsoleError);
  });

  it('describes a click target by its action id, else tag and role, never text', () => {
    const plain = { tagName: 'DIV', getAttribute: (name: string) => (name === 'role' ? 'tab' : null), closest: () => null };
    expect(describeIssuesClickTarget(plain)).toBe('div[role=tab]');
    expect(describeIssuesClickTarget(null)).toBeNull();
    expect(describeIssuesClickTarget({ textContent: 'ana@example.com' })).toBeNull();
  });

  it('creates a page reporter: context from the page, endpoint on this origin, transport with the unwrapped fetch', async () => {
    const { fakeWindow } = createFakeBrowserWindow(async () => new Response(null, { status: 200 }));
    const { clock, advance } = createFakeIssuesClock();
    const reporter = createBrowserIssuesReporter({ app: 'web', release: () => 'web-7', browserWindow: fakeWindow, clock });
    expect(reporter).not.toBeNull();
    const pageFetch = fakeWindow.fetch as unknown as ReturnType<typeof vi.fn>;
    const { reporter: breadcrumbReporter, breadcrumbs } = createFakeReporter();
    uninstallers.push(installBrowserIssueCapture(breadcrumbReporter, { browserWindow: fakeWindow }));

    reporter?.captureError(Object.assign(new Error('page bug'), { stack: 'Error: page bug\n    at f (https://app.example.com/assets/a.js:1:2)' }));
    await advance(2_000);
    expect(pageFetch).toHaveBeenCalledTimes(1);
    const [url, init] = pageFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.example.com/api/public/common/issues/report');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', keepalive: true });
    const body = JSON.parse(String(init.body));
    expect(body.report.client).toEqual({
      runtime: 'browser',
      app: 'web',
      release: 'web-7',
      tabId: '11111111-2222-4333-8444-555555555555',
      userAgent: null,
      viewportWidth: 1280,
      viewportHeight: 720,
      locale: 'en-GB',
    });
    expect(body.report.events.elements[0].frames.elements[0].inApp).toBe(true);
    expect(breadcrumbs).toEqual([]);
  });

  it('reports nothing under automation and returns null outside a browser', () => {
    const { fakeWindow } = createFakeBrowserWindow(async () => new Response(null, { status: 200 }));
    (fakeWindow.navigator as { webdriver?: boolean }).webdriver = true;
    const { clock } = createFakeIssuesClock();
    const reporter = createBrowserIssuesReporter({ app: 'web', browserWindow: fakeWindow, clock });
    reporter?.captureError(new Error('automated'));
    expect(reporter?.getQueuedEventCount()).toBe(0);
    expect(createBrowserIssuesReporter({ app: 'web' })).toBeNull();
  });

  it('keeps one tab id per session storage and survives blocked storage', () => {
    const { fakeWindow, storage } = createFakeBrowserWindow(async () => new Response(null));
    expect(readOrCreateIssuesTabId('tab', fakeWindow)).toBe('11111111-2222-4333-8444-555555555555');
    storage.set('tab', 'existing');
    expect(readOrCreateIssuesTabId('tab', fakeWindow)).toBe('existing');
    const blocked = {
      ...fakeWindow,
      sessionStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => undefined,
      },
    } as unknown as IssuesBrowserWindow;
    expect(readOrCreateIssuesTabId('tab', blocked)).toBeNull();
    expect(readOrCreateIssuesTabId('tab', null)).toBeNull();
  });

  it('sends an unloading anonymous request as a beacon, everything else through the fallback', async () => {
    const { fakeWindow, beacons } = createFakeBrowserWindow(async () => new Response(null));
    const fallbackRequests: IssuesTransportRequest[] = [];
    const transport = createBeaconIssuesTransport({
      browserWindow: fakeWindow,
      fallback: async (request) => {
        fallbackRequests.push(request);
        return { status: 200 };
      },
    });
    const base = { url: 'https://api.example.com/r', body: '{}', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } };
    expect(await transport({ ...base, keepalive: true, unloading: true })).toEqual({ status: 202 });
    expect(beacons).toHaveLength(1);
    expect((beacons[0]?.data as Blob).type).toBe('text/plain;charset=utf-8');
    await transport({ ...base, keepalive: true, unloading: false });
    await transport({ ...base, keepalive: true, unloading: true, headers: { ...base.headers, Authorization: 'Bearer a' } });
    expect(fallbackRequests).toHaveLength(2);
    expect(beacons).toHaveLength(1);
  });

  it('tracks routes with the page URL and skips render errors that carry a server digest', () => {
    const { fakeWindow } = createFakeBrowserWindow(async () => new Response(null));
    const { reporter, captured, breadcrumbs } = createFakeReporter();
    const routeTracker = createBrowserIssuesRouteTracker(reporter, fakeWindow);
    expect(routeTracker.trackRoute('/books/7', { bookId: '7' })).toBe('/books/[bookId]');
    expect(reporter.setRoute).toHaveBeenCalledWith('/books/[bookId]', 'https://app.example.com/books/7?token=abc');
    expect(breadcrumbs).toHaveLength(1);

    captureRenderError(reporter, Object.assign(new Error('server'), { digest: '123' }));
    captureRenderError(reporter, new Error('client'));
    captureRenderError(reporter, Object.assign(new Error('server'), { digest: '456' }), { reportServerDigests: true });
    captureRenderError(null, new Error('no reporter'));
    expect(captured.map((capture) => [(capture.error as Error).message, capture.kind])).toEqual([
      ['client', 'react-render'],
      ['server', 'react-render'],
    ]);
  });
});

describe('issues browser adapter end to end', () => {
  it('reports an uncaught error through the installed capture to the endpoint, without a breadcrumb of its own request', async () => {
    const { fakeWindow } = createFakeBrowserWindow(async (url) => new Response(null, { status: url.includes('missing') ? 500 : 200 }));
    const pageFetch = fakeWindow.fetch as unknown as ReturnType<typeof vi.fn>;
    const { clock, advance } = createFakeIssuesClock();
    const reporter = createBrowserIssuesReporter({
      app: 'web',
      endpoint: 'https://api.example.com/api/public/common/issues/report',
      browserWindow: fakeWindow,
      clock,
    });
    if (!reporter) throw new Error('no reporter');
    uninstallers.push(installBrowserIssueCapture(reporter, { browserWindow: fakeWindow }));
    await fakeWindow.fetch('https://api.example.com/books/missing');
    fakeWindow.dispatchEvent(Object.assign(new Event('error'), { error: new RangeError('bad range') }));
    await advance(2_000);
    await settle();

    expect(pageFetch).toHaveBeenCalledTimes(2);
    const [url, init] = pageFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/public/common/issues/report');
    const [event] = JSON.parse(String(init.body)).report.events.elements;
    expect(event).toMatchObject({ kind: 'error', name: 'RangeError', message: 'bad range' });
    expect(event.breadcrumbs.elements.map((breadcrumb: { message: string }) => breadcrumb.message)).toEqual(['GET 500']);
  });
});
