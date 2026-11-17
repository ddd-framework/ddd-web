import { describe, expect, it } from 'vitest';
import type { CapturedIssueContext, CapturedIssueEvent } from '../../src/issues';
import { DDD_ISSUES_REPORT_PATH, dddIssuesWireAdapter } from '../../src/issues/wire';

const context: CapturedIssueContext = {
  runtime: 'browser',
  app: 'web',
  release: 'web-1.2',
  tabId: 't1',
  userAgent: null,
  viewportWidth: 390,
  viewportHeight: 844,
  locale: 'en-GB',
};

const event: CapturedIssueEvent = {
  occurredAt: '2026-10-29T10:00:00.000Z',
  kind: 'error',
  level: 'error',
  name: 'TypeError',
  message: 'e is not a function',
  frames: [{ file: '/_next/static/chunks/app/page-3f2a.js', line: 1, column: 200, function: 'onClick', inApp: true }],
  rawStack: null,
  url: 'https://app.example.com/books/1',
  routePattern: '/books/[bookId]',
  requestMethod: null,
  httpStatus: null,
  breadcrumbs: [{ at: '2026-10-29T09:59:00.000Z', category: 'navigation', message: 'nav', url: null, from: '/a', to: '/b', status: null }],
  tags: [{ key: 'feature', value: 'books' }],
  count: 2,
  clientFingerprint: 'TypeError|e is not a function|/_next/static/chunks/app/page-3f2a.js:onClick',
};

describe('issues wire', () => {
  it('maps the capture model onto the request body of the DDD client-errors endpoint', () => {
    const body = dddIssuesWireAdapter.toRequestBody(context, [dddIssuesWireAdapter.toWireEvent(event)]);
    expect(body).toEqual({
      report: {
        client: {
          runtime: 'browser',
          app: 'web',
          release: 'web-1.2',
          tabId: 't1',
          userAgent: null,
          viewportWidth: 390,
          viewportHeight: 844,
          locale: 'en-GB',
        },
        events: {
          elements: [
            {
              occurredAt: '2026-10-29T10:00:00.000Z',
              kind: 'error',
              level: 'error',
              name: 'TypeError',
              message: 'e is not a function',
              frames: { elements: [{ file: '/_next/static/chunks/app/page-3f2a.js', line: 1, column: 200, function: 'onClick', inApp: true }] },
              rawStack: null,
              url: 'https://app.example.com/books/1',
              routePattern: '/books/[bookId]',
              requestMethod: null,
              httpStatus: null,
              breadcrumbs: {
                elements: [{ at: '2026-10-29T09:59:00.000Z', category: 'navigation', message: 'nav', url: null, from: '/a', to: '/b', status: null }],
              },
              tags: { elements: [{ key: 'feature', value: 'books' }] },
              count: 2,
              clientFingerprint: 'TypeError|e is not a function|/_next/static/chunks/app/page-3f2a.js:onClick',
            },
          ],
        },
      },
    });
  });

  it('names the endpoint path of the issues-log guide', () => {
    expect(DDD_ISSUES_REPORT_PATH).toBe('/api/public/common/issues/report');
  });
});
