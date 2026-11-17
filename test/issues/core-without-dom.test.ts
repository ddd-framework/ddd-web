import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The core must load and work in React Native and in Node: no `window`, `document`, `navigator`, `location`, `self`
 * or `sessionStorage` access — not at import time, not while capturing and sending. Every such global throws here.
 */
const BROWSER_GLOBALS = ['window', 'document', 'navigator', 'location', 'self', 'sessionStorage', 'localStorage'];

const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
const touchedGlobals: string[] = [];

const trapBrowserGlobals = () => {
  for (const globalName of BROWSER_GLOBALS) {
    savedDescriptors.set(globalName, Object.getOwnPropertyDescriptor(globalThis, globalName));
    Object.defineProperty(globalThis, globalName, {
      configurable: true,
      get() {
        touchedGlobals.push(globalName);
        throw new Error(`the issues core touched the browser global "${globalName}"`);
      },
    });
  }
};

afterEach(() => {
  for (const [globalName, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, globalName, descriptor);
    else delete (globalThis as Record<string, unknown>)[globalName];
  }
  savedDescriptors.clear();
});

describe('issues core without DOM', () => {
  it('imports, captures and sends without touching a browser global', async () => {
    trapBrowserGlobals();
    vi.resetModules();
    const issues = await import('../../src/issues');
    const wire = await import('../../src/issues/wire');
    expect(typeof issues.createIssuesReporter).toBe('function');
    expect(typeof wire.dddIssuesWireAdapter.toRequestBody).toBe('function');

    const sentBodies: string[] = [];
    const reporter = issues.createIssuesReporter({
      runtime: 'react-native',
      app: 'mobile',
      endpoint: () => 'https://api.example.com/api/public/common/issues/report',
      transport: async (request) => {
        sentBodies.push(request.body);
        return { status: 200 };
      },
      context: () => ({ release: 'mobile-1.0', userAgent: 'ExampleApp/1.0 (iOS 19)' }),
    });
    const routeTracker = issues.createIssuesRouteTracker(reporter);
    routeTracker.trackRoute('/books/7', { bookId: '7' });
    reporter.addBreadcrumb(issues.customBreadcrumb(new Date().toISOString(), 'opened book'));
    reporter.captureError(new TypeError('x is undefined'), 'error');
    await reporter.flush();

    expect(touchedGlobals).toEqual([]);
    expect(sentBodies).toHaveLength(1);
    const body = JSON.parse(sentBodies[0] ?? '{}');
    expect(body.report.client).toMatchObject({ runtime: 'react-native', app: 'mobile', release: 'mobile-1.0' });
    expect(body.report.events.elements[0]).toMatchObject({ routePattern: '/books/[bookId]', name: 'TypeError' });
    expect(body.report.events.elements[0].breadcrumbs.elements).toHaveLength(2);
  });

  it('really has no DOM in this environment', () => {
    expect('document' in globalThis && typeof (globalThis as { document?: unknown }).document === 'object').toBe(false);
  });
});
